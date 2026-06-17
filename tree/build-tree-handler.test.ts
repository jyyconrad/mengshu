/**
 * build_tree job handler 测试。
 *
 * 覆盖范围：
 * - leaf 追加到 buffer（未满不 seal）
 * - leaf 追加超 maxLeafCount 触发 seal（生成 SummaryNode，buffer 被删除）
 * - LlmClient 注入时用 abstractive 摘要
 * - LlmClient 未注入或 available=false 时 fallback extractive
 * - payload 缺必填字段抛错
 */

import { describe, expect, it, vi } from "vitest";
import { createBuildTreeHandler } from "./build-tree-handler.js";
import { InMemoryTreeRepository } from "./buffer.js";
import type { LlmClient } from "../processing/llm-client.js";
import type { MemoryScope } from "../core/types.js";
import type { JobRecord } from "../storage/repositories/types.js";

// Fake LlmClient（可用，返回指定摘要）
class FakeLlmClient implements LlmClient {
  public readonly available = true;
  public readonly summarizeText: string;

  constructor(summarizeText: string) {
    this.summarizeText = summarizeText;
  }

  async complete(): Promise<string> {
    return "fake completion";
  }

  async summarize(text: string, instruction: string): Promise<string> {
    return this.summarizeText;
  }

  async extractStructured<T>(args: any): Promise<T> {
    // 模拟结构化输出：返回符合 SealSummaryOutput schema 的对象
    return {
      title: "测试摘要",
      summary: this.summarizeText,
      keyFacts: [
        {
          text: "关键事实1",
          evidenceLeafIds: ["leaf-1"],
        },
      ],
      evidenceLeafIds: ["leaf-1"],
    } as T;
  }
}

// Fake LlmClient（不可用）
class UnavailableLlmClient implements LlmClient {
  public readonly available = false;

  async complete(): Promise<string> {
    throw new Error("LLM not configured");
  }

  async summarize(): Promise<string> {
    throw new Error("LLM not configured");
  }

  async extractStructured<T>(): Promise<T> {
    throw new Error("LLM not configured");
  }
}

describe("build_tree job handler", () => {
  const testScope: MemoryScope = {
    tenantId: "local",
    appId: "openclaw",
    userId: "u1",
    projectId: "p1",
    agentId: "default",
    namespace: "memories",
    sessionId: "test-session",
  };

  function makeJobPayload(payload: Record<string, unknown>): JobRecord {
    return {
      id: `job-${Date.now()}`,
      type: "build_tree",
      payload,
      dedupeKey: `build_tree:${Date.now()}`,
      status: "running",
      attempts: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  it("追加 leaf 到 buffer（未满不 seal）", async () => {
    const repository = new InMemoryTreeRepository();
    const handler = createBuildTreeHandler({ repository, policy: { maxLeafCount: 5 } });

    const leaf = {
      id: "leaf-1",
      chunkId: "chunk-1",
      sourceId: "source-1",
      text: "用户偏好深色主题",
      importance: 0.8,
      eventAt: Date.now(),
    };

    const result = await handler(
      makeJobPayload({
        scope: testScope,
        treeType: "source",
        treeKey: "user-pref",
        leaf,
      }),
    );

    expect(result).toEqual({ sealed: false, bufferId: expect.any(String) });
    const bufferId = (result as { sealed: false; bufferId: string }).bufferId;
    const buffer = await repository.getBuffer(bufferId);
    expect(buffer).toBeDefined();
    expect(buffer?.leafIds).toContain("leaf-1");
    expect(buffer?.leafIds).toHaveLength(1);
  });

  it("追加 leaf 超过 maxLeafCount 触发 seal", async () => {
    const repository = new InMemoryTreeRepository();
    const handler = createBuildTreeHandler({ repository, policy: { maxLeafCount: 2 } });

    const baseLeaf = {
      id: "",
      chunkId: "chunk-1",
      sourceId: "source-1",
      importance: 0.8,
      eventAt: Date.now(),
    };

    // 添加第一个 leaf（不 seal）
    await handler(
      makeJobPayload({
        scope: testScope,
        treeType: "topic",
        treeKey: "ui-preference",
        leaf: { ...baseLeaf, id: "leaf-1", text: "文本 1" },
      }),
    );

    // 添加第二个 leaf（触发 seal）
    const result = await handler(
      makeJobPayload({
        scope: testScope,
        treeType: "topic",
        treeKey: "ui-preference",
        leaf: { ...baseLeaf, id: "leaf-2", text: "文本 2" },
      }),
    );

    expect(result).toEqual({ sealed: true, nodeId: expect.any(String) });
    const nodeId = (result as { sealed: true; nodeId: string }).nodeId;
    const node = await repository.getSummary(nodeId);
    expect(node).toBeDefined();
    expect(node?.leafIds).toEqual(["leaf-1", "leaf-2"]);
    expect(node?.status).toBe("sealed");
  });

  it("LlmClient 注入时生成 abstractive 摘要", async () => {
    const repository = new InMemoryTreeRepository();
    const llmClient = new FakeLlmClient("这是一个抽象摘要");
    const handler = createBuildTreeHandler({
      repository,
      llmClient,
      policy: { maxLeafCount: 1 },
    });

    const leaf = {
      id: "leaf-1",
      chunkId: "chunk-1",
      sourceId: "source-1",
      text: "用户偏好深色主题，字体大小 16pt",
      importance: 0.9,
      eventAt: Date.now(),
    };

    const result = await handler(
      makeJobPayload({
        scope: testScope,
        treeType: "source",
        treeKey: "user-pref",
        leaf,
      }),
    );

    expect(result).toEqual({ sealed: true, nodeId: expect.any(String) });
    const nodeId = (result as { sealed: true; nodeId: string }).nodeId;
    const node = await repository.getSummary(nodeId);
    // 验证三级摘要结构：title + summary + keyFacts
    expect(node?.summary).toContain("# 测试摘要");
    expect(node?.summary).toContain("这是一个抽象摘要");
    expect(node?.summary).toContain("## 关键事实");
    expect(node?.metadata.summaryMode).toBe("abstractive");
  });

  it("LlmClient 不可用时 fallback 到 extractive 摘要", async () => {
    const repository = new InMemoryTreeRepository();
    const llmClient = new UnavailableLlmClient();
    const handler = createBuildTreeHandler({
      repository,
      llmClient,
      policy: { maxLeafCount: 1 },
    });

    const leaf = {
      id: "leaf-1",
      chunkId: "chunk-1",
      sourceId: "source-1",
      text: "用户偏好深色主题",
      importance: 0.9,
      eventAt: Date.now(),
    };

    const result = await handler(
      makeJobPayload({
        scope: testScope,
        treeType: "global",
        treeKey: "all-events",
        leaf,
      }),
    );

    expect(result).toEqual({ sealed: true, nodeId: expect.any(String) });
    const nodeId = (result as { sealed: true; nodeId: string }).nodeId;
    const node = await repository.getSummary(nodeId);
    expect(node?.summary).toBe("用户偏好深色主题");
    expect(node?.metadata.summaryMode).toBe("extractive");
  });

  it("LlmClient 未注入时使用 extractive 摘要", async () => {
    const repository = new InMemoryTreeRepository();
    const handler = createBuildTreeHandler({
      repository,
      policy: { maxLeafCount: 1 },
    });

    const leaf = {
      id: "leaf-1",
      chunkId: "chunk-1",
      sourceId: "source-1",
      text: "用户设置通知为关闭",
      importance: 0.7,
      eventAt: Date.now(),
    };

    const result = await handler(
      makeJobPayload({
        scope: testScope,
        treeType: "source",
        treeKey: "notifications",
        leaf,
      }),
    );

    expect(result).toEqual({ sealed: true, nodeId: expect.any(String) });
    const nodeId = (result as { sealed: true; nodeId: string }).nodeId;
    const node = await repository.getSummary(nodeId);
    expect(node?.summary).toBe("用户设置通知为关闭");
    expect(node?.metadata.summaryMode).toBe("extractive");
  });

  it("payload 缺失 scope 抛错", async () => {
    const repository = new InMemoryTreeRepository();
    const handler = createBuildTreeHandler({ repository });

    await expect(
      handler(
        makeJobPayload({
          treeType: "source",
          treeKey: "key-1",
          leaf: { id: "leaf-1", chunkId: "chunk-1", sourceId: "source-1" },
        }),
      ),
    ).rejects.toThrow("Missing required field: scope");
  });

  it("payload 缺失 treeType 抛错", async () => {
    const repository = new InMemoryTreeRepository();
    const handler = createBuildTreeHandler({ repository });

    await expect(
      handler(
        makeJobPayload({
          scope: testScope,
          treeKey: "key-1",
          leaf: { id: "leaf-1", chunkId: "chunk-1", sourceId: "source-1" },
        }),
      ),
    ).rejects.toThrow("Missing required field: treeType");
  });

  it("payload 缺失 treeKey 抛错", async () => {
    const repository = new InMemoryTreeRepository();
    const handler = createBuildTreeHandler({ repository });

    await expect(
      handler(
        makeJobPayload({
          scope: testScope,
          treeType: "topic",
          leaf: { id: "leaf-1", chunkId: "chunk-1", sourceId: "source-1" },
        }),
      ),
    ).rejects.toThrow("Missing required field: treeKey");
  });

  it("payload leaf 缺失 id 抛错", async () => {
    const repository = new InMemoryTreeRepository();
    const handler = createBuildTreeHandler({ repository });

    await expect(
      handler(
        makeJobPayload({
          scope: testScope,
          treeType: "source",
          treeKey: "key-1",
          leaf: { chunkId: "chunk-1", sourceId: "source-1" },
        }),
      ),
    ).rejects.toThrow("Missing required field: leaf.id");
  });

  it("payload leaf 缺失 chunkId 抛错", async () => {
    const repository = new InMemoryTreeRepository();
    const handler = createBuildTreeHandler({ repository });

    await expect(
      handler(
        makeJobPayload({
          scope: testScope,
          treeType: "source",
          treeKey: "key-1",
          leaf: { id: "leaf-1", sourceId: "source-1" },
        }),
      ),
    ).rejects.toThrow("Missing required field: leaf.chunkId");
  });

  it("payload leaf 缺失 sourceId 抛错", async () => {
    const repository = new InMemoryTreeRepository();
    const handler = createBuildTreeHandler({ repository });

    await expect(
      handler(
        makeJobPayload({
          scope: testScope,
          treeType: "source",
          treeKey: "key-1",
          leaf: { id: "leaf-1", chunkId: "chunk-1" },
        }),
      ),
    ).rejects.toThrow("Missing required field: leaf.sourceId");
  });

  it("补全 leaf 默认字段（entityIds、importance、eventAt、tokenCount）", async () => {
    const repository = new InMemoryTreeRepository();
    const handler = createBuildTreeHandler({ repository, policy: { maxLeafCount: 10 } });

    const now = Date.now();
    await handler(
      makeJobPayload({
        scope: testScope,
        treeType: "source",
        treeKey: "test-key",
        leaf: {
          id: "leaf-1",
          chunkId: "chunk-1",
          sourceId: "source-1",
          text: "这是一段测试文本",
        },
      }),
    );

    const storedLeaf = await repository.getLeaf("leaf-1");
    expect(storedLeaf).toBeDefined();
    expect(storedLeaf?.entityIds).toEqual([]);
    expect(storedLeaf?.importance).toBe(0.5);
    expect(storedLeaf?.eventAt).toBeGreaterThanOrEqual(now);
    expect(storedLeaf?.tokenCount).toBe(Math.ceil("这是一段测试文本".length / 4));
  });

  it("treeType 非法值抛错", async () => {
    const repository = new InMemoryTreeRepository();
    const handler = createBuildTreeHandler({ repository });

    await expect(
      handler(
        makeJobPayload({
          scope: testScope,
          treeType: "invalid-type",
          treeKey: "key-1",
          leaf: { id: "leaf-1", chunkId: "chunk-1", sourceId: "source-1" },
        }),
      ),
    ).rejects.toThrow("Invalid treeType");
  });
});
