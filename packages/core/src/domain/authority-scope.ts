/**
 * Server-owned AuthorityScope resolution.
 *
 * tenantId/userId can only come from authenticated server authority. A client
 * must request every remaining scope dimension explicitly, and every value
 * must be an exact member of the corresponding authority allowlist.
 */

import type { MemoryScope, MemoryVisibility } from "./types.js";

export type AuthorityScopeErrorCode =
  | "AUTHORITY_FIELD_MISSING"
  | "AUTHORITY_FIELD_INVALID"
  | "AUTHORITY_ALLOWLIST_MISSING"
  | "AUTHORITY_ALLOWLIST_EMPTY"
  | "AUTHORITY_ALLOWLIST_AMBIGUOUS"
  | "CLIENT_SCOPE_INVALID"
  | "CLIENT_FIELD_FORBIDDEN"
  | "CLIENT_FIELD_MISSING"
  | "CLIENT_FIELD_INVALID"
  | "CLIENT_VALUE_NOT_ALLOWED"
  | "CLIENT_VALUE_AMBIGUOUS";

export class AuthorityScopeError extends Error {
  readonly code: AuthorityScopeErrorCode;
  readonly field?: string;

  constructor(code: AuthorityScopeErrorCode, message: string, field?: string) {
    super(message);
    this.name = "AuthorityScopeError";
    this.code = code;
    this.field = field;
  }
}

export interface AuthorityScopeAllowlist {
  appIds: readonly string[];
  projectIds: readonly string[];
  agentIds: readonly string[];
  namespaces: readonly string[];
  visibilities: readonly MemoryVisibility[];
}

export interface AuthorityScope {
  /** Authenticated tenant. Never sourced from client input. */
  tenantId: string;
  /** Authenticated user. Never sourced from client input. */
  userId: string;
  /** Optional server-owned workspace coordinate. Never client requestable. */
  workspaceId?: string;
  /** Optional server-owned session coordinate. Never client requestable. */
  sessionId?: string;
  allow: AuthorityScopeAllowlist;
}

export interface ClientAuthorityScopeRequest {
  appId: string;
  projectId: string;
  agentId: string;
  namespace: string;
  visibility: MemoryVisibility;
}

type ClientField = keyof ClientAuthorityScopeRequest;
type AllowlistField = keyof AuthorityScopeAllowlist;

const CLIENT_FIELDS = [
  "appId",
  "projectId",
  "agentId",
  "namespace",
  "visibility",
] as const satisfies readonly ClientField[];

const ALLOWLIST_BY_CLIENT_FIELD: Readonly<Record<ClientField, AllowlistField>> = {
  appId: "appIds",
  projectId: "projectIds",
  agentId: "agentIds",
  namespace: "namespaces",
  visibility: "visibilities",
};

const VALID_VISIBILITIES = new Set<MemoryVisibility>([
  "private",
  "workspace",
  "team",
  "public",
]);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const ENCODED_PATH_SEPARATOR = /%(?:25)*(?:2e|2f|5c)/i;
const SLASH_LIKE_CHARACTER = /[\u2044\u2215]/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, field);
}

function comparisonKey(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function hasValidStringShape(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    !CONTROL_CHARACTERS.test(value)
  );
}

function hasPathConfusion(value: string): boolean {
  const normalized = value.normalize("NFKC");
  if (
    normalized === "/" ||
    normalized.includes("\\") ||
    SLASH_LIKE_CHARACTER.test(normalized) ||
    normalized.includes("//") ||
    normalized.endsWith("/") ||
    ENCODED_PATH_SEPARATOR.test(normalized)
  ) {
    return true;
  }

  const segments = normalized.startsWith("/")
    ? normalized.slice(1).split("/")
    : normalized.split("/");
  return segments.some((segment) => segment.length === 0 || segment === "." || segment === "..");
}

function hasIdentifierPathConfusion(value: string): boolean {
  const normalized = value.normalize("NFKC");
  return (
    normalized.includes("/") ||
    normalized.includes("\\") ||
    SLASH_LIKE_CHARACTER.test(normalized) ||
    ENCODED_PATH_SEPARATOR.test(normalized)
  );
}

function isValidClientShape(field: ClientField, value: unknown): value is string {
  if (!hasValidStringShape(value)) {
    return false;
  }
  if (field === "projectId") {
    return !hasPathConfusion(value);
  }
  if (field !== "visibility") {
    return !hasIdentifierPathConfusion(value);
  }
  return true;
}

function isCanonicalAuthorityValue(field: ClientField, value: unknown): value is string {
  if (!isValidClientShape(field, value) || value.normalize("NFKC") !== value) {
    return false;
  }
  if (field === "visibility") {
    return VALID_VISIBILITIES.has(value as MemoryVisibility);
  }
  return true;
}

function authorityField(authority: Record<string, unknown>, field: "tenantId" | "userId"): string {
  const value = authority[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AuthorityScopeError(
      "AUTHORITY_FIELD_MISSING",
      `server authority field ${field} is required`,
      field,
    );
  }
  if (
    !hasValidStringShape(value) ||
    value.normalize("NFKC") !== value ||
    hasIdentifierPathConfusion(value)
  ) {
    throw new AuthorityScopeError(
      "AUTHORITY_FIELD_INVALID",
      `server authority field ${field} is not canonical`,
      field,
    );
  }
  return value;
}

function optionalAuthorityField(
  authority: Record<string, unknown>,
  field: "workspaceId" | "sessionId",
): string | undefined {
  const value = authority[field];
  if (value === undefined) return undefined;
  if (!hasValidStringShape(value) || value.normalize("NFKC") !== value ||
      hasIdentifierPathConfusion(value)) {
    throw new AuthorityScopeError(
      "AUTHORITY_FIELD_INVALID",
      `server authority field ${field} is not canonical`,
      field,
    );
  }
  return value;
}

function validateAllowlist(
  allow: Record<string, unknown>,
  field: ClientField,
): readonly string[] {
  const allowlistField = ALLOWLIST_BY_CLIENT_FIELD[field];
  const values = allow[allowlistField];
  if (!Array.isArray(values)) {
    throw new AuthorityScopeError(
      "AUTHORITY_ALLOWLIST_MISSING",
      `authority allowlist for ${field} is required`,
      field,
    );
  }
  if (values.length === 0) {
    throw new AuthorityScopeError(
      "AUTHORITY_ALLOWLIST_EMPTY",
      `authority allowlist for ${field} must not be empty`,
      field,
    );
  }

  const exact = new Set<string>();
  const comparisons = new Set<string>();
  for (const value of values) {
    if (!isCanonicalAuthorityValue(field, value)) {
      throw new AuthorityScopeError(
        "AUTHORITY_FIELD_INVALID",
        `authority allowlist contains an invalid ${field}`,
        field,
      );
    }
    const key = comparisonKey(value);
    if (exact.has(value) || comparisons.has(key)) {
      throw new AuthorityScopeError(
        "AUTHORITY_ALLOWLIST_AMBIGUOUS",
        `authority allowlist contains ambiguous ${field} entries`,
        field,
      );
    }
    exact.add(value);
    comparisons.add(key);
  }
  return values;
}

function validatedAuthority(authority: AuthorityScope): {
  tenantId: string;
  userId: string;
  workspaceId?: string;
  sessionId?: string;
  allowlists: Readonly<Record<ClientField, readonly string[]>>;
} {
  if (!isRecord(authority)) {
    throw new AuthorityScopeError(
      "AUTHORITY_FIELD_MISSING",
      "server authority is required",
      "authority",
    );
  }
  const tenantId = authorityField(authority, "tenantId");
  const userId = authorityField(authority, "userId");
  const workspaceId = optionalAuthorityField(authority, "workspaceId");
  const sessionId = optionalAuthorityField(authority, "sessionId");
  if (!isRecord(authority.allow)) {
    throw new AuthorityScopeError(
      "AUTHORITY_ALLOWLIST_MISSING",
      "authority allowlists are required",
      "allow",
    );
  }

  return {
    tenantId,
    userId,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(sessionId === undefined ? {} : { sessionId }),
    allowlists: {
      appId: validateAllowlist(authority.allow, "appId"),
      projectId: validateAllowlist(authority.allow, "projectId"),
      agentId: validateAllowlist(authority.allow, "agentId"),
      namespace: validateAllowlist(authority.allow, "namespace"),
      visibility: validateAllowlist(authority.allow, "visibility"),
    },
  };
}

function validatedClientRequest(
  clientScope: unknown,
  allowlists: Readonly<Record<ClientField, readonly string[]>>,
): ClientAuthorityScopeRequest {
  if (!isRecord(clientScope)) {
    throw new AuthorityScopeError(
      "CLIENT_SCOPE_INVALID",
      "client scope must be an object",
      "scope",
    );
  }

  for (const field of Object.keys(clientScope)) {
    if (!(CLIENT_FIELDS as readonly string[]).includes(field)) {
      throw new AuthorityScopeError(
        "CLIENT_FIELD_FORBIDDEN",
        `client scope field ${field} is not requestable`,
        field,
      );
    }
  }

  const result = {} as Record<ClientField, string>;
  for (const field of CLIENT_FIELDS) {
    if (!hasOwn(clientScope, field)) {
      throw new AuthorityScopeError(
        "CLIENT_FIELD_MISSING",
        `client scope field ${field} is required`,
        field,
      );
    }
    const value = clientScope[field];
    if (!isValidClientShape(field, value)) {
      throw new AuthorityScopeError(
        "CLIENT_FIELD_INVALID",
        `client scope field ${field} is invalid`,
        field,
      );
    }

    const allowed = allowlists[field];
    if (allowed.includes(value)) {
      result[field] = value;
      continue;
    }
    if (allowed.some((candidate) => comparisonKey(candidate) === comparisonKey(value))) {
      throw new AuthorityScopeError(
        "CLIENT_VALUE_AMBIGUOUS",
        `client scope field ${field} is ambiguous`,
        field,
      );
    }
    if (field === "visibility" && !VALID_VISIBILITIES.has(value as MemoryVisibility)) {
      throw new AuthorityScopeError(
        "CLIENT_FIELD_INVALID",
        "client scope visibility is invalid",
        field,
      );
    }
    throw new AuthorityScopeError(
      "CLIENT_VALUE_NOT_ALLOWED",
      `client scope field ${field} is not allowlisted`,
      field,
    );
  }

  return result as unknown as ClientAuthorityScopeRequest;
}

/**
 * Resolve an effective MemoryScope from authenticated authority and a client
 * request. The function is deterministic and side-effect free.
 */
export function resolveAuthorityScope(
  authority: AuthorityScope,
  clientScope: unknown,
): MemoryScope {
  const trusted = validatedAuthority(authority);
  const requested = validatedClientRequest(clientScope, trusted.allowlists);
  return {
    tenantId: trusted.tenantId,
    userId: trusted.userId,
    appId: requested.appId,
    projectId: requested.projectId,
    agentId: requested.agentId,
    namespace: requested.namespace,
    visibility: requested.visibility,
    ...(trusted.workspaceId === undefined ? {} : { workspaceId: trusted.workspaceId }),
    ...(trusted.sessionId === undefined ? {} : { sessionId: trusted.sessionId }),
  };
}
