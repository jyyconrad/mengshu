import { describe, expect, test } from "vitest";
import type { MemoryRecord, MemoryScope } from "../../../core/types.js";
import { computeRecallScoreBreakdown } from "../../../core/recall-scoring.js";
import { handleMemoryContextFast } from "./context-fast.js";

const scope: MemoryScope = {
  tenantId: "local",
  appId: "openclaw",
  userId: "user-1",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "memories",
};

const record: MemoryRecord = {
  id: "rule-1",
  scope,
  kind: "preference",
  semanticType: "rules",
  text: "严格遵守升级方案",
  contentHash: "hash-1",
  importance: 0.9,
  category: "core",
  dataType: "memory",
  metadata: {},
  provenance: { source: "user" },
  createdAt: 1,
};

const scoreBreakdown = computeRecallScoreBreakdown(
  record,
  { relevance: 0.9, scopeFit: 1 },
  ["vector"],
  { vector: 0.9 },
);

function contextResponse() {
  return {
    scope,
    slots: {
      rules: {
        semanticType: "rules" as const,
        question: "Q3",
        content: `- ${record.text}`,
        sourceIds: [record.id],
        recallReceipts: [{
          sourceId: record.id,
          score: scoreBreakdown.score,
          source: "vector" as const,
          scoreBreakdown,
        }],
        nodeCount: 1,
        tokenEstimate: record.text.length,
      },
    },
    content: record.text,
    telemetry: { latencyMs: 1, nodesUsed: 1, cacheHit: false },
  };
}

describe("handleMemoryContextFast", () => {
  test("details.slots 原样保留唯一六因子 recallReceipts", async () => {
    const response = contextResponse();
    const result = await handleMemoryContextFast(
      { task: "upgrade", scope },
      { agentFastPath: { context: async () => response } as never },
    );

    expect(result.details).toMatchObject({
      slots: {
        rules: {
          sourceIds: [record.id],
          recallReceipts: response.slots.rules.recallReceipts,
        },
      },
    });
  });

  test("sourceIds 与 recallReceipts 不一致时 fail-closed", async () => {
    const response = contextResponse();
    response.slots.rules.recallReceipts = [];

    await expect(handleMemoryContextFast(
      { task: "upgrade", scope },
      { agentFastPath: { context: async () => response } as never },
    )).rejects.toThrow("CONTEXT_RECALL_BREAKDOWN_REQUIRED");
  });
});
