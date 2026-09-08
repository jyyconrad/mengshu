import { describe, expect, test } from "vitest";
import { resolveAuthorityScope, type AuthorityScope } from "../../domain/authority-scope.js";
import type { MemoryScope } from "../../domain/types.js";
import { historyClientScope } from "./postgres-store.js";

const scope: MemoryScope = { tenantId: "fixture-tenant", userId: "fixture-owner", workspaceId: "fixture-workspace", sessionId: "fixture-session", appId: "fixture-app", projectId: "fixture-project", agentId: "fixture-agent", namespace: "fixture", visibility: "private" };
const authority: AuthorityScope = { tenantId: scope.tenantId, userId: scope.userId, workspaceId: scope.workspaceId, sessionId: scope.sessionId,
  allow: { appIds: [scope.appId], projectIds: [scope.projectId], agentIds: [scope.agentId], namespaces: [scope.namespace], visibilities: ["private"] } };

describe("history native authority boundary", () => {
  test("projects only the five client fields and resolves all nine coordinates using the real validator", () => {
    expect(() => resolveAuthorityScope(authority, scope)).toThrow(expect.objectContaining({ code: "CLIENT_FIELD_FORBIDDEN" }));
    const client = historyClientScope(scope);
    expect(Object.keys(client).sort()).toEqual(["agentId", "appId", "namespace", "projectId", "visibility"]);
    expect(resolveAuthorityScope(authority, client)).toEqual(scope);
    expect(scope.sessionId).toBe("fixture-session");
  });

  test("owner/workspace/session values come from server authority, never the projected source", () => {
    const client = historyClientScope({ ...scope, tenantId: "forged-tenant", userId: "forged-owner", workspaceId: "forged-workspace", sessionId: "forged-session" });
    expect(resolveAuthorityScope(authority, client)).toEqual(scope);
    expect(() => resolveAuthorityScope(authority, { ...client, tenantId: "forged-tenant" })).toThrow(expect.objectContaining({ code: "CLIENT_FIELD_FORBIDDEN" }));
  });

  test("does not bypass exact server allowlists or manufacture optional authority coordinates", () => {
    expect(() => resolveAuthorityScope(authority, historyClientScope({ ...scope, projectId: "other-project" }))).toThrow(expect.objectContaining({ code: "CLIENT_VALUE_NOT_ALLOWED" }));
    const { workspaceId: _workspace, sessionId: _session, ...withoutOptional } = authority;
    const resolved = resolveAuthorityScope(withoutOptional, historyClientScope({ ...scope, visibility: undefined }));
    expect(resolved.visibility).toBe("private");
    expect(resolved.workspaceId).toBeUndefined(); expect(resolved.sessionId).toBeUndefined();
  });
});
