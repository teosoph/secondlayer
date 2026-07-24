/**
 * TokenBudgetAllocator — centralized context window budget management.
 *
 * Replaces scattered per-tool caps with a single allocator that:
 *   1. Tracks total token spend across the agentic loop
 *   2. Reserves space for the final synthesis answer
 *   3. Allocates per-step budgets proportionally to remaining capacity
 *   4. Gates tool result compaction through one chokepoint
 */

import { BUDGET_LIMITS, type BudgetKey, type BudgetLimits } from './chat-constants.js';
import { logger } from '../utils/logger.js';

export interface StepBudget {
  maxResultChars: number;
  maxTokens: number;
  resolutionSlice: number;
  sectionLimit: number;
  maxDocsForContext: number;
}

export class TokenBudgetAllocator {
  private spentChars = 0;
  private iterationsUsed = 0;

  readonly tier: BudgetKey;
  readonly limits: BudgetLimits;
  private readonly synthesisReserveChars: number;

  constructor(tier: BudgetKey) {
    this.tier = tier;
    this.limits = BUDGET_LIMITS[tier] || BUDGET_LIMITS.standard;

    // Reserve ~30% of context for synthesis (system prompt + final answer generation)
    // This ensures the LLM always has room for a complete answer.
    this.synthesisReserveChars = Math.floor(this.limits.maxContextChars * 0.30);
  }

  /** Total context budget in chars (quick=48K, standard=64K, deep=100K). */
  get totalBudgetChars(): number {
    return this.limits.maxContextChars;
  }

  /** How many context chars have been consumed by tool results so far. */
  get spent(): number {
    return this.spentChars;
  }

  /** Context chars still available for tool results (excludes synthesis reserve). */
  get remainingChars(): number {
    return Math.max(0, this.limits.maxContextChars - this.spentChars - this.synthesisReserveChars);
  }

  /** Max iterations (tool calls) for the agentic loop. */
  get maxIterations(): number {
    return this.limits.maxToolCalls;
  }

  /** Max LLM output tokens per iteration. */
  get maxTokensPerIteration(): number {
    return this.limits.maxTokens;
  }

  /** Max context chars for initial context building (system prompt + history). */
  get maxContextChars(): number {
    return this.limits.maxContextChars;
  }

  /** Max prompt tokens before RAG compaction triggers. */
  get maxPromptTokens(): number {
    return this.limits.maxPromptTokens;
  }

  /**
   * Allocate a per-step budget based on remaining capacity.
   * Called before compacting each tool result.
   *
   * @param remainingSteps — how many more tool calls are expected after this one
   */
  allocateForStep(remainingSteps: number): StepBudget {
    const available = this.remainingChars;
    const divisor = Math.max(1, remainingSteps + 1);
    const perStepChars = Math.floor(available / divisor);

    // Clamp to tier's static maxResultChars as upper bound
    const maxResultChars = Math.min(perStepChars, this.limits.maxResultChars);

    return {
      maxResultChars,
      maxTokens: this.limits.maxTokens,
      resolutionSlice: this.limits.resolutionSlice,
      sectionLimit: this.deriveSectionLimit(),
      maxDocsForContext: this.deriveMaxDocs(),
    };
  }

  /**
   * Record that a tool result consumed `chars` of context budget.
   * Call after compaction, with the actual size of the compacted result.
   */
  consume(chars: number): void {
    this.spentChars += chars;
    this.iterationsUsed++;

    if (this.remainingChars <= 0) {
      logger.warn('[TokenBudgetAllocator] Context budget exhausted', {
        tier: this.tier,
        spent: this.spentChars,
        total: this.totalBudgetChars,
        iterations: this.iterationsUsed,
      });
    }
  }

  /** Check if the context budget is nearly exhausted (< 10% remaining). */
  isNearlyExhausted(): boolean {
    return this.remainingChars < this.totalBudgetChars * 0.10;
  }

  /**
   * Get a BudgetLimits-compatible object for backward compatibility.
   * Consumers that still expect the old `limits` shape can use this,
   * but the per-step allocation from `allocateForStep()` is preferred.
   */
  toLegacyLimits(): BudgetLimits {
    return this.limits;
  }

  /**
   * Get the max chars available for the forced fallback answer
   * when maxToolCalls is exhausted without a final answer.
   */
  get fallbackContextChars(): number {
    return Math.floor(this.limits.maxContextChars / 2);
  }

  /** Court section char limit: quick=500, standard=1500, deep=3000. */
  private deriveSectionLimit(): number {
    if (this.tier === 'deep') return 3000;
    if (this.tier === 'quick') return 500;
    return 1500;
  }

  /** Max court docs kept in context: quick/standard=5, deep=15. */
  private deriveMaxDocs(): number {
    return this.tier === 'deep' ? 15 : 5;
  }
}
