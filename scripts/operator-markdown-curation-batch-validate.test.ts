import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import type { MemoryCurationBatchPlan } from "../packages/core/src/db/migrations/markdown-curation-batch-planner.js";
import {
  CURATION_ARTIFACT_BUNDLE_SCHEMA,
  CURATION_BATCH_RECEIPT_SCHEMA,
  CURATION_DOCUMENT_PROPOSAL_REF_SCHEMA,
  CURATION_UNIT_DECISION_SCHEMA,
  computeCurationArtifactListHash,
  type CurationArtifactBundle,
  type CurationBatchReceipt,
  type CurationDocumentProposalRef,
  type CurationUnitDecision,
} from "../packages/core/src/documents/curation-artifacts.js";
import {
  parseMarkdownCurationBatchValidationArgs,
  runMarkdownCurationBatchValidation,
} from "./operator-markdown-curation-batch-validate.js";

const temporaryRoots: string[] = [];
const HASH = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");
const SCOPE = "a".repeat(64);
const BATCH_ID = "batch_1";
const PROPOSAL_MARKDOWN = "# Grounded proposal\n";
const execFileAsync = promisify(execFile);

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [
      key,
      stableValue((value as Record<string, unknown>)[key]),
    ]));
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function canonicalJsonl(values: readonly unknown[]): string {
  return values.length === 0
    ? ""
    : `${values.map((value) => JSON.stringify(stableValue(value))).join("\n")}\n`;
}

function planFixture(): MemoryCurationBatchPlan {
  const source = { sourceRef: "memories:a", sourceHash: HASH("source-a") };
  const body = {
    schema: "mengshu.memory-curation-batch-plan/v1" as const,
    migrationRunId: "run_1",
    sourceSnapshotSha256: HASH("snapshot"),
    sourceManifestSha256: HASH("source-manifest"),
    preprocessedManifestSha256: HASH("preprocessed-manifest"),
    inventorySha256: HASH("inventory"),
    policyVersion: "curation/v1",
    createdAt: "2026-08-28T08:00:00.000Z",
    maxUnitsPerBatch: 10,
    maxBytesPerBatch: 10_000,
    units: [{
      unitId: "unit_a",
      cohort: "untyped" as const,
      scopeFingerprint: SCOPE,
      sourceRefs: [source.sourceRef],
      sourceHashes: [source.sourceHash],
      candidateTypes: [],
      qualityFlags: ["missing_type"],
      files: [{
        ...source,
        relativePath: "source/memories/a.md",
        markdownSha256: HASH("input-a"),
        bytes: 100,
      }],
      sourceCount: 1,
      bytes: 100,
    }],
    batches: [{
      batchId: BATCH_ID,
      sequence: 1,
      cohort: "untyped" as const,
      mode: "type_review" as const,
      scopeFingerprint: SCOPE,
      unitIds: ["unit_a"],
      sourceCount: 1,
      bytes: 100,
    }],
    summary: {
      sourceCount: 1,
      unitCount: 1,
      batchCount: 1,
      byCohort: { untyped: { units: 1, sources: 1 } },
    },
    guards: [
      "agent_output_is_proposal_not_disposition",
      "postgres_activation_is_forbidden_during_curation",
    ],
  };
  return {
    ...body,
    planSha256: HASH(JSON.stringify(stableValue(body))),
  };
}

function bundleFixture(plan: MemoryCurationBatchPlan): CurationArtifactBundle {
  const source = { sourceRef: "memories:a", sourceHash: HASH("source-a") };
  const unitDecisions: CurationUnitDecision[] = [{
    schema: CURATION_UNIT_DECISION_SCHEMA,
    unitId: "unit_a",
    scopeFingerprint: SCOPE,
    sources: [source],
    proposedSemanticType: "experience",
    disposition: "propose_asset",
    documentProposalIds: ["proposal_a"],
    reasonCodes: ["grounded"],
    candidateOnly: true,
  }];
  const documentProposals: CurationDocumentProposalRef[] = [{
    schema: CURATION_DOCUMENT_PROPOSAL_REF_SCHEMA,
    proposalId: "proposal_a",
    unitIds: ["unit_a"],
    scopeFingerprint: SCOPE,
    semanticType: "experience",
    relativePath: "document-proposals/proposal-a.md",
    markdownSha256: HASH(PROPOSAL_MARKDOWN),
    sources: [source],
    candidateOnly: true,
  }];
  const receipt: CurationBatchReceipt = {
    schema: CURATION_BATCH_RECEIPT_SCHEMA,
    batchId: BATCH_ID,
    planSha256: plan.planSha256,
    sourceSnapshotSha256: plan.sourceSnapshotSha256,
    sourceManifestSha256: plan.sourceManifestSha256,
    preprocessedManifestSha256: plan.preprocessedManifestSha256,
    inventorySha256: plan.inventorySha256,
    unitCount: 1,
    sourceCount: 1,
    sectionHashes: {
      unitDecisions: computeCurationArtifactListHash("unit-decisions", unitDecisions),
      documentProposals: computeCurationArtifactListHash(
        "document-proposals", documentProposals,
      ),
      relationProposals: computeCurationArtifactListHash("relation-proposals", []),
      reviewVerdicts: computeCurationArtifactListHash("review-verdicts", []),
    },
    candidateOnly: true,
    canonicalTargetsSelected: false,
    formalAssetsWritten: false,
    treeArtifactsWritten: false,
    postgresTouched: false,
    createdAt: "2026-08-28T09:00:00.000Z",
  };
  return {
    schema: CURATION_ARTIFACT_BUNDLE_SCHEMA,
    receipt,
    unitDecisions,
    documentProposals,
    relationProposals: [],
    reviewVerdicts: [],
  };
}

interface Fixture {
  readonly root: string;
  readonly planPath: string;
  readonly attemptDirectory: string;
  readonly plan: MemoryCurationBatchPlan;
  readonly bundle: CurationArtifactBundle;
  readonly input: {
    readonly containmentRoot: string;
    readonly planPath: string;
    readonly planFileSha256: string;
    readonly batchId: string;
    readonly attemptDirectory: string;
  };
}

async function writeBundle(attemptDirectory: string, bundle: CurationArtifactBundle): Promise<void> {
  const proposalDirectory = join(attemptDirectory, "document-proposals");
  await mkdir(proposalDirectory, { recursive: true });
  await Promise.all([
    writeFile(join(attemptDirectory, "batch-receipt.json"), canonicalJson(bundle.receipt)),
    writeFile(join(attemptDirectory, "unit-decisions.jsonl"), canonicalJsonl(bundle.unitDecisions)),
    writeFile(join(proposalDirectory, "manifest.jsonl"), canonicalJsonl(bundle.documentProposals)),
    writeFile(join(attemptDirectory, "relation-proposals.jsonl"), canonicalJsonl(
      bundle.relationProposals,
    )),
    writeFile(join(attemptDirectory, "review-verdicts.jsonl"), canonicalJsonl(
      bundle.reviewVerdicts,
    )),
    writeFile(join(proposalDirectory, "proposal-a.md"), PROPOSAL_MARKDOWN),
  ]);
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "mengshu-curation-validator-"));
  temporaryRoots.push(root);
  const plan = planFixture();
  const bundle = bundleFixture(plan);
  const planPath = join(root, "integration-plan-v1", "memory-curation-plan.json");
  const attemptDirectory = join(root, "integration-plan-v2", "attempt-01");
  await mkdir(dirname(planPath), { recursive: true });
  await mkdir(attemptDirectory, { recursive: true });
  const serializedPlan = canonicalJson(plan);
  await writeFile(planPath, serializedPlan);
  await writeBundle(attemptDirectory, bundle);
  return {
    root,
    planPath,
    attemptDirectory,
    plan,
    bundle,
    input: {
      containmentRoot: root,
      planPath,
      planFileSha256: HASH(serializedPlan),
      batchId: BATCH_ID,
      attemptDirectory,
    },
  };
}

async function refreshReceipt(value: Fixture): Promise<void> {
  const mutable = value.bundle as any;
  mutable.receipt.sectionHashes.unitDecisions = computeCurationArtifactListHash(
    "unit-decisions", mutable.unitDecisions,
  );
  mutable.receipt.sectionHashes.documentProposals = computeCurationArtifactListHash(
    "document-proposals", mutable.documentProposals,
  );
  await writeFile(
    join(value.attemptDirectory, "batch-receipt.json"),
    canonicalJson(value.bundle.receipt),
  );
  await writeFile(
    join(value.attemptDirectory, "unit-decisions.jsonl"),
    canonicalJsonl(value.bundle.unitDecisions),
  );
  await writeFile(
    join(value.attemptDirectory, "document-proposals", "manifest.jsonl"),
    canonicalJsonl(value.bundle.documentProposals),
  );
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("Markdown curation batch validation operator", () => {
  test("只读验收 canonical 五组件并仅返回计数、hash 与状态", async () => {
    const value = await fixture();
    const before = await readdir(value.attemptDirectory, { recursive: true });

    const result = await runMarkdownCurationBatchValidation(value.input);

    expect(result).toMatchObject({
      status: "accepted",
      batchId: BATCH_ID,
      planFileSha256: value.input.planFileSha256,
      planSha256: value.plan.planSha256,
      counts: {
        units: 1,
        sources: 1,
        documentProposals: 1,
        relationProposals: 0,
        reviewVerdicts: 0,
      },
    });
    expect(result.receiptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.artifactSetSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(result)).not.toContain(PROPOSAL_MARKDOWN.trim());
    expect(await readdir(value.attemptDirectory, { recursive: true })).toEqual(before);
  });

  test("CLI 参数必须完整、绝对且不接受未知选项", async () => {
    const value = await fixture();
    expect(parseMarkdownCurationBatchValidationArgs([
      "--containment-root", value.root,
      "--plan", value.planPath,
      "--plan-file-sha256", value.input.planFileSha256,
      "--batch-id", BATCH_ID,
      "--attempt-dir", value.attemptDirectory,
    ])).toEqual(value.input);
    expect(() => parseMarkdownCurationBatchValidationArgs([
      "--containment-root", "relative",
      "--plan", value.planPath,
      "--plan-file-sha256", value.input.planFileSha256,
      "--batch-id", BATCH_ID,
      "--attempt-dir", value.attemptDirectory,
    ])).toThrow(/argument|absolute/i);
    expect(() => parseMarkdownCurationBatchValidationArgs([
      "--containment-root", value.root,
      "--plan", value.planPath,
      "--plan-file-sha256", value.input.planFileSha256,
      "--batch-id", BATCH_ID,
      "--attempt-dir", value.attemptDirectory,
      "--unknown", "value",
    ])).toThrow(/argument|option/i);
  });

  test("CLI stdout 只输出可机器读取的验收摘要", async () => {
    const value = await fixture();
    const { stdout, stderr } = await execFileAsync(
      resolve("node_modules/.bin/tsx"),
      [
        resolve("scripts/operator-markdown-curation-batch-validate.ts"),
        "--containment-root", value.root,
        "--plan", value.planPath,
        "--plan-file-sha256", value.input.planFileSha256,
        "--batch-id", BATCH_ID,
        "--attempt-dir", value.attemptDirectory,
      ],
      { cwd: process.cwd() },
    );
    const report = JSON.parse(stdout) as Record<string, unknown>;
    expect(stderr).toBe("");
    expect(report).toMatchObject({ status: "accepted", batchId: BATCH_ID });
    expect(stdout).not.toContain(PROPOSAL_MARKDOWN.trim());
    expect(stdout).not.toContain(value.attemptDirectory);
  });

  test("拒绝 plan 文件 hash 漂移、非 canonical plan 和未知 batch", async () => {
    const value = await fixture();
    await expect(runMarkdownCurationBatchValidation({
      ...value.input,
      planFileSha256: HASH("wrong"),
    })).rejects.toThrow(/plan|hash|drift/i);

    const planText = await readFile(value.planPath, "utf8");
    await writeFile(value.planPath, ` ${planText}`);
    await expect(runMarkdownCurationBatchValidation({
      ...value.input,
      planFileSha256: HASH(` ${planText}`),
    })).rejects.toThrow(/canonical|plan/i);

    await writeFile(value.planPath, planText);
    await expect(runMarkdownCurationBatchValidation({
      ...value.input,
      batchId: "batch_missing",
    })).rejects.toThrow(/batch/i);
  });

  test("拒绝 proposal Markdown hash 漂移", async () => {
    const value = await fixture();
    await writeFile(
      join(value.attemptDirectory, "document-proposals", "proposal-a.md"),
      "# Drifted\n",
    );
    await expect(runMarkdownCurationBatchValidation(value.input)).rejects.toThrow(/markdown|hash/i);
  });

  test.each(["missing", "extra"] as const)("拒绝 %s proposal 文件", async (mode) => {
    const value = await fixture();
    const proposalDirectory = join(value.attemptDirectory, "document-proposals");
    if (mode === "missing") {
      await unlink(join(proposalDirectory, "proposal-a.md"));
    } else {
      await writeFile(join(proposalDirectory, "extra.md"), "# Extra\n");
    }
    await expect(runMarkdownCurationBatchValidation(value.input)).rejects.toThrow(
      /proposal|manifest|missing|extra|unknown/i,
    );
  });

  test("拒绝 proposal symlink、路径逃逸和 attempt 越界", async () => {
    const value = await fixture();
    const proposal = join(value.attemptDirectory, "document-proposals", "proposal-a.md");
    const outside = join(value.root, "outside.md");
    await writeFile(outside, PROPOSAL_MARKDOWN);
    await unlink(proposal);
    await symlink(outside, proposal);
    await expect(runMarkdownCurationBatchValidation(value.input)).rejects.toThrow(/symlink|link/i);

    const escaped = await mkdtemp(join(tmpdir(), "mengshu-curation-outside-"));
    temporaryRoots.push(escaped);
    await expect(runMarkdownCurationBatchValidation({
      ...value.input,
      attemptDirectory: escaped,
    })).rejects.toThrow(/contain|escape|descendant|path/i);
  });

  test("拒绝五组件之外的文件、非 canonical JSONL 和 proposal path escape", async () => {
    const value = await fixture();
    await writeFile(join(value.attemptDirectory, "notes.txt"), "unexpected");
    await expect(runMarkdownCurationBatchValidation(value.input)).rejects.toThrow(
      /component|unknown|layout/i,
    );
    await unlink(join(value.attemptDirectory, "notes.txt"));

    const decisionsPath = join(value.attemptDirectory, "unit-decisions.jsonl");
    const decisions = await readFile(decisionsPath, "utf8");
    await writeFile(decisionsPath, ` ${decisions}`);
    await expect(runMarkdownCurationBatchValidation(value.input)).rejects.toThrow(/canonical|jsonl/i);

    await writeFile(decisionsPath, canonicalJsonl(value.bundle.unitDecisions));
    (value.bundle as any).documentProposals[0]!.relativePath =
      "document-proposals/../outside.md";
    await refreshReceipt(value);
    await expect(runMarkdownCurationBatchValidation(value.input)).rejects.toThrow(/path|proposal/i);
  });

  test.each(["schema", "section_hash", "source_coverage"] as const)(
    "拒绝 bundle %s 错误",
    async (mode) => {
      const value = await fixture();
      if (mode === "schema") {
        (value.bundle.receipt as { schema: string }).schema = "unknown/v1";
        await writeFile(
          join(value.attemptDirectory, "batch-receipt.json"),
          canonicalJson(value.bundle.receipt),
        );
      } else if (mode === "section_hash") {
        (value.bundle as any).receipt.sectionHashes.unitDecisions = HASH("drift");
        await writeFile(
          join(value.attemptDirectory, "batch-receipt.json"),
          canonicalJson(value.bundle.receipt),
        );
      } else {
        (value.bundle as any).unitDecisions[0]!.sources[0]!.sourceHash = HASH("wrong-source");
        await refreshReceipt(value);
      }
      await expect(runMarkdownCurationBatchValidation(value.input)).rejects.toThrow(
        /schema|hash|source|coverage|binding/i,
      );
    },
  );

  test("拒绝 attempt 组件 symlink directory", async () => {
    const value = await fixture();
    const proposalDirectory = join(value.attemptDirectory, "document-proposals");
    const target = join(value.root, "proposal-target");
    await mkdir(target);
    for (const name of await readdir(proposalDirectory)) {
      await writeFile(join(target, name), await readFile(join(proposalDirectory, name)));
    }
    await rm(proposalDirectory, { recursive: true });
    await symlink(target, proposalDirectory);
    expect((await lstat(proposalDirectory)).isSymbolicLink()).toBe(true);
    await expect(runMarkdownCurationBatchValidation(value.input)).rejects.toThrow(/symlink|link/i);
  });
});
