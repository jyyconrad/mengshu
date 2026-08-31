import type { MemoryEvolutionService } from "./memory-evolution-service.js";

export interface TemporalActivationLoopScheduler {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface TemporalActivationLoopOptions {
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly scheduler?: TemporalActivationLoopScheduler;
  readonly onError?: () => void;
}

const DEFAULT_SCHEDULER: TemporalActivationLoopScheduler = {
  setInterval: (callback, intervalMs) => {
    const handle = setInterval(callback, intervalMs);
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export class TemporalActivationLoop {
  readonly #scheduler: TemporalActivationLoopScheduler;
  readonly #intervalMs: number;
  readonly #batchSize: number;
  readonly #onError?: () => void;
  #handle?: unknown;
  #inflight?: Promise<void>;

  constructor(
    readonly service: Pick<
      MemoryEvolutionService,
      "activateDue" | "materializeExpired" | "retryPendingPurges"
    >,
    options: TemporalActivationLoopOptions = {},
  ) {
    this.#scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
    this.#intervalMs = options.intervalMs ?? 1_000;
    this.#batchSize = options.batchSize ?? 100;
    this.#onError = options.onError;
    if (!Number.isSafeInteger(this.#intervalMs) || this.#intervalMs < 100 ||
        !Number.isSafeInteger(this.#batchSize) || this.#batchSize < 1 || this.#batchSize > 1_000) {
      throw new Error("TEMPORAL_ACTIVATION_LOOP_INVALID");
    }
  }

  start(): void {
    if (this.#handle !== undefined) return;
    this.#handle = this.#scheduler.setInterval(() => { void this.tick(); }, this.#intervalMs);
    void this.tick();
  }

  async tick(): Promise<void> {
    if (this.#inflight !== undefined) return this.#inflight;
    const operation = Promise.all([
      this.service.activateDue({ limit: this.#batchSize }),
      this.service.materializeExpired({ limit: this.#batchSize }),
      this.service.retryPendingPurges({ limit: Math.min(100, this.#batchSize) }),
    ])
      .then(() => undefined)
      .catch(() => {
        try { this.#onError?.(); } catch { /* observability cannot stop reconciliation */ }
      })
      .finally(() => {
        if (this.#inflight === operation) this.#inflight = undefined;
      });
    this.#inflight = operation;
    return operation;
  }

  async stop(): Promise<void> {
    if (this.#handle !== undefined) {
      this.#scheduler.clearInterval(this.#handle);
      this.#handle = undefined;
    }
    await this.#inflight;
  }
}
