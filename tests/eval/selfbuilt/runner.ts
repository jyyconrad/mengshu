import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { filterRecallEligibleRecords } from
  "../../../packages/core/src/domain/recall-filter.js";
import type { MemoryRecord } from "../../../packages/core/src/domain/types.js";
import type { SelfBuiltDatasetManifest } from "./generator.js";
import type {
  SelfBuiltCapability,
  SelfBuiltEvalCaseV1,
  SelfBuiltMemoryEventV1,
  SelfBuiltScenario,
} from "./protocol.js";

export type SelfBuiltEngineRole = "baseline" | "candidate";

export interface SelfBuiltEngineResult {
  readonly rankedEventIds: readonly string[];
  readonly warnings: readonly string[];
}

export interface SelfBuiltEngine {
  readonly id: string;
  readonly role: SelfBuiltEngineRole;
  run(evalCase: Readonly<SelfBuiltEvalCaseV1>): Promise<SelfBuiltEngineResult>;
}

export interface SelfBuiltCaseResult {
  readonly caseId: string;
  readonly capability: SelfBuiltCapability;
  readonly scenario: SelfBuiltScenario;
  readonly score: number;
  readonly evidenceRecall: number;
  readonly ndcg: number;
  readonly forbiddenLeak: boolean;
  readonly abstentionCorrect: boolean | null;
  readonly rankedEvidenceRefs: readonly string[];
  readonly latencyMs: number;
  readonly warnings: readonly string[];
}

export interface SelfBuiltVariantReport {
  readonly variantId: string;
  readonly role: SelfBuiltEngineRole;
  readonly macroScore: number;
  readonly evidenceRecall: number;
  readonly forbiddenLeakRate: number;
  readonly abstentionAccuracy: number;
  readonly latencyP50Ms: number;
  readonly latencyP95Ms: number;
  readonly byCapability: Readonly<Record<SelfBuiltCapability, number>>;
  readonly cases: readonly SelfBuiltCaseResult[];
}

export interface SelfBuiltRunSpec {
  readonly candidateVersion: string;
  readonly dbSchemaVersion: string;
  readonly worktreeSha256: string;
  readonly datasetSha256: string;
  readonly cacheMode: "cold" | "warm";
  readonly engineContract: "selfbuilt-governed-retrieval/v1";
}

export interface SelfBuiltEvaluationReport {
  readonly schemaVersion: "mengshu.selfbuilt-eval-report/v1";
  readonly track: "selfbuilt";
  readonly scoreName: "SBS";
  readonly scoreAuthority: "selfbuilt-diagnostic";
  readonly formalReleaseEligible: false;
  readonly generatedAt: string;
  readonly runSpec: Readonly<SelfBuiltRunSpec>;
  readonly runFingerprint: string;
  readonly datasetId: "mengshu-selfbuilt-v1";
  readonly datasetVersion: "template-v1";
  readonly caseCount: number;
  readonly baselineCandidateDelta: number;
  readonly variants: readonly SelfBuiltVariantReport[];
  readonly reportHash: string;
}

export interface SelfBuiltRoundComparison {
  readonly schemaVersion: "mengshu.selfbuilt-comparison/v1";
  readonly scoreName: "SBS";
  readonly datasetSha256: string;
  readonly baselineReportHash: string;
  readonly candidateReportHash: string;
  readonly caseCount: number;
  readonly round1CandidateScore: number;
  readonly round2CandidateScore: number;
  readonly delta: number;
  readonly changedCaseCount: number;
  readonly stable: boolean;
  readonly p50Speedup: number;
  readonly p95Speedup: number;
}

interface PreparedEvent {
  readonly event: SelfBuiltMemoryEventV1;
  readonly tokens: readonly string[];
  readonly occurredAt: number;
}

const WORDS = /[\p{L}\p{N}]+/gu;

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function percentile(values: readonly number[], probability: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return round(sorted[Math.max(0, Math.ceil(sorted.length * probability) - 1)]!);
}

function tokens(value: string): string[] {
  return (value.toLocaleLowerCase("en-US").match(WORDS) ?? [])
    .flatMap((token) => /\p{Script=Han}/u.test(token) && token.length > 1
      ? [token, ...Array.from(token)]
      : [token]);
}

function prepare(evalCase: Readonly<SelfBuiltEvalCaseV1>): PreparedEvent[] {
  return evalCase.memoryStream.map((event) => Object.freeze({
    event,
    tokens: Object.freeze(tokens(event.text)),
    occurredAt: Date.parse(event.occurredAt),
  }));
}

function rank(
  evalCase: Readonly<SelfBuiltEvalCaseV1>,
  events: readonly PreparedEvent[],
  requirePositiveScore: boolean,
): SelfBuiltMemoryEventV1[] {
  const queryTokens = [...new Set(tokens(evalCase.query.text))];
  const averageLength = events.reduce((sum, item) => sum + item.tokens.length, 0) /
    Math.max(1, events.length);
  const documentFrequency = new Map(queryTokens.map((term) => [term,
    events.filter((item) => item.tokens.includes(term)).length]));
  return events.map((item) => {
    const frequencies = new Map<string, number>();
    for (const token of item.tokens) {
      if (documentFrequency.has(token)) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }
    const score = queryTokens.reduce((sum, term) => {
      const frequency = frequencies.get(term) ?? 0;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (events.length - df + 0.5) / (df + 0.5));
      const denominator = frequency + 1.2 * (0.25 + 0.75 * item.tokens.length /
        Math.max(1, averageLength));
      return sum + idf * (frequency * 2.2 / Math.max(Number.EPSILON, denominator));
    }, 0);
    return { item, score };
  }).filter((item) => !requirePositiveScore || item.score > 0)
    .sort((left, right) => right.score - left.score ||
      right.item.occurredAt - left.item.occurredAt ||
      left.item.event.eventId.localeCompare(right.item.event.eventId))
    .slice(0, evalCase.query.topK)
    .map((item) => item.item.event);
}

function memoryRecord(event: SelfBuiltMemoryEventV1): MemoryRecord {
  return {
    id: event.eventId,
    scope: event.scope,
    kind: event.kind,
    semanticType: event.semanticType,
    lifecycleStatus: event.lifecycleStatus,
    container: "project",
    confidence: 1,
    hotness: 0,
    text: event.text,
    contentHash: createHash("sha256").update(event.text).digest("hex"),
    importance: 1,
    category: "fact",
    dataType: "memory",
    metadata: {
      admissionRoute: event.admissionRoute,
      contextEligible: event.admissionRoute === "active",
      riskFlags: [],
    },
    provenance: { source: event.sourceClass, sourceId: event.evidenceRef },
    sourceNodeIds: [event.evidenceRef],
    ...(event.supersededBy === undefined ? {} : { supersededBy: event.supersededBy }),
    createdAt: Date.parse(event.occurredAt),
  };
}

function cachedEngine(input: {
  readonly id: string;
  readonly role: SelfBuiltEngineRole;
  readonly cacheMode: "cold" | "warm";
  readonly cases?: readonly Readonly<SelfBuiltEvalCaseV1>[];
  readonly governed: boolean;
}): SelfBuiltEngine {
  const cache = new Map<string, PreparedEvent[]>();
  if (input.cacheMode === "warm") {
    for (const evalCase of input.cases ?? []) cache.set(evalCase.id, prepare(evalCase));
  }
  return Object.freeze({
    id: input.id,
    role: input.role,
    async run(evalCase: Readonly<SelfBuiltEvalCaseV1>): Promise<SelfBuiltEngineResult> {
      const prepared = cache.get(evalCase.id) ?? prepare(evalCase);
      cache.set(evalCase.id, prepared);
      if (!input.governed) {
        return Object.freeze({
          rankedEventIds: Object.freeze(rank(evalCase, prepared, false).map((item) => item.eventId)),
          warnings: Object.freeze(["baseline_ignores_governance"]),
        });
      }
      const at = Date.parse(evalCase.query.occurredAt);
      const temporallyEligible = prepared.filter(({ event }) =>
        Date.parse(event.validFrom) <= at &&
        (event.validTo === undefined || at < Date.parse(event.validTo)));
      const eligibleIds = new Set(filterRecallEligibleRecords(
        temporallyEligible.map(({ event }) => memoryRecord(event)),
        evalCase.query.scope,
      ).map((record) => record.id));
      const eligible = temporallyEligible.filter(({ event }) => eligibleIds.has(event.eventId));
      const warnings = evalCase.scenario === "hydration-fallback" &&
          eligible.some(({ event }) => event.hydrationState === "unavailable")
        ? ["hydration_unavailable", "lexical_fallback_used"]
        : [];
      return Object.freeze({
        rankedEventIds: Object.freeze(rank(evalCase, eligible, true).map((item) => item.eventId)),
        warnings: Object.freeze(warnings),
      });
    },
  });
}

export function createLegacySelfBuiltEngine(input: {
  readonly cacheMode: "cold" | "warm";
  readonly cases?: readonly Readonly<SelfBuiltEvalCaseV1>[];
}): SelfBuiltEngine {
  return cachedEngine({
    id: "legacy-lexical-no-governance/v1", role: "baseline",
    cacheMode: input.cacheMode, cases: input.cases, governed: false,
  });
}

export function createGovernedSelfBuiltEngine(input: {
  readonly cacheMode: "cold" | "warm";
  readonly cases?: readonly Readonly<SelfBuiltEvalCaseV1>[];
}): SelfBuiltEngine {
  return cachedEngine({
    id: "governed-lexical-fallback/v1", role: "candidate",
    cacheMode: input.cacheMode, cases: input.cases, governed: true,
  });
}

function dcg(relevances: readonly number[]): number {
  return relevances.reduce((sum, value, index) =>
    sum + value / Math.log2(index + 2), 0);
}

function scoreCase(
  evalCase: Readonly<SelfBuiltEvalCaseV1>,
  result: SelfBuiltEngineResult,
  latencyMs: number,
): SelfBuiltCaseResult {
  const byId = new Map(evalCase.memoryStream.map((event) => [event.eventId, event]));
  const rankedEvidenceRefs = result.rankedEventIds.map((id) => byId.get(id)?.evidenceRef)
    .filter((value): value is string => value !== undefined);
  const forbidden = new Set(evalCase.gold.forbiddenEvidenceRefs);
  const required = new Set(evalCase.gold.requiredEvidenceRefs);
  const forbiddenLeak = rankedEvidenceRefs.some((ref) => forbidden.has(ref));
  const evidenceRecall = required.size === 0 ? 1 :
    [...required].filter((ref) => rankedEvidenceRefs.includes(ref)).length / required.size;
  const idealDcg = dcg(Array.from({ length: required.size }, () => 1));
  const ndcg = idealDcg === 0 ? 1 : dcg(rankedEvidenceRefs.map((ref) => required.has(ref) ? 1 : 0)) /
    idealDcg;
  const abstentionCorrect = evalCase.query.expectedMode === "abstain"
    ? rankedEvidenceRefs.length === 0
    : null;
  const score = abstentionCorrect === null
    ? 50 * evidenceRecall + 30 * ndcg + 20 * (forbiddenLeak ? 0 : 1)
    : abstentionCorrect ? 100 : 0;
  return Object.freeze({
    caseId: evalCase.id,
    capability: evalCase.capability,
    scenario: evalCase.scenario,
    score: round(score),
    evidenceRecall: round(evidenceRecall),
    ndcg: round(ndcg),
    forbiddenLeak,
    abstentionCorrect,
    rankedEvidenceRefs: Object.freeze(rankedEvidenceRefs),
    latencyMs: round(latencyMs),
    warnings: Object.freeze([...result.warnings]),
  });
}

async function runVariant(
  engine: SelfBuiltEngine,
  cases: readonly Readonly<SelfBuiltEvalCaseV1>[],
): Promise<SelfBuiltVariantReport> {
  const results: SelfBuiltCaseResult[] = [];
  for (const evalCase of cases) {
    const started = performance.now();
    const result = await engine.run(evalCase);
    results.push(scoreCase(evalCase, result, performance.now() - started));
  }
  const byCapability = Object.fromEntries([...new Set(cases.map((item) => item.capability))]
    .sort().map((capability) => [capability,
      mean(results.filter((item) => item.capability === capability).map((item) => item.score))])) as
      Record<SelfBuiltCapability, number>;
  const abstention = results.filter((item) => item.abstentionCorrect !== null);
  return Object.freeze({
    variantId: engine.id,
    role: engine.role,
    macroScore: mean(Object.values(byCapability)),
    evidenceRecall: mean(results.map((item) => item.evidenceRecall)),
    forbiddenLeakRate: round(results.filter((item) => item.forbiddenLeak).length / results.length),
    abstentionAccuracy: mean(abstention.map((item) => item.abstentionCorrect ? 1 : 0)),
    latencyP50Ms: percentile(results.map((item) => item.latencyMs), 0.5),
    latencyP95Ms: percentile(results.map((item) => item.latencyMs), 0.95),
    byCapability: Object.freeze(byCapability),
    cases: Object.freeze(results),
  });
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

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export async function runSelfBuiltEvaluation(input: {
  readonly generatedAt: string;
  readonly cacheMode: "cold" | "warm";
  readonly candidateVersion: string;
  readonly dbSchemaVersion: string;
  readonly worktreeSha256: string;
  readonly manifest: Readonly<SelfBuiltDatasetManifest>;
  readonly cases: readonly Readonly<SelfBuiltEvalCaseV1>[];
  readonly engines: readonly SelfBuiltEngine[];
}): Promise<Readonly<SelfBuiltEvaluationReport>> {
  if (!Number.isFinite(Date.parse(input.generatedAt)) || input.cases.length === 0 ||
      input.cases.some((item) => item.split !== "test") ||
      !/^[0-9a-f]{64}$/.test(input.worktreeSha256) ||
      input.manifest.formalReleaseEligible !== false ||
      new Set(input.engines.map((engine) => engine.role)).size !== 2) {
    throw new Error("invalid self-built evaluation input");
  }
  const runSpec = Object.freeze({
    candidateVersion: input.candidateVersion,
    dbSchemaVersion: input.dbSchemaVersion,
    worktreeSha256: input.worktreeSha256,
    datasetSha256: input.manifest.casesSha256,
    cacheMode: input.cacheMode,
    engineContract: "selfbuilt-governed-retrieval/v1" as const,
  });
  const variants: SelfBuiltVariantReport[] = [];
  for (const engine of input.engines) variants.push(await runVariant(engine, input.cases));
  const baseline = variants.find((item) => item.role === "baseline")!;
  const candidate = variants.find((item) => item.role === "candidate")!;
  const base = Object.freeze({
    schemaVersion: "mengshu.selfbuilt-eval-report/v1" as const,
    track: "selfbuilt" as const,
    scoreName: "SBS" as const,
    scoreAuthority: "selfbuilt-diagnostic" as const,
    formalReleaseEligible: false as const,
    generatedAt: input.generatedAt,
    runSpec,
    runFingerprint: hash(runSpec),
    datasetId: input.manifest.datasetId,
    datasetVersion: input.manifest.datasetVersion,
    caseCount: input.cases.length,
    baselineCandidateDelta: round(candidate.macroScore - baseline.macroScore),
    variants: Object.freeze(variants),
  });
  return Object.freeze({ ...base, reportHash: hash(base) });
}

export function assertSelfBuiltReportIntegrity(report: SelfBuiltEvaluationReport): void {
  const { reportHash, ...base } = report;
  if (hash(base) !== reportHash || hash(report.runSpec) !== report.runFingerprint) {
    throw new Error("self-built evaluation report integrity check failed");
  }
}

export function compareSelfBuiltRounds(input: {
  readonly baseline: SelfBuiltEvaluationReport;
  readonly candidate: SelfBuiltEvaluationReport;
}): Readonly<SelfBuiltRoundComparison> {
  assertSelfBuiltReportIntegrity(input.baseline);
  assertSelfBuiltReportIntegrity(input.candidate);
  if (input.baseline.runSpec.datasetSha256 !== input.candidate.runSpec.datasetSha256 ||
      input.baseline.runSpec.worktreeSha256 !== input.candidate.runSpec.worktreeSha256 ||
      input.baseline.runSpec.candidateVersion !== input.candidate.runSpec.candidateVersion ||
      input.baseline.runSpec.dbSchemaVersion !== input.candidate.runSpec.dbSchemaVersion) {
    throw new Error("self-built rounds must use the same dataset and candidate");
  }
  const baseline = input.baseline.variants.find((item) => item.role === "candidate")!;
  const candidate = input.candidate.variants.find((item) => item.role === "candidate")!;
  const baselineCases = new Map(baseline.cases.map((item) => [item.caseId, item.score]));
  const candidateCases = new Map(candidate.cases.map((item) => [item.caseId, item.score]));
  if (baselineCases.size !== candidateCases.size ||
      [...baselineCases.keys()].some((caseId) => !candidateCases.has(caseId))) {
    throw new Error("self-built round case ids do not match");
  }
  const changedCaseCount = [...baselineCases].filter(([caseId, score]) =>
    candidateCases.get(caseId) !== score).length;
  return Object.freeze({
    schemaVersion: "mengshu.selfbuilt-comparison/v1",
    scoreName: "SBS",
    datasetSha256: input.baseline.runSpec.datasetSha256,
    baselineReportHash: input.baseline.reportHash,
    candidateReportHash: input.candidate.reportHash,
    caseCount: baselineCases.size,
    round1CandidateScore: baseline.macroScore,
    round2CandidateScore: candidate.macroScore,
    delta: round(candidate.macroScore - baseline.macroScore),
    changedCaseCount,
    stable: changedCaseCount === 0,
    p50Speedup: round(baseline.latencyP50Ms / Math.max(Number.EPSILON, candidate.latencyP50Ms)),
    p95Speedup: round(baseline.latencyP95Ms / Math.max(Number.EPSILON, candidate.latencyP95Ms)),
  });
}
