/**
 * profile-layer.ts — profile 分层推断与召回合并（D-13，§3.3）
 *
 * 职责：
 * 1. inferProfileLayer：从文本+scope 推断 profile 属于哪一层（project/app/global）
 * 2. mergeProfileByLayer：召回时按层级合并同 profileDimension 的 profile，优先级 project > app > global
 *
 * 设计依据：
 * - docs/04-design/04.2-detail/memory-system-unified-design.md §3.3
 * - D-13: profile 三层 global/app/project，召回优先级 project > app > global
 *
 * 分层规则（由高到低）：
 * - project: 文本绑定明确 projectId/repo/任务域，或用户说"这个项目里"
 * - app: 文本绑定 appId/agent/工具，但不绑定具体项目
 * - global: 跨项目长期偏好，或来自全局规则文件
 *
 * 召回合并规则：
 * - 同 profileDimension，更高层覆盖低层（project 覆盖 app/global，app 覆盖 global）
 * - 被覆盖的旧记忆保留为 evidence，标记 overriddenBy 层级
 * - 不同 profileDimension 之间互不影响，全部保留
 */

import type { MemoryRecord, MemoryScope, ProfileLayer } from "./types.js";

/**
 * 项目绑定模式：命中表示 profile 绑定到具体项目（→ project layer）
 */
const PROJECT_BINDING_PATTERNS: readonly RegExp[] = [
  /这个项目|本项目|当前项目|这个仓库|本仓库|该项目/,
  /\bthis project\b|\bcurrent project\b|\bthis repo\b/i,
  /在.*(项目|仓库)(里|中)/,
  /\bin (this|the) project\b/i,
];

/**
 * 应用绑定模式：命中表示 profile 绑定到特定应用/工具（→ app layer）
 */
const APP_BINDING_PATTERNS: readonly RegExp[] = [
  /在\s*(Codex|OpenClaw|Claude|Cursor|VS Code)\s*(里|中)/,
  /\bin (Codex|OpenClaw|Claude|Cursor|VS Code)\b/i,
  /这个\s*app|这个\s*工具|这个\s*agent/,
  /\bthis app\b|\bthis tool\b|\bthis agent\b/i,
];

/**
 * 全局信号词：命中表示跨项目长期偏好（→ global layer）
 */
const GLOBAL_SIGNAL_PATTERNS: readonly RegExp[] = [
  /总是|永远|一直|所有项目|任何项目|全局/,
  /\balways\b|\bfor all projects\b|\bglobally\b/i,
];

/**
 * 从文本和 scope 推断 profileLayer（§3.3）。
 *
 * 推断顺序（由高到低，优先级调整为显式优先）：
 * 1. 文本命中 PROJECT_BINDING_PATTERNS → project（显式项目绑定最强）
 * 2. 文本命中 APP_BINDING_PATTERNS → app（显式应用绑定次之）
 * 3. 文本命中 GLOBAL_SIGNAL_PATTERNS → global（显式全局信号）
 * 4. scope.projectId 非空且非 default → project（隐式项目绑定，优先级低于显式信号）
 * 5. scope.appId 非空 → app（隐式应用绑定）
 * 6. 兜底 → global（默认最保守）
 *
 * 设计原理：显式文本信号优先级高于隐式 scope 推断，避免用户明确表达"总是"/"全局"时
 * 仍被 scope.projectId 隐式绑定为 project，导致全局偏好失效。
 *
 * @param text 候选文本
 * @param scope 记忆 scope（用于隐式推断）
 * @returns profileLayer
 */
export function inferProfileLayer(
  text: string,
  scope: MemoryScope,
): ProfileLayer {
  // 1. 显式项目绑定（最强信号）
  if (PROJECT_BINDING_PATTERNS.some((p) => p.test(text))) {
    return "project";
  }

  // 2. 显式应用绑定
  if (APP_BINDING_PATTERNS.some((p) => p.test(text))) {
    return "app";
  }

  // 3. 显式全局信号
  if (GLOBAL_SIGNAL_PATTERNS.some((p) => p.test(text))) {
    return "global";
  }

  // 4. 隐式项目绑定：scope.projectId 非空且非占位符
  if (
    scope.projectId &&
    scope.projectId.trim().length > 0 &&
    scope.projectId !== "default" &&
    scope.projectId !== "unknown"
  ) {
    return "project";
  }

  // 5. 隐式应用绑定：scope.appId 非空
  if (scope.appId && scope.appId.trim().length > 0) {
    return "app";
  }

  // 6. 兜底默认 global（最保守，避免项目偏好污染）
  return "global";
}

/**
 * profileLayer 优先级映射（数值越大优先级越高）
 */
const LAYER_PRIORITY: Readonly<Record<ProfileLayer, number>> = {
  global: 0,
  app: 1,
  project: 2,
};

/**
 * 按层级合并 profile 记忆（召回时使用）。
 *
 * 合并规则：
 * - 同 profileDimension，保留优先级最高的层级（project > app > global）
 * - 被覆盖的低层记忆不丢弃，保留在 overridden 数组中作为 evidence
 * - 不同 profileDimension 之间互不影响，全部保留
 * - 无 profileDimension 或 profileLayer 的记忆保留在 unclassified
 *
 * @param profiles 所有 semanticType=profile 的记忆
 * @returns 合并结果 { active: 生效的高层记忆, overridden: 被覆盖的低层记忆, unclassified: 无法分层的记忆 }
 */
export function mergeProfileByLayer(profiles: MemoryRecord[]): {
  active: MemoryRecord[];
  overridden: Array<MemoryRecord & { overriddenBy: ProfileLayer }>;
  unclassified: MemoryRecord[];
} {
  const active: MemoryRecord[] = [];
  const overridden: Array<MemoryRecord & { overriddenBy: ProfileLayer }> = [];
  const unclassified: MemoryRecord[] = [];

  // 按 profileDimension 分组
  const byDimension = new Map<string, MemoryRecord[]>();

  for (const record of profiles) {
    // 无 profileDimension 或 profileLayer → unclassified
    if (!record.profileDimension || !record.profileLayer) {
      unclassified.push(record);
      continue;
    }

    const dimension = record.profileDimension;
    if (!byDimension.has(dimension)) {
      byDimension.set(dimension, []);
    }
    byDimension.get(dimension)!.push(record);
  }

  // 每个 dimension 内按 layer 优先级排序，取最高层的为 active，其余为 overridden
  for (const [dimension, records] of byDimension.entries()) {
    // 按优先级降序排序（project > app > global）
    const sorted = [...records].sort((a, b) => {
      const priorityA = LAYER_PRIORITY[a.profileLayer!];
      const priorityB = LAYER_PRIORITY[b.profileLayer!];
      if (priorityA !== priorityB) {
        return priorityB - priorityA; // 降序
      }
      // 优先级相同时，按创建时间降序（最新的优先）
      return b.createdAt - a.createdAt;
    });

    // 第一条（优先级最高）为 active
    const [winner, ...losers] = sorted;
    active.push(winner);

    // 其余标记为 overridden，记录被哪一层覆盖
    for (const loser of losers) {
      overridden.push({
        ...loser,
        overriddenBy: winner.profileLayer!,
      });
    }
  }

  return { active, overridden, unclassified };
}

/**
 * 判断一条记忆是否是 profile 类型
 */
export function isProfileMemory(record: MemoryRecord): boolean {
  return record.semanticType === "profile";
}

/**
 * 为 profile 记忆自动补充 profileLayer（如果缺失）
 *
 * @param record profile 记忆
 * @returns 补充 profileLayer 后的记忆（不可变，返回新对象）
 */
export function enrichProfileLayer(record: MemoryRecord): MemoryRecord {
  if (!isProfileMemory(record)) {
    return record;
  }

  if (record.profileLayer) {
    return record;
  }

  const inferredLayer = inferProfileLayer(record.text, record.scope);
  return {
    ...record,
    profileLayer: inferredLayer,
  };
}
