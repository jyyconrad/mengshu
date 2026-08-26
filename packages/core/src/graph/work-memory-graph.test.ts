import { describe, expect, test } from "vitest";

import { InMemoryGraphRepository } from "./repository.js";
import { WorkMemoryGraphQueryService } from "./work-memory-query.js";
import type {
  EvidenceGraphNode,
  MemoryNode,
  SkillCandidateGraphNode,
  SummaryGraphNode,
  WorkMemoryEdge,
  WorkMemoryGraphNode,
} from "./work-memory-types.js";

const scope = {
  tenantId: "local",
  appId: "openclaw",
  userId: "user-1",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "memory",
};

const otherScope = {
  ...scope,
  projectId: "project-2",
};

const now = 1_710_000_000_000;

function evidence(id: string, recordScope = scope): EvidenceGraphNode {
  return {
    id: `evidence:${id}`,
    scope: recordScope,
    nodeType: "evidence",
    recordId: id,
    evidenceKind: "chunk",
    label: id,
    metadata: {},
    createdAt: now,
  };
}

function memory(id: string, evidenceChunkIds = ["chunk-1"], recordScope = scope): MemoryNode {
  return {
    id: `memory:${id}`,
    scope: recordScope,
    nodeType: "memory",
    recordId: id,
    semanticType: "experience",
    lifecycleStatus: "active",
    evidenceChunkIds,
    label: id,
    metadata: {},
    createdAt: now,
  };
}

function summary(id: string): SummaryGraphNode {
  return {
    id: `summary:${id}`,
    scope,
    nodeType: "summary",
    recordId: id,
    treeType: "topic",
    level: 2,
    evidenceChunkIds: ["chunk-1"],
    label: id,
    metadata: {},
    createdAt: now,
  };
}

function skillCandidate(id: string): SkillCandidateGraphNode {
  return {
    id: `skill-candidate:${id}`,
    scope,
    nodeType: "skill_candidate",
    recordId: id,
    status: "pending",
    evidenceMemoryIds: ["new"],
    evidenceChunkIds: ["chunk-1"],
    label: id,
    metadata: {},
    createdAt: now,
  };
}

function edge(
  id: string,
  predicate: WorkMemoryEdge["predicate"],
  sourceId: string,
  targetId: string,
  evidenceChunkIds = ["chunk-1"],
): WorkMemoryEdge {
  return {
    id,
    scope,
    edgeType: "memory_relation",
    predicate,
    sourceId,
    targetId,
    confidence: 0.9,
    evidenceChunkIds,
    metadata: {},
    createdAt: now,
  };
}

function graphNodes(): WorkMemoryGraphNode[] {
  return [
    evidence("chunk-1"),
    memory("old"),
    memory("new"),
    summary("topic"),
    skillCandidate("review"),
  ];
}

describe("Work Memory Graph contract", () => {
  test("persists the native memory evolution relations without mixing entity graph semantics", async () => {
    const repository = new InMemoryGraphRepository();
    const edges = [
      edge("edge-grounded", "grounded_by", "memory:new", "evidence:chunk-1"),
      edge("edge-derived", "derives_from", "summary:topic", "memory:old"),
      edge("edge-conflict", "contradicts", "memory:new", "memory:old"),
      edge("edge-supersedes", "supersedes", "memory:new", "memory:old"),
      edge("edge-promoted", "promoted_to", "memory:new", "skill-candidate:review"),
    ];

    await repository.upsertWorkMemoryGraph({ scope, nodes: graphNodes(), edges });

    await expect(repository.findWorkMemoryNodes({ scope })).resolves.toHaveLength(5);
    await expect(repository.findWorkMemoryEdges({ scope })).resolves.toEqual(
      [...edges].sort((left, right) => left.id.localeCompare(right.id)),
    );
    await expect(repository.findEntities({ scope })).resolves.toEqual([]);
    await expect(repository.findRelations({ scope })).resolves.toEqual([]);
  });

  test("validates the whole batch before mutation and rejects illegal relation endpoints", async () => {
    const repository = new InMemoryGraphRepository();

    await expect(repository.upsertWorkMemoryGraph({
      scope,
      nodes: graphNodes(),
      edges: [edge("bad-promotion", "promoted_to", "summary:topic", "skill-candidate:review")],
    })).rejects.toThrow(/promoted_to/i);

    await expect(repository.findWorkMemoryNodes({ scope })).resolves.toEqual([]);
    await expect(repository.findWorkMemoryEdges({ scope })).resolves.toEqual([]);
  });

  test("rejects missing evidence, cross-scope nodes, and dangling endpoints", async () => {
    const repository = new InMemoryGraphRepository();

    await expect(repository.upsertWorkMemoryGraph({
      scope,
      nodes: [memory("no-evidence", [])],
      edges: [],
    })).rejects.toThrow(/evidence/i);

    await expect(repository.upsertWorkMemoryGraph({
      scope,
      nodes: [memory("cross-scope", ["chunk-1"], otherScope)],
      edges: [],
    })).rejects.toThrow(/scope/i);

    await expect(repository.upsertWorkMemoryGraph({
      scope,
      nodes: [evidence("chunk-1"), memory("dangling")],
      edges: [edge("dangling", "contradicts", "memory:dangling", "memory:missing")],
    })).rejects.toThrow(/endpoint/i);

    await expect(repository.upsertWorkMemoryGraph({
      scope,
      nodes: [memory("unresolved", ["missing-chunk"])],
      edges: [],
    })).rejects.toThrow(/resolve.*evidence/i);

    await expect(repository.upsertWorkMemoryGraph({
      scope,
      nodes: graphNodes(),
      edges: [edge("unresolved-edge", "contradicts", "memory:new", "memory:old", ["missing-chunk"])],
    })).rejects.toThrow(/resolve.*evidence/i);

    await expect(repository.upsertWorkMemoryGraph({
      scope,
      nodes: [{ ...evidence("chunk-1"), label: "x".repeat(1_001) }],
      edges: [],
    })).rejects.toThrow(/label/i);
  });

  test("isolates work-memory queries by explicit intent, scope, and evidence trail", async () => {
    const repository = new InMemoryGraphRepository();
    await repository.upsertWorkMemoryGraph({
      scope,
      nodes: graphNodes(),
      edges: [
        edge("edge-grounded", "grounded_by", "memory:new", "evidence:chunk-1"),
        edge("edge-derived", "derives_from", "summary:topic", "memory:new"),
      ],
    });
    await repository.upsertWorkMemoryGraph({
      scope: otherScope,
      nodes: [evidence("other-chunk", otherScope), memory("new", ["other-chunk"], otherScope)],
      edges: [],
    });
    const service = new WorkMemoryGraphQueryService(repository);

    const result = await service.query({
      intent: "work_memory",
      scope,
      nodeId: "memory:new",
      depth: 2,
    });

    expect(result.intent).toBe("work_memory");
    expect(result.nodes.map((node) => node.id).sort()).toEqual([
      "evidence:chunk-1",
      "memory:new",
      "summary:topic",
    ]);
    expect(result.edges.map((item) => item.id).sort()).toEqual(["edge-derived", "edge-grounded"]);
    expect(result.evidenceChunkIds).toEqual(["chunk-1"]);
    await expect(repository.getWorkMemoryNode("memory:new", otherScope)).resolves.toMatchObject({
      scope: otherScope,
      evidenceChunkIds: ["other-chunk"],
    });
  });
});
