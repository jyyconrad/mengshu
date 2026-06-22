/**
 * identifier grader 单元测试（P0-2）。
 *
 * 覆盖 forbiddenBodyPatternsGrader 的红绿路径：
 *   - 绿：被注入记忆 body 不含禁止模式 → passed。
 *   - 红：被注入记忆 body 命中禁止模式（room id 正则）→ !passed + violation。
 *   - skip：未配置 forbiddenBodyPatterns。
 *   - 边界：仅检查"被注入"的记忆，未注入的不计。
 */

import { describe, expect, test } from "vitest";

import { forbiddenBodyPatternsGrader } from "./identifier.js";
import type { GraderInput } from "./types.js";
import type { GoldenCase } from "../types.js";

function makeCase(overrides: Partial<GoldenCase>): GoldenCase {
  return {
    id: "case-identifier",
    suite: "mengshu-v0.1",
    task: "test",
    scope: {},
    seedMemories: [],
    query: "q",
    expected: {},
    ...overrides,
  };
}

function makeInput(
  gc: GoldenCase,
  injectedMemoryIds: string[],
  content = "",
): GraderInput {
  return { goldenCase: gc, runtimeOutput: { injectedMemoryIds, content } };
}

describe("forbiddenBodyPatternsGrader", () => {
  test("skip：未配置 forbiddenBodyPatterns", () => {
    const gc = makeCase({
      seedMemories: [{ id: "m1", kind: "fact", body: "hello" }],
    });
    expect(forbiddenBodyPatternsGrader(makeInput(gc, ["m1"]))).toBe("skip");
  });

  test("绿：注入记忆 body 不含禁止模式 → passed", () => {
    const gc = makeCase({
      seedMemories: [{ id: "m1", kind: "fact", body: "用户偏好深色主题" }],
      expected: { forbiddenBodyPatterns: ["![a-z0-9]+:matrix\\.org"] },
    });
    const result = forbiddenBodyPatternsGrader(makeInput(gc, ["m1"]));
    expect(result).not.toBe("skip");
    if (result === "skip") return;
    expect(result.passed).toBe(true);
    expect(result.value).toBe(0);
    expect(result.metric).toBe("identifier_leak_rate");
  });

  test("红：注入记忆 body 命中 matrix room id 模式 → !passed", () => {
    const gc = makeCase({
      seedMemories: [
        { id: "m1", kind: "fact", body: "会话发生在 !abc123:matrix.org 房间" },
      ],
      expected: { forbiddenBodyPatterns: ["![a-zA-Z0-9]+:matrix\\.org"] },
    });
    const result = forbiddenBodyPatternsGrader(makeInput(gc, ["m1"]));
    expect(result).not.toBe("skip");
    if (result === "skip") return;
    expect(result.passed).toBe(false);
    expect(result.value).toBeGreaterThan(0);
    expect(result.violations?.[0]?.relatedId).toBe("m1");
  });

  test("边界：未注入的记忆即使命中也不计违规", () => {
    const gc = makeCase({
      seedMemories: [
        { id: "m1", kind: "fact", body: "clean body" },
        { id: "m2", kind: "fact", body: "sessionId=sess-999 in body" },
      ],
      expected: { forbiddenBodyPatterns: ["sessionId=\\S+"] },
    });
    // 只注入 m1（干净），m2 未注入。
    const result = forbiddenBodyPatternsGrader(makeInput(gc, ["m1"]));
    expect(result).not.toBe("skip");
    if (result === "skip") return;
    expect(result.passed).toBe(true);
  });
});
