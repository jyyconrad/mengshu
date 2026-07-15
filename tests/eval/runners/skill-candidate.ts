import type { MemoryScope } from "../../../packages/core/src/domain/types.js";
import { InMemoryCandidateRepository } from "../../../packages/core/src/lifecycle/candidate-repository.js";
import { SkillCandidateAggregator } from "../../../packages/core/src/lifecycle/skill-candidate-aggregator.js";
import { InMemorySkillCandidateRepository } from "../../../packages/core/src/lifecycle/skill-candidate-repository.js";
import {
  DEFAULT_GENERALIZATION_TRIGGER,
  SKILL_CANDIDATE_BOUNDARIES,
  type GeneralizationAnalysis,
  type SkillCandidate,
} from "../../../packages/core/src/lifecycle/skill-candidate-types.js";

import { createMetric } from "./eval-metrics.js";
import {
  loadExtensionSuite,
  type ContractIssue,
  type SkillCandidateCase,
} from "./extension-loaders.js";
import type { EvalExecutionMetadata, EvalMetricResult } from "./types.js";

const EXPECTED_CASE_COUNT = 8;
const FIXED_NOW = Date.parse("2026-06-20T00:00:00.000Z");
const HARNESS_SCOPE: MemoryScope = Object.freeze({
  tenantId: "eval",
  appId: "mengshu-eval",
  userId: "skill-candidate",
  projectId: "skill-candidate-golden",
  agentId: "skill-candidate-runner",
  namespace: "skill-candidate-eval",
  sessionId: "skill-candidate-eval",
});

export interface SkillCandidateActual {
  analyses: GeneralizationAnalysis[];
  candidate: {
    schema: "skill_candidate";
    status: "pending";
    title: string;
    topicLabel: string;
    evidenceMemoryIds: string[];
    evidenceChunkIds: string[];
    confidence: number;
    highRisk: boolean;
    createdAt: number;
  } | null;
  executableSkill: null;
}

export interface SkillCandidateCaseResult {
  caseId: string;
  actual: SkillCandidateActual;
  passed: boolean;
  failures: string[];
  unsupportedContracts: string[];
  productionInvocations: { runAggregation: 1 };
}

export interface SkillCandidateRun {
  suite: "mengshu-skill-candidate";
  total: number;
  passed: number;
  failed: number;
  results: SkillCandidateCaseResult[];
  metrics: EvalMetricResult[];
  execution: EvalExecutionMetadata;
  componentBoundary: {
    productionEntry: "SkillCandidateAggregator.runAggregation";
    topicPolicy: "experience_body_heuristic_only";
    scopePolicy: "fixed_isolation_scope";
    timestampPolicy: "fixture_createdAt_via_repository_clock";
    evidencePolicy: "fixture_ids_as_candidate_evidence";
    executableOutput: "always_null";
  };
  qualityGatePassed: boolean;
  gateFailures: string[];
  contractIssues: ContractIssue[];
}

function normalizeCandidate(candidate: SkillCandidate): SkillCandidateActual["candidate"] {
  if (candidate.status !== "pending") return null;
  return {
    schema: "skill_candidate",
    status: candidate.status,
    title: candidate.title,
    topicLabel: candidate.topicLabel,
    evidenceMemoryIds: [...candidate.evidenceMemoryIds],
    evidenceChunkIds: [...candidate.evidenceChunkIds],
    confidence: candidate.confidence,
    highRisk: candidate.highRisk,
    createdAt: candidate.createdAt,
  };
}

function unsupportedContracts(goldenCase: SkillCandidateCase): string[] {
  const unsupported: string[] = [];
  if (goldenCase.experiences.some((experience) => experience.createdAt === undefined)) {
    unsupported.push("createdAt_required");
  }
  const expected = goldenCase.expected;
  if (expected.skill_candidate?.pattern !== undefined) unsupported.push("pattern");
  if (expected.skill_candidate?.domain !== undefined) unsupported.push("domain");
  if (expected.reason === "conflicting_experiences") unsupported.push("conflict_detection");
  if (expected.downgrade_to_candidate !== undefined) unsupported.push("downgrade_to_candidate");
  return unsupported;
}

function compareExpected(
  goldenCase: SkillCandidateCase,
  actual: SkillCandidateActual,
): string[] {
  const failures: string[] = [];
  const expected = goldenCase.expected;
  const generated = actual.candidate !== null;
  const expectsGenerated = expected.skill_candidate_generated ??
    (expected.skill_candidate === undefined ? undefined : true);
  if (expectsGenerated !== undefined && generated !== expectsGenerated) {
    failures.push(`skill_candidate_generated:expected=${expectsGenerated}:actual=${generated}`);
  }
  if (expected.executable_skill_generated !== undefined &&
      expected.executable_skill_generated !== false) {
    failures.push("executable_skill_generated:expected=true:actual=false");
  }
  if (expected.threshold_met === "5_evidence" &&
      !actual.analyses.some((analysis) => analysis.evidenceCount >= 5 && analysis.meetsThreshold)) {
    failures.push("threshold_met:expected=5_evidence:actual=false");
  }
  const expectsWindow = expected.observation_window === "3_days" ||
    expected.observation_window_met === true || expected.window_days === 3;
  if (expectsWindow && !actual.analyses.some((analysis) => analysis.timeSpanDays >= 3)) {
    failures.push("observation_window:expected_at_least_3_days:actual=false");
  }
  if (expected.reason === "insufficient_evidence" &&
      (actual.analyses.length === 0 ||
        actual.analyses.some((analysis) => analysis.meetsThreshold) ||
        !actual.analyses.every((analysis) => analysis.evidenceCount < DEFAULT_GENERALIZATION_TRIGGER.minExperienceCount))) {
    failures.push("reason:expected=insufficient_evidence:actual=mismatch");
  }
  if (expected.min_required !== undefined &&
      expected.min_required !== DEFAULT_GENERALIZATION_TRIGGER.minExperienceCount) {
    failures.push("min_required:mismatch");
  }
  if (expected.not_skill_object === true &&
      (actual.candidate === null || actual.candidate.schema !== "skill_candidate")) {
    failures.push("not_skill_object:mismatch");
  }
  if (expected.llm_role === "suggest_only" && !SKILL_CANDIDATE_BOUNDARIES.canSuggestOnRecall) {
    failures.push("llm_role:suggest_only:not_proven");
  }
  if (expected.user_approval_required === true && actual.candidate?.status !== "pending") {
    failures.push("user_approval_required:not_pending");
  }
  if (expected.auto_execute === false && SKILL_CANDIDATE_BOUNDARIES.canAutoExecute) {
    failures.push("auto_execute:unexpectedly_enabled");
  }
  const expectedCandidate = expected.skill_candidate;
  if (expectedCandidate && actual.candidate) {
    if (actual.candidate.title !== expectedCandidate.title) failures.push("skill_candidate.title:mismatch");
    if (expectedCandidate.evidence !== undefined &&
        JSON.stringify(actual.candidate.evidenceMemoryIds) !== JSON.stringify(expectedCandidate.evidence)) {
      failures.push("skill_candidate.evidence:mismatch");
    }
    if (expectedCandidate.confidence !== undefined &&
        actual.candidate.confidence !== expectedCandidate.confidence) {
      failures.push("skill_candidate.confidence:mismatch");
    }
    if (expectedCandidate.aggregated_count !== undefined &&
        actual.candidate.evidenceMemoryIds.length !== expectedCandidate.aggregated_count) {
      failures.push("skill_candidate.aggregated_count:mismatch");
    }
    if (expectedCandidate.schema !== undefined && actual.candidate.schema !== expectedCandidate.schema) {
      failures.push("skill_candidate.schema:mismatch");
    }
    if (expectedCandidate.status === "candidate" && actual.candidate.status !== "pending") {
      failures.push("skill_candidate.status:not_pending_candidate");
    }
    if (expectedCandidate.not_executable === true && actual.executableSkill !== null) {
      failures.push("skill_candidate.not_executable:mismatch");
    }
  }
  return failures;
}

async function evaluateCase(goldenCase: SkillCandidateCase): Promise<SkillCandidateCaseResult> {
  let repositoryNow = FIXED_NOW;
  const candidateRepository = new InMemoryCandidateRepository({
    now: () => repositoryNow,
    idFactory: () => { throw new Error("fixture experience id is required"); },
  });
  for (const experience of goldenCase.experiences) {
    repositoryNow = Date.parse(experience.createdAt!);
    await candidateRepository.enqueue({
      id: experience.id,
      scope: HARNESS_SCOPE,
      text: experience.body,
      semanticType: "experience",
      kind: "lesson",
      confidence: 0.8,
      reason: "offline golden experience",
      evidenceIds: [experience.id],
      extractor: "skill-candidate-eval",
      status: "pending",
      metadata: {},
    });
  }
  const skillCandidateRepository = new InMemorySkillCandidateRepository({ now: () => FIXED_NOW });
  const aggregator = new SkillCandidateAggregator({
    candidateRepository,
    skillCandidateRepository,
    now: () => FIXED_NOW,
  });
  const aggregation = await aggregator.runAggregation(HARNESS_SCOPE);
  const candidate = aggregation.skillCandidates.length === 1
    ? normalizeCandidate(aggregation.skillCandidates[0]!)
    : null;
  const actual: SkillCandidateActual = {
    analyses: aggregation.analyses.map((analysis) => ({
      ...analysis,
      experienceIds: [...analysis.experienceIds],
    })),
    candidate,
    executableSkill: null,
  };
  const unsupported = unsupportedContracts(goldenCase);
  const failures = [
    ...aggregation.errors.map(() => "production_aggregation:error"),
    ...unsupported.map((field) => `unsupported_contract:${field}`),
    ...(unsupported.length === 0 ? compareExpected(goldenCase, actual) : []),
  ];
  if (aggregation.skillCandidates.length > 1) {
    failures.push(`ambiguous_candidates:${aggregation.skillCandidates.length}`);
  }
  return {
    caseId: goldenCase.id,
    actual,
    passed: failures.length === 0,
    failures,
    unsupportedContracts: unsupported,
    productionInvocations: { runAggregation: 1 },
  };
}

function safeCandidateOnly(actual: SkillCandidateActual): boolean {
  return actual.candidate !== null && actual.candidate.schema === "skill_candidate" &&
    actual.candidate.status === "pending" && actual.executableSkill === null;
}

function metricFailure(metric: EvalMetricResult): string {
  return metric.failure ?? `${metric.name}: value=${metric.value} 未满足 ${metric.direction} ${metric.threshold}`;
}

export async function runSkillCandidateSuite(fixturePath: string): Promise<SkillCandidateRun> {
  const loaded = loadExtensionSuite(fixturePath, "mengshu-skill-candidate");
  if (loaded.cases.length !== EXPECTED_CASE_COUNT) {
    throw new Error(`[skill-candidate-v1] expected ${EXPECTED_CASE_COUNT} cases, got ${loaded.cases.length}`);
  }
  const results: SkillCandidateCaseResult[] = [];
  for (const goldenCase of loaded.cases) results.push(await evaluateCase(goldenCase));
  const generated = results.filter((result) => result.actual.candidate !== null);
  const metrics = [
    createMetric({
      name: "skill_candidate_only",
      numerator: generated.filter((result) => safeCandidateOnly(result.actual)).length,
      denominator: generated.length,
      direction: "exact",
      threshold: 1,
    }),
    createMetric({
      name: "no_executable_skill",
      numerator: results.filter((result) => result.actual.executableSkill === null).length,
      denominator: results.length,
      direction: "exact",
      threshold: 1,
    }),
  ];
  const failedResults = results.filter((result) => !result.passed);
  const gateFailures = [
    ...metrics.filter((metric) => !metric.passed).map(metricFailure),
    ...(failedResults.length > 0 ? [`case_contract_failures:${failedResults.length}`] : []),
    ...(loaded.contractIssues.length > 0 ? [`fixture_contract_issues:${loaded.contractIssues.length}`] : []),
    ...loaded.contractIssues.map((issue) =>
      `fixture_contract_issue:${issue.caseId ?? issue.suite}:${issue.code}`),
  ];
  return {
    suite: "mengshu-skill-candidate",
    total: results.length,
    passed: results.length - failedResults.length,
    failed: failedResults.length,
    results,
    metrics,
    execution: {
      runMode: "offline-component",
      provider: null,
      model: null,
      prompt: null,
      version: "skill-candidate-v1",
      fallback: false,
      degraded: false,
    },
    componentBoundary: {
      productionEntry: "SkillCandidateAggregator.runAggregation",
      topicPolicy: "experience_body_heuristic_only",
      scopePolicy: "fixed_isolation_scope",
      timestampPolicy: "fixture_createdAt_via_repository_clock",
      evidencePolicy: "fixture_ids_as_candidate_evidence",
      executableOutput: "always_null",
    },
    qualityGatePassed: gateFailures.length === 0,
    gateFailures,
    contractIssues: loaded.contractIssues,
  };
}
