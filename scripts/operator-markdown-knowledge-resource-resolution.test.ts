import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import {
  planKnowledgeResourceCuration,
  serializeKnowledgeResourcePlan,
  type KnowledgeResourceCurationPlan,
  type PlanKnowledgeResourceCurationInput,
} from "../packages/core/src/db/migrations/knowledge-resource-curation.js";
import {
  parseMarkdownKnowledgeResourceResolutionArgs,
  runMarkdownKnowledgeResourceResolution,
  type RunMarkdownKnowledgeResourceResolutionInput,
} from "./operator-markdown-knowledge-resource-resolution.js";

const roots: string[] = [];
const CREATED_AT = "2026-08-28T12:00:00.000Z";
const SCOPE_A = "a".repeat(64);
const SCOPE_B = "b".repeat(64);
const execFileAsync = promisify(execFile);

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stable(item)]));
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}

function node(
  id: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    sourceRef: `knowledge:${id}`,
    sourceHash: sha256(`source:${id}`),
    sourceTable: "knowledge",
    scopeFingerprint: SCOPE_A,
    normalizedContentHash: sha256(`content:${id}`),
    semanticTypeCandidates: [{ semanticType: "resource", confidence: 1, reason: "fixture" }],
    logicalSourceCandidates: [],
    revisionCandidates: [],
    ordinalCandidates: [],
    resourceCandidates: [],
    topicCandidates: [],
    routeCandidates: {
      source: "threshold_met",
      topic: "threshold_not_met",
      global: "threshold_not_met",
    },
    qualityFlags: [],
    ...overrides,
  };
}

function fixturePlan(): KnowledgeResourceCurationPlan {
  const frozenHashes = {
    sourceManifestSha256: sha256("source-manifest"),
    sourceSnapshotSha256: sha256("source-snapshot"),
    preprocessedManifestSha256: sha256("preprocessed-manifest"),
    inventoryFileSha256: sha256("inventory-file"),
    inventorySemanticSha256: sha256("inventory-semantic"),
  };
  const nodes = [
    node("quarantine", { qualityFlags: ["legacy_quarantine"] }),
    node("low"),
    node("snapshot-0", {
      logicalSourceCandidates: [{ identity: "doc-1", field: "documentId", confidence: 1 }],
      ordinalCandidates: [{ ordinal: 0, field: "ordinal", confidence: 1 }],
      resourceCandidates: [{
        kind: "document_id", locator: "doc-1", field: "documentId", confidence: 1,
      }],
    }),
    node("snapshot-1", {
      logicalSourceCandidates: [{ identity: "doc-1", field: "documentId", confidence: 1 }],
      ordinalCandidates: [{ ordinal: 1, field: "ordinal", confidence: 1 }],
      resourceCandidates: [{
        kind: "document_id", locator: "doc-1", field: "documentId", confidence: 1,
      }],
    }),
    node("locator-a", {
      resourceCandidates: [{
        kind: "url", locator: "https://example.test/a", field: "url", confidence: 1,
      }],
    }),
    node("locator-b", {
      scopeFingerprint: SCOPE_B,
      resourceCandidates: [{
        kind: "path", locator: "docs/b.md", field: "path", confidence: 1,
      }],
    }),
  ];
  const files = nodes.map((item) => ({
    relativePath: `knowledge/${String(item.sourceRef).slice("knowledge:".length)}.md`,
    sourceRef: item.sourceRef as string,
    sourceHash: item.sourceHash as string,
    markdownSha256: sha256(`markdown:${String(item.sourceRef)}`),
    nodeSha256: sha256(`node:${String(item.sourceRef)}`),
  }));
  const input = {
    runId: "knowledge-resolution-fixture",
    policyVersion: "knowledge-resource-curation/v1",
    createdAt: "2026-08-28T00:00:00.000Z",
    expectedKnowledgeSourceCount: nodes.length,
    frozenHashes,
    observedHashes: { ...frozenHashes },
    preprocessedManifest: {
      schema: "mengshu.markdown-workset-preprocess-manifest/v1",
      migrationRunId: "knowledge-resolution-fixture",
      policyVersion: "markdown-preprocess/v1",
      createdAt: "2026-08-28T00:00:00.000Z",
      sourceCount: nodes.length,
      sourceManifestSha256: frozenHashes.sourceManifestSha256,
      sourceSnapshotSha256: frozenHashes.sourceSnapshotSha256,
      inventoryFileSha256: frozenHashes.inventoryFileSha256,
      inventorySha256: frozenHashes.inventorySemanticSha256,
      files,
      summary: {},
    },
    inventory: {
      schema: "mengshu.markdown-workset-preprocess/v1",
      sourceSnapshotSha256: frozenHashes.sourceSnapshotSha256,
      policyVersion: "markdown-preprocess/v1",
      sourceCount: nodes.length,
      nodes,
      groups: [{
        kind: "snapshot_revision",
        key: sha256("snapshot-group"),
        members: ["knowledge:snapshot-0", "knowledge:snapshot-1"],
      }],
      relationships: [],
      summary: {},
      inventorySha256: frozenHashes.inventorySemanticSha256,
    },
    sourceFacts: nodes.map((item) => ({
      sourceRef: item.sourceRef as string,
      bytes: 100,
      contentLength: String(item.sourceRef).endsWith("quarantine") ? 0 : 10,
    })),
  } as unknown as PlanKnowledgeResourceCurationInput;
  return planKnowledgeResourceCuration(input);
}

interface Fixture {
  readonly root: string;
  readonly plan: KnowledgeResourceCurationPlan;
  readonly input: RunMarkdownKnowledgeResourceResolutionInput;
  readonly reviewFiles: readonly string[];
  readonly arbitrationPath: string;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(resolve(tmpdir(), "mengshu-knowledge-resolution-"));
  roots.push(root);
  const plan = fixturePlan();
  const planPath = resolve(root, "knowledge-plan.json");
  const planText = serializeKnowledgeResourcePlan(plan);
  await writeFile(planPath, planText);
  const reviewRoot = resolve(root, "reviews");
  const agents = ["agent-a", "agent-b", "agent-c"];
  await mkdir(reviewRoot);
  await Promise.all(agents.map((agent) => mkdir(resolve(reviewRoot, agent))));
  const unitById = new Map(plan.units.map((unit) => [unit.unitId, unit] as const));
  const reviewFiles: string[] = [];
  const reviewBatches = plan.batches.filter((batch) => batch.mode === "review");
  expect(reviewBatches).toHaveLength(3);
  for (const [index, batch] of reviewBatches.entries()) {
    const decisions = batch.unitIds.map((unitId) => {
      const unit = unitById.get(unitId)!;
      const snapshot = unit.cohort === "snapshot_document";
      return {
        unitId,
        scopeFingerprint: unit.scopeFingerprint,
        sources: unit.sources,
        cohort: unit.cohort,
        verdict: "accept",
        logicalSourceDisposition: snapshot ? "snapshot_document" : "locator_resource",
        revisionKind: snapshot ? "snapshot_chunks" : "unversioned",
        disposition: "lookup_only",
        confidence: 0.98,
        conflict: false,
        reasonCodes: ["independent_review_accept"],
        notes: ["The source component is coherent."],
      };
    });
    const path = resolve(reviewRoot, agents[index]!, `${batch.batchId}.json`);
    await writeFile(path, canonicalJson({
      schema: "mengshu.knowledge-resource-review-draft/v1",
      planFileSha256: sha256(planText),
      semanticPlanSha256: plan.semanticPlanSha256,
      batchId: batch.batchId,
      reviewer: `${agents[index]}-reviewer`,
      createdAt: "2026-08-28T10:00:00.000Z",
      candidateOnly: true,
      decisions,
    }));
    reviewFiles.push(path);
  }
  const arbitrationPath = resolve(root, "arbitration.json");
  const arbitrationText = canonicalJson({
    schema: "mengshu.knowledge-resource-arbitration/v1",
    planFileSha256: sha256(planText),
    semanticPlanSha256: plan.semanticPlanSha256,
    createdAt: "2026-08-28T11:00:00.000Z",
    candidateOnly: true,
    decisions: [],
  });
  await writeFile(arbitrationPath, arbitrationText);
  return {
    root,
    plan,
    reviewFiles,
    arbitrationPath,
    input: {
      containmentRoot: root,
      planPath,
      planFileSha256: sha256(planText),
      reviewRoot,
      arbitrationPath,
      arbitrationFileSha256: sha256(arbitrationText),
      outputDirectory: resolve(root, "resolution"),
      createdAt: CREATED_AT,
    },
  };
}

async function mutateReview(
  path: string,
  mutate: (value: any) => void,
): Promise<void> {
  const value = JSON.parse(await readFile(path, "utf8"));
  mutate(value);
  await writeFile(path, canonicalJson(value));
}

async function writeArbitration(
  value: Fixture,
  decisions: readonly Record<string, unknown>[],
): Promise<RunMarkdownKnowledgeResourceResolutionInput> {
  const text = canonicalJson({
    schema: "mengshu.knowledge-resource-arbitration/v1",
    planFileSha256: value.input.planFileSha256,
    semanticPlanSha256: value.plan.semanticPlanSha256,
    createdAt: "2026-08-28T11:00:00.000Z",
    candidateOnly: true,
    decisions,
  });
  await writeFile(value.arbitrationPath, text);
  return { ...value.input, arbitrationFileSha256: sha256(text) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Markdown Knowledge resource resolution operator", () => {
  test("生成全量 unit/binding/source 决议并绑定 review 与输出 hash", async () => {
    const value = await fixture();
    const result = await runMarkdownKnowledgeResourceResolution(value.input);
    expect(result).toMatchObject({
      status: "accepted",
      units: value.plan.summary.unitCount,
      sources: value.plan.summary.sourceCount,
      unresolved: 0,
      coverage: 1,
    });
    const unitRows = (await readFile(resolve(
      value.input.outputDirectory,
      "unit-decisions.jsonl",
    ), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const bindings = (await readFile(resolve(
      value.input.outputDirectory,
      "knowledge-resource-bindings.jsonl",
    ), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const sourceRows = (await readFile(resolve(
      value.input.outputDirectory,
      "knowledge-source-dispositions.jsonl",
    ), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const receipt = JSON.parse(await readFile(resolve(
      value.input.outputDirectory,
      "receipt.json",
    ), "utf8"));
    expect(unitRows).toHaveLength(value.plan.summary.unitCount);
    expect(bindings).toHaveLength(value.plan.summary.unitCount);
    expect(sourceRows).toHaveLength(value.plan.summary.sourceCount);
    expect(new Set(bindings.map((item) => item.resourceIdentity)).size).toBe(bindings.length);
    for (const row of [...unitRows, ...bindings, ...sourceRows]) {
      expect(Object.keys(row)).not.toContain("canonicalTarget");
    }
    expect(receipt).toMatchObject({
      counts: { unresolved: 0, coverage: 1, supersede: 0 },
      guards: {
        canonicalTargetsSelected: false,
        formalAssetsWritten: false,
        treeArtifactsWritten: false,
        postgresTouched: false,
      },
    });
    expect(receipt.inputHashes.reviewFiles).toHaveLength(3);
  });

  test("拒绝漏 review 和重复 review batch", async () => {
    const missing = await fixture();
    await unlink(missing.reviewFiles[0]!);
    await expect(runMarkdownKnowledgeResourceResolution(missing.input))
      .rejects.toThrow(/review|coverage|missing/i);

    const duplicate = await fixture();
    await copyFile(
      duplicate.reviewFiles[0]!,
      resolve(duplicate.input.reviewRoot, "agent-b", "duplicate.json"),
    );
    await expect(runMarkdownKnowledgeResourceResolution(duplicate.input))
      .rejects.toThrow(/review|duplicate|coverage|layout/i);
  });

  test("needs_review 必须由仲裁精确覆盖", async () => {
    const value = await fixture();
    await mutateReview(value.reviewFiles[0]!, (draft) => {
      draft.decisions[0].verdict = "needs_review";
      draft.decisions[0].logicalSourceDisposition = "distinct_chunk";
    });
    await expect(runMarkdownKnowledgeResourceResolution(value.input))
      .rejects.toThrow(/arbitration|unresolved|coverage/i);
  });

  test("仲裁收敛 needs_review，且拒绝 accept unit 的多余仲裁", async () => {
    const resolved = await fixture();
    let arbitrationDecision: Record<string, unknown> | undefined;
    await mutateReview(resolved.reviewFiles[1]!, (draft) => {
      const decision = draft.decisions[0];
      decision.verdict = "needs_review";
      const { verdict: ignoredVerdict, notes: ignoredNotes, ...arbitration } = decision;
      arbitration.disposition = "quarantine";
      arbitration.conflict = true;
      arbitration.reasonCodes = ["hardcoded_default_credential_pattern"];
      arbitrationDecision = arbitration;
    });
    const result = await runMarkdownKnowledgeResourceResolution(
      await writeArbitration(resolved, [arbitrationDecision!]),
    );
    const arbitratedSourceCount = (arbitrationDecision!.sources as unknown[]).length;
    expect(result).toMatchObject({
      status: "accepted",
      arbitrated: 1,
      unresolved: 0,
      quarantineSources: resolved.plan.summary.quarantineSourceCount + arbitratedSourceCount,
    });

    const extra = await fixture();
    const draft = JSON.parse(await readFile(extra.reviewFiles[0]!, "utf8"));
    const { verdict: ignoredVerdict, notes: ignoredNotes, ...accepted } = draft.decisions[0];
    await expect(runMarkdownKnowledgeResourceResolution(
      await writeArbitration(extra, [accepted]),
    )).rejects.toThrow(/arbitration|accept|extra|coverage/i);
  });

  test("拒绝 review source hash 漂移", async () => {
    const value = await fixture();
    await mutateReview(value.reviewFiles[0]!, (draft) => {
      draft.decisions[0].sources[0].sourceHash = sha256("drifted");
    });
    await expect(runMarkdownKnowledgeResourceResolution(value.input))
      .rejects.toThrow(/source|hash|binding|drift/i);
  });

  test("拒绝 review 增加 canonical target key", async () => {
    const value = await fixture();
    await mutateReview(value.reviewFiles[0]!, (draft) => {
      draft.decisions[0].canonicalTarget = "forbidden";
    });
    await expect(runMarkdownKnowledgeResourceResolution(value.input))
      .rejects.toThrow(/key|target|review/i);
  });

  test("拒绝 review 符号链接", async () => {
    const value = await fixture();
    const original = value.reviewFiles[0]!;
    const target = resolve(value.root, "review-target.txt");
    await writeFile(target, await readFile(original));
    await unlink(original);
    await symlink(target, original);
    await expect(runMarkdownKnowledgeResourceResolution(value.input))
      .rejects.toThrow(/symlink|review|layout/i);
  });

  test("输出目录已存在时不覆盖", async () => {
    const value = await fixture();
    await mkdir(value.input.outputDirectory);
    await writeFile(resolve(value.input.outputDirectory, "keep.txt"), "keep");
    await expect(runMarkdownKnowledgeResourceResolution(value.input))
      .rejects.toThrow(/output|exist|overwrite/i);
    expect(await readFile(resolve(value.input.outputDirectory, "keep.txt"), "utf8")).toBe("keep");
  });

  test("CLI 参数错误时结构化 fail closed", async () => {
    const value = await fixture();
    const args = [
      "--containment-root", value.input.containmentRoot,
      "--plan", value.input.planPath,
      "--plan-file-sha256", value.input.planFileSha256,
      "--review-root", value.input.reviewRoot,
      "--arbitration", value.input.arbitrationPath,
      "--arbitration-file-sha256", value.input.arbitrationFileSha256,
      "--output-dir", value.input.outputDirectory,
      "--created-at", value.input.createdAt,
    ];
    expect(parseMarkdownKnowledgeResourceResolutionArgs(args)).toEqual(value.input);
    expect(() => parseMarkdownKnowledgeResourceResolutionArgs([...args, "--unknown", "x"]))
      .toThrow(/CLI|argument/i);
    let failure: any;
    try {
      await execFileAsync("npx", [
        "tsx",
        resolve(process.cwd(), "scripts/operator-markdown-knowledge-resource-resolution.ts"),
      ], { cwd: process.cwd() });
    } catch (error) {
      failure = error;
    }
    expect(failure?.code).toBe(1);
    expect(JSON.parse(String(failure?.stderr))).toMatchObject({
      code: "MARKDOWN_KNOWLEDGE_RESOURCE_RESOLUTION_FAILED",
    });
  });
});
