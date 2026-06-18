/**
 * Entity 三级匹配解析器（§5.10 实现）
 *
 * 实现 Graph 实体的去重逻辑，使用三级匹配算法（从快到慢，命中即停）：
 * 1. 精确匹配：canonicalName 完全相同
 * 2. 别名表：命中 TOOL_ALIASES 或用户自定义别名表
 * 3. 语义匹配：仅同 scope + 同 type，person/file 跳过
 *
 * 设计文档：docs/04-design/04.2-detail/memory-system-unified-design.md §5.10
 */

import { createHash } from "node:crypto";
import { scopeToKey } from "../core/scope.js";
import type { MemoryScope } from "../core/types.js";
import type { EntityType } from "./schema.js";
import type { GraphEntityRecord, GraphExtractionResult, GraphRelationRecord } from "./types.js";
import type { ValidatedExtraction } from "./extraction-validator.js";

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 原始实体（LLM 提取结果）
 */
export interface RawEntity {
  name: string;
  type: EntityType;
  aliases: string[];
  description?: string;
}

/**
 * Entity 解析结果
 */
export interface EntityResolveResult {
  /** 动作：merge（合并到已有）、create（创建新实体）、judge_or_related（LLM 判断或建关系） */
  action: "merge" | "create" | "judge_or_related";
  /** 目标实体 ID（action=merge/judge_or_related 时） */
  targetId?: string;
  /** 匹配方法（action=merge 时） */
  method?: "exact" | "alias" | "semantic";
  /** 置信度（method=semantic 时） */
  confidence?: number;
  /** 相似度（action=judge_or_related 时） */
  similarity?: number;
  /** 原因（action=create 时） */
  reason?: string;
}

/**
 * Entity 仓储接口（由调用方实现）
 */
export interface EntityRepository {
  /** 根据 canonicalName 查找实体 */
  findByCanonical(scope: MemoryScope, type: EntityType, canonicalName: string): Promise<GraphEntityRecord | null>;
  /** 向量搜索候选实体（返回按相似度降序排列） */
  annSearch(scope: MemoryScope, type: EntityType, name: string, limit: number): Promise<Array<{ id: string; score: number; entity: GraphEntityRecord }>>;
  /** 合并实体 */
  merge(newEntity: RawEntity, targetId: string, metadata: MergeMetadata): Promise<void>;
}

/**
 * 合并元数据
 */
export interface MergeMetadata {
  method: "exact" | "alias" | "semantic" | "llm_judge";
  confidence: number;
  mergedAt: number;
  canRollback: boolean;
}

/**
 * 配置接口
 */
export interface EntityResolverConfig {
  /** 是否启用 LLM 判断（action=judge_or_related 时） */
  enableJudge?: boolean;
  /** 按 type 分级的阈值配置 */
  thresholds?: Partial<Record<EntityType | "default", EntityThreshold>>;
}

/**
 * 实体阈值配置
 */
export interface EntityThreshold {
  /** merge 阈值（>=此值自动合并） */
  mergeThreshold: number;
  /** review 阈值（>=此值进入 judge_or_related） */
  reviewThreshold: number;
}

// ============================================================================
// 常量配置
// ============================================================================

/**
 * 按 type 分级的 entity 阈值（首期统一，后续按 eval 数据分 type 调参）
 */
const ENTITY_THRESHOLDS: Record<EntityType | "default", EntityThreshold> = {
  tool: { mergeThreshold: 0.88, reviewThreshold: 0.80 },
  project: { mergeThreshold: 0.90, reviewThreshold: 0.82 },
  concept: { mergeThreshold: 0.86, reviewThreshold: 0.78 },
  organization: { mergeThreshold: 0.92, reviewThreshold: 0.85 },
  person: { mergeThreshold: 1.0, reviewThreshold: 1.0 }, // 不启用语义
  file: { mergeThreshold: 1.0, reviewThreshold: 1.0 }, // 不启用语义
  repo: { mergeThreshold: 0.90, reviewThreshold: 0.82 },
  topic: { mergeThreshold: 0.86, reviewThreshold: 0.78 },
  task: { mergeThreshold: 0.88, reviewThreshold: 0.80 },
  user: { mergeThreshold: 0.92, reviewThreshold: 0.85 },
  agent: { mergeThreshold: 0.90, reviewThreshold: 0.82 },
  chunk: { mergeThreshold: 1.0, reviewThreshold: 1.0 }, // 不启用语义
  document: { mergeThreshold: 1.0, reviewThreshold: 1.0 }, // 不启用语义
  other: { mergeThreshold: 0.90, reviewThreshold: 0.82 },
  default: { mergeThreshold: 0.90, reviewThreshold: 0.82 },
};

/**
 * 不启用语义合并的实体类型（仅精确匹配 + 别名表）
 */
const NO_SEMANTIC_MERGE_TYPES = new Set<EntityType>(["person", "file", "chunk", "document"]);

/**
 * 工具别名表（硬编码常见别名）
 */
const TOOL_ALIASES: Record<string, string[]> = {
  postgresql: ["postgres", "pg", "psql"],
  javascript: ["js", "ecmascript"],
  typescript: ["ts"],
  python: ["py"],
  kubernetes: ["k8s"],
  docker: ["docker-compose"],
  redis: ["redis-cli"],
  mongodb: ["mongo"],
  mysql: ["mariadb"],
  elasticsearch: ["es", "elastic"],
};

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 生成确定性 hash ID
 */
function hashId(prefix: string, parts: string[]): string {
  const digest = createHash("sha256").update(parts.join(":")).digest("hex").slice(0, 24);
  return `${prefix}_${digest}`;
}

/**
 * 规范化实体名称（用于精确匹配）
 */
export function canonicalize(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * 查找工具别名
 */
function lookupToolAlias(name: string, type: EntityType): string | null {
  if (type !== "tool") return null;

  const canonical = canonicalize(name);

  // 检查是否是某个工具的别名
  for (const [tool, aliases] of Object.entries(TOOL_ALIASES)) {
    const canonicalAliases = aliases.map(a => canonicalize(a));
    if (canonicalAliases.includes(canonical)) {
      return tool;
    }
  }

  return null;
}

// ============================================================================
// 核心解析器
// ============================================================================

/**
 * Entity 三级匹配解析器
 *
 * 算法流程（从快到慢，命中即停）：
 * 1. 精确匹配：canonicalName 完全相同
 * 2. 别名表：命中 TOOL_ALIASES 或用户自定义别名表
 * 3. 语义匹配：仅同 scope + 同 type；person/file 跳过
 */
export async function resolveEntity(
  newEntity: RawEntity,
  scope: MemoryScope,
  entityRepo: EntityRepository,
  config: EntityResolverConfig = {},
): Promise<EntityResolveResult> {
  const canonical = canonicalize(newEntity.name);

  // ============================================================================
  // 级别 1 — 精确匹配：canonicalName 完全相同
  // ============================================================================
  const exact = await entityRepo.findByCanonical(scope, newEntity.type, canonical);
  if (exact) {
    return { action: "merge", targetId: exact.id, method: "exact" };
  }

  // ============================================================================
  // 级别 2 — 别名表：命中 TOOL_ALIASES 或用户自定义别名表
  // ============================================================================
  const aliasCanonical = lookupToolAlias(newEntity.name, newEntity.type);
  if (aliasCanonical) {
    const aliasEntity = await entityRepo.findByCanonical(scope, newEntity.type, aliasCanonical);
    if (aliasEntity) {
      return { action: "merge", targetId: aliasEntity.id, method: "alias" };
    }
  }

  // ============================================================================
  // 级别 3 — 语义匹配（仅同 scope + 同 type；person/file 跳过）
  // ============================================================================
  if (NO_SEMANTIC_MERGE_TYPES.has(newEntity.type)) {
    return { action: "create", reason: "type_no_semantic_merge" };
  }

  const thresholds = config.thresholds?.[newEntity.type] ?? ENTITY_THRESHOLDS[newEntity.type] ?? ENTITY_THRESHOLDS.default;
  const { mergeThreshold, reviewThreshold } = thresholds;

  const candidates = await entityRepo.annSearch(scope, newEntity.type, newEntity.name, 10);
  const top = candidates[0];
  if (!top) {
    return { action: "create", reason: "no_candidates" };
  }

  if (top.score >= mergeThreshold) {
    return { action: "merge", targetId: top.id, method: "semantic", confidence: top.score };
  }

  if (top.score >= reviewThreshold) {
    return { action: "judge_or_related", targetId: top.id, similarity: top.score };
  }

  return { action: "create", reason: "below_threshold" };
}

// ============================================================================
// 兼容层：保持向后兼容的 resolveExtraction 函数
// ============================================================================

/**
 * 将 LLM 验证后的提取结果解析为图谱记录（向后兼容）
 *
 * 注意：这是旧版简单实现，不包含三级匹配逻辑。
 * 如需使用三级匹配，请直接调用 resolveEntity()。
 */
export function resolveExtraction(
  validated: ValidatedExtraction,
  scope: MemoryScope,
  chunkId: string,
  createdAt: number,
): GraphExtractionResult {
  const scopeKey = scopeToKey(scope);

  const entities: GraphEntityRecord[] = validated.entities.map((entity) => {
    const id = hashId("ent", [scopeKey, entity.type, canonicalize(entity.name)]);
    const aliases = [...new Set([entity.name, ...entity.aliases])];
    return {
      id,
      scope,
      canonicalName: canonicalize(entity.name),
      displayName: entity.name,
      type: entity.type,
      aliases,
      mentionCount: 1,
      mentionCount30d: 1,
      distinctSourceCount: 1,
      hotness: 0,
      queryHits30d: 0,
      status: "active",
      createdAt,
      updatedAt: createdAt,
      metadata: { description: entity.description, source: "llm" },
    };
  });

  const nameToId = new Map<string, string>(
    entities.map((e, i) => [validated.entities[i].name, e.id]),
  );

  const relations: GraphRelationRecord[] = validated.relations.map((relation) => {
    const subjectId = nameToId.get(relation.subject)!;
    const objectId = nameToId.get(relation.object)!;
    const id = hashId("rel", [scopeKey, subjectId, relation.predicate, objectId]);
    return {
      id,
      scope,
      subjectId,
      predicate: relation.predicate,
      objectId,
      confidence: relation.confidence,
      evidenceChunkIds: [chunkId],
      evidenceCount: 1,
      firstSeenAt: createdAt,
      lastSeenAt: createdAt,
      status: relation.confidence < 0.5 ? "weak" : "active",
      sourceKinds: ["llm"],
      metadata: { evidence: relation.evidence },
    };
  });

  return { entities, relations };
}

// ============================================================================
// 导出配置常量（供外部使用）
// ============================================================================

export { ENTITY_THRESHOLDS, NO_SEMANTIC_MERGE_TYPES, TOOL_ALIASES };
