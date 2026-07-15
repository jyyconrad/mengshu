import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { planLegacyScopeBackfill } from
  "../packages/core/src/db/migrations/scope-backfill.js";

import {
  OPERATOR_SCOPE_STAGE_APPLY_TOKEN,
  OperatorScopeStageError,
  loadOperatorScopeManifest,
  parseOperatorPostgresConfig,
  planOperatorScopeRow,
  registryFromOperatorScopeManifest,
  runOperatorScopeStage,
  runOperatorScopeStageAndPublish,
  runOperatorScopeStageCli,
  terminateOperatorScopeStageCli,
  writeOperatorScopeRegistry,
  type OperatorScopeStageClient,
  type OperatorScopeStageManifest,
  type OperatorScopeStageRow,
} from "./operator-scope-stage.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const manifest: OperatorScopeStageManifest = {
  version: 1,
  defaults: {
    scope: {
      tenantId: "local",
      userId: "default",
      appId: "mengshu",
      agentId: "default",
      visibility: "private",
    },
    producer: { productId: "mengshu", producerId: "default" },
  },
  tables: {
    memories: { namespace: "working-context" },
    knowledge: {
      namespace: "knowledge",
      producerId: "scanner",
      defaultProjectId: "default",
    },
  },
  legacyUserAliases: {
    default: "default",
    jiangyayun: "default",
  },
  projectNameAliases: {
    memory_autodb: "memory-autodb",
  },
  sourceRoots: [
    { root: "/Users/operator/projects/memory-autodb", projectId: "memory-autodb" },
    { root: "/root/legacy-source", projectId: "legacy-source" },
  ],
  unmatched: "quarantine",
};

const row = (
  overrides: Partial<OperatorScopeStageRow> = {},
): OperatorScopeStageRow => ({
  id: "00000000-0000-4000-8000-000000000001",
  text: "legacy content used only for hashing",
  contentHash: "a".repeat(64),
  metadata: {},
  projectName: "memory_autodb",
  appName: null,
  userId: null,
  agentId: null,
  workspaceId: null,
  ...overrides,
});

function manifestText(value: unknown = manifest): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

class FakeClient implements OperatorScopeStageClient {
  readonly calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  private readonly selected = { memories: false, knowledge: false };

  constructor(
    private readonly rowsByTable: Record<"memories" | "knowledge", OperatorScopeStageRow[]>,
  ) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number }> {
    this.calls.push({ sql, params });
    if (/^BEGIN|^COMMIT|^ROLLBACK/.test(sql)) return { rows: [], rowCount: 0 };
    if (sql.startsWith("SELECT")) {
      const table = sql.includes('FROM "memories"') ? "memories" : "knowledge";
      if (this.selected[table]) return { rows: [], rowCount: 0 };
      this.selected[table] = true;
      const rows = this.rowsByTable[table].map((item) => ({
        id: item.id,
        text: item.contentHash === null ? item.text : "",
        content_hash: item.contentHash,
        metadata: item.metadata,
        project_name: item.projectName,
        app_name: item.appName,
        user_id: item.userId,
        agent_id: item.agentId,
        workspace_id: item.workspaceId,
      })) as unknown as Row[];
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("UPDATE")) {
      const payload = JSON.parse(String(params[0])) as Array<{ id: string }>;
      return {
        rows: payload.map(({ id }) => ({ id })) as unknown as Row[],
        rowCount: payload.length,
      };
    }
    throw new Error("unexpected fake query");
  }
}

describe("operator scope metadata staging", () => {
  test("standalone CLI 必须先完整输出一行 JSON，再显式退出", () => {
    const events: string[] = [];
    terminateOperatorScopeStageCli({ scanned: 48_372 }, 0, {
      write: (payload, completed) => {
        events.push(`write:${payload}`);
        completed();
      },
      exit: (code) => events.push(`exit:${code}`),
    });
    expect(events).toEqual([
      'write:{"scanned":48372}\n',
      "exit:0",
    ]);
  });

  test("operator config 只校验 PostgreSQL，忽略未配置的 embedding/llm placeholder", () => {
    const parsed = parseOperatorPostgresConfig(JSON.stringify({
      dbType: "postgres",
      embedding: { apiKey: "${UNSET_EMBEDDING_KEY}" },
      llm: { apiKey: "${UNSET_LLM_KEY}" },
      postgres: {
        host: "${PG_HOST}",
        port: "${PG_PORT}",
        database: "${PG_DATABASE}",
        user: "${PG_USER}",
        password: "${PG_PASSWORD}",
        ssl: "${PG_SSL}",
      },
    }), {
      PG_HOST: "127.0.0.1",
      PG_PORT: "5432",
      PG_DATABASE: "mengshu",
      PG_USER: "operator",
      PG_PASSWORD: "private-password",
      PG_SSL: "false",
    });
    expect(parsed).toEqual({
      host: "127.0.0.1",
      port: 5432,
      database: "mengshu",
      user: "operator",
      password: "private-password",
      ssl: false,
    });
  });

  test("缺失/非法 PostgreSQL env placeholder 固定 INVALID_CONFIG 且不泄露值", () => {
    const raw = JSON.stringify({
      dbType: "postgres",
      postgres: {
        host: "${PG_HOST}",
        port: 5432,
        database: "mengshu",
        user: "operator",
        password: "${PRIVATE_PASSWORD}",
      },
    });
    let error: unknown;
    try {
      parseOperatorPostgresConfig(raw, { PG_HOST: "127.0.0.1" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "INVALID_CONFIG" });
    expect(String(error)).not.toContain("PRIVATE_PASSWORD");
  });

  test("manifest 必须显式提供完整 defaults、alias、绝对 source root 与 quarantine 策略", () => {
    const loaded = loadOperatorScopeManifest(manifestText());
    expect(loaded.manifest).toEqual(manifest);
    expect(loaded.sha256).toBe(
      createHash("sha256").update(manifestText()).digest("hex"),
    );

    const invalid = {
      ...manifest,
      sourceRoots: [{ root: "relative/path", projectId: "bad" }],
    };
    expect(() => loadOperatorScopeManifest(manifestText(invalid))).toThrow(
      OperatorScopeStageError,
    );
  });

  test("legacy app/agent 只进入 producer，canonical app/agent 始终来自 operator defaults", () => {
    const plan = planOperatorScopeRow(
      "memories",
      row({ appName: "openclaw", agentId: "memory-agent" }),
      manifest,
      "b".repeat(64),
    );

    expect(plan.status).toBe("staged");
    if (plan.status !== "staged") throw new Error("test fixture must stage");
    expect(plan.fields).toEqual({
      tenantId: "local",
      userId: "default",
      appId: "mengshu",
      agentId: "default",
      namespace: "working-context",
      visibility: "private",
      productId: "openclaw",
      producerId: "memory-agent",
      projectId: "memory-autodb",
    });
    expect(plan.metadata.operatorScopeStage).toMatchObject({
      version: "operator-scope-stage-v1",
      manifestSha256: "b".repeat(64),
    });
    expect(plan.metadata.operatorScopeStage).toHaveProperty("auditHash");
  });

  test("兼容真实 v5 null content_hash，audit 使用明确 sentinel 且不伪造 hash", () => {
    const legacy = row({ contentHash: null });
    const plan = planOperatorScopeRow(
      "memories",
      legacy,
      manifest,
      "b".repeat(64),
    );
    expect(plan.status).toBe("staged");
    if (plan.status !== "staged") throw new Error("test fixture must stage");
    expect(plan.repairedContentHash).toBe(true);
    expect(plan.metadata.operatorScopeStage.originalContentHash).toBe("legacy-null");
    expect(plan.metadata.operatorScopeStage.stagedContentHash).toMatch(/^[0-9a-f]{32}$/);
    expect(plan.metadata.operatorScopeStage.auditHash).toMatch(/^[0-9a-f]{64}$/);
    const fakeHashPlan = planOperatorScopeRow(
      "memories",
      row({ contentHash: "0".repeat(64) }),
      manifest,
      "b".repeat(64),
    );
    expect(fakeHashPlan.status).toBe("staged");
    if (fakeHashPlan.status !== "staged") throw new Error("test fixture must stage");
    expect(plan.metadata.operatorScopeStage.auditHash).not.toBe(
      fakeHashPlan.metadata.operatorScopeStage.auditHash,
    );
  });

  test("严格允许真实 v5 UUID-shaped opaque content key，非 null 原样保留", () => {
    const legacyUuid = "11111111-2222-3333-4444-555555555555";
    const plan = planOperatorScopeRow(
      "memories",
      row({ contentHash: legacyUuid, text: "" }),
      manifest,
      "b".repeat(64),
    );
    expect(plan.status).toBe("staged");
    if (plan.status !== "staged") throw new Error("test fixture must stage");
    expect(plan.repairedContentHash).toBe(false);
    expect(plan.metadata.operatorScopeStage.stagedContentHash).toBe(legacyUuid);
  });

  test("当前 ingest RFC 9562 UUIDv8 新行可 stage，marker rerun 可 already-staged", () => {
    const v8Row = row({
      id: "00000000-0000-8000-8000-000000000012",
      contentHash: "b".repeat(32),
      text: "",
    });
    const first = planOperatorScopeRow("memories", v8Row, manifest, "b".repeat(64));
    expect(first.status).toBe("staged");
    if (first.status !== "staged") throw new Error("test fixture must stage");
    const rerun = planOperatorScopeRow(
      "memories",
      { ...v8Row, metadata: first.metadata },
      manifest,
      "b".repeat(64),
    );
    expect(rerun.status).toBe("already-staged");
  });

  test("knowledge 使用最长 absolute source root，缺少 path 时才用显式 default project", () => {
    const nestedManifest: OperatorScopeStageManifest = {
      ...manifest,
      sourceRoots: [
        ...manifest.sourceRoots,
        {
          root: "/Users/operator/projects/memory-autodb/packages/core",
          projectId: "memory-core",
        },
      ],
    };
    const byPath = planOperatorScopeRow(
      "knowledge",
      row({
        projectName: null,
        metadata: { sourcePath: "/Users/operator/projects/memory-autodb/packages/core/a.ts" },
      }),
      nestedManifest,
      "c".repeat(64),
    );
    const noPath = planOperatorScopeRow(
      "knowledge",
      row({ projectName: null }),
      nestedManifest,
      "c".repeat(64),
    );
    expect(byPath.status === "staged" && byPath.fields.projectId).toBe("memory-core");
    expect(noPath.status === "staged" && noPath.fields.projectId).toBe("default");
  });

  test("移除 planner 可见的全部 legacy path，仅用 originalMetadataHash 审计", () => {
    const plan = planOperatorScopeRow(
      "memories",
      row({
        metadata: {
          projectPath: "relative/old/path",
          filePath: "/Users/operator/projects/memory-autodb/a.ts",
          provenance: { cwd: "/Users/operator/projects/memory-autodb" },
          note: "kept",
        },
      }),
      manifest,
      "c".repeat(64),
    );
    if (plan.status !== "staged") throw new Error("test fixture must stage");
    expect(plan.metadata).not.toHaveProperty("projectPath");
    expect(plan.metadata).not.toHaveProperty("filePath");
    expect(plan.metadata.provenance).not.toHaveProperty("cwd");
    expect(plan.metadata).toHaveProperty("note", "kept");
    expect(plan.metadata.operatorScopeStage.originalMetadataHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("legacy row.workspaceId 作为 absolute path evidence 参与项目归属", () => {
    const plan = planOperatorScopeRow(
      "knowledge",
      row({
        projectName: null,
        workspaceId: "/root/legacy-source/subdir",
      }),
      manifest,
      "c".repeat(64),
    );
    expect(plan.status === "staged" && plan.fields.projectId).toBe("legacy-source");
  });

  test("同一 manifest 确定性生成 cutover 可直接读取的 registry v2", () => {
    const registry = registryFromOperatorScopeManifest(manifest);
    expect(registry.version).toBe(2);
    expect(registry.projects["memory-autodb"]).toMatchObject({
      workspaceId: "memory-autodb",
      canonicalRoot: "/Users/operator/projects/memory-autodb",
    });
    expect(registry.projects["memory-autodb"]?.aliases).toContainEqual({
      value: "memory_autodb",
      normalized: "memory-autodb",
      source: "explicit",
    });
    expect(registry.workspaces["memory-autodb"]?.projectIds).toEqual(["memory-autodb"]);

    const directory = mkdtempSync(path.join(os.tmpdir(), "mengshu-scope-registry-"));
    tempDirs.push(directory);
    const output = path.join(directory, "registry.json");
    writeOperatorScopeRegistry(manifest, output);
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(registry);
  });

  test("unmapped/conflicting project 均不写任何默认猜测", () => {
    const unknown = planOperatorScopeRow(
      "memories",
      row({ projectName: "not-in-manifest" }),
      manifest,
      "3".repeat(64),
    );
    const conflict = planOperatorScopeRow(
      "memories",
      row({
        metadata: { filePath: "/root/legacy-source/a.md" },
      }),
      manifest,
      "3".repeat(64),
    );
    expect(unknown).toEqual({ status: "unmatched", reason: "conflicting-evidence" });
    expect(conflict).toEqual({ status: "unmatched", reason: "conflicting-evidence" });
  });

  test("显式但未列入 alias 的 legacy user 保持未映射，供后续 quarantine", () => {
    const phoneUsers = ["13800000000", "13900000000"].map((userId, index) =>
      planOperatorScopeRow(
        "memories",
        row({
          id: `00000000-0000-4000-8000-00000000000${index + 2}`,
          metadata: { userId },
        }),
        manifest,
        "d".repeat(64),
      ));

    expect(phoneUsers.map((plan) => plan.status)).toEqual(["unmatched", "unmatched"]);
    expect(phoneUsers.map((plan) => plan.status === "unmatched" ? plan.reason : null)).toEqual([
      "unmapped-user",
      "unmapped-user",
    ]);
  });

  test("dry-run 只查询并汇总，不发 UPDATE/DDL，也不在报告暴露正文或连接配置", async () => {
    const client = new FakeClient({
      memories: [row({ contentHash: null })],
      knowledge: [row({ projectName: null })],
    });
    const result = await runOperatorScopeStage(client, manifest, "e".repeat(64));

    expect(result).toMatchObject({
      mode: "dry-run",
      scanned: 2,
      staged: 2,
      unmatched: 0,
      updated: 0,
      repairedContentHashes: 1,
    });
    expect(client.calls.some(({ sql }) => sql.startsWith("UPDATE"))).toBe(false);
    expect(client.calls.find(({ sql }) => sql.startsWith("SELECT"))?.sql).toMatch(
      /CASE WHEN content_hash IS NULL THEN text ELSE '' END AS text/,
    );
    expect(client.calls.some(({ sql }) => /ALTER|CREATE|DROP/i.test(sql))).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/text|password|host|metadata/i);
  });

  test("apply 同时校验 maintenance、quiescence、exact token 与 manifest SHA", async () => {
    const client = new FakeClient({ memories: [], knowledge: [] });
    const base = {
      mode: "apply" as const,
      maintenance: true,
      quiescenceConfirmed: true,
      confirmationToken: OPERATOR_SCOPE_STAGE_APPLY_TOKEN,
      expectedManifestSha256: "f".repeat(64),
    };

    for (const options of [
      { ...base, maintenance: false },
      { ...base, quiescenceConfirmed: false },
      { ...base, confirmationToken: "wrong" },
      { ...base, expectedManifestSha256: "0".repeat(64) },
    ]) {
      await expect(
        runOperatorScopeStage(client, manifest, "f".repeat(64), options),
      ).rejects.toBeInstanceOf(OperatorScopeStageError);
    }
    expect(client.calls).toEqual([]);
  });

  test("apply 每批以 bulk JSONB + id/content_hash/原 metadata 乐观锁，且绝不改 scope 列或 DDL", async () => {
    const client = new FakeClient({ memories: [row()], knowledge: [] });
    const result = await runOperatorScopeStage(client, manifest, "f".repeat(64), {
      mode: "apply",
      maintenance: true,
      quiescenceConfirmed: true,
      confirmationToken: OPERATOR_SCOPE_STAGE_APPLY_TOKEN,
      expectedManifestSha256: "f".repeat(64),
    });

    expect(result.updated).toBe(1);
    const update = client.calls.find(({ sql }) => sql.startsWith("UPDATE"));
    expect(update?.sql).toMatch(
      /jsonb_to_recordset\(\$1::jsonb\).*target\.id = staged\.id.*target\.content_hash IS NOT DISTINCT FROM staged\.old_content_hash.*target\.metadata IS NOT DISTINCT FROM staged\.old_metadata.*RETURNING target\.id::text AS id/,
    );
    expect(update?.sql).not.toMatch(
      /tenant_id|canonical_project_id|product_id|producer_id|scope_key|ALTER|CREATE|DROP/i,
    );
    const payload = JSON.parse(String(update?.params[0])) as Array<Record<string, unknown>>;
    expect(payload).toHaveLength(1);
    expect(payload[0]).toMatchObject({
      id: row().id,
      old_content_hash: "a".repeat(64),
      new_content_hash: "a".repeat(64),
      old_metadata: {},
    });
    expect(client.calls.filter(({ sql }) => sql.startsWith("UPDATE"))).toHaveLength(1);
  });

  test("500 行单批 apply 仍只有 SELECT + BEGIN + 单次 bulk UPDATE + COMMIT", async () => {
    const rows = Array.from({ length: 500 }, (_, index) => row({
      id: `00000000-0000-4000-8${String(index).padStart(3, "0")}-${String(index + 1).padStart(12, "0")}`,
    }));
    const client = new FakeClient({ memories: rows, knowledge: [] });
    const result = await runOperatorScopeStage(client, manifest, "2".repeat(64), {
      mode: "apply",
      maintenance: true,
      quiescenceConfirmed: true,
      confirmationToken: OPERATOR_SCOPE_STAGE_APPLY_TOKEN,
      expectedManifestSha256: "2".repeat(64),
      batchSize: 500,
    });
    expect(result.updated).toBe(500);
    expect(client.calls.filter(({ sql }) => sql.startsWith("UPDATE"))).toHaveLength(1);
  });

  test("staged 显式 default metadata 可被 core planner + generated registry resolved", () => {
    const staged = planOperatorScopeRow(
      "knowledge",
      row({ projectName: null, contentHash: "a".repeat(32), text: "" }),
      manifest,
      "1".repeat(64),
    );
    if (staged.status !== "staged") throw new Error("test fixture must stage");
    const plan = planLegacyScopeBackfill(
      { metadata: staged.metadata, provenance: staged.metadata.provenance },
      registryFromOperatorScopeManifest(manifest),
    );
    expect(plan).toMatchObject({
      status: "resolved",
      scope: { userId: "default", agentId: "default", projectId: "default" },
      producer: { producerId: "scanner" },
    });
  });

  test("相同 manifest 的已 staging 行校验 audit 后幂等跳过", () => {
    const first = planOperatorScopeRow(
      "memories",
      row(),
      manifest,
      "1".repeat(64),
    );
    if (first.status !== "staged") throw new Error("test fixture must stage");
    const second = planOperatorScopeRow(
      "memories",
      row({ metadata: first.metadata }),
      manifest,
      "1".repeat(64),
    );
    expect(second.status).toBe("already-staged");
  });

  test("core backfill 重写 legacy 列并增加 nested scope 后 rerun 仍 already-staged", () => {
    const first = planOperatorScopeRow(
      "memories",
      row({
        appName: "openclaw",
        agentId: "legacy-memory-agent",
        workspaceId: "/Users/operator/projects/memory-autodb",
      }),
      manifest,
      "5".repeat(64),
    );
    if (first.status !== "staged") throw new Error("test fixture must stage");

    const rerun = planOperatorScopeRow(
      "memories",
      row({
        // Core backfill 会把这些 legacy columns 改为 canonical scope；它们不再是
        // producer/project 的原始证据，rerun 不得重新使用。
        appName: "mengshu",
        agentId: "default",
        workspaceId: "memory-autodb",
        metadata: {
          ...first.metadata,
          scope: {
            tenantId: "local",
            userId: "default",
            appId: "mengshu",
            agentId: "default",
            namespace: "working-context",
            visibility: "private",
            projectId: "memory-autodb",
            workspaceId: "memory-autodb",
          },
          producer: { productId: "openclaw", producerId: "legacy-memory-agent" },
          mengshuScopeBackfill: { status: "resolved", auditHash: "6".repeat(64) },
        },
      }),
      manifest,
      "5".repeat(64),
    );

    expect(rerun).toMatchObject({
      status: "already-staged",
      fields: {
        appId: "mengshu",
        agentId: "default",
        productId: "openclaw",
        producerId: "legacy-memory-agent",
        projectId: "memory-autodb",
      },
    });
  });

  test("CLI 缺参数或非 PostgreSQL config 在连接前固定错误，不泄露配置", async () => {
    await expect(runOperatorScopeStageCli([])).rejects.toMatchObject({
      code: "INVALID_ARGUMENTS",
    });
    const directory = mkdtempSync(path.join(os.tmpdir(), "mengshu-scope-cli-"));
    tempDirs.push(directory);
    const configPath = path.join(directory, "config.json");
    const manifestPath = path.join(directory, "manifest.json");
    writeFileSync(configPath, JSON.stringify({
      embedding: {
        provider: "openai",
        apiKey: "test-not-secret",
        baseURL: "http://127.0.0.1",
      },
      dbType: "lancedb",
    }));
    writeFileSync(manifestPath, manifestText());
    await expect(runOperatorScopeStageCli([
      "--config", configPath,
      "--manifest", manifestPath,
    ])).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });

  test("dry-run 禁止 registry-output，apply gate 失败也不创建或覆盖 registry", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "mengshu-scope-publish-"));
    tempDirs.push(directory);
    const configPath = path.join(directory, "config.json");
    const manifestPath = path.join(directory, "manifest.json");
    const registryPath = path.join(directory, "registry.json");
    writeFileSync(configPath, JSON.stringify({
      embedding: {
        provider: "openai",
        apiKey: "test-not-secret",
        baseURL: "http://127.0.0.1",
      },
      dbType: "postgres",
      postgres: {
        host: "127.0.0.1",
        port: 1,
        database: "not-connected",
        user: "not-connected",
        password: "not-connected",
        ssl: false,
      },
    }));
    writeFileSync(manifestPath, manifestText());

    await expect(runOperatorScopeStageCli([
      "--config", configPath,
      "--manifest", manifestPath,
      "--registry-output", registryPath,
    ])).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });
    expect(() => readFileSync(registryPath, "utf8")).toThrow();

    writeFileSync(registryPath, "existing-registry\n");
    await expect(runOperatorScopeStageCli([
      "--config", configPath,
      "--manifest", manifestPath,
      "--apply",
      "--registry-output", registryPath,
      "--maintenance",
      "--quiescence-confirmed",
      "--confirmation-token", "wrong-token",
      "--manifest-sha256", createHash("sha256").update(manifestText()).digest("hex"),
    ])).rejects.toMatchObject({ code: "APPLY_GATE_REQUIRED" });
    expect(readFileSync(registryPath, "utf8")).toBe("existing-registry\n");
  });

  test("DB staging 失败不触碰已有 registry，成功提交后才发布", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "mengshu-scope-order-"));
    tempDirs.push(directory);
    const registryPath = path.join(directory, "registry.json");
    writeFileSync(registryPath, "existing-registry\n");
    const options = {
      mode: "apply" as const,
      maintenance: true,
      quiescenceConfirmed: true,
      confirmationToken: OPERATOR_SCOPE_STAGE_APPLY_TOKEN,
      expectedManifestSha256: "4".repeat(64),
    };
    const failedClient: OperatorScopeStageClient = {
      query: async () => { throw new Error("db unavailable"); },
    };
    await expect(runOperatorScopeStageAndPublish(
      failedClient,
      manifest,
      "4".repeat(64),
      options,
      registryPath,
    )).rejects.toMatchObject({ code: "DATABASE_OPERATION_FAILED" });
    expect(readFileSync(registryPath, "utf8")).toBe("existing-registry\n");

    const client = new FakeClient({ memories: [], knowledge: [] });
    await runOperatorScopeStageAndPublish(
      client,
      manifest,
      "4".repeat(64),
      options,
      registryPath,
    );
    expect(JSON.parse(readFileSync(registryPath, "utf8"))).toEqual(
      registryFromOperatorScopeManifest(manifest),
    );
  });
});
