import {
  computeImportanceForRecordWithBreakdown,
  type ImportanceResult,
} from "../../../packages/core/src/domain/recall-scoring.js";
import type { SourceKind } from "../../../packages/core/src/scoring/importance-score.js";

import { createMetric } from "./eval-metrics.js";
import {
  loadExtensionSuite,
  type ContractIssue,
  type RecallExplainCase,
  type RecallMemory,
} from "./extension-loaders.js";
import type { EvalExecutionMetadata, EvalMetricResult } from "./types.js";

const BREAKDOWN_FIELDS = [
  "salience_llm",
  "sourceAuthority",
  "explicitnessBonus",
  "typePrior",
] as const;

export interface RecallExplainMemoryEvaluation {
  memoryId: string;
  /**
   * metric 分母只统计 fixture 真实提供 salience_llm 的 memory。
   * sourceKind 必须由 fixture 来源无歧义映射；semanticType 由 loader 保证。
   */
  eligibleForBreakdownMetric: boolean;
  sourceKind?: SourceKind;
  explicitSave: boolean;
  actual: ImportanceResult;
}

export interface RecallExplainCaseResult {
  caseId: string;
  memoryEvaluations: RecallExplainMemoryEvaluation[];
  passed: boolean;
  failures: string[];
  unsupportedContracts: string[];
}

export interface RecallExplainRun {
  suite: "mengshu-recall-explain";
  total: number;
  passed: number;
  failed: number;
  results: RecallExplainCaseResult[];
  metrics: EvalMetricResult[];
  execution: EvalExecutionMetadata;
  componentBoundary: {
    productionEntry: "computeImportanceForRecordWithBreakdown";
    output: "importance_weighted_contributions_only";
    sourceKindPolicy: "fixture_explicit_mapping_only";
    clock: "not_applicable_pure_function";
    metricEligibility: "memory.salience_llm_and_source_kind_are_present";
  };
  qualityGatePassed: boolean;
  gateFailures: string[];
  contractIssues: ContractIssue[];
}

function sourceKindFor(memory: RecallMemory): SourceKind | undefined {
  // `source` 是单值 production scoring 信号；存在时优先于多来源证据列表。
  // `sources` 仅在 source 缺失时用于无歧义推导，避免把 expected authority 倒灌为 actual。
  if (memory.source === "rule_file") return "rule_file";
  if (memory.source === "inferred") return "agent_output";
  const candidates = new Set<SourceKind>();
  for (const source of memory.sources ?? []) {
    if (source === "rule_file") candidates.add("rule_file");
    if (source === "conversation" || source === "explicit_save") {
      candidates.add("session_user");
    }
  }
  return candidates.size === 1 ? [...candidates][0] : undefined;
}

function explicitSaveFor(memory: RecallMemory): boolean {
  return memory.explicitSave ?? memory.sources?.includes("explicit_save") ?? false;
}

function evaluateMemory(memory: RecallMemory): RecallExplainMemoryEvaluation {
  const sourceKind = sourceKindFor(memory);
  const explicitSave = explicitSaveFor(memory);
  const actual = computeImportanceForRecordWithBreakdown({
    salience: memory.salience_llm,
    sourceKind,
    explicitSave,
    semanticType: memory.type,
  });

  return {
    memoryId: memory.id,
    eligibleForBreakdownMetric:
      memory.salience_llm !== undefined && sourceKind !== undefined,
    sourceKind,
    explicitSave,
    actual,
  };
}

function unsupportedContracts(goldenCase: RecallExplainCase): string[] {
  const unsupported = new Set<string>();
  if (goldenCase.expected.recalled !== undefined) unsupported.add("recalled");
  if (goldenCase.expected.filtered !== undefined) unsupported.add("filtered");
  if (goldenCase.expected.slot_order !== undefined) unsupported.add("slot_order");

  for (const hit of goldenCase.expected.recalled ?? []) {
    if (hit.slot !== undefined) unsupported.add("slot");
    if (hit.overridden !== undefined) unsupported.add("override");
    if (hit.confidence !== undefined) unsupported.add("confidence");
    if (hit.hotness !== undefined) unsupported.add("hotness");
    if (hit.recencyDecay !== undefined) unsupported.add("recency");
  }
  return [...unsupported];
}

function hasCompleteBreakdown(evaluation: RecallExplainMemoryEvaluation): boolean {
  const breakdown = evaluation.actual.breakdown;
  return breakdown !== null && BREAKDOWN_FIELDS.every((field) =>
    Number.isFinite(breakdown[field]));
}

function evaluateCase(goldenCase: RecallExplainCase): RecallExplainCaseResult {
  const memoryEvaluations = goldenCase.memories.map(evaluateMemory);
  const unsupported = unsupportedContracts(goldenCase);
  // 本 runner 的 case gate 只覆盖 production importance breakdown。
  // 召回、过滤、slot 等完整链路断言保留为诊断，由对应 suite 负责，不能污染本 metric。
  const failures: string[] = [];

  if (goldenCase.expected.breakdown_visible === true) {
    if (memoryEvaluations.some((evaluation) => evaluation.actual.breakdown === null)) {
      failures.push("breakdown_visible:expected=true,actual=false");
    }
  } else if (goldenCase.expected.breakdown_visible === false) {
    if (memoryEvaluations.some((evaluation) => evaluation.actual.breakdown !== null)) {
      failures.push("breakdown_visible:expected=false,actual=true");
    }
  }

  for (const evaluation of memoryEvaluations) {
    if (evaluation.actual.breakdown !== null) continue;
    const reason = goldenCase.memories.find(
      (memory) => memory.id === evaluation.memoryId,
    )?.salience_llm === undefined
      ? "missing_salience_llm"
      : evaluation.sourceKind === undefined
        ? "missing_source_kind"
        : "production_returned_null";
    failures.push(
      `importance_breakdown_unavailable:${evaluation.memoryId}:${reason}`,
    );
  }

  return {
    caseId: goldenCase.id,
    memoryEvaluations,
    passed: failures.length === 0,
    failures,
    unsupportedContracts: unsupported,
  };
}

function gateFailure(metric: EvalMetricResult): string {
  if (metric.failure) return metric.failure;
  return `${metric.name}: value=${metric.value} 未满足 ${metric.direction} ${metric.threshold}`;
}

/**
 * Honest offline component runner。它只评估 production importance breakdown 纯函数：
 * 不执行召回、过滤、slot 或 override，也不读 expected importance 生成 actual。
 */
export async function runRecallExplainSuite(fixturePath: string): Promise<RecallExplainRun> {
  const loaded = loadExtensionSuite(fixturePath, "mengshu-recall-explain");
  const results = loaded.cases.map(evaluateCase);
  const eligible = results
    .flatMap((result) => result.memoryEvaluations)
    .filter((evaluation) => evaluation.eligibleForBreakdownMetric);
  const metrics = [
    createMetric({
      name: "breakdown_output_rate",
      numerator: eligible.filter(hasCompleteBreakdown).length,
      denominator: eligible.length,
      direction: "exact",
      threshold: 1,
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
    suite: "mengshu-recall-explain",
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
      version: "recall-explain-v1",
      fallback: false,
      degraded: false,
    },
    componentBoundary: {
      productionEntry: "computeImportanceForRecordWithBreakdown",
      output: "importance_weighted_contributions_only",
      sourceKindPolicy: "fixture_explicit_mapping_only",
      clock: "not_applicable_pure_function",
      metricEligibility: "memory.salience_llm_and_source_kind_are_present",
    },
    qualityGatePassed: gateFailures.length === 0,
    gateFailures,
    contractIssues: loaded.contractIssues,
  };
}
