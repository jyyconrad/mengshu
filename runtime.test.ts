import { describe, expect, test, vi } from "vitest";
import type { DatabaseProvider, MemoryEntry, MemoryQueryOptions } from "./db/types.js";
import { createMengshuRuntime, toFriendlyMengshuError } from "./runtime.js";
import type { MemoryConfig } from "./config.js";
import { PostgresTreeRepository } from "./tree/postgres-repository.js";
import type { Embeddings } from "./processing/embeddings.js";

class FakeDb implements DatabaseProvider {
  initialize = vi.fn(async () => {});
  close = vi.fn(async () => {});
  store = vi.fn(async (_entries: MemoryEntry[]) => {});
  query = vi.fn(async (_options: MemoryQueryOptions) => []);
  delete = vi.fn(async (_ids: string[]) => {});
  deleteByFilter = vi.fn(async (_filter: Record<string, unknown>) => 0);
  existsByContentHash = vi.fn(async (_contentHashes: string[]) => []);
  count = vi.fn(async (_filter?: Record<string, unknown>) => 0);
  getTableStats = vi.fn(async () => [{ name: "memories" as const, count: 0 }]);
}

const config: MemoryConfig = {
  embedding: {
    provider: "openai",
    apiKey: "test-key",
    baseURL: "http://localhost:9999/v1",
    model: "text-embedding-3-small",
  },
  dbType: "lancedb",
  dbPath: "/tmp/mengshu-test",
};

describe("createMengshuRuntime", () => {
  test("constructs shared runtime and delegates lifecycle to db", async () => {
    const db = new FakeDb();
    const runtime = createMengshuRuntime({
      config,
      resolvedDbPath: "/tmp/mengshu-test",
      appId: "test-app",
      db,
    });

    expect(runtime.memoryService).toBeDefined();
    expect(runtime.ingestionPipeline).toBeDefined();
    expect(runtime.consoleApi).toBeDefined();
    expect(runtime.agentFastPath).toBeDefined();
    expect(Object.keys(runtime.handlers).sort()).toEqual([
      "build_tree",
      "extract_candidate",
      "extract_graph",
    ]);

    await runtime.start();
    await runtime.stop();
    expect(db.initialize).toHaveBeenCalledTimes(1);
    expect(db.close).toHaveBeenCalledTimes(1);
  });

  test("keeps friendly config errors", () => {
    expect(() =>
      createMengshuRuntime({
        config: {
          ...config,
          embedding: { ...config.embedding, apiKey: "" },
        },
        resolvedDbPath: "/tmp/mengshu-test",
        db: new FakeDb(),
      })
    ).toThrow("[Mengshu 配置错误] embedding.apiKey 未设置");
  });

  test("uses durable Postgres tree repository for postgres config", () => {
    const db = new FakeDb();
    const runtime = createMengshuRuntime({
      config: {
        ...config,
        dbType: "postgres",
        dbPath: undefined,
        postgres: {
          host: "127.0.0.1",
          port: 5432,
          database: "test",
          user: "postgres",
          password: "postgres",
        },
      },
      resolvedDbPath: "",
      appId: "test-app",
      db,
    });

    expect(runtime.treeRepository).toBeInstanceOf(PostgresTreeRepository);
  });

  test("agent observeLight persists observations through shared memory service", async () => {
    const db = new FakeDb();
    const embeddings = {
      embed: vi.fn(async () => Array.from({ length: 1536 }, () => 0.01)),
      embedBatch: vi.fn(),
    } as unknown as Embeddings;
    const runtime = createMengshuRuntime({
      config,
      resolvedDbPath: "/tmp/mengshu-test",
      appId: "test-app",
      db,
      embeddings,
    });

    const response = await runtime.agentFastPath.observeLight({
      scope: runtime.defaultScope,
      eventType: "user_input",
      text: "用户要求所有 agent 共享 OpenClaw Postgres 记忆库。",
      intent: "remember",
    });

    expect(response.ack).toBe(true);
    expect(db.store).toHaveBeenCalledTimes(1);
    const stored = db.store.mock.calls[0]?.[0]?.[0];
    expect(stored?.text).toContain("OpenClaw Postgres");
    expect(stored?.tableName).toBe("memories");
    expect(stored?.vector).toHaveLength(1536);
  });

  test("maps common provider errors to friendly errors", () => {
    expect(toFriendlyMengshuError(new Error("403 balance is insufficient")).message).toContain("余额不足");
    expect(toFriendlyMengshuError(new Error("401 unauthorized")).message).toContain("API 认证失败");
    expect(toFriendlyMengshuError(new Error("ECONNREFUSED")).message).toContain("无法连接到 Embedding API");
  });

  test("observeLight stores record with scope metadata for non-default scope", async () => {
    const db = new FakeDb();
    const embeddings = {
      embed: vi.fn(async () => Array.from({ length: 1536 }, () => 0.01)),
      embedBatch: vi.fn(),
    } as unknown as Embeddings;
    const runtime = createMengshuRuntime({
      config,
      resolvedDbPath: "/tmp/mengshu-test",
      appId: "test-app",
      db,
      embeddings,
    });

    await runtime.agentFastPath.observeLight({
      scope: { userId: "alice", projectId: "proj1", agentId: "agent1" },
      eventType: "user_input",
      text: "Alice 的项目任务",
      intent: "remember",
    });

    expect(db.store).toHaveBeenCalledTimes(1);
    const stored = db.store.mock.calls[0]?.[0]?.[0];
    expect(stored?.metadata?.userId).toBe("alice");
    expect(stored?.metadata?.projectPath).toBe("proj1");
    expect(stored?.metadata?.agentName).toBe("agent1");
  });

  test("observeLight stores record with default scope metadata for default scope", async () => {
    const db = new FakeDb();
    const embeddings = {
      embed: vi.fn(async () => Array.from({ length: 1536 }, () => 0.01)),
      embedBatch: vi.fn(),
    } as unknown as Embeddings;
    const runtime = createMengshuRuntime({
      config,
      resolvedDbPath: "/tmp/mengshu-test",
      appId: "test-app",
      db,
      embeddings,
    });

    await runtime.agentFastPath.observeLight({
      scope: { userId: "default" },
      eventType: "system_event",
      text: "全局观察",
    });

    expect(db.store).toHaveBeenCalledTimes(1);
    const stored = db.store.mock.calls[0]?.[0]?.[0];
    expect(stored?.metadata?.userId).toBe("default");
    expect(stored?.metadata?.projectPath).toBe("default");
    expect(stored?.metadata?.agentName).toBe("default");
  });
});
