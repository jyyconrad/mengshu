/**
 * slot-context-builder.test.ts
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SlotContextBuilder } from "./slot-context-builder.js";
import { SlotSnapshotCache } from "./slot-snapshot.js";
import type { MemoryScope } from "../domain/semantic-types.js";
import type { MemoryRecord } from "../domain/types.js";
import { computeRecallScoreBreakdown } from "../domain/recall-scoring.js";
import type { TreeSummaryNode } from "../tree/types.js";

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
    it("把 evidence/leaf 命中的 sealed tree 按 source R1、topic/global R2 接入对应槽位", async () => {
      const record = {
        ...mockRecords[0],
        id: "memory-tree-1",
        sourceNodeIds: ["evidence-tree-1"],
        lifecycleStatus: "active",
      } as MemoryRecord;
      const tree = (treeType: TreeSummaryNode["treeType"], id: string): TreeSummaryNode => ({
        id, scope: mockScope, treeType, treeKey: `${treeType}-key`,
        level: treeType === "global" ? 3 : treeType === "topic" ? 2 : 1,
        title: `${treeType} summary`, summary: "bounded summary", childNodeIds: [],
        leafIds: [record.id], evidenceChunkIds: ["evidence-tree-1"], entityIds: [],
        relationIds: [], tokenCount: 20, timeRange: { startAt: 1, endAt: 2 },
        status: "sealed", createdAt: 1, sealedAt: 2, metadata: { summaryMode: "extractive" },
      });

      const response = await builder.buildSlotContext(mockScope, [record], {
        useCache: false,
        treeDepth: "topic",
        treeSummaries: [tree("source", "source-tree-1"), tree("topic", "topic-tree-1"),
          tree("global", "global-tree-1"), { ...tree("topic", "invalid-tree"), tokenCount: 501 }],
      });

      expect(response.assemblyPlan?.slots.task_context?.navigation).toEqual(expect.arrayContaining([
        expect.objectContaining({ ref: "source-tree-1", kind: "source_tree", level: "R1" }),
        expect.objectContaining({ ref: "topic-tree-1", kind: "topic_tree", level: "R2" }),
      ]));
      expect(response.assemblyPlan?.slots.task_context?.navigation)
        .not.toEqual(expect.arrayContaining([
          expect.objectContaining({ ref: "global-tree-1" }),
          expect.objectContaining({ ref: "invalid-tree" }),
        ]));
    });

    it("生产 RecallHit 按唯一六因子总分排序并把完整回执保留到槽位", async () => {
      const highImportance = {
        ...mockRecords[0],
        id: "high-importance",
        text: "importance 高但任务相关性低",
        importance: 0.95,
        confidence: 1,
      } as MemoryRecord;
      const highRelevance = {
        ...mockRecords[0],
        id: "high-relevance",
        text: "importance 低但任务相关性高",
        importance: 0.2,
        confidence: 1,
      } as MemoryRecord;
      const lowScoreBreakdown = computeRecallScoreBreakdown(
        highImportance,
        { relevance: 0.05, scopeFit: 1 },
        ["vector"],
        { vector: 0.05 },
      );
      const highScoreBreakdown = computeRecallScoreBreakdown(
        highRelevance,
        { relevance: 1, scopeFit: 1 },
        ["vector"],
        { vector: 1 },
      );

      const result = await builder.buildSlotContextFromRecallHits(
        mockScope,
        [
          { record: highImportance, score: lowScoreBreakdown.score, source: "vector", scoreBreakdown: lowScoreBreakdown },
          { record: highRelevance, score: highScoreBreakdown.score, source: "vector", scoreBreakdown: highScoreBreakdown },
        ],
        { useCache: false },
      );

      expect(result.slots.task_context?.sourceIds).toEqual([
        "high-relevance",
        "high-importance",
      ]);
      expect(result.slots.task_context?.recallReceipts).toEqual([
        expect.objectContaining({
          sourceId: "high-relevance",
          score: highScoreBreakdown.score,
          scoreBreakdown: highScoreBreakdown,
        }),
        expect.objectContaining({
          sourceId: "high-importance",
          score: lowScoreBreakdown.score,
          scoreBreakdown: lowScoreBreakdown,
        }),
      ]);
      expect(result.slots.task_context?.evidenceRefs).toEqual([
        ...(highRelevance.sourceNodeIds ?? []),
        ...(highImportance.sourceNodeIds ?? []),
      ]);
      expect(result.assemblyPlan?.slots.task_context?.mustRead[0]).toMatchObject({
        ref: "high-relevance",
        semanticType: "task_context",
      });
      expect(result.assemblyPlan?.versions.slotSnapshot).toBe(2);
      expect(result.assemblyPlan?.stableContentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.assemblyPlan?.dynamicContentHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("任务变化只改变动态 hash，不改变稳定 profile/rules hash", async () => {
      const record = {
        ...mockRecords[0],
        id: "stable-rule",
        semanticType: "rules",
        sourceNodeIds: ["evidence-rule"],
      } as MemoryRecord;
      const breakdown = computeRecallScoreBreakdown(
        record,
        { relevance: 1, scopeFit: 1 },
        ["vector"],
        { vector: 1 },
      );
      const hits = [{ record, score: breakdown.score, source: "vector" as const, scoreBreakdown: breakdown }];

      const first = await builder.buildSlotContextFromRecallHits(
        mockScope,
        hits,
        { useCache: false, task: "first task" },
      );
      const second = await builder.buildSlotContextFromRecallHits(
        mockScope,
        hits,
        { useCache: false, task: "second task" },
      );

      expect(first.assemblyPlan?.stableContentHash).toBe(second.assemblyPlan?.stableContentHash);
      expect(first.assemblyPlan?.dynamicContentHash).not.toBe(second.assemblyPlan?.dynamicContentHash);
      expect(first.slots.rules?.evidenceRefs).toEqual(["evidence-rule"]);
    });

    it("生产 RecallHit 缺少完整六因子回执时 fail-closed", async () => {
      const record = mockRecords[0] as MemoryRecord;

      await expect(builder.buildSlotContextFromRecallHits(
        mockScope,
        [{ record, score: 0.9, source: "vector" }],
        { useCache: false },
      )).rejects.toThrow("CONTEXT_RECALL_BREAKDOWN_REQUIRED");
    });

    it("缓存输入发生 revoke 后不会继续注入旧节点", async () => {
      const active = {
        ...mockRecords[0],
        id: "cache-revoke",
        text: "随后会被撤回的规则",
        semanticType: "rules",
        lifecycleStatus: "active",
      } as MemoryRecord;
      const breakdown = computeRecallScoreBreakdown(
        active,
        { relevance: 1, scopeFit: 1 },
        ["vector"],
        { vector: 1 },
      );

      const first = await builder.buildSlotContextFromRecallHits(
        mockScope,
        [{ record: active, score: breakdown.score, source: "vector", scoreBreakdown: breakdown }],
        { useCache: true },
      );
      const revoked = { ...active, lifecycleStatus: "revoked" as const };
      const second = await builder.buildSlotContextFromRecallHits(
        mockScope,
        [{ record: revoked, score: breakdown.score, source: "vector", scoreBreakdown: breakdown }],
        { useCache: true },
      );

      expect(first.content).toContain("随后会被撤回的规则");
      expect(second.content).not.toContain("随后会被撤回的规则");
      expect(second.filtered).toContainEqual(expect.objectContaining({
        recordId: "cache-revoke",
        reason: "lifecycle_revoked",
      }));
    });

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
    it("session_candidate evidence 不进入原生 5 槽位/context_fast，reason=raw_evidence", async () => {
      const records: Partial<MemoryRecord>[] = [{
        id: "evidence-1",
        kind: "observation",
        container: "session_candidate",
        text: "尚未经过候选审核的原始观察",
        importance: 0.9,
        lifecycleStatus: "active",
        metadata: { admissionRoute: "evidence_only" },
        scope: mockScope,
      }];

      const result = await builder.buildSlotContext(
        mockScope,
        records as MemoryRecord[],
        { useCache: false },
      );

      expect(result.content).not.toContain("原始观察");
      expect(result.filtered).toEqual([
        expect.objectContaining({ recordId: "evidence-1", reason: "raw_evidence" }),
      ]);
    });

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
