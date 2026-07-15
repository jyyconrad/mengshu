import { createHash } from "node:crypto";
import type { DataType } from "../types.js";
import type { NormalizedProviderFilter } from "../../domain/provider-filter.js";
import type {
  AuthorityScopedForgetAction,
  AuthorityScopedForgetReceipt,
  AuthorityScopedForgetResult,
  ForgetAuditEvent,
  ForgetOutboxEvent,
  ForgetTargetSelection,
  ForgetTransactionContext,
  ForgetTransactionPort,
} from "../../domain/service-types.js";
import type {
  MemoryKind,
  MemoryLifecycleStatus,
  MemoryRecord,
  MemoryScope,
  MemorySemanticType,
  MemoryVisibility,
} from "../../domain/types.js";

export interface PostgresForgetQueryResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly rows: Row[];
  readonly rowCount?: number | null;
}

export interface PostgresForgetPoolClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresForgetQueryResult<Row>>;
  release(): void;
}

export interface PostgresForgetPool {
  connect(): Promise<PostgresForgetPoolClient>;
}

const postgresForgetTransactionPorts = new WeakSet<object>();

/** Runtime brand: plain objects with a transaction() method are not real ports. */
export function isPostgresForgetTransactionPort(
  value: unknown,
): value is PostgresForgetTransactionPort {
  return typeof value === "object" && value !== null && postgresForgetTransactionPorts.has(value);
}

const TABLES = {
  memories: '"memories"',
  knowledge: '"knowledge"',
} as const;

const FILTER_EXPRESSIONS = {
  tenantId: 'tenant_id',
  userId: 'user_id',
  id: 'id::text',
  contentHash: 'content_hash',
  appId: 'product_id',
  projectId: 'canonical_project_id',
  agentId: 'producer_id',
  namespace: 'namespace',
  visibility: 'visibility',
  category: 'category',
  kind: "metadata->>'kind'",
  semanticType: "metadata->>'semanticType'",
  lifecycleStatus: 'lifecycle_status',
  source: "metadata->>'source'",
  createdAt: 'created_at',
  importance: 'importance',
  pinned: "metadata->>'pinned'",
} as const;

const FILTER_ORDER = Object.keys(FILTER_EXPRESSIONS) as Array<keyof typeof FILTER_EXPRESSIONS>;
const ACTIONS = new Set<AuthorityScopedForgetAction>(["revoke", "archive", "delete"]);
const DATA_TYPES = new Set<DataType>(["memory", "document", "knowledge"]);
const VISIBILITIES = new Set<MemoryVisibility>(["private", "workspace", "team", "public"]);
const LIFECYCLE = new Set<MemoryLifecycleStatus>(["active", "archived", "revoked", "superseded", "promoted"]);
const KINDS = new Set<MemoryKind>([
  "preference", "decision", "entity", "fact", "task", "plan", "goal",
  "document", "knowledge", "observation", "other",
]);
const SEMANTIC_TYPES = new Set<MemorySemanticType>([
  "profile", "task_context", "rules", "experience", "resource",
]);
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SHA256 = /^[a-f0-9]{64}$/;

interface LockedTarget {
  readonly tableName: keyof typeof TABLES;
  readonly scope: MemoryScope;
}

function tableIdentifier(tableName: unknown): string {
  if (tableName !== "memories" && tableName !== "knowledge") {
    throw new Error("Postgres forget selection contains an unsupported table");
  }
  return TABLES[tableName];
}

function requiredString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Postgres forget row has invalid ${key}`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function decodeTimestamp(value: unknown): number {
  const timestamp = value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? value
      : typeof value === "string"
        ? Date.parse(value)
        : Number.NaN;
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new Error("Postgres forget row has invalid created_at");
  }
  return timestamp;
}

function decodeMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Postgres forget row has invalid metadata");
  }
  return { ...(value as Record<string, unknown>) };
}

function inferKind(dataType: DataType, category: string, metadata: Record<string, unknown>): MemoryKind {
  if (typeof metadata.kind === "string" && KINDS.has(metadata.kind as MemoryKind)) {
    return metadata.kind as MemoryKind;
  }
  if (dataType === "document") return "document";
  if (dataType === "knowledge") return "knowledge";
  return KINDS.has(category as MemoryKind) ? category as MemoryKind : "other";
}

function decodeRow(
  row: Record<string, unknown>,
  tableName: keyof typeof TABLES,
): MemoryRecord {
  const dataType = requiredString(row, "data_type") as DataType;
  if (!DATA_TYPES.has(dataType)) throw new Error("Postgres forget row has invalid data_type");
  const visibility = requiredString(row, "visibility") as MemoryVisibility;
  if (!VISIBILITIES.has(visibility)) throw new Error("Postgres forget row has invalid visibility");
  const metadata = decodeMetadata(row.metadata);
  const category = requiredString(row, "category");
  const lifecycle = optionalString(row.lifecycle_status) ?? optionalString(metadata.lifecycleStatus);
  if (lifecycle && !LIFECYCLE.has(lifecycle as MemoryLifecycleStatus)) {
    throw new Error("Postgres forget row has invalid lifecycle_status");
  }
  const semanticType = optionalString(metadata.semanticType);
  const importance = typeof row.importance === "number" ? row.importance : Number(row.importance);
  if (!Number.isFinite(importance) || importance < 0 || importance > 1) {
    throw new Error("Postgres forget row has invalid importance");
  }

  const scope: MemoryScope = {
    tenantId: requiredString(row, "tenant_id"),
    userId: requiredString(row, "user_id"),
    appId: requiredString(row, "product_id"),
    projectId: requiredString(row, "canonical_project_id"),
    agentId: requiredString(row, "producer_id"),
    namespace: requiredString(row, "namespace"),
    visibility,
  };
  const createdAt = decodeTimestamp(row.created_at);
  return {
    id: requiredString(row, "id"),
    scope,
    kind: inferKind(dataType, category, metadata),
    semanticType: semanticType && SEMANTIC_TYPES.has(semanticType as MemorySemanticType)
      ? semanticType as MemorySemanticType
      : undefined,
    lifecycleStatus: lifecycle as MemoryLifecycleStatus | undefined,
    text: requiredString(row, "text"),
    contentHash: requiredString(row, "content_hash"),
    importance,
    category: category as MemoryRecord["category"],
    dataType,
    tableName,
    metadata,
    provenance: {
      source: optionalString(metadata.source),
      sessionId: optionalString(metadata.sessionId),
      conversationId: optionalString(metadata.conversationId),
      messageId: optionalString(metadata.messageId),
      filePath: optionalString(metadata.filePath),
      createdAt,
    },
    createdAt,
    updatedAt: typeof metadata.updatedAt === "number" ? metadata.updatedAt : undefined,
  };
}

function sameScope(left: MemoryScope, right: MemoryScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.userId === right.userId &&
    left.appId === right.appId &&
    left.projectId === right.projectId &&
    left.agentId === right.agentId &&
    left.namespace === right.namespace &&
    (left.visibility ?? "private") === (right.visibility ?? "private")
  );
}

function normalizedFilterForSelection(
  filter: NormalizedProviderFilter,
  selection: ForgetTargetSelection,
): void {
  if (
    filter.operation !== "delete" ||
    filter.tableName !== selection.tableName ||
    filter.dataTypes.length !== selection.dataTypes.length ||
    filter.dataTypes.some((value, index) => value !== selection.dataTypes[index])
  ) {
    throw new Error("Postgres forget selection is not normalized for delete");
  }
  const values = filter.filter;
  if (
    values.tenantId !== selection.scope.tenantId ||
    values.userId !== selection.scope.userId ||
    values.appId !== selection.scope.appId ||
    values.projectId !== selection.scope.projectId ||
    values.agentId !== selection.scope.agentId ||
    values.namespace !== selection.scope.namespace ||
    values.visibility !== (selection.scope.visibility ?? "private")
  ) {
    throw new Error("Postgres forget selection authority/scope mismatch");
  }
}

function sqlValue(key: keyof typeof FILTER_EXPRESSIONS, value: unknown): unknown {
  if (key === "createdAt") return new Date(value as number);
  if (key === "pinned") return String(value);
  return value;
}

function whereFragment(
  values: Readonly<Record<string, unknown>>,
  dataTypes: readonly DataType[],
  startIndex = 1,
): { sql: string; params: unknown[]; nextIndex: number } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let index = startIndex;
  for (const key of FILTER_ORDER) {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      conditions.push(`${FILTER_EXPRESSIONS[key]} = $${index}`);
      params.push(sqlValue(key, values[key]));
      index += 1;
    }
  }
  conditions.push(`data_type = ANY($${index}::text[])`);
  params.push([...dataTypes]);
  return { sql: conditions.join(" AND "), params, nextIndex: index + 1 };
}

function scopeWhere(scope: MemoryScope, startIndex: number): { sql: string; params: unknown[] } {
  return {
    sql: [
      `tenant_id = $${startIndex}`,
      `user_id = $${startIndex + 1}`,
      `product_id = $${startIndex + 2}`,
      `canonical_project_id = $${startIndex + 3}`,
      `producer_id = $${startIndex + 4}`,
      `namespace = $${startIndex + 5}`,
      `visibility = $${startIndex + 6}`,
    ].join(" AND "),
    params: [
      scope.tenantId,
      scope.userId,
      scope.appId,
      scope.projectId,
      scope.agentId,
      scope.namespace,
      scope.visibility ?? "private",
    ],
  };
}

function validateResult(value: unknown): AuthorityScopedForgetResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Postgres forget receipt result is invalid");
  }
  const result = value as Record<string, unknown>;
  if (
    typeof result.action !== "string" || !ACTIONS.has(result.action as AuthorityScopedForgetAction) ||
    !Number.isSafeInteger(result.affected) || (result.affected as number) < 0 ||
    !Number.isSafeInteger(result.deleted) || (result.deleted as number) < 0 ||
    !Array.isArray(result.affectedIds) || result.affectedIds.some((id) => typeof id !== "string") ||
    result.transactional !== true || typeof result.idempotentReplay !== "boolean"
  ) {
    throw new Error("Postgres forget receipt result is invalid");
  }
  return result as unknown as AuthorityScopedForgetResult;
}

function validateReceipt(receipt: AuthorityScopedForgetReceipt): AuthorityScopedForgetReceipt {
  if (
    !IDEMPOTENCY_KEY.test(receipt.idempotencyKey) ||
    !SHA256.test(receipt.requestFingerprint) ||
    typeof receipt.scope.tenantId !== "string" || receipt.scope.tenantId.length === 0 ||
    typeof receipt.scope.userId !== "string" || receipt.scope.userId.length === 0
  ) {
    throw new Error("Postgres forget receipt identity is invalid");
  }
  return { ...receipt, result: validateResult(receipt.result) };
}

/** DB 内部 identity；client key 永不直接占用全局 PK/advisory namespace。 */
export function postgresForgetStorageIdempotencyKey(
  scope: Pick<MemoryScope, "tenantId" | "userId">,
  clientIdempotencyKey: string,
): string {
  if (
    typeof scope.tenantId !== "string" || scope.tenantId.length === 0 ||
    typeof scope.userId !== "string" || scope.userId.length === 0 ||
    !IDEMPOTENCY_KEY.test(clientIdempotencyKey)
  ) {
    throw new Error("Postgres forget authority/idempotency namespace is invalid");
  }
  return createHash("sha256")
    .update(`${scope.tenantId}\0${scope.userId}\0${clientIdempotencyKey}`)
    .digest("hex");
}

function postgresForgetStorageEventId(event: ForgetOutboxEvent): string {
  const storageKey = postgresForgetStorageIdempotencyKey(event.scope, event.idempotencyKey);
  return createHash("sha256").update(`${storageKey}\0${event.eventId}`).digest("hex");
}

class PostgresForgetTransactionContext implements ForgetTransactionContext {
  private readonly locked = new Map<string, LockedTarget>();
  private selectionUsed = false;

  constructor(private readonly client: PostgresForgetPoolClient) {}

  async findTargets(selection: ForgetTargetSelection): Promise<MemoryRecord[]> {
    if (this.selectionUsed) throw new Error("Postgres forget findTargets may only be called once");
    this.selectionUsed = true;
    const table = tableIdentifier(selection.tableName);
    let filter: NormalizedProviderFilter;
    let ids: string[] | undefined;
    if (selection.kind === "ids") {
      if (selection.filters.length === 0) throw new Error("Postgres forget id selection is empty");
      for (const item of selection.filters) normalizedFilterForSelection(item, selection);
      filter = selection.filters[0]!;
      const base = { ...filter.filter } as Record<string, unknown>;
      delete base.id;
      ids = selection.filters.map((item) => String(item.filter.id));
      if (
        new Set(ids).size !== ids.length ||
        selection.filters.some((item) => {
          const comparison = { ...item.filter } as Record<string, unknown>;
          delete comparison.id;
          return JSON.stringify(comparison) !== JSON.stringify(base);
        })
      ) {
        throw new Error("Postgres forget id selection is inconsistent");
      }
      filter = { ...filter, filter: base as typeof filter.filter };
    } else {
      normalizedFilterForSelection(selection.filter, selection);
      filter = selection.filter;
    }

    const where = whereFragment(filter.filter, filter.dataTypes);
    if (ids) {
      where.sql += ` AND id::text = ANY($${where.nextIndex}::text[])`;
      where.params.push(ids);
    }
    const result = await this.client.query(
      `SELECT id::text AS id, text, content_hash, importance, category, data_type,
  metadata, created_at, tenant_id, user_id, product_id, canonical_project_id,
  producer_id, namespace, visibility, lifecycle_status
FROM ${table}
WHERE ${where.sql}
FOR UPDATE`,
      where.params,
    );
    const records = result.rows.map((item) => decodeRow(item, selection.tableName));
    for (const record of records) {
      if (!sameScope(record.scope, selection.scope)) {
        throw new Error("Postgres forget selected a record outside authority scope");
      }
      this.locked.set(record.id, { tableName: selection.tableName, scope: record.scope });
    }
    return records;
  }

  private lockedTarget(id: string): LockedTarget {
    const target = this.locked.get(id);
    if (!target) throw new Error("Postgres forget mutation requires findTargets locked records");
    return target;
  }

  async replace(records: readonly MemoryRecord[]): Promise<void> {
    for (const record of records) {
      const locked = this.lockedTarget(record.id);
      if (!sameScope(record.scope, locked.scope)) {
        throw new Error("Postgres forget replacement scope mismatch");
      }
      const table = tableIdentifier(locked.tableName);
      const scope = scopeWhere(locked.scope, 4);
      const result = await this.client.query(
        `UPDATE ${table}
SET metadata = $1::jsonb, lifecycle_status = $2
WHERE id::text = $3 AND ${scope.sql}`,
        [JSON.stringify(record.metadata), record.lifecycleStatus ?? null, record.id, ...scope.params],
      );
      if (result.rowCount !== 1) throw new Error("Postgres forget replacement lost locked record");
    }
  }

  async delete(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const targets = ids.map((id) => this.lockedTarget(id));
    const first = targets[0]!;
    if (targets.some((target) => target.tableName !== first.tableName || !sameScope(target.scope, first.scope))) {
      throw new Error("Postgres forget delete targets span multiple storage scopes");
    }
    const table = tableIdentifier(first.tableName);
    const scope = scopeWhere(first.scope, 2);
    const result = await this.client.query(
      `DELETE FROM ${table}
WHERE id::text = ANY($1::text[]) AND ${scope.sql}`,
      [[...ids], ...scope.params],
    );
    if (result.rowCount !== ids.length) throw new Error("Postgres forget delete lost locked record");
  }

  private assertEventTarget(targetId: string, scope: MemoryScope): void {
    const locked = this.lockedTarget(targetId);
    if (!sameScope(scope, locked.scope)) throw new Error("Postgres forget event scope mismatch");
  }

  async appendAudit(events: readonly ForgetAuditEvent[]): Promise<void> {
    for (const event of events) {
      this.assertEventTarget(event.targetId, event.scope);
      const storageKey = postgresForgetStorageIdempotencyKey(event.scope, event.idempotencyKey);
      await this.client.query(
        `INSERT INTO mengshu_forget_audit (
  idempotency_key, target_id, action, tenant_id, user_id, canonical_project_id,
  product_id, producer_id, namespace, visibility, actor, reason,
  before_state, after_state, occurred_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15)
ON CONFLICT (idempotency_key, target_id, action) DO NOTHING`,
        [
          storageKey, event.targetId, event.action,
          event.scope.tenantId, event.scope.userId, event.scope.projectId,
          event.scope.appId, event.scope.agentId, event.scope.namespace,
          event.scope.visibility ?? "private", event.actor ?? null, event.reason ?? null,
          event.before ? JSON.stringify(event.before) : null,
          event.after ? JSON.stringify(event.after) : null,
          new Date(event.at),
        ],
      );
    }
  }

  async appendOutbox(events: readonly ForgetOutboxEvent[]): Promise<void> {
    for (const event of events) {
      this.assertEventTarget(event.targetId, event.scope);
      const storageKey = postgresForgetStorageIdempotencyKey(event.scope, event.idempotencyKey);
      await this.client.query(
        `INSERT INTO mengshu_forget_outbox (
  event_id, idempotency_key, topic, action, target_id, tenant_id, user_id,
  canonical_project_id, product_id, producer_id, namespace, visibility, occurred_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
ON CONFLICT (event_id) DO NOTHING`,
        [
          postgresForgetStorageEventId(event), storageKey, event.topic, event.action, event.targetId,
          event.scope.tenantId, event.scope.userId, event.scope.projectId,
          event.scope.appId, event.scope.agentId, event.scope.namespace,
          event.scope.visibility ?? "private", new Date(event.occurredAt),
        ],
      );
    }
  }

  async getReceipt(
    scope: MemoryScope,
    idempotencyKey: string,
  ): Promise<AuthorityScopedForgetReceipt | undefined> {
    const storageKey = postgresForgetStorageIdempotencyKey(scope, idempotencyKey);
    await this.client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [storageKey],
    );
    const result = await this.client.query(
      `SELECT idempotency_key, request_fingerprint, result
FROM mengshu_forget_receipts
WHERE idempotency_key = $1`,
      [storageKey],
    );
    if (result.rows.length === 0) return undefined;
    if (result.rows.length !== 1) throw new Error("Postgres forget receipt returned multiple rows");
    const persisted = result.rows[0]!;
    if (requiredString(persisted, "idempotency_key") !== storageKey) {
      throw new Error("Postgres forget receipt storage identity mismatch");
    }
    return validateReceipt({
      idempotencyKey,
      scope,
      requestFingerprint: requiredString(persisted, "request_fingerprint"),
      result: validateResult(persisted.result),
    });
  }

  async saveReceipt(receipt: AuthorityScopedForgetReceipt): Promise<void> {
    const validated = validateReceipt(receipt);
    const storageKey = postgresForgetStorageIdempotencyKey(
      validated.scope,
      validated.idempotencyKey,
    );
    await this.client.query(
      `INSERT INTO mengshu_forget_receipts (idempotency_key, request_fingerprint, result)
VALUES ($1, $2, $3::jsonb)`,
      [storageKey, validated.requestFingerprint, JSON.stringify(validated.result)],
    );
  }
}

/** Dedicated PoolClient callback transaction；绝不使用 pool.query 模拟事务。 */
export class PostgresForgetTransactionPort implements ForgetTransactionPort {
  constructor(private readonly pool: PostgresForgetPool) {
    if (!pool || typeof pool.connect !== "function") {
      throw new Error("Postgres forget transaction pool is required");
    }
    postgresForgetTransactionPorts.add(this);
  }

  async transaction<T>(work: (transaction: ForgetTransactionContext) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let result: T | undefined;
    let failure: unknown;
    let begun = false;
    let committed = false;
    try {
      await client.query("BEGIN");
      begun = true;
      result = await work(new PostgresForgetTransactionContext(client));
      await client.query("COMMIT");
      committed = true;
    } catch (error) {
      failure = error;
      if (begun && !committed) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          failure = new AggregateError(
            [failure, rollbackError],
            "Postgres forget transaction and rollback both failed",
          );
        }
      }
    }

    try {
      client.release();
    } catch (releaseError) {
      failure = failure
        ? new AggregateError([failure, releaseError], "Postgres forget transaction and release both failed")
        : releaseError;
    }
    if (failure) throw failure;
    return result as T;
  }
}
