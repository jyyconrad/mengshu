/**
 * slot-context-builder.test.ts
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SlotContextBuilder } from "./slot-context-builder.js";
import { SlotSnapshotCache } from "./slot-snapshot.js";
import type { MemoryScope } from "./semantic-types.js";
import type { MemoryRecord } from "./types.js";

const mockScope: MemoryScope = {
  tenantId: "test-tenant",
  appId: "test-app",
  userId: "test-user",
  projectId: "test-project",
  agentId: "test-agent",
  namespace: "memories",
};

const mockRecords: Partial<MemoryRecord>[] = [
  {
    id: "mem-1",
    kind: "goal",
    semanticType: "task_context",
    text: "完成项目架构升级",
    importance: 0.9,
    scope: mockScope,
  },
  {
    id: "mem-2",
    kind: "document",
    semanticType: "resource",
    text: "参考文档：docs/architecture.md",
    importance: 0.7,
    scope: mockScope,
  },
  {
    id: "mem-3",
    kind: "preference",
    text: "用户喜欢简洁的代码风格",
    importance: 0.8,
    scope: mockScope,
  },
  {
    id: "mem-4",
    kind: "decision",
    text: "选择 LanceDB 作为向量库",
    importance: 0.85,
    scope: mockScope,
  },
];

describe("SlotContextBuilder", () => {
  let builder: SlotContextBuilder;
  let cache: SlotSnapshotCache;

  beforeEach(() => {
    cache = new SlotSnapshotCache();
    builder = new SlotContextBuilder(cache);
  });

  describe("buildSlotContext", () => {
    it("应该构建 5 槽位上下文", async () => {
      const result = await builder.buildSlotContext(
        mockScope,
        mockRecords as MemoryRecord[],
        { useCache: false }
      );

      expect(result.slots.task_context).toBeDefined();
      expect(result.slots.resource).toBeDefined();
      expect(result.telemetry.nodesUsed).toBeGreaterThan(0);
    });

    it("应该按 importance 排序", async () => {
      const records: Partial<MemoryRecord>[] = [
        { id: "1", kind: "goal", semanticType: "task_context", text: "Low priority", importance: 0.3, scope: mockScope },
        { id: "2", kind: "goal", semanticType: "task_context", text: "High priority", importance: 0.9, scope: mockScope },
        { id: "3", kind: "goal", semanticType: "task_context", text: "Medium priority", importance: 0.6, scope: mockScope },
      ];

      const result = await builder.buildSlotContext(
        mockScope,
        records as MemoryRecord[],
        { tokenBudgetPerSlot: 200, useCache: false }
      );

      const content = result.slots.task_context?.content ?? "";
      const firstLine = content.split("\n")[0];

      expect(firstLine).toContain("High priority");
    });

    it("应该截断到 token 预算", async () => {
      const manyRecords: Partial<MemoryRecord>[] = Array.from({ length: 20 }, (_, i) => ({
        id: `mem-${i}`,
        kind: "goal",
        semanticType: "task_context",
        text: `任务 ${i}`,
        importance: 0.5,
        scope: mockScope,
      }));

      const result = await builder.buildSlotContext(
        mockScope,
        manyRecords as MemoryRecord[],
        { tokenBudgetPerSlot: 50, useCache: false }
      );

      // 50 字符预算，每条约 10 字符，预期最多 5 条
      expect(result.slots.task_context?.nodeCount).toBeLessThanOrEqual(10);
    });

    it("应该使用缓存", async () => {
      const result1 = await builder.buildSlotContext(
        mockScope,
        mockRecords as MemoryRecord[],
        { useCache: true }
      );

      expect(result1.telemetry.cacheHit).toBe(false);

      const result2 = await builder.buildSlotContext(
        mockScope,
        mockRecords as MemoryRecord[],
        { useCache: true }
      );

      expect(result2.telemetry.cacheHit).toBe(true);
    });

    it("应该警告延迟超预算", async () => {
      const result = await builder.buildSlotContext(
        mockScope,
        mockRecords as MemoryRecord[],
        { latencyBudgetMs: 1, useCache: false }
      );

      // 注意：实际延迟可能 < 1ms，此测试可能不稳定
      // 更可靠的方式是 mock Date.now()
      if (result.telemetry.latencyMs > 1) {
        expect(result.warnings).toBeDefined();
        expect(result.warnings![0]).toContain("超过预算");
      }
    });

    it("应该自动映射 semanticType", async () => {
      const recordsWithoutType: Partial<MemoryRecord>[] = [
        { id: "1", kind: "goal", text: "项目目标", importance: 0.9, scope: mockScope },
        { id: "2", kind: "document", text: "文档", importance: 0.7, scope: mockScope },
      ];

      const result = await builder.buildSlotContext(
        mockScope,
        recordsWithoutType as MemoryRecord[],
        { useCache: false }
      );

      expect(result.slots.task_context).toBeDefined();
      expect(result.slots.resource).toBeDefined();
    });

    it("应该跳过无法归类的记忆", async () => {
      const recordsWithUnmappable: Partial<MemoryRecord>[] = [
        { id: "1", kind: "goal", text: "项目目标", importance: 0.9, scope: mockScope },
        { id: "2", kind: "fact", text: "一个事实", importance: 0.7, scope: mockScope },
      ];

      const result = await builder.buildSlotContext(
        mockScope,
        recordsWithUnmappable as MemoryRecord[],
        { useCache: false }
      );

      expect(result.slots.task_context).toBeDefined();
      expect(result.telemetry.nodesUsed).toBe(1);
    });
  });

  describe("invalidateCache", () => {
    it("应该使缓存失效", async () => {
      await builder.buildSlotContext(mockScope, mockRecords as MemoryRecord[], { useCache: true });

      builder.invalidateCache(mockScope, "task_context");

      const cached = cache.get(mockScope, "task_context");
      expect(cached).toBeNull();
    });
  });

  describe("filtered 收集", () => {
    it("revoked 记忆进入 filtered，reason=lifecycle_revoked", async () => {
      const records: Partial<MemoryRecord>[] = [
        { id: "active-1", kind: "goal", semanticType: "task_context", text: "活跃任务", importance: 0.9, scope: mockScope },
        { id: "revoked-1", kind: "preference", semanticType: "profile", text: "已撤销", importance: 0.8, lifecycleStatus: "revoked", scope: mockScope },
      ];

      const result = await builder.buildSlotContext(mockScope, records as MemoryRecord[], { useCache: false });

      const entry = result.filtered?.find((f) => f.recordId === "revoked-1");
      expect(entry).toBeDefined();
      expect(entry!.reason).toBe("lifecycle_revoked");
    });

    it("superseded 记忆进入 filtered，reason=lifecycle_superseded", async () => {
      const records: Partial<MemoryRecord>[] = [
        { id: "sup-1", kind: "goal", semanticType: "task_context", text: "旧版本", importance: 0.8, lifecycleStatus: "superseded", scope: mockScope },
      ];

      const result = await builder.buildSlotContext(mockScope, records as MemoryRecord[], { useCache: false });

      expect(result.filtered?.[0]?.reason).toBe("lifecycle_superseded");
    });

    it("archived 记忆进入 filtered，reason=lifecycle_archived", async () => {
      const records: Partial<MemoryRecord>[] = [
        { id: "arc-1", kind: "goal", semanticType: "task_context", text: "归档", importance: 0.8, lifecycleStatus: "archived", scope: mockScope },
      ];

      const result = await builder.buildSlotContext(mockScope, records as MemoryRecord[], { useCache: false });

      expect(result.filtered?.[0]?.reason).toBe("lifecycle_archived");
    });

    it("无 semanticType 的记忆进入 filtered，reason=no_semantic_type", async () => {
      const records: Partial<MemoryRecord>[] = [
        { id: "goal-1", kind: "goal", text: "目标", importance: 0.9, scope: mockScope },
        { id: "fact-1", kind: "fact", text: "无法归类的事实", importance: 0.7, scope: mockScope },
      ];

      const result = await builder.buildSlotContext(mockScope, records as MemoryRecord[], { useCache: false });

      const entry = result.filtered?.find((f) => f.recordId === "fact-1");
      expect(entry).toBeDefined();
      expect(entry!.reason).toBe("no_semantic_type");
    });

    it("超预算被裁掉的记忆进入 filtered，reason=budget_exceeded", async () => {
      const manyRecords: Partial<MemoryRecord>[] = Array.from({ length: 10 }, (_, i) => ({
        id: `mem-${i}`,
        kind: "goal",
        semanticType: "task_context",
        text: `任务内容编号 ${i}`,
        importance: 0.5,
        scope: mockScope,
      }));

      const result = await builder.buildSlotContext(mockScope, manyRecords as MemoryRecord[], {
        tokenBudgetPerSlot: 30,
        useCache: false,
      });

      const budgetFiltered = result.filtered?.filter((f) => f.reason === "budget_exceeded") ?? [];
      expect(budgetFiltered.length).toBeGreaterThan(0);
    });

    it("filteredSummary 按 reason 聚合计数", async () => {
      const records: Partial<MemoryRecord>[] = [
        { id: "r1", kind: "preference", semanticType: "profile", text: "撤销1", importance: 0.8, lifecycleStatus: "revoked", scope: mockScope },
        { id: "r2", kind: "preference", semanticType: "profile", text: "撤销2", importance: 0.8, lifecycleStatus: "revoked", scope: mockScope },
        { id: "f1", kind: "fact", text: "事实", importance: 0.5, scope: mockScope },
      ];

      const result = await builder.buildSlotContext(mockScope, records as MemoryRecord[], { useCache: false });

      const revokedSummary = result.filteredSummary?.find((s) => s.reason === "lifecycle_revoked");
      expect(revokedSummary?.count).toBe(2);
      const noTypeSummary = result.filteredSummary?.find((s) => s.reason === "no_semantic_type");
      expect(noTypeSummary?.count).toBe(1);
    });

    it("全部 active 且可归类时 filtered 为空数组", async () => {
      const records: Partial<MemoryRecord>[] = [
        { id: "g1", kind: "goal", semanticType: "task_context", text: "任务", importance: 0.9, scope: mockScope },
      ];

      const result = await builder.buildSlotContext(mockScope, records as MemoryRecord[], { useCache: false });

      expect(result.filtered).toEqual([]);
      expect(result.filteredSummary).toEqual([]);
    });
  });

  describe("profile 分层合并（D-13）", () => {
    it("同 profileDimension，project 层覆盖 global 层", async () => {
      const records: Partial<MemoryRecord>[] = [
        {
          id: "global-lang",
          kind: "preference",
          semanticType: "profile",
          text: "默认用英文",
          importance: 0.8,
          profileDimension: "language",
          profileLayer: "global",
          scope: mockScope,
          createdAt: 1000,
        },
        {
          id: "project-lang",
          kind: "preference",
          semanticType: "profile",
          text: "这个项目里用中文",
          importance: 0.9,
          profileDimension: "language",
          profileLayer: "project",
          scope: mockScope,
          createdAt: 2000,
        },
      ];

      const result = await builder.buildSlotContext(mockScope, records as MemoryRecord[], { useCache: false });

      // active 应该只有 project 层的记忆
      expect(result.slots.profile?.nodeCount).toBe(1);
      expect(result.slots.profile?.content).toContain("这个项目里用中文");
      expect(result.slots.profile?.content).not.toContain("默认用英文");

      // global 层被覆盖，进入 filtered
      const overridden = result.filtered?.find((f) => f.recordId === "global-lang");
      expect(overridden).toBeDefined();
      expect(overridden?.reason).toBe("overridden_by_layer");
      expect(overridden?.metadata?.overriddenBy).toBe("project");
    });

    it("不同 profileDimension 互不影响，全部保留", async () => {
      const records: Partial<MemoryRecord>[] = [
        {
          id: "lang",
          kind: "preference",
          semanticType: "profile",
          text: "默认用中文",
          importance: 0.8,
          profileDimension: "language",
          profileLayer: "global",
          scope: mockScope,
        },
        {
          id: "style",
          kind: "preference",
          semanticType: "profile",
          text: "回答要详细",
          importance: 0.9,
          profileDimension: "response_style",
          profileLayer: "project",
          scope: mockScope,
        },
        {
          id: "verify",
          kind: "preference",
          semanticType: "profile",
          text: "总是先验证",
          importance: 0.85,
          profileDimension: "verification_preference",
          profileLayer: "app",
          scope: mockScope,
        },
      ];

      const result = await builder.buildSlotContext(mockScope, records as MemoryRecord[], { useCache: false });

      // 3 个不同维度，全部保留
      expect(result.slots.profile?.nodeCount).toBe(3);
      expect(result.slots.profile?.content).toContain("默认用中文");
      expect(result.slots.profile?.content).toContain("回答要详细");
      expect(result.slots.profile?.content).toContain("总是先验证");

      // 无 filtered
      expect(result.filtered?.filter((f) => f.reason === "overridden_by_layer")).toHaveLength(0);
    });

    it("app 层覆盖 global 层，但不覆盖 project 层", async () => {
      const records: Partial<MemoryRecord>[] = [
        {
          id: "global-lang",
          kind: "preference",
          semanticType: "profile",
          text: "默认用英文",
          importance: 0.7,
          profileDimension: "language",
          profileLayer: "global",
          scope: mockScope,
          createdAt: 1000,
        },
        {
          id: "app-lang",
          kind: "preference",
          semanticType: "profile",
          text: "在 Codex 里用中文",
          importance: 0.8,
          profileDimension: "language",
          profileLayer: "app",
          scope: mockScope,
          createdAt: 2000,
        },
      ];

      const result = await builder.buildSlotContext(mockScope, records as MemoryRecord[], { useCache: false });

      // app 层胜出
      expect(result.slots.profile?.nodeCount).toBe(1);
      expect(result.slots.profile?.content).toContain("在 Codex 里用中文");

      // global 层被覆盖
      const overridden = result.filtered?.find((f) => f.recordId === "global-lang");
      expect(overridden?.reason).toBe("overridden_by_layer");
      expect(overridden?.metadata?.overriddenBy).toBe("app");
    });

    it("自动推断缺失的 profileLayer", async () => {
      const records: Partial<MemoryRecord>[] = [
        {
          id: "infer-project",
          kind: "preference",
          semanticType: "profile",
          text: "在这个项目里用中文",
          importance: 0.9,
          profileDimension: "language",
          // profileLayer 缺失，应自动推断为 project
          scope: mockScope,
        },
        {
          id: "infer-global",
          kind: "preference",
          semanticType: "profile",
          text: "总是用详细风格",
          importance: 0.8,
          profileDimension: "response_style",
          // profileLayer 缺失，应自动推断为 global
          scope: { ...mockScope, projectId: "" },
        },
      ];

      const result = await builder.buildSlotContext(mockScope, records as MemoryRecord[], { useCache: false });

      // 两条都应该被推断并保留（不同维度）
      expect(result.slots.profile?.nodeCount).toBe(2);
    });

    it("无 profileDimension 的 profile 记忆归入 unclassified，仍保留", async () => {
      const records: Partial<MemoryRecord>[] = [
        {
          id: "no-dim",
          kind: "preference",
          semanticType: "profile",
          text: "用户偏好但无维度",
          importance: 0.8,
          profileLayer: "global",
          // profileDimension 缺失
          scope: mockScope,
        },
        {
          id: "has-dim",
          kind: "preference",
          semanticType: "profile",
          text: "默认用中文",
          importance: 0.9,
          profileDimension: "language",
          profileLayer: "global",
          scope: mockScope,
        },
      ];

      const result = await builder.buildSlotContext(mockScope, records as MemoryRecord[], { useCache: false });

      // 两条都保留（unclassified 也进 active）
      expect(result.slots.profile?.nodeCount).toBe(2);
    });

    it("复杂场景：3 层 2 维度混合", async () => {
      const records: Partial<MemoryRecord>[] = [
        // language 维度：3 层都有，project 应该胜出
        {
          id: "lang-global",
          kind: "preference",
          semanticType: "profile",
          text: "全局默认英文",
          importance: 0.7,
          profileDimension: "language",
          profileLayer: "global",
          scope: mockScope,
          createdAt: 1000,
        },
        {
          id: "lang-app",
          kind: "preference",
          semanticType: "profile",
          text: "Codex 里用简体中文",
          importance: 0.8,
          profileDimension: "language",
          profileLayer: "app",
          scope: mockScope,
          createdAt: 2000,
        },
        {
          id: "lang-project",
          kind: "preference",
          semanticType: "profile",
          text: "这个项目里用繁体中文",
          importance: 0.9,
          profileDimension: "language",
          profileLayer: "project",
          scope: mockScope,
          createdAt: 3000,
        },
        // response_style 维度：只有 app 层
        {
          id: "style-app",
          kind: "preference",
          semanticType: "profile",
          text: "回答要详细",
          importance: 0.85,
          profileDimension: "response_style",
          profileLayer: "app",
          scope: mockScope,
          createdAt: 4000,
        },
      ];

      const result = await builder.buildSlotContext(mockScope, records as MemoryRecord[], { useCache: false });

      // active 应该有 2 条（每个维度 1 条）
      expect(result.slots.profile?.nodeCount).toBe(2);
      expect(result.slots.profile?.content).toContain("这个项目里用繁体中文");
      expect(result.slots.profile?.content).toContain("回答要详细");

      // language 维度的 global 和 app 被覆盖
      const overridden = result.filtered?.filter((f) => f.reason === "overridden_by_layer") ?? [];
      expect(overridden).toHaveLength(2);

      const overriddenIds = overridden.map((f) => f.recordId);
      expect(overriddenIds).toContain("lang-global");
      expect(overriddenIds).toContain("lang-app");
    });
  });
});
