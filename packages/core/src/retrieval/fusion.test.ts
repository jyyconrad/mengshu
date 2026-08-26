import { describe, expect, test } from "vitest";
import type { MemoryRecord, RecallHit } from "../domain/types.js";
import { isRecallScoreBreakdown } from "../domain/recall-scoring.js";
import { fuseHits } from "./fusion.js";

const scope = {
  tenantId: "local",
  appId: "openclaw",
  userId: "user-1",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "memories",
};

function hit(id: string, score: number, source: RecallHit["source"]): RecallHit {
  const record: MemoryRecord = {
    id,
    scope,
    kind: "fact",
    text: id,
    contentHash: `hash-${id}`,
    importance: 0.5,
    category: "fact",
    dataType: "memory",
    tableName: "memories",
    metadata: {},
    provenance: { source: "user" },
    createdAt: 1710000000000,
  };
  return {
    record,
    score,
    source,
    scoreBreakdown: { [source]: score },
  };
}

describe("fuseHits", () => {
  test("dedupes records and keeps score breakdown by source", () => {
    const results = fuseHits([
      { source: "vector", hits: [hit("same", 0.9, "vector"), hit("vector-only", 0.8, "vector")] },
      { source: "text", hits: [hit("same", 2.1, "text"), hit("text-only", 1.5, "text")] },
    ]);

    expect(results.map((result) => result.record.id)).toEqual(["same", "vector-only", "text-only"]);
    expect(results[0].scoreBreakdown).toMatchObject({
      score: results[0].score,
      matchedBy: ["vector", "text"],
      sourceSignals: { vector: 0.9, text: 2.1, rrf: expect.any(Number) },
      factors: {
        relevance: 1,
        scopeFit: 1,
        importance: 0.5,
      },
    });
    expect(results.every((result) => isRecallScoreBreakdown(result.scoreBreakdown))).toBe(true);
  });

  test("无法可靠生成完整六因子的 chunk/tree hit 必须 fail-closed", () => {
    const memory = hit("memory", 0.8, "vector");
    const chunk: RecallHit = {
      record: {
        id: "chunk",
        scope: memory.record.scope,
        documentId: "doc",
        text: "raw evidence",
        contentHash: "chunk-hash",
        ordinal: 0,
        metadata: {},
        provenance: { source: "document" },
        createdAt: 1,
      },
      score: 1,
      source: "vector",
    };
    const tree: RecallHit = {
      record: {
        id: "tree",
        scope: memory.record.scope,
        treeType: "topic",
        level: 2,
        summary: "derived summary",
        childIds: [],
        evidenceIds: [],
        createdAt: 1,
      },
      score: 1,
      source: "tree",
    };

    expect(fuseHits([{ source: "vector", hits: [chunk, memory] }, { source: "tree", hits: [tree] }]))
      .toEqual([expect.objectContaining({ record: expect.objectContaining({ id: "memory" }) })]);
  });

  test("respects result limit after fusion", () => {
    const results = fuseHits([
      { source: "vector", hits: [hit("a", 0.9, "vector"), hit("b", 0.8, "vector")] },
      { source: "text", hits: [hit("c", 1.2, "text")] },
    ], { limit: 2 });

    expect(results).toHaveLength(2);
  });
});
