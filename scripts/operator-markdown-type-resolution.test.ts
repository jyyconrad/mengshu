import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type { MemoryCurationBatchPlan } from "../packages/core/src/db/migrations/markdown-curation-batch-planner.js";
import { runTypeReviewMaterialize } from "./operator-markdown-type-review-materialize.js";
import { runTypeReviewReviewMaterialize } from "./operator-markdown-type-review-review-materialize.js";
import {
  runMarkdownTypeResolution,
  type RunMarkdownTypeResolutionInput,
} from "./operator-markdown-type-resolution.js";

const temporary: string[] = [];
const HASH = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");
const CREATED_AT = "2026-08-28T12:00:00.000Z";

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

function createPlan(duplicateGlobalSource = false): MemoryCurationBatchPlan {
  const units: any[] = [];
  const batches: any[] = [];
  let reviewUnitIndex = 0;
  for (let sequence = 1; sequence <= 34; sequence += 1) {
    const quarantine = sequence <= 7;
    const unitCount = quarantine
      ? sequence === 7 ? 6 : 7
      : sequence <= 10 ? 6 : 5;
    const unitIds: string[] = [];
    let sourceCount = 0;
    for (let index = 0; index < unitCount; index += 1) {
      const unitId = `${quarantine ? "q" : "r"}_${sequence}_${index}`;
      const memberCount = quarantine ? 1 : reviewUnitIndex < 10 ? 2 : 3;
      const sourceRefs = Array.from({ length: memberCount }, (_, member) => {
        if (duplicateGlobalSource && reviewUnitIndex === 6 && member === 0) {
          return "memories:r_8_0_0";
        }
        return `memories:${unitId}_${member}`;
      });
      const sourceHashes = sourceRefs.map((sourceRef) => HASH(`source:${sourceRef}`));
      units.push({
        unitId,
        cohort: quarantine ? "quarantine" : sequence === 8 ? "untyped" : "type_conflict",
        scopeFingerprint: HASH(`scope:${sequence}`),
        sourceRefs,
        sourceHashes,
        candidateTypes: quarantine ? [] : ["experience", "rules"],
        qualityFlags: quarantine ? ["legacy_quarantine"] : [],
        files: sourceRefs.map((sourceRef, member) => ({
          sourceRef,
          sourceHash: sourceHashes[member],
          relativePath: `source/${unitId}_${member}.md`,
          markdownSha256: HASH(`markdown:${sourceRef}`),
          bytes: 100,
        })),
        sourceCount: memberCount,
        bytes: memberCount * 100,
      });
      unitIds.push(unitId);
      sourceCount += memberCount;
      if (!quarantine) reviewUnitIndex += 1;
    }
    batches.push({
      batchId: `batch_${sequence}`,
      sequence,
      cohort: quarantine ? "quarantine" : sequence === 8 ? "untyped" : "type_conflict",
      mode: quarantine ? "exclude" : "type_review",
      scopeFingerprint: HASH(`scope:${sequence}`),
      unitIds,
      sourceCount,
      bytes: sourceCount * 100,
    });
  }
  const body = {
    schema: "mengshu.memory-curation-batch-plan/v1" as const,
    migrationRunId: "run_resolution_1",
    sourceSnapshotSha256: HASH("snapshot"),
    sourceManifestSha256: HASH("source-manifest"),
    preprocessedManifestSha256: HASH("preprocessed-manifest"),
    inventorySha256: HASH("inventory"),
    policyVersion: "type-resolution/v1",
    createdAt: "2026-08-28T08:00:00.000Z",
    maxUnitsPerBatch: 10,
    maxBytesPerBatch: 10_000,
    units,
    batches,
    summary: {
      sourceCount: 452,
      unitCount: 186,
      batchCount: 34,
      byCohort: {
        quarantine: { units: 48, sources: 48 },
        untyped: { units: 6, sources: 12 },
        type_conflict: { units: 132, sources: 392 },
      },
    },
    guards: [
      "agent_output_is_proposal_not_disposition",
      "postgres_activation_is_forbidden_during_curation",
    ],
  };
  return {
    ...body,
    planSha256: HASH(JSON.stringify(stable(body))),
  } as MemoryCurationBatchPlan;
}

interface Fixture {
  readonly root: string;
  readonly plan: MemoryCurationBatchPlan;
  readonly input: RunMarkdownTypeResolutionInput;
  readonly manifestPath: string;
  readonly arbitrationPath: string;
  readonly manifest: any;
  readonly arbitration: any;
}

async function fixture(options: { duplicateGlobalSource?: boolean } = {}): Promise<Fixture> {
  const root = await mkdtemp(resolve(tmpdir(), "mengshu-type-resolution-"));
  temporary.push(root);
  const plan = createPlan(options.duplicateGlobalSource);
  const planPath = resolve(root, "plan.json");
  const planText = canonicalJson(plan);
  await writeFile(planPath, planText);
  await mkdir(resolve(root, "attempts"));
  await mkdir(resolve(root, "drafts"));
  const quarantineAttempts: any[] = [];
  const reviewAttempts: any[] = [];
  const arbitrationDecisions: any[] = [];
  let globalReviewIndex = 0;

  for (const batch of plan.batches) {
    if (batch.sequence <= 7) {
      const outputDirectory = resolve(root, "attempts", `quarantine-${batch.sequence}`);
      const result = await runTypeReviewMaterialize({
        containmentRoot: root,
        planPath,
        planFileSha256: HASH(planText),
        batchId: batch.batchId,
        mode: "quarantine",
        outputDirectory,
        createdAt: "2026-08-28T09:00:00.000Z",
      });
      quarantineAttempts.push({
        sequence: batch.sequence,
        batchId: batch.batchId,
        attemptDirectory: outputDirectory,
        artifactSetSha256: result.artifactSetSha256,
      });
      continue;
    }

    const primaryDraftPath = resolve(root, "drafts", `primary-${batch.sequence}.json`);
    const decisions = batch.unitIds.map((unitId) => ({
      unitId,
      proposedSemanticType: "experience",
      dispositionCandidate: "canonical_keep",
      confidence: 0.91,
      conflict: false,
      reviewRequired: true,
      title: `Resolution ${unitId}`,
      summary: "The source records describe a reusable problem, action, and result.",
      reasonCodes: ["problem_action_result"],
      evidenceNotes: ["Every exact unit member carries the same governed content."],
    }));
    await writeFile(primaryDraftPath, canonicalJson({
      schema: "mengshu.type-review-agent-draft/v1",
      batchId: batch.batchId,
      reviewer: "agent-primary",
      createdAt: "2026-08-28T09:00:00.000Z",
      candidateOnly: true,
      decisions,
    }));
    const primaryAttemptDirectory = resolve(root, "attempts", `primary-${batch.sequence}`);
    const primary = await runTypeReviewMaterialize({
      containmentRoot: root,
      planPath,
      planFileSha256: HASH(planText),
      batchId: batch.batchId,
      mode: "draft",
      draftPath: primaryDraftPath,
      outputDirectory: primaryAttemptDirectory,
      createdAt: "2026-08-28T09:30:00.000Z",
    });
    const proposals = (await readFile(resolve(
      primaryAttemptDirectory,
      "document-proposals/manifest.jsonl",
    ), "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const reviewDraftPath = resolve(root, "drafts", `review-${batch.sequence}.json`);
    const verdicts = batch.unitIds.map((unitId) => {
      const proposal = proposals.find((candidate) => candidate.unitIds[0] === unitId);
      const verdict = globalReviewIndex === 0
        ? "override"
        : globalReviewIndex === 1 ? "needs_review" : "accept";
      const value = {
        unitId,
        proposalId: proposal.proposalId,
        reviewedArtifactHash: proposal.markdownSha256,
        verdict,
        proposedSemanticType: verdict === "override" ? "rules" : "experience",
        dispositionCandidate: verdict === "override" ? "distinct_keep" : "canonical_keep",
        confidence: 0.92,
        conflict: verdict === "override",
        reasonCodes: [verdict === "accept" ? "independent_review_agrees" : "arbitration_required"],
        notes: [verdict === "accept" ? "The independent review agrees." : "Final arbitration is required."],
      };
      if (verdict !== "accept") {
        const unit = plan.units.find((candidate) => candidate.unitId === unitId)!;
        arbitrationDecisions.push({
          unitId,
          scopeFingerprint: unit.scopeFingerprint,
          sources: unit.files.map((file) => ({
            sourceRef: file.sourceRef,
            sourceHash: file.sourceHash,
          })),
          proposalId: proposal.proposalId,
          reviewedArtifactHash: proposal.markdownSha256,
          semanticType: verdict === "override" ? "rules" : "experience",
          disposition: verdict === "override" ? "distinct_keep" : "canonical_keep",
          confidence: 0.9,
          conflict: verdict === "override",
          reasonCodes: ["deterministic_arbitration"],
        });
      }
      globalReviewIndex += 1;
      return value;
    });
    const reviewDraftText = canonicalJson({
      schema: "mengshu.type-review-review-draft/v1",
      batchId: batch.batchId,
      reviewer: "agent-reviewer",
      createdAt: "2026-08-28T10:00:00.000Z",
      candidateOnly: true,
      verdicts,
    });
    await writeFile(reviewDraftPath, reviewDraftText);
    const reviewAttemptDirectory = resolve(root, "attempts", `review-${batch.sequence}`);
    const review = await runTypeReviewReviewMaterialize({
      containmentRoot: root,
      planPath,
      planFileSha256: HASH(planText),
      batchId: batch.batchId,
      primaryAttemptDirectory,
      reviewDraftPath,
      outputDirectory: reviewAttemptDirectory,
      createdAt: "2026-08-28T10:30:00.000Z",
    });
    reviewAttempts.push({
      sequence: batch.sequence,
      batchId: batch.batchId,
      primaryAttemptDirectory,
      primaryArtifactSetSha256: primary.artifactSetSha256,
      reviewAttemptDirectory,
      reviewArtifactSetSha256: review.artifactSetSha256,
      reviewDraftPath,
      reviewDraftSha256: HASH(reviewDraftText),
    });
  }

  const manifest = {
    schema: "mengshu.type-resolution-input-manifest/v1",
    planFileSha256: HASH(planText),
    planSha256: plan.planSha256,
    quarantineAttempts,
    reviewAttempts,
  };
  const manifestPath = resolve(root, "input-manifest.json");
  const manifestText = canonicalJson(manifest);
  await writeFile(manifestPath, manifestText);
  const arbitration = {
    schema: "mengshu.type-resolution-arbitration-draft/v1",
    planSha256: plan.planSha256,
    createdAt: "2026-08-28T11:00:00.000Z",
    candidateOnly: true,
    decisions: arbitrationDecisions,
  };
  const arbitrationPath = resolve(root, "arbitration.json");
  const arbitrationText = canonicalJson(arbitration);
  await writeFile(arbitrationPath, arbitrationText);
  return {
    root,
    plan,
    manifestPath,
    arbitrationPath,
    manifest,
    arbitration,
    input: {
      containmentRoot: root,
      planPath,
      planFileSha256: HASH(planText),
      inputManifestPath: manifestPath,
      inputManifestFileSha256: HASH(manifestText),
      arbitrationDraftPath: arbitrationPath,
      arbitrationDraftFileSha256: HASH(arbitrationText),
      outputDirectory: resolve(root, "resolution-output"),
      createdAt: CREATED_AT,
    },
  };
}

async function rewriteManifest(value: Fixture): Promise<RunMarkdownTypeResolutionInput> {
  const text = canonicalJson(value.manifest);
  await writeFile(value.manifestPath, text);
  return { ...value.input, inputManifestFileSha256: HASH(text) };
}

async function rewriteArbitration(value: Fixture): Promise<RunMarkdownTypeResolutionInput> {
  const text = canonicalJson(value.arbitration);
  await writeFile(value.arbitrationPath, text);
  return { ...value.input, arbitrationDraftFileSha256: HASH(text) };
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("P2 deterministic type resolution", () => {
  test("校验全部 attempts 并生成 186 unit / 452 source 的正式决议账本", async () => {
    const value = await fixture();
    const result = await runMarkdownTypeResolution(value.input);
    expect(result).toMatchObject({
      status: "accepted",
      units: 186,
      sources: 452,
      unresolved: 0,
      acceptedPrimary: 136,
      arbitrated: 2,
    });
    const units = (await readFile(resolve(
      value.input.outputDirectory,
      "unit-type-resolutions.jsonl",
    ), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const sources = (await readFile(resolve(
      value.input.outputDirectory,
      "source-type-dispositions.jsonl",
    ), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const receipt = JSON.parse(await readFile(resolve(
      value.input.outputDirectory,
      "receipt.json",
    ), "utf8"));
    expect(units).toHaveLength(186);
    expect(sources).toHaveLength(452);
    expect(receipt).toMatchObject({
      candidateOnly: false,
      canonicalTargetsSelected: false,
      formalAssetsWritten: false,
      treeArtifactsWritten: false,
      postgresTouched: false,
    });
    await expect(runMarkdownTypeResolution(value.input)).rejects.toThrow(/output|exist|overwrite/i);
  });

  test("同一输入与 createdAt 在不同输出目录产生相同账本 hash", async () => {
    const value = await fixture();
    const first = await runMarkdownTypeResolution(value.input);
    const second = await runMarkdownTypeResolution({
      ...value.input,
      outputDirectory: resolve(value.root, "resolution-output-2"),
    });
    expect(second.outputHashes).toEqual(first.outputHashes);
    expect(second.receiptSha256).toBe(first.receiptSha256);
  });

  test("拒绝 plan 或 attempt artifact hash 篡改", async () => {
    const value = await fixture();
    await expect(runMarkdownTypeResolution({
      ...value.input,
      planFileSha256: HASH("wrong-plan"),
    })).rejects.toThrow(/plan|hash|drift/i);
    value.manifest.reviewAttempts[0].primaryArtifactSetSha256 = HASH("tampered-attempt");
    await expect(runMarkdownTypeResolution(await rewriteManifest(value)))
      .rejects.toThrow(/attempt|artifact|hash/i);
  });

  test("拒绝漏 batch、重复 arbitration unit 与跨 batch 重复 source", async () => {
    const missing = await fixture();
    missing.manifest.quarantineAttempts.pop();
    await expect(runMarkdownTypeResolution(await rewriteManifest(missing)))
      .rejects.toThrow(/sequence|batch|coverage/i);

    const duplicated = await fixture();
    duplicated.arbitration.decisions.push(structuredClone(duplicated.arbitration.decisions[0]));
    await expect(runMarkdownTypeResolution(await rewriteArbitration(duplicated)))
      .rejects.toThrow(/arbitration|duplicate|coverage/i);

    const duplicateSource = await fixture({ duplicateGlobalSource: true });
    await expect(runMarkdownTypeResolution(duplicateSource.input))
      .rejects.toThrow(/source|duplicate|coverage/i);
  });

  test("review accept 漂移和缺少仲裁均 fail closed", async () => {
    const drifted = await fixture();
    const acceptAttempt = drifted.manifest.reviewAttempts[1];
    const reviewDraft = JSON.parse(await readFile(acceptAttempt.reviewDraftPath, "utf8"));
    const accepted = reviewDraft.verdicts.find(
      (item: { verdict: string }) => item.verdict === "accept",
    );
    accepted.proposedSemanticType = "rules";
    const reviewText = canonicalJson(reviewDraft);
    await writeFile(acceptAttempt.reviewDraftPath, reviewText);
    acceptAttempt.reviewDraftSha256 = HASH(reviewText);
    await expect(runMarkdownTypeResolution(await rewriteManifest(drifted)))
      .rejects.toThrow(/accept|primary|drift/i);

    const missing = await fixture();
    missing.arbitration.decisions.pop();
    await expect(runMarkdownTypeResolution(await rewriteArbitration(missing)))
      .rejects.toThrow(/arbitration|coverage|unresolved/i);
  });

  test("仲裁不得添加 canonical target，attempt 不得越过 PG guard", async () => {
    const target = await fixture();
    target.arbitration.decisions[0].canonicalTargetRef = "memories:forbidden";
    await expect(runMarkdownTypeResolution(await rewriteArbitration(target)))
      .rejects.toThrow(/arbitration|key|target/i);

    const postgres = await fixture();
    const attempt = postgres.manifest.quarantineAttempts[0];
    const receiptPath = resolve(attempt.attemptDirectory, "batch-receipt.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    receipt.postgresTouched = true;
    await writeFile(receiptPath, canonicalJson(receipt));
    await expect(runMarkdownTypeResolution(postgres.input))
      .rejects.toThrow(/postgres|guard|artifact/i);
  });

  test("拒绝非 canonical manifest 和 symlink 输入", async () => {
    const value = await fixture();
    const original = await readFile(value.manifestPath, "utf8");
    await writeFile(value.manifestPath, ` ${original}`);
    await expect(runMarkdownTypeResolution({
      ...value.input,
      inputManifestFileSha256: HASH(` ${original}`),
    })).rejects.toThrow(/canonical|manifest/i);

    await writeFile(value.manifestPath, original);
    const link = resolve(value.root, "arbitration-link.json");
    await symlink(value.arbitrationPath, link);
    await expect(runMarkdownTypeResolution({
      ...value.input,
      inputManifestFileSha256: HASH(original),
      arbitrationDraftPath: link,
    })).rejects.toThrow(/symlink|path|input/i);
  });
});
