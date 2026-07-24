/**
 * Chat VERIFY phase — answer verification against the incremental allow-set.
 *
 * Extracted from ChatService (CORE-21 decomposition). After the final answer
 * is produced, this node:
 *  1. checks cited case numbers against the allow-set built during execution
 *  2. checks cited law articles, confirming "unverified" ones via DB lookup
 *     (verifyArticlesAgainstDb) before warning — see CORE-28/30
 *  3. yields citation_warning SSE events for whatever remains unverified
 *
 * sanitizeAnswerForPersistence() strips the unverified references from the
 * text that gets persisted to the conversation (CORE-28).
 */

import { logger } from '../utils/logger.js';
import { ToolCall } from '@secondlayer/shared';
import { IncrementalAllowSet, verifyArticlesAgainstDb, verifyCaseSubjectsAgainstDb, verifyNormAttributionsAgainstGraph, findChainAttributionMismatches } from './incremental-allow-set.js';
import { verifyCitedCaseClaims } from './claim-verifier.js';
import type { EvidenceTracker } from './evidence-extractor.js';
import type { ChatEvent } from './chat-service.js';
import type { ILLMPort } from '../domain/ports/index.js';

export interface VerifyContext {
  fullAnswerText: string;
  allowSet: IncrementalAllowSet;
  evidence: EvidenceTracker;
  collectedToolCalls: ToolCall[];
  requestId?: string;
  /** Query topic terms — used to flag real-but-off-topic case citations. */
  queryTerms?: string[];
  /** LLM port for the CORE-21 P0.2 claim↔source check. Omit to skip it. */
  llm?: ILLMPort;
}

export interface VerifyResult {
  fabricatedCaseNumbers: string[];
  fabricatedLawArticles: string[];
  /** Usage of the P0.2 claim-verifier LLM call, for cost recording by the caller. */
  claimCheck?: { usage?: any; provider?: string; model?: string };
  /**
   * CORE-21 P0.enforce: real cases cited with an unsupported quote (P0.1) or a
   * mischaracterised holding (P0.2). The caller strips these claims via
   * repairUnsupportedCitations (distinct from fabricated — the case exists).
   */
  unsupportedCitations?: Array<{ caseNumber: string; reason: string }>;
  /** V3 telemetry (CORE-55): per-request grounding-signal counts for metrics. */
  signals?: {
    fabricatedCases: number;
    fabricatedArticles: number;
    lowRelevance: number;
    subjectMismatch: number;
    ungroundedQuotes: number;
    /** CORE-102: answer stated a case outcome its dispositive contradicts. */
    outcomeMismatch: number;
    /** CORE-103: answer attributed a norm to a case whose citation-graph edges
     *  don't include it (warn-only while telemetry accumulates). */
    normAttributionMismatch: number;
    /** CORE-108: foreign-case document cited in an instance-chain row (warn-only). */
    chainAttributionMismatch: number;
  };
}

export async function* verifyAnswerNode(
  ctx: VerifyContext,
  executeTool: (name: string, args: Record<string, unknown>) => Promise<any>
): AsyncGenerator<ChatEvent, VerifyResult> {
  const { fullAnswerText, allowSet, evidence, collectedToolCalls, requestId, queryTerms, llm } = ctx;

  // LEXAI-637: verify answer against incrementally built allow-set.
  // The allow-set was populated during tool execution (not post-hoc).
  // Also ingest cumulative decisions for completeness.
  allowSet.ingestDecisions(evidence.decisions);

  let fabricatedCaseNumbers: string[] = [];
  let fabricatedLawArticles: string[] = [];
  let claimCheckUsage: VerifyResult['claimCheck'];
  const unsupportedCitations: Array<{ caseNumber: string; reason: string }> = [];
  // V3 telemetry (CORE-55): grounding-signal counts surfaced to the caller for metrics.
  let lowRelevanceCount = 0;
  let subjectMismatchCount = 0;
  let ungroundedCount = 0;
  let outcomeMismatchCount = 0;
  let normAttributionCount = 0;
  let chainAttributionCount = 0;
  if (fullAnswerText) {
    const verification = allowSet.verify(fullAnswerText);
    fabricatedCaseNumbers = verification.fabricatedCaseNumbers;
    fabricatedLawArticles = verification.fabricatedLawArticles;

    if (fabricatedCaseNumbers.length > 0) {
      logger.warn('[ChatService] Fabricated case numbers in answer', {
        requestId,
        fabricated: fabricatedCaseNumbers,
        allowedCount: allowSet.allowedCaseNumbers.size,
        toolCalls: collectedToolCalls.map(c => c.name),
      });
      yield {
        type: 'citation_warning',
        data: {
          reason: 'fabricated_case_numbers',
          fabricated: fabricatedCaseNumbers,
          message:
            'Деякі номери справ у відповіді не знайдені в результатах пошуку цього запиту. ' +
            'Їх не можна вважати підтвердженими. Запитайте «пошукай конкретно справу X» щоб перевірити.',
        },
      };
    }

    // Verify unverified law articles by looking them up in the DB.
    // LLM often references valid articles from its training data that
    // weren't in the search results — confirm they exist before warning.
    if (fabricatedLawArticles.length > 0) {
      fabricatedLawArticles = await verifyArticlesAgainstDb(allowSet, fullAnswerText, executeTool);
    }

    if (fabricatedLawArticles.length > 0) {
      logger.warn('[ChatService] Unverified law articles in answer', {
        requestId,
        unverified: fabricatedLawArticles,
        allowedCount: allowSet.allowedLawArticles.size,
        searchedRadaIds: [...allowSet.allowedRadaIds],
      });
      yield {
        type: 'citation_warning',
        data: {
          reason: 'unverified_law_articles',
          unverified: fabricatedLawArticles,
          message:
            'Деякі посилання на статті законів не підтверджені результатами пошуку. ' +
            'Перевірте їх через «пошукай статтю X закону Y».',
        },
      };
    }
    // Relevance gate: real cases cited for an unrelated proposition (off-topic).
    // A/B (2026-06-21, LEXAI) found models citing real but off-topic Supreme Court
    // cases as "the position on this issue". Non-destructive — warn only.
    const lowRelevanceCaseNumbers = allowSet.findLowRelevanceCitations(fullAnswerText, queryTerms || []);
    lowRelevanceCount = lowRelevanceCaseNumbers.length;
    if (lowRelevanceCaseNumbers.length > 0) {
      logger.warn('[ChatService] Off-topic case citations in answer', {
        requestId,
        lowRelevance: lowRelevanceCaseNumbers,
        queryTermCount: (queryTerms || []).length,
      });
      yield {
        type: 'citation_warning',
        data: {
          reason: 'low_relevance_case_numbers',
          lowRelevance: lowRelevanceCaseNumbers,
          message:
            'Деякі справи у відповіді справжні, але їх зміст не стосується суті запиту. ' +
            'Не покладайтесь на них як на позицію суду з цього питання без перевірки.',
        },
      };
    }

    // Subject-matter gate: a real case characterised as being about a subject its own
    // result text contradicts (e.g. a ПДВ case cited as a податок-на-нерухомість holding —
    // chat-001815fe). Stronger than low-relevance: the case is about a mutually-exclusive
    // subject, not merely off-topic. Non-destructive — warn only.
    // DB-backed: snippet-only cases that assert a subject get their full text fetched and
    // re-checked, so a mischaracterisation invisible in the snippet is still caught.
    const subjectMismatches = await verifyCaseSubjectsAgainstDb(allowSet, fullAnswerText, executeTool);
    subjectMismatchCount = subjectMismatches.length;
    if (subjectMismatches.length > 0) {
      // CORE-21 P0.enforce: this gate loads the case's FULL TEXT (DB-backed for
      // snippet-only cites) and finds it positively about a mutually-exclusive subject
      // — the answer presents the case as a holding on something its own text is not
      // about (repro chat-f8dbb84e: 200/7694/24 cited for податок-на-нерухомість while
      // the decision is about єдиний податок / плата за землю). Deterministic and
      // conservative, so enforce it like P0.1/P0.2: strip, not just warn.
      for (const x of subjectMismatches) {
        unsupportedCitations.push({
          caseNumber: x.caseNumber,
          reason: `у відповіді подано як «${x.claimed}», а текст рішення стосується «${x.actual}»`,
        });
      }
      logger.warn('[ChatService] Subject-matter mismatch in case citations', {
        requestId,
        mismatches: subjectMismatches,
      });
      yield {
        type: 'citation_warning',
        data: {
          reason: 'subject_matter_mismatch',
          mismatches: subjectMismatches,
          message:
            'Деякі справи у відповіді стосуються іншого предмета спору, ніж зазначено: ' +
            subjectMismatches.map(x => `${x.caseNumber} (у відповіді як «${x.claimed}», у тексті — «${x.actual}»)`).join('; ') +
            '. Не покладайтесь на них як на практику з цього питання без перевірки повного тексту.',
        },
      };
    }

    // Outcome gate (CORE-102): the answer states a case's outcome (whose cassation
    // appeal, granted/denied) that the decision's operative part contradicts — repro
    // chat-98f8472e («касаційну скаргу ДПС відхилено, ППР скасовано» while the
    // dispositive GRANTED the taxpayer's appeal in a debt-collection suit). Deterministic
    // and conservative (needs a captured dispositive + confidently classified parties),
    // so enforce like the subject gate: strip, not just warn.
    const outcomeMismatches = allowSet.findOutcomeMismatchCitations(fullAnswerText);
    outcomeMismatchCount = outcomeMismatches.length;
    if (outcomeMismatches.length > 0) {
      for (const x of outcomeMismatches) {
        unsupportedCitations.push({
          caseNumber: x.caseNumber,
          reason: `виклад результату справи суперечить резолютивній частині: у відповіді — «${x.claimed}», у рішенні — «${x.actual}»`,
        });
      }
      logger.warn('[ChatService] Outcome mismatch in case citations', {
        requestId,
        mismatches: outcomeMismatches,
      });
      yield {
        type: 'citation_warning',
        data: {
          reason: 'outcome_mismatch',
          mismatches: outcomeMismatches,
          message:
            'Результат розгляду деяких справ викладено всупереч резолютивній частині рішення: ' +
            outcomeMismatches.map(x => `${x.caseNumber} (у відповіді — «${x.claimed}», у рішенні — «${x.actual}»)`).join('; ') +
            '. Перевірте повний текст рішення.',
        },
      };
    }

    // Norm-attribution gate (CORE-103): the answer asserts a case APPLIED a specific
    // norm («суд застосував ч. 2 ст. 77 КАС у справі …») that the decision's own
    // citation-graph edges (legislation_citation_links) do not contain — repro
    // chat-98f8472e: ст. 77 КАС attributed to doc 116616306 whose edges are КАС 341,
    // КУ 67, ПКУ 14/42/59/70. Deterministic (one indexed lookup per doc); only judged
    // when the decision HAS graph edges (no edges = coverage gap, never flagged).
    // WARN-ONLY for now — promotion to strip after prod telemetry (CORE-103 §4).
    const normAttributionMismatches = await verifyNormAttributionsAgainstGraph(allowSet, fullAnswerText, executeTool);
    normAttributionCount = normAttributionMismatches.length;
    if (normAttributionMismatches.length > 0) {
      logger.warn('[ChatService] Norm-attribution mismatch in case citations', {
        requestId,
        mismatches: normAttributionMismatches,
      });
      yield {
        type: 'citation_warning',
        data: {
          reason: 'norm_attribution_mismatch',
          mismatches: normAttributionMismatches,
          message:
            'Застосування деяких норм у цитованих справах не підтверджується даними судового рішення: ' +
            normAttributionMismatches.map(x => `${x.caseNumber} (у відповіді — «${x.article}», ${x.actual})`).join('; ') +
            '. Перевірте повний текст рішення перед посиланням на цю норму.',
        },
      };
    }

    // Chain-attribution gate (CORE-108): an instance-chain row inside a «Справа № X»
    // section cites a document of a DIFFERENT case — a foreign decision spliced into
    // the chain (repro chat-ae921608: cassation ruling of 910/14863/22 presented as
    // the cassation stage of 910/1138/19). Deterministic and text-only. WARN-ONLY:
    // the link text itself declares the true case number, so no strip.
    const chainMismatches = findChainAttributionMismatches(fullAnswerText);
    chainAttributionCount = chainMismatches.length;
    if (chainMismatches.length > 0) {
      logger.warn('[ChatService] Chain-attribution mismatch in case citations', {
        requestId,
        mismatches: chainMismatches,
      });
      yield {
        type: 'citation_warning',
        data: {
          reason: 'chain_attribution_mismatch',
          mismatches: chainMismatches,
          message:
            'У ланцюгу інстанцій деяких справ процитовано рішення з інших справ: ' +
            chainMismatches.map(x => `у розділі справи ${x.sectionCase} наведено документ справи ${x.citedCase}`).join('; ') +
            '. Перевірте, чи належить рішення саме цій справі.',
        },
      };
    }

    // Quote-grounding gate (CORE-21 P0.1): a direct quotation attributed to a court
    // whose text we captured, but which does not appear in that text — an invented
    // holding dressed as a verbatim citation. Catches same-subject fabrication that the
    // subject-matter gate (label-level) cannot — repro chat-b8a0b5fb. Non-destructive.
    const ungroundedQuotes = allowSet.findUngroundedQuotedCitations(fullAnswerText);
    ungroundedCount = ungroundedQuotes.length;
    if (ungroundedQuotes.length > 0) {
      for (const x of ungroundedQuotes) {
        unsupportedCitations.push({ caseNumber: x.caseNumber, reason: 'наведена пряма цитата відсутня в тексті рішення' });
      }
      logger.warn('[ChatService] Ungrounded quoted citations in answer', {
        requestId,
        ungrounded: ungroundedQuotes.map(x => x.caseNumber),
      });
      yield {
        type: 'citation_warning',
        data: {
          reason: 'ungrounded_quote',
          ungrounded: ungroundedQuotes,
          message:
            'Деякі цитати, наведені як пряма мова суду, не знайдені в тексті відповідних рішень: ' +
            ungroundedQuotes.map(x => x.caseNumber).join(', ') +
            '. Можливо, формулювання позиції суду неточне — перевірте повний текст.',
        },
      };
    }

    // Claim↔source gate (CORE-21 P0.2): an LLM judge checks each cited case's captured
    // text against how the answer characterises it. Catches a PARAPHRASED holding with no
    // basis in the source — the deterministic gates miss it (no «...» quote, same subject
    // label). One cheap batched call; fail-open; non-destructive (warn-only).
    if (llm) {
      const claimCheck = await verifyCitedCaseClaims(allowSet, fullAnswerText, llm);
      claimCheckUsage = { usage: claimCheck.usage, provider: claimCheck.provider, model: claimCheck.model };
      if (claimCheck.unsupported.length > 0) {
        for (const x of claimCheck.unsupported) {
          unsupportedCitations.push({ caseNumber: x.caseNumber, reason: x.reason });
        }
        logger.warn('[ChatService] Unsupported case characterisations in answer', {
          requestId,
          unsupported: claimCheck.unsupported.map(x => x.caseNumber),
        });
        yield {
          type: 'citation_warning',
          data: {
            reason: 'claim_unsupported',
            unsupported: claimCheck.unsupported,
            message:
              'Зміст деяких справ у відповіді не підтверджується їх текстом: ' +
              claimCheck.unsupported.map(x => `${x.caseNumber} (${x.reason})`).join('; ') +
              '. Не покладайтесь на них як на позицію суду без перевірки повного тексту.',
          },
        };
      }
    }
  }

  return {
    fabricatedCaseNumbers, fabricatedLawArticles, claimCheck: claimCheckUsage,
    ...(unsupportedCitations.length > 0 ? { unsupportedCitations } : {}),
    signals: {
      fabricatedCases: fabricatedCaseNumbers.length,
      fabricatedArticles: fabricatedLawArticles.length,
      lowRelevance: lowRelevanceCount,
      subjectMismatch: subjectMismatchCount,
      ungroundedQuotes: ungroundedCount,
      outcomeMismatch: outcomeMismatchCount,
      normAttributionMismatch: normAttributionCount,
      chainAttributionMismatch: chainAttributionCount,
    },
  };
}

/**
 * CORE-28: remove fabricated references from persisted content entirely.
 * The citation_warning event already notified the client; leaving
 * "[не підтверджено: ...]" in the text confused users who re-read
 * conversations and thought it was part of the answer.
 */
export function sanitizeAnswerForPersistence(
  text: string,
  fabricatedCaseNumbers: string[],
  fabricatedLawArticles: string[]
): string {
  let out = text;
  for (const raw of fabricatedCaseNumbers) {
    const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\[не підтверджено: ${escaped}\\]`, 'g'), '');
    out = out.replace(new RegExp(`(?:справ[иа]?\\s+(?:№\\s*)?)?${escaped}`, 'g'), '');
  }
  for (const raw of fabricatedLawArticles) {
    const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\[не підтверджено: ${escaped}\\]`, 'g'), '');
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * CORE-39: guaranteed repair for fabricated citations. When the allow-set verify
 * found case numbers / law articles not backed by search results, ask the model to
 * rewrite the answer removing exactly those references (and any claim resting solely
 * on them), preserving everything else. Returns the original text unchanged on a
 * no-op (nothing fabricated, empty rewrite) or on error — repair must never make
 * the answer worse or block the response.
 */
export async function repairFabricatedCitations(
  text: string,
  fabricatedCaseNumbers: string[],
  fabricatedLawArticles: string[],
  llm: ILLMPort,
): Promise<{ repaired: string; changed: boolean; usage?: any; provider?: string; model?: string }> {
  const bad = [...fabricatedCaseNumbers, ...fabricatedLawArticles];
  if (!text || bad.length === 0) return { repaired: text, changed: false };

  // Generous cap: the rewrite is ~the same length as the original (~2.2 chars/token).
  const maxTokens = Math.min(8000, Math.ceil(text.length / 2) + 600);
  try {
    const response = await llm.chatCompletion(
      {
        messages: [
          {
            role: 'system',
            content:
              'Ти редактор юридичних відповідей. Тобі дають відповідь і перелік НЕпідтверджених посилань ' +
              '(номери судових справ або статті законів), яких немає в результатах пошуку. Перепиши відповідь, ' +
              'прибравши САМЕ ці посилання та будь-які твердження, що спираються виключно на них. ' +
              'Збережи весь інший зміст, структуру, форматування і мову (українська) без змін. ' +
              'Не додавай нових посилань і не вигадуй заміни. Поверни ЛИШЕ відредаговану відповідь, без коментарів.',
          },
          {
            role: 'user',
            content: `НЕпідтверджені посилання: ${bad.join(', ')}\n\nВідповідь:\n${text}`,
          },
        ],
        max_tokens: maxTokens,
        temperature: 0.1,
      },
      'standard',
    );
    const repaired = (response.content || '').trim();
    if (!repaired) return { repaired: text, changed: false };
    return {
      repaired,
      changed: repaired !== text,
      usage: response.usage,
      provider: response.provider,
      model: response.model,
    };
  } catch (e) {
    logger.warn('[ChatService] Citation repair failed; keeping original answer', { error: (e as Error).message });
    return { repaired: text, changed: false };
  }
}

/**
 * CORE-21 P0.enforce: repair for UNSUPPORTED citations — real cases (number exists in
 * results) cited with a quote that isn't in their text (P0.1) or a holding their text
 * doesn't support (P0.2). Unlike fabricated citations, the case is real, so the case may
 * still be legitimately on-topic; we remove only the unsupported claim/quote and drop the
 * citation itself only when it rests SOLELY on that claim. Conservative, fail-open — never
 * makes the answer worse or blocks the response.
 */
export async function repairUnsupportedCitations(
  text: string,
  unsupported: Array<{ caseNumber: string; reason: string }>,
  llm: ILLMPort,
): Promise<{ repaired: string; changed: boolean; usage?: any; provider?: string; model?: string }> {
  if (!text || unsupported.length === 0) return { repaired: text, changed: false };

  // Dedup by case number (P0.1 and P0.2 can both flag the same case).
  const byCase = new Map<string, string>();
  for (const u of unsupported) if (!byCase.has(u.caseNumber)) byCase.set(u.caseNumber, u.reason);
  const list = [...byCase.entries()].map(([num, reason]) => `${num} — ${reason}`).join('; ');

  const maxTokens = Math.min(8000, Math.ceil(text.length / 2) + 600);
  try {
    const response = await llm.chatCompletion(
      {
        messages: [
          {
            role: 'system',
            content:
              'Ти редактор юридичних відповідей. Тобі дають відповідь і перелік СПРАВ, які РЕАЛЬНО існують, ' +
              'але у відповіді їм приписано цитату чи правову позицію, що НЕ підтверджується текстом цих рішень. ' +
              'Для кожної такої справи: прибери саме цю непідтверджену цитату/твердження. Якщо посилання на справу ' +
              'спирається ВИКЛЮЧНО на це непідтверджене твердження — прибери і саме посилання на справу. Якщо справа ' +
              'згадана ще й коректно — залиш лише підтверджену частину. Якщо непідтверджене твердження ' +
              'стосується РЕЗУЛЬТАТУ розгляду справи (хто переміг; скаргу/позов задоволено чи відхилено; ' +
              'ППР скасовано чи залишено в силі) — прибери УСІ твердження про результат розгляду цієї справи, ' +
              'а не лише дослівно процитоване. Не вигадуй нових формулювань чи заміни, ' +
              'не додавай інших справ. Збережи решту змісту, структуру, форматування і мову (українська). ' +
              'Поверни ЛИШЕ відредаговану відповідь, без коментарів.',
          },
          {
            role: 'user',
            content: `Справи з непідтвердженими твердженнями: ${list}\n\nВідповідь:\n${text}`,
          },
        ],
        max_tokens: maxTokens,
        temperature: 0.1,
      },
      'standard',
    );
    const repaired = (response.content || '').trim();
    if (!repaired) return { repaired: text, changed: false };
    return {
      repaired,
      changed: repaired !== text,
      usage: response.usage,
      provider: response.provider,
      model: response.model,
    };
  } catch (e) {
    logger.warn('[ChatService] Unsupported-citation repair failed; keeping prior answer', { error: (e as Error).message });
    return { repaired: text, changed: false };
  }
}
