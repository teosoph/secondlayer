/**
 * PipelineMetrics — per-request instrumentation for the chat pipeline.
 *
 * Tracks timing, model, tokens, and cost for each stage:
 *   classify → plan → [tool_select → tool_exec → interpret]* → synthesize
 *
 * Used to establish baseline data for cascaded model routing experiments.
 */

import { logger } from '../utils/logger.js';
import type { LLMProvider } from '@secondlayer/shared';

// ============================
// Types
// ============================

export type PipelineStage =
  | 'classify'
  | 'plan_generation'
  | 'history_compression'
  | 'context_build'
  | 'tool_select'       // LLM decides which tool to call
  | 'tool_exec'         // actual tool execution (no LLM)
  | 'result_compact'    // summarize/compact tool results
  | 'rag_compact'       // RAG-based compaction
  | 'synthesize'        // final answer generation
  | 'citation_check'    // shepardization / fabrication check
  | 'replan'            // plan regenerated mid-execution after empty results
  | 'iteration';        // full agentic loop iteration

export interface StageMetric {
  stage: PipelineStage;
  startedAt: number;
  durationMs: number;
  provider?: LLMProvider;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  /** iteration index (for multi-iteration stages like tool_select) */
  iteration?: number;
  /** tool name (for tool_exec / tool_select) */
  toolName?: string;
  /** whether result was served from cache */
  cached?: boolean;
  /** extra context for debugging */
  meta?: Record<string, any>;
}

export interface PipelineMetricsSummary {
  requestId: string;
  query: string;
  queryType?: string;
  effectiveBudget: string;
  totalDurationMs: number;
  totalCostUsd: number;
  stages: StageMetric[];
  stageSummary: Record<PipelineStage, { count: number; totalMs: number; totalCostUsd: number }>;
  /** cost breakdown by model tier */
  costByModel: Record<string, { calls: number; tokens: number; costUsd: number }>;
  /** theoretical cost if every LLM stage used haiku */
  theoreticalHaikuCostUsd: number;
  /** theoretical cost if every LLM stage used sonnet */
  theoreticalSonnetCostUsd: number;
  /** ratio: actual cost / theoretical haiku cost — measures decomposition potential */
  costReductionPotential: number;
}

// Pricing per 1M tokens for theoretical cost calculations
const THEORETICAL_PRICING: Record<string, { input: number; output: number }> = {
  haiku: { input: 1.00, output: 5.00 },
  sonnet: { input: 3.00, output: 15.00 },
  opus: { input: 15.00, output: 75.00 },
};

// ============================
// Service
// ============================

export class PipelineMetrics {
  private stages: StageMetric[] = [];
  private activeTimers = new Map<string, { startedAt: number; stage: PipelineStage; iteration?: number; toolName?: string }>();
  private timerSeq = 0;
  private requestStartedAt: number;

  constructor(
    private requestId: string,
    private query: string
  ) {
    this.requestStartedAt = Date.now();
  }

  /**
   * Start timing a stage. Returns a key to pass to endStage().
   */
  startStage(stage: PipelineStage, meta?: { iteration?: number; toolName?: string }): string {
    // Sequence suffix keeps keys unique when the same tool runs twice in one
    // iteration (parallel calls) — identical keys used to collide and trigger
    // "endStage called for unknown key" for the second call.
    const key = `${stage}:${meta?.iteration ?? 0}:${meta?.toolName ?? ''}:${this.timerSeq++}`;
    this.activeTimers.set(key, {
      startedAt: Date.now(),
      stage,
      iteration: meta?.iteration,
      toolName: meta?.toolName,
    });
    return key;
  }

  /**
   * End a stage and record the metric.
   */
  endStage(key: string, result?: {
    provider?: LLMProvider;
    model?: string;
    promptTokens?: number;
    completionTokens?: number;
    costUsd?: number;
    cached?: boolean;
    meta?: Record<string, any>;
  }): void {
    const timer = this.activeTimers.get(key);
    if (!timer) {
      logger.warn('[PipelineMetrics] endStage called for unknown key', { key, requestId: this.requestId });
      return;
    }
    this.activeTimers.delete(key);

    const { startedAt, stage, iteration, toolName } = timer;

    const totalTokens = (result?.promptTokens || 0) + (result?.completionTokens || 0);

    this.stages.push({
      stage,
      startedAt,
      durationMs: Date.now() - startedAt,
      provider: result?.provider,
      model: result?.model,
      promptTokens: result?.promptTokens,
      completionTokens: result?.completionTokens,
      totalTokens: totalTokens || undefined,
      costUsd: result?.costUsd,
      iteration,
      toolName,
      cached: result?.cached,
      meta: result?.meta,
    });
  }

  /**
   * Record a stage that already completed (e.g. tool execution with known duration).
   */
  recordStage(stage: PipelineStage, metric: Omit<StageMetric, 'stage'>): void {
    this.stages.push({ stage, ...metric });
  }

  /**
   * Build the full summary with theoretical cost comparisons.
   */
  summarize(queryType?: string, effectiveBudget?: string): PipelineMetricsSummary {
    const totalDurationMs = Date.now() - this.requestStartedAt;
    let totalCostUsd = 0;

    // Stage summary
    const stageSummary: Record<string, { count: number; totalMs: number; totalCostUsd: number }> = {};
    const costByModel: Record<string, { calls: number; tokens: number; costUsd: number }> = {};

    let theoreticalHaikuCostUsd = 0;
    let theoreticalSonnetCostUsd = 0;

    for (const s of this.stages) {
      // 'iteration' is a roll-up wrapper: it duplicates the cost/tokens of its
      // typed sub-stage (tool_select/synthesize), which is recorded separately
      // for cleaner analysis. Grand totals must count each LLM turn once, so
      // iteration rows are excluded from totalCostUsd, costByModel, and
      // theoretical costs — but kept in stages[] and the per-stage summary.
      const isRollup = s.stage === 'iteration';

      // Accumulate stage summary
      if (!stageSummary[s.stage]) {
        stageSummary[s.stage] = { count: 0, totalMs: 0, totalCostUsd: 0 };
      }
      stageSummary[s.stage].count++;
      stageSummary[s.stage].totalMs += s.durationMs;
      stageSummary[s.stage].totalCostUsd += s.costUsd || 0;
      if (!isRollup) {
        totalCostUsd += s.costUsd || 0;
      }

      // Accumulate cost by model
      if (s.model && !isRollup) {
        if (!costByModel[s.model]) {
          costByModel[s.model] = { calls: 0, tokens: 0, costUsd: 0 };
        }
        costByModel[s.model].calls++;
        costByModel[s.model].tokens += s.totalTokens || 0;
        costByModel[s.model].costUsd += s.costUsd || 0;
      }

      // Theoretical costs: what if this LLM call used haiku/sonnet instead?
      if (s.promptTokens && s.completionTokens && !isRollup) {
        theoreticalHaikuCostUsd +=
          (s.promptTokens * THEORETICAL_PRICING.haiku.input) / 1_000_000 +
          (s.completionTokens * THEORETICAL_PRICING.haiku.output) / 1_000_000;
        theoreticalSonnetCostUsd +=
          (s.promptTokens * THEORETICAL_PRICING.sonnet.input) / 1_000_000 +
          (s.completionTokens * THEORETICAL_PRICING.sonnet.output) / 1_000_000;
      }
    }

    const costReductionPotential = theoreticalHaikuCostUsd > 0
      ? totalCostUsd / theoreticalHaikuCostUsd
      : 1;

    return {
      requestId: this.requestId,
      query: this.query.slice(0, 200),
      queryType,
      effectiveBudget: effectiveBudget || 'unknown',
      totalDurationMs,
      totalCostUsd,
      stages: this.stages,
      stageSummary: stageSummary as any,
      costByModel,
      theoreticalHaikuCostUsd,
      theoreticalSonnetCostUsd,
      costReductionPotential,
    };
  }

  /**
   * Log the full summary at info level for debugging and data collection.
   */
  logSummary(queryType?: string, effectiveBudget?: string): PipelineMetricsSummary {
    const summary = this.summarize(queryType, effectiveBudget);

    logger.info('[PipelineMetrics] Request completed', {
      requestId: summary.requestId,
      query: summary.query,
      queryType: summary.queryType,
      effectiveBudget: summary.effectiveBudget,
      totalDurationMs: summary.totalDurationMs,
      totalCostUsd: summary.totalCostUsd.toFixed(6),
      theoreticalHaikuCostUsd: summary.theoreticalHaikuCostUsd.toFixed(6),
      theoreticalSonnetCostUsd: summary.theoreticalSonnetCostUsd.toFixed(6),
      costReductionPotential: summary.costReductionPotential.toFixed(2),
      stageCount: summary.stages.length,
    });

    // Log per-stage breakdown at debug level
    for (const s of summary.stages) {
      logger.debug('[PipelineMetrics] Stage', {
        stage: s.stage,
        durationMs: s.durationMs,
        model: s.model,
        tokens: s.totalTokens,
        costUsd: s.costUsd?.toFixed(6),
        iteration: s.iteration,
        toolName: s.toolName,
        cached: s.cached,
      });
    }

    // Log stage summary
    logger.info('[PipelineMetrics] Stage summary', {
      requestId: summary.requestId,
      stages: Object.entries(summary.stageSummary).map(([stage, data]) => ({
        stage,
        count: data.count,
        totalMs: data.totalMs,
        totalCostUsd: data.totalCostUsd.toFixed(6),
      })),
    });

    // Log model cost breakdown
    if (Object.keys(summary.costByModel).length > 0) {
      logger.info('[PipelineMetrics] Cost by model', {
        requestId: summary.requestId,
        models: Object.entries(summary.costByModel).map(([model, data]) => ({
          model,
          calls: data.calls,
          tokens: data.tokens,
          costUsd: data.costUsd.toFixed(6),
        })),
      });
    }

    return summary;
  }
}
