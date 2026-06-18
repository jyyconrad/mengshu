/**
 * Query Hits Tracker - 追踪 recall 命中的 entity，递增 queryHits30d
 *
 * 设计参考：theory-algorithm-design.md §4.4
 * P2 核心功能：在 memory_recall 命中时递增 entity.queryHits30d，
 * 使 hotness 评分生效，topic tree 开始创建。
 */

import type { InMemoryGraphRepository } from "./repository.js";
import type { MemoryScope } from "../domain/types.js";
import type { RecallHit } from "../domain/types.js";

export interface QueryHitsTrackerOptions {
  graphRepo: InMemoryGraphRepository;
}

export class QueryHitsTracker {
  private readonly graphRepo: InMemoryGraphRepository;

  constructor(options: QueryHitsTrackerOptions) {
    this.graphRepo = options.graphRepo;
  }

  /**
   * 从 recall hits 中提取 entityIds，递增对应 entity 的 queryHits30d。
   *
   * @param hits - recall 返回的命中记录
   * @param scope - 当前查询的 scope
   */
  async trackRecallHits(hits: RecallHit[], scope: MemoryScope): Promise<void> {
    if (hits.length === 0) {
      return;
    }

    // 收集所有被命中的 entityIds
    const entityIds = new Set<string>();
    for (const hit of hits) {
      const record = hit.record;
      // 从 metadata.entityIds 提取（如果存在）
      if ("metadata" in record && record.metadata && typeof record.metadata === "object") {
        const ids = (record.metadata as { entityIds?: string[] }).entityIds;
        if (Array.isArray(ids)) {
          for (const id of ids) {
            if (typeof id === "string") {
              entityIds.add(id);
            }
          }
        }
      }
    }

    if (entityIds.size === 0) {
      return;
    }

    // 逐个递增 queryHits30d
    const now = Date.now();
    for (const entityId of entityIds) {
      const entity = await this.graphRepo.getEntity(entityId);
      if (!entity) {
        continue;
      }

      // 递增 queryHits30d：注意 repository.upsertEntities 会累加，
      // 所以这里只传 +1 的增量，不是设置绝对值
      await this.graphRepo.upsertEntities([{
        ...entity,
        queryHits30d: 1, // 增量值，repository 会累加到现有值
        hotness: entity.hotness, // hotness 会在下次 tree routing 时重新计算
        updatedAt: now,
      }]);
    }
  }
}
