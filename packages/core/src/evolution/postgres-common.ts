import { createHash } from "node:crypto";
import { authorityScopeFingerprint, canonicalAuthorityScope } from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../domain/types.js";
import type { EvolutionLease } from "./types.js";

export interface PostgresEvolutionQueryClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string, params?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount?: number | null }>;
}
export interface PostgresEvolutionClient extends PostgresEvolutionQueryClient { release(): void }
export interface PostgresEvolutionPool extends PostgresEvolutionQueryClient { connect(): Promise<PostgresEvolutionClient> }
export const POSTGRES_EVOLUTION_SCHEMA_VERSION = 36;
export const POSTGRES_EVOLUTION_GOVERNANCE_SCHEMA_VERSION = 37;
export const DB_NOW_MS = "floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint";
export const SHA256 = /^[a-f0-9]{64}$/;
export const POSTGRES_EVOLUTION_TRANSACTION_LIMITS_SQL = `SELECT
set_config('lock_timeout', '250ms', true),
set_config('statement_timeout', '5000ms', true),
set_config('idle_in_transaction_session_timeout', '5000ms', true)`;

export class PostgresEvolutionError extends Error {
  constructor(readonly code: string) { super(code); this.name = "PostgresEvolutionError"; }
}
export function fail(code: string): never { throw new PostgresEvolutionError(code); }
export function requiredId(value: unknown): string {
  if (typeof value !== "string" || !/^[^\s\p{Cc}]{1,256}$/u.test(value)) fail("INVALID_ID");
  return value;
}
export function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) fail("INVALID_INTEGER");
  return value;
}
export function checkedHash(value: string): string { if (!SHA256.test(value)) fail("INVALID_HASH"); return value; }
export function scopedFingerprint(scope: MemoryScope): string {
  return authorityScopeFingerprint({ ...scope, visibility: scope.visibility ?? "private" });
}
export function scopeParams(scope: MemoryScope): string[] {
  const s = canonicalAuthorityScope({ ...scope, visibility: scope.visibility ?? "private" });
  return [s.tenantId, s.userId, s.appId, s.projectId, s.agentId, s.namespace, s.visibility, s.workspaceId, s.sessionId];
}
export function boundedJson<T>(value: T, maxBytes = 196608): T {
  const json = JSON.stringify(value);
  if (typeof json !== "string" || Buffer.byteLength(json) > maxBytes) fail("PAYLOAD_LIMIT");
  return JSON.parse(json) as T;
}
export function jsonHash(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sort(v)]));
    return item;
  };
  return createHash("sha256").update(JSON.stringify(sort(boundedJson(value)))).digest("hex");
}
export async function transaction<T>(pool: PostgresEvolutionPool, work: (client: PostgresEvolutionClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let begun = false;
  let committed = false;
  try {
    await client.query("BEGIN");
    begun = true;
    await client.query(POSTGRES_EVOLUTION_TRANSACTION_LIMITS_SQL);
    const result = await work(client);
    await client.query("COMMIT");
    committed = true;
    return result;
  } catch (error) {
    if (begun && !committed) {
      try { await client.query("ROLLBACK"); } catch { fail("ROLLBACK_FAILED"); }
    }
    if (error instanceof PostgresEvolutionError) throw error;
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "55P03" || code === "40P01") fail("LOCK_BUSY");
    if (code === "57014") fail("QUERY_TIMEOUT");
    return fail("TRANSACTION_FAILED");
  } finally {
    try { client.release(); } catch { if (committed) fail("COMMITTED_CLEANUP_FAILED"); }
  }
}
export async function lockLease(client: PostgresEvolutionQueryClient, lease: EvolutionLease, scopeFingerprint: string, batchId: string): Promise<void> {
  if (lease.scopeFingerprint !== scopeFingerprint || lease.batchId !== batchId) fail("SCOPE_MISMATCH");
  requiredId(lease.ownerId);
  integer(lease.fencingToken);
  const result = await client.query(
    `/* evolution:lease-lock */ SELECT id FROM mengshu_evolution_batches
WHERE scope_fingerprint = $1 AND id = $2 AND lease_owner = $3 AND fencing_token = $4
  AND lease_expires_at > ${DB_NOW_MS} AND NOT (body ? 'cancelRequestedAt') FOR UPDATE`,
    [scopeFingerprint, requiredId(batchId), lease.ownerId, lease.fencingToken],
  );
  if (result.rows.length !== 1 || result.rows[0]?.id !== batchId) fail("STALE_LEASE");
}
