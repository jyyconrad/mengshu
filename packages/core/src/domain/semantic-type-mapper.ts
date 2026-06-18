/**
 * kind → semanticType 映射器
 *
 * 本文件实现 MemoryKind 到 MemorySemanticType 的确定性映射规则。
 *
 * 核心原则：
 * 1. semanticType 是可选字段，不强制所有 kind 都有映射
 * 2. 映射规则基于启发式逻辑，不依赖 LLM
 * 3. v0.1 只映射高置信度的 kind（goal/document/knowledge）
 * 4. 无法归类的保留 kind，通过 memory_lookup 检索
 *
 * 映射规则详见：
 * ~/.claude/tasks/20260608-1430-mengshu-architecture-upgrade/kind-semantic-type-mapping-rules.json
 */

import type { MemoryKind, MemoryRecord, MemorySemanticType } from "../../../../core/types.js";

/**
 * 映射置信度
 */
export type MappingConfidence = "high" | "medium" | "low" | "unmappable";

/**
 * 映射结果
 */
export interface MappingResult {
  semanticType: MemorySemanticType | null;
  confidence: MappingConfidence;
  reason?: string;
}

/**
 * kind → semanticType 映射（v0.1 简化版）
 *
 * v0.1 只映射高置信度的 3 个 kind：
 * - goal → task_context
 * - document → resource
 * - knowledge → resource
 *
 * 其他 kind 返回 null，保留为 kind-only 记忆。
 */
export function kindToSemanticType(
  kind: MemoryKind,
  record?: MemoryRecord
): MappingResult {
  // v0.1: 只映射高置信度的 3 个 kind
  switch (kind) {
    case "goal":
      return {
        semanticType: "task_context",
        confidence: "high",
        reason: "目标通常是项目级的，符合 Q2（我在做什么）",
      };

    case "document":
      return {
        semanticType: "resource",
        confidence: "high",
        reason: "文档是可用资源，符合 Q5（有什么可用资源）",
      };

    case "knowledge":
      return {
        semanticType: "resource",
        confidence: "high",
        reason: "知识库条目是可用资源，符合 Q5",
      };

    // v0.1: 以下 kind 暂不映射，延迟到 v0.2
    case "preference":
    case "decision":
    case "task":
    case "plan":
      return {
        semanticType: null,
        confidence: "medium",
        reason: `kind=${kind} 需要上下文判断，v0.1 暂不映射`,
      };

    // 无法归类的 kind
    case "fact":
    case "entity":
    case "observation":
    case "other":
      return {
        semanticType: null,
        confidence: "unmappable",
        reason: `kind=${kind} 无法稳定归类到 5 type`,
      };

    default:
      return {
        semanticType: null,
        confidence: "unmappable",
        reason: `未知 kind: ${kind}`,
      };
  }
}

/**
 * 批量映射（用于回填旧数据）
 *
 * 遍历 MemoryRecord 列表，为每条记忆补充 semanticType。
 * 只更新高置信度的映射结果，低置信度和 unmappable 保留为 undefined。
 */
export function batchMapSemanticType(
  records: MemoryRecord[]
): Array<MemoryRecord & { mappingResult: MappingResult }> {
  return records.map((record) => {
    const mappingResult = kindToSemanticType(record.kind, record);
    const shouldApply =
      (mappingResult.confidence === "high" ||
        mappingResult.confidence === "medium") &&
      mappingResult.semanticType !== null;

    const enriched: MemoryRecord & { mappingResult: MappingResult } = {
      ...record,
      mappingResult,
    };

    if (shouldApply && mappingResult.semanticType) {
      enriched.semanticType = mappingResult.semanticType;
    }

    return enriched;
  });
}

/**
 * 统计映射覆盖率
 */
export function computeMappingCoverage(records: MemoryRecord[]): {
  total: number;
  mapped: number;
  unmapped: number;
  coverageRate: number;
  byConfidence: Record<MappingConfidence, number>;
} {
  const results = records.map((r) => kindToSemanticType(r.kind, r));

  const byConfidence: Record<MappingConfidence, number> = {
    high: 0,
    medium: 0,
    low: 0,
    unmappable: 0,
  };

  results.forEach((r) => {
    byConfidence[r.confidence]++;
  });

  const mapped = results.filter((r) => r.semanticType !== null).length;
  const unmapped = results.length - mapped;

  return {
    total: results.length,
    mapped,
    unmapped,
    coverageRate: results.length > 0 ? mapped / results.length : 0,
    byConfidence,
  };
}
