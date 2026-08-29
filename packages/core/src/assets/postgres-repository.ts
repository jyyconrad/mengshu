import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../domain/types.js";
import { MemoryViewAssetError } from "./content-ref.js";
import {
  validatePersistedMemoryViewAssetDescriptor,
  validatePersistedMemoryViewPromotionReceipt,
} from "./memory-view-service.js";
import type {
  AppendMemoryViewAssetVersionInput,
  MemoryViewAssetRepository,
} from "./repository.js";
import type {
  MemoryViewAssetDescriptor,
  MemoryViewPromotionReceipt,
} from "./types.js";

interface QueryResultLike {
  readonly rows?: readonly Record<string, unknown>[];
  readonly rowCount?: number | null;
}

export interface PostgresMemoryViewAssetQueryClient {
  query(sql: string, params?: readonly unknown[]): Promise<QueryResultLike>;
}

export interface PostgresMemoryViewAssetTransactionClient
  extends PostgresMemoryViewAssetQueryClient {
  release(): void;
}

export interface PostgresMemoryViewAssetPool extends PostgresMemoryViewAssetQueryClient {
  connect(): Promise<PostgresMemoryViewAssetTransactionClient>;
}

function privateScopeFingerprint(scope: MemoryScope): string {
  const normalized = scope.visibility === undefined
    ? { ...scope, visibility: "private" as const }
    : scope;
  if (normalized.visibility !== "private") {
    throw new MemoryViewAssetError("PRIVATE_SCOPE_REQUIRED");
  }
  try {
    return authorityScopeFingerprint(normalized);
  } catch {
    throw new MemoryViewAssetError("INVALID_INPUT", "scope is invalid");
  }
}

function first(result: QueryResultLike): Record<string, unknown> | undefined {
  return result.rows?.[0];
}

function assertDescriptor(
  value: unknown,
  scopeFingerprint: string,
  assetId?: string,
  version?: number,
): MemoryViewAssetDescriptor {
  const descriptor = validatePersistedMemoryViewAssetDescriptor(value);
  if (authorityScopeFingerprint(descriptor.sourceScope) !== scopeFingerprint) {
    throw new MemoryViewAssetError("SOURCE_SCOPE_MISMATCH");
  }
  if ((assetId !== undefined && descriptor.id !== assetId) ||
      (version !== undefined && descriptor.version !== version)) {
    throw new MemoryViewAssetError("INVALID_INPUT", "descriptor identity mismatch");
  }
  return descriptor;
}

function assertDescriptorRow(
  row: Record<string, unknown>,
  scopeFingerprint: string,
  assetId?: string,
  version?: number,
  requireHead = false,
): MemoryViewAssetDescriptor {
  const descriptor = assertDescriptor(row.descriptor, scopeFingerprint, assetId, version);
  const persistedVersion = Number(row.version);
  const headVersion = Number(row.latest_version);
  if (row.scope_fingerprint !== scopeFingerprint || row.asset_id !== descriptor.id ||
      !Number.isSafeInteger(persistedVersion) || persistedVersion !== descriptor.version ||
      row.kind !== descriptor.kind || row.status !== descriptor.status ||
      row.visibility !== descriptor.visibility || row.owner_user_id !== descriptor.owner.subjectId ||
      (requireHead && (!Number.isSafeInteger(headVersion) || headVersion !== persistedVersion))) {
    throw new MemoryViewAssetError("INVALID_INPUT", "descriptor relational columns mismatch");
  }
  return descriptor;
}

function assertReceipt(
  value: unknown,
  scopeFingerprint: string,
): MemoryViewPromotionReceipt {
  const receipt = validatePersistedMemoryViewPromotionReceipt(value);
  if (receipt.scopeFingerprint !== scopeFingerprint) {
    throw new MemoryViewAssetError("SOURCE_SCOPE_MISMATCH");
  }
  return receipt;
}

function assertReceiptRow(
  row: Record<string, unknown>,
  scopeFingerprint: string,
  requestKey?: string,
): MemoryViewPromotionReceipt {
  const receipt = assertReceipt(row.receipt, scopeFingerprint);
  if (row.receipt_id !== receipt.id || row.scope_fingerprint !== scopeFingerprint ||
      row.request_key !== receipt.requestKey || row.request_hash !== receipt.requestHash ||
      row.asset_id !== receipt.assetId || Number(row.asset_version) !== receipt.assetVersion ||
      (requestKey !== undefined && receipt.requestKey !== requestKey)) {
    throw new MemoryViewAssetError("INVALID_INPUT", "receipt relational columns mismatch");
  }
  return receipt;
}

function assertReturned(
  result: QueryResultLike,
  field: string,
  expected?: unknown,
): Record<string, unknown> {
  const row = first(result);
  if (result.rowCount !== 1 || result.rows?.length !== 1 || !row ||
      !Object.hasOwn(row, field) || row[field] === null || row[field] === undefined ||
      (expected !== undefined && row[field] !== expected)) {
    throw new MemoryViewAssetError("INVALID_INPUT", `database write did not return ${field}`);
  }
  return row;
}

function sameIdempotentAsset(
  left: MemoryViewAssetDescriptor,
  right: MemoryViewAssetDescriptor,
): boolean {
  const { createdAt: _leftCreatedAt, updatedAt: _leftUpdatedAt, ...leftStable } = left;
  const { createdAt: _rightCreatedAt, updatedAt: _rightUpdatedAt, ...rightStable } = right;
  return isDeepStrictEqual(leftStable, rightStable);
}

function sameIdempotentReceipt(
  left: MemoryViewPromotionReceipt,
  right: MemoryViewPromotionReceipt,
): boolean {
  const { id: _leftId, createdAt: _leftCreatedAt, ...leftStable } = left;
  const { id: _rightId, createdAt: _rightCreatedAt, ...rightStable } = right;
  return isDeepStrictEqual(leftStable, rightStable);
}

export class PostgresMemoryViewAssetRepository implements MemoryViewAssetRepository {
  readonly idFactory: () => string;
  readonly now: () => number;

  constructor(
    private readonly pool: PostgresMemoryViewAssetPool,
    options: { readonly idFactory?: () => string; readonly now?: () => number } = {},
  ) {
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? Date.now;
  }

  async listLatest(scope: MemoryScope): Promise<readonly MemoryViewAssetDescriptor[]> {
    const fingerprint = privateScopeFingerprint(scope);
    const result = await this.pool.query(
      `/* asset-repository:list-latest */
SELECT heads.scope_fingerprint, heads.asset_id, heads.latest_version,
       versions.version, versions.kind, versions.status, versions.visibility,
       versions.owner_user_id, versions.descriptor
FROM mengshu_asset_heads AS heads
JOIN mengshu_asset_versions AS versions
  ON versions.scope_fingerprint = heads.scope_fingerprint
 AND versions.asset_id = heads.asset_id
 AND versions.version = heads.latest_version
WHERE heads.scope_fingerprint = $1 AND versions.kind = 'memory_view'
ORDER BY heads.asset_id`,
      [fingerprint],
    );
    return Object.freeze((result.rows ?? []).map((row) =>
      assertDescriptorRow(row, fingerprint, undefined, undefined, true)));
  }

  async getLatest(
    scope: MemoryScope,
    assetId: string,
  ): Promise<MemoryViewAssetDescriptor | undefined> {
    const fingerprint = privateScopeFingerprint(scope);
    const result = await this.pool.query(
      `/* asset-repository:get-latest */
SELECT heads.scope_fingerprint, heads.asset_id, heads.latest_version,
       versions.version, versions.kind, versions.status, versions.visibility,
       versions.owner_user_id, versions.descriptor
FROM mengshu_asset_heads AS heads
JOIN mengshu_asset_versions AS versions
  ON versions.scope_fingerprint = heads.scope_fingerprint
 AND versions.asset_id = heads.asset_id
 AND versions.version = heads.latest_version
WHERE heads.scope_fingerprint = $1 AND heads.asset_id = $2
  AND versions.kind = 'memory_view'`,
      [fingerprint, assetId],
    );
    const row = first(result);
    return row ? assertDescriptorRow(row, fingerprint, assetId, undefined, true) : undefined;
  }

  async getVersion(
    scope: MemoryScope,
    assetId: string,
    version: number,
  ): Promise<MemoryViewAssetDescriptor | undefined> {
    const fingerprint = privateScopeFingerprint(scope);
    const result = await this.pool.query(
      `/* asset-repository:get-version */
SELECT scope_fingerprint, asset_id, version, kind, status, visibility,
       owner_user_id, descriptor
FROM mengshu_asset_versions
WHERE scope_fingerprint = $1 AND asset_id = $2 AND version = $3
  AND kind = 'memory_view'`,
      [fingerprint, assetId, version],
    );
    const row = first(result);
    return row ? assertDescriptorRow(row, fingerprint, assetId, version) : undefined;
  }

  async getReceipt(
    scope: MemoryScope,
    requestKey: string,
  ): Promise<MemoryViewPromotionReceipt | undefined> {
    const fingerprint = privateScopeFingerprint(scope);
    const result = await this.pool.query(
      `/* asset-repository:get-receipt */
SELECT receipt_id, scope_fingerprint, request_key, request_hash,
       asset_id, asset_version, receipt
FROM mengshu_asset_promotion_receipts
WHERE scope_fingerprint = $1 AND request_key = $2`,
      [fingerprint, requestKey],
    );
    const row = first(result);
    return row ? assertReceiptRow(row, fingerprint, requestKey) : undefined;
  }

  async appendVersion(input: AppendMemoryViewAssetVersionInput) {
    const asset = validatePersistedMemoryViewAssetDescriptor(input.asset);
    const receipt = validatePersistedMemoryViewPromotionReceipt(input.receipt);
    const fingerprint = privateScopeFingerprint(asset.sourceScope);
    if (!Number.isSafeInteger(input.expectedLatestVersion) || input.expectedLatestVersion < 0 ||
        asset.version !== input.expectedLatestVersion + 1 ||
        receipt.scopeFingerprint !== fingerprint || receipt.assetId !== asset.id ||
        receipt.assetVersion !== asset.version || receipt.targetStatus !== asset.status) {
      throw new MemoryViewAssetError("VERSION_CONFLICT");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const receiptLock = await client.query(
        `/* asset-repository:receipt-lock */
WITH locked AS (
  SELECT pg_advisory_xact_lock(hashtext($1))
)
SELECT receipts.receipt_id, receipts.scope_fingerprint, receipts.request_key,
       receipts.request_hash, receipts.asset_id, receipts.asset_version, receipts.receipt,
       versions.descriptor, versions.kind AS version_kind, versions.status AS version_status,
       versions.visibility AS version_visibility, versions.owner_user_id AS version_owner_user_id
FROM locked
LEFT JOIN mengshu_asset_promotion_receipts AS receipts
  ON receipts.scope_fingerprint = $2 AND receipts.request_key = $3
LEFT JOIN mengshu_asset_versions AS versions
  ON versions.scope_fingerprint = receipts.scope_fingerprint
 AND versions.asset_id = receipts.asset_id
 AND versions.version = receipts.asset_version`,
        [`asset-receipt:${fingerprint}:${receipt.requestKey}`, fingerprint, receipt.requestKey],
      );
      const existingValue = first(receiptLock)?.receipt;
      if (existingValue !== undefined && existingValue !== null) {
        const existing = assertReceiptRow(first(receiptLock)!, fingerprint, receipt.requestKey);
        const persistedDescriptor = assertDescriptorRow({
          scope_fingerprint: first(receiptLock)!.scope_fingerprint,
          asset_id: first(receiptLock)!.asset_id,
          version: first(receiptLock)!.asset_version,
          kind: first(receiptLock)!.version_kind,
          status: first(receiptLock)!.version_status,
          visibility: first(receiptLock)!.version_visibility,
          owner_user_id: first(receiptLock)!.version_owner_user_id,
          descriptor: first(receiptLock)!.descriptor,
        }, fingerprint, existing.assetId, existing.assetVersion);
        if (existing.requestHash !== receipt.requestHash || existing.assetId !== receipt.assetId ||
            existing.assetVersion !== receipt.assetVersion ||
            !sameIdempotentReceipt(existing, receipt) ||
            !sameIdempotentAsset(persistedDescriptor, asset)) {
          throw new MemoryViewAssetError("IDEMPOTENCY_CONFLICT");
        }
        await client.query("COMMIT");
        return { asset: persistedDescriptor, receipt: existing, replayed: true };
      }

      const headLock = await client.query(
        `/* asset-repository:head-lock */
WITH locked AS (
  SELECT pg_advisory_xact_lock(hashtext($1))
)
SELECT heads.latest_version
FROM locked
LEFT JOIN mengshu_asset_heads AS heads
  ON heads.scope_fingerprint = $2 AND heads.asset_id = $3
FOR UPDATE OF heads`,
        [`asset-head:${fingerprint}:${asset.id}`, fingerprint, asset.id],
      );
      const latestValue = first(headLock)?.latest_version;
      const latest = latestValue === undefined || latestValue === null ? 0 : Number(latestValue);
      if (!Number.isSafeInteger(latest) || latest !== input.expectedLatestVersion) {
        throw new MemoryViewAssetError("VERSION_CONFLICT");
      }
      const occurredAt = Date.parse(asset.updatedAt);
      const insertedVersion = await client.query(
        `/* asset-repository:insert-version */
INSERT INTO mengshu_asset_versions (
  scope_fingerprint, asset_id, version, kind, status, visibility,
  owner_user_id, descriptor, created_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
RETURNING version`,
        [fingerprint, asset.id, asset.version, asset.kind, asset.status, asset.visibility,
          asset.owner.subjectId, JSON.stringify(asset), Date.parse(asset.createdAt)],
      );
      assertReturned(insertedVersion, "version", asset.version);
      const head = await client.query(
        `/* asset-repository:upsert-head */
INSERT INTO mengshu_asset_heads (scope_fingerprint, asset_id, latest_version, changed_at)
VALUES ($1, $2, $3, $4)
ON CONFLICT (scope_fingerprint, asset_id) DO UPDATE
SET latest_version = EXCLUDED.latest_version, changed_at = EXCLUDED.changed_at
WHERE mengshu_asset_heads.latest_version = $5
RETURNING latest_version`,
        [fingerprint, asset.id, asset.version, occurredAt, input.expectedLatestVersion],
      );
      if (head.rowCount === 0) throw new MemoryViewAssetError("VERSION_CONFLICT");
      assertReturned(head, "latest_version", asset.version);
      const insertedReceipt = await client.query(
        `/* asset-repository:insert-receipt */
INSERT INTO mengshu_asset_promotion_receipts (
  receipt_id, scope_fingerprint, request_key, request_hash,
  asset_id, asset_version, receipt, created_at
) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
RETURNING receipt_id`,
        [receipt.id, fingerprint, receipt.requestKey, receipt.requestHash, asset.id,
          asset.version, JSON.stringify(receipt), Date.parse(receipt.createdAt)],
      );
      assertReturned(insertedReceipt, "receipt_id", receipt.id);
      const statusChanged = receipt.decisions.length === 0;
      const insertedAudit = await client.query(
        `/* asset-repository:insert-audit */
INSERT INTO mengshu_asset_audit (
  scope_fingerprint, asset_id, asset_version, event_type, receipt_id, occurred_at
) VALUES ($1, $2, $3, $4, $5, $6)
RETURNING audit_id`,
        [fingerprint, asset.id, asset.version,
          statusChanged ? "status_changed" : "version_created", receipt.id, occurredAt],
      );
      assertReturned(insertedAudit, "audit_id");
      const eventId = createHash("sha256")
        .update(JSON.stringify(["mengshu.asset-outbox/v1", fingerprint, receipt.id]))
        .digest("hex");
      const insertedOutbox = await client.query(
        `/* asset-repository:insert-outbox */
INSERT INTO mengshu_asset_outbox (
  event_id, scope_fingerprint, asset_id, asset_version,
  event_type, payload, occurred_at
) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
RETURNING event_id`,
        [eventId, fingerprint, asset.id, asset.version,
          statusChanged ? "asset.status.changed" : "asset.version.created",
          JSON.stringify({ assetId: asset.id, version: asset.version, status: asset.status }),
          occurredAt],
      );
      assertReturned(insertedOutbox, "event_id", eventId);
      await client.query("COMMIT");
      return { asset, receipt, replayed: false };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the domain or database error that caused the rollback.
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
