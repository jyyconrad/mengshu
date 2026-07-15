import { createHash } from "node:crypto";
import { scopeToKey } from "../../domain/scope.js";
import type { MemoryAutodbRegistry } from "../../runtime/registry.js";
import {
  planLegacyScopeBackfill,
  type ScopeBackfillPlan,
} from "./scope-backfill.js";

export type ScopeBackfillTable = "memories" | "knowledge";
export type ScopeBackfillMode = "dry-run" | "apply";

export interface PostgresScopeBackfillQueryResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly rows: Row[];
  readonly rowCount?: number | null;
}

/**
 * 调用方必须传 dedicated PostgreSQL client。apply 会在该 client 上逐批开启事务；
 * 本模块不持有 Pool，也不会接触 provider/runtime 生命周期。
 */
export interface PostgresScopeBackfillClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresScopeBackfillQueryResult<Row>>;
}

export interface ExecutePostgresScopeBackfillOptions {
  readonly table: ScopeBackfillTable;
  readonly registry: MemoryAutodbRegistry;
  /** 默认为 dry-run；apply 必须同时确认 maintenance 与 writer quiescence。 */
  readonly mode?: ScopeBackfillMode;
  readonly maintenance?: boolean;
  readonly quiescenceConfirmed?: boolean;
  readonly batchSize?: number;
}

export interface ExecutePostgresScopeBackfillResult {
  readonly mode: ScopeBackfillMode;
  readonly table: ScopeBackfillTable;
  readonly scanned: number;
  readonly resolved: number;
  readonly quarantined: number;
  readonly conflict: number;
  /** 预留给未来显式 no-op 策略；当前 pending 查询不会返回已处理行。 */
  readonly skipped: number;
  readonly batches: number;
}

export type ScopeBackfillExecutorErrorCode =
  | "SCOPE_BACKFILL_INVALID_OPTIONS"
  | "SCOPE_BACKFILL_MAINTENANCE_REQUIRED"
  | "SCOPE_BACKFILL_INVALID_DB_RESULT"
  | "SCOPE_BACKFILL_CONCURRENT_DRIFT"
  | "SCOPE_BACKFILL_DATABASE_FAILED"
  | "SCOPE_BACKFILL_ROLLBACK_FAILED";

const ERROR_MESSAGES: Record<ScopeBackfillExecutorErrorCode, string> = {
  SCOPE_BACKFILL_INVALID_OPTIONS: "Postgres scope backfill options are invalid",
  SCOPE_BACKFILL_MAINTENANCE_REQUIRED:
    "Postgres scope backfill apply requires maintenance mode and writer quiescence",
  SCOPE_BACKFILL_INVALID_DB_RESULT: "Postgres scope backfill database result is invalid",
  SCOPE_BACKFILL_CONCURRENT_DRIFT: "Postgres scope backfill detected concurrent row drift",
  SCOPE_BACKFILL_DATABASE_FAILED: "Postgres scope backfill database operation failed",
  SCOPE_BACKFILL_ROLLBACK_FAILED: "Postgres scope backfill rollback failed",
};

/** 固定 code/message，绝不把底层 SQL、metadata 或凭据拼进错误。 */
export class ScopeBackfillExecutorError extends Error {
  constructor(readonly code: ScopeBackfillExecutorErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ScopeBackfillExecutorError";
  }
}

interface BackfillRow {
  readonly id: string;
  readonly metadata: unknown;
  readonly provenance?: unknown;
}

interface MutableStats {
  scanned: number;
  resolved: number;
  quarantined: number;
  conflict: number;
  skipped: number;
  batches: number;
}

const TABLES = new Set<ScopeBackfillTable>(["memories", "knowledge"]);
const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 1_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JSONB_TYPES = new Set(["object", "array", "string", "number", "boolean", "null"]);

function executorError(code: ScopeBackfillExecutorErrorCode): never {
  throw new ScopeBackfillExecutorError(code);
}

function validateOptions(options: ExecutePostgresScopeBackfillOptions): {
  table: ScopeBackfillTable;
  mode: ScopeBackfillMode;
  batchSize: number;
} {
  const table = (options as { table?: unknown })?.table;
  const mode = (options as { mode?: unknown })?.mode ?? "dry-run";
  const batchSize = (options as { batchSize?: unknown })?.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!TABLES.has(table as ScopeBackfillTable) ||
      (mode !== "dry-run" && mode !== "apply") ||
      !Number.isInteger(batchSize) || Number(batchSize) < 1 || Number(batchSize) > MAX_BATCH_SIZE ||
      !options.registry || typeof options.registry !== "object") {
    executorError("SCOPE_BACKFILL_INVALID_OPTIONS");
  }
  if (mode === "apply" &&
      (options.maintenance !== true || options.quiescenceConfirmed !== true)) {
    executorError("SCOPE_BACKFILL_MAINTENANCE_REQUIRED");
  }
  return { table: table as ScopeBackfillTable, mode, batchSize: Number(batchSize) };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function runtimeJsonbType(value: unknown): string | null {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (isPlainRecord(value)) return "object";
  if (typeof value === "string") return "string";
  if (typeof value === "number" && Number.isFinite(value)) return "number";
  if (typeof value === "boolean") return "boolean";
  return null;
}

function validateRows(result: PostgresScopeBackfillQueryResult): BackfillRow[] {
  if (!Array.isArray(result.rows) || !Number.isInteger(result.rowCount) ||
      result.rowCount !== result.rows.length) {
    executorError("SCOPE_BACKFILL_INVALID_DB_RESULT");
  }
  const rows: BackfillRow[] = [];
  for (const row of result.rows) {
    if (!isPlainRecord(row) || typeof row.id !== "string" || !UUID.test(row.id) ||
        typeof row.metadata_type !== "string" || !JSONB_TYPES.has(row.metadata_type) ||
        runtimeJsonbType(row.metadata) !== row.metadata_type ||
        typeof row.provenance_present !== "boolean") {
      executorError("SCOPE_BACKFILL_INVALID_DB_RESULT");
    }
    if (row.provenance_present) {
      if (row.metadata_type !== "object" || typeof row.provenance_type !== "string" ||
          !JSONB_TYPES.has(row.provenance_type) ||
          runtimeJsonbType(row.provenance) !== row.provenance_type) {
        executorError("SCOPE_BACKFILL_INVALID_DB_RESULT");
      }
    } else if (row.provenance_type !== null || row.provenance !== null) {
      executorError("SCOPE_BACKFILL_INVALID_DB_RESULT");
    }
    rows.push({
      id: row.id,
      metadata: row.metadata,
      provenance: row.provenance_present ? row.provenance : undefined,
    });
  }
  return rows;
}

function assertStrictlyIncreasingRows(rows: readonly BackfillRow[], cursor: string | null): void {
  let previous = cursor;
  for (const row of rows) {
    if (previous !== null && row.id <= previous) {
      executorError("SCOPE_BACKFILL_INVALID_DB_RESULT");
    }
    previous = row.id;
  }
}

function countPlan(stats: MutableStats, plan: ScopeBackfillPlan): void {
  stats.scanned += 1;
  if (plan.status === "resolved") stats.resolved += 1;
  else if (plan.status === "conflict") stats.conflict += 1;
  else stats.quarantined += 1;
}

function auditHash(plan: ScopeBackfillPlan): string {
  return createHash("sha256")
    .update(`scope-backfill-audit-v1\0${JSON.stringify(plan.audit)}`)
    .digest("hex");
}

function auditMarker(plan: ScopeBackfillPlan): Record<string, unknown> {
  return {
    planVersion: plan.audit.planVersion,
    status: plan.status,
    targetPartition: plan.targetPartition,
    eligibility: plan.eligibility,
    reasonCodes: plan.status === "resolved" ? [] : plan.reasonCodes,
    auditHash: auditHash(plan),
    audit: plan.audit,
  };
}

function json(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) executorError("SCOPE_BACKFILL_INVALID_DB_RESULT");
    return serialized;
  } catch (error) {
    if (error instanceof ScopeBackfillExecutorError) throw error;
    executorError("SCOPE_BACKFILL_INVALID_DB_RESULT");
  }
}

function pendingSelectSql(table: ScopeBackfillTable, mode: ScopeBackfillMode): string {
  const base = `SELECT id::text AS id, metadata, jsonb_typeof(metadata) AS metadata_type, (jsonb_typeof(metadata) = 'object' AND metadata ? 'provenance') AS provenance_present, metadata->'provenance' AS provenance, jsonb_typeof(metadata->'provenance') AS provenance_type FROM "${table}" WHERE scope_key IS NULL AND legacy_quarantine_reason IS NULL`;
  return mode === "dry-run"
    ? `${base} AND ($1::uuid IS NULL OR id > $1::uuid) ORDER BY id ASC LIMIT $2`
    : `${base} ORDER BY id ASC LIMIT $1 FOR UPDATE NOWAIT`;
}

function remainingCountSql(table: ScopeBackfillTable): string {
  return `SELECT COUNT(*)::text AS remaining_count FROM "${table}" WHERE scope_key IS NULL AND legacy_quarantine_reason IS NULL`;
}

function resolvedUpdateSql(table: ScopeBackfillTable): string {
  return `UPDATE "${table}" AS target SET tenant_id = staged.tenant_id, user_id = staged.user_id, canonical_project_id = staged.canonical_project_id, product_id = staged.product_id, producer_id = staged.producer_id, namespace = staged.namespace, visibility = staged.visibility, app_name = staged.app_name, agent_id = staged.agent_id, workspace_id = staged.workspace_id, scope_key = staged.scope_key, metadata = target.metadata || staged.audit_patch FROM jsonb_to_recordset($1::jsonb) AS staged(id uuid, tenant_id text, user_id text, canonical_project_id text, product_id text, producer_id text, namespace text, visibility text, app_name text, agent_id text, workspace_id text, scope_key text, audit_patch jsonb, old_metadata jsonb) WHERE target.id = staged.id AND target.metadata IS NOT DISTINCT FROM staged.old_metadata AND target.scope_key IS NULL AND target.legacy_quarantine_reason IS NULL RETURNING target.id::text AS id`;
}

function quarantineUpdateSql(table: ScopeBackfillTable): string {
  return `UPDATE "${table}" AS target SET legacy_quarantine_reason = staged.quarantine_reason, metadata = target.metadata || staged.audit_patch FROM jsonb_to_recordset($1::jsonb) AS staged(id uuid, quarantine_reason text, audit_patch jsonb, old_metadata jsonb) WHERE target.id = staged.id AND target.metadata IS NOT DISTINCT FROM staged.old_metadata AND target.scope_key IS NULL AND target.legacy_quarantine_reason IS NULL RETURNING target.id::text AS id`;
}

function malformedMetadataUpdateSql(table: ScopeBackfillTable): string {
  return `UPDATE "${table}" AS target SET legacy_quarantine_reason = staged.quarantine_reason FROM jsonb_to_recordset($1::jsonb) AS staged(id uuid, quarantine_reason text, old_metadata jsonb) WHERE target.id = staged.id AND target.metadata IS NOT DISTINCT FROM staged.old_metadata AND target.scope_key IS NULL AND target.legacy_quarantine_reason IS NULL RETURNING target.id::text AS id`;
}

function assertBulkUpdatedRows(
  result: PostgresScopeBackfillQueryResult,
  expectedIds: readonly string[],
): void {
  if (!Array.isArray(result.rows) || !Number.isInteger(result.rowCount) ||
      result.rowCount !== result.rows.length) {
    executorError("SCOPE_BACKFILL_INVALID_DB_RESULT");
  }
  const actualIds: string[] = [];
  for (const row of result.rows) {
    if (!isPlainRecord(row) || typeof row.id !== "string" || !UUID.test(row.id)) {
      executorError("SCOPE_BACKFILL_INVALID_DB_RESULT");
    }
    actualIds.push(row.id);
  }
  const expected = new Set(expectedIds);
  const actual = new Set(actualIds);
  if (expected.size !== expectedIds.length || actual.size !== actualIds.length ||
      actualIds.length !== expectedIds.length ||
      actualIds.some((id) => !expected.has(id))) {
    executorError("SCOPE_BACKFILL_CONCURRENT_DRIFT");
  }
}

async function assertNoRemainingRows(
  client: PostgresScopeBackfillClient,
  table: ScopeBackfillTable,
): Promise<void> {
  const result = await client.query(remainingCountSql(table));
  if (result.rowCount !== 1 || !Array.isArray(result.rows) || result.rows.length !== 1 ||
      !isPlainRecord(result.rows[0]) ||
      typeof result.rows[0].remaining_count !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(result.rows[0].remaining_count)) {
    executorError("SCOPE_BACKFILL_INVALID_DB_RESULT");
  }
  if (result.rows[0].remaining_count !== "0") {
    executorError("SCOPE_BACKFILL_CONCURRENT_DRIFT");
  }
}

interface PlannedBackfillRow {
  readonly row: BackfillRow;
  readonly plan: ScopeBackfillPlan;
}

async function updateBatch(
  client: PostgresScopeBackfillClient,
  table: ScopeBackfillTable,
  planned: readonly PlannedBackfillRow[],
): Promise<void> {
  const resolved = planned.filter((item) => item.plan.status === "resolved");
  const malformed = planned.filter((item) =>
    item.plan.status !== "resolved" && item.plan.reasonCodes.includes("invalid-metadata-shape"));
  const quarantined = planned.filter((item) =>
    item.plan.status !== "resolved" && !item.plan.reasonCodes.includes("invalid-metadata-shape"));

  if (resolved.length > 0) {
    const payload = resolved.map(({ row, plan }) => {
      if (plan.status !== "resolved") executorError("SCOPE_BACKFILL_INVALID_DB_RESULT");
      return {
        id: row.id,
        tenant_id: plan.scope.tenantId,
        user_id: plan.scope.userId,
        canonical_project_id: plan.scope.projectId,
        product_id: plan.producer.productId,
        producer_id: plan.producer.producerId,
        namespace: plan.scope.namespace,
        visibility: plan.scope.visibility,
        app_name: plan.scope.appId,
        agent_id: plan.scope.agentId,
        workspace_id: plan.scope.workspaceId,
        scope_key: scopeToKey(plan.scope),
        audit_patch: {
          scope: plan.scope,
          producer: plan.producer,
          mengshuScopeBackfill: auditMarker(plan),
        },
        old_metadata: row.metadata,
      };
    });
    const result = await client.query(resolvedUpdateSql(table), [json(payload)]);
    assertBulkUpdatedRows(result, resolved.map(({ row }) => row.id));
  }

  if (quarantined.length > 0) {
    const payload = quarantined.map(({ row, plan }) => {
      if (plan.status === "resolved") executorError("SCOPE_BACKFILL_INVALID_DB_RESULT");
      return {
        id: row.id,
        quarantine_reason: plan.reasonCodes.join(","),
        audit_patch: { mengshuScopeBackfill: auditMarker(plan) },
        old_metadata: row.metadata,
      };
    });
    const result = await client.query(quarantineUpdateSql(table), [json(payload)]);
    assertBulkUpdatedRows(result, quarantined.map(({ row }) => row.id));
  }

  if (malformed.length > 0) {
    const payload = malformed.map(({ row }) => ({
      id: row.id,
      quarantine_reason: "invalid-metadata-shape",
      old_metadata: row.metadata,
    }));
    const result = await client.query(malformedMetadataUpdateSql(table), [json(payload)]);
    assertBulkUpdatedRows(result, malformed.map(({ row }) => row.id));
  }
}

function sanitizeError(error: unknown): ScopeBackfillExecutorError {
  return error instanceof ScopeBackfillExecutorError
    ? error
    : new ScopeBackfillExecutorError("SCOPE_BACKFILL_DATABASE_FAILED");
}

async function executeDryRun(
  client: PostgresScopeBackfillClient,
  table: ScopeBackfillTable,
  registry: MemoryAutodbRegistry,
  batchSize: number,
  stats: MutableStats,
): Promise<void> {
  let cursor: string | null = null;
  while (true) {
    try {
      const result = await client.query(pendingSelectSql(table, "dry-run"), [cursor, batchSize]);
      const rows = validateRows(result);
      assertStrictlyIncreasingRows(rows, cursor);
      if (rows.length === 0) return;
      stats.batches += 1;
      for (const row of rows) {
        countPlan(stats, planLegacyScopeBackfill(row, registry));
      }
      cursor = rows.at(-1)!.id;
    } catch (error) {
      throw sanitizeError(error);
    }
  }
}

async function executeApply(
  client: PostgresScopeBackfillClient,
  table: ScopeBackfillTable,
  registry: MemoryAutodbRegistry,
  batchSize: number,
  stats: MutableStats,
): Promise<void> {
  while (true) {
    let transactionStarted = false;
    try {
      await client.query("BEGIN");
      transactionStarted = true;
      const selected = await client.query(pendingSelectSql(table, "apply"), [batchSize]);
      const rows = validateRows(selected);
      if (rows.length > 0) stats.batches += 1;
      const planned = rows.map((row) => ({
        row,
        plan: planLegacyScopeBackfill(row, registry),
      }));
      if (planned.length > 0) await updateBatch(client, table, planned);
      for (const { plan } of planned) {
        countPlan(stats, plan);
      }
      // 最后一批不能只相信 locking SELECT 的空结果。NOWAIT 保证遇到已锁行
      // 直接失败；同一 transaction 的无 SKIP count 再确认没有漏扫/新出现的 pending。
      if (rows.length === 0) await assertNoRemainingRows(client, table);
      await client.query("COMMIT");
      transactionStarted = false;
      if (rows.length === 0) return;
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch {
          throw new ScopeBackfillExecutorError("SCOPE_BACKFILL_ROLLBACK_FAILED");
        }
      }
      throw sanitizeError(error);
    }
  }
}

/**
 * 安全执行 legacy scope 回填。
 *
 * - 默认 dry-run，仅参数化分页 SELECT；
 * - apply 逐批 transaction + FOR UPDATE NOWAIT，并在结束前复核无遗漏行；
 * - resolved 才写 authority scope；unknown/conflict 只隔离，不猜身份；
 * - metadata 原值乐观条件避免锁外/异常并发覆盖；重复执行只扫描未处理行。
 */
export async function executePostgresScopeBackfill(
  client: PostgresScopeBackfillClient,
  options: ExecutePostgresScopeBackfillOptions,
): Promise<ExecutePostgresScopeBackfillResult> {
  const { table, mode, batchSize } = validateOptions(options);
  const stats: MutableStats = {
    scanned: 0,
    resolved: 0,
    quarantined: 0,
    conflict: 0,
    skipped: 0,
    batches: 0,
  };
  if (mode === "dry-run") {
    await executeDryRun(client, table, options.registry, batchSize, stats);
  } else {
    await executeApply(client, table, options.registry, batchSize, stats);
  }
  return { mode, table, ...stats };
}
