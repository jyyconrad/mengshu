import { describe, expect, test } from "vitest";
import {
  AUTHORITY_DEDUPE_INDEX_CATALOG_SQL,
  ASSET_LOADOUT_OVERLAY_REQUIRED_COLUMNS,
  CANONICAL_ENTITY_RESOLUTION_REQUIRED_COLUMNS,
  CANDIDATE_WRITE_JOURNAL_REQUIRED_COLUMNS,
  CONTEXT_ASSEMBLY_RECEIPT_REQUIRED_COLUMNS,
  EVIDENCE_LINK_LEDGER_REQUIRED_COLUMNS,
  LOADOUT_EVENT_LEDGER_REQUIRED_COLUMNS,
  TOPIC_TREE_ALIAS_REQUIRED_COLUMNS,
  DURABLE_JOB_STATE_SCHEMA_CATALOG_SQL,
  DURABLE_DOMAIN_REQUIRED_COLUMNS,
  DURABLE_DOMAIN_SCHEMA_CATALOG_SQL,
  EMBEDDING_REEMBED_REQUIRED_COLUMNS,
  WRITE_JOURNAL_REQUIRED_COLUMNS,
  WORK_MEMORY_GRAPH_REQUIRED_COLUMNS,
  HISTORY_REBUILD_LEDGER_REQUIRED_COLUMNS,
  HISTORY_REBUILD_MODEL_ATTEMPT_REQUIRED_COLUMNS,
  executePostgresMigrations,
  INSERT_MIGRATION_SQL,
  LOCK_MIGRATIONS_SQL,
  READ_MIGRATIONS_SQL,
  type PostgresMigrationClient,
  type PostgresQueryResult,
} from "./postgres-ledger.js";
import {
  CURRENT_SCHEMA_VERSION,
  SCHEMA_MIGRATIONS,
  type AppliedSchemaMigration,
  type SchemaMigration,
} from "./schema-migrations.js";

class FakePostgresClient implements PostgresMigrationClient {
  readonly calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  readonly applied: AppliedSchemaMigration[] = [];
  failWhenSqlIncludes?: string;
  private transactionApplied?: AppliedSchemaMigration[];
  catalogRows?: Record<string, unknown>[];
  domainCatalogRows?: Record<string, unknown>[];
  writeCatalogRows?: Record<string, unknown>[];
  embeddingCatalogRows?: Record<string, unknown>[];
  workMemoryCatalogRows?: Record<string, unknown>[];
  candidateWriteCatalogRows?: Record<string, unknown>[];
  evidenceLinkCatalogRows?: Record<string, unknown>[];
  topicTreeAliasCatalogRows?: Record<string, unknown>[];
  canonicalEntityResolutionCatalogRows?: Record<string, unknown>[];
  assetLoadoutCatalogRows?: Record<string, unknown>[];
  loadoutEventCatalogRows?: Record<string, unknown>[];
  contextAssemblyReceiptCatalogRows?: Record<string, unknown>[];
  historyRebuildLedgerCatalogRows?: Record<string, unknown>[];
  candidateWriteRouteValues?: readonly string[];
  jobStateCatalogRows?: Record<string, unknown>[];
  evolutionCatalogMutation?: (rows: Record<string, unknown>[]) => Record<string, unknown>[];

  private evolutionColumns(tableName: string): Record<string, unknown>[] {
    const applied = this.transactionApplied ?? this.applied;
    if (!applied.some(({ version }) => version === 37) && !this.calls.some(({ sql }) =>
      sql === "ALTER TABLE memories ADD COLUMN IF NOT EXISTS evolution_disputed BOOLEAN NOT NULL DEFAULT FALSE")) return [];
    const outbox = { evolution_consumed_at: ["bigint", "YES", null], evolution_origin: ["boolean", "NO", "false"] };
    const specs: Record<string, Record<string, unknown[]>> = {
      mengshu_write_outbox: outbox,
      mengshu_memory_version_outbox: outbox,
      memories: { evolution_review_due_at: ["bigint", "NO", "0"], evolution_disputed: ["boolean", "NO", "false"], evolution_alias_of: ["uuid", "YES", null] },
      mengshu_memory_evidence_links: {
        relation_state: ["text", "NO", "'effective'::text"], retired_at: ["bigint", "YES", null],
        ...Object.fromEntries(["root_evidence_id", "source_id", "source_revision", "source_current_revision", "source_hash", "source_kind", "source_record_id", "source_path_id", "source_span_id", "source_logical_file_id", "continuity_key", "independence_group_id"].map(name => [name, ["text", "YES", null]])),
      },
    };
    return Object.entries(specs[tableName] ?? {}).map(([object_name, [definition, is_nullable, default_definition]]) => ({
      kind: "column", table_name: tableName, object_name, definition, is_nullable, default_definition, is_valid: true, is_ready: true,
    }));
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    this.calls.push({ sql, params });
    if (this.failWhenSqlIncludes && sql.includes(this.failWhenSqlIncludes)) {
      throw new Error("fake migration failure");
    }
    if (sql === "BEGIN") {
      this.transactionApplied = [...this.applied];
    }
    if (sql === "COMMIT") {
      this.applied.splice(0, this.applied.length, ...(this.transactionApplied ?? this.applied));
      this.transactionApplied = undefined;
    }
    if (sql === "ROLLBACK") {
      this.transactionApplied = undefined;
    }
    if (sql === READ_MIGRATIONS_SQL) {
      const rows = this.transactionApplied ?? this.applied;
      return { rows: [...rows] as unknown as Row[], rowCount: rows.length };
    }
    if (sql === AUTHORITY_DEDUPE_INDEX_CATALOG_SQL) {
      const contractDdlApplied = this.calls.some(({ sql: callSql }) =>
        /CREATE UNIQUE INDEX memories_authority_content_hash_uidx/.test(callSql),
      );
      const activeMemoryDedupeApplied = this.calls.some(({ sql: callSql }) =>
        /CREATE UNIQUE INDEX memories_active_authority_content_hash_uidx/.test(callSql),
      );
      const rows = this.catalogRows ?? ["memories", "knowledge"].flatMap((table) => [
        {
          table_name: table, index_name: `${table}_pkey`, is_unique: true,
          is_valid: true, is_ready: true, predicate: null, index_columns: ["id"],
        },
        contractDdlApplied
          ? {
              table_name: table, index_name: `${table}_authority_content_hash_uidx`, is_unique: true,
              is_valid: true, is_ready: true,
              predicate: activeMemoryDedupeApplied && table === "memories"
                ? "(lifecycle_status = 'active'::text)"
                : null,
              index_columns: [
                "tenant_id", "user_id", "canonical_project_id", "product_id",
                "producer_id", "namespace", "visibility", "content_hash",
              ],
            }
          : {
              table_name: table, index_name: `${table}_content_hash_key`, is_unique: true,
              is_valid: true, is_ready: true, predicate: null, index_columns: ["content_hash"],
            },
      ]);
      return { rows: [...rows] as Row[], rowCount: rows.length };
    }
    if (sql === DURABLE_DOMAIN_SCHEMA_CATALOG_SQL) {
      const requestedTables = Array.isArray(params[0]) ? params[0] as string[] : [];
      if (requestedTables.includes("mengshu_memory_version_outbox") || requestedTables.includes("memories")) {
        const rows = requestedTables.flatMap(tableName => {
          const base = tableName === "mengshu_memory_version_outbox" ? Object.entries({
            event_id: "text", scope_fingerprint: "text", lineage_id: "text", revision: "integer",
            event_type: "text", payload: "jsonb", occurred_at: "bigint", published_at: "bigint",
          }).map(([object_name, definition]) => ({ kind: "column", table_name: tableName, object_name, definition,
            is_nullable: object_name === "published_at" ? "YES" : "NO", default_definition: null, is_valid: true, is_ready: true })) : [];
          return [...base, ...this.evolutionColumns(tableName)];
        });
        const catalogRows = this.evolutionCatalogMutation?.(rows) ?? rows;
        return { rows: catalogRows as Row[], rowCount: catalogRows.length };
      }
      if (requestedTables.includes("mengshu_history_rebuild_model_attempts")) {
        const nullable = new Set([
          "output", "output_hash", "actual_input_tokens", "actual_output_tokens",
          "actual_cost_minor_units", "completed_at",
        ]);
        const integerColumns = new Set([
          "attempt", "reserved_input_tokens", "reserved_output_tokens",
          "actual_input_tokens", "actual_output_tokens",
        ]);
        const bigintColumns = new Set([
          "reserved_cost_minor_units", "actual_cost_minor_units", "reserved_at", "completed_at",
        ]);
        const rows: Record<string, unknown>[] = Object.entries(
          HISTORY_REBUILD_MODEL_ATTEMPT_REQUIRED_COLUMNS,
        ).flatMap(([tableName, columns]) => columns.map((column) => ({
          kind: "column", table_name: tableName, object_name: column,
          definition: column === "record_id" ? "uuid"
            : integerColumns.has(column) ? "integer"
              : bigintColumns.has(column) ? "bigint"
                : column === "output" ? "jsonb" : "text",
          default_definition: null,
          is_nullable: nullable.has(column) ? "YES" : "NO",
          is_valid: true, is_ready: true,
        })));
        for (const definition of [
          "PRIMARY KEY (run_id, source_table, record_id, attempt)",
          "FOREIGN KEY (run_id) REFERENCES mengshu_history_rebuild_runs(run_id)",
          "CHECK (source_table = ANY)", "CHECK (state = ANY)",
          "CHECK (attempt >= 0 AND attempt < 2)",
          "CHECK ((state = 'reserved' AND output IS NULL) OR (state = 'completed' AND jsonb_typeof(output) = 'object' AND actual_input_tokens = reserved_input_tokens AND actual_output_tokens <= reserved_output_tokens AND actual_cost_minor_units <= reserved_cost_minor_units))",
        ]) rows.push({
          kind: "constraint", table_name: "mengshu_history_rebuild_model_attempts",
          object_name: `history_attempt_constraint_${rows.length}`, definition,
          is_nullable: null, is_valid: true, is_ready: true,
        });
        rows.push({
          kind: "index", table_name: "mengshu_history_rebuild_model_attempts",
          object_name: "mengshu_history_rebuild_model_attempts_budget_idx",
          definition: "CREATE INDEX mengshu_history_rebuild_model_attempts_budget_idx ON mengshu_history_rebuild_model_attempts USING btree (migration_id, manifest_hash, state)",
          is_nullable: null, is_valid: true, is_ready: true,
        });
        return { rows: rows as Row[], rowCount: rows.length };
      }
      if (requestedTables.includes("mengshu_history_rebuild_runs")) {
        const uuidColumns = new Set(["source_upper_bound", "after_id", "record_id"]);
        const bigintColumns = new Set([
          "created_at", "updated_at", "captured_at", "source_count",
          "checkpoint_version",
        ]);
        const integerColumns = new Set(["proposal_count", "input_tokens", "output_tokens"]);
        const jsonColumns = new Set([
          "counts", "topic_labels", "tree_eligibility", "source_row", "original_metadata",
        ]);
        const booleanColumns = new Set(["context_eligible"]);
        const nullable = new Set([
          "mengshu_history_rebuild_source_snapshots.source_upper_bound",
          "mengshu_history_rebuild_checkpoints.after_id",
          "mengshu_history_rebuild_source_rows.original_lifecycle_status",
          "mengshu_history_rebuild_shadow_plans.semantic_type",
          "mengshu_history_rebuild_operation_receipts.drift_hash",
        ]);
        const rows: Record<string, unknown>[] = Object.entries(
          HISTORY_REBUILD_LEDGER_REQUIRED_COLUMNS,
        ).flatMap(([tableName, columns]) => columns.map((column) => ({
          kind: "column", table_name: tableName, object_name: column,
          definition: uuidColumns.has(column) ? "uuid"
            : bigintColumns.has(column) ? "bigint"
              : integerColumns.has(column) ? "integer"
                : jsonColumns.has(column) ? "jsonb"
                  : booleanColumns.has(column) ? "boolean"
                    : column === "confidence" ? "double precision" : "text",
          default_definition: tableName === "mengshu_history_rebuild_runs" &&
              (column === "workspace_id" || column === "session_id") ? "''::text"
            : tableName === "mengshu_history_rebuild_checkpoints" &&
                column === "checkpoint_version" ? "0" : null,
          is_nullable: nullable.has(`${tableName}.${column}`) ? "YES" : "NO",
          is_valid: true, is_ready: true,
        })));
        const constraints: Record<string, readonly string[]> = {
          mengshu_history_rebuild_runs: [
            "PRIMARY KEY (run_id)", "UNIQUE (migration_id, scope_fingerprint, attempt_hash)",
            "CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$')", "CHECK (visibility = ANY)",
            "CHECK (state = ANY)",
          ],
          mengshu_history_rebuild_source_snapshots: [
            "PRIMARY KEY (run_id, source_table)",
            "FOREIGN KEY (run_id) REFERENCES mengshu_history_rebuild_runs(run_id)",
            "CHECK (source_table = ANY)",
            "CHECK (((source_count = 0) AND (source_upper_bound IS NULL)) OR (source_count > 0))",
          ],
          mengshu_history_rebuild_source_rows: [
            "PRIMARY KEY (run_id, source_table, record_id)",
            "UNIQUE (run_id, source_table, source_hash)",
            "FOREIGN KEY (run_id, source_table) REFERENCES mengshu_history_rebuild_source_snapshots(run_id, source_table)",
            "CHECK (source_table = ANY)",
            "CHECK (jsonb_typeof(source_row) = 'object')",
            "CHECK (jsonb_typeof(original_metadata) = 'object')",
          ],
          mengshu_history_rebuild_checkpoints: [
            "PRIMARY KEY (run_id, source_table)",
            "FOREIGN KEY (run_id, source_table) REFERENCES mengshu_history_rebuild_source_snapshots(run_id, source_table)",
            "CHECK (jsonb_typeof(counts) = 'object')", "CHECK (state = ANY)",
          ],
          mengshu_history_rebuild_shadow_plans: [
            "PRIMARY KEY (run_id, source_table, record_id)",
            "UNIQUE (run_id, plan_receipt_hash)",
            "FOREIGN KEY (run_id, source_table) REFERENCES mengshu_history_rebuild_source_snapshots(run_id, source_table)",
            "CHECK (disposition = ANY)", "CHECK (semantic_type IS NULL OR semantic_type = ANY)",
            "CHECK (jsonb_typeof(topic_labels) = 'array')",
            "CHECK (jsonb_typeof(tree_eligibility) = 'object')",
            "CHECK ((source_table <> 'knowledge') OR semantic_type = 'resource')",
          ],
          mengshu_history_rebuild_model_receipts: [
            "PRIMARY KEY (receipt_hash)", "UNIQUE (run_id, source_table, record_id)",
            "FOREIGN KEY (run_id, source_table, record_id) REFERENCES mengshu_history_rebuild_shadow_plans(run_id, source_table, record_id)",
            "CHECK (confidence >= 0)", "CHECK (confidence <= 1)",
          ],
          mengshu_history_rebuild_operation_receipts: [
            "PRIMARY KEY (receipt_hash)",
            "FOREIGN KEY (run_id) REFERENCES mengshu_history_rebuild_runs(run_id)",
            "CHECK (operation = ANY)", "CHECK (status = ANY)",
            "CHECK (jsonb_typeof(counts) = 'object')",
            "CHECK ((drift_hash IS NULL) OR (drift_hash ~ '^[0-9a-f]{64}$'))",
          ],
          mengshu_history_rebuild_artifacts: [
            "PRIMARY KEY (run_id, artifact_type, artifact_id)",
            "FOREIGN KEY (run_id, source_table, record_id) REFERENCES mengshu_history_rebuild_source_rows(run_id, source_table, record_id)",
            "CHECK (source_table = ANY)", "CHECK (artifact_type = ANY)",
            "CHECK (artifact_role = ANY)", "CHECK (source_hash ~ '^[0-9a-f]{64}$')",
            "CHECK (char_length(artifact_id) >= 1 AND char_length(artifact_id) <= 256)",
            "CHECK (artifact_id !~ '[[:space:][:cntrl:]]')",
          ],
        };
        for (const [tableName, definitions] of Object.entries(constraints)) {
          definitions.forEach((definition, index) => rows.push({
            kind: "constraint", table_name: tableName,
            object_name: `${tableName}_constraint_${index}`, definition,
            is_nullable: null, is_valid: true, is_ready: true,
          }));
        }
        for (const [indexName, definition] of [
          ["mengshu_history_rebuild_shadow_disposition_idx",
            "CREATE INDEX mengshu_history_rebuild_shadow_disposition_idx ON mengshu_history_rebuild_shadow_plans USING btree (run_id, source_table, disposition, record_id)"],
          ["mengshu_history_rebuild_operations_idx",
            "CREATE INDEX mengshu_history_rebuild_operations_idx ON mengshu_history_rebuild_operation_receipts USING btree (run_id, source_table, operation, created_at, receipt_hash)"],
          ["mengshu_history_rebuild_artifacts_source_idx",
            "CREATE INDEX mengshu_history_rebuild_artifacts_source_idx ON mengshu_history_rebuild_artifacts USING btree (run_id, source_table, record_id, artifact_type, artifact_role)"],
        ]) rows.push({
          kind: "index", table_name: "unused", object_name: indexName, definition,
          is_nullable: null, is_valid: true, is_ready: true,
        });
        const catalogRows = this.historyRebuildLedgerCatalogRows ?? rows;
        return { rows: catalogRows as Row[], rowCount: catalogRows.length };
      }
      if (requestedTables.includes("mengshu_context_assembly_receipts")) {
        const rows: Record<string, unknown>[] = Object.entries(
          CONTEXT_ASSEMBLY_RECEIPT_REQUIRED_COLUMNS,
        ).flatMap(([tableName, columns]) => columns.map((column) => ({
          kind: "column", table_name: tableName, object_name: column,
          definition: column === "receipt" ? "jsonb"
            : ["created_at", "expires_at"].includes(column) ? "bigint" : "text",
          default_definition: null, is_nullable: "NO", is_valid: true, is_ready: true,
        })));
        for (const definition of [
          "PRIMARY KEY (receipt_id)",
          "CHECK (receipt_id ~ '^[0-9a-f]{64}$')",
          "CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$')",
          "CHECK (stable_content_hash ~ '^[0-9a-f]{64}$')",
          "CHECK (dynamic_content_hash ~ '^[0-9a-f]{64}$')",
          "CHECK (jsonb_typeof(receipt) = 'object')",
          "CHECK (created_at >= 0)",
          "CHECK (expires_at >= created_at)",
          "CHECK (char_length(session_id) >= 1 AND char_length(session_id) <= 256 AND session_id !~ '[[:space:][:cntrl:]]')",
        ]) rows.push({
          kind: "constraint", table_name: "mengshu_context_assembly_receipts",
          object_name: `context_receipt_constraint_${rows.length}`, definition,
          is_nullable: null, is_valid: true, is_ready: true,
        });
        rows.push({
          kind: "index", table_name: "mengshu_context_assembly_receipts",
          object_name: "mengshu_context_assembly_receipts_session_idx",
          definition: "CREATE INDEX mengshu_context_assembly_receipts_session_idx ON mengshu_context_assembly_receipts USING btree (scope_fingerprint, session_id, created_at DESC, receipt_id DESC)",
          is_nullable: null, is_valid: true, is_ready: true,
        });
        const catalogRows = this.contextAssemblyReceiptCatalogRows ?? rows;
        return { rows: catalogRows as Row[], rowCount: catalogRows.length };
      }
      if (requestedTables.includes("mengshu_asset_versions") ||
          requestedTables.includes("mengshu_loadout_audit")) {
        const columns = requestedTables.includes("mengshu_loadout_audit")
          ? LOADOUT_EVENT_LEDGER_REQUIRED_COLUMNS
          : ASSET_LOADOUT_OVERLAY_REQUIRED_COLUMNS;
        const integerColumns = new Set(["version", "latest_version", "asset_version", "loadout_version"]);
        const bigintColumns = new Set(["audit_id", "created_at", "changed_at", "occurred_at", "published_at"]);
        const jsonColumns = new Set(["descriptor", "receipt", "payload"]);
        const rows: Record<string, unknown>[] = Object.entries(columns)
          .flatMap(([tableName, names]) => names.map((column) => ({
            kind: "column", table_name: tableName, object_name: column,
            definition: integerColumns.has(column) ? "integer"
              : bigintColumns.has(column) ? "bigint"
                : jsonColumns.has(column) ? "jsonb" : "text",
            default_definition: column === "audit_id"
              ? `nextval('${tableName}_audit_id_seq'::regclass)` : null,
            is_nullable: (column === "published_at" ||
              (tableName === "mengshu_loadout_versions" && column === "project_id")) ? "YES" : "NO",
            is_valid: true, is_ready: true,
          })));
        const governedDocumentKinds = this.calls.some(({ sql: callSql }) =>
          callSql.includes("ADD CONSTRAINT mengshu_asset_versions_kind_check") &&
          callSql.includes("'memory_document'"));
        const constraints: Record<string, readonly string[]> = requestedTables.includes("mengshu_loadout_audit")
          ? {
              mengshu_loadout_audit: [
                "PRIMARY KEY (audit_id)",
                "FOREIGN KEY (scope_fingerprint, loadout_id, loadout_version) REFERENCES mengshu_loadout_versions",
                "FOREIGN KEY (scope_fingerprint, request_key) REFERENCES mengshu_loadout_receipts",
                "CHECK (event_type = 'version_created')",
              ],
              mengshu_loadout_outbox: [
                "PRIMARY KEY (event_id)",
                "FOREIGN KEY (scope_fingerprint, loadout_id, loadout_version) REFERENCES mengshu_loadout_versions",
                "CHECK (event_type = 'loadout.version.created')",
                "CHECK (jsonb_typeof(payload) = 'object')",
              ],
            }
          : {
              mengshu_asset_versions: [
                "PRIMARY KEY (scope_fingerprint, asset_id, version)",
                governedDocumentKinds
                  ? "CHECK (kind = ANY (ARRAY['memory_view'::text, 'memory_document'::text, 'tree_document'::text, 'index_document'::text]))"
                  : "CHECK (kind = 'memory_view')",
                governedDocumentKinds
                  ? "CHECK (status = ANY (ARRAY['draft'::text, 'review'::text, 'published'::text, 'active'::text, 'deprecated'::text, 'revoked'::text]))"
                  : "CHECK (status = ANY)",
                "CHECK (visibility = 'private')", "CHECK (jsonb_typeof(descriptor) = 'object')",
              ],
              mengshu_asset_heads: [
                "PRIMARY KEY (scope_fingerprint, asset_id)",
                "FOREIGN KEY (scope_fingerprint, asset_id, latest_version) REFERENCES mengshu_asset_versions",
              ],
              mengshu_asset_promotion_receipts: [
                "PRIMARY KEY (receipt_id)", "UNIQUE (scope_fingerprint, request_key)",
                "FOREIGN KEY (scope_fingerprint, asset_id, asset_version) REFERENCES mengshu_asset_versions",
                "CHECK (jsonb_typeof(receipt) = 'object')",
              ],
              mengshu_asset_audit: [
                "PRIMARY KEY (audit_id)",
                "FOREIGN KEY (receipt_id) REFERENCES mengshu_asset_promotion_receipts",
                "FOREIGN KEY (scope_fingerprint, asset_id, asset_version) REFERENCES mengshu_asset_versions",
                "CHECK (event_type = ANY)",
              ],
              mengshu_asset_outbox: [
                "PRIMARY KEY (event_id)",
                "FOREIGN KEY (scope_fingerprint, asset_id, asset_version) REFERENCES mengshu_asset_versions",
                "CHECK (event_type = ANY)", "CHECK (jsonb_typeof(payload) = 'object')",
              ],
              mengshu_loadout_versions: [
                "PRIMARY KEY (scope_fingerprint, loadout_id, version)",
                "CHECK (visibility = 'private')", "CHECK (jsonb_typeof(descriptor) = 'object')",
              ],
              mengshu_loadout_heads: [
                "PRIMARY KEY (scope_fingerprint, loadout_id)",
                "FOREIGN KEY (scope_fingerprint, loadout_id, latest_version) REFERENCES mengshu_loadout_versions",
              ],
              mengshu_loadout_receipts: [
                "PRIMARY KEY (scope_fingerprint, request_key)",
                "FOREIGN KEY (scope_fingerprint, loadout_id, loadout_version) REFERENCES mengshu_loadout_versions",
                "CHECK (jsonb_typeof(receipt) = 'object')",
              ],
            };
        for (const [tableName, definitions] of Object.entries(constraints)) {
          definitions.forEach((definition, index) => rows.push({
            kind: "constraint", table_name: tableName,
            object_name: `${tableName}_constraint_${index}`, definition,
            is_nullable: null, is_valid: true, is_ready: true,
          }));
        }
        const indexes = requestedTables.includes("mengshu_loadout_audit")
          ? ["mengshu_loadout_outbox_pending_idx"]
          : ["mengshu_asset_versions_status_idx", "mengshu_asset_outbox_pending_idx",
              "mengshu_loadout_identity_idx"];
        for (const indexName of indexes) rows.push({
          kind: "index", table_name: "unused", object_name: indexName,
          definition: `CREATE INDEX ${indexName}${indexName.includes("outbox_pending")
            ? " WHERE (published_at IS NULL)" : ""}`,
          is_nullable: null, is_valid: true, is_ready: true,
        });
        const catalogRows = requestedTables.includes("mengshu_loadout_audit")
          ? this.loadoutEventCatalogRows ?? rows
          : this.assetLoadoutCatalogRows ?? rows;
        return { rows: catalogRows as Row[], rowCount: catalogRows.length };
      }
      if (requestedTables.includes("mengshu_graph_entity_resolution_ledger")) {
        const nullable = new Map<string, readonly string[]>([
          ["mengshu_graph_entity_alias_bindings", ["retired_at"]],
          ["mengshu_graph_entity_resolution_ledger", ["similarity", "rolled_back_at"]],
          ["mengshu_graph_relation_resolution_ledger", ["canonical_relation_id"]],
          ["mengshu_graph_entity_embeddings", []],
        ]);
        const typeFor = (column: string): string => {
          if (["created_at", "updated_at", "retired_at", "rolled_back_at"].includes(column)) {
            return "bigint";
          }
          if (column === "similarity") return "double precision";
          if (column === "can_rollback") return "boolean";
          if (["raw_entity", "observed_aliases", "raw_relation"].includes(column)) return "jsonb";
          if (column === "vector") return "vector";
          return "text";
        };
        const rows: Record<string, unknown>[] = Object.entries(
          CANONICAL_ENTITY_RESOLUTION_REQUIRED_COLUMNS,
        ).flatMap(([tableName, columns]) => columns.map((column) => ({
          kind: "column", table_name: tableName, object_name: column,
          definition: typeFor(column),
          default_definition: column === "workspace_id" || column === "session_id"
            ? "''::text" : null,
          is_nullable: nullable.get(tableName)?.includes(column) ? "YES" : "NO",
          is_valid: true, is_ready: true,
        })));
        const constraints: Record<string, readonly string[]> = {
          mengshu_graph_entity_alias_bindings: [
            "PRIMARY KEY (alias_binding_id)",
            "FOREIGN KEY (scope_fingerprint, canonical_entity_id) REFERENCES mengshu_graph_entities(scope_fingerprint, id)",
            "CHECK (status = ANY (ARRAY['active', 'retired']))",
          ],
          mengshu_graph_entity_resolution_ledger: [
            "PRIMARY KEY (resolution_id)",
            "FOREIGN KEY (job_id) REFERENCES mengshu_jobs_v2(id)",
            "FOREIGN KEY (scope_fingerprint, canonical_entity_id) REFERENCES mengshu_graph_entities(scope_fingerprint, id)",
            "UNIQUE (scope_fingerprint, job_id, evidence_memory_id, raw_entity_id)",
            "CHECK (method = ANY (ARRAY['exact', 'alias', 'semantic', 'create']))",
            "CHECK (status = ANY (ARRAY['applied', 'rolled_back']))",
            "CHECK (jsonb_typeof(raw_entity) = 'object')",
            "CHECK (jsonb_typeof(observed_aliases) = 'array')",
            "CHECK (((method = 'semantic') AND similarity IS NOT NULL AND can_rollback = true) OR ((method <> 'semantic') AND similarity IS NULL AND can_rollback = false))",
          ],
          mengshu_graph_relation_resolution_ledger: [
            "PRIMARY KEY (resolution_id)",
            "FOREIGN KEY (job_id) REFERENCES mengshu_jobs_v2(id)",
            "FOREIGN KEY (scope_fingerprint, canonical_relation_id) REFERENCES mengshu_graph_relations(scope_fingerprint, id)",
            "FOREIGN KEY (scope_fingerprint, canonical_subject_id) REFERENCES mengshu_graph_entities(scope_fingerprint, id)",
            "FOREIGN KEY (scope_fingerprint, canonical_object_id) REFERENCES mengshu_graph_entities(scope_fingerprint, id)",
            "UNIQUE (scope_fingerprint, job_id, evidence_memory_id, raw_relation_id)",
            "CHECK (outcome = ANY (ARRAY['canonicalized', 'dropped_self']))",
            "CHECK (jsonb_typeof(raw_relation) = 'object')",
            "CHECK (((outcome = 'canonicalized') AND canonical_relation_id IS NOT NULL AND canonical_subject_id <> canonical_object_id) OR ((outcome = 'dropped_self') AND canonical_relation_id IS NULL AND canonical_subject_id = canonical_object_id))",
          ],
          mengshu_graph_entity_embeddings: [
            "PRIMARY KEY (scope_fingerprint, entity_id, embedding_space_id)",
            "FOREIGN KEY (scope_fingerprint, entity_id) REFERENCES mengshu_graph_entities(scope_fingerprint, id)",
            "FOREIGN KEY (embedding_space_id) REFERENCES mengshu_embedding_spaces(embedding_space_id)",
            "CHECK (embedding_space_state = ANY (ARRAY['known-queryable', 'unknown-unqueryable']))",
          ],
        };
        for (const [tableName, definitions] of Object.entries(constraints)) {
          definitions.forEach((definition, index) => rows.push({
            kind: "constraint", table_name: tableName,
            object_name: `${tableName}_constraint_${index}`, definition,
            is_nullable: null, is_valid: true, is_ready: true,
          }));
        }
        for (const indexName of [
          "mengshu_graph_entity_alias_bindings_active_uidx",
          "mengshu_graph_entity_alias_bindings_entity_idx",
          "mengshu_graph_entity_resolution_scope_evidence_idx",
          "mengshu_graph_entity_resolution_rollback_idx",
          "mengshu_graph_relation_resolution_scope_evidence_idx",
          "mengshu_graph_entity_embeddings_queryable_idx",
        ]) rows.push({
          kind: "index", table_name: "unused", object_name: indexName,
          definition: indexName === "mengshu_graph_entity_alias_bindings_active_uidx"
            ? `CREATE UNIQUE INDEX ${indexName} ON mengshu_graph_entity_alias_bindings USING btree (scope_fingerprint, entity_type, normalized_alias) WHERE (status = 'active'::text)`
            : indexName === "mengshu_graph_entity_embeddings_queryable_idx"
              ? `CREATE INDEX ${indexName} ON mengshu_graph_entity_embeddings USING btree (scope_fingerprint, entity_type, embedding_space_id, entity_id) WHERE (embedding_space_state = 'known-queryable'::text)`
              : `CREATE INDEX ${indexName}`,
          is_nullable: null, is_valid: true, is_ready: true,
        });
        const catalogRows = this.canonicalEntityResolutionCatalogRows ?? rows;
        return { rows: catalogRows as Row[], rowCount: catalogRows.length };
      }
      if (requestedTables.includes("mengshu_topic_tree_aliases")) {
        const rows: Record<string, unknown>[] = Object.entries(TOPIC_TREE_ALIAS_REQUIRED_COLUMNS)
          .flatMap(([tableName, columns]) => columns.map((column) => ({
            kind: "column", table_name: tableName, object_name: column,
            definition: column === "merged_from" ? "jsonb" :
              ["created_at", "updated_at", "superseded_at", "archived_at"].includes(column)
                ? "bigint" : "text",
            default_definition: column === "workspace_id" || column === "session_id"
              ? "''::text"
              : column === "status"
                ? "'active'::text"
                : null,
            is_nullable: ["sealed_node_id", "superseded_at", "archived_at"].includes(column)
              ? "YES" : "NO",
            is_valid: true, is_ready: true,
          })));
        for (const definition of [
          "PRIMARY KEY (scope_fingerprint, legacy_tree_key)",
          "CHECK (status = ANY (ARRAY['active', 'superseded', 'archived']))",
          "CHECK (jsonb_typeof(merged_from) = 'array')",
          "CHECK (merged_from @> jsonb_build_array(legacy_tree_key))",
        ]) rows.push({
          kind: "constraint", table_name: "mengshu_topic_tree_aliases",
          object_name: `alias_constraint_${rows.length}`, definition,
          is_nullable: null, is_valid: true, is_ready: true,
        });
        for (const indexName of [
          "mengshu_topic_tree_aliases_scope_canonical_idx",
          "mengshu_topic_tree_aliases_scope_status_idx",
        ]) rows.push({
          kind: "index", table_name: "mengshu_topic_tree_aliases",
          object_name: indexName, definition: `CREATE INDEX ${indexName}`,
          is_nullable: null, is_valid: true, is_ready: true,
        });
        const catalogRows = this.topicTreeAliasCatalogRows ?? rows;
        return { rows: catalogRows as Row[], rowCount: catalogRows.length };
      }
      if (requestedTables.includes("mengshu_memory_evidence_links")) {
        const rows: Record<string, unknown>[] = Object.entries(EVIDENCE_LINK_LEDGER_REQUIRED_COLUMNS)
          .flatMap(([tableName, columns]) => columns.map((column) => ({
            kind: "column", table_name: tableName, object_name: column,
            definition: column === "created_at" ? "bigint" : "text",
            default_definition: column === "workspace_id" || column === "session_id"
              ? "''::text"
              : null,
            is_nullable: "NO", is_valid: true, is_ready: true,
          })));
        const constraints: Record<string, readonly string[]> = {
          mengshu_memory_evidence_links: [
            "PRIMARY KEY (link_id)",
            "UNIQUE (scope_fingerprint, target_memory_id, evidence_memory_id, link_kind, source)",
            "CHECK (link_kind = ANY (ARRAY['grounded_by', 'duplicate_evidence', 'supersession_evidence', 'conflict_evidence']))",
          ],
          mengshu_graph_entity_evidence: [
            "PRIMARY KEY (link_id)",
            "FOREIGN KEY (scope_fingerprint, entity_id) REFERENCES mengshu_graph_entities(scope_fingerprint, id)",
            "UNIQUE (scope_fingerprint, entity_id, evidence_memory_id, source_id, source_kind)",
          ],
          mengshu_graph_relation_evidence: [
            "PRIMARY KEY (link_id)",
            "FOREIGN KEY (scope_fingerprint, relation_id) REFERENCES mengshu_graph_relations(scope_fingerprint, id)",
            "UNIQUE (scope_fingerprint, relation_id, evidence_memory_id, source_id, source_kind)",
          ],
          mengshu_graph_entity_aliases: [
            "PRIMARY KEY (alias_id)",
            "FOREIGN KEY (scope_fingerprint, entity_id) REFERENCES mengshu_graph_entities(scope_fingerprint, id)",
            "UNIQUE (scope_fingerprint, entity_id, normalized_alias)",
          ],
        };
        for (const [tableName, definitions] of Object.entries(constraints)) {
          definitions.forEach((definition, index) => rows.push({
            kind: "constraint", table_name: tableName,
            object_name: `${tableName}_constraint_${index}`, definition,
            is_nullable: null, is_valid: true, is_ready: true,
          }));
        }
        for (const indexName of [
          "mengshu_memory_evidence_links_scope_target_idx",
          "mengshu_graph_entity_evidence_scope_evidence_idx",
          "mengshu_graph_relation_evidence_scope_evidence_idx",
          "mengshu_graph_entity_aliases_scope_alias_idx",
        ]) {
          rows.push({
            kind: "index", table_name: "unused", object_name: indexName,
            definition: `CREATE INDEX ${indexName}`, is_nullable: null,
            is_valid: true, is_ready: true,
          });
        }
        rows.push(...this.evolutionColumns("mengshu_memory_evidence_links"));
        const catalogRows = this.evidenceLinkCatalogRows ?? this.evolutionCatalogMutation?.(rows) ?? rows;
        return { rows: catalogRows as Row[], rowCount: catalogRows.length };
      }
      if (requestedTables.includes("mengshu_candidate_write_receipts")) {
        const timestampColumns = new Set(["created_at", "occurred_at", "published_at"]);
        const routeValues = this.candidateWriteRouteValues ?? ["candidate_low_priority", "candidate"];
        const routeConstraint = `CHECK (route = ANY (ARRAY[${routeValues
          .map((route) => `'${route}'`)
          .join(", ")}]))`;
        const rows: Record<string, unknown>[] = Object.entries(CANDIDATE_WRITE_JOURNAL_REQUIRED_COLUMNS)
          .flatMap(([tableName, columns]) => columns.map((column) => ({
            kind: "column",
            table_name: tableName,
            object_name: column,
            definition: column === "audit_id"
              ? "bigint"
              : column === "result"
                ? "jsonb"
                : timestampColumns.has(column)
                  ? "timestamp with time zone"
                  : "text",
            default_definition: column === "audit_id"
              ? "nextval('mengshu_candidate_write_audit_audit_id_seq'::regclass)"
              : tableName === "mengshu_candidate_write_receipts" && column === "created_at"
                ? "now()"
                : column === "workspace_id" || column === "session_id"
                  ? "''::text"
                  : null,
            is_nullable: tableName === "mengshu_candidate_write_outbox" && column === "published_at"
              ? "YES"
              : "NO",
            is_valid: true,
            is_ready: true,
          })));
        const constraints: Record<string, readonly string[]> = {
          mengshu_candidate_write_receipts: [
            "PRIMARY KEY (storage_key)",
            "FOREIGN KEY (candidate_id) REFERENCES mengshu_candidates(id)",
            "CHECK (storage_key ~ '^[0-9a-f]{64}$')",
            "CHECK (request_fingerprint ~ '^[0-9a-f]{64}$')",
            "CHECK (visibility = ANY (ARRAY['private', 'workspace', 'team', 'public']))",
            routeConstraint,
            "CHECK (jsonb_typeof(result) = 'object')",
          ],
          mengshu_candidate_write_audit: [
            "PRIMARY KEY (audit_id)",
            "FOREIGN KEY (candidate_id) REFERENCES mengshu_candidates(id)",
            "UNIQUE (storage_key, candidate_id, action)",
            "CHECK (storage_key ~ '^[0-9a-f]{64}$')",
            "CHECK (request_fingerprint ~ '^[0-9a-f]{64}$')",
            "CHECK (action = 'candidate.store')",
            "CHECK (visibility = ANY (ARRAY['private', 'workspace', 'team', 'public']))",
            routeConstraint,
          ],
          mengshu_candidate_write_outbox: [
            "PRIMARY KEY (event_id)",
            "FOREIGN KEY (candidate_id) REFERENCES mengshu_candidates(id)",
            "UNIQUE (storage_key, topic, candidate_id)",
            "CHECK (event_id ~ '^[0-9a-f]{64}$')",
            "CHECK (storage_key ~ '^[0-9a-f]{64}$')",
            "CHECK (request_fingerprint ~ '^[0-9a-f]{64}$')",
            "CHECK (topic = 'candidate.written')",
            "CHECK (visibility = ANY (ARRAY['private', 'workspace', 'team', 'public']))",
            routeConstraint,
          ],
        };
        for (const [tableName, definitions] of Object.entries(constraints)) {
          definitions.forEach((definition, index) => rows.push({
            kind: "constraint",
            table_name: tableName,
            object_name: `${tableName}_constraint_${index}`,
            definition,
            is_nullable: null,
            is_valid: true,
            is_ready: true,
          }));
        }
        for (const indexName of [
          "mengshu_candidate_write_audit_scope_candidate_idx",
          "mengshu_candidate_write_outbox_pending_idx",
          "mengshu_candidate_write_receipts_created_idx",
        ]) {
          rows.push({
            kind: "index",
            table_name: "unused",
            object_name: indexName,
            definition: `CREATE INDEX ${indexName}`,
            is_nullable: null,
            is_valid: true,
            is_ready: true,
          });
        }
        const catalogRows = this.candidateWriteCatalogRows ?? rows;
        return { rows: catalogRows as Row[], rowCount: catalogRows.length };
      }
      if (requestedTables.includes("mengshu_work_memory_nodes")) {
        const nullable = new Map<string, readonly string[]>([
          ["mengshu_work_memory_nodes", [
            "evidence_kind", "semantic_type", "lifecycle_status", "tree_type", "level",
            "skill_candidate_status", "updated_at",
          ]],
          ["mengshu_work_memory_edges", ["reason", "updated_at"]],
        ]);
        const rows: Record<string, unknown>[] = Object.entries(WORK_MEMORY_GRAPH_REQUIRED_COLUMNS)
          .flatMap(([tableName, columns]) => columns.map((column) => ({
            kind: "column", table_name: tableName, object_name: column,
            definition: column === "scope_fingerprint" ? "text" : "text",
            default_definition: null,
            is_nullable: nullable.get(tableName)?.includes(column) ? "YES" : "NO",
            is_valid: true, is_ready: true,
          })));
        const constraints: Record<string, readonly string[]> = {
          mengshu_work_memory_nodes: [
            "PRIMARY KEY (scope_fingerprint, id)",
            "UNIQUE (scope_fingerprint, node_type, record_id)",
            "CHECK (node_type = ANY (ARRAY['evidence', 'memory', 'summary', 'skill_candidate']))",
          ],
          mengshu_work_memory_edges: [
            "PRIMARY KEY (scope_fingerprint, id)",
            "FOREIGN KEY (scope_fingerprint, source_id) REFERENCES mengshu_work_memory_nodes(scope_fingerprint, id)",
            "FOREIGN KEY (scope_fingerprint, target_id) REFERENCES mengshu_work_memory_nodes(scope_fingerprint, id)",
            "CHECK (predicate = ANY (ARRAY['grounded_by', 'derives_from', 'contradicts', 'supersedes', 'promoted_to']))",
          ],
        };
        for (const [tableName, definitions] of Object.entries(constraints)) {
          definitions.forEach((definition, index) => rows.push({
            kind: "constraint", table_name: tableName,
            object_name: `${tableName}_constraint_${index}`, definition,
            is_nullable: null, is_valid: true, is_ready: true,
          }));
        }
        for (const indexName of [
          "mengshu_work_memory_nodes_scope_type_idx",
          "mengshu_work_memory_edges_scope_source_idx",
          "mengshu_work_memory_edges_scope_target_idx",
        ]) {
          rows.push({
            kind: "index", table_name: "unused", object_name: indexName,
            definition: `CREATE INDEX ${indexName}`, is_nullable: null,
            is_valid: true, is_ready: true,
          });
        }
        const catalogRows = this.workMemoryCatalogRows ?? rows;
        return { rows: catalogRows as Row[], rowCount: catalogRows.length };
      }
      if (requestedTables.includes("mengshu_embedding_reembed_shadow")) {
        const nullable = new Map<string, readonly string[]>([
          ["mengshu_embedding_spaces", ["queryability_state"]],
          ["mengshu_embedding_reembed_shadow", ["old_embedding_space_id", "old_embedding_space_state"]],
          ["mengshu_embedding_reembed_receipts", []],
        ]);
        const typeFor = (column: string): string => {
          if (column === "dimensions") return "integer";
          if (column === "record_id") return "uuid";
          if (column === "old_vector") return "vector";
          if (column === "old_metadata") return "jsonb";
          if (column === "created_at" || column === "captured_at") return "timestamp with time zone";
          return "text";
        };
        const rows: Record<string, unknown>[] = Object.entries(EMBEDDING_REEMBED_REQUIRED_COLUMNS)
          .flatMap(([tableName, columns]) => columns.map((column) => ({
            kind: "column", table_name: tableName, object_name: column,
            definition: typeFor(column),
            default_definition: column === "created_at" || column === "captured_at" ? "now()" : null,
            is_nullable: nullable.get(tableName)?.includes(column) ? "YES" : "NO",
            is_valid: true, is_ready: true,
          })));
        const constraints: Record<string, readonly string[]> = {
          mengshu_embedding_spaces: [
            "PRIMARY KEY (embedding_space_id)",
            "CHECK (queryability_state IS NULL OR queryability_state = ANY (ARRAY['known-queryable', 'unknown-unqueryable']))",
          ],
          mengshu_embedding_reembed_shadow: [
            "PRIMARY KEY (migration_id, table_name, record_id)",
            "CHECK (table_name = ANY (ARRAY['memories', 'knowledge']))",
            "CHECK (jsonb_typeof(old_metadata) = 'object')",
          ],
          mengshu_embedding_reembed_receipts: [
            "PRIMARY KEY (receipt_id)",
            "UNIQUE (migration_id, table_name, record_id, operation)",
            "CHECK (operation = ANY (ARRAY['validated', 'applied', 'rolled-back']))",
            "FOREIGN KEY (target_embedding_space_id) REFERENCES mengshu_embedding_spaces(embedding_space_id)",
          ],
        };
        for (const [tableName, definitions] of Object.entries(constraints)) {
          definitions.forEach((definition, index) => rows.push({
            kind: "constraint", table_name: tableName,
            object_name: `${tableName}_constraint_${index}`, definition,
            is_nullable: null, is_valid: true, is_ready: true,
          }));
        }
        for (const indexName of [
          "mengshu_embedding_spaces_queryability_idx",
          "mengshu_embedding_reembed_shadow_record_idx",
          "mengshu_embedding_reembed_receipts_migration_idx",
        ]) {
          rows.push({
            kind: "index", table_name: "unused", object_name: indexName,
            definition: `CREATE INDEX ${indexName}`, is_nullable: null,
            is_valid: true, is_ready: true,
          });
        }
        const catalogRows = this.embeddingCatalogRows ?? rows;
        return { rows: catalogRows as Row[], rowCount: catalogRows.length };
      }
      if (requestedTables.includes("mengshu_write_receipts")) {
        const timestampColumns = new Set(["created_at", "occurred_at", "published_at"]);
        const rows: Record<string, unknown>[] = Object.entries(WRITE_JOURNAL_REQUIRED_COLUMNS)
          .flatMap(([tableName, columns]) => columns.map((column) => ({
            kind: "column",
            table_name: tableName,
            object_name: column,
            definition: column === "audit_id"
              ? "bigint"
              : column === "result"
                ? "jsonb"
                : timestampColumns.has(column)
                  ? "timestamp with time zone"
                  : "text",
            default_definition: column === "audit_id"
              ? "nextval('mengshu_write_audit_audit_id_seq'::regclass)"
              : tableName === "mengshu_write_receipts" && column === "created_at"
                ? "now()"
                : (tableName === "mengshu_write_audit" || tableName === "mengshu_write_outbox") &&
                    (column === "workspace_id" || column === "session_id")
                  ? "''::text"
                  : null,
            is_nullable: tableName === "mengshu_write_outbox" && column === "published_at"
              ? "YES"
              : "NO",
            is_valid: true,
            is_ready: true,
          })));
        const constraints: Record<string, readonly string[]> = {
          mengshu_write_receipts: ["PRIMARY KEY (storage_key)"],
          mengshu_write_audit: [
            "UNIQUE (storage_key, memory_id, action)",
            "CHECK (action = 'memory.store')",
          ],
          mengshu_write_outbox: [
            "PRIMARY KEY (event_id)",
            "UNIQUE (storage_key, topic, memory_id)",
            "CHECK (topic = 'memory.written')",
          ],
        };
        for (const [tableName, definitions] of Object.entries(constraints)) {
          definitions.forEach((definition, index) => rows.push({
            kind: "constraint",
            table_name: tableName,
            object_name: `${tableName}_constraint_${index}`,
            definition,
            is_nullable: null,
            is_valid: true,
            is_ready: true,
          }));
        }
        for (const indexName of [
          "mengshu_write_audit_scope_memory_idx",
          "mengshu_write_outbox_pending_idx",
          "mengshu_write_receipts_created_idx",
        ]) {
          rows.push({
            kind: "index",
            table_name: indexName.split("_idx")[0],
            object_name: indexName,
            definition: `CREATE INDEX ${indexName}`,
            is_nullable: null,
            is_valid: true,
            is_ready: true,
          });
        }
        rows.push(...this.evolutionColumns("mengshu_write_outbox"));
        const writeRows = this.writeCatalogRows ?? this.evolutionCatalogMutation?.(rows) ?? rows;
        return { rows: writeRows as Row[], rowCount: writeRows.length };
      }
      const nullable = new Map<string, readonly string[]>([
        ["mengshu_tree_leaves", []],
        ["mengshu_tree_buffers", ["seal_after_at"]],
        ["mengshu_tree_summary_nodes", ["sealed_at"]],
        ["mengshu_graph_entities", ["last_seen_at", "graph_centrality", "merged_into"]],
        ["mengshu_graph_relations", []],
      ]);
      const rows: Record<string, unknown>[] = Object.entries(DURABLE_DOMAIN_REQUIRED_COLUMNS)
        .flatMap(([tableName, columns]) => columns.map((column) => ({
          kind: "column",
          table_name: tableName,
          object_name: column,
          definition: "text",
          is_nullable: nullable.get(tableName)?.includes(column) ? "YES" : "NO",
          is_valid: true,
          is_ready: true,
        })));
      const constraints: Record<string, readonly string[]> = {
        mengshu_tree_leaves: [
          "PRIMARY KEY (scope_fingerprint, id)",
          "FOREIGN KEY (source_job_id) REFERENCES mengshu_jobs_v2(id)",
        ],
        mengshu_tree_buffers: [
          "PRIMARY KEY (scope_fingerprint, id)",
          "UNIQUE (scope_fingerprint, tree_type, tree_key, level)",
        ],
        mengshu_tree_summary_nodes: [
          "PRIMARY KEY (scope_fingerprint, id)",
          "FOREIGN KEY (sealed_by_job_id) REFERENCES mengshu_jobs_v2(id)",
        ],
        mengshu_graph_entities: [
          "PRIMARY KEY (scope_fingerprint, id)",
          "UNIQUE (scope_fingerprint, entity_type, canonical_name)",
          "FOREIGN KEY (scope_fingerprint, merged_into) REFERENCES mengshu_graph_entities(scope_fingerprint, id)",
        ],
        mengshu_graph_relations: [
          "PRIMARY KEY (scope_fingerprint, id)",
          "FOREIGN KEY (scope_fingerprint, subject_id) REFERENCES mengshu_graph_entities(scope_fingerprint, id)",
          "FOREIGN KEY (scope_fingerprint, object_id) REFERENCES mengshu_graph_entities(scope_fingerprint, id)",
          "CHECK (evidence_count = jsonb_array_length(evidence_chunk_ids))",
        ],
      };
      for (const [tableName, definitions] of Object.entries(constraints)) {
        definitions.forEach((definition, index) => rows.push({
          kind: "constraint",
          table_name: tableName,
          object_name: `${tableName}_constraint_${index}`,
          definition,
          is_nullable: null,
          is_valid: true,
          is_ready: true,
        }));
      }
      for (const indexName of [
        "mengshu_tree_leaves_scope_event_idx",
        "mengshu_tree_summary_scope_idx",
        "mengshu_graph_entities_scope_name_idx",
        "mengshu_graph_relations_scope_subject_idx",
        "mengshu_graph_relations_scope_object_idx",
      ]) {
        rows.push({
          kind: "index",
          table_name: indexName.split("_scope_")[0],
          object_name: indexName,
          definition: `CREATE INDEX ${indexName}`,
          is_nullable: null,
          is_valid: true,
          is_ready: true,
        });
      }
      const domainRows = this.domainCatalogRows ?? rows;
      return { rows: domainRows as Row[], rowCount: domainRows.length };
    }
    if (sql === DURABLE_JOB_STATE_SCHEMA_CATALOG_SQL) {
      const rows = this.jobStateCatalogRows ?? [{
        constraint_name: "mengshu_jobs_v2_state_check",
        definition: "CHECK ((status = 'queued') OR (status = 'running' AND char_length(lease_token) >= 32 AND char_length(lease_token) <= 256 AND lease_token ~ '^[A-Za-z0-9._~-]+$') OR (status = 'retry_wait') OR (status = 'completed') OR (status = 'dead_letter'))",
        is_valid: true,
      }];
      return { rows: rows as Row[], rowCount: rows.length };
    }
    if (sql === INSERT_MIGRATION_SQL) {
      const target = this.transactionApplied ?? this.applied;
      target.push({
        version: Number(params[0]),
        name: String(params[1]),
        checksum: String(params[2]),
      });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

describe("executePostgresMigrations", () => {
  test("catalog UNION 将 column type 显式抬升为 text，禁止 PostgreSQL 把长 CHECK definition 截断", () => {
    expect(DURABLE_DOMAIN_SCHEMA_CATALOG_SQL).toContain(
      "(CASE WHEN data_type = 'USER-DEFINED' THEN udt_name ELSE data_type END)::text AS definition",
    );
  });

  test("默认启动在 v6 contract barrier 停止，v7/v8 expand 延迟到 maintenance", async () => {
    const client = new FakePostgresClient();

    const result = await executePostgresMigrations(client);

    expect(result.appliedVersions).toEqual([1, 2, 3, 4, 5]);
    expect(result.toVersion).toBe(5);
    expect(result.pendingContractVersions).toEqual([6, 10, 18, 26]);
    expect(client.calls[0]?.sql).toBe("BEGIN");
    expect(client.calls.at(-1)?.sql).toBe("COMMIT");
    expect(client.calls.findIndex((call) => call.sql === LOCK_MIGRATIONS_SQL)).toBeLessThan(
      client.calls.findIndex((call) => call.sql === READ_MIGRATIONS_SQL),
    );
    expect(client.calls.filter((call) => call.sql === INSERT_MIGRATION_SQL)).toHaveLength(
      5,
    );
    expect(client.applied).toEqual(
      SCHEMA_MIGRATIONS.slice(0, 5).map(({ version, name, checksum }) => ({ version, name, checksum })),
    );
    expect(client.calls.some(({ sql }) => sql.includes("mengshu_job_v2_effect_receipts"))).toBe(false);
    expect(client.calls.some(({ sql }) => sql.includes("mengshu_candidates"))).toBe(false);
    expect(client.calls.some(({ sql }) => sql.includes("scope-content-hash-dedupe"))).toBe(false);
  });

  test("显式 maintenance + quiescence 才执行 v6，并在写 ledger 前验证 catalog", async () => {
    const client = new FakePostgresClient();
    await executePostgresMigrations(client);

    const result = await executePostgresMigrations(client, {
      contractMigration: { mode: "apply", maintenance: true, quiescenceConfirmed: true },
    });

    expect(result.appliedVersions).toEqual(
      Array.from({ length: CURRENT_SCHEMA_VERSION - 5 }, (_, index) => index + 6),
    );
    expect(result.toVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(result.pendingContractVersions).toEqual([]);
    const catalogIndex = client.calls.findIndex(({ sql }) => sql === AUTHORITY_DEDUPE_INDEX_CATALOG_SQL);
    const ledgerIndex = client.calls.findIndex(({ sql, params }) => sql === INSERT_MIGRATION_SQL && params[0] === 6);
    expect(catalogIndex).toBeGreaterThan(-1);
    expect(catalogIndex).toBeLessThan(ledgerIndex);
  });

  test("contract apply 缺少 maintenance/quiescence 任一确认均 fail-closed 且不执行 v6", async () => {
    const client = new FakePostgresClient();
    await executePostgresMigrations(client);

    await expect(executePostgresMigrations(client, {
      contractMigration: { mode: "apply", maintenance: false, quiescenceConfirmed: true } as never,
    })).rejects.toMatchObject({ code: "SCHEMA_MAINTENANCE_REQUIRED" });
    expect(client.calls.some(({ sql }) => sql.includes("authority_content_hash_uidx"))).toBe(false);
  });

  test("pending schema 缺少 legacy global unique 时启动 fail-closed", async () => {
    const client = new FakePostgresClient();
    client.catalogRows = ["memories", "knowledge"].map((table) => ({
      table_name: table, index_name: `${table}_pkey`, is_unique: true,
      is_valid: true, is_ready: true, predicate: null, index_columns: ["id"],
    }));

    await expect(executePostgresMigrations(client)).rejects.toMatchObject({
      code: "SCHEMA_CONTRACT_INVALID",
    });
    expect(client.applied).toEqual([]);
  });

  test("同名错误索引或 legacy global unique 使 catalog 验证 fail-closed，不记录 v6", async () => {
    const client = new FakePostgresClient();
    await executePostgresMigrations(client);
    client.catalogRows = [
      {
        table_name: "memories", index_name: "memories_authority_content_hash_uidx",
        is_unique: true, is_valid: true, is_ready: true, predicate: null,
        index_columns: ["tenant_id", "content_hash"],
      },
      {
        table_name: "knowledge", index_name: "knowledge_authority_content_hash_uidx",
        is_unique: true, is_valid: true, is_ready: true, predicate: null,
        index_columns: [
          "tenant_id", "user_id", "canonical_project_id", "product_id",
          "producer_id", "namespace", "visibility", "content_hash",
        ],
      },
      {
        table_name: "knowledge", index_name: "knowledge_content_hash_idx",
        is_unique: true, is_valid: true, is_ready: true, predicate: null,
        index_columns: ["content_hash"],
      },
    ];

    await expect(executePostgresMigrations(client, {
      contractMigration: { mode: "apply", maintenance: true, quiescenceConfirmed: true },
    })).rejects.toMatchObject({ code: "SCHEMA_CONTRACT_INVALID" });
    expect(client.applied.map(({ version }) => version)).toEqual([1, 2, 3, 4, 5]);
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("重复执行幂等，不重复运行或记录已应用 migration", async () => {
    const client = new FakePostgresClient();
    await executePostgresMigrations(client);
    const migrationSql = SCHEMA_MIGRATIONS.flatMap((item) => item.statements);
    const firstCounts = migrationSql.map((sql) => client.calls.filter((call) => call.sql === sql).length);

    const second = await executePostgresMigrations(client);

    expect(second.appliedVersions).toEqual([]);
    expect(second.toVersion).toBe(5);
    expect(client.applied).toHaveLength(5);
    expect(migrationSql.map((sql) => client.calls.filter((call) => call.sql === sql).length)).toEqual(
      firstCounts,
    );
  });

  test("maintenance 完成全部 migration 后再次启动幂等，并复核关键 catalog", async () => {
    const client = new FakePostgresClient();
    await executePostgresMigrations(client);
    await executePostgresMigrations(client, {
      contractMigration: { mode: "apply", maintenance: true, quiescenceConfirmed: true },
    });
    const ledgerWrites = client.calls.filter((call) => call.sql === INSERT_MIGRATION_SQL).length;

    const restarted = await executePostgresMigrations(client);

    expect(restarted.appliedVersions).toEqual([]);
    expect(restarted.toVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(restarted.pendingContractVersions).toEqual([]);
    expect(client.calls.filter((call) => call.sql === INSERT_MIGRATION_SQL)).toHaveLength(ledgerWrites);
    expect(client.calls.filter((call) => call.sql === AUTHORITY_DEDUPE_INDEX_CATALOG_SQL).length)
      .toBeGreaterThanOrEqual(2);
  });

  test.each([36, 37])("v%s catalog supports repeated startup with exactly its versioned columns", async (version) => {
    const client = new FakePostgresClient();
    const options = { migrations: SCHEMA_MIGRATIONS.slice(0, version), currentSchemaVersion: version };
    await executePostgresMigrations(client, options);
    await executePostgresMigrations(client, { ...options,
      contractMigration: { mode: "apply", maintenance: true, quiescenceConfirmed: true } });
    const before = structuredClone(client.applied);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(executePostgresMigrations(client, options)).resolves.toMatchObject({ toVersion: version, appliedVersions: [] });
      expect(client.applied).toEqual(before);
    }
  });

  test("v36 upgrades to v37 and restarts without rewriting any previous ledger entry", async () => {
    const client = new FakePostgresClient();
    await executePostgresMigrations(client, { migrations: SCHEMA_MIGRATIONS.slice(0, 36), currentSchemaVersion: 36,
      contractMigration: { mode: "apply", maintenance: true, quiescenceConfirmed: true } });
    const original = structuredClone(client.applied);
    await expect(executePostgresMigrations(client)).resolves.toMatchObject({ fromVersion: 36, toVersion: 37, appliedVersions: [37] });
    await expect(executePostgresMigrations(client)).resolves.toMatchObject({ toVersion: 37, appliedVersions: [] });
    expect(client.applied.slice(0, 36)).toEqual(original);
    const calls = client.calls.length;
    await expect(executePostgresMigrations(client, { migrations: SCHEMA_MIGRATIONS.slice(0, 36), currentSchemaVersion: 36 })).rejects.toThrow(/newer or unknown/i);
    expect(client.calls.slice(calls).some(call => call.sql === DURABLE_DOMAIN_SCHEMA_CATALOG_SQL)).toBe(false);
    expect(client.applied.slice(0, 36)).toEqual(original);
  });

  test.each([
    ["mengshu_write_outbox", "evolution_consumed_at"], ["mengshu_write_outbox", "evolution_origin"],
    ["mengshu_memory_version_outbox", "evolution_consumed_at"], ["mengshu_memory_version_outbox", "evolution_origin"],
    ["mengshu_memory_evidence_links", "relation_state"], ["mengshu_memory_evidence_links", "source_id"],
    ["mengshu_memory_evidence_links", "source_current_revision"], ["mengshu_memory_evidence_links", "retired_at"],
    ["memories", "evolution_review_due_at"], ["memories", "evolution_disputed"], ["memories", "evolution_alias_of"],
  ])("v37 rejects missing/type/default/nullability drift in %s.%s on every restart", async (table, column) => {
    const client = new FakePostgresClient();
    await executePostgresMigrations(client, { contractMigration: { mode: "apply", maintenance: true, quiescenceConfirmed: true } });
    const original = structuredClone(client.applied);
    for (const drift of ["missing", "definition", "default_definition", "is_nullable"]) {
      client.evolutionCatalogMutation = rows => rows.flatMap(row => {
        if (row.kind !== "column" || row.table_name !== table || row.object_name !== column) return [row];
        if (drift === "missing") return [];
        return [{ ...row, [drift]: drift === "is_nullable" ? (row.is_nullable === "YES" ? "NO" : "YES") : "unsafe_drift" }];
      });
      await expect(executePostgresMigrations(client)).rejects.toMatchObject({ code: "SCHEMA_CONTRACT_INVALID" });
      expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
      expect(client.applied).toEqual(original);
    }
  });

  test.each([36, 37])("v%s rejects undeclared journal/evidence/temporal columns instead of allowing unknown extensions", async (version) => {
    const client = new FakePostgresClient();
    const options = { migrations: SCHEMA_MIGRATIONS.slice(0, version), currentSchemaVersion: version };
    await executePostgresMigrations(client, { ...options, contractMigration: { mode: "apply", maintenance: true, quiescenceConfirmed: true } });
    for (const table of ["mengshu_write_outbox", "mengshu_memory_evidence_links", "mengshu_memory_version_outbox"]) {
      client.evolutionCatalogMutation = rows => rows.some(row => row.table_name === table) ? [...rows, {
        kind: "column", table_name: table, object_name: "evolution_unknown", definition: "text", default_definition: null, is_nullable: "YES",
      }] : rows;
      await expect(executePostgresMigrations(client, options)).rejects.toMatchObject({ code: "SCHEMA_CONTRACT_INVALID" });
    }
  });

  test("v37 validates expansion before recording its ledger and rolls back invalid defaults", async () => {
    const client = new FakePostgresClient();
    await executePostgresMigrations(client, { migrations: SCHEMA_MIGRATIONS.slice(0, 36), currentSchemaVersion: 36,
      contractMigration: { mode: "apply", maintenance: true, quiescenceConfirmed: true } });
    client.evolutionCatalogMutation = rows => rows.map(row => row.object_name === "evolution_origin"
      ? { ...row, default_definition: "true" } : row);
    const start = client.calls.length;
    await expect(executePostgresMigrations(client)).rejects.toMatchObject({ code: "SCHEMA_CONTRACT_INVALID" });
    expect(client.applied.at(-1)?.version).toBe(36);
    expect(client.calls.slice(start).some(call => call.sql === INSERT_MIGRATION_SQL && call.params[0] === 37)).toBe(false);
  });

  test("v36 does not accept v37 columns without the v37 migration", async () => {
    const client = new FakePostgresClient();
    const options = { migrations: SCHEMA_MIGRATIONS.slice(0, 36), currentSchemaVersion: 36 };
    await executePostgresMigrations(client, { ...options, contractMigration: { mode: "apply", maintenance: true, quiescenceConfirmed: true } });
    client.evolutionCatalogMutation = rows => rows.some(row => row.table_name === "mengshu_write_outbox") ? [...rows, {
      kind: "column", table_name: "mengshu_write_outbox", object_name: "evolution_origin", definition: "boolean", default_definition: "false", is_nullable: "NO",
    }] : rows;
    await expect(executePostgresMigrations(client, options)).rejects.toMatchObject({ code: "SCHEMA_CONTRACT_INVALID" });
    expect(client.applied.at(-1)?.version).toBe(36);
  });

  test("v18 catalog predicate 漂移时 fail-closed，且不写 v18 ledger", async () => {
    const client = new FakePostgresClient();
    client.applied.push(...SCHEMA_MIGRATIONS.slice(0, 17).map(({ version, name, checksum }) => ({
      version,
      name,
      checksum: checksum!,
    })));
    client.catalogRows = ["memories", "knowledge"].flatMap((table) => [{
      table_name: table,
      index_name: `${table}_pkey`,
      is_unique: true,
      is_valid: true,
      is_ready: true,
      predicate: null,
      index_columns: ["id"],
    }, {
      table_name: table,
      index_name: `${table}_authority_content_hash_uidx`,
      is_unique: true,
      is_valid: true,
      is_ready: true,
      predicate: table === "memories"
        ? "(lifecycle_status = 'active'::text) OR context_eligible = false"
        : null,
      index_columns: [
        "tenant_id", "user_id", "canonical_project_id", "product_id",
        "producer_id", "namespace", "visibility", "content_hash",
      ],
    }]);

    await expect(executePostgresMigrations(client, {
      contractMigration: { mode: "apply", maintenance: true, quiescenceConfirmed: true },
    })).rejects.toMatchObject({ code: "SCHEMA_CONTRACT_INVALID" });
    expect(client.applied.map(({ version }) => version)).toEqual(
      SCHEMA_MIGRATIONS.slice(0, 17).map(({ version }) => version),
    );
    expect(client.calls.some(({ sql, params }) =>
      sql === INSERT_MIGRATION_SQL && params[0] === 18)).toBe(false);
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("v14 candidate write journal catalog 完整时才在 ledger 记录版本", async () => {
    const client = new FakePostgresClient();
    await executePostgresMigrations(client);

    const result = await executePostgresMigrations(client, {
      contractMigration: { mode: "apply", maintenance: true, quiescenceConfirmed: true },
    });

    expect(result.appliedVersions).toContain(14);
    const tableNames = Object.keys(CANDIDATE_WRITE_JOURNAL_REQUIRED_COLUMNS);
    const catalogIndex = client.calls.findIndex(({ sql, params }) => {
      const requestedTables = params[0];
      return sql === DURABLE_DOMAIN_SCHEMA_CATALOG_SQL &&
        Array.isArray(requestedTables) &&
        tableNames.every((table) => requestedTables.includes(table));
    });
    const ledgerIndex = client.calls.findIndex(({ sql, params }) =>
      sql === INSERT_MIGRATION_SQL && params[0] === 14);
    expect(catalogIndex).toBeGreaterThan(-1);
    expect(catalogIndex).toBeLessThan(ledgerIndex);
  });

  test("v14 candidate write journal catalog 残缺时 rollback 且不写 ledger", async () => {
    const client = new FakePostgresClient();
    await executePostgresMigrations(client);
    client.candidateWriteCatalogRows = [];

    await expect(executePostgresMigrations(client, {
      contractMigration: { mode: "apply", maintenance: true, quiescenceConfirmed: true },
    })).rejects.toMatchObject({ code: "SCHEMA_CONTRACT_INVALID" });
    expect(client.applied.map(({ version }) => version)).toEqual([1, 2, 3, 4, 5]);
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("v15 evidence link ledger catalog 残缺时 rollback 且不写 v15 ledger", async () => {
    const client = new FakePostgresClient();
    await executePostgresMigrations(client);
    client.evidenceLinkCatalogRows = [];

    await expect(executePostgresMigrations(client, {
      contractMigration: { mode: "apply", maintenance: true, quiescenceConfirmed: true },
    })).rejects.toMatchObject({ code: "SCHEMA_CONTRACT_INVALID" });
    expect(client.applied.map(({ version }) => version)).toEqual([1, 2, 3, 4, 5]);
    expect(client.calls.some(({ sql, params }) => sql === INSERT_MIGRATION_SQL && params[0] === 15))
      .toBe(false);
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("v16 topic tree alias catalog 完整时才写 ledger，残缺时整笔 rollback", async () => {
    const complete = new FakePostgresClient();
    await executePostgresMigrations(complete);
    const applied = await executePostgresMigrations(complete, {
      contractMigration: { mode: "apply", maintenance: true, quiescenceConfirmed: true },
    });
    expect(applied.appliedVersions).toContain(16);
    const catalogIndex = complete.calls.findIndex(({ sql, params }) =>
      sql === DURABLE_DOMAIN_SCHEMA_CATALOG_SQL &&
      Array.isArray(params[0]) && params[0].includes("mengshu_topic_tree_aliases"));
    const ledgerIndex = complete.calls.findIndex(({ sql, params }) =>
      sql === INSERT_MIGRATION_SQL && params[0] === 16);
    expect(catalogIndex).toBeGreaterThan(-1);
    expect(catalogIndex).toBeLessThan(ledgerIndex);

    const incomplete = new FakePostgresClient();
    await executePostgresMigrations(incomplete);
    incomplete.topicTreeAliasCatalogRows = [];
    await expect(executePostgresMigrations(incomplete, {
      contractMigration: { mode: "apply", maintenance: true, quiescenceConfirmed: true },
    })).rejects.toMatchObject({ code: "SCHEMA_CONTRACT_INVALID" });
    expect(incomplete.calls.some(({ sql, params }) =>
      sql === INSERT_MIGRATION_SQL && params[0] === 16)).toBe(false);
    expect(incomplete.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("v17 canonical entity resolution catalog 完整时才写 ledger", async () => {
    const client = new FakePostgresClient();
    await executePostgresMigrations(client);

    const result = await executePostgresMigrations(client, {
      contractMigration: { mode: "apply", maintenance: true, quiescenceConfirmed: true },
    });

    expect(result.appliedVersions).toContain(17);
    const tableNames = Object.keys(CANONICAL_ENTITY_RESOLUTION_REQUIRED_COLUMNS);
    const catalogIndex = client.calls.findIndex(({ sql, params }) => {
      const requestedTables = params[0];
      return sql === DURABLE_DOMAIN_SCHEMA_CATALOG_SQL && Array.isArray(requestedTables) &&
        tableNames.every((tableName) => requestedTables.includes(tableName));
    });
    const ledgerIndex = client.calls.findIndex(({ sql, params }) =>
      sql === INSERT_MIGRATION_SQL && params[0] === 17);
    expect(catalogIndex).toBeGreaterThan(-1);
    expect(catalogIndex).toBeLessThan(ledgerIndex);
  });

  test("v17 canonical entity resolution catalog 残缺时 rollback 且不写 ledger", async () => {
    const client = new FakePostgresClient();
    await executePostgresMigrations(client);
    client.canonicalEntityResolutionCatalogRows = [];

    await expect(executePostgresMigrations(client, {
      contractMigration: { mode: "apply", maintenance: true, quiescenceConfirmed: true },
    })).rejects.toMatchObject({ code: "SCHEMA_CONTRACT_INVALID" });
    expect(client.calls.some(({ sql, params }) =>
      sql === INSERT_MIGRATION_SQL && params[0] === 17)).toBe(false);
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("v20/v21 overlay catalog 在 ledger 前验证，已应用版本也持续复核", async () => {
    const client = new FakePostgresClient();
    await executePostgresMigrations(client);
    await executePostgresMigrations(client, {
      contractMigration: { mode: "apply", maintenance: true, quiescenceConfirmed: true },
    });
    for (const version of [20, 21]) {
      const table = version === 20 ? "mengshu_asset_versions" : "mengshu_loadout_audit";
      const catalogIndex = client.calls.findIndex(({ sql, params }) =>
        sql === DURABLE_DOMAIN_SCHEMA_CATALOG_SQL && Array.isArray(params[0]) && params[0].includes(table));
      const ledgerIndex = client.calls.findIndex(({ sql, params }) =>
        sql === INSERT_MIGRATION_SQL && params[0] === version);
      expect(catalogIndex).toBeGreaterThan(-1);
      expect(catalogIndex).toBeLessThan(ledgerIndex);
    }
    const catalogCalls = client.calls.filter(({ sql, params }) =>
      sql === DURABLE_DOMAIN_SCHEMA_CATALOG_SQL && Array.isArray(params[0]) &&
      (params[0].includes("mengshu_asset_versions") || params[0].includes("mengshu_loadout_audit"))).length;
    await executePostgresMigrations(client);
    expect(client.calls.filter(({ sql, params }) =>
      sql === DURABLE_DOMAIN_SCHEMA_CATALOG_SQL && Array.isArray(params[0]) &&
      (params[0].includes("mengshu_asset_versions") || params[0].includes("mengshu_loadout_audit"))).length)
      .toBe(catalogCalls + 2);
  });

  test("已应用 v24 的库升级到当前版本时按 v26 扩展约束复核 asset catalog", async () => {
    const client = new FakePostgresClient();
    const bootstrap = await executePostgresMigrations(client, {
      migrations: SCHEMA_MIGRATIONS.slice(0, 24),
      currentSchemaVersion: 24,
      contractMigration: { mode: "apply", maintenance: true, quiescenceConfirmed: true },
    });
    expect(bootstrap.toVersion).toBe(24);

    const result = await executePostgresMigrations(client, {
      contractMigration: { mode: "apply", maintenance: true, quiescenceConfirmed: true },
    });

    expect(result.fromVersion).toBe(24);
    expect(result.toVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(result.appliedVersions).toEqual(
      Array.from({ length: CURRENT_SCHEMA_VERSION - 24 }, (_, index) => index + 25),
    );
    expect(client.calls.some(({ sql }) =>
      sql.includes("ADD CONSTRAINT mengshu_asset_versions_kind_check") &&
      sql.includes("'memory_document'"))).toBe(true);
    expect(client.calls.at(-1)?.sql).toBe("COMMIT");
  });

  test.each([20, 21])("v%s overlay catalog 残缺时 rollback 且不写 ledger", async (version) => {
    const client = new FakePostgresClient();
    await executePostgresMigrations(client);
    if (version === 20) client.assetLoadoutCatalogRows = [];
    else client.loadoutEventCatalogRows = [];
    await expect(executePostgresMigrations(client, {
      contractMigration: { mode: "apply", maintenance: true, quiescenceConfirmed: true },
    })).rejects.toMatchObject({ code: "SCHEMA_CONTRACT_INVALID" });
    expect(client.calls.some(({ sql, params }) =>
      sql === INSERT_MIGRATION_SQL && params[0] === version)).toBe(false);
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("v22 context assembly receipt catalog 在 ledger 前验证且已应用版本持续复核", async () => {
    const client = new FakePostgresClient();
    await executePostgresMigrations(client);
    await executePostgresMigrations(client, {
      contractMigration: { mode: "apply", maintenance: true, quiescenceConfirmed: true },
    });

    const catalogCalls = () => client.calls.filter(({ sql, params }) =>
      sql === DURABLE_DOMAIN_SCHEMA_CATALOG_SQL && Array.isArray(params[0]) &&
      params[0].includes("mengshu_context_assembly_receipts"));
    const ledgerIndex = client.calls.findIndex(({ sql, params }) =>
      sql === INSERT_MIGRATION_SQL && params[0] === 22);
    expect(catalogCalls().at(0)).toBeDefined();
    expect(client.calls.indexOf(catalogCalls()[0]!)).toBeLessThan(ledgerIndex);

    const beforeRestart = catalogCalls().length;
    await executePostgresMigrations(client);
    expect(catalogCalls()).toHaveLength(beforeRestart + 1);
  });

  test.each([
    ["missing column", (rows: Record<string, unknown>[]) => rows.filter((row) =>
      !(row.kind === "column" && row.object_name === "expires_at"))],
    ["wrong type", (rows: Record<string, unknown>[]) => rows.map((row) =>
      row.kind === "column" && row.object_name === "receipt" ? { ...row, definition: "text" } : row)],
    ["nullable column", (rows: Record<string, unknown>[]) => rows.map((row) =>
      row.kind === "column" && row.object_name === "session_id" ? { ...row, is_nullable: "YES" } : row)],
    ["invalid constraint", (rows: Record<string, unknown>[]) => rows.map((row) =>
      row.kind === "constraint" && String(row.definition).includes("expires_at >= created_at")
        ? { ...row, is_valid: false } : row)],
    ["wrong index definition", (rows: Record<string, unknown>[]) => rows.map((row) =>
      row.kind === "index" ? { ...row, definition: "CREATE INDEX wrong_order ON t (session_id)" } : row)],
  ])("v22 context assembly receipt catalog %s 时 rollback 且不写 ledger", async (_case, mutate) => {
    const client = new FakePostgresClient();
    await executePostgresMigrations(client);
    const probe = new FakePostgresClient();
    const complete = (await probe.query(DURABLE_DOMAIN_SCHEMA_CATALOG_SQL,
      [["mengshu_context_assembly_receipts"]])).rows;
    client.contextAssemblyReceiptCatalogRows = mutate([...complete]);

    await expect(executePostgresMigrations(client, {
      contractMigration: { mode: "apply", maintenance: true, quiescenceConfirmed: true },
    })).rejects.toMatchObject({ code: "SCHEMA_CONTRACT_INVALID" });
    expect(client.calls.some(({ sql, params }) =>
      sql === INSERT_MIGRATION_SQL && params[0] === 22)).toBe(false);
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("ledger 已到 v22 但 context assembly receipt catalog 后续残缺时启动 fail-closed", async () => {
    const client = new FakePostgresClient();
    await executePostgresMigrations(client);
    await executePostgresMigrations(client, {
      contractMigration: { mode: "apply", maintenance: true, quiescenceConfirmed: true },
    });
    client.contextAssemblyReceiptCatalogRows = [];

    await expect(executePostgresMigrations(client)).rejects.toMatchObject({
      code: "SCHEMA_CONTRACT_INVALID",
    });
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test.each([
    ["missing column", (rows: Record<string, unknown>[]) => rows.filter((row) =>
      !(row.kind === "column" && row.table_name === "mengshu_history_rebuild_runs" &&
        row.object_name === "policy_hash"))],
    ["wrong type", (rows: Record<string, unknown>[]) => rows.map((row) =>
      row.kind === "column" && row.object_name === "confidence"
        ? { ...row, definition: "text" } : row)],
    ["nullable column", (rows: Record<string, unknown>[]) => rows.map((row) =>
      row.kind === "column" && row.object_name === "source_hash"
        ? { ...row, is_nullable: "YES" } : row)],
    ["invalid constraint", (rows: Record<string, unknown>[]) => rows.map((row) =>
      row.kind === "constraint" && String(row.definition).includes("disposition = ANY")
        ? { ...row, is_valid: false } : row)],
    ["wrong index definition", (rows: Record<string, unknown>[]) => rows.map((row) =>
      row.kind === "index" && row.object_name === "mengshu_history_rebuild_operations_idx"
        ? { ...row, definition: "CREATE INDEX wrong ON t (run_id)" } : row)],
  ])("v23 history rebuild ledger catalog %s 时 rollback 且不写 ledger", async (_case, mutate) => {
    const client = new FakePostgresClient();
    await executePostgresMigrations(client);
    const probe = new FakePostgresClient();
    const complete = (await probe.query(DURABLE_DOMAIN_SCHEMA_CATALOG_SQL,
      [Object.keys(HISTORY_REBUILD_LEDGER_REQUIRED_COLUMNS)])).rows;
    client.historyRebuildLedgerCatalogRows = mutate([...complete]);

    await expect(executePostgresMigrations(client, {
      contractMigration: { mode: "apply", maintenance: true, quiescenceConfirmed: true },
    })).rejects.toMatchObject({ code: "SCHEMA_CONTRACT_INVALID" });
    expect(client.calls.some(({ sql, params }) =>
      sql === INSERT_MIGRATION_SQL && params[0] === 23)).toBe(false);
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("ledger 已到 v23 但 history rebuild catalog 后续残缺时启动 fail-closed", async () => {
    const client = new FakePostgresClient();
    await executePostgresMigrations(client);
    await executePostgresMigrations(client, {
      contractMigration: { mode: "apply", maintenance: true, quiescenceConfirmed: true },
    });
    client.historyRebuildLedgerCatalogRows = [];

    await expect(executePostgresMigrations(client)).rejects.toMatchObject({
      code: "SCHEMA_CONTRACT_INVALID",
    });
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("v14 candidate write journal route allowlist 混入非 candidate 路由时 fail-closed", async () => {
    const client = new FakePostgresClient();
    await executePostgresMigrations(client);
    client.candidateWriteRouteValues = [
      "candidate_low_priority", "candidate", "active", "lookup_only", "evidence_only",
    ];

    await expect(executePostgresMigrations(client, {
      contractMigration: { mode: "apply", maintenance: true, quiescenceConfirmed: true },
    })).rejects.toMatchObject({ code: "SCHEMA_CONTRACT_INVALID" });
    expect(client.applied.map(({ version }) => version)).toEqual([1, 2, 3, 4, 5]);
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("ledger 已到 v14 但 candidate write journal 后续残缺时启动 fail-closed", async () => {
    const client = new FakePostgresClient();
    await executePostgresMigrations(client);
    await executePostgresMigrations(client, {
      contractMigration: { mode: "apply", maintenance: true, quiescenceConfirmed: true },
    });
    client.candidateWriteCatalogRows = [];

    await expect(executePostgresMigrations(client)).rejects.toMatchObject({
      code: "SCHEMA_CONTRACT_INVALID",
    });
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("ledger 已到 v12 但 canonical domain catalog 残缺时启动 fail-closed", async () => {
    const client = new FakePostgresClient();
    await executePostgresMigrations(client);
    await executePostgresMigrations(client, {
      contractMigration: { mode: "apply", maintenance: true, quiescenceConfirmed: true },
    });
    client.domainCatalogRows = [];

    await expect(executePostgresMigrations(client)).rejects.toMatchObject({
      code: "SCHEMA_CONTRACT_INVALID",
    });
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("ledger 已到 v12 但 PostgreSQL-safe lease state constraint 缺失时启动 fail-closed", async () => {
    const client = new FakePostgresClient();
    await executePostgresMigrations(client);
    await executePostgresMigrations(client, {
      contractMigration: { mode: "apply", maintenance: true, quiescenceConfirmed: true },
    });
    client.jobStateCatalogRows = [];

    await expect(executePostgresMigrations(client)).rejects.toMatchObject({
      code: "SCHEMA_CONTRACT_INVALID",
    });
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("v10 新约束存在但旧 {32,256} state CHECK 仍残留时拒绝 false-green", async () => {
    const client = new FakePostgresClient();
    await executePostgresMigrations(client);
    await executePostgresMigrations(client, {
      contractMigration: { mode: "apply", maintenance: true, quiescenceConfirmed: true },
    });
    client.jobStateCatalogRows = [{
      constraint_name: "mengshu_jobs_v2_state_check",
      definition: "CHECK ((status = 'queued') OR (status = 'running' AND char_length(lease_token) >= 32 AND char_length(lease_token) <= 256 AND lease_token ~ '^[A-Za-z0-9._~-]+$') OR (status = 'retry_wait') OR (status = 'completed') OR (status = 'dead_letter'))",
      is_valid: true,
    }, {
      constraint_name: "renamed_legacy_state_check",
      definition: "CHECK (status = 'running' AND lease_token ~ '^[A-Za-z0-9._~-]{32,256}$')",
      is_valid: true,
    }];

    await expect(executePostgresMigrations(client)).rejects.toMatchObject({
      code: "SCHEMA_CONTRACT_INVALID",
    });
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("ledger 已到 v12 但 atomic write journal catalog 残缺时启动 fail-closed", async () => {
    const client = new FakePostgresClient();
    await executePostgresMigrations(client);
    await executePostgresMigrations(client, {
      contractMigration: { mode: "apply", maintenance: true, quiescenceConfirmed: true },
    });
    client.writeCatalogRows = [];

    await expect(executePostgresMigrations(client)).rejects.toMatchObject({
      code: "SCHEMA_CONTRACT_INVALID",
    });
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("v12 shadow/vector/receipt/queryability catalog 任一残缺都不写 ledger", async () => {
    const client = new FakePostgresClient();
    await executePostgresMigrations(client);
    client.embeddingCatalogRows = [];

    await expect(executePostgresMigrations(client, {
      contractMigration: { mode: "apply", maintenance: true, quiescenceConfirmed: true },
    })).rejects.toMatchObject({ code: "SCHEMA_CONTRACT_INVALID" });
    expect(client.applied.map(({ version }) => version)).toEqual([1, 2, 3, 4, 5]);
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("ledger 已连续应用至 v7 时，普通在线启动依序追加 v8-v9 expand", async () => {
    const client = new FakePostgresClient();
    client.applied.push(...SCHEMA_MIGRATIONS.slice(0, 7).map(({ version, name, checksum }) => ({
      version,
      name,
      checksum: checksum!,
    })));
    client.catalogRows = ["memories", "knowledge"].flatMap((table) => [{
      table_name: table,
      index_name: `${table}_pkey`,
      is_unique: true,
      is_valid: true,
      is_ready: true,
      predicate: null,
      index_columns: ["id"],
    }, {
      table_name: table,
      index_name: `${table}_authority_content_hash_uidx`,
      is_unique: true,
      is_valid: true,
      is_ready: true,
      predicate: null,
      index_columns: [
        "tenant_id", "user_id", "canonical_project_id", "product_id",
        "producer_id", "namespace", "visibility", "content_hash",
      ],
    }]);

    const result = await executePostgresMigrations(client);

    expect(result.appliedVersions).toEqual([8, 9]);
    expect(result.fromVersion).toBe(7);
    expect(result.toVersion).toBe(9);
    expect(client.calls.filter(({ sql }) => sql === INSERT_MIGRATION_SQL).map(({ params }) => params[0]))
      .toEqual([8, 9]);
    expect(client.calls.some(({ sql }) => sql.includes("mengshu_candidates"))).toBe(true);
    expect(client.calls.some(({ sql }) => sql.includes("mengshu_graph_entities"))).toBe(true);
    expect(client.calls.some(({ sql }) => sql.includes("mengshu_job_v2_effect_receipts"))).toBe(false);
  });

  test("稀疏 ledger [1..5,7] 属于未知 gap，fail-closed 且不执行 SQL migration", async () => {
    const client = new FakePostgresClient();
    client.applied.push(...SCHEMA_MIGRATIONS.slice(0, 5).map(({ version, name, checksum }) => ({
      version,
      name,
      checksum: checksum!,
    })), {
      version: 7,
      name: SCHEMA_MIGRATIONS[6]!.name,
      checksum: SCHEMA_MIGRATIONS[6]!.checksum!,
    });

    await expect(executePostgresMigrations(client)).rejects.toThrow(/missing prefix version 6/i);
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(client.calls.some((call) => call.sql.includes("mengshu_job_v2_effect_receipts"))).toBe(false);
  });

  test("稀疏 ledger [1..6,8] 不能跳过 v7 effect receipt 直接应用 candidate schema", async () => {
    const client = new FakePostgresClient();
    client.applied.push(...SCHEMA_MIGRATIONS.slice(0, 6).map(({ version, name, checksum }) => ({
      version,
      name,
      checksum: checksum!,
    })), {
      version: 8,
      name: SCHEMA_MIGRATIONS[7]!.name,
      checksum: SCHEMA_MIGRATIONS[7]!.checksum!,
    });

    await expect(executePostgresMigrations(client)).rejects.toThrow(/missing prefix version 7/i);
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(client.calls.some((call) => call.sql.includes("CREATE TABLE IF NOT EXISTS mengshu_candidates")))
      .toBe(false);
  });

  test("任一 migration 失败时 rollback 且不 commit", async () => {
    const client = new FakePostgresClient();
    const migrations: SchemaMigration[] = [
      {
        version: 1,
        name: "create-test-table",
        kind: "expand",
        statements: ["CREATE TABLE IF NOT EXISTS test_table (id TEXT PRIMARY KEY)"],
      },
      {
        version: 2,
        name: "create-test-index",
        kind: "expand",
        statements: ["CREATE INDEX IF NOT EXISTS test_idx ON test_table (id)"],
      },
    ];
    client.failWhenSqlIncludes = "CREATE INDEX";

    await expect(
      executePostgresMigrations(client, { migrations, currentSchemaVersion: 2 }),
    ).rejects.toThrow("fake migration failure");

    expect(client.calls.some((call) => call.sql === "ROLLBACK")).toBe(true);
    expect(client.calls.some((call) => call.sql === "COMMIT")).toBe(false);
    expect(client.applied).toEqual([]);
  });

  test("v6 删除旧全局索引失败时整笔 rollback，不记录 v6 ledger", async () => {
    const client = new FakePostgresClient();
    client.applied.push(...SCHEMA_MIGRATIONS.slice(0, 5).map(({ version, name, checksum }) => ({
      version,
      name,
      checksum: checksum!,
    })));
    client.failWhenSqlIncludes = "DROP INDEX IF EXISTS memories_content_hash_idx";

    await expect(executePostgresMigrations(client, {
      contractMigration: { mode: "apply", maintenance: true, quiescenceConfirmed: true },
    })).rejects.toThrow("fake migration failure");

    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(client.calls.some((call) => call.sql === "COMMIT")).toBe(false);
    expect(client.applied.map((item) => item.version)).toEqual([1, 2, 3, 4, 5]);
  });

  test("数据库 schema 超前时 fail-closed 并 rollback", async () => {
    const client = new FakePostgresClient();
    client.applied.push({
      version: CURRENT_SCHEMA_VERSION + 1,
      name: "future",
      checksum: "future",
    });

    await expect(executePostgresMigrations(client)).rejects.toThrow(/newer|unknown|超前/i);
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("advisory lock 在 ledger bootstrap 前获取", async () => {
    const client = new FakePostgresClient();
    await executePostgresMigrations(client);
    expect(client.calls[1]?.sql).toBe(LOCK_MIGRATIONS_SQL);
    expect(client.calls.findIndex(({ sql }) => sql === LOCK_MIGRATIONS_SQL)).toBeLessThan(
      client.calls.findIndex(({ sql }) => sql.includes("CREATE TABLE IF NOT EXISTS mengshu_schema_migrations")),
    );
  });

  test("ledger row 结构非法时 fail-closed 并 rollback", async () => {
    const client = new FakePostgresClient();
    client.applied.push({ version: Number.NaN, name: "invalid", checksum: "invalid" });

    await expect(executePostgresMigrations(client)).rejects.toThrow(/invalid schema migration ledger row/i);
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
  });
});
