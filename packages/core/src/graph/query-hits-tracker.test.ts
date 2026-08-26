/**
 * QueryHitsTracker 单元测试
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { QueryHitsTracker } from "./query-hits-tracker.js";
import { InMemoryGraphRepository } from "./repository.js";
import type { GraphEntityRecord } from "./types.js";
import type { RecallHit, MemoryScope } from "../domain/types.js";

describe("QueryHitsTracker", () => {
  let graphRepo: InMemoryGraphRepository;
  let tracker: QueryHitsTracker;
  let scope: MemoryScope;

  beforeEach(() => {
    graphRepo = new InMemoryGraphRepository();
    tracker = new QueryHitsTracker({ graphRepo });
    scope = {
      tenantId: "test-tenant",
      appId: "test-app",
      userId: "test-user",
      projectId: "test-project",
      agentId: "test-agent",
      namespace: "default",
    };
  });

  it("should increment queryHits30d for entities in recall hits", async () => {
    // 准备测试数据
    const entity: GraphEntityRecord = {
      id: "entity-1",
      scope,
      canonicalName: "test-entity",
      displayName: "Test Entity",
      type: "tool",
      aliases: [],
      mentionCount: 5,
      mentionCount30d: 3,
      distinctSourceCount: 2,
      lastSeenAt: Date.now(),
      hotness: 5.0,
      queryHits30d: 0,
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {},
    };

    await graphRepo.upsertEntities([entity]);

    // 模拟 recall hits
    const hits: RecallHit[] = [
      {
        record: {
          id: "mem-1",
          scope,
          kind: "fact",
          text: "Test memory",
          contentHash: "hash-1",
          importance: 0.8,
          category: "other",
          dataType: "memory",
          vector: new Array(384).fill(0.1),
          provenance: {},
          createdAt: Date.now(),
          metadata: {
            entityIds: ["entity-1"],
          },
        },
        score: 0.9,
        source: "vector",
        scoreBreakdown: { vector: 0.9 },
        provenance: {},
      },
    ];

    // 追踪 queryHits
    await tracker.trackRecallHits(hits, scope);

    // 验证 queryHits30d 递增
    const updated = await graphRepo.getEntity("entity-1");
    expect(updated).toBeDefined();
    expect(updated!.queryHits30d).toBe(1);
  });

  it("should handle multiple entities in one hit", async () => {
    // 准备多个实体
    const entities: GraphEntityRecord[] = [
      {
        id: "entity-1",
        scope,
        canonicalName: "entity-1",
        displayName: "Entity 1",
        type: "tool",
        aliases: [],
        mentionCount: 1,
        mentionCount30d: 1,
        distinctSourceCount: 1,
        hotness: 1.0,
        queryHits30d: 0,
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        metadata: {},
      },
      {
        id: "entity-2",
        scope,
        canonicalName: "entity-2",
        displayName: "Entity 2",
        type: "tool",
        aliases: [],
        mentionCount: 1,
        mentionCount30d: 1,
        distinctSourceCount: 1,
        hotness: 1.0,
        queryHits30d: 0,
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        metadata: {},
      },
    ];

    await graphRepo.upsertEntities(entities);

    // 一个 hit 包含多个 entity
    const hits: RecallHit[] = [
      {
        record: {
          id: "mem-1",
          scope,
          kind: "fact",
          text: "Test memory",
          contentHash: "hash-1",
          importance: 0.8,
          category: "other",
          dataType: "memory",
          vector: new Array(384).fill(0.1),
          provenance: {},
          createdAt: Date.now(),
          metadata: {
            entityIds: ["entity-1", "entity-2"],
          },
        },
        score: 0.9,
        source: "vector",
        scoreBreakdown: { vector: 0.9 },
        provenance: {},
      },
    ];

    await tracker.trackRecallHits(hits, scope);

    // 验证两个 entity 都递增了
    const e1 = await graphRepo.getEntity("entity-1");
    const e2 = await graphRepo.getEntity("entity-2");
    expect(e1!.queryHits30d).toBe(1);
    expect(e2!.queryHits30d).toBe(1);
  });

  it("should accumulate queryHits30d across multiple recalls", async () => {
    const entity: GraphEntityRecord = {
      id: "entity-1",
      scope,
      canonicalName: "test-entity",
      displayName: "Test Entity",
      type: "tool",
      aliases: [],
      mentionCount: 5,
      mentionCount30d: 3,
      distinctSourceCount: 2,
      hotness: 5.0,
      queryHits30d: 0,
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {},
    };

    await graphRepo.upsertEntities([entity]);

    const hits: RecallHit[] = [
      {
        record: {
          id: "mem-1",
          scope,
          kind: "fact",
          text: "Test memory",
          contentHash: "hash-1",
          importance: 0.8,
          category: "other",
          dataType: "memory",
          vector: new Array(384).fill(0.1),
          provenance: {},
          createdAt: Date.now(),
          metadata: {
            entityIds: ["entity-1"],
          },
        },
        score: 0.9,
        source: "vector",
        scoreBreakdown: { vector: 0.9 },
        provenance: {},
      },
    ];

    // 第一次 recall
    await tracker.trackRecallHits(hits, scope);
    let updated = await graphRepo.getEntity("entity-1");
    expect(updated!.queryHits30d).toBe(1);

    // 第二次 recall
    await tracker.trackRecallHits(hits, scope);
    updated = await graphRepo.getEntity("entity-1");
    expect(updated!.queryHits30d).toBe(2);

    // 第三次 recall
    await tracker.trackRecallHits(hits, scope);
    updated = await graphRepo.getEntity("entity-1");
    expect(updated!.queryHits30d).toBe(3);
  });

  it("should handle hits without entityIds", async () => {
    const hits: RecallHit[] = [
      {
        record: {
          id: "mem-1",
          scope,
          kind: "fact",
          text: "Test memory",
          contentHash: "hash-1",
          importance: 0.8,
          category: "other",
          dataType: "memory",
          vector: new Array(384).fill(0.1),
          provenance: {},
          createdAt: Date.now(),
          metadata: {}, // 没有 entityIds
        },
        score: 0.9,
        source: "vector",
        scoreBreakdown: { vector: 0.9 },
        provenance: {},
      },
    ];

    // 不应该抛出错误
    await expect(tracker.trackRecallHits(hits, scope)).resolves.toBeUndefined();
  });

  it("should handle empty hits", async () => {
    await expect(tracker.trackRecallHits([], scope)).resolves.toBeUndefined();
  });

  it("should handle non-existent entities gracefully", async () => {
    const hits: RecallHit[] = [
      {
        record: {
          id: "mem-1",
          scope,
          kind: "fact",
          text: "Test memory",
          contentHash: "hash-1",
          importance: 0.8,
          category: "other",
          dataType: "memory",
          vector: new Array(384).fill(0.1),
          provenance: {},
          createdAt: Date.now(),
          metadata: {
            entityIds: ["non-existent-entity"],
          },
        },
        score: 0.9,
        source: "vector",
        scoreBreakdown: { vector: 0.9 },
        provenance: {},
      },
    ];

    // 不应该抛出错误
    await expect(tracker.trackRecallHits(hits, scope)).resolves.toBeUndefined();
  });

  it("production port 只接收权威 memory identity，不信任 metadata entityIds", async () => {
    const incrementRecallHits = vi.fn(async () => ({
      updatedEntityIds: ["authoritative-entity"],
    }));
    const productionTracker = new QueryHitsTracker({
      entityGraphQueryHits: { incrementRecallHits },
    });
    const hit = {
      record: {
        id: "active-memory-1",
        scope,
        kind: "fact" as const,
        text: "PostgreSQL query hit",
        contentHash: "hash-production",
        importance: 0.8,
        category: "other",
        dataType: "memory",
        vector: new Array(384).fill(0.1),
        provenance: {},
        createdAt: Date.now(),
        metadata: {
          entityIds: ["caller-forged-entity"],
          workMemoryNodeIds: ["must-not-be-treated-as-entity"],
          codeGraphNodeIds: ["must-not-be-treated-as-entity"],
        },
      },
      score: 0.9,
      source: "graph" as const,
      scoreBreakdown: { vector: 0.9 },
      provenance: {},
    } satisfies RecallHit;

    await productionTracker.trackRecallHits([hit, hit], scope);

    expect(incrementRecallHits).toHaveBeenCalledOnce();
    expect(incrementRecallHits).toHaveBeenCalledWith({
      memoryIds: ["active-memory-1"],
      scope,
      occurredAt: expect.any(Number),
    });
    expect(JSON.stringify(incrementRecallHits.mock.calls)).not.toContain("caller-forged-entity");
    expect(JSON.stringify(incrementRecallHits.mock.calls)).not.toContain("workMemoryNodeIds");
    expect(JSON.stringify(incrementRecallHits.mock.calls)).not.toContain("codeGraphNodeIds");
  });
});
