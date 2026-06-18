/**
 * Leaf 分级路由（D-03 实现）。
 *
 * 本文件做什么：
 * - 实现 D-03 决策：valueScore >= 0.55 准入 leaf
 * - 0.55-0.70 仅进入 source tree
 * - >= 0.70 才进入 topic/global tree
 *
 * 职责边界：
 * - 路由决策纯确定性，不调用 LLM
 * - 基于 valueScore 和 importance 阈值判断
 * - 返回应路由到的 treeType 列表
 */

import type { MemoryTreeType } from "./types.js";

/**
 * D-03 阈值定义（与设计文档 §0.3 / §7.2 / §7.3 一致）
 */
export const LEAF_ADMISSION_THRESHOLD = 0.55;  // 最低准入阈值
export const TOPIC_TREE_THRESHOLD = 0.70;      // topic/global tree 门槛
export const GLOBAL_TREE_IMPORTANCE = 0.85;    // global tree 的 importance 门槛

/**
 * Leaf 路由决策结果
 */
export interface LeafRoutingDecision {
  /** 是否准入（valueScore >= 0.55） */
  admitted: boolean;
  /** 应路由到的树类型列表 */
  treeTypes: MemoryTreeType[];
  /** 决策理由（用于 audit / explain） */
  reason: string;
}

/**
 * Leaf 路由输入
 */
export interface LeafRoutingInput {
  /** valueScore（准入决策 8 维加权，§4.1） */
  valueScore: number;
  /** importance（召回排序 + 树路由，§4.2） */
  importance: number;
  /** semanticType（某些类型不进 topic tree） */
  semanticType?: string;
  /** 是否有 topic label（无 topic 不路由到 topic tree） */
  hasTopicLabel: boolean;
  /** scope visibility（global 需要明确标记） */
  scopeVisibility?: "session" | "project" | "workspace" | "app" | "user" | "global";
  /** 是否用户显式保存到 global */
  explicitGlobal?: boolean;
  /** 是否为规则类型且 workspace/team 可见 */
  isWorkspaceRule?: boolean;
  /** riskFlags（含 sensitive 的不进 global） */
  riskFlags?: string[];
}

/**
 * 决策 leaf 应路由到哪些树（D-03 分级路由核心逻辑）。
 *
 * 路由规则（§7.3）：
 * 1. source tree（始终写入）：
 *    - 所有 valueScore >= 0.55 的 leaf 都写入 source tree
 *
 * 2. topic tree（按条件路由）：
 *    - valueScore >= 0.70（D-03：0.55-0.70 不进 topic）
 *    - importance >= 0.55
 *    - 存在 topicLabel
 *    - semanticType != "profile"（profile 走独立分层容器）
 *
 * 3. global tree（仅高价值）：
 *    - importance >= 0.85
 *    - 或 rules 类型且 workspace/team 可见
 *    - 或用户显式保存到 global
 *    - 且不含 sensitive + session/project scope（防止隐私泄漏）
 *
 * @param input - Leaf 路由输入（包含 valueScore、importance 等）
 * @returns LeafRoutingDecision - 路由决策结果
 */
export function routeLeaf(input: LeafRoutingInput): LeafRoutingDecision {
  const treeTypes: MemoryTreeType[] = [];
  const reasons: string[] = [];

  // 第一道门槛：valueScore < 0.55 直接拒绝
  if (input.valueScore < LEAF_ADMISSION_THRESHOLD) {
    return {
      admitted: false,
      treeTypes: [],
      reason: `valueScore ${input.valueScore.toFixed(2)} < ${LEAF_ADMISSION_THRESHOLD} (admission threshold)`,
    };
  }

  // 通过准入阈值，至少进入 source tree
  treeTypes.push("source");
  reasons.push(`valueScore ${input.valueScore.toFixed(2)} >= ${LEAF_ADMISSION_THRESHOLD} → source tree`);

  // D-03 分级路由：0.55-0.70 只进 source tree
  if (input.valueScore < TOPIC_TREE_THRESHOLD) {
    return {
      admitted: true,
      treeTypes,
      reason: reasons.join("; ") + `; valueScore ${input.valueScore.toFixed(2)} < ${TOPIC_TREE_THRESHOLD} → skip topic/global`,
    };
  }

  // valueScore >= 0.70：评估是否进入 topic tree
  const canEnterTopic =
    input.hasTopicLabel &&
    input.importance >= 0.55 &&
    input.semanticType !== "profile"; // profile 走独立分层容器

  if (canEnterTopic) {
    treeTypes.push("topic");
    reasons.push(`valueScore ${input.valueScore.toFixed(2)} >= ${TOPIC_TREE_THRESHOLD}, importance ${input.importance.toFixed(2)} >= 0.55, has topic → topic tree`);
  } else {
    if (!input.hasTopicLabel) {
      reasons.push("no topic label → skip topic tree");
    } else if (input.importance < 0.55) {
      reasons.push(`importance ${input.importance.toFixed(2)} < 0.55 → skip topic tree`);
    } else if (input.semanticType === "profile") {
      reasons.push("semanticType=profile → skip topic tree (use profile layer instead)");
    }
  }

  // 评估是否进入 global tree（更严格的门槛）
  const hasSensitiveScope =
    input.riskFlags?.includes("sensitive") &&
    (input.scopeVisibility === "session" || input.scopeVisibility === "project");

  const canEnterGlobal =
    !hasSensitiveScope &&
    (input.importance >= GLOBAL_TREE_IMPORTANCE ||
     input.isWorkspaceRule ||
     input.explicitGlobal);

  if (canEnterGlobal) {
    treeTypes.push("global");
    const globalReasons: string[] = [];
    if (input.importance >= GLOBAL_TREE_IMPORTANCE) {
      globalReasons.push(`importance ${input.importance.toFixed(2)} >= ${GLOBAL_TREE_IMPORTANCE}`);
    }
    if (input.isWorkspaceRule) {
      globalReasons.push("workspace rule");
    }
    if (input.explicitGlobal) {
      globalReasons.push("explicit global save");
    }
    reasons.push(`${globalReasons.join(" or ")} → global tree`);
  } else {
    if (hasSensitiveScope) {
      reasons.push("sensitive + session/project scope → skip global tree");
    } else {
      reasons.push(`importance ${input.importance.toFixed(2)} < ${GLOBAL_TREE_IMPORTANCE}, not workspace rule, not explicit → skip global tree`);
    }
  }

  return {
    admitted: true,
    treeTypes,
    reason: reasons.join("; "),
  };
}

/**
 * 判断是否应路由到指定树类型（便捷函数）。
 */
export function shouldRouteToTree(
  input: LeafRoutingInput,
  treeType: MemoryTreeType,
): boolean {
  const decision = routeLeaf(input);
  return decision.treeTypes.includes(treeType);
}
