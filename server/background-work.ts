import { randomUUID } from "node:crypto";
import type { MemoryScope } from "../packages/core/src/domain/types.js";
import type { EvolutionBatchReport } from "../packages/core/src/evolution/types.js";
import {
  RuntimeBackgroundWorkError, parseRuntimeBackgroundWork, parseRuntimeBackgroundWorkUpdate,
  type RuntimeBackgroundWorkConfig, type RuntimeBackgroundWorkSnapshot,
} from "../packages/core/src/runtime/background-work.js";
import { deriveDurableJobV2ScopedDedupeKey, type DurableJobV2Scope } from "../packages/core/src/storage/repositories/job-v2.js";
import type { DurableJobV2PollSelection } from "./workers-v2.js";
import { evolutionJobIdentity } from "./evolution-job.js";

interface BackgroundLoop { start(): void; stop(): Promise<void> }

export class RuntimeBackgroundWork {
  private config: RuntimeBackgroundWorkConfig;
  private revision = randomUUID();
  private readonly active = new Set<AbortController>();
  private readonly scope: DurableJobV2Scope;
  private readonly evolutionScope: MemoryScope;
  private readonly resolveBatch?: (id: string) => Promise<EvolutionBatchReport | undefined>;
  private readonly authorizeUpdate?: () => void;
  private readonly loops = new Map<BackgroundLoop, boolean>();
  private readonly stoppingLoops = new Map<BackgroundLoop, Promise<void>>();
  private readonly failedLoops = new Set<BackgroundLoop>();

  constructor(input: {
    config?: RuntimeBackgroundWorkConfig;
    scope: MemoryScope;
    resolveBatch?: (id: string) => Promise<EvolutionBatchReport | undefined>;
    authorizeUpdate?: () => void;
  }) {
    this.config = parseRuntimeBackgroundWork(input.config ?? { mode: "all" });
    this.evolutionScope = Object.freeze(structuredClone({ ...input.scope, visibility: input.scope.visibility ?? "private" }));
    this.scope = Object.freeze({ tenantId: input.scope.tenantId, userId: input.scope.userId,
      appId: input.scope.appId, projectId: input.scope.projectId, agentId: input.scope.agentId,
      namespace: input.scope.namespace, visibility: input.scope.visibility ?? "private" });
    deriveDurableJobV2ScopedDedupeKey(this.scope, "background-work");
    this.resolveBatch = input.resolveBatch;
    this.authorizeUpdate = input.authorizeUpdate;
    this.assertAvailable(this.config);
  }

  snapshot(): RuntimeBackgroundWorkSnapshot {
    const draining = this.stoppingLoops.size > 0 || this.failedLoops.size > 0 || [...this.active].some(controller => controller.signal.aborted);
    return Object.freeze({ ...this.config, revision: this.revision, active: this.active.size + this.stoppingLoops.size + this.failedLoops.size,
      state: draining ? "draining" : this.config.mode === "all" ? "enabled" : this.config.mode === "paused" ? "paused" : "controlled" });
  }

  async update(request: unknown): Promise<RuntimeBackgroundWorkSnapshot> {
    this.authorizeUpdate?.();
    const { expectedRevision, ...config } = parseRuntimeBackgroundWorkUpdate(request);
    if (expectedRevision !== this.revision) throw new RuntimeBackgroundWorkError("BACKGROUND_REVISION_STALE");
    this.assertAvailable(config);
    if (config.mode !== "paused" && this.snapshot().state === "draining") throw new RuntimeBackgroundWorkError("BACKGROUND_DRAINING");
    this.config = Object.freeze(config);
    this.revision = randomUUID();
    for (const controller of this.active) controller.abort(new DOMException("Background policy changed", "AbortError"));
    if (config.mode === "all") {
      for (const [loop, started] of this.loops) {
        if (!started) { this.loops.set(loop, true); loop.start(); }
      }
    } else {
      await Promise.all([...this.loops.keys()].map(loop => this.stopLoop(loop)));
    }
    return this.snapshot();
  }

  manageLoop(loop: BackgroundLoop): BackgroundLoop {
    return {
      start: () => {
        if (this.loops.has(loop)) return;
        const enabled = this.config.mode === "all";
        this.loops.set(loop, enabled);
        if (enabled) loop.start();
      },
      stop: async () => {
        const stopping = this.stopLoop(loop);
        this.loops.delete(loop);
        await stopping;
      },
    };
  }

  private stopLoop(loop: BackgroundLoop): Promise<void> {
    const pending = this.stoppingLoops.get(loop);
    if (pending) return pending;
    if (!this.loops.get(loop)) return Promise.resolve();
    this.loops.set(loop, false);
    let stopping: Promise<void>;
    try { stopping = loop.stop(); }
    catch { stopping = Promise.reject(new RuntimeBackgroundWorkError("BACKGROUND_LOOP_STOP_FAILED")); }
    const tracked = stopping.catch(() => {
      this.failedLoops.add(loop);
      throw new RuntimeBackgroundWorkError("BACKGROUND_LOOP_STOP_FAILED");
    }).finally(() => { this.stoppingLoops.delete(loop); });
    this.stoppingLoops.set(loop, tracked);
    return tracked;
  }

  async select(parent: AbortSignal): Promise<DurableJobV2PollSelection> {
    parent.throwIfAborted();
    const config = this.config;
    if (config.mode === "paused") return { mode: "paused" };
    const controller = new AbortController();
    const signal = AbortSignal.any([parent, controller.signal]);
    this.active.add(controller);
    const release = () => { this.active.delete(controller); };
    try {
      if (config.mode === "all") return { mode: "all", signal, release };
      const jobIds: string[] = [];
      for (const batchId of config.allowedBatchIds) {
        signal.throwIfAborted();
        const report = await this.resolveBatch!(batchId);
        signal.throwIfAborted();
        if (!report) continue;
        if (report.batchId !== batchId) throw new RuntimeBackgroundWorkError("BACKGROUND_BATCH_INVALID");
        if (["queued", "running", "failed"].includes(report.status)) {
          jobIds.push(evolutionJobIdentity(this.evolutionScope, batchId, report.segment?.attempt ?? 0).id);
        }
      }
      return { mode: "evolution_only", scope: this.scope, jobIds, signal, release };
    } catch (error) { release(); throw error; }
  }

  private assertAvailable(config: RuntimeBackgroundWorkConfig): void {
    if (config.mode === "evolution_only" && !this.resolveBatch) {
      throw new RuntimeBackgroundWorkError("BACKGROUND_EVOLUTION_UNAVAILABLE");
    }
  }
}
