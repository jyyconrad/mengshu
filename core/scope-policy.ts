/**
 * scope 复用策略层（单 appId）。
 *
 * 本文件做什么：在 scope 隔离边界之上，定义"哪些记忆能在当前请求 scope 下被复用"
 * 的策略。核心是 5 问题语义类型（profile/rules/experience/task_context/resource）
 * 各自的复用层级，以及多级 scope key（workspace/project/session）。
 *
 * 核心流程：
 * 1. 多级 key：workspace key（profile/rules 复用边界）⊇ project key ⊇ session key。
 * 2. matchesReuseScope：按 semanticType 查策略，判断 recordScope 能否被 requestScope 复用。
 * 3. applyScopeReusePolicy / applyVisibilityFilter：批量过滤，返回 reusable/visible 与
 *    带 reason 的 filtered 列表。
 *
 * 关键边界（v0.1 单 appId）：
 * - 复用要求 appId 相同，不做跨 appId（跨 appId 是 v0.2）。
 * - workspace 级复用要求 tenant/app/user/workspace 相同，可跨 project。
 * - project 级隔离要求 tenant/app/user/workspace/project 全部相同。
 * - 所有函数不修改入参，返回新对象/新数组。
 */

import type {
  MemoryRecord,
  MemoryScope,
  MemorySemanticType,
} from "./types.js";

/** 复用层级：workspace（跨 project 同工作空间）或 project（同项目隔离）。 */
export type ReuseLevel = "workspace" | "project";

/** 每个语义类型的复用层级映射。 */
export type SlotReusePolicy = Record<MemorySemanticType, ReuseLevel>;

/**
 * v0.1 默认复用策略：
 * - profile（我为谁工作）：workspace 级复用，跨 project 共享画像。
 * - rules（什么不能做）：workspace 级复用，跨 project 共享规范。
 * - experience（之前怎么做）：workspace 级复用，跨 project 沉淀经验。
 * - task_context（我在做什么）：project 级隔离，任务上下文不跨项目串。
 * - resource（有什么资源）：project 级隔离，资源绑定项目。
 */
export const DEFAULT_SLOT_REUSE_POLICY: SlotReusePolicy = {
  profile: "workspace",
  rules: "workspace",
  experience: "workspace",
  task_context: "project",
  resource: "project",
};

const DEFAULT_DIMENSION = "default";

function dimension(value: string | undefined | null): string {
  if (typeof value !== "string") {
    return DEFAULT_DIMENSION;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_DIMENSION;
}

/**
 * project 级 key：tenantId:appId:userId:workspaceId:projectId:agentId:namespace。
 *
 * 关键修正（v0.1）：在 scopeToKey 字段顺序基础上显式插入 workspaceId 维度。
 * 底层 scopeToKey（core/scope.ts）不含 workspaceId，会导致跨 workspace 同 projectId
 * 的记忆碰撞为同一 project key（串库/越权复用）。本函数独立实现，包含 workspaceId，
 * 作为 task_context/resource 的隔离边界，且不修改底层 scopeToKey 的写入隔离行为。
 */
export function scopeToProjectKey(scope: MemoryScope): string {
  return [
    dimension(scope.tenantId),
    dimension(scope.appId),
    dimension(scope.userId),
    dimension(scope.workspaceId),
    dimension(scope.projectId),
    dimension(scope.agentId),
    dimension(scope.namespace),
  ]
    .map(encodeURIComponent)
    .join(":");
}

/**
 * workspace 级 key：tenantId:appId:userId:workspaceId:namespace。
 * 不含 projectId/agentId/sessionId，是 profile/rules/experience 的复用边界。
 */
export function scopeToWorkspaceKey(scope: MemoryScope): string {
  return [
    dimension(scope.tenantId),
    dimension(scope.appId),
    dimension(scope.userId),
    dimension(scope.workspaceId),
    dimension(scope.namespace),
  ]
    .map(encodeURIComponent)
    .join(":");
}

/**
 * session 级 key：在 project key 基础上追加 sessionId，最细粒度。
 */
export function scopeToSessionKey(scope: MemoryScope): string {
  return `${scopeToProjectKey(scope)}:${encodeURIComponent(dimension(scope.sessionId))}`;
}

/**
 * 判断 recordScope 的记忆能否在 requestScope 下按 semanticType 复用（单 appId）。
 *
 * - workspace 级：workspace key 相同即可复用（隐含 tenant/app/user/workspace 相同）。
 * - project 级：project key 相同才可复用（隐含再加 projectId/agentId 相同）。
 *
 * 单 appId 边界由 key 中的 appId 字段天然保证：appId 不同则 key 不同，返回 false。
 */
export function matchesReuseScope(
  recordScope: MemoryScope,
  requestScope: MemoryScope,
  semanticType: MemorySemanticType,
  policy: SlotReusePolicy = DEFAULT_SLOT_REUSE_POLICY,
): boolean {
  const level = policy[semanticType] ?? "project";
  if (level === "workspace") {
    return scopeToWorkspaceKey(recordScope) === scopeToWorkspaceKey(requestScope);
  }
  return scopeToProjectKey(recordScope) === scopeToProjectKey(requestScope);
}

/** 复用过滤结果。filtered 每项带 reason，便于审计与排查。 */
export interface ScopeReuseResult {
  reusable: MemoryRecord[];
  filtered: Array<{ record: MemoryRecord; reason: "scope_mismatch" }>;
}

/**
 * 批量按复用策略过滤记忆。无 semanticType 的记忆按 project 级隔离处理（最保守）。
 * 不修改入参数组。
 */
export function applyScopeReusePolicy(
  records: readonly MemoryRecord[],
  requestScope: MemoryScope,
  policy: SlotReusePolicy = DEFAULT_SLOT_REUSE_POLICY,
): ScopeReuseResult {
  const reusable: MemoryRecord[] = [];
  const filtered: Array<{ record: MemoryRecord; reason: "scope_mismatch" }> = [];

  for (const record of records) {
    const semanticType = record.semanticType;
    const ok = semanticType
      ? matchesReuseScope(record.scope, requestScope, semanticType, policy)
      : scopeToProjectKey(record.scope) === scopeToProjectKey(requestScope);
    if (ok) {
      reusable.push(record);
    } else {
      filtered.push({ record, reason: "scope_mismatch" });
    }
  }

  return { reusable, filtered };
}

/** 可见性过滤结果。filtered 带 reason。 */
export interface VisibilityFilterResult {
  visible: MemoryRecord[];
  filtered: Array<{ record: MemoryRecord; reason: "visibility_private" | "visibility_workspace" }>;
}

/**
 * 按记忆 visibility 过滤（默认 private）：
 * - private：仅 userId 相同可见。
 * - workspace：workspaceId 相同可见。
 * - team/public：全部可见（v0.1 team 暂等同 public，后续细化）。
 *
 * 不修改入参数组。
 */
export function applyVisibilityFilter(
  records: readonly MemoryRecord[],
  requestScope: MemoryScope,
): VisibilityFilterResult {
  const visible: MemoryRecord[] = [];
  const filtered: VisibilityFilterResult["filtered"] = [];

  for (const record of records) {
    const visibility = record.scope.visibility ?? "private";
    if (visibility === "public" || visibility === "team") {
      visible.push(record);
      continue;
    }
    if (visibility === "workspace") {
      if (dimension(record.scope.workspaceId) === dimension(requestScope.workspaceId)) {
        visible.push(record);
      } else {
        filtered.push({ record, reason: "visibility_workspace" });
      }
      continue;
    }
    // private
    if (record.scope.userId === requestScope.userId) {
      visible.push(record);
    } else {
      filtered.push({ record, reason: "visibility_private" });
    }
  }

  return { visible, filtered };
}
