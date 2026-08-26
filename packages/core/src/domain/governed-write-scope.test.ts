import { describe, expect, test } from "vitest";

import {
  GovernedWriteScopeError,
  resolveGovernedWriteScope,
  type GovernedWriteScopeLevel,
} from "./governed-write-scope.js";

const exactScope = {
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "app-a",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "memory",
  visibility: "private" as const,
  workspaceId: "workspace-a",
  sessionId: "session-a",
};

const LEVELS = [
  "session",
  "project",
  "workspace",
  "app",
  "user",
  "global",
] as const satisfies readonly GovernedWriteScopeLevel[];

describe("resolveGovernedWriteScope", () => {
  test("未声明 sourceLevel 时有 session 默认 session，否则默认 project", () => {
    expect(resolveGovernedWriteScope({ exactScope }).sourceLevel).toBe("session");
    expect(resolveGovernedWriteScope({
      exactScope: { ...exactScope, sessionId: undefined },
    }).sourceLevel).toBe("project");
  });

  test.each(LEVELS)("D-04 source=%s 时全六档 requested target 单调收窄", (sourceLevel) => {
    const scopeForLevel = {
      ...exactScope,
      ...(sourceLevel === "session" ? {} : { sessionId: undefined }),
      ...(sourceLevel === "workspace" ? {} : sourceLevel === "session" || sourceLevel === "project"
        ? {}
        : { workspaceId: undefined }),
    };

    for (const requestedTargetLevel of LEVELS) {
      const resolved = resolveGovernedWriteScope({
        exactScope: scopeForLevel,
        sourceLevel,
        ...(sourceLevel === "workspace" || sourceLevel === "app" ||
          sourceLevel === "user" || sourceLevel === "global"
          ? { sourceLevelAuthority: "server" as const }
          : {}),
        requestedTargetLevel,
      });
      const expected = LEVELS.indexOf(requestedTargetLevel) > LEVELS.indexOf(sourceLevel)
        ? sourceLevel
        : requestedTargetLevel;
      expect(resolved.targetLevel).toBe(expected);
    }
  });

  test("完整保留并冻结 canonical 9D scope，逻辑 level 不受必填 projectId 干扰", () => {
    const resolved = resolveGovernedWriteScope({
      exactScope: { ...exactScope, sessionId: undefined },
      sourceLevel: "app",
      sourceLevelAuthority: "server",
      requestedTargetLevel: "user",
    });

    expect(resolved).toEqual({
      exactScope: { ...exactScope, sessionId: "" },
      sourceLevel: "app",
      requestedTargetLevel: "user",
      targetLevel: "app",
    });
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.exactScope)).toBe(true);
  });

  test.each(["workspace", "app", "user", "global"] as const)(
    "%s source 必须来自 server-owned 明确信号",
    (sourceLevel) => {
      expect(() => resolveGovernedWriteScope({
        exactScope: { ...exactScope, sessionId: undefined },
        sourceLevel,
      })).toThrowError(expect.objectContaining({
        name: "GovernedWriteScopeError",
        code: "SOURCE_LEVEL_AUTHORITY_REQUIRED",
      }));
    },
  );

  test("source 的物理上下文缺失或与 session 冲突时拒绝歧义", () => {
    expect(() => resolveGovernedWriteScope({
      exactScope: { ...exactScope, sessionId: undefined },
      sourceLevel: "session",
    })).toThrowError(expect.objectContaining({ code: "SOURCE_LEVEL_CONTEXT_MISSING" }));

    expect(() => resolveGovernedWriteScope({
      exactScope: { ...exactScope, workspaceId: undefined, sessionId: undefined },
      sourceLevel: "workspace",
      sourceLevelAuthority: "server",
    })).toThrowError(expect.objectContaining({ code: "SOURCE_LEVEL_CONTEXT_MISSING" }));

    expect(() => resolveGovernedWriteScope({
      exactScope,
      sourceLevel: "project",
    })).toThrowError(expect.objectContaining({ code: "SOURCE_LEVEL_AMBIGUOUS" }));
  });

  test("非法 level、authority 与 9D scope 一律 fail closed", () => {
    const invalidInputs = [
      null,
      { exactScope, sourceLevel: "tenant" },
      { exactScope, requestedTargetLevel: "tenant" },
      {
        exactScope: { ...exactScope, sessionId: undefined },
        sourceLevel: "app",
        sourceLevelAuthority: "client",
      },
      { exactScope: { ...exactScope, visibility: undefined } },
      { exactScope: { ...exactScope, tenantId: "bad tenant" } },
    ];

    for (const input of invalidInputs) {
      expect(() => resolveGovernedWriteScope(input as never)).toThrow(GovernedWriteScopeError);
    }
  });

  test("不修改调用方输入", () => {
    const input = {
      exactScope: { ...exactScope, sessionId: undefined },
      sourceLevel: "user" as const,
      sourceLevelAuthority: "server" as const,
      requestedTargetLevel: "global" as const,
    };
    const snapshot = JSON.stringify(input);

    resolveGovernedWriteScope(input);

    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
