import { describe, expect, test } from "vitest";

import type { MemoryScope } from "../domain/types.js";
import {
  planTreeFolding,
  TreeFoldingPlanError,
} from "./tree-folding.js";
import type { TreeSummaryNode } from "./types.js";

const scope: MemoryScope = {
  tenantId: "local",
  userId: "user-1",
  appId: "codex",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "memories",
  visibility: "private",
  workspaceId: "workspace-1",
  sessionId: "session-1",
};

function child(id: string, overrides: Partial<TreeSummaryNode> = {}): TreeSummaryNode {
  return {
    id,
    scope,
    treeType: "source",
    treeKey: "session-1",
    level: 1,
    title: `Child ${id}`,
    summary: `Grounded summary ${id}`,
    childNodeIds: [],
    leafIds: [`leaf-${id}`],
    evidenceChunkIds: [`evidence-${id}`],
    entityIds: [`entity-${id}`],
    relationIds: [`relation-${id}`],
    tokenCount: 20,
    timeRange: { startAt: 100, endAt: 200 },
    status: "sealed",
    createdAt: 200,
    sealedAt: 200,
    metadata: { summaryMode: "extractive" },
    ...overrides,
  };
}

describe("tree folding plan", () => {
  test("plans L1 -> L2 with deterministic identities and canonical child order", () => {
    const first = planTreeFolding({
      children: [child("b"), child("a")],
      targetLevel: 2,
      faithfulnessMode: "high_risk",
    });
    const replay = planTreeFolding({
      children: [child("a"), child("b"), child("a")],
      targetLevel: 2,
      faithfulnessMode: "high_risk",
    });

    expect(first).toEqual(replay);
    expect(first.childNodeIds).toEqual(["a", "b"]);
    expect(first.leafIds).toEqual(["leaf-a", "leaf-b"]);
    expect(first.evidenceChunkIds).toEqual(["evidence-a", "evidence-b"]);
    expect(first.parentBufferId).toMatch(/^fold-buffer:[0-9a-f]{64}$/);
    expect(first.parentNodeId).toMatch(/^fold-node:[0-9a-f]{64}$/);
    expect(first.dedupeKey).toMatch(/^tree-fold:[0-9a-f]{64}$/);
    expect(first.target).toMatchObject({ scope, treeType: "source", treeKey: "session-1", level: 2 });
  });

  test("folds governed L2 children to L3 and never plans beyond L3", () => {
    const plan = planTreeFolding({
      children: [child("l2", { level: 2 })],
      targetLevel: 3,
      faithfulnessMode: "always",
    });
    expect(plan.target.level).toBe(3);

    expect(() => planTreeFolding({
      children: [child("l3", { level: 3 })],
      targetLevel: 4 as 3,
      faithfulnessMode: "always",
    })).toThrowError(expect.objectContaining({ code: "TREE_FOLD_LEVEL_INVALID" }));
  });

  test("keeps only sealed children with a governed faithfulness receipt", () => {
    const plan = planTreeFolding({
      children: [
        child("good"),
        child("stale", { status: "stale" }),
        child("failed", { metadata: { summaryMode: "extractive", faithfulnessFailed: true } }),
        child("untrusted", { metadata: { summaryMode: "abstractive", faithfulnessUntrusted: true } }),
        child("unjudged", { metadata: { summaryMode: "abstractive" } }),
        child("empty-evidence", { evidenceChunkIds: [] }),
      ],
      targetLevel: 2,
      faithfulnessMode: "always",
    });

    expect(plan.childNodeIds).toEqual(["good"]);
    expect(plan.filtered).toEqual([
      { childNodeId: "empty-evidence", reason: "faithfulness_not_passed" },
      { childNodeId: "failed", reason: "faithfulness_not_passed" },
      { childNodeId: "stale", reason: "child_not_sealed" },
      { childNodeId: "unjudged", reason: "faithfulness_not_passed" },
      { childNodeId: "untrusted", reason: "faithfulness_not_passed" },
    ]);
  });

  test("fails closed when no eligible child remains", () => {
    expect(() => planTreeFolding({
      children: [child("stale", { status: "stale" })],
      targetLevel: 2,
      faithfulnessMode: "always",
    })).toThrowError(expect.objectContaining({ code: "TREE_FOLD_NO_ELIGIBLE_CHILDREN" }));
  });

  test("rejects mixed scope, tree identity, child level, and conflicting duplicate ids", () => {
    const cases: TreeSummaryNode[][] = [
      [child("a"), child("b", { scope: { ...scope, projectId: "other" } })],
      [child("a"), child("b", { treeType: "topic" })],
      [child("a"), child("b", { treeKey: "other" })],
      [child("a"), child("b", { level: 2 })],
      [child("same"), child("same", { summary: "conflicting summary" })],
    ];

    for (const children of cases) {
      expect(() => planTreeFolding({
        children,
        targetLevel: 2,
        faithfulnessMode: "always",
      })).toThrow(TreeFoldingPlanError);
    }
  });
});
