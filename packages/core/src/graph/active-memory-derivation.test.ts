import { describe, expect, test } from "vitest";

import type { MemoryScope } from "../domain/types.js";
import type { WriteMemoryRecord } from "../service/write-kernel.js";
import {
  ActiveMemoryDerivationError,
  deriveActiveMemoryProjections,
  type ActiveMemoryEvidenceFact,
  type ActiveMemoryTreeFacts,
} from "./active-memory-derivation.js";

type ContentRecord = Extract<WriteMemoryRecord, { mutation: "content" }>;

const scope: MemoryScope = {
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "mengshu",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "memory",
  workspaceId: "workspace-a",
  sessionId: "session-a",
  visibility: "workspace",
};

function record(
  id: string,
  route: ContentRecord["route"] = "active",
  overrides: Partial<ContentRecord> = {},
): ContentRecord {
  return {
    id,
    commandType: "saveExplicit",
    mutation: "content",
    scope,
    text: `memory ${id}`,
    metadata: { callerValueMustNotBecomeRoutingFacts: true },
    vector: [0.1, 0.2],
    route,
    valueScore: 0.92,
    importance: 0.9,
    kind: "decision",
    semanticType: "rules",
    confidence: 0.8,
    provenance: { source: "user", sourceId: "message-a", createdAt: 1_000 },
    evidenceIds: [`evidence-${id}`],
    governance: {
      candidate: { riskFlags: ["metadata-is-not-authority"] },
      admissionReason: "fixture",
    },
    createdAt: 1_000,
    ...overrides,
  };
}

function evidenceFact(
  evidenceId: string,
  overrides: Partial<ActiveMemoryEvidenceFact> = {},
): ActiveMemoryEvidenceFact {
  return {
    evidenceId,
    scope,
    evidenceKind: "message",
    label: `evidence ${evidenceId}`,
    metadata: { source: "conversation" },
    createdAt: 900,
    ...overrides,
  };
}

function treeFacts(
  memoryId: string,
  evidenceId = `evidence-${memoryId}`,
  overrides: Partial<ActiveMemoryTreeFacts> = {},
): ActiveMemoryTreeFacts {
  return {
    memoryId,
    scope,
    evidenceId,
    sourceId: "conversation-a",
    entityIds: ["entity-a"],
    scopeVisibility: "workspace",
    riskFlags: [],
    topicLabels: ["Runtime Architecture"],
    topicHotnessEligible: true,
    explicitGlobal: false,
    isWorkspaceRule: true,
    ...overrides,
  };
}

describe("active memory derivation projection", () => {
  test("只投影 route=active 且 ID 存在于 persisted activeMemoryIds 的记录", () => {
    const records = [
      record("active-selected"),
      record("active-not-persisted"),
      record("candidate", "candidate"),
      record("lookup", "lookup_only"),
      record("evidence", "evidence_only"),
    ];

    const result = deriveActiveMemoryProjections({
      records,
      activeMemoryIds: ["active-selected", "candidate", "lookup", "missing"],
      evidenceFacts: [evidenceFact("evidence-active-selected")],
      treeFacts: [treeFacts("active-selected")],
    });

    expect(result.projections.map((item) => item.memoryId)).toEqual(["active-selected"]);
  });

  test("生成保留 MemoryKind/semanticType 的 memory/evidence nodes 与逐 evidence grounded_by 边", () => {
    const active = record("memory-a", "active", {
      kind: "decision",
      semanticType: "rules",
      evidenceIds: ["evidence-a", "evidence-b"],
    });
    const result = deriveActiveMemoryProjections({
      records: [active],
      activeMemoryIds: [active.id],
      evidenceFacts: [evidenceFact("evidence-a"), evidenceFact("evidence-b")],
      treeFacts: [treeFacts(active.id, "evidence-a")],
    });

    const graph = result.projections[0]!.graph;
    expect(graph.status).toBe("available");
    if (graph.status !== "available") throw new Error("graph should be available");
    const memory = graph.batch.nodes.find((node) => node.nodeType === "memory");
    expect(memory).toMatchObject({
      nodeType: "memory",
      recordId: "memory-a",
      semanticType: "rules",
      lifecycleStatus: "active",
      evidenceChunkIds: ["evidence-a", "evidence-b"],
      metadata: { kind: "decision" },
    });
    expect(graph.batch.nodes.filter((node) => node.nodeType === "evidence"))
      .toHaveLength(2);
    expect(graph.batch.edges).toEqual([
      expect.objectContaining({
        predicate: "grounded_by",
        sourceId: memory!.id,
        targetId: expect.stringContaining("evidence:"),
        evidenceChunkIds: ["evidence-a"],
      }),
      expect.objectContaining({
        predicate: "grounded_by",
        sourceId: memory!.id,
        targetId: expect.stringContaining("evidence:"),
        evidenceChunkIds: ["evidence-b"],
      }),
    ]);
  });

  test("图导航 label 按 Unicode 字符确定性限制为 1000，权威正文仍留在 record/evidence", () => {
    const longMemoryText = `memory-${"😀".repeat(1_001)}`;
    const longEvidenceText = `evidence-${"证".repeat(1_001)}`;
    const active = record("memory-long", "active", { text: longMemoryText });
    const result = deriveActiveMemoryProjections({
      records: [active],
      activeMemoryIds: [active.id],
      evidenceFacts: [evidenceFact("evidence-memory-long", { label: longEvidenceText })],
      treeFacts: [],
    });

    const graph = result.projections[0]!.graph;
    expect(graph.status).toBe("available");
    if (graph.status !== "available") throw new Error("graph should be available");
    const memoryNode = graph.batch.nodes.find((node) => node.nodeType === "memory")!;
    const evidenceNode = graph.batch.nodes.find((node) => node.nodeType === "evidence")!;
    expect(Array.from(memoryNode.label)).toHaveLength(1_000);
    expect(Array.from(evidenceNode.label)).toHaveLength(1_000);
    expect(longMemoryText.startsWith(memoryNode.label)).toBe(true);
    expect(longEvidenceText.startsWith(evidenceNode.label)).toBe(true);
    expect(active.text).toBe(longMemoryText);
  });

  test("evidenceIds 为空或 evidence fact 缺失时 graph fail-closed 且不产出部分节点或边", () => {
    const noEvidence = record("no-evidence", "active", { evidenceIds: [] });
    const missingFact = record("missing-fact");
    const result = deriveActiveMemoryProjections({
      records: [noEvidence, missingFact],
      activeMemoryIds: [noEvidence.id, missingFact.id],
      evidenceFacts: [],
      treeFacts: [],
    });

    expect(result.projections.map((item) => item.graph)).toEqual([
      { status: "unavailable", reason: "evidence_ids_missing" },
      { status: "unavailable", reason: "evidence_fact_missing" },
    ]);
  });

  test("evidence 与 tree facts 必须按 record ID 和完整 scope 精确匹配", () => {
    const active = record("memory-a");
    const otherScope = { ...scope, projectId: "project-b" };
    const result = deriveActiveMemoryProjections({
      records: [active],
      activeMemoryIds: [active.id],
      evidenceFacts: [evidenceFact("evidence-memory-a", { scope: otherScope })],
      treeFacts: [treeFacts(active.id, undefined, { scope: otherScope })],
    });

    expect(result.projections[0]).toMatchObject({
      graph: { status: "unavailable", reason: "evidence_scope_mismatch" },
      tree: { status: "unavailable", reason: "tree_scope_mismatch" },
    });

    const wrongId = deriveActiveMemoryProjections({
      records: [active],
      activeMemoryIds: [active.id],
      evidenceFacts: [evidenceFact("evidence-memory-a")],
      treeFacts: [treeFacts("other-memory", "evidence-memory-a")],
    });
    expect(wrongId.projections[0]!.tree).toEqual({
      status: "unavailable",
      reason: "tree_facts_missing",
    });
  });

  test("缺 semanticType、importance 或任一显式 tree 必需事实时只关闭 tree", () => {
    const noSemanticType = record("no-semantic", "active", { semanticType: undefined });
    const noImportance = record("no-importance", "active", { importance: undefined });
    const requiredFacts = [
      "scopeVisibility", "riskFlags", "topicLabels", "topicHotnessEligible",
    ] as const;
    const incompleteRecords = requiredFacts.map((field) => record(`incomplete-${field}`));
    const incompleteFacts = incompleteRecords.map((item, index) => {
      const facts = treeFacts(item.id) as unknown as Record<string, unknown>;
      delete facts[requiredFacts[index]!];
      return facts as unknown as ActiveMemoryTreeFacts;
    });

    const result = deriveActiveMemoryProjections({
      records: [noSemanticType, noImportance, ...incompleteRecords],
      activeMemoryIds: [noSemanticType.id, noImportance.id, ...incompleteRecords.map(({ id }) => id)],
      evidenceFacts: [
        evidenceFact("evidence-no-semantic"),
        evidenceFact("evidence-no-importance"),
        ...incompleteRecords.map(({ id }) => evidenceFact(`evidence-${id}`)),
      ],
      treeFacts: [
        treeFacts(noSemanticType.id),
        treeFacts(noImportance.id),
        ...incompleteFacts,
      ],
    });

    expect(result.projections.every((item) => item.graph.status === "available")).toBe(true);
    expect(result.projections.map((item) => item.tree)).toEqual([
      { status: "unavailable", reason: "semantic_type_missing" },
      { status: "unavailable", reason: "importance_missing" },
      ...requiredFacts.map(() => ({
        status: "unavailable" as const,
        reason: "tree_routing_incomplete" as const,
      })),
    ]);
  });

  test("tree evidenceId 必须来自 active record 的真实 evidenceIds", () => {
    const active = record("memory-a");
    const result = deriveActiveMemoryProjections({
      records: [active],
      activeMemoryIds: [active.id],
      evidenceFacts: [evidenceFact("evidence-memory-a")],
      treeFacts: [treeFacts(active.id, "invented-evidence")],
    });

    expect(result.projections[0]!.tree).toEqual({
      status: "unavailable",
      reason: "tree_evidence_mismatch",
    });
  });

  test("产出完整 D-03 routing input 并复用三棵树 fan-out 计划", () => {
    const active = record("memory-a", "active", { valueScore: 0.92, importance: 0.9 });
    const facts = treeFacts(active.id);
    const result = deriveActiveMemoryProjections({
      records: [active],
      activeMemoryIds: [active.id],
      evidenceFacts: [evidenceFact("evidence-memory-a")],
      treeFacts: [facts],
    });

    const tree = result.projections[0]!.tree;
    expect(tree.status).toBe("available");
    if (tree.status !== "available") throw new Error("tree should be available");
    expect(tree.input.routing).toEqual({
      valueScore: 0.92,
      importance: 0.9,
      semanticType: "rules",
      scopeVisibility: "workspace",
      riskFlags: [],
      topicLabels: ["Runtime Architecture"],
      topicHotnessEligible: true,
      explicitGlobal: false,
      isWorkspaceRule: true,
    });
    expect(tree.input.leaf).toMatchObject({
      id: active.id,
      chunkId: "evidence-memory-a",
      sourceId: "conversation-a",
      entityIds: ["entity-a"],
      importance: 0.9,
      eventAt: active.createdAt,
      createdAt: active.createdAt,
      text: active.text,
    });
    expect(tree.plan.targets.map(({ treeType, treeKey }) => ({ treeType, treeKey })))
      .toEqual([
        { treeType: "source", treeKey: "conversation-a" },
        { treeType: "topic", treeKey: "runtime-architecture" },
        { treeType: "global", treeKey: "1970-01-01" },
      ]);
  });

  test("D-03 的 0.55-0.70 区间继续只生成 source tree，不改阈值", () => {
    const active = record("memory-a", "active", { valueScore: 0.6, importance: 0.9 });
    const result = deriveActiveMemoryProjections({
      records: [active],
      activeMemoryIds: [active.id],
      evidenceFacts: [evidenceFact("evidence-memory-a")],
      treeFacts: [treeFacts(active.id)],
    });
    const tree = result.projections[0]!.tree;

    expect(tree.status).toBe("available");
    if (tree.status !== "available") throw new Error("tree should be available");
    expect(tree.plan.targets.map((target) => target.treeType)).toEqual(["source"]);
  });

  test("结果是输入快照且深度不可变", () => {
    const active = record("memory-a");
    const evidence = evidenceFact("evidence-memory-a");
    const facts = treeFacts(active.id);
    const result = deriveActiveMemoryProjections({
      records: [active],
      activeMemoryIds: [active.id],
      evidenceFacts: [evidence],
      treeFacts: [facts],
    });
    (active.evidenceIds as string[]).push("late-evidence");
    (facts.riskFlags as string[]).push("late-risk");
    (evidence.metadata as Record<string, unknown>).late = true;

    const projection = result.projections[0]!;
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.projections)).toBe(true);
    expect(Object.isFrozen(projection)).toBe(true);
    expect(projection.graph.status).toBe("available");
    expect(projection.tree.status).toBe("available");
    if (projection.graph.status !== "available" || projection.tree.status !== "available") {
      throw new Error("projection should be available");
    }
    expect(projection.graph.batch.nodes.find((node) => node.nodeType === "memory"))
      .toMatchObject({ evidenceChunkIds: ["evidence-memory-a"] });
    expect(projection.tree.input.routing.riskFlags).toEqual([]);
    expect(Object.isFrozen(projection.graph.batch.nodes)).toBe(true);
    expect(Object.isFrozen(projection.tree.input.routing.riskFlags)).toBe(true);
  });

  test("重复 record、persisted ID 或 fact ID 直接拒绝，避免选择不确定输入", () => {
    const active = record("memory-a");
    const base = {
      records: [active],
      activeMemoryIds: [active.id],
      evidenceFacts: [evidenceFact("evidence-memory-a")],
      treeFacts: [treeFacts(active.id)],
    };

    expect(() => deriveActiveMemoryProjections({ ...base, records: [active, active] }))
      .toThrow(ActiveMemoryDerivationError);
    expect(() => deriveActiveMemoryProjections({ ...base, activeMemoryIds: [active.id, active.id] }))
      .toThrow(ActiveMemoryDerivationError);
    expect(() => deriveActiveMemoryProjections({
      ...base,
      treeFacts: [treeFacts(active.id), treeFacts(active.id)],
    })).toThrow(ActiveMemoryDerivationError);
  });
});
