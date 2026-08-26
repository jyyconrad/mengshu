import { describe, expect, test } from "vitest";

import type { AuthorityScope } from "../../../packages/core/src/domain/authority-scope.js";
import type { MemoryScope } from "../../../core/types.js";
import {
  createExactOpenClawAuthority,
  defaultScopeFromExactOpenClawAuthority,
  resolveOpenClawAuthorityScope,
  resolveOpenClawHostScope,
  snapshotOpenClawAuthority,
} from "./authority.js";

const defaultScope: MemoryScope = {
  tenantId: "server-tenant",
  userId: "server-user",
  appId: "openclaw",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "memories",
  visibility: "private",
};

const authority: AuthorityScope = {
  tenantId: defaultScope.tenantId,
  userId: defaultScope.userId,
  allow: {
    appIds: ["openclaw", "openclaw-admin"],
    projectIds: ["project-a", "project-b"],
    agentIds: ["agent-a", "agent-b"],
    namespaces: ["memories", "knowledge"],
    visibilities: ["private", "team"],
  },
};

describe("OpenClaw server-owned authority", () => {
  test("exact authority 完全来自 server defaultScope，不硬编码身份", () => {
    expect(createExactOpenClawAuthority(defaultScope)).toEqual({
      tenantId: "server-tenant",
      userId: "server-user",
      allow: {
        appIds: ["openclaw"],
        projectIds: ["project-a"],
        agentIds: ["agent-a"],
        namespaces: ["memories"],
        visibilities: ["private"],
      },
    });
  });

  test("operator authority 深快照后不受原始 allowlist mutation 影响", () => {
    const mutable: AuthorityScope = {
      tenantId: "tenant-x",
      userId: "user-x",
      allow: {
        appIds: ["openclaw"],
        projectIds: ["project-a"],
        agentIds: ["agent-a"],
        namespaces: ["memories"],
        visibilities: ["private"],
      },
    };
    const snapshot = snapshotOpenClawAuthority(mutable);
    (mutable.allow.projectIds as string[]).push("pwn");

    expect(snapshot.allow.projectIds).toEqual(["project-a"]);
    expect(Object.isFrozen(snapshot.allow.projectIds)).toBe(true);
    expect(() => resolveOpenClawAuthorityScope(snapshot, {
      tenantId: "tenant-x",
      userId: "user-x",
      appId: "openclaw",
      projectId: "project-a",
      agentId: "agent-a",
      namespace: "memories",
      visibility: "private",
    }, { projectId: "pwn" })).toThrow(expect.objectContaining({
      code: "CLIENT_VALUE_NOT_ALLOWED",
    }));
  });

  test("exact operator authority 可生成非硬编码 runtime default，多值 allowlist 明确拒绝", () => {
    expect(defaultScopeFromExactOpenClawAuthority({
      tenantId: "tenant-x",
      userId: "user-x",
      allow: {
        appIds: ["openclaw-x"],
        projectIds: ["project-x"],
        agentIds: ["agent-x"],
        namespaces: ["memory-x"],
        visibilities: ["team"],
      },
    })).toEqual({
      tenantId: "tenant-x",
      userId: "user-x",
      appId: "openclaw-x",
      projectId: "project-x",
      agentId: "agent-x",
      namespace: "memory-x",
      visibility: "team",
    });
    expect(() => defaultScopeFromExactOpenClawAuthority(authority)).toThrow(
      /exactly one default/i,
    );
  });

  test("无 client claim 使用 defaultScope；allowlist 内 canonical claim 可选择", () => {
    expect(resolveOpenClawAuthorityScope(authority, defaultScope)).toEqual(defaultScope);
    expect(resolveOpenClawAuthorityScope(authority, defaultScope, {
      scope: {
        appId: "openclaw-admin",
        projectId: "project-b",
        agentId: "agent-b",
        namespace: "knowledge",
        visibility: "team",
      },
    })).toEqual({
      tenantId: "server-tenant",
      userId: "server-user",
      appId: "openclaw-admin",
      projectId: "project-b",
      agentId: "agent-b",
      namespace: "knowledge",
      visibility: "team",
    });
  });

  test("host scope 在选定 Agent 后收窄 authority，参数不能切换到其他已授权 Agent", () => {
    const boundary = resolveOpenClawHostScope(authority, defaultScope, {
      agentId: "agent-b",
      sessionKey: "agent:agent-b:main",
    });

    expect(boundary.authority).toEqual({
      tenantId: "server-tenant",
      userId: "server-user",
      sessionId: "agent:agent-b:main",
      allow: {
        appIds: ["openclaw"],
        projectIds: ["project-a"],
        agentIds: ["agent-b"],
        namespaces: ["memories"],
        visibilities: ["private"],
      },
    });
    expect(() => resolveOpenClawAuthorityScope(
      boundary.authority,
      boundary.scope,
      { agentId: "agent-a" },
    )).toThrow(expect.objectContaining({
      code: "CLIENT_VALUE_NOT_ALLOWED",
      field: "agentId",
    }));
  });

  test("100 组顶层/envelope tenant/user claim 均 fail-closed，永不覆盖 server identity", () => {
    const attacks = Array.from({ length: 100 }, (_, index) => index % 2 === 0
      ? { tenantId: `tenant-${index}` }
      : { scope: { userId: `user-${index}` } });

    for (const attack of attacks) {
      expect(() => resolveOpenClawAuthorityScope(authority, defaultScope, attack))
        .toThrow(expect.objectContaining({ code: "CLIENT_FIELD_FORBIDDEN" }));
    }
  });

  test.each([
    [{ appId: "evil-app" }, "appId"],
    [{ projectId: "evil-project" }, "projectId"],
    [{ agentId: "evil-agent" }, "agentId"],
    [{ namespace: "evil-namespace" }, "namespace"],
    [{ visibility: "public" }, "visibility"],
  ] as const)("非 allowlist claim %j 在任何下游调用前拒绝", (claim, field) => {
    expect(() => resolveOpenClawAuthorityScope(authority, defaultScope, claim))
      .toThrow(expect.objectContaining({ code: "CLIENT_VALUE_NOT_ALLOWED", field }));
  });

  test("messages/filter/metadata 内同名业务字段不参与 authority 解析", () => {
    const businessPayload = {
      messages: [{ role: "user", content: { userId: "mentioned-user", projectId: "mentioned-project" } }],
      filter: { projectId: "business-filter-project", nested: { tenantId: "business-tenant" } },
      metadata: { userId: "metadata-user", projectId: "metadata-project" },
    };

    expect(resolveOpenClawAuthorityScope(authority, defaultScope, businessPayload))
      .toEqual(defaultScope);
  });

  test("仅根字段和根 scope envelope 的明确别名可选择 authority scope", () => {
    expect(resolveOpenClawAuthorityScope(authority, defaultScope, {
      projectPath: "project-b",
      agentName: "agent-b",
      scope: { appId: "openclaw-admin", namespace: "knowledge", visibility: "team" },
    })).toMatchObject({
      appId: "openclaw-admin",
      projectId: "project-b",
      agentId: "agent-b",
      namespace: "knowledge",
      visibility: "team",
    });
  });

  test("深层/宽幅业务 payload 不遍历，且 scope envelope 拒绝未知字段/getter", () => {
    let deep: Record<string, unknown> = { userId: "business-only" };
    for (let index = 0; index < 20_000; index += 1) deep = { child: deep };
    expect(resolveOpenClawAuthorityScope(authority, defaultScope, { messages: [deep] }))
      .toEqual(defaultScope);

    expect(() => resolveOpenClawAuthorityScope(authority, defaultScope, {
      scope: { projectId: "project-b", nested: {} },
    })).toThrow(expect.objectContaining({ code: "CLIENT_FIELD_FORBIDDEN", field: "nested" }));
    const scopeWithGetter = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(scopeWithGetter, "projectId", { enumerable: true, get: () => "project-b" });
    expect(() => resolveOpenClawAuthorityScope(authority, defaultScope, { scope: scopeWithGetter }))
      .toThrow(expect.objectContaining({ code: "CLIENT_SCOPE_INVALID" }));
  });

  test.each([null, [], new Date()])("非 plain root request %j fail-closed", (request) => {
    expect(() => resolveOpenClawAuthorityScope(authority, defaultScope, request))
      .toThrow(expect.objectContaining({ code: "CLIENT_SCOPE_INVALID" }));
  });

  test("scope envelope 必须是 plain object，冲突别名和 symbol 字段均拒绝", () => {
    expect(() => resolveOpenClawAuthorityScope(authority, defaultScope, { scope: "project-b" }))
      .toThrow(expect.objectContaining({ code: "CLIENT_SCOPE_INVALID" }));
    expect(() => resolveOpenClawAuthorityScope(authority, defaultScope, {
      projectId: "project-a",
      scope: { projectPath: "project-b" },
    })).toThrow(expect.objectContaining({ code: "CLIENT_VALUE_AMBIGUOUS" }));
    expect(() => resolveOpenClawAuthorityScope(authority, defaultScope, {
      scope: { [Symbol("project")]: "project-b" },
    })).toThrow(expect.objectContaining({ code: "CLIENT_FIELD_FORBIDDEN" }));
  });

  test("authority 缺失或与 runtime default identity 不一致时拒绝 composition", () => {
    expect(() => resolveOpenClawAuthorityScope(
      undefined as unknown as AuthorityScope,
      defaultScope,
    )).toThrow();
    expect(() => resolveOpenClawAuthorityScope(
      { ...authority, tenantId: "other-tenant" },
      defaultScope,
    )).toThrow(expect.objectContaining({ code: "AUTHORITY_FIELD_INVALID" }));
  });
});
