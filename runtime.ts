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
import {
  isProviderOwnedMemoryWriteKernelTransactionPort,
  type ProviderOwnedMemoryWriteKernelTransactionPort,
} from "./packages/core/src/service/write-kernel-postgres-transaction.js";
import { normalizeScope } from "./core/scope.js";
import type { MemoryRecord, MemoryScope, MemorySemanticType } from "./core/types.js";
import { computeImportanceForRecord } from "./packages/core/src/domain/recall-scoring.js";
import {
  MemoryWriteKernel,
  type MemoryWriteCommand,
  type MemoryWriteKernelResult,
  type ValidatedWriteCandidate,
  type WriteScope,
} from "./packages/core/src/service/write-kernel.js";
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
import { CandidateReviewService } from "./lifecycle/candidate-review.js";
import { candidateToMemoryRecord } from "./lifecycle/candidate-promotion.js";
import { InMemoryCandidateRepository } from "./lifecycle/candidate-repository.js";
import { mapFastPathObservationPolicy } from
  "./packages/core/src/lifecycle/fast-path-observation-policy.js";
import {
  validateCandidate,
  type CandidateSource,
  type RawCandidate,
  type ScopeLevel,
  type ValidatedCandidate,
} from "./packages/core/src/lifecycle/candidate-validator.js";
import { decideAdmissionWithBreakdown } from
  "./packages/core/src/lifecycle/admission-decision.js";
import {
  computeCandidateMaximumSimilarity,
  evaluateCandidateDedup,
  type CandidateDedupComparable,
} from
  "./packages/core/src/lifecycle/candidate-dedup-policy.js";
import { deriveCandidateConfidence } from
  "./packages/core/src/lifecycle/candidate-confidence-deriver.js";
import { detectSensitive } from
  "./packages/core/src/lifecycle/sensitive-filter.js";
import { PROMPT_INJECTION_PATTERNS } from
  "./packages/core/src/runtime/llm/extraction-rules.js";
import type { SourceKind } from
  "./packages/core/src/scoring/importance-score.js";
import { resolveGovernedWriteScope } from
  "./packages/core/src/domain/governed-write-scope.js";
import {
  createEvidenceFirstMemoryWriteExecutor,
  type EvidenceFirstMemoryWriteResult,
} from "./packages/core/src/service/evidence-first-memory-write-executor.js";
import {
  isProviderOwnedDuplicateEvidenceLinkPort,
  type ProviderOwnedDuplicateEvidenceLinkPort,
} from "./packages/core/src/service/postgres-memory-evidence-link-port.js";
import { createRuntimeCandidateMaterialization } from
  "./packages/core/src/lifecycle/runtime-candidate-materialization.js";
import { candidateTreeRoutingEnvelope } from
  "./packages/core/src/lifecycle/candidate-tree-routing.js";
import type { ScopeBoundCandidateReviewRepository } from
  "./packages/core/src/lifecycle/postgres-candidate-review-repository.js";
import {
  isProviderOwnedCandidatePromotionPort,
  type ProviderOwnedCandidatePromotionPort,
} from "./packages/core/src/db/providers/postgres-candidate-promotion.js";
import { createExtractCandidateHandler } from "./lifecycle/extract-candidate-handler.js";
import { defaultTypeExtractor } from "./lifecycle/type-extractor.js";
import { InMemoryTreeRepository } from "./tree/buffer.js";
import { createBuildTreeHandler } from "./tree/build-tree-handler.js";
import { PostgresTreeRepository } from "./tree/postgres-repository.js";
import type { TreeRepository } from "./tree/types.js";
import { isGovernedTreeSummaryForAsset } from "./tree/faithfulness.js";
import {
  GraphRepositoryOverlay,
  InMemoryGraphRepository,
  type GraphRepository,
} from "./graph/repository.js";
import { GraphQueryService, type GraphReadRepository } from "./graph/query.js";
import { createExtractGraphHandler } from "./graph/extract-graph-handler.js";
import { QueryHitsTracker } from "./graph/query-hits-tracker.js";
import { CentralityCalculator } from "./graph/centrality-calculator.js";
import { MemoryNavigationService } from
  "./packages/core/src/graph/memory-navigation-service.js";
import { resolveMemoryViewLoadoutCandidate } from
  "./packages/core/src/loadout/memory-view-candidate-resolver.js";
import { AgentLoadoutService } from "./packages/core/src/loadout/service.js";
import { MemoryViewAssetService } from
  "./packages/core/src/assets/memory-view-service.js";
import type { KnowledgeResourceCapability } from
  "./packages/core/src/resources/knowledge-resource-capability.js";
import {
  SlotInvalidationOutboxConsumer,
  SlotInvalidationOutboxLoop,
} from "./packages/core/src/context/postgres-slot-invalidation-outbox.js";
import type { ContextAssemblyReceiptRepository } from
  "./packages/core/src/context/assembly-receipt.js";
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
  assertPostgresProviderOwnsEntityGraphQueryHits,
  assertPostgresProviderOwnsGovernedRetrievalCandidateSource,
  assertPostgresProviderOwnsGovernedRetrievalHydrator,
  assertPostgresProviderOwnsDurableJobV2RuntimeBundle,
  PostgresProvider,
  type PostgresDurableJobV2RuntimeBundle,
} from "./packages/core/src/db/providers/postgres.js";
import { GovernedRetrievalEngine } from
  "./packages/core/src/retrieval/governed-retrieval-engine.js";
import { createNativeDurableJobV2Composition } from
  "./server/native-durable-job-v2-composition.js";
import { createNativeCommittedActiveDerivation } from
  "./server/native-active-derivation-composition.js";
import type { NativeCommittedActiveDerivation } from
  "./server/native-extract-candidate-handler.js";
import {
  ActiveDerivationOutboxConsumer,
  ActiveDerivationOutboxLoop,
  PostgresActiveDerivationOutboxRepository,
  type ActiveDerivationOutboxRepository,
} from "./server/postgres-active-derivation-outbox.js";
import {
  UNPRICED_RUNTIME_PRICING_SNAPSHOT,
  fingerprintRuntimeScope,
  type RuntimeCostLedger,
  type RuntimePricingSnapshot,
} from "./packages/core/src/cost/runtime-cost.js";
import { JsonlRuntimeCostLedger } from
  "./packages/core/src/cost/runtime-cost-ledger.js";
import { runtimePricingSnapshotFromConfig } from
  "./packages/core/src/cost/runtime-pricing.js";

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
  /** 测试/宿主可替换的 append-only 账本；默认写入全局 runtime-cost.jsonl。 */
  runtimeCostLedger?: RuntimeCostLedger;
  /** 显式版本化价格快照；未配置时事件保留为 unpriced。 */
  runtimePricingSnapshot?: RuntimePricingSnapshot;
  treeRepository?: TreeRepository;
  /** Trusted native-v2 composition only; structural/legacy-handler capabilities are rejected. */
  durableJobV2ServeCapability?: DurableJobV2ServeCapability;
  /** Same-provider atomic repository/effect/readiness capability required by production serve. */
  durableJobV2RuntimeBundle?: PostgresDurableJobV2RuntimeBundle;
  /** Provider-owned v11 memory.written outbox capability for post-commit derivation repair. */
  activeDerivationOutboxRepository?: ActiveDerivationOutboxRepository;
}

const COMMITTED_ACTIVE_DERIVATION_WARNING =
  "Committed active memory warm derivation failed after durable write receipt";

function warnCommittedActiveDerivation(logger: RuntimeLogger | undefined): void {
  try {
    logger?.warn?.(COMMITTED_ACTIVE_DERIVATION_WARNING);
  } catch {
    // Observability is best-effort after the authoritative receipt is committed.
  }
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
  /** F0 PostgreSQL 唯一事件写入能力；其它 provider 保留显式兼容路径。 */
  memoryWriteKernel?: MemoryWriteKernel;
  /** REST/MCP/OpenClaw 共同探测的 provider-agnostic 深接口。 */
  executeMemoryWrite?: (command: MemoryWriteCommand) => Promise<MemoryWriteKernelResult>;
  authorityScopedForgetCapability?: AuthorityScopedForgetCapability;
  durableJobV2ServeCapability?: DurableJobV2ServeCapability;
  durableJobV2RuntimeBundle?: PostgresDurableJobV2RuntimeBundle;
  ingestionStore: PersistentRepositories;
  ingestionPipeline: IngestionPipeline;
  candidateRepository: InMemoryCandidateRepository;
  candidateReview: CandidateReviewService;
  consoleApi: ConsoleApi;
  llmClient: LlmClient;
  runtimeCostLedger: RuntimeCostLedger;
  treeRepository: TreeRepository;
  graphRepository: GraphRepository;
  queryHitsTracker: QueryHitsTracker;
  centralityCalculator: CentralityCalculator;
  agentFastPath: AgentFastPathService;
  /** F2 private asset governance facade; absent on providers without v20 overlay support. */
  memoryViewAssets?: MemoryViewAssetService;
  /** F3 private append-only Loadout control facade. */
  agentLoadouts?: AgentLoadoutService;
  /** F3 exact-scope, read-only Knowledge resource capability. */
  knowledgeResources?: KnowledgeResourceCapability;
  /** F1 durable session assembly explain capability; PostgreSQL schema v22+. */
  contextAssemblyReceipts?: ContextAssemblyReceiptRepository;
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
      ...(payload.routing === undefined ? {} : { routing: payload.routing }),
      ...(payload.targetIdempotencyKey === undefined
        ? {}
        : { targetIdempotencyKey: payload.targetIdempotencyKey }),
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

function postgresCandidatePromotionPort(
  config: MemoryConfig,
  db: DatabaseProvider,
  scope: MemoryScope,
): ProviderOwnedCandidatePromotionPort | undefined {
  if (config.dbType !== "postgres" || !(db instanceof PostgresProvider)) return undefined;
  const port = db.createCandidatePromotionPort(scope);
  if (!isProviderOwnedCandidatePromotionPort(port)) {
    throw new Error("provider-owned candidate promotion capability is required");
  }
  return port;
}

function postgresMemoryWriteKernelTransactionPort(
  config: MemoryConfig,
  db: DatabaseProvider,
): ProviderOwnedMemoryWriteKernelTransactionPort | undefined {
  if (config.dbType !== "postgres" || !(db instanceof PostgresProvider)) return undefined;
  const port = db.createMemoryWriteKernelTransactionPort();
  if (!isProviderOwnedMemoryWriteKernelTransactionPort(port)) {
    throw new Error("provider-owned memory write kernel transaction capability is required");
  }
  return port;
}

function postgresDuplicateEvidenceLinkPort(
  config: MemoryConfig,
  db: DatabaseProvider,
): ProviderOwnedDuplicateEvidenceLinkPort | undefined {
  if (config.dbType !== "postgres" || !(db instanceof PostgresProvider)) return undefined;
  const port = db.createDuplicateEvidenceLinkPort();
  if (!isProviderOwnedDuplicateEvidenceLinkPort(port)) {
    throw new Error("provider-owned duplicate evidence link capability is required");
  }
  return port;
}

function trustedRuntimeWriteScope(value: unknown, authority: unknown): WriteScope {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !authority || typeof authority !== "object" || Array.isArray(authority)) {
    throw new Error("runtime write scope is invalid");
  }
  const scope = value as Record<string, unknown>;
  const owner = authority as Record<string, unknown>;
  const required = [
    "tenantId", "userId", "appId", "projectId", "agentId", "namespace",
  ] as const;
  for (const field of required) {
    if (typeof scope[field] !== "string" || String(scope[field]).trim().length === 0) {
      throw new Error(`runtime write scope ${field} is required`);
    }
  }
  if (scope.tenantId !== owner.tenantId || scope.userId !== owner.userId) {
    throw new Error("runtime write authority does not own the requested scope");
  }
  for (const field of ["workspaceId", "sessionId"] as const) {
    if (owner[field] !== undefined &&
        (typeof owner[field] !== "string" || String(owner[field]).trim().length === 0)) {
      throw new Error(`runtime write authority ${field} is invalid`);
    }
    if (scope[field] !== owner[field]) {
      throw new Error("runtime write authority does not own the requested scope");
    }
  }
  if (scope.visibility !== undefined &&
      !["private", "workspace", "team", "public"].includes(String(scope.visibility))) {
    throw new Error("runtime write scope visibility is invalid");
  }
  for (const field of ["workspaceId", "sessionId"] as const) {
    if (scope[field] !== undefined &&
        (typeof scope[field] !== "string" || String(scope[field]).trim().length === 0)) {
      throw new Error(`runtime write scope ${field} is invalid`);
    }
  }
  return Object.freeze({
    tenantId: scope.tenantId as string,
    userId: scope.userId as string,
    appId: scope.appId as string,
    projectId: scope.projectId as string,
    agentId: scope.agentId as string,
    namespace: scope.namespace as string,
    ...(scope.workspaceId === undefined ? {} : { workspaceId: scope.workspaceId as string }),
    ...(scope.sessionId === undefined ? {} : { sessionId: scope.sessionId as string }),
    visibility: (scope.visibility ?? "private") as WriteScope["visibility"],
  });
}

function runtimeCandidateScope(scope: WriteScope): ScopeLevel {
  return resolveGovernedWriteScope({ exactScope: scope }).sourceLevel;
}

function runtimeWriteSourceKind(command: MemoryWriteCommand): SourceKind {
  const source = ("provenance" in command ? command.provenance?.source : undefined) ??
    command.metadata?.source;
  if (source === "user" || source === "mcp") return "session_user";
  if (source === "scan") return "document";
  if (source === "tool") return "tool_result";
  if (source === "work_log") return "work_log";
  if (source === "rule_file") return "rule_file";
  return "agent_output";
}

function runtimeWriteSalience(command: MemoryWriteCommand): number {
  const metadataSalience = command.metadata?.salience;
  if (typeof metadataSalience === "number" && Number.isFinite(metadataSalience)) {
    return Math.max(0, Math.min(1, metadataSalience));
  }
  if ("confidence" in command && typeof command.confidence === "number" &&
      Number.isFinite(command.confidence)) {
    return Math.max(0, Math.min(1, command.confidence));
  }
  return command.type === "saveExplicit" ? 1 : 0.5;
}

function isValidRuntimeEmbeddingVector(
  vector: readonly number[],
  expectedDim: number,
): boolean {
  if (vector.length !== expectedDim) return false;
  let squaredNorm = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) return false;
    squaredNorm += value * value;
  }
  return Number.isFinite(squaredNorm) && squaredNorm > 0;
}

function runtimeWriteEvidenceIds(command: MemoryWriteCommand): readonly string[] {
  if ("evidenceIds" in command && command.evidenceIds && command.evidenceIds.length > 0) {
    return Object.freeze([...command.evidenceIds]);
  }
  return Object.freeze([]);
}

function publicMemoryWriteResult(result: EvidenceFirstMemoryWriteResult): MemoryWriteKernelResult {
  switch (result.status) {
    case "evidence_not_persisted": return result.evidence;
    case "governance_persisted":
    case "governance_rejected":
    case "governance_duplicate":
    case "governance_ignored": return result.governance;
    default: return result;
  }
}

function runtimeValidatedCandidate(
  command: Exclude<MemoryWriteCommand, { type: "correctMemory" }>,
  scope: WriteScope,
  text: string,
): ValidatedCandidate | { rejected: true; reason: string } {
  const eventIds = runtimeWriteEvidenceIds(command);
  const level = runtimeCandidateScope(scope);
  const raw: RawCandidate = {
    text,
    semanticType: command.semanticType,
    salience: runtimeWriteSalience(command),
    temporality: command.type === "observeAuto" && command.intent !== "remember"
      ? "ephemeral"
      : "persistent",
    crossContextual: command.type === "saveExplicit" ||
      (command.type === "observeAuto" && command.intent === "remember"),
    targetScope: level,
    ...(typeof command.metadata?.profileDimension === "string"
      ? { profileDimension: command.metadata.profileDimension }
      : {}),
    evidence: { quote: text, eventIds },
  };
  const source: CandidateSource = { text, scope: level, eventIds };
  const verdict = validateCandidate(raw, source);
  if (verdict.rejected) return verdict;
  const treeRouting = candidateTreeRoutingEnvelope({
    scope,
    semanticType: verdict.semanticType,
    targetScope: verdict.targetScope,
    riskFlags: verdict.riskFlags,
    evidenceIds: verdict.evidence.eventIds ?? [],
    explicit: command.type === "saveExplicit" ||
      (command.type === "observeAuto" && command.intent === "remember"),
  });
  return Object.freeze({
    ...verdict,
    ...(treeRouting === undefined ? {} : { treeRouting }),
  });
}

function runtimeKindOnlyExplicitCandidate(
  command: Extract<MemoryWriteCommand, { type: "saveExplicit" }>,
  scope: WriteScope,
  text: string,
): { accepted: true; candidate: ValidatedWriteCandidate } |
  { accepted: false; reason: string } {
  if (text.replace(/\s+/g, "").length < 8) {
    return { accepted: false, reason: "text_too_short" };
  }
  const promptRisk = PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(text));
  if (promptRisk) {
    return { accepted: false, reason: "prompt_injection_detected" };
  }
  const sensitive = detectSensitive(text);
  return {
    accepted: true,
    candidate: Object.freeze({
      compatibility: "kind_only_explicit",
      rejected: false,
      text,
      kind: command.kind,
      salience: runtimeWriteSalience(command),
      targetScope: runtimeCandidateScope(scope),
      evidence: Object.freeze({
        quote: text,
        eventIds: runtimeWriteEvidenceIds(command),
      }),
      riskFlags: Object.freeze(sensitive.sensitive ? ["sensitive"] : []),
      evidenceOnly: false,
      confidence: 1,
    }),
  };
}

export function createMengshuRuntime(options: RuntimeOptions): MengshuRuntime {
  validateEmbeddingConfig(options.config.embedding);

  const appId = options.appId ?? "mengshu";
  const runtimeDefaultScope = options.defaultScope ?? defaultScope(appId);
  const runtimeCostLedger = options.runtimeCostLedger ?? new JsonlRuntimeCostLedger();
  const runtimePricingSnapshot = options.runtimePricingSnapshot ??
    runtimePricingSnapshotFromConfig(options.config) ?? UNPRICED_RUNTIME_PRICING_SNAPSHOT;
  const runtimeCostContext = {
    category: "native_memory" as const,
    scopeFingerprint: fingerprintRuntimeScope(runtimeDefaultScope),
  };
  const onCostLedgerError = () => options.logger?.warn?.(
    "runtime cost ledger append failed; provider result was preserved",
  );
  const db = options.db ?? DatabaseFactory.createProvider(options.config, options.resolvedDbPath);
  const embeddings = options.embeddings ?? new Embeddings(
    options.config.embedding,
    options.config.batchProcessing,
    {
      costLedger: runtimeCostLedger,
      pricingSnapshot: runtimePricingSnapshot,
      costContext: runtimeCostContext,
      onCostLedgerError,
    },
  );
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
  const workMemoryGraphRepository =
    options.config.dbType === "postgres" && db instanceof PostgresProvider
      ? db.createWorkMemoryGraphRepository()
      : undefined;
  const graphRepository: GraphRepository =
    options.config.dbType === "postgres" && db instanceof PostgresProvider &&
      workMemoryGraphRepository
      ? new GraphRepositoryOverlay(
          db.createCanonicalEntityGraphRepository(runtimeDefaultScope),
          workMemoryGraphRepository,
        )
      : new InMemoryGraphRepository();
  const memoryNavigation = new MemoryNavigationService({
    repository: graphRepository,
    ...(options.config.dbType === "postgres" && db instanceof PostgresProvider
      ? { evidenceContent: db.createEvidenceContentReadPort() }
      : {}),
  });
  const queryHitsTracker = options.config.dbType === "postgres" && db instanceof PostgresProvider
    ? new QueryHitsTracker({
        entityGraphQueryHits: assertPostgresProviderOwnsEntityGraphQueryHits(
          db,
          db.createEntityGraphQueryHitsPort(),
        ),
      })
    : new QueryHitsTracker({ graphRepo: graphRepository });
  // F5 stage-1 repositories are also the shared audit path for direct memory
  // writes, including cleanup-warning receipts that already prove persistence.
  const persistentRepos = createPersistentRepositories({
    db,
    embeddings: guardedPersistenceEmbeddings,
    scope: runtimeDefaultScope,
    embeddingSpace,
  });
  const memoryRepository = new LegacyDatabaseAdapter(db, { appId });
  const activeMemoryDerivationReadPort = options.config.dbType === "postgres" &&
      db instanceof PostgresProvider
    ? db.createActiveMemoryDerivationReadPort()
    : undefined;
  const canonicalTreeReadRepositoryFactory = db instanceof PostgresProvider
    ? (scope: MemoryScope) => db.createCanonicalTreeReadRepository(scope)
    : undefined;
  const memoryViewAssetRepository = options.config.dbType === "postgres" &&
      db instanceof PostgresProvider
    ? db.createMemoryViewAssetRepository()
    : undefined;
  const agentLoadoutRepository = options.config.dbType === "postgres" &&
      db instanceof PostgresProvider
    ? db.createAgentLoadoutRepository()
    : undefined;
  const contextAssemblyReceipts = options.config.dbType === "postgres" &&
      db instanceof PostgresProvider
    ? db.createContextAssemblyReceiptRepository()
    : undefined;
  const knowledgeResources = options.config.dbType === "postgres" &&
      db instanceof PostgresProvider
    ? db.createKnowledgeResourceCapability()
    : undefined;
  const agentLoadouts = agentLoadoutRepository
    ? new AgentLoadoutService(agentLoadoutRepository)
    : undefined;
  const assetSourceReadPort = memoryViewAssetRepository
    ? activeMemoryDerivationReadPort
    : undefined;
  const memoryViewAssets = memoryViewAssetRepository && assetSourceReadPort
    ? new MemoryViewAssetService({
        repository: memoryViewAssetRepository,
        sourceResolver: {
          resolveMemories: async ({ scope, recordIds }) => {
            try {
              const records = await assetSourceReadPort.readCommittedActiveRecords({
                scope,
                activeMemoryIds: recordIds,
                signal: new AbortController().signal,
              });
              return records.map((record) => {
                const candidate = record.governance.candidate as Record<string, unknown>;
                const riskFlags = Array.isArray(candidate.riskFlags) &&
                    candidate.riskFlags.every((flag) => typeof flag === "string")
                  ? candidate.riskFlags as string[]
                  : ["invalid_governance"];
                return {
                  id: record.id,
                  scope: record.scope,
                  lifecycleStatus: "active" as const,
                  semanticType: record.semanticType,
                  evidenceIds: record.evidenceIds,
                  riskFlags,
                  unresolvedConflict: riskFlags.includes("conflict_possible"),
                };
              });
            } catch {
              // Exact read is fail-closed; the service marks every unresolved ref stale.
              return [];
            }
          },
          resolveTrees: async ({ scope, treeNodeIds }) => {
            try {
              if (!canonicalTreeReadRepositoryFactory) return [];
              const repository = canonicalTreeReadRepositoryFactory(scope);
              const nodes = await Promise.all(treeNodeIds.map((id) => repository.getSummary(id)));
              const leafIds = [...new Set(nodes.flatMap((node) => node?.leafIds ?? []))];
              const activeRecords = leafIds.length === 0
                ? []
                : await assetSourceReadPort.readCommittedActiveRecords({
                    scope,
                    activeMemoryIds: leafIds,
                    signal: new AbortController().signal,
                  });
              const activeById = new Map(activeRecords.map((record) => [record.id, record]));
              return nodes.flatMap((node) => {
                if (!node) return [];
                const records = node.leafIds.map((id) => activeById.get(id));
                const semanticTypes: MemorySemanticType[] = [...new Set(records.flatMap((record) =>
                  record?.semanticType === undefined
                    ? [] as MemorySemanticType[]
                    : [record.semanticType]))];
                const evidenceIds = [...new Set(node.evidenceChunkIds)];
                const evidenceMatches = records.every((record) => record !== undefined) &&
                  evidenceIds.every((id) => records.some((record) => record?.evidenceIds.includes(id)));
                const faithfulnessPassed = isGovernedTreeSummaryForAsset(
                  node,
                  options.config.tree?.summaryFaithfulness?.mode ?? "high_risk",
                );
                return [{
                  id: node.id,
                  scope: node.scope,
                  evidenceIds,
                  semanticTypes,
                  stale: node.status !== "sealed" || !evidenceMatches ||
                    semanticTypes.length === 0 || !faithfulnessPassed,
                  faithfulnessPassed,
                }];
              });
            } catch {
              // Tree-backed assets fail closed when canonical exact-scope reads are unavailable.
              return [];
            }
          },
        },
      })
    : undefined;
  const forgetTransactions = postgresForgetTransactionPort(options.config, db);
  const atomicStore = postgresAtomicMemoryStorePort(options.config, db);
  const governedRetrieval = options.config.dbType === "postgres" && db instanceof PostgresProvider
    ? new GovernedRetrievalEngine(assertPostgresProviderOwnsGovernedRetrievalHydrator(
        db,
        db.createGovernedRetrievalHydrator(),
      ))
    : undefined;
  const governedCandidateSource = options.config.dbType === "postgres" && db instanceof PostgresProvider
    ? assertPostgresProviderOwnsGovernedRetrievalCandidateSource(
        db,
        db.createGovernedRetrievalCandidateSource(),
      )
    : undefined;
  const memoryService = new DefaultMemoryService({
    repository: memoryRepository,
    embeddings,
    atomicStore,
    audit: persistentRepos.audit,
    queryHitsTracker,
    forgetTransactions,
    governedRetrieval,
    governedCandidateSource,
    embeddingReadGuard,
    // 与 candidate/document/chunk/observation 共用同一 mutable registry gate；
    // public REST/MCP/script/doctor 经 memoryService 写入时不再有 vector 旁路。
    embeddingWriteGuard,
    stampEmbeddingMetadata: (metadata) =>
      attachEmbeddingSpaceMetadata({ ...metadata }, embeddingSpace),
  });
  const memoryWriteKernelTransactions = postgresMemoryWriteKernelTransactionPort(options.config, db);
  const duplicateEvidenceLinkPort = postgresDuplicateEvidenceLinkPort(options.config, db);
  const candidateDedupReadPort = memoryWriteKernelTransactions && db instanceof PostgresProvider
    ? db.createCandidateDedupReadPort()
    : undefined;
  const candidateDedupReadsByRequest = new WeakMap<
    ValidatedWriteCandidate,
    Promise<readonly CandidateDedupComparable[]>
  >();
  const readRuntimeCandidateDedupRecords = (
    command: Exclude<MemoryWriteCommand, { type: "correctMemory" }>,
    scope: WriteScope,
    candidate: ValidatedWriteCandidate,
  ): Promise<readonly CandidateDedupComparable[]> => {
    if (!candidateDedupReadPort) {
      return Promise.reject(new Error("runtime candidate dedup capability is unavailable"));
    }
    const cached = candidateDedupReadsByRequest.get(candidate);
    if (cached) return cached;
    const pending = candidateDedupReadPort.findExisting({
      scope: { ...scope, visibility: scope.visibility ?? "private" },
      kind: command.kind,
      ...(command.semanticType === undefined ? {} : { semanticType: command.semanticType }),
      embeddingSpaceId: embeddingSpace.embeddingSpaceId,
      embeddingSpaceState: "known-queryable",
      excludeIds: [],
    });
    candidateDedupReadsByRequest.set(candidate, pending);
    return pending;
  };
  const memoryWriteKernel = memoryWriteKernelTransactions
    ? new MemoryWriteKernel({
        resolveAuthority: ({ serverAuthority, clientScope }) =>
          trustedRuntimeWriteScope(clientScope, serverAuthority),
        normalize: ({ command, scope }) => {
          if (!("text" in command) || typeof command.text !== "string" ||
              command.text.trim().length === 0) {
            throw new Error("runtime evidence text is required");
          }
          return {
            // Evidence quote fidelity: do not trim or rewrite the original event.
            text: command.text,
            metadata: Object.freeze(attachEmbeddingSpaceMetadata({
              ...(command.metadata ?? {}),
              ...(scope.sessionId === undefined ? {} : { sessionId: scope.sessionId }),
            }, embeddingSpace)),
            promptRisk: PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(command.text)),
          };
        },
        embeddingGuard: () => {
          embeddingWriteGuard.assertWriteAllowed();
          return { ok: true as const };
        },
        embed: ({ text }) => guardedPersistenceEmbeddings.embed(text),
        validate: ({ command, scope, normalized }) => {
          if (command.type === "importEvidence") {
            return {
              accepted: true as const,
              candidate: Object.freeze({
                phase: "raw_evidence",
                evidenceOnly: true,
                quote: normalized.text,
                sourceId: command.sourceId,
              }),
            };
          }
          if (command.type === "correctMemory") {
            return { accepted: false as const, reason: "runtime_correction_requires_forget_capability" };
          }
          if (command.semanticType === undefined) {
            if (command.type !== "saveExplicit") {
              return { accepted: false as const, reason: "unknown_semantic_type" };
            }
            const compatibility = runtimeKindOnlyExplicitCandidate(
              command,
              scope,
              normalized.text,
            );
            return compatibility;
          }
          const verdict = runtimeValidatedCandidate(command, scope, normalized.text);
          if (verdict.rejected) {
            return { accepted: false as const, reason: verdict.reason };
          }
          if (verdict.semanticType !== command.semanticType) {
            return { accepted: false as const, reason: "semantic_type_recalibration_required" };
          }
          const eventIds = verdict.evidence.eventIds ?? [];
          const confidenceBreakdown = deriveCandidateConfidence({
            semanticType: verdict.semanticType,
            eventIds,
            evidenceFacts: eventIds.map((evidenceId) => Object.freeze({
              evidenceId,
              sourceKind: runtimeWriteSourceKind(command),
            })),
          });
          if (!confidenceBreakdown) {
            return { accepted: false as const, reason: "confidence_evidence_unavailable" };
          }
          return {
            accepted: true as const,
            candidate: Object.freeze({
              ...verdict,
              confidence: confidenceBreakdown.score,
              confidenceBreakdown,
            }),
          };
        },
        scoreAdmission: async ({ command, scope, normalized, vector, candidate }) => {
          if (command.type === "importEvidence") {
            return {
              route: "evidence_only" as const,
              valueScore: 0,
              reason: "raw_evidence_before_candidate_admission",
            };
          }
          if (command.type === "correctMemory") {
            return { route: "drop" as const, valueScore: 0, reason: "unsupported_runtime_command" };
          }
          if (candidate.compatibility === "kind_only_explicit") {
            return {
              route: "lookup_only" as const,
              valueScore: 0.5,
              reason: "kind_only_explicit_lookup",
            };
          }
          const validatedCandidate = candidate as unknown as ValidatedCandidate;
          const admissionIntent = command.type === "saveExplicit" || command.intent === "remember"
            ? "remember"
            : "auto";
          const sourceKind = runtimeWriteSourceKind(command);
          if (
            validatedCandidate.evidenceOnly ||
            validatedCandidate.riskFlags.includes("prompt_injection")
          ) {
            return decideAdmissionWithBreakdown(validatedCandidate, {
              intent: admissionIntent,
              sourceKind,
              hasConflict: false,
            });
          }
          if (!isValidRuntimeEmbeddingVector(vector, embeddingSpace.fingerprint.dim)) {
            return {
              route: "drop" as const,
              valueScore: 0,
              reason: "value_score_signal_invalid",
            };
          }
          const existingRecords = await readRuntimeCandidateDedupRecords(
            command,
            scope,
            candidate,
          );
          const maximumSimilarity = computeCandidateMaximumSimilarity({
            candidate: {
              text: normalized.text,
              vector,
              salience: runtimeWriteSalience(command),
              confidence: typeof candidate.confidence === "number"
                ? candidate.confidence
                : command.confidence,
              kind: command.kind,
              ...(command.semanticType === undefined ? {} : { semanticType: command.semanticType }),
            },
            existingRecords,
            batchRecords: [],
          });
          if (!maximumSimilarity.known) {
            return {
              route: "drop" as const,
              valueScore: 0,
              reason: "value_score_signal_invalid",
            };
          }
          return decideAdmissionWithBreakdown(validatedCandidate, {
            intent: admissionIntent,
            sourceKind,
            hasConflict: false,
            valueSignals: {
              mode: "authoritative",
              sourceKind,
              maxSimilarity: maximumSimilarity.maxSimilarity,
            },
          });
        },
        scoreImportance: ({ command, candidate }) => {
          if (command.type === "importEvidence" || command.type === "correctMemory" ||
              candidate.compatibility === "kind_only_explicit") {
            return computeImportanceForRecord({});
          }
          const validated = candidate as unknown as ValidatedCandidate;
          return computeImportanceForRecord({
            salience: validated.salience,
            sourceKind: runtimeWriteSourceKind(command),
            explicitSave: command.type === "saveExplicit" || command.intent === "remember",
            semanticType: validated.semanticType,
          });
        },
        exactDedup: async ({ command, scope, normalized, candidate }) => {
          if (command.type === "importEvidence" || command.type === "correctMemory") {
            return { duplicate: false };
          }
          const existingRecords = await readRuntimeCandidateDedupRecords(command, scope, candidate);
          const result = evaluateCandidateDedup({
            candidate: {
              text: normalized.text,
              salience: runtimeWriteSalience(command),
              confidence: typeof candidate.confidence === "number"
                ? candidate.confidence
                : command.confidence,
              kind: command.kind,
              ...(command.semanticType === undefined ? {} : { semanticType: command.semanticType }),
            },
            existingRecords,
            batchRecords: [],
          });
          return result.duplicate
            ? { duplicate: true, duplicateOf: result.duplicateOf, layer: result.layer }
            : { duplicate: false };
        },
        semanticDedup: async ({ command, scope, normalized, vector, candidate }) => {
          if (command.type === "importEvidence" || command.type === "correctMemory") {
            return { duplicate: false };
          }
          const existingRecords = await readRuntimeCandidateDedupRecords(command, scope, candidate);
          const result = evaluateCandidateDedup({
            candidate: {
              text: normalized.text,
              vector,
              salience: runtimeWriteSalience(command),
              confidence: typeof candidate.confidence === "number"
                ? candidate.confidence
                : command.confidence,
              kind: command.kind,
              ...(command.semanticType === undefined ? {} : { semanticType: command.semanticType }),
            },
            existingRecords,
            batchRecords: [],
          });
          return result.duplicate
            ? { duplicate: true, duplicateOf: result.duplicateOf, layer: result.layer }
            : { duplicate: false };
        },
        transaction: (work) => memoryWriteKernelTransactions.transaction(work),
        ack: () => undefined,
        createId: randomUUID,
        now: Date.now,
      })
    : undefined;
  const evidenceFirstMemoryWriteExecutor = memoryWriteKernel
    ? createEvidenceFirstMemoryWriteExecutor({
        executeKernel: (command) => memoryWriteKernel.execute(command),
        ...(duplicateEvidenceLinkPort
          ? {
              linkDuplicateEvidence: ({ command, evidenceMemoryId, targetMemoryId }) =>
                duplicateEvidenceLinkPort.linkDuplicateEvidence({
                  scope: trustedRuntimeWriteScope(
                    command.clientScope,
                    command.serverAuthority,
                  ),
                  targetMemoryId,
                  evidenceMemoryId,
                  createdAt: Date.now(),
                }),
            }
          : {}),
      })
    : undefined;
  const authorityScopedForgetCapability = forgetTransactions
    ? createAuthorityScopedForgetCapability(memoryService, forgetTransactions)
    : undefined;

  const llmClient = options.llmClient ?? createLlmClient(options.config.llm, {
    costLedger: runtimeCostLedger,
    pricingSnapshot: runtimePricingSnapshot,
    costContext: runtimeCostContext,
    onCostLedgerError,
  });
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
  const candidatePromotionPort = postgresCandidatePromotionPort(
    options.config,
    db,
    runtimeDefaultScope,
  );
  let deriveCommittedActive: NativeCommittedActiveDerivation | undefined;
  const candidateReview = new CandidateReviewService({
    repository: candidateReviewRepository,
    ...(candidatePromotionPort ? { replayApprovedPromotion: true as const } : {}),
    promoteCandidate: candidatePromotionPort
      ? async ({ candidate }) => {
          embeddingWriteGuard.assertWriteAllowed();
          const candidateRecord = candidateToMemoryRecord(candidate, candidate.createdAt);
          const governedImportance = typeof candidate.metadata.importance === "number" &&
              Number.isFinite(candidate.metadata.importance) &&
              candidate.metadata.importance >= 0 && candidate.metadata.importance <= 1
            ? candidate.metadata.importance
            : candidateRecord.importance;
          const metadata = attachEmbeddingSpaceMetadata(
            {
              ...candidateRecord.metadata,
              admissionRoute: "active",
              contextEligible: true,
              importance: governedImportance,
            },
            embeddingSpace,
          );
          const vector = await guardedPersistenceEmbeddings.embed(candidate.text);
          // Registry capability may be revoked while the provider call is in flight.
          embeddingWriteGuard.assertWriteAllowed();
          const outcome = await candidatePromotionPort.promote({
            candidateId: candidate.id,
            material: {
              id: candidateRecord.id,
              importance: governedImportance,
              category: candidateRecord.category,
              container: candidateRecord.container,
              metadata,
              provenance: candidateRecord.provenance,
              createdAt: candidateRecord.createdAt,
              updatedAt: candidateRecord.updatedAt,
              vector,
            },
          });
          if (!deriveCommittedActive) {
            throw new RuntimeDurableJobV2Error("CAPABILITY_UNAVAILABLE");
          }
          if (runtimeDefaultScope.visibility === undefined) {
            throw new RuntimeDurableJobV2Error("CAPABILITY_UNAVAILABLE");
          }
          await deriveCommittedActive({
            scope: Object.freeze({
              tenantId: runtimeDefaultScope.tenantId,
              userId: runtimeDefaultScope.userId,
              appId: runtimeDefaultScope.appId,
              projectId: runtimeDefaultScope.projectId,
              agentId: runtimeDefaultScope.agentId,
              namespace: runtimeDefaultScope.namespace,
              visibility: runtimeDefaultScope.visibility,
            }),
            context: Object.freeze({
              ...(runtimeDefaultScope.workspaceId === undefined
                ? {}
                : { workspaceId: runtimeDefaultScope.workspaceId }),
              ...(runtimeDefaultScope.sessionId === undefined
                ? {}
                : { sessionId: runtimeDefaultScope.sessionId }),
            }),
            activeMemoryIds: Object.freeze([outcome.memoryId]),
            signal: new AbortController().signal,
          });
          return {
            memoryId: outcome.memoryId,
            governanceCommitted: true as const,
          };
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
    deriveCommittedActive = createNativeCommittedActiveDerivation({
      readPort: activeMemoryDerivationReadPort!,
      workMemoryGraph: workMemoryGraphRepository!,
      repository: runtimeBundle.repository,
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
      candidateMaterialization: createRuntimeCandidateMaterialization({
        embeddingSpace,
        assertEmbeddingWriteAllowed: () => embeddingWriteGuard.assertWriteAllowed(),
        embed: (text) => embeddings.embed(text),
        dedupReadPort: db.createCandidateDedupReadPort(),
      }),
      candidateEvidenceRead: db.createCandidateEvidenceReadPort(),
      authoritativeEntityGraphRead: db.createAuthoritativeEntityGraphReadPort(),
      prepareEntityEmbeddings: async (entities, signal) => {
        if (signal.aborted) {
          const error = new Error("Entity Graph embedding preparation aborted");
          error.name = "AbortError";
          throw error;
        }
        embeddingWriteGuard.assertWriteAllowed();
        const vectors = await embeddings.embedBatch(entities.map((entity) => entity.displayName));
        embeddingWriteGuard.assertWriteAllowed();
        if (signal.aborted) {
          const error = new Error("Entity Graph embedding preparation aborted");
          error.name = "AbortError";
          throw error;
        }
        return Object.freeze({
          authority: "runtime_active_embedding_space" as const,
          embeddingSpaceId: embeddingSpace.embeddingSpaceId,
          embeddingSpaceState: embeddingSpace.state,
          vectors: Object.freeze(entities.map((entity, index) => Object.freeze({
            rawEntityId: entity.id,
            vector: Object.freeze([...(vectors[index] ?? [])]),
          }))),
        });
      },
      deriveCommittedActive,
      onCommittedActiveDerivationWarning: () => warnCommittedActiveDerivation(options.logger),
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
    if (!(db instanceof PostgresProvider) || !workMemoryGraphRepository) {
      throw new RuntimeDurableJobV2Error("CAPABILITY_UNAVAILABLE");
    }
    deriveCommittedActive ??= createNativeCommittedActiveDerivation({
      readPort: activeMemoryDerivationReadPort!,
      workMemoryGraph: workMemoryGraphRepository,
      repository: durableJobV2RuntimeBundle.repository,
    });
  }

  const executeRuntimeMemoryWrite = evidenceFirstMemoryWriteExecutor
    ? async (command: MemoryWriteCommand): Promise<MemoryWriteKernelResult> => {
        const evidenceFirstResult = await evidenceFirstMemoryWriteExecutor.execute(command);
        const result = publicMemoryWriteResult(evidenceFirstResult);
        if (result.status === "persisted" && "route" in result &&
            result.route === "active" && result.recordType === "memory") {
          if (!deriveCommittedActive) {
            throw new RuntimeDurableJobV2Error("CAPABILITY_UNAVAILABLE");
          }
          const scope = trustedRuntimeWriteScope(command.clientScope, command.serverAuthority);
          if (scope.visibility === undefined) {
            throw new RuntimeDurableJobV2Error("CAPABILITY_UNAVAILABLE");
          }
          try {
            await deriveCommittedActive({
              scope: Object.freeze({
                tenantId: scope.tenantId,
                userId: scope.userId,
                appId: scope.appId,
                projectId: scope.projectId,
                agentId: scope.agentId,
                namespace: scope.namespace,
                visibility: scope.visibility,
              }),
              context: Object.freeze({
                ...(scope.workspaceId === undefined ? {} : { workspaceId: scope.workspaceId }),
                ...(scope.sessionId === undefined ? {} : { sessionId: scope.sessionId }),
              }),
              activeMemoryIds: Object.freeze([result.memoryId]),
              signal: new AbortController().signal,
            });
          } catch {
            warnCommittedActiveDerivation(options.logger);
          }
        }
        return result;
      }
    : undefined;

  const activeDerivationOutboxRepository = options.activeDerivationOutboxRepository ??
    (options.db === undefined && db instanceof PostgresProvider
      ? new PostgresActiveDerivationOutboxRepository(db.createActiveDerivationOutboxPool())
      : undefined);
  const activeDerivationOutboxLoop = activeDerivationOutboxRepository &&
      options.config.dbType === "postgres" && deriveCommittedActive
    ? new ActiveDerivationOutboxLoop({
        consumer: new ActiveDerivationOutboxConsumer({
          repository: activeDerivationOutboxRepository,
          deriveCommittedActive,
        }),
        onError: () => warnCommittedActiveDerivation(options.logger),
      })
    : undefined;
  if (activeDerivationOutboxRepository && !activeDerivationOutboxLoop) {
    throw new RuntimeDurableJobV2Error("CAPABILITY_UNAVAILABLE");
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
  const graphReadRepository: GraphReadRepository = graphRepository;
  const centralityCalculator = new CentralityCalculator({
    graphRepo: graphRepository,
    ...(options.config.dbType === "postgres" && durableJobV2RuntimeBundle
      ? {
          refreshCanonical: async (scope: MemoryScope) => {
            await durableJobV2RuntimeBundle.assertEnqueueReady();
            await durableJobV2RuntimeBundle.refreshCanonicalEntityCentrality({
              scope,
              now: Date.now(),
              signal: new AbortController().signal,
            });
          },
        }
      : {}),
  });
  const consoleApi = createConsoleApi({
    service: memoryService,
    graph: new GraphQueryService(graphReadRepository),
    candidates: candidateReviewRepository,
    candidateReview,
  });

  const agentFastPath = new AgentFastPathService({
    defaultScope: runtimeDefaultScope,
    loadRecallHitsForScope: async (resolvedScope, query) => {
      const result = await memoryService.recall({
        query,
        scope: resolvedScope,
        limit: 50,
        minScore: 0,
        searchAll: appId !== "openclaw",
      });
      return result.hits;
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
    navigate: (resolvedScope, input) => memoryNavigation.navigate(resolvedScope, input),
    readEvidence: async (resolvedScope, refs) => [
      ...await memoryNavigation.readEvidence(resolvedScope, refs),
    ],
    knowledgeResources,
    contextAssemblyReceipts,
    ...(options.config.features?.assetInjection === true &&
      agentLoadoutRepository && memoryViewAssetRepository && memoryViewAssets
      ? {
          resolveLoadout: (resolvedScope: MemoryScope) =>
            agentLoadouts!.resolveForAssembly(resolvedScope),
          resolveLoadoutAssetCandidates: async (
            resolvedScope: MemoryScope,
            loadout,
            governedHits,
          ) => {
            const resolved = new Map<string, Awaited<ReturnType<
              typeof memoryViewAssets.resolveBinding
            >>>();
            for (const binding of loadout.slotBindings) {
              const key = `${binding.assetId}:${binding.pinnedVersion ?? "latest"}`;
              if (resolved.has(key)) continue;
              const asset = await memoryViewAssets.resolveBinding(
                resolvedScope,
                binding.assetId,
                binding.pinnedVersion,
              );
              resolved.set(key, asset);
            }
            const assets = [...resolved.values()]
              .filter((asset): asset is NonNullable<typeof asset> => asset !== undefined);
            const reads = await Promise.all(assets.map((asset) =>
              memoryViewAssets.read(resolvedScope, asset.id)));
            return assets
              .map((asset, index) =>
                resolveMemoryViewLoadoutCandidate(asset, governedHits, reads[index]))
              .filter((candidate): candidate is NonNullable<typeof candidate> =>
                candidate !== undefined);
          },
        }
      : {}),
    storeObservation: async ({ scope, text, metadata, intent, idempotencyKey }) => {
      embeddingWriteGuard.assertWriteAllowed();
      const resolvedScope = normalizeScope(scope, runtimeDefaultScope);
      if (executeRuntimeMemoryWrite) {
        const transportTraceId = typeof metadata.traceId === "string" ? metadata.traceId : randomUUID();
        const sourceId = idempotencyKey === undefined
          ? transportTraceId
          : `agent-observation:${idempotencyKey}`;
        const stableMetadata = { ...metadata };
        delete stableMetadata.traceId;
        for (const key of [
          "tenantId", "userId", "appId", "projectId", "agentId", "namespace",
          "visibility", "workspaceId", "sessionId", "source",
        ]) {
          delete stableMetadata[key];
        }
        const eventType = typeof stableMetadata.eventType === "string"
          ? stableMetadata.eventType
          : "observation";
        const source = "agent-fast-path";
        const result = await executeRuntimeMemoryWrite({
          type: "importEvidence",
          idempotencyKey: idempotencyKey ?? `observation:${transportTraceId}`,
          serverAuthority: {
            tenantId: runtimeDefaultScope.tenantId,
            userId: runtimeDefaultScope.userId,
            ...(runtimeDefaultScope.workspaceId === undefined
              ? {}
              : { workspaceId: runtimeDefaultScope.workspaceId }),
            ...(runtimeDefaultScope.sessionId === undefined
              ? {}
              : { sessionId: runtimeDefaultScope.sessionId }),
          },
          clientScope: resolvedScope,
          text,
          kind: "observation",
          container: "session_candidate",
          confidence: intent === "remember" ? 0.9 : 0.6,
          category: "core",
          dataType: "memory",
          tableName: "memories",
          sourceId,
          evidenceIds: [sourceId],
          metadata: attachEmbeddingSpaceMetadata({
            ...stableMetadata,
            source,
            eventType,
            intent,
            admissionRoute: "evidence_only",
            observationPolicy: "raw_evidence_before_candidate_admission",
            embeddingModel,
            userId: resolvedScope.userId,
            projectPath: resolvedScope.projectId,
            agentName: resolvedScope.agentId,
          }, embeddingSpace),
          provenance: {
            source,
            sourceId,
            sessionId: resolvedScope.sessionId,
          },
        });
        if (result.status !== "persisted" || result.recordType !== "memory" ||
            !("route" in result)) {
          throw new Error(`runtime evidence write was not persisted: ${result.status}`);
        }
        return {
          id: result.memoryId,
          stored: result.stored,
          recordType: result.recordType,
          admissionRoute: result.route,
        };
      }
      const now = Date.now();
      const traceId = typeof metadata.traceId === "string" ? metadata.traceId : undefined;
      const eventType = typeof metadata.eventType === "string" ? metadata.eventType : "observation";
      const stableMetadata = { ...metadata };
      for (const key of [
        "tenantId", "userId", "appId", "projectId", "agentId", "namespace",
        "visibility", "workspaceId", "sessionId", "source",
      ]) {
        delete stableMetadata[key];
      }
      const observationIntent = metadata.intent === "remember" ? "remember" : "auto";
      const observationPolicy = mapFastPathObservationPolicy({
        intent: observationIntent,
        // 原始 observation 是 evidence；异步 candidate handler 才执行统一准入。
        admissionRoute: "evidence_only",
      });
      if (observationPolicy.disposition !== "governed") {
        throw new Error("ignored observation reached the persistence boundary");
      }
      const record: MemoryRecord = {
        id: traceId && isUuid(traceId) ? traceId : randomUUID(),
        scope: resolvedScope,
        kind: "observation",
        container: observationPolicy.container,
        confidence: observationIntent === "remember" ? 0.9 : 0.6,
        text,
        contentHash: computeContentHash(text),
        importance: intent === "remember" ? 0.8 : 0.4,
        category: "core",
        dataType: "memory",
        tableName: "memories",
        metadata: attachEmbeddingSpaceMetadata(
          {
            ...stableMetadata,
            source: "agent-fast-path",
            eventType,
            admissionRoute: observationPolicy.effectiveRoute,
            observationPolicy: observationPolicy.reason,
            updatedAt: now,
            embeddingModel,
            userId: resolvedScope.userId ?? "default",
            projectPath: resolvedScope.projectId ?? "default",
            agentName: resolvedScope.agentId ?? "default",
          },
          embeddingSpace,
        ),
        provenance: {
          source: "agent-fast-path",
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
        admissionRoute: "evidence_only" as const,
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
  const slotInvalidationOutboxLoop = options.config.dbType === "postgres" &&
      db instanceof PostgresProvider
    ? new SlotInvalidationOutboxLoop({
        consumer: new SlotInvalidationOutboxConsumer({
          repository: db.createSlotInvalidationOutboxRepository(),
          invalidateScopeFingerprint: (scopeFingerprint) =>
            agentFastPath.invalidateContextCacheFingerprint(scopeFingerprint),
        }),
        onError: () => options.logger?.warn?.(
          "asset/loadout invalidation outbox drain failed; read-time validation remains authoritative",
        ),
      })
    : undefined;

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
    ...(slotInvalidationOutboxLoop && db instanceof PostgresProvider
      ? [{
          name: "slot-invalidation-outbox",
          start: () => {
            if (db.hasSlotInvalidationOutboxCapability()) slotInvalidationOutboxLoop.start();
          },
          stop: () => slotInvalidationOutboxLoop.stop(),
        }]
      : []),
    ...(activeDerivationOutboxLoop
      ? [{
          name: "active-derivation-outbox",
          start: () => activeDerivationOutboxLoop.start(),
          stop: () => activeDerivationOutboxLoop.stop(),
        }]
      : []),
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
    memoryWriteKernel,
    ...(executeRuntimeMemoryWrite
      ? { executeMemoryWrite: executeRuntimeMemoryWrite }
      : {}),
    authorityScopedForgetCapability,
    durableJobV2ServeCapability,
    durableJobV2RuntimeBundle,
    ingestionStore: persistentRepos,
    ingestionPipeline,
    candidateRepository,
    candidateReview,
    consoleApi,
    llmClient,
    runtimeCostLedger,
    treeRepository,
    graphRepository,
    queryHitsTracker,
    centralityCalculator,
    agentFastPath,
    ...(memoryViewAssets ? { memoryViewAssets } : {}),
    ...(agentLoadouts ? { agentLoadouts } : {}),
    ...(knowledgeResources ? { knowledgeResources } : {}),
    ...(contextAssemblyReceipts ? { contextAssemblyReceipts } : {}),
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
