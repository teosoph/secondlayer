/**
 * HighRelevanceTracker (CORE-101) — tracks high-relevance search hits that were
 * never loaded, so the execution loop can enforce budget discipline in code,
 * not prompts.
 *
 * Repro chat-98f8472e: search_court_decisions returned the profile decision
 * TWICE at rank 1 with relevance_score 9/10 (doc 107631753, справа 280/5185/19);
 * the model loaded ranks 2-3 instead, burned 4× get_court_decision depth 3 on
 * rel 5-7 docs, spent its final round on ANOTHER search, and the composer —
 * citing only loaded docs — silently dropped the case and wrote «практика ВС
 * обмежена» while the on-point holding sat in its own search results.
 *
 * Consumed by chat-execution-loop for three enforcement points:
 *  1. reserve — block new search_* calls near the iteration cap while a rel≥8
 *     hit is pending (load-first nudge names the doc);
 *  2. injection — forced-synthesis / fallback prompts carry the pending hits'
 *     evidence chunks so the composer can ground on them;
 *  3. discipline — get_court_decision depth>1 on a doc whose best known
 *     relevance is <8 is downgraded to depth 1.
 */

export interface HighRelHit {
  docId: number;
  caseNumber?: string;
  score: number;
  /** Best evidence text the search returned (semantic chunk / FTS headline / snippet). */
  chunk?: string;
}

/** A search hit at or above this LLM relevance score must not be silently dropped. */
export const HIGH_REL_THRESHOLD = 8;
/** get_court_decision deep-dives on docs that scored below this are downgraded to depth 1. */
export const DEEP_DIVE_MIN_SCORE = 8;

/** Tools whose executed call loads a document (clears the pending state). */
const LOADING_TOOLS = new Set(['get_court_decision', 'load_full_texts']);

export class HighRelevanceTracker {
  private pending = new Map<number, HighRelHit>();
  private loaded = new Set<number>();
  /** Best known relevance per doc — includes sub-threshold scores for the deep-dive gate. */
  private scores = new Map<number, number>();

  /** Ingest a tool result: remember scores, register unloaded rel≥8 hits as pending. */
  ingestToolResult(toolName: string, result: any): void {
    if (!result) return;
    // Prod tool results are MCP content blocks whose text is a JSON string —
    // unwrap them like IncrementalAllowSet does (reading only result.results
    // left the tracker blind on prod, chat-7ea11f21).
    if (Array.isArray(result.content)) {
      for (const block of result.content) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          try {
            this.ingestToolResult(toolName, JSON.parse(block.text));
          } catch { /* not JSON */ }
        }
      }
    }
    if (!Array.isArray(result.results)) return;
    for (const r of result.results) {
      if (!r || typeof r !== 'object') continue;
      const docId = Number(r.doc_id);
      const score = Number(r.relevance_score);
      if (!Number.isFinite(docId) || docId <= 0 || !Number.isFinite(score)) continue;
      const prev = this.scores.get(docId);
      if (prev === undefined || score > prev) this.scores.set(docId, score);
      if (score < HIGH_REL_THRESHOLD || this.loaded.has(docId)) continue;
      const existing = this.pending.get(docId);
      if (existing && existing.score >= score) continue;
      this.pending.set(docId, {
        docId,
        caseNumber: r.cause_num || r.case_number || existing?.caseNumber,
        score,
        chunk: r.qdrant_best_chunk_text || r.fts_headline || r.snippet || r.text || existing?.chunk,
      });
    }
  }

  /** Record an EXECUTED loading call — clears matching pending hits. */
  recordCall(toolName: string, params: any): void {
    if (!params || !LOADING_TOOLS.has(toolName)) return;
    const ids: number[] = [];
    if (toolName === 'get_court_decision') {
      const id = Number(params.doc_id ?? params.case_id);
      if (Number.isFinite(id) && id > 0) ids.push(id);
    } else if (Array.isArray(params.doc_ids)) {
      for (const d of params.doc_ids) {
        const id = Number(d);
        if (Number.isFinite(id) && id > 0) ids.push(id);
      }
    }
    for (const id of ids) {
      this.loaded.add(id);
      this.pending.delete(id);
    }
  }

  get hasPending(): boolean {
    return this.pending.size > 0;
  }

  /** Unloaded rel≥8 hits, best first. */
  pendingHits(): HighRelHit[] {
    return [...this.pending.values()].sort((a, b) => b.score - a.score);
  }

  /** Best relevance ever seen for a doc (any score), or undefined if never scored. */
  bestKnownScore(docId: number): number | undefined {
    return this.scores.get(docId);
  }

  /** Compact note describing pending hits for injection into a synthesis prompt. */
  buildPendingNote(maxHits = 2, maxChunkChars = 600): string | null {
    const hits = this.pendingHits().slice(0, maxHits);
    if (hits.length === 0) return null;
    return hits
      .map(h =>
        `Справа ${h.caseNumber ?? '(номер невідомий)'} [doc_id ${h.docId}, релевантність ${h.score}/10]` +
        (h.chunk ? `: «${String(h.chunk).slice(0, maxChunkChars)}»` : ''))
      .join('\n');
  }
}
