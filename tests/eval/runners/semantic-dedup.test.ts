import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { runSemanticDedupSuite } from "./semantic-dedup.js";

const fixture = path.resolve(
  import.meta.dirname,
  "../goldens/mengshu-dedup.jsonl",
);
const tempDirs: string[] = [];

function writeFixture(cases: unknown[]): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mengshu-semantic-dedup-"));
  tempDirs.push(dir);
  const file = path.join(dir, "fixture.jsonl");
  writeFileSync(file, `${cases.map((item) => JSON.stringify(item)).join("\n")}\n`);
  return file;
}

function syntheticCase(
  id: string,
  bodyA: string,
  bodyB: string,
  relation: "duplicate" | "distinct",
  memoryAExtra: Record<string, unknown> = {},
  memoryBExtra: Record<string, unknown> = {},
): unknown {
  return {
    id,
    suite: "mengshu-dedup",
    task: "coverage boundary",
    memoryA: { body: bodyA, type: "resource", ...memoryAExtra },
    memoryB: { body: bodyB, type: "resource", ...memoryBExtra },
    expected: {
      relation,
      ...(relation === "duplicate" ? { canonical: bodyA } : {}),
    },
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("semantic-dedup-v1 honest component runner", () => {
  test("严格加载并逐条运行全部 80 case", async () => {
    const run = await runSemanticDedupSuite(fixture);

    expect(run.suite).toBe("mengshu-dedup");
    expect(run.total).toBe(80);
    expect(run.results).toHaveLength(80);
    expect(new Set(run.results.map((result) => result.caseId)).size).toBe(80);
    expect(run.passed).toBe(80);
    expect(run.failed).toBe(0);
    expect(run.qualityGatePassed).toBe(true);
    expect(run.gateFailures).not.toContain(expect.stringMatching(/case_contract_failures/));
  });

  test("连续运行确定一致", async () => {
    const first = await runSemanticDedupSuite(fixture);
    const second = await runSemanticDedupSuite(fixture);

    expect(second).toEqual(first);
  });

  test("输出来自真实 SemanticDeduplicator，不生成五分类标签", async () => {
    const run = await runSemanticDedupSuite(fixture);
    const detected = run.results.filter((result) => result.actual.isDuplicate);

    expect(detected.length).toBeGreaterThan(0);
    expect(
      detected.every((result) =>
        ["high_value_duplicate", "low_salience_duplicate"].includes(
          result.actual.reason!,
        ),
      ),
    ).toBe(true);
    expect(
      detected.every((result) => result.actual.threshold !== undefined),
    ).toBe(true);
  });

  test("duplicate_precision 分母是实际预测 duplicate，false_merge 分母是全部非 duplicate golden", async () => {
    const run = await runSemanticDedupSuite(fixture);
    const precision = run.metrics.find(
      (metric) => metric.name === "duplicate_precision",
    )!;
    const falseMerge = run.metrics.find(
      (metric) => metric.name === "false_merge",
    )!;
    const predictedDuplicates = run.results.filter(
      (result) => result.actual.isDuplicate,
    );
    const goldenNonDuplicates = run.results.filter(
      (result) => !result.expectedDuplicate,
    );

    expect(precision).toMatchObject({
      numerator: predictedDuplicates.filter((result) => result.expectedDuplicate)
        .length,
      denominator: predictedDuplicates.length,
      direction: "min",
      threshold: 0.9,
    });
    expect(falseMerge).toMatchObject({
      numerator: goldenNonDuplicates.filter(
        (result) => result.actual.isDuplicate,
      ).length,
      denominator: goldenNonDuplicates.length,
      direction: "max",
      threshold: 0.03,
    });
    expect(goldenNonDuplicates).toHaveLength(50);
    expect(run.diagnostics.binaryDuplicateRecall).toEqual({
      numerator: run.results.filter(
        (result) => result.expectedDuplicate && result.actual.isDuplicate,
      ).length,
      denominator: 30,
      value:
        run.results.filter(
          (result) => result.expectedDuplicate && result.actual.isDuplicate,
        ).length / 30,
    });
  });

  test("5 条 distinct 均不被误合并", async () => {
    const run = await runSemanticDedupSuite(fixture);
    const distinct = run.results.filter(
      (result) => result.expectedRelation === "distinct",
    );

    expect(distinct).toHaveLength(5);
    expect(distinct.every((result) => !result.actual.isDuplicate)).toBe(true);
  });

  test.each([
    ["dd-001", "duplicate", true],
    ["dd-031", "update", false],
    ["dd-041", "conflict", false],
    ["dd-061", "related", false],
    ["dd-076", "distinct", false],
  ] as const)("%s 的 %s 语义投影为真实 binary duplicate=%s", async (
    caseId,
    relation,
    expectedDuplicate,
  ) => {
    const run = await runSemanticDedupSuite(fixture);
    const result = run.results.find((item) => item.caseId === caseId)!;

    expect(result.expectedRelation).toBe(relation);
    expect(result.expectedDuplicate).toBe(expectedDuplicate);
    expect(result.passed).toBe(true);
    expect(result.unsupportedContracts).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  test("execution 记录离线文本 embedding 边界且无 fallback/degraded", async () => {
    const run = await runSemanticDedupSuite(fixture);

    expect(run.execution).toEqual({
      runMode: "offline-component",
      provider: "deterministic-hashed-char-ngram",
      model: "char-ngram-v1",
      prompt: null,
      version: "semantic-dedup-v1",
      fallback: false,
      degraded: false,
    });
    expect(run.componentBoundary).toMatchObject({
      fixedSalience: 0.5,
      salienceBranchesCovered: ["low_salience"],
      salienceBranchesNotCovered: ["high_value"],
    });
  });

  test("memoryA 非法字段由 loader fail-closed，memoryB context 仅为 fixture 注释不制造 contract failure", async () => {
    await expect(runSemanticDedupSuite(writeFixture([
      syntheticCase("context-a", "alpha", "beta", "distinct", { context: "ctx-a" }),
    ]))).rejects.toThrow(/memoryA.*context|额外字段/i);

    const run = await runSemanticDedupSuite(writeFixture([
      syntheticCase("context-b", "gamma", "delta", "distinct", {}, { context: "ctx-b" }),
    ]));
    expect(run.results[0]).toMatchObject({
      passed: true,
      unsupportedContracts: [],
      failures: [],
    });
  });

  test("纯标点与单字符也走固定文本向量边界", async () => {
    const punctuation = await runSemanticDedupSuite(
      writeFixture([syntheticCase("edge-empty", "!!!", "???", "duplicate")]),
    );
    const singleCharacter = await runSemanticDedupSuite(
      writeFixture([syntheticCase("edge-short", "A", "A", "duplicate")]),
    );

    expect(punctuation.results[0].actual.isDuplicate).toBe(true);
    expect(singleCharacter.results[0].actual.isDuplicate).toBe(true);
  });

  test("无任何 duplicate 预测时 precision denominator=0 并 fail-closed", async () => {
    const run = await runSemanticDedupSuite(
      writeFixture([
        syntheticCase("edge-no-prediction", "A", "完全不同的长文本", "distinct"),
      ]),
    );
    const precision = run.metrics.find(
      (metric) => metric.name === "duplicate_precision",
    )!;

    expect(precision.denominator).toBe(0);
    expect(precision.passed).toBe(false);
    expect(run.gateFailures.join("\n")).toMatch(/denominator=0/);
  });
});
