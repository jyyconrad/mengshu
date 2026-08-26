import { describe, expect, test } from "vitest";

import { candidateTreeRoutingEnvelope } from "./candidate-tree-routing.js";

const projectScope = {
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "mengshu",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "working-context",
  visibility: "private" as const,
};

describe("candidate tree routing envelope", () => {
  test("session 内 active 共享 source tree，缺 session 时回退 evidence", () => {
    const base = {
      semanticType: "rules" as const,
      targetScope: "project" as const,
      riskFlags: [] as string[],
      evidenceIds: ["evidence-1"],
      explicit: true,
    };
    expect(candidateTreeRoutingEnvelope({
      ...base,
      scope: { ...projectScope, sessionId: "session-a" },
    })?.sourceId).toBe("session-a");
    expect(candidateTreeRoutingEnvelope({ ...base, scope: projectScope })?.sourceId)
      .toBe("evidence-1");
  });

  test("只投影 validator 裁决，并保留 workspace rule/global 语义", () => {
    expect(candidateTreeRoutingEnvelope({
      scope: projectScope,
      semanticType: "rules",
      targetScope: "workspace",
      riskFlags: ["sensitive"],
      evidenceIds: ["evidence-1", "evidence-2"],
      explicit: true,
    })).toEqual({
      version: 1,
      evidenceId: "evidence-1",
      sourceId: "evidence-1",
      entityIds: [],
      scopeVisibility: "workspace",
      riskFlags: ["sensitive"],
      topicLabels: [],
      topicHotnessEligible: false,
      explicitGlobal: false,
      isWorkspaceRule: true,
    });
    expect(candidateTreeRoutingEnvelope({
      scope: projectScope,
      semanticType: "experience",
      targetScope: "global",
      riskFlags: [],
      evidenceIds: ["evidence-1"],
      explicit: true,
    })?.explicitGlobal).toBe(true);
  });

  test("缺少真实 evidence 时不产生 tree routing", () => {
    expect(candidateTreeRoutingEnvelope({
      scope: projectScope,
      semanticType: "rules",
      targetScope: "project",
      riskFlags: [],
      evidenceIds: [],
      explicit: true,
    })).toBeUndefined();
  });
});
