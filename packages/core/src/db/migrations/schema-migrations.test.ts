import { describe, expect, test } from "vitest";
import {
  CURRENT_SCHEMA_VERSION,
  SCHEMA_MIGRATIONS,
  planSchemaMigrations,
  schemaMigrationChecksum,
  validateMigrationRegistry,
  type SchemaMigration,
} from "./schema-migrations.js";

function migration(version: number, name = `migration-${version}`): SchemaMigration {
  return {
    version,
    name,
    kind: "expand",
    statements: [`CREATE TABLE IF NOT EXISTS test_${version} (id TEXT PRIMARY KEY)`],
  };
}

describe("schema migration registry", () => {
  test("内置 migration 从 1 连续递增，v6/v10 仅允许各自白名单 contract", () => {
    expect(validateMigrationRegistry(SCHEMA_MIGRATIONS, CURRENT_SCHEMA_VERSION)).toBeUndefined();
    expect(SCHEMA_MIGRATIONS.map((item) => item.version)).toEqual(
      Array.from({ length: CURRENT_SCHEMA_VERSION }, (_, index) => index + 1),
    );
    expect(SCHEMA_MIGRATIONS.slice(0, 5).every((item) => item.kind === "expand")).toBe(true);
    expect(SCHEMA_MIGRATIONS[5]?.kind).toBe("contract");
    expect(SCHEMA_MIGRATIONS.slice(6, 9).every((item) => item.kind === "expand")).toBe(true);
    expect(SCHEMA_MIGRATIONS[9]?.kind).toBe("contract");
    expect(SCHEMA_MIGRATIONS[10]?.kind).toBe("expand");
  });

  test.each([
    ["缺失", [migration(1), migration(3)]],
    ["重复", [migration(1), migration(1)]],
    ["乱序", [migration(2), migration(1)]],
  ])("拒绝%s migration registry", (_name, migrations) => {
    expect(() => validateMigrationRegistry(migrations, 2)).toThrow(/migration/i);
  });

  test("拒绝 destructive migration SQL", () => {
    const destructive = [{ ...migration(1), statements: ["DROP TABLE memories"] }];
    expect(() => validateMigrationRegistry(destructive, 1)).toThrow(/expand-only|DROP/i);
  });

  test("拒绝在 expand SQL 后拼接 destructive statement", () => {
    const smuggled = [{
      ...migration(1),
      statements: ["CREATE TABLE safe_table (id TEXT); DROP TABLE memories"],
    }];
    expect(() => validateMigrationRegistry(smuggled, 1)).toThrow(/expand-only|DROP/i);
  });

  test("拒绝 contract migration 删除非白名单表、约束或索引", () => {
    const unsafe = [{
      version: 1,
      name: "unsafe-contract",
      kind: "contract",
      statements: ["DROP INDEX IF EXISTS users_email_idx"],
    }] as SchemaMigration[];
    expect(() => validateMigrationRegistry(unsafe, 1)).toThrow(/allowlist|contract/i);
  });

  test("拒绝缺少新复合唯一键、只删除旧唯一键的 contract migration", () => {
    const incomplete = [{
      version: 1,
      name: "incomplete-contract",
      kind: "contract",
      statements: ["DROP INDEX IF EXISTS memories_content_hash_idx"],
    }] as SchemaMigration[];
    expect(() => validateMigrationRegistry(incomplete, 1)).toThrow(/complete|order|contract/i);
  });

  test("拒绝未知 migration kind", () => {
    const invalid = [{ ...migration(1), kind: "unsafe" }] as unknown as SchemaMigration[];
    expect(() => validateMigrationRegistry(invalid, 1)).toThrow(/kind/i);
  });

  test("v2 为 memories/knowledge 增加 nullable scope/producer/embedding/lifecycle 列", () => {
    const v2 = SCHEMA_MIGRATIONS.find((item) => item.version === 2);
    const requiredColumns = [
      "tenant_id",
      "canonical_project_id",
      "product_id",
      "producer_id",
      "namespace",
      "visibility",
      "lifecycle_status",
      "embedding_space_id",
      "embedding_space_state",
      "legacy_quarantine_reason",
      "scope_key",
    ];

    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(2);
    expect(v2?.name).toBe("add-scope-producer-embedding-lifecycle-columns");
    for (const table of ["memories", "knowledge"]) {
      for (const column of requiredColumns) {
        expect(v2?.statements).toContain(
          `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} TEXT`,
        );
      }
    }
  });

  test("v2 保持 expand-only：不回填、不删改旧列、不加 NOT NULL/default/scope 唯一键", () => {
    const statements = SCHEMA_MIGRATIONS.find((item) => item.version === 2)!.statements;
    const sql = statements.join("\n");
    const columnSql = statements.filter((statement) => /^ALTER TABLE/i.test(statement)).join("\n");

    expect(sql).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE|UPDATE|RENAME)\b/i);
    expect(columnSql).not.toMatch(/\bNOT\s+NULL\b|\bDEFAULT\b/i);
    expect(sql).not.toMatch(/CREATE\s+UNIQUE\s+INDEX|UNIQUE\s*\([^)]*scope_key/i);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS/);
    expect(sql).toMatch(/scope_key/);
    expect(sql).toMatch(/embedding_space_id/);
    expect(sql).toMatch(/lifecycle_status/);
  });

  test("v2 checksum 固定且以 v2 为目标时 v1 ledger 只计划 v2", () => {
    const [v1, v2] = SCHEMA_MIGRATIONS;
    const plan = planSchemaMigrations([
      { version: v1!.version, name: v1!.name, checksum: schemaMigrationChecksum(v1!) },
    ], { migrations: [v1!, v2!], currentSchemaVersion: 2 });

    expect(v2?.checksum).toBe(schemaMigrationChecksum(v2!));
    expect(plan).toEqual({
      fromVersion: 1,
      toVersion: 2,
      currentSchemaVersion: 2,
      pending: [v2],
    });
  });

  test("v3 expand-only 新增 embedding descriptor registry 与 singleton active pointer", () => {
    const v3 = SCHEMA_MIGRATIONS.find((item) => item.version === 3);
    const sql = v3?.statements.join("\n") ?? "";

    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(3);
    expect(v3?.name).toBe("add-active-embedding-space-registry");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS mengshu_embedding_spaces");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS mengshu_active_embedding_space");
    expect(sql).toMatch(/embedding_space_id TEXT PRIMARY KEY/);
    expect(sql).toMatch(/singleton_key TEXT PRIMARY KEY/);
    expect(sql).toMatch(/REFERENCES mengshu_embedding_spaces/);
    expect(sql).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE|UPDATE|RENAME)\b/i);
  });

  test("v4 expand-only 新增 transactional forget audit/outbox/receipt 表", () => {
    const v4 = SCHEMA_MIGRATIONS.find((item) => item.version === 4);
    const sql = v4?.statements.join("\n") ?? "";

    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(4);
    expect(v4?.name).toBe("add-transactional-forget-journal");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS mengshu_forget_audit");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS mengshu_forget_outbox");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS mengshu_forget_receipts");
    expect(sql).toMatch(/idempotency_key TEXT PRIMARY KEY/);
    expect(sql).toMatch(/event_id TEXT PRIMARY KEY/);
    expect(sql).toMatch(/request_fingerprint TEXT NOT NULL/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS mengshu_forget_outbox_pending_idx/);
    expect(sql).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE|UPDATE|RENAME)\b/i);
  });

  test("v5 expand-only 新增独立 durable job v2 表且完整持久化 scope/fence/error 合同", () => {
    const v5 = SCHEMA_MIGRATIONS.find((item) => item.version === 5);
    const sql = v5?.statements.join("\n") ?? "";

    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(5);
    expect(v5?.name).toBe("add-durable-job-v2-queue");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS mengshu_jobs_v2");
    expect(sql).not.toMatch(/ALTER TABLE\s+mengshu_jobs\b/i);
    for (const column of [
      "id TEXT PRIMARY KEY",
      "type TEXT NOT NULL",
      "payload JSONB NOT NULL",
      "dedupe_key TEXT NOT NULL",
      "scoped_dedupe_key TEXT NOT NULL",
      "tenant_id TEXT NOT NULL",
      "user_id TEXT NOT NULL",
      "app_id TEXT NOT NULL",
      "project_id TEXT NOT NULL",
      "agent_id TEXT NOT NULL",
      "namespace TEXT NOT NULL",
      "visibility TEXT NOT NULL",
      "attempts INTEGER NOT NULL",
      "lease_generation INTEGER NOT NULL",
      "max_attempts INTEGER NOT NULL",
      "next_attempt_at BIGINT",
      "lease_owner TEXT",
      "lease_token TEXT",
      "lease_until BIGINT",
      "heartbeat_at BIGINT",
      "last_error_code TEXT",
      "last_error_retryable BOOLEAN",
      "last_error_fingerprint TEXT",
      "created_at BIGINT NOT NULL",
      "updated_at BIGINT NOT NULL",
    ]) {
      expect(sql).toContain(column);
    }
    expect(sql).toMatch(/jsonb_typeof\(payload\)\s*=\s*'object'/i);
    expect(sql).toMatch(/visibility IN \('private', 'workspace', 'team', 'public'\)/i);
    for (const field of [
      "tenant_id",
      "user_id",
      "app_id",
      "project_id",
      "agent_id",
      "namespace",
    ]) {
      expect(sql).toMatch(new RegExp(
        `char_length\\(${field}\\) BETWEEN 1 AND 256[\\s\\S]+${field} !~ '\\[\\[:space:\]\\[:cntrl:\]\\]'`,
        "i",
      ));
    }
    expect(sql).toMatch(/status IN \('queued', 'retry_wait', 'running', 'completed', 'dead_letter'\)/i);
    expect(sql).toMatch(/lease_generation\s*=\s*attempts/i);
    expect(sql).toMatch(/attempts\s*<=\s*max_attempts/i);
    expect(sql).toMatch(/updated_at\s*>=\s*created_at/i);
    expect(sql).toMatch(/lease_until\s*>\s*heartbeat_at/i);
    expect(sql).toMatch(/lease_until\s*>\s*updated_at/i);
    expect(sql).toMatch(/next_attempt_at\s*>=\s*updated_at/i);
    expect(sql).toMatch(/attempts\s*<\s*max_attempts/i);
    expect(sql).toMatch(/last_error_fingerprint\s*~\s*'\^\[0-9a-f\]\{64\}\$'/i);
    expect(sql).toMatch(/lease_token\s*~\s*'\^\[A-Za-z0-9\._~-\]\{32,256\}\$'/i);
    expect(sql).toMatch(/lease_owner\s*~\s*'\^\[A-Za-z0-9\]\[A-Za-z0-9\._:@\/-\]\{0,127\}\$'/i);
    expect(sql).toMatch(/last_error_code IS NULL[\s\S]+last_error_retryable IS NULL[\s\S]+last_error_fingerprint IS NULL/i);
  });

  test("v5 scoped dedupe 仅以 opaque hash 唯一，ready/status 查询使用 partial indexes", () => {
    const sql = SCHEMA_MIGRATIONS.find((item) => item.version === 5)!.statements.join("\n");

    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS mengshu_jobs_v2_scoped_dedupe_uidx\s+ON mengshu_jobs_v2 \(scoped_dedupe_key\)/i,
    );
    expect(sql).not.toMatch(/UNIQUE\s*\(dedupe_key\)|UNIQUE INDEX[^\n]+\(dedupe_key\)/i);
    expect(sql).toMatch(/mengshu_jobs_v2_queued_idx[\s\S]+WHERE status = 'queued'/i);
    expect(sql).toMatch(/mengshu_jobs_v2_retry_idx[\s\S]+WHERE status = 'retry_wait'/i);
    expect(sql).toMatch(/mengshu_jobs_v2_expired_lease_idx[\s\S]+WHERE status = 'running'/i);
    expect(sql).toMatch(
      /mengshu_jobs_v2_status_updated_idx[\s\S]+WHERE status IN \('completed', 'dead_letter'\)/i,
    );
  });

  test("v5 quarantine 只存 sanitized 审计信息，不复制原始 error/payload", () => {
    const v5 = SCHEMA_MIGRATIONS.find((item) => item.version === 5)!;
    const sql = v5.statements.join("\n");
    const quarantine = v5.statements.find((statement) =>
      statement.includes("CREATE TABLE IF NOT EXISTS mengshu_jobs_v2_legacy_quarantine"),
    ) ?? "";

    expect(quarantine).toContain("legacy_job_id TEXT NOT NULL");
    expect(quarantine).toContain("legacy_status TEXT NOT NULL");
    expect(quarantine).toContain("reason_code TEXT NOT NULL");
    expect(quarantine).toContain("error_fingerprint TEXT");
    expect(quarantine).toContain("sanitized_metadata JSONB NOT NULL");
    expect(quarantine).toContain("resolution TEXT");
    expect(quarantine).toContain("resolved_at BIGINT");
    expect(quarantine).not.toMatch(/\b(?:raw_error|error_message|payload)\b/i);
    expect(quarantine).not.toMatch(/(?:^|\s)error\s+TEXT\b/i);
    expect(sql).toMatch(/mengshu_jobs_v2_legacy_quarantine_reason_idx/i);
    expect(sql).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE|UPDATE|RENAME)\b/i);
  });

  test("v5 append 不改变 v1-v4 checksum，v4 ledger 仅计划 v5", () => {
    expect(SCHEMA_MIGRATIONS.slice(0, 4).map((item) => item.checksum)).toEqual([
      "579838a230d7e915c1a82d7937d42d04b73dcd0a7682b0320ba8920444c04b55",
      "351de9a732b876ac7ebcfe68e6aad89cbacf56c416c32482e504dd07d674db74",
      "dfdca1eee72077512614cedd89a7f832fc3e5ef0579fc4c600ec74ae8cad2491",
      "a448b7db685ab929bb47b6851018a633df3bd0aa1bc87f42961d22dd8d4dfb2c",
    ]);
    const appliedV4 = SCHEMA_MIGRATIONS.slice(0, 4).map((item) => ({
      version: item.version,
      name: item.name,
      checksum: schemaMigrationChecksum(item),
    }));
    const plan = planSchemaMigrations(appliedV4, {
      migrations: SCHEMA_MIGRATIONS.slice(0, 5),
      currentSchemaVersion: 5,
    });

    expect(plan.fromVersion).toBe(4);
    expect(plan.toVersion).toBe(5);
    expect(plan.pending.map((item) => item.version)).toEqual([5]);
  });

  test("v6 用完整 canonical authority + content_hash 建复合唯一键后移除旧全局唯一键", () => {
    const v6 = SCHEMA_MIGRATIONS.find((item) => item.version === 6);
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(6);
    expect(v6?.name).toBe("scope-content-hash-dedupe");
    expect(v6?.kind).toBe("contract");

    for (const table of ["memories", "knowledge"]) {
      const statements = v6!.statements.filter((statement) => statement.includes(table));
      expect(statements[0]).toMatch(new RegExp(
        `CREATE UNIQUE INDEX ${table}_authority_content_hash_uidx ON ${table} ` +
        `\\(tenant_id, user_id, canonical_project_id, product_id, producer_id, namespace, visibility, content_hash\\)`,
        "i",
      ));
      expect(statements[0]).not.toMatch(/IF NOT EXISTS/i);
      expect(statements).toContain(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_content_hash_key`);
      expect(statements).toContain(`DROP INDEX IF EXISTS ${table}_content_hash_idx`);
    }

    const sql = v6!.statements.join("\n");
    expect(sql).not.toMatch(/UPDATE|COALESCE|SET\s+tenant_id/i);
    expect(sql).not.toMatch(/NULLS\s+NOT\s+DISTINCT/i);
    expect(sql).not.toMatch(/knowledge_[a-z0-9_]+_authority_content_hash/i);
  });

  test("v6 append 不改变 v1-v5 checksum，v5 ledger 只计划 v6", () => {
    const appliedV5 = SCHEMA_MIGRATIONS.slice(0, 5).map((item) => ({
      version: item.version,
      name: item.name,
      checksum: schemaMigrationChecksum(item),
    }));
    const plan = planSchemaMigrations(appliedV5, {
      migrations: SCHEMA_MIGRATIONS.slice(0, 6),
      currentSchemaVersion: 6,
    });

    expect(plan.fromVersion).toBe(5);
    expect(plan.toVersion).toBe(6);
    expect(plan.pending.map((item) => item.version)).toEqual([6]);
  });

  test("v7 expand-only 新增 job effect receipt，且不持久化 lease token", () => {
    const v7 = SCHEMA_MIGRATIONS.find((item) => item.version === 7);
    const sql = v7?.statements.join("\n") ?? "";

    expect(v7?.name).toBe("add-durable-job-v2-effect-receipts");
    expect(v7?.kind).toBe("expand");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS mengshu_job_v2_effect_receipts");
    expect(sql).toMatch(/PRIMARY KEY \(job_id, effect_key\)/i);
    expect(sql).toMatch(/request_fingerprint TEXT NOT NULL/i);
    expect(sql).toMatch(/lease_generation INTEGER NOT NULL/i);
    expect(sql).toMatch(/result JSONB NOT NULL/i);
    expect(sql).toMatch(/REFERENCES mengshu_jobs_v2 \(id\)/i);
    expect(sql).not.toMatch(/lease_token/i);
    expect(sql).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE|UPDATE|RENAME)\b/i);
  });

  test("v8 expand-only 新增 canonical durable candidate zone 与确定 pending 唯一键", () => {
    const v8 = SCHEMA_MIGRATIONS.find((item) => item.version === 8);
    const sql = v8?.statements.join("\n") ?? "";

    expect(v8?.name).toBe("add-durable-candidate-zone");
    expect(v8?.kind).toBe("expand");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS mengshu_candidates");
    for (const column of [
      "id TEXT PRIMARY KEY",
      "tenant_id TEXT NOT NULL",
      "user_id TEXT NOT NULL",
      "app_id TEXT NOT NULL",
      "project_id TEXT NOT NULL",
      "agent_id TEXT NOT NULL",
      "namespace TEXT NOT NULL",
      "visibility TEXT NOT NULL",
      "workspace_id TEXT NOT NULL DEFAULT ''",
      "session_id TEXT NOT NULL DEFAULT ''",
      "source_job_id TEXT REFERENCES mengshu_jobs_v2 (id)",
      "content_hash TEXT NOT NULL",
      "active_content_hash TEXT",
      "evidence_ids JSONB NOT NULL",
      "extractor TEXT",
      "metadata JSONB NOT NULL",
      "created_at BIGINT NOT NULL",
    ]) {
      expect(sql).toContain(column);
    }
    expect(sql).toMatch(/status IN \('pending', 'approved', 'rejected', 'archived', 'expired'\)/i);
    expect(sql).toMatch(/jsonb_typeof\(evidence_ids\) = 'array'/i);
    expect(sql).toMatch(/jsonb_typeof\(metadata\) = 'object'/i);
    expect(sql).toMatch(/active_content_hash = content_hash/i);
    expect(sql).toMatch(/workspace_id = '' OR \(char_length\(workspace_id\) BETWEEN 1 AND 256/i);
    expect(sql).toMatch(/session_id = '' OR \(char_length\(session_id\) BETWEEN 1 AND 256/i);
    expect(sql).toMatch(/char_length\(kind\) BETWEEN 1 AND 256/i);
    expect(sql).toMatch(/reason IS NULL OR char_length\(reason\) <= 2000/i);
    expect(sql).toMatch(/extractor IS NULL OR \(char_length\(extractor\) BETWEEN 1 AND 256/i);
    expect(sql).toMatch(/promoted_to_memory_id IS NULL OR \(char_length\(promoted_to_memory_id\) BETWEEN 1 AND 256/i);
    expect(sql).toMatch(/btrim\(text\) <> ''/i);
    expect(sql).toMatch(
      /UNIQUE \(tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility, workspace_id, session_id, active_content_hash\)/i,
    );
    expect(sql).toMatch(/mengshu_candidates_scope_status_created_idx/i);
    expect(sql).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE|UPDATE|RENAME)\b/i);
  });

  test("v8 append 不改变 v1-v7 checksum，v7 ledger 只计划 v8", () => {
    expect(SCHEMA_MIGRATIONS.slice(0, 7).map((item) => item.checksum)).toEqual([
      "579838a230d7e915c1a82d7937d42d04b73dcd0a7682b0320ba8920444c04b55",
      "351de9a732b876ac7ebcfe68e6aad89cbacf56c416c32482e504dd07d674db74",
      "dfdca1eee72077512614cedd89a7f832fc3e5ef0579fc4c600ec74ae8cad2491",
      "a448b7db685ab929bb47b6851018a633df3bd0aa1bc87f42961d22dd8d4dfb2c",
      "b98b8d4f4c23f3f1978ea8653bb73f64b3cb8fcb566411c50e725fbd2c37b4c2",
      "0e1b2fa7016cddc9da9b324bf5d0531f3c70329ecf024cc3b7b4858a72f49e93",
      "c15af146bef3270f1a8e39d138bf1628eb8fb0cb816d351daa748ab8538c9da7",
    ]);
    const appliedV7 = SCHEMA_MIGRATIONS.slice(0, 7).map(({ version, name, checksum }) => ({
      version,
      name,
      checksum: checksum!,
    }));

    const plan = planSchemaMigrations(appliedV7, {
      migrations: SCHEMA_MIGRATIONS.slice(0, 8),
      currentSchemaVersion: 8,
    });

    expect(plan.fromVersion).toBe(7);
    expect(plan.toVersion).toBe(8);
    expect(plan.pending.map((item) => item.version)).toEqual([8]);
  });

  test("v9 expand-only 新增 provider-owned canonical tree/graph relations", () => {
    const v9 = SCHEMA_MIGRATIONS.find((item) => item.version === 9);
    const sql = v9?.statements.join("\n") ?? "";

    expect(v9?.name).toBe("add-durable-tree-and-graph");
    expect(v9?.kind).toBe("expand");
    for (const relation of [
      "mengshu_tree_leaves",
      "mengshu_tree_buffers",
      "mengshu_tree_summary_nodes",
      "mengshu_graph_entities",
      "mengshu_graph_relations",
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${relation}`);
    }
    for (const column of [
      "scope_fingerprint TEXT NOT NULL",
      "tenant_id TEXT NOT NULL",
      "user_id TEXT NOT NULL",
      "app_id TEXT NOT NULL",
      "project_id TEXT NOT NULL",
      "agent_id TEXT NOT NULL",
      "namespace TEXT NOT NULL",
      "visibility TEXT NOT NULL",
      "workspace_id TEXT NOT NULL DEFAULT ''",
      "session_id TEXT NOT NULL DEFAULT ''",
    ]) {
      expect(sql.match(new RegExp(column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length)
        .toBeGreaterThanOrEqual(5);
    }
    expect(sql.match(/PRIMARY KEY \(scope_fingerprint, id\)/gi)?.length).toBe(5);
    expect(sql).toMatch(/UNIQUE \(scope_fingerprint, tree_type, tree_key, level\)/i);
    expect(sql).toMatch(/REFERENCES mengshu_graph_entities \(scope_fingerprint, id\)/i);
    expect(sql).not.toMatch(/CREATE TABLE IF NOT EXISTS (?:tree_leaves|tree_buffers|summary_nodes)\b/i);
    expect(sql).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE|UPDATE|RENAME)\b/i);
  });

  test("v11 append 不改变 v1-v10 checksum，v8 ledger 依次计划 v9/v10/v11", () => {
    const appliedV8 = SCHEMA_MIGRATIONS.slice(0, 8).map(({ version, name, checksum }) => ({
      version,
      name,
      checksum: checksum!,
    }));
    const plan = planSchemaMigrations(appliedV8, {
      migrations: SCHEMA_MIGRATIONS.slice(0, 11),
      currentSchemaVersion: 11,
    });

    expect(plan.fromVersion).toBe(8);
    expect(plan.toVersion).toBe(11);
    expect(plan.pending.map((item) => item.version)).toEqual([9, 10, 11]);
    const v10Sql = SCHEMA_MIGRATIONS[9]?.statements.join("\n") ?? "";
    expect(v10Sql).toContain("DROP CONSTRAINT IF EXISTS mengshu_jobs_v2_check4");
    expect(v10Sql).toContain("char_length(lease_token) BETWEEN 32 AND 256");
    expect(v10Sql).toContain("lease_token ~ '^[A-Za-z0-9._~-]+$'");
    expect(v10Sql).not.toContain("{32,256}");
    const v11Sql = SCHEMA_MIGRATIONS[10]?.statements.join("\n") ?? "";
    expect(v11Sql).toContain("CREATE TABLE IF NOT EXISTS mengshu_write_receipts");
    expect(v11Sql).toContain("CREATE TABLE IF NOT EXISTS mengshu_write_audit");
    expect(v11Sql).toContain("CREATE TABLE IF NOT EXISTS mengshu_write_outbox");
  });

  test("v12 expand-only 为重嵌入保留可回滚 shadow 快照和独立审计 receipt", () => {
    const v12 = SCHEMA_MIGRATIONS.find((item) => item.version === 12);
    const sql = v12?.statements.join("\n") ?? "";

    expect(CURRENT_SCHEMA_VERSION).toBe(12);
    expect(v12?.name).toBe("add-embedding-reembed-shadow-journal");
    expect(v12?.kind).toBe("expand");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS mengshu_embedding_reembed_shadow");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS mengshu_embedding_reembed_receipts");
    for (const rollbackField of [
      "old_vector vector NOT NULL",
      "old_embedding_space_id TEXT",
      "old_embedding_space_state TEXT",
      "old_metadata JSONB NOT NULL",
      "source_content_hash TEXT NOT NULL",
    ]) {
      expect(sql).toContain(rollbackField);
    }
    expect(sql).toMatch(/operation IN \('validated', 'applied', 'rolled-back'\)/i);
    expect(sql).toMatch(/target_embedding_space_id TEXT NOT NULL REFERENCES mengshu_embedding_spaces/i);
    expect(sql).toMatch(/target_vector_sha256 TEXT NOT NULL/i);
    expect(sql).toMatch(/source_snapshot_sha256 TEXT NOT NULL/i);
    expect(sql).not.toMatch(/embedding_space_state[^\n]+reembedded[\s\S]+operation/i);
    expect(sql).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE|UPDATE|RENAME)\b/i);
  });

  test("v12 append 不改变 v1-v11 checksum，v11 ledger 只计划 v12", () => {
    expect(SCHEMA_MIGRATIONS.slice(0, 11).map((item) => item.checksum)).toEqual([
      "579838a230d7e915c1a82d7937d42d04b73dcd0a7682b0320ba8920444c04b55",
      "351de9a732b876ac7ebcfe68e6aad89cbacf56c416c32482e504dd07d674db74",
      "dfdca1eee72077512614cedd89a7f832fc3e5ef0579fc4c600ec74ae8cad2491",
      "a448b7db685ab929bb47b6851018a633df3bd0aa1bc87f42961d22dd8d4dfb2c",
      "b98b8d4f4c23f3f1978ea8653bb73f64b3cb8fcb566411c50e725fbd2c37b4c2",
      "0e1b2fa7016cddc9da9b324bf5d0531f3c70329ecf024cc3b7b4858a72f49e93",
      "c15af146bef3270f1a8e39d138bf1628eb8fb0cb816d351daa748ab8538c9da7",
      "6abe4c875385418efaf2b5a195c68a30cdc377f8d080db6b25d5832da87417a2",
      "f70c1d636493d2379dbcd88043853343828d86f06c6a8bdecac5a9f099b1397f",
      "e2325803791bd7ac34ee723c9d81cf26c9a3163d54167741ee10183dfcd72ded",
      "8b0284e17cd4e6efe4dcda913d91779735d99f9e477484f1445d41b6b45607c5",
    ]);
    const appliedV11 = SCHEMA_MIGRATIONS.slice(0, 11).map(({ version, name, checksum }) => ({
      version,
      name,
      checksum: checksum!,
    }));

    expect(planSchemaMigrations(appliedV11)).toMatchObject({
      fromVersion: 11,
      toVersion: 12,
      pending: [SCHEMA_MIGRATIONS[11]],
    });
  });
});

describe("planSchemaMigrations", () => {
  test("空 ledger 生成确定的 dry-run plan 且不含时间等瞬态字段", () => {
    const first = planSchemaMigrations([]);
    const second = planSchemaMigrations([]);

    expect(second).toEqual(first);
    expect(first).toEqual({
      fromVersion: 0,
      toVersion: CURRENT_SCHEMA_VERSION,
      currentSchemaVersion: CURRENT_SCHEMA_VERSION,
      pending: SCHEMA_MIGRATIONS,
    });
    expect(first).not.toHaveProperty("appliedAt");
    expect(first.pending.every((item) => !("appliedAt" in item))).toBe(true);
  });

  test("已完整应用时 plan 为空并保持 current version", () => {
    const applied = SCHEMA_MIGRATIONS.map((item) => ({
      version: item.version,
      name: item.name,
      checksum: schemaMigrationChecksum(item),
    }));

    expect(planSchemaMigrations(applied)).toEqual({
      fromVersion: CURRENT_SCHEMA_VERSION,
      toVersion: CURRENT_SCHEMA_VERSION,
      currentSchemaVersion: CURRENT_SCHEMA_VERSION,
      pending: [],
    });
  });

  test("未知或超前 schema version fail-closed", () => {
    expect(() =>
      planSchemaMigrations([
        { version: CURRENT_SCHEMA_VERSION + 1, name: "future", checksum: "future" },
      ]),
    ).toThrow(/newer|unknown|超前/i);
  });

  test("ledger checksum 与 registry 不一致时 fail-closed", () => {
    const current = SCHEMA_MIGRATIONS[0]!;
    expect(() =>
      planSchemaMigrations([
        { version: current.version, name: current.name, checksum: "tampered" },
      ]),
    ).toThrow(/checksum/i);
  });

  test("ledger 缺失、重复或乱序版本时 fail-closed", () => {
    const migrations = [migration(1), migration(2)];
    const registry = appliedRows(migrations);

    expect(() => planSchemaMigrations([registry[1]!], { migrations, currentSchemaVersion: 2 }))
      .toThrow(/missing|prefix|缺失/i);
    expect(() => planSchemaMigrations([registry[0]!, registry[0]!], { migrations, currentSchemaVersion: 2 }))
      .toThrow(/duplicate|重复/i);
    expect(() => planSchemaMigrations([registry[1]!, registry[0]!], { migrations, currentSchemaVersion: 2 }))
      .toThrow(/order|乱序/i);
  });
});

function appliedRows(migrations: SchemaMigration[]) {
  validateMigrationRegistry(migrations, migrations.length);
  return migrations.map((item) => ({
    version: item.version,
    name: item.name,
    checksum: schemaMigrationChecksum(item),
  }));
}
