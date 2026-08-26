import {
  resolveAuthorityScope,
  type AuthorityScope,
} from "../../core/src/domain/authority-scope.js";
import type { MemoryScope } from "../../core/src/domain/types.js";

const CLIENT_FIELDS = ["appId", "projectId", "agentId", "namespace", "visibility"] as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Build the narrowest server authority when no configurable allowlist exists. */
export function createExactMcpAuthority(scope: MemoryScope): AuthorityScope {
  return Object.freeze({
    tenantId: scope.tenantId,
    userId: scope.userId,
    ...(scope.workspaceId === undefined ? {} : { workspaceId: scope.workspaceId }),
    ...(scope.sessionId === undefined ? {} : { sessionId: scope.sessionId }),
    allow: Object.freeze({
      appIds: Object.freeze([scope.appId]),
      projectIds: Object.freeze([scope.projectId]),
      agentIds: Object.freeze([scope.agentId]),
      namespaces: Object.freeze([scope.namespace]),
      visibilities: Object.freeze([scope.visibility ?? "private"]),
    }),
  });
}

/** Resolve client-requestable fields; tenant/user and unknown fields stay forbidden. */
export function resolveMcpAuthorityScope(
  authority: AuthorityScope,
  clientScope: unknown,
): MemoryScope {
  const requested = { ...asRecord(clientScope) };
  // Identity is authenticated by the server. Client copies are ignored, never merged.
  delete requested.tenantId;
  delete requested.userId;
  for (const field of CLIENT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(requested, field)) {
      continue;
    }
    const allowlist = authority.allow[`${field === "visibility" ? "visibilities" : `${field}s`}` as keyof AuthorityScope["allow"]];
    if (allowlist.length === 1) {
      requested[field] = allowlist[0];
    }
  }
  return resolveAuthorityScope(authority, requested);
}
