import {
  POSTGRES_EVOLUTION_TRANSACTION_LIMITS_SQL,
  type PostgresEvolutionClient,
  type PostgresEvolutionPool,
} from "../../evolution/postgres-common.js";

export const EVOLUTION_TRANSACTION_TIMEOUT_MS = 5_000;
export const EVOLUTION_CONNECTION_ACQUIRE_TIMEOUT_MS = 1_000;
const LOCK_TIMEOUT_MS = 250;

export class EvolutionQueryBoundaryError extends Error {
  readonly retryable = true;
  constructor(readonly code: string) { super(code); this.name = "EvolutionQueryBoundaryError"; }
}

function transactionLimits(remainingMs: number): string {
  return `SELECT
set_config('lock_timeout', '${Math.min(LOCK_TIMEOUT_MS, remainingMs)}ms', true),
set_config('statement_timeout', '${remainingMs}ms', true),
set_config('idle_in_transaction_session_timeout', '${remainingMs}ms', true)`;
}

function acquire(pool: PostgresEvolutionPool, signal?: AbortSignal): Promise<PostgresEvolutionClient> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", aborted); };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const aborted = () => fail(new EvolutionQueryBoundaryError("EVOLUTION_QUERY_CANCELLED"));
    const timer = setTimeout(() => fail(new EvolutionQueryBoundaryError("EVOLUTION_CONNECTION_ACQUIRE_TIMEOUT")), EVOLUTION_CONNECTION_ACQUIRE_TIMEOUT_MS);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) { aborted(); return; }
    try {
      void pool.connect().then(client => {
        if (settled) {
          // Acquisition owns no SQL. A timed-out caller may only return this late connection.
          try { client.release(); } catch { /* The driver may already have discarded a closed pool's client. */ }
          return;
        }
        settled = true;
        cleanup();
        resolve(client);
      }, fail);
    } catch (error) { fail(error); }
  });
}

/** Only evolution borrows this boundary. Native pg release(error) discards a broken connection. */
export function boundEvolutionPool(pool: PostgresEvolutionPool, signal?: AbortSignal): PostgresEvolutionPool {
  const cancelled = () => {
    if (signal?.aborted) throw new EvolutionQueryBoundaryError("EVOLUTION_QUERY_CANCELLED");
  };
  const connect = async (): Promise<PostgresEvolutionClient> => {
    cancelled();
    const client = await acquire(pool, signal);
    const releaseClient: (error?: Error) => void = client.release.bind(client);
    let active = false;
    let released = false;
    let deadline = 0;
    const release = (error?: Error) => {
      if (released) return;
      released = true;
      if (error) releaseClient(error);
      else releaseClient();
    };
    const rollback = async () => {
      if (!active) return;
      try {
        await client.query("ROLLBACK", []);
        active = false;
      } catch {
        active = false;
        const error = new EvolutionQueryBoundaryError("EVOLUTION_QUERY_ROLLBACK_FAILED");
        release(error);
        throw error;
      }
    };
    try { cancelled(); } catch (error) { release(); throw error; }
    return {
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) => {
        if (released) throw new EvolutionQueryBoundaryError("EVOLUTION_QUERY_CLIENT_RELEASED");
        if (sql === "ROLLBACK") { await rollback(); return { rows: [] as Row[], rowCount: 0 }; }
        try {
          cancelled();
          if (sql === "BEGIN") {
            if (active) throw new EvolutionQueryBoundaryError("EVOLUTION_TRANSACTION_ALREADY_ACTIVE");
            const result = await client.query<Row>(sql, params);
            active = true;
            deadline = performance.now() + EVOLUTION_TRANSACTION_TIMEOUT_MS;
            await client.query(POSTGRES_EVOLUTION_TRANSACTION_LIMITS_SQL, []);
            cancelled();
            return result;
          }
          if (!active) throw new EvolutionQueryBoundaryError("EVOLUTION_TRANSACTION_REQUIRED");
          const remainingMs = Math.ceil(deadline - performance.now());
          if (remainingMs <= 0) throw new EvolutionQueryBoundaryError("EVOLUTION_TRANSACTION_TIMEOUT");
          // Repeated repository setup cannot restart the transaction's finite budget.
          const limits = await client.query<Row>(transactionLimits(remainingMs), []);
          cancelled();
          if (sql === POSTGRES_EVOLUTION_TRANSACTION_LIMITS_SQL) return limits;
          const result = await client.query<Row>(sql, params);
          if (sql === "COMMIT") active = false;
          else cancelled();
          return result;
        } catch (error) {
          // Await PostgreSQL's bounded execution and rollback before releasing any held locks.
          await rollback();
          throw error;
        }
      },
      release: () => release(active ? new EvolutionQueryBoundaryError("EVOLUTION_TRANSACTION_ABANDONED") : undefined),
    };
  };
  return Object.freeze({
    connect,
    query: async <Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) => {
      const client = await connect();
      try {
        await client.query("BEGIN");
        const result = await client.query<Row>(sql, params);
        await client.query("COMMIT");
        return result;
      } finally { client.release(); }
    },
  });
}
