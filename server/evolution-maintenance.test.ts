import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryConfigSchema } from "../config.js";
import { authority, scope } from "../packages/core/src/evolution/test-fixtures.js";
import { authorityScopeFingerprint } from "../packages/core/src/domain/authority-scope-fingerprint.js";
import { evolutionHash } from "../packages/core/src/evolution/fingerprints.js";
import { PostgresEvolutionRepository } from "../packages/core/src/evolution/postgres-repository.js";
import { PostgresEvolutionMaintenancePort } from "../packages/core/src/evolution/postgres-maintenance.js";
import type { EvolutionBatch, EvolutionRunRequest } from "../packages/core/src/evolution/types.js";
import type { PostgresEvolutionPool } from "../packages/core/src/evolution/postgres-common.js";
import type { EvolutionMaintenanceEnvironment, EvolutionMaintenanceOptions } from "./evolution-maintenance.js";
import { createEvolutionMaintenance } from "./evolution-maintenance.js";
import { evolutionJobIdentity } from "./evolution-job.js";

const { minted } = vi.hoisted(() => ({ minted: new WeakSet<object>() }));
vi.mock("../packages/core/src/db/providers/postgres.js", () => ({
  assertProviderOwnedPostgresDurableJobV2RuntimeBundle: (bundle: { native?: boolean }) => {
    if (!bundle?.native) throw new Error("unminted"); return bundle;
  },
  assertPostgresBundleOwnsEvolutionPersistence: (bundle: object, value: { bundle: object; repository: PostgresEvolutionRepository; job: unknown }, bound: typeof scope, job?: unknown) => {
    if (!value || !minted.has(value) || value.bundle !== bundle || value.job !== job || value.repository.scopeFingerprint !== authorityScopeFingerprint(bound)) throw new Error("unminted");
    return value;
  },
}));
const NOW = Date.UTC(2026, 8, 6, 12);
const limits = { maxRecords: 20, maxFiles: 1, maxBytes: 10000, maxLlmCalls: 2, maxInputTokens: 1000, maxOutputTokens: 500, maxDurationMs: 10000 };
const zero = { records: 0, files: 0, bytes: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 };
const memoryId = "11111111-1111-4111-8111-111111111111";
function transport() {
  const reservations = new Map<string, { request_hash: string; status: string; owner: unknown; day: unknown; tokens: number; cost: number }>();
  let tail = Promise.resolve();
  const query = vi.fn(async (sql: string, p: readonly unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> => {
    const key = JSON.stringify(p.slice(0, 3));
    if (sql.includes("evolution:storage-usage")) return { rows: [{ database_bytes: "1000", evolution_bytes: "100" }] };
    if (sql.includes("evolution:maintenance-due")) return { rows: [{ id: memoryId, revision: 1, content_hash: "a".repeat(64), metadata: {}, evolution_review_due_at: NOW - 100 }] };
    if (sql.includes("evolution:budget-get")) return { rows: reservations.has(key) ? [reservations.get(key)!] : [] };
    if (sql.includes("evolution:budget-total")) {
      const current = [...reservations.values()].filter(r => r.owner === p[0] && r.day === p[1] && r.status !== "released");
      return { rows: [{ tokens: String(current.reduce((n, r) => n + r.tokens, 0)), cost_micros: String(current.reduce((n, r) => n + r.cost, 0)) }] };
    }
    if (sql.includes("evolution:budget-insert")) {
      reservations.set(key, { request_hash: String(p[3]), status: "reserved", owner: p[0], day: p[1], tokens: Number(p[4]), cost: Number(p[5]) });
      return { rows: [{ reservation_id: p[2] }] };
    }
    if (sql.includes("evolution:budget-settle")) {
      const row = reservations.get(key);
      if (!row || row.status !== "reserved" && !(row.status === "settled" && row.tokens === p[3] && row.cost === p[4])) return { rows: [] };
      Object.assign(row, { status: "settled", tokens: p[3], cost: p[4] }); return { rows: [{ reservation_id: p[2] }] };
    }
    if (sql.includes("evolution:lease-lock")) return { rows: [{ id: p[1] }] };
    if (sql.includes("evolution:outcome-event")) return { rows: [{ idempotency_key: p[1] }] };
    return { rows: [] };
  });
  const connect = vi.fn(async () => {
    let unlock = () => {};
    return { query: async (sql: string, p?: readonly unknown[]) => {
      if (sql === "BEGIN") { const previous = tail; tail = new Promise(resolve => { unlock = resolve; }); await previous; }
      const result = await query(sql, p);
      if (sql === "COMMIT" || sql === "ROLLBACK") unlock();
      return result;
    }, release: vi.fn() };
  });
  return { query, connect, pool: { query, connect } as unknown as PostgresEvolutionPool, reservations };
}
function fixture(shared = transport(), bound = scope) {
  let now = NOW;
  const config = memoryConfigSchema.parse({ embedding: { provider: "openai", apiKey: "synthetic", baseURL: "https://example.test/v1" }, llm: { provider: "openai", model: "synthetic", apiKey: "synthetic",
    pricing: { provider: "openai", version: "prices-v1", currency: "USD", minorUnitsPerMajor: 100, models: { default: { inputTokenPrice: 2, outputTokenPrice: 6 } } } },
    features: { continuousMemoryEvolution: true }, evolution: { maintenance: { enabled: true, intervalMs: 60000, quietPeriodMs: 1000, dailyTokens: 10000, dailyMinorUnits: 100, maxStorageBytes: 100000, minFreeBytes: 1000 } } });
  const environment: EvolutionMaintenanceEnvironment = { backgroundMode: "all", foregroundBusy: false, lastForegroundAt: NOW - 2000, freeBytes: 10000 };
  const repository = new PostgresEvolutionRepository({ pool: shared.pool, scope: bound });
  const bundle = { native: true, createEvolutionPersistence: vi.fn((_scope: typeof scope, options: { job?: unknown }) => {
    const persistence = { bundle, repository, job: options.job }; minted.add(persistence); return persistence;
  }) };
  let batch: EvolutionBatch;
  const prepareBatch = vi.fn(async (request: EvolutionRunRequest) => {
    batch ??= { id: evolutionHash(request.idempotencyKey), scope: bound, scopeFingerprint: authorityScopeFingerprint(bound), request: { ...request, limits: { ...limits, ...request.limits } }, requestHash: evolutionHash(request), configFingerprint: "c".repeat(64), policyVersion: "evolution-v1", status: "queued", reasons: [], usage: { ...zero }, segment: { attempt: 1, usage: { ...zero } }, counts: { proposed: 0, applied: 0, rejected: 0, review: 0, noop: 0, skipped: 0 }, cursor: null, createdAt: now, updatedAt: now, version: 1 };
    return structuredClone(batch);
  });
  const enqueueBatch = vi.fn(async (batch: EvolutionBatch) => ({ batchId: batch.id, segmentAttempt: batch.segment!.attempt, jobId: evolutionJobIdentity(bound, batch.id, batch.segment!.attempt).id }));
  const options: EvolutionMaintenanceOptions = { runtimeBundle: bundle as never, authority: { ...authority, allow: { ...authority.allow, appIds: ["app", "second"] } }, scope: bound, config: { config, sources: [], configFingerprint: "c".repeat(64) }, environment: () => environment, prepareBatch, enqueueBatch, limits, dueLimit: 2, retentionLimit: 2, now: () => now };
  const fenced = () => {
    const job = { type: "evolve_memory_batch", status: "running", scope: bound, payload: { batchId: batch.id, segmentAttempt: 1 }, ...evolutionJobIdentity(bound, batch.id, 1) };
    return { job, persistence: bundle.createEvolutionPersistence(bound, { job }), batch: { ...batch, status: "running" }, lease: { batchId: batch.id, scopeFingerprint: repository.scopeFingerprint, ownerId: "worker", fencingToken: 1, expiresAt: now + 10000 } } as unknown as Parameters<ReturnType<typeof createEvolutionMaintenance>["afterBatch"]>[0];
  };
  return { ...shared, options, config, environment, bundle, repository, prepareBatch, enqueueBatch, fenced, batch: () => batch, setNow: (value: number) => { now = value; } };
}
afterEach(() => vi.restoreAllMocks());

describe("native host maintenance driver", () => {
  it.each([null, NaN, Infinity, 1.5, -1])("unknown or invalid backing free space %s blocks before any native query", async freeBytes => {
    const f = fixture(); f.environment.freeBytes = freeBytes;
    expect(await createEvolutionMaintenance(f.options).idleTick()).toMatchObject({ status: "blocked", reasons: ["maintenance_free_space_unknown"] });
    expect(f.query).not.toHaveBeenCalled(); expect(f.prepareBatch).not.toHaveBeenCalled(); expect(f.enqueueBatch).not.toHaveBeenCalled();
  });
  it.each([0, 999])("known insufficient backing free space %i preserves the low-space reason", async freeBytes => {
    const f = fixture(); f.environment.freeBytes = freeBytes;
    expect(await createEvolutionMaintenance(f.options).idleTick()).toMatchObject({ status: "blocked", reasons: ["maintenance_free_space"] });
    expect(f.query).not.toHaveBeenCalled(); expect(f.prepareBatch).not.toHaveBeenCalled(); expect(f.enqueueBatch).not.toHaveBeenCalled();
  });
  it.each(["feature", "maintenance", "paused", "evolution_only", "foreground", "quiet", "cancel"])("does no native IO for %s", async mode => {
    const t = fixture(), abort = new AbortController();
    if (mode === "feature") t.config.features!.continuousMemoryEvolution = false;
    if (mode === "maintenance") t.config.evolution!.maintenance!.enabled = false;
    if (mode === "paused" || mode === "evolution_only") t.environment.backgroundMode = mode;
    if (mode === "foreground") t.environment.foregroundBusy = true;
    if (mode === "quiet") t.environment.lastForegroundAt = NOW;
    if (mode === "cancel") abort.abort();
    expect((await createEvolutionMaintenance(t.options).idleTick(abort.signal)).status).toBe("deferred");
    expect(t.query).not.toHaveBeenCalled(); expect(t.prepareBatch).not.toHaveBeenCalled(); expect(t.bundle.createEvolutionPersistence).not.toHaveBeenCalled();
  });
  it("uses the native due reader, prices the entire batch, and never acknowledges unbound due IDs", async () => {
    const t = fixture(), driver = createEvolutionMaintenance(t.options);
    const result = await driver.idleTick();
    expect(result).toMatchObject({ status: "queued", reservation: { tokens: 1500, currency: "USD", segmentAttempt: 1 } });
    expect(result.reservation!.costMicros).toBeGreaterThanOrEqual(5000);
    expect(t.prepareBatch).toHaveBeenCalledWith(expect.objectContaining({ input: { mode: "inventory", selection: "due" }, action: "propose", limits }), undefined);
    expect(t.query.mock.calls.find(([sql]) => sql.includes("evolution:maintenance-due"))?.[1]?.at(-1)).toBe(2);
    expect(t.query.mock.calls.some(([sql]) => sql.includes("maintenance-enqueue"))).toBe(false);
    t.query.mockClear(); expect((await driver.idleTick()).reasons).toContain("maintenance_interval"); expect(t.query).not.toHaveBeenCalled();
  });
  it.each(["storage", "space", "space_unknown", "unpriced", "units", "scope", "native"])("fails closed for %s without enqueue", async mode => {
    const t = fixture();
    if (mode === "storage") t.config.evolution!.maintenance!.maxStorageBytes = 999;
    if (mode === "space") t.environment.freeBytes = 1;
    if (mode === "space_unknown") t.environment.freeBytes = null;
    if (mode === "unpriced") delete t.config.llm!.pricing;
    if (mode === "units") t.config.llm!.pricing!.minorUnitsPerMajor = 0;
    if (mode === "scope") t.options.scope = { ...scope, userId: "other" };
    if (mode === "native") t.bundle.native = false;
    expect((await createEvolutionMaintenance(t.options).idleTick()).status).toBe("blocked"); expect(t.enqueueBatch).not.toHaveBeenCalled();
    expect(t.query.mock.calls.some(([sql]) => sql.includes("maintenance-due"))).toBe(false);
  });
  it("shares one owner/day reservation across project scopes and does not recharge an idempotent batch", async () => {
    const shared = transport(), t = fixture(shared), other = fixture(shared, { ...scope, appId: "second" });
    t.config.evolution!.maintenance!.dailyTokens = 2000; other.config.evolution!.maintenance!.dailyTokens = 2000;
    const driver = createEvolutionMaintenance(t.options), second = createEvolutionMaintenance(other.options);
    expect((await driver.idleTick()).status).toBe("queued");
    expect((await second.idleTick()).reasons).toContain("maintenance_daily_budget");
    expect((await driver.beforeBatch(t.batch())).status).toBe("admitted");
    expect(shared.reservations.size).toBe(1); expect(other.enqueueBatch).not.toHaveBeenCalled();
  });
  it("retains an uncertain enqueue reservation and replays the same identity after restart", async () => {
    const t = fixture(); t.enqueueBatch.mockRejectedValueOnce(new Error("sensitive external message"));
    expect(await createEvolutionMaintenance(t.options).idleTick()).toMatchObject({ status: "deferred", reasons: ["maintenance_enqueue_uncertain"] });
    const first = t.batch().request.idempotencyKey;
    expect((await createEvolutionMaintenance(t.options).idleTick()).status).toBe("queued");
    expect(t.batch().request.idempotencyKey).toBe(first); expect(t.reservations.size).toBe(1);
    expect(t.query.mock.calls.some(([sql]) => sql.includes("budget-release"))).toBe(false);
  });
  it("checks exact prepared scope/limits/segment before dispatch and exact returned job identity", async () => {
    for (const change of ["scope", "limits", "segment", "receipt"] as const) {
      const t = fixture();
      if (change !== "receipt") {
        const original = t.prepareBatch.getMockImplementation()!;
        t.prepareBatch.mockImplementation(async request => { const batch = await original(request); if (change === "scope") batch.scope.userId = "forged"; if (change === "limits") batch.request.limits.maxLlmCalls++; if (change === "segment") batch.segment!.attempt++; return batch; });
      } else t.enqueueBatch.mockResolvedValueOnce({ batchId: "wrong", segmentAttempt: 2, jobId: "wrong" });
      expect((await createEvolutionMaintenance(t.options).idleTick()).status).toBe("blocked");
      if (change !== "receipt") expect(t.enqueueBatch).not.toHaveBeenCalled();
    }
  });
  it("cancels after reservation without enqueue or refund and rejects automatic segment replenishment", async () => {
    const t = fixture(), abort = new AbortController(), original = t.query.getMockImplementation()!;
    t.query.mockImplementation(async (sql, p) => { const value = await original(sql, p); if (sql.includes("budget-insert")) abort.abort(); return value; });
    const driver = createEvolutionMaintenance(t.options);
    expect((await driver.idleTick(abort.signal)).status).toBe("deferred"); expect(t.reservations.size).toBe(1); expect(t.enqueueBatch).not.toHaveBeenCalled();
    expect((await driver.beforeBatch({ ...t.batch(), segment: { attempt: 2, usage: { ...zero } } })).status).toBe("blocked");
    expect(t.query.mock.calls.some(([sql]) => sql.includes("budget-release"))).toBe(false);
  });
  it("requires bounded native fenced retention, and rechecks quiet state before each mutation", async () => {
    const t = fixture(), driver = createEvolutionMaintenance(t.options); await driver.idleTick();
    const cleanup = vi.spyOn(PostgresEvolutionMaintenancePort.prototype, "cleanupUnreferenced").mockImplementation(async () => { t.environment.foregroundBusy = true; return { status: "deleted", receiptId: "retention-receipt" }; });
    vi.spyOn(PostgresEvolutionMaintenancePort.prototype, "listExpired").mockResolvedValue([
      { id: "orphan-1", revision: "a".repeat(64), kind: "orphan_evidence", expiresAt: NOW - 1 },
      { id: "orphan-2", revision: "b".repeat(64), kind: "orphan_evidence", expiresAt: NOW - 1 },
    ]);
    const result = await driver.afterBatch(t.fenced());
    expect(result).toMatchObject({ status: "deferred", deleted: ["orphan-1"] }); expect(cleanup).toHaveBeenCalledTimes(1);
  });
  it("records compact outcomes under the caller lease, using unfenced list reads and no new timer", async () => {
    const timer = vi.spyOn(globalThis, "setInterval"), t = fixture(), driver = createEvolutionMaintenance(t.options); await driver.idleTick();
    t.query.mockClear();
    const input = t.fenced();
    input.outcomes = [{ outcome: { scope, workId: "unit", inputFingerprint: "input", policyVersion: "evolution-v1", outcome: "noop", reasonCode: "unchanged", at: NOW }, attemptId: "attempt", failureCount: 0 }];
    expect(await driver.afterBatch(input)).toMatchObject({ status: "completed", outcomesRecorded: 1 });
    const calls = t.query.mock.calls.map(([sql]) => sql);
    expect(calls.findIndex(sql => sql.includes("lease-lock"))).toBeLessThan(calls.findIndex(sql => sql.includes("outcome-event")));
    expect(calls.some(sql => sql.includes("retention-list"))).toBe(true); expect(timer).not.toHaveBeenCalled();
    expect((await driver.afterBatch({ ...input, persistence: { ...input.persistence } })).status).toBe("blocked");
    expect((await driver.afterBatch({ ...input, job: { ...input.job } })).status).toBe("blocked");
    expect((await driver.afterBatch({ ...input, lease: { ...input.lease, scopeFingerprint: "d".repeat(64) } })).status).toBe("blocked");
  });
  it("keeps missing actual usage reserved, settles precise host usage once, and rejects contradictory settlement", async () => {
    const t = fixture(), driver = createEvolutionMaintenance(t.options), tick = await driver.idleTick();
    const reservation = tick.reservation!;
    expect((await driver.settleReservation({ batch: t.batch(), reservation })).status).toBe("retained");
    const batch = { ...t.batch(), status: "completed" as const };
    const usage = { batchId: batch.id, scopeFingerprint: batch.scopeFingerprint, segmentAttempt: 1 as const, complete: true as const, provider: "openai", model: "synthetic", currency: "USD", pricingSnapshotVersion: "prices-v1", inputTokens: 10, outputTokens: 5, estimatedMinorUnits: 0.005 };
    expect((await driver.settleReservation({ batch, reservation, usage: { ...usage, estimatedMinorUnits: undefined } })).status).toBe("retained");
    expect((await driver.settleReservation({ batch, reservation, usage })).status).toBe("settled");
    expect((await driver.settleReservation({ batch, reservation, usage })).status).toBe("settled");
    expect((await driver.settleReservation({ batch, reservation, usage: { ...usage, inputTokens: 11 } })).status).toBe("blocked");
    expect((await driver.settleReservation({ batch, reservation, usage: { ...usage, currency: "EUR" } })).status).toBe("blocked");
  });
  it("does not let a forged settlement ticket reduce another same-owner reservation", async () => {
    const shared = transport(), t = fixture(shared), other = fixture(shared, { ...scope, appId: "second" });
    const driver = createEvolutionMaintenance(t.options), otherTick = await createEvolutionMaintenance(other.options).idleTick(), tick = await driver.idleTick();
    const batch = { ...t.batch(), status: "completed" as const };
    const usage = { batchId: batch.id, scopeFingerprint: batch.scopeFingerprint, segmentAttempt: 1 as const, complete: true as const, provider: "openai", model: "synthetic", currency: "USD", pricingSnapshotVersion: "prices-v1", inputTokens: 10, outputTokens: 5, estimatedMinorUnits: 0.005 };
    const forged = { ...tick.reservation!, reservationId: otherTick.reservation!.reservationId };
    expect((await driver.settleReservation({ batch, reservation: forged, usage })).status).toBe("blocked");
    expect([...shared.reservations.values()].every(r => r.status === "reserved")).toBe(true);
  });
  it("defers and rolls back when foreground work appears inside the outcome transaction", async () => {
    const t = fixture(), driver = createEvolutionMaintenance(t.options); await driver.idleTick();
    const original = t.query.getMockImplementation()!;
    t.query.mockImplementation(async (sql, p) => { const r = await original(sql, p); if (sql.includes("outcome-event")) t.environment.foregroundBusy = true; return r; });
    const input = t.fenced();
    input.outcomes = [{ outcome: { scope, workId: "unit", inputFingerprint: "input", policyVersion: "evolution-v1", outcome: "noop", reasonCode: "unchanged", at: NOW }, attemptId: "attempt", failureCount: 0 }];
    expect((await driver.afterBatch(input)).status).toBe("deferred");
    expect(t.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });
  it("defers stale retention work instead of announcing that cleanup completed", async () => {
    const t = fixture(), driver = createEvolutionMaintenance(t.options); await driver.idleTick();
    vi.spyOn(PostgresEvolutionMaintenancePort.prototype, "listExpired").mockResolvedValue([{ id: "orphan", revision: "a".repeat(64), kind: "orphan_evidence", expiresAt: NOW - 1 }]);
    vi.spyOn(PostgresEvolutionMaintenancePort.prototype, "cleanupUnreferenced").mockResolvedValue({ status: "stale" });
    expect(await driver.afterBatch(t.fenced())).toMatchObject({ status: "deferred", deleted: [], preserved: ["orphan"] });
  });
  it("uses extraction pricing and exact minor-unit conversion for the shared monetary ceiling", async () => {
    const t = fixture(); t.config.llm!.extractionModel = "extract";
    t.config.llm!.pricing!.models.extractionModel = { inputTokenPrice: 8, outputTokenPrice: 12 };
    t.config.llm!.pricing!.minorUnitsPerMajor = 1000; t.config.evolution!.maintenance!.dailyMinorUnits = 1;
    expect((await createEvolutionMaintenance(t.options).idleTick()).reasons).toEqual(["maintenance_daily_budget"]);
    expect(t.enqueueBatch).not.toHaveBeenCalled(); expect(t.reservations.size).toBe(0);
    const total = t.query.mock.calls.find(([sql]) => sql.includes("budget-total")); expect(total).toBeDefined();
    const priced = fixture(); priced.config.llm!.pricing!.models.default = { inputTokenPrice: 1e-10, outputTokenPrice: 1e-10 };
    const small = await createEvolutionMaintenance(priced.options).idleTick();
    expect(small.status).toBe("queued"); expect(small.reservation!.costMicros).toBeGreaterThan(0);
  });
  it("rejects unsafe prices, counters and missing native ports before scheduling", async () => {
    for (const variant of ["price", "counter", "missing", "limit", "mode"] as const) {
      const t = fixture();
      if (variant === "price") t.config.llm!.pricing!.models.default.inputTokenPrice = Number.MAX_VALUE;
      if (variant === "counter") t.config.evolution!.maintenance!.dailyMinorUnits = Number.MAX_SAFE_INTEGER;
      if (variant === "missing") t.options.runtimeBundle = { native: true } as never;
      if (variant === "limit") t.options.limits = { ...limits, maxLlmCalls: 0 };
      if (variant === "mode") t.environment.backgroundMode = "unknown" as never;
      expect((await createEvolutionMaintenance(t.options).idleTick()).status).toBe("blocked"); expect(t.enqueueBatch).not.toHaveBeenCalled();
    }
  });
  it("reads only one due page, does not invent other work kinds, and handles no due work", async () => {
    const t = fixture(), list = vi.spyOn(PostgresEvolutionMaintenancePort.prototype, "listDue").mockResolvedValue([]);
    expect((await createEvolutionMaintenance(t.options).idleTick()).status).toBe("idle"); expect(list).toHaveBeenCalledTimes(1); expect(t.prepareBatch).not.toHaveBeenCalled();
    list.mockResolvedValueOnce([{ id: "other-kind", kind: "propose_skill", scope, revision: "r1", dueAt: NOW - 1, budget: { records: 1, files: 0, bytes: 1, llmCalls: 0, inputTokens: 0, outputTokens: 0, durationMs: 1, costMicros: 0 } }]);
    expect((await createEvolutionMaintenance(t.options).idleTick()).status).toBe("blocked");
    expect(t.prepareBatch).not.toHaveBeenCalled();
  });
  it("serializes idle ticks while an existing bounded callback is pending", async () => {
    const t = fixture(); let done!: () => void;
    const original = t.prepareBatch.getMockImplementation()!;
    t.prepareBatch.mockImplementation(async request => { await new Promise<void>(resolve => { done = resolve; }); return original(request); });
    const driver = createEvolutionMaintenance(t.options), pending = driver.idleTick();
    await vi.waitFor(() => expect(t.prepareBatch).toHaveBeenCalledOnce());
    expect((await driver.idleTick()).reasons).toEqual(["maintenance_tick_busy"]);
    done(); expect((await pending).status).toBe("queued"); expect(t.enqueueBatch).toHaveBeenCalledOnce();
  });
  it("rechecks free space after reservation and preserves that uncertain charge", async () => {
    const t = fixture(), original = t.query.getMockImplementation()!;
    t.query.mockImplementation(async (sql, p) => { const value = await original(sql, p); if (sql.includes("budget-insert")) t.environment.freeBytes = 0; return value; });
    expect((await createEvolutionMaintenance(t.options).idleTick()).status).toBe("blocked");
    expect(t.enqueueBatch).not.toHaveBeenCalled(); expect(t.reservations.size).toBe(1);
  });
  it("reserves the current day on delayed execution without resetting the batch segment", async () => {
    const t = fixture(), driver = createEvolutionMaintenance(t.options); const tick = await driver.idleTick();
    t.setNow(NOW + 86400000);
    const admission = await driver.beforeBatch(t.batch());
    expect(admission.status).toBe("admitted"); expect(admission.reservation!.dayKey).not.toBe(tick.reservation!.dayKey);
    expect(t.reservations.size).toBe(2); expect(t.batch().segment!.usage).toEqual(zero);
    expect((await driver.beforeBatch({ ...t.batch(), status: "partial" })).status).toBe("deferred");
    expect((await driver.beforeBatch({ ...t.batch(), request: { ...t.batch().request, idempotencyKey: "ordinary" } })).status).toBe("not_maintenance");
  });
  it("does not run retention on cancellation, scope mismatch, or a stale database lease", async () => {
    const t = fixture(), driver = createEvolutionMaintenance(t.options); await driver.idleTick();
    const input = t.fenced(), abort = new AbortController(); abort.abort(); t.query.mockClear();
    expect((await driver.afterBatch({ ...input, signal: abort.signal })).status).toBe("deferred"); expect(t.query).not.toHaveBeenCalled();
    input.outcomes = [{ outcome: { scope: { ...scope, appId: "second" }, workId: "unit", inputFingerprint: "input", policyVersion: "evolution-v1", outcome: "noop", reasonCode: "unchanged", at: NOW }, attemptId: "attempt", failureCount: 0 }];
    expect((await driver.afterBatch(input)).status).toBe("blocked"); expect(t.query).not.toHaveBeenCalled();
    input.outcomes = [{ ...input.outcomes[0], outcome: { ...input.outcomes[0].outcome, scope } }];
    const original = t.query.getMockImplementation()!;
    t.query.mockImplementation((sql, p) => sql.includes("lease-lock") ? Promise.resolve({ rows: [] }) : original(sql, p));
    expect((await driver.afterBatch(input)).reasons).toEqual(["maintenance_lock_busy"]);
    expect(t.query.mock.calls.some(([sql]) => sql.includes("outcome-event"))).toBe(false);
  });
  it.each(["EVOLUTION_CONNECTION_ACQUIRE_TIMEOUT", "EVOLUTION_TRANSACTION_TIMEOUT", "EVOLUTION_QUERY_CANCELLED"])("defers native %s with a finite public reason", async code => {
    const t = fixture();
    vi.spyOn(PostgresEvolutionMaintenancePort.prototype, "listDue").mockRejectedValue(Object.assign(new Error("private connection details"), { code }));
    const response = await createEvolutionMaintenance(t.options).idleTick();
    expect(response).toEqual({ status: "deferred", reasons: ["maintenance_query_deferred"] });
    expect(t.prepareBatch).not.toHaveBeenCalled();
  });
});
