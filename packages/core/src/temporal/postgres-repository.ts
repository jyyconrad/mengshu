import { createHash } from "node:crypto";

import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { MemoryRecord, MemoryScope } from "../domain/types.js";
import type {
  AppendTemporalMemoryVersionInput,
  CloseTemporalMemoryHeadInput,
  PurgeTemporalMemoryLineageInput,
  TemporalMemoryRepository,
} from "./repository.js";
import {
  MemoryEvolutionError,
  type MemoryHistoryResult,
  type MemoryLineageHead,
  type MemoryPurgeReceipt,
  type MemoryTemporalVersion,
  type MemoryVersionTransitionReceipt,
  type MemoryVersionTransitionResult,
} from "./types.js";
import { PostgresTemporalDerivedPurgeError } from "./postgres-derived-purger.js";

export interface PostgresTemporalMemoryQueryResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly rows: readonly Row[];
  readonly rowCount?: number | null;
}

export interface PostgresTemporalMemoryQueryClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresTemporalMemoryQueryResult<Row>>;
}

export interface PostgresTemporalMemoryClient extends PostgresTemporalMemoryQueryClient {
  release(): void;
}

export interface PostgresTemporalMemoryPool extends PostgresTemporalMemoryQueryClient {
  connect(): Promise<PostgresTemporalMemoryClient>;
}

export interface PostgresTemporalMemoryRepositoryOptions {
  readonly persistVersion?: (
    client: PostgresTemporalMemoryClient,
    version: MemoryTemporalVersion,
  ) => Promise<{ readonly memoryId: string; readonly stored: boolean }>;
  readonly purgeDerived?: (
    versionIds: readonly string[],
    lineageId: string,
    scopeFingerprint: string,
  ) => Promise<number>;
}

const SHA256 = /^[a-f0-9]{64}$/;

function normalizedScope(scope: MemoryScope): MemoryScope {
  return scope.visibility === undefined ? { ...scope, visibility: "private" } : scope;
}

function scopeFingerprint(scope: MemoryScope): string {
  return authorityScopeFingerprint(normalizedScope(scope));
}

function first(result: PostgresTemporalMemoryQueryResult): Record<string, unknown> | undefined {
  if ((result.rowCount ?? result.rows.length) !== result.rows.length || result.rows.length > 1) {
    throw new MemoryEvolutionError("MEMORY_VERSION_CONFLICT");
  }
  return result.rows[0];
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value :
    typeof value === "string" && value.trim().length > 0 ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function dataRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function decodeHead(row: Record<string, unknown> | undefined): MemoryLineageHead | undefined {
  if (!row) return undefined;
  const latestRevision = numberValue(row.latest_revision);
  const updatedAt = numberValue(row.updated_at);
  if (typeof row.scope_fingerprint !== "string" || !SHA256.test(row.scope_fingerprint) ||
      typeof row.lineage_id !== "string" || row.lineage_id.length === 0 ||
      latestRevision === undefined || latestRevision < 1 || updatedAt === undefined ||
      (row.current_version_id !== null && row.current_version_id !== undefined &&
        typeof row.current_version_id !== "string") ||
      (row.current_version_revision !== null && row.current_version_revision !== undefined &&
        numberValue(row.current_version_revision) === undefined)) {
    throw new MemoryEvolutionError("MEMORY_VERSION_CONFLICT");
  }
  const currentVersionRevision = row.current_version_revision === null ||
      row.current_version_revision === undefined
    ? undefined
    : numberValue(row.current_version_revision);
  return {
    scopeFingerprint: row.scope_fingerprint,
    lineageId: row.lineage_id,
    latestRevision,
    ...(typeof row.current_version_id === "string"
      ? { currentVersionId: row.current_version_id }
      : {}),
    ...(currentVersionRevision === undefined ? {} : { currentVersionRevision }),
    updatedAt,
  };
}

function decodeTransitionReceipt(value: unknown): MemoryVersionTransitionReceipt {
  const receipt = dataRecord(value);
  if (!receipt || typeof receipt.id !== "string" ||
      typeof receipt.idempotencyKey !== "string" ||
      typeof receipt.requestHash !== "string" || !SHA256.test(receipt.requestHash) ||
      typeof receipt.scopeFingerprint !== "string" || !SHA256.test(receipt.scopeFingerprint) ||
      typeof receipt.lineageId !== "string" ||
      !["created", "evolved", "corrected", "expired", "restored", "revoked"]
        .includes(String(receipt.transitionType)) ||
      numberValue(receipt.revision) === undefined || numberValue(receipt.occurredAt) === undefined) {
    throw new MemoryEvolutionError("MEMORY_VERSION_CONFLICT");
  }
  return structuredClone(receipt) as unknown as MemoryVersionTransitionReceipt;
}

function decodePurgeReceipt(value: unknown): MemoryPurgeReceipt {
  const receipt = dataRecord(value);
  if (!receipt || typeof receipt.operationId !== "string" ||
      typeof receipt.idempotencyKey !== "string" ||
      typeof receipt.requestHash !== "string" || !SHA256.test(receipt.requestHash) ||
      typeof receipt.scopeFingerprint !== "string" || !SHA256.test(receipt.scopeFingerprint) ||
      typeof receipt.lineageHash !== "string" || !SHA256.test(receipt.lineageHash) ||
      numberValue(receipt.purgedVersions) === undefined ||
      numberValue(receipt.derivedArtifactsPurged) === undefined ||
      numberValue(receipt.occurredAt) === undefined) {
    throw new MemoryEvolutionError("MEMORY_VERSION_CONFLICT");
  }
  return structuredClone(receipt) as unknown as MemoryPurgeReceipt;
}

function decodeVersion(row: Record<string, unknown> | undefined): MemoryTemporalVersion | undefined {
  if (!row) return undefined;
  const snapshot = dataRecord(row.temporal_snapshot);
  const snapshotRecord = snapshot && dataRecord(snapshot.record);
  const revision = numberValue(row.revision);
  const validFrom = numberValue(row.valid_from_ms);
  const validTo = row.valid_to_ms === null || row.valid_to_ms === undefined
    ? undefined
    : numberValue(row.valid_to_ms);
  const recordedAt = numberValue(row.recorded_at_ms);
  const closedAt = row.closed_at_ms === null || row.closed_at_ms === undefined
    ? undefined
    : numberValue(row.closed_at_ms);
  const activationState = row.temporal_activation_state === undefined
    ? "active"
    : row.temporal_activation_state;
  if (!snapshot || !snapshotRecord || typeof row.id !== "string" ||
      typeof row.lineage_id !== "string" || revision === undefined || revision < 1 ||
      validFrom === undefined || recordedAt === undefined ||
      (validTo !== undefined && validTo < validFrom) ||
      (closedAt !== undefined && closedAt < recordedAt) ||
      snapshotRecord.id !== row.id || snapshotRecord.text !== row.text ||
      snapshotRecord.contentHash !== row.content_hash ||
      typeof row.lifecycle_status !== "string" ||
      (activationState !== "active" && activationState !== "staged")) {
    throw new MemoryEvolutionError("MEMORY_VERSION_CONFLICT");
  }
  const record = structuredClone(snapshotRecord) as unknown as MemoryRecord;
  record.lifecycleStatus = activationState === "staged"
    ? "active"
    : row.lifecycle_status as MemoryRecord["lifecycleStatus"];
  return {
    ...(structuredClone(snapshot) as unknown as MemoryTemporalVersion),
    record,
    lineageId: row.lineage_id,
    revision,
    validFrom,
    ...(validTo === undefined ? {} : { validTo }),
    recordedAt,
    ...(closedAt === undefined ? {} : { closedAt }),
    invalidated: row.temporal_invalidated === true,
    activationState,
  };
}

function eventId(receipt: MemoryVersionTransitionReceipt, eventType: string): string {
  return createHash("sha256").update(JSON.stringify([
    "mengshu.memory-version-outbox/v1",
    receipt.scopeFingerprint,
    receipt.id,
    eventType,
  ])).digest("hex");
}

async function transaction<T>(
  pool: PostgresTemporalMemoryPool,
  work: (client: PostgresTemporalMemoryClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the domain/database error that caused rollback.
    }
    throw error;
  } finally {
    client.release();
  }
}

export class PostgresTemporalMemoryRepository implements TemporalMemoryRepository {
  readonly #persistVersion: NonNullable<PostgresTemporalMemoryRepositoryOptions["persistVersion"]>;
  readonly #purgeDerived: NonNullable<PostgresTemporalMemoryRepositoryOptions["purgeDerived"]>;

  constructor(
    private readonly pool: PostgresTemporalMemoryPool,
    options: PostgresTemporalMemoryRepositoryOptions = {},
  ) {
    this.#persistVersion = options.persistVersion ?? this.#insertCanonicalVersion.bind(this);
    this.#purgeDerived = options.purgeDerived ?? (async () => 0);
  }

  async #insertCanonicalVersion(
    client: PostgresTemporalMemoryClient,
    version: MemoryTemporalVersion,
  ): Promise<{ memoryId: string; stored: boolean }> {
    const record = version.record;
    if (!record.vector || record.vector.length === 0) {
      throw new MemoryEvolutionError("MEMORY_EVOLUTION_INVALID");
    }
    const scope = normalizedScope(record.scope);
    const metadata = {
      ...record.metadata,
      ...(record.semanticType === undefined ? {} : { semanticType: record.semanticType }),
      ...(record.container === undefined ? {} : { memoryContainer: record.container }),
      ...(record.confidence === undefined ? {} : { confidence: record.confidence }),
      ...(record.sourceNodeIds === undefined ? {} : { sourceNodeIds: record.sourceNodeIds }),
    };
    const result = await client.query(
      `/* temporal-repository:insert-canonical-version */
INSERT INTO memories (
  id, text, content_hash, vector, importance, category, data_type, metadata, created_at,
  project_name, app_name, user_id, agent_id, workspace_id,
  tenant_id, canonical_project_id, product_id, producer_id, namespace, visibility,
  scope_key, lifecycle_status
) VALUES (
  $1, $2, $3, $4::vector, $5, $6, 'memory', $7::jsonb, $8, $9, $10, $11,
  $12, $13, $14, $15, $16, $17, $18, $19, $20, 'active'
)
ON CONFLICT DO NOTHING
RETURNING id`,
      [record.id, record.text, record.contentHash, `[${record.vector.join(",")}]`,
        record.importance, record.category, JSON.stringify(metadata),
        new Date(record.createdAt).toISOString(), scope.projectId, scope.appId, scope.userId,
        scope.agentId, scope.workspaceId ?? null, scope.tenantId, scope.projectId, scope.appId,
        scope.agentId, scope.namespace, scope.visibility,
        JSON.stringify([scope.tenantId, scope.appId, scope.userId, scope.projectId,
          scope.agentId, scope.namespace])],
    );
    const persistedId = result.rows[0]?.id;
    if (result.rowCount !== 1 || persistedId !== record.id) {
      throw new MemoryEvolutionError("MEMORY_VERSION_CONFLICT");
    }
    return { memoryId: record.id, stored: true };
  }

  async getTransitionReceipt(scope: MemoryScope, idempotencyKey: string) {
    const result = await this.pool.query(
      `/* temporal-repository:get-transition-receipt */
SELECT receipt
FROM mengshu_memory_version_transition_receipts
WHERE scope_fingerprint = $1 AND idempotency_key = $2`,
      [scopeFingerprint(scope), idempotencyKey],
    );
    const row = first(result);
    return row ? decodeTransitionReceipt(row.receipt) : undefined;
  }

  async getPurgeReceipt(scope: MemoryScope, idempotencyKey: string) {
    const result = await this.pool.query(
      `/* temporal-repository:get-purge-receipt */
SELECT receipt
FROM mengshu_memory_purge_receipts
WHERE scope_fingerprint = $1 AND idempotency_key = $2`,
      [scopeFingerprint(scope), idempotencyKey],
    );
    const row = first(result);
    return row ? decodePurgeReceipt(row.receipt) : undefined;
  }

  async getHead(scope: MemoryScope, lineageId: string) {
    const result = await this.pool.query(
      `/* temporal-repository:get-head */
SELECT scope_fingerprint, lineage_id, latest_revision, current_version_id,
       current_version_revision, updated_at
FROM mengshu_memory_lineage_heads
WHERE scope_fingerprint = $1 AND lineage_id = $2`,
      [scopeFingerprint(scope), lineageId],
    );
    return decodeHead(first(result));
  }

  async getVersion(scope: MemoryScope, lineageId: string, versionId: string) {
    const result = await this.pool.query(
      `/* temporal-repository:get-version */
SELECT id::text AS id, text, content_hash, lifecycle_status, lineage_id, revision,
       floor(extract(epoch FROM valid_from) * 1000)::text AS valid_from_ms,
       CASE WHEN valid_to IS NULL THEN NULL
         ELSE floor(extract(epoch FROM valid_to) * 1000)::text END AS valid_to_ms,
       floor(extract(epoch FROM recorded_at) * 1000)::text AS recorded_at_ms,
       CASE WHEN closed_at IS NULL THEN NULL
         ELSE floor(extract(epoch FROM closed_at) * 1000)::text END AS closed_at_ms,
       temporal_invalidated, temporal_activation_state, temporal_snapshot
FROM memories
WHERE scope_fingerprint = $1 AND lineage_id = $2 AND id = $3
  AND temporal_purge_pending IS NOT TRUE`,
      [scopeFingerprint(scope), lineageId, versionId],
    );
    return decodeVersion(first(result));
  }

  async #lockedReceipt(
    client: PostgresTemporalMemoryClient,
    scope: MemoryScope,
    receipt: MemoryVersionTransitionReceipt,
  ): Promise<MemoryVersionTransitionResult | undefined> {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `memory-version-receipt:${receipt.scopeFingerprint}:${receipt.idempotencyKey}`,
    ]);
    const result = await client.query(
      `/* temporal-repository:receipt-lock */
SELECT receipts.receipt, memories.id::text AS id, memories.text, memories.content_hash,
       memories.lifecycle_status, memories.lineage_id, memories.revision,
       floor(extract(epoch FROM memories.valid_from) * 1000)::text AS valid_from_ms,
       CASE WHEN memories.valid_to IS NULL THEN NULL
         ELSE floor(extract(epoch FROM memories.valid_to) * 1000)::text END AS valid_to_ms,
       floor(extract(epoch FROM memories.recorded_at) * 1000)::text AS recorded_at_ms,
       CASE WHEN memories.closed_at IS NULL THEN NULL
         ELSE floor(extract(epoch FROM memories.closed_at) * 1000)::text END AS closed_at_ms,
       memories.temporal_invalidated, memories.temporal_activation_state,
       memories.temporal_snapshot
FROM mengshu_memory_version_transition_receipts AS receipts
LEFT JOIN memories ON memories.id = COALESCE(receipts.version_id, receipts.previous_version_id)
WHERE receipts.scope_fingerprint = $1 AND receipts.idempotency_key = $2`,
      [receipt.scopeFingerprint, receipt.idempotencyKey],
    );
    const row = first(result);
    if (!row) return undefined;
    const existing = decodeTransitionReceipt(row.receipt);
    if (existing.requestHash !== receipt.requestHash) {
      throw new MemoryEvolutionError("MEMORY_IDEMPOTENCY_CONFLICT");
    }
    const version = decodeVersion(row);
    if (!version) throw new MemoryEvolutionError("MEMORY_VERSION_CONFLICT");
    return { version, receipt: existing, replayed: true };
  }

  async appendVersion(
    input: AppendTemporalMemoryVersionInput,
  ): Promise<MemoryVersionTransitionResult> {
    return transaction(this.pool, (client) => this.appendVersionWithClient(client, input));
  }

  /** Uses a caller-owned transaction; intended only for the provider-owned Write Kernel port. */
  async appendVersionWithClient(
    client: PostgresTemporalMemoryClient,
    input: AppendTemporalMemoryVersionInput,
  ): Promise<MemoryVersionTransitionResult> {
      const replay = await this.#lockedReceipt(client, input.scope, input.receipt);
      if (replay) return replay;
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `memory-lineage:${input.receipt.scopeFingerprint}:${input.version.lineageId}`,
      ]);
      const headResult = await client.query(
        `/* temporal-repository:head-lock */
SELECT scope_fingerprint, lineage_id, latest_revision, current_version_id,
       current_version_revision, updated_at
FROM mengshu_memory_lineage_heads
WHERE scope_fingerprint = $1 AND lineage_id = $2
FOR UPDATE`,
        [input.receipt.scopeFingerprint, input.version.lineageId],
      );
      const head = decodeHead(first(headResult));
      const restoringWithoutCurrent = input.version.transitionType === "restored" &&
        head !== undefined && head.currentVersionId === undefined;
      const currentRevision = head?.latestRevision ?? 0;
      const staged = input.version.activationState === "staged";
      if (currentRevision !== input.expectedHeadRevision ||
          input.version.revision !== input.expectedHeadRevision + 1 ||
          (!restoringWithoutCurrent && input.expectedHeadRevision > 0 &&
            head?.currentVersionId !== input.version.previousVersionId) ||
          (!staged && head?.currentVersionRevision !== undefined &&
            head.currentVersionRevision !== head.latestRevision)) {
        throw new MemoryEvolutionError("MEMORY_VERSION_STALE");
      }

      if (input.version.transitionType === "restored") {
        if (!input.version.restoredFromVersionId) {
          throw new MemoryEvolutionError("MEMORY_VERSION_CONFLICT");
        }
        const sourceResult = await client.query(
          `/* temporal-repository:restore-source-lock */
SELECT id::text AS id, text, content_hash
FROM memories
WHERE scope_fingerprint = $1 AND lineage_id = $2 AND id = $3
  AND temporal_purge_pending IS NOT TRUE
FOR SHARE`,
          [input.receipt.scopeFingerprint, input.version.lineageId,
            input.version.restoredFromVersionId],
        );
        const source = first(sourceResult);
        if (!source) throw new MemoryEvolutionError("MEMORY_VERSION_NOT_FOUND");
        if (source.id !== input.version.restoredFromVersionId ||
            source.text !== input.version.record.text ||
            source.content_hash !== input.version.record.contentHash) {
          throw new MemoryEvolutionError("MEMORY_VERSION_CONFLICT");
        }
      }

      if (!staged && head?.currentVersionId) {
        const lifecycle = input.version.transitionType === "corrected" ? "revoked" : "superseded";
        const closed = await client.query(
          `/* temporal-repository:close-head */
UPDATE memories
SET valid_to = to_timestamp($1::double precision / 1000),
    closed_at = to_timestamp($2::double precision / 1000),
    lifecycle_status = $3,
    temporal_invalidated = $4,
    transition_reason = $5
WHERE id = $6 AND scope_fingerprint = $7 AND lineage_id = $8 AND revision = $9
  AND valid_to IS NULL AND temporal_purge_pending IS NOT TRUE
RETURNING id::text AS id`,
          [Math.max(0, input.version.validFrom), input.version.recordedAt, lifecycle,
            input.version.transitionType === "corrected", input.version.transitionReason ?? null,
            head.currentVersionId, input.receipt.scopeFingerprint, input.version.lineageId,
            input.expectedHeadRevision],
        );
        if (closed.rowCount !== 1 || closed.rows[0]?.id !== head.currentVersionId) {
          throw new MemoryEvolutionError("MEMORY_VERSION_STALE");
        }
      }

      const persisted = await this.#persistVersion(client, input.version);
      if (!persisted.stored || persisted.memoryId !== input.version.record.id) {
        throw new MemoryEvolutionError("MEMORY_VERSION_CONFLICT");
      }
      const stamped = await client.query(
        `/* temporal-repository:stamp-version */
UPDATE memories
SET scope_fingerprint = $1, lineage_id = $2, revision = $3,
    previous_version_id = $4, restored_from_version_id = $5,
    valid_from = to_timestamp($6::double precision / 1000), valid_to = NULL,
    recorded_at = to_timestamp($7::double precision / 1000), closed_at = NULL,
    transition_type = $8, transition_reason = $9,
    temporal_invalidated = FALSE, temporal_purge_pending = FALSE,
    temporal_activation_state = $10, lifecycle_status = $11,
    temporal_snapshot = $12::jsonb
WHERE id = $13 AND tenant_id = $14 AND user_id = $15
RETURNING id::text AS id`,
        [input.receipt.scopeFingerprint, input.version.lineageId, input.version.revision,
          input.version.previousVersionId ?? null, input.version.restoredFromVersionId ?? null,
          input.version.validFrom, input.version.recordedAt, input.version.transitionType,
          input.version.transitionReason ?? null, input.version.activationState,
          staged ? "archived" : "active", JSON.stringify(input.version),
          input.version.record.id, input.scope.tenantId, input.scope.userId],
      );
      if (stamped.rowCount !== 1 || stamped.rows[0]?.id !== input.version.record.id) {
        throw new MemoryEvolutionError("MEMORY_VERSION_CONFLICT");
      }

      const advanced = input.expectedHeadRevision === 0
        ? await client.query(
            `/* temporal-repository:advance-head */
INSERT INTO mengshu_memory_lineage_heads (
  scope_fingerprint, lineage_id, latest_revision, current_version_id,
  current_version_revision, updated_at
) VALUES ($1, $2, 1, $3, $4, $5)
RETURNING latest_revision`,
            [input.receipt.scopeFingerprint, input.version.lineageId,
              staged ? null : input.version.record.id,
              staged ? null : input.version.revision, input.version.recordedAt],
          )
        : staged
        ? await client.query(
            `/* temporal-repository:advance-staged-head */
UPDATE mengshu_memory_lineage_heads
SET latest_revision = $1, updated_at = $2
WHERE scope_fingerprint = $3 AND lineage_id = $4
  AND latest_revision = $5 AND current_version_revision = $5
RETURNING latest_revision`,
            [input.version.revision, input.version.recordedAt,
              input.receipt.scopeFingerprint, input.version.lineageId,
              input.expectedHeadRevision],
          )
        : await client.query(
            `/* temporal-repository:advance-head */
UPDATE mengshu_memory_lineage_heads
SET latest_revision = $1, current_version_id = $2,
    current_version_revision = $1, updated_at = $3
WHERE scope_fingerprint = $4 AND lineage_id = $5
  AND latest_revision = $6
  AND (($7::boolean AND current_version_revision IS NULL) OR
    (NOT $7::boolean AND current_version_revision = $6))
RETURNING latest_revision`,
            [input.version.revision, input.version.record.id, input.version.recordedAt,
              input.receipt.scopeFingerprint, input.version.lineageId,
              input.expectedHeadRevision, restoringWithoutCurrent],
          );
      if (advanced.rowCount !== 1 || numberValue(advanced.rows[0]?.latest_revision) !==
          input.version.revision) {
        throw new MemoryEvolutionError("MEMORY_VERSION_STALE");
      }

      const insertedReceipt = await client.query(
        `/* temporal-repository:insert-receipt */
INSERT INTO mengshu_memory_version_transition_receipts (
  receipt_id, scope_fingerprint, idempotency_key, request_hash, lineage_id,
  transition_type, previous_version_id, version_id, revision, receipt, occurred_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
RETURNING receipt_id`,
        [input.receipt.id, input.receipt.scopeFingerprint, input.receipt.idempotencyKey,
          input.receipt.requestHash, input.receipt.lineageId, input.receipt.transitionType,
          input.receipt.previousVersionId ?? null, input.receipt.versionId ?? null,
          input.receipt.revision, JSON.stringify(input.receipt), input.receipt.occurredAt],
      );
      if (insertedReceipt.rowCount !== 1 ||
          insertedReceipt.rows[0]?.receipt_id !== input.receipt.id) {
        throw new MemoryEvolutionError("MEMORY_VERSION_CONFLICT");
      }
      const outboxType = input.version.transitionType === "corrected"
        ? "memory.version.corrected"
        : input.version.transitionType === "restored"
        ? "memory.version.restored"
        : "memory.version.created";
      const id = eventId(input.receipt, outboxType);
      const insertedOutbox = await client.query(
        `/* temporal-repository:insert-outbox */
INSERT INTO mengshu_memory_version_outbox (
  event_id, scope_fingerprint, lineage_id, revision, event_type, payload, occurred_at
) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
RETURNING event_id`,
        [id, input.receipt.scopeFingerprint, input.version.lineageId,
          input.version.revision, outboxType,
          JSON.stringify({ versionId: input.version.record.id, revision: input.version.revision }),
          input.receipt.occurredAt],
      );
      if (insertedOutbox.rowCount !== 1 || insertedOutbox.rows[0]?.event_id !== id) {
        throw new MemoryEvolutionError("MEMORY_VERSION_CONFLICT");
      }
      return {
        version: structuredClone(input.version),
        receipt: structuredClone(input.receipt),
        replayed: false,
      };
  }

  async closeHead(input: CloseTemporalMemoryHeadInput): Promise<MemoryVersionTransitionResult> {
    const result = await transaction(this.pool, async (client) => {
      const replay = await this.#lockedReceipt(client, input.scope, input.receipt);
      if (replay) return replay;
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `memory-lineage:${input.receipt.scopeFingerprint}:${input.lineageId}`,
      ]);
      const headResult = await client.query(
        `/* temporal-repository:head-lock */
SELECT scope_fingerprint, lineage_id, latest_revision, current_version_id,
       current_version_revision, updated_at
FROM mengshu_memory_lineage_heads
WHERE scope_fingerprint = $1 AND lineage_id = $2
FOR UPDATE`,
        [input.receipt.scopeFingerprint, input.lineageId],
      );
      const head = decodeHead(first(headResult));
      if (!head?.currentVersionId || head.latestRevision !== input.expectedHeadRevision ||
          head.currentVersionRevision !== input.expectedHeadRevision) {
        throw new MemoryEvolutionError("MEMORY_VERSION_STALE");
      }
      const scheduled = input.transitionType === "expired" &&
        input.validTo > input.receipt.occurredAt;
      const closed = scheduled
        ? await client.query(
            `/* temporal-repository:close-head-state */
UPDATE memories
SET valid_to = to_timestamp($1::double precision / 1000),
    transition_reason = $2
WHERE id = $3 AND scope_fingerprint = $4 AND lineage_id = $5 AND revision = $6
  AND valid_to IS NULL AND lifecycle_status = 'active'
  AND temporal_activation_state = 'active' AND temporal_purge_pending IS NOT TRUE
RETURNING id::text AS id`,
            [input.validTo, input.reason ?? null, head.currentVersionId,
              input.receipt.scopeFingerprint, input.lineageId, input.expectedHeadRevision],
          )
        : await client.query(
            `/* temporal-repository:close-head-state */
UPDATE memories
SET valid_to = to_timestamp($1::double precision / 1000),
    closed_at = to_timestamp($2::double precision / 1000),
    lifecycle_status = $3, transition_reason = $4, temporal_invalidated = $5
WHERE id = $6 AND scope_fingerprint = $7 AND lineage_id = $8 AND revision = $9
  AND valid_to IS NULL AND temporal_purge_pending IS NOT TRUE
RETURNING id::text AS id`,
            [input.validTo, input.receipt.occurredAt,
              input.transitionType === "revoked" ? "revoked" : "archived",
              input.reason ?? null, input.transitionType === "revoked", head.currentVersionId,
              input.receipt.scopeFingerprint, input.lineageId, input.expectedHeadRevision],
          );
      if (closed.rowCount !== 1 || closed.rows[0]?.id !== head.currentVersionId) {
        throw new MemoryEvolutionError("MEMORY_VERSION_STALE");
      }
      if (!scheduled) {
        const cleared = await client.query(
          `/* temporal-repository:clear-head */
UPDATE mengshu_memory_lineage_heads
SET current_version_id = NULL, current_version_revision = NULL, updated_at = $1
WHERE scope_fingerprint = $2 AND lineage_id = $3
  AND current_version_revision = $4
RETURNING latest_revision`,
          [input.receipt.occurredAt, input.receipt.scopeFingerprint, input.lineageId,
            input.expectedHeadRevision],
        );
        if (cleared.rowCount !== 1) throw new MemoryEvolutionError("MEMORY_VERSION_STALE");
      }
      const inserted = await client.query(
        `/* temporal-repository:insert-receipt */
INSERT INTO mengshu_memory_version_transition_receipts (
  receipt_id, scope_fingerprint, idempotency_key, request_hash, lineage_id,
  transition_type, previous_version_id, version_id, revision, receipt, occurred_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9::jsonb, $10)
RETURNING receipt_id`,
        [input.receipt.id, input.receipt.scopeFingerprint, input.receipt.idempotencyKey,
          input.receipt.requestHash, input.lineageId, input.transitionType, head.currentVersionId,
          input.expectedHeadRevision, JSON.stringify(input.receipt), input.receipt.occurredAt],
      );
      if (inserted.rowCount !== 1) throw new MemoryEvolutionError("MEMORY_VERSION_CONFLICT");
      if (!scheduled) {
        const outboxId = eventId(input.receipt, "memory.version.closed");
        await client.query(
          `/* temporal-repository:insert-outbox */
INSERT INTO mengshu_memory_version_outbox (
  event_id, scope_fingerprint, lineage_id, revision, event_type, payload, occurred_at
) VALUES ($1, $2, $3, $4, 'memory.version.closed', $5::jsonb, $6)
RETURNING event_id`,
          [outboxId, input.receipt.scopeFingerprint, input.lineageId,
            input.expectedHeadRevision, JSON.stringify({
              versionId: head.currentVersionId,
              transitionType: input.transitionType,
            }),
            input.receipt.occurredAt],
        );
      }
      return { versionId: head.currentVersionId, receipt: input.receipt };
    });
    if ("version" in result) return result;
    const version = await this.getVersion(input.scope, input.lineageId, result.versionId);
    if (!version) throw new MemoryEvolutionError("MEMORY_VERSION_CONFLICT");
    return { version, receipt: result.receipt, replayed: false };
  }

  async current(scope: MemoryScope, lineageId: string, at: number) {
    const result = await this.pool.query(
      `/* temporal-repository:current */
SELECT id::text AS id, text, content_hash, lifecycle_status, lineage_id, revision,
       floor(extract(epoch FROM valid_from) * 1000)::text AS valid_from_ms,
       CASE WHEN valid_to IS NULL THEN NULL
         ELSE floor(extract(epoch FROM valid_to) * 1000)::text END AS valid_to_ms,
       floor(extract(epoch FROM recorded_at) * 1000)::text AS recorded_at_ms,
       CASE WHEN closed_at IS NULL THEN NULL
         ELSE floor(extract(epoch FROM closed_at) * 1000)::text END AS closed_at_ms,
       temporal_invalidated, temporal_activation_state, temporal_snapshot
FROM memories
WHERE scope_fingerprint = $1 AND lineage_id = $2
  AND ((lifecycle_status = 'active' AND temporal_activation_state = 'active') OR
    (lifecycle_status = 'archived' AND temporal_activation_state = 'staged'))
  AND valid_from <= to_timestamp($3::double precision / 1000)
  AND (valid_to IS NULL OR valid_to > to_timestamp($3::double precision / 1000))
  AND temporal_invalidated IS NOT TRUE AND temporal_purge_pending IS NOT TRUE
ORDER BY valid_from DESC, revision DESC LIMIT 1`,
      [scopeFingerprint(scope), lineageId, at],
    );
    return decodeVersion(first(result));
  }

  async asOf(scope: MemoryScope, lineageId: string, asOf: number, knownAt?: number) {
    const result = await this.pool.query(
      `/* temporal-repository:as-of */
SELECT id::text AS id, text, content_hash, lifecycle_status, lineage_id, revision,
       floor(extract(epoch FROM valid_from) * 1000)::text AS valid_from_ms,
       CASE WHEN valid_to IS NULL THEN NULL
         ELSE floor(extract(epoch FROM valid_to) * 1000)::text END AS valid_to_ms,
       floor(extract(epoch FROM recorded_at) * 1000)::text AS recorded_at_ms,
       CASE WHEN closed_at IS NULL THEN NULL
         ELSE floor(extract(epoch FROM closed_at) * 1000)::text END AS closed_at_ms,
       temporal_invalidated, temporal_activation_state, temporal_snapshot
FROM memories
WHERE scope_fingerprint = $1 AND lineage_id = $2
  AND valid_from <= to_timestamp($3::double precision / 1000)
  AND (valid_to IS NULL OR valid_to > to_timestamp($3::double precision / 1000))
  AND temporal_invalidated IS NOT TRUE AND temporal_purge_pending IS NOT TRUE
  AND lifecycle_status IN ('active', 'superseded', 'archived')
  AND ($4::bigint IS NULL OR (
    recorded_at <= to_timestamp($4::double precision / 1000) AND
    (closed_at IS NULL OR closed_at > to_timestamp($4::double precision / 1000))
  ))
ORDER BY revision DESC LIMIT 1`,
      [scopeFingerprint(scope), lineageId, asOf, knownAt ?? null],
    );
    return decodeVersion(first(result));
  }

  async history(scope: MemoryScope, lineageId: string): Promise<MemoryHistoryResult | undefined> {
    const head = await this.getHead(scope, lineageId);
    if (!head) return undefined;
    const result = await this.pool.query(
      `/* temporal-repository:history */
SELECT id::text AS id, text, content_hash, lifecycle_status, lineage_id, revision,
       floor(extract(epoch FROM valid_from) * 1000)::text AS valid_from_ms,
       CASE WHEN valid_to IS NULL THEN NULL
         ELSE floor(extract(epoch FROM valid_to) * 1000)::text END AS valid_to_ms,
       floor(extract(epoch FROM recorded_at) * 1000)::text AS recorded_at_ms,
       CASE WHEN closed_at IS NULL THEN NULL
         ELSE floor(extract(epoch FROM closed_at) * 1000)::text END AS closed_at_ms,
       temporal_invalidated, temporal_activation_state, temporal_snapshot
FROM memories
WHERE scope_fingerprint = $1 AND lineage_id = $2
  AND temporal_purge_pending IS NOT TRUE
ORDER BY revision`,
      [scopeFingerprint(scope), lineageId],
    );
    const versions = result.rows.map((row) => decodeVersion(row));
    if (versions.some((version) => version === undefined)) {
      throw new MemoryEvolutionError("MEMORY_VERSION_CONFLICT");
    }
    return {
      scope: structuredClone(normalizedScope(scope)),
      lineageId,
      head,
      versions: versions as MemoryTemporalVersion[],
    };
  }

  async activateDue(now: number, limit: number): Promise<number> {
    return transaction(this.pool, async (client) => {
      const due = await client.query<{
        scope_fingerprint: string;
        lineage_id: string;
        id: string;
        revision: number | string;
        valid_from_ms: number | string;
        current_version_id: string | null;
        current_version_revision: number | string | null;
      }>(
        `/* temporal-repository:lock-due-activations */
SELECT versions.scope_fingerprint, versions.lineage_id, versions.id::text AS id,
       versions.revision,
       floor(extract(epoch FROM versions.valid_from) * 1000)::text AS valid_from_ms,
       heads.current_version_id::text AS current_version_id,
       heads.current_version_revision
FROM memories versions
JOIN mengshu_memory_lineage_heads heads
  ON heads.scope_fingerprint = versions.scope_fingerprint
 AND heads.lineage_id = versions.lineage_id
 AND heads.latest_revision = versions.revision
WHERE versions.temporal_activation_state = 'staged'
  AND versions.valid_from <= to_timestamp($1::double precision / 1000)
  AND versions.temporal_purge_pending IS NOT TRUE
ORDER BY versions.valid_from, versions.scope_fingerprint, versions.lineage_id
LIMIT $2
FOR UPDATE OF versions, heads SKIP LOCKED`,
        [now, limit],
      );
      let activated = 0;
      for (const row of due.rows) {
        const revision = numberValue(row.revision);
        const validFrom = numberValue(row.valid_from_ms);
        const currentRevision = row.current_version_revision === null
          ? undefined
          : numberValue(row.current_version_revision);
        if (revision === undefined || validFrom === undefined) {
          throw new MemoryEvolutionError("MEMORY_VERSION_CONFLICT");
        }
        if (row.current_version_id !== null) {
          const closed = await client.query(
            `/* temporal-repository:activate-close-previous */
UPDATE memories
SET valid_to = to_timestamp($1::double precision / 1000),
    closed_at = to_timestamp($2::double precision / 1000),
    lifecycle_status = 'superseded'
WHERE scope_fingerprint = $3 AND lineage_id = $4 AND id = $5
  AND revision = $6 AND lifecycle_status = 'active'
  AND temporal_activation_state = 'active' AND valid_to IS NULL
  AND temporal_purge_pending IS NOT TRUE
RETURNING id::text AS id`,
            [validFrom, now, row.scope_fingerprint, row.lineage_id,
              row.current_version_id, currentRevision],
          );
          if (closed.rowCount !== 1 || closed.rows[0]?.id !== row.current_version_id) {
            throw new MemoryEvolutionError("MEMORY_VERSION_STALE");
          }
        }
        const version = await client.query(
          `/* temporal-repository:activate-version */
UPDATE memories
SET temporal_activation_state = 'active', lifecycle_status = 'active'
WHERE scope_fingerprint = $1 AND lineage_id = $2 AND id = $3 AND revision = $4
  AND temporal_activation_state = 'staged' AND lifecycle_status = 'archived'
  AND temporal_purge_pending IS NOT TRUE
RETURNING id::text AS id`,
          [row.scope_fingerprint, row.lineage_id, row.id, revision],
        );
        if (version.rowCount !== 1 || version.rows[0]?.id !== row.id) {
          throw new MemoryEvolutionError("MEMORY_VERSION_STALE");
        }
        const head = await client.query(
          `/* temporal-repository:activate-head */
UPDATE mengshu_memory_lineage_heads
SET current_version_id = $1, current_version_revision = $2, updated_at = $3
WHERE scope_fingerprint = $4 AND lineage_id = $5 AND latest_revision = $2
  AND current_version_revision IS NOT DISTINCT FROM $6
RETURNING latest_revision`,
          [row.id, revision, now, row.scope_fingerprint, row.lineage_id,
            currentRevision ?? null],
        );
        if (head.rowCount !== 1 || numberValue(head.rows[0]?.latest_revision) !== revision) {
          throw new MemoryEvolutionError("MEMORY_VERSION_STALE");
        }
        const outboxId = createHash("sha256").update(JSON.stringify([
          "mengshu.memory-version-activation/v1",
          row.scope_fingerprint,
          row.lineage_id,
          revision,
        ])).digest("hex");
        await client.query(
          `/* temporal-repository:activate-outbox */
INSERT INTO mengshu_memory_version_outbox (
  event_id, scope_fingerprint, lineage_id, revision, event_type, payload, occurred_at
) VALUES ($1, $2, $3, $4, 'memory.version.created', $5::jsonb, $6)
ON CONFLICT (event_id) DO NOTHING`,
          [outboxId, row.scope_fingerprint, row.lineage_id, revision,
            JSON.stringify({ versionId: row.id, revision, activationState: "active" }), now],
        );
        activated += 1;
      }
      return activated;
    });
  }

  async materializeExpired(now: number, limit: number): Promise<number> {
    return transaction(this.pool, async (client) => {
      const due = await client.query<{
        scope_fingerprint: string;
        lineage_id: string;
        id: string;
        revision: number | string;
        valid_to_ms: number | string;
      }>(
        `/* temporal-repository:lock-due-expirations */
SELECT versions.scope_fingerprint, versions.lineage_id, versions.id::text AS id,
       versions.revision,
       floor(extract(epoch FROM versions.valid_to) * 1000)::text AS valid_to_ms
FROM memories versions
JOIN mengshu_memory_lineage_heads heads
  ON heads.scope_fingerprint = versions.scope_fingerprint
 AND heads.lineage_id = versions.lineage_id
 AND heads.current_version_id = versions.id
 AND heads.current_version_revision = versions.revision
WHERE versions.lifecycle_status = 'active'
  AND versions.temporal_activation_state = 'active'
  AND versions.valid_to <= to_timestamp($1::double precision / 1000)
  AND versions.temporal_invalidated IS NOT TRUE
  AND versions.temporal_purge_pending IS NOT TRUE
ORDER BY versions.valid_to, versions.scope_fingerprint, versions.lineage_id
LIMIT $2
FOR UPDATE OF versions, heads SKIP LOCKED`,
        [now, limit],
      );
      let materialized = 0;
      for (const row of due.rows) {
        const revision = numberValue(row.revision);
        const validTo = numberValue(row.valid_to_ms);
        if (revision === undefined || validTo === undefined) {
          throw new MemoryEvolutionError("MEMORY_VERSION_CONFLICT");
        }
        const version = await client.query(
          `/* temporal-repository:materialize-expired-version */
UPDATE memories
SET lifecycle_status = 'archived',
    closed_at = to_timestamp($1::double precision / 1000)
WHERE scope_fingerprint = $2 AND lineage_id = $3 AND id = $4 AND revision = $5
  AND lifecycle_status = 'active' AND temporal_activation_state = 'active'
  AND valid_to <= to_timestamp($1::double precision / 1000)
  AND temporal_purge_pending IS NOT TRUE
RETURNING id::text AS id`,
          [now, row.scope_fingerprint, row.lineage_id, row.id, revision],
        );
        if (version.rowCount !== 1 || version.rows[0]?.id !== row.id) {
          throw new MemoryEvolutionError("MEMORY_VERSION_STALE");
        }
        const head = await client.query(
          `/* temporal-repository:materialize-expired-head */
UPDATE mengshu_memory_lineage_heads
SET current_version_id = NULL, current_version_revision = NULL, updated_at = $1
WHERE scope_fingerprint = $2 AND lineage_id = $3
  AND current_version_id = $4 AND current_version_revision = $5
RETURNING latest_revision`,
          [now, row.scope_fingerprint, row.lineage_id, row.id, revision],
        );
        if (head.rowCount !== 1) throw new MemoryEvolutionError("MEMORY_VERSION_STALE");
        const outboxId = createHash("sha256").update(JSON.stringify([
          "mengshu.memory-expiration-materialized/v1",
          row.scope_fingerprint,
          row.lineage_id,
          revision,
          validTo,
        ])).digest("hex");
        await client.query(
          `/* temporal-repository:materialize-expired-outbox */
INSERT INTO mengshu_memory_version_outbox (
  event_id, scope_fingerprint, lineage_id, revision, event_type, payload, occurred_at
) VALUES ($1, $2, $3, $4, 'memory.version.closed', $5::jsonb, $6)
ON CONFLICT (event_id) DO NOTHING`,
          [outboxId, row.scope_fingerprint, row.lineage_id, revision,
            JSON.stringify({
              versionId: row.id,
              transitionType: "expired",
              validTo,
              materialized: true,
            }), now],
        );
        materialized += 1;
      }
      return materialized;
    });
  }

  async purge(input: PurgeTemporalMemoryLineageInput): Promise<MemoryPurgeReceipt> {
    const existing = await this.getPurgeReceipt(input.scope, input.receipt.idempotencyKey);
    if (existing) {
      if (existing.requestHash !== input.receipt.requestHash) {
        throw new MemoryEvolutionError("MEMORY_IDEMPOTENCY_CONFLICT");
      }
      return existing;
    }
    return this.#purgeByIdentity({ lineageId: input.lineageId, receipt: input.receipt });
  }

  async #purgeByIdentity(input: {
    readonly lineageId: string;
    readonly receipt: MemoryPurgeReceipt;
  }): Promise<MemoryPurgeReceipt> {
    const versionIds = await transaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `memory-purge:${input.receipt.scopeFingerprint}:${input.lineageId}`,
      ]);
      const receiptLock = await client.query(
        `/* temporal-repository:purge-receipt-lock */
SELECT receipt FROM mengshu_memory_purge_receipts
WHERE scope_fingerprint = $1 AND idempotency_key = $2`,
        [input.receipt.scopeFingerprint, input.receipt.idempotencyKey],
      );
      const receiptRow = first(receiptLock);
      if (receiptRow) {
        const replay = decodePurgeReceipt(receiptRow.receipt);
        if (replay.requestHash !== input.receipt.requestHash) {
          throw new MemoryEvolutionError("MEMORY_IDEMPOTENCY_CONFLICT");
        }
        return { replay } as const;
      }
      const retryResult = await client.query<{
        request_hash: string;
        request: unknown;
        version_ids: unknown;
        derived_artifacts_purged: number | string;
        derived_complete: boolean;
      }>(
        `/* temporal-repository:purge-retry-lock */
SELECT request_hash, request, version_ids, derived_artifacts_purged, derived_complete
FROM mengshu_memory_purge_retry_requests
WHERE scope_fingerprint = $1 AND idempotency_key = $2
FOR UPDATE`,
        [input.receipt.scopeFingerprint, input.receipt.idempotencyKey],
      );
      const retry = first(retryResult);
      if (retry !== undefined && retry.request_hash !== input.receipt.requestHash) {
        throw new MemoryEvolutionError("MEMORY_IDEMPOTENCY_CONFLICT");
      }
      const headResult = await client.query(
        `/* temporal-repository:purge-head-lock */
SELECT latest_revision, current_version_id
FROM mengshu_memory_lineage_heads
WHERE scope_fingerprint = $1 AND lineage_id = $2
FOR UPDATE`,
        [input.receipt.scopeFingerprint, input.lineageId],
      );
      if (!first(headResult)) throw new MemoryEvolutionError("MEMORY_LINEAGE_NOT_FOUND");
      const marked = await client.query(
        `/* temporal-repository:mark-purge-pending */
UPDATE memories
SET temporal_purge_pending = TRUE, lifecycle_status = 'revoked'
WHERE scope_fingerprint = $1 AND lineage_id = $2
RETURNING id::text AS id`,
        [input.receipt.scopeFingerprint, input.lineageId],
      );
      const ids = marked.rows.map((row) => row.id).filter((id): id is string =>
        typeof id === "string");
      if (ids.length === 0 || ids.length !== marked.rows.length) {
        throw new MemoryEvolutionError("MEMORY_VERSION_CONFLICT");
      }
      const persistedRetry = await client.query(
        `/* temporal-repository:insert-purge-retry */
INSERT INTO mengshu_memory_purge_retry_requests (
  scope_fingerprint, lineage_id, operation_id, idempotency_key, request_hash,
  request, version_ids, derived_artifacts_purged, derived_complete,
  attempts, next_attempt_at, last_error_code, created_at, updated_at
) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, 0, FALSE, 0, $8, NULL, $8, $8)
ON CONFLICT (scope_fingerprint, idempotency_key) DO NOTHING
RETURNING operation_id`,
        [input.receipt.scopeFingerprint, input.lineageId, input.receipt.operationId,
          input.receipt.idempotencyKey, input.receipt.requestHash, JSON.stringify(input.receipt),
          JSON.stringify(ids), input.receipt.occurredAt],
      );
      if (retry === undefined && (persistedRetry.rowCount !== 1 ||
          persistedRetry.rows[0]?.operation_id !== input.receipt.operationId)) {
        throw new MemoryEvolutionError("MEMORY_VERSION_CONFLICT");
      }
      await client.query(
        `/* temporal-repository:purge-pending-outbox */
INSERT INTO mengshu_memory_version_outbox (
  event_id, scope_fingerprint, lineage_id, revision, event_type, payload, occurred_at
) VALUES ($1, $2, $3, $4, 'memory.version.purge_pending', $5::jsonb, $6)
ON CONFLICT (event_id) DO NOTHING`,
        [createHash("sha256").update(`${input.receipt.operationId}:pending`).digest("hex"),
          input.receipt.scopeFingerprint, input.lineageId,
          numberValue(first(headResult)?.latest_revision) ?? ids.length,
          JSON.stringify({ operationId: input.receipt.operationId, versionCount: ids.length }),
          input.receipt.occurredAt],
      );
      return {
        ids,
        derivedArtifactsPurged: retry === undefined
          ? 0
          : numberValue(retry.derived_artifacts_purged) ?? 0,
        derivedComplete: retry?.derived_complete === true,
      } as const;
    });
    if ("replay" in versionIds) {
      if (!versionIds.replay) throw new MemoryEvolutionError("MEMORY_VERSION_CONFLICT");
      return versionIds.replay;
    }

    let derivedArtifactsPurged = versionIds.derivedArtifactsPurged;
    if (!versionIds.derivedComplete) {
      try {
        derivedArtifactsPurged = await this.#purgeDerived(
          versionIds.ids,
          input.lineageId,
          input.receipt.scopeFingerprint,
        );
        const persisted = await this.pool.query(
          `/* temporal-repository:complete-derived-purge */
UPDATE mengshu_memory_purge_retry_requests
SET derived_artifacts_purged = $1, derived_complete = TRUE,
    updated_at = $2, last_error_code = NULL
WHERE scope_fingerprint = $3 AND idempotency_key = $4
  AND request_hash = $5
RETURNING operation_id`,
          [derivedArtifactsPurged, Date.now(), input.receipt.scopeFingerprint,
            input.receipt.idempotencyKey, input.receipt.requestHash],
        );
        if (persisted.rowCount !== 1) throw new Error("purge retry state unavailable");
      } catch (error) {
        const code = error instanceof PostgresTemporalDerivedPurgeError
          ? error.code
          : "TEMPORAL_DERIVED_PURGE_FAILED";
        await this.pool.query(
          `/* temporal-repository:record-derived-purge-failure */
UPDATE mengshu_memory_purge_retry_requests
SET last_error_code = $1, updated_at = $2
WHERE scope_fingerprint = $3 AND idempotency_key = $4 AND request_hash = $5`,
          [code, Date.now(), input.receipt.scopeFingerprint,
            input.receipt.idempotencyKey, input.receipt.requestHash],
        ).catch(() => undefined);
        throw new MemoryEvolutionError("MEMORY_PURGE_PENDING");
      }
    }
    return transaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `memory-purge:${input.receipt.scopeFingerprint}:${input.lineageId}`,
      ]);
      const deletedHead = await client.query(
        `/* temporal-repository:delete-head */
DELETE FROM mengshu_memory_lineage_heads
WHERE scope_fingerprint = $1 AND lineage_id = $2
RETURNING lineage_id`,
        [input.receipt.scopeFingerprint, input.lineageId],
      );
      if (deletedHead.rowCount !== 1) {
        throw new MemoryEvolutionError("MEMORY_PURGE_PENDING");
      }
      const deleted = await client.query(
        `/* temporal-repository:delete-versions */
DELETE FROM memories
WHERE scope_fingerprint = $1 AND lineage_id = $2 AND temporal_purge_pending = TRUE`,
        [input.receipt.scopeFingerprint, input.lineageId],
      );
      if (deleted.rowCount !== versionIds.ids.length) {
        throw new MemoryEvolutionError("MEMORY_PURGE_PENDING");
      }
      const receipt: MemoryPurgeReceipt = {
        ...input.receipt,
        purgedVersions: versionIds.ids.length,
        derivedArtifactsPurged,
      };
      const inserted = await client.query(
        `/* temporal-repository:insert-purge-receipt */
INSERT INTO mengshu_memory_purge_receipts (
  operation_id, scope_fingerprint, idempotency_key, request_hash, lineage_hash,
  purged_versions, derived_artifacts_purged, receipt, occurred_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
RETURNING operation_id`,
        [receipt.operationId, receipt.scopeFingerprint, receipt.idempotencyKey,
          receipt.requestHash, receipt.lineageHash, receipt.purgedVersions,
          receipt.derivedArtifactsPurged, JSON.stringify(receipt), receipt.occurredAt],
      );
      if (inserted.rowCount !== 1 || inserted.rows[0]?.operation_id !== receipt.operationId) {
        throw new MemoryEvolutionError("MEMORY_PURGE_PENDING");
      }
      await client.query(
        `/* temporal-repository:purged-outbox */
INSERT INTO mengshu_memory_version_outbox (
  event_id, scope_fingerprint, lineage_id, revision, event_type, payload, occurred_at
) VALUES ($1, $2, $3, $4, 'memory.version.purged', $5::jsonb, $6)
ON CONFLICT (event_id) DO NOTHING`,
        [createHash("sha256").update(`${receipt.operationId}:purged`).digest("hex"),
          receipt.scopeFingerprint, input.lineageId, receipt.purgedVersions,
          JSON.stringify({ operationId: receipt.operationId,
            versionCount: receipt.purgedVersions }), receipt.occurredAt],
      );
      const clearedRetry = await client.query(
        `/* temporal-repository:delete-purge-retry */
DELETE FROM mengshu_memory_purge_retry_requests
WHERE scope_fingerprint = $1 AND idempotency_key = $2 AND request_hash = $3
RETURNING operation_id`,
        [receipt.scopeFingerprint, receipt.idempotencyKey, receipt.requestHash],
      );
      if (clearedRetry.rowCount !== 1) {
        throw new MemoryEvolutionError("MEMORY_PURGE_PENDING");
      }
      return structuredClone(receipt);
    });
  }

  async retryPendingPurges(now: number, limit: number) {
    const claimed = await transaction(this.pool, async (client) => {
      const due = await client.query<{
        scope_fingerprint: string;
        lineage_id: string;
        idempotency_key: string;
        request: unknown;
        attempts: number | string;
      }>(
        `/* temporal-repository:claim-purge-retries */
SELECT scope_fingerprint, lineage_id, idempotency_key, request, attempts
FROM mengshu_memory_purge_retry_requests
WHERE next_attempt_at <= $1
ORDER BY next_attempt_at, scope_fingerprint, lineage_id
LIMIT $2
FOR UPDATE SKIP LOCKED`,
        [now, limit],
      );
      for (const row of due.rows) {
        const attempts = numberValue(row.attempts) ?? 0;
        const backoff = Math.min(300_000, 1_000 * 2 ** Math.min(8, attempts));
        await client.query(
          `/* temporal-repository:lease-purge-retry */
UPDATE mengshu_memory_purge_retry_requests
SET attempts = attempts + 1, next_attempt_at = $1,
    last_error_code = 'MEMORY_PURGE_PENDING', updated_at = $2
WHERE scope_fingerprint = $3 AND idempotency_key = $4`,
          [now + backoff, now, row.scope_fingerprint, row.idempotency_key],
        );
      }
      return due.rows;
    });
    let completed = 0;
    for (const row of claimed) {
      try {
        const receipt = decodePurgeReceipt(row.request);
        if (receipt.scopeFingerprint !== row.scope_fingerprint ||
            receipt.idempotencyKey !== row.idempotency_key) {
          throw new MemoryEvolutionError("MEMORY_VERSION_CONFLICT");
        }
        await this.#purgeByIdentity({ lineageId: row.lineage_id, receipt });
        completed += 1;
      } catch {
        // The leased durable row retains its bounded backoff for the next tick.
      }
    }
    return { attempted: claimed.length, completed, failed: claimed.length - completed };
  }
}
