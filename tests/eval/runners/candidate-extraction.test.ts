import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { HeuristicTypeExtractor } from "../../../packages/core/src/lifecycle/type-extractor.js";
import { loadExtensionSuite } from "./extension-loaders.js";
import { runCandidateExtractionSuite } from "./candidate-extraction.js";

const fixture = path.resolve(
  import.meta.dirname,
  "../goldens/mengshu-extraction.jsonl",
);
const tempDirs: string[] = [];

function writeFixture(cases: unknown[]): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mengshu-candidate-extraction-"));
  tempDirs.push(dir);
  const file = path.join(dir, "fixture.jsonl");
  writeFileSync(file, `${cases.map((item) => JSON.stringify(item)).join("\n")}\n`);
  return file;
}

function sourceTexts(goldenCase: ReturnType<typeof loadExtensionSuite<"mengshu-extraction">>["cases"][number]): string[] {
  return [
    ...(goldenCase.input.conversation ?? []).map((message) => message.text),
    ...(goldenCase.input.documentChunk ? [goldenCase.input.documentChunk.text] : []),
  ];
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("candidate-extraction-v1 honest component runner", () => {
  test("严格加载 100 case，并逐 source event 调用真实 candidate computation", async () => {
    const extract = vi.spyOn(HeuristicTypeExtractor.prototype, "extract");
    const loaded = loadExtensionSuite(fixture, "mengshu-extraction");
    const expectedInvocations = loaded.cases.reduce(
      (sum, goldenCase) => sum + sourceTexts(goldenCase).length,
      0,
    );

    const run = await runCandidateExtractionSuite(fixture);

    expect(run.suite).toBe("mengshu-extraction");
    expect(run.total).toBe(100);
    expect(run.results).toHaveLength(100);
    expect(new Set(run.results.map((result) => result.caseId)).size).toBe(100);
    expect(extract).toHaveBeenCalledTimes(expectedInvocations);
    expect(run.productionInvocations.computation).toBe(expectedInvocations);
    expect(run.productionInvocations.extractor).toBe(expectedInvocations);
  });

  test("production extractor 输入仅来自 conversation/documentChunk，不含 task/expected/notes", async () => {
    const extract = vi.spyOn(HeuristicTypeExtractor.prototype, "extract");
    const loaded = loadExtensionSuite(fixture, "mengshu-extraction");

    await runCandidateExtractionSuite(fixture);

    expect(extract.mock.calls.map(([input]) => input.text)).toEqual(
      loaded.cases.flatMap(sourceTexts),
    );
    expect(extract.mock.calls.every(([input]) => input.hints?.suggestedType === undefined))
      .toBe(true);
    expect(JSON.stringify(extract.mock.calls)).not.toContain("profile 提取：协作风格跨情境稳定性");
    expect(JSON.stringify(extract.mock.calls)).not.toContain("用户偏好先结论后细节，跳过寒暄");
  });

  test("修改 task/expected label 不会改变 production actual", async () => {
    const loaded = loadExtensionSuite(fixture, "mengshu-extraction");
    const relabeled = loaded.cases.map((goldenCase) => ({
      ...goldenCase,
      task: `adversarial-label-${goldenCase.id}`,
      expected: {
        candidates: [{
          type: "resource" as const,
          body: `label-only-${goldenCase.id}`,
          targetScope: "session" as const,
        }],
      },
      notes: "label-only-not-production-input",
    }));

    const baseline = await runCandidateExtractionSuite(fixture);
    const changed = await runCandidateExtractionSuite(writeFixture(relabeled));

    expect(changed.results.map((result) => result.actual))
      .toEqual(baseline.results.map((result) => result.actual));
    expect(changed.productionInvocations).toEqual(baseline.productionInvocations);
  });

  test("metrics 由真实 prediction 分子分母推导且方向/阈值固定", async () => {
    const run = await runCandidateExtractionSuite(fixture);
    const predicted = run.results.reduce(
      (sum, result) => sum + result.actual.candidates.length,
      0,
    );
    const typeCorrect = run.results.reduce(
      (sum, result) => sum + result.metricCounts.typeCorrect,
      0,
    );
    const extractionCorrect = run.results.reduce(
      (sum, result) => sum + result.metricCounts.extractionCorrect,
      0,
    );
    const negativeCases = run.results.filter((result) => result.expectedCandidateCount === 0);
    const overCaptured = negativeCases.filter(
      (result) => result.actual.candidates.length > 0,
    ).length;

    expect(run.metrics.find((metric) => metric.name === "type_precision")).toMatchObject({
      numerator: typeCorrect,
      denominator: predicted,
      direction: "min",
      threshold: 0.85,
    });
    expect(run.metrics.find((metric) => metric.name === "extraction_precision")).toMatchObject({
      numerator: extractionCorrect,
      denominator: predicted,
      direction: "min",
      threshold: 0.8,
    });
    expect(run.metrics.find((metric) => metric.name === "type_recall")).toMatchObject({
      numerator: typeCorrect,
      denominator: run.diagnostics.expectedCandidates,
      direction: "min",
      threshold: 0.8,
    });
    expect(run.metrics.find((metric) => metric.name === "extraction_recall")).toMatchObject({
      numerator: extractionCorrect,
      denominator: run.diagnostics.expectedCandidates,
      direction: "min",
      threshold: 0.8,
    });
    expect(run.metrics.find((metric) => metric.name === "over_capture")).toMatchObject({
      numerator: overCaptured,
      denominator: negativeCases.length,
      direction: "max",
      threshold: 0.1,
    });
    expect(run.diagnostics.expectedCandidates).toBe(86);
    expect(run.diagnostics.negativeCases).toBe(16);
  });

  test("negative cases 的 over-capture 可逐 case 追溯", async () => {
    const run = await runCandidateExtractionSuite(fixture);
    const negativeCases = run.results.filter((result) => result.expectedCandidateCount === 0);
    const capturedIds = negativeCases
      .filter((result) => result.actual.candidates.length > 0)
      .map((result) => result.caseId);

    expect(run.diagnostics.overCapturedCaseIds).toEqual(capturedIds);
    expect(run.metrics.find((metric) => metric.name === "over_capture")!.denominator)
      .toBe(16);
  });

  test("fixture 的丰富标注不伪装成生产 case contract failure", async () => {
    const run = await runCandidateExtractionSuite(fixture);

    expect(run.results.every((result) => result.unsupportedContracts.length === 0)).toBe(true);
    expect(run.results.every((result) => result.failures.length === 0)).toBe(true);
    expect(run.passed).toBe(100);
    expect(run.failed).toBe(0);
    expect(run.gateFailures).not.toContain(expect.stringMatching(/case_contract_failures/));
  });

  test("没有 prediction 时 precision 分母为 0 并 fail-closed", async () => {
    const loaded = loadExtensionSuite(fixture, "mengshu-extraction");
    const empty = loaded.cases.map((goldenCase) => ({
      ...goldenCase,
      input: { conversation: [{ role: "user" as const, text: "hello" }] },
      expected: { candidates: [], rejectedReason: "not_actionable" as const },
    }));

    const run = await runCandidateExtractionSuite(writeFixture(empty));
    for (const name of ["type_precision", "extraction_precision"]) {
      expect(run.metrics.find((metric) => metric.name === name)).toMatchObject({
        numerator: 0,
        denominator: 0,
        value: 0,
        passed: false,
      });
      expect(run.metrics.find((metric) => metric.name === name)!.failure)
        .toMatch(/denominator=0/);
    }
  });

  test("固定 clock/id 连续运行确定，且 execution 无 fallback/degraded", async () => {
    const first = await runCandidateExtractionSuite(fixture);
    const second = await runCandidateExtractionSuite(fixture);

    expect(second).toEqual(first);
    expect(first.execution).toEqual({
      runMode: "offline-component",
      provider: null,
      model: null,
      prompt: null,
      version: "candidate-extraction-v1",
      fallback: false,
      degraded: false,
    });
    expect(first.componentBoundary).toEqual({
      productionEntry: "computeCandidateSpecs",
      extractor: "HeuristicTypeExtractor",
      llm: "not_configured",
      sourceMapping: "one_computation_per_conversation_message_or_document_chunk",
      validator: "candidate-validator+admission-decision",
      rejectionOutput: "empty_specs",
    });
  });

  test("真实 production predictions 达到 gate，且逐 case mismatch 不替代聚合 metrics", async () => {
    const run = await runCandidateExtractionSuite(fixture);

    if (run.contractIssues.length > 0) {
      expect(run.gateFailures).toContain(`fixture_contract_issues:${run.contractIssues.length}`);
    }
    expect(run.failed).toBe(0);
    expect(run.gateFailures.some((failure) => failure.startsWith("case_contract_failures:")))
      .toBe(false);
    expect(run.metrics.map((metric) => [metric.name, metric.passed])).toEqual([
      ["type_precision", true],
      ["extraction_precision", true],
      ["type_recall", true],
      ["extraction_recall", true],
      ["over_capture", true],
    ]);
    expect(run.qualityGatePassed).toBe(true);
  });

  test("case 数不是 100 时拒绝运行", async () => {
    const loaded = loadExtensionSuite(fixture, "mengshu-extraction");
    await expect(runCandidateExtractionSuite(writeFixture(loaded.cases.slice(0, 99))))
      .rejects.toThrow(/expected 100 cases, got 99/);
  });
});
