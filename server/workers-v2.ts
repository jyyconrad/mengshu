import {
  resolveAuthorityScope,
  type AuthorityScope,
  type ClientAuthorityScopeRequest,
} from "../packages/core/src/domain/authority-scope.js";
import {
  assertDurableJobV2,
  createDurableJobHandlerRegistry,
  deriveDurableJobV2ScopedDedupeKey,
  isDurableJobV2SafeIdentifier,
  type DurableJobV2,
  type DurableJobV2Scope,
} from "../packages/core/src/storage/repositories/job-v2.js";

export interface DurableJobV2OperationResult {
  readonly applied: 0 | 1;
  readonly job?: DurableJobV2;
}

export interface DurableJobV2FencedInput {
  readonly id: string;
  readonly scope: DurableJobV2Scope;
  readonly owner: string;
  readonly leaseToken: string;
  readonly leaseGeneration: number;
}

export interface DurableJobV2RepositoryPort {
  reap(input: {
    readonly scope: DurableJobV2Scope;
    readonly idPrefix?: string;
    readonly excludeIdPrefix?: string;
    readonly idAllowlist?: readonly string[];
  }): Promise<DurableJobV2OperationResult>;
  quarantineUnknown(input: {
    readonly scope: DurableJobV2Scope;
    /** 当前 runtime 的完整 handler 集合；partial worker pool 子集禁止传入。 */
    readonly authoritativeHandlerTypes: readonly string[];
    readonly idPrefix?: string;
    readonly excludeIdPrefix?: string;
    readonly idAllowlist?: readonly string[];
  }): Promise<DurableJobV2OperationResult>;
  lease(input: {
    readonly scope: DurableJobV2Scope;
    readonly owner: string;
    readonly leaseMs: number;
    readonly idPrefix?: string;
    readonly excludeIdPrefix?: string;
    readonly idAllowlist?: readonly string[];
  }): Promise<DurableJobV2OperationResult>;
  renew(input: DurableJobV2FencedInput & {
    readonly leaseMs: number;
  }): Promise<DurableJobV2OperationResult>;
  complete(input: DurableJobV2FencedInput): Promise<DurableJobV2OperationResult>;
  fail(input: DurableJobV2FencedInput & {
    readonly failure: {
      readonly code: string;
      readonly retryable: boolean;
    };
  }): Promise<DurableJobV2OperationResult>;
}

export interface BroadAuthorityDurableJobV2RepositoryPort extends DurableJobV2RepositoryPort {
  listRunnableScopes(
    authority: AuthorityScope,
    limit: number,
    after?: DurableJobV2Scope,
  ): Promise<readonly DurableJobV2Scope[]>;
}

export interface DurableJobV2HandlerContext {
  readonly signal: AbortSignal;
  readonly workerId: string;
}

/**
 * AbortSignal 只能通知 handler 停止并释放 worker 的等待，不能强杀 JavaScript Promise
 * 或撤销已发生的外部副作用。handler 必须协作检查 signal，并对不可逆副作用使用幂等键或 fence。
 */
export type DurableJobV2Handler = (
  job: DurableJobV2,
  context: DurableJobV2HandlerContext,
) => Promise<unknown>;

export interface DurableJobV2AuthoritativeHandlerRegistry {
  /** 显式声明 types 是整个 runtime 的完整集合，而不是某个 worker pool 的子集。 */
  readonly authoritative: true;
  readonly types: readonly string[];
  get(type: string): DurableJobV2Handler | undefined;
}

const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Handler 可显式声明 retryable；message 固定，禁止携带 provider 原始错误。 */
export class DurableJobV2HandlerFailure extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, retryable: boolean) {
    if (!ERROR_CODE.test(code)) throw new Error("durable job handler failure code is invalid");
    super("Durable job handler failed");
    this.name = "DurableJobV2HandlerFailure";
    this.code = code;
    this.retryable = retryable;
  }
}

export function createAuthoritativeDurableJobV2WorkerHandlerRegistry(
  handlers: Readonly<Record<string, DurableJobV2Handler | undefined>>,
): DurableJobV2AuthoritativeHandlerRegistry {
  if (!handlers || typeof handlers !== "object" || Array.isArray(handlers)) {
    throw new Error("durable job worker handlers must be an object");
  }
  const entries = Object.entries(handlers);
  if (entries.length === 0) {
    throw new Error("authoritative durable job handler registry must not be empty");
  }
  const contract = createDurableJobHandlerRegistry(entries.map(([type]) => type));
  const lookup = new Map<string, DurableJobV2Handler>();
  for (const [type, handler] of entries) {
    if (typeof handler !== "function") {
      throw new Error(`durable job worker handler '${type}' is invalid`);
    }
    lookup.set(type, handler);
  }
  return Object.freeze({
    authoritative: true as const,
    types: contract.types,
    get: (type: string) => lookup.get(type),
  });
}

export interface DurableJobV2Scheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const DEFAULT_SCHEDULER: DurableJobV2Scheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface RunNextDurableJobV2Options {
  readonly scope: DurableJobV2Scope;
  readonly workerId: string;
  readonly leaseMs: number;
  readonly heartbeatIntervalMs: number;
  readonly idPrefix?: string;
  readonly excludeIdPrefix?: string;
  readonly idAllowlist?: readonly string[];
  readonly registry: DurableJobV2AuthoritativeHandlerRegistry;
  readonly scheduler?: DurableJobV2Scheduler;
  readonly clock?: () => number;
  readonly signal?: AbortSignal;
}

type RepositoryOperation =
  | "listRunnableScopes"
  | "reap"
  | "quarantineUnknown"
  | "lease"
  | "renew"
  | "complete"
  | "fail";

export type RunNextDurableJobV2Result =
  | { readonly status: "idle" }
  | { readonly status: "completed"; readonly id: string; readonly type: string }
  | {
      readonly status: "retry_wait" | "dead_letter";
      readonly id: string;
      readonly type: string;
      readonly failureCode: string;
    }
  | {
      readonly status: "lease_lost";
      readonly operation: "renew";
      readonly id: string;
      readonly type: string;
    }
  | {
      readonly status: "stale";
      readonly operation: "complete" | "fail";
      readonly id: string;
      readonly type: string;
    }
  | {
      readonly status: "uncertain";
      readonly operation: RepositoryOperation;
      readonly code: "REPOSITORY_OUTCOME_UNCERTAIN";
      readonly id?: string;
      readonly type?: string;
    }
  | {
      readonly status: "error";
      readonly operation: RepositoryOperation | "protocol";
      readonly code: "INVALID_REPOSITORY_RESULT" | "INVALID_WORKER_OPTIONS";
      readonly id?: string;
      readonly type?: string;
    }
  | { readonly status: "aborted"; readonly id?: string; readonly type?: string };

function canonicalScope(scope: DurableJobV2Scope): DurableJobV2Scope {
  deriveDurableJobV2ScopedDedupeKey(scope, "worker-scope-validation");
  return Object.freeze({ ...scope });
}

function sameScope(left: DurableJobV2Scope, right: DurableJobV2Scope): boolean {
  return left.tenantId === right.tenantId && left.userId === right.userId &&
    left.appId === right.appId && left.projectId === right.projectId &&
    left.agentId === right.agentId && left.namespace === right.namespace &&
    left.visibility === right.visibility;
}

function validPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function canonicalIdAllowlist(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("durable job worker id allowlist is invalid");
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of value) {
    if (!isDurableJobV2SafeIdentifier(id) || seen.has(id)) {
      throw new Error("durable job worker id allowlist is invalid");
    }
    seen.add(id);
    result.push(id);
  }
  return Object.freeze(result);
}

function validateOptions(options: RunNextDurableJobV2Options): {
  readonly scope: DurableJobV2Scope;
  readonly authoritativeHandlerTypes: readonly string[];
  readonly idPrefix?: string;
  readonly excludeIdPrefix?: string;
  readonly idAllowlist?: readonly string[];
} {
  const scope = canonicalScope(options.scope);
  const idAllowlist = canonicalIdAllowlist(options.idAllowlist);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(options.workerId) ||
      !validPositiveInteger(options.leaseMs) ||
      !validPositiveInteger(options.heartbeatIntervalMs) ||
      options.heartbeatIntervalMs >= options.leaseMs || options.registry?.authoritative !== true ||
      (options.idPrefix !== undefined && options.idPrefix !== "history-job:") ||
      (options.excludeIdPrefix !== undefined && options.excludeIdPrefix !== "history-job:") ||
      (options.idPrefix !== undefined && options.excludeIdPrefix !== undefined) ||
      !Array.isArray(options.registry.types) || options.registry.types.length === 0 ||
      typeof options.registry?.get !== "function") {
    throw new Error("durable job worker options are invalid");
  }
  const now = (options.clock ?? Date.now)();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("durable job worker clock is invalid");
  }
  const registryContract = createDurableJobHandlerRegistry(options.registry.types);
  if (registryContract.types.length !== options.registry.types.length ||
      registryContract.types.some((type, index) => type !== options.registry.types[index])) {
    throw new Error("authoritative durable job handler registry is not canonical");
  }
  return {
    scope,
    authoritativeHandlerTypes: Object.freeze([...registryContract.types]),
    ...(options.idPrefix === undefined ? {} : { idPrefix: options.idPrefix }),
    ...(options.excludeIdPrefix === undefined
      ? {}
      : { excludeIdPrefix: options.excludeIdPrefix }),
    ...(idAllowlist === undefined ? {} : { idAllowlist }),
  };
}

function uncertain(
  operation: RepositoryOperation,
  job?: DurableJobV2,
): RunNextDurableJobV2Result {
  return {
    status: "uncertain",
    operation,
    code: "REPOSITORY_OUTCOME_UNCERTAIN",
    ...(job ? { id: job.id, type: job.type } : {}),
  };
}

function protocolError(
  operation: RepositoryOperation | "protocol",
  job?: DurableJobV2,
): RunNextDurableJobV2Result {
  return {
    status: "error",
    operation,
    code: "INVALID_REPOSITORY_RESULT",
    ...(job ? { id: job.id, type: job.type } : {}),
  };
}

function validateOperationResult(result: unknown): DurableJobV2OperationResult {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("invalid durable job repository result");
  }
  const candidate = result as { readonly applied?: unknown; readonly job?: unknown };
  if (candidate.applied !== 0 && candidate.applied !== 1) {
    throw new Error("invalid durable job repository applied discriminator");
  }
  if (candidate.job !== undefined) assertDurableJobV2(candidate.job as DurableJobV2);
  if (candidate.applied === 1 && candidate.job === undefined) {
    throw new Error("applied durable job repository result is missing job");
  }
  return candidate as DurableJobV2OperationResult;
}

function sameJobIdentity(actual: DurableJobV2, expected: DurableJobV2): boolean {
  return actual.id === expected.id && actual.type === expected.type &&
    sameScope(actual.scope, expected.scope);
}

function sameLeaseFence(actual: DurableJobV2, expected: DurableJobV2): boolean {
  return actual.leaseOwner === expected.leaseOwner &&
    actual.leaseToken === expected.leaseToken &&
    actual.leaseGeneration === expected.leaseGeneration;
}

function assertResultJobInIdAllowlist(
  result: DurableJobV2OperationResult,
  idAllowlist: readonly string[] | undefined,
): void {
  if (result.job !== undefined && idAllowlist !== undefined &&
      !idAllowlist.includes(result.job.id)) {
    throw new Error("durable job repository result escaped id allowlist");
  }
}

function validateReapResult(
  rawResult: unknown,
  scope: DurableJobV2Scope,
  idAllowlist: readonly string[] | undefined,
): DurableJobV2OperationResult {
  const result = validateOperationResult(rawResult);
  assertResultJobInIdAllowlist(result, idAllowlist);
  if (result.applied === 1 &&
      (result.job!.status !== "dead_letter" || !sameScope(result.job!.scope, scope) ||
       result.job!.lastError?.code !== "LEASE_EXPIRED" ||
       result.job!.lastError.retryable !== false)) {
    throw new Error("invalid reaped job transition");
  }
  return result;
}

function validateQuarantineUnknownResult(
  rawResult: unknown,
  scope: DurableJobV2Scope,
  authoritativeHandlerTypes: readonly string[],
  idAllowlist: readonly string[] | undefined,
): DurableJobV2 | undefined {
  const result = validateOperationResult(rawResult);
  assertResultJobInIdAllowlist(result, idAllowlist);
  if (result.applied === 0) {
    // CAS miss 可以携带刚才锁定的旧状态供诊断，但它仍必须是本 scope 下的
    // orphan candidate。否则继续 lease 会把 repository 的跨租户/错误 registry
    // 结果静默吞掉，破坏 worker 的 fail-closed 边界。
    if (result.job !== undefined &&
        (!sameScope(result.job.scope, scope) ||
         authoritativeHandlerTypes.includes(result.job.type) ||
         (result.job.status !== "queued" && result.job.status !== "retry_wait"))) {
      throw new Error("invalid unapplied orphan quarantine result");
    }
    return undefined;
  }
  const quarantined = result.job!;
  if (quarantined.status !== "dead_letter" || !sameScope(quarantined.scope, scope) ||
      authoritativeHandlerTypes.includes(quarantined.type) ||
      quarantined.lastError?.code !== "HANDLER_NOT_REGISTERED" ||
      quarantined.lastError.retryable !== false) {
    throw new Error("invalid quarantined durable job transition");
  }
  return quarantined;
}

function validateLeasedJob(
  rawResult: unknown,
  scope: DurableJobV2Scope,
  workerId: string,
  idAllowlist: readonly string[] | undefined,
): DurableJobV2 | undefined {
  const result = validateOperationResult(rawResult);
  assertResultJobInIdAllowlist(result, idAllowlist);
  if (result.applied === 0) return undefined;
  const leased = result.job!;
  if (leased.status !== "running" || !sameScope(leased.scope, scope) ||
      leased.leaseOwner !== workerId || !leased.leaseToken ||
      !validPositiveInteger(leased.leaseGeneration)) {
    throw new Error("invalid leased job");
  }
  return leased;
}

function validateRenewResult(
  rawResult: unknown,
  previous: DurableJobV2,
  leaseMs: number,
): DurableJobV2 | undefined {
  const result = validateOperationResult(rawResult);
  if (result.applied === 0) return undefined;
  const renewed = result.job!;
  if (renewed.status !== "running" || !sameJobIdentity(renewed, previous) ||
      !sameLeaseFence(renewed, previous) ||
      renewed.heartbeatAt! <= previous.heartbeatAt! ||
      renewed.updatedAt !== renewed.heartbeatAt ||
      renewed.leaseUntil !== renewed.heartbeatAt! + leaseMs ||
      renewed.leaseUntil! <= previous.leaseUntil!) {
    throw new Error("invalid renewed job transition");
  }
  return renewed;
}

function validateCompletedResult(
  rawResult: unknown,
  previous: DurableJobV2,
): DurableJobV2 | undefined {
  const result = validateOperationResult(rawResult);
  if (result.applied === 0) return undefined;
  const completed = result.job!;
  if (completed.status !== "completed" || !sameJobIdentity(completed, previous) ||
      completed.updatedAt < previous.updatedAt) {
    throw new Error("invalid completed job transition");
  }
  return completed;
}

function validateFailedResult(
  rawResult: unknown,
  previous: DurableJobV2,
  failure: { readonly code: string; readonly retryable: boolean },
): DurableJobV2 | undefined {
  const result = validateOperationResult(rawResult);
  if (result.applied === 0) return undefined;
  const failed = result.job!;
  const expectedStatus = !failure.retryable || previous.attempts >= previous.maxAttempts
    ? "dead_letter"
    : "retry_wait";
  if (failed.status !== expectedStatus || !sameJobIdentity(failed, previous) ||
      failed.updatedAt < previous.updatedAt || failed.lastError?.code !== failure.code ||
      failed.lastError.retryable !== failure.retryable) {
    throw new Error("invalid failed job transition");
  }
  return failed;
}

function fence(job: DurableJobV2, scope: DurableJobV2Scope): DurableJobV2FencedInput {
  return {
    id: job.id,
    scope,
    owner: job.leaseOwner!,
    leaseToken: job.leaseToken!,
    leaseGeneration: job.leaseGeneration,
  };
}

function safeHandlerFailure(error: unknown): { code: string; retryable: boolean } {
  if (error instanceof DurableJobV2HandlerFailure) {
    return { code: error.code, retryable: error.retryable };
  }
  return { code: "HANDLER_ERROR", retryable: true };
}

async function settleFailure(
  repository: DurableJobV2RepositoryPort,
  job: DurableJobV2,
  scope: DurableJobV2Scope,
  failure: { code: string; retryable: boolean },
): Promise<RunNextDurableJobV2Result> {
  let rawResult: unknown;
  try {
    rawResult = await repository.fail({ ...fence(job, scope), failure });
  } catch {
    return uncertain("fail", job);
  }
  let failed: DurableJobV2 | undefined;
  try {
    failed = validateFailedResult(rawResult, job, failure);
  } catch {
    return protocolError("fail", job);
  }
  if (!failed) {
    return { status: "stale", operation: "fail", id: job.id, type: job.type };
  }
  return {
    status: failed.status === "retry_wait" ? "retry_wait" : "dead_letter",
    id: job.id,
    type: job.type,
    failureCode: failure.code,
  };
}

/** 执行至多一个 job；任何 repository throw 都作为 uncertain 返回，不自动重放 handler。 */
export async function runNextDurableJobV2(
  repository: DurableJobV2RepositoryPort,
  options: RunNextDurableJobV2Options,
): Promise<RunNextDurableJobV2Result> {
  let scope: DurableJobV2Scope;
  let authoritativeHandlerTypes: readonly string[];
  let idPrefix: string | undefined;
  let excludeIdPrefix: string | undefined;
  let idAllowlist: readonly string[] | undefined;
  try {
    ({ scope, authoritativeHandlerTypes, idPrefix, excludeIdPrefix, idAllowlist } =
      validateOptions(options));
  } catch {
    return { status: "error", operation: "protocol", code: "INVALID_WORKER_OPTIONS" };
  }
  if (options.signal?.aborted) return { status: "aborted" };

  let rawReaped: unknown;
  try {
    rawReaped = await repository.reap({
      scope,
      ...(idPrefix ? { idPrefix } : {}),
      ...(excludeIdPrefix ? { excludeIdPrefix } : {}),
      ...(idAllowlist === undefined ? {} : { idAllowlist }),
    });
  } catch {
    return uncertain("reap");
  }
  try {
    validateReapResult(rawReaped, scope, idAllowlist);
  } catch {
    return protocolError("reap");
  }
  if (options.signal?.aborted) return { status: "aborted" };

  let rawQuarantined: unknown;
  try {
    rawQuarantined = await repository.quarantineUnknown({
      scope,
      authoritativeHandlerTypes,
      ...(idPrefix ? { idPrefix } : {}),
      ...(excludeIdPrefix ? { excludeIdPrefix } : {}),
      ...(idAllowlist === undefined ? {} : { idAllowlist }),
    });
  } catch {
    return uncertain("quarantineUnknown");
  }
  let quarantined: DurableJobV2 | undefined;
  try {
    quarantined = validateQuarantineUnknownResult(
      rawQuarantined,
      scope,
      authoritativeHandlerTypes,
      idAllowlist,
    );
  } catch {
    return protocolError("quarantineUnknown");
  }
  if (quarantined) {
    return {
      status: "dead_letter",
      id: quarantined.id,
      type: quarantined.type,
      failureCode: "HANDLER_NOT_REGISTERED",
    };
  }
  if (options.signal?.aborted) return { status: "aborted" };

  let rawLeaseResult: unknown;
  try {
    rawLeaseResult = await repository.lease({
      scope,
      owner: options.workerId,
      leaseMs: options.leaseMs,
      ...(idPrefix ? { idPrefix } : {}),
      ...(excludeIdPrefix ? { excludeIdPrefix } : {}),
      ...(idAllowlist === undefined ? {} : { idAllowlist }),
    });
  } catch {
    return uncertain("lease");
  }

  let job: DurableJobV2 | undefined;
  try {
    job = validateLeasedJob(rawLeaseResult, scope, options.workerId, idAllowlist);
  } catch {
    return protocolError("lease");
  }
  if (!job) return { status: "idle" };
  if (options.signal?.aborted) return { status: "aborted", id: job.id, type: job.type };

  let handler: DurableJobV2Handler | undefined;
  try {
    handler = options.registry.get(job.type);
  } catch {
    return protocolError("protocol", job);
  }
  if (!handler) {
    return settleFailure(repository, job, scope, {
      code: "HANDLER_NOT_REGISTERED",
      retryable: false,
    });
  }

  const scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
  const handlerAbort = new AbortController();
  let leaseState = job;
  let externalAborted = false;
  let finished = false;
  let heartbeatTimer: unknown;
  let heartbeatInFlight: Promise<void> = Promise.resolve();
  let boundaryReleased = false;
  let releaseBoundary!: () => void;
  const handlerBoundary = new Promise<void>((resolve) => {
    releaseBoundary = () => {
      if (boundaryReleased) return;
      boundaryReleased = true;
      resolve();
    };
  });
  const heartbeat = {
    state: "healthy" as "healthy" | "lost" | "uncertain" | "invalid",
    invalidOperation: "renew" as "renew" | "protocol",
  };

  const abortHandler = (reason: string) => {
    if (!handlerAbort.signal.aborted) handlerAbort.abort(reason);
  };
  const markHeartbeat = (
    state: "lost" | "uncertain" | "invalid",
    reason: string,
    invalidOperation: "renew" | "protocol" = "renew",
  ) => {
    if (heartbeat.state === "healthy") {
      heartbeat.state = state;
      if (state === "invalid") heartbeat.invalidOperation = invalidOperation;
    }
    abortHandler(reason);
    releaseBoundary();
  };
  const cancelHeartbeat = (): boolean => {
    const handle = heartbeatTimer;
    heartbeatTimer = undefined;
    if (handle === undefined) return true;
    try {
      scheduler.clearTimeout(handle);
      return true;
    } catch {
      markHeartbeat("invalid", "INVALID_SCHEDULER_RESULT", "protocol");
      return false;
    }
  };
  const onExternalAbort = () => {
    externalAborted = true;
    cancelHeartbeat();
    abortHandler("WORKER_STOPPED");
    releaseBoundary();
  };
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });

  const scheduleHeartbeat = (): boolean => {
    if (finished || externalAborted || heartbeat.state !== "healthy") return true;
    try {
      heartbeatTimer = scheduler.setTimeout(() => {
        heartbeatTimer = undefined;
        heartbeatInFlight = (async () => {
          let rawRenewed: unknown;
          try {
            rawRenewed = await repository.renew({
              ...fence(leaseState, scope),
              leaseMs: options.leaseMs,
            });
          } catch {
            markHeartbeat("uncertain", "RENEW_OUTCOME_UNCERTAIN");
            return;
          }
          let renewed: DurableJobV2 | undefined;
          try {
            renewed = validateRenewResult(rawRenewed, leaseState, options.leaseMs);
          } catch {
            markHeartbeat("invalid", "INVALID_REPOSITORY_RESULT");
            return;
          }
          if (!renewed) {
            markHeartbeat("lost", "LEASE_LOST");
            return;
          }
          leaseState = renewed;
          scheduleHeartbeat();
        })();
        void heartbeatInFlight.catch(() => {
          markHeartbeat("uncertain", "RENEW_OUTCOME_UNCERTAIN");
        });
      }, options.heartbeatIntervalMs);
      return true;
    } catch {
      markHeartbeat("invalid", "INVALID_SCHEDULER_RESULT", "protocol");
      return false;
    }
  };
  if (options.signal?.aborted) onExternalAbort();
  if (externalAborted) {
    options.signal?.removeEventListener("abort", onExternalAbort);
    return { status: "aborted", id: job.id, type: job.type };
  }
  if (!scheduleHeartbeat()) {
    options.signal?.removeEventListener("abort", onExternalAbort);
    return protocolError("protocol", job);
  }

  const handlerOutcome = Promise.resolve()
    .then(() => handler(job, { signal: handlerAbort.signal, workerId: options.workerId }))
    .then(
      () => ({ kind: "success" as const }),
      (error: unknown) => ({ kind: "failure" as const, error }),
    );
  const winner = await Promise.race([
    handlerOutcome.then((outcome) => ({ source: "handler" as const, outcome })),
    handlerBoundary.then(() => ({ source: "boundary" as const })),
  ]);
  finished = true;
  cancelHeartbeat();
  if (winner.source === "handler") {
    await heartbeatInFlight;
  }
  options.signal?.removeEventListener("abort", onExternalAbort);

  if (externalAborted || options.signal?.aborted) {
    return { status: "aborted", id: job.id, type: job.type };
  }
  if (heartbeat.state === "lost") {
    return { status: "lease_lost", operation: "renew", id: job.id, type: job.type };
  }
  if (heartbeat.state === "uncertain") return uncertain("renew", job);
  if (heartbeat.state === "invalid") return protocolError(heartbeat.invalidOperation, job);
  if (winner.source !== "handler") return protocolError("protocol", job);
  if (winner.outcome.kind === "failure") {
    return settleFailure(repository, leaseState, scope, safeHandlerFailure(winner.outcome.error));
  }

  let rawCompleted: unknown;
  try {
    rawCompleted = await repository.complete(fence(leaseState, scope));
  } catch {
    return uncertain("complete", job);
  }
  let completed: DurableJobV2 | undefined;
  try {
    completed = validateCompletedResult(rawCompleted, leaseState);
  } catch {
    return protocolError("complete", job);
  }
  if (!completed) {
    return { status: "stale", operation: "complete", id: job.id, type: job.type };
  }
  return { status: "completed", id: job.id, type: job.type };
}

export interface DurableJobV2WorkerLoopOptions extends RunNextDurableJobV2Options {
  readonly intervalMs: number;
  readonly maxPerTick?: number;
  readonly stopTimeoutMs: number;
}

export interface DurableJobV2WorkerStopOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface DurableJobV2WorkerLoopHandle {
  tick(): Promise<RunNextDurableJobV2Result[]>;
  stop(options?: DurableJobV2WorkerStopOptions): Promise<{
    status: "stopped" | "timeout" | "aborted";
  }>;
  snapshot?(): DurableJobV2WorkerHealthSnapshot;
}

export interface DurableJobV2WorkerHealthSnapshot {
  readonly state: "healthy" | "backoff" | "open" | "half_open" | "stopped";
  readonly ready: boolean;
  readonly consecutiveFailures: number;
  readonly failingScopes: number;
  readonly nextRetryAt?: number;
  readonly providerState?: "healthy" | "backoff" | "open" | "half_open" | "stopped";
  readonly providerConsecutiveFailures?: number;
  readonly providerNextRetryAt?: number;
  readonly scopeBackoffCount?: number;
  readonly scopeOpenCount?: number;
  readonly scopeHalfOpenCount?: number;
}

export function startDurableJobV2WorkerLoop(
  repository: DurableJobV2RepositoryPort,
  options: DurableJobV2WorkerLoopOptions,
): DurableJobV2WorkerLoopHandle {
  if (!validPositiveInteger(options.intervalMs) ||
      !validPositiveInteger(options.stopTimeoutMs) ||
      (options.maxPerTick !== undefined && !validPositiveInteger(options.maxPerTick))) {
    throw new Error("durable job worker loop options are invalid");
  }
  const scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
  const maxPerTick = options.maxPerTick ?? 50;
  const loopAbort = new AbortController();
  let stopped = false;
  let timer: unknown;
  let activeTick: Promise<RunNextDurableJobV2Result[]> | undefined;

  const stopForSchedulerFailure = () => {
    stopped = true;
    timer = undefined;
    if (!loopAbort.signal.aborted) loopAbort.abort("SCHEDULER_FAILURE");
  };
  const clearScheduledTimer = (): boolean => {
    const handle = timer;
    timer = undefined;
    if (handle === undefined) return true;
    try {
      scheduler.clearTimeout(handle);
      return true;
    } catch {
      stopForSchedulerFailure();
      return false;
    }
  };
  const scheduleNext = (): boolean => {
    if (stopped) return false;
    try {
      timer = scheduler.setTimeout(() => {
        timer = undefined;
        void tick().then(
          () => { scheduleNext(); },
          () => { scheduleNext(); },
        );
      }, options.intervalMs);
      return true;
    } catch {
      stopForSchedulerFailure();
      return false;
    }
  };

  const drain = async (): Promise<RunNextDurableJobV2Result[]> => {
    const results: RunNextDurableJobV2Result[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < maxPerTick && !loopAbort.signal.aborted; index += 1) {
      const result = await runNextDurableJobV2(repository, {
        ...options,
        scheduler,
        signal: loopAbort.signal,
      });
      results.push(result);
      if (result.status === "idle" || result.status === "uncertain" ||
          result.status === "error" || result.status === "aborted" ||
          result.status === "lease_lost") break;
      if ("id" in result && typeof result.id === "string") {
        if (seen.has(result.id)) break;
        seen.add(result.id);
      }
    }
    return results;
  };

  const tick = (): Promise<RunNextDurableJobV2Result[]> => {
    if (stopped) return Promise.resolve([]);
    if (activeTick) return activeTick;
    activeTick = drain().finally(() => {
      activeTick = undefined;
    });
    return activeTick;
  };

  scheduleNext();

  return {
    tick,
    async stop(stopOptions: DurableJobV2WorkerStopOptions = {}) {
      stopped = true;
      clearScheduledTimer();
      if (!loopAbort.signal.aborted) loopAbort.abort("WORKER_STOPPED");
      if (!activeTick) return { status: "stopped" };

      const timeoutMs = stopOptions.timeoutMs ?? options.stopTimeoutMs;
      if (!validPositiveInteger(timeoutMs)) throw new Error("worker stop timeout is invalid");
      if (stopOptions.signal?.aborted) return { status: "aborted" };

      let timeoutHandle: unknown;
      let onStopAbort: (() => void) | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        try {
          timeoutHandle = scheduler.setTimeout(() => resolve("timeout"), timeoutMs);
        } catch {
          resolve("timeout");
        }
      });
      const externallyAborted = new Promise<"aborted">((resolve) => {
        onStopAbort = () => resolve("aborted");
        stopOptions.signal?.addEventListener("abort", onStopAbort, { once: true });
      });
      const outcome = await Promise.race([
        activeTick.then(() => "stopped" as const, () => "stopped" as const),
        timeout,
        externallyAborted,
      ]);
      if (timeoutHandle !== undefined) {
        try {
          scheduler.clearTimeout(timeoutHandle);
        } catch {
          stopForSchedulerFailure();
        }
      }
      if (onStopAbort) stopOptions.signal?.removeEventListener("abort", onStopAbort);
      return { status: outcome };
    },
  };
}

export interface BroadAuthorityDurableJobV2SupervisorOptions {
  readonly authority: AuthorityScope;
  readonly workerId: string;
  readonly leaseMs: number;
  readonly heartbeatIntervalMs: number;
  readonly registry: DurableJobV2AuthoritativeHandlerRegistry;
  readonly scheduler?: DurableJobV2Scheduler;
  readonly clock?: () => number;
  readonly signal?: AbortSignal;
  readonly intervalMs: number;
  readonly maxScopesPerTick: number;
  readonly maxJobsPerTick: number;
  readonly stopTimeoutMs: number;
  readonly failureBackoffBaseMs?: number;
  readonly failureBackoffMaxMs?: number;
  readonly circuitFailureThreshold?: number;
  readonly circuitResetMs?: number;
  readonly jitterRatio?: number;
  readonly random?: () => number;
}

export interface BroadAuthorityDurableJobV2SupervisorHandle {
  tick(): Promise<RunNextDurableJobV2Result[]>;
  stop(options?: DurableJobV2WorkerStopOptions): Promise<{
    status: "stopped" | "timeout" | "aborted";
  }>;
  snapshot(): DurableJobV2WorkerHealthSnapshot;
}

const MAX_BROAD_AUTHORITY_SCOPES_PER_TICK = 1_000;

function authorityRequestSeed(authority: AuthorityScope): ClientAuthorityScopeRequest {
  const allow = authority && typeof authority === "object" && !Array.isArray(authority)
    ? (authority as { readonly allow?: unknown }).allow
    : undefined;
  const candidate = allow && typeof allow === "object" && !Array.isArray(allow)
    ? allow as Record<string, unknown>
    : {};
  const first = (field: string): unknown => {
    const values = candidate[field];
    return Array.isArray(values) ? values[0] : undefined;
  };
  return {
    appId: first("appIds") as string,
    projectId: first("projectIds") as string,
    agentId: first("agentIds") as string,
    namespace: first("namespaces") as string,
    visibility: first("visibilities") as DurableJobV2Scope["visibility"],
  };
}

function canonicalBroadAuthority(authority: AuthorityScope): {
  readonly authority: AuthorityScope;
  readonly probeScope: DurableJobV2Scope;
} {
  const seed = authorityRequestSeed(authority);
  const resolved = resolveAuthorityScope(authority, seed);
  const snapshot = Object.freeze({
    tenantId: resolved.tenantId,
    userId: resolved.userId,
    ...(resolved.workspaceId === undefined ? {} : { workspaceId: resolved.workspaceId }),
    ...(resolved.sessionId === undefined ? {} : { sessionId: resolved.sessionId }),
    allow: Object.freeze({
      appIds: Object.freeze([...authority.allow.appIds]),
      projectIds: Object.freeze([...authority.allow.projectIds]),
      agentIds: Object.freeze([...authority.allow.agentIds]),
      namespaces: Object.freeze([...authority.allow.namespaces]),
      visibilities: Object.freeze([...authority.allow.visibilities]),
    }),
  });
  return {
    authority: snapshot,
    probeScope: canonicalScope({
      tenantId: resolved.tenantId,
      userId: resolved.userId,
      appId: resolved.appId,
      projectId: resolved.projectId,
      agentId: resolved.agentId,
      namespace: resolved.namespace,
      visibility: resolved.visibility!,
    }),
  };
}

function validateDiscoveredScopes(
  raw: unknown,
  authority: AuthorityScope,
  limit: number,
): readonly DurableJobV2Scope[] {
  if (!Array.isArray(raw) || raw.length > limit) {
    throw new Error("durable job runnable scope result is invalid");
  }
  const result: DurableJobV2Scope[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    const candidate = canonicalScope(value as DurableJobV2Scope);
    const resolved = resolveAuthorityScope(authority, {
      appId: candidate.appId,
      projectId: candidate.projectId,
      agentId: candidate.agentId,
      namespace: candidate.namespace,
      visibility: candidate.visibility,
    });
    const exact = canonicalScope({
      tenantId: resolved.tenantId,
      userId: resolved.userId,
      appId: resolved.appId,
      projectId: resolved.projectId,
      agentId: resolved.agentId,
      namespace: resolved.namespace,
      visibility: resolved.visibility!,
    });
    if (!sameScope(candidate, exact)) {
      throw new Error("durable job runnable scope escaped authority");
    }
    const key = deriveDurableJobV2ScopedDedupeKey(exact, "supervisor-scope-validation");
    if (seen.has(key)) throw new Error("durable job runnable scopes are duplicated");
    seen.add(key);
    result.push(exact);
  }
  return Object.freeze(result);
}

/**
 * Broad authority 只用于 provider discovery；实际执行始终回落到已复核的 exact 7D scope。
 * 每个 tick 对真实 scope 做 round-robin，绝不展开 allowlist 的笛卡尔积。
 */
export function startBroadAuthorityDurableJobV2Supervisor(
  repository: BroadAuthorityDurableJobV2RepositoryPort,
  options: BroadAuthorityDurableJobV2SupervisorOptions,
): BroadAuthorityDurableJobV2SupervisorHandle {
  const failureBackoffBaseMs = options.failureBackoffBaseMs ?? Math.max(options.intervalMs, 100);
  const failureBackoffMaxMs = options.failureBackoffMaxMs ?? 30_000;
  const circuitFailureThreshold = options.circuitFailureThreshold ?? 5;
  const circuitResetMs = options.circuitResetMs ?? 30_000;
  const jitterRatio = options.jitterRatio ?? 0.2;
  const random = options.random ?? Math.random;
  let authority: AuthorityScope;
  let probeScope: DurableJobV2Scope;
  try {
    ({ authority, probeScope } = canonicalBroadAuthority(options.authority));
    validateOptions({
      scope: probeScope,
      workerId: options.workerId,
      leaseMs: options.leaseMs,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      registry: options.registry,
      ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
    if (!repository || typeof repository.listRunnableScopes !== "function" ||
        !validPositiveInteger(options.intervalMs) ||
        !validPositiveInteger(options.stopTimeoutMs) ||
        !validPositiveInteger(options.maxScopesPerTick) ||
        options.maxScopesPerTick > MAX_BROAD_AUTHORITY_SCOPES_PER_TICK ||
        !validPositiveInteger(options.maxJobsPerTick) ||
        !validPositiveInteger(failureBackoffBaseMs) ||
        !validPositiveInteger(failureBackoffMaxMs) ||
        failureBackoffMaxMs < failureBackoffBaseMs ||
        !validPositiveInteger(circuitFailureThreshold) ||
        !validPositiveInteger(circuitResetMs) ||
        !Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1 ||
        typeof random !== "function") {
      throw new Error("invalid supervisor options");
    }
  } catch {
    throw new Error("durable job broad authority supervisor options are invalid");
  }

  const scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
  const supervisorAbort = new AbortController();
  let stopped = false;
  let timer: unknown;
  let activeTick: Promise<RunNextDurableJobV2Result[]> | undefined;
  let discoveryCursor: DurableJobV2Scope | undefined;
  const providerFailure = {
    consecutiveFailures: 0,
    nextRetryAt: 0,
    circuitOpen: false,
  };
  const scopeFailures = new Map<string, {
    readonly scope: DurableJobV2Scope;
    consecutiveFailures: number;
    nextRetryAt: number;
    circuitOpen: boolean;
  }>();

  const now = (): number => {
    const value = (options.clock ?? Date.now)();
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  };
  const failureDelay = (consecutiveFailures: number): number => {
    const exponent = Math.min(consecutiveFailures - 1, 30);
    const base = Math.min(failureBackoffMaxMs, failureBackoffBaseMs * (2 ** exponent));
    const sample = random();
    const boundedSample = Number.isFinite(sample) && sample >= 0 && sample <= 1 ? sample : 0.5;
    return Math.max(1, Math.round(base * (1 - jitterRatio + (2 * jitterRatio * boundedSample))));
  };
  const recordProviderFailure = () => {
    providerFailure.consecutiveFailures += 1;
    providerFailure.circuitOpen =
      providerFailure.consecutiveFailures >= circuitFailureThreshold;
    providerFailure.nextRetryAt = now() + (providerFailure.circuitOpen
      ? circuitResetMs
      : failureDelay(providerFailure.consecutiveFailures));
  };
  const recordProviderSuccess = () => {
    providerFailure.consecutiveFailures = 0;
    providerFailure.nextRetryAt = 0;
    providerFailure.circuitOpen = false;
  };
  const scopeKey = (scope: DurableJobV2Scope): string =>
    deriveDurableJobV2ScopedDedupeKey(scope, "worker-health");
  const recordScopeFailure = (scope: DurableJobV2Scope) => {
    const key = scopeKey(scope);
    const state = scopeFailures.get(key) ?? {
      scope,
      consecutiveFailures: 0,
      nextRetryAt: 0,
      circuitOpen: false,
    };
    state.consecutiveFailures += 1;
    state.circuitOpen = state.consecutiveFailures >= circuitFailureThreshold;
    state.nextRetryAt = now() + (state.circuitOpen
      ? circuitResetMs
      : failureDelay(state.consecutiveFailures));
    scopeFailures.set(key, state);
  };
  const recordScopeSuccess = (scope: DurableJobV2Scope) => {
    scopeFailures.delete(scopeKey(scope));
  };
  const scopeCanRun = (scope: DurableJobV2Scope): boolean => {
    const state = scopeFailures.get(scopeKey(scope));
    return state === undefined || now() >= state.nextRetryAt;
  };
  const failureState = (failure: {
    consecutiveFailures: number;
    nextRetryAt: number;
    circuitOpen: boolean;
  }): "healthy" | "backoff" | "open" | "half_open" => {
    if (failure.consecutiveFailures === 0) return "healthy";
    if (!failure.circuitOpen) return "backoff";
    return now() >= failure.nextRetryAt ? "half_open" : "open";
  };
  const healthSnapshot = (): DurableJobV2WorkerHealthSnapshot => {
    const providerState = stopped ? "stopped" as const : failureState(providerFailure);
    const scopeStates = [...scopeFailures.values()].map(failureState);
    const scopeBackoffCount = scopeStates.filter((state) => state === "backoff").length;
    const scopeOpenCount = scopeStates.filter((state) => state === "open").length;
    const scopeHalfOpenCount = scopeStates.filter((state) => state === "half_open").length;
    const maxScopeFailures = Math.max(
      0,
      ...[...scopeFailures.values()].map((state) => state.consecutiveFailures),
    );
    const scopeNextRetryAt = Math.min(
      Number.POSITIVE_INFINITY,
      ...[...scopeFailures.values()].map((state) => state.nextRetryAt),
    );
    const consecutiveFailures = providerFailure.consecutiveFailures || maxScopeFailures;
    const nextRetryAt = providerFailure.consecutiveFailures > 0
      ? providerFailure.nextRetryAt
      : Number.isFinite(scopeNextRetryAt) ? scopeNextRetryAt : undefined;
    const state = stopped
      ? "stopped" as const
      : providerState !== "healthy"
        ? providerState
        : scopeHalfOpenCount > 0
          ? "half_open" as const
          : scopeOpenCount > 0
            ? "open" as const
            : scopeBackoffCount > 0 ? "backoff" as const : "healthy" as const;
    if (stopped) {
      return Object.freeze({
        state,
        ready: false,
        consecutiveFailures,
        failingScopes: scopeFailures.size,
        providerState,
        providerConsecutiveFailures: providerFailure.consecutiveFailures,
        ...(providerFailure.nextRetryAt > 0
          ? { providerNextRetryAt: providerFailure.nextRetryAt }
          : {}),
        scopeBackoffCount,
        scopeOpenCount,
        scopeHalfOpenCount,
      });
    }
    return Object.freeze({
      state,
      ready: state === "healthy",
      consecutiveFailures,
      failingScopes: scopeFailures.size,
      ...(nextRetryAt === undefined ? {} : { nextRetryAt }),
      providerState,
      providerConsecutiveFailures: providerFailure.consecutiveFailures,
      ...(providerFailure.nextRetryAt > 0
        ? { providerNextRetryAt: providerFailure.nextRetryAt }
        : {}),
      scopeBackoffCount,
      scopeOpenCount,
      scopeHalfOpenCount,
    });
  };

  const stopForSchedulerFailure = () => {
    stopped = true;
    timer = undefined;
    if (!supervisorAbort.signal.aborted) supervisorAbort.abort("SCHEDULER_FAILURE");
  };
  const clearScheduledTimer = (): boolean => {
    const handle = timer;
    timer = undefined;
    if (handle === undefined) return true;
    try {
      scheduler.clearTimeout(handle);
      return true;
    } catch {
      stopForSchedulerFailure();
      return false;
    }
  };
  const onExternalAbort = () => {
    stopped = true;
    clearScheduledTimer();
    if (!supervisorAbort.signal.aborted) supervisorAbort.abort("WORKER_STOPPED");
  };
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (options.signal?.aborted) onExternalAbort();

  const drain = async (): Promise<RunNextDurableJobV2Result[]> => {
    if (supervisorAbort.signal.aborted) return [{ status: "aborted" }];
    if (providerFailure.consecutiveFailures > 0 && now() < providerFailure.nextRetryAt) return [];
    let rawScopes: unknown;
    try {
      rawScopes = discoveryCursor
        ? await repository.listRunnableScopes(
            authority,
            options.maxScopesPerTick,
            discoveryCursor,
          )
        : await repository.listRunnableScopes(authority, options.maxScopesPerTick);
    } catch {
      if (supervisorAbort.signal.aborted) return [{ status: "aborted" }];
      recordProviderFailure();
      return [{
            status: "uncertain",
            operation: "listRunnableScopes",
            code: "REPOSITORY_OUTCOME_UNCERTAIN",
          }];
    }
    if (supervisorAbort.signal.aborted) return [{ status: "aborted" }];
    let scopes: readonly DurableJobV2Scope[];
    try {
      scopes = validateDiscoveredScopes(rawScopes, authority, options.maxScopesPerTick);
    } catch {
      recordProviderFailure();
      return [{
        status: "error",
        operation: "listRunnableScopes",
        code: "INVALID_REPOSITORY_RESULT",
      }];
    }
    recordProviderSuccess();
    if (scopes.length > 0) discoveryCursor = scopes[scopes.length - 1];

    const discoveredScopeKeys = new Set(scopes.map(scopeKey));
    const halfOpenScopes = [...scopeFailures.entries()]
      .filter(([key, state]) =>
        state.circuitOpen && now() >= state.nextRetryAt && !discoveredScopeKeys.has(key))
      .map(([, state]) => state.scope);
    const queue = [...halfOpenScopes, ...scopes.filter(scopeCanRun)];
    const results: RunNextDurableJobV2Result[] = [];
    const seenJobs = new Set<string>();
    while (queue.length > 0 && results.length < options.maxJobsPerTick &&
        !supervisorAbort.signal.aborted) {
      const scope = queue.shift()!;
      const result = await runNextDurableJobV2(repository, {
        scope,
        workerId: options.workerId,
        leaseMs: options.leaseMs,
        heartbeatIntervalMs: options.heartbeatIntervalMs,
        registry: options.registry,
        scheduler,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        excludeIdPrefix: "history-job:",
        signal: supervisorAbort.signal,
      });
      results.push(result);
      if (result.status === "uncertain" || result.status === "error") {
        recordScopeFailure(scope);
        continue;
      }
      recordScopeSuccess(scope);
      if (result.status === "aborted") break;
      if (result.status === "lease_lost") continue;
      if (result.status === "idle") continue;
      if ("id" in result && typeof result.id === "string") {
        if (seenJobs.has(result.id)) break;
        seenJobs.add(result.id);
      }
      queue.push(scope);
    }
    return results;
  };

  const tick = (): Promise<RunNextDurableJobV2Result[]> => {
    if (stopped) return Promise.resolve([]);
    if (activeTick) return activeTick;
    activeTick = drain().finally(() => {
      activeTick = undefined;
    });
    return activeTick;
  };
  const scheduleNext = (): boolean => {
    if (stopped) return false;
    try {
      const retryDelay = providerFailure.consecutiveFailures > 0
        ? Math.max(1, providerFailure.nextRetryAt - now())
        : 0;
      timer = scheduler.setTimeout(() => {
        timer = undefined;
        void tick().then(
          () => { scheduleNext(); },
          () => { scheduleNext(); },
        );
      }, Math.max(options.intervalMs, retryDelay));
      return true;
    } catch {
      stopForSchedulerFailure();
      return false;
    }
  };
  scheduleNext();

  return {
    tick,
    snapshot: healthSnapshot,
    async stop(stopOptions: DurableJobV2WorkerStopOptions = {}) {
      const timeoutMs = stopOptions.timeoutMs ?? options.stopTimeoutMs;
      if (!validPositiveInteger(timeoutMs)) throw new Error("worker stop timeout is invalid");
      stopped = true;
      clearScheduledTimer();
      if (!supervisorAbort.signal.aborted) supervisorAbort.abort("WORKER_STOPPED");
      options.signal?.removeEventListener("abort", onExternalAbort);
      if (!activeTick) return { status: "stopped" };
      if (stopOptions.signal?.aborted) return { status: "aborted" };

      let timeoutHandle: unknown;
      let onStopAbort: (() => void) | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        try {
          timeoutHandle = scheduler.setTimeout(() => resolve("timeout"), timeoutMs);
        } catch {
          resolve("timeout");
        }
      });
      const externallyAborted = new Promise<"aborted">((resolve) => {
        onStopAbort = () => resolve("aborted");
        stopOptions.signal?.addEventListener("abort", onStopAbort, { once: true });
      });
      const outcome = await Promise.race([
        activeTick.then(() => "stopped" as const, () => "stopped" as const),
        timeout,
        externallyAborted,
      ]);
      if (timeoutHandle !== undefined) {
        try {
          scheduler.clearTimeout(timeoutHandle);
        } catch {
          stopForSchedulerFailure();
        }
      }
      if (onStopAbort) stopOptions.signal?.removeEventListener("abort", onStopAbort);
      return { status: outcome };
    },
  };
}
