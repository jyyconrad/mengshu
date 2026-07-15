import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { runConflictDetectionSuite } from "./conflict-detection.js";

const fixture = path.resolve(
  import.meta.dirname,
  "../goldens/mengshu-conflict.jsonl",
);
const tempDirs: string[] = [];

function writeFixture(cases: unknown[]): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mengshu-conflict-detection-"));
  tempDirs.push(dir);
  const file = path.join(dir, "fixture.jsonl");
  writeFileSync(file, `${cases.map((item) => JSON.stringify(item)).join("\n")}\n`);
  return file;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("conflict-detection-v1 honest component runner", () => {
  test("补足真实冲突语义信号后 production classifier 达到 gate", async () => {
    const run = await runConflictDetectionSuite(fixture);

    expect(run.suite).toBe("mengshu-conflict");
    expect(run.total).toBe(10);
    expect(run.results).toHaveLength(10);
    expect(run.passed).toBe(10);
    expect(run.qualityGatePassed).toBe(true);
    expect(run.gateFailures).toEqual([]);
  });

  test("只输出 manifest 要求的两个精确 metric", async () => {
    const run = await runConflictDetectionSuite(fixture);
    const conflictRecall = run.metrics.find(
      (metric) => metric.name === "conflict_recall",
    )!;
    const falseMerge = run.metrics.find(
      (metric) => metric.name === "rules_false_merge",
    )!;
    const expectedPositive = run.results.filter(
      (result) => result.expectedConflict,
    ).length;
    const detectedPositive = run.results.filter(
      (result) => result.expectedConflict && result.actual.detected,
    ).length;

    expect(run.metrics.map((metric) => metric.name)).toEqual([
      "conflict_recall",
      "rules_false_merge",
    ]);
    expect(conflictRecall).toMatchObject({
      numerator: detectedPositive,
      denominator: expectedPositive,
      direction: "min",
      threshold: 0.8,
    });
    expect(falseMerge).toMatchObject({
      numerator: 0,
      denominator: 3,
      value: 0,
      direction: "exact",
      threshold: 0,
      passed: true,
    });
    expect(falseMerge.failure).toBeUndefined();
    expect(conflictRecall.passed).toBe(true);
    expect(falseMerge.passed).toBe(true);
  });

  test("rules false-merge 由 production 冲突降级动作给出真实非零分母", async () => {
    const run = await runConflictDetectionSuite(fixture);
    const labelled = run.results.filter(
      (result) => result.expectedFalseMerge !== undefined,
    );

    expect(labelled).toHaveLength(3);
    for (const result of labelled) {
      expect(result.unsupportedContracts).not.toContain("rules_merge_outcome");
      expect(result.actual.falseMerge).toBe(0);
      expect(result.actual.downgradeApplied).toBe(1);
    }
    expect(run.gateFailures).toEqual([]);
  });

  test("execution 明确是非降级 offline component", async () => {
    const run = await runConflictDetectionSuite(fixture);

    expect(run.execution).toEqual({
      runMode: "offline-component",
      provider: null,
      model: null,
      prompt: null,
      version: "conflict-detection-v1",
      fallback: false,
      degraded: false,
    });
  });

  test("同一 fixture 连续运行完全确定一致", async () => {
    const first = await runConflictDetectionSuite(fixture);
    const second = await runConflictDetectionSuite(fixture);

    expect(second).toEqual(first);
  });

  test("直接暴露当前公开 classifier 的真实能力，不按 golden 标签造结果", async () => {
    const run = await runConflictDetectionSuite(fixture);
    const positivePattern = run.results.find(
      (result) => result.caseId === "conflict-003",
    )!;
    const unsupportedMutualChoice = run.results.find(
      (result) => result.caseId === "conflict-001",
    )!;

    expect(positivePattern.actual.detected).toBe(true);
    expect(positivePattern.actual.conflictTypes).toContain("contradiction");
    expect(unsupportedMutualChoice.actual.detected).toBe(true);
  });

  test.each([
    ["conflict-007", ["resolved_by", "winner"]],
    ["conflict-008", ["action", "rollback_available"]],
    ["conflict-009", ["reason"]],
    ["conflict-010", ["relation"]],
  ] as const)("%s 将 component 外断言保留为非阻断诊断", async (caseId, fields) => {
    const run = await runConflictDetectionSuite(fixture);
    const result = run.results.find((item) => item.caseId === caseId)!;

    expect(result.passed).toBe(true);
    expect(result.unsupportedContracts).toEqual(expect.arrayContaining([...fields]));
    for (const field of fields) {
      expect(result.failures).not.toContain(`unsupported_contract:${field}`);
    }
  });

  test("memory.scope 通过 production repository scope filter 执行", async () => {
    const run = await runConflictDetectionSuite(fixture);
    for (const caseId of ["conflict-001", "conflict-006", "conflict-009"]) {
      const result = run.results.find((item) => item.caseId === caseId)!;
      expect(result.unsupportedContracts).not.toContain("memory.scope");
    }
    expect(run.results.find((item) => item.caseId === "conflict-009")?.actual.detected)
      .toBe(false);
  });

  test("zero denominator 保留 createMetric 的结构化 failure", async () => {
    const run = await runConflictDetectionSuite(writeFixture([{
      id: "conflict-zero-denominator",
      suite: "mengshu-conflict",
      task: "no positive or false-merge labels",
      memoryA: { body: "use eslint", type: "resource" },
      memoryB: { body: "use prettier", type: "resource" },
      expected: { conflict_detected: false },
    }]));

    expect(run.metrics.every((metric) => metric.denominator === 0)).toBe(true);
    expect(run.gateFailures).toEqual(expect.arrayContaining([
      "metric 'conflict_recall' denominator=0",
      "metric 'rules_false_merge' denominator=0",
    ]));
  });
});
