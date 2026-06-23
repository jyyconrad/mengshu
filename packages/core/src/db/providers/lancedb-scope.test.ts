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
    expect(generic?.userId).toBeUndefined();
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
