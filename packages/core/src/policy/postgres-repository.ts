import type { MemoryPolicyOverlayRepository } from "./repository.js";
import type {
  MemoryPolicyLayer,
  MemoryPolicyMutationResult,
  MemoryPolicyOverlayReceipt,
  MemoryPolicyOverlayVersion,
} from "./types.js";

interface QueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  readonly rows: Row[];
  readonly rowCount?: number | null;
}
export interface PostgresMemoryPolicyClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  release?(): void;
}

export interface PostgresMemoryPolicyPool extends PostgresMemoryPolicyClient {
  connect(): Promise<PostgresMemoryPolicyClient>;
}

function overlay(value: unknown): MemoryPolicyOverlayVersion {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("POLICY_INVALID_ROW");
  const result = value as MemoryPolicyOverlayVersion;
  if (typeof result.id !== "string" || !Number.isSafeInteger(result.version) ||
      typeof result.contentHash !== "string" || !Array.isArray(result.focusHints)) {
    throw new Error("POLICY_INVALID_ROW");
  }
  return structuredClone(result);
}

function receipt(value: unknown): MemoryPolicyOverlayReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("POLICY_INVALID_ROW");
  const result = value as MemoryPolicyOverlayReceipt;
  if (typeof result.id !== "string" || typeof result.scopeFingerprint !== "string" ||
      typeof result.requestHash !== "string" || !Number.isSafeInteger(result.version)) {
    throw new Error("POLICY_INVALID_ROW");
  }
  return structuredClone(result);
}

export class PostgresMemoryPolicyOverlayRepository implements MemoryPolicyOverlayRepository {
  constructor(readonly pool: PostgresMemoryPolicyPool) {}

  async getLatest(scopeFingerprint: string, overlayId: string): Promise<MemoryPolicyOverlayVersion | undefined> {
    const result = await this.pool.query<{ overlay: unknown }>(
      `/* policy-overlay:get-latest */
SELECT versions.overlay
FROM mengshu_memory_policy_overlay_heads heads
JOIN mengshu_memory_policy_overlay_versions versions
  ON versions.scope_fingerprint = heads.scope_fingerprint
 AND versions.overlay_id = heads.overlay_id AND versions.version = heads.latest_version
WHERE heads.scope_fingerprint = $1 AND heads.overlay_id = $2`,
      [scopeFingerprint, overlayId],
    );
    return result.rows[0] === undefined ? undefined : overlay(result.rows[0].overlay);
  }

  async getVersion(
    scopeFingerprint: string,
    overlayId: string,
    version: number,
  ): Promise<MemoryPolicyOverlayVersion | undefined> {
    const result = await this.pool.query<{ overlay: unknown }>(
      `/* policy-overlay:get-version */
SELECT overlay FROM mengshu_memory_policy_overlay_versions
WHERE scope_fingerprint = $1 AND overlay_id = $2 AND version = $3`,
      [scopeFingerprint, overlayId, version],
    );
    return result.rows[0] === undefined ? undefined : overlay(result.rows[0].overlay);
  }

  async listActive(
    scopeFingerprint: string,
    layer: MemoryPolicyLayer,
  ): Promise<readonly MemoryPolicyOverlayVersion[]> {
    const result = await this.pool.query<{ overlay: unknown }>(
      `/* policy-overlay:list-active */
SELECT versions.overlay
FROM mengshu_memory_policy_overlay_heads heads
JOIN mengshu_memory_policy_overlay_versions versions
  ON versions.scope_fingerprint = heads.scope_fingerprint
 AND versions.overlay_id = heads.overlay_id AND versions.version = heads.latest_version
WHERE heads.scope_fingerprint = $1 AND versions.layer = $2 AND versions.status = 'active'
ORDER BY versions.overlay_id`,
      [scopeFingerprint, layer],
    );
    return result.rows.map((row) => overlay(row.overlay));
  }

  async getReceipt(
    scopeFingerprint: string,
    idempotencyKey: string,
  ): Promise<MemoryPolicyOverlayReceipt | undefined> {
    const result = await this.pool.query<{ receipt: unknown }>(
      `/* policy-overlay:get-receipt */
SELECT receipt FROM mengshu_memory_policy_overlay_receipts
WHERE scope_fingerprint = $1 AND idempotency_key = $2`,
      [scopeFingerprint, idempotencyKey],
    );
    return result.rows[0] === undefined ? undefined : receipt(result.rows[0].receipt);
  }

  async appendVersion(input: {
    readonly scopeFingerprint: string;
    readonly overlay: MemoryPolicyOverlayVersion;
    readonly receipt: MemoryPolicyOverlayReceipt;
    readonly expectedLatestVersion: number;
  }): Promise<MemoryPolicyMutationResult> {
    const replay = await this.getReceipt(input.scopeFingerprint, input.receipt.idempotencyKey);
    if (replay !== undefined) {
      if (replay.requestHash !== input.receipt.requestHash) throw new Error("POLICY_IDEMPOTENCY_CONFLICT");
      const existing = await this.getVersion(input.scopeFingerprint, replay.overlayId, replay.version);
      if (existing === undefined) throw new Error("POLICY_OVERLAY_NOT_FOUND");
      return { overlay: existing, receipt: replay, replayed: true };
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `memory-policy:${input.scopeFingerprint}:${input.overlay.id}`,
      ]);
      const head = await client.query<{ latest_version: number }>(
        `/* policy-overlay:lock-head */
SELECT latest_version FROM mengshu_memory_policy_overlay_heads
WHERE scope_fingerprint = $1 AND overlay_id = $2 FOR UPDATE`,
        [input.scopeFingerprint, input.overlay.id],
      );
      const latest = head.rows[0] === undefined ? 0 : Number(head.rows[0].latest_version);
      if (latest !== input.expectedLatestVersion || input.overlay.version !== latest + 1) {
        throw new Error("POLICY_VERSION_STALE");
      }
      const value = input.overlay;
      const inserted = await client.query(
        `/* policy-overlay:insert-version */
INSERT INTO mengshu_memory_policy_overlay_versions (
  scope_fingerprint, overlay_id, version, owner_user_id, tenant_id, user_id,
  app_id, project_id, agent_id, namespace, visibility,
  target_app_id, target_project_id, target_agent_id, layer, status,
  content_hash, guard_version, overlay, created_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
  $12, $13, $14, $15, $16, $17, 'memory-policy-guard-v1', $18::jsonb, $19)
RETURNING version`,
        [input.scopeFingerprint, value.id, value.version, value.ownerUserId,
          value.scope.tenantId, value.scope.userId, value.scope.appId, value.scope.projectId,
          value.scope.agentId, value.scope.namespace, value.scope.visibility,
          value.target.appId ?? null, value.target.projectId ?? null, value.target.agentId ?? null,
          value.layer, value.status, value.contentHash, JSON.stringify(value),
          Date.parse(value.createdAt)],
      );
      if (inserted.rowCount !== 1) throw new Error("POLICY_DATABASE_FAILED");
      const advanced = await client.query(
        `/* policy-overlay:advance-head */
INSERT INTO mengshu_memory_policy_overlay_heads (
  scope_fingerprint, overlay_id, latest_version, updated_at
) VALUES ($1, $2, $3, $4)
ON CONFLICT (scope_fingerprint, overlay_id) DO UPDATE SET
  latest_version = EXCLUDED.latest_version, updated_at = EXCLUDED.updated_at
WHERE mengshu_memory_policy_overlay_heads.latest_version = $5
RETURNING latest_version`,
        [input.scopeFingerprint, value.id, value.version, Date.parse(value.createdAt),
          input.expectedLatestVersion],
      );
      if (advanced.rowCount !== 1) throw new Error("POLICY_VERSION_STALE");
      const insertedReceipt = await client.query(
        `/* policy-overlay:insert-receipt */
INSERT INTO mengshu_memory_policy_overlay_receipts (
  receipt_id, scope_fingerprint, idempotency_key, request_hash,
  overlay_id, version, receipt, occurred_at
) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
RETURNING receipt_id`,
        [input.receipt.id, input.scopeFingerprint, input.receipt.idempotencyKey,
          input.receipt.requestHash, input.receipt.overlayId, input.receipt.version,
          JSON.stringify(input.receipt), Date.parse(input.receipt.occurredAt)],
      );
      if (insertedReceipt.rowCount !== 1) throw new Error("POLICY_DATABASE_FAILED");
      await client.query("COMMIT");
      return {
        overlay: structuredClone(input.overlay),
        receipt: structuredClone(input.receipt),
        replayed: false,
      };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve primary error */ }
      throw error;
    } finally {
      client.release?.();
    }
  }
}
