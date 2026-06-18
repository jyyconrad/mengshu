import { describe, expect, test } from "vitest";
import type { MemoryRecord, MemoryScope, RecallHit } from "../core/types.js";
import { RetrievalOrchestrator, type RetrievalSource } from "./orchestrator.js";

const scope: MemoryScope = {
  tenantId: "local",
  appId: "openclaw",
  userId: "user-1",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "knowledge",
};

function hit(id: string, source: RecallHit["source"], score: number): RecallHit {
  const record: MemoryRecord = {
    id,
    scope,
    kind: "knowledge",
    text: id,
    contentHash: `hash-${id}`,
    importance: 0.5,
    category: "other",
    dataType: "knowledge",
    tableName: "knowledge",
    metadata: {},
    provenance: { source: "scan" },
    createdAt: 1710000000000,
  };
  return {
    record,
    score,
    source,
    scoreBreakdown: { [source]: score },
  };
}

describe("RetrievalOrchestrator", () => {
  test("runs sources and fuses results with normalized scope", async () => {
    const calls: Array<{ source: string; scope: MemoryScope; query: string }> = [];
    const sources: RetrievalSource[] = [
      {
        source: "vector",
        search: async (input) => {
          calls.push({ source: "vector", scope: input.scope as MemoryScope, query: input.query });
          return [hit("same", "vector", 0.8)];
        },
      },
      {
        source: "text",
        search: async (input) => {
          calls.push({ source: "text", scope: input.scope as MemoryScope, query: input.query });
          return [hit("same", "text", 2.4), hit("text-only", "text", 1.2)];
        },
      },
    ];
    const orchestrator = new RetrievalOrchestrator({ sources });

    const result = await orchestrator.recall({
      query: "memory tree",
      scope,
      limit: 5,
    });

    expect(calls).toEqual([
      { source: "vector", scope, query: "memory tree" },
      { source: "text", scope, query: "memory tree" },
    ]);
    expect(result.scope).toEqual(scope);
    expect(result.hits.map((item) => item.record.id)).toEqual(["same", "text-only"]);
    expect(result.hits[0].scoreBreakdown).toMatchObject({
      vector: 0.8,
      text: 2.4,
      rrf: expect.any(Number),
    });
  });
});
