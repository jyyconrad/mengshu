import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  createMarkdownWorksetManifest,
  createMarkdownWorksetRecord,
  markdownWorksetManifestSha256,
  renderNativeRecordMarkdown,
  serializeMarkdownWorksetManifest,
} from "../packages/core/src/db/migrations/markdown-workset.js";
import { parsePreprocessedMarkdown } from
  "../packages/core/src/db/migrations/markdown-workset-preprocessed.js";
import { runMarkdownWorksetPreprocess } from "./operator-markdown-workset-preprocess.js";

const roots: string[] = [];

async function fixture(): Promise<Readonly<{
  root: string;
  sourceDirectory: string;
  manifestPath: string;
  manifestSha256: string;
}>> {
  const root = await mkdtemp(join(tmpdir(), "mengshu-preprocess-test-"));
  roots.push(root);
  const sourceDirectory = join(root, "source");
  await mkdir(join(sourceDirectory, "memories"), { recursive: true, mode: 0o700 });
  const files = ["a", "b"].map((id) => {
    const record = createMarkdownWorksetRecord({
      phase: "source",
      scopeFingerprint: "a".repeat(64),
      record: {
        id,
        sourceTable: "memories",
        text: "same content",
        contentHash: `legacy-${id}`,
        vector: [0.1, 0.2],
        importance: 0.9,
        category: "rule",
        dataType: "rule",
        metadata: {
          source: "docs/guide.md",
          revision: { id: "r1", order: 1 },
          semanticType: "rules",
          valueScore: 0.9,
          topicLabels: ["Quality"],
        },
        createdAt: "2026-08-28T00:00:00.000Z",
      },
    });
    return { relativePath: `memories/${id}.md`, markdown: renderNativeRecordMarkdown(record) };
  });
  for (const file of files) {
    await writeFile(join(sourceDirectory, file.relativePath), file.markdown, { mode: 0o600 });
  }
  const manifest = createMarkdownWorksetManifest({
    migrationRunId: "preprocess-test",
    phase: "source",
    policyVersion: "markdown-export/v1",
    createdAt: "2026-08-28T00:00:00.000Z",
    files,
  });
  const serialized = serializeMarkdownWorksetManifest(manifest);
  const manifestPath = join(sourceDirectory, "manifest.json");
  await writeFile(manifestPath, serialized, { mode: 0o600 });
  return {
    root,
    sourceDirectory,
    manifestPath,
    manifestSha256: markdownWorksetManifestSha256(serialized),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Markdown workset preprocess operator", () => {
  test("两遍校验后生成逐行预处理 MD、inventory 和原子 manifest", async () => {
    const input = await fixture();
    const outputDirectory = join(input.root, "preprocessed");
    const result = await runMarkdownWorksetPreprocess({
      containmentRoot: input.root,
      sourceManifestPath: input.manifestPath,
      sourceManifestSha256: input.manifestSha256,
      outputDirectory,
      policyVersion: "markdown-preprocess/v1",
      createdAt: "2026-08-28T01:00:00.000Z",
      concurrency: 2,
    });

    expect(result.manifest.sourceCount).toBe(2);
    expect(result.inventory.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "exact_content", members: ["memories:a", "memories:b"] }),
      expect.objectContaining({ kind: "logical_source", members: ["memories:a", "memories:b"] }),
    ]));
    const parsed = parsePreprocessedMarkdown(await readFile(join(outputDirectory, "memories/a.md"), "utf8"));
    expect(parsed.relationships).toContainEqual(expect.objectContaining({
      kind: "exact_duplicate_candidate",
      from: "memories:b",
      to: "memories:a",
    }));
    expect(await readFile(result.manifestPath, "utf8")).toContain(result.inventory.inventorySha256);
    expect(await readFile(result.inventoryPath, "utf8")).toContain(result.inventory.inventorySha256);
  });

  test("源文件 hash 漂移或输出目录已存在时拒绝且不发布 manifest", async () => {
    const input = await fixture();
    await writeFile(join(input.sourceDirectory, "memories/a.md"), "drift", { mode: 0o600 });
    await expect(runMarkdownWorksetPreprocess({
      containmentRoot: input.root,
      sourceManifestPath: input.manifestPath,
      sourceManifestSha256: input.manifestSha256,
      outputDirectory: join(input.root, "preprocessed-drift"),
      policyVersion: "markdown-preprocess/v1",
      createdAt: "2026-08-28T01:00:00.000Z",
    })).rejects.toThrow(/drift/i);

    const clean = await fixture();
    const existing = join(clean.root, "existing");
    await mkdir(existing);
    await expect(runMarkdownWorksetPreprocess({
      containmentRoot: clean.root,
      sourceManifestPath: clean.manifestPath,
      sourceManifestSha256: clean.manifestSha256,
      outputDirectory: existing,
      policyVersion: "markdown-preprocess/v1",
      createdAt: "2026-08-28T01:00:00.000Z",
    })).rejects.toThrow(/output/i);
  });

  test("拒绝越界路径、无效 hash 和无效并发", async () => {
    const input = await fixture();
    await expect(runMarkdownWorksetPreprocess({
      containmentRoot: input.root,
      sourceManifestPath: input.manifestPath,
      sourceManifestSha256: "bad",
      outputDirectory: join(input.root, "out"),
      policyVersion: "markdown-preprocess/v1",
      createdAt: "2026-08-28T01:00:00.000Z",
      concurrency: 0,
    })).rejects.toThrow(/input/i);
  });
});
