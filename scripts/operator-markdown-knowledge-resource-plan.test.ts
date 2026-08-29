import { createHash } from "node:crypto";
import { mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { parseKnowledgeResourcePlan } from "../packages/core/src/db/migrations/knowledge-resource-curation.js";
import {
  preprocessedNodeSha256,
  renderPreprocessedMarkdown,
} from "../packages/core/src/db/migrations/markdown-workset-preprocessed.js";
import {
  assembleMarkdownWorksetPreprocessInventory,
  type MarkdownPreprocessNode,
} from "../packages/core/src/db/migrations/markdown-workset-preprocessor.js";
import {
  MarkdownKnowledgeResourcePlanOperatorError,
  parseMarkdownKnowledgeResourcePlanArgs,
  runMarkdownKnowledgeResourcePlan,
  type RunMarkdownKnowledgeResourcePlanInput,
} from "./operator-markdown-knowledge-resource-plan.js";

const roots: string[] = [];

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [
          key,
          stableValue((value as Record<string, unknown>)[key]),
        ]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function node(id: string, content: string): MarkdownPreprocessNode {
  return {
    sourceRef: `knowledge:${id}`,
    sourceHash: sha256(`source:${id}`),
    sourceTable: "knowledge",
    scopeFingerprint: "a".repeat(64),
    normalizedContentHash: sha256(content),
    semanticTypeCandidates:
      content.length === 0
        ? []
        : [{ semanticType: "resource", confidence: 1, reason: "namespace" }],
    logicalSourceCandidates: [],
    revisionCandidates: [],
    ordinalCandidates: [],
    resourceCandidates:
      content.length === 0
        ? []
        : [
            {
              kind: "path",
              locator: `docs/${id}.md`,
              field: "path",
              confidence: 1,
            },
          ],
    topicCandidates: [],
    routeCandidates: {
      source: "threshold_met",
      topic: "threshold_met",
      global: "threshold_not_met",
    },
    qualityFlags: [],
  };
}

interface Fixture {
  readonly root: string;
  readonly sourceRoot: string;
  readonly manifestPath: string;
  readonly inventoryPath: string;
  readonly outputPath: string;
  readonly input: RunMarkdownKnowledgeResourcePlanInput;
  readonly sourcePaths: readonly string[];
}

async function fixture(
  contents: readonly string[] = ["resource body", ""],
): Promise<Fixture> {
  const root = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "mengshu-knowledge-plan-")),
  );
  roots.push(root);
  const sourceRoot = resolve(root, "preprocessed");
  const inventoryPath = resolve(sourceRoot, "inventory.json");
  const manifestPath = resolve(sourceRoot, "manifest.json");
  const outputPath = resolve(root, "knowledge-resource-plan.json");
  await mkdir(resolve(sourceRoot, "knowledge"), { recursive: true });

  const nodes = contents.map((content, index) =>
    node(String(index + 1), content),
  );
  const sourceSnapshotSha256 = sha256("source-snapshot");
  const sourceManifestSha256 = sha256("source-manifest");
  const inventory = assembleMarkdownWorksetPreprocessInventory({
    sourceSnapshotSha256,
    policyVersion: "markdown-preprocess/v4",
    nodes,
  });
  const inventoryText = canonicalJson(inventory);
  await writeFile(inventoryPath, inventoryText, "utf8");
  const inventoryFileSha256 = sha256(inventoryText);

  const sourcePaths: string[] = [];
  const files = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const current = nodes[index]!;
    const content = contents[index]!;
    const relativePath = `knowledge/${index + 1}.md`;
    const sourcePath = resolve(sourceRoot, relativePath);
    const markdown = renderPreprocessedMarkdown({
      policyVersion: "markdown-preprocess/v4",
      node: current,
      relationships: [],
      content,
    });
    await writeFile(sourcePath, markdown, "utf8");
    sourcePaths.push(sourcePath);
    files.push({
      relativePath,
      sourceRef: current.sourceRef,
      sourceHash: current.sourceHash,
      nodeSha256: preprocessedNodeSha256(current),
      markdownSha256: sha256(markdown),
    });
  }
  const manifest = {
    schema: "mengshu.markdown-workset-preprocess-manifest/v1",
    migrationRunId: "p3-operator-fixture",
    sourceManifestSha256,
    sourceSnapshotSha256,
    policyVersion: "markdown-preprocess/v4",
    createdAt: "2026-08-28T00:00:00.000Z",
    sourceCount: files.length,
    inventorySha256: inventory.inventorySha256,
    inventoryFileSha256,
    summary: inventory.summary,
    files,
  };
  const manifestText = canonicalJson(manifest);
  await writeFile(manifestPath, manifestText, "utf8");
  return {
    root,
    sourceRoot,
    manifestPath,
    inventoryPath,
    outputPath,
    sourcePaths,
    input: {
      containmentRoot: root,
      preprocessedManifestPath: manifestPath,
      preprocessedManifestFileSha256: sha256(manifestText),
      inventoryPath,
      inventoryFileSha256,
      inventorySemanticSha256: inventory.inventorySha256,
      sourceManifestSha256,
      sourceSnapshotSha256,
      expectedKnowledgeSourceCount: files.length,
      outputPath,
      createdAt: "2026-08-28T12:00:00.000Z",
      readConcurrency: 2,
    },
  };
}

async function expectCode(
  promise: Promise<unknown>,
  code: MarkdownKnowledgeResourcePlanOperatorError["code"],
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: "MarkdownKnowledgeResourcePlanOperatorError",
    code,
  } satisfies Partial<MarkdownKnowledgeResourcePlanOperatorError>);
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Markdown Knowledge resource plan operator", () => {
  test("验证冻结输入、保留 empty body 并以 wx 写入可 parse-back 的 canonical plan", async () => {
    const value = await fixture();
    const result = await runMarkdownKnowledgeResourcePlan(value.input);

    const serialized = await readFile(value.outputPath, "utf8");
    const parsed = parseKnowledgeResourcePlan(serialized);
    expect(result).toMatchObject({
      outputPath: value.outputPath,
      outputFileSha256: sha256(serialized),
      knowledgeSourceCount: 2,
    });
    expect(parsed.summary).toMatchObject({
      sourceCount: 2,
      sourceCoverage: 1,
      quarantineSourceCount: 1,
    });
    expect(serialized).toBe(`${serialized.trimEnd()}\n`);
  });

  test("Markdown 字节 hash 漂移时 fail closed", async () => {
    const value = await fixture(["body"]);
    await writeFile(value.sourcePaths[0]!, "drift", "utf8");
    await expectCode(
      runMarkdownKnowledgeResourcePlan(value.input),
      "MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_INPUT_DRIFT",
    );
  });

  test("拒绝 canonical JSON、inventory semantic hash 和冻结 source hash 漂移", async () => {
    const nonCanonical = await fixture(["body"]);
    const manifest = JSON.parse(
      await readFile(nonCanonical.manifestPath, "utf8"),
    );
    const compactManifest = JSON.stringify(manifest);
    await writeFile(nonCanonical.manifestPath, compactManifest, "utf8");
    await expectCode(
      runMarkdownKnowledgeResourcePlan({
        ...nonCanonical.input,
        preprocessedManifestFileSha256: sha256(compactManifest),
      }),
      "MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_INPUT_DRIFT",
    );

    const semantic = await fixture(["body"]);
    await expectCode(
      runMarkdownKnowledgeResourcePlan({
        ...semantic.input,
        inventorySemanticSha256: sha256("other-inventory"),
      }),
      "MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_INPUT_DRIFT",
    );

    const frozen = await fixture(["body"]);
    await expectCode(
      runMarkdownKnowledgeResourcePlan({
        ...frozen.input,
        sourceManifestSha256: sha256("other-source-manifest"),
      }),
      "MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_INPUT_DRIFT",
    );
  });

  test("拒绝 source Markdown 符号链接", async () => {
    const value = await fixture(["body"]);
    const original = value.sourcePaths[0]!;
    const target = resolve(value.sourceRoot, "real.md");
    await writeFile(target, await readFile(original));
    await unlink(original);
    await symlink(target, original);
    await expectCode(
      runMarkdownKnowledgeResourcePlan(value.input),
      "MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_SYMLINK",
    );
  });

  test("已存在输出不可覆盖且原字节保持不变", async () => {
    const value = await fixture(["body"]);
    await writeFile(value.outputPath, "keep", "utf8");
    await expectCode(
      runMarkdownKnowledgeResourcePlan(value.input),
      "MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_OUTPUT_EXISTS",
    );
    expect(await readFile(value.outputPath, "utf8")).toBe("keep");
  });

  test("重复 source、Knowledge 表/ref 不一致和漏文件均拒绝", async () => {
    const duplicate = await fixture(["body"]);
    const manifest = JSON.parse(await readFile(duplicate.manifestPath, "utf8"));
    manifest.files.push({ ...manifest.files[0] });
    manifest.sourceCount += 1;
    const duplicateText = canonicalJson(manifest);
    await writeFile(duplicate.manifestPath, duplicateText, "utf8");
    await expectCode(
      runMarkdownKnowledgeResourcePlan({
        ...duplicate.input,
        preprocessedManifestFileSha256: sha256(duplicateText),
      }),
      "MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_COVERAGE_INVALID",
    );

    const nonKnowledge = await fixture(["body"]);
    const inventory = JSON.parse(
      await readFile(nonKnowledge.inventoryPath, "utf8"),
    );
    inventory.nodes[0].sourceTable = "memories";
    const inventoryBody = { ...inventory };
    delete inventoryBody.inventorySha256;
    inventory.inventorySha256 = sha256(
      JSON.stringify(stableValue(inventoryBody)),
    );
    const inventoryText = canonicalJson(inventory);
    await writeFile(nonKnowledge.inventoryPath, inventoryText, "utf8");
    const nonKnowledgeManifest = JSON.parse(
      await readFile(nonKnowledge.manifestPath, "utf8"),
    );
    nonKnowledgeManifest.inventoryFileSha256 = sha256(inventoryText);
    nonKnowledgeManifest.inventorySha256 = inventory.inventorySha256;
    const nonKnowledgeManifestText = canonicalJson(nonKnowledgeManifest);
    await writeFile(
      nonKnowledge.manifestPath,
      nonKnowledgeManifestText,
      "utf8",
    );
    await expectCode(
      runMarkdownKnowledgeResourcePlan({
        ...nonKnowledge.input,
        preprocessedManifestFileSha256: sha256(nonKnowledgeManifestText),
        inventoryFileSha256: sha256(inventoryText),
        inventorySemanticSha256: inventory.inventorySha256,
      }),
      "MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_COVERAGE_INVALID",
    );

    const missing = await fixture(["body"]);
    await unlink(missing.sourcePaths[0]!);
    await expectCode(
      runMarkdownKnowledgeResourcePlan(missing.input),
      "MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_INPUT_DRIFT",
    );
  });

  test("CLI 参数 exact-key 且 read concurrency 显式有界", () => {
    const args = [
      "--containment-root",
      "/tmp/root",
      "--preprocessed-manifest",
      "/tmp/root/manifest.json",
      "--preprocessed-manifest-file-sha256",
      "1".repeat(64),
      "--inventory",
      "/tmp/root/inventory.json",
      "--inventory-file-sha256",
      "2".repeat(64),
      "--inventory-semantic-sha256",
      "3".repeat(64),
      "--source-manifest-sha256",
      "4".repeat(64),
      "--source-snapshot-sha256",
      "5".repeat(64),
      "--expected-knowledge-count",
      "47963",
      "--output",
      "/tmp/root/plan.json",
      "--created-at",
      "2026-08-28T12:00:00.000Z",
      "--read-concurrency",
      "32",
    ];
    expect(parseMarkdownKnowledgeResourcePlanArgs(args)).toMatchObject({
      expectedKnowledgeSourceCount: 47_963,
      readConcurrency: 32,
    });
    expect(() =>
      parseMarkdownKnowledgeResourcePlanArgs([...args, "--unknown", "x"]),
    ).toThrow(/argument/i);
    const invalidConcurrency = [...args];
    invalidConcurrency[invalidConcurrency.indexOf("32")] = "65";
    expect(() =>
      parseMarkdownKnowledgeResourcePlanArgs(invalidConcurrency),
    ).toThrow(/argument/i);
  });
});
