/**
 * Graph Centrality Calculator - 计算 entity 的图中心性
 *
 * 设计参考：theory-algorithm-design.md §4.4
 * P2 核心功能：按 entity degree 归一化计算 graphCentrality = degree / max(degree_in_scope)
 */

import type { InMemoryGraphRepository } from "./repository.js";
import type { MemoryScope } from "../core/types.js";
import { scopeToKey } from "../core/scope.js";

export interface CentralityCalculatorOptions {
  graphRepo: InMemoryGraphRepository;
}

export class CentralityCalculator {
  private readonly graphRepo: InMemoryGraphRepository;

  constructor(options: CentralityCalculatorOptions) {
    this.graphRepo = options.graphRepo;
  }

  /**
   * 计算指定 scope 下所有 entity 的 graphCentrality。
   *
   * 算法：
   * 1. 统计每个 entity 的 degree（作为 subject 或 object 的 relation 数量）
   * 2. 归一化：graphCentrality = degree / max(degree_in_scope)
   *
   * @param scope - 要计算的 scope
   */
  async calculateCentrality(scope: MemoryScope): Promise<void> {
    // 获取 scope 内的所有 entity 和 relation
    const entities = await this.graphRepo.findEntities({ scope, limit: Number.POSITIVE_INFINITY });
    const relations = await this.graphRepo.findRelations({ scope, limit: Number.POSITIVE_INFINITY });

    if (entities.length === 0) {
      return;
    }

    // 统计每个 entity 的 degree
    const degreeMap = new Map<string, number>();
    for (const entity of entities) {
      degreeMap.set(entity.id, 0);
    }

    for (const relation of relations) {
      if (relation.status !== "active") {
        continue; // 只统计 active 关系
      }
      const subjectDegree = degreeMap.get(relation.subjectId) ?? 0;
      degreeMap.set(relation.subjectId, subjectDegree + 1);

      const objectDegree = degreeMap.get(relation.objectId) ?? 0;
      degreeMap.set(relation.objectId, objectDegree + 1);
    }

    // 找到最大 degree
    let maxDegree = 0;
    for (const degree of degreeMap.values()) {
      if (degree > maxDegree) {
        maxDegree = degree;
      }
    }

    // 归一化并更新 entity
    const now = Date.now();
    const updatedEntities = entities.map((entity) => {
      const degree = degreeMap.get(entity.id) ?? 0;
      const centrality = maxDegree > 0 ? degree / maxDegree : 0;
      return {
        ...entity,
        graphCentrality: centrality,
        updatedAt: now,
      };
    });

    await this.graphRepo.upsertEntities(updatedEntities);
  }

  /**
   * 批量计算多个 scope 的 centrality。
   *
   * @param scopes - 要计算的 scope 列表
   */
  async calculateCentralityBatch(scopes: MemoryScope[]): Promise<void> {
    for (const scope of scopes) {
      await this.calculateCentrality(scope);
    }
  }
}
