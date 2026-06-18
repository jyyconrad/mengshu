/**
 * recall-filter 单元测试。
 *
 * 覆盖三类 filteredReason：scope_mismatch / salience_below_threshold / dedup_merged，
 * 以及过滤开关、过滤顺序、纯函数（不修改入参）等边界。
 */

import { describe, expect, test } from "vitest";
import type { MemoryRecord, MemoryScope } from "../../../../core/types.js";
import {
  filterRecallRecords,
  DEFAULT_SALIENCE_THRESHOLD,
} from "./recall-filter.js";

const requestScope: MemoryScope = {
  tenantId: "t",
  appId: "a",
  userId: "u",
  workspaceId: "w",
  projectId: "p",
  agentId: "ag",
  namespace: "memories",
};

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: overrides.id ?? "rec",
    scope: overrides.scope ?? requestScope,
    kind: overrides.kind ?? "fact",
    semanticType: overrides.semanticType ?? "experience",
    text: overrides.text ?? "demo",
    contentHash: overrides.contentHash ?? "hash-default",
    importance: overrides.importance ?? 0.8,
    category: "core",
    dataType: "memory",
    metadata: {},
    provenance: { source: "user" },
    createdAt: 0,
    ...overrides,
  };
}

describe("filterRecallRecords - scope_mismatch", () => {
  test("剔除跨 project 的 project 级记忆并记录 scope_mismatch", () => {
    const inScope = makeRecord({ id: "in", semanticType: "task_context" });
    const otherProject = makeRecord({
      id: "out",
      semanticType: "task_context",
      scope: { ...requestScope, projectId: "other" },
    });

    const { kept, filtered } = filterRecallRecords(
      [inScope, otherProject],
      requestScope,
    );

    expect(kept.map((r) => r.id)).toEqual(["in"]);
    expect(filtered).toContainEqual({
      recordId: "out",
      reason: "scope_mismatch",
      semanticType: "task_context",
    });
  });

  test("workspace 级语义类型允许跨 project 复用", () => {
    const crossProject = makeRecord({
      id: "profile-cross",
      semanticType: "profile",
      scope: { ...requestScope, projectId: "other" },
    });

    const { kept, filtered } = filterRecallRecords([crossProject], requestScope);

    expect(kept.map((r) => r.id)).toEqual(["profile-cross"]);
    expect(filtered).toHaveLength(0);
  });
});

describe("filterRecallRecords - salience_below_threshold", () => {
  test("importance 低于阈值的记忆被剔除并记录原因", () => {
    const low = makeRecord({ id: "low", importance: 0.2 });
    const high = makeRecord({ id: "high", importance: 0.9, contentHash: "h-high" });

    const { kept, filtered } = filterRecallRecords([low, high], requestScope);

    expect(kept.map((r) => r.id)).toEqual(["high"]);
    expect(filtered).toContainEqual({
      recordId: "low",
      reason: "salience_below_threshold",
      semanticType: "experience",
    });
  });

  test("恰好等于阈值的记忆保留（>= 阈值通过）", () => {
    const atThreshold = makeRecord({
      id: "at",
      importance: DEFAULT_SALIENCE_THRESHOLD,
    });

    const { kept, filtered } = filterRecallRecords([atThreshold], requestScope);

    expect(kept.map((r) => r.id)).toEqual(["at"]);
    expect(filtered).toHaveLength(0);
  });

  test("自定义阈值生效", () => {
    const record = makeRecord({ id: "r", importance: 0.6 });

    const { kept, filtered } = filterRecallRecords([record], requestScope, {
      salienceThreshold: 0.7,
    });

    expect(kept).toHaveLength(0);
    expect(filtered[0]?.reason).toBe("salience_below_threshold");
  });
});

describe("filterRecallRecords - dedup_merged", () => {
  test("相同 contentHash 仅保留综合分最高的一条", () => {
    const weak = makeRecord({ id: "weak", contentHash: "dup", importance: 0.5 });
    const strong = makeRecord({ id: "strong", contentHash: "dup", importance: 0.95 });

    const { kept, filtered } = filterRecallRecords([weak, strong], requestScope);

    expect(kept.map((r) => r.id)).toEqual(["strong"]);
    expect(filtered).toContainEqual({
      recordId: "weak",
      reason: "dedup_merged",
      semanticType: "experience",
    });
  });

  test("contentHash 缺失时按归一化文本去重", () => {
    const a = makeRecord({ id: "a", contentHash: "", text: "Same Text", importance: 0.6 });
    const b = makeRecord({ id: "b", contentHash: "", text: "same text", importance: 0.9 });

    const { kept, filtered } = filterRecallRecords([a, b], requestScope);

    expect(kept.map((r) => r.id)).toEqual(["b"]);
    expect(filtered[0]).toMatchObject({ recordId: "a", reason: "dedup_merged" });
  });

  test("不同内容不被去重", () => {
    const a = makeRecord({ id: "a", contentHash: "h-a" });
    const b = makeRecord({ id: "b", contentHash: "h-b" });

    const { kept, filtered } = filterRecallRecords([a, b], requestScope);

    expect(kept).toHaveLength(2);
    expect(filtered).toHaveLength(0);
  });
});

describe("filterRecallRecords - 开关与边界", () => {
  test("禁用各过滤器时全部保留", () => {
    const lowDup = makeRecord({
      id: "x",
      importance: 0.1,
      contentHash: "dup",
      scope: { ...requestScope, projectId: "other" },
      semanticType: "task_context",
    });
    const dup = makeRecord({ id: "y", importance: 0.1, contentHash: "dup" });

    const { kept, filtered } = filterRecallRecords([lowDup, dup], requestScope, {
      enableScopeFilter: false,
      enableSalienceFilter: false,
      enableDedup: false,
    });

    expect(kept).toHaveLength(2);
    expect(filtered).toHaveLength(0);
  });

  test("不修改入参数组", () => {
    const records = [
      makeRecord({ id: "a", importance: 0.1 }),
      makeRecord({ id: "b", importance: 0.9, contentHash: "h-b" }),
    ];
    const snapshot = [...records];

    filterRecallRecords(records, requestScope);

    expect(records).toEqual(snapshot);
  });

  test("空输入返回空结果", () => {
    const { kept, filtered } = filterRecallRecords([], requestScope);
    expect(kept).toHaveLength(0);
    expect(filtered).toHaveLength(0);
  });
});
