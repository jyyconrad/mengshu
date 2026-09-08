import { fail, type PostgresEvolutionPool, type PostgresEvolutionQueryClient } from "../../evolution/postgres-common.js";

/** One control segment shares its SQL allowance, including rollback-safe affected-row checks. */
export function budgetEvolutionControlPool(pool: PostgresEvolutionPool, limits: { maxRecords: number; maxBytes: number }): PostgresEvolutionPool {
  if (![limits.maxRecords, limits.maxBytes].every(value => Number.isSafeInteger(value) && value > 0)) fail("CONTROL_BUDGET_INVALID");
  let records = 0, bytes = 0;
  const wrap = (client: PostgresEvolutionQueryClient): PostgresEvolutionQueryClient["query"] => async <Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) => {
    // Transaction controls must remain usable after exhaustion so the owner can release locks.
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config('lock_timeout'")) return client.query<Row>(sql, params);
    bytes += Buffer.byteLength(JSON.stringify(params));
    if (records >= limits.maxRecords) fail("CONTROL_MAX_RECORDS");
    if (bytes > limits.maxBytes) fail("CONTROL_MAX_BYTES");
    const result = await client.query<Row>(sql, params);
    const count = result.rowCount ?? result.rows.length;
    if (!Number.isSafeInteger(count) || count < result.rows.length || count < 0) fail("CONTROL_IO_ACCOUNTING_INVALID");
    records += count; bytes += Buffer.byteLength(JSON.stringify(result.rows));
    if (records > limits.maxRecords) fail("CONTROL_MAX_RECORDS");
    if (bytes > limits.maxBytes) fail("CONTROL_MAX_BYTES");
    return result;
  };
  return { query: wrap(pool), connect: async () => {
    const client = await pool.connect();
    return { query: wrap(client), release: client.release.bind(client) };
  } };
}
