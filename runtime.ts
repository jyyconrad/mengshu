import { randomUUID } from "node:crypto";
import type { MemoryConfig } from "./config.js";
import { DatabaseFactory } from "./db/factory.js";
import type { DatabaseProvider } from "./db/types.js";
import type { MemoryService } from "./core/service-types.js";
import { DefaultMemoryService } from "./core/memory-service.js";
import { normalizeScope } from "./core/scope.js";
import type { MemoryRecord, MemoryScope } from "./core/types.js";
import { Embeddings } from "./processing/embeddings.js";
import { computeContentHash } from "./processing/hash-utils.js";
import { createLlmClient, type LlmClient } from "./processing/llm-client.js";
import { createRoutingEngine, type RoutingEngine } from "./packages/core/src/routing/index.js";
import { LegacyDatabaseAdapter } from "./storage/legacy-database-adapter.js";
import { createPersistentRepositories, type PersistentRepositories } from "./packages/core/src/storage/db-provider-adapters.js";
import { IngestionPipeline } from "./ingest/pipeline.js";
import { enqueueUniqueJob } from "./ingest/jobs.js";
import { AgentFastPathService } from "./api/agent-fast-path.js";
import { createConsoleApi } from "./console/api.js";
import type { ConsoleApi } from "./console/types.js";
import { extractRecords } from "./adapters/openclaw/agent-service-helper.js";
import { CandidateReviewService } from "./lifecycle/candidate-review.js";
import { candidateToMemoryRecord } from "./lifecycle/candidate-promotion.js";
import { InMemoryCandidateRepository } from "./lifecycle/candidate-repository.js";
import { createExtractCandidateHandler } from "./lifecycle/extract-candidate-handler.js";
import { defaultTypeExtractor } from "./lifecycle/type-extractor.js";
import { InMemoryTreeRepository } from "./tree/buffer.js";
import { createBuildTreeHandler } from "./tree/build-tree-handler.js";
import { PostgresTreeRepository } from "./tree/postgres-repository.js";
import type { TreeRepository } from "./tree/types.js";
import { InMemoryGraphRepository } from "./graph/repository.js";
import { createExtractGraphHandler } from "./graph/extract-graph-handler.js";
import { QueryHitsTracker } from "./graph/query-hits-tracker.js";
import { CentralityCalculator } from "./graph/centrality-calculator.js";
import type { JobHandler } from "./server/workers.js";

export interface RuntimeLogger {
  info?(message: string): void;
  warn?(message: string): void;
}

export interface RuntimeOptions {
  config: MemoryConfig;
  resolvedDbPath: string;
  appId?: string;
  defaultScope?: MemoryScope;
  logger?: RuntimeLogger;
  db?: DatabaseProvider;
  embeddings?: Embeddings;
  llmClient?: LlmClient;
}

export interface MengshuRuntime {
  config: MemoryConfig;
  resolvedDbPath: string;
  appId: string;
  defaultScope: MemoryScope;
  db: DatabaseProvider;
  embeddings: Embeddings;
  memoryRepository: LegacyDatabaseAdapter;
  memoryService: MemoryService;
  ingestionStore: PersistentRepositories;
  ingestionPipeline: IngestionPipeline;
  candidateRepository: InMemoryCandidateRepository;
  candidateReview: CandidateReviewService;
  consoleApi: ConsoleApi;
  llmClient: LlmClient;
  treeRepository: TreeRepository;
  graphRepository: InMemoryGraphRepository;
  queryHitsTracker: QueryHitsTracker;
  centralityCalculator: CentralityCalculator;
  agentFastPath: AgentFastPathService;
  routingEngine: RoutingEngine | null;
  handlers: Record<"extract_candidate" | "build_tree" | "extract_graph", JobHandler>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function validateEmbeddingConfig(config: { apiKey: string; baseURL?: string; model?: string }): void {
  if (!config.apiKey || config.apiKey.trim().length === 0) {
    throw new Error(
      `[Mengshu 配置错误] embedding.apiKey 未设置\n\n` +
      `请在 openclaw.plugin.json 中配置 Embedding API Key：\n` +
      `{\n` +
      `  "embedding": {\n` +
      `    "apiKey": "\${OPENAI_API_KEY}",  // 推荐：使用环境变量\n` +
      `    "baseURL": "https://api.openai.com/v1",\n` +
      `    "model": "text-embedding-3-small"\n` +
      `  }\n` +
      `}\n\n` +
      `如需帮助，运行：ms doctor\n` +
      `详细文档：docs/troubleshooting/env-setup.md`
    );
  }

  if (config.apiKey.includes("${") || config.apiKey.includes("}")) {
    throw new Error(
      `[Mengshu 配置错误] 环境变量未正确解析\n\n` +
      `当前配置：embedding.apiKey = "${config.apiKey}"\n\n` +
      `这通常是因为环境变量未设置。请按以下步骤检查：\n` +
      `1. 检查 Shell 配置文件（~/.zshrc 或 ~/.bashrc）中是否已设置环境变量\n` +
      `2. 运行 'source ~/.zshrc' 重新加载配置（或重启终端）\n` +
      `3. 运行 'echo $OPENAI_API_KEY' 验证环境变量是否已生效\n` +
      `4. 或者直接在配置文件中填写实际 API Key（不推荐用于敏感信息）\n\n` +
      `如需帮助，运行：ms doctor\n` +
      `详细文档：docs/troubleshooting/env-setup.md`
    );
  }
}

export function toFriendlyMengshuError(error: unknown): Error {
  if (error instanceof Error) {
    if (error.message.includes("[Mengshu 配置错误]") || error.message.includes("环境变量")) {
      return error;
    }

    if (
      (error.message.includes("403") || error.message.includes("余额") ||
        /balance|insufficient|arrears/i.test(error.message)) &&
      (/balance|insufficient|余额|欠费|arrears/i.test(error.message) ||
        error.message.includes("30001"))
    ) {
      return new Error(
        `[Mengshu 配置错误] Embedding 服务账户余额不足（${error.message}）\n\n` +
        `API Key 本身有效，但对应账户额度不足以调用 Embedding。\n\n` +
        `请处理：\n` +
        `- 前往服务商控制台充值（如 SiliconFlow / DeepSeek）\n` +
        `- 或更换一个有额度的 Embedding API Key\n` +
        `- 充值后运行 'ms doctor' 复验\n\n` +
        `原始错误：${error.message}`
      );
    }

    if (error.message.includes("403") || error.message.includes("401")) {
      return new Error(
        `[Mengshu 配置错误] API 认证失败（${error.message}）\n\n` +
        `这通常是因为：\n` +
        `1. API Key 无效或已过期\n` +
        `2. API Key 没有访问 Embedding API 的权限\n` +
        `3. 环境变量未正确设置\n\n` +
        `请检查配置：\n` +
        `- 确认 API Key 是否有效（可在提供商控制台验证）\n` +
        `- 确认 baseURL 是否正确（如 https://api.openai.com/v1）\n` +
        `- 运行 'ms doctor' 诊断配置问题\n\n` +
        `详细文档：docs/troubleshooting/env-setup.md\n\n` +
        `原始错误：${error.message}`
      );
    }

    if (error.message.includes("ECONNREFUSED") || error.message.includes("ENOTFOUND")) {
      return new Error(
        `[Mengshu 配置错误] 无法连接到 Embedding API（${error.message}）\n\n` +
        `这通常是因为：\n` +
        `1. baseURL 配置错误（请检查拼写和协议 http/https）\n` +
        `2. 网络连接问题（防火墙、代理设置）\n` +
        `3. API 服务不可用\n\n` +
        `请检查配置：\n` +
        `- 确认 baseURL 是否正确（如 https://api.openai.com/v1）\n` +
        `- 如使用本地服务（如 Ollama），确认服务是否已启动\n` +
        `- 运行 'ms doctor' 诊断连接问题\n\n` +
        `详细文档：docs/troubleshooting/env-setup.md\n\n` +
        `原始错误：${error.message}`
      );
    }
  }

  return new Error(
    `[Mengshu 初始化失败] ${error instanceof Error ? error.message : String(error)}\n\n` +
    `如需帮助：\n` +
    `- 运行 'ms doctor' 诊断问题\n` +
    `- 查看配置文档：docs/troubleshooting/env-setup.md\n` +
    `- 查看故障排查：docs/troubleshooting/README.md`
  );
}

function defaultScope(appId: string): MemoryScope {
  return {
    tenantId: appId === "openclaw" ? "default" : "local",
    appId,
    userId: "default",
    projectId: "default",
    agentId: "default",
    namespace: appId === "mengshu" || appId === "cli" ? "working-context" : "default",
    visibility: "private",
  };
}

export function createMengshuRuntime(options: RuntimeOptions): MengshuRuntime {
  validateEmbeddingConfig(options.config.embedding);

  const appId = options.appId ?? "mengshu";
  const db = options.db ?? DatabaseFactory.createProvider(options.config, options.resolvedDbPath);
  const embeddings = options.embeddings ?? new Embeddings(options.config.embedding, options.config.batchProcessing);
  const graphRepository = new InMemoryGraphRepository();
  const queryHitsTracker = new QueryHitsTracker({ graphRepo: graphRepository });
  const centralityCalculator = new CentralityCalculator({ graphRepo: graphRepository });
  const memoryRepository = new LegacyDatabaseAdapter(db, { appId });
  const memoryService = new DefaultMemoryService({
    repository: memoryRepository,
    embeddings,
    queryHitsTracker,
  });

  const llmClient = options.llmClient ?? createLlmClient(options.config.llm);
  const treeRepository: TreeRepository = options.config.dbType === "postgres" && options.config.postgres
    ? new PostgresTreeRepository(options.config.postgres)
    : new InMemoryTreeRepository();
  const runtimeDefaultScope = options.defaultScope ?? defaultScope(appId);

  // F5 阶段 1：使用持久化 repository 替代 in-memory store
  const persistentRepos = createPersistentRepositories({
    db,
    embeddings,
    scope: runtimeDefaultScope,
  });
  const ingestionPipeline = new IngestionPipeline({
    documents: persistentRepos.documents,
    chunks: persistentRepos.chunks,
    jobs: persistentRepos.jobs,
    audit: persistentRepos.audit,
  });

  const candidateRepository = new InMemoryCandidateRepository();
  const candidateReview = new CandidateReviewService({
    repository: candidateRepository,
    promoteCandidate: async ({ candidate }) => {
      const record = candidateToMemoryRecord(candidate);
      await memoryService.storeMemory({ record });
      return { memoryId: record.id };
    },
    audit: async ({ scope, action, targetId, metadata }) => {
      await persistentRepos.audit.append({ scope, action, targetId, metadata });
    },
  });

  const consoleApi = createConsoleApi({
    service: memoryService,
    candidates: candidateRepository,
    candidateReview,
  });

  const agentFastPath = new AgentFastPathService({
    defaultScope: runtimeDefaultScope,
    loadRecordsForScope: async (resolvedScope) => {
      const result = await memoryService.recall({
        query: "",
        scope: resolvedScope,
        limit: 50,
        minScore: 0,
        searchAll: appId !== "openclaw",
      });
      return extractRecords(result.hits);
    },
    recall: async (resolvedScope, query, opts) =>
      memoryService.recall({
        query,
        scope: resolvedScope,
        limit: opts?.limit ?? 10,
        minScore: opts?.minScore ?? 0.1,
        filter: opts?.filter,
        searchAll: appId !== "openclaw",
      }),
    storeObservation: async ({ scope, text, metadata }) => {
      const resolvedScope = normalizeScope(scope, runtimeDefaultScope);
      const now = Date.now();
      const traceId = typeof metadata.traceId === "string" ? metadata.traceId : undefined;
      const eventType = typeof metadata.eventType === "string" ? metadata.eventType : "observation";
      const record: MemoryRecord = {
        id: traceId && isUuid(traceId) ? traceId : randomUUID(),
        scope: resolvedScope,
        kind: "observation",
        semanticType: "task_context",
        container: "session_candidate",
        lifecycleStatus: "active",
        confidence: metadata.intent === "remember" ? 0.9 : 0.6,
        text,
        contentHash: computeContentHash(text),
        importance: metadata.intent === "remember" ? 0.8 : 0.4,
        category: "core",
        dataType: "memory",
        tableName: "memories",
        metadata: {
          ...metadata,
          source: metadata.source ?? "agent-fast-path",
          eventType,
          updatedAt: now,
          embeddingModel: options.config.embedding.model,
          userId: resolvedScope.userId ?? "default",
          projectPath: resolvedScope.projectId ?? "default",
          agentName: resolvedScope.agentId ?? "default",
        },
        provenance: {
          source: typeof metadata.source === "string" ? metadata.source : "agent-fast-path",
          sessionId: resolvedScope.sessionId,
          createdAt: now,
        },
        createdAt: now,
        updatedAt: now,
        vector: await embeddings.embed(text),
      };
      await memoryService.storeMemory({ record });
      return { id: record.id };
    },
    enqueueJob: async ({ type, payload }) => {
      const targetId =
        typeof payload.traceId === "string" ? payload.traceId : computeContentHash(JSON.stringify(payload));
      const job = await enqueueUniqueJob(persistentRepos.jobs, { type, targetId, payload });
      return job.id;
    },
    loadTreeSummaries: async (resolvedScope) => treeRepository.listSummaries({ scope: resolvedScope }),
    logger: options.logger,
  });

  const extractCandidateHandler = createExtractCandidateHandler({
    extractor: defaultTypeExtractor,
    candidates: candidateRepository,
    llmClient,
    audit: async ({ scope, action, targetId, metadata }) => {
      await persistentRepos.audit.append({ scope, action, targetId, metadata });
    },
  });
  const buildTreeHandler = createBuildTreeHandler({
    repository: treeRepository,
    llmClient,
  });
  const extractGraphHandler = createExtractGraphHandler({
    llmClient,
    graphRepository,
    audit: async ({ scope, action, targetId, metadata }) => {
      await persistentRepos.audit.append({ scope, action, targetId, metadata });
    },
  });

  const routingEngine = options.config.knowledgeBases?.enabled
    ? createRoutingEngine(options.config.routingRules)
    : null;

  return {
    config: options.config,
    resolvedDbPath: options.resolvedDbPath,
    appId,
    defaultScope: runtimeDefaultScope,
    db,
    embeddings,
    memoryRepository,
    memoryService,
    ingestionStore: persistentRepos,
    ingestionPipeline,
    candidateRepository,
    candidateReview,
    consoleApi,
    llmClient,
    treeRepository,
    graphRepository,
    queryHitsTracker,
    centralityCalculator,
    agentFastPath,
    routingEngine,
    handlers: {
      extract_candidate: extractCandidateHandler,
      build_tree: buildTreeHandler,
      extract_graph: extractGraphHandler,
    },
    start: async () => {
      await db.initialize();
      if ("initialize" in treeRepository && typeof treeRepository.initialize === "function") {
        await treeRepository.initialize();
      }
    },
    stop: async () => {
      await db.close();
      if ("close" in treeRepository && typeof treeRepository.close === "function") {
        await treeRepository.close();
      }
    },
  };
}
