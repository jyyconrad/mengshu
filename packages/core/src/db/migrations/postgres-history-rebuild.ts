import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import {
  authorityScopeFingerprint,
  canonicalAuthorityScope,
} from "../../domain/authority-scope-fingerprint.js";
import { scopeToKey } from "../../domain/scope.js";
import type {
  MemoryKind,
  MemoryScope,
  MemorySemanticType,
} from "../../domain/types.js";
import {
  deriveDurableJobV2DomainDedupeKey,
  deriveDurableJobV2ScopedDedupeKey,
  type DurableJobV2Scope,
} from "../../storage/repositories/job-v2.js";
import { bufferId } from "../../tree/buffer.js";
import { normalizeTopicLabel, planTreeFanOut } from "../../tree/tree-fan-out.js";
import type {
  HistoryRebuildPlan,
  HistoryRebuildScanRow,
} from "./history-rebuild.js";

export interface PostgresHistoryRebuildQueryResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly rows: readonly Row[];
  readonly rowCount?: number | null;
}

export interface PostgresHistoryRebuildClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresHistoryRebuildQueryResult<Row>>;
}

export type HistoryRebuildSourceTable = "memories" | "knowledge";

export const HISTORY_REBUILD_TREE_ROUTING_POLICY_VERSION = "history-tree-routing/v2" as const;
export const HISTORY_REBUILD_TOPIC_TAXONOMY_VERSION = "scope-topic-taxonomy/v1" as const;
export const HISTORY_REBUILD_SOURCE_IDENTITY_VERSION = "auditable-source-identity/v1" as const;

export interface HistoryRebuildTopicTaxonomyEntry {
  readonly canonicalLabel: string;
  readonly aliases: readonly string[];
  readonly support: number;
}

export interface HistoryRebuildSourceIdentityFact {
  readonly recordId: string;
  readonly sourceHash: string;
  readonly kind: "document" | "import_batch" | "provenance";
  readonly identity: string;
  readonly receiptHash: string;
}

export interface HistoryRebuildTreeRoutingPolicy {
  readonly version: typeof HISTORY_REBUILD_TREE_ROUTING_POLICY_VERSION;
  readonly scopeFingerprint: string;
  readonly topic: Readonly<{
    version: typeof HISTORY_REBUILD_TOPIC_TAXONOMY_VERSION;
    minimumSupport: number;
    maxLabelsPerRecord: 1 | 2 | 3;
    taxonomy: readonly HistoryRebuildTopicTaxonomyEntry[];
  }>;
  readonly source: Readonly<{
    version: typeof HISTORY_REBUILD_SOURCE_IDENTITY_VERSION;
    identities: readonly HistoryRebuildSourceIdentityFact[];
  }>;
}

export interface HistoryRebuildTreeRoutingDecision {
  readonly policyVersion: typeof HISTORY_REBUILD_TREE_ROUTING_POLICY_VERSION;
  readonly policyHash: string;
  readonly scopeFingerprint: string;
  readonly source: Readonly<{
    eligible: boolean;
    reason: "plan_ineligible" | "audited_session_identity" |
      "audited_source_identity" | "missing_auditable_source_identity";
    kind?: "session" | HistoryRebuildSourceIdentityFact["kind"];
    treeKey?: string;
    identityReceiptHash?: string;
  }>;
  readonly topic: Readonly<{
    eligible: boolean;
    labels: readonly string[];
    droppedLabels: readonly string[];
    reason: "plan_ineligible" | "taxonomy_miss" | "below_minimum_support" |
      "canonical_topics_selected";
  }>;
  readonly receiptHash: string;
}

export interface ListHistoryRebuildScopesInput {
  readonly limit: number;
  readonly after?: MemoryScope;
}

export interface HistoryRebuildScopeSummary {
  readonly scope: MemoryScope;
  readonly memoriesCount: number;
  readonly knowledgeCount: number;
}

export interface CreateHistoryRebuildRunInput {
  readonly runId: string;
  readonly migrationId: string;
  readonly scope: MemoryScope;
  readonly manifestHash: string;
  readonly modelFingerprint: string;
  readonly promptHash: string;
  readonly schemaHash: string;
  readonly policyHash: string;
  readonly now: number;
}

export interface HistoryRebuildSourceSnapshot {
  readonly sourceTable: HistoryRebuildSourceTable;
  readonly sourceUpperBound: string | null;
  readonly sourceCount: number;
  readonly snapshotHash: string;
  readonly afterId?: string | null;
  readonly checkpointVersion?: number;
  readonly processedCount?: number;
  readonly checkpointState?: HistoryRebuildCheckpoint["state"];
}

export interface CreatedHistoryRebuildRun {
  readonly runId: string;
  readonly scopeFingerprint: string;
  readonly attemptHash: string;
  readonly state?: "running" | "completed";
  readonly snapshots: readonly HistoryRebuildSourceSnapshot[];
}

export interface ScanHistoryRebuildBatchInput {
  readonly runId: string;
  readonly scope: MemoryScope;
  readonly sourceTable: HistoryRebuildSourceTable;
  readonly afterId: string | null;
  readonly sourceUpperBound: string | null;
  readonly batchSize: number;
}

export interface HistoryRebuildFunnelCounts {
  readonly total: number;
  readonly preserve: number;
  readonly backfill: number;
  readonly modelClassify: number;
  readonly lookupOnly: number;
  readonly quarantine: number;
}

export interface HistoryRebuildModelReceiptInput {
  readonly receiptHash: string;
  readonly recordId: string;
  readonly sourceHash: string;
  readonly planReceiptHash: string;
  readonly modelFingerprint: string;
  readonly promptHash: string;
  readonly schemaHash: string;
  readonly inputHash: string;
  readonly outputHash: string;
  readonly confidence: number;
  readonly proposalCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ReadHistoryRebuildModelUsageInput {
  readonly migrationId: string;
  readonly manifestHash: string;
  readonly modelFingerprint: string;
  readonly promptHash: string;
  readonly schemaHash: string;
}

export interface HistoryRebuildPersistedModelUsage {
  readonly modelCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMinorUnits: number;
}

export interface HistoryRebuildModelAttemptIdentity {
  readonly migrationId: string;
  readonly manifestHash: string;
  readonly runId: string;
  readonly sourceTable: HistoryRebuildSourceTable;
  readonly recordId: string;
  readonly sourceHash: string;
  readonly attempt: number;
  readonly modelFingerprint: string;
  readonly promptHash: string;
  readonly schemaHash: string;
  readonly inputHash: string;
}

export interface HistoryRebuildModelAttemptUsage {
  readonly modelCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMinorUnits: number;
}

export interface ReserveHistoryRebuildModelAttemptInput extends HistoryRebuildModelAttemptIdentity {
  readonly usageCeiling: HistoryRebuildModelAttemptUsage;
  readonly budget: Readonly<{
    maxModelCalls: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    maxCostMinorUnits: number;
  }>;
  /** Only the migration-lock owner may advance past a reservation left by a dead operator. */
  readonly resumeUnresolved?: boolean;
  readonly now: number;
}

export interface CompleteHistoryRebuildModelAttemptInput extends HistoryRebuildModelAttemptIdentity {
  readonly result: Readonly<{
    version: 1;
    output: unknown;
    outputHash: string;
    usage: HistoryRebuildModelAttemptUsage;
  }>;
  readonly now: number;
}

export type HistoryRebuildModelAttemptReservation =
  | Readonly<{ state: "reserved" }>
  | Readonly<{ state: "in_flight_or_unknown" }>
  | Readonly<{ state: "retry_next_attempt" }>
  | Readonly<{ state: "budget_exceeded" }>
  | Readonly<{ state: "completed"; result: CompleteHistoryRebuildModelAttemptInput["result"] }>;

export type HistoryRebuildOperation = "plan" | "apply" | "verify" | "rollback";
export type HistoryRebuildOperationStatus =
  | "applied"
  | "verified"
  | "rolled_back"
  | "drifted"
  | "failed";

export interface HistoryRebuildOperationReceiptInput {
  readonly receiptHash: string;
  readonly operation: HistoryRebuildOperation;
  readonly status: HistoryRebuildOperationStatus;
  readonly counts: Readonly<Record<string, number>>;
  readonly driftHash?: string;
}

export interface HistoryRebuildBatchCommit {
  readonly runId: string;
  readonly scope: MemoryScope;
  readonly sourceTable: HistoryRebuildSourceTable;
  readonly expectedAfterId: string | null;
  readonly nextAfterId: string | null;
  readonly expectedCheckpointVersion: number;
  readonly counts: HistoryRebuildFunnelCounts;
  readonly sourceRows: readonly HistoryRebuildScanRow[];
  readonly plans: readonly HistoryRebuildPlan[];
  readonly modelReceipts: readonly HistoryRebuildModelReceiptInput[];
  readonly operationReceipt: HistoryRebuildOperationReceiptInput;
  readonly complete?: boolean;
  readonly now: number;
}

export interface HistoryRebuildCheckpoint {
  readonly afterId: string | null;
  readonly checkpointVersion: number;
  readonly state: "running" | "completed" | "rolled_back" | "drifted" | "failed";
}

export interface ExecuteHistoryRebuildRunInput {
  readonly runId: string;
  readonly scope: MemoryScope;
  readonly now: number;
  readonly treePolicy?: HistoryRebuildTreeRoutingPolicy;
}

export interface VerifyHistoryRebuildRunInput {
  readonly runId: string;
  readonly scope: MemoryScope;
  readonly treePolicy?: HistoryRebuildTreeRoutingPolicy;
}

export interface AppliedHistoryRebuildRun {
  readonly active: number;
  readonly lookupOnly: number;
  readonly classifiedInactive: number;
  readonly evidenceMirrors: number;
  readonly evidenceLinks: number;
  readonly treeJobs: number;
}

export interface VerifiedHistoryRebuildRun {
  readonly totalSourceCount: number;
  readonly memorySourceCount: number;
  readonly knowledgeSourceCount: number;
  readonly totalPlanCount: number;
  readonly memoryPlanCount: number;
  readonly knowledgePlanCount: number;
  readonly appliedMemoryCount: number;
  readonly unchangedKnowledgeCount: number;
  readonly evidenceMirrors: number;
  readonly evidenceLinks: number;
  readonly treeJobs: number;
  readonly queuedTreeJobs: number;
  readonly completedTreeJobs: number;
  readonly deadLetterTreeJobs: number;
}

export interface RolledBackHistoryRebuildRun {
  readonly restored: number;
  readonly removedEvidenceMirrors: number;
  readonly removedTreeJobs: number;
}

export type HistoryRebuildRepositoryErrorCode =
  | "HISTORY_REBUILD_INVALID_INPUT"
  | "HISTORY_REBUILD_INVALID_DB_RESULT"
  | "HISTORY_REBUILD_CONCURRENT_DRIFT"
  | "HISTORY_REBUILD_DATABASE_FAILED";

export class HistoryRebuildRepositoryError extends Error {
  constructor(readonly code: HistoryRebuildRepositoryErrorCode) {
    super(code);
    this.name = "HistoryRebuildRepositoryError";
  }
}

const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SOURCE_TABLES = Object.freeze(["memories", "knowledge"] as const);
const MEMORY_KINDS = new Set<MemoryKind>([
  "preference", "decision", "entity", "fact", "task", "plan", "goal",
  "document", "knowledge", "observation", "other",
]);
const SEMANTIC_TYPES = new Set<MemorySemanticType>([
  "profile", "task_context", "rules", "experience", "resource",
]);

const RUN_INSERT_SQL = `/* history-rebuild:run-insert */
INSERT INTO mengshu_history_rebuild_runs (
  run_id, migration_id, scope_fingerprint, tenant_id, user_id, project_id, app_id,
  agent_id, namespace, visibility, workspace_id, session_id, manifest_hash,
  model_fingerprint, prompt_hash, schema_hash, policy_hash, attempt_hash,
  state, created_at, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
  $13, $14, $15, $16, $17, $18, 'running', $19, $19)
ON CONFLICT DO NOTHING`;

const RESUMABLE_RUN_SQL = `/* history-rebuild:resumable-run */
SELECT run_id, state
FROM mengshu_history_rebuild_runs
WHERE migration_id = $1 AND scope_fingerprint = $2 AND attempt_hash = $3
  AND manifest_hash = $4 AND model_fingerprint = $5 AND prompt_hash = $6
  AND schema_hash = $7 AND policy_hash = $8
  AND state IN ('running', 'completed')`;

const RESUMABLE_SNAPSHOTS_SQL = `/* history-rebuild:resumable-snapshots */
SELECT snapshot.source_table, snapshot.source_upper_bound::text,
  snapshot.source_count::text, snapshot.snapshot_hash,
  checkpoint.after_id::text, checkpoint.checkpoint_version::text,
  checkpoint.state AS checkpoint_state,
  (SELECT COUNT(*)::text FROM mengshu_history_rebuild_source_rows source
   WHERE source.run_id = snapshot.run_id
     AND source.source_table = snapshot.source_table) AS processed_count
FROM mengshu_history_rebuild_source_snapshots snapshot
JOIN mengshu_history_rebuild_checkpoints checkpoint
  USING (run_id, source_table)
WHERE snapshot.run_id = $1
ORDER BY snapshot.source_table DESC`;

const SNAPSHOT_INSERT_SQL = `/* history-rebuild:snapshot-insert */
INSERT INTO mengshu_history_rebuild_source_snapshots (
  run_id, source_table, source_upper_bound, source_count, snapshot_hash, captured_at
) VALUES ($1, $2, $3::uuid, $4, $5, $6)
ON CONFLICT DO NOTHING`;

const CHECKPOINT_INSERT_SQL = `/* history-rebuild:checkpoint-insert */
INSERT INTO mengshu_history_rebuild_checkpoints (
  run_id, source_table, after_id, checkpoint_version, counts, state, updated_at
) VALUES ($1, $2, NULL, 0, $3::jsonb, 'running', $4)
ON CONFLICT DO NOTHING`;

const CHECKPOINT_LOCK_SQL = `/* history-rebuild:checkpoint-lock */
SELECT after_id::text, checkpoint_version::text, checkpoint.state
FROM mengshu_history_rebuild_checkpoints checkpoint
JOIN mengshu_history_rebuild_runs run ON run.run_id = checkpoint.run_id
WHERE checkpoint.run_id = $1 AND checkpoint.source_table = $2
  AND run.scope_fingerprint = $3
FOR UPDATE OF checkpoint`;

const SOURCE_ROW_SNAPSHOT_SQL = `/* history-rebuild:source-row-snapshot */
INSERT INTO mengshu_history_rebuild_source_rows (
  run_id, source_table, record_id, source_hash, source_row,
  original_text, original_metadata, original_metadata_hash, original_lifecycle_status, captured_at
) SELECT $1, $2, input.record_id::uuid, input.source_hash, input.source_row,
  input.original_text, input.original_metadata, input.original_metadata_hash,
  input.original_lifecycle_status, $4
FROM jsonb_to_recordset($3::jsonb) AS input(
  record_id text,
  source_hash text,
  source_row jsonb,
  original_text text,
  original_metadata jsonb,
  original_metadata_hash text,
  original_lifecycle_status text
)
ON CONFLICT DO NOTHING`;

const SHADOW_PLAN_SQL = `/* history-rebuild:shadow-plan */
INSERT INTO mengshu_history_rebuild_shadow_plans (
  run_id, source_table, record_id, source_hash, disposition, semantic_type,
  topic_labels, context_eligible, tree_eligibility, reason, plan_receipt_hash, created_at
) SELECT $1, $2, input.record_id::uuid, input.source_hash, input.disposition,
  input.semantic_type, input.topic_labels, input.context_eligible,
  input.tree_eligibility, input.reason, input.plan_receipt_hash, $4
FROM jsonb_to_recordset($3::jsonb) AS input(
  record_id text,
  source_hash text,
  disposition text,
  semantic_type text,
  topic_labels jsonb,
  context_eligible boolean,
  tree_eligibility jsonb,
  reason text,
  plan_receipt_hash text
)
ON CONFLICT DO NOTHING`;

const MODEL_RECEIPT_SQL = `/* history-rebuild:model-receipt */
INSERT INTO mengshu_history_rebuild_model_receipts (
  receipt_hash, run_id, source_table, record_id, source_hash, model_fingerprint,
  prompt_hash, schema_hash, input_hash, output_hash, confidence, proposal_count,
  input_tokens, output_tokens, created_at
) SELECT $1, $2, $3, $4::uuid, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $16
FROM mengshu_history_rebuild_runs run
JOIN mengshu_history_rebuild_shadow_plans plan
  ON plan.run_id = run.run_id AND plan.source_table = $3 AND plan.record_id = $4::uuid
WHERE run.run_id = $2 AND run.state = 'running'
  AND run.model_fingerprint = $6 AND run.prompt_hash = $7 AND run.schema_hash = $8
  AND plan.source_hash = $5 AND plan.plan_receipt_hash = $15
ON CONFLICT DO NOTHING`;

const MODEL_USAGE_SQL = `/* history-rebuild:model-usage */
SELECT
  COUNT(attempt.*)::text AS model_calls,
  COALESCE(SUM(CASE WHEN attempt.state = 'completed' THEN attempt.actual_input_tokens
    ELSE attempt.reserved_input_tokens END), 0)::text AS input_tokens,
  COALESCE(SUM(CASE WHEN attempt.state = 'completed' THEN attempt.actual_output_tokens
    ELSE attempt.reserved_output_tokens END), 0)::text AS output_tokens,
  COALESCE(SUM(CASE WHEN attempt.state = 'completed' THEN attempt.actual_cost_minor_units
    ELSE attempt.reserved_cost_minor_units END), 0)::text AS cost_minor_units,
  COUNT(attempt.*) FILTER (WHERE run.run_id IS NULL OR run.migration_id <> $1 OR
    run.manifest_hash <> $2 OR run.model_fingerprint <> $3 OR run.prompt_hash <> $4 OR
    run.schema_hash <> $5 OR attempt.model_fingerprint <> $3 OR
    attempt.prompt_hash <> $4 OR attempt.schema_hash <> $5)::text AS binding_drift_count
FROM mengshu_history_rebuild_model_attempts attempt
LEFT JOIN mengshu_history_rebuild_runs run ON run.run_id = attempt.run_id
WHERE attempt.migration_id = $1 AND attempt.manifest_hash = $2`;

const MODEL_ATTEMPT_ADVISORY_LOCK_SQL = `/* history-rebuild:model-attempt-lock */
SELECT pg_advisory_xact_lock(hashtextextended(concat_ws(chr(31),
  'mengshu.history-rebuild-model-attempt/v1', $1::text, $2::text), 0))`;

const MODEL_ATTEMPT_READ_SQL = `/* history-rebuild:model-attempt-read */
SELECT migration_id, manifest_hash, run_id, source_table, record_id::text, source_hash,
  attempt::text, model_fingerprint, prompt_hash, schema_hash, input_hash, state,
  reserved_input_tokens::text, reserved_output_tokens::text,
  reserved_cost_minor_units::text, output, output_hash, actual_input_tokens::text,
  actual_output_tokens::text, actual_cost_minor_units::text
FROM mengshu_history_rebuild_model_attempts
WHERE run_id = $1 AND source_table = $2 AND record_id = $3::uuid AND attempt = $4`;

const MODEL_ATTEMPT_BUDGET_SQL = `/* history-rebuild:model-attempt-budget */
SELECT COUNT(*)::text AS model_calls,
  COALESCE(SUM(CASE WHEN state = 'completed' THEN actual_input_tokens
    ELSE reserved_input_tokens END), 0)::text AS input_tokens,
  COALESCE(SUM(CASE WHEN state = 'completed' THEN actual_output_tokens
    ELSE reserved_output_tokens END), 0)::text AS output_tokens,
  COALESCE(SUM(CASE WHEN state = 'completed' THEN actual_cost_minor_units
    ELSE reserved_cost_minor_units END), 0)::text AS cost_minor_units
FROM mengshu_history_rebuild_model_attempts
WHERE migration_id = $1 AND manifest_hash = $2`;

const MODEL_ATTEMPT_INSERT_SQL = `/* history-rebuild:model-attempt-reserve */
INSERT INTO mengshu_history_rebuild_model_attempts (
  migration_id, manifest_hash, run_id, source_table, record_id, source_hash, attempt,
  model_fingerprint, prompt_hash, schema_hash, input_hash, state, reserved_input_tokens,
  reserved_output_tokens, reserved_cost_minor_units, reserved_at
) SELECT $1, $2, $3, $4, $5::uuid, $6, $7, $8, $9, $10, $11, 'reserved',
  $12, $13, $14, $15
FROM mengshu_history_rebuild_runs run
WHERE run.run_id = $3 AND run.migration_id = $1 AND run.manifest_hash = $2
  AND run.model_fingerprint = $8 AND run.prompt_hash = $9 AND run.schema_hash = $10
  AND run.state = 'running'
ON CONFLICT DO NOTHING`;

const MODEL_ATTEMPT_COMPLETE_SQL = `/* history-rebuild:model-attempt-complete */
UPDATE mengshu_history_rebuild_model_attempts SET state = 'completed', output = $12::jsonb,
  output_hash = $13, actual_input_tokens = $14, actual_output_tokens = $15,
  actual_cost_minor_units = $16, completed_at = $17
WHERE migration_id = $1 AND manifest_hash = $2 AND run_id = $3 AND source_table = $4
  AND record_id = $5::uuid AND source_hash = $6 AND attempt = $7
  AND model_fingerprint = $8 AND prompt_hash = $9 AND schema_hash = $10
  AND input_hash = $11 AND state = 'reserved'`;

const OPERATION_RECEIPT_SQL = `/* history-rebuild:operation-receipt */
INSERT INTO mengshu_history_rebuild_operation_receipts (
  receipt_hash, run_id, source_table, operation, status, counts,
  result_hash, drift_hash, created_at
) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
ON CONFLICT DO NOTHING`;

const CHECKPOINT_CAS_SQL = `/* history-rebuild:checkpoint-cas */
UPDATE mengshu_history_rebuild_checkpoints SET
  after_id = $3::uuid,
  checkpoint_version = checkpoint_version + 1,
  counts = $4::jsonb,
  state = $5,
  updated_at = GREATEST(updated_at, $6)
WHERE run_id = $1 AND source_table = $2
  AND checkpoint_version = $7
  AND after_id IS NOT DISTINCT FROM $8::uuid`;

const RUN_LOCK_SQL = `/* history-rebuild:run-lock */
SELECT state, policy_hash FROM mengshu_history_rebuild_runs
WHERE run_id = $1 AND scope_fingerprint = $2
FOR UPDATE`;

const RUN_STATE_SQL = `/* history-rebuild:run-state */
SELECT state, policy_hash FROM mengshu_history_rebuild_runs
WHERE run_id = $1 AND scope_fingerprint = $2`;

const FROZEN_MATERIAL_SQL = `/* history-rebuild:frozen-material */
SELECT source.source_table, source.record_id::text, source.source_hash, source.source_row,
  jsonb_strip_nulls(jsonb_build_object(
    'sourceTable', plan.source_table,
    'recordId', plan.record_id::text,
    'sourceHash', plan.source_hash,
    'disposition', plan.disposition,
    'semanticType', plan.semantic_type,
    'topicLabels', plan.topic_labels,
    'contextEligible', plan.context_eligible,
    'treeEligibility', plan.tree_eligibility,
    'reason', plan.reason,
    'receiptHash', plan.plan_receipt_hash
  )) AS plan
FROM mengshu_history_rebuild_source_rows source
JOIN mengshu_history_rebuild_shadow_plans plan USING (run_id, source_table, record_id, source_hash)
JOIN mengshu_history_rebuild_runs run USING (run_id)
WHERE source.run_id = $1 AND run.scope_fingerprint = $2
  AND source.source_table = 'memories'
ORDER BY source.source_table, source.record_id`;

const MATERIAL_CTES_SQL = `material AS (
  SELECT item, item->'source' AS source, item->'plan' AS plan,
    item->'resultingMetadata' AS resulting_metadata,
    item->>'resultingLifecycleStatus' AS resulting_lifecycle_status,
    item->>'evidenceId' AS evidence_id,
    item->>'evidenceContentHash' AS evidence_content_hash,
    item->>'evidenceLinkId' AS evidence_link_id,
    item->'evidenceMetadata' AS evidence_metadata,
    COALESCE(item->'treeJobs', '[]'::jsonb) AS tree_jobs
  FROM jsonb_array_elements($13::jsonb) item
), expected_tree_jobs AS (
  SELECT source->>'recordId' AS record_id, source->>'sourceHash' AS source_hash,
    job->>'id' AS expected_id, job->>'artifactRole' AS artifact_role,
    job->>'dedupeKey' AS dedupe_key, job->>'scopedDedupeKey' AS scoped_dedupe_key,
    (job->>'maxAttempts')::integer AS max_attempts, job->'payload' AS payload
  FROM material CROSS JOIN LATERAL jsonb_array_elements(tree_jobs) job
), expected_artifacts AS (
  SELECT source->>'recordId' AS record_id, source->>'sourceHash' AS source_hash,
    'evidence_memory'::text AS artifact_type, evidence_id AS artifact_id,
    'evidence_mirror'::text AS artifact_role
  FROM material WHERE evidence_id IS NOT NULL
  UNION ALL
  SELECT source->>'recordId', source->>'sourceHash', 'evidence_link', evidence_link_id, 'grounded_by'
  FROM material WHERE evidence_link_id IS NOT NULL
)`;

const SOURCE_CAS_SQL = `memory.id = (material.source->>'recordId')::uuid
    AND memory.tenant_id = $3 AND memory.user_id = $4
    AND memory.canonical_project_id = $5 AND memory.product_id = $6
    AND memory.producer_id = $7 AND memory.namespace = $8 AND memory.visibility = $9
    AND COALESCE(memory.workspace_id, '') = $10
    AND COALESCE(memory.metadata->>'sessionId', '') = $11
    AND memory.text = material.source->>'text'
    AND memory.content_hash = material.source->>'contentHash'
    AND memory.vector::text::jsonb = material.source->'vector'
    AND memory.importance IS NOT DISTINCT FROM
      (material.source->>'importance')::double precision
    AND memory.category = material.source->>'category'
    AND memory.data_type = material.source->>'dataType'
    AND memory.metadata = material.source->'metadata'
    AND memory.lifecycle_status IS NOT DISTINCT FROM material.source->>'lifecycleStatus'
    AND floor(extract(epoch FROM memory.created_at) * 1000)::bigint =
      (material.source->>'createdAt')::bigint
    AND memory.embedding_space_id IS NOT DISTINCT FROM material.source->>'embeddingSpaceId'
    AND memory.embedding_space_state IS NOT DISTINCT FROM material.source->>'embeddingSpaceState'`;

const KNOWLEDGE_PARITY_SQL = `SELECT COUNT(*) FROM mengshu_history_rebuild_source_rows source
  JOIN knowledge record ON record.id = source.record_id
    AND record.tenant_id = $3 AND record.user_id = $4
    AND record.canonical_project_id = $5 AND record.product_id = $6
    AND record.producer_id = $7 AND record.namespace = $8 AND record.visibility = $9
    AND COALESCE(record.workspace_id, '') = $10
    AND COALESCE(record.metadata->>'sessionId', '') = $11
    AND record.text = source.source_row->>'text'
    AND record.content_hash = source.source_row->>'contentHash'
    AND record.vector::text::jsonb = source.source_row->'vector'
    AND record.importance IS NOT DISTINCT FROM
      (source.source_row->>'importance')::double precision
    AND record.category = source.source_row->>'category'
    AND record.data_type = source.source_row->>'dataType'
    AND record.metadata = source.source_row->'metadata'
    AND record.lifecycle_status IS NOT DISTINCT FROM source.source_row->>'lifecycleStatus'
    AND floor(extract(epoch FROM record.created_at) * 1000)::bigint =
      (source.source_row->>'createdAt')::bigint
    AND record.embedding_space_id IS NOT DISTINCT FROM source.source_row->>'embeddingSpaceId'
    AND record.embedding_space_state IS NOT DISTINCT FROM source.source_row->>'embeddingSpaceState'
  WHERE source.run_id = $1 AND source.source_table = 'knowledge'`;

const APPLY_RUN_SQL = `/* history-rebuild:apply */
WITH ${MATERIAL_CTES_SQL}, updated AS (
  UPDATE memories memory SET metadata = material.resulting_metadata,
    lifecycle_status = material.resulting_lifecycle_status
  FROM material WHERE ${SOURCE_CAS_SQL}
  RETURNING memory.id::text
), inserted_evidence AS (
  /* history-rebuild:evidence-mirrors */
  INSERT INTO memories (
    id, text, content_hash, vector, importance, category, data_type, metadata, created_at,
    project_name, app_name, user_id, agent_id, workspace_id,
    tenant_id, canonical_project_id, product_id, producer_id, namespace, visibility,
    scope_key, lifecycle_status, embedding_space_id, embedding_space_state
  )
  SELECT material.evidence_id::uuid, material.source->>'text', material.evidence_content_hash,
    (material.source->'vector')::text::vector,
    (material.evidence_metadata->>'importance')::double precision, 'core', 'memory',
    material.evidence_metadata, to_timestamp((material.source->>'createdAt')::double precision / 1000),
    $5, $6, $4, $7, NULLIF($10, ''), $3, $5, $6, $7, $8, $9, $14, 'archived',
    NULLIF(material.source->>'embeddingSpaceId', ''),
    NULLIF(material.source->>'embeddingSpaceState', '')
  FROM material JOIN updated ON updated.id = material.source->>'recordId'
  WHERE material.evidence_id IS NOT NULL
  ON CONFLICT DO NOTHING RETURNING id::text
), inserted_links AS (
  INSERT INTO mengshu_memory_evidence_links (
    link_id, scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id,
    namespace, visibility, workspace_id, session_id, target_memory_id,
    evidence_memory_id, link_kind, source, created_at
  )
  SELECT material.evidence_link_id, $2, $3, $4, $6, $5, $7, $8, $9, $10, $11,
    material.source->>'recordId', material.evidence_id, 'grounded_by',
    'history_rebuild:' || $1, $12
  FROM material JOIN inserted_evidence ON inserted_evidence.id = material.evidence_id
  ON CONFLICT DO NOTHING RETURNING link_id
), inserted_jobs AS (
  INSERT INTO mengshu_jobs_v2 (
    id, type, payload, dedupe_key, scoped_dedupe_key, tenant_id, user_id, app_id,
    project_id, agent_id, namespace, visibility, status, attempts, lease_generation,
    max_attempts, created_at, updated_at
  )
  SELECT job->>'id', 'build_tree', job->'payload', job->>'dedupeKey',
    job->>'scopedDedupeKey', $3, $4, $6, $5, $7, $8, $9,
    'queued', 0, 0, (job->>'maxAttempts')::integer, $12, $12
  FROM material JOIN updated ON updated.id = material.source->>'recordId'
  CROSS JOIN LATERAL jsonb_array_elements(material.tree_jobs) job
  ON CONFLICT (scoped_dedupe_key) DO UPDATE SET
    id = EXCLUDED.id,
    payload = EXCLUDED.payload,
    dedupe_key = EXCLUDED.dedupe_key,
    max_attempts = EXCLUDED.max_attempts,
    updated_at = EXCLUDED.updated_at
  WHERE mengshu_jobs_v2.type = 'build_tree'
    AND mengshu_jobs_v2.id LIKE 'history-job:%'
    AND EXCLUDED.id LIKE 'history-job:%'
    AND mengshu_jobs_v2.dedupe_key = EXCLUDED.dedupe_key
    AND mengshu_jobs_v2.tenant_id = EXCLUDED.tenant_id
    AND mengshu_jobs_v2.user_id = EXCLUDED.user_id
    AND mengshu_jobs_v2.app_id = EXCLUDED.app_id
    AND mengshu_jobs_v2.project_id = EXCLUDED.project_id
    AND mengshu_jobs_v2.agent_id = EXCLUDED.agent_id
    AND mengshu_jobs_v2.namespace = EXCLUDED.namespace
    AND mengshu_jobs_v2.visibility = EXCLUDED.visibility
    AND mengshu_jobs_v2.status = 'queued'
    AND mengshu_jobs_v2.attempts = 0
    AND mengshu_jobs_v2.lease_generation = 0
    AND mengshu_jobs_v2.max_attempts = EXCLUDED.max_attempts
    AND mengshu_jobs_v2.next_attempt_at IS NULL
    AND mengshu_jobs_v2.lease_owner IS NULL
    AND mengshu_jobs_v2.lease_token IS NULL
    AND mengshu_jobs_v2.lease_until IS NULL
    AND mengshu_jobs_v2.heartbeat_at IS NULL
    AND mengshu_jobs_v2.last_error_code IS NULL
    AND mengshu_jobs_v2.last_error_retryable IS NULL
    AND mengshu_jobs_v2.last_error_fingerprint IS NULL
    AND NOT EXISTS (SELECT 1 FROM mengshu_candidates candidate
      WHERE candidate.source_job_id = mengshu_jobs_v2.id)
    AND NOT EXISTS (SELECT 1 FROM mengshu_graph_entity_resolution_ledger ledger
      WHERE ledger.job_id = mengshu_jobs_v2.id)
    AND NOT EXISTS (SELECT 1 FROM mengshu_graph_relation_resolution_ledger ledger
      WHERE ledger.job_id = mengshu_jobs_v2.id)
    AND NOT EXISTS (SELECT 1 FROM mengshu_job_v2_effect_receipts receipt
      WHERE receipt.job_id = mengshu_jobs_v2.id)
    AND NOT EXISTS (SELECT 1 FROM mengshu_tree_leaves leaf
      WHERE leaf.source_job_id = mengshu_jobs_v2.id)
    AND NOT EXISTS (SELECT 1 FROM mengshu_tree_summary_nodes node
      WHERE node.sealed_by_job_id = mengshu_jobs_v2.id)
  RETURNING id, scoped_dedupe_key
), resolved_jobs AS (
  SELECT expected.record_id, expected.source_hash, expected.artifact_role,
    inserted.id AS artifact_id
  FROM expected_tree_jobs expected
  JOIN inserted_jobs inserted ON inserted.scoped_dedupe_key = expected.scoped_dedupe_key
    AND inserted.id = expected.expected_id
  UNION ALL
  SELECT expected.record_id, expected.source_hash, expected.artifact_role,
    actual.id AS artifact_id
  FROM expected_tree_jobs expected
  JOIN mengshu_jobs_v2 actual ON actual.scoped_dedupe_key = expected.scoped_dedupe_key
    AND actual.type = 'build_tree' AND actual.payload = expected.payload
    AND actual.dedupe_key = expected.dedupe_key
    AND actual.max_attempts = expected.max_attempts
    AND actual.status = 'completed'
    AND actual.tenant_id = $3 AND actual.user_id = $4 AND actual.app_id = $6
    AND actual.project_id = $5 AND actual.agent_id = $7 AND actual.namespace = $8
    AND actual.visibility = $9
  JOIN mengshu_job_v2_effect_receipts reusable_receipt
    ON reusable_receipt.job_id = actual.id
    AND reusable_receipt.effect_key = 'build_tree.persist.v1'
  WHERE NOT EXISTS (
    SELECT 1 FROM inserted_jobs inserted
    WHERE inserted.scoped_dedupe_key = expected.scoped_dedupe_key
  )
), inserted_artifacts AS (
  INSERT INTO mengshu_history_rebuild_artifacts (
    run_id, source_table, record_id, artifact_type, artifact_id,
    artifact_role, source_hash, created_at
  )
  SELECT $1, 'memories', expected.record_id::uuid, expected.artifact_type,
    expected.artifact_id, expected.artifact_role, expected.source_hash, $12
  FROM expected_artifacts expected
  WHERE (expected.artifact_type = 'evidence_memory' AND
      EXISTS (SELECT 1 FROM inserted_evidence item WHERE item.id = expected.artifact_id))
    OR (expected.artifact_type = 'evidence_link' AND
      EXISTS (SELECT 1 FROM inserted_links item WHERE item.link_id = expected.artifact_id))
  UNION ALL
  SELECT $1, 'memories', resolved.record_id::uuid, 'tree_job', resolved.artifact_id,
    resolved.artifact_role, resolved.source_hash, $12
  FROM resolved_jobs resolved
  ON CONFLICT DO NOTHING RETURNING artifact_type, artifact_id
), counts AS (
  SELECT
    COUNT(*) FILTER (WHERE plan->>'contextEligible' = 'true' AND
      resulting_lifecycle_status = 'active') AS active_count,
    COUNT(*) FILTER (WHERE plan->>'disposition' = 'lookup_only') AS lookup_only_count,
    COUNT(*) FILTER (WHERE NOT (plan->>'contextEligible' = 'true' AND
      resulting_lifecycle_status = 'active') AND plan->>'disposition' <> 'lookup_only')
      AS classified_inactive_count,
    COUNT(*) FILTER (WHERE evidence_id IS NOT NULL) AS expected_evidence_mirror_count,
    COUNT(*) FILTER (WHERE evidence_link_id IS NOT NULL) AS expected_evidence_link_count,
    COALESCE(SUM(jsonb_array_length(tree_jobs)), 0) AS expected_tree_job_count
  FROM material
), gate AS (
  SELECT counts.*,
    (SELECT COUNT(*) FROM updated) AS updated_count,
    (SELECT COUNT(*) FROM inserted_evidence) AS evidence_mirror_count,
    (SELECT COUNT(*) FROM inserted_links) AS evidence_link_count,
    (SELECT COUNT(*) FROM resolved_jobs) AS tree_job_count,
    (SELECT COUNT(*) FROM inserted_artifacts) AS artifact_count,
    (SELECT COUNT(*) FROM mengshu_history_rebuild_checkpoints
      WHERE run_id = $1 AND state = 'completed') AS completed_checkpoint_count,
    (SELECT COALESCE(SUM(source_count), 0) FROM mengshu_history_rebuild_source_snapshots
      WHERE run_id = $1) AS snapshot_count,
    (SELECT COUNT(*) FROM mengshu_history_rebuild_source_rows WHERE run_id = $1) AS source_count,
    (SELECT COUNT(*) FROM mengshu_history_rebuild_shadow_plans WHERE run_id = $1) AS plan_count,
    (SELECT COUNT(*) FROM mengshu_history_rebuild_source_rows
      WHERE run_id = $1 AND source_table = 'knowledge') AS knowledge_source_count,
    (${KNOWLEDGE_PARITY_SQL}) AS unchanged_knowledge_count
  FROM counts
), receipt AS (
  INSERT INTO mengshu_history_rebuild_operation_receipts (
    receipt_hash, run_id, source_table, operation, status, counts,
    result_hash, drift_hash, created_at
  )
  SELECT encode(sha256(convert_to(concat_ws(chr(31), 'history-apply/v2', $1, $2), 'UTF8')), 'hex'),
    $1, 'memories', 'apply', 'applied', jsonb_build_object(
      'active', active_count, 'lookupOnly', lookup_only_count,
      'classifiedInactive', classified_inactive_count,
      'evidenceMirrors', evidence_mirror_count, 'evidenceLinks', evidence_link_count,
      'treeJobs', tree_job_count),
    encode(sha256(convert_to(concat_ws(chr(31), $1, updated_count::text,
      artifact_count::text), 'UTF8')), 'hex'), NULL, $12
  FROM gate WHERE completed_checkpoint_count = 2 AND snapshot_count = source_count
    AND source_count = plan_count AND updated_count = jsonb_array_length($13::jsonb)
    AND evidence_mirror_count = expected_evidence_mirror_count
    AND evidence_link_count = expected_evidence_link_count
    AND tree_job_count = expected_tree_job_count
    AND artifact_count = expected_evidence_mirror_count + expected_evidence_link_count +
      expected_tree_job_count AND unchanged_knowledge_count = knowledge_source_count
  ON CONFLICT DO NOTHING RETURNING receipt_hash
), completed_run AS (
  UPDATE mengshu_history_rebuild_runs SET state = 'completed', updated_at = $12
  FROM gate WHERE run_id = $1 AND scope_fingerprint = $2 AND state = 'running'
    AND completed_checkpoint_count = 2 AND snapshot_count = source_count
    AND source_count = plan_count AND updated_count = jsonb_array_length($13::jsonb)
    AND evidence_mirror_count = expected_evidence_mirror_count
    AND evidence_link_count = expected_evidence_link_count
    AND tree_job_count = expected_tree_job_count
    AND artifact_count = expected_evidence_mirror_count + expected_evidence_link_count +
      expected_tree_job_count AND unchanged_knowledge_count = knowledge_source_count
  RETURNING run_id
)
SELECT active_count::text, lookup_only_count::text, classified_inactive_count::text,
  evidence_mirror_count::text, evidence_link_count::text, tree_job_count::text,
  expected_evidence_mirror_count::text, expected_evidence_link_count::text,
  expected_tree_job_count::text,
  CASE WHEN (SELECT COUNT(*) FROM receipt) = 1 AND
    (SELECT COUNT(*) FROM completed_run) = 1 THEN '0' ELSE '1' END AS drift_count
FROM gate`;

const VERIFY_RUN_SQL = `/* history-rebuild:verify */
WITH ${MATERIAL_CTES_SQL}, exact_run AS (
  SELECT run_id FROM mengshu_history_rebuild_runs
  WHERE run_id = $1 AND scope_fingerprint = $2 AND state = 'completed'
    AND $12::bigint = 0
), source_counts AS (
  SELECT COUNT(*) AS total_source_count,
    COUNT(*) FILTER (WHERE source_table = 'memories') AS memory_source_count,
    COUNT(*) FILTER (WHERE source_table = 'knowledge') AS knowledge_source_count
  FROM mengshu_history_rebuild_source_rows WHERE run_id IN (SELECT run_id FROM exact_run)
), plan_counts AS (
  SELECT COUNT(*) AS total_plan_count,
    COUNT(*) FILTER (WHERE source_table = 'memories') AS memory_plan_count,
    COUNT(*) FILTER (WHERE source_table = 'knowledge') AS knowledge_plan_count
  FROM mengshu_history_rebuild_shadow_plans WHERE run_id IN (SELECT run_id FROM exact_run)
), memory_parity AS (
  SELECT COUNT(*) AS applied_memory_count FROM material
  JOIN memories memory ON memory.id = (material.source->>'recordId')::uuid
    AND memory.tenant_id = $3 AND memory.user_id = $4
    AND memory.canonical_project_id = $5 AND memory.product_id = $6
    AND memory.producer_id = $7 AND memory.namespace = $8 AND memory.visibility = $9
    AND COALESCE(memory.workspace_id, '') = $10
    AND COALESCE(memory.metadata->>'sessionId', '') = $11
    AND memory.text = material.source->>'text'
    AND memory.content_hash = material.source->>'contentHash'
    AND memory.vector::text::jsonb = material.source->'vector'
    AND memory.importance IS NOT DISTINCT FROM
      (material.source->>'importance')::double precision
    AND memory.category = material.source->>'category'
    AND memory.data_type = material.source->>'dataType'
    AND floor(extract(epoch FROM memory.created_at) * 1000)::bigint =
      (material.source->>'createdAt')::bigint
    AND memory.embedding_space_id IS NOT DISTINCT FROM material.source->>'embeddingSpaceId'
    AND memory.embedding_space_state IS NOT DISTINCT FROM material.source->>'embeddingSpaceState'
    AND memory.metadata = material.resulting_metadata
    AND memory.lifecycle_status IS NOT DISTINCT FROM material.resulting_lifecycle_status
), expected_artifacts_with_jobs AS (
  SELECT * FROM expected_artifacts
  UNION ALL
  SELECT expected.record_id, expected.source_hash, 'tree_job', ledger.artifact_id,
    expected.artifact_role
  FROM expected_tree_jobs expected
  LEFT JOIN mengshu_jobs_v2 job ON job.scoped_dedupe_key = expected.scoped_dedupe_key
    AND job.type = 'build_tree' AND job.payload = expected.payload
    AND job.dedupe_key = expected.dedupe_key
    AND job.max_attempts = expected.max_attempts
    AND job.tenant_id = $3 AND job.user_id = $4 AND job.app_id = $6
    AND job.project_id = $5 AND job.agent_id = $7 AND job.namespace = $8
    AND job.visibility = $9
  LEFT JOIN mengshu_history_rebuild_artifacts ledger ON ledger.run_id = $1
    AND ledger.source_table = 'memories' AND ledger.record_id = expected.record_id::uuid
    AND ledger.source_hash = expected.source_hash AND ledger.artifact_type = 'tree_job'
    AND ledger.artifact_id = job.id AND ledger.artifact_role = expected.artifact_role
), artifact_parity AS (
  SELECT expected.artifact_type, expected.artifact_id, expected.artifact_role,
    ledger.artifact_id IS NOT NULL AS ledger_matches,
    CASE expected.artifact_type
      WHEN 'evidence_memory' THEN EXISTS (
        SELECT 1 FROM material JOIN memories evidence
          ON evidence.id = material.evidence_id::uuid
        WHERE material.evidence_id = expected.artifact_id
          AND evidence.text = material.source->>'text'
          AND evidence.content_hash = material.evidence_content_hash
          AND evidence.vector::text::jsonb = material.source->'vector'
          AND evidence.importance =
            (material.evidence_metadata->>'importance')::double precision::numeric
          AND evidence.category = 'core' AND evidence.data_type = 'memory'
          AND evidence.metadata = material.evidence_metadata
          AND evidence.scope_key = $14
          AND evidence.lifecycle_status = 'archived')
      WHEN 'evidence_link' THEN EXISTS (
        SELECT 1 FROM material JOIN mengshu_memory_evidence_links link
          ON link.link_id = material.evidence_link_id
        WHERE material.evidence_link_id = expected.artifact_id
          AND link.scope_fingerprint = $2
          AND link.target_memory_id = material.source->>'recordId'
          AND link.evidence_memory_id = material.evidence_id
          AND link.link_kind = 'grounded_by' AND link.source = 'history_rebuild:' || $1)
      WHEN 'tree_job' THEN EXISTS (
        SELECT 1 FROM expected_tree_jobs spec
        JOIN mengshu_jobs_v2 job ON job.scoped_dedupe_key = spec.scoped_dedupe_key
        WHERE job.id = expected.artifact_id AND job.type = 'build_tree'
          AND job.payload = spec.payload AND job.dedupe_key = spec.dedupe_key
          AND job.max_attempts = spec.max_attempts
          AND job.tenant_id = $3 AND job.user_id = $4 AND job.app_id = $6
          AND job.project_id = $5 AND job.agent_id = $7 AND job.namespace = $8
          AND job.visibility = $9)
      ELSE false
    END AS object_matches
  FROM expected_artifacts_with_jobs expected
  LEFT JOIN mengshu_history_rebuild_artifacts ledger ON ledger.run_id = $1
    AND ledger.source_table = 'memories'
    AND ledger.record_id = expected.record_id::uuid
    AND ledger.source_hash = expected.source_hash
    AND ledger.artifact_type = expected.artifact_type
    AND ledger.artifact_id = expected.artifact_id
    AND ledger.artifact_role = expected.artifact_role
), job_counts AS (
  SELECT COUNT(*) AS tree_job_count,
    COUNT(*) FILTER (WHERE job.status = 'queued') AS queued_tree_job_count,
    COUNT(*) FILTER (WHERE job.status = 'completed') AS completed_tree_job_count,
    COUNT(*) FILTER (WHERE job.status = 'dead_letter') AS dead_letter_tree_job_count,
    COUNT(*) FILTER (WHERE job.status IN ('running', 'retry_wait')) AS transient_tree_job_count
  FROM mengshu_history_rebuild_artifacts artifact
  JOIN mengshu_jobs_v2 job ON job.id = artifact.artifact_id
  WHERE artifact.run_id = $1 AND artifact.artifact_type = 'tree_job'
), aggregate AS (
  SELECT (SELECT COUNT(*) FROM exact_run) AS run_count, source_counts.*, plan_counts.*,
    memory_parity.applied_memory_count,
    (${KNOWLEDGE_PARITY_SQL}) AS unchanged_knowledge_count,
    (SELECT COUNT(*) FROM artifact_parity WHERE artifact_type = 'evidence_memory'
      AND ledger_matches AND object_matches) AS evidence_mirror_count,
    (SELECT COUNT(*) FROM artifact_parity WHERE artifact_type = 'evidence_link'
      AND ledger_matches AND object_matches) AS evidence_link_count,
    job_counts.*,
    (SELECT COUNT(*) FROM artifact_parity WHERE NOT ledger_matches OR NOT object_matches) +
      (SELECT COUNT(*) FROM mengshu_history_rebuild_artifacts ledger
       WHERE ledger.run_id = $1 AND NOT EXISTS (
         SELECT 1 FROM expected_artifacts_with_jobs expected
         WHERE expected.artifact_type = ledger.artifact_type
           AND expected.artifact_id = ledger.artifact_id
           AND expected.artifact_role = ledger.artifact_role
           AND expected.record_id::uuid = ledger.record_id
           AND expected.source_hash = ledger.source_hash)) AS artifact_drift_count
  FROM source_counts CROSS JOIN plan_counts CROSS JOIN memory_parity CROSS JOIN job_counts
)
SELECT run_count::text, total_source_count::text, memory_source_count::text,
  knowledge_source_count::text, total_plan_count::text, memory_plan_count::text,
  knowledge_plan_count::text, applied_memory_count::text, unchanged_knowledge_count::text,
  evidence_mirror_count::text, evidence_link_count::text, tree_job_count::text,
  queued_tree_job_count::text, completed_tree_job_count::text, dead_letter_tree_job_count::text,
  CASE WHEN run_count = 1 AND total_source_count = total_plan_count
    AND memory_plan_count >= applied_memory_count
    AND knowledge_source_count = knowledge_plan_count
    AND knowledge_source_count = unchanged_knowledge_count
    AND applied_memory_count = jsonb_array_length($13::jsonb)
    AND artifact_drift_count = 0 AND transient_tree_job_count = 0
    AND tree_job_count = queued_tree_job_count + completed_tree_job_count + dead_letter_tree_job_count
    THEN '0' ELSE '1' END AS drift_count
FROM aggregate`;

const ROLLBACK_PREFLIGHT_SQL = `/* history-rebuild:rollback-preflight */
WITH material AS (
  SELECT item, item->'source' AS source,
    COALESCE(item->'treeJobs', '[]'::jsonb) AS tree_jobs
  FROM jsonb_array_elements($3::jsonb) item
), expected_jobs AS (
  SELECT source->>'recordId' AS record_id, source->>'sourceHash' AS source_hash,
    job->>'artifactRole' AS artifact_role,
    job->>'scopedDedupeKey' AS scoped_dedupe_key, job->>'dedupeKey' AS dedupe_key,
    (job->>'maxAttempts')::integer AS max_attempts, job->'payload' AS payload
  FROM material CROSS JOIN LATERAL jsonb_array_elements(tree_jobs) job
), exact_run AS (
  SELECT run_id FROM mengshu_history_rebuild_runs run
  WHERE run.run_id = $1 AND run.scope_fingerprint = $2::text
), expected_state AS (
  SELECT expected.*, ledger.artifact_id, job.id AS job_id, job.status, job.attempts,
    job.type, job.payload AS actual_payload, job.dedupe_key AS actual_dedupe_key,
    job.scoped_dedupe_key AS actual_scoped_dedupe_key,
    job.max_attempts AS actual_max_attempts,
    job.tenant_id, job.user_id, job.project_id, job.app_id, job.agent_id,
    job.namespace, job.visibility
  FROM expected_jobs expected
  LEFT JOIN mengshu_history_rebuild_artifacts ledger ON ledger.run_id IN (SELECT run_id FROM exact_run)
    AND ledger.source_table = 'memories' AND ledger.record_id = expected.record_id::uuid
    AND ledger.source_hash = expected.source_hash AND ledger.artifact_type = 'tree_job'
    AND ledger.artifact_role = expected.artifact_role
    AND EXISTS (
      SELECT 1 FROM mengshu_jobs_v2 exact_job
      WHERE exact_job.id = ledger.artifact_id
        AND exact_job.scoped_dedupe_key = expected.scoped_dedupe_key
    )
  LEFT JOIN mengshu_jobs_v2 job ON job.id = ledger.artifact_id
), unexpected_ledger AS (
  SELECT ledger.artifact_id
  FROM mengshu_history_rebuild_artifacts ledger
  LEFT JOIN mengshu_jobs_v2 job ON job.id = ledger.artifact_id
  WHERE ledger.run_id IN (SELECT run_id FROM exact_run) AND ledger.artifact_type = 'tree_job'
    AND NOT EXISTS (
      SELECT 1 FROM expected_jobs expected
      WHERE ledger.source_table = 'memories'
        AND ledger.record_id = expected.record_id::uuid
        AND ledger.source_hash = expected.source_hash
        AND ledger.artifact_role = expected.artifact_role
        AND job.scoped_dedupe_key = expected.scoped_dedupe_key)
)
SELECT ((SELECT COUNT(*) FROM expected_state
    WHERE artifact_id IS NULL OR job_id IS NULL OR NOT (
      (status = 'queued' AND attempts = 0) OR
      (status = 'dead_letter' AND NOT EXISTS (
        SELECT 1 FROM mengshu_job_v2_effect_receipts effect_receipt
        WHERE effect_receipt.job_id = expected_state.job_id
          AND effect_receipt.effect_key = 'build_tree.persist.v1'
      ))) OR type <> 'build_tree' OR
      actual_payload IS DISTINCT FROM payload OR
      actual_dedupe_key IS DISTINCT FROM dedupe_key OR
      actual_scoped_dedupe_key IS DISTINCT FROM scoped_dedupe_key OR
      actual_max_attempts IS DISTINCT FROM max_attempts OR
      tenant_id IS DISTINCT FROM $4 OR user_id IS DISTINCT FROM $5 OR
      project_id IS DISTINCT FROM $6 OR app_id IS DISTINCT FROM $7 OR
      agent_id IS DISTINCT FROM $8 OR namespace IS DISTINCT FROM $9 OR
      visibility IS DISTINCT FROM $10 OR
      COALESCE(actual_payload->'scope'->>'workspaceId', '') IS DISTINCT FROM $11 OR
      COALESCE(actual_payload->'scope'->>'sessionId', '') IS DISTINCT FROM $12) +
    (SELECT COUNT(*) FROM unexpected_ledger))::text AS started_job_count,
  (SELECT COUNT(*)::text FROM expected_jobs) AS tree_job_count,
  (SELECT COUNT(*)::text FROM mengshu_history_rebuild_artifacts
    WHERE run_id IN (SELECT run_id FROM exact_run)
      AND artifact_type = 'evidence_link') AS evidence_link_count,
  (SELECT COUNT(*)::text FROM mengshu_history_rebuild_artifacts
    WHERE run_id IN (SELECT run_id FROM exact_run)
      AND artifact_type = 'evidence_memory') AS evidence_mirror_count`;

const ROLLBACK_RUN_SQL = `/* history-rebuild:rollback */
WITH ${MATERIAL_CTES_SQL}, expected_artifacts_with_jobs AS (
  SELECT * FROM expected_artifacts
  UNION ALL
  SELECT expected.record_id, expected.source_hash, 'tree_job', ledger.artifact_id,
    expected.artifact_role
  FROM expected_tree_jobs expected
  JOIN mengshu_jobs_v2 job ON job.scoped_dedupe_key = expected.scoped_dedupe_key
    AND job.type = 'build_tree' AND job.payload = expected.payload
    AND job.dedupe_key = expected.dedupe_key
    AND job.max_attempts = expected.max_attempts
    AND job.tenant_id = $3 AND job.user_id = $4 AND job.app_id = $6
    AND job.project_id = $5 AND job.agent_id = $7 AND job.namespace = $8
    AND job.visibility = $9
  JOIN mengshu_history_rebuild_artifacts ledger ON ledger.run_id = $1
    AND ledger.source_table = 'memories' AND ledger.record_id = expected.record_id::uuid
    AND ledger.source_hash = expected.source_hash AND ledger.artifact_type = 'tree_job'
    AND ledger.artifact_id = job.id AND ledger.artifact_role = expected.artifact_role
), restored AS (
  UPDATE memories memory SET metadata = material.source->'metadata',
    lifecycle_status = material.source->>'lifecycleStatus'
  FROM material
  WHERE memory.id = (material.source->>'recordId')::uuid
    AND memory.tenant_id = $3 AND memory.user_id = $4
    AND memory.canonical_project_id = $5 AND memory.product_id = $6
    AND memory.producer_id = $7 AND memory.namespace = $8 AND memory.visibility = $9
    AND COALESCE(memory.workspace_id, '') = $10
    AND COALESCE(memory.metadata->>'sessionId', '') = $11
    AND memory.text = material.source->>'text'
    AND memory.content_hash = material.source->>'contentHash'
    AND memory.vector::text::jsonb = material.source->'vector'
    AND memory.importance IS NOT DISTINCT FROM
      (material.source->>'importance')::double precision
    AND memory.category = material.source->>'category'
    AND memory.data_type = material.source->>'dataType'
    AND floor(extract(epoch FROM memory.created_at) * 1000)::bigint =
      (material.source->>'createdAt')::bigint
    AND memory.embedding_space_id IS NOT DISTINCT FROM material.source->>'embeddingSpaceId'
    AND memory.embedding_space_state IS NOT DISTINCT FROM material.source->>'embeddingSpaceState'
    AND memory.metadata = material.resulting_metadata
    AND memory.lifecycle_status IS NOT DISTINCT FROM material.resulting_lifecycle_status
  RETURNING memory.id::text
), removed_links AS (
  DELETE FROM mengshu_memory_evidence_links link USING expected_artifacts_with_jobs artifact
  WHERE artifact.artifact_type = 'evidence_link' AND link.link_id = artifact.artifact_id
    AND link.scope_fingerprint = $2 AND link.target_memory_id = artifact.record_id
    AND link.source = 'history_rebuild:' || $1
    AND EXISTS (SELECT 1 FROM mengshu_history_rebuild_artifacts ledger
      WHERE ledger.run_id = $1 AND ledger.artifact_type = artifact.artifact_type
        AND ledger.artifact_id = artifact.artifact_id AND ledger.artifact_role = artifact.artifact_role
        AND ledger.record_id = artifact.record_id::uuid AND ledger.source_hash = artifact.source_hash)
  RETURNING link.link_id
), removed_jobs AS (
  DELETE FROM mengshu_jobs_v2 job USING expected_artifacts_with_jobs artifact,
    expected_tree_jobs spec
  WHERE artifact.artifact_type = 'tree_job' AND job.id = artifact.artifact_id
    AND spec.scoped_dedupe_key = job.scoped_dedupe_key AND job.type = 'build_tree'
    AND job.payload = spec.payload AND job.dedupe_key = spec.dedupe_key
    AND job.max_attempts = spec.max_attempts
    AND ((job.status = 'queued' AND job.attempts = 0) OR
      (job.status = 'dead_letter' AND NOT EXISTS (
        SELECT 1 FROM mengshu_job_v2_effect_receipts effect_receipt
        WHERE effect_receipt.job_id = job.id
          AND effect_receipt.effect_key = 'build_tree.persist.v1'
      )))
    AND EXISTS (SELECT 1 FROM mengshu_history_rebuild_artifacts ledger
      WHERE ledger.run_id = $1 AND ledger.artifact_type = artifact.artifact_type
        AND ledger.artifact_id = artifact.artifact_id AND ledger.artifact_role = artifact.artifact_role
        AND ledger.record_id = artifact.record_id::uuid AND ledger.source_hash = artifact.source_hash)
  RETURNING job.id
), removed_evidence AS (
  DELETE FROM memories evidence USING expected_artifacts_with_jobs artifact, material
  WHERE artifact.artifact_type = 'evidence_memory' AND evidence.id = artifact.artifact_id::uuid
    AND material.evidence_id = artifact.artifact_id
    AND evidence.text = material.source->>'text'
    AND evidence.content_hash = material.evidence_content_hash
    AND evidence.vector::text::jsonb = material.source->'vector'
    AND evidence.importance =
      (material.evidence_metadata->>'importance')::double precision::numeric
    AND evidence.category = 'core' AND evidence.data_type = 'memory'
    AND evidence.metadata = material.evidence_metadata AND evidence.lifecycle_status = 'archived'
    AND EXISTS (SELECT 1 FROM mengshu_history_rebuild_artifacts ledger
      WHERE ledger.run_id = $1 AND ledger.artifact_type = artifact.artifact_type
        AND ledger.artifact_id = artifact.artifact_id AND ledger.artifact_role = artifact.artifact_role
        AND ledger.record_id = artifact.record_id::uuid AND ledger.source_hash = artifact.source_hash)
  RETURNING evidence.id::text
), removed_artifacts AS (
  DELETE FROM mengshu_history_rebuild_artifacts ledger
  WHERE ledger.run_id = $1
    AND (SELECT COUNT(*) FROM removed_jobs) =
      (SELECT COUNT(*) FROM expected_artifacts_with_jobs WHERE artifact_type = 'tree_job')
    AND (SELECT COUNT(*) FROM removed_links) =
      (SELECT COUNT(*) FROM expected_artifacts_with_jobs WHERE artifact_type = 'evidence_link')
    AND (SELECT COUNT(*) FROM removed_evidence) =
      (SELECT COUNT(*) FROM expected_artifacts_with_jobs WHERE artifact_type = 'evidence_memory')
    AND EXISTS (
    SELECT 1 FROM expected_artifacts_with_jobs expected
    WHERE expected.artifact_type = ledger.artifact_type
      AND expected.artifact_id = ledger.artifact_id
      AND expected.artifact_role = ledger.artifact_role
      AND expected.record_id::uuid = ledger.record_id
      AND expected.source_hash = ledger.source_hash)
  RETURNING ledger.artifact_id
), receipt AS (
  /* history-rebuild:rollback-receipt */
  INSERT INTO mengshu_history_rebuild_operation_receipts (
    receipt_hash, run_id, source_table, operation, status, counts,
    result_hash, drift_hash, created_at
  ) SELECT encode(sha256(convert_to(concat_ws(chr(31), 'history-rollback/v2', $1, $2), 'UTF8')), 'hex'),
    $1, 'memories', 'rollback', 'rolled_back', jsonb_build_object(
      'restored', (SELECT COUNT(*) FROM restored),
      'removedEvidenceMirrors', (SELECT COUNT(*) FROM removed_evidence),
      'removedTreeJobs', (SELECT COUNT(*) FROM removed_jobs)),
    encode(sha256(convert_to(concat_ws(chr(31), $1,
      (SELECT COUNT(*) FROM removed_artifacts)::text), 'UTF8')), 'hex'), NULL, $12
  WHERE (SELECT COUNT(*) FROM restored) = jsonb_array_length($13::jsonb)
    AND (SELECT COUNT(*) FROM removed_artifacts) =
      (SELECT COUNT(*) FROM expected_artifacts_with_jobs)
  ON CONFLICT DO NOTHING RETURNING receipt_hash
), rolled_back_checkpoints AS (
  UPDATE mengshu_history_rebuild_checkpoints SET state = 'rolled_back', updated_at = $12
  WHERE run_id = $1 AND state = 'completed' AND (SELECT COUNT(*) FROM receipt) = 1
  RETURNING source_table
), rolled_back_run AS (
  UPDATE mengshu_history_rebuild_runs SET state = 'rolled_back', updated_at = $12
  WHERE run_id = $1 AND scope_fingerprint = $2 AND state = 'completed'
    AND (SELECT COUNT(*) FROM rolled_back_checkpoints) = 2
  RETURNING run_id
)
SELECT (SELECT COUNT(*)::text FROM restored) AS restored_count,
  (SELECT COUNT(*)::text FROM removed_jobs) AS removed_job_count,
  (SELECT COUNT(*)::text FROM removed_links) AS removed_link_count,
  (SELECT COUNT(*)::text FROM removed_evidence) AS removed_evidence_mirror_count,
  (SELECT COUNT(*)::text FROM removed_artifacts) AS removed_artifact_count,
  CASE WHEN (SELECT COUNT(*) FROM receipt) = 1 AND
    (SELECT COUNT(*) FROM rolled_back_run) = 1 THEN '0' ELSE '1' END AS drift_count`;

function fail(code: HistoryRebuildRepositoryErrorCode): never {
  throw new HistoryRebuildRepositoryError(code);
}

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownData(record: Readonly<Record<string, unknown>>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor?.enumerable === true && "value" in descriptor ? descriptor.value : undefined;
}

function integer(value: unknown): number | null {
  const parsed = typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)
    ? Number(value) : value;
  return Number.isSafeInteger(parsed) && Number(parsed) >= 0 ? Number(parsed) : null;
}

function hash(domain: string, value: unknown): string {
  return createHash("sha256").update(`${domain}\0${canonicalJson(value)}`).digest("hex");
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("HISTORY_REBUILD_INVALID_INPUT");
    return JSON.stringify(value);
  }
  if (value === undefined) return '"undefined"';
  if (!plainRecord(value) && !Array.isArray(value)) fail("HISTORY_REBUILD_INVALID_INPUT");
  if (ancestors.has(value as object)) fail("HISTORY_REBUILD_INVALID_INPUT");
  ancestors.add(value as object);
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).length !== value.length + 1) fail("HISTORY_REBUILD_INVALID_INPUT");
      return `[${value.map((item) => canonicalJson(item, ancestors)).join(",")}]`;
    }
    const record = value as Readonly<Record<string, unknown>>;
    const fields: string[] = [];
    for (const key of Reflect.ownKeys(record).sort((a, b) => String(a).localeCompare(String(b)))) {
      if (typeof key !== "string") fail("HISTORY_REBUILD_INVALID_INPUT");
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) fail("HISTORY_REBUILD_INVALID_INPUT");
      fields.push(`${JSON.stringify(key)}:${canonicalJson(descriptor.value, ancestors)}`);
    }
    return `{${fields.join(",")}}`;
  } finally {
    ancestors.delete(value as object);
  }
}

function exactScope(scope: MemoryScope): ReturnType<typeof canonicalAuthorityScope> {
  if (!plainRecord(scope) || scope.visibility === undefined) fail("HISTORY_REBUILD_INVALID_INPUT");
  try {
    return canonicalAuthorityScope(scope);
  } catch {
    return fail("HISTORY_REBUILD_INVALID_INPUT");
  }
}

function exactPolicyRecord(
  value: unknown,
  keys: readonly string[],
): value is Readonly<Record<string, unknown>> {
  if (!plainRecord(value)) return false;
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== "string") || actual.length !== keys.length) return false;
  const expected = [...keys].sort();
  return [...actual as string[]].sort().every((key, index) => key === expected[index]) &&
    actual.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && "value" in descriptor;
    });
}

function policyArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) ||
      Reflect.ownKeys(value).length !== value.length + 1) {
    fail("HISTORY_REBUILD_INVALID_INPUT");
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      fail("HISTORY_REBUILD_INVALID_INPUT");
    }
  }
  return value;
}

function auditedIdentity(value: unknown): value is string {
  return typeof value === "string" && value === value.trim() &&
    /^[^\s\p{Cc}]{1,512}$/u.test(value);
}

function sourceTreeKey(
  scopeFingerprint: string,
  kind: "session" | HistoryRebuildSourceIdentityFact["kind"],
  identity: string,
): string {
  return `history-source:${hash(
    "mengshu.history-rebuild-source-tree-key/v2",
    [scopeFingerprint, kind, identity],
  )}`;
}

interface ValidatedHistoryRebuildTreeRoutingPolicy {
  readonly policy: HistoryRebuildTreeRoutingPolicy;
  readonly scopeFingerprint: string;
  readonly minimumSupport: number;
  readonly maxLabelsPerRecord: number;
  readonly aliases: ReadonlyMap<string, { readonly canonical: string; readonly support: number }>;
  readonly identities: ReadonlyMap<string, HistoryRebuildSourceIdentityFact>;
}

function validatedHistoryRebuildTreeRoutingPolicy(
  value: unknown,
  expectedScopeFingerprint?: string,
): ValidatedHistoryRebuildTreeRoutingPolicy {
  if (!exactPolicyRecord(value, ["version", "scopeFingerprint", "topic", "source"]) ||
      ownData(value, "version") !== HISTORY_REBUILD_TREE_ROUTING_POLICY_VERSION) {
    fail("HISTORY_REBUILD_INVALID_INPUT");
  }
  const scopeFingerprint = ownData(value, "scopeFingerprint");
  if (typeof scopeFingerprint !== "string" || !SHA256.test(scopeFingerprint) ||
      (expectedScopeFingerprint !== undefined && scopeFingerprint !== expectedScopeFingerprint)) {
    fail("HISTORY_REBUILD_INVALID_INPUT");
  }
  const topicPolicy = ownData(value, "topic");
  const sourcePolicy = ownData(value, "source");
  if (!exactPolicyRecord(topicPolicy, [
    "version", "minimumSupport", "maxLabelsPerRecord", "taxonomy",
  ]) || ownData(topicPolicy, "version") !== HISTORY_REBUILD_TOPIC_TAXONOMY_VERSION ||
      !exactPolicyRecord(sourcePolicy, ["version", "identities"]) ||
      ownData(sourcePolicy, "version") !== HISTORY_REBUILD_SOURCE_IDENTITY_VERSION) {
    fail("HISTORY_REBUILD_INVALID_INPUT");
  }
  const minimumSupport = ownData(topicPolicy, "minimumSupport");
  const maxLabelsPerRecord = ownData(topicPolicy, "maxLabelsPerRecord");
  if (!Number.isSafeInteger(minimumSupport) || (minimumSupport as number) < 2 ||
      !Number.isSafeInteger(maxLabelsPerRecord) || (maxLabelsPerRecord as number) < 1 ||
      (maxLabelsPerRecord as number) > 3) {
    fail("HISTORY_REBUILD_INVALID_INPUT");
  }

  const aliases = new Map<string, { readonly canonical: string; readonly support: number }>();
  const canonicalLabels = new Set<string>();
  for (const candidate of policyArray(ownData(topicPolicy, "taxonomy"))) {
    if (!exactPolicyRecord(candidate, ["canonicalLabel", "aliases", "support"])) {
      fail("HISTORY_REBUILD_INVALID_INPUT");
    }
    const canonicalLabel = ownData(candidate, "canonicalLabel");
    const support = ownData(candidate, "support");
    if (typeof canonicalLabel !== "string" || canonicalLabel !== normalizeTopicLabel(canonicalLabel) ||
        canonicalLabel.length === 0 || canonicalLabels.has(canonicalLabel) ||
        !Number.isSafeInteger(support) || (support as number) < 1) {
      fail("HISTORY_REBUILD_INVALID_INPUT");
    }
    canonicalLabels.add(canonicalLabel);
    for (const rawAlias of [canonicalLabel, ...policyArray(ownData(candidate, "aliases"))]) {
      if (typeof rawAlias !== "string" || rawAlias.length === 0 || rawAlias.length > 256) {
        fail("HISTORY_REBUILD_INVALID_INPUT");
      }
      const alias = normalizeTopicLabel(rawAlias);
      if (alias.length === 0) fail("HISTORY_REBUILD_INVALID_INPUT");
      const existing = aliases.get(alias);
      if (existing !== undefined && existing.canonical !== canonicalLabel) {
        fail("HISTORY_REBUILD_INVALID_INPUT");
      }
      aliases.set(alias, Object.freeze({ canonical: canonicalLabel, support: support as number }));
    }
  }

  const identities = new Map<string, HistoryRebuildSourceIdentityFact>();
  for (const candidate of policyArray(ownData(sourcePolicy, "identities"))) {
    if (!exactPolicyRecord(candidate, [
      "recordId", "sourceHash", "kind", "identity", "receiptHash",
    ])) fail("HISTORY_REBUILD_INVALID_INPUT");
    const recordId = ownData(candidate, "recordId");
    const sourceHash = ownData(candidate, "sourceHash");
    const kind = ownData(candidate, "kind");
    const identity = ownData(candidate, "identity");
    const identityReceiptHash = ownData(candidate, "receiptHash");
    if (typeof recordId !== "string" || !SAFE_ID.test(recordId) ||
        typeof sourceHash !== "string" || !SHA256.test(sourceHash) ||
        (kind !== "document" && kind !== "import_batch" && kind !== "provenance") ||
        !auditedIdentity(identity) || typeof identityReceiptHash !== "string" ||
        !SHA256.test(identityReceiptHash)) {
      fail("HISTORY_REBUILD_INVALID_INPUT");
    }
    const key = `${recordId}\0${sourceHash}`;
    if (identities.has(key)) fail("HISTORY_REBUILD_INVALID_INPUT");
    identities.set(key, candidate as unknown as HistoryRebuildSourceIdentityFact);
  }

  return Object.freeze({
    policy: value as unknown as HistoryRebuildTreeRoutingPolicy,
    scopeFingerprint,
    minimumSupport: minimumSupport as number,
    maxLabelsPerRecord: maxLabelsPerRecord as number,
    aliases,
    identities,
  });
}

/** Stable pin persisted as `mengshu_history_rebuild_runs.policy_hash` for v2 tree routing. */
export function historyRebuildTreeRoutingPolicyHash(
  policy: HistoryRebuildTreeRoutingPolicy,
): string {
  const validated = validatedHistoryRebuildTreeRoutingPolicy(policy);
  return hash("mengshu.history-rebuild-tree-policy/v2", validated.policy);
}

/**
 * Pure scope-bound policy gate for corrected history tree routing. The policy facts must be
 * prepared before a new migration identity is allowed to materialize canonical tree jobs.
 */
export function planHistoryRebuildTreeRouting(input: {
  readonly source: HistoryRebuildScanRow;
  readonly plan: HistoryRebuildPlan;
  readonly policy: HistoryRebuildTreeRoutingPolicy;
}): HistoryRebuildTreeRoutingDecision {
  if (!exactPolicyRecord(input, ["source", "plan", "policy"])) {
    fail("HISTORY_REBUILD_INVALID_INPUT");
  }
  const source = ownData(input, "source") as HistoryRebuildScanRow;
  const plan = ownData(input, "plan") as HistoryRebuildPlan;
  const policy = ownData(input, "policy");
  if (!plainRecord(source) || !plainRecord(plan) ||
      source.sourceTable !== "memories" || plan.sourceTable !== source.sourceTable ||
      plan.recordId !== source.recordId || plan.sourceHash !== source.sourceHash ||
      typeof source.recordId !== "string" || !SAFE_ID.test(source.recordId) ||
      typeof source.sourceHash !== "string" || !SHA256.test(source.sourceHash) ||
      typeof plan.receiptHash !== "string" || !SHA256.test(plan.receiptHash) ||
      !plainRecord(plan.treeEligibility) ||
      typeof plan.treeEligibility.source !== "boolean" ||
      typeof plan.treeEligibility.topic !== "boolean" ||
      !Array.isArray(plan.topicLabels)) {
    fail("HISTORY_REBUILD_INVALID_INPUT");
  }
  exactScope(source.scope);
  const validatedPolicy = validatedHistoryRebuildTreeRoutingPolicy(
    policy,
    authorityScopeFingerprint(source.scope),
  );
  const { aliases, identities, maxLabelsPerRecord, minimumSupport, scopeFingerprint } =
    validatedPolicy;

  const requestedTopics = new Set<string>();
  for (const rawLabel of policyArray(plan.topicLabels)) {
    if (typeof rawLabel !== "string" || rawLabel.length === 0 || rawLabel.length > 256) {
      fail("HISTORY_REBUILD_INVALID_INPUT");
    }
    const label = normalizeTopicLabel(rawLabel);
    if (label.length === 0) fail("HISTORY_REBUILD_INVALID_INPUT");
    requestedTopics.add(label);
  }
  const recognized = new Map<string, number>();
  const dropped = new Set<string>();
  for (const label of requestedTopics) {
    const resolved = aliases.get(label);
    if (resolved === undefined) {
      dropped.add(label);
    } else if (resolved.support < minimumSupport) {
      dropped.add(resolved.canonical);
    } else {
      recognized.set(resolved.canonical, resolved.support);
    }
  }
  const rankedTopics = [...recognized]
    .sort(([leftLabel, leftSupport], [rightLabel, rightSupport]) =>
      rightSupport - leftSupport || leftLabel.localeCompare(rightLabel));
  const selectedTopics = rankedTopics.slice(0, maxLabelsPerRecord)
    .map(([label]) => label);
  for (const [label] of rankedTopics.slice(maxLabelsPerRecord)) dropped.add(label);
  const topicReason = !plan.treeEligibility.topic
    ? "plan_ineligible"
    : selectedTopics.length > 0
      ? "canonical_topics_selected"
      : [...requestedTopics].some((label) => aliases.has(label))
        ? "below_minimum_support"
        : "taxonomy_miss";
  const topicDecision = Object.freeze({
    eligible: plan.treeEligibility.topic && selectedTopics.length > 0,
    labels: Object.freeze(selectedTopics),
    droppedLabels: Object.freeze([...dropped].sort()),
    reason: topicReason,
  }) as HistoryRebuildTreeRoutingDecision["topic"];

  let sourceDecision: HistoryRebuildTreeRoutingDecision["source"];
  if (!plan.treeEligibility.source) {
    sourceDecision = Object.freeze({ eligible: false, reason: "plan_ineligible" });
  } else if (source.scope.sessionId !== undefined) {
    sourceDecision = Object.freeze({
      eligible: true,
      reason: "audited_session_identity",
      kind: "session",
      treeKey: sourceTreeKey(scopeFingerprint, "session", source.scope.sessionId),
    });
  } else {
    const fact = identities.get(`${source.recordId}\0${source.sourceHash}`);
    sourceDecision = fact === undefined
      ? Object.freeze({ eligible: false, reason: "missing_auditable_source_identity" })
      : Object.freeze({
          eligible: true,
          reason: "audited_source_identity",
          kind: fact.kind,
          treeKey: sourceTreeKey(scopeFingerprint, fact.kind, fact.identity),
          identityReceiptHash: fact.receiptHash,
        });
  }

  const policyHash = historyRebuildTreeRoutingPolicyHash(validatedPolicy.policy);
  const base = Object.freeze({
    policyVersion: HISTORY_REBUILD_TREE_ROUTING_POLICY_VERSION,
    policyHash,
    scopeFingerprint,
    source: sourceDecision,
    topic: topicDecision,
  });
  return Object.freeze({
    ...base,
    receiptHash: hash("mengshu.history-rebuild-tree-routing-receipt/v2", {
      sourceTable: source.sourceTable,
      recordId: source.recordId,
      sourceHash: source.sourceHash,
      planReceiptHash: plan.receiptHash,
      result: base,
    }),
  });
}

function scopeParams(scope: MemoryScope): readonly string[] {
  const canonical = exactScope(scope);
  return Object.freeze([
    canonical.tenantId, canonical.userId, canonical.projectId, canonical.appId,
    canonical.agentId, canonical.namespace, canonical.visibility,
    canonical.workspaceId, canonical.sessionId,
  ]);
}

interface HistoryRebuildTreeJobMaterial {
  readonly id: string;
  readonly dedupeKey: string;
  readonly scopedDedupeKey: string;
  readonly maxAttempts: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly artifactRole:
    | "source_leaf"
    | "source_finalize"
    | "topic_leaf"
    | "topic_finalize";
}

interface HistoryRebuildMemoryMaterial {
  readonly source: HistoryRebuildScanRow;
  readonly plan: HistoryRebuildPlan;
  readonly resultingMetadata: Readonly<Record<string, unknown>>;
  readonly resultingLifecycleStatus: HistoryRebuildScanRow["lifecycleStatus"];
  readonly evidenceId?: string;
  readonly evidenceContentHash?: string;
  readonly evidenceLinkId?: string;
  readonly evidenceMetadata?: Readonly<Record<string, unknown>>;
  readonly treeJobs: readonly HistoryRebuildTreeJobMaterial[];
}

function deterministicUuid(domain: string, value: unknown): string {
  const digest = hash(domain, value);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-` +
    `8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function canonicalContainer(metadata: Readonly<Record<string, unknown>>):
"personal" | "project" | "team" | "enterprise" {
  const value = ownData(metadata, "memoryContainer");
  return value === "personal" || value === "project" || value === "team" || value === "enterprise"
    ? value : "project";
}

function historyScopeVisibility(scope: MemoryScope):
"session" | "project" | "workspace" {
  return scope.sessionId ? "session" : scope.workspaceId ? "workspace" : "project";
}

function queueScope(scope: MemoryScope): DurableJobV2Scope {
  const canonical = exactScope(scope);
  return Object.freeze({
    tenantId: canonical.tenantId,
    userId: canonical.userId,
    appId: canonical.appId,
    projectId: canonical.projectId,
    agentId: canonical.agentId,
    namespace: canonical.namespace,
    visibility: canonical.visibility,
  });
}

/** Pure materialization shared by live apply and contract tests. */
export function buildHistoryRebuildMemoryMaterial(input: {
  readonly runId: string;
  readonly source: HistoryRebuildScanRow;
  readonly plan: HistoryRebuildPlan;
  readonly policy?: HistoryRebuildTreeRoutingPolicy;
  /** Internal recovery-only path for reconstructing artifacts created by the frozen v1 cohort. */
  readonly allowLegacyPolicy?: boolean;
}): HistoryRebuildMemoryMaterial | undefined {
  const { runId, source, plan, policy } = input;
  if (!SAFE_ID.test(runId) || source.sourceTable !== "memories" ||
      plan.sourceTable !== source.sourceTable || plan.recordId !== source.recordId ||
      plan.sourceHash !== source.sourceHash) fail("HISTORY_REBUILD_INVALID_INPUT");
  if (policy === undefined && input.allowLegacyPolicy !== true) {
    fail("HISTORY_REBUILD_INVALID_INPUT");
  }
  if (plan.disposition === "quarantine" ||
      (plan.disposition === "model_classify" && plan.semanticType === undefined)) return undefined;

  const lifecycle = source.lifecycleStatus ?? "active";
  const active = plan.contextEligible && lifecycle === "active";
  const lookupOnly = plan.disposition === "lookup_only";
  const resultingLifecycle = lookupOnly ? "archived" : lifecycle;
  const needsEvidence = source.canCreateEvidenceMirror === true && (active || lookupOnly);
  const sourceImportance = source.importance;
  const createdAt = source.createdAt;
  if ((sourceImportance !== undefined &&
      (typeof sourceImportance !== "number" || !Number.isFinite(sourceImportance) ||
        sourceImportance < 0 || sourceImportance > 1)) ||
      !Number.isSafeInteger(createdAt) || createdAt! < 0 ||
      typeof source.category !== "string" || source.category.length === 0 ||
      typeof source.dataType !== "string" || source.dataType.length === 0) {
    fail("HISTORY_REBUILD_INVALID_INPUT");
  }
  const importance = sourceImportance ?? 0.70;
  const valueScore = source.valueScore ?? 0.70;
  const confidence = source.confidence ?? 0.85;
  const valueScoreBasis = source.valueScore === undefined
    ? "legacy-active-floor-v1" : "historical-metadata";
  const confidenceBasis = source.confidence === undefined
    ? "legacy-governance-floor-v1" : "historical-metadata";
  const container = canonicalContainer(source.metadata);
  const evidenceId = needsEvidence ? deterministicUuid(
    "mengshu.history-rebuild-evidence-mirror/v1",
    [runId, source.recordId, source.sourceHash],
  ) : undefined;
  const evidenceContentHash = evidenceId === undefined ? undefined : hash(
    "mengshu.history-rebuild-evidence-content/v1",
    [runId, source.recordId, source.sourceHash, evidenceId],
  );
  const evidenceLinkId = evidenceId === undefined ? undefined : hash(
    "mengshu.history-rebuild-evidence-link/v1",
    [runId, source.recordId, source.sourceHash, evidenceId],
  );
  const treeRouting = policy === undefined ? undefined : planHistoryRebuildTreeRouting({
    source, plan, policy,
  });
  const topicLabels = treeRouting?.topic.labels ?? plan.topicLabels;
  const sourceTreeEligible = treeRouting?.source.eligible ?? plan.treeEligibility.source;
  const topicTreeEligible = treeRouting?.topic.eligible ?? plan.treeEligibility.topic;
  const materialPlan = treeRouting === undefined ? plan : Object.freeze({
    ...plan,
    topicLabels: Object.freeze([...topicLabels]),
    treeEligibility: Object.freeze({
      ...plan.treeEligibility,
      source: sourceTreeEligible,
      topic: topicTreeEligible,
    }),
  });
  const sourceId = treeRouting?.source.treeKey ?? source.scope.sessionId ?? evidenceId;
  const scopeVisibility = historyScopeVisibility(source.scope);
  const candidate = {
    confidence,
    extractor: "history-rebuild-v1",
    riskFlags: Object.freeze([] as string[]),
    targetScope: scopeVisibility,
    evidence: Object.freeze({ eventIds: evidenceId ? Object.freeze([evidenceId]) : Object.freeze([]) }),
    ...(active && evidenceId && sourceId && plan.semanticType ? {
      treeRouting: Object.freeze({
        version: 1,
        evidenceId,
        sourceId,
        entityIds: Object.freeze([] as string[]),
        scopeVisibility,
        riskFlags: Object.freeze([] as string[]),
        topicLabels: Object.freeze([...topicLabels]),
        topicHotnessEligible: topicTreeEligible,
        globalHotnessEligible: plan.treeEligibility.global,
        explicitGlobal: false,
        isWorkspaceRule: plan.treeEligibility.global && plan.semanticType === "rules" &&
          scopeVisibility === "workspace",
      }),
    } : {}),
  };
  const provenance = Object.freeze({
    source: "history_rebuild",
    sourceId: evidenceId ?? source.recordId,
    ...(source.scope.sessionId === undefined ? {} : { sessionId: source.scope.sessionId }),
    createdAt,
  });
  const resultingMetadata = Object.freeze({
    ...source.metadata,
    ...(plan.semanticType === undefined ? {} : { semanticType: plan.semanticType }),
    ...(active ? {
      admissionRoute: "active",
      contextEligible: true,
      memoryContainer: container,
    } : lookupOnly ? {
      admissionRoute: "lookup_only",
      contextEligible: false,
      memoryContainer: "session_candidate",
    } : {}),
    valueScore,
    importance,
    confidence,
    topicLabels: Object.freeze([...topicLabels]),
    ...(evidenceId === undefined ? {} : { sourceNodeIds: Object.freeze([evidenceId]) }),
    historyRebuild: Object.freeze({
      runId,
      sourceHash: source.sourceHash,
      disposition: plan.disposition,
      planReceiptHash: plan.receiptHash,
      valueScoreBasis,
      confidenceBasis,
      ...(evidenceId === undefined ? {} : { evidenceId }),
      ...(treeRouting === undefined ? {} : {
        treeRouting: Object.freeze({
          policyVersion: treeRouting.policyVersion,
          policyHash: treeRouting.policyHash,
          receiptHash: treeRouting.receiptHash,
          sourceReason: treeRouting.source.reason,
          topicReason: treeRouting.topic.reason,
        }),
      }),
    }),
    governance: Object.freeze({
      commandType: "observeAuto",
      candidate: Object.freeze(candidate),
      provenance,
      evidenceIds: evidenceId ? Object.freeze([evidenceId]) : Object.freeze([]),
      native: Object.freeze({
        kind: source.kind,
        ...(plan.semanticType === undefined ? {} : { semanticType: plan.semanticType }),
        ...(active ? { container } : lookupOnly ? { container: "session_candidate" } : {}),
        category: source.category,
        dataType: source.dataType,
        tableName: "memories",
      }),
      admissionReason: "history_rebuild_compatibility_policy",
    }),
  });
  const evidenceMetadata = evidenceId === undefined ? undefined : Object.freeze({
    admissionRoute: "evidence_only",
    contextEligible: false,
    importance,
    memoryContainer: "session_candidate",
    eventType: "observation",
    source: "history_rebuild",
    sourceNodeIds: Object.freeze([evidenceId]),
    ...(source.scope.sessionId === undefined ? {} : { sessionId: source.scope.sessionId }),
    ...(source.embeddingSpaceId === null || source.embeddingSpaceId === undefined ? {} : {
      embeddingSpaceId: source.embeddingSpaceId,
    }),
    ...(source.embeddingSpaceState === null || source.embeddingSpaceState === undefined ? {} : {
      embeddingSpaceState: source.embeddingSpaceState,
    }),
    historyRebuild: Object.freeze({
      runId, sourceHash: source.sourceHash, role: "evidence_mirror",
      sourceMemoryId: source.recordId,
    }),
    governance: Object.freeze({
      commandType: "importEvidence",
      candidate: Object.freeze({
        phase: "raw_evidence", evidenceOnly: true, quote: source.text, sourceId: evidenceId,
      }),
      provenance: Object.freeze({ ...provenance, sourceId: evidenceId }),
      evidenceIds: Object.freeze([evidenceId]),
      native: Object.freeze({
        kind: "observation", container: "session_candidate", category: "core",
        dataType: "memory", tableName: "memories",
      }),
    }),
  });

  const treeJobs: HistoryRebuildTreeJobMaterial[] = [];
  if (active && evidenceId && sourceId && plan.semanticType) {
    const routing = Object.freeze({
      valueScore,
      importance,
      semanticType: plan.semanticType,
      scopeVisibility,
      riskFlags: Object.freeze([] as string[]) as string[],
      topicLabels: Object.freeze([...topicLabels]),
      topicHotnessEligible: topicTreeEligible,
      globalHotnessEligible: plan.treeEligibility.global,
      explicitGlobal: false,
      isWorkspaceRule: plan.treeEligibility.global && plan.semanticType === "rules" &&
        scopeVisibility === "workspace",
    });
    const leaf = Object.freeze({
      id: source.recordId,
      scope: Object.freeze({ ...source.scope }),
      chunkId: evidenceId,
      sourceId,
      entityIds: Object.freeze([] as string[]) as string[],
      importance,
      eventAt: createdAt!,
      createdAt: createdAt!,
      text: source.text,
    });
    const treePlan = planTreeFanOut({ scope: source.scope, leaf, routing });
    const normalizedTopics = topicLabels.map(normalizeTopicLabel);
    if (normalizedTopics.some((label) => label.length === 0) ||
        new Set(normalizedTopics).size !== topicLabels.length) {
      fail("HISTORY_REBUILD_INVALID_INPUT");
    }
    normalizedTopics.sort();
    const expectedTargets = [
      ...(sourceTreeEligible ? [{ treeType: "source", treeKey: sourceId }] : []),
      ...(topicTreeEligible
        ? normalizedTopics.map((treeKey) => ({ treeType: "topic", treeKey }))
        : []),
    ];
    const eligibleTargets = treePlan.targets.filter((target) =>
      (target.treeType === "source" && sourceTreeEligible) ||
      (target.treeType === "topic" && topicTreeEligible));
    if (canonicalJson(eligibleTargets.map(({ treeType, treeKey }) => ({ treeType, treeKey }))) !==
        canonicalJson(expectedTargets) || treePlan.targets.some((target) => target.treeType === "global")) {
      fail("HISTORY_REBUILD_INVALID_INPUT");
    }
    const coreScope = queueScope(source.scope);
    const context = Object.freeze({
      ...(source.scope.workspaceId === undefined ? {} : { workspaceId: source.scope.workspaceId }),
      ...(source.scope.sessionId === undefined ? {} : { sessionId: source.scope.sessionId }),
    });
    for (const target of eligibleTargets) {
      const dedupeKey = deriveDurableJobV2DomainDedupeKey(
        "build_tree", target.idempotencyKey, context,
      );
      const payload = Object.freeze({
        scope: Object.freeze({ ...coreScope, ...context }),
        traceId: leaf.id,
        treeType: target.treeType,
        treeKey: target.treeKey,
        leaf: Object.freeze({
          id: leaf.id, chunkId: leaf.chunkId, sourceId: leaf.sourceId,
          entityIds: Object.freeze([...leaf.entityIds]), text: leaf.text, eventAt: leaf.eventAt,
        }),
        routing,
        targetIdempotencyKey: target.idempotencyKey,
      });
      treeJobs.push(Object.freeze({
        id: `history-job:${hash("mengshu.history-rebuild-tree-job/v1", [runId, dedupeKey])}`,
        dedupeKey,
        scopedDedupeKey: deriveDurableJobV2ScopedDedupeKey(coreScope, dedupeKey),
        maxAttempts: 3,
        payload,
        artifactRole: `${target.treeType}_leaf` as "source_leaf" | "topic_leaf",
      }));
      const expectedBufferId = bufferId(
        source.scope,
        target.treeType,
        target.treeKey,
        0,
      );
      const finalizeTraceId = `history-finalize:${hash(
        "mengshu.history-rebuild-tree-finalize/v1",
        [runId, authorityScopeFingerprint(source.scope), target.treeType, target.treeKey,
          expectedBufferId],
      )}`;
      const finalizeDedupeKey = deriveDurableJobV2DomainDedupeKey(
        "build_tree",
        finalizeTraceId,
        context,
      );
      treeJobs.push(Object.freeze({
        id: `history-job:${hash(
          "mengshu.history-rebuild-tree-job/v1",
          [runId, finalizeDedupeKey],
        )}`,
        dedupeKey: finalizeDedupeKey,
        scopedDedupeKey: deriveDurableJobV2ScopedDedupeKey(coreScope, finalizeDedupeKey),
        maxAttempts: 100,
        payload: Object.freeze({
          scope: Object.freeze({ ...coreScope, ...context }),
          traceId: finalizeTraceId,
          treeType: target.treeType,
          treeKey: target.treeKey,
          finalize: Object.freeze({ mode: "history_rebuild", expectedBufferId }),
        }),
        artifactRole: `${target.treeType}_finalize` as
          "source_finalize" | "topic_finalize",
      }));
    }
  }
  return Object.freeze({
    source,
    plan: materialPlan,
    resultingMetadata,
    resultingLifecycleStatus: resultingLifecycle,
    ...(evidenceId === undefined
      ? {}
      : { evidenceId, evidenceContentHash, evidenceLinkId, evidenceMetadata }),
    treeJobs: Object.freeze(treeJobs),
  });
}

function dedupeHistoryRebuildFinalizeJobs(
  materials: readonly HistoryRebuildMemoryMaterial[],
): readonly HistoryRebuildMemoryMaterial[] {
  const owners = new Map<string, string>();
  const specifications = new Map<string, string>();
  for (const material of materials) {
    const sourceIdentity = `${material.source.recordId}\0${material.source.sourceHash}`;
    for (const job of material.treeJobs) {
      if (!job.artifactRole.endsWith("_finalize")) continue;
      const specification = canonicalJson(job);
      const existing = specifications.get(job.scopedDedupeKey);
      if (existing !== undefined && existing !== specification) {
        fail("HISTORY_REBUILD_INVALID_DB_RESULT");
      }
      specifications.set(job.scopedDedupeKey, specification);
      const owner = owners.get(job.scopedDedupeKey);
      if (owner === undefined || sourceIdentity < owner) {
        owners.set(job.scopedDedupeKey, sourceIdentity);
      }
    }
  }
  return Object.freeze(materials.map((material) => {
    const sourceIdentity = `${material.source.recordId}\0${material.source.sourceHash}`;
    const treeJobs = material.treeJobs.filter((job) =>
      !job.artifactRole.endsWith("_finalize") ||
      owners.get(job.scopedDedupeKey) === sourceIdentity);
    return treeJobs.length === material.treeJobs.length ? material : Object.freeze({
      ...material,
      treeJobs: Object.freeze(treeJobs),
    });
  }));
}

const LIST_SCOPES_SQL = `/* history-rebuild:list-scopes */
WITH scoped AS (
  SELECT tenant_id, user_id, canonical_project_id, product_id, producer_id, namespace,
    visibility, COALESCE(workspace_id, '') AS workspace_id,
    COALESCE(metadata->>'sessionId', '') AS session_id,
    COUNT(*)::bigint AS memories_count, 0::bigint AS knowledge_count
  FROM memories WHERE legacy_quarantine_reason IS NULL
    AND metadata#>>'{historyRebuild,role}' IS DISTINCT FROM 'evidence_mirror'
  GROUP BY tenant_id, user_id, canonical_project_id, product_id, producer_id, namespace,
    visibility, COALESCE(workspace_id, ''), COALESCE(metadata->>'sessionId', '')
  UNION ALL
  SELECT tenant_id, user_id, canonical_project_id, product_id, producer_id, namespace,
    visibility, COALESCE(workspace_id, '') AS workspace_id,
    COALESCE(metadata->>'sessionId', '') AS session_id,
    0::bigint AS memories_count, COUNT(*)::bigint AS knowledge_count
  FROM knowledge WHERE legacy_quarantine_reason IS NULL
    AND metadata#>>'{historyRebuild,role}' IS DISTINCT FROM 'evidence_mirror'
  GROUP BY tenant_id, user_id, canonical_project_id, product_id, producer_id, namespace,
    visibility, COALESCE(workspace_id, ''), COALESCE(metadata->>'sessionId', '')
), aggregated AS (
  SELECT tenant_id, user_id, canonical_project_id, product_id, producer_id, namespace,
    visibility, workspace_id, session_id, SUM(memories_count)::text AS memories_count,
    SUM(knowledge_count)::text AS knowledge_count
  FROM scoped
  GROUP BY tenant_id, user_id, canonical_project_id, product_id, producer_id, namespace,
    visibility, workspace_id, session_id
)
SELECT * FROM aggregated
WHERE $1::text IS NULL OR ROW(tenant_id, user_id, canonical_project_id, product_id,
  producer_id, namespace, visibility, workspace_id, session_id) >
  ROW($1, $2, $3, $4, $5, $6, $7, $8, $9)
ORDER BY tenant_id, user_id, canonical_project_id, product_id, producer_id, namespace,
  visibility, workspace_id, session_id
LIMIT $10`;

function sourceSnapshotSql(table: HistoryRebuildSourceTable): string {
  return `/* history-rebuild:source-snapshot:${table} */
SELECT (array_agg(id ORDER BY id DESC))[1]::text AS source_upper_bound,
  COUNT(*)::text AS source_count
FROM ${table}
WHERE tenant_id = $1 AND user_id = $2 AND canonical_project_id = $3
  AND product_id = $4 AND producer_id = $5 AND namespace = $6
  AND visibility = $7 AND COALESCE(workspace_id, '') = $8
  AND COALESCE(metadata->>'sessionId', '') = $9
  AND metadata#>>'{historyRebuild,role}' IS DISTINCT FROM 'evidence_mirror'
  AND legacy_quarantine_reason IS NULL`;
}

function keysetScanSql(table: HistoryRebuildSourceTable): string {
  return `/* history-rebuild:keyset-scan:${table} */
SELECT id::text, text, content_hash, vector::text AS vector_text,
  importance::double precision AS importance,
  category, data_type, lifecycle_status,
  floor(extract(epoch FROM created_at) * 1000)::text AS created_at_ms,
  embedding_space_id, embedding_space_state, metadata,
  tenant_id, user_id, canonical_project_id, product_id, producer_id, namespace,
  visibility, COALESCE(workspace_id, '') AS workspace_id,
  COALESCE(metadata->>'sessionId', '') AS session_id
FROM ${table}
WHERE tenant_id = $1 AND user_id = $2 AND canonical_project_id = $3
  AND product_id = $4 AND producer_id = $5 AND namespace = $6
  AND visibility = $7 AND COALESCE(workspace_id, '') = $8
  AND COALESCE(metadata->>'sessionId', '') = $9
  AND ($10::uuid IS NULL OR id > $10::uuid)
  AND ($11::uuid IS NOT NULL AND id <= $11::uuid)
  AND metadata#>>'{historyRebuild,role}' IS DISTINCT FROM 'evidence_mirror'
  AND legacy_quarantine_reason IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM mengshu_history_rebuild_shadow_plans plan
    WHERE plan.run_id = $12 AND plan.source_table = $13 AND plan.record_id = ${table}.id
  )
ORDER BY id ASC
LIMIT $14`;
}

export function historyRebuildSourceKind(
  table: HistoryRebuildSourceTable,
  row: Readonly<Record<string, unknown>>,
): {
  readonly kind: MemoryKind;
  readonly conflict: boolean;
} {
  if (table === "knowledge") return { kind: "knowledge", conflict: false };
  const metadata = plainRecord(row.metadata) ? row.metadata : {};
  const governance = plainRecord(ownData(metadata, "governance"))
    ? ownData(metadata, "governance") as Readonly<Record<string, unknown>> : undefined;
  const native = governance && plainRecord(ownData(governance, "native"))
    ? ownData(governance, "native") as Readonly<Record<string, unknown>> : undefined;
  const explicitCandidates = [
    native ? ownData(native, "kind") : undefined,
    ownData(metadata, "kind"),
    ownData(metadata, "memoryKind"),
    ownData(row, "memory_kind"),
  ].filter((value): value is MemoryKind =>
    typeof value === "string" && MEMORY_KINDS.has(value as MemoryKind));
  const distinctExplicit = [...new Set(explicitCandidates)];
  if (distinctExplicit.length > 0) {
    return { kind: distinctExplicit[0]!, conflict: distinctExplicit.length > 1 };
  }
  const candidates: MemoryKind[] = [];
  const dataType = row.data_type;
  const category = row.category;
  if (dataType === "document") candidates.push("document");
  else if (dataType === "knowledge") candidates.push("knowledge");
  else if (typeof category === "string" && MEMORY_KINDS.has(category as MemoryKind) &&
      category !== "other") candidates.push(category as MemoryKind);
  const distinct = [...new Set(candidates)];
  return { kind: distinct[0] ?? "other", conflict: false };
}

function sourceArray(metadata: Readonly<Record<string, unknown>>, key: string): readonly string[] {
  const value = ownData(metadata, key);
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? Object.freeze([...value]) : Object.freeze([]);
}

function decodeSourceRow(
  sourceTable: HistoryRebuildSourceTable,
  raw: unknown,
  scope: MemoryScope,
): HistoryRebuildScanRow {
  if (!plainRecord(raw) || typeof raw.id !== "string" || !UUID.test(raw.id) ||
      typeof raw.text !== "string" ||
      typeof raw.content_hash !== "string" || raw.content_hash.length === 0 ||
      typeof raw.vector_text !== "string" ||
      (raw.importance !== null && (typeof raw.importance !== "number" ||
        !Number.isFinite(raw.importance) || raw.importance < 0 || raw.importance > 1)) ||
      typeof raw.category !== "string" || typeof raw.data_type !== "string" ||
      typeof raw.created_at_ms !== "string" || !/^(0|[1-9][0-9]*)$/.test(raw.created_at_ms) ||
      !plainRecord(raw.metadata)) {
    fail("HISTORY_REBUILD_INVALID_DB_RESULT");
  }
  let vector: unknown;
  try {
    vector = JSON.parse(raw.vector_text);
  } catch {
    fail("HISTORY_REBUILD_INVALID_DB_RESULT");
  }
  const createdAt = Number(raw.created_at_ms);
  if (!Array.isArray(vector) || vector.length === 0 || vector.some((item) =>
    typeof item !== "number" || !Number.isFinite(item)) ||
      !Number.isSafeInteger(createdAt) || createdAt < 0 ||
      (raw.embedding_space_id !== null && typeof raw.embedding_space_id !== "string") ||
      (raw.embedding_space_state !== null && typeof raw.embedding_space_state !== "string")) {
    fail("HISTORY_REBUILD_INVALID_DB_RESULT");
  }
  const params = scopeParams(scope);
  const actual = [raw.tenant_id, raw.user_id, raw.canonical_project_id, raw.product_id,
    raw.producer_id, raw.namespace, raw.visibility, raw.workspace_id, raw.session_id];
  if (actual.some((value, index) => value !== params[index])) {
    fail("HISTORY_REBUILD_INVALID_DB_RESULT");
  }
  const { kind, conflict } = historyRebuildSourceKind(sourceTable, raw);
  const metadata = raw.metadata;
  const topicLabels = sourceArray(metadata, "topicLabels");
  const evidenceIds = sourceArray(metadata, "sourceNodeIds");
  const metadataValueScore = ownData(metadata, "valueScore");
  const metadataConfidence = ownData(metadata, "confidence");
  const sourceHash = hash("mengshu.history-rebuild-source/v1", {
    sourceTable, id: raw.id, text: raw.text, contentHash: raw.content_hash,
    metadata, category: raw.category, dataType: raw.data_type,
    lifecycleStatus: raw.lifecycle_status, scope: Object.freeze({ ...scope }), vector,
    importance: raw.importance, createdAt, embeddingSpaceId: raw.embedding_space_id,
    embeddingSpaceState: raw.embedding_space_state,
  });
  return Object.freeze({
    sourceTable,
    recordId: raw.id,
    sourceHash,
    text: raw.text,
    kind,
    metadata,
    scope: Object.freeze({ ...scope }),
    ...(typeof raw.lifecycle_status === "string"
      ? { lifecycleStatus: raw.lifecycle_status as HistoryRebuildScanRow["lifecycleStatus"] }
      : {}),
    contentHash: raw.content_hash,
    vector: Object.freeze([...vector as number[]]),
    ...(raw.importance === null ? {} : { importance: raw.importance }),
    ...(typeof metadataValueScore === "number" && Number.isFinite(metadataValueScore) &&
      metadataValueScore >= 0 && metadataValueScore <= 1 ? { valueScore: metadataValueScore } : {}),
    ...(typeof metadataConfidence === "number" && Number.isFinite(metadataConfidence) &&
      metadataConfidence >= 0 && metadataConfidence <= 1 ? { confidence: metadataConfidence } : {}),
    category: raw.category,
    dataType: raw.data_type,
    createdAt,
    embeddingSpaceId: raw.embedding_space_id as string | null,
    embeddingSpaceState: raw.embedding_space_state as string | null,
    canCreateEvidenceMirror: sourceTable === "memories",
    evidenceIds,
    topicLabels,
    classificationConflict: conflict,
  });
}

function validCountRecord(value: unknown): value is Readonly<Record<string, number>> {
  return plainRecord(value) && Object.keys(value).length > 0 &&
    Object.values(value).every((count) =>
      typeof count === "number" && Number.isSafeInteger(count) && count >= 0);
}

function validateFunnelCounts(counts: HistoryRebuildFunnelCounts, plans: readonly HistoryRebuildPlan[]): void {
  if (!validCountRecord(counts) || counts.total !== plans.length ||
      counts.total !== counts.preserve + counts.backfill + counts.modelClassify +
        counts.lookupOnly + counts.quarantine) fail("HISTORY_REBUILD_INVALID_INPUT");
  const actual: Record<string, number> = {
    preserve: 0, backfill: 0, model_classify: 0, lookup_only: 0, quarantine: 0,
  };
  for (const plan of plans) actual[plan.disposition] = (actual[plan.disposition] ?? 0) + 1;
  if (actual.preserve !== counts.preserve || actual.backfill !== counts.backfill ||
      actual.model_classify !== counts.modelClassify || actual.lookup_only !== counts.lookupOnly ||
      actual.quarantine !== counts.quarantine) fail("HISTORY_REBUILD_INVALID_INPUT");
}

function validatePlan(
  plan: HistoryRebuildPlan,
  input: HistoryRebuildBatchCommit,
): void {
  if (!plainRecord(plan) || plan.sourceTable !== input.sourceTable ||
      typeof plan.recordId !== "string" || !UUID.test(plan.recordId) ||
      typeof plan.sourceHash !== "string" || !SHA256.test(plan.sourceHash) ||
      typeof plan.receiptHash !== "string" || !SHA256.test(plan.receiptHash) ||
      !Array.isArray(plan.topicLabels) || !plainRecord(plan.treeEligibility)) {
    fail("HISTORY_REBUILD_INVALID_INPUT");
  }
  const quarantinedKnowledge = plan.disposition === "quarantine" &&
    plan.semanticType === undefined && plan.reason === "invalid_source_row";
  if (input.sourceTable === "knowledge" &&
      ((!quarantinedKnowledge && plan.semanticType !== "resource") || plan.contextEligible ||
        plan.treeEligibility.source || plan.treeEligibility.topic || plan.treeEligibility.global)) {
    fail("HISTORY_REBUILD_INVALID_INPUT");
  }
  if (plan.semanticType !== undefined && !SEMANTIC_TYPES.has(plan.semanticType)) {
    fail("HISTORY_REBUILD_INVALID_INPUT");
  }
}

function validateModelReceipt(
  receipt: HistoryRebuildModelReceiptInput,
  plans: readonly HistoryRebuildPlan[],
): void {
  const hashes = [receipt.receiptHash, receipt.sourceHash, receipt.planReceiptHash,
    receipt.modelFingerprint,
    receipt.promptHash, receipt.schemaHash, receipt.inputHash, receipt.outputHash];
  const plan = plans.find((candidate) => candidate.recordId === receipt.recordId &&
    candidate.sourceHash === receipt.sourceHash);
  if (!plainRecord(receipt) || hashes.some((value) => typeof value !== "string" || !SHA256.test(value)) ||
      !UUID.test(receipt.recordId) || !Number.isFinite(receipt.confidence) ||
      receipt.confidence < 0 || receipt.confidence > 1 ||
      ![receipt.proposalCount, receipt.inputTokens, receipt.outputTokens].every((value) =>
        Number.isSafeInteger(value) && value >= 0) ||
      !plan || receipt.planReceiptHash !== plan.receiptHash ||
      ((plan.reason === "model_classification_accepted" ||
        plan.reason === "model_confidence_below_threshold") &&
        plan.modelConfidence !== receipt.confidence) ||
      !(
          plan.disposition === "model_classify" ||
          (plan.disposition === "lookup_only" &&
            plan.reason === "model_confidence_below_threshold") ||
          (plan.semanticType !== undefined && plan.contextEligible &&
            plan.semanticType !== "profile" && plan.topicLabels.length > 0 &&
            (plan.reason === "valid_explicit_semantic_type" ||
              plan.reason === "deterministic_kind_mapping"))
        )) {
    fail("HISTORY_REBUILD_INVALID_INPUT");
  }
}

function validateBatch(input: HistoryRebuildBatchCommit): string {
  if (!plainRecord(input) || !SAFE_ID.test(input.runId) || !SOURCE_TABLES.includes(input.sourceTable) ||
      !Number.isSafeInteger(input.expectedCheckpointVersion) || input.expectedCheckpointVersion < 0 ||
      (input.expectedAfterId !== null && !UUID.test(input.expectedAfterId)) ||
      (input.nextAfterId !== null && !UUID.test(input.nextAfterId)) ||
      !Number.isSafeInteger(input.now) || input.now < 0 || !Array.isArray(input.sourceRows) ||
      !Array.isArray(input.plans) || input.sourceRows.length !== input.plans.length ||
      !Array.isArray(input.modelReceipts) || !plainRecord(input.operationReceipt) ||
      !SHA256.test(input.operationReceipt.receiptHash) ||
      !validCountRecord(input.operationReceipt.counts)) fail("HISTORY_REBUILD_INVALID_INPUT");
  exactScope(input.scope);
  const fingerprint = authorityScopeFingerprint(input.scope);
  validateFunnelCounts(input.counts, input.plans);
  const sourceIdentities = new Set<string>();
  for (const candidate of input.sourceRows) {
    if (!plainRecord(candidate) || candidate.sourceTable !== input.sourceTable ||
        typeof candidate.recordId !== "string" || !UUID.test(candidate.recordId) ||
        typeof candidate.sourceHash !== "string" || !SHA256.test(candidate.sourceHash) ||
        !plainRecord(candidate.metadata) || !plainRecord(candidate.scope)) {
      fail("HISTORY_REBUILD_INVALID_INPUT");
    }
    const candidateScope = candidate.scope as unknown as MemoryScope;
    exactScope(candidateScope);
    if (authorityScopeFingerprint(candidateScope) !== fingerprint) {
      fail("HISTORY_REBUILD_INVALID_INPUT");
    }
    const row = candidate as unknown as HistoryRebuildScanRow;
    const identity = `${row.recordId}\0${row.sourceHash}`;
    if (sourceIdentities.has(identity)) fail("HISTORY_REBUILD_INVALID_INPUT");
    sourceIdentities.add(identity);
  }
  for (const plan of input.plans) validatePlan(plan, input);
  if (input.plans.some((plan) => !sourceIdentities.has(`${plan.recordId}\0${plan.sourceHash}`))) {
    fail("HISTORY_REBUILD_INVALID_INPUT");
  }
  const receiptIdentities = new Set<string>();
  for (const receipt of input.modelReceipts) {
    validateModelReceipt(receipt, input.plans);
    const identity = `${receipt.recordId}\0${receipt.sourceHash}`;
    if (receiptIdentities.has(identity)) fail("HISTORY_REBUILD_INVALID_INPUT");
    receiptIdentities.add(identity);
  }
  if (input.plans.some((plan) =>
    (plan.reason === "model_classification_accepted" ||
      plan.reason === "model_confidence_below_threshold") &&
    !receiptIdentities.has(`${plan.recordId}\0${plan.sourceHash}`))) {
    fail("HISTORY_REBUILD_INVALID_INPUT");
  }
  return fingerprint;
}

async function rollback(client: PostgresHistoryRebuildClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    fail("HISTORY_REBUILD_DATABASE_FAILED");
  }
}

function oneResultRow(
  result: PostgresHistoryRebuildQueryResult,
): Readonly<Record<string, unknown>> {
  if (!Array.isArray(result.rows) || result.rows.length !== 1 || result.rowCount !== 1 ||
      !plainRecord(result.rows[0])) fail("HISTORY_REBUILD_INVALID_DB_RESULT");
  return result.rows[0];
}

function validAttemptIdentity(input: HistoryRebuildModelAttemptIdentity): boolean {
  return plainRecord(input) && SAFE_ID.test(input.migrationId) && SAFE_ID.test(input.runId) &&
    SOURCE_TABLES.includes(input.sourceTable) && UUID.test(input.recordId) &&
    SHA256.test(input.manifestHash) && SHA256.test(input.sourceHash) &&
    Number.isSafeInteger(input.attempt) && input.attempt >= 0 && input.attempt < 2 &&
    [input.modelFingerprint, input.promptHash, input.schemaHash, input.inputHash]
      .every((value) => SHA256.test(value));
}

function validAttemptUsage(
  usage: HistoryRebuildModelAttemptUsage,
  expectedCalls?: number,
): boolean {
  return plainRecord(usage) &&
    [usage.modelCalls, usage.inputTokens, usage.outputTokens, usage.costMinorUnits]
      .every((value) => Number.isSafeInteger(value) && value >= 0) &&
    (expectedCalls === undefined || usage.modelCalls === expectedCalls);
}

function modelAttemptIdentityParams(input: HistoryRebuildModelAttemptIdentity): readonly unknown[] {
  return [
    input.migrationId, input.manifestHash, input.runId, input.sourceTable,
    input.recordId, input.sourceHash, input.attempt, input.modelFingerprint,
    input.promptHash, input.schemaHash, input.inputHash,
  ];
}

function canonicalOutputHash(output: unknown): string {
  return createHash("sha256").update(canonicalJson(output)).digest("hex");
}

function requiredResultCount(value: unknown): number {
  const result = integer(value);
  return result === null ? fail("HISTORY_REBUILD_INVALID_DB_RESULT") : result;
}

function frozenMaterialRows(
  result: PostgresHistoryRebuildQueryResult,
  runId: string,
  policy: HistoryRebuildTreeRoutingPolicy | undefined,
  allowLegacyPolicy = false,
): readonly HistoryRebuildMemoryMaterial[] {
  if (!Array.isArray(result.rows) ||
      (result.rowCount ?? result.rows.length) !== result.rows.length) {
    fail("HISTORY_REBUILD_INVALID_DB_RESULT");
  }
  const materials: HistoryRebuildMemoryMaterial[] = [];
  const identities = new Set<string>();
  for (const raw of result.rows) {
    if (!plainRecord(raw) || !plainRecord(raw.source_row) || !plainRecord(raw.plan) ||
        (raw.source_table !== "memories" && raw.source_table !== "knowledge") ||
        typeof raw.record_id !== "string" || !UUID.test(raw.record_id) ||
        typeof raw.source_hash !== "string" || !SHA256.test(raw.source_hash)) {
      fail("HISTORY_REBUILD_INVALID_DB_RESULT");
    }
    const source = raw.source_row as unknown as HistoryRebuildScanRow;
    const plan = raw.plan as unknown as HistoryRebuildPlan;
    const identity = `${raw.source_table}\0${raw.record_id}\0${raw.source_hash}`;
    if (identities.has(identity) || source.sourceTable !== raw.source_table ||
        source.recordId !== raw.record_id || source.sourceHash !== raw.source_hash ||
        plan.sourceTable !== raw.source_table || plan.recordId !== raw.record_id ||
        plan.sourceHash !== raw.source_hash) {
      fail("HISTORY_REBUILD_INVALID_DB_RESULT");
    }
    identities.add(identity);
    if (raw.source_table === "knowledge") continue;
    try {
      const material = buildHistoryRebuildMemoryMaterial({
        runId,
        source,
        plan,
        ...(policy === undefined ? {} : { policy }),
        ...(allowLegacyPolicy ? { allowLegacyPolicy: true } : {}),
      });
      if (material !== undefined) materials.push(material);
    } catch {
      fail("HISTORY_REBUILD_INVALID_DB_RESULT");
    }
  }
  return dedupeHistoryRebuildFinalizeJobs(materials);
}

function materialJson(materials: readonly HistoryRebuildMemoryMaterial[]): string {
  return `[${materials.map((material) => canonicalJson(material)).join(",")}]`;
}

function executeRunBinding(input: ExecuteHistoryRebuildRunInput): {
  readonly scopeFingerprint: string;
  readonly scopeKey: string;
  readonly params: readonly unknown[];
} {
  if (!plainRecord(input) || !SAFE_ID.test(input.runId) ||
      !Number.isSafeInteger(input.now) || input.now < 0) fail("HISTORY_REBUILD_INVALID_INPUT");
  exactScope(input.scope);
  const scopeFingerprint = authorityScopeFingerprint(input.scope);
  return Object.freeze({
    scopeFingerprint,
    scopeKey: scopeToKey(input.scope),
    params: Object.freeze([input.runId, scopeFingerprint, ...scopeParams(input.scope), input.now]),
  });
}

function executionTreePolicy(
  value: unknown,
  scope: MemoryScope,
): HistoryRebuildTreeRoutingPolicy {
  return validatedHistoryRebuildTreeRoutingPolicy(
    value,
    authorityScopeFingerprint(scope),
  ).policy;
}

export class PostgresHistoryRebuildRepository {
  constructor(private readonly client: PostgresHistoryRebuildClient) {}

  async listScopes(input: ListHistoryRebuildScopesInput): Promise<readonly HistoryRebuildScopeSummary[]> {
    if (!plainRecord(input) || !Number.isSafeInteger(input.limit) || input.limit < 1 ||
        input.limit > 1_000) fail("HISTORY_REBUILD_INVALID_INPUT");
    const after = input.after === undefined ? Array(9).fill(null) : scopeParams(input.after);
    try {
      const result = await this.client.query(LIST_SCOPES_SQL, [...after, input.limit]);
      if (!Array.isArray(result.rows) || (result.rowCount ?? result.rows.length) !== result.rows.length ||
          result.rows.length > input.limit) fail("HISTORY_REBUILD_INVALID_DB_RESULT");
      return Object.freeze(result.rows.map((raw) => {
        if (!plainRecord(raw)) fail("HISTORY_REBUILD_INVALID_DB_RESULT");
        const memoriesCount = integer(raw.memories_count);
        const knowledgeCount = integer(raw.knowledge_count);
        const visibility = raw.visibility;
        const strings = [raw.tenant_id, raw.user_id, raw.canonical_project_id, raw.product_id,
          raw.producer_id, raw.namespace, raw.workspace_id, raw.session_id];
        if (memoriesCount === null || knowledgeCount === null ||
            strings.some((value) => typeof value !== "string") ||
            !["private", "workspace", "team", "public"].includes(String(visibility))) {
          fail("HISTORY_REBUILD_INVALID_DB_RESULT");
        }
        const workspaceId = raw.workspace_id as string;
        const sessionId = raw.session_id as string;
        return Object.freeze({
          scope: Object.freeze({
            tenantId: raw.tenant_id as string, userId: raw.user_id as string,
            projectId: raw.canonical_project_id as string, appId: raw.product_id as string,
            agentId: raw.producer_id as string, namespace: raw.namespace as string,
            visibility: visibility as MemoryScope["visibility"],
            ...(workspaceId === "" ? {} : { workspaceId }),
            ...(sessionId === "" ? {} : { sessionId }),
          }),
          memoriesCount,
          knowledgeCount,
        });
      }));
    } catch (error) {
      if (error instanceof HistoryRebuildRepositoryError) throw error;
      return fail("HISTORY_REBUILD_DATABASE_FAILED");
    }
  }

  async createRun(input: CreateHistoryRebuildRunInput): Promise<CreatedHistoryRebuildRun> {
    if (!plainRecord(input) || !SAFE_ID.test(input.runId) || !SAFE_ID.test(input.migrationId) ||
        ![input.manifestHash, input.modelFingerprint, input.promptHash, input.schemaHash,
          input.policyHash].every((value) => typeof value === "string" && SHA256.test(value)) ||
        !Number.isSafeInteger(input.now) || input.now < 0) fail("HISTORY_REBUILD_INVALID_INPUT");
    exactScope(input.scope);
    const params = scopeParams(input.scope);
    const scopeFingerprint = authorityScopeFingerprint(input.scope);
    try {
      await this.client.query("BEGIN");
      const snapshots: HistoryRebuildSourceSnapshot[] = [];
      for (const sourceTable of SOURCE_TABLES) {
        const result = await this.client.query(sourceSnapshotSql(sourceTable), params);
        if (!Array.isArray(result.rows) || result.rows.length !== 1 || result.rowCount !== 1 ||
            !plainRecord(result.rows[0])) fail("HISTORY_REBUILD_INVALID_DB_RESULT");
        const sourceUpperBound = result.rows[0].source_upper_bound;
        const sourceCount = integer(result.rows[0].source_count);
        if ((sourceUpperBound !== null &&
              (typeof sourceUpperBound !== "string" || !UUID.test(sourceUpperBound))) ||
            sourceCount === null || (sourceCount === 0) !== (sourceUpperBound === null)) {
          fail("HISTORY_REBUILD_INVALID_DB_RESULT");
        }
        snapshots.push(Object.freeze({
          sourceTable,
          sourceUpperBound: sourceUpperBound as string | null,
          sourceCount,
          snapshotHash: hash("mengshu.history-rebuild-snapshot/v1", {
            sourceTable, sourceUpperBound, sourceCount, scopeFingerprint,
          }),
          afterId: null,
          checkpointVersion: 0,
          processedCount: 0,
          checkpointState: "running",
        }));
      }
      const attemptHash = hash("mengshu.history-rebuild-attempt/v1", {
        migrationId: input.migrationId,
        scopeFingerprint,
        manifestHash: input.manifestHash,
        modelFingerprint: input.modelFingerprint,
        promptHash: input.promptHash,
        schemaHash: input.schemaHash,
        policyHash: input.policyHash,
        // Keep the attempt identity stable across operator upgrades. Mutable resume
        // fields belong to checkpoints and must never change the frozen attempt hash.
        snapshots: snapshots.map((snapshot) => ({
          sourceTable: snapshot.sourceTable,
          sourceUpperBound: snapshot.sourceUpperBound,
          sourceCount: snapshot.sourceCount,
          snapshotHash: snapshot.snapshotHash,
        })),
      });
      const inserted = await this.client.query(RUN_INSERT_SQL, [
        input.runId, input.migrationId, scopeFingerprint, ...params,
        input.manifestHash, input.modelFingerprint, input.promptHash,
        input.schemaHash, input.policyHash, attemptHash, input.now,
      ]);
      let runId = input.runId;
      let state: CreatedHistoryRebuildRun["state"] = "running";
      let effectiveSnapshots = snapshots;
      if (inserted.rowCount === 1) {
        for (const snapshot of snapshots) {
          const stored = await this.client.query(SNAPSHOT_INSERT_SQL, [
            input.runId, snapshot.sourceTable, snapshot.sourceUpperBound,
            snapshot.sourceCount, snapshot.snapshotHash, input.now,
          ]);
          const checkpoint = await this.client.query(CHECKPOINT_INSERT_SQL, [
            input.runId, snapshot.sourceTable,
            JSON.stringify({ total: 0, preserve: 0, backfill: 0, modelClassify: 0,
              lookupOnly: 0, quarantine: 0 }), input.now,
          ]);
          if (stored.rowCount !== 1 || checkpoint.rowCount !== 1) {
            fail("HISTORY_REBUILD_CONCURRENT_DRIFT");
          }
        }
      } else if (inserted.rowCount === 0) {
        const existing = await this.client.query(RESUMABLE_RUN_SQL, [
          input.migrationId, scopeFingerprint, attemptHash, input.manifestHash,
          input.modelFingerprint, input.promptHash, input.schemaHash, input.policyHash,
        ]);
        if (existing.rowCount !== 1 || existing.rows.length !== 1 ||
            !plainRecord(existing.rows[0]) ||
            typeof existing.rows[0].run_id !== "string" ||
            !["running", "completed"].includes(String(existing.rows[0].state))) {
          fail("HISTORY_REBUILD_CONCURRENT_DRIFT");
        }
        runId = existing.rows[0].run_id;
        state = existing.rows[0].state as CreatedHistoryRebuildRun["state"];
        const resumed = await this.client.query(RESUMABLE_SNAPSHOTS_SQL, [runId]);
        if (resumed.rowCount !== SOURCE_TABLES.length || resumed.rows.length !== SOURCE_TABLES.length) {
          fail("HISTORY_REBUILD_CONCURRENT_DRIFT");
        }
        effectiveSnapshots = snapshots.map((expected) => {
          const raw = resumed.rows.find((row) => row.source_table === expected.sourceTable);
          if (!plainRecord(raw)) fail("HISTORY_REBUILD_CONCURRENT_DRIFT");
          const sourceCount = integer(raw.source_count);
          const checkpointVersion = integer(raw.checkpoint_version);
          const processedCount = integer(raw.processed_count);
          const afterId = raw.after_id;
          const checkpointState = raw.checkpoint_state;
          if (raw.source_upper_bound !== expected.sourceUpperBound ||
              sourceCount !== expected.sourceCount || raw.snapshot_hash !== expected.snapshotHash ||
              checkpointVersion === null || processedCount === null || processedCount > sourceCount ||
              (afterId !== null && (typeof afterId !== "string" || !UUID.test(afterId))) ||
              !["running", "completed"].includes(String(checkpointState)) ||
              (checkpointState === "completed" && processedCount !== sourceCount)) {
            fail("HISTORY_REBUILD_CONCURRENT_DRIFT");
          }
          return Object.freeze({
            ...expected, afterId: afterId as string | null, checkpointVersion,
            processedCount, checkpointState: checkpointState as HistoryRebuildCheckpoint["state"],
          });
        });
      } else {
        fail("HISTORY_REBUILD_INVALID_DB_RESULT");
      }
      await this.client.query("COMMIT");
      return Object.freeze({
        runId,
        scopeFingerprint,
        attemptHash,
        state,
        snapshots: Object.freeze(effectiveSnapshots),
      });
    } catch (error) {
      await rollback(this.client);
      if (error instanceof HistoryRebuildRepositoryError) throw error;
      return fail("HISTORY_REBUILD_DATABASE_FAILED");
    }
  }

  async scanBatch(input: ScanHistoryRebuildBatchInput): Promise<readonly HistoryRebuildScanRow[]> {
    if (!plainRecord(input) || !SAFE_ID.test(input.runId) ||
        !SOURCE_TABLES.includes(input.sourceTable) ||
        (input.afterId !== null && !UUID.test(input.afterId)) ||
        (input.sourceUpperBound !== null && !UUID.test(input.sourceUpperBound)) ||
        !Number.isSafeInteger(input.batchSize) || input.batchSize < 1 || input.batchSize > 1_000) {
      fail("HISTORY_REBUILD_INVALID_INPUT");
    }
    if (input.sourceUpperBound === null) return Object.freeze([]);
    try {
      const params = [
        ...scopeParams(input.scope), input.afterId, input.sourceUpperBound,
        input.runId, input.sourceTable, input.batchSize,
      ];
      const result = await this.client.query(keysetScanSql(input.sourceTable), params);
      if (!Array.isArray(result.rows) || (result.rowCount ?? result.rows.length) !== result.rows.length ||
          result.rows.length > input.batchSize) fail("HISTORY_REBUILD_INVALID_DB_RESULT");
      const rows = result.rows.map((row) => decodeSourceRow(input.sourceTable, row, input.scope));
      if (rows.some((row, index) => index > 0 && row.recordId <= rows[index - 1]!.recordId)) {
        fail("HISTORY_REBUILD_INVALID_DB_RESULT");
      }
      return Object.freeze(rows);
    } catch (error) {
      if (error instanceof HistoryRebuildRepositoryError) throw error;
      return fail("HISTORY_REBUILD_DATABASE_FAILED");
    }
  }

  async reserveModelAttempt(
    input: ReserveHistoryRebuildModelAttemptInput,
  ): Promise<HistoryRebuildModelAttemptReservation> {
    if (!validAttemptIdentity(input) || !validAttemptUsage(input.usageCeiling, 1) ||
        !plainRecord(input.budget) || !Number.isSafeInteger(input.now) || input.now < 0 ||
        ![input.budget.maxModelCalls, input.budget.maxInputTokens,
          input.budget.maxOutputTokens, input.budget.maxCostMinorUnits]
          .every((value) => Number.isSafeInteger(value) && value >= 0)) {
      fail("HISTORY_REBUILD_INVALID_INPUT");
    }
    try {
      await this.client.query("BEGIN");
      await this.client.query(MODEL_ATTEMPT_ADVISORY_LOCK_SQL, [
        input.migrationId, input.manifestHash,
      ]);
      const existing = await this.client.query(MODEL_ATTEMPT_READ_SQL, [
        input.runId, input.sourceTable, input.recordId, input.attempt,
      ]);
      if (!Array.isArray(existing.rows) || ![0, 1].includes(existing.rowCount ?? existing.rows.length) ||
          existing.rows.length !== (existing.rowCount ?? existing.rows.length)) {
        fail("HISTORY_REBUILD_INVALID_DB_RESULT");
      }
      if (existing.rows.length === 1) {
        const row = existing.rows[0];
        if (!plainRecord(row) || row.migration_id !== input.migrationId ||
            row.manifest_hash !== input.manifestHash || row.run_id !== input.runId ||
            row.source_table !== input.sourceTable || row.record_id !== input.recordId ||
            row.source_hash !== input.sourceHash || integer(row.attempt) !== input.attempt ||
            row.model_fingerprint !== input.modelFingerprint || row.prompt_hash !== input.promptHash ||
            row.schema_hash !== input.schemaHash || row.input_hash !== input.inputHash) {
          fail("HISTORY_REBUILD_CONCURRENT_DRIFT");
        }
        if (row.state === "reserved") {
          await this.client.query("COMMIT");
          return Object.freeze({
            state: input.resumeUnresolved === true
              ? "retry_next_attempt" as const
              : "in_flight_or_unknown" as const,
          });
        }
        const output = row.output;
        const usage = {
          modelCalls: 1,
          inputTokens: integer(row.actual_input_tokens),
          outputTokens: integer(row.actual_output_tokens),
          costMinorUnits: integer(row.actual_cost_minor_units),
        };
        if (row.state !== "completed" || !plainRecord(output) ||
            typeof row.output_hash !== "string" || !SHA256.test(row.output_hash) ||
            row.output_hash !== canonicalOutputHash(output) ||
            Object.values(usage).some((value) => value === null)) {
          fail("HISTORY_REBUILD_CONCURRENT_DRIFT");
        }
        await this.client.query("COMMIT");
        return Object.freeze({
          state: "completed",
          result: Object.freeze({
            version: 1,
            output,
            outputHash: row.output_hash,
            usage: Object.freeze(usage as HistoryRebuildModelAttemptUsage),
          }),
        });
      }

      const persisted = oneResultRow(await this.client.query(MODEL_ATTEMPT_BUDGET_SQL, [
        input.migrationId, input.manifestHash,
      ]));
      const usage = {
        modelCalls: integer(persisted.model_calls),
        inputTokens: integer(persisted.input_tokens),
        outputTokens: integer(persisted.output_tokens),
        costMinorUnits: integer(persisted.cost_minor_units),
      };
      if (Object.values(usage).some((value) => value === null)) {
        fail("HISTORY_REBUILD_INVALID_DB_RESULT");
      }
      const prospective = {
        modelCalls: usage.modelCalls! + input.usageCeiling.modelCalls,
        inputTokens: usage.inputTokens! + input.usageCeiling.inputTokens,
        outputTokens: usage.outputTokens! + input.usageCeiling.outputTokens,
        costMinorUnits: usage.costMinorUnits! + input.usageCeiling.costMinorUnits,
      };
      if (prospective.modelCalls > input.budget.maxModelCalls ||
          prospective.inputTokens > input.budget.maxInputTokens ||
          prospective.outputTokens > input.budget.maxOutputTokens ||
          prospective.costMinorUnits > input.budget.maxCostMinorUnits) {
        await this.client.query("COMMIT");
        return Object.freeze({ state: "budget_exceeded" });
      }
      const inserted = await this.client.query(MODEL_ATTEMPT_INSERT_SQL, [
        ...modelAttemptIdentityParams(input), input.usageCeiling.inputTokens,
        input.usageCeiling.outputTokens, input.usageCeiling.costMinorUnits, input.now,
      ]);
      if (inserted.rowCount !== 1) fail("HISTORY_REBUILD_CONCURRENT_DRIFT");
      await this.client.query("COMMIT");
      return Object.freeze({ state: "reserved" });
    } catch (error) {
      await rollback(this.client);
      if (error instanceof HistoryRebuildRepositoryError) throw error;
      return fail("HISTORY_REBUILD_DATABASE_FAILED");
    }
  }

  async completeModelAttempt(input: CompleteHistoryRebuildModelAttemptInput): Promise<void> {
    if (!validAttemptIdentity(input) || !plainRecord(input.result) || input.result.version !== 1 ||
        !plainRecord(input.result.output) || typeof input.result.outputHash !== "string" ||
        !SHA256.test(input.result.outputHash) ||
        input.result.outputHash !== canonicalOutputHash(input.result.output) ||
        !validAttemptUsage(input.result.usage, 1) ||
        !Number.isSafeInteger(input.now) || input.now < 0) {
      fail("HISTORY_REBUILD_INVALID_INPUT");
    }
    try {
      await this.client.query("BEGIN");
      const updated = await this.client.query(MODEL_ATTEMPT_COMPLETE_SQL, [
        ...modelAttemptIdentityParams(input), canonicalJson(input.result.output),
        input.result.outputHash, input.result.usage.inputTokens,
        input.result.usage.outputTokens, input.result.usage.costMinorUnits, input.now,
      ]);
      if (updated.rowCount !== 1) fail("HISTORY_REBUILD_CONCURRENT_DRIFT");
      await this.client.query("COMMIT");
    } catch (error) {
      await rollback(this.client);
      if (error instanceof HistoryRebuildRepositoryError) throw error;
      fail("HISTORY_REBUILD_DATABASE_FAILED");
    }
  }

  async readModelUsage(
    input: ReadHistoryRebuildModelUsageInput,
  ): Promise<HistoryRebuildPersistedModelUsage> {
    if (!plainRecord(input) || !SAFE_ID.test(input.migrationId) ||
        ![input.manifestHash, input.modelFingerprint, input.promptHash, input.schemaHash]
          .every((value) => typeof value === "string" && SHA256.test(value))) {
      fail("HISTORY_REBUILD_INVALID_INPUT");
    }
    try {
      const result = await this.client.query(MODEL_USAGE_SQL, [
        input.migrationId, input.manifestHash, input.modelFingerprint,
        input.promptHash, input.schemaHash,
      ]);
      const row = oneResultRow(result);
      const modelCalls = integer(row.model_calls);
      const inputTokens = integer(row.input_tokens);
      const outputTokens = integer(row.output_tokens);
      const costMinorUnits = integer(row.cost_minor_units);
      const bindingDriftCount = integer(row.binding_drift_count);
      if (modelCalls === null || inputTokens === null || outputTokens === null ||
          costMinorUnits === null ||
          bindingDriftCount !== 0) {
        fail("HISTORY_REBUILD_INVALID_DB_RESULT");
      }
      return Object.freeze({ modelCalls, inputTokens, outputTokens, costMinorUnits });
    } catch (error) {
      if (error instanceof HistoryRebuildRepositoryError) throw error;
      return fail("HISTORY_REBUILD_DATABASE_FAILED");
    }
  }

  async commitBatch(input: HistoryRebuildBatchCommit): Promise<HistoryRebuildCheckpoint> {
    const scopeFingerprint = validateBatch(input);
    try {
      await this.client.query("BEGIN");
      const locked = await this.client.query(CHECKPOINT_LOCK_SQL, [
        input.runId, input.sourceTable, scopeFingerprint,
      ]);
      if (!Array.isArray(locked.rows) || locked.rows.length !== 1 || locked.rowCount !== 1 ||
          !plainRecord(locked.rows[0])) fail("HISTORY_REBUILD_CONCURRENT_DRIFT");
      const checkpointVersion = integer(locked.rows[0].checkpoint_version);
      const afterId = locked.rows[0].after_id;
      if (checkpointVersion !== input.expectedCheckpointVersion ||
          afterId !== input.expectedAfterId || locked.rows[0].state !== "running") {
        fail("HISTORY_REBUILD_CONCURRENT_DRIFT");
      }
      const sourceRowsJson = canonicalJson(input.sourceRows.map((row) => ({
        record_id: row.recordId,
        source_hash: row.sourceHash,
        source_row: row,
        original_text: row.text,
        original_metadata: row.metadata,
        original_metadata_hash: hash(
          "mengshu.history-rebuild-original-metadata/v1",
          row.metadata,
        ),
        original_lifecycle_status: row.lifecycleStatus ?? null,
      })));
      const insertedSources = await this.client.query(SOURCE_ROW_SNAPSHOT_SQL, [
        input.runId, input.sourceTable, sourceRowsJson, input.now,
      ]);
      if (insertedSources.rowCount !== input.sourceRows.length) {
        fail("HISTORY_REBUILD_CONCURRENT_DRIFT");
      }
      const plansJson = canonicalJson(input.plans.map((plan) => ({
        record_id: plan.recordId,
        source_hash: plan.sourceHash,
        disposition: plan.disposition,
        semantic_type: plan.semanticType ?? null,
        topic_labels: plan.topicLabels,
        context_eligible: plan.contextEligible,
        tree_eligibility: plan.treeEligibility,
        reason: plan.reason,
        plan_receipt_hash: plan.receiptHash,
      })));
      const insertedPlans = await this.client.query(SHADOW_PLAN_SQL, [
        input.runId, input.sourceTable, plansJson, input.now,
      ]);
      if (insertedPlans.rowCount !== input.plans.length) {
        fail("HISTORY_REBUILD_CONCURRENT_DRIFT");
      }
      for (const receipt of input.modelReceipts) {
        const inserted = await this.client.query(MODEL_RECEIPT_SQL, [
          receipt.receiptHash, input.runId, input.sourceTable, receipt.recordId,
          receipt.sourceHash, receipt.modelFingerprint, receipt.promptHash,
          receipt.schemaHash, receipt.inputHash, receipt.outputHash, receipt.confidence,
          receipt.proposalCount, receipt.inputTokens, receipt.outputTokens,
          receipt.planReceiptHash, input.now,
        ]);
        if (inserted.rowCount !== 1) fail("HISTORY_REBUILD_CONCURRENT_DRIFT");
      }
      const resultHash = hash("mengshu.history-rebuild-operation/v1", {
        runId: input.runId, sourceTable: input.sourceTable,
        operation: input.operationReceipt.operation, status: input.operationReceipt.status,
        counts: input.operationReceipt.counts,
      });
      const operation = await this.client.query(OPERATION_RECEIPT_SQL, [
        input.operationReceipt.receiptHash, input.runId, input.sourceTable,
        input.operationReceipt.operation, input.operationReceipt.status,
        JSON.stringify(input.operationReceipt.counts), resultHash,
        input.operationReceipt.driftHash ?? null, input.now,
      ]);
      if (operation.rowCount !== 1) fail("HISTORY_REBUILD_CONCURRENT_DRIFT");
      const state = input.complete === true ? "completed" as const : "running" as const;
      const advanced = await this.client.query(CHECKPOINT_CAS_SQL, [
        input.runId, input.sourceTable, input.nextAfterId, JSON.stringify(input.counts),
        state, input.now, input.expectedCheckpointVersion, input.expectedAfterId,
      ]);
      if (advanced.rowCount !== 1) fail("HISTORY_REBUILD_CONCURRENT_DRIFT");
      await this.client.query("COMMIT");
      return Object.freeze({
        afterId: input.nextAfterId,
        checkpointVersion: input.expectedCheckpointVersion + 1,
        state,
      });
    } catch (error) {
      await rollback(this.client);
      if (error instanceof HistoryRebuildRepositoryError) throw error;
      return fail("HISTORY_REBUILD_DATABASE_FAILED");
    }
  }

  async applyRun(input: ExecuteHistoryRebuildRunInput): Promise<AppliedHistoryRebuildRun> {
    const binding = executeRunBinding(input);
    const treePolicy = executionTreePolicy(input.treePolicy, input.scope);
    const policyHash = historyRebuildTreeRoutingPolicyHash(treePolicy);
    try {
      await this.client.query("BEGIN");
      await this.assertRunState(input.runId, binding.scopeFingerprint, "running", policyHash);
      const frozen = await this.client.query(FROZEN_MATERIAL_SQL, [
        input.runId, binding.scopeFingerprint,
      ]);
      const materials = frozenMaterialRows(frozen, input.runId, treePolicy);
      const result = await this.client.query(APPLY_RUN_SQL, [
        ...binding.params, materialJson(materials), binding.scopeKey,
      ]);
      const row = oneResultRow(result);
      const active = requiredResultCount(row.active_count);
      const lookupOnly = requiredResultCount(row.lookup_only_count);
      const classifiedInactive = requiredResultCount(row.classified_inactive_count);
      const evidenceMirrors = requiredResultCount(row.evidence_mirror_count);
      const evidenceLinks = requiredResultCount(row.evidence_link_count);
      const treeJobs = requiredResultCount(row.tree_job_count);
      const expectedEvidenceMirrors = requiredResultCount(row.expected_evidence_mirror_count);
      const expectedEvidenceLinks = requiredResultCount(row.expected_evidence_link_count);
      const expectedTreeJobs = requiredResultCount(row.expected_tree_job_count);
      if (requiredResultCount(row.drift_count) !== 0 ||
          evidenceMirrors !== expectedEvidenceMirrors || evidenceLinks !== expectedEvidenceLinks ||
          treeJobs !== expectedTreeJobs) fail("HISTORY_REBUILD_CONCURRENT_DRIFT");
      await this.client.query("COMMIT");
      return Object.freeze({
        active,
        lookupOnly,
        classifiedInactive,
        evidenceMirrors,
        evidenceLinks,
        treeJobs,
      });
    } catch (error) {
      await rollback(this.client);
      if (error instanceof HistoryRebuildRepositoryError) throw error;
      return fail("HISTORY_REBUILD_DATABASE_FAILED");
    }
  }

  async verifyRun(input: VerifyHistoryRebuildRunInput): Promise<VerifiedHistoryRebuildRun> {
    if (!plainRecord(input) || !SAFE_ID.test(input.runId)) fail("HISTORY_REBUILD_INVALID_INPUT");
    exactScope(input.scope);
    const scopeFingerprint = authorityScopeFingerprint(input.scope);
    const treePolicy = executionTreePolicy(input.treePolicy, input.scope);
    const policyHash = historyRebuildTreeRoutingPolicyHash(treePolicy);
    try {
      await this.assertRunStateReadOnly(input.runId, scopeFingerprint, "completed", policyHash);
      const frozen = await this.client.query(FROZEN_MATERIAL_SQL, [input.runId, scopeFingerprint]);
      const materials = frozenMaterialRows(frozen, input.runId, treePolicy);
      const result = await this.client.query(VERIFY_RUN_SQL, [
        input.runId, scopeFingerprint, ...scopeParams(input.scope), 0, materialJson(materials),
        scopeToKey(input.scope),
      ]);
      const row = oneResultRow(result);
      const runCount = requiredResultCount(row.run_count);
      const totalSourceCount = requiredResultCount(row.total_source_count);
      const memorySourceCount = requiredResultCount(row.memory_source_count);
      const knowledgeSourceCount = requiredResultCount(row.knowledge_source_count);
      const totalPlanCount = requiredResultCount(row.total_plan_count);
      const memoryPlanCount = requiredResultCount(row.memory_plan_count);
      const knowledgePlanCount = requiredResultCount(row.knowledge_plan_count);
      const appliedMemoryCount = requiredResultCount(row.applied_memory_count);
      const unchangedKnowledgeCount = requiredResultCount(row.unchanged_knowledge_count);
      const evidenceMirrors = requiredResultCount(row.evidence_mirror_count);
      const evidenceLinks = requiredResultCount(row.evidence_link_count);
      const treeJobs = requiredResultCount(row.tree_job_count);
      const queuedTreeJobs = requiredResultCount(row.queued_tree_job_count);
      const completedTreeJobs = requiredResultCount(row.completed_tree_job_count);
      const deadLetterTreeJobs = requiredResultCount(row.dead_letter_tree_job_count);
      if (runCount !== 1 || requiredResultCount(row.drift_count) !== 0 ||
          totalSourceCount !== totalPlanCount || memorySourceCount !== memoryPlanCount ||
          knowledgeSourceCount !== knowledgePlanCount ||
          knowledgeSourceCount !== unchangedKnowledgeCount ||
          appliedMemoryCount !== materials.length) fail("HISTORY_REBUILD_CONCURRENT_DRIFT");
      return Object.freeze({
        totalSourceCount,
        memorySourceCount,
        knowledgeSourceCount,
        totalPlanCount,
        memoryPlanCount,
        knowledgePlanCount,
        appliedMemoryCount,
        unchangedKnowledgeCount,
        evidenceMirrors,
        evidenceLinks,
        treeJobs,
        queuedTreeJobs,
        completedTreeJobs,
        deadLetterTreeJobs,
      });
    } catch (error) {
      if (error instanceof HistoryRebuildRepositoryError) throw error;
      return fail("HISTORY_REBUILD_DATABASE_FAILED");
    }
  }

  async rollbackRun(input: ExecuteHistoryRebuildRunInput): Promise<RolledBackHistoryRebuildRun> {
    const binding = executeRunBinding(input);
    const treePolicy = input.treePolicy === undefined
      ? undefined
      : executionTreePolicy(input.treePolicy, input.scope);
    const policyHash = treePolicy === undefined
      ? undefined
      : historyRebuildTreeRoutingPolicyHash(treePolicy);
    try {
      await this.client.query("BEGIN");
      await this.assertRunState(input.runId, binding.scopeFingerprint, "completed", policyHash);
      const frozen = await this.client.query(FROZEN_MATERIAL_SQL, [
        input.runId, binding.scopeFingerprint,
      ]);
      const materials = frozenMaterialRows(
        frozen,
        input.runId,
        treePolicy,
        treePolicy === undefined,
      );
      const serialized = materialJson(materials);
      const preflight = oneResultRow(await this.client.query(ROLLBACK_PREFLIGHT_SQL, [
        input.runId, binding.scopeFingerprint, serialized, ...scopeParams(input.scope),
      ]));
      if (requiredResultCount(preflight.started_job_count) !== 0) {
        fail("HISTORY_REBUILD_CONCURRENT_DRIFT");
      }
      const expectedTreeJobs = requiredResultCount(preflight.tree_job_count);
      const expectedEvidenceLinks = requiredResultCount(preflight.evidence_link_count);
      const expectedEvidenceMirrors = requiredResultCount(preflight.evidence_mirror_count);
      const row = oneResultRow(await this.client.query(ROLLBACK_RUN_SQL, [
        ...binding.params, serialized,
      ]));
      const restored = requiredResultCount(row.restored_count);
      const removedTreeJobs = requiredResultCount(row.removed_job_count);
      const removedEvidenceLinks = requiredResultCount(row.removed_link_count);
      const removedEvidenceMirrors = requiredResultCount(row.removed_evidence_mirror_count);
      const removedArtifacts = requiredResultCount(row.removed_artifact_count);
      if (requiredResultCount(row.drift_count) !== 0 || removedTreeJobs !== expectedTreeJobs ||
          removedEvidenceLinks !== expectedEvidenceLinks ||
          removedEvidenceMirrors !== expectedEvidenceMirrors ||
          removedArtifacts !== expectedTreeJobs + expectedEvidenceLinks + expectedEvidenceMirrors) {
        fail("HISTORY_REBUILD_CONCURRENT_DRIFT");
      }
      await this.client.query("COMMIT");
      return Object.freeze({ restored, removedEvidenceMirrors, removedTreeJobs });
    } catch (error) {
      await rollback(this.client);
      if (error instanceof HistoryRebuildRepositoryError) throw error;
      return fail("HISTORY_REBUILD_DATABASE_FAILED");
    }
  }

  private async assertRunState(
    runId: string,
    scopeFingerprint: string,
    expectedState: "running" | "completed",
    expectedPolicyHash?: string,
  ): Promise<void> {
    const result = await this.client.query(RUN_LOCK_SQL, [runId, scopeFingerprint]);
    if (!Array.isArray(result.rows) || result.rows.length !== 1 || result.rowCount !== 1 ||
        !plainRecord(result.rows[0]) || result.rows[0].state !== expectedState ||
        (expectedPolicyHash !== undefined && result.rows[0].policy_hash !== expectedPolicyHash)) {
      fail("HISTORY_REBUILD_CONCURRENT_DRIFT");
    }
  }

  private async assertRunStateReadOnly(
    runId: string,
    scopeFingerprint: string,
    expectedState: "running" | "completed",
    expectedPolicyHash: string,
  ): Promise<void> {
    const result = await this.client.query(RUN_STATE_SQL, [runId, scopeFingerprint]);
    if (!Array.isArray(result.rows) || result.rows.length !== 1 || result.rowCount !== 1 ||
        !plainRecord(result.rows[0]) || result.rows[0].state !== expectedState ||
        result.rows[0].policy_hash !== expectedPolicyHash) {
      fail("HISTORY_REBUILD_CONCURRENT_DRIFT");
    }
  }
}
