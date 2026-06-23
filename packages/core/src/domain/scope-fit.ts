/**
 * scope 契合度（scopeFit）软排序信号。
 *
 * 设计理念（用户明确要求）：
 * scope 只作为溯源 + 排序信号，不作为召回拦截过滤条件。记忆可完全跨 scope 检索
 * （含 tenantId/appId，所有维度都跨域）。同 scope 的记忆排序靠前，但其它 scope
 * 的记忆不被拦截，仍可召回。
 *
 * computeScopeFit 计算"查询 scope"与"记忆 scope"的相对契合度（[0,1]）：
 * - 完全匹配（tenant+app+user+project+agent 全同）→ 1.0
 * - 逐级匹配递减：从最宽（tenant）到最窄（agent）逐层比对，连续匹配越深契合度越高
 * - 完全不同 → 0.2 左右（中性偏低，但不为 0，保证跨域仍可召回）
 *
 * 采用"从宽到窄的连续匹配链"语义：一旦在某一层（如 app）背离，更窄维度（user/
 * project/agent）即便字面相同也不再代表同一归属，链在此断裂。这与 scope 的嵌套
 * 隔离含义一致（不同 app 下的 project 不是同一个 project）。
 *
 * 纯函数：同入同出、无副作用、无 LLM 调用（遵循项目"评分函数必须纯函数"铁律）。
 */

import type { MemoryScope } from "./types.js";

/**
 * 完全不同 scope 的契合度地板分。
 *
 * 不为 0 是刻意设计：scope 不拦截召回，跨域记忆仍可被检索，只是排序靠后。
 */
export const SCOPE_FIT_FLOOR = 0.2;

/**
 * 从宽到窄的 scope 维度链与各层匹配增益。
 *
 * 各层增益之和 = 1 - SCOPE_FIT_FLOOR = 0.8，叠加地板分后全匹配恰为 1.0。
 * project 增益最高（0.25）：项目级是最常见、最有意义的归属边界；
 * agent/user/app 中等；tenant 最低（最宽，区分度最弱）。
 */
const SCOPE_DIMENSION_GAINS: ReadonlyArray<{ key: keyof MemoryScope; gain: number }> = [
  { key: "tenantId", gain: 0.1 },
  { key: "appId", gain: 0.15 },
  { key: "userId", gain: 0.15 },
  { key: "projectId", gain: 0.25 },
  { key: "agentId", gain: 0.15 },
];

/**
 * 计算查询 scope 与记忆 scope 的契合度（[0,1]）。
 *
 * @param queryScope 召回请求的 scope（"我现在在哪个 scope 查"）
 * @param recordScope 候选记忆的 scope（"这条记忆属于哪个 scope"）
 * @returns 契合度 ∈ [SCOPE_FIT_FLOOR, 1.0]
 */
export function computeScopeFit(
  queryScope: MemoryScope,
  recordScope: MemoryScope,
): number {
  let fit = SCOPE_FIT_FLOOR;

  // 从最宽维度逐层向窄比对，遇到第一个不匹配即停止累加（链断裂）。
  for (const { key, gain } of SCOPE_DIMENSION_GAINS) {
    if (queryScope[key] !== recordScope[key]) {
      break;
    }
    fit += gain;
  }

  // 防御性 clamp（理论上不会越界，权重之和已对齐）。
  if (fit < 0) return 0;
  if (fit > 1) return 1;
  return fit;
}
