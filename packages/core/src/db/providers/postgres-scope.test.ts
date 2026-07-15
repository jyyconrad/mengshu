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
  DURABLE_DOMAIN_REQUIRED_COLUMNS,
  EMBEDDING_REEMBED_REQUIRED_COLUMNS,
  WRITE_JOURNAL_REQUIRED_COLUMNS,
} from "../migrations/postgres-ledger.js";

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
    const rows = requestedTables.includes("mengshu_embedding_reembed_shadow")
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
    const rows = catalogRows ?? ["memories", "knowledge"].flatMap((table) => [
      {
        table_name: table, index_name: `${table}_pkey`, is_unique: true,
        is_valid: true, is_ready: true, predicate: null, index_columns: ["id"],
      },
      contractDdlApplied
        ? {
            table_name: table, index_name: `${table}_authority_content_hash_uidx`, is_unique: true,
            is_valid: true, is_ready: true, predicate: null,
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
        targetVersion: 12,
        scopeContentHashDedupe: "pending",
      });
      expect(queryCalls.some(({ sql }) => /CREATE UNIQUE INDEX memories_authority_content_hash_uidx/.test(sql)))
        .toBe(false);
    });

    it("显式 maintenance/quiescence 路径连续应用 v6-v11 并切换 ready", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      await provider.initialize();

      await expect(provider.applyScopeContentHashDedupeContract({
        maintenance: true,
        quiescenceConfirmed: true,
      })).resolves.toMatchObject({ scopeContentHashDedupe: "ready", currentVersion: 12 });

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
      // 参数顺序：[..., project_name, app_name, user_id, agent_id, workspace_id]
      const params = insert!.params!;
      expect(params).toContain("memory-autodb");
      expect(params).toContain("claude-code");
      expect(params).toContain("user-1");
      expect(params).toContain("agent-1");
      expect(params).toContain("ws-1");
      expect(params.slice(14, 21)).toEqual([
        "tenant-a",
        "memory-autodb",
        "claude-code",
        "agent-1",
        "memories",
        "private",
        null,
      ]);
      expect(insert!.sql).toContain("embedding_space_id");
      expect(insert!.sql).toContain("embedding_space_state");
      expect(params.slice(21, 23)).toEqual([
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
        /ON CONFLICT \(tenant_id, user_id, canonical_project_id, product_id, producer_id, namespace, visibility, content_hash\) DO NOTHING/i,
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

    it("v6 ready 后 store 使用精确完整 authority conflict target", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      await provider.initialize();
      await provider.applyScopeContentHashDedupeContract({ maintenance: true, quiescenceConfirmed: true });
      queryCalls.length = 0;

      await provider.store([makeEntry()]);

      const insert = queryCalls.find(({ sql }) => /INSERT INTO\s+"memories"/.test(sql));
      expect(insert?.sql).toMatch(
        /ON CONFLICT \(tenant_id, user_id, canonical_project_id, product_id, producer_id, namespace, visibility, content_hash\) DO NOTHING/i,
      );
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
      expect(select!.params).toEqual(expect.arrayContaining([maliciousTenant, "user-authority", 5]));
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
