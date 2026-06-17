/**
 * cli-forget.test.ts
 *
 * 单元测试：`ms forget` CLI 命令注册与调用。
 */

import { describe, expect, test } from "vitest";
import { registerForgetCliCommands } from "./cli-forget.js";
import { InMemoryMemoryStore } from "../../storage/repositories/in-memory.js";
import type { MemoryRecord } from "../../core/types.js";
import { computeContentHash } from "../../processing/hash-utils.js";

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

function createTestRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const text = overrides.text ?? "test memory";
  return {
    id: overrides.id ?? "mem_001",
    scope: {
      tenantId: "local",
      appId: "mengshu",
      userId: "default",
      projectId: "default",
      agentId: "default",
      namespace: "memories",
    },
    kind: "fact",
    text,
    contentHash: computeContentHash(text),
    importance: 0.8,
    category: "other",
    dataType: "memory",
    metadata: {},
    provenance: {},
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("registerForgetCliCommands", () => {
  test("注册 forget 子命令", () => {
    const ms = new FakeCommand("ms");
    const store = new InMemoryMemoryStore();

    registerForgetCliCommands(ms as never, { repository: store.memories });

    const forgetCmd = ms.subcommands.find((cmd) => cmd.name === "forget <id>");
    expect(forgetCmd).toBeDefined();
    expect(forgetCmd!.options.map(([flag]) => flag)).toEqual(
      expect.arrayContaining([
        "--undo",
        "--archive",
        "--restore",
        "--pin",
        "--unpin",
        "--correct",
        "--rollback-merge",
        "--text <text>",
        "--type <type>",
        "--scope <scope>",
        "--reason <reason>",
      ])
    );
  });

  test("执行 revoke 动作", async () => {
    const ms = new FakeCommand("ms");
    const store = new InMemoryMemoryStore({ now: () => 1000 });
    const record = createTestRecord();
    await store.memories.store([record]);

    registerForgetCliCommands(ms as never, { repository: store.memories });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => logs.push(String(message));

    try {
      const forgetCmd = ms.subcommands.find((cmd) => cmd.name === "forget <id>");
      await forgetCmd!.actionHandler!(record.id, {});

      expect(logs.join("\n")).toContain("记忆已撤回");

      const updated = await store.memories.query({
        query: "",
        scope: record.scope,
        limit: 1,
      });
      expect(updated[0].metadata.lifecycleStatus).toBe("revoked");
    } finally {
      console.log = originalLog;
    }
  });

  test("执行 undo 动作", async () => {
    const ms = new FakeCommand("ms");
    const store = new InMemoryMemoryStore({ now: () => 1000 });
    const record = createTestRecord({ metadata: { lifecycleStatus: "revoked", forgetLog: [
      { action: "revoke" as never, at: Date.now() }
    ]} });
    await store.memories.store([record]);

    registerForgetCliCommands(ms as never, { repository: store.memories });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => logs.push(String(message));

    try {
      const forgetCmd = ms.subcommands.find((cmd) => cmd.name === "forget <id>");
      await forgetCmd!.actionHandler!(record.id, { undo: true });

      expect(logs.join("\n")).toContain("记忆已恢复为 active 状态");

      const updated = await store.memories.query({
        query: "",
        scope: record.scope,
        limit: 1,
      });
      expect(updated[0].metadata.lifecycleStatus).toBe("active");
    } finally {
      console.log = originalLog;
    }
  });

  test("执行 pin 动作", async () => {
    const ms = new FakeCommand("ms");
    const store = new InMemoryMemoryStore({ now: () => 1000 });
    const record = createTestRecord();
    await store.memories.store([record]);

    registerForgetCliCommands(ms as never, { repository: store.memories });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => logs.push(String(message));

    try {
      const forgetCmd = ms.subcommands.find((cmd) => cmd.name === "forget <id>");
      await forgetCmd!.actionHandler!(record.id, { pin: true });

      expect(logs.join("\n")).toContain("记忆已固定");

      const updated = await store.memories.query({
        query: "",
        scope: record.scope,
        limit: 1,
      });
      expect(updated[0].metadata.pinned).toBe(true);
    } finally {
      console.log = originalLog;
    }
  });

  test("执行 correct 动作修改文本", async () => {
    const ms = new FakeCommand("ms");
    const store = new InMemoryMemoryStore({ now: () => 1000 });
    const record = createTestRecord({ text: "old text" });
    await store.memories.store([record]);

    registerForgetCliCommands(ms as never, { repository: store.memories });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => logs.push(String(message));

    try {
      const forgetCmd = ms.subcommands.find((cmd) => cmd.name === "forget <id>");
      await forgetCmd!.actionHandler!(record.id, { correct: true, text: "new text", reason: "纠错" });

      expect(logs.join("\n")).toContain("记忆已纠错");

      const updated = await store.memories.query({
        query: "",
        scope: record.scope,
        limit: 1,
      });
      expect(updated[0].text).toBe("new text");
    } finally {
      console.log = originalLog;
    }
  });

  test("执行 rollback-merge 动作", async () => {
    const ms = new FakeCommand("ms");
    const store = new InMemoryMemoryStore({ now: () => 1000 });
    const merged = createTestRecord({
      id: "merged_001",
      text: "merged memory",
      metadata: {
        mergedFrom: [
          { id: "orig_001", text: "orig 1", contentHash: computeContentHash("orig 1"), importance: 0.5, category: "other", createdAt: 500 },
        ],
      },
    });
    await store.memories.store([merged]);

    registerForgetCliCommands(ms as never, { repository: store.memories });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => logs.push(String(message));

    try {
      const forgetCmd = ms.subcommands.find((cmd) => cmd.name === "forget <id>");
      await forgetCmd!.actionHandler!(merged.id, { rollbackMerge: true });

      expect(logs.join("\n")).toContain("合并已回滚");

      const all = await store.memories.query({
        query: "",
        scope: merged.scope,
        limit: 10,
      });
      expect(all.map(r => r.id)).toEqual(["orig_001"]);
    } finally {
      console.log = originalLog;
    }
  });
});
