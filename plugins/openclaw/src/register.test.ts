import { describe, expect, test, vi } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerOpenClawAdapter } from "./index.js";
import { createMengshuRuntime } from "../../runtime.js";
import type { MemoryConfig } from "../../config.js";
import type { DatabaseProvider, MemoryEntry, MemoryQueryOptions } from "../../db/types.js";

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
  const tools: Array<{ tool: { name: string }; opts: { name: string } }> = [];
  const clis: unknown[] = [];
  const services: Array<{ id: string; start(): Promise<void>; stop(): Promise<void> }> = [];
  const hooks: Array<{ name: string; handler: unknown }> = [];
  const api = {
    pluginConfig: config,
    logger: { info: vi.fn(), warn: vi.fn() },
    resolvePath: (input: string) => input,
    registerTool: (tool: { name: string }, opts: { name: string }) => tools.push({ tool, opts }),
    registerCli: (registrar: unknown) => clis.push(registrar),
    registerService: (service: { id: string; start(): Promise<void>; stop(): Promise<void> }) => services.push(service),
    on: (name: string, handler: unknown) => hooks.push({ name, handler }),
  };
  return { api: api as unknown as OpenClawPluginApi, tools, clis, services, hooks };
}

describe("registerOpenClawAdapter", () => {
  test("registers tools, CLI, hooks and service through runtime", async () => {
    const db = new FakeDb();
    const runtime = createMengshuRuntime({
      config,
      resolvedDbPath: config.dbPath!,
      appId: "openclaw",
      db,
    });
    const { api, tools, clis, services, hooks } = makeApi();

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
    await services[0].start();
    await services[0].stop();
    expect(db.initialize).toHaveBeenCalledTimes(1);
    expect(db.close).toHaveBeenCalledTimes(1);
  });
});
