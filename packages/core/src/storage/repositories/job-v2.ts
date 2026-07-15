import { createHash } from "node:crypto";

export type DurableJobV2Status =
  | "queued"
  | "retry_wait"
  | "running"
  | "completed"
  | "dead_letter";

export interface DurableJobV2Error {
  readonly code: string;
  readonly retryable: boolean;
  /** 原始 message 不落库，仅保留不可逆 fingerprint 供审计聚类。 */
  readonly fingerprint: string;
}

export type DurableJobV2Visibility = "private" | "workspace" | "team" | "public";

/** Production durable-v2 runtime 的完整 native handler SSOT；partial registry 不得 serve。 */
export const DURABLE_JOB_V2_AUTHORITATIVE_TYPES = Object.freeze([
  "build_tree",
  "extract_candidate",
  "extract_graph",
] as const);

/**
 * Provider 持久队列只接受 authority 已解析完成的 canonical scope。
 * 可选 workspace/session 不是 v2 队列隔离键，调用方不得把未解析 client scope 传入。
 */
export interface DurableJobV2Scope {
  readonly tenantId: string;
  readonly userId: string;
  readonly appId: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly namespace: string;
  readonly visibility: DurableJobV2Visibility;
}

export interface DurableJobV2 {
  readonly id: string;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly scope: DurableJobV2Scope;
  /** client 原始 key 仅用于审计，provider 不得用它做全局唯一约束。 */
  readonly dedupeKey: string;
  /** provider-facing、按完整 canonical scope 隔离的 opaque 唯一键。 */
  readonly scopedDedupeKey: string;
  readonly status: DurableJobV2Status;
  /** 已开始执行的次数；每次成功 lease 时递增。 */
  readonly attempts: number;
  /** 单调 fencing generation；每次成功 lease 时递增，不能因清空 token 回退。 */
  readonly leaseGeneration: number;
  readonly maxAttempts: number;
  readonly nextAttemptAt?: number;
  readonly leaseOwner?: string;
  readonly leaseToken?: string;
  readonly leaseUntil?: number;
  readonly heartbeatAt?: number;
  readonly lastError?: DurableJobV2Error;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface DurableJobHandlerRegistry {
  readonly types: readonly string[];
  isRegistered(type: string): boolean;
}

export interface DurableJobV2TransitionResult {
  readonly applied: 0 | 1;
  readonly job: DurableJobV2;
}

export type JobV2ContractErrorCode =
  | "HANDLER_NOT_REGISTERED"
  | "INVALID_HANDLER_TYPE"
  | "INVALID_JOB"
  | "INVALID_TRANSITION"
  | "INVALID_LEASE_OWNER"
  | "INVALID_LEASE_TOKEN"
  | "INVALID_LEASE_GENERATION"
  | "LEASE_TOKEN_REUSED"
  | "INVALID_BACKOFF"
  | "INVALID_ERROR_CODE";

export class JobV2ContractError extends Error {
  readonly code: JobV2ContractErrorCode;

  constructor(code: JobV2ContractErrorCode, message: string) {
    super(message);
    this.name = "JobV2ContractError";
    this.code = code;
  }
}

const HANDLER_TYPE = /^[a-z][a-z0-9._:-]{0,127}$/;
export const DURABLE_JOB_V2_SAFE_IDENTIFIER_MAX_LENGTH = 256 as const;
const UNSAFE_IDENTIFIER_CHARACTER = /[\s\p{Cc}]/u;
const UNPAIRED_IDENTIFIER_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const LEASE_OWNER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
// token 由调用方使用 CSPRNG 生成；合同只接受足够长且可安全持久化的 opaque token。
const LEASE_TOKEN = /^[A-Za-z0-9._~-]{32,256}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const SCOPE_FIELDS = Object.freeze([
  "tenantId",
  "userId",
  "appId",
  "projectId",
  "agentId",
  "namespace",
  "visibility",
] as const);
const SCOPE_DIMENSIONS = SCOPE_FIELDS.slice(0, 6) as ReadonlyArray<
  Exclude<(typeof SCOPE_FIELDS)[number], "visibility">
>;
const VISIBILITIES = new Set<DurableJobV2Visibility>([
  "private",
  "workspace",
  "team",
  "public",
]);
const STATUSES = new Set<DurableJobV2Status>([
  "queued",
  "retry_wait",
  "running",
  "completed",
  "dead_letter",
]);

function contractError(code: JobV2ContractErrorCode, message: string): never {
  throw new JobV2ContractError(code, message);
}

/** Shared durable-v2 identity contract; length is measured in UTF-16 code units. */
export function isDurableJobV2SafeIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 &&
    value.length <= DURABLE_JOB_V2_SAFE_IDENTIFIER_MAX_LENGTH &&
    !UNSAFE_IDENTIFIER_CHARACTER.test(value) &&
    !UNPAIRED_IDENTIFIER_SURROGATE.test(value);
}

export function assertDurableJobV2SafeIdentifier(
  value: unknown,
): asserts value is string {
  if (!isDurableJobV2SafeIdentifier(value)) {
    contractError("INVALID_JOB", "durable job safe identifier is invalid");
  }
}

function validTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function assertNow(now: number): void {
  if (!validTime(now)) contractError("INVALID_JOB", "job transition time is invalid");
}

function assertLeaseMs(leaseMs: number, now: number): void {
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0 || !Number.isSafeInteger(now + leaseMs)) {
    contractError("INVALID_JOB", "job lease duration is invalid");
  }
}

function assertOwner(owner: string): void {
  if (typeof owner !== "string" || !LEASE_OWNER.test(owner)) {
    contractError("INVALID_LEASE_OWNER", "job lease owner is invalid");
  }
}

function assertLeaseToken(token: string): void {
  if (typeof token !== "string" || !LEASE_TOKEN.test(token)) {
    contractError("INVALID_LEASE_TOKEN", "job lease token is invalid");
  }
}

function cloneCanonicalScope(scope: DurableJobV2Scope): DurableJobV2Scope {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    contractError("INVALID_JOB", "job canonical scope is invalid");
  }
  const prototype = Object.getPrototypeOf(scope);
  if (prototype !== Object.prototype && prototype !== null) {
    contractError("INVALID_JOB", "job canonical scope must be a plain object");
  }
  const keys = Reflect.ownKeys(scope);
  if (keys.length !== SCOPE_FIELDS.length ||
      keys.some((key) => typeof key !== "string" ||
        !(SCOPE_FIELDS as readonly string[]).includes(key))) {
    contractError("INVALID_JOB", "job canonical scope fields are invalid");
  }
  for (const field of SCOPE_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(scope, field);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      contractError("INVALID_JOB", "job canonical scope contains a non-data field");
    }
  }
  for (const field of SCOPE_DIMENSIONS) {
    if (!isDurableJobV2SafeIdentifier(scope[field])) {
      contractError("INVALID_JOB", `job canonical scope ${field} is invalid`);
    }
  }
  if (!VISIBILITIES.has(scope.visibility)) {
    contractError("INVALID_JOB", "job canonical scope visibility is invalid");
  }
  return Object.freeze({
    tenantId: scope.tenantId,
    userId: scope.userId,
    appId: scope.appId,
    projectId: scope.projectId,
    agentId: scope.agentId,
    namespace: scope.namespace,
    visibility: scope.visibility,
  });
}

function canonicalScopeTuple(scope: DurableJobV2Scope): readonly string[] {
  return [
    scope.tenantId,
    scope.userId,
    scope.appId,
    scope.projectId,
    scope.agentId,
    scope.namespace,
    scope.visibility,
  ];
}

export function deriveDurableJobV2ScopedDedupeKey(
  scope: DurableJobV2Scope,
  clientDedupeKey: string,
): string {
  const canonicalScope = cloneCanonicalScope(scope);
  if (!isDurableJobV2SafeIdentifier(clientDedupeKey)) {
    contractError("INVALID_JOB", "job client dedupe key is invalid");
  }
  return createHash("sha256")
    .update("mengshu:durable-job-v2:dedupe:v1\0")
    .update(JSON.stringify(canonicalScopeTuple(canonicalScope)))
    .update("\0")
    .update(clientDedupeKey)
    .digest("hex");
}

/**
 * Domain dedupe 必须覆盖 queue 7D scope 之外的 workspace/session，避免同一
 * trace/chunk 在不同上下文被提前合并。返回值只含 type + SHA-256，保持安全长度。
 */
export function deriveDurableJobV2DomainDedupeKey(
  type: string,
  identity: string,
  context: { readonly workspaceId?: string; readonly sessionId?: string } = {},
): string {
  if (!HANDLER_TYPE.test(type) || !isDurableJobV2SafeIdentifier(identity) ||
      (context.workspaceId !== undefined && !isDurableJobV2SafeIdentifier(context.workspaceId)) ||
      (context.sessionId !== undefined && !isDurableJobV2SafeIdentifier(context.sessionId))) {
    throw new JobV2ContractError("INVALID_JOB", "durable job domain dedupe input is invalid");
  }
  const digest = createHash("sha256").update(JSON.stringify([
    "mengshu.durable-job-v2.domain-dedupe/v1",
    type,
    identity,
    context.workspaceId ?? "",
    context.sessionId ?? "",
  ])).digest("hex");
  return `${type}:${digest}`;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function cloneJsonValue(value: unknown, ancestors: Set<object>): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) contractError("INVALID_JOB", "job payload contains invalid number");
    return value;
  }
  if (typeof value !== "object") {
    contractError("INVALID_JOB", "job payload contains a non-JSON value");
  }
  if (ancestors.has(value)) contractError("INVALID_JOB", "job payload contains a cycle");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.some((key) => typeof key !== "string" ||
          (key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) ||
            !Number.isSafeInteger(Number(key)) || Number(key) >= value.length)))) {
        contractError("INVALID_JOB", "job payload array contains invalid properties");
      }
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          contractError("INVALID_JOB", "job payload array contains a hole");
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          contractError("INVALID_JOB", "job payload array contains an accessor");
        }
        result.push(cloneJsonValue(descriptor.value, ancestors));
      }
      return Object.freeze(result) as JsonValue;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      contractError("INVALID_JOB", "job payload contains a non-plain object");
    }
    const result: Record<string, JsonValue> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        contractError("INVALID_JOB", "job payload contains a symbol property");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        contractError("INVALID_JOB", "job payload contains a non-data property");
      }
      Object.defineProperty(result, key, {
        value: cloneJsonValue(descriptor.value, ancestors),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
}

function clonePayload(payload: Record<string, unknown>): Readonly<Record<string, unknown>> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    contractError("INVALID_JOB", "job payload must be a JSON object");
  }
  return cloneJsonValue(payload, new Set()) as Readonly<Record<string, unknown>>;
}

function freezeJob(job: DurableJobV2): DurableJobV2 {
  const lastError = job.lastError ? Object.freeze({ ...job.lastError }) : undefined;
  return Object.freeze({
    ...job,
    payload: clonePayload(job.payload as Record<string, unknown>),
    scope: cloneCanonicalScope(job.scope),
    ...(lastError ? { lastError } : {}),
  });
}

function assertLastError(error: DurableJobV2Error | undefined): void {
  if (!error) return;
  if (!ERROR_CODE.test(error.code) || typeof error.retryable !== "boolean" ||
      !/^[a-f0-9]{64}$/.test(error.fingerprint)) {
    contractError("INVALID_JOB", "job last error is invalid");
  }
}

export function assertDurableJobV2(job: DurableJobV2): void {
  if (!job || typeof job !== "object" || !isDurableJobV2SafeIdentifier(job.id) ||
      !HANDLER_TYPE.test(job.type) || !isDurableJobV2SafeIdentifier(job.dedupeKey) ||
      !SHA256_HEX.test(job.scopedDedupeKey) ||
      !STATUSES.has(job.status) || !Number.isSafeInteger(job.attempts) || job.attempts < 0 ||
      !Number.isSafeInteger(job.leaseGeneration) || job.leaseGeneration < 0 ||
      job.leaseGeneration !== job.attempts ||
      !Number.isSafeInteger(job.maxAttempts) || job.maxAttempts < 1 ||
      job.attempts > job.maxAttempts || !validTime(job.createdAt) || !validTime(job.updatedAt) ||
      job.updatedAt < job.createdAt) {
    contractError("INVALID_JOB", "durable job shape is invalid");
  }
  const canonicalScope = cloneCanonicalScope(job.scope);
  if (deriveDurableJobV2ScopedDedupeKey(canonicalScope, job.dedupeKey) !==
      job.scopedDedupeKey) {
    contractError("INVALID_JOB", "job scoped dedupe identity does not match canonical scope");
  }
  clonePayload(job.payload as Record<string, unknown>);
  assertLastError(job.lastError);

  if (job.status === "running") {
    if (!LEASE_OWNER.test(job.leaseOwner ?? "") || !LEASE_TOKEN.test(job.leaseToken ?? "") ||
        !validTime(job.leaseUntil) || !validTime(job.heartbeatAt) ||
        job.attempts < 1 || job.heartbeatAt! < job.createdAt ||
        job.heartbeatAt! > job.updatedAt || job.leaseUntil! <= job.heartbeatAt! ||
        job.leaseUntil! <= job.updatedAt ||
        job.nextAttemptAt !== undefined) {
      contractError("INVALID_JOB", "running job lease fields are invalid");
    }
    return;
  }

  if (job.leaseOwner !== undefined || job.leaseToken !== undefined ||
      job.leaseUntil !== undefined || job.heartbeatAt !== undefined) {
    contractError("INVALID_JOB", "non-running job must not retain lease fields");
  }
  if (job.status === "retry_wait") {
    if (!validTime(job.nextAttemptAt) || job.nextAttemptAt < job.updatedAt ||
        job.attempts >= job.maxAttempts || !job.lastError) {
      contractError("INVALID_JOB", "retry_wait job requires nextAttemptAt");
    }
  } else if (job.nextAttemptAt !== undefined) {
    contractError("INVALID_JOB", "non-retry job must not retain nextAttemptAt");
  }
  if (job.status === "queued" && (job.attempts !== 0 || job.lastError !== undefined)) {
    contractError("INVALID_JOB", "queued job cannot retain execution state");
  }
  if (job.status === "completed" && job.attempts < 1) {
    contractError("INVALID_JOB", "completed job requires an execution attempt");
  }
  if (job.status === "dead_letter" && !job.lastError) {
    contractError("INVALID_JOB", "dead_letter job requires an audit error");
  }
}

export function createDurableJobHandlerRegistry(
  types: readonly string[],
): DurableJobHandlerRegistry {
  const distinct = new Set<string>();
  for (const type of types) {
    if (typeof type !== "string" || !HANDLER_TYPE.test(type)) {
      contractError("INVALID_HANDLER_TYPE", "durable job handler type is invalid");
    }
    distinct.add(type);
  }
  const registered = Object.freeze([...distinct].sort());
  const lookup = new Set(registered);
  return Object.freeze({
    types: registered,
    isRegistered: (type: string) => lookup.has(type),
  });
}

export function createDurableJobV2(
  input: {
    readonly id: string;
    readonly type: string;
    readonly payload: Record<string, unknown>;
    readonly dedupeKey: string;
    readonly scope: DurableJobV2Scope;
    readonly maxAttempts: number;
  },
  dependencies: {
    readonly registry: DurableJobHandlerRegistry;
    readonly now: number;
  },
): DurableJobV2 {
  // handler gate 必须先于任何 enqueue record 构造或 payload 处理。
  if (!dependencies.registry.isRegistered(input.type)) {
    contractError("HANDLER_NOT_REGISTERED", "durable job handler is not registered");
  }
  assertNow(dependencies.now);
  const scope = cloneCanonicalScope(input.scope);
  const job: DurableJobV2 = {
    id: input.id,
    type: input.type,
    payload: clonePayload(input.payload),
    scope,
    dedupeKey: input.dedupeKey,
    scopedDedupeKey: deriveDurableJobV2ScopedDedupeKey(scope, input.dedupeKey),
    status: "queued",
    attempts: 0,
    leaseGeneration: 0,
    maxAttempts: input.maxAttempts,
    createdAt: dependencies.now,
    updatedAt: dependencies.now,
  };
  assertDurableJobV2(job);
  return freezeJob(job);
}

export function isDurableJobV2LeaseEligible(job: DurableJobV2, now: number): boolean {
  assertDurableJobV2(job);
  assertTransitionTime(job, now);
  if (job.attempts >= job.maxAttempts) return false;
  if (job.status === "queued") return true;
  if (job.status === "retry_wait") return job.nextAttemptAt! <= now;
  if (job.status === "running") return job.leaseUntil! <= now;
  return false;
}

function withoutSchedulingAndLease(
  job: DurableJobV2,
): Omit<DurableJobV2, "nextAttemptAt" | "leaseOwner" | "leaseToken" | "leaseUntil" | "heartbeatAt"> {
  const {
    nextAttemptAt: _nextAttemptAt,
    leaseOwner: _leaseOwner,
    leaseToken: _leaseToken,
    leaseUntil: _leaseUntil,
    heartbeatAt: _heartbeatAt,
    ...rest
  } = job;
  return rest;
}

export function leaseDurableJobV2(
  job: DurableJobV2,
  input: {
    readonly owner: string;
    readonly now: number;
    readonly leaseMs: number;
    /** T403 provider 必须注入 CSPRNG token factory；纯状态机不读取全局随机源。 */
    readonly tokenFactory: () => string;
  },
): DurableJobV2TransitionResult {
  assertDurableJobV2(job);
  assertNow(input.now);
  assertLeaseMs(input.leaseMs, input.now);
  if (!isDurableJobV2LeaseEligible(job, input.now)) return { applied: 0, job };
  assertOwner(input.owner);
  const token = input.tokenFactory();
  assertLeaseToken(token);
  if (token === job.leaseToken) {
    contractError("LEASE_TOKEN_REUSED", "expired job lease takeover requires a new token");
  }
  const leased = freezeJob({
    ...withoutSchedulingAndLease(job),
    status: "running",
    attempts: job.attempts + 1,
    leaseGeneration: job.leaseGeneration + 1,
    leaseOwner: input.owner,
    leaseToken: token,
    leaseUntil: input.now + input.leaseMs,
    heartbeatAt: input.now,
    updatedAt: input.now,
  });
  return { applied: 1, job: leased };
}

function assertRunningTransition(job: DurableJobV2): void {
  assertDurableJobV2(job);
  if (job.status !== "running") {
    contractError("INVALID_TRANSITION", "job transition requires running status");
  }
}

function assertTransitionTime(job: DurableJobV2, now: number): void {
  assertNow(now);
  if (now < job.updatedAt) {
    contractError("INVALID_JOB", "job transition time precedes persisted state");
  }
}

function assertLeaseGeneration(leaseGeneration: number): void {
  if (!Number.isSafeInteger(leaseGeneration) || leaseGeneration < 0) {
    contractError("INVALID_LEASE_GENERATION", "job lease generation is invalid");
  }
}

function holdsCurrentLease(
  job: DurableJobV2,
  input: {
    readonly owner: string;
    readonly leaseToken: string;
    readonly leaseGeneration: number;
    readonly now: number;
  },
): boolean {
  assertOwner(input.owner);
  assertLeaseToken(input.leaseToken);
  assertLeaseGeneration(input.leaseGeneration);
  assertTransitionTime(job, input.now);
  return job.leaseOwner === input.owner &&
    job.leaseToken === input.leaseToken &&
    job.leaseGeneration === input.leaseGeneration &&
    input.now < job.leaseUntil!;
}

export function renewDurableJobLeaseV2(
  job: DurableJobV2,
  input: {
    readonly owner: string;
    readonly leaseToken: string;
    readonly leaseGeneration: number;
    readonly now: number;
    readonly leaseMs: number;
  },
): DurableJobV2TransitionResult {
  assertRunningTransition(job);
  assertLeaseMs(input.leaseMs, input.now);
  if (!holdsCurrentLease(job, input)) return { applied: 0, job };
  return {
    applied: 1,
    job: freezeJob({
      ...job,
      heartbeatAt: input.now,
      leaseUntil: input.now + input.leaseMs,
      updatedAt: input.now,
    }),
  };
}

export function completeDurableJobV2(
  job: DurableJobV2,
  input: {
    readonly owner: string;
    readonly leaseToken: string;
    readonly leaseGeneration: number;
    readonly now: number;
  },
): DurableJobV2TransitionResult {
  assertRunningTransition(job);
  if (!holdsCurrentLease(job, input)) return { applied: 0, job };
  return {
    applied: 1,
    job: freezeJob({
      ...withoutSchedulingAndLease(job),
      status: "completed",
      updatedAt: input.now,
    }),
  };
}

function safeFailure(input: {
  readonly code: string;
  readonly retryable: boolean;
  readonly message?: string;
}): DurableJobV2Error {
  if (typeof input.code !== "string" || !ERROR_CODE.test(input.code)) {
    contractError("INVALID_ERROR_CODE", "durable job error code is invalid");
  }
  if (typeof input.retryable !== "boolean") {
    contractError("INVALID_ERROR_CODE", "durable job retryable flag is invalid");
  }
  const message = typeof input.message === "string" ? input.message : "";
  return Object.freeze({
    code: input.code,
    retryable: input.retryable,
    fingerprint: createHash("sha256")
      .update(JSON.stringify({ code: input.code, message }))
      .digest("hex"),
  });
}

/**
 * 回收“最终 attempt 已开始但 worker 永久消失”的过期 lease。
 * 未耗尽 attempts 的过期 lease 仍由 leaseDurableJobV2 以新 generation 接管。
 */
export function reapExpiredDurableJobV2(
  job: DurableJobV2,
  input: { readonly now: number },
): DurableJobV2TransitionResult {
  assertRunningTransition(job);
  assertTransitionTime(job, input.now);
  if (input.now < job.leaseUntil! || job.attempts < job.maxAttempts) {
    return { applied: 0, job };
  }
  return {
    applied: 1,
    job: freezeJob({
      ...withoutSchedulingAndLease(job),
      status: "dead_letter",
      lastError: safeFailure({
        code: "LEASE_EXPIRED",
        retryable: false,
      }),
      updatedAt: input.now,
    }),
  };
}

export function failDurableJobV2(
  job: DurableJobV2,
  input: {
    readonly owner: string;
    readonly leaseToken: string;
    readonly leaseGeneration: number;
    readonly now: number;
    readonly failure: {
      readonly code: string;
      readonly retryable: boolean;
      readonly message?: string;
    };
    readonly backoffMs: (attempts: number) => number;
  },
): DurableJobV2TransitionResult {
  assertRunningTransition(job);
  if (!holdsCurrentLease(job, input)) return { applied: 0, job };
  const lastError = safeFailure(input.failure);
  const base = withoutSchedulingAndLease(job);
  if (!lastError.retryable || job.attempts >= job.maxAttempts) {
    return {
      applied: 1,
      job: freezeJob({
        ...base,
        status: "dead_letter",
        lastError,
        updatedAt: input.now,
      }),
    };
  }

  const delay = input.backoffMs(job.attempts);
  if (!Number.isSafeInteger(delay) || delay < 0 || !Number.isSafeInteger(input.now + delay)) {
    contractError("INVALID_BACKOFF", "durable job retry backoff is invalid");
  }
  return {
    applied: 1,
    job: freezeJob({
      ...base,
      status: "retry_wait",
      nextAttemptAt: input.now + delay,
      lastError,
      updatedAt: input.now,
    }),
  };
}

/**
 * 使用当前 runtime 的完整 authoritative handler registry 隔离历史 orphan job。
 * partial worker pool 不得把自己的 handler 子集作为 authoritative registry 传入。
 */
export function quarantineUnknownDurableJobV2(
  job: DurableJobV2,
  input: {
    readonly authoritativeRegistry: DurableJobHandlerRegistry;
    readonly now: number;
  },
): DurableJobV2TransitionResult {
  assertDurableJobV2(job);
  assertTransitionTime(job, input.now);
  const rawTypes = input.authoritativeRegistry?.types;
  if (!Array.isArray(rawTypes) || rawTypes.length === 0 ||
      typeof input.authoritativeRegistry.isRegistered !== "function") {
    contractError("INVALID_JOB", "authoritative durable job handler registry is empty or invalid");
  }
  const authoritativeRegistry = createDurableJobHandlerRegistry(rawTypes);
  if (authoritativeRegistry.types.length !== rawTypes.length ||
      authoritativeRegistry.types.some((type, index) => type !== rawTypes[index]) ||
      authoritativeRegistry.types.some((type) => !input.authoritativeRegistry.isRegistered(type))) {
    contractError("INVALID_JOB", "authoritative durable job handler registry is not canonical");
  }
  if (authoritativeRegistry.isRegistered(job.type)) return { applied: 0, job };
  const due = job.status === "queued" ||
    (job.status === "retry_wait" && job.nextAttemptAt! <= input.now);
  if (!due) return { applied: 0, job };
  return {
    applied: 1,
    job: freezeJob({
      ...withoutSchedulingAndLease(job),
      status: "dead_letter",
      lastError: safeFailure({
        code: "HANDLER_NOT_REGISTERED",
        retryable: false,
      }),
      updatedAt: input.now,
    }),
  };
}
