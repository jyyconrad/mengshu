import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { compareGeneralDiagnosticRounds } from "./compare-runner.js";
import { evaluateReleaseGate } from "./gate-runner.js";
import {
  assertGeneralEvaluationReportIntegrity,
  type GeneralEvaluationReport,
} from "./general-runner.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function readReport(file: string): GeneralEvaluationReport {
  const value = JSON.parse(readFileSync(file, "utf8")) as GeneralEvaluationReport;
  if (value.schemaVersion !== "mengshu.general-eval-report/v1" ||
      !/^[0-9a-f]{64}$/.test(value.reportHash)) throw new Error(`invalid report: ${file}`);
  assertGeneralEvaluationReportIntegrity(value);
  return value;
}

function main(): void {
  const root = path.resolve(argument("--root") ??
    path.join(os.homedir(), ".mengshu", "eval-results", "g0-v1"));
  const round1 = readReport(path.join(root, "round-1", "report.json"));
  const round2 = readReport(path.join(root, "round-2", "report.json"));
  const lexical = "lexical-diagnostic-bm25/v1";
  const stability = compareGeneralDiagnosticRounds({
    baseline: round1,
    candidate: round2,
    baselineVariantId: lexical,
    candidateVariantId: lexical,
    regressionTolerance: -1,
    capabilityRegressionTolerance: -2,
    randomSeed: 42,
  });
  const noMemoryAblation = compareGeneralDiagnosticRounds({
    baseline: round1,
    candidate: round2,
    baselineVariantId: "no-memory/v1",
    candidateVariantId: lexical,
    regressionTolerance: -1,
    capabilityRegressionTolerance: -2,
    randomSeed: 42,
  });
  const releaseGate = evaluateReleaseGate({
    qualityPassed: process.argv.includes("--quality-passed"),
    integrityPassed: true,
    generalRun: round2,
    generalComparison: stability,
    privateFreshCaseCount: 0,
  });
  const cold = round1.variants.find((variant) => variant.variantId === lexical)!;
  const warm = round2.variants.find((variant) => variant.variantId === lexical)!;
  const efficiency = Object.freeze({
    schemaVersion: "mengshu.g0-efficiency/v1",
    cold: { p50Ms: cold.latencyP50Ms, p95Ms: cold.latencyP95Ms },
    warm: { p50Ms: warm.latencyP50Ms, p95Ms: warm.latencyP95Ms },
    p50Speedup: cold.latencyP50Ms / Math.max(Number.EPSILON, warm.latencyP50Ms),
    p95Speedup: cold.latencyP95Ms / Math.max(Number.EPSILON, warm.latencyP95Ms),
  });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const [name, value] of [
    ["stability-comparison.json", stability],
    ["no-memory-ablation.json", noMemoryAblation],
    ["efficiency.json", efficiency],
    ["release-gate.json", releaseGate],
  ] as const) {
    writeFileSync(path.join(root, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  }
  process.stdout.write(`${JSON.stringify({ stability, noMemoryAblation, efficiency, releaseGate }, null, 2)}\n`);
}

main();
