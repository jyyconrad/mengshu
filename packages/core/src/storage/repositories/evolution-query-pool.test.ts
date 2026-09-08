import { afterEach, describe, expect, test, vi } from "vitest";
import { POSTGRES_EVOLUTION_TRANSACTION_LIMITS_SQL } from "../../evolution/postgres-common.js";
import { boundEvolutionPool, EVOLUTION_CONNECTION_ACQUIRE_TIMEOUT_MS } from "./evolution-query-pool.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(run: (sql: string) => Promise<{ rows: Record<string, unknown>[] }> = async () => ({ rows: [] })) {
  const query = vi.fn(async (sql: string) => run(sql));
  const release = vi.fn((_error?: Error) => {});
  const connect = vi.fn(async () => ({ query, release }));
  return { pool: { query, connect }, query, release, connect };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("evolution-only database execution boundary", () => {
  test("bounds autocommit reads inside a local transaction without changing session defaults", async () => {
    const f = fixture();
    await boundEvolutionPool(f.pool as never).query("SELECT evidence");
    const sql = f.query.mock.calls.map(([text]) => text);
    expect(sql[0]).toBe("BEGIN");
    expect(sql[1]).toContain("set_config('lock_timeout', '250ms', true)");
    expect(sql[1]).toContain("set_config('statement_timeout', '5000ms', true)");
    expect(sql[1]).toContain("set_config('idle_in_transaction_session_timeout', '5000ms', true)");
    expect(sql.indexOf("SELECT evidence")).toBeGreaterThan(1);
    expect(sql.at(-1)).toBe("COMMIT");
    expect(sql.some((text) => /pg_(cancel|terminate)_backend|SET\s+(SESSION|GLOBAL)/i.test(text))).toBe(false);
    expect(f.release).toHaveBeenCalledExactlyOnceWith();
  });

  test("a database lock timeout waits for rollback before returning the connection", async () => {
    const rollback = deferred<{ rows: Record<string, unknown>[] }>();
    const failure = Object.assign(new Error("lock unavailable"), { code: "55P03" });
    const f = fixture(async (sql) => {
      if (sql === "SELECT locked") throw failure;
      if (sql === "ROLLBACK") return rollback.promise;
      return { rows: [] };
    });
    const settled = vi.fn();
    const work = boundEvolutionPool(f.pool as never).query("SELECT locked").then(settled, settled);
    await vi.waitFor(() => expect(f.query).toHaveBeenCalledWith("ROLLBACK", []));
    expect(settled).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
    rollback.resolve({ rows: [] });
    await work;
    expect(settled).toHaveBeenCalledWith(failure);
    expect(f.release).toHaveBeenCalledExactlyOnceWith();
  });

  test("abort during SQL awaits its bounded database completion and rollback, not a Promise.race", async () => {
    const queryResult = deferred<{ rows: Record<string, unknown>[] }>();
    const f = fixture(async (sql) => sql === "UPDATE bounded" ? queryResult.promise : { rows: [] });
    const abort = new AbortController();
    const settled = vi.fn();
    const work = boundEvolutionPool(f.pool as never, abort.signal).query("UPDATE bounded").then(settled, settled);
    await vi.waitFor(() => expect(f.query).toHaveBeenCalledWith("UPDATE bounded", []));
    abort.abort();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
    queryResult.resolve({ rows: [] });
    await work;
    expect(settled.mock.calls[0]?.[0]).toMatchObject({ code: "EVOLUTION_QUERY_CANCELLED" });
    expect(f.query).toHaveBeenCalledWith("ROLLBACK", []);
    expect(f.query).not.toHaveBeenCalledWith("COMMIT", []);
    expect(f.release).toHaveBeenCalledExactlyOnceWith();
  });

  test("later statements and repository timeout setup cannot reset a short transaction's remaining budget", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const f = fixture();
    const client = await boundEvolutionPool(f.pool as never).connect();
    await client.query("BEGIN");
    clock.mockReturnValue(4_000);
    await client.query(POSTGRES_EVOLUTION_TRANSACTION_LIMITS_SQL);
    expect(f.query.mock.calls.at(-1)?.[0]).toContain("set_config('statement_timeout', '1000ms', true)");
    clock.mockReturnValue(5_001);
    await expect(client.query("UPDATE too_late")).rejects.toMatchObject({ code: "EVOLUTION_TRANSACTION_TIMEOUT" });
    expect(f.query).not.toHaveBeenCalledWith("UPDATE too_late", []);
    expect(f.query).toHaveBeenCalledWith("ROLLBACK", []);
    client.release();
  });

  test("rollback failure destroys only the borrowed evolution connection", async () => {
    const f = fixture(async (sql) => {
      if (sql === "UPDATE broken" || sql === "ROLLBACK") throw new Error("connection unavailable");
      return { rows: [] };
    });
    await expect(boundEvolutionPool(f.pool as never).query("UPDATE broken"))
      .rejects.toMatchObject({ code: "EVOLUTION_QUERY_ROLLBACK_FAILED" });
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  test("releasing an unfinished transaction discards the connection instead of returning held locks to the pool", async () => {
    const f = fixture();
    const client = await boundEvolutionPool(f.pool as never).connect();
    await client.query("BEGIN");
    client.release();
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.release.mock.calls[0]?.[0]).toMatchObject({ code: "EVOLUTION_TRANSACTION_ABANDONED" });
    await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "EVOLUTION_QUERY_CLIENT_RELEASED" });
  });

  test("abort while acquiring a connection releases the eventual client before BEGIN", async () => {
    const acquired = deferred<{ query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }>();
    const abort = new AbortController();
    const f = fixture();
    const pool = { ...f.pool, connect: () => acquired.promise };
    const work = boundEvolutionPool(pool as never, abort.signal).connect();
    abort.abort();
    acquired.resolve({ query: f.query, release: f.release });
    await expect(work).rejects.toMatchObject({ code: "EVOLUTION_QUERY_CANCELLED" });
    expect(f.query).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledExactlyOnceWith();
  });

  test("pool exhaustion expires before acquisition completes and any late connection is only released", async () => {
    vi.useFakeTimers();
    const acquired = deferred<{ query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }>();
    const f = fixture();
    const settled = vi.fn();
    const work = boundEvolutionPool({ ...f.pool, connect: () => acquired.promise } as never).query("UPDATE forbidden_after_timeout").then(settled, settled);
    await vi.advanceTimersByTimeAsync(EVOLUTION_CONNECTION_ACQUIRE_TIMEOUT_MS + 1);
    expect(settled.mock.calls[0]?.[0]).toMatchObject({ code: "EVOLUTION_CONNECTION_ACQUIRE_TIMEOUT" });
    expect(f.query).not.toHaveBeenCalled();
    acquired.resolve({ query: f.query, release: f.release });
    await work;
    await Promise.resolve();
    expect(f.release).toHaveBeenCalledExactlyOnceWith();
    expect(f.query).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("stop during a hung acquisition returns immediately without waiting for PostgreSQL, with no late SQL", async () => {
    vi.useFakeTimers();
    const acquired = deferred<{ query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }>();
    const f = fixture(), abort = new AbortController(), settled = vi.fn();
    const work = boundEvolutionPool({ ...f.pool, connect: () => acquired.promise } as never, abort.signal).query("UPDATE forbidden_after_stop").then(settled, settled);
    abort.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled.mock.calls[0]?.[0]).toMatchObject({ code: "EVOLUTION_QUERY_CANCELLED" });
    expect(vi.getTimerCount()).toBe(0);
    acquired.resolve({ query: f.query, release: f.release });
    await work;
    await Promise.resolve();
    expect(f.release).toHaveBeenCalledExactlyOnceWith();
    expect(f.query).not.toHaveBeenCalled();
  });
});
