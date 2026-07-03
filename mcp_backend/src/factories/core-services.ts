import { Database, ContentDatabase } from '../database/database.js';
import { logger } from '../utils/logger.js';
import { DocumentService } from '../services/document-service.js';
import { EdsrLocalAdapter } from '../adapters/edrsr-local-adapter.js';
import { QueryPlanner } from '../services/query-planner.js';
import { SemanticSectionizer } from '../services/semantic-sectionizer.js';
import { EmbeddingService } from '../services/embedding-service.js';
import { LegalPatternStore } from '../services/legal-pattern-store.js';
import { CitationValidator } from '../services/citation-validator.js';
import { HallucinationGuard } from '../services/hallucination-guard.js';
import { ShepardizationService } from '../services/shepardization-service.js';
import { CitationGraphService } from '../services/citation-graph-service.js';
import { MCPQueryAPI } from '../api/mcp-query-api.js';
import { LegislationTools } from '../api/legislation-tools.js';
import { LegislationService } from '../services/legislation-service.js';
import { LLMAdapter } from '../infrastructure/adapters/llm-adapter.js';
import { getLLMManager } from '../utils/llm-client-manager.js';
import { ReyestrDownloadService } from '../services/reyestr-download-service.js';
import { ImportTaskService } from '../services/import-task-service.js';
import { EchrHudocSyncService } from '../services/echr-hudoc-sync-service.js';

export interface BackendCoreServices {
  db: Database;
  /**
   * Pool for legal-content reads (legislation, EDRSR, editions). Separate pool
   * when CONTENT_DATABASE_URL is set (dev reads prod content read-only via
   * tunnel), otherwise the same instance as `db`.
   */
  contentDb: Database;
  documentService: DocumentService;
  queryPlanner: QueryPlanner;
  sectionizer: SemanticSectionizer;
  embeddingService: EmbeddingService;
  zoAdapter: EdsrLocalAdapter;
  zoPracticeAdapter: EdsrLocalAdapter;
  zoSessionsAdapter: EdsrLocalAdapter;
  zoLegalActsAdapter: EdsrLocalAdapter;
  zoECHRAdapter: EdsrLocalAdapter;
  patternStore: LegalPatternStore;
  shepardizationService: ShepardizationService;
  citationValidator: CitationValidator;
  citationGraphService: CitationGraphService;
  hallucinationGuard: HallucinationGuard;
  legislationTools: LegislationTools;
  reyestrDownloadService: ReyestrDownloadService;
  importTaskService: ImportTaskService;
  echrHudocSyncService: EchrHudocSyncService;
  mcpAPI: MCPQueryAPI;
}

export function createBackendCoreServices(): BackendCoreServices {
  const db = new Database();
  let contentDb: Database = db;
  if (process.env.CONTENT_DATABASE_URL) {
    contentDb = new ContentDatabase(process.env.CONTENT_DATABASE_URL);
    logger.info('Content database split enabled: legal-content reads use CONTENT_DATABASE_URL');
  }
  const documentService = new DocumentService(db);
  const llmAdapter = new LLMAdapter(getLLMManager());
  const queryPlanner = new QueryPlanner(llmAdapter);
  const sectionizer = new SemanticSectionizer(llmAdapter);
  const embeddingService = new EmbeddingService();
  const zoAdapter = new EdsrLocalAdapter(documentService, undefined, embeddingService, undefined, sectionizer);
  const zoPracticeAdapter = new EdsrLocalAdapter('court_practice', documentService, embeddingService, undefined, sectionizer);
  const zoSessionsAdapter = new EdsrLocalAdapter('court_sessions', documentService, embeddingService, undefined, sectionizer);
  const zoLegalActsAdapter = new EdsrLocalAdapter('legal_acts', documentService, embeddingService, undefined, sectionizer);
  const zoECHRAdapter = new EdsrLocalAdapter('echr_practice', documentService, embeddingService, undefined, sectionizer);
  const patternStore = new LegalPatternStore(db, embeddingService);
  const shepardizationService = new ShepardizationService(zoAdapter, db);
  const citationValidator = new CitationValidator(db, shepardizationService);
  const citationGraphService = new CitationGraphService();
  const hallucinationGuard = new HallucinationGuard(db, shepardizationService);
  const legislationService = new LegislationService(contentDb, embeddingService, undefined, llmAdapter);
  const legislationTools = new LegislationTools(legislationService, undefined, patternStore);
  const reyestrDownloadService = new ReyestrDownloadService(db, documentService, sectionizer, embeddingService);
  const importTaskService = new ImportTaskService(db);
  const echrHudocSyncService = new EchrHudocSyncService(db);

  const mcpAPI = new MCPQueryAPI(
    queryPlanner,
    zoAdapter,
    zoPracticeAdapter,
    embeddingService,
    patternStore,
    citationValidator,
    hallucinationGuard,
    legislationTools,
    citationGraphService
  );

  return {
    db,
    contentDb,
    documentService,
    queryPlanner,
    sectionizer,
    embeddingService,
    zoAdapter,
    zoPracticeAdapter,
    zoSessionsAdapter,
    zoLegalActsAdapter,
    zoECHRAdapter,
    patternStore,
    shepardizationService,
    citationValidator,
    citationGraphService,
    hallucinationGuard,
    legislationTools,
    reyestrDownloadService,
    importTaskService,
    echrHudocSyncService,
    mcpAPI,
  };
}
