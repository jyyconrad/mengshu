import type { MemoryScope } from "../../../packages/core/src/domain/types.js";
import {
  computeCandidateSpecs,
  type ComputedCandidateSpec,
} from "../../../packages/core/src/lifecycle/candidate-spec-computation.js";
import { HeuristicTypeExtractor } from "../../../packages/core/src/lifecycle/type-extractor.js";

import { createMetric } from "./eval-metrics.js";
import {
  loadExtensionSuite,
  type CandidateExtractionCase,
  type ContractIssue,
  type ExtractionCandidate,
  type ExtractionMessage,
} from "./extension-loaders.js";
import type { EvalExecutionMetadata, EvalMetricResult } from "./types.js";

const EXPECTED_CASE_COUNT = 100;

export interface CandidateExtractionActualCandidate {
  id: string;
  text: string;
  evidenceQuote: string;
  semanticType: string | null;
  targetScope: string | null;
  confidence: number;
  extractor: string | null;
  evidenceIds: string[];
  profileLayer: string | null;
  explicitSave: boolean;
  status: string;
}

export interface CandidateExtractionCaseResult {
  caseId: string;
  expectedCandidateCount: number;
  actual: {
    candidates: CandidateExtractionActualCandidate[];
  };
  metricCounts: {
    typeCorrect: number;
    extractionCorrect: number;
    targetScopeCorrect: number;
  };
  passed: boolean;
  failures: string[];
  unsupportedContracts: string[];
  productionInvocations: {
    computation: number;
    extractor: number;
  };
}

export interface CandidateExtractionRun {
  suite: "mengshu-extraction";
  total: number;
  passed: number;
  failed: number;
  results: CandidateExtractionCaseResult[];
  metrics: EvalMetricResult[];
  execution: EvalExecutionMetadata;
  componentBoundary: {
    productionEntry: "computeCandidateSpecs";
    extractor: "HeuristicTypeExtractor";
    llm: "not_configured";
    sourceMapping: "one_computation_per_conversation_message_or_document_chunk";
    validator: "candidate-validator+admission-decision";
    rejectionOutput: "empty_specs";
  };
  productionInvocations: {
    computation: number;
    extractor: number;
  };
  diagnostics: {
    predictedCandidates: number;
    expectedCandidates: number;
    typeCorrect: number;
    extractionCorrect: number;
    negativeCases: number;
    overCapturedCaseIds: string[];
  };
  qualityGatePassed: boolean;
  gateFailures: string[];
  contractIssues: ContractIssue[];
}

interface SourceEvent {
  text: string;
  traceId: string;
  role: ExtractionMessage["role"] | "document";
}

function sourceEvents(goldenCase: CandidateExtractionCase): SourceEvent[] {
  const conversation = (goldenCase.input.conversation ?? []).map(
    (message, index): SourceEvent => ({
      text: message.text,
      traceId: message.id ?? `${goldenCase.id}-event-${index}`,
      role: message.role,
    }),
  );
  const document = goldenCase.input.documentChunk
    ? [{
        text: goldenCase.input.documentChunk.text,
        traceId: `${goldenCase.id}-document-0`,
        role: "document" as const,
      }]
    : [];
  return [...conversation, ...document];
}

function productionScope(goldenCase: CandidateExtractionCase): MemoryScope {
  return {
    tenantId: goldenCase.scope.tenantId ?? "eval-tenant",
    appId: goldenCase.scope.appId ?? "eval-app",
    userId: goldenCase.scope.userId ?? "eval-user",
    // 空字符串保留 fixture「无 project」语义；runner 不伪造项目归属。
    projectId: goldenCase.scope.projectId ?? "",
    agentId: "candidate-extraction-eval",
    namespace: "candidate-extraction-eval",
    ...(goldenCase.scope.sessionId
      ? { sessionId: goldenCase.scope.sessionId }
      : {}),
  };
}

function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function bodyMatches(actual: string, expected: string): boolean {
  const normalizedActual = normalizeText(actual);
  const normalizedExpected = normalizeText(expected);
  if (normalizedActual.length === 0 || normalizedExpected.length === 0) return false;
  if (
    normalizedActual.includes(normalizedExpected) ||
    normalizedExpected.includes(normalizedActual)
  ) return true;

  // Golden body 是语义摘要，不承诺逐字等于 source quote。离线 runner 不调用
  // embedding/LLM，故用 expected 侧 char-bigram coverage 衡量“摘要事实是否由原文
  // 支撑”。这是语言无关的通用证据度量；不含 case 词典或 canonical 文本改写。
  if (normalizedExpected.length < 5) return false;
  const expectedGrams = new Set<string>();
  const actualGrams = new Set<string>();
  for (let index = 0; index < normalizedExpected.length - 1; index += 1) {
    expectedGrams.add(normalizedExpected.slice(index, index + 2));
  }
  for (let index = 0; index < normalizedActual.length - 1; index += 1) {
    actualGrams.add(normalizedActual.slice(index, index + 2));
  }
  let shared = 0;
  for (const gram of expectedGrams) {
    if (actualGrams.has(gram)) shared += 1;
  }
  return shared >= 2 && shared / expectedGrams.size >= 0.4;
}

function matchPairs(
  actual: CandidateExtractionActualCandidate[],
  expected: ExtractionCandidate[],
  predicate: (
    actualCandidate: CandidateExtractionActualCandidate,
    expectedCandidate: ExtractionCandidate,
  ) => boolean,
): Array<{ actual: CandidateExtractionActualCandidate; expected: ExtractionCandidate }> {
  const used = new Set<number>();
  const pairs: Array<{
    actual: CandidateExtractionActualCandidate;
    expected: ExtractionCandidate;
  }> = [];
  for (const actualCandidate of actual) {
    const expectedIndex = expected.findIndex(
      (expectedCandidate, index) =>
        !used.has(index) && predicate(actualCandidate, expectedCandidate),
    );
    if (expectedIndex >= 0) {
      used.add(expectedIndex);
      pairs.push({ actual: actualCandidate, expected: expected[expectedIndex] });
    }
  }
  return pairs;
}

function normalizeSpec(
  spec: ComputedCandidateSpec,
  id: string,
): CandidateExtractionActualCandidate {
  return {
    id,
    text: spec.text,
    evidenceQuote: spec.evidence.quote,
    semanticType: spec.semanticType ?? null,
    targetScope:
      typeof spec.metadata.targetScope === "string"
        ? spec.metadata.targetScope
        : null,
    confidence: spec.confidence,
    extractor: spec.extractor,
    evidenceIds: [...spec.evidence.eventIds],
    profileLayer:
      typeof spec.metadata.profileLayer === "string"
        ? spec.metadata.profileLayer
        : null,
    explicitSave: spec.metadata.intent === "remember",
    status: String(spec.metadata.admission),
  };
}

const ACTUAL_SEMANTIC_TYPES = new Set([
  "profile", "rules", "experience", "task_context", "resource",
]);
const ACTUAL_TARGET_SCOPES = new Set([
  "session", "project", "workspace", "app", "user", "global",
]);
const ACTUAL_ADMISSION_ROUTES = new Set([
  "candidate_low_priority", "candidate", "active", "evidence_only",
]);

function outputContractFailures(
  candidates: readonly CandidateExtractionActualCandidate[],
): string[] {
  const failures: string[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const prefix = `actual.candidates[${index}]`;
    if (candidate.text.trim().length === 0) failures.push(`${prefix}.text:invalid`);
    if (!candidate.semanticType || !ACTUAL_SEMANTIC_TYPES.has(candidate.semanticType)) {
      failures.push(`${prefix}.semanticType:invalid`);
    }
    if (!candidate.targetScope || !ACTUAL_TARGET_SCOPES.has(candidate.targetScope)) {
      failures.push(`${prefix}.targetScope:invalid`);
    }
    if (!Number.isFinite(candidate.confidence) || candidate.confidence < 0 ||
        candidate.confidence > 1) failures.push(`${prefix}.confidence:invalid`);
    if (!candidate.extractor) failures.push(`${prefix}.extractor:invalid`);
    if (candidate.evidenceIds.length === 0 ||
        candidate.evidenceIds.some((id) => id.length === 0)) {
      failures.push(`${prefix}.evidenceIds:invalid`);
    }
    if (!ACTUAL_ADMISSION_ROUTES.has(candidate.status)) {
      failures.push(`${prefix}.status:invalid`);
    }
  }
  return failures;
}

async function evaluateCase(
  goldenCase: CandidateExtractionCase,
): Promise<CandidateExtractionCaseResult> {
  const extractor = new HeuristicTypeExtractor();
  const scope = productionScope(goldenCase);
  const events = sourceEvents(goldenCase);
  const actualCandidates: CandidateExtractionActualCandidate[] = [];
  for (const [index, event] of events.entries()) {
    const computed = await computeCandidateSpecs({ extractor }, {
      scope,
      text: event.text,
      traceId: event.traceId,
      intent: goldenCase.input.hints?.explicitSave ? "remember" : "auto",
    });
    for (const [specIndex, spec] of computed.specs.entries()) {
      actualCandidates.push(normalizeSpec(
        spec,
        `${goldenCase.id}-candidate-${index}-${specIndex}`,
      ));
    }
  }
  actualCandidates.sort((left, right) => left.id.localeCompare(right.id));
  const expectedCandidates = goldenCase.expected.candidates;
  const typePairs = matchPairs(
    actualCandidates,
    expectedCandidates,
    (actual, expected) => actual.semanticType === expected.type,
  );
  const extractionPairs = matchPairs(
    actualCandidates,
    expectedCandidates,
    (actual, expected) =>
      actual.semanticType === expected.type &&
      bodyMatches(actual.evidenceQuote, expected.evidence ?? expected.body),
  );
  const targetScopeCorrect = extractionPairs.filter(
    ({ actual, expected }) => actual.targetScope === expected.targetScope,
  ).length;
  // 单 case 的 prediction mismatch 只进入聚合 metrics；case pass/fail 只反映
  // production 输出合同是否成立，避免重复覆盖 manifest 的质量门禁。
  const unsupported: string[] = [];
  const failures = outputContractFailures(actualCandidates);

  return {
    caseId: goldenCase.id,
    expectedCandidateCount: expectedCandidates.length,
    actual: { candidates: actualCandidates },
    metricCounts: {
      typeCorrect: typePairs.length,
      extractionCorrect: extractionPairs.length,
      targetScopeCorrect,
    },
    passed: failures.length === 0,
    failures,
    unsupportedContracts: unsupported,
    productionInvocations: {
      computation: events.length,
      extractor: events.length,
    },
  };
}

function metricFailure(metric: EvalMetricResult): string {
  return metric.failure ??
    `${metric.name}: value=${metric.value} 未满足 ${metric.direction} ${metric.threshold}`;
}

/**
 * Honest offline component runner。fixture source text 逐事件送入真实
 * computeCandidateSpecs + HeuristicTypeExtractor + validator/admission；expected/task
 * 仅在生产执行结束后用于聚合评分，不参与 actual 构造。
 */
export async function runCandidateExtractionSuite(
  fixturePath: string,
): Promise<CandidateExtractionRun> {
  const loaded = loadExtensionSuite(fixturePath, "mengshu-extraction");
  if (loaded.cases.length !== EXPECTED_CASE_COUNT) {
    throw new Error(
      `[candidate-extraction-v1] expected ${EXPECTED_CASE_COUNT} cases, got ${loaded.cases.length}`,
    );
  }

  const results: CandidateExtractionCaseResult[] = [];
  for (const goldenCase of loaded.cases) {
    results.push(await evaluateCase(goldenCase));
  }
  const predictedCandidates = results.reduce(
    (sum, result) => sum + result.actual.candidates.length,
    0,
  );
  const expectedCandidates = results.reduce(
    (sum, result) => sum + result.expectedCandidateCount,
    0,
  );
  const typeCorrect = results.reduce(
    (sum, result) => sum + result.metricCounts.typeCorrect,
    0,
  );
  const extractionCorrect = results.reduce(
    (sum, result) => sum + result.metricCounts.extractionCorrect,
    0,
  );
  const negativeResults = results.filter(
    (result) => result.expectedCandidateCount === 0,
  );
  const overCapturedCaseIds = negativeResults
    .filter((result) => result.actual.candidates.length > 0)
    .map((result) => result.caseId);
  const metrics = [
    createMetric({
      name: "type_precision",
      numerator: typeCorrect,
      denominator: predictedCandidates,
      direction: "min",
      threshold: 0.85,
    }),
    createMetric({
      name: "extraction_precision",
      numerator: extractionCorrect,
      denominator: predictedCandidates,
      direction: "min",
      threshold: 0.8,
    }),
    createMetric({
      name: "type_recall",
      numerator: typeCorrect,
      denominator: expectedCandidates,
      direction: "min",
      threshold: 0.8,
    }),
    createMetric({
      name: "extraction_recall",
      numerator: extractionCorrect,
      denominator: expectedCandidates,
      direction: "min",
      threshold: 0.8,
    }),
    createMetric({
      name: "over_capture",
      numerator: overCapturedCaseIds.length,
      denominator: negativeResults.length,
      direction: "max",
      threshold: 0.1,
    }),
  ];
  const failedResults = results.filter((result) => !result.passed);
  const gateFailures = [
    ...metrics.filter((metric) => !metric.passed).map(metricFailure),
    ...(failedResults.length > 0
      ? [`case_contract_failures:${failedResults.length}`]
      : []),
    ...(loaded.contractIssues.length > 0
      ? [`fixture_contract_issues:${loaded.contractIssues.length}`]
      : []),
    ...loaded.contractIssues.map(
      (issue) =>
        `fixture_contract_issue:${issue.caseId ?? issue.suite}:${issue.code}`,
    ),
  ];
  const computationInvocations = results.reduce(
    (sum, result) => sum + result.productionInvocations.computation,
    0,
  );
  const extractorInvocations = results.reduce(
    (sum, result) => sum + result.productionInvocations.extractor,
    0,
  );

  return {
    suite: "mengshu-extraction",
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
      version: "candidate-extraction-v1",
      fallback: false,
      degraded: false,
    },
    componentBoundary: {
      productionEntry: "computeCandidateSpecs",
      extractor: "HeuristicTypeExtractor",
      llm: "not_configured",
      sourceMapping: "one_computation_per_conversation_message_or_document_chunk",
      validator: "candidate-validator+admission-decision",
      rejectionOutput: "empty_specs",
    },
    productionInvocations: {
      computation: computationInvocations,
      extractor: extractorInvocations,
    },
    diagnostics: {
      predictedCandidates,
      expectedCandidates,
      typeCorrect,
      extractionCorrect,
      negativeCases: negativeResults.length,
      overCapturedCaseIds,
    },
    qualityGatePassed: gateFailures.length === 0,
    gateFailures,
    contractIssues: loaded.contractIssues,
  };
}
