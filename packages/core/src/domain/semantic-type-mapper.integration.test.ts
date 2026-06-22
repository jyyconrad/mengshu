/**
 * semantic-type-mapper.integration.test.ts
 *
 * 集成测试：验证 kind → semanticType 映射在 SlotContextBuilder 中的使用
 */

import { describe, it, expect } from "vitest";
import { kindToSemanticType, batchMapSemanticType } from "./semantic-type-mapper.js";
import type { MemoryRecord } from "./types.js";

describe("semantic-type-mapper 集成测试", () => {
  describe("P1 问题修复：decision/preference 映射", () => {
    it("decision 应映射到 rules（高置信度）", () => {
      const result = kindToSemanticType("decision");
      expect(result.semanticType).toBe("rules");
      expect(result.confidence).toBe("high");
      expect(result.reason).toContain("技术决策");
    });

    it("preference 应映射到 profile（高置信度）", () => {
      const result = kindToSemanticType("preference");
      expect(result.semanticType).toBe("profile");
      expect(result.confidence).toBe("high");
      expect(result.reason).toContain("偏好");
    });

    it("task 应映射到 task_context（高置信度）", () => {
      const result = kindToSemanticType("task");
      expect(result.semanticType).toBe("task_context");
      expect(result.confidence).toBe("high");
    });

    it("plan 应映射到 task_context（高置信度）", () => {
      const result = kindToSemanticType("plan");
      expect(result.semanticType).toBe("task_context");
      expect(result.confidence).toBe("high");
    });
  });

  describe("模拟 Recall 返回场景", () => {
    it("Recall 返回的 decision 记录应能通过 enrichSemanticType 补充 semanticType", () => {
      // 模拟 Recall 返回的记录（kind="decision"，无 semanticType）
      const recallRecords: Partial<MemoryRecord>[] = [
        {
          id: "decision-001",
          kind: "decision",
          text: "使用 Postgres 作为主数据库",
          scope: "project:test-project" as any,
          lifecycleStatus: "active",
          // 注意：没有 semanticType 字段
        },
        {
          id: "preference-001",
          kind: "preference",
          text: "代码风格偏好：使用 2 空格缩进",
          scope: "project:test-project" as any,
          lifecycleStatus: "active",
        },
      ];

      // 批量映射（模拟 SlotContextBuilder.enrichSemanticType）
      const enriched = batchMapSemanticType(recallRecords as MemoryRecord[]);

      // 验证 decision 映射到 rules
      expect(enriched[0].semanticType).toBe("rules");
      expect(enriched[0].mappingResult.confidence).toBe("high");

      // 验证 preference 映射到 profile
      expect(enriched[1].semanticType).toBe("profile");
      expect(enriched[1].mappingResult.confidence).toBe("high");
    });

    it("混合记录：有些有 semanticType，有些需要映射", () => {
      const records: Partial<MemoryRecord>[] = [
        {
          id: "1",
          kind: "goal",
          semanticType: "task_context", // 已有 semanticType
          text: "实现用户认证",
        },
        {
          id: "2",
          kind: "decision",
          // 无 semanticType，需要映射
          text: "决策：使用 JWT 而非 session",
        },
        {
          id: "3",
          kind: "fact",
          // fact 无法映射，应保持 undefined
          text: "服务器 IP: 192.168.1.1",
        },
      ];

      const enriched = batchMapSemanticType(records as MemoryRecord[]);

      // 记录 1：保留原有 semanticType
      expect(enriched[0].semanticType).toBe("task_context");

      // 记录 2：自动映射
      expect(enriched[1].semanticType).toBe("rules");

      // 记录 3：无法映射，保持 undefined
      expect(enriched[2].semanticType).toBeUndefined();
    });
  });

  describe("5 槽位分组验证", () => {
    it("所有映射的 kind 应覆盖 5 个 semanticType", () => {
      const testKinds: Array<{ kind: any; expectedType: string }> = [
        { kind: "preference", expectedType: "profile" },
        { kind: "goal", expectedType: "task_context" },
        { kind: "task", expectedType: "task_context" },
        { kind: "plan", expectedType: "task_context" },
        { kind: "decision", expectedType: "rules" },
        { kind: "document", expectedType: "resource" },
        { kind: "knowledge", expectedType: "resource" },
        // experience 映射缺失（需要从 kind 推断或用户显式标注）
      ];

      const coveredTypes = new Set<string>();
      testKinds.forEach(({ kind, expectedType }) => {
        const result = kindToSemanticType(kind);
        expect(result.semanticType).toBe(expectedType);
        if (result.semanticType) {
          coveredTypes.add(result.semanticType);
        }
      });

      // 验证至少覆盖 4 个 type（experience 可能需要额外处理）
      expect(coveredTypes.size).toBeGreaterThanOrEqual(4);
      expect(coveredTypes.has("profile")).toBe(true);
      expect(coveredTypes.has("task_context")).toBe(true);
      expect(coveredTypes.has("rules")).toBe(true);
      expect(coveredTypes.has("resource")).toBe(true);
    });
  });

  describe("边界情况", () => {
    it("未知 kind 返回 unmappable", () => {
      const result = kindToSemanticType("unknown_kind" as any);
      expect(result.semanticType).toBeNull();
      expect(result.confidence).toBe("unmappable");
    });

    it("unmappable kind 不应被 batchMapSemanticType 应用", () => {
      const records: Partial<MemoryRecord>[] = [
        { id: "1", kind: "fact" },
      ];

      const enriched = batchMapSemanticType(records as MemoryRecord[]);
      expect(enriched[0].semanticType).toBeUndefined();
      expect(enriched[0].mappingResult.confidence).toBe("unmappable");
    });
  });
});
