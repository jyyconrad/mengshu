import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { EvalCaseV2 } from "../public/protocol.js";
import { scoreLongMemEvalRetrieval } from "../public/scorer-bridges/longmemeval.js";
import type { EvalRunSpec } from "./evaluation-protocol.js";
import { fingerprintEvalRunSpec } from "./evaluation-protocol.js";

export type EvaluationVariantRole =
  | "no-memory"
  | "full-context"
  | "vector-only"
  | "previous-release"
  | "candidate-release"
  | "diagnostic";

export interface GeneralEvalEngineResult {
  readonly status: "completed" | "unavailable";
  readonly rankedEventIds: readonly string[];
  readonly contextTokens: number;
  readonly scoreAtK?: number;
  readonly warnings: readonly string[];
  readonly unavailableReason?: string;
}

export interface GeneralEvalEngine {
  readonly id: string;
  readonly role: EvaluationVariantRole;
  run(evalCase: Readonly<EvalCaseV2>): Promise<GeneralEvalEngineResult>;
}

export interface GeneralCaseResult {
  readonly caseId: string;
  readonly benchmarkId: string;
  readonly capability: string;
  readonly status: "scored" | "excluded" | "unavailable" | "failed";
  readonly score?: number;
  readonly recallAny?: number;
  readonly recallAll?: number;
  readonly ndcg?: number;
  readonly rankedEventIds: readonly string[];
  readonly latencyMs: number;
  readonly contextTokens: number;
  readonly warnings: readonly string[];
  readonly reason?: string;
}

export interface GeneralVariantReport {
  readonly variantId: string;
  readonly role: EvaluationVariantRole;
  readonly status: "complete" | "partial" | "failed";
  readonly scoredCases: number;
  readonly excludedCases: number;
  readonly unavailableCases: number;
  readonly failedCases: number;
  readonly diagnosticScore: number | null;
  readonly latencyP50Ms: number;
  readonly latencyP95Ms: number;
  readonly cases: readonly GeneralCaseResult[];
}

export interface GeneralEvaluationReport {
  readonly schemaVersion: "mengshu.general-eval-report/v1";
  readonly track: "general";
  readonly tier: "G0" | "G1" | "G2";
  readonly scoreAuthority: "diagnostic";
  readonly officialAnswerScoring: "not_run";
  readonly formalScoreEligible: false;
  readonly generatedAt: string;
  readonly runSpec: Readonly<EvalRunSpec>;
  readonly runFingerprint: string;
  readonly datasetId: string;
  readonly datasetSha256: string;
  readonly caseCount: number;
  readonly controls: Readonly<Record<Exclude<EvaluationVariantRole, "diagnostic">, {
    readonly status: "available" | "missing";
    readonly variantId?: string;
  }>>;
  readonly blockers: readonly string[];
  readonly variants: readonly GeneralVariantReport[];
  readonly reportHash: string;
}

const REQUIRED_ROLES = [
  "no-memory", "full-context", "vector-only", "previous-release", "candidate-release",
] as const;

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function percentile(values: readonly number[], probability: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * probability) - 1);
  return round(sorted[Math.max(0, index)]!);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function reportHash(value: Omit<GeneralEvaluationReport, "reportHash">): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function assertGeneralEvaluationReportIntegrity(report: GeneralEvaluationReport): void {
  const { reportHash: actualHash, ...unsigned } = report;
  const expectedHash = reportHash(unsigned);
  if (actualHash !== expectedHash ||
      report.runFingerprint !== fingerprintEvalRunSpec(report.runSpec)) {
    throw new Error("general evaluation report integrity check failed");
  }
}

function scoreCase(
  evalCase: Readonly<EvalCaseV2>,
  engineResult: GeneralEvalEngineResult,
  latencyMs: number,
): GeneralCaseResult {
  if (engineResult.status === "unavailable") {
    return Object.freeze({
      caseId: evalCase.id, benchmarkId: evalCase.benchmarkId,
      capability: evalCase.capability, status: "unavailable",
      rankedEventIds: Object.freeze([...engineResult.rankedEventIds]),
      latencyMs: round(latencyMs), contextTokens: engineResult.contextTokens,
      warnings: Object.freeze([...engineResult.warnings]),
      reason: engineResult.unavailableReason ?? "engine_unavailable",
    });
  }
  if (evalCase.benchmarkId === "longmemeval-cleaned" &&
      evalCase.official?.retrievalAbstentionExcluded === true) {
    return Object.freeze({
      caseId: evalCase.id, benchmarkId: evalCase.benchmarkId,
      capability: evalCase.capability, status: "excluded",
      rankedEventIds: Object.freeze([...engineResult.rankedEventIds]),
      latencyMs: round(latencyMs), contextTokens: engineResult.contextTokens,
      warnings: Object.freeze([...engineResult.warnings, "official_retrieval_abstention_excluded"]),
      reason: "official_retrieval_abstention_excluded",
    });
  }
  const corpusIds = evalCase.memoryStream.map((event) => event.eventId);
  const score = scoreLongMemEvalRetrieval({
    rankedIds: engineResult.rankedEventIds,
    correctIds: evalCase.gold.requiredEvidenceRefs,
    corpusIds,
    k: engineResult.scoreAtK ?? evalCase.protocol.topK,
  });
  return Object.freeze({
    caseId: evalCase.id, benchmarkId: evalCase.benchmarkId,
    capability: evalCase.capability, status: "scored",
    score: round(100 * (score.recallAll + score.ndcg) / 2),
    recallAny: score.recallAny, recallAll: score.recallAll, ndcg: round(score.ndcg),
    rankedEventIds: Object.freeze([...engineResult.rankedEventIds]),
    latencyMs: round(latencyMs), contextTokens: engineResult.contextTokens,
    warnings: Object.freeze([...engineResult.warnings]),
  });
}

async function runVariant(
  engine: GeneralEvalEngine,
  cases: readonly Readonly<EvalCaseV2>[],
): Promise<GeneralVariantReport> {
  const results: GeneralCaseResult[] = [];
  for (const evalCase of cases) {
    const started = performance.now();
    try {
      const result = await engine.run(evalCase);
      results.push(scoreCase(evalCase, result, performance.now() - started));
    } catch (error) {
      results.push(Object.freeze({
        caseId: evalCase.id, benchmarkId: evalCase.benchmarkId,
        capability: evalCase.capability, status: "failed",
        rankedEventIds: Object.freeze([]), latencyMs: round(performance.now() - started),
        contextTokens: 0, warnings: Object.freeze([]),
        reason: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  const scored = results.filter((result) => result.status === "scored");
  const unavailableCases = results.filter((result) => result.status === "unavailable").length;
  const failedCases = results.filter((result) => result.status === "failed").length;
  return Object.freeze({
    variantId: engine.id,
    role: engine.role,
    status: failedCases > 0 || scored.length === 0
      ? "failed"
      : unavailableCases > 0 ? "partial" : "complete",
    scoredCases: scored.length,
    excludedCases: results.filter((result) => result.status === "excluded").length,
    unavailableCases,
    failedCases,
    diagnosticScore: scored.length === 0
      ? null
      : round(scored.reduce((sum, result) => sum + result.score!, 0) / scored.length),
    latencyP50Ms: percentile(results.map((result) => result.latencyMs), 0.5),
    latencyP95Ms: percentile(results.map((result) => result.latencyMs), 0.95),
    cases: Object.freeze(results),
  });
}

export async function runGeneralEvaluation(input: {
  readonly tier: "G0" | "G1" | "G2";
  readonly generatedAt: string;
  readonly runSpec: Readonly<EvalRunSpec>;
  readonly datasetId: string;
  readonly datasetSha256: string;
  readonly cases: readonly Readonly<EvalCaseV2>[];
  readonly engines: readonly GeneralEvalEngine[];
}): Promise<GeneralEvaluationReport> {
  if (input.cases.length === 0 || input.cases.some((evalCase) => evalCase.track !== "general") ||
      new Set(input.cases.map((evalCase) => evalCase.id)).size !== input.cases.length ||
      !/^[0-9a-f]{64}$/.test(input.datasetSha256) ||
      !Number.isFinite(Date.parse(input.generatedAt))) {
    throw new Error("invalid general evaluation input");
  }
  if (new Set(input.engines.map((engine) => engine.id)).size !== input.engines.length) {
    throw new Error("evaluation engine ids must be unique");
  }
  const variants: GeneralVariantReport[] = [];
  for (const engine of input.engines) {
    variants.push(await runVariant(engine, input.cases));
  }
  const controls = Object.freeze(Object.fromEntries(REQUIRED_ROLES.map((role) => {
    const variant = variants.find((candidate) => candidate.role === role);
    return [role, variant === undefined
      ? Object.freeze({ status: "missing" as const })
      : Object.freeze({ status: "available" as const, variantId: variant.variantId })];
  }))) as GeneralEvaluationReport["controls"];
  const blockers = [
    ...REQUIRED_ROLES.filter((role) => controls[role].status === "missing")
      .map((role) => `required_control_missing:${role}`),
    "official_answer_scorer_not_run",
  ];
  const base = Object.freeze({
    schemaVersion: "mengshu.general-eval-report/v1" as const,
    track: "general" as const,
    tier: input.tier,
    scoreAuthority: "diagnostic" as const,
    officialAnswerScoring: "not_run" as const,
    formalScoreEligible: false as const,
    generatedAt: input.generatedAt,
    runSpec: input.runSpec,
    runFingerprint: fingerprintEvalRunSpec(input.runSpec),
    datasetId: input.datasetId,
    datasetSha256: input.datasetSha256,
    caseCount: input.cases.length,
    controls,
    blockers: Object.freeze(blockers),
    variants: Object.freeze(variants),
  });
  return Object.freeze({ ...base, reportHash: reportHash(base) });
}
