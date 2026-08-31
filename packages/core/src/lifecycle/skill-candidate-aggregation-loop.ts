import type { MemoryScope } from "../domain/types.js";
import type { SkillCandidateAggregator } from "./skill-candidate-aggregator.js";

export interface SkillCandidateAggregationScheduler {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface SkillCandidateAggregationLoopOptions {
  readonly intervalMs?: number;
  readonly scheduler?: SkillCandidateAggregationScheduler;
  readonly onError?: () => void;
}

const DEFAULT_SCHEDULER: SkillCandidateAggregationScheduler = {
  setInterval: (callback, intervalMs) => {
    const handle = setInterval(callback, intervalMs);
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export class SkillCandidateAggregationLoop {
  readonly #scheduler: SkillCandidateAggregationScheduler;
  readonly #intervalMs: number;
  readonly #onError?: () => void;
  #handle?: unknown;
  #inflight?: Promise<void>;

  constructor(
    readonly aggregator: Pick<SkillCandidateAggregator, "runAggregation">,
    readonly scope: MemoryScope,
    options: SkillCandidateAggregationLoopOptions = {},
  ) {
    this.#scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
    this.#intervalMs = options.intervalMs ?? 60_000;
    this.#onError = options.onError;
    if (!Number.isSafeInteger(this.#intervalMs) || this.#intervalMs < 1_000) {
      throw new Error("SKILL_AGGREGATION_LOOP_INVALID");
    }
  }

  start(): void {
    if (this.#handle !== undefined) return;
    this.#handle = this.#scheduler.setInterval(() => { void this.tick(); }, this.#intervalMs);
    void this.tick();
  }

  async tick(): Promise<void> {
    if (this.#inflight !== undefined) return this.#inflight;
    const operation = this.aggregator.runAggregation(this.scope)
      .then((result) => {
        if (result.errors.length > 0) this.#notifyError();
      })
      .catch(() => this.#notifyError())
      .finally(() => {
        if (this.#inflight === operation) this.#inflight = undefined;
      });
    this.#inflight = operation;
    return operation;
  }

  #notifyError(): void {
    try { this.#onError?.(); } catch { /* observability cannot stop aggregation */ }
  }

  async stop(): Promise<void> {
    if (this.#handle !== undefined) {
      this.#scheduler.clearInterval(this.#handle);
      this.#handle = undefined;
    }
    await this.#inflight;
  }
}
