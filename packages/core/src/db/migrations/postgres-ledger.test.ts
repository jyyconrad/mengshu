import { describe, expect, test } from "vitest";
import {
  AUTHORITY_DEDUPE_INDEX_CATALOG_SQL,
  DURABLE_JOB_STATE_SCHEMA_CATALOG_SQL,
  DURABLE_DOMAIN_REQUIRED_COLUMNS,
  DURABLE_DOMAIN_SCHEMA_CATALOG_SQL,
  EMBEDDING_REEMBED_REQUIRED_COLUMNS,
  WRITE_JOURNAL_REQUIRED_COLUMNS,
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
  jobStateCatalogRows?: Record<string, unknown>[];

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
      const rows = this.catalogRows ?? ["memories", "knowledge"].flatMap((table) => [
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
      return { rows: [...rows] as Row[], rowCount: rows.length };
    }
    if (sql === DURABLE_DOMAIN_SCHEMA_CATALOG_SQL) {
      const requestedTables = Array.isArray(params[0]) ? params[0] as string[] : [];
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
        const writeRows = this.writeCatalogRows ?? rows;
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
    expect(result.pendingContractVersions).toEqual([6, 10]);
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

    expect(result.appliedVersions).toEqual([6, 7, 8, 9, 10, 11, 12]);
    expect(result.toVersion).toBe(12);
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

  test("maintenance 完成 v6-v12 后再次启动幂等，并复核 authority 与 job state catalog", async () => {
    const client = new FakePostgresClient();
    await executePostgresMigrations(client);
    await executePostgresMigrations(client, {
      contractMigration: { mode: "apply", maintenance: true, quiescenceConfirmed: true },
    });
    const ledgerWrites = client.calls.filter((call) => call.sql === INSERT_MIGRATION_SQL).length;

    const restarted = await executePostgresMigrations(client);

    expect(restarted.appliedVersions).toEqual([]);
    expect(restarted.toVersion).toBe(12);
    expect(restarted.pendingContractVersions).toEqual([]);
    expect(client.calls.filter((call) => call.sql === INSERT_MIGRATION_SQL)).toHaveLength(ledgerWrites);
    expect(client.calls.filter((call) => call.sql === AUTHORITY_DEDUPE_INDEX_CATALOG_SQL).length)
      .toBeGreaterThanOrEqual(2);
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
