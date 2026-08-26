import { describe, expect, test } from "vitest";

import { requireContextFastRecallReceipts } from "../domain/recall-receipt-validation.js";
import type { ContextFastResponse } from "../domain/semantic-types.js";
import { applyKnowledgeResourceIndexToContext } from "./knowledge-resource-context.js";

const scope = {
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "codex",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "memory",
  visibility: "private" as const,
  sessionId: "session-a",
};

function response(tokenBudget = 500): ContextFastResponse {
  return {
    scope,
    slots: {
      resource: {
        semanticType: "resource",
        question: "Q5: resources",
        content: "- native resource",
        sourceIds: [],
        evidenceRefs: [],
        recallReceipts: [],
        nodeCount: 0,
        tokenEstimate: 17,
      },
    },
    content: "native prompt",
    assemblyPlan: {
      sessionId: scope.sessionId,
      slots: {
        resource: {
          semanticType: "resource",
          mustRead: [],
          navigation: [],
          assetRefs: [],
          evidenceRefs: [],
          filtered: [],
          tokenBudget,
        },
      },
      tools: [],
      denied: [],
      versions: {
        slotSnapshot: 2,
        retrieval: "retrieval-v1",
        scoring: "scoring-v1",
        promptPolicy: "prompt-v1",
      },
      stableContentHash: "a".repeat(64),
      dynamicContentHash: "b".repeat(64),
      expiresAt: "2026-08-16T12:00:00.000Z",
    },
    warnings: [],
    telemetry: { latencyMs: 10, nodesUsed: 0, cacheHit: false, tokenEstimate: 13 },
  };
}

const resource = {
  ref: "11111111-1111-4111-8111-111111111111",
  revision: "a".repeat(64),
  title: "Runtime guide",
  category: "docs",
  createdAt: "2026-08-01T00:00:00.000Z",
  sourceRef: { kind: "file" as const, ref: "docs/runtime.md" },
  evidence: {
    kind: "knowledge_record" as const,
    ref: "11111111-1111-4111-8111-111111111111",
    revision: "a".repeat(64),
  },
};

describe("applyKnowledgeResourceIndexToContext", () => {
  test("adds only a short resource index and R2 navigation without recall source ids", () => {
    const native = response();
    const result = applyKnowledgeResourceIndexToContext(native, {
      resources: [resource],
      warnings: [],
    }, "implement runtime");

    expect(result).not.toBe(native);
    expect(result.slots.resource?.content).toContain(
      `[knowledge:${resource.ref}@${resource.revision}] Runtime guide`,
    );
    expect(result.slots.resource?.content).not.toContain("正文");
    expect(result.slots.resource?.sourceIds).toEqual([]);
    expect(result.slots.resource?.recallReceipts).toEqual([]);
    expect(result.assemblyPlan?.slots.resource?.navigation).toContainEqual({
      ref: resource.ref,
      kind: "knowledge",
      level: "R2",
      semanticType: "resource",
      revision: resource.revision,
      title: resource.title,
      evidenceRefs: [`knowledge:${resource.ref}@${resource.revision}`],
    });
    expect(result.assemblyPlan?.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "memory_knowledge_search" }),
      expect.objectContaining({ name: "memory_knowledge_read" }),
    ]));
    expect(result.assemblyPlan?.stableContentHash).toBe(native.assemblyPlan?.stableContentHash);
    expect(result.assemblyPlan?.dynamicContentHash).not.toBe(native.assemblyPlan?.dynamicContentHash);
    expect(() => requireContextFastRecallReceipts(result)).not.toThrow();
  });

  test("keeps navigation but omits prompt index when resource slot budget is exhausted", () => {
    const result = applyKnowledgeResourceIndexToContext(response(17), {
      resources: [resource],
      warnings: [],
    });

    expect(result.slots.resource?.content).toBe("- native resource");
    expect(result.assemblyPlan?.slots.resource?.navigation).toHaveLength(1);
    expect(result.warnings).toContain("knowledge_resource_budget_exceeded");
  });

  test("preserves native context and surfaces safe capability warnings", () => {
    const native = response();
    const result = applyKnowledgeResourceIndexToContext(native, {
      resources: [],
      warnings: ["knowledge_resource_timeout"],
    });

    expect(result.slots).toEqual(native.slots);
    expect(result.warnings).toEqual(["knowledge_resource_timeout"]);
  });
});
