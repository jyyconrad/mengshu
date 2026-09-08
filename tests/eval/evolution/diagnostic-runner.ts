import { performance } from "node:perf_hooks";
import { authorityScopeFingerprint } from "../../../packages/core/src/domain/authority-scope-fingerprint.js";
import { evolutionHash } from "../../../packages/core/src/evolution/fingerprints.js";
import { computeCanonicalContentHash } from "../../../packages/core/src/scoring/hash-utils.js";
import { comparePairedEffectRuns } from "../runners/evaluation-protocol.js";
import {
  COST_FIELDS, DIAGNOSTIC_ARMS, type DiagnosticArmFactory, type DiagnosticArmSession,
  type DiagnosticCaseResult, type DiagnosticCost, type DiagnosticDataset, type DiagnosticVerifier, type DiagnosticGovernanceMode,
} from "./types.js";

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
const hashValid = (value: string) => /^[a-f0-9]{64}$/.test(value);
const positiveInteger = (value: number) => Number.isSafeInteger(value) && value > 0;
const normalized = (text: string) => text.normalize("NFC").replace(/\s+/g, " ").trim();

export function freezeDiagnosticDataset(input: DiagnosticDataset) {
  const dataset = structuredClone(input);
  const s = dataset.settings;
  if (!dataset.id || !dataset.version || !["synthetic", "frozen-authorized"].includes(dataset.provenance) ||
      !dataset.cases.length || dataset.cases.length > 500 ||
      !positiveInteger(s.topK) || !positiveInteger(s.contextTokenBudget) || !Number.isSafeInteger(s.randomSeed) ||
      ![s.knownAt, s.asOf, s.sourceCutoffAt].every(Number.isSafeInteger) ||
      !hashValid(s.configFingerprint) || !hashValid(s.governanceSnapshotHash) || !hashValid(s.toolFingerprint) ||
      !s.schemaVersion || ![s.models.proposer, s.models.answerer, s.models.embedding].every(value => typeof value === "string" && value.trim()) ||
      !Object.keys(s.promptHashes).length || !Object.values(s.promptHashes).every(hashValid) ||
      !["cold", "warm"].includes(s.cacheMode)) throw new Error("invalid_frozen_settings");
  const ids = new Set<string>();
  const familyPartitions = new Map<string, string>();
  const rootFamilies = new Map<string, string>();
  for (const item of dataset.cases) {
    if (!item.id || ids.has(item.id) || !item.capability || !item.familyIds.length ||
        !["holdout", "calibration"].includes(item.partition) || !positiveInteger(item.material.repeatCount) ||
        item.material.repeatCount > 3 || !item.question.text || item.question.asOf !== s.asOf ||
        item.question.knownAt !== s.knownAt) throw new Error("invalid_diagnostic_case");
    ids.add(item.id);
    for (const family of item.familyIds) {
      if (!family) throw new Error("invalid_source_family");
      const prior = familyPartitions.get(family);
      if (prior && prior !== item.partition) throw new Error("family_split_leakage");
      familyPartitions.set(family, item.partition);
    }
    for (const evidence of item.material.unit.evidence) {
      if (computeCanonicalContentHash(evidence.text) !== evidence.snapshotHash) throw new Error("source_hash_mismatch");
      const previous = rootFamilies.get(evidence.rootEvidenceId);
      const familyKey = [...new Set(item.familyIds)].sort().join("\0");
      if (previous && previous !== familyKey) throw new Error("root_family_mismatch");
      rootFamilies.set(evidence.rootEvidenceId, familyKey);
      if (evidence.origin === "evaluation") throw new Error("evaluation_source_forbidden");
      if (evidence.occurredAt !== undefined && (!Number.isSafeInteger(evidence.occurredAt) || evidence.occurredAt > s.sourceCutoffAt)) throw new Error("source_after_frozen_cutoff");
    }
    for (const target of item.material.unit.targets) {
      if (computeCanonicalContentHash(target.text) !== target.beforeHash) throw new Error("target_hash_mismatch");
    }
  }
  if (!dataset.cases.some(item => item.partition === "holdout")) throw new Error("holdout_missing");
  return {
    dataset: deepFreeze(dataset),
    datasetFingerprint: evolutionHash(dataset),
    freezeFingerprint: evolutionHash(dataset.settings),
    materialFingerprint: evolutionHash(dataset.cases.map(item => ({ id: item.id, familyIds: item.familyIds, material: item.material }))),
    oracleFingerprint: evolutionHash(dataset.cases.map(item => ({ id: item.id, question: item.question, oracle: item.oracle }))),
  };
}

export const exactDiagnosticVerifier: DiagnosticVerifier = {
  id: "independent-exact-fixture-verifier/v1",
  authority: "independent-frozen-fixture",
  verify({ question, oracle, observation }) {
    const reasons: string[] = [];
    const allowed = new Set(oracle.allowedEvidenceIds);
    for (const evidence of observation.hydratedEvidence ?? []) {
      if (oracle.allowedEvidenceTextHashes?.includes(evidence.textHash) &&
          authorityScopeFingerprint(evidence.scope) === authorityScopeFingerprint(question.scope)) allowed.add(evidence.id);
    }
    if (observation.evidenceIds.some(id => !allowed.has(id)) ||
        observation.status === "answered" && observation.evidenceIds.length === 0) reasons.push("unsupported_evidence");
    const answer = normalized(observation.text ?? "");
    const fragmentsPreserved = oracle.requiredFragments.every(fragment => answer.includes(normalized(fragment)));
    const forbiddenAnswer = oracle.forbiddenFragments.some(fragment => answer.includes(normalized(fragment)));
    if (observation.status === "answered" && (!fragmentsPreserved || forbiddenAnswer)) reasons.push("claim_fidelity_failed");
    for (const memory of observation.injected ?? []) {
      if (authorityScopeFingerprint(memory.scope) !== authorityScopeFingerprint(question.scope)) reasons.push("scope_injection");
      if (memory.validFrom !== undefined && memory.validFrom > question.asOf ||
          memory.validTo !== undefined && memory.validTo <= question.asOf) reasons.push("stale_injection");
      if (!memory.evidenceIds.length || memory.evidenceIds.some(id => !allowed.has(id))) reasons.push("unsupported_evidence");
      if (oracle.forbiddenFragments.some(fragment => normalized(memory.text).includes(normalized(fragment)))) reasons.push("wrong_context_injection");
    }
    const injectedError = observation.injected === null ? null :
      reasons.some(reason => ["scope_injection", "stale_injection", "unsupported_evidence", "wrong_context_injection"].includes(reason));
    const answerCorrect = observation.status === "unavailable" ? null : observation.status === "abstained" ? oracle.allowAbstain :
      oracle.acceptedAnswers.some(value => normalized(value) === answer) && reasons.length === 0;
    return {
      answerCorrect,
      fidelity: observation.status === "unavailable" ? null : observation.status === "abstained" ? null :
        fragmentsPreserved && !forbiddenAnswer && !reasons.includes("unsupported_evidence"),
      injectedError,
      reasons: [...new Set(reasons)],
    };
  },
};

function assertCost(cost: DiagnosticCost): void {
  for (const field of COST_FIELDS) {
    const value = cost[field];
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value) ||
        field !== "databaseBytesDelta" && value < 0)) throw new Error("invalid_cost_telemetry");
  }
}
function optionalNonnegative(value: number | null): boolean {
  return value === null || Number.isFinite(value) && value >= 0;
}
function aggregate(results: DiagnosticCaseResult[]) {
  const count = (predicate: (item: DiagnosticCaseResult) => boolean) => results.filter(predicate).length;
  const totalCases = results.length;
  const answered = count(item => item.answer?.status === "answered");
  const correct = count(item => item.verdict?.answerCorrect === true);
  const correctlyAnswered = count(item => item.answer?.status === "answered" && item.verdict?.answerCorrect === true);
  const contextObserved = count(item => item.verdict?.injectedError !== undefined && item.verdict.injectedError !== null);
  const injectedErrors = count(item => item.verdict?.injectedError === true);
  const fidelityObserved = count(item => typeof item.verdict?.fidelity === "boolean");
  const fidelityFailures = count(item => item.verdict?.fidelity === false);
  const cost = Object.fromEntries(COST_FIELDS.map(field => {
    let knownTotal = 0;
    let partiallyMeasured = 0;
    const values = results.map(item => {
      const a = item.evolution?.cost[field];
      const b = item.answer?.cost[field];
      if (typeof a === "number") knownTotal += a;
      if (typeof b === "number") knownTotal += b;
      if ((typeof a === "number") !== (typeof b === "number")) partiallyMeasured++;
      return a === undefined || a === null || b === undefined || b === null ? null : a + b;
    });
    const known = values.filter((value): value is number => value !== null);
    return [field, { knownTotal, measured: known.length, partiallyMeasured,
      unknown: values.length - known.length, completeTotal: known.length === values.length ? known.reduce((sum, value) => sum + value, 0) : null }];
  })) as Record<keyof DiagnosticCost, { knownTotal: number; measured: number; partiallyMeasured: number; unknown: number; completeTotal: number | null }>;
  const latency = (field: "commitToLookupMs" | "commitToContextMs") => {
    const values = results.flatMap(item => typeof item.evolution?.[field] === "number" ? [item.evolution[field]] : []).sort((a, b) => a - b);
    return { measured: values.length, unknown: results.length - values.length,
      p50Ms: values.length ? values[Math.ceil(values.length * 0.5) - 1] : null,
      p95Ms: values.length ? values[Math.ceil(values.length * 0.95) - 1] : null };
  };
  return {
    totalCases, answered, correct, abstained: count(item => item.answer?.status === "abstained"),
    unavailable: count(item => item.answer?.status === "unavailable"), failed: count(item => item.status === "failed"),
    unknownVerdicts: count(item => item.verdict?.answerCorrect === null || item.verdict === undefined),
    answerCoverage: answered / totalCases, answeredPrecision: answered ? correctlyAnswered / answered : null,
    successRateAllCases: correct / totalCases, contextObserved, injectedErrors,
    injectionErrorRate: contextObserved ? injectedErrors / contextObserved : null,
    fidelityObserved, fidelityFailures, fidelityFailureRate: fidelityObserved ? fidelityFailures / fidelityObserved : null,
    blocked: count(item => item.evolution?.status === "blocked"), partial: count(item => item.evolution?.status === "partial"),
    repeatMutationViolations: count(item => (item.evolution?.repeatMutationDelta ?? 0) > 0),
    repeatMutationUnknown: count(item => item.evolution?.repeatMutationDelta === null || item.evolution === undefined),
    lookupPropagation: latency("commitToLookupMs"), contextPropagation: latency("commitToContextMs"), cost,
  };
}

export async function runEvolutionDiagnostic(input: {
  dataset: DiagnosticDataset;
  factory: DiagnosticArmFactory;
  verifier: DiagnosticVerifier;
  governanceMode?: DiagnosticGovernanceMode;
}) {
  const frozen = freezeDiagnosticDataset(input.dataset);
  const governanceMode = input.governanceMode ?? "auto";
  if (!["auto", "reviewed"].includes(governanceMode)) throw new Error("invalid_governance_mode");
  const cases = frozen.dataset.cases.filter(item => item.partition === "holdout");
  const stores = new Set<string>();
  const arms: Array<{ arm: typeof DIAGNOSTIC_ARMS[number]; cases: DiagnosticCaseResult[]; metrics: ReturnType<typeof aggregate> }> = [];
  for (const arm of DIAGNOSTIC_ARMS) {
    const results: DiagnosticCaseResult[] = [];
    for (const item of cases) {
      const started = performance.now();
      let session: DiagnosticArmSession | undefined;
      const result: DiagnosticCaseResult = { caseId: item.id, capability: item.capability, status: "observed", wallTimeMs: 0 };
      try {
        const isolationKey = `evolution-diagnostic:${frozen.datasetFingerprint}:${governanceMode}:${arm}:${item.id}`;
        session = await input.factory.open({ arm, governanceMode, caseId: item.id, isolationKey,
          freezeFingerprint: frozen.freezeFingerprint, settings: structuredClone(frozen.dataset.settings), material: structuredClone(item.material) });
        if (session.isolationKey !== isolationKey || session.freezeFingerprint !== frozen.freezeFingerprint) throw new Error("driver_freeze_or_isolation_mismatch");
        if (!session.storageIdentity || stores.has(session.storageIdentity)) throw new Error("driver_store_reused");
        stores.add(session.storageIdentity);
        result.storageIdentity = session.storageIdentity;
        result.evolution = structuredClone(await session.evolve());
        result.evolution.reasons = result.evolution.reasons.slice(0, 32).map(reason =>
          /^[a-z][a-z0-9_:-]{0,79}$/.test(reason) ? reason : "driver_reason_redacted");
        assertCost(result.evolution.cost);
        const governance = result.evolution.governance;
        if (!governance || governance.mode !== governanceMode ||
            ![governance.autoApplied, governance.reviewedApplied].every(optionalNonnegative) ||
            !["not-requested", "owner-source-diff-only", "unavailable"].includes(governance.reviewDecisionBasis) ||
            governanceMode === "auto" && (governance.reviewDecisionBasis !== "not-requested" || governance.reviewedApplied !== 0) ||
            (governance.reviewedApplied ?? 0) > 0 && (governance.reviewDecisionBasis !== "owner-source-diff-only" || !governance.reviewPolicyId) ||
            governance.autoApplied !== null && governance.reviewedApplied !== null && result.evolution.canonicalWrites !== null &&
              governance.autoApplied + governance.reviewedApplied !== result.evolution.canonicalWrites) throw new Error("invalid_governance_observation");
        if (!["completed", "blocked", "partial", "unavailable"].includes(result.evolution.status) ||
            !["measured", "component-measured"].includes(result.evolution.costBasis) ||
            ![result.evolution.stagedCount, result.evolution.canonicalWrites, result.evolution.evidenceWrites,
              result.evolution.repeatMutationDelta, result.evolution.commitToLookupMs, result.evolution.commitToContextMs].every(optionalNonnegative) ||
            result.evolution.confidenceDelta !== null && !Number.isFinite(result.evolution.confidenceDelta)) throw new Error("invalid_evolution_observation");
        result.answer = structuredClone(await session.answer(structuredClone(item.question)));
        assertCost(result.answer.cost);
        if (!["answered", "abstained", "unavailable"].includes(result.answer.status) ||
            result.answer.status === "answered" && !result.answer.text?.trim()) throw new Error("invalid_answer_observation");
        result.verdict = input.verifier.verify({ question: structuredClone(item.question), oracle: structuredClone(item.oracle), observation: structuredClone(result.answer) });
      } catch {
        result.status = "failed";
        result.failureCode = "diagnostic_execution_failed";
        // Driver errors may contain source snippets, credentials or provider response bodies.
        delete result.verdict;
      } finally {
        try { await session?.close(); } catch {
          result.status = "failed";
          result.failureCode = "diagnostic_cleanup_failed";
          delete result.verdict;
        }
        result.wallTimeMs = Math.round((performance.now() - started) * 100) / 100;
      }
      results.push(result);
    }
    arms.push({ arm, cases: results, metrics: aggregate(results) });
  }
  const comparisons = ([[0, 1], [0, 2], [1, 2]] as const).map(([left, right]) => {
    const baseline = arms[left];
    const candidate = arms[right];
    // Reuse the existing stratified bootstrap math, not its formal G/P labels or release gate.
    const paired = comparePairedEffectRuns({ track: "general", datasetVersion: frozen.datasetFingerprint,
      baselineVersion: `diagnostic-${baseline.arm}`, candidateVersion: `diagnostic-${candidate.arm}`,
      baseline: baseline.cases.map(item => ({ caseId: item.caseId, capability: item.capability, score: item.verdict?.answerCorrect === true ? 100 : 0 })),
      candidate: candidate.cases.map(item => ({ caseId: item.caseId, capability: item.capability, score: item.verdict?.answerCorrect === true ? 100 : 0 })),
      regressionTolerance: 0, capabilityRegressionTolerance: 0, randomSeed: frozen.dataset.settings.randomSeed });
    return { baseline: baseline.arm, candidate: candidate.arm, caseCount: paired.caseCount,
      aggregation: "capability_macro_average" as const, unknownHandling: "retained_as_unsuccessful_with_separate_coverage" as const,
      baselineScore: paired.baselineScore, candidateScore: paired.candidateScore, delta: paired.delta,
      confidenceInterval: paired.confidenceInterval,
      worstCapabilityDelta: Math.min(...paired.byCapability.map(item => item.delta)),
      byCapability: paired.byCapability.map(({ capability, caseCount, baselineScore, candidateScore, delta, confidenceInterval }) =>
        ({ capability, caseCount, baselineScore, candidateScore, delta, confidenceInterval })) };
  });
  const blockers = ["formal_scorer_not_run", "formal_gp_not_established"];
  if (frozen.dataset.provenance === "synthetic") blockers.push("synthetic_not_formal_gp");
  if (input.factory.executionBoundary === "component-controlled-model") blockers.push("not_native_runtime_or_postgres", "not_real_model");
  if (input.factory.executionBoundary === "isolated-postgres-controlled-model") blockers.push("not_real_model");
  if (arms.some(arm => arm.metrics.failed)) blockers.push("execution_failures");
  if (arms.some(arm => arm.metrics.contextObserved < arm.metrics.totalCases)) blockers.push("context_observation_incomplete");
  if (arms.some(arm => arm.metrics.injectedErrors || arm.metrics.fidelityFailures || arm.metrics.repeatMutationViolations)) blockers.push("diagnostic_hard_gate_failure");
  if (arms.some(arm => COST_FIELDS.some(field => arm.metrics.cost[field].unknown))) blockers.push("cost_telemetry_incomplete");
  return deepFreeze({
    protocol: "mengshu-evolution-abc-diagnostic/v1", scoreAuthority: "diagnostic", formalScoreEligible: false, governanceMode,
    releaseGate: "blocked", datasetId: frozen.dataset.id, datasetFingerprint: frozen.datasetFingerprint,
    freezeFingerprint: frozen.freezeFingerprint, materialFingerprint: frozen.materialFingerprint, oracleFingerprint: frozen.oracleFingerprint,
    settings: frozen.dataset.settings, provenance: frozen.dataset.provenance,
    driver: { id: input.factory.id, executionBoundary: input.factory.executionBoundary },
    verifier: { id: input.verifier.id, authority: input.verifier.authority },
    excludedCalibrationCases: frozen.dataset.cases.length - cases.length, arms, comparisons, blockers,
  });
}
