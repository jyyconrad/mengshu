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

    expect(provider.stored).toEqual([[entry]]);
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

    expect(provider.queries).toEqual([
      {
        query: "concise",
        vector: [0.3, 0.4],
        limit: 5,
        minScore: 0.2,
        tableName: "memories",
        dataTypes: ["memory"],
        searchAll: true,
        filter: {
          userId: "user-1",
          projectPath: "project-1",
          agentName: "agent-1",
        },
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
