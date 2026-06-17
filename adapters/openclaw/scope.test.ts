import { describe, expect, test } from "vitest";
import { buildOpenClawScope, metadataToOpenClawScope } from "./scope.js";

describe("OpenClaw scope adapter", () => {
  test("builds scope from OpenClaw event fields", () => {
    expect(
      buildOpenClawScope({
        userId: "user-1",
        projectPath: "/workspace/app",
        agentName: "main-agent",
      }),
    ).toEqual({
      tenantId: "local",
      appId: "openclaw",
      userId: "user-1",
      projectId: "/workspace/app",
      agentId: "main-agent",
      namespace: "memories",
    });
  });

  test("uses workspacePath and agentId fallbacks", () => {
    expect(
      buildOpenClawScope({
        workspacePath: "/workspace/fallback",
        agentId: "agent-id",
        tableName: "knowledge",
      }),
    ).toEqual({
      tenantId: "local",
      appId: "openclaw",
      userId: "default",
      projectId: "/workspace/fallback",
      agentId: "agent-id",
      namespace: "knowledge",
    });
  });

  test("maps legacy metadata to scope", () => {
    expect(
      metadataToOpenClawScope({
        userId: "user-1",
        projectPath: "/workspace/app",
        agentName: "agent",
      }, "knowledge_work"),
    ).toEqual({
      tenantId: "local",
      appId: "openclaw",
      userId: "user-1",
      projectId: "/workspace/app",
      agentId: "agent",
      namespace: "knowledge_work",
    });
  });

  test("preserves sessionId and workspaceId when provided", () => {
    expect(
      buildOpenClawScope({
        userId: "user-1",
        projectPath: "/workspace/app",
        agentName: "main-agent",
        sessionId: "session-123",
        workspaceId: "workspace-456",
      }),
    ).toEqual({
      tenantId: "local",
      appId: "openclaw",
      userId: "user-1",
      projectId: "/workspace/app",
      agentId: "main-agent",
      namespace: "memories",
      sessionId: "session-123",
      workspaceId: "workspace-456",
    });
  });

  test("handles missing sessionId and workspaceId gracefully", () => {
    const scope = buildOpenClawScope({
      userId: "user-1",
      projectPath: "/workspace/app",
    });
    expect(scope.sessionId).toBeUndefined();
    expect(scope.workspaceId).toBeUndefined();
  });

  test("ignores empty string sessionId and workspaceId", () => {
    const scope = buildOpenClawScope({
      userId: "user-1",
      projectPath: "/workspace/app",
      sessionId: "  ",
      workspaceId: "",
    });
    expect(scope.sessionId).toBeUndefined();
    expect(scope.workspaceId).toBeUndefined();
  });
});
