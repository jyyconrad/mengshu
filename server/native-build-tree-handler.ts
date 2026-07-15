import { types as nodeUtilTypes } from "node:util";

import {
  assertProviderOwnedPostgresDurableJobV2RuntimeBundle,
  type PostgresDurableJobV2RuntimeBundle,
} from "../packages/core/src/db/providers/postgres.js";
import { PostgresDurableJobV2EffectError } from
  "../packages/core/src/storage/repositories/postgres-job-v2-effect.js";

import { bufferId } from "../packages/core/src/tree/buffer.js";
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

export interface NativeBuildTreeSemanticRequest {
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
}

const JOB_REQUIRED = Object.freeze([
  "id", "type", "payload", "scope", "dedupeKey", "scopedDedupeKey", "status",
  "attempts", "leaseGeneration", "maxAttempts", "createdAt", "updatedAt",
] as const);
const JOB_OPTIONAL = Object.freeze([
  "nextAttemptAt", "leaseOwner", "leaseToken", "leaseUntil", "heartbeatAt", "lastError",
] as const);
const PAYLOAD_REQUIRED = Object.freeze([
  "scope", "traceId", "treeType", "treeKey", "leaf",
] as const);
const SCOPE_REQUIRED = Object.freeze([
  "tenantId", "userId", "appId", "projectId", "agentId", "namespace", "visibility",
] as const);
const CONTEXT_OPTIONAL = Object.freeze(["workspaceId", "sessionId"] as const);
const LEAF_REQUIRED = Object.freeze(["id", "chunkId", "sourceId", "text", "eventAt"] as const);
const LEASE_OWNER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const LEASE_TOKEN = /^[A-Za-z0-9._~-]{32,256}$/;
const UNSAFE_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
const UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const VISIBILITIES = new Set(["private", "workspace", "team", "public"]);
const TREE_TYPES = new Set<MemoryTreeType>(["source", "topic", "global"]);
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
  const payload = exactDataRecord(job.payload, PAYLOAD_REQUIRED);
  const payloadScope = snapshotScope(payload.scope, true);
  if (!sameScope(jobScope, payloadScope.core)) invalidJob();
  if (!safeId(payload.traceId) || (payload.traceId as string).length > MAX_TRACE_ID_LENGTH ||
      job.dedupeKey !== deriveDurableJobV2DomainDedupeKey(
        "build_tree",
        payload.traceId as string,
        payloadScope.context,
      ) ||
      typeof payload.treeType !== "string" || !TREE_TYPES.has(payload.treeType as MemoryTreeType) ||
      !safeId(payload.treeKey)) invalidJob();
  const leaf = exactDataRecord(payload.leaf, LEAF_REQUIRED);
  if (!safeId(leaf.id) || !safeId(leaf.chunkId) || !safeId(leaf.sourceId) ||
      leaf.id !== payload.traceId || leaf.chunkId !== payload.traceId ||
      !safeText(leaf.text) || !safeTime(leaf.eventAt) ||
      !safeTime(job.createdAt) || (leaf.eventAt as number) > (job.createdAt as number)) invalidJob();

  const fullScope = Object.freeze({ ...jobScope, ...payloadScope.context });
  const normalizedLeaf = Object.freeze({
    id: leaf.id as string,
    scope: fullScope,
    chunkId: leaf.chunkId as string,
    sourceId: leaf.sourceId as string,
    entityIds: Object.freeze([]) as readonly string[],
    importance: 0.5,
    eventAt: leaf.eventAt as number,
    createdAt: leaf.eventAt as number,
    text: leaf.text as string,
    tokenCount: Math.max(1, Math.ceil((leaf.text as string).length / 4)),
  }) as unknown as Readonly<TreeLeaf>;
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
  if (Reflect.ownKeys(result).length !== 4 || result.leafId !== request.semanticRequest.leaf.id ||
      typeof result.sealed !== "boolean") throw handlerFailure("BUILD_TREE_EFFECT_REJECTED", false);
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
  });
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
