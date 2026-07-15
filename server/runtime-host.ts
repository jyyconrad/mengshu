import {
  RuntimeLifecycle,
  RuntimeLifecycleError,
  type RuntimeLifecycleState,
  type RuntimeLifecycleStep,
  type RuntimeLifecycleStepResult,
} from "../packages/core/src/runtime/runtime-lifecycle.js";
import type {
  DurableJobV2WorkerLoopHandle,
} from "./workers-v2.js";

export type RuntimeHostErrorCode =
  | "HOST_INVALID_CONFIG"
  | "HOST_START_FAILED"
  | "HOST_STOP_FAILED"
  | "HOST_STOPPING";

/** 对外错误只暴露稳定错误码，不转发 provider、连接串或 handler 原始异常。 */
export class RuntimeHostError extends Error {
  readonly code: RuntimeHostErrorCode;

  constructor(code: RuntimeHostErrorCode) {
    super("Runtime host operation failed");
    this.name = "RuntimeHostError";
    this.code = code;
  }
}

export interface RuntimeHostBoundaryScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const DEFAULT_SCHEDULER: RuntimeHostBoundaryScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface RuntimeHostOptions {
  /** 按声明顺序初始化、按逆序关闭的 runtime 依赖。 */
  readonly dependencies: readonly RuntimeLifecycleStep[];
  /** 仅在所有依赖均 ready 后调用。Host 不负责构造真实 repository/runtime。 */
  readonly startWorker: () => DurableJobV2WorkerLoopHandle;
  /**
   * 可选的无业务副作用健康探测。禁止用 tick/lease/handler 充当 probe。
   * 未注入时，依赖 ready 且 worker loop 构造成功即视为启动完成。
   */
  readonly probeWorker?: () => Promise<RuntimeHostWorkerProbeResult> | RuntimeHostWorkerProbeResult;
  /** 显式 probe 的硬边界；超时只会降级，避免启动/停止竞态永久挂起。 */
  readonly workerProbeTimeoutMs: number;
  /** 传给 worker，同时由 Host 再施加一次硬边界。 */
  readonly workerStopTimeoutMs: number;
  readonly scheduler?: RuntimeHostBoundaryScheduler;
}

export type RuntimeHostWorkerProbeResult =
  | { readonly status: "ready" }
  | { readonly status: "uncertain" | "unavailable" };

export interface RuntimeHostIssue {
  readonly component: string;
  readonly code:
    | "DEPENDENCY_DEGRADED"
    | "DEPENDENCIES_NOT_READY"
    | "WORKER_NOT_READY"
    | "WORKER_PROBE_FAILED"
    | "WORKER_PROBE_TIMEOUT";
}

export interface RuntimeHostSnapshot {
  readonly state: RuntimeLifecycleState;
  readonly ready: boolean;
  readonly accepting: boolean;
  readonly generation: number;
  readonly issues?: readonly RuntimeHostIssue[];
  readonly failureCode?: "HOST_START_FAILED" | "HOST_STOP_FAILED";
}

interface RuntimeHostCycle {
  readonly generation: number;
  readonly lifecycle: RuntimeLifecycle;
  readonly issues: RuntimeHostIssue[];
  startPromise: Promise<void>;
  stopPromise?: Promise<void>;
  readonly workerCleanup: RuntimeHostWorkerCleanup;
}

interface RuntimeHostWorkerCleanup {
  promise?: Promise<unknown>;
  complete: boolean;
}

type BoundaryResult<T> =
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "rejected" }
  | { readonly kind: "timeout" }
  | { readonly kind: "scheduler_failure" };

const COMPONENT_NAME = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validWorkerProbe(result: unknown): result is RuntimeHostWorkerProbeResult {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return false;
  const status = (result as { status?: unknown }).status;
  return status === "ready" || status === "uncertain" || status === "unavailable";
}

/**
 * RuntimeHostBoundaryScheduler 由上层注入，便于以手动时钟验证所有停机边界。
 * promise 的 resolve/reject handler 在建 timer 时即注册，迟到 rejection 不会变成 unhandled。
 */
function withinBoundary<T>(
  promise: Promise<T>,
  timeoutMs: number,
  scheduler: RuntimeHostBoundaryScheduler,
): Promise<BoundaryResult<T>> {
  return new Promise((resolve) => {
    let settled = false;
    let timerCreated = false;
    let timer: unknown;
    const finish = (result: BoundaryResult<T>) => {
      if (settled) return;
      settled = true;
      if (timerCreated) {
        try {
          scheduler.clearTimeout(timer);
        } catch {
          // 边界已经决议；清 timer 失败不得把成功改写成 raw scheduler 异常。
        }
      }
      resolve(result);
    };

    promise.then(
      (value) => { finish({ kind: "value", value }); },
      () => { finish({ kind: "rejected" }); },
    );
    try {
      timer = scheduler.setTimeout(() => { finish({ kind: "timeout" }); }, timeoutMs);
      timerCreated = true;
    } catch {
      finish({ kind: "scheduler_failure" });
    }
  });
}

function validateOptions(options: RuntimeHostOptions): void {
  if (!options || !Array.isArray(options.dependencies) ||
      typeof options.startWorker !== "function" ||
      (options.probeWorker !== undefined && typeof options.probeWorker !== "function") ||
      !positiveSafeInteger(options.workerProbeTimeoutMs) ||
      !positiveSafeInteger(options.workerStopTimeoutMs)) {
    throw new RuntimeHostError("HOST_INVALID_CONFIG");
  }
  const scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
  if (typeof scheduler.setTimeout !== "function" || typeof scheduler.clearTimeout !== "function") {
    throw new RuntimeHostError("HOST_INVALID_CONFIG");
  }
  const names = new Set<string>();
  for (const dependency of options.dependencies) {
    if (!dependency || !COMPONENT_NAME.test(dependency.name) || dependency.name === "worker" ||
        typeof dependency.start !== "function" ||
        (dependency.stop !== undefined && typeof dependency.stop !== "function") ||
        names.has(dependency.name)) {
      throw new RuntimeHostError("HOST_INVALID_CONFIG");
    }
    names.add(dependency.name);
  }
}

/**
 * 可重启、注入式的纯 Runtime Host 核心。
 *
 * 它不监听 signal、不打开真实数据库，也不拥有 daemon；上层只需注入资源和 worker factory。
 * 每次 restart 都创建新的 RuntimeLifecycle，避免复用已关闭的 lifecycle 实例。
 */
export class RuntimeHost {
  private readonly scheduler: RuntimeHostBoundaryScheduler;
  private current?: RuntimeHostCycle;
  private state: RuntimeLifecycleState = "created";
  private accepting = false;
  private generation = 1;
  private startedOnce = false;
  private failureCode?: "HOST_START_FAILED" | "HOST_STOP_FAILED";
  private idleStopPromise?: Promise<void>;

  constructor(private readonly options: RuntimeHostOptions) {
    validateOptions(options);
    this.scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
  }

  snapshot(): RuntimeHostSnapshot {
    const issues = this.current?.issues;
    return Object.freeze({
      state: this.state,
      ready: this.state === "ready",
      accepting: this.accepting,
      generation: this.generation,
      ...(issues && issues.length > 0
        ? { issues: Object.freeze(issues.map((issue) => Object.freeze({ ...issue }))) }
        : {}),
      ...(this.failureCode ? { failureCode: this.failureCode } : {}),
    });
  }

  start(): Promise<void> {
    if (this.state === "starting" || this.state === "ready" || this.state === "degraded") {
      return this.current!.startPromise;
    }
    if (this.state === "stopping") {
      return Promise.reject(new RuntimeHostError("HOST_STOPPING"));
    }
    if (this.state === "failed") {
      return Promise.reject(new RuntimeHostError("HOST_START_FAILED"));
    }

    this.idleStopPromise = undefined;
    this.failureCode = undefined;
    this.accepting = false;
    this.state = "starting";
    if (this.startedOnce) {
      this.generation += 1;
    } else {
      this.startedOnce = true;
    }

    const issues: RuntimeHostIssue[] = [];
    const workerCleanup: RuntimeHostWorkerCleanup = { complete: false };
    let dependenciesReady = true;
    let worker: DurableJobV2WorkerLoopHandle | undefined;
    const dependencySteps = this.options.dependencies.map((dependency): RuntimeLifecycleStep => ({
      name: dependency.name,
      start: async (): Promise<RuntimeLifecycleStepResult | void> => {
        const result = await dependency.start();
        if (result?.ready === false) {
          dependenciesReady = false;
          issues.push({ component: dependency.name, code: "DEPENDENCY_DEGRADED" });
          return { ready: false, reason: "DEPENDENCY_DEGRADED" };
        }
      },
      ...(dependency.stop ? { stop: () => dependency.stop!() } : {}),
    }));
    const workerStep: RuntimeLifecycleStep = {
      name: "worker",
      start: async (): Promise<RuntimeLifecycleStepResult | void> => {
        if (!dependenciesReady) {
          issues.push({ component: "worker", code: "DEPENDENCIES_NOT_READY" });
          return { ready: false, reason: "DEPENDENCIES_NOT_READY" };
        }
        if (this.options.probeWorker) {
          const probe = await withinBoundary(
            Promise.resolve().then(() => this.options.probeWorker!()),
            this.options.workerProbeTimeoutMs,
            this.scheduler,
          );
          if (probe.kind === "timeout") {
            issues.push({ component: "worker", code: "WORKER_PROBE_TIMEOUT" });
            return { ready: false, reason: "WORKER_PROBE_TIMEOUT" };
          }
          if (probe.kind === "rejected" || probe.kind === "scheduler_failure" ||
              !validWorkerProbe(probe.value)) {
            issues.push({ component: "worker", code: "WORKER_PROBE_FAILED" });
            return { ready: false, reason: "WORKER_PROBE_FAILED" };
          }
          if (probe.value.status !== "ready") {
            issues.push({ component: "worker", code: "WORKER_NOT_READY" });
            return { ready: false, reason: "WORKER_NOT_READY" };
          }
        }

        try {
          worker = this.options.startWorker();
        } catch {
          throw new RuntimeHostError("HOST_START_FAILED");
        }
        if (!worker || typeof worker.tick !== "function" || typeof worker.stop !== "function") {
          const partial = worker as unknown as {
            stop?: (options?: { timeoutMs?: number }) => Promise<unknown> | unknown;
          } | undefined;
          if (typeof partial?.stop === "function") {
            workerCleanup.promise = Promise.resolve().then(() =>
              partial.stop!({ timeoutMs: this.options.workerStopTimeoutMs }),
            );
            const cleanup = await withinBoundary(
              workerCleanup.promise,
              this.options.workerStopTimeoutMs,
              this.scheduler,
            );
            if (cleanup.kind !== "value" ||
                cleanup.value === null || typeof cleanup.value !== "object" ||
                (cleanup.value as { status?: unknown }).status !== "stopped") {
              worker = undefined;
              throw new RuntimeHostError("HOST_STOP_FAILED");
            }
            workerCleanup.complete = true;
          }
          worker = undefined;
          throw new RuntimeHostError("HOST_START_FAILED");
        }
      },
      stop: async () => {
        if (!worker) return;
        const handle = worker;
        worker = undefined;
        const stopped = await withinBoundary(
          Promise.resolve().then(() => handle.stop({ timeoutMs: this.options.workerStopTimeoutMs })),
          this.options.workerStopTimeoutMs,
          this.scheduler,
        );
        if (stopped.kind !== "value" || stopped.value.status !== "stopped") {
          throw new RuntimeHostError("HOST_STOP_FAILED");
        }
      },
    };

    const lifecycle = new RuntimeLifecycle([...dependencySteps, workerStep]);
    const cycle = {
      generation: this.generation,
      lifecycle,
      issues,
      startPromise: Promise.resolve(),
      workerCleanup,
    } satisfies RuntimeHostCycle;
    this.current = cycle;
    cycle.startPromise = lifecycle.start().then(
      () => {
        if (this.current !== cycle || this.state === "stopping") return;
        const lifecycleState = lifecycle.snapshot().state;
        this.state = lifecycleState;
        this.accepting = lifecycleState === "ready";
      },
      (error: unknown) => {
        if (this.current === cycle && this.state === "stopping" &&
            error instanceof RuntimeLifecycleError && error.code === "RUNTIME_STOPPING") {
          throw new RuntimeHostError("HOST_STOPPING");
        }
        if (this.current === cycle) {
          const failureCode = error instanceof RuntimeHostError && error.code === "HOST_STOP_FAILED"
            ? "HOST_STOP_FAILED"
            : "HOST_START_FAILED";
          this.state = "failed";
          this.accepting = false;
          this.failureCode = failureCode;
          throw new RuntimeHostError(failureCode);
        }
        throw new RuntimeHostError(
          error instanceof RuntimeHostError && error.code === "HOST_STOP_FAILED"
            ? "HOST_STOP_FAILED"
            : "HOST_START_FAILED",
        );
      },
    );
    return cycle.startPromise;
  }

  stop(): Promise<void> {
    if (this.current?.stopPromise) return this.current.stopPromise;
    if (this.state === "created" || this.state === "stopped") {
      this.state = "stopped";
      this.accepting = false;
      this.idleStopPromise ??= Promise.resolve();
      return this.idleStopPromise;
    }

    const cycle = this.current;
    if (!cycle) {
      this.state = "stopped";
      this.accepting = false;
      this.idleStopPromise ??= Promise.resolve();
      return this.idleStopPromise;
    }

    // 发布 stopping/停止接单必须先于任何异步 worker drain。
    this.state = "stopping";
    this.accepting = false;
    cycle.stopPromise = this.stopCycle(cycle);
    return cycle.stopPromise;
  }

  private async stopCycle(cycle: RuntimeHostCycle): Promise<void> {
    let failed = false;
    try {
      await cycle.lifecycle.stop();
    } catch {
      failed = true;
    }

    if (cycle.workerCleanup.promise && !cycle.workerCleanup.complete) {
      const cleanup = await withinBoundary(
        cycle.workerCleanup.promise,
        this.options.workerStopTimeoutMs,
        this.scheduler,
      );
      if (cleanup.kind === "value" && cleanup.value !== null &&
          typeof cleanup.value === "object" &&
          (cleanup.value as { status?: unknown }).status === "stopped") {
        cycle.workerCleanup.complete = true;
      } else {
        failed = true;
      }
    }

    if (failed) {
      if (this.current === cycle) {
        cycle.issues.length = 0;
        this.state = "failed";
        this.accepting = false;
        this.failureCode = "HOST_STOP_FAILED";
        if (cycle.workerCleanup.promise && !cycle.workerCleanup.complete) {
          // 同一 raw cleanup promise 仍由本 cycle 持有；允许迟到完成后再次显式收口。
          cycle.stopPromise = undefined;
        }
      }
      throw new RuntimeHostError("HOST_STOP_FAILED");
    }

    if (this.current !== cycle) return;
    cycle.issues.length = 0;
    this.failureCode = undefined;
    this.state = "stopped";
    this.accepting = false;
  }
}
