import { describe, expect, test } from "vitest";
import type { MemoryRecord, RecallHit } from "../domain/types.js";
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
      vector: 0.9,
      text: 2.1,
      rrf: expect.any(Number),
    });
  });

  test("respects result limit after fusion", () => {
    const results = fuseHits([
      { source: "vector", hits: [hit("a", 0.9, "vector"), hit("b", 0.8, "vector")] },
      { source: "text", hits: [hit("c", 1.2, "text")] },
    ], { limit: 2 });

    expect(results).toHaveLength(2);
  });
});
