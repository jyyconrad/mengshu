import { describe, expect, test, vi } from "vitest";
import { transaction } from "./postgres-common.js";

describe("postgres evolution short transaction limits", () => {
  test.each([['55P03', 'LOCK_BUSY'], ['57014', 'QUERY_TIMEOUT']])("database %s rolls back and releases the connection", async (code, outcome) => {
    const calls: string[] = [];
    const query = vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql === 'SELECT locked_work()') throw Object.assign(new Error('blocked'), { code });
      return { rows: [] };
    });
    const release = vi.fn();
    await expect(transaction({ connect: async () => ({ query, release }), query } as never, client => client.query('SELECT locked_work()'))).rejects.toThrow(outcome);
    expect(calls[0]).toBe('BEGIN');
    expect(calls[1]).toContain("set_config('lock_timeout', '250ms', true)");
    expect(calls[1]).toContain("set_config('statement_timeout', '5000ms', true)");
    expect(calls[1]).toContain("set_config('idle_in_transaction_session_timeout', '5000ms', true)");
    expect(calls.at(-1)).toBe('ROLLBACK');
    expect(release).toHaveBeenCalledTimes(1);
  });
});
