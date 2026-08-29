import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import {
  createMarkdownWorksetRecord,
  markdownWorksetSnapshotSha256,
  type MarkdownWorksetNativeRecord,
  type MarkdownWorksetSourceTable,
} from "../packages/core/src/db/migrations/markdown-workset.js";
import type {
  MarkdownWorksetBeforeImageReceipt,
  MarkdownWorksetImportActivationPort,
  MarkdownWorksetImportActivationReceipt,
  MarkdownWorksetImportCounts,
  MarkdownWorksetImportPlan,
  MarkdownWorksetImportReceipt,
  MarkdownWorksetImportReceiptKind,
  MarkdownWorksetImportRollbackReceipt,
  MarkdownWorksetImportSnapshot,
  MarkdownWorksetImportTransaction,
  MarkdownWorksetStageReceipt,
} from "../packages/core/src/db/migrations/markdown-workset-importer.js";
import { decodePostgresMarkdownWorksetRow } from "./operator-markdown-workset.js";

export interface PostgresMarkdownWorksetImportQueryResult {
  readonly rows: readonly unknown[];
  readonly rowCount?: number | null;
}

export interface PostgresMarkdownWorksetImportPoolClient {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresMarkdownWorksetImportQueryResult>;
  release(): void;
}

export interface PostgresMarkdownWorksetImportPool {
  connect(): Promise<PostgresMarkdownWorksetImportPoolClient>;
}

export interface PostgresMarkdownWorksetImportOptions {
  readonly sourceManifestHash: string;
  readonly sourceSnapshotHash: string;
  readonly clock?: () => number;
}

export type PostgresMarkdownWorksetImportErrorCode =
  | "POSTGRES_MARKDOWN_IMPORT_INVALID_INPUT"
  | "POSTGRES_MARKDOWN_IMPORT_CONTEXT_REQUIRED"
  | "POSTGRES_MARKDOWN_IMPORT_LEDGER_MISMATCH"
  | "POSTGRES_MARKDOWN_IMPORT_SNAPSHOT_DRIFT"
  | "POSTGRES_MARKDOWN_IMPORT_COUNT_MISMATCH"
  | "POSTGRES_MARKDOWN_IMPORT_HASH_MISMATCH"
  | "POSTGRES_MARKDOWN_IMPORT_RECEIPT_MISMATCH";

const ERROR_MESSAGES: Record<PostgresMarkdownWorksetImportErrorCode, string> = {
  POSTGRES_MARKDOWN_IMPORT_INVALID_INPUT: "Postgres Markdown workset import input is invalid",
  POSTGRES_MARKDOWN_IMPORT_CONTEXT_REQUIRED: "Postgres Markdown workset transaction context is required",
  POSTGRES_MARKDOWN_IMPORT_LEDGER_MISMATCH: "Postgres Markdown workset ledger does not match the plan",
  POSTGRES_MARKDOWN_IMPORT_SNAPSHOT_DRIFT: "Postgres Markdown workset snapshot drifted",
  POSTGRES_MARKDOWN_IMPORT_COUNT_MISMATCH: "Postgres Markdown workset row count does not match",
  POSTGRES_MARKDOWN_IMPORT_HASH_MISMATCH: "Postgres Markdown workset row hash does not match",
  POSTGRES_MARKDOWN_IMPORT_RECEIPT_MISMATCH: "Postgres Markdown workset receipt does not match",
};

export class PostgresMarkdownWorksetImportError extends Error {
  constructor(readonly code: PostgresMarkdownWorksetImportErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "PostgresMarkdownWorksetImportError";
  }
}

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_RUN_ID = /^[^\s\p{Cc}]{1,256}$/u;
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

const RUN_LOCK_SQL = `/* markdown-workset-import:run-lock */
SELECT pg_advisory_xact_lock(hashtextextended(concat_ws(chr(31),
  'mengshu-markdown-workset-import', $1), 0)) AS locked`;

const RECEIPT_READ_SQL = `/* markdown-workset-import:receipt-read */
SELECT activation_id, run_id, operation, request_hash, source_manifest_sha256,
  governed_manifest_sha256, verification_sha256, before_snapshot_sha256,
  after_snapshot_sha256, confirmation_hash, result, created_at::text
FROM mengshu_markdown_migration_activation_receipts
WHERE run_id = $1 AND operation = $2`;

const READ_MEMORIES_SQL = `/* markdown-workset-import:read-memories */
SELECT to_jsonb(memories) AS row_payload
FROM memories
ORDER BY id::text COLLATE "C" ASC`;

const READ_KNOWLEDGE_SQL = `/* markdown-workset-import:read-knowledge */
SELECT to_jsonb(knowledge) AS row_payload
FROM knowledge
ORDER BY id::text COLLATE "C" ASC`;

const RUN_INSERT_SQL = `/* markdown-workset-import:run-insert */
INSERT INTO mengshu_markdown_migration_runs (
  run_id, source_manifest_sha256, source_snapshot_sha256,
  governed_manifest_sha256, governed_snapshot_sha256, verification_sha256,
  policy_version, status, source_count, mapped_count, staged_live_count,
  prepared_at, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, 'staging', $8, $9, $10, $11, $11)
ON CONFLICT (run_id) DO NOTHING
RETURNING run_id`;

const RUN_READ_SQL = `/* markdown-workset-import:run-read */
SELECT run_id, source_manifest_sha256, source_snapshot_sha256,
  governed_manifest_sha256, governed_snapshot_sha256, verification_sha256,
  policy_version, status, source_count::text, mapped_count::text,
  staged_live_count::text, prepared_at::text, updated_at::text
FROM mengshu_markdown_migration_runs
WHERE run_id = $1
FOR UPDATE`;

const BEFORE_INSERT_SQL = `/* markdown-workset-import:before-insert */
INSERT INTO mengshu_markdown_migration_before_rows (
  run_id, source_table, record_id, row_sha256, row_payload, captured_at
) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
ON CONFLICT (run_id, source_table, record_id) DO NOTHING
RETURNING record_id`;

const BEFORE_READ_SQL = `/* markdown-workset-import:before-read */
SELECT run_id, source_table, record_id, row_sha256, row_payload, captured_at::text
FROM mengshu_markdown_migration_before_rows
WHERE run_id = $1
ORDER BY source_table COLLATE "C", record_id COLLATE "C"`;

const STAGE_INSERT_SQL = `/* markdown-workset-import:stage-insert */
INSERT INTO mengshu_markdown_migration_staged_rows (
  run_id, source_table, record_id, source_ref, source_hash,
  row_sha256, row_payload, created_at
) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
ON CONFLICT (run_id, source_table, record_id) DO NOTHING
RETURNING source_ref`;

const MAPPING_INSERT_SQL = `/* markdown-workset-import:mapping-insert */
INSERT INTO mengshu_markdown_migration_mappings (
  run_id, source_ref, source_hash, scope_fingerprint, disposition,
  canonical_target_ref, reason_code, mapping_sha256, created_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (run_id, source_ref) DO NOTHING
RETURNING source_ref`;

const STAGE_READ_SQL = `/* markdown-workset-import:stage-read */
SELECT source_table, record_id, source_ref, source_hash, row_sha256, row_payload
FROM mengshu_markdown_migration_staged_rows
WHERE run_id = $1
ORDER BY source_ref COLLATE "C"`;

const MAPPING_READ_SQL = `/* markdown-workset-import:mapping-read */
SELECT source_ref, source_hash, disposition, mapping_sha256
FROM mengshu_markdown_migration_mappings
WHERE run_id = $1
ORDER BY source_ref COLLATE "C"`;

const RUN_VERIFIED_SQL = `/* markdown-workset-import:run-verified */
UPDATE mengshu_markdown_migration_runs
SET status = 'verified', mapped_count = $2, staged_live_count = $3, updated_at = $4
WHERE run_id = $1 AND status IN ('staging', 'verified')
  AND governed_manifest_sha256 = $5 AND verification_sha256 = $6
RETURNING run_id`;

const TABLE_LOCK_SQL = `/* markdown-workset-import:table-lock */
LOCK TABLE memories, knowledge IN ACCESS EXCLUSIVE MODE`;
const DELETE_MEMORIES_SQL = `/* markdown-workset-import:delete-memories */
DELETE FROM memories`;
const DELETE_KNOWLEDGE_SQL = `/* markdown-workset-import:delete-knowledge */
DELETE FROM knowledge`;

const INSERT_COLUMNS = `id, text, content_hash, vector, importance, category, data_type,
  metadata, created_at, project_name, app_name, user_id, agent_id, workspace_id,
  tenant_id, canonical_project_id, product_id, producer_id, namespace,
  visibility, lifecycle_status, embedding_space_id, embedding_space_state,
  legacy_quarantine_reason, scope_key`;
const INSERT_VALUES = `$1, $2, $3, $4::vector, $5, $6, $7, $8::jsonb, $9::timestamptz,
  $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24,
  $25`;
const INSERT_MEMORIES_SQL = `/* markdown-workset-import:insert-memories */
INSERT INTO memories (${INSERT_COLUMNS}) VALUES (${INSERT_VALUES})
RETURNING id::text AS id`;
const INSERT_KNOWLEDGE_SQL = `/* markdown-workset-import:insert-knowledge */
INSERT INTO knowledge (${INSERT_COLUMNS}) VALUES (${INSERT_VALUES})
RETURNING id::text AS id`;

const RECEIPT_INSERT_SQL = `/* markdown-workset-import:receipt-insert */
INSERT INTO mengshu_markdown_migration_activation_receipts (
  activation_id, run_id, operation, request_hash, source_manifest_sha256,
  governed_manifest_sha256, verification_sha256, before_snapshot_sha256,
  after_snapshot_sha256, confirmation_hash, result, created_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
ON CONFLICT DO NOTHING
RETURNING activation_id, run_id, operation, request_hash, source_manifest_sha256,
  governed_manifest_sha256, verification_sha256, before_snapshot_sha256,
  after_snapshot_sha256, confirmation_hash, result, created_at::text`;

const RUN_ACTIVATED_SQL = `/* markdown-workset-import:run-activated */
UPDATE mengshu_markdown_migration_runs
SET status = 'activated', activated_at = $2, updated_at = $2
WHERE run_id = $1 AND status = 'verified'
RETURNING run_id`;
const RUN_ROLLED_BACK_SQL = `/* markdown-workset-import:run-rolled-back */
UPDATE mengshu_markdown_migration_runs
SET status = 'rolled_back', rolled_back_at = $2, updated_at = $2
WHERE run_id = $1 AND status = 'activated'
RETURNING run_id`;

function fail(code: PostgresMarkdownWorksetImportErrorCode): never {
  throw new PostgresMarkdownWorksetImportError(code);
}

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stableValue(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("POSTGRES_MARKDOWN_IMPORT_INVALID_INPUT");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (nodeUtilTypes.isProxy(value) || seen.has(value)) fail("POSTGRES_MARKDOWN_IMPORT_INVALID_INPUT");
    seen.add(value);
    const result = value.map((item) => stableValue(item, seen));
    seen.delete(value);
    return result;
  }
  if (!plainRecord(value) || seen.has(value)) fail("POSTGRES_MARKDOWN_IMPORT_INVALID_INPUT");
  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item === undefined || typeof item === "function" || typeof item === "symbol" ||
        typeof item === "bigint") fail("POSTGRES_MARKDOWN_IMPORT_INVALID_INPUT");
    result[key] = stableValue(item, seen);
  }
  seen.delete(value);
  return result;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function hash(domain: string, value: unknown): string {
  return createHash("sha256").update(`${domain}\u001f${stableJson(value)}`, "utf8").digest("hex");
}

function textHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function exactCount(result: PostgresMarkdownWorksetImportQueryResult, expected: number): void {
  if (result.rowCount !== expected || result.rows.length !== expected) {
    fail("POSTGRES_MARKDOWN_IMPORT_COUNT_MISMATCH");
  }
}

function safeInteger(value: unknown): number {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(text)) {
    fail("POSTGRES_MARKDOWN_IMPORT_LEDGER_MISMATCH");
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) fail("POSTGRES_MARKDOWN_IMPORT_LEDGER_MISMATCH");
  return parsed;
}

function sourceTableAndId(sourceRef: string): { table: MarkdownWorksetSourceTable; id: string } {
  const separator = sourceRef.indexOf(":");
  const table = sourceRef.slice(0, separator);
  const id = sourceRef.slice(separator + 1);
  if (separator < 1 || id.length === 0 || (table !== "memories" && table !== "knowledge")) {
    fail("POSTGRES_MARKDOWN_IMPORT_INVALID_INPUT");
  }
  return { table, id };
}

function databasePayload(record: MarkdownWorksetNativeRecord): Readonly<Record<string, unknown>> {
  return Object.freeze({
    id: record.id,
    text: record.text,
    content_hash: record.contentHash,
    vector: `[${record.vector.join(",")}]`,
    importance: record.importance,
    category: record.category,
    data_type: record.dataType,
    metadata: stableValue(record.metadata),
    created_at: record.createdAt,
    project_name: record.projectName ?? null,
    app_name: record.appName ?? null,
    user_id: record.userId ?? null,
    agent_id: record.agentId ?? null,
    workspace_id: record.workspaceId ?? null,
    tenant_id: record.tenantId ?? null,
    canonical_project_id: record.canonicalProjectId ?? null,
    product_id: record.productId ?? null,
    producer_id: record.producerId ?? null,
    namespace: record.namespace ?? null,
    visibility: record.visibility ?? null,
    lifecycle_status: record.lifecycleStatus ?? null,
    embedding_space_id: record.embeddingSpaceId ?? null,
    embedding_space_state: record.embeddingSpaceState ?? null,
    legacy_quarantine_reason: record.legacyQuarantineReason ?? null,
    scope_key: record.scopeKey ?? null,
  });
}

function insertParams(record: MarkdownWorksetNativeRecord): readonly unknown[] {
  const payload = databasePayload(record);
  return [
    payload.id, payload.text, payload.content_hash, payload.vector, payload.importance,
    payload.category, payload.data_type, JSON.stringify(payload.metadata), payload.created_at,
    payload.project_name, payload.app_name, payload.user_id, payload.agent_id,
    payload.workspace_id, payload.tenant_id, payload.canonical_project_id,
    payload.product_id, payload.producer_id, payload.namespace, payload.visibility,
    payload.lifecycle_status, payload.embedding_space_id, payload.embedding_space_state,
    payload.legacy_quarantine_reason, payload.scope_key,
  ];
}

interface RawRow {
  readonly sourceTable: MarkdownWorksetSourceTable;
  readonly id: string;
  readonly sourceRef: string;
  readonly sourceHash: string;
  readonly rowHash: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly record: MarkdownWorksetNativeRecord;
}

interface PendingBeforeImage {
  readonly runId: string;
  readonly rows: readonly RawRow[];
  readonly snapshot: MarkdownWorksetImportSnapshot;
  readonly beforeImageHash: string;
}

interface TransactionContext {
  readonly client: PostgresMarkdownWorksetImportPoolClient;
  readonly runId: string;
  inWork: boolean;
  rawRows?: readonly RawRow[];
  lastSnapshot?: MarkdownWorksetImportSnapshot;
  operationStartSnapshot?: MarkdownWorksetImportSnapshot;
  pendingBefore?: PendingBeforeImage;
  plan?: MarkdownWorksetImportPlan;
  activeActivation?: MarkdownWorksetImportActivationReceipt;
}

function decodePayload(sourceTable: MarkdownWorksetSourceTable, value: unknown): RawRow {
  if (!plainRecord(value)) fail("POSTGRES_MARKDOWN_IMPORT_LEDGER_MISMATCH");
  const vector = value.vector;
  const vectorText = typeof vector === "string"
    ? vector
    : Array.isArray(vector) ? JSON.stringify(vector) : undefined;
  if (!vectorText) fail("POSTGRES_MARKDOWN_IMPORT_LEDGER_MISMATCH");
  let decoded: ReturnType<typeof decodePostgresMarkdownWorksetRow>;
  try {
    decoded = decodePostgresMarkdownWorksetRow(sourceTable, { ...value, vector_text: vectorText });
  } catch {
    fail("POSTGRES_MARKDOWN_IMPORT_LEDGER_MISMATCH");
  }
  const workset = createMarkdownWorksetRecord({
    phase: "source",
    scopeFingerprint: decoded.scopeFingerprint,
    record: decoded.record,
  });
  return Object.freeze({
    sourceTable,
    id: decoded.record.id,
    sourceRef: workset.sourceRef,
    sourceHash: workset.sourceHash,
    rowHash: hash("mengshu.markdown-workset-postgres-row/v1", value),
    payload: Object.freeze(stableValue(value) as Readonly<Record<string, unknown>>),
    record: decoded.record,
  });
}

function snapshotForRows(rows: readonly RawRow[]): MarkdownWorksetImportSnapshot {
  const records = rows.map((row) => createMarkdownWorksetRecord({
    phase: "source",
    record: row.record,
  }));
  const count = rows.length;
  return Object.freeze({
    snapshotHash: markdownWorksetSnapshotSha256(records),
    counts: Object.freeze({ liveRows: count, mappings: count, archived: 0, quarantined: 0 }),
  });
}

function sameCounts(left: MarkdownWorksetImportCounts, right: MarkdownWorksetImportCounts): boolean {
  return left.liveRows === right.liveRows && left.mappings === right.mappings &&
    left.archived === right.archived && left.quarantined === right.quarantined;
}

function sameSnapshot(left: MarkdownWorksetImportSnapshot, right: MarkdownWorksetImportSnapshot): boolean {
  return left.snapshotHash === right.snapshotHash && sameCounts(left.counts, right.counts);
}

function beforeImageHash(rows: readonly RawRow[]): string {
  return hash("mengshu.markdown-workset-before-image/v1", rows.map((row) => ({
    sourceTable: row.sourceTable,
    recordId: row.id,
    rowHash: row.rowHash,
  })));
}

function receiptResult(value: unknown): MarkdownWorksetImportReceipt {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      fail("POSTGRES_MARKDOWN_IMPORT_RECEIPT_MISMATCH");
    }
  }
  if (!plainRecord(parsed) || (parsed.kind !== "activate" && parsed.kind !== "rollback")) {
    fail("POSTGRES_MARKDOWN_IMPORT_RECEIPT_MISMATCH");
  }
  return parsed as unknown as MarkdownWorksetImportReceipt;
}

function confirmationToken(
  receipt: MarkdownWorksetImportReceipt,
  beforeSnapshotHash: string,
): string {
  return receipt.kind === "activate"
    ? ["ACTIVATE_MARKDOWN_WORKSET", receipt.runId, receipt.manifestHash,
      receipt.verifyHash, beforeSnapshotHash].join(":")
    : ["ROLLBACK_MARKDOWN_WORKSET", receipt.runId, receipt.activationReceiptHash,
      receipt.manifestHash, receipt.verifyHash, beforeSnapshotHash].join(":");
}

export class PostgresMarkdownWorksetImportActivationPort
implements MarkdownWorksetImportActivationPort {
  private readonly storage = new AsyncLocalStorage<TransactionContext>();
  private readonly clock: () => number;

  constructor(
    private readonly pool: PostgresMarkdownWorksetImportPool,
    private readonly options: PostgresMarkdownWorksetImportOptions,
  ) {
    if (!pool || typeof pool.connect !== "function" || !plainRecord(options) ||
        !SHA256.test(options.sourceManifestHash) || !SHA256.test(options.sourceSnapshotHash) ||
        (options.clock !== undefined && typeof options.clock !== "function")) {
      fail("POSTGRES_MARKDOWN_IMPORT_INVALID_INPUT");
    }
    this.clock = options.clock ?? (() => Date.now());
  }

  private context(): TransactionContext {
    const context = this.storage.getStore();
    if (!context) fail("POSTGRES_MARKDOWN_IMPORT_CONTEXT_REQUIRED");
    return context;
  }

  async withRunLock<T>(runId: string, work: () => Promise<T>): Promise<T> {
    if (!SAFE_RUN_ID.test(runId) || typeof work !== "function" || this.storage.getStore()) {
      fail("POSTGRES_MARKDOWN_IMPORT_INVALID_INPUT");
    }
    const client = await this.pool.connect();
    let began = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      began = true;
      const lock = await client.query(RUN_LOCK_SQL, [runId]);
      exactCount(lock, 1);
      const context: TransactionContext = { client, runId, inWork: false };
      const result = await this.storage.run(context, work);
      await client.query("COMMIT");
      began = false;
      return result;
    } catch (error) {
      if (began) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the original fail-closed error.
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async readReceipt(
    kind: MarkdownWorksetImportReceiptKind,
    idempotencyKey: string,
  ): Promise<MarkdownWorksetImportReceipt | undefined> {
    if ((kind !== "activate" && kind !== "rollback") ||
        !SAFE_IDEMPOTENCY_KEY.test(idempotencyKey)) fail("POSTGRES_MARKDOWN_IMPORT_INVALID_INPUT");
    const context = this.context();
    const result = await context.client.query(RECEIPT_READ_SQL, [context.runId, kind]);
    if (result.rows.length > 1 || (result.rowCount ?? result.rows.length) !== result.rows.length) {
      fail("POSTGRES_MARKDOWN_IMPORT_COUNT_MISMATCH");
    }
    const found = result.rows[0];
    if (found) return this.decodeReceiptRow(found, kind);
    if (kind === "rollback") {
      const activation = await context.client.query(RECEIPT_READ_SQL, [context.runId, "activate"]);
      exactCount(activation, 1);
      const decoded = this.decodeReceiptRow(activation.rows[0], "activate");
      context.activeActivation = decoded as MarkdownWorksetImportActivationReceipt;
    }
    return undefined;
  }

  async transaction<T>(
    work: (transaction: MarkdownWorksetImportTransaction) => Promise<T>,
  ): Promise<T> {
    const context = this.context();
    if (context.inWork || typeof work !== "function") fail("POSTGRES_MARKDOWN_IMPORT_INVALID_INPUT");
    context.inWork = true;
    try {
      return await work(this.transactionPort(context));
    } finally {
      context.inWork = false;
    }
  }

  private transactionPort(context: TransactionContext): MarkdownWorksetImportTransaction {
    return {
      readCurrentSnapshot: () => this.readCurrentSnapshot(context),
      saveBeforeImage: (input) => this.saveBeforeImage(context, input),
      stagePlan: (plan) => this.stagePlan(context, plan),
      replaceFromStage: (input) => this.replaceFromStage(context, input),
      restoreBeforeImage: (input) => this.restoreBeforeImage(context, input),
      writeReceipt: (receipt) => this.writeReceipt(context, receipt),
    };
  }

  private async rawRows(context: TransactionContext): Promise<readonly RawRow[]> {
    const [memories, knowledge] = await Promise.all([
      context.client.query(READ_MEMORIES_SQL),
      context.client.query(READ_KNOWLEDGE_SQL),
    ]);
    const rows: RawRow[] = [];
    for (const [table, result] of [["memories", memories], ["knowledge", knowledge]] as const) {
      if ((result.rowCount ?? result.rows.length) !== result.rows.length) {
        fail("POSTGRES_MARKDOWN_IMPORT_COUNT_MISMATCH");
      }
      for (const raw of result.rows) {
        if (!plainRecord(raw) || !Object.prototype.hasOwnProperty.call(raw, "row_payload")) {
          fail("POSTGRES_MARKDOWN_IMPORT_LEDGER_MISMATCH");
        }
        rows.push(decodePayload(table, raw.row_payload));
      }
    }
    rows.sort((left, right) => left.sourceRef.localeCompare(right.sourceRef));
    if (new Set(rows.map((row) => row.sourceRef)).size !== rows.length) {
      fail("POSTGRES_MARKDOWN_IMPORT_LEDGER_MISMATCH");
    }
    return Object.freeze(rows);
  }

  private async readCurrentSnapshot(
    context: TransactionContext,
  ): Promise<MarkdownWorksetImportSnapshot> {
    const rows = await this.rawRows(context);
    let snapshot = snapshotForRows(rows);
    if (context.activeActivation) {
      await this.verifyRowsAgainstStoredStage(context, rows);
      snapshot = context.activeActivation.afterSnapshot;
    }
    context.rawRows = rows;
    context.lastSnapshot = snapshot;
    context.operationStartSnapshot ??= snapshot;
    return snapshot;
  }

  private async saveBeforeImage(
    context: TransactionContext,
    input: Readonly<{ runId: string; snapshot: MarkdownWorksetImportSnapshot }>,
  ): Promise<MarkdownWorksetBeforeImageReceipt> {
    if (input.runId !== context.runId || !context.rawRows || !context.lastSnapshot ||
        !sameSnapshot(input.snapshot, context.lastSnapshot)) {
      fail("POSTGRES_MARKDOWN_IMPORT_SNAPSHOT_DRIFT");
    }
    const receipt = Object.freeze({
      runId: input.runId,
      rows: context.rawRows,
      snapshot: input.snapshot,
      beforeImageHash: beforeImageHash(context.rawRows),
    });
    context.pendingBefore = receipt;
    return Object.freeze({ beforeImageHash: receipt.beforeImageHash, snapshot: receipt.snapshot });
  }

  private async stagePlan(
    context: TransactionContext,
    plan: MarkdownWorksetImportPlan,
  ): Promise<MarkdownWorksetStageReceipt> {
    if (plan.runId !== context.runId || plan.sourceSnapshotHash !== this.options.sourceSnapshotHash ||
        !context.pendingBefore) fail("POSTGRES_MARKDOWN_IMPORT_LEDGER_MISMATCH");
    const now = this.now();
    await context.client.query(RUN_INSERT_SQL, [
      plan.runId,
      this.options.sourceManifestHash,
      this.options.sourceSnapshotHash,
      plan.manifestHash,
      plan.sourceSnapshotHash,
      plan.verifyHash,
      plan.policyVersion,
      plan.counts.sourceTotal,
      plan.mappings.length,
      plan.liveRows.length,
      now,
    ]);
    await this.verifyRun(context, plan);
    await this.persistBeforeRows(context, context.pendingBefore, now);

    const expectedStages = new Map<string, string>();
    for (const row of plan.liveRows) {
      const identity = sourceTableAndId(row.targetRef);
      if (identity.table !== row.record.sourceTable || identity.id !== row.record.id ||
          row.sourceRef !== row.targetRef) fail("POSTGRES_MARKDOWN_IMPORT_LEDGER_MISMATCH");
      const payload = databasePayload(row.record);
      const rowHash = hash("mengshu.markdown-workset-staged-row/v1", payload);
      expectedStages.set(row.sourceRef, rowHash);
      await context.client.query(STAGE_INSERT_SQL, [
        plan.runId, identity.table, identity.id, row.sourceRef, row.sourceHash,
        rowHash, JSON.stringify(payload), now,
      ]);
    }
    const expectedMappings = new Map<string, string>();
    for (const mapping of plan.mappings) {
      const mappingHash = hash("mengshu.markdown-workset-mapping/v1", mapping);
      expectedMappings.set(mapping.sourceRef, mappingHash);
      await context.client.query(MAPPING_INSERT_SQL, [
        plan.runId, mapping.sourceRef, mapping.sourceHash, mapping.scopeFingerprint ?? null,
        mapping.disposition, mapping.canonicalTargetRef ?? null,
        `governed_${mapping.disposition}`, mappingHash, now,
      ]);
    }
    await this.verifyStageRows(context, plan, expectedStages, expectedMappings);
    const verified = await context.client.query(RUN_VERIFIED_SQL, [
      plan.runId, plan.mappings.length, plan.liveRows.length, now,
      plan.manifestHash, plan.verifyHash,
    ]);
    exactCount(verified, 1);
    context.plan = plan;
    return Object.freeze({
      stageHash: plan.stageHash,
      counts: Object.freeze({
        liveRows: plan.liveRows.length,
        mappings: plan.mappings.length,
        archived: plan.archiveLedger.length,
        quarantined: plan.quarantineLedger.length,
      }),
    });
  }

  private async verifyRun(context: TransactionContext, plan: MarkdownWorksetImportPlan): Promise<void> {
    const result = await context.client.query(RUN_READ_SQL, [plan.runId]);
    exactCount(result, 1);
    const row = result.rows[0];
    if (!plainRecord(row) || row.run_id !== plan.runId ||
        row.source_manifest_sha256 !== this.options.sourceManifestHash ||
        row.source_snapshot_sha256 !== this.options.sourceSnapshotHash ||
        row.governed_manifest_sha256 !== plan.manifestHash ||
        row.governed_snapshot_sha256 !== plan.sourceSnapshotHash ||
        row.verification_sha256 !== plan.verifyHash || row.policy_version !== plan.policyVersion ||
        safeInteger(row.source_count) !== plan.counts.sourceTotal ||
        safeInteger(row.mapped_count) !== plan.mappings.length ||
        safeInteger(row.staged_live_count) !== plan.liveRows.length ||
        (row.status !== "staging" && row.status !== "verified")) {
      fail("POSTGRES_MARKDOWN_IMPORT_LEDGER_MISMATCH");
    }
  }

  private async persistBeforeRows(
    context: TransactionContext,
    before: PendingBeforeImage,
    now: number,
  ): Promise<void> {
    for (const row of before.rows) {
      await context.client.query(BEFORE_INSERT_SQL, [
        before.runId, row.sourceTable, row.id, row.rowHash, JSON.stringify(row.payload), now,
      ]);
    }
    const stored = await context.client.query(BEFORE_READ_SQL, [before.runId]);
    if (stored.rows.length !== before.rows.length ||
        (stored.rowCount ?? stored.rows.length) !== before.rows.length) {
      fail("POSTGRES_MARKDOWN_IMPORT_COUNT_MISMATCH");
    }
    const expected = before.rows.map((row) => `${row.sourceTable}\0${row.id}\0${row.rowHash}`).sort();
    const actual = stored.rows.map((value) => {
      if (!plainRecord(value) || typeof value.source_table !== "string" ||
          typeof value.record_id !== "string" || typeof value.row_sha256 !== "string") {
        fail("POSTGRES_MARKDOWN_IMPORT_LEDGER_MISMATCH");
      }
      return `${value.source_table}\0${value.record_id}\0${value.row_sha256}`;
    }).sort();
    if (stableJson(actual) !== stableJson(expected)) fail("POSTGRES_MARKDOWN_IMPORT_HASH_MISMATCH");
  }

  private async verifyStageRows(
    context: TransactionContext,
    plan: MarkdownWorksetImportPlan,
    expectedStages: ReadonlyMap<string, string>,
    expectedMappings: ReadonlyMap<string, string>,
  ): Promise<void> {
    const [stages, mappings] = await Promise.all([
      context.client.query(STAGE_READ_SQL, [plan.runId]),
      context.client.query(MAPPING_READ_SQL, [plan.runId]),
    ]);
    if (stages.rows.length !== expectedStages.size || mappings.rows.length !== expectedMappings.size ||
        (stages.rowCount ?? stages.rows.length) !== expectedStages.size ||
        (mappings.rowCount ?? mappings.rows.length) !== expectedMappings.size) {
      fail("POSTGRES_MARKDOWN_IMPORT_COUNT_MISMATCH");
    }
    for (const row of stages.rows) {
      if (!plainRecord(row) || typeof row.source_ref !== "string" ||
          row.row_sha256 !== expectedStages.get(row.source_ref)) {
        fail("POSTGRES_MARKDOWN_IMPORT_HASH_MISMATCH");
      }
    }
    for (const row of mappings.rows) {
      if (!plainRecord(row) || typeof row.source_ref !== "string" ||
          row.mapping_sha256 !== expectedMappings.get(row.source_ref)) {
        fail("POSTGRES_MARKDOWN_IMPORT_HASH_MISMATCH");
      }
    }
  }

  private async replaceFromStage(
    context: TransactionContext,
    input: Readonly<{
      runId: string;
      expectedCurrentSnapshotHash: string;
      stageHash: string;
      expectedSnapshot: MarkdownWorksetImportSnapshot;
    }>,
  ): Promise<MarkdownWorksetImportSnapshot> {
    const plan = context.plan;
    if (!plan || input.runId !== context.runId || input.stageHash !== plan.stageHash ||
        !context.operationStartSnapshot ||
        context.operationStartSnapshot.snapshotHash !== input.expectedCurrentSnapshotHash) {
      fail("POSTGRES_MARKDOWN_IMPORT_SNAPSHOT_DRIFT");
    }
    await context.client.query(TABLE_LOCK_SQL);
    const lockedRows = await this.rawRows(context);
    const lockedSnapshot = snapshotForRows(lockedRows);
    if (!sameSnapshot(lockedSnapshot, context.operationStartSnapshot)) {
      fail("POSTGRES_MARKDOWN_IMPORT_SNAPSHOT_DRIFT");
    }
    await context.client.query(DELETE_MEMORIES_SQL);
    await context.client.query(DELETE_KNOWLEDGE_SQL);
    for (const row of plan.liveRows) await this.insertLiveRecord(context, row.record);
    const persisted = await this.rawRows(context);
    this.verifyRowsAgainstPlan(persisted, plan);
    context.rawRows = persisted;
    context.lastSnapshot = input.expectedSnapshot;
    return input.expectedSnapshot;
  }

  private async insertLiveRecord(
    context: TransactionContext,
    record: MarkdownWorksetNativeRecord,
  ): Promise<void> {
    const sql = record.sourceTable === "memories" ? INSERT_MEMORIES_SQL : INSERT_KNOWLEDGE_SQL;
    const result = await context.client.query(sql, insertParams(record));
    exactCount(result, 1);
    const returned = result.rows[0];
    if (!plainRecord(returned) || returned.id !== record.id) {
      fail("POSTGRES_MARKDOWN_IMPORT_LEDGER_MISMATCH");
    }
  }

  private verifyRowsAgainstPlan(rows: readonly RawRow[], plan: MarkdownWorksetImportPlan): void {
    if (rows.length !== plan.liveRows.length) fail("POSTGRES_MARKDOWN_IMPORT_COUNT_MISMATCH");
    const expected = new Map(plan.liveRows.map((row) => [row.targetRef, row.sourceHash]));
    for (const row of rows) {
      if (expected.get(row.sourceRef) !== row.sourceHash) {
        fail("POSTGRES_MARKDOWN_IMPORT_HASH_MISMATCH");
      }
      expected.delete(row.sourceRef);
    }
    if (expected.size !== 0) fail("POSTGRES_MARKDOWN_IMPORT_COUNT_MISMATCH");
  }

  private async verifyRowsAgainstStoredStage(
    context: TransactionContext,
    rows: readonly RawRow[],
  ): Promise<void> {
    const result = await context.client.query(STAGE_READ_SQL, [context.runId]);
    if (result.rows.length !== rows.length || (result.rowCount ?? result.rows.length) !== rows.length) {
      fail("POSTGRES_MARKDOWN_IMPORT_COUNT_MISMATCH");
    }
    const expected = new Map<string, string>();
    for (const value of result.rows) {
      if (!plainRecord(value) || typeof value.source_ref !== "string" ||
          typeof value.source_hash !== "string") fail("POSTGRES_MARKDOWN_IMPORT_LEDGER_MISMATCH");
      expected.set(value.source_ref, value.source_hash);
    }
    for (const row of rows) {
      if (expected.get(row.sourceRef) !== row.sourceHash) {
        fail("POSTGRES_MARKDOWN_IMPORT_HASH_MISMATCH");
      }
      expected.delete(row.sourceRef);
    }
    if (expected.size !== 0) fail("POSTGRES_MARKDOWN_IMPORT_COUNT_MISMATCH");
  }

  private async restoreBeforeImage(
    context: TransactionContext,
    input: Readonly<{
      runId: string;
      beforeImageHash: string;
      expectedCurrentSnapshotHash: string;
      expectedRestoredSnapshot: MarkdownWorksetImportSnapshot;
    }>,
  ): Promise<MarkdownWorksetImportSnapshot> {
    if (input.runId !== context.runId || !context.activeActivation ||
        !context.operationStartSnapshot ||
        context.operationStartSnapshot.snapshotHash !== input.expectedCurrentSnapshotHash) {
      fail("POSTGRES_MARKDOWN_IMPORT_SNAPSHOT_DRIFT");
    }
    const stored = await context.client.query(BEFORE_READ_SQL, [context.runId]);
    const rows = stored.rows.map((value) => {
      if (!plainRecord(value) || (value.source_table !== "memories" && value.source_table !== "knowledge") ||
          typeof value.record_id !== "string" || typeof value.row_sha256 !== "string") {
        fail("POSTGRES_MARKDOWN_IMPORT_LEDGER_MISMATCH");
      }
      const row = decodePayload(value.source_table, value.row_payload);
      if (row.id !== value.record_id || row.rowHash !== value.row_sha256) {
        fail("POSTGRES_MARKDOWN_IMPORT_HASH_MISMATCH");
      }
      return row;
    }).sort((left, right) => left.sourceRef.localeCompare(right.sourceRef));
    if (beforeImageHash(rows) !== input.beforeImageHash) fail("POSTGRES_MARKDOWN_IMPORT_HASH_MISMATCH");

    await context.client.query(TABLE_LOCK_SQL);
    const lockedRows = await this.rawRows(context);
    await this.verifyRowsAgainstStoredStage(context, lockedRows);
    await context.client.query(DELETE_MEMORIES_SQL);
    await context.client.query(DELETE_KNOWLEDGE_SQL);
    for (const row of rows) await this.insertLiveRecord(context, row.record);
    const restoredRows = await this.rawRows(context);
    const restored = snapshotForRows(restoredRows);
    if (!sameSnapshot(restored, input.expectedRestoredSnapshot)) {
      fail("POSTGRES_MARKDOWN_IMPORT_SNAPSHOT_DRIFT");
    }
    context.rawRows = restoredRows;
    context.lastSnapshot = restored;
    return restored;
  }

  private async writeReceipt(
    context: TransactionContext,
    receipt: MarkdownWorksetImportReceipt,
  ): Promise<MarkdownWorksetImportReceipt> {
    if (receipt.runId !== context.runId || !context.operationStartSnapshot) {
      fail("POSTGRES_MARKDOWN_IMPORT_RECEIPT_MISMATCH");
    }
    const beforeSnapshot = receipt.kind === "activate"
      ? receipt.beforeSnapshot.snapshotHash
      : context.operationStartSnapshot.snapshotHash;
    const afterSnapshot = receipt.kind === "activate"
      ? receipt.afterSnapshot.snapshotHash
      : receipt.restoredSnapshot.snapshotHash;
    const confirmed = confirmationToken(receipt, beforeSnapshot);
    const createdAt = Date.parse(receipt.createdAt);
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
      fail("POSTGRES_MARKDOWN_IMPORT_RECEIPT_MISMATCH");
    }
    const inserted = await context.client.query(RECEIPT_INSERT_SQL, [
      receipt.receiptHash,
      receipt.runId,
      receipt.kind,
      receipt.requestHash,
      this.options.sourceManifestHash,
      receipt.manifestHash,
      receipt.verifyHash,
      beforeSnapshot,
      afterSnapshot,
      textHash(confirmed),
      JSON.stringify(receipt),
      createdAt,
    ]);
    exactCount(inserted, 1);
    const persisted = this.decodeReceiptRow(inserted.rows[0], receipt.kind);
    if (stableJson(persisted) !== stableJson(receipt)) {
      fail("POSTGRES_MARKDOWN_IMPORT_RECEIPT_MISMATCH");
    }
    const status = await context.client.query(
      receipt.kind === "activate" ? RUN_ACTIVATED_SQL : RUN_ROLLED_BACK_SQL,
      [receipt.runId, this.now()],
    );
    exactCount(status, 1);
    return persisted;
  }

  private decodeReceiptRow(
    value: unknown,
    expectedKind: MarkdownWorksetImportReceiptKind,
  ): MarkdownWorksetImportReceipt {
    if (!plainRecord(value) || value.run_id !== this.context().runId ||
        value.operation !== expectedKind || typeof value.request_hash !== "string" ||
        value.source_manifest_sha256 !== this.options.sourceManifestHash ||
        typeof value.governed_manifest_sha256 !== "string" ||
        typeof value.verification_sha256 !== "string" ||
        typeof value.before_snapshot_sha256 !== "string" ||
        typeof value.after_snapshot_sha256 !== "string" ||
        typeof value.confirmation_hash !== "string") {
      fail("POSTGRES_MARKDOWN_IMPORT_RECEIPT_MISMATCH");
    }
    const receipt = receiptResult(value.result);
    if (receipt.kind !== expectedKind || receipt.runId !== value.run_id ||
        receipt.requestHash !== value.request_hash ||
        receipt.manifestHash !== value.governed_manifest_sha256 ||
        receipt.verifyHash !== value.verification_sha256 ||
        receipt.receiptHash !== value.activation_id ||
        textHash(confirmationToken(receipt, value.before_snapshot_sha256)) !== value.confirmation_hash) {
      fail("POSTGRES_MARKDOWN_IMPORT_RECEIPT_MISMATCH");
    }
    const receiptBefore = receipt.kind === "activate"
      ? receipt.beforeSnapshot.snapshotHash
      : value.before_snapshot_sha256;
    const receiptAfter = receipt.kind === "activate"
      ? receipt.afterSnapshot.snapshotHash
      : receipt.restoredSnapshot.snapshotHash;
    if (receiptBefore !== value.before_snapshot_sha256 || receiptAfter !== value.after_snapshot_sha256) {
      fail("POSTGRES_MARKDOWN_IMPORT_RECEIPT_MISMATCH");
    }
    return receipt;
  }

  private now(): number {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0) fail("POSTGRES_MARKDOWN_IMPORT_INVALID_INPUT");
    return value;
  }
}
