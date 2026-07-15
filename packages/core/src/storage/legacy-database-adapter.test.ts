import { describe, expect, test } from "vitest";
import type { DatabaseProvider, MemoryEntry, MemoryQueryOptions, TableStats } from "../db/types.js";
import {
  DATABASE_STORE_CLEANUP_WARNING,
  DatabaseStoreCleanupError,
} from "../db/types.js";
import { LanceDBStoreCleanupError } from "../db/providers/lancedb.js";
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
  tenantId: "local",
  userId: "user-1",
};

class FakeProvider implements DatabaseProvider {
  stored: MemoryEntry[][] = [];
  queries: MemoryQueryOptions[] = [];
  deletedIds: string[][] = [];
  deletedFilters: Array<Record<string, unknown>> = [];

  constructor(private readonly queryHits: Array<MemoryEntry & { score: number }> = []) {}

  async initialize(): Promise<void> {}
  async close(): Promise<void> {}

  async store(entries: MemoryEntry[]) {
    this.stored.push(entries);
    return {
      inserted: entries.length,
      duplicates: 0,
      records: entries.map((item) => ({
        requestedId: item.id,
        persistedId: item.id,
        stored: true,
      })),
    };
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
        tenantId: "local",
        canonicalProjectId: "project-1",
        productId: "openclaw",
        producerId: "agent-1",
        namespace: "memories",
        visibility: "private",
        lifecycleStatus: undefined,
      }],
    ]);
  });

  test("converts a validated provider-neutral cleanup error into receipt metadata", async () => {
    const provider = new FakeProvider();
    provider.store = async () => {
      throw new LanceDBStoreCleanupError({
        inserted: 1,
        duplicates: 0,
        records: [{ requestedId: "mem-1", persistedId: "mem-1", stored: true }],
      }, "completed");
    };
    const adapter = new LegacyDatabaseAdapter(provider, { appId: "openclaw" });

    await expect(adapter.storeLegacyEntries([entry])).resolves.toEqual({
      inserted: 1,
      duplicates: 0,
      records: [{ requestedId: "mem-1", persistedId: "mem-1", stored: true }],
      cleanup: {
        cleanupFailed: true,
        operationStatus: "completed",
        warning: DATABASE_STORE_CLEANUP_WARNING,
      },
    });
  });

  test("keeps a valid partial receipt but does not invent missing records", async () => {
    const provider = new FakeProvider();
    provider.store = async () => {
      throw new DatabaseStoreCleanupError({
        inserted: 1,
        duplicates: 0,
        records: [{ requestedId: "mem-1", persistedId: "mem-1", stored: true }],
      }, "partial");
    };
    const adapter = new LegacyDatabaseAdapter(provider);

    await expect(adapter.storeLegacyEntries([
      entry,
      { ...entry, id: "mem-2", contentHash: "hash-2" },
    ])).resolves.toMatchObject({
      inserted: 1,
      records: [{ requestedId: "mem-1", stored: true }],
      cleanup: { operationStatus: "partial" },
    });
  });

  test("rejects a forged cleanup error with malformed receipt instead of swallowing it", async () => {
    const provider = new FakeProvider();
    const forged = Object.assign(Object.create(DatabaseStoreCleanupError.prototype), {
      code: "DATABASE_STORE_CLEANUP_FAILED",
      cleanupFailed: true,
      warning: DATABASE_STORE_CLEANUP_WARNING,
      operationStatus: "completed",
      receipt: {
        inserted: 1,
        duplicates: 0,
        records: [{ requestedId: "mem-1", persistedId: "", stored: true }],
      },
    });
    provider.store = async () => { throw forged; };
    const adapter = new LegacyDatabaseAdapter(provider);

    await expect(adapter.storeLegacyEntries([entry])).rejects.toBe(forged);
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

    // authority 使用独立列下推；project/app/agent/namespace 仍按既有策略处理。
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
        tenantId: "local",
        userId: "user-1",
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

  test("仅下推 tenant/user authority，不把 project/agent/namespace 误升级成硬隔离", async () => {
    const provider = new FakeProvider([{ ...entry, userId: "user-7", score: 0.5 }]);
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
    expect(options).toMatchObject({ tenantId: "local", userId: "user-7" });
    expect(options.filter).toBeUndefined();
    expect(options).not.toHaveProperty("agentId");
    expect(options).not.toHaveProperty("namespace");
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
    // 显式 filter 透传；authority 走独立列，不混入 metadata filter。
    expect(options.filter).toEqual({ tableName: "memories", kind: "preference" });
    expect(options).toMatchObject({ tenantId: "local", userId: "user-7" });
    expect(options.filter).not.toHaveProperty("userId");
    expect(options.filter).not.toHaveProperty("projectPath");
    expect(options.filter).not.toHaveProperty("agentName");
  });

  test("legacy NULL authority 记录 fail-closed，不允许 metadata/default 回填后可见", async () => {
    const legacyNullTenant = { ...entry, id: "legacy-null-tenant", tenantId: undefined, score: 1 };
    const legacyNullUser = { ...entry, id: "legacy-null-user", userId: undefined, score: 1 };
    const authorized = { ...entry, id: "authorized", score: 0.8 };
    const provider = new FakeProvider([legacyNullTenant, legacyNullUser, authorized]);
    const adapter = new LegacyDatabaseAdapter(provider, {
      tenantId: "local",
      userId: "user-1",
      appId: "openclaw",
    });

    const hits = await adapter.query({
      query: "x",
      scope: {
        tenantId: "local", appId: "openclaw", userId: "user-1",
        projectId: "project-1", agentId: "agent-1", namespace: "memories",
      },
      limit: 10,
    });

    expect(hits.map(({ id }) => id)).toEqual(["authorized"]);
    expect(JSON.stringify(hits)).not.toContain("legacy-null");
  });

  test("100 组 cross tenant/user provider 污染结果在 adapter 边界被 exact post-filter", async () => {
    const alien = Array.from({ length: 100 }, (_, index) => ({
      ...entry,
      id: `alien-${index}`,
      tenantId: index % 2 === 0 ? `tenant-${index}` : "local",
      userId: index % 2 === 0 ? "user-1" : `alien-user-${index}`,
      score: 1,
    }));
    const provider = new FakeProvider([...alien, { ...entry, id: "allowed", score: 0.7 }]);
    const adapter = new LegacyDatabaseAdapter(provider);

    const hits = await adapter.query({
      query: "x",
      scope: {
        tenantId: "local", appId: "openclaw", userId: "user-1",
        projectId: "project-1", agentId: "agent-1", namespace: "memories",
      },
      limit: 5,
    });

    expect(provider.queries[0]).toMatchObject({ tenantId: "local", userId: "user-1", limit: 5 });
    expect(hits.map(({ id }) => id)).toEqual(["allowed"]);
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
