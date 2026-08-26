import { describe, expect, test } from "vitest";
import {
  AuthorityScopeError,
  resolveAuthorityScope,
  type AuthorityScope,
  type AuthorityScopeErrorCode,
} from "./authority-scope.js";

const AUTHORITY: AuthorityScope = {
  tenantId: "tenant-a",
  userId: "user-a",
  allow: {
    appIds: ["mengshu", "codex"],
    projectIds: ["project-a", "/repo/project-a"],
    agentIds: ["agent-a", "agent-b"],
    namespaces: ["memories", "knowledge"],
    visibilities: ["private", "workspace"],
  },
};

const CLIENT_SCOPE = {
  appId: "mengshu",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "memories",
  visibility: "private" as const,
};

function authorityError(
  action: () => unknown,
  code: AuthorityScopeErrorCode,
  field?: string,
): AuthorityScopeError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(AuthorityScopeError);
    const scopedError = error as AuthorityScopeError;
    expect(scopedError.code).toBe(code);
    if (field) {
      expect(scopedError.field).toBe(field);
    }
    return scopedError;
  }
  throw new Error(`expected AuthorityScopeError(${code})`);
}

describe("resolveAuthorityScope", () => {
  test("uses server-owned tenant/user and an exactly allowlisted client scope", () => {
    const resolved = resolveAuthorityScope(AUTHORITY, CLIENT_SCOPE);

    expect(resolved).toEqual({
      tenantId: "tenant-a",
      userId: "user-a",
      appId: "mengshu",
      projectId: "project-a",
      agentId: "agent-a",
      namespace: "memories",
      visibility: "private",
    });
  });

  test("preserves canonical server-owned workspace/session while clients cannot submit them", () => {
    const resolved = resolveAuthorityScope({
      ...AUTHORITY,
      workspaceId: "workspace-a",
      sessionId: "session-a",
    }, CLIENT_SCOPE);

    expect(resolved).toEqual({
      tenantId: "tenant-a",
      userId: "user-a",
      appId: "mengshu",
      projectId: "project-a",
      agentId: "agent-a",
      namespace: "memories",
      visibility: "private",
      workspaceId: "workspace-a",
      sessionId: "session-a",
    });
    authorityError(
      () => resolveAuthorityScope(AUTHORITY, { ...CLIENT_SCOPE, sessionId: "session-a" }),
      "CLIENT_FIELD_FORBIDDEN",
      "sessionId",
    );
  });

  test.each(["workspaceId", "sessionId"] as const)(
    "rejects invalid server-owned optional field %s",
    (field) => {
      authorityError(
        () => resolveAuthorityScope({ ...AUTHORITY, [field]: " bad" }, CLIENT_SCOPE),
        "AUTHORITY_FIELD_INVALID",
        field,
      );
    },
  );

  test("is deterministic and does not mutate frozen authority/client inputs", () => {
    const authority = Object.freeze({
      ...AUTHORITY,
      allow: Object.freeze({
        appIds: Object.freeze([...AUTHORITY.allow.appIds]),
        projectIds: Object.freeze([...AUTHORITY.allow.projectIds]),
        agentIds: Object.freeze([...AUTHORITY.allow.agentIds]),
        namespaces: Object.freeze([...AUTHORITY.allow.namespaces]),
        visibilities: Object.freeze([...AUTHORITY.allow.visibilities]),
      }),
    });
    const client = Object.freeze({ ...CLIENT_SCOPE });

    expect(resolveAuthorityScope(authority, client)).toEqual(resolveAuthorityScope(authority, client));
  });

  test.each(["tenantId", "userId"] as const)(
    "requires server-owned authority field %s",
    (field) => {
      const invalid = { ...AUTHORITY, [field]: "" } as AuthorityScope;
      authorityError(
        () => resolveAuthorityScope(invalid, CLIENT_SCOPE),
        "AUTHORITY_FIELD_MISSING",
        field,
      );
    },
  );

  test("rejects non-canonical server-owned authority fields", () => {
    authorityError(
      () => resolveAuthorityScope({ ...AUTHORITY, tenantId: " tenant-a" }, CLIENT_SCOPE),
      "AUTHORITY_FIELD_INVALID",
      "tenantId",
    );
  });

  test.each([
    ["appIds", "appId"],
    ["projectIds", "projectId"],
    ["agentIds", "agentId"],
    ["namespaces", "namespace"],
    ["visibilities", "visibility"],
  ] as const)("requires a non-empty authority allowlist %s", (allowlist, field) => {
    const invalid = {
      ...AUTHORITY,
      allow: { ...AUTHORITY.allow, [allowlist]: [] },
    } as AuthorityScope;
    authorityError(
      () => resolveAuthorityScope(invalid, CLIENT_SCOPE),
      "AUTHORITY_ALLOWLIST_EMPTY",
      field,
    );
  });

  test("fails closed when authority allowlists are absent", () => {
    const invalid = { tenantId: "tenant-a", userId: "user-a" } as AuthorityScope;
    authorityError(
      () => resolveAuthorityScope(invalid, CLIENT_SCOPE),
      "AUTHORITY_ALLOWLIST_MISSING",
      "allow",
    );
  });

  test("fails closed when one authority allowlist is absent", () => {
    const allow = { ...AUTHORITY.allow } as Partial<AuthorityScope["allow"]>;
    delete allow.appIds;
    authorityError(
      () => resolveAuthorityScope({ ...AUTHORITY, allow } as AuthorityScope, CLIENT_SCOPE),
      "AUTHORITY_ALLOWLIST_MISSING",
      "appId",
    );
  });

  test("fails closed when the server authority itself is absent", () => {
    authorityError(
      () => resolveAuthorityScope(null as unknown as AuthorityScope, CLIENT_SCOPE),
      "AUTHORITY_FIELD_MISSING",
      "authority",
    );
  });

  test("fails closed when the client scope is not an object", () => {
    authorityError(
      () => resolveAuthorityScope(AUTHORITY, null),
      "CLIENT_SCOPE_INVALID",
      "scope",
    );
  });

  test.each(["appId", "projectId", "agentId", "namespace", "visibility"] as const)(
    "rejects missing client field %s",
    (field) => {
      const invalid = { ...CLIENT_SCOPE } as Record<string, unknown>;
      delete invalid[field];
      authorityError(
        () => resolveAuthorityScope(AUTHORITY, invalid),
        "CLIENT_FIELD_MISSING",
        field,
      );
    },
  );

  test.each([
    ["appId", ""],
    ["appId", " mengshu"],
    ["projectId", "project-a "],
    ["agentId", "\u0000agent-a"],
    ["namespace", 42],
    ["visibility", "owner"],
  ] as const)("rejects invalid or empty client %s", (field, value) => {
    authorityError(
      () => resolveAuthorityScope(AUTHORITY, { ...CLIENT_SCOPE, [field]: value }),
      "CLIENT_FIELD_INVALID",
      field,
    );
  });

  test.each(["tenantId", "userId", "workspaceId", "sessionId", "extra"])(
    "rejects client-owned or unsupported field %s",
    (field) => {
      authorityError(
        () => resolveAuthorityScope(AUTHORITY, { ...CLIENT_SCOPE, [field]: "attacker" }),
        "CLIENT_FIELD_FORBIDDEN",
        field,
      );
    },
  );

  test.each([
    ["appId", "other-app"],
    ["projectId", "other-project"],
    ["agentId", "other-agent"],
    ["namespace", "other-namespace"],
    ["visibility", "public"],
  ] as const)("rejects non-allowlisted client %s", (field, value) => {
    authorityError(
      () => resolveAuthorityScope(AUTHORITY, { ...CLIENT_SCOPE, [field]: value }),
      "CLIENT_VALUE_NOT_ALLOWED",
      field,
    );
  });

  test.each([
    ["appId", "MENGSHU"],
    ["projectId", "PROJECT-A"],
    ["agentId", "AGENT-A"],
    ["namespace", "MEMORIES"],
    ["namespace", "ｍｅｍｏｒｉｅｓ"],
    ["visibility", "PRIVATE"],
  ] as const)("rejects case or Unicode-confusable client %s", (field, value) => {
    authorityError(
      () => resolveAuthorityScope(AUTHORITY, { ...CLIENT_SCOPE, [field]: value }),
      "CLIENT_VALUE_AMBIGUOUS",
      field,
    );
  });

  test.each([
    "/repo/../project-a",
    "/repo/./project-a",
    "/repo//project-a",
    "/repo/project-a/",
    "\\repo\\project-a",
    "/repo/%2e%2e/project-a",
    "/repo/%2Fproject-a",
    "/repo/%252e%252e/project-a",
    "/repo/\u2215project-a",
  ])("rejects project path confusion: %s", (projectId) => {
    authorityError(
      () => resolveAuthorityScope(AUTHORITY, { ...CLIENT_SCOPE, projectId }),
      "CLIENT_FIELD_INVALID",
      "projectId",
    );
  });

  test("rejects ambiguous authority allowlist entries", () => {
    const ambiguous: AuthorityScope = {
      ...AUTHORITY,
      allow: {
        ...AUTHORITY.allow,
        projectIds: ["project-a", "PROJECT-A"],
      },
    };
    authorityError(
      () => resolveAuthorityScope(ambiguous, CLIENT_SCOPE),
      "AUTHORITY_ALLOWLIST_AMBIGUOUS",
      "projectId",
    );
  });

  test("rejects non-canonical authority values instead of normalizing them", () => {
    const invalid: AuthorityScope = {
      ...AUTHORITY,
      allow: { ...AUTHORITY.allow, namespaces: [" memories"] },
    };
    authorityError(
      () => resolveAuthorityScope(invalid, CLIENT_SCOPE),
      "AUTHORITY_FIELD_INVALID",
      "namespace",
    );
  });
});

const CROSS_TENANT_USER_CASES = Array.from({ length: 10 }, (_, tenantIndex) =>
  Array.from({ length: 10 }, (_, userIndex) => ({
    tenantId: `tenant-${tenantIndex + 1}`,
    userId: `user-${userIndex + 1}`,
  })),
).flat();

describe("AuthorityScope cross-tenant/user isolation matrix", () => {
  test.each(CROSS_TENANT_USER_CASES)(
    "rejects client authority override $tenantId/$userId",
    ({ tenantId, userId }) => {
      authorityError(
        () => resolveAuthorityScope(AUTHORITY, {
          ...CLIENT_SCOPE,
          tenantId,
          userId,
        }),
        "CLIENT_FIELD_FORBIDDEN",
      );
    },
  );

  test("rejects a userId-only override even when tenantId is omitted", () => {
    authorityError(
      () => resolveAuthorityScope(AUTHORITY, { ...CLIENT_SCOPE, userId: "user-b" }),
      "CLIENT_FIELD_FORBIDDEN",
      "userId",
    );
  });
});
