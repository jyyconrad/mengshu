import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  MarkdownWorksetExportError,
  exportMarkdownWorkset,
  type MarkdownWorksetSnapshotRead,
  type MarkdownWorksetSnapshotSession,
} from "./markdown-workset-exporter.js";
import {
  parseNativeRecordMarkdown,
  verifyMarkdownWorksetManifest,
  type MarkdownWorksetNativeRecord,
  type MarkdownWorksetSourceTable,
} from "./markdown-workset.js";

const CREATED_AT = "2026-08-28T08:00:00.000Z";
const SCOPE_FINGERPRINT = "a".repeat(64);
const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mengshu-markdown-export-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function nativeRecord(
  id: string,
  sourceTable: MarkdownWorksetSourceTable,
  overrides: Partial<MarkdownWorksetNativeRecord> = {},
): MarkdownWorksetNativeRecord {
  return {
    id,
    sourceTable,
    text: `raw-${sourceTable}-${id}`,
    contentHash: `${sourceTable}-${id}-hash`,
    vector: [0.125, -0.25, 0.5],
    importance: 0.73,
    category: "fact",
    dataType: sourceTable === "memories" ? "memory" : "knowledge",
    metadata: { source: "postgres", nested: { version: 1 } },
    createdAt: CREATED_AT,
    projectName: "memory-autodb",
    appName: "codex",
    userId: "user-a",
    agentId: "agent-a",
    workspaceId: "workspace-a",
    tenantId: "tenant-a",
    canonicalProjectId: "project-a",
    productId: "codex",
    producerId: "agent-a",
    namespace: sourceTable,
    visibility: "private",
    lifecycleStatus: "active",
    embeddingSpaceId: `embedding-space:v1:${"b".repeat(64)}`,
    embeddingSpaceState: "known-queryable",
    legacyQuarantineReason: "legacy-review",
    scopeKey: `tenant-a:codex:user-a:project-a:agent-a:${sourceTable}`,
    ...overrides,
  };
}

function sessionFor(
  source: Readonly<Record<MarkdownWorksetSourceTable, readonly MarkdownWorksetNativeRecord[]>>,
  calls: MarkdownWorksetSnapshotRead[] = [],
): MarkdownWorksetSnapshotSession {
  return {
    async getSourceCounts() {
      return { memories: source.memories.length, knowledge: source.knowledge.length };
    },
    async readPage(input) {
      calls.push(input);
      const start = input.afterId === undefined
        ? 0
        : source[input.sourceTable].findIndex((record) => record.id > input.afterId!);
      const offset = start < 0 ? source[input.sourceTable].length : start;
      const rows = source[input.sourceTable].slice(offset, offset + input.limit).map((record) => ({
        scopeFingerprint: SCOPE_FINGERPRINT,
        record,
      }));
      return {
        rows,
        done: offset + rows.length >= source[input.sourceTable].length,
        ...(rows.length > 0 ? { nextAfterId: rows.at(-1)!.record.id } : {}),
      };
    },
  };
}

function exportInput(
  containmentRoot: string,
  snapshotSession: MarkdownWorksetSnapshotSession,
) {
  return {
    containmentRoot,
    outputDirectory: join(containmentRoot, "run-2026-08-28", "workset"),
    migrationRunId: "markdown-export-2026-08-28-01",
    policyVersion: "markdown-export/v1",
    createdAt: CREATED_AT,
    pageSize: 1,
    writeConcurrency: 2,
    snapshotSession,
  } as const;
}

describe("PostgreSQL Markdown workset exporter", () => {
  test("在同一只读 snapshot session 中按 memories/knowledge + id 分页并完整导出", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "run-2026-08-28"), { mode: 0o700 });
    const first = nativeRecord("11111111-1111-4111-8111-111111111111", "memories");
    const second = nativeRecord("22222222-2222-4222-8222-222222222222", "memories", {
      vector: [1, 0, -1],
    });
    const knowledge = nativeRecord("aa111111-1111-4111-8111-111111111111", "knowledge");
    const calls: MarkdownWorksetSnapshotRead[] = [];

    const result = await exportMarkdownWorkset(exportInput(root, sessionFor({
      memories: [first, second],
      knowledge: [knowledge],
    }, calls)));

    expect(calls).toEqual([
      { sourceTable: "memories", afterId: undefined, limit: 1 },
      { sourceTable: "memories", afterId: first.id, limit: 1 },
      { sourceTable: "knowledge", afterId: undefined, limit: 1 },
    ]);
    expect(result.manifest.sourceCount).toBe(3);
    expect(result.manifestPath).toBe(join(result.outputDirectory, "manifest.json"));
    expect(result.manifestSha256).toMatch(/^[0-9a-f]{64}$/);

    const markdownFiles = await Promise.all(result.manifest.files.map(async (file) => ({
      relativePath: file.relativePath,
      markdown: await readFile(join(result.outputDirectory, file.relativePath), "utf8"),
    })));
    expect(markdownFiles.map((file) => file.relativePath)).toEqual([
      "source/knowledge/aa/aa111111-1111-4111-8111-111111111111.md",
      "source/memories/11/11111111-1111-4111-8111-111111111111.md",
      "source/memories/22/22222222-2222-4222-8222-222222222222.md",
    ]);
    const secondMarkdown = markdownFiles.find((file) => file.relativePath.includes(second.id));
    expect(parseNativeRecordMarkdown(secondMarkdown!.markdown).record).toEqual(second);
    expect(verifyMarkdownWorksetManifest(result.manifest, markdownFiles).verifiedCount).toBe(3);
    expect(JSON.parse(await readFile(result.manifestPath, "utf8"))).toEqual(result.manifest);
    expect((await stat(result.manifestPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(result.outputDirectory, markdownFiles[0]!.relativePath))).mode & 0o777)
      .toBe(0o600);
    expect((await stat(result.outputDirectory)).mode & 0o777).toBe(0o700);
  });

  test("output 必须是 containment root 内尚不存在的目录", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const session = sessionFor({ memories: [], knowledge: [] });

    await expect(exportMarkdownWorkset({
      ...exportInput(root, session),
      outputDirectory: join(outside, "escaped"),
    })).rejects.toMatchObject({ code: "MARKDOWN_WORKSET_EXPORT_PATH_ESCAPE" });

    await mkdir(join(root, "run-2026-08-28", "workset"), { recursive: true });
    await expect(exportMarkdownWorkset(exportInput(root, session)))
      .rejects.toMatchObject({ code: "MARKDOWN_WORKSET_EXPORT_OUTPUT_EXISTS" });
  });

  test("文件 fsync 并发必须是受限正整数", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "run-2026-08-28"));
    const session = sessionFor({ memories: [], knowledge: [] });
    await expect(exportMarkdownWorkset({
      ...exportInput(root, session),
      writeConcurrency: 0,
    })).rejects.toMatchObject({ code: "MARKDOWN_WORKSET_EXPORT_INVALID_INPUT" });
  });

  test("非法 ID 与大小写折叠后的重复输出 path 均 fail closed，且不生成 manifest", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "run-2026-08-28"));
    const invalidInput = exportInput(root, sessionFor({
      memories: [nativeRecord("../escape", "memories")],
      knowledge: [],
    }));
    await expect(exportMarkdownWorkset(invalidInput))
      .rejects.toMatchObject({ code: "MARKDOWN_WORKSET_EXPORT_INVALID_ROW" });
    await expect(readFile(join(invalidInput.outputDirectory, "manifest.json")))
      .rejects.toMatchObject({ code: "ENOENT" });

    const rootTwo = await temporaryRoot();
    await mkdir(join(rootTwo, "run-2026-08-28"));
    const collisionInput = exportInput(rootTwo, sessionFor({
      memories: [nativeRecord("AA11", "memories"), nativeRecord("aa11", "memories")],
      knowledge: [],
    }));
    await expect(exportMarkdownWorkset({ ...collisionInput, pageSize: 2 }))
      .rejects.toMatchObject({ code: "MARKDOWN_WORKSET_EXPORT_DUPLICATE_PATH" });
    await expect(readFile(join(collisionInput.outputDirectory, "manifest.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  test("重复 source id 即使跨页也拒绝", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "run-2026-08-28"));
    const duplicate = nativeRecord("11111111-1111-4111-8111-111111111111", "memories");
    let reads = 0;
    const session: MarkdownWorksetSnapshotSession = {
      async getSourceCounts() {
        return { memories: 2, knowledge: 0 };
      },
      async readPage(input) {
        if (input.sourceTable === "knowledge") return { rows: [], done: true };
        reads += 1;
        return reads === 1
          ? { rows: [{ record: duplicate }], done: false, nextAfterId: duplicate.id }
          : { rows: [{ record: duplicate }], done: true, nextAfterId: duplicate.id };
      },
    };

    await expect(exportMarkdownWorkset(exportInput(root, session)))
      .rejects.toMatchObject({ code: "MARKDOWN_WORKSET_EXPORT_DUPLICATE_SOURCE" });
  });

  test("空页未结束、next cursor 不等于末行或未前进均拒绝", async () => {
    const variants: MarkdownWorksetSnapshotSession[] = [
      {
        async getSourceCounts() { return { memories: 1, knowledge: 0 }; },
        async readPage() { return { rows: [], done: false }; },
      },
      {
        async getSourceCounts() { return { memories: 1, knowledge: 0 }; },
        async readPage() {
          return {
            rows: [{ record: nativeRecord("bb11", "memories") }],
            done: false,
            nextAfterId: "aa11",
          };
        },
      },
    ];

    for (const snapshotSession of variants) {
      const root = await temporaryRoot();
      await mkdir(join(root, "run-2026-08-28"));
      await expect(exportMarkdownWorkset(exportInput(root, snapshotSession)))
        .rejects.toMatchObject({ code: "MARKDOWN_WORKSET_EXPORT_CURSOR_STALLED" });
    }
  });

  test("非法 vector 行字段不会被序列化", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "run-2026-08-28"));
    const session: MarkdownWorksetSnapshotSession = {
      async getSourceCounts() { return { memories: 1, knowledge: 0 }; },
      async readPage(input) {
        if (input.sourceTable === "knowledge") return { rows: [], done: true };
        return {
          rows: [{ record: nativeRecord("1111", "memories", { vector: [] }) }],
          done: true,
          nextAfterId: "1111",
        };
      },
    };

    await expect(exportMarkdownWorkset(exportInput(root, session)))
      .rejects.toBeInstanceOf(MarkdownWorksetExportError);
    await expect(exportMarkdownWorkset({
      ...exportInput(root, session),
      outputDirectory: join(root, "run-2026-08-28", "second-workset"),
    })).rejects.toMatchObject({ code: "MARKDOWN_WORKSET_EXPORT_INVALID_ROW" });
  });

  test("snapshot 期望计数与实际扫描不一致时不发布 manifest", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "run-2026-08-28"));
    const session = sessionFor({
      memories: [nativeRecord("1111", "memories")],
      knowledge: [],
    });
    const drifted: MarkdownWorksetSnapshotSession = {
      ...session,
      async getSourceCounts() { return { memories: 2, knowledge: 0 }; },
    };
    const input = exportInput(root, drifted);

    await expect(exportMarkdownWorkset(input))
      .rejects.toMatchObject({ code: "MARKDOWN_WORKSET_EXPORT_SNAPSHOT_DRIFT" });
    await expect(readFile(join(input.outputDirectory, "manifest.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  test("并发出现的已有目标文件不会被覆盖，manifest 仍缺席", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "run-2026-08-28"));
    const first = nativeRecord("1111", "memories");
    const second = nativeRecord("1122", "memories");
    const outputDirectory = join(root, "run-2026-08-28", "workset");
    const session: MarkdownWorksetSnapshotSession = {
      async getSourceCounts() { return { memories: 2, knowledge: 0 }; },
      async readPage(input) {
        if (input.sourceTable === "knowledge") return { rows: [], done: true };
        if (input.afterId === first.id) {
          const targetDirectory = join(outputDirectory, "source", "memories", "11");
          await writeFile(join(targetDirectory, "1122.md"), "do-not-overwrite", { mode: 0o600 });
          return { rows: [{ record: second }], done: true, nextAfterId: second.id };
        }
        return { rows: [{ record: first }], done: false, nextAfterId: first.id };
      },
    };
    const input = exportInput(root, session);

    await expect(exportMarkdownWorkset(input))
      .rejects.toMatchObject({ code: "MARKDOWN_WORKSET_EXPORT_OUTPUT_EXISTS" });
    expect(await readFile(join(outputDirectory, "source", "memories", "11", "1122.md"), "utf8"))
      .toBe("do-not-overwrite");
    await expect(readFile(join(outputDirectory, "manifest.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});
