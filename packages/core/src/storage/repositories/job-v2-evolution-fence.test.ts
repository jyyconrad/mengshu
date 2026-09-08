import { describe, expect, test, vi } from "vitest";
import { createDurableJobHandlerRegistry, createDurableJobV2, leaseDurableJobV2 } from "./job-v2.js";
import { fenceEvolutionPool } from "./job-v2-evolution-fence.js";

const scope = { tenantId: "t", userId: "u", appId: "a", projectId: "p", agentId: "agent", namespace: "memories", visibility: "private" as const };
function job() {
  const queued = createDurableJobV2({ id: "job", type: "evolve_memory_batch", payload: { batchId: "batch" }, scope, dedupeKey: "batch", maxAttempts: 3 }, { registry: createDurableJobHandlerRegistry(["evolve_memory_batch"]), now: 1 });
  return leaseDurableJobV2(queued, { owner: "worker", leaseMs: 100, now: 2, tokenFactory: () => "a".repeat(32) }).job;
}
function fixture(responses = [[{ id: "job" }], [{ id: "job" }]]) {
  const calls: string[] = [];
  const query = vi.fn(async (sql: string) => {
    calls.push(sql);
    return { rows: sql.includes("evolution:job-fence") ? responses.shift() ?? [] : [], rowCount: 0 };
  });
  const release = vi.fn();
  const pool = { query, connect: async () => ({ query, release }) };
  return { pool, calls, release };
}
describe("evolution provider transaction job fencing", () => {
  test("wraps autocommit checkpoint writes in the exact job fence transaction", async () => {
    const f = fixture();
    await fenceEvolutionPool(f.pool as never, job()).query("UPDATE checkpoint");
    expect(f.calls[0]).toBe("BEGIN");
    expect(f.calls[1]).toContain("set_config('lock_timeout', '250ms', true)");
    expect(f.calls[1]).toContain("set_config('statement_timeout', '5000ms', true)");
    const firstFence = f.calls.findIndex((sql) => sql.includes("evolution:job-fence"));
    expect(firstFence).toBeGreaterThan(1);
    expect(f.calls[firstFence]).toContain("FOR UPDATE");
    expect(f.calls[firstFence]).toContain("lease_generation = $11");
    expect(f.calls[firstFence]).toContain("clock_timestamp()");
    expect(f.calls.indexOf("UPDATE checkpoint")).toBeGreaterThan(firstFence);
    expect(f.calls.at(-1)).toBe("COMMIT");
    expect(f.release).toHaveBeenCalledTimes(1);
  });
  test("expired fence at commit rolls back the domain mutation", async () => {
    const f = fixture([[{ id: "job" }], []]);
    const client = await fenceEvolutionPool(f.pool as never, job()).connect();
    await client.query("BEGIN");
    await client.query("INSERT receipt");
    await expect(client.query("COMMIT")).rejects.toThrow("EVOLUTION_JOB_LEASE_LOST");
    expect(f.calls).not.toContain("COMMIT");
    expect(f.calls.at(-1)).toBe("ROLLBACK");
    client.release();
  });
  test("stale generation or cancellation cannot start a mutation", async () => {
    const stale = fixture([[]]);
    await expect(fenceEvolutionPool(stale.pool as never, job()).query("UPDATE memories"))
      .rejects.toThrow("EVOLUTION_JOB_LEASE_LOST");
    expect(stale.calls).not.toContain("UPDATE memories");
    const cancelled = fixture();
    await expect(fenceEvolutionPool(cancelled.pool as never, job(), AbortSignal.abort()).query("UPDATE memories"))
      .rejects.toThrow("EVOLUTION_JOB_CANCELLED");
    expect(cancelled.calls).not.toContain("UPDATE memories");
  });
});
