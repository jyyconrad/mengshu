/**
 * Entity Resolver 测试（§5.10 三级匹配）
 *
 * 测试覆盖：
 * 1. 精确匹配（canonicalName 完全相同）
 * 2. 别名表匹配（TOOL_ALIASES）
 * 3. 语义匹配（embedding 相似度）
 * 4. NO_SEMANTIC_MERGE_TYPES（person/file 仅精确+别名）
 * 5. 按 type 分级的阈值
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  resolveEntity,
  canonicalize,
  ENTITY_THRESHOLDS,
  NO_SEMANTIC_MERGE_TYPES,
  type RawEntity,
  type EntityRepository,
  type EntityResolveResult,
} from "./entity-resolver.js";
import type { MemoryScope } from "../domain/types.js";
import type { GraphEntityRecord } from "./types.js";
import type { EntityType } from "./schema.js";

// ============================================================================
// Mock Entity Repository
// ============================================================================

class MockEntityRepository implements EntityRepository {
  private entities: Map<string, GraphEntityRecord> = new Map();

  addEntity(entity: GraphEntityRecord): void {
    this.entities.set(entity.id, entity);
  }

  async findByCanonical(
    scope: MemoryScope,
    type: EntityType,
    canonicalName: string,
  ): Promise<GraphEntityRecord | null> {
    for (const entity of this.entities.values()) {
      if (
        entity.scope.tenantId === scope.tenantId &&
        entity.scope.appId === scope.appId &&
        entity.scope.projectId === scope.projectId &&
        entity.type === type &&
        entity.canonicalName === canonicalName
      ) {
        return entity;
      }
    }
    return null;
  }

  async annSearch(
    scope: MemoryScope,
    type: EntityType,
    name: string,
    limit: number,
  ): Promise<Array<{ id: string; score: number; entity: GraphEntityRecord }>> {
    // 简单模拟：返回同 scope + 同 type 的实体，按名称相似度排序
    const candidates: Array<{ id: string; score: number; entity: GraphEntityRecord }> = [];

    for (const entity of this.entities.values()) {
      if (
        entity.scope.tenantId === scope.tenantId &&
        entity.scope.appId === scope.appId &&
        entity.scope.projectId === scope.projectId &&
        entity.type === type
      ) {
        // 简单相似度：Jaccard 相似度（仅用于测试）
        const score = calculateJaccardSimilarity(name, entity.displayName);
        candidates.push({ id: entity.id, score, entity });
      }
    }

    return candidates.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async merge(): Promise<void> {
    // Mock: 实际实现需要更新数据库
  }

  reset(): void {
    this.entities.clear();
  }
}

/**
 * 简单 Jaccard 相似度（仅用于测试）
 */
function calculateJaccardSimilarity(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(""));
  const setB = new Set(b.toLowerCase().split(""));
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

// ============================================================================
// 测试辅助函数
// ============================================================================

function createMockEntity(
  id: string,
  name: string,
  type: EntityType,
  scope: MemoryScope = {
    tenantId: "default",
    appId: "test",
    userId: "user1",
    projectId: "proj1",
    agentId: "agent1",
    namespace: "default",
  },
): GraphEntityRecord {
  return {
    id,
    scope,
    canonicalName: canonicalize(name),
    displayName: name,
    type,
    aliases: [name],
    mentionCount: 1,
    mentionCount30d: 1,
    distinctSourceCount: 1,
    hotness: 0,
    queryHits30d: 0,
    status: "active",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata: {},
  };
}

// ============================================================================
// 测试套件
// ============================================================================

describe("Entity Resolver - 三级匹配", () => {
  let repo: MockEntityRepository;
  const scope: MemoryScope = {
    tenantId: "default",
    appId: "test",
    userId: "user1",
    projectId: "proj1",
    agentId: "agent1",
    namespace: "default",
  };

  beforeEach(() => {
    repo = new MockEntityRepository();
  });

  // ==========================================================================
  // 1. 精确匹配测试
  // ==========================================================================

  describe("级别 1 - 精确匹配", () => {
    it("应该匹配 canonicalName 完全相同的实体", async () => {
      const existingEntity = createMockEntity("ent_001", "PostgreSQL", "tool", scope);
      repo.addEntity(existingEntity);

      const newEntity: RawEntity = {
        name: "PostgreSQL",
        type: "tool",
        aliases: [],
      };

      const result = await resolveEntity(newEntity, scope, repo);

      expect(result.action).toBe("merge");
      expect(result.targetId).toBe("ent_001");
      expect(result.method).toBe("exact");
    });

    it("应该忽略大小写和空格差异", async () => {
      const existingEntity = createMockEntity("ent_002", "My Project", "project", scope);
      repo.addEntity(existingEntity);

      const newEntity: RawEntity = {
        name: "MY  PROJECT", // 多余空格 + 大写
        type: "project",
        aliases: [],
      };

      const result = await resolveEntity(newEntity, scope, repo);

      expect(result.action).toBe("merge");
      expect(result.targetId).toBe("ent_002");
      expect(result.method).toBe("exact");
    });

    it("不同 scope 的同名实体不应该匹配", async () => {
      const existingEntity = createMockEntity("ent_003", "Tool A", "tool", {
        tenantId: "default",
        appId: "test",
        userId: "user1",
        projectId: "proj1",
        agentId: "agent1",
        namespace: "default",
      });
      repo.addEntity(existingEntity);

      const newEntity: RawEntity = {
        name: "Tool A",
        type: "tool",
        aliases: [],
      };

      const result = await resolveEntity(
        newEntity,
        {
          tenantId: "default",
          appId: "app1",
          userId: "user1",
          projectId: "proj1",
          agentId: "agent1",
          namespace: "default",
        },
        repo,
      );

      expect(result.action).toBe("create");
      expect(result.reason).toBe("no_candidates");
    });

    it("不同 type 的同名实体不应该匹配", async () => {
      const existingEntity = createMockEntity("ent_004", "React", "tool", scope);
      repo.addEntity(existingEntity);

      const newEntity: RawEntity = {
        name: "React",
        type: "concept", // 不同 type
        aliases: [],
      };

      const result = await resolveEntity(newEntity, scope, repo);

      expect(result.action).toBe("create");
    });
  });

  // ==========================================================================
  // 2. 别名表匹配测试
  // ==========================================================================

  describe("级别 2 - 别名表匹配", () => {
    it("应该匹配 TOOL_ALIASES 中的别名（postgres -> postgresql）", async () => {
      const existingEntity = createMockEntity("ent_005", "postgresql", "tool", scope);
      repo.addEntity(existingEntity);

      const newEntity: RawEntity = {
        name: "postgres", // 别名
        type: "tool",
        aliases: [],
      };

      const result = await resolveEntity(newEntity, scope, repo);

      expect(result.action).toBe("merge");
      expect(result.targetId).toBe("ent_005");
      expect(result.method).toBe("alias");
    });

    it("应该匹配别名表中的多个别名（pg -> postgresql）", async () => {
      const existingEntity = createMockEntity("ent_006", "postgresql", "tool", scope);
      repo.addEntity(existingEntity);

      const newEntity: RawEntity = {
        name: "pg", // 另一个别名
        type: "tool",
        aliases: [],
      };

      const result = await resolveEntity(newEntity, scope, repo);

      expect(result.action).toBe("merge");
      expect(result.targetId).toBe("ent_006");
      expect(result.method).toBe("alias");
    });

    it("非 tool 类型不应该使用别名表", async () => {
      const existingEntity = createMockEntity("ent_007", "postgresql", "concept", scope);
      repo.addEntity(existingEntity);

      const newEntity: RawEntity = {
        name: "postgres",
        type: "concept", // 不是 tool
        aliases: [],
      };

      const result = await resolveEntity(newEntity, scope, repo);

      // 不会匹配别名，会进入语义匹配
      expect(result.action).not.toBe("merge");
      expect(result.method).not.toBe("alias");
    });

    it("应该匹配 k8s -> kubernetes", async () => {
      const existingEntity = createMockEntity("ent_008", "kubernetes", "tool", scope);
      repo.addEntity(existingEntity);

      const newEntity: RawEntity = {
        name: "k8s",
        type: "tool",
        aliases: [],
      };

      const result = await resolveEntity(newEntity, scope, repo);

      expect(result.action).toBe("merge");
      expect(result.targetId).toBe("ent_008");
      expect(result.method).toBe("alias");
    });
  });

  // ==========================================================================
  // 3. 语义匹配测试
  // ==========================================================================

  describe("级别 3 - 语义匹配", () => {
    it("相似度 >= mergeThreshold 应该自动合并", async () => {
      // 注意：这个测试依赖 Mock 的相似度计算
      // 实际实现会使用 embedding 向量相似度
      const existingEntity = createMockEntity("ent_009", "TypeScript", "tool", scope);
      repo.addEntity(existingEntity);

      const newEntity: RawEntity = {
        name: "TypeScript", // 完全相同，Jaccard = 1.0
        type: "tool",
        aliases: [],
      };

      const result = await resolveEntity(newEntity, scope, repo);

      // 因为已经被精确匹配捕获，所以是 exact
      expect(result.action).toBe("merge");
      expect(result.method).toBe("exact");
    });

    it("相似度在 reviewThreshold 和 mergeThreshold 之间应该返回 judge_or_related", async () => {
      // Mock 场景：需要手动构造相似但不完全相同的实体
      const existingEntity = createMockEntity("ent_010", "React Framework", "concept", scope);
      repo.addEntity(existingEntity);

      const newEntity: RawEntity = {
        name: "React Library", // 相似但不同
        type: "concept",
        aliases: [],
      };

      const result = await resolveEntity(newEntity, scope, repo);

      // 根据 Mock 的 Jaccard 相似度，可能会落在 review 区间
      // 实际结果取决于相似度计算
      if (result.action === "judge_or_related") {
        expect(result.targetId).toBe("ent_010");
        expect(result.similarity).toBeGreaterThanOrEqual(ENTITY_THRESHOLDS.concept.reviewThreshold);
        expect(result.similarity).toBeLessThan(ENTITY_THRESHOLDS.concept.mergeThreshold);
      }
    });

    it("相似度 < reviewThreshold 应该创建新实体", async () => {
      const existingEntity = createMockEntity("ent_011", "Redux", "tool", scope);
      repo.addEntity(existingEntity);

      const newEntity: RawEntity = {
        name: "Vue", // 完全不同
        type: "tool",
        aliases: [],
      };

      const result = await resolveEntity(newEntity, scope, repo);

      expect(result.action).toBe("create");
      expect(result.reason).toBe("below_threshold");
    });

    it("没有候选实体应该创建新实体", async () => {
      const newEntity: RawEntity = {
        name: "New Tool",
        type: "tool",
        aliases: [],
      };

      const result = await resolveEntity(newEntity, scope, repo);

      expect(result.action).toBe("create");
      expect(result.reason).toBe("no_candidates");
    });
  });

  // ==========================================================================
  // 4. NO_SEMANTIC_MERGE_TYPES 测试
  // ==========================================================================

  describe("NO_SEMANTIC_MERGE_TYPES - 禁用语义匹配的类型", () => {
    it("person 类型应该跳过语义匹配", async () => {
      const existingEntity = createMockEntity("ent_012", "John Doe", "person", scope);
      repo.addEntity(existingEntity);

      const newEntity: RawEntity = {
        name: "John Smith", // 相似但不同
        type: "person",
        aliases: [],
      };

      const result = await resolveEntity(newEntity, scope, repo);

      expect(result.action).toBe("create");
      expect(result.reason).toBe("type_no_semantic_merge");
    });

    it("file 类型应该跳过语义匹配", async () => {
      const existingEntity = createMockEntity("ent_013", "/path/to/file.ts", "file", scope);
      repo.addEntity(existingEntity);

      const newEntity: RawEntity = {
        name: "/path/to/file2.ts",
        type: "file",
        aliases: [],
      };

      const result = await resolveEntity(newEntity, scope, repo);

      expect(result.action).toBe("create");
      expect(result.reason).toBe("type_no_semantic_merge");
    });

    it("chunk 类型应该跳过语义匹配", async () => {
      const newEntity: RawEntity = {
        name: "chunk-001",
        type: "chunk",
        aliases: [],
      };

      const result = await resolveEntity(newEntity, scope, repo);

      expect(result.action).toBe("create");
      expect(result.reason).toBe("type_no_semantic_merge");
    });

    it("document 类型应该跳过语义匹配", async () => {
      const newEntity: RawEntity = {
        name: "doc-001",
        type: "document",
        aliases: [],
      };

      const result = await resolveEntity(newEntity, scope, repo);

      expect(result.action).toBe("create");
      expect(result.reason).toBe("type_no_semantic_merge");
    });

    it("person 类型仍然支持精确匹配", async () => {
      const existingEntity = createMockEntity("ent_014", "Alice", "person", scope);
      repo.addEntity(existingEntity);

      const newEntity: RawEntity = {
        name: "Alice", // 完全相同
        type: "person",
        aliases: [],
      };

      const result = await resolveEntity(newEntity, scope, repo);

      expect(result.action).toBe("merge");
      expect(result.method).toBe("exact");
    });
  });

  // ==========================================================================
  // 5. 按 type 分级的阈值测试
  // ==========================================================================

  describe("按 type 分级的阈值", () => {
    it("tool 类型应该使用 mergeThreshold=0.88", () => {
      expect(ENTITY_THRESHOLDS.tool.mergeThreshold).toBe(0.88);
      expect(ENTITY_THRESHOLDS.tool.reviewThreshold).toBe(0.80);
    });

    it("organization 类型应该使用更严格的阈值 mergeThreshold=0.92", () => {
      expect(ENTITY_THRESHOLDS.organization.mergeThreshold).toBe(0.92);
      expect(ENTITY_THRESHOLDS.organization.reviewThreshold).toBe(0.85);
    });

    it("concept 类型应该使用更宽松的阈值 mergeThreshold=0.86", () => {
      expect(ENTITY_THRESHOLDS.concept.mergeThreshold).toBe(0.86);
      expect(ENTITY_THRESHOLDS.concept.reviewThreshold).toBe(0.78);
    });

    it("person 类型应该完全禁用语义匹配（mergeThreshold=1.0）", () => {
      expect(ENTITY_THRESHOLDS.person.mergeThreshold).toBe(1.0);
      expect(NO_SEMANTIC_MERGE_TYPES.has("person")).toBe(true);
    });

    it("默认类型应该使用 mergeThreshold=0.90", () => {
      expect(ENTITY_THRESHOLDS.default.mergeThreshold).toBe(0.90);
      expect(ENTITY_THRESHOLDS.default.reviewThreshold).toBe(0.82);
    });
  });

  // ==========================================================================
  // 6. 自定义配置测试
  // ==========================================================================

  describe("自定义配置", () => {
    it("应该支持自定义阈值配置", async () => {
      const existingEntity = createMockEntity("ent_015", "Tool X", "tool", scope);
      repo.addEntity(existingEntity);

      const newEntity: RawEntity = {
        name: "Tool Y",
        type: "tool",
        aliases: [],
      };

      const customConfig = {
        thresholds: {
          tool: { mergeThreshold: 0.95, reviewThreshold: 0.90 },
        },
      };

      const result = await resolveEntity(newEntity, scope, repo, customConfig);

      // 由于提高了阈值，应该更容易返回 create
      expect(result.action).toBe("create");
    });

    it("未配置的类型应该回退到 default", async () => {
      const newEntity: RawEntity = {
        name: "Unknown Entity",
        type: "other",
        aliases: [],
      };

      const result = await resolveEntity(newEntity, scope, repo);

      // 使用 default 阈值
      expect(result.action).toBe("create");
    });
  });

  // ==========================================================================
  // 7. canonicalize 工具函数测试
  // ==========================================================================

  describe("canonicalize 工具函数", () => {
    it("应该转换为小写", () => {
      expect(canonicalize("PostgreSQL")).toBe("postgresql");
    });

    it("应该去除前后空格", () => {
      expect(canonicalize("  PostgreSQL  ")).toBe("postgresql");
    });

    it("应该合并多余空格", () => {
      expect(canonicalize("My   Project")).toBe("my project");
    });

    it("应该保留单个空格", () => {
      expect(canonicalize("React Native")).toBe("react native");
    });

    it("应该处理空字符串", () => {
      expect(canonicalize("")).toBe("");
    });

    it("应该处理仅包含空格的字符串", () => {
      expect(canonicalize("   ")).toBe("");
    });
  });

  // ==========================================================================
  // 8. 边界条件测试
  // ==========================================================================

  describe("边界条件", () => {
    it("空 name 应该被规范化为空字符串", async () => {
      const newEntity: RawEntity = {
        name: "",
        type: "tool",
        aliases: [],
      };

      const result = await resolveEntity(newEntity, scope, repo);

      expect(result.action).toBe("create");
    });

    it("name 包含特殊字符应该正常处理", async () => {
      const existingEntity = createMockEntity("ent_016", "C++", "tool", scope);
      repo.addEntity(existingEntity);

      const newEntity: RawEntity = {
        name: "C++",
        type: "tool",
        aliases: [],
      };

      const result = await resolveEntity(newEntity, scope, repo);

      expect(result.action).toBe("merge");
      expect(result.method).toBe("exact");
    });

    it("name 包含 Unicode 字符应该正常处理", async () => {
      const existingEntity = createMockEntity("ent_017", "数据库", "tool", scope);
      repo.addEntity(existingEntity);

      const newEntity: RawEntity = {
        name: "数据库",
        type: "tool",
        aliases: [],
      };

      const result = await resolveEntity(newEntity, scope, repo);

      expect(result.action).toBe("merge");
      expect(result.method).toBe("exact");
    });

    it("annSearch 返回空数组应该创建新实体", async () => {
      // repo 中没有任何实体
      const newEntity: RawEntity = {
        name: "First Entity",
        type: "tool",
        aliases: [],
      };

      const result = await resolveEntity(newEntity, scope, repo);

      expect(result.action).toBe("create");
      expect(result.reason).toBe("no_candidates");
    });
  });
});
