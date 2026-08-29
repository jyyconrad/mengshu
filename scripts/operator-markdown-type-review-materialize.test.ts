import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type { MemoryCurationBatchPlan } from "../packages/core/src/db/migrations/markdown-curation-batch-planner.js";
import { runTypeReviewMaterialize } from "./operator-markdown-type-review-materialize.js";
import { runTypeReviewReviewMaterialize } from "./operator-markdown-type-review-review-materialize.js";

const temporary: string[] = [];
const HASH = (value: string): string => createHash("sha256").update(value).digest("hex");

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stable(item)]));
  }
  return value;
}

function plan(): MemoryCurationBatchPlan {
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
    units: [
      {
        unitId: "unit_type",
        cohort: "untyped" as const,
        scopeFingerprint: "a".repeat(64),
        sourceRefs: ["memories:type"],
        sourceHashes: [HASH("source-type")],
        candidateTypes: [],
        qualityFlags: [],
        files: [{
          sourceRef: "memories:type", sourceHash: HASH("source-type"),
          relativePath: "source/type.md", markdownSha256: HASH("type.md"), bytes: 100,
        }],
        sourceCount: 1,
        bytes: 100,
      },
      {
        unitId: "unit_quarantine",
        cohort: "quarantine" as const,
        scopeFingerprint: undefined,
        sourceRefs: ["memories:quarantine"],
        sourceHashes: [HASH("source-quarantine")],
        candidateTypes: [],
        qualityFlags: ["legacy_quarantine"],
        files: [{
          sourceRef: "memories:quarantine", sourceHash: HASH("source-quarantine"),
          relativePath: "source/quarantine.md", markdownSha256: HASH("quarantine.md"), bytes: 100,
        }],
        sourceCount: 1,
        bytes: 100,
      },
    ],
    batches: [
      {
        batchId: "batch_type", sequence: 8, cohort: "untyped" as const,
        mode: "type_review" as const, scopeFingerprint: "a".repeat(64),
        unitIds: ["unit_type"], sourceCount: 1, bytes: 100,
      },
      {
        batchId: "batch_quarantine", sequence: 1, cohort: "quarantine" as const,
        mode: "exclude" as const, scopeFingerprint: undefined,
        unitIds: ["unit_quarantine"], sourceCount: 1, bytes: 100,
      },
    ],
    summary: {
      sourceCount: 2,
      unitCount: 2,
      batchCount: 2,
      byCohort: {
        untyped: { units: 1, sources: 1 },
        quarantine: { units: 1, sources: 1 },
      },
    },
    guards: [
      "agent_output_is_proposal_not_disposition",
      "postgres_activation_is_forbidden_during_curation",
    ],
  };
  return { ...body, planSha256: createHash("sha256")
    .update(JSON.stringify(stable(body))).digest("hex") };
}

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "mengshu-type-review-"));
  temporary.push(root);
  const planPath = resolve(root, "plan.json");
  const planText = `${JSON.stringify(stable(plan()), null, 2)}\n`;
  await writeFile(planPath, planText);
  const draftPath = resolve(root, "draft.json");
  await writeFile(draftPath, JSON.stringify({
    schema: "mengshu.type-review-agent-draft/v1",
    batchId: "batch_type",
    reviewer: "agent-a-primary",
    createdAt: "2026-08-28T09:00:00.000Z",
    candidateOnly: true,
    decisions: [{
      unitId: "unit_type",
      proposedSemanticType: "experience",
      dispositionCandidate: "canonical_keep",
      confidence: 0.91,
      conflict: false,
      reviewRequired: true,
      title: "Markdown 治理经验",
      summary: "内容描述了可复用的问题处理过程和结果。",
      reasonCodes: ["problem_action_result"],
      evidenceNotes: ["正文同时包含问题、动作与结果线索。"],
    }],
  }, null, 2));
  return {
    containmentRoot: root,
    planPath,
    planFileSha256: createHash("sha256").update(planText).digest("hex"),
    draftPath,
  };
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("type review materializer", () => {
  test("从 agent draft 确定性生成并自验五件套", async () => {
    const input = await fixture();
    const outputDirectory = resolve(input.containmentRoot, "attempt-type");
    const result = await runTypeReviewMaterialize({
      ...input,
      batchId: "batch_type",
      mode: "draft",
      outputDirectory,
      createdAt: "2026-08-28T10:00:00.000Z",
    });
    expect(result).toMatchObject({ status: "accepted", units: 1, sources: 1, proposals: 1 });
    expect(JSON.parse(await readFile(resolve(outputDirectory, "batch-receipt.json"), "utf8")))
      .toMatchObject({
        candidateOnly: true,
        canonicalTargetsSelected: false,
        formalAssetsWritten: false,
        treeArtifactsWritten: false,
        postgresTouched: false,
      });
    const names = await readdir(resolve(outputDirectory, "document-proposals"));
    expect(names).toHaveLength(2);
    expect(await readFile(resolve(outputDirectory, "document-proposals", names.find(
      (name) => name.endsWith(".md"),
    )!), "utf8")).toContain("# Markdown 治理经验");
  });

  test("quarantine batch 只生成 exclude ledger，不生成 proposal", async () => {
    const input = await fixture();
    const outputDirectory = resolve(input.containmentRoot, "attempt-quarantine");
    const result = await runTypeReviewMaterialize({
      containmentRoot: input.containmentRoot,
      planPath: input.planPath,
      planFileSha256: input.planFileSha256,
      batchId: "batch_quarantine",
      mode: "quarantine",
      outputDirectory,
      createdAt: "2026-08-28T10:00:00.000Z",
    });
    expect(result).toMatchObject({ status: "accepted", proposals: 0 });
    expect(await readdir(resolve(outputDirectory, "document-proposals")))
      .toEqual(["manifest.jsonl"]);
    expect(await readFile(resolve(outputDirectory, "unit-decisions.jsonl"), "utf8"))
      .toContain('"disposition":"exclude"');
  });

  test("拒绝 draft unit coverage 漂移和错误 batch mode", async () => {
    const input = await fixture();
    await writeFile(input.draftPath, JSON.stringify({
      schema: "mengshu.type-review-agent-draft/v1",
      batchId: "batch_type",
      reviewer: "agent-a-primary",
      createdAt: "2026-08-28T09:00:00.000Z",
      candidateOnly: true,
      decisions: [],
    }));
    await expect(runTypeReviewMaterialize({
      ...input,
      batchId: "batch_type",
      mode: "draft",
      outputDirectory: resolve(input.containmentRoot, "attempt-invalid"),
      createdAt: "2026-08-28T10:00:00.000Z",
    })).rejects.toThrow(/coverage/i);
    await expect(runTypeReviewMaterialize({
      containmentRoot: input.containmentRoot,
      planPath: input.planPath,
      planFileSha256: input.planFileSha256,
      batchId: "batch_type",
      mode: "quarantine",
      outputDirectory: resolve(input.containmentRoot, "attempt-wrong-mode"),
      createdAt: "2026-08-28T10:00:00.000Z",
    })).rejects.toThrow(/batch mode/i);
  });

  test("独立 review attempt 重放 primary hash 并写入 accept verdict", async () => {
    const input = await fixture();
    const primaryAttemptDirectory = resolve(input.containmentRoot, "attempt-primary");
    await runTypeReviewMaterialize({
      ...input,
      batchId: "batch_type",
      mode: "draft",
      outputDirectory: primaryAttemptDirectory,
      createdAt: "2026-08-28T10:00:00.000Z",
    });
    const [proposal] = (await readFile(
      resolve(primaryAttemptDirectory, "document-proposals/manifest.jsonl"), "utf8",
    )).trim().split("\n").map((line) => JSON.parse(line));
    const reviewDraftPath = resolve(input.containmentRoot, "review.json");
    await writeFile(reviewDraftPath, JSON.stringify({
      schema: "mengshu.type-review-review-draft/v1",
      batchId: "batch_type",
      reviewer: "agent-b-reviewer",
      createdAt: "2026-08-28T10:30:00.000Z",
      candidateOnly: true,
      verdicts: [{
        unitId: "unit_type",
        proposalId: proposal.proposalId,
        reviewedArtifactHash: proposal.markdownSha256,
        verdict: "accept",
        proposedSemanticType: "experience",
        dispositionCandidate: "canonical_keep",
        confidence: 0.92,
        conflict: false,
        reasonCodes: ["independent_review_agrees"],
        notes: ["独立复读后仍符合经验类型。"],
      }],
    }));
    const outputDirectory = resolve(input.containmentRoot, "attempt-review");
    const result = await runTypeReviewReviewMaterialize({
      containmentRoot: input.containmentRoot,
      planPath: input.planPath,
      planFileSha256: input.planFileSha256,
      batchId: "batch_type",
      primaryAttemptDirectory,
      reviewDraftPath,
      outputDirectory,
      createdAt: "2026-08-28T11:00:00.000Z",
    });
    expect(result).toMatchObject({ status: "accepted", accepted: 1, overridden: 0 });
    expect(await readFile(resolve(outputDirectory, "review-verdicts.jsonl"), "utf8"))
      .toContain('"verdict":"accept"');
  });

  test("override 显式拒绝 primary，accept 漂移则 fail closed", async () => {
    const input = await fixture();
    const primaryAttemptDirectory = resolve(input.containmentRoot, "attempt-primary");
    await runTypeReviewMaterialize({
      ...input,
      batchId: "batch_type",
      mode: "draft",
      outputDirectory: primaryAttemptDirectory,
      createdAt: "2026-08-28T10:00:00.000Z",
    });
    const [proposal] = (await readFile(
      resolve(primaryAttemptDirectory, "document-proposals/manifest.jsonl"), "utf8",
    )).trim().split("\n").map((line) => JSON.parse(line));
    const reviewDraftPath = resolve(input.containmentRoot, "review-override.json");
    const review = {
      schema: "mengshu.type-review-review-draft/v1",
      batchId: "batch_type",
      reviewer: "agent-b-reviewer",
      createdAt: "2026-08-28T10:30:00.000Z",
      candidateOnly: true,
      verdicts: [{
        unitId: "unit_type",
        proposalId: proposal.proposalId,
        reviewedArtifactHash: proposal.markdownSha256,
        verdict: "override",
        proposedSemanticType: "rules",
        dispositionCandidate: "distinct_keep",
        confidence: 0.8,
        conflict: true,
        reasonCodes: ["independent_review_overrides"],
        notes: ["正文主要表达约束，且冲突应并列保留。"],
      }],
    };
    await writeFile(reviewDraftPath, JSON.stringify(review));
    const outputDirectory = resolve(input.containmentRoot, "attempt-review-override");
    expect(await runTypeReviewReviewMaterialize({
      containmentRoot: input.containmentRoot,
      planPath: input.planPath,
      planFileSha256: input.planFileSha256,
      batchId: "batch_type",
      primaryAttemptDirectory,
      reviewDraftPath,
      outputDirectory,
      createdAt: "2026-08-28T11:00:00.000Z",
    })).toMatchObject({ overridden: 1 });
    expect(await readFile(resolve(outputDirectory, "review-verdicts.jsonl"), "utf8"))
      .toContain('"verdict":"reject"');

    review.verdicts[0]!.verdict = "accept";
    await writeFile(reviewDraftPath, JSON.stringify(review));
    await expect(runTypeReviewReviewMaterialize({
      containmentRoot: input.containmentRoot,
      planPath: input.planPath,
      planFileSha256: input.planFileSha256,
      batchId: "batch_type",
      primaryAttemptDirectory,
      reviewDraftPath,
      outputDirectory: resolve(input.containmentRoot, "attempt-review-invalid"),
      createdAt: "2026-08-28T11:00:00.000Z",
    })).rejects.toThrow(/accepted review drifts/i);
  });
});
