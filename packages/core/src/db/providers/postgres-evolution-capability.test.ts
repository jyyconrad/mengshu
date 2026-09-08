import { afterEach, describe, expect, test, vi } from "vitest";
import { PostgresProvider, assertPostgresBundleOwnsEvolutionPersistence } from "./postgres.js";
import { createDurableJobHandlerRegistry, createDurableJobV2, leaseDurableJobV2 } from "../../storage/repositories/job-v2.js";
import type { EvolutionEvidence } from "../../evolution/types.js";
import { computeCanonicalContentHash } from "../../scoring/hash-utils.js";

const scope = { tenantId: "tenant", userId: "user", appId: "app", projectId: "project", agentId: "agent", namespace: "memories", visibility: "private" as const };
function fixture() {
  const provider = new PostgresProvider({ host: "unused", database: "unused", port: 5432, user: "unused", password: "unused" }, "text-embedding-3-small");
  const bundle = provider.createDurableJobV2RuntimeBundle({ clock: () => 100, tokenFactory: () => "a".repeat(32), backoffMs: () => 100, enableMemoryEvolution: true });
  const queued = createDurableJobV2({ id: "job", type: "evolve_memory_batch", payload: { batchId: "batch", segmentAttempt: 1 }, dedupeKey: "batch", scope, maxAttempts: 3 }, { now: 100, registry: createDurableJobHandlerRegistry(bundle.handlerTypes) });
  const job = leaseDurableJobV2(queued, { now: 101, owner: "worker", leaseMs: 1000, tokenFactory: () => "b".repeat(32) }).job;
  return { provider, bundle, job };
}
afterEach(() => vi.restoreAllMocks());
describe("provider-owned evolution composition", () => {
  test("WeakMap rejects copies, another provider, different scope and missing job fence", () => {
    const f = fixture();
    const persistence = f.bundle.createEvolutionPersistence!(scope, { job: f.job });
    expect(Object.isFrozen(persistence)).toBe(true);
    expect(assertPostgresBundleOwnsEvolutionPersistence(f.bundle, persistence, scope, f.job)).toBe(persistence);
    expect(() => assertPostgresBundleOwnsEvolutionPersistence(f.bundle, { ...persistence }, scope, f.job)).toThrow();
    expect(() => assertPostgresBundleOwnsEvolutionPersistence(fixture().bundle, persistence, scope, f.job)).toThrow();
    expect(() => assertPostgresBundleOwnsEvolutionPersistence(f.bundle, persistence, { ...scope, sessionId: "other" }, f.job)).toThrow();
    expect(() => assertPostgresBundleOwnsEvolutionPersistence(f.bundle, persistence, scope)).toThrow();
    expect(() => f.bundle.createEvolutionPersistence!({ ...scope, projectId: "other" }, { job: f.job })).toThrow("EVOLUTION_JOB_SCOPE_MISMATCH");
  });
  test("native control ports require the minted job for mutations and reject cancellation before SQL", async () => {
    const f = fixture(), query = vi.fn(async () => ({ rows: [] }));
    Object.assign(f.provider, { pool: { query, connect: async () => ({ query, release() {} }) }, schemaVersion: 37, schemaContractState: "ready" });
    vi.spyOn(f.provider, "initialize").mockResolvedValue();
    const readonly = f.bundle.createEvolutionPersistence!(scope, {}).createControlPorts({ limits: { maxRecords: 100, maxBytes: 10000 } });
    const lease = { batchId: "batch", scopeFingerprint: f.bundle.createEvolutionPersistence!(scope, {}).repository.scopeFingerprint,
      ownerId: "owner", fencingToken: 1, expiresAt: Date.now() + 10000 };
    expect(() => readonly.source("docs", "a".repeat(64))).toThrow("CONTROL_JOB_REQUIRED");
    await expect(readonly.undo({ operationReceiptId: "a".repeat(64), currentStateHash: "b".repeat(64),
      reviewReceiptId: "review", idempotencyKey: "undo", lease })).rejects.toThrow("CONTROL_JOB_REQUIRED");
    expect(query).not.toHaveBeenCalled();
    const controlled = f.bundle.createEvolutionPersistence!(scope, { job: f.job }).createControlPorts({
      limits: { maxRecords: 100, maxBytes: 10000 }, signal: AbortSignal.abort() });
    await expect(controlled.previewUndo({ operationReceiptId: "a".repeat(64) })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  test("inventory revalidation while canonical transaction holds the job row never reacquires that lock", async () => {
    const f = fixture();
    let owner: number | undefined;
    let serial = 0;
    const query = vi.fn();
    const statements: Array<{ id: number; sql: string }> = [];
    const connect = vi.fn(async () => {
      const id = ++serial;
      return {
        query: async (sql: string) => {
          statements.push({ id, sql });
          if (sql.includes("evolution:job-fence")) {
            if (owner !== undefined && owner !== id) throw new Error("second connection would self-deadlock");
            owner = id;
            return { rows: [{ id: f.job.id }], rowCount: 1 };
          }
          if (sql === "COMMIT" || sql === "ROLLBACK") { if (owner === id) owner = undefined; }
          return { rows: [], rowCount: 0 };
        },
        release: () => { if (owner === id) owner = undefined; },
      };
    });
    Object.assign(f.provider, { pool: { query, connect }, schemaVersion: 37, schemaContractState: "ready" });
    vi.spyOn(f.provider, "initialize").mockResolvedValue();
    const persistence = f.bundle.createEvolutionPersistence!(scope, { job: f.job });
    const canonicalClient = await persistence.repository.pool.connect();
    try {
      await canonicalClient.query("BEGIN");
      expect(owner).toBe(1);
      const evidence: EvolutionEvidence = { id: "raw", text: "quote", sourceId: "source", revision: "1", snapshotHash: "a".repeat(64), rootEvidenceId: "root", scope, trust: "untrusted", origin: "external" };
      await expect(persistence.inventory.verifyEvidence(scope, [evidence])).resolves.toEqual({ valid: false, reason: "SOURCE_CHANGED_OR_REVOKED" });
      expect(query).not.toHaveBeenCalled();
      expect(connect).toHaveBeenCalledTimes(2);
      const read = statements.filter(statement => statement.id === 2).map(statement => statement.sql);
      expect(read.some(sql => sql.includes("evolution:inventory-hydrate"))).toBe(true);
      expect(read.some(sql => sql.includes("evolution:job-fence"))).toBe(false);
      expect(read[0]).toBe("BEGIN");
      expect(read[1]).toContain("set_config('lock_timeout', '250ms', true)");
      expect(read.at(-1)).toBe("COMMIT");
      expect(owner).toBe(1);
      await expect(persistence.relatedTargets.resolve({ scope, evidence: [{ ...evidence, snapshotHash: computeCanonicalContentHash(evidence.text) }],
        limit: 8, maxBytes: 4096 })).resolves.toEqual({ targets: [], recordsRead: 0, bytesRead: 0 });
      expect(connect).toHaveBeenCalledTimes(3);
      const related = statements.filter(statement => statement.id === 3).map(statement => statement.sql);
      expect(related.some(sql => sql.includes("evolution:related-targets"))).toBe(true);
      expect(related.some(sql => sql.includes("evolution:job-fence"))).toBe(false);
      expect(related[1]).toContain("set_config('lock_timeout', '250ms', true)");
      expect(owner).toBe(1);
      await canonicalClient.query("COMMIT");
    } finally { canonicalClient.release(); }
  });

  test.each([35, 36])("readiness rejects v%i before SQL because the default control plane requires governance tables", async version => {
    const f = fixture();
    const query = vi.fn();
    Object.assign(f.provider, { pool: { query }, schemaVersion: version, schemaContractState: "ready" });
    vi.spyOn(f.provider, "initialize").mockResolvedValue();
    await expect(f.provider.assertEvolutionReady()).rejects.toThrow("continuous memory evolution schema v37 is required");
    expect(query).not.toHaveBeenCalled();
  });

  test("v37 readiness requires every default evolution control table, not only the v36 batch ledger", async () => {
    const f = fixture();
    const tables = { batches: true, receipts: true, processed: true, reviews: true, sources: true,
      operations: true, budgets: true, host_state: true, host_receipts: true };
    const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith("SELECT\n") ? [{ ...tables }] : [] }));
    Object.assign(f.provider, { pool: { query, connect: async () => ({ query, release() {} }) }, schemaVersion: 37, schemaContractState: "ready" });
    vi.spyOn(f.provider, "initialize").mockResolvedValue();
    await expect(f.provider.assertEvolutionReady()).resolves.toBeUndefined();
    for (const name of Object.keys(tables)) {
      tables[name as keyof typeof tables] = false;
      await expect(f.provider.assertEvolutionReady()).rejects.toThrow("EVOLUTION_SCHEMA_CAPABILITY_UNAVAILABLE");
      tables[name as keyof typeof tables] = true;
    }
  });
});
