/**
 * candidate-repository.test.ts
 *
 * 工作内容：覆盖 InMemoryCandidateRepository 的容量约束（D-02 / §17.1）。
 * 核心流程：
 * - 同 session 下 pending 数达到 maxCandidatesPerSession 时，再 enqueue 触发
 *   最早 pending 被标 archived 且 statusReason=archived_due_to_session_capacity。
 * - 新写入条目以 pending 状态入库，原条目从 pending 列表移除。
 * 关键边界：
 * - 仅按 sessionId 聚合（不污染其他 session）。
 * - 已 archived/expired/approved 状态的旧条目不计入容量。
 * - 缺省 sessionId 时按 full scope 聚合（向后兼容旧调用方）。
 */

import { describe, expect, it } from "vitest";
import { InMemoryCandidateRepository } from "./candidate-repository.js";
import type { MemoryScope } from "../core/types.js";

const baseScope: MemoryScope = {
  tenantId: "local",
  appId: "openclaw",
  userId: "u1",
  projectId: "p1",
  agentId: "default",
  namespace: "memories",
  sessionId: "session-A",
};

function makeInput(scope: MemoryScope, text: string) {
  return {
    scope,
    text,
    kind: "fact",
    confidence: 0.8,
    evidenceIds: [],
    metadata: {},
  };
}

describe("InMemoryCandidateRepository 容量约束 (D-02 / §17.1)", () => {
  it("session 满 maxCandidatesPerSession 后，第 N+1 条入队最旧 pending 被归档", async () => {
    let clock = 1_000_000;
    const repo = new InMemoryCandidateRepository({
      now: () => clock++,
      config: { maxCandidatesPerSession: 50 },
    });

    // 写入 50 条 pending（占满容量）
    const firstId = (await repo.enqueue(makeInput(baseScope, "text-0"))).id;
    for (let i = 1; i < 50; i++) {
      await repo.enqueue(makeInput(baseScope, `text-${i}`));
    }
    expect(await repo.count({ scope: baseScope, status: "pending" })).toBe(50);

    // 第 51 条触发归档最旧条目
    const newest = await repo.enqueue(makeInput(baseScope, "text-50"));

    const pending = await repo.list({ scope: baseScope, status: "pending" });
    expect(pending.length).toBe(50);
    expect(pending.find((r) => r.id === firstId)).toBeUndefined();
    expect(pending.find((r) => r.id === newest.id)).toBeDefined();

    const oldest = await repo.get(firstId);
    expect(oldest?.status).toBe("archived");
    expect(oldest?.metadata.statusReason).toBe(
      "archived_due_to_session_capacity",
    );
  });

  it("不同 session 的 pending 互不影响容量计数", async () => {
    let clock = 1_000_000;
    const repo = new InMemoryCandidateRepository({
      now: () => clock++,
      config: { maxCandidatesPerSession: 3 },
    });

    const sessionA: MemoryScope = { ...baseScope, sessionId: "session-A" };
    const sessionB: MemoryScope = { ...baseScope, sessionId: "session-B" };

    // 注：list/count 的 scope 过滤用 sameScope（不含 sessionId），无法区分会话，
    // 因此这里跟踪具体 id 来验证会话隔离。
    const bIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      await repo.enqueue(makeInput(sessionA, `a-${i}`));
    }
    for (let i = 0; i < 3; i++) {
      bIds.push((await repo.enqueue(makeInput(sessionB, `b-${i}`))).id);
    }

    // 仅向 A 再入一条，触发 A 内最旧归档；B 的任何条目都不应被归档。
    await repo.enqueue(makeInput(sessionA, "a-overflow"));

    for (const id of bIds) {
      const r = await repo.get(id);
      expect(r?.status).toBe("pending");
    }
  });

  it("非 pending 状态不计入容量（archived/approved 不阻塞新入队）", async () => {
    let clock = 1_000_000;
    const repo = new InMemoryCandidateRepository({
      now: () => clock++,
      config: { maxCandidatesPerSession: 2 },
    });

    const r1 = await repo.enqueue(makeInput(baseScope, "t1"));
    const r2 = await repo.enqueue(makeInput(baseScope, "t2"));
    await repo.setStatus(r1.id, "approved");
    await repo.setStatus(r2.id, "rejected");

    // 即便容量是 2，由于 r1/r2 不再是 pending，下一条仍按 pending 入库
    const r3 = await repo.enqueue(makeInput(baseScope, "t3"));
    expect(r3.status).toBe("pending");

    const pending = await repo.list({ scope: baseScope, status: "pending" });
    expect(pending.length).toBe(1);
  });

  it("缺省 sessionId 时按 full scope 聚合，限制仍生效（向后兼容）", async () => {
    let clock = 1_000_000;
    const repo = new InMemoryCandidateRepository({
      now: () => clock++,
      config: { maxCandidatesPerSession: 2 },
    });

    const noSessionScope: MemoryScope = { ...baseScope };
    delete (noSessionScope as { sessionId?: string }).sessionId;

    const a = await repo.enqueue(makeInput(noSessionScope, "x1"));
    await repo.enqueue(makeInput(noSessionScope, "x2"));
    // 第 3 条触发归档最旧
    await repo.enqueue(makeInput(noSessionScope, "x3"));

    const oldest = await repo.get(a.id);
    expect(oldest?.status).toBe("archived");
    expect(oldest?.metadata.statusReason).toBe(
      "archived_due_to_session_capacity",
    );
  });
});
