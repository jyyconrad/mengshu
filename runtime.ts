import { randomUUID } from "node:crypto";
import { vectorDimsForModel, type MemoryConfig } from "./config.js";
import { DatabaseFactory } from "./db/factory.js";
import type { DatabaseProvider } from "./db/types.js";
import type { ForgetTransactionPort, MemoryService } from "./core/service-types.js";
import {
  createAuthorityScopedForgetCapability,
  type AuthorityScopedForgetCapability,
} from "./packages/core/src/service/authority-forget-capability.js";
import { DefaultMemoryService } from "./core/memory-service.js";
import type { ProviderOwnedAtomicMemoryStorePort } from
  "./packages/core/src/service/write-kernel-transaction.js";
import { normalizeScope } from "./core/scope.js";
import type { MemoryRecord, MemoryScope } from "./core/types.js";
import { Embeddings } from "./processing/embeddings.js";
import { computeContentHash } from "./processing/hash-utils.js";
import { createLlmClient, type LlmClient } from "./processing/llm-client.js";
import { createRoutingEngine, type RoutingEngine } from "./packages/core/src/routing/index.js";
import { LegacyDatabaseAdapter } from "./storage/legacy-database-adapter.js";
import {
  attachEmbeddingSpaceMetadata,
  createPersistentRepositories,
  type PersistentRepositories,
} from "./packages/core/src/storage/db-provider-adapters.js";
import {
  createEmbeddingSpace,
  type KnownEmbeddingSpace,
} from "./packages/core/src/domain/embedding-space.js";
import {
  EmbeddingReadGuard,
  EmbeddingWriteGuard,
} from "./packages/core/src/storage/embedding-space-policy.js";
import { IngestionPipeline } from "./ingest/pipeline.js";
import { AgentFastPathService } from "./api/agent-fast-path.js";
import { createConsoleApi } from "./console/api.js";
import type { ConsoleApi } from "./console/types.js";
import { extractRecords } from "./adapters/openclaw/agent-service-helper.js";
import { CandidateReviewService } from "./lifecycle/candidate-review.js";
import { candidateToMemoryRecord } from "./lifecycle/candidate-promotion.js";
import { InMemoryCandidateRepository } from "./lifecycle/candidate-repository.js";
import type { ScopeBoundCandidateReviewRepository } from
  "./packages/core/src/lifecycle/postgres-candidate-review-repository.js";
import { createExtractCandidateHandler } from "./lifecycle/extract-candidate-handler.js";
import { defaultTypeExtractor } from "./lifecycle/type-extractor.js";
import { InMemoryTreeRepository } from "./tree/buffer.js";
import { createBuildTreeHandler } from "./tree/build-tree-handler.js";
import { PostgresTreeRepository } from "./tree/postgres-repository.js";
import type { TreeRepository } from "./tree/types.js";
import { InMemoryGraphRepository } from "./graph/repository.js";
import { GraphQueryService, type GraphReadRepository } from "./graph/query.js";
import { createExtractGraphHandler } from "./graph/extract-graph-handler.js";
import { QueryHitsTracker } from "./graph/query-hits-tracker.js";
import { CentralityCalculator } from "./graph/centrality-calculator.js";
import type { JobHandler } from "./server/workers.js";
import {
  RuntimeLifecycle,
  type RuntimeLifecycleStepResult,
} from "./packages/core/src/runtime/runtime-lifecycle.js";
import {
  RuntimeDurableJobV2Error,
  createRuntimeDurableJobV2Enqueuer,
  type RuntimeDurableJobV2Enqueuer,
} from "./runtime-durable-job-v2.js";
import {
  assertNativeDurableJobV2ServeCapability,
  type DurableJobV2ServeCapability,
} from "./server/runtime-host-factory.js";
import {
  assertPostgresProviderOwnsDurableJobV2RuntimeBundle,
  PostgresProvider,
  type PostgresDurableJobV2RuntimeBundle,
} from "./packages/core/src/db/providers/postgres.js";
import { createNativeDurableJobV2Composition } from
  "./server/native-durable-job-v2-composition.js";

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
  treeRepository?: TreeRepository;
  /** Trusted native-v2 composition only; structural/legacy-handler capabilities are rejected. */
  durableJobV2ServeCapability?: DurableJobV2ServeCapability;
  /** Same-provider atomic repository/effect/readiness capability required by production serve. */
  durableJobV2RuntimeBundle?: PostgresDurableJobV2RuntimeBundle;
}

export interface MengshuRuntime {
  config: MemoryConfig;
  resolvedDbPath: string;
  appId: string;
  defaultScope: MemoryScope;
  db: DatabaseProvider;
  embeddings: Embeddings;
  embeddingSpace: KnownEmbeddingSpace;
  embeddingWriteGuard: EmbeddingWriteGuard;
  embeddingReadGuard: EmbeddingReadGuard;
  memoryRepository: LegacyDatabaseAdapter;
  memoryService: MemoryService;
  authorityScopedForgetCapability?: AuthorityScopedForgetCapability;
  durableJobV2ServeCapability?: DurableJobV2ServeCapability;
  durableJobV2RuntimeBundle?: PostgresDurableJobV2RuntimeBundle;
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
  lifecycle: RuntimeLifecycle;
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

function strictFastPathJobPayload(
  type: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const rawScope = payload.scope as MemoryScope | undefined;
  if (!rawScope) return payload;
  const scope: Record<string, unknown> = {
    tenantId: rawScope.tenantId,
    userId: rawScope.userId,
    appId: rawScope.appId,
    projectId: rawScope.projectId,
    agentId: rawScope.agentId,
    namespace: rawScope.namespace,
    visibility: rawScope.visibility,
    ...(rawScope.workspaceId === undefined ? {} : { workspaceId: rawScope.workspaceId }),
    ...(rawScope.sessionId === undefined ? {} : { sessionId: rawScope.sessionId }),
  };
  if (type === "extract_candidate") {
    return {
      scope,
      ...(payload.text === undefined ? {} : { text: payload.text }),
      ...(payload.traceId === undefined ? {} : { traceId: payload.traceId }),
      ...(payload.intent === undefined ? {} : { intent: payload.intent }),
    };
  }
  if (type === "build_tree") {
    return {
      scope,
      ...(payload.traceId === undefined ? {} : { traceId: payload.traceId }),
      ...(payload.treeType === undefined ? {} : { treeType: payload.treeType }),
      ...(payload.treeKey === undefined ? {} : { treeKey: payload.treeKey }),
      ...(payload.leaf === undefined ? {} : { leaf: payload.leaf }),
    };
  }
  if (type === "extract_graph") {
    return {
      scope,
      ...(payload.chunkId === undefined ? {} : { chunkId: payload.chunkId }),
      ...(payload.text === undefined ? {} : { text: payload.text }),
      ...(payload.sourceId === undefined ? {} : { sourceId: payload.sourceId }),
      ...(payload.context === undefined ? {} : { context: payload.context }),
    };
  }
  return payload;
}

function postgresForgetTransactionPort(
  config: MemoryConfig,
  db: DatabaseProvider,
): ForgetTransactionPort | undefined {
  if (config.dbType !== "postgres") return undefined;
  const provider = db as DatabaseProvider & {
    createForgetTransactionPort?: () => ForgetTransactionPort;
  };
  return typeof provider.createForgetTransactionPort === "function"
    ? provider.createForgetTransactionPort()
    : undefined;
}

function postgresAtomicMemoryStorePort(
  config: MemoryConfig,
  db: DatabaseProvider,
): ProviderOwnedAtomicMemoryStorePort | undefined {
  if (config.dbType !== "postgres") return undefined;
  const provider = db as DatabaseProvider & {
    createAtomicMemoryStorePort?: () => ProviderOwnedAtomicMemoryStorePort;
  };
  // DatabaseFactory's real PostgresProvider exposes this capability. Injected
  // provider-neutral test/custom adapters retain their legacy path explicitly;
  // a transaction-shaped duck type is rejected later by MemoryService branding.
  return typeof provider.createAtomicMemoryStorePort === "function"
    ? provider.createAtomicMemoryStorePort()
    : undefined;
}

export function createMengshuRuntime(options: RuntimeOptions): MengshuRuntime {
  validateEmbeddingConfig(options.config.embedding);

  const appId = options.appId ?? "mengshu";
  const db = options.db ?? DatabaseFactory.createProvider(options.config, options.resolvedDbPath);
  const embeddings = options.embeddings ?? new Embeddings(options.config.embedding, options.config.batchProcessing);
  const embeddingModel = options.config.embedding.model ?? "text-embedding-3-small";
  const embeddingSpace = createEmbeddingSpace({
    provider: options.config.embedding.provider,
    baseURL: options.config.embedding.baseURL ?? "",
    model: embeddingModel,
    // 必须反映当前 Embeddings/provider 真正使用的模型维度；
    // knowledgeBases.vectorDimensions 目前没有接入向量生成或 provider schema，不能作为指纹真源。
    dim: vectorDimsForModel(embeddingModel),
    // 当前 Embeddings 实现不在客户端侧执行向量归一化。
    normalization: "none",
  });
  // Postgres 从本次升级起强制 persisted registry；其他 provider 保留显式兼容过渡，
  // snapshot 仍为 registry-unavailable，绝不伪装为 active-space-match。
  const embeddingWriteGuard = new EmbeddingWriteGuard(
    embeddingSpace,
    options.config.dbType === "postgres" ? "enforced" : "legacy-write-through",
  );
  // 所有 provider 的读链都严格执行：没有已验证的 active registry 时，
  // runtime 不得在 legacy/unknown/mixed embedding 记录上执行 ANN。
  const embeddingReadGuard = new EmbeddingReadGuard(embeddingSpace);
  const resetEmbeddingGuards = () => {
    embeddingWriteGuard.update({ status: "unavailable" });
    embeddingReadGuard.update({ status: "unavailable" });
  };
  const guardedPersistenceEmbeddings = {
    get modelName() {
      return embeddings.modelName;
    },
    embed: async (text: string) => {
      embeddingWriteGuard.assertWriteAllowed();
      return embeddings.embed(text);
    },
    embedBatch: async (texts: string[]) => {
      embeddingWriteGuard.assertWriteAllowed();
      return embeddings.embedBatch(texts);
    },
  } as unknown as Embeddings;
  const graphRepository = new InMemoryGraphRepository();
  const queryHitsTracker = new QueryHitsTracker({ graphRepo: graphRepository });
  const centralityCalculator = new CentralityCalculator({ graphRepo: graphRepository });
  const runtimeDefaultScope = options.defaultScope ?? defaultScope(appId);
  // F5 stage-1 repositories are also the shared audit path for direct memory
  // writes, including cleanup-warning receipts that already prove persistence.
  const persistentRepos = createPersistentRepositories({
    db,
    embeddings: guardedPersistenceEmbeddings,
    scope: runtimeDefaultScope,
    embeddingSpace,
  });
  const memoryRepository = new LegacyDatabaseAdapter(db, { appId });
  const forgetTransactions = postgresForgetTransactionPort(options.config, db);
  const atomicStore = postgresAtomicMemoryStorePort(options.config, db);
  const memoryService = new DefaultMemoryService({
    repository: memoryRepository,
    embeddings,
    atomicStore,
    audit: persistentRepos.audit,
    queryHitsTracker,
    forgetTransactions,
    embeddingReadGuard,
    // 与 candidate/document/chunk/observation 共用同一 mutable registry gate；
    // public REST/MCP/script/doctor 经 memoryService 写入时不再有 vector 旁路。
    embeddingWriteGuard,
    stampEmbeddingMetadata: (metadata) =>
      attachEmbeddingSpaceMetadata({ ...metadata }, embeddingSpace),
  });
  const authorityScopedForgetCapability = forgetTransactions
    ? createAuthorityScopedForgetCapability(memoryService, forgetTransactions)
    : undefined;

  const llmClient = options.llmClient ?? createLlmClient(options.config.llm);
  const treeRepository: TreeRepository = options.treeRepository ?? (
    options.config.dbType === "postgres" && options.config.postgres
      ? new PostgresTreeRepository(options.config.postgres)
      : new InMemoryTreeRepository()
  );
  const ingestionPipeline = new IngestionPipeline({
    documents: persistentRepos.documents,
    chunks: persistentRepos.chunks,
    jobs: persistentRepos.jobs,
    audit: persistentRepos.audit,
  });

  const candidateRepository = new InMemoryCandidateRepository();
  // Production Postgres review is bound to the provider's private pool and the
  // runtime authority scope. The legacy in-memory repository remains the
  // direct-handler compatibility path for non-Postgres providers.
  const candidateReviewRepository: InMemoryCandidateRepository | ScopeBoundCandidateReviewRepository =
    options.config.dbType === "postgres" && db instanceof PostgresProvider
      ? db.createCandidateReviewRepository(runtimeDefaultScope)
      : candidateRepository;
  const durableCandidateReview = candidateReviewRepository !== candidateRepository;
  const candidateReview = new CandidateReviewService({
    repository: candidateReviewRepository,
    promoteCandidate: durableCandidateReview
      ? async () => {
          // v8 candidate rows do not yet carry a promotion receipt/lease.
          // Never create a memory first and mark the candidate afterwards:
          // a crash in that window would violate exactly-once semantics.
          throw new Error("candidate_approval_requires_atomic_promotion");
        }
      : async ({ candidate }) => {
          embeddingWriteGuard.assertWriteAllowed();
          const candidateRecord = candidateToMemoryRecord(candidate);
          const record: MemoryRecord = {
            ...candidateRecord,
            metadata: attachEmbeddingSpaceMetadata(
              candidateRecord.metadata,
              embeddingSpace,
            ),
          };
          const outcome = await memoryService.storeMemory({ record });
          return { memoryId: outcome.id };
        },
    audit: async ({ scope, action, targetId, metadata }) => {
      await persistentRepos.audit.append({ scope, action, targetId, metadata });
    },
  });

  let rawDurableJobV2ServeCapability = options.durableJobV2ServeCapability;
  let durableJobV2RuntimeBundle = options.durableJobV2RuntimeBundle;
  if (!rawDurableJobV2ServeCapability && !durableJobV2RuntimeBundle &&
      options.config.dbType === "postgres" && db instanceof PostgresProvider &&
      runtimeDefaultScope.visibility !== undefined) {
    const runtimeBundle = db.createDurableJobV2RuntimeBundle({
      clock: Date.now,
      tokenFactory: randomUUID,
      backoffMs: (attempts) => Math.min(60_000, 1_000 * (2 ** Math.max(0, attempts - 1))),
    });
    const composition = createNativeDurableJobV2Composition({
      runtimeBundle,
      scope: {
        tenantId: runtimeDefaultScope.tenantId,
        userId: runtimeDefaultScope.userId,
        appId: runtimeDefaultScope.appId,
        projectId: runtimeDefaultScope.projectId,
        agentId: runtimeDefaultScope.agentId,
        namespace: runtimeDefaultScope.namespace,
        visibility: runtimeDefaultScope.visibility,
      },
      candidateComputation: { extractor: defaultTypeExtractor, llmClient },
      llmClient,
    });
    durableJobV2RuntimeBundle = composition.runtimeBundle;
    rawDurableJobV2ServeCapability = composition.serveCapability;
  }
  let durableJobV2ServeCapability: DurableJobV2ServeCapability | undefined;
  let durableJobV2Enqueuer: RuntimeDurableJobV2Enqueuer | undefined;
  if (rawDurableJobV2ServeCapability || durableJobV2RuntimeBundle) {
    if (options.config.dbType !== "postgres") {
      throw new RuntimeDurableJobV2Error("CAPABILITY_UNAVAILABLE");
    }
    if (!rawDurableJobV2ServeCapability || !durableJobV2RuntimeBundle) {
      throw new RuntimeDurableJobV2Error("CAPABILITY_UNAVAILABLE");
    }
    try {
      durableJobV2ServeCapability = assertNativeDurableJobV2ServeCapability(
        rawDurableJobV2ServeCapability,
      );
      assertPostgresProviderOwnsDurableJobV2RuntimeBundle(db, durableJobV2RuntimeBundle);
    } catch {
      throw new RuntimeDurableJobV2Error("CAPABILITY_UNAVAILABLE");
    }
    if (durableJobV2ServeCapability.repository !== durableJobV2RuntimeBundle.repository) {
      throw new RuntimeDurableJobV2Error("CAPABILITY_UNAVAILABLE");
    }
    durableJobV2Enqueuer = createRuntimeDurableJobV2Enqueuer({
      runtimeBundle: durableJobV2RuntimeBundle,
      scope: durableJobV2ServeCapability.scope,
    }, {
      defaultScope: runtimeDefaultScope,
    });
  }

  const canonicalDomainReadsReady = async (): Promise<boolean> => {
    if (!durableJobV2RuntimeBundle || !(db instanceof PostgresProvider)) return false;
    try {
      await durableJobV2RuntimeBundle.assertEnqueueReady();
      return true;
    } catch {
      return false;
    }
  };
  const graphReadRepository: GraphReadRepository = {
    getEntity: async (id, requestedScope = runtimeDefaultScope) => {
      if (await canonicalDomainReadsReady() && db instanceof PostgresProvider) {
        return db.createCanonicalGraphReadRepository(requestedScope)
          .getEntity(id, requestedScope);
      }
      return graphRepository.getEntity(id);
    },
    findEntities: async (filter) => {
      if (await canonicalDomainReadsReady() && db instanceof PostgresProvider) {
        return db.createCanonicalGraphReadRepository(filter.scope).findEntities(filter);
      }
      return graphRepository.findEntities(filter);
    },
    findRelations: async (filter) => {
      if (await canonicalDomainReadsReady() && db instanceof PostgresProvider) {
        return db.createCanonicalGraphReadRepository(filter.scope).findRelations(filter);
      }
      return graphRepository.findRelations(filter);
    },
  };
  const consoleApi = createConsoleApi({
    service: memoryService,
    graph: new GraphQueryService(graphReadRepository),
    candidates: candidateReviewRepository,
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
      embeddingWriteGuard.assertWriteAllowed();
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
        metadata: attachEmbeddingSpaceMetadata(
          {
            ...metadata,
            source: metadata.source ?? "agent-fast-path",
            eventType,
            updatedAt: now,
            embeddingModel,
            userId: resolvedScope.userId ?? "default",
            projectPath: resolvedScope.projectId ?? "default",
            agentName: resolvedScope.agentId ?? "default",
          },
          embeddingSpace,
        ),
        provenance: {
          source: typeof metadata.source === "string" ? metadata.source : "agent-fast-path",
          sessionId: resolvedScope.sessionId,
          createdAt: now,
        },
        createdAt: now,
        updatedAt: now,
        vector: await embeddings.embed(text),
      };
      const outcome = await memoryService.storeMemory({ record });
      return {
        id: outcome.id,
        stored: outcome.stored,
        ...(outcome.warnings ? { warnings: outcome.warnings } : {}),
      };
    },
    enqueueJob: async ({ type, payload }) => {
      if (!durableJobV2Enqueuer) {
        throw new RuntimeDurableJobV2Error("CAPABILITY_UNAVAILABLE");
      }
      return durableJobV2Enqueuer.enqueue({
        type,
        payload: strictFastPathJobPayload(type, payload),
      });
    },
    ensureJob: durableJobV2Enqueuer
      ? async ({ type, payload }) => durableJobV2Enqueuer.enqueue({
          type,
          payload: strictFastPathJobPayload(type, payload),
        })
      : undefined,
    loadTreeSummaries: async (resolvedScope) => {
      if (await canonicalDomainReadsReady() && db instanceof PostgresProvider) {
        return db.createCanonicalTreeReadRepository(resolvedScope)
          .listSummaries({ scope: resolvedScope });
      }
      return treeRepository.listSummaries({ scope: resolvedScope });
    },
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

  const handlers = {
    extract_candidate: extractCandidateHandler,
    build_tree: buildTreeHandler,
    extract_graph: extractGraphHandler,
  } satisfies Record<"extract_candidate" | "build_tree" | "extract_graph", JobHandler>;

  const routingEngine = options.config.knowledgeBases?.enabled
    ? createRoutingEngine(options.config.routingRules)
    : null;

  const initializeEmbeddingRegistry = async (): Promise<RuntimeLifecycleStepResult | void> => {
    if (options.config.dbType !== "postgres") return;
    if (typeof db.getActiveEmbeddingSpace !== "function") {
      embeddingWriteGuard.update({ status: "unavailable" });
      embeddingReadGuard.update({ status: "unavailable" });
      return { ready: false, reason: "registry-capability-missing" };
    }
    try {
      const activeSpace = await db.getActiveEmbeddingSpace();
      // stop() 会先同步撤销能力。若 registry read 随后才返回，不得在
      // stopping/stopped 窗口把 read/write guard 重新激活。
      if (lifecycle.snapshot().state !== "starting") {
        resetEmbeddingGuards();
        return;
      }
      const registry = activeSpace
        ? { status: "ready" as const, activeSpace }
        : { status: "missing" as const };
      embeddingWriteGuard.update(registry);
      embeddingReadGuard.update(registry);
      const decision = embeddingWriteGuard.snapshot().decision;
      if (!decision.allowed) {
        return { ready: false, reason: decision.reasonCode };
      }
    } catch {
      embeddingWriteGuard.update({ status: "unavailable" });
      embeddingReadGuard.update({ status: "unavailable" });
      options.logger?.warn?.(
        "embedding registry unavailable; runtime is not ready (registry-read-failed)",
      );
      return { ready: false, reason: "registry-read-failed" };
    }
  };

  const lifecycle = new RuntimeLifecycle([
    {
      name: "database",
      start: () => db.initialize(),
      stop: () => db.close(),
    },
    {
      name: "embedding-registry",
      start: initializeEmbeddingRegistry,
      stop: () => {
        // 正常 stop 与 startup rollback 都必须先撤销 active 能力，再关闭 DB。
        resetEmbeddingGuards();
      },
    },
    {
      name: "tree",
      start: async () => {
        try {
          if ("initialize" in treeRepository && typeof treeRepository.initialize === "function") {
            await treeRepository.initialize();
          }
        } catch (initializeFailure) {
          // 失败 step 尚未进入 lifecycle rollback 栈，必须自行释放部分初始化资源。
          if ("close" in treeRepository && typeof treeRepository.close === "function") {
            try {
              await treeRepository.close();
            } catch (closeFailure) {
              throw new AggregateError(
                [initializeFailure, closeFailure],
                "tree startup and cleanup failed",
              );
            }
          }
          throw initializeFailure;
        }
      },
      stop: async () => {
        if ("close" in treeRepository && typeof treeRepository.close === "function") {
          await treeRepository.close();
        }
      },
    },
  ]);

  return {
    config: options.config,
    resolvedDbPath: options.resolvedDbPath,
    appId,
    defaultScope: runtimeDefaultScope,
    db,
    embeddings,
    embeddingSpace,
    embeddingWriteGuard,
    embeddingReadGuard,
    memoryRepository,
    memoryService,
    authorityScopedForgetCapability,
    durableJobV2ServeCapability,
    durableJobV2RuntimeBundle,
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
    handlers,
    lifecycle,
    start: () => lifecycle.start(),
    stop: () => {
      // lifecycle 按逆序关闭；同步撤销 guard，避免等待 tree/registry cleanup
      // 时仍有写入窗口。registry step 的 stop 仍保留用于 startup rollback。
      resetEmbeddingGuards();
      return lifecycle.stop();
    },
  };
}
