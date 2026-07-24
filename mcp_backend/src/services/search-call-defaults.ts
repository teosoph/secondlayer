/**
 * Code-enforced defaults for `search_court_decisions` tool calls.
 *
 * The model is told to do these in the prompt but routinely doesn't, so they are enforced in
 * code (see also applySearchModeDefault in chat-execution-loop). Kept dependency-free — a
 * minimal structural call shape instead of the shared `ToolCall` type — so the rules stay
 * unit-testable without pulling in the full execution-loop dependency graph.
 */

interface SearchToolCall {
  name: string;
  arguments?: any;
}

// When the user explicitly asks for the SUPREME COURT's position ("позиція Верховного Суду",
// "практика ВС", "Велика Палата"), the relevant cassation rulings are a tiny fraction of all
// decisions and neither the FTS nor the vector leg ranks them — measured 0/29 recall on a real
// consultation, because the rulings sit amid thousands of lower-court cases on the same topic.
// The decisive lever is collapsing the search universe to the cassation instance: pin
// court_level=SC (→ instance_code=1) so the leg only considers Supreme-Court practice. Skip when
// the model already set any court/instance constraint (its explicit choice wins).
// Explicit Cyrillic class + the u flag — JS \w matches only ASCII, so \w* would never span the
// Ukrainian inflection ("верховн|ого| суд") and the rule would silently never fire.
export const SUPREME_COURT_RE = /верховн[а-яіїєґ]*\s+суд|велик[а-яіїєґ]*\s+палат/iu;

export function applySupremeCourtFilter(call: SearchToolCall, query: string): void {
  if (call.name !== 'search_court_decisions') return;
  if (!SUPREME_COURT_RE.test(query)) return;
  const args = (call.arguments || {}) as Record<string, any>;
  if (args.court_level || args.instance_code || args.court_code || args.court_name) return;
  args.court_level = 'SC';
  call.arguments = args;
}
