import { DB_NOW_MS, fail, integer, jsonHash, requiredId, transaction, type PostgresEvolutionPool, type PostgresEvolutionQueryClient } from "./postgres-common.js";

export interface EvolutionBudgetReservation { reservationId: string; dayKey: string; tokens: number; costMicros: number }
export interface EvolutionBudgetReserveRequest {
  idempotencyKey: string;
  tokens: number;
  costMicros: number;
  limits: { tokens: number; costMicros: number };
  ttlMs?: number;
}

/** Owner-wide (not project-local) daily reservations. Uncertain work remains charged. */
export class PostgresEvolutionBudgetLedger {
  readonly #ownerKey: string;
  readonly #now: () => number;
  constructor(private readonly options: { pool: PostgresEvolutionPool; owner: { tenantId: string; userId: string }; now?: () => number }) {
    this.#ownerKey = jsonHash([requiredId(options.owner.tenantId), requiredId(options.owner.userId)]);
    this.#now = options.now ?? Date.now;
  }
  #day(day: string): string { if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fail("INVALID_BUDGET_DAY"); return day; }
  async #lock(client: PostgresEvolutionQueryClient, day: string): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`evolution-budget:${this.#ownerKey}:${this.#day(day)}`]);
  }
  async reserve(input: EvolutionBudgetReserveRequest): Promise<EvolutionBudgetReservation | undefined> {
    const tokens = integer(input.tokens), costMicros = integer(input.costMicros);
    const maxTokens = integer(input.limits.tokens), maxCost = integer(input.limits.costMicros);
    const ttl = integer(input.ttlMs ?? 3600000, 86400000);
    if (ttl < 1) fail("INVALID_BUDGET_TTL");
    const dayKey = new Date(integer(this.#now())).toISOString().slice(0, 10);
    const reservationId = jsonHash([this.#ownerKey, dayKey, requiredId(input.idempotencyKey)]);
    const hash = jsonHash({ reservationId, tokens, costMicros });
    return transaction(this.options.pool, async client => {
      await this.#lock(client, dayKey);
      const prior = (await client.query(`/* evolution:budget-get */ SELECT request_hash, status FROM mengshu_evolution_budget_reservations
WHERE owner_key = $1 AND day_key = $2 AND reservation_id = $3 FOR UPDATE`, [this.#ownerKey, dayKey, reservationId])).rows[0];
      if (prior) {
        if (prior.request_hash !== hash) fail("BUDGET_IDEMPOTENCY_CONFLICT");
        if (prior.status !== "reserved") fail("BUDGET_RESERVATION_FINISHED");
        return { reservationId, dayKey, tokens, costMicros };
      }
      const used = (await client.query(`/* evolution:budget-total */ SELECT
COALESCE(sum(CASE WHEN status = 'settled' THEN actual_tokens ELSE reserved_tokens END), 0)::text AS tokens,
COALESCE(sum(CASE WHEN status = 'settled' THEN actual_cost_micros ELSE reserved_cost_micros END), 0)::text AS cost_micros
FROM mengshu_evolution_budget_reservations WHERE owner_key = $1 AND day_key = $2 AND status <> 'released'`, [this.#ownerKey, dayKey])).rows[0];
      if (!used) fail("BUDGET_STATE_UNAVAILABLE");
      if (BigInt(String(used.tokens)) + BigInt(tokens) > BigInt(maxTokens) || BigInt(String(used.cost_micros)) + BigInt(costMicros) > BigInt(maxCost)) return undefined;
      const inserted = await client.query(`/* evolution:budget-insert */ INSERT INTO mengshu_evolution_budget_reservations
(owner_key, day_key, reservation_id, request_hash, reserved_tokens, reserved_cost_micros, status, created_at, expires_at)
SELECT $1,$2,$3,$4,$5,$6,'reserved',${DB_NOW_MS},${DB_NOW_MS} + $7
WHERE $2 = to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD') RETURNING reservation_id`,
      [this.#ownerKey, dayKey, reservationId, hash, tokens, costMicros, ttl]);
      if (inserted.rows[0]?.reservation_id !== reservationId) fail("BUDGET_DAY_CHANGED");
      return { reservationId, dayKey, tokens, costMicros };
    });
  }
  async settle(input: { reservationId: string; dayKey: string; tokens: number; costMicros: number }): Promise<void> {
    integer(input.tokens); integer(input.costMicros); requiredId(input.reservationId); this.#day(input.dayKey);
    await transaction(this.options.pool, async client => {
      await this.#lock(client, input.dayKey);
      const result = await client.query(`/* evolution:budget-settle */ UPDATE mengshu_evolution_budget_reservations
SET status = 'settled', actual_tokens = $4, actual_cost_micros = $5
WHERE owner_key = $1 AND day_key = $2 AND reservation_id = $3
AND (status = 'reserved' OR status = 'settled' AND actual_tokens = $4 AND actual_cost_micros = $5) RETURNING reservation_id`,
      [this.#ownerKey, input.dayKey, input.reservationId, input.tokens, input.costMicros]);
      if (result.rows[0]?.reservation_id !== input.reservationId) fail("BUDGET_SETTLEMENT_CONFLICT");
    });
  }
  /** Host calls only when it knows no work began. Expiry alone never releases uncertain work. */
  async release(input: { reservationId: string; dayKey: string }): Promise<void> {
    requiredId(input.reservationId); this.#day(input.dayKey);
    await transaction(this.options.pool, async client => {
      await this.#lock(client, input.dayKey);
      const result = await client.query(`/* evolution:budget-release */ UPDATE mengshu_evolution_budget_reservations SET status = 'released'
WHERE owner_key = $1 AND day_key = $2 AND reservation_id = $3 AND status IN ('reserved','released') RETURNING reservation_id`, [this.#ownerKey, input.dayKey, input.reservationId]);
      if (result.rows[0]?.reservation_id !== input.reservationId) fail("BUDGET_RELEASE_CONFLICT");
    });
  }
  async storageUsage(): Promise<{ databaseBytes: number; evolutionBytes: number }> {
    const row = (await this.options.pool.query(`/* evolution:storage-usage */ SELECT pg_database_size(current_database())::text AS database_bytes,
(SELECT COALESCE(sum(pg_total_relation_size(c.oid)),0)::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = current_schema() AND c.relkind = 'r' AND c.relname IN (
'mengshu_evolution_batches','mengshu_evolution_apply_receipts','mengshu_evolution_processed_inputs',
'mengshu_evolution_reviews','mengshu_evolution_source_dispositions','mengshu_evolution_operation_receipts','mengshu_evolution_budget_reservations',
'mengshu_evolution_host_state','mengshu_evolution_host_receipts')) AS evolution_bytes`)).rows[0];
    if (!row) fail("STORAGE_USAGE_UNAVAILABLE");
    return { databaseBytes: integer(Number(row.database_bytes)), evolutionBytes: integer(Number(row.evolution_bytes)) };
  }
}
