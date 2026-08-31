import { createHash } from "node:crypto";

import { computeCanonicalContentHash, durableUuid } from "../../scoring/hash-utils.js";

interface QueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  readonly rows: Row[];
  readonly rowCount?: number | null;
}
export interface TemporalPrerequisiteRepairClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

export type TemporalPrerequisiteRepairDisposition =
  | "migrate_candidate"
  | "quarantine_duplicate"
  | "review_invalid_hash";

export interface TemporalPrerequisiteRepairPlanRow {
  readonly memoryId: string;
  readonly disposition: TemporalPrerequisiteRepairDisposition;
  readonly candidateId?: string;
  readonly candidateContentHash?: string;
  readonly duplicateOf?: string;
  readonly beforeHash: string;
  readonly afterHash?: string;
}

export interface TemporalPrerequisiteRepairPlan {
  readonly version: "temporal-prerequisite-repair-v1";
  readonly runId: string;
  readonly createdAt: number;
  readonly sourceHash: string;
  readonly manifestHash: string;
  readonly counts: Readonly<{ scanned: number; repaired: number; review: number }>;
  readonly rows: readonly TemporalPrerequisiteRepairPlanRow[];
}

export interface PlanTemporalPrerequisiteRepairOptions {
  readonly runId: string;
  readonly createdAt: number;
}

interface RawRepairRow extends Record<string, unknown> {
  id: string;
  text: string;
  content_hash: string;
  lifecycle_status: string | null;
  category: string;
  metadata: Record<string, unknown>;
  created_at_ms: string;
  tenant_id: string;
  user_id: string;
  canonical_project_id: string;
  product_id: string;
  producer_id: string;
  namespace: string;
  visibility: string;
  workspace_id: string | null;
}

const SAFE_ID = /^[^\s\p{Cc}]{1,256}$/u;
const HASH = /^(?:[0-9a-f]{32}|[0-9a-f]{64})$/;

function stable(value: unknown): unknown {
  if (value === undefined) return { $type: "undefined" };
  if (value === null || typeof value === "string" || typeof value === "boolean" ||
      typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [
      key,
      stable((value as Record<string, unknown>)[key]),
    ]));
  }
  return { $type: typeof value };
}

function digest(domain: string, value: unknown): string {
  return createHash("sha256").update(`${domain}\0${JSON.stringify(stable(value))}`).digest("hex");
}

function scopeKey(row: RawRepairRow): string {
  return JSON.stringify([
    row.tenant_id, row.user_id, row.canonical_project_id, row.product_id,
    row.producer_id, row.namespace, row.visibility, row.workspace_id ?? "",
  ]);
}

function beforeProjection(row: RawRepairRow): Record<string, unknown> {
  return {
    id: row.id,
    scopeKey: scopeKey(row),
    textHash: digest("temporal-repair-text-v1", row.text),
    contentHash: row.content_hash,
    lifecycleStatus: row.lifecycle_status,
    category: row.category,
    metadataHash: digest("temporal-repair-metadata-v1", row.metadata),
    createdAt: row.created_at_ms,
  };
}

function validateRows(result: QueryResult<RawRepairRow>): RawRepairRow[] {
  if (!Array.isArray(result.rows) ||
      (result.rowCount !== undefined && result.rowCount !== null && result.rowCount !== result.rows.length)) {
    throw new Error("TEMPORAL_REPAIR_INVALID_SOURCE");
  }
  for (const row of result.rows) {
    if (!SAFE_ID.test(row.id) || typeof row.text !== "string" || !row.text ||
        typeof row.content_hash !== "string" || typeof row.category !== "string" ||
        !row.metadata || typeof row.metadata !== "object" || Array.isArray(row.metadata) ||
        ![row.tenant_id, row.user_id, row.canonical_project_id, row.product_id,
          row.producer_id, row.namespace, row.visibility].every((value) => typeof value === "string")) {
      throw new Error("TEMPORAL_REPAIR_INVALID_SOURCE");
    }
  }
  return result.rows;
}

async function loadRepairRows(client: TemporalPrerequisiteRepairClient): Promise<{
  source: RawRepairRow[];
  versioned: RawRepairRow[];
}> {
  const columns = `id::text AS id, text, content_hash, lifecycle_status, category, metadata,
    FLOOR(EXTRACT(EPOCH FROM created_at) * 1000)::bigint::text AS created_at_ms,
    tenant_id, user_id, canonical_project_id, product_id, producer_id, namespace,
    visibility, workspace_id`;
  const source = validateRows(await client.query<RawRepairRow>(
    `/* temporal-prerequisite-repair:repair-source */
SELECT ${columns} FROM memories
WHERE lineage_id IS NULL AND legacy_quarantine_reason IS NULL
  AND (lifecycle_status = 'pending' OR content_hash !~ '^(?:[0-9a-f]{32}|[0-9a-f]{64})$')
ORDER BY id`,
  ));
  const versioned = validateRows(await client.query<RawRepairRow>(
    `/* temporal-prerequisite-repair:versioned-source */
SELECT ${columns} FROM memories
WHERE lineage_id IS NOT NULL AND legacy_quarantine_reason IS NULL
ORDER BY id`,
  ));
  return { source, versioned };
}

export async function planPostgresTemporalPrerequisiteRepair(
  client: TemporalPrerequisiteRepairClient,
  options: PlanTemporalPrerequisiteRepairOptions,
): Promise<TemporalPrerequisiteRepairPlan> {
  if (!SAFE_ID.test(options.runId) || !Number.isSafeInteger(options.createdAt) || options.createdAt < 0) {
    throw new Error("TEMPORAL_REPAIR_INVALID_OPTIONS");
  }
  const { source, versioned } = await loadRepairRows(client);
  const versionedByContent = new Map<string, string[]>();
  for (const row of versioned) {
    const key = `${scopeKey(row)}\0${computeCanonicalContentHash(row.text)}`;
    versionedByContent.set(key, [...(versionedByContent.get(key) ?? []), row.id].sort());
  }
  const rows = source.map((row): TemporalPrerequisiteRepairPlanRow => {
    const beforeHash = digest("temporal-prerequisite-repair-before-v1", beforeProjection(row));
    if (row.lifecycle_status === "pending") {
      const candidateId = `legacy-pending-${durableUuid("temporal-pending", row.id)}`;
      const candidateContentHash = computeCanonicalContentHash(row.text);
      const after = { candidateId, candidateContentHash, quarantine: "migrated_to_candidate" };
      return {
        memoryId: row.id,
        disposition: "migrate_candidate",
        candidateId,
        candidateContentHash,
        beforeHash,
        afterHash: digest("temporal-prerequisite-repair-after-v1", after),
      };
    }
    if (!HASH.test(row.content_hash)) {
      const duplicates = versionedByContent.get(
        `${scopeKey(row)}\0${computeCanonicalContentHash(row.text)}`,
      ) ?? [];
      const duplicateOf = duplicates[0];
      if (duplicateOf !== undefined) {
        return {
          memoryId: row.id,
          disposition: "quarantine_duplicate",
          duplicateOf,
          beforeHash,
          afterHash: digest("temporal-prerequisite-repair-after-v1", {
            duplicateOf,
            quarantine: "temporal_duplicate_content",
          }),
        };
      }
    }
    return { memoryId: row.id, disposition: "review_invalid_hash", beforeHash };
  });
  const review = rows.filter((row) => row.disposition === "review_invalid_hash").length;
  const counts = { scanned: rows.length, repaired: rows.length - review, review };
  const sourceHash = digest("temporal-prerequisite-repair-source-v1", source.map(beforeProjection));
  const base = {
    version: "temporal-prerequisite-repair-v1" as const,
    runId: options.runId,
    createdAt: options.createdAt,
    sourceHash,
    counts,
    rows,
  };
  return Object.freeze({
    ...base,
    manifestHash: digest("temporal-prerequisite-repair-manifest-v1", base),
  });
}

export interface ExecuteTemporalPrerequisiteRepairResult {
  readonly runId: string;
  readonly state: "applied" | "verified";
  readonly repaired: number;
  readonly review: number;
  readonly manifestHash: string;
}

function semanticType(metadata: Record<string, unknown>): string | null {
  const value = metadata.semanticType;
  return typeof value === "string" &&
      ["profile", "task_context", "rules", "experience", "resource"].includes(value)
    ? value
    : null;
}

export async function executePostgresTemporalPrerequisiteRepair(
  client: TemporalPrerequisiteRepairClient,
  plan: TemporalPrerequisiteRepairPlan,
  options: { readonly maintenance: true; readonly quiescenceConfirmed: true },
): Promise<ExecuteTemporalPrerequisiteRepairResult> {
  if (options.maintenance !== true || options.quiescenceConfirmed !== true) {
    throw new Error("TEMPORAL_REPAIR_MAINTENANCE_REQUIRED");
  }
  const regenerated = await planPostgresTemporalPrerequisiteRepair(client, {
    runId: plan.runId,
    createdAt: plan.createdAt,
  });
  if (regenerated.manifestHash !== plan.manifestHash) throw new Error("TEMPORAL_REPAIR_MANIFEST_MISMATCH");
  const { source } = await loadRepairRows(client);
  const sourceById = new Map(source.map((row) => [row.id, row]));
  await client.query("BEGIN");
  try {
    const run = await client.query(
      `/* temporal-prerequisite-repair:insert-run */
INSERT INTO mengshu_temporal_prerequisite_repair_runs (
  run_id, manifest_hash, before_hash, after_hash, state, scanned_count,
  repaired_count, review_count, created_at, updated_at
) VALUES ($1, $2, $3, NULL, 'planned', $4, 0, $5, $6, $6)
RETURNING run_id`,
      [plan.runId, plan.manifestHash, plan.sourceHash, plan.counts.scanned,
        plan.counts.review, plan.createdAt],
    );
    if (run.rowCount !== 1) throw new Error("TEMPORAL_REPAIR_CONFLICT");
    for (const item of plan.rows) {
      const row = sourceById.get(item.memoryId);
      if (row === undefined) throw new Error("TEMPORAL_REPAIR_DRIFT");
      const beforeRow = {
        contentHash: row.content_hash,
        lifecycleStatus: row.lifecycle_status,
        legacyQuarantineReason: null,
        metadata: row.metadata,
      };
      let candidateId = item.candidateId ?? null;
      let candidateInserted: boolean | null = null;
      let afterRow: Record<string, unknown> | null = null;
      if (item.disposition === "migrate_candidate") {
        const candidateHash = item.candidateContentHash!;
        const evidenceIds = Array.isArray(row.metadata.sourceNodeIds)
          ? row.metadata.sourceNodeIds.filter((id) => typeof id === "string")
          : [];
        const inserted = await client.query<{ id: string }>(
          `/* temporal-prerequisite-repair:insert-candidate */
INSERT INTO mengshu_candidates (
  id, tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility,
  workspace_id, session_id, source_job_id, content_hash, active_content_hash,
  text, semantic_type, kind, confidence, reason, evidence_ids, extractor, status,
  hit_count, metadata, created_at, updated_at, last_hit_at, promoted_to_memory_id
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '', NULL, $10, $10, $11,
  $12, $13, $14, 'legacy pending lifecycle migration', $15::jsonb,
  'temporal-prerequisite-repair-v1', 'pending', 0, $16::jsonb, $17, NULL, NULL, NULL)
ON CONFLICT (tenant_id, user_id, app_id, project_id, agent_id, namespace,
  visibility, workspace_id, session_id, active_content_hash) DO NOTHING
RETURNING id`,
          [item.candidateId, row.tenant_id, row.user_id, row.product_id,
            row.canonical_project_id, row.producer_id, row.namespace, row.visibility,
            row.workspace_id ?? "", candidateHash, row.text, semanticType(row.metadata),
            row.category, typeof row.metadata.confidence === "number"
              ? Math.max(0, Math.min(1, row.metadata.confidence)) : 0.5,
            JSON.stringify(evidenceIds), JSON.stringify({
              temporalPrerequisiteRepair: { runId: plan.runId, sourceMemoryId: row.id },
            }), Number(row.created_at_ms)],
        );
        candidateInserted = inserted.rowCount === 1;
        if (candidateInserted) candidateId = inserted.rows[0]!.id;
        else {
          const existing = await client.query<{ id: string }>(
            `/* temporal-prerequisite-repair:find-candidate */
SELECT id FROM mengshu_candidates
WHERE tenant_id = $1 AND user_id = $2 AND app_id = $3 AND project_id = $4
  AND agent_id = $5 AND namespace = $6 AND visibility = $7
  AND workspace_id = $8 AND session_id = '' AND active_content_hash = $9`,
            [row.tenant_id, row.user_id, row.product_id, row.canonical_project_id,
              row.producer_id, row.namespace, row.visibility, row.workspace_id ?? "", candidateHash],
          );
          if (existing.rowCount !== 1) throw new Error("TEMPORAL_REPAIR_CONFLICT");
          candidateId = existing.rows[0]!.id;
        }
        afterRow = { candidateId, candidateInserted, quarantine: "migrated_to_candidate" };
      } else if (item.disposition === "quarantine_duplicate") {
        afterRow = { duplicateOf: item.duplicateOf, quarantine: "temporal_duplicate_content" };
      }
      if (afterRow !== null) {
        const quarantineReason = item.disposition === "migrate_candidate"
          ? "temporal_pending_migrated_to_candidate"
          : "temporal_duplicate_content";
        const patch = item.disposition === "migrate_candidate"
          ? { temporalPrerequisiteRepair: { runId: plan.runId, candidateId } }
          : { temporalPrerequisiteRepair: { runId: plan.runId, duplicateOf: item.duplicateOf } };
        const updated = await client.query(
          `/* temporal-prerequisite-repair:quarantine-memory */
UPDATE memories SET legacy_quarantine_reason = $1, metadata = metadata || $2::jsonb
WHERE id = $3::uuid AND content_hash = $4 AND lifecycle_status IS NOT DISTINCT FROM $5
  AND metadata = $6::jsonb AND lineage_id IS NULL AND legacy_quarantine_reason IS NULL
RETURNING id`,
          [quarantineReason, JSON.stringify(patch), row.id, row.content_hash,
            row.lifecycle_status, JSON.stringify(row.metadata)],
        );
        if (updated.rowCount !== 1) throw new Error("TEMPORAL_REPAIR_DRIFT");
      }
      const audit = await client.query(
        `/* temporal-prerequisite-repair:insert-row */
INSERT INTO mengshu_temporal_prerequisite_repair_rows (
  run_id, memory_id, disposition, duplicate_of, candidate_id, candidate_inserted,
  before_hash, after_hash, before_row, after_row, created_at
) VALUES ($1, $2::uuid, $3, $4::uuid, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11)
RETURNING memory_id`,
        [plan.runId, item.memoryId, item.disposition, item.duplicateOf ?? null,
          candidateId, candidateInserted, item.beforeHash, item.afterHash ?? null,
          JSON.stringify(beforeRow), afterRow === null ? null : JSON.stringify(afterRow),
          plan.createdAt],
      );
      if (audit.rowCount !== 1) throw new Error("TEMPORAL_REPAIR_CONFLICT");
    }
    const afterHash = digest("temporal-prerequisite-repair-result-v1", plan.rows.map((row) => row.afterHash));
    const finished = await client.query(
      `/* temporal-prerequisite-repair:finish-run */
UPDATE mengshu_temporal_prerequisite_repair_runs
SET after_hash = $1, state = 'applied', repaired_count = $2, updated_at = $3
WHERE run_id = $4 AND state = 'planned' RETURNING run_id`,
      [afterHash, plan.counts.repaired, plan.createdAt, plan.runId],
    );
    if (finished.rowCount !== 1) throw new Error("TEMPORAL_REPAIR_CONFLICT");
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve primary error */ }
    throw error;
  }
  return {
    runId: plan.runId,
    state: "applied",
    repaired: plan.counts.repaired,
    review: plan.counts.review,
    manifestHash: plan.manifestHash,
  };
}

export async function verifyPostgresTemporalPrerequisiteRepair(
  client: TemporalPrerequisiteRepairClient,
  plan: TemporalPrerequisiteRepairPlan,
  now: number,
): Promise<ExecuteTemporalPrerequisiteRepairResult> {
  const result = await client.query<{ repaired_count: string; review_count: string; mismatch_count: string }>(
    `/* temporal-prerequisite-repair:verify */
SELECT run.repaired_count::text, run.review_count::text,
  COUNT(*) FILTER (WHERE rows.disposition <> 'review_invalid_hash' AND (
    memories.legacy_quarantine_reason IS NULL OR
    (rows.disposition = 'migrate_candidate' AND candidates.id IS NULL) OR
    (rows.disposition = 'quarantine_duplicate' AND duplicates.lineage_id IS NULL)
  ))::text AS mismatch_count
FROM mengshu_temporal_prerequisite_repair_runs run
JOIN mengshu_temporal_prerequisite_repair_rows rows ON rows.run_id = run.run_id
JOIN memories ON memories.id = rows.memory_id
LEFT JOIN mengshu_candidates candidates ON candidates.id = rows.candidate_id
LEFT JOIN memories duplicates ON duplicates.id = rows.duplicate_of
WHERE run.run_id = $1 AND run.manifest_hash = $2 AND run.state IN ('applied', 'verified')
GROUP BY run.run_id, run.repaired_count, run.review_count`,
    [plan.runId, plan.manifestHash],
  );
  const row = result.rows[0];
  if (result.rowCount !== 1 || Number(row?.mismatch_count) !== 0 ||
      Number(row.repaired_count) !== plan.counts.repaired || Number(row.review_count) !== plan.counts.review) {
    throw new Error("TEMPORAL_REPAIR_VERIFY_FAILED");
  }
  await client.query(
    `/* temporal-prerequisite-repair:mark-verified */
UPDATE mengshu_temporal_prerequisite_repair_runs SET state = 'verified', updated_at = $1
WHERE run_id = $2 AND state = 'applied'`,
    [now, plan.runId],
  );
  return {
    runId: plan.runId,
    state: "verified",
    repaired: plan.counts.repaired,
    review: plan.counts.review,
    manifestHash: plan.manifestHash,
  };
}
