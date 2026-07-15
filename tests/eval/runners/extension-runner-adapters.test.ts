import { describe, expect, test } from "vitest";

import {
  EXTENSION_RUNNER_REGISTRY,
  adaptExtensionRun,
  type HonestExtensionRun,
} from "./extension-runner-adapters.js";

const execution = {
  runMode: "offline-component" as const,
  provider: null,
  model: null,
  prompt: null,
  version: "honest-test-v1",
  fallback: false,
  degraded: false,
};

function run(overrides: Partial<HonestExtensionRun> = {}): HonestExtensionRun {
  return {
    suite: "mengshu-extension-test",
    total: 2,
    passed: 1,
    failed: 1,
    results: [
      { caseId: "case-pass", passed: true, failures: [] },
      {
        caseId: "case-fail",
        passed: false,
        failures: ["unsupported_contract:real_gap"],
      },
    ],
    metrics: [{
      name: "faithfulness",
      numerator: 1,
      denominator: 2,
      value: 0.5,
      direction: "min",
      threshold: 0.95,
      passed: false,
    }],
    execution,
    qualityGatePassed: false,
    gateFailures: ["runner_gate:real_failure"],
    contractIssues: [{
      suite: "mengshu-extension-test",
      caseId: "case-fail",
      severity: "warning",
      code: "fixture_contract_gap",
      path: "$.expected",
      message: "fixture contract is not implemented",
    }],
    ...overrides,
  };
}

describe("honest extension runner adapter", () => {
  test("只映射 runner 原始 verdict，不二次造标签，并保留 gate/contract identity", () => {
    const adapted = adaptExtensionRun(run());

    expect(adapted.results.map(({ caseId, passed, failures }) => ({ caseId, passed, failures })))
      .toEqual([
        { caseId: "case-pass", passed: true, failures: [] },
        {
          caseId: "case-fail",
          passed: false,
          failures: ["unsupported_contract:real_gap"],
        },
      ]);
    expect(adapted.summary).toMatchObject({
      suite: "mengshu-extension-test",
      total: 2,
      passed: 1,
      failed: 1,
      passRate: 0.5,
      gateFailures: ["runner_gate:real_failure"],
      contractIssues: [expect.objectContaining({
        caseId: "case-fail",
        code: "fixture_contract_gap",
      })],
      execution,
    });
    expect(adapted.summary.failedCases.map(({ caseId }) => caseId)).toEqual(["case-fail"]);
    expect(adapted.summary.metrics).toEqual(run().metrics);
  });

  test.each([
    { total: 3 },
    { passed: 2 },
    { failed: 0 },
    { qualityGatePassed: true },
    { gateFailures: [], qualityGatePassed: false },
  ])("不一致 runner summary %# fail-closed", (overrides) => {
    expect(() => adaptExtensionRun(run(overrides))).toThrow(/extension runner|inconsistent|不一致/i);
  });

  test("registry 精确注册 manifest 六个 runner id", () => {
    expect([...EXTENSION_RUNNER_REGISTRY.keys()]).toEqual([
      "candidate-extraction-v1",
      "semantic-dedup-v1",
      "recall-explain-v1",
      "conflict-detection-v1",
      "tree-summary-v1",
      "skill-candidate-v1",
    ]);
  });
});
