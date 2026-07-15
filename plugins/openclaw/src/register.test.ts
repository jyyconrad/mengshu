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
import { createEmbeddingSpace, type KnownEmbeddingSpace } from "../../../packages/core/src/domain/embedding-space.js";
import { PostgresForgetTransactionPort } from "../../../packages/core/src/db/providers/postgres-forget-transaction.js";
import { PostgresProvider } from "../../../packages/core/src/db/providers/postgres.js";
import { createNativeDurableJobV2ServeCapability } from "../../../server/runtime-host-factory.js";
import { createAuthoritativeDurableJobV2WorkerHandlerRegistry } from "../../../server/workers-v2.js";
import { createExactOpenClawAuthority } from "./authority.js";

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

class RegistryFakeDb extends FakeDb {
  getActiveEmbeddingSpace = vi.fn<() => Promise<KnownEmbeddingSpace | null>>(async () => null);
}

class TransactionalRegistryFakeDb extends RegistryFakeDb {
  createForgetTransactionPort = () => new PostgresForgetTransactionPort({
    connect: async () => {
      throw new Error("test transaction must not execute");
    },
  });
}

type DurableRegistryFakeDb = PostgresProvider & RegistryFakeDb;

function durableRegistryFakeDb(): DurableRegistryFakeDb {
  const provider = new PostgresProvider({
    host: "unused",
    port: 5432,
    database: "unused",
    user: "unused",
    password: "unused",
  }, "text-embedding-3-small");
  return Object.assign(provider, {
    initialize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    store: vi.fn(async (_entries: MemoryEntry[]) => {}),
    query: vi.fn(async (_options: MemoryQueryOptions) => []),
    delete: vi.fn(async (_ids: string[]) => {}),
    deleteByFilter: vi.fn(async (_filter: Record<string, unknown>) => 0),
    existsByContentHash: vi.fn(async (_contentHashes: string[]) => []),
    count: vi.fn(async (_filter?: Record<string, unknown>) => 0),
    getActiveEmbeddingSpace: vi.fn<() => Promise<KnownEmbeddingSpace | null>>(async () => null),
  }) as DurableRegistryFakeDb;
}

function nativeDurableCapability(db: DurableRegistryFakeDb) {
  const registry = createAuthoritativeDurableJobV2WorkerHandlerRegistry({
    build_tree: async () => undefined,
    extract_candidate: async () => undefined,
    extract_graph: async () => undefined,
  });
  const runtimeBundle = db.createDurableJobV2RuntimeBundle({
    clock: () => 100,
    tokenFactory: () => "a".repeat(32),
    backoffMs: () => 100,
  });
  return {
    runtimeBundle,
    capability: createNativeDurableJobV2ServeCapability({
      repository: runtimeBundle.repository,
      registry,
      scope: {
        tenantId: "default",
        userId: "default",
        appId: "openclaw",
        projectId: "default",
        agentId: "default",
        namespace: "default",
        visibility: "private",
      },
    }),
  };
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

const postgresConfig: MemoryConfig = {
  ...config,
  dbType: "postgres",
  dbPath: undefined,
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
    logger: api.logger,
  };
}

function registeredAuthority(runtime: ReturnType<typeof createMengshuRuntime>) {
  return createExactOpenClawAuthority(runtime.defaultScope);
}

class FakeCommand {
  subcommands: FakeCommand[] = [];
  actionHandler?: (...args: unknown[]) => unknown;

  constructor(readonly name: string) {}

  command(name: string) {
    const command = new FakeCommand(name);
    this.subcommands.push(command);
    return command;
  }

  description() { return this; }
  option() { return this; }
  action(handler: (...args: unknown[]) => unknown) {
    this.actionHandler = handler;
    return this;
  }
}

function registeredMsCommand(clis: unknown[]): FakeCommand {
  const program = new FakeCommand("root");
  const registrar = clis[0] as (context: { program: FakeCommand }) => void;
  registrar({ program });
  return program.subcommands.find((command) => command.name === "ms")!;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe("registerOpenClawAdapter", () => {
  test("self-created runtime 缺少显式 authenticated authority 时在任何 host/path 副作用前拒绝", () => {
    const { api, tools, clis, services, hooks } = makeApi();
    const resolvePath = vi.spyOn(api, "resolvePath");

    expect(() => registerOpenClawAdapter(api, { ...config, dbPath: ".mengshu/test" }))
      .toThrow(/authenticated.*authority|authority.*required/i);

    expect(resolvePath).not.toHaveBeenCalled();
    expect(tools).toEqual([]);
    expect(clis).toEqual([]);
    expect(services).toEqual([]);
    expect(hooks).toEqual([]);
  });

  test("injected runtime 缺少显式 server authority 时拒绝注册且不启动", () => {
    const db = new FakeDb();
    const runtime = createMengshuRuntime({
      config,
      resolvedDbPath: config.dbPath!,
      appId: "openclaw",
      db,
    });
    const { api, tools, services, hooks } = makeApi();

    expect(() => registerOpenClawAdapter(api, config, { runtime })).toThrow(/authority/i);
    expect(tools).toEqual([]);
    expect(services).toEqual([]);
    expect(hooks).toEqual([]);
    expect(db.initialize).not.toHaveBeenCalled();
  });

  test("OpenClaw serve 缺 durable job v2 capability 时 fail-closed 且不启动 listener", async () => {
    const runtime = createMengshuRuntime({
      config,
      resolvedDbPath: config.dbPath!,
      appId: "openclaw",
      db: new FakeDb(),
    });
    const startServer = vi.fn();
    const { api, clis } = makeApi();
    registerOpenClawAdapter(api, config, {
      runtime,
      authority: registeredAuthority(runtime),
      startServer: startServer as never,
    });
    const ms = registeredMsCommand(clis);

    await expect(ms.subcommands.find((command) => command.name === "serve")?.actionHandler?.({}))
      .rejects.toThrow(/durable job v2 serve capability/i);

    expect(startServer).not.toHaveBeenCalled();
  });

  test("OpenClaw serve 将 v2 RuntimeHost 注入 daemon 且 worker 明确为 undefined", async () => {
    const db = durableRegistryFakeDb();
    const trusted = nativeDurableCapability(db);
    const runtime = createMengshuRuntime({
      config: postgresConfig,
      resolvedDbPath: "",
      appId: "openclaw",
      db,
      durableJobV2ServeCapability: trusted.capability,
      durableJobV2RuntimeBundle: trusted.runtimeBundle,
    });
    const captured = new Error("captured before listener");
    const startServer = vi.fn(async () => { throw captured; });
    const { api, clis } = makeApi();
    registerOpenClawAdapter(api, postgresConfig, {
      runtime,
      authority: registeredAuthority(runtime),
      startServer: startServer as never,
    });
    const ms = registeredMsCommand(clis);

    await expect(ms.subcommands.find((command) => command.name === "serve")?.actionHandler?.({}))
      .rejects.toBe(captured);

    expect(startServer).toHaveBeenCalledWith(expect.objectContaining({
      runtimeHost: expect.objectContaining({
        start: expect.any(Function),
        stop: expect.any(Function),
        snapshot: expect.any(Function),
      }),
      worker: undefined,
    }));
  });

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
    const { api, tools, clis, services, hooks, memoryPromptSections, memoryFlushPlans, memoryRuntimes, logger } = makeApi();

    registerOpenClawAdapter(api, config, { runtime, authority: registeredAuthority(runtime) });

    expect(tools.map((entry) => entry.opts.name)).toEqual([
      "memory_recall",
      "memory_store",
      "memory_scan_directory",
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
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("status=legacy"));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("writeMode=legacy-write-through"));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("embeddingReadMode=fail-closed"));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("lifecycleState=ready"));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("lifecycleReady=true"));
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining("status=active"));
    const legacyMemoryRuntime = memoryRuntimes[0] as {
      getMemorySearchManager(): Promise<{
        manager: {
          status(): { custom?: Record<string, unknown> };
          probeVectorAvailability(): Promise<boolean>;
        };
      }>;
    };
    const { manager: legacyManager } = await legacyMemoryRuntime.getMemorySearchManager();
    expect(legacyManager.status().custom).toMatchObject({
      embeddingRegistryStatus: "legacy",
      embeddingWriteMode: "legacy-write-through",
      embeddingReadMode: "fail-closed",
      lifecycleState: "ready",
      lifecycleReady: true,
    });
    await expect(legacyManager.probeVectorAvailability()).resolves.toBe(false);
    await services[0].stop();
    expect(db.initialize).toHaveBeenCalledTimes(1);
    expect(db.close).toHaveBeenCalledTimes(1);
  });

  test("非 Postgres runtime 不暴露运行后才失败的 forget/cleanup 工具", () => {
    const runtime = createMengshuRuntime({
      config,
      resolvedDbPath: config.dbPath!,
      appId: "openclaw",
      db: new FakeDb(),
    });
    const { api, tools, logger } = makeApi();

    registerOpenClawAdapter(api, config, { runtime, authority: registeredAuthority(runtime) });

    expect(tools.map((entry) => entry.opts.name)).not.toContain("memory_forget");
    expect(tools.map((entry) => entry.opts.name)).not.toContain("memory_cleanup");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/transactional forget.*unavailable/i));
  });

  test("仅 Postgres transaction capability 可用时暴露 forget/cleanup", () => {
    const db = new TransactionalRegistryFakeDb();
    const runtime = createMengshuRuntime({
      config: postgresConfig,
      resolvedDbPath: "",
      appId: "openclaw",
      db,
    });
    const { api, tools } = makeApi();

    registerOpenClawAdapter(api, postgresConfig, { runtime, authority: registeredAuthority(runtime) });

    expect(tools.map((entry) => entry.opts.name)).toContain("memory_forget");
    expect(tools.map((entry) => entry.opts.name)).toContain("memory_cleanup");
  });

  test("Postgres initialization logs active and write-enabled only after registry match", async () => {
    const db = new RegistryFakeDb();
    const runtime = createMengshuRuntime({
      config: postgresConfig,
      resolvedDbPath: "",
      appId: "openclaw",
      db,
    });
    db.getActiveEmbeddingSpace.mockResolvedValue(runtime.embeddingSpace);
    const { api, services, logger } = makeApi();

    registerOpenClawAdapter(api, postgresConfig, { runtime, authority: registeredAuthority(runtime) });
    await services[0].start();

    const output = logger.info.mock.calls.flat().join("\n");
    expect(output).toContain("status=active");
    expect(output).toContain("writeMode=write-enabled");
    expect(output).toContain("embeddingReadMode=same-space-ann");
    expect(output).toContain("lifecycleState=ready");
    expect(output).toContain("lifecycleReady=true");
    expect(output).not.toContain("test-key");
    expect(output).not.toContain("localhost:9999");
  });

  test.each([
    ["missing", null],
    ["mismatch", createEmbeddingSpace({
      provider: "openai",
      baseURL: "http://localhost:9999/v1",
      model: "text-embedding-3-large",
      dim: 3072,
      normalization: "none",
    })],
  ] as const)("Postgres %s initialization is visibly read-only", async (status, activeSpace) => {
    const db = new RegistryFakeDb();
    db.getActiveEmbeddingSpace.mockResolvedValue(activeSpace);
    const runtime = createMengshuRuntime({
      config: postgresConfig,
      resolvedDbPath: "",
      appId: "openclaw",
      db,
    });
    const { api, services, logger } = makeApi();

    registerOpenClawAdapter(api, postgresConfig, { runtime, authority: registeredAuthority(runtime) });
    await services[0].start();

    const output = logger.warn.mock.calls.flat().join("\n");
    expect(output).toContain("initialized degraded/read-only");
    expect(output).toContain(`status=${status}`);
    expect(output).toContain("writeMode=read-only");
    expect(output).toContain("embeddingReadMode=fail-closed");
    expect(output).toContain("lifecycleState=degraded");
    expect(output).toContain("lifecycleReady=false");
    expect(output).not.toContain("test-key");
    expect(output).not.toContain("localhost:9999");
  });

  test("doctor 读取 degraded service 状态但绝不取得或释放其 lifecycle 所有权", async () => {
    const db = new RegistryFakeDb();
    db.getActiveEmbeddingSpace.mockResolvedValue(null);
    const runtime = createMengshuRuntime({
      config: postgresConfig,
      resolvedDbPath: "",
      appId: "openclaw",
      db,
    });
    vi.spyOn(runtime.embeddings, "embed").mockResolvedValue([0.1]);
    const { api, services, clis } = makeApi();
    registerOpenClawAdapter(api, postgresConfig, {
      runtime,
      authority: registeredAuthority(runtime),
    });
    await services[0].start();
    expect(runtime.lifecycle.snapshot().state).toBe("degraded");

    const doctor = registeredMsCommand(clis).subcommands.find(
      (command) => command.name.startsWith("doctor"),
    )!;
    await doctor.actionHandler?.(".", {});

    expect(runtime.lifecycle.snapshot().state).toBe("degraded");
    expect(db.close).not.toHaveBeenCalled();
    await services[0].stop();
  });

  test("doctor 等待其他 owner 的 starting lifecycle，完成后不停止 runtime", async () => {
    const active = deferred<KnownEmbeddingSpace | null>();
    const db = new RegistryFakeDb();
    db.getActiveEmbeddingSpace.mockImplementation(() => active.promise);
    const runtime = createMengshuRuntime({
      config: postgresConfig,
      resolvedDbPath: "",
      appId: "openclaw",
      db,
    });
    vi.spyOn(runtime.embeddings, "embed").mockResolvedValue([0.1]);
    const { api, services, clis } = makeApi();
    registerOpenClawAdapter(api, postgresConfig, {
      runtime,
      authority: registeredAuthority(runtime),
    });
    const serviceStart = services[0].start();
    await Promise.resolve();
    expect(runtime.lifecycle.snapshot().state).toBe("starting");
    const doctor = registeredMsCommand(clis).subcommands.find(
      (command) => command.name.startsWith("doctor"),
    )!;
    const doctorRun = doctor.actionHandler?.(".", {});
    active.resolve(runtime.embeddingSpace);

    await Promise.all([serviceStart, doctorRun]);
    expect(runtime.lifecycle.snapshot().state).toBe("ready");
    expect(db.close).not.toHaveBeenCalled();
    await services[0].stop();
  });

  test("Postgres registry errors initialize read-only without logging provider details", async () => {
    const db = new RegistryFakeDb();
    db.getActiveEmbeddingSpace.mockRejectedValue(new Error("password=provider-secret"));
    const runtime = createMengshuRuntime({
      config: postgresConfig,
      resolvedDbPath: "",
      appId: "openclaw",
      db,
    });
    const { api, services, logger } = makeApi();

    registerOpenClawAdapter(api, postgresConfig, { runtime, authority: registeredAuthority(runtime) });
    await services[0].start();

    const output = [...logger.info.mock.calls, ...logger.warn.mock.calls].flat().join("\n");
    expect(output).toContain("status=unavailable");
    expect(output).toContain("writeMode=read-only");
    expect(output).toContain("embeddingReadMode=fail-closed");
    expect(output).toContain("initialized degraded/read-only");
    expect(output).toContain("lifecycleState=degraded");
    expect(output).toContain("lifecycleReady=false");
    expect(output).not.toContain("provider-secret");
  });

  test("OpenClaw memory status exposes registry and write mode without descriptors", async () => {
    const db = new RegistryFakeDb();
    const runtime = createMengshuRuntime({
      config: postgresConfig,
      resolvedDbPath: "",
      appId: "openclaw",
      db,
    });
    db.getActiveEmbeddingSpace.mockResolvedValue(runtime.embeddingSpace);
    const { api, services, memoryRuntimes } = makeApi();

    registerOpenClawAdapter(api, postgresConfig, { runtime, authority: registeredAuthority(runtime) });
    await services[0].start();
    const memoryRuntime = memoryRuntimes[0] as {
      getMemorySearchManager(): Promise<{
        manager: {
          status(): { custom?: Record<string, unknown> };
          probeVectorAvailability(): Promise<boolean>;
        };
      }>;
    };
    const { manager } = await memoryRuntime.getMemorySearchManager();
    const status = manager.status();

    expect(status.custom).toMatchObject({
      embeddingRegistryStatus: "active",
      embeddingWriteMode: "write-enabled",
      embeddingReadMode: "same-space-ann",
      lifecycleState: "ready",
      lifecycleReady: true,
    });
    await expect(manager.probeVectorAvailability()).resolves.toBe(true);
    expect(JSON.stringify(status.custom)).not.toContain("localhost:9999");
    expect(JSON.stringify(status.custom)).not.toContain("test-key");
  });

  test("OpenClaw vector health probe is false while Postgres registry is read-only", async () => {
    const db = new RegistryFakeDb();
    db.getActiveEmbeddingSpace.mockResolvedValue(null);
    const runtime = createMengshuRuntime({
      config: postgresConfig,
      resolvedDbPath: "",
      appId: "openclaw",
      db,
    });
    const { api, services, memoryRuntimes } = makeApi();

    registerOpenClawAdapter(api, postgresConfig, { runtime, authority: registeredAuthority(runtime) });
    await services[0].start();
    const memoryRuntime = memoryRuntimes[0] as {
      getMemorySearchManager(): Promise<{
        manager: { probeVectorAvailability(): Promise<boolean> };
      }>;
    };
    const { manager } = await memoryRuntime.getMemorySearchManager();

    await expect(manager.probeVectorAvailability()).resolves.toBe(false);
    expect((manager as unknown as { status(): { custom?: Record<string, unknown> } }).status().custom)
      .toMatchObject({ lifecycleState: "degraded", lifecycleReady: false });
  });

  test("OpenClaw embedding health probe never exposes provider errors", async () => {
    const runtime = createMengshuRuntime({
      config,
      resolvedDbPath: config.dbPath!,
      appId: "openclaw",
      db: new FakeDb(),
    });
    vi.spyOn(runtime.embeddings, "embed").mockRejectedValue(
      new Error("apiKey=test-key baseURL=http://localhost:9999/v1 provider raw error"),
    );
    const { api, memoryRuntimes } = makeApi();

    registerOpenClawAdapter(api, config, { runtime, authority: registeredAuthority(runtime) });
    const memoryRuntime = memoryRuntimes[0] as {
      getMemorySearchManager(): Promise<{
        manager: { probeEmbeddingAvailability(): Promise<{ ok: boolean; error?: string }> };
      }>;
    };
    const { manager } = await memoryRuntime.getMemorySearchManager();
    const result = await manager.probeEmbeddingAvailability();

    expect(result).toEqual({ ok: false, error: "embedding probe failed" });
    expect(JSON.stringify(result)).not.toContain("test-key");
    expect(JSON.stringify(result)).not.toContain("localhost:9999");
    expect(JSON.stringify(result)).not.toContain("provider raw error");
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

    registerOpenClawAdapter(api, config, { runtime, authority: registeredAuthority(runtime) });

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

  test("registered tools receive the runtime-configured knowledge table allowlist", async () => {
    const configured = {
      ...config,
      knowledgeBases: {
        enabled: true,
        autoCreateTables: false,
        builtinCategories: ["work"],
        customCategories: [],
      },
    } satisfies MemoryConfig;
    const runtime = createMengshuRuntime({
      config: configured,
      resolvedDbPath: configured.dbPath!,
      appId: "openclaw",
      db: new FakeDb(),
    });
    const recallSpy = vi.spyOn(runtime.memoryService, "recall").mockResolvedValue({
      scope: runtime.defaultScope,
      query: "configured knowledge",
      hits: [],
    });
    const { api, tools } = makeApi();

    registerOpenClawAdapter(api, configured, {
      runtime,
      authority: registeredAuthority(runtime),
    });
    const recallTool = tools.find((entry) => entry.opts.name === "memory_recall")!;

    await expect(recallTool.tool.execute("configured", {
      query: "configured knowledge",
      knowledgeBase: "knowledge_work",
    })).resolves.toBeDefined();
    await expect(recallTool.tool.execute("unknown", {
      query: "unknown knowledge",
      knowledgeBase: "knowledge_unconfigured",
    })).rejects.toMatchObject({ code: "TABLE_NAME_INVALID" });

    expect(recallSpy).toHaveBeenCalledTimes(1);
    expect(recallSpy.mock.calls[0]?.[0]).toMatchObject({
      tableName: "knowledge_work",
      dataTypes: ["knowledge"],
    });
  });

  test("registered memory_store rejects explicit scope identity claims before hash/embed/store", async () => {
    const db = new FakeDb();
    const runtime = createMengshuRuntime({
      config,
      resolvedDbPath: config.dbPath!,
      appId: "openclaw",
      db,
    });
    const embed = vi.spyOn(runtime.embeddings, "embed").mockResolvedValue([0.1]);
    const store = vi.spyOn(runtime.memoryService, "storeMemory");
    const { api, tools } = makeApi();
    registerOpenClawAdapter(api, config, { runtime, authority: registeredAuthority(runtime) });
    const tool = tools.find((entry) => entry.opts.name === "memory_store")!;

    await expect(tool.tool.execute("attack", {
      text: "I prefer secure server authority",
      scope: { tenantId: "attacker" },
    })).rejects.toMatchObject({ code: "CLIENT_FIELD_FORBIDDEN" });

    expect(db.existsByContentHash).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
    expect(db.store).not.toHaveBeenCalled();
  });

  test("registered memory_context_fast rejects client identity scope before recall", async () => {
    const runtime = createMengshuRuntime({
      config,
      resolvedDbPath: config.dbPath!,
      appId: "openclaw",
      db: new FakeDb(),
    });
    const recall = vi.spyOn(runtime.memoryService, "recall");
    const { api, tools } = makeApi();
    registerOpenClawAdapter(api, config, { runtime, authority: registeredAuthority(runtime) });
    const tool = tools.find((entry) => entry.opts.name === "memory_context_fast")!;

    await expect(tool.tool.execute("attack-context", {
      task: "load context",
      scope: { tenantId: "attacker" },
    })).rejects.toMatchObject({ code: "CLIENT_FIELD_FORBIDDEN" });
    expect(recall).not.toHaveBeenCalled();
  });

  test("registered host wrappers all retain the injected authority boundary", async () => {
    const db = new FakeDb();
    const runtime = createMengshuRuntime({
      config,
      resolvedDbPath: config.dbPath!,
      appId: "openclaw",
      db,
    });
    const {
      api, tools, hooks, memoryPromptSections, memoryFlushPlans, memoryRuntimes,
    } = makeApi();
    registerOpenClawAdapter(api, config, { runtime, authority: registeredAuthority(runtime) });

    for (const [name, params] of [
      ["memory_scan_directory", { directory: "/tmp/docs", userId: "attacker" }],
    ] as const) {
      const tool = tools.find((entry) => entry.opts.name === name)!;
      await expect(tool.tool.execute(`attack-${name}`, params))
        .rejects.toMatchObject({ code: "CLIENT_FIELD_FORBIDDEN" });
    }
    expect(db.query).not.toHaveBeenCalled();
    expect(db.store).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();

    const beforeStart = hooks.find((entry) => entry.name === "before_agent_start")!
      .handler as (event: unknown) => Promise<unknown>;
    const agentEnd = hooks.find((entry) => entry.name === "agent_end")!
      .handler as (event: unknown) => Promise<unknown>;
    await expect(beforeStart({ prompt: "x" })).resolves.toBeUndefined();
    await expect(agentEnd({ success: false })).resolves.toBeUndefined();

    const promptBuilder = memoryPromptSections[0] as (params: {
      availableTools: Set<string>;
    }) => string[];
    expect(promptBuilder({ availableTools: new Set(["memory_recall"]) })).toContain("## Mengshu Memory");
    expect(promptBuilder({ availableTools: new Set() })).toEqual([]);
    const flushPlan = memoryFlushPlans[0] as () => unknown;
    expect(flushPlan()).toBeNull();

    const hostRuntime = memoryRuntimes[0] as {
      getMemorySearchManager(): Promise<{ manager: { sync(): Promise<void>; close(): Promise<void> } }>;
      resolveMemoryBackendConfig(params: unknown): { backend: string };
      closeAllMemorySearchManagers(): Promise<void>;
    };
    expect(hostRuntime.resolveMemoryBackendConfig({})).toEqual({ backend: "builtin" });
    const { manager } = await hostRuntime.getMemorySearchManager();
    await manager.sync();
    await manager.close();
    await hostRuntime.closeAllMemorySearchManagers();
    expect(db.initialize).toHaveBeenCalledTimes(1);
    expect(db.close).toHaveBeenCalledTimes(1);
  });
});
