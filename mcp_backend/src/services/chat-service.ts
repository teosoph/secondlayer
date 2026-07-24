/**
 * ChatService — Agentic LLM loop for the /api/chat endpoint.
 *
 * Flow:
 * 1. Classify user intent → filter tools to relevant subset
 * 2. Anthropic pre-analysis: generate response template (structure, legal norms, strategy)
 * 3. Inject template into system prompt for the main LLM
 * 4. Stream LLM response with function calling / tool_use
 * 5. Execute tool calls via ToolRegistry
 * 6. Feed results back → loop until LLM produces final answer
 * 7. Stream token-level events to client via SSE
 */

import { createHash, randomBytes } from 'crypto';
import { logger } from '../utils/logger.js';


import { ToolRegistry, ToolDefinition } from '../api/tool-registry.js';
import { QueryPlanner } from './query-planner.js';
import { generateThinkingDescription } from './thinking-descriptions.js';
import { CostTracker } from './cost-tracker.js';
import { ConversationService } from './conversation-service.js';
import {
  UnifiedMessage,
  ToolDefinitionParam,
  ToolCall,
  type LLMProvider,
} from '@secondlayer/shared';
import { ModelSelector } from '@secondlayer/shared';
import type { IEmbeddingPort, ILLMPort } from '../domain/ports/index.js';
import {
  buildPlanGenerationMessages,
  ExecutionPlan,
  type QueryType,
  type ChatIntentClassification,
} from '../prompts/chat-system-prompt.js';
import { QUERY_TYPE_CONFIG } from '../prompts/query-type-config.js';
import { ChatSearchCacheService, isCourtSearchTool } from './chat-search-cache-service.js';
import type { ShepardizationService, ShepardizationResult } from './shepardization-service.js';
import { extractAllEvidence, extractFromToolResult, extractNormsFromAnswer, EvidenceTracker } from './evidence-extractor.js';

import { CASE_NUMBER_REGEX, type BudgetKey } from './chat-constants.js';
import { TokenBudgetAllocator } from './token-budget-allocator.js';
import { IncrementalAllowSet } from './incremental-allow-set.js';
import { verifyAnswerNode, sanitizeAnswerForPersistence, repairFabricatedCitations, repairUnsupportedCitations } from './chat-answer-verification.js';
import { isSimpleDocumentListQuery, runDocumentListingFastPath } from './chat-document-listing.js';
import { ToolHealthTracker } from './tool-health-tracker.js';
import { StepConstraintEnforcer } from './step-constraints.js';
import { IntentClassifier } from './chat-intent-classifier.js';
import { ResultCompactor } from './chat-result-compactor.js';
import { ChatContextBuilder } from './chat-context-builder.js';
import type { WorkflowGeneratorService } from './workflow-generator-service.js';
import type { WorkflowService } from './workflow-service.js';
import { NameVariationService } from './name-variation-service.js';
import { PipelineMetrics } from './pipeline-metrics.js';
import { ChatPlanService } from './chat-plan-service.js';
import { runExecutionPhase, type ExecutionDeps } from './chat-execution-loop.js';

// ============================
// Types
// ============================

export interface ChatEvent {
  type: 'plan' | 'thinking' | 'tool_result' | 'answer_delta' | 'answer' | 'citation_warning' | 'answer_corrected' | 'complete' | 'error' | 'budget_escalated' | 'evidence_update' | 'pipeline_metrics';
  data: any;
}

export interface ChatRequest {
  query: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  budget?: 'quick' | 'standard' | 'deep';
  /** Budget ceiling — prevents escalation above this tier (useful for load testing) */
  maxBudget?: 'quick' | 'standard' | 'deep';
  conversationId?: string;
  userId?: string;
  requestId?: string;
  signal?: AbortSignal;
  /** Pre-approved plan with per-step depth choices — skips plan generation */
  approvedPlan?: ExecutionPlan;
  /** Session ID from a prior /api/chat/plan call — reuses cached classification */
  planSessionId?: string;
  /** If true, allow auto-escalation to deep budget without user confirmation */
  allowDeepEscalation?: boolean;
}


// ============================
// Constants
// ============================

const CITATION_CHECK_TIMEOUT_MS = 5_000;

/**
 * CHAT PIPELINE V2/V3 — the fixed tool set exposed to the model.
 *
 * v2 drops the v1 tool-selection machinery (classify → filterTools → plan →
 * expand). Instead, every chat turn hands the model this fixed set of
 * legal-search tools and lets it decide which to call for the task.
 *
 * V3 (CORE-53): curated to the EDRSR court registry + Ukrainian legislation
 * surface — only simple, direct tools. Deliberately excludes ops/admin/bulk
 * tools and heavy agentic builders, and drops the deprecated
 * search_legal_precedents (always returns 0; the real practice search is
 * search_court_decisions with mode=hybrid/semantic/fulltext/structured).
 */
const FIXED_V2_TOOLS = new Set<string>([
  // ── Законодавство України ──
  'search_legislation',            // semantic search over law articles
  'get_legislation_section',       // article / section text
  'get_legislation_articles',      // multiple articles by range
  'get_legislation_structure',     // act table of contents
  'list_legislation_editions',     // list of historical editions/dates
  'get_legislation_history',       // amendment history of act/article
  // ── ЄДРСР / судова практика ──
  'search_court_decisions',        // core practice search (110M+ decisions)
  'get_court_decision',            // full decision text
  'get_case_documents_chain',      // case chain — upheld / overruled
  'load_full_texts',               // batch full-text fetch
  'find_similar_fact_pattern_cases', // similar fact-pattern cases
  'compare_practice_pro_contra',   // pro/contra practice comparison
  'count_cases_by_party',          // case counts by party
  'check_precedent_status',        // is a cited precedent still valid
  'get_citation_graph',            // decision→article citation graph (Neo4j backend, CORE-56)
  // ── Реєстри / інтелектуальна власність ──
  'search_registry',               // державні реєстри, зокрема торговельні марки/патенти (Укрпатент/УІПВ)
  // ── Парламент / законодавчий намір ──
  'rada_search_bill_documents',    // супровідні документи законопроєктів: висновки ГНЕУ, комітетів, ГЮУ
]);

/**
 * Which chat pipeline to run. Defaults to v2 (fixed toolset, model self-selects).
 * Roll back to the full v1 machinery without redeploying code by setting
 * CHAT_PIPELINE=v1 (or CHAT_PIPELINE_V2=false) in the environment.
 */
function useV2Pipeline(): boolean {
  const pipeline = (process.env.CHAT_PIPELINE || '').trim().toLowerCase();
  if (pipeline === 'v1') return false;
  if (pipeline === 'v2') return true;
  if ((process.env.CHAT_PIPELINE_V2 || '').trim().toLowerCase() === 'false') return false;
  return true; // default: v2
}

/** V3 telemetry (CORE-55) — emitted once per chat request for Prometheus. */
export interface ChatTelemetry {
  queryType: string;
  /** 0..100 composite grounding score derived from verify-phase signals. */
  groundingScore: number;
  signals: {
    fabricatedCases: number;
    fabricatedArticles: number;
    lowRelevance: number;
    subjectMismatch: number;
    ungroundedQuotes: number;
    /** CORE-102: answer stated a case outcome its dispositive contradicts. */
    outcomeMismatch?: number;
    /** CORE-103: norm attributed to a case without a matching citation-graph edge (warn-only). */
    normAttributionMismatch?: number;
    /** CORE-108: foreign-case document cited in an instance-chain row (warn-only). */
    chainAttributionMismatch?: number;
    /** CORE-97: 1 when the burden-of-proof backstop had to append ст. 77 КАС —
     *  a nonzero prod counter means the prompt regressed. */
    requiredNormAppended?: number;
    /** CORE-101: search_* calls blocked by the high-relevance budget reserve. */
    searchBlockedForPending?: number;
    /** CORE-101: deep dives downgraded to depth 1 (doc scored <8). */
    deepDiveDowngraded?: number;
    /** CORE-101: rel≥8 hits still unloaded when the answer was produced. */
    highRelUnloaded?: number;
  };
  /** agentic-loop iterations used (thrashing/efficiency signal). */
  iterations: number;
  /** total tool calls executed this request. */
  toolCalls: number;
  /** max calls to any single tool name — repeats with varying params (thrashing). */
  toolRepeatMax: number;
  /** safety-cap hits this request: per-tool repeat cap / total-call cap (CORE-55). */
  capHits: { repeat: number; total: number };
}

/** Composite grounding score: 100 minus weighted penalties per fabricated/ungrounded signal. */
function computeGroundingScore(s: ChatTelemetry['signals']): number {
  const penalty =
    s.fabricatedCases * 25 +
    s.fabricatedArticles * 15 +
    s.ungroundedQuotes * 15 +
    (s.outcomeMismatch ?? 0) * 15 +
    s.subjectMismatch * 10 +
    s.lowRelevance * 5;
  return Math.max(0, 100 - penalty);
}

/** Highest number of calls to a single tool name (thrashing proxy). */
function maxToolRepeat(calls: Array<{ name: string }>): number {
  const counts = new Map<string, number>();
  let max = 0;
  for (const c of calls) {
    const n = (counts.get(c.name) || 0) + 1;
    counts.set(c.name, n);
    if (n > max) max = n;
  }
  return max;
}




// ============================
// Service
// ============================

export class ChatService {
  private intentClassifier: IntentClassifier;
  private planService: ChatPlanService;
  private resultCompactor: ResultCompactor;
  private contextBuilder: ChatContextBuilder;
  private nameVariationService: NameVariationService;
  private toolGroupMetricsCallback?: (groups: string) => void;
  private chatTelemetryCallback?: (t: ChatTelemetry) => void;
  private toolHealthTracker = new ToolHealthTracker();

  constructor(
    private toolRegistry: ToolRegistry,
    private queryPlanner: QueryPlanner,
    private costTracker: CostTracker,
    private llm: ILLMPort,
    private searchCache?: ChatSearchCacheService,
    private conversationService?: ConversationService,
    private shepardizationService?: ShepardizationService,
    private embeddingService?: IEmbeddingPort,
    private workflowGenerator?: WorkflowGeneratorService,
    private workflowService?: WorkflowService
  ) {
    // Wire up cost recorder adapter for sub-modules
    const costRecorder = {
      recordStreamingCost: (requestId: string, provider: string, model: string, usage: any, task: string) => {
        this.recordStreamingCost(requestId, provider as LLMProvider, model, usage, task);
      },
    };

    this.intentClassifier = new IntentClassifier(toolRegistry, queryPlanner, llm, costRecorder);
    this.planService = new ChatPlanService(this.intentClassifier, toolRegistry, llm, costRecorder);
    this.resultCompactor = new ResultCompactor(embeddingService);
    this.contextBuilder = new ChatContextBuilder(llm, costRecorder);
    this.nameVariationService = new NameVariationService(llm);

  }

  setToolGroupMetricsCallback(cb: (groups: string) => void): void {
    this.toolGroupMetricsCallback = cb;
  }

  /** V3 telemetry (CORE-55): receive one ChatTelemetry record per request for Prometheus. */
  setChatTelemetryCallback(cb: (t: ChatTelemetry) => void): void {
    this.chatTelemetryCallback = cb;
  }

  /** Capabilities the EXECUTE phase (chat-execution-loop.ts) borrows from this service. */
  private executionDeps(): ExecutionDeps {
    return {
      llm: this.llm,
      embeddingService: this.embeddingService,
      resultCompactor: this.resultCompactor,
      intentClassifier: this.intentClassifier,
      planService: this.planService,
      toolHealthTracker: this.toolHealthTracker,
      executeToolWithCache: (call, userId) => this.executeToolWithCache(call, userId),
      isEmptyResult: (result) => this.isEmptyResult(result),
      convertToolDefs: (defs) => this.convertToolDefs(defs),
      recordStreamingCost: (requestId, provider, model, usage, task) =>
        this.recordStreamingCost(requestId, provider, model, usage, task),
    };
  }

  /** Phase 1 of the two-phase flow — delegated to ChatPlanService. */
  async generatePlanForReview(
    query: string,
    budget: 'quick' | 'standard' | 'deep' = 'standard',
    userId?: string,
    requestId?: string
  ) {
    return this.planService.generatePlanForReview(query, budget, userId, requestId);
  }

  /**
   * Run the agentic chat loop. Yields ChatEvents for SSE streaming.
   *
   * Dispatches to the v2 pipeline (default — fixed toolset, model self-selects)
   * or the legacy v1 pipeline (classify → filterTools → plan → expand). Roll back
   * to v1 at runtime with CHAT_PIPELINE=v1 (no code redeploy needed).
   */
  async *chat(request: ChatRequest): AsyncGenerator<ChatEvent> {
    if (useV2Pipeline()) {
      yield* this.chatV2(request);
    } else {
      yield* this.chatV1(request);
    }
  }

  /**
   * CHAT PIPELINE V2 — fixed toolset, model self-selects (Opus).
   *
   * Skips the v1 tool-selection machinery (classify → filterTools → plan →
   * expand) and the unsupported / institutional / document-listing short-circuits.
   * Every turn hands the Opus model the fixed FIXED_V2_TOOLS set and lets it
   * decide which tools to call. Plan-based tool gating is disabled downstream via
   * lockToolset, so the agentic loop never widens beyond these tools. VERIFY +
   * citation repair + persistence are unchanged from v1.
   */
  private async *chatV2(request: ChatRequest): AsyncGenerator<ChatEvent> {
    const { query, history = [], signal, requestId } = request;
    const startTime = Date.now();
    const metrics = new PipelineMetrics(requestId || `anon-${Date.now()}`, query);

    // Auto-create conversation if userId is present but no conversationId was provided
    if (this.conversationService && request.userId && !request.conversationId) {
      try {
        const titlePreview = query.slice(0, 80) || 'New conversation';
        const conv = await this.conversationService.createConversation(request.userId, titlePreview, { requestId });
        request.conversationId = conv.id;
        logger.info('[ChatService] Auto-created conversation for request without conversationId', {
          conversationId: conv.id,
          userId: request.userId,
          requestId,
        });
      } catch (e) {
        logger.warn('[ChatService] Failed to auto-create conversation', { error: (e as Error).message });
      }
    } else if (this.conversationService && request.conversationId && requestId) {
      // Link request_id to existing conversation for log traceability
      this.conversationService.updateRequestId(request.conversationId, requestId).catch(() => {});
    }

    // Create cost tracking record if requestId provided
    if (requestId) {
      try {
        await this.costTracker.createTrackingRecord({
          requestId,
          toolName: 'ai_chat',
          userId: request.userId,
          userQuery: query,
          queryParams: { budget: request.budget || 'deep', conversationId: request.conversationId },
        });
      } catch (e) {
        logger.warn('[ChatService] Failed to create tracking record', { error: (e as Error).message });
      }
    }

    // Emit early thinking event so client sees immediate feedback
    yield {
      type: 'thinking',
      data: { step: 0, tool: '_init', description: 'Аналізую запит...' },
    };

    try {
      // ============================================================
      // CHAT PIPELINE V2 — fixed toolset, model self-selects.
      // ============================================================

      // Fixed tool set exposed to the model.
      const allToolDefs = await this.toolRegistry.getAllToolDefinitions();
      const toolDefs: ToolDefinition[] = allToolDefs.filter(d => FIXED_V2_TOOLS.has(d.name));
      const missingTools = [...FIXED_V2_TOOLS].filter(n => !toolDefs.some(d => d.name === n));
      if (missingTools.length > 0) {
        logger.warn('[ChatService] V2: some fixed tools are not registered in ToolRegistry', { missingTools });
      }

      // Synthetic classification — no LLM classify call. legal_consultation gives a
      // hybrid default for search_court_decisions (robust full-text/semantic mix) and
      // streams the answer live (not in VERIFY_BEFORE_STREAM_QUERY_TYPES).
      const classification: ChatIntentClassification = {
        domains: ['court', 'legislation'],
        keywords: query,
        slots: {},
        queryType: 'legal_consultation',
      };
      // No plan in v2 — the model drives tool selection itself.
      const plan: ExecutionPlan | undefined = undefined;

      // V2 always runs Opus (deep model tier) with deep resource caps, so the
      // model has room to chain searches itself.
      const effectiveBudget: BudgetKey = 'deep';
      const modelTier: BudgetKey = 'deep';
      const selection = ModelSelector.getModelSelection(modelTier);

      logger.info('[ChatService] Starting V2 agentic loop', {
        query: query.slice(0, 100),
        tools: toolDefs.map(d => d.name),
        provider: selection.provider,
        model: selection.model,
        budget: effectiveBudget,
      });

      // Build messages with token-aware context window (no plan injection).
      const allocator = new TokenBudgetAllocator(effectiveBudget);
      const limits = allocator.toLegacyLimits();
      const mContext = metrics.startStage('context_build');
      const messages = await this.contextBuilder.build(history, query, classification.domains, plan, limits.maxContextChars, request.conversationId, requestId, classification.queryType);
      metrics.endStage(mContext, { meta: { historyLength: history.length } });

      // Log estimated prompt size for rate-limit debugging
      const totalChars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
      const estimatedTokens = Math.ceil(totalChars / 2.2); // ~2.2 chars per token for Cyrillic/Ukrainian
      logger.info('[ChatService] Prompt size estimate', {
        totalChars,
        estimatedTokens,
        messageCount: messages.length,
        systemPromptChars: messages[0]?.content?.length || 0,
        provider: selection.provider,
        model: selection.model,
      });
      if (estimatedTokens > 25000) {
        logger.warn('[ChatService] Prompt exceeds 25K tokens — risk of Anthropic rate limit', {
          estimatedTokens,
          provider: selection.provider,
        });
      }

      // EXECUTE phase — agentic loop (lockToolset keeps the toolset fixed).
      const exec = yield* runExecutionPhase(
        {
          query,
          requestId,
          userId: request.userId,
          history,
          signal,
          messages,
          toolDefs,
          plan,
          classification,
          selection,
          effectiveBudget,
          modelTier,
          limits,
          allocator,
          metrics,
          hasApprovedPlan: false,
          lockToolset: true,
        },
        this.executionDeps()
      );
      const {
        fullAnswerText, totalCostUsd, iteration, toolsUsed,
        collectedToolCalls, collectedThinkingSteps, allowSet, evidence,
      } = exec;

      // VERIFY phase — allow-set check + DB verification + citation warnings.
      const verdict = yield* verifyAnswerNode(
        {
          fullAnswerText,
          allowSet,
          evidence,
          collectedToolCalls,
          requestId,
          queryTerms: (classification.keywords || query).toLowerCase().match(/[а-яіїєґ’a-z]{5,}/gi) || [],
          llm: this.llm,
        },
        (name, args) => this.toolRegistry.executeTool(name, args)
      );
      const { fabricatedCaseNumbers, fabricatedLawArticles } = verdict;
      if (requestId && verdict.claimCheck?.usage) {
        this.recordStreamingCost(
          requestId,
          (verdict.claimCheck.provider as LLMProvider) || 'openai',
          verdict.claimCheck.model || '',
          verdict.claimCheck.usage,
          'claim_verification',
        );
      }

      // CORE-39: guaranteed repair of fabricated case numbers / law articles.
      let finalAnswerText = fullAnswerText;
      if (fullAnswerText && (fabricatedCaseNumbers.length > 0 || fabricatedLawArticles.length > 0)) {
        const repair = await repairFabricatedCitations(
          fullAnswerText, fabricatedCaseNumbers, fabricatedLawArticles, this.llm,
        );
        if (repair.changed) {
          finalAnswerText = repair.repaired;
          if (requestId && repair.usage) {
            this.recordStreamingCost(requestId, (repair.provider as LLMProvider) || 'openai', repair.model || '', repair.usage, 'citation_repair');
          }
          if (!exec.finalAnswerDeferred) {
            yield {
              type: 'answer_corrected',
              data: {
                text: finalAnswerText,
                reason: 'fabricated_citations_removed',
                removed: { caseNumbers: fabricatedCaseNumbers, lawArticles: fabricatedLawArticles },
              },
            };
          }
        }
      }

      // CORE-21 P0.enforce: strip unsupported quotes / mischaracterised holdings from REAL cited cases.
      if (finalAnswerText && verdict.unsupportedCitations && verdict.unsupportedCitations.length > 0) {
        const repair = await repairUnsupportedCitations(finalAnswerText, verdict.unsupportedCitations, this.llm);
        if (repair.changed) {
          finalAnswerText = repair.repaired;
          if (requestId && repair.usage) {
            this.recordStreamingCost(requestId, (repair.provider as LLMProvider) || 'openai', repair.model || '', repair.usage, 'unsupported_citation_repair');
          }
          if (!exec.finalAnswerDeferred) {
            yield {
              type: 'answer_corrected',
              data: {
                text: finalAnswerText,
                reason: 'unsupported_citations_removed',
                removed: { caseNumbers: [...new Set(verdict.unsupportedCitations.map(x => x.caseNumber))] },
              },
            };
          }
        }
      }

      // CORE-21 P0.3: deferred high-stakes answer emit (only when deferFinalAnswer was set).
      if (exec.finalAnswerDeferred && finalAnswerText) {
        const answerNorms = extractNormsFromAnswer(finalAnswerText);
        evidence.ingestCitations(answerNorms);
        yield {
          type: 'answer',
          data: {
            text: finalAnswerText,
            provider: exec.answerMeta?.provider,
            model: exec.answerMeta?.model,
            norms: answerNorms.length > 0 ? answerNorms : undefined,
          },
        };
        if (evidence.hasAny) {
          yield { type: 'evidence_update', data: evidence.payload() };
        }
      }

      // Emit pipeline metrics summary before completion
      const metricsSummary = metrics.logSummary(classification.queryType, effectiveBudget);
      yield {
        type: 'pipeline_metrics',
        data: metricsSummary,
      };

      // V3 telemetry (CORE-55): grounding-score + tool-thrashing signals → Prometheus.
      if (this.chatTelemetryCallback) {
        const signals = {
          ...(verdict.signals ?? {
            fabricatedCases: 0, fabricatedArticles: 0, lowRelevance: 0, subjectMismatch: 0, ungroundedQuotes: 0,
            outcomeMismatch: 0, normAttributionMismatch: 0,
          }),
          // CORE-97: backend increments chat_grounding_signals_total per signal key.
          requiredNormAppended: exec.requiredNormAppended ? 1 : 0,
          // CORE-101: budget-reserve enforcement counters.
          searchBlockedForPending: exec.searchBlockedForPending ?? 0,
          deepDiveDowngraded: exec.deepDiveDowngraded ?? 0,
          highRelUnloaded: exec.highRelUnloadedAtEnd ?? 0,
        };
        try {
          this.chatTelemetryCallback({
            queryType: classification.queryType,
            groundingScore: computeGroundingScore(signals),
            signals,
            iterations: iteration,
            toolCalls: collectedToolCalls.length,
            toolRepeatMax: maxToolRepeat(collectedToolCalls),
            capHits: { repeat: exec.capHitRepeat, total: exec.capHitTotal },
          });
        } catch (e) {
          logger.warn('[ChatService] chatTelemetryCallback failed', { error: (e as Error).message });
        }
      }

      // Yield completion event
      const elapsed = Date.now() - startTime;
      yield {
        type: 'complete',
        data: {
          iterations: iteration,
          elapsed_ms: elapsed,
          tools_used: toolsUsed,
          total_cost_usd: totalCostUsd,
          queryType: classification.queryType,
          pipelineMetrics: metricsSummary,
        },
      };

      // Post-completion citation verification — yields citation_warning after complete
      if (this.shepardizationService && fullAnswerText) {
        const mCitation = metrics.startStage('citation_check');
        yield* this.verifyCitationsInAnswer(finalAnswerText);
        metrics.endStage(mCitation);
      }

      // Server-side message persistence
      const hasData = fullAnswerText || collectedThinkingSteps.length > 0 || collectedToolCalls.length > 0;
      if (this.conversationService && request.conversationId && request.userId && hasData) {
        try {
          if (signal?.aborted) {
            logger.info('[ChatService] Client disconnected but persisting partial results', {
              conversationId: request.conversationId,
              hadAnswer: !!fullAnswerText,
              toolCallsCount: collectedToolCalls.length,
            });
          }

          await this.conversationService.addMessage(request.conversationId, request.userId, {
            role: 'user',
            content: request.query,
          });
          const persistEvidence = collectedThinkingSteps.length > 0
            ? extractAllEvidence(collectedThinkingSteps, finalAnswerText)
            : undefined;

          const contentToSave = finalAnswerText
            ? sanitizeAnswerForPersistence(finalAnswerText, fabricatedCaseNumbers, fabricatedLawArticles)
            : (collectedThinkingSteps.length > 0
              ? '[Відповідь не завершена — клієнт від\'єднався під час генерації]'
              : '');

          await this.conversationService.addMessage(request.conversationId, request.userId, {
            role: 'assistant',
            content: contentToSave,
            tool_calls: collectedToolCalls.length > 0 ? collectedToolCalls : undefined,
            thinking_steps: collectedThinkingSteps.length > 0 ? collectedThinkingSteps : undefined,
            decisions: persistEvidence?.decisions && persistEvidence.decisions.length > 0 ? persistEvidence.decisions : undefined,
            citations: persistEvidence?.citations && persistEvidence.citations.length > 0 ? persistEvidence.citations : undefined,
            documents: persistEvidence?.documents && persistEvidence.documents.length > 0 ? persistEvidence.documents : undefined,
            cost_summary: totalCostUsd > 0 ? { total_cost_usd: totalCostUsd, tools_used: toolsUsed, response_id: requestId } : undefined,
          });
        } catch (e) {
          logger.warn('[ChatService] Failed to persist messages', { error: (e as Error).message });
        }
      }
    } catch (err: any) {
      logger.error('[ChatService] Error in V2 agentic loop', { error: err.message, stack: err.stack });
      if (requestId) {
        try {
          await this.costTracker.completeTrackingRecord({
            requestId,
            executionTimeMs: Date.now() - startTime,
            status: 'failed',
            errorMessage: err.message,
          });
        } catch (e) {
          logger.warn('[ChatService] Failed to complete tracking record', { error: (e as Error).message });
        }
      }
      yield {
        type: 'error',
        data: { message: err.message },
      };
      return;
    }

    // Complete tracking as successful
    if (requestId) {
      try {
        await this.costTracker.completeTrackingRecord({
          requestId,
          executionTimeMs: Date.now() - startTime,
          status: 'completed',
        });
      } catch (e) {
        logger.warn('[ChatService] Failed to complete tracking record', { error: (e as Error).message });
      }
    }
  }

  /**
   * CHAT PIPELINE V1 (legacy) — classify → filterTools → plan → expand → agentic loop.
   * Retained for rollback via CHAT_PIPELINE=v1. Yields ChatEvents for SSE streaming.
   */
  private async *chatV1(request: ChatRequest): AsyncGenerator<ChatEvent> {
    const { query, history = [], budget = 'standard', maxBudget, signal, requestId } = request;
    const startTime = Date.now();
    const metrics = new PipelineMetrics(requestId || `anon-${Date.now()}`, query);

    // Auto-create conversation if userId is present but no conversationId was provided
    if (this.conversationService && request.userId && !request.conversationId) {
      try {
        const titlePreview = query.slice(0, 80) || 'New conversation';
        const conv = await this.conversationService.createConversation(request.userId, titlePreview, { requestId });
        request.conversationId = conv.id;
        logger.info('[ChatService] Auto-created conversation for request without conversationId', {
          conversationId: conv.id,
          userId: request.userId,
          requestId,
        });
      } catch (e) {
        logger.warn('[ChatService] Failed to auto-create conversation', { error: (e as Error).message });
      }
    } else if (this.conversationService && request.conversationId && requestId) {
      // Link request_id to existing conversation for log traceability
      this.conversationService.updateRequestId(request.conversationId, requestId).catch(() => {});
    }

    // Create cost tracking record if requestId provided
    if (requestId) {
      try {
        await this.costTracker.createTrackingRecord({
          requestId,
          toolName: 'ai_chat',
          userId: request.userId,
          userQuery: query,
          queryParams: { budget, conversationId: request.conversationId },
        });
      } catch (e) {
        logger.warn('[ChatService] Failed to create tracking record', { error: (e as Error).message });
      }
    }

    // Emit early thinking event so client sees immediate feedback
    yield {
      type: 'thinking',
      data: { step: 0, tool: '_init', description: 'Аналізую запит...' },
    };

    try {
      // --- Two-phase support: reuse cached session if approvedPlan is provided ---
      let classification: ChatIntentClassification;
      let toolDefs: ToolDefinition[];
      let plan: ExecutionPlan | undefined;

      if (request.approvedPlan && request.planSessionId) {
        const session = this.planService.takeValidSession(request.planSessionId);
        if (session) {
          classification = session.classification;
          toolDefs = session.toolDefs;
          // Use the user-approved plan with depth overrides applied
          plan = this.planService.applyStepDepths(request.approvedPlan);
          // Seed search cache with pre-fetched document chain result
          if (session.prefetchedChainResult && this.searchCache) {
            const caseNum = classification.slots?.case_number;
            if (caseNum) {
              this.searchCache.cacheResult(
                'get_case_documents_chain',
                { case_number: caseNum, group_by_instance: false },
                session.prefetchedChainResult,
                request.userId
              ).catch(() => {});
            }
          }
          logger.info('[ChatService] Using approved plan from session', {
            planSessionId: request.planSessionId,
            steps: plan.steps.length,
            deepSteps: plan.steps.filter(s => s.depth === 'deep').length,
          });
        } else {
          logger.warn('[ChatService] Plan session expired or not found, regenerating', {
            planSessionId: request.planSessionId,
          });
          const mClassifyFallback = metrics.startStage('classify');
          classification = await this.intentClassifier.classify(query, requestId);
          metrics.endStage(mClassifyFallback, { meta: { queryType: classification.queryType, path: 'session_expired' } });
          toolDefs = await this.intentClassifier.filterTools(classification.domains, classification.slots, classification.queryType);
          const mPlanFallback = metrics.startStage('plan_generation');
          plan = await this.planService.generateExecutionPlan(query, classification, toolDefs, requestId);
          metrics.endStage(mPlanFallback, { meta: { steps: plan?.steps.length, path: 'session_expired' } });
        }
      } else {
        // Standard flow: classify + generate plan
        const mClassify = metrics.startStage('classify');
        classification = await this.intentClassifier.classify(query, requestId);
        const classifyMeta = this.intentClassifier.lastClassifyMeta;
        metrics.endStage(mClassify, {
          provider: classifyMeta?.provider as LLMProvider | undefined,
          model: classifyMeta?.model,
          promptTokens: classifyMeta?.promptTokens,
          completionTokens: classifyMeta?.completionTokens,
          costUsd: classifyMeta?.costUsd,
          meta: { queryType: classification.queryType, domains: classification.domains },
        });
        toolDefs = await this.intentClassifier.filterTools(classification.domains, classification.slots, classification.queryType);

        // Try fast plan lookup for deterministic query types (skips LLM plan generation)
        const fastPlan = this.planService.fastPlanLookup(classification, toolDefs);
        if (fastPlan) {
          plan = fastPlan;
          metrics.recordStage('plan_generation', { startedAt: Date.now(), durationMs: 0, meta: { fast: true, steps: fastPlan.steps.length } });
          logger.info('[ChatService] Used fast plan lookup, skipped plan generation LLM call', {
            queryType: classification.queryType,
            steps: fastPlan.steps.map(s => s.tool),
          });
        } else {
          const mPlan = metrics.startStage('plan_generation');
          plan = await this.planService.generateExecutionPlan(query, classification, toolDefs, requestId);
          metrics.endStage(mPlan, { meta: { steps: plan?.steps.length } });
        }
      }

      // --- 5a2. Apply analysis depth in-pipeline ---
      // The old plan-review dialog let the user pick per-step depth (standard/deep)
      // before execution. That dialog was removed; depth is now decided automatically
      // here, mirroring the logic that previously ran in generatePlanForReview().
      // The approvedPlan branch already applied depths via applyStepDepths(), so we
      // only handle the plans generated directly in this request.
      if (plan && !request.approvedPlan) {
        for (const step of plan.steps) {
          if (step.recommendedDepth) {
            step.depth = step.recommendedDepth;
          } else if (!step.depth) {
            step.depth = 'standard';
          }
        }
        plan = this.planService.applyStepDepths(plan);
      }

      // --- 5b. Expand tool set from plan (cross-domain resolution) ---
      // The plan may reference tools from domains the classifier missed.
      // Expand to include sibling tools from the same TOOL_GROUPs.
      if (plan && plan.steps.length > 0) {
        toolDefs = await this.intentClassifier.expandToolsFromPlan(toolDefs, plan);
      }

      // --- 6a. Unsupported short-circuit ---
      if (classification.queryType === 'unsupported') {
        const reason = classification.unsupportedReason || 'Цей запит виходить за межі можливостей системи SecondLayer.';
        logger.info('[ChatService] Query classified as unsupported', { reason, query: query.slice(0, 100) });
        yield {
          type: 'answer',
          data: {
            text: reason,
            queryType: 'unsupported',
          },
        };
        yield {
          type: 'complete',
          data: {
            iterations: 0,
            elapsed_ms: Date.now() - startTime,
            tools_used: [],
            total_cost_usd: 0,
            queryType: 'unsupported',
          },
        };
        return;
      }

      // --- 6b. Institutional analysis → generate workflows ---
      if (classification.queryType === 'institutional_analysis' && this.workflowGenerator && this.workflowService) {
        logger.info('[ChatService] Generating workflows for institutional analysis', { query: query.slice(0, 100) });
        yield {
          type: 'thinking',
          data: {
            step: 0,
            tool: '_classify',
            params: { queryType: 'institutional_analysis' },
            description: 'Генерую план глибокого аналізу',
          },
        };

        try {
          const generated = await this.workflowGenerator.generateWorkflows(query, classification);
          const workflowSet = await this.workflowService.createWorkflowSet({
            userId: request.userId || 'anonymous',
            conversationId: request.conversationId,
            title: generated.title,
            description: generated.description,
            sourceQuery: query,
            workflows: generated.workflows.map(w => ({
              sequenceNumber: w.sequenceNumber,
              title: w.title,
              description: w.description,
              plan: w.plan,
            })),
          });

          yield {
            type: 'answer',
            data: {
              text: `Для вашого запиту згенеровано **${generated.workflows.length} робочих процесів** у наборі "${generated.title}".\n\n${generated.description}\n\nПерейдіть на сторінку [Workflows](/workflows/${workflowSet.id}) для перегляду та запуску.`,
              queryType: 'institutional_analysis',
              workflowSetId: workflowSet.id,
            },
          };
          yield {
            type: 'complete',
            data: {
              iterations: 0,
              elapsed_ms: Date.now() - startTime,
              tools_used: [],
              total_cost_usd: 0,
              queryType: 'institutional_analysis',
              workflowSetId: workflowSet.id,
            },
          };
        } catch (err: any) {
          logger.error('[ChatService] Workflow generation failed', { error: err.message });
          yield {
            type: 'answer',
            data: {
              text: `Не вдалося згенерувати робочі процеси: ${err.message}. Спробуйте уточнити запит.`,
              queryType: 'institutional_analysis',
            },
          };
          yield {
            type: 'complete',
            data: {
              iterations: 0,
              elapsed_ms: Date.now() - startTime,
              tools_used: [],
              total_cost_usd: 0,
              queryType: 'institutional_analysis',
            },
          };
        }
        return;
      }

      // --- 6b2. Document listing fast-path (chat-document-listing.ts) ---
      if (classification.queryType === 'document_query' && isSimpleDocumentListQuery(query, classification)) {
        yield* runDocumentListingFastPath(query, startTime, request.userId, (name, args) =>
          this.toolRegistry.executeTool(name, args));
        return;
      }

      // --- 6c. Synthetic thinking event (step 0) ---
      const qtConfig = QUERY_TYPE_CONFIG[classification.queryType];
      if (qtConfig?.thinkingPrefix) {
        yield {
          type: 'thinking',
          data: {
            step: 0,
            tool: '_classify',
            params: { queryType: classification.queryType },
            description: qtConfig.thinkingPrefix,
          },
        };
      }

      // Emit plan to client via SSE (Step 7: include queryType)
      if (plan) {
        yield {
          type: 'plan',
          data: {
            ...plan,
            queryType: classification.queryType,
            thinkingPrefix: qtConfig?.thinkingPrefix,
          },
        };
      }

      // --- 6b. Budget floor from queryType config ---
      const budgetOrder: Record<string, number> = { quick: 0, standard: 1, deep: 2 };
      const configBudget = qtConfig?.defaultBudget || 'standard';

      // Automatic budget escalation — no user confirmation needed.
      // Escalation triggers (conservative — most queries stay on standard/Sonnet):
      //    - Plan with >= 8 steps → deep (complex multi-stage analysis)
      //    - institutional_analysis queryType → deep (via configBudget floor)
      let effectiveBudget: BudgetKey = budget;
      if (plan && plan.steps.length >= 8) {
        effectiveBudget = 'deep';
        logger.info('[ChatService] Auto-escalated to deep budget (plan >= 8 steps)', {
          stepCount: plan.steps.length,
        });
      }

      // Apply budget floor from queryType config (never downgrade below config minimum)
      if ((budgetOrder[configBudget] || 0) > (budgetOrder[effectiveBudget] || 0)) {
        logger.info('[ChatService] Budget floor applied from queryType config', {
          queryType: classification.queryType,
          configBudget,
          previousBudget: effectiveBudget,
        });
        effectiveBudget = configBudget as BudgetKey;
      }

      // Apply budget ceiling (maxBudget) — never escalate above this
      if (maxBudget && (budgetOrder[effectiveBudget] || 0) > (budgetOrder[maxBudget] || 0)) {
        logger.info('[ChatService] Budget ceiling applied (maxBudget)', {
          maxBudget,
          previousBudget: effectiveBudget,
        });
        effectiveBudget = maxBudget as BudgetKey;
      }

      logger.info('[ChatService] Starting agentic loop', {
        query: query.slice(0, 100),
        domains: classification.domains,
        keywords: classification.keywords,
        queryType: classification.queryType,
        toolCount: toolDefs.length,
        budget: effectiveBudget,
        budgetEscalated: effectiveBudget !== budget,
        hasPlan: !!plan,
        planSteps: plan?.steps.length || 0,
      });

      // 4. Pick LLM model for the main loop.
      // Model tier is decoupled from the resource tier: a queryType can run big
      // (deep) caps with a cheaper model via modelBudget (e.g. practice_analysis
      // keeps deep caps for full texts but runs Sonnet — see query-type-config).
      // Never let the model exceed the effective resource tier.
      const modelTier: BudgetKey =
        qtConfig?.modelBudget && (budgetOrder[qtConfig.modelBudget] || 0) < (budgetOrder[effectiveBudget] || 0)
          ? (qtConfig.modelBudget as BudgetKey)
          : effectiveBudget;
      const selection = ModelSelector.getModelSelection(modelTier);

      logger.info('[ChatService] Selected LLM', {
        provider: selection.provider,
        model: selection.model,
        modelTier,
        resourceTier: effectiveBudget,
      });

      // 5. Build messages with token-aware context window + injected plan
      const allocator = new TokenBudgetAllocator(effectiveBudget);
      const limits = allocator.toLegacyLimits();
      const mContext = metrics.startStage('context_build');
      const messages = await this.contextBuilder.build(history, query, classification.domains, plan, limits.maxContextChars, request.conversationId, requestId, classification.queryType);
      metrics.endStage(mContext, { meta: { historyLength: history.length } });

      // Log estimated prompt size for rate-limit debugging
      const totalChars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
      const estimatedTokens = Math.ceil(totalChars / 2.2); // ~2.2 chars per token for Cyrillic/Ukrainian
      logger.info('[ChatService] Prompt size estimate', {
        totalChars,
        estimatedTokens,
        messageCount: messages.length,
        systemPromptChars: messages[0]?.content?.length || 0,
        provider: selection.provider,
        model: selection.model,
      });

      if (estimatedTokens > 25000) {
        logger.warn('[ChatService] Prompt exceeds 25K tokens — risk of Anthropic rate limit', {
          estimatedTokens,
          provider: selection.provider,
        });
      }

      // 5. EXECUTE phase — fast path, agentic loop, fallback synthesis.
      // Extracted to chat-execution-loop.ts (CORE-21 decomposition).
      const exec = yield* runExecutionPhase(
        {
          query,
          requestId,
          userId: request.userId,
          history,
          signal,
          messages,
          toolDefs,
          plan,
          classification,
          selection,
          effectiveBudget,
          modelTier,
          limits,
          allocator,
          metrics,
          hasApprovedPlan: !!request.approvedPlan,
        },
        this.executionDeps()
      );
      const {
        fullAnswerText, totalCostUsd, iteration, toolsUsed,
        collectedToolCalls, collectedThinkingSteps, allowSet, evidence,
      } = exec;

      // VERIFY phase — allow-set check + DB verification + citation warnings.
      // Extracted to chat-answer-verification.ts (CORE-21 decomposition).
      const verdict = yield* verifyAnswerNode(
        {
          fullAnswerText,
          allowSet,
          evidence,
          collectedToolCalls,
          requestId,
          queryTerms: (classification.keywords || query).toLowerCase().match(/[а-яіїєґ’a-z]{5,}/gi) || [],
          llm: this.llm,
        },
        (name, args) => this.toolRegistry.executeTool(name, args)
      );
      const { fabricatedCaseNumbers, fabricatedLawArticles } = verdict;
      // CORE-21 P0.2: record the claim-verifier LLM cost (warn-only gate, but it bills).
      if (requestId && verdict.claimCheck?.usage) {
        this.recordStreamingCost(
          requestId,
          (verdict.claimCheck.provider as LLMProvider) || 'openai',
          verdict.claimCheck.model || '',
          verdict.claimCheck.usage,
          'claim_verification',
        );
      }

      // CORE-39: guaranteed repair. If the answer cited unsupported (fabricated)
      // case numbers / law articles, rewrite it to drop them. The original text was
      // already streamed (answer_delta); emit the corrected version so clients can
      // replace it, and use it for persistence + downstream evidence/citation checks.
      let finalAnswerText = fullAnswerText;
      if (fullAnswerText && (fabricatedCaseNumbers.length > 0 || fabricatedLawArticles.length > 0)) {
        const repair = await repairFabricatedCitations(
          fullAnswerText, fabricatedCaseNumbers, fabricatedLawArticles, this.llm,
        );
        if (repair.changed) {
          finalAnswerText = repair.repaired;
          if (requestId && repair.usage) {
            this.recordStreamingCost(requestId, (repair.provider as LLMProvider) || 'openai', repair.model || '', repair.usage, 'citation_repair');
          }
          // Deferred answers were never streamed, so there is nothing to "correct" —
          // the single `answer` event below carries the already-repaired text (P0.3).
          if (!exec.finalAnswerDeferred) {
            yield {
              type: 'answer_corrected',
              data: {
                text: finalAnswerText,
                reason: 'fabricated_citations_removed',
                removed: { caseNumbers: fabricatedCaseNumbers, lawArticles: fabricatedLawArticles },
              },
            };
          }
        }
      }

      // CORE-21 P0.enforce: strip unsupported quotes (P0.1) / mischaracterised holdings
      // (P0.2) from REAL cited cases — the case exists, but the quote/claim isn't in its
      // text. Runs after the fabricated repair (latest text) and before the deferred P0.3
      // emit (so the held answer carries the cleaned text). Warnings already fired in verify.
      if (finalAnswerText && verdict.unsupportedCitations && verdict.unsupportedCitations.length > 0) {
        const repair = await repairUnsupportedCitations(finalAnswerText, verdict.unsupportedCitations, this.llm);
        if (repair.changed) {
          finalAnswerText = repair.repaired;
          if (requestId && repair.usage) {
            this.recordStreamingCost(requestId, (repair.provider as LLMProvider) || 'openai', repair.model || '', repair.usage, 'unsupported_citation_repair');
          }
          if (!exec.finalAnswerDeferred) {
            yield {
              type: 'answer_corrected',
              data: {
                text: finalAnswerText,
                reason: 'unsupported_citations_removed',
                removed: { caseNumbers: [...new Set(verdict.unsupportedCitations.map(x => x.caseNumber))] },
              },
            };
          }
        }
      }

      // CORE-21 P0.3: high-stakes answer was withheld from the live stream. Now that
      // verification + citation repair are done, emit it as a single `answer` event
      // (with norms + evidence) — the client renders this as the authoritative answer,
      // so a fabricated draft is never shown and then retracted.
      if (exec.finalAnswerDeferred && finalAnswerText) {
        const answerNorms = extractNormsFromAnswer(finalAnswerText);
        evidence.ingestCitations(answerNorms);
        yield {
          type: 'answer',
          data: {
            text: finalAnswerText,
            provider: exec.answerMeta?.provider,
            model: exec.answerMeta?.model,
            norms: answerNorms.length > 0 ? answerNorms : undefined,
          },
        };
        if (evidence.hasAny) {
          yield { type: 'evidence_update', data: evidence.payload() };
        }
      }

      // Emit pipeline metrics summary before completion
      const metricsSummary = metrics.logSummary(classification.queryType, effectiveBudget);
      yield {
        type: 'pipeline_metrics',
        data: metricsSummary,
      };

      // Yield completion event — client sees response as done immediately
      const elapsed = Date.now() - startTime;
      yield {
        type: 'complete',
        data: {
          iterations: iteration,
          elapsed_ms: elapsed,
          tools_used: toolsUsed,
          total_cost_usd: totalCostUsd,
          queryType: classification.queryType,
          pipelineMetrics: metricsSummary,
        },
      };

      // Post-completion citation verification — yields citation_warning after complete
      if (this.shepardizationService && fullAnswerText) {
        const mCitation = metrics.startStage('citation_check');
        yield* this.verifyCitationsInAnswer(finalAnswerText);
        metrics.endStage(mCitation);
      }

      // Server-side message persistence — always persist if we have any data,
      // even if client disconnected (user may have refreshed or navigated away).
      const hasData = fullAnswerText || collectedThinkingSteps.length > 0 || collectedToolCalls.length > 0;
      if (this.conversationService && request.conversationId && request.userId && hasData) {
        try {
          if (signal?.aborted) {
            logger.info('[ChatService] Client disconnected but persisting partial results', {
              conversationId: request.conversationId,
              hadAnswer: !!fullAnswerText,
              toolCallsCount: collectedToolCalls.length,
            });
          }

          await this.conversationService.addMessage(request.conversationId, request.userId, {
            role: 'user',
            content: request.query,
          });
          // Extract decisions/citations/documents from tool results for persistence
          const persistEvidence = collectedThinkingSteps.length > 0
            ? extractAllEvidence(collectedThinkingSteps, finalAnswerText)
            : undefined;

          const contentToSave = finalAnswerText
            ? sanitizeAnswerForPersistence(finalAnswerText, fabricatedCaseNumbers, fabricatedLawArticles)
            : (collectedThinkingSteps.length > 0
              ? '[Відповідь не завершена — клієнт від\'єднався під час генерації]'
              : '');

          await this.conversationService.addMessage(request.conversationId, request.userId, {
            role: 'assistant',
            content: contentToSave,
            tool_calls: collectedToolCalls.length > 0 ? collectedToolCalls : undefined,
            thinking_steps: collectedThinkingSteps.length > 0 ? collectedThinkingSteps : undefined,
            decisions: persistEvidence?.decisions && persistEvidence.decisions.length > 0 ? persistEvidence.decisions : undefined,
            citations: persistEvidence?.citations && persistEvidence.citations.length > 0 ? persistEvidence.citations : undefined,
            documents: persistEvidence?.documents && persistEvidence.documents.length > 0 ? persistEvidence.documents : undefined,
            cost_summary: totalCostUsd > 0 ? { total_cost_usd: totalCostUsd, tools_used: toolsUsed, response_id: requestId } : undefined,
          });
        } catch (e) {
          logger.warn('[ChatService] Failed to persist messages', { error: (e as Error).message });
        }
      }
    } catch (err: any) {
      logger.error('[ChatService] Error in agentic loop', { error: err.message, stack: err.stack });

      // Complete tracking as failed
      if (requestId) {
        try {
          await this.costTracker.completeTrackingRecord({
            requestId,
            executionTimeMs: Date.now() - startTime,
            status: 'failed',
            errorMessage: err.message,
          });
        } catch (e) {
          logger.warn('[ChatService] Failed to complete tracking record', { error: (e as Error).message });
        }
      }

      yield {
        type: 'error',
        data: { message: err.message },
      };
      return;
    }

    // Complete tracking as successful
    if (requestId) {
      try {
        await this.costTracker.completeTrackingRecord({
          requestId,
          executionTimeMs: Date.now() - startTime,
          status: 'completed',
        });
      } catch (e) {
        logger.warn('[ChatService] Failed to complete tracking record', { error: (e as Error).message });
      }
    }
  }

  /**
   * Generate a structured execution plan: which tools to call, in what order,
   * with what parameters. Uses a fast LLM call (quick budget, ~200-400ms).
   * Falls back to undefined on error → agentic loop runs without a plan.
   */

  /**
   * Check if a tool result is effectively empty (no meaningful data).
   */
  private isEmptyResult(result: any): boolean {
    if (!result) return true;
    if (result.error) return false; // errors are errors, not empty
    if (result.empty) return true;
    if (result.total === 0 || result.total_count === 0) return true;
    if (Array.isArray(result.results) && result.results.length === 0) return true;
    if (result.content && Array.isArray(result.content)) {
      const text = result.content[0]?.text;
      if (text) {
        try {
          const parsed = JSON.parse(text);
          if (parsed.total === 0 || parsed.total_count === 0) return true;
          if (Array.isArray(parsed.results) && parsed.results.length === 0) return true;
          if (Array.isArray(parsed.data) && parsed.data.length === 0) return true;
        } catch {
          // not JSON
        }
      }
    }
    return false;
  }

  /**
   * Convert ToolRegistry definitions to LLM function calling format.
   */
  private convertToolDefs(defs: ToolDefinition[]): ToolDefinitionParam[] {
    return defs.map((d) => ({
      name: d.name,
      description: d.description,
      parameters: d.inputSchema || { type: 'object', properties: {} },
    }));
  }

  /**
   * Record LLM cost for a single call (streaming or non-streaming).
   * Fire-and-forget — errors are logged but don't break the chat flow.
   */
  private recordStreamingCost(
    requestId: string,
    provider: LLMProvider,
    model: string,
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
    task: string
  ): void {
    const costUsd = ModelSelector.estimateCostAccurate(model, usage.prompt_tokens, usage.completion_tokens);

    const params = {
      requestId,
      model,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      costUsd,
      task,
    };

    this.costTracker.recordOpenAICall(params).catch((e: Error) => {
      logger.warn('[ChatService] Failed to record LLM cost', { error: e.message, task });
    });
  }

  /**
   * Extract case numbers from the LLM answer and verify their precedent status.
   * Yields citation_warning events for overruled or limited decisions.
   */
  private async *verifyCitationsInAnswer(answerText: string): AsyncGenerator<ChatEvent> {
    try {
      const matches = answerText.match(CASE_NUMBER_REGEX);
      if (!matches || matches.length === 0) return;

      const caseNumbers = [...new Set(matches)];
      logger.info('[ChatService] Verifying citations in answer', { count: caseNumbers.length });

      // Doc ids the answer already cites (as #doc-<id> anchors). If the answer cites
      // the very decision that did the overruling, warning "this case was overruled"
      // by case number alone is self-referential nonsense — the warning would point
      // AT the overruling decision itself (CORE-95, case 280/5185/19).
      const citedDocIds = new Set(
        [...answerText.matchAll(/#doc-(\d+)/g)].map((m) => m[1])
      );

      const results = await Promise.race([
        this.shepardizationService!.batchAnalyze(caseNumbers),
        new Promise<ShepardizationResult[]>((_, reject) =>
          setTimeout(() => reject(new Error('citation check timeout')), CITATION_CHECK_TIMEOUT_MS)
        ),
      ]);

      for (const result of results) {
        if (result.status === 'explicitly_overruled' || result.status === 'limited') {
          // Skip self-referential warnings: the top affecting decision is itself
          // cited in the answer, so the answer already relies on the latest ruling.
          const topAffectingDocId = result.affecting_decisions[0]?.doc_id;
          if (topAffectingDocId && citedDocIds.has(String(topAffectingDocId))) {
            logger.debug('[ChatService] Skipping self-referential citation warning', {
              case_number: result.case_number,
              affecting_doc_id: topAffectingDocId,
            });
            continue;
          }
          yield {
            type: 'citation_warning',
            data: {
              case_number: result.case_number,
              status: result.status,
              confidence: result.confidence,
              affecting_decisions: result.affecting_decisions,
              message: result.status === 'explicitly_overruled'
                ? `Рішення у справі ${result.case_number} було скасовано вищою інстанцією`
                : `Рішення у справі ${result.case_number} було змінено вищою інстанцією`,
            },
          };
        }
      }
    } catch (err: any) {
      logger.debug('[ChatService] Citation verification skipped', { error: err.message });
      // Non-critical — don't yield error, just skip
    }
  }

  /**
   * Execute a single tool call with cache check/store logic.
   * Extracted to enable parallel execution via Promise.allSettled().
   */
  private async executeToolWithCache(
    call: ToolCall,
    userId?: string
  ): Promise<{ call: ToolCall; result: any; cached: boolean }> {
    let toolResult: any;
    let cached = false;

    // Meta-tool: request_additional_tools — returns available tools by group
    if (call.name === 'request_additional_tools') {
      const { resolveToolGroupsByIds } = await import('../prompts/tool-registry-catalog.js');
      const groupIds = call.arguments?.groups;
      if (Array.isArray(groupIds)) {
        const toolNames = resolveToolGroupsByIds(groupIds);
        const allDefs = await this.toolRegistry.getAllToolDefinitions();
        const matchedNames = new Set(allDefs.map(d => d.name));
        const matchedTools = allDefs
          .filter(d => toolNames.includes(d.name))
          .map(d => ({ name: d.name, description: d.description }));
        // Guard: surface tool names a group references but the registry can't resolve.
        // A stale catalog (wrong names, deleted tools) otherwise silently returns [].
        const unresolved = toolNames.filter(n => !matchedNames.has(n));
        if (unresolved.length > 0) {
          logger.warn('[ChatService] request_additional_tools: unresolved tool names in group catalog', {
            groups: groupIds,
            unresolved,
          });
        }
        toolResult = {
          message: `Додаткові інструменти для груп [${groupIds.join(', ')}]:`,
          tools: matchedTools,
          hint: matchedTools.length > 0
            ? 'Тепер ви можете використовувати ці інструменти у наступних кроках.'
            : 'У цих групах немає доступних інструментів — спробуйте іншу групу.',
        };
        logger.info('[ChatService] Meta-tool request_additional_tools invoked', {
          groups: groupIds,
          toolsReturned: matchedTools.length,
          unresolvedCount: unresolved.length,
        });
        this.toolGroupMetricsCallback?.(groupIds.join(','));
      } else {
        toolResult = { error: 'Параметр groups має бути масивом ідентифікаторів груп (edrsr_search, court_practice, legislation, registry, parliament, vault, procedural, due_diligence, echr)' };
        logger.warn('[ChatService] Meta-tool request_additional_tools called with invalid args', {
          args: call.arguments,
        });
      }
      return { call, result: toolResult, cached: false };
    }

    // Check cache for court search tools
    if (this.searchCache && isCourtSearchTool(call.name)) {
      const hit = await this.searchCache.getCachedResult(call.name, call.arguments, userId);
      if (hit) {
        toolResult = hit;
        cached = true;
        logger.info('[ChatService] Cache hit for tool', { tool: call.name });
      }
    }

    if (!cached) {
      try {
        const VAULT_TOOLS = new Set(['store_document', 'get_document', 'list_documents', 'semantic_search', 'list_folders', 'delete_document', 'update_document']);
        const toolArgs = (userId && VAULT_TOOLS.has(call.name))
          ? { ...call.arguments, userId }
          : call.arguments;
        try {
          toolResult = await this.toolRegistry.executeTool(call.name, toolArgs);
        } catch (firstErr: any) {
          // Retry once after 1s for non-client errors (skip 4xx)
          const status = firstErr?.status || firstErr?.statusCode || firstErr?.response?.status;
          const isClientError = status && status >= 400 && status < 500;
          if (isClientError) {
            throw firstErr;
          }
          logger.warn('[ChatService] Tool execution failed, retrying once after 1s', {
            tool: call.name,
            error: firstErr.message,
          });
          await new Promise(r => setTimeout(r, 1000));
          toolResult = await this.toolRegistry.executeTool(call.name, toolArgs);
        }
      } catch (err: any) {
        toolResult = { error: err.message };
      }

      // Post-execution: retry entity search with name variations if not found
      if (call.name === 'openreyestr_search_entities' && this.isEntityNotFound(toolResult) && call.arguments?.query) {
        toolResult = await this.retryWithNameVariations(call.name, call.arguments, toolResult);
      }

      // Post-execution: cache result & trigger background downloads
      if (this.searchCache && isCourtSearchTool(call.name) && !toolResult?.error) {
        this.searchCache.cacheResult(call.name, call.arguments, toolResult, userId);
        const docIds = this.searchCache.extractDocIds(toolResult);
        if (docIds.length > 0) {
          this.searchCache.triggerBackgroundDownloads(docIds);
        }
      }
    }

    return { call, result: toolResult, cached };
  }

  /**
   * Check if an OpenReyestr search result indicates "not found".
   */
  private isEntityNotFound(result: any): boolean {
    if (Array.isArray(result) && result.length === 1 && result[0]?.found === false) {
      return true;
    }
    // Result may come wrapped in MCP content format
    if (result?.content && Array.isArray(result.content)) {
      try {
        const textBlock = result.content.find((b: any) => b.type === 'text');
        if (textBlock?.text) {
          const parsed = JSON.parse(textBlock.text);
          if (Array.isArray(parsed) && parsed.length === 1 && parsed[0]?.found === false) {
            return true;
          }
        }
      } catch { /* not JSON, ignore */ }
    }
    return false;
  }

  /**
   * Retry entity search with LLM-generated name spelling variations.
   * Searches sequentially with early exit on first match.
   */
  private async retryWithNameVariations(
    toolName: string,
    originalArgs: any,
    originalResult: any
  ): Promise<any> {
    const variations = await this.nameVariationService.generateVariations(originalArgs.query);
    if (variations.length === 0) return originalResult;

    logger.info('[ChatService] Retrying entity search with name variations', {
      original: originalArgs.query,
      variations,
    });

    for (const variant of variations) {
      try {
        const variantResult = await this.toolRegistry.executeTool(toolName, {
          ...originalArgs,
          query: variant,
        });

        if (!this.isEntityNotFound(variantResult)) {
          logger.info('[ChatService] Name variation matched', {
            original: originalArgs.query,
            matchedVariant: variant,
          });

          // Return results with metadata about the name variation
          if (Array.isArray(variantResult)) {
            return {
              _nameVariation: {
                originalQuery: originalArgs.query,
                matchedVariant: variant,
                attemptedVariants: variations,
              },
              results: variantResult,
            };
          }
          return variantResult;
        }
      } catch (err: any) {
        logger.warn('[ChatService] Variant search failed', { variant, error: err.message });
      }
    }

    // No matches found — enrich original result with attempted variants
    if (Array.isArray(originalResult) && originalResult.length > 0) {
      originalResult[0].attemptedVariants = variations;
    }
    return originalResult;
  }

}
