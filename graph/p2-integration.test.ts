/**
 * P2 集成测试：验证 queryHits30d 递增 + graphCentrality 计算的完整流程
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DefaultMemoryService } from "../core/memory-service.js";
import { InMemoryMemoryStore } from "../storage/repositories/in-memory.js";
import { InMemoryGraphRepository } from "../graph/repository.js";
import { QueryHitsTracker } from "../graph/query-hits-tracker.js";
import { CentralityCalculator } from "../graph/centrality-calculator.js";
import { computeHotness } from "../tree/topic.js";
import type { MemoryScope } from "../core/types.js";
import type { GraphEntityRecord, GraphRelationRecord } from "../graph/types.js";

describe("P2 Integration: queryHits30d + graphCentrality", () => {
  let memoryStore: InMemoryMemoryStore;
  let graphRepo: InMemoryGraphRepository;
  let queryHitsTracker: QueryHitsTracker;
  let centralityCalculator: CentralityCalculator;
  let memoryService: DefaultMemoryService;
  let scope: MemoryScope;

  beforeEach(() => {
    memoryStore = new InMemoryMemoryStore();
    graphRepo = new InMemoryGraphRepository();
    queryHitsTracker = new QueryHitsTracker({ graphRepo });
    centralityCalculator = new CentralityCalculator({ graphRepo });

    // Mock embeddings
    const mockEmbeddings = {
      embed: async (text: string) => new Array(384).fill(0.1),
    };

    memoryService = new DefaultMemoryService({
      repository: memoryStore.memories,
      embeddings: mockEmbeddings as any,
      queryHitsTracker,
    });

    scope = {
      tenantId: "test-tenant",
      appId: "test-app",
      userId: "test-user",
      projectId: "test-project",
      agentId: "test-agent",
      namespace: "default",
    };
  });

  it("should increment queryHits30d on recall and affect hotness", async () => {
    // 1. 创建实体
    const entity: GraphEntityRecord = {
      id: "entity-1",
      scope,
      canonicalName: "typescript",
      displayName: "TypeScript",
      type: "tool",
      aliases: ["ts"],
      mentionCount: 10,
      mentionCount30d: 5,
      distinctSourceCount: 3,
      lastSeenAt: Date.now(),
      hotness: 0,
      queryHits30d: 0,
      graphCentrality: 0,
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {},
    };

    await graphRepo.upsertEntities([entity]);

    // 2. 存储记忆（关联 entity）
    const now = Date.now();
    await memoryService.storeMemory({
      record: {
        id: "mem-1",
        scope,
        kind: "fact",
        text: "TypeScript is a typed superset of JavaScript",
        contentHash: "hash-1",
        importance: 0.8,
        category: "other",
        dataType: "memory",
        vector: new Array(384).fill(0.1),
        provenance: {},
        createdAt: now,
        metadata: {
          entityIds: ["entity-1"],
        },
      },
    });

    // 3. 初始 hotness（queryHits30d=0）
    const initialHotness = computeHotness(entity, now);
    expect(initialHotness).toBeGreaterThan(0); // 有 mention 和 source

    // 4. 召回记忆（会触发 queryHits30d 递增）
    await memoryService.recall({
      query: "TypeScript",
      limit: 5,
      scope,
    });

    // 等待异步追踪完成
    await new Promise(resolve => setTimeout(resolve, 50));

    // 5. 验证 queryHits30d 递增
    const updatedEntity = await graphRepo.getEntity("entity-1");
    expect(updatedEntity!.queryHits30d).toBe(1);

    // 6. 验证 hotness 增加
    const newHotness = computeHotness(updatedEntity!, now);
    expect(newHotness).toBeGreaterThan(initialHotness);
  });

  it("should calculate graphCentrality and affect hotness", async () => {
    // 1. 创建实体网络
    const entities: GraphEntityRecord[] = [
      {
        id: "e1",
        scope,
        canonicalName: "react",
        displayName: "React",
        type: "tool",
        aliases: [],
        mentionCount: 10,
        mentionCount30d: 5,
        distinctSourceCount: 2,
        lastSeenAt: Date.now(),
        hotness: 0,
        queryHits30d: 0,
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        metadata: {},
      },
      {
        id: "e2",
        scope,
        canonicalName: "typescript",
        displayName: "TypeScript",
        type: "tool",
        aliases: [],
        mentionCount: 10,
        mentionCount30d: 5,
        distinctSourceCount: 2,
        lastSeenAt: Date.now(),
        hotness: 0,
        queryHits30d: 0,
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        metadata: {},
      },
      {
        id: "e3",
        scope,
        canonicalName: "nextjs",
        displayName: "Next.js",
        type: "tool",
        aliases: [],
        mentionCount: 10,
        mentionCount30d: 5,
        distinctSourceCount: 2,
        lastSeenAt: Date.now(),
        hotness: 0,
        queryHits30d: 0,
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        metadata: {},
      },
    ];

    await graphRepo.upsertEntities(entities);

    // 2. 创建关系（e1 是中心节点）
    const relations: GraphRelationRecord[] = [
      {
        id: "r1",
        scope,
        subjectId: "e1",
        predicate: "uses",
        objectId: "e2",
        confidence: 0.9,
        evidenceChunkIds: ["chunk-1"],
        evidenceCount: 1,
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
        status: "active",
        sourceKinds: ["session"],
        metadata: {},
      },
      {
        id: "r2",
        scope,
        subjectId: "e1",
        predicate: "uses",
        objectId: "e3",
        confidence: 0.9,
        evidenceChunkIds: ["chunk-2"],
        evidenceCount: 1,
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
        status: "active",
        sourceKinds: ["session"],
        metadata: {},
      },
    ];

    await graphRepo.upsertRelations(relations);

    // 3. 初始 hotness（graphCentrality=0）
    const now = Date.now();
    const e1Before = await graphRepo.getEntity("e1");
    const hotnessBefore = computeHotness(e1Before!, now);

    // 4. 计算 centrality
    await centralityCalculator.calculateCentrality(scope);

    // 5. 验证 centrality
    const e1After = await graphRepo.getEntity("e1");
    const e2After = await graphRepo.getEntity("e2");
    const e3After = await graphRepo.getEntity("e3");

    expect(e1After!.graphCentrality).toBe(1.0); // 最高度数
    expect(e2After!.graphCentrality).toBe(0.5);
    expect(e3After!.graphCentrality).toBe(0.5);

    // 6. 验证 hotness 增加
    const hotnessAfter = computeHotness(e1After!, now);
    expect(hotnessAfter).toBeGreaterThan(hotnessBefore);
  });

  it("should combine queryHits30d and graphCentrality for hotness", async () => {
    // 1. 创建实体和关系
    const entity: GraphEntityRecord = {
      id: "entity-1",
      scope,
      canonicalName: "postgres",
      displayName: "PostgreSQL",
      type: "tool",
      aliases: ["pg", "postgresql"],
      mentionCount: 20,
      mentionCount30d: 10,
      distinctSourceCount: 4,
      lastSeenAt: Date.now(),
      hotness: 0,
      queryHits30d: 0,
      graphCentrality: 0,
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {},
    };

    const relatedEntity: GraphEntityRecord = {
      id: "entity-2",
      scope,
      canonicalName: "sql",
      displayName: "SQL",
      type: "concept",
      aliases: [],
      mentionCount: 5,
      mentionCount30d: 3,
      distinctSourceCount: 2,
      lastSeenAt: Date.now(),
      hotness: 0,
      queryHits30d: 0,
      graphCentrality: 0,
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {},
    };

    await graphRepo.upsertEntities([entity, relatedEntity]);

    const relation: GraphRelationRecord = {
      id: "r1",
      scope,
      subjectId: "entity-1",
      predicate: "uses",
      objectId: "entity-2",
      confidence: 0.9,
      evidenceChunkIds: ["chunk-1"],
      evidenceCount: 1,
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
      status: "active",
      sourceKinds: ["session"],
      metadata: {},
    };

    await graphRepo.upsertRelations([relation]);

    // 2. 存储记忆
    const now = Date.now();
    await memoryService.storeMemory({
      record: {
        id: "mem-1",
        scope,
        kind: "fact",
        text: "PostgreSQL is a powerful relational database",
        contentHash: "hash-1",
        importance: 0.8,
        category: "other",
        dataType: "memory",
        vector: new Array(384).fill(0.1),
        provenance: {},
        createdAt: now,
        metadata: {
          entityIds: ["entity-1"],
        },
      },
    });

    // 3. 初始 hotness
    const initialEntity = await graphRepo.getEntity("entity-1");
    const initialHotness = computeHotness(initialEntity!, now);

    // 4. 召回 + 计算 centrality
    await memoryService.recall({
      query: "PostgreSQL",
      limit: 5,
      scope,
    });

    await new Promise(resolve => setTimeout(resolve, 50));

    await centralityCalculator.calculateCentrality(scope);

    // 5. 验证两个因子都生效
    const finalEntity = await graphRepo.getEntity("entity-1");
    expect(finalEntity!.queryHits30d).toBeGreaterThan(0);
    expect(finalEntity!.graphCentrality).toBeGreaterThan(0);

    // 6. 最终 hotness 显著提升
    const finalHotness = computeHotness(finalEntity!, now);
    expect(finalHotness).toBeGreaterThan(initialHotness);
  });
});
