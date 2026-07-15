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

/** v6 ledger 只能在物理 catalog 与逻辑 contract 完全一致时写入。 */
export async function verifyAuthorityDedupeCatalog(
  client: PostgresMigrationClient,
): Promise<void> {
  const result = await client.query(AUTHORITY_DEDUPE_INDEX_CATALOG_SQL, [AUTHORITY_DEDUPE_TABLES]);
  for (const table of AUTHORITY_DEDUPE_TABLES) {
    const rows = result.rows.filter((row) => row.table_name === table);
    const expectedName = `${table}_authority_content_hash_uidx`;
    const expected = rows.find((row) => row.index_name === expectedName);
    if (!expected || !asBoolean(expected.is_unique) || !asBoolean(expected.is_valid) ||
        !asBoolean(expected.is_ready) || expected.predicate !== null ||
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
): Promise<void> {
  const tableNames = Object.keys(WRITE_JOURNAL_REQUIRED_COLUMNS);
  const result = await client.query(DURABLE_DOMAIN_SCHEMA_CATALOG_SQL, [tableNames]);
  for (const tableName of tableNames) {
    const expectedColumns = WRITE_JOURNAL_REQUIRED_COLUMNS[
      tableName as keyof typeof WRITE_JOURNAL_REQUIRED_COLUMNS
    ];
    const columnRows = result.rows.filter((row) =>
      row.kind === "column" && row.table_name === tableName);
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
    } else if (!appliedVersions.includes(6)) {
      // maintenance 内已在写 v6 ledger 前验证；后续每次启动仍复核物理 catalog，
      // 防止旧 binary 重新创建 global unique 后逻辑状态继续误报 ready。
      await verifyAuthorityDedupeCatalog(client);
    }
    if (effectiveApplied.has(9) && !appliedVersions.includes(9)) {
      await verifyDurableDomainSchemaCatalog(client);
    }
    if (effectiveApplied.has(10) && !appliedVersions.includes(10)) {
      await verifyDurableJobStateSchemaCatalog(client);
    }
    if (effectiveApplied.has(11) && !appliedVersions.includes(11)) {
      await verifyWriteJournalSchemaCatalog(client);
    }
    if (effectiveApplied.has(12) && !appliedVersions.includes(12)) {
      await verifyEmbeddingReembedSchemaCatalog(client);
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
