/**
 * ShepardizationService — Real-time precedent validity verification.
 *
 * Reconstructs the full procedural chain (first instance → appeal → cassation → Grand
 * Chamber) from the LOCAL EDRSR registry (edrsr_documents + edrsr_courts + edrsr_fulltext)
 * and determines whether a cited decision is still valid law. ZakonOnline is no longer used
 * (deprecated); the Grand-Chamber "position departed from" signal is layered on separately
 * by the caller via the Neo4j citation graph.
 *
 * Three access patterns:
 * - analyze()      — Full verification against the EDRSR DB + caching
 * - quickCheck()   — Cache-only (Redis/PG), no DB scan, for hot paths
 * - batchAnalyze() — Parallel analysis with concurrency limit
 */

import { logger } from '../utils/logger.js';
import { generateCaseNumberVariations } from '../api/tool-utils.js';
import { extractDispositive, extractOutcomeExtended } from './shepardization-outcome.js';
import type { EdsrLocalAdapter } from '../adapters/edrsr-local-adapter.js';
import type { IDatabase, ICachePort } from '../domain/ports/index.js';
import type { PrecedentStatusType } from '../types/index.js';

// ============================
// Types
// ============================

export interface ShepardizationResult {
  case_number: string;
  target_doc_id?: string;
  status: PrecedentStatusType;
  confidence: number;
  affecting_decisions: AffectingDecision[];
  chain_length: number;
  check_source: 'redis' | 'pg' | 'zo_api' | 'edrsr' | 'local';
  checked_at: string;
}

export interface AffectingDecision {
  doc_id: string;
  instance: string;
  court: string;
  date?: string;
  outcome: string;
  effect: 'upheld' | 'modified' | 'overruled' | 'remanded' | 'closed';
}

// ============================
// Instance classification
// ============================

const INSTANCE_HIERARCHY: Record<string, number> = {
  'Велика Палата ВС': 4,
  'Касація (КЦС ВС)': 3,
  'Касація (КГС ВС)': 3,
  'Касація (КАС ВС)': 3,
  'Касація (ККС ВС)': 3,
  'Касація': 3,
  'Апеляція': 2,
  'Перша інстанція': 1,
  'Невідомо': 0,
};

function classifyInstance(doc: any): string {
  const court = (doc?.court || doc?.court_name || '').toLowerCase();
  const chamber = (doc?.chamber || '').toLowerCase();
  const title = (doc?.title || '').toLowerCase();
  const snippet = (doc?.snippet || '').toLowerCase();

  // Grand Chamber first — it can carry instance_code=1 too.
  if (chamber.includes('велика палата') || chamber.includes('вп вс') || court.includes('велика палата')) {
    return 'Велика Палата ВС';
  }

  // Prefer the structured instance_code from edrsr_courts (1=cassation, 2=appeal, 3=first).
  if (doc?.instance_code === 1) {
    if (court.includes('касаційний цивільний') || chamber.includes('кцс')) return 'Касація (КЦС ВС)';
    if (court.includes('касаційний господарський') || chamber.includes('кгс')) return 'Касація (КГС ВС)';
    if (court.includes('касаційний адміністративний') || chamber.includes('кас')) return 'Касація (КАС ВС)';
    if (court.includes('касаційний кримінальний') || chamber.includes('ккс')) return 'Касація (ККС ВС)';
    return 'Касація';
  }
  if (doc?.instance_code === 2) return 'Апеляція';
  if (doc?.instance_code === 3) return 'Перша інстанція';

  // Name/chamber fallback when instance_code is absent.
  if (chamber.includes('кцс') || chamber.includes('касаційний цивільний')) return 'Касація (КЦС ВС)';
  if (chamber.includes('кгс') || chamber.includes('касаційний господарський')) return 'Касація (КГС ВС)';
  if (chamber.includes('кас') || chamber.includes('касаційний адміністративний')) return 'Касація (КАС ВС)';
  if (chamber.includes('ккс') || chamber.includes('касаційний кримінальний')) return 'Касація (ККС ВС)';

  const courtText = court || snippet;
  if (courtText.includes('касаці') || courtText.includes('верховн')) return 'Касація';
  if (courtText.includes('апеляці')) return 'Апеляція';
  if (courtText.includes('окружний') || courtText.includes('районний') || courtText.includes('міськ')) return 'Перша інстанція';
  if (courtText.match(/господарський суд .*(області|міста)|цивільний суд .*(області|міста)|адміністративний суд/)) return 'Перша інстанція';

  if (title.includes('касаці')) return 'Касація';
  if (title.includes('апеляці')) return 'Апеляція';
  return 'Невідомо';
}

// ============================
// Outcome extraction (extended)
// ============================
// extractDispositive / extractOutcomeExtended live in shepardization-outcome.ts
// (pure helpers, exported for tests — see CORE-95).

// ============================
// Confidence scoring
// ============================

function computeConfidence(
  status: PrecedentStatusType,
  highestAffectingInstance: string,
  checkSource: ShepardizationResult['check_source']
): number {
  if (checkSource === 'local') return 0.6;
  if (status === 'unknown') return 0.5;

  const instanceLevel = INSTANCE_HIERARCHY[highestAffectingInstance] || 0;

  if (status === 'explicitly_overruled') {
    if (instanceLevel >= 4) return 0.95; // Grand Chamber
    if (instanceLevel >= 3) return 0.95; // Cassation
    if (instanceLevel >= 2) return 0.85; // Appeal
    return 0.75;
  }

  if (status === 'limited') {
    if (instanceLevel >= 3) return 0.90;
    if (instanceLevel >= 2) return 0.80;
    return 0.70;
  }

  if (status === 'valid') {
    if (instanceLevel >= 3) return 0.90; // Upheld at cassation
    return 0.80;
  }

  return 0.5;
}

// ============================
// Constants
// ============================

const REDIS_TTL_SECONDS = 24 * 60 * 60; // 24 hours
const PG_FRESHNESS_DAYS = 7;
const BATCH_CONCURRENCY = 3;
const ANALYZE_TIMEOUT_MS = 15_000;

// ============================
// Service
// ============================

export class ShepardizationService {
  private cache: ICachePort | null = null;

  constructor(
    private zoAdapter: EdsrLocalAdapter,
    private db: IDatabase,
    cache?: ICachePort
  ) {
    this.cache = cache || null;
  }

  setCachePort(cache: ICachePort): void {
    this.cache = cache;
  }

  /**
   * Full verification: Redis cache → PG cache → ZO API search → classify → cache.
   */
  async analyze(identifier: string): Promise<ShepardizationResult> {
    const startTime = Date.now();

    // 1. Resolve to case_number
    const caseNumber = await this.resolveCaseNumber(identifier);
    if (!caseNumber) {
      return this.unknownResult(identifier, 'local');
    }

    // 2. Check Redis cache
    const redisCached = await this.checkRedisCache(caseNumber);
    if (redisCached) {
      logger.debug('[Shepardization] Redis cache hit', { caseNumber });
      return redisCached;
    }

    // 3. Check PG cache (within freshness window)
    const pgCached = await this.checkPGCache(caseNumber);
    if (pgCached) {
      logger.debug('[Shepardization] PG cache hit', { caseNumber });
      // Warm Redis for next time
      await this.cacheToRedis(caseNumber, pgCached);
      return pgCached;
    }

    // 4. Search ZakonOnline for all documents in this case
    try {
      const result = await this.searchAndClassify(caseNumber);

      // 5. Cache in Redis + PG
      await this.cacheToRedis(caseNumber, result);
      await this.cacheToPG(result);

      // 6. Log
      const duration = Date.now() - startTime;
      await this.logAnalysis(result, duration);

      return result;
    } catch (err: any) {
      logger.warn('[Shepardization] ZO API search failed, falling back to local', {
        caseNumber,
        error: err.message,
      });

      // Fallback to local citation_links analysis
      return this.localFallback(caseNumber);
    }
  }

  /**
   * Cache-only check (Redis/PG). Returns null if no cached data.
   * For HallucinationGuard hot path — must be fast, no API calls.
   */
  async quickCheck(caseNumber: string): Promise<ShepardizationResult | null> {
    // Redis first
    const redisCached = await this.checkRedisCache(caseNumber);
    if (redisCached) return redisCached;

    // PG second (any age)
    const pgResult = await this.checkPGCache(caseNumber, false);
    if (pgResult) {
      await this.cacheToRedis(caseNumber, pgResult);
      return pgResult;
    }

    return null;
  }

  /**
   * Parallel analysis with concurrency limit. For post-chat verification.
   */
  async batchAnalyze(caseNumbers: string[]): Promise<ShepardizationResult[]> {
    const unique = [...new Set(caseNumbers)];
    const results: ShepardizationResult[] = [];
    const queue = [...unique];

    const workers = Array.from({ length: Math.min(BATCH_CONCURRENCY, queue.length) }, async () => {
      while (queue.length > 0) {
        const cn = queue.shift();
        if (!cn) break;

        try {
          const result = await Promise.race([
            this.analyze(cn),
            new Promise<ShepardizationResult>((_, reject) =>
              setTimeout(() => reject(new Error('timeout')), ANALYZE_TIMEOUT_MS)
            ),
          ]);
          results.push(result);
        } catch (err: any) {
          logger.warn('[Shepardization] Batch item failed', { caseNumber: cn, error: err.message });
          results.push(this.unknownResult(cn, 'local'));
        }
      }
    });

    await Promise.all(workers);
    return results;
  }

  // ============================
  // Internal: Resolution
  // ============================

  private async resolveCaseNumber(identifier: string): Promise<string | null> {
    if (!identifier) return null;

    // Already a case number (digits/digits/digits pattern)?
    if (/^\d+\/\d+\/\d{2,4}/.test(identifier)) {
      return identifier;
    }

    // Numeric EDRSR doc_id → resolve its cause_num from the local registry.
    if (/^\d+$/.test(identifier)) {
      try {
        const result = await this.db.query(
          'SELECT cause_num FROM edrsr_documents WHERE doc_id = $1 LIMIT 1',
          [identifier]
        );
        if (result.rows.length > 0 && result.rows[0].cause_num) {
          return result.rows[0].cause_num;
        }
      } catch {
        // ignore
      }
    }

    return null;
  }

  // ============================
  // Internal: Cache operations
  // ============================

  private async checkRedisCache(caseNumber: string): Promise<ShepardizationResult | null> {
    try {
      if (!this.cache) return null;

      const cached = await this.cache.get(`shepard:${caseNumber}`);
      if (!cached) return null;

      const parsed = JSON.parse(cached) as ShepardizationResult;
      // Ignore results computed by the retired ZakonOnline path (always "unknown") so a
      // pre-migration cached entry self-heals into a fresh EDRSR computation.
      if (parsed.check_source === 'zo_api') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private async cacheToRedis(caseNumber: string, result: ShepardizationResult): Promise<void> {
    try {
      if (!this.cache) return;

      await this.cache.set(`shepard:${caseNumber}`, JSON.stringify(result), REDIS_TTL_SECONDS);
    } catch {
      // non-critical
    }
  }

  private async checkPGCache(caseNumber: string, checkFreshness = true): Promise<ShepardizationResult | null> {
    try {
      const freshnessClause = checkFreshness
        ? `AND last_checked > NOW() - INTERVAL '${PG_FRESHNESS_DAYS} days'`
        : '';

      const result = await this.db.query(
        `SELECT status, confidence, case_number, target_doc_id, affecting_decisions, check_source, last_checked
         FROM precedent_status
         WHERE case_number = $1 ${freshnessClause}
           AND (check_source IS NULL OR check_source <> 'zo_api')
         LIMIT 1`,
        [caseNumber]
      );

      if (result.rows.length === 0) return null;

      const row = result.rows[0];
      const affecting = Array.isArray(row.affecting_decisions) ? row.affecting_decisions : [];

      return {
        case_number: caseNumber,
        target_doc_id: row.target_doc_id || undefined,
        status: row.status as PrecedentStatusType,
        confidence: row.confidence,
        affecting_decisions: affecting,
        chain_length: affecting.length,
        check_source: (row.check_source || 'pg') as ShepardizationResult['check_source'],
        checked_at: row.last_checked?.toISOString() || new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  private async cacheToPG(result: ShepardizationResult): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO precedent_status (case_id, case_number, target_doc_id, status, confidence, affecting_decisions, check_source, last_checked, ttl_expires_at)
         SELECT id, $1::varchar(100), $2, $3, $4, $5::jsonb, $6, NOW(), NOW() + INTERVAL '7 days'
         FROM documents WHERE metadata->>'case_number' = $1::text LIMIT 1
         ON CONFLICT (case_id) DO UPDATE SET
           case_number = EXCLUDED.case_number,
           target_doc_id = EXCLUDED.target_doc_id,
           status = EXCLUDED.status,
           confidence = EXCLUDED.confidence,
           affecting_decisions = EXCLUDED.affecting_decisions,
           check_source = EXCLUDED.check_source,
           last_checked = EXCLUDED.last_checked,
           ttl_expires_at = EXCLUDED.ttl_expires_at`,
        [
          result.case_number,
          result.target_doc_id || null,
          result.status,
          result.confidence,
          JSON.stringify(result.affecting_decisions),
          result.check_source,
        ]
      );
    } catch (err: any) {
      logger.warn('[Shepardization] Failed to cache to PG', { error: err.message });
    }
  }

  // ============================
  // Internal: EDRSR chain reconstruction + classification
  // ============================

  private async searchAndClassify(caseNumber: string): Promise<ShepardizationResult> {
    const variations = generateCaseNumberVariations(caseNumber);

    // Pull the whole procedural chain straight from the local EDRSR registry.
    // instance_code (edrsr_courts): 1=cassation, 2=appeal, 3=first instance.
    const res = await this.db.query(
      `SELECT d.doc_id, d.court_code, d.judgment_code, d.adjudication_date,
              c.name AS court_name, c.instance_code
       FROM edrsr_documents d
       LEFT JOIN edrsr_courts c ON c.court_code = d.court_code
       WHERE d.cause_num = ANY($1)
       ORDER BY d.adjudication_date ASC NULLS LAST
       LIMIT 200`,
      [variations]
    );
    const rows: any[] = res.rows || [];
    if (rows.length === 0) {
      return this.unknownResult(caseNumber, 'edrsr');
    }

    const classified = rows.map((r) => {
      const instance = classifyInstance(r);
      return {
        doc_id: String(r.doc_id),
        instance,
        instanceLevel: INSTANCE_HIERARCHY[instance] || 0,
        court: r.court_name || '',
        date: r.adjudication_date ? new Date(r.adjudication_date).toISOString() : '',
        judgmentCode: Number(r.judgment_code) || 0,
      };
    });

    // Original (target) decision = the lowest instance present in the chain.
    const targetDoc = classified.reduce(
      (lowest, doc) =>
        doc.instanceLevel > 0 && doc.instanceLevel < (lowest?.instanceLevel || 999) ? doc : lowest,
      classified[classified.length - 1]
    );
    const targetLevel = targetDoc?.instanceLevel || 1;

    // Higher-instance SUBSTANTIVE decisions that could affect the target.
    // judgment_code: 1=Вирок, 2=Постанова, 3=Рішення (skip 5=Ухвала, 10=Окрема думка).
    const SUBSTANTIVE = new Set([1, 2, 3]);
    const higherDecisions = classified
      .filter((d) => d.instanceLevel > targetLevel && SUBSTANTIVE.has(d.judgmentCode))
      .sort((a, b) => b.instanceLevel - a.instanceLevel || (b.date || '').localeCompare(a.date || ''));

    let status: PrecedentStatusType = 'unknown';
    let highestInstance = 'Невідомо';
    const affectingDecisions: AffectingDecision[] = [];

    if (higherDecisions.length === 0) {
      // No higher court decided the case → the original decision stands as issued.
      status = 'valid';
    } else {
      highestInstance = higherDecisions[0].instance;

      // Read the disposition from each higher-court decision's operative part (capped).
      for (const hc of higherDecisions.slice(0, 6)) {
        const outcome = extractOutcomeExtended(extractDispositive(await this.fetchFullText(hc.doc_id)));
        if (outcome) {
          affectingDecisions.push({
            doc_id: hc.doc_id,
            instance: hc.instance,
            court: hc.court,
            date: hc.date || undefined,
            outcome: outcome.outcome,
            effect: outcome.effect,
          });
        }
      }

      // Highest-instance, latest outcome decides the status.
      const top = affectingDecisions[0];
      switch (top?.effect) {
        case 'overruled':
        case 'remanded':
          status = 'explicitly_overruled';
          break;
        case 'modified':
          status = 'limited';
          break;
        case 'upheld':
          status = 'valid';
          break;
        case 'closed':
          status = 'limited';
          break;
        default:
          // Reached a higher instance but no clear disposition text → treat as reviewed/valid.
          status = 'valid';
      }
    }

    const confidence = computeConfidence(status, highestInstance, 'edrsr');

    return {
      case_number: caseNumber,
      target_doc_id: targetDoc?.doc_id,
      status,
      confidence,
      affecting_decisions: affectingDecisions,
      chain_length: classified.length,
      check_source: 'edrsr',
      checked_at: new Date().toISOString(),
    };
  }

  /** Full text of a decision from the local EDRSR fulltext store; null if absent. */
  private async fetchFullText(docId: string): Promise<string | null> {
    try {
      const r = await this.db.query('SELECT full_text FROM edrsr_fulltext WHERE doc_id = $1 LIMIT 1', [docId]);
      return r.rows?.[0]?.full_text || null;
    } catch {
      return null;
    }
  }

  // ============================
  // Internal: Fallback to local citation_links
  // ============================

  private async localFallback(caseNumber: string): Promise<ShepardizationResult> {
    try {
      // Try to find via citation_links
      const result = await this.db.query(
        `SELECT cl.citation_type, cl.from_case_id, d.metadata->>'case_number' as from_case_number
         FROM citation_links cl
         JOIN documents d ON d.id = cl.from_case_id
         WHERE cl.to_case_id IN (
           SELECT id FROM documents WHERE metadata->>'case_number' = $1
         )`,
        [caseNumber]
      );

      if (result.rows.length === 0) {
        return this.unknownResult(caseNumber, 'local');
      }

      const overruledBy = result.rows.filter((r: any) => r.citation_type === 'overrules');
      const distinguished = result.rows.filter((r: any) => r.citation_type === 'distinguishes');

      let status: PrecedentStatusType = 'valid';
      if (overruledBy.length > 0) status = 'explicitly_overruled';
      else if (distinguished.length > 0) status = 'questioned';

      return {
        case_number: caseNumber,
        status,
        confidence: 0.6,
        affecting_decisions: overruledBy.map((r: any) => ({
          doc_id: r.from_case_id,
          instance: 'Невідомо',
          court: '',
          outcome: 'overrules',
          effect: 'overruled' as const,
        })),
        chain_length: result.rows.length,
        check_source: 'local',
        checked_at: new Date().toISOString(),
      };
    } catch {
      return this.unknownResult(caseNumber, 'local');
    }
  }

  // ============================
  // Internal: Logging
  // ============================

  private async logAnalysis(result: ShepardizationResult, durationMs: number): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO shepardization_log (case_number, target_doc_id, status, confidence, chain_length, source, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          result.case_number,
          result.target_doc_id || null,
          result.status,
          result.confidence,
          result.chain_length,
          result.check_source,
          durationMs,
        ]
      );
    } catch {
      // non-critical
    }
  }

  // ============================
  // Helpers
  // ============================

  private unknownResult(caseNumber: string, source: ShepardizationResult['check_source']): ShepardizationResult {
    return {
      case_number: caseNumber,
      status: 'unknown',
      confidence: 0.5,
      affecting_decisions: [],
      chain_length: 0,
      check_source: source,
      checked_at: new Date().toISOString(),
    };
  }
}
