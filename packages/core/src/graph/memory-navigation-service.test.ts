import { describe, expect, test, vi } from "vitest";

import { InMemoryGraphRepository } from "./repository.js";
import { MemoryNavigationService } from "./memory-navigation-service.js";
import type { WorkMemoryGraphBatch } from "./work-memory-types.js";

const scope = {
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "codex",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "memory",
  visibility: "private" as const,
};

const batch: WorkMemoryGraphBatch = {
  scope,
  nodes: [
    {
      id: "evidence:evidence-1",
      scope,
      nodeType: "evidence",
      recordId: "evidence-1",
      evidenceKind: "message",
      label: "source message",
      metadata: {},
      createdAt: 1,
    },
    {
      id: "memory:memory-1",
      scope,
      nodeType: "memory",
      recordId: "memory-1",
      semanticType: "rules",
      lifecycleStatus: "active",
      evidenceChunkIds: ["evidence-1"],
      label: "must use evidence",
      metadata: {},
      createdAt: 2,
    },
    {
      id: "summary:topic-1",
      scope,
      nodeType: "summary",
      recordId: "topic-1",
      treeType: "topic",
      level: 2,
      evidenceChunkIds: ["evidence-1"],
      label: "topic summary",
      metadata: {},
      createdAt: 3,
    },
  ],
  edges: [
    {
      id: "edge-grounded",
      scope,
      edgeType: "memory_relation",
      predicate: "grounded_by",
      sourceId: "memory:memory-1",
      targetId: "evidence:evidence-1",
      confidence: 1,
      evidenceChunkIds: ["evidence-1"],
      metadata: {},
      createdAt: 2,
    },
    {
      id: "edge-derived",
      scope,
      edgeType: "memory_relation",
      predicate: "derives_from",
      sourceId: "summary:topic-1",
      targetId: "memory:memory-1",
      confidence: 1,
      evidenceChunkIds: ["evidence-1"],
      metadata: {},
      createdAt: 3,
    },
  ],
};

describe("MemoryNavigationService", () => {
  test("navigates from an authoritative memory record to tree and real R4 evidence refs", async () => {
    const repository = new InMemoryGraphRepository();
    await repository.upsertWorkMemoryGraph(batch);
    const service = new MemoryNavigationService({ repository });

    await expect(service.navigate(scope, { ref: "memory-1", level: "R0", limit: 20 }))
      .resolves.toEqual([
        expect.objectContaining({ ref: "topic-1", kind: "topic_tree", level: "R2" }),
        expect.objectContaining({ ref: "evidence-1", kind: "evidence", level: "R4" }),
      ]);
  });

  test("reads evidence only after every ref resolves to an exact-scope evidence graph node", async () => {
    const repository = new InMemoryGraphRepository();
    await repository.upsertWorkMemoryGraph(batch);
    const read = vi.fn(async () => [{
      ref: "evidence-1",
      preview: "escaped evidence",
      source: "message" as const,
    }]);
    const service = new MemoryNavigationService({ repository, evidenceContent: { read } });

    await expect(service.readEvidence(scope, ["evidence-1"]))
      .resolves.toEqual([{ ref: "evidence-1", preview: "escaped evidence", source: "message" }]);
    expect(read).toHaveBeenCalledWith(scope, [{ ref: "evidence-1", source: "message" }]);
    await expect(service.readEvidence(scope, ["memory-1"]))
      .rejects.toThrow("MEMORY_EVIDENCE_REFERENCE_INVALID");
  });

  test("fails closed for cross-scope, missing, duplicate and unavailable evidence", async () => {
    const repository = new InMemoryGraphRepository();
    await repository.upsertWorkMemoryGraph(batch);
    const service = new MemoryNavigationService({ repository });

    await expect(service.navigate({ ...scope, projectId: "other" }, {
      ref: "memory-1", level: "R0", limit: 20,
    })).rejects.toThrow("MEMORY_NAVIGATION_REFERENCE_NOT_FOUND");
    await expect(service.readEvidence(scope, ["evidence-1", "evidence-1"]))
      .rejects.toThrow("MEMORY_EVIDENCE_REFERENCE_INVALID");
    await expect(service.readEvidence(scope, ["evidence-1"]))
      .rejects.toThrow("MEMORY_EVIDENCE_CONTENT_UNAVAILABLE");
  });
});
