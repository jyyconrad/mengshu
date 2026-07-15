import { createHash } from "node:crypto";

import type { MemoryScope } from "./types.js";

const SAFE_SCOPE_DIMENSION = /^[^\s\p{Cc}]{1,256}$/u;
const VISIBILITIES = new Set<NonNullable<MemoryScope["visibility"]>>([
  "private",
  "workspace",
  "team",
  "public",
]);

export interface CanonicalAuthorityScope {
  readonly tenantId: string;
  readonly userId: string;
  readonly appId: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly namespace: string;
  readonly visibility: NonNullable<MemoryScope["visibility"]>;
  readonly workspaceId: string;
  readonly sessionId: string;
}
export function canonicalAuthorityScope(scope: MemoryScope): CanonicalAuthorityScope {
  const core = [
    scope.tenantId,
    scope.userId,
    scope.appId,
    scope.projectId,
    scope.agentId,
    scope.namespace,
  ];
  if (core.some((value) => !SAFE_SCOPE_DIMENSION.test(value)) ||
      scope.visibility === undefined || !VISIBILITIES.has(scope.visibility) ||
      (scope.workspaceId !== undefined && !SAFE_SCOPE_DIMENSION.test(scope.workspaceId)) ||
      (scope.sessionId !== undefined && !SAFE_SCOPE_DIMENSION.test(scope.sessionId))) {
    throw new Error("Canonical authority scope is invalid");
  }
  return Object.freeze({
    tenantId: scope.tenantId,
    userId: scope.userId,
    appId: scope.appId,
    projectId: scope.projectId,
    agentId: scope.agentId,
    namespace: scope.namespace,
    visibility: scope.visibility,
    workspaceId: scope.workspaceId ?? "",
    sessionId: scope.sessionId ?? "",
  });
}

/**
 * Provider-owned tree/graph schema 的完整 9D authority 主键前缀。
 * 固定 tag 与数组顺序属于持久化合同，变更必须新增 schema/contract 版本。
 */
export function authorityScopeFingerprint(scope: MemoryScope): string {
  const canonical = canonicalAuthorityScope(scope);
  return createHash("sha256").update(JSON.stringify([
    "mengshu.authority-scope/v1",
    canonical.tenantId,
    canonical.userId,
    canonical.appId,
    canonical.projectId,
    canonical.agentId,
    canonical.namespace,
    canonical.visibility,
    canonical.workspaceId,
    canonical.sessionId,
  ])).digest("hex");
}
