import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryAutodbRegistry } from "../../runtime/registry.js";

const calls: Array<{ sql: string; params?: unknown[] }> = [];
let ledger: Array<{ version: number; name: string; checksum: string }> = [];
let transactionLedger: typeof ledger | undefined;
let scopeCounts = {
  total_count: "3",
  canonical_count: "2",
  quarantined_count: "1",
  pending_count: "0",
  invalid_count: "0",
};

const query = vi.fn(async (sql: string, params?: unknown[]) => {
  calls.push({ sql, params });
  if (sql === "BEGIN") transactionLedger = [...ledger];
  if (sql === "COMMIT") {
    if (transactionLedger) ledger = [...transactionLedger];
    transactionLedger = undefined;
  }
  if (sql === "ROLLBACK") transactionLedger = undefined;
  if (/SELECT version, name, checksum FROM mengshu_schema_migrations/.test(sql)) {
    const rows = transactionLedger ?? ledger;
    return { rows: [...rows], rowCount: rows.length };
  }
  if (/INSERT INTO mengshu_schema_migrations/.test(sql)) {
    (transactionLedger ?? ledger).push({
      version: Number(params?.[0]),
      name: String(params?.[1]),
      checksum: String(params?.[2]),
    });
    return { rows: [], rowCount: 1 };
  }
  if (/FROM pg_class AS table_rel/.test(sql)) {
    const rows = ["memories", "knowledge"].flatMap((table) => [{
      table_name: table,
      index_name: `${table}_content_hash_key`,
      is_unique: true,
      is_valid: true,
      is_ready: true,
      predicate: null,
      index_columns: ["content_hash"],
    }]);
    return { rows, rowCount: rows.length };
  }
  if (/SELECT to_regclass\('public\.mengshu_schema_migrations'\)/.test(sql)) {
    return { rows: [{ ledger_relation: "mengshu_schema_migrations" }], rowCount: 1 };
  }
  if (/COUNT\(\*\).*canonical_count/s.test(sql)) {
    return {
      rows: [{ ...scopeCounts }],
      rowCount: 1,
    };
  }
  if (/SELECT id::text AS id, metadata/.test(sql)) {
    return { rows: [], rowCount: 0 };
  }
  if (/SELECT COUNT\(\*\)::text AS remaining_count/.test(sql)) {
    return { rows: [{ remaining_count: "0" }], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
});

vi.mock("pg", () => ({
  default: {
    Pool: class {
      query = query;
      async connect() {
        return { query, release: vi.fn() };
      }
      async end() {}
    },
  },
}));

import { PostgresProvider } from "./postgres.js";

const config = {
  host: "localhost",
  port: 5432,
  database: "mengshu-test",
  user: "test",
  password: "test",
};

const registry: MemoryAutodbRegistry = { version: 2, projects: {}, workspaces: {} };

describe("PostgresProvider scope cutover facade", () => {
  beforeEach(() => {
    calls.length = 0;
    ledger = [];
    transactionLedger = undefined;
    scopeCounts = {
      total_count: "3",
      canonical_count: "2",
      quarantined_count: "1",
      pending_count: "0",
      invalid_count: "0",
    };
    query.mockClear();
  });

  it("inspection 只暴露固定计数与 dry-run plan", async () => {
    const provider = new PostgresProvider(config, "text-embedding-3-small");

    await expect(provider.inspectScopeBackfill({
      table: "memories",
      registry,
    })).resolves.toEqual({
      table: "memories",
      total: 3,
      canonical: 2,
      quarantined: 1,
      pending: 0,
      plan: {
        mode: "dry-run",
        table: "memories",
        scanned: 0,
        resolved: 0,
        quarantined: 0,
        conflict: 0,
        skipped: 0,
        batches: 0,
      },
    });

    expect(calls.some(({ sql }) => /UPDATE\s+"memories"/.test(sql))).toBe(false);
    expect(calls.some(({ sql }) => /^(?:CREATE|ALTER|DROP|INSERT)\b/i.test(sql.trim()))).toBe(false);
  });

  it("schema status 在未初始化 provider 上只读 ledger，不 bootstrap/DDL", async () => {
    ledger = [
      // The read-only path validates the real names/checksums via the registry; use
      // an initialized sibling only to obtain the deterministic ledger fixture.
    ];
    const seeded = new PostgresProvider(config, "text-embedding-3-small");
    await seeded.initialize();
    await seeded.close();
    calls.length = 0;
    const provider = new PostgresProvider(config, "text-embedding-3-small");

    await expect(provider.getSchemaContractStatus()).resolves.toMatchObject({
      currentVersion: 5,
      targetVersion: 12,
      scopeContentHashDedupe: "pending",
    });

    expect(calls.some(({ sql }) => /^(?:CREATE|ALTER|DROP|INSERT)\b/i.test(sql.trim()))).toBe(false);
  });

  it("apply 缺 maintenance/quiescence 时在 backfill 写路径前拒绝", async () => {
    const provider = new PostgresProvider(config, "text-embedding-3-small");

    await expect(provider.applyScopeBackfill({
      table: "knowledge",
      registry,
      maintenance: false as never,
      quiescenceConfirmed: true,
      allowedQuarantine: 0,
    })).rejects.toThrow(/maintenance|quiescence/i);

    expect(calls.some(({ sql }) => /FOR UPDATE NOWAIT/.test(sql))).toBe(false);
  });

  it("confirmed apply 使用 dedicated facade 且空 pending 时幂等", async () => {
    scopeCounts = {
      total_count: "2",
      canonical_count: "2",
      quarantined_count: "0",
      pending_count: "0",
      invalid_count: "0",
    };
    const provider = new PostgresProvider(config, "text-embedding-3-small");

    await expect(provider.applyScopeBackfill({
      table: "knowledge",
      registry,
      maintenance: true,
      quiescenceConfirmed: true,
      allowedQuarantine: 0,
    })).resolves.toMatchObject({
      mode: "apply",
      table: "knowledge",
      scanned: 0,
    });

    expect(calls.some(({ sql }) => /FOR UPDATE NOWAIT/.test(sql))).toBe(true);
  });

  it("partial resume 接受 existing=allowed 且 planned=0", async () => {
    const provider = new PostgresProvider(config, "text-embedding-3-small");

    await expect(provider.applyScopeBackfill({
      table: "memories",
      registry,
      maintenance: true,
      quiescenceConfirmed: true,
      allowedQuarantine: 1,
    })).resolves.toMatchObject({
      mode: "apply",
      table: "memories",
      scanned: 0,
      quarantined: 0,
    });
  });

  it("existing+planned 与 per-table allowance 不相等时零写 fail-closed", async () => {
    const provider = new PostgresProvider(config, "text-embedding-3-small");

    await expect(provider.applyScopeBackfill({
      table: "memories",
      registry,
      maintenance: true,
      quiescenceConfirmed: true,
      allowedQuarantine: 0,
    })).rejects.toThrow(/unresolved|pending|allowance|scope/i);

    expect(calls.some(({ sql }) => /FOR UPDATE NOWAIT/.test(sql))).toBe(false);
  });

  it.each(["conflict", "skipped"] as const)(
    "plan %s > 0 时即使 allowance 相等也拒绝",
    async (field) => {
      scopeCounts = {
        total_count: "1",
        canonical_count: "0",
        quarantined_count: "0",
        pending_count: "1",
        invalid_count: "0",
      };
      const provider = new PostgresProvider(config, "text-embedding-3-small");
      vi.spyOn(provider, "inspectScopeBackfill").mockResolvedValue({
        table: "memories",
        total: 1,
        canonical: 0,
        quarantined: 0,
        pending: 1,
        plan: {
          mode: "dry-run",
          table: "memories",
          scanned: 1,
          resolved: 0,
          quarantined: 0,
          conflict: field === "conflict" ? 1 : 0,
          skipped: field === "skipped" ? 1 : 0,
          batches: 1,
        },
      });

      await expect(provider.applyScopeBackfill({
        table: "memories",
        registry,
        maintenance: true,
        quiescenceConfirmed: true,
        allowedQuarantine: 0,
      })).rejects.toThrow(/unresolved|pending|scope/i);
      expect(calls.some(({ sql }) => /FOR UPDATE NOWAIT/.test(sql))).toBe(false);
    },
  );
});
