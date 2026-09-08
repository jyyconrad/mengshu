import { describe, expect, test, vi } from "vitest";
import { PostgresEvolutionBudgetLedger } from "./postgres-budget.js";

function harness(total = { tokens: "0", cost_micros: "0" }) {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes("evolution:budget-total")) return { rows: [total] };
    if (sql.includes("evolution:budget-insert")) return { rows: [{ reservation_id: params[2] }] };
    return { rows: [] };
  });
  const release = vi.fn();
  const ledger = new PostgresEvolutionBudgetLedger({ pool: { query, connect: async () => ({ query, release }) } as never, owner: { tenantId: "tenant", userId: "owner" }, now: () => Date.UTC(2026, 8, 5) });
  return { ledger, calls, release };
}
describe("PostgresEvolutionBudgetLedger", () => {
  test("storage accounting includes both new host control tables", async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [{ database_bytes: "10000", evolution_bytes: "2000" }] }));
    const ledger = new PostgresEvolutionBudgetLedger({ pool: { query } as never, owner: { tenantId: "tenant", userId: "owner" } });
    expect(await ledger.storageUsage()).toEqual({ databaseBytes: 10000, evolutionBytes: 2000 });
    expect(query.mock.calls[0]?.[0]).toContain("'mengshu_evolution_host_state'");
    expect(query.mock.calls[0]?.[0]).toContain("'mengshu_evolution_host_receipts'");
  });
  test("serializes all project scopes using one owner-day lock before reserve", async () => {
    const h = harness();
    const result = await h.ledger.reserve({ idempotencyKey: "job", tokens: 100, costMicros: 10, limits: { tokens: 1000, costMicros: 100 } });
    expect(result).toMatchObject({ dayKey: "2026-09-05", tokens: 100 });
    expect(h.calls[0]?.sql).toBe("BEGIN");
    expect(h.calls[1]?.sql).toContain("set_config('lock_timeout'");
    expect(h.calls[2]?.sql).toContain("pg_advisory_xact_lock");
    expect(h.calls.at(-1)?.sql).toBe("COMMIT");
    expect(h.calls.find(c => c.sql.includes("evolution:budget-total"))?.sql).not.toContain("expires_at >");
  });
  test("expired uncertain reservations remain charged and deny over-budget work", async () => {
    const h = harness({ tokens: "990", cost_micros: "0" });
    await expect(h.ledger.reserve({ idempotencyKey: "job", tokens: 100, costMicros: 10, limits: { tokens: 1000, costMicros: 100 } })).resolves.toBeUndefined();
    expect(h.calls.some(c => c.sql.includes("evolution:budget-insert"))).toBe(false);
  });
  test("rejects invalid counters without a transaction", async () => {
    const h = harness();
    await expect(h.ledger.reserve({ idempotencyKey: "job", tokens: -1, costMicros: 10, limits: { tokens: 1000, costMicros: 100 } })).rejects.toThrow("INVALID_INTEGER");
    expect(h.calls).toHaveLength(0);
  });
});
