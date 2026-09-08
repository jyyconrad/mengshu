import { describe, expect, test, vi } from "vitest";
import type { MemoryScope } from "../../domain/types.js";
import type { SkillArtifactVersion } from "../../skills/types.js";
import { fingerprintTargetProfile, skillCompatibilitySubject } from "./target-compatibility.js";
import {
  SkillPairedValidationService,
  skillAtomicDiffFingerprint,
  type SkillEvaluationArmResult,
  type SkillPairedEvaluationPlan,
  type SkillPairedEvaluator,
} from "./skill-paired-validator.js";

const scope: MemoryScope & { visibility: "private" } = { tenantId: "t", userId: "u", appId: "codex",
  agentId: "a", projectId: "p", namespace: "memory", visibility: "private" };
const old: SkillArtifactVersion = {
  skillId: "skill-a", version: 1, isHead: false, ownerUserId: "u", scope, title: "Reviewed pattern",
  description: "A bounded procedure.", triggerConditions: ["review"], preconditions: ["read-only"],
  steps: ["Old suggestion"], successSignals: ["verified"], antiPatterns: [], riskBoundaries: ["no writes"],
  evidenceMemoryIds: ["m"], evidenceChunkIds: ["e"], manifest: [], contentHash: "a".repeat(64),
  status: "published", executionMode: "suggest_only", expectedOutcomePolicyVersion: "v1",
  createdAt: "2026-09-01T00:00:00.000Z",
};
const next: SkillArtifactVersion = { ...old, version: 3, isHead: true, steps: ["New suggestion"],
  contentHash: "b".repeat(64), status: "review" };
const now = Date.parse("2026-09-06T00:00:00Z");

function plan(): SkillPairedEvaluationPlan {
  return {
    id: "plan-a", proposerId: "proposer-a", frozenAt: "2026-09-05T00:00:00.000Z",
    expiresAt: "2026-09-07T00:00:00.000Z", sourceScope: scope, targetScope: scope,
    oldSubject: skillCompatibilitySubject(old), newSubject: skillCompatibilitySubject(next),
    atomicField: "steps", diffFingerprint: skillAtomicDiffFingerprint(old, next, "steps"),
    target: { model: { provider: "offline", modelId: "test", revision: "1" },
      tools: [{ name: "read", version: "1", schemaHash: "d".repeat(64) }],
      environmentFingerprint: "e".repeat(64), applicability: ["read-only"] },
    holdoutRef: "holdout-1", holdoutHash: "f".repeat(64), splitManifestHash: "1".repeat(64),
    objective: { kind: "quality", minimumGain: 0.05 },
    confidenceAlpha: 0.05, maximumQualityRegression: 0.1,
    criticalSubclasses: ["permission-sensitive"], minimumPairs: 200, minimumSubclassPairs: 200,
    budget: { maximumPairs: 2000, maximumToolCallsPerCase: 3, maximumCostPerArm: 300000,
      maximumArmDurationMs: 1000, costUnit: "tokens" },
    rejectedRetentionMs: 1000,
  };
}

function evaluator(p = plan(), qualityOld = 0, qualityNew = 1, pairs = 200) {
  let consumed = false;
  const closed: string[] = [];
  const run = vi.fn(async (input: Parameters<SkillPairedEvaluator["run"]>[0]): Promise<SkillEvaluationArmResult> => ({
    planHash: input.planHash, targetFingerprint: fingerprintTargetProfile(p.target),
    sandboxId: input.sandboxId, loadedContentHash: input.artifact.contentHash,
    holdoutRef: p.holdoutRef, holdoutHash: p.holdoutHash, splitManifestHash: p.splitManifestHash,
    cases: Array.from({ length: pairs }, (_, i) => ({
      caseId: `case-${i}`, independenceGroupId: `group-${i}`, subclass: "permission-sensitive",
      quality: input.arm === "old" ? qualityOld : qualityNew,
      cost: input.arm === "old" ? 100 : 50, toolCalls: 1,
      hardGates: { facts: true, authority: true }, evidenceRef: `receipt-${input.arm}-${i}`,
    })),
  }));
  const port: SkillPairedEvaluator = {
    id: "verifier-a",
    claimHoldout: async () => { if (consumed) return false; consumed = true; return true; },
    open: async (input) => ({ id: `isolated-${input.arm}`, isolation: "fresh_sandbox",
      productionWrites: false, targetFingerprint: fingerprintTargetProfile(p.target) }),
    load: async (input) => ({ artifact: structuredClone(input.subject.revision === "1" ? old : next),
      persistedContentHash: input.subject.contentHash, reviewReceiptId: `review-${input.subject.revision}` }),
    run,
    close: async (id) => { closed.push(id); },
  };
  return { port, run, closed };
}

describe("bounded paired Skill validation", () => {
  test("undeclared objectives, future plans and non-independent evaluators stop before execution", async () => {
    const e = evaluator();
    const service = new SkillPairedValidationService({ evaluator: e.port }, () => now);
    expect(await service.validate({ ...plan(), maximumQualityRegression: 1 })).toMatchObject({ status: "blocked", reason: "plan_invalid" });
    expect(await service.validate({ ...plan(), frozenAt: "2026-09-07T00:00:00.000Z" })).toMatchObject({ status: "blocked", reason: "plan_invalid" });
    expect(await service.validate({ ...plan(), proposerId: e.port.id })).toMatchObject({ status: "blocked", reason: "independent_evaluator_required" });
    expect(e.run).not.toHaveBeenCalled();
  });

  test("timeouts and caller cancellation do not publish and close all opened sandboxes", async () => {
    const p = { ...plan(), budget: { ...plan().budget, maximumArmDurationMs: 20 } };
    const e = evaluator(p);
    e.port.run = async () => new Promise(() => {});
    expect(await new SkillPairedValidationService({ evaluator: e.port }, () => now).validate(p))
      .toMatchObject({ status: "blocked", reason: "evaluation_timeout", publishAllowed: false });
    expect(e.closed).toEqual(["isolated-old", "isolated-new"]);
    const cancelled = new AbortController();
    cancelled.abort();
    expect(await new SkillPairedValidationService({ evaluator: evaluator().port }, () => now).validate(plan(), cancelled.signal))
      .toMatchObject({ status: "blocked", reason: "evaluation_cancelled" });
  });

  test("cleanup failure and untrusted evaluator exceptions cannot produce accepted receipts", async () => {
    const e = evaluator();
    e.port.close = async () => { throw new Error("secret-path"); };
    expect(await new SkillPairedValidationService({ evaluator: e.port }, () => now).validate(plan()))
      .toMatchObject({ status: "blocked", reason: "sandbox_cleanup_failed" });
    const failed = evaluator();
    failed.port.run = async () => { throw new Error("secret-path"); };
    const result = await new SkillPairedValidationService({ evaluator: failed.port }, () => now).validate(plan());
    expect(result).toMatchObject({ status: "blocked", reason: "evaluator_failed" });
    expect(JSON.stringify(result)).not.toContain("secret-path");
  });

  test("missing evaluator blocks without invented metrics, execution or publication", async () => {
    expect(await new SkillPairedValidationService({}, () => now).validate(plan())).toEqual({
      status: "blocked", reason: "evaluator_unavailable", publishAllowed: false, executionAllowed: false,
    });
  });

  test("isolates and reloads old/new persisted artifacts; accepts only for review", async () => {
    const e = evaluator();
    const service = new SkillPairedValidationService({ evaluator: e.port }, () => now);
    const result = await service.validate(plan());
    expect(result).toMatchObject({ status: "accepted_for_review", publishAllowed: false, executionAllowed: false });
    expect(e.run.mock.calls.map(([call]) => [call.arm, call.sandboxId, call.artifact.executionMode]))
      .toEqual([["old", "isolated-old", "suggest_only"], ["new", "isolated-new", "suggest_only"]]);
    expect(e.closed).toEqual(["isolated-old", "isolated-new"]);
    expect(await service.validate(plan())).toMatchObject({ status: "blocked", reason: "holdout_already_used" });
  });

  test("compression requires predeclared noninferiority and lower measured cost", async () => {
    const p = { ...plan(), objective: { kind: "compression" as const, minimumCostReduction: 0.2 } };
    const e = evaluator(p, 1, 1, 1000);
    expect(await new SkillPairedValidationService({ evaluator: e.port }, () => now).validate(p))
      .toMatchObject({ status: "accepted_for_review" });
  });

  test("failed hard gate rejects and retains only bounded references, applicability and fingerprints", async () => {
    const e = evaluator();
    const original = e.port.run;
    e.port.run = async (input) => {
      const result = await original(input);
      return { ...result, cases: result.cases.map((row, i) => i === 0
        ? { ...row, hardGates: { facts: true, authority: false }, secret: "must-not-retain" } : row) };
    };
    const result = await new SkillPairedValidationService({ evaluator: e.port }, () => now).validate(plan());
    expect(result).toMatchObject({ status: "rejected", retained: { reasons: ["hard_gate_failed"] } });
    expect(JSON.stringify(result)).not.toContain("must-not-retain");
    expect(JSON.stringify(result)).not.toContain(old.description);
  });

  test.each(["model-drift", "same-sandbox", "unreviewed", "artifact-drift", "multi-patch", "unpaired", "duplicate-evidence", "budget"])(
    "%s cannot create a validation receipt", async (fault) => {
      const e = evaluator();
      if (fault === "same-sandbox") e.port.open = async () => ({ id: "same", isolation: "fresh_sandbox",
        productionWrites: false, targetFingerprint: fingerprintTargetProfile(plan().target) });
      if (["unreviewed", "artifact-drift", "multi-patch"].includes(fault)) {
        const load = e.port.load;
        e.port.load = async (input) => {
          const loaded = await load(input);
          return { ...loaded, artifact: { ...loaded.artifact,
            ...(fault === "unreviewed" ? { status: "draft" as const } : {}),
            ...(fault === "artifact-drift" ? { contentHash: "9".repeat(64) } : {}),
            ...(fault === "multi-patch" && input.subject.revision !== "1" ? { description: "Another change" } : {}),
          } };
        };
      }
      const run = e.port.run;
      e.port.run = async (input) => {
        const result = await run(input);
        if (fault === "model-drift") return { ...result, targetFingerprint: "9".repeat(64) };
        if (fault === "unpaired" && input.arm === "new") return { ...result, cases: result.cases.slice(1) };
        if (fault === "duplicate-evidence") return { ...result, cases: result.cases.map((row) => ({ ...row, independenceGroupId: "same" })) };
        if (fault === "budget") return { ...result, cases: result.cases.map((row) => ({ ...row, toolCalls: 100 })) };
        return result;
      };
      expect((await new SkillPairedValidationService({ evaluator: e.port }, () => now).validate(plan())).status)
        .not.toBe("accepted_for_review");
    },
  );

  test("critical subclasses and objectives cannot be rescued by aggregate improvements", async () => {
    const e = evaluator(plan(), 1, 0);
    const result = await new SkillPairedValidationService({ evaluator: e.port }, () => now).validate(plan());
    expect(result).toMatchObject({ status: "rejected" });
    if (result.status === "rejected") expect(result.retained.reasons).toContain("critical_subclass_regression");
  });
});
