import type {
  CaseResult,
  EvalExecutionMetadata,
  EvalMetricDirection,
  EvalMetricResult,
  GoldenCase,
  SuiteSummary,
} from "./types.js";

export interface MetricInput {
  name: string;
  numerator: number;
  denominator: number;
  direction: EvalMetricDirection;
  threshold: number;
}

/** buildReport 消费的最小 manifest gate 契约。 */
export interface SuiteGateContract {
  kind: "baseline" | "extension";
  metrics?: unknown;
  gate?: unknown;
}

export interface SuiteGateEvaluation {
  passed: boolean;
  failures: string[];
}

export const METRIC_DIRECTIONS: Readonly<Record<string, EvalMetricDirection>> = Object.freeze({
  case_pass_rate: "min",
  slot_recall: "min",
  wrong_injection: "exact",
  latency: "max",
  sensitive_blocked: "exact",
  must_escape: "exact",
  type_precision: "min",
  extraction_precision: "min",
  type_recall: "min",
  extraction_recall: "min",
  over_capture: "max",
  duplicate_precision: "min",
  false_merge: "max",
  breakdown_output_rate: "exact",
  conflict_recall: "min",
  rules_false_merge: "exact",
  faithfulness: "min",
  key_fact_evidence_rate: "exact",
  skill_candidate_only: "exact",
  no_executable_skill: "exact",
});

/** slot-context component baseline 的唯一阈值真源；latency=80ms 对应本地 component SLO。 */
export const SLOT_CONTEXT_BASELINE_THRESHOLDS = Object.freeze({
  casePassRate: 0.8,
  safetyCasePassRate: 1,
  slotRecall: 0.8,
  wrongInjection: 0,
  latencyP95Ms: 80,
  sensitiveBlocked: 1,
  mustEscape: 1,
});

export function isKnownEvalMetricName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(METRIC_DIRECTIONS, name);
}

const OFFLINE_EXECUTION: EvalExecutionMetadata = {
  runMode: "offline-component",
  provider: null,
  model: null,
  prompt: null,
  version: "slot-context-v1",
  fallback: false,
  degraded: false,
};

function metricPasses(
  value: number,
  direction: EvalMetricDirection,
  threshold: number,
): boolean {
  if (direction === "min") return value >= threshold;
  if (direction === "max") return value <= threshold;
  return value === threshold;
}

/** 创建不可伪造 value 的 metric；空分母直接失败。 */
export function createMetric(input: MetricInput): EvalMetricResult {
  if (input.denominator <= 0) {
    return {
      ...input,
      value: 0,
      passed: false,
      failure: `metric '${input.name}' denominator=${input.denominator}`,
    };
  }
  const value = input.numerator / input.denominator;
  const finite = [input.numerator, input.denominator, value, input.threshold].every(
    Number.isFinite,
  );
  return {
    ...input,
    value,
    passed: finite && metricPasses(value, input.direction, input.threshold),
    ...(!finite ? { failure: `metric '${input.name}' 含非有限数值` } : {}),
  };
}

/** 返回 runner 未声明支持的 expected keys；调用方必须把它们折叠进 case failures。 */
export function findUnsupportedExpectedFields(
  expected: Record<string, unknown>,
  supported: ReadonlySet<string>,
): string[] {
  return Object.keys(expected).filter((field) => !supported.has(field));
}

function parseManifestContract(contract: SuiteGateContract): {
  declared: string[];
  gates: Record<string, number>;
  failures: string[];
} {
  const failures: string[] = [];
  if (!Array.isArray(contract.metrics) || contract.metrics.length === 0) {
    return {
      declared: [],
      gates: {},
      failures: ["manifest metrics 必须为非空数组"],
    };
  }
  const declared: string[] = [];
  for (const name of contract.metrics) {
    if (typeof name !== "string" || !isKnownEvalMetricName(name)) {
      failures.push("manifest metrics 包含未知或非法 metric");
      continue;
    }
    if (declared.includes(name)) {
      failures.push(`manifest metric '${name}' 重复声明`);
      continue;
    }
    declared.push(name);
  }

  const gates: Record<string, number> = {};
  if (contract.kind === "extension") {
    if (!contract.gate || typeof contract.gate !== "object" || Array.isArray(contract.gate)) {
      failures.push("extension manifest gate 必须为对象");
    } else {
      const gateEntries = Object.entries(contract.gate);
      for (const [name, threshold] of gateEntries) {
        if (!declared.includes(name)) {
          failures.push(`manifest gate 包含未声明 metric '${name}'`);
          continue;
        }
        if (typeof threshold !== "number" || !Number.isFinite(threshold)) {
          failures.push(`manifest gate metric '${name}' threshold 非法`);
          continue;
        }
        gates[name] = threshold;
      }
      for (const name of declared) {
        if (!(name in gates)) {
          failures.push(`extension metric '${name}' 缺少 manifest gate threshold`);
        }
      }
    }
  } else if (contract.gate !== undefined) {
    if (!contract.gate || typeof contract.gate !== "object" || Array.isArray(contract.gate)) {
      failures.push("baseline manifest gate 必须为对象");
    }
  }
  return { declared, gates, failures };
}

/**
 * 用 manifest 声明核验 runner metric。extension 完全由声明 metric 决定，
 * 不读取 passRate，因此不会回退到历史 80% 通用 gate。
 */
export function evaluateSuiteGate(
  summary: SuiteSummary,
  contract: SuiteGateContract,
): SuiteGateEvaluation {
  const failures: string[] = [];
  const metrics = summary.metrics ?? [];
  const byName = new Map(metrics.map((metric) => [metric.name, metric]));
  const parsed = parseManifestContract(contract);
  const { declared, gates } = parsed;
  failures.push(...parsed.failures);
  if (declared.length === 0 && metrics.length === 0) {
    failures.push("suite 未声明且未产出任何 metric");
  }

  const metricNames = metrics.map((metric) => metric.name);
  const duplicateNames = metricNames.filter(
    (name, index) => metricNames.indexOf(name) !== index,
  );
  for (const name of new Set(duplicateNames)) {
    failures.push(`metric '${name}' 重复产出`);
  }

  for (const name of declared) {
    if (!byName.has(name)) {
      failures.push(`manifest metric '${name}' 未产出`);
    }
  }

  if (contract.kind === "extension") {
    for (const name of metricNames) {
      if (!declared.includes(name)) {
        failures.push(`runner 产出未声明 metric '${name}'`);
      }
    }
  }

  for (const metric of metrics) {
    if (!Number.isFinite(metric.denominator) || metric.denominator <= 0) {
      failures.push(metric.failure ?? `metric '${metric.name}' denominator=${metric.denominator}`);
      continue;
    }
    const expectedValue = metric.numerator / metric.denominator;
    if (!Number.isFinite(metric.numerator) || !Number.isFinite(metric.threshold) ||
        !Number.isFinite(expectedValue) || metric.value !== expectedValue) {
      failures.push(`metric '${metric.name}' value 不是 numerator/denominator`);
      continue;
    }
    if (metric.failure) failures.push(metric.failure);

    const manifestThreshold = gates[metric.name];
    const expectedDirection = METRIC_DIRECTIONS[metric.name];
    if (!expectedDirection) {
      failures.push(`metric '${metric.name}' 缺少 direction 定义`);
      continue;
    }
    if (metric.direction !== expectedDirection) {
      failures.push(
        `metric '${metric.name}' direction=${metric.direction}，协议要求 ${expectedDirection}`,
      );
    }
    if (manifestThreshold !== undefined) {
      if (metric.threshold !== manifestThreshold) {
        failures.push(
          `metric '${metric.name}' threshold=${metric.threshold}，manifest 要求 ${manifestThreshold}`,
        );
      }
      if (!metricPasses(expectedValue, expectedDirection, manifestThreshold)) {
        failures.push(
          `metric '${metric.name}' value=${expectedValue} 未满足 ${expectedDirection} ${manifestThreshold}`,
        );
      }
    } else if (!metric.passed || metric.failure) {
      failures.push(
        metric.failure ??
          `metric '${metric.name}' value=${metric.value} 未满足 ${metric.direction} ${metric.threshold}`,
      );
    }
  }

  // 通用 quality gate：任何 suite 存在 case failure 都不得被 metric 伪绿。
  if (summary.failed > 0) {
    failures.push(`suite '${summary.suite}' 存在 ${summary.failed} 个失败 case`);
  }

  return { passed: failures.length === 0, failures };
}

/** 只有真实宿主 E2E、无 fallback、无 degraded 才具备 production release 资格。 */
export function isProductionReleaseEligible(
  summaries: readonly SuiteSummary[],
): boolean {
  return (
    summaries.length > 0 &&
    summaries.every(
      (summary) =>
        summary.execution?.runMode === "runtime-e2e" &&
        validExecutionIdentity(summary.execution.provider, 256) &&
        validExecutionIdentity(summary.execution.model, 256) &&
        validExecutionIdentity(summary.execution.prompt, 2_048) &&
        validExecutionIdentity(summary.execution.version, 256) &&
        summary.execution.fallback === false &&
        summary.execution.degraded === false,
    )
  );
}

function validExecutionIdentity(value: string | null, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength &&
    value === value.trim() && value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
}

function countPassingByFailurePrefix(
  cases: readonly GoldenCase[],
  results: readonly CaseResult[],
  applicable: (goldenCase: GoldenCase) => boolean,
  prefix: string,
): { numerator: number; denominator: number } {
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < cases.length; i++) {
    if (!applicable(cases[i])) continue;
    denominator += 1;
    const result = results[i];
    if (result && !result.failures.some((failure) => failure.startsWith(prefix))) {
      numerator += 1;
    }
  }
  return { numerator, denominator };
}

/** 为现有 slot-context baseline 生成完整 metric 协议。 */
export function createBaselineMetrics(
  cases: readonly GoldenCase[],
  results: readonly CaseResult[],
  summary: SuiteSummary,
): EvalMetricResult[] {
  if (cases.length !== results.length || summary.total !== cases.length) {
    throw new Error("baseline cases/results/summary 数量不一致");
  }
  const total = summary.total;
  const slotApplicable = cases
    .map((goldenCase, index) => ({ goldenCase, result: results[index] }))
    .filter(({ goldenCase }) => (goldenCase.expected.requiredMemoryIds?.length ?? 0) > 0);
  const metrics: EvalMetricResult[] = [
    createMetric({
      name: "case_pass_rate",
      numerator: summary.passed,
      denominator: total,
      direction: "min",
      threshold: summary.suite.includes("safety")
        ? SLOT_CONTEXT_BASELINE_THRESHOLDS.safetyCasePassRate
        : SLOT_CONTEXT_BASELINE_THRESHOLDS.casePassRate,
    }),
    createMetric({
      name: "slot_recall",
      numerator: slotApplicable.filter(({ result }) => result?.missedRequired.length === 0).length,
      denominator: slotApplicable.length,
      direction: "min",
      threshold: SLOT_CONTEXT_BASELINE_THRESHOLDS.slotRecall,
    }),
    createMetric({
      name: "wrong_injection",
      numerator: results.filter((result) => result.injectedForbidden.length > 0).length,
      denominator: total,
      direction: "exact",
      threshold: SLOT_CONTEXT_BASELINE_THRESHOLDS.wrongInjection,
    }),
    createMetric({
      name: "latency",
      numerator: summary.latencyP95Ms,
      denominator: 1,
      direction: "max",
      threshold: SLOT_CONTEXT_BASELINE_THRESHOLDS.latencyP95Ms,
    }),
  ];

  if (summary.suite.includes("safety")) {
    const sensitive = countPassingByFailurePrefix(
      cases,
      results,
      (goldenCase) => goldenCase.expected.expectSensitiveBlocked === true,
      "sensitive_blocked:",
    );
    const escaped = countPassingByFailurePrefix(
      cases,
      results,
      (goldenCase) =>
        (goldenCase.expected.mustEscape?.length ?? 0) > 0 ||
        (goldenCase.expected.mustEscapeMaxCount?.length ?? 0) > 0,
      "must_escape:",
    );
    metrics.push(
      createMetric({
        name: "sensitive_blocked",
        ...sensitive,
        direction: "exact",
        threshold: SLOT_CONTEXT_BASELINE_THRESHOLDS.sensitiveBlocked,
      }),
      createMetric({
        name: "must_escape",
        ...escaped,
        direction: "exact",
        threshold: SLOT_CONTEXT_BASELINE_THRESHOLDS.mustEscape,
      }),
    );
  }

  return metrics;
}

export function offlineSlotContextExecution(): EvalExecutionMetadata {
  return { ...OFFLINE_EXECUTION };
}
