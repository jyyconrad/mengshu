/**
 * tests/eval/runners/quick-eval.test.ts
 *
 * 本文件做什么：
 *   把 tests/eval/goldens/*.jsonl 的每条 case 接到 vitest test.each 上，
 *   形成"每条黄金集 → 一个 vitest 用例"的回归测试。
 *
 * 核心流程：
 *   1) 从 manifest 加载已登记的 baseline suite；
 *   2) 用 quick-eval 的 runSuite 跑出 results；
 *   3) test.each 逐条断言 result.passed === true；
 *      失败时打印 case.failures 帮助定位。
 *   4) suite 级断言：
 *      - safety 套件 wrong_injection_rate 必须为 0；
 *      - v0.1 套件 pass rate 必须 >= 80%（v0.1 release gate）。
 *
 * 关键边界：
 *   - 这里依赖 SlotContextBuilder + scope-policy + sensitive-filter，
 *     不调用任何外部服务；纯本地，2 秒内能跑完。
 *   - 不依赖 LLM，不依赖向量库；判定全部基于 id 命中与字面匹配。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import { loadEvalManifest, selectEvalSuites } from "./eval-manifest.js";
import { buildReport, renderReport, runSuite } from "./quick-eval.js";
import type { CaseResult } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const goldensDir = path.resolve(__dirname, "../goldens");
const manifestPath = path.join(goldensDir, "manifest.json");

const SUITES = selectEvalSuites(
  loadEvalManifest(manifestPath),
  "all",
  manifestPath,
).filter((suite) => suite.kind === "baseline");

for (const suite of SUITES) {
  describe(`golden suite: ${suite.name}`, async () => {
    const { results, summary } = await runSuite(suite.filePath);

    test("suite-level release gate", () => {
      expect(buildReport([summary], [], [suite]).releaseGatePassed).toBe(true);
    });

    const cases: Array<[string, CaseResult]> = results.map((r) => [r.caseId, r]);

    test.each(cases)("case %s should pass", (_caseId, result) => {
      if (!result.passed) {
        // 让失败信息可读
        // 方便直接复现：打印 caseId + failures
        console.error(
          `[${result.suite}] ${result.caseId} failed:\n  - ${result.failures.join("\n  - ")}`,
        );
      }
      expect(result.passed).toBe(true);
    });
  });
}

describe("T500-0 baseline gate 与报告兼容", async () => {
  const baselineRuns = await Promise.all(
    SUITES.map(async (suite) => ({
      plan: suite,
      result: await runSuite(suite.filePath),
    })),
  );

  test("现有两套 baseline 保持 honest green，但 offline 不能标 production release", () => {
    const report = buildReport(
      baselineRuns.map(({ result }) => result.summary),
      [],
      baselineRuns.map(({ plan }) => plan),
    );

    expect(report.releaseGatePassed).toBe(true);
    expect(report.productionReleaseGatePassed).toBe(false);
    expect(report.suites.every((suite) => suite.gatePassed === true)).toBe(true);
    expect(
      report.suites.every(
        (suite) => suite.execution?.runMode === "offline-component",
      ),
    ).toBe(true);
  });

  test("production release 必须同时满足 quality gate 与完整 runtime-e2e metadata", () => {
    const first = baselineRuns[0]!;
    const runtimeSummary = {
      ...first.result.summary,
      execution: {
        runMode: "runtime-e2e" as const,
        provider: "openai",
        model: "gpt-test",
        prompt: "slot-context-prompt-v1",
        version: "runtime-v1",
        fallback: false,
        degraded: false,
      },
    };
    const report = buildReport([runtimeSummary], [], [first.plan]);

    expect(report.releaseGatePassed).toBe(true);
    expect(report.productionReleaseGatePassed).toBe(true);
  });

  test("报告写出 metric 协议与执行环境元数据", () => {
    const report = buildReport(
      baselineRuns.map(({ result }) => result.summary),
      [],
      baselineRuns.map(({ plan }) => plan),
    );
    const markdown = renderReport(report);

    expect(markdown).toContain("production release gate：未通过");
    expect(markdown).toContain("run mode：offline-component");
    expect(markdown).toContain("numerator=");
    expect(markdown).toContain("direction=");
    expect(markdown).toContain("manifest schema：1");
    expect(markdown).toContain("manifest version：v0.2-P0c");
    expect(report.manifest.suites).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "mengshu-v0.1",
        runner: "slot-context-v1",
        fixtureSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        gateIdentity: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]));
  });

  test("buildReport 缺失、多余或重复 suite plan/summary 时 fail-closed", () => {
    const first = baselineRuns[0]!;
    const extraPlan = { ...first.plan, name: "extra-suite" };

    expect(() => buildReport([first.result.summary])).toThrow(/manifest|plan/i);
    expect(() => buildReport(
      [first.result.summary],
      [],
      [first.plan, extraPlan],
    )).toThrow(/多余|extra|一一对应|plan/i);
    expect(() => buildReport(
      [first.result.summary],
      [],
      [first.plan, first.plan],
    )).toThrow(/重复|duplicate|plan/i);
    expect(() => buildReport(
      [first.result.summary, first.result.summary],
      [],
      [first.plan],
    )).toThrow(/重复|duplicate|summary|suite/i);
  });

  test("buildReport 校验 summary totals、passRate、failedCases 与 manifest caseCount", () => {
    const first = baselineRuns[0]!;
    const base = first.result.summary;
    const invalid = [
      { ...base, total: base.total + 1 },
      { ...base, failed: 1 },
      { ...base, passRate: 0.5 },
      { ...base, failedCases: [first.result.results[0]!] },
    ];

    for (const summary of invalid) {
      expect(() => buildReport([summary], [], [first.plan])).toThrow(
        /summary|total|passed|failed|passRate|failedCases|caseCount/i,
      );
    }
  });

  test("safety 任一 case 失败时，即使 wrong injection=0 也不能通过", () => {
    const safety = baselineRuns.find(({ plan }) => plan.name === "mengshu-safety")!;
    const brokenSummary = {
      ...safety.result.summary,
      passed: safety.result.summary.passed - 1,
      failed: 1,
      passRate: (safety.result.summary.total - 1) / safety.result.summary.total,
      failedCases: [
        {
          ...safety.result.results[0],
          passed: false,
          failures: ["must_escape: synthetic failure"],
        },
      ],
    };
    const report = buildReport([brokenSummary], [], [safety.plan]);

    expect(brokenSummary.wrongInjectionRate).toBe(0);
    expect(report.releaseGatePassed).toBe(false);
    expect(report.suites[0].gateFailures?.join("\n")).toMatch(/safety.*case/i);
  });

  test("metric PASS + case FAIL 不得 quality/release PASS", () => {
    const first = baselineRuns[0]!;
    const original = first.result.summary;
    const brokenCase = {
      ...first.result.results[0]!,
      passed: false,
      failures: ["unsupported_contract:synthetic"],
    };
    const brokenSummary = {
      ...original,
      passed: original.passed - 1,
      failed: 1,
      passRate: (original.total - 1) / original.total,
      failedCases: [brokenCase],
      execution: {
        runMode: "runtime-e2e" as const,
        provider: "openai",
        model: "gpt-test",
        prompt: "prompt-v1",
        version: "runtime-v1",
        fallback: false,
        degraded: false,
      },
    };
    expect(brokenSummary.metrics?.every((metric) => metric.passed)).toBe(true);

    const report = buildReport([brokenSummary], [], [first.plan]);

    expect(report.suites[0].gatePassed).toBe(false);
    expect(report.releaseGatePassed).toBe(false);
    expect(report.productionReleaseGatePassed).toBe(false);
    expect(report.suites[0].gateFailures?.join("\n")).toMatch(/1.*失败 case|失败 case.*1/i);
  });

  test("buildReport 保留并阻断 runner gateFailures，不被 manifest metric gate 覆盖", () => {
    const first = baselineRuns[0]!;
    const runnerFailure = "fixture_contract_issues:2";
    const report = buildReport([
      { ...first.result.summary, gateFailures: [runnerFailure] },
    ], [], [first.plan]);

    expect(report.suites[0].gatePassed).toBe(false);
    expect(report.suites[0].gateFailures).toContain(runnerFailure);
    expect(report.releaseGatePassed).toBe(false);
  });

  test("buildReport 对 contractIssues 独立 fail-closed，即使 runner 漏写 gate failure", () => {
    const first = baselineRuns[0]!;
    const report = buildReport([{
      ...first.result.summary,
      contractIssues: [{
        suite: first.plan.name,
        severity: "warning",
        code: "fixture_contract_gap",
        path: "$.expected",
        message: "unsupported fixture contract",
      }],
    }], [], [first.plan]);

    expect(report.releaseGatePassed).toBe(false);
    expect(report.suites[0].gatePassed).toBe(false);
    expect(report.suites[0].gateFailures?.join("\n")).toMatch(/contract issue/i);
  });

  test("slot-context runner 遇到未支持 expected 字段时 case 明确失败", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mengshu-unsupported-expected-"));
    const fixture = path.join(dir, "unsupported.jsonl");
    writeFileSync(
      fixture,
      `${JSON.stringify({
        id: "unsupported-001",
        suite: "unsupported-suite",
        task: "禁止空断言伪绿",
        scope: { userId: "u1" },
        seedMemories: [],
        query: "test",
        expected: { conflict_detected: true },
      })}\n`,
      "utf8",
    );

    try {
      const { results } = await runSuite(fixture);
      expect(results[0].passed).toBe(false);
      expect(results[0].failures).toContain(
        "unsupported expected field: conflict_detected",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
