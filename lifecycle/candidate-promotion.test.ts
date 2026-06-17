/**
 * candidate-promotion.ts 单元测试。
 *
 * 验证 candidateToMemoryRecord 把审核通过的候选正确转换为 active MemoryRecord：
 * - scope/text/semanticType/kind/confidence 正确映射
 * - lifecycleStatus 固定 active，container 为 personal
 * - contentHash 由文本派生（同文本幂等）
 * - 未知 kind 收敛为 other，evidence 保留可追溯
 */

import { describe, expect, test } from "vitest";
import { candidateToMemoryRecord } from "./candidate-promotion.js";
import type { CandidateRecord } from "./candidate-types.js";

const scope = {
  tenantId: "local",
  appId: "openclaw",
  userId: "u1",
  projectId: "p1",
  agentId: "default",
  namespace: "memories",
};

function candidate(overrides: Partial<CandidateRecord> = {}): CandidateRecord {
  return {
    id: "cand-1",
    scope,
    text: "复杂方案先给短结论",
    semanticType: "profile",
    kind: "preference",
    confidence: 0.85,
    evidenceIds: ["ev-1", "ev-2"],
    status: "pending",
    hitCount: 0,
    metadata: { source: "observe" },
    createdAt: 1000,
    ...overrides,
  };
}

describe("candidateToMemoryRecord", () => {
  test("映射核心字段并固定 active 状态", () => {
    const record = candidateToMemoryRecord(candidate(), 5000);
    expect(record.id).toBe("mem-cand-1");
    expect(record.scope).toEqual(scope);
    expect(record.text).toBe("复杂方案先给短结论");
    expect(record.semanticType).toBe("profile");
    expect(record.kind).toBe("preference");
    expect(record.confidence).toBe(0.85);
    expect(record.lifecycleStatus).toBe("active");
    expect(record.container).toBe("personal");
    expect(record.createdAt).toBe(5000);
  });

  test("contentHash 由文本派生，同文本幂等", () => {
    const a = candidateToMemoryRecord(candidate(), 1);
    const b = candidateToMemoryRecord(candidate({ id: "cand-2" }), 2);
    expect(a.contentHash).toBe(b.contentHash);
  });

  test("evidence 保留且记录原候选 id 可追溯", () => {
    const record = candidateToMemoryRecord(candidate());
    expect(record.sourceNodeIds).toEqual(["ev-1", "ev-2"]);
    expect(record.metadata.promotedFromCandidate).toBe("cand-1");
    expect(record.provenance.sourceId).toBe("cand-1");
  });

  test("未知 kind 收敛为 other", () => {
    const record = candidateToMemoryRecord(candidate({ kind: "weird-kind" }));
    expect(record.kind).toBe("other");
  });
});
