/**
 * cli-why.ts 单元测试。
 *
 * `ms why <target>` 解释一条记忆为什么会被召回 / 存在：
 * 展示来源（provenance）、scope、riskFlags 与合并/替代记录。
 *
 * 覆盖：
 * 1. 注册 why 命令到父 ms。
 * 2. 纯函数 extractWhyDetails：从 MemoryRecord 抽取 source/scope/riskFlags/merge。
 *    - riskFlags 从 metadata.riskFlags 读取并去重。
 *    - merge 记录从 supersededBy / sourceNodeIds / metadata.mergedFrom 聚合。
 * 3. 纯函数 formatWhyReport：渲染人类可读文本，含各分节标题。
 * 4. resolveTarget：按精确 id 命中优先，否则取查询 top hit。
 * 5. action：无 service 时友好提示；未命中时提示无结果；命中时打印报告。
 */

import { describe, expect, test, vi } from "vitest";
import {
  registerWhyCliCommands,
  extractWhyDetails,
  formatWhyReport,
  resolveTarget,
} from "./cli-why.js";
import type { MemoryRecord, MemoryScope } from "../../core/types.js";

const baseScope: MemoryScope = {
  tenantId: "local",
  appId: "mengshu",
  userId: "alice",
  projectId: "proj-1",
  agentId: "default",
  namespace: "memories",
  visibility: "private",
};

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "rec-1",
    scope: baseScope,
    kind: "preference",
    text: "用户偏好使用中文交流",
    contentHash: "hash-1",
    importance: 0.9,
    category: "preference",
    dataType: "memory",
    metadata: {},
    provenance: { source: "user", sessionId: "sess-1", conversationId: "conv-1" },
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

class FakeCommand {
  subcommands: FakeCommand[] = [];
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
  option() {
    return this;
  }
  action(handler: (...args: unknown[]) => unknown) {
    this.actionHandler = handler;
    return this;
  }
  find(name: string): FakeCommand | undefined {
    return this.subcommands.find((c) => c.name === name || c.name.startsWith(`${name} `));
  }
}

describe("registerWhyCliCommands 注册", () => {
  test("注册 why 命令", () => {
    const ms = new FakeCommand("ms");
    registerWhyCliCommands(ms as never, {});
    expect(ms.find("why")).toBeDefined();
  });
});

describe("extractWhyDetails", () => {
  test("抽取 source / scope 基本字段", () => {
    const details = extractWhyDetails(makeRecord());
    expect(details.source.source).toBe("user");
    expect(details.source.sessionId).toBe("sess-1");
    expect(details.source.conversationId).toBe("conv-1");
    expect(details.scope.userId).toBe("alice");
    expect(details.scope.projectId).toBe("proj-1");
  });

  test("riskFlags 从 metadata 读取并去重", () => {
    const details = extractWhyDetails(
      makeRecord({ metadata: { riskFlags: ["sensitive", "sensitive", "scope_risk"] } }),
    );
    expect(details.riskFlags).toEqual(["sensitive", "scope_risk"]);
  });

  test("无 riskFlags 时返回空数组", () => {
    expect(extractWhyDetails(makeRecord()).riskFlags).toEqual([]);
  });

  test("合并记录聚合 supersededBy / sourceNodeIds / metadata.mergedFrom", () => {
    const details = extractWhyDetails(
      makeRecord({
        supersededBy: "rec-9",
        sourceNodeIds: ["src-1", "src-2"],
        metadata: { mergedFrom: ["old-1", "old-2", "src-1"] },
      }),
    );
    expect(details.merge.supersededBy).toBe("rec-9");
    expect(details.merge.sourceNodeIds).toEqual(["src-1", "src-2"]);
    expect(details.merge.mergedFrom).toEqual(["old-1", "old-2", "src-1"]);
    expect(details.merge.hasMergeHistory).toBe(true);
  });

  test("无合并信息时 hasMergeHistory 为 false", () => {
    expect(extractWhyDetails(makeRecord()).merge.hasMergeHistory).toBe(false);
  });
});

describe("formatWhyReport", () => {
  test("包含来源/scope/风险/合并各分节", () => {
    const report = formatWhyReport(
      makeRecord({
        metadata: { riskFlags: ["sensitive"] },
        supersededBy: "rec-9",
      }),
    );
    expect(report).toContain("用户偏好使用中文交流");
    expect(report).toContain("来源");
    expect(report).toContain("user");
    expect(report).toContain("Scope");
    expect(report).toContain("proj-1");
    expect(report).toContain("风险标记");
    expect(report).toContain("sensitive");
    expect(report).toContain("合并");
    expect(report).toContain("rec-9");
  });

  test("无风险标记时显示无", () => {
    const report = formatWhyReport(makeRecord());
    expect(report).toContain("无");
  });
});

describe("resolveTarget", () => {
  const hits = [
    { record: makeRecord({ id: "rec-1" }), score: 0.4, source: "vector" as const },
    { record: makeRecord({ id: "rec-2" }), score: 0.9, source: "vector" as const },
  ];

  test("精确 id 命中优先于得分", () => {
    const target = resolveTarget("rec-1", hits);
    expect(target?.id).toBe("rec-1");
  });

  test("非 id 时取首个 hit（已按得分排序）", () => {
    const target = resolveTarget("中文偏好", hits);
    expect(target?.id).toBe("rec-1");
  });

  test("空命中返回 undefined", () => {
    expect(resolveTarget("x", [])).toBeUndefined();
  });
});

describe("why action", () => {
  test("无 service 时友好提示，不抛错", async () => {
    const ms = new FakeCommand("ms");
    registerWhyCliCommands(ms as never, {});
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
      logs.push(String(m));
    });
    await ms.find("why")?.actionHandler?.("rec-1", {});
    spy.mockRestore();
    expect(logs.join("\n")).toContain("MemoryService");
  });

  test("命中记录时打印报告", async () => {
    const ms = new FakeCommand("ms");
    const record = makeRecord({ id: "rec-1", metadata: { riskFlags: ["sensitive"] } });
    const service = {
      recall: vi.fn().mockResolvedValue({
        scope: baseScope,
        query: "rec-1",
        hits: [{ record, score: 0.8, source: "vector" }],
      }),
    };
    registerWhyCliCommands(ms as never, {
      service: service as never,
      scope: baseScope,
    });
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
      logs.push(String(m));
    });
    await ms.find("why")?.actionHandler?.("rec-1", {});
    spy.mockRestore();
    expect(service.recall).toHaveBeenCalled();
    expect(logs.join("\n")).toContain("用户偏好使用中文交流");
    expect(logs.join("\n")).toContain("sensitive");
  });

  test("未命中时提示无结果", async () => {
    const ms = new FakeCommand("ms");
    const service = {
      recall: vi.fn().mockResolvedValue({ scope: baseScope, query: "x", hits: [] }),
    };
    registerWhyCliCommands(ms as never, { service: service as never, scope: baseScope });
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
      logs.push(String(m));
    });
    await ms.find("why")?.actionHandler?.("不存在的内容", {});
    spy.mockRestore();
    expect(logs.join("\n")).toContain("未找到");
  });
});
