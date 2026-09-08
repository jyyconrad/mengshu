import type { PairedEffectComparison } from "./evaluation-protocol.js";
import type { GeneralEvaluationReport } from "./general-runner.js";

export interface ReleaseGateReport {
  readonly schemaVersion: "mengshu.release-gate/v1";
  readonly decision: "pass" | "blocked";
  readonly blockers: readonly string[];
}

export function evaluateReleaseGate(input: {
  readonly qualityPassed: boolean;
  readonly integrityPassed: boolean;
  readonly generalRun?: GeneralEvaluationReport;
  readonly generalComparison?: PairedEffectComparison;
  readonly privateComparison?: PairedEffectComparison;
  readonly privateFreshCaseCount?: number;
}): ReleaseGateReport {
  const blockers: string[] = [];
  if (!input.qualityPassed) blockers.push("quality_gate_failed");
  if (!input.integrityPassed) blockers.push("integrity_gate_failed");
  if (!input.generalRun?.formalScoreEligible) blockers.push("formal_general_score_missing");
  blockers.push(...(input.generalRun?.blockers ?? []));
  if (!input.generalComparison?.gatePassed) blockers.push("general_paired_gate_missing_or_failed");
  if (!input.privateComparison?.gatePassed) blockers.push("private_paired_gate_missing_or_failed");
  if ((input.privateFreshCaseCount ?? 0) < 150) blockers.push("private_fresh_quota_not_met");
  return Object.freeze({
    schemaVersion: "mengshu.release-gate/v1",
    decision: blockers.length === 0 ? "pass" : "blocked",
    blockers: Object.freeze([...new Set(blockers)]),
  });
}
