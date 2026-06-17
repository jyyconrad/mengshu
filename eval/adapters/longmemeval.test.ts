/**
 * eval/adapters/longmemeval.test.ts
 *
 * 本文件做什么：
 *   验证 LongMemEval adapter 能加载示例 fixture 并正确转换：
 *   - cases 数量与 fixture 一致；
 *   - seedMemories 来自所有 session 的全部 message；
 *   - query 来自 question 字段；
 *   - answerMustContain 包含 answer 的关键字；
 *   - suite 名称按 options 覆写。
 *
 * 关键边界：
 *   - 仅是 schema 转换测试，不依赖任何外部 benchmark。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { loadLongMemEval, rawToGoldenCase } from "./longmemeval.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixtureFile = path.resolve(
  __dirname,
  "../fixtures/longmemeval-mini.json",
);

describe("longmemeval adapter", () => {
  test("加载 mini fixture 转换为 2 条 GoldenCase", () => {
    const cases = loadLongMemEval(fixtureFile);
    expect(cases).toHaveLength(2);
    expect(cases[0].id).toBe("lme-sample-001");
    expect(cases[0].suite).toBe("longmemeval-imported");
  });

  test("seedMemories 包含所有 session 的所有 message", () => {
    const cases = loadLongMemEval(fixtureFile);
    // sample 1: 2 sessions, 2 + 1 messages = 3
    expect(cases[0].seedMemories).toHaveLength(3);
    // sample 2: 1 session, 1 message
    expect(cases[1].seedMemories).toHaveLength(1);
  });

  test("query 来自 question，answerMustContain 是 answer 的关键字", () => {
    const cases = loadLongMemEval(fixtureFile);
    expect(cases[0].query).toBe("用户上次提到他们偏好的编程语言是什么？");
    // answer "用户偏好 TypeScript 严格模式" 至少包含 "TypeScript"
    expect(cases[0].expected.answerMustContain?.length ?? 0).toBeGreaterThan(0);
  });

  test("options.suite 可覆盖默认 suite 名", () => {
    const cases = loadLongMemEval(fixtureFile, {
      suite: "lme-v1-small",
      limit: 1,
    });
    expect(cases).toHaveLength(1);
    expect(cases[0].suite).toBe("lme-v1-small");
  });

  test("rawToGoldenCase 容错处理：缺失字段也不抛错", () => {
    const gc = rawToGoldenCase({
      question_id: "robust-001",
      // question / sessions 都缺失
    });
    expect(gc.id).toBe("robust-001");
    expect(gc.query).toBe("");
    expect(gc.seedMemories).toEqual([]);
  });
});
