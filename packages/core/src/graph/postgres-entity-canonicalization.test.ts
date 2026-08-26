import { describe, expect, test, vi } from "vitest";

import type { MemoryScope } from "../domain/types.js";
import { deriveAuthoritativeEntityGraph } from "./authoritative-entity-graph-derivation.js";
import {
  canonicalizeAuthoritativeEntityGraphWithClient,
  persistEntityCanonicalizationPlanWithClient,
  snapshotEntityGraphEmbeddingBatch,
  type EntityGraphEmbeddingBatch,
  type PostgresEntityCanonicalizationClient,
} from "./postgres-entity-canonicalization.js";
import type { GraphEntityRecord, GraphRelationRecord } from "./types.js";

const scope: MemoryScope = Object.freeze({
  tenantId: "tenant", userId: "user", appId: "app", projectId: "project",
  agentId: "agent", namespace: "memory", visibility: "private",
  workspaceId: "workspace", sessionId: "session",
});

function entity(
  id: string,
  canonicalName: string,
  type: GraphEntityRecord["type"],
  aliases: string[] = [],
): GraphEntityRecord {
  return {
    id, scope, canonicalName, displayName: canonicalName, type, aliases,
    mentionCount: 1, mentionCount30d: 1, distinctSourceCount: 1,
    lastSeenAt: 100, hotness: 0, graphCentrality: 0, queryHits30d: 0,
    status: "active", createdAt: 100, updatedAt: 100, metadata: {},
  };
}

function relation(
  id: string,
  subjectId: string,
  objectId: string,
  evidenceId = "evidence-2",
): GraphRelationRecord {
  return {
    id, scope, subjectId, predicate: "uses", objectId, confidence: 0.9,
    evidenceChunkIds: [evidenceId], evidenceCount: 1,
    firstSeenAt: 100, lastSeenAt: 100, status: "active",
    sourceKinds: ["llm"], metadata: {},
  };
}

function graph() {
  return deriveAuthoritativeEntityGraph({
    graphKind: "entity", memoryId: "memory-2",
    evidence: {
      authority: "persisted_evidence", evidenceId: "evidence-2", scope,
      text: "Mengshu 使用 PG 作为数据库。", sourceId: "message-2",
      sourceKind: "agent-fast-path", createdAt: 100,
    },
    extraction: {
      entities: [
        entity("raw-project", "mengshu", "project", ["Mengshu"]),
        entity("raw-pg", "pg", "tool", ["PG"]),
      ],
      relations: [relation("raw-relation", "raw-project", "raw-pg")],
    },
  });
}

const embeddings: EntityGraphEmbeddingBatch = Object.freeze({
  authority: "runtime_active_embedding_space",
  embeddingSpaceId: `embedding-space:v1:${"a".repeat(64)}`,
  embeddingSpaceState: "known-queryable",
  vectors: Object.freeze([
    Object.freeze({ rawEntityId: "raw-project", vector: Object.freeze([1, 0, 0]) }),
    Object.freeze({ rawEntityId: "raw-pg", vector: Object.freeze([0, 1, 0]) }),
  ]),
});

function existingRow(overrides: Record<string, unknown>) {
  return {
    id: "canonical-postgresql", canonical_name: "postgresql",
    display_name: "PostgreSQL", entity_type: "tool", status: "active",
    ...overrides,
  };
}

describe("Postgres authoritative Entity Graph canonicalization", () => {
  test("同一 transaction 内按稳定顺序加锁并执行 exact -> alias -> semantic", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [{ locked: "" }], rowCount: 1 };
      if (sql.includes("canonical_name =") && params.at(-1) === "postgresql") {
        return { rows: [existingRow({})], rowCount: 1 };
      }
      if (sql.includes("mengshu_graph_entity_alias_bindings")) return { rows: [], rowCount: 0 };
      if (sql.includes("mengshu_graph_entity_embeddings") && sql.includes("<=>")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });
    const client = { query } as PostgresEntityCanonicalizationClient;

    const result = await canonicalizeAuthoritativeEntityGraphWithClient(client, {
      jobId: "job-2", graph: graph(), embeddings,
    });

    expect(result.graph.entities.map((item) => item.id)).toEqual([
      "raw-project", "canonical-postgresql",
    ]);
    expect(result.graph.relations).toHaveLength(1);
    expect(result.graph.relations[0]).toMatchObject({
      subjectId: "raw-project", objectId: "canonical-postgresql",
    });
    expect(result.graph.relations[0]?.id).not.toBe("raw-relation");
    expect(result.graph.entityEvidenceLinks.map((link) => link.targetId)).toEqual([
      "raw-project", "canonical-postgresql",
    ]);
    expect(result.graph.relationEvidenceLinks[0]?.targetId)
      .toBe(result.graph.relations[0]?.id);
    expect(result.graph.aliasProjections
      .filter((alias) => alias.normalizedAlias === "pg")
      .map((alias) => alias.entityId)).toEqual(["canonical-postgresql"]);
    expect(result.entityResolutions).toEqual([
      expect.objectContaining({ rawEntityId: "raw-project", method: "create" }),
      expect.objectContaining({
        rawEntityId: "raw-pg", canonicalEntityId: "canonical-postgresql", method: "alias",
      }),
    ]);
    const lockKeys = calls.filter(({ sql }) => sql.includes("pg_advisory_xact_lock"))
      .map(({ params }) => params[0]);
    expect(lockKeys).toEqual([...lockKeys].sort());
    expect(lockKeys.every((key) => typeof key === "string" && !key.includes("\0"))).toBe(true);
    expect(calls.every(({ params }) => !params.includes("session-other"))).toBe(true);
  });

  test("semantic 阈值复用原 entity resolver；person/file 不执行 ANN", async () => {
    const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [{ locked: "" }], rowCount: 1 };
      if (sql.includes("canonical_name =") || sql.includes("entity_alias_bindings")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("<=>") && params.includes("project")) {
        return {
          rows: [{
            ...existingRow({ id: "canonical-mengshu", canonical_name: "mengshu project",
              display_name: "Mengshu Project", entity_type: "project" }),
            similarity: 0.91,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const semanticGraph = deriveAuthoritativeEntityGraph({
      graphKind: "entity", memoryId: "memory-semantic",
      evidence: {
        authority: "persisted_evidence", evidenceId: "evidence-semantic", scope,
        text: "Mengshu project and README.md", sourceId: "message-semantic",
        sourceKind: "agent-fast-path", createdAt: 100,
      },
      extraction: {
        entities: [
          entity("raw-project", "mengshu", "project"),
          entity("raw-file", "README.md", "file"),
        ],
        relations: [],
      },
    });
    const semanticEmbeddings: EntityGraphEmbeddingBatch = {
      ...embeddings,
      vectors: [
        { rawEntityId: "raw-project", vector: [1, 0, 0] },
        { rawEntityId: "raw-file", vector: [0, 0, 1] },
      ],
    };

    const result = await canonicalizeAuthoritativeEntityGraphWithClient(
      { query } as PostgresEntityCanonicalizationClient,
      { jobId: "job-semantic", graph: semanticGraph, embeddings: semanticEmbeddings },
    );

    expect(result.entityResolutions).toEqual([
      expect.objectContaining({
        rawEntityId: "raw-project", canonicalEntityId: "canonical-mengshu",
        method: "semantic", similarity: 0.91,
      }),
      expect.objectContaining({ rawEntityId: "raw-file", method: "create" }),
    ]);
    const annCalls = query.mock.calls.filter(([sql]) => String(sql).includes("<=>"));
    expect(annCalls).toHaveLength(1);
    expect(annCalls[0]?.[1]).toContain("project");
  });

  test("semantic review band 保留新实体并规划有 evidence 的 weak related_to", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [{ locked: "" }], rowCount: 1 };
      if (sql.includes("canonical_name =") || sql.includes("entity_alias_bindings")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("<=>")) {
        return {
          rows: [{
            ...existingRow({ id: "canonical-related", canonical_name: "memory platform",
              display_name: "Memory Platform", entity_type: "project" }),
            similarity: 0.85,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const inputGraph = deriveAuthoritativeEntityGraph({
      graphKind: "entity", memoryId: "memory-related",
      evidence: {
        authority: "persisted_evidence", evidenceId: "evidence-related", scope,
        text: "Mengshu memory project", sourceId: "message-related",
        sourceKind: "agent-fast-path", createdAt: 100,
      },
      extraction: { entities: [entity("raw-related", "mengshu", "project")], relations: [] },
    });
    const batch: EntityGraphEmbeddingBatch = {
      ...embeddings,
      vectors: [{ rawEntityId: "raw-related", vector: [1, 0, 0] }],
    };

    const result = await canonicalizeAuthoritativeEntityGraphWithClient(
      { query } as PostgresEntityCanonicalizationClient,
      { jobId: "job-related", graph: inputGraph, embeddings: batch },
    );

    expect(result.graph.entities.map((item) => item.id)).toEqual(["raw-related"]);
    expect(result.entityResolutions).toEqual([
      expect.objectContaining({ rawEntityId: "raw-related", method: "create" }),
    ]);
    expect(result.entityResolutions[0]).not.toHaveProperty("similarity");
    expect(result.relatedRelations).toEqual([
      expect.objectContaining({
        subjectId: "raw-related", predicate: "related_to",
        objectId: "canonical-related", confidence: 0.85, status: "weak",
      }),
    ]);
    expect(result.relatedRelationEvidenceLinks).toEqual([
      expect.objectContaining({ evidenceId: "evidence-related", targetKind: "relation" }),
    ]);
  });

  test("pgvector cosine NULL 视为不可比较并走 create", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [{ locked: "" }], rowCount: 1 };
      if (sql.includes("canonical_name =") || sql.includes("entity_alias_bindings")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("<=>")) {
        return {
          rows: [{
            ...existingRow({ id: "zero-vector-candidate", canonical_name: "memory platform",
              display_name: "Memory Platform", entity_type: "project" }),
            similarity: null,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const inputGraph = deriveAuthoritativeEntityGraph({
      graphKind: "entity", memoryId: "memory-null-similarity",
      evidence: {
        authority: "persisted_evidence", evidenceId: "evidence-null-similarity", scope,
        text: "Mengshu memory project", sourceId: "message-null-similarity",
        sourceKind: "agent-fast-path", createdAt: 100,
      },
      extraction: { entities: [entity("raw-null", "mengshu", "project")], relations: [] },
    });

    const result = await canonicalizeAuthoritativeEntityGraphWithClient(
      { query } as PostgresEntityCanonicalizationClient,
      {
        jobId: "job-null-similarity", graph: inputGraph,
        embeddings: {
          ...embeddings,
          vectors: [{ rawEntityId: "raw-null", vector: [1, 0, 0] }],
        },
      },
    );

    expect(result.graph.entities).toEqual([
      expect.objectContaining({ id: "raw-null", canonicalName: "mengshu" }),
    ]);
    expect(result.entityResolutions).toEqual([
      expect.objectContaining({ rawEntityId: "raw-null", method: "create" }),
    ]);
    expect(result.entityResolutions[0]).not.toHaveProperty("similarity");
    expect(result.relatedRelations).toEqual([]);
  });

  test("零范数 embedding 在任何 SQL 前 fail closed", () => {
    const zeroVectorBatch: EntityGraphEmbeddingBatch = {
      ...embeddings,
      vectors: [
        { rawEntityId: "raw-project", vector: [0, 0, 0] },
        { rawEntityId: "raw-pg", vector: [0, 1, 0] },
      ],
    };

    expect(() => snapshotEntityGraphEmbeddingBatch(graph(), zeroVectorBatch))
      .toThrow("embedding batch is invalid");
  });

  test("同批同 type/canonicalName 先本地聚合，不产生第二个 canonical identity", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [{ locked: "" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const duplicateGraph = deriveAuthoritativeEntityGraph({
      graphKind: "entity", memoryId: "memory-local-exact",
      evidence: {
        authority: "persisted_evidence", evidenceId: "evidence-local-exact", scope,
        text: "Mengshu and MENGSHU", sourceId: "message-local-exact",
        sourceKind: "agent-fast-path", createdAt: 100,
      },
      extraction: {
        entities: [
          entity("raw-first", "mengshu", "project"),
          entity("raw-second", "mengshu", "project", ["MENGSHU"]),
        ],
        relations: [],
      },
    });
    const batch: EntityGraphEmbeddingBatch = {
      ...embeddings,
      vectors: [
        { rawEntityId: "raw-first", vector: [1, 0] },
        { rawEntityId: "raw-second", vector: [1, 0] },
      ],
    };

    const result = await canonicalizeAuthoritativeEntityGraphWithClient(
      { query } as PostgresEntityCanonicalizationClient,
      { jobId: "job-local-exact", graph: duplicateGraph, embeddings: batch },
    );

    expect(result.graph.entities.map((item) => item.id)).toEqual(["raw-first"]);
    expect(result.entityResolutions.map((item) => [item.rawEntityId, item.canonicalEntityId, item.method]))
      .toEqual([
        ["raw-first", "raw-first", "create"],
        ["raw-second", "raw-first", "exact"],
      ]);
    expect(query.mock.calls.filter(([sql]) => String(sql).includes("canonical_name =")))
      .toHaveLength(1);
  });

  test("同批 canonical tool 后续 built-in alias 命中本地 identity，命中即停", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [{ locked: "" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const aliasGraph = deriveAuthoritativeEntityGraph({
      graphKind: "entity", memoryId: "memory-local-alias",
      evidence: {
        authority: "persisted_evidence", evidenceId: "evidence-local-alias", scope,
        text: "PostgreSQL is also called PG", sourceId: "message-local-alias",
        sourceKind: "agent-fast-path", createdAt: 100,
      },
      extraction: {
        entities: [
          entity("raw-postgresql", "postgresql", "tool"),
          entity("raw-pg", "pg", "tool"),
        ],
        relations: [],
      },
    });
    const batch: EntityGraphEmbeddingBatch = {
      ...embeddings,
      vectors: [
        { rawEntityId: "raw-postgresql", vector: [1, 0] },
        { rawEntityId: "raw-pg", vector: [1, 0] },
      ],
    };

    const result = await canonicalizeAuthoritativeEntityGraphWithClient(
      { query } as PostgresEntityCanonicalizationClient,
      { jobId: "job-local-alias", graph: aliasGraph, embeddings: batch },
    );

    expect(result.graph.entities.map((item) => item.id)).toEqual(["raw-postgresql"]);
    expect(result.entityResolutions.map((item) => [item.rawEntityId, item.canonicalEntityId, item.method]))
      .toEqual([
        ["raw-postgresql", "raw-postgresql", "create"],
        ["raw-pg", "raw-postgresql", "alias"],
      ]);
    expect(query.mock.calls.filter(([sql]) => String(sql).includes("<=>"))).toHaveLength(1);
  });

  test("同批 built-in alias 先出现时仍归一 canonical identity", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [{ locked: "" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const aliasFirstGraph = deriveAuthoritativeEntityGraph({
      graphKind: "entity", memoryId: "memory-local-alias-first",
      evidence: {
        authority: "persisted_evidence", evidenceId: "evidence-local-alias-first", scope,
        text: "PG is PostgreSQL", sourceId: "message-local-alias-first",
        sourceKind: "agent-fast-path", createdAt: 100,
      },
      extraction: {
        entities: [
          entity("raw-pg", "pg", "tool"),
          entity("raw-postgresql", "postgresql", "tool"),
        ],
        relations: [],
      },
    });
    const batch: EntityGraphEmbeddingBatch = {
      ...embeddings,
      vectors: [
        { rawEntityId: "raw-pg", vector: [1, 0] },
        { rawEntityId: "raw-postgresql", vector: [1, 0] },
      ],
    };

    const result = await canonicalizeAuthoritativeEntityGraphWithClient(
      { query } as PostgresEntityCanonicalizationClient,
      { jobId: "job-local-alias-first", graph: aliasFirstGraph, embeddings: batch },
    );

    expect(result.graph.entities).toEqual([
      expect.objectContaining({ id: "raw-pg", canonicalName: "postgresql", type: "tool" }),
    ]);
    expect(result.entityResolutions.map((item) => [item.rawEntityId, item.canonicalEntityId, item.method]))
      .toEqual([
        ["raw-pg", "raw-pg", "create"],
        ["raw-postgresql", "raw-pg", "exact"],
      ]);
    expect(result.aliasBindings.map((binding) => binding.normalizedAlias))
      .toEqual(expect.arrayContaining(["pg", "postgresql"]));
  });

  test("alias binding identity 同 activation 可重放、跨 activation 使用新 generation", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [{ locked: "" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const client = { query } as PostgresEntityCanonicalizationClient;

    const first = await canonicalizeAuthoritativeEntityGraphWithClient(client, {
      jobId: "job-generation-a", graph: graph(), embeddings,
    });
    const replay = await canonicalizeAuthoritativeEntityGraphWithClient(client, {
      jobId: "job-generation-a", graph: graph(), embeddings,
    });
    const nextActivation = await canonicalizeAuthoritativeEntityGraphWithClient(client, {
      jobId: "job-generation-b", graph: graph(), embeddings,
    });

    expect(replay.aliasBindings.map(({ bindingId }) => bindingId))
      .toEqual(first.aliasBindings.map(({ bindingId }) => bindingId));
    expect(nextActivation.aliasBindings.map(({ bindingId }) => bindingId))
      .not.toEqual(first.aliasBindings.map(({ bindingId }) => bindingId));
  });

  test("显式 related_to 与 review-band 投影同 ID 时只保留显式 active 关系", async () => {
    const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [{ locked: "" }], rowCount: 1 };
      if (sql.includes("canonical_name =") && params.at(-1) === "memory platform") {
        return { rows: [existingRow({
          id: "canonical-related", canonical_name: "memory platform",
          display_name: "Memory Platform", entity_type: "project",
        })], rowCount: 1 };
      }
      if (sql.includes("canonical_name =") || sql.includes("entity_alias_bindings")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("<=>")) {
        return {
          rows: [{
            ...existingRow({
              id: "canonical-related", canonical_name: "memory platform",
              display_name: "Memory Platform", entity_type: "project",
            }),
            similarity: 0.85,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const explicitRelatedGraph = deriveAuthoritativeEntityGraph({
      graphKind: "entity", memoryId: "memory-explicit-related",
      evidence: {
        authority: "persisted_evidence", evidenceId: "evidence-explicit-related", scope,
        text: "Mengshu is related to Memory Platform", sourceId: "message-explicit-related",
        sourceKind: "agent-fast-path", createdAt: 100,
      },
      extraction: {
        entities: [
          entity("raw-new", "mengshu", "project"),
          entity("raw-existing", "memory platform", "project"),
        ],
        relations: [{
          ...relation("raw-explicit-related", "raw-new", "raw-existing", "evidence-explicit-related"),
          predicate: "related_to",
          status: "active",
        }],
      },
    });
    const batch: EntityGraphEmbeddingBatch = {
      ...embeddings,
      vectors: [
        { rawEntityId: "raw-new", vector: [1, 0] },
        { rawEntityId: "raw-existing", vector: [0, 1] },
      ],
    };

    const result = await canonicalizeAuthoritativeEntityGraphWithClient(
      { query } as PostgresEntityCanonicalizationClient,
      { jobId: "job-explicit-related", graph: explicitRelatedGraph, embeddings: batch },
    );

    expect(result.graph.relations).toEqual([
      expect.objectContaining({
        subjectId: "raw-new", predicate: "related_to",
        objectId: "canonical-related", status: "active",
      }),
    ]);
    expect(result.relatedRelations).toEqual([]);
    expect(result.relatedRelationEvidenceLinks).toEqual([]);
    expect(result.relationResolutions).toEqual([
      expect.objectContaining({
        rawRelationId: "raw-explicit-related", outcome: "canonicalized",
      }),
    ]);
  });

  test("canonical merge 形成 self-edge 时记录 dropped_self，且不写伪 relation", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [{ locked: "" }], rowCount: 1 };
      if (sql.includes("canonical_name =")) {
        return { rows: [existingRow({ id: "same", canonical_name: "postgresql" })], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const duplicateEndpoints = deriveAuthoritativeEntityGraph({
      graphKind: "entity", memoryId: "memory-self",
      evidence: {
        authority: "persisted_evidence", evidenceId: "evidence-self", scope,
        text: "PostgreSQL 即 postgres", sourceId: "message-self",
        sourceKind: "agent-fast-path", createdAt: 100,
      },
      extraction: {
        entities: [
          entity("raw-a", "postgresql", "tool"),
          entity("raw-b", "postgresql", "tool", ["postgres"]),
        ],
        relations: [relation("raw-self", "raw-a", "raw-b", "evidence-self")],
      },
    });
    const batch = { ...embeddings, vectors: [
      { rawEntityId: "raw-a", vector: [1, 0] },
      { rawEntityId: "raw-b", vector: [1, 0] },
    ] } as EntityGraphEmbeddingBatch;

    const result = await canonicalizeAuthoritativeEntityGraphWithClient(
      { query } as PostgresEntityCanonicalizationClient,
      { jobId: "job-self", graph: duplicateEndpoints, embeddings: batch },
    );

    expect(result.graph.entities.map((item) => item.id)).toEqual(["same"]);
    expect(result.graph.relations).toEqual([]);
    expect(result.relationResolutions).toEqual([
      expect.objectContaining({ rawRelationId: "raw-self", outcome: "dropped_self" }),
    ]);
  });

  test("resolution/alias/embedding ledgers 由 caller-owned transaction client 持久化", async () => {
    const result = await canonicalizeAuthoritativeEntityGraphWithClient({
      query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
        if (sql.includes("pg_advisory_xact_lock")) return { rows: [{ locked: "" }], rowCount: 1 };
        if (sql.includes("canonical_name =") && params.at(-1) === "postgresql") {
          return { rows: [existingRow({})], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }) as PostgresEntityCanonicalizationClient["query"],
    }, { jobId: "job-2", graph: graph(), embeddings });
    const calls: string[] = [];
    const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      calls.push(sql);
      if (sql.includes("RETURNING")) {
        const column = sql.includes("alias_bindings") ? "canonical_entity_id"
          : sql.includes("relation_resolution") ? "canonical_relation_id"
            : sql.includes("entity_resolution") ? "canonical_entity_id" : "entity_id";
        const index = sql.includes("alias_bindings") ? 13
          : sql.includes("relation_resolution") || sql.includes("entity_resolution") ? 14
            : 10;
        return { rows: [{ [column]: params[index] }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    await persistEntityCanonicalizationPlanWithClient(
      { query } as PostgresEntityCanonicalizationClient,
      result,
    );

    expect(calls.some((sql) => /\b(?:BEGIN|COMMIT|ROLLBACK)\b/i.test(sql))).toBe(false);
    expect(calls.some((sql) => sql.includes("mengshu_graph_entity_alias_bindings"))).toBe(true);
    expect(calls.some((sql) => sql.includes("mengshu_graph_entity_resolution_ledger"))).toBe(true);
    expect(calls.some((sql) => sql.includes("mengshu_graph_relation_resolution_ledger"))).toBe(true);
    expect(calls.some((sql) => sql.includes("mengshu_graph_entity_embeddings"))).toBe(true);
  });

  test.each([
    ["alias ownership", "mengshu_graph_entity_alias_bindings"],
    ["resolution identity", "mengshu_graph_entity_resolution_ledger"],
  ])("%s conflict 返回零行时 fail closed", async (_label, conflictSql) => {
    const result = await canonicalizeAuthoritativeEntityGraphWithClient({
      query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
        if (sql.includes("pg_advisory_xact_lock")) return { rows: [{ locked: "" }], rowCount: 1 };
        if (sql.includes("canonical_name =") && params.at(-1) === "postgresql") {
          return { rows: [existingRow({})], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }) as PostgresEntityCanonicalizationClient["query"],
    }, { jobId: "job-2", graph: graph(), embeddings });
    const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      if (sql.includes(conflictSql)) return { rows: [], rowCount: 0 };
      if (sql.includes("RETURNING")) {
        const column = sql.includes("alias_bindings") ? "canonical_entity_id"
          : sql.includes("relation_resolution") ? "canonical_relation_id"
            : sql.includes("entity_resolution") ? "canonical_entity_id" : "entity_id";
        const index = sql.includes("alias_bindings") ? 13
          : sql.includes("relation_resolution") || sql.includes("entity_resolution") ? 14
            : 10;
        return { rows: [{ [column]: params[index] }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    await expect(persistEntityCanonicalizationPlanWithClient(
      { query } as PostgresEntityCanonicalizationClient,
      result,
    )).rejects.toThrow("ledger result is invalid");
  });
});
