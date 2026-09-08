import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  assertRegisteredRunners,
  loadEvalManifest,
  selectEvalSuites,
} from "./eval-manifest.js";

const goldensDir = path.resolve(import.meta.dirname, "../goldens");
const manifestPath = path.join(goldensDir, "manifest.json");
const tempDirs: string[] = [];

function writeManifest(value: unknown): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mengshu-eval-manifest-"));
  tempDirs.push(dir);
  const file = path.join(dir, "manifest.json");
  writeFileSync(file, JSON.stringify(value), "utf8");
  return file;
}

function writeValidFixtureManifest(
  suiteOverrides: Record<string, unknown> = {},
): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mengshu-eval-manifest-suite-"));
  tempDirs.push(dir);
  const content = '{"id":"case-1"}\n';
  writeFileSync(path.join(dir, "suite.jsonl"), content, "utf8");
  const file = path.join(dir, "manifest.json");
  writeFileSync(file, JSON.stringify({
    schemaVersion: 2,
    version: "test-v1",
    suites: {
      suite: {
        track: "quality",
        datasetVersion: "q-test-v1",
        kind: "extension",
        runner: "test-runner-v1",
        file: "suite.jsonl",
        caseCount: 1,
        bytes: Buffer.byteLength(content),
        sha256: createHash("sha256").update(content).digest("hex"),
        metrics: ["type_precision"],
        gate: { type_precision: 0.85 },
        ...suiteOverrides,
      },
    },
  }), "utf8");
  return file;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("eval manifest", () => {
  test("当前 manifest 明确登记 2 套 baseline 与 10 套 extension", () => {
    const manifest = loadEvalManifest(manifestPath);
    const suites = Object.values(manifest.suites);

    expect(suites).toHaveLength(12);
    expect(suites.filter((suite) => suite.kind === "baseline")).toHaveLength(2);
    expect(suites.filter((suite) => suite.kind === "extension")).toHaveLength(10);
    expect(suites.every((suite) => suite.track === "quality")).toBe(true);
    expect(suites.every((suite) => suite.datasetVersion.length > 0)).toBe(true);
  });

  test.each([
    ["track 缺失", { track: undefined }],
    ["track 非法", { track: "effect" }],
    ["datasetVersion 缺失", { datasetVersion: undefined }],
    ["datasetVersion 空白", { datasetVersion: " " }],
  ])("suite %s时 fail-closed", (_label, overrides) => {
    expect(() => loadEvalManifest(writeValidFixtureManifest(overrides)))
      .toThrow(/track|datasetVersion/i);
  });

  test("all 完全由 manifest 展开，不允许硬编码漏跑", () => {
    const manifest = loadEvalManifest(manifestPath);

    expect(selectEvalSuites(manifest, "all").map((suite) => suite.name)).toEqual(
      Object.keys(manifest.suites),
    );
  });

  test("未知 suite 立即失败", () => {
    const manifest = loadEvalManifest(manifestPath);

    expect(() => selectEvalSuites(manifest, "mengshu-unknown")).toThrow(
      /未登记.*mengshu-unknown/,
    );
  });

  test("manifest schema 缺 runner 时立即失败", () => {
    const invalidPath = writeManifest({
      schemaVersion: 2,
      suites: {
        "broken-suite": {
          track: "quality",
          datasetVersion: "q-test-v1",
          kind: "extension",
          file: "broken.jsonl",
        },
      },
    });

    expect(() => loadEvalManifest(invalidPath)).toThrow(/runner/);
  });

  test("选择到未实现 runner 时列出全部缺口并失败", () => {
    const manifest = loadEvalManifest(manifestPath);
    const selected = selectEvalSuites(manifest, "all");

    expect(() =>
      assertRegisteredRunners(selected, new Set(["slot-context-v1"])),
    ).toThrow(/未实现 runner.*candidate-extraction-v1.*semantic-dedup-v1/s);
  });

  test("fixture bytes、caseCount 或 sha256 漂移时立即失败", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mengshu-eval-integrity-"));
    tempDirs.push(dir);
    writeFileSync(path.join(dir, "suite.jsonl"), '{"id":"case-1"}\n', "utf8");
    const file = path.join(dir, "manifest.json");
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 2,
        suites: {
          suite: {
            track: "quality",
            datasetVersion: "q-test-v1",
            kind: "baseline",
            runner: "slot-context-v1",
            file: "suite.jsonl",
            caseCount: 1,
            bytes: 16,
            sha256: "0".repeat(64),
            metrics: ["slot_recall"],
          },
        },
      }),
      "utf8",
    );

    expect(() => loadEvalManifest(file)).toThrow(/bytes 不匹配|sha256 不匹配/);
  });

  test.each([
    ["缺失", undefined],
    ["空数组", []],
    ["非数组", "type_precision"],
    ["重复", ["type_precision", "type_precision"]],
    ["未知", ["unknown_metric"]],
  ])("manifest metrics %s时 fail-closed", (_label, metrics) => {
    const file = writeValidFixtureManifest({ metrics });
    expect(() => loadEvalManifest(file)).toThrow(/metrics|metric/i);
  });

  test.each([
    ["缺失", undefined],
    ["非对象", "bad"],
    ["缺 metric", {}],
    ["多余 key", { type_precision: 0.85, extra: 1 }],
    ["非有限/非法值", { type_precision: null }],
  ])("extension gate %s时 fail-closed", (_label, gate) => {
    const file = writeValidFixtureManifest({ gate });
    expect(() => loadEvalManifest(file)).toThrow(/gate|threshold|metric/i);
  });

  test("suite plan 投影 manifest schema/version 与 fixture identity", () => {
    const manifest = loadEvalManifest(manifestPath);
    const plan = selectEvalSuites(manifest, "mengshu-v0.1", manifestPath)[0];

    expect(plan).toMatchObject({
      manifestSchemaVersion: 2,
      manifestVersion: "v0.5-eval-tracks",
      track: "quality",
      datasetVersion: "q-contract-v1",
      runner: "slot-context-v1",
      caseCount: 30,
      sha256: "082bd7165c76ab17639cabf00d10ca7280d8bc0696d4717eb03b96e9027278dc",
    });
  });
});
