/**
 * LanceDB scope 维度列集成测试（D-25 / T3）。
 *
 * 验证 project_name / app_name / user_id / agent_id / workspace_id 五个独立列：
 *   - store 时把 MemoryEntry 上的 scope 字段写入对应列；
 *   - query 时按 projectName / appName 精确过滤、projectPattern LIKE 相似检索；
 *   - 读回时把 sentinel 空串还原成 undefined。
 *
 * 使用真实 LanceDB（临时目录），避免 mock 掩盖 Arrow schema 推断问题。
 * 若本机无法加载 LanceDB native binding，则整体 skip（与 provider 注释一致）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LanceDBProvider } from "./lancedb";
import type { MemoryEntry } from "../types";

const EMBEDDING_MODEL = "text-embedding-3-small";

let lancedbAvailable = true;
try {
  await import("@lancedb/lancedb");
} catch {
  lancedbAvailable = false;
}

const makeVector = (seed: number, dim = 1536): number[] =>
  Array.from({ length: dim }, (_, i) => ((seed + i) % 7) / 7);

const baseEntry = (overrides: Partial<MemoryEntry>): MemoryEntry => ({
  id: "",
  text: "示例记忆",
  contentHash: `hash-${Math.random()}`,
  vector: makeVector(1),
  importance: 0.5,
  category: "other",
  dataType: "memory",
  metadata: {},
  createdAt: Date.now(),
  tenantId: "tenant-default",
  userId: "user-default",
  canonicalProjectId: "project-default",
  productId: "app-default",
  producerId: "agent-default",
  namespace: "memories",
  visibility: "private",
  ...overrides,
});

describe.skipIf(!lancedbAvailable)("LanceDB scope 维度列", () => {
  let dbPath: string;
  let provider: LanceDBProvider;

  beforeAll(async () => {
    dbPath = mkdtempSync(join(tmpdir(), "mengshu-lancedb-scope-"));
    provider = new LanceDBProvider(dbPath, EMBEDDING_MODEL);
    await provider.initialize();

    await provider.store([
      baseEntry({
        text: "proj-A 的部署记忆",
        contentHash: "hash-a",
        vector: makeVector(2),
        projectName: "memory-autodb",
        appName: "codex",
        userId: "alice",
        tenantId: "tenant-a",
        agentId: "agent-1",
        workspaceId: "ws-1",
      }),
      baseEntry({
        text: "proj-B 的部署记忆",
        contentHash: "hash-b",
        vector: makeVector(3),
        projectName: "openclaw-core",
        appName: "claude-code",
      }),
      baseEntry({
        text: "无 scope 的通用记忆",
        contentHash: "hash-c",
        vector: makeVector(4),
      }),
      baseEntry({
        text: "openclaw 衍生项目记忆",
        contentHash: "hash-d",
        vector: makeVector(5),
        projectName: "openclaw-plugins",
      }),
    ]);
  });

  afterAll(async () => {
    await provider.close();
    rmSync(dbPath, { recursive: true, force: true });
  });

  it("store 写入的 scope 列在 query 时能读回（空值还原为 undefined）", async () => {
    const results = await provider.query({ vector: makeVector(2), limit: 10 });
    const projA = results.find((r) => r.contentHash === "hash-a");
    const generic = results.find((r) => r.contentHash === "hash-c");

    expect(projA).toBeDefined();
    expect(projA?.projectName).toBe("memory-autodb");
    expect(projA?.appName).toBe("codex");
    expect(projA?.userId).toBe("alice");
    expect(projA?.agentId).toBe("agent-1");
    expect(projA?.workspaceId).toBe("ws-1");

    expect(generic).toBeDefined();
    expect(generic?.projectName).toBeUndefined();
    expect(generic?.appName).toBeUndefined();
    expect(generic?.userId).toBe("user-default");
  });

  it("projectName 精确过滤只返回该项目记忆", async () => {
    const results = await provider.query({
      vector: makeVector(2),
      limit: 10,
      projectName: "memory-autodb",
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.projectName === "memory-autodb")).toBe(true);
  });

  it("tenant/user authority 在 limit 前走独立列 exact filter", async () => {
    const results = await provider.query({
      vector: makeVector(2),
      limit: 1,
      tenantId: "tenant-a",
      userId: "alice",
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ tenantId: "tenant-a", userId: "alice" });
  });

  it("同 authority/contentHash 串行写入返回真实 duplicate id", async () => {
    const first = await provider.store([
      baseEntry({
        id: "dedupe-first",
        text: "authority dedupe",
        contentHash: "hash-authority-dedupe",
        tenantId: "tenant-dedupe",
        userId: "user-dedupe",
      }),
    ]);
    const duplicate = await provider.store([
      baseEntry({
        id: "dedupe-second",
        text: "authority dedupe duplicate",
        contentHash: "hash-authority-dedupe",
        tenantId: "tenant-dedupe",
        userId: "user-dedupe",
      }),
    ]);

    expect(first).toEqual({
      inserted: 1,
      duplicates: 0,
      records: [{ requestedId: "dedupe-first", persistedId: "dedupe-first", stored: true }],
    });
    expect(duplicate).toEqual({
      inserted: 0,
      duplicates: 1,
      records: [{ requestedId: "dedupe-second", persistedId: "dedupe-first", stored: false }],
    });
  });

  it.each([
    ["app", { productId: "app-other" }],
    ["project", { canonicalProjectId: "project-other" }],
    ["agent", { producerId: "agent-other" }],
    ["namespace", { namespace: "knowledge" }],
    ["visibility", { visibility: "workspace" as const }],
  ])("相同 tenant/user/hash 在不同 %s 下各自持久化", async (dimension, override) => {
    const contentHash = `hash-full-scope-${dimension}`;
    const first = await provider.store([baseEntry({
      id: `full-scope-${dimension}-a`,
      contentHash,
      tenantId: "tenant-full-scope",
      userId: "user-full-scope",
    })]);
    const second = await provider.store([baseEntry({
      id: `full-scope-${dimension}-b`,
      contentHash,
      tenantId: "tenant-full-scope",
      userId: "user-full-scope",
      ...override,
    })]);

    expect(first.records[0]).toMatchObject({ stored: true });
    expect(second.records[0]).toMatchObject({
      requestedId: `full-scope-${dimension}-b`,
      persistedId: `full-scope-${dimension}-b`,
      stored: true,
    });
  });

  it.each([
    "tenantId",
    "userId",
    "canonicalProjectId",
    "productId",
    "producerId",
    "namespace",
    "visibility",
  ] as const)("legacy write missing canonical %s fails before initialization/write", async (field) => {
    const legacy = baseEntry({
      id: `legacy-missing-${field}`,
      contentHash: `legacy-missing-${field}`,
    });
    delete legacy[field];

    await expect(provider.store([legacy])).rejects.toThrow(
      new RegExp(`canonical scope field: ${field}`, "i"),
    );
  });

  it("相同 contentHash 在不同 authority 下可分别写入", async () => {
    const first = await provider.store([
      baseEntry({
        id: "authority-a-id",
        contentHash: "hash-cross-authority",
        tenantId: "tenant-a",
        userId: "authority-a",
      }),
    ]);
    const second = await provider.store([
      baseEntry({
        id: "authority-b-id",
        contentHash: "hash-cross-authority",
        tenantId: "tenant-a",
        userId: "authority-b",
      }),
    ]);

    expect(first.inserted).toBe(1);
    expect(second.inserted).toBe(1);
    expect(second.records[0]).toMatchObject({ persistedId: "authority-b-id", stored: true });
  });

  it("并发同 scope/contentHash 在单进程内只插入一次", async () => {
    const [first, second] = await Promise.all([
      provider.store([
        baseEntry({
          id: "concurrent-a",
          contentHash: "hash-concurrent-dedupe",
          tenantId: "tenant-concurrent",
          userId: "user-concurrent",
        }),
      ]),
      provider.store([
        baseEntry({
          id: "concurrent-b",
          contentHash: "hash-concurrent-dedupe",
          tenantId: "tenant-concurrent",
          userId: "user-concurrent",
        }),
      ]),
    ]);

    expect(first.inserted + second.inserted).toBe(1);
    expect(first.duplicates + second.duplicates).toBe(1);
    expect(second.records[0]?.persistedId).toBe(first.records[0]?.persistedId);
  });

  it("两个 provider 实例共享同一路径时也只插入一次", async () => {
    const secondProvider = new LanceDBProvider(dbPath, EMBEDDING_MODEL);
    try {
      const [first, second] = await Promise.all([
        provider.store([baseEntry({
          id: "multi-provider-a",
          contentHash: "hash-multi-provider-dedupe",
          tenantId: "tenant-multi-provider",
          userId: "user-multi-provider",
        })]),
        secondProvider.store([baseEntry({
          id: "multi-provider-b",
          contentHash: "hash-multi-provider-dedupe",
          tenantId: "tenant-multi-provider",
          userId: "user-multi-provider",
        })]),
      ]);

      expect(first.inserted + second.inserted).toBe(1);
      expect(first.duplicates + second.duplicates).toBe(1);
      expect(second.records[0]?.persistedId).toBe(first.records[0]?.persistedId);
    } finally {
      await secondProvider.close();
    }
  });

  it("tenant/user authority 必须成对且经过白名单，恶意 ID 在 query 前拒绝", async () => {
    await expect(provider.query({ vector: makeVector(2), tenantId: "tenant-a" }))
      .rejects.toThrow(/tenant.*user.*together|authority/i);
    await expect(provider.query({
      vector: makeVector(2),
      tenantId: "x' OR '1'='1",
      userId: "alice",
    })).rejects.toThrow(/authority/i);
    await expect(provider.query({
      vector: makeVector(2),
      tenantId: "tenant-a",
      userId: "alice",
      filter: { "x' OR TRUE --": "value" },
    })).rejects.toThrow(/metadata filter key is unsafe/i);
  });

  it("appName 精确过滤只返回该产品记忆", async () => {
    const results = await provider.query({
      vector: makeVector(2),
      limit: 10,
      appName: "claude-code",
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.appName === "claude-code")).toBe(true);
  });

  it("projectPattern LIKE 相似检索匹配同前缀项目", async () => {
    const results = await provider.query({
      vector: makeVector(2),
      limit: 10,
      projectPattern: "openclaw%",
    });
    const names = results.map((r) => r.projectName).sort();
    expect(names).toEqual(["openclaw-core", "openclaw-plugins"]);
  });

  it("非向量查询同样支持 scope 列过滤", async () => {
    const results = await provider.query({
      limit: 10,
      projectName: "memory-autodb",
    });
    expect(results.every((r) => r.projectName === "memory-autodb")).toBe(true);
  });

  it("table inventory/statistics 只返回已配置表并保持真实计数", async () => {
    await expect(provider.getTableNames()).resolves.toEqual(["memories", "knowledge"]);
    const stats = await provider.getTableStats();
    expect(stats.map(({ name }) => name).sort()).toEqual(["knowledge", "memories"]);
    expect(stats.find(({ name }) => name === "memories")?.count).toBeGreaterThan(0);
  });

  it("单引号注入被转义，不破坏查询", async () => {
    const results = await provider.query({
      vector: makeVector(2),
      limit: 10,
      projectName: "x' OR '1'='1",
    });
    // 转义后应当匹配不到任何记忆，而非返回全部
    expect(results).toHaveLength(0);
  });
});
