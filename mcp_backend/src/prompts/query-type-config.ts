/**
 * Per-queryType workflow configuration.
 *
 * Controls budget floor, grounding constraints, preferred scenarios,
 * and UI labels for each classified query type.
 */

import type { QueryType } from './chat-system-prompt.js';

export interface QueryTypeConfig {
  /** Minimum budget tier — classifier may upgrade but never downgrade below this.
   *  Governs RESOURCE caps (tool calls, result chars, context window) via
   *  TokenBudgetAllocator. */
  defaultBudget: 'quick' | 'standard' | 'deep';
  /** Optional override for the MODEL tier only, decoupled from defaultBudget's
   *  resource caps. Lets a queryType use big (deep) caps with a cheaper model.
   *  Defaults to the effective resource budget when unset. */
  modelBudget?: 'quick' | 'standard' | 'deep';
  /** Whether the LLM answer MUST reference tool results (no "from memory" answers) */
  requiresGrounding: boolean;
  /** Scenario IDs from catalog to prioritize in the system prompt */
  preferredScenarios: string[];
  /** Ukrainian instruction appended to system prompt constraining what the LLM can say */
  groundingNote: string;
  /** UI-facing label (Ukrainian) — displayed as "thinking" step 0 */
  thinkingPrefix: string;
}

export const QUERY_TYPE_CONFIG: Record<QueryType, QueryTypeConfig> = {
  case_lookup: {
    defaultBudget: 'standard',
    requiresGrounding: true,
    preferredScenarios: ['specific_case_lookup', 'case_chain_analysis', 'comprehensive_case_analysis', 'edrsr_case_search'],
    groundingNote: 'Відповідь МУСИТЬ містити дані з результатів інструментів (номер справи, суд, дата, резолютивна частина). Не вигадуй деталі справи.',
    thinkingPrefix: 'Шукаю справу в реєстрі',
  },

  practice_analysis: {
    // deep (not standard): practice analysis must load FULL texts of several key
    // decisions to be reliable. standard caps at maxToolCalls=10 / maxResultChars=8000,
    // which both exhausts the call budget before texts are fetched AND truncates the
    // full decisions that do load (court rulings run 20-40K chars). deep raises these
    // to 25 calls / 40K chars / 100K context. Acts as a budget floor (a cap, not a
    // forced spend) — simple queries still finish early. Mirrors institutional_analysis.
    defaultBudget: 'deep',
    // ...but run the cheaper Sonnet model, not Opus. A/B on prod (2026-06-21, LEXAI)
    // with EDRSR ground-truth grounding showed Sonnet grounds as well or better than
    // Opus on practice_analysis (0.67 vs 0.58) at ~10% the cost. We keep deep's big
    // caps (so full texts load) but decouple the model tier.
    modelBudget: 'standard',
    requiresGrounding: true,
    preferredScenarios: ['court_practice_search', 'practice_pro_contra', 'supreme_court_practice', 'similar_fact_pattern', 'legislation_search', 'relevant_articles_by_situation'],
    groundingNote: 'СПОЧАТКУ знайди правові норми через find_relevant_law_articles або search_legislation — без конкретних статей закону аналіз практики неповний. ПОТІМ шукай судову практику через search_court_decisions (mode=fulltext). Для ключових справ перевір ланцюжок інстанцій через get_case_documents_chain — чи рішення діє, чи скасовано. Кожне твердження про позицію суду підкріплюй номером справи з результатів пошуку. Вкажи обмеження застосовності: коли норма/практика НЕ діє, які виключення існують.',
    thinkingPrefix: 'Аналізую судову практику',
  },

  legislation_lookup: {
    defaultBudget: 'quick',
    requiresGrounding: true,
    preferredScenarios: ['legislation_article_lookup', 'legislation_section_lookup', 'legislation_search'],
    groundingNote: 'Відповідь МУСИТЬ містити точний текст статті з результатів інструменту. Не цитуй закони з пам\'яті.',
    thinkingPrefix: 'Шукаю норму закону',
  },

  legal_consultation: {
    defaultBudget: 'standard',
    requiresGrounding: true,
    preferredScenarios: ['relevant_articles_by_situation', 'legislation_search', 'comprehensive_legal_advice', 'court_practice_search', 'edrsr_case_search', 'case_chain_analysis'],
    groundingNote: 'СПОЧАТКУ знайди відповідний закон через find_relevant_law_articles або search_legislation. НІКОЛИ не викликай get_legislation_article без відомого rada_id — спочатку визнач закон. ПОТІМ знайди судову практику через search_court_decisions (mode=fulltext). Для ключових знайдених справ перевір ланцюжок інстанцій через get_case_documents_chain — чи рішення діє, чи скасовано вищою інстанцією. Відповідь має містити: конкретні статті законів, судову практику з номерами справ, та обмеження застосовності (коли норма/практика НЕ діє). Загальні поради без правового обґрунтування неприпустимі.',
    thinkingPrefix: 'Готую юридичну консультацію',
  },

  registry_lookup: {
    defaultBudget: 'quick',
    requiresGrounding: true,
    preferredScenarios: ['entity_lookup_edrpou', 'entity_search_name', 'beneficiary_search', 'debtor_search'],
    groundingNote: 'Відповідь МУСИТЬ містити ТІЛЬКИ дані з реєстру. Якщо реєстр не повернув інформацію — повідом що не знайдено. Не вигадуй реєстраційні дані.',
    thinkingPrefix: 'Перевіряю реєстри',
  },

  parliament_query: {
    defaultBudget: 'quick',
    requiresGrounding: true,
    preferredScenarios: ['deputy_info', 'parliament_bills_search', 'voting_record_analysis', 'legislation_text_search'],
    groundingNote: 'Відповідь МУСИТЬ базуватися на даних з API Ради. Не вигадуй інформацію про депутатів або законопроєкти.',
    thinkingPrefix: 'Шукаю парламентські дані',
  },

  document_query: {
    defaultBudget: 'quick',
    requiresGrounding: true,
    preferredScenarios: ['document_semantic_search', 'document_list'],
    groundingNote: 'Відповідь МУСИТЬ базуватися на знайдених документах користувача. Якщо документи не знайдено — повідом про це.',
    thinkingPrefix: 'Шукаю у ваших документах',
  },

  calculation: {
    defaultBudget: 'standard',
    requiresGrounding: true,
    preferredScenarios: ['procedural_norms_search', 'legislation_article_lookup'],
    groundingNote: 'Розрахунок МУСИТЬ базуватися на конкретних нормах закону. Спочатку знайди відповідну норму, потім застосуй формулу. Покажи хід розрахунку.',
    thinkingPrefix: 'Розраховую на основі норм',
  },

  document_drafting: {
    defaultBudget: 'standard',
    requiresGrounding: true,
    preferredScenarios: ['legal_document_drafting', 'relevant_articles_by_situation'],
    groundingNote: 'Документ МУСИТЬ містити правове обґрунтування з конкретними статтями закону, отриманими з інструментів. Формат — блок ```document.',
    thinkingPrefix: 'Складаю юридичний документ',
  },

  comparative_analysis: {
    defaultBudget: 'standard',
    requiresGrounding: true,
    preferredScenarios: ['practice_pro_contra', 'court_practice_search', 'comprehensive_legal_advice'],
    groundingNote: 'Порівняння МУСИТЬ базуватися на конкретних справах з результатів пошуку. Кожен підхід підкріплюй номерами справ. Обов\'язково побудуй порівняльну таблицю. Завершуй аналіз викликом build_legal_decision для структурованого рішення з оцінкою позицій та картою ризиків.',
    thinkingPrefix: 'Порівнюю правові підходи',
  },

  due_diligence: {
    defaultBudget: 'standard',
    requiresGrounding: true,
    preferredScenarios: ['due_diligence_check', 'entity_lookup_edrpou', 'debtor_search', 'bankruptcy_search', 'osint_entity_screening', 'osint_cyber_check'],
    groundingNote: 'Перевірка МУСИТЬ базуватися ТІЛЬКИ на даних з реєстрів, судових справ та OSINT-джерел. Ризик-оцінка має посилатися на конкретні знайдені факти.',
    thinkingPrefix: 'Перевіряю контрагента',
  },

  institutional_analysis: {
    defaultBudget: 'deep',
    requiresGrounding: true,
    preferredScenarios: ['edrsr_judge_analysis', 'edrsr_case_search', 'court_practice_search', 'practice_pro_contra', 'supreme_court_practice', 'due_diligence_check', 'entity_search_name', 'beneficiary_search'],
    groundingNote: 'Запит потребує глибокого інституційного аналізу. Система згенерує набір робочих процесів (workflows) для поетапного виконання.',
    thinkingPrefix: 'Генерую план глибокого аналізу',
  },

  osint_investigation: {
    defaultBudget: 'standard',
    requiresGrounding: true,
    preferredScenarios: ['osint_entity_screening', 'osint_cyber_check', 'osint_darknet_intel'],
    groundingNote: 'Відповідь МУСИТЬ базуватися ТІЛЬКИ на даних з OSINT-джерел (санкційні бази, AbuseIPDB, VirusTotal, NVD, ICIJ тощо). Ніколи не вигадуй результати перевірок.',
    thinkingPrefix: 'Перевіряю через OSINT-джерела',
  },

  unsupported: {
    defaultBudget: 'quick',
    requiresGrounding: false,
    preferredScenarios: [],
    groundingNote: '',
    thinkingPrefix: '',
  },
};
