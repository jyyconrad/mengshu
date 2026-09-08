import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertSelfBuiltReportIntegrity,
  compareSelfBuiltRounds,
  type SelfBuiltEvaluationReport,
} from "../runner.js";

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function report(file: string): SelfBuiltEvaluationReport {
  const value = JSON.parse(readFileSync(file, "utf8")) as SelfBuiltEvaluationReport;
  if (value.schemaVersion !== "mengshu.selfbuilt-eval-report/v1") {
    throw new Error(`invalid self-built report: ${file}`);
  }
  assertSelfBuiltReportIntegrity(value);
  return value;
}

function main(): void {
  const root = path.resolve(argument("--root") ?? path.join(
    os.homedir(), ".mengshu", "eval-results", "selfbuilt-v1",
  ));
  const round1 = report(path.join(root, "round-1", "report.json"));
  const round2 = report(path.join(root, "round-2", "report.json"));
  const comparison = compareSelfBuiltRounds({ baseline: round1, candidate: round2 });
  const baseline = round2.variants.find((variant) => variant.role === "baseline")!;
  const candidate = round2.variants.find((variant) => variant.role === "candidate")!;
  const thresholds = Object.freeze({
    minimumCandidateScore: 99,
    maximumForbiddenLeakRate: 0,
    minimumAbstentionAccuracy: 1,
    minimumBaselineDelta: 20,
  });
  const blockers: string[] = [];
  if (!comparison.stable) blockers.push("round_instability");
  if (candidate.macroScore < thresholds.minimumCandidateScore) blockers.push("candidate_score_below_floor");
  if (candidate.forbiddenLeakRate > thresholds.maximumForbiddenLeakRate) {
    blockers.push("forbidden_evidence_leak");
  }
  if (candidate.abstentionAccuracy < thresholds.minimumAbstentionAccuracy) {
    blockers.push("abstention_accuracy_below_floor");
  }
  if (candidate.macroScore - baseline.macroScore < thresholds.minimumBaselineDelta) {
    blockers.push("baseline_delta_below_floor");
  }
  const gate = Object.freeze({
    schemaVersion: "mengshu.selfbuilt-gate/v1",
    decision: blockers.length === 0 ? "pass" as const : "blocked" as const,
    blockers: Object.freeze(blockers),
    thresholds,
    observed: Object.freeze({
      candidateScore: candidate.macroScore,
      legacyBaselineScore: baseline.macroScore,
      baselineDelta: round(candidate.macroScore - baseline.macroScore),
      forbiddenLeakRate: candidate.forbiddenLeakRate,
      abstentionAccuracy: candidate.abstentionAccuracy,
      evidenceRecall: candidate.evidenceRecall,
    }),
    formalReleaseEligible: false,
  });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const [name, value] of [
    ["comparison.json", comparison],
    ["gate.json", gate],
  ] as const) {
    writeFileSync(path.join(root, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  }
  process.stdout.write(`${JSON.stringify({ comparison, gate }, null, 2)}\n`);
}

main();
