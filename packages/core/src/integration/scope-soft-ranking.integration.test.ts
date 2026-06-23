/**
 * scope 软排序集成测试。
 *
 * 验证 scope 从硬过滤改为软排序后的端到端行为：
 * - 跨 scope 记忆可被检索（不被 SQL WHERE 拦截）
 * - 同 scope 记忆排序靠前（scopeFit 高）
 * - 显式 filter 仍然透传生效
 */

import { describe, test, expect, beforeEach } from "vitest";
import type { DatabaseProvider, MemoryEntry } from "../db/types.js";
import { LegacyDatabaseAdapter } from "../storage/legacy-database-adapter.js";
import { DefaultMemoryService } from "../service/memory-service.js";
import type { EmbeddingPort } from "../service/memory-service.js";

class StubProvider implements DatabaseProvider {
  entries: MemoryEntry[] = [];

  async initialize(): Promise<void> {}
  async close(): Promise<void> {}

  async store(entries: MemoryEntry[]): Promise<void> {
    this.entries.push(...entries);
  }

  async query(): Promise<Array<MemoryEntry & { score: number }>> {
    // 返回所有已存储的记忆，向量相似度相同（模拟跨 scope 查询，无硬过滤，排序完全由 scopeFit 决定）
    return this.entries.map((e) => ({ ...e, score: 0.85 }));
  }

  async delete(): Promise<void> {}
  async deleteByFilter(): Promise<number> {
    return 0;
  }
  async existsByContentHash(): Promise<string[]> {
    return [];
  }
  async count(): Promise<number> {
    return this.entries.length;
  }
}

class StubEmbeddings implements EmbeddingPort {
  async embed(): Promise<number[]> {
    return [0.1, 0.2, 0.3];
  }
}

describe("scope soft ranking integration", () => {
  let provider: StubProvider;
  let service: DefaultMemoryService;

  beforeEach(() => {
    provider = new StubProvider();
    const adapter = new LegacyDatabaseAdapter(provider, {
      appId: "openclaw",
      tenantId: "local",
    });
    service = new DefaultMemoryService({ repository: adapter, embeddings: new StubEmbeddings() });
  });

  test("recalls memories across different scopes (no hard WHERE filter)", async () => {
    const scopeA = {
      tenantId: "local",
      appId: "openclaw",
      userId: "user-1",
      projectId: "project-1",
      agentId: "agent-1",
      namespace: "memories",
    };
    const scopeB = {
      tenantId: "local",
      appId: "openclaw",
      userId: "user-2",
      projectId: "project-2",
      agentId: "agent-2",
      namespace: "memories",
    };

    await service.storeMemory({
      record: {
        id: "mem-A",
        scope: scopeA,
        kind: "preference",
        text: "preference A",
        contentHash: "hash-A",
        importance: 0.5,
        category: "preference",
        dataType: "memory",
        metadata: {},
        provenance: { source: "user" },
        createdAt: Date.now(),
        vector: [0.1, 0.2],
      },
    });

    await service.storeMemory({
      record: {
        id: "mem-B",
        scope: scopeB,
        kind: "preference",
        text: "preference B",
        contentHash: "hash-B",
        importance: 0.5,
        category: "preference",
        dataType: "memory",
        metadata: {},
        provenance: { source: "user" },
        createdAt: Date.now(),
        vector: [0.3, 0.4],
      },
    });

    // 用 scopeA 召回：应该同时能检索到 mem-A 和 mem-B（跨 scope）
    const result = await service.recall({
      query: "preference",
      scope: scopeA,
    });

    expect(result.hits).toHaveLength(2);
    const ids = result.hits.map((h: { record: { id: string } }) => h.record.id);
    expect(ids).toContain("mem-A");
    expect(ids).toContain("mem-B");
  });

  test("ranks same-scope memory first via scopeFit signal", async () => {
    const scopeA = {
      tenantId: "local",
      appId: "openclaw",
      userId: "user-1",
      projectId: "project-1",
      agentId: "agent-1",
      namespace: "memories",
    };
    const scopeB = {
      tenantId: "local",
      appId: "openclaw",
      userId: "user-1",
      projectId: "project-2",
      agentId: "agent-2",
      namespace: "memories",
    };

    await service.storeMemory({
      record: {
        id: "mem-A",
        scope: scopeA,
        kind: "preference",
        text: "A",
        contentHash: "hash-A",
        importance: 0.5,
        category: "preference",
        dataType: "memory",
        metadata: {
          userId: scopeA.userId,
          projectPath: scopeA.projectId,
          agentName: scopeA.agentId,
        },
        provenance: { source: "user" },
        createdAt: Date.now(),
        vector: [0.1, 0.2],
      },
    });

    await service.storeMemory({
      record: {
        id: "mem-B",
        scope: scopeB,
        kind: "preference",
        text: "B",
        contentHash: "hash-B",
        importance: 0.5,
        category: "preference",
        dataType: "memory",
        metadata: {
          userId: scopeB.userId,
          projectPath: scopeB.projectId,
          agentName: scopeB.agentId,
        },
        provenance: { source: "user" },
        createdAt: Date.now(),
        vector: [0.3, 0.4],
      },
    });

    const result = await service.recall({
      query: "pref",
      scope: scopeA,
    });

    // 同 scope 的 mem-A 排在前面（高 scopeFit）
    expect(result.hits[0].record.id).toBe("mem-A");
    expect(result.hits[1].record.id).toBe("mem-B");

    // scopeFit 分数体现差异：scopeA 完全匹配=1.0，scopeB 部分匹配<1.0
    const fitA = result.hits[0].scoreBreakdown?.scopeFit ?? 0;
    const fitB = result.hits[1].scoreBreakdown?.scopeFit ?? 0;
    expect(fitA).toBeGreaterThan(fitB);
    expect(fitA).toBeCloseTo(1.0, 1); // 完全匹配
  });
});
