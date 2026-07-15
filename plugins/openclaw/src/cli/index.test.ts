import { describe, expect, test, vi } from "vitest";
import { registerMemoryServerCliCommands as registerMemoryServerCliCommandsRaw } from "./index.js";
import {
  POSTGRES_SCHEMA_CUTOVER_TARGET,
  type PostgresSchemaCutoverPort,
} from "./migrate-v10.js";

const defaultScope = {
  tenantId: "tenant-a", appId: "openclaw", userId: "user-a", projectId: "project-a",
  agentId: "agent-a", namespace: "memories", visibility: "private" as const,
};
const authority = {
  tenantId: "tenant-a", userId: "user-a",
  allow: { appIds: ["openclaw"], projectIds: ["project-a"], agentIds: ["agent-a"], namespaces: ["memories"], visibilities: ["private" as const] },
};
function registerMemoryServerCliCommands(memory: never, options: Record<string, unknown>) {
  return registerMemoryServerCliCommandsRaw(memory, { authority, defaultScope, ...options } as never);
}

class FakeCommand {
  subcommands: FakeCommand[] = [];
  options: Array<[string, string, unknown?]> = [];
  actionHandler?: (...args: unknown[]) => unknown;

  constructor(public readonly name: string) {}

  command(name: string) {
    const child = new FakeCommand(name);
    this.subcommands.push(child);
    return child;
  }

  description() {
    return this;
  }

  option(flag: string, description: string, defaultValue?: unknown) {
    this.options.push([flag, description, defaultValue]);
    return this;
  }

  action(handler: (...args: unknown[]) => unknown) {
    this.actionHandler = handler;
    return this;
  }
}

describe("OpenClaw server CLI commands", () => {
  test.each(["serve", "status", "health", "migrate"])(
    "缺少 authenticated authority 时在 %s action 副作用前拒绝",
    async (commandName) => {
      const ms = new FakeCommand("ms");
      const startServer = vi.fn();
      const health = vi.fn(async () => ({ ok: true }));
      registerMemoryServerCliCommandsRaw(ms as never, {
        config: { dbType: "lancedb" },
        service: { health } as never,
        startServer: startServer as never,
      });
      await expect(ms.subcommands.find((command) => command.name === commandName)?.actionHandler?.({}))
        .rejects.toThrow(/authority/i);
      expect(startServer).not.toHaveBeenCalled();
      expect(health).not.toHaveBeenCalled();
    },
  );

  test("registers serve, status, and health commands", () => {
    const ms = new FakeCommand("ms");

    registerMemoryServerCliCommands(ms as never, {
      config: { dbType: "lancedb", dbPath: "/tmp/db", server: { host: "127.0.0.1", port: 3847 } },
      service: { health: async () => ({ ok: true }) } as never,
    });

    expect(ms.subcommands.map((command) => command.name)).toEqual(["serve", "status", "health", "migrate"]);
  });

  test("status prints server URL, db type, and table stats", async () => {
    const ms = new FakeCommand("ms");
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => logs.push(String(message));
    try {
      registerMemoryServerCliCommands(ms as never, {
        config: { dbType: "lancedb", dbPath: "/tmp/db", server: { host: "127.0.0.1", port: 3847 } },
        service: { health: async () => ({ ok: true, records: 3 }) } as never,
        getTableStats: async () => [{ name: "memories", count: 3, dataType: "memory" }],
        probeServer: async () => true,
      });

      await ms.subcommands.find((command) => command.name === "status")?.actionHandler?.({});

      expect(logs.join("\n")).toContain("Server URL: http://127.0.0.1:3847");
      expect(logs.join("\n")).toContain("Database type: lancedb");
      expect(logs.join("\n")).toContain("Server reachable: true");
      expect(logs.join("\n")).toContain("Service healthy: true");
      expect(logs.join("\n")).toContain("- memories: 3 entries");
    } finally {
      console.log = originalLog;
    }
  });

  test("status fails closed when the configured listener is unavailable", async () => {
    const ms = new FakeCommand("ms");
    const logs: string[] = [];
    const probeServer = vi.fn(async () => false);
    const originalLog = console.log;
    console.log = (message?: unknown) => logs.push(String(message));
    try {
      registerMemoryServerCliCommands(ms as never, {
        config: { dbType: "lancedb", server: { host: "127.0.0.1", port: 3847 } },
        service: { health: async () => ({ ok: true, records: 3 }) } as never,
        probeServer,
      });

      await expect(
        ms.subcommands.find((command) => command.name === "status")?.actionHandler?.({}),
      ).rejects.toThrow("Memory server is not reachable");

      expect(probeServer).toHaveBeenCalledWith({ host: "127.0.0.1", port: 3847 });
      expect(logs.join("\n")).toContain("Server reachable: false");
      expect(logs.join("\n")).toContain("Service healthy: false");
      expect(logs.join("\n")).not.toContain("Service healthy: true");
    } finally {
      console.log = originalLog;
    }
  });

  test("health prints service health JSON", async () => {
    const ms = new FakeCommand("ms");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      registerMemoryServerCliCommands(ms as never, {
        config: { dbType: "lancedb", server: { host: "127.0.0.1", port: 3847 } },
        service: { health: async () => ({ ok: true, records: 1 }) } as never,
      });

      await ms.subcommands.find((command) => command.name === "health")?.actionHandler?.({});

      expect(log).toHaveBeenCalledWith(JSON.stringify({ ok: true, records: 1 }, null, 2));
    } finally {
      log.mockRestore();
    }
  });

  test("serve starts server with configured host and port", async () => {
    const ms = new FakeCommand("ms");
    const startServer = vi.fn(async () => ({
      url: "http://127.0.0.1:3847",
      server: {} as never,
      stop: async () => {},
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const runtimeHost = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      snapshot: vi.fn(() => ({ state: "ready", ready: true })),
    };
    const runtimeHostFactory = vi.fn(() => runtimeHost);
    try {
      registerMemoryServerCliCommands(ms as never, {
        config: { dbType: "lancedb", server: { host: "127.0.0.1", port: 3847, secret: "secret" } },
        service: { health: async () => ({ ok: true }) } as never,
        startServer,
        runtimeHostFactory,
        keepAlive: false,
      });

      await ms.subcommands.find((command) => command.name === "serve")?.actionHandler?.({});

      expect(startServer).toHaveBeenCalledWith({
        service: expect.anything(),
        console: undefined,
        agentFastPath: undefined,
        authority,
        runtimeHost,
        worker: undefined,
        host: "127.0.0.1",
        port: 3847,
        secret: "secret",
        requireHttps: undefined,
      });
      expect(runtimeHostFactory).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith("Memory server listening at http://127.0.0.1:3847");
    } finally {
      log.mockRestore();
    }
  });

  test("serve 缺少 v2 RuntimeHost factory 时 fail-closed，listener 启动次数为 0", async () => {
    const ms = new FakeCommand("ms");
    const startServer = vi.fn();
    registerMemoryServerCliCommands(ms as never, {
      config: { dbType: "postgres", server: { host: "127.0.0.1", port: 3847 } },
      service: { health: async () => ({ ok: true }) } as never,
      startServer,
      keepAlive: false,
    });

    await expect(ms.subcommands.find((command) => command.name === "serve")?.actionHandler?.({}))
      .rejects.toThrow(/durable job v2.*runtimehost|runtimehost.*required/i);

    expect(startServer).not.toHaveBeenCalled();
  });

  test("RuntimeHost factory capability 校验失败时不调用 startMemoryServer", async () => {
    const ms = new FakeCommand("ms");
    const startServer = vi.fn();
    const runtimeHostFactory = vi.fn(() => {
      throw new Error("Durable job v2 capability unavailable");
    });
    registerMemoryServerCliCommands(ms as never, {
      config: { dbType: "postgres", server: { host: "127.0.0.1", port: 3847 } },
      service: { health: async () => ({ ok: true }) } as never,
      startServer,
      runtimeHostFactory,
      keepAlive: false,
    });

    await expect(ms.subcommands.find((command) => command.name === "serve")?.actionHandler?.({}))
      .rejects.toThrow(/capability unavailable/i);

    expect(runtimeHostFactory).toHaveBeenCalledTimes(1);
    expect(startServer).not.toHaveBeenCalled();
  });

  test("migrate 默认打印 PostgreSQL 当前 target 与 scope dry-run，不再伪造 v4 records", async () => {
    const ms = new FakeCommand("ms");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const port: PostgresSchemaCutoverPort = {
      getSchemaContractStatus: vi.fn(async () => ({
        currentVersion: 5,
        targetVersion: POSTGRES_SCHEMA_CUTOVER_TARGET,
        scopeContentHashDedupe: "pending" as const,
      })),
      inspectScopeBackfill: vi.fn(async (table) => ({
        table,
        total: 0,
        canonical: 0,
        quarantined: 0,
        pending: 0,
        plan: {
          mode: "dry-run" as const,
          table,
          scanned: 0,
          resolved: 0,
          quarantined: 0,
          conflict: 0,
          skipped: 0,
          batches: 0,
        },
      })),
      applyScopeBackfill: vi.fn(),
      applyScopeContentHashDedupeContract: vi.fn(),
    };
    try {
      registerMemoryServerCliCommands(ms as never, {
        config: { dbType: "postgres", server: { host: "127.0.0.1", port: 3847 } },
        service: { health: async () => ({ ok: true, records: 2 }) } as never,
        schemaCutover: {
          port,
          getRegistry: () => ({ version: 2, projects: {}, workspaces: {} }),
        },
      });

      await ms.subcommands.find((command) => command.name === "migrate")?.actionHandler?.({
        toSchema: `v${POSTGRES_SCHEMA_CUTOVER_TARGET}`,
        dryRun: true,
      });

      const output = String(log.mock.calls[0]?.[0]);
      expect(JSON.parse(output)).toMatchObject({
        mode: "dry-run",
        currentVersion: 5,
        targetVersion: POSTGRES_SCHEMA_CUTOVER_TARGET,
        pendingVersions: expect.arrayContaining([6, 10, POSTGRES_SCHEMA_CUTOVER_TARGET]),
        canonical: 0,
        unresolved: 0,
      });
      expect(port.applyScopeBackfill).not.toHaveBeenCalled();
      expect(port.applyScopeContentHashDedupeContract).not.toHaveBeenCalled();
      const migrate = ms.subcommands.find((command) => command.name === "migrate");
      expect(migrate?.options.some(([flag]) => flag === "--allow-quarantine <count>"))
        .toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  test.each(["", "-1", "1.5", "1e3", "9007199254740992"])(
    "migrate apply 拒绝非十进制安全整数 quarantine allowance %j，且 inspection 零调用",
    async (allowQuarantine) => {
      const ms = new FakeCommand("ms");
      const port: PostgresSchemaCutoverPort = {
        getSchemaContractStatus: vi.fn(),
        inspectScopeBackfill: vi.fn(),
        applyScopeBackfill: vi.fn(),
        applyScopeContentHashDedupeContract: vi.fn(),
      };
      registerMemoryServerCliCommands(ms as never, {
        config: { dbType: "postgres" },
        service: { health: async () => ({ ok: true }) } as never,
        schemaCutover: {
          port,
          getRegistry: () => ({ version: 2, projects: {}, workspaces: {} }),
        },
      });

      await expect(ms.subcommands.find((command) => command.name === "migrate")?.actionHandler?.({
        apply: true,
        maintenance: true,
        quiescenceConfirmed: true,
        confirm: "unused-by-invalid-allowance",
        allowQuarantine,
      })).rejects.toMatchObject({
        code: "SCHEMA_CUTOVER_INVALID_QUARANTINE_ALLOWANCE",
      });

      expect(port.getSchemaContractStatus).not.toHaveBeenCalled();
      expect(port.inspectScopeBackfill).not.toHaveBeenCalled();
    },
  );
});
