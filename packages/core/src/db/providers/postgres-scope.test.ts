/**
 * Postgres provider scope 维度列单元测试（D-25）。
 *
 * 通过 mock pg.Pool 捕获 SQL 文本与参数，验证：
 * - ensureTable：CREATE TABLE 含 5 个 scope 列 + 2 个 scope 索引
 * - store：把 entry 的 scope 字段写入 project_name/app_name/... 列（NULL 兜底）
 * - query：projectName/appName 生成等值条件、projectPattern 生成 LIKE 条件，全部参数化
 *
 * 不依赖真实 postgres 连接，纯校验 SQL 生成与参数绑定。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ASSET_LOADOUT_OVERLAY_REQUIRED_COLUMNS,
  CANONICAL_ENTITY_RESOLUTION_REQUIRED_COLUMNS,
  CANDIDATE_WRITE_JOURNAL_REQUIRED_COLUMNS,
  CONTEXT_ASSEMBLY_RECEIPT_REQUIRED_COLUMNS,
  DURABLE_DOMAIN_REQUIRED_COLUMNS,
  EMBEDDING_REEMBED_REQUIRED_COLUMNS,
  EVIDENCE_LINK_LEDGER_REQUIRED_COLUMNS,
  HISTORY_REBUILD_LEDGER_REQUIRED_COLUMNS,
  HISTORY_REBUILD_MODEL_ATTEMPT_REQUIRED_COLUMNS,
  LOADOUT_EVENT_LEDGER_REQUIRED_COLUMNS,
  TOPIC_TREE_ALIAS_REQUIRED_COLUMNS,
  WRITE_JOURNAL_REQUIRED_COLUMNS,
  WORK_MEMORY_GRAPH_REQUIRED_COLUMNS,
} from "../migrations/postgres-ledger.js";
import { CURRENT_SCHEMA_VERSION } from "../migrations/schema-migrations.js";

// 捕获所有 pool.query 调用的 SQL 与参数
const queryCalls: Array<{ sql: string; params?: unknown[] }> = [];
const businessInsertResults: Array<{ rows: Array<{ id: string }>; rowCount: number }> = [];
const duplicateLookupResults: Array<{ rows: Array<{ id: string }>; rowCount: number }> = [];
let failBusinessInsertAt: number | undefined;
let businessInsertFailure: Error | undefined;
let businessInsertCount = 0;
let migrationRows: Array<{ version: number; name: string; checksum: string }> = [];
let transactionMigrationRows: Array<{ version: number; name: string; checksum: string }> | undefined;
let catalogRows: Record<string, unknown>[] | undefined;

function createDurableDomainCatalogRows(): Record<string, unknown>[] {
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
  return rows;
}

function createWriteJournalCatalogRows(): Record<string, unknown>[] {
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
  return rows;
}

function createEmbeddingReembedCatalogRows(): Record<string, unknown>[] {
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
  return rows;
}

function appendCatalogConstraints(
  rows: Record<string, unknown>[],
  constraints: Record<string, readonly string[]>,
): void {
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
}

function appendCatalogIndexes(
  rows: Record<string, unknown>[],
  indexNames: readonly string[],
  definitionFor: (indexName: string) => string = (indexName) => `CREATE INDEX ${indexName}`,
): void {
  for (const indexName of indexNames) {
    rows.push({
      kind: "index",
      table_name: "unused",
      object_name: indexName,
      definition: definitionFor(indexName),
      is_nullable: null,
      is_valid: true,
      is_ready: true,
    });
  }
}

function createWorkMemoryCatalogRows(): Record<string, unknown>[] {
  const nullable = new Map<string, readonly string[]>([
    ["mengshu_work_memory_nodes", [
      "evidence_kind", "semantic_type", "lifecycle_status", "tree_type", "level",
      "skill_candidate_status", "updated_at",
    ]],
    ["mengshu_work_memory_edges", ["reason", "updated_at"]],
  ]);
  const rows: Record<string, unknown>[] = Object.entries(WORK_MEMORY_GRAPH_REQUIRED_COLUMNS)
    .flatMap(([tableName, columns]) => columns.map((column) => ({
      kind: "column",
      table_name: tableName,
      object_name: column,
      definition: "text",
      default_definition: null,
      is_nullable: nullable.get(tableName)?.includes(column) ? "YES" : "NO",
      is_valid: true,
      is_ready: true,
    })));
  appendCatalogConstraints(rows, {
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
  });
  appendCatalogIndexes(rows, [
    "mengshu_work_memory_nodes_scope_type_idx",
    "mengshu_work_memory_edges_scope_source_idx",
    "mengshu_work_memory_edges_scope_target_idx",
  ]);
  return rows;
}

function createCandidateWriteCatalogRows(): Record<string, unknown>[] {
  const timestampColumns = new Set(["created_at", "occurred_at", "published_at"]);
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
  const routeConstraint = "CHECK (route = ANY (ARRAY['candidate_low_priority', 'candidate']))";
  appendCatalogConstraints(rows, {
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
  });
  appendCatalogIndexes(rows, [
    "mengshu_candidate_write_audit_scope_candidate_idx",
    "mengshu_candidate_write_outbox_pending_idx",
    "mengshu_candidate_write_receipts_created_idx",
  ]);
  return rows;
}

function createEvidenceLinkCatalogRows(): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = Object.entries(EVIDENCE_LINK_LEDGER_REQUIRED_COLUMNS)
    .flatMap(([tableName, columns]) => columns.map((column) => ({
      kind: "column",
      table_name: tableName,
      object_name: column,
      definition: column === "created_at" ? "bigint" : "text",
      default_definition: column === "workspace_id" || column === "session_id"
        ? "''::text"
        : null,
      is_nullable: "NO",
      is_valid: true,
      is_ready: true,
    })));
  appendCatalogConstraints(rows, {
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
  });
  appendCatalogIndexes(rows, [
    "mengshu_memory_evidence_links_scope_target_idx",
    "mengshu_graph_entity_evidence_scope_evidence_idx",
    "mengshu_graph_relation_evidence_scope_evidence_idx",
    "mengshu_graph_entity_aliases_scope_alias_idx",
  ]);
  return rows;
}

function createTopicTreeAliasCatalogRows(): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = Object.entries(TOPIC_TREE_ALIAS_REQUIRED_COLUMNS)
    .flatMap(([tableName, columns]) => columns.map((column) => ({
      kind: "column",
      table_name: tableName,
      object_name: column,
      definition: column === "merged_from"
        ? "jsonb"
        : ["created_at", "updated_at", "superseded_at", "archived_at"].includes(column)
          ? "bigint"
          : "text",
      default_definition: column === "workspace_id" || column === "session_id"
        ? "''::text"
        : column === "status"
          ? "'active'::text"
          : null,
      is_nullable: ["sealed_node_id", "superseded_at", "archived_at"].includes(column)
        ? "YES"
        : "NO",
      is_valid: true,
      is_ready: true,
    })));
  appendCatalogConstraints(rows, {
    mengshu_topic_tree_aliases: [
      "PRIMARY KEY (scope_fingerprint, legacy_tree_key)",
      "CHECK (status = ANY (ARRAY['active', 'superseded', 'archived']))",
      "CHECK (jsonb_typeof(merged_from) = 'array')",
      "CHECK (merged_from @> jsonb_build_array(legacy_tree_key))",
    ],
  });
  appendCatalogIndexes(rows, [
    "mengshu_topic_tree_aliases_scope_canonical_idx",
    "mengshu_topic_tree_aliases_scope_status_idx",
  ]);
  return rows;
}

function createCanonicalEntityResolutionCatalogRows(): Record<string, unknown>[] {
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
    kind: "column",
    table_name: tableName,
    object_name: column,
    definition: typeFor(column),
    default_definition: column === "workspace_id" || column === "session_id"
      ? "''::text"
      : null,
    is_nullable: nullable.get(tableName)?.includes(column) ? "YES" : "NO",
    is_valid: true,
    is_ready: true,
  })));
  appendCatalogConstraints(rows, {
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
  });
  appendCatalogIndexes(rows, [
    "mengshu_graph_entity_alias_bindings_active_uidx",
    "mengshu_graph_entity_alias_bindings_entity_idx",
    "mengshu_graph_entity_resolution_scope_evidence_idx",
    "mengshu_graph_entity_resolution_rollback_idx",
    "mengshu_graph_relation_resolution_scope_evidence_idx",
    "mengshu_graph_entity_embeddings_queryable_idx",
  ], (indexName) => {
    if (indexName === "mengshu_graph_entity_alias_bindings_active_uidx") {
      return `CREATE UNIQUE INDEX ${indexName} ON mengshu_graph_entity_alias_bindings USING btree (scope_fingerprint, entity_type, normalized_alias) WHERE (status = 'active'::text)`;
    }
    if (indexName === "mengshu_graph_entity_embeddings_queryable_idx") {
      return `CREATE INDEX ${indexName} ON mengshu_graph_entity_embeddings USING btree (scope_fingerprint, entity_type, embedding_space_id, entity_id) WHERE (embedding_space_state = 'known-queryable'::text)`;
    }
    return `CREATE INDEX ${indexName}`;
  });
  return rows;
}

function createAssetLoadoutCatalogRows(
  columnsByTable: Readonly<Record<string, readonly string[]>>,
): Record<string, unknown>[] {
  const integerColumns = new Set(["version", "latest_version", "asset_version", "loadout_version"]);
  const bigintColumns = new Set([
    "audit_id", "created_at", "changed_at", "occurred_at", "published_at",
  ]);
  const jsonColumns = new Set(["descriptor", "receipt", "payload"]);
  const rows = Object.entries(columnsByTable).flatMap(([tableName, columns]) =>
    columns.map((column) => ({
      kind: "column",
      table_name: tableName,
      object_name: column,
      definition: integerColumns.has(column)
        ? "integer"
        : bigintColumns.has(column)
          ? "bigint"
          : jsonColumns.has(column) ? "jsonb" : "text",
      default_definition: column === "audit_id"
        ? `nextval('${tableName}_audit_id_seq'::regclass)`
        : null,
      is_nullable: column === "published_at" ||
          (tableName === "mengshu_loadout_versions" && column === "project_id")
        ? "YES"
        : "NO",
      is_valid: true,
      is_ready: true,
    })),
  );
  const loadoutEventLedger = Object.hasOwn(columnsByTable, "mengshu_loadout_audit");
  appendCatalogConstraints(rows, loadoutEventLedger
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
          "CHECK (kind = 'memory_view')",
          "CHECK (status = ANY (ARRAY['draft', 'review', 'published', 'deprecated', 'revoked']))",
          "CHECK (visibility = 'private')",
          "CHECK (jsonb_typeof(descriptor) = 'object')",
        ],
        mengshu_asset_heads: [
          "PRIMARY KEY (scope_fingerprint, asset_id)",
          "FOREIGN KEY (scope_fingerprint, asset_id, latest_version) REFERENCES mengshu_asset_versions",
        ],
        mengshu_asset_promotion_receipts: [
          "PRIMARY KEY (receipt_id)",
          "UNIQUE (scope_fingerprint, request_key)",
          "FOREIGN KEY (scope_fingerprint, asset_id, asset_version) REFERENCES mengshu_asset_versions",
          "CHECK (jsonb_typeof(receipt) = 'object')",
        ],
        mengshu_asset_audit: [
          "PRIMARY KEY (audit_id)",
          "FOREIGN KEY (receipt_id) REFERENCES mengshu_asset_promotion_receipts",
          "FOREIGN KEY (scope_fingerprint, asset_id, asset_version) REFERENCES mengshu_asset_versions",
          "CHECK (event_type = ANY (ARRAY['version_created', 'status_changed']))",
        ],
        mengshu_asset_outbox: [
          "PRIMARY KEY (event_id)",
          "FOREIGN KEY (scope_fingerprint, asset_id, asset_version) REFERENCES mengshu_asset_versions",
          "CHECK (event_type = ANY (ARRAY['asset.version.created', 'asset.status.changed']))",
          "CHECK (jsonb_typeof(payload) = 'object')",
        ],
        mengshu_loadout_versions: [
          "PRIMARY KEY (scope_fingerprint, loadout_id, version)",
          "CHECK (visibility = 'private')",
          "CHECK (jsonb_typeof(descriptor) = 'object')",
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
      });
  appendCatalogIndexes(rows, loadoutEventLedger
    ? ["mengshu_loadout_outbox_pending_idx"]
    : [
        "mengshu_asset_versions_status_idx",
        "mengshu_asset_outbox_pending_idx",
        "mengshu_loadout_identity_idx",
      ], (indexName) => indexName.includes("outbox_pending")
      ? `CREATE INDEX ${indexName} WHERE (published_at IS NULL)`
      : `CREATE INDEX ${indexName}`);
  return rows;
}

function createContextAssemblyReceiptCatalogRows(): Record<string, unknown>[] {
  const bigintColumns = new Set(["created_at", "expires_at"]);
  const rows = Object.entries(CONTEXT_ASSEMBLY_RECEIPT_REQUIRED_COLUMNS)
    .flatMap(([tableName, columns]) => columns.map((column) => ({
      kind: "column",
      table_name: tableName,
      object_name: column,
      definition: bigintColumns.has(column) ? "bigint" : column === "receipt" ? "jsonb" : "text",
      default_definition: null,
      is_nullable: "NO",
      is_valid: true,
      is_ready: true,
    })));
  appendCatalogConstraints(rows, {
    mengshu_context_assembly_receipts: [
      "PRIMARY KEY (receipt_id)",
      "CHECK (receipt_id ~ '^[0-9a-f]{64}$')",
      "CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$')",
      "CHECK (stable_content_hash ~ '^[0-9a-f]{64}$')",
      "CHECK (dynamic_content_hash ~ '^[0-9a-f]{64}$')",
      "CHECK (jsonb_typeof(receipt) = 'object')",
      "CHECK (created_at >= 0)",
      "CHECK (expires_at >= created_at)",
      "CHECK (char_length(session_id) >= 1 AND char_length(session_id) <= 256 AND session_id !~ '[[:space:][:cntrl:]]')",
    ],
  });
  appendCatalogIndexes(rows, ["mengshu_context_assembly_receipts_session_idx"],
    (indexName) => `CREATE INDEX ${indexName} ON mengshu_context_assembly_receipts ` +
      "(scope_fingerprint, session_id, created_at DESC, receipt_id DESC)");
  return rows;
}

function createHistoryRebuildLedgerCatalogRows(): Record<string, unknown>[] {
  const uuidColumns = new Set(["source_upper_bound", "record_id", "after_id"]);
  const bigintColumns = new Set([
    "created_at", "updated_at", "captured_at", "source_count", "checkpoint_version",
  ]);
  const integerColumns = new Set(["proposal_count", "input_tokens", "output_tokens"]);
  const jsonColumns = new Set([
    "source_row", "original_metadata", "counts", "topic_labels", "tree_eligibility",
  ]);
  const nullable = new Set([
    "mengshu_history_rebuild_source_snapshots.source_upper_bound",
    "mengshu_history_rebuild_checkpoints.after_id",
    "mengshu_history_rebuild_source_rows.original_lifecycle_status",
    "mengshu_history_rebuild_shadow_plans.semantic_type",
    "mengshu_history_rebuild_operation_receipts.drift_hash",
  ]);
  const rows = Object.entries(HISTORY_REBUILD_LEDGER_REQUIRED_COLUMNS)
    .flatMap(([tableName, columns]) => columns.map((column) => ({
      kind: "column",
      table_name: tableName,
      object_name: column,
      definition: uuidColumns.has(column) ? "uuid"
        : bigintColumns.has(column) ? "bigint"
        : integerColumns.has(column) ? "integer"
        : jsonColumns.has(column) ? "jsonb"
        : column === "context_eligible" ? "boolean"
        : column === "confidence" ? "double precision"
        : "text",
      default_definition: tableName === "mengshu_history_rebuild_runs" &&
          (column === "workspace_id" || column === "session_id")
        ? "''::text"
        : tableName === "mengshu_history_rebuild_checkpoints" &&
            column === "checkpoint_version"
        ? "0"
        : null,
      is_nullable: nullable.has(`${tableName}.${column}`) ? "YES" : "NO",
      is_valid: true,
      is_ready: true,
    })));
  const constraints: Record<string, readonly string[]> = {
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
      "REFERENCES mengshu_history_rebuild_source_snapshots", "source_table = ANY",
      "jsonb_typeof(source_row) = 'object'", "jsonb_typeof(original_metadata) = 'object'",
    ],
    mengshu_history_rebuild_checkpoints: [
      "PRIMARY KEY (run_id, source_table)", "FOREIGN KEY (run_id, source_table)",
      "REFERENCES mengshu_history_rebuild_source_snapshots",
      "jsonb_typeof(counts) = 'object'", "state = ANY",
    ],
    mengshu_history_rebuild_shadow_plans: [
      "PRIMARY KEY (run_id, source_table, record_id)",
      "UNIQUE (run_id, plan_receipt_hash)", "FOREIGN KEY (run_id, source_table)",
      "REFERENCES mengshu_history_rebuild_source_snapshots", "disposition = ANY",
      "semantic_type IS NULL", "jsonb_typeof(topic_labels) = 'array'",
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
  };
  appendCatalogConstraints(rows, constraints);
  appendCatalogIndexes(rows, [
    "mengshu_history_rebuild_shadow_disposition_idx",
    "mengshu_history_rebuild_operations_idx",
    "mengshu_history_rebuild_artifacts_source_idx",
  ], (indexName) => {
    const columns = indexName === "mengshu_history_rebuild_shadow_disposition_idx"
      ? "run_id, source_table, disposition, record_id"
      : indexName === "mengshu_history_rebuild_operations_idx"
      ? "run_id, source_table, operation, created_at, receipt_hash"
      : "run_id, source_table, record_id, artifact_type, artifact_role";
    return `CREATE INDEX ${indexName} ON history (${columns})`;
  });
  return rows;
}

function createHistoryRebuildModelAttemptCatalogRows(): Record<string, unknown>[] {
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
  const rows = Object.entries(HISTORY_REBUILD_MODEL_ATTEMPT_REQUIRED_COLUMNS)
    .flatMap(([tableName, columns]) => columns.map((column) => ({
      kind: "column",
      table_name: tableName,
      object_name: column,
      definition: column === "record_id" ? "uuid"
        : integerColumns.has(column) ? "integer"
        : bigintColumns.has(column) ? "bigint"
        : column === "output" ? "jsonb" : "text",
      default_definition: null,
      is_nullable: nullable.has(column) ? "YES" : "NO",
      is_valid: true,
      is_ready: true,
    })));
  appendCatalogConstraints(rows, {
    mengshu_history_rebuild_model_attempts: [
      "PRIMARY KEY (run_id, source_table, record_id, attempt)",
      "FOREIGN KEY (run_id) REFERENCES mengshu_history_rebuild_runs(run_id)",
      "CHECK (source_table = ANY)", "CHECK (state = ANY)",
      "CHECK (attempt >= 0 AND attempt < 2)",
      "CHECK ((state = 'reserved' AND output IS NULL) OR (state = 'completed' AND " +
        "jsonb_typeof(output) = 'object' AND actual_input_tokens = reserved_input_tokens AND " +
        "actual_output_tokens <= reserved_output_tokens AND " +
        "actual_cost_minor_units <= reserved_cost_minor_units))",
    ],
  });
  appendCatalogIndexes(rows, ["mengshu_history_rebuild_model_attempts_budget_idx"],
    (indexName) => `CREATE INDEX ${indexName} ON mengshu_history_rebuild_model_attempts ` +
      "(migration_id, manifest_hash, state)");
  return rows;
}

const mockQuery = vi.fn(async (sql: string, params?: unknown[]) => {
  queryCalls.push({ sql, params });
  if (sql === "BEGIN") {
    transactionMigrationRows = [...migrationRows];
  }
  if (sql === "COMMIT") {
    if (transactionMigrationRows) migrationRows = [...transactionMigrationRows];
    transactionMigrationRows = undefined;
  }
  if (sql === "ROLLBACK") {
    transactionMigrationRows = undefined;
  }
  if (/SELECT version, name, checksum FROM mengshu_schema_migrations/.test(sql)) {
    const rows = transactionMigrationRows ?? migrationRows;
    return { rows: [...rows], rowCount: rows.length };
  }
  if (/INSERT INTO mengshu_schema_migrations/.test(sql)) {
    const rows = transactionMigrationRows ?? migrationRows;
    rows.push({ version: Number(params?.[0]), name: String(params?.[1]), checksum: String(params?.[2]) });
    return { rows: [], rowCount: 1 };
  }
  if (/FROM information_schema\.columns/.test(sql)) {
    const requestedTables = Array.isArray(params?.[0]) ? params[0] as string[] : [];
    const rows = requestedTables.includes("mengshu_history_rebuild_model_attempts")
      ? createHistoryRebuildModelAttemptCatalogRows()
      : requestedTables.includes("mengshu_history_rebuild_runs")
      ? createHistoryRebuildLedgerCatalogRows()
      : requestedTables.includes("mengshu_context_assembly_receipts")
      ? createContextAssemblyReceiptCatalogRows()
      : requestedTables.includes("mengshu_asset_versions")
      ? createAssetLoadoutCatalogRows(ASSET_LOADOUT_OVERLAY_REQUIRED_COLUMNS)
      : requestedTables.includes("mengshu_loadout_audit")
        ? createAssetLoadoutCatalogRows(LOADOUT_EVENT_LEDGER_REQUIRED_COLUMNS)
        : requestedTables.includes("mengshu_graph_entity_resolution_ledger")
      ? createCanonicalEntityResolutionCatalogRows()
      : requestedTables.includes("mengshu_topic_tree_aliases")
        ? createTopicTreeAliasCatalogRows()
        : requestedTables.includes("mengshu_memory_evidence_links")
          ? createEvidenceLinkCatalogRows()
          : requestedTables.includes("mengshu_candidate_write_receipts")
            ? createCandidateWriteCatalogRows()
            : requestedTables.includes("mengshu_work_memory_nodes")
              ? createWorkMemoryCatalogRows()
              : requestedTables.includes("mengshu_embedding_reembed_shadow")
                ? createEmbeddingReembedCatalogRows()
                : requestedTables.includes("mengshu_write_receipts")
                  ? createWriteJournalCatalogRows()
                  : createDurableDomainCatalogRows();
    return { rows, rowCount: rows.length };
  }
  if (/FROM pg_constraint AS constraint_meta/.test(sql) && /mengshu_jobs_v2/.test(sql)) {
    const rows = [{
      constraint_name: "mengshu_jobs_v2_state_check",
      definition: "CHECK ((status = 'queued') OR (status = 'running' AND char_length(lease_token) >= 32 AND char_length(lease_token) <= 256 AND lease_token ~ '^[A-Za-z0-9._~-]+$') OR (status = 'retry_wait') OR (status = 'completed') OR (status = 'dead_letter'))",
      is_valid: true,
    }];
    return { rows, rowCount: rows.length };
  }
  if (/FROM pg_class AS table_rel/.test(sql)) {
    const contractDdlApplied = queryCalls.some(({ sql: callSql }) =>
      /CREATE UNIQUE INDEX memories_authority_content_hash_uidx/.test(callSql),
    );
    const activeMemoryDedupeApplied = queryCalls.some(({ sql: callSql }) =>
      /CREATE UNIQUE INDEX memories_active_authority_content_hash_uidx/.test(callSql),
    );
    const rows = catalogRows ?? ["memories", "knowledge"].flatMap((table) => [
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
    return { rows, rowCount: rows.length };
  }
  if (/INSERT INTO\s+"(?:memories|knowledge)"/.test(sql)) {
    businessInsertCount += 1;
    if (businessInsertCount === failBusinessInsertAt) {
      throw businessInsertFailure ?? new Error("fake business insert failure");
    }
    return businessInsertResults.shift() ?? {
      rows: [{ id: String(params?.[0]) }],
      rowCount: 1,
    };
  }
  if (/SELECT\s+id\s+FROM\s+"(?:memories|knowledge)"/i.test(sql)) {
    return duplicateLookupResults.shift() ?? { rows: [], rowCount: 0 };
  }
  // 模拟向量查询返回一行，验证 rowToEntry 能读出 scope 列
  if (/<=>/.test(sql)) {
    return {
      rows: [
        {
          id: "id-1",
          text: "hello",
          content_hash: "h1",
          vector: [0.1, 0.2],
          importance: 0.7,
          category: "other",
          data_type: "memory",
          metadata: {
            embeddingSpaceId: `embedding-space:v1:${"a".repeat(64)}`,
            embeddingSpaceState: "known-queryable",
          },
          embedding_space_id: `embedding-space:v1:${"a".repeat(64)}`,
          embedding_space_state: "known-queryable",
          created_at: new Date().toISOString(),
          project_name: "memory-autodb",
          app_name: "claude-code",
          user_id: "u1",
          agent_id: "a1",
          workspace_id: "w1",
          tenant_id: "tenant-1",
          similarity: 0.9,
        },
      ],
    };
  }
  return { rows: [], rowCount: 0 };
});

vi.mock("pg", () => {
  class FakePool {
    query = mockQuery;
    async connect() {
      return {
        query: mockQuery,
        release() {},
      };
    }
    async end() {}
  }
  return { default: { Pool: FakePool } };
});

import { PostgresProvider } from "./postgres";
import { DEFAULT_VECTOR_CANDIDATE_LIMIT } from "../types";
import type { MemoryEntry, MemoryQueryOptions } from "../types";
import type { MemoryRecord } from "../../domain/types.js";

const PG_CONFIG = {
  host: "localhost",
  port: 5432,
  database: "test",
  user: "test",
  password: "test",
};

const TEST_EMBEDDING_SPACE_ID = `embedding-space:v1:${"a".repeat(64)}`;
const TEST_EMBEDDING_FILTER = Object.freeze({
  embeddingSpaceId: TEST_EMBEDDING_SPACE_ID,
  embeddingSpaceState: "known-queryable",
});

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    text: "记忆内容",
    contentHash: "hash-1",
    vector: [0.1, 0.2],
    importance: 0.7,
    category: "other" as MemoryEntry["category"],
    dataType: "memory",
    metadata: { ...TEST_EMBEDDING_FILTER },
    createdAt: Date.now(),
    tenantId: "tenant-1",
    userId: "user-1",
    canonicalProjectId: "project-1",
    productId: "product-1",
    producerId: "producer-1",
    namespace: "memories",
    visibility: "private",
    ...overrides,
  };
}

describe("PostgresProvider scope 维度列（D-25）", () => {
  beforeEach(() => {
    queryCalls.length = 0;
    businessInsertResults.length = 0;
    duplicateLookupResults.length = 0;
    failBusinessInsertAt = undefined;
    businessInsertFailure = undefined;
    businessInsertCount = 0;
    migrationRows = [];
    transactionMigrationRows = undefined;
    catalogRows = undefined;
    mockQuery.mockClear();
  });

  describe("ensureTable / createTableIfNotExists", () => {
    it("并发 initialize 复用同一初始化过程，避免迁移完成前放行", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");

      await Promise.all([provider.initialize(), provider.initialize(), provider.initialize()]);

      expect(queryCalls.filter((call) => /CREATE EXTENSION IF NOT EXISTS vector/.test(call.sql))).toHaveLength(1);
      expect(queryCalls.filter((call) => /CREATE TABLE IF NOT EXISTS mengshu_schema_migrations/.test(call.sql))).toHaveLength(1);
    });

    it("跨进程 bootstrap advisory lock 覆盖 extension/default tables 与 migration", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      await provider.initialize();

      const lock = queryCalls.findIndex(({ sql }) => /pg_advisory_lock\(hashtext\('mengshu_schema_bootstrap'\)\)/.test(sql));
      const extension = queryCalls.findIndex(({ sql }) => /CREATE EXTENSION IF NOT EXISTS vector/.test(sql));
      const defaultTable = queryCalls.findIndex(({ sql }) => /CREATE TABLE IF NOT EXISTS\s+"memories"/.test(sql));
      const migrationBegin = queryCalls.findIndex(({ sql }) => sql === "BEGIN");
      const unlock = queryCalls.findIndex(({ sql }) => /pg_advisory_unlock\(hashtext\('mengshu_schema_bootstrap'\)\)/.test(sql));
      expect(lock).toBeGreaterThan(-1);
      expect(lock).toBeLessThan(extension);
      expect(extension).toBeLessThan(defaultTable);
      expect(defaultTable).toBeLessThan(migrationBegin);
      expect(unlock).toBeGreaterThan(migrationBegin);
    });

    it("普通 initialize 只执行 expand，并显式报告 scope dedupe contract pending", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      await provider.initialize();

      await expect(provider.getSchemaContractStatus()).resolves.toEqual({
        currentVersion: 5,
        targetVersion: CURRENT_SCHEMA_VERSION,
        scopeContentHashDedupe: "pending",
      });
      expect(queryCalls.some(({ sql }) => /CREATE UNIQUE INDEX memories_authority_content_hash_uidx/.test(sql)))
        .toBe(false);
    });

    it("显式 maintenance/quiescence 路径连续应用至当前 schema 并切换 ready", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      await provider.initialize();

      await expect(provider.applyScopeContentHashDedupeContract({
        maintenance: true,
        quiescenceConfirmed: true,
      })).resolves.toMatchObject({
        scopeContentHashDedupe: "ready",
        currentVersion: CURRENT_SCHEMA_VERSION,
      });

      expect(queryCalls.some(({ sql }) => /CREATE UNIQUE INDEX memories_authority_content_hash_uidx/.test(sql)))
        .toBe(true);
      expect(queryCalls.some(({ sql }) => /FROM pg_class AS table_rel/.test(sql))).toBe(true);
    });

    it("CREATE TABLE 包含 5 个 scope 列", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      await provider.initialize();
      queryCalls.length = 0;
      await provider.ensureTable("memories");

      const createSql = queryCalls.find((c) => /CREATE TABLE IF NOT EXISTS/.test(c.sql))?.sql ?? "";
      expect(createSql).toContain("project_name TEXT");
      expect(createSql).toContain("app_name TEXT");
      expect(createSql).toContain("user_id TEXT");
      expect(createSql).toContain("agent_id TEXT");
      expect(createSql).toContain("workspace_id TEXT");
    });

    it("为存量表补列：ALTER TABLE ADD COLUMN IF NOT EXISTS", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      await provider.initialize();
      queryCalls.length = 0;
      await provider.ensureTable("memories");

      const alterSqls = queryCalls.filter((c) => /ALTER TABLE .* ADD COLUMN IF NOT EXISTS/.test(c.sql));
      const joined = alterSqls.map((c) => c.sql).join("\n");
      expect(joined).toContain("project_name TEXT");
      expect(joined).toContain("app_name TEXT");
      expect(joined).toContain("workspace_id TEXT");
    });

    it("创建 project_name 和 app_name 的 B-tree 索引", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      await provider.initialize();
      queryCalls.length = 0;
      await provider.ensureTable("memories");

      const idxSqls = queryCalls.filter((c) => /CREATE INDEX IF NOT EXISTS/.test(c.sql)).map((c) => c.sql);
      const joined = idxSqls.join("\n");
      expect(joined).toContain("idx_memories_project_name");
      expect(joined).toContain("(project_name)");
      expect(joined).toContain("idx_memories_app_name");
      expect(joined).toContain("(app_name)");
    });

    it("fresh pending 表保留 inline global unique，且不创建第二个重复显式索引", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      await provider.initialize();
      queryCalls.length = 0;
      await provider.ensureTable("memories");

      const createSql = queryCalls.find((c) => /CREATE TABLE IF NOT EXISTS\s+"memories"/.test(c.sql))?.sql ?? "";
      expect(createSql).toMatch(/content_hash TEXT NOT NULL UNIQUE/);
      expect(queryCalls.some((c) => /memories_content_hash_idx/.test(c.sql))).toBe(false);
    });
  });

  describe("store 写入 scope 列", () => {
    it("把 entry 的 scope 字段写入对应列", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      await provider.store([
        makeEntry({
          projectName: "memory-autodb",
          appName: "claude-code",
          userId: "user-1",
          agentId: "agent-1",
          workspaceId: "ws-1",
          tenantId: "tenant-a",
          canonicalProjectId: "memory-autodb",
          productId: "claude-code",
          producerId: "agent-1",
          namespace: "memories",
          visibility: "private",
        }),
      ]);

      const insert = queryCalls.find((c) => /INSERT INTO\s+"memories"/.test(c.sql));
      expect(insert).toBeDefined();
      expect(insert!.sql).toContain("project_name");
      expect(insert!.sql).toContain("app_name");
      expect(insert!.sql).toContain("workspace_id");
      expect(insert!.sql).toContain("scope_key");
      // 参数顺序：[..., project_name, app_name, user_id, agent_id, workspace_id]
      const params = insert!.params!;
      expect(params).toContain("memory-autodb");
      expect(params).toContain("claude-code");
      expect(params).toContain("user-1");
      expect(params).toContain("agent-1");
      expect(params).toContain("ws-1");
      expect(params.slice(14, 22)).toEqual([
        "tenant-a",
        "memory-autodb",
        "claude-code",
        "agent-1",
        "memories",
        "private",
        "tenant-a:claude-code:user-1:memory-autodb:agent-1:memories",
        null,
      ]);
      expect(insert!.sql).toContain("embedding_space_id");
      expect(insert!.sql).toContain("embedding_space_state");
      expect(params.slice(22, 24)).toEqual([
        TEST_EMBEDDING_SPACE_ID,
        "known-queryable",
      ]);
    });

    it("embedding metadata 缺失、非 queryable 或 snake/camel 冲突时在 INSERT 前 fail-closed", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");

      for (const metadata of [
        {},
        { embeddingSpaceId: TEST_EMBEDDING_SPACE_ID, embeddingSpaceState: "reembedded" },
        {
          ...TEST_EMBEDDING_FILTER,
          embedding_space_id: `embedding-space:v1:${"b".repeat(64)}`,
        },
      ]) {
        await expect(provider.store([makeEntry({ metadata })])).rejects.toThrow(/embedding/i);
      }
      expect(queryCalls.find((call) => /INSERT INTO\s+"memories"/.test(call.sql))).toBeUndefined();
    });

    it("canonical scope 字段缺失时 fail-closed，不产生 INSERT", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      await expect(provider.store([makeEntry({ tenantId: undefined })])).rejects.toThrow(
        /canonical scope field: tenantId/,
      );

      const insert = queryCalls.find((c) => /INSERT INTO\s+"memories"/.test(c.sql));
      expect(insert).toBeUndefined();
    });

    it("非 UUID durable id 在进入 PostgreSQL 前 fail-closed", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      await expect(provider.store([makeEntry({ id: "doc:not-a-postgres-uuid" })])).rejects.toThrow(
        /durable record id must be a UUID/,
      );
      expect(queryCalls.find((c) => /INSERT INTO\s+"memories"/.test(c.sql))).toBeUndefined();
    });

    it("扩展 knowledge_* 表在纳入 transactional forget 前禁止新写", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small", {
        enabled: true,
        autoCreateTables: false,
        builtinCategories: ["work"],
      });

      await expect(provider.store([makeEntry({
        tableName: "knowledge_work",
        dataType: "knowledge",
        namespace: "knowledge_work",
      })])).rejects.toThrow(/extended knowledge table writes are disabled/);
      expect(queryCalls.find((c) => /INSERT INTO\s+"knowledge_work"/.test(c.sql))).toBeUndefined();
    });

    it("mixed batch 含扩展表时在任何业务 INSERT 前原子拒绝", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small", {
        enabled: true,
        autoCreateTables: false,
        builtinCategories: ["work"],
      });

      await expect(provider.store([
        makeEntry(),
        makeEntry({
          id: "00000000-0000-0000-0000-000000000002",
          contentHash: "hash-2",
          tableName: "knowledge_work",
          dataType: "knowledge",
          namespace: "knowledge_work",
        }),
      ])).rejects.toThrow(/extended knowledge table writes are disabled/);
      expect(queryCalls.find((c) => /INSERT INTO\s+"(?:memories|knowledge_work)"/.test(c.sql))).toBeUndefined();
    });

    it.each([
      ["tenant", { tenantId: "tenant-2" }],
      ["user", { userId: "user-2" }],
      ["project", { canonicalProjectId: "project-2" }],
    ])("相同 contentHash 但不同 %s authority 均可写入", async (_dimension, authorityOverride) => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      await provider.initialize();
      await provider.applyScopeContentHashDedupeContract({ maintenance: true, quiescenceConfirmed: true });
      queryCalls.length = 0;
      businessInsertCount = 0;
      const result = await provider.store([
        makeEntry(),
        makeEntry({
          id: "00000000-0000-0000-0000-000000000002",
          ...authorityOverride,
        }),
      ]);

      expect(result.inserted).toBe(2);
      expect(result.duplicates).toBe(0);
      const inserts = queryCalls.filter((c) => /INSERT INTO\s+"memories"/.test(c.sql));
      expect(inserts).toHaveLength(2);
      expect(inserts[0]!.sql).toMatch(
        /ON CONFLICT \(tenant_id, user_id, canonical_project_id, product_id, producer_id, namespace, visibility, content_hash\) WHERE lifecycle_status = 'active' DO NOTHING/i,
      );
    });

    it("同一完整 authority 重复内容保持幂等并返回已存在记录 ID", async () => {
      businessInsertResults.push({ rows: [], rowCount: 0 });
      duplicateLookupResults.push({
        rows: [{ id: "00000000-0000-0000-0000-000000000099" }],
        rowCount: 1,
      });
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");

      const result = await provider.store([makeEntry()]);

      expect(result).toEqual({
        inserted: 0,
        duplicates: 1,
        records: [{
          requestedId: "00000000-0000-0000-0000-000000000001",
          persistedId: "00000000-0000-0000-0000-000000000099",
          stored: false,
        }],
      });
      const lookup = queryCalls.find((c) => /SELECT\s+id\s+FROM\s+"memories"/i.test(c.sql));
      expect(lookup?.sql).toMatch(/tenant_id = \$1[\s\S]+content_hash = \$8/i);
      expect(lookup?.sql).toMatch(/lifecycle_status = 'active'/i);
      expect(lookup?.sql).toMatch(/legacy_quarantine_reason IS NULL/i);
      expect(lookup?.params).toEqual([
        "tenant-1", "user-1", "project-1", "product-1", "producer-1", "memories", "private", "hash-1",
      ]);
    });

    it("v6 pending 下跨 authority 命中旧 global unique 时返回稳定 SCHEMA_CONTRACT_PENDING", async () => {
      businessInsertResults.push({ rows: [], rowCount: 0 });
      duplicateLookupResults.push({ rows: [], rowCount: 0 });
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");

      await expect(provider.store([makeEntry()])).rejects.toMatchObject({
        code: "SCHEMA_CONTRACT_PENDING",
      });
      const insert = queryCalls.find(({ sql }) => /INSERT INTO\s+"memories"/.test(sql));
      expect(insert?.sql).toMatch(/ON CONFLICT DO NOTHING/i);
      expect(insert?.sql).not.toMatch(/ON CONFLICT\s*\(/i);
    });

    it("ready 后 memories 仅用 active partial authority conflict target", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      await provider.initialize();
      await provider.applyScopeContentHashDedupeContract({ maintenance: true, quiescenceConfirmed: true });
      queryCalls.length = 0;

      await provider.store([makeEntry({ lifecycleStatus: "active" })]);

      const insert = queryCalls.find(({ sql }) => /INSERT INTO\s+"memories"/.test(sql));
      expect(insert?.sql).toMatch(
        /ON CONFLICT \(tenant_id, user_id, canonical_project_id, product_id, producer_id, namespace, visibility, content_hash\) WHERE lifecycle_status = 'active' DO NOTHING/i,
      );
    });

    it("evidence-only archived 写入使用 active partial arbiter，不与同文本 active 共享唯一身份", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      await provider.initialize();
      await provider.applyScopeContentHashDedupeContract({ maintenance: true, quiescenceConfirmed: true });
      queryCalls.length = 0;

      const result = await provider.store([makeEntry({
        lifecycleStatus: "archived",
        metadata: {
          ...TEST_EMBEDDING_FILTER,
          admissionRoute: "evidence_only",
          contextEligible: false,
        },
      })]);

      expect(result.inserted).toBe(1);
      const insert = queryCalls.find(({ sql }) => /INSERT INTO\s+"memories"/.test(sql));
      expect(insert?.sql).toMatch(
        /ON CONFLICT \(tenant_id, user_id, canonical_project_id, product_id, producer_id, namespace, visibility, content_hash\) WHERE lifecycle_status = 'active' DO NOTHING/i,
      );
      expect(insert?.params?.[21]).toBe("archived");
    });

    it("knowledge 保持 authority hash 全量唯一合同，不继承 memories lifecycle predicate", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      await provider.initialize();
      await provider.applyScopeContentHashDedupeContract({ maintenance: true, quiescenceConfirmed: true });
      queryCalls.length = 0;

      await provider.store([makeEntry({
        tableName: "knowledge",
        dataType: "knowledge",
        namespace: "knowledge",
      })]);

      const insert = queryCalls.find(({ sql }) => /INSERT INTO\s+"knowledge"/.test(sql));
      expect(insert?.sql).toMatch(
        /ON CONFLICT \(tenant_id, user_id, canonical_project_id, product_id, producer_id, namespace, visibility, content_hash\) DO NOTHING/i,
      );
      expect(insert?.sql).not.toMatch(/WHERE lifecycle_status = 'active'/i);
    });

    it("v6 后旧 binary 重建 global unique 时跨 scope 冲突转换为稳定 schema error", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      await provider.initialize();
      await provider.applyScopeContentHashDedupeContract({ maintenance: true, quiescenceConfirmed: true });
      queryCalls.length = 0;
      businessInsertCount = 0;
      failBusinessInsertAt = 1;
      businessInsertFailure = Object.assign(new Error("raw duplicate detail secret"), {
        code: "23505",
        constraint: "memories_content_hash_idx",
      });

      const error = await provider.store([makeEntry()]).catch((caught) => caught);
      expect(error).toMatchObject({ code: "SCHEMA_CONTRACT_INVALID" });
      expect(error.message).not.toContain("raw duplicate detail secret");
    });

    it("batch 第二条失败时回滚第一条且不提交", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      await provider.initialize();
      queryCalls.length = 0;
      businessInsertCount = 0;
      failBusinessInsertAt = 2;

      await expect(provider.store([
        makeEntry(),
        makeEntry({
          id: "00000000-0000-0000-0000-000000000002",
          contentHash: "hash-2",
        }),
      ])).rejects.toThrow("fake business insert failure");

      expect(queryCalls[0]?.sql).toBe("BEGIN");
      expect(queryCalls.at(-1)?.sql).toBe("ROLLBACK");
      expect(queryCalls.some((call) => call.sql === "COMMIT")).toBe(false);
    });
  });

  describe("query 按 scope 过滤", () => {
    it("普通/ANN/searchAll/count/content-hash 所有 read path 统一排除 legacy quarantine", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      await provider.query({ tableName: "memories" });
      await provider.query({ tableName: "memories", vector: [0.1, 0.2], filter: TEST_EMBEDDING_FILTER });
      await provider.query({ searchAll: true });
      await provider.existsByContentHash(["hash-1"]);
      await provider.count();

      const ordinary = queryCalls.filter(({ sql }) =>
        /SELECT \* FROM "(?:memories|knowledge)"/.test(sql));
      const ann = queryCalls.filter(({ sql }) => /vector <=>/.test(sql));
      const exists = queryCalls.filter(({ sql }) =>
        /SELECT content_hash FROM "(?:memories|knowledge)"/.test(sql));
      const counts = queryCalls.filter(({ sql }) =>
        /SELECT COUNT\(\*\)::int AS count FROM "(?:memories|knowledge)"/.test(sql));
      expect(ordinary.length).toBeGreaterThanOrEqual(3);
      expect(ann).toHaveLength(1);
      expect(exists).toHaveLength(2);
      expect(counts).toHaveLength(2);
      for (const call of [...ordinary, ...ann, ...exists, ...counts]) {
        expect(call.sql).toMatch(/legacy_quarantine_reason IS NULL/i);
      }
    });

    it("无 authority 的 ANN 也不能召回 quarantine 行，条件位于排序前", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      await provider.query({ vector: [0.1, 0.2], filter: TEST_EMBEDDING_FILTER });

      const select = queryCalls.find((call) => /vector <=>/.test(call.sql));
      expect(select?.sql).toMatch(/WHERE legacy_quarantine_reason IS NULL/i);
      expect(select!.sql.indexOf("legacy_quarantine_reason IS NULL"))
        .toBeLessThan(select!.sql.indexOf("ORDER BY vector <=>"));
    });

    it("ANN 缺省候选池大于 5，且 legacy final limit 不下推到 SQL", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      await provider.query({
        vector: [0.1, 0.2],
        limit: 5,
        minScore: undefined,
        filter: TEST_EMBEDDING_FILTER,
      });

      const select = queryCalls.find((call) => /vector <=>/.test(call.sql));
      expect(select?.params?.at(-1)).toBe(DEFAULT_VECTOR_CANDIDATE_LIMIT);
      expect(select?.params).not.toContain(5);
      expect(select?.sql).not.toMatch(/similarity\s*>=/i);
    });

    it("ANN candidateLimit 可显式配置且不复用 legacy final limit", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      await provider.query({
        vector: [0.1, 0.2],
        candidateLimit: 23,
        limit: 5,
        filter: TEST_EMBEDDING_FILTER,
      });

      const select = queryCalls.find((call) => /vector <=>/.test(call.sql));
      expect(select?.params?.at(-1)).toBe(23);
      expect(select?.params).not.toContain(5);
    });

    it("tenant/user authority 使用独立列参数化并在 LIMIT 前硬过滤", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      const maliciousTenant = "tenant' OR '1'='1";
      await provider.query({
        vector: [0.1, 0.2],
        limit: 5,
        tenantId: maliciousTenant,
        userId: "user-authority",
        filter: TEST_EMBEDDING_FILTER,
      });

      const select = queryCalls.find((call) => /<=>/.test(call.sql));
      expect(select).toBeDefined();
      expect(select!.sql).toMatch(/tenant_id = \$\d+[\s\S]+user_id = \$\d+[\s\S]+LIMIT \$\d+/);
      expect(select!.sql).not.toContain(maliciousTenant);
      expect(select!.params).toEqual(expect.arrayContaining([
        maliciousTenant,
        "user-authority",
        DEFAULT_VECTOR_CANDIDATE_LIMIT,
      ]));
    });

    it("tenant/user authority 必须成对提供", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      await expect(provider.query({ vector: [0.1, 0.2], tenantId: "tenant-only" }))
        .rejects.toThrow(/tenant.*user.*together|authority/i);
      expect(queryCalls.find((call) => /<=>/.test(call.sql))).toBeUndefined();
    });

    it("恶意 metadata key 不能通过 SQL 片段绕过 authority WHERE", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      await expect(provider.query({
        vector: [0.1, 0.2],
        tenantId: "tenant-a",
        userId: "user-a",
        filter: { ...TEST_EMBEDDING_FILTER, "x' OR TRUE --": "value" },
      })).rejects.toThrow(/metadata filter key is unsafe/i);
      expect(queryCalls.find((call) => /<=>/.test(call.sql))).toBeUndefined();
    });

    it("projectName 生成 project_name = $N 等值条件（参数化）", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      const options: MemoryQueryOptions = {
        vector: [0.1, 0.2],
        limit: 5,
        projectName: "memory-autodb",
        filter: TEST_EMBEDDING_FILTER,
      };

      await provider.query(options);

      const select = queryCalls.find((c) => /<=>/.test(c.sql));
      expect(select).toBeDefined();
      expect(select!.sql).toMatch(/project_name = \$\d+/);
      expect(select!.params).toContain("memory-autodb");
    });

    it("appName 生成 app_name = $N 等值条件", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      const options: MemoryQueryOptions = {
        vector: [0.1, 0.2],
        appName: "codex",
        filter: TEST_EMBEDDING_FILTER,
      };

      await provider.query(options);

      const select = queryCalls.find((c) => /<=>/.test(c.sql));
      expect(select!.sql).toMatch(/app_name = \$\d+/);
      expect(select!.params).toContain("codex");
    });

    it("ANN 在排序前用 metadata 绑定 embedding space ID/state", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      const options: MemoryQueryOptions = {
        vector: [0.1, 0.2],
        filter: {
          embeddingSpaceId: TEST_EMBEDDING_SPACE_ID,
          embeddingSpaceState: "known-queryable",
        },
      };

      await provider.query(options);

      const select = queryCalls.find((call) => /<=>/.test(call.sql));
      expect(select).toBeDefined();
      expect(select!.sql).toContain("embedding_space_id");
      expect(select!.sql).toContain("embedding_space_state");
      expect(select!.sql).toContain("metadata->>'embeddingSpaceId'");
      expect(select!.sql).toContain("metadata->>'embeddingSpaceState'");
      expect(select!.sql.indexOf("embedding_space_id")).toBeLessThan(
        select!.sql.indexOf("ORDER BY vector <=>"),
      );
      expect(select!.params).toEqual(expect.arrayContaining([
        TEST_EMBEDDING_SPACE_ID,
        "known-queryable",
      ]));
    });

    it("ANN 缺失完整 embedding space 硬过滤时在 SQL 前 fail-closed", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");

      await expect(provider.query({ vector: [0.1, 0.2] })).rejects.toThrow(/embedding.*filter/i);
      await expect(provider.query({
        vector: [0.1, 0.2],
        filter: { embeddingSpaceId: TEST_EMBEDDING_SPACE_ID },
      })).rejects.toThrow(/embedding.*filter/i);
      expect(queryCalls.find((call) => /vector <=>/.test(call.sql))).toBeUndefined();
    });

    it("ANN 拒绝用 reembedded 表示过程审计，已验证行只查 known-queryable", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");

      await expect(provider.query({
        vector: [0.1, 0.2],
        filter: {
          embeddingSpaceId: TEST_EMBEDDING_SPACE_ID,
          embeddingSpaceState: "reembedded",
        },
      })).rejects.toThrow(/known-queryable|embedding/i);
      expect(queryCalls.find((call) => /vector <=>/.test(call.sql))).toBeUndefined();
    });

    it("projectPattern 生成 project_name LIKE $N 模糊条件", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      const options: MemoryQueryOptions = {
        vector: [0.1, 0.2],
        projectPattern: "%openclaw%",
        filter: TEST_EMBEDDING_FILTER,
      };

      await provider.query(options);

      const select = queryCalls.find((c) => /<=>/.test(c.sql));
      expect(select!.sql).toMatch(/project_name LIKE \$\d+/);
      expect(select!.params).toContain("%openclaw%");
    });

    it("非向量查询也应用 scope 过滤", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      const options: MemoryQueryOptions = {
        projectName: "proj-x",
        limit: 10,
      };

      await provider.query(options);

      const select = queryCalls.find((c) => /ORDER BY created_at DESC/.test(c.sql));
      expect(select).toBeDefined();
      expect(select!.sql).toMatch(/project_name = \$\d+/);
      expect(select!.params).toContain("proj-x");
    });

    it("未传 scope 字段时不注入 scope 条件", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      await provider.query({ vector: [0.1, 0.2], filter: TEST_EMBEDDING_FILTER });

      const select = queryCalls.find((c) => /<=>/.test(c.sql));
      expect(select!.sql).not.toContain("project_name");
      expect(select!.sql).not.toContain("app_name");
    });

    it("rowToEntry 读回 scope 列", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      const results = await provider.query({ vector: [0.1, 0.2], filter: TEST_EMBEDDING_FILTER });

      expect(results).toHaveLength(1);
      expect(results[0].projectName).toBe("memory-autodb");
      expect(results[0].appName).toBe("claude-code");
      expect(results[0].userId).toBe("u1");
      expect(results[0].tenantId).toBe("tenant-1");
      expect(results[0].agentId).toBe("a1");
      expect(results[0].workspaceId).toBe("w1");
    });
  });

  describe("v11 provider-owned atomic memory write", () => {
    it("record insert 与 write audit/outbox/receipt 共用 provider PoolClient transaction", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      await provider.initialize();
      Object.assign(provider as unknown as Record<string, unknown>, {
        schemaVersion: 11,
        schemaContractState: "ready",
      });
      queryCalls.length = 0;
      const item: MemoryRecord = {
        id: "00000000-0000-4000-8000-000000000001",
        scope: {
          tenantId: "tenant-1",
          userId: "user-1",
          appId: "product-1",
          projectId: "project-1",
          agentId: "producer-1",
          namespace: "memories",
          visibility: "private",
          workspaceId: "workspace-1",
          sessionId: "session-1",
        },
        kind: "fact",
        text: "atomic memory",
        contentHash: "atomic-hash",
        importance: 0.8,
        category: "fact",
        dataType: "memory",
        tableName: "memories",
        metadata: { ...TEST_EMBEDDING_FILTER },
        provenance: { source: "user", createdAt: 1_000 },
        createdAt: 1_000,
        vector: [0.1, 0.2],
      };

      await expect(provider.createAtomicMemoryStorePort().store(item)).resolves.toEqual({
        id: item.id,
        stored: true,
      });

      const sql = queryCalls.map((call) => call.sql);
      expect(sql[0]).toBe("BEGIN");
      expect(sql.some((value) => /INSERT INTO\s+"memories"/.test(value))).toBe(true);
      expect(sql.some((value) => /INSERT INTO mengshu_write_audit/.test(value))).toBe(true);
      expect(sql.some((value) => /INSERT INTO mengshu_write_outbox/.test(value))).toBe(true);
      expect(sql.some((value) => /INSERT INTO mengshu_write_receipts/.test(value))).toBe(true);
      expect(sql.at(-1)).toBe("COMMIT");
    });
  });
});
