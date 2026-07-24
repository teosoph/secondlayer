/**
 * Chat EXECUTE phase — fast path, agentic tool loop, fallback synthesis.
 *
 * Extracted from ChatService (CORE-21 decomposition). This is the
 * EXECUTE → REPLAN? → SYNTHESIZE part of the graph pipeline:
 *
 *   FAST PATH?  single-step deterministic plan → pre-execute + pure synthesis
 *   EXECUTE     stream LLM, run tool calls in parallel, budget-gate results
 *   REPLAN?     after consecutive empty rounds, regenerate the plan once
 *   SYNTHESIZE  final answer (or fallback when maxToolCalls is exhausted)
 *
 * The generator yields ChatEvents (SSE) and returns the accumulated
 * ExecutionResult consumed by the VERIFY/persist phases in ChatService.
 */

import { createHash } from 'crypto';
import { logger } from '../utils/logger.js';
import {
  UnifiedMessage,
  ToolDefinitionParam,
  ToolCall,
  type LLMProvider,
} from '@secondlayer/shared';
import { ModelSelector } from '@secondlayer/shared';
import type { ILLMPort, IEmbeddingPort } from '../domain/ports/index.js';
import type { ToolDefinition } from '../api/tool-registry.js';
import type { ExecutionPlan, ChatIntentClassification } from '../prompts/chat-system-prompt.js';
import { generateThinkingDescription } from './thinking-descriptions.js';
import { extractFromToolResult, extractNormsFromAnswer, EvidenceTracker } from './evidence-extractor.js';
import { IncrementalAllowSet } from './incremental-allow-set.js';
import { HighRelevanceTracker, DEEP_DIVE_MIN_SCORE } from './high-relevance-tracker.js';
import { StepConstraintEnforcer } from './step-constraints.js';
import { ToolHealthTracker } from './tool-health-tracker.js';
import { TokenBudgetAllocator } from './token-budget-allocator.js';
import { PipelineMetrics } from './pipeline-metrics.js';
import type { ResultCompactor } from './chat-result-compactor.js';
import type { IntentClassifier } from './chat-intent-classifier.js';
import type { ChatPlanService } from './chat-plan-service.js';
import type { BudgetKey } from './chat-constants.js';
import { VERIFY_BEFORE_STREAM_QUERY_TYPES } from './chat-constants.js';
import { applySupremeCourtFilter } from './search-call-defaults.js';
import { ensureBurdenOfProofNorm, BURDEN_OF_PROOF_SECTION } from './required-norms.js';
import type { ChatEvent } from './chat-service.js';

/** Capabilities the execution phase borrows from ChatService. */
export interface ExecutionDeps {
  llm: ILLMPort;
  embeddingService?: IEmbeddingPort;
  resultCompactor: ResultCompactor;
  intentClassifier: IntentClassifier;
  planService: ChatPlanService;
  toolHealthTracker: ToolHealthTracker;
  executeToolWithCache(call: ToolCall, userId?: string): Promise<{ result: any; cached: boolean }>;
  isEmptyResult(result: any): boolean;
  convertToolDefs(defs: ToolDefinition[]): ToolDefinitionParam[];
  recordStreamingCost(requestId: string, provider: LLMProvider, model: string, usage: any, task: string): void;
}

/** Per-request state assembled by ChatService before the EXECUTE phase. */
export interface ExecutionContext {
  query: string;
  requestId?: string;
  userId?: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  signal?: AbortSignal;
  /** Conversation messages (mutated: tool results and nudges are appended) */
  messages: UnifiedMessage[];
  toolDefs: ToolDefinition[];
  plan?: ExecutionPlan;
  classification: ChatIntentClassification;
  selection: { provider: LLMProvider; model: string };
  /** Resource tier — drives token/cap budgets (TokenBudgetAllocator). */
  effectiveBudget: BudgetKey;
  /** Model tier — drives LLM model selection, decoupled from resource caps. */
  modelTier: BudgetKey;
  limits: ReturnType<TokenBudgetAllocator['toLegacyLimits']>;
  allocator: TokenBudgetAllocator;
  metrics: PipelineMetrics;
  hasApprovedPlan: boolean;
  /**
   * V2 pipeline: the tool set is fixed for the whole turn — the model self-selects
   * from it. Disables REPLAN's plan regeneration + tool expansion, which would
   * otherwise widen the toolset beyond the fixed list.
   */
  lockToolset?: boolean;
}

/** Everything the VERIFY / persist phases need after execution. */
export interface ExecutionResult {
  fullAnswerText: string;
  totalCostUsd: number;
  iteration: number;
  toolsUsed: string[];
  collectedToolCalls: ToolCall[];
  collectedThinkingSteps: Array<{ tool: string; params: any; result: any }>;
  allowSet: IncrementalAllowSet;
  evidence: EvidenceTracker;
  /** CORE-21 P0.3: final answer was withheld from the live stream (high-stakes
   *  queryType) and must be emitted by the caller after verify + repair. */
  finalAnswerDeferred?: boolean;
  /** Provider/model of the deferred final answer, for the caller's answer event. */
  answerMeta?: { provider: LLMProvider; model: string };
  /** CORE-97: the burden-of-proof backstop appended ст. 77 КАС — surfaced as a
   *  telemetry signal; a nonzero prod counter means the prompt regressed. */
  requiredNormAppended?: boolean;
  /** Safety-cap hits this request (CORE-55): per-tool repeat cap / total-call cap. */
  capHitRepeat: number;
  capHitTotal: number;
  /** CORE-101: search_* calls blocked by the high-relevance budget reserve. */
  searchBlockedForPending: number;
  /** CORE-101: get_court_decision deep-dives downgraded to depth 1 (doc scored <8). */
  deepDiveDowngraded: number;
  /** CORE-101: rel≥8 hits still unloaded when the answer was produced. */
  highRelUnloadedAtEnd: number;
  /** Turn telemetry (LEXAI-1803): total LLM streaming/plan calls in the execute phase
   *  (loop rounds + replans + fallback synthesis). Excludes the initial plan-gen call
   *  made in ChatService. */
  llmTurns: number;
  replanCalls: number;
}

/**
 * Validate citation links in the answer text and log warnings for broken ones.
 * Pattern: [label](#doc-ID) where ID should be non-empty and numeric.
 */
function validateCitationLinks(text: string): void {
  const citationPattern = /\[([^\]]+)\]\(#doc-([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = citationPattern.exec(text)) !== null) {
    const [fullMatch, label, docId] = match;
    if (!docId || !/^\d+$/.test(docId)) {
      logger.warn('[ChatService] Broken citation link detected', {
        citation: fullMatch,
        label,
        docId: docId || '(empty)',
      });
    }
  }
}

// Tools where deduplication hashes only on the primary key (e.g. caseNumber),
// ignoring secondary params like groupByInstance, includeFullText, maxDocs.
const COARSE_HASH_TOOLS: Record<string, string[]> = {
  get_case_documents_chain: ['case_number'],
  get_court_decision: ['doc_id', 'case_number'],
  load_full_texts: ['doc_ids'],
};

// Safety caps (CORE-55) — runaway guardrails. Raised after a heavy-query stress
// run (broad surveys + multi-domain + citation-graph): legitimate deep analysis
// reached repeat-max p95≈11.5 and 24-25 tool calls with grounding ~96, so the
// 12/25 caps clipped good requests. 15/30 keeps normal traffic untouched and
// still stops true runaway loops. Iteration cap stays at limits.maxToolCalls.
const TOOL_REPEAT_CAP = 15;      // max executed calls to a single tool per request
const TOTAL_TOOL_CALL_CAP = 30;  // max executed tool calls per request

/**
 * Compute a deduplication key for a tool call.
 * For court-chain tools, hash only the primary key to catch "same query, different flags" loops.
 */
/**
 * Deterministic stringify: sorts object keys recursively WITHOUT dropping any.
 * The previous `JSON.stringify(params, Object.keys(params).sort())` used the
 * replacer-ARRAY form, which whitelists those keys at EVERY nesting level —
 * nested params like search_registry's filters.mark_text were erased from the
 * hash, so two calls differing only in nested filter values collided and the
 * second was wrongly skipped as a duplicate (NEMIROFF demo miss, 2026-07-02).
 */
function stableStringify(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort()
    .map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
    .join(',')}}`;
}

export function toolCallHash(toolName: string, params: Record<string, any>): string {
  const primaryKeys = COARSE_HASH_TOOLS[toolName];
  let payload: string;
  if (primaryKeys) {
    const subset: Record<string, any> = {};
    for (const k of primaryKeys) {
      if (params[k] !== undefined) subset[k] = params[k];
    }
    payload = JSON.stringify(subset);
  } else {
    payload = stableStringify(params);
  }
  const hash = createHash('md5').update(payload).digest('hex').slice(0, 12);
  return `${toolName}:${hash}`;
}

// REPLAN: after this many consecutive all-empty tool rounds, regenerate the plan
const REPLAN_EMPTY_ROUNDS = 2;
// At most one replan per request — prevents plan-thrashing loops
const MAX_REPLANS = 1;

// PARALLEL SEED: pre-execute independent plan steps (depends_on empty) in one
// parallel batch BEFORE the agentic loop, collapsing what would otherwise be
// several sequential model-driven search rounds. Opt-in: CHAT_PARALLEL_SEED_MIN
// is the minimum number of seedable steps required to trigger the batch
// (0 = disabled, default → identical behavior to before). Set to 2 to enable.
const PARALLEL_SEED_MIN = parseInt(process.env.CHAT_PARALLEL_SEED_MIN || '0', 10) || 0;

// Tools safe to pre-execute up front: independent searches/lookups whose params
// derive from the query (keywords/filters), never from a prior step's output.
// Deliberately EXCLUDES fetch-by-id tools (get_court_decision, load_full_texts,
// get_case_documents_chain, get_legislation_article) — those need IDs the model
// extracts from seed results, so they stay in the loop. This allowlist is the
// primary safety gate; the depends_on==empty check is secondary.
const SEED_TOOLS: ReadonlySet<string> = new Set([
  'search_court_decisions',   // unified EDRSR search (mode=fulltext/semantic/structured/hybrid)
  'find_relevant_law_articles',
  'search_legislation',
  'search_procedural_norms',
  'find_similar_fact_pattern_cases',
  'compare_practice_pro_contra',
  'search_supreme_court_practice',
  'search_echr_practice',
  'count_cases_by_party',
  'semantic_search',
]);

// FAST PATH: query types whose single-step plans skip the tool-selection LLM
// round trip — the step is pre-executed and the loop becomes pure synthesis.
// case_lookup is excluded: document chains often need follow-up load_full_texts.
const FAST_PATH_QUERY_TYPES: ReadonlySet<string> = new Set([
  'registry_lookup',
  'legislation_lookup',
  'parliament_query',
]);

// CORE-37: for thematic practice queries, default search_court_decisions to hybrid.
// The model tends to pick mode=fulltext, whose all-token AND match returns nothing for
// verbose/inflected queries (plainto_tsquery + no Ukrainian stemmer). Hybrid's semantic
// leg is far more robust; structured/semantic that the model explicitly chose are kept.
const HYBRID_DEFAULT_QUERY_TYPES: ReadonlySet<string> = new Set([
  'practice_analysis',
  'legal_consultation',
]);
function applySearchModeDefault(call: ToolCall, queryType: string): void {
  if (call.name !== 'search_court_decisions') return;
  if (!HYBRID_DEFAULT_QUERY_TYPES.has(queryType)) return;
  const args = (call.arguments || {}) as Record<string, any>;
  if (!args.mode || args.mode === 'fulltext') {
    args.mode = 'hybrid';
    call.arguments = args;
  }
}


export async function* runExecutionPhase(
  ctx: ExecutionContext,
  deps: ExecutionDeps
): AsyncGenerator<ChatEvent, ExecutionResult> {
  const {
    query, requestId, history, signal, messages, classification,
    selection, modelTier, limits, allocator, metrics,
  } = ctx;
  let plan = ctx.plan;
  let toolDefs = ctx.toolDefs;
  const llm = deps.llm;
  let llmTools = deps.convertToolDefs(toolDefs);

  let iteration = 0;
  let fullAnswerText = '';
  let totalCostUsd = 0;
  // CORE-21 P0.3: for high-stakes query types, withhold the final answer from the
  // live token stream so the caller can verify + repair citations before the user
  // ever sees it. Tool/thinking events still stream; only the final answer is held.
  const deferFinalAnswer = VERIFY_BEFORE_STREAM_QUERY_TYPES.has(classification.queryType);
  let finalAnswerDeferred = false;
  let requiredNormAppended = false;
  let answerMeta: { provider: LLMProvider; model: string } | undefined;
  const toolsUsed: string[] = [];
  const collectedToolCalls: ToolCall[] = [];
  const collectedThinkingSteps: Array<{ tool: string; params: any; result: any }> = [];
  const previousToolCallHashes = new Set<string>();
  // Safety-cap hit counters (CORE-55) — surfaced via ExecutionResult for telemetry.
  let capHitRepeat = 0;
  let capHitTotal = 0;
  // CORE-101 enforcement counters — surfaced via ExecutionResult for telemetry.
  let searchBlockedForPending = 0;
  let deepDiveDowngraded = 0;

  // REPLAN state: regenerate the plan when consecutive rounds yield nothing
  let consecutiveEmptyRounds = 0;
  let replansUsed = 0;
  const emptyCallLog: string[] = [];

  // Turn telemetry (LEXAI-1803): count every LLM streaming/plan call in the execute
  // phase so we can see where a deep chat's ~10 sequential Bedrock calls go
  // (loop tool-select/synthesize rounds + replans + fallback). The initial
  // plan-generation call happens in ChatService, before this phase.
  let llmTurns = 0;

  // Incremental allow-set: build during execution, verify after answer
  const allowSet = new IncrementalAllowSet();
  allowSet.ingestUserQuery(query);

  // CORE-101: track high-relevance search hits that were never loaded, so the
  // loop can reserve budget for them and the synthesis prompts can carry them.
  const relTracker = new HighRelevanceTracker();

  // Step constraints: enforce behavioral rules in code, not prompts.
  // Tier-scaled: deep budgets get higher per-tool call ceilings.
  const constraints = new StepConstraintEnforcer(ctx.effectiveBudget);

  // Cumulative evidence tracking for evidence_update events (Phase 3)
  const evidence = new EvidenceTracker();

  // --- FAST PATH: single-step deterministic plan → pre-execute + pure synthesis ---
  // Eligible queries skip the tool-selection LLM round trip: the plan's only
  // step runs right now, its result goes into context, and the loop below
  // degenerates into a single synthesis call (llmTools emptied). Falls back
  // to the standard loop when the result is empty or the call fails.
  if (
    plan && plan.steps.length === 1 &&
    history.length === 0 &&
    !ctx.hasApprovedPlan &&
    FAST_PATH_QUERY_TYPES.has(classification.queryType)
  ) {
    const step = plan.steps[0];
    yield {
      type: 'thinking',
      data: { step: 1, tool: step.tool, params: step.params, description: step.purpose || 'Виконую запит...' },
    };
    const tFast = metrics.startStage('tool_exec', { iteration: 0, toolName: step.tool });
    try {
      const fastCall: ToolCall = { id: 'fastpath-1', name: step.tool, arguments: step.params };
      const { result: fastResult, cached } = await deps.executeToolWithCache(fastCall, ctx.userId);
      metrics.endStage(tFast, { cached, meta: { tool: step.tool, fastPath: true } });
      const isEmpty = deps.isEmptyResult(fastResult);
      constraints.recordCall(step.tool, isEmpty);
      deps.toolHealthTracker.record(step.tool, isEmpty ? 'empty' : 'success', 0);
      if (!isEmpty) {
        allowSet.ingestToolResult(step.tool, fastResult);
        relTracker.recordCall(step.tool, step.params);
        relTracker.ingestToolResult(step.tool, fastResult);
        collectedToolCalls.push(fastCall);
        collectedThinkingSteps.push({ tool: step.tool, params: step.params, result: fastResult });
        if (!toolsUsed.includes(step.tool)) toolsUsed.push(step.tool);

        const stepBudget = allocator.allocateForStep(1);
        const summarized = deps.resultCompactor.summarize(fastResult, limits, stepBudget.maxResultChars);
        const toolEvidence = extractFromToolResult(step.tool, fastResult);
        yield {
          type: 'tool_result',
          data: { tool: step.tool, result: fastResult, evidence: toolEvidence, cached, cost_usd: 0 },
        };
        evidence.ingest(toolEvidence);
        if (evidence.hasAny) {
          yield { type: 'evidence_update', data: evidence.payload() };
        }

        const resultJson = JSON.stringify(summarized);
        allocator.consume(resultJson.length);
        messages.push({
          role: 'user',
          content: `Результат інструмента ${step.tool}:\n${resultJson}\n\nНа основі цього результату дай повну відповідь на запит користувача. Не викликай інструменти.`,
        });
        llmTools = [];
        logger.info('[ChatService] FAST PATH: pre-executed single-step plan, loop reduced to synthesis', {
          requestId, tool: step.tool, queryType: classification.queryType,
        });
      } else {
        logger.info('[ChatService] FAST PATH: empty result, falling back to standard loop', {
          requestId, tool: step.tool,
        });
      }
    } catch (err: any) {
      metrics.endStage(tFast, { meta: { tool: step.tool, fastPath: true, error: err.message } });
      logger.warn('[ChatService] FAST PATH: tool failed, falling back to standard loop', {
        requestId, tool: step.tool, error: err.message,
      });
    }
  }

  // --- PARALLEL SEED: pre-execute independent plan steps in one batch ---
  // Eligible steps (tool in SEED_TOOLS, no unmet dependencies) run concurrently
  // before the loop. Their results are injected as a valid assistant+tool
  // exchange (so RAG compaction applies) and their hashes are registered for
  // dedup, so the model proceeds to dependent steps (full-text fetches) and
  // synthesis instead of re-issuing the same searches one per round.
  if (
    PARALLEL_SEED_MIN > 0 &&
    plan && plan.steps.length > 1 &&
    history.length === 0 &&
    !ctx.hasApprovedPlan &&
    llmTools.length > 0
  ) {
    const seen = new Set<string>();
    const seedSteps = plan.steps.filter(s => {
      if (!SEED_TOOLS.has(s.tool)) return false;
      if (s.depends_on && s.depends_on.length > 0) return false;
      const h = toolCallHash(s.tool, (s.params || {}) as Record<string, any>);
      if (seen.has(h) || previousToolCallHashes.has(h)) return false;
      seen.add(h);
      return true;
    });

    if (seedSteps.length >= PARALLEL_SEED_MIN) {
      const seedCalls: ToolCall[] = seedSteps.map((s, i) => ({
        id: `seed-${i + 1}`, name: s.tool, arguments: (s.params || {}) as Record<string, any>,
      }));
      seedCalls.forEach(c => { applySearchModeDefault(c, classification.queryType); applySupremeCourtFilter(c, query); });

      for (const call of seedCalls) {
        collectedToolCalls.push(call);
        if (!toolsUsed.includes(call.name)) toolsUsed.push(call.name);
        previousToolCallHashes.add(toolCallHash(call.name, (call.arguments || {}) as Record<string, any>));
        yield {
          type: 'thinking',
          data: {
            step: 1,
            tool: call.name,
            params: call.arguments,
            description: generateThinkingDescription(call.name, call.arguments as Record<string, unknown>),
          },
        };
      }

      const seedTimers = seedCalls.map(call =>
        metrics.startStage('tool_exec', { iteration: 0, toolName: call.name })
      );
      const seedSettled = await Promise.allSettled(
        seedCalls.map(call => deps.executeToolWithCache(call, ctx.userId))
      );

      // One assistant message carrying ALL seed tool_calls, then per-result tool messages.
      messages.push({ role: 'assistant', content: '', tool_calls: seedCalls });

      for (let i = 0; i < seedSettled.length; i++) {
        const outcome = seedSettled[i];
        const call = seedCalls[i];
        const toolResult = outcome.status === 'fulfilled'
          ? outcome.value.result
          : { error: (outcome.reason as Error).message };
        const cached = outcome.status === 'fulfilled' ? outcome.value.cached : false;

        metrics.endStage(seedTimers[i], {
          cached,
          meta: { tool: call.name, success: outcome.status === 'fulfilled', seed: true },
        });

        collectedThinkingSteps.push({ tool: call.name, params: call.arguments, result: toolResult });
        const isError = outcome.status === 'rejected';
        const isEmpty = !isError && deps.isEmptyResult(toolResult);
        constraints.recordCall(call.name, isEmpty);
        deps.toolHealthTracker.record(call.name, isError ? 'error' : isEmpty ? 'empty' : 'success', 0);
        allowSet.ingestToolResult(call.name, toolResult);
        relTracker.recordCall(call.name, call.arguments);
        relTracker.ingestToolResult(call.name, toolResult);

        const remainingSteps = Math.max(0, limits.maxToolCalls - 1);
        const stepBudget = allocator.allocateForStep(remainingSteps);
        const summarized = deps.resultCompactor.summarize(toolResult, limits, stepBudget.maxResultChars);
        const toolEvidence = extractFromToolResult(call.name, toolResult);

        yield {
          type: 'tool_result',
          data: { tool: call.name, result: toolResult, evidence: toolEvidence, cached, cost_usd: 0 },
        };
        evidence.ingest(toolEvidence);
        if (evidence.hasAny) {
          yield { type: 'evidence_update', data: evidence.payload() };
        }

        const resultJson = JSON.stringify(summarized);
        allocator.consume(resultJson.length);
        messages.push({ role: 'tool', content: resultJson, tool_call_id: call.id });
      }

      messages.push({
        role: 'user',
        content: 'Початкові пошуки виконано (результати вище). Якщо для ключових рішень потрібні повні тексти — виклич get_case_documents_chain / load_full_texts / get_court_decision. Інакше перейди до фінального аналізу на основі зібраних даних. Не повторюй уже виконані пошуки з тими самими параметрами.',
      });

      logger.info('[ChatService] PARALLEL SEED: pre-executed independent plan steps', {
        requestId, seeds: seedCalls.map(c => c.name), count: seedCalls.length,
      });
    }
  }

  while (iteration < limits.maxToolCalls) {
    if (signal?.aborted) break;
    if (allocator.isNearlyExhausted() && iteration > 2) {
      logger.info('[ChatService] Budget nearly exhausted — forcing synthesis', {
        iteration, remaining: allocator.remainingChars, spent: allocator.spent,
      });
      // CORE-101: carry unloaded rel≥8 hits into the forced synthesis so the
      // composer grounds on them instead of silently dropping the best result.
      const pendingNote = relTracker.buildPendingNote();
      messages.push({
        role: 'user',
        content:
          'Бюджет контексту майже вичерпано. Перейди до фінального аналізу на основі зібраних даних. Не викликай додаткові інструменти.' +
          (pendingNote
            ? `\n\nНайрелевантніші знайдені пошуком рішення (повний текст не завантажено — обов'язково розглянь їх у відповіді на основі наведених фрагментів):\n${pendingNote}`
            : ''),
      });
    }
    const mIteration = metrics.startStage('iteration', { iteration });

    // Stream LLM response
    let fullContent = '';
    let toolCalls: ToolCall[] = [];
    let finishReason: 'stop' | 'tool_calls' = 'stop';
    let hasToolCallDelta = false;
    let iterationUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let iterationModel = '';
    let iterationProvider: LLMProvider = 'openai';

    // --- Prevention: constrain case citations to the retrieved allow-set (CORE-39) ---
    // The model otherwise invents plausible-looking Ukrainian case numbers during
    // synthesis. Append the ONLY case numbers backed by search results to the
    // SYSTEM prompt (messages[0]) — every provider path reads the first system
    // message, whereas an extra system message mid-array is dropped by the
    // Anthropic/Bedrock adapters (they take messages.find(role==='system') only).
    // Refreshed from the live allow-set each turn and restored right after the call.
    let savedSystemContent: string | null = null;
    if (allowSet.allowedCaseNumbers.size > 0 && messages[0]?.role === 'system') {
      const allowed = [...allowSet.allowedCaseNumbers].slice(0, 100).join(', ');
      savedSystemContent = messages[0].content;
      messages[0] = {
        ...messages[0],
        content:
          `${messages[0].content}\n\n[ОБМЕЖЕННЯ ЦИТУВАННЯ] Цитуй номери судових справ виключно з цього переліку ` +
          `(знайдені пошуком у цьому запиті): ${allowed}. НЕ вигадуй і не наводь жодних інших номерів справ із пам'яті. ` +
          `Якщо потрібної справи немає в переліку — прямо зазнач, що підтверджених справ із цього питання не знайдено.`,
      };
    }

    llmTurns++; // execute-loop round (tool_select or synthesize)
    for await (const chunk of llm.chatCompletionStream(
      {
        messages,
        tools: llmTools.length > 0 ? llmTools : undefined,
        tool_choice: llmTools.length > 0 ? 'auto' : undefined,
        max_tokens: limits.maxTokens,
        temperature: 0.3,
      },
      modelTier,
      selection.provider,
      signal
    )) {
      if (signal?.aborted) break;

      if (chunk.type === 'text_delta' && chunk.text) {
        fullContent += chunk.text;
        // Stream text deltas live — if tool calls follow, the frontend clears partial
        // text on the next 'thinking' event. CORE-21 P0.3: for high-stakes query types
        // we withhold deltas so an unverified answer is never shown (emitted post-verify).
        if (!deferFinalAnswer) {
          yield { type: 'answer_delta', data: { text: chunk.text } };
        }
      }

      if (chunk.type === 'tool_call_delta') {
        hasToolCallDelta = true;
      }

      if (chunk.type === 'usage' && chunk.usage) {
        iterationUsage = chunk.usage;
      }

      if (chunk.type === 'done') {
        finishReason = chunk.finish_reason || 'stop';
        if (chunk.tool_calls) {
          toolCalls = chunk.tool_calls;
          toolCalls.forEach(c => { applySearchModeDefault(c, classification.queryType); applySupremeCourtFilter(c, query); });
        }
        if (chunk.model) iterationModel = chunk.model;
        if (chunk.provider) iterationProvider = chunk.provider;
      }
    }

    // Restore the original system prompt (CORE-39) so the transient citation
    // constraint does not accumulate across iterations or leak into history.
    if (savedSystemContent !== null && messages[0]?.role === 'system') {
      messages[0] = { ...messages[0], content: savedSystemContent };
    }

    if (signal?.aborted) break;

    // Record LLM cost for this iteration
    // Anthropic streaming may not report usage; estimate from content length
    let iterationCostUsd = 0;
    if (requestId && iterationModel) {
      if (iterationUsage.total_tokens > 0) {
        iterationCostUsd = ModelSelector.estimateCostAccurate(iterationModel, iterationUsage.prompt_tokens, iterationUsage.completion_tokens);
      } else {
        // Estimate tokens from content length (~2.2 chars/token for Cyrillic/Ukrainian)
        const estPromptTokens = Math.ceil(messages.reduce((s, m) => s + (m.content?.length || 0), 0) / 2.2);
        const estCompletionTokens = Math.ceil((fullContent.length + JSON.stringify(toolCalls).length) / 2.2);
        iterationCostUsd = ModelSelector.estimateCostAccurate(iterationModel, estPromptTokens, estCompletionTokens);
        iterationUsage = { prompt_tokens: estPromptTokens, completion_tokens: estCompletionTokens, total_tokens: estPromptTokens + estCompletionTokens };
        logger.warn('[ChatService] No usage from streaming, estimated tokens', {
          iteration,
          model: iterationModel,
          provider: iterationProvider,
          estPromptTokens,
          estCompletionTokens,
          estimatedCost: iterationCostUsd,
        });
      }
      totalCostUsd += iterationCostUsd;
      deps.recordStreamingCost(requestId, iterationProvider, iterationModel, iterationUsage, `chat_iteration_${iteration}`);
    }

    // Determine stage type: synthesize (final answer) vs tool_select (choosing tools)
    const isFinalAnswer = finishReason === 'stop' || toolCalls.length === 0;
    const llmStageType = isFinalAnswer ? 'synthesize' : 'tool_select';
    metrics.endStage(mIteration, {
      provider: iterationProvider || undefined,
      model: iterationModel || undefined,
      promptTokens: iterationUsage.prompt_tokens,
      completionTokens: iterationUsage.completion_tokens,
      costUsd: iterationCostUsd,
      meta: { finishReason, toolCallCount: toolCalls.length, stageType: llmStageType },
    });

    // Also record a typed sub-stage for cleaner analysis
    metrics.recordStage(llmStageType as any, {
      startedAt: Date.now() - (iterationCostUsd > 0 ? 1 : 0),
      durationMs: 0,
      provider: iterationProvider || undefined,
      model: iterationModel || undefined,
      promptTokens: iterationUsage.prompt_tokens,
      completionTokens: iterationUsage.completion_tokens,
      costUsd: iterationCostUsd,
      iteration,
    });

    // Final answer — no tool calls
    if (finishReason === 'stop' || toolCalls.length === 0) {
      // CORE-97: required-norm enforcement — a ППР-challenge answer must state the
      // burden-of-proof rule (ч. 2 ст. 77 КАС). The prompt asks for it; this guarantees
      // it. Register the article in the allow-set so VERIFY doesn't strip it back out.
      const normCheck = ensureBurdenOfProofNorm(query, fullContent);
      if (normCheck.appended) {
        fullContent = normCheck.text;
        requiredNormAppended = true;
        allowSet.ingestUserQuery('ст. 77 КАС');
        if (!deferFinalAnswer) {
          yield { type: 'answer_delta', data: { text: `\n\n${BURDEN_OF_PROOF_SECTION}` } };
        }
        logger.info('[ChatService] CORE-97: appended burden-of-proof norm (ст. 77 КАС) to ППР-challenge answer', { requestId });
      }
      fullAnswerText = fullContent;

      // Validate citation links in the final answer
      validateCitationLinks(fullContent);

      // CORE-21 P0.3: high-stakes answer is withheld — the caller emits the `answer`
      // event (with norms + evidence) after verify + citation repair, so no unverified
      // draft is ever shown. Otherwise emit it live as before.
      if (deferFinalAnswer) {
        finalAnswerDeferred = true;
        answerMeta = { provider: selection.provider, model: selection.model };
      } else {
        const answerNorms = extractNormsFromAnswer(fullContent);
        evidence.ingestCitations(answerNorms);
        yield {
          type: 'answer',
          data: {
            text: fullContent,
            provider: selection.provider,
            model: selection.model,
            norms: answerNorms.length > 0 ? answerNorms : undefined,
          },
        };
        // Final evidence_update with norms included
        if (evidence.hasAny) {
          yield { type: 'evidence_update', data: evidence.payload() };
        }
      }
      break;
    }

    // Tool-calling iteration — deduplicate before executing

    // Filter out duplicate tool calls (same tool + same/similar params)
    const uniqueToolCalls: ToolCall[] = [];
    const duplicateToolCalls: ToolCall[] = [];
    for (const call of toolCalls) {
      const hash = toolCallHash(call.name, (call.arguments || {}) as Record<string, any>);
      if (previousToolCallHashes.has(hash)) {
        duplicateToolCalls.push(call);
        logger.warn('[ChatService] Skipping duplicate tool call', {
          tool: call.name,
          hash,
          iteration,
        });
      } else {
        previousToolCallHashes.add(hash);
        uniqueToolCalls.push(call);
      }
    }

    // If ALL tool calls are duplicates, force exit and generate answer from collected data
    if (uniqueToolCalls.length === 0) {
      logger.warn('[ChatService] All tool calls are duplicates — forcing answer generation', {
        iteration,
        duplicates: duplicateToolCalls.map(c => c.name),
      });
      // Push assistant message with the duplicate calls so context is valid,
      // then inject a nudge to synthesize
      messages.push({
        role: 'assistant',
        content: fullContent || '',
        tool_calls: toolCalls,
      });
      // Build per-tool nudge with alternative suggestions
      for (const call of toolCalls) {
        let note = 'Цей інструмент вже було викликано з такими параметрами. Використай наявні результати.';
        if (call.name === 'get_legislation_article') {
          note += ' Якщо потрібний закон не знайдено — спробуй search_legislation або find_relevant_law_articles для пошуку за описом ситуації.';
        } else if (call.name === 'get_court_decision' || call.name === 'get_case_documents_chain') {
          note += ' Якщо потрібна справа не знайдена — спробуй search_court_decisions (mode=fulltext) з іншими ключовими словами.';
        }
        messages.push({
          role: 'tool',
          content: JSON.stringify({ note }),
          tool_call_id: call.id,
        });
      }
      // Detect if duplicate calls include legislation lookups without prior search
      const hasLegislationDupes = duplicateToolCalls.some(c => c.name === 'get_legislation_article');
      const hasUsedSearch = collectedToolCalls.some(c =>
        c.name === 'search_legislation' || c.name === 'find_relevant_law_articles'
      );
      let nudge = 'Дані вже отримано. Перейди до аналізу на основі зібраних результатів. Не повторюй виклики інструментів.';
      if (hasLegislationDupes && !hasUsedSearch) {
        nudge = 'get_legislation_article не дав результату. Спочатку визнач потрібний закон через find_relevant_law_articles або search_legislation, а потім виклич get_legislation_article з отриманим rada_id. Не повторюй попередні виклики.';
      }
      messages.push({
        role: 'user',
        content: nudge,
      });
      // Continue to next iteration — the model should now produce a text answer
      iteration++;
      continue;
    }

    // Replace toolCalls with only unique ones for execution
    toolCalls = uniqueToolCalls;

    // Step 0: Enforce step constraints + health check — filter out blocked/degraded tool calls
    const allowedCalls: ToolCall[] = [];
    for (const call of toolCalls) {
      // Safety caps (CORE-55): bound per-tool repeats and total tool calls per
      // request. Counts include calls already admitted earlier this iteration.
      const sameToolSoFar =
        collectedToolCalls.filter(c => c.name === call.name).length +
        allowedCalls.filter(c => c.name === call.name).length;
      const totalSoFar = collectedToolCalls.length + allowedCalls.length;
      if (sameToolSoFar >= TOOL_REPEAT_CAP) {
        capHitRepeat++;
        logger.warn('[ChatService] Tool repeat cap hit — skipping call', { tool: call.name, cap: TOOL_REPEAT_CAP, iteration });
        messages.push({ role: 'assistant', content: '', tool_calls: [call] });
        messages.push({
          role: 'tool',
          content: JSON.stringify({ note: `Ліміт викликів інструмента ${call.name} (${TOOL_REPEAT_CAP}) досягнуто. Використай вже отримані результати або інший інструмент.` }),
          tool_call_id: call.id,
        });
        continue;
      }
      if (totalSoFar >= TOTAL_TOOL_CALL_CAP) {
        capHitTotal++;
        logger.warn('[ChatService] Total tool-call cap hit — skipping call', { tool: call.name, cap: TOTAL_TOOL_CALL_CAP, iteration });
        messages.push({ role: 'assistant', content: '', tool_calls: [call] });
        messages.push({
          role: 'tool',
          content: JSON.stringify({ note: `Досягнуто загальний ліміт викликів інструментів (${TOTAL_TOOL_CALL_CAP}). Перейди до аналізу на основі зібраних результатів.` }),
          tool_call_id: call.id,
        });
        continue;
      }

      // CORE-101 discipline: a deep dive (depth>1) into a doc whose best known
      // search relevance is <8 burns budget on mediocre documents (repro
      // chat-98f8472e: 4× depth-3 dives on rel 5-7 docs left no budget to load
      // the rel-9 profile decision). Downgrade to depth 1; unknown docs are
      // untouched (e.g. user-provided ids never seen in a search).
      if (call.name === 'get_court_decision') {
        const args = (call.arguments || {}) as Record<string, any>;
        const known = relTracker.bestKnownScore(Number(args.doc_id));
        if (known !== undefined && known < DEEP_DIVE_MIN_SCORE && Number(args.depth) > 1) {
          deepDiveDowngraded++;
          logger.info('[ChatService] CORE-101: deep dive downgraded to depth 1 (doc scored below threshold)', {
            requestId, docId: args.doc_id, relevance: known, requestedDepth: args.depth,
          });
          args.depth = 1;
          call.arguments = args;
        }
      }

      // CORE-101 reserve: near the iteration cap, while a rel≥8 search hit is
      // still unloaded, new searches are blocked — the remaining budget belongs
      // to loading that hit (or to synthesis). Prevents the repro's terminal
      // pattern: the final round spent on another search whose rank-1 result
      // could never be loaded.
      if (relTracker.hasPending && iteration >= limits.maxToolCalls - 2 && call.name.startsWith('search_')) {
        searchBlockedForPending++;
        const top = relTracker.pendingHits()[0];
        logger.warn('[ChatService] CORE-101: search blocked — budget reserved for pending high-relevance hit', {
          requestId, tool: call.name, iteration,
          pendingDocId: top.docId, pendingCase: top.caseNumber, pendingScore: top.score,
        });
        messages.push({ role: 'assistant', content: '', tool_calls: [call] });
        messages.push({
          role: 'tool',
          content: JSON.stringify({
            note:
              `Бюджет інструментів майже вичерпано — нові пошуки заблоковано. Спочатку завантаж найрелевантніше ` +
              `вже знайдене рішення: справа ${top.caseNumber ?? ''} (doc_id ${top.docId}, релевантність ${top.score}/10) ` +
              `через get_court_decision, або переходь до фінального аналізу з обов'язковим використанням цього рішення.`,
          }),
          tool_call_id: call.id,
        });
        continue;
      }

      // Check step constraints first
      const check = constraints.check(call.name, classification.queryType);
      if (!check.allowed) {
        messages.push({
          role: 'assistant',
          content: '',
          tool_calls: [call],
        });
        messages.push({
          role: 'tool',
          content: JSON.stringify({ note: constraints.buildNudge(call.name, 'blocked', classification.queryType) }),
          tool_call_id: call.id,
        });
        continue;
      }

      // Check cross-request health: skip tools with >80% empty rate
      if (deps.toolHealthTracker.isDegraded(call.name)) {
        const health = deps.toolHealthTracker.getHealth(call.name);
        const fallback = constraints.getFallbackSuggestion(call.name);
        logger.warn('[ChatService] Skipping degraded tool', {
          tool: call.name, emptyRate: health?.emptyRate, fallback,
        });
        messages.push({
          role: 'assistant',
          content: '',
          tool_calls: [call],
        });
        messages.push({
          role: 'tool',
          content: JSON.stringify({
            note: `Інструмент ${call.name} тимчасово недоступний (висока частка порожніх відповідей).${fallback ? ` Спробуй: ${fallback}` : ' Використай наявні результати.'}`,
          }),
          tool_call_id: call.id,
        });
        continue;
      }

      allowedCalls.push(call);
    }
    if (allowedCalls.length === 0) {
      // All calls blocked — nudge synthesis
      messages.push({
        role: 'user',
        content: 'Усі запитані інструменти вже досягли ліміту викликів. Перейди до аналізу на основі наявних результатів.',
      });
      iteration++;
      continue;
    }
    toolCalls = allowedCalls;

    // Step 1: Emit all thinking events upfront
    for (const call of toolCalls) {
      collectedToolCalls.push(call);
      if (!toolsUsed.includes(call.name)) toolsUsed.push(call.name);
      yield {
        type: 'thinking',
        data: {
          step: iteration + 1,
          tool: call.name,
          params: call.arguments,
          description: generateThinkingDescription(call.name, call.arguments as Record<string, unknown>),
          cost_usd: iterationCostUsd,
        },
      };
    }

    // Step 2: Execute all tools in parallel
    const toolExecTimers = toolCalls.map(call =>
      metrics.startStage('tool_exec', { iteration, toolName: call.name })
    );
    const settled = await Promise.allSettled(
      toolCalls.map(call => deps.executeToolWithCache(call, ctx.userId))
    );
    for (let ti = 0; ti < settled.length; ti++) {
      const outcome = settled[ti];
      metrics.endStage(toolExecTimers[ti], {
        cached: outcome.status === 'fulfilled' ? outcome.value.cached : false,
        meta: {
          tool: toolCalls[ti].name,
          success: outcome.status === 'fulfilled',
          error: outcome.status === 'rejected' ? (outcome.reason as Error).message : undefined,
        },
      });
    }

    // Step 3: Build correct message format — ONE assistant message with ALL tool_calls
    messages.push({
      role: 'assistant',
      content: fullContent || '',
      tool_calls: toolCalls,
    });

    // Step 4: Yield results and append individual tool result messages
    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i];
      const call = toolCalls[i];

      const toolResult = outcome.status === 'fulfilled'
        ? outcome.value.result
        : { error: (outcome.reason as Error).message };
      const cached = outcome.status === 'fulfilled' ? outcome.value.cached : false;

      collectedThinkingSteps.push({ tool: call.name, params: call.arguments, result: toolResult });

      const isError = outcome.status === 'rejected';
      const isEmpty = !isError && deps.isEmptyResult(toolResult);
      // Record constraint call count (with empty flag) + health tracking
      constraints.recordCall(call.name, isEmpty);
      deps.toolHealthTracker.record(
        call.name,
        isError ? 'error' : isEmpty ? 'empty' : 'success',
        0 // latency tracked separately via metrics
      );

      // Ingest into incremental allow-set immediately (not post-hoc)
      allowSet.ingestToolResult(call.name, toolResult);
      relTracker.recordCall(call.name, call.arguments);
      relTracker.ingestToolResult(call.name, toolResult);

      // Dynamic per-step budget: allocator distributes remaining context
      // proportionally across the remaining expected tool calls.
      const remainingSteps = Math.max(0, limits.maxToolCalls - iteration - 1);
      const stepBudget = allocator.allocateForStep(remainingSteps);
      const summarized = deps.resultCompactor.summarize(toolResult, limits, stepBudget.maxResultChars);

      // Extract evidence server-side and include in tool_result event.
      // The FULL result is kept for backward compatibility; `evidence` is the new field.
      const toolEvidence = extractFromToolResult(call.name, toolResult);

      yield {
        type: 'tool_result',
        data: {
          tool: call.name,
          result: toolResult,
          evidence: toolEvidence,
          cached,
          cost_usd: iterationCostUsd,
        },
      };

      // Accumulate cumulative evidence (deduplicated) for evidence_update
      evidence.ingest(toolEvidence);
      if (evidence.hasAny) {
        yield { type: 'evidence_update', data: evidence.payload() };
      }

      const resultJson = JSON.stringify(summarized);
      allocator.consume(resultJson.length);
      messages.push({
        role: 'tool',
        content: resultJson,
        tool_call_id: call.id,
      });
    }

    // Nudge on empty results: suggest fallback tools so the LLM doesn't retry the same tool
    const emptyTools = toolCalls.filter((call, idx) => {
      if (settled[idx].status === 'rejected') return false;
      return deps.isEmptyResult(settled[idx].status === 'fulfilled' ? (settled[idx] as PromiseFulfilledResult<any>).value.result : null);
    });
    for (const call of emptyTools) {
      const nudge = constraints.buildNudge(call.name, 'empty', classification.queryType);
      if (nudge) {
        messages.push({ role: 'user', content: nudge });
      }
    }

    // --- REPLAN node ---
    // Track rounds where every tool call came back empty or failed. After
    // REPLAN_EMPTY_ROUNDS such rounds, regenerate the plan (once per request)
    // with the failed calls as context, instead of relying on nudges alone.
    if (toolCalls.length > 0) {
      const rejectedCount = settled.filter(s => s.status === 'rejected').length;
      const productiveCalls = toolCalls.length - emptyTools.length - rejectedCount;
      if (productiveCalls <= 0) {
        consecutiveEmptyRounds++;
        for (const call of emptyTools) {
          emptyCallLog.push(`- ${call.name}(${JSON.stringify(call.arguments ?? {}).slice(0, 200)})`);
        }
      } else {
        consecutiveEmptyRounds = 0;
      }
    }

    if (
      !ctx.lockToolset &&
      consecutiveEmptyRounds >= REPLAN_EMPTY_ROUNDS &&
      replansUsed < MAX_REPLANS &&
      iteration < limits.maxToolCalls - 2
    ) {
      replansUsed++;
      consecutiveEmptyRounds = 0;
      const mReplan = metrics.startStage('replan', { iteration });
      yield {
        type: 'thinking',
        data: { step: iteration, tool: '_replan', description: 'Результати порожні — змінюю стратегію пошуку...' },
      };
      const replanNote = [...new Set(emptyCallLog)].slice(-10).join('\n');
      llmTurns++; // replan = 1 plan-generation LLM call
      const newPlan = await deps.planService.generateExecutionPlan(query, classification, toolDefs, requestId, replanNote);
      if (newPlan && newPlan.steps.length > 0) {
        plan = newPlan;
        toolDefs = await deps.intentClassifier.expandToolsFromPlan(toolDefs, newPlan);
        llmTools = deps.convertToolDefs(toolDefs);
        messages.push({
          role: 'user',
          content: `Попередні пошуки повернули порожні результати, тому план оновлено. Нові кроки:\n${newPlan.steps.map(s => `${s.id}. ${s.tool} — ${s.purpose}`).join('\n')}\nВиконуй нові кроки. Не повторюй попередні виклики з тими самими параметрами.`,
        });
        metrics.endStage(mReplan, {
          meta: { steps: newPlan.steps.length, emptyCalls: emptyCallLog.length, tools: newPlan.steps.map(s => s.tool) },
        });
        logger.info('[ChatService] REPLAN: regenerated plan after empty rounds', {
          requestId,
          emptyCalls: emptyCallLog.length,
          newSteps: newPlan.steps.map(s => s.tool),
        });
      } else {
        metrics.endStage(mReplan, { meta: { failed: true, emptyCalls: emptyCallLog.length } });
        logger.warn('[ChatService] REPLAN: plan regeneration returned no steps', { requestId });
      }
    }

    // After first tool execution round, nudge the model to synthesize —
    // but ONLY if there is no multi-step plan that requires further tool calls.
    if (iteration === 0 && settled.some(o => o.status === 'fulfilled')) {
      const planExpectsMoreSteps = plan && plan.steps.length > 1;
      if (planExpectsMoreSteps) {
        messages.push({
          role: 'user',
          content: 'Перший крок виконано. Продовжуй план — виконай наступні кроки. Якщо всі кроки завершено, перейди до фінального аналізу.',
        });
      } else {
        messages.push({
          role: 'user',
          content: 'Дані вже отримано. Якщо потрібні додаткові інструменти (наприклад, load_full_texts для завантаження повних текстів) — виклич їх. Інакше перейди до аналізу на основі зібраних результатів.',
        });
      }
    }

    // Document fallback nudge: if list_documents with query returned 0 docs, hint to retry without query
    if (iteration === 0) {
      const hasEmptyDocSearch = settled.some((outcome, idx) => {
        if (outcome.status !== 'fulfilled') return false;
        const call = toolCalls[idx];
        if (call.name !== 'list_documents') return false;
        const result = outcome.value.result;
        const resultText = typeof result === 'string' ? result : JSON.stringify(result);
        const hasQuery = call.arguments?.query && String(call.arguments.query).trim().length > 0;
        return hasQuery && resultText.includes('"total":0');
      });
      if (hasEmptyDocSearch) {
        messages.push({
          role: 'user',
          content: 'УВАГА: list_documents з ключовими словами повернув 0 документів. Це може означати що документи мають інші назви. Обовʼязково виклич list_documents(query="", limit=50) щоб побачити ВСІ документи, і semantic_search для пошуку по змісту.',
        });
      }
    }

    // RAG compaction: trigger by context size OR allocator budget exhaustion.
    // LEXAI-877: EDRSR fulltext results grow context fast (50K+ per doc).
    const totalContextChars = messages.reduce((sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0), 0);
    const estimatedPromptTokens = Math.ceil(totalContextChars / 2.2);
    const shouldCompact = estimatedPromptTokens > limits.maxPromptTokens || allocator.isNearlyExhausted();
    if (deps.embeddingService && shouldCompact) {
      const toolMessages = messages.filter(m => m.role === 'tool');
      if (toolMessages.length >= 2) {
        logger.info('[ChatService] Triggering RAG compaction', {
          iteration,
          estimatedPromptTokens,
          maxPromptTokens: limits.maxPromptTokens,
          allocatorRemaining: allocator.remainingChars,
          allocatorSpent: allocator.spent,
          toolMessageCount: toolMessages.length,
        });
        const toolContents = toolMessages.map(m => ({
          tool: (m as any).tool_call_id || 'unknown',
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        }));
        const mRag = metrics.startStage('rag_compact', { iteration });
        const ragBudget = Math.min(limits.maxResultChars, allocator.remainingChars);
        const compacted = await deps.resultCompactor.ragCompact(query, toolContents, ragBudget);
        metrics.endStage(mRag, { meta: { toolMessages: toolMessages.length, estimatedPromptTokens } });
        let compIdx = 0;
        for (const msg of messages) {
          if (msg.role === 'tool' && compIdx < compacted.length) {
            msg.content = compacted[compIdx].content;
            compIdx++;
          }
        }
      }
    }

    iteration++;
  }

  // If loop exhausted MAX_TOOL_CALLS without a final answer, generate fallback
  if (!fullAnswerText && collectedThinkingSteps.length > 0 && !signal?.aborted) {
    logger.warn('[ChatService] Agentic loop exhausted maxToolCalls without final answer', {
      iterations: iteration,
      toolCalls: collectedToolCalls.length,
      maxToolCalls: limits.maxToolCalls,
    });
    // Attempt one more LLM call without tools to force a text answer
    try {
      const summaryPrompt = collectedThinkingSteps
        .map(s => `[${s.tool}]: ${JSON.stringify(s.result).slice(0, 2000)}`)
        .join('\n\n');
      // CORE-101: the exhausted-budget path is exactly where the repro lost the
      // rel-9 profile decision — inject the pending hits' evidence chunks so the
      // fallback composer can cite them (their case numbers are already in the
      // allow-set, so VERIFY will not strip them).
      const pendingNote = relTracker.buildPendingNote();
      messages.push({
        role: 'user',
        content:
          `На основі зібраних даних дай повну аналітичну відповідь. Не викликай інструменти.` +
          (pendingNote
            ? `\n\nНайрелевантніші підтверджені пошуком рішення (обов'язково розглянь їх на основі наведених фрагментів):\n${pendingNote}`
            : '') +
          `\n\nЗібрані дані:\n${summaryPrompt.slice(0, allocator.fallbackContextChars)}`,
      });
      let fallbackContent = '';
      llmTurns++; // fallback synthesis after maxToolCalls exhausted
      for await (const chunk of llm.chatCompletionStream(
        { messages, max_tokens: limits.maxTokens, temperature: 0.3 },
        modelTier,
        selection.provider,
        signal
      )) {
        if (signal?.aborted) break;
        if (chunk.type === 'text_delta' && chunk.text) {
          fallbackContent += chunk.text;
          if (!deferFinalAnswer) {
            yield { type: 'answer_delta', data: { text: chunk.text } };
          }
        }
      }
      if (fallbackContent) {
        // CORE-97: same required-norm enforcement as the main final-answer path.
        const normCheck = ensureBurdenOfProofNorm(query, fallbackContent);
        if (normCheck.appended) {
          fallbackContent = normCheck.text;
          requiredNormAppended = true;
          allowSet.ingestUserQuery('ст. 77 КАС');
          if (!deferFinalAnswer) {
            yield { type: 'answer_delta', data: { text: `\n\n${BURDEN_OF_PROOF_SECTION}` } };
          }
          logger.info('[ChatService] CORE-97: appended burden-of-proof norm (ст. 77 КАС) to fallback answer', { requestId });
        }
        fullAnswerText = fallbackContent;
        // CORE-21 P0.3: same deferral as the main path — withhold the high-stakes
        // answer; the caller emits it after verify + repair.
        if (deferFinalAnswer) {
          finalAnswerDeferred = true;
          answerMeta = { provider: selection.provider, model: selection.model };
        } else {
          const fallbackNorms = extractNormsFromAnswer(fallbackContent);
          evidence.ingestCitations(fallbackNorms);
          yield {
            type: 'answer',
            data: {
              text: fallbackContent,
              provider: selection.provider,
              model: selection.model,
              norms: fallbackNorms.length > 0 ? fallbackNorms : undefined,
            },
          };
          if (evidence.hasAny) {
            yield { type: 'evidence_update', data: evidence.payload() };
          }
        }
      }
    } catch (fallbackErr: any) {
      logger.warn('[ChatService] Fallback answer generation failed', { error: fallbackErr.message });
    }
  }


  // Turn telemetry (LEXAI-1803): breakdown of the execute-phase LLM calls so we can see
  // where a deep chat's sequential Bedrock round-trips go (loop rounds + replans + fallback).
  logger.info('[ChatService] Execute-phase LLM turns', {
    requestId,
    llmTurns,
    loopIterations: iteration,
    replans: replansUsed,
    toolCalls: collectedToolCalls.length,
    maxToolCalls: limits.maxToolCalls,
  });

  return {
    fullAnswerText, totalCostUsd, iteration, toolsUsed,
    collectedToolCalls, collectedThinkingSteps, allowSet, evidence,
    finalAnswerDeferred, requiredNormAppended, answerMeta, capHitRepeat, capHitTotal,
    searchBlockedForPending, deepDiveDowngraded,
    highRelUnloadedAtEnd: relTracker.pendingHits().length,
    llmTurns, replanCalls: replansUsed,
  };
}
