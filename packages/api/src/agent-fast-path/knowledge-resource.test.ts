import { describe, expect, test, vi } from "vitest";

import type { ContextFastResponse } from "../../../core/src/domain/semantic-types.js";
import { AgentFastPathService } from "./index.js";

const scope = {
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "codex",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "memory",
  visibility: "private" as const,
};

function nativeResponse(): ContextFastResponse {
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
    content: "native context",
    assemblyPlan: {
      sessionId: "context",
      slots: {
        resource: {
          semanticType: "resource",
          mustRead: [],
          navigation: [],
          assetRefs: [],
          evidenceRefs: [],
          filtered: [],
          tokenBudget: 500,
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
    telemetry: { latencyMs: 10, nodesUsed: 0, cacheHit: false, tokenEstimate: 14 },
  };
}

function service(index: () => Promise<unknown>): AgentFastPathService {
  return new AgentFastPathService({
    defaultScope: scope,
    loadRecallHitsForScope: async () => [],
    recall: async () => ({ scope, query: "", hits: [] }),
    builder: {
      buildSlotContextFromRecallHits: vi.fn(async () => nativeResponse()),
      invalidateCacheFingerprint: vi.fn(),
    } as never,
    knowledgeResources: { index } as never,
  });
}

describe("AgentFastPath Knowledge resource overlay", () => {
  test("adds the bounded Knowledge index after native context assembly", async () => {
    const index = vi.fn(async () => ({
      resources: [{
        ref: "11111111-1111-4111-8111-111111111111",
        revision: "a".repeat(64),
        title: "Runtime guide",
        category: "docs",
        createdAt: "2026-08-01T00:00:00.000Z",
        evidence: {
          kind: "knowledge_record" as const,
          ref: "11111111-1111-4111-8111-111111111111",
          revision: "a".repeat(64),
        },
      }],
      warnings: [],
    }));

    const result = await service(index).context({ scope, task: "runtime" });

    expect(index).toHaveBeenCalledWith(scope);
    expect(result.slots.resource?.content).toContain("Runtime guide");
    expect(result.slots.resource?.sourceIds).toEqual([]);
    expect(result.assemblyPlan?.slots.resource?.navigation)
      .toContainEqual(expect.objectContaining({ kind: "knowledge", revision: "a".repeat(64) }));
  });

  test("provider failure preserves native five-slot output and emits a stable warning", async () => {
    const result = await service(async () => {
      throw new Error("postgres credentials");
    }).context({ scope, task: "runtime" });

    expect(result.slots.resource?.content).toBe("- native resource");
    expect(result.warnings).toContain("knowledge_resource_unavailable");
    expect(JSON.stringify(result)).not.toContain("postgres credentials");
  });
});
