import { describe, expect, test, vi } from "vitest";

import type { DatabaseProvider, DatabaseStoreResult, MemoryEntry, MemoryQueryOptions } from "../types.js";
import { HybridProvider } from "./hybrid.js";

function entry(id: string, tenantId: string | undefined, userId: string | undefined, score = 0.8): MemoryEntry & { score: number } {
  return {
    id, text: `text-${id}`, contentHash: `hash-${id}`, vector: [0.1], importance: 0.5,
    category: "fact", dataType: "memory", metadata: {}, createdAt: 1,
    tenantId, userId, score,
  };
}

class FakeProvider implements DatabaseProvider {
  queryCalls: MemoryQueryOptions[] = [];
  storeCalls: MemoryEntry[][] = [];
  constructor(
    readonly results: Array<MemoryEntry & { score: number }> = [],
    readonly queryFailure?: Error,
    readonly storeOutcome?: DatabaseStoreResult,
    readonly storeFailure?: Error,
  ) {}
  async initialize() {}
  async close() {}
  async store(entries: MemoryEntry[]) {
    this.storeCalls.push(entries);
    if (this.storeFailure) throw this.storeFailure;
    return this.storeOutcome ?? {
      inserted: entries.length, duplicates: 0,
      records: entries.map((item) => ({ requestedId: item.id, persistedId: item.id, stored: true })),
    };
  }
  async query(options: MemoryQueryOptions) {
    this.queryCalls.push(options);
    if (this.queryFailure) throw this.queryFailure;
    return this.results;
  }
  async delete() {}
  async deleteByFilter() { return 0; }
  async existsByContentHash() { return []; }
  async count() { return 0; }
}

function hybrid(lance: FakeProvider, supabase: FakeProvider): HybridProvider {
  return new HybridProvider(lance as never, supabase as never);
}

const authority = { tenantId: "tenant-a", userId: "user-a" } as const;

describe("HybridProvider recall authority", () => {
  test("两后端 store outcome 完全一致才返回，duplicate/persisted ID 不虚报", async () => {
    const item = entry("00000000-0000-4000-8000-000000000001", "tenant-a", "user-a");
    const outcome: DatabaseStoreResult = {
      inserted: 0, duplicates: 1,
      records: [{
        requestedId: item.id,
        persistedId: "99999999-9999-4999-8999-999999999999",
        stored: false,
      }],
    };
    const lance = new FakeProvider([], undefined, outcome);
    const supabase = new FakeProvider([], undefined, outcome);

    await expect(hybrid(lance, supabase).store([item])).resolves.toEqual(outcome);
  });

  test("任一后端失败或 outcome 分叉均 sanitized fail-closed", async () => {
    const item = entry("00000000-0000-4000-8000-000000000001", "tenant-a", "user-a");
    const inserted: DatabaseStoreResult = {
      inserted: 1, duplicates: 0,
      records: [{ requestedId: item.id, persistedId: item.id, stored: true }],
    };
    const duplicate: DatabaseStoreResult = {
      inserted: 0, duplicates: 1,
      records: [{ requestedId: item.id, persistedId: "existing", stored: false }],
    };

    await expect(hybrid(
      new FakeProvider([], undefined, inserted),
      new FakeProvider([], undefined, duplicate),
    ).store([item])).rejects.toMatchObject({ code: "HYBRID_STORE_DIVERGED" });

    const failure = await hybrid(
      new FakeProvider([], undefined, undefined, new Error("raw-lance-secret")),
      new FakeProvider([], undefined, inserted),
    ).store([item]).catch((error) => error);
    expect(failure).toMatchObject({ code: "HYBRID_STORE_FAILED" });
    expect(failure.message).not.toContain("raw-lance-secret");
  });

  test("两后端接收同一 authority，合并后按 Lance 顺序/分数并在最后应用 limit", async () => {
    const lance = new FakeProvider(Array.from({ length: 8 }, (_, index) =>
      entry(`id-${index}`, authority.tenantId, authority.userId, 1 - index / 10)));
    const supabase = new FakeProvider([...lance.results].reverse());
    const provider = hybrid(lance, supabase);

    const result = await provider.query({ ...authority, vector: [0.1], limit: 5, filter: { category: "fact" } });

    expect(result.map(({ id }) => id)).toEqual(["id-0", "id-1", "id-2", "id-3", "id-4"]);
    expect(lance.queryCalls[0]).toMatchObject({ ...authority, limit: undefined });
    expect(supabase.queryCalls[0]).toMatchObject({ ...authority, vector: undefined, limit: undefined });
    expect(supabase.queryCalls[0]?.filter).toEqual({
      category: "fact",
      id: lance.results.map(({ id }) => id),
    });
  });

  test("Supabase 镜像 underfill 时只返回交集，不用无关记录补足或超过 limit", async () => {
    const lance = new FakeProvider(Array.from({ length: 5 }, (_, index) =>
      entry(`id-${index}`, authority.tenantId, authority.userId)));
    const supabase = new FakeProvider([
      entry("id-1", authority.tenantId, authority.userId),
      entry("id-3", authority.tenantId, authority.userId),
    ]);

    await expect(hybrid(lance, supabase).query({ ...authority, limit: 5 }))
      .resolves.toMatchObject([{ id: "id-1" }, { id: "id-3" }]);
  });

  test("Supabase 违反 ID 预选合同返回 unrequested row 时整体 fail-closed", async () => {
    const lance = new FakeProvider([entry("id-1", authority.tenantId, authority.userId)]);
    const supabase = new FakeProvider([entry("unrequested", authority.tenantId, authority.userId)]);
    await expect(hybrid(lance, supabase).query(authority)).rejects.toThrow(/authority contract/i);
  });

  test("Lance 返回任一跨 authority/legacy NULL 即 fail-closed，且不查询 Supabase", async () => {
    const violations = [
      ...Array.from({ length: 100 }, (_, index) => entry(
        `alien-${index}`,
        index % 2 === 0 ? `tenant-${index}` : authority.tenantId,
        index % 2 === 0 ? authority.userId : `user-${index}`,
      )),
      entry("legacy-null", undefined, authority.userId),
    ];
    const lance = new FakeProvider([entry("ok", authority.tenantId, authority.userId), ...violations]);
    const supabase = new FakeProvider();

    await expect(hybrid(lance, supabase).query(authority)).rejects.toThrow(/authority contract/i);
    expect(supabase.queryCalls).toEqual([]);
  });

  test("Supabase 返回跨 authority/legacy NULL 即 fail-closed，不返回任一侧文本/ID", async () => {
    const lance = new FakeProvider([entry("id-1", authority.tenantId, authority.userId)]);
    for (const bad of [
      entry("id-1", "tenant-b", authority.userId),
      entry("id-1", authority.tenantId, undefined),
    ]) {
      const supabase = new FakeProvider([bad]);
      await expect(hybrid(lance, supabase).query(authority)).rejects.toThrow(/authority contract/i);
    }
  });

  test.each([
    {},
    { tenantId: "tenant-a" },
    { userId: "user-a" },
    { tenantId: "x' OR TRUE --", userId: "user-a" },
  ])("invalid authority %# 在任一 provider call 前拒绝", async (input) => {
    const lance = new FakeProvider();
    const supabase = new FakeProvider();
    await expect(hybrid(lance, supabase).query(input)).rejects.toThrow(/authority/i);
    expect(lance.queryCalls).toEqual([]);
    expect(supabase.queryCalls).toEqual([]);
  });

  test("任一 provider throw 都转为 sanitized fail-closed error", async () => {
    const lance = new FakeProvider([], new Error("raw-lance-secret"));
    const result = await hybrid(lance, new FakeProvider()).query(authority).catch((error) => error);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toMatch(/authority contract|backend unavailable/i);
    expect(result.message).not.toContain("raw-lance-secret");
  });
});
