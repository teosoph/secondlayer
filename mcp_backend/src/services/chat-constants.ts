/**
 * Shared constants for the chat pipeline modules.
 */

/** Budget-aware limits: deep analysis needs much more context */
export const BUDGET_LIMITS = {
  quick:    { maxResultChars: 6000,   maxContextChars: 48_000,  maxTokens: 4096,  maxToolCalls: 5,  resolutionSlice: 120, maxPromptTokens: 30_000 },
  standard: { maxResultChars: 8000,   maxContextChars: 64_000,  maxTokens: 8192,  maxToolCalls: 10, resolutionSlice: 300, maxPromptTokens: 60_000 },
  deep:     { maxResultChars: 40_000, maxContextChars: 100_000, maxTokens: 16384, maxToolCalls: 25, resolutionSlice: 800, maxPromptTokens: 150_000 },
} as const;

export type BudgetKey = keyof typeof BUDGET_LIMITS;
export type BudgetLimits = typeof BUDGET_LIMITS[BudgetKey];

/** Regex to match Ukrainian case numbers (e.g. 922/123/24) */
export const CASE_NUMBER_REGEX = /\d+\/\d+\/\d{2,4}/g;

/**
 * Query types whose final answer is verified BEFORE it is streamed to the client
 * (CORE-21 P0.3). These produce court-practice analyses where citation fabrication
 * is highest-risk; for them we withhold the live token stream, run verify + citation
 * repair, then emit the corrected answer as a single event — so a fabricated draft is
 * never shown and then yanked. Other query types stream live as before.
 */
export const VERIFY_BEFORE_STREAM_QUERY_TYPES = new Set<string>([
  'practice_analysis',
  'institutional_analysis',
  'comparative_analysis',
  'due_diligence',
]);
