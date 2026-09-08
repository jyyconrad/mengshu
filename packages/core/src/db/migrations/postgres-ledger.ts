import {
  CURRENT_SCHEMA_VERSION,
  DURABLE_JOB_STATE_CONSTRAINT_NAME,
  SCHEMA_MIGRATIONS,
  planSchemaMigrations,
  type AppliedSchemaMigration,
  type SchemaMigration,
  type SchemaMigrationPlan,
} from "./schema-migrations.js";

export interface PostgresQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  readonly rows: Row[];
  readonly rowCount?: number | null;
}

export interface PostgresMigrationClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresQueryResult<Row>>;
}

export interface ExecutePostgresMigrationsOptions {
  readonly migrations?: readonly SchemaMigration[];
  readonly currentSchemaVersion?: number;
  /**
   * Contract migration 只能由显式 maintenance 入口执行。普通 runtime initialize
   * 必须保持 expand-only，避免旧 embedded binary 混跑时偷偷切换唯一键语义。
   */
  readonly contractMigration?: {
    readonly mode: "apply";
    readonly maintenance: true;
    readonly quiescenceConfirmed: true;
  };
}

export interface ExecutePostgresMigrationsResult {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly appliedVersions: readonly number[];
  readonly pendingContractVersions: readonly number[];
  readonly plan: SchemaMigrationPlan;
}

export type PostgresSchemaContractErrorCode =
  | "SCHEMA_MAINTENANCE_REQUIRED"
  | "SCHEMA_CONTRACT_PENDING"
  | "SCHEMA_CONTRACT_INVALID";

export class PostgresSchemaContractError extends Error {
  constructor(
    readonly code: PostgresSchemaContractErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PostgresSchemaContractError";
  }
}

export const CREATE_MIGRATION_LEDGER_SQL = `CREATE TABLE IF NOT EXISTS mengshu_schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;

export const READ_MIGRATIONS_SQL =
  "SELECT version, name, checksum FROM mengshu_schema_migrations ORDER BY version ASC";

export const LOCK_MIGRATIONS_SQL =
  "SELECT pg_advisory_xact_lock(hashtext('mengshu_schema_migrations'))";

/**
 * 同时读取 constraint backing index 与普通 unique index。返回全部 unique index，
 * 使验证器既能确认 v6 精确结构，也能发现旧 binary 重新创建的全局 content_hash。
 */
export const AUTHORITY_DEDUPE_INDEX_CATALOG_SQL = `SELECT
  table_rel.relname AS table_name,
  index_rel.relname AS index_name,
  index_meta.indisunique AS is_unique,
  index_meta.indisvalid AS is_valid,
  index_meta.indisready AS is_ready,
  pg_get_expr(index_meta.indpred, index_meta.indrelid) AS predicate,
  ARRAY(
    SELECT pg_get_indexdef(index_meta.indexrelid, ordinal.position, TRUE)
    FROM generate_series(1, index_meta.indnkeyatts) AS ordinal(position)
    ORDER BY ordinal.position
  ) AS index_columns
FROM pg_class AS table_rel
JOIN pg_namespace AS table_ns ON table_ns.oid = table_rel.relnamespace
JOIN pg_index AS index_meta ON index_meta.indrelid = table_rel.oid
JOIN pg_class AS index_rel ON index_rel.oid = index_meta.indexrelid
WHERE table_ns.nspname = current_schema()
  AND table_rel.relname = ANY($1::text[])
  AND index_meta.indisunique = TRUE
ORDER BY table_rel.relname, index_rel.relname`;

export const INSERT_MIGRATION_SQL =
  "INSERT INTO mengshu_schema_migrations (version, name, checksum) VALUES ($1, $2, $3)";

export const DURABLE_DOMAIN_SCHEMA_CATALOG_SQL = `SELECT
  'column'::text AS kind,
  table_name,
  column_name AS object_name,
  (CASE WHEN data_type = 'USER-DEFINED' THEN udt_name ELSE data_type END)::text AS definition,
  column_default AS default_definition,
  is_nullable,
  TRUE AS is_valid,
  TRUE AS is_ready
FROM information_schema.columns
WHERE table_schema = current_schema() AND table_name = ANY($1::text[])
UNION ALL
SELECT
  'constraint'::text AS kind,
  table_rel.relname AS table_name,
  constraint_meta.conname AS object_name,
  pg_get_constraintdef(constraint_meta.oid, TRUE) AS definition,
  NULL::text AS default_definition,
  NULL::text AS is_nullable,
  constraint_meta.convalidated AS is_valid,
  TRUE AS is_ready
FROM pg_constraint AS constraint_meta
JOIN pg_class AS table_rel ON table_rel.oid = constraint_meta.conrelid
JOIN pg_namespace AS table_ns ON table_ns.oid = table_rel.relnamespace
WHERE table_ns.nspname = current_schema() AND table_rel.relname = ANY($1::text[])
UNION ALL
SELECT
  'index'::text AS kind,
  table_rel.relname AS table_name,
  index_rel.relname AS object_name,
  pg_get_indexdef(index_meta.indexrelid) AS definition,
  NULL::text AS default_definition,
  NULL::text AS is_nullable,
  index_meta.indisvalid AS is_valid,
  index_meta.indisready AS is_ready
FROM pg_index AS index_meta
JOIN pg_class AS table_rel ON table_rel.oid = index_meta.indrelid
JOIN pg_class AS index_rel ON index_rel.oid = index_meta.indexrelid
JOIN pg_namespace AS table_ns ON table_ns.oid = table_rel.relnamespace
WHERE table_ns.nspname = current_schema() AND table_rel.relname = ANY($1::text[])
ORDER BY kind, table_name, object_name`;

export const DURABLE_JOB_STATE_SCHEMA_CATALOG_SQL = `SELECT
  constraint_meta.conname AS constraint_name,
  pg_get_constraintdef(constraint_meta.oid, TRUE) AS definition,
  constraint_meta.convalidated AS is_valid
FROM pg_constraint AS constraint_meta
JOIN pg_class AS table_rel ON table_rel.oid = constraint_meta.conrelid
JOIN pg_namespace AS table_ns ON table_ns.oid = table_rel.relnamespace
WHERE table_ns.nspname = current_schema()
  AND table_rel.relname = 'mengshu_jobs_v2'
  AND constraint_meta.contype = 'c'
ORDER BY constraint_meta.conname`;

export const DURABLE_DOMAIN_REQUIRED_COLUMNS = Object.freeze({
  mengshu_tree_leaves: Object.freeze([
    "id", "scope_fingerprint", "tenant_id", "user_id", "app_id", "project_id",
    "agent_id", "namespace", "visibility", "workspace_id", "session_id", "source_job_id",
    "chunk_id", "source_id", "entity_ids", "importance", "event_at", "created_at", "text",
    "token_count",
  ]),
  mengshu_tree_buffers: Object.freeze([
    "id", "scope_fingerprint", "tenant_id", "user_id", "app_id", "project_id",
    "agent_id", "namespace", "visibility", "workspace_id", "session_id", "tree_type",
    "tree_key", "level", "leaf_ids", "child_node_ids", "token_count", "opened_at",
    "updated_at", "seal_after_at",
  ]),
  mengshu_tree_summary_nodes: Object.freeze([
    "id", "scope_fingerprint", "tenant_id", "user_id", "app_id", "project_id",
    "agent_id", "namespace", "visibility", "workspace_id", "session_id", "sealed_by_job_id",
    "tree_type", "tree_key", "level", "title", "summary", "child_node_ids", "leaf_ids",
    "evidence_chunk_ids", "entity_ids", "relation_ids", "token_count", "start_at", "end_at",
    "status", "created_at", "sealed_at", "metadata",
  ]),
  mengshu_graph_entities: Object.freeze([
    "id", "scope_fingerprint", "tenant_id", "user_id", "app_id", "project_id",
    "agent_id", "namespace", "visibility", "workspace_id", "session_id", "canonical_name",
    "display_name", "entity_type", "aliases", "mention_count", "mention_count_30d",
    "distinct_source_count", "last_seen_at", "hotness", "graph_centrality", "query_hits_30d",
    "status", "merged_into", "created_at", "updated_at", "metadata",
  ]),
  mengshu_graph_relations: Object.freeze([
    "id", "scope_fingerprint", "tenant_id", "user_id", "app_id", "project_id",
    "agent_id", "namespace", "visibility", "workspace_id", "session_id", "subject_id",
    "predicate", "object_id", "confidence", "evidence_chunk_ids", "evidence_count",
    "first_seen_at", "last_seen_at", "status", "source_kinds", "metadata",
  ]),
} as const);

export const WRITE_JOURNAL_REQUIRED_COLUMNS = Object.freeze({
  mengshu_write_receipts: Object.freeze([
    "storage_key", "tenant_id", "user_id", "request_fingerprint", "result", "created_at",
  ]),
  mengshu_write_audit: Object.freeze([
    "audit_id", "storage_key", "memory_id", "action", "tenant_id", "user_id",
    "canonical_project_id", "product_id", "producer_id", "namespace", "visibility",
    "workspace_id", "session_id", "occurred_at",
  ]),
  mengshu_write_outbox: Object.freeze([
    "event_id", "storage_key", "topic", "memory_id", "tenant_id", "user_id",
    "canonical_project_id", "product_id", "producer_id", "namespace", "visibility",
    "workspace_id", "session_id", "occurred_at", "published_at",
  ]),
} as const);

export const EMBEDDING_REEMBED_REQUIRED_COLUMNS = Object.freeze({
  mengshu_embedding_spaces: Object.freeze([
    "embedding_space_id", "provider", "base_url", "model", "dimensions", "normalization",
    "state", "created_at", "queryability_state",
  ]),
  mengshu_embedding_reembed_shadow: Object.freeze([
    "migration_id", "table_name", "record_id", "source_content_hash", "old_vector",
    "old_embedding_space_id", "old_embedding_space_state", "old_metadata", "captured_at",
  ]),
  mengshu_embedding_reembed_receipts: Object.freeze([
    "receipt_id", "migration_id", "table_name", "record_id", "operation",
    "target_embedding_space_id", "target_vector_sha256", "source_snapshot_sha256", "created_at",
  ]),
} as const);

export const WORK_MEMORY_GRAPH_REQUIRED_COLUMNS = Object.freeze({
  mengshu_work_memory_nodes: Object.freeze([
    "id", "scope_fingerprint", "tenant_id", "user_id", "app_id", "project_id",
    "agent_id", "namespace", "visibility", "workspace_id", "session_id", "node_type",
    "record_id", "label", "evidence_kind", "semantic_type", "lifecycle_status", "tree_type",
    "level", "skill_candidate_status", "evidence_memory_ids", "evidence_chunk_ids", "metadata",
    "created_at", "updated_at",
  ]),
  mengshu_work_memory_edges: Object.freeze([
    "id", "scope_fingerprint", "tenant_id", "user_id", "app_id", "project_id",
    "agent_id", "namespace", "visibility", "workspace_id", "session_id", "edge_type",
    "predicate", "source_id", "target_id", "confidence", "evidence_chunk_ids", "reason",
    "metadata", "created_at", "updated_at",
  ]),
} as const);

export const CANDIDATE_WRITE_JOURNAL_REQUIRED_COLUMNS = Object.freeze({
  mengshu_candidate_write_receipts: Object.freeze([
    "storage_key", "request_fingerprint", "candidate_id", "tenant_id", "user_id", "app_id",
    "project_id", "agent_id", "namespace", "visibility", "workspace_id", "session_id",
    "route", "result", "created_at",
  ]),
  mengshu_candidate_write_audit: Object.freeze([
    "audit_id", "storage_key", "request_fingerprint", "candidate_id", "action", "tenant_id",
    "user_id", "app_id", "project_id", "agent_id", "namespace", "visibility", "workspace_id",
    "session_id", "route", "occurred_at",
  ]),
  mengshu_candidate_write_outbox: Object.freeze([
    "event_id", "storage_key", "request_fingerprint", "candidate_id", "topic", "tenant_id",
    "user_id", "app_id", "project_id", "agent_id", "namespace", "visibility", "workspace_id",
    "session_id", "route", "occurred_at", "published_at",
  ]),
} as const);

export const EVIDENCE_LINK_LEDGER_REQUIRED_COLUMNS = Object.freeze({
  mengshu_memory_evidence_links: Object.freeze([
    "link_id", "scope_fingerprint", "tenant_id", "user_id", "app_id", "project_id",
    "agent_id", "namespace", "visibility", "workspace_id", "session_id", "target_memory_id",
    "evidence_memory_id", "link_kind", "source", "created_at",
  ]),
  mengshu_graph_entity_evidence: Object.freeze([
    "link_id", "scope_fingerprint", "tenant_id", "user_id", "app_id", "project_id",
    "agent_id", "namespace", "visibility", "workspace_id", "session_id", "entity_id",
    "evidence_memory_id", "source_id", "source_kind", "created_at",
  ]),
  mengshu_graph_relation_evidence: Object.freeze([
    "link_id", "scope_fingerprint", "tenant_id", "user_id", "app_id", "project_id",
    "agent_id", "namespace", "visibility", "workspace_id", "session_id", "relation_id",
    "evidence_memory_id", "source_id", "source_kind", "created_at",
  ]),
  mengshu_graph_entity_aliases: Object.freeze([
    "alias_id", "scope_fingerprint", "tenant_id", "user_id", "app_id", "project_id",
    "agent_id", "namespace", "visibility", "workspace_id", "session_id", "entity_id",
    "alias", "normalized_alias", "evidence_memory_id", "source_id", "created_at",
  ]),
} as const);

export const TOPIC_TREE_ALIAS_REQUIRED_COLUMNS = Object.freeze({
  mengshu_topic_tree_aliases: Object.freeze([
    "scope_fingerprint", "tenant_id", "user_id", "app_id", "project_id", "agent_id",
    "namespace", "visibility", "workspace_id", "session_id", "legacy_tree_key",
    "canonical_topic_label", "status", "merged_from", "sealed_node_id", "created_at",
    "updated_at", "superseded_at", "archived_at",
  ]),
} as const);

export const CANONICAL_ENTITY_RESOLUTION_REQUIRED_COLUMNS = Object.freeze({
  mengshu_graph_entity_alias_bindings: Object.freeze([
    "alias_binding_id", "scope_fingerprint", "tenant_id", "user_id", "app_id",
    "project_id", "agent_id", "namespace", "visibility", "workspace_id", "session_id",
    "entity_type", "normalized_alias", "canonical_entity_id", "status",
    "created_at", "updated_at", "retired_at",
  ]),
  mengshu_graph_entity_resolution_ledger: Object.freeze([
    "resolution_id", "scope_fingerprint", "tenant_id", "user_id", "app_id", "project_id",
    "agent_id", "namespace", "visibility", "workspace_id", "session_id", "job_id",
    "evidence_memory_id", "raw_entity_id", "canonical_entity_id", "entity_type", "method", "similarity",
    "can_rollback", "raw_entity", "observed_aliases", "status", "created_at",
    "rolled_back_at",
  ]),
  mengshu_graph_relation_resolution_ledger: Object.freeze([
    "resolution_id", "scope_fingerprint", "tenant_id", "user_id", "app_id", "project_id",
    "agent_id", "namespace", "visibility", "workspace_id", "session_id", "job_id",
    "evidence_memory_id", "raw_relation_id", "canonical_relation_id",
    "canonical_subject_id", "canonical_object_id", "outcome", "raw_relation", "created_at",
  ]),
  mengshu_graph_entity_embeddings: Object.freeze([
    "scope_fingerprint", "tenant_id", "user_id", "app_id", "project_id", "agent_id",
    "namespace", "visibility", "workspace_id", "session_id", "entity_id", "entity_type",
    "embedding_space_id", "embedding_space_state", "vector", "updated_at",
  ]),
} as const);

export const ASSET_LOADOUT_OVERLAY_REQUIRED_COLUMNS = Object.freeze({
  mengshu_asset_versions: Object.freeze([
    "scope_fingerprint", "asset_id", "version", "kind", "status", "visibility",
    "owner_user_id", "descriptor", "created_at",
  ]),
  mengshu_asset_heads: Object.freeze([
    "scope_fingerprint", "asset_id", "latest_version", "changed_at",
  ]),
  mengshu_asset_promotion_receipts: Object.freeze([
    "receipt_id", "scope_fingerprint", "request_key", "request_hash", "asset_id",
    "asset_version", "receipt", "created_at",
  ]),
  mengshu_asset_audit: Object.freeze([
    "audit_id", "scope_fingerprint", "asset_id", "asset_version", "event_type",
    "receipt_id", "occurred_at",
  ]),
  mengshu_asset_outbox: Object.freeze([
    "event_id", "scope_fingerprint", "asset_id", "asset_version", "event_type",
    "payload", "occurred_at", "published_at",
  ]),
  mengshu_loadout_versions: Object.freeze([
    "scope_fingerprint", "loadout_id", "version", "app_id", "agent_id", "project_id",
    "visibility", "descriptor", "created_at",
  ]),
  mengshu_loadout_heads: Object.freeze([
    "scope_fingerprint", "loadout_id", "latest_version", "changed_at",
  ]),
  mengshu_loadout_receipts: Object.freeze([
    "scope_fingerprint", "request_key", "request_hash", "loadout_id", "loadout_version",
    "receipt", "created_at",
  ]),
} as const);

export const LOADOUT_EVENT_LEDGER_REQUIRED_COLUMNS = Object.freeze({
  mengshu_loadout_audit: Object.freeze([
    "audit_id", "scope_fingerprint", "loadout_id", "loadout_version", "event_type",
    "request_key", "occurred_at",
  ]),
  mengshu_loadout_outbox: Object.freeze([
    "event_id", "scope_fingerprint", "loadout_id", "loadout_version", "event_type",
    "payload", "occurred_at", "published_at",
  ]),
} as const);

export const CONTEXT_ASSEMBLY_RECEIPT_REQUIRED_COLUMNS = Object.freeze({
  mengshu_context_assembly_receipts: Object.freeze([
    "receipt_id", "scope_fingerprint", "session_id", "stable_content_hash",
    "dynamic_content_hash", "receipt", "created_at", "expires_at",
  ]),
} as const);

export const HISTORY_REBUILD_LEDGER_REQUIRED_COLUMNS = Object.freeze({
  mengshu_history_rebuild_runs: Object.freeze([
    "run_id", "migration_id", "scope_fingerprint", "tenant_id", "user_id", "app_id",
    "project_id", "agent_id", "namespace", "visibility", "workspace_id", "session_id",
    "manifest_hash", "model_fingerprint", "prompt_hash", "schema_hash", "policy_hash",
    "attempt_hash", "state", "created_at", "updated_at",
  ]),
  mengshu_history_rebuild_source_snapshots: Object.freeze([
    "run_id", "source_table", "source_upper_bound", "source_count", "snapshot_hash",
    "captured_at",
  ]),
  mengshu_history_rebuild_source_rows: Object.freeze([
    "run_id", "source_table", "record_id", "source_hash", "source_row", "original_text",
    "original_metadata", "original_metadata_hash", "original_lifecycle_status", "captured_at",
  ]),
  mengshu_history_rebuild_checkpoints: Object.freeze([
    "run_id", "source_table", "after_id", "checkpoint_version", "counts", "state",
    "updated_at",
  ]),
  mengshu_history_rebuild_shadow_plans: Object.freeze([
    "run_id", "source_table", "record_id", "source_hash", "disposition", "semantic_type",
    "topic_labels", "context_eligible", "tree_eligibility", "reason", "plan_receipt_hash",
    "created_at",
  ]),
  mengshu_history_rebuild_model_receipts: Object.freeze([
    "receipt_hash", "run_id", "source_table", "record_id", "source_hash",
    "model_fingerprint", "prompt_hash", "schema_hash", "input_hash", "output_hash",
    "confidence", "proposal_count", "input_tokens", "output_tokens", "created_at",
  ]),
  mengshu_history_rebuild_operation_receipts: Object.freeze([
    "receipt_hash", "run_id", "source_table", "operation", "status", "counts",
    "result_hash", "drift_hash", "created_at",
  ]),
  mengshu_history_rebuild_artifacts: Object.freeze([
    "run_id", "source_table", "record_id", "artifact_type", "artifact_id",
    "artifact_role", "source_hash", "created_at",
  ]),
} as const);

export const HISTORY_REBUILD_MODEL_ATTEMPT_REQUIRED_COLUMNS = Object.freeze({
  mengshu_history_rebuild_model_attempts: Object.freeze([
    "migration_id", "manifest_hash", "run_id", "source_table", "record_id",
    "source_hash", "attempt", "model_fingerprint", "prompt_hash", "schema_hash",
    "input_hash", "state", "reserved_input_tokens", "reserved_output_tokens",
    "reserved_cost_minor_units", "output", "output_hash", "actual_input_tokens",
    "actual_output_tokens", "actual_cost_minor_units", "reserved_at", "completed_at",
  ]),
} as const);

const DURABLE_DOMAIN_REQUIRED_CONSTRAINTS = Object.freeze({
  mengshu_tree_leaves: ["PRIMARY KEY (scope_fingerprint, id)", "FOREIGN KEY (source_job_id)"],
  mengshu_tree_buffers: [
    "PRIMARY KEY (scope_fingerprint, id)",
    "UNIQUE (scope_fingerprint, tree_type, tree_key, level)",
  ],
  mengshu_tree_summary_nodes: [
    "PRIMARY KEY (scope_fingerprint, id)",
    "FOREIGN KEY (sealed_by_job_id)",
  ],
  mengshu_graph_entities: [
    "PRIMARY KEY (scope_fingerprint, id)",
    "UNIQUE (scope_fingerprint, entity_type, canonical_name)",
    "FOREIGN KEY (scope_fingerprint, merged_into)",
  ],
  mengshu_graph_relations: [
    "PRIMARY KEY (scope_fingerprint, id)",
    "FOREIGN KEY (scope_fingerprint, subject_id)",
    "FOREIGN KEY (scope_fingerprint, object_id)",
    "evidence_count = jsonb_array_length(evidence_chunk_ids)",
  ],
} as const);

const DURABLE_DOMAIN_REQUIRED_INDEXES = Object.freeze([
  "mengshu_tree_leaves_scope_event_idx",
  "mengshu_tree_summary_scope_idx",
  "mengshu_graph_entities_scope_name_idx",
  "mengshu_graph_relations_scope_subject_idx",
  "mengshu_graph_relations_scope_object_idx",
] as const);

const WRITE_JOURNAL_REQUIRED_CONSTRAINTS = Object.freeze({
  mengshu_write_receipts: ["PRIMARY KEY (storage_key)"],
  mengshu_write_audit: [
    "UNIQUE (storage_key, memory_id, action)",
    "action = 'memory.store'",
  ],
  mengshu_write_outbox: [
    "PRIMARY KEY (event_id)",
    "UNIQUE (storage_key, topic, memory_id)",
    "topic = 'memory.written'",
  ],
} as const);

const WRITE_JOURNAL_REQUIRED_INDEXES = Object.freeze([
  "mengshu_write_audit_scope_memory_idx",
  "mengshu_write_outbox_pending_idx",
  "mengshu_write_receipts_created_idx",
] as const);

const WRITE_JOURNAL_COLUMN_TYPES = Object.freeze({
  mengshu_write_receipts: Object.freeze({
    storage_key: "text", tenant_id: "text", user_id: "text",
    request_fingerprint: "text", result: "jsonb", created_at: "timestamp with time zone",
  }),
  mengshu_write_audit: Object.freeze({
    audit_id: "bigint", storage_key: "text", memory_id: "text", action: "text",
    tenant_id: "text", user_id: "text", canonical_project_id: "text", product_id: "text",
    producer_id: "text", namespace: "text", visibility: "text", workspace_id: "text",
    session_id: "text", occurred_at: "timestamp with time zone",
  }),
  mengshu_write_outbox: Object.freeze({
    event_id: "text", storage_key: "text", topic: "text", memory_id: "text",
    tenant_id: "text", user_id: "text", canonical_project_id: "text", product_id: "text",
    producer_id: "text", namespace: "text", visibility: "text", workspace_id: "text",
    session_id: "text", occurred_at: "timestamp with time zone",
    published_at: "timestamp with time zone",
  }),
} as const);

interface CatalogColumnContract {
  readonly type: string;
  readonly nullable: boolean;
  readonly default: string | null;
}
interface EvolutionCatalogOptions { readonly evolutionGovernance?: boolean }
const EVOLUTION_OUTBOX_COLUMN_CONTRACT: Readonly<Record<string, CatalogColumnContract>> = {
  evolution_consumed_at: { type: "bigint", nullable: true, default: null },
  evolution_origin: { type: "boolean", nullable: false, default: "false" },
};
const EVOLUTION_MEMORY_COLUMN_CONTRACT: Readonly<Record<string, CatalogColumnContract>> = {
  evolution_review_due_at: { type: "bigint", nullable: false, default: "0" },
  evolution_disputed: { type: "boolean", nullable: false, default: "false" },
  evolution_alias_of: { type: "uuid", nullable: true, default: null },
};
const EVOLUTION_EVIDENCE_COLUMN_CONTRACT: Readonly<Record<string, CatalogColumnContract>> = {
  relation_state: { type: "text", nullable: false, default: "'effective'::text" },
  retired_at: { type: "bigint", nullable: true, default: null },
  ...Object.fromEntries([
    "root_evidence_id", "source_id", "source_revision", "source_current_revision", "source_hash",
    "source_kind", "source_record_id", "source_path_id", "source_span_id", "source_logical_file_id",
    "continuity_key", "independence_group_id",
  ].map(name => [name, { type: "text", nullable: true, default: null }])),
};
const TEMPORAL_OUTBOX_COLUMN_CONTRACT: Readonly<Record<string, CatalogColumnContract>> = Object.fromEntries(
  Object.entries({ event_id: "text", scope_fingerprint: "text", lineage_id: "text", revision: "integer",
    event_type: "text", payload: "jsonb", occurred_at: "bigint", published_at: "bigint" })
    .map(([name, type]) => [name, { type, nullable: name === "published_at", default: null }]),
);

/** Remove only the validated, ledger-selected expansion; base checks still reject unknown columns. */
function verifyCatalogColumnExtension(
  tableName: string,
  rows: readonly Record<string, unknown>[],
  contract: Readonly<Record<string, CatalogColumnContract>>,
): Record<string, unknown>[] {
  for (const [name, expected] of Object.entries(contract)) {
    const matches = rows.filter(row => row.object_name === name);
    const row = matches[0];
    if (matches.length !== 1 || !row || row.definition !== expected.type ||
        row.is_nullable !== (expected.nullable ? "YES" : "NO") || row.default_definition !== expected.default) {
      throw new PostgresSchemaContractError("SCHEMA_CONTRACT_INVALID",
        `Postgres versioned column is invalid: ${tableName}.${name}`);
    }
  }
  return rows.filter(row => !Object.hasOwn(contract, String(row.object_name)));
}

export async function verifyTemporalOutboxSchemaCatalog(
  client: PostgresMigrationClient,
  options: EvolutionCatalogOptions = {},
): Promise<void> {
  const tableName = "mengshu_memory_version_outbox";
  const result = await client.query(DURABLE_DOMAIN_SCHEMA_CATALOG_SQL, [[tableName]]);
  const columns = result.rows.filter(row => row.kind === "column" && row.table_name === tableName);
  const remaining = verifyCatalogColumnExtension(tableName, columns, {
    ...TEMPORAL_OUTBOX_COLUMN_CONTRACT,
    ...(options.evolutionGovernance ? EVOLUTION_OUTBOX_COLUMN_CONTRACT : {}),
  });
  if (remaining.length) throw new PostgresSchemaContractError("SCHEMA_CONTRACT_INVALID",
    "Postgres temporal outbox contains undeclared columns");
}

async function verifyEvolutionMemoryColumnsCatalog(client: PostgresMigrationClient): Promise<void> {
  const result = await client.query(DURABLE_DOMAIN_SCHEMA_CATALOG_SQL, [["memories"]]);
  const columns = result.rows.filter(row => row.kind === "column" && row.table_name === "memories");
  const remaining = verifyCatalogColumnExtension("memories", columns, EVOLUTION_MEMORY_COLUMN_CONTRACT);
  if (remaining.some(row => String(row.object_name).startsWith("evolution_"))) {
    throw new PostgresSchemaContractError("SCHEMA_CONTRACT_INVALID", "Postgres memories contains undeclared evolution columns");
  }
}

const EMBEDDING_REEMBED_NULLABLE_COLUMNS = Object.freeze({
  mengshu_embedding_spaces: Object.freeze(["queryability_state"]),
  mengshu_embedding_reembed_shadow: Object.freeze([
    "old_embedding_space_id", "old_embedding_space_state",
  ]),
  mengshu_embedding_reembed_receipts: Object.freeze([] as string[]),
} as const);

const EMBEDDING_REEMBED_COLUMN_TYPES = Object.freeze({
  mengshu_embedding_spaces: Object.freeze({
    embedding_space_id: "text", provider: "text", base_url: "text", model: "text",
    dimensions: "integer", normalization: "text", state: "text",
    created_at: "timestamp with time zone", queryability_state: "text",
  }),
  mengshu_embedding_reembed_shadow: Object.freeze({
    migration_id: "text", table_name: "text", record_id: "uuid", source_content_hash: "text",
    old_vector: "vector", old_embedding_space_id: "text", old_embedding_space_state: "text",
    old_metadata: "jsonb", captured_at: "timestamp with time zone",
  }),
  mengshu_embedding_reembed_receipts: Object.freeze({
    receipt_id: "text", migration_id: "text", table_name: "text", record_id: "uuid",
    operation: "text", target_embedding_space_id: "text", target_vector_sha256: "text",
    source_snapshot_sha256: "text", created_at: "timestamp with time zone",
  }),
} as const);

const EMBEDDING_REEMBED_REQUIRED_CONSTRAINTS = Object.freeze({
  mengshu_embedding_spaces: [
    "PRIMARY KEY (embedding_space_id)",
    "queryability_state IS NULL",
    "unknown-unqueryable",
  ],
  mengshu_embedding_reembed_shadow: [
    "PRIMARY KEY (migration_id, table_name, record_id)",
    "table_name = ANY",
    "jsonb_typeof(old_metadata) = 'object'",
  ],
  mengshu_embedding_reembed_receipts: [
    "PRIMARY KEY (receipt_id)",
    "UNIQUE (migration_id, table_name, record_id, operation)",
    "operation = ANY",
    "FOREIGN KEY (target_embedding_space_id)",
  ],
} as const);

const EMBEDDING_REEMBED_REQUIRED_INDEXES = Object.freeze([
  "mengshu_embedding_spaces_queryability_idx",
  "mengshu_embedding_reembed_shadow_record_idx",
  "mengshu_embedding_reembed_receipts_migration_idx",
] as const);

const WORK_MEMORY_GRAPH_NULLABLE_COLUMNS = Object.freeze({
  mengshu_work_memory_nodes: Object.freeze([
    "evidence_kind", "semantic_type", "lifecycle_status", "tree_type", "level",
    "skill_candidate_status", "updated_at",
  ]),
  mengshu_work_memory_edges: Object.freeze(["reason", "updated_at"]),
} as const);

const WORK_MEMORY_GRAPH_REQUIRED_CONSTRAINTS = Object.freeze({
  mengshu_work_memory_nodes: Object.freeze([
    "PRIMARY KEY (scope_fingerprint, id)",
    "UNIQUE (scope_fingerprint, node_type, record_id)",
    "node_type = ANY",
  ]),
  mengshu_work_memory_edges: Object.freeze([
    "PRIMARY KEY (scope_fingerprint, id)",
    "FOREIGN KEY (scope_fingerprint, source_id)",
    "FOREIGN KEY (scope_fingerprint, target_id)",
    "predicate = ANY",
  ]),
} as const);

const WORK_MEMORY_GRAPH_REQUIRED_INDEXES = Object.freeze([
  "mengshu_work_memory_nodes_scope_type_idx",
  "mengshu_work_memory_edges_scope_source_idx",
  "mengshu_work_memory_edges_scope_target_idx",
] as const);

const CANDIDATE_WRITE_JOURNAL_REQUIRED_CONSTRAINTS = Object.freeze({
  mengshu_candidate_write_receipts: Object.freeze([
    "PRIMARY KEY (storage_key)",
    "FOREIGN KEY (candidate_id)",
    "REFERENCES mengshu_candidates",
    "storage_key ~",
    "request_fingerprint ~",
    "visibility = ANY",
    "route = ANY",
    "candidate_low_priority",
    "jsonb_typeof(result) = 'object'",
  ]),
  mengshu_candidate_write_audit: Object.freeze([
    "PRIMARY KEY (audit_id)",
    "FOREIGN KEY (candidate_id)",
    "REFERENCES mengshu_candidates",
    "UNIQUE (storage_key, candidate_id, action)",
    "storage_key ~",
    "request_fingerprint ~",
    "action = 'candidate.store'",
    "visibility = ANY",
    "route = ANY",
    "candidate_low_priority",
  ]),
  mengshu_candidate_write_outbox: Object.freeze([
    "PRIMARY KEY (event_id)",
    "FOREIGN KEY (candidate_id)",
    "REFERENCES mengshu_candidates",
    "UNIQUE (storage_key, topic, candidate_id)",
    "event_id ~",
    "storage_key ~",
    "request_fingerprint ~",
    "topic = 'candidate.written'",
    "visibility = ANY",
    "route = ANY",
    "candidate_low_priority",
  ]),
} as const);

const CANDIDATE_WRITE_JOURNAL_REQUIRED_INDEXES = Object.freeze([
  "mengshu_candidate_write_audit_scope_candidate_idx",
  "mengshu_candidate_write_outbox_pending_idx",
  "mengshu_candidate_write_receipts_created_idx",
] as const);

const EVIDENCE_LINK_LEDGER_REQUIRED_CONSTRAINTS = Object.freeze({
  mengshu_memory_evidence_links: Object.freeze([
    "PRIMARY KEY (link_id)",
    "UNIQUE (scope_fingerprint, target_memory_id, evidence_memory_id, link_kind, source)",
    "link_kind = ANY",
  ]),
  mengshu_graph_entity_evidence: Object.freeze([
    "PRIMARY KEY (link_id)",
    "FOREIGN KEY (scope_fingerprint, entity_id)",
    "REFERENCES mengshu_graph_entities",
    "UNIQUE (scope_fingerprint, entity_id, evidence_memory_id, source_id, source_kind)",
  ]),
  mengshu_graph_relation_evidence: Object.freeze([
    "PRIMARY KEY (link_id)",
    "FOREIGN KEY (scope_fingerprint, relation_id)",
    "REFERENCES mengshu_graph_relations",
    "UNIQUE (scope_fingerprint, relation_id, evidence_memory_id, source_id, source_kind)",
  ]),
  mengshu_graph_entity_aliases: Object.freeze([
    "PRIMARY KEY (alias_id)",
    "FOREIGN KEY (scope_fingerprint, entity_id)",
    "REFERENCES mengshu_graph_entities",
    "UNIQUE (scope_fingerprint, entity_id, normalized_alias)",
  ]),
} as const);

const EVIDENCE_LINK_LEDGER_REQUIRED_INDEXES = Object.freeze([
  "mengshu_memory_evidence_links_scope_target_idx",
  "mengshu_graph_entity_evidence_scope_evidence_idx",
  "mengshu_graph_relation_evidence_scope_evidence_idx",
  "mengshu_graph_entity_aliases_scope_alias_idx",
] as const);

const TOPIC_TREE_ALIAS_REQUIRED_CONSTRAINTS = Object.freeze([
  "PRIMARY KEY (scope_fingerprint, legacy_tree_key)",
  "status = ANY",
  "jsonb_typeof(merged_from) = 'array'",
  "merged_from @> jsonb_build_array(legacy_tree_key)",
] as const);

const TOPIC_TREE_ALIAS_REQUIRED_INDEXES = Object.freeze([
  "mengshu_topic_tree_aliases_scope_canonical_idx",
  "mengshu_topic_tree_aliases_scope_status_idx",
] as const);

const CANONICAL_ENTITY_RESOLUTION_NULLABLE_COLUMNS = Object.freeze({
  mengshu_graph_entity_alias_bindings: Object.freeze(["retired_at"]),
  mengshu_graph_entity_resolution_ledger: Object.freeze(["similarity", "rolled_back_at"]),
  mengshu_graph_relation_resolution_ledger: Object.freeze(["canonical_relation_id"]),
  mengshu_graph_entity_embeddings: Object.freeze([] as string[]),
} as const);

const CANONICAL_ENTITY_RESOLUTION_COLUMN_TYPES = Object.freeze({
  mengshu_graph_entity_alias_bindings: Object.freeze({
    alias_binding_id: "text", scope_fingerprint: "text", tenant_id: "text", user_id: "text",
    app_id: "text", project_id: "text", agent_id: "text", namespace: "text",
    visibility: "text", workspace_id: "text", session_id: "text", entity_type: "text",
    normalized_alias: "text", canonical_entity_id: "text", status: "text",
    created_at: "bigint", updated_at: "bigint", retired_at: "bigint",
  }),
  mengshu_graph_entity_resolution_ledger: Object.freeze({
    resolution_id: "text", scope_fingerprint: "text", tenant_id: "text", user_id: "text",
    app_id: "text", project_id: "text", agent_id: "text", namespace: "text",
    visibility: "text", workspace_id: "text", session_id: "text", job_id: "text",
    evidence_memory_id: "text", raw_entity_id: "text", canonical_entity_id: "text",
    entity_type: "text", method: "text", similarity: "double precision", can_rollback: "boolean",
    raw_entity: "jsonb", observed_aliases: "jsonb", status: "text", created_at: "bigint",
    rolled_back_at: "bigint",
  }),
  mengshu_graph_relation_resolution_ledger: Object.freeze({
    resolution_id: "text", scope_fingerprint: "text", tenant_id: "text", user_id: "text",
    app_id: "text", project_id: "text", agent_id: "text", namespace: "text",
    visibility: "text", workspace_id: "text", session_id: "text", job_id: "text",
    evidence_memory_id: "text", raw_relation_id: "text", canonical_relation_id: "text",
    canonical_subject_id: "text", canonical_object_id: "text", outcome: "text",
    raw_relation: "jsonb", created_at: "bigint",
  }),
  mengshu_graph_entity_embeddings: Object.freeze({
    scope_fingerprint: "text", tenant_id: "text", user_id: "text", app_id: "text",
    project_id: "text", agent_id: "text", namespace: "text", visibility: "text",
    workspace_id: "text", session_id: "text", entity_id: "text", entity_type: "text",
    embedding_space_id: "text", embedding_space_state: "text", vector: "vector",
    updated_at: "bigint",
  }),
} as const);

const CANONICAL_ENTITY_RESOLUTION_REQUIRED_CONSTRAINTS = Object.freeze({
  mengshu_graph_entity_alias_bindings: Object.freeze([
    "PRIMARY KEY (alias_binding_id)",
    "FOREIGN KEY (scope_fingerprint, canonical_entity_id)",
    "REFERENCES mengshu_graph_entities",
    "status = ANY",
  ]),
  mengshu_graph_entity_resolution_ledger: Object.freeze([
    "PRIMARY KEY (resolution_id)",
    "FOREIGN KEY (job_id)",
    "REFERENCES mengshu_jobs_v2",
    "FOREIGN KEY (scope_fingerprint, canonical_entity_id)",
    "REFERENCES mengshu_graph_entities",
    "UNIQUE (scope_fingerprint, job_id, evidence_memory_id, raw_entity_id)",
    "method = ANY",
    "status = ANY",
    "jsonb_typeof(raw_entity) = 'object'",
    "jsonb_typeof(observed_aliases) = 'array'",
    "method = 'semantic'",
    "similarity IS NOT NULL",
    "can_rollback = true",
  ]),
  mengshu_graph_relation_resolution_ledger: Object.freeze([
    "PRIMARY KEY (resolution_id)",
    "FOREIGN KEY (job_id)",
    "REFERENCES mengshu_jobs_v2",
    "FOREIGN KEY (scope_fingerprint, canonical_relation_id)",
    "REFERENCES mengshu_graph_relations",
    "FOREIGN KEY (scope_fingerprint, canonical_subject_id)",
    "FOREIGN KEY (scope_fingerprint, canonical_object_id)",
    "REFERENCES mengshu_graph_entities",
    "UNIQUE (scope_fingerprint, job_id, evidence_memory_id, raw_relation_id)",
    "outcome = ANY",
    "jsonb_typeof(raw_relation) = 'object'",
    "outcome = 'dropped_self'",
    "canonical_relation_id IS NULL",
    "canonical_subject_id = canonical_object_id",
  ]),
  mengshu_graph_entity_embeddings: Object.freeze([
    "PRIMARY KEY (scope_fingerprint, entity_id, embedding_space_id)",
    "FOREIGN KEY (scope_fingerprint, entity_id)",
    "REFERENCES mengshu_graph_entities",
    "FOREIGN KEY (embedding_space_id)",
    "REFERENCES mengshu_embedding_spaces",
    "embedding_space_state = ANY",
  ]),
} as const);

const CANONICAL_ENTITY_RESOLUTION_REQUIRED_INDEXES = Object.freeze([
  "mengshu_graph_entity_alias_bindings_active_uidx",
  "mengshu_graph_entity_alias_bindings_entity_idx",
  "mengshu_graph_entity_resolution_scope_evidence_idx",
  "mengshu_graph_entity_resolution_rollback_idx",
  "mengshu_graph_relation_resolution_scope_evidence_idx",
  "mengshu_graph_entity_embeddings_queryable_idx",
] as const);

const ASSET_LOADOUT_OVERLAY_COLUMN_TYPES: Readonly<Record<string, Readonly<Record<string, string>>>> =
  Object.freeze({
    mengshu_asset_versions: Object.freeze({
      scope_fingerprint: "text", asset_id: "text", version: "integer", kind: "text",
      status: "text", visibility: "text", owner_user_id: "text", descriptor: "jsonb",
      created_at: "bigint",
    }),
    mengshu_asset_heads: Object.freeze({
      scope_fingerprint: "text", asset_id: "text", latest_version: "integer", changed_at: "bigint",
    }),
    mengshu_asset_promotion_receipts: Object.freeze({
      receipt_id: "text", scope_fingerprint: "text", request_key: "text", request_hash: "text",
      asset_id: "text", asset_version: "integer", receipt: "jsonb", created_at: "bigint",
    }),
    mengshu_asset_audit: Object.freeze({
      audit_id: "bigint", scope_fingerprint: "text", asset_id: "text", asset_version: "integer",
      event_type: "text", receipt_id: "text", occurred_at: "bigint",
    }),
    mengshu_asset_outbox: Object.freeze({
      event_id: "text", scope_fingerprint: "text", asset_id: "text", asset_version: "integer",
      event_type: "text", payload: "jsonb", occurred_at: "bigint", published_at: "bigint",
    }),
    mengshu_loadout_versions: Object.freeze({
      scope_fingerprint: "text", loadout_id: "text", version: "integer", app_id: "text",
      agent_id: "text", project_id: "text", visibility: "text", descriptor: "jsonb",
      created_at: "bigint",
    }),
    mengshu_loadout_heads: Object.freeze({
      scope_fingerprint: "text", loadout_id: "text", latest_version: "integer", changed_at: "bigint",
    }),
    mengshu_loadout_receipts: Object.freeze({
      scope_fingerprint: "text", request_key: "text", request_hash: "text", loadout_id: "text",
      loadout_version: "integer", receipt: "jsonb", created_at: "bigint",
    }),
  });

const LOADOUT_EVENT_LEDGER_COLUMN_TYPES: Readonly<Record<string, Readonly<Record<string, string>>>> =
  Object.freeze({
    mengshu_loadout_audit: Object.freeze({
      audit_id: "bigint", scope_fingerprint: "text", loadout_id: "text",
      loadout_version: "integer", event_type: "text", request_key: "text", occurred_at: "bigint",
    }),
    mengshu_loadout_outbox: Object.freeze({
      event_id: "text", scope_fingerprint: "text", loadout_id: "text",
      loadout_version: "integer", event_type: "text", payload: "jsonb",
      occurred_at: "bigint", published_at: "bigint",
    }),
  });

const CONTEXT_ASSEMBLY_RECEIPT_COLUMN_TYPES = Object.freeze({
  mengshu_context_assembly_receipts: Object.freeze({
    receipt_id: "text", scope_fingerprint: "text", session_id: "text",
    stable_content_hash: "text", dynamic_content_hash: "text", receipt: "jsonb",
    created_at: "bigint", expires_at: "bigint",
  }),
});

const HISTORY_REBUILD_LEDGER_COLUMN_TYPES: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = Object.freeze({
  mengshu_history_rebuild_runs: Object.freeze({
    run_id: "text", migration_id: "text", scope_fingerprint: "text", tenant_id: "text",
    user_id: "text", app_id: "text", project_id: "text", agent_id: "text",
    namespace: "text", visibility: "text", workspace_id: "text", session_id: "text",
    manifest_hash: "text", model_fingerprint: "text", prompt_hash: "text",
    schema_hash: "text", policy_hash: "text", attempt_hash: "text", state: "text",
    created_at: "bigint", updated_at: "bigint",
  }),
  mengshu_history_rebuild_source_snapshots: Object.freeze({
    run_id: "text", source_table: "text", source_upper_bound: "uuid",
    source_count: "bigint", snapshot_hash: "text", captured_at: "bigint",
  }),
  mengshu_history_rebuild_source_rows: Object.freeze({
    run_id: "text", source_table: "text", record_id: "uuid", source_hash: "text",
    source_row: "jsonb", original_text: "text", original_metadata: "jsonb",
    original_metadata_hash: "text", original_lifecycle_status: "text", captured_at: "bigint",
  }),
  mengshu_history_rebuild_checkpoints: Object.freeze({
    run_id: "text", source_table: "text", after_id: "uuid", checkpoint_version: "bigint",
    counts: "jsonb", state: "text", updated_at: "bigint",
  }),
  mengshu_history_rebuild_shadow_plans: Object.freeze({
    run_id: "text", source_table: "text", record_id: "uuid", source_hash: "text",
    disposition: "text", semantic_type: "text", topic_labels: "jsonb",
    context_eligible: "boolean", tree_eligibility: "jsonb", reason: "text",
    plan_receipt_hash: "text", created_at: "bigint",
  }),
  mengshu_history_rebuild_model_receipts: Object.freeze({
    receipt_hash: "text", run_id: "text", source_table: "text", record_id: "uuid",
    source_hash: "text", model_fingerprint: "text", prompt_hash: "text", schema_hash: "text",
    input_hash: "text", output_hash: "text", confidence: "double precision",
    proposal_count: "integer", input_tokens: "integer", output_tokens: "integer",
    created_at: "bigint",
  }),
  mengshu_history_rebuild_operation_receipts: Object.freeze({
    receipt_hash: "text", run_id: "text", source_table: "text", operation: "text",
    status: "text", counts: "jsonb", result_hash: "text", drift_hash: "text",
    created_at: "bigint",
  }),
  mengshu_history_rebuild_artifacts: Object.freeze({
    run_id: "text", source_table: "text", record_id: "uuid", artifact_type: "text",
    artifact_id: "text", artifact_role: "text", source_hash: "text", created_at: "bigint",
  }),
});

const HISTORY_REBUILD_MODEL_ATTEMPT_COLUMN_TYPES = Object.freeze({
  mengshu_history_rebuild_model_attempts: Object.freeze({
    migration_id: "text", manifest_hash: "text", run_id: "text", source_table: "text",
    record_id: "uuid", source_hash: "text", attempt: "integer", model_fingerprint: "text",
    prompt_hash: "text", schema_hash: "text", input_hash: "text", state: "text",
    reserved_input_tokens: "integer", reserved_output_tokens: "integer",
    reserved_cost_minor_units: "bigint", output: "jsonb", output_hash: "text",
    actual_input_tokens: "integer", actual_output_tokens: "integer",
    actual_cost_minor_units: "bigint", reserved_at: "bigint", completed_at: "bigint",
  }),
});

const ASSET_LOADOUT_OVERLAY_REQUIRED_CONSTRAINTS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    mengshu_asset_versions: [
      "PRIMARY KEY (scope_fingerprint, asset_id, version)", "kind = 'memory_view'",
      "status = ANY", "visibility = 'private'", "jsonb_typeof(descriptor) = 'object'",
    ],
    mengshu_asset_heads: [
      "PRIMARY KEY (scope_fingerprint, asset_id)",
      "FOREIGN KEY (scope_fingerprint, asset_id, latest_version)",
      "REFERENCES mengshu_asset_versions",
    ],
    mengshu_asset_promotion_receipts: [
      "PRIMARY KEY (receipt_id)", "UNIQUE (scope_fingerprint, request_key)",
      "FOREIGN KEY (scope_fingerprint, asset_id, asset_version)",
      "REFERENCES mengshu_asset_versions", "jsonb_typeof(receipt) = 'object'",
    ],
    mengshu_asset_audit: [
      "PRIMARY KEY (audit_id)", "FOREIGN KEY (receipt_id)",
      "REFERENCES mengshu_asset_promotion_receipts",
      "FOREIGN KEY (scope_fingerprint, asset_id, asset_version)",
      "REFERENCES mengshu_asset_versions", "event_type = ANY",
    ],
    mengshu_asset_outbox: [
      "PRIMARY KEY (event_id)", "FOREIGN KEY (scope_fingerprint, asset_id, asset_version)",
      "REFERENCES mengshu_asset_versions", "event_type = ANY", "jsonb_typeof(payload) = 'object'",
    ],
    mengshu_loadout_versions: [
      "PRIMARY KEY (scope_fingerprint, loadout_id, version)", "visibility = 'private'",
      "jsonb_typeof(descriptor) = 'object'",
    ],
    mengshu_loadout_heads: [
      "PRIMARY KEY (scope_fingerprint, loadout_id)",
      "FOREIGN KEY (scope_fingerprint, loadout_id, latest_version)",
      "REFERENCES mengshu_loadout_versions",
    ],
    mengshu_loadout_receipts: [
      "PRIMARY KEY (scope_fingerprint, request_key)",
      "FOREIGN KEY (scope_fingerprint, loadout_id, loadout_version)",
      "REFERENCES mengshu_loadout_versions", "jsonb_typeof(receipt) = 'object'",
    ],
  });

const GOVERNED_DOCUMENT_ASSET_REQUIRED_CONSTRAINTS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    ...ASSET_LOADOUT_OVERLAY_REQUIRED_CONSTRAINTS,
    mengshu_asset_versions: Object.freeze([
      "PRIMARY KEY (scope_fingerprint, asset_id, version)",
      "kind = ANY (ARRAY['memory_view'::text, 'memory_document'::text, 'tree_document'::text, 'index_document'::text])",
      "status = ANY (ARRAY['draft'::text, 'review'::text, 'published'::text, 'active'::text, 'deprecated'::text, 'revoked'::text])",
      "visibility = 'private'", "jsonb_typeof(descriptor) = 'object'",
    ]),
  });

const LOADOUT_EVENT_LEDGER_REQUIRED_CONSTRAINTS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    mengshu_loadout_audit: [
      "PRIMARY KEY (audit_id)", "FOREIGN KEY (scope_fingerprint, loadout_id, loadout_version)",
      "REFERENCES mengshu_loadout_versions", "FOREIGN KEY (scope_fingerprint, request_key)",
      "REFERENCES mengshu_loadout_receipts", "event_type = 'version_created'",
    ],
    mengshu_loadout_outbox: [
      "PRIMARY KEY (event_id)", "FOREIGN KEY (scope_fingerprint, loadout_id, loadout_version)",
      "REFERENCES mengshu_loadout_versions", "event_type = 'loadout.version.created'",
      "jsonb_typeof(payload) = 'object'",
    ],
  });

const CONTEXT_ASSEMBLY_RECEIPT_REQUIRED_CONSTRAINTS = Object.freeze({
  mengshu_context_assembly_receipts: Object.freeze([
    "PRIMARY KEY (receipt_id)", "receipt_id ~ '^[0-9a-f]{64}$'",
    "scope_fingerprint ~ '^[0-9a-f]{64}$'", "stable_content_hash ~ '^[0-9a-f]{64}$'",
    "dynamic_content_hash ~ '^[0-9a-f]{64}$'", "jsonb_typeof(receipt) = 'object'",
    "created_at >= 0", "expires_at >= created_at", "char_length(session_id)",
    "char_length(session_id) >= 1", "char_length(session_id) <= 256",
    "session_id !~ '[[:space:][:cntrl:]]'",
  ]),
});

const ASSET_LOADOUT_OVERLAY_REQUIRED_INDEXES = Object.freeze([
  "mengshu_asset_versions_status_idx", "mengshu_asset_outbox_pending_idx",
  "mengshu_loadout_identity_idx",
] as const);
const LOADOUT_EVENT_LEDGER_REQUIRED_INDEXES = Object.freeze([
  "mengshu_loadout_outbox_pending_idx",
] as const);
const CONTEXT_ASSEMBLY_RECEIPT_REQUIRED_INDEXES = Object.freeze([
  "mengshu_context_assembly_receipts_session_idx",
] as const);

const HISTORY_REBUILD_LEDGER_REQUIRED_CONSTRAINTS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    mengshu_history_rebuild_runs: [
      "PRIMARY KEY (run_id)", "UNIQUE (migration_id, scope_fingerprint, attempt_hash)",
      "scope_fingerprint ~ '^[0-9a-f]{64}$'", "visibility = ANY", "state = ANY",
    ],
    mengshu_history_rebuild_source_snapshots: [
      "PRIMARY KEY (run_id, source_table)", "FOREIGN KEY (run_id)",
      "REFERENCES mengshu_history_rebuild_runs", "source_table = ANY",
      "source_count = 0", "source_upper_bound IS NULL",
    ],
    mengshu_history_rebuild_source_rows: [
      "PRIMARY KEY (run_id, source_table, record_id)",
      "UNIQUE (run_id, source_table, source_hash)",
      "FOREIGN KEY (run_id, source_table)",
      "REFERENCES mengshu_history_rebuild_source_snapshots",
      "source_table = ANY", "jsonb_typeof(source_row) = 'object'",
      "jsonb_typeof(original_metadata) = 'object'",
    ],
    mengshu_history_rebuild_checkpoints: [
      "PRIMARY KEY (run_id, source_table)", "FOREIGN KEY (run_id, source_table)",
      "REFERENCES mengshu_history_rebuild_source_snapshots", "jsonb_typeof(counts) = 'object'",
      "state = ANY",
    ],
    mengshu_history_rebuild_shadow_plans: [
      "PRIMARY KEY (run_id, source_table, record_id)", "UNIQUE (run_id, plan_receipt_hash)",
      "FOREIGN KEY (run_id, source_table)", "REFERENCES mengshu_history_rebuild_source_snapshots",
      "disposition = ANY", "semantic_type IS NULL", "jsonb_typeof(topic_labels) = 'array'",
      "jsonb_typeof(tree_eligibility) = 'object'", "source_table <> 'knowledge'",
    ],
    mengshu_history_rebuild_model_receipts: [
      "PRIMARY KEY (receipt_hash)", "UNIQUE (run_id, source_table, record_id)",
      "FOREIGN KEY (run_id, source_table, record_id)",
      "REFERENCES mengshu_history_rebuild_shadow_plans", "confidence >=", "confidence <=",
    ],
    mengshu_history_rebuild_operation_receipts: [
      "PRIMARY KEY (receipt_hash)", "FOREIGN KEY (run_id)",
      "REFERENCES mengshu_history_rebuild_runs", "operation = ANY", "status = ANY",
      "jsonb_typeof(counts) = 'object'", "drift_hash IS NULL",
    ],
    mengshu_history_rebuild_artifacts: [
      "PRIMARY KEY (run_id, artifact_type, artifact_id)",
      "FOREIGN KEY (run_id, source_table, record_id)",
      "REFERENCES mengshu_history_rebuild_source_rows", "source_table = ANY",
      "artifact_type = ANY", "artifact_role = ANY", "source_hash ~ '^[0-9a-f]{64}$'",
      "char_length(artifact_id) >= 1", "char_length(artifact_id) <= 256",
      "artifact_id !~ '[[:space:][:cntrl:]]'",
    ],
  });

const HISTORY_REBUILD_LEDGER_REQUIRED_INDEXES = Object.freeze([
  "mengshu_history_rebuild_shadow_disposition_idx",
  "mengshu_history_rebuild_operations_idx",
  "mengshu_history_rebuild_artifacts_source_idx",
] as const);

const HISTORY_REBUILD_MODEL_ATTEMPT_REQUIRED_CONSTRAINTS = Object.freeze([
  "PRIMARY KEY (run_id, source_table, record_id, attempt)",
  "FOREIGN KEY (run_id)", "REFERENCES mengshu_history_rebuild_runs",
  "source_table = ANY", "state = ANY", "attempt >= 0", "attempt < 2",
  "output IS NULL", "jsonb_typeof(output) = 'object'",
  "actual_input_tokens = reserved_input_tokens",
  "actual_output_tokens <= reserved_output_tokens",
  "actual_cost_minor_units <= reserved_cost_minor_units",
] as const);

const HISTORY_REBUILD_MODEL_ATTEMPT_REQUIRED_INDEX =
  "mengshu_history_rebuild_model_attempts_budget_idx" as const;

const CANDIDATE_WRITE_JOURNAL_COLUMN_TYPES = Object.freeze({
  mengshu_candidate_write_receipts: Object.freeze({
    storage_key: "text", request_fingerprint: "text", candidate_id: "text", tenant_id: "text",
    user_id: "text", app_id: "text", project_id: "text", agent_id: "text", namespace: "text",
    visibility: "text", workspace_id: "text", session_id: "text", route: "text", result: "jsonb",
    created_at: "timestamp with time zone",
  }),
  mengshu_candidate_write_audit: Object.freeze({
    audit_id: "bigint", storage_key: "text", request_fingerprint: "text", candidate_id: "text",
    action: "text", tenant_id: "text", user_id: "text", app_id: "text", project_id: "text",
    agent_id: "text", namespace: "text", visibility: "text", workspace_id: "text",
    session_id: "text", route: "text", occurred_at: "timestamp with time zone",
  }),
  mengshu_candidate_write_outbox: Object.freeze({
    event_id: "text", storage_key: "text", request_fingerprint: "text", candidate_id: "text",
    topic: "text", tenant_id: "text", user_id: "text", app_id: "text", project_id: "text",
    agent_id: "text", namespace: "text", visibility: "text", workspace_id: "text",
    session_id: "text", route: "text", occurred_at: "timestamp with time zone",
    published_at: "timestamp with time zone",
  }),
} as const);

function asAppliedRows(rows: readonly Record<string, unknown>[]): AppliedSchemaMigration[] {
  return rows.map((row) => {
    if (
      !Number.isInteger(row.version) ||
      typeof row.name !== "string" ||
      typeof row.checksum !== "string"
    ) {
      throw new Error("Invalid schema migration ledger row");
    }
    return {
      version: Number(row.version),
      name: row.name,
      checksum: row.checksum,
    };
  });
}

const AUTHORITY_DEDUPE_TABLES = ["memories", "knowledge"] as const;
const AUTHORITY_DEDUPE_COLUMNS = [
  "tenant_id",
  "user_id",
  "canonical_project_id",
  "product_id",
  "producer_id",
  "namespace",
  "visibility",
  "content_hash",
] as const;

function asBoolean(value: unknown): boolean {
  return value === true;
}

function sameColumns(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual) && actual.length === expected.length &&
    actual.every((column, index) => column === expected[index]);
}

function normalizeIndexPredicate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let normalized = value.replaceAll("::text", "").replace(/\s+/g, " ").trim();
  while (normalized.startsWith("(") && normalized.endsWith(")")) {
    let depth = 0;
    let enclosesWholeExpression = true;
    for (let index = 0; index < normalized.length; index += 1) {
      const character = normalized[index];
      if (character === "(") depth += 1;
      if (character === ")") depth -= 1;
      if (depth === 0 && index < normalized.length - 1) {
        enclosesWholeExpression = false;
        break;
      }
      if (depth < 0) return null;
    }
    if (!enclosesWholeExpression || depth !== 0) break;
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized;
}

/** v6 ledger 只能在物理 catalog 与逻辑 contract 完全一致时写入。 */
export async function verifyAuthorityDedupeCatalog(
  client: PostgresMigrationClient,
  contractVersion: 6 | 18 = 6,
): Promise<void> {
  const result = await client.query(AUTHORITY_DEDUPE_INDEX_CATALOG_SQL, [AUTHORITY_DEDUPE_TABLES]);
  for (const table of AUTHORITY_DEDUPE_TABLES) {
    const rows = result.rows.filter((row) => row.table_name === table);
    const expectedName = `${table}_authority_content_hash_uidx`;
    const expected = rows.find((row) => row.index_name === expectedName);
    const expectedPredicate = contractVersion >= 18 && table === "memories"
      ? "lifecycle_status = 'active'"
      : null;
    if (!expected || !asBoolean(expected.is_unique) || !asBoolean(expected.is_valid) ||
        !asBoolean(expected.is_ready) ||
        normalizeIndexPredicate(expected.predicate) !== expectedPredicate ||
        !sameColumns(expected.index_columns, AUTHORITY_DEDUPE_COLUMNS)) {
      throw new PostgresSchemaContractError(
        "SCHEMA_CONTRACT_INVALID",
        `Postgres authority dedupe catalog is invalid for ${table}`,
      );
    }
    if (rows.some((row) => sameColumns(row.index_columns, ["content_hash"]))) {
      throw new PostgresSchemaContractError(
        "SCHEMA_CONTRACT_INVALID",
        `Postgres legacy global content hash unique index is still active for ${table}`,
      );
    }
  }
}

/** expand-only/pending 阶段必须继续由旧 global unique 保护，禁止无约束写窗口。 */
export async function verifyPendingGlobalDedupeCatalog(
  client: PostgresMigrationClient,
): Promise<void> {
  const result = await client.query(AUTHORITY_DEDUPE_INDEX_CATALOG_SQL, [AUTHORITY_DEDUPE_TABLES]);
  for (const table of AUTHORITY_DEDUPE_TABLES) {
    const rows = result.rows.filter((row) => row.table_name === table);
    const legacyGlobal = rows.filter((row) =>
      asBoolean(row.is_unique) && asBoolean(row.is_valid) && asBoolean(row.is_ready) &&
      row.predicate === null && sameColumns(row.index_columns, ["content_hash"]),
    );
    if (legacyGlobal.length === 0) {
      throw new PostgresSchemaContractError(
        "SCHEMA_CONTRACT_INVALID",
        `Postgres pending schema lacks legacy global content hash protection for ${table}`,
      );
    }
  }
}

const DURABLE_DOMAIN_NULLABLE_COLUMNS = Object.freeze({
  mengshu_tree_leaves: Object.freeze([] as string[]),
  mengshu_tree_buffers: Object.freeze(["seal_after_at"]),
  mengshu_tree_summary_nodes: Object.freeze(["sealed_at"]),
  mengshu_graph_entities: Object.freeze([
    "last_seen_at", "graph_centrality", "merged_into",
  ]),
  mengshu_graph_relations: Object.freeze([] as string[]),
} as const);

/** v9 ledger/readiness 只能在五张 canonical relation 的物理合同完整时成立。 */
export async function verifyDurableDomainSchemaCatalog(
  client: PostgresMigrationClient,
): Promise<void> {
  const tableNames = Object.keys(DURABLE_DOMAIN_REQUIRED_COLUMNS);
  const result = await client.query(DURABLE_DOMAIN_SCHEMA_CATALOG_SQL, [tableNames]);
  for (const tableName of tableNames) {
    const expectedColumns = DURABLE_DOMAIN_REQUIRED_COLUMNS[
      tableName as keyof typeof DURABLE_DOMAIN_REQUIRED_COLUMNS
    ];
    const nullableColumns = new Set(DURABLE_DOMAIN_NULLABLE_COLUMNS[
      tableName as keyof typeof DURABLE_DOMAIN_NULLABLE_COLUMNS
    ]);
    const columnRows = result.rows.filter((row) =>
      row.kind === "column" && row.table_name === tableName);
    const actualColumns = columnRows.map((row) => row.object_name).sort();
    if (!sameColumns(actualColumns, [...expectedColumns].sort()) ||
        columnRows.some((row) => typeof row.object_name !== "string" ||
          row.is_nullable !== (nullableColumns.has(row.object_name) ? "YES" : "NO"))) {
      throw new PostgresSchemaContractError(
        "SCHEMA_CONTRACT_INVALID",
        `Postgres durable domain columns are invalid for ${tableName}`,
      );
    }
    const fingerprint = columnRows.find((row) => row.object_name === "scope_fingerprint");
    if (!fingerprint || fingerprint.definition !== "text") {
      throw new PostgresSchemaContractError(
        "SCHEMA_CONTRACT_INVALID",
        `Postgres durable domain scope fingerprint is invalid for ${tableName}`,
      );
    }
    const constraints = result.rows.filter((row) =>
      row.kind === "constraint" && row.table_name === tableName);
    const definitions = constraints.map((row) =>
      typeof row.definition === "string" ? row.definition.replace(/\s+/g, " ").toLowerCase() : "");
    const required = DURABLE_DOMAIN_REQUIRED_CONSTRAINTS[
      tableName as keyof typeof DURABLE_DOMAIN_REQUIRED_CONSTRAINTS
    ];
    if (constraints.some((row) => !asBoolean(row.is_valid)) || required.some((fragment) =>
      !definitions.some((definition) => definition.includes(fragment.toLowerCase())))) {
      throw new PostgresSchemaContractError(
        "SCHEMA_CONTRACT_INVALID",
        `Postgres durable domain constraints are invalid for ${tableName}`,
      );
    }
  }
  for (const indexName of DURABLE_DOMAIN_REQUIRED_INDEXES) {
    const index = result.rows.find((row) => row.kind === "index" && row.object_name === indexName);
    if (!index || !asBoolean(index.is_valid) || !asBoolean(index.is_ready)) {
      throw new PostgresSchemaContractError(
        "SCHEMA_CONTRACT_INVALID",
        `Postgres durable domain index is invalid: ${indexName}`,
      );
    }
  }
}

/** v10 ledger/readiness requires the PostgreSQL-safe lease token constraint. */
export async function verifyDurableJobStateSchemaCatalog(
  client: PostgresMigrationClient,
): Promise<void> {
  const result = await client.query(DURABLE_JOB_STATE_SCHEMA_CATALOG_SQL);
  const decoded = result.rows.map((row) => ({
    row,
    definition: typeof row.definition === "string"
      ? row.definition.replace(/\s+/g, " ").toLowerCase()
      : "",
  }));
  const stateConstraints = decoded.filter(({ definition }) =>
    definition.includes("lease_token") || definition.includes("lease_owner"));
  if (stateConstraints.length !== 1) {
    throw new PostgresSchemaContractError(
      "SCHEMA_CONTRACT_INVALID",
      "Postgres durable job state constraint is missing or duplicated",
    );
  }
  const { row, definition } = stateConstraints[0]!;
  if (row.constraint_name !== DURABLE_JOB_STATE_CONSTRAINT_NAME ||
      !asBoolean(row.is_valid) || decoded.some(({ row: item, definition: itemDefinition }) =>
        !asBoolean(item.is_valid) || itemDefinition.includes("{32,256}")) ||
      !definition.includes("char_length(lease_token) >= 32") ||
      !definition.includes("char_length(lease_token) <= 256") ||
      !definition.includes("lease_token ~ '^[a-za-z0-9._~-]+$'") ||
      ["queued", "running", "retry_wait", "completed", "dead_letter"].some((status) =>
        !definition.includes(`status = '${status}'`))) {
    throw new PostgresSchemaContractError(
      "SCHEMA_CONTRACT_INVALID",
      "Postgres durable job state constraint is invalid",
    );
  }
}

/** v11 ledger/readiness requires the complete atomic memory write journal. */
export async function verifyWriteJournalSchemaCatalog(
  client: PostgresMigrationClient,
  options: EvolutionCatalogOptions = {},
): Promise<void> {
  const tableNames = Object.keys(WRITE_JOURNAL_REQUIRED_COLUMNS);
  const result = await client.query(DURABLE_DOMAIN_SCHEMA_CATALOG_SQL, [tableNames]);
  for (const tableName of tableNames) {
    const expectedColumns = WRITE_JOURNAL_REQUIRED_COLUMNS[
      tableName as keyof typeof WRITE_JOURNAL_REQUIRED_COLUMNS
    ];
    const columnRows = verifyCatalogColumnExtension(tableName, result.rows.filter((row) =>
      row.kind === "column" && row.table_name === tableName),
    options.evolutionGovernance && tableName === "mengshu_write_outbox" ? EVOLUTION_OUTBOX_COLUMN_CONTRACT : {});
    const actualColumns = columnRows.map((row) => row.object_name).sort();
    const expectedTypes = WRITE_JOURNAL_COLUMN_TYPES[
      tableName as keyof typeof WRITE_JOURNAL_COLUMN_TYPES
    ];
    if (!sameColumns(actualColumns, [...expectedColumns].sort()) || columnRows.some((row) => {
      const columnName = row.object_name as keyof typeof expectedTypes;
      const nullable = tableName === "mengshu_write_outbox" && row.object_name === "published_at";
      const defaultDefinition = row.default_definition;
      const requiresNow = tableName === "mengshu_write_receipts" && row.object_name === "created_at";
      const requiresSequence = tableName === "mengshu_write_audit" && row.object_name === "audit_id";
      const requiresEmpty = (tableName === "mengshu_write_audit" ||
        tableName === "mengshu_write_outbox") &&
        (row.object_name === "workspace_id" || row.object_name === "session_id");
      return row.definition !== expectedTypes[columnName] ||
        row.is_nullable !== (nullable ? "YES" : "NO") ||
        (requiresNow && (typeof defaultDefinition !== "string" ||
          !defaultDefinition.toLowerCase().includes("now()"))) ||
        (requiresSequence && (typeof defaultDefinition !== "string" ||
          !defaultDefinition.toLowerCase().includes("nextval("))) ||
        (requiresEmpty && (typeof defaultDefinition !== "string" ||
          !defaultDefinition.includes("''::text")));
    })) {
      throw new PostgresSchemaContractError(
        "SCHEMA_CONTRACT_INVALID",
        `Postgres write journal columns are invalid for ${tableName}`,
      );
    }
    const constraints = result.rows.filter((row) =>
      row.kind === "constraint" && row.table_name === tableName);
    const definitions = constraints.map((row) =>
      typeof row.definition === "string" ? row.definition.replace(/\s+/g, " ").toLowerCase() : "");
    const required = WRITE_JOURNAL_REQUIRED_CONSTRAINTS[
      tableName as keyof typeof WRITE_JOURNAL_REQUIRED_CONSTRAINTS
    ];
    if (constraints.some((row) => !asBoolean(row.is_valid)) || required.some((fragment) =>
      !definitions.some((definition) => definition.includes(fragment.toLowerCase())))) {
      throw new PostgresSchemaContractError(
        "SCHEMA_CONTRACT_INVALID",
        `Postgres write journal constraints are invalid for ${tableName}`,
      );
    }
  }
  for (const indexName of WRITE_JOURNAL_REQUIRED_INDEXES) {
    const index = result.rows.find((row) => row.kind === "index" && row.object_name === indexName);
    if (!index || !asBoolean(index.is_valid) || !asBoolean(index.is_ready)) {
      throw new PostgresSchemaContractError(
        "SCHEMA_CONTRACT_INVALID",
        `Postgres write journal index is invalid: ${indexName}`,
      );
    }
  }
}

/** v12 ledger/readiness 只能在可回滚 shadow、过程 receipt 和 queryability 合同完整时成立。 */
export async function verifyEmbeddingReembedSchemaCatalog(
  client: PostgresMigrationClient,
): Promise<void> {
  const tableNames = Object.keys(EMBEDDING_REEMBED_REQUIRED_COLUMNS);
  const result = await client.query(DURABLE_DOMAIN_SCHEMA_CATALOG_SQL, [tableNames]);
  for (const tableName of tableNames) {
    const typedTableName = tableName as keyof typeof EMBEDDING_REEMBED_REQUIRED_COLUMNS;
    const expectedColumns = EMBEDDING_REEMBED_REQUIRED_COLUMNS[typedTableName];
    const expectedTypes = EMBEDDING_REEMBED_COLUMN_TYPES[typedTableName];
    const nullableColumns = new Set(EMBEDDING_REEMBED_NULLABLE_COLUMNS[typedTableName]);
    const columnRows = result.rows.filter((row) =>
      row.kind === "column" && row.table_name === tableName);
    const actualColumns = columnRows.map((row) => row.object_name).sort();
    if (!sameColumns(actualColumns, [...expectedColumns].sort()) || columnRows.some((row) => {
      if (typeof row.object_name !== "string" || !(row.object_name in expectedTypes)) return true;
      const columnName = row.object_name as keyof typeof expectedTypes;
      const requiresNow = row.object_name === "created_at" || row.object_name === "captured_at";
      return row.definition !== expectedTypes[columnName] ||
        row.is_nullable !== (nullableColumns.has(row.object_name) ? "YES" : "NO") ||
        (requiresNow && (typeof row.default_definition !== "string" ||
          !row.default_definition.toLowerCase().includes("now()")));
    })) {
      throw new PostgresSchemaContractError(
        "SCHEMA_CONTRACT_INVALID",
        `Postgres embedding re-embed columns are invalid for ${tableName}`,
      );
    }

    const constraints = result.rows.filter((row) =>
      row.kind === "constraint" && row.table_name === tableName);
    const definitions = constraints.map((row) =>
      typeof row.definition === "string" ? row.definition.replace(/\s+/g, " ").toLowerCase() : "");
    const required = EMBEDDING_REEMBED_REQUIRED_CONSTRAINTS[typedTableName];
    if (constraints.some((row) => !asBoolean(row.is_valid)) || required.some((fragment) =>
      !definitions.some((definition) => definition.includes(fragment.toLowerCase())))) {
      throw new PostgresSchemaContractError(
        "SCHEMA_CONTRACT_INVALID",
        `Postgres embedding re-embed constraints are invalid for ${tableName}`,
      );
    }
  }
  for (const indexName of EMBEDDING_REEMBED_REQUIRED_INDEXES) {
    const index = result.rows.find((row) => row.kind === "index" && row.object_name === indexName);
    if (!index || !asBoolean(index.is_valid) || !asBoolean(index.is_ready)) {
      throw new PostgresSchemaContractError(
        "SCHEMA_CONTRACT_INVALID",
        `Postgres embedding re-embed index is invalid: ${indexName}`,
      );
    }
  }
}

/** v13 ledger/readiness 必须由独立的 Work Memory Graph 物理合同支撑。 */
export async function verifyWorkMemoryGraphSchemaCatalog(
  client: PostgresMigrationClient,
): Promise<void> {
  const tableNames = Object.keys(WORK_MEMORY_GRAPH_REQUIRED_COLUMNS);
  const result = await client.query(DURABLE_DOMAIN_SCHEMA_CATALOG_SQL, [tableNames]);
  for (const tableName of tableNames) {
    const typedTableName = tableName as keyof typeof WORK_MEMORY_GRAPH_REQUIRED_COLUMNS;
    const expectedColumns = WORK_MEMORY_GRAPH_REQUIRED_COLUMNS[typedTableName];
    const nullableColumns = new Set(WORK_MEMORY_GRAPH_NULLABLE_COLUMNS[typedTableName]);
    const columnRows = result.rows.filter((row) => row.kind === "column" && row.table_name === tableName);
    const actualColumns = columnRows.map((row) => row.object_name).sort();
    if (!sameColumns(actualColumns, [...expectedColumns].sort()) || columnRows.some((row) =>
      typeof row.object_name !== "string" ||
      row.is_nullable !== (nullableColumns.has(row.object_name) ? "YES" : "NO"))) {
      throw new PostgresSchemaContractError(
        "SCHEMA_CONTRACT_INVALID",
        `Postgres Work Memory Graph columns are invalid for ${tableName}`,
      );
    }
    const fingerprint = columnRows.find((row) => row.object_name === "scope_fingerprint");
    if (!fingerprint || fingerprint.definition !== "text") {
      throw new PostgresSchemaContractError(
        "SCHEMA_CONTRACT_INVALID",
        `Postgres Work Memory Graph scope fingerprint is invalid for ${tableName}`,
      );
    }
    const constraints = result.rows.filter((row) =>
      row.kind === "constraint" && row.table_name === tableName);
    const definitions = constraints.map((row) =>
      typeof row.definition === "string" ? row.definition.replace(/\s+/g, " ").toLowerCase() : "");
    const required = WORK_MEMORY_GRAPH_REQUIRED_CONSTRAINTS[typedTableName];
    if (constraints.some((row) => !asBoolean(row.is_valid)) || required.some((fragment) =>
      !definitions.some((definition) => definition.includes(fragment.toLowerCase())))) {
      throw new PostgresSchemaContractError(
        "SCHEMA_CONTRACT_INVALID",
        `Postgres Work Memory Graph constraints are invalid for ${tableName}`,
      );
    }
  }
  for (const indexName of WORK_MEMORY_GRAPH_REQUIRED_INDEXES) {
    const index = result.rows.find((row) => row.kind === "index" && row.object_name === indexName);
    if (!index || !asBoolean(index.is_valid) || !asBoolean(index.is_ready)) {
      throw new PostgresSchemaContractError(
        "SCHEMA_CONTRACT_INVALID",
        `Postgres Work Memory Graph index is invalid: ${indexName}`,
      );
    }
  }
}

/** v14 ledger/readiness requires an independent F0 candidate write journal. */
export async function verifyCandidateWriteJournalSchemaCatalog(
  client: PostgresMigrationClient,
): Promise<void> {
  const tableNames = Object.keys(CANDIDATE_WRITE_JOURNAL_REQUIRED_COLUMNS);
  const result = await client.query(DURABLE_DOMAIN_SCHEMA_CATALOG_SQL, [tableNames]);
  for (const tableName of tableNames) {
    const typedTableName = tableName as keyof typeof CANDIDATE_WRITE_JOURNAL_REQUIRED_COLUMNS;
    const expectedColumns = CANDIDATE_WRITE_JOURNAL_REQUIRED_COLUMNS[typedTableName];
    const expectedTypes = CANDIDATE_WRITE_JOURNAL_COLUMN_TYPES[typedTableName];
    const columnRows = result.rows.filter((row) =>
      row.kind === "column" && row.table_name === tableName);
    const actualColumns = columnRows.map((row) => row.object_name).sort();
    if (!sameColumns(actualColumns, [...expectedColumns].sort()) || columnRows.some((row) => {
      if (typeof row.object_name !== "string" || !(row.object_name in expectedTypes)) return true;
      const columnName = row.object_name as keyof typeof expectedTypes;
      const nullable = tableName === "mengshu_candidate_write_outbox" &&
        row.object_name === "published_at";
      const requiresNow = tableName === "mengshu_candidate_write_receipts" &&
        row.object_name === "created_at";
      const requiresSequence = tableName === "mengshu_candidate_write_audit" &&
        row.object_name === "audit_id";
      const requiresEmpty = (row.object_name === "workspace_id" || row.object_name === "session_id");
      const defaultDefinition = row.default_definition;
      return row.definition !== expectedTypes[columnName] ||
        row.is_nullable !== (nullable ? "YES" : "NO") ||
        (requiresNow && (typeof defaultDefinition !== "string" ||
          !defaultDefinition.toLowerCase().includes("now()"))) ||
        (requiresSequence && (typeof defaultDefinition !== "string" ||
          !defaultDefinition.toLowerCase().includes("nextval("))) ||
        (requiresEmpty && (typeof defaultDefinition !== "string" ||
          !defaultDefinition.includes("''::text")));
    })) {
      throw new PostgresSchemaContractError(
        "SCHEMA_CONTRACT_INVALID",
        `Postgres candidate write journal columns are invalid for ${tableName}`,
      );
    }

    const constraints = result.rows.filter((row) =>
      row.kind === "constraint" && row.table_name === tableName);
    const definitions = constraints.map((row) =>
      typeof row.definition === "string" ? row.definition.replace(/\s+/g, " ").toLowerCase() : "");
    const required = CANDIDATE_WRITE_JOURNAL_REQUIRED_CONSTRAINTS[typedTableName];
    const quotedValues = (definition: string): string[] =>
      [...definition.matchAll(/'([^']+)'/g)].map((match) => match[1]!).sort();
    const routeDefinition = definitions.find((definition) =>
      definition.includes("route = any"));
    const visibilityDefinition = definitions.find((definition) =>
      definition.includes("visibility = any"));
    if (constraints.some((row) => !asBoolean(row.is_valid)) || required.some((fragment) =>
      !definitions.some((definition) => definition.includes(fragment.toLowerCase()))) ||
      !routeDefinition || !sameColumns(quotedValues(routeDefinition), ["candidate", "candidate_low_priority"]) ||
      !visibilityDefinition || !sameColumns(quotedValues(visibilityDefinition), [
        "private", "public", "team", "workspace",
      ])) {
      throw new PostgresSchemaContractError(
        "SCHEMA_CONTRACT_INVALID",
        `Postgres candidate write journal constraints are invalid for ${tableName}`,
      );
    }
  }
  for (const indexName of CANDIDATE_WRITE_JOURNAL_REQUIRED_INDEXES) {
    const index = result.rows.find((row) => row.kind === "index" && row.object_name === indexName);
    if (!index || !asBoolean(index.is_valid) || !asBoolean(index.is_ready)) {
      throw new PostgresSchemaContractError(
        "SCHEMA_CONTRACT_INVALID",
        `Postgres candidate write journal index is invalid: ${indexName}`,
      );
    }
  }
}

/** v15 ledger/readiness requires evidence provenance independent from Work Graph storage. */
export async function verifyEvidenceLinkLedgerSchemaCatalog(
  client: PostgresMigrationClient,
  options: EvolutionCatalogOptions = {},
): Promise<void> {
  const tableNames = Object.keys(EVIDENCE_LINK_LEDGER_REQUIRED_COLUMNS);
  const result = await client.query(DURABLE_DOMAIN_SCHEMA_CATALOG_SQL, [tableNames]);
  for (const tableName of tableNames) {
    const typedTableName = tableName as keyof typeof EVIDENCE_LINK_LEDGER_REQUIRED_COLUMNS;
    const expectedColumns = EVIDENCE_LINK_LEDGER_REQUIRED_COLUMNS[typedTableName];
    const columnRows = verifyCatalogColumnExtension(tableName, result.rows.filter((row) =>
      row.kind === "column" && row.table_name === tableName),
    options.evolutionGovernance && tableName === "mengshu_memory_evidence_links" ? EVOLUTION_EVIDENCE_COLUMN_CONTRACT : {});
    const actualColumns = columnRows.map((row) => row.object_name).sort();
    if (!sameColumns(actualColumns, [...expectedColumns].sort()) || columnRows.some((row) =>
      row.definition !== (row.object_name === "created_at" ? "bigint" : "text") ||
      row.is_nullable !== "NO" || ((row.object_name === "workspace_id" ||
        row.object_name === "session_id") && (typeof row.default_definition !== "string" ||
        !row.default_definition.includes("''::text"))))) {
      throw new PostgresSchemaContractError(
        "SCHEMA_CONTRACT_INVALID",
        `Postgres evidence link ledger columns are invalid for ${tableName}`,
      );
    }
    const constraints = result.rows.filter((row) =>
      row.kind === "constraint" && row.table_name === tableName);
    const definitions = constraints.map((row) =>
      typeof row.definition === "string" ? row.definition.replace(/\s+/g, " ").toLowerCase() : "");
    const required = EVIDENCE_LINK_LEDGER_REQUIRED_CONSTRAINTS[typedTableName];
    if (constraints.some((row) => !asBoolean(row.is_valid)) || required.some((fragment) =>
      !definitions.some((definition) => definition.includes(fragment.toLowerCase())))) {
      throw new PostgresSchemaContractError(
        "SCHEMA_CONTRACT_INVALID",
        `Postgres evidence link ledger constraints are invalid for ${tableName}`,
      );
    }
    if (tableName === "mengshu_memory_evidence_links" && definitions.some((definition) =>
      definition.includes("mengshu_work_memory_"))) {
      throw new PostgresSchemaContractError(
        "SCHEMA_CONTRACT_INVALID",
        "Postgres memory evidence links must not depend on Work Memory Graph storage",
      );
    }
  }
  for (const indexName of EVIDENCE_LINK_LEDGER_REQUIRED_INDEXES) {
    const index = result.rows.find((row) => row.kind === "index" && row.object_name === indexName);
    if (!index || !asBoolean(index.is_valid) || !asBoolean(index.is_ready)) {
      throw new PostgresSchemaContractError(
        "SCHEMA_CONTRACT_INVALID",
        `Postgres evidence link ledger index is invalid: ${indexName}`,
      );
    }
  }
}

/** v16 ledger/readiness requires the complete scope-bound D-21 alias state. */
export async function verifyTopicTreeAliasSchemaCatalog(
  client: PostgresMigrationClient,
): Promise<void> {
  const tableNames = Object.keys(TOPIC_TREE_ALIAS_REQUIRED_COLUMNS);
  const result = await client.query(DURABLE_DOMAIN_SCHEMA_CATALOG_SQL, [tableNames]);
  const tableName = "mengshu_topic_tree_aliases";
  const columnRows = result.rows.filter((row) =>
    row.kind === "column" && row.table_name === tableName);
  const actualColumns = columnRows.map((row) => row.object_name).sort();
  const expectedColumns = [...TOPIC_TREE_ALIAS_REQUIRED_COLUMNS[tableName]].sort();
  const nullable = new Set(["sealed_node_id", "superseded_at", "archived_at"]);
  const bigints = new Set(["created_at", "updated_at", "superseded_at", "archived_at"]);
  if (!sameColumns(actualColumns, expectedColumns) || columnRows.some((row) => {
    if (typeof row.object_name !== "string") return true;
    const expectedType = row.object_name === "merged_from"
      ? "jsonb"
      : bigints.has(row.object_name) ? "bigint" : "text";
    const requiresEmpty = row.object_name === "workspace_id" || row.object_name === "session_id";
    const requiresActive = row.object_name === "status";
    return row.definition !== expectedType ||
      row.is_nullable !== (nullable.has(row.object_name) ? "YES" : "NO") ||
      (requiresEmpty && (typeof row.default_definition !== "string" ||
        !row.default_definition.includes("''::text"))) ||
      (requiresActive && (typeof row.default_definition !== "string" ||
        !row.default_definition.includes("'active'::text")));
  })) {
    throw new PostgresSchemaContractError(
      "SCHEMA_CONTRACT_INVALID",
      "Postgres topic tree alias columns are invalid",
    );
  }
  const constraints = result.rows.filter((row) =>
    row.kind === "constraint" && row.table_name === tableName);
  const definitions = constraints.map((row) =>
    typeof row.definition === "string" ? row.definition.replace(/\s+/g, " ").toLowerCase() : "");
  if (constraints.some((row) => !asBoolean(row.is_valid)) ||
      TOPIC_TREE_ALIAS_REQUIRED_CONSTRAINTS.some((fragment) =>
        !definitions.some((definition) => definition.includes(fragment.toLowerCase())))) {
    throw new PostgresSchemaContractError(
      "SCHEMA_CONTRACT_INVALID",
      "Postgres topic tree alias constraints are invalid",
    );
  }
  for (const indexName of TOPIC_TREE_ALIAS_REQUIRED_INDEXES) {
    const index = result.rows.find((row) => row.kind === "index" && row.object_name === indexName);
    if (!index || !asBoolean(index.is_valid) || !asBoolean(index.is_ready)) {
      throw new PostgresSchemaContractError(
        "SCHEMA_CONTRACT_INVALID",
        `Postgres topic tree alias index is invalid: ${indexName}`,
      );
    }
  }
}

/** v17 ledger/readiness requires complete §5.10 canonical identity persistence. */
export async function verifyCanonicalEntityResolutionSchemaCatalog(
  client: PostgresMigrationClient,
): Promise<void> {
  const tableNames = Object.keys(CANONICAL_ENTITY_RESOLUTION_REQUIRED_COLUMNS);
  const result = await client.query(DURABLE_DOMAIN_SCHEMA_CATALOG_SQL, [tableNames]);
  for (const tableName of tableNames) {
    const typedTableName = tableName as keyof typeof CANONICAL_ENTITY_RESOLUTION_REQUIRED_COLUMNS;
    const expectedColumns = CANONICAL_ENTITY_RESOLUTION_REQUIRED_COLUMNS[typedTableName];
    const expectedTypes = CANONICAL_ENTITY_RESOLUTION_COLUMN_TYPES[typedTableName];
    const nullableColumns = new Set(CANONICAL_ENTITY_RESOLUTION_NULLABLE_COLUMNS[typedTableName]);
    const columnRows = result.rows.filter((row) =>
      row.kind === "column" && row.table_name === tableName);
    const actualColumns = columnRows.map((row) => row.object_name).sort();
    if (!sameColumns(actualColumns, [...expectedColumns].sort()) || columnRows.some((row) => {
      if (typeof row.object_name !== "string" || !(row.object_name in expectedTypes)) return true;
      const columnName = row.object_name as keyof typeof expectedTypes;
      const requiresEmpty = row.object_name === "workspace_id" || row.object_name === "session_id";
      return row.definition !== expectedTypes[columnName] ||
        row.is_nullable !== (nullableColumns.has(row.object_name) ? "YES" : "NO") ||
        (requiresEmpty && (typeof row.default_definition !== "string" ||
          !row.default_definition.includes("''::text")));
    })) {
      throw new PostgresSchemaContractError(
        "SCHEMA_CONTRACT_INVALID",
        `Postgres canonical entity resolution columns are invalid for ${tableName}`,
      );
    }

    const constraints = result.rows.filter((row) =>
      row.kind === "constraint" && row.table_name === tableName);
    const definitions = constraints.map((row) =>
      typeof row.definition === "string" ? row.definition.replace(/\s+/g, " ").toLowerCase() : "");
    const required = CANONICAL_ENTITY_RESOLUTION_REQUIRED_CONSTRAINTS[typedTableName];
    if (constraints.some((row) => !asBoolean(row.is_valid)) || required.some((fragment) =>
      !definitions.some((definition) => definition.includes(fragment.toLowerCase())))) {
      throw new PostgresSchemaContractError(
        "SCHEMA_CONTRACT_INVALID",
        `Postgres canonical entity resolution constraints are invalid for ${tableName}`,
      );
    }
  }

  for (const indexName of CANONICAL_ENTITY_RESOLUTION_REQUIRED_INDEXES) {
    const index = result.rows.find((row) => row.kind === "index" && row.object_name === indexName);
    if (!index || !asBoolean(index.is_valid) || !asBoolean(index.is_ready) ||
        typeof index.definition !== "string") {
      throw new PostgresSchemaContractError(
        "SCHEMA_CONTRACT_INVALID",
        `Postgres canonical entity resolution index is invalid: ${indexName}`,
      );
    }
    const definition = index.definition.replace(/\s+/g, " ").toLowerCase();
    if (indexName === "mengshu_graph_entity_alias_bindings_active_uidx" &&
        (!definition.includes("create unique index") ||
          !definition.includes("scope_fingerprint, entity_type, normalized_alias") ||
          !definition.includes("where (status = 'active'::text)"))) {
      throw new PostgresSchemaContractError(
        "SCHEMA_CONTRACT_INVALID",
        "Postgres active canonical entity alias ownership index is invalid",
      );
    }
    if (indexName === "mengshu_graph_entity_embeddings_queryable_idx" &&
        (!definition.includes("scope_fingerprint, entity_type, embedding_space_id, entity_id") ||
          !definition.includes("where (embedding_space_state = 'known-queryable'::text)") ||
          /\b(?:ivfflat|hnsw)\b/.test(definition))) {
      throw new PostgresSchemaContractError(
        "SCHEMA_CONTRACT_INVALID",
        "Postgres scoped canonical entity semantic scan index is invalid",
      );
    }
  }
}

async function verifyOverlaySchemaCatalog(
  client: PostgresMigrationClient,
  columnsByTable: Readonly<Record<string, readonly string[]>>,
  typesByTable: Readonly<Record<string, Readonly<Record<string, string>>>>,
  constraintsByTable: Readonly<Record<string, readonly string[]>>,
  requiredIndexes: readonly string[],
  capability: string,
  indexDefinitions: Readonly<Record<string, readonly string[]>> = {},
): Promise<void> {
  const tableNames = Object.keys(columnsByTable);
  const result = await client.query(DURABLE_DOMAIN_SCHEMA_CATALOG_SQL, [tableNames]);
  for (const tableName of tableNames) {
    const expectedColumns = columnsByTable[tableName] ?? [];
    const expectedTypes = typesByTable[tableName] ?? {};
    const columnRows = result.rows.filter((row) =>
      row.kind === "column" && row.table_name === tableName);
    const actualColumns = columnRows.map((row) => row.object_name).sort();
    if (!sameColumns(actualColumns, [...expectedColumns].sort()) || columnRows.some((row) => {
      if (typeof row.object_name !== "string") return true;
      const nullable = row.object_name === "published_at" ||
        (tableName === "mengshu_loadout_versions" && row.object_name === "project_id");
      const requiresSequence = row.object_name === "audit_id";
      return row.definition !== expectedTypes[row.object_name] ||
        row.is_nullable !== (nullable ? "YES" : "NO") ||
        (requiresSequence && (typeof row.default_definition !== "string" ||
          !row.default_definition.toLowerCase().includes("nextval(")));
    })) {
      throw new PostgresSchemaContractError(
        "SCHEMA_CONTRACT_INVALID",
        `Postgres ${capability} columns are invalid for ${tableName}`,
      );
    }
    const constraints = result.rows.filter((row) =>
      row.kind === "constraint" && row.table_name === tableName);
    const definitions = constraints.map((row) =>
      typeof row.definition === "string" ? row.definition.replace(/\s+/g, " ").toLowerCase() : "");
    if (constraints.some((row) => !asBoolean(row.is_valid)) ||
        (constraintsByTable[tableName] ?? []).some((fragment) =>
          !definitions.some((definition) => definition.includes(fragment.toLowerCase())))) {
      throw new PostgresSchemaContractError(
        "SCHEMA_CONTRACT_INVALID",
        `Postgres ${capability} constraints are invalid for ${tableName}`,
      );
    }
  }
  for (const indexName of requiredIndexes) {
    const index = result.rows.find((row) => row.kind === "index" && row.object_name === indexName);
    const normalizedDefinition = typeof index?.definition === "string"
      ? index.definition.replace(/\s+/g, " ").toLowerCase()
      : "";
    if (!index || !asBoolean(index.is_valid) || !asBoolean(index.is_ready) ||
        (indexName.includes("outbox_pending") &&
          (typeof index.definition !== "string" ||
            !normalizedDefinition.includes("where (published_at is null)"))) ||
        (indexDefinitions[indexName] ?? []).some((fragment) =>
          !normalizedDefinition.includes(fragment.toLowerCase()))) {
      throw new PostgresSchemaContractError(
        "SCHEMA_CONTRACT_INVALID",
        `Postgres ${capability} index is invalid: ${indexName}`,
      );
    }
  }
}

/** v20 private asset/loadout overlay must be physically complete before exposure. */
export async function verifyAssetLoadoutOverlaySchemaCatalog(
  client: PostgresMigrationClient,
  options: Readonly<{ governedDocumentKinds?: boolean }> = {},
): Promise<void> {
  await verifyOverlaySchemaCatalog(
    client,
    ASSET_LOADOUT_OVERLAY_REQUIRED_COLUMNS,
    ASSET_LOADOUT_OVERLAY_COLUMN_TYPES,
    options.governedDocumentKinds === true
      ? GOVERNED_DOCUMENT_ASSET_REQUIRED_CONSTRAINTS
      : ASSET_LOADOUT_OVERLAY_REQUIRED_CONSTRAINTS,
    ASSET_LOADOUT_OVERLAY_REQUIRED_INDEXES,
    "asset/loadout overlay",
  );
}

/** v21 loadout audit/outbox are part of the atomic write capability. */
export async function verifyLoadoutEventLedgerSchemaCatalog(
  client: PostgresMigrationClient,
): Promise<void> {
  await verifyOverlaySchemaCatalog(
    client,
    LOADOUT_EVENT_LEDGER_REQUIRED_COLUMNS,
    LOADOUT_EVENT_LEDGER_COLUMN_TYPES,
    LOADOUT_EVENT_LEDGER_REQUIRED_CONSTRAINTS,
    LOADOUT_EVENT_LEDGER_REQUIRED_INDEXES,
    "loadout event ledger",
  );
}

/** v22 assembly receipts must remain durable and queryable in deterministic session order. */
export async function verifyContextAssemblyReceiptSchemaCatalog(
  client: PostgresMigrationClient,
): Promise<void> {
  await verifyOverlaySchemaCatalog(
    client,
    CONTEXT_ASSEMBLY_RECEIPT_REQUIRED_COLUMNS,
    CONTEXT_ASSEMBLY_RECEIPT_COLUMN_TYPES,
    CONTEXT_ASSEMBLY_RECEIPT_REQUIRED_CONSTRAINTS,
    CONTEXT_ASSEMBLY_RECEIPT_REQUIRED_INDEXES,
    "context assembly receipt",
    {
      mengshu_context_assembly_receipts_session_idx: [
        "scope_fingerprint, session_id, created_at desc, receipt_id desc",
      ],
    },
  );
}

/** v23 history rebuild ledger is metadata-only and must stay physically complete. */
export async function verifyHistoryRebuildLedgerSchemaCatalog(
  client: PostgresMigrationClient,
): Promise<void> {
  const tableNames = Object.keys(HISTORY_REBUILD_LEDGER_REQUIRED_COLUMNS);
  const nullable = new Set([
    "mengshu_history_rebuild_source_snapshots.source_upper_bound",
    "mengshu_history_rebuild_checkpoints.after_id",
    "mengshu_history_rebuild_source_rows.original_lifecycle_status",
    "mengshu_history_rebuild_shadow_plans.semantic_type",
    "mengshu_history_rebuild_operation_receipts.drift_hash",
  ]);
  const result = await client.query(DURABLE_DOMAIN_SCHEMA_CATALOG_SQL, [tableNames]);
  for (const tableName of tableNames) {
    const expectedColumns = HISTORY_REBUILD_LEDGER_REQUIRED_COLUMNS[
      tableName as keyof typeof HISTORY_REBUILD_LEDGER_REQUIRED_COLUMNS
    ];
    const expectedTypes = HISTORY_REBUILD_LEDGER_COLUMN_TYPES[tableName] ?? {};
    const columns = result.rows.filter((row) => row.kind === "column" && row.table_name === tableName);
    if (!sameColumns(columns.map((row) => row.object_name).sort(), [...expectedColumns].sort()) ||
        columns.some((row) => {
          if (typeof row.object_name !== "string") return true;
          const key = `${tableName}.${row.object_name}`;
          const requiresEmpty = tableName === "mengshu_history_rebuild_runs" &&
            (row.object_name === "workspace_id" || row.object_name === "session_id");
          const requiresZero = tableName === "mengshu_history_rebuild_checkpoints" &&
            row.object_name === "checkpoint_version";
          return row.definition !== expectedTypes[row.object_name] ||
            row.is_nullable !== (nullable.has(key) ? "YES" : "NO") ||
            (requiresEmpty && (typeof row.default_definition !== "string" ||
              !row.default_definition.includes("''::text"))) ||
            (requiresZero && (typeof row.default_definition !== "string" ||
              !row.default_definition.includes("0")));
        })) {
      throw new PostgresSchemaContractError(
        "SCHEMA_CONTRACT_INVALID",
        `Postgres history rebuild ledger columns are invalid for ${tableName}`,
      );
    }
    const constraints = result.rows.filter((row) =>
      row.kind === "constraint" && row.table_name === tableName);
    const definitions = constraints.map((row) =>
      typeof row.definition === "string" ? row.definition.replace(/\s+/g, " ").toLowerCase() : "");
    if (constraints.some((row) => !asBoolean(row.is_valid)) ||
        (HISTORY_REBUILD_LEDGER_REQUIRED_CONSTRAINTS[tableName] ?? []).some((fragment) =>
          !definitions.some((definition) => definition.includes(fragment.toLowerCase())))) {
      throw new PostgresSchemaContractError(
        "SCHEMA_CONTRACT_INVALID",
        `Postgres history rebuild ledger constraints are invalid for ${tableName}`,
      );
    }
  }
  const indexDefinitions: Readonly<Record<string, string>> = {
    mengshu_history_rebuild_shadow_disposition_idx:
      "run_id, source_table, disposition, record_id",
    mengshu_history_rebuild_operations_idx:
      "run_id, source_table, operation, created_at, receipt_hash",
    mengshu_history_rebuild_artifacts_source_idx:
      "run_id, source_table, record_id, artifact_type, artifact_role",
  };
  for (const indexName of HISTORY_REBUILD_LEDGER_REQUIRED_INDEXES) {
    const index = result.rows.find((row) => row.kind === "index" && row.object_name === indexName);
    const definition = typeof index?.definition === "string"
      ? index.definition.replace(/\s+/g, " ").toLowerCase() : "";
    if (!index || !asBoolean(index.is_valid) || !asBoolean(index.is_ready) ||
        !definition.includes(indexDefinitions[indexName]!)) {
      throw new PostgresSchemaContractError(
        "SCHEMA_CONTRACT_INVALID",
        `Postgres history rebuild ledger index is invalid: ${indexName}`,
      );
    }
  }
}

/** v24 model attempt reservations/results must be durable before any history model egress. */
export async function verifyHistoryRebuildModelAttemptSchemaCatalog(
  client: PostgresMigrationClient,
): Promise<void> {
  const tableName = "mengshu_history_rebuild_model_attempts";
  const result = await client.query(DURABLE_DOMAIN_SCHEMA_CATALOG_SQL, [[tableName]]);
  const expectedColumns = HISTORY_REBUILD_MODEL_ATTEMPT_REQUIRED_COLUMNS[tableName];
  const expectedTypes = HISTORY_REBUILD_MODEL_ATTEMPT_COLUMN_TYPES[tableName];
  const nullable = new Set([
    "output", "output_hash", "actual_input_tokens", "actual_output_tokens",
    "actual_cost_minor_units", "completed_at",
  ]);
  const columns = result.rows.filter((row) => row.kind === "column" && row.table_name === tableName);
  if (!sameColumns(columns.map((row) => row.object_name).sort(), [...expectedColumns].sort()) ||
      columns.some((row) => typeof row.object_name !== "string" ||
        row.definition !== expectedTypes[row.object_name as keyof typeof expectedTypes] ||
        row.is_nullable !== (nullable.has(row.object_name) ? "YES" : "NO"))) {
    throw new PostgresSchemaContractError(
      "SCHEMA_CONTRACT_INVALID",
      "Postgres history rebuild model attempt columns are invalid",
    );
  }
  const constraints = result.rows.filter((row) =>
    row.kind === "constraint" && row.table_name === tableName);
  const definitions = constraints.map((row) =>
    typeof row.definition === "string" ? row.definition.replace(/\s+/g, " ").toLowerCase() : "");
  if (constraints.some((row) => !asBoolean(row.is_valid)) ||
      HISTORY_REBUILD_MODEL_ATTEMPT_REQUIRED_CONSTRAINTS.some((fragment) =>
        !definitions.some((definition) => definition.includes(fragment.toLowerCase())))) {
    throw new PostgresSchemaContractError(
      "SCHEMA_CONTRACT_INVALID",
      "Postgres history rebuild model attempt constraints are invalid",
    );
  }
  const index = result.rows.find((row) =>
    row.kind === "index" && row.object_name === HISTORY_REBUILD_MODEL_ATTEMPT_REQUIRED_INDEX);
  const definition = typeof index?.definition === "string"
    ? index.definition.replace(/\s+/g, " ").toLowerCase() : "";
  if (!index || !asBoolean(index.is_valid) || !asBoolean(index.is_ready) ||
      !definition.includes("migration_id, manifest_hash, state")) {
    throw new PostgresSchemaContractError(
      "SCHEMA_CONTRACT_INVALID",
      "Postgres history rebuild model attempt index is invalid",
    );
  }
}

function assertContractMaintenance(options: ExecutePostgresMigrationsOptions): boolean {
  if (options.contractMigration === undefined) return false;
  const gate = options.contractMigration as {
    mode?: unknown;
    maintenance?: unknown;
    quiescenceConfirmed?: unknown;
  };
  if (gate.mode !== "apply" || gate.maintenance !== true || gate.quiescenceConfirmed !== true) {
    throw new PostgresSchemaContractError(
      "SCHEMA_MAINTENANCE_REQUIRED",
      "Postgres contract migration requires explicit maintenance mode and quiescence confirmation",
    );
  }
  return true;
}

/** Execute pending migrations atomically. Callers own connection acquisition. */
export async function executePostgresMigrations(
  client: PostgresMigrationClient,
  options: ExecutePostgresMigrationsOptions = {},
): Promise<ExecutePostgresMigrationsResult> {
  const migrations = options.migrations ?? SCHEMA_MIGRATIONS;
  const currentSchemaVersion = options.currentSchemaVersion ?? CURRENT_SCHEMA_VERSION;
  const applyContracts = assertContractMaintenance(options);

  await client.query("BEGIN");
  try {
    await client.query(LOCK_MIGRATIONS_SQL);
    await client.query(CREATE_MIGRATION_LEDGER_SQL);
    const ledgerResult = await client.query(READ_MIGRATIONS_SQL);
    const appliedBefore = asAppliedRows(ledgerResult.rows);
    const plan = planSchemaMigrations(appliedBefore, {
      migrations,
      currentSchemaVersion,
    });

    const appliedVersions: number[] = [];
    // Contract 是顺序 barrier：普通在线启动只执行它之前的 expand。
    // barrier 后的 v7+ expand 必须等 maintenance 应用 contract 后按版本顺序执行，
    // 这样 ledger 永远保持连续前缀，旧 runtime 再次启动也不会遇到稀疏版本。
    const contractBarrier = plan.pending.findIndex((migration) => migration.kind === "contract");
    const executable = applyContracts || contractBarrier < 0
      ? plan.pending
      : plan.pending.slice(0, contractBarrier);
    for (const migration of executable) {
      for (const statement of migration.statements) {
        await client.query(statement);
      }
      if (migration.version === 6) {
        await verifyAuthorityDedupeCatalog(client);
      }
      if (migration.version === 9) {
        await verifyDurableDomainSchemaCatalog(client);
      }
      if (migration.version === 10) {
        await verifyDurableJobStateSchemaCatalog(client);
      }
      if (migration.version === 11) {
        await verifyWriteJournalSchemaCatalog(client);
      }
      if (migration.version === 12) {
        await verifyEmbeddingReembedSchemaCatalog(client);
      }
      if (migration.version === 13) {
        await verifyWorkMemoryGraphSchemaCatalog(client);
      }
      if (migration.version === 14) {
        await verifyCandidateWriteJournalSchemaCatalog(client);
      }
      if (migration.version === 15) {
        await verifyEvidenceLinkLedgerSchemaCatalog(client);
      }
      if (migration.version === 16) {
        await verifyTopicTreeAliasSchemaCatalog(client);
      }
      if (migration.version === 17) {
        await verifyCanonicalEntityResolutionSchemaCatalog(client);
      }
      if (migration.version === 18) {
        await verifyAuthorityDedupeCatalog(client, 18);
      }
      if (migration.version === 20) {
        await verifyAssetLoadoutOverlaySchemaCatalog(client);
      }
      if (migration.version === 21) {
        await verifyLoadoutEventLedgerSchemaCatalog(client);
      }
      if (migration.version === 22) {
        await verifyContextAssemblyReceiptSchemaCatalog(client);
      }
      if (migration.version === 23) {
        await verifyHistoryRebuildLedgerSchemaCatalog(client);
      }
      if (migration.version === 24) {
        await verifyHistoryRebuildModelAttemptSchemaCatalog(client);
      }
      if (migration.version === 28) {
        await verifyTemporalOutboxSchemaCatalog(client);
      }
      if (migration.version === 37) {
        await verifyWriteJournalSchemaCatalog(client, { evolutionGovernance: true });
        await verifyEvidenceLinkLedgerSchemaCatalog(client, { evolutionGovernance: true });
        await verifyTemporalOutboxSchemaCatalog(client, { evolutionGovernance: true });
        await verifyEvolutionMemoryColumnsCatalog(client);
      }
      await client.query(INSERT_MIGRATION_SQL, [
        migration.version,
        migration.name,
        migration.checksum,
      ]);
      appliedVersions.push(migration.version);
    }

    const contractVersions = migrations
      .filter((migration) => migration.kind === "contract")
      .map((migration) => migration.version);
    const effectiveApplied = new Set([
      ...appliedBefore.map((migration) => migration.version),
      ...appliedVersions,
    ]);
    const pendingContractVersions = contractVersions.filter((version) => !effectiveApplied.has(version));
    if (!effectiveApplied.has(6)) {
      await verifyPendingGlobalDedupeCatalog(client);
    } else if (!appliedVersions.includes(6) && !appliedVersions.includes(18)) {
      // maintenance 内已在写 v6 ledger 前验证；后续每次启动仍复核物理 catalog，
      // 防止旧 binary 重新创建 global unique 后逻辑状态继续误报 ready。
      await verifyAuthorityDedupeCatalog(client, effectiveApplied.has(18) ? 18 : 6);
    }
    if (effectiveApplied.has(9) && !appliedVersions.includes(9)) {
      await verifyDurableDomainSchemaCatalog(client);
    }
    if (effectiveApplied.has(10) && !appliedVersions.includes(10)) {
      await verifyDurableJobStateSchemaCatalog(client);
    }
    if (effectiveApplied.has(11) && !appliedVersions.includes(11)) {
      await verifyWriteJournalSchemaCatalog(client, { evolutionGovernance: effectiveApplied.has(37) });
    }
    if (effectiveApplied.has(12) && !appliedVersions.includes(12)) {
      await verifyEmbeddingReembedSchemaCatalog(client);
    }
    if (effectiveApplied.has(13) && !appliedVersions.includes(13)) {
      await verifyWorkMemoryGraphSchemaCatalog(client);
    }
    if (effectiveApplied.has(14) && !appliedVersions.includes(14)) {
      await verifyCandidateWriteJournalSchemaCatalog(client);
    }
    if (effectiveApplied.has(15) && !appliedVersions.includes(15)) {
      await verifyEvidenceLinkLedgerSchemaCatalog(client, { evolutionGovernance: effectiveApplied.has(37) });
    }
    if (effectiveApplied.has(16) && !appliedVersions.includes(16)) {
      await verifyTopicTreeAliasSchemaCatalog(client);
    }
    if (effectiveApplied.has(17) && !appliedVersions.includes(17)) {
      await verifyCanonicalEntityResolutionSchemaCatalog(client);
    }
    if (effectiveApplied.has(20) && !appliedVersions.includes(20)) {
      await verifyAssetLoadoutOverlaySchemaCatalog(client, {
        governedDocumentKinds: effectiveApplied.has(26),
      });
    }
    if (effectiveApplied.has(21) && !appliedVersions.includes(21)) {
      await verifyLoadoutEventLedgerSchemaCatalog(client);
    }
    if (effectiveApplied.has(22) && !appliedVersions.includes(22)) {
      await verifyContextAssemblyReceiptSchemaCatalog(client);
    }
    if (effectiveApplied.has(23) && !appliedVersions.includes(23)) {
      await verifyHistoryRebuildLedgerSchemaCatalog(client);
    }
    if (effectiveApplied.has(24) && !appliedVersions.includes(24)) {
      await verifyHistoryRebuildModelAttemptSchemaCatalog(client);
    }
    if (effectiveApplied.has(28) && !appliedVersions.includes(28) && !appliedVersions.includes(37)) {
      await verifyTemporalOutboxSchemaCatalog(client, { evolutionGovernance: effectiveApplied.has(37) });
    }
    if (effectiveApplied.has(37) && !appliedVersions.includes(37)) {
      await verifyEvolutionMemoryColumnsCatalog(client);
    }

    await client.query("COMMIT");
    const toVersion = appliedVersions.at(-1) ?? plan.fromVersion;
    return {
      fromVersion: plan.fromVersion,
      toVersion,
      appliedVersions,
      pendingContractVersions,
      plan,
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Schema migration and rollback both failed");
    }
    throw error;
  }
}
