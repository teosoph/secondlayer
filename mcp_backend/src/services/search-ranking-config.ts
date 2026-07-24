/**
 * Search ranking configuration for the ЄДРСР pipeline.
 *
 * Proprietary: these constants encode ranking decisions tuned against the
 * SecondLayer corpus (which signals matter, how strongly, and in what order).
 * The values look small but represent accumulated calibration — keep them
 * colocated here rather than scattered across the main repo.
 */

/**
 * Order clause used in metadata-first search (no query vector),
 * e.g. "find decisions by court / judge / date range".
 * Freshness bias: newer рішення first, NULL dates last.
 */
export const EDRSR_METADATA_SEARCH_ORDER = 'd.adjudication_date DESC NULLS LAST';

/**
 * Order clause used in full-text search over ЄДРСР fulltext.
 * Pure tsvector rank — signal is strong enough that date bias is skipped.
 */
export const EDRSR_FTS_SEARCH_ORDER = 'rank DESC';

/**
 * tsvector setweight letters applied by the documents trigger (migration 060).
 * Exposed here for documentation and future runtime-configurable re-ranking.
 * Current values: title dominates body by ~2x (A vs B in PostgreSQL default).
 */
export const TSVECTOR_TITLE_WEIGHT: 'A' | 'B' | 'C' | 'D' = 'A';
export const TSVECTOR_BODY_WEIGHT: 'A' | 'B' | 'C' | 'D' = 'B';

/**
 * Body text is truncated before tsvector conversion to keep GIN index small
 * and to avoid tsvector size limits on very long рішення.
 */
export const TSVECTOR_BODY_TRUNCATE_CHARS = 50_000;

/**
 * Snippet (ts_headline) sizing for result previews.
 */
export const FTS_HEADLINE_MAX_WORDS = 60;
export const FTS_HEADLINE_MIN_WORDS = 20;
