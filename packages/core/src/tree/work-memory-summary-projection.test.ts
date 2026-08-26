import { describe, expect, test } from "vitest";

import type { MemoryScope } from "../domain/types.js";
import type { TreeSummaryNode } from "./types.js";
import { buildWorkMemorySummaryProjection } from "./work-memory-summary-projection.js";

const scope: MemoryScope = Object.freeze({
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "mengshu",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "memory",
  visibility: "private",
  workspaceId: "workspace-a",
  sessionId: "session-a",
});

function summary(overrides: Partial<TreeSummaryNode> = {}): TreeSummaryNode {
  return {
    id: "sum_topic_1",
    scope,
    treeType: "topic",
    treeKey: "postgresql-migration",
    level: 1,
    title: "PostgreSQL migration",
    summary: "private summary body must not be copied into graph metadata",
    childNodeIds: [],
    leafIds: ["memory-2", "memory-1"],
    evidenceChunkIds: ["chunk-2", "chunk-1"],
    entityIds: ["entity-1"],
    relationIds: [],
    tokenCount: 12,
    timeRange: { startAt: 100, endAt: 200 },
    status: "sealed",
    createdAt: 200,
    sealedAt: 210,
    metadata: { summaryMode: "extractive", privateBody: "do-not-copy" },
    ...overrides,
  };
}

describe("buildWorkMemorySummaryProjection", () => {
  test("L1 summary 派生到 memory leaf，保留完整证据且不复制摘要正文", () => {
    const batch = buildWorkMemorySummaryProjection(summary());

    expect(batch.nodes).toEqual([{
      id: "summary:sum_topic_1",
      scope,
      nodeType: "summary",
      recordId: "sum_topic_1",
      label: "PostgreSQL migration",
      treeType: "topic",
      level: 1,
      evidenceChunkIds: ["chunk-2", "chunk-1"],
      metadata: { treeKey: "postgresql-migration", sealedAt: 210 },
      createdAt: 200,
    }]);
    expect(batch.edges.map((edge) => edge.targetId)).toEqual([
      "memory:memory-1",
      "memory:memory-2",
    ]);
    expect(batch.edges.every((edge) =>
      edge.sourceId === "summary:sum_topic_1" &&
      edge.predicate === "derives_from" &&
      edge.evidenceChunkIds.join(",") === "chunk-2,chunk-1" &&
      edge.createdAt === 210)).toBe(true);
    expect(JSON.stringify(batch)).not.toContain("private summary body");
    expect(JSON.stringify(batch)).not.toContain("do-not-copy");
  });

  test("L2/L3 summary 派生到 child summary，边 ID 对输入顺序稳定", () => {
    const first = buildWorkMemorySummaryProjection(summary({
      id: "sum_parent",
      level: 2,
      leafIds: ["memory-2", "memory-1"],
      childNodeIds: ["sum_child_b", "sum_child_a"],
    }));
    const reordered = buildWorkMemorySummaryProjection(summary({
      id: "sum_parent",
      level: 2,
      leafIds: ["memory-1", "memory-2"],
      childNodeIds: ["sum_child_a", "sum_child_b"],
    }));

    expect(first.edges.map((edge) => edge.targetId)).toEqual([
      "summary:sum_child_a",
      "summary:sum_child_b",
    ]);
    expect(first.edges.map((edge) => edge.id)).toEqual(reordered.edges.map((edge) => edge.id));
    expect(first.edges.every((edge) => /^derives-from:[0-9a-f]{64}$/.test(edge.id))).toBe(true);

    const level3 = buildWorkMemorySummaryProjection(summary({
      id: "sum_root",
      level: 3,
      childNodeIds: ["sum_parent"],
    }));
    expect(level3.edges[0]?.targetId).toBe("summary:sum_parent");
  });

  test("拒绝未 sealed、缺证据或缺派生端点的 summary", () => {
    expect(() => buildWorkMemorySummaryProjection(summary({ status: "open" })))
      .toThrow(/sealed/i);
    expect(() => buildWorkMemorySummaryProjection(summary({ evidenceChunkIds: [] })))
      .toThrow(/evidence/i);
    expect(() => buildWorkMemorySummaryProjection(summary({ leafIds: [] })))
      .toThrow(/endpoint/i);
    expect(() => buildWorkMemorySummaryProjection(summary({ level: 2, childNodeIds: [] })))
      .toThrow(/endpoint/i);
  });
});
