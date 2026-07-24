/**
 * ChatPlanService — execution-plan generation and the two-phase plan-review flow.
 *
 * Extracted from ChatService (CORE-21 decomposition). Owns:
 *  - plan generation via LLM (generateExecutionPlan), incl. REPLAN notes
 *  - fast plan lookup for deterministic query types (no LLM call)
 *  - plan-for-review sessions (/api/chat/plan) with TTL + cost estimation
 *  - depth overrides applied to user-approved plans
 */

import { randomBytes } from 'crypto';
import { logger } from '../utils/logger.js';
import { ToolRegistry, ToolDefinition } from '../api/tool-registry.js';
import type { ILLMPort } from '../domain/ports/index.js';
import {
  buildPlanGenerationMessages,
  ExecutionPlan,
  type QueryType,
  type ChatIntentClassification,
} from '../prompts/chat-system-prompt.js';
import type { IntentClassifier } from './chat-intent-classifier.js';

export interface PlanCostRecorder {
  recordStreamingCost(requestId: string, provider: string, model: string, usage: any, task: string): void;
}

/** Depth-based parameter overrides for search tools (deep = larger limits) */
const DEPTH_OVERRIDES: Record<string, { standard: Record<string, any>; deep: Record<string, any> }> = {
  search_legal_precedents:        { standard: { limit: 20 }, deep: { limit: 50 } },
  search_supreme_court_practice:  { standard: { limit: 20 }, deep: { limit: 50 } },
  find_similar_fact_pattern_cases: { standard: { limit: 10 }, deep: { limit: 30 } },
  compare_practice_pro_contra:    { standard: { limit: 20 }, deep: { limit: 50 } },
  search_legislation:             { standard: { limit: 10 }, deep: { limit: 30 } },
  find_relevant_law_articles:     { standard: { limit: 10 }, deep: { limit: 25 } },
  search_procedural_norms:        { standard: { limit: 10 }, deep: { limit: 25 } },
};

/**
 * Estimated cost per SINGLE tool call (USD) at two budget tiers.
 * Includes BOTH tool API cost AND LLM processing cost for one iteration.
 *
 * Budget tiers map to different models on prod:
 *   standard → Sonnet 4.6  ($3/M input,  $15/M output)  — ~$0.03-0.06/iter
 *   deep     → Opus 4.6    ($15/M input, $75/M output)  — ~$0.20-0.80/iter
 *
 * Calibrated from production cost_tracking data (2026-03-11):
 *   Sonnet sessions (2-3 iters): $0.33-$0.74 total
 *   Opus sessions (5 iters):     $5-$15 total
 */
const STEP_COST_PER_CALL: Record<string, { standard: number; deep: number }> = {
  // Search tools — deep mode uses Opus + returns more results → much larger cost
  search_legal_precedents:         { standard: 0.05, deep: 0.40 },
  search_supreme_court_practice:   { standard: 0.05, deep: 0.40 },
  find_similar_fact_pattern_cases: { standard: 0.04, deep: 0.30 },
  compare_practice_pro_contra:     { standard: 0.05, deep: 0.40 },
  search_legislation:              { standard: 0.03, deep: 0.25 },
  find_relevant_law_articles:      { standard: 0.03, deep: 0.25 },
  search_procedural_norms:         { standard: 0.03, deep: 0.25 },
  // Fixed-output tools — cost still differs because deep → Opus model
  get_court_decision:              { standard: 0.04, deep: 0.30 },
  get_case_documents_chain:        { standard: 0.05, deep: 0.35 },
  get_legislation_article:         { standard: 0.02, deep: 0.15 },
  get_legislation_structure:       { standard: 0.01, deep: 0.10 },
  load_full_texts:                 { standard: 0.06, deep: 0.50 },
  semantic_search:                 { standard: 0.03, deep: 0.25 },
  list_documents:                  { standard: 0.01, deep: 0.10 },
  count_cases_by_party:            { standard: 0.02, deep: 0.15 },
};

const DEFAULT_STEP_COST_PER_CALL = { standard: 0.04, deep: 0.30 };

/**
 * Typical number of tool invocations per plan step.
 * Some tools are called once, others are called multiple times
 * (e.g., get_court_decision is called per each decision in the case chain).
 */
const TYPICAL_CALLS: Record<string, number> = {
  get_court_decision:              4,  // Per decision: district, appeal, cassation, Grand Chamber
  load_full_texts:                 2,  // May need multiple batches for many documents
  get_legislation_article:         2,  // Often multiple articles referenced
  get_case_documents_chain:        1,
  search_legal_precedents:         1,
  search_supreme_court_practice:   1,
  find_similar_fact_pattern_cases: 1,
  compare_practice_pro_contra:     1,
  search_legislation:              1,
  find_relevant_law_articles:      1,
  search_procedural_norms:         1,
  get_legislation_structure:       1,
  semantic_search:                 1,
  list_documents:                  1,
  count_cases_by_party:            1,
};

const DEFAULT_TYPICAL_CALLS = 1;

/**
 * Fixed overhead cost (USD) per request by budget tier.
 * - Classification: ~$0.005 (always Haiku)
 * - Plan generation: ~$0.08 (always Opus 4.6)
 * - Final synthesis: ~$0.04 (Sonnet) or ~$0.50 (Opus)
 *
 * Calibrated from prod: plan_generation alone costs $0.055-$0.107
 */
const PLAN_OVERHEAD_COST: Record<string, number> = { standard: 0.14, deep: 0.70 };

const PLAN_SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** Cached result from /api/chat/plan for reuse during execution */
export interface PlanSession {
  classification: ChatIntentClassification;
  toolDefs: ToolDefinition[];
  plan: ExecutionPlan;
  query: string;
  createdAt: number;
  /** Pre-fetched document chain result (to avoid re-fetching during execution) */
  prefetchedChainResult?: any;
}

export class ChatPlanService {
  /** In-memory cache: planSessionId → classification + plan for two-phase flow */
  private planSessions = new Map<string, PlanSession>();

  constructor(
    private intentClassifier: IntentClassifier,
    private toolRegistry: ToolRegistry,
    private llm: ILLMPort,
    private costRecorder: PlanCostRecorder
  ) {
    // Periodic cleanup of expired plan sessions (every 2 minutes)
    setInterval(() => {
      const now = Date.now();
      for (const [id, session] of this.planSessions) {
        if (now - session.createdAt > PLAN_SESSION_TTL_MS) {
          this.planSessions.delete(id);
        }
      }
    }, 2 * 60 * 1000);
  }

  /**
   * Consume a plan session: returns it if present and fresh, removing it from
   * the cache. Returns undefined when missing or expired (TTL).
   */
  takeValidSession(planSessionId: string): PlanSession | undefined {
    const session = this.planSessions.get(planSessionId);
    if (!session) return undefined;
    this.planSessions.delete(planSessionId);
    if (Date.now() - session.createdAt > PLAN_SESSION_TTL_MS) return undefined;
    return session;
  }

  /**
   * Phase 1: Generate execution plan for user review.
   * Returns plan + session ID that can be passed to chat() for execution.
   */
  async generatePlanForReview(
    query: string,
    budget: 'quick' | 'standard' | 'deep' = 'standard',
    userId?: string,
    requestId?: string
  ): Promise<{ plan: ExecutionPlan; planSessionId: string; queryType: QueryType } | null> {
    const classification = await this.intentClassifier.classify(query, requestId);
    const toolDefs = await this.intentClassifier.filterTools(classification.domains, classification.slots, classification.queryType);

    // Fast plan queries (case_number, EDRPOU, legislation, deputy) skip plan review —
    // they're deterministic and don't need user confirmation
    const fastPlan = this.fastPlanLookup(classification, toolDefs);
    if (fastPlan) {
      logger.info('[ChatPlanService] Fast plan detected in generatePlanForReview, skipping review', {
        queryType: classification.queryType,
        steps: fastPlan.steps.map(s => s.tool),
      });
      return null;
    }

    const plan = await this.generateExecutionPlan(query, classification, toolDefs, requestId);

    if (!plan) return null;

    // Pre-fetch document count for case-based queries to get accurate cost estimates.
    // get_case_documents_chain is fast (~200-500ms) and gives us exact document counts.
    // The result is cached in the plan session so execution doesn't re-fetch it.
    let docCount = 0;
    let prefetchedChainResult: any = undefined;
    const caseNumber = classification.slots?.case_number;
    if (caseNumber && plan.steps.some(s => ['get_court_decision', 'load_full_texts', 'get_case_documents_chain'].includes(s.tool))) {
      try {
        prefetchedChainResult = await this.toolRegistry.executeTool('get_case_documents_chain', {
          case_number: caseNumber,
          group_by_instance: false,
        });
        const parsed = typeof prefetchedChainResult === 'string' ? JSON.parse(prefetchedChainResult) : prefetchedChainResult;
        docCount = parsed?.total_documents || parsed?.data?.total_documents || 0;
        logger.info('[ChatPlanService] Pre-fetched document chain for cost estimation', {
          caseNumber,
          docCount,
        });
      } catch (e) {
        logger.warn('[ChatPlanService] Failed to pre-fetch document chain for cost estimation', {
          error: (e as Error).message,
        });
      }
    }

    // Apply LLM-recommended depth and estimate costs per step
    for (const step of plan.steps) {
      if (step.recommendedDepth) {
        step.depth = step.recommendedDepth;
      } else if (!step.depth) {
        step.depth = 'standard';
      }
    }

    // Predict effective budget tier (mirrors escalation logic in chat()):
    //   8+ steps → deep, institutional_analysis queryType → deep (via config floor)
    const willEscalateToDeep = plan.steps.length >= 8;
    const effectiveTier: 'standard' | 'deep' = willEscalateToDeep ? 'deep' : 'standard';

    // Calculate cost per step using predicted budget tier
    for (const step of plan.steps) {
      let calls = TYPICAL_CALLS[step.tool] || DEFAULT_TYPICAL_CALLS;
      if (docCount > 0) {
        if (step.tool === 'get_court_decision') {
          calls = docCount;
        } else if (step.tool === 'load_full_texts') {
          calls = Math.ceil(docCount / 5);
        }
      }
      const costPerCall = STEP_COST_PER_CALL[step.tool] || DEFAULT_STEP_COST_PER_CALL;
      step.estimatedCalls = calls;
      step.estimatedCost = costPerCall[effectiveTier] * calls;
    }

    // Overhead: classification + plan gen (Opus) + final synthesis (model depends on tier)
    const baseOverhead = PLAN_OVERHEAD_COST[effectiveTier] || PLAN_OVERHEAD_COST.standard;
    plan.overheadCost = docCount > 5
      ? baseOverhead + (docCount - 5) * (effectiveTier === 'deep' ? 0.03 : 0.005)
      : baseOverhead;

    // Cache session for reuse
    const planSessionId = `plan-${Date.now()}-${randomBytes(4).toString('hex')}`;
    this.planSessions.set(planSessionId, {
      classification,
      toolDefs,
      plan,
      query,
      createdAt: Date.now(),
      prefetchedChainResult,
    });

    logger.info('[ChatPlanService] Plan generated for review', {
      planSessionId,
      steps: plan.steps.length,
      goal: plan.goal.slice(0, 100),
      queryType: classification.queryType,
    });

    return { plan, planSessionId, queryType: classification.queryType };
  }

  /**
   * Apply user-chosen depth overrides to plan step parameters.
   * Deep steps get larger limits for search tools.
   */
  applyStepDepths(plan: ExecutionPlan): ExecutionPlan {
    const adjustedSteps = plan.steps.map(step => {
      const depth = step.depth || 'standard';
      const overrides = DEPTH_OVERRIDES[step.tool];
      if (!overrides) return step;
      return {
        ...step,
        params: { ...step.params, ...overrides[depth] },
      };
    });
    return { ...plan, steps: adjustedSteps };
  }

  /**
   * Fast plan lookup for deterministic query types.
   * Returns a pre-built plan if the classification is simple enough,
   * skipping the plan-generation LLM call (saves 200-400ms).
   */
  fastPlanLookup(
    classification: ChatIntentClassification,
    toolDefs: ToolDefinition[]
  ): ExecutionPlan | null {
    const slots = classification.slots || {};
    const toolNames = new Set(toolDefs.map(t => t.name));

    // EDRPOU → single registry lookup
    if (slots.edrpou && classification.queryType === 'registry_lookup' && toolNames.has('openreyestr_get_by_edrpou')) {
      return {
        goal: `Пошук юридичної особи за ЄДРПОУ ${slots.edrpou}`,
        steps: [{
          id: 1,
          tool: 'openreyestr_get_by_edrpou',
          params: { edrpou: slots.edrpou },
          purpose: 'Отримати дані з реєстру',
        }],
        expected_iterations: 1,
      };
    }

    // Single case number → case document chain
    if (
      slots.case_number &&
      !slots.law_reference &&
      classification.queryType === 'case_lookup' &&
      toolNames.has('get_case_documents_chain')
    ) {
      return {
        goal: `Отримати документи справи ${slots.case_number}`,
        steps: [{
          id: 1,
          tool: 'get_case_documents_chain',
          params: { case_number: slots.case_number, include_full_text: true },
          purpose: 'Отримати всі документи справи',
        }],
        expected_iterations: 2,
      };
    }

    // Legislation article lookup
    if (
      slots.law_reference &&
      !slots.case_number &&
      classification.queryType === 'legislation_lookup' &&
      toolNames.has('get_legislation_article')
    ) {
      return {
        goal: `Отримати текст ${slots.law_reference}`,
        steps: [{
          id: 1,
          tool: 'get_legislation_article',
          params: { query: slots.law_reference },
          purpose: 'Знайти статтю закону',
        }],
        expected_iterations: 1,
      };
    }

    // Deputy info lookup
    if (
      slots.deputy_name &&
      classification.queryType === 'parliament_query' &&
      toolNames.has('rada_get_deputy_info')
    ) {
      return {
        goal: `Інформація про депутата ${slots.deputy_name}`,
        steps: [{
          id: 1,
          tool: 'rada_get_deputy_info',
          params: { name: slots.deputy_name },
          purpose: 'Отримати інформацію про депутата',
        }],
        expected_iterations: 1,
      };
    }

    return null;
  }

  async generateExecutionPlan(
    query: string,
    classification: { domains: string[]; keywords: string; slots?: Record<string, any> },
    toolDefs: ToolDefinition[],
    requestId?: string,
    replanNote?: string
  ): Promise<ExecutionPlan | undefined> {
    try {
      const llm = this.llm;

      // Build tool descriptions for the prompt
      const toolDescriptions = toolDefs
        .map((d) => `- ${d.name}: ${d.description}`)
        .join('\n');

      const planMessages = buildPlanGenerationMessages(query, classification, toolDescriptions, replanNote ? { replanNote } : undefined);

      const totalChars = planMessages.reduce((s, m) => s + m.content.length, 0);
      logger.debug('[ChatPlanService] Execution plan prompt size', {
        chars: totalChars,
        estimatedTokens: Math.ceil(totalChars / 2.2),
      });

      const startTime = Date.now();

      const response = await llm.chatCompletion(
        {
          messages: planMessages,
          max_tokens: 2000,
        },
        'deep'
      );

      // Record plan generation LLM cost
      if (requestId && response.usage) {
        this.costRecorder.recordStreamingCost(requestId, response.provider, response.model, response.usage, 'plan_generation');
      }

      const content = response.content || '{}';
      const elapsed = Date.now() - startTime;

      logger.debug('[ChatPlanService] Plan generation response', {
        model: response.model,
        contentLength: content.length,
        contentPreview: content.slice(0, 500),
      });

      // Extract JSON from response (may be wrapped in markdown code blocks)
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in plan response');
      }

      const parsed = JSON.parse(jsonMatch[0]);

      // Empty object — model failed to generate a plan despite instructions
      if (Object.keys(parsed).length === 0) {
        logger.warn('[ChatPlanService] Plan generation returned empty object, model did not follow instructions', {
          model: response.model,
          query: query.slice(0, 200),
        });
        return undefined;
      }

      // Validate plan structure
      if (!parsed.goal || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
        logger.warn('[ChatPlanService] Plan validation failed - invalid structure', {
          parsed: JSON.stringify(parsed).slice(0, 500),
          hasGoal: !!parsed.goal,
          hasSteps: Array.isArray(parsed.steps),
          stepsLength: parsed.steps?.length,
          model: response.model,
          provider: response.provider,
        });
        throw new Error('Invalid plan structure: missing goal or steps');
      }

      // Cap at 5 steps
      const steps = parsed.steps.slice(0, 5);

      // Validate each step has required fields
      for (const step of steps) {
        if (!step.tool || !step.purpose) {
          throw new Error(`Invalid step: missing tool or purpose`);
        }
        step.params = step.params || {};
      }

      // Validate tool names against registry — remove steps with non-existent tools
      const validatedSteps = steps.filter((step: any) => {
        const route = this.toolRegistry.getRoute(step.tool);
        if (!route) {
          logger.warn('[ChatPlanService] Plan step references non-existent tool, removing', {
            tool: step.tool,
            purpose: step.purpose,
          });
          return false;
        }
        return true;
      });

      if (validatedSteps.length === 0) {
        logger.warn('[ChatPlanService] All plan steps had invalid tool names', {
          originalSteps: steps.map((s: any) => s.tool),
        });
        throw new Error('All plan steps reference non-existent tools');
      }

      const plan: ExecutionPlan = {
        goal: parsed.goal,
        steps: validatedSteps,
        expected_iterations: parsed.expected_iterations || validatedSteps.length,
      };

      logger.info('[ChatPlanService] Execution plan generated', {
        provider: response.provider,
        elapsed_ms: elapsed,
        steps: plan.steps.length,
        goal: plan.goal.slice(0, 100),
      });

      return plan;
    } catch (err: any) {
      logger.warn('[ChatPlanService] Plan generation failed, proceeding without plan', {
        error: err.message,
      });
      return undefined;
    }
  }
}
