/**
 * forget-handler.test.ts
 *
 * 单元测试：忘记 / 治理命令族（TDD）。
 */

import { describe, expect, test } from "vitest";
import { InMemoryMemoryStore } from "../storage/repositories/in-memory.js";
import type { MemoryRecord } from "../core/types.js";
import { computeContentHash } from "../processing/hash-utils.js";
import { forgetCommand } from "./forget-handler.js";
import {
  HIDDEN_FROM_RECALL,
  REVOKE_UNDO_WINDOW_MS,
  type ForgetAction,
} from "./forget-types.js";

describe("forgetCommand", () => {
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

  test("revoke 撤回记忆，lifecycle → revoked，追加审计日志", async () => {
    const store = new InMemoryMemoryStore({ now: () => 1000 });
    const record = createTestRecord();
    await store.memories.store([record]);

    const result = await forgetCommand({
      repository: store.memories,
      id: record.id,
      action: "revoke",
      actor: "user_123",
      reason: "错误信息",
      now: 2000,
    });

    expect(result.applied).toBe(true);
    expect(result.lifecycleStatus).toBe("revoked");
    expect(result.message).toContain("记忆已撤回");

    const updated = await store.memories.query({
      query: "",
      scope: record.scope,
      limit: 1,
    });
    expect(updated).toHaveLength(1);
    expect(updated[0].metadata.lifecycleStatus).toBe("revoked");
    expect(updated[0].metadata.forgetLog).toHaveLength(1);
    expect((updated[0].metadata.forgetLog as unknown[])[0]).toMatchObject({
      action: "revoke",
      at: 2000,
      actor: "user_123",
      reason: "错误信息",
    });
  });

  test("undo 在时间窗口内回滚撤回，lifecycle → active", async () => {
    const store = new InMemoryMemoryStore({ now: () => 1000 });
    const record = createTestRecord({ metadata: { lifecycleStatus: "revoked", forgetLog: [
      { action: "revoke" as ForgetAction, at: 1000, actor: "user_123" }
    ]} });
    await store.memories.store([record]);

    const result = await forgetCommand({
      repository: store.memories,
      id: record.id,
      action: "undo",
      now: 1000 + REVOKE_UNDO_WINDOW_MS - 1,
    });

    expect(result.applied).toBe(true);
    expect(result.lifecycleStatus).toBe("active");

    const updated = await store.memories.query({
      query: "",
      scope: record.scope,
      limit: 1,
    });
    expect(updated[0].metadata.lifecycleStatus).toBe("active");
  });

  test("undo 超出时间窗口拒绝回滚", async () => {
    const store = new InMemoryMemoryStore({ now: () => 1000 });
    const record = createTestRecord({ metadata: { lifecycleStatus: "revoked", forgetLog: [
      { action: "revoke" as ForgetAction, at: 1000, actor: "user_123" }
    ]} });
    await store.memories.store([record]);

    await expect(
      forgetCommand({
        repository: store.memories,
        id: record.id,
        action: "undo",
        now: 1000 + REVOKE_UNDO_WINDOW_MS + 1,
      })
    ).rejects.toThrow("超出撤回回滚时间窗口");
  });

  test("archive 归档记忆，lifecycle → archived", async () => {
    const store = new InMemoryMemoryStore({ now: () => 1000 });
    const record = createTestRecord();
    await store.memories.store([record]);

    const result = await forgetCommand({
      repository: store.memories,
      id: record.id,
      action: "archive",
      now: 2000,
    });

    expect(result.applied).toBe(true);
    expect(result.lifecycleStatus).toBe("archived");

    const updated = await store.memories.query({
      query: "",
      scope: record.scope,
      limit: 1,
    });
    expect(updated[0].metadata.lifecycleStatus).toBe("archived");
  });

  test("restore 恢复归档记忆，lifecycle → active", async () => {
    const store = new InMemoryMemoryStore({ now: () => 1000 });
    const record = createTestRecord({ metadata: { lifecycleStatus: "archived" } });
    await store.memories.store([record]);

    const result = await forgetCommand({
      repository: store.memories,
      id: record.id,
      action: "restore",
      now: 2000,
    });

    expect(result.applied).toBe(true);
    expect(result.lifecycleStatus).toBe("active");

    const updated = await store.memories.query({
      query: "",
      scope: record.scope,
      limit: 1,
    });
    expect(updated[0].metadata.lifecycleStatus).toBe("active");
  });

  test("pin 固定记忆，设置 pinned = true", async () => {
    const store = new InMemoryMemoryStore({ now: () => 1000 });
    const record = createTestRecord();
    await store.memories.store([record]);

    const result = await forgetCommand({
      repository: store.memories,
      id: record.id,
      action: "pin",
      now: 2000,
    });

    expect(result.applied).toBe(true);
    expect(result.pinned).toBe(true);

    const updated = await store.memories.query({
      query: "",
      scope: record.scope,
      limit: 1,
    });
    expect(updated[0].metadata.pinned).toBe(true);
  });

  test("unpin 取消固定", async () => {
    const store = new InMemoryMemoryStore({ now: () => 1000 });
    const record = createTestRecord({ metadata: { pinned: true } });
    await store.memories.store([record]);

    const result = await forgetCommand({
      repository: store.memories,
      id: record.id,
      action: "unpin",
      now: 2000,
    });

    expect(result.applied).toBe(true);
    expect(result.pinned).toBe(false);

    const updated = await store.memories.query({
      query: "",
      scope: record.scope,
      limit: 1,
    });
    expect(updated[0].metadata.pinned).toBe(false);
  });

  test("correct 纠错记忆文本，刷新 contentHash 和审计日志", async () => {
    const store = new InMemoryMemoryStore({ now: () => 1000 });
    const record = createTestRecord({ text: "old text" });
    await store.memories.store([record]);

    const result = await forgetCommand({
      repository: store.memories,
      id: record.id,
      action: "correct",
      correction: { text: "new text" },
      reason: "纠错",
      now: 2000,
    });

    expect(result.applied).toBe(true);

    const updated = await store.memories.query({
      query: "",
      scope: record.scope,
      limit: 1,
    });
    expect(updated[0].text).toBe("new text");
    expect(updated[0].contentHash).toBe(computeContentHash("new text"));
    expect((updated[0].metadata.forgetLog as unknown[])[0]).toMatchObject({
      action: "correct",
      reason: "纠错",
      before: { text: "old text" },
      after: { text: "new text" },
    });
  });

  test("correct 纠错类型 kind", async () => {
    const store = new InMemoryMemoryStore({ now: () => 1000 });
    const record = createTestRecord({ kind: "fact" });
    await store.memories.store([record]);

    const result = await forgetCommand({
      repository: store.memories,
      id: record.id,
      action: "correct",
      correction: { type: "preference" },
      now: 2000,
    });

    expect(result.applied).toBe(true);

    const updated = await store.memories.query({
      query: "",
      scope: record.scope,
      limit: 1,
    });
    expect(updated[0].kind).toBe("preference");
  });

  test("rollback-merge 恢复被合并的原始记忆（从 metadata.mergedFrom）", async () => {
    const store = new InMemoryMemoryStore({ now: () => 1000 });
    const merged = createTestRecord({
      id: "merged_001",
      text: "merged memory",
      metadata: {
        mergedFrom: [
          { id: "orig_001", text: "orig 1", contentHash: computeContentHash("orig 1"), importance: 0.5, category: "other", createdAt: 500 },
          { id: "orig_002", text: "orig 2", contentHash: computeContentHash("orig 2"), importance: 0.6, category: "other", createdAt: 600 },
        ],
      },
    });
    await store.memories.store([merged]);

    const result = await forgetCommand({
      repository: store.memories,
      id: merged.id,
      action: "rollback-merge",
      now: 2000,
    });

    expect(result.applied).toBe(true);
    expect(result.restoredIds).toEqual(["orig_001", "orig_002"]);

    const all = await store.memories.query({
      query: "",
      scope: merged.scope,
      limit: 10,
    });
    expect(all).toHaveLength(2); // 合并记录被删除，原始记录恢复
    expect(all.map(r => r.id)).toEqual(expect.arrayContaining(["orig_001", "orig_002"]));
  });

  test("记忆不存在抛出错误", async () => {
    const store = new InMemoryMemoryStore({ now: () => 1000 });

    await expect(
      forgetCommand({
        repository: store.memories,
        id: "non_existent",
        action: "revoke",
        now: 2000,
      })
    ).rejects.toThrow("记忆不存在");
  });

  test("rollback-merge 缺失 mergedFrom 拒绝", async () => {
    const store = new InMemoryMemoryStore({ now: () => 1000 });
    const record = createTestRecord();
    await store.memories.store([record]);

    await expect(
      forgetCommand({
        repository: store.memories,
        id: record.id,
        action: "rollback-merge",
        now: 2000,
      })
    ).rejects.toThrow("不是合并记忆，无法回滚");
  });

  test("幂等：已 revoked 再 revoke 返回 applied=false", async () => {
    const store = new InMemoryMemoryStore({ now: () => 1000 });
    const record = createTestRecord({ metadata: { lifecycleStatus: "revoked" } });
    await store.memories.store([record]);

    const result = await forgetCommand({
      repository: store.memories,
      id: record.id,
      action: "revoke",
      now: 2000,
    });

    expect(result.applied).toBe(false);
    expect(result.message).toContain("已处于");
  });
});
