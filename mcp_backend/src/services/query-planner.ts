import { QueryIntent, SectionType } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { queryIr } from '@secondlayer/shared';
import type { ILLMPort } from '../domain/ports/index.js';

export class QueryPlanner {
  private intentMapping: Map<string, string[]> = new Map();

  constructor(private readonly llm?: ILLMPort) {

    // Initialize intent to endpoint mapping
    this.intentMapping.set('consumer_penalty_delay', ['court', 'npa']);
    this.intentMapping.set('tax_dispute', ['court', 'npa']);
    this.intentMapping.set('labor_dispute', ['court', 'echr']);
    this.intentMapping.set('property_dispute', ['court']);
    this.intentMapping.set('general_search', ['court', 'npa', 'echr']);

    // Task-based intents for court/procedure use cases
    this.intentMapping.set('supreme_court_position', ['court']);
    this.intentMapping.set('procedural_deadlines', ['court', 'npa']);
    this.intentMapping.set('admissibility_and_formal_requirements', ['court', 'npa']);
    this.intentMapping.set('jurisdiction_and_competence', ['court', 'npa']);
    this.intentMapping.set('evidence_and_standards', ['court', 'npa']);
    this.intentMapping.set('interim_measures', ['court', 'npa']);
    this.intentMapping.set('amounts_and_costs', ['court', 'npa']);
    this.intentMapping.set('two_sided_practice', ['court']);
  }

  async classifyIntent(query: string, budget: 'quick' | 'standard' | 'deep' = 'standard'): Promise<QueryIntent> {
    // For quick budget, use simple keyword matching
    if (budget === 'quick') {
      return this.sanitizeIntent(this.quickIntentClassification(query));
    }

    // For standard/deep, use LLM
    if (!this.llm) {
      return this.sanitizeIntent(this.quickIntentClassification(query));
    }

    try {
      const response = await this.llm.chatCompletion(
        {
          messages: [
            {
              role: 'system',
              content: `Ти експерт з класифікації юридичних запитів. Проаналізуй запит та визнач:
1. Intent (наприклад: consumer_penalty_delay, tax_dispute, labor_dispute)
2. Домени (court, npa, echr)
3. Необхідні сутності (law_article, seller, consumer, etc.)
4. Типи секцій (FACTS, CLAIMS, COURT_REASONING, DECISION, LAW_REFERENCES, AMOUNTS)
5. Часовий діапазон (якщо вказано)

Додатково (якщо можливо витягнути з тексту):
6. Task-based intent для судів/процесу: supreme_court_position | procedural_deadlines | admissibility_and_formal_requirements | jurisdiction_and_competence | evidence_and_standards | interim_measures | amounts_and_costs | two_sided_practice
7. Слоти (optional):
   - procedure_code: ЦПК|ГПК|КАС|КПК
   - court_level: first_instance|appeal|cassation|SC|GrandChamber
   - case_category (строка)
   - law_article (строка)
   - section_focus (масив секцій)
   - money_terms: {penalty,inflation,three_percent,legal_fees}
   - desired_output: теза|чеклист|таблиця|підбірка|порівняння

Поверни ТІЛЬКИ валідний JSON без додаткового тексту з полями: intent, confidence, domains, required_entities, sections, time_range (опціонально), reasoning_budget, slots (опціонально).`,
            },
            {
              role: 'user',
              content: query,
            },
          ],
          temperature: 0.3,
          max_tokens: 4096,
          response_format: { type: 'json_object' },
        },
        budget
      );

      let content = response.content || '{}';
      
      // Extract JSON from markdown code blocks if present
      const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
      if (jsonMatch) {
        content = jsonMatch[1];
      }
      
      // Try to extract JSON object from text
      const jsonObjectMatch = content.match(/\{[\s\S]*\}/);
      if (jsonObjectMatch) {
        content = jsonObjectMatch[0];
      }
      
      const result = JSON.parse(content);
      
      return this.sanitizeIntent({
        intent: result.intent || 'general_search',
        confidence: result.confidence || 0.7,
        domains: result.domains || ['court'],
        required_entities: result.required_entities || [],
        sections: (result.sections || ['COURT_REASONING', 'DECISION']).map((s: string) => s as SectionType),
        time_range: result.time_range,
        reasoning_budget: budget,
        slots: result.slots,
      });
    } catch (error) {
      logger.error('Intent classification error:', error);
      return this.sanitizeIntent(this.quickIntentClassification(query));
    }
  }

  private sanitizeIntent(intent: QueryIntent): QueryIntent {
    const allowedSectionTypes = new Set(Object.values(SectionType));

    const normalizeSectionType = (value: unknown): SectionType | undefined => {
      if (typeof value !== 'string') return undefined;
      const raw = value.trim();
      if (!raw) return undefined;
      if (allowedSectionTypes.has(raw as SectionType)) return raw as SectionType;
      const upper = raw.toUpperCase();
      if (allowedSectionTypes.has(upper as SectionType)) return upper as SectionType;
      return undefined;
    };

    const normalizeCourtLevel = (value: unknown): string | undefined => {
      if (typeof value !== 'string') return undefined;
      const v = value.trim();
      if (!v) return undefined;
      const lower = v.toLowerCase();

      if (
        lower === 'grandchamber' ||
        lower === 'grand_chamber' ||
        lower === 'grand chamber' ||
        lower.includes('велика палата') ||
        lower.includes('вп вс') ||
        lower === 'вп'
      ) {
        return 'GrandChamber';
      }

      if (
        lower === 'sc' ||
        lower.includes('supreme') ||
        lower.includes('верхов') ||
        lower === 'вс' ||
        lower.includes('кцс') ||
        lower.includes('кгс') ||
        lower.includes('кас') ||
        lower.includes('ккс')
      ) {
        return 'SC';
      }

      if (lower === 'cassation' || lower.includes('касац')) return 'cassation';
      if (lower === 'appeal' || lower.includes('апеляц')) return 'appeal';
      if (lower === 'first_instance' || lower.includes('перша інстанц') || lower.includes('первая инстанц')) {
        return 'first_instance';
      }

      if (
        lower === 'first_instance' ||
        lower === 'appeal' ||
        lower === 'cassation' ||
        lower === 'sc' ||
        lower === 'grandchamber'
      ) {
        return value;
      }

      return undefined;
    };

    const sanitizedSections = Array.isArray(intent.sections)
      ? intent.sections.map((s) => normalizeSectionType(s)).filter(Boolean)
      : [];

    const sections = (sanitizedSections.length > 0
      ? (sanitizedSections as SectionType[])
      : [SectionType.COURT_REASONING, SectionType.DECISION]) as SectionType[];

    const slotsRaw: any = intent.slots && typeof intent.slots === 'object' ? { ...(intent.slots as any) } : undefined;
    if (slotsRaw) {
      if (Array.isArray(slotsRaw.section_focus)) {
        const focus = slotsRaw.section_focus
          .map((s: any) => normalizeSectionType(s))
          .filter(Boolean) as SectionType[];
        if (focus.length > 0) {
          slotsRaw.section_focus = focus;
        } else {
          delete slotsRaw.section_focus;
        }
      }

      if (slotsRaw.court_level !== undefined) {
        const normalized = normalizeCourtLevel(slotsRaw.court_level);
        if (normalized) {
          slotsRaw.court_level = normalized;
        } else {
          delete slotsRaw.court_level;
        }
      }

      if (Object.keys(slotsRaw).length === 0) {
        return {
          ...intent,
          sections,
          slots: undefined,
        };
      }
    }

    // Canonical validation guard (CORE-50): run AFTER the alias-normalization
    // above so canonical values reach the shared strictObject. On success we
    // adopt the validated bag (unknown LLM-invented slots dropped = injection
    // guard); on failure we keep the normalized slots and just log — strictly
    // non-regressive vs. the previous behavior.
    const validatedSlots = (() => {
      if (!slotsRaw) return slotsRaw;
      const parsed = queryIr.parsePlannerSlots(slotsRaw);
      if (parsed.ok) return parsed.value;
      const issues = 'issues' in parsed ? parsed.issues : [];
      logger.warn('Planner slots failed canonical (PlannerSlots) validation; keeping normalized slots', {
        issues,
      });
      return slotsRaw;
    })();

    return {
      ...intent,
      sections,
      slots: validatedSlots,
    };
  }

  private quickIntentClassification(query: string): QueryIntent {
    const lowerQuery = query.toLowerCase();
    
    let intent = 'general_search';
    const domains: string[] = [];
    let sections: SectionType[] = [SectionType.COURT_REASONING, SectionType.DECISION];
    const slots: any = {};

    // Slots: procedure_code
    if (lowerQuery.includes('цпк')) slots.procedure_code = 'ЦПК';
    if (lowerQuery.includes('гпк')) slots.procedure_code = 'ГПК';
    if (lowerQuery.includes('кас')) slots.procedure_code = 'КАС';
    if (lowerQuery.includes('кпк')) slots.procedure_code = 'КПК';

    if (
      lowerQuery.includes('велика палата') ||
      lowerQuery.includes('вп вс') ||
      lowerQuery.includes('вп')
    ) {
      slots.court_level = 'GrandChamber';
    } else if (
      lowerQuery.includes('верховн') ||
      lowerQuery.includes('вс ') ||
      lowerQuery.includes(' кцс') ||
      lowerQuery.includes(' кгс') ||
      lowerQuery.includes(' ккc') ||
      lowerQuery.includes(' ккс')
    ) {
      slots.court_level = 'SC';
    } else if (lowerQuery.includes('касац')) {
      slots.court_level = 'cassation';
    } else if (lowerQuery.includes('апеляц')) {
      slots.court_level = 'appeal';
    } else if (lowerQuery.includes('перша інстанц') || lowerQuery.includes('первая инстанц')) {
      slots.court_level = 'first_instance';
    }

    // Slots: desired_output
    if (lowerQuery.includes('чеклист')) slots.desired_output = 'чеклист';
    if (lowerQuery.includes('таблиц')) slots.desired_output = 'таблиця';
    if (lowerQuery.includes('порівня')) slots.desired_output = 'порівняння';
    if (lowerQuery.includes('підбірк') || lowerQuery.includes('підбірка')) slots.desired_output = 'підбірка';

    // Slots: money_terms
    if (lowerQuery.includes('пеня') || lowerQuery.includes('штраф')) {
      slots.money_terms = { ...(slots.money_terms || {}), penalty: true };
    }
    if (lowerQuery.includes('інфляц')) {
      slots.money_terms = { ...(slots.money_terms || {}), inflation: true };
    }
    if (lowerQuery.includes('3%') || lowerQuery.includes('три відсотк') || lowerQuery.includes('три проц')) {
      slots.money_terms = { ...(slots.money_terms || {}), three_percent: true };
    }
    if (lowerQuery.includes('судов') && lowerQuery.includes('витрат')) {
      slots.money_terms = { ...(slots.money_terms || {}), legal_fees: true };
    }

    // Task-based intent hints (courts/procedure)
    if (
      lowerQuery.includes('позиці') ||
      lowerQuery.includes('позиция') ||
      lowerQuery.includes('правов') ||
      lowerQuery.includes('правовой') ||
      (lowerQuery.includes('вс') && lowerQuery.includes('виснов')) ||
      lowerQuery.includes('верховн')
    ) {
      intent = 'supreme_court_position';
      domains.push('court');
      sections = [SectionType.COURT_REASONING];
    } else if (
      lowerQuery.includes('строк') ||
      lowerQuery.includes('поновлен') ||
      lowerQuery.includes('пропуск')
    ) {
      intent = 'procedural_deadlines';
      domains.push('court', 'npa');
      sections = [SectionType.COURT_REASONING, SectionType.DECISION, SectionType.LAW_REFERENCES];
    } else if (
      lowerQuery.includes('без рух') ||
      lowerQuery.includes('повернен') ||
      lowerQuery.includes('без розгляд') ||
      lowerQuery.includes('закритт')
    ) {
      intent = 'admissibility_and_formal_requirements';
      domains.push('court', 'npa');
      sections = [SectionType.COURT_REASONING, SectionType.DECISION, SectionType.LAW_REFERENCES];
    } else if (
      lowerQuery.includes('підсудн') ||
      lowerQuery.includes('юрисдикц') ||
      lowerQuery.includes('підвідомч')
    ) {
      intent = 'jurisdiction_and_competence';
      domains.push('court', 'npa');
      sections = [SectionType.COURT_REASONING, SectionType.LAW_REFERENCES];
    } else if (
      lowerQuery.includes('доказ') ||
      lowerQuery.includes('належн') ||
      lowerQuery.includes('допустим') ||
      lowerQuery.includes('тягар доказ') ||
      lowerQuery.includes('експертиз') ||
      lowerQuery.includes('електронн')
    ) {
      intent = 'evidence_and_standards';
      domains.push('court', 'npa');
      sections = [SectionType.FACTS, SectionType.COURT_REASONING];
    } else if (
      lowerQuery.includes('забезпечен') && (lowerQuery.includes('позов') || lowerQuery.includes('доказ'))
    ) {
      intent = 'interim_measures';
      domains.push('court', 'npa');
      sections = [SectionType.COURT_REASONING, SectionType.LAW_REFERENCES];
    } else if (
      lowerQuery.includes('пеня') ||
      lowerQuery.includes('інфляц') ||
      lowerQuery.includes('3%') ||
      (lowerQuery.includes('судов') && lowerQuery.includes('витрат'))
    ) {
      intent = 'amounts_and_costs';
      domains.push('court', 'npa');
      sections = [SectionType.AMOUNTS, SectionType.COURT_REASONING];
    } else if (
      lowerQuery.includes('за/проти') ||
      lowerQuery.includes('дві ліні') ||
      lowerQuery.includes('две лини') ||
      lowerQuery.includes('неоднорід')
    ) {
      intent = 'two_sided_practice';
      domains.push('court');
      sections = [SectionType.COURT_REASONING, SectionType.DECISION];
    } else if (
      lowerQuery.includes('депутат') ||
      lowerQuery.includes('народн') ||
      lowerQuery.includes('парламент') ||
      lowerQuery.includes('верховна рада') ||
      lowerQuery.includes('верховної ради') ||
      lowerQuery.includes('верховну раду') ||
      lowerQuery.includes('верховная рада') ||
      lowerQuery.includes('голосуванн') ||
      lowerQuery.includes('голосован') ||
      lowerQuery.includes('законопроект') ||
      lowerQuery.includes('законопроєкт') ||
      lowerQuery.includes('фракці') ||
      lowerQuery.includes('фракци') ||
      lowerQuery.includes('комітет') ||
      lowerQuery.includes('комитет')
    ) {
      intent = 'parliament_search';
      domains.push('parliament');
    } else if (
      lowerQuery.includes('єдрпоу') ||
      lowerQuery.includes('едрпоу') ||
      lowerQuery.includes('эдрпоу') ||
      lowerQuery.includes('бенефіціар') ||
      lowerQuery.includes('бенефициар') ||
      lowerQuery.includes('реєстр підприємств') ||
      lowerQuery.includes('реестр предприятий') ||
      (lowerQuery.includes('юридичн') && lowerQuery.includes('особ')) ||
      (lowerQuery.includes('юридическ') && lowerQuery.includes('лиц')) ||
      lowerQuery.includes('підприємств') ||
      lowerQuery.includes('предприяти') ||
      lowerQuery.includes('засновник') ||
      lowerQuery.includes('учредител') ||
      lowerQuery.includes('боржник') ||
      lowerQuery.includes('должник')
    ) {
      intent = 'registry_search';
      domains.push('registry');
    } else if (lowerQuery.includes('споживач') || lowerQuery.includes('затримка') || lowerQuery.includes('доставка')) {
      intent = 'consumer_penalty_delay';
      domains.push('court', 'npa');
    } else if (lowerQuery.includes('податк') || lowerQuery.includes('налог')) {
      intent = 'tax_dispute';
      domains.push('court', 'npa');
    } else if (lowerQuery.includes('прац') || lowerQuery.includes('трудов')) {
      intent = 'labor_dispute';
      domains.push('court', 'echr');
    } else {
      domains.push('court');
    }

    return {
      intent,
      confidence: 0.6,
      domains: domains.length > 0 ? domains : ['court'],
      required_entities: [],
      sections,
      reasoning_budget: 'quick',
      slots: Object.keys(slots).length > 0 ? slots : undefined,
    };
  }

  async generateOptimizedSearchQuery(userQuery: string, _intent: QueryIntent, budget: 'quick' | 'standard' | 'deep' = 'standard'): Promise<string> {
    // For quick budget, use simple keyword extraction
    if (budget === 'quick') {
      return userQuery;
    }

    if (!this.llm) {
      return userQuery;
    }

    try {
      const response = await this.llm.chatCompletion(
        {
          messages: [
            {
              role: 'system',
              content: `Ти експерт з оптимізації пошукових запитів для API ZakonOnline (повнотекстовий пошук Sphinx sph04).

ЗАВДАННЯ: Перетвори питання користувача в пошуковий запит у форматі Sphinx OR-фраз.

ПРАВИЛА ФОРМАТУВАННЯ:
- Витягни 2-3 ключові юридичні ФРАЗИ (2-4 слова кожна)
- Кожну фразу обгорни в подвійні лапки: "фраза тут"
- З'єднай фрази оператором | (OR): "фраза1" | "фраза2" | "фраза3"
- Sphinx sph04 з'єднує слова в лапках як PHRASE (точний порядок)
- OR між фразами дає більше результатів, ніж AND окремих слів
- НЕ додавай назви судів (Верховний Суд) — це додається окремо фільтром
- Використовуй форми слів, характерні для текстів судових рішень

ПРИКЛАДИ:
Вхід: "Яка позиція Верховного Суду щодо поновлення строку на апеляційне оскарження у разі несвоєчасного отримання повного тексту рішення?"
Вихід: "поновлення строку" | "апеляційне оскарження" | "несвоєчасне отримання рішення"

Вхід: "Чи можна стягнути 3% річних та інфляційні втрати одночасно?"
Вихід: "3% річних" | "інфляційні втрати" | "одночасне стягнення"

Вхід: "Які підстави для залишення позову без руху згідно ЦПК?"
Вихід: "залишення позову без руху" | "підстави ЦПК"

Вхід: "звільнення самовільно захопленої частини земельної ділянки вивезення майна відповідача межі за експертизою"
Вихід: "самовільне захоплення земельної ділянки" | "вивезення майна" | "межі ділянки експертиза"

Поверни JSON: {"search_query": "оптимізований запит"}`,
            },
            {
              role: 'user',
              content: userQuery,
            },
          ],
          temperature: 0.2,
          max_tokens: 100,
          response_format: { type: 'json_object' },
        },
        budget
      );

      let content = response.content || userQuery;
      
      // Strip markdown code block wrappers before JSON parse
      content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/g, '').trim();

      // If JSON mode, extract search_query field
      if (content.includes('{')) {
        try {
          const parsed = JSON.parse(content);
          if (parsed.search_query) {
            content = parsed.search_query;
          }
        } catch {
          // Not valid JSON — try to extract "search_query": "value" with regex
          const match = content.match(/["']?search_query["']?\s*:\s*"([^"]+)"/i);
          if (match) {
            content = match[1];
          }
        }
      }
      
      // Clean up the response — only strip outer quotes when the ENTIRE content is a single
      // quoted string (e.g., `"query"` → `query`).  Do NOT strip if content starts with `"`
      // as part of a Sphinx multi-phrase OR query (e.g. `"фраза1" | "фраза2" | "фраза3"`),
      // otherwise the leading `"` of the first phrase is silently removed and Sphinx returns 0.
      content = content.trim();
      const isSingleQuotedString =
        (content.startsWith('"') && content.endsWith('"') && content.indexOf('"', 1) === content.length - 1) ||
        (content.startsWith("'") && content.endsWith("'") && content.indexOf("'", 1) === content.length - 1);
      if (isSingleQuotedString) {
        content = content.slice(1, -1);
      }

      // Convert AND-format phrases to OR: `"A" "B" "C"` → `"A" | "B" | "C"`.
      // Sphinx sph04 treats adjacent quoted phrases as AND (all must be present),
      // which returns very few results. OR gives many more matches.
      // Only fires when the ENTIRE query is quoted phrases with no | already.
      if (/^"[^"]+"(\s+"[^"]+")+$/.test(content)) {
        content = content.replace(/"\s+"/g, '" | "');
        logger.info('Converted AND-phrases to OR for broader Sphinx match', { converted: content });
      }

      logger.info('Generated optimized search query', {
        original: userQuery,
        optimized: content,
      });
      
      return content;
    } catch (error) {
      logger.error('Failed to generate optimized search query:', error);
      return userQuery; // Fallback to original
    }
  }

  buildQueryParams(intent: QueryIntent, searchQuery?: string): any {
    const where: any[] = [];
    const meta: any = {};

    // Always use text search - API handles case numbers well in full-text mode
    if (searchQuery) {
      meta.search = searchQuery;
    }

    // Add domain-specific filters
    if (intent.domains.includes('court')) {
      // Court-specific filters can be added here if needed
      // Note: API doesn't require type filter for court decisions endpoint
    }

    // Add time range if specified
    if (intent.time_range) {
      where.push({
        field: 'date_publ',
        operator: '$gte',
        value: intent.time_range.from,
      });
      where.push({
        field: 'date_publ',
        operator: '$lte',
        value: intent.time_range.to,
      });
    }

    // Add required entities as search terms
    if (intent.required_entities.length > 0) {
      meta.search_entities = intent.required_entities;
    }

    // Default order by publication date descending
    meta.order = { date_publ: 'desc' };

    return {
      where,
      meta,
      limit: 50,
      offset: 0,
    };
  }

  selectEndpoints(intent: QueryIntent): string[] {
    const mapped = this.intentMapping.get(intent.intent);
    if (mapped && mapped.length > 0) {
      return mapped;
    }

    const endpoints: string[] = [];

    if (intent.domains.includes('court')) {
      endpoints.push('court');
    }
    if (intent.domains.includes('npa')) {
      endpoints.push('npa');
    }
    if (intent.domains.includes('echr')) {
      endpoints.push('echr');
    }

    return endpoints.length > 0 ? endpoints : ['court'];
  }
}
