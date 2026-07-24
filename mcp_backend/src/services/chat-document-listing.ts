/**
 * Document-listing fast path — "які в мене документи?" queries skip plan
 * generation and LLM synthesis entirely: one list_documents call + a
 * formatted answer. Extracted from ChatService (CORE-21 decomposition).
 */

import { logger } from '../utils/logger.js';
import { extractFromToolResult } from './evidence-extractor.js';
import type { ChatIntentClassification } from '../prompts/chat-system-prompt.js';
import type { ChatEvent } from './chat-service.js';

/**
 * Detect whether a document_query is a simple "list my documents" request
 * (as opposed to a semantic search like "find contract about rent in my docs").
 */
export function isSimpleDocumentListQuery(query: string, classification: ChatIntentClassification): boolean {
  const SIMPLE_LIST_PATTERNS = /^(як[іі]\s+документ|покажи\s+(мо[їі]|документ|файл)|список\s+документ|що\s+(я\s+)?завантажи|що\s+ти\s+бачиш|які\s+файли|мо[їі]\s+документ|мо[їі]\s+файл|what\s+document|show\s+(my\s+)?document|list\s+document|я\s+загрузил|я\s+завантажи|документи\s+загружен|які\s+є\s+документ|які\s+є\s+файл|що\s+в\s+(мене|моєму|моїй)|документи\s+в\s+(vault|сховищ)|файли\s+в\s+(vault|сховищ)|що\s+у\s+мене)/i;

  // If query matches simple list patterns OR if keywords are very generic
  if (SIMPLE_LIST_PATTERNS.test(query)) return true;

  // Short queries with only "documents" domain are likely simple listings
  const kw = classification.keywords.toLowerCase();
  if (query.length < 60 && classification.domains.length === 1 && classification.domains[0] === 'documents' && !kw.includes(' ')) {
    return true;
  }

  return false;
}

export async function* runDocumentListingFastPath(
  query: string,
  startTime: number,
  userId: string | undefined,
  executeTool: (name: string, args: Record<string, any>) => Promise<any>
): AsyncGenerator<ChatEvent, void> {
  logger.info('[ChatService] Fast-path: simple document listing', { query: query.slice(0, 100) });
  yield {
    type: 'thinking',
    data: {
      step: 0,
      tool: '_classify',
      params: { queryType: 'document_query' },
      description: 'Отримую список документів',
    },
  };

  try {
    const toolArgs: Record<string, any> = {
      query: '',
      limit: 50,
      offset: 0,
      sortBy: 'uploadedAt',
      sortOrder: 'desc',
    };
    if (userId) toolArgs.userId = userId;

    const toolResult = await executeTool('list_documents', toolArgs);

    // Emit tool_result so evidence panel gets populated
    const listDocEvidence = extractFromToolResult('list_documents', toolResult);
    yield {
      type: 'tool_result',
      data: {
        tool: 'list_documents',
        result: toolResult,
        evidence: listDocEvidence,
        cached: false,
        cost_usd: 0,
      },
    };

    // Format a simple document list without LLM
    const answerText = formatDocumentListAnswer(toolResult);

    yield {
      type: 'answer',
      data: {
        text: answerText,
        queryType: 'document_query',
      },
    };
    yield {
      type: 'complete',
      data: {
        iterations: 0,
        elapsed_ms: Date.now() - startTime,
        tools_used: ['list_documents'],
        total_cost_usd: 0,
        queryType: 'document_query',
      },
    };
  } catch (err: any) {
    logger.error('[ChatService] Document listing fast-path failed', { error: err.message });
    yield {
      type: 'answer',
      data: {
        text: `Не вдалося отримати список документів: ${err.message}`,
        queryType: 'document_query',
      },
    };
    yield {
      type: 'complete',
      data: {
        iterations: 0,
        elapsed_ms: Date.now() - startTime,
        tools_used: [],
        total_cost_usd: 0,
        queryType: 'document_query',
      },
    };
  }
}

/**
 * Format list_documents tool result into a simple readable list.
 */
export function formatDocumentListAnswer(toolResult: any): string {
  try {
    // Parse the tool result content
    let data: any;
    if (toolResult?.content && Array.isArray(toolResult.content)) {
      const textBlock = toolResult.content.find((b: any) => b.type === 'text');
      if (textBlock?.text) {
        data = JSON.parse(textBlock.text);
      }
    } else if (typeof toolResult === 'object') {
      data = toolResult;
    }

    if (!data?.documents || data.documents.length === 0) {
      return 'У вас поки немає завантажених документів.';
    }

    const docs = data.documents;
    const total = data.total || docs.length;

    let text = `У вас ${total} ${pluralizeDocuments(total)}:\n\n`;
    text += '| # | Назва | Тип | Дата завантаження |\n';
    text += '|---|-------|-----|-------------------|\n';

    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      const title = doc.title || 'Без назви';
      const type = doc.type || '—';
      const date = doc.metadata?.uploadedAt
        ? new Date(doc.metadata.uploadedAt).toLocaleDateString('uk-UA')
        : (doc.storage_type === 'vault' ? '—' : '—');
      text += `| ${i + 1} | ${title} | ${type} | ${date} |\n`;
    }

    if (total > docs.length) {
      text += `\n*Показано ${docs.length} з ${total} документів.*`;
    }

    return text;
  } catch (err: any) {
    logger.warn('[ChatService] Failed to format document list', { error: err.message });
    return 'Документи отримано, але не вдалося відформатувати список.';
  }
}

function pluralizeDocuments(n: number): string {
  const lastTwo = n % 100;
  const lastOne = n % 10;
  if (lastTwo >= 11 && lastTwo <= 19) return 'документів';
  if (lastOne === 1) return 'документ';
  if (lastOne >= 2 && lastOne <= 4) return 'документи';
  return 'документів';
}
