import { afterAll, beforeAll, describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MemoryService } from "../../../core/service-types.js";
import type { ContextBlock, MemoryRecord, RecallResult } from "../../../core/types.js";
import type { IngestInput, IngestResult } from "../../core/src/ingest/types.js";
import type { IngestionPipeline } from "../../core/src/ingest/pipeline.js";
import { createMcpMemoryTools } from "./tools.js";

const scope = {
  tenantId: "local",
  appId: "openclaw",
  userId: "user-1",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "memories",
};

const record: MemoryRecord = {
  id: "mem-1",
  scope,
  kind: "preference",
  text: "User prefers concise replies",
  contentHash: "hash-1",
  importance: 0.8,
  category: "preference",
  dataType: "memory",
  tableName: "memories",
  metadata: {},
  provenance: {},
  createdAt: 1710000000000,
};

class FakeMemoryService implements MemoryService {
  calls: string[] = [];

  async storeMemory() {
    this.calls.push("storeMemory");
    return { id: "mem-1", stored: true };
  }

  async recall(): Promise<RecallResult> {
    this.calls.push("recall");
    return { scope, query: "concise", hits: [{ record, score: 0.9, source: "vector" }] };
  }

  async buildContext(): Promise<ContextBlock> {
    this.calls.push("buildContext");
    return { scope, content: "safe", hits: [], tokenEstimate: 1 };
  }

  async delete() {
    this.calls.push("delete");
    return { deleted: 1 };
  }

  async health() {
    this.calls.push("health");
    return { ok: true, records: 1 };
  }
}

/** 记录 ingest 调用入参的假 pipeline。 */
class FakePipeline {
  inputs: IngestInput[] = [];

  async ingest(input: IngestInput): Promise<IngestResult> {
    this.inputs.push(input);
    return {
      documentId: "doc:fake",
      chunksAdmitted: 2,
      chunksDropped: 0,
      jobsQueued: 2,
    };
  }
}

const ingestScope = {
  tenantId: "local",
  appId: "mengshu",
  userId: "user-1",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "knowledge",
};

describe("MCP memory tools", () => {
  test("exposes the planned core tool names", () => {
    const tools = createMcpMemoryTools({ service: new FakeMemoryService() });

    expect(tools.map((tool) => tool.name)).toEqual([
      "memory_save",
      "memory_recall",
      "memory_context",
      "memory_observe",
      "memory_ingest",
      "memory_namespaces",
      "memory_forget",
      "memory_health",
    ]);
  });

  test("maps core tools to MemoryService calls", async () => {
    const service = new FakeMemoryService();
    const tools = createMcpMemoryTools({ service });
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    await expect(byName.memory_save.execute({ record })).resolves.toEqual({ id: "mem-1", stored: true });
    await expect(byName.memory_observe.execute({ record })).resolves.toEqual({ id: "mem-1", stored: true });
    await expect(byName.memory_recall.execute({ query: "concise" })).resolves.toMatchObject({ query: "concise" });
    await expect(byName.memory_context.execute({ query: "concise" })).resolves.toMatchObject({ content: "safe" });
    await expect(byName.memory_forget.execute({ ids: ["mem-1"] })).resolves.toEqual({ deleted: 1 });
    await expect(byName.memory_health.execute({})).resolves.toEqual({ ok: true, records: 1 });

    expect(service.calls).toEqual([
      "storeMemory",
      "storeMemory",
      "recall",
      "buildContext",
      "delete",
      "health",
    ]);
  });

  test("reports namespaces from configured defaults", async () => {
    const tools = createMcpMemoryTools({
      service: new FakeMemoryService(),
      namespaces: ["memories", "knowledge"],
    });
    const namespaces = tools.find((tool) => tool.name === "memory_namespaces");

    await expect(namespaces?.execute({})).resolves.toEqual({ namespaces: ["memories", "knowledge"] });
  });

  test("memory_ingest stays unimplemented when no pipeline is injected", async () => {
    const tools = createMcpMemoryTools({ service: new FakeMemoryService() });
    const ingest = tools.find((tool) => tool.name === "memory_ingest");

    const result = (await ingest?.execute({ source: "file-system" })) as {
      status?: string;
      error?: string;
      hint?: string;
    };
    expect(result.status).toBe("not_implemented");
    expect(result.error).toMatch(/暂未开放|roadmap/i);
    // 必须给出可操作替代方案，避免调用方误判为配置错误。
    expect(result.hint).toMatch(/memory_observe|memory_save|ms scan/);
  });

  describe("memory_ingest with injected pipeline", () => {
    let tmpDir: string;
    let mdPath: string;

    beforeAll(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mengshu-ingest-tool-"));
      mdPath = path.join(tmpDir, "doc.md");
      fs.writeFileSync(mdPath, "# Title\n\nsome body content for ingest");
    });

    afterAll(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test("ingests raw text and returns document summary", async () => {
      const pipeline = new FakePipeline();
      const tools = createMcpMemoryTools({
        service: new FakeMemoryService(),
        pipeline: pipeline as unknown as IngestionPipeline,
      });
      const ingest = tools.find((tool) => tool.name === "memory_ingest");

      const result = (await ingest?.execute({
        source: "hello world body",
        sourceType: "text",
        scope: ingestScope,
      })) as { documentId?: string; chunksAdmitted?: number };

      expect(result.documentId).toBe("doc:fake");
      expect(result.chunksAdmitted).toBe(2);
      expect(pipeline.inputs).toHaveLength(1);
      expect(pipeline.inputs[0].scope).toEqual(ingestScope);
      // prompt 注入防护：内容前应插入不可信数据警告 header。
      expect(pipeline.inputs[0].content).toMatch(/untrusted|不可信|do not follow/i);
      expect(pipeline.inputs[0].content).toContain("hello world body");
    });

    test("ingests a file path via safe loader", async () => {
      const pipeline = new FakePipeline();
      const tools = createMcpMemoryTools({
        service: new FakeMemoryService(),
        pipeline: pipeline as unknown as IngestionPipeline,
      });
      const ingest = tools.find((tool) => tool.name === "memory_ingest");

      const result = (await ingest?.execute({
        source: mdPath,
        sourceType: "file",
        scope: ingestScope,
      })) as { documentId?: string };

      expect(result.documentId).toBe("doc:fake");
      expect(pipeline.inputs).toHaveLength(1);
      expect(pipeline.inputs[0].content).toContain("some body content for ingest");
    });

    test("dryRun returns chunk preview without persisting", async () => {
      const pipeline = new FakePipeline();
      const tools = createMcpMemoryTools({
        service: new FakeMemoryService(),
        pipeline: pipeline as unknown as IngestionPipeline,
      });
      const ingest = tools.find((tool) => tool.name === "memory_ingest");

      const result = (await ingest?.execute({
        source: "preview body content",
        sourceType: "text",
        scope: ingestScope,
        dryRun: true,
      })) as { dryRun?: boolean; chunkCount?: number };

      expect(result.dryRun).toBe(true);
      expect(result.chunkCount).toBeGreaterThanOrEqual(1);
      // dryRun 不得触达持久化 pipeline。
      expect(pipeline.inputs).toHaveLength(0);
    });

    test("rejects path traversal in file source", async () => {
      const pipeline = new FakePipeline();
      const tools = createMcpMemoryTools({
        service: new FakeMemoryService(),
        pipeline: pipeline as unknown as IngestionPipeline,
      });
      const ingest = tools.find((tool) => tool.name === "memory_ingest");

      await expect(
        ingest?.execute({ source: "../../etc/passwd", sourceType: "file", scope: ingestScope }),
      ).rejects.toThrow(/path traversal|遍历|\.\./i);
      expect(pipeline.inputs).toHaveLength(0);
    });

    test("rejects unsupported file extension", async () => {
      const pipeline = new FakePipeline();
      const tools = createMcpMemoryTools({
        service: new FakeMemoryService(),
        pipeline: pipeline as unknown as IngestionPipeline,
      });
      const ingest = tools.find((tool) => tool.name === "memory_ingest");

      await expect(
        ingest?.execute({ source: "/tmp/script.sh", sourceType: "file", scope: ingestScope }),
      ).rejects.toThrow(/unsupported|扩展名|extension/i);
      expect(pipeline.inputs).toHaveLength(0);
    });
  });

  test("every tool exposes a JSON Schema inputSchema object", () => {
    const tools = createMcpMemoryTools({ service: new FakeMemoryService() });

    for (const tool of tools) {
      expect(tool.inputSchema).toBeTypeOf("object");
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema).toHaveProperty("properties");
    }
  });

  test("keeps 8 base tools when no agentFastPath is injected", () => {
    const tools = createMcpMemoryTools({ service: new FakeMemoryService() });
    expect(tools).toHaveLength(8);
    expect(tools.map((tool) => tool.name)).not.toContain("memory_context_fast");
  });

  test("adds 3 fast-path tools when agentFastPath is injected", async () => {
    const calls: string[] = [];
    const fastPath = {
      async context() {
        calls.push("context");
        return { scope, slots: {}, content: "ctx" };
      },
      async observeLight() {
        calls.push("observeLight");
        return { ack: true as const, traceId: "t-1", queuedJobs: [] };
      },
      async lookup() {
        calls.push("lookup");
        return { hits: [], telemetry: { latencyMs: 1, mode: "fast" as const } };
      },
    };

    const tools = createMcpMemoryTools({
      service: new FakeMemoryService(),
      // 只用到 3 个方法，用最小桩替身注入
      agentFastPath: fastPath as unknown as Parameters<
        typeof createMcpMemoryTools
      >[0]["agentFastPath"],
    });

    expect(tools).toHaveLength(11);
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("memory_context_fast");
    expect(names).toContain("memory_observe_light");
    expect(names).toContain("memory_lookup");

    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    await byName.memory_context_fast.execute({ scope, task: "t" });
    await byName.memory_observe_light.execute({ scope, eventType: "user_input", text: "x" });
    await byName.memory_lookup.execute({ scope, query: "q" });

    expect(calls).toEqual(["context", "observeLight", "lookup"]);
  });

  describe("defaultScope 自动填充（DEFECT-001 修复）", () => {
    test("未配置 defaultScope 时，客户端未传递 scope 不会崩溃", async () => {
      const service = new FakeMemoryService();
      const tools = createMcpMemoryTools({ service });
      const observeTool = tools.find((t) => t.name === "memory_observe");

      // 客户端未传递 scope
      await expect(
        observeTool!.execute({
          record: {
            id: "test-1",
            text: "test content",
            kind: "preference",
            contentHash: "hash-1",
            importance: 0.5,
            category: "test",
            dataType: "memory",
            tableName: "memories",
            metadata: {},
            provenance: {},
            createdAt: Date.now(),
            // scope 未传递
          },
        })
      ).resolves.toBeDefined();

      expect(service.calls).toContain("storeMemory");
    });

    test("配置 defaultScope 后，自动填充到客户端调用中", async () => {
      let capturedInput: unknown = null;
      const service = new FakeMemoryService();
      service.storeMemory = (async (input: unknown) => {
        capturedInput = input;
        return { id: "mem-1", stored: true };
      }) as unknown as typeof service.storeMemory;

      const tools = createMcpMemoryTools({
        service,
        defaultScope: {
          tenantId: "claude-code",
          appId: "mengshu",
          projectId: "memory-autodb",
        },
      });

      const observeTool = tools.find((t) => t.name === "memory_observe");
      await observeTool!.execute({
        record: {
          id: "test-2",
          text: "test content",
          kind: "preference",
          contentHash: "hash-2",
          importance: 0.5,
          category: "test",
          dataType: "memory",
          tableName: "memories",
          metadata: {},
          provenance: {},
          createdAt: Date.now(),
          // 客户端未传递 scope
        },
      });

      // 验证 scope 包含了默认值
      expect(capturedInput).toMatchObject({
        record: expect.objectContaining({
          scope: expect.objectContaining({
            tenantId: "claude-code",
            appId: "mengshu",
            projectId: "memory-autodb",
          }),
        }),
      });
    });

    test("客户端传递的 scope 字段优先级高于 defaultScope", async () => {
      let capturedInput: unknown = null;
      const service = new FakeMemoryService();
      service.storeMemory = (async (input: unknown) => {
        capturedInput = input;
        return { id: "mem-1", stored: true };
      }) as unknown as typeof service.storeMemory;

      const tools = createMcpMemoryTools({
        service,
        defaultScope: {
          tenantId: "default-tenant",
          appId: "default-app",
        },
      });

      const observeTool = tools.find((t) => t.name === "memory_observe");
      await observeTool!.execute({
        record: {
          id: "test-3",
          text: "test content",
          kind: "preference",
          contentHash: "hash-3",
          importance: 0.5,
          category: "test",
          dataType: "memory",
          tableName: "memories",
          metadata: {},
          provenance: {},
          createdAt: Date.now(),
          scope: {
            tenantId: "custom-tenant", // 客户端传递的优先
            // appId 未传递，应使用默认值
          },
        },
      });

      // 验证：tenantId 使用客户端传递的，appId 使用默认值
      expect(capturedInput).toMatchObject({
        record: expect.objectContaining({
          scope: expect.objectContaining({
            tenantId: "custom-tenant", // 客户端值
            appId: "default-app", // 默认值
          }),
        }),
      });
    });

    test("memory_recall 也应用 defaultScope", async () => {
      let capturedInput: unknown = null;
      const service = new FakeMemoryService();
      service.recall = (async (input: unknown) => {
        capturedInput = input;
        return { scope: scope, query: "", hits: [] };
      }) as unknown as typeof service.recall;

      const tools = createMcpMemoryTools({
        service,
        defaultScope: {
          tenantId: "recall-tenant",
        },
      });

      const recallTool = tools.find((t) => t.name === "memory_recall");
      await recallTool!.execute({
        query: "test query",
        // scope 未传递
      });

      expect(capturedInput).toMatchObject({
        scope: expect.objectContaining({
          tenantId: "recall-tenant",
        }),
      });
    });

    test("fast path 工具也应用 defaultScope", async () => {
      let capturedInput: unknown = null;
      const fastPath = {
        async context(input: unknown) {
          capturedInput = input;
          return { scope: {}, slots: {}, content: "ctx" };
        },
        async observeLight() {
          return { ack: true as const, traceId: "t-1", queuedJobs: [] };
        },
        async lookup() {
          return { hits: [], telemetry: { latencyMs: 1, mode: "fast" as const } };
        },
      };

      const tools = createMcpMemoryTools({
        service: new FakeMemoryService(),
        agentFastPath: fastPath as unknown as Parameters<
          typeof createMcpMemoryTools
        >[0]["agentFastPath"],
        defaultScope: {
          tenantId: "fastpath-tenant",
          projectId: "fastpath-project",
        },
      });

      const contextFastTool = tools.find((t) => t.name === "memory_context_fast");
      await contextFastTool!.execute({
        task: "test task",
        // scope 未传递
      });

      expect(capturedInput).toMatchObject({
        scope: expect.objectContaining({
          tenantId: "fastpath-tenant",
          projectId: "fastpath-project",
        }),
      });
    });
  });
});
