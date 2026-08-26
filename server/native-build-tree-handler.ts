import { types as nodeUtilTypes } from "node:util";

import {
  assertProviderOwnedPostgresDurableJobV2RuntimeBundle,
  type PostgresDurableJobV2RuntimeBundle,
} from "../packages/core/src/db/providers/postgres.js";
import { PostgresDurableJobV2EffectError } from
  "../packages/core/src/storage/repositories/postgres-job-v2-effect.js";

import { bufferId } from "../packages/core/src/tree/buffer.js";
import { PostgresTreeFinalizeError } from
  "../packages/core/src/tree/postgres-build-tree-effect.js";
import {
  planTreeFanOut,
  type TreeFanOutRoutingInput,
} from "../packages/core/src/tree/tree-fan-out.js";
import type { MemoryTreeType, TreeLeaf } from "../packages/core/src/tree/types.js";
import {
  DURABLE_JOB_V2_SAFE_IDENTIFIER_MAX_LENGTH,
  isDurableJobV2SafeIdentifier,
  deriveDurableJobV2DomainDedupeKey,
  type DurableJobV2,
  type DurableJobV2Scope,
} from "../packages/core/src/storage/repositories/job-v2.js";
import {
  DurableJobV2HandlerFailure,
  type DurableJobV2Handler,
  type DurableJobV2HandlerContext,
  type DurableJobV2FencedInput,
} from "./workers-v2.js";

export const BUILD_TREE_EFFECT_KEY = "build_tree.persist.v1" as const;
export const BUILD_TREE_CONTRACT_VERSION = 1 as const;
const BUILD_TREE_DEDUPE_PREFIX = "build_tree:" as const;
const MAX_TRACE_ID_LENGTH =
  DURABLE_JOB_V2_SAFE_IDENTIFIER_MAX_LENGTH;

export interface NativeBuildTreeContext {
  readonly workspaceId?: string;
  readonly sessionId?: string;
}

export interface NativeAppendTreeSemanticRequest {
  readonly type: "build_tree";
  readonly version: typeof BUILD_TREE_CONTRACT_VERSION;
  readonly traceId: string;
  readonly context: NativeBuildTreeContext;
  readonly treeType: MemoryTreeType;
  readonly treeKey: string;
  readonly level: 0;
  readonly policy: {
    readonly maxLeafCount: 20;
    readonly maxTokenCount: 6000;
  };
  readonly leaf: Readonly<TreeLeaf>;
  readonly expectedBufferId: string;
}

export interface NativeFinalizeTreeSemanticRequest {
  readonly type: "finalize_tree_buffer";
  readonly version: typeof BUILD_TREE_CONTRACT_VERSION;
  readonly traceId: string;
  readonly context: NativeBuildTreeContext;
  readonly treeType: Exclude<MemoryTreeType, "global">;
  readonly treeKey: string;
  readonly level: 0;
  readonly finalizeMode: "history_rebuild";
  readonly expectedBufferId: string;
}

export type NativeBuildTreeSemanticRequest =
  | NativeAppendTreeSemanticRequest
  | NativeFinalizeTreeSemanticRequest;

export interface NativeBuildTreeEffectRequest {
  readonly effectKey: typeof BUILD_TREE_EFFECT_KEY;
  readonly effectInput: DurableJobV2FencedInput;
  readonly semanticRequest: NativeBuildTreeSemanticRequest;
}

export interface NativeBuildTreeEffectResult {
  readonly leafId: string;
  readonly sealed: boolean;
  readonly bufferId: string | null;
  readonly nodeId: string | null;
  /** Optional only at the provider boundary for replaying pre-folding v1 receipts. */
  readonly foldedNodeIds?: readonly string[];
}

export type NativeBuildTreeEffectOutcome =
  | { readonly status: "stale" }
  | {
      readonly status: "applied" | "replayed";
      readonly receipt: { readonly result: NativeBuildTreeEffectResult };
    };

/**
 * Provider 后续需要实现的最小原子端口。
 *
 * 单次调用必须在同一 provider transaction 内完成：
 * 1. 校验 durable-v2 job scope + owner/token/generation fence；
 * 2. 以固定 effectKey + semantic request fingerprint 查询/校验 receipt；
 * 3. 原子 upsert leaf、合并同 scope/treeType/treeKey/level buffer；
 * 4. 达到固定 policy 时 seal summary 并删除 buffer；
 * 5. 写 receipt 后 commit；重复请求返回 replayed，lease 失效返回 stale。
 *
 * AbortSignal 只允许在 transaction 开始前取消，或由实现 rollback 后抛 AbortError；
 * 不得在 outcome 已不确定时把取消伪装成安全回滚。
 */
export interface NativeBuildTreeEffectPort {
  executeBuildTreeEffect(
    request: NativeBuildTreeEffectRequest,
    signal: AbortSignal,
  ): Promise<NativeBuildTreeEffectOutcome>;
}

export type NativeBuildTreeEffectErrorCode =
  | "BUILD_TREE_EFFECT_OUTCOME_UNCERTAIN"
  | "BUILD_TREE_EFFECT_LEASE_LOST"
  | "BUILD_TREE_EFFECT_FINGERPRINT_MISMATCH"
  | "BUILD_TREE_EFFECT_INVALID_RECEIPT";

/** Provider 可用的固定 typed error；构造参数中的底层消息故意不保存。 */
export class NativeBuildTreeEffectError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: NativeBuildTreeEffectErrorCode,
    _unsafeProviderMessage?: string,
  ) {
    super("Native build_tree effect failed");
    this.name = "NativeBuildTreeEffectError";
    this.retryable = code === "BUILD_TREE_EFFECT_OUTCOME_UNCERTAIN" ||
      code === "BUILD_TREE_EFFECT_LEASE_LOST";
  }
}

export interface NativeBuildTreeHandlerDependencies {
  readonly effectPort: NativeBuildTreeEffectPort;
}

export interface ProviderOwnedNativeBuildTreeHandlerDependencies {
  readonly runtimeBundle: PostgresDurableJobV2RuntimeBundle;
}

export interface NativeBuildTreeHandlerResult extends NativeBuildTreeEffectResult {
  readonly status: "applied" | "replayed";
  readonly foldedNodeIds: readonly string[];
}

const JOB_REQUIRED = Object.freeze([
  "id", "type", "payload", "scope", "dedupeKey", "scopedDedupeKey", "status",
  "attempts", "leaseGeneration", "maxAttempts", "createdAt", "updatedAt",
] as const);
const JOB_OPTIONAL = Object.freeze([
  "nextAttemptAt", "leaseOwner", "leaseToken", "leaseUntil", "heartbeatAt", "lastError",
] as const);
const PAYLOAD_REQUIRED = Object.freeze([
  "scope", "traceId", "treeType", "treeKey",
] as const);
const PAYLOAD_OPTIONAL = Object.freeze([
  "leaf", "routing", "targetIdempotencyKey", "finalize",
] as const);
const SCOPE_REQUIRED = Object.freeze([
  "tenantId", "userId", "appId", "projectId", "agentId", "namespace", "visibility",
] as const);
const CONTEXT_OPTIONAL = Object.freeze(["workspaceId", "sessionId"] as const);
const LEAF_REQUIRED = Object.freeze(["id", "chunkId", "sourceId", "text", "eventAt"] as const);
const LEAF_OPTIONAL = Object.freeze(["entityIds"] as const);
const ROUTING_REQUIRED = Object.freeze([
  "valueScore", "importance", "semanticType", "scopeVisibility", "riskFlags",
  "topicHotnessEligible",
] as const);
const ROUTING_OPTIONAL = Object.freeze([
  "topicLabels", "explicitGlobal", "isWorkspaceRule", "globalHotnessEligible",
] as const);
const FINALIZE_REQUIRED = Object.freeze(["mode", "expectedBufferId"] as const);
const LEASE_OWNER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const LEASE_TOKEN = /^[A-Za-z0-9._~-]{32,256}$/;
const UNSAFE_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
const UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const VISIBILITIES = new Set(["private", "workspace", "team", "public"]);
const TREE_TYPES = new Set<MemoryTreeType>(["source", "topic", "global"]);
const SEMANTIC_TYPES = new Set(["profile", "task_context", "rules", "experience", "resource"]);
const SCOPE_VISIBILITIES = new Set([
  "session", "project", "workspace", "app", "user", "global",
]);
const MAX_TEXT_LENGTH = 100_000;

function handlerFailure(code: string, retryable: boolean): DurableJobV2HandlerFailure {
  return new DurableJobV2HandlerFailure(code, retryable);
}

function invalidJob(): never {
  throw handlerFailure("BUILD_TREE_INVALID_JOB", false);
}

function exactDataRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    invalidJob();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalidJob();
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (keys.length < required.length ||
      keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
      required.some((key) => !keys.includes(key))) invalidJob();
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor) || descriptor.value === undefined) {
      invalidJob();
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function snapshotEffectPort(value: unknown): NativeBuildTreeEffectPort {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("Native build_tree effect port is invalid");
  }
  const keys = Reflect.ownKeys(value);
  const descriptor = Object.getOwnPropertyDescriptor(value, "executeBuildTreeEffect");
  if (keys.length !== 1 || !descriptor?.enumerable || !("value" in descriptor) ||
      typeof descriptor.value !== "function") {
    throw new Error("Native build_tree effect port is invalid");
  }
  const execute = descriptor.value as NativeBuildTreeEffectPort["executeBuildTreeEffect"];
  return Object.freeze({
    executeBuildTreeEffect: (
      request: NativeBuildTreeEffectRequest,
      signal: AbortSignal,
    ) => Reflect.apply(execute, value, [request, signal]),
  });
}

function safeId(value: unknown): value is string {
  return isDurableJobV2SafeIdentifier(value);
}

function safeText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    value.length <= MAX_TEXT_LENGTH && !UNSAFE_TEXT.test(value) &&
    !UNPAIRED_SURROGATE.test(value);
}

function safeTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function safeScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function snapshotStringArray(value: unknown, allowEmpty: boolean): readonly string[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Array.prototype) invalidJob();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) invalidJob();
  const snapshot: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    if (!keys.includes(key)) invalidJob();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor) ||
        !safeText(descriptor.value)) invalidJob();
    snapshot.push(descriptor.value);
  }
  if (!allowEmpty && snapshot.length === 0) invalidJob();
  return Object.freeze(snapshot);
}

function snapshotIdArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Array.prototype) invalidJob();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) invalidJob();
  const ids: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor) ||
        !safeId(descriptor.value) || seen.has(descriptor.value)) invalidJob();
    seen.add(descriptor.value);
    ids.push(descriptor.value);
  }
  return Object.freeze(ids);
}

function snapshotRouting(value: unknown): TreeFanOutRoutingInput {
  const raw = exactDataRecord(value, ROUTING_REQUIRED, ROUTING_OPTIONAL);
  if (!safeScore(raw.valueScore) || !safeScore(raw.importance) ||
      typeof raw.semanticType !== "string" || !SEMANTIC_TYPES.has(raw.semanticType) ||
      typeof raw.scopeVisibility !== "string" ||
      !SCOPE_VISIBILITIES.has(raw.scopeVisibility) ||
      typeof raw.topicHotnessEligible !== "boolean") invalidJob();
  for (const field of [
    "explicitGlobal", "isWorkspaceRule", "globalHotnessEligible",
  ] as const) {
    if (Object.hasOwn(raw, field) && typeof raw[field] !== "boolean") invalidJob();
  }
  const riskFlags = snapshotStringArray(raw.riskFlags, true);
  const topicLabels = Object.hasOwn(raw, "topicLabels")
    ? snapshotStringArray(raw.topicLabels, true)
    : undefined;
  return Object.freeze({
    valueScore: raw.valueScore as number,
    importance: raw.importance as number,
    semanticType: raw.semanticType as TreeFanOutRoutingInput["semanticType"],
    scopeVisibility: raw.scopeVisibility as TreeFanOutRoutingInput["scopeVisibility"],
    riskFlags: [...riskFlags],
    topicHotnessEligible: raw.topicHotnessEligible as boolean,
    ...(topicLabels === undefined ? {} : { topicLabels }),
    ...(raw.explicitGlobal === undefined ? {} : { explicitGlobal: raw.explicitGlobal as boolean }),
    ...(raw.isWorkspaceRule === undefined ? {} : { isWorkspaceRule: raw.isWorkspaceRule as boolean }),
    ...(raw.globalHotnessEligible === undefined
      ? {}
      : { globalHotnessEligible: raw.globalHotnessEligible as boolean }),
  });
}

function snapshotScope(value: unknown, withContext: boolean): {
  readonly core: DurableJobV2Scope;
  readonly context: NativeBuildTreeContext;
} {
  const raw = exactDataRecord(value, SCOPE_REQUIRED, withContext ? CONTEXT_OPTIONAL : []);
  for (const field of SCOPE_REQUIRED.slice(0, 6)) if (!safeId(raw[field])) invalidJob();
  if (typeof raw.visibility !== "string" || !VISIBILITIES.has(raw.visibility)) invalidJob();
  for (const field of CONTEXT_OPTIONAL) {
    if (Object.hasOwn(raw, field) && !safeId(raw[field])) invalidJob();
  }
  return Object.freeze({
    core: Object.freeze({
      tenantId: raw.tenantId as string,
      userId: raw.userId as string,
      appId: raw.appId as string,
      projectId: raw.projectId as string,
      agentId: raw.agentId as string,
      namespace: raw.namespace as string,
      visibility: raw.visibility as DurableJobV2Scope["visibility"],
    }),
    context: Object.freeze({
      ...(raw.workspaceId === undefined ? {} : { workspaceId: raw.workspaceId as string }),
      ...(raw.sessionId === undefined ? {} : { sessionId: raw.sessionId as string }),
    }),
  });
}

function sameScope(left: DurableJobV2Scope, right: DurableJobV2Scope): boolean {
  return left.tenantId === right.tenantId && left.userId === right.userId &&
    left.appId === right.appId && left.projectId === right.projectId &&
    left.agentId === right.agentId && left.namespace === right.namespace &&
    left.visibility === right.visibility;
}

function assertLease(job: DurableJobV2, context: DurableJobV2HandlerContext): void {
  if (job.status !== "running" || typeof job.leaseOwner !== "string" ||
      !LEASE_OWNER.test(job.leaseOwner) || job.leaseOwner !== context.workerId ||
      typeof job.leaseToken !== "string" || !LEASE_TOKEN.test(job.leaseToken) ||
      !Number.isSafeInteger(job.leaseGeneration) || job.leaseGeneration < 1) invalidJob();
}

/** Pure deterministic normalization. No repository/provider/clock calls occur here. */
function computeEffectRequest(
  rawJob: DurableJobV2,
  context: DurableJobV2HandlerContext,
): NativeBuildTreeEffectRequest {
  const job = exactDataRecord(rawJob, JOB_REQUIRED, JOB_OPTIONAL);
  if (job.type !== "build_tree" || !safeId(job.id)) invalidJob();
  assertLease(rawJob, context);
  const jobScope = snapshotScope(job.scope, false).core;
  const payload = exactDataRecord(job.payload, PAYLOAD_REQUIRED, PAYLOAD_OPTIONAL);
  const payloadScope = snapshotScope(payload.scope, true);
  if (!sameScope(jobScope, payloadScope.core)) invalidJob();
  const hasLeaf = Object.hasOwn(payload, "leaf");
  const hasFinalize = Object.hasOwn(payload, "finalize");
  const hasRouting = Object.hasOwn(payload, "routing");
  const hasTargetIdempotencyKey = Object.hasOwn(payload, "targetIdempotencyKey");
  if (hasLeaf === hasFinalize || hasRouting !== hasTargetIdempotencyKey ||
      (hasFinalize && (hasRouting || hasTargetIdempotencyKey)) ||
      !safeId(payload.traceId) || (payload.traceId as string).length > MAX_TRACE_ID_LENGTH ||
      (hasTargetIdempotencyKey && !safeId(payload.targetIdempotencyKey)) ||
      typeof payload.treeType !== "string" || !TREE_TYPES.has(payload.treeType as MemoryTreeType) ||
      !safeId(payload.treeKey)) invalidJob();
  const dedupeIdentity = hasTargetIdempotencyKey
    ? payload.targetIdempotencyKey as string
    : payload.traceId as string;
  if (job.dedupeKey !== deriveDurableJobV2DomainDedupeKey(
    "build_tree",
    dedupeIdentity,
    payloadScope.context,
  )) invalidJob();

  const fullScope = Object.freeze({ ...jobScope, ...payloadScope.context });
  if (hasFinalize) {
    if (payload.treeType === "global") invalidJob();
    const finalize = exactDataRecord(payload.finalize, FINALIZE_REQUIRED);
    const expectedBufferId = bufferId(
      fullScope,
      payload.treeType as Exclude<MemoryTreeType, "global">,
      payload.treeKey as string,
      0,
    );
    if (finalize.mode !== "history_rebuild" || finalize.expectedBufferId !== expectedBufferId) {
      invalidJob();
    }
    return Object.freeze({
      effectKey: BUILD_TREE_EFFECT_KEY,
      effectInput: Object.freeze({
        id: job.id as string,
        scope: jobScope,
        owner: rawJob.leaseOwner!,
        leaseToken: rawJob.leaseToken!,
        leaseGeneration: rawJob.leaseGeneration,
      }),
      semanticRequest: Object.freeze({
        type: "finalize_tree_buffer" as const,
        version: BUILD_TREE_CONTRACT_VERSION,
        traceId: payload.traceId as string,
        context: payloadScope.context,
        treeType: payload.treeType as Exclude<MemoryTreeType, "global">,
        treeKey: payload.treeKey as string,
        level: 0 as const,
        finalizeMode: "history_rebuild" as const,
        expectedBufferId,
      }),
    });
  }

  const leaf = exactDataRecord(payload.leaf, LEAF_REQUIRED, LEAF_OPTIONAL);
  if (!safeId(leaf.id) || !safeId(leaf.chunkId) || !safeId(leaf.sourceId) ||
      leaf.id !== payload.traceId ||
      !safeText(leaf.text) || !safeTime(leaf.eventAt) ||
      !safeTime(job.createdAt) || (leaf.eventAt as number) > (job.createdAt as number)) invalidJob();

  const routing = hasRouting ? snapshotRouting(payload.routing) : undefined;
  const entityIds = Object.hasOwn(leaf, "entityIds")
    ? snapshotIdArray(leaf.entityIds)
    : Object.freeze([] as string[]);
  const normalizedLeaf = Object.freeze({
    id: leaf.id as string,
    scope: fullScope,
    chunkId: leaf.chunkId as string,
    sourceId: leaf.sourceId as string,
    entityIds,
    importance: routing?.importance ?? 0.5,
    eventAt: leaf.eventAt as number,
    createdAt: leaf.eventAt as number,
    text: leaf.text as string,
    tokenCount: Math.max(1, Math.ceil((leaf.text as string).length / 4)),
  }) as unknown as Readonly<TreeLeaf>;
  if (routing) {
    const matchingTargets = planTreeFanOut({
      scope: fullScope,
      leaf: normalizedLeaf,
      routing,
    }).targets.filter((target) =>
      target.treeType === payload.treeType &&
      target.treeKey === payload.treeKey &&
      target.idempotencyKey === payload.targetIdempotencyKey
    );
    if (matchingTargets.length !== 1) invalidJob();
  } else if (payload.treeType !== "source" || payload.treeKey !== leaf.sourceId) {
    invalidJob();
  }
  const semanticRequest = Object.freeze({
    type: "build_tree" as const,
    version: BUILD_TREE_CONTRACT_VERSION,
    traceId: payload.traceId as string,
    context: payloadScope.context,
    treeType: payload.treeType as MemoryTreeType,
    treeKey: payload.treeKey as string,
    level: 0 as const,
    policy: Object.freeze({ maxLeafCount: 20 as const, maxTokenCount: 6000 as const }),
    leaf: normalizedLeaf,
    expectedBufferId: bufferId(fullScope, payload.treeType as MemoryTreeType, payload.treeKey as string, 0),
  });
  return Object.freeze({
    effectKey: BUILD_TREE_EFFECT_KEY,
    effectInput: Object.freeze({
      id: job.id as string,
      scope: jobScope,
      owner: rawJob.leaseOwner!,
      leaseToken: rawJob.leaseToken!,
      leaseGeneration: rawJob.leaseGeneration,
    }),
    semanticRequest,
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error && signal.reason.name === "AbortError"
    ? signal.reason
    : new DOMException("Native build_tree aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function normalizeOutcome(
  outcome: unknown,
  request: NativeBuildTreeEffectRequest,
): NativeBuildTreeHandlerResult | { readonly status: "stale" } {
  const envelope = exactEffectRecord(outcome);
  if (envelope.status === "stale" && Reflect.ownKeys(envelope).length === 1) {
    return Object.freeze({ status: "stale" as const });
  }
  if ((envelope.status !== "applied" && envelope.status !== "replayed") ||
      Reflect.ownKeys(envelope).length !== 2) throw handlerFailure("BUILD_TREE_EFFECT_REJECTED", false);
  const receipt = exactEffectRecord(envelope.receipt);
  if (Reflect.ownKeys(receipt).length !== 1) throw handlerFailure("BUILD_TREE_EFFECT_REJECTED", false);
  const result = exactEffectRecord(receipt.result);
  const resultKeys = Reflect.ownKeys(result);
  const hasFoldedNodeIds = Object.hasOwn(result, "foldedNodeIds");
  if (resultKeys.length !== (hasFoldedNodeIds ? 5 : 4) ||
      resultKeys.some((key) => typeof key !== "string" ||
        !["leafId", "sealed", "bufferId", "nodeId", "foldedNodeIds"].includes(key)) ||
      result.leafId !== request.semanticRequest.traceId ||
      typeof result.sealed !== "boolean") throw handlerFailure("BUILD_TREE_EFFECT_REJECTED", false);
  const foldedNodeIds = hasFoldedNodeIds
    ? snapshotEffectIdArray(result.foldedNodeIds)
    : Object.freeze([] as string[]);
  if (result.sealed) {
    if (result.bufferId !== null || !safeId(result.nodeId)) {
      throw handlerFailure("BUILD_TREE_EFFECT_REJECTED", false);
    }
  } else if (result.nodeId !== null || result.bufferId !== request.semanticRequest.expectedBufferId) {
    throw handlerFailure("BUILD_TREE_EFFECT_REJECTED", false);
  }
  return Object.freeze({
    status: envelope.status,
    leafId: result.leafId as string,
    sealed: result.sealed,
    bufferId: result.bufferId as string | null,
    nodeId: result.nodeId as string | null,
    foldedNodeIds,
  });
}

function snapshotEffectIdArray(value: unknown): readonly string[] {
  try {
    return snapshotIdArray(value);
  } catch {
    throw handlerFailure("BUILD_TREE_EFFECT_REJECTED", false);
  }
}

function exactEffectRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    throw handlerFailure("BUILD_TREE_EFFECT_REJECTED", false);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw handlerFailure("BUILD_TREE_EFFECT_REJECTED", false);
  }
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw handlerFailure("BUILD_TREE_EFFECT_REJECTED", false);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw handlerFailure("BUILD_TREE_EFFECT_REJECTED", false);
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function mapEffectError(error: unknown): DurableJobV2HandlerFailure {
  if (error instanceof PostgresDurableJobV2EffectError) {
    return handlerFailure(
      error.retryable ? "BUILD_TREE_EFFECT_RETRYABLE" : "BUILD_TREE_EFFECT_REJECTED",
      error.retryable,
    );
  }
  if (error instanceof NativeBuildTreeEffectError) {
    return handlerFailure(
      error.retryable ? "BUILD_TREE_EFFECT_RETRYABLE" : "BUILD_TREE_EFFECT_REJECTED",
      error.retryable,
    );
  }
  if (error instanceof PostgresTreeFinalizeError) {
    return handlerFailure(
      error.retryable ? "BUILD_TREE_FINALIZE_PENDING" : "BUILD_TREE_FINALIZE_REJECTED",
      error.retryable,
    );
  }
  return handlerFailure("BUILD_TREE_EFFECT_RETRYABLE", true);
}

export function createNativeBuildTreeHandler(
  dependencies: NativeBuildTreeHandlerDependencies,
): DurableJobV2Handler {
  const effectPort = snapshotEffectPort(dependencies?.effectPort);
  return async (job, context): Promise<NativeBuildTreeHandlerResult> => {
    throwIfAborted(context.signal);
    let request: NativeBuildTreeEffectRequest;
    try {
      request = computeEffectRequest(job, context);
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (error instanceof DurableJobV2HandlerFailure) throw error;
      throw handlerFailure("BUILD_TREE_INVALID_JOB", false);
    }
    throwIfAborted(context.signal);
    try {
      const outcome = normalizeOutcome(
        await effectPort.executeBuildTreeEffect(request, context.signal),
        request,
      );
      if (outcome.status === "stale") {
        throw handlerFailure("BUILD_TREE_EFFECT_STALE", true);
      }
      return outcome;
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (error instanceof DurableJobV2HandlerFailure) throw error;
      throw mapEffectError(error);
    }
  };
}

/** Production composition path：只接受 provider mint 的 atomic runtime bundle。 */
export function createProviderOwnedNativeBuildTreeHandler(
  dependencies: ProviderOwnedNativeBuildTreeHandlerDependencies,
): DurableJobV2Handler {
  const bundle = assertProviderOwnedPostgresDurableJobV2RuntimeBundle(
    dependencies?.runtimeBundle,
  );
  const effectPort: NativeBuildTreeEffectPort = Object.freeze({
    executeBuildTreeEffect: async (
      request: NativeBuildTreeEffectRequest,
      signal: AbortSignal,
    ) => {
      const outcome = await bundle.executeBuildTreeEffect(request, signal);
      if (outcome.status === "stale") return outcome;
      const receipt = outcome.receipt;
      if (receipt.jobId !== request.effectInput.id || receipt.effectKey !== request.effectKey ||
          !/^[0-9a-f]{64}$/.test(receipt.requestFingerprint) ||
          !Number.isSafeInteger(receipt.leaseGeneration) || receipt.leaseGeneration < 1 ||
          receipt.leaseGeneration > request.effectInput.leaseGeneration ||
          !Number.isSafeInteger(receipt.committedAt) || receipt.committedAt < 0) {
        throw new NativeBuildTreeEffectError("BUILD_TREE_EFFECT_INVALID_RECEIPT");
      }
      return Object.freeze({
        status: outcome.status,
        receipt: Object.freeze({ result: receipt.result }),
      });
    },
  });
  return createNativeBuildTreeHandler({ effectPort });
}
