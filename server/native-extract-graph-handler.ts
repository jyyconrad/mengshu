import { types as nodeUtilTypes } from "node:util";
import { createHash } from "node:crypto";

import {
  assertProviderOwnedPostgresDurableJobV2RuntimeBundle,
  type PostgresDurableJobV2RuntimeBundle,
} from "../packages/core/src/db/providers/postgres.js";

import { extractGraphWithLlm } from "../packages/core/src/graph/llm-extractor.js";
import {
  deriveAuthoritativeEntityGraph,
  planCanonicalEntityTopicFanOut,
  type AuthoritativeEntityGraphDerivation,
} from "../packages/core/src/graph/authoritative-entity-graph-derivation.js";
import {
  authorityScopeFingerprint,
} from "../packages/core/src/domain/authority-scope-fingerprint.js";
import type {
  AuthoritativeEntityGraphReadFact,
  AuthoritativeEntityGraphReadPort,
} from "../packages/core/src/graph/postgres-authoritative-entity-graph-read-port.js";
import type {
  CanonicalEntityCentralityRefreshPort,
} from "../packages/core/src/graph/postgres-canonical-entity-centrality-refresh.js";
import type {
  CanonicalEntityTopicReadPort,
} from "../packages/core/src/graph/postgres-canonical-entity-topic-read-port.js";
import type {
  TreeFanOutInput,
  TreeFanOutTarget,
} from "../packages/core/src/tree/tree-fan-out.js";
import { ENTITY_TYPES, RELATION_PREDICATES } from "../packages/core/src/graph/schema.js";
import type {
  GraphEntityRecord,
  GraphExtractionResult,
  GraphRelationRecord,
} from "../packages/core/src/graph/types.js";
import type {
  EntityGraphEmbeddingBatch,
} from "../packages/core/src/graph/postgres-entity-canonicalization.js";
import type { LlmClient } from "../packages/core/src/runtime/llm/llm-client.js";
import {
  PostgresDurableJobV2EffectError,
  type PostgresDurableJobV2EffectReplayInspection,
  type PostgresDurableJobV2EffectResult,
} from "../packages/core/src/storage/repositories/postgres-job-v2-effect.js";
import type { PostgresAuthoritativeExtractGraphReplayRequest } from
  "../packages/core/src/db/providers/postgres-job-v2-domain-effects.js";
import {
  assertDurableJobV2,
  deriveDurableJobV2DomainDedupeKey,
  deriveDurableJobV2ScopedDedupeKey,
  isDurableJobV2SafeIdentifier,
  type DurableJobV2,
  type DurableJobV2Scope,
} from "../packages/core/src/storage/repositories/job-v2.js";
import {
  DurableJobV2HandlerFailure,
  type DurableJobV2Handler,
  type DurableJobV2HandlerContext,
} from "./workers-v2.js";

export interface NativeExtractGraphSemanticRequest {
  readonly chunkId: string;
  readonly text: string;
  readonly sourceId?: string;
  readonly context?: Readonly<{
    projectName?: string;
    userName?: string;
    agentName?: string;
  }>;
}

export interface NativeExtractGraphEffectInput {
  readonly id: string;
  readonly scope: DurableJobV2Scope;
  readonly owner: string;
  readonly leaseToken: string;
  readonly leaseGeneration: number;
}

export interface NativeExtractGraphEffectSummary extends Record<string, unknown> {
  readonly createdEntities: number;
  readonly createdRelations: number;
  readonly entityIds: readonly string[];
  readonly relationIds: readonly string[];
  readonly evidenceId?: string;
  readonly memoryEvidenceLinks?: number;
  readonly entityEvidenceLinks?: number;
  readonly relationEvidenceLinks?: number;
  readonly aliasProjections?: number;
}

export interface NativeLegacyExtractGraphEffectRequest {
  readonly effectInput: NativeExtractGraphEffectInput;
  readonly context: Readonly<{ workspaceId?: string; sessionId?: string }>;
  readonly semanticRequest: NativeExtractGraphSemanticRequest;
  readonly entities: readonly Readonly<GraphEntityRecord>[];
  readonly relations: readonly Readonly<GraphRelationRecord>[];
}

export interface NativeAuthoritativeExtractGraphSemanticRequest {
  readonly graphKind: "entity";
  readonly activeMemoryId: string;
  readonly evidenceId: string;
}

export interface NativeAuthoritativeExtractGraphEffectRequest {
  readonly effectInput: NativeExtractGraphEffectInput;
  readonly context: Readonly<{ workspaceId?: string; sessionId?: string }>;
  readonly semanticRequest: NativeAuthoritativeExtractGraphSemanticRequest;
  readonly graph: AuthoritativeEntityGraphDerivation;
  readonly entityEmbeddings: EntityGraphEmbeddingBatch;
}

export type NativeExtractGraphEffectRequest =
  | NativeLegacyExtractGraphEffectRequest
  | NativeAuthoritativeExtractGraphEffectRequest;

/**
 * Provider 最小能力面：由同一 PostgresProvider mint 的冻结 port，内部固定
 * effectKey/fingerprint，并在一个 transaction 中完成 job fence、graph upsert 与 receipt。
 */
export interface NativeExtractGraphEffectPort {
  readonly contract: "mengshu.postgres-graph-effect/v1";
  readonly executeGraphEffect: (
    request: NativeExtractGraphEffectRequest,
  ) => Promise<PostgresDurableJobV2EffectResult<NativeExtractGraphEffectSummary>>;
  readonly inspectAuthoritativeGraphReplay?: (
    request: PostgresAuthoritativeExtractGraphReplayRequest,
  ) => Promise<PostgresDurableJobV2EffectReplayInspection<NativeExtractGraphEffectSummary>>;
}

export interface NativeExtractGraphHandlerDependencies {
  readonly effectPort: NativeExtractGraphEffectPort;
  readonly llmClient: LlmClient;
  readonly authoritativeRead?: AuthoritativeEntityGraphReadPort;
  readonly canonicalEntityCentrality?: CanonicalEntityCentralityRefreshPort;
  readonly canonicalEntityTopicRead?: CanonicalEntityTopicReadPort;
  readonly topicTreeAliases?: Readonly<{
    persist(input: {
      readonly scope: TreeFanOutInput["scope"];
      readonly entities: readonly {
        readonly entityId: string;
        readonly canonicalName: string;
      }[];
      readonly now: number;
    }): Promise<unknown>;
  }>;
  readonly enqueueTopicTarget?: (
    input: TreeFanOutInput,
    target: TreeFanOutTarget,
    signal: AbortSignal,
  ) => Promise<string>;
  /** Production provider-owned composition accepts identity-only jobs. */
  readonly authoritativeOnly?: boolean;
  readonly prepareEntityEmbeddings?: (
    entities: readonly Readonly<GraphEntityRecord>[],
    signal: AbortSignal,
  ) => Promise<EntityGraphEmbeddingBatch>;
  /** 测试/未来可取消计算 seam；production 缺省调用 extractGraphWithLlm。 */
  readonly compute?: (
    input: Parameters<typeof extractGraphWithLlm>[0],
    signal: AbortSignal,
  ) => Promise<GraphExtractionResult>;
}

export interface ProviderOwnedNativeExtractGraphHandlerDependencies {
  readonly runtimeBundle: PostgresDurableJobV2RuntimeBundle;
  readonly llmClient: LlmClient;
  readonly authoritativeRead: AuthoritativeEntityGraphReadPort;
  readonly prepareEntityEmbeddings: NonNullable<
    NativeExtractGraphHandlerDependencies["prepareEntityEmbeddings"]
  >;
  readonly compute?: NativeExtractGraphHandlerDependencies["compute"];
}

export interface NativeExtractGraphHandlerResult {
  readonly status: "applied" | "replayed";
  readonly createdEntities: number;
  readonly createdRelations: number;
  readonly entityIds: readonly string[];
  readonly relationIds: readonly string[];
  readonly evidenceId?: string;
  readonly memoryEvidenceLinks?: number;
  readonly entityEvidenceLinks?: number;
  readonly relationEvidenceLinks?: number;
  readonly aliasProjections?: number;
  readonly topicTargetCount?: number;
  readonly topicJobIds?: readonly string[];
}

const EFFECT_KEY = "extract_graph.persist.v1";
const LEASE_OWNER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const LEASE_TOKEN = /^[A-Za-z0-9._~-]{32,256}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ENTITY_TYPE_SET = new Set<string>(ENTITY_TYPES);
const PREDICATE_SET = new Set<string>(RELATION_PREDICATES);
const ENTITY_STATUS = new Set(["active", "archived", "merged"]);
const RELATION_STATUS = new Set(["active", "weak", "contradicted", "archived"]);
const CONTEXT_KEYS = new Set(["projectName", "userName", "agentName"]);
const SCOPE_KEYS = new Set([
  "tenantId", "userId", "appId", "projectId", "agentId", "namespace", "visibility",
  "workspaceId", "sessionId",
]);

export interface NativeAuthoritativeExtractGraphDedupeInput {
  readonly graphKind: "entity";
  readonly activeMemoryId: string;
  readonly evidenceId: string;
  readonly context?: Readonly<{ workspaceId?: string; sessionId?: string }>;
}

/** Producer/consumer 共用 identity-only authoritative extract_graph dedupe。 */
export function deriveNativeAuthoritativeExtractGraphDedupeKey(
  input: NativeAuthoritativeExtractGraphDedupeInput,
): string {
  if (!input || input.graphKind !== "entity" ||
      !isDurableJobV2SafeIdentifier(input.activeMemoryId) ||
      !isDurableJobV2SafeIdentifier(input.evidenceId)) {
    throw new Error("Authoritative extract_graph dedupe identity is invalid");
  }
  const identity = createHash("sha256").update(JSON.stringify([
    "mengshu.extract-graph.authoritative-job/v1",
    input.graphKind,
    input.activeMemoryId,
    input.evidenceId,
  ])).digest("hex");
  return deriveDurableJobV2DomainDedupeKey("extract_graph", identity, input.context);
}

function failure(code: string, retryable: boolean): DurableJobV2HandlerFailure {
  return new DurableJobV2HandlerFailure(code, retryable);
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error && signal.reason.name === "AbortError") return signal.reason;
  return new DOMException("Native graph extraction aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownData(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error("invalid data property");
  return descriptor.value;
}

function exactKeys(record: Record<string, unknown>, required: readonly string[], allowed = required): void {
  const keys = Reflect.ownKeys(record);
  if (keys.some((key) => typeof key !== "string" || !allowed.includes(key)) ||
      required.some((key) => !keys.includes(key))) {
    throw new Error("invalid keys");
  }
  for (const key of keys as string[]) ownData(record, key);
}

function safeLabel(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max &&
    !/[\u0000-\u001F\u007F-\u009F]/u.test(value) &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}

function sameScope(left: DurableJobV2Scope, right: DurableJobV2Scope): boolean {
  return left.tenantId === right.tenantId && left.userId === right.userId &&
    left.appId === right.appId && left.projectId === right.projectId &&
    left.agentId === right.agentId && left.namespace === right.namespace &&
    left.visibility === right.visibility;
}

function parseScope(raw: unknown, expected: DurableJobV2Scope) {
  if (!plainRecord(raw)) throw new Error("invalid scope");
  exactKeys(raw,
    ["tenantId", "userId", "appId", "projectId", "agentId", "namespace", "visibility"],
    [...SCOPE_KEYS]);
  const scope: DurableJobV2Scope = {
    tenantId: ownData(raw, "tenantId") as string,
    userId: ownData(raw, "userId") as string,
    appId: ownData(raw, "appId") as string,
    projectId: ownData(raw, "projectId") as string,
    agentId: ownData(raw, "agentId") as string,
    namespace: ownData(raw, "namespace") as string,
    visibility: ownData(raw, "visibility") as DurableJobV2Scope["visibility"],
  };
  deriveDurableJobV2ScopedDedupeKey(scope, "extract-graph-scope-validation");
  if (!sameScope(scope, expected)) throw new Error("scope mismatch");
  const context: { workspaceId?: string; sessionId?: string } = {};
  for (const key of ["workspaceId", "sessionId"] as const) {
    if (!Reflect.ownKeys(raw).includes(key)) continue;
    const value = ownData(raw, key);
    if (!isDurableJobV2SafeIdentifier(value)) throw new Error("invalid scope context");
    context[key] = value;
  }
  return Object.freeze({ scope: Object.freeze(scope), context: Object.freeze(context) });
}

function parseContext(raw: unknown): NativeExtractGraphSemanticRequest["context"] {
  if (raw === undefined) return undefined;
  if (!plainRecord(raw)) throw new Error("invalid context");
  exactKeys(raw, [], [...CONTEXT_KEYS]);
  const result: Record<string, string> = {};
  for (const key of Reflect.ownKeys(raw) as string[]) {
    const value = ownData(raw, key);
    if (!safeLabel(value)) throw new Error("invalid context value");
    result[key] = value;
  }
  return Object.freeze(result);
}

interface NativeLegacyExtractGraphContract {
  readonly mode: "legacy";
  readonly scope: DurableJobV2Scope;
  readonly context: Readonly<{ workspaceId?: string; sessionId?: string }>;
  readonly semanticRequest: NativeExtractGraphSemanticRequest;
}

interface NativeAuthoritativeExtractGraphContract {
  readonly mode: "authoritative";
  readonly scope: DurableJobV2Scope;
  readonly context: Readonly<{ workspaceId?: string; sessionId?: string }>;
  readonly semanticRequest: NativeAuthoritativeExtractGraphSemanticRequest;
}

type NativeExtractGraphContract =
  | NativeLegacyExtractGraphContract
  | NativeAuthoritativeExtractGraphContract;

function parseJob(
  job: DurableJobV2,
  context: DurableJobV2HandlerContext,
): NativeExtractGraphContract {
  assertDurableJobV2(job);
  if (job.type !== "extract_graph" || job.status !== "running" ||
      typeof job.leaseOwner !== "string" || !LEASE_OWNER.test(job.leaseOwner) ||
      job.leaseOwner !== context.workerId || typeof job.leaseToken !== "string" ||
      !LEASE_TOKEN.test(job.leaseToken) || !Number.isSafeInteger(job.leaseGeneration) ||
      job.leaseGeneration < 1 || !plainRecord(job.payload)) {
    throw new Error("invalid job");
  }
  const parsedScope = parseScope(ownData(job.payload, "scope"), job.scope);
  if (Reflect.ownKeys(job.payload).includes("graphKind")) {
    exactKeys(job.payload, ["scope", "graphKind", "activeMemoryId", "evidenceId"]);
    const graphKind = ownData(job.payload, "graphKind");
    const activeMemoryId = ownData(job.payload, "activeMemoryId");
    const evidenceId = ownData(job.payload, "evidenceId");
    const semanticRequest = Object.freeze({ graphKind, activeMemoryId, evidenceId });
    if (graphKind !== "entity" || !isDurableJobV2SafeIdentifier(activeMemoryId) ||
        !isDurableJobV2SafeIdentifier(evidenceId) ||
        job.dedupeKey !== deriveNativeAuthoritativeExtractGraphDedupeKey({
          graphKind,
          activeMemoryId,
          evidenceId,
          context: parsedScope.context,
        })) {
      throw new Error("invalid authoritative semantic request");
    }
    return Object.freeze({
      mode: "authoritative" as const,
      ...parsedScope,
      semanticRequest: semanticRequest as NativeAuthoritativeExtractGraphSemanticRequest,
    });
  }
  exactKeys(job.payload, ["scope", "chunkId", "text"], [
    "scope", "chunkId", "text", "sourceId", "context",
  ]);
  const chunkId = ownData(job.payload, "chunkId");
  const text = ownData(job.payload, "text");
  const sourceId = Reflect.ownKeys(job.payload).includes("sourceId")
    ? ownData(job.payload, "sourceId")
    : undefined;
  if (!isDurableJobV2SafeIdentifier(chunkId) || typeof text !== "string" ||
      text.trim().length === 0 || text.length > 1_000_000 ||
      (sourceId !== undefined && !isDurableJobV2SafeIdentifier(sourceId)) ||
      job.dedupeKey !== deriveDurableJobV2DomainDedupeKey(
        "extract_graph",
        chunkId,
        parsedScope.context,
      )) {
    throw new Error("invalid semantic request");
  }
  const semanticRequest = Object.freeze({
    chunkId,
    text,
    ...(sourceId === undefined ? {} : { sourceId }),
    ...(Reflect.ownKeys(job.payload).includes("context")
      ? { context: parseContext(ownData(job.payload, "context")) }
      : {}),
  }) as NativeExtractGraphSemanticRequest;
  return Object.freeze({ mode: "legacy" as const, ...parsedScope, semanticRequest });
}

function cloneJson(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("invalid JSON number");
    return value;
  }
  if (typeof value !== "object" || ancestors.has(value) || nodeUtilTypes.isProxy(value)) {
    throw new Error("invalid JSON value");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      if (Reflect.ownKeys(value).length !== value.length + 1) throw new Error("invalid JSON array");
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) throw new Error("sparse JSON array");
        result.push(cloneJson(ownData(value as unknown as Record<string, unknown>, String(index)), ancestors));
      }
      return Object.freeze(result);
    }
    if (!plainRecord(value)) throw new Error("invalid JSON object");
    const result: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw new Error("invalid JSON key");
      result[key] = cloneJson(ownData(value, key), ancestors);
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
}

function denseStringArray(raw: unknown, options: { unique?: boolean; exact?: string } = {}): readonly string[] {
  const cloned = cloneJson(raw);
  if (!Array.isArray(cloned) || cloned.some((value) => !safeLabel(value))) {
    throw new Error("invalid string array");
  }
  const values = cloned as string[];
  if (options.unique && new Set(values).size !== values.length) throw new Error("duplicate string");
  if (options.exact !== undefined &&
      (values.length === 0 || values.some((value) => value !== options.exact))) {
    throw new Error("unexpected evidence id");
  }
  return Object.freeze([...values]);
}

function denseArray(raw: unknown): readonly unknown[] {
  if (!Array.isArray(raw) || nodeUtilTypes.isProxy(raw) ||
      Reflect.ownKeys(raw).length !== raw.length + 1) {
    throw new Error("invalid dense array");
  }
  const values: unknown[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(raw, index)) throw new Error("sparse array");
    values.push(ownData(raw as unknown as Record<string, unknown>, String(index)));
  }
  return values;
}

function canonicalGraphScope(raw: unknown, expected: Record<string, unknown>) {
  if (!plainRecord(raw)) throw new Error("invalid graph scope");
  exactKeys(raw, [...Reflect.ownKeys(expected)] as string[]);
  const snapshot = cloneJson(raw) as Record<string, unknown>;
  if (JSON.stringify(snapshot) !== JSON.stringify(expected)) throw new Error("graph scope mismatch");
  return Object.freeze(snapshot);
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("invalid integer");
  return Number(value);
}

function finite(value: unknown, min = 0, max = Number.POSITIVE_INFINITY): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error("invalid number");
  }
  return value;
}

function snapshotOutput(
  raw: GraphExtractionResult,
  expectedScope: Record<string, unknown>,
  chunkId: string,
): { entities: readonly Readonly<GraphEntityRecord>[]; relations: readonly Readonly<GraphRelationRecord>[] } {
  if (!plainRecord(raw)) throw new Error("invalid graph output");
  exactKeys(raw, ["entities", "relations"]);
  const rawEntities = ownData(raw, "entities");
  const rawRelations = ownData(raw, "relations");
  const entityItems = denseArray(rawEntities);
  const relationItems = denseArray(rawRelations);
  const entityIds = new Set<string>();
  const entities = entityItems.map((rawEntity) => {
    if (!plainRecord(rawEntity)) throw new Error("invalid entity");
    exactKeys(rawEntity, [
      "id", "scope", "canonicalName", "displayName", "type", "aliases", "mentionCount",
      "mentionCount30d", "distinctSourceCount", "hotness", "queryHits30d", "status",
      "createdAt", "updatedAt", "metadata",
    ], [
      "id", "scope", "canonicalName", "displayName", "type", "aliases", "mentionCount",
      "mentionCount30d", "distinctSourceCount", "lastSeenAt", "hotness", "graphCentrality",
      "queryHits30d", "status", "mergedInto", "createdAt", "updatedAt", "metadata",
    ]);
    const id = ownData(rawEntity, "id");
    const type = ownData(rawEntity, "type");
    const canonicalName = ownData(rawEntity, "canonicalName");
    const displayName = ownData(rawEntity, "displayName");
    const status = ownData(rawEntity, "status");
    if (!isDurableJobV2SafeIdentifier(id) || entityIds.has(id) ||
        !safeLabel(canonicalName, 200) || !safeLabel(displayName, 200) ||
        !ENTITY_TYPE_SET.has(String(type)) || !ENTITY_STATUS.has(String(status))) {
      throw new Error("invalid entity identity");
    }
    entityIds.add(id);
    const entity = {
      id,
      scope: canonicalGraphScope(ownData(rawEntity, "scope"), expectedScope),
      canonicalName,
      displayName,
      type,
      aliases: denseStringArray(ownData(rawEntity, "aliases"), { unique: true }),
      mentionCount: integer(ownData(rawEntity, "mentionCount")),
      mentionCount30d: integer(ownData(rawEntity, "mentionCount30d")),
      distinctSourceCount: integer(ownData(rawEntity, "distinctSourceCount")),
      ...(Reflect.ownKeys(rawEntity).includes("lastSeenAt")
        ? { lastSeenAt: integer(ownData(rawEntity, "lastSeenAt")) }
        : {}),
      hotness: finite(ownData(rawEntity, "hotness")),
      ...(Reflect.ownKeys(rawEntity).includes("graphCentrality")
        ? { graphCentrality: finite(ownData(rawEntity, "graphCentrality")) }
        : {}),
      queryHits30d: integer(ownData(rawEntity, "queryHits30d")),
      status,
      ...(Reflect.ownKeys(rawEntity).includes("mergedInto")
        ? { mergedInto: ownData(rawEntity, "mergedInto") }
        : {}),
      createdAt: integer(ownData(rawEntity, "createdAt")),
      updatedAt: integer(ownData(rawEntity, "updatedAt")),
      metadata: cloneJson(ownData(rawEntity, "metadata")),
    } as unknown as GraphEntityRecord;
    if (entity.updatedAt < entity.createdAt ||
        (entity.mergedInto !== undefined && !isDurableJobV2SafeIdentifier(entity.mergedInto))) {
      throw new Error("invalid entity lifecycle");
    }
    return Object.freeze(entity);
  });

  const relationIds = new Set<string>();
  const relations = relationItems.map((rawRelation) => {
    if (!plainRecord(rawRelation)) throw new Error("invalid relation");
    exactKeys(rawRelation, [
      "id", "scope", "subjectId", "predicate", "objectId", "confidence",
      "evidenceChunkIds", "evidenceCount", "firstSeenAt", "lastSeenAt", "status",
      "sourceKinds", "metadata",
    ]);
    const id = ownData(rawRelation, "id");
    const subjectId = ownData(rawRelation, "subjectId");
    const objectId = ownData(rawRelation, "objectId");
    const predicate = ownData(rawRelation, "predicate");
    const status = ownData(rawRelation, "status");
    if (!isDurableJobV2SafeIdentifier(id) || relationIds.has(id) ||
        typeof subjectId !== "string" || !entityIds.has(subjectId) ||
        typeof objectId !== "string" || !entityIds.has(objectId) ||
        !PREDICATE_SET.has(String(predicate)) || !RELATION_STATUS.has(String(status))) {
      throw new Error("invalid relation identity");
    }
    relationIds.add(id);
    const evidenceChunkIds = denseStringArray(ownData(rawRelation, "evidenceChunkIds"), {
      unique: true,
      exact: chunkId,
    });
    const relation = {
      id,
      scope: canonicalGraphScope(ownData(rawRelation, "scope"), expectedScope),
      subjectId,
      predicate,
      objectId,
      confidence: finite(ownData(rawRelation, "confidence"), Number.EPSILON, 1),
      evidenceChunkIds,
      evidenceCount: integer(ownData(rawRelation, "evidenceCount")),
      firstSeenAt: integer(ownData(rawRelation, "firstSeenAt")),
      lastSeenAt: integer(ownData(rawRelation, "lastSeenAt")),
      status,
      sourceKinds: denseStringArray(ownData(rawRelation, "sourceKinds"), { unique: true }),
      metadata: cloneJson(ownData(rawRelation, "metadata")),
    } as unknown as GraphRelationRecord;
    if (relation.evidenceCount !== evidenceChunkIds.length || relation.lastSeenAt < relation.firstSeenAt) {
      throw new Error("invalid relation lifecycle");
    }
    return Object.freeze(relation);
  });
  return Object.freeze({ entities: Object.freeze(entities), relations: Object.freeze(relations) });
}

function mapEffectError(error: unknown): DurableJobV2HandlerFailure {
  if (error instanceof PostgresDurableJobV2EffectError) {
    return failure(
      error.retryable ? "EXTRACT_GRAPH_EFFECT_RETRYABLE" : "EXTRACT_GRAPH_EFFECT_REJECTED",
      error.retryable,
    );
  }
  return failure("EXTRACT_GRAPH_EFFECT_RETRYABLE", true);
}

function snapshotLegacySummary(
  effect: Exclude<PostgresDurableJobV2EffectResult<NativeExtractGraphEffectSummary>, { status: "stale" }>,
  job: DurableJobV2,
  output: ReturnType<typeof snapshotOutput>,
): NativeExtractGraphHandlerResult {
  const receipt = effect.receipt;
  if (!plainRecord(receipt) || receipt.jobId !== job.id || receipt.effectKey !== EFFECT_KEY ||
      !SHA256.test(receipt.requestFingerprint) || !Number.isSafeInteger(receipt.leaseGeneration) ||
      receipt.leaseGeneration < 1 || receipt.leaseGeneration > job.leaseGeneration ||
      !Number.isSafeInteger(receipt.committedAt) || receipt.committedAt < 0 ||
      !plainRecord(receipt.result)) {
    throw failure("EXTRACT_GRAPH_EFFECT_REJECTED", false);
  }
  exactKeys(receipt.result, ["createdEntities", "createdRelations", "entityIds", "relationIds"]);
  const entityIds = denseStringArray(receipt.result.entityIds, { unique: true });
  const relationIds = denseStringArray(receipt.result.relationIds, { unique: true });
  const expectedEntityIds = output.entities.map((entity) => entity.id);
  const expectedRelationIds = output.relations.map((relation) => relation.id);
  if (effect.status === "applied" &&
      (JSON.stringify(entityIds) !== JSON.stringify(expectedEntityIds) ||
        JSON.stringify(relationIds) !== JSON.stringify(expectedRelationIds))) {
    throw failure("EXTRACT_GRAPH_EFFECT_REJECTED", false);
  }
  const createdEntities = integer(receipt.result.createdEntities);
  const createdRelations = integer(receipt.result.createdRelations);
  if (createdEntities > entityIds.length || createdRelations > relationIds.length) {
    throw failure("EXTRACT_GRAPH_EFFECT_REJECTED", false);
  }
  return Object.freeze({
    status: effect.status,
    createdEntities,
    createdRelations,
    entityIds,
    relationIds,
  });
}

function snapshotAuthoritativeFact(
  raw: AuthoritativeEntityGraphReadFact,
  contract: NativeAuthoritativeExtractGraphContract,
): AuthoritativeEntityGraphReadFact {
  const fullScope = Object.freeze({ ...contract.scope, ...contract.context });
  if (!raw || raw.authority !== "persisted_active_memory_evidence" ||
      raw.graphKind !== "entity" ||
      raw.activeMemoryId !== contract.semanticRequest.activeMemoryId ||
      typeof raw.activeText !== "string" || raw.activeText.trim().length === 0 ||
      !raw.evidence || raw.evidence.authority !== "persisted_evidence" ||
      raw.evidence.evidenceId !== contract.semanticRequest.evidenceId ||
      typeof raw.evidence.text !== "string" || raw.evidence.text.trim().length === 0 ||
      !isDurableJobV2SafeIdentifier(raw.evidence.sourceId) ||
      !safeLabel(raw.evidence.sourceKind) ||
      !Number.isSafeInteger(raw.evidence.createdAt) || raw.evidence.createdAt < 0) {
    throw new Error("authoritative graph fact identity mismatch");
  }
  try {
    if (authorityScopeFingerprint(raw.evidence.scope) !== authorityScopeFingerprint(fullScope)) {
      throw new Error("authoritative graph fact scope mismatch");
    }
  } catch {
    throw new Error("authoritative graph fact scope mismatch");
  }
  return Object.freeze({
    authority: "persisted_active_memory_evidence",
    graphKind: "entity",
    activeMemoryId: raw.activeMemoryId,
    activeText: raw.activeText,
    evidence: Object.freeze({
      authority: "persisted_evidence",
      evidenceId: raw.evidence.evidenceId,
      scope: Object.freeze({ ...raw.evidence.scope }),
      text: raw.evidence.text,
      sourceId: raw.evidence.sourceId,
      sourceKind: raw.evidence.sourceKind,
      createdAt: raw.evidence.createdAt,
    }),
  });
}

function snapshotAuthoritativeSummary(
  effect: Exclude<PostgresDurableJobV2EffectResult<NativeExtractGraphEffectSummary>, { status: "stale" }>,
  job: DurableJobV2,
  contract: NativeAuthoritativeExtractGraphContract,
  graph: AuthoritativeEntityGraphDerivation,
): Readonly<{
  result: NativeExtractGraphHandlerResult;
  committedAt: number;
}> {
  const receipt = effect.receipt;
  if (!plainRecord(receipt) || receipt.jobId !== job.id || receipt.effectKey !== EFFECT_KEY ||
      !SHA256.test(receipt.requestFingerprint) || !Number.isSafeInteger(receipt.leaseGeneration) ||
      receipt.leaseGeneration < 1 || receipt.leaseGeneration > job.leaseGeneration ||
      !Number.isSafeInteger(receipt.committedAt) || receipt.committedAt < 0 ||
      !plainRecord(receipt.result)) {
    throw failure("EXTRACT_GRAPH_EFFECT_REJECTED", false);
  }
  try {
    exactKeys(receipt.result, [
      "createdEntities", "createdRelations", "entityIds", "relationIds", "evidenceId",
      "memoryEvidenceLinks", "entityEvidenceLinks", "relationEvidenceLinks", "aliasProjections",
    ]);
  } catch {
    throw failure("EXTRACT_GRAPH_EFFECT_REJECTED", false);
  }
  const entityIds = denseStringArray(receipt.result.entityIds, { unique: true });
  const relationIds = denseStringArray(receipt.result.relationIds, { unique: true });
  const createdEntities = integer(receipt.result.createdEntities);
  const createdRelations = integer(receipt.result.createdRelations);
  const memoryEvidenceLinks = integer(receipt.result.memoryEvidenceLinks);
  const entityEvidenceLinks = integer(receipt.result.entityEvidenceLinks);
  const relationEvidenceLinks = integer(receipt.result.relationEvidenceLinks);
  const aliasProjections = integer(receipt.result.aliasProjections);
  if (receipt.result.evidenceId !== contract.semanticRequest.evidenceId ||
      graph.evidenceId !== contract.semanticRequest.evidenceId ||
      graph.memoryId !== contract.semanticRequest.activeMemoryId ||
      createdEntities > entityIds.length || createdRelations > relationIds.length ||
      memoryEvidenceLinks > 1 || entityEvidenceLinks > entityIds.length ||
      relationEvidenceLinks > relationIds.length) {
    throw failure("EXTRACT_GRAPH_EFFECT_REJECTED", false);
  }
  const maximumRelatedRelations = graph.entities.length;
  if (effect.status === "applied" && (
    entityIds.length > graph.entities.length ||
    relationIds.length > graph.relations.length + maximumRelatedRelations ||
    entityEvidenceLinks > graph.entityEvidenceLinks.length ||
    relationEvidenceLinks > graph.relationEvidenceLinks.length + maximumRelatedRelations ||
    aliasProjections > graph.aliasProjections.length
  )) {
    throw failure("EXTRACT_GRAPH_EFFECT_REJECTED", false);
  }
  return Object.freeze({
    committedAt: receipt.committedAt,
    result: Object.freeze({
      status: effect.status,
      createdEntities,
      createdRelations,
      entityIds,
      relationIds,
      evidenceId: contract.semanticRequest.evidenceId,
      memoryEvidenceLinks,
      entityEvidenceLinks,
      relationEvidenceLinks,
      aliasProjections,
    }),
  });
}

function snapshotAuthoritativeReplaySummary(
  effect: Extract<
    PostgresDurableJobV2EffectReplayInspection<NativeExtractGraphEffectSummary>,
    { status: "replayed" }
  >,
  job: DurableJobV2,
  contract: NativeAuthoritativeExtractGraphContract,
): Readonly<{ result: NativeExtractGraphHandlerResult; committedAt: number }> {
  const receipt = effect.receipt;
  if (!plainRecord(receipt) || receipt.jobId !== job.id || receipt.effectKey !== EFFECT_KEY ||
      !SHA256.test(receipt.requestFingerprint) || !Number.isSafeInteger(receipt.leaseGeneration) ||
      receipt.leaseGeneration < 1 || receipt.leaseGeneration > job.leaseGeneration ||
      !Number.isSafeInteger(receipt.committedAt) || receipt.committedAt < 0 ||
      !plainRecord(receipt.result)) {
    throw failure("EXTRACT_GRAPH_EFFECT_REJECTED", false);
  }
  try {
    exactKeys(receipt.result, [
      "createdEntities", "createdRelations", "entityIds", "relationIds", "evidenceId",
      "memoryEvidenceLinks", "entityEvidenceLinks", "relationEvidenceLinks", "aliasProjections",
    ]);
  } catch {
    throw failure("EXTRACT_GRAPH_EFFECT_REJECTED", false);
  }
  const entityIds = denseStringArray(receipt.result.entityIds, { unique: true });
  const relationIds = denseStringArray(receipt.result.relationIds, { unique: true });
  const createdEntities = integer(receipt.result.createdEntities);
  const createdRelations = integer(receipt.result.createdRelations);
  const memoryEvidenceLinks = integer(receipt.result.memoryEvidenceLinks);
  const entityEvidenceLinks = integer(receipt.result.entityEvidenceLinks);
  const relationEvidenceLinks = integer(receipt.result.relationEvidenceLinks);
  const aliasProjections = integer(receipt.result.aliasProjections);
  if (receipt.result.evidenceId !== contract.semanticRequest.evidenceId ||
      createdEntities > entityIds.length || createdRelations > relationIds.length ||
      memoryEvidenceLinks > 1 || entityEvidenceLinks > entityIds.length ||
      relationEvidenceLinks > relationIds.length) {
    throw failure("EXTRACT_GRAPH_EFFECT_REJECTED", false);
  }
  return Object.freeze({
    committedAt: receipt.committedAt,
    result: Object.freeze({
      status: "replayed" as const,
      createdEntities,
      createdRelations,
      entityIds,
      relationIds,
      evidenceId: contract.semanticRequest.evidenceId,
      memoryEvidenceLinks,
      entityEvidenceLinks,
      relationEvidenceLinks,
      aliasProjections,
    }),
  });
}

export function createNativeExtractGraphHandler(
  dependencies: NativeExtractGraphHandlerDependencies,
): DurableJobV2Handler {
  const port = dependencies?.effectPort;
  const llmClient = dependencies?.llmClient;
  const authoritativeRead = dependencies?.authoritativeRead;
  const canonicalEntityCentrality = dependencies?.canonicalEntityCentrality;
  const canonicalEntityTopicRead = dependencies?.canonicalEntityTopicRead;
  const topicTreeAliases = dependencies?.topicTreeAliases;
  const enqueueTopicTarget = dependencies?.enqueueTopicTarget;
  const prepareEntityEmbeddings = dependencies?.prepareEntityEmbeddings;
  const topicProjectionCount = [
    canonicalEntityCentrality, canonicalEntityTopicRead, topicTreeAliases, enqueueTopicTarget,
  ].filter((value) => value !== undefined).length;
  if (!plainRecord(port) || port.contract !== "mengshu.postgres-graph-effect/v1" ||
      typeof port.executeGraphEffect !== "function" || !llmClient ||
      (port.inspectAuthoritativeGraphReplay !== undefined &&
        typeof port.inspectAuthoritativeGraphReplay !== "function") ||
      typeof llmClient !== "object" || typeof llmClient.extractStructured !== "function" ||
      typeof llmClient.available !== "boolean" ||
      (authoritativeRead !== undefined && typeof authoritativeRead.read !== "function") ||
      topicProjectionCount !== 0 && topicProjectionCount !== 4 ||
      (canonicalEntityCentrality !== undefined &&
        typeof canonicalEntityCentrality.refresh !== "function") ||
      (canonicalEntityTopicRead !== undefined && typeof canonicalEntityTopicRead.read !== "function") ||
      (topicTreeAliases !== undefined && typeof topicTreeAliases.persist !== "function") ||
      (enqueueTopicTarget !== undefined && typeof enqueueTopicTarget !== "function") ||
      (dependencies.authoritativeOnly !== undefined &&
        typeof dependencies.authoritativeOnly !== "boolean") ||
      (prepareEntityEmbeddings !== undefined && typeof prepareEntityEmbeddings !== "function") ||
      (dependencies.compute !== undefined && typeof dependencies.compute !== "function")) {
    throw new Error("Native extract_graph dependencies or effect port are invalid");
  }
  const executeGraphEffect = port.executeGraphEffect.bind(port);
  const inspectAuthoritativeGraphReplay = port.inspectAuthoritativeGraphReplay?.bind(port);
  const compute = dependencies.compute ?? ((input: Parameters<typeof extractGraphWithLlm>[0]) =>
    extractGraphWithLlm(input, { llmClient }));
  const projectAuthoritativeTopics = async (
    verified: Readonly<{ result: NativeExtractGraphHandlerResult; committedAt: number }>,
    contract: NativeAuthoritativeExtractGraphContract,
    graphScope: Parameters<CanonicalEntityCentralityRefreshPort["refresh"]>[0]["scope"],
    context: DurableJobV2HandlerContext,
  ): Promise<NativeExtractGraphHandlerResult> => {
    if (!canonicalEntityCentrality || !canonicalEntityTopicRead || !topicTreeAliases ||
        !enqueueTopicTarget) {
      return verified.result;
    }
    try {
      await canonicalEntityCentrality.refresh({
        scope: graphScope,
        now: verified.committedAt,
        signal: context.signal,
      });
      throwIfAborted(context.signal);
      const facts = await canonicalEntityTopicRead.read({
        graphKind: "entity",
        activeMemoryId: contract.semanticRequest.activeMemoryId,
        evidenceId: contract.semanticRequest.evidenceId,
        receiptEntityIds: verified.result.entityIds,
        scope: graphScope,
        signal: context.signal,
      });
      throwIfAborted(context.signal);
      const projection = planCanonicalEntityTopicFanOut({
        ...facts,
        graphReceipt: {
          status: verified.result.status,
          entityIds: verified.result.entityIds,
          relationIds: verified.result.relationIds,
          evidenceId: contract.semanticRequest.evidenceId,
        },
        now: verified.committedAt,
      });
      if (projection.topicEntityIds.length > 0) {
        await topicTreeAliases.persist({
          scope: facts.memory.scope,
          entities: projection.topicEntityIds.map((entityId, index) => Object.freeze({
            entityId,
            canonicalName: projection.topicLabels[index]!,
          })),
          now: verified.committedAt,
        });
        throwIfAborted(context.signal);
      }
      const topicJobIds: string[] = [];
      for (const target of projection.topicTargets) {
        throwIfAborted(context.signal);
        const jobId = await enqueueTopicTarget({
          scope: facts.memory.scope,
          leaf: {
            id: facts.memory.memoryId,
            scope: facts.memory.scope,
            chunkId: facts.memory.evidenceId,
            sourceId: facts.memory.sourceId,
            entityIds: [...facts.memory.entityIds],
            importance: facts.memory.routing.importance,
            eventAt: facts.memory.eventAt,
            createdAt: facts.memory.createdAt,
            text: facts.memory.text,
          },
          routing: {
            ...facts.memory.routing,
            topicLabels: projection.topicLabels,
            topicHotnessEligible: projection.topicLabels.length > 0,
          },
        }, target, context.signal);
        if (!isDurableJobV2SafeIdentifier(jobId)) {
          throw new Error("topic target enqueue returned invalid job identity");
        }
        topicJobIds.push(jobId);
      }
      return Object.freeze({
        ...verified.result,
        topicTargetCount: projection.topicTargets.length,
        topicJobIds: Object.freeze(topicJobIds),
      });
    } catch (error) {
      if (isAbortError(error) || context.signal.aborted) throw abortError(context.signal);
      throw failure("EXTRACT_GRAPH_TOPIC_PROJECTION_RETRYABLE", true);
    }
  };

  return async (job: DurableJobV2, context: DurableJobV2HandlerContext) => {
    throwIfAborted(context.signal);
    let contract: ReturnType<typeof parseJob>;
    try {
      contract = parseJob(job, context);
      if (dependencies.authoritativeOnly === true && contract.mode !== "authoritative") {
        throw new Error("legacy graph job is disabled");
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw failure("EXTRACT_GRAPH_INVALID_JOB", false);
    }

    const graphScope = Object.freeze({ ...job.scope, ...contract.context });
    if (contract.mode === "authoritative") {
      if (!authoritativeRead) {
        throw failure("EXTRACT_GRAPH_AUTHORITY_UNAVAILABLE", true);
      }
      if (inspectAuthoritativeGraphReplay) {
        let replay: PostgresDurableJobV2EffectReplayInspection<NativeExtractGraphEffectSummary>;
        try {
          replay = await inspectAuthoritativeGraphReplay(Object.freeze({
            effectInput: Object.freeze({
              id: job.id,
              scope: Object.freeze({ ...job.scope }),
              owner: job.leaseOwner!,
              leaseToken: job.leaseToken!,
              leaseGeneration: job.leaseGeneration,
            }),
            context: contract.context,
            semanticRequest: contract.semanticRequest,
          }));
        } catch (error) {
          if (error instanceof DurableJobV2HandlerFailure) throw error;
          throw mapEffectError(error);
        }
        if (replay.status === "stale") throw failure("EXTRACT_GRAPH_EFFECT_STALE", true);
        if (replay.status === "replayed") {
          return projectAuthoritativeTopics(
            snapshotAuthoritativeReplaySummary(replay, job, contract),
            contract,
            graphScope,
            context,
          );
        }
      }
      let fact: AuthoritativeEntityGraphReadFact;
      try {
        fact = snapshotAuthoritativeFact(await authoritativeRead.read({
          graphKind: "entity",
          activeMemoryId: contract.semanticRequest.activeMemoryId,
          evidenceId: contract.semanticRequest.evidenceId,
          scope: graphScope,
          signal: context.signal,
        }), contract);
        throwIfAborted(context.signal);
      } catch (error) {
        if (isAbortError(error) || context.signal.aborted) throw abortError(context.signal);
        throw failure("EXTRACT_GRAPH_AUTHORITY_UNAVAILABLE", true);
      }

      let computed: GraphExtractionResult;
      try {
        computed = await compute({
          scope: graphScope,
          chunkId: fact.evidence.evidenceId,
          text: fact.evidence.text,
          sourceId: fact.evidence.sourceId,
          createdAt: fact.evidence.createdAt,
          metadata: {},
        }, context.signal);
        throwIfAborted(context.signal);
      } catch (error) {
        if (isAbortError(error) || context.signal.aborted) throw abortError(context.signal);
        throw failure("EXTRACT_GRAPH_COMPUTATION_FAILED", true);
      }

      let graph: AuthoritativeEntityGraphDerivation;
      try {
        const output = snapshotOutput(
          computed,
          graphScope,
          fact.evidence.evidenceId,
        );
        graph = deriveAuthoritativeEntityGraph({
          graphKind: "entity",
          memoryId: fact.activeMemoryId,
          evidence: fact.evidence,
          extraction: output,
        });
      } catch {
        throw failure("EXTRACT_GRAPH_OUTPUT_INVALID", false);
      }
      throwIfAborted(context.signal);

      if (!prepareEntityEmbeddings) {
        throw failure("EXTRACT_GRAPH_EMBEDDING_UNAVAILABLE", true);
      }
      let entityEmbeddings: EntityGraphEmbeddingBatch;
      try {
        entityEmbeddings = await prepareEntityEmbeddings(graph.entities, context.signal);
        throwIfAborted(context.signal);
      } catch (error) {
        if (isAbortError(error) || context.signal.aborted) throw abortError(context.signal);
        throw failure("EXTRACT_GRAPH_EMBEDDING_FAILED", true);
      }

      let effect: PostgresDurableJobV2EffectResult<NativeExtractGraphEffectSummary>;
      try {
        effect = await executeGraphEffect(Object.freeze({
          effectInput: Object.freeze({
            id: job.id,
            scope: Object.freeze({ ...job.scope }),
            owner: job.leaseOwner!,
            leaseToken: job.leaseToken!,
            leaseGeneration: job.leaseGeneration,
          }),
          context: contract.context,
          semanticRequest: contract.semanticRequest,
          graph,
          entityEmbeddings,
        }));
      } catch (error) {
        if (error instanceof DurableJobV2HandlerFailure) throw error;
        throw mapEffectError(error);
      }
      if (effect.status === "stale") throw failure("EXTRACT_GRAPH_EFFECT_STALE", true);
      const verified = snapshotAuthoritativeSummary(effect, job, contract, graph);
      return projectAuthoritativeTopics(verified, contract, graphScope, context);
    }

    let computed: GraphExtractionResult;
    try {
      computed = await compute({
        scope: graphScope,
        chunkId: contract.semanticRequest.chunkId,
        text: contract.semanticRequest.text,
        ...(contract.semanticRequest.sourceId === undefined
          ? {}
          : { sourceId: contract.semanticRequest.sourceId }),
        createdAt: job.createdAt,
        ...(contract.semanticRequest.context === undefined
          ? {}
          : { context: contract.semanticRequest.context }),
        metadata: {},
      }, context.signal);
      throwIfAborted(context.signal);
    } catch (error) {
      if (isAbortError(error) || context.signal.aborted) throw abortError(context.signal);
      throw failure("EXTRACT_GRAPH_COMPUTATION_FAILED", true);
    }

    let output: ReturnType<typeof snapshotOutput>;
    try {
      output = snapshotOutput(computed, graphScope, contract.semanticRequest.chunkId);
    } catch {
      throw failure("EXTRACT_GRAPH_OUTPUT_INVALID", false);
    }
    throwIfAborted(context.signal);

    try {
      const effect = await executeGraphEffect(Object.freeze({
        effectInput: Object.freeze({
          id: job.id,
          scope: Object.freeze({ ...job.scope }),
          owner: job.leaseOwner!,
          leaseToken: job.leaseToken!,
          leaseGeneration: job.leaseGeneration,
        }),
        context: contract.context,
        semanticRequest: contract.semanticRequest,
        entities: output.entities,
        relations: output.relations,
      }));
      if (effect.status === "stale") throw failure("EXTRACT_GRAPH_EFFECT_STALE", true);
      return snapshotLegacySummary(effect, job, output);
    } catch (error) {
      if (error instanceof DurableJobV2HandlerFailure) throw error;
      throw mapEffectError(error);
    }
  };
}

/** Production composition path：graph effect 只能来自 provider-owned runtime bundle。 */
export function createProviderOwnedNativeExtractGraphHandler(
  dependencies: ProviderOwnedNativeExtractGraphHandlerDependencies,
): DurableJobV2Handler {
  const bundle = assertProviderOwnedPostgresDurableJobV2RuntimeBundle(
    dependencies?.runtimeBundle,
  );
  const effectPort: NativeExtractGraphEffectPort = Object.freeze({
    contract: "mengshu.postgres-graph-effect/v1" as const,
    executeGraphEffect: (request: NativeExtractGraphEffectRequest) =>
      bundle.executeGraphEffect(request),
    inspectAuthoritativeGraphReplay: (request: PostgresAuthoritativeExtractGraphReplayRequest) =>
      bundle.inspectAuthoritativeGraphReplay(request) as Promise<
        PostgresDurableJobV2EffectReplayInspection<NativeExtractGraphEffectSummary>
      >,
  });
  const queueScope = (scope: TreeFanOutInput["scope"]): DurableJobV2Scope => Object.freeze({
    tenantId: scope.tenantId,
    userId: scope.userId,
    appId: scope.appId,
    projectId: scope.projectId,
    agentId: scope.agentId,
    namespace: scope.namespace,
    visibility: scope.visibility as DurableJobV2Scope["visibility"],
  });
  const topicJobId = (idempotencyKey: string): string => {
    const digest = createHash("sha256")
      .update("mengshu.active-memory-tree-job/v1\0")
      .update(idempotencyKey)
      .digest("hex");
    return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-` +
      `8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  };
  return createNativeExtractGraphHandler({
    effectPort,
    llmClient: dependencies.llmClient,
    authoritativeRead: dependencies.authoritativeRead,
    prepareEntityEmbeddings: dependencies.prepareEntityEmbeddings,
    canonicalEntityCentrality: {
      refresh: (input) => bundle.refreshCanonicalEntityCentrality(input),
    },
    canonicalEntityTopicRead: {
      read: (input) => bundle.readCanonicalEntityTopicFacts(input),
    },
    topicTreeAliases: {
      persist: (input) => bundle.persistTopicTreeAliases(input),
    },
    enqueueTopicTarget: async (input, target, signal) => {
      if (signal.aborted) throw abortError(signal);
      const context = Object.freeze({
        ...(input.scope.workspaceId === undefined ? {} : { workspaceId: input.scope.workspaceId }),
        ...(input.scope.sessionId === undefined ? {} : { sessionId: input.scope.sessionId }),
      });
      const dedupeKey = deriveDurableJobV2DomainDedupeKey(
        "build_tree",
        target.idempotencyKey,
        context,
      );
      const enqueued = await bundle.repository.enqueue({
        id: topicJobId(target.idempotencyKey),
        type: "build_tree",
        payload: {
          scope: { ...queueScope(input.scope), ...context },
          traceId: input.leaf.id,
          treeType: target.treeType,
          treeKey: target.treeKey,
          leaf: {
            id: input.leaf.id,
            chunkId: input.leaf.chunkId,
            sourceId: input.leaf.sourceId,
            entityIds: [...input.leaf.entityIds],
            text: input.leaf.text,
            eventAt: input.leaf.eventAt,
          },
          routing: {
            ...input.routing,
            riskFlags: [...input.routing.riskFlags],
            topicLabels: [...(input.routing.topicLabels ?? [])],
          },
          targetIdempotencyKey: target.idempotencyKey,
        },
        dedupeKey,
        scope: queueScope(input.scope),
        maxAttempts: 3,
      });
      if (signal.aborted) throw abortError(signal);
      if (enqueued.type !== "build_tree" || enqueued.dedupeKey !== dedupeKey) {
        throw new Error("topic target enqueue result is invalid");
      }
      return enqueued.id;
    },
    authoritativeOnly: true,
    ...(dependencies.compute === undefined ? {} : { compute: dependencies.compute }),
  });
}
