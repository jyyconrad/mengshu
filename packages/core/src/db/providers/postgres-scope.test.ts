/**
 * Postgres provider scope 维度列单元测试（D-25）。
 *
 * 通过 mock pg.Pool 捕获 SQL 文本与参数，验证：
 * - ensureTable：CREATE TABLE 含 5 个 scope 列 + 2 个 scope 索引
 * - store：把 entry 的 scope 字段写入 project_name/app_name/... 列（NULL 兜底）
 * - query：projectName/appName 生成等值条件、projectPattern 生成 LIKE 条件，全部参数化
 *
 * 不依赖真实 postgres 连接，纯校验 SQL 生成与参数绑定。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// 捕获所有 pool.query 调用的 SQL 与参数
const queryCalls: Array<{ sql: string; params?: unknown[] }> = [];

const mockQuery = vi.fn(async (sql: string, params?: unknown[]) => {
  queryCalls.push({ sql, params });
  // 模拟向量查询返回一行，验证 rowToEntry 能读出 scope 列
  if (/<=>/.test(sql)) {
    return {
      rows: [
        {
          id: "id-1",
          text: "hello",
          content_hash: "h1",
          vector: [0.1, 0.2],
          importance: 0.7,
          category: "other",
          data_type: "memory",
          metadata: {},
          created_at: new Date().toISOString(),
          project_name: "memory-autodb",
          app_name: "claude-code",
          user_id: "u1",
          agent_id: "a1",
          workspace_id: "w1",
          similarity: 0.9,
        },
      ],
    };
  }
  return { rows: [], rowCount: 0 };
});

vi.mock("pg", () => {
  class FakePool {
    query = mockQuery;
    async end() {}
  }
  return { default: { Pool: FakePool } };
});

import { PostgresProvider } from "./postgres";
import type { MemoryEntry, MemoryQueryOptions } from "../types";

const PG_CONFIG = {
  host: "localhost",
  port: 5432,
  database: "test",
  user: "test",
  password: "test",
};

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    text: "记忆内容",
    contentHash: "hash-1",
    vector: [0.1, 0.2],
    importance: 0.7,
    category: "other" as MemoryEntry["category"],
    dataType: "memory",
    metadata: {},
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("PostgresProvider scope 维度列（D-25）", () => {
  beforeEach(() => {
    queryCalls.length = 0;
    mockQuery.mockClear();
  });

  describe("ensureTable / createTableIfNotExists", () => {
    it("CREATE TABLE 包含 5 个 scope 列", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      await provider.initialize();
      queryCalls.length = 0;
      await provider.ensureTable("memories");

      const createSql = queryCalls.find((c) => /CREATE TABLE IF NOT EXISTS/.test(c.sql))?.sql ?? "";
      expect(createSql).toContain("project_name TEXT");
      expect(createSql).toContain("app_name TEXT");
      expect(createSql).toContain("user_id TEXT");
      expect(createSql).toContain("agent_id TEXT");
      expect(createSql).toContain("workspace_id TEXT");
    });

    it("为存量表补列：ALTER TABLE ADD COLUMN IF NOT EXISTS", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      await provider.initialize();
      queryCalls.length = 0;
      await provider.ensureTable("memories");

      const alterSqls = queryCalls.filter((c) => /ALTER TABLE .* ADD COLUMN IF NOT EXISTS/.test(c.sql));
      const joined = alterSqls.map((c) => c.sql).join("\n");
      expect(joined).toContain("project_name TEXT");
      expect(joined).toContain("app_name TEXT");
      expect(joined).toContain("workspace_id TEXT");
    });

    it("创建 project_name 和 app_name 的 B-tree 索引", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      await provider.initialize();
      queryCalls.length = 0;
      await provider.ensureTable("memories");

      const idxSqls = queryCalls.filter((c) => /CREATE INDEX IF NOT EXISTS/.test(c.sql)).map((c) => c.sql);
      const joined = idxSqls.join("\n");
      expect(joined).toContain("idx_memories_project_name");
      expect(joined).toContain("(project_name)");
      expect(joined).toContain("idx_memories_app_name");
      expect(joined).toContain("(app_name)");
    });
  });

  describe("store 写入 scope 列", () => {
    it("把 entry 的 scope 字段写入对应列", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      await provider.store([
        makeEntry({
          projectName: "memory-autodb",
          appName: "claude-code",
          userId: "user-1",
          agentId: "agent-1",
          workspaceId: "ws-1",
        }),
      ]);

      const insert = queryCalls.find((c) => /INSERT INTO/.test(c.sql));
      expect(insert).toBeDefined();
      expect(insert!.sql).toContain("project_name");
      expect(insert!.sql).toContain("app_name");
      expect(insert!.sql).toContain("workspace_id");
      // 参数顺序：[..., project_name, app_name, user_id, agent_id, workspace_id]
      const params = insert!.params!;
      expect(params).toContain("memory-autodb");
      expect(params).toContain("claude-code");
      expect(params).toContain("user-1");
      expect(params).toContain("agent-1");
      expect(params).toContain("ws-1");
    });

    it("scope 字段缺失时写入 NULL", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      await provider.store([makeEntry()]);

      const insert = queryCalls.find((c) => /INSERT INTO/.test(c.sql));
      const params = insert!.params!;
      // 末 5 个参数应全部为 null
      const tail = params.slice(-5);
      expect(tail).toEqual([null, null, null, null, null]);
    });
  });

  describe("query 按 scope 过滤", () => {
    it("projectName 生成 project_name = $N 等值条件（参数化）", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      const options: MemoryQueryOptions = {
        vector: [0.1, 0.2],
        limit: 5,
        projectName: "memory-autodb",
      };

      await provider.query(options);

      const select = queryCalls.find((c) => /<=>/.test(c.sql));
      expect(select).toBeDefined();
      expect(select!.sql).toMatch(/project_name = \$\d+/);
      expect(select!.params).toContain("memory-autodb");
    });

    it("appName 生成 app_name = $N 等值条件", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      const options: MemoryQueryOptions = {
        vector: [0.1, 0.2],
        appName: "codex",
      };

      await provider.query(options);

      const select = queryCalls.find((c) => /<=>/.test(c.sql));
      expect(select!.sql).toMatch(/app_name = \$\d+/);
      expect(select!.params).toContain("codex");
    });

    it("projectPattern 生成 project_name LIKE $N 模糊条件", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      const options: MemoryQueryOptions = {
        vector: [0.1, 0.2],
        projectPattern: "%openclaw%",
      };

      await provider.query(options);

      const select = queryCalls.find((c) => /<=>/.test(c.sql));
      expect(select!.sql).toMatch(/project_name LIKE \$\d+/);
      expect(select!.params).toContain("%openclaw%");
    });

    it("非向量查询也应用 scope 过滤", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      const options: MemoryQueryOptions = {
        projectName: "proj-x",
        limit: 10,
      };

      await provider.query(options);

      const select = queryCalls.find((c) => /ORDER BY created_at DESC/.test(c.sql));
      expect(select).toBeDefined();
      expect(select!.sql).toMatch(/project_name = \$\d+/);
      expect(select!.params).toContain("proj-x");
    });

    it("未传 scope 字段时不注入 scope 条件", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      await provider.query({ vector: [0.1, 0.2] });

      const select = queryCalls.find((c) => /<=>/.test(c.sql));
      expect(select!.sql).not.toContain("project_name");
      expect(select!.sql).not.toContain("app_name");
    });

    it("rowToEntry 读回 scope 列", async () => {
      const provider = new PostgresProvider(PG_CONFIG, "text-embedding-3-small");
      const results = await provider.query({ vector: [0.1, 0.2] });

      expect(results).toHaveLength(1);
      expect(results[0].projectName).toBe("memory-autodb");
      expect(results[0].appName).toBe("claude-code");
      expect(results[0].userId).toBe("u1");
      expect(results[0].agentId).toBe("a1");
      expect(results[0].workspaceId).toBe("w1");
    });
  });
});
