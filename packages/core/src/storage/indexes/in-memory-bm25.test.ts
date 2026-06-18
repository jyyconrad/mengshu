import { describe, expect, test } from "vitest";
import type { MemoryRecord, MemoryScope, RecallHit } from "../../domain/types.js";
import { InMemoryBm25Index, tokenizeForBm25 } from "./in-memory-bm25.js";

const scope: MemoryScope = {
  tenantId: "local",
  appId: "openclaw",
  userId: "user-1",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "knowledge",
};

const otherScope: MemoryScope = {
  ...scope,
  userId: "user-2",
};

function hit(id: string, text: string, recordScope: MemoryScope = scope): RecallHit {
  const record: MemoryRecord = {
    id,
    scope: recordScope,
    kind: "knowledge",
    text,
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
    score: 0,
    source: "vector",
  };
}

describe("InMemoryBm25Index", () => {
  test("indexes and ranks keyword matches within scope", async () => {
    const index = new InMemoryBm25Index();
    await index.upsert([
      { id: "doc-1", scope, text: "alpha alpha memory middleware", hit: hit("doc-1", "alpha alpha memory middleware") },
      { id: "doc-2", scope, text: "beta memory", hit: hit("doc-2", "beta memory") },
      { id: "doc-3", scope: otherScope, text: "alpha private", hit: hit("doc-3", "alpha private", otherScope) },
    ]);

    const results = await index.search({ query: "alpha memory", scope, limit: 5 });

    expect(results.map((result) => result.record.id)).toEqual(["doc-1", "doc-2"]);
    expect(results[0].source).toBe("text");
    expect(results[0].scoreBreakdown?.text).toBeGreaterThan(0);
  });

  test("uses CJK bigrams as fallback tokens", async () => {
    expect(tokenizeForBm25("记忆树系统")).toEqual(["记忆", "忆树", "树系", "系统"]);

    const index = new InMemoryBm25Index();
    await index.upsert([
      { id: "zh-1", scope, text: "记忆树支持整体预览", hit: hit("zh-1", "记忆树支持整体预览") },
      { id: "zh-2", scope, text: "向量数据库", hit: hit("zh-2", "向量数据库") },
    ]);

    const results = await index.search({ query: "记忆树", scope });

    expect(results.map((result) => result.record.id)).toEqual(["zh-1"]);
  });

  test("filters by document metadata", async () => {
    const index = new InMemoryBm25Index();
    await index.upsert([
      { id: "doc-1", scope, text: "alpha guide", hit: hit("doc-1", "alpha guide"), metadata: { sourceType: "docs" } },
      { id: "doc-2", scope, text: "alpha chat", hit: hit("doc-2", "alpha chat"), metadata: { sourceType: "chat" } },
    ]);

    const results = await index.search({
      query: "alpha",
      scope,
      filter: { sourceType: "docs" },
    });

    expect(results.map((result) => result.record.id)).toEqual(["doc-1"]);
  });
});
