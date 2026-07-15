import { describe, expect, test } from "vitest";

import {
  createBaselineMetrics,
  createMetric,
  evaluateSuiteGate,
  findUnsupportedExpectedFields,
  isProductionReleaseEligible,
} from "./eval-metrics.js";
import type { EvalExecutionMetadata, SuiteSummary } from "./types.js";

function execution(
  overrides: Partial<EvalExecutionMetadata> = {},
): EvalExecutionMetadata {
  return {
    runMode: "offline-component",
    provider: null,
    model: null,
    prompt: null,
    version: "test-v1",
    fallback: false,
    degraded: false,
    ...overrides,
  };
}

function summary(overrides: Partial<SuiteSummary> = {}): SuiteSummary {
  return {
    suite: "extension-suite",
    total: 10,
    passed: 10,
    failed: 0,
    passRate: 1,
    slotRecallPassRate: 1,
    wrongInjectionRate: 0,
    latencyP50Ms: 1,
    latencyP95Ms: 2,
    failedCases: [],
    metrics: [],
    execution: execution(),
    ...overrides,
  };
}

describe("eval metric protocol", () => {
  test.each([
    ["min", 8, 10, 0.8, true],
    ["min", 7, 10, 0.8, false],
    ["max", 1, 10, 0.1, true],
    ["max", 2, 10, 0.1, false],
    ["exact", 0, 10, 0, true],
    ["exact", 1, 10, 0, false],
  ] as const)(
    "%s gate 使用 numerator/denominator 计算并判定",
    (direction, numerator, denominator, threshold, passed) => {
      const metric = createMetric({
        name: "metric",
        numerator,
        denominator,
        direction,
        threshold,
      });

      expect(metric.value).toBe(numerator / denominator);
      expect(metric.passed).toBe(passed);
    },
  );

  test("denominator=0 必须 fail-closed", () => {
    const metric = createMetric({
      name: "breakdown_output_rate",
      numerator: 0,
      denominator: 0,
      direction: "exact",
      threshold: 1,
    });

    expect(metric.passed).toBe(false);
    expect(metric.failure).toMatch(/denominator=0/);
  });

  test("denominator<0 不能被 manifest gate 重新判为通过", () => {
    const metric = createMetric({
      name: "wrong_injection",
      numerator: 0,
      denominator: -1,
      direction: "exact",
      threshold: 0,
    });
    const result = evaluateSuiteGate(summary({ metrics: [metric] }), {
      kind: "extension",
      metrics: ["wrong_injection"],
      gate: { wrong_injection: 0 },
    });

    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toMatch(/denominator=-1/);
  });

  test("manifest 声明 metric 缺失时即使 extension passRate=100% 也失败", () => {
    const result = evaluateSuiteGate(
      summary({ passRate: 1, metrics: [] }),
      {
        kind: "extension",
        metrics: ["type_precision"],
        gate: { type_precision: 0.85 },
      },
    );

    expect(result.passed).toBe(false);
    expect(result.failures).toContain("manifest metric 'type_precision' 未产出");
  });

  test("既无声明也无输出 metric 时 fail-closed", () => {
    const result = evaluateSuiteGate(summary({ metrics: [] }), {
      kind: "extension",
      metrics: [],
      gate: {},
    });

    expect(result.passed).toBe(false);
    expect(result.failures).toContain("suite 未声明且未产出任何 metric");
  });

  test("同名 metric 重复产出时 fail-closed", () => {
    const metric = createMetric({
      name: "type_precision",
      numerator: 9,
      denominator: 10,
      direction: "min",
      threshold: 0.85,
    });
    const result = evaluateSuiteGate(summary({ metrics: [metric, metric] }), {
      kind: "extension",
      metrics: ["type_precision"],
      gate: { type_precision: 0.85 },
    });

    expect(result.passed).toBe(false);
    expect(result.failures).toContain("metric 'type_precision' 重复产出");
  });

  test("manifest 重复 metric、额外 gate 或 malformed contract 均 fail-closed", () => {
    const metric = createMetric({
      name: "type_precision",
      numerator: 9,
      denominator: 10,
      direction: "min",
      threshold: 0.85,
    });

    expect(evaluateSuiteGate(summary({ metrics: [metric] }), {
      kind: "extension",
      metrics: ["type_precision", "type_precision"],
      gate: { type_precision: 0.85 },
    }).passed).toBe(false);
    expect(evaluateSuiteGate(summary({ metrics: [metric] }), {
      kind: "extension",
      metrics: ["type_precision"],
      gate: { type_precision: 0.85, undeclared: 1 },
    }).passed).toBe(false);
    expect(evaluateSuiteGate(summary({ metrics: [metric] }), {
      kind: "extension",
      metrics: "malformed",
      gate: "malformed",
    }).passed).toBe(false);
  });

  test("extension 只按声明 metric 判定，不回退通用 80% pass rate", () => {
    const metric = createMetric({
      name: "type_precision",
      numerator: 9,
      denominator: 10,
      direction: "min",
      threshold: 0.85,
    });
    const result = evaluateSuiteGate(
      summary({ passRate: 0.2, metrics: [metric] }),
      {
        kind: "extension",
        metrics: ["type_precision"],
        gate: { type_precision: 0.85 },
      },
    );

    expect(result.passed).toBe(true);
  });

  test("metric 通过但 summary.failed>0 时通用 quality gate 仍 fail-closed", () => {
    const metric = createMetric({
      name: "type_precision",
      numerator: 10,
      denominator: 10,
      direction: "min",
      threshold: 0.85,
    });
    const result = evaluateSuiteGate(
      summary({ total: 10, passed: 9, failed: 1, passRate: 0.9, metrics: [metric] }),
      {
        kind: "extension",
        metrics: ["type_precision"],
        gate: { type_precision: 0.85 },
      },
    );

    expect(metric.passed).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toMatch(/1.*失败 case|失败 case.*1/i);
  });

  test("runner metric threshold 或 direction 与 manifest 协议不一致时失败", () => {
    const metric = createMetric({
      name: "over_capture",
      numerator: 0,
      denominator: 10,
      direction: "min",
      threshold: 0.2,
    });
    const result = evaluateSuiteGate(
      summary({ metrics: [metric] }),
      {
        kind: "extension",
        metrics: ["over_capture"],
        gate: { over_capture: 0.1 },
      },
    );

    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toMatch(/direction.*max/);
    expect(result.failures.join("\n")).toMatch(/threshold.*0.1/);
  });

  test("未知 expected 字段必须显式报告，不允许空断言通过", () => {
    expect(
      findUnsupportedExpectedFields(
        { requiredMemoryIds: ["m1"], conflict_detected: true },
        new Set(["requiredMemoryIds"]),
      ),
    ).toEqual(["conflict_detected"]);
  });

  test("slot_recall 只统计有 requiredMemoryIds 的 applicable cases", () => {
    const cases = [
      { expected: { requiredMemoryIds: ["m1"] } },
      { expected: { requiredMemoryIds: ["m2"] } },
      { expected: { forbiddenMemoryIds: ["m3"] } },
    ] as never[];
    const results = [
      { missedRequired: [], injectedForbidden: [], failures: [] },
      { missedRequired: ["m2"], injectedForbidden: [], failures: ["slot_recall: miss"] },
      { missedRequired: [], injectedForbidden: [], failures: [] },
    ] as never[];
    const metrics = createBaselineMetrics(cases, results, summary({
      suite: "mengshu-v0.1",
      total: 3,
      passed: 2,
      failed: 1,
    }));

    expect(metrics.find((metric) => metric.name === "slot_recall")).toMatchObject({
      numerator: 1,
      denominator: 2,
      value: 0.5,
      passed: false,
    });
  });

  test("无 applicable slot case 与 cases/results 缺项都 fail-closed", () => {
    const negativeCases = [{ expected: { forbiddenMemoryIds: ["m1"] } }] as never[];
    const results = [{ missedRequired: [], injectedForbidden: [], failures: [] }] as never[];
    const metrics = createBaselineMetrics(negativeCases, results, summary({
      suite: "mengshu-v0.1",
      total: 1,
      passed: 1,
      failed: 0,
    }));

    expect(metrics.find((metric) => metric.name === "slot_recall")).toMatchObject({
      denominator: 0,
      passed: false,
    });
    expect(() => createBaselineMetrics(negativeCases, [], summary({
      suite: "mengshu-safety",
      total: 1,
      passed: 0,
      failed: 1,
    }))).toThrow(/cases.*results|数量/i);
  });
});

describe("production release eligibility", () => {
  test("只有 runtime-e2e 且非 fallback/degraded 才具备 production release 资格", () => {
    const eligible = summary({
      execution: execution({
        runMode: "runtime-e2e",
        provider: "openai",
        model: "gpt-test",
        prompt: "prompt-v1",
      }),
    });
    const offline = summary({ execution: execution() });
    const degraded = summary({
      execution: execution({ runMode: "runtime-e2e", degraded: true }),
    });
    const fallback = summary({
      execution: execution({ runMode: "runtime-e2e", fallback: true }),
    });

    expect(isProductionReleaseEligible([eligible])).toBe(true);
    expect(isProductionReleaseEligible([offline])).toBe(false);
    expect(isProductionReleaseEligible([degraded])).toBe(false);
    expect(isProductionReleaseEligible([fallback])).toBe(false);
  });

  test("runtime-e2e 缺 provider/model/prompt/version 不能进入 production", () => {
    for (const field of ["provider", "model", "prompt", "version"] as const) {
      const invalid = summary({
        execution: execution({
          runMode: "runtime-e2e",
          provider: "openai",
          model: "gpt-test",
          prompt: "prompt-v1",
          [field]: field === "version" ? " " : null,
        }),
      });
      expect(isProductionReleaseEligible([invalid])).toBe(false);
    }
  });
});
