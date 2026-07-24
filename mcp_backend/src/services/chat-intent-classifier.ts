/**
 * IntentClassifier — classifies user chat intent and filters tools.
 *
 * Extracted from ChatService to isolate the classification logic
 * (LLM call, regex safety nets, slot coercions, queryType coercions).
 */

import { logger } from '../utils/logger.js';
import { ToolRegistry, ToolDefinition } from '../api/tool-registry.js';
import { QueryPlanner } from './query-planner.js';
import type { ILLMPort } from '../domain/ports/index.js';
import { ModelSelector } from '@secondlayer/shared';
import {
  CHAT_INTENT_CLASSIFICATION_PROMPT,
  DOMAIN_TOOL_MAP,
  DEFAULT_TOOLS,
  VALID_QUERY_TYPES,
  type QueryType,
  type ChatIntentClassification,
} from '../prompts/chat-system-prompt.js';
import { getScenarioPriorityTools, resolveToolGroupsByDomains, resolveToolGroupsByToolNames } from '../prompts/tool-registry-catalog.js';
import { QUERY_TYPE_CONFIG } from '../prompts/query-type-config.js';
import { TOOL_GROUPS } from '../prompts/tool-registry-catalog.js';
import type { ExecutionPlan } from '../prompts/chat-system-prompt.js';

/** Virtual meta-tool definition — safety valve when LLM needs tools not in the filtered set */
const META_TOOL_DEF: ToolDefinition = {
  name: 'request_additional_tools',
  description: `Запитати додаткові інструменти з конкретної групи. Використовуй якщо потрібні інструменти, яких немає у поточному наборі. Доступні групи: ${TOOL_GROUPS.map(g => `${g.id} (${g.label})`).join(', ')}`,
  inputSchema: {
    type: 'object',
    properties: {
      groups: {
        type: 'array',
        items: { type: 'string' },
        description: 'Масив ідентифікаторів груп інструментів',
      },
    },
    required: ['groups'],
  },
};

interface CostRecorder {
  recordStreamingCost(
    requestId: string,
    provider: string,
    model: string,
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
    task: string
  ): void;
}

export interface ClassifyLLMMetadata {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  durationMs: number;
}

export class IntentClassifier {
  /** LLM metadata from the most recent classify() call — used by PipelineMetrics */
  lastClassifyMeta?: ClassifyLLMMetadata;

  constructor(
    private toolRegistry: ToolRegistry,
    private queryPlanner: QueryPlanner,
    private llm: ILLMPort,
    private costRecorder?: CostRecorder
  ) {}

  /**
   * Classify chat intent using a fast LLM call (gpt-4o-mini ~200ms).
   * Falls back to keyword-based QueryPlanner on error.
   */
  async classify(query: string, requestId?: string): Promise<ChatIntentClassification> {
    this.lastClassifyMeta = undefined;
    const classifyStart = Date.now();
    try {
      const llm = this.llm;

      const classifyChars = CHAT_INTENT_CLASSIFICATION_PROMPT.length + query.length;
      logger.debug('[IntentClassifier] Intent classification prompt size', {
        chars: classifyChars,
        estimatedTokens: Math.ceil(classifyChars / 2.2),
      });

      const response = await llm.chatCompletion(
        {
          messages: [
            { role: 'system', content: CHAT_INTENT_CLASSIFICATION_PROMPT },
            { role: 'user', content: query },
          ],
          max_tokens: 300,
          temperature: 0.1,
          response_format: { type: 'json_object' },
        },
        'quick'
      );

      // Capture LLM metadata for PipelineMetrics
      if (response.usage) {
        this.lastClassifyMeta = {
          provider: response.provider,
          model: response.model,
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          costUsd: ModelSelector.estimateCostAccurate(response.model, response.usage.prompt_tokens, response.usage.completion_tokens),
          durationMs: Date.now() - classifyStart,
        };
      }

      // Record classification LLM cost
      if (requestId && response.usage && this.costRecorder) {
        this.costRecorder.recordStreamingCost(requestId, response.provider, response.model, response.usage, 'intent_classification');
      }

      const content = response.content || '{}';

      // Extract JSON from response (may be wrapped in markdown code blocks)
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in classification response');
      }

      const parsed = JSON.parse(jsonMatch[0]);

      const domains = Array.isArray(parsed.domains) && parsed.domains.length > 0
        ? parsed.domains
        : ['court'];
      const keywords = typeof parsed.keywords === 'string' ? parsed.keywords : query;
      let slots: Record<string, any> | undefined = parsed.slots && typeof parsed.slots === 'object' && Object.keys(parsed.slots).length > 0
        ? parsed.slots
        : undefined;

      // Force-include domains based on extracted slots
      if (slots?.edrpou && !domains.includes('registry')) {
        domains.push('registry');
      }
      if (slots?.case_number && !domains.includes('court')) {
        domains.push('court');
      }
      if (slots?.law_reference && !domains.includes('legislation')) {
        domains.push('legislation');
      }

      // Safety net: extract case_number from query if LLM missed it
      if (!slots?.case_number) {
        const caseMatch = query.match(/\d{1,10}\/\d{1,10}\/\d{2,4}/);
        if (caseMatch) {
          if (!slots) slots = {};
          slots.case_number = caseMatch[0];
        }
      }

      // Keyword-based safety net for registry queries
      const lowerQuery = query.toLowerCase();
      const registryKeywords = ['тов ', 'тов "', 'тов «', 'фоп ', 'пп ', 'ат ', 'єдрпоу', 'edrpou', 'підприємство', 'компанія', 'юридична особа'];
      const hasRegistryKeyword = registryKeywords.some(kw => lowerQuery.includes(kw));
      const hasEdrpouPattern = /\b\d{8}\b/.test(query);
      if ((hasRegistryKeyword || hasEdrpouPattern) && !domains.includes('registry')) {
        domains.push('registry');
      }

      // Safety net: specific registry sub-tool hints based on keywords
      if (domains.includes('registry')) {
        const registrySubKeywords: Array<[RegExp, string]> = [
          [/банкрут|ліквідац/i, 'openreyestr_search_bankruptcy_cases'],
          [/тендер|prozorro|прозорро|закупівл/i, 'openreyestr_search_prozorro'],
          [/декларац|назк|НАЗК/i, 'openreyestr_search_nazk_declarations'],
          [/санкці.{0,20}(?:рнбо|РНБО|нацбез)/i, 'openreyestr_search_rnbo_sanctions'],
          [/арма|АРМА|арештован.{0,20}актив/i, 'openreyestr_search_arma_seized_assets'],
          [/виконавч.{0,20}провадж/i, 'openreyestr_search_enforcement_proceedings'],
          [/боржник|борг.{0,20}реєстр/i, 'openreyestr_search_debtors'],
        ];
        for (const [pattern, toolHint] of registrySubKeywords) {
          if (pattern.test(query)) {
            if (!slots) slots = {};
            slots.registry_tool_hint = toolHint;
            break;
          }
        }
      }

      // Safety net for OSINT queries (IP, domain, sanctions, credentials, CVE, darknet)
      const osintKeywords = ['osint', 'санкці', 'ofac', 'інтерпол', 'interpol', 'дебармент', 'debarment', 'ransomware', 'darknet', 'dark net', 'virustotal', 'abuseipdb', 'greynoise', 'cve ', 'вразливост', 'витоки', 'credentials', 'leak', 'offshore', 'panama papers', 'paradise papers', 'icij', 'gleif'];
      const hasOsintKeyword = osintKeywords.some(kw => lowerQuery.includes(kw));
      const hasIpCheck = /(?:перевір|check|репутаці|reputation|шкідлив|malicious|abuse).{0,30}(?:ip|ір)|(?:ip|ір).{0,30}(?:перевір|check|репутаці|reputation|шкідлив|malicious|abuse)/i.test(query);
      const hasDomainCheck = /(?:перевір|check|репутаці|reputation).{0,30}(?:домен|domain)|(?:домен|domain).{0,30}(?:перевір|check|репутаці|reputation)/i.test(query);
      const hasIpPattern = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(query);
      if ((hasOsintKeyword || hasIpCheck || hasDomainCheck || (hasIpPattern && /перевір|check|шкідлив|malicious|reputation|репутаці/i.test(query))) && !domains.includes('osint')) {
        domains.push('osint');
      }

      // Safety net: ECHR queries should use ECHR tools, not Vault/documents
      const hasEchrKeyword = /єспл|echr|європейськ.{0,20}суд.{0,20}прав|конвенц.{0,20}прав.{0,20}людин|hudoc/i.test(query);
      if (hasEchrKeyword) {
        if (!domains.includes('court')) domains.push('court');
        const docIdx = domains.indexOf('documents');
        if (docIdx !== -1) domains.splice(docIdx, 1);
      }

      // Safety net for documents/vault queries
      const documentsKeywords = ['vault', 'сховищ', 'завантажив', 'завантажені', 'мої документи', 'мої файли', 'загрузил', 'зарузил', 'загруженн', 'зберіг', 'збережені', 'uploaded', 'my documents', 'my files', 'видали', 'видалити', 'удали', 'удалить', 'delete', 'перейменуй', 'переименуй', 'rename', 'перенеси', 'move', 'папк', 'тег', 'tag', 'позначк', 'проаналізуй документ', 'проаналізуй договір', 'резюме документ', 'короткий зміст', 'ключові пункти', 'витяг положень', 'порівняй документ', 'що змінилось', 'аналіз договору', 'аналіз документ'];
      const hasDocumentsKeyword = documentsKeywords.some(kw => lowerQuery.includes(kw));
      if (hasDocumentsKeyword && !domains.includes('documents')) {
        domains.push('documents');
      }

      // Parse queryType with validation and safety coercions
      let queryType: QueryType = 'legal_consultation';
      if (parsed.queryType && VALID_QUERY_TYPES.has(parsed.queryType)) {
        queryType = parsed.queryType as QueryType;
      }

      // Safety coercions based on slots
      if (slots?.case_number && queryType === 'legal_consultation') {
        queryType = 'case_lookup';
      }
      if (slots?.edrpou && queryType === 'legal_consultation') {
        queryType = 'registry_lookup';
      }
      if (slots?.law_reference && queryType === 'legal_consultation') {
        queryType = 'legislation_lookup';
      }

      // Regex-based queryType coercions when LLM defaults to legal_consultation
      if (queryType === 'legal_consultation') {
        // Legislation amendment history: "зміни до закону", "редакції", "історія змін", "еволюція норми"
        if (/зміни?.{0,30}(?:закон|норм|стат|редакц|пункт|постанов)|редакці[яї]|історі[яї].{0,20}(?:змін|закон|норм)|еволюці[яї].{0,20}норм/i.test(query)) {
          queryType = 'legislation_lookup';
        }
        // Legislation: "ст. 16 ЦК", "стаття 382 КК", "ч. 3 ст. 16"
        else if (/ст(?:атт[яію])?\.?\s?\d+/i.test(query) || /(?:^|\s)(?:ЦК|КК|ГПК|ЦПК|КАС|ГК|ЗК|СК|КЗпП)(?:\s|$|[,.])/i.test(query)) {
          queryType = 'legislation_lookup';
        }
        // Registry: ЄДРПОУ, 8-digit code, ТОВ/ПАТ/ФОП lookup
        else if (hasEdrpouPattern || lowerQuery.includes('єдрпоу') || lowerQuery.includes('edrpou')) {
          queryType = 'registry_lookup';
        }
        // Institutional analysis: judge/court statistics, deep analysis over time
        else if (/рейтинг.{0,30}(?:судд|суд)|статистик.{0,30}(?:судд|суд)|відсот.{0,30}(?:задовол|відмов).{0,30}судд|тенденці.{0,30}(?:закрит|судд)/i.test(lowerQuery)) {
          queryType = 'institutional_analysis';
        }
        // Institutional analysis: "аналіз рішень суддів суду за N років", "проаналізуй всі рішення суду"
        else if (/аналіз.{0,30}рішень.{0,30}судд|проаналізу.{0,30}всі.{0,30}рішення.{0,30}суд|всі справи судді|аналіз суду за.{0,20}років|аналіз.{0,30}судді.{0,20}за.{0,10}рок/i.test(lowerQuery)) {
          queryType = 'institutional_analysis';
        }
        // Practice analysis: "аналіз практики", "судова практика", "як суди"
        else if (/проаналізу|аналіз практик|судова практика|знайти справи|знайти практику|огляд практики|яка практика|як суди|позиція судів/i.test(query)) {
          queryType = 'practice_analysis';
        }
        // Document drafting: "напиши позовну", "зразок скарги", "склади заяву"
        else if (/(?:^|\s)(?:напиш[иі]|склад[иі]|підготуй|зразок|шаблон)\s.{0,60}(?:позов|скарг|заяв|клопотан|претенз)/i.test(query)) {
          queryType = 'document_drafting';
        }
        // Due diligence: "перевір контрагента/компанію/власників", "due diligence"
        else if (/due.?diligence|перевір.{0,30}(?:контрагент|компані|підприємств|власник|бенефіціар|засновник|афілі)|комплексна перевірка|корупц.{0,30}схем/i.test(query)) {
          queryType = 'due_diligence';
        }
        // Parliament: "депутат", "законопроєкт", "голосування"
        else if (domains.includes('parliament')) {
          queryType = 'parliament_query';
        }
        // Documents/vault
        else if (hasDocumentsKeyword || domains.includes('documents')) {
          queryType = 'document_query';
        }
        // Comparative analysis: "негаторний чи віндикаційний", "який спосіб захисту"
        else if (/(?:^|\s)чи\s.{0,40}позов|який спосіб захисту|порівн.{0,30}підход|яка стаття підходить/i.test(query)) {
          queryType = 'comparative_analysis';
        }
        // OSINT: IP/domain checks, sanctions, credentials, darknet
        else if (domains.includes('osint')) {
          queryType = 'osint_investigation';
        }
        // Unsupported: non-legal queries
        else if (/(?:погод[аиу]|рецепт|футбол|спорт|кіно|фільм|музик|пісн)/i.test(lowerQuery) && !domains.some((d: string) => d !== 'court')) {
          queryType = 'unsupported';
        }
      }

      // Escalate due_diligence → institutional_analysis for long-period investigations
      // Queries spanning 5+ years, mentioning corruption schemes, or requesting deep investigation
      // of affiliated persons need workflow-based multi-step analysis, not a single agentic loop
      if (queryType === 'due_diligence') {
        const hasLongPeriod = /(?:\d{2,})\s*(?:років|рок|лет|year)|за\s+(?:весь\s+)?(?:час|період|історі)/i.test(query);
        const isDeepInvestigation = /корупц|розслідуван|афілі.{0,30}(?:персон|осіб|чиновник|судд|адвокат|нотаріус)|схем.{0,20}(?:присво|виведен|захоплен)/i.test(query);
        if (hasLongPeriod || isDeepInvestigation) {
          queryType = 'institutional_analysis';
        }
      }

      // Rescue OSINT queries that LLM misclassified as unsupported
      if (queryType === 'unsupported' && domains.includes('osint')) {
        queryType = 'osint_investigation';
      }

      let unsupportedReason = queryType === 'unsupported' && typeof parsed.unsupportedReason === 'string'
        ? parsed.unsupportedReason
        : undefined;

      // Generate unsupportedReason if not provided by LLM
      if (queryType === 'unsupported' && !unsupportedReason) {
        unsupportedReason = 'Цей запит виходить за межі можливостей юридичної системи SecondLayer. Я спеціалізуюся на українському праві: судова практика, законодавство, реєстри, парламентські дані.';
      }

      // Auto-inject 'registry' domain when query mentions companies, owners, beneficiaries
      if (!domains.includes('registry') && /компані|ТОВ |ПАТ |підприємств|власник|бенефіціар|засновник|афілі|ЄДРПОУ|edrpou/i.test(query)) {
        domains.push('registry');
      }

      // Hybrid domain injection: ensure both legislation and court practice
      // tools are available regardless of which queryType was classified.
      // LEXAI-877: short vs long queries on the same topic produced different
      // tool sets (only legislation OR only court practice), leading to
      // inconsistent quality and cost.
      if (queryType === 'practice_analysis' && !domains.includes('legislation')) {
        domains.push('legislation');
      }
      if (queryType === 'legal_consultation' && !domains.includes('court')) {
        domains.push('court');
      }
      if (queryType === 'legal_consultation' && !domains.includes('legislation')) {
        domains.push('legislation');
      }
      if (queryType === 'comparative_analysis' && !domains.includes('legislation')) {
        domains.push('legislation');
      }

      logger.info('[IntentClassifier] LLM intent classification', { domains, keywords, slots, queryType, unsupportedReason });

      return { domains, keywords, slots, queryType, unsupportedReason };
    } catch (err: any) {
      logger.warn('[IntentClassifier] LLM classification failed, falling back to keyword matching', {
        error: err.message,
      });

      // Fallback to keyword-based classification
      const intent = await this.queryPlanner.classifyIntent(query, 'quick');
      const fallbackSlots = (intent.slots as Record<string, any>) || {};

      // Extract case_number from query if QueryPlanner didn't
      if (!fallbackSlots.case_number) {
        const caseMatch = query.match(/\d{1,10}\/\d{1,10}\/\d{2,4}/);
        if (caseMatch) {
          fallbackSlots.case_number = caseMatch[0];
        }
      }

      // Determine queryType from keywords instead of always defaulting to legal_consultation
      let fallbackQueryType: QueryType = 'legal_consultation';
      if (/зміни?.{0,30}(?:закон|норм|стат|редакц|пункт|постанов)|редакці[яї]|історі[яї].{0,20}(?:змін|закон|норм)|еволюці[яї].{0,20}норм/i.test(query)) {
        fallbackQueryType = 'legislation_lookup';
      } else if (/стат(?:т[яі]|ей).{0,20}(?:кодекс|закон|ЦК|ГК|КК|КПК|ЦПК|ГПК|КАС)/i.test(query) || /(?:кодекс|закон).{0,30}стат/i.test(query)) {
        fallbackQueryType = 'legislation_lookup';
      } else if (/практик[аи]|судов[аіі].{0,20}практик|як суди/i.test(query)) {
        fallbackQueryType = 'practice_analysis';
      } else if (/порівня|негаторн|віндикаційн|який спосіб захисту/i.test(query)) {
        fallbackQueryType = 'comparative_analysis';
      } else if (/ЄДРПОУ|edrpou|ТОВ |ПАТ |юридичн.{0,10}особ|компані|підприємств/i.test(query)) {
        fallbackQueryType = 'registry_lookup';
      } else if (/osint|санкці|ofac|інтерпол|interpol|ransomware|darknet|virustotal|abuseipdb|cve\s|витоки.{0,20}(?:дан|credential)/i.test(query) || /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(query)) {
        fallbackQueryType = 'osint_investigation';
        if (!intent.domains.includes('osint')) intent.domains.push('osint');
      } else if (fallbackSlots.case_number) {
        fallbackQueryType = 'case_lookup';
      }

      return {
        domains: intent.domains,
        keywords: query,
        slots: Object.keys(fallbackSlots).length > 0 ? fallbackSlots : undefined,
        queryType: fallbackQueryType,
      };
    }
  }

  /**
   * Filter 45+ tools to a relevant subset based on intent domains.
   *
   * Two-tier selection:
   *   1. Tool Groups (primary) — semantic groups matched by domain
   *   2. Scenario priority (secondary) — preferred scenarios for the queryType
   *   3. DOMAIN_TOOL_MAP (fallback) — if groups don't cover enough
   *
   * Target: 8-15 tools per request.
   */
  async filterTools(domains: string[], slots?: Record<string, any>, queryType?: QueryType): Promise<ToolDefinition[]> {
    const allDefs = await this.toolRegistry.getAllToolDefinitions();
    const allDefsByName = new Map(allDefs.map(d => [d.name, d]));

    // 1. Start with tool groups matched by domains (primary selection)
    const groupToolNames = new Set<string>(resolveToolGroupsByDomains(domains));

    // 2. Add default tools (appear in 2+ scenarios)
    for (const name of DEFAULT_TOOLS) {
      groupToolNames.add(name);
    }

    // 3. Slot-based additions
    if (slots?.edrpou) {
      const registryTools = DOMAIN_TOOL_MAP.registry || [];
      for (const name of registryTools) {
        groupToolNames.add(name);
      }
    }

    // 4. DOMAIN_TOOL_MAP fallback when groups don't cover enough
    if (groupToolNames.size < 5 && domains.length > 0) {
      for (const domain of domains) {
        const mapped = DOMAIN_TOOL_MAP[domain];
        if (mapped) {
          for (const name of mapped) {
            groupToolNames.add(name);
          }
        }
      }
    }

    // 5. Legal advice fallback if still sparse
    if (groupToolNames.size <= DEFAULT_TOOLS.length && domains.length > 0) {
      const fallback = DOMAIN_TOOL_MAP.legal_advice || [];
      for (const name of fallback) {
        groupToolNames.add(name);
      }
    }

    // Build priority set from preferred scenarios for this queryType
    const priorityTools = new Set<string>();
    if (queryType) {
      const config = QUERY_TYPE_CONFIG[queryType];
      if (config?.preferredScenarios?.length) {
        for (const tool of getScenarioPriorityTools(config.preferredScenarios)) {
          priorityTools.add(tool);
          groupToolNames.add(tool);
        }
      }
    }

    // Filter to only tools that actually exist in the registry
    const filtered = allDefs.filter((d) => groupToolNames.has(d.name));

    // Sort: scenario-priority tools first, then the rest
    if (priorityTools.size > 0) {
      const priority = filtered.filter((d) => priorityTools.has(d.name));
      const rest = filtered.filter((d) => !priorityTools.has(d.name));

      const combined = [...priority, ...rest].slice(0, 20);

      combined.push(META_TOOL_DEF);

      return combined;
    }

    const result = filtered.slice(0, 20);
    result.push(META_TOOL_DEF);

    return result;
  }

  /**
   * Expand tool set based on execution plan steps.
   *
   * The plan knows which tools each step needs. For each plan tool,
   * resolve its TOOL_GROUP and add sibling tools the LLM might need
   * (e.g., a step using search_court_decisions → add the whole court_practice group).
   *
   * This fixes rigid gating: classification may have missed a domain,
   * but the plan (generated by a smarter model) correctly identified
   * cross-domain needs.
   */
  async expandToolsFromPlan(
    currentTools: ToolDefinition[],
    plan: ExecutionPlan
  ): Promise<ToolDefinition[]> {
    const planToolNames = plan.steps.map(s => s.tool);
    const siblingTools = resolveToolGroupsByToolNames(planToolNames);

    const currentNames = new Set(currentTools.map(d => d.name));
    const newToolNames = siblingTools.filter(t => !currentNames.has(t));

    if (newToolNames.length === 0) return currentTools;

    const allDefs = await this.toolRegistry.getAllToolDefinitions();
    const allDefsByName = new Map(allDefs.map(d => [d.name, d]));

    const expanded = [...currentTools.filter(d => d.name !== 'request_additional_tools')];
    for (const name of newToolNames) {
      const def = allDefsByName.get(name);
      if (def) expanded.push(def);
    }

    logger.info('[IntentClassifier] Expanded tool set from plan', {
      planTools: planToolNames,
      addedTools: newToolNames.filter(n => allDefsByName.has(n)),
      totalBefore: currentTools.length,
      totalAfter: expanded.length + 1,
    });

    expanded.push(META_TOOL_DEF);
    return expanded.slice(0, 25);
  }
}
