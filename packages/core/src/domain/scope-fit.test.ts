/**
 * scope-fit 单元测试。
 *
 * 覆盖：computeScopeFit 纯函数的逐级匹配契合度计算。
 * 设计理念：scope 只作为排序信号，不作为召回拦截；完全匹配最高分，
 * 逐级背离单调递减，完全不同仍保留中性偏低分（保证跨域可召回）。
 */

import { describe, expect, test } from "vitest";
import type { MemoryScope } from "./types.js";
import { computeScopeFit } from "./scope-fit.js";

function makeScope(overrides: Partial<MemoryScope> = {}): MemoryScope {
  return {
    tenantId: "t1",
    appId: "a1",
    userId: "u1",
    projectId: "p1",
    agentId: "ag1",
    namespace: "memories",
    ...overrides,
  };
}

describe("computeScopeFit", () => {
  test("returns 1.0 for fully matching scope (tenant+app+user+project+agent)", () => {
    expect(computeScopeFit(makeScope(), makeScope())).toBe(1.0);
  });

  test("returns high score for same project but different agent", () => {
    const query = makeScope();
    const record = makeScope({ agentId: "ag2" });
    const fit = computeScopeFit(query, record);
    expect(fit).toBeGreaterThanOrEqual(0.8);
    expect(fit).toBeLessThan(1.0);
  });

  test("returns mid score for same app but different project", () => {
    const query = makeScope();
    const record = makeScope({ projectId: "p2", agentId: "ag2" });
    const fit = computeScopeFit(query, record);
    expect(fit).toBeGreaterThan(0.2);
    expect(fit).toBeLessThan(0.8);
  });

  test("returns low score for same tenant but different app", () => {
    const query = makeScope();
    const record = makeScope({ appId: "a2", userId: "u2", projectId: "p2", agentId: "ag2" });
    const fit = computeScopeFit(query, record);
    expect(fit).toBeGreaterThan(0.2);
    expect(fit).toBeLessThan(0.5);
  });

  test("returns neutral-low score (~0.2) for completely different scope", () => {
    const query = makeScope();
    const record = makeScope({
      tenantId: "t2",
      appId: "a2",
      userId: "u2",
      projectId: "p2",
      agentId: "ag2",
    });
    const fit = computeScopeFit(query, record);
    // 跨域仍可召回：分数不为 0，约 0.2 中性偏低
    expect(fit).toBeGreaterThan(0);
    expect(fit).toBeLessThanOrEqual(0.25);
  });

  test("is monotonically non-decreasing as match depth increases", () => {
    const query = makeScope();
    const diffTenant = computeScopeFit(
      query,
      makeScope({ tenantId: "x", appId: "x", userId: "x", projectId: "x", agentId: "x" }),
    );
    const sameTenant = computeScopeFit(
      query,
      makeScope({ appId: "x", userId: "x", projectId: "x", agentId: "x" }),
    );
    const sameApp = computeScopeFit(
      query,
      makeScope({ userId: "x", projectId: "x", agentId: "x" }),
    );
    const sameUser = computeScopeFit(query, makeScope({ projectId: "x", agentId: "x" }));
    const sameProject = computeScopeFit(query, makeScope({ agentId: "x" }));
    const fullMatch = computeScopeFit(query, makeScope());

    expect(diffTenant).toBeLessThanOrEqual(sameTenant);
    expect(sameTenant).toBeLessThanOrEqual(sameApp);
    expect(sameApp).toBeLessThanOrEqual(sameUser);
    expect(sameUser).toBeLessThanOrEqual(sameProject);
    expect(sameProject).toBeLessThanOrEqual(fullMatch);
  });

  test("all results stay within [0,1]", () => {
    const query = makeScope();
    const record = makeScope({ tenantId: "z", agentId: "z" });
    const fit = computeScopeFit(query, record);
    expect(fit).toBeGreaterThanOrEqual(0);
    expect(fit).toBeLessThanOrEqual(1);
  });

  test("agent mismatch alone outranks app mismatch (relative ordering)", () => {
    const query = makeScope();
    const agentOnly = computeScopeFit(query, makeScope({ agentId: "other" }));
    const appDiff = computeScopeFit(query, makeScope({ appId: "other" }));
    expect(agentOnly).toBeGreaterThan(appDiff);
  });
});
