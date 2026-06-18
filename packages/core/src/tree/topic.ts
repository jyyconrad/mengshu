/**
 * Topic tree hotness and routing.
 *
 * 参考 OpenHuman 的确定性 hotness 思路：mention、source 多样性、recency、
 * centrality、query hits 共同决定是否为实体建立 topic tree。
 *
 * D-03 分级路由：0.55-0.70 只进 source tree，>=0.70 才进 topic tree。
 */

import type { GraphEntityRecord } from "../graph/types.js";
import type { TreeLeaf } from "./types.js";
import { appendLeafToBuffer, type SealPolicy } from "./buffer.js";
import type { TreeRepository } from "./types.js";
import { SCORING_WEIGHTS_V1, type RecencyDecayBucket } from "../scoring/scoring-weights.js";
import { shouldRouteToTree, type LeafRoutingInput } from "./leaf-routing.js";

export const TOPIC_CREATION_THRESHOLD = 6.0;
export const TOPIC_ARCHIVE_THRESHOLD = 2.0;

const HOTNESS_WEIGHTS = SCORING_WEIGHTS_V1.hotness;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 遗忘曲线（艾宾浩斯）分段线性近似（设计 §4.4）。
 *
 * 衰减系数完全由 SCORING_WEIGHTS_V1.hotness.recency_decay_buckets 驱动，
 * 不在此处内联硬编码（变更需经 ADR-001）。bucket 形如 [天数上界, 衰减系数]，
 * 必须按天数升序排列。
 *
 * - ageDays <= 第一个 bucket 上界：返回该 bucket 系数（区间内平台）。
 * - 落在相邻两个 bucket 之间：在两 bucket 系数间做线性插值。
 * - ageDays >= 最后一个 bucket 上界：返回最后一个 bucket 系数。
 */
export function recencyDecay(
  now: number,
  lastSeenAt?: number,
  buckets: readonly RecencyDecayBucket[] = HOTNESS_WEIGHTS.recency_decay_buckets,
): number {
  if (!lastSeenAt || buckets.length === 0) {
    return 0;
  }
  const ageDays = Math.max(0, (now - lastSeenAt) / MS_PER_DAY);

  const [firstBound, firstCoeff] = buckets[0];
  if (ageDays <= firstBound) {
    return firstCoeff;
  }

  for (let i = 1; i < buckets.length; i += 1) {
    const [prevBound, prevCoeff] = buckets[i - 1];
    const [bound, coeff] = buckets[i];
    if (ageDays <= bound) {
      const span = bound - prevBound;
      if (span <= 0) {
        return coeff;
      }
      const ratio = (ageDays - prevBound) / span;
      return prevCoeff + ratio * (coeff - prevCoeff);
    }
  }

  return buckets[buckets.length - 1][1];
}

/**
 * hotness 5 项求和（设计 §4.4），系数取自 SCORING_WEIGHTS_V1.hotness。
 *
 *   hotness = ln_mention_coeff   * ln(mentionCount30d + 1)   // 重复激活（边际递减）
 *           + distinct_source_coeff * distinctSourceCount    // 多来源印证
 *           + recencyDecay(now, lastSeenAt)                  // 遗忘曲线（时间衰减）
 *           + centrality_coeff   * graphCentrality           // 结构重要性
 *           + query_hits_coeff   * queryHits30d              // 主动召回 = 强激活
 */
export function computeHotness(entity: GraphEntityRecord, now: number): number {
  const mention = HOTNESS_WEIGHTS.ln_mention_coeff * Math.log(entity.mentionCount30d + 1);
  const source = HOTNESS_WEIGHTS.distinct_source_coeff * entity.distinctSourceCount;
  const recency = recencyDecay(now, entity.lastSeenAt);
  const centrality = HOTNESS_WEIGHTS.centrality_coeff * (entity.graphCentrality ?? 0);
  const queryHits = HOTNESS_WEIGHTS.query_hits_coeff * entity.queryHits30d;
  return mention + source + recency + centrality + queryHits;
}

export function shouldCreateTopicTree(entity: GraphEntityRecord, now: number): boolean {
  return computeHotness(entity, now) >= TOPIC_CREATION_THRESHOLD;
}

/**
 * 路由 leaf 到 topic tree（D-03 分级路由）。
 *
 * 新逻辑：
 * 1. 先用 shouldRouteToTree 判断 leaf 是否满足 topic tree 门槛（valueScore >= 0.70）
 * 2. 再判断 entity hotness 是否达到创建 topic tree 的阈值
 * 3. 两者都满足才实际路由
 *
 * @param repository - Tree repository
 * @param leaf - 待路由的 leaf
 * @param entities - 关联的实体列表
 * @param routingInput - Leaf 路由输入（包含 valueScore、importance 等）
 * @param now - 当前时间戳
 * @param policy - Seal 策略
 * @returns 成功路由到的 buffer 列表
 */
export async function routeLeafToTopicTree(
  repository: TreeRepository,
  leaf: TreeLeaf,
  entities: GraphEntityRecord[],
  routingInput: LeafRoutingInput,
  now: number,
  policy?: SealPolicy,
) {
  // D-03 分级路由：先判断 leaf 是否达到 topic tree 门槛
  if (!shouldRouteToTree(routingInput, "topic")) {
    return [];
  }

  const routed = [];
  for (const entity of entities) {
    if (!leaf.entityIds.includes(entity.id) || !shouldCreateTopicTree(entity, now)) {
      continue;
    }
    routed.push(await appendLeafToBuffer(repository, {
      scope: leaf.scope,
      treeType: "topic",
      treeKey: entity.id,
      leaf,
      now,
    }, policy));
  }
  return routed;
}
