import {
  resolveAuthorityScope,
  type AuthorityScope,
} from "../../core/src/domain/authority-scope.js";
import type { MemoryScope } from "../../core/src/domain/types.js";

const CLIENT_FIELDS = ["appId", "projectId", "agentId", "namespace", "visibility"] as const;

export type McpProjectWorkspaceBindings = Readonly<Record<string, string>>;

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
  projectWorkspaceByProjectId?: McpProjectWorkspaceBindings,
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
  const resolved = resolveAuthorityScope(authority, requested);
  if (resolved.workspaceId !== undefined || projectWorkspaceByProjectId === undefined) {
    return resolved;
  }
  if (!Object.prototype.hasOwnProperty.call(projectWorkspaceByProjectId, resolved.projectId)) {
    return resolved;
  }
  return resolveAuthorityScope(
    { ...authority, workspaceId: projectWorkspaceByProjectId[resolved.projectId] },
    requested,
  );
}

/** Snapshot and validate registry bindings against the authority allowlist at startup. */
export function snapshotMcpProjectWorkspaceBindings(
  authority: AuthorityScope,
  bindings?: McpProjectWorkspaceBindings,
): McpProjectWorkspaceBindings | undefined {
  if (authority.workspaceId !== undefined || bindings === undefined) return undefined;

  const snapshot = Object.create(null) as Record<string, string>;
  for (const projectId of authority.allow.projectIds) {
    if (!Object.prototype.hasOwnProperty.call(bindings, projectId)) continue;
    const resolved = resolveAuthorityScope(
      { ...authority, workspaceId: bindings[projectId] },
      {
        appId: authority.allow.appIds[0],
        projectId,
        agentId: authority.allow.agentIds[0],
        namespace: authority.allow.namespaces[0],
        visibility: authority.allow.visibilities[0],
      },
    );
    Object.defineProperty(snapshot, projectId, {
      value: resolved.workspaceId!,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(snapshot);
}
