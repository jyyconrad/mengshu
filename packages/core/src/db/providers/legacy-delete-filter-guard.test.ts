import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { HybridProvider } from "./hybrid.js";
import { LanceDBProvider } from "./lancedb.js";
import { PostgresProvider } from "./postgres.js";
import { SupabaseProvider } from "./supabase.js";
import {
  LegacyDeleteFilterError,
  assertSafeLegacyDeleteFilter,
} from "./legacy-delete-filter-guard.js";

const DELETE_FILTER_REQUIRED = { code: "DELETE_FILTER_REQUIRED" };

describe("assertSafeLegacyDeleteFilter", () => {
  test.each([
    undefined,
    null,
    [],
    {},
    { tableName: "memories" },
    { createdAt: {} },
    { createdAt: { $unknown: 1_720_000_000_000 } },
    { category: [] },
  ])("rejects a filter with no provider-consumed predicate: %j", (filter) => {
    expect(() => assertSafeLegacyDeleteFilter(filter)).toThrowError(LegacyDeleteFilterError);
  });

  test("treats dataType as a predicate only for providers that consume it", () => {
    expect(() => assertSafeLegacyDeleteFilter({ dataType: "memory" })).toThrowError(
      LegacyDeleteFilterError,
    );
    expect(() => assertSafeLegacyDeleteFilter(
      { tableName: "memories", dataType: "memory" },
      { consumesDataType: true },
    )).not.toThrow();
  });

  test.each([
    { id: "memory-1" },
    { pinned: false },
    { importance: 0 },
    { createdAt: { $gte: 1_720_000_000_000 } },
    { tableName: "knowledge", category: "architecture" },
  ])("keeps a legacy call with an explicit consumed condition: %j", (filter) => {
    expect(() => assertSafeLegacyDeleteFilter(filter)).not.toThrow();
  });
});

function postgresProvider(): PostgresProvider {
  return new PostgresProvider({
    host: "127.0.0.1",
    port: 5432,
    database: "never-used",
    user: "never-used",
    password: "never-used",
  }, "text-embedding-3-small");
}

describe("legacy provider deleteByFilter fail-closed boundary", () => {
  test.each([
    ["empty", {}],
    ["routing-only tableName", { tableName: "memories" }],
  ])("Postgres rejects %s before initialization", async (_label, filter) => {
    const provider = postgresProvider();
    const initialize = vi.spyOn(provider, "initialize").mockResolvedValue();

    await expect(provider.deleteByFilter(filter)).rejects.toMatchObject(DELETE_FILTER_REQUIRED);
    expect(initialize).not.toHaveBeenCalled();
  });

  test.each([
    ["empty", {}],
    ["routing-only tableName", { tableName: "knowledge" }],
  ])("Supabase rejects %s before initialization", async (_label, filter) => {
    const provider = new SupabaseProvider(
      "https://never-used.invalid",
      "never-used",
      "text-embedding-3-small",
    );
    const initialize = vi.spyOn(provider, "initialize").mockResolvedValue();

    await expect(provider.deleteByFilter(filter)).rejects.toMatchObject(DELETE_FILTER_REQUIRED);
    expect(initialize).not.toHaveBeenCalled();
  });

  test.each([
    ["empty", {}],
    ["routing-only tableName", { tableName: "memories" }],
    ["ignored dataType", { tableName: "memories", dataType: "memory" }],
  ])("LanceDB rejects %s before initialization", async (_label, filter) => {
    const provider = new LanceDBProvider("/never-used", "text-embedding-3-small");
    const initialize = vi.spyOn(provider, "initialize").mockResolvedValue();

    await expect(provider.deleteByFilter(filter)).rejects.toMatchObject(DELETE_FILTER_REQUIRED);
    expect(initialize).not.toHaveBeenCalled();
  });

  test.each([
    ["empty", {}],
    ["routing-only tableName", { tableName: "memories" }],
    ["inconsistent dataType-only", { tableName: "memories", dataType: "memory" }],
  ])("Hybrid rejects %s before delegating", async (_label, filter) => {
    const lance = {
      deleteByFilter: vi.fn().mockResolvedValue(0),
    } as unknown as LanceDBProvider;
    const supabase = {
      deleteByFilter: vi.fn().mockResolvedValue(0),
    } as unknown as SupabaseProvider;
    const provider = new HybridProvider(lance, supabase);

    await expect(provider.deleteByFilter(filter)).rejects.toMatchObject(DELETE_FILTER_REQUIRED);
    expect(lance.deleteByFilter).not.toHaveBeenCalled();
    expect(supabase.deleteByFilter).not.toHaveBeenCalled();
  });

  test("Postgres keeps a dataType predicate that it consumes", async () => {
    const provider = postgresProvider();
    const query = vi.fn().mockResolvedValue({ rowCount: 2 });
    (provider as unknown as { pool: { query: typeof query } }).pool = { query };

    await expect(provider.deleteByFilter({
      tableName: "memories",
      dataType: "memory",
    })).resolves.toBe(2);
    expect(query).toHaveBeenCalledWith(
      "DELETE FROM \"memories\" WHERE data_type = $1",
      ["memory"],
    );
  });

  test("Supabase keeps a dataType predicate that it consumes", async () => {
    const result = Promise.resolve({ error: null, count: 2 });
    const deleteQuery = {
      eq: vi.fn(),
      then: result.then.bind(result),
    };
    deleteQuery.eq.mockReturnValue(deleteQuery);
    const deleteCall = vi.fn().mockReturnValue(deleteQuery);
    const from = vi.fn().mockReturnValue({ delete: deleteCall });
    const provider = new SupabaseProvider(
      "https://never-used.invalid",
      "never-used",
      "text-embedding-3-small",
    );
    (provider as unknown as { client: { from: typeof from } }).client = { from };

    await expect(provider.deleteByFilter({
      tableName: "memories",
      dataType: "memory",
    })).resolves.toBe(2);
    expect(deleteQuery.eq).toHaveBeenCalledWith("data_type", "memory");
  });

  test("LanceDB keeps an explicit business predicate", async () => {
    const toArray = vi.fn().mockResolvedValue([{ id: "memory-1" }]);
    const queryBuilder = {
      filter: vi.fn(),
      select: vi.fn(),
      toArray,
    };
    queryBuilder.filter.mockReturnValue(queryBuilder);
    queryBuilder.select.mockReturnValue(queryBuilder);
    const table = {
      query: vi.fn().mockReturnValue(queryBuilder),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const dbPath = mkdtempSync(join(realpathSync(tmpdir()), "mengshu-delete-filter-"));
    const provider = new LanceDBProvider(dbPath, "text-embedding-3-small");
    (provider as unknown as { tables: Map<string, typeof table> }).tables = new Map([
      ["memories", table],
    ]);

    try {
      await expect(provider.deleteByFilter({
        tableName: "memories",
        category: "core",
      })).resolves.toBe(1);
      expect(table.delete).toHaveBeenCalledWith("category = 'core'");
    } finally {
      rmSync(dbPath, { recursive: true, force: true });
    }
  });

  test("Hybrid keeps an explicit predicate and delegates to both providers", async () => {
    const lance = {
      deleteByFilter: vi.fn().mockResolvedValue(1),
    } as unknown as LanceDBProvider;
    const supabase = {
      deleteByFilter: vi.fn().mockResolvedValue(1),
    } as unknown as SupabaseProvider;
    const provider = new HybridProvider(lance, supabase);
    const filter = { tableName: "memories", category: "core" };

    await expect(provider.deleteByFilter(filter)).resolves.toBe(1);
    expect(supabase.deleteByFilter).toHaveBeenCalledWith(filter);
    expect(lance.deleteByFilter).toHaveBeenCalledWith(filter);
  });
});
