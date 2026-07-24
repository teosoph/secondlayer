/**
 * StepConstraints — enforces behavioral rules in code instead of prompts.
 *
 * The LLM ignores prompt rules ("don't call search_legislation more than 2 times").
 * These constraints are enforced at the execution layer — the LLM literally cannot
 * violate them.
 */

import { logger } from '../utils/logger.js';
import type { BudgetKey } from './chat-constants.js';

export interface ToolConstraint {
  /** Max times this tool can be called per request.
   *  A scalar applies to every tier. A per-tier map scales the ceiling with the
   *  resource budget: quick stays cheap, deep gets more recall. Missing tiers
   *  fall back deep → standard → quick. */
  maxCallsPerRequest?: number | Partial<Record<BudgetKey, number>>;
  /** Block after this many consecutive empty results (default: 2). */
  maxConsecutiveEmpty?: number;
  /** Block this tool for these plan intents / queryTypes. */
  blockedFor?: string[];
  /** If this tool returns empty, suggest these fallback tools. */
  fallbackTools?: string[];
}

export interface ConstraintResult {
  allowed: boolean;
  reason?: string;
  fallbackSuggestion?: string;
}

const DEFAULT_MAX_CONSECUTIVE_EMPTY = 2;

// Recall-oriented tools are tier-scaled: the per-tool ceiling grows with the
// resource budget so a `deep` query (e.g. practice analysis / party statistics
// over a large population) can actually spend its budget on the tool that
// matters, while a `quick` query keeps today's tight cap (no cost regression).
// quick values intentionally mirror the previous flat constants.
const CONSTRAINTS: Record<string, ToolConstraint> = {
  search_legislation: {
    maxCallsPerRequest: { quick: 3, standard: 3, deep: 4 },
  },
  search_court_sessions: {
    blockedFor: ['case_lookup', 'practice_analysis', 'legal_consultation'],
  },
  search_court_decisions: {
    maxCallsPerRequest: { quick: 3, standard: 4, deep: 6 },
    maxConsecutiveEmpty: 2,
    fallbackTools: ['search_legal_precedents', 'get_legislation_section'],
  },
  find_similar_fact_pattern_cases: {
    maxCallsPerRequest: { quick: 2, standard: 2, deep: 3 },
    maxConsecutiveEmpty: 1,
    fallbackTools: ['search_court_decisions', 'search_legal_precedents', 'compare_practice_pro_contra'],
  },
  compare_practice_pro_contra: {
    maxCallsPerRequest: { quick: 2, standard: 2, deep: 3 },
    maxConsecutiveEmpty: 1,
    fallbackTools: ['search_court_decisions', 'search_legal_precedents'],
  },
  search_legal_precedents: {
    // deprecated tool — kept flat, not scaled
    maxCallsPerRequest: 3,
    maxConsecutiveEmpty: 2,
    fallbackTools: ['search_court_decisions'],
  },
  get_court_decision: {
    maxCallsPerRequest: { quick: 3, standard: 4, deep: 6 },
  },
  get_legislation_section: {
    maxCallsPerRequest: { quick: 4, standard: 4, deep: 6 },
  },
};

export class StepConstraintEnforcer {
  private callCounts = new Map<string, number>();
  private consecutiveEmpty = new Map<string, number>();

  /** @param tier resource budget tier — scales per-tool call ceilings. */
  constructor(private readonly tier: BudgetKey = 'standard') {}

  /**
   * Resolve the per-request call cap for a constraint under the active tier.
   * Scalar caps apply to every tier; per-tier maps fall back deep → standard → quick.
   */
  private resolveMaxCalls(constraint: ToolConstraint): number | undefined {
    const m = constraint.maxCallsPerRequest;
    if (m === undefined) return undefined;
    if (typeof m === 'number') return m;
    return m[this.tier] ?? m.deep ?? m.standard ?? m.quick;
  }

  /**
   * Check if a tool call is allowed under current constraints.
   * Call before executing each tool.
   */
  check(toolName: string, queryType?: string): ConstraintResult {
    const constraint = CONSTRAINTS[toolName];
    if (!constraint) return { allowed: true };

    // Max calls per request (tier-scaled)
    const maxCalls = this.resolveMaxCalls(constraint);
    if (maxCalls !== undefined) {
      const count = this.callCounts.get(toolName) || 0;
      if (count >= maxCalls) {
        logger.info('[StepConstraints] Blocked: max calls reached', {
          tool: toolName,
          count,
          max: maxCalls,
          tier: this.tier,
        });
        const fallback = this.getFallbackSuggestion(toolName);
        return {
          allowed: false,
          reason: `max ${maxCalls} calls reached`,
          fallbackSuggestion: fallback,
        };
      }
    }

    // Consecutive empty results
    const maxEmpty = constraint.maxConsecutiveEmpty ?? DEFAULT_MAX_CONSECUTIVE_EMPTY;
    const emptyCount = this.consecutiveEmpty.get(toolName) || 0;
    if (emptyCount >= maxEmpty) {
      logger.info('[StepConstraints] Blocked: consecutive empty results', {
        tool: toolName,
        emptyCount,
        maxEmpty,
      });
      const fallback = this.getFallbackSuggestion(toolName);
      return {
        allowed: false,
        reason: `${emptyCount} consecutive empty results`,
        fallbackSuggestion: fallback,
      };
    }

    // Blocked for this queryType
    if (constraint.blockedFor && queryType && constraint.blockedFor.includes(queryType)) {
      logger.info('[StepConstraints] Blocked: tool not allowed for queryType', {
        tool: toolName,
        queryType,
      });
      return {
        allowed: false,
        reason: `blocked for ${queryType}`,
      };
    }

    return { allowed: true };
  }

  /**
   * Record that a tool was called. Call after successful execution.
   */
  recordCall(toolName: string, empty: boolean = false): void {
    this.callCounts.set(toolName, (this.callCounts.get(toolName) || 0) + 1);
    if (empty) {
      this.consecutiveEmpty.set(toolName, (this.consecutiveEmpty.get(toolName) || 0) + 1);
    } else {
      this.consecutiveEmpty.set(toolName, 0);
    }
  }

  /**
   * Get fallback suggestion when a tool returns empty results.
   */
  getFallbackSuggestion(toolName: string): string | undefined {
    const constraint = CONSTRAINTS[toolName];
    if (!constraint?.fallbackTools?.length) return undefined;

    const suggestions = constraint.fallbackTools
      .filter(t => {
        const c = CONSTRAINTS[t];
        if (!c) return true;
        const max = this.resolveMaxCalls(c);
        if (max === undefined) return true;
        return (this.callCounts.get(t) || 0) < max;
      });

    if (suggestions.length === 0) return undefined;
    return suggestions.join(', ');
  }

  /**
   * Build a nudge message for the LLM when a tool is blocked or returned empty.
   */
  buildNudge(toolName: string, reason: 'blocked' | 'empty', queryType?: string): string {
    const constraint = CONSTRAINTS[toolName];
    const fallback = this.getFallbackSuggestion(toolName);

    if (reason === 'blocked') {
      if (fallback) {
        return `Інструмент ${toolName} заблоковано (${this.getBlockReason(toolName, queryType)}). Спробуй: ${fallback}`;
      }
      return `Інструмент ${toolName} заблоковано. Використай наявні результати для аналізу.`;
    }

    // empty result
    if (fallback) {
      return `${toolName} повернув 0 результатів. Спробуй альтернативу: ${fallback}`;
    }
    return `${toolName} повернув 0 результатів. Зроби аналіз на основі наявних даних.`;
  }

  /** Get constraint config (for testing). */
  static getConstraints(): Record<string, ToolConstraint> {
    return { ...CONSTRAINTS };
  }

  /** Number of times a tool has been called in this request. */
  getCallCount(toolName: string): number {
    return this.callCounts.get(toolName) || 0;
  }

  private getBlockReason(toolName: string, queryType?: string): string {
    const constraint = CONSTRAINTS[toolName];
    if (!constraint) return 'unknown';
    const maxCalls = this.resolveMaxCalls(constraint);
    if (maxCalls !== undefined) {
      const count = this.callCounts.get(toolName) || 0;
      if (count >= maxCalls) {
        return `ліміт ${maxCalls} викликів`;
      }
    }
    if (constraint.blockedFor && queryType && constraint.blockedFor.includes(queryType)) {
      return `не для ${queryType}`;
    }
    return 'constraint';
  }
}
