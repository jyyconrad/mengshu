import type { MemoryScope } from "../../domain/types.js";
import type { SkillArtifactVersion } from "../../skills/types.js";
import { sameExactReuseScope, type ExplicitReusePermit, type HostManagedReuseAuthorizer } from "./explicit-reuse-authorizer.js";
import {
  fingerprintCompatibilitySubject,
  fingerprintTargetProfile,
  reuseDigest,
  skillCompatibilitySubject,
  type CompatibilitySubject,
  type TargetExecutionProfile,
} from "./target-compatibility.js";

const PATCH_FIELDS = ["title", "description", "applicability", "triggerConditions", "preconditions",
  "steps", "successSignals", "antiPatterns", "riskBoundaries", "evidenceMemoryIds", "evidenceChunkIds",
  "manifest", "expectedOutcomePolicyVersion"] as const;
type AtomicField = typeof PATCH_FIELDS[number];

export interface SkillPairedEvaluationPlan {
  readonly id: string;
  readonly proposerId: string;
  readonly frozenAt: string;
  readonly expiresAt: string;
  readonly sourceScope: MemoryScope;
  readonly targetScope: MemoryScope;
  readonly oldSubject: CompatibilitySubject;
  readonly newSubject: CompatibilitySubject;
  readonly atomicField: AtomicField;
  readonly diffFingerprint: string;
  readonly target: TargetExecutionProfile;
  readonly holdoutRef: string;
  readonly holdoutHash: string;
  readonly splitManifestHash: string;
  readonly objective:
    | { readonly kind: "quality"; readonly minimumGain: number }
    | { readonly kind: "compression"; readonly minimumCostReduction: number };
  readonly confidenceAlpha: number;
  readonly maximumQualityRegression: number;
  readonly criticalSubclasses: readonly string[];
  readonly minimumPairs: number;
  readonly minimumSubclassPairs: number;
  readonly budget: {
    readonly maximumPairs: number;
    readonly maximumToolCallsPerCase: number;
    readonly maximumCostPerArm: number;
    readonly maximumArmDurationMs: number;
    readonly costUnit: "tokens" | "milliseconds";
  };
  readonly rejectedRetentionMs: number;
}

export interface SkillEvaluationCaseResult {
  readonly caseId: string;
  readonly independenceGroupId: string;
  readonly subclass: string;
  readonly quality: number;
  readonly cost: number;
  readonly toolCalls: number;
  readonly hardGates: { readonly facts: boolean; readonly authority: boolean };
  readonly evidenceRef: string;
}

export interface SkillEvaluationArmResult {
  readonly planHash: string;
  readonly targetFingerprint: string;
  readonly sandboxId: string;
  readonly loadedContentHash: string;
  readonly holdoutRef: string;
  readonly holdoutHash: string;
  readonly splitManifestHash: string;
  readonly cases: readonly SkillEvaluationCaseResult[];
}

export interface SkillEvaluationSandbox {
  readonly id: string;
  readonly isolation: "fresh_sandbox";
  readonly productionWrites: false;
  readonly targetFingerprint: string;
}

/** Trusted verifier adapter, not proposer output. It must enforce budgets and honor AbortSignal. */
export interface SkillPairedEvaluator {
  readonly id: string;
  /** Atomic durable claim. Reuse of an already searched holdout must be refused. */
  claimHoldout(input: {
    readonly planHash: string; readonly holdoutRef: string; readonly holdoutHash: string;
    readonly sourceScope: MemoryScope; readonly signal: AbortSignal;
  }): Promise<boolean>;
  open(input: {
    readonly arm: "old" | "new"; readonly planHash: string; readonly target: TargetExecutionProfile;
    readonly targetScope: MemoryScope; readonly budget: SkillPairedEvaluationPlan["budget"]; readonly signal: AbortSignal;
  }): Promise<SkillEvaluationSandbox>;
  /** Reload from persisted artifacts/resources and verify the byte hash and owner review receipt. */
  load(input: {
    readonly subject: CompatibilitySubject; readonly sandboxId: string; readonly signal: AbortSignal;
  }): Promise<{
    readonly artifact: SkillArtifactVersion; readonly persistedContentHash: string; readonly reviewReceiptId: string;
  }>;
  run(input: {
    readonly arm: "old" | "new"; readonly sandboxId: string; readonly artifact: SkillArtifactVersion;
    readonly plan: SkillPairedEvaluationPlan; readonly planHash: string; readonly signal: AbortSignal;
  }): Promise<SkillEvaluationArmResult>;
  close(sandboxId: string): Promise<void>;
}

export interface PairedQualitySummary {
  readonly pairs: number;
  readonly meanDelta: number;
  readonly lowerConfidenceBound: number;
}

const NO_PUBLISH = { publishAllowed: false, executionAllowed: false } as const;
export type SkillPairedValidationResult = typeof NO_PUBLISH & (
  | { readonly status: "blocked"; readonly reason: string }
  | { readonly status: "rejected"; readonly retained: {
    readonly diffFingerprint: string; readonly applicability: readonly string[];
    readonly reasons: readonly string[]; readonly evidenceRefs: readonly string[]; readonly expiresAt: string;
  } }
  | { readonly status: "accepted_for_review"; readonly validation: {
    readonly subject: CompatibilitySubject; readonly evaluatorId: string; readonly reviewReceiptId: string;
    readonly planHash: string; readonly reportHash: string; readonly targetFingerprint: string;
    readonly holdoutRef: string; readonly validatedAt: string;
    readonly quality: PairedQualitySummary;
    readonly criticalSubclasses: Readonly<Record<string, PairedQualitySummary>>;
    readonly costReduction: number;
  } }
);

const SHA256 = /^[a-f0-9]{64}$/;
function id(value: unknown): value is string {
  return typeof value === "string" && /^[^\s\p{Cc}]{1,256}$/u.test(value);
}
function numberIn(value: number, minimum: number, maximum: number): boolean {
  return Number.isFinite(value) && value >= minimum && value <= maximum;
}
function integerIn(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && numberIn(value, minimum, maximum);
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function blocked(reason: string): SkillPairedValidationResult {
  return { status: "blocked", reason, ...NO_PUBLISH };
}

export function skillAtomicDiffFingerprint(
  old: SkillArtifactVersion, next: SkillArtifactVersion, field: AtomicField,
): string {
  return reuseDigest("mengshu.skill-atomic-patch/v1", [field, old[field] ?? null, next[field] ?? null,
    fingerprintCompatibilitySubject(skillCompatibilitySubject(old)),
    fingerprintCompatibilitySubject(skillCompatibilitySubject(next))]);
}

function validatePlan(plan: SkillPairedEvaluationPlan, now: number): void {
  fingerprintTargetProfile(plan.target);
  fingerprintCompatibilitySubject(plan.oldSubject);
  fingerprintCompatibilitySubject(plan.newSubject);
  const gain = plan.objective.kind === "quality" ? plan.objective.minimumGain
    : plan.objective.kind === "compression" ? plan.objective.minimumCostReduction : NaN;
  if (![plan.id, plan.proposerId, plan.holdoutRef].every(id) ||
      ![plan.diffFingerprint, plan.holdoutHash, plan.splitManifestHash].every((hash) => SHA256.test(hash)) ||
      !Number.isFinite(now) || !(Date.parse(plan.frozenAt) <= now && now < Date.parse(plan.expiresAt)) ||
      !PATCH_FIELDS.includes(plan.atomicField) || !numberIn(gain, Number.EPSILON, 1) ||
      !numberIn(plan.confidenceAlpha, 0.001, 0.1) || !numberIn(plan.maximumQualityRegression, 0, 0.1) ||
      !integerIn(plan.minimumPairs, 2, 5000) || !integerIn(plan.minimumSubclassPairs, 2, plan.minimumPairs) ||
      !integerIn(plan.budget.maximumPairs, plan.minimumPairs, 5000) ||
      !integerIn(plan.budget.maximumToolCallsPerCase, 0, 100) ||
      !numberIn(plan.budget.maximumCostPerArm, Number.EPSILON, 1e9) ||
      !integerIn(plan.budget.maximumArmDurationMs, 1, 30000) ||
      !["tokens", "milliseconds"].includes(plan.budget.costUnit) ||
      !integerIn(plan.rejectedRetentionMs, 1, 604800000) ||
      !Array.isArray(plan.criticalSubclasses) || plan.criticalSubclasses.length === 0 ||
      plan.criticalSubclasses.length > 32 || !plan.criticalSubclasses.every(id) ||
      new Set(plan.criticalSubclasses).size !== plan.criticalSubclasses.length ||
      plan.oldSubject.kind !== "skill" || plan.newSubject.kind !== "skill" ||
      plan.oldSubject.id !== plan.newSubject.id ||
      !(Number(plan.newSubject.revision) > Number(plan.oldSubject.revision)) ||
      !sameExactReuseScope(plan.sourceScope, plan.oldSubject.sourceScope) ||
      !sameExactReuseScope(plan.sourceScope, plan.newSubject.sourceScope) ||
      plan.sourceScope.tenantId !== plan.targetScope.tenantId || plan.sourceScope.userId !== plan.targetScope.userId) {
    throw new TypeError("plan_invalid");
  }
}

function loadedArtifact(
  loaded: Awaited<ReturnType<SkillPairedEvaluator["load"]>>,
  expected: CompatibilitySubject,
): SkillArtifactVersion {
  const artifact = loaded.artifact;
  if (!artifact || !["published", "review"].includes(artifact.status) || artifact.executionMode !== "suggest_only" ||
      artifact.scope.visibility !== "private" || artifact.ownerUserId !== expected.sourceScope.userId ||
      !id(loaded.reviewReceiptId) || loaded.persistedContentHash !== expected.contentHash ||
      fingerprintCompatibilitySubject(skillCompatibilitySubject(artifact)) !== fingerprintCompatibilitySubject(expected) ||
      !Array.isArray(artifact.manifest) || artifact.manifest.some((resource) => resource.executable !== false)) {
    throw new TypeError("artifact_or_review_invalid");
  }
  return freeze(structuredClone(artifact));
}

function armCases(
  result: SkillEvaluationArmResult, plan: SkillPairedEvaluationPlan,
  planHash: string, sandbox: SkillEvaluationSandbox, artifact: SkillArtifactVersion,
): readonly SkillEvaluationCaseResult[] {
  if (!result || result.planHash !== planHash || result.sandboxId !== sandbox.id ||
      result.targetFingerprint !== fingerprintTargetProfile(plan.target) ||
      result.loadedContentHash !== artifact.contentHash || result.holdoutRef !== plan.holdoutRef ||
      result.holdoutHash !== plan.holdoutHash || result.splitManifestHash !== plan.splitManifestHash ||
      !Array.isArray(result.cases) || !integerIn(result.cases.length, plan.minimumPairs, plan.budget.maximumPairs)) {
    throw new TypeError("evaluation_receipt_invalid");
  }
  const cases = result.cases;
  if (cases.some((item) => !item || ![item.caseId, item.independenceGroupId, item.subclass, item.evidenceRef].every(id) ||
      !numberIn(item.quality, 0, 1) || !numberIn(item.cost, 0, plan.budget.maximumCostPerArm) ||
      !integerIn(item.toolCalls, 0, plan.budget.maximumToolCallsPerCase) ||
      typeof item.hardGates?.authority !== "boolean" || typeof item.hardGates?.facts !== "boolean") ||
      new Set(cases.map((item) => item.caseId)).size !== cases.length ||
      new Set(cases.map((item) => item.independenceGroupId)).size !== cases.length ||
      cases.reduce((sum, item) => sum + item.cost, 0) > plan.budget.maximumCostPerArm) {
    throw new TypeError("evaluation_cases_or_budget_invalid");
  }
  return cases;
}

function summarize(deltas: readonly number[], alpha: number): PairedQualitySummary {
  const meanDelta = deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length;
  // One-sided Hoeffding bound for paired differences in [-1, 1]; no fabricated judge confidence.
  return { pairs: deltas.length, meanDelta,
    lowerConfidenceBound: meanDelta - Math.sqrt(2 * Math.log(1 / alpha) / deltas.length) };
}

async function bounded<T>(
  work: (signal: AbortSignal) => Promise<T>, duration: number, parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const limit = new Promise<never>((_resolve, reject) => {
    abort = () => { controller.abort(); reject(new Error("evaluation_cancelled")); };
    if (parent?.aborted) { abort(); return; }
    parent?.addEventListener("abort", abort, { once: true });
    timeout = setTimeout(() => { controller.abort(); reject(new Error("evaluation_timeout")); }, duration);
  });
  try {
    if (controller.signal.aborted) return await limit;
    return await Promise.race([work(controller.signal), limit]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (abort) parent?.removeEventListener("abort", abort);
  }
}

export class SkillPairedValidationService {
  constructor(private readonly deps: {
    readonly evaluator?: SkillPairedEvaluator;
    readonly reuseAuthorizer?: HostManagedReuseAuthorizer;
  }, private readonly now: () => number = Date.now) {}

  async validate(input: SkillPairedEvaluationPlan, signal?: AbortSignal): Promise<SkillPairedValidationResult> {
    const evaluator = this.deps.evaluator;
    if (!evaluator) return blocked("evaluator_unavailable");
    let plan: SkillPairedEvaluationPlan;
    try {
      plan = freeze(structuredClone(input));
      validatePlan(plan, this.now());
      if (!id(evaluator.id) || evaluator.id === plan.proposerId) return blocked("independent_evaluator_required");
    } catch { return blocked("plan_invalid"); }
    const planHash = reuseDigest("mengshu.skill-paired-plan/v1", plan);
    let permit: ExplicitReusePermit | undefined;
    if (!sameExactReuseScope(plan.sourceScope, plan.targetScope)) {
      permit = await this.deps.reuseAuthorizer?.authorize(plan.sourceScope, plan.targetScope, "knowledge");
      if (!permit) return blocked("reuse_grant_required");
    }
    const sandboxes: SkillEvaluationSandbox[] = [];
    const deadlines: number[] = [];
    const remaining = (index: number): number => {
      const duration = Math.ceil(deadlines[index]! - performance.now());
      if (duration <= 0) throw new Error("evaluation_timeout");
      return duration;
    };
    let outcome: SkillPairedValidationResult;
    try {
      const claimed = await bounded((abort) => evaluator.claimHoldout({ planHash, holdoutRef: plan.holdoutRef,
        holdoutHash: plan.holdoutHash, sourceScope: plan.sourceScope, signal: abort }), plan.budget.maximumArmDurationMs, signal);
      if (!claimed) return blocked("holdout_already_used");
      const artifacts: SkillArtifactVersion[] = [];
      const reviews: string[] = [];
      for (const arm of ["old", "new"] as const) {
        const deadline = performance.now() + plan.budget.maximumArmDurationMs;
        const sandbox = await bounded((abort) => evaluator.open({ arm, planHash, target: plan.target,
          targetScope: plan.targetScope, budget: plan.budget, signal: abort }), plan.budget.maximumArmDurationMs, signal);
        const duplicate = sandbox && sandboxes.some((item) => item.id === sandbox.id);
        if (sandbox && id(sandbox.id) && !duplicate) {
          sandboxes.push(sandbox);
          deadlines.push(deadline);
        }
        if (!sandbox || !id(sandbox.id) || sandbox.isolation !== "fresh_sandbox" || sandbox.productionWrites !== false ||
            sandbox.targetFingerprint !== fingerprintTargetProfile(plan.target) || duplicate) {
          throw new TypeError("sandbox_isolation_invalid");
        }
        const subject = arm === "old" ? plan.oldSubject : plan.newSubject;
        const loaded = await bounded((abort) => evaluator.load({ subject, sandboxId: sandbox.id, signal: abort }),
          remaining(sandboxes.length - 1), signal);
        artifacts.push(loadedArtifact(loaded, subject));
        reviews.push(loaded.reviewReceiptId);
      }
      const [old, next] = artifacts as [SkillArtifactVersion, SkillArtifactVersion];
      const changed = PATCH_FIELDS.filter((field) => JSON.stringify(old[field]) !== JSON.stringify(next[field]));
      if (changed.length !== 1 || changed[0] !== plan.atomicField ||
          skillAtomicDiffFingerprint(old, next, plan.atomicField) !== plan.diffFingerprint) throw new TypeError("atomic_patch_invalid");
      const results: Array<readonly SkillEvaluationCaseResult[]> = [];
      for (const [index, arm] of (["old", "new"] as const).entries()) {
        const artifact = artifacts[index]!;
        const sandbox = sandboxes[index]!;
        const result = await bounded((abort) => evaluator.run({ arm, sandboxId: sandbox.id,
          artifact, plan, planHash, signal: abort }), remaining(index), signal);
        results.push(armCases(result, plan, planHash, sandbox, artifact));
      }
      const oldCases = results[0]!;
      const newCases = results[1]!;
      const oldById = new Map(oldCases.map((item) => [item.caseId, item]));
      if (oldCases.length !== newCases.length || newCases.some((item) => {
        const paired = oldById.get(item.caseId);
        return !paired || paired.subclass !== item.subclass || paired.independenceGroupId !== item.independenceGroupId;
      })) throw new TypeError("paired_cohort_mismatch");
      const alpha = plan.confidenceAlpha / (1 + plan.criticalSubclasses.length);
      const delta = (item: SkillEvaluationCaseResult) => item.quality - oldById.get(item.caseId)!.quality;
      const quality = summarize(newCases.map(delta), alpha);
      const criticalSubclasses: Record<string, PairedQualitySummary> = Object.create(null);
      const reasons: string[] = [];
      if ([...oldCases, ...newCases].some((item) => !item.hardGates.facts || !item.hardGates.authority)) reasons.push("hard_gate_failed");
      if (quality.lowerConfidenceBound < -plan.maximumQualityRegression) reasons.push("quality_regression");
      for (const name of plan.criticalSubclasses) {
        const subclass = newCases.filter((item) => item.subclass === name);
        if (subclass.length < plan.minimumSubclassPairs) { reasons.push("critical_subclass_sample_missing"); continue; }
        const summary = summarize(subclass.map(delta), alpha);
        criticalSubclasses[name] = summary;
        if (summary.lowerConfidenceBound < -plan.maximumQualityRegression) reasons.push("critical_subclass_regression");
      }
      const oldCost = oldCases.reduce((sum, item) => sum + item.cost, 0);
      const newCost = newCases.reduce((sum, item) => sum + item.cost, 0);
      const costReduction = oldCost > 0 ? (oldCost - newCost) / oldCost : 0;
      if (plan.objective.kind === "quality" && quality.lowerConfidenceBound < plan.objective.minimumGain) reasons.push("quality_gain_unproven");
      if (plan.objective.kind === "compression" && costReduction < plan.objective.minimumCostReduction) reasons.push("cost_reduction_unproven");
      if (permit && !await this.deps.reuseAuthorizer?.revalidate(permit, "knowledge")) throw new Error("reuse_grant_revoked");
      if (reasons.length > 0) {
        outcome = { status: "rejected", ...NO_PUBLISH, retained: {
          diffFingerprint: plan.diffFingerprint, applicability: plan.target.applicability,
          reasons: [...new Set(reasons)], evidenceRefs: [...new Set(newCases.map((item) => item.evidenceRef))].slice(0, 8),
          expiresAt: new Date(this.now() + plan.rejectedRetentionMs).toISOString(),
        } };
      } else {
        const reportCase = (item: SkillEvaluationCaseResult) => [item.caseId, item.independenceGroupId,
          item.subclass, item.quality, item.cost, item.toolCalls, item.hardGates.facts, item.hardGates.authority, item.evidenceRef];
        const reportHash = reuseDigest("mengshu.skill-paired-report/v1", [planHash, evaluator.id,
          oldCases.map(reportCase), newCases.map(reportCase)]);
        outcome = { status: "accepted_for_review", ...NO_PUBLISH, validation: {
          subject: plan.newSubject, evaluatorId: evaluator.id, reviewReceiptId: reviews[1]!, planHash, reportHash,
          targetFingerprint: fingerprintTargetProfile(plan.target), holdoutRef: plan.holdoutRef,
          validatedAt: new Date(this.now()).toISOString(), quality, criticalSubclasses, costReduction,
        } };
      }
    } catch (error) {
      const known = ["evaluation_timeout", "evaluation_cancelled", "artifact_or_review_invalid", "evaluation_receipt_invalid",
        "evaluation_cases_or_budget_invalid", "sandbox_isolation_invalid", "atomic_patch_invalid", "paired_cohort_mismatch", "reuse_grant_revoked"];
      outcome = blocked(error instanceof Error && known.includes(error.message) ? error.message : "evaluator_failed");
    } finally {
      // Fresh sandboxes are owned by the verifier adapter; cleanup never executes artifact resources.
      for (const sandbox of sandboxes) {
        try { await bounded(() => evaluator.close(sandbox.id), 1000); }
        catch { outcome = blocked("sandbox_cleanup_failed"); }
      }
    }
    return freeze(outcome!);
  }
}
