import { describe, expect, test, vi } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  OPENCLAW_MEMORY_PLUGIN_ID,
  registerOpenClawAdapter,
  resolveOpenClawDbPath,
} from "./register.js";
import { createMengshuRuntime } from "../../../runtime.js";
import type { MemoryConfig } from "../../../config.js";
import type { DatabaseProvider, MemoryEntry, MemoryQueryOptions } from "../../../db/types.js";

class FakeDb implements DatabaseProvider {
  initialize = vi.fn(async () => {});
  close = vi.fn(async () => {});
  store = vi.fn(async (_entries: MemoryEntry[]) => {});
  query = vi.fn(async (_options: MemoryQueryOptions) => []);
  delete = vi.fn(async (_ids: string[]) => {});
  deleteByFilter = vi.fn(async (_filter: Record<string, unknown>) => 0);
  existsByContentHash = vi.fn(async (_contentHashes: string[]) => []);
  count = vi.fn(async (_filter?: Record<string, unknown>) => 0);
}

interface ToolEntry {
  tool: { name: string; execute(toolCallId: string, params: unknown): Promise<unknown> };
  opts: { name: string };
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
  autoRecall: true,
  autoCapture: true,
};

function makeApi() {
  const tools: ToolEntry[] = [];
  const clis: unknown[] = [];
  const services: Array<{ id: string; start(): Promise<void>; stop(): Promise<void> }> = [];
  const hooks: Array<{ name: string; handler: unknown }> = [];
  const memoryPromptSections: unknown[] = [];
  const memoryFlushPlans: unknown[] = [];
  const memoryRuntimes: unknown[] = [];
  const api = {
    pluginConfig: config,
    logger: { info: vi.fn(), warn: vi.fn() },
    resolvePath: (input: string) => input,
    registerTool: (tool: ToolEntry["tool"], opts: { name: string }) => tools.push({ tool, opts }),
    registerCli: (registrar: unknown) => clis.push(registrar),
    registerService: (service: { id: string; start(): Promise<void>; stop(): Promise<void> }) => services.push(service),
    on: (name: string, handler: unknown) => hooks.push({ name, handler }),
    registerMemoryPromptSection: (builder: unknown) => memoryPromptSections.push(builder),
    registerMemoryFlushPlan: (resolver: unknown) => memoryFlushPlans.push(resolver),
    registerMemoryRuntime: (runtime: unknown) => memoryRuntimes.push(runtime),
  };
  return {
    api: api as unknown as OpenClawPluginApi,
    tools,
    clis,
    services,
    hooks,
    memoryPromptSections,
    memoryFlushPlans,
    memoryRuntimes,
  };
}

describe("registerOpenClawAdapter", () => {
  test("expands home dbPath instead of resolving it relative to project", () => {
    const resolved = resolveOpenClawDbPath("~/.mengshu/memory/lancedb", (input) => `/project/${input}`);

    expect(resolved).toMatch(/\/\.mengshu\/memory\/lancedb$/);
    expect(resolved).not.toContain("/project/");
    expect(resolved).not.toContain("/~/");
  });

  test("keeps relative dbPath resolved by OpenClaw project resolver", () => {
    const resolved = resolveOpenClawDbPath(".mengshu/memory/lancedb", (input) => `/project/${input}`);

    expect(resolved).toBe("/project/.mengshu/memory/lancedb");
  });

  test("registers tools, CLI, hooks and service through runtime", async () => {
    const db = new FakeDb();
    const runtime = createMengshuRuntime({
      config,
      resolvedDbPath: config.dbPath!,
      appId: "openclaw",
      db,
    });
    const { api, tools, clis, services, hooks, memoryPromptSections, memoryFlushPlans, memoryRuntimes } = makeApi();

    registerOpenClawAdapter(api, config, { runtime });

    expect(tools.map((entry) => entry.opts.name)).toEqual([
      "memory_recall",
      "memory_store",
      "memory_forget",
      "memory_scan_directory",
      "memory_cleanup",
      "memory_context_fast",
    ]);
    expect(clis).toHaveLength(1);
    expect(hooks.map((hook) => hook.name).sort()).toEqual(["agent_end", "before_agent_start"]);
    expect(services).toHaveLength(1);
    expect(services[0].id).toBe(OPENCLAW_MEMORY_PLUGIN_ID);
    expect(memoryPromptSections).toHaveLength(1);
    expect(memoryFlushPlans).toHaveLength(1);
    expect(memoryRuntimes).toHaveLength(1);
    await services[0].start();
    await services[0].stop();
    expect(db.initialize).toHaveBeenCalledTimes(1);
    expect(db.close).toHaveBeenCalledTimes(1);
  });

  test("memory_recall tool passes runtime defaultScope to the memory service", async () => {
    const db = new FakeDb();
    const runtime = createMengshuRuntime({
      config,
      resolvedDbPath: config.dbPath!,
      appId: "openclaw",
      db,
    });
    const recallSpy = vi.spyOn(runtime.memoryService, "recall").mockResolvedValue({
      scope: runtime.defaultScope,
      query: "dark mode",
      hits: [],
    });
    const { api, tools } = makeApi();

    registerOpenClawAdapter(api, config, { runtime });

    const recallTool = tools.find((entry) => entry.opts.name === "memory_recall");
    expect(recallTool).toBeDefined();

    await recallTool!.tool.execute("call-1", { query: "dark mode" });

    expect(recallSpy).toHaveBeenCalledTimes(1);
    // Scope must match runtime.defaultScope so recall and store share the same isolation boundary
    expect(recallSpy.mock.calls[0][0]).toMatchObject({
      query: "dark mode",
      scope: {
        appId: "openclaw",
        tenantId: runtime.defaultScope.tenantId,
        userId: runtime.defaultScope.userId,
        projectId: runtime.defaultScope.projectId,
        agentId: runtime.defaultScope.agentId,
        namespace: runtime.defaultScope.namespace,
      },
    });
  });
});
