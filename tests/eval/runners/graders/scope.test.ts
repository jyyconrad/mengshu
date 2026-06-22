/**
 * scope grader 单元测试（P0-2）。
 *
 * 覆盖 scopeMatchGrader 的红绿路径：
 *   - skip：case 未开启 scopeValidation。
 *   - 绿：注入记忆 scope 与查询 scope 6 维全等 → passed。
 *   - 红：注入记忆 scope 某维度不同 → !passed + violation。
 *   - 边界：无注入记忆 → passed（无泄漏）。
 */

import { describe, expect, test } from "vitest";

import { scopeMatchGrader } from "./scope.js";
import type { GraderInput } from "./types.js";
import type { GoldenCase } from "../types.js";

function makeCase(overrides: Partial<GoldenCase>): GoldenCase {
  return {
    id: "case-scope",
    suite: "mengshu-v0.1",
    task: "test",
    scope: { tenantId: "t1", appId: "a1", userId: "u1", projectId: "p1" },
    seedMemories: [],
    query: "q",
    expected: {},
    ...overrides,
  };
}

function makeInput(gc: GoldenCase, injectedMemoryIds: string[]): GraderInput {
  return { goldenCase: gc, runtimeOutput: { injectedMemoryIds, content: "" } };
}

describe("scopeMatchGrader", () => {
  test("skip：未开启 scopeValidation", () => {
    const gc = makeCase({
      seedMemories: [{ id: "m1", kind: "fact", body: "x" }],
    });
    expect(scopeMatchGrader(makeInput(gc, ["m1"]))).toBe("skip");
  });

  test("绿：注入记忆 scope 与查询 scope 全等 → passed", () => {
    const gc = makeCase({
      scopeValidation: { enabled: true },
      seedMemories: [
        // seed 不带 scope，继承 case scope → 全等。
        { id: "m1", kind: "fact", body: "same scope" },
      ],
    });
    const result = scopeMatchGrader(makeInput(gc, ["m1"]));
    expect(result).not.toBe("skip");
    if (result === "skip") return;
    expect(result.passed).toBe(true);
    expect(result.value).toBe(0);
    expect(result.metric).toBe("scope_leak_rate");
  });

  test("红：注入记忆 projectId 不同 → !passed", () => {
    const gc = makeCase({
      scopeValidation: { enabled: true },
      seedMemories: [
        { id: "m1", kind: "fact", body: "cross project", scope: { projectId: "p-other" } },
      ],
    });
    const result = scopeMatchGrader(makeInput(gc, ["m1"]));
    expect(result).not.toBe("skip");
    if (result === "skip") return;
    expect(result.passed).toBe(false);
    expect(result.value).toBe(1);
    expect(result.violations?.[0]?.relatedId).toBe("m1");
    expect(result.violations?.[0]?.context).toContain("projectId");
  });

  test("边界：无注入记忆 → passed", () => {
    const gc = makeCase({
      scopeValidation: { enabled: true },
      seedMemories: [{ id: "m1", kind: "fact", body: "x" }],
    });
    const result = scopeMatchGrader(makeInput(gc, []));
    expect(result).not.toBe("skip");
    if (result === "skip") return;
    expect(result.passed).toBe(true);
  });
});
