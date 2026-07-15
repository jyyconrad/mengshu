import { describe, expect, test } from "vitest";

import {
  authorityScopeFingerprint,
  canonicalAuthorityScope,
} from "./authority-scope-fingerprint.js";

const scope = {
  tenantId: "tenant",
  userId: "user",
  appId: "app",
  projectId: "project",
  agentId: "agent",
  namespace: "memory",
  visibility: "private" as const,
};

describe("authorityScopeFingerprint", () => {
  test("固定覆盖完整 9D authority，缺省 context 归一成空串", () => {
    expect(canonicalAuthorityScope(scope)).toEqual({
      ...scope,
      workspaceId: "",
      sessionId: "",
    });
    expect(authorityScopeFingerprint(scope)).toMatch(/^[0-9a-f]{64}$/);
    expect(authorityScopeFingerprint(scope)).toBe(authorityScopeFingerprint({ ...scope }));
  });

  test.each([
    ["visibility", { ...scope, visibility: "team" as const }],
    ["workspace", { ...scope, workspaceId: "workspace" }],
    ["session", { ...scope, sessionId: "session" }],
  ])("%s 变化会产生不同 fingerprint", (_label, changed) => {
    expect(authorityScopeFingerprint(changed)).not.toBe(authorityScopeFingerprint(scope));
  });

  test("拒绝空白、控制字符和缺失 visibility", () => {
    expect(() => authorityScopeFingerprint({ ...scope, tenantId: "bad tenant" }))
      .toThrow(/invalid/i);
    expect(() => authorityScopeFingerprint({ ...scope, visibility: undefined }))
      .toThrow(/invalid/i);
  });
});
