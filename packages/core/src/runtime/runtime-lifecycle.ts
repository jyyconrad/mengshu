export type RuntimeLifecycleState =
  | "created"
  | "starting"
  | "ready"
  | "degraded"
  | "stopping"
  | "stopped"
  | "failed";

export interface RuntimeLifecycleStep {
  readonly name: string;
  start(): Promise<RuntimeLifecycleStepResult | void> | RuntimeLifecycleStepResult | void;
  stop?(): Promise<void> | void;
}

export interface RuntimeLifecycleStepResult {
  readonly ready: false;
  readonly reason: string;
}

export interface RuntimeLifecycleSnapshot {
  readonly state: RuntimeLifecycleState;
  readonly ready: boolean;
  readonly failure?: unknown;
  readonly degradedSteps?: readonly { readonly name: string; readonly reason: string }[];
}

export type RuntimeLifecycleErrorCode = "RUNTIME_STOPPED" | "RUNTIME_STOPPING";

export class RuntimeLifecycleError extends Error {
  readonly code: RuntimeLifecycleErrorCode;

  constructor(code: RuntimeLifecycleErrorCode, message: string) {
    super(message);
    this.name = "RuntimeLifecycleError";
    this.code = code;
  }
}

/**
 * 进程内 runtime 生命周期状态机。
 *
 * 每个 start step 成功后才进入回滚栈；启动失败或正常 stop 都按逆序释放。
 * 同一实例是单次生命周期：stopped 后必须新建实例，避免复用已经关闭的 pool。
 */
export class RuntimeLifecycle {
  private state: RuntimeLifecycleState = "created";
  private failure: unknown;
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<void>;
  private stopRequested = false;
  private stopSignal?: RuntimeLifecycleError;
  private cleanupIncomplete = false;
  private readonly startedSteps: RuntimeLifecycleStep[] = [];
  private readonly degradedSteps: Array<{ name: string; reason: string }> = [];

  constructor(private readonly steps: readonly RuntimeLifecycleStep[]) {}

  snapshot(): RuntimeLifecycleSnapshot {
    return Object.freeze({
      state: this.state,
      ready: this.state === "ready",
      ...(this.failure !== undefined ? { failure: this.failure } : {}),
      ...(this.degradedSteps.length > 0
        ? { degradedSteps: this.degradedSteps.map((item) => ({ ...item })) }
        : {}),
    });
  }

  start(): Promise<void> {
    if (this.state === "ready" || this.state === "degraded") return Promise.resolve();
    if (this.state === "starting") return this.startPromise!;
    if (this.state === "stopped") {
      return Promise.reject(new RuntimeLifecycleError(
        "RUNTIME_STOPPED",
        "runtime lifecycle is stopped and cannot be restarted",
      ));
    }
    if (this.state === "stopping") {
      return Promise.reject(new RuntimeLifecycleError(
        "RUNTIME_STOPPING",
        "runtime lifecycle is stopping",
      ));
    }
    if (this.state === "failed") return Promise.reject(this.failure);

    this.state = "starting";
    this.startPromise = this.runStart();
    return this.startPromise;
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (this.state === "stopped") return Promise.resolve();
    if (this.state === "created") {
      this.state = "stopped";
      this.stopPromise = Promise.resolve();
      return this.stopPromise;
    }

    if (this.state === "starting") {
      this.stopRequested = true;
      this.stopSignal = new RuntimeLifecycleError(
        "RUNTIME_STOPPING",
        "runtime lifecycle stop was requested during startup",
      );
      // 立即对 snapshot/后续 start 发布 stopping，runStop 仍会等待当前 start 决议。
      this.state = "stopping";
    }

    this.stopPromise = this.runStop();
    return this.stopPromise;
  }

  private async runStart(): Promise<void> {
    try {
      for (const step of this.steps) {
        const result = await step.start();
        this.startedSteps.push(step);
        if (result?.ready === false) {
          this.degradedSteps.push({ name: step.name, reason: result.reason });
        }
        if (this.stopRequested) throw this.stopSignal!;
      }
      if (this.stopRequested) throw this.stopSignal!;
      this.state = this.degradedSteps.length > 0 ? "degraded" : "ready";
    } catch (startFailure) {
      if (startFailure === this.stopSignal) {
        // runStop owns the one and only reverse cleanup for startup cancellation.
        throw startFailure;
      }
      const rollbackFailures = await this.stopStartedSteps();
      this.cleanupIncomplete = rollbackFailures.length > 0;
      this.failure = rollbackFailures.length === 0
        ? startFailure
        : new AggregateError(
            [startFailure, ...rollbackFailures],
            "runtime startup and rollback failed",
          );
      this.state = "failed";
      throw this.failure;
    }
  }

  private async runStop(): Promise<void> {
    if (this.stopRequested) {
      try {
        await this.startPromise;
      } catch {
        // runStart 已完成逆序回滚；stop 只负责收口为 stopped。
      }
    }

    if (this.state === "failed") {
      if (this.cleanupIncomplete) throw this.failure;
      this.failure = undefined;
      this.degradedSteps.length = 0;
      this.state = "stopped";
      return;
    }

    this.state = "stopping";
    const stopFailures = await this.stopStartedSteps();
    if (stopFailures.length > 0) {
      const aggregate = new AggregateError(stopFailures, "runtime shutdown failed");
      this.failure = aggregate;
      this.state = "failed";
      throw aggregate;
    }
    this.failure = undefined;
    this.degradedSteps.length = 0;
    this.state = "stopped";
  }

  private async stopStartedSteps(): Promise<unknown[]> {
    const failures: unknown[] = [];
    while (this.startedSteps.length > 0) {
      const step = this.startedSteps.pop()!;
      if (!step.stop) continue;
      try {
        await step.stop();
      } catch (error) {
        failures.push(error);
      }
    }
    return failures;
  }
}
