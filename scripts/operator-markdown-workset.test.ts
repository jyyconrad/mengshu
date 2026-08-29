import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  PostgresMarkdownWorksetSnapshotSession,
  decodePostgresMarkdownWorksetRow,
  loadMarkdownWorksetBundle,
  runPostgresMarkdownWorksetExport,
  writeGovernedMarkdownWorkset,
  type MarkdownWorksetPostgresQueryClient,
} from "./operator-markdown-workset.js";
import {
  createMarkdownWorksetManifest,
  createMarkdownWorksetRecord,
  markdownWorksetManifestSha256,
  parseMarkdownWorksetManifest,
  renderNativeRecordMarkdown,
  serializeMarkdownWorksetManifest,
  type MarkdownWorksetFileInput,
  type MarkdownWorksetNativeRecord,
} from "../packages/core/src/db/migrations/markdown-workset.js";

const roots: string[] = [];
const CREATED_AT = "2026-08-28T08:00:00.000Z";

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mengshu-workset-operator-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function row(id = "11111111-1111-4111-8111-111111111111") {
  return {
    id,
    text: "必须先验证，再迁移",
    content_hash: "legacy-content-hash",
    vector_text: "[0.1,-0.2,0.3]",
    importance: 0.9,
    category: "fact",
    data_type: "memory",
    metadata: { semanticType: "rules" },
    created_at: new Date("2026-08-28T00:00:00.000Z"),
    project_name: "project-a",
    app_name: "codex",
    user_id: "user-a",
    agent_id: "agent-a",
    workspace_id: "workspace-a",
    tenant_id: "tenant-a",
    canonical_project_id: "project-a",
    product_id: "codex",
    producer_id: "agent-a",
    namespace: "memories",
    visibility: "private",
    lifecycle_status: "active",
    embedding_space_id: `embedding-space:v1:${"b".repeat(64)}`,
    embedding_space_state: "known-queryable",
    legacy_quarantine_reason: null,
    scope_key: "tenant-a:codex:user-a:project-a:agent-a:memories",
  };
}

async function sourceBundleFixture(root: string, name = "source-workset") {
  const sourceDirectory = join(root, name);
  const native: MarkdownWorksetNativeRecord = {
    id: row().id,
    sourceTable: "memories",
    text: "必须先验证，再迁移",
    contentHash: "legacy-content-hash",
    vector: [0.1, -0.2, 0.3],
    importance: 0.9,
    category: "fact",
    dataType: "memory",
    metadata: { semanticType: "rules" },
    createdAt: "2026-08-28T00:00:00.000Z",
  };
  const markdown = renderNativeRecordMarkdown(createMarkdownWorksetRecord({
    phase: "source", scopeFingerprint: "a".repeat(64), record: native,
  }));
  const file: MarkdownWorksetFileInput = {
    relativePath: `source/memories/11/${native.id}.md`, markdown,
  };
  const manifest = createMarkdownWorksetManifest({
    migrationRunId: "markdown-migration-01",
    phase: "source",
    policyVersion: "markdown-export/v1",
    createdAt: CREATED_AT,
    files: [file],
  });
  const serialized = serializeMarkdownWorksetManifest(manifest);
  const manifestPath = join(sourceDirectory, "manifest.json");
  const filePath = join(sourceDirectory, file.relativePath);
  await mkdir(join(sourceDirectory, "source", "memories", "11"), { recursive: true });
  await writeFile(filePath, markdown);
  await writeFile(manifestPath, serialized);
  return {
    sourceDirectory,
    manifestPath,
    manifestSha256: markdownWorksetManifestSha256(serialized),
    filePath,
    file,
    markdown,
  };
}

describe("PostgreSQL raw row adapter", () => {
  test("完整解码 vector、scope 和 legacy/canonical 字段", () => {
    const decoded = decodePostgresMarkdownWorksetRow("memories", {
      ...row(), importance: "0.9", data_type: "status", workspace_id: "",
    });

    expect(decoded.record).toMatchObject({
      sourceTable: "memories",
      vector: [0.1, -0.2, 0.3],
      tenantId: "tenant-a",
      canonicalProjectId: "project-a",
      namespace: "memories",
      importance: 0.9,
      dataType: "status",
      workspaceId: "",
      createdAt: "2026-08-28T00:00:00.000Z",
    });
    expect(decoded.scopeFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  test("canonical scope 不完整时不猜 fingerprint，非法 vector/visibility 拒绝", () => {
    expect(decodePostgresMarkdownWorksetRow("memories", {
      ...row(), tenant_id: null,
    }).scopeFingerprint).toBeUndefined();
    expect(decodePostgresMarkdownWorksetRow("memories", {
      ...row(), tenant_id: "legacy tenant with spaces",
    }).scopeFingerprint).toBeUndefined();
    const invalidRows = [
      { ...row(), vector_text: null },
      { ...row(), vector_text: "[]" },
      { ...row(), vector_text: "not-json" },
      { ...row(), vector_text: "[0.1,\"bad\"]" },
      { ...row(), visibility: "organization" },
    ];
    for (const invalid of invalidRows) {
      expect(() => decodePostgresMarkdownWorksetRow("memories", invalid))
        .toThrow(/row|vector|invalid/i);
    }
  });

  test("PostgreSQL nullable 列保持缺席，字符串时间仍规范为 ISO", () => {
    const decoded = decodePostgresMarkdownWorksetRow("knowledge", {
      ...row(),
      importance: null,
      created_at: "2026-08-28T00:00:00.000Z",
      project_name: null,
      app_name: null,
      user_id: null,
      agent_id: null,
      workspace_id: null,
      tenant_id: null,
      canonical_project_id: null,
      product_id: null,
      producer_id: null,
      namespace: null,
      visibility: null,
      lifecycle_status: null,
      embedding_space_id: null,
      embedding_space_state: null,
      legacy_quarantine_reason: null,
      scope_key: null,
    });

    expect(decoded.record.createdAt).toBe("2026-08-28T00:00:00.000Z");
    expect(decoded.record.importance).toBeNull();
    expect(decoded.scopeFingerprint).toBeUndefined();
    expect(Object.keys(decoded.record)).not.toEqual(expect.arrayContaining([
      "projectName", "appName", "userId", "agentId", "workspaceId", "tenantId",
      "canonicalProjectId", "productId", "producerId", "namespace", "visibility",
      "lifecycleStatus", "embeddingSpaceId", "embeddingSpaceState",
      "legacyQuarantineReason", "scopeKey",
    ]));
  });
});

describe("PostgreSQL snapshot session", () => {
  test("只使用静态 memories/knowledge 和 id keyset SQL", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const client: MarkdownWorksetPostgresQueryClient = {
      async query(sql, params = []) {
        calls.push({ sql, params });
        if (sql.includes("memories_count")) {
          return { rows: [{ memories_count: "1", knowledge_count: "0" }] };
        }
        return {
          rows: [
            row("11111111-1111-4111-8111-111111111111"),
            row("22222222-2222-4222-8222-222222222222"),
          ],
        };
      },
    };
    const session = new PostgresMarkdownWorksetSnapshotSession(client);

    await expect(session.getSourceCounts()).resolves.toEqual({ memories: 1, knowledge: 0 });
    const page = await session.readPage({ sourceTable: "memories", afterId: undefined, limit: 1 });

    expect(page.done).toBe(false);
    expect(page.nextAfterId).toBe(row().id);
    expect(calls[1]!.sql).toContain("FROM memories");
    expect(calls[1]!.sql).toContain('COLLATE "C"');
    expect(calls[1]!.sql).not.toMatch(/OFFSET|knowledge|history/i);
    expect(calls[1]!.sql).not.toContain("session_id");
    expect(calls[1]!.params).toEqual([null, 2]);
  });

  test("非法 count 与越界或超量 page 均 fail closed", async () => {
    const invalidCounts = ["-1", "01", "9007199254740992"];
    for (const memoriesCount of invalidCounts) {
      const session = new PostgresMarkdownWorksetSnapshotSession({
        async query() {
          return { rows: [{ memories_count: memoriesCount, knowledge_count: "0" }] };
        },
      });
      await expect(session.getSourceCounts())
        .rejects.toMatchObject({ code: "MARKDOWN_WORKSET_OPERATOR_INVALID_COUNT" });
    }

    const oversized = new PostgresMarkdownWorksetSnapshotSession({
      async query() {
        return { rows: [row("1111"), row("2222"), row("3333")] };
      },
    });
    await expect(oversized.readPage({ sourceTable: "memories", afterId: undefined, limit: 1 }))
      .rejects.toMatchObject({ code: "MARKDOWN_WORKSET_OPERATOR_INVALID_INPUT" });
    const invalidReads = [
      { sourceTable: "other", afterId: undefined, limit: 1 },
      { sourceTable: "memories", afterId: "", limit: 1 },
      { sourceTable: "memories", afterId: undefined, limit: 0 },
      { sourceTable: "memories", afterId: undefined, limit: 10_001 },
    ];
    for (const input of invalidReads) {
      await expect(oversized.readPage(input as Parameters<typeof oversized.readPage>[0]))
        .rejects.toMatchObject({ code: "MARKDOWN_WORKSET_OPERATOR_INVALID_INPUT" });
    }
  });
});

describe("Markdown workset filesystem operator", () => {
  test("export 在单个 repeatable-read read-only 事务中完成并始终 rollback", async () => {
    const root = await temporaryRoot();
    const calls: string[] = [];
    const client: MarkdownWorksetPostgresQueryClient = {
      async query(sql) {
        calls.push(sql.trim());
        if (/^BEGIN/i.test(sql) || /^ROLLBACK/i.test(sql)) return { rows: [] };
        if (sql.includes("memories_count")) {
          return { rows: [{ memories_count: "1", knowledge_count: "0" }] };
        }
        if (sql.includes("FROM memories")) return { rows: [row()] };
        if (sql.includes("FROM knowledge")) return { rows: [] };
        throw new Error("unexpected query");
      },
    };

    const result = await runPostgresMarkdownWorksetExport({
      client,
      containmentRoot: root,
      outputDirectory: join(root, "source-workset"),
      migrationRunId: "markdown-migration-01",
      policyVersion: "markdown-export/v1",
      createdAt: CREATED_AT,
      pageSize: 100,
    });

    expect(calls[0]).toBe("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(calls.at(-1)).toBe("ROLLBACK");
    expect(result.manifest.sourceCount).toBe(1);
    expect(parseMarkdownWorksetManifest(await readFile(result.manifestPath, "utf8")))
      .toEqual(result.manifest);
  });

  test.each(["BEGIN", "snapshot"] as const)(
    "%s 失败仍执行 ROLLBACK，并按边界传播稳定错误",
    async (failurePoint) => {
      const root = await temporaryRoot();
      const calls: string[] = [];
      const original = new Error(`${failurePoint}-failed`);
      const client: MarkdownWorksetPostgresQueryClient = {
        async query(sql) {
          const normalized = sql.trim();
          calls.push(normalized);
          if (/^ROLLBACK/i.test(normalized)) return { rows: [] };
          if (failurePoint === "BEGIN" && /^BEGIN/i.test(normalized)) throw original;
          if (/^BEGIN/i.test(normalized)) return { rows: [] };
          if (failurePoint === "snapshot" && normalized.includes("memories_count")) throw original;
          throw new Error("unexpected query");
        },
      };

      const execution = runPostgresMarkdownWorksetExport({
        client,
        containmentRoot: root,
        outputDirectory: join(root, "source-workset"),
        migrationRunId: "markdown-migration-failed",
        policyVersion: "markdown-export/v1",
        createdAt: CREATED_AT,
      });
      if (failurePoint === "BEGIN") {
        await expect(execution).rejects.toBe(original);
      } else {
        await expect(execution).rejects.toMatchObject({
          code: "MARKDOWN_WORKSET_EXPORT_SESSION_ERROR",
        });
      }
      expect(calls.at(-1)).toBe("ROLLBACK");
      expect(calls.filter((sql) => /^ROLLBACK/i.test(sql))).toHaveLength(1);
      await expect(readFile(join(root, "source-workset", "manifest.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  test("strict load source bundle 后治理到全新目录，source 文件保持不变", async () => {
    const root = await temporaryRoot();
    const fixture = await sourceBundleFixture(root);
    const governedDirectory = join(root, "governed-workset");
    const loaded = await loadMarkdownWorksetBundle(fixture.manifestPath);
    const result = await writeGovernedMarkdownWorkset({
      source: loaded,
      containmentRoot: root,
      outputDirectory: governedDirectory,
      policyVersion: "markdown-governance/v1",
    });

    expect(await readFile(fixture.filePath, "utf8")).toBe(fixture.markdown);
    expect(result.manifest.phase).toBe("governed");
    const serialized = await readFile(result.manifestPath, "utf8");
    expect(markdownWorksetManifestSha256(serialized)).toBe(result.manifestSha256);
    expect(await loadMarkdownWorksetBundle(result.manifestPath)).toMatchObject({
      manifest: { sourceCount: 1, phase: "governed" },
    });
  });

  test("expected manifest hash 或 Markdown bytes 漂移时拒绝 bundle", async () => {
    const root = await temporaryRoot();
    const hashFixture = await sourceBundleFixture(root, "hash-drift");
    await expect(loadMarkdownWorksetBundle(hashFixture.manifestPath, "0".repeat(64)))
      .rejects.toMatchObject({ code: "MARKDOWN_WORKSET_OPERATOR_BUNDLE_DRIFT" });

    const bytesFixture = await sourceBundleFixture(root, "bytes-drift");
    await writeFile(bytesFixture.filePath, `${bytesFixture.markdown}\n篡改`);
    await expect(loadMarkdownWorksetBundle(bytesFixture.manifestPath))
      .rejects.toMatchObject({ code: "MARKDOWN_WORKSET_OPERATOR_BUNDLE_DRIFT" });

    const manifestFixture = await sourceBundleFixture(root, "manifest-bytes-drift");
    await writeFile(manifestFixture.manifestPath, "{broken-json}");
    await expect(loadMarkdownWorksetBundle(manifestFixture.manifestPath))
      .rejects.toMatchObject({ code: "MARKDOWN_WORKSET_OPERATOR_BUNDLE_DRIFT" });
  });

  test("manifest 所列文件为 symlink 时拒绝跟随", async () => {
    const root = await temporaryRoot();
    const fixture = await sourceBundleFixture(root, "symlink-drift");
    const outside = join(root, "outside.md");
    await writeFile(outside, fixture.markdown);
    await rm(fixture.filePath);
    await symlink(outside, fixture.filePath);

    await expect(loadMarkdownWorksetBundle(fixture.manifestPath))
      .rejects.toMatchObject({ code: "MARKDOWN_WORKSET_OPERATOR_SYMLINK" });
  });

  test("govern output 已存在或与 source 路径重叠时拒绝且不覆盖", async () => {
    const root = await temporaryRoot();
    const fixture = await sourceBundleFixture(root);
    const loaded = await loadMarkdownWorksetBundle(fixture.manifestPath);
    const existing = join(root, "governed-existing");
    const sentinel = join(existing, "sentinel.txt");
    await mkdir(existing);
    await writeFile(sentinel, "keep");

    await expect(writeGovernedMarkdownWorkset({
      source: loaded,
      containmentRoot: root,
      outputDirectory: existing,
      policyVersion: "markdown-governance/v1",
    })).rejects.toMatchObject({ code: "MARKDOWN_WORKSET_OPERATOR_OUTPUT_EXISTS" });
    expect(await readFile(sentinel, "utf8")).toBe("keep");

    const nestedOutput = join(fixture.sourceDirectory, "governed-inside-source");
    await expect(writeGovernedMarkdownWorkset({
      source: loaded,
      containmentRoot: root,
      outputDirectory: nestedOutput,
      policyVersion: "markdown-governance/v1",
    })).rejects.toMatchObject({ code: "MARKDOWN_WORKSET_OPERATOR_PATH_ESCAPE" });
    await expect(readFile(join(nestedOutput, "manifest.json")))
      .rejects.toMatchObject({ code: "ENOENT" });

    const outside = await temporaryRoot();
    await expect(writeGovernedMarkdownWorkset({
      source: loaded,
      containmentRoot: root,
      outputDirectory: join(outside, "governed-outside-root"),
      policyVersion: "markdown-governance/v1",
    })).rejects.toMatchObject({ code: "MARKDOWN_WORKSET_OPERATOR_PATH_ESCAPE" });
  });
});
