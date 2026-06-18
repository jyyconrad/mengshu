/**
 * OpenClaw 上下文到 MemoryScope 的适配。
 *
 * OpenClaw 事件和工具 metadata 字段并不稳定完整，这里统一做 fallback：
 * app 固定为 `openclaw`，namespace 来自表名，其余维度缺失时交给 core scope 默认值。
 */

import type { TableName } from "../../db/types.js";
import { normalizeScope } from "../../core/scope.js";
import type { MemoryScope } from "../../core/types.js";

export interface OpenClawScopeInput extends Record<string, unknown> {
  userId?: unknown;
  projectPath?: unknown;
  workspacePath?: unknown;
  agentName?: unknown;
  agentId?: unknown;
  tableName?: unknown;
  sessionId?: unknown;
  workspaceId?: unknown;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function buildOpenClawScope(input: OpenClawScopeInput = {}): MemoryScope {
  return normalizeScope({
    tenantId: "local",
    appId: "openclaw",
    userId: stringValue(input.userId),
    projectId: stringValue(input.projectPath) ?? stringValue(input.workspacePath),
    agentId: stringValue(input.agentName) ?? stringValue(input.agentId),
    namespace: stringValue(input.tableName) ?? "memories",
    sessionId: stringValue(input.sessionId),
    workspaceId: stringValue(input.workspaceId),
  });
}

export function metadataToOpenClawScope(
  metadata: Record<string, unknown> = {},
  tableName?: TableName,
): MemoryScope {
  return buildOpenClawScope({
    ...metadata,
    tableName: tableName ?? metadata.tableName,
  });
}
