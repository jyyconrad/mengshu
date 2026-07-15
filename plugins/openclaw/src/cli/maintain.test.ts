import { describe, expect, test, vi } from "vitest";
import { registerMaintainCommands } from "./maintain.js";

class FakeCommand {
  subcommands: FakeCommand[] = [];
  actionHandler?: (...args: unknown[]) => unknown;
  constructor(readonly name: string) {}
  command(name: string) { const child = new FakeCommand(name); this.subcommands.push(child); return child; }
  description() { return this; }
  option() { return this; }
  action(handler: (...args: unknown[]) => unknown) { this.actionHandler = handler; return this; }
  find(name: string): FakeCommand | undefined {
    for (const child of this.subcommands) {
      if (child.name === name || child.name.startsWith(`${name} `)) return child;
      const nested = child.find(name);
      if (nested) return nested;
    }
    return undefined;
  }
}

const defaultScope = {
  tenantId: "tenant-a", appId: "openclaw", userId: "user-a", projectId: "project-a",
  agentId: "agent-a", namespace: "memories", visibility: "private" as const,
};
const authority = {
  tenantId: "tenant-a", userId: "user-a",
  allow: { appIds: ["openclaw"], projectIds: ["project-a"], agentIds: ["agent-a"], namespaces: ["memories"], visibilities: ["private" as const] },
};

describe("OpenClaw maintain CLI authority", () => {
  test("--scope 不能覆盖 tenant/user，且在 calculator 前拒绝", async () => {
    const ms = new FakeCommand("ms");
    const calculateCentrality = vi.fn();
    registerMaintainCommands(ms as never, {
      authority,
      defaultScope,
      centralityCalculator: { calculateCentrality },
      getDefaultScope: () => defaultScope,
    } as never);

    await expect(ms.find("calculate-centrality")?.actionHandler?.({
      scope: JSON.stringify({ ...defaultScope, tenantId: "attacker" }),
    })).rejects.toThrow(/tenantId|server-owned|forbidden/i);
    expect(calculateCentrality).not.toHaveBeenCalled();
  });

  test("未提供 --scope 时只使用 server defaultScope", async () => {
    const ms = new FakeCommand("ms");
    const calculateCentrality = vi.fn(async () => {});
    registerMaintainCommands(ms as never, {
      authority,
      defaultScope,
      centralityCalculator: { calculateCentrality },
    } as never);

    await ms.find("calculate-centrality")?.actionHandler?.({});
    expect(calculateCentrality).toHaveBeenCalledWith(defaultScope);
  });

  test("info 仅输出说明且不访问 calculator", () => {
    const ms = new FakeCommand("ms");
    const calculateCentrality = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      registerMaintainCommands(ms as never, {
        authority,
        defaultScope,
        centralityCalculator: { calculateCentrality },
      } as never);
      ms.find("info")?.actionHandler?.();
      expect(log).toHaveBeenCalled();
      expect(calculateCentrality).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});
