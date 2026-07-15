import { createHash, randomUUID } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";
import pg from "pg";
import type {
  DatabaseProvider,
  DatabaseStoreRecordResult,
  DatabaseStoreResult,
  MemoryEntry,
  MemoryQueryOptions,
  TableName,
  TableStats,
  KnowledgeBaseConfig,
} from "../types.js";
import { vectorDimsForModel } from "../../../../../config.js";
import { assertSafeLegacyDeleteFilter } from "./legacy-delete-filter-guard.js";
import type { KnownEmbeddingSpace } from "../../domain/embedding-space.js";
import {
  PostgresEmbeddingSpaceRegistryAdapter,
  type EmbeddingSpaceSwitchGate,
  type EmbeddingSpaceRegistryQueryClient,
} from "./postgres-embedding-space-registry.js";
import {
  PostgresForgetTransactionPort,
  type PostgresForgetPoolClient,
} from "./postgres-forget-transaction.js";
import type { ForgetTransactionPort } from "../../domain/service-types.js";
import type { MemoryRecord, MemoryScope } from "../../domain/types.js";
import { recordToMemoryEntry } from "../../domain/legacy-mapping.js";
import {
  PostgresAtomicMemoryStorePort,
  type PostgresMemoryWriteClient,
  type ProviderOwnedAtomicMemoryStorePort,
} from "../../service/write-kernel-transaction.js";
import {
  executePostgresMigrations,
  PostgresSchemaContractError,
  READ_MIGRATIONS_SQL,
} from "../migrations/postgres-ledger.js";
import {
  executePostgresScopeBackfill,
  type ExecutePostgresScopeBackfillResult,
  type ScopeBackfillTable,
} from "../migrations/scope-backfill-executor.js";
import {
  CURRENT_SCHEMA_VERSION,
  planSchemaMigrations,
  type AppliedSchemaMigration,
} from "../migrations/schema-migrations.js";
import type { MemoryAutodbRegistry } from "../../runtime/registry.js";
import {
  PostgresDurableJobV2Repository,
  type PostgresDurableJobV2Dependencies,
  type PostgresDurableJobV2PoolClient,
} from "../../storage/repositories/postgres-job-v2.js";
import {
  DURABLE_JOB_V2_AUTHORITATIVE_TYPES,
  createDurableJobHandlerRegistry,
} from "../../storage/repositories/job-v2.js";
import {
  PostgresDurableJobV2EffectRepository,
  PostgresDurableJobV2EffectError,
  createPostgresProviderOwnedDomainEffectRunner,
  type PostgresProviderOwnedDomainEffectRunner,
  type PostgresDurableJobV2EffectClient,
  type PostgresDurableJobV2EffectInput,
  type PostgresDurableJobV2EffectResult,
} from "../../storage/repositories/postgres-job-v2-effect.js";
import {
  POSTGRES_EXTRACT_GRAPH_EFFECT_KEY,
  POSTGRES_BUILD_TREE_EFFECT_KEY,
  buildTreeSemanticFingerprint,
  extractGraphSemanticFingerprint,
  type PostgresBuildTreeEffectRequest,
  type PostgresBuildTreeEffectSummary,
  type PostgresExtractGraphEffectRequest,
  type PostgresExtractGraphEffectSummary,
} from "./postgres-job-v2-domain-effects.js";
import { PostgresGraphRepository } from "../../graph/postgres-repository.js";
import {
  POSTGRES_BUILD_TREE_EFFECT_RELATIONS,
  executePostgresBuildTreeDomainEffect,
} from "../../tree/postgres-build-tree-effect.js";
import { PostgresCanonicalTreeReadRepository } from
  "../../tree/postgres-canonical-read-repository.js";
import { PostgresCanonicalGraphReadRepository } from
  "../../graph/postgres-canonical-read-repository.js";
import {
  MENGSHU_CANDIDATE_CONFLICT_COLUMNS,
  MENGSHU_CANDIDATE_RELATION,
  PostgresCandidateRepository,
  type PostgresPendingCandidateInput,
} from "../../lifecycle/postgres-candidate-repository.js";
import {
  PostgresBoundCandidateReviewRepository,
  type ScopeBoundCandidateReviewRepository,
} from "../../lifecycle/postgres-candidate-review-repository.js";

const { Pool } = pg;

const DEFAULT_TABLES: TableName[] = ["memories", "knowledge"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_METADATA_FILTER_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const KNOWN_EMBEDDING_SPACE_ID = /^embedding-space:v1:[0-9a-f]{64}$/;
const QUERYABLE_EMBEDDING_SPACE_STATE = "known-queryable" as const;
const EMBEDDING_METADATA_ID = "embeddingSpaceId" as const;
const EMBEDDING_METADATA_STATE = "embeddingSpaceState" as const;
const AUTHORITY_DEDUPE_COLUMNS =
  "tenant_id, user_id, canonical_project_id, product_id, producer_id, namespace, visibility, content_hash";
const NON_QUARANTINED_ROW_SQL = "legacy_quarantine_reason IS NULL";
const LOCK_SCHEMA_BOOTSTRAP_SQL =
  "SELECT pg_advisory_lock(hashtext('mengshu_schema_bootstrap'))";
const UNLOCK_SCHEMA_BOOTSTRAP_SQL =
  "SELECT pg_advisory_unlock(hashtext('mengshu_schema_bootstrap'))";
const PROVIDER_OWNED_EFFECT_REPOSITORIES = new WeakSet<object>();
const CANDIDATE_EFFECT_KEY = "extract_candidate.persist.v1";
const CANDIDATE_SEMANTIC_REQUEST_VERSION = 1;
const SAFE_CANDIDATE_ID = /^[^\s\p{Cc}]{1,256}$/u;
const SAFE_CANDIDATE_OWNER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const SAFE_CANDIDATE_LEASE_TOKEN = /^[A-Za-z0-9._~-]{32,256}$/;
const UNSAFE_CANDIDATE_STRING = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
const UNPAIRED_CANDIDATE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const CANDIDATE_VISIBILITIES = new Set(["private", "workspace", "team", "public"]);
const CANDIDATE_EFFECT_FACTORY_AUTHORITY = Object.freeze({});
const PROVIDER_OWNED_DOMAIN_EFFECT_RELATIONS = new Set([
  MENGSHU_CANDIDATE_RELATION,
  "mengshu_tree_leaves",
  "mengshu_tree_buffers",
  "mengshu_tree_summary_nodes",
  "mengshu_graph_entities",
  "mengshu_graph_relations",
]);

export type PostgresDurableJobV2RuntimeBundleErrorCode =
  | "DURABLE_RUNTIME_BUNDLE_INVALID"
  | "DURABLE_RUNTIME_SCHEMA_CONTRACT_PENDING"
  | "DURABLE_RUNTIME_SCHEMA_V10_REQUIRED"
  | "DURABLE_RUNTIME_SCHEMA_INVALID"
  | "DURABLE_RUNTIME_READINESS_UNAVAILABLE";

export class PostgresDurableJobV2RuntimeBundleError extends Error {
  readonly retryable: boolean;

  constructor(readonly code: PostgresDurableJobV2RuntimeBundleErrorCode) {
    super("Postgres durable runtime capability is unavailable");
    this.name = "PostgresDurableJobV2RuntimeBundleError";
    this.retryable = code === "DURABLE_RUNTIME_READINESS_UNAVAILABLE";
  }
}

export interface PostgresDurableJobV2RuntimeReadiness {
  readonly provider: "postgres";
  readonly minimumSchemaVersion: 10;
  readonly currentSchemaVersion: number;
  readonly candidateEffects: "ready";
  readonly treeEffects: "ready";
  readonly graphEffects: "ready";
}

export interface PostgresDurableJobV2RuntimeBundle {
  readonly contract: "mengshu.postgres-durable-job-v2/v1";
  readonly repository: PostgresDurableJobV2Repository;
  readonly handlerTypes: typeof DURABLE_JOB_V2_AUTHORITATIVE_TYPES;
  readonly executeCandidateEffect: (
    request: PostgresCandidateEffectRequest,
  ) => Promise<PostgresDurableJobV2EffectResult<PostgresCandidateEffectSummary>>;
  readonly executeGraphEffect: (
    request: PostgresExtractGraphEffectRequest,
  ) => Promise<PostgresDurableJobV2EffectResult<PostgresExtractGraphEffectSummary>>;
  readonly executeBuildTreeEffect: (
    request: PostgresBuildTreeEffectRequest,
    signal: AbortSignal,
  ) => Promise<PostgresDurableJobV2EffectResult<PostgresBuildTreeEffectSummary>>;
  /** Runtime enqueue gate：只读 readiness，不拥有/关闭运行中 provider。 */
  readonly assertEnqueueReady: () => Promise<PostgresDurableJobV2RuntimeReadiness>;
  readonly assertReady: () => Promise<PostgresDurableJobV2RuntimeReadiness>;
  readonly close: () => Promise<void>;
}

export interface PostgresDurableJobV2RuntimeBundleDependencies {
  readonly clock: () => number;
  readonly tokenFactory: () => string;
  readonly backoffMs: (attempts: number) => number;
  readonly effectClock?: () => number;
}

const POSTGRES_DURABLE_RUNTIME_BUNDLE_OWNERS = new WeakMap<object, PostgresProvider>();

function bundleError(code: PostgresDurableJobV2RuntimeBundleErrorCode): never {
  throw new PostgresDurableJobV2RuntimeBundleError(code);
}

export function assertProviderOwnedPostgresDurableJobV2RuntimeBundle(
  value: unknown,
): PostgresDurableJobV2RuntimeBundle {
  if (!value || typeof value !== "object" ||
      !POSTGRES_DURABLE_RUNTIME_BUNDLE_OWNERS.has(value)) {
    bundleError("DURABLE_RUNTIME_BUNDLE_INVALID");
  }
  return value as PostgresDurableJobV2RuntimeBundle;
}

export function assertPostgresProviderOwnsDurableJobV2RuntimeBundle(
  provider: unknown,
  value: unknown,
): PostgresDurableJobV2RuntimeBundle {
  const bundle = assertProviderOwnedPostgresDurableJobV2RuntimeBundle(value);
  if (!(provider instanceof PostgresProvider) ||
      POSTGRES_DURABLE_RUNTIME_BUNDLE_OWNERS.get(bundle) !== provider) {
    bundleError("DURABLE_RUNTIME_BUNDLE_INVALID");
  }
  return bundle;
}

export function assertProviderOwnedPostgresEffectRepository(
  value: unknown,
): PostgresDurableJobV2EffectRepository {
  if (!value || typeof value !== "object" || !PROVIDER_OWNED_EFFECT_REPOSITORIES.has(value)) {
    throw new Error("Postgres provider-owned effect repository is required");
  }
  return value as PostgresDurableJobV2EffectRepository;
}

type StoreQuery = (
  sql: string,
  params?: readonly unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>;

interface QueryableEmbeddingStamp {
  readonly embeddingSpaceId: string;
  readonly embeddingSpaceState: typeof QUERYABLE_EMBEDDING_SPACE_STATE;
}

function ownDataValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return undefined;
  if (!("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) {
    throw new Error(`Postgres embedding metadata field is not a data property: ${key}`);
  }
  return descriptor.value;
}

/**
 * PostgreSQL 独立列是 ANN 分区真源，camelCase metadata 是跨 provider
 * 兼容镜像。两者的值只从这个严格解码结果产生，禁止静默覆盖。
 */
function readQueryableEmbeddingStamp(metadata: Record<string, unknown>): QueryableEmbeddingStamp {
  const embeddingSpaceId = ownDataValue(metadata, EMBEDDING_METADATA_ID);
  const embeddingSpaceState = ownDataValue(metadata, EMBEDDING_METADATA_STATE);
  if (typeof embeddingSpaceId !== "string" || !KNOWN_EMBEDDING_SPACE_ID.test(embeddingSpaceId)) {
    throw new Error("Postgres new write requires a valid embeddingSpaceId metadata stamp");
  }
  if (embeddingSpaceState !== QUERYABLE_EMBEDDING_SPACE_STATE) {
    throw new Error("Postgres new write requires embeddingSpaceState=known-queryable");
  }
  const snakeId = ownDataValue(metadata, "embedding_space_id");
  const snakeState = ownDataValue(metadata, "embedding_space_state");
  if (snakeId !== undefined && snakeId !== embeddingSpaceId) {
    throw new Error("Postgres embedding metadata conflict: embedding_space_id");
  }
  if (snakeState !== undefined && snakeState !== embeddingSpaceState) {
    throw new Error("Postgres embedding metadata conflict: embedding_space_state");
  }
  return Object.freeze({ embeddingSpaceId, embeddingSpaceState });
}

function assertSafeMetadataFilterKey(key: string): void {
  if (!SAFE_METADATA_FILTER_KEY.test(key) ||
      key === "__proto__" || key === "prototype" || key === "constructor") {
    throw new Error("Postgres metadata filter key is unsafe");
  }
}

function isLegacyGlobalContentHashViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === "23505" && typeof candidate.constraint === "string" &&
    /_content_hash_(?:key|idx)$/.test(candidate.constraint) &&
    !candidate.constraint.includes("authority_content_hash");
}

export interface PostgresCandidateEffectRequest {
  readonly effectInput: Omit<
    PostgresDurableJobV2EffectInput,
    "effectKey" | "requestFingerprint"
  >;
  readonly context: {
    readonly workspaceId?: string;
    readonly sessionId?: string;
  };
  readonly semanticRequest: {
    readonly type: "extract_candidate";
    readonly version: 1;
    readonly text: string;
    readonly traceId: string;
    readonly intent: string;
  };
  readonly candidates: readonly PostgresPendingCandidateInput[];
}

export interface PostgresCandidateEffectSummary extends Record<string, unknown> {
  readonly created: number;
  readonly duplicateCount: number;
  readonly capacityRejectedCount: number;
  readonly candidateIds: readonly string[];
}

export interface PostgresScopeBackfillInspection {
  readonly table: ScopeBackfillTable;
  readonly total: number;
  readonly canonical: number;
  readonly quarantined: number;
  readonly pending: number;
  readonly plan: ExecutePostgresScopeBackfillResult;
}

const SCOPE_BACKFILL_TABLES = new Set<ScopeBackfillTable>(["memories", "knowledge"]);

function validatedScopeBackfillTable(value: unknown): ScopeBackfillTable {
  if (!SCOPE_BACKFILL_TABLES.has(value as ScopeBackfillTable)) {
    throw new PostgresSchemaContractError(
      "SCHEMA_CONTRACT_INVALID",
      "Postgres scope backfill table is invalid",
    );
  }
  return value as ScopeBackfillTable;
}

function parseScopeBackfillCount(value: unknown): number {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new PostgresSchemaContractError(
      "SCHEMA_CONTRACT_INVALID",
      "Postgres scope backfill count is invalid",
    );
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count)) {
    throw new PostgresSchemaContractError(
      "SCHEMA_CONTRACT_INVALID",
      "Postgres scope backfill count is invalid",
    );
  }
  return count;
}

function exactDataRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
  label = "Postgres candidate effect input is invalid",
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    throw new Error(label);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(label);
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (keys.length < required.length || keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
      required.some((key) => !keys.includes(key))) throw new Error(label);
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error(label);
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

type GenericEffectRepositoryDependencies = Omit<
  ConstructorParameters<typeof PostgresDurableJobV2EffectRepository>[1],
  "insertOnConflictPolicies"
>;

function snapshotAllowedEffectRelations(value: unknown): readonly string[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error("Postgres durable job effect dependencies are invalid");
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 1) {
    throw new Error("Postgres durable job effect dependencies are invalid");
  }
  const length = Number(lengthDescriptor.value);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || !keys.includes("length") ||
      keys.some((key) => typeof key !== "string" ||
        (key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)))) {
    throw new Error("Postgres durable job effect dependencies are invalid");
  }
  const relations: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor) ||
        typeof descriptor.value !== "string") {
      throw new Error("Postgres durable job effect dependencies are invalid");
    }
    relations.push(descriptor.value);
  }
  return Object.freeze(relations);
}

function snapshotGenericEffectRepositoryDependencies(
  value: unknown,
): GenericEffectRepositoryDependencies {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      nodeUtilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("Postgres durable job effect dependencies are invalid");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length < 1 || keys.length > 2 ||
      keys.some((key) => typeof key !== "string" ||
        (key !== "allowedRelations" && key !== "clock")) ||
      !keys.includes("allowedRelations")) {
    throw new Error("Postgres durable job effect dependencies are invalid");
  }
  const descriptors = new Map<string, PropertyDescriptor>();
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error("Postgres durable job effect dependencies are invalid");
    }
    descriptors.set(key, descriptor);
  }
  const clock = descriptors.get("clock")?.value;
  if (clock !== undefined && typeof clock !== "function") {
    throw new Error("Postgres durable job effect dependencies are invalid");
  }
  return Object.freeze({
    allowedRelations: snapshotAllowedEffectRelations(
      descriptors.get("allowedRelations")?.value,
    ),
    ...(clock === undefined ? {} : { clock }),
  });
}

function snapshotDurableRuntimeBundleDependencies(
  value: unknown,
): Readonly<PostgresDurableJobV2RuntimeBundleDependencies> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      nodeUtilTypes.isProxy(value)) {
    bundleError("DURABLE_RUNTIME_BUNDLE_INVALID");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    bundleError("DURABLE_RUNTIME_BUNDLE_INVALID");
  }
  const required = ["clock", "tokenFactory", "backoffMs"] as const;
  const allowed = new Set<string>([...required, "effectClock"]);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
      required.some((key) => !keys.includes(key))) {
    bundleError("DURABLE_RUNTIME_BUNDLE_INVALID");
  }
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      bundleError("DURABLE_RUNTIME_BUNDLE_INVALID");
    }
    snapshot[key] = descriptor.value;
  }
  if (typeof snapshot.clock !== "function" || typeof snapshot.tokenFactory !== "function" ||
      typeof snapshot.backoffMs !== "function" ||
      (Object.hasOwn(snapshot, "effectClock") && typeof snapshot.effectClock !== "function")) {
    bundleError("DURABLE_RUNTIME_BUNDLE_INVALID");
  }
  return Object.freeze({
    clock: snapshot.clock as () => number,
    tokenFactory: snapshot.tokenFactory as () => string,
    backoffMs: snapshot.backoffMs as (attempts: number) => number,
    ...(snapshot.effectClock === undefined
      ? {}
      : { effectClock: snapshot.effectClock as () => number }),
  });
}

function snapshotCandidateEffectRequest(value: unknown): PostgresCandidateEffectRequest {
  const request = exactDataRecord(value, ["effectInput", "context", "semanticRequest", "candidates"]);
  const effect = exactDataRecord(request.effectInput, [
    "id", "scope", "owner", "leaseToken", "leaseGeneration",
  ]);
  const effectScope = exactDataRecord(effect.scope, [
    "tenantId", "userId", "appId", "projectId", "agentId", "namespace", "visibility",
  ]);
  const context = exactDataRecord(request.context, [], ["workspaceId", "sessionId"]);
  const semantic = exactDataRecord(request.semanticRequest, [
    "type", "version", "text", "traceId", "intent",
  ]);
  const safeId = (candidate: unknown): candidate is string =>
    typeof candidate === "string" && SAFE_CANDIDATE_ID.test(candidate) &&
    !UNPAIRED_CANDIDATE_SURROGATE.test(candidate);
  const safeText = (candidate: unknown): candidate is string =>
    typeof candidate === "string" && !UNSAFE_CANDIDATE_STRING.test(candidate) &&
    !UNPAIRED_CANDIDATE_SURROGATE.test(candidate);
  for (const key of ["tenantId", "userId", "appId", "projectId", "agentId", "namespace"] as const) {
    if (!safeId(effectScope[key])) throw new Error("Postgres candidate effect input is invalid");
  }
  if (typeof effectScope.visibility !== "string" ||
      !CANDIDATE_VISIBILITIES.has(effectScope.visibility) ||
      !safeId(effect.id) || typeof effect.owner !== "string" ||
      !SAFE_CANDIDATE_OWNER.test(effect.owner) || typeof effect.leaseToken !== "string" ||
      !SAFE_CANDIDATE_LEASE_TOKEN.test(effect.leaseToken) ||
      !Number.isSafeInteger(effect.leaseGeneration) || Number(effect.leaseGeneration) < 1 ||
      (Object.hasOwn(context, "workspaceId") && !safeId(context.workspaceId)) ||
      (Object.hasOwn(context, "sessionId") && !safeId(context.sessionId)) ||
      semantic.type !== "extract_candidate" ||
      semantic.version !== CANDIDATE_SEMANTIC_REQUEST_VERSION ||
      !safeText(semantic.text) || semantic.text.trim().length === 0 || semantic.text.length > 100_000 ||
      !safeId(semantic.traceId) || !safeId(semantic.intent)) {
    throw new Error("Postgres candidate effect input is invalid");
  }
  return Object.freeze({
    effectInput: Object.freeze({
      id: effect.id,
      scope: Object.freeze({ ...effectScope }) as unknown as PostgresDurableJobV2EffectInput["scope"],
      owner: effect.owner,
      leaseToken: effect.leaseToken,
      leaseGeneration: effect.leaseGeneration,
    }),
    context: Object.freeze({
      ...(context.workspaceId === undefined ? {} : { workspaceId: context.workspaceId }),
      ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
    }),
    semanticRequest: Object.freeze({
      type: "extract_candidate" as const,
      version: CANDIDATE_SEMANTIC_REQUEST_VERSION,
      text: semantic.text,
      traceId: semantic.traceId,
      intent: semantic.intent,
    }),
    candidates: request.candidates as readonly PostgresPendingCandidateInput[],
  }) as PostgresCandidateEffectRequest;
}

function candidateEffectInput(
  request: PostgresCandidateEffectRequest,
): PostgresDurableJobV2EffectInput {
  const scope = request.effectInput.scope;
  const semantic = request.semanticRequest;
  const fingerprint = createHash("sha256").update(JSON.stringify([
    "mengshu.candidate-effect.semantic-request.v1",
    request.effectInput.id,
    semantic.type,
    semantic.version,
    scope.tenantId,
    scope.userId,
    scope.appId,
    scope.projectId,
    scope.agentId,
    scope.namespace,
    scope.visibility,
    request.context.workspaceId ?? "",
    request.context.sessionId ?? "",
    semantic.text,
    semantic.traceId,
    semantic.intent,
  ])).digest("hex");
  return Object.freeze({
    ...request.effectInput,
    effectKey: CANDIDATE_EFFECT_KEY,
    requestFingerprint: fingerprint,
  });
}

function assertCandidateEffectSummary(
  value: unknown,
  candidates?: readonly Readonly<PostgresPendingCandidateInput>[],
): void {
  const summary = exactDataRecord(
    value,
    ["created", "duplicateCount", "capacityRejectedCount", "candidateIds"],
    [],
    "Postgres candidate effect receipt is invalid");
  if (!Number.isSafeInteger(summary.created) || Number(summary.created) < 0 ||
      !Number.isSafeInteger(summary.duplicateCount) || Number(summary.duplicateCount) < 0 ||
      !Number.isSafeInteger(summary.capacityRejectedCount) ||
      Number(summary.capacityRejectedCount) < 0 ||
      !Number.isSafeInteger(Number(summary.created) + Number(summary.duplicateCount) +
        Number(summary.capacityRejectedCount)) ||
      (candidates !== undefined &&
        Number(summary.created) + Number(summary.duplicateCount) +
          Number(summary.capacityRejectedCount) !== candidates.length) ||
      !Array.isArray(summary.candidateIds) || nodeUtilTypes.isProxy(summary.candidateIds)) {
    throw new Error("Postgres candidate effect receipt is invalid");
  }
  const ids = summary.candidateIds;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(ids, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor) ||
      lengthDescriptor.value !== summary.created || Reflect.ownKeys(ids).length !== ids.length + 1) {
    throw new Error("Postgres candidate effect receipt is invalid");
  }
  let inputCursor = 0;
  const seen = new Set<string>();
  for (let index = 0; index < ids.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(ids, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor) || typeof descriptor.value !== "string" ||
        seen.has(descriptor.value)) throw new Error("Postgres candidate effect receipt is invalid");
    seen.add(descriptor.value);
    if (!SAFE_CANDIDATE_ID.test(descriptor.value) ||
        UNPAIRED_CANDIDATE_SURROGATE.test(descriptor.value)) {
      throw new Error("Postgres candidate effect receipt is invalid");
    }
    if (candidates !== undefined) {
      while (inputCursor < candidates.length && candidates[inputCursor]?.id !== descriptor.value) {
        inputCursor += 1;
      }
      if (inputCursor >= candidates.length) throw new Error("Postgres candidate effect receipt is invalid");
      inputCursor += 1;
    }
  }
}

/**
 * PostgreSQL + pgvector 数据库提供者实现
 * 使用原生 pg 库（Pool）进行连接管理
 *
 * D-25 scope 维度独立列（projectName/appName/userId/agentId/workspaceId）：
 * - 写入：legacy scope 与 canonical authority scope 双写；canonical 缺失时 fail-closed
 * - 查询：tenant/user authority 使用参数化独立列铁隔离；projectName/appName
 *   精确过滤、projectPattern LIKE 模糊匹配保持现有策略
 * - Schema：ensureTable 自动 CREATE TABLE 时加列；存量表通过文档手动 ALTER TABLE
 */
export class PostgresProvider implements DatabaseProvider {
  private pool: pg.Pool | null = null;
  private initializationPromise: Promise<void> | null = null;
  #closingPromise: Promise<void> | null = null;
  #durableRuntimeReadinessPromise: Promise<PostgresDurableJobV2RuntimeReadiness> | null = null;
  private readonly vectorDim: number;
  private extendedTables: TableName[] = [];
  private schemaContractState: "unknown" | "pending" | "applying" | "ready" = "unknown";
  private schemaVersion = 0;

  constructor(
    private readonly pgConfig: {
      host: string;
      port: number;
      database: string;
      user: string;
      password: string;
      ssl?: boolean | object;
    },
    private readonly embeddingModel: string,
    private readonly knowledgeBases?: KnowledgeBaseConfig,
  ) {
    this.vectorDim = vectorDimsForModel(embeddingModel);
    if (knowledgeBases?.enabled && knowledgeBases.builtinCategories) {
      const extended = knowledgeBases.builtinCategories.map((cat: string) => `knowledge_${cat}`);
      if (knowledgeBases.customCategories) {
        extended.push(...knowledgeBases.customCategories.map((cat: string) => `knowledge_${cat}`));
      }
      this.extendedTables = extended as TableName[];
    }
  }

  async initialize(): Promise<void> {
    if (this.initializationPromise) {
      return this.initializationPromise;
    }
    if (this.pool) {
      return;
    }

    const initialization = this.initializePool();
    this.initializationPromise = initialization;
    try {
      await initialization;
    } finally {
      if (this.initializationPromise === initialization) {
        this.initializationPromise = null;
      }
    }
  }

  private async initializePool(): Promise<void> {
    if (this.pool) return;

    this.pool = new Pool({
      host: this.pgConfig.host,
      port: this.pgConfig.port,
      database: this.pgConfig.database,
      user: this.pgConfig.user,
      password: this.pgConfig.password,
      ssl: this.pgConfig.ssl || undefined,
    });
    const initializingPool = this.pool;

    try {
      const migrationClient = await this.pool.connect();
      let bootstrapLocked = false;
      let bootstrapError: unknown;
      try {
        // session advisory lock 覆盖 fresh bootstrap 与后续 transaction migrations，
        // 解决多个本地 runtime 进程同时首次启动时 IF NOT EXISTS 的竞态窗口。
        await migrationClient.query(LOCK_SCHEMA_BOOTSTRAP_SQL);
        bootstrapLocked = true;
        await migrationClient.query("CREATE EXTENSION IF NOT EXISTS vector");
        for (const tableName of DEFAULT_TABLES) {
          await this.createTableIfNotExists(tableName, migrationClient);
        }
        if (this.knowledgeBases?.enabled && this.knowledgeBases.autoCreateTables) {
          for (const tableName of this.extendedTables) {
            await this.createTableIfNotExists(tableName, migrationClient);
          }
        }

        // Schema ledger/migrations 使用同一 dedicated client；内部 transaction advisory
        // lock 负责 ledger 顺序，外层 session lock 负责 bootstrap 生命周期。
        const migrationResult = await executePostgresMigrations({
          query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
            sql: string,
            params: readonly unknown[] = [],
          ) => {
            const result = await migrationClient.query(sql, [...params]);
            return {
              rows: result.rows as Row[],
              rowCount: result.rowCount,
            };
          },
        });
        this.schemaVersion = migrationResult.toVersion;
        this.schemaContractState = migrationResult.pendingContractVersions.length > 0
          ? "pending"
          : "ready";
      } catch (error) {
        bootstrapError = error;
        throw error;
      } finally {
        let unlockError: unknown;
        if (bootstrapLocked) {
          try {
            await migrationClient.query(UNLOCK_SCHEMA_BOOTSTRAP_SQL);
          } catch (error) {
            unlockError = error;
          }
        }
        migrationClient.release();
        if (unlockError) {
          if (bootstrapError) {
            throw new AggregateError(
              [bootstrapError, unlockError],
              "Postgres schema bootstrap and advisory unlock both failed",
            );
          }
          throw unlockError;
        }
      }
    } catch (error) {
      this.pool = null;
      this.schemaContractState = "unknown";
      this.schemaVersion = 0;
      try {
        await initializingPool.end();
      } catch (closeError) {
        throw new AggregateError([error, closeError], "Postgres initialization and close both failed");
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.#closeProviderPool();
  }

  async #closeProviderPool(): Promise<void> {
    if (this.#closingPromise) {
      await this.#closingPromise;
      return;
    }
    const pool = this.pool;
    // Detach all provider readiness before the first await. A failed pool.end()
    // must never leave a stale ready capability reachable or cause a later close
    // to retry the same uncertain Pool.
    this.pool = null;
    this.schemaContractState = "unknown";
    this.schemaVersion = 0;
    if (!pool) return;

    const closing = Promise.resolve()
      .then(() => pool.end())
      .catch(() => {
        throw new PostgresDurableJobV2RuntimeBundleError(
          "DURABLE_RUNTIME_READINESS_UNAVAILABLE",
        );
      });
    this.#closingPromise = closing;
    try {
      await closing;
    } finally {
      if (this.#closingPromise === closing) this.#closingPromise = null;
    }
  }

  async getSchemaContractStatus(): Promise<{
    currentVersion: number;
    targetVersion: number;
    scopeContentHashDedupe: "pending" | "ready";
  }> {
    if (this.pool) {
      return {
        currentVersion: this.schemaVersion,
        targetVersion: CURRENT_SCHEMA_VERSION,
        scopeContentHashDedupe: this.schemaContractState === "ready" ? "ready" : "pending",
      };
    }

    // CLI dry-run must not bootstrap schema. Use a short-lived read-only connection
    // and validate the ledger as an exact local migration-registry prefix.
    const inspectionPool = new Pool({
      host: this.pgConfig.host,
      port: this.pgConfig.port,
      database: this.pgConfig.database,
      user: this.pgConfig.user,
      password: this.pgConfig.password,
      ssl: this.pgConfig.ssl || undefined,
    });
    try {
      const relation = await inspectionPool.query(
        "SELECT to_regclass('public.mengshu_schema_migrations')::text AS ledger_relation",
      );
      if (relation.rowCount !== 1 || !Array.isArray(relation.rows) ||
          relation.rows.length !== 1) {
        throw new PostgresSchemaContractError(
          "SCHEMA_CONTRACT_INVALID",
          "Postgres schema ledger inspection is invalid",
        );
      }
      if ((relation.rows[0] as Record<string, unknown>).ledger_relation === null) {
        return {
          currentVersion: 0,
          targetVersion: CURRENT_SCHEMA_VERSION,
          scopeContentHashDedupe: "pending",
        };
      }
      if (typeof (relation.rows[0] as Record<string, unknown>).ledger_relation !== "string") {
        throw new PostgresSchemaContractError(
          "SCHEMA_CONTRACT_INVALID",
          "Postgres schema ledger inspection is invalid",
        );
      }
      const ledgerResult = await inspectionPool.query(READ_MIGRATIONS_SQL);
      if (!Array.isArray(ledgerResult.rows)) {
        throw new PostgresSchemaContractError(
          "SCHEMA_CONTRACT_INVALID",
          "Postgres schema ledger inspection is invalid",
        );
      }
      const applied: AppliedSchemaMigration[] = ledgerResult.rows.map((row) => {
        const value = row as Record<string, unknown>;
        if (!Number.isInteger(value.version) || typeof value.name !== "string" ||
            typeof value.checksum !== "string") {
          throw new PostgresSchemaContractError(
            "SCHEMA_CONTRACT_INVALID",
            "Postgres schema ledger inspection is invalid",
          );
        }
        return {
          version: value.version as number,
          name: value.name,
          checksum: value.checksum,
        };
      });
      const plan = planSchemaMigrations(applied);
      return {
        currentVersion: plan.fromVersion,
        targetVersion: plan.currentSchemaVersion,
        scopeContentHashDedupe: plan.pending.some((migration) => migration.kind === "contract")
          ? "pending"
          : "ready",
      };
    } finally {
      await inspectionPool.end();
    }
  }

  /**
   * Fixed, read-only scope cutover inspection. The CLI never receives Pool/raw SQL.
   * A repeatable-read snapshot keeps aggregate counts and the paged dry-run plan aligned.
   */
  async inspectScopeBackfill(options: {
    readonly table: ScopeBackfillTable;
    readonly registry: MemoryAutodbRegistry;
    readonly batchSize?: number;
  }): Promise<PostgresScopeBackfillInspection> {
    const table = validatedScopeBackfillTable((options as { table?: unknown })?.table);
    if (!options.registry || typeof options.registry !== "object") {
      throw new PostgresSchemaContractError(
        "SCHEMA_CONTRACT_INVALID",
        "Postgres scope backfill registry is invalid",
      );
    }
    const ownsInspectionPool = this.pool === null;
    const inspectionPool = this.pool ?? new Pool({
      host: this.pgConfig.host,
      port: this.pgConfig.port,
      database: this.pgConfig.database,
      user: this.pgConfig.user,
      password: this.pgConfig.password,
      ssl: this.pgConfig.ssl || undefined,
    });
    const client = await inspectionPool.connect();
    let transactionStarted = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      transactionStarted = true;
      const counts = await client.query(`SELECT
  COUNT(*)::text AS total_count,
  COUNT(*) FILTER (WHERE scope_key IS NOT NULL AND legacy_quarantine_reason IS NULL)::text AS canonical_count,
  COUNT(*) FILTER (WHERE scope_key IS NULL AND legacy_quarantine_reason IS NOT NULL)::text AS quarantined_count,
  COUNT(*) FILTER (WHERE scope_key IS NULL AND legacy_quarantine_reason IS NULL)::text AS pending_count,
  COUNT(*) FILTER (WHERE scope_key IS NOT NULL AND legacy_quarantine_reason IS NOT NULL)::text AS invalid_count
FROM "${table}"`);
      if (counts.rowCount !== 1 || !Array.isArray(counts.rows) || counts.rows.length !== 1) {
        throw new PostgresSchemaContractError(
          "SCHEMA_CONTRACT_INVALID",
          "Postgres scope backfill count result is invalid",
        );
      }
      const row = counts.rows[0] as Record<string, unknown>;
      const total = parseScopeBackfillCount(row.total_count);
      const canonical = parseScopeBackfillCount(row.canonical_count);
      const quarantined = parseScopeBackfillCount(row.quarantined_count);
      const pending = parseScopeBackfillCount(row.pending_count);
      const invalid = parseScopeBackfillCount(row.invalid_count);
      if (invalid !== 0 || total !== canonical + quarantined + pending) {
        throw new PostgresSchemaContractError(
          "SCHEMA_CONTRACT_INVALID",
          "Postgres scope backfill row classification is invalid",
        );
      }
      const plan = await executePostgresScopeBackfill(client, {
        table,
        registry: options.registry,
        mode: "dry-run",
        batchSize: options.batchSize,
      });
      if (plan.scanned !== pending) {
        throw new PostgresSchemaContractError(
          "SCHEMA_CONTRACT_INVALID",
          "Postgres scope backfill plan does not match pending rows",
        );
      }
      await client.query("COMMIT");
      transactionStarted = false;
      return Object.freeze({ table, total, canonical, quarantined, pending, plan });
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "Postgres scope inspection and rollback both failed",
          );
        }
      }
      throw error;
    } finally {
      client.release();
      if (ownsInspectionPool) await inspectionPool.end();
    }
  }

  /**
   * Fixed scope backfill apply facade. It independently re-inspects and rejects any
   * quarantine/conflict plan before the executor is allowed to write.
   */
  async applyScopeBackfill(options: {
    readonly table: ScopeBackfillTable;
    readonly registry: MemoryAutodbRegistry;
    readonly maintenance: true;
    readonly quiescenceConfirmed: true;
    readonly allowedQuarantine: number;
    readonly batchSize?: number;
  }): Promise<ExecutePostgresScopeBackfillResult> {
    if ((options as { maintenance?: unknown })?.maintenance !== true ||
        (options as { quiescenceConfirmed?: unknown })?.quiescenceConfirmed !== true) {
      throw new PostgresSchemaContractError(
        "SCHEMA_MAINTENANCE_REQUIRED",
        "Postgres scope backfill requires maintenance mode and writer quiescence",
      );
    }
    const table = validatedScopeBackfillTable((options as { table?: unknown })?.table);
    const allowedQuarantine = (options as { allowedQuarantine?: unknown }).allowedQuarantine;
    if (typeof allowedQuarantine !== "number" ||
        !Number.isSafeInteger(allowedQuarantine) || allowedQuarantine < 0) {
      throw new PostgresSchemaContractError(
        "SCHEMA_CONTRACT_INVALID",
        "Postgres scope backfill quarantine allowance is invalid",
      );
    }
    const inspection = await this.inspectScopeBackfill({
      table,
      registry: options.registry,
      batchSize: options.batchSize,
    });
    const quarantined = inspection.quarantined + inspection.plan.quarantined;
    if (!Number.isSafeInteger(quarantined) || quarantined !== allowedQuarantine ||
        inspection.plan.conflict > 0 || inspection.plan.skipped > 0) {
      throw new PostgresSchemaContractError(
        "SCHEMA_CONTRACT_PENDING",
        "Postgres scope backfill has unresolved canonical scope records",
      );
    }

    await this.initialize();
    const client = await this.pool!.connect();
    try {
      return await executePostgresScopeBackfill(client, {
        table,
        registry: options.registry,
        mode: "apply",
        maintenance: true,
        quiescenceConfirmed: true,
        batchSize: options.batchSize,
      });
    } finally {
      client.release();
    }
  }

  /**
   * 显式 destructive/contract maintenance 入口。
   *
   * quiescenceConfirmed 是 operator 对“所有旧 embedded binary 与其它 writer 已停”的
   * 明确证明；普通 initialize 永远不会调用此路径。旧 binary 不理解 schema epoch，
   * 因此无法仅靠 PostgreSQL advisory lock 实现兼容混跑。
   */
  async applyScopeContentHashDedupeContract(options: {
    maintenance: true;
    quiescenceConfirmed: true;
  }): Promise<{
    currentVersion: number;
    targetVersion: number;
    scopeContentHashDedupe: "ready";
  }> {
    if ((options as { maintenance?: unknown })?.maintenance !== true ||
        (options as { quiescenceConfirmed?: unknown })?.quiescenceConfirmed !== true) {
      throw new PostgresSchemaContractError(
        "SCHEMA_MAINTENANCE_REQUIRED",
        "Postgres scope dedupe contract requires maintenance mode and writer quiescence",
      );
    }
    await this.initialize();
    if (this.schemaContractState === "ready") {
      return {
        currentVersion: this.schemaVersion,
        targetVersion: CURRENT_SCHEMA_VERSION,
        scopeContentHashDedupe: "ready",
      };
    }
    if (this.schemaContractState === "applying") {
      throw new PostgresSchemaContractError(
        "SCHEMA_MAINTENANCE_REQUIRED",
        "Postgres scope dedupe contract maintenance is already running",
      );
    }

    this.schemaContractState = "applying";
    let client: pg.PoolClient | undefined;
    try {
      const connectedClient = await this.pool!.connect();
      client = connectedClient;
      const result = await executePostgresMigrations({
        query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
          sql: string,
          params: readonly unknown[] = [],
        ) => {
          const queryResult = await connectedClient.query(sql, [...params]);
          return { rows: queryResult.rows as Row[], rowCount: queryResult.rowCount };
        },
      }, {
        contractMigration: { mode: "apply", maintenance: true, quiescenceConfirmed: true },
      });
      this.schemaVersion = result.toVersion;
      this.schemaContractState = "ready";
      return {
        currentVersion: result.toVersion,
        targetVersion: CURRENT_SCHEMA_VERSION,
        scopeContentHashDedupe: "ready",
      };
    } catch (error) {
      this.schemaContractState = "pending";
      throw error;
    } finally {
      client?.release();
    }
  }

  private registryQueryClient(
    execute: (
      sql: string,
      params: readonly unknown[],
    ) => Promise<{ rows: unknown[]; rowCount?: number | null }>,
  ): EmbeddingSpaceRegistryQueryClient {
    return {
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        params: readonly unknown[] = [],
      ) => {
        const result = await execute(sql, params);
        return {
          rows: result.rows as Row[],
          rowCount: result.rowCount ?? null,
        };
      },
    };
  }

  async getActiveEmbeddingSpace(): Promise<KnownEmbeddingSpace | null> {
    await this.initialize();
    return new PostgresEmbeddingSpaceRegistryAdapter(
      this.registryQueryClient((sql, params) => this.pool!.query(sql, [...params])),
    ).readActive();
  }

  async registerActiveEmbeddingSpace(
    space: KnownEmbeddingSpace,
  ): Promise<KnownEmbeddingSpace> {
    await this.initialize();
    const client = await this.pool!.connect();
    try {
      return await new PostgresEmbeddingSpaceRegistryAdapter(
        this.registryQueryClient((sql, params) => client.query(sql, [...params])),
      ).registerActive(space);
    } finally {
      client.release();
    }
  }

  /** v12 显式运维切换；普通 registerActive 仍保持 first-registration-wins。 */
  async switchActiveEmbeddingSpace(
    expectedCurrentSpaceId: string,
    targetSpace: KnownEmbeddingSpace,
    gate: EmbeddingSpaceSwitchGate,
  ): Promise<KnownEmbeddingSpace> {
    if (gate?.maintenance !== true || gate.quiescenceConfirmed !== true) {
      throw new Error("embedding space switch requires maintenance and quiescence confirmation");
    }
    await this.initialize();
    this.assertSchemaVersion(12, "embedding space switch");
    const client = await this.pool!.connect();
    try {
      return await new PostgresEmbeddingSpaceRegistryAdapter(
        this.registryQueryClient((sql, params) => client.query(sql, [...params])),
      ).switchActive(expectedCurrentSpaceId, targetSpace, gate);
    } finally {
      client.release();
    }
  }

  /** 为核心 forget service 提供基于本 provider pool 的 dedicated-client transaction。 */
  createForgetTransactionPort(): ForgetTransactionPort {
    return new PostgresForgetTransactionPort({
      connect: async (): Promise<PostgresForgetPoolClient> => {
        await this.initialize();
        const client = await this.pool!.connect();
        return {
          query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
            sql: string,
            params: readonly unknown[] = [],
          ) => {
            const result = await client.query(sql, [...params]);
            return {
              rows: result.rows as Row[],
              rowCount: result.rowCount,
            };
          },
          release: () => client.release(),
        };
      },
    });
  }

  /**
   * v11 core write path. The record insert callback is deliberately closed
   * over this provider's private insertEntries implementation, so journal
   * writes and the record mutation cannot escape to a second connection.
   */
  createAtomicMemoryStorePort(): ProviderOwnedAtomicMemoryStorePort {
    return new PostgresAtomicMemoryStorePort({
      connect: async (): Promise<PostgresMemoryWriteClient> => {
        await this.initialize();
        this.assertSchemaVersion(11, "atomic memory write");
        const client = await this.pool!.connect();
        return {
          query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
            sql: string,
            params: readonly unknown[] = [],
          ) => {
            const result = await client.query(sql, [...params]);
            return {
              rows: result.rows as Row[],
              rowCount: result.rowCount,
            };
          },
          release: () => client.release(),
        };
      },
    }, async (client, record: MemoryRecord) => {
      const entry = recordToMemoryEntry(record);
      const tableName = entry.tableName ?? this.getDefaultTableName(entry.dataType);
      if (!DEFAULT_TABLES.includes(tableName)) {
        throw new Error(
          "Postgres atomic memory write only supports canonical memories/knowledge tables",
        );
      }
      this.validateStoreEntry(entry);
      const records = await this.insertEntries(tableName, [entry], async (sql, params = []) => {
        const result = await client.query(sql, params);
        return { rows: result.rows, rowCount: result.rowCount };
      });
      const [result] = records;
      if (!result || records.length !== 1) {
        throw new Error("Postgres atomic memory write returned an invalid record result");
      }
      return result;
    });
  }

  createCanonicalTreeReadRepository(scope: MemoryScope): PostgresCanonicalTreeReadRepository {
    return new PostgresCanonicalTreeReadRepository({
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        params: readonly unknown[] = [],
      ) => {
        await this.initialize();
        this.assertSchemaVersion(9, "canonical tree read");
        const result = await this.pool!.query(sql, [...params]);
        return { rows: result.rows as Row[], rowCount: result.rowCount };
      },
    }, scope);
  }

  createCanonicalGraphReadRepository(scope: MemoryScope): PostgresCanonicalGraphReadRepository {
    return new PostgresCanonicalGraphReadRepository({
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        params: readonly unknown[] = [],
      ) => {
        await this.initialize();
        this.assertSchemaVersion(9, "canonical graph read");
        const result = await this.pool!.query(sql, [...params]);
        return { rows: result.rows as Row[], rowCount: result.rowCount };
      },
    }, scope);
  }

  /**
   * v8+ scope-bound candidate review view used by the production Console.
   * The adapter only receives a fixed provider-owned query closure: callers
   * cannot supply a pool/client or escape the authority scope bound here.
   */
  createCandidateReviewRepository(scope: MemoryScope): ScopeBoundCandidateReviewRepository {
    return new PostgresBoundCandidateReviewRepository({
      client: {
        query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
          sql: string,
          params: readonly unknown[] = [],
        ) => {
          await this.initialize();
          this.assertSchemaVersion(8, "candidate review");
          const result = await this.pool!.query(sql, [...params]);
          return { rows: result.rows as Row[], rowCount: result.rowCount };
        },
      },
      scope,
    });
  }

  /**
   * Production durable-v2 原子 bundle。repository、candidate effect 与 readiness
   * 都由同一个 provider 闭包 mint；调用方不能传入 Pool/repository/per-call clock。
   */
  createDurableJobV2RuntimeBundle(
    rawDependencies: PostgresDurableJobV2RuntimeBundleDependencies,
  ): PostgresDurableJobV2RuntimeBundle {
    const dependencies = snapshotDurableRuntimeBundleDependencies(rawDependencies);
    const repository = this.#createDurableJobV2Repository({
      registry: createDurableJobHandlerRegistry(DURABLE_JOB_V2_AUTHORITATIVE_TYPES),
      clock: dependencies.clock,
      tokenFactory: dependencies.tokenFactory,
      backoffMs: dependencies.backoffMs,
    });
    const effectDependencies = Object.freeze({
      clock: dependencies.effectClock ?? dependencies.clock,
    });
    const bundle = Object.freeze({
      contract: "mengshu.postgres-durable-job-v2/v1" as const,
      repository,
      handlerTypes: DURABLE_JOB_V2_AUTHORITATIVE_TYPES,
      executeCandidateEffect: (request: PostgresCandidateEffectRequest) =>
        this.#executeCandidateEffect(request, effectDependencies),
      executeGraphEffect: (request: PostgresExtractGraphEffectRequest) =>
        this.#executeGraphEffect(request, effectDependencies),
      executeBuildTreeEffect: (request: PostgresBuildTreeEffectRequest, signal: AbortSignal) =>
        this.#executeBuildTreeEffect(request, signal, effectDependencies),
      assertEnqueueReady: () => this.#assertDurableJobV2EnqueueReady(),
      assertReady: () => this.#assertDurableJobV2RuntimeReady(),
      close: () => this.#closeProviderPool(),
    }) satisfies PostgresDurableJobV2RuntimeBundle;
    POSTGRES_DURABLE_RUNTIME_BUNDLE_OWNERS.set(bundle, this);
    return bundle;
  }

  /**
   * Low-level maintenance/test factory。Production serve 必须消费上方 atomic bundle，
   * 不得把本 repository 与其它 provider 的 effect/readiness 手工拼装。
   */
  createDurableJobV2Repository(
    dependencies: PostgresDurableJobV2Dependencies,
  ): PostgresDurableJobV2Repository {
    return this.#createDurableJobV2Repository(dependencies);
  }

  #createDurableJobV2Repository(
    dependencies: PostgresDurableJobV2Dependencies,
  ): PostgresDurableJobV2Repository {
    return new PostgresDurableJobV2Repository({
      connect: async (): Promise<PostgresDurableJobV2PoolClient> => {
        await this.initialize();
        const client = await this.pool!.connect();
        return {
          query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
            sql: string,
            params: readonly unknown[] = [],
          ) => {
            const result = await client.query(sql, [...params]);
            return {
              rows: result.rows as Row[],
              rowCount: result.rowCount,
            };
          },
          release: () => client.release(),
        };
      },
    }, dependencies);
  }

  async #assertDurableJobV2RuntimeReady(): Promise<PostgresDurableJobV2RuntimeReadiness> {
    if (this.#durableRuntimeReadinessPromise) {
      return this.#durableRuntimeReadinessPromise;
    }
    const readiness = (async (): Promise<PostgresDurableJobV2RuntimeReadiness> => {
      try {
        await this.initialize();
        if (this.schemaContractState === "pending" || this.schemaContractState === "applying") {
          bundleError("DURABLE_RUNTIME_SCHEMA_CONTRACT_PENDING");
        }
        if (this.schemaContractState !== "ready") {
          bundleError("DURABLE_RUNTIME_READINESS_UNAVAILABLE");
        }
        if (this.schemaVersion < 10) {
          bundleError("DURABLE_RUNTIME_SCHEMA_V10_REQUIRED");
        }
        return Object.freeze({
          provider: "postgres" as const,
          minimumSchemaVersion: 10 as const,
          currentSchemaVersion: this.schemaVersion,
          candidateEffects: "ready" as const,
          treeEffects: "ready" as const,
          graphEffects: "ready" as const,
        });
      } catch (error) {
        const readinessError = error instanceof PostgresDurableJobV2RuntimeBundleError
          ? error
          : error instanceof PostgresSchemaContractError
            ? new PostgresDurableJobV2RuntimeBundleError(
                error.code === "SCHEMA_CONTRACT_INVALID"
                  ? "DURABLE_RUNTIME_SCHEMA_INVALID"
                  : "DURABLE_RUNTIME_SCHEMA_CONTRACT_PENDING",
              )
            : new PostgresDurableJobV2RuntimeBundleError(
                "DURABLE_RUNTIME_READINESS_UNAVAILABLE",
              );
        try {
          await this.#closeProviderPool();
        } finally {
          // Cleanup diagnostics must not replace or contaminate the stable typed
          // readiness failure surfaced to production composition.
          throw readinessError;
        }
      }
    })();
    this.#durableRuntimeReadinessPromise = readiness;
    try {
      return await readiness;
    } finally {
      if (this.#durableRuntimeReadinessPromise === readiness) {
        this.#durableRuntimeReadinessPromise = null;
      }
    }
  }

  async #assertDurableJobV2EnqueueReady(): Promise<PostgresDurableJobV2RuntimeReadiness> {
    try {
      await this.initialize();
      if (this.schemaContractState === "pending" || this.schemaContractState === "applying") {
        bundleError("DURABLE_RUNTIME_SCHEMA_CONTRACT_PENDING");
      }
      if (this.schemaContractState !== "ready") {
        bundleError("DURABLE_RUNTIME_READINESS_UNAVAILABLE");
      }
      if (this.schemaVersion < 10) {
        bundleError("DURABLE_RUNTIME_SCHEMA_V10_REQUIRED");
      }
      return Object.freeze({
        provider: "postgres" as const,
        minimumSchemaVersion: 10 as const,
        currentSchemaVersion: this.schemaVersion,
        candidateEffects: "ready" as const,
        treeEffects: "ready" as const,
        graphEffects: "ready" as const,
      });
    } catch (error) {
      if (error instanceof PostgresDurableJobV2RuntimeBundleError) throw error;
      if (error instanceof PostgresSchemaContractError) {
        throw new PostgresDurableJobV2RuntimeBundleError(
          error.code === "SCHEMA_CONTRACT_INVALID"
            ? "DURABLE_RUNTIME_SCHEMA_INVALID"
            : "DURABLE_RUNTIME_SCHEMA_CONTRACT_PENDING",
        );
      }
      throw new PostgresDurableJobV2RuntimeBundleError(
        "DURABLE_RUNTIME_READINESS_UNAVAILABLE",
      );
    }
  }

  /**
   * Fenced domain effect capability bound to this provider's initialized Pool.
   * Callers can choose relation policies, but cannot inject a Pool or alternate DB config.
   */
  createDurableJobV2EffectRepository(
    dependencies: GenericEffectRepositoryDependencies,
  ): PostgresDurableJobV2EffectRepository {
    const canonicalDependencies = snapshotGenericEffectRepositoryDependencies(dependencies);
    if (canonicalDependencies.allowedRelations.includes(MENGSHU_CANDIDATE_RELATION)) {
      throw new Error(
        "Postgres candidate effect must use the provider-owned executeCandidateEffect capability",
      );
    }
    if (canonicalDependencies.allowedRelations.some((relation) =>
      PROVIDER_OWNED_DOMAIN_EFFECT_RELATIONS.has(relation))) {
      throw new Error(
        "Postgres domain effect must use a provider-owned runtime capability",
      );
    }
    return this.#createDurableJobV2EffectRepositoryInternal(canonicalDependencies, false, 7);
  }

  #createDurableJobV2EffectRepositoryInternal(
    dependencies: GenericEffectRepositoryDependencies,
    candidateEffect: boolean,
    minimumSchemaVersion: number,
    authority?: typeof CANDIDATE_EFFECT_FACTORY_AUTHORITY,
  ): PostgresDurableJobV2EffectRepository {
    const canonicalDependencies = snapshotGenericEffectRepositoryDependencies(dependencies);
    const includesCandidate = canonicalDependencies.allowedRelations.includes(
      MENGSHU_CANDIDATE_RELATION,
    );
    if ((!candidateEffect && includesCandidate) ||
        (candidateEffect && (
          authority !== CANDIDATE_EFFECT_FACTORY_AUTHORITY ||
          minimumSchemaVersion !== 8 ||
          canonicalDependencies.allowedRelations.length !== 1 ||
          !includesCandidate
        ))) {
      throw new Error(
        "Postgres candidate effect must use the provider-owned executeCandidateEffect capability",
      );
    }
    const candidateInsertPolicy = candidateEffect
      ? [{
        relation: MENGSHU_CANDIDATE_RELATION,
        conflictColumns: MENGSHU_CANDIDATE_CONFLICT_COLUMNS,
        valueCasts: [
          { column: "evidence_ids", type: "jsonb" as const },
          { column: "metadata", type: "jsonb" as const },
        ],
      }]
      : [];
    const repository = new PostgresDurableJobV2EffectRepository({
      connect: async (): Promise<PostgresDurableJobV2EffectClient> => {
        await this.initialize();
        this.assertSchemaVersion(minimumSchemaVersion, candidateEffect
          ? "durable candidate effect"
          : "durable job effect");
        const client = await this.pool!.connect();
        return {
          query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
            sql: string,
            params: readonly unknown[] = [],
          ) => {
            const result = await client.query(sql, [...params]);
            return {
              rows: result.rows as Row[],
              rowCount: result.rowCount,
            };
          },
          release: () => client.release(),
        };
      },
    }, {
      ...canonicalDependencies,
      insertOnConflictPolicies: candidateInsertPolicy,
    });
    PROVIDER_OWNED_EFFECT_REPOSITORIES.add(repository);
    return repository;
  }

  #createProviderOwnedDomainEffectRunner(
    allowedRelations: readonly string[],
    executionDependencies: { readonly clock?: () => number },
  ): PostgresProviderOwnedDomainEffectRunner {
    const repository = new PostgresDurableJobV2EffectRepository({
      connect: async (): Promise<PostgresDurableJobV2EffectClient> => {
        await this.initialize();
        this.assertSchemaVersion(9, "durable tree/graph effect");
        const client = await this.pool!.connect();
        return {
          query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
            sql: string,
            params: readonly unknown[] = [],
          ) => {
            const result = await client.query(sql, [...params]);
            return { rows: result.rows as Row[], rowCount: result.rowCount };
          },
          release: () => client.release(),
        };
      },
    }, {
      ...executionDependencies,
      allowedRelations,
    });
    return createPostgresProviderOwnedDomainEffectRunner(repository);
  }

  async #executeBuildTreeEffect(
    request: PostgresBuildTreeEffectRequest,
    signal: AbortSignal,
    executionDependencies: { readonly clock?: () => number },
  ): Promise<PostgresDurableJobV2EffectResult<PostgresBuildTreeEffectSummary>> {
    if (!signal || typeof signal !== "object" || typeof signal.aborted !== "boolean") {
      throw new Error("Postgres build_tree abort signal is invalid");
    }
    if (signal.aborted) {
      throw signal.reason instanceof Error && signal.reason.name === "AbortError"
        ? signal.reason
        : new DOMException("Postgres build_tree aborted", "AbortError");
    }
    const runner = this.#createProviderOwnedDomainEffectRunner(
      POSTGRES_BUILD_TREE_EFFECT_RELATIONS,
      executionDependencies,
    );
    try {
      return await runner.execute({
        ...request.effectInput,
        effectKey: POSTGRES_BUILD_TREE_EFFECT_KEY,
        requestFingerprint: buildTreeSemanticFingerprint(request),
      }, (client) => executePostgresBuildTreeDomainEffect(client, request));
    } catch (error) {
      if (error instanceof PostgresDurableJobV2EffectError) throw error;
      if (error instanceof Error && /^Postgres build_tree (?:effect input|query result)/.test(error.message)) {
        throw new PostgresDurableJobV2EffectError(
          "DURABLE_JOB_EFFECT_INVALID_RESULT",
          "Postgres build_tree domain effect is invalid",
        );
      }
      throw error;
    }
  }

  async #executeGraphEffect(
    rawRequest: PostgresExtractGraphEffectRequest,
    executionDependencies: { readonly clock?: () => number },
  ): Promise<PostgresDurableJobV2EffectResult<PostgresExtractGraphEffectSummary>> {
    const requestRecord = exactDataRecord(
      rawRequest,
      ["effectInput", "context", "semanticRequest", "entities", "relations"],
      [],
      "Postgres graph effect input is invalid",
    );
    const effectRecord = exactDataRecord(
      requestRecord.effectInput,
      ["id", "scope", "owner", "leaseToken", "leaseGeneration"],
      [],
      "Postgres graph effect input is invalid",
    );
    const contextRecord = exactDataRecord(
      requestRecord.context,
      [],
      ["workspaceId", "sessionId"],
      "Postgres graph effect input is invalid",
    );
    const semanticRecord = exactDataRecord(
      requestRecord.semanticRequest,
      ["chunkId", "text"],
      ["sourceId", "context"],
      "Postgres graph effect input is invalid",
    );
    const effectInput = Object.freeze({
      id: effectRecord.id,
      scope: effectRecord.scope,
      owner: effectRecord.owner,
      leaseToken: effectRecord.leaseToken,
      leaseGeneration: effectRecord.leaseGeneration,
    }) as unknown as PostgresExtractGraphEffectRequest["effectInput"];
    const context = Object.freeze({
      ...(contextRecord.workspaceId === undefined ? {} : { workspaceId: contextRecord.workspaceId }),
      ...(contextRecord.sessionId === undefined ? {} : { sessionId: contextRecord.sessionId }),
    }) as PostgresExtractGraphEffectRequest["context"];
    const semanticRequest = Object.freeze({
      chunkId: semanticRecord.chunkId,
      text: semanticRecord.text,
      ...(semanticRecord.sourceId === undefined ? {} : { sourceId: semanticRecord.sourceId }),
      ...(semanticRecord.context === undefined ? {} : { context: semanticRecord.context }),
    }) as PostgresExtractGraphEffectRequest["semanticRequest"];
    const graphRepository = new PostgresGraphRepository({
      assertReady: () => this.assertSchemaVersion(9, "durable graph effect"),
    });
    const fullScope = {
      ...effectInput.scope,
      ...context,
    };
    // 整批在 initialize/connect 前完成深快照；transaction 内仅重验冻结值。
    let graph: ReturnType<PostgresGraphRepository["snapshotGraph"]>;
    try {
      graph = graphRepository.snapshotGraph(
        fullScope,
        requestRecord.entities as PostgresExtractGraphEffectRequest["entities"],
        requestRecord.relations as PostgresExtractGraphEffectRequest["relations"],
      );
    } catch {
      throw new PostgresDurableJobV2EffectError(
        "DURABLE_JOB_EFFECT_INVALID_INPUT",
        "Postgres graph domain input is invalid",
      );
    }
    const request = Object.freeze({
      effectInput,
      context,
      semanticRequest,
      entities: graph.entities,
      relations: graph.relations,
    }) satisfies PostgresExtractGraphEffectRequest;
    const runner = this.#createProviderOwnedDomainEffectRunner([
      "mengshu_graph_entities",
      "mengshu_graph_relations",
    ], executionDependencies);
    try {
      return await runner.execute({
        ...effectInput,
        effectKey: POSTGRES_EXTRACT_GRAPH_EFFECT_KEY,
        requestFingerprint: extractGraphSemanticFingerprint(request),
      }, (client) => graphRepository.upsertGraphWithClient(
        client,
        fullScope,
        graph.entities as PostgresExtractGraphEffectRequest["entities"],
        graph.relations as PostgresExtractGraphEffectRequest["relations"],
      ));
    } catch (error) {
      if (error instanceof PostgresDurableJobV2EffectError) throw error;
      if (error instanceof Error && /^Postgres graph (?:input|query result|relation endpoint)/.test(error.message)) {
        throw new PostgresDurableJobV2EffectError(
          "DURABLE_JOB_EFFECT_INVALID_RESULT",
          "Postgres graph domain effect is invalid",
        );
      }
      throw error;
    }
  }

  /** Provider-owned atomic batch, reachable only through a minted runtime bundle. */
  async #executeCandidateEffect(
    rawRequest: PostgresCandidateEffectRequest,
    executionDependencies: { readonly clock?: () => number },
  ): Promise<PostgresDurableJobV2EffectResult<PostgresCandidateEffectSummary>> {
    const request = snapshotCandidateEffectRequest(rawRequest);
    const repository = new PostgresCandidateRepository({
      assertReady: () => this.assertSchemaVersion(8, "durable candidate"),
    });
    // Snapshot the entire batch before initialize/connect. A malformed later
    // item therefore cannot cause an earlier item to reach PostgreSQL.
    const candidates = repository.snapshotPendingCandidates(request.candidates);
    const effectInput = candidateEffectInput(request);
    const effects = this.#createDurableJobV2EffectRepositoryInternal({
      ...executionDependencies,
      allowedRelations: [MENGSHU_CANDIDATE_RELATION],
    }, true, 8, CANDIDATE_EFFECT_FACTORY_AUTHORITY);
    const effectResult = await effects.executeWithPendingCandidateCapacity<PostgresCandidateEffectSummary>(
      effectInput,
      { context: request.context, requestedCount: candidates.length },
      async (client, capacity) => {
      const candidateIds: string[] = [];
      let duplicateCount = 0;
      const boundedCandidates = candidates.slice(0, capacity.remaining);
      const capacityRejectedCount = candidates.length - boundedCandidates.length;
      const binding = Object.freeze({
        sourceJobId: effectInput.id,
        scope: Object.freeze({
          ...effectInput.scope,
          ...request.context,
        }) as Readonly<MemoryScope>,
      });
      for (const candidate of boundedCandidates) {
        const result = await repository.insertPendingWithClient(client, binding, candidate);
        if (result.inserted) candidateIds.push(result.candidateId!);
        else duplicateCount += 1;
      }
      return Object.freeze({
        created: candidateIds.length,
        duplicateCount,
        capacityRejectedCount,
        candidateIds: Object.freeze(candidateIds),
      });
      },
    );
    if (effectResult.status === "applied") {
      assertCandidateEffectSummary(effectResult.receipt.result, candidates);
    } else if (effectResult.status === "replayed") {
      // Candidates are intentionally excluded from the semantic fingerprint:
      // nondeterministic recomputation must replay the original committed receipt.
      assertCandidateEffectSummary(effectResult.receipt.result);
    }
    return effectResult;
  }

  private assertSchemaVersion(minimum: number, capability: string): void {
    if (this.schemaVersion < minimum) {
      throw new Error(`Postgres ${capability} schema v${minimum} is required`);
    }
  }

  async store(entries: MemoryEntry[]): Promise<DatabaseStoreResult> {
    await this.initialize();

    // 按表名分组
    const entriesByTable = new Map<TableName, MemoryEntry[]>();
    for (const entry of entries) {
      const tableName = entry.tableName ?? this.getDefaultTableName(entry.dataType);
      const existing = entriesByTable.get(tableName) || [];
      existing.push(entry);
      entriesByTable.set(tableName, existing);
    }

    // 先对整个 batch 做能力校验，再开始任何 INSERT，避免 mixed batch 部分写。
    for (const tableName of entriesByTable.keys()) {
      if (!DEFAULT_TABLES.includes(tableName)) {
        throw new Error(
          "Postgres extended knowledge table writes are disabled until transactional scope/forget support is available",
        );
      }
    }
    for (const entry of entries) {
      this.validateStoreEntry(entry);
    }
    if (entries.length === 0) {
      return { inserted: 0, duplicates: 0, records: [] };
    }

    const client = await this.pool!.connect();
    try {
      await client.query("BEGIN");
      const records: DatabaseStoreRecordResult[] = [];
      const query: StoreQuery = async (sql, params = []) => {
        const result = await client.query(sql, [...params]);
        return { rows: result.rows, rowCount: result.rowCount };
      };
      for (const [tableName, tableEntries] of entriesByTable.entries()) {
        records.push(...await this.insertEntries(tableName, tableEntries, query));
      }
      await client.query("COMMIT");
      const inserted = records.filter((record) => record.stored).length;
      return {
        inserted,
        duplicates: records.length - inserted,
        records,
      };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Postgres store and rollback both failed");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async query(options: MemoryQueryOptions): Promise<(MemoryEntry & { score: number })[]> {
    const hasTenantAuthority = options.tenantId !== undefined;
    const hasUserAuthority = options.userId !== undefined;
    if (hasTenantAuthority !== hasUserAuthority ||
        (hasTenantAuthority &&
         (typeof options.tenantId !== "string" || options.tenantId.length === 0 ||
          typeof options.userId !== "string" || options.userId.length === 0))) {
      throw new Error("Postgres recall tenant/user authority must be provided together");
    }
    if (options.vector) {
      this.assertAnnEmbeddingFilter(options.filter);
    }
    await this.initialize();

    if (options.searchAll) {
      const allResults: Array<MemoryEntry & { score: number }> = [];

      for (const tableName of DEFAULT_TABLES) {
        try {
          const results = await this.queryFromTable(tableName, options);
          allResults.push(...results);
        } catch (err) {
          console.warn(`Query failed on table ${tableName}:`, err);
        }
      }

      allResults.sort((a, b) => b.score - a.score);
      if (options.limit) {
        return allResults.slice(0, options.limit);
      }
      return allResults;
    }

    const tableName = options.tableName ?? this.getDefaultTableName(options.dataTypes?.[0]);
    return this.queryFromTable(tableName, options);
  }

  async delete(ids: string[]): Promise<void> {
    await this.initialize();

    if (ids.length === 0) return;

    const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");
    await this.pool!.query(
      `DELETE FROM memories WHERE id IN (${placeholders})`,
      ids,
    );
  }

  async deleteByFilter(filter: Record<string, unknown>): Promise<number> {
    assertSafeLegacyDeleteFilter(filter, { consumesDataType: true });
    await this.initialize();

    const tableName = filter.tableName as TableName | undefined;
    const tables = tableName ? [tableName] : DEFAULT_TABLES;

    let totalDeleted = 0;

    for (const table of tables) {
      const { conditions, params } = this.buildFilterConditions(filter, ["tableName"]);

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const result = await this.pool!.query(
        `DELETE FROM ${this.escapeIdentifier(table)} ${whereClause}`,
        params,
      );

      totalDeleted += result.rowCount ?? 0;
    }

    return totalDeleted;
  }

  async existsByContentHash(contentHashes: string[]): Promise<string[]> {
    await this.initialize();

    if (contentHashes.length === 0) return [];

    const existingHashes: string[] = [];

    for (const table of DEFAULT_TABLES) {
      const placeholders = contentHashes.map((_, i) => `$${i + 1}`).join(", ");
      const { rows } = await this.pool!.query(
        `SELECT content_hash FROM ${this.escapeIdentifier(table)} WHERE ${NON_QUARANTINED_ROW_SQL} AND content_hash IN (${placeholders})`,
        contentHashes,
      );

      for (const row of rows) {
        if (!existingHashes.includes(row.content_hash)) {
          existingHashes.push(row.content_hash);
        }
      }
    }

    return existingHashes;
  }

  async count(filter?: Record<string, unknown>): Promise<number> {
    await this.initialize();

    if (filter?.tableName) {
      return this.countByTable(filter.tableName as TableName, filter);
    }

    let total = 0;
    for (const table of DEFAULT_TABLES) {
      total += await this.countByTable(table, filter);
    }
    return total;
  }

  async getTableNames(): Promise<TableName[]> {
    return [...DEFAULT_TABLES, ...this.extendedTables];
  }

  async ensureTable(tableName: TableName): Promise<void> {
    await this.createTableIfNotExists(tableName);
  }

  async getTableStats(): Promise<TableStats[]> {
    const stats: TableStats[] = [];
    const allTables = [...DEFAULT_TABLES, ...this.extendedTables];

    for (const tableName of allTables) {
      const count = await this.count({ tableName });
      stats.push({
        name: tableName,
        count,
        dataType: tableName === "memories" ? "memory" : "knowledge",
      });
    }

    return stats;
  }

  /**
   * 按 id 增量合并 metadata（jsonb `||` 操作符）。
   *
   * 用于回填历史记录的溯源字段：store 在 content_hash 冲突时 DO NOTHING，
   * 已存在记录的 metadata 无法更新；本方法直接按主键 UPDATE。
   *
   * SQL: `UPDATE <table> SET metadata = metadata || $1::jsonb WHERE id = $2`
   * - $1 为 patch 的 JSON 字符串（参数化，防注入）
   * - tableName 经 escapeIdentifier 白名单校验（防注入）
   *
   * @returns affected rows > 0
   */
  async updateMetadata(
    id: string,
    metadataPatch: Record<string, unknown>,
    tableName: TableName = "memories",
  ): Promise<boolean> {
    await this.initialize();

    const escaped = this.escapeIdentifier(tableName);
    const result = await this.pool!.query(
      `UPDATE ${escaped} SET metadata = metadata || $1::jsonb WHERE id = $2`,
      [JSON.stringify(metadataPatch), id],
    );

    return (result.rowCount ?? 0) > 0;
  }

  // ============================================================================
  // 私有方法
  // ============================================================================

  private getDefaultTableName(dataType?: string): TableName {
    switch (dataType) {
      case "knowledge":
      case "document":
        return "knowledge";
      case "memory":
      default:
        return "memories";
    }
  }

  /**
   * 转义 SQL 标识符，防止注入
   * 只允许字母、数字、下划线
   */
  private escapeIdentifier(name: string): string {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      throw new Error(`Invalid identifier: ${name}`);
    }
    return `"${name}"`;
  }

  private async createTableIfNotExists(
    tableName: TableName,
    queryClient: Pick<pg.Pool, "query"> = this.pool!,
  ): Promise<void> {
    const escaped = this.escapeIdentifier(tableName);
    const defaultImportance = tableName === "memories" ? "0.7" : "0.5";
    const defaultDataType = tableName === "memories" ? "memory" : "knowledge";

    await queryClient.query(`
      CREATE TABLE IF NOT EXISTS ${escaped} (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        text TEXT NOT NULL,
        content_hash TEXT NOT NULL UNIQUE,
        vector vector(${this.vectorDim}) NOT NULL,
        importance FLOAT NOT NULL DEFAULT ${defaultImportance},
        category TEXT NOT NULL DEFAULT 'other',
        data_type TEXT NOT NULL DEFAULT '${defaultDataType}',
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        project_name TEXT,
        app_name TEXT,
        user_id TEXT,
        agent_id TEXT,
        workspace_id TEXT
      )
    `);

    // 存量表兼容：CREATE TABLE 已有但缺 scope 列时补齐（IF NOT EXISTS 防重复）
    const alterQueries = [
      `ALTER TABLE ${escaped} ADD COLUMN IF NOT EXISTS project_name TEXT`,
      `ALTER TABLE ${escaped} ADD COLUMN IF NOT EXISTS app_name TEXT`,
      `ALTER TABLE ${escaped} ADD COLUMN IF NOT EXISTS user_id TEXT`,
      `ALTER TABLE ${escaped} ADD COLUMN IF NOT EXISTS agent_id TEXT`,
      `ALTER TABLE ${escaped} ADD COLUMN IF NOT EXISTS workspace_id TEXT`,
    ];
    for (const sql of alterQueries) {
      try {
        await queryClient.query(sql);
      } catch (err: any) {
        console.warn(`Column add warning for ${tableName}:`, err.message);
      }
    }

    // 创建索引（忽略已存在错误）
    const indexQueries = [
      `CREATE INDEX IF NOT EXISTS ${tableName}_vector_idx ON ${escaped} USING ivfflat (vector vector_cosine_ops) WITH (lists = 100)`,
      `CREATE INDEX IF NOT EXISTS ${tableName}_data_type_idx ON ${escaped} (data_type)`,
      `CREATE INDEX IF NOT EXISTS ${tableName}_created_at_idx ON ${escaped} (created_at DESC)`,
      // D-25：scope 维度索引（高频按项目/产品过滤时性能关键）
      `CREATE INDEX IF NOT EXISTS idx_${tableName}_project_name ON ${escaped} (project_name)`,
      `CREATE INDEX IF NOT EXISTS idx_${tableName}_app_name ON ${escaped} (app_name)`,
    ];

    for (const sql of indexQueries) {
      try {
        await queryClient.query(sql);
      } catch (err: any) {
        // ivfflat 索引在表为空时可能无法创建，忽略此错误
        if (!err.message?.includes("already exists")) {
          console.warn(`Index creation warning for ${tableName}:`, err.message);
        }
      }
    }
  }

  private validateStoreEntry(entry: MemoryEntry): void {
    const canonicalFields = {
      tenantId: entry.tenantId,
      userId: entry.userId,
      canonicalProjectId: entry.canonicalProjectId,
      productId: entry.productId,
      producerId: entry.producerId,
      namespace: entry.namespace,
      visibility: entry.visibility,
    };
    for (const [field, value] of Object.entries(canonicalFields)) {
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`Postgres new write requires canonical scope field: ${field}`);
      }
    }
    if (entry.id !== undefined && !UUID.test(entry.id)) {
      throw new Error("Postgres durable record id must be a UUID");
    }
    readQueryableEmbeddingStamp(entry.metadata);
  }

  private async insertEntries(
    tableName: TableName,
    entries: MemoryEntry[],
    query: StoreQuery,
  ): Promise<DatabaseStoreRecordResult[]> {
    const escaped = this.escapeIdentifier(tableName);
    const outcomes: DatabaseStoreRecordResult[] = [];

    for (const entry of entries) {
      const id = entry.id || randomUUID();
      const vectorStr = `[${entry.vector.join(",")}]`;
      const createdAt = new Date(entry.createdAt || Date.now()).toISOString();
      const embeddingStamp = readQueryableEmbeddingStamp(entry.metadata);

      // Legacy + canonical scope 双写。新 MemoryEntry 缺 canonical 字段时已在上方
      // fail-closed；绝不从 legacy/default 猜测 tenant/namespace/visibility。
      let insert: Awaited<ReturnType<StoreQuery>>;
      try {
        insert = await query(
          `INSERT INTO ${escaped} (
           id, text, content_hash, vector, importance, category, data_type, metadata, created_at,
           project_name, app_name, user_id, agent_id, workspace_id,
           tenant_id, canonical_project_id, product_id, producer_id, namespace, visibility, lifecycle_status,
           embedding_space_id, embedding_space_state
         )
         VALUES ($1, $2, $3, $4::vector, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14,
                 $15, $16, $17, $18, $19, $20, $21, $22, $23)
         ${this.schemaContractState === "ready"
    ? `ON CONFLICT (${AUTHORITY_DEDUPE_COLUMNS}) DO NOTHING`
    : "ON CONFLICT DO NOTHING"}
         RETURNING id`,
          [
          id,
          entry.text,
          entry.contentHash,
          vectorStr,
          entry.importance,
          entry.category,
          entry.dataType,
          JSON.stringify(entry.metadata),
          createdAt,
          entry.projectName ?? null,
          entry.appName ?? null,
          entry.userId ?? null,
          entry.agentId ?? null,
          entry.workspaceId ?? null,
          entry.tenantId,
          entry.canonicalProjectId,
          entry.productId,
          entry.producerId,
          entry.namespace,
          entry.visibility,
          entry.lifecycleStatus ?? null,
          embeddingStamp.embeddingSpaceId,
          embeddingStamp.embeddingSpaceState,
          ],
        );
      } catch (error) {
        if (this.schemaContractState === "ready" && isLegacyGlobalContentHashViolation(error)) {
          throw new PostgresSchemaContractError(
            "SCHEMA_CONTRACT_INVALID",
            "Postgres legacy global content hash unique index was reintroduced after contract migration",
          );
        }
        throw error;
      }
      if (insert.rowCount === 1 && insert.rows.length === 1) {
        const persistedId = (insert.rows[0] as { id?: unknown }).id;
        if (typeof persistedId !== "string") {
          throw new Error("Postgres insert did not return a durable record id");
        }
        outcomes.push({ requestedId: id, persistedId, stored: true });
        continue;
      }
      if (insert.rowCount !== 0) {
        throw new Error("Postgres insert returned an invalid row count");
      }

      // ON CONFLICT DO NOTHING 不返回冲突行；在同一 transaction 内按完整
      // authority key 查询真实持久化 ID，避免 service 返回一个并不存在的新 ID。
      const duplicate = await query(
        `SELECT id FROM ${escaped}
         WHERE tenant_id = $1 AND user_id = $2 AND canonical_project_id = $3
           AND product_id = $4 AND producer_id = $5 AND namespace = $6
           AND visibility = $7 AND content_hash = $8
           AND ${NON_QUARANTINED_ROW_SQL}
         LIMIT 1`,
        [
          entry.tenantId,
          entry.userId,
          entry.canonicalProjectId,
          entry.productId,
          entry.producerId,
          entry.namespace,
          entry.visibility,
          entry.contentHash,
        ],
      );
      const persistedId = (duplicate.rows[0] as { id?: unknown } | undefined)?.id;
      if (duplicate.rowCount !== 1 || typeof persistedId !== "string") {
        if (this.schemaContractState !== "ready") {
          throw new PostgresSchemaContractError(
            "SCHEMA_CONTRACT_PENDING",
            "Postgres scope-aware content dedupe contract is pending explicit maintenance",
          );
        }
        throw new Error("Postgres authority-scoped duplicate could not be resolved");
      }
      outcomes.push({ requestedId: id, persistedId, stored: false });
    }
    return outcomes;
  }

  private async queryFromTable(
    tableName: TableName,
    options: MemoryQueryOptions,
  ): Promise<(MemoryEntry & { score: number })[]> {
    const escaped = this.escapeIdentifier(tableName);

    if (options.vector) {
      return this.queryWithVector(escaped, tableName, options);
    }

    // 非向量查询
    const conditions: string[] = [NON_QUARANTINED_ROW_SQL];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (options.dataTypes && options.dataTypes.length > 0) {
      const placeholders = options.dataTypes.map((_, i) => `$${paramIdx + i}`).join(", ");
      conditions.push(`data_type IN (${placeholders})`);
      params.push(...options.dataTypes);
      paramIdx += options.dataTypes.length;
    }

    paramIdx = this.appendMetadataConditions(
      conditions,
      params,
      options.filter,
      paramIdx,
    );

    // D-25：scope 维度硬过滤（参数化防注入）
    paramIdx = this.appendScopeConditions(conditions, params, options, paramIdx);

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limitClause = options.limit ? `LIMIT $${paramIdx}` : "";
    if (options.limit) params.push(options.limit);

    const { rows } = await this.pool!.query(
      `SELECT * FROM ${escaped} ${whereClause} ORDER BY created_at DESC ${limitClause}`,
      params,
    );

    return rows.map((row) => this.rowToEntry(row, 0));
  }

  private async queryWithVector(
    escapedTable: string,
    _tableName: TableName,
    options: MemoryQueryOptions,
  ): Promise<(MemoryEntry & { score: number })[]> {
    const vectorStr = `[${options.vector!.join(",")}]`;
    const conditions: string[] = [NON_QUARANTINED_ROW_SQL];
    const params: unknown[] = [vectorStr];
    let paramIdx = 2;

    if (options.dataTypes && options.dataTypes.length > 0) {
      const placeholders = options.dataTypes.map((_, i) => `$${paramIdx + i}`).join(", ");
      conditions.push(`data_type IN (${placeholders})`);
      params.push(...options.dataTypes);
      paramIdx += options.dataTypes.length;
    }

    paramIdx = this.appendMetadataConditions(
      conditions,
      params,
      options.filter,
      paramIdx,
    );

    // D-25：scope 维度硬过滤（参数化防注入）
    paramIdx = this.appendScopeConditions(conditions, params, options, paramIdx);

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = options.limit ?? 5;
    params.push(limit);

    const { rows } = await this.pool!.query(
      `SELECT *, 1 - (vector <=> $1::vector) AS similarity
       FROM ${escapedTable}
       ${whereClause}
       ORDER BY vector <=> $1::vector
       LIMIT $${paramIdx}`,
      params,
    );

    const minScore = options.minScore ?? 0;
    return rows
      .map((row) => this.rowToEntry(row, row.similarity))
      .filter((entry) => entry.score >= minScore);
  }

  /**
   * D-25：把 options 上的 scope 维度字段转成 WHERE 条件（参数化）
   *
   * - projectName/appName：精确等值（走 B-tree 索引）
   * - projectPattern：LIKE 模糊匹配（如 `'%openclaw%'`）
   *
   * @returns 更新后的 paramIdx
   */
  private appendScopeConditions(
    conditions: string[],
    params: unknown[],
    options: MemoryQueryOptions,
    paramIdx: number,
  ): number {
    if (options.tenantId !== undefined && options.userId !== undefined) {
      // Authority 永远绑定独立列；值只进入 pg 参数，绝不拼接进 SQL。
      conditions.push(`tenant_id = $${paramIdx}`);
      params.push(options.tenantId);
      paramIdx++;
      conditions.push(`user_id = $${paramIdx}`);
      params.push(options.userId);
      paramIdx++;
    }

    if (typeof options.projectName === "string" && options.projectName.length > 0) {
      conditions.push(`project_name = $${paramIdx}`);
      params.push(options.projectName);
      paramIdx++;
    }

    if (typeof options.appName === "string" && options.appName.length > 0) {
      conditions.push(`app_name = $${paramIdx}`);
      params.push(options.appName);
      paramIdx++;
    }

    if (typeof options.projectPattern === "string" && options.projectPattern.length > 0) {
      conditions.push(`project_name LIKE $${paramIdx}`);
      params.push(options.projectPattern);
      paramIdx++;
    }

    return paramIdx;
  }

  /** ANN 必须在进入 provider SQL 前携带完整的 canonical space 分区。 */
  private assertAnnEmbeddingFilter(filter?: Record<string, unknown>): void {
    if (!filter) {
      throw new Error("Postgres ANN requires a complete embedding space filter");
    }
    try {
      readQueryableEmbeddingStamp(filter);
    } catch {
      // 不回显 filter 值，避免把调用方 metadata 或密钥写入日志。
      throw new Error(
        "Postgres ANN requires a valid embeddingSpaceId and embeddingSpaceState=known-queryable filter",
      );
    }
  }

  /**
   * embedding partition 同时命中独立列和兼容 metadata：独立列保证
   * ANN 在 top-K 前分区，metadata 镜像防止部分双写/人工篡改被静默接受。
   */
  private appendMetadataConditions(
    conditions: string[],
    params: unknown[],
    filter: Record<string, unknown> | undefined,
    paramIdx: number,
  ): number {
    if (!filter) return paramIdx;
    for (const [key, value] of Object.entries(filter)) {
      assertSafeMetadataFilterKey(key);
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        continue;
      }
      if (key === EMBEDDING_METADATA_ID) {
        conditions.push(
          `(embedding_space_id = $${paramIdx} AND metadata->>'${EMBEDDING_METADATA_ID}' = $${paramIdx})`,
        );
      } else if (key === EMBEDDING_METADATA_STATE) {
        conditions.push(
          `(embedding_space_state = $${paramIdx} AND metadata->>'${EMBEDDING_METADATA_STATE}' = $${paramIdx})`,
        );
      } else {
        conditions.push(`metadata->>'${key}' = $${paramIdx}`);
      }
      params.push(String(value));
      paramIdx += 1;
    }
    return paramIdx;
  }

  private rowToEntry(row: any, score: number): MemoryEntry & { score: number } {
    return {
      id: row.id,
      text: row.text,
      contentHash: row.content_hash,
      vector: row.vector,
      importance: row.importance,
      category: row.category,
      dataType: row.data_type,
      metadata: row.metadata,
      createdAt: new Date(row.created_at).getTime(),
      // D-25：scope 维度字段（NULL → undefined，由上层 legacy-mapping 决定回退默认值）
      projectName: row.project_name ?? undefined,
      appName: row.app_name ?? undefined,
      userId: row.user_id ?? undefined,
      agentId: row.agent_id ?? undefined,
      workspaceId: row.workspace_id ?? undefined,
      tenantId: row.tenant_id ?? undefined,
      canonicalProjectId: row.canonical_project_id ?? undefined,
      productId: row.product_id ?? undefined,
      producerId: row.producer_id ?? undefined,
      namespace: row.namespace ?? undefined,
      visibility: row.visibility ?? undefined,
      lifecycleStatus: row.lifecycle_status ?? undefined,
      score,
    };
  }

  /**
   * 构建过滤条件（用于 deleteByFilter）
   */
  private buildFilterConditions(
    filter: Record<string, unknown>,
    skipKeys: string[],
  ): { conditions: string[]; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    for (const [key, value] of Object.entries(filter)) {
      if (skipKeys.includes(key)) continue;

      if (key === "dataType") {
        conditions.push(`data_type = $${paramIdx}`);
        params.push(value);
        paramIdx++;
      } else if (key === "createdAt" && typeof value === "object" && value !== null) {
        for (const [op, val] of Object.entries(value as Record<string, number>)) {
          const date = new Date(val).toISOString();
          switch (op) {
            case "$gt":
              conditions.push(`created_at > $${paramIdx}`);
              break;
            case "$gte":
              conditions.push(`created_at >= $${paramIdx}`);
              break;
            case "$lt":
              conditions.push(`created_at < $${paramIdx}`);
              break;
            case "$lte":
              conditions.push(`created_at <= $${paramIdx}`);
              break;
            case "$eq":
              conditions.push(`created_at = $${paramIdx}`);
              break;
            default:
              continue;
          }
          params.push(date);
          paramIdx++;
        }
      } else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        conditions.push(`${this.escapeIdentifier(key)} = $${paramIdx}`);
        params.push(value);
        paramIdx++;
      }
    }

    return { conditions, params };
  }

  private async countByTable(tableName: TableName, filter?: Record<string, unknown>): Promise<number> {
    const escaped = this.escapeIdentifier(tableName);
    const conditions: string[] = [NON_QUARANTINED_ROW_SQL];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (filter) {
      for (const [key, value] of Object.entries(filter)) {
        if (key === "tableName") continue;
        if (key === "dataType") {
          conditions.push(`data_type = $${paramIdx}`);
          params.push(value);
          paramIdx++;
        } else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          conditions.push(`${this.escapeIdentifier(key)} = $${paramIdx}`);
          params.push(value);
          paramIdx++;
        }
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await this.pool!.query(
      `SELECT COUNT(*)::int AS count FROM ${escaped} ${whereClause}`,
      params,
    );

    return rows[0]?.count ?? 0;
  }
}
