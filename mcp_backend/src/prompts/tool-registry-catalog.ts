/**
 * Scenario Catalog for the LLM chat pipeline.
 *
 * Each entry maps: query type → data sources → tool chain → response template.
 * ChatService injects the relevant subset into the system prompt so the LLM
 * follows a structured answer format for every scenario.
 */

// ============================
// Types
// ============================

export interface ScenarioDataSource {
  name: string;     // "ZakonOnline", "Rada API", "OpenReyestr", "Qdrant", "PostgreSQL"
  provides: string; // What it provides for this scenario
}

export interface ScenarioToolStep {
  tool: string;      // MCP tool name
  purpose: string;   // Why call it (Ukrainian)
  optional?: boolean;
}

export interface ResponseSection {
  heading: string;     // Section heading (Ukrainian)
  instruction: string; // What to write
  optional?: boolean;
}

export interface ScenarioCatalogEntry {
  id: string;
  label: string;                     // Name (Ukrainian)
  domains: string[];                 // Trigger domains
  triggerSlots?: string[];           // Slots that refine selection
  exampleQueries: string[];          // Example queries (Ukrainian)
  dataSources: ScenarioDataSource[];
  toolChain: ScenarioToolStep[];
  responseTemplate: ResponseSection[];
}

// ============================
// Catalog (~29 scenarios)
// ============================

export const SCENARIO_CATALOG: ScenarioCatalogEntry[] = [

  // ─────────────── Court (7) ───────────────

  {
    id: 'court_practice_search',
    label: 'Тематичний пошук судової практики',
    domains: ['court', 'legal_advice'],
    exampleQueries: [
      'Яка практика щодо виселення з іпотечного майна?',
      'Судова практика стягнення аліментів на дитину',
      'Проаналізувати практику щодо самовільного захоплення земельних ділянок',
    ],
    dataSources: [
      { name: 'ZakonOnline', provides: 'судові рішення за темою' },
      { name: 'Qdrant', provides: 'векторний пошук по збережених рішеннях' },
    ],
    toolChain: [
      { tool: 'find_relevant_law_articles', purpose: 'знайти правові норми що регулюють питання — без законодавчої бази аналіз практики неповний' },
      {
        tool: 'search_court_decisions',
        purpose: 'тематичний пошук рішень усіх інстанцій — ЗАВЖДИ використовуй limit=25-30. Якщо запит містить кілька аспектів — окремий виклик для кожного аспекту. ОБОВ\'ЯЗКОВИЙ fallback якщо інші інструменти пошуку практики повернули 0.',
      },
      { tool: 'get_case_documents_chain', purpose: 'перевірка ключових рішень через інстанції — чи діє, чи скасовано' },
      { tool: 'search_supreme_court_practice', purpose: 'практика Верховного Суду з цього питання', optional: true },
      { tool: 'get_court_decision', purpose: 'повний текст ключового рішення для детального аналізу', optional: true },
    ],
    responseTemplate: [
      { heading: 'Правова норма', instruction: 'відповідні статті законів з результатів пошуку' },
      { heading: 'Позиція суду', instruction: 'конкретні рішення з номерами справ — вказуй номер справи, суд, рік, суть позиції' },
      { heading: 'Перевірка через інстанції', instruction: 'для ключових справ — чи рішення діє, чи скасовано/змінено вищою інстанцією' },
      { heading: 'Кількість знайдених справ', instruction: 'скільки справ знайдено по кожному аспекту запиту' },
      { heading: 'Висновок', instruction: 'узагальнення практики — яка позиція переважає' },
      { heading: 'Обмеження застосовності', instruction: 'коли норма/практика НЕ діє, які виключення' },
      { heading: 'Джерела', instruction: 'номери справ, статті законів' },
    ],
  },

  {
    id: 'supreme_court_practice',
    label: 'Практика Верховного Суду',
    domains: ['court'],
    triggerSlots: ['procedure_code'],
    exampleQueries: [
      'Позиція ВС щодо строків позовної давності у господарських справах',
      'Практика Великої Палати ВС щодо земельних спорів',
    ],
    dataSources: [
      { name: 'ZakonOnline', provides: 'рішення Верховного Суду' },
    ],
    toolChain: [
      { tool: 'search_supreme_court_practice', purpose: 'пошук практики ВС за процесуальним кодексом' },
      { tool: 'get_court_decision', purpose: 'повний текст постанови ВС', optional: true },
    ],
    responseTemplate: [
      { heading: 'Позиція ВС', instruction: 'ключові правові висновки Верховного Суду' },
      { heading: 'Ключові тези', instruction: 'цитати з мотивувальної частини' },
      { heading: 'Висновок', instruction: 'узагальнення для практичного застосування' },
      { heading: 'Джерела', instruction: 'номери справ, дати постанов' },
    ],
  },

  {
    id: 'specific_case_lookup',
    label: 'Пошук конкретної справи за номером',
    domains: ['court'],
    triggerSlots: ['case_number'],
    exampleQueries: [
      'Покажи рішення у справі 922/989/18',
      'Що вирішив суд у справі 757/1234/22-ц?',
    ],
    dataSources: [
      { name: 'ZakonOnline', provides: 'текст судового рішення' },
    ],
    toolChain: [
      { tool: 'get_court_decision', purpose: 'отримати рішення за номером справи' },
      { tool: 'get_citation_graph', purpose: 'граф цитувань рішення (decision→article): на які норми/статті спирається. case_id = номер справи або doc_id. Покриття часткове — порожній граф означає брак даних графа, а не відсутність цитувань', optional: true },
    ],
    responseTemplate: [
      { heading: 'Суд / дата', instruction: 'назва суду, дата рішення, форма судочинства' },
      { heading: 'Обставини', instruction: 'короткий виклад фактів справи' },
      { heading: 'Рішення', instruction: 'резолютивна частина' },
      { heading: 'Мотивувальна частина', instruction: 'ключові аргументи суду' },
      { heading: 'Резолютивна частина', instruction: 'що саме вирішив суд' },
    ],
  },

  {
    id: 'case_chain_analysis',
    label: 'Історія справи через інстанції',
    domains: ['court'],
    triggerSlots: ['case_number'],
    exampleQueries: [
      'Покажи всю історію справи 910/12345/20 через усі інстанції',
      'Як змінювались рішення у справі 756/111/21?',
    ],
    dataSources: [
      { name: 'ZakonOnline', provides: 'рішення всіх інстанцій у справі' },
    ],
    toolChain: [
      { tool: 'get_case_documents_chain', purpose: 'отримати ланцюг рішень через інстанції' },
      { tool: 'get_citation_graph', purpose: 'граф цитувань рішення (decision→article): на які норми/статті спирається. case_id = номер справи або doc_id. Покриття часткове — порожній граф означає брак даних графа, а не відсутність цитувань', optional: true },
    ],
    responseTemplate: [
      { heading: 'Хронологія інстанцій', instruction: 'послідовність рішень з датами' },
      { heading: 'Ключові зміни', instruction: 'що змінювалось між інстанціями' },
      { heading: 'Поточний статус', instruction: 'остаточне рішення або стадія розгляду' },
    ],
  },

  {
    id: 'precedent_verification',
    label: 'Перевірка актуальності рішення',
    domains: ['court'],
    triggerSlots: ['case_number'],
    exampleQueries: [
      'Чи актуальне рішення у справі 922/989/18?',
      'Перевір чи не скасовано рішення у справі 757/1234/22',
    ],
    dataSources: [
      { name: 'ZakonOnline', provides: 'ланцюг рішень через інстанції' },
      { name: 'PostgreSQL', provides: 'кешований статус прецеденту' },
    ],
    toolChain: [
      { tool: 'check_precedent_status', purpose: 'Перевірити чи рішення не скасовано' },
      { tool: 'get_case_documents_chain', purpose: 'Отримати ланцюг інстанцій' },
      { tool: 'get_citation_graph', purpose: 'Граф цитувань рішення: на які норми/статті воно посилається (decision→article + закон норми). Приймає case_id = номер справи або doc_id. Покриття часткове — порожній граф означає "немає даних графа", а не "рішення нічого не цитує"', optional: true },
    ],
    responseTemplate: [
      { heading: 'Статус рішення', instruction: 'актуальне / скасоване / змінене з поясненням' },
      { heading: 'Ланцюг інстанцій', instruction: 'хронологія рішень вищих інстанцій' },
      { heading: 'Рішення що вплинули', instruction: 'які саме рішення скасували / змінили' },
      { heading: 'Правова основа', instruction: 'ключові норми, на які спирається рішення (з графа цитувань, якщо доступний)', optional: true },
      { heading: 'Висновок', instruction: 'чи можна посилатися на це рішення' },
    ],
  },

  {
    id: 'comprehensive_case_analysis',
    label: 'Комплексний аналіз справи через усі інстанції',
    domains: ['court', 'legal_advice'],
    triggerSlots: ['case_number'],
    exampleQueries: [
      'Проаналізуй справу 922/989/18 через усі інстанції',
      'Комплексний аналіз справи 757/1234/22 з хронологією та оцінкою доказів',
      'Аналіз справи 910/5678/20 — позиції судів, еволюція вимог, висновки для сторін',
      'Детальний розбір справи 922/989/18 від районного суду до Великої Палати ВС',
    ],
    dataSources: [
      { name: 'ZakonOnline', provides: 'повні тексти рішень усіх інстанцій' },
      { name: 'PostgreSQL', provides: 'кешовані повні тексти судових рішень' },
    ],
    toolChain: [
      { tool: 'get_case_documents_chain', purpose: 'отримати повний ланцюг документів через усі інстанції' },
      { tool: 'load_full_texts', purpose: 'завантажити повні тексти ключових рішень (Рішення, Постанови, Окремі думки)' },
      { tool: 'get_court_decision', purpose: 'отримати секції конкретного рішення для аналізу' },
      { tool: 'get_legislation_section', purpose: 'текст застосованих норм для перевірки', optional: true },
    ],
    responseTemplate: [
      { heading: 'Вступний блок', instruction: 'номер справи, обсяг аналізу (кількість документів, інстанцій), джерела (ЄДРСР)' },
      { heading: 'Картка справи', instruction: 'категорія, сторони (позивач, відповідач, треті особи), предмет спору (первісний), ціна позову, поточний статус' },
      { heading: 'Хронологія (таблиця)', instruction: 'таблиця: №, дата, інстанція, процесуальна дія, ключова зміна — від відкриття провадження до остаточного рішення' },
      { heading: 'Еволюція предмету спору та вимог', instruction: 'по етапах: що змінилось, причина зміни, процесуальна підстава. Фінальне формулювання вимог' },
      { heading: 'Аналіз доказової бази (таблиця)', instruction: 'таблиця по етапах: докази позивача, докази відповідача, оцінка суду (прийнято/відхилено з мотивуванням), прогалини (що не досліджено)' },
      { heading: 'Позиції судів усіх інстанцій', instruction: 'для кожної інстанції окремо: висновок, мотивування, застосовані норми, ключова логіка. Для апеляції — розбіжність з 1 інстанцією. Для касації — підстава передачі до ВП ВС. Для ВП ВС — правова позиція та значення для правозастосування' },
      { heading: 'Результативні висновки для сторін', instruction: 'окремо для позивача, відповідача, третіх осіб: що отримано, що втрачено, правові ризики що реалізувались, використані захисні аргументи та їх ефективність' },
      { heading: 'Ключові правові висновки', instruction: 'юрисдикційне питання (якщо було переадресування), еволюція правової позиції ВС (як змінювалась практика), прецедентне значення (чи формує нову правову позицію), окремі думки суддів (якщо є)' },
      { heading: 'Додатки', instruction: 'схема руху справи між інстанціями (текстовий flowchart), перелік усіх рішень з посиланнями на ЄДРСР, порівняльна таблиця позицій сторін', optional: true },
    ],
  },

  {
    id: 'similar_fact_pattern',
    label: 'Пошук справ зі схожими обставинами',
    domains: ['court'],
    exampleQueries: [
      'Чи були справи де орендар відмовився від оренди через форс-мажор?',
      'Справи про відшкодування збитків від ДТП з пішоходом',
    ],
    dataSources: [
      { name: 'ZakonOnline', provides: 'рішення зі схожими фактичними обставинами' },
    ],
    toolChain: [
      { tool: 'find_similar_fact_pattern_cases', purpose: 'пошук справ зі схожими обставинами' },
    ],
    responseTemplate: [
      { heading: 'Схожі обставини', instruction: 'які факти збігаються' },
      { heading: 'Як суди вирішили', instruction: 'рішення у схожих справах' },
      { heading: 'Тенденція', instruction: 'переважаюча позиція судів' },
      { heading: 'Джерела', instruction: 'номери справ' },
    ],
  },

  {
    id: 'practice_pro_contra',
    label: 'Порівняння позитивної та негативної практики',
    domains: ['court'],
    exampleQueries: [
      'Які шанси на задоволення позову про визнання договору недійсним?',
      'Порівняй практику за і проти стягнення моральної шкоди',
      'Який спосіб захисту обрати: негаторний позов чи віндикаційний?',
    ],
    dataSources: [
      { name: 'ZakonOnline', provides: 'рішення з протилежними висновками' },
    ],
    toolChain: [
      { tool: 'compare_practice_pro_contra', purpose: 'порівняння позитивної та негативної практики' },
      { tool: 'search_court_decisions', purpose: 'додатковий пошук по окремих моделях захисту з різними запитами', optional: true },
      { tool: 'get_case_documents_chain', purpose: 'перевірка скасованих рішень через інстанції', optional: true },
    ],
    responseTemplate: [
      { heading: 'Порівняльна таблиця підходів', instruction: 'таблиця: підхід суду | правова підстава | коли застосовують | як кваліфікують | де відмовляють | ризик для позивача — з номерами справ' },
      { heading: 'ЗА (позитивна практика)', instruction: 'рішення на користь позивача з мотивуванням суду' },
      { heading: 'ПРОТИ (негативна практика)', instruction: 'рішення на користь відповідача з причинами відмови' },
      { heading: 'Відмінності юрисдикцій', instruction: 'як відрізняється підхід КГС від КЦС, апеляційних судів — з номерами справ', optional: true },
      { heading: 'Скасовані рішення', instruction: 'ОКРЕМИЙ пошук скасованих рішень (запит "тема + скасовано + апеляція"): номер справи, що вирішила перша інстанція, чому скасувала вища, як переформулювали вимоги' },
      { heading: 'Ризики щодо третіх осіб', instruction: 'залучення третіх осіб, майно третіх осіб, скасування через незалучення', optional: true },
      { heading: 'Виконуваність рішення', instruction: 'строк добровільного виконання, субсидіарне виконання за рахунок відповідача, які формулювання ДВС може реально виконати' },
      { heading: 'Баланс та тенденція', instruction: 'співвідношення позитивної/негативної практики, яка позиція переважає' },
      { heading: 'Стратегічна рекомендація', instruction: 'яка модель найбезпечніша, чи комбінувати підстави, чеклист для позовної заяви' },
    ],
  },

  {
    id: 'party_case_statistics',
    label: 'Статистика справ за учасником',
    domains: ['court'],
    exampleQueries: [
      'Скільки справ у ТОВ "Нова Пошта"?',
      'Судова статистика ПАТ "Укрзалізниця"',
    ],
    dataSources: [
      { name: 'ZakonOnline', provides: 'кількість та розподіл справ за стороною' },
    ],
    toolChain: [
      { tool: 'count_cases_by_party', purpose: 'статистика справ за учасником' },
    ],
    responseTemplate: [
      { heading: 'Загальна кількість', instruction: 'кількість справ' },
      { heading: 'Розподіл за категоріями', instruction: 'цивільні, господарські, адміністративні' },
      { heading: 'Ключові справи', instruction: 'найбільш значимі справи', optional: true },
    ],
  },

  // ─────────────── EDRSR (2) ───────────────

  {
    id: 'edrsr_case_search',
    label: 'Пошук рішень у ЄДРСР',
    domains: ['court'],
    exampleQueries: [
      'Знайди рішення судді Іванова за 2024 рік',
      'Господарські справи Господарського суду Харківської області за останній місяць',
      'Рішення у справі 922/989/18',
      'Кримінальні вироки за статтею 190 КК за 2023 рік',
    ],
    dataSources: [
      { name: 'PostgreSQL (ЄДРСР)', provides: 'метадані та повні тексти 82+ млн судових рішень' },
    ],
    toolChain: [
      { tool: 'search_court_decisions', purpose: 'пошук рішень за суддею, судом, датою, видом судочинства' },
      { tool: 'get_edrsr_decision_fulltext', purpose: 'отримати повний текст конкретного рішення', optional: true },
    ],
    responseTemplate: [
      { heading: 'Результати пошуку', instruction: 'знайдені рішення з номером справи, судом, суддею, датою' },
      { heading: 'Кількість', instruction: 'скільки всього знайдено рішень' },
      { heading: 'Аналіз', instruction: 'короткий огляд знайдених рішень', optional: true },
      { heading: 'Джерела', instruction: 'посилання на ЄДРСР' },
    ],
  },

  {
    id: 'edrsr_judge_analysis',
    label: 'Аналіз практики конкретного судді',
    domains: ['court'],
    triggerSlots: ['judge_name'],
    exampleQueries: [
      'Які рішення виносив суддя Петренко?',
      'Статистика рішень судді Коваленко за 2023-2024',
    ],
    dataSources: [
      { name: 'PostgreSQL (ЄДРСР)', provides: 'рішення конкретного судді з повними текстами' },
    ],
    toolChain: [
      { tool: 'search_court_decisions', purpose: 'пошук рішень за ПІБ судді' },
      { tool: 'get_edrsr_decision_fulltext', purpose: 'повний текст ключового рішення', optional: true },
    ],
    responseTemplate: [
      { heading: 'Статистика судді', instruction: 'кількість рішень, розподіл за категоріями та формами' },
      { heading: 'Ключові справи', instruction: 'найбільш значимі рішення' },
      { heading: 'Джерела', instruction: 'посилання на ЄДРСР' },
    ],
  },

  {
    id: 'edrsr_fulltext_search',
    label: 'Повнотекстовий пошук у ЄДРСР',
    domains: ['court'],
    exampleQueries: [
      'Знайди рішення про самовільне зайняття земельної ділянки',
      'Судова практика щодо оренди нежитлових приміщень',
      'Рішення де згадується ст. 376 ЦК',
    ],
    dataSources: [
      { name: 'PostgreSQL (ЄДРСР FTS)', provides: 'повнотекстовий пошук по 96М+ рішеннях з ранжуванням' },
    ],
    toolChain: [
      { tool: 'search_court_decisions', purpose: 'повнотекстовий пошук за ключовими словами з фільтрами' },
      { tool: 'get_edrsr_decision_fulltext', purpose: 'повний текст найрелевантнішого рішення', optional: true },
    ],
    responseTemplate: [
      { heading: 'Результати пошуку', instruction: 'знайдені рішення з фрагментами тексту та ранжуванням' },
      { heading: 'Кількість', instruction: 'скільки знайдено рішень за запитом' },
      { heading: 'Джерела', instruction: 'посилання на ЄДРСР' },
    ],
  },

  {
    id: 'edrsr_semantic_search',
    label: 'Семантичний пошук подібних рішень у ЄДРСР',
    domains: ['court'],
    exampleQueries: [
      'Знайди рішення з подібною аргументацією до цієї справи',
      'Схожі справи про порушення умов договору підряду',
      'Рішення де суд застосовував аналогічну правову позицію',
    ],
    dataSources: [
      { name: 'Qdrant (ЄДРСР vectors)', provides: 'семантичний пошук за змістом через BGE-M3 embeddings' },
      { name: 'PostgreSQL (ЄДРСР FTS)', provides: 'попередній пошук для автоматичної векторизації' },
    ],
    toolChain: [
      { tool: 'search_court_decisions', purpose: 'семантичний пошук за змістом, не за точними словами' },
      { tool: 'get_edrsr_decision_fulltext', purpose: 'повний текст семантично схожого рішення', optional: true },
    ],
    responseTemplate: [
      { heading: 'Семантично схожі рішення', instruction: 'рішення відсортовані за семантичною близькістю з оцінкою' },
      { heading: 'Аналіз подібності', instruction: 'що спільного між знайденими рішеннями' },
      { heading: 'Джерела', instruction: 'посилання на ЄДРСР' },
    ],
  },

  // ─────────────── Legislation (5) ───────────────

  {
    id: 'legislation_article_lookup',
    label: 'Пошук конкретної статті закону',
    domains: ['legislation'],
    triggerSlots: ['law_reference'],
    exampleQueries: [
      'Стаття 16 Цивільного кодексу',
      'Що каже ст. 382 КК?',
    ],
    dataSources: [
      { name: 'Rada API', provides: 'текст статті закону' },
      { name: 'PostgreSQL', provides: 'кешовані тексти законодавства' },
    ],
    toolChain: [
      { tool: 'get_legislation_article', purpose: 'отримати текст конкретної статті' },
      { tool: 'get_legislation_history', purpose: 'історія змін/редакцій цієї статті (для запитів про зміни)', optional: true },
      { tool: 'search_court_decisions', purpose: 'практика застосування цієї статті', optional: true },
    ],
    responseTemplate: [
      { heading: 'Текст статті', instruction: 'повний текст статті закону' },
      { heading: 'Практика застосування', instruction: 'як суди тлумачать цю норму', optional: true },
      { heading: "Пов'язані норми", instruction: 'суміжні статті', optional: true },
    ],
  },

  {
    id: 'legislation_section_lookup',
    label: 'Розділ або глава закону',
    domains: ['legislation'],
    exampleQueries: [
      'Розділ II ЦПК про юрисдикцію',
      'Глава 82 ЦК про відшкодування шкоди',
    ],
    dataSources: [
      { name: 'Rada API', provides: 'текст розділу закону' },
    ],
    toolChain: [
      { tool: 'get_legislation_section', purpose: 'отримати розділ/главу закону' },
    ],
    responseTemplate: [
      { heading: 'Структура розділу', instruction: 'перелік статей із назвами' },
      { heading: 'Ключові статті', instruction: 'найважливіші норми розділу' },
      { heading: 'Зміст', instruction: 'короткий зміст розділу' },
    ],
  },

  {
    id: 'legislation_search',
    label: 'Пошук законодавства за темою',
    domains: ['legislation', 'legal_advice'],
    exampleQueries: [
      'Який закон регулює оренду земельних ділянок?',
      'Законодавство про захист прав споживачів',
    ],
    dataSources: [
      { name: 'Rada API', provides: 'закони за тематикою' },
      { name: 'ZakonOnline', provides: 'додаткові нормативні акти' },
    ],
    toolChain: [
      { tool: 'search_legislation', purpose: 'пошук законів за темою' },
      { tool: 'get_legislation_article', purpose: 'текст конкретних статей', optional: true },
      { tool: 'list_legislation_editions', purpose: 'перелік дат редакцій акту (для запитів про зміни/історію)', optional: true },
      { tool: 'get_legislation_history', purpose: 'історія змін та редакцій акту або конкретної статті', optional: true },
    ],
    responseTemplate: [
      { heading: 'Знайдені закони', instruction: 'перелік відповідних нормативних актів' },
      { heading: 'Релевантні статті', instruction: 'конкретні норми що регулюють питання' },
      { heading: 'Висновок', instruction: 'які акти застосовуються до ситуації' },
    ],
  },

  {
    id: 'relevant_articles_by_situation',
    label: 'Знайти статті за описом ситуації',
    domains: ['legislation', 'legal_advice'],
    exampleQueries: [
      'Мене звільнили без попередження, які мої права?',
      'Сусід заливає квартиру, що робити за законом?',
      'Є норма яка вимагає нотаріальне засвідчення при реєстрації авто з кількома власниками',
    ],
    dataSources: [
      { name: 'Rada API', provides: 'норми що регулюють ситуацію' },
    ],
    toolChain: [
      { tool: 'find_relevant_law_articles', purpose: 'знайти застосовні норми за описом ситуації (семантичний пошук по законодавству)' },
      { tool: 'get_legislation_article', purpose: 'отримати повний текст знайденої статті', optional: true },
      { tool: 'get_legislation_history', purpose: 'переглянути історію змін до знайденого акту', optional: true },
    ],
    responseTemplate: [
      { heading: 'Ситуація', instruction: 'переформулювання запиту юридичною мовою' },
      { heading: 'Застосовні норми', instruction: 'конкретні статті з цитатами' },
      { heading: 'Історія змін', instruction: 'як змінювалась норма з часом (якщо запитували)', optional: true },
      { heading: 'Порядок дій', instruction: 'покрокові рекомендації' },
      { heading: 'Джерела', instruction: 'посилання на закони' },
    ],
  },

  {
    id: 'procedural_norms_search',
    label: 'Пошук процесуальних норм',
    domains: ['legislation'],
    exampleQueries: [
      'Строки подання апеляційної скарги у цивільній справі',
      'Порядок забезпечення позову в господарському процесі',
    ],
    dataSources: [
      { name: 'Rada API', provides: 'процесуальні кодекси та норми' },
    ],
    toolChain: [
      { tool: 'search_procedural_norms', purpose: 'пошук процесуальних норм' },
    ],
    responseTemplate: [
      { heading: 'Процесуальна норма', instruction: 'відповідна стаття процесуального кодексу' },
      { heading: 'Строки', instruction: 'процесуальні строки якщо є' },
      { heading: 'Порядок', instruction: 'покрокова процедура' },
      { heading: 'Джерела', instruction: 'посилання на процесуальний кодекс' },
    ],
  },

  // ─────────────── Registry (7) ───────────────

  {
    id: 'entity_lookup_edrpou',
    label: 'Пошук юридичної особи за ЄДРПОУ або record',
    domains: ['registry'],
    triggerSlots: ['edrpou'],
    exampleQueries: [
      'Інформація про компанію з ЄДРПОУ 12345678',
      'Перевірити підприємство 87654321',
      'Повна картка компанії (record 14845945)',
    ],
    dataSources: [
      { name: 'OpenReyestr', provides: 'дані з Єдиного держреєстру (БЕЗ адреси та КВЕДів — вилучено через воєнний стан)' },
    ],
    toolChain: [
      { tool: 'openreyestr_get_by_edrpou', purpose: 'дані за ЄДРПОУ (або openreyestr_get_entity_details якщо є record)' },
      { tool: 'openreyestr_search_debtors', purpose: 'перевірка в реєстрі боржників', optional: true },
      { tool: 'openreyestr_search_enforcement_proceedings', purpose: 'виконавчі провадження', optional: true },
      { tool: 'openreyestr_search_bankruptcy_cases', purpose: 'перевірка на банкрутство', optional: true },
    ],
    responseTemplate: [
      { heading: 'Картка компанії', instruction: 'компактний блок: назва, ОПФ, ЄДРПОУ, статус, дата реєстрації, статутний капітал' },
      { heading: 'Керівник', instruction: 'ПІБ та посада' },
      { heading: 'Засновники', instruction: 'список із частками' },
      { heading: 'Бенефіціари', instruction: 'кінцеві власники з відсотками' },
      { heading: 'Реєстри ризиків', instruction: 'результати перевірки: боржники / провадження / банкрутство', optional: true },
      { heading: 'Примітка', instruction: 'ОДНЕ речення: "Адреса та КВЕДи відсутні у відкритих даних (обмеження воєнного часу)." — більше нічого' },
    ],
  },

  {
    id: 'entity_search_name',
    label: 'Пошук юридичної особи за назвою',
    domains: ['registry'],
    exampleQueries: [
      'Знайди компанію "Нова Пошта"',
      'Пошук ТОВ "Епіцентр"',
    ],
    dataSources: [
      { name: 'OpenReyestr', provides: 'список знайдених юридичних осіб' },
    ],
    toolChain: [
      { tool: 'openreyestr_search_entities', purpose: 'пошук юр. осіб за назвою' },
      { tool: 'openreyestr_get_by_edrpou', purpose: 'деталі найбільш релевантного результату', optional: true },
    ],
    responseTemplate: [
      { heading: 'Список знайдених', instruction: 'назва, ЄДРПОУ, статус кожного' },
      { heading: 'Деталі найбільш релевантного', instruction: 'повна інформація', optional: true },
    ],
  },

  {
    id: 'beneficiary_search',
    label: 'Пошук кінцевих бенефіціарів',
    domains: ['registry'],
    exampleQueries: [
      'Хто бенефіціар ТОВ "Рошен"?',
      'Кінцеві власники компанії з ЄДРПОУ 00000000',
    ],
    dataSources: [
      { name: 'OpenReyestr', provides: 'дані про кінцевих бенефіціарних власників' },
    ],
    toolChain: [
      { tool: 'openreyestr_search_beneficiaries', purpose: 'пошук бенефіціарів' },
    ],
    responseTemplate: [
      { heading: 'Кінцеві бенефіціари', instruction: 'ПІБ та тип зв\'язку' },
      { heading: 'Частка', instruction: 'розмір частки кожного бенефіціара' },
      { heading: 'Ланцюг володіння', instruction: 'структура власності', optional: true },
    ],
  },

  {
    id: 'debtor_search',
    label: 'Пошук боржників',
    domains: ['registry'],
    exampleQueries: [
      'Чи є борги у ТОВ "Приклад"?',
      'Перевірити боржника Іванов Іван Іванович',
      'Виконавчі провадження по ЄДРПОУ 12345678',
    ],
    dataSources: [
      { name: 'ERB (Мін\'юст)', provides: 'Єдиний реєстр боржників (10M+ записів)' },
      { name: 'OpenReyestr', provides: 'реєстр боржників' },
    ],
    toolChain: [
      { tool: 'search_erb_debtors', purpose: 'пошук у Єдиному реєстрі боржників Мін\'юсту (основне джерело, 10M+ записів)' },
      { tool: 'openreyestr_search_debtors', purpose: 'додатковий пошук боржників (OpenReyestr)', optional: true },
    ],
    responseTemplate: [
      { heading: 'Боржник', instruction: 'назва/ПІБ боржника' },
      { heading: 'Код ЄДРПОУ', instruction: 'ідентифікаційний код (якщо є)', optional: true },
      { heading: 'Виконавче провадження', instruction: 'номер ВП та категорія стягнення' },
      { heading: 'Орган стягнення', instruction: 'суд або орган, що видав документ' },
      { heading: 'Виконавець', instruction: 'ПІБ та контакти державного/приватного виконавця' },
    ],
  },

  {
    id: 'bankruptcy_search',
    label: 'Справи про банкрутство',
    domains: ['registry'],
    exampleQueries: [
      'Чи є справа про банкрутство ТОВ "Будінвест"?',
      'Банкрутство компанії ЄДРПОУ 11111111',
    ],
    dataSources: [
      { name: 'OpenReyestr', provides: 'справи про банкрутство' },
    ],
    toolChain: [
      { tool: 'openreyestr_search_bankruptcy_cases', purpose: 'пошук справ про банкрутство' },
    ],
    responseTemplate: [
      { heading: 'Боржник', instruction: 'назва та ідентифікатори' },
      { heading: 'Стадія банкрутства', instruction: 'розпорядження майном / ліквідація / санація' },
      { heading: 'Арбітражний керуючий', instruction: 'ПІБ та контакти' },
      { heading: 'Кредитори', instruction: 'основні кредитори', optional: true },
    ],
  },

  {
    id: 'enforcement_proceedings',
    label: 'Виконавчі провадження',
    domains: ['registry'],
    exampleQueries: [
      'Виконавчі провадження щодо Петренко П.П.',
      'Статус виконавчого провадження №12345',
    ],
    dataSources: [
      { name: 'ERB (Мін\'юст)', provides: 'Єдиний реєстр боржників (виконавчі провадження)' },
      { name: 'OpenReyestr', provides: 'реєстр виконавчих проваджень' },
    ],
    toolChain: [
      { tool: 'search_erb_debtors', purpose: 'пошук у Єдиному реєстрі боржників за номером ВП або ПІБ' },
      { tool: 'openreyestr_search_enforcement_proceedings', purpose: 'додатковий пошук виконавчих проваджень', optional: true },
    ],
    responseTemplate: [
      { heading: 'Номер провадження', instruction: 'номер та дата відкриття' },
      { heading: 'Виконавець', instruction: 'назва органу/виконавця' },
      { heading: 'Боржник', instruction: 'дані боржника' },
      { heading: 'Статус', instruction: 'стан провадження' },
    ],
  },

  {
    id: 'notary_expert_search',
    label: 'Пошук нотаріусів та судових експертів',
    domains: ['registry'],
    exampleQueries: [
      'Нотаріуси у Київському районі Одеси',
      'Судові експерти з почеркознавства',
    ],
    dataSources: [
      { name: 'OpenReyestr', provides: 'реєстри нотаріусів та судових експертів' },
    ],
    toolChain: [
      { tool: 'openreyestr_search_notaries', purpose: 'пошук нотаріусів', optional: true },
      { tool: 'openreyestr_search_court_experts', purpose: 'пошук судових експертів', optional: true },
      { tool: 'openreyestr_search_forensic_methods', purpose: 'методики судових експертиз', optional: true },
    ],
    responseTemplate: [
      { heading: 'Список знайдених', instruction: 'ПІБ, район діяльності' },
      { heading: 'Контакти', instruction: 'адреса, телефон' },
      { heading: 'Спеціалізація', instruction: 'вид діяльності або спеціальність' },
    ],
  },

  {
    id: 'nbu_bank_search',
    label: 'Пошук банків з ліцензією НБУ',
    domains: ['registry'],
    exampleQueries: [
      'Чи має банк "Приватбанк" ліцензію НБУ?',
      'Які банки мають статус "Неплатоспроможний"?',
      'Інформація про банк з ЄДРПОУ 14360570',
      'Список усіх банків України',
    ],
    dataSources: [
      { name: 'НБУ (bank.gov.ua)', provides: 'реєстр банків з банківською ліцензією' },
    ],
    toolChain: [
      { tool: 'search_nbu_banks', purpose: 'пошук банків у реєстрі НБУ' },
    ],
    responseTemplate: [
      { heading: 'Банк', instruction: 'назва та ЄДРПОУ' },
      { heading: 'Статус', instruction: 'нормальний / неплатоспроможний / ліквідація' },
      { heading: 'Ліцензія', instruction: 'номер та дата ліцензії' },
      { heading: 'Контакти', instruction: 'адреса, телефон, сайт' },
    ],
  },

  // ─────────────── Parliament (4) ───────────────

  {
    id: 'deputy_info',
    label: 'Інформація про народного депутата',
    domains: ['parliament'],
    exampleQueries: [
      'Хто такий депутат Шевченко?',
      'Депутати фракції "Слуга Народу"',
    ],
    dataSources: [
      { name: 'Rada API', provides: 'дані про народних депутатів' },
    ],
    toolChain: [
      { tool: 'rada_get_deputy_info', purpose: 'отримати інформацію про депутата або фракцію' },
    ],
    responseTemplate: [
      { heading: 'ПІБ', instruction: 'повне ім\'я депутата' },
      { heading: 'Фракція', instruction: 'назва фракції' },
      { heading: 'Комітети', instruction: 'членство у комітетах' },
      { heading: 'Контакти', instruction: 'контактна інформація', optional: true },
    ],
  },

  {
    id: 'parliament_bills_search',
    label: 'Пошук законопроєктів',
    domains: ['parliament'],
    exampleQueries: [
      'Законопроєкти про мобілізацію',
      'Які законопроєкти подав депутат Іваненко?',
    ],
    dataSources: [
      { name: 'Rada API', provides: 'реєстр законопроєктів Верховної Ради' },
    ],
    toolChain: [
      { tool: 'rada_search_parliament_bills', purpose: 'пошук законопроєктів' },
    ],
    responseTemplate: [
      { heading: 'Список законопроєктів', instruction: 'номер, назва, дата реєстрації' },
      { heading: 'Статус', instruction: 'стадія розгляду' },
      { heading: 'Ініціатори', instruction: 'хто подав законопроєкт' },
    ],
  },

  {
    id: 'legislation_text_search',
    label: 'Пошук текстів законів (Рада)',
    domains: ['parliament', 'legislation'],
    exampleQueries: [
      'Знайди в законах згадку про "електронний підпис"',
      'Текст закону про публічні закупівлі',
    ],
    dataSources: [
      { name: 'Rada API', provides: 'повнотекстовий пошук по законодавству' },
    ],
    toolChain: [
      { tool: 'rada_search_legislation_text', purpose: 'повнотекстовий пошук у законах' },
    ],
    responseTemplate: [
      { heading: 'Знайдені тексти', instruction: 'назви законів що містять пошуковий термін' },
      { heading: 'Релевантні фрагменти', instruction: 'цитати з контекстом' },
    ],
  },

  {
    id: 'voting_record_analysis',
    label: 'Аналіз голосувань',
    domains: ['parliament'],
    exampleQueries: [
      'Як голосували за закон про мобілізацію?',
      'Голосування фракції "ЄС" за бюджет 2025',
    ],
    dataSources: [
      { name: 'Rada API', provides: 'результати голосувань' },
    ],
    toolChain: [
      { tool: 'rada_analyze_voting_record', purpose: 'аналіз результатів голосування' },
    ],
    responseTemplate: [
      { heading: 'Результат голосування', instruction: 'за/проти/утримались/не голосували' },
      { heading: 'Розподіл по фракціях', instruction: 'як голосувала кожна фракція' },
    ],
  },

  // ─────────────── Documents (2) ───────────────

  {
    id: 'document_semantic_search',
    label: 'Пошук по документах користувача',
    domains: ['documents'],
    exampleQueries: [
      'Що написано в завантаженому договорі про відповідальність?',
      'Знайди в моїх документах інформацію про гарантійний строк',
      'Документи зі словом "оренда" в назві',
    ],
    dataSources: [
      { name: 'PostgreSQL', provides: 'повнотекстовий пошук по назві та змісту документів (list_documents з query)' },
      { name: 'Qdrant', provides: 'векторний пошук по завантажених документах' },
    ],
    toolChain: [
      { tool: 'list_documents', purpose: 'текстовий пошук за ключовими словами (query параметр) — для точних збігів, назв, ключових слів', optional: true },
      { tool: 'semantic_search', purpose: 'семантичний пошук за змістом — для пошуку за значенням, коли ключові слова невідомі' },
    ],
    responseTemplate: [
      { heading: 'Знайдені документи', instruction: 'назви документів' },
      { heading: 'Релевантні фрагменти', instruction: 'цитати з документів' },
      { heading: 'Джерела', instruction: 'назви файлів та секції' },
    ],
  },

  {
    id: 'document_store',
    label: 'Збереження документа',
    domains: ['documents'],
    exampleQueries: [
      'Збережи цей договір',
      'Додай документ до бази',
    ],
    dataSources: [
      { name: 'PostgreSQL', provides: 'збереження метаданих' },
      { name: 'Qdrant', provides: 'збереження векторних ембедінгів' },
    ],
    toolChain: [
      { tool: 'store_document', purpose: 'зберегти документ у систему' },
    ],
    responseTemplate: [
      { heading: 'Статус збереження', instruction: 'успішно / помилка' },
      { heading: 'ID документа', instruction: 'ідентифікатор збереженого документа' },
    ],
  },

  {
    id: 'document_list',
    label: 'Список документів користувача',
    domains: ['documents'],
    exampleQueries: [
      'Які документи я завантажив?',
      'Покажи мої файли у VAULT',
      'Знайди документ з назвою "договір оренди"',
    ],
    dataSources: [
      { name: 'PostgreSQL', provides: 'список завантажених документів з повнотекстовим пошуком' },
    ],
    toolChain: [
      { tool: 'list_documents', purpose: 'отримати список документів (використовуй query для пошуку за ключовими словами у назві/тексті)' },
    ],
    responseTemplate: [
      { heading: 'Документи', instruction: 'список документів з датами' },
    ],
  },

  {
    id: 'document_delete',
    label: 'Видалення документа з Vault',
    domains: ['documents'],
    exampleQueries: [
      'Видали документ "договір оренди"',
      'Удали файл про земельну ділянку',
      'Delete document with name...',
    ],
    dataSources: [
      { name: 'PostgreSQL', provides: 'документ для видалення' },
    ],
    toolChain: [
      { tool: 'list_documents', purpose: 'знайти документ за назвою/ключовими словами' },
      { tool: 'delete_document', purpose: 'видалити документ за ID' },
    ],
    responseTemplate: [
      { heading: 'Результат', instruction: 'підтвердження видалення з назвою документа' },
    ],
  },

  {
    id: 'document_update',
    label: 'Оновлення метаданих документа',
    domains: ['documents'],
    exampleQueries: [
      'Переименуй документ на "Новий договір"',
      'Додай тег "оренда" до документа',
      'Перенеси документ в папку Contracts',
    ],
    dataSources: [
      { name: 'PostgreSQL', provides: 'документ для оновлення' },
    ],
    toolChain: [
      { tool: 'list_documents', purpose: 'знайти документ за назвою/ключовими словами' },
      { tool: 'update_document', purpose: 'оновити метадані документа (назва, теги, тип, категорія, папка)' },
    ],
    responseTemplate: [
      { heading: 'Результат', instruction: 'підтвердження оновлення з новими даними' },
    ],
  },

  // ─────────────── Document Analysis (4) ───────────────

  {
    id: 'document_summarize',
    label: 'Резюме документа користувача',
    domains: ['documents'],
    exampleQueries: [
      'Зроби резюме мого договору оренди',
      'Короткий зміст завантаженого документа',
      'Проаналізуй мій договір',
    ],
    dataSources: [
      { name: 'PostgreSQL', provides: 'повний текст документа з Vault' },
      { name: 'OpenAI', provides: 'LLM-аналіз для генерації резюме' },
    ],
    toolChain: [
      { tool: 'list_documents', purpose: 'знайти документ за назвою/ключовими словами' },
      { tool: 'get_document', purpose: 'отримати повний текст документа для аналізу' },
      { tool: 'summarize_document', purpose: 'створити резюме: executive summary + детальний опис + ключові факти (сторони, дати, суми)' },
    ],
    responseTemplate: [
      { heading: 'Executive Summary', instruction: 'короткий огляд для керівництва' },
      { heading: 'Детальний опис', instruction: 'опис по секціях' },
      { heading: 'Ключові факти', instruction: 'сторони, дати, суми' },
    ],
  },

  {
    id: 'document_extract_clauses',
    label: 'Витяг ключових положень з договору',
    domains: ['documents'],
    exampleQueries: [
      'Витягни ключові пункти з договору',
      'Які зобов\'язання сторін у договорі?',
      'Проаналізуй ризики в договорі оренди',
    ],
    dataSources: [
      { name: 'PostgreSQL', provides: 'повний текст документа з Vault' },
      { name: 'OpenAI', provides: 'LLM-аналіз для класифікації клаузул' },
    ],
    toolChain: [
      { tool: 'list_documents', purpose: 'знайти документ за назвою/ключовими словами' },
      { tool: 'get_document', purpose: 'отримати повний текст документа' },
      { tool: 'extract_key_clauses', purpose: 'витягнути та класифікувати положення: сторони, обов\'язки, строки, платежі, відповідальність, ризики' },
    ],
    responseTemplate: [
      { heading: 'Сторони та предмет', instruction: 'хто і про що' },
      { heading: 'Ключові положення', instruction: 'список клаузул за типами' },
      { heading: 'Ризики', instruction: 'положення з високим/середнім рівнем ризику' },
    ],
  },

  {
    id: 'document_compare',
    label: 'Порівняння двох документів',
    domains: ['documents'],
    exampleQueries: [
      'Порівняй два мої договори',
      'Що змінилось у новій версії договору?',
      'Різниця між двома документами',
    ],
    dataSources: [
      { name: 'PostgreSQL', provides: 'повні тексти обох документів з Vault' },
      { name: 'OpenAI', provides: 'семантичне порівняння через ембедінги' },
    ],
    toolChain: [
      { tool: 'list_documents', purpose: 'знайти обидва документи за назвою' },
      { tool: 'get_document', purpose: 'отримати повний текст першого документа' },
      { tool: 'compare_documents', purpose: 'семантичне порівняння: критичні, значні та незначні зміни' },
    ],
    responseTemplate: [
      { heading: 'Критичні зміни', instruction: 'зміни сум, строків, обов\'язків' },
      { heading: 'Значні зміни', instruction: 'нові клаузули, зміни прав' },
      { heading: 'Незначні зміни', instruction: 'форматування, опечатки' },
      { heading: 'Висновок', instruction: 'загальна оцінка змін' },
    ],
  },

  {
    id: 'document_get_full_text',
    label: 'Отримання повного тексту документа',
    domains: ['documents'],
    exampleQueries: [
      'Покажи повний текст договору',
      'Відкрий мій документ',
      'Що написано в документі X?',
    ],
    dataSources: [
      { name: 'PostgreSQL', provides: 'повний текст та метадані документа' },
    ],
    toolChain: [
      { tool: 'list_documents', purpose: 'знайти документ за назвою/ключовими словами' },
      { tool: 'get_document', purpose: 'отримати повний текст, метадані, секції та результати аналізу' },
    ],
    responseTemplate: [
      { heading: 'Документ', instruction: 'текст документа або ключові секції' },
      { heading: 'Метадані', instruction: 'тип, дата, теги' },
    ],
  },

  // ─────────────── Composite (4) ───────────────

  {
    id: 'comprehensive_legal_advice',
    label: 'Комплексна юридична консультація',
    domains: ['legal_advice'],
    exampleQueries: [
      'Як захистити права при незаконному звільненні?',
      'Що робити якщо забудовник порушує строки будівництва?',
      'Який спосіб захисту обрати при самовільному захопленні ділянки?',
    ],
    dataSources: [
      { name: 'Rada API', provides: 'відповідне законодавство' },
      { name: 'ZakonOnline', provides: 'судова практика' },
    ],
    toolChain: [
      { tool: 'search_legislation', purpose: 'знайти відповідний закон (max 2 виклики, не дублювати з варіаціями)' },
      { tool: 'get_legislation_article', purpose: 'текст конкретної статті', optional: true },
      { tool: 'search_court_decisions', purpose: 'судова практика з цього питання — ОБОВ\'ЯЗКОВО, шукає по 110M+ рішеннях усіх інстанцій' },
      { tool: 'get_case_documents_chain', purpose: 'перевірка ключових рішень через інстанції — чи діє, чи скасовано' },
      { tool: 'compare_practice_pro_contra', purpose: 'порівняння позитивної та негативної практики по кожній моделі', optional: true },
    ],
    responseTemplate: [
      { heading: 'Правова норма', instruction: 'відповідні статті законів з цитатами' },
      { heading: 'Конкуруючі способи захисту', instruction: 'перелік усіх можливих правових моделей з підставами', optional: true },
      { heading: 'Порівняльна таблиця', instruction: 'підхід | підстава | коли застосовують | де відмовляють | ризик — якщо є кілька способів захисту', optional: true },
      { heading: 'Позиція суду', instruction: 'як суди вирішують подібні справи — з номерами справ та мотивуванням' },
      { heading: 'Перевірка через інстанції', instruction: 'для ключових справ — чи рішення діє, чи скасовано/змінено вищою інстанцією' },
      { heading: 'Скасовані рішення', instruction: 'ОКРЕМИЙ пошук (запит "тема + скасовано"): що вирішила перша інстанція, чому скасувала вища, як переформулювали', optional: true },
      { heading: 'Висновок', instruction: 'конкретна відповідь на запитання' },
      { heading: 'Обмеження застосовності', instruction: 'коли норма/практика НЕ діє, які виключення, спеціальні умови' },
      { heading: 'Джерела', instruction: 'номери справ, статті законів' },
    ],
  },

  {
    id: 'legal_document_drafting',
    label: 'Складання юридичного документа',
    domains: ['legal_advice'],
    exampleQueries: [
      'Напиши позовну заяву про стягнення боргу',
      'Зразок скарги на дії виконавця',
    ],
    dataSources: [
      { name: 'Rada API', provides: 'правова основа для документа' },
    ],
    toolChain: [
      { tool: 'find_relevant_law_articles', purpose: 'знайти норми для правового обґрунтування' },
      { tool: 'search_legislation', purpose: 'додаткові нормативні акти', optional: true },
    ],
    responseTemplate: [
      { heading: 'Вступ + правова основа', instruction: 'пояснення та правова підстава' },
      { heading: 'Документ', instruction: 'зразок у блоці ```document з правильною розміткою' },
      { heading: 'Примітки', instruction: 'що потрібно замінити, на що звернути увагу' },
    ],
  },

  {
    id: 'echr_practice',
    label: 'Практика ЄСПЛ',
    domains: ['court'],
    exampleQueries: [
      'Рішення ЄСПЛ щодо свободи слова в Україні',
      'Практика Європейського суду з прав людини щодо права на справедливий суд',
    ],
    dataSources: [
      { name: 'ZakonOnline', provides: 'рішення ЄСПЛ' },
    ],
    toolChain: [
      { tool: 'search_echr_practice', purpose: 'пошук практики ЄСПЛ' },
    ],
    responseTemplate: [
      { heading: 'Справа ЄСПЛ', instruction: 'назва справи та номер заяви' },
      { heading: 'Обставини', instruction: 'короткий виклад фактів' },
      { heading: 'Рішення', instruction: 'висновок Суду' },
      { heading: 'Значення для України', instruction: 'як застосовується в українській практиці' },
    ],
  },

  {
    id: 'due_diligence_check',
    label: 'Комплексна перевірка контрагента (Due Diligence)',
    domains: ['registry', 'court'],
    triggerSlots: ['edrpou'],
    exampleQueries: [
      'Перевір контрагента ТОВ "Партнер" ЄДРПОУ 33333333',
      'Due diligence компанії "Інвест Груп"',
    ],
    dataSources: [
      { name: 'OpenReyestr', provides: 'реєстраційні дані, бенефіціари' },
      { name: 'ZakonOnline', provides: 'судові справи контрагента' },
    ],
    toolChain: [
      { tool: 'openreyestr_get_by_edrpou', purpose: 'загальна інформація з реєстру' },
      { tool: 'openreyestr_search_beneficiaries', purpose: 'кінцеві бенефіціари', optional: true },
      { tool: 'count_cases_by_party', purpose: 'судові справи контрагента', optional: true },
      { tool: 'openreyestr_search_debtors', purpose: 'перевірка в реєстрі боржників', optional: true },
      { tool: 'openreyestr_search_bankruptcy_cases', purpose: 'перевірка на банкрутство', optional: true },
    ],
    responseTemplate: [
      { heading: 'Загальна інформація', instruction: 'назва, статус, дата реєстрації, керівник' },
      { heading: 'Бенефіціари', instruction: 'ланцюг власності' },
      { heading: 'Судові справи', instruction: 'кількість та характер справ' },
      { heading: 'Борги', instruction: 'наявність у реєстрі боржників' },
      { heading: 'Ризик-оцінка', instruction: 'загальний висновок про надійність контрагента' },
    ],
  },

  // ─────────────── OSINT (3) ───────────────

  {
    id: 'osint_entity_screening',
    label: 'OSINT-перевірка особи/компанії (санкції, розшук, медіа)',
    domains: ['registry', 'court', 'legal_advice', 'osint'],
    exampleQueries: [
      'Перевір компанію Wirecard по міжнародних базах',
      'Чи є ця особа в санкційних списках OFAC або EU?',
      'OSINT-перевірка John Smith — санкції, Інтерпол, медіа',
    ],
    dataSources: [
      { name: 'OpenSanctions', provides: 'OFAC, EU, UN, РНБО, PEP бази' },
      { name: 'INTERPOL', provides: 'червоні повідомлення' },
      { name: 'World Bank', provides: 'список дебарменту' },
      { name: 'GLEIF/ICIJ', provides: 'корпоративні реєстри, offshore leaks' },
      { name: 'GDELT', provides: 'глобальне медіа-покриття' },
    ],
    toolChain: [
      { tool: 'osint_search_sanctions', purpose: 'перевірка за санкційними списками та PEP' },
      { tool: 'osint_search_interpol', purpose: 'перевірка в розшуку Інтерполу' },
      { tool: 'osint_search_worldbank_debarment', purpose: 'перевірка дебарменту Світового банку' },
      { tool: 'osint_search_corporate_registry', purpose: 'GLEIF + offshore leaks (Panama/Paradise Papers)', optional: true },
      { tool: 'osint_search_media_mentions', purpose: 'пошук медіа-згадок', optional: true },
    ],
    responseTemplate: [
      { heading: 'Санкції', instruction: 'статус за OFAC, EU, UN, РНБО з деталями' },
      { heading: 'Розшук', instruction: 'статус ІНТЕРПОЛУ, обвинувачення' },
      { heading: 'Дебармент', instruction: 'статус Світового банку' },
      { heading: 'Корпоративні зв\'язки', instruction: 'LEI, offshore connections' },
      { heading: 'Медіа', instruction: 'ключові згадки в новинах' },
      { heading: 'Ризик-рейтинг', instruction: 'загальна оцінка ризику з обґрунтуванням' },
    ],
  },

  {
    id: 'osint_cyber_check',
    label: 'Кібер-перевірка (IP, домен, витоки, вразливості)',
    domains: ['legal_advice', 'osint'],
    exampleQueries: [
      'Перевір домен company.com на безпеку',
      'Чи є витоки даних для email@company.com?',
      'Перевір IP 1.2.3.4 на шкідливу активність',
    ],
    dataSources: [
      { name: 'AbuseIPDB/GreyNoise', provides: 'репутація IP' },
      { name: 'VirusTotal/URLScan', provides: 'репутація домену' },
      { name: 'Breach DB', provides: 'витоки облікових даних' },
      { name: 'NVD', provides: 'CVE вразливості' },
    ],
    toolChain: [
      { tool: 'osint_check_domain_reputation', purpose: 'репутація домену через VirusTotal + URLScan' },
      { tool: 'osint_check_ip_reputation', purpose: 'репутація IP через AbuseIPDB + GreyNoise', optional: true },
      { tool: 'osint_search_credentials', purpose: 'пошук витоків за email/доменом', optional: true },
      { tool: 'osint_search_github_leaks', purpose: 'витоки в GitHub репозиторіях', optional: true },
      { tool: 'osint_search_cve', purpose: 'відомі вразливості', optional: true },
    ],
    responseTemplate: [
      { heading: 'Домен', instruction: 'вердикти VirusTotal, сертифікати, технології' },
      { heading: 'IP-репутація', instruction: 'рівень зловживань, ISP, класифікація' },
      { heading: 'Витоки даних', instruction: 'знайдені зламах, дати, типи даних' },
      { heading: 'Вразливості', instruction: 'CVE з CVSS, EPSS, KEV статусом' },
      { heading: 'Рекомендації', instruction: 'кроки щодо мітигації знайдених ризиків' },
    ],
  },

  {
    id: 'osint_darknet_intel',
    label: 'Darknet-розвідка (ransomware, форуми)',
    domains: ['legal_advice', 'osint'],
    exampleQueries: [
      'Чи є компанія у списках жертв ransomware?',
      'Що обговорюють на darknet форумах про Україну?',
    ],
    dataSources: [
      { name: 'Ransomware DB', provides: 'жертви ransomware-груп' },
      { name: 'Darknet Forums', provides: 'публікації darknet-форумів' },
    ],
    toolChain: [
      { tool: 'osint_search_ransomware_victims', purpose: 'перевірка в базі жертв ransomware' },
      { tool: 'osint_search_forum_subjects', purpose: 'пошук на darknet-форумах' },
    ],
    responseTemplate: [
      { heading: 'Ransomware', instruction: 'група-вимагач, дати, типи вкрадених даних' },
      { heading: 'Darknet-форуми', instruction: 'релевантні обговорення, категорії, рівень ризику' },
      { heading: 'Висновок', instruction: 'оцінка загрози та рекомендації' },
    ],
  },
];

// ============================
// Serializer → system prompt
// ============================

function serializeToolChain(steps: ScenarioToolStep[]): string {
  return steps
    .map((s) => (s.optional ? `${s.tool} (опц.)` : s.tool))
    .join(' → ');
}

function serializeResponseTemplate(sections: ResponseSection[]): string {
  return sections
    .map((s, i) => {
      const opt = s.optional ? ' (опц.)' : '';
      return `  ${i + 1}. ${s.heading}${opt} — ${s.instruction}`;
    })
    .join('\n');
}

/**
 * Serialize the full catalog (or a filtered subset) into readable text
 * that gets injected into the system prompt.
 */
export function serializeCatalogForPrompt(scenarios: ScenarioCatalogEntry[]): string {
  const lines: string[] = ['## Каталог сценаріїв\n'];

  for (const s of scenarios) {
    lines.push(`### ${s.id} — ${s.label}`);
    lines.push(`Джерела: ${s.dataSources.map((d) => `${d.name} (${d.provides})`).join(', ')}`);
    lines.push(`Інструменти: ${serializeToolChain(s.toolChain)}`);
    lines.push(`Приклад: "${s.exampleQueries[0]}"`);
    lines.push(`Шаблон відповіді:`);
    lines.push(serializeResponseTemplate(s.responseTemplate));
    lines.push('');
  }

  lines.push(`## Якщо жоден сценарій не підходить`);
  lines.push(`Сформуй відповідь за шаблоном найближчого сценарію. Базовий шаблон:`);
  lines.push(`  1. Аналіз — що потрібно користувачу`);
  lines.push(`  2. Знайдена інформація — результати інструментів`);
  lines.push(`  3. Висновок — відповідь`);
  lines.push(`  4. Джерела — перелік джерел`);

  return lines.join('\n');
}

// ============================
// Domain → Tools derivation
// ============================

/**
 * Derive DOMAIN_TOOL_MAP from the catalog so tool filtering stays in sync.
 */
export function deriveDomainToolMap(catalog: ScenarioCatalogEntry[]): Record<string, string[]> {
  const map: Record<string, Set<string>> = {};

  for (const entry of catalog) {
    for (const domain of entry.domains) {
      if (!map[domain]) map[domain] = new Set();
      for (const step of entry.toolChain) {
        map[domain].add(step.tool);
      }
    }
  }

  const result: Record<string, string[]> = {};
  for (const [domain, tools] of Object.entries(map)) {
    result[domain] = Array.from(tools);
  }
  return result;
}

/**
 * Derive default tools — non-optional tools from the most common scenarios.
 */
export function deriveDefaultTools(catalog: ScenarioCatalogEntry[]): string[] {
  const toolFreq = new Map<string, number>();

  for (const entry of catalog) {
    for (const step of entry.toolChain) {
      if (!step.optional) {
        toolFreq.set(step.tool, (toolFreq.get(step.tool) || 0) + 1);
      }
    }
  }

  // Take tools that appear in 2+ scenarios as non-optional, sorted by frequency
  return Array.from(toolFreq.entries())
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([tool]) => tool);
}

/**
 * Get prioritized tool names for a list of preferred scenario IDs.
 * Non-optional tools from preferred scenarios come first.
 */
export function getScenarioPriorityTools(scenarioIds: string[]): string[] {
  const priority: string[] = [];
  const seen = new Set<string>();

  for (const id of scenarioIds) {
    const scenario = SCENARIO_CATALOG.find(s => s.id === id);
    if (!scenario) continue;
    // Non-optional tools first
    for (const step of scenario.toolChain) {
      if (!step.optional && !seen.has(step.tool)) {
        seen.add(step.tool);
        priority.push(step.tool);
      }
    }
    // Then optional tools
    for (const step of scenario.toolChain) {
      if (step.optional && !seen.has(step.tool)) {
        seen.add(step.tool);
        priority.push(step.tool);
      }
    }
  }

  return priority;
}

// ============================
// Tool Groups — Two-tier selection
// ============================

/**
 * Semantic tool groups for two-tier tool selection.
 * IntentClassifier picks relevant groups based on intent, then expands to tool names.
 * This reduces the tool count the LLM sees from 45+ down to 8-15.
 */
export interface ToolGroup {
  id: string;
  label: string;       // Ukrainian label
  tools: string[];     // Tool names in this group
  domains: string[];   // Which domains this group covers
}

export const TOOL_GROUPS: ToolGroup[] = [
  {
    id: 'edrsr_search',
    label: 'Пошук в ЄДРСР',
    domains: ['court'],
    tools: [
      'search_court_decisions',
      'get_court_decision',
    ],
  },
  {
    id: 'court_practice',
    label: 'Судова практика',
    domains: ['court', 'legal_advice'],
    tools: [
      'search_court_decisions',
      'search_supreme_court_practice',
      'get_case_documents_chain',
      'count_cases_by_party',
    ],
  },
  {
    id: 'legislation',
    label: 'Законодавство',
    domains: ['legislation', 'legal_advice'],
    tools: [
      'get_legislation_article',
      'search_legislation',
      'find_relevant_law_articles',
      'get_legislation_structure',
      'list_legislation_editions',
      'get_legislation_history',
    ],
  },
  {
    id: 'registry',
    label: 'Реєстри',
    domains: ['registry'],
    tools: [
      'openreyestr_get_by_edrpou',
      'openreyestr_search_entities',
      'openreyestr_get_entity_details',
      'openreyestr_search_beneficiaries',
      'search_erb_debtors',
      'search_nbu_banks',
      'openreyestr_search_arbitration_managers',
      'openreyestr_search_legal_acts',
      'openreyestr_search_administrative_units',
      'openreyestr_search_streets',
      'openreyestr_search_special_forms',
    ],
  },
  {
    id: 'parliament',
    label: 'Парламент',
    domains: ['parliament'],
    tools: [
      'rada_get_deputy_info',
      'rada_search_parliament_bills',
      'rada_search_legislation_text',
      'rada_analyze_voting_record',
    ],
  },
  {
    id: 'vault',
    label: 'Документи',
    domains: ['documents'],
    tools: [
      'list_documents',
      'get_document',
      'semantic_search',
      'delete_document',
      'update_document',
    ],
  },
  {
    id: 'procedural',
    label: 'Процесуальне',
    domains: ['court', 'legal_advice'],
    tools: [
      'search_court_hearing_schedule',
      'search_court_registry',
      'get_court_info',
      'search_judges',
      'check_case_status',
      'calculate_deadlines',
    ],
  },
  {
    id: 'due_diligence',
    label: 'Due Diligence',
    domains: ['registry', 'court'],
    tools: [
      'openreyestr_get_by_edrpou',
      'openreyestr_search_beneficiaries',
      'search_erb_debtors',
      'count_cases_by_party',
    ],
  },
  {
    id: 'echr',
    label: 'ЄСПЛ',
    domains: ['echr'],
    tools: [
      'search_echr_cases',
      'get_echr_decision',
      'search_echr_by_article',
    ],
  },
  {
    id: 'osint',
    label: 'OSINT',
    domains: ['registry', 'court', 'legal_advice', 'osint'],
    tools: [
      'osint_search_sanctions',
      'osint_search_interpol',
      'osint_search_worldbank_debarment',
      'osint_search_corporate_registry',
      'osint_search_credentials',
      'osint_search_ransomware_victims',
      'osint_search_forum_subjects',
      'osint_search_cve',
      'osint_check_ip_reputation',
      'osint_check_domain_reputation',
      'osint_search_media_mentions',
      'osint_search_github_leaks',
    ],
  },
];

/**
 * Resolve tool groups by domain list → flat array of unique tool names.
 */
export function resolveToolGroupsByDomains(domains: string[]): string[] {
  const tools = new Set<string>();
  for (const group of TOOL_GROUPS) {
    if (group.domains.some(d => domains.includes(d))) {
      for (const tool of group.tools) {
        tools.add(tool);
      }
    }
  }
  return Array.from(tools);
}

/**
 * Resolve specific tool group IDs → flat array of unique tool names.
 */
export function resolveToolGroupsByIds(groupIds: string[]): string[] {
  const tools = new Set<string>();
  for (const group of TOOL_GROUPS) {
    if (groupIds.includes(group.id)) {
      for (const tool of group.tools) {
        tools.add(tool);
      }
    }
  }
  return Array.from(tools);
}

/**
 * Resolve tool groups that contain ANY of the given tool names.
 * Returns sibling tools from those groups — used to expand a plan's
 * tool list to include related tools the LLM might need.
 */
export function resolveToolGroupsByToolNames(toolNames: string[]): string[] {
  const tools = new Set<string>();
  for (const group of TOOL_GROUPS) {
    if (group.tools.some(t => toolNames.includes(t))) {
      for (const tool of group.tools) {
        tools.add(tool);
      }
    }
  }
  return Array.from(tools);
}

// Pre-computed exports
export const DERIVED_DOMAIN_TOOL_MAP = deriveDomainToolMap(SCENARIO_CATALOG);
export const DERIVED_DEFAULT_TOOLS = deriveDefaultTools(SCENARIO_CATALOG);

// ============================
// Enriched system prompt builder
// ============================

/**
 * Sections in the base prompt that are replaced by the catalog.
 * These are identified by their heading markers.
 */
const REPLACED_SECTION_HEADINGS = [
  '## Багатокрокові стратегії',
  '## Вибір інструменту для законодавства',
  '## Вибір інструменту для судових справ',
  '## Вибір інструменту для парламентських даних',
];

/**
 * Remove sections from the base prompt that are now covered by the catalog.
 */
function stripReplacedSections(prompt: string): string {
  let result = prompt;

  for (const heading of REPLACED_SECTION_HEADINGS) {
    // Find the heading and remove everything until the next ## heading or end
    const idx = result.indexOf(heading);
    if (idx === -1) continue;

    // Find the next ## heading after this one
    const afterHeading = idx + heading.length;
    const nextHeadingIdx = result.indexOf('\n##', afterHeading);

    if (nextHeadingIdx !== -1) {
      // Remove from heading start to the next heading (exclusive)
      result = result.slice(0, idx) + result.slice(nextHeadingIdx + 1); // +1 to skip the \n
    } else {
      // No next heading — remove to end
      result = result.slice(0, idx);
    }
  }

  return result;
}

/**
 * Build the enriched system prompt by:
 * 1. Stripping old tool-selection sections from the base prompt
 * 2. Filtering catalog scenarios to matching domains (if provided)
 * 3. Injecting the serialized catalog before ## Правила
 */
export function buildEnrichedSystemPrompt(
  basePrompt: string,
  catalog: ScenarioCatalogEntry[],
  domains?: string[],
  preferredScenarioIds?: string[]
): string {
  // 1. Strip old sections
  const stripped = stripReplacedSections(basePrompt);

  // 2. Filter catalog by domains (if known)
  let filtered: ScenarioCatalogEntry[];
  if (domains && domains.length > 0) {
    filtered = catalog.filter((entry) =>
      entry.domains.some((d) => domains.includes(d))
    );
    // Always include composite scenarios when legal_advice or multiple domains
    if (domains.length > 1 || domains.includes('legal_advice')) {
      const compositeIds = new Set(filtered.map((e) => e.id));
      for (const entry of catalog) {
        if (!compositeIds.has(entry.id) && entry.domains.length > 1) {
          // Check if any of entry's domains overlap with requested domains
          if (entry.domains.some((d) => domains.includes(d))) {
            filtered.push(entry);
          }
        }
      }
    }
  } else {
    filtered = catalog;
  }

  // 2b. Reorder: preferred scenarios first (if specified)
  if (preferredScenarioIds && preferredScenarioIds.length > 0) {
    const preferredSet = new Set(preferredScenarioIds);
    const preferred = filtered.filter((e) => preferredSet.has(e.id));
    const rest = filtered.filter((e) => !preferredSet.has(e.id));
    filtered = [...preferred, ...rest];
  }

  // 2c. Limit to top 4 scenarios to reduce token bloat (~30-40% savings)
  const MAX_SCENARIOS = 4;
  if (filtered.length > MAX_SCENARIOS) {
    filtered = filtered.slice(0, MAX_SCENARIOS);
  }

  // 3. Serialize catalog
  const catalogText = serializeCatalogForPrompt(filtered);

  // 4. Insert before ## Правила (or at the end if not found)
  const rulesIdx = stripped.indexOf('## Правила');
  if (rulesIdx !== -1) {
    return stripped.slice(0, rulesIdx) + catalogText + '\n\n' + stripped.slice(rulesIdx);
  }

  return stripped + '\n\n' + catalogText;
}
