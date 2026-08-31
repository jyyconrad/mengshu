import type { SessionWorkingSetService } from "./session-working-set-service.js";

export interface WorkingSetRetentionLoopScheduler {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface WorkingSetRetentionLoopOptions {
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly scheduler?: WorkingSetRetentionLoopScheduler;
  readonly onError?: () => void;
}

const DEFAULT_SCHEDULER: WorkingSetRetentionLoopScheduler = {
  setInterval: (callback, intervalMs) => {
    const handle = setInterval(callback, intervalMs);
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export class WorkingSetRetentionLoop {
  readonly #scheduler: WorkingSetRetentionLoopScheduler;
  readonly #intervalMs: number;
  readonly #batchSize: number;
  readonly #onError?: () => void;
  #handle?: unknown;
  #inflight?: Promise<void>;

  constructor(
    readonly service: Pick<SessionWorkingSetService, "runRetentionCleanup">,
    options: WorkingSetRetentionLoopOptions = {},
  ) {
    this.#scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
    this.#intervalMs = options.intervalMs ?? 60_000;
    this.#batchSize = options.batchSize ?? 25;
    this.#onError = options.onError;
    if (!Number.isSafeInteger(this.#intervalMs) || this.#intervalMs < 1_000 ||
        !Number.isSafeInteger(this.#batchSize) || this.#batchSize < 1 || this.#batchSize > 100) {
      throw new Error("WORKING_SET_RETENTION_LOOP_INVALID");
    }
  }

  start(): void {
    if (this.#handle !== undefined) return;
    this.#handle = this.#scheduler.setInterval(() => { void this.tick(); }, this.#intervalMs);
    void this.tick();
  }

  async tick(): Promise<void> {
    if (this.#inflight !== undefined) return this.#inflight;
    const operation = this.service.runRetentionCleanup({ limit: this.#batchSize })
      .then((result) => {
        if (result.failedSessions > 0) this.#notifyError();
      })
      .catch(() => this.#notifyError())
      .finally(() => {
        if (this.#inflight === operation) this.#inflight = undefined;
      });
    this.#inflight = operation;
    return operation;
  }

  #notifyError(): void {
    try { this.#onError?.(); } catch { /* observability cannot stop retention */ }
  }

  async stop(): Promise<void> {
    if (this.#handle !== undefined) {
      this.#scheduler.clearInterval(this.#handle);
      this.#handle = undefined;
    }
    await this.#inflight;
  }
}
