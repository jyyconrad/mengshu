import { describe, expect, test } from "vitest";
import type { MemoryService } from "../../core/service-types.js";
import type { ContextBlock, MemoryRecord, RecallResult } from "../../core/types.js";
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

  test("keeps ingest as an explicit unimplemented placeholder with actionable hint", async () => {
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
});
