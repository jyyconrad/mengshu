/**
 * cli-mcp.ts 单元测试。
 *
 * 验证 `ms mcp` 命令注册与启动逻辑：
 * 1. 命令以 "mcp" 名注册，带 description。
 * 2. action 调用注入的 startServer，传入 service / agentFastPath / namespaces。
 * 3. keepAlive=false 时启动后立即 close（测试不挂起进程）。
 */

import { describe, expect, test, vi } from "vitest";
import { registerMcpCliCommands } from "./cli-mcp.js";
import type { CommanderLike } from "./cli.js";
import type { MemoryService } from "../../core/service-types.js";

/** 捕获注册的命令名、描述与 action 的 fake CommanderLike。 */
function makeFakeCommander(): {
  commander: CommanderLike;
  commands: Array<{ name: string; description?: string; action?: (...args: unknown[]) => unknown }>;
} {
  const commands: Array<{ name: string; description?: string; action?: (...args: unknown[]) => unknown }> = [];
  let current: { name: string; description?: string; action?: (...args: unknown[]) => unknown } | undefined;
  const commander: CommanderLike = {
    command(name: string) {
      current = { name };
      commands.push(current);
      return commander;
    },
    description(text: string) {
      if (current) current.description = text;
      return commander;
    },
    option() {
      return commander;
    },
    action(handler: (...args: unknown[]) => unknown) {
      if (current) current.action = handler;
      return commander;
    },
  };
  return { commander, commands };
}

const fakeService = {} as MemoryService;

describe("registerMcpCliCommands", () => {
  test("注册 mcp 命令并带描述", () => {
    const { commander, commands } = makeFakeCommander();
    registerMcpCliCommands(commander, { service: fakeService });
    const mcp = commands.find((c) => c.name === "mcp");
    expect(mcp).toBeDefined();
    expect(mcp?.description).toContain("MCP");
  });

  test("action 用注入的 startServer 启动，传入 service 与 namespaces", async () => {
    const { commander, commands } = makeFakeCommander();
    const close = vi.fn(async () => {});
    const startServer = vi.fn(async () => ({ close }));
    registerMcpCliCommands(commander, {
      service: fakeService,
      namespaces: ["memories", "knowledge"],
      startServer: startServer as never,
      keepAlive: false,
    });
    const mcp = commands.find((c) => c.name === "mcp");
    await mcp?.action?.();
    expect(startServer).toHaveBeenCalledTimes(1);
    const calls = startServer.mock.calls as unknown as Array<[{ service: unknown; namespaces?: string[] }]>;
    const arg = calls[0][0];
    expect(arg.service).toBe(fakeService);
    expect(arg.namespaces).toEqual(["memories", "knowledge"]);
  });

  test("keepAlive=false 启动后立即 close，不挂起", async () => {
    const { commander, commands } = makeFakeCommander();
    const close = vi.fn(async () => {});
    const startServer = vi.fn(async () => ({ close }));
    registerMcpCliCommands(commander, {
      service: fakeService,
      startServer: startServer as never,
      keepAlive: false,
    });
    const mcp = commands.find((c) => c.name === "mcp");
    await expect(mcp?.action?.()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
