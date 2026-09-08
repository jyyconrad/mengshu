import { describe, expect, test, vi } from "vitest";
import { budgetEvolutionControlPool } from "./evolution-control-budget.js";
import { transaction, type PostgresEvolutionPool } from "../../evolution/postgres-common.js";

function fixture(rows: Record<string, unknown>[] = []) {
  const calls: string[] = [];
  const query = vi.fn(async (sql: string) => { calls.push(sql); return { rows: sql.startsWith("SELECT value") ? rows : [],
    rowCount: sql.startsWith("UPDATE") ? 2 : sql.startsWith("SELECT value") ? rows.length : 0 }; });
  const release = vi.fn();
  const pool = { query, connect: async () => ({ query, release }) } as unknown as PostgresEvolutionPool;
  return { pool, calls, query, release };
}
describe("provider control I/O budget", () => {
  test("counts rows and affected writes across transactions rather than resetting per query", async () => {
    const f = fixture([{ value: "one" }]);
    const pool = budgetEvolutionControlPool(f.pool, { maxRecords: 3, maxBytes: 1000 });
    await transaction(pool, client => client.query("SELECT value"));
    await transaction(pool, client => client.query("UPDATE row"));
    await expect(transaction(pool, client => client.query("SELECT value"))).rejects.toThrow("CONTROL_MAX_RECORDS");
    expect(f.calls.at(-1)).toBe("ROLLBACK"); expect(f.release).toHaveBeenCalledTimes(3);
  });
  test("oversized returned evidence rolls back; oversized parameters never reach SQL", async () => {
    const f = fixture([{ value: "x".repeat(500) }]);
    const pool = budgetEvolutionControlPool(f.pool, { maxRecords: 5, maxBytes: 100 });
    await expect(transaction(pool, client => client.query("SELECT value"))).rejects.toThrow("CONTROL_MAX_BYTES");
    expect(f.calls).not.toContain("COMMIT"); expect(f.calls.at(-1)).toBe("ROLLBACK");
    const before = f.query.mock.calls.length;
    await expect(pool.query("UPDATE secret", ["x".repeat(200)])).rejects.toThrow("CONTROL_MAX_BYTES");
    expect(f.query).toHaveBeenCalledTimes(before);
  });
  test("invalid accounting fails closed and never commits a mutated row", async () => {
    const f = fixture(); f.query.mockImplementationOnce(async () => ({ rows: [], rowCount: -1 }));
    const pool = budgetEvolutionControlPool(f.pool, { maxRecords: 1, maxBytes: 100 });
    await expect(pool.query("UPDATE row")).rejects.toThrow("CONTROL_IO_ACCOUNTING_INVALID");
    expect(() => budgetEvolutionControlPool(f.pool, { maxRecords: 0, maxBytes: 100 })).toThrow("CONTROL_BUDGET_INVALID");
  });
});
