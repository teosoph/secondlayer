/**
 * Server-side evidence extraction from tool results.
 *
 * Mirrors the frontend extractEvidenceFromToolResult() logic so that
 * decisions, citations, and documents are persisted in conversation_messages
 * and survive page reloads.
 *
 * Types are imported from @secondlayer/shared — single source of truth.
 */

import type { Decision, Citation, VaultDocument, ExtractedEvidence } from '@secondlayer/shared';

// Re-export for consumers that import from this file
export type { Decision, Citation, VaultDocument, ExtractedEvidence };

// ── Helpers ──────────────────────────────────────────────────────────

function parseToolResultContent(result: any): any {
  if (!result) return null;

  // Extract text from MCP content blocks first
  let rawText: string | undefined;
  if (result.content && Array.isArray(result.content)) {
    const textBlock = result.content.find((b: any) => b.type === 'text');
    if (textBlock?.text) {
      rawText = textBlock.text;
    }
  }

  if (rawText) {
    try {
      return JSON.parse(rawText);
    } catch {
      // Text is not JSON — return it as a plain-text wrapper, NOT the original
      // ToolResult (which has content: [{type, text}] that breaks React rendering)
      return { text: rawText };
    }
  }

  try {
    return typeof result === 'string' ? JSON.parse(result) : result;
  } catch {
    return { text: String(result) };
  }
}

function rndId(): string {
  return Math.random().toString(36).slice(2, 8);
}

const courtDocUrl = (docId: string | number | undefined) =>
  docId ? `https://reyestr.court.gov.ua/Review/${docId}` : undefined;

/**
 * Classify court document type from available fields (title, summary, judgment_form).
 * Matches the logic in court-decision-tools.ts classifyDocumentType().
 */
function classifyDocumentType(item: any): string {
  // Explicit field from API
  const form = item?.judgment_form || item?.form_name || item?.judgment_form_name
    || item?.document_type || '';
  const formLower = String(form).toLowerCase();
  if (formLower.includes('постанова')) return 'Постанова';
  if (formLower.includes('рішення')) return 'Рішення';
  if (formLower.includes('ухвала')) return 'Ухвала';
  if (formLower.includes('вирок')) return 'Вирок';
  if (formLower.includes('окрема думка')) return 'Окрема думка';
  if (formLower.includes('окрема')) return 'Окрема ухвала';

  // Fallback: parse from title/summary/resolution/snippet
  const text = [item?.title, item?.resolution, item?.summary, item?.snippet]
    .filter(Boolean).join(' ');
  // NB: \b is ASCII-only and never matches next to Cyrillic (CORE-98) — use lookarounds.
  if (/Постанова(?![а-яіїєґ])/i.test(text)) return 'Постанова';
  if (/(?<![а-яіїєґ])Рішення(?![а-яіїєґ])/i.test(text)) return 'Рішення';
  if (/(?<![а-яіїєґ])Ухвала(?![а-яіїєґ])/i.test(text)) return 'Ухвала';
  if (/(?<![а-яіїєґ])Вирок(?![а-яіїєґ])/i.test(text)) return 'Вирок';
  if (/Окрема думка/i.test(text)) return 'Окрема думка';

  return '';
}

// ── Single tool result extraction ────────────────────────────────────

export function extractFromToolResult(
  toolName: string,
  rawResult: any,
): ExtractedEvidence {
  const decisions: Decision[] = [];
  const citations: Citation[] = [];
  const documents: VaultDocument[] = [];

  const parsed = parseToolResultContent(rawResult);
  if (!parsed) return { decisions, citations, documents };

  // ── Court case tools ─────────────────────────────────────────────
  const courtTools = [
    'search_legal_precedents',
    'search_supreme_court_practice',
    'get_case_documents_chain',
    'find_similar_fact_pattern_cases',
    'compare_practice_pro_contra',
    'get_court_decision',
    'count_cases_by_party',
    'search_court_decisions',
    'get_edrsr_decision_fulltext',
  ];
  if (courtTools.some((t) => toolName.includes(t) || toolName === t)) {
    // source_case (single)
    if (parsed.source_case) {
      const sc = parsed.source_case;
      const scDocType = classifyDocumentType(sc);
      const scCaseNum = sc.cause_num || sc.case_number || '';
      decisions.push({
        id: `sc-${sc.doc_id || Date.now()}`,
        number: scCaseNum || 'N/A',
        court: sc.court_name || sc.court || sc.court_code || '',
        date: sc.adjudication_date || sc.date || '',
        summary: sc.title || sc.resolution
          || (sc.judgment_form || sc.document_type
            ? `${sc.judgment_form || sc.document_type} у справі ${scCaseNum}`.trim()
            : '')
          || (scDocType && scCaseNum ? `${scDocType} у справі ${scCaseNum}` : '')
          || (scDocType || scCaseNum || ''),
        relevance: 100,
        status: 'active',
        documentType: scDocType,
        externalUrl: courtDocUrl(sc.doc_id),
      });
    }

    // similar_cases / results array
    const cases = parsed.similar_cases || parsed.results || parsed.cases || parsed.precedents || [];
    for (const c of cases) {
      const cDocType = classifyDocumentType(c);
      const cCaseNum = c.cause_num || c.case_number || c.number || '';
      decisions.push({
        id: `d-${c.doc_id || c.id || rndId()}`,
        number: cCaseNum || 'N/A',
        court: c.court_name || c.court_code || c.court || '',
        date: c.adjudication_date || c.date || '',
        summary: c.title || c.resolution || c.summary || c.similarity_reason
          || (Array.isArray(c.snippets) ? c.snippets.join(' ') : '')
          || (c.full_text ? c.full_text.slice(0, 300) : '')
          || (c.judgment_form || c.judgment_form_name || c.document_type
            ? `${c.judgment_form || c.judgment_form_name || c.document_type} у справі ${cCaseNum}`.trim()
            : '')
          || (cDocType && cCaseNum ? `${cDocType} у справі ${cCaseNum}` : '')
          || (cDocType || cCaseNum || ''),
        relevance: c.similarity
          ? Math.round(c.similarity * 100)
          : c.relevance
            ? Math.round(c.relevance * 100)
            : 70,
        status: 'active',
        documentType: cDocType,
        externalUrl: courtDocUrl(c.doc_id),
      });
    }

    // get_case_documents_chain format
    let chainDocs: any[] = [];
    if (parsed.documents && Array.isArray(parsed.documents)) {
      chainDocs = parsed.documents;
    } else if (parsed.grouped_documents && typeof parsed.grouped_documents === 'object') {
      chainDocs = Object.values(parsed.grouped_documents).flat();
    }
    for (const doc of chainDocs) {
      const docType = classifyDocumentType(doc);
      const caseNum = doc.case_number || parsed.case_number || '';
      decisions.push({
        id: `chain-${doc.doc_id || rndId()}`,
        number: caseNum || doc.title || 'N/A',
        court: doc.court_name || doc.court || doc.instance || '',
        date: doc.adjudication_date || doc.date || '',
        summary: doc.resolution || doc.title
          || (doc.full_text ? doc.full_text.slice(0, 300) : '')
          || (doc.judgment_form || doc.document_type
            ? `${doc.judgment_form || doc.document_type} у справі ${caseNum}`.trim()
            : '')
          || (docType && caseNum ? `${docType} у справі ${caseNum}` : '')
          || (docType || caseNum || ''),
        relevance: 80,
        status: 'active',
        documentType: docType,
        externalUrl: courtDocUrl(doc.doc_id),
      });
    }

    // compare_practice_pro_contra format
    const proContraCases = [...(parsed.pro || []), ...(parsed.contra || [])];
    for (const c of proContraCases) {
      decisions.push({
        id: `pc-${c.doc_id || rndId()}`,
        number: c.case_number || 'N/A',
        court: c.court || c.chamber || '',
        date: c.date || '',
        summary: c.snippet || '',
        relevance: 70,
        status: 'active',
        documentType: classifyDocumentType(c),
        externalUrl: courtDocUrl(c.doc_id),
      });
    }

    // get_court_decision — single decision with sections
    if (parsed.sections && Array.isArray(parsed.sections) && (parsed.doc_id || parsed.case_number)) {
      // Pick best summary: DECISION > COURT_REASONING > FACTS > HEADER > full_text fallback
      const summarySection = parsed.sections.find((s: any) => s.type === 'DECISION')
        || parsed.sections.find((s: any) => s.type === 'COURT_REASONING')
        || parsed.sections.find((s: any) => s.type === 'FACTS')
        || parsed.sections.find((s: any) => s.type === 'HEADER');
      const summaryText = summarySection?.text?.slice(0, 500)
        || (parsed.full_text ? parsed.full_text.slice(0, 500) : '');
      decisions.push({
        id: `gcd-${parsed.doc_id || Date.now()}`,
        number: parsed.case_number || String(parsed.doc_id) || 'N/A',
        court: parsed.court_name || '',
        date: parsed.adjudication_date || '',
        summary: summaryText,
        relevance: 100,
        status: 'active',
        documentType: classifyDocumentType({ judgment_form: parsed.judgment_form }),
        externalUrl: courtDocUrl(parsed.doc_id),
      });
    }
  }

  // ── Legislation tools ────────────────────────────────────────────
  const legislationTools = [
    'search_legislation',
    'get_legislation_article',
    'get_legislation_articles',
    'get_legislation_section',
    'find_relevant_law_articles',
  ];
  if (legislationTools.some((t) => toolName.includes(t) || toolName === t)) {
    // Single article result
    if (parsed.full_text || parsed.text || parsed.content) {
      const articleNum = parsed.article_number || parsed.section_name || '';
      const title = parsed.title || parsed.rada_id || parsed.legislation_id || '';
      citations.push({
        text: parsed.full_text || parsed.text || parsed.content || '',
        source: articleNum ? `${title}, ст. ${articleNum}` : title,
      });
    }

    // Array of legislation results
    const legislationArray = parsed.legislation || (toolName === 'search_legislation' ? parsed.articles : null);
    if (legislationArray && Array.isArray(legislationArray)) {
      for (const l of legislationArray) {
        citations.push({
          text: l.full_text || l.text || l.snippet || l.title || '',
          source: l.article_number
            ? `${l.title || l.rada_id || 'Норма'}, ст. ${l.article_number}`
            : (l.title || l.type || 'Нормативний акт'),
        });
      }
    }

    // find_relevant_law_articles — returns array of string refs
    if (toolName === 'find_relevant_law_articles') {
      const refs = parsed.relevant_articles || parsed.articles || (Array.isArray(parsed) ? parsed : []);
      for (const r of refs) {
        if (typeof r === 'string') {
          citations.push({ text: r, source: r });
        } else if (r?.article || r?.reference || r?.norm) {
          citations.push({
            text: r.text || r.content || r.description || r.article || r.reference || r.norm || '',
            source: r.article || r.reference || r.norm || r.title || 'Норма',
          });
        }
      }
    } else if (parsed.articles && Array.isArray(parsed.articles)) {
      for (const a of parsed.articles) {
        if (typeof a === 'object' && a !== null) {
          citations.push({
            text: a.full_text || a.text || a.content || '',
            source: `Стаття ${a.article_number || ''}`,
          });
        }
      }
    }
  }

  // ── Procedural norm tools ────────────────────────────────────────
  const proceduralNormTools = [
    'search_procedural_norms',
    'calculate_procedural_deadlines',
    'build_procedural_checklist',
  ];
  if (proceduralNormTools.some((t) => toolName === t)) {
    const textContent = rawResult?.content?.find((b: any) => b.type === 'text')?.text;
    if (textContent) {
      const sourceLabel =
        toolName === 'search_procedural_norms' ? 'Процесуальна норма' :
        toolName === 'calculate_procedural_deadlines' ? 'Процесуальні строки' :
        'Процесуальний чеклист';
      citations.push({ text: textContent, source: sourceLabel });
    }
  }

  // ── Vault / document tools ───────────────────────────────────────
  const vaultTools = [
    'list_documents', 'semantic_search', 'semantic_search_vault',
    'get_document', 'store_document', 'parse_document',
    'extract_document_sections', 'summarize_document',
    'compare_documents', 'extract_key_clauses',
  ];
  if (vaultTools.some((t) => toolName.includes(t) || toolName === t)) {
    if (parsed.documents && Array.isArray(parsed.documents)) {
      for (const doc of parsed.documents) {
        documents.push({
          id: doc.id || `vd-${rndId()}`,
          title: doc.title || doc.name || 'Без назви',
          type: doc.type || 'other',
          uploadedAt: doc.created_at || doc.uploadedAt || doc.uploaded_at || '',
          metadata: doc.metadata || {},
        });
      }
    }
    if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].documentId) {
      for (const r of parsed) {
        documents.push({
          id: r.documentId || `vd-${rndId()}`,
          title: r.title || r.sectionTitle || 'Без назви',
          type: r.type || 'other',
          metadata: { relevance: r.relevance, snippet: r.text?.slice(0, 200) },
        });
      }
    }
    if (parsed.id && parsed.title && !parsed.documents) {
      documents.push({
        id: parsed.id,
        title: parsed.title,
        type: parsed.type || 'other',
        uploadedAt: parsed.created_at || parsed.uploadedAt || '',
        metadata: parsed.metadata || {},
      });
    }
  }

  // ── retrieve_legal_sources ───────────────────────────────────────
  if (toolName === 'retrieve_legal_sources') {
    if (parsed.cases && Array.isArray(parsed.cases)) {
      for (const c of parsed.cases) {
        decisions.push({
          id: `rls-${c.id || rndId()}`,
          number: c.id || 'N/A',
          court: c.court || '',
          date: c.date || '',
          summary: c.text?.slice(0, 300) || c.title || '',
          relevance: 70,
          status: 'active',
        });
      }
    }
    if (parsed.laws && Array.isArray(parsed.laws)) {
      for (const l of parsed.laws) {
        citations.push({
          text: l.text || l.full_text || l.title || '',
          source: l.article ? `${l.title || l.rada_id || ''}, ст. ${l.article}` : (l.title || 'Норма'),
        });
      }
    }
  }

  // ── RADA / Parliament tools ──────────────────────────────────────
  const radaTools = [
    'rada_search_parliament_bills',
    'rada_get_deputy_info',
    'rada_search_legislation_text',
    'rada_analyze_voting_record',
  ];
  if (radaTools.some((t) => toolName === t)) {
    if (parsed.bills && Array.isArray(parsed.bills)) {
      for (const bill of parsed.bills) {
        documents.push({
          id: `bill-${bill.id || bill.number || rndId()}`,
          title: bill.title || bill.name || `Законопроект ${bill.number || ''}`,
          type: 'legislation',
          metadata: {
            snippet: bill.summary || bill.description || '',
            status: bill.status,
            number: bill.number,
            date: bill.date || bill.registration_date,
          },
        });
      }
    }
    if (parsed.name && (parsed.faction || parsed.party || parsed.deputy_id)) {
      documents.push({
        id: `deputy-${parsed.deputy_id || parsed.id || rndId()}`,
        title: parsed.name || parsed.full_name || 'Народний депутат',
        type: 'other',
        metadata: {
          snippet: [parsed.faction || parsed.party, parsed.region, parsed.position].filter(Boolean).join(' • '),
          deputy_id: parsed.deputy_id || parsed.id,
        },
      });
    }
    if (parsed.deputies && Array.isArray(parsed.deputies)) {
      for (const dep of parsed.deputies) {
        documents.push({
          id: `deputy-${dep.id || rndId()}`,
          title: dep.name || dep.full_name || 'Депутат',
          type: 'other',
          metadata: {
            snippet: [dep.faction || dep.party, dep.region].filter(Boolean).join(' • '),
          },
        });
      }
    }
    if (parsed.results && Array.isArray(parsed.results) && toolName === 'rada_search_legislation_text') {
      for (const r of parsed.results) {
        citations.push({
          text: (r.text || r.snippet || r.content || '').slice(0, 500),
          source: r.title || r.law_title || r.source || 'Законодавство',
        });
      }
    }
    if (parsed.votings && Array.isArray(parsed.votings)) {
      for (const v of parsed.votings) {
        citations.push({
          text: `За: ${v.yes || 0}, Проти: ${v.no || 0}, Утримались: ${v.abstain || 0}${v.result ? ` — ${v.result}` : ''}`,
          source: v.title || v.bill_title || 'Голосування',
        });
      }
    }
    if (parsed.voting_summary) {
      citations.push({
        text: typeof parsed.voting_summary === 'string'
          ? parsed.voting_summary.slice(0, 500)
          : JSON.stringify(parsed.voting_summary).slice(0, 500),
        source: 'Аналіз голосувань',
      });
    }
  }

  // ── OpenReyestr / Business registry tools ────────────────────────
  const registryTools = [
    'openreyestr_search_entities', 'openreyestr_get_entity_details',
    'openreyestr_search_beneficiaries', 'openreyestr_get_by_edrpou',
    'openreyestr_get_statistics', 'openreyestr_search_enforcement_proceedings',
    'openreyestr_search_debtors', 'openreyestr_search_bankruptcy_cases',
    'openreyestr_search_notaries', 'openreyestr_search_court_experts',
    'openreyestr_search_arbitration_managers',
  ];
  if (registryTools.some((t) => toolName === t)) {
    const entities = parsed.entities || parsed.results || [];
    if (Array.isArray(entities) && entities.length > 0 && (entities[0].name || entities[0].full_name || entities[0].edrpou)) {
      for (const e of entities) {
        documents.push({
          id: `entity-${e.id || e.edrpou || rndId()}`,
          title: e.name || e.full_name || e.short_name || 'Юрособа',
          type: 'other',
          metadata: {
            snippet: [e.edrpou && `ЄДРПОУ: ${e.edrpou}`, e.address, e.status].filter(Boolean).join(' • '),
            edrpou: e.edrpou,
            status: e.status,
          },
        });
      }
    }
    if (parsed.name && parsed.edrpou && !parsed.entities) {
      documents.push({
        id: `entity-${parsed.edrpou}`,
        title: parsed.name || parsed.full_name || 'Юрособа',
        type: 'other',
        metadata: {
          snippet: [
            `ЄДРПОУ: ${parsed.edrpou}`,
            parsed.address,
            parsed.status,
            parsed.head && `Керівник: ${parsed.head}`,
          ].filter(Boolean).join(' • '),
          edrpou: parsed.edrpou,
          status: parsed.status,
        },
      });
    }
    if (parsed.beneficiaries && Array.isArray(parsed.beneficiaries)) {
      for (const b of parsed.beneficiaries) {
        documents.push({
          id: `benef-${b.id || rndId()}`,
          title: b.name || b.full_name || 'Бенефіціар',
          type: 'other',
          metadata: {
            snippet: [b.share && `Частка: ${b.share}%`, b.country, b.entity_name].filter(Boolean).join(' • '),
          },
        });
      }
    }
    if (parsed.statistics || parsed.total_count != null) {
      citations.push({
        text: typeof parsed.statistics === 'string'
          ? parsed.statistics
          : `Загалом: ${parsed.total_count || 0}. ${parsed.summary || ''}`.trim(),
        source: 'Статистика реєстру',
      });
    }
  }

  // ── Procedural tools ─────────────────────────────────────────────
  const proceduralTools = [
    'calculate_procedural_deadlines',
    'build_procedural_checklist',
    'calculate_monetary_claims',
  ];
  if (proceduralTools.some((t) => toolName === t)) {
    if (parsed.deadlines && Array.isArray(parsed.deadlines)) {
      for (const dl of parsed.deadlines) {
        citations.push({
          text: `${dl.description || dl.action || dl.name}: ${dl.deadline || dl.date || dl.days_left ? `${dl.days_left} днів` : ''}`,
          source: dl.legal_basis || dl.norm || 'Процесуальний строк',
        });
      }
    }
    if (parsed.checklist && Array.isArray(parsed.checklist)) {
      for (const item of parsed.checklist) {
        citations.push({
          text: `${item.step || item.action || item.description || ''}${item.deadline ? ` (до ${item.deadline})` : ''}`,
          source: item.legal_basis || item.norm || 'Процесуальний чеклист',
        });
      }
    }
    if (parsed.items && Array.isArray(parsed.items)) {
      for (const item of parsed.items) {
        citations.push({
          text: item.description || item.text || item.name || '',
          source: item.legal_basis || 'Чеклист',
        });
      }
    }
    if (parsed.total != null || parsed.amount != null || parsed.calculation) {
      citations.push({
        text: parsed.calculation
          || `Загальна сума: ${parsed.total || parsed.amount || 0} грн${parsed.breakdown ? `. ${parsed.breakdown}` : ''}`,
        source: parsed.legal_basis || 'Розрахунок грошових вимог',
      });
    }
    if (parsed.components && Array.isArray(parsed.components)) {
      for (const comp of parsed.components) {
        citations.push({
          text: `${comp.name || comp.type || 'Складова'}: ${comp.amount || 0} грн`,
          source: comp.legal_basis || 'Складова вимоги',
        });
      }
    }
  }

  // ── Due Diligence tools ──────────────────────────────────────────
  const ddTools = ['generate_dd_report', 'risk_scoring', 'format_answer_pack'];
  if (ddTools.some((t) => toolName === t)) {
    if (parsed.report || parsed.summary || parsed.findings) {
      const reportText = parsed.report || parsed.summary || '';
      if (reportText) {
        citations.push({
          text: (typeof reportText === 'string' ? reportText : JSON.stringify(reportText)).slice(0, 500),
          source: 'Due Diligence звіт',
        });
      }
      if (parsed.findings && Array.isArray(parsed.findings)) {
        for (const f of parsed.findings) {
          citations.push({
            text: (f.description || f.text || f.finding || '').slice(0, 500),
            source: f.category || f.type || 'Висновок DD',
          });
        }
      }
    }
    if (parsed.risk_score != null || parsed.score != null) {
      citations.push({
        text: `Рівень ризику: ${parsed.risk_score || parsed.score}${parsed.risk_level ? ` (${parsed.risk_level})` : ''}. ${parsed.explanation || parsed.summary || ''}`.trim(),
        source: 'Скоринг ризиків',
      });
    }
    if (parsed.risks && Array.isArray(parsed.risks)) {
      for (const r of parsed.risks) {
        citations.push({
          text: `${r.name || r.type || 'Ризик'}: ${r.score || r.level || ''}. ${r.description || ''}`.trim(),
          source: r.category || 'Ризик',
        });
      }
    }
    if (parsed.answers && Array.isArray(parsed.answers)) {
      for (const a of parsed.answers) {
        citations.push({
          text: (a.answer || a.text || a.content || '').slice(0, 500),
          source: a.question || a.topic || 'Відповідь',
        });
      }
    }
  }

  return { decisions, citations, documents };
}

// ── Norm extraction from answer text ─────────────────────────────────

export function extractNormsFromAnswer(answerText: string): Citation[] {
  const norms: Citation[] = [];
  const seen = new Set<string>();

  const CODES = '(?:ЦКУ|ГКУ|КПК|ЦПК|ГПК|КАС|ПКУ|СКУ|ККУ|КЗпП|ЗКУ|МКУ|ЦК|ГК|ПК|ЗК|МК)';
  const FULL_LAW = '(?:[А-ЯҐЄІЇа-яґєії]+ого\\s+[Кк]одексу(?:\\s+України)?|[Зз]акону\\s+України(?:\\s+[«""][^»""]{1,80}[»""])?|[Кк]онституції\\s+України|[Кк]онвенції[^,;.]{0,50})';
  const ST = 'ст(?:атт[а-яіїєґ]*)?';

  const re = new RegExp(
    '(?:(?:п\\.?\\s*\\d+[,\\s]+)?(?:ч\\.?\\s*\\d+[,\\s]+))?' +
    ST + '\\.?\\s*\\d+(?:[\\u2013\\u2014,\\-]\\s*\\d+)*\\s+(?:' + CODES + '|' + FULL_LAW + ')(?:\\s+України)?' +
    '|' + ST + '\\.?\\s*\\d+\\s+Конституц[іи][їи]\\s+України',
    'gi'
  );

  const sentences = answerText.split(/\n|(?<=[.;!?])\s+/);
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(trimmed)) !== null) {
      const ref = match[0].trim();
      const key = ref.toLowerCase().replace(/\s+/g, ' ');
      if (!seen.has(key)) {
        seen.add(key);
        norms.push({ text: trimmed, source: ref });
      }
    }
  }
  return norms;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Extract all evidence (decisions, citations, documents) from collected
 * thinking steps (tool results) and optionally from the final answer text.
 */
export function extractAllEvidence(
  thinkingSteps: Array<{ tool: string; params: any; result: any }>,
  answerText?: string,
): ExtractedEvidence {
  const allDecisions: Decision[] = [];
  const allCitations: Citation[] = [];
  const allDocuments: VaultDocument[] = [];

  for (const step of thinkingSteps) {
    const evidence = extractFromToolResult(step.tool, step.result);
    allDecisions.push(...evidence.decisions);
    allCitations.push(...evidence.citations);
    allDocuments.push(...evidence.documents);
  }

  // Extract norm references from the answer text
  if (answerText) {
    const answerNorms = extractNormsFromAnswer(answerText);
    allCitations.push(...answerNorms);
  }

  return {
    decisions: allDecisions,
    citations: allCitations,
    documents: allDocuments,
  };
}

/**
 * EvidenceTracker — accumulates deduplicated evidence (decisions, citations,
 * documents) across tool results during one chat request, for incremental
 * evidence_update SSE events. Extracted from ChatService (CORE-21).
 */
export class EvidenceTracker {
  readonly decisions: Decision[] = [];
  readonly citations: Citation[] = [];
  readonly documents: VaultDocument[] = [];
  private seenDecisionIds = new Set<string>();
  private seenCitationKeys = new Set<string>();
  private seenDocumentIds = new Set<string>();

  /** Ingest evidence extracted from one tool result (deduplicated). */
  ingest(evidence: { decisions: Decision[]; citations: Citation[]; documents: VaultDocument[] }): void {
    for (const d of evidence.decisions) {
      if (!this.seenDecisionIds.has(d.id)) {
        this.seenDecisionIds.add(d.id);
        this.decisions.push(d);
      }
    }
    this.ingestCitations(evidence.citations);
    for (const doc of evidence.documents) {
      if (!this.seenDocumentIds.has(doc.id)) {
        this.seenDocumentIds.add(doc.id);
        this.documents.push(doc);
      }
    }
  }

  /** Ingest citations alone (e.g. norms extracted from the answer text). */
  ingestCitations(citations: Citation[]): void {
    for (const c of citations) {
      const key = c.source.toLowerCase().replace(/\s+/g, ' ').trim();
      if (!this.seenCitationKeys.has(key)) {
        this.seenCitationKeys.add(key);
        this.citations.push(c);
      }
    }
  }

  get hasAny(): boolean {
    return this.decisions.length > 0 || this.citations.length > 0 || this.documents.length > 0;
  }

  /** Payload for the evidence_update SSE event. */
  payload(): { decisions: Decision[]; citations: Citation[]; documents: VaultDocument[] } {
    return { decisions: this.decisions, citations: this.citations, documents: this.documents };
  }
}
