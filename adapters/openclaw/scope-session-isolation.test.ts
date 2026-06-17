/**
 * scope-session-isolation.test.ts
 *
 * 验证 P1-Q5 修复：buildOpenClawScope 正确传递 sessionId，确保候选区 session 隔离生效。
 *
 * 关键测试场景：
 * 1. OpenClaw hooks 构建的 scope 包含真实 sessionId
 * 2. 不同 session 的候选在容量约束下互不影响
 * 3. 缺少 sessionId 时退化为 full scope 比较（向后兼容）
 */

import { describe, expect, it } from "vitest";
import { buildOpenClawScope } from "./scope.js";
import { InMemoryCandidateRepository } from "../../lifecycle/candidate-repository.js";
import type { MemoryScope } from "../../core/types.js";

describe("OpenClaw scope sessionId 传递与候选区 session 隔离 (P1-Q5)", () => {
  it("buildOpenClawScope 正确传递 sessionId", () => {
    const scope = buildOpenClawScope({
      userId: "user-1",
      projectPath: "/workspace/app",
      agentName: "main-agent",
      sessionId: "session-abc-123",
    });

    expect(scope.sessionId).toBe("session-abc-123");
  });

  it("buildOpenClawScope 正确传递 workspaceId", () => {
    const scope = buildOpenClawScope({
      userId: "user-1",
      projectPath: "/workspace/app",
      workspaceId: "workspace-xyz-456",
    });

    expect(scope.workspaceId).toBe("workspace-xyz-456");
  });

  it("模拟 OpenClaw hooks 场景：不同 session 的候选区容量隔离", async () => {
    let clock = 1_000_000;
    const repo = new InMemoryCandidateRepository({
      now: () => clock++,
      config: { maxCandidatesPerSession: 3 },
    });

    // 模拟 session A 的 OpenClaw event
    const scopeA: MemoryScope = buildOpenClawScope({
      userId: "user-1",
      projectPath: "/workspace/app",
      agentName: "agent-1",
      sessionId: "session-A",
    });

    // 模拟 session B 的 OpenClaw event
    const scopeB: MemoryScope = buildOpenClawScope({
      userId: "user-1",
      projectPath: "/workspace/app",
      agentName: "agent-1",
      sessionId: "session-B",
    });

    // Session A 入队 3 条候选（达到容量上限）
    const aIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await repo.enqueue({
        scope: scopeA,
        text: `session-A candidate ${i}`,
        kind: "fact",
        confidence: 0.8,
        evidenceIds: [],
        metadata: {},
      });
      aIds.push(r.id);
    }

    // Session B 入队 3 条候选（达到容量上限）
    const bIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await repo.enqueue({
        scope: scopeB,
        text: `session-B candidate ${i}`,
        kind: "fact",
        confidence: 0.8,
        evidenceIds: [],
        metadata: {},
      });
      bIds.push(r.id);
    }

    // 验证：Session A 和 B 的候选都是 pending 状态
    for (const id of [...aIds, ...bIds]) {
      const r = await repo.get(id);
      expect(r?.status).toBe("pending");
    }

    // Session A 再入队一条（触发容量淘汰）
    await repo.enqueue({
      scope: scopeA,
      text: "session-A overflow candidate",
      kind: "fact",
      confidence: 0.8,
      evidenceIds: [],
      metadata: {},
    });

    // 验证：Session A 最旧的候选被归档
    const oldestA = await repo.get(aIds[0]);
    expect(oldestA?.status).toBe("archived");
    expect(oldestA?.metadata.statusReason).toBe("archived_due_to_session_capacity");

    // 验证：Session B 的所有候选仍然是 pending（不受 Session A 影响）
    for (const id of bIds) {
      const r = await repo.get(id);
      expect(r?.status).toBe("pending");
    }
  });

  it("缺失 sessionId 时退化为 full scope 比较（向后兼容）", async () => {
    let clock = 1_000_000;
    const repo = new InMemoryCandidateRepository({
      now: () => clock++,
      config: { maxCandidatesPerSession: 2 },
    });

    // 构建不带 sessionId 的 scope（模拟旧版本调用）
    const scopeNoSession: MemoryScope = buildOpenClawScope({
      userId: "user-1",
      projectPath: "/workspace/app",
      agentName: "agent-1",
      // sessionId 故意不传
    });

    expect(scopeNoSession.sessionId).toBeUndefined();

    // 入队 2 条（达到容量上限）
    const r1 = await repo.enqueue({
      scope: scopeNoSession,
      text: "candidate 1",
      kind: "fact",
      confidence: 0.8,
      evidenceIds: [],
      metadata: {},
    });

    await repo.enqueue({
      scope: scopeNoSession,
      text: "candidate 2",
      kind: "fact",
      confidence: 0.8,
      evidenceIds: [],
      metadata: {},
    });

    // 第 3 条触发归档最旧的
    await repo.enqueue({
      scope: scopeNoSession,
      text: "candidate 3",
      kind: "fact",
      confidence: 0.8,
      evidenceIds: [],
      metadata: {},
    });

    const oldest = await repo.get(r1.id);
    expect(oldest?.status).toBe("archived");
    expect(oldest?.metadata.statusReason).toBe("archived_due_to_session_capacity");
  });

  it("空字符串 sessionId 被规范化为 undefined", () => {
    const scope = buildOpenClawScope({
      userId: "user-1",
      projectPath: "/workspace/app",
      sessionId: "   ", // 空白字符串
    });

    expect(scope.sessionId).toBeUndefined();
  });
});
