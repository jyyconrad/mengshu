import { describe, expect, test } from "vitest";

describe("package layer compatibility exports", () => {
  test("MCP package exports remain compatible with adapters/mcp", async () => {
    const pkg = await import("../../packages/mcp/src/index.js");
    const tools = await import("../../adapters/mcp/tools.js");
    const stdio = await import("../../adapters/mcp/stdio-server.js");
    const server = await import("../../adapters/mcp/server.js");

    expect(tools.createMcpMemoryTools).toBe(pkg.createMcpMemoryTools);
    expect(stdio.startMcpStdioServer).toBe(pkg.startMcpStdioServer);
    expect(server.createMcpMemoryServer).toBe(pkg.createMcpMemoryServer);
  });

  test("API package exports remain compatible with legacy api/adapters paths", async () => {
    const pkg = await import("../../packages/api/src/index.js");
    const fastPath = await import("../../api/agent-fast-path.js");
    const rest = await import("../../adapters/rest/router.js");
    const sdk = await import("../../adapters/sdk/index.js");
    const cli = await import("../../packages/api/src/cli/ms.js");
    const projectCli = await import("../../packages/api/src/cli/project.js");

    expect(fastPath.AgentFastPathService).toBe(pkg.AgentFastPathService);
    expect(rest.createRestRouter).toBe(pkg.createRestRouter);
    expect(sdk.MemoryClient).toBe(pkg.MemoryClient);
    expect(projectCli.registerProjectCliCommands).toBe(pkg.registerProjectCliCommands);
    expect(cli.runMengshuCli).toBeTypeOf("function");
  });

  test("UI package exports remain compatible with console paths", async () => {
    const pkg = await import("../../packages/ui/src/index.js");
    const consoleApi = await import("../../console/api.js");

    expect(consoleApi.createConsoleApi).toBe(pkg.createConsoleApi);
  });

  test("OpenClaw adapter compatibility paths re-export plugin implementations", async () => {
    const pluginTools = await import("../../plugins/openclaw/src/tools.js");
    const pluginHooks = await import("../../plugins/openclaw/src/hooks.js");
    const pluginContextFast = await import("../../plugins/openclaw/src/context-fast.js");
    const pluginScope = await import("../../plugins/openclaw/src/scope.js");
    const pluginManifest = await import("../../plugins/openclaw/src/manifest.js");
    const pluginCli = await import("../../plugins/openclaw/src/cli/index.js");
    const pluginDoctor = await import("../../plugins/openclaw/src/cli/doctor.js");
    const pluginProject = await import("../../plugins/openclaw/src/cli/project.js");
    const pluginMcp = await import("../../plugins/openclaw/src/cli/mcp.js");
    const adapterTools = await import("../../adapters/openclaw/tools.js");
    const adapterHooks = await import("../../adapters/openclaw/hooks.js");
    const adapterContextFast = await import("../../adapters/openclaw/context-fast.js");
    const adapterScope = await import("../../adapters/openclaw/scope.js");
    const adapterManifest = await import("../../adapters/openclaw/manifest.js");
    const adapterCli = await import("../../adapters/openclaw/cli.js");
    const adapterDoctor = await import("../../adapters/openclaw/cli-doctor.js");
    const adapterProject = await import("../../adapters/openclaw/cli-project.js");
    const adapterMcp = await import("../../adapters/openclaw/cli-mcp.js");

    expect(adapterTools.handleMemoryRecall).toBe(pluginTools.handleMemoryRecall);
    expect(adapterHooks.handleAgentEndCapture).toBe(pluginHooks.handleAgentEndCapture);
    expect(adapterContextFast.handleMemoryContextFast).toBe(pluginContextFast.handleMemoryContextFast);
    expect(adapterScope.buildOpenClawScope).toBe(pluginScope.buildOpenClawScope);
    expect(adapterManifest.manifestToScope).toBe(pluginManifest.manifestToScope);
    expect(adapterCli.registerMemoryServerCliCommands).toBe(pluginCli.registerMemoryServerCliCommands);
    expect(adapterDoctor.registerDoctorCliCommands).toBe(pluginDoctor.registerDoctorCliCommands);
    expect(adapterProject.registerProjectCliCommands).toBe(pluginProject.registerProjectCliCommands);
    expect(adapterMcp.registerMcpCliCommands).toBe(pluginMcp.registerMcpCliCommands);
  });

  test("source adapter compatibility paths re-export package/plugin implementations", async () => {
    const coreParser = await import("../../packages/core/src/ingest/sources/jsonl-parser.js");
    const codexSource = await import("../../plugins/codex/sources/adapter.js");
    const claudeCodeSource = await import("../../plugins/claude-code/sources/adapter.js");
    const openClawSource = await import("../../plugins/openclaw/src/sources/adapter.js");
    const legacyParser = await import("../../adapters/sources/jsonl-parser.js");
    const legacyIndex = await import("../../adapters/sources/index.js");
    const legacyCodex = await import("../../adapters/sources/codex/adapter.js");
    const legacyClaudeCode = await import("../../adapters/sources/claude-code/adapter.js");
    const legacyOpenClaw = await import("../../adapters/sources/openclaw/adapter.js");

    expect(legacyParser.parseJsonlFile).toBe(coreParser.parseJsonlFile);
    expect(legacyIndex.codexSourceAdapter).toBe(codexSource.codexSourceAdapter);
    expect(legacyCodex.codexSourceAdapter).toBe(codexSource.codexSourceAdapter);
    expect(legacyIndex.claudeCodeSourceAdapter).toBe(claudeCodeSource.claudeCodeSourceAdapter);
    expect(legacyClaudeCode.claudeCodeSourceAdapter).toBe(claudeCodeSource.claudeCodeSourceAdapter);
    expect(legacyIndex.openClawSourceAdapter).toBe(openClawSource.openClawSourceAdapter);
    expect(legacyOpenClaw.openClawSourceAdapter).toBe(openClawSource.openClawSourceAdapter);
  });

  test("feedback compatibility paths re-export core package implementations", async () => {
    const coreFeedback = await import("../../packages/core/src/feedback/index.js");
    const corePackage = await import("../../packages/core/src/index.js");
    const legacyFeedback = await import("../../feedback/index.js");
    const legacyCollector = await import("../../feedback/collector.js");
    const legacyStore = await import("../../feedback/in-memory-store.js");

    expect(corePackage.FeedbackCollector).toBe(coreFeedback.FeedbackCollector);
    expect(legacyFeedback.FeedbackCollector).toBe(coreFeedback.FeedbackCollector);
    expect(legacyCollector.FeedbackCollector).toBe(coreFeedback.FeedbackCollector);
    expect(legacyFeedback.InMemoryFeedbackStore).toBe(coreFeedback.InMemoryFeedbackStore);
    expect(legacyStore.InMemoryFeedbackStore).toBe(coreFeedback.InMemoryFeedbackStore);
  });

  test("routing compatibility paths re-export core package implementations", async () => {
    const coreRouting = await import("../../packages/core/src/routing/index.js");
    const coreRules = await import("../../packages/core/src/routing/rules.js");
    const corePackage = await import("../../packages/core/src/index.js");
    const legacyRouting = await import("../../routing/index.js");
    const legacyRules = await import("../../routing/rules.js");

    expect(corePackage.createRoutingEngine).toBe(coreRouting.createRoutingEngine);
    expect(legacyRouting.createRoutingEngine).toBe(coreRouting.createRoutingEngine);
    expect(legacyRouting.RoutingEngine).toBe(coreRouting.RoutingEngine);
    expect(legacyRules.RoutingEngine).toBe(coreRules.RoutingEngine);
  });

  test("retrieval compatibility paths re-export core package implementations", async () => {
    const corePackage = await import("../../packages/core/src/index.js");
    const contextPacker = await import("../../packages/core/src/retrieval/context-packer.js");
    const fusion = await import("../../packages/core/src/retrieval/fusion.js");
    const orchestrator = await import("../../packages/core/src/retrieval/orchestrator.js");
    const promptSafety = await import("../../packages/core/src/retrieval/prompt-safety.js");
    const legacyContextPacker = await import("../../retrieval/context-packer.js");
    const legacyFusion = await import("../../retrieval/fusion.js");
    const legacyOrchestrator = await import("../../retrieval/orchestrator.js");
    const legacyPromptSafety = await import("../../retrieval/prompt-safety.js");

    expect(corePackage.packContext).toBe(contextPacker.packContext);
    expect(legacyContextPacker.packContext).toBe(contextPacker.packContext);
    expect(corePackage.fuseHits).toBe(fusion.fuseHits);
    expect(legacyFusion.fuseHits).toBe(fusion.fuseHits);
    expect(corePackage.RetrievalOrchestrator).toBe(orchestrator.RetrievalOrchestrator);
    expect(legacyOrchestrator.RetrievalOrchestrator).toBe(orchestrator.RetrievalOrchestrator);
    expect(corePackage.escapeMemoryForPrompt).toBe(promptSafety.escapeMemoryForPrompt);
    expect(legacyPromptSafety.escapeMemoryForPrompt).toBe(promptSafety.escapeMemoryForPrompt);
  });

  test("database compatibility paths re-export core package implementations", async () => {
    const corePackage = await import("../../packages/core/src/index.js");
    const factory = await import("../../packages/core/src/db/factory.js");
    const lancedb = await import("../../packages/core/src/db/providers/lancedb.js");
    const postgres = await import("../../packages/core/src/db/providers/postgres.js");
    const supabase = await import("../../packages/core/src/db/providers/supabase.js");
    const hybrid = await import("../../packages/core/src/db/providers/hybrid.js");
    const legacyFactory = await import("../../db/factory.js");
    const legacyLancedb = await import("../../db/providers/lancedb.js");
    const legacyPostgres = await import("../../db/providers/postgres.js");
    const legacySupabase = await import("../../db/providers/supabase.js");
    const legacyHybrid = await import("../../db/providers/hybrid.js");

    expect(corePackage.DatabaseFactory).toBe(factory.DatabaseFactory);
    expect(legacyFactory.DatabaseFactory).toBe(factory.DatabaseFactory);
    expect(legacyLancedb.LanceDBProvider).toBe(lancedb.LanceDBProvider);
    expect(legacyPostgres.PostgresProvider).toBe(postgres.PostgresProvider);
    expect(legacySupabase.SupabaseProvider).toBe(supabase.SupabaseProvider);
    expect(legacySupabase.assertSafeTableName).toBe(supabase.assertSafeTableName);
    expect(legacyHybrid.HybridProvider).toBe(hybrid.HybridProvider);
  });

  test("storage compatibility paths re-export core package implementations", async () => {
    const corePackage = await import("../../packages/core/src/index.js");
    const legacyAdapter = await import("../../packages/core/src/storage/legacy-database-adapter.js");
    const bm25 = await import("../../packages/core/src/storage/indexes/in-memory-bm25.js");
    const inMemory = await import("../../packages/core/src/storage/repositories/in-memory.js");
    const postgresJob = await import("../../packages/core/src/storage/repositories/postgres-job.js");
    const legacyLegacyAdapter = await import("../../storage/legacy-database-adapter.js");
    const legacyBm25 = await import("../../storage/indexes/in-memory-bm25.js");
    const legacyInMemory = await import("../../storage/repositories/in-memory.js");
    const legacyPostgresJob = await import("../../storage/repositories/postgres-job.js");

    expect(corePackage.LegacyDatabaseAdapter).toBe(legacyAdapter.LegacyDatabaseAdapter);
    expect(legacyLegacyAdapter.LegacyDatabaseAdapter).toBe(legacyAdapter.LegacyDatabaseAdapter);
    expect(corePackage.InMemoryBm25Index).toBe(bm25.InMemoryBm25Index);
    expect(legacyBm25.InMemoryBm25Index).toBe(bm25.InMemoryBm25Index);
    expect(corePackage.InMemoryMemoryStore).toBe(inMemory.InMemoryMemoryStore);
    expect(legacyInMemory.InMemoryMemoryStore).toBe(inMemory.InMemoryMemoryStore);
    expect(corePackage.PostgresJobRepository).toBe(postgresJob.PostgresJobRepository);
    expect(legacyPostgresJob.PostgresJobRepository).toBe(postgresJob.PostgresJobRepository);
  });

  test("domain compatibility paths re-export core package implementations", async () => {
    const corePackage = await import("../../packages/core/src/index.js");
    const memoryService = await import("../../packages/core/src/service/memory-service.js");
    const paths = await import("../../packages/core/src/runtime/paths.js");
    const registry = await import("../../packages/core/src/runtime/registry.js");
    const slotContextBuilder = await import("../../packages/core/src/context/slot-context-builder.js");
    const slotPromptPacker = await import("../../packages/core/src/context/slot-prompt-packer.js");
    const slotSnapshot = await import("../../packages/core/src/context/slot-snapshot.js");
    const legacyMapping = await import("../../packages/core/src/domain/legacy-mapping.js");
    const profileLayer = await import("../../packages/core/src/domain/profile-layer.js");
    const recallScoring = await import("../../packages/core/src/domain/recall-scoring.js");
    const recallFilter = await import("../../packages/core/src/domain/recall-filter.js");
    const scope = await import("../../packages/core/src/domain/scope.js");
    const scopePolicy = await import("../../packages/core/src/domain/scope-policy.js");
    const semanticTypeMapper = await import("../../packages/core/src/domain/semantic-type-mapper.js");
    const semanticTypes = await import("../../packages/core/src/domain/semantic-types.js");
    const statusMapping = await import("../../packages/core/src/domain/status-mapping.js");
    const legacyCoreMapping = await import("../../core/legacy-mapping.js");
    const legacyCoreProfile = await import("../../core/profile-layer.js");
    const legacyCoreRecallScoring = await import("../../core/recall-scoring.js");
    const legacyCoreRecallFilter = await import("../../core/recall-filter.js");
    const legacyCoreScope = await import("../../core/scope.js");
    const legacyCoreScopePolicy = await import("../../core/scope-policy.js");
    const legacyCoreSemanticMapper = await import("../../core/semantic-type-mapper.js");
    const legacyCoreSemanticTypes = await import("../../core/semantic-types.js");
    const legacyCoreStatus = await import("../../core/status-mapping.js");
    const legacyCoreMemoryService = await import("../../core/memory-service.js");
    const legacyCorePaths = await import("../../core/paths.js");
    const legacyCoreRegistry = await import("../../core/registry.js");
    const legacyCoreSlotBuilder = await import("../../core/slot-context-builder.js");
    const legacyCoreSlotPacker = await import("../../core/slot-prompt-packer.js");
    const legacyCoreSlotSnapshot = await import("../../core/slot-snapshot.js");

    expect(corePackage.DefaultMemoryService).toBe(memoryService.DefaultMemoryService);
    expect(legacyCoreMemoryService.DefaultMemoryService).toBe(memoryService.DefaultMemoryService);

    expect(corePackage.resolveHomeDir).toBe(paths.resolveHomeDir);
    expect(legacyCorePaths.resolveHomeDir).toBe(paths.resolveHomeDir);
    expect(legacyCorePaths.resolveDefaultLanceDbPath).toBe(paths.resolveDefaultLanceDbPath);

    expect(corePackage.readRegistry).toBe(registry.readRegistry);
    expect(legacyCoreRegistry.upsertProject).toBe(registry.upsertProject);

    expect(corePackage.SlotContextBuilder).toBe(slotContextBuilder.SlotContextBuilder);
    expect(legacyCoreSlotBuilder.SlotContextBuilder).toBe(slotContextBuilder.SlotContextBuilder);
    expect(corePackage.packSlotsToPrompt).toBe(slotPromptPacker.packSlotsToPrompt);
    expect(legacyCoreSlotPacker.escapeForPrompt).toBe(slotPromptPacker.escapeForPrompt);
    expect(corePackage.SlotSnapshotCache).toBe(slotSnapshot.SlotSnapshotCache);
    expect(legacyCoreSlotSnapshot.globalSlotSnapshotCache).toBe(slotSnapshot.globalSlotSnapshotCache);

    expect(corePackage.normalizeScope).toBe(scope.normalizeScope);
    expect(legacyCoreScope.normalizeScope).toBe(scope.normalizeScope);
    expect(legacyCoreScope.scopeToKey).toBe(scope.scopeToKey);

    expect(corePackage.DEFAULT_SLOT_REUSE_POLICY).toBe(scopePolicy.DEFAULT_SLOT_REUSE_POLICY);
    expect(legacyCoreScopePolicy.matchesReuseScope).toBe(scopePolicy.matchesReuseScope);
    expect(legacyCoreScopePolicy.applyScopeReusePolicy).toBe(scopePolicy.applyScopeReusePolicy);

    expect(corePackage.DEFAULT_RECALL_WEIGHTS).toBe(recallScoring.DEFAULT_RECALL_WEIGHTS);
    expect(legacyCoreRecallScoring.computeNodeScore).toBe(recallScoring.computeNodeScore);
    expect(legacyCoreRecallScoring.computeNodeScoreWithBreakdown).toBe(
      recallScoring.computeNodeScoreWithBreakdown,
    );

    expect(corePackage.memoryEntryToRecord).toBe(legacyMapping.memoryEntryToRecord);
    expect(legacyCoreMapping.memoryEntryToRecord).toBe(legacyMapping.memoryEntryToRecord);
    expect(legacyCoreMapping.recordToMemoryEntry).toBe(legacyMapping.recordToMemoryEntry);

    expect(corePackage.inferProfileLayer).toBe(profileLayer.inferProfileLayer);
    expect(legacyCoreProfile.mergeProfileByLayer).toBe(profileLayer.mergeProfileByLayer);
    expect(legacyCoreProfile.enrichProfileLayer).toBe(profileLayer.enrichProfileLayer);

    expect(corePackage.filterRecallRecords).toBe(recallFilter.filterRecallRecords);
    expect(legacyCoreRecallFilter.filterRecallRecords).toBe(recallFilter.filterRecallRecords);

    expect(corePackage.kindToSemanticType).toBe(semanticTypeMapper.kindToSemanticType);
    expect(legacyCoreSemanticMapper.batchMapSemanticType).toBe(semanticTypeMapper.batchMapSemanticType);
    expect(legacyCoreSemanticMapper.computeMappingCoverage).toBe(semanticTypeMapper.computeMappingCoverage);

    expect(corePackage.FIVE_QUESTIONS).toBe(semanticTypes.FIVE_QUESTIONS);
    expect(legacyCoreSemanticTypes.formatWarning).toBe(semanticTypes.formatWarning);
    expect(legacyCoreSemanticTypes.lifecycleStatusToFilteredReason).toBe(
      semanticTypes.lifecycleStatusToFilteredReason,
    );

    expect(corePackage.mapToUserVisibleStatus).toBe(statusMapping.mapToUserVisibleStatus);
    expect(legacyCoreStatus.mapToUserVisibleStatus).toBe(statusMapping.mapToUserVisibleStatus);
  });

  test("processing compatibility paths re-export core scoring and LLM runtime implementations", async () => {
    const corePackage = await import("../../packages/core/src/index.js");
    const confidenceScore = await import("../../packages/core/src/scoring/confidence-score.js");
    const hashUtils = await import("../../packages/core/src/scoring/hash-utils.js");
    const importanceScore = await import("../../packages/core/src/scoring/importance-score.js");
    const scoringWeights = await import("../../packages/core/src/scoring/scoring-weights.js");
    const textSplitter = await import("../../packages/core/src/scoring/text-splitter.js");
    const valueScore = await import("../../packages/core/src/scoring/value-score.js");
    const valueSignals = await import("../../packages/core/src/scoring/value-score-signals.js");
    const embeddings = await import("../../packages/core/src/runtime/llm/embeddings.js");
    const extractionRules = await import("../../packages/core/src/runtime/llm/extraction-rules.js");
    const llmClient = await import("../../packages/core/src/runtime/llm/llm-client.js");
    const legacyConfidence = await import("../../processing/confidence-score.js");
    const legacyHashUtils = await import("../../processing/hash-utils.js");
    const legacyImportance = await import("../../processing/importance-score.js");
    const legacyWeights = await import("../../processing/scoring-weights.js");
    const legacyTextSplitter = await import("../../processing/text-splitter.js");
    const legacyValueScore = await import("../../processing/value-score.js");
    const legacyValueSignals = await import("../../processing/value-score-signals.js");
    const legacyEmbeddings = await import("../../processing/embeddings.js");
    const legacyExtractionRules = await import("../../processing/extraction-rules.js");
    const legacyLlmClient = await import("../../processing/llm-client.js");

    expect(corePackage.computeConfidence).toBe(confidenceScore.computeConfidence);
    expect(legacyConfidence.computeConfidence).toBe(confidenceScore.computeConfidence);
    expect(corePackage.computeContentHash).toBe(hashUtils.computeContentHash);
    expect(legacyHashUtils.computeContentHash).toBe(hashUtils.computeContentHash);
    expect(corePackage.computeImportance).toBe(importanceScore.computeImportance);
    expect(legacyImportance.computeImportance).toBe(importanceScore.computeImportance);
    expect(corePackage.SCORING_WEIGHTS_V1).toBe(scoringWeights.SCORING_WEIGHTS_V1);
    expect(legacyWeights.SCORING_WEIGHTS_V1).toBe(scoringWeights.SCORING_WEIGHTS_V1);
    expect(corePackage.TextSplitter).toBe(textSplitter.TextSplitter);
    expect(legacyTextSplitter.TextSplitter).toBe(textSplitter.TextSplitter);
    expect(corePackage.computeValueScore).toBe(valueScore.computeValueScore);
    expect(legacyValueScore.computeValueScore).toBe(valueScore.computeValueScore);
    expect(corePackage.deriveValueScoreSignals).toBe(valueSignals.deriveValueScoreSignals);
    expect(legacyValueSignals.deriveValueScoreSignals).toBe(valueSignals.deriveValueScoreSignals);

    expect(corePackage.Embeddings).toBe(embeddings.Embeddings);
    expect(legacyEmbeddings.Embeddings).toBe(embeddings.Embeddings);
    expect(corePackage.reconcileCrossContextual).toBe(extractionRules.reconcileCrossContextual);
    expect(legacyExtractionRules.reconcileCrossContextual).toBe(
      extractionRules.reconcileCrossContextual,
    );
    expect(corePackage.createLlmClient).toBe(llmClient.createLlmClient);
    expect(legacyLlmClient.createLlmClient).toBe(llmClient.createLlmClient);
  });

  test("ingest compatibility paths re-export core package implementations", async () => {
    const corePackage = await import("../../packages/core/src/index.js");
    const pipeline = await import("../../packages/core/src/ingest/pipeline.js");
    const chunker = await import("../../packages/core/src/ingest/chunker.js");
    const jobs = await import("../../packages/core/src/ingest/jobs.js");
    const fileSystem = await import("../../packages/core/src/ingest/adapters/file-system.js");
    const fileScanner = await import("../../packages/core/src/ingest/scanner/file-scanner.js");
    const legacyPipeline = await import("../../ingest/pipeline.js");
    const legacyChunker = await import("../../ingest/chunker.js");
    const legacyJobs = await import("../../ingest/jobs.js");
    const legacyFileSystem = await import("../../ingest/adapters/file-system.js");
    const legacyFileScanner = await import("../../scanner/file-scanner.js");

    expect(corePackage.IngestionPipeline).toBe(pipeline.IngestionPipeline);
    expect(legacyPipeline.IngestionPipeline).toBe(pipeline.IngestionPipeline);
    expect(corePackage.chunkMarkdown).toBe(chunker.chunkMarkdown);
    expect(legacyChunker.chunkMarkdown).toBe(chunker.chunkMarkdown);
    expect(corePackage.enqueueUniqueJob).toBe(jobs.enqueueUniqueJob);
    expect(legacyJobs.enqueueUniqueJob).toBe(jobs.enqueueUniqueJob);
    expect(corePackage.ingestMarkdownFile).toBe(fileSystem.ingestMarkdownFile);
    expect(legacyFileSystem.ingestMarkdownFile).toBe(fileSystem.ingestMarkdownFile);
    expect(corePackage.FileScanner).toBe(fileScanner.FileScanner);
    expect(legacyFileScanner.FileScanner).toBe(fileScanner.FileScanner);
  });

  test("lifecycle compatibility paths re-export core package implementations", async () => {
    const corePackage = await import("../../packages/core/src/index.js");
    const candidates = await import("../../packages/core/src/lifecycle/candidate-repository.js");
    const extractor = await import("../../packages/core/src/lifecycle/extract-candidate-handler.js");
    const forget = await import("../../packages/core/src/lifecycle/forget-handler.js");
    const review = await import("../../packages/core/src/lifecycle/candidate-review.js");
    const legacyCandidates = await import("../../lifecycle/candidate-repository.js");
    const legacyExtractor = await import("../../lifecycle/extract-candidate-handler.js");
    const legacyForget = await import("../../lifecycle/forget-handler.js");
    const legacyReview = await import("../../lifecycle/candidate-review.js");

    expect(corePackage.InMemoryCandidateRepository).toBe(candidates.InMemoryCandidateRepository);
    expect(legacyCandidates.InMemoryCandidateRepository).toBe(candidates.InMemoryCandidateRepository);
    expect(corePackage.createExtractCandidateHandler).toBe(extractor.createExtractCandidateHandler);
    expect(legacyExtractor.createExtractCandidateHandler).toBe(extractor.createExtractCandidateHandler);
    expect(corePackage.forgetCommand).toBe(forget.forgetCommand);
    expect(legacyForget.forgetCommand).toBe(forget.forgetCommand);
    expect(corePackage.CandidateReviewService).toBe(review.CandidateReviewService);
    expect(legacyReview.CandidateReviewService).toBe(review.CandidateReviewService);
  });

  test("graph and tree compatibility paths re-export core package implementations", async () => {
    const corePackage = await import("../../packages/core/src/index.js");
    const graphRepo = await import("../../packages/core/src/graph/repository.js");
    const graphHandler = await import("../../packages/core/src/graph/extract-graph-handler.js");
    const treeBuffer = await import("../../packages/core/src/tree/buffer.js");
    const treeHandler = await import("../../packages/core/src/tree/build-tree-handler.js");
    const treePostgres = await import("../../packages/core/src/tree/postgres-repository.js");
    const topic = await import("../../packages/core/src/tree/topic.js");
    const legacyGraphRepo = await import("../../graph/repository.js");
    const legacyGraphHandler = await import("../../graph/extract-graph-handler.js");
    const legacyTreeBuffer = await import("../../tree/buffer.js");
    const legacyTreeHandler = await import("../../tree/build-tree-handler.js");
    const legacyTreePostgres = await import("../../tree/postgres-repository.js");
    const legacyTopic = await import("../../tree/topic.js");

    expect(corePackage.InMemoryGraphRepository).toBe(graphRepo.InMemoryGraphRepository);
    expect(legacyGraphRepo.InMemoryGraphRepository).toBe(graphRepo.InMemoryGraphRepository);
    expect(corePackage.createExtractGraphHandler).toBe(graphHandler.createExtractGraphHandler);
    expect(legacyGraphHandler.createExtractGraphHandler).toBe(graphHandler.createExtractGraphHandler);
    expect(corePackage.InMemoryTreeRepository).toBe(treeBuffer.InMemoryTreeRepository);
    expect(legacyTreeBuffer.InMemoryTreeRepository).toBe(treeBuffer.InMemoryTreeRepository);
    expect(corePackage.PostgresTreeRepository).toBe(treePostgres.PostgresTreeRepository);
    expect(legacyTreePostgres.PostgresTreeRepository).toBe(treePostgres.PostgresTreeRepository);
    expect(corePackage.createBuildTreeHandler).toBe(treeHandler.createBuildTreeHandler);
    expect(legacyTreeHandler.createBuildTreeHandler).toBe(treeHandler.createBuildTreeHandler);
    expect(corePackage.computeHotness).toBe(topic.computeHotness);
    expect(legacyTopic.computeHotness).toBe(topic.computeHotness);
  });
});
