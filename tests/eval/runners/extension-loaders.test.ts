import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  loadExtensionSuite,
  type ExtensionSuiteName,
} from "./extension-loaders.js";

const goldensDir = path.resolve(import.meta.dirname, "../goldens");
const tempDirs: string[] = [];

const SUITES = [
  ["mengshu-extraction", 100],
  ["mengshu-dedup", 80],
  ["mengshu-recall-explain", 60],
  ["mengshu-conflict", 10],
  ["mengshu-tree-summary", 8],
  ["mengshu-skill-candidate", 8],
] as const satisfies ReadonlyArray<readonly [ExtensionSuiteName, number]>;

function fixturePath(suite: ExtensionSuiteName): string {
  return path.join(goldensDir, `${suite}.jsonl`);
}

function firstCase(suite: ExtensionSuiteName): Record<string, any> {
  const line = readFileSync(fixturePath(suite), "utf8")
    .split(/\r?\n/)
    .find((value) => value.trim().length > 0)!;
  return JSON.parse(line) as Record<string, any>;
}

function writeCases(cases: unknown[]): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mengshu-extension-loader-"));
  tempDirs.push(dir);
  const file = path.join(dir, "fixture.jsonl");
  writeFileSync(file, `${cases.map((value) => JSON.stringify(value)).join("\n")}\n`, "utf8");
  return file;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("extension golden 强类型加载", () => {
  test.each(SUITES)("%s 精确加载 %i 条", (suite, count) => {
    const loaded = loadExtensionSuite(fixturePath(suite), suite);

    expect(loaded.suite).toBe(suite);
    expect(loaded.cases).toHaveLength(count);
    expect(new Set(loaded.cases.map((item) => item.id)).size).toBe(count);
    expect(loaded.cases.every((item) => item.suite === suite)).toBe(true);
  });

  test("suite discriminator 保留 candidate-extraction 的结构类型", () => {
    const loaded = loadExtensionSuite(
      fixturePath("mengshu-extraction"),
      "mengshu-extraction",
    );

    expect(loaded.cases[0].input.conversation?.[0].role).toBe("user");
    expect(loaded.cases[0].expected.candidates[0].type).toBe("profile");
  });

  test("已修复 golden 无 contract issue，合成的旧矛盾仍以结构化 contractIssues 返回", () => {
    const recall = loadExtensionSuite(
      fixturePath("mengshu-recall-explain"),
      "mengshu-recall-explain",
    );
    const skill = loadExtensionSuite(
      fixturePath("mengshu-skill-candidate"),
      "mengshu-skill-candidate",
    );

    expect(recall.contractIssues).toEqual([]);
    expect(skill.contractIssues).toEqual([]);

    const ambiguousRecall = firstCase("mengshu-recall-explain");
    ambiguousRecall.expected.recalled[0].importance = {
      salience_llm: 0.85,
      sourceAuthority: 0.45,
      explicitnessBonus: 0,
      typePrior: 0.95,
    };
    delete ambiguousRecall.memories[0].salience_llm;
    const underspecifiedSkill = firstCase("mengshu-skill-candidate");
    underspecifiedSkill.experiences = underspecifiedSkill.experiences.slice(0, 4);
    delete underspecifiedSkill.experiences[0].createdAt;

    const legacyRecall = loadExtensionSuite(
      writeCases([ambiguousRecall]),
      "mengshu-recall-explain",
    );
    const legacySkill = loadExtensionSuite(
      writeCases([underspecifiedSkill]),
      "mengshu-skill-candidate",
    );

    expect(legacyRecall.contractIssues.map((issue) => issue.code)).toContain(
      "recall_breakdown_semantics_ambiguous",
    );
    expect(legacyRecall.contractIssues.map((issue) => issue.code)).toContain(
      "recall_breakdown_input_underspecified",
    );
    expect(legacySkill.contractIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "skill_generation_below_min_evidence",
          caseId: "skill-001",
        }),
        expect.objectContaining({
          code: "skill_observation_window_missing_timestamps",
          caseId: "skill-001",
        }),
      ]),
    );
  });
});

describe("extension loader fail-closed", () => {
  test("拒绝 unknown suite，错误包含 suite+line", () => {
    const value = firstCase("mengshu-extraction");
    value.suite = "unknown-suite";

    expect(() =>
      loadExtensionSuite(writeCases([value]), "mengshu-extraction"),
    ).toThrow(/suite=unknown-suite line=1/);
  });

  test("拒绝空 case id", () => {
    const value = firstCase("mengshu-conflict");
    value.id = "";

    expect(() =>
      loadExtensionSuite(writeCases([value]), "mengshu-conflict"),
    ).toThrow(/suite=mengshu-conflict line=1.*id/s);
  });

  test("拒绝重复 case id，并定位第二行", () => {
    const value = firstCase("mengshu-skill-candidate");

    expect(() =>
      loadExtensionSuite(writeCases([value, value]), "mengshu-skill-candidate"),
    ).toThrow(/suite=mengshu-skill-candidate line=2.*重复 case id/s);
  });

  test("拒绝缺失必填字段", () => {
    const value = firstCase("mengshu-tree-summary");
    delete value.expected;

    expect(() =>
      loadExtensionSuite(writeCases([value]), "mengshu-tree-summary"),
    ).toThrow(/suite=mengshu-tree-summary line=1.*expected/s);
  });

  test("拒绝非法 enum", () => {
    const value = firstCase("mengshu-dedup");
    value.expected.relation = "same-ish";

    expect(() =>
      loadExtensionSuite(writeCases([value]), "mengshu-dedup"),
    ).toThrow(/suite=mengshu-dedup line=1.*expected\.relation.*枚举/s);
  });

  test("拒绝越界数值", () => {
    const value = firstCase("mengshu-recall-explain");
    value.memories[0].salience_llm = 1.2;

    expect(() =>
      loadExtensionSuite(writeCases([value]), "mengshu-recall-explain"),
    ).toThrow(/suite=mengshu-recall-explain line=1.*salience_llm.*0.*1/s);
  });

  test.each([
    [
      "顶层",
      (value: Record<string, any>): void => {
        value.unversioned = true;
      },
      /顶层.*unversioned/,
    ],
    [
      "expected",
      (value: Record<string, any>): void => {
        value.expected.unversioned = true;
      },
      /expected.*unversioned/,
    ],
  ] as const)("拒绝额外%s字段", (_label, mutate, pattern) => {
    const value = firstCase("mengshu-extraction");
    mutate(value);

    expect(() =>
      loadExtensionSuite(writeCases([value]), "mengshu-extraction"),
    ).toThrow(pattern);
  });

  test("错误不回显输入正文", () => {
    const value = firstCase("mengshu-extraction");
    const sensitive = "SECRET-DO-NOT-ECHO-123456";
    value.input.conversation[0].text = sensitive;
    value.expected.candidates[0].type = "invalid-type";

    let message = "";
    try {
      loadExtensionSuite(writeCases([value]), "mengshu-extraction");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/suite=mengshu-extraction line=1/);
    expect(message).not.toContain(sensitive);
  });
});
