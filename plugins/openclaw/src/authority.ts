import {
  AuthorityScopeError,
  resolveAuthorityScope,
  type AuthorityScope,
  type ClientAuthorityScopeRequest,
} from "../../../packages/core/src/domain/authority-scope.js";
import type { MemoryScope } from "../../../core/types.js";

const CLIENT_FIELDS = [
  "appId",
  "projectId",
  "agentId",
  "namespace",
  "visibility",
] as const satisfies readonly (keyof ClientAuthorityScopeRequest)[];
const IDENTITY_FIELDS = new Set(["tenantId", "userId"]);
const FIELD_ALIASES: Readonly<Record<string, keyof ClientAuthorityScopeRequest>> = {
  appId: "appId",
  projectId: "projectId",
  projectPath: "projectId",
  workspacePath: "projectId",
  agentId: "agentId",
  agentName: "agentId",
  namespace: "namespace",
  visibility: "visibility",
};

function clientRequestFromDefault(scope: MemoryScope): ClientAuthorityScopeRequest {
  return {
    appId: scope.appId,
    projectId: scope.projectId,
    agentId: scope.agentId,
    namespace: scope.namespace,
    visibility: scope.visibility ?? "private",
  };
}

/** Validate, deep-copy and freeze host authority before any closure captures it. */
export function snapshotOpenClawAuthority(authority: AuthorityScope): AuthorityScope {
  const allow = authority?.allow;
  const request: ClientAuthorityScopeRequest = {
    appId: allow?.appIds?.[0] as string,
    projectId: allow?.projectIds?.[0] as string,
    agentId: allow?.agentIds?.[0] as string,
    namespace: allow?.namespaces?.[0] as string,
    visibility: allow?.visibilities?.[0] as MemoryScope["visibility"] ?? "private",
  };
  // Core resolver validates identity plus every allowlist entry, including
  // canonical ambiguity/path-confusion checks, before we snapshot the arrays.
  resolveAuthorityScope(authority, request);
  return Object.freeze({
    tenantId: authority.tenantId,
    userId: authority.userId,
    allow: Object.freeze({
      appIds: Object.freeze([...authority.allow.appIds]),
      projectIds: Object.freeze([...authority.allow.projectIds]),
      agentIds: Object.freeze([...authority.allow.agentIds]),
      namespaces: Object.freeze([...authority.allow.namespaces]),
      visibilities: Object.freeze([...authority.allow.visibilities]),
    }),
  });
}

/** Exact local operator authority has one unambiguous runtime default. */
export function defaultScopeFromExactOpenClawAuthority(
  authority: AuthorityScope,
): MemoryScope {
  const snapshot = snapshotOpenClawAuthority(authority);
  const lists = Object.values(snapshot.allow);
  if (lists.some((values) => values.length !== 1)) {
    throw new AuthorityScopeError(
      "AUTHORITY_ALLOWLIST_AMBIGUOUS",
      "OpenClaw canonical plugin config requires exactly one default per authority allowlist",
      "authority",
    );
  }
  return Object.freeze({
    tenantId: snapshot.tenantId,
    userId: snapshot.userId,
    appId: snapshot.allow.appIds[0]!,
    projectId: snapshot.allow.projectIds[0]!,
    agentId: snapshot.allow.agentIds[0]!,
    namespace: snapshot.allow.namespaces[0]!,
    visibility: snapshot.allow.visibilities[0]!,
  });
}

/** Build the narrowest OpenClaw authority from the runtime/server default scope. */
export function createExactOpenClawAuthority(scope: MemoryScope): AuthorityScope {
  return Object.freeze({
    tenantId: scope.tenantId,
    userId: scope.userId,
    allow: Object.freeze({
      appIds: Object.freeze([scope.appId]),
      projectIds: Object.freeze([scope.projectId]),
      agentIds: Object.freeze([scope.agentId]),
      namespaces: Object.freeze([scope.namespace]),
      visibilities: Object.freeze([scope.visibility ?? "private"]),
    }),
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dataProperty(record: Record<string, unknown>, field: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, field);
  if (!descriptor?.enumerable || !("value" in descriptor)) {
    throw new AuthorityScopeError(
      "CLIENT_SCOPE_INVALID",
      "OpenClaw scope claims must use enumerable data properties",
      field,
    );
  }
  return descriptor.value;
}

function addClaim(
  claims: Partial<Record<keyof ClientAuthorityScopeRequest, unknown>>,
  field: string,
  value: unknown,
): void {
  if (IDENTITY_FIELDS.has(field)) {
    throw new AuthorityScopeError(
      "CLIENT_FIELD_FORBIDDEN",
      `OpenClaw client field ${field} is server-owned`,
      field,
    );
  }
  const canonical = FIELD_ALIASES[field];
  if (!canonical) return;
  if (
    Object.prototype.hasOwnProperty.call(claims, canonical) &&
    claims[canonical] !== value
  ) {
    throw new AuthorityScopeError(
      "CLIENT_VALUE_AMBIGUOUS",
      `OpenClaw client field ${canonical} has conflicting values`,
      canonical,
    );
  }
  claims[canonical] = value;
}

/**
 * Parse only the root request and its explicit root `scope` envelope. Business
 * payloads such as messages/filter/metadata are deliberately opaque.
 */
function collectNarrowClaims(
  value: unknown,
): Partial<Record<keyof ClientAuthorityScopeRequest, unknown>> {
  if (!isPlainRecord(value)) {
    throw new AuthorityScopeError(
      "CLIENT_SCOPE_INVALID",
      "OpenClaw request must be a plain object",
      "scope",
    );
  }
  const claims: Partial<Record<keyof ClientAuthorityScopeRequest, unknown>> = {};
  for (const field of [...IDENTITY_FIELDS, ...Object.keys(FIELD_ALIASES)]) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      addClaim(claims, field, dataProperty(value, field));
    }
  }
  if (!Object.prototype.hasOwnProperty.call(value, "scope")) return claims;

  const envelope = dataProperty(value, "scope");
  if (!isPlainRecord(envelope)) {
    throw new AuthorityScopeError(
      "CLIENT_SCOPE_INVALID",
      "OpenClaw scope envelope must be a plain object",
      "scope",
    );
  }
  if (Reflect.ownKeys(envelope).some((field) => typeof field !== "string")) {
    throw new AuthorityScopeError(
      "CLIENT_FIELD_FORBIDDEN",
      "OpenClaw scope envelope contains a non-string field",
      "scope",
    );
  }
  for (const field of Object.keys(envelope)) {
    if (!IDENTITY_FIELDS.has(field) && !FIELD_ALIASES[field]) {
      throw new AuthorityScopeError(
        "CLIENT_FIELD_FORBIDDEN",
        `OpenClaw scope envelope field ${field} is not requestable`,
        field,
      );
    }
    addClaim(claims, field, dataProperty(envelope, field));
  }
  return claims;
}

/**
 * Resolve untrusted tool/event claims against a server authority. tenant/user
 * are rejected at the explicit claim boundary; business payloads stay opaque.
 */
export function resolveOpenClawAuthorityScope(
  authority: AuthorityScope,
  defaultScope: MemoryScope,
  untrusted?: unknown,
): MemoryScope {
  const defaultRequest = clientRequestFromDefault(defaultScope);
  const serverDefault = resolveAuthorityScope(authority, defaultRequest);
  if (serverDefault.tenantId !== defaultScope.tenantId ||
      serverDefault.userId !== defaultScope.userId) {
    throw new AuthorityScopeError(
      "AUTHORITY_FIELD_INVALID",
      "OpenClaw authority identity does not match runtime default scope",
      serverDefault.tenantId !== defaultScope.tenantId ? "tenantId" : "userId",
    );
  }
  if (untrusted === undefined) return Object.freeze({ ...serverDefault });

  const claims = collectNarrowClaims(untrusted);
  const requested: Record<string, unknown> = { ...defaultRequest };
  for (const field of CLIENT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(claims, field)) requested[field] = claims[field];
  }
  return Object.freeze({ ...resolveAuthorityScope(authority, requested) });
}
