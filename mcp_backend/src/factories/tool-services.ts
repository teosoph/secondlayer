import { BackendCoreServices } from './core-services.js';
import { CostTracker } from '../services/cost-tracker.js';
import { DocumentParser } from '../services/document-parser.js';
import { DocumentAnalysisTools } from '../api/document-analysis-tools.js';
import { BatchDocumentTools } from '../api/batch-document-tools.js';
import { MetadataExtractor } from '../services/metadata-extractor.js';
import { ToolRegistry } from '../api/tool-registry.js';
import { ServiceProxy } from '../services/service-proxy.js';
import { RemoteServiceClient } from '../services/remote-service-client.js';
import { UploadService } from '../services/upload-service.js';
import { MinioService } from '../services/minio-service.js';
import { VaultTools } from '../api/vault-tools.js';
import { CourtDecisionTools } from '../api/tools/court-decision-tools.js';
import { ProceduralTools } from '../api/tools/procedural-tools.js';
import { LegalAdviceTools } from '../api/tools/legal-advice-tools.js';
import { DueDiligenceTools } from '../api/due-diligence-tools.js';
import { DueDiligenceService } from '../services/due-diligence-service.js';
import { CourtSessionTools } from '../api/tools/court-session-tools.js';
import { LegalActsTools } from '../api/tools/legal-acts-tools.js';
import { ECHRPracticeTools } from '../api/tools/echr-practice-tools.js';
import { EdsrExtendedTools } from '../api/tools/edrsr-extended-tools.js';
import { EdsrUnifiedSearchTool } from '../api/tools/edrsr-unified-search-tool.js';
import { EdsrFtsService } from '../services/edrsr-fts-service.js';
import { EdsrVectorizerService } from '../services/edrsr-vectorizer-service.js';
import { SearchResultFilter } from '../services/search-result-filter.js';
import { QueryReformulator } from '../services/query-reformulator.js';
import { NextcloudService } from '../services/nextcloud-service.js';
import { NextcloudTools } from '../api/tools/nextcloud-tools.js';
import { CourtStatusTools } from '../api/tools/court-status-tools.js';
import { OpenDataTools } from '../api/tools/opendata-tools.js';
import { SpendingTools } from '../api/tools/spending-tools.js';
import { OpenDataRegistriesTools } from '../api/tools/opendata-registries-tools.js';
import { Tier1OpenDataTools } from '../api/tools/tier1-opendata-tools.js';
import { RegistrySearchTool } from '../api/tools/registry-search-tool.js';
import { AnalyzeDataTool } from '../api/tools/analyze-data-tool.js';
import { LLMAdapter } from '../infrastructure/adapters/llm-adapter.js';
import { DecisionLayerTools } from '../api/tools/decision-layer-tools.js';
import { ImportTaskTools } from '../api/tools/import-task-tools.js';
import { WorkflowMemoryTools } from '../api/tools/workflow-memory-tools.js';
import { WorkflowMemoryService } from '../services/workflow-memory-service.js';
import { WorkflowMemoryPushService } from '../services/workflow-memory-push-service.js';
import { OsintProxyAdapter } from '../adapters/osint-proxy-adapter.js';
import { OsintProxyTools } from '../api/tools/osint-proxy-tools.js';
import { IndiaCourtTools } from '../api/tools/india-court-tools.js';
import { ABTestingTools } from '../api/tools/ab-testing-tools.js';
import { ABTestingService } from '../services/ab-testing-service.js';
import { logger } from '../utils/logger.js';
import path from 'path';

export interface ToolServices {
  toolRegistry: ToolRegistry;
  serviceProxy: ServiceProxy;
  documentParser: DocumentParser;
  documentAnalysisTools: DocumentAnalysisTools;
  batchDocumentTools: BatchDocumentTools;
  uploadService: UploadService;
  minioService: MinioService;
  vaultTools: VaultTools;
  edsrFtsService: EdsrFtsService;
  edsrVectorizer?: EdsrVectorizerService;
}

export function createToolServices(
  coreServices: BackendCoreServices,
  costTracker: CostTracker,
  llmAdapter: LLMAdapter
): ToolServices {
  // Document parser with Vision API credentials
  const visionKeyPath = process.env.VISION_CREDENTIALS_PATH ||
                       process.env.GOOGLE_APPLICATION_CREDENTIALS ||
                       path.resolve(process.cwd(), '../vision-ocr-credentials.json');
  const documentParser = new DocumentParser(visionKeyPath, llmAdapter);

  const documentAnalysisTools = new DocumentAnalysisTools(
    documentParser,
    coreServices.sectionizer,
    coreServices.patternStore,
    coreServices.citationValidator,
    coreServices.embeddingService,
    coreServices.documentService,
    llmAdapter
  );

  const batchDocumentTools = new BatchDocumentTools(
    documentParser,
    documentAnalysisTools
  );
  logger.info('Batch document processing tools initialized');

  // Unified Gateway components — single shared HTTP client for remote services
  const remoteClient = new RemoteServiceClient();
  const toolRegistry = new ToolRegistry(remoteClient);
  const serviceProxy = new ServiceProxy(costTracker, remoteClient);
  logger.info('Unified Gateway initialized (Tool Registry + Service Proxy)');

  // EDRSR FTS service — instantiated early so procedural/unified tools can share it
  const edsrFtsService = new EdsrFtsService();

  // Register all tool handlers with the central registry
  toolRegistry.registerHandler(coreServices.legislationTools);
  toolRegistry.registerHandler(documentAnalysisTools);
  toolRegistry.registerHandler(batchDocumentTools);
  const ddService = new DueDiligenceService(
    coreServices.sectionizer,
    coreServices.patternStore,
    coreServices.citationValidator,
    coreServices.documentService,
    llmAdapter
  );
  toolRegistry.registerHandler(new DueDiligenceTools(ddService));
  toolRegistry.registerHandler(coreServices.mcpAPI);
  toolRegistry.registerHandler(new CourtDecisionTools(
    coreServices.zoAdapter,
    coreServices.zoPracticeAdapter,
    coreServices.sectionizer,
    coreServices.embeddingService,
    coreServices.patternStore,
    coreServices.contentDb,
    edsrFtsService,
    coreServices.citationGraphService
  ));
  // EDRSR vectorizer (BGE-M3 + qdrant edrsr_serving HNSW) — shared by ProceduralTools
  // (find_similar_fact_pattern_cases) and EdsrUnifiedSearchTool below.
  let edsrVectorizer: EdsrVectorizerService | undefined;
  try {
    edsrVectorizer = new EdsrVectorizerService();
    edsrVectorizer.setUsageCallback((tokens, model, task) => {
      costTracker.recordVoyageCall({ model, totalTokens: tokens, task }).catch((err) => {
        logger.warn('Failed to record embedding cost', { error: err.message });
      });
    });
  } catch (err: any) {
    logger.warn('EdsrVectorizerService not available (BGE_M3_URL missing?)', { error: err.message });
  }

  toolRegistry.registerHandler(new ProceduralTools(
    coreServices.zoAdapter,
    coreServices.zoPracticeAdapter,
    coreServices.sectionizer,
    coreServices.embeddingService,
    coreServices.patternStore,
    llmAdapter,
    edsrFtsService,
    coreServices.contentDb,
    edsrVectorizer,
  ));
  toolRegistry.registerHandler(new LegalAdviceTools(
    coreServices.queryPlanner,
    coreServices.zoAdapter,
    coreServices.zoPracticeAdapter,
    coreServices.sectionizer,
    coreServices.embeddingService,
    coreServices.patternStore,
    coreServices.citationValidator,
    coreServices.shepardizationService,
    llmAdapter,
    coreServices.contentDb,
    edsrFtsService,
    coreServices.citationGraphService
  ));
  toolRegistry.registerHandler(new CourtSessionTools(
    coreServices.zoSessionsAdapter,
    coreServices.contentDb
  ));
  toolRegistry.registerHandler(new LegalActsTools(coreServices.zoLegalActsAdapter));
  toolRegistry.registerHandler(new ECHRPracticeTools(coreServices.zoECHRAdapter));
  toolRegistry.registerHandler(new CourtStatusTools(coreServices.contentDb));
  toolRegistry.registerHandler(new RegistrySearchTool(coreServices.contentDb));
  toolRegistry.registerHandler(new AnalyzeDataTool(coreServices.contentDb));
  // Bespoke tools with non-parametric query patterns
  toolRegistry.registerHandler(new OpenDataTools(coreServices.contentDb));
  toolRegistry.registerHandler(new SpendingTools(coreServices.contentDb));
  toolRegistry.registerHandler(new OpenDataRegistriesTools(coreServices.contentDb));
  toolRegistry.registerHandler(new Tier1OpenDataTools(coreServices.contentDb));
  toolRegistry.registerHandler(new EdsrExtendedTools(coreServices.contentDb));
  toolRegistry.registerHandler(new IndiaCourtTools(coreServices.contentDb));
  toolRegistry.registerHandler(new DecisionLayerTools(llmAdapter));

  // EDRSR unified search (structured + FTS + hybrid + semantic in one tool)
  // Reuses the edsrVectorizer instance created above.
  const edsrUnifiedSearch = new EdsrUnifiedSearchTool(coreServices.contentDb, edsrFtsService, edsrVectorizer);
  edsrUnifiedSearch.setResultFilter(new SearchResultFilter(llmAdapter));
  edsrUnifiedSearch.setQueryReformulator(new QueryReformulator(llmAdapter));
  toolRegistry.registerHandler(edsrUnifiedSearch);
  // Import task manager (multi-IP downloads)
  toolRegistry.registerHandler(new ImportTaskTools(coreServices.importTaskService));

  // Workflow Memory — three-layer semantic retrieval + push-mode orchestrator
  const wmService = new WorkflowMemoryService(coreServices.db, coreServices.embeddingService);
  const wmTools = new WorkflowMemoryTools(wmService);
  const pushSummarize = async (prompt: string) => {
    const resp = await llmAdapter.chatCompletion({ messages: [{ role: 'user', content: prompt }] }, 'quick');
    return typeof resp === 'string' ? resp : (resp as any).content ?? '';
  };
  const wmPushService = new WorkflowMemoryPushService(coreServices.db, pushSummarize);
  wmTools.setPushService(wmPushService);
  toolRegistry.registerHandler(wmTools);

  // A/B testing tools
  const abTestingService = new ABTestingService(coreServices.db);
  toolRegistry.registerHandler(new ABTestingTools(abTestingService));

  logger.info('Core tool handlers registered with ToolRegistry');

  // Nextcloud integration
  const nextcloudService = new NextcloudService();
  toolRegistry.registerHandler(new NextcloudTools(nextcloudService));
  logger.info('Nextcloud tools registered');

  // Upload and storage services
  const uploadService = new UploadService(coreServices.db);
  const minioService = new MinioService();
  const metadataExtractor = new MetadataExtractor(llmAdapter);
  const vaultTools = new VaultTools(
    documentParser,
    coreServices.sectionizer,
    coreServices.patternStore,
    coreServices.embeddingService,
    coreServices.documentService,
    metadataExtractor
  );
  vaultTools.setMinioService(minioService);
  toolRegistry.registerHandler(vaultTools);
  logger.info('Upload, MinIO, and Vault services initialized');

  // OSINT proxy (SneakyPiper integration)
  //
  // TEMPORARILY DISABLED 2026-06-23: the upstream SneakyPiper self-hosted yente /
  // OpenSanctions host (178.150.37.129, reachable over the wg-panoptic mesh at
  // 10.77.0.1:8200) is down, and the INTERPOL relay is failing. Every osint_* call
  // therefore returned an empty result set, which for a sanctions/PEP check is a
  // dangerous false-negative ("nothing found" reads as "not sanctioned"). We keep the
  // adapter and tools in the codebase (nothing deleted) but skip registration so they
  // do not reach the chat. Re-enable once the host is restored: either revert this
  // guard or set OSINT_PROXY_ENABLED=true.
  const osintAdapter = new OsintProxyAdapter(
    process.env.SNEAKYPIPER_API_URL || '',
    process.env.SNEAKYPIPER_API_KEY || ''
  );
  const osintProxyEnabled = process.env.OSINT_PROXY_ENABLED === 'true';
  if (osintProxyEnabled && osintAdapter.isConfigured()) {
    toolRegistry.registerHandler(new OsintProxyTools(osintAdapter));
    logger.info('OSINT proxy tools registered (SneakyPiper)');
  } else if (osintAdapter.isConfigured()) {
    logger.warn(
      'OSINT proxy tools NOT registered: disabled via kill-switch (set OSINT_PROXY_ENABLED=true to re-enable once SneakyPiper upstream is restored)'
    );
  }

  return {
    toolRegistry,
    serviceProxy,
    documentParser,
    documentAnalysisTools,
    batchDocumentTools,
    uploadService,
    minioService,
    vaultTools,
    edsrFtsService,
    edsrVectorizer,
  };
}
