import { describe, expect, test, vi } from "vitest";
import { registerLegacyCliCommands } from "./legacy.js";

class FakeCommand {
  subcommands: FakeCommand[] = [];
  actionHandler?: (...args: unknown[]) => unknown;
  constructor(readonly name: string) {}
  command(name: string) { const child = new FakeCommand(name); this.subcommands.push(child); return child; }
  description() { return this; }
  option() { return this; }
  action(handler: (...args: unknown[]) => unknown) { this.actionHandler = handler; return this; }
  find(name: string) { return this.subcommands.find((command) => command.name === name || command.name.startsWith(`${name} `)); }
}

const defaultScope = {
  tenantId: "tenant-a", appId: "openclaw", userId: "user-a", projectId: "project-a",
  agentId: "agent-a", namespace: "memories", visibility: "private" as const,
};
const authority = {
  tenantId: "tenant-a", userId: "user-a",
  allow: { appIds: ["openclaw"], projectIds: ["project-a"], agentIds: ["agent-a"], namespaces: ["memories"], visibilities: ["private" as const] },
};

describe("OpenClaw legacy CLI authority boundary", () => {
  test.each(["list", "tables", "stats", "search", "query", "cleanup", "export"])(
    "%s 不再直连 raw provider",
    async (name) => {
      const ms = new FakeCommand("ms");
      const db = { count: vi.fn(), query: vi.fn(), deleteByFilter: vi.fn(), getTableStats: vi.fn() };
      const embeddings = { embed: vi.fn() };
      registerLegacyCliCommands(ms as never, {
        authority,
        defaultScope,
        db,
        embeddings,
      } as never);

      await expect(ms.find(name)?.actionHandler?.("value", {})).rejects.toThrow(/disabled|unavailable|authority-safe/i);
      expect(db.count).not.toHaveBeenCalled();
      expect(db.query).not.toHaveBeenCalled();
      expect(db.deleteByFilter).not.toHaveBeenCalled();
      expect(embeddings.embed).not.toHaveBeenCalled();
    },
  );

  test("scan 缺少 scoped ingestion dependency 时明确拒绝", async () => {
    const ms = new FakeCommand("ms");
    registerLegacyCliCommands(ms as never, { authority, defaultScope } as never);

    await expect(ms.find("scan")?.actionHandler?.("/tmp/docs", {}))
      .rejects.toThrow(/scoped ingestion dependencies/i);
  });

  test("routing rule 命令在 authority 后调用受信配置引擎", async () => {
    const ms = new FakeCommand("ms");
    const toggleRule = vi.fn();
    const getAllRules = vi.fn(() => [{ name: "rule-a" }]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      registerLegacyCliCommands(ms as never, {
        authority,
        defaultScope,
        routingEngine: { toggleRule, getAllRules },
      } as never);

      await ms.find("rules:list")?.actionHandler?.();
      await ms.find("rules:enable")?.actionHandler?.("rule-a");
      await ms.find("rules:disable")?.actionHandler?.("rule-a");

      expect(getAllRules).toHaveBeenCalledTimes(1);
      expect(toggleRule).toHaveBeenNthCalledWith(1, "rule-a", true);
      expect(toggleRule).toHaveBeenNthCalledWith(2, "rule-a", false);
    } finally {
      log.mockRestore();
    }
  });
});
