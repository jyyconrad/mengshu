import { describe, expect, test } from "vitest";
import type { DatabaseProvider, MemoryEntry, MemoryQueryOptions, TableStats } from "../db/types.js";
import { LegacyDatabaseAdapter } from "./legacy-database-adapter.js";

const entry: MemoryEntry = {
  id: "mem-1",
  text: "User prefers concise replies",
  contentHash: "hash-1",
  vector: [0.1, 0.2],
  importance: 0.8,
  category: "preference",
  dataType: "memory",
  tableName: "memories",
  metadata: {
    userId: "user-1",
    projectPath: "project-1",
    agentName: "agent-1",
    source: "user",
  },
  createdAt: 1710000000000,
};

class FakeProvider implements DatabaseProvider {
  stored: MemoryEntry[][] = [];
  queries: MemoryQueryOptions[] = [];
  deletedIds: string[][] = [];
  deletedFilters: Array<Record<string, unknown>> = [];

  constructor(private readonly queryHits: Array<MemoryEntry & { score: number }> = []) {}

  async initialize(): Promise<void> {}
  async close(): Promise<void> {}

  async store(entries: MemoryEntry[]): Promise<void> {
    this.stored.push(entries);
  }

  async query(options: MemoryQueryOptions): Promise<Array<MemoryEntry & { score: number }>> {
    this.queries.push(options);
    return this.queryHits;
  }

  async delete(ids: string[]): Promise<void> {
    this.deletedIds.push(ids);
  }

  async deleteByFilter(filter: Record<string, unknown>): Promise<number> {
    this.deletedFilters.push(filter);
    return 3;
  }

  async existsByContentHash(): Promise<string[]> {
    return [];
  }

  async count(): Promise<number> {
    return 7;
  }

  async getTableStats(): Promise<TableStats[]> {
    return [
      { name: "memories", count: 4, dataType: "memory" },
      { name: "knowledge", count: 3, dataType: "knowledge" },
    ];
  }
}

describe("LegacyDatabaseAdapter", () => {
  test("stores core records as legacy entries", async () => {
    const provider = new FakeProvider();
    const adapter = new LegacyDatabaseAdapter(provider, { appId: "openclaw" });

    await adapter.store([adapter.memoryEntryToRecord(entry)]);

    // category=preference -> kind=preference -> semanticType=profile（边界统一推导），
    // 该值回写进 metadata.semanticType，因此存回的 legacy entry 多出该字段。
    // D-25：scope 维度会镜像到独立列：
    // - projectName: 从 metadata.projectPath = "project-1" 读回
    // - appName: 从 adapter 默认 scope.appId = "openclaw" 读回
    // - userId: 从 metadata.userId = "user-1" 读回
    // - agentId: 从 metadata.agentName = "agent-1" 读回
    // - workspaceId: 未设置，为 undefined
    expect(provider.stored).toEqual([
      [{
        ...entry,
        metadata: { ...entry.metadata, semanticType: "profile" },
        projectName: "project-1",
        appName: "openclaw",
        userId: "user-1",
        agentId: "agent-1",
        workspaceId: undefined,
      }],
    ]);
  });

  test("queries provider with legacy options and returns core records with scores", async () => {
    const provider = new FakeProvider([{ ...entry, score: 0.89 }]);
    const adapter = new LegacyDatabaseAdapter(provider, { appId: "openclaw" });

    const hits = await adapter.query({
      query: "concise",
      vector: [0.3, 0.4],
      limit: 5,
      minScore: 0.2,
      scope: {
        tenantId: "local",
        appId: "openclaw",
        userId: "user-1",
        projectId: "project-1",
        agentId: "agent-1",
        namespace: "memories",
      },
      tableName: "memories",
      dataTypes: ["memory"],
      searchAll: true,
    });

    // scope 不再塞进 filter（跨 scope 软排序，硬过滤已移除）
    expect(provider.queries).toEqual([
      {
        query: "concise",
        vector: [0.3, 0.4],
        limit: 5,
        minScore: 0.2,
        tableName: "memories",
        dataTypes: ["memory"],
        searchAll: true,
        filter: undefined,
      },
    ]);
    expect(hits[0]).toMatchObject({
      id: "mem-1",
      scope: {
        appId: "openclaw",
        userId: "user-1",
        projectId: "project-1",
        agentId: "agent-1",
        namespace: "memories",
      },
      score: 0.89,
    });
  });

  test("does not push non-default scope into the SQL filter (no hard scope WHERE)", async () => {
    const provider = new FakeProvider([{ ...entry, score: 0.5 }]);
    const adapter = new LegacyDatabaseAdapter(provider, { appId: "openclaw" });

    await adapter.query({
      query: "x",
      scope: {
        tenantId: "local",
        appId: "openclaw",
        userId: "user-7",
        projectId: "project-7",
        agentId: "agent-7",
        namespace: "memories",
      },
    });

    const options = provider.queries[0];
    expect(options.filter).toBeUndefined();
  });

  test("still passes through caller-provided structured filter", async () => {
    const provider = new FakeProvider([{ ...entry, score: 0.5 }]);
    const adapter = new LegacyDatabaseAdapter(provider, { appId: "openclaw" });

    await adapter.query({
      query: "x",
      filter: { tableName: "memories", kind: "preference" },
      scope: {
        tenantId: "local",
        appId: "openclaw",
        userId: "user-7",
        projectId: "project-7",
        agentId: "agent-7",
        namespace: "memories",
      },
    });

    const options = provider.queries[0];
    // 显式 filter 透传，但不混入任何 scope 字段
    expect(options.filter).toEqual({ tableName: "memories", kind: "preference" });
    expect(options.filter).not.toHaveProperty("userId");
    expect(options.filter).not.toHaveProperty("projectPath");
    expect(options.filter).not.toHaveProperty("agentName");
  });

  // D-25：toLegacyQueryOptions 内部 key 提取（_projectName/_appName/_projectPattern）
  describe("D-25: scope 维度硬过滤 key 提取", () => {
    test("提取 _projectName 到 MemoryQueryOptions.projectName，并从 filter 删除", async () => {
      const provider = new FakeProvider([{ ...entry, score: 0.5 }]);
      const adapter = new LegacyDatabaseAdapter(provider, { appId: "openclaw" });

      await adapter.query({
        query: "x",
        filter: { _projectName: "memory-autodb", category: "preference" },
        scope: {
          tenantId: "local",
          appId: "openclaw",
          userId: "user-1",
          projectId: "project-1",
          agentId: "agent-1",
          namespace: "memories",
        },
      });

      const options = provider.queries[0];
      expect(options.projectName).toBe("memory-autodb");
      expect(options.filter).toEqual({ category: "preference" });  // 内部 key 已删除
      expect(options.filter).not.toHaveProperty("_projectName");
    });

    test("提取 _appName 到 MemoryQueryOptions.appName", async () => {
      const provider = new FakeProvider([{ ...entry, score: 0.5 }]);
      const adapter = new LegacyDatabaseAdapter(provider, { appId: "openclaw" });

      await adapter.query({
        query: "x",
        filter: { _appName: "codex" },
        scope: {
          tenantId: "local",
          appId: "openclaw",
          userId: "user-1",
          projectId: "project-1",
          agentId: "agent-1",
          namespace: "memories",
        },
      });

      const options = provider.queries[0];
      expect(options.appName).toBe("codex");
      expect(options.filter).toBeUndefined();  // 删除内部 key 后 filter 为空对象 → undefined
    });

    test("提取 _projectPattern 到 MemoryQueryOptions.projectPattern（LIKE 模糊检索）", async () => {
      const provider = new FakeProvider([{ ...entry, score: 0.5 }]);
      const adapter = new LegacyDatabaseAdapter(provider, { appId: "openclaw" });

      await adapter.query({
        query: "x",
        filter: { _projectPattern: "openclaw%" },
        scope: {
          tenantId: "local",
          appId: "openclaw",
          userId: "user-1",
          projectId: "project-1",
          agentId: "agent-1",
          namespace: "memories",
        },
      });

      const options = provider.queries[0];
      expect(options.projectPattern).toBe("openclaw%");
      expect(options.filter).toBeUndefined();
    });

    test("同时提取 _projectName + _appName + _projectPattern", async () => {
      const provider = new FakeProvider([{ ...entry, score: 0.5 }]);
      const adapter = new LegacyDatabaseAdapter(provider, { appId: "openclaw" });

      await adapter.query({
        query: "x",
        filter: {
          _projectName: "p1",
          _appName: "codex",
          _projectPattern: "p%",
          tableName: "memories",  // 用户 filter 保留
        },
        scope: {
          tenantId: "local",
          appId: "openclaw",
          userId: "user-1",
          projectId: "project-1",
          agentId: "agent-1",
          namespace: "memories",
        },
      });

      const options = provider.queries[0];
      expect(options.projectName).toBe("p1");
      expect(options.appName).toBe("codex");
      expect(options.projectPattern).toBe("p%");
      expect(options.filter).toEqual({ tableName: "memories" });  // 内部 key 全部删除，用户 filter 保留
    });

    test("没有内部 key 时不影响现有逻辑", async () => {
      const provider = new FakeProvider([{ ...entry, score: 0.5 }]);
      const adapter = new LegacyDatabaseAdapter(provider, { appId: "openclaw" });

      await adapter.query({
        query: "x",
        filter: { category: "preference" },
        scope: {
          tenantId: "local",
          appId: "openclaw",
          userId: "user-1",
          projectId: "project-1",
          agentId: "agent-1",
          namespace: "memories",
        },
      });

      const options = provider.queries[0];
      expect(options.projectName).toBeUndefined();
      expect(options.appName).toBeUndefined();
      expect(options.projectPattern).toBeUndefined();
      expect(options.filter).toEqual({ category: "preference" });
    });
  });

  test("exposes legacy operations for OpenClaw compatibility", async () => {
    const provider = new FakeProvider([{ ...entry, score: 0.7 }]);
    const adapter = new LegacyDatabaseAdapter(provider);

    await adapter.storeLegacyEntries([entry]);
    const hits = await adapter.queryLegacyEntries({ query: "concise", tableName: "memories" });
    await adapter.deleteLegacyEntries(["mem-1"]);
    const deleted = await adapter.deleteByFilter({ tableName: "memories" });
    const stats = await adapter.stats();

    expect(provider.stored).toEqual([[entry]]);
    expect(hits).toEqual([{ ...entry, score: 0.7 }]);
    expect(provider.deletedIds).toEqual([["mem-1"]]);
    expect(deleted).toBe(3);
    expect(stats).toEqual({
      count: 7,
      tables: [
        { name: "memories", count: 4, dataType: "memory" },
        { name: "knowledge", count: 3, dataType: "knowledge" },
      ],
    });
  });
});
