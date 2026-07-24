/**
 * ToolHealthTracker — tracks success/empty/error rates per tool across requests.
 *
 * Singleton per process. Detects degraded tools (stub backends, always-failing
 * AI extraction) automatically instead of waiting for user complaints.
 */

import { logger } from '../utils/logger.js';

export interface ToolHealthSnapshot {
  totalCalls: number;
  successCount: number;
  emptyCount: number;
  errorCount: number;
  emptyRate: number;
  errorRate: number;
  avgLatencyMs: number;
  lastCallAt: number;
}

interface ToolRecord {
  success: number;
  empty: number;
  error: number;
  totalLatencyMs: number;
  lastCallAt: number;
}

const WINDOW_SIZE = 50;

export class ToolHealthTracker {
  private records = new Map<string, ToolRecord>();

  /**
   * Record a tool call outcome.
   * Call after each tool execution in the agentic loop.
   */
  record(
    toolName: string,
    outcome: 'success' | 'empty' | 'error',
    latencyMs: number
  ): void {
    let rec = this.records.get(toolName);
    if (!rec) {
      rec = { success: 0, empty: 0, error: 0, totalLatencyMs: 0, lastCallAt: 0 };
      this.records.set(toolName, rec);
    }

    rec[outcome]++;
    rec.totalLatencyMs += latencyMs;
    rec.lastCallAt = Date.now();

    // Sliding window: decay old counts when total exceeds WINDOW_SIZE
    const total = rec.success + rec.empty + rec.error;
    if (total > WINDOW_SIZE * 2) {
      const factor = WINDOW_SIZE / total;
      rec.success = Math.round(rec.success * factor);
      rec.empty = Math.round(rec.empty * factor);
      rec.error = Math.round(rec.error * factor);
      rec.totalLatencyMs = Math.round(rec.totalLatencyMs * factor);
    }

    // Warn on high empty/error rates
    const snapshot = this.getHealth(toolName);
    if (snapshot && snapshot.totalCalls >= 5) {
      if (snapshot.emptyRate > 0.8) {
        logger.warn('[ToolHealthTracker] Tool returning empty 80%+', {
          tool: toolName, ...snapshot,
        });
      }
      if (snapshot.errorRate > 0.5) {
        logger.warn('[ToolHealthTracker] Tool error rate > 50%', {
          tool: toolName, ...snapshot,
        });
      }
    }
  }

  /**
   * Get health snapshot for a specific tool.
   */
  getHealth(toolName: string): ToolHealthSnapshot | null {
    const rec = this.records.get(toolName);
    if (!rec) return null;

    const total = rec.success + rec.empty + rec.error;
    if (total === 0) return null;

    return {
      totalCalls: total,
      successCount: rec.success,
      emptyCount: rec.empty,
      errorCount: rec.error,
      emptyRate: rec.empty / total,
      errorRate: rec.error / total,
      avgLatencyMs: Math.round(rec.totalLatencyMs / total),
      lastCallAt: rec.lastCallAt,
    };
  }

  /**
   * Check if a tool is degraded (empty rate > threshold).
   * Used before tool execution to skip or suggest fallback.
   */
  isDegraded(toolName: string, emptyThreshold = 0.8): boolean {
    const health = this.getHealth(toolName);
    if (!health || health.totalCalls < 5) return false;
    return health.emptyRate > emptyThreshold;
  }

  /**
   * Get all tracked tools and their health.
   * Useful for monitoring dashboards.
   */
  getAllHealth(): Record<string, ToolHealthSnapshot> {
    const result: Record<string, ToolHealthSnapshot> = {};
    for (const [name] of this.records) {
      const h = this.getHealth(name);
      if (h) result[name] = h;
    }
    return result;
  }

  /** Reset all tracking data (for testing). */
  reset(): void {
    this.records.clear();
  }
}
