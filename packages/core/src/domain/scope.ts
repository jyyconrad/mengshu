/**
 * 记忆 scope 归一化与稳定 key 生成。
 *
 * scope 是中间件隔离多产品、多用户、多项目和多命名空间的基础边界；
 * key 使用固定字段顺序和 URL 编码，避免空值、分隔符或字段顺序导致串库。
 */

import type { MemoryScope, MemoryScopeInput } from "./types.js";

const DEFAULT_SCOPE: MemoryScope = {
  tenantId: "local",
  appId: "default",
  userId: "default",
  projectId: "default",
  agentId: "default",
  namespace: "default",
};

function normalizeDimension(value: string | null | undefined, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

export function normalizeScope(
  input: MemoryScopeInput = {},
  defaults: MemoryScope = DEFAULT_SCOPE,
): MemoryScope {
  return {
    tenantId: normalizeDimension(input.tenantId, defaults.tenantId),
    appId: normalizeDimension(input.appId, defaults.appId),
    userId: normalizeDimension(input.userId, defaults.userId),
    projectId: normalizeDimension(input.projectId, defaults.projectId),
    agentId: normalizeDimension(input.agentId, defaults.agentId),
    namespace: normalizeDimension(input.namespace, defaults.namespace),
    workspaceId:
      typeof input.workspaceId === "string" && input.workspaceId.trim().length > 0
        ? input.workspaceId
        : defaults.workspaceId,
    sessionId:
      typeof input.sessionId === "string" && input.sessionId.trim().length > 0
        ? input.sessionId
        : defaults.sessionId,
    visibility: input.visibility ?? defaults.visibility,
  };
}

export function scopeToKey(scope: MemoryScopeInput): string {
  const normalized = normalizeScope(scope);
  return [
    normalized.tenantId,
    normalized.appId,
    normalized.userId,
    normalized.projectId,
    normalized.agentId,
    normalized.namespace,
  ].map(encodeURIComponent).join(":");
}

/**
 * 写入前的 scope 一致性校验（RISK-3）。
 *
 * 校验记录 scope 与请求 scope 的核心隔离字段 tenantId/appId/userId 完全一致，
 * 并且这三个字段非空。任一不满足直接抛错，避免 adapter 把不同租户/应用/用户
 * 的记忆错写到同一隔离边界（防串库、防越权写）。
 *
 * 边界：projectId/agentId/namespace 不在此校验，由复用策略层处理；
 * v0.1 单 appId 场景下 record 与 request 通常同源，故默认自洽校验。
 */
export function validateScopeForWrite(
  recordScope: MemoryScope,
  requestScope: MemoryScope,
): void {
  const guardedFields: Array<keyof MemoryScope> = ["tenantId", "appId", "userId"];
  for (const field of guardedFields) {
    const recordValue = recordScope[field];
    if (typeof recordValue !== "string" || recordValue.trim().length === 0) {
      throw new Error(`scope 写入校验失败：字段 ${field} 不能为空`);
    }
    if (recordValue !== requestScope[field]) {
      throw new Error(
        `scope 写入校验失败：字段 ${field} 不匹配（record=${String(recordValue)} request=${String(
          requestScope[field],
        )}）`,
      );
    }
  }
}
