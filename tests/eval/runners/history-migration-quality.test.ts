import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  evaluateHistoryMigrationQuality,
  loadHistoryMigrationQualityDataset,
  runHistoryMigrationQualityCli,
  type HistoryMigrationQualityDataset,
} from "./history-migration-quality.js";

const fixturePath = path.resolve(
  import.meta.dirname,
  "../fixtures/history-migration-quality-v1.jsonl",
);
const scopeA = `sha256:${"a".repeat(64)}`;
const scopeB = `sha256:${"b".repeat(64)}`;
const tempDirs: string[] = [];

function tempFile(lines: readonly unknown[]): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mengshu-history-quality-"));
  tempDirs.push(dir);
  const file = path.join(dir, "quality.jsonl");
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return file;
}

function fixtureLines(): Array<Record<string, any>> {
  return readFileSync(fixturePath, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as Record<string, any>);
}

function clonedDataset(): HistoryMigrationQualityDataset {
  return structuredClone(loadHistoryMigrationQualityDataset(fixturePath));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("history migration quality dataset", () => {
  test("合成脱敏 fixture 覆盖全部强制 strata 并通过确定性 gate", () => {
    const dataset = loadHistoryMigrationQualityDataset(fixturePath);
    const report = evaluateHistoryMigrationQuality(dataset);

    expect(report.coverage.missing).toEqual([]);
    expect(report.coverage.present).toEqual([
      "semantic:profile",
      "semantic:rules",
      "semantic:experience",
      "semantic:resource",
      "semantic:task_context",
      "disposition:lookup_only",
      "disposition:legacy_quarantine",
      "disposition:new_quarantine",
      "scenario:conflict",
      "scenario:cross_scope",
    ]);
    expect(report.metrics.classification.macroPrecision).toBe(1);
    expect(report.metrics.classification.macroRecall).toBe(1);
    expect(report.metrics.disposition.accuracy).toBe(1);
    expect(report.metrics.topic).toMatchObject({
      precision: 1,
      recall: 1,
      exactMatchRate: 1,
    });
    expect(report.metrics.conflict.accuracy).toBe(1);
    expect(report.metrics.injection).toMatchObject({
      wrong: 0,
      forbiddenOpportunities: 8,
      wrongInjectionRate: 0,
    });
    expect(report.passed).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.evidenceBoundary).toEqual({
      sampleSource: "synthetic",
      realSampleEvaluated: false,
      defectVerificationEligible: false,
      claim: "implementation_verified_with_synthetic_fixture_only",
    });
  });

  test("分类、topic、冲突和跨 scope 错注入均追溯到样本版本", () => {
    const dataset = clonedDataset();
    const sample = dataset.samples.find(
      (item) => item.sampleId === "rules-conflict-cross-scope-001",
    )!;
    sample.actual.semanticType = "experience";
    sample.actual.topics = ["wrong-topic"];
    sample.actual.conflict = "absent";
    sample.actual.injectedScopeIds = [scopeA, scopeB];

    const report = evaluateHistoryMigrationQuality(dataset);

    expect(report.passed).toBe(false);
    expect(report.metrics.injection.wrongInjectionRate).toBe(1 / 8);
    expect(report.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "semantic_type_mismatch",
        "topic_false_positive",
        "topic_false_negative",
        "conflict_mismatch",
        "wrong_scope_injection",
      ]),
    );
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sampleId: "rules-conflict-cross-scope-001",
          trace: {
            policyVersion: "history-policy-v3",
            promptVersion: "history-prompt-v2",
            taxonomyVersion: "history-taxonomy-v5",
          },
        }),
      ]),
    );
    expect(report.failuresByVersion).toEqual([
      expect.objectContaining({
        policyVersion: "history-policy-v3",
        promptVersion: "history-prompt-v2",
        taxonomyVersion: "history-taxonomy-v5",
        sampleIds: ["rules-conflict-cross-scope-001"],
      }),
    ]);
  });

  test("route 错误和漏注入不会被五类准确率掩盖", () => {
    const dataset = clonedDataset();
    const sample = dataset.samples.find((item) => item.sampleId === "lookup-only-001")!;
    sample.actual.disposition = "context";
    sample.actual.injectedScopeIds = [scopeA];

    const report = evaluateHistoryMigrationQuality(dataset);

    expect(report.metrics.classification.macroPrecision).toBe(1);
    expect(report.metrics.disposition.accuracy).toBeLessThan(1);
    expect(report.metrics.injection.wrongInjectionRate).toBeGreaterThan(0);
    expect(report.gateFailures.map((failure) => failure.metric)).toEqual(
      expect.arrayContaining(["dispositionAccuracy", "wrongInjectionRate"]),
    );
  });
});

describe("history migration quality contract fail-closed", () => {
  test("缺任一强制 strata 时拒绝评测", () => {
    const lines = fixtureLines().filter(
      (line) => line.sampleId !== "new-quarantine-001",
    );

    expect(() => loadHistoryMigrationQualityDataset(tempFile(lines))).toThrow(
      /缺少强制覆盖.*disposition:new_quarantine/,
    );
  });

  test("manifest 未确认脱敏时拒绝读取", () => {
    const lines = fixtureLines();
    lines[0].redaction.status = "unreviewed";

    expect(() => loadHistoryMigrationQualityDataset(tempFile(lines))).toThrow(
      /redaction\.status.*verified/,
    );
  });

  test("拒绝正文和未知字段且错误不回显内容", () => {
    const lines = fixtureLines();
    const secret = "SECRET-SOURCE-TEXT-DO-NOT-ECHO";
    lines[1].body = secret;
    let message = "";

    try {
      loadHistoryMigrationQualityDataset(tempFile(lines));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/line=2.*未知字段.*body/);
    expect(message).not.toContain(secret);
  });

  test("缺失版本回执时拒绝评测", () => {
    const lines = fixtureLines();
    lines[2].trace.taxonomyVersion = "";

    expect(() => loadHistoryMigrationQualityDataset(tempFile(lines))).toThrow(
      /line=3.*trace\.taxonomyVersion/,
    );
  });

  test("拒绝可识别的明文 scopeId", () => {
    const lines = fixtureLines();
    lines[1].scopeProbe.originScopeId = "tenant-user-project-a";
    lines[1].scopeProbe.evaluatedScopeIds[0] = "tenant-user-project-a";
    lines[1].expected.allowedInjectionScopeIds[0] = "tenant-user-project-a";
    lines[1].actual.injectedScopeIds[0] = "tenant-user-project-a";

    expect(() => loadHistoryMigrationQualityDataset(tempFile(lines))).toThrow(
      /line=2.*scopeProbe\.originScopeId.*sha256/,
    );
  });

  test.each([
    ["datasetId", 0, "datasetId", "../../private/history.jsonl"],
    ["sampleId", 1, "sampleId", "tenant a/session 1"],
  ] as const)("拒绝路径或空白型 %s", (_label, lineIndex, field, value) => {
    const lines = fixtureLines();
    lines[lineIndex][field] = value;

    expect(() => loadHistoryMigrationQualityDataset(tempFile(lines))).toThrow(
      new RegExp(`${field}.*安全标识`),
    );
  });

  test("cross_scope 必须实际探测至少一个外部 scope", () => {
    const lines = fixtureLines();
    lines[2].scopeProbe.evaluatedScopeIds = [scopeA];

    expect(() => loadHistoryMigrationQualityDataset(tempFile(lines))).toThrow(
      /line=3.*cross_scope.*外部 scope/,
    );
  });
});

describe("history migration quality CLI", () => {
  test("写出机器可读报告，并明确 synthetic 不能验收真实缺陷", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mengshu-history-quality-cli-"));
    tempDirs.push(dir);
    const out = path.join(dir, "report.json");
    const output: string[] = [];

    const exitCode = runHistoryMigrationQualityCli(
      ["--input", fixturePath, "--out", out],
      { writeLine: (line) => output.push(line) },
    );
    const report = JSON.parse(readFileSync(out, "utf8")) as Record<string, any>;

    expect(exitCode).toBe(0);
    expect(report.passed).toBe(true);
    expect(report.evidenceBoundary.defectVerificationEligible).toBe(false);
    expect(output.join("\n")).toMatch(/synthetic.*不能据此宣称 MG-013 verified/i);
  });
});
