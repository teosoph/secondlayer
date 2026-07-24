/**
 * ChatContextBuilder — builds the LLM context messages with token-aware sliding window.
 *
 * Extracted from ChatService to isolate context construction
 * (system prompt enrichment, history compression, plan injection).
 */

import { logger } from '../utils/logger.js';
import { UnifiedMessage } from '@secondlayer/shared';
import type { ILLMPort } from '../domain/ports/index.js';
import {
  CHAT_SYSTEM_PROMPT,
  ExecutionPlan,
  type QueryType,
} from '../prompts/chat-system-prompt.js';
import { buildEnrichedSystemPrompt, SCENARIO_CATALOG } from '../prompts/tool-registry-catalog.js';
import { QUERY_TYPE_CONFIG } from '../prompts/query-type-config.js';
import { getPromptSectionsForQueryType } from '../prompts/prompt-sections.js';
import { BUDGET_LIMITS } from './chat-constants.js';

interface CostRecorder {
  recordStreamingCost(
    requestId: string,
    provider: string,
    model: string,
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
    task: string
  ): void;
}

export class ChatContextBuilder {
  /** In-memory cache: conversationId:queryType → compressed summary of older history */
  private static readonly CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
  private historySummaryCache = new Map<string, { messageCount: number; summary: string; createdAt: number }>();

  constructor(
    private llm: ILLMPort,
    private costRecorder?: CostRecorder
  ) {}

  /**
   * Token-aware sliding window with history compression.
   * Recent messages (last 4) are kept verbatim; older messages are LLM-summarized.
   */
  async build(
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
    query: string,
    classifiedDomains?: string[],
    plan?: ExecutionPlan,
    maxContextChars?: number,
    conversationId?: string,
    requestId?: string,
    queryType?: QueryType
  ): Promise<UnifiedMessage[]> {
    const contextBudget = maxContextChars || BUDGET_LIMITS.standard.maxContextChars;

    // Get preferred scenarios from queryType config
    const qtConfig = queryType ? QUERY_TYPE_CONFIG[queryType] : undefined;
    const preferredScenarioIds = qtConfig?.preferredScenarios;

    let enrichedPrompt = buildEnrichedSystemPrompt(
      CHAT_SYSTEM_PROMPT,
      SCENARIO_CATALOG,
      classifiedDomains,
      preferredScenarioIds
    );

    // Inject queryType-specific prompt sections (document_drafting template, practice analysis, etc.)
    const queryTypeSections = getPromptSectionsForQueryType(queryType);
    if (queryTypeSections) {
      enrichedPrompt += '\n\n' + queryTypeSections;
    }

    // Inject grounding note from queryType config
    if (qtConfig?.groundingNote) {
      enrichedPrompt += `\n\n## Обмеження відповіді (queryType: ${queryType})\n${qtConfig.groundingNote}`;
    }

    // Inject execution plan into system prompt
    if (plan) {
      const stepsText = plan.steps
        .map((s) => {
          const paramsStr = JSON.stringify(s.params);
          const depsStr = s.depends_on?.length ? ` (після кроків ${s.depends_on.join(', ')})` : '';
          return `Крок ${s.id}: ${s.tool}(${paramsStr})${depsStr}\n  → Мета: ${s.purpose}`;
        })
        .join('\n\n');

      enrichedPrompt += `\n\n## План виконання

Ціль: ${plan.goal}

${stepsText}

ВАЖЛИВО: Виконай кроки в зазначеному порядку. Можеш адаптувати параметри на основі результатів попередніх кроків.
Використовуй РЕАЛЬНІ дані з результатів інструментів. НІКОЛИ не залишай плейсхолдери — тільки конкретні факти.
Якщо інструмент не повернув певну інформацію — напиши "інформація не знайдена".`;
    }

    const messages: UnifiedMessage[] = [
      { role: 'system', content: enrichedPrompt },
    ];

    const systemChars = enrichedPrompt.length;
    const queryChars = query.length;
    let availableChars = contextBudget - systemChars - queryChars;

    // Split history: last 4 messages are "recent", the rest are "older"
    const RECENT_COUNT = 4;
    const recentHistory = history.slice(-RECENT_COUNT);
    const olderHistory = history.slice(0, Math.max(0, history.length - RECENT_COUNT));

    // Compress older history into a summary if it exists
    if (olderHistory.length > 0) {
      const summary = await this.compressOlderHistory(olderHistory, conversationId, requestId, queryType);
      if (summary) {
        const summaryChars = summary.length + 20;
        if (availableChars - summaryChars > 0) {
          messages.push({ role: 'user', content: summary });
          availableChars -= summaryChars;
        }
      }
    }

    // Add recent messages verbatim (truncated to 2000 chars each), from most recent backwards
    const recentMessages: UnifiedMessage[] = [];
    for (let i = recentHistory.length - 1; i >= 0; i--) {
      const content = recentHistory[i].content.slice(0, 2000);
      const msgChars = content.length + 20;
      if (availableChars - msgChars < 0) break;
      availableChars -= msgChars;
      recentMessages.unshift({ role: recentHistory[i].role, content });
    }

    messages.push(...recentMessages);
    messages.push({ role: 'user', content: query });
    return messages;
  }

  /**
   * Compress older chat history into a concise summary using a quick LLM call.
   * Caches summaries per conversation to avoid re-summarizing on each iteration.
   */
  private async compressOlderHistory(
    olderMessages: Array<{ role: string; content: string }>,
    conversationId?: string,
    requestId?: string,
    queryType?: QueryType
  ): Promise<string | null> {
    // If total content is small, just concatenate
    const totalChars = olderMessages.reduce((sum, m) => sum + m.content.length, 0);
    if (totalChars < 2000) {
      const concat = olderMessages.map(m => `${m.role}: ${m.content}`).join('\n');
      return `[Контекст попередніх повідомлень]: ${concat}`;
    }

    // Check cache — key includes queryType so switching context triggers re-summarization
    const cacheKey = conversationId ? `${conversationId}:${queryType || 'unknown'}` : undefined;
    if (cacheKey) {
      const cached = this.historySummaryCache.get(cacheKey);
      const now = Date.now();
      if (cached && cached.messageCount === olderMessages.length && (now - cached.createdAt) < ChatContextBuilder.CACHE_TTL_MS) {
        return cached.summary;
      }
    }

    try {
      const llm = this.llm;

      const historyText = olderMessages
        .map(m => `${m.role}: ${m.content.slice(0, 1000)}`)
        .join('\n---\n');

      const response = await llm.chatCompletion(
        {
          messages: [
            {
              role: 'system',
              content: 'Стисло підсумуй контекст розмови (до 200 слів). Збережи ключові юридичні факти, номери справ, посилання на закони та прийняті рішення. Відповідай українською.',
            },
            { role: 'user', content: historyText },
          ],
          max_tokens: 400,
          temperature: 0.1,
        },
        'quick'
      );

      if (requestId && response.usage && this.costRecorder) {
        this.costRecorder.recordStreamingCost(requestId, response.provider, response.model, response.usage, 'history_compression');
      }

      const summary = `[Контекст попередніх повідомлень]: ${response.content || ''}`;

      // Cache the summary (keyed by conversationId + queryType, with TTL)
      if (cacheKey) {
        this.historySummaryCache.set(cacheKey, {
          messageCount: olderMessages.length,
          summary,
          createdAt: Date.now(),
        });
      }

      logger.info('[ChatContextBuilder] Compressed older history', {
        originalMessages: olderMessages.length,
        originalChars: totalChars,
        summaryChars: summary.length,
      });

      return summary;
    } catch (err: any) {
      logger.warn('[ChatContextBuilder] History compression failed, using truncated concat', { error: err.message });
      // Fallback: truncated concatenation
      const concat = olderMessages
        .map(m => `${m.role}: ${m.content.slice(0, 300)}`)
        .join('\n');
      return `[Контекст попередніх повідомлень]: ${concat}`.slice(0, 3000);
    }
  }
}
