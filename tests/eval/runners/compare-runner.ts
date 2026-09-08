import type { EffectCaseScore, PairedEffectComparison } from "./evaluation-protocol.js";
import { comparePairedEffectRuns } from "./evaluation-protocol.js";
import type { GeneralEvaluationReport } from "./general-runner.js";

function scores(report: GeneralEvaluationReport, variantId: string): EffectCaseScore[] {
  const variant = report.variants.find((candidate) => candidate.variantId === variantId);
  if (variant === undefined) throw new Error(`variant '${variantId}' is missing`);
  return variant.cases.flatMap((result) => result.status === "scored" && result.score !== undefined
    ? [{ caseId: result.caseId, capability: result.capability, score: result.score }]
    : []);
}

export function compareGeneralDiagnosticRounds(input: {
  readonly baseline: GeneralEvaluationReport;
  readonly candidate: GeneralEvaluationReport;
  readonly baselineVariantId: string;
  readonly candidateVariantId: string;
  readonly regressionTolerance?: number;
  readonly capabilityRegressionTolerance?: number;
  readonly randomSeed?: number;
}): PairedEffectComparison {
  if (input.baseline.datasetId !== input.candidate.datasetId ||
      input.baseline.datasetSha256 !== input.candidate.datasetSha256 ||
      input.baseline.caseCount !== input.candidate.caseCount ||
      input.baseline.runSpec.candidateVersion !== input.candidate.runSpec.candidateVersion ||
      input.baseline.runSpec.dbSchemaVersion !== input.candidate.runSpec.dbSchemaVersion ||
      JSON.stringify(input.baseline.runSpec.promptHashes) !==
        JSON.stringify(input.candidate.runSpec.promptHashes)) {
    throw new Error("general rounds must use the same frozen dataset");
  }
  return comparePairedEffectRuns({
    track: "general",
    datasetVersion: `${input.baseline.datasetId}@${input.baseline.datasetSha256}`,
    baselineVersion: `${input.baseline.reportHash}:${input.baselineVariantId}`,
    candidateVersion: `${input.candidate.reportHash}:${input.candidateVariantId}`,
    regressionTolerance: input.regressionTolerance ?? -1,
    capabilityRegressionTolerance: input.capabilityRegressionTolerance ?? -2,
    randomSeed: input.randomSeed ?? 42,
    baseline: scores(input.baseline, input.baselineVariantId),
    candidate: scores(input.candidate, input.candidateVariantId),
  });
}
