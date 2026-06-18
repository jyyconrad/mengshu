/**
 * scope-policy 单元测试。
 *
 * 覆盖：多级 scope key（workspace/project/session）、单 appId 复用规则 1-5
 * （profile/rules/experience 按 workspace 复用，task_context/resource 按 project 隔离）、
 * visibility 过滤（private/workspace/public）。纯单元风格，无 mock。
 */

import { describe, expect, test } from "vitest";
import type { MemoryRecord, MemoryScope, MemorySemanticType } from "./types.js";
import {
  DEFAULT_SLOT_REUSE_POLICY,
  applyScopeReusePolicy,
  applyVisibilityFilter,
  matchesReuseScope,
  scopeToProjectKey,
  scopeToSessionKey,
  scopeToWorkspaceKey,
} from "./scope-policy.js";
import { scopeToKey } from "./scope.js";

const now = 1710000000000;

function makeScope(overrides: Partial<MemoryScope> = {}): MemoryScope {
  return {
    tenantId: "acme",
    appId: "openclaw",
    userId: "user-1",
    projectId: "project-a",
    agentId: "agent-main",
    namespace: "memories",
    workspaceId: "ws-1",
    sessionId: "sess-1",
    ...overrides,
  };
}

function makeRecord(
  scope: MemoryScope,
  semanticType: MemorySemanticType,
  id = "mem-1",
): MemoryRecord {
  return {
    id,
    scope,
    kind: "preference",
    semanticType,
    text: "demo",
    contentHash: `hash-${id}`,
    importance: 0.5,
    category: "preference",
    dataType: "memory",
    metadata: {},
    provenance: { source: "user", createdAt: now },
    createdAt: now,
  };
}

describe("multi-level scope keys", () => {
  test("scopeToProjectKey includes workspaceId dimension distinct from scopeToKey", () => {
    const scope = makeScope();
    // 修正后：project key 包含 workspaceId，不再等于底层 scopeToKey
    // 防止跨 workspace 同 projectId 串库
    expect(scopeToProjectKey(scope)).not.toBe(scopeToKey(scope));
    expect(scopeToProjectKey(scope)).toBe(
      "acme:openclaw:user-1:ws-1:project-a:agent-main:memories",
    );
  });

  test("scopeToProjectKey separates different workspaces with same projectId", () => {
    const ws1 = makeScope({ workspaceId: "ws-1", projectId: "proj-shared" });
    const ws2 = makeScope({ workspaceId: "ws-2", projectId: "proj-shared" });
    expect(scopeToProjectKey(ws1)).not.toBe(scopeToProjectKey(ws2));
  });

  test("scopeToProjectKey falls back to default when workspaceId missing", () => {
    const noWs = makeScope({ workspaceId: undefined });
    expect(scopeToProjectKey(noWs)).toBe(
      "acme:openclaw:user-1:default:project-a:agent-main:memories",
    );
  });

  test("scopeToWorkspaceKey ignores projectId/agentId/sessionId", () => {
    const base = makeScope({ projectId: "project-a", agentId: "agent-main", sessionId: "sess-1" });
    const other = makeScope({ projectId: "project-z", agentId: "agent-x", sessionId: "sess-9" });
    expect(scopeToWorkspaceKey(base)).toBe(scopeToWorkspaceKey(other));
    expect(scopeToWorkspaceKey(base)).toBe("acme:openclaw:user-1:ws-1:memories");
  });

  test("scopeToWorkspaceKey separates different workspaces", () => {
    expect(scopeToWorkspaceKey(makeScope({ workspaceId: "ws-1" }))).not.toBe(
      scopeToWorkspaceKey(makeScope({ workspaceId: "ws-2" })),
    );
  });

  test("scopeToWorkspaceKey falls back to default when workspaceId missing", () => {
    expect(scopeToWorkspaceKey(makeScope({ workspaceId: undefined }))).toBe(
      "acme:openclaw:user-1:default:memories",
    );
  });

  test("scopeToSessionKey extends project key with sessionId", () => {
    const scope = makeScope();
    expect(scopeToSessionKey(scope)).toBe(`${scopeToProjectKey(scope)}:sess-1`);
    expect(scopeToSessionKey(makeScope({ sessionId: "sess-2" }))).not.toBe(
      scopeToSessionKey(scope),
    );
  });
});

describe("single-appId reuse rules", () => {
  const request = makeScope({ projectId: "project-current", sessionId: "sess-current" });

  test("rule 1: profile reuses across projects within same workspace", () => {
    const record = makeScope({ projectId: "project-other" });
    expect(matchesReuseScope(record, request, "profile", DEFAULT_SLOT_REUSE_POLICY)).toBe(true);
  });

  test("rule 2: rules reuse across projects within same workspace", () => {
    const record = makeScope({ projectId: "project-other" });
    expect(matchesReuseScope(record, request, "rules", DEFAULT_SLOT_REUSE_POLICY)).toBe(true);
  });

  test("rule 3: task_context is isolated per project", () => {
    const sameProject = makeScope({ projectId: "project-current" });
    const otherProject = makeScope({ projectId: "project-other" });
    expect(matchesReuseScope(sameProject, request, "task_context")).toBe(true);
    expect(matchesReuseScope(otherProject, request, "task_context")).toBe(false);
  });

  test("rule 4: experience reuses across projects within same workspace", () => {
    const record = makeScope({ projectId: "project-other" });
    expect(matchesReuseScope(record, request, "experience")).toBe(true);
  });

  test("rule 5: resource is isolated per project", () => {
    const otherProject = makeScope({ projectId: "project-other" });
    expect(matchesReuseScope(otherProject, request, "resource")).toBe(false);
  });

  test("profile does not reuse across different appId (single-app boundary)", () => {
    const otherApp = makeScope({ appId: "other-app", projectId: "project-other" });
    expect(matchesReuseScope(otherApp, request, "profile")).toBe(false);
  });

  test("profile does not reuse across different workspace", () => {
    const otherWorkspace = makeScope({ workspaceId: "ws-other", projectId: "project-other" });
    expect(matchesReuseScope(otherWorkspace, request, "profile")).toBe(false);
  });

  test("task_context does not reuse across workspaces even with same projectId", () => {
    // 修正点：project 级隔离必须包含 workspace 维度
    const sameProjectOtherWs = makeScope({
      workspaceId: "ws-other",
      projectId: "project-current",
    });
    expect(matchesReuseScope(sameProjectOtherWs, request, "task_context")).toBe(false);
  });
});

describe("applyScopeReusePolicy", () => {
  const request = makeScope({ projectId: "project-current" });

  test("splits records into reusable and filtered with reason", () => {
    const records = [
      makeRecord(makeScope({ projectId: "project-other" }), "profile", "p1"),
      makeRecord(makeScope({ projectId: "project-other" }), "task_context", "t1"),
      makeRecord(makeScope({ projectId: "project-current" }), "task_context", "t2"),
    ];

    const result = applyScopeReusePolicy(records, request);

    expect(result.reusable.map((r) => r.id)).toEqual(["p1", "t2"]);
    expect(result.filtered).toHaveLength(1);
    expect(result.filtered[0].record.id).toBe("t1");
    expect(result.filtered[0].reason).toBe("scope_mismatch");
  });

  test("does not mutate the input array", () => {
    const records = [makeRecord(makeScope({ projectId: "project-other" }), "task_context", "t1")];
    const snapshot = [...records];
    applyScopeReusePolicy(records, request);
    expect(records).toEqual(snapshot);
  });
});

describe("applyVisibilityFilter", () => {
  const request = makeScope({ userId: "user-1", workspaceId: "ws-1" });

  test("private memory is hidden from other users", () => {
    const record = makeRecord(
      makeScope({ userId: "user-2", visibility: "private" }),
      "profile",
      "v1",
    );
    const result = applyVisibilityFilter([record], request);
    expect(result.visible).toHaveLength(0);
    expect(result.filtered[0].reason).toBe("visibility_private");
  });

  test("private memory is visible to the same user", () => {
    const record = makeRecord(
      makeScope({ userId: "user-1", visibility: "private" }),
      "profile",
      "v2",
    );
    const result = applyVisibilityFilter([record], request);
    expect(result.visible.map((r) => r.id)).toEqual(["v2"]);
    expect(result.filtered).toHaveLength(0);
  });

  test("undefined visibility defaults to private", () => {
    const record = makeRecord(makeScope({ userId: "user-2", visibility: undefined }), "profile", "v3");
    const result = applyVisibilityFilter([record], request);
    expect(result.visible).toHaveLength(0);
  });

  test("workspace memory is visible within the same workspace", () => {
    const record = makeRecord(
      makeScope({ userId: "user-2", workspaceId: "ws-1", visibility: "workspace" }),
      "rules",
      "v4",
    );
    const result = applyVisibilityFilter([record], request);
    expect(result.visible.map((r) => r.id)).toEqual(["v4"]);
  });

  test("workspace memory is hidden across workspaces", () => {
    const record = makeRecord(
      makeScope({ userId: "user-2", workspaceId: "ws-other", visibility: "workspace" }),
      "rules",
      "v5",
    );
    const result = applyVisibilityFilter([record], request);
    expect(result.visible).toHaveLength(0);
  });

  test("public memory is visible to everyone", () => {
    const record = makeRecord(
      makeScope({ userId: "user-9", workspaceId: "ws-9", visibility: "public" }),
      "resource",
      "v6",
    );
    const result = applyVisibilityFilter([record], request);
    expect(result.visible.map((r) => r.id)).toEqual(["v6"]);
  });
});
