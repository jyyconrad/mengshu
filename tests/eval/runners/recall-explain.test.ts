import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { adaptExtensionRun } from "./extension-runner-adapters.js";
import { buildReport } from "./quick-eval.js";
import { runRecallExplainSuite } from "./recall-explain.js";

const fixture = path.resolve(
  import.meta.dirname,
  "../goldens/mengshu-recall-explain.jsonl",
);
const tempDirs: string[] = [];

function writeFixture(cases: unknown[]): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mengshu-recall-explain-"));
  tempDirs.push(dir);
  const file = path.join(dir, "fixture.jsonl");
  writeFileSync(file, `${cases.map((item) => JSON.stringify(item)).join("\n")}\n`);
  return file;
}

function syntheticCase(memory: Record<string, unknown>): unknown {
  return {
    id: "recall-synthetic",
    suite: "mengshu-recall-explain",
    task: "production importance breakdown boundary",
    query: "write code",
    scope: { userId: "u1", projectId: "p1" },
    memories: [{ id: "memory-1", body: "Never use any", type: "rules", ...memory }],
    expected: {
      recalled: [{
        id: "memory-1",
        importance: {
          salience_llm: 0,
          sourceAuthority: 0,
          explicitnessBonus: 0,
          typePrior: 0,
        },
        breakdown_visible: true,
      }],
    },
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("recall-explain-v1 honest component runner", () => {
  test("严格加载并逐条运行全部 60 case", async () => {
    const run = await runRecallExplainSuite(fixture);

    expect(run.suite).toBe("mengshu-recall-explain");
    expect(run.total).toBe(60);
    expect(run.results).toHaveLength(60);
    expect(new Set(run.results.map((result) => result.caseId)).size).toBe(60);
    expect(run.passed).toBe(60);
    expect(run.qualityGatePassed).toBe(true);
  });

  test("连续运行完全确定", async () => {
    const first = await runRecallExplainSuite(fixture);
    const second = await runRecallExplainSuite(fixture);

    expect(second).toEqual(first);
  });

  test("四项 breakdown 来自真实 production 入口，不是 expected 回填", async () => {
    const run = await runRecallExplainSuite(writeFixture([
      syntheticCase({ salience_llm: 0.8, source: "rule_file", explicitSave: true }),
    ]));
    const evaluation = run.results[0].memoryEvaluations[0];

    expect(evaluation.eligibleForBreakdownMetric).toBe(true);
    expect(evaluation.actual.importance).toBeCloseTo(0.91, 12);
    expect(evaluation.actual.breakdown).not.toBeNull();
    expect(evaluation.actual.breakdown!.salience_llm).toBeCloseTo(0.36, 12);
    expect(evaluation.actual.breakdown!.sourceAuthority).toBeCloseTo(0.2, 12);
    expect(evaluation.actual.breakdown!.explicitnessBonus).toBeCloseTo(0.2, 12);
    expect(evaluation.actual.breakdown!.typePrior).toBeCloseTo(0.15, 12);
    expect(evaluation.actual.breakdown).not.toEqual({
      salience_llm: 0,
      sourceAuthority: 0,
      explicitnessBonus: 0,
      typePrior: 0,
    });
  });

  test("顶层 breakdown_visible 使用 production breakdown 精确判定，不得静默忽略", async () => {
    const base = {
      id: "recall-breakdown-visible",
      suite: "mengshu-recall-explain",
      task: "breakdown visibility contract",
      query: "write code",
      scope: { userId: "u1", projectId: "p1" },
      memories: [{
        id: "memory-1",
        body: "Never use any",
        type: "rules",
        salience_llm: 0.8,
        source: "rule_file",
      }],
    };
    const hidden = await runRecallExplainSuite(writeFixture([
      { ...base, expected: { breakdown_visible: false } },
    ]));
    const visible = await runRecallExplainSuite(writeFixture([
      { ...base, expected: { breakdown_visible: true } },
    ]));

    expect(hidden.results[0].memoryEvaluations[0].actual.breakdown).not.toBeNull();
    expect(hidden.results[0]).toMatchObject({
      passed: false,
      failures: ["breakdown_visible:expected=false,actual=true"],
    });
    expect(hidden.qualityGatePassed).toBe(false);
    expect(hidden.gateFailures).toContain("case_contract_failures:1");
    expect(visible.results[0].failures).not.toContain(
      "breakdown_visible:expected=true,actual=false",
    );
  });

  test("custom suite report 不能让未满足的 breakdown_visible contract 放行", async () => {
    const custom = await runRecallExplainSuite(writeFixture([{
      id: "recall-breakdown-report",
      suite: "mengshu-recall-explain",
      task: "breakdown visibility report gate",
      query: "write code",
      scope: { userId: "u1" },
      memories: [{
        id: "memory-1",
        body: "Never use any",
        type: "rules",
        salience_llm: 0.8,
        source: "rule_file",
      }],
      expected: { breakdown_visible: false },
    }]));
    const adapted = adaptExtensionRun(custom);
    const report = buildReport([adapted.summary], [], [{
      name: "mengshu-recall-explain",
      kind: "extension",
      runner: "recall-explain-v1",
      caseCount: 1,
      sha256: "0".repeat(64),
      metrics: ["breakdown_output_rate"],
      gate: { breakdown_output_rate: 1 },
      manifestSchemaVersion: 1,
      manifestVersion: "test",
    }]);

    expect(report.totalFailed).toBe(1);
    expect(report.suites[0].gatePassed).toBe(false);
    expect(report.releaseGatePassed).toBe(false);
    expect(report.productionReleaseGatePassed).toBe(false);
  });

  test("golden fixture 为每条 memory 提供真实 scoring 输入并达到 breakdown 门槛", async () => {
    const run = await runRecallExplainSuite(fixture);

    expect(run.metrics).toHaveLength(1);
    expect(run.metrics[0]).toMatchObject({
      name: "breakdown_output_rate",
      value: 1,
      direction: "exact",
      threshold: 1,
      passed: true,
    });
    expect(
      run.results.flatMap((result) => result.memoryEvaluations)
        .filter((evaluation) => evaluation.eligibleForBreakdownMetric),
    ).toHaveLength(run.metrics[0].denominator);
    expect(run.metrics[0].denominator).toBeGreaterThan(0);
    expect(run.qualityGatePassed).toBe(true);
    expect(run.gateFailures).toEqual([]);
  });

  test("缺失必要 salience metadata 时保留 production null 并 fail-closed", async () => {
    const run = await runRecallExplainSuite(writeFixture([
      syntheticCase({ source: "rule_file" }),
    ]));
    const result = run.results[0];
    const evaluation = result.memoryEvaluations[0];

    expect(evaluation.eligibleForBreakdownMetric).toBe(false);
    expect(evaluation.actual).toEqual({ importance: 0.5, breakdown: null });
    expect(result.failures).toContain(
      "importance_breakdown_unavailable:memory-1:missing_salience_llm",
    );
    expect(run.metrics[0]).toMatchObject({
      numerator: 0,
      denominator: 0,
      value: 0,
      passed: false,
    });
    expect(run.gateFailures.join("\n")).toMatch(/denominator=0/);
  });

  test("有 salience 但来源未知时不伪造 session_user，保留 production null", async () => {
    const run = await runRecallExplainSuite(writeFixture([
      syntheticCase({ salience_llm: 0.8 }),
    ]));
    const result = run.results[0];
    const evaluation = result.memoryEvaluations[0];

    expect(evaluation.sourceKind).toBeUndefined();
    expect(evaluation.eligibleForBreakdownMetric).toBe(false);
    expect(evaluation.actual).toEqual({ importance: 0.5, breakdown: null });
    expect(result.failures).toContain(
      "importance_breakdown_unavailable:memory-1:missing_source_kind",
    );
  });

  test("salience=0 明确入参但 production 返回 null 时进入分母并使 metric 失败", async () => {
    const run = await runRecallExplainSuite(writeFixture([
      syntheticCase({ salience_llm: 0, source: "rule_file" }),
    ]));
    const evaluation = run.results[0].memoryEvaluations[0];

    expect(evaluation.eligibleForBreakdownMetric).toBe(true);
    expect(evaluation.actual.breakdown).toBeNull();
    expect(run.results[0].failures).toContain(
      "importance_breakdown_unavailable:memory-1:production_returned_null",
    );
    expect(run.metrics[0]).toMatchObject({ numerator: 0, denominator: 1, passed: false });
    expect(run.gateFailures.join("\n")).toMatch(/value=0.*exact 1/);
  });

  test.each([
    ["recall-021", ["recalled", "filtered", "override"]],
    ["recall-022", ["recalled", "confidence"]],
    ["recall-024", ["recalled", "hotness"]],
    ["recall-026", ["recalled", "recency"]],
    ["recall-031", ["recalled", "slot"]],
    ["recall-059", ["recalled", "slot", "slot_order"]],
  ] as const)("%s 保留 component 外 contract 诊断但不污染 scoring gate", async (caseId, fields) => {
    const run = await runRecallExplainSuite(fixture);
    const result = run.results.find((item) => item.caseId === caseId)!;

    expect(result.passed).toBe(true);
    expect(result.unsupportedContracts).toEqual(expect.arrayContaining([...fields]));
    for (const field of fields) {
      expect(result.failures).not.toContain(`unsupported_contract:${field}`);
    }
  });

  test("离线 component 身份与确定性输入边界可追溯", async () => {
    const run = await runRecallExplainSuite(fixture);

    expect(run.execution).toEqual({
      runMode: "offline-component",
      provider: null,
      model: null,
      prompt: null,
      version: "recall-explain-v1",
      fallback: false,
      degraded: false,
    });
    expect(run.componentBoundary).toEqual({
      productionEntry: "computeImportanceForRecordWithBreakdown",
      output: "importance_weighted_contributions_only",
      sourceKindPolicy: "fixture_explicit_mapping_only",
      clock: "not_applicable_pure_function",
      metricEligibility: "memory.salience_llm_and_source_kind_are_present",
    });
  });

  test("golden fixture 已消除 breakdown 输入欠定与语义歧义", async () => {
    const run = await runRecallExplainSuite(fixture);

    expect(run.contractIssues).toEqual([]);
    expect(run.gateFailures).toEqual([]);
    expect(run.qualityGatePassed).toBe(true);
  });
});
