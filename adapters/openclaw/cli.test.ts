import { describe, expect, test, vi } from "vitest";
import { registerMemoryServerCliCommands } from "./cli.js";

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
      });

      await ms.subcommands.find((command) => command.name === "status")?.actionHandler?.({});

      expect(logs.join("\n")).toContain("Server URL: http://127.0.0.1:3847");
      expect(logs.join("\n")).toContain("Database type: lancedb");
      expect(logs.join("\n")).toContain("- memories: 3 entries");
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
    try {
      registerMemoryServerCliCommands(ms as never, {
        config: { dbType: "lancedb", server: { host: "127.0.0.1", port: 3847, secret: "secret" } },
        service: { health: async () => ({ ok: true }) } as never,
        startServer,
        keepAlive: false,
      });

      await ms.subcommands.find((command) => command.name === "serve")?.actionHandler?.({});

      expect(startServer).toHaveBeenCalledWith({
        service: expect.anything(),
        host: "127.0.0.1",
        port: 3847,
        secret: "secret",
        requireHttps: undefined,
      });
      expect(log).toHaveBeenCalledWith("Memory server listening at http://127.0.0.1:3847");
    } finally {
      log.mockRestore();
    }
  });

  test("migrate prints v4 dry-run plan", async () => {
    const ms = new FakeCommand("ms");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      registerMemoryServerCliCommands(ms as never, {
        config: { dbType: "lancedb", server: { host: "127.0.0.1", port: 3847 } },
        service: { health: async () => ({ ok: true, records: 2 }) } as never,
      });

      await ms.subcommands.find((command) => command.name === "migrate")?.actionHandler?.({ toSchema: "v4", dryRun: true });

      expect(log).toHaveBeenCalledWith(JSON.stringify({
        sourceRecords: 2,
        memoryRecords: 2,
        documentRecords: 0,
        chunksEstimated: 0,
        entitiesEstimated: 1,
        jobsEstimated: 0,
        dryRun: true,
      }, null, 2));
    } finally {
      log.mockRestore();
    }
  });
});
