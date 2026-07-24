/**
 * Required-norm enforcement (CORE-97).
 *
 * Some dispute categories have a norm that MUST be present for the answer to be
 * professionally complete, yet the model includes it only intermittently — prompt
 * instructions alone don't make it reliable. This module enforces such norms
 * deterministically in code, after synthesis and before the answer is emitted.
 *
 * First case: challenges to податкові повідомлення-рішення (ППР). The winning
 * procedural lever is ч. 2 ст. 77 КАС України — the tax authority, not the
 * taxpayer, bears the burden of proving the assessment lawful. Repro:
 * chat-30dbd56a / chat-face9993 — two consecutive gold-standard runs omitted it.
 */

// NB: \w and \b are ASCII-only in JS regexes — they do not match/anchor Cyrillic.
// Use explicit letter classes instead.
const UA = 'а-яіїєґА-ЯІЇЄҐ';

/** The answer/query concerns a tax assessment (ППР / податкові нарахування). */
const TAX_ASSESSMENT_RE = new RegExp(
  `податков[${UA}]*\\s+повідомлення-рішення|(?:^|[^${UA}])ППР(?![${UA}])|податков[${UA}]*\\s+нарахуванн|нарахуванн[${UA}]*\\s+податк`,
  'i'
);

/** ...and that assessment is being (or may be) challenged. */
const CHALLENGE_RE = new RegExp(
  `оскарж|скасуванн|скасув|протиправн|неправомірн|адміністративн[${UA}]*\\s+(?:суд|позов)`,
  'i'
);

/** The burden-of-proof norm is already cited ("77" within reach of КАС in any spelling). */
const ART_77_KAS_RE =
  /\b77\b[^\n]{0,60}(?:КАС|Кодексу?\s+адміністративного\s+судочинства)/i;

/** Appended verbatim; ст. 77 КАС must also be registered in the citation allow-set
 *  by the caller (allowSet.ingestUserQuery('ст. 77 КАС')) so verify() won't strip it. */
export const BURDEN_OF_PROOF_SECTION =
  "**Тягар доведення (ч. 2 ст. 77 КАС України).** В адміністративних справах про " +
  "протиправність рішень суб'єкта владних повноважень обов'язок щодо доказування " +
  "правомірності свого рішення покладається на відповідача. Це означає, що саме " +
  "контролюючий орган (ДПС) має довести в суді правомірність податкового " +
  "повідомлення-рішення — платник податків не зобов'язаний доводити його " +
  "протиправність. Використовуйте це процесуальне правило при оскарженні ППР, " +
  "особливо якщо доступ до об'єкта чи доказів обмежений.";

export interface RequiredNormResult {
  text: string;
  appended: boolean;
}

/**
 * If the query+answer concern a challenge to a tax assessment (ППР) and the answer
 * does not cite ст. 77 КАС, append the burden-of-proof section. Detection is
 * conservative: both the assessment marker AND the challenge marker must be present
 * across query+answer, so plain rate/calculation questions are never touched.
 */
export function ensureBurdenOfProofNorm(query: string, answerText: string): RequiredNormResult {
  if (!answerText) return { text: answerText, appended: false };

  const haystack = `${query}\n${answerText}`;
  if (!TAX_ASSESSMENT_RE.test(haystack)) return { text: answerText, appended: false };
  if (!CHALLENGE_RE.test(haystack)) return { text: answerText, appended: false };
  if (ART_77_KAS_RE.test(answerText)) return { text: answerText, appended: false };

  return { text: `${answerText}\n\n${BURDEN_OF_PROOF_SECTION}`, appended: true };
}
