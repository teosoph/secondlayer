/**
 * Shepardization outcome extraction — pure helpers, no service dependencies.
 *
 * Extracted from shepardization-service.ts (CORE-95) so they can be unit-tested:
 * the service module imports mcp_backend overlay files that do not resolve in a
 * standalone checkout.
 *
 * CORE-95 fixes:
 * 1. extractDispositive now slices AFTER the matched ruling header — previously
 *    the header stayed in the text and lowercased "постановив" (contains "нов")
 *    made the remand branch fire for every dispositive containing "скасув".
 * 2. Added reinstatement pattern ("залишити/залишено в силі" → upheld): a final
 *    cassation decision reinstating the lower-court decision means the case's
 *    controlling position stands — it is NOT overruled.
 * 3. Remand branch now requires "направ" + "розгляд" (not the loose "нов" that
 *    matched words like "установ…" or "ухвалити нове рішення").
 */

export interface OutcomeInfo {
  outcome: string;
  effect: 'upheld' | 'modified' | 'overruled' | 'remanded' | 'closed';
}

/**
 * Isolate the operative (dispositive) part of a decision so that outcome keywords are
 * matched against the court's actual ruling, not the narrative or quoted lower-court
 * decisions. Cuts AFTER the LAST ruling header ("ПОСТАНОВИВ/ПОСТАНОВИЛА/УХВАЛИВ/УХВАЛИЛА/
 * ВИРІШИВ", tolerating spaced-out letters like "П О С Т А Н О В И Л А") — the header
 * itself is excluded so its letters can't be mistaken for outcome keywords; falls back
 * to the tail of the text when no header is found.
 */
export function extractDispositive(text?: string | null): string | null {
  if (!text) return null;
  return extractDispositiveStrict(text) ?? text.slice(-1800);
}

/**
 * Strict variant (CORE-102): returns the dispositive ONLY when an explicit ruling
 * header is present — null otherwise, with no tail fallback. The outcome guard must
 * never mistake narrative text for the court's ruling, so absence of a header means
 * "cannot judge", not "use the tail".
 */
export function extractDispositiveStrict(text?: string | null): string | null {
  if (!text) return null;
  // Require the trailing colon so the ruling header ("ПОСТАНОВИВ:", "П О С Т А Н О В И Л А:",
  // "УХВАЛИВ:", "ВИРІШИВ:") is matched but the genitive noun "постанови …" is not.
  const marker =
    /(?:п\s*о\s*с\s*т\s*а\s*н\s*о\s*в\s*и\s*(?:в|л\s*а)|у\s*х\s*в\s*а\s*л\s*и\s*(?:в|л\s*а)|в\s*и\s*р\s*і\s*ш\s*и\s*(?:в|л\s*а))\s*:/gi;
  let last = -1;
  let m: RegExpExecArray | null;
  // Track the END of the last header match: the header text must not leak into the
  // returned dispositive (lowercased "постановив" contains "нов" — see CORE-95).
  while ((m = marker.exec(text)) !== null) last = m.index + m[0].length;
  return last >= 0 ? text.slice(last) : null;
}

export function extractOutcomeExtended(text?: string | null): OutcomeInfo | null {
  if (!text) return null;
  const t = text.toLowerCase();

  // Upheld patterns
  if (t.includes('залишити без змін') || t.includes('залишено без змін')) {
    return { outcome: 'залишено без змін', effect: 'upheld' };
  }
  // Reinstatement: cassation cancels the intermediate decision but leaves the
  // reviewed decision in force — the controlling position stands (CORE-95).
  // Must be checked BEFORE the "скасув" branches: reinstatement dispositives
  // typically also contain "скасувати" (for the intermediate decision).
  if (t.includes('залишити в силі') || t.includes('залишено в силі')) {
    return { outcome: 'залишено в силі', effect: 'upheld' };
  }
  if (
    (t.includes('відмовити') || t.includes('залишити без задоволення') || t.includes('залишено без задоволення')) &&
    (t.includes('апеляці') || t.includes('касаці') || t.includes('скарг'))
  ) {
    return { outcome: 'скаргу залишено без задоволення', effect: 'upheld' };
  }

  // Overruled patterns (cancel + remand first, since it's more specific).
  // Remand requires an explicit "направ…розгляд" — the earlier loose 'нов' check
  // false-positived on "ухвалити нове рішення", "установ…" etc. (CORE-95).
  if (t.includes('скасув') && t.includes('направ') && t.includes('розгляд')) {
    return { outcome: 'скасовано та направлено на новий розгляд', effect: 'remanded' };
  }
  if (t.includes('скасув')) {
    return { outcome: 'скасовано', effect: 'overruled' };
  }

  // Modified patterns
  if (t.includes('змінити') || t.includes('змінено')) {
    return { outcome: 'змінено', effect: 'modified' };
  }
  if (t.includes('частков') && t.includes('задовольн')) {
    return { outcome: 'частково задоволено', effect: 'modified' };
  }

  // Closed
  if (t.includes('закрити провадження') || t.includes('закрито провадження')) {
    return { outcome: 'провадження закрито', effect: 'closed' };
  }

  // Costs-only rulings (додаткова постанова про судові витрати): no specific
  // merits pattern matched above, and the ruling is about costs — it does not
  // affect the reviewed decision, so it carries no outcome (CORE-107).
  if (t.includes('судові витрати') || t.includes('судового збору') || t.includes('судовий збір')) {
    return null;
  }

  // Generic allowed/denied (fallbacks) — only meaningful for a granted/refused
  // СКАРГА: «заяву/клопотання задовольнити» is a procedural ruling, not a
  // disposition of the reviewed decision (CORE-107, repro 910/2489/24).
  if (t.includes('задовольн') && t.includes('скарг')) {
    return { outcome: 'скаргу задоволено', effect: 'overruled' };
  }
  if (t.includes('відмов') && t.includes('скарг')) {
    return { outcome: 'відмовлено', effect: 'upheld' };
  }

  return null;
}
