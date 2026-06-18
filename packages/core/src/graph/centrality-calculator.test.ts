/**
 * CentralityCalculator 单元测试
 */

import { describe, it, expect, beforeEach } from "vitest";
import { CentralityCalculator } from "./centrality-calculator.js";
import { InMemoryGraphRepository } from "./repository.js";
import type { GraphEntityRecord, GraphRelationRecord } from "./types.js";
import type { MemoryScope } from "../core/types.js";

describe("CentralityCalculator", () => {
  let graphRepo: InMemoryGraphRepository;
  let calculator: CentralityCalculator;
  let scope: MemoryScope;

  beforeEach(() => {
    graphRepo = new InMemoryGraphRepository();
    calculator = new CentralityCalculator({ graphRepo });
    scope = {
      tenantId: "test-tenant",
      appId: "test-app",
      userId: "test-user",
      projectId: "test-project",
      agentId: "test-agent",
      namespace: "default",
    };
  });

  it("should calculate centrality based on degree", async () => {
    // 创建实体
    const entities: GraphEntityRecord[] = [
      {
        id: "e1",
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
        id: "e2",
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
      {
        id: "e3",
        scope,
        canonicalName: "entity-3",
        displayName: "Entity 3",
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

    // 创建关系：e1 是中心节点（连接 e2 和 e3）
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

    // 计算 centrality
    await calculator.calculateCentrality(scope);

    // 验证结果
    const e1 = await graphRepo.getEntity("e1");
    const e2 = await graphRepo.getEntity("e2");
    const e3 = await graphRepo.getEntity("e3");

    // e1 有 2 个连接（degree=2），是最大值，centrality=1.0
    expect(e1!.graphCentrality).toBe(1.0);

    // e2 和 e3 各有 1 个连接（degree=1），centrality=0.5
    expect(e2!.graphCentrality).toBe(0.5);
    expect(e3!.graphCentrality).toBe(0.5);
  });

  it("should handle entities with no relations", async () => {
    const entities: GraphEntityRecord[] = [
      {
        id: "e1",
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
        id: "e2",
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

    // 没有关系
    await calculator.calculateCentrality(scope);

    // 所有实体的 centrality 应该为 0
    const e1 = await graphRepo.getEntity("e1");
    const e2 = await graphRepo.getEntity("e2");

    expect(e1!.graphCentrality).toBe(0);
    expect(e2!.graphCentrality).toBe(0);
  });

  it("should only count active relations", async () => {
    const entities: GraphEntityRecord[] = [
      {
        id: "e1",
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
        id: "e2",
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
        objectId: "e2",
        confidence: 0.5,
        evidenceChunkIds: ["chunk-2"],
        evidenceCount: 1,
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
        status: "weak", // 非 active 状态
        sourceKinds: ["session"],
        metadata: {},
      },
    ];

    await graphRepo.upsertRelations(relations);

    await calculator.calculateCentrality(scope);

    const e1 = await graphRepo.getEntity("e1");
    const e2 = await graphRepo.getEntity("e2");

    // 只有一个 active 关系被计数，所以 degree=1
    expect(e1!.graphCentrality).toBe(1.0);
    expect(e2!.graphCentrality).toBe(1.0);
  });

  it("should count both subject and object connections", async () => {
    const entities: GraphEntityRecord[] = [
      {
        id: "e1",
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
        id: "e2",
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
      {
        id: "e3",
        scope,
        canonicalName: "entity-3",
        displayName: "Entity 3",
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

    // e2 作为 subject 和 object 各出现一次
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
        subjectId: "e2",
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

    await calculator.calculateCentrality(scope);

    const e1 = await graphRepo.getEntity("e1");
    const e2 = await graphRepo.getEntity("e2");
    const e3 = await graphRepo.getEntity("e3");

    // e2 有 2 个连接（作为 subject 1 次 + 作为 object 1 次）
    expect(e2!.graphCentrality).toBe(1.0);

    // e1 和 e3 各有 1 个连接
    expect(e1!.graphCentrality).toBe(0.5);
    expect(e3!.graphCentrality).toBe(0.5);
  });

  it("should handle empty graph", async () => {
    // 没有实体和关系
    await expect(calculator.calculateCentrality(scope)).resolves.toBeUndefined();
  });

  it("should isolate by scope", async () => {
    const scope2: MemoryScope = {
      ...scope,
      projectId: "another-project",
    };

    // scope 1 的实体
    const entities1: GraphEntityRecord[] = [
      {
        id: "e1",
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
    ];

    // scope 2 的实体
    const entities2: GraphEntityRecord[] = [
      {
        id: "e2",
        scope: scope2,
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

    await graphRepo.upsertEntities([...entities1, ...entities2]);

    // 只计算 scope 1
    await calculator.calculateCentrality(scope);

    // scope 1 的实体应该有 centrality
    const e1 = await graphRepo.getEntity("e1");
    expect(e1!.graphCentrality).toBeDefined();

    // scope 2 的实体应该没有被更新
    const e2 = await graphRepo.getEntity("e2");
    expect(e2!.graphCentrality).toBeUndefined();
  });
});
