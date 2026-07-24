/**
 * CORE-21 P0.2 — claim↔source verifier.
 *
 * For each cited allow-set case we captured text for, a single batched cheap
 * (quick-tier) LLM call judges whether the case's text supports how the answer
 * characterises it. This is the layer the deterministic gates cannot cover:
 *  - fabrication guard:   case number not in results        (handled by verify())
 *  - quote-grounding:     an explicit «...» quote not in text (CORE-21 P0.1)
 *  - subject-matter:      a CONFLICTING subject label        (CORE-40)
 *  - claim verifier:      a PARAPHRASED holding with no basis in the source  ← here
 *
 * Repro chat-b8a0b5fb: three real ст.266 КАС ВС cases were given paraphrased
 * occupied-territory / ДРРП holdings their texts never state — same subject label,
 * no quote marks, so only a content-level check catches them.
 *
 * Safety: conservative prompt (default "uncertain" when unsure), temperature 0, and
 * fail-open — any parse/transport error flags nothing. Non-destructive: the caller
 * surfaces results as a citation_warning, not a strip.
 */

import { logger } from '../utils/logger.js';
import { IncrementalAllowSet } from './incremental-allow-set.js';
import type { ILLMPort } from '../domain/ports/index.js';

export interface ClaimVerdict {
  caseNumber: string;
  reason: string;
}

export interface ClaimCheckResult {
  unsupported: ClaimVerdict[];
  usage?: any;
  provider?: string;
  model?: string;
}

/** Lenient parse of the verifier's JSON array; tolerates code fences / surrounding prose. */
export function parseClaimVerdicts(
  content: string | undefined,
  n: number,
): Map<number, { verdict: string; reason: string }> {
  const out = new Map<number, { verdict: string; reason: string }>();
  if (!content) return out;
  const match = content.match(/\[[\s\S]*\]/);
  if (!match) return out;
  try {
    const arr = JSON.parse(match[0]);
    if (!Array.isArray(arr)) return out;
    for (const e of arr) {
      const i = Number(e?.i);
      if (!Number.isInteger(i) || i < 0 || i >= n) continue;
      if (typeof e?.verdict !== 'string') continue;
      out.set(i, { verdict: e.verdict.toLowerCase().trim(), reason: typeof e.reason === 'string' ? e.reason : '' });
    }
  } catch {
    /* fail-open: no verdicts → nothing flagged */
  }
  return out;
}

export async function verifyCitedCaseClaims(
  allowSet: IncrementalAllowSet,
  answerText: string,
  llm: ILLMPort,
): Promise<ClaimCheckResult> {
  const items = allowSet.getCitedCaseClaims(answerText);
  if (items.length === 0) return { unsupported: [] };

  const payload = items
    .map((it, i) =>
      `[${i}] Справа ${it.caseNumber}\nЯК ПОДАНО У ВІДПОВІДІ:\n${it.claim}\n\nТЕКСТ РІШЕННЯ (витяг):\n${it.source}`)
    .join('\n\n---\n\n');

  try {
    const response = await llm.chatCompletion(
      {
        messages: [
          {
            role: 'system',
            content:
              'Ти юридичний фактчекер. Для КОЖНОЇ справи порівняй, ЯК її подано у відповіді (фабула, ' +
              'позиція чи висновок суду), з ТЕКСТОМ рішення. Визнач: "supported" — текст рішення явно ' +
              'підтверджує подану характеристику; "unsupported" — текст про ІНШУ фабулу/предмет або прямо ' +
              'суперечить поданому; "uncertain" — наданого витягу недостатньо, щоб судити. Будь ' +
              'КОНСЕРВАТИВНИМ: якщо вагаєшся між unsupported і uncertain — обери uncertain. Поверни ЛИШЕ ' +
              'JSON-масив, без пояснень: ' +
              '[{"i":<номер з дужок>,"verdict":"supported|unsupported|uncertain","reason":"<до 12 слів українською>"}]',
          },
          { role: 'user', content: payload },
        ],
        max_tokens: 80 * items.length + 200,
        temperature: 0,
      },
      'quick',
    );
    const verdicts = parseClaimVerdicts(response.content, items.length);
    const unsupported = items
      .map((it, i) => ({ it, v: verdicts.get(i) }))
      .filter(x => x.v?.verdict === 'unsupported')
      .map(x => ({ caseNumber: x.it.caseNumber, reason: x.v!.reason || 'текст рішення стосується іншого предмета' }));
    return { unsupported, usage: response.usage, provider: response.provider, model: response.model };
  } catch (e) {
    logger.warn('[ChatService] Claim verification failed; skipping (fail-open)', { error: (e as Error).message });
    return { unsupported: [] };
  }
}
