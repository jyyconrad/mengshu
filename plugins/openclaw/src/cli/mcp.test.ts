/**
 * cli-mcp.ts 单元测试。
 *
 * 验证 `ms mcp` 命令注册与启动逻辑：
 * 1. 命令以 "mcp" 名注册，带 description。
 * 2. action 调用注入的 startServer，传入 service / agentFastPath / namespaces。
 * 3. keepAlive=false 时启动后立即 close（测试不挂起进程）。
 */

import { describe, expect, test, vi } from "vitest";
import { registerMcpCliCommands } from "./mcp.js";
import type { CommanderLike } from "./index.js";
import type { MemoryService } from "../../../../core/service-types.js";

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
const defaultScope = {
  tenantId: "local",
  appId: "mengshu",
  userId: "default",
  projectId: "default",
  agentId: "default",
  namespace: "working-context",
  visibility: "private" as const,
};
const authority = {
  tenantId: defaultScope.tenantId,
  userId: defaultScope.userId,
  allow: {
    appIds: [defaultScope.appId],
    projectIds: [defaultScope.projectId, "project-b"],
    agentIds: [defaultScope.agentId],
    namespaces: [defaultScope.namespace],
    visibilities: [defaultScope.visibility],
  },
} as const;
const forgetService = { forget: vi.fn() };

describe("registerMcpCliCommands", () => {
  test("缺少 server-owned defaultScope 时拒绝启动", async () => {
    const { commander, commands } = makeFakeCommander();
    const startServer = vi.fn();
    registerMcpCliCommands(commander, {
      service: fakeService,
      authority,
      startServer: startServer as never,
      keepAlive: false,
    });
    await expect(commands.find((c) => c.name === "mcp")?.action?.()).rejects.toThrow(/defaultScope/i);
    expect(startServer).not.toHaveBeenCalled();
  });

  test("有 defaultScope 但缺少显式 authenticated authority 仍拒绝启动", async () => {
    const { commander, commands } = makeFakeCommander();
    const startServer = vi.fn();
    registerMcpCliCommands(commander, {
      service: fakeService,
      defaultScope,
      startServer: startServer as never,
      keepAlive: false,
    });
    await expect(commands.find((c) => c.name === "mcp")?.action?.()).rejects.toThrow(/authority/i);
    expect(startServer).not.toHaveBeenCalled();
  });

  test("MCP 启动透传显式 wider authority，不从 defaultScope 自动缩窄", async () => {
    const { commander, commands } = makeFakeCommander();
    const close = vi.fn(async () => {});
    const startServer = vi.fn(async () => ({ close }));
    registerMcpCliCommands(commander, {
      service: fakeService,
      defaultScope,
      authority,
      forgetService,
      startServer: startServer as never,
      keepAlive: false,
    } as never);

    await commands.find((c) => c.name === "mcp")?.action?.();
    expect(startServer).toHaveBeenCalledWith(expect.objectContaining({ authority }));
  });

  test("注册 mcp 命令并带描述", () => {
    const { commander, commands } = makeFakeCommander();
    registerMcpCliCommands(commander, { service: fakeService, authority, defaultScope });
    const mcp = commands.find((c) => c.name === "mcp");
    expect(mcp).toBeDefined();
    expect(mcp?.description).toContain("MCP");
  });

  test("无 transactional forget capability 时在 server 启动前明确拒绝", async () => {
    const { commander, commands } = makeFakeCommander();
    const startServer = vi.fn();
    registerMcpCliCommands(commander, {
      service: fakeService,
      authority,
      defaultScope,
      startServer: startServer as never,
      keepAlive: false,
    });

    await expect(commands.find((c) => c.name === "mcp")?.action?.())
      .rejects.toThrow(/transactional forget capability/i);
    expect(startServer).not.toHaveBeenCalled();
  });

  test("action 用注入的 startServer 启动，传入 service 与 namespaces", async () => {
    const { commander, commands } = makeFakeCommander();
    const close = vi.fn(async () => {});
    const startServer = vi.fn(async () => ({ close }));
    registerMcpCliCommands(commander, {
      service: fakeService,
      authority,
      defaultScope,
      forgetService,
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
      authority,
      defaultScope,
      forgetService,
      startServer: startServer as never,
      keepAlive: false,
    });
    const mcp = commands.find((c) => c.name === "mcp");
    await expect(mcp?.action?.()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
