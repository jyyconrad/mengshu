import {
  CandidateAutoPromotionService,
  type ConflictDetectionResult,
} from "../../../packages/core/src/lifecycle/candidate-auto-promotion.js";
import { InMemoryCandidateRepository } from "../../../packages/core/src/lifecycle/candidate-repository.js";
import type { MemoryScope } from "../../../packages/core/src/domain/types.js";

import { createMetric } from "./eval-metrics.js";
import {
  loadExtensionSuite,
  type ConflictDetectionCase,
  type ConflictMemory,
  type ContractIssue,
} from "./extension-loaders.js";
import type {
  EvalExecutionMetadata,
  EvalMetricResult,
} from "./types.js";

const FIXED_NOW = Date.parse("2026-06-20T00:00:00.000Z");
const SUPPORTED_EXPECTED_FIELDS = new Set([
  "conflict_detected",
  "conflict_type",
  "false_merge",
]);

export interface ConflictActualResult {
  detected: boolean;
  conflictTypes: Array<"contradiction" | "supersedes" | "incompatible">;
  confidences: number[];
  suggestedActions: ConflictDetectionResult["suggestedActions"];
  falseMerge?: number;
  downgradeApplied?: number;
}

export interface ConflictCaseResult {
  caseId: string;
  expectedConflict: boolean;
  expectedFalseMerge?: number;
  actual: ConflictActualResult;
  passed: boolean;
  failures: string[];
  unsupportedContracts: string[];
}

export interface ConflictDetectionRun {
  suite: "mengshu-conflict";
  total: number;
  passed: number;
  failed: number;
  results: ConflictCaseResult[];
  metrics: EvalMetricResult[];
  execution: EvalExecutionMetadata;
  qualityGatePassed: boolean;
  gateFailures: string[];
  contractIssues: ContractIssue[];
}

function scopeFor(memory: ConflictMemory): MemoryScope {
  return {
    tenantId: "local",
    appId: "eval",
    userId: "eval-user",
    projectId: memory.scope?.projectId ?? "default",
    agentId: "eval-agent",
    namespace: "memories",
  };
}

function timestamp(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function kindFor(memory: ConflictMemory): string {
  if (memory.type === "rules") return "constraint";
  if (memory.type === "profile") return "preference";
  return "reference";
}

function sameScope(left: MemoryScope, right: MemoryScope): boolean {
  return left.tenantId === right.tenantId && left.appId === right.appId &&
    left.userId === right.userId && left.projectId === right.projectId &&
    left.agentId === right.agentId && left.namespace === right.namespace;
}

function expectedProductionConflictType(
  value: ConflictDetectionCase["expected"]["conflict_type"],
): ConflictActualResult["conflictTypes"][number] | undefined {
  if (value === "rules_mutually_exclusive" || value === "profile_priority_conflict" ||
      value === "resource_mutually_exclusive") {
    return "contradiction";
  }
  return undefined;
}

async function evaluateCase(
  goldenCase: ConflictDetectionCase,
): Promise<ConflictCaseResult> {
  let clock = timestamp(goldenCase.memoryA.createdAt, FIXED_NOW);
  let nextGeneratedId = 0;
  const repository = new InMemoryCandidateRepository({
    now: () => clock,
    idFactory: () => `${goldenCase.id}-generated-${nextGeneratedId++}`,
  });
  const service = new CandidateAutoPromotionService({
    repository,
    now: () => clock,
  });

  await repository.enqueue({
    id: `${goldenCase.id}-memoryA`,
    scope: scopeFor(goldenCase.memoryA),
    text: goldenCase.memoryA.body,
    semanticType: goldenCase.memoryA.type,
    kind: kindFor(goldenCase.memoryA),
    confidence: 0.5,
    evidenceIds: [],
    metadata: {
      ...(goldenCase.memoryA.lifecycleStatus
        ? { lifecycleStatus: goldenCase.memoryA.lifecycleStatus }
        : {}),
    },
  });

  clock = timestamp(goldenCase.memoryB.createdAt, clock + 1);
  await repository.enqueue({
    id: `${goldenCase.id}-memoryB`,
    scope: scopeFor(goldenCase.memoryB),
    text: goldenCase.memoryB.body,
    semanticType: goldenCase.memoryB.type,
    kind: kindFor(goldenCase.memoryB),
    confidence: 0.5,
    evidenceIds: [],
    metadata: {
      ...(goldenCase.memoryB.lifecycleStatus
        ? { lifecycleStatus: goldenCase.memoryB.lifecycleStatus }
        : {}),
      ...(goldenCase.memoryB.userCorrected
        ? { userCorrected: true }
        : {}),
    },
  });

  // 通过公开 production scope filter 执行：同 scope 比较一次，不同 scope 分别查询，
  // 每次都只看到本 authority partition 的候选。
  const scopeA = scopeFor(goldenCase.memoryA);
  const scopeB = scopeFor(goldenCase.memoryB);
  const productionResults: ConflictDetectionResult[] = [];
  productionResults.push(await service.detectConflicts(scopeA));
  if (!sameScope(scopeA, scopeB)) {
    productionResults.push(await service.detectConflicts(scopeB));
  }
  const productionResult: ConflictDetectionResult = {
    conflictingPairs: productionResults.flatMap((result) => result.conflictingPairs),
    suggestedActions: productionResults.flatMap((result) => result.suggestedActions),
  };
  const pairIds = new Set([
    `${goldenCase.id}-memoryA`,
    `${goldenCase.id}-memoryB`,
  ]);
  const matchingPairs = productionResult.conflictingPairs.filter(
    (pair) => pairIds.has(pair.candidateA) && pairIds.has(pair.candidateB),
  );
  const matchingActions = productionResult.suggestedActions.filter(
    (action) => pairIds.has(action.candidateId),
  );
  let falseMerge: number | undefined;
  let downgradeApplied: number | undefined;
  if (goldenCase.expected.false_merge !== undefined) {
    const downgrade = await service.applyConflictDowngrades({
      conflictingPairs: matchingPairs,
      suggestedActions: matchingActions,
    });
    downgradeApplied = downgrade.applied;
    falseMerge = matchingPairs.length > 0 && downgrade.applied > 0 ? 0 : 1;
  }
  const actual: ConflictActualResult = {
    detected: matchingPairs.length > 0,
    conflictTypes: matchingPairs.map((pair) => pair.conflictType).sort(),
    confidences: matchingPairs.map((pair) => pair.confidence).sort((a, b) => a - b),
    suggestedActions: [...matchingActions].sort((a, b) =>
      a.candidateId.localeCompare(b.candidateId),
    ),
    ...(falseMerge === undefined ? {} : { falseMerge }),
    ...(downgradeApplied === undefined ? {} : { downgradeApplied }),
  };

  const unsupportedContracts = Object.keys(goldenCase.expected).filter(
    (field) => !SUPPORTED_EXPECTED_FIELDS.has(field),
  );
  const failures: string[] = [];
  if (actual.detected !== goldenCase.expected.conflict_detected) {
    failures.push(
      `conflict_detected:expected=${goldenCase.expected.conflict_detected},actual=${actual.detected}`,
    );
  }
  const expectedType = expectedProductionConflictType(goldenCase.expected.conflict_type);
  if (expectedType !== undefined && !actual.conflictTypes.includes(expectedType)) {
    failures.push(
      `conflict_type:expected=${expectedType},actual=${actual.conflictTypes.join(",") || "none"}`,
    );
  }
  if (goldenCase.expected.false_merge !== undefined &&
      actual.falseMerge !== goldenCase.expected.false_merge) {
    failures.push(
      `false_merge:expected=${goldenCase.expected.false_merge},actual=${actual.falseMerge}`,
    );
  }

  return {
    caseId: goldenCase.id,
    expectedConflict: goldenCase.expected.conflict_detected,
    expectedFalseMerge: goldenCase.expected.false_merge,
    actual,
    passed: failures.length === 0,
    failures,
    unsupportedContracts,
  };
}

function gateFailure(metric: EvalMetricResult): string {
  if (metric.failure) return metric.failure;
  return `${metric.name}: value=${metric.value} 未满足 ${metric.direction} ${metric.threshold}`;
}

export async function runConflictDetectionSuite(
  fixturePath: string,
): Promise<ConflictDetectionRun> {
  const loaded = loadExtensionSuite(fixturePath, "mengshu-conflict");
  const results: ConflictCaseResult[] = [];
  for (const goldenCase of loaded.cases) {
    results.push(await evaluateCase(goldenCase));
  }

  const expectedConflicts = results.filter((result) => result.expectedConflict);
  const falseMergeCases = results.filter(
    (result) => result.expectedFalseMerge !== undefined,
  );
  const metrics = [
    createMetric({
      name: "conflict_recall",
      numerator: expectedConflicts.filter((result) => result.actual.detected).length,
      denominator: expectedConflicts.length,
      direction: "min",
      threshold: 0.8,
    }),
    createMetric({
      name: "rules_false_merge",
      // 真实 production detect + applyConflictDowngrades 成功后该 case 未进入 merge。
      numerator: falseMergeCases.reduce(
        (sum, result) => sum + (result.actual.falseMerge ?? 0),
        0,
      ),
      denominator: falseMergeCases.length,
      direction: "exact",
      threshold: 0,
    }),
  ];

  const failedResults = results.filter((result) => !result.passed);
  const gateFailures = [
    ...metrics.filter((metric) => !metric.passed).map(gateFailure),
    ...(failedResults.length > 0
      ? [`case_contract_failures:${failedResults.length}`]
      : []),
    ...(loaded.contractIssues.length > 0
      ? [`fixture_contract_issues:${loaded.contractIssues.length}`]
      : []),
  ];

  return {
    suite: "mengshu-conflict",
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
      version: "conflict-detection-v1",
      fallback: false,
      degraded: false,
    },
    qualityGatePassed: gateFailures.length === 0,
    gateFailures,
    contractIssues: loaded.contractIssues,
  };
}
