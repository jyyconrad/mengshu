import { createHash } from "node:crypto";

import { authorityScopeFingerprint } from "../../domain/authority-scope-fingerprint.js";
import type { MemoryLifecycleStatus, MemoryScope } from "../../domain/types.js";
import { categoryToKind } from "../../domain/legacy-mapping.js";
import { kindToSemanticType } from "../../domain/semantic-type-mapper.js";
import {
  planTemporalMemoryBackfill,
  type TemporalMemoryBackfillPlan,
  type TemporalMemoryBackfillRowPlan,
  type TemporalMemoryBackfillSourceRow,
} from "./temporal-memory-backfill.js";

export interface PostgresTemporalMemoryBackfillQueryResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly rows: Row[];
  readonly rowCount?: number | null;
}

export interface PostgresTemporalMemoryBackfillClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresTemporalMemoryBackfillQueryResult<Row>>;
}

export type TemporalMemoryBackfillMode = "dry-run" | "apply";
export type TemporalMemoryBackfillRunState =
  | "planned"
  | "review_required"
  | "applied"
  | "verified"
  | "rolled_back";

export interface ExecutePostgresTemporalMemoryBackfillOptions {
  readonly mode?: TemporalMemoryBackfillMode;
  readonly maintenance?: boolean;
  readonly quiescenceConfirmed?: boolean;
}

export interface ExecutePostgresTemporalMemoryBackfillResult {
  readonly mode: TemporalMemoryBackfillMode;
  readonly state: TemporalMemoryBackfillRunState;
  readonly runId: string;
  readonly manifestHash: string;
  readonly scanned: number;
  readonly applied: number;
  readonly review: number;
  readonly lineages: number;
  readonly replayed: boolean;
}

export type TemporalMemoryBackfillExecutorErrorCode =
  | "TEMPORAL_BACKFILL_INVALID_OPTIONS"
  | "TEMPORAL_BACKFILL_MAINTENANCE_REQUIRED"
  | "TEMPORAL_BACKFILL_MANIFEST_MISMATCH"
  | "TEMPORAL_BACKFILL_INVALID_SOURCE"
  | "TEMPORAL_BACKFILL_CONCURRENT_DRIFT"
  | "TEMPORAL_BACKFILL_DATABASE_FAILED"
  | "TEMPORAL_BACKFILL_VERIFY_FAILED"
  | "TEMPORAL_BACKFILL_ROLLBACK_BLOCKED"
  | "TEMPORAL_BACKFILL_ROLLBACK_FAILED";

const ERROR_MESSAGES: Record<TemporalMemoryBackfillExecutorErrorCode, string> = {
  TEMPORAL_BACKFILL_INVALID_OPTIONS: "Temporal memory backfill options are invalid",
  TEMPORAL_BACKFILL_MAINTENANCE_REQUIRED:
    "Temporal memory backfill apply requires maintenance mode and writer quiescence",
  TEMPORAL_BACKFILL_MANIFEST_MISMATCH:
    "Temporal memory backfill manifest does not match the source snapshot",
  TEMPORAL_BACKFILL_INVALID_SOURCE: "Temporal memory backfill source is not executable",
  TEMPORAL_BACKFILL_CONCURRENT_DRIFT: "Temporal memory backfill detected concurrent row drift",
  TEMPORAL_BACKFILL_DATABASE_FAILED: "Temporal memory backfill database operation failed",
  TEMPORAL_BACKFILL_VERIFY_FAILED: "Temporal memory backfill verification failed",
  TEMPORAL_BACKFILL_ROLLBACK_BLOCKED:
    "Temporal memory backfill rollback is blocked by later temporal activity",
  TEMPORAL_BACKFILL_ROLLBACK_FAILED: "Temporal memory backfill rollback failed",
};

export class TemporalMemoryBackfillExecutorError extends Error {
  override readonly name = "TemporalMemoryBackfillExecutorError";

  constructor(readonly code: TemporalMemoryBackfillExecutorErrorCode) {
    super(ERROR_MESSAGES[code]);
  }
}

const RUN_ID = /^[^\s\p{Cc}]{1,256}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(code: TemporalMemoryBackfillExecutorErrorCode): never {
  throw new TemporalMemoryBackfillExecutorError(code);
}

function hashAfter(plan: TemporalMemoryBackfillPlan): string {
  return createHash("sha256")
    .update("mengshu.temporal-memory-backfill-after/v1\0")
    .update(JSON.stringify(plan.rows.map((row) => [row.memoryId, row.afterHash ?? null])))
    .digest("hex");
}

function assertPlanMatchesSource(
  sourceRows: readonly TemporalMemoryBackfillSourceRow[],
  plan: TemporalMemoryBackfillPlan,
): void {
  if (!RUN_ID.test(plan.runId) || !Number.isFinite(plan.createdAt) ||
      plan.version !== "temporal-memory-backfill-v1") {
    fail("TEMPORAL_BACKFILL_INVALID_OPTIONS");
  }
  const regenerated = planTemporalMemoryBackfill(sourceRows, {
    runId: plan.runId,
    createdAt: plan.createdAt,
  });
  if (regenerated.manifestHash !== plan.manifestHash || regenerated.sourceHash !== plan.sourceHash) {
    fail("TEMPORAL_BACKFILL_MANIFEST_MISMATCH");
  }
}

function beforeRow(row: TemporalMemoryBackfillSourceRow): Record<string, unknown> {
  return {
    id: row.id,
    scope: row.scope,
    kind: row.kind,
    semanticType: row.semanticType ?? null,
    lifecycleStatus: row.lifecycleStatus,
    originalLifecycleStatus: row.originalLifecycleStatus ?? row.lifecycleStatus,
    contentHash: row.contentHash,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt ?? null,
    supersededBy: row.supersededBy ?? null,
    metadata: row.metadata,
    recordHash: row.record === undefined
      ? null
      : createHash("sha256").update(JSON.stringify(row.record)).digest("hex"),
    temporal: {
      scopeFingerprint: null,
      lineageId: null,
      revision: null,
      previousVersionId: null,
      validFrom: null,
      validTo: null,
      recordedAt: null,
      transitionType: null,
    },
  };
}

function afterRow(row: TemporalMemoryBackfillRowPlan): Record<string, unknown> | null {
  if (row.lineageId === undefined || row.revision === undefined || row.validFrom === undefined) {
    return null;
  }
  return {
    scopeFingerprint: null,
    lineageId: row.lineageId,
    revision: row.revision,
    previousVersionId: row.previousVersionId ?? null,
    validFrom: row.validFrom,
    validTo: row.validTo ?? null,
    currentHead: row.currentHead === true,
    lifecycleStatus: row.lifecycleStatus,
    transitionType: row.revision === 1 ? "created" : "evolved",
  };
}

function executableRows(
  sourceRows: readonly TemporalMemoryBackfillSourceRow[],
  plan: TemporalMemoryBackfillPlan,
): Array<{ source: TemporalMemoryBackfillSourceRow; row: TemporalMemoryBackfillRowPlan }> {
  const sourceById = new Map(sourceRows.map((row) => [row.id, row]));
  const executable = plan.rows.flatMap((row) => {
    if (row.lineageId === undefined) return [];
    const source = sourceById.get(row.memoryId);
    if (source === undefined || !UUID.test(source.id) || row.revision === undefined ||
        row.validFrom === undefined || row.afterHash === undefined || source.record === undefined) {
      fail("TEMPORAL_BACKFILL_INVALID_SOURCE");
    }
    return [{ source, row }];
  });
  if (executable.length !== plan.counts.automatic) {
    fail("TEMPORAL_BACKFILL_INVALID_SOURCE");
  }
  return executable;
}

function resultFor(
  mode: TemporalMemoryBackfillMode,
  state: TemporalMemoryBackfillRunState,
  plan: TemporalMemoryBackfillPlan,
  applied: number,
  replayed: boolean,
): ExecutePostgresTemporalMemoryBackfillResult {
  return {
    mode,
    state,
    runId: plan.runId,
    manifestHash: plan.manifestHash,
    scanned: plan.counts.scanned,
    applied,
    review: plan.counts.review,
    lineages: plan.counts.lineages,
    replayed,
  };
}

async function rollbackTransaction(
  client: PostgresTemporalMemoryBackfillClient,
  code: "TEMPORAL_BACKFILL_DATABASE_FAILED" | "TEMPORAL_BACKFILL_ROLLBACK_FAILED",
): Promise<never> {
  try {
    await client.query("ROLLBACK");
  } catch {
    fail("TEMPORAL_BACKFILL_ROLLBACK_FAILED");
  }
  fail(code);
}

export async function executePostgresTemporalMemoryBackfill(
  client: PostgresTemporalMemoryBackfillClient,
  sourceRows: readonly TemporalMemoryBackfillSourceRow[],
  plan: TemporalMemoryBackfillPlan,
  options: ExecutePostgresTemporalMemoryBackfillOptions = {},
): Promise<ExecutePostgresTemporalMemoryBackfillResult> {
  assertPlanMatchesSource(sourceRows, plan);
  const mode = options.mode ?? "dry-run";
  if (mode !== "dry-run" && mode !== "apply") fail("TEMPORAL_BACKFILL_INVALID_OPTIONS");
  if (mode === "dry-run") return resultFor(mode, "planned", plan, 0, false);
  if (options.maintenance !== true || options.quiescenceConfirmed !== true) {
    fail("TEMPORAL_BACKFILL_MAINTENANCE_REQUIRED");
  }
  const executable = executableRows(sourceRows, plan);
  const finalState = plan.counts.review > 0 ? "review_required" : "applied";
  try {
    await client.query("BEGIN");
    const insertedRun = await client.query<{ run_id: string }>(
      `/* temporal-backfill:insert-run */
INSERT INTO mengshu_memory_temporal_migration_runs (
  run_id, manifest_hash, before_hash, after_hash, state,
  scanned_count, applied_count, ambiguous_count, created_at, updated_at
) VALUES ($1, $2, $3, NULL, 'planned', $4, 0, $5, $6, $6)
ON CONFLICT (run_id) DO NOTHING
RETURNING run_id`,
      [plan.runId, plan.manifestHash, plan.sourceHash, plan.counts.scanned,
        plan.counts.review, plan.createdAt],
    );
    if (insertedRun.rowCount !== 1) {
      const existing = await client.query<{ manifest_hash: string; state: string; applied_count: string }>(
        `/* temporal-backfill:read-existing-run */
SELECT manifest_hash, state, applied_count::text AS applied_count
FROM mengshu_memory_temporal_migration_runs WHERE run_id = $1 FOR UPDATE`,
        [plan.runId],
      );
      const row = existing.rows[0];
      if (existing.rowCount !== 1 || row?.manifest_hash !== plan.manifestHash ||
          !["applied", "verified", "review_required"].includes(row.state)) {
        await rollbackTransaction(client, "TEMPORAL_BACKFILL_DATABASE_FAILED");
      }
      await client.query("COMMIT");
      return resultFor(mode, row.state as TemporalMemoryBackfillRunState, plan,
        Number(row.applied_count), true);
    }

    const sourceById = new Map(sourceRows.map((row) => [row.id, row]));
    for (const rowPlan of plan.rows) {
      const candidateSource = sourceById.get(rowPlan.memoryId);
      if (candidateSource === undefined || !UUID.test(candidateSource.id)) {
        await rollbackTransaction(client, "TEMPORAL_BACKFILL_DATABASE_FAILED");
      }
      const source = candidateSource as TemporalMemoryBackfillSourceRow;
      const projected = afterRow(rowPlan);
      if (projected !== null) projected.scopeFingerprint = authorityScopeFingerprint(source.scope);
      const audit = await client.query(
        `/* temporal-backfill:insert-row */
INSERT INTO mengshu_memory_temporal_migration_rows (
  run_id, memory_id, scope_fingerprint, disposition, lineage_id, revision,
  before_hash, after_hash, before_row, after_row, reason_code, created_at
) VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12)
RETURNING memory_id::text AS memory_id`,
        [plan.runId, source.id,
          rowPlan.lineageId === undefined ? null : authorityScopeFingerprint(source.scope),
          rowPlan.disposition, rowPlan.lineageId ?? null, rowPlan.revision ?? null,
          rowPlan.beforeHash, rowPlan.afterHash ?? null, JSON.stringify(beforeRow(source)),
          projected === null ? null : JSON.stringify(projected),
          rowPlan.reasonCodes.length === 0 ? "automatic" : rowPlan.reasonCodes.join(","),
          plan.createdAt],
      );
      if (audit.rowCount !== 1) {
        await rollbackTransaction(client, "TEMPORAL_BACKFILL_DATABASE_FAILED");
      }
    }

    for (const { source, row } of executable) {
      const fingerprint = authorityScopeFingerprint(source.scope);
      const sourceRecord = source.record!;
      const snapshot = {
        lineageId: row.lineageId,
        revision: row.revision,
        record: sourceRecord,
        ...(row.previousVersionId === undefined ? {} : { previousVersionId: row.previousVersionId }),
        validFrom: row.validFrom,
        ...(row.validTo === undefined ? {} : { validTo: row.validTo, closedAt: row.validTo }),
        recordedAt: source.createdAt,
        transitionType: row.revision === 1 ? "created" : "evolved",
        transitionReason: "legacy_temporal_backfill",
        invalidated: false,
      };
      const stamped = await client.query<{ id: string }>(
        `/* temporal-backfill:stamp-memory */
UPDATE memories SET
  scope_fingerprint = $1, lineage_id = $2, revision = $3,
  previous_version_id = $4::uuid,
  valid_from = to_timestamp($5::double precision / 1000),
  valid_to = CASE WHEN $6::double precision IS NULL THEN NULL
    ELSE to_timestamp($6::double precision / 1000) END,
  recorded_at = to_timestamp($7::double precision / 1000),
  transition_type = $8, transition_reason = 'legacy_temporal_backfill',
  lifecycle_status = $20,
  temporal_invalidated = FALSE, temporal_purge_pending = FALSE,
  temporal_snapshot = $9::jsonb
WHERE id = $10::uuid AND content_hash = $11
  AND tenant_id = $12 AND user_id = $13 AND canonical_project_id = $14
  AND product_id = $15 AND producer_id = $16 AND namespace = $17 AND visibility = $18
  AND metadata = $19::jsonb
  AND lifecycle_status IS NOT DISTINCT FROM $21 AND text = $22
  AND lineage_id IS NULL AND revision IS NULL AND scope_fingerprint IS NULL
RETURNING id::text AS id`,
        [fingerprint, row.lineageId, row.revision, row.previousVersionId ?? null,
          row.validFrom, row.validTo ?? null, source.createdAt,
          row.revision === 1 ? "created" : "evolved",
          JSON.stringify(snapshot),
          source.id, source.contentHash, source.scope.tenantId, source.scope.userId,
          source.scope.projectId, source.scope.appId, source.scope.agentId,
          source.scope.namespace, source.scope.visibility, JSON.stringify(source.metadata),
          source.lifecycleStatus,
          source.originalLifecycleStatus === undefined
            ? source.lifecycleStatus
            : source.originalLifecycleStatus,
          sourceRecord.text],
      );
      if (stamped.rowCount !== 1 || stamped.rows[0]?.id !== source.id) {
        await rollbackTransaction(client, "TEMPORAL_BACKFILL_DATABASE_FAILED");
      }
    }

    const byLineage = new Map<string, typeof executable>();
    for (const item of executable) {
      const values = byLineage.get(item.row.lineageId!) ?? [];
      values.push(item);
      byLineage.set(item.row.lineageId!, values);
    }
    for (const [lineageId, versions] of byLineage) {
      versions.sort((left, right) => left.row.revision! - right.row.revision!);
      const latest = versions.at(-1)!;
      const current = versions.find((item) => item.row.currentHead === true);
      const head = await client.query(
        `/* temporal-backfill:insert-head */
INSERT INTO mengshu_memory_lineage_heads (
  scope_fingerprint, lineage_id, latest_revision, current_version_id,
  current_version_revision, updated_at
) VALUES ($1, $2, $3, $4::uuid, $5, $6)
RETURNING lineage_id`,
        [authorityScopeFingerprint(latest.source.scope), lineageId, latest.row.revision,
          current?.source.id ?? null, current?.row.revision ?? null, plan.createdAt],
      );
      if (head.rowCount !== 1) {
        await rollbackTransaction(client, "TEMPORAL_BACKFILL_DATABASE_FAILED");
      }
    }

    const updated = await client.query(
      `/* temporal-backfill:finish-run */
UPDATE mengshu_memory_temporal_migration_runs
SET after_hash = $1, state = $2, applied_count = $3, updated_at = $4
WHERE run_id = $5 AND manifest_hash = $6 AND state = 'planned'
RETURNING run_id`,
      [hashAfter(plan), finalState, executable.length, plan.createdAt, plan.runId,
        plan.manifestHash],
    );
    if (updated.rowCount !== 1) {
      await rollbackTransaction(client, "TEMPORAL_BACKFILL_DATABASE_FAILED");
    }
    await client.query("COMMIT");
    return resultFor(mode, finalState, plan, executable.length, false);
  } catch (error) {
    if (error instanceof TemporalMemoryBackfillExecutorError) throw error;
    return rollbackTransaction(client, "TEMPORAL_BACKFILL_DATABASE_FAILED");
  }
}

export interface VerifyPostgresTemporalMemoryBackfillResult {
  readonly runId: string;
  readonly state: "verified" | "review_required";
  readonly applied: number;
  readonly review: number;
  readonly mismatches: number;
}

export async function verifyPostgresTemporalMemoryBackfill(
  client: PostgresTemporalMemoryBackfillClient,
  plan: TemporalMemoryBackfillPlan,
  now: number,
): Promise<VerifyPostgresTemporalMemoryBackfillResult> {
  if (!Number.isFinite(now)) fail("TEMPORAL_BACKFILL_INVALID_OPTIONS");
  try {
    const result = await client.query<{
      manifest_hash: string;
      state: string;
      applied_count: string;
      ambiguous_count: string;
      mismatch_count: string;
      head_mismatch_count: string;
    }>(
      `/* temporal-backfill:verify */
SELECT run.manifest_hash, run.state, run.applied_count::text, run.ambiguous_count::text,
  COUNT(*) FILTER (WHERE rows.lineage_id IS NOT NULL AND (
    memories.id IS NULL OR memories.scope_fingerprint IS DISTINCT FROM rows.scope_fingerprint OR
    memories.lineage_id IS DISTINCT FROM rows.lineage_id OR
    memories.revision IS DISTINCT FROM rows.revision OR
    memories.temporal_invalidated IS DISTINCT FROM FALSE OR
    memories.temporal_purge_pending IS DISTINCT FROM FALSE
  ))::text AS mismatch_count,
  (SELECT COUNT(*)::text FROM mengshu_memory_lineage_heads heads
    WHERE EXISTS (
      SELECT 1 FROM mengshu_memory_temporal_migration_rows expected
      WHERE expected.run_id = run.run_id AND expected.lineage_id = heads.lineage_id
        AND expected.scope_fingerprint = heads.scope_fingerprint
    ) AND NOT EXISTS (
      SELECT 1 FROM mengshu_memory_temporal_migration_rows expected_head
      WHERE expected_head.run_id = run.run_id
        AND expected_head.lineage_id = heads.lineage_id
        AND expected_head.scope_fingerprint = heads.scope_fingerprint
        AND expected_head.revision = heads.latest_revision
    )
  ) AS head_mismatch_count
FROM mengshu_memory_temporal_migration_runs run
LEFT JOIN mengshu_memory_temporal_migration_rows rows ON rows.run_id = run.run_id
LEFT JOIN memories ON memories.id = rows.memory_id
WHERE run.run_id = $1
GROUP BY run.run_id, run.manifest_hash, run.state, run.applied_count, run.ambiguous_count`,
      [plan.runId],
    );
    const row = result.rows[0];
    if (result.rowCount !== 1 || row?.manifest_hash !== plan.manifestHash ||
        !["applied", "verified", "review_required"].includes(row.state)) {
      fail("TEMPORAL_BACKFILL_VERIFY_FAILED");
    }
    const mismatches = Number(row.mismatch_count) + Number(row.head_mismatch_count);
    if (!Number.isSafeInteger(mismatches) || mismatches !== 0 ||
        Number(row.applied_count) !== plan.counts.automatic ||
        Number(row.ambiguous_count) !== plan.counts.review) {
      fail("TEMPORAL_BACKFILL_VERIFY_FAILED");
    }
    const state = plan.counts.review > 0 ? "review_required" : "verified";
    if (state === "verified" && row.state !== "verified") {
      const updated = await client.query(
        `/* temporal-backfill:mark-verified */
UPDATE mengshu_memory_temporal_migration_runs
SET state = 'verified', updated_at = $1
WHERE run_id = $2 AND manifest_hash = $3 AND state = 'applied'
RETURNING run_id`,
        [now, plan.runId, plan.manifestHash],
      );
      if (updated.rowCount !== 1) fail("TEMPORAL_BACKFILL_VERIFY_FAILED");
    }
    return {
      runId: plan.runId,
      state,
      applied: Number(row.applied_count),
      review: Number(row.ambiguous_count),
      mismatches,
    };
  } catch (error) {
    if (error instanceof TemporalMemoryBackfillExecutorError) throw error;
    fail("TEMPORAL_BACKFILL_VERIFY_FAILED");
  }
}

export async function rollbackPostgresTemporalMemoryBackfill(
  client: PostgresTemporalMemoryBackfillClient,
  plan: TemporalMemoryBackfillPlan,
  options: { readonly maintenance: boolean; readonly quiescenceConfirmed: boolean; readonly now: number },
): Promise<ExecutePostgresTemporalMemoryBackfillResult> {
  if (options.maintenance !== true || options.quiescenceConfirmed !== true) {
    fail("TEMPORAL_BACKFILL_MAINTENANCE_REQUIRED");
  }
  if (!Number.isFinite(options.now)) fail("TEMPORAL_BACKFILL_INVALID_OPTIONS");
  try {
    await client.query("BEGIN");
    const run = await client.query<{ manifest_hash: string; state: string }>(
      `/* temporal-backfill:rollback-lock */
SELECT manifest_hash, state FROM mengshu_memory_temporal_migration_runs
WHERE run_id = $1 FOR UPDATE`,
      [plan.runId],
    );
    if (run.rowCount !== 1 || run.rows[0]?.manifest_hash !== plan.manifestHash ||
        !["applied", "verified", "review_required"].includes(run.rows[0].state)) {
      await rollbackTransaction(client, "TEMPORAL_BACKFILL_ROLLBACK_FAILED");
    }
    const activity = await client.query<{ activity_count: string }>(
      `/* temporal-backfill:rollback-activity */
SELECT (
  (SELECT COUNT(*) FROM mengshu_memory_version_transition_receipts receipts
   WHERE EXISTS (SELECT 1 FROM mengshu_memory_temporal_migration_rows rows
     WHERE rows.run_id = $1 AND rows.scope_fingerprint = receipts.scope_fingerprint
       AND rows.lineage_id = receipts.lineage_id)) +
  (SELECT COUNT(*) FROM mengshu_memory_version_outbox outbox
   WHERE EXISTS (SELECT 1 FROM mengshu_memory_temporal_migration_rows rows
     WHERE rows.run_id = $1 AND rows.scope_fingerprint = outbox.scope_fingerprint
       AND rows.lineage_id = outbox.lineage_id))
)::text AS activity_count`,
      [plan.runId],
    );
    if (activity.rowCount !== 1 || Number(activity.rows[0]?.activity_count) !== 0) {
      try {
        await client.query("ROLLBACK");
      } catch {
        fail("TEMPORAL_BACKFILL_ROLLBACK_FAILED");
      }
      fail("TEMPORAL_BACKFILL_ROLLBACK_BLOCKED");
    }
    const reset = await client.query(
      `/* temporal-backfill:rollback-memories */
UPDATE memories SET
  scope_fingerprint = NULL, lineage_id = NULL, revision = NULL,
  previous_version_id = NULL, restored_from_version_id = NULL,
  valid_from = NULL, valid_to = NULL, recorded_at = NULL, closed_at = NULL,
  transition_type = NULL, transition_reason = NULL,
  temporal_invalidated = NULL, temporal_purge_pending = NULL, temporal_snapshot = NULL,
  lifecycle_status = CASE
    WHEN rows.before_row ? 'originalLifecycleStatus'
      AND rows.before_row->'originalLifecycleStatus' <> 'null'::jsonb
    THEN rows.before_row->>'originalLifecycleStatus'
    ELSE NULL
  END
FROM mengshu_memory_temporal_migration_rows rows
WHERE rows.run_id = $1 AND rows.memory_id = memories.id
  AND rows.lineage_id = memories.lineage_id AND rows.revision = memories.revision
RETURNING id`,
      [plan.runId],
    );
    if (reset.rowCount !== plan.counts.automatic) {
      await rollbackTransaction(client, "TEMPORAL_BACKFILL_ROLLBACK_FAILED");
    }
    await client.query(
      `/* temporal-backfill:rollback-heads */
DELETE FROM mengshu_memory_lineage_heads heads
WHERE EXISTS (
  SELECT 1 FROM mengshu_memory_temporal_migration_rows rows
  WHERE rows.run_id = $1 AND rows.scope_fingerprint = heads.scope_fingerprint
    AND rows.lineage_id = heads.lineage_id
)`,
      [plan.runId],
    );
    const marked = await client.query(
      `/* temporal-backfill:mark-rolled-back */
UPDATE mengshu_memory_temporal_migration_runs
SET state = 'rolled_back', updated_at = $1
WHERE run_id = $2 AND manifest_hash = $3
RETURNING run_id`,
      [options.now, plan.runId, plan.manifestHash],
    );
    if (marked.rowCount !== 1) {
      await rollbackTransaction(client, "TEMPORAL_BACKFILL_ROLLBACK_FAILED");
    }
    await client.query("COMMIT");
    return resultFor("apply", "rolled_back", plan, 0, false);
  } catch (error) {
    if (error instanceof TemporalMemoryBackfillExecutorError) throw error;
    return rollbackTransaction(client, "TEMPORAL_BACKFILL_ROLLBACK_FAILED");
  }
}

export interface PostgresTemporalMemoryBackfillRawRow extends Record<string, unknown> {
  readonly id: string;
  readonly tenant_id: string;
  readonly user_id: string;
  readonly canonical_project_id: string;
  readonly product_id: string;
  readonly producer_id: string;
  readonly namespace: string;
  readonly visibility: string;
  readonly workspace_id: string | null;
  readonly category: string;
  readonly lifecycle_status: string | null;
  readonly content_hash: string;
  readonly text: string;
  readonly vector_text: string;
  readonly importance: number | null;
  readonly data_type: string;
  readonly created_at_ms: string;
  readonly metadata: Record<string, unknown>;
}

const MIGRATION_LIFECYCLES = new Set<MemoryLifecycleStatus>([
  "active", "archived", "revoked", "superseded", "promoted",
]);
const MIGRATION_VISIBILITIES = new Set(["private", "workspace", "team", "public"]);
const MIGRATION_CATEGORIES = new Set([
  "core", "preference", "fact", "entity", "decision", "task", "plan", "goal", "other",
]);

function migrationVector(value: unknown): number[] {
  if (typeof value !== "string" || !/^\[[^\]]*\]$/.test(value)) {
    fail("TEMPORAL_BACKFILL_INVALID_SOURCE");
  }
  const body = value.slice(1, -1).trim();
  if (!body) fail("TEMPORAL_BACKFILL_INVALID_SOURCE");
  const values = body.split(",").map((item) => Number(item));
  if (values.some((item) => !Number.isFinite(item))) fail("TEMPORAL_BACKFILL_INVALID_SOURCE");
  return values;
}

function migrationMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("TEMPORAL_BACKFILL_INVALID_SOURCE");
  }
  return value as Record<string, unknown>;
}

/** Loads one repeatable canonical snapshot; callers should run in REPEATABLE READ for apply. */
export async function loadPostgresTemporalMemoryBackfillSourceRows(
  client: PostgresTemporalMemoryBackfillClient,
): Promise<readonly TemporalMemoryBackfillSourceRow[]> {
  const result = await client.query<PostgresTemporalMemoryBackfillRawRow>(
    `/* temporal-backfill:load-source */
SELECT id::text AS id, tenant_id, user_id, canonical_project_id, product_id,
       producer_id, namespace, visibility, workspace_id, category,
       lifecycle_status, content_hash, text, vector::text AS vector_text,
       importance::double precision AS importance, data_type,
       FLOOR(EXTRACT(EPOCH FROM created_at) * 1000)::bigint::text AS created_at_ms,
       metadata
FROM memories
WHERE lineage_id IS NULL AND legacy_quarantine_reason IS NULL
  AND tenant_id IS NOT NULL AND user_id IS NOT NULL
  AND canonical_project_id IS NOT NULL AND product_id IS NOT NULL
  AND producer_id IS NOT NULL AND namespace IS NOT NULL AND visibility IS NOT NULL
ORDER BY created_at, id`,
  );
  if (!Array.isArray(result.rows) ||
      (result.rowCount !== undefined && result.rowCount !== null && result.rowCount !== result.rows.length)) {
    fail("TEMPORAL_BACKFILL_INVALID_SOURCE");
  }
  return result.rows.map((row) => {
    const metadata = migrationMetadata(row.metadata);
    if (!UUID.test(row.id) || !MIGRATION_VISIBILITIES.has(row.visibility) ||
        typeof row.category !== "string" || typeof row.text !== "string" || !row.text ||
        (row.importance !== null &&
          (typeof row.importance !== "number" || !Number.isFinite(row.importance))) ||
        typeof row.created_at_ms !== "string" || !Number.isSafeInteger(Number(row.created_at_ms))) {
      fail("TEMPORAL_BACKFILL_INVALID_SOURCE");
    }
    const canonicalCategory = MIGRATION_CATEGORIES.has(row.category) ? row.category : "other";
    const fallbackKind = categoryToKind(canonicalCategory as Parameters<typeof categoryToKind>[0]);
    const explicitSemantic = metadata.semanticType;
    const inferred = kindToSemanticType(fallbackKind).semanticType ?? undefined;
    const semanticType = typeof explicitSemantic === "string" &&
        ["profile", "task_context", "rules", "experience", "resource"].includes(explicitSemantic)
      ? explicitSemantic as TemporalMemoryBackfillSourceRow["semanticType"]
      : inferred;
    const kind = explicitSemantic === "rules" ? "decision"
      : explicitSemantic === "task_context" ? "task"
      : explicitSemantic === "profile" ? "preference"
      : explicitSemantic === "experience" ? "observation"
      : explicitSemantic === "resource" ? "knowledge"
      : fallbackKind;
    const createdAt = Number(row.created_at_ms);
    const updatedAt = typeof metadata.updatedAt === "number" &&
        Number.isSafeInteger(metadata.updatedAt) && metadata.updatedAt >= createdAt
      ? metadata.updatedAt
      : undefined;
    const supersededBy = typeof metadata.supersededBy === "string" && metadata.supersededBy.trim()
      ? metadata.supersededBy.trim()
      : undefined;
    const canonicalLifecycle = typeof row.lifecycle_status === "string" &&
        MIGRATION_LIFECYCLES.has(row.lifecycle_status as MemoryLifecycleStatus)
      ? row.lifecycle_status as MemoryLifecycleStatus
      : undefined;
    const lifecycleStatus = canonicalLifecycle ?? "archived";
    const scope: MemoryScope = {
      tenantId: row.tenant_id,
      userId: row.user_id,
      appId: row.product_id,
      projectId: row.canonical_project_id,
      agentId: row.producer_id,
      namespace: row.namespace,
      visibility: row.visibility as MemoryScope["visibility"],
      ...(row.workspace_id === null ? {} : { workspaceId: row.workspace_id }),
      ...(typeof metadata.sessionId === "string" && metadata.sessionId
        ? { sessionId: metadata.sessionId }
        : {}),
    };
    const sourceNodeIds = Array.isArray(metadata.sourceNodeIds)
      ? metadata.sourceNodeIds.filter((id): id is string => typeof id === "string")
      : undefined;
    const provenance = metadata.provenance && typeof metadata.provenance === "object" &&
        !Array.isArray(metadata.provenance)
      ? metadata.provenance as Record<string, unknown>
      : {};
    const record = {
      id: row.id,
      scope,
      kind,
      ...(semanticType === undefined ? {} : { semanticType }),
      ...(typeof metadata.memoryContainer === "string"
        ? { container: metadata.memoryContainer as "personal" | "project" | "team" | "enterprise" }
        : {}),
      lifecycleStatus,
      ...(typeof metadata.confidence === "number" ? { confidence: metadata.confidence } : {}),
      text: row.text,
      contentHash: row.content_hash,
      importance: row.importance === null ? 0.5 : Math.max(0, Math.min(1, row.importance)),
      category: canonicalCategory as Parameters<typeof categoryToKind>[0],
      dataType: "memory" as const,
      tableName: "memories" as const,
      metadata: structuredClone(metadata),
      provenance: structuredClone(provenance),
      ...(sourceNodeIds === undefined ? {} : { sourceNodeIds }),
      createdAt,
      ...(updatedAt === undefined ? {} : { updatedAt }),
      vector: migrationVector(row.vector_text),
    };
    const migrationBlockReason = canonicalLifecycle === undefined
      ? "noncanonical_lifecycle" as const
      : !/^(?:[0-9a-f]{32}|[0-9a-f]{64})$/.test(row.content_hash)
      ? "unverifiable_content_hash" as const
      : undefined;
    return Object.freeze({
      id: row.id,
      scope,
      kind,
      ...(semanticType === undefined ? {} : { semanticType }),
      lifecycleStatus,
      originalLifecycleStatus: canonicalLifecycle ?? null,
      contentHash: row.content_hash,
      createdAt,
      ...(updatedAt === undefined ? {} : { updatedAt }),
      ...(supersededBy === undefined ? {} : { supersededBy }),
      metadata: structuredClone(metadata),
      record,
      ...(migrationBlockReason === undefined ? {} : { migrationBlockReason }),
    });
  });
}
