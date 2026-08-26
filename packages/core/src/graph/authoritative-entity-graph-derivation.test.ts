import { describe, expect, test } from "vitest";

import type { MemoryScope } from "../domain/types.js";
import type { TreeFanOutRoutingInput } from "../tree/tree-fan-out.js";
import {
  deriveAuthoritativeEntityGraph,
  planCanonicalEntityTopicFanOut,
  type AuthoritativeEntityGraphInput,
} from "./authoritative-entity-graph-derivation.js";
import type { GraphEntityRecord, GraphRelationRecord } from "./types.js";

const scope: MemoryScope = Object.freeze({
  tenantId: "tenant", userId: "user", appId: "app", projectId: "project",
  agentId: "agent", namespace: "memory", visibility: "private",
  workspaceId: "workspace", sessionId: "session",
});

function entity(overrides: Partial<GraphEntityRecord> = {}): GraphEntityRecord {
  return {
    id: "entity-topic", scope, canonicalName: "runtime architecture",
    displayName: "Runtime Architecture", type: "topic",
    aliases: [" Runtime  Architecture ", "runtime architecture"],
    mentionCount: 20, mentionCount30d: 20, distinctSourceCount: 3,
    lastSeenAt: 1_720_000_000_000, hotness: 0, graphCentrality: 0.8,
    queryHits30d: 4, status: "active", createdAt: 1_720_000_000_000,
    updatedAt: 1_720_000_000_000, metadata: {}, ...overrides,
  };
}

function relation(overrides: Partial<GraphRelationRecord> = {}): GraphRelationRecord {
  return {
    id: "relation-1", scope, subjectId: "entity-topic", predicate: "related_to",
    objectId: "entity-tool", confidence: 0.8, evidenceChunkIds: ["evidence-1"],
    evidenceCount: 1, firstSeenAt: 1_720_000_000_000,
    lastSeenAt: 1_720_000_000_000, status: "active", sourceKinds: ["explicit_save"],
    metadata: {}, ...overrides,
  };
}

function input(overrides: Partial<AuthoritativeEntityGraphInput> = {}): AuthoritativeEntityGraphInput {
  return {
    graphKind: "entity",
    memoryId: "memory-1",
    evidence: {
      authority: "persisted_evidence",
      evidenceId: "evidence-1", scope, text: "Runtime Architecture uses PostgreSQL.",
      sourceId: "explicit-save-1", sourceKind: "explicit_save", createdAt: 1_720_000_000_000,
    },
    extraction: {
      entities: [
        entity(),
        entity({
          id: "entity-tool", canonicalName: "postgresql", displayName: "PostgreSQL",
          type: "tool", aliases: ["Postgres", " postgresql "],
        }),
      ],
      relations: [relation()],
    },
    ...overrides,
  };
}

describe("authoritative entity graph derivation", () => {
  test("只接受已持久化 evidence，并为 entity/relation/alias 生成完整幂等 ledger", () => {
    const result = deriveAuthoritativeEntityGraph(input());

    expect(result.entities).toHaveLength(2);
    expect(result).toMatchObject({
      evidenceSourceId: "explicit-save-1",
      evidenceSourceKind: "explicit_save",
      evidenceCreatedAt: 1_720_000_000_000,
    });
    expect(result.entityEvidenceLinks.map((link) => link.targetId)).toEqual([
      "entity-topic", "entity-tool",
    ]);
    expect(result.relationEvidenceLinks).toEqual([
      expect.objectContaining({ targetId: "relation-1", evidenceId: "evidence-1" }),
    ]);
    expect(result.aliasProjections).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityId: "entity-topic", normalizedAlias: "runtime architecture" }),
      expect.objectContaining({ entityId: "entity-tool", normalizedAlias: "postgres" }),
    ]));
    expect(new Set(result.aliasProjections.map((alias) => alias.id)).size)
      .toBe(result.aliasProjections.length);
    expect(deriveAuthoritativeEntityGraph(input())).toEqual(result);
  });

  test("evidence 缺失、scope 不一致或 relation 未绑定该 evidence 时 fail closed", () => {
    expect(() => deriveAuthoritativeEntityGraph(input({
      evidence: { ...input().evidence, text: "" },
    }))).toThrow(/evidence/i);
    expect(() => deriveAuthoritativeEntityGraph(input({
      evidence: { ...input().evidence, authority: "untrusted" } as never,
    }))).toThrow(/evidence/i);
    expect(() => deriveAuthoritativeEntityGraph(input({
      evidence: { ...input().evidence, scope: { ...scope, projectId: "other" } },
    }))).toThrow(/scope/i);
    expect(() => deriveAuthoritativeEntityGraph(input({
      extraction: { ...input().extraction, relations: [relation({ evidenceChunkIds: ["other"] })] },
    }))).toThrow(/evidence/i);
  });

  test("Entity Graph 与 Work Memory Graph/external CodeGraph 输入语义隔离", () => {
    expect(() => deriveAuthoritativeEntityGraph({ ...input(), graphKind: "work_memory" } as never))
      .toThrow(/graph kind/i);
    expect(() => deriveAuthoritativeEntityGraph({ ...input(), graphKind: "external_codegraph" } as never))
      .toThrow(/graph kind/i);
  });

  test("只有 receipt 覆盖的 canonical topic facts 可按现有 hotness 与 D-03/D-21 规划 topic tree", () => {
    const graph = deriveAuthoritativeEntityGraph(input());
    const routing: TreeFanOutRoutingInput = {
      valueScore: 0.75, importance: 0.8, semanticType: "experience",
      scopeVisibility: "project", riskFlags: [], topicHotnessEligible: false,
    };
    const projected = planCanonicalEntityTopicFanOut({
      memory: {
        memoryId: "memory-1", scope, text: "Runtime Architecture uses PostgreSQL.",
        evidenceId: "evidence-1", sourceId: "explicit-save-1", entityIds: graph.entities.map((item) => item.id),
        eventAt: 1_720_000_000_000, createdAt: 1_720_000_000_000, routing,
      },
      graphReceipt: {
        status: "applied", entityIds: graph.entities.map((item) => item.id),
        relationIds: graph.relations.map((item) => item.id), evidenceId: "evidence-1",
      },
      canonicalFactsAuthority: "graph_repository",
      canonicalEntities: graph.entities,
      entityEvidenceLinks: graph.entityEvidenceLinks,
      now: 1_720_000_000_000,
    });

    expect(projected.topicEntityIds).toEqual(["entity-tool", "entity-topic"]);
    expect(projected.plan.targets.map((target) => [target.treeType, target.treeKey])).toEqual([
      ["source", "explicit-save-1"],
      ["topic", "postgresql"],
      ["topic", "runtime-architecture"],
    ]);
    expect(projected.topicTargets.map((target) => [target.treeType, target.treeKey])).toEqual([
      ["topic", "postgresql"],
      ["topic", "runtime-architecture"],
    ]);
  });

  test("保留原生路由：任意满足 evidence、scope 与 hotness 的 canonical entity 均可贡献 topic-label", () => {
    const graph = deriveAuthoritativeEntityGraph(input());
    const projected = planCanonicalEntityTopicFanOut({
      memory: {
        memoryId: "memory-1", scope, text: "Runtime Architecture uses PostgreSQL.",
        evidenceId: "evidence-1", sourceId: "explicit-save-1", entityIds: ["entity-topic"],
        eventAt: 1_720_000_000_000, createdAt: 1_720_000_000_000,
        routing: {
          valueScore: 0.75, importance: 0.8, semanticType: "experience",
          scopeVisibility: "project", riskFlags: [], topicHotnessEligible: false,
        },
      },
      graphReceipt: {
        status: "applied", entityIds: ["entity-topic"], relationIds: ["relation-1"],
        evidenceId: "evidence-1",
      },
      canonicalFactsAuthority: "graph_repository",
      canonicalEntities: [entity({ type: "concept" })],
      entityEvidenceLinks: graph.entityEvidenceLinks,
      now: 1_720_000_000_000,
    });

    expect(projected.topicEntityIds).toEqual(["entity-topic"]);
    expect(projected.topicTargets.map((target) => [target.treeType, target.treeKey])).toEqual([
      ["topic", "runtime-architecture"],
    ]);
  });

  test("receipt/evidence 不匹配或 hotness 不足时不猜 topic", () => {
    const graph = deriveAuthoritativeEntityGraph(input());
    const base = {
      memory: {
        memoryId: "memory-1", scope, text: "Runtime Architecture uses PostgreSQL.",
        evidenceId: "evidence-1", sourceId: "explicit-save-1", entityIds: ["entity-topic"],
        eventAt: 1_720_000_000_000, createdAt: 1_720_000_000_000,
        routing: {
          valueScore: 0.75, importance: 0.8, semanticType: "experience" as const,
          scopeVisibility: "project" as const, riskFlags: [], topicHotnessEligible: false,
        },
      },
      graphReceipt: {
        status: "replayed" as const, entityIds: ["entity-topic"], relationIds: ["relation-1"],
        evidenceId: "evidence-1",
      },
      canonicalFactsAuthority: "graph_repository" as const,
      entityEvidenceLinks: graph.entityEvidenceLinks,
      now: 1_720_000_000_000,
    };

    const cold = planCanonicalEntityTopicFanOut({
      ...base,
      canonicalEntities: [entity({ mentionCount30d: 0, distinctSourceCount: 0,
        graphCentrality: 0, queryHits30d: 0, lastSeenAt: undefined })],
    });
    expect(cold.topicEntityIds).toEqual([]);

    const incompleteHotness = planCanonicalEntityTopicFanOut({
      ...base, canonicalEntities: [entity({ graphCentrality: undefined })],
    });
    expect(incompleteHotness.topicTargets).toEqual([]);

    const wrongMemoryLink = planCanonicalEntityTopicFanOut({
      ...base,
      canonicalEntities: [entity()],
      entityEvidenceLinks: graph.entityEvidenceLinks.map((link) => ({
        ...link, memoryId: "other-memory",
      })),
    });
    expect(wrongMemoryLink.topicTargets).toEqual([]);

    expect(() => planCanonicalEntityTopicFanOut({
      ...base, canonicalEntities: [entity()],
      graphReceipt: { ...base.graphReceipt, evidenceId: "other" },
    })).toThrow(/receipt/i);
    expect(() => planCanonicalEntityTopicFanOut({
      ...base, canonicalEntities: [entity()], canonicalFactsAuthority: "untrusted" as never,
    })).toThrow(/authority/i);
  });
});
