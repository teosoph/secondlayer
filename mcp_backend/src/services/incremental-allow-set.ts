/**
 * IncrementalAllowSet — builds allow-sets for case numbers and law articles
 * incrementally during tool execution, not post-hoc from serialized results.
 *
 * Replaces buildAllowedCaseNumbers() + buildAllowedLawArticles() which
 * scanned JSON.stringify'd tool results with regex (fragile, caused PR #20
 * false positives from codes that were never searched).
 *
 * Each tool result is ingested immediately after execution. The set knows
 * exactly what was returned — no guessing from JSON scanning.
 */

import { logger } from '../utils/logger.js';
import { extractDispositiveStrict } from './shepardization-outcome.js';
import { BURDEN_OF_PROOF_SECTION } from './required-norms.js';

const CASE_NUMBER_RE = /\d+\/\d+\/\d{2,4}/g;

const LAW_ARTICLE_RE =
  /(?:ст(?:атт[іяє])?\.?\s*)(\d+(?:\.\d+)*)\s*(ЦК|ЦПК|ГК|ГПК|КК|КПК|ПКУ|КАС|КЗпП|КЗПП|СК|ЗК|МК|КУ|КУпАП|КУПАП)?/gi;

const SUBPOINT_RE =
  /(?:п{1,2}\.?\s*)(\d+(?:\.\d+)*)\s*(ЦК|ЦПК|ГК|ГПК|КК|КПК|ПКУ|КАС|КЗпП|КЗПП|СК|ЗК|МК|КУ|КУпАП|КУПАП)?/gi;

const CODE_TO_RADA: Record<string, string> = {
  'ЦК': '435-15', 'ЦПК': '1618-15', 'ГК': '436-15', 'ГПК': '1798-12',
  'КК': '2341-14', 'КПК': '4651-17', 'ПКУ': '2755-17', 'КАС': '2747-15',
  'КЗПП': '322-08', 'КЗпП': '322-08', 'СК': '2947-14', 'ЗК': '2768-14',
  'МК': '4495-17', 'КУ': '254к/96-вр', 'КУпАП': '80731-10', 'КУПАП': '80731-10',
};

// КУпАП is split in RADA across two documents: 80731-10 (статті 1–212-21) and
// 80732-10 (статті 213–330). CODE_TO_RADA maps it to the first half only, so a
// citation to ст. 213+ — grounded by a search that returned the 80732-10 half —
// would be wrongly flagged as fabricated. Treat either half as КУпАП (LEXAI-1770).
const KUPAP_RADA_IDS = ['80731-10', '80732-10'];

/** All rada_ids equivalent to the given one (КУпАП → both halves; else just it). */
function relatedRadaIds(radaId: string): string[] {
  return KUPAP_RADA_IDS.includes(radaId) ? KUPAP_RADA_IDS : [radaId];
}

/** The CODE_TO_RADA key for a rada_id, treating both КУпАП halves as 'КУпАП'. */
function codeForRadaId(radaId: string): string | undefined {
  if (KUPAP_RADA_IDS.includes(radaId)) return 'КУпАП';
  return Object.entries(CODE_TO_RADA).find(([, v]) => v === radaId)?.[0];
}

/**
 * Mutually-exclusive subject markers — used to catch a real case cited for a subject it
 * is NOT about (e.g. a ПДВ case characterised as a податок-на-нерухомість holding, observed
 * in chat-001815fe). `caseRe` detects a case's OWN subject from its captured result text
 * (strict — needs a defining marker); `claimRe` detects what the answer asserts near the
 * citation (looser — a characterisation, not source text). Tax-type axis for now; add
 * further disjoint axes as new failure modes surface.
 */
interface SubjectGroup { key: string; label: string; caseRe: RegExp; claimRe: RegExp; }

const SUBJECT_GROUPS: SubjectGroup[] = [
  { key: 'property_tax', label: 'податок на нерухоме майно',
    // NB: \b is ASCII-only and never matches next to Cyrillic (CORE-98) — use lookarounds.
    caseRe: /податк[а-яії]*\s+на\s+нерухом|нерухоме майно,?\s+відмінн|266\s*пку|(?<![а-яіїєґ\d])ст\.?\s*266(?!\d)|пп\.?\s*266/i,
    claimRe: /податк[а-яії]*\s+на\s+нерухом|нерухом(?:е|ого|ість|істю|ості|им)|266\s*пку|(?<![а-яіїєґ\d])ст\.?\s*266(?!\d)/i },
  { key: 'vat', label: 'ПДВ',
    caseRe: /податк[а-яії]*\s+на\s+додану\s+вартіст|(?<![а-яіїєґ])пдв(?![а-яіїєґ])/i,
    claimRe: /податк[а-яії]*\s+на\s+додану\s+вартіст|(?<![а-яіїєґ])пдв(?![а-яіїєґ])/i },
  { key: 'land', label: 'плата за землю',
    caseRe: /плат[аиу]\s+за\s+землю|земельн[а-яії]*\s+податок|податк[а-яії]*\s+на\s+земл/i,
    claimRe: /плат[аиу]\s+за\s+землю|земельн[а-яії]*\s+податок|податк[а-яії]*\s+на\s+земл/i },
  { key: 'single_tax', label: 'єдиний податок',
    caseRe: /єдин[а-яії]*\s+податок|єдиного податку/i,
    claimRe: /єдин[а-яії]*\s+податок|єдиного податку/i },
  { key: 'profit_tax', label: 'податок на прибуток',
    caseRe: /податк[а-яії]*\s+на\s+прибуток/i,
    claimRe: /податк[а-яії]*\s+на\s+прибуток/i },
  { key: 'pit', label: 'ПДФО',
    caseRe: /податк[а-яії]*\s+на\s+доход[а-яії]*\s+фізичн|(?<![а-яіїєґ])пдфо(?![а-яіїєґ])/i,
    claimRe: /податк[а-яії]*\s+на\s+доход[а-яії]*\s+фізичн|(?<![а-яіїєґ])пдфо(?![а-яіїєґ])/i },
];

/** Context window around a citation: biased to follow it (descriptions trail the case
 *  number) with a generous lead-in so short back-references inherit a neighbour's subject. */
function citationContext(text: string, idx: number): string {
  return text.slice(Math.max(0, idx - 350), Math.min(text.length, idx + 400));
}

// --- Outcome guard (CORE-102) -------------------------------------------------
// The answer's statement of a case's OUTCOME (whose cassation appeal, granted or
// denied) must match the decision's operative part. Repro chat-98f8472e: «касаційну
// скаргу ДПС відхилено, ППР скасовано» about a case whose dispositive granted the
// TAXPAYER's appeal in a debt-collection suit. Deterministic and conservative: only
// judged when a dispositive was captured, it rules on ≥1 cassation appeal, and both
// the claimed and actual parties classify confidently.

type PartyClass = 'authority' | 'taxpayer';
type OutcomeDirection = 'granted' | 'denied';

interface AppealRuling { partyText: string; party: PartyClass | null; direction: OutcomeDirection }
interface OutcomeClaim { party: PartyClass | null; direction: OutcomeDirection; raw: string }

// NB: \b is ASCII-only next to Cyrillic (CORE-98) — use explicit lookarounds.
const AUTHORITY_PARTY_RE =
  /(?<![а-яіїєґa-z])(?:гу\s+)?(?:дпс|дфс|дпі)(?![а-яіїєґa-z])|податков|контролююч|митниц|фіскальн/i;
const TAXPAYER_PARTY_RE =
  /особа_\d+|платник|фізичн[а-яіїєґ]*\s+особ|(?<![а-яіїєґa-z])(?:тов|фоп|прат|пат)(?![а-яіїєґa-z])/i;

/** Confident party classification; ambiguous/unknown → null (never judged). */
function classifyParty(s: string): PartyClass | null {
  const a = AUTHORITY_PARTY_RE.test(s);
  const t = TAXPAYER_PARTY_RE.test(s);
  if (a && !t) return 'authority';
  if (t && !a) return 'taxpayer';
  return null;
}

/** Rulings on cassation appeals in a dispositive: «Касаційну скаргу X задовольнити /
 *  залишити без задоволення», «у задоволенні касаційної скарги X відмовити». */
const APPEAL_RULING_RE =
  /касаційн[а-яіїєґ]*\s+скарг[а-яіїєґ]*\s+([^.\n]{0,160}?)\s*[-—–]?\s*(задовольнити|задоволити|залишити\s+без\s+задоволення)/gi;
const APPEAL_DENY_RE =
  /у\s+задоволенні\s+касаційн[а-яіїєґ]*\s+скарг[а-яіїєґ]*\s+([^.\n]{0,160}?)\s*відмовити/gi;

function parseAppealRulings(dispositive: string): AppealRuling[] {
  const out: AppealRuling[] = [];
  let m: RegExpExecArray | null;
  APPEAL_RULING_RE.lastIndex = 0;
  while ((m = APPEAL_RULING_RE.exec(dispositive)) !== null) {
    out.push({
      partyText: m[1].trim(),
      party: classifyParty(m[1]),
      direction: /залишити/i.test(m[2]) ? 'denied' : 'granted',
    });
  }
  APPEAL_DENY_RE.lastIndex = 0;
  while ((m = APPEAL_DENY_RE.exec(dispositive)) !== null) {
    out.push({ partyText: m[1].trim(), party: classifyParty(m[1]), direction: 'denied' });
  }
  return out;
}

/** The answer's outcome assertion near a citation: «касаційну скаргу X задоволено/
 *  відхилено/залишено без задоволення/відмовлено» or the verb-first form. */
const CLAIM_FWD_RE =
  /касаційн[а-яіїєґ]*\s+скарг[а-яіїєґ]*\s+([^,.;:\n]{0,80}?)\s*(?:було\s+)?(задоволен[оаіу]|відхилен[оаіу]|залишен[оаі]\s+без\s+задоволення|відмовлен[оа])/i;
const CLAIM_REV_RE =
  /(відхилив|задовольнив|залишив\s+без\s+задоволення)\s+касаційн[а-яіїєґ]*\s+скарг[а-яіїєґ]*\s+([^,.;:\n]{0,80})/i;

function parseOutcomeClaim(ctx: string): OutcomeClaim | null {
  let m = CLAIM_FWD_RE.exec(ctx);
  if (m) {
    const granted = /задоволен/i.test(m[2]) && !/без/i.test(m[2]);
    return { party: classifyParty(m[1]), direction: granted ? 'granted' : 'denied', raw: m[0].trim() };
  }
  m = CLAIM_REV_RE.exec(ctx);
  if (m) {
    return { party: classifyParty(m[2]), direction: /задовольнив/i.test(m[1]) ? 'granted' : 'denied', raw: m[0].trim() };
  }
  return null;
}

function describeAppeal(a: AppealRuling): string {
  return `касаційну скаргу ${a.partyText} ${a.direction === 'granted' ? 'задоволено' : 'залишено без задоволення'}`;
}

// --- ППР/позов outcome class (CORE-105) ----------------------------------------
// «ППР визнано протиправним / скасовано» ≈ the taxpayer's challenge succeeded.
// Repro chat-e806aa5f: 808/3463/17 cited as «ППР визнано протиправним» while the
// taxpayer finally LOST (appellate court reversed the first instance and denied the
// claim; ВС left that unchanged). The final lawsuit outcome is composed from the
// procedural history (which lives in the HEAD of the decision) plus which court's
// decision the cassation dispositive leaves standing. Scope is deliberately narrow:
// only suits where a taxpayer challenges a ППР — in debt-collection suits (ДПС is
// the plaintiff) the mapping inverts, so they are skipped.

/** True when the suit is a taxpayer challenging a tax notice (ППР) — the only suit
 *  shape where «ППР скасовано» maps cleanly to "claimant won". */
function isTaxpayerPprChallenge(caseText: string): boolean {
  const suit = /позовом\s+([^,]{1,120}?)\s+до\s+([^,]{1,200})/i.exec(caseText);
  if (!suit) return false;
  if (classifyParty(suit[1]) !== 'taxpayer' || classifyParty(suit[2]) !== 'authority') return false;
  return /(?:визнання\s+протиправн|скасування)[^.]{0,150}?повідомлення-рішення/i.test(caseText);
}

/** Outcome of the first-instance decision, from the procedural-history sentence.
 *  NB: sentences contain dotted dates (05.12.2017), so `[^.]*` sentence-bounding
 *  breaks — use a tempered window that must not cross into the appellate sentence. */
function firstInstanceOutcome(caseText: string): OutcomeDirection | null {
  const m =
    /(?:постановою|рішенням)\s+(?:(?!апеляційн)[\s\S]){0,140}?(?:окружного|першої\s+інстанції)(?:(?!апеляційн)[\s\S]){0,160}?(задоволено|відмовлено)/i
      .exec(caseText);
  if (!m) return null;
  return m[1].toLowerCase() === 'задоволено' ? 'granted' : 'denied';
}

/** Outcome after the appellate stage: reversal verdict, 'same' when left unchanged. */
function appellateOutcome(caseText: string): OutcomeDirection | 'same' | null {
  const m = /(?:постановою|ухвалою)\s+(?:(?!постановив)[\s\S]){0,140}?апеляційн/i.exec(caseText);
  if (!m) return null;
  const window = caseText.slice(m.index, m.index + 320);
  if (/залишен[оа]\s+без\s+змін/i.test(window)) return 'same';
  if (/скасовано/i.test(window) && /відмов/i.test(window)) return 'denied';
  if (/скасовано/i.test(window) && /задоволен/i.test(window)) return 'granted';
  return null;
}

/** Final lawsuit outcome = the outcome of whichever decision the cassation
 *  dispositive leaves standing. Remands and unparseable dispositives → null.
 *  Tempered windows (no `скасувати` bridge) keep «постанову апеляційного суду
 *  скасувати, а рішення окружного залишити в силі» from matching the wrong court. */
/** Remand: the cassation sent the case back — no final outcome exists yet. */
function isRemandDispositive(dispositive: string): boolean {
  return /направ[а-яіїєґ]*\s+[\s\S]{0,80}?розгляд/i.test(dispositive);
}

function finalLawsuitOutcome(caseText: string, dispositive: string): OutcomeDirection | null {
  if (isRemandDispositive(dispositive)) return null;   // remand — no final outcome
  const first = firstInstanceOutcome(caseText);
  if (/апеляційн(?:(?!скасувати)[\s\S]){0,200}?залишити\s+без\s+змін/i.test(dispositive)) {
    const app = appellateOutcome(caseText);
    return app === 'same' ? first : app;
  }
  if (/(?:окружного|першої\s+інстанції)(?:(?!скасувати)[\s\S]){0,200}?залишити\s+(?:в\s+силі|без\s+змін)/i.test(dispositive)) {
    return first;
  }
  return null;
}

/** The answer's ППР/позов-outcome assertion near a citation. */
const PPR_GRANTED_CLAIM_RE =
  /(?:ппр|повідомлення-рішення)[^.]{0,80}?(?:скасован|протиправн)|(?:скасован[оа]|скасував|визнан[оа]\s+протиправним|визнав\s+протиправним)[^.]{0,40}?(?:ппр|повідомлення-рішення)/i;
const PPR_DENIED_CLAIM_RE =
  /(?:ппр|повідомлення-рішення)[^.]{0,60}?залишен[оа][^.]{0,15}?(?:в\s+силі|без\s+змін|чинним)|у\s+задоволенні\s+позову\s+відмовлено|позов[а-яіїєґ]*[^.]{0,40}?відмовлен|позов[а-яіїєґ]*\s+залишен[оа]\s+без\s+задоволення/i;
const POZOV_GRANTED_CLAIM_RE = /позов(?:ні\s+вимоги)?[^.]{0,40}?задоволен/i;

function parsePprOutcomeClaim(ctx: string): { direction: OutcomeDirection; raw: string } | null {
  let m = PPR_DENIED_CLAIM_RE.exec(ctx);
  if (m) return { direction: 'denied', raw: m[0].trim() };
  m = PPR_GRANTED_CLAIM_RE.exec(ctx);
  if (m) return { direction: 'granted', raw: m[0].trim() };
  m = POZOV_GRANTED_CLAIM_RE.exec(ctx);
  if (m) return { direction: 'granted', raw: m[0].trim() };
  return null;
}

function describeFinalOutcome(final: OutcomeDirection): string {
  return final === 'granted'
    ? 'остаточно позов платника задоволено'
    : 'остаточно у задоволенні позову платника відмовлено (ППР залишилось чинним)';
}

// --- Quote-grounding (CORE-21 P0.1) -----------------------------------------
// A direct quotation the answer attributes to a court decision must appear,
// verbatim, in that case's captured source text. Cases share the same SUBJECT
// label (all "податок на нерухомість") yet carry fabricated holdings, which the
// subject-matter guard cannot see — but an invented «...» quote is checkable.

/** Minimum inner length for a quote to be worth grounding (skip short generic phrases). */
const MIN_QUOTE_CHARS = 25;
/** Consecutive-word run that counts as grounded when the full quote isn't a verbatim substring (tolerates ellipsis/light edits). */
const GROUND_SHINGLE_WORDS = 6;
/** Quote spans: «...», „..." and straight "..." — capture the inner text. */
const QUOTE_RE = /[«„"]([^«»„"]{15,400})[»"]/g;
/** Attributive cues that mark a quote as the court's statement in THIS case (not a quoted statute). */
const ATTRIBUTION_CUE_RE =
  /(суд|(?<![а-яіїєґ])вс(?![а-яіїєґ])|колегі|зазнач|вказа|дійш|висновк|постанов|рішенн|сформул|правов[аую]\s+позиці|у\s+справ)/i;

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[«»„""'']/g, '').replace(/\s+/g, ' ').trim();
}

/** True if the quote (or a long contiguous word-run of it) appears in the source text. */
function quoteGroundedIn(quoteInner: string, sourceText: string): boolean {
  const q = normalizeForMatch(quoteInner);
  const src = normalizeForMatch(sourceText);
  if (!q || !src) return false;
  if (src.includes(q)) return true;
  const words = q.split(' ').filter(Boolean);
  if (words.length < GROUND_SHINGLE_WORDS) return false;
  for (let i = 0; i + GROUND_SHINGLE_WORDS <= words.length; i++) {
    if (src.includes(words.slice(i, i + GROUND_SHINGLE_WORDS).join(' '))) return true;
  }
  return false;
}

// --- Norm-attribution guard (CORE-103) ----------------------------------------
// «Суд застосував ст. X у справі Y» is attribution-blind in every other gate:
// getUnverifiedArticleDetails only proves the article EXISTS somewhere, never that
// case Y actually applied it (repro chat-98f8472e: «ч. 2 ст. 77 КАС» attributed to
// 200/1185/21 / doc 116616306 whose text never mentions ст. 77). The citation graph
// (legislation_citation_links, 331M edges) makes the check deterministic: if the
// decision has resolved article edges but NONE for the claimed norm, the attribution
// is unsupported. Decisions with no graph edges are never judged (coverage gap ≠ lie).

/** Attribution cue in the lead-in of an article reference: the answer asserts the
 *  court APPLIED/RELIED ON the norm, not merely mentions it. Stems, Cyrillic-safe. */
const NORM_ATTRIBUTION_CUE_RE = /(застосов|застосу|керуючись|на\s+підставі|посилаюч|посила[вє]|послав|послал)/i;

/** How far back from the article reference the attribution cue may sit. */
const NORM_ATTRIBUTION_CUE_WINDOW = 120;

/** Article reference with an EXPLICIT code — attribution needs an addressable norm.
 *  КУпАП/КУПАП before КУ so the longer code wins; trailing-letter lookahead keeps
 *  «ст. 264 касаційний…» from reading «кас» as КАС (\b is ASCII-only, CORE-98). */
const ATTRIBUTED_ARTICLE_RE =
  /ст(?:атт[іяєю])?\.?\s*(\d+(?:\.\d+)*(?:-\d+)?)\s*(ЦПК|ЦК|ГПК|ГК|КПК|КК|ПКУ|КАС|КЗпП|КЗПП|СК|ЗК|МК|КУпАП|КУПАП|КУ)(?![А-ЯІЇЄҐа-яіїєґ])/g;

export interface NormAttributionCandidate {
  /** Case number as cited in the answer. */
  caseNumber: string;
  /** doc_id parsed from the adjacent [num](#doc-ID) link, when present. */
  docId?: number;
  /** Base article number of the claimed norm ("77", "121-1"). */
  articleBase: string;
  /** Canonical code abbreviation as written ("КАС"). */
  code: string;
  /** rada_id of the claimed code (CODE_TO_RADA). */
  radaId: string;
  /** The matched article text, for warning messages ("ст. 77 КАС"). */
  raw: string;
}

export interface NormAttributionMismatch {
  caseNumber: string;
  /** The claimed norm as written in the answer. */
  article: string;
  /** What the decision's citation-graph edges actually show for the claimed code. */
  actual: string;
}

export interface UnverifiedArticle {
  raw: string;
  articleNumber: string;
  radaId: string;
}

function normalizeCaseNumber(n: string): string {
  // Strip the trailing procedural suffix (-ц civil, -а admin, -к criminal, etc.)
  // so a cause_num like "554/5062/13-ц" from search results matches the suffixless
  // "554/5062/13" that CASE_NUMBER_RE extracts from the answer — otherwise real,
  // grounded cases get falsely flagged as fabricated.
  return n.replace(/\s+/g, '').replace(/-[а-яіїєґ]+$/i, '').trim();
}

function normalizeArticleRef(raw: string): string {
  return raw.replace(/\s+/g, '').replace(/\.$/, '').toLowerCase();
}

export class IncrementalAllowSet {
  private caseNumbers = new Set<string>();
  private lawArticles = new Set<string>();
  private searchedRadaIds = new Set<string>();
  /** Per-case context text captured at ingest, for relevance (on-topic) checks. */
  private caseTexts = new Map<string, string>();
  /** Per-case operative part (резолютивна частина), captured at ingest BEFORE the
   *  length cap can cut it off — dispositives sit at the END of a decision (CORE-102). */
  private caseResolutions = new Map<string, string>();

  /** Accumulate any text fields associated with a case number (capped). */
  private addCaseText(caseNum: string, ...vals: any[]): void {
    const norm = normalizeCaseNumber(caseNum);
    const strs = vals.filter((v): v is string => typeof v === 'string' && v.length > 0);
    const text = strs.join(' ');
    if (!text) return;
    // CORE-102: extract the dispositive from each field before capping. Prefer the
    // longest capture (a full text beats a snippet's partial tail).
    for (const v of strs) {
      const disp = extractDispositiveStrict(v)?.trim();
      if (!disp) continue;
      const prevDisp = this.caseResolutions.get(norm);
      if (!prevDisp || disp.length > prevDisp.length) {
        this.caseResolutions.set(norm, disp.slice(0, 3500));
      }
    }
    const prev = this.caseTexts.get(norm) || '';
    const combined = prev + ' ' + text;
    // Head+tail cap (CORE-102): a pure prefix cap discarded the end of long decisions,
    // structurally hiding the operative part from every downstream check.
    this.caseTexts.set(norm, combined.length <= 20000
      ? combined
      : combined.slice(0, 16000) + ' … ' + combined.slice(-4000));
  }

  /** Snapshot counts for logging */
  get stats() {
    return {
      caseNumbers: this.caseNumbers.size,
      lawArticles: this.lawArticles.size,
      searchedRadaIds: this.searchedRadaIds.size,
    };
  }

  /**
   * Ingest a tool result immediately after execution.
   * Extracts case numbers, law articles, and searched rada_ids
   * from structured fields — not from serialized JSON regex scanning.
   */
  ingestToolResult(toolName: string, result: any): void {
    if (!result) return;

    this.extractCaseNumbersFromResult(result);
    this.extractLawArticlesFromResult(toolName, result);
  }

  /**
   * Ingest case numbers from the user's query.
   * Echoing back user-provided numbers is not fabrication.
   */
  ingestUserQuery(query: string): void {
    CASE_NUMBER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CASE_NUMBER_RE.exec(query)) !== null) {
      this.caseNumbers.add(normalizeCaseNumber(m[0]));
    }

    for (const re of [LAW_ARTICLE_RE, SUBPOINT_RE]) {
      re.lastIndex = 0;
      while ((m = re.exec(query)) !== null) {
        const base = m[1].split('.')[0];
        const code = m[2] || '';
        this.lawArticles.add(normalizeArticleRef(base));
        if (code) this.lawArticles.add(normalizeArticleRef(`${base}:${code.toUpperCase()}`));
      }
    }
  }

  /**
   * Ingest case numbers from cumulative decisions (evidence panel).
   */
  ingestDecisions(decisions: Array<{ number?: string; id?: string }>): void {
    for (const d of decisions) {
      if (d.number) this.caseNumbers.add(normalizeCaseNumber(d.number));
    }
  }

  /**
   * Verify the final answer text. Returns fabricated items.
   */
  verify(answerText: string): {
    fabricatedCaseNumbers: string[];
    fabricatedLawArticles: string[];
  } {
    return {
      fabricatedCaseNumbers: this.findFabricatedCaseNumbers(answerText),
      fabricatedLawArticles: this.findFabricatedLawArticles(answerText),
    };
  }

  /**
   * Find cited cases that ARE in the allow-set (real, returned by a tool) but whose
   * captured text shares NONE of the query's topic terms — i.e. real-but-off-topic
   * citations ("fabricated relevance"). This is distinct from fabrication: the case
   * exists, but it doesn't support the proposition it's cited for.
   *
   * Conservative by design: a case is only flagged when we actually captured text
   * for it (e.g. from get_court_decision / search snippets). Cases ingested as a
   * bare number — no context to judge — are never flagged, to avoid false positives.
   * Non-destructive: callers surface this as a citation_warning, not a hard strip.
   */
  findLowRelevanceCitations(answerText: string, queryTerms: string[]): string[] {
    const terms = queryTerms.map(t => t.toLowerCase().trim()).filter(t => t.length >= 4);
    if (!terms.length) return [];
    CASE_NUMBER_RE.lastIndex = 0;
    const seen = new Set<string>();
    const low: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = CASE_NUMBER_RE.exec(answerText)) !== null) {
      const raw = m[0];
      const norm = normalizeCaseNumber(raw);
      if (seen.has(norm)) continue;
      seen.add(norm);
      if (!this.caseNumbers.has(norm)) continue;   // fabricated — handled by verify()
      const text = this.caseTexts.get(norm);
      if (!text) continue;                          // no captured context → cannot judge
      const hay = text.toLowerCase();
      if (!terms.some(t => hay.includes(t))) low.push(raw);
    }
    return low;
  }

  /**
   * Find cited cases the answer characterises as being about a SUBJECT the case's own
   * result text contradicts — e.g. a ПДВ case presented as a податок-на-нерухомість
   * holding (observed in chat-001815fe, where semantic search surfaced topically-adjacent
   * VAT cases that were then mis-cited as Supreme Court property-tax practice).
   *
   * Distinct from fabrication (the case is real) and from low-relevance (here the case is
   * about a CONFLICTING, mutually-exclusive subject, not merely off-topic). Deterministic
   * and conservative: only fires when (a) we captured text for the case, (b) that text
   * positively belongs to a known subject group, and (c) the answer asserts a DIFFERENT
   * group near the citation that the case text neither defines nor mentions. Cases with no
   * captured text, or an unrecognised subject, are never flagged — no false positives from
   * thin snippets. Non-destructive: surfaced as a citation_warning.
   */
  findSubjectMismatchCitations(answerText: string): Array<{ caseNumber: string; claimed: string; actual: string }> {
    CASE_NUMBER_RE.lastIndex = 0;
    const seen = new Set<string>();
    const out: Array<{ caseNumber: string; claimed: string; actual: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = CASE_NUMBER_RE.exec(answerText)) !== null) {
      const raw = m[0];
      const norm = normalizeCaseNumber(raw);
      if (seen.has(norm)) continue;
      seen.add(norm);
      if (!this.caseNumbers.has(norm)) continue;          // fabricated — handled by verify()
      const caseText = this.caseTexts.get(norm);
      if (!caseText) continue;                             // no captured text → cannot judge
      const actual = SUBJECT_GROUPS.filter(g => g.caseRe.test(caseText));
      if (actual.length === 0) continue;                  // case subject unknown → don't judge
      const actualKeys = new Set(actual.map(g => g.key));
      const ctx = citationContext(answerText, m.index);
      // A subject the answer asserts near the citation that the case's own text neither
      // defines (caseRe) nor positively belongs to — i.e. a contradicted characterisation.
      const bad = SUBJECT_GROUPS.find(g =>
        !actualKeys.has(g.key) && g.claimRe.test(ctx) && !g.caseRe.test(caseText));
      if (bad) out.push({ caseNumber: raw, claimed: bad.label, actual: actual.map(g => g.label).join(', ') });
    }
    return out;
  }

  /**
   * CORE-102. Find cited allow-set cases whose stated OUTCOME contradicts the decision's
   * operative part — e.g. «касаційну скаргу ДПС відхилено» when the dispositive granted
   * the TAXPAYER's appeal (repro chat-98f8472e, case 200/1185/21: a debt-collection suit
   * where the answer inverted the appellant AND invented a cancelled ППР).
   *
   * Conservative by design — a case is flagged only when ALL of:
   *  (a) it is in the allow-set (fabricated numbers are handled by verify());
   *  (b) a dispositive was captured at ingest (no operative part → cannot judge);
   *  (c) that dispositive rules on ≥1 cassation appeal;
   *  (d) the answer asserts an appeal outcome near the citation with a confidently
   *      classified party (ДПС/контролюючий орган vs платник/ОСОБА_N);
   *  (e) the claim is contradicted: the same party's appeal went the OTHER way, or the
   *      claimed party had no appeal ruled on at all (only when every actual appellant
   *      classified — an unclassifiable appellant means "cannot be sure", not a flag).
   * Surfaced like the subject gate: strip via unsupportedCitations + citation_warning.
   */
  findOutcomeMismatchCitations(answerText: string): Array<{ caseNumber: string; claimed: string; actual: string }> {
    CASE_NUMBER_RE.lastIndex = 0;
    const seen = new Set<string>();
    const out: Array<{ caseNumber: string; claimed: string; actual: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = CASE_NUMBER_RE.exec(answerText)) !== null) {
      const raw = m[0];
      const norm = normalizeCaseNumber(raw);
      if (seen.has(norm)) continue;
      seen.add(norm);
      if (!this.caseNumbers.has(norm)) continue;          // fabricated — handled by verify()
      const dispositive = this.caseResolutions.get(norm);
      if (!dispositive) continue;                          // no operative part → cannot judge
      const ctx = citationContext(answerText, m.index);
      const claim = parseOutcomeClaim(ctx);
      if (claim && claim.party) {
        // CORE-102: «касаційну скаргу X задоволено/відхилено» vs the dispositive's rulings.
        const appeals = parseAppealRulings(dispositive);
        if (appeals.length === 0) continue;                // no cassation-appeal ruling → cannot judge
        const sameParty = appeals.filter(a => a.party === claim.party);
        let mismatch = false;
        if (sameParty.length > 0) {
          mismatch = !sameParty.some(a => a.direction === claim.direction);
        } else if (appeals.every(a => a.party !== null)) {
          // Every actual appellant classified and none is the claimed party — the answer
          // reports the outcome of an appeal that was never ruled on.
          mismatch = true;
        }
        if (mismatch) {
          out.push({
            caseNumber: raw,
            claimed: claim.raw.slice(0, 120),
            actual: appeals.map(describeAppeal).join('; ').slice(0, 200),
          });
        }
      } else {
        // CORE-105: «ППР скасовано / визнано протиправним», «позов задоволено/відмовлено»
        // vs the FINAL lawsuit outcome. Only in taxpayer-challenges-ППР suits — in
        // debt-collection suits (ДПС is the plaintiff) the mapping inverts, so skip.
        const pprClaim = parsePprOutcomeClaim(ctx);
        if (!pprClaim) continue;
        const caseText = this.caseTexts.get(norm) || '';
        if (!isTaxpayerPprChallenge(caseText)) continue;
        // Remand: the cassation decided nothing final, so ANY definite outcome claim
        // is unsupported (repro chat-5340fe5c: «ВС скасував ППР» about a remanded case).
        if (isRemandDispositive(dispositive)) {
          out.push({
            caseNumber: raw,
            claimed: pprClaim.raw.slice(0, 120),
            actual: 'касаційний суд направив справу на новий розгляд — остаточного рішення по суті спору немає',
          });
          continue;
        }
        const final = finalLawsuitOutcome(caseText, dispositive);
        if (!final) continue;                              // unparseable → cannot judge
        if (final !== pprClaim.direction) {
          out.push({
            caseNumber: raw,
            claimed: pprClaim.raw.slice(0, 120),
            actual: describeFinalOutcome(final),
          });
        }
      }
    }
    return out;
  }

  /**
   * Ambiguous subject-claim candidates for a DB-backed full-text check: cited allow-set
   * cases where the answer asserts a subject near the citation, but the case's CURRENT
   * captured text recognises NO subject group at all (thin/snippet-only) — so
   * findSubjectMismatchCitations cannot yet judge them. Pairs each with the doc_id parsed
   * from an adjacent [num](#doc-ID) link so the caller can fetch the full text and
   * re-evaluate. Cases whose text already shows a subject (supported or conflicting) are
   * excluded — they are handled directly by findSubjectMismatchCitations.
   */
  getSubjectClaimCandidates(answerText: string): Array<{ caseNumber: string; claimedLabel: string; docId?: number }> {
    CASE_NUMBER_RE.lastIndex = 0;
    const seen = new Set<string>();
    const out: Array<{ caseNumber: string; claimedLabel: string; docId?: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = CASE_NUMBER_RE.exec(answerText)) !== null) {
      const raw = m[0];
      const norm = normalizeCaseNumber(raw);
      if (seen.has(norm)) continue;
      seen.add(norm);
      if (!this.caseNumbers.has(norm)) continue;
      const caseText = this.caseTexts.get(norm) || '';
      if (SUBJECT_GROUPS.some(g => g.caseRe.test(caseText))) continue;   // subject already known
      const ctx = citationContext(answerText, m.index);
      const claimed = SUBJECT_GROUPS.find(g => g.claimRe.test(ctx));
      if (!claimed) continue;                                            // no subject asserted
      const link = answerText.slice(m.index, m.index + 80).match(/#doc-(\d+)/);
      out.push({ caseNumber: raw, claimedLabel: claimed.label, docId: link ? Number(link[1]) : undefined });
    }
    return out;
  }

  /**
   * CORE-103. Norm-attribution candidates: cited allow-set cases where the answer
   * asserts the court APPLIED a specific norm (attribution cue + «ст. N КОДЕКС» in the
   * citation window), paired with the doc_id from the adjacent [num](#doc-ID) link so
   * the caller can check the claim against the decision's citation-graph edges.
   *
   * Skipped by design:
   *  - dotted numbers (пп. 38.6 / п. 69.22 перехідних положень ПКУ) — absent from the
   *    graph as a class (0 dotted targets on 331M edges), so they can never be judged;
   *  - article references inside the appended BURDEN_OF_PROOF_SECTION (CORE-97) — that
   *    text cites ст. 77 КАС as a general rule, attributed to no case;
   *  - references with no attribution cue in the lead-in — a bare mention next to a
   *    case citation is not an attribution claim.
   */
  getNormAttributionCandidates(answerText: string): NormAttributionCandidate[] {
    // Exempt the deterministic burden-of-proof appendix (it is registered, not cited).
    const burdenStart = answerText.indexOf(BURDEN_OF_PROOF_SECTION.slice(0, 60));
    const burdenEnd = burdenStart >= 0 ? burdenStart + BURDEN_OF_PROOF_SECTION.length : -1;

    CASE_NUMBER_RE.lastIndex = 0;
    const seen = new Set<string>();
    const out: NormAttributionCandidate[] = [];
    let m: RegExpExecArray | null;
    while ((m = CASE_NUMBER_RE.exec(answerText)) !== null) {
      const rawCase = m[0];
      const norm = normalizeCaseNumber(rawCase);
      if (!this.caseNumbers.has(norm)) continue;           // fabricated — handled by verify()
      const ctxStart = Math.max(0, m.index - 350);
      const ctx = citationContext(answerText, m.index);
      const link = answerText.slice(m.index, m.index + 80).match(/#doc-(\d+)/);
      const docId = link ? Number(link[1]) : undefined;

      ATTRIBUTED_ARTICLE_RE.lastIndex = 0;
      let a: RegExpExecArray | null;
      while ((a = ATTRIBUTED_ARTICLE_RE.exec(ctx)) !== null) {
        const globalIdx = ctxStart + a.index;
        if (burdenStart >= 0 && globalIdx >= burdenStart && globalIdx < burdenEnd) continue;
        const num = a[1];
        if (num.includes('.')) continue;                   // dotted norms not in graph — cannot judge
        const code = a[2].toUpperCase() === 'КУПАП' ? 'КУпАП' : a[2];
        const radaId = CODE_TO_RADA[code];
        if (!radaId) continue;
        const leadIn = ctx.slice(Math.max(0, a.index - NORM_ATTRIBUTION_CUE_WINDOW), a.index);
        if (!NORM_ATTRIBUTION_CUE_RE.test(leadIn)) continue;
        const key = `${norm}|${num}|${radaId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ caseNumber: rawCase, docId, articleBase: num, code, radaId, raw: a[0].trim() });
      }
    }
    return out;
  }

  /**
   * CORE-21 P0.1 (quote-or-drop). Find cited allow-set cases that carry a DIRECT
   * QUOTATION the answer attributes to the court, where that quote is NOT present in
   * the case's captured source text — i.e. an invented holding dressed as a verbatim
   * citation. Catches what the subject-matter guard cannot: all three repro cases
   * (chat-b8a0b5fb: 820/6918/16, 2040/7125/18, 520/35740/24) share the SAME subject
   * label ("податок на нерухомість") but were given fabricated occupied-territory /
   * ДРРП holdings.
   *
   * Conservative by design — a case is flagged only when ALL of:
   *  (a) it is in the allow-set (real; fabricated numbers are handled by verify());
   *  (b) we captured source text for it (no captured text → cannot judge);
   *  (c) a quote of meaningful length sits near the citation AND is attributed to the
   *      court (cue word or the case number in the lead-in) — so a quoted statute next
   *      to a case link is not mistaken for the case's holding;
   *  (d) none of the case's attributed quotes are grounded in its source text.
   * Paraphrased (quote-less) citations are never flagged — no false positives. The
   * caller surfaces this as a citation_warning, not a hard strip.
   */
  findUngroundedQuotedCitations(answerText: string): Array<{ caseNumber: string; quote: string }> {
    CASE_NUMBER_RE.lastIndex = 0;
    const seen = new Set<string>();
    const out: Array<{ caseNumber: string; quote: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = CASE_NUMBER_RE.exec(answerText)) !== null) {
      const raw = m[0];
      const norm = normalizeCaseNumber(raw);
      if (seen.has(norm)) continue;
      seen.add(norm);
      if (!this.caseNumbers.has(norm)) continue;     // fabricated — handled by verify()
      const caseText = this.caseTexts.get(norm);
      if (!caseText) continue;                        // no captured text → cannot judge

      const ctx = citationContext(answerText, m.index);
      let attributedQuotes = 0;
      let firstUngrounded = '';
      QUOTE_RE.lastIndex = 0;
      let q: RegExpExecArray | null;
      while ((q = QUOTE_RE.exec(ctx)) !== null) {
        const inner = q[1];
        if (normalizeForMatch(inner).length < MIN_QUOTE_CHARS) continue;
        const leadIn = ctx.slice(Math.max(0, q.index - 140), q.index);
        const attributed = leadIn.includes(raw) || ATTRIBUTION_CUE_RE.test(leadIn);
        if (!attributed) continue;                    // quoted statute / aside, not this case's holding
        attributedQuotes++;
        if (quoteGroundedIn(inner, caseText)) { firstUngrounded = ''; break; } // a grounded quote clears the case
        if (!firstUngrounded) firstUngrounded = inner.trim();
      }
      if (attributedQuotes > 0 && firstUngrounded) {
        out.push({ caseNumber: raw, quote: firstUngrounded.slice(0, 160) });
      }
    }
    return out;
  }

  /**
   * CORE-21 P0.2. Collect, for each DISTINCT cited allow-set case we captured text for,
   * the answer's characterisation of it (citation context) paired with the case's own
   * source text — the inputs for an LLM claim↔source check. Complements the deterministic
   * gates: quote-grounding needs an explicit «...» quote and subject-matter works at the
   * label level; this surfaces a PARAPHRASED holding with no basis in the source (the
   * actual repro failure mode). Cases with no captured text are skipped (cannot judge).
   * Capped to bound verifier cost.
   */
  getCitedCaseClaims(
    answerText: string,
    opts: { maxCases?: number; maxSourceChars?: number; maxClaimChars?: number } = {},
  ): Array<{ caseNumber: string; claim: string; source: string }> {
    const maxCases = opts.maxCases ?? 8;
    const maxSourceChars = opts.maxSourceChars ?? 4000;
    const maxClaimChars = opts.maxClaimChars ?? 700;
    CASE_NUMBER_RE.lastIndex = 0;
    const seen = new Set<string>();
    const out: Array<{ caseNumber: string; claim: string; source: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = CASE_NUMBER_RE.exec(answerText)) !== null) {
      if (out.length >= maxCases) break;
      const raw = m[0];
      const norm = normalizeCaseNumber(raw);
      if (seen.has(norm)) continue;
      seen.add(norm);
      if (!this.caseNumbers.has(norm)) continue;     // fabricated — handled by verify()
      const source = this.caseTexts.get(norm);
      if (!source) continue;                          // no captured text → cannot judge
      const claim = citationContext(answerText, m.index).replace(/\s+/g, ' ').trim();
      // CORE-102: the dispositive sits at the END of a decision — a prefix slice
      // structurally hid it from the judge, so outcome mischaracterisations could never
      // be found "unsupported". Feed head + operative part (or head+tail as fallback).
      let src: string;
      if (source.length <= maxSourceChars) {
        src = source;
      } else {
        const resolution = this.caseResolutions.get(norm);
        const headBudget = Math.max(1000, maxSourceChars - 1500);
        src = resolution
          ? source.slice(0, headBudget) + '\n…\n[РЕЗОЛЮТИВНА ЧАСТИНА] ' + resolution.slice(0, 1400)
          : source.slice(0, headBudget) + '\n…\n' + source.slice(-1400);
      }
      out.push({ caseNumber: raw, claim: claim.slice(0, maxClaimChars), source: src });
    }
    return out;
  }

  /** Allowed case numbers set (for backward compat / testing). */
  get allowedCaseNumbers(): ReadonlySet<string> {
    return this.caseNumbers;
  }

  /** Allowed law articles set (for backward compat / testing). */
  get allowedLawArticles(): ReadonlySet<string> {
    return this.lawArticles;
  }

  /** Searched rada IDs (for backward compat / testing). */
  get allowedRadaIds(): ReadonlySet<string> {
    return this.searchedRadaIds;
  }

  // ---------------------------------------------------------------------------
  // Private: extraction from structured tool results
  // ---------------------------------------------------------------------------

  private extractCaseNumbersFromResult(result: any): void {
    // Structured decisions array (from court tools)
    if (result.decisions && Array.isArray(result.decisions)) {
      for (const d of result.decisions) {
        const num = d.number || d.cause_num || d.case_number;
        if (num) {
          this.caseNumbers.add(normalizeCaseNumber(num));
          this.addCaseText(num, d.text, d.full_text, d.snippet, d.summary, d.resolution, d.holding, d.excerpt, d.title, d.headline);
        }
      }
    }

    // MCP content wrapper
    if (result.content && Array.isArray(result.content)) {
      for (const block of result.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          this.extractCaseNumbersFromText(block.text);
        }
      }
    }

    // Results array (search results)
    if (result.results && Array.isArray(result.results)) {
      for (const r of result.results) {
        const num = r.cause_num || r.case_number;
        if (num) {
          this.caseNumbers.add(normalizeCaseNumber(num));
          // Capture the snippet/chunk text that search modes return (headline, FTS/Qdrant
          // chunk, key_sections) — not just the *_text fields — so subject/relevance checks
          // have the only text we hold for cases that were never fetched in full.
          this.addCaseText(num, r.text, r.full_text, r.snippet, r.summary, r.resolution, r.holding, r.excerpt, r.title,
            r.headline, r.fts_headline, r.qdrant_best_chunk_text,
            r.key_sections && typeof r.key_sections === 'object'
              ? Object.values(r.key_sections).filter((v: any) => typeof v === 'string').join(' ')
              : undefined);
        }
      }
    }

    // Grouped documents (case chain)
    if (result.grouped_documents && typeof result.grouped_documents === 'object') {
      for (const docs of Object.values(result.grouped_documents)) {
        if (Array.isArray(docs)) {
          for (const d of docs as any[]) {
            if (d.cause_num || d.case_number) {
              this.caseNumbers.add(normalizeCaseNumber(d.cause_num || d.case_number));
            }
          }
        }
      }
    }

    // Single case_number field (e.g. get_court_decision — returns full text)
    if (result.case_number) {
      this.caseNumbers.add(normalizeCaseNumber(result.case_number));
      this.addCaseText(result.case_number, result.text, result.full_text, result.fulltext,
        result.snippet, result.summary, result.resolution, result.holding, result.title);
    }

    // Full text fields — case numbers mentioned in document body are valid sources
    for (const field of ['full_text', 'text', 'doc_text', 'document_text']) {
      if (typeof result[field] === 'string' && result[field].length > 0) {
        CASE_NUMBER_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = CASE_NUMBER_RE.exec(result[field])) !== null) {
          this.caseNumbers.add(normalizeCaseNumber(m[0]));
        }
      }
    }

    // Nested: decisions/results may also carry full text
    const arrays = [result.decisions, result.results];
    for (const arr of arrays) {
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        for (const field of ['full_text', 'text', 'doc_text']) {
          if (typeof item[field] === 'string' && item[field].length > 0) {
            CASE_NUMBER_RE.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = CASE_NUMBER_RE.exec(item[field])) !== null) {
              this.caseNumbers.add(normalizeCaseNumber(m[0]));
            }
          }
        }
      }
    }
  }

  private extractCaseNumbersFromText(text: string): void {
    try {
      const parsed = JSON.parse(text);
      this.extractCaseNumbersFromResult(parsed);
    } catch {
      // Not JSON — scan as raw text
      CASE_NUMBER_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = CASE_NUMBER_RE.exec(text)) !== null) {
        this.caseNumbers.add(normalizeCaseNumber(m[0]));
      }
    }
  }

  private extractLawArticlesFromResult(toolName: string, result: any): void {
    // Legislation tools return structured article data
    if (toolName.includes('legislation') || toolName.includes('law') || toolName.includes('relevant')) {
      this.extractArticlesFromStructured(result);
    }

    // MCP content wrapper
    if (result.content && Array.isArray(result.content)) {
      for (const block of result.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          try {
            const parsed = JSON.parse(block.text);
            this.extractArticlesFromStructured(parsed);
          } catch {
            // not JSON
          }
        }
      }
    }
  }

  private extractArticlesFromStructured(obj: any): void {
    if (!obj || typeof obj !== 'object') return;

    // Direct article_number field
    if (obj.article_number) {
      const base = String(obj.article_number).split('.')[0];
      this.lawArticles.add(normalizeArticleRef(base));
    }

    // rada_id field → track which codes were searched
    if (obj.rada_id) {
      this.searchedRadaIds.add(String(obj.rada_id));
    }

    // Results array
    if (Array.isArray(obj.results)) {
      for (const r of obj.results) {
        if (r.article_number) {
          const base = String(r.article_number).split('.')[0];
          this.lawArticles.add(normalizeArticleRef(base));
          if (r.code) {
            this.lawArticles.add(normalizeArticleRef(`${base}:${r.code.toUpperCase()}`));
          }
        }
        if (r.rada_id) this.searchedRadaIds.add(String(r.rada_id));
      }
    }

    // Articles array
    if (Array.isArray(obj.articles)) {
      for (const a of obj.articles) {
        if (a.number || a.article_number) {
          const num = String(a.number || a.article_number).split('.')[0];
          this.lawArticles.add(normalizeArticleRef(num));
        }
      }
    }

    // Scan article text for cross-references — when retrieved Article 258 ЦК
    // mentions "ст. 362 ЦК", that's a legitimate citation from the source, not
    // a hallucination. Add all article refs found in retrieved text to the allow-set.
    this.extractCrossRefsFromText(obj);
    if (Array.isArray(obj.results)) {
      for (const r of obj.results) this.extractCrossRefsFromText(r);
    }
    if (Array.isArray(obj.articles)) {
      for (const a of obj.articles) this.extractCrossRefsFromText(a);
    }
  }

  private extractCrossRefsFromText(obj: any): void {
    const text = obj?.full_text || obj?.text || '';
    if (!text || typeof text !== 'string') return;
    for (const re of [LAW_ARTICLE_RE, SUBPOINT_RE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const base = m[1].split('.')[0];
        const code = m[2] || '';
        this.lawArticles.add(normalizeArticleRef(base));
        if (code) this.lawArticles.add(normalizeArticleRef(`${base}:${code.toUpperCase()}`));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private: verification against accumulated sets
  // ---------------------------------------------------------------------------

  private findFabricatedCaseNumbers(answerText: string): string[] {
    CASE_NUMBER_RE.lastIndex = 0;
    const seen = new Set<string>();
    const fabricated: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = CASE_NUMBER_RE.exec(answerText)) !== null) {
      const raw = m[0];
      const norm = normalizeCaseNumber(raw);
      if (seen.has(norm)) continue;
      seen.add(norm);
      if (!this.caseNumbers.has(norm)) fabricated.push(raw);
    }
    return fabricated;
  }

  /**
   * Returns structured details for unverified articles so callers can
   * look them up in the DB before emitting warnings.
   */
  getUnverifiedArticleDetails(answerText: string): UnverifiedArticle[] {
    const seen = new Set<string>();
    const result: UnverifiedArticle[] = [];

    for (const re of [LAW_ARTICLE_RE, SUBPOINT_RE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(answerText)) !== null) {
        const num = m[1];
        const code = m[2] || '';
        const raw = m[0].trim();
        const baseArticle = num.split('.')[0];

        if (!code) continue;
        const radaId = CODE_TO_RADA[code.toUpperCase()];
        if (!radaId) continue;
        // For КУпАП, count the article as searched if EITHER half was searched.
        if (!relatedRadaIds(radaId).some((id) => this.searchedRadaIds.has(id))) continue;

        const norm = normalizeArticleRef(`${baseArticle}:${code.toUpperCase()}`);
        if (seen.has(norm)) continue;
        seen.add(norm);
        if (!this.lawArticles.has(norm) && !this.lawArticles.has(normalizeArticleRef(baseArticle))) {
          result.push({ raw, articleNumber: num, radaId });
        }
      }
    }
    return result;
  }

  /**
   * Add verified articles to the allow-set (after DB lookup confirms they exist).
   */
  addVerifiedArticles(articles: Array<{ articleNumber: string; radaId?: string }>): void {
    for (const a of articles) {
      const base = a.articleNumber.split('.')[0];
      this.lawArticles.add(normalizeArticleRef(base));
      if (a.radaId) {
        const code = codeForRadaId(a.radaId);
        if (code) this.lawArticles.add(normalizeArticleRef(`${base}:${code}`));
      }
    }
  }

  private findFabricatedLawArticles(answerText: string): string[] {
    return this.getUnverifiedArticleDetails(answerText).map(a => a.raw);
  }
}

/**
 * Extract confirmed article numbers from a get_legislation_articles tool result.
 * The tool returns {articles: [{article_number, ...}]}; older callers may see
 * {results: [...]} — accept both. Returns base article numbers ("4.1.3" → "4").
 */
export function extractVerifiedArticleNumbers(content: unknown): string[] {
  const verified: string[] = [];
  if (!Array.isArray(content)) return verified;
  for (const block of content) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    try {
      const parsed = JSON.parse(block.text);
      const found = Array.isArray(parsed.articles) ? parsed.articles
        : Array.isArray(parsed.results) ? parsed.results : [];
      for (const r of found) {
        if (r?.article_number) verified.push(String(r.article_number).split('.')[0]);
      }
    } catch { /* not JSON */ }
  }
  return verified;
}

/**
 * Verify "unverified" law articles against the legislation DB before warning.
 * The LLM often cites valid articles from training data that simply weren't
 * in this turn's search results — look them up via get_legislation_articles,
 * add confirmed ones to the allow-set, and return the remaining (truly
 * unverifiable) article references.
 */
export async function verifyArticlesAgainstDb(
  allowSet: IncrementalAllowSet,
  answerText: string,
  executeTool: (name: string, args: Record<string, unknown>) => Promise<any>
): Promise<string[]> {
  const unverifiedDetails = allowSet.getUnverifiedArticleDetails(answerText);
  if (unverifiedDetails.length === 0) {
    return allowSet.verify(answerText).fabricatedLawArticles;
  }

  const byRadaId = new Map<string, string[]>();
  for (const u of unverifiedDetails) {
    const arr = byRadaId.get(u.radaId) || [];
    arr.push(u.articleNumber);
    byRadaId.set(u.radaId, arr);
  }

  const verified: string[] = [];
  for (const [radaId, articleNumbers] of byRadaId) {
    try {
      const result = await executeTool('get_legislation_articles', {
        rada_id: radaId,
        article_numbers: [...new Set(articleNumbers.map(n => n.split('.')[0]))],
      });
      verified.push(...extractVerifiedArticleNumbers(result?.content));
    } catch (err: any) {
      logger.warn('[IncrementalAllowSet] Article verification lookup failed', {
        radaId, articleNumbers, error: err.message,
      });
    }
  }

  if (verified.length > 0) {
    allowSet.addVerifiedArticles(verified.map(n => ({ articleNumber: n })));
  }
  return allowSet.verify(answerText).fabricatedLawArticles;
}

/** Cap on full-text fetches per answer — bounds cost in the verify hot path. */
const MAX_SUBJECT_FETCHES = 6;

/**
 * DB-backed subject check. findSubjectMismatchCitations is snippet-bound: a case whose only
 * captured text is a thin search snippet may show no subject marker, so a mischaracterisation
 * can't be judged. For those ambiguous-but-doc-linked cases this fetches the full decision
 * (get_court_decision by the doc_id parsed from the answer's [num](#doc-ID) link), feeds it
 * back through ingestToolResult to enrich caseTexts, then re-runs the deterministic check —
 * which now sees the full text and confirms or clears the mismatch. Mirrors
 * verifyArticlesAgainstDb. Fail-open and capped; returns the (possibly enriched) mismatches.
 */
export async function verifyCaseSubjectsAgainstDb(
  allowSet: IncrementalAllowSet,
  answerText: string,
  executeTool: (name: string, args: Record<string, unknown>) => Promise<any>
): Promise<Array<{ caseNumber: string; claimed: string; actual: string }>> {
  const candidates = allowSet.getSubjectClaimCandidates(answerText).filter(c => c.docId);
  if (candidates.length === 0) return allowSet.findSubjectMismatchCitations(answerText);

  let fetched = 0;
  for (const c of candidates) {
    if (fetched >= MAX_SUBJECT_FETCHES) {
      logger.warn('[IncrementalAllowSet] Subject full-text checks capped', {
        cap: MAX_SUBJECT_FETCHES, pending: candidates.length - fetched,
      });
      break;
    }
    try {
      const result = await executeTool('get_court_decision', { doc_id: c.docId, depth: 0 });
      allowSet.ingestToolResult('get_court_decision', result);   // enriches caseTexts with full_text
      fetched++;
    } catch (err: any) {
      logger.warn('[IncrementalAllowSet] Case subject lookup failed', {
        docId: c.docId, caseNumber: c.caseNumber, error: err.message,
      });
    }
  }
  return allowSet.findSubjectMismatchCitations(answerText);
}

/** Cap on citation-graph lookups per answer — one cheap indexed query per doc. */
const MAX_NORM_ATTRIBUTION_FETCHES = 6;

/** Parse the first JSON text block of a tool result (wrapResponse format). */
function parseToolJson(result: any): any | null {
  const blocks = result?.content;
  if (!Array.isArray(blocks)) return null;
  for (const b of blocks) {
    if (b?.type === 'text' && typeof b.text === 'string') {
      try { return JSON.parse(b.text); } catch { /* not JSON */ }
    }
  }
  return null;
}

/**
 * CORE-103. Check norm-attribution claims («суд застосував ст. X у справі Y») against
 * the decision's citation-graph edges (get_decision_cited_norms → resolved rows of
 * legislation_citation_links, grouped to base articles).
 *
 * Flag rule (anti-false-positive, per ticket): a claim is a mismatch ONLY when the
 * decision HAS resolved article edges in the graph, yet none of them is the claimed
 * norm. A decision with no edges is a coverage gap — never judged. Everything is
 * fail-open: lookup errors, unparseable results and uncapped candidates are skipped.
 * Callers surface mismatches as a citation_warning (warn-only start, CORE-103 §4).
 */
export async function verifyNormAttributionsAgainstGraph(
  allowSet: IncrementalAllowSet,
  answerText: string,
  executeTool: (name: string, args: Record<string, unknown>) => Promise<any>
): Promise<NormAttributionMismatch[]> {
  const candidates = allowSet.getNormAttributionCandidates(answerText).filter(c => c.docId);
  if (candidates.length === 0) return [];

  const byDoc = new Map<number, NormAttributionCandidate[]>();
  for (const c of candidates) {
    const arr = byDoc.get(c.docId!) || [];
    arr.push(c);
    byDoc.set(c.docId!, arr);
  }

  const out: NormAttributionMismatch[] = [];
  let fetched = 0;
  for (const [docId, docCandidates] of byDoc) {
    if (fetched >= MAX_NORM_ATTRIBUTION_FETCHES) {
      logger.warn('[IncrementalAllowSet] Norm-attribution checks capped', {
        cap: MAX_NORM_ATTRIBUTION_FETCHES, pending: byDoc.size - fetched,
      });
      break;
    }
    fetched++;
    let parsed: any;
    try {
      parsed = parseToolJson(await executeTool('get_decision_cited_norms', { doc_id: docId }));
    } catch (err: any) {
      logger.warn('[IncrementalAllowSet] Norm-attribution lookup failed', {
        docId, error: err.message,
      });
      continue;
    }
    const norms: Array<{ rada_id?: string; article_base?: string }> =
      Array.isArray(parsed?.norms) ? parsed.norms : [];
    // No resolved edges → coverage gap, not evidence of absence. Never judge.
    if (!parsed || !(parsed.total_resolved_links > 0) || norms.length === 0) continue;

    const edges = new Set(
      norms
        .filter(n => n.rada_id && n.article_base)
        .map(n => `${String(n.rada_id).toLowerCase()}:${String(n.article_base)}`)
    );
    for (const c of docCandidates) {
      const claimedIds = relatedRadaIds(c.radaId).map(id => id.toLowerCase());
      if (claimedIds.some(id => edges.has(`${id}:${c.articleBase}`))) continue;   // supported
      const sameLaw = norms.filter(
        n => n.rada_id && claimedIds.includes(String(n.rada_id).toLowerCase()) && n.article_base
      );
      const actual = sameLaw.length > 0
        ? `рішення посилається на ${c.code}: ст. ${[...new Set(sameLaw.map(n => String(n.article_base)))].slice(0, 8).join(', ст. ')}`
        : `рішення не посилається на жодну статтю ${c.code}`;
      out.push({ caseNumber: c.caseNumber, article: c.raw, actual });
    }
  }
  return out;
}

// ============================
// Chain-attribution gate (CORE-108)
// ============================

export interface ChainAttributionMismatch {
  /** Case number of the «Справа № X» section the row appears under. */
  sectionCase: string;
  /** Case number written in the offending citation link. */
  citedCase: string;
  /** doc_id parsed from the citation's #doc-ID anchor. */
  docId: number;
}

/** Section header introducing a per-case block: «### Справа № 910/1138/19». */
const CASE_SECTION_RE = /^\s*(?:#{1,6}|\*\*)\s*справа\s*№?\s*(\d+\/\d+\/\d{2,4}(?:-[а-яіїєґ])?)/i;
/** Instance-chain row: a table row or bold label STARTING with an instance name.
 *  Prose that merely mentions «касаційна інстанція» mid-sentence must not match —
 *  citing analogous practice from other cases inside a section is legitimate. */
const CHAIN_ROW_RE = /^\s*(?:\|\s*)?(?:\*\*)?\s*(?:перша\s+інстанція|апеляція|касація)/i;
/** Citation link whose text is a case number: [910/14863/22](#doc-123226305). */
const CASE_CITATION_LINK_RE = /\[(\d+\/\d+\/\d{2,4}(?:-[а-яіїєґ])?)\]\(#doc-(\d+)\)/gi;

/**
 * Deterministic, text-only check: inside a «Справа № X» section, an instance-chain
 * row (Перша інстанція / Апеляція / Касація) must cite documents of case X — a
 * citation link carrying a DIFFERENT case number means a foreign decision was
 * spliced into the chain (repro chat-ae921608: the cassation ruling of 910/14863/22
 * presented as the cassation stage of 910/1138/19). Warn-only by design: the link
 * text itself declares the true case number, so the reader can see the source.
 */
export function findChainAttributionMismatches(answerText: string): ChainAttributionMismatch[] {
  const out: ChainAttributionMismatch[] = [];
  let sectionCase: string | null = null;
  for (const line of answerText.split('\n')) {
    const header = line.match(CASE_SECTION_RE);
    if (header) {
      sectionCase = header[1];
      continue;
    }
    if (!sectionCase || !CHAIN_ROW_RE.test(line)) continue;
    CASE_CITATION_LINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CASE_CITATION_LINK_RE.exec(line)) !== null) {
      if (normalizeCaseNumber(m[1]) === normalizeCaseNumber(sectionCase)) continue;
      out.push({ sectionCase, citedCase: m[1], docId: Number(m[2]) });
    }
  }
  return out;
}
