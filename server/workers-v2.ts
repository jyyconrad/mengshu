import {
  assertDurableJobV2,
  createDurableJobHandlerRegistry,
  deriveDurableJobV2ScopedDedupeKey,
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
  reap(input: { readonly scope: DurableJobV2Scope }): Promise<DurableJobV2OperationResult>;
  quarantineUnknown(input: {
    readonly scope: DurableJobV2Scope;
    /** 当前 runtime 的完整 handler 集合；partial worker pool 子集禁止传入。 */
    readonly authoritativeHandlerTypes: readonly string[];
  }): Promise<DurableJobV2OperationResult>;
  lease(input: {
    readonly scope: DurableJobV2Scope;
    readonly owner: string;
    readonly leaseMs: number;
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
  readonly registry: DurableJobV2AuthoritativeHandlerRegistry;
  readonly scheduler?: DurableJobV2Scheduler;
  readonly clock?: () => number;
  readonly signal?: AbortSignal;
}

type RepositoryOperation =
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

function validateOptions(options: RunNextDurableJobV2Options): {
  readonly scope: DurableJobV2Scope;
  readonly authoritativeHandlerTypes: readonly string[];
} {
  const scope = canonicalScope(options.scope);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(options.workerId) ||
      !validPositiveInteger(options.leaseMs) ||
      !validPositiveInteger(options.heartbeatIntervalMs) ||
      options.heartbeatIntervalMs >= options.leaseMs || options.registry?.authoritative !== true ||
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

function validateReapResult(
  rawResult: unknown,
  scope: DurableJobV2Scope,
): DurableJobV2OperationResult {
  const result = validateOperationResult(rawResult);
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
): DurableJobV2 | undefined {
  const result = validateOperationResult(rawResult);
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
): DurableJobV2 | undefined {
  const result = validateOperationResult(rawResult);
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
  try {
    ({ scope, authoritativeHandlerTypes } = validateOptions(options));
  } catch {
    return { status: "error", operation: "protocol", code: "INVALID_WORKER_OPTIONS" };
  }
  if (options.signal?.aborted) return { status: "aborted" };

  let rawReaped: unknown;
  try {
    rawReaped = await repository.reap({ scope });
  } catch {
    return uncertain("reap");
  }
  try {
    validateReapResult(rawReaped, scope);
  } catch {
    return protocolError("reap");
  }
  if (options.signal?.aborted) return { status: "aborted" };

  let rawQuarantined: unknown;
  try {
    rawQuarantined = await repository.quarantineUnknown({
      scope,
      authoritativeHandlerTypes,
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
    });
  } catch {
    return uncertain("lease");
  }

  let job: DurableJobV2 | undefined;
  try {
    job = validateLeasedJob(rawLeaseResult, scope, options.workerId);
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
      if ("id" in result) {
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
