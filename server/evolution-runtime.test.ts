import { afterEach, describe, expect, test, vi } from "vitest";
import { memoryConfigSchema } from "../config.js";
import { createMengshuRuntime } from "../runtime.js";
import { PostgresProvider } from "../packages/core/src/db/providers/postgres.js";
import { MemoryEvolutionBatchService } from "../packages/core/src/evolution/batch-service.js";
import { PostgresEvolutionInventoryReadPort } from "../packages/core/src/evolution/postgres-inventory.js";
import type { EvolutionBatch, EvolutionRunRequest } from "../packages/core/src/evolution/types.js";
import type { MemoryWriteKernelDependencies } from "../packages/core/src/service/write-kernel.js";
import { NullLlmClient } from "../packages/core/src/runtime/llm/llm-client.js";
import { createDurableJobHandlerRegistry, createDurableJobV2, leaseDurableJobV2, type DurableJobV2 } from "../packages/core/src/storage/repositories/job-v2.js";
import { createEvolutionRuntime, assertEvolutionRuntimeOwner } from "./evolution-runtime.js";
import { loadGlobalEvolutionConfig } from "./evolution-config.js";
import { withAuthenticatedEvolutionOwner } from "../packages/api/src/evolution-owner-auth.js";
import * as maintenanceModule from "./evolution-maintenance.js";
import { assertPostgresBundleOwnsEvolutionPersistence } from "../packages/core/src/db/providers/postgres.js";
import { EvolutionActivity } from "./evolution-activity.js";

const scope = { tenantId: "tenant", userId: "user", appId: "app", projectId: "project", agentId: "agent", namespace: "memories", visibility: "private" as const };
const authority = { tenantId: scope.tenantId, userId: scope.userId, allow: {
  appIds: [scope.appId], projectIds: [scope.projectId], agentIds: [scope.agentId], namespaces: [scope.namespace], visibilities: [scope.visibility],
} };
const config = memoryConfigSchema.parse({ embedding: { apiKey: "fixture", baseURL: "http://127.0.0.1:9/v1" }, dbType: "postgres", postgres: { host: "unused", port: 5432, database: "unused", user: "unused", password: "unused" }, features: { continuousMemoryEvolution: true } });
const request: EvolutionRunRequest = { input: { mode: "inventory", selection: "baseline" }, action: "apply_allowed", idempotencyKey: "request-one" };

/** SQL boundary double only: the service, repository, provider factory and handler are production code. */
function fixture(options: { config?: typeof config; maintenanceHost?: Parameters<typeof createEvolutionRuntime>[0]["maintenanceHost"] } = {}) {
  const provider = new PostgresProvider({ host: "unused", database: "unused", port: 5432, user: "unused", password: "unused" }, "text-embedding-3-small");
  const batches = new Map<string, EvolutionBatch>();
  const calls: string[] = [];
  let fences = 0;
  const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
    calls.push(sql);
    let rows: Record<string, unknown>[] = [];
    if (sql.includes("evolution:batch-insert")) {
      const value = JSON.parse(params[4] as string) as EvolutionBatch;
      if (!batches.has(value.id)) { batches.set(value.id, value); rows = [{ body: value }]; }
    } else if (sql.includes("evolution:batch-by-key")) {
      const value = [...batches.values()].find(batch => batch.scopeFingerprint === params[0] && batch.request.idempotencyKey === params[1]);
      rows = value ? [{ body: value }] : [];
    } else if (sql.includes("evolution:batch-get")) {
      const value = batches.get(params[1] as string);
      rows = value?.scopeFingerprint === params[0] ? [{ body: value }] : [];
    } else if (sql.includes("evolution:lease-acquire")) {
      rows = [{ fencing_token: ++fences, lease_expires_at: Date.now() + (params[3] as number) }];
    } else if (sql.includes("evolution:batch-save")) {
      const value = JSON.parse(params[2] as string) as EvolutionBatch;
      batches.set(value.id, value); rows = [{ body: value }];
    } else if (sql.includes("evolution:batch-cancel")) {
      const batch = batches.get(params[1] as string);
      if (batch) { batch.status = "cancelled"; batch.cancelRequestedAt = params[2] as number; rows = [{ body: batch }]; }
    } else if (sql.includes("evolution:job-fence")) {
      rows = [{ id: params[0] }];
    } else if (sql.includes("to_regclass('mengshu_evolution_batches')")) {
      rows = [{ batches: true, receipts: true, processed: true, reviews: true, sources: true,
        operations: true, budgets: true, host_state: true, host_receipts: true }];
    } else if (!["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) && !sql.includes("set_config('lock_timeout'") &&
        !sql.includes("evolution:lease-release") && !sql.includes("evolution:inventory-freeze") &&
        !sql.includes("evolution:selection-freeze") && !sql.includes("evolution:review-get") && !sql.includes("evolution:proposal-list")) {
      throw new Error(`Unexpected fixture SQL: ${sql.slice(0, 80)}`);
    }
    return { rows: structuredClone(rows), rowCount: rows.length };
  });
  Object.assign(provider, { pool: { query, connect: async () => ({ query, release: vi.fn() }) }, schemaVersion: 37, schemaContractState: "ready" });
  vi.spyOn(provider, "initialize").mockResolvedValue();
  const bundle = provider.createDurableJobV2RuntimeBundle({ clock: Date.now, tokenFactory: () => "a".repeat(32), backoffMs: () => 10, enableMemoryEvolution: true });
  const queued = new Map<string, DurableJobV2>();
  const enqueue = vi.spyOn(bundle.repository, "enqueue").mockImplementation(async value => {
    if (!queued.has(value.dedupeKey)) queued.set(value.dedupeKey, createDurableJobV2(value, { now: Date.now(), registry: createDurableJobHandlerRegistry(bundle.handlerTypes) }));
    return queued.get(value.dedupeKey)!;
  });
  const llm = new NullLlmClient();
  const kernelDependencies = vi.fn(() => ({} as Omit<MemoryWriteKernelDependencies, "transaction">));
  const runtime = createEvolutionRuntime({ runtimeBundle: bundle, scope, authority,
    config: loadGlobalEvolutionConfig({ scope, authority, hostConfig: options.config ?? config }), llmClient: llm, kernelDependencies, onCommitted: vi.fn(),
    ...(options.maintenanceHost ? { maintenanceHost: options.maintenanceHost } : {}) });
  const leased = (job: DurableJobV2) => leaseDurableJobV2(job, { now: Date.now(), owner: "worker", leaseMs: 10_000, tokenFactory: () => "b".repeat(32) }).job;
  return { provider, bundle, runtime, batches, calls, query, enqueue, queued, leased };
}
afterEach(() => vi.restoreAllMocks());

describe("host evolution durable wiring", () => {
  test("native idle never treats plentiful local disk as PostgreSQL backing space and pause precedes all I/O", async () => {
    const now = Date.now();
    let clock = now - 2000, mode: "all" | "paused" = "all";
    const statfs = vi.fn(async () => ({ bavail: 1_000_000n, bsize: 4096n }));
    const activity = new EvolutionActivity("/unused", { now: () => clock, statfs });
    clock = now;
    const f = fixture({ config: memoryConfigSchema.parse({ ...config,
      llm: { provider: "openai", model: "synthetic", apiKey: "synthetic", baseURL: "http://127.0.0.1:9/v1",
        pricing: { provider: "openai", version: "prices-v1", currency: "USD", minorUnitsPerMajor: 100,
          models: { default: { inputTokenPrice: 2, outputTokenPrice: 6 } } } },
      evolution: { maintenance: { enabled: true, intervalMs: 60_000, quietPeriodMs: 1000, dailyTokens: 10_000,
        dailyMinorUnits: 100, maxStorageBytes: 100_000, minFreeBytes: 1000 } } }),
      maintenanceHost: { activity, backgroundMode: () => mode } });
    expect(statfs).not.toHaveBeenCalled(); expect(f.query).not.toHaveBeenCalled();
    await f.runtime.onIdle(new AbortController().signal);
    expect(f.runtime.maintenanceStatus()).toMatchObject({ enabled: true, status: "blocked",
      reasons: ["maintenance_free_space_unknown"], databaseFreeBytes: null, localFreeBytes: 4_096_000_000 });
    expect(statfs).toHaveBeenCalledTimes(1); expect(f.query).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
    mode = "paused";
    await f.runtime.onIdle(new AbortController().signal);
    expect(f.runtime.maintenanceStatus()).toMatchObject({ status: "deferred", reasons: ["maintenance_background_paused"] });
    expect(statfs).toHaveBeenCalledTimes(1); expect(f.query).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
  });
  test("maintenance factory is native, disabled idle is inert, and worker hooks receive the real lease before release", async () => {
    const factory = vi.spyOn(maintenanceModule, "createEvolutionMaintenance");
    const f = fixture();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0][0].runtimeBundle).toBe(f.bundle);
    await f.runtime.onIdle(new AbortController().signal);
    expect(f.calls).toEqual([]);
    expect(f.runtime.maintenanceStatus()).toMatchObject({ enabled: false, reasons: ["maintenance_disabled"], databaseFreeBytes: null });
    const driver = factory.mock.results[0].value as maintenanceModule.EvolutionMaintenanceDriver;
    const first = await f.runtime.capability.run(request);
    const job = f.leased([...f.queued.values()][0]!);
    const reserved = { reservationId: "a".repeat(64), dayKey: "2026-09-06", tokens: 1, costMicros: 1, batchId: first.batchId,
      scopeFingerprint: f.batches.get(first.batchId)!.scopeFingerprint, segmentAttempt: 1 as const, currency: "USD", pricingSnapshotVersion: "fixture" };
    const before = vi.spyOn(driver, "beforeBatch").mockResolvedValue({ status: "admitted", reasons: [], reservation: reserved });
    const after = vi.spyOn(driver, "afterBatch").mockImplementation(async value => {
      expect(value.job).toBe(job); expect(value.batch.status).toBe("completed");
      expect(value.lease).toMatchObject({ batchId: first.batchId, fencingToken: 1 });
      expect(assertPostgresBundleOwnsEvolutionPersistence(f.bundle, value.persistence, scope, job)).toBe(value.persistence);
      expect(f.calls.some(sql => sql.includes("evolution:lease-release"))).toBe(false);
      return { status: "completed", reasons: [] };
    });
    const settle = vi.spyOn(driver, "settleReservation").mockResolvedValue({ status: "retained", reasons: ["maintenance_usage_uncertain"] });
    await expect(f.runtime.handler(job, { signal: new AbortController().signal, workerId: "worker" })).resolves.toMatchObject({ status: "completed" });
    expect(before).toHaveBeenCalledTimes(1); expect(after).toHaveBeenCalledTimes(1); expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0][0]).not.toHaveProperty("usage");
    expect(f.calls.some(sql => sql.includes("evolution:lease-release"))).toBe(true);
  });
  test("automatic infrastructure retries retain the already reserved segment budget", async () => {
    const f = fixture();
    const first = await f.runtime.capability.run(request);
    const batch = f.batches.get(first.batchId)!;
    batch.usage.llmCalls = 3;
    batch.segment!.usage.llmCalls = 3;
    const job = f.leased([...f.queued.values()][0]!);
    const freeze = vi.spyOn(PostgresEvolutionInventoryReadPort.prototype, "freeze").mockRejectedValueOnce(new Error("transient provider failure"));
    const context = { signal: new AbortController().signal, workerId: "worker" };
    await expect(f.runtime.handler(job, context)).rejects.toMatchObject({ code: "EVOLUTION_BATCH_RETRY", retryable: true });
    expect(f.batches.get(first.batchId)).toMatchObject({ status: "failed", segment: { attempt: 1, usage: { llmCalls: 3 } }, usage: { llmCalls: 3 } });
    freeze.mockRestore();
    await expect(f.runtime.handler(job, context)).resolves.toMatchObject({ status: "completed", segment: { attempt: 1, usage: { llmCalls: 3 } }, usage: { llmCalls: 3 } });
  });
  test("real prepare persists a queued batch, duplicate enqueue is stable, and worker retry reads the same scoped batch", async () => {
    const f = fixture();
    const retry = vi.spyOn(MemoryEvolutionBatchService.prototype, "retry");
    const resume = vi.spyOn(MemoryEvolutionBatchService.prototype, "resume");
    const first = await f.runtime.capability.run(request);
    expect(first).toMatchObject({ status: "queued", segment: { attempt: 1 }, usage: { llmCalls: 0, records: 0 } });
    expect(f.batches.has(first.batchId)).toBe(true);
    expect(f.calls.some(sql => sql.includes("evolution:inventory-freeze"))).toBe(false);
    expect(await f.runtime.capability.run(request)).toEqual(first);
    expect(f.queued.size).toBe(1);
    const job = f.leased([...f.queued.values()][0]!);
    expect(job.payload).toEqual({ batchId: first.batchId, segmentAttempt: 1 });
    const signal = new AbortController().signal;
    await expect(f.runtime.handler(job, { signal, workerId: "worker" })).resolves.toMatchObject({ status: "completed", segment: { attempt: 1 } });
    expect(retry).toHaveBeenCalledWith(first.batchId, signal);
    expect(resume).not.toHaveBeenCalled();
    expect(f.calls.some(sql => sql.includes("evolution:job-fence"))).toBe(true);
    expect(await f.runtime.capability.status(first.batchId)).toMatchObject({ status: "completed" });
  });

  test("explicit resume authorizes one new segment; repeated resume and delayed old jobs cannot reset/consume it", async () => {
    const f = fixture();
    const first = await f.runtime.capability.run(request);
    const previousJob = f.leased([...f.queued.values()][0]!);
    const batch = f.batches.get(first.batchId)!;
    batch.status = "partial";
    batch.usage.llmCalls = 8;
    batch.segment!.usage.llmCalls = 8;
    const resumed = await f.runtime.capability.resume(first.batchId);
    expect(resumed).toMatchObject({ status: "queued", segment: { attempt: 2, usage: { llmCalls: 0 } }, usage: { llmCalls: 8 } });
    expect(await f.runtime.capability.resume(first.batchId)).toEqual(resumed);
    expect(f.queued.size).toBe(2);
    const retry = vi.spyOn(MemoryEvolutionBatchService.prototype, "retry");
    await expect(f.runtime.handler(previousJob, { signal: new AbortController().signal, workerId: "worker" })).resolves.toMatchObject({ segment: { attempt: 2 } });
    expect(retry).not.toHaveBeenCalled();
  });

  test("bad scope/payload/cancellation fail before database or models; cross-provider composition cannot mint", async () => {
    const f = fixture();
    await f.runtime.capability.run(request);
    const job = f.leased([...f.queued.values()][0]!);
    f.query.mockClear();
    for (const input of [{ ...job, payload: { ...job.payload, path: "/private" } }, { ...job, scope: { ...job.scope, userId: "other" } }]) {
      await expect(f.runtime.handler(input, { signal: new AbortController().signal, workerId: "worker" })).rejects.toMatchObject({ code: "EVOLUTION_INVALID_JOB", retryable: false });
    }
    await expect(f.runtime.handler(job, { signal: AbortSignal.abort(), workerId: "worker" })).rejects.toThrow();
    await expect(f.runtime.capability.run({ ...request, input: { mode: "directory", sourceId: "not-registered" } })).rejects.toThrow("source_not_registered");
    expect(f.query).not.toHaveBeenCalled();
    expect(() => assertEvolutionRuntimeOwner({ ...f.runtime }, f.bundle, scope)).toThrow();
    expect(() => assertEvolutionRuntimeOwner(f.runtime, fixture().bundle, scope)).toThrow();
  });

  test("preview is synchronous and changed selection uses the real provider read without acknowledging events", async () => {
    const f = fixture();
    await expect(f.runtime.capability.run({ ...request, action: "preview" })).resolves.toMatchObject({ status: "completed", usage: { llmCalls: 0 } });
    await expect(f.runtime.capability.run({ ...request, action: "preview", idempotencyKey: "changed", input: { mode: "inventory", selection: "changed" } }))
      .resolves.toMatchObject({ status: "completed", reasons: [] });
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.calls.some(sql => sql.includes("evolution:selection-freeze"))).toBe(true);
    expect(f.calls.some(sql => sql.includes("evolution:changed-ack"))).toBe(false);
  });

  test("default runtime review and cancellation are real provider services guarded by the authenticated owner", async () => {
    const f = fixture();
    const batch = await f.runtime.capability.run(request);
    expect(f.runtime.capability.review?.preview).toBeTypeOf("function");
    expect(f.runtime.capability.review?.apply).toBeTypeOf("function");
    f.query.mockClear();
    await expect(f.runtime.capability.review!.status("review-one")).rejects.toThrow("EVOLUTION_OWNER_REQUIRED");
    await expect(f.runtime.capability.cancel!(batch.batchId)).rejects.toThrow("EVOLUTION_OWNER_REQUIRED");
    expect(f.query).not.toHaveBeenCalled();
    const secret = "owner-test-credential-not-production";
    await withAuthenticatedEvolutionOwner({ secret, owner: authority, headers: { "x-mengshu-owner-token": secret } }, async () => {
      expect(await f.runtime.capability.review!.status("review-one")).toBeUndefined();
      expect(await f.runtime.capability.review!.list!({})).toEqual({ proposals: [] });
      expect(await f.runtime.capability.cancel!(batch.batchId)).toMatchObject({ status: "cancelled", batchId: batch.batchId });
    });
    expect(f.calls.some(sql => sql.includes("evolution:review-get"))).toBe(true);
    expect(f.calls.some(sql => sql.includes("evolution:batch-cancel"))).toBe(true);
    expect(f.batches.get(batch.batchId)?.status).toBe("cancelled");
  });
  test("native control preparation queues typed work on the same handler and owner resume never reaches the model", async () => {
    const f = fixture();
    expect(f.runtime.capability.control?.run).toBeTypeOf("function");
    const control = { input: { mode: "control" as const, work: { kind: "undo_governance" as const,
      operationReceiptId: "a".repeat(64), currentStateHash: "b".repeat(64), reviewReceiptId: "review" } },
      action: "execute_control" as const, idempotencyKey: "control", limits: { maxFiles: 0 } };
    await expect(f.runtime.capability.control!.run(control)).rejects.toThrow("EVOLUTION_OWNER_REQUIRED");
    expect(f.query).not.toHaveBeenCalled();
    const secret = "owner-test-credential-not-production";
    const owner = <T>(work: () => Promise<T>) => withAuthenticatedEvolutionOwner({ secret, owner: authority,
      headers: { "x-mengshu-owner-token": secret } }, work);
    const report = await owner(() => f.runtime.capability.control!.run(control));
    expect(report).toMatchObject({ status: "queued", work: { kind: "undo_governance" }, usage: { files: 0, llmCalls: 0 } });
    const batch = f.batches.get(report.batchId)!;
    const job = [...f.queued.values()][0]!;
    expect(job).toMatchObject({ type: "evolve_memory_batch", payload: { batchId: report.batchId,
      segmentAttempt: 1, control: { kind: "undo_governance", requestHash: batch.requestHash } } });
    f.query.mockClear();
    await expect(f.runtime.handler({ ...f.leased(job), payload: { ...job.payload, control: { kind: "source_reconcile", requestHash: batch.requestHash } } },
      { signal: new AbortController().signal, workerId: "worker" })).rejects.toMatchObject({ code: "EVOLUTION_CONTROL_JOB_MISMATCH" });
    expect(f.calls.some(sql => sql.includes("evolution:undo-original"))).toBe(false);
    batch.status = "partial";
    await expect(f.runtime.capability.resume(report.batchId)).rejects.toThrow("EVOLUTION_OWNER_REQUIRED");
    expect(await owner(() => f.runtime.capability.resume(report.batchId))).toMatchObject({ status: "queued", segment: { attempt: 2 } });
    expect([...f.queued.values()].at(-1)?.payload).toMatchObject({ control: { kind: "undo_governance", requestHash: batch.requestHash }, segmentAttempt: 2 });
  });

  test("actual Runtime creates four handlers only with the trusted host feature and performs no eager source reads", async () => {
    const f = fixture();
    const runtime = createMengshuRuntime({ config, resolvedDbPath: "/unused", defaultScope: scope, db: f.provider,
      continuousMemoryEvolutionHost: { authority, config } });
    expect(runtime.continuousMemoryEvolution?.run).toBeTypeOf("function");
    expect(runtime.continuousMemoryEvolution?.sourceControl?.issueSourceAttestation).toBeTypeOf("function");
    expect(runtime.evolutionHostControl?.state.scope).toEqual(scope);
    expect(runtime.continuousMemoryEvolution?.reuse?.evaluate).toBeTypeOf("function");
    expect(runtime.evolutionReuse?.skillDraftGate.evaluate).toBeTypeOf("function");
    expect(runtime.durableJobV2ServeCapability?.registry.types).toEqual(["build_tree", "evolve_memory_batch", "extract_candidate", "extract_graph"]);
    expect(runtime.durableJobV2ServeCapability?.repository).toBe(runtime.durableJobV2RuntimeBundle?.repository);
    expect(f.query).not.toHaveBeenCalled();
    await expect(runtime.agentFastPath.lookup({ query: "memory", scope: { ...scope, appId: "other" } }))
      .rejects.toThrow("REUSE_HOST_SCOPE_MISMATCH");
    expect(f.query).not.toHaveBeenCalled();
    const disabled = createMengshuRuntime({ config: { ...config, features: { ...config.features, continuousMemoryEvolution: false } }, resolvedDbPath: "/unused", defaultScope: scope, db: f.provider });
    expect(disabled.continuousMemoryEvolution).toBeUndefined();
    expect(disabled.evolutionReuse).toBeUndefined();
    expect(disabled.governedReuse).toBeUndefined();
    expect(disabled.durableJobV2RuntimeBundle?.handlerTypes).toEqual(["build_tree", "extract_candidate", "extract_graph"]);
  });
});
