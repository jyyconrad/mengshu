import { createHash } from "node:crypto";
import type {
  MemoryWriteCommand,
  MemoryWriteKernelResult,
  WriteScope,
} from "./write-kernel.js";
import type { MemoryRecord, MemoryScope } from "../domain/types.js";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export interface WriteIdempotencyIdentity {
  readonly tenantId: string;
  readonly userId: string;
  readonly clientKey: string;
  /** Provider-facing opaque namespace key; client key is never used as a global PK. */
  readonly storageKey: string;
}

export interface MemoryWriteReceipt {
  readonly identity: WriteIdempotencyIdentity;
  readonly requestFingerprint: string;
  readonly result: Extract<MemoryWriteKernelResult, { status: "persisted" }>;
}

const SHA256 = /^[a-f0-9]{64}$/;
const ROUTES = new Set(["candidate_low_priority", "candidate", "active", "lookup_only", "evidence_only"]);
const LIFECYCLE_CORRECTIONS = new Set(["revoke", "archive", "delete"]);

function requiredOwnerField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`write idempotency ${field} is required`);
  }
  return value;
}

export function createWriteIdempotencyIdentity(
  scope: Pick<WriteScope, "tenantId" | "userId">,
  clientKey: string,
): WriteIdempotencyIdentity {
  const tenantId = requiredOwnerField(scope.tenantId, "tenantId");
  const userId = requiredOwnerField(scope.userId, "userId");
  if (typeof clientKey !== "string" || !IDEMPOTENCY_KEY.test(clientKey)) {
    throw new Error("write idempotency key is invalid");
  }
  return Object.freeze({
    tenantId,
    userId,
    clientKey,
    storageKey: createHash("sha256")
      .update(`${tenantId}\0${userId}\0${clientKey}`)
      .digest("hex"),
  });
}

function canonicalJsonValue(value: unknown, seen: Set<object>): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("write command must be JSON serializable");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new Error("write command must be JSON serializable");
  if (seen.has(value)) throw new Error("write command must be JSON serializable without cycles");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.map((item) => {
        const serialized = canonicalJsonValue(item, seen);
        if (serialized === undefined) throw new Error("write command arrays must be JSON serializable");
        return serialized;
      });
      return `[${items.join(",")}]`;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new Error("write command must contain plain JSON objects");
    }
    const record = value as Record<string, unknown>;
    const fields: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const serialized = canonicalJsonValue(record[key], seen);
      if (serialized !== undefined) fields.push(`${JSON.stringify(key)}:${serialized}`);
    }
    return `{${fields.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

export interface AtomicMemoryStoreResult {
  readonly id: string;
  readonly stored: boolean;
  /** Commit is proven, but returning the PoolClient to the pool failed. */
  readonly cleanupFailed?: true;
}

export interface ProviderOwnedAtomicMemoryStorePort {
  /**
   * A successful resolution proves that record, audit, outbox and receipt were
   * committed by one provider-owned transaction. Duplicate content commits a
   * receipt only and never fabricates a second memory.store event.
   */
  store(record: MemoryRecord): Promise<AtomicMemoryStoreResult>;
}

export interface PostgresMemoryWriteQueryResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly rows: Row[];
  readonly rowCount?: number | null;
}

export interface PostgresMemoryWriteClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresMemoryWriteQueryResult<Row>>;
  release(): void;
}

export interface PostgresMemoryWritePool {
  connect(): Promise<PostgresMemoryWriteClient>;
}

export interface PostgresMemoryWriteInsertResult {
  readonly requestedId: string;
  readonly persistedId: string;
  readonly stored: boolean;
}

export type PostgresMemoryWriteInsert = (
  client: PostgresMemoryWriteClient,
  record: MemoryRecord,
) => Promise<PostgresMemoryWriteInsertResult>;

const providerOwnedAtomicMemoryStorePorts = new WeakSet<object>();

export function isProviderOwnedAtomicMemoryStorePort(
  value: unknown,
): value is ProviderOwnedAtomicMemoryStorePort {
  return typeof value === "object" && value !== null &&
    providerOwnedAtomicMemoryStorePorts.has(value);
}

function requiredAtomicField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error(`atomic memory write ${field} is required`);
  }
  return value;
}

function normalizedAtomicScope(scope: MemoryScope): Required<MemoryScope> {
  const visibility = scope.visibility ?? "private";
  if (!["private", "workspace", "team", "public"].includes(visibility)) {
    throw new Error("atomic memory write visibility is invalid");
  }
  return {
    tenantId: requiredAtomicField(scope.tenantId, "tenantId"),
    userId: requiredAtomicField(scope.userId, "userId"),
    appId: requiredAtomicField(scope.appId, "appId"),
    projectId: requiredAtomicField(scope.projectId, "projectId"),
    agentId: requiredAtomicField(scope.agentId, "agentId"),
    namespace: requiredAtomicField(scope.namespace, "namespace"),
    visibility,
    workspaceId: scope.workspaceId === undefined
      ? ""
      : requiredAtomicField(scope.workspaceId, "workspaceId"),
    sessionId: scope.sessionId === undefined
      ? ""
      : requiredAtomicField(scope.sessionId, "sessionId"),
  };
}

function atomicStoreStorageKey(scope: MemoryScope, recordId: string): string {
  return createHash("sha256")
    .update([
      "memory.store.v1",
      requiredAtomicField(scope.tenantId, "tenantId"),
      requiredAtomicField(scope.userId, "userId"),
      requiredAtomicField(recordId, "record id"),
    ].join("\0"))
    .digest("hex");
}

function atomicStoreFingerprint(record: MemoryRecord, scope: Required<MemoryScope>): string {
  // Vector is deliberately excluded. It is provider/runtime-derived and may be
  // recomputed before an idempotent replay; the durable client command is the
  // record content, identity, scope and semantic metadata.
  const canonical = canonicalJsonValue({
    id: record.id,
    scope,
    kind: record.kind,
    semanticType: record.semanticType,
    lifecycleStatus: record.lifecycleStatus,
    text: record.text,
    contentHash: record.contentHash,
    importance: record.importance,
    category: record.category,
    dataType: record.dataType,
    tableName: record.tableName ?? "memories",
    metadata: record.metadata,
    provenance: record.provenance,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    hotness: record.hotness,
    sourceNodeIds: record.sourceNodeIds,
    confidence: record.confidence,
  }, new Set());
  if (!canonical) throw new Error("atomic memory write record is not serializable");
  return createHash("sha256").update(canonical).digest("hex");
}

function decodeAtomicStoreResult(value: unknown): AtomicMemoryStoreResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("atomic memory write receipt result is invalid");
  }
  const result = value as Record<string, unknown>;
  if (Reflect.ownKeys(result).length !== 2 ||
      typeof result.id !== "string" || result.id.length === 0 ||
      typeof result.stored !== "boolean") {
    throw new Error("atomic memory write receipt result is invalid");
  }
  return Object.freeze({ id: result.id, stored: result.stored });
}

function eventId(storageKey: string, memoryId: string): string {
  return createHash("sha256")
    .update(`memory.written.v1\0${storageKey}\0${memoryId}`)
    .digest("hex");
}

/**
 * Dedicated PoolClient transaction for the v11 write journal. The injected
 * insert function is provider-owned and must use the same client; pool.query or
 * a second repository transaction cannot satisfy this contract.
 */
export class PostgresAtomicMemoryStorePort implements ProviderOwnedAtomicMemoryStorePort {
  constructor(
    private readonly pool: PostgresMemoryWritePool,
    private readonly insert: PostgresMemoryWriteInsert,
    private readonly clock: () => number = Date.now,
  ) {
    if (!pool || typeof pool.connect !== "function" || typeof insert !== "function") {
      throw new Error("Postgres atomic memory write dependencies are required");
    }
    providerOwnedAtomicMemoryStorePorts.add(this);
  }

  async store(record: MemoryRecord): Promise<AtomicMemoryStoreResult> {
    const scope = normalizedAtomicScope(record.scope);
    const storageKey = atomicStoreStorageKey(scope, record.id);
    const fingerprint = atomicStoreFingerprint(record, scope);
    const client = await this.pool.connect();
    let begun = false;
    let committed = false;
    let result: AtomicMemoryStoreResult | undefined;
    let failure: unknown;
    let cleanupFailed = false;
    try {
      await client.query("BEGIN");
      begun = true;
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [storageKey]);
      const receipt = await client.query(
        `SELECT storage_key, tenant_id, user_id, request_fingerprint, result
FROM mengshu_write_receipts
WHERE storage_key = $1`,
        [storageKey],
      );
      if (receipt.rows.length > 1 || (receipt.rowCount ?? receipt.rows.length) !== receipt.rows.length) {
        throw new Error("atomic memory write receipt query is inconsistent");
      }
      if (receipt.rows.length === 1) {
        const row = receipt.rows[0]!;
        if (row.storage_key !== storageKey || row.tenant_id !== scope.tenantId ||
            row.user_id !== scope.userId || row.request_fingerprint !== fingerprint) {
          throw new Error("atomic memory write idempotency conflict");
        }
        result = decodeAtomicStoreResult(row.result);
      } else {
        const inserted = await this.insert(client, { ...record, scope });
        if (inserted.requestedId !== record.id ||
            typeof inserted.persistedId !== "string" || inserted.persistedId.length === 0 ||
            typeof inserted.stored !== "boolean") {
          throw new Error("atomic memory write provider result is invalid");
        }
        result = Object.freeze({ id: inserted.persistedId, stored: inserted.stored });
        const occurredAt = new Date(this.clock());
        if (!Number.isFinite(occurredAt.getTime())) {
          throw new Error("atomic memory write clock is invalid");
        }
        if (inserted.stored) {
          const scopeParams = [
            scope.tenantId, scope.userId, scope.projectId, scope.appId,
            scope.agentId, scope.namespace, scope.visibility,
            scope.workspaceId, scope.sessionId,
          ];
          await client.query(
            `INSERT INTO mengshu_write_audit (
  storage_key, memory_id, action, tenant_id, user_id, canonical_project_id,
  product_id, producer_id, namespace, visibility, workspace_id, session_id, occurred_at
) VALUES ($1, $2, 'memory.store', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [storageKey, inserted.persistedId, ...scopeParams, occurredAt],
          );
          await client.query(
            `INSERT INTO mengshu_write_outbox (
  event_id, storage_key, topic, memory_id, tenant_id, user_id, canonical_project_id,
  product_id, producer_id, namespace, visibility, workspace_id, session_id, occurred_at
) VALUES ($1, $2, 'memory.written', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
            [eventId(storageKey, inserted.persistedId), storageKey, inserted.persistedId,
              ...scopeParams, occurredAt],
          );
        }
        await client.query(
          `INSERT INTO mengshu_write_receipts (
  storage_key, tenant_id, user_id, request_fingerprint, result
) VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [storageKey, scope.tenantId, scope.userId, fingerprint, JSON.stringify(result)],
        );
      }
      await client.query("COMMIT");
      committed = true;
    } catch (error) {
      failure = error;
      if (begun && !committed) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          failure = new AggregateError(
            [error, rollbackError],
            "Postgres atomic memory write and rollback both failed",
          );
        }
      }
      throw failure;
    } finally {
      try {
        client.release();
      } catch (releaseError) {
        if (!failure && committed) cleanupFailed = true;
      }
    }
    if (!result || !committed) {
      throw new Error("Postgres atomic memory write completion is unavailable");
    }
    return cleanupFailed ? { ...result, cleanupFailed: true } : result;
  }
}

function clonePersistedResult(
  result: Extract<MemoryWriteKernelResult, { status: "persisted" }>,
): Extract<MemoryWriteKernelResult, { status: "persisted" }> {
  const canonical = canonicalJsonValue(result, new Set());
  if (!canonical) throw new Error("write acknowledgement must be JSON serializable");
  const cloned = JSON.parse(canonical) as Record<string, unknown>;
  const route = cloned.route;
  const correctionKind = cloned.correctionKind;
  if (
    cloned.status !== "persisted" ||
    typeof cloned.memoryId !== "string" || cloned.memoryId.length === 0 ||
    !(
      (typeof route === "string" && ROUTES.has(route) && correctionKind === undefined) ||
      (typeof correctionKind === "string" && LIFECYCLE_CORRECTIONS.has(correctionKind) && route === undefined)
    )
  ) {
    throw new Error("write acknowledgement has an invalid durable result shape");
  }
  return cloned as Extract<MemoryWriteKernelResult, { status: "persisted" }>;
}

export function createMemoryWriteReceipt(
  identity: WriteIdempotencyIdentity,
  requestFingerprint: string,
  result: Extract<MemoryWriteKernelResult, { status: "persisted" }>,
): MemoryWriteReceipt {
  if (!SHA256.test(requestFingerprint)) {
    throw new Error("write receipt fingerprint is invalid");
  }
  return Object.freeze({
    identity: Object.freeze({ ...identity }),
    requestFingerprint,
    result: Object.freeze(clonePersistedResult(result)),
  });
}

export function validateMemoryWriteReceipt(
  receipt: MemoryWriteReceipt,
  expectedIdentity: WriteIdempotencyIdentity,
): MemoryWriteReceipt {
  if (
    receipt.identity.tenantId !== expectedIdentity.tenantId ||
    receipt.identity.userId !== expectedIdentity.userId ||
    receipt.identity.clientKey !== expectedIdentity.clientKey ||
    receipt.identity.storageKey !== expectedIdentity.storageKey
  ) {
    throw new Error("write receipt idempotency identity mismatch");
  }
  return createMemoryWriteReceipt(
    expectedIdentity,
    receipt.requestFingerprint,
    receipt.result,
  );
}

function commandPayload(command: MemoryWriteCommand): Record<string, unknown> {
  const common: Record<string, unknown> = {
    type: command.type,
    metadata: command.metadata ?? {},
  };
  if ("text" in command) {
    common.text = command.text;
    common.vector = command.vector;
  }
  if (command.type === "observeAuto") common.intent = command.intent;
  if (command.type === "importEvidence") common.sourceId = command.sourceId;
  if (command.type === "correctMemory") {
    common.correctionKind = command.correctionKind;
    common.targetId = command.targetId;
  }
  return common;
}

export function createWriteCommandFingerprint(
  scope: WriteScope,
  command: MemoryWriteCommand,
): string {
  const canonical = canonicalJsonValue({
    scope: {
      tenantId: scope.tenantId,
      userId: scope.userId,
      appId: scope.appId,
      projectId: scope.projectId,
      agentId: scope.agentId,
      namespace: scope.namespace,
      visibility: scope.visibility ?? "private",
    },
    command: commandPayload(command),
  }, new Set());
  if (!canonical) throw new Error("write command must be JSON serializable");
  return createHash("sha256").update(canonical).digest("hex");
}
