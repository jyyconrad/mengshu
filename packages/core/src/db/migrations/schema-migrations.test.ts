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
  test("v37 adds bounded governance metadata and per-event evolution consumption without rewriting v36", () => {
    const change = SCHEMA_MIGRATIONS.find((item) => item.version === 37);
    expect(change?.name).toBe("add-evolution-governance-and-maintenance");
    expect(change?.kind).toBe("expand");
    const sql = change?.statements.join("\n") ?? "";
    for (const value of ["mengshu_evolution_reviews", "evolution_consumed_at", "evolution_origin", "evolution_review_due_at",
      "relation_state", "root_evidence_id", "mengshu_evolution_source_dispositions", "mengshu_evolution_operation_receipts", "mengshu_evolution_budget_reservations",
      "mengshu_evolution_host_state", "mengshu_evolution_host_receipts", "value_hash", "consumed_by", "UNIQUE (owner_key, scope_fingerprint, receipt_id)"]) expect(sql).toContain(value);
    expect(sql).not.toMatch(/\b(?:DELETE|TRUNCATE|UPDATE|DROP)\b/i);
    expect(sql).toContain("octet_length");
    expect(sql).not.toContain("source_text");
    expect(SCHEMA_MIGRATIONS.find((item) => item.version === 36)?.name).toBe("add-memory-evolution-batches");
  });
  test("v36 isolates evolution state, receipts and processed fingerprints without canonical evidence writes", () => {
    const migration = SCHEMA_MIGRATIONS.find((item) => item.version === 36);
    expect(migration?.name).toBe("add-memory-evolution-batches");
    const sql = migration?.statements.join("\n") ?? "";
    for (const name of ["mengshu_evolution_batches", "mengshu_evolution_apply_receipts", "mengshu_evolution_processed_inputs"]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${name}`);
    }
    expect(sql).toContain("fencing_token BIGINT");
    expect(sql).toContain("UNIQUE (scope_fingerprint, idempotency_key)");
    expect(sql).toContain("PRIMARY KEY (scope_fingerprint, input_fingerprint, action)");
    expect(sql).toContain("octet_length");
    expect(sql).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE|UPDATE|RENAME|INSERT)\b/i);
    expect(sql).not.toContain("ALTER TABLE mengshu_memory_evidence_links");
  });

  test("v35 persists content-free purge retry requests with backoff state", () => {
    const v35 = SCHEMA_MIGRATIONS.find((item) => item.version === 35);
    const sql = v35?.statements.join("\n") ?? "";
    expect(v35?.name).toBe("add-temporal-purge-retry-requests");
    expect(sql).toContain("mengshu_memory_purge_retry_requests");
    expect(sql).toContain("version_ids JSONB");
    expect(sql).toContain("next_attempt_at BIGINT");
    expect(sql).not.toContain("text_body");
  });

  test("v34 stages future temporal versions without extending lifecycle status", () => {
    const v34 = SCHEMA_MIGRATIONS.find((item) => item.version === 34);
    const sql = v34?.statements.join("\n") ?? "";
    expect(v34?.name).toBe("add-temporal-future-activation-state");
    expect(sql).toContain("temporal_activation_state");
    expect(sql).toContain("'active', 'staged'");
    expect(sql).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE|UPDATE|RENAME)\b/i);
  });

  test("v33 expand-only adds immutable Working Set cleanup receipts", () => {
    const v33 = SCHEMA_MIGRATIONS.find((item) => item.version === 33);
    const sql = v33?.statements.join("\n") ?? "";
    expect(v33?.name).toBe("add-session-working-set-cleanup-receipts");
    expect(sql).toContain("mengshu_session_cleanup_receipts");
    expect(sql).toContain("retention_expired");
    expect(sql).toContain("receipt JSONB NOT NULL");
    expect(sql).toMatch(/UNIQUE \(scope_fingerprint, session_id, reason\)/i);
  });

  test("v32 expand-only 增加 temporal prerequisite repair 审计与回滚快照", () => {
    const v32 = SCHEMA_MIGRATIONS.find((item) => item.version === 32);
    const sql = v32?.statements.join("\n") ?? "";
    expect(v32?.name).toBe("add-temporal-prerequisite-repair-audit");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS mengshu_temporal_prerequisite_repair_runs");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS mengshu_temporal_prerequisite_repair_rows");
    expect(sql).toMatch(/disposition IN \('migrate_candidate', 'quarantine_duplicate', 'review_invalid_hash'\)/i);
    expect(sql).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE|UPDATE|RENAME)\b/i);
  });

  test("v31 expand-only 增加受限 Policy Overlay version、head 与 receipt", () => {
    const v31 = SCHEMA_MIGRATIONS.find((item) => item.version === 31);
    const sql = v31?.statements.join("\n") ?? "";
    expect(v31?.name).toBe("add-scoped-memory-policy-overlays");
    for (const relation of [
      "mengshu_memory_policy_overlay_versions",
      "mengshu_memory_policy_overlay_heads",
      "mengshu_memory_policy_overlay_receipts",
    ]) expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${relation}`);
    expect(sql).toMatch(/PRIMARY KEY \(scope_fingerprint, overlay_id, version\)/i);
    expect(sql).toContain("guard_version TEXT NOT NULL CHECK (guard_version = 'memory-policy-guard-v1')");
    expect(sql).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE|UPDATE|RENAME)\b/i);
  });

  test("v30 expand-only 增加 reviewed Skill Artifact version、resource、head 与 receipt", () => {
    const v30 = SCHEMA_MIGRATIONS.find((item) => item.version === 30);
    const sql = v30?.statements.join("\n") ?? "";
    expect(v30?.name).toBe("add-reviewed-skill-artifacts");
    for (const relation of [
      "mengshu_skill_asset_versions",
      "mengshu_skill_asset_resources",
      "mengshu_skill_asset_heads",
      "mengshu_skill_promotion_receipts",
    ]) expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${relation}`);
    expect(sql).toMatch(/PRIMARY KEY \(scope_fingerprint, skill_id, version\)/i);
    expect(sql).toContain("execution_mode TEXT NOT NULL CHECK (execution_mode = 'suggest_only')");
    expect(sql).toContain("executable BOOLEAN NOT NULL CHECK (executable = FALSE)");
    expect(sql).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE|UPDATE|RENAME)\b/i);
  });

  test("v29 expand-only 增加 exact-session Working Set、outline 与 rewrite receipt", () => {
    const v29 = SCHEMA_MIGRATIONS.find((item) => item.version === 29);
    const sql = v29?.statements.join("\n") ?? "";

    expect(v29?.name).toBe("add-session-working-set");
    expect(v29?.kind).toBe("expand");
    for (const relation of [
      "mengshu_session_working_set_entries",
      "mengshu_session_working_set_idempotency_receipts",
      "mengshu_session_task_outline_versions",
      "mengshu_session_task_outline_heads",
      "mengshu_context_rewrite_receipts",
      "mengshu_session_close_receipts",
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${relation}`);
    }
    expect(sql).toMatch(/PRIMARY KEY \(scope_fingerprint, session_id, entry_id\)/i);
    expect(sql).toMatch(/UNIQUE \(scope_fingerprint, session_id, input_hash, policy_version\)/i);
    expect(sql).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE|UPDATE|RENAME)\b/i);
  });

  test("v28 expand-only 增加双时态版本链、单 head、receipt/outbox 与迁移审计", () => {
    const v28 = SCHEMA_MIGRATIONS.find((item) => item.version === 28);
    const sql = v28?.statements.join("\n") ?? "";

    expect(v28?.name).toBe("add-temporal-memory-version-chain");
    expect(v28?.kind).toBe("expand");
    for (const column of [
      "scope_fingerprint TEXT",
      "lineage_id TEXT",
      "revision INTEGER",
      "previous_version_id UUID",
      "restored_from_version_id UUID",
      "valid_from TIMESTAMPTZ",
      "valid_to TIMESTAMPTZ",
      "recorded_at TIMESTAMPTZ",
      "closed_at TIMESTAMPTZ",
      "transition_type TEXT",
      "transition_reason TEXT",
      "temporal_invalidated BOOLEAN",
      "temporal_purge_pending BOOLEAN",
      "temporal_snapshot JSONB",
    ]) {
      expect(sql).toContain(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS ${column}`);
    }
    for (const relation of [
      "mengshu_memory_lineage_heads",
      "mengshu_memory_version_transition_receipts",
      "mengshu_memory_purge_receipts",
      "mengshu_memory_version_outbox",
      "mengshu_memory_temporal_migration_runs",
      "mengshu_memory_temporal_migration_rows",
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${relation}`);
    }
    expect(sql).toMatch(/PRIMARY KEY \(scope_fingerprint, lineage_id\)/i);
    expect(sql).toMatch(/UNIQUE \(scope_fingerprint, lineage_id, latest_revision\)/i);
    expect(sql).toMatch(/memories_temporal_lineage_revision_uidx[\s\S]+scope_fingerprint, lineage_id, revision/i);
    expect(sql).toMatch(/memories_temporal_current_head_uidx[\s\S]+WHERE lineage_id IS NOT NULL[\s\S]+lifecycle_status = 'active'/i);
    expect(sql).toMatch(/request_hash TEXT NOT NULL CHECK \(request_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/i);
    expect(sql).toMatch(/before_hash TEXT NOT NULL CHECK \(before_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/i);
    expect(sql).toMatch(/after_hash TEXT CHECK \(after_hash IS NULL OR after_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/i);
    expect(sql).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE|UPDATE|RENAME)\b/i);
  });

  test("v22 expand-only persists exact-session context assembly receipts", () => {
    const v22 = SCHEMA_MIGRATIONS.find((item) => item.version === 22);
    const sql = v22?.statements.join("\n") ?? "";
    expect(v22?.name).toBe("add-context-assembly-receipts");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS mengshu_context_assembly_receipts");
    expect(sql).toContain("scope_fingerprint TEXT NOT NULL");
    expect(sql).toContain("session_id TEXT NOT NULL");
    expect(sql).toContain("receipt JSONB NOT NULL");
    expect(sql).toContain("expires_at BIGINT NOT NULL");
    expect(sql).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE|UPDATE|RENAME)\b/i);
  });

  test("内置 migration 从 1 连续递增，v6/v10/v18/v26 仅允许各自白名单 contract", () => {
    expect(validateMigrationRegistry(SCHEMA_MIGRATIONS, CURRENT_SCHEMA_VERSION)).toBeUndefined();
    expect(SCHEMA_MIGRATIONS.map((item) => item.version)).toEqual(
      Array.from({ length: CURRENT_SCHEMA_VERSION }, (_, index) => index + 1),
    );
    expect(SCHEMA_MIGRATIONS.slice(0, 5).every((item) => item.kind === "expand")).toBe(true);
    expect(SCHEMA_MIGRATIONS[5]?.kind).toBe("contract");
    expect(SCHEMA_MIGRATIONS.slice(6, 9).every((item) => item.kind === "expand")).toBe(true);
    expect(SCHEMA_MIGRATIONS[9]?.kind).toBe("contract");
    expect(SCHEMA_MIGRATIONS.slice(10, 17).every((item) => item.kind === "expand")).toBe(true);
    expect(SCHEMA_MIGRATIONS[17]?.kind).toBe("contract");
    expect(SCHEMA_MIGRATIONS.slice(18, 25).every((item) => item.kind === "expand")).toBe(true);
    expect(SCHEMA_MIGRATIONS[25]?.kind).toBe("contract");
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

    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(12);
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

    expect(planSchemaMigrations(appliedV11, {
      migrations: SCHEMA_MIGRATIONS.slice(0, 12),
      currentSchemaVersion: 12,
    })).toMatchObject({
      fromVersion: 11,
      toVersion: 12,
      pending: [SCHEMA_MIGRATIONS[11]],
    });
  });

  test("v13 使用独立 work memory node/edge 表并保持 scope 外键", () => {
    const v13 = SCHEMA_MIGRATIONS.find((item) => item.version === 13);
    const sql = v13?.statements.join("\n") ?? "";

    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(13);
    expect(v13?.name).toBe("add-durable-work-memory-graph");
    expect(v13?.kind).toBe("expand");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS mengshu_work_memory_nodes");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS mengshu_work_memory_edges");
    expect(sql).toMatch(/PRIMARY KEY \(scope_fingerprint, id\)/i);
    expect(sql).toMatch(/REFERENCES mengshu_work_memory_nodes \(scope_fingerprint, id\)/i);
    expect(sql).toMatch(/node_type IN \('evidence', 'memory', 'summary', 'skill_candidate'\)/i);
    expect(sql).toMatch(/predicate IN \('grounded_by', 'derives_from', 'contradicts', 'supersedes', 'promoted_to'\)/i);
    expect(sql).not.toContain("mengshu_graph_entities");
    expect(sql).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE|UPDATE|RENAME)\b/i);
  });

  test("v14 为 candidate route 建立独立 write journal，不冒充 active memory", () => {
    const v14 = SCHEMA_MIGRATIONS.find((item) => item.version === 14);
    const sql = v14?.statements.join("\n") ?? "";

    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(14);
    expect(v14?.name).toBe("add-atomic-candidate-write-journal");
    expect(v14?.kind).toBe("expand");
    for (const tableName of [
      "mengshu_candidate_write_receipts",
      "mengshu_candidate_write_audit",
      "mengshu_candidate_write_outbox",
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${tableName}`);
    }
    for (const column of [
      "candidate_id TEXT NOT NULL REFERENCES mengshu_candidates (id)",
      "tenant_id TEXT NOT NULL",
      "user_id TEXT NOT NULL",
      "app_id TEXT NOT NULL",
      "project_id TEXT NOT NULL",
      "agent_id TEXT NOT NULL",
      "namespace TEXT NOT NULL",
      "visibility TEXT NOT NULL",
      "workspace_id TEXT NOT NULL DEFAULT ''",
      "session_id TEXT NOT NULL DEFAULT ''",
      "route TEXT NOT NULL CHECK (route IN ('candidate_low_priority', 'candidate'))",
    ]) {
      expect(sql.match(new RegExp(column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length)
        .toBe(3);
    }
    expect(sql).toContain("action TEXT NOT NULL CHECK (action = 'candidate.store')");
    expect(sql).toContain("topic TEXT NOT NULL CHECK (topic = 'candidate.written')");
    expect(sql).toMatch(/UNIQUE \(storage_key, candidate_id, action\)/i);
    expect(sql).toMatch(/UNIQUE \(storage_key, topic, candidate_id\)/i);
    expect(sql).toMatch(/result JSONB NOT NULL CHECK \(jsonb_typeof\(result\) = 'object'\)/i);
    expect(sql).not.toMatch(/\bmemory_id\b|memory\.store|memory\.written/i);
    expect(sql).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE|UPDATE|RENAME)\b/i);
  });

  test("v15 建立通用 memory evidence link 与 Entity Graph evidence/alias ledger", () => {
    const v15 = SCHEMA_MIGRATIONS.find((item) => item.version === 15);
    const sql = v15?.statements.join("\n") ?? "";

    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(15);
    expect(v15?.name).toBe("add-authoritative-evidence-link-ledgers");
    expect(v15?.kind).toBe("expand");
    for (const tableName of [
      "mengshu_memory_evidence_links",
      "mengshu_graph_entity_evidence",
      "mengshu_graph_relation_evidence",
      "mengshu_graph_entity_aliases",
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${tableName}`);
    }
    for (const dimension of [
      "scope_fingerprint", "tenant_id", "user_id", "app_id", "project_id",
      "agent_id", "namespace", "visibility", "workspace_id", "session_id",
    ]) {
      expect(sql).toContain(dimension);
    }
    expect(sql).toMatch(/UNIQUE \(\s*scope_fingerprint, target_memory_id, evidence_memory_id, link_kind, source\s*\)/i);
    expect(sql).toMatch(/REFERENCES mengshu_graph_entities \(scope_fingerprint, id\)/i);
    expect(sql).toMatch(/REFERENCES mengshu_graph_relations \(scope_fingerprint, id\)/i);
    expect(sql).toMatch(/UNIQUE \(scope_fingerprint, entity_id, normalized_alias\)/i);
    const memoryLedger = v15?.statements.find((statement) =>
      statement.includes("CREATE TABLE IF NOT EXISTS mengshu_memory_evidence_links"),
    ) ?? "";
    expect(memoryLedger).not.toMatch(/REFERENCES mengshu_work_memory_/i);
    expect(sql).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE|UPDATE|RENAME)\b/i);
  });

  test("v16 append-only 建立 D-21 scoped topic alias migration ledger", () => {
    const v16 = SCHEMA_MIGRATIONS.find((item) => item.version === 16);
    const sql = v16?.statements.join("\n") ?? "";

    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(16);
    expect(v16?.name).toBe("add-topic-tree-alias-migration-ledger");
    expect(v16?.kind).toBe("expand");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS mengshu_topic_tree_aliases");
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
      "legacy_tree_key TEXT NOT NULL",
      "canonical_topic_label TEXT NOT NULL",
      "status TEXT NOT NULL",
      "merged_from JSONB NOT NULL",
      "sealed_node_id TEXT",
      "created_at BIGINT NOT NULL",
      "updated_at BIGINT NOT NULL",
      "superseded_at BIGINT",
      "archived_at BIGINT",
    ]) expect(sql).toContain(column);
    expect(sql).toMatch(/PRIMARY KEY \(scope_fingerprint, legacy_tree_key\)/i);
    expect(sql).toMatch(/status IN \('active', 'superseded', 'archived'\)/i);
    expect(sql).toMatch(/jsonb_typeof\(merged_from\) = 'array'/i);
    expect(sql).toMatch(/merged_from @> jsonb_build_array\(legacy_tree_key\)/i);
    expect(sql).toContain("mengshu_topic_tree_aliases_scope_canonical_idx");
    expect(sql).toContain("mengshu_topic_tree_aliases_scope_status_idx");
    expect(sql).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE|UPDATE|RENAME)\b/i);
  });

  test("v16 append 不改变 v1-v15 checksum，v15 ledger 只计划 v16", () => {
    const appliedV15 = SCHEMA_MIGRATIONS.slice(0, 15).map(({ version, name, checksum }) => ({
      version, name, checksum: checksum!,
    }));
    const plan = planSchemaMigrations(appliedV15, {
      migrations: SCHEMA_MIGRATIONS.slice(0, 16),
      currentSchemaVersion: 16,
    });

    expect(plan).toMatchObject({
      fromVersion: 15,
      toVersion: 16,
      pending: [SCHEMA_MIGRATIONS[15]],
    });
    expect(SCHEMA_MIGRATIONS.slice(0, 15).map((migration) => migration.checksum))
      .toEqual(appliedV15.map((migration) => migration.checksum));
  });

  test("v17 append-only 建立 §5.10 canonical entity identity 的四个事务表", () => {
    const v17 = SCHEMA_MIGRATIONS.find((item) => item.version === 17);
    const sql = v17?.statements.join("\n") ?? "";

    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(17);
    expect(v17?.name).toBe("add-canonical-entity-resolution-journal");
    expect(v17?.kind).toBe("expand");
    for (const tableName of [
      "mengshu_graph_entity_alias_bindings",
      "mengshu_graph_entity_resolution_ledger",
      "mengshu_graph_relation_resolution_ledger",
      "mengshu_graph_entity_embeddings",
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${tableName}`);
    }
    for (const dimension of [
      "scope_fingerprint", "tenant_id", "user_id", "app_id", "project_id",
      "agent_id", "namespace", "visibility", "workspace_id", "session_id",
    ]) {
      expect(sql.match(new RegExp(`\\b${dimension}\\b`, "g"))?.length).toBeGreaterThanOrEqual(4);
    }

    expect(sql).toMatch(/status IN \('active', 'retired'\)/i);
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS mengshu_graph_entity_alias_bindings_active_uidx[\s\S]+scope_fingerprint, entity_type, normalized_alias[\s\S]+WHERE status = 'active'/i,
    );
    expect(sql).toMatch(/method IN \('exact', 'alias', 'semantic', 'create'\)/i);
    expect(sql).toMatch(/raw_entity_id TEXT NOT NULL[\s\S]+canonical_entity_id TEXT NOT NULL[\s\S]+entity_type TEXT NOT NULL/i);
    expect(sql).toMatch(/status IN \('applied', 'rolled_back'\)/i);
    expect(sql).toMatch(/method = 'semantic'[\s\S]+similarity IS NOT NULL[\s\S]+can_rollback = TRUE/i);
    expect(sql).toMatch(/outcome IN \('canonicalized', 'dropped_self'\)/i);
    expect(sql).toMatch(/outcome = 'dropped_self'[\s\S]+canonical_relation_id IS NULL[\s\S]+canonical_subject_id = canonical_object_id/i);
    expect(sql).toMatch(/embedding_space_state IN \('known-queryable', 'unknown-unqueryable'\)/i);
    expect(sql).toMatch(/REFERENCES mengshu_embedding_spaces \(embedding_space_id\)/i);
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS mengshu_graph_entity_embeddings_queryable_idx[\s\S]+scope_fingerprint, entity_type, embedding_space_id, entity_id[\s\S]+WHERE embedding_space_state = 'known-queryable'/i,
    );
    expect(sql).not.toMatch(/USING (?:ivfflat|hnsw)/i);
    expect(sql).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE|UPDATE|RENAME)\b/i);
  });

  test("v17 append 不改变 v1-v16 checksum，v16 ledger 只计划 v17", () => {
    const v1ToV16Checksums = [
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
      "26dcfcfd6ca0a55496f60cfe37d718751d75beb6c89bd28177668af4d660ea82",
      "ec3d7bd001828317bd38dea5137cc38c0c957bbbc42ae2e9217a76b18bfb0a42",
      "8cdadbedc3283cc8ba760429808d09965b615d0d831d7a8df978f76dfa63aeaa",
      "b29861f3f76806f5843a19700192163d941c11c21647f0e3a55feb754f372e4f",
      "03f32ac752804aba5dabdca4967e728c91dc217ac97f3896399214cb02938eb4",
    ];
    expect(SCHEMA_MIGRATIONS.slice(0, 16).map((item) => item.checksum))
      .toEqual(v1ToV16Checksums);
    const appliedV16 = SCHEMA_MIGRATIONS.slice(0, 16).map(({ version, name, checksum }) => ({
      version, name, checksum: checksum!,
    }));

    expect(planSchemaMigrations(appliedV16, {
      migrations: SCHEMA_MIGRATIONS.slice(0, 17),
      currentSchemaVersion: 17,
    })).toMatchObject({
      fromVersion: 16,
      toVersion: 17,
      pending: [SCHEMA_MIGRATIONS[16]],
    });
  });

  test("v18 contract 仅把 memories authority hash 改为 active partial unique，knowledge 保持原合同", () => {
    const v18 = SCHEMA_MIGRATIONS.find((item) => item.version === 18);
    const sql = v18?.statements.join("\n") ?? "";

    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(18);
    expect(v18?.name).toBe("evidence-first-active-memory-dedupe");
    expect(v18?.kind).toBe("contract");
    expect(sql).toMatch(/DROP INDEX memories_authority_content_hash_uidx/i);
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX memories_active_authority_content_hash_uidx ON memories[\s\S]+tenant_id, user_id, canonical_project_id, product_id, producer_id, namespace, visibility, content_hash[\s\S]+WHERE lifecycle_status = 'active'/i,
    );
    expect(sql).toMatch(/ALTER INDEX memories_active_authority_content_hash_uidx RENAME TO memories_authority_content_hash_uidx/i);
    expect(sql).not.toMatch(/DROP INDEX knowledge_authority_content_hash_uidx/i);
    expect(sql).not.toMatch(/UPDATE|DELETE|TRUNCATE|ALTER\s+TABLE/i);
  });

  test("v18-v32 append 不改变 v1-v17 checksum，v17 ledger 计划全部后续迁移", () => {
    const appliedV17 = SCHEMA_MIGRATIONS.slice(0, 17).map(({ version, name, checksum }) => ({
      version, name, checksum: checksum!,
    }));

    expect(SCHEMA_MIGRATIONS.slice(0, 17).map((item) => item.checksum)).toEqual([
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
      "26dcfcfd6ca0a55496f60cfe37d718751d75beb6c89bd28177668af4d660ea82",
      "ec3d7bd001828317bd38dea5137cc38c0c957bbbc42ae2e9217a76b18bfb0a42",
      "8cdadbedc3283cc8ba760429808d09965b615d0d831d7a8df978f76dfa63aeaa",
      "b29861f3f76806f5843a19700192163d941c11c21647f0e3a55feb754f372e4f",
      "03f32ac752804aba5dabdca4967e728c91dc217ac97f3896399214cb02938eb4",
      "b3ace4e344bcadb3ddd8f15f7bbb0139834f8c32ec5874ad49639ba1be00886f",
    ]);
    expect(planSchemaMigrations(appliedV17)).toMatchObject({
      fromVersion: 17,
      toVersion: CURRENT_SCHEMA_VERSION,
      pending: SCHEMA_MIGRATIONS.slice(17),
    });
  });

  test("v19 expand-only 新增 semanticType backfill shadow、receipt 与 checkpoint", () => {
    const v19 = SCHEMA_MIGRATIONS.find((item) => item.version === 19);
    const sql = v19?.statements.join("\n") ?? "";

    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(19);
    expect(v19?.name).toBe("add-semantic-type-backfill-ledger");
    expect(v19?.kind).toBe("expand");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS mengshu_semantic_type_backfill_shadow");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS mengshu_semantic_type_backfill_receipts");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS mengshu_semantic_type_backfill_checkpoints");
    expect(sql).toMatch(/disposition IN \('preserve_explicit', 'backfill', 'lookup_only', 'invalid_explicit'\)/);
    expect(sql).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE|UPDATE|RENAME)\b/i);
  });

  test("v20 expand-only 新增 private asset/loadout overlay、不可变版本、回执和 outbox", () => {
    const v20 = SCHEMA_MIGRATIONS.find((item) => item.version === 20);
    const sql = v20?.statements.join("\n") ?? "";

    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(20);
    expect(v20?.name).toBe("add-private-asset-loadout-overlay");
    expect(v20?.kind).toBe("expand");
    for (const table of [
      "mengshu_asset_versions",
      "mengshu_asset_heads",
      "mengshu_asset_promotion_receipts",
      "mengshu_asset_audit",
      "mengshu_asset_outbox",
      "mengshu_loadout_versions",
      "mengshu_loadout_heads",
      "mengshu_loadout_receipts",
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(sql).toMatch(/kind TEXT NOT NULL CHECK \(kind IN \('memory_view'\)\)/);
    expect(sql).toMatch(/visibility TEXT NOT NULL CHECK \(visibility = 'private'\)/);
    expect(sql).toMatch(/PRIMARY KEY \(scope_fingerprint, asset_id, version\)/);
    expect(sql).toMatch(/PRIMARY KEY \(scope_fingerprint, loadout_id, version\)/);
    expect(sql).toMatch(/UNIQUE \(scope_fingerprint, request_key\)/);
    expect(sql).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE|UPDATE|RENAME)\b/i);
  });

  test("v21 expand-only 为 Loadout 写入补齐 audit/outbox，且只追加 v20 ledger", () => {
    const v21 = SCHEMA_MIGRATIONS.find((item) => item.version === 21);
    const sql = v21?.statements.join("\n") ?? "";
    const appliedV20 = SCHEMA_MIGRATIONS.slice(0, 20).map(({ version, name, checksum }) => ({
      version,
      name,
      checksum: checksum!,
    }));

    expect(CURRENT_SCHEMA_VERSION).toBe(SCHEMA_MIGRATIONS.at(-1)?.version);
    expect(v21?.name).toBe("add-loadout-audit-invalidation-outbox");
    expect(v21?.kind).toBe("expand");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS mengshu_loadout_audit");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS mengshu_loadout_outbox");
    expect(sql).toMatch(/event_type TEXT NOT NULL CHECK \(event_type = 'loadout\.version\.created'\)/);
    expect(sql).toMatch(/published_at BIGINT/);
    expect(sql).toMatch(/mengshu_loadout_outbox_pending_idx/);
    expect(sql).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE|UPDATE|RENAME)\b/i);
    expect(SCHEMA_MIGRATIONS.slice(0, 20).map((item) => item.checksum)).toEqual([
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
      "26dcfcfd6ca0a55496f60cfe37d718751d75beb6c89bd28177668af4d660ea82",
      "ec3d7bd001828317bd38dea5137cc38c0c957bbbc42ae2e9217a76b18bfb0a42",
      "8cdadbedc3283cc8ba760429808d09965b615d0d831d7a8df978f76dfa63aeaa",
      "b29861f3f76806f5843a19700192163d941c11c21647f0e3a55feb754f372e4f",
      "03f32ac752804aba5dabdca4967e728c91dc217ac97f3896399214cb02938eb4",
      "b3ace4e344bcadb3ddd8f15f7bbb0139834f8c32ec5874ad49639ba1be00886f",
      "1394410f346b9411b2677ca2edd777340b053dafd954fa0b784cbe0b68209943",
      "23ffa2e19c3ac66136e686fd20d45ed47826fe02fe37000e7574d6a708698e96",
      "e5450cfe2e1c3814a367122efaff7fb314aba0b0b61f5aa347d51f4b997b3cf8",
    ]);
    expect(planSchemaMigrations(appliedV20)).toMatchObject({
      fromVersion: 20,
      toVersion: CURRENT_SCHEMA_VERSION,
      pending: SCHEMA_MIGRATIONS.slice(20),
    });
  });

  test("v23 expand-only 新增历史重建 run/snapshot/checkpoint/plan/model/operation ledger", () => {
    const v23 = SCHEMA_MIGRATIONS.find((item) => item.version === 23);
    const sql = v23?.statements.join("\n") ?? "";

    expect(CURRENT_SCHEMA_VERSION).toBe(SCHEMA_MIGRATIONS.at(-1)?.version);
    expect(v23?.name).toBe("add-history-rebuild-ledger");
    expect(v23?.kind).toBe("expand");
    for (const table of [
      "mengshu_history_rebuild_runs",
      "mengshu_history_rebuild_source_snapshots",
      "mengshu_history_rebuild_source_rows",
      "mengshu_history_rebuild_checkpoints",
      "mengshu_history_rebuild_shadow_plans",
      "mengshu_history_rebuild_model_receipts",
      "mengshu_history_rebuild_operation_receipts",
      "mengshu_history_rebuild_artifacts",
    ]) expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    expect(sql).toMatch(/source_table TEXT NOT NULL CHECK \(source_table IN \('memories', 'knowledge'\)\)/);
    expect(sql).toMatch(/disposition TEXT NOT NULL CHECK \(disposition IN \('preserve', 'backfill', 'model_classify', 'lookup_only', 'quarantine'\)\)/);
    expect(sql).toMatch(/semantic_type TEXT CHECK \(semantic_type IS NULL OR semantic_type IN \('profile', 'task_context', 'rules', 'experience', 'resource'\)\)/);
    expect(sql).toMatch(/operation TEXT NOT NULL CHECK \(operation IN \('plan', 'apply', 'verify', 'rollback'\)\)/);
    expect(sql).toMatch(/status TEXT NOT NULL CHECK \(status IN \('applied', 'verified', 'rolled_back', 'drifted', 'failed'\)\)/);
    expect(sql).toMatch(/artifact_type TEXT NOT NULL CHECK \(artifact_type IN \('evidence_memory', 'evidence_link', 'tree_job'\)\)/);
    expect(sql).toMatch(/artifact_role TEXT NOT NULL CHECK \(artifact_role IN \('evidence_mirror', 'grounded_by', 'source_leaf', 'source_finalize', 'topic_leaf', 'topic_finalize'\)\)/);
    expect(sql).toContain("FOREIGN KEY (run_id, source_table, record_id)");
    expect(sql).toContain("ON mengshu_history_rebuild_artifacts (run_id, source_table, record_id, artifact_type, artifact_role)");
    expect(sql).not.toMatch(/prompt(?:_text| TEXT| JSONB)/i);
    expect(sql).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE|UPDATE|RENAME|ALTER\s+TABLE)\b/i);
  });

  test("v23 append 不改变 v1-v22 checksum", () => {
    const appliedV22 = SCHEMA_MIGRATIONS.slice(0, 22).map(({ version, name, checksum }) => ({
      version, name, checksum: checksum!,
    }));
    expect(planSchemaMigrations(appliedV22, {
      migrations: SCHEMA_MIGRATIONS.slice(0, 23), currentSchemaVersion: 23,
    })).toMatchObject({
      fromVersion: 22,
      toVersion: 23,
      pending: [SCHEMA_MIGRATIONS[22]],
    });
  });

  test("v24 append-only 新增 crash-safe 模型 attempt ledger，且不改变 v23 checksum", () => {
    const v24 = SCHEMA_MIGRATIONS.find((item) => item.version === 24);
    const sql = v24?.statements.join("\n") ?? "";
    const appliedV23 = SCHEMA_MIGRATIONS.slice(0, 23).map(({ version, name, checksum }) => ({
      version, name, checksum: checksum!,
    }));

    expect(v24?.name).toBe("add-history-rebuild-model-attempt-ledger");
    expect(v24?.kind).toBe("expand");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS mengshu_history_rebuild_model_attempts");
    expect(sql).toContain("PRIMARY KEY (run_id, source_table, record_id, attempt)");
    expect(sql).toContain("state IN ('reserved', 'completed')");
    expect(sql).toContain("actual_output_tokens <= reserved_output_tokens");
    expect(sql).toContain("actual_cost_minor_units <= reserved_cost_minor_units");
    expect(sql).toContain("mengshu_history_rebuild_model_attempts_budget_idx");
    expect(sql).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE|UPDATE|RENAME|ALTER\s+TABLE)\b/i);
    expect(planSchemaMigrations(appliedV23)).toMatchObject({
      fromVersion: 23,
      toVersion: CURRENT_SCHEMA_VERSION,
      pending: SCHEMA_MIGRATIONS.slice(23),
    });
  });

  test("v25 expand-only 新增 governed document、Vault、complete head 与治理账本", () => {
    const v25 = SCHEMA_MIGRATIONS.find((item) => item.version === 25);
    const sql = v25?.statements.join("\n") ?? "";

    expect(v25?.name).toBe("add-governed-document-vault-ledger");
    expect(v25?.kind).toBe("expand");
    for (const table of [
      "mengshu_vaults",
      "mengshu_governed_document_bindings",
      "mengshu_governed_document_sync_receipts",
      "mengshu_governed_document_complete_heads",
      "mengshu_document_governance_runs",
      "mengshu_information_dispositions",
    ]) expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);

    expect(sql).toContain("PRIMARY KEY (scope_fingerprint, vault_id)");
    expect(sql).toContain("PRIMARY KEY (scope_fingerprint, vault_id, asset_id)");
    expect(sql).toContain("PRIMARY KEY (scope_fingerprint, asset_id)");
    expect(sql).toContain("UNIQUE (scope_fingerprint, vault_id, idempotency_key)");
    expect(sql).toContain("UNIQUE (governance_run_id, scope_fingerprint)");
    expect(sql).toContain("FOREIGN KEY (scope_fingerprint, asset_id, asset_version)");
    expect(sql).toContain("REFERENCES mengshu_asset_versions(scope_fingerprint, asset_id, version)");
    expect(sql).toContain("REFERENCES mengshu_vaults(scope_fingerprint, vault_id)");
    expect(sql).toContain("REFERENCES mengshu_governed_document_sync_receipts");
    expect(sql).toContain("REFERENCES mengshu_document_governance_runs(governance_run_id, scope_fingerprint)");

    expect(sql).toContain("jsonb_typeof(descriptor) = 'object'");
    expect(sql).toContain("jsonb_typeof(governance_descriptor) = 'object'");
    expect(sql).toContain("jsonb_typeof(semantic_types) = 'array'");
    expect(sql).toContain("jsonb_typeof(tree_routes) = 'array'");
    expect(sql).toContain("jsonb_typeof(target_asset_ids) = 'array'");
    expect(sql).toMatch(/char_length\(vault_id\) BETWEEN 1 AND 256/);
    expect(sql).toMatch(/char_length\(asset_id\) BETWEEN 1 AND 256/);
    expect(sql).toMatch(/char_length\(idempotency_key\) BETWEEN 1 AND 256/);
    expect(sql).toMatch(/char_length\(normalized_path\) BETWEEN 1 AND 4096/);
    expect(sql).toMatch(/scope_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'/);
    expect(sql).toMatch(/public_content_hash ~ '\^\[0-9a-f\]\{64\}\$'/);
    expect(sql).toMatch(/governance_projection_hash ~ '\^\[0-9a-f\]\{64\}\$'/);
    expect(sql).toMatch(/completion_contract_hash ~ '\^\[0-9a-f\]\{64\}\$'/);
    expect(sql).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE|UPDATE|RENAME)\b/i);
  });

  test("v26 allowlisted contract 只放宽 asset kind/status 并保留 legacy 值", () => {
    const v26 = SCHEMA_MIGRATIONS.find((item) => item.version === 26);
    const sql = v26?.statements.join("\n") ?? "";

    expect(v26?.name).toBe("allow-governed-document-asset-kinds");
    expect(v26?.kind).toBe("contract");
    expect(v26?.statements).toHaveLength(2);
    expect(v26?.statements.every((statement) =>
      /^ALTER TABLE mengshu_asset_versions\b/.test(statement))).toBe(true);
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS mengshu_asset_versions_kind_check/);
    expect(sql).toMatch(/ADD CONSTRAINT mengshu_asset_versions_kind_check CHECK \(kind IN \('memory_view', 'memory_document', 'tree_document', 'index_document'\)\)/);
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS mengshu_asset_versions_status_check/);
    expect(sql).toMatch(/ADD CONSTRAINT mengshu_asset_versions_status_check CHECK \(status IN \('draft', 'review', 'published', 'active', 'deprecated', 'revoked'\)\)/);
    expect(sql).not.toMatch(/\b(?:UPDATE|DELETE|TRUNCATE|INSERT)\b/i);
    expect(sql).not.toMatch(/\b(?:memories|knowledge|mengshu_asset_heads)\b/i);
  });

  test("v26 contract 任一 CHECK 漂移都被 allowlist fail-closed", () => {
    const tampered = SCHEMA_MIGRATIONS.map(({ checksum: _checksum, ...migration }) =>
      migration.version === 26
        ? {
            ...migration,
            statements: [
              migration.statements[0]!,
              migration.statements[1]!.replace("'revoked'", "'revoked', 'removed'"),
            ],
          }
        : migration);

    expect(() => validateMigrationRegistry(tampered, CURRENT_SCHEMA_VERSION)).toThrow(/allowlist|contract/i);
  });

  test("v27 expand-only 建立 Markdown 工作集 staging、映射、before-image 与 activation receipt", () => {
    const v27 = SCHEMA_MIGRATIONS.find((item) => item.version === 27);
    const sql = v27?.statements.join("\n") ?? "";

    expect(CURRENT_SCHEMA_VERSION).toBe(SCHEMA_MIGRATIONS.at(-1)?.version);
    expect(v27?.name).toBe("add-markdown-workset-migration-ledger");
    expect(v27?.kind).toBe("expand");
    for (const table of [
      "mengshu_markdown_migration_runs",
      "mengshu_markdown_migration_staged_rows",
      "mengshu_markdown_migration_mappings",
      "mengshu_markdown_migration_before_rows",
      "mengshu_markdown_migration_activation_receipts",
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(sql).toMatch(/status IN \(\s*'prepared', 'staging', 'verified', 'activated', 'rolled_back', 'blocked'\s*\)/i);
    expect(sql).toMatch(/disposition IN \(\s*'canonical_keep', 'merge_exact', 'merge_semantic', 'supersede',\s*'archive_stale', 'lookup_only', 'quarantine', 'distinct_keep'\s*\)/i);
    expect(sql).toContain("row_payload JSONB NOT NULL CHECK (jsonb_typeof(row_payload) = 'object')");
    expect(sql).toContain("before_snapshot_sha256 TEXT NOT NULL");
    expect(sql).toContain("after_snapshot_sha256 TEXT NOT NULL");
    expect(sql).toContain("confirmation_hash TEXT NOT NULL");
    expect(sql).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE|UPDATE|RENAME)\b/i);
  });

  test("v25-v32 append 不改变 v1-v24 checksum，v24 ledger 计划全部后续安全迁移", () => {
    const v1ToV24Checksums = [
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
      "26dcfcfd6ca0a55496f60cfe37d718751d75beb6c89bd28177668af4d660ea82",
      "ec3d7bd001828317bd38dea5137cc38c0c957bbbc42ae2e9217a76b18bfb0a42",
      "8cdadbedc3283cc8ba760429808d09965b615d0d831d7a8df978f76dfa63aeaa",
      "b29861f3f76806f5843a19700192163d941c11c21647f0e3a55feb754f372e4f",
      "03f32ac752804aba5dabdca4967e728c91dc217ac97f3896399214cb02938eb4",
      "b3ace4e344bcadb3ddd8f15f7bbb0139834f8c32ec5874ad49639ba1be00886f",
      "1394410f346b9411b2677ca2edd777340b053dafd954fa0b784cbe0b68209943",
      "23ffa2e19c3ac66136e686fd20d45ed47826fe02fe37000e7574d6a708698e96",
      "e5450cfe2e1c3814a367122efaff7fb314aba0b0b61f5aa347d51f4b997b3cf8",
      "ae5b8745083216972e7eb310e89d92435df43a8eab0e01398e09868090a3672e",
      "f1c3c9883c8fe950eed30b07a8bd6441c3dc2d5d7c8d432e30b340bf701dd473",
      "b7e7935bb46242dccf17a57926c8b1628cc572610cd81d3a38451c905bd1611b",
      "d8162524bd4930b8edfc264406bf533bec14b5a6fcbf1ad4a1ed2f14cbc56cab",
    ];
    const appliedV24 = SCHEMA_MIGRATIONS.slice(0, 24).map(({ version, name, checksum }) => ({
      version, name, checksum: checksum!,
    }));

    expect(SCHEMA_MIGRATIONS.slice(0, 24).map((item) => item.checksum))
      .toEqual(v1ToV24Checksums);
    expect(CURRENT_SCHEMA_VERSION).toBe(SCHEMA_MIGRATIONS.at(-1)?.version);
    expect(planSchemaMigrations(appliedV24)).toMatchObject({
      fromVersion: 24,
      toVersion: CURRENT_SCHEMA_VERSION,
      pending: SCHEMA_MIGRATIONS.slice(24),
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
