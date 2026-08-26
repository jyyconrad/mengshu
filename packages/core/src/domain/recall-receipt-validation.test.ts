import { describe, expect, test } from "vitest";
import type { ContextFastResponse } from "./semantic-types.js";
import type { MemoryRecord, MemoryScope, RecallHit } from "./types.js";
import { computeRecallScoreBreakdown } from "./recall-scoring.js";
import {
  requireContextFastRecallReceipts,
  requireRecallHitReceipt,
} from "./recall-receipt-validation.js";

const scope: MemoryScope = {
  tenantId: "local",
  appId: "mengshu",
  userId: "user-1",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "memories",
};

const record: MemoryRecord = {
  id: "memory-1",
  scope,
  kind: "preference",
  semanticType: "rules",
  text: "所有召回入口共享同一六因子回执",
  contentHash: "hash-1",
  importance: 0.9,
  category: "core",
  dataType: "memory",
  metadata: {},
  provenance: { source: "user" },
  createdAt: 1,
};

const breakdown = computeRecallScoreBreakdown(
  record,
  { relevance: 0.8, scopeFit: 1 },
  ["vector"],
  { vector: 0.8 },
);

function hit(overrides: Partial<RecallHit> = {}): RecallHit {
  return {
    record,
    score: breakdown.score,
    source: "vector",
    scoreBreakdown: breakdown,
    ...overrides,
  };
}

describe("recall receipt validation", () => {
  test("合法命中原样返回 Retrieval Engine 产生的 breakdown", () => {
    expect(requireRecallHitReceipt(hit())).toBe(breakdown);
  });

  test("总分不一致或 source 不在 matchedBy 时 fail-closed", () => {
    expect(() => requireRecallHitReceipt(hit({ score: breakdown.score - 0.1 })))
      .toThrow("RECALL_SCORE_BREAKDOWN_REQUIRED");
    expect(() => requireRecallHitReceipt(hit({ source: "tree" })))
      .toThrow("RECALL_SCORE_BREAKDOWN_REQUIRED");
  });

  test("context_fast 要求 sourceIds 与 recallReceipts 数量和顺序完全一致", () => {
    const response = {
      scope,
      slots: {
        rules: {
          semanticType: "rules",
          question: "Q3",
          content: `- ${record.text}`,
          sourceIds: [record.id],
          recallReceipts: [{
            sourceId: record.id,
            score: breakdown.score,
            source: "vector",
            scoreBreakdown: breakdown,
          }],
          nodeCount: 1,
        },
      },
      content: record.text,
      telemetry: { latencyMs: 1, nodesUsed: 1, cacheHit: false },
    } satisfies ContextFastResponse;

    expect(requireContextFastRecallReceipts(response)).toBe(response);
    expect(() => requireContextFastRecallReceipts({
      ...response,
      slots: {
        rules: {
          ...response.slots.rules,
          sourceIds: ["other-memory"],
        },
      },
    })).toThrow("CONTEXT_RECALL_BREAKDOWN_REQUIRED");
    expect(() => requireContextFastRecallReceipts({
      ...response,
      slots: {
        rules: {
          ...response.slots.rules,
          recallReceipts: [],
        },
      },
    })).toThrow("CONTEXT_RECALL_BREAKDOWN_REQUIRED");
  });
});
