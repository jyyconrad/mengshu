import { describe, expect, test, vi } from "vitest";

import { bufferId } from "../../tree/buffer.js";
import { deriveAuthoritativeEntityGraph } from
  "../../graph/authoritative-entity-graph-derivation.js";
import { PostgresProvider } from "./postgres.js";
import type {
  PostgresBuildTreeEffectRequest,
  PostgresLegacyExtractGraphEffectRequest,
  PostgresAuthoritativeExtractGraphEffectRequest,
  PostgresExtractGraphEffectRequest,
} from "./postgres-job-v2-domain-effects.js";

const scope = Object.freeze({
  tenantId: "tenant",
  userId: "user",
  appId: "app",
  projectId: "project",
  agentId: "agent",
  namespace: "memory",
  visibility: "private" as const,
});
const fullScope = Object.freeze({ ...scope, workspaceId: "workspace", sessionId: "session" });

function treeRequest(): PostgresBuildTreeEffectRequest {
  return {
    effectKey: "build_tree.persist.v1",
    effectInput: {
      id: "job-tree",
      scope,
      owner: "worker-1",
      leaseToken: "t".repeat(32),
      leaseGeneration: 1,
    },
    semanticRequest: {
      type: "build_tree",
      version: 1,
      traceId: "trace-1",
      context: { workspaceId: "workspace", sessionId: "session" },
      treeType: "source",
      treeKey: "source-1",
      level: 0,
      policy: { maxLeafCount: 20, maxTokenCount: 6000 },
      leaf: {
        id: "trace-1",
        scope: fullScope,
        chunkId: "trace-1",
        sourceId: "source-1",
        entityIds: [],
        importance: 0.5,
        eventAt: 100,
        createdAt: 100,
        text: "evidence",
        tokenCount: 2,
      },
      expectedBufferId: bufferId(fullScope, "source", "source-1", 0),
    },
  };
}

function graphRequest(): PostgresLegacyExtractGraphEffectRequest {
  return {
    effectInput: {
      id: "job-graph",
      scope,
      owner: "worker-1",
      leaseToken: "g".repeat(32),
      leaseGeneration: 1,
    },
    context: { workspaceId: "workspace", sessionId: "session" },
    semanticRequest: { chunkId: "chunk-1", text: "Project uses PostgreSQL" },
    entities: [{
      id: "entity-1",
      scope: fullScope,
      canonicalName: "postgresql",
      displayName: "PostgreSQL",
      type: "tool",
      aliases: ["PostgreSQL"],
      mentionCount: 1,
      mentionCount30d: 1,
      distinctSourceCount: 1,
      lastSeenAt: 100,
      hotness: 0.5,
      graphCentrality: 0,
      queryHits30d: 0,
      status: "active",
      createdAt: 100,
      updatedAt: 100,
      metadata: {},
    }],
    relations: [],
  };
}

function authoritativeGraphRequest(): PostgresAuthoritativeExtractGraphEffectRequest {
  const firstEntity = graphRequest().entities[0]!;
  const secondEntity = {
    ...firstEntity,
    id: "entity-2",
    canonicalName: "mengshu",
    displayName: "Mengshu",
    type: "project" as const,
    aliases: ["Mengshu"],
  };
  const graph = deriveAuthoritativeEntityGraph({
    graphKind: "entity",
    memoryId: "memory-1",
    evidence: {
      authority: "persisted_evidence",
      evidenceId: "evidence-1",
      scope: fullScope,
      text: "Project uses PostgreSQL",
      sourceId: "source-1",
      sourceKind: "explicit_save",
      createdAt: 100,
    },
    extraction: {
      entities: [firstEntity, secondEntity],
      relations: [{
        id: "relation-1",
        scope: fullScope,
        subjectId: "entity-2",
        predicate: "uses",
        objectId: "entity-1",
        confidence: 0.9,
        evidenceChunkIds: ["evidence-1"],
        evidenceCount: 1,
        firstSeenAt: 100,
        lastSeenAt: 100,
        status: "active",
        sourceKinds: ["explicit_save"],
        metadata: {},
      }],
    },
  });
  return {
    effectInput: {
      id: "job-graph-authoritative",
      scope,
      owner: "worker-1",
      leaseToken: "a".repeat(32),
      leaseGeneration: 1,
    },
    context: { workspaceId: "workspace", sessionId: "session" },
    semanticRequest: {
      graphKind: "entity",
      activeMemoryId: "memory-1",
      evidenceId: "evidence-1",
    },
    graph,
    entityEmbeddings: {
      authority: "runtime_active_embedding_space",
      embeddingSpaceId: `embedding-space:v1:${"a".repeat(64)}`,
      embeddingSpaceState: "known-queryable",
      vectors: graph.entities.map((entity, index) => ({
        rawEntityId: entity.id,
        vector: index === 0 ? [1, 0] : [0, 1],
      })),
    },
  };
}

function providerHarness(options: {
  readonly schemaVersion?: number;
  readonly priorReceipt?: Readonly<Record<string, unknown>>;
  readonly failRelation?: string;
  readonly activeEmbeddingDimensions?: number;
} = {}) {
  const calls: Array<{ readonly sql: string; readonly params: readonly unknown[] }> = [];
  const client = {
    release: vi.fn(),
    query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      const normalized = sql.trim().replace(/\s+/g, " ");
      calls.push({ sql: normalized, params });
      if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (/^SELECT id FROM mengshu_jobs_v2/.test(normalized)) {
        return { rows: [{ id: params[0] }], rowCount: 1 };
      }
      if (/^SELECT job_id, effect_key/.test(normalized)) {
        return options.priorReceipt
          ? { rows: [options.priorReceipt], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (/^SELECT s\.embedding_space_id, s\.dimensions/.test(normalized) &&
          normalized.includes("FROM mengshu_active_embedding_space")) {
        return {
          rows: [{
            embedding_space_id: `embedding-space:v1:${"a".repeat(64)}`,
            dimensions: options.activeEmbeddingDimensions ?? 2,
            state: "known-queryable",
            queryability_state: "known-queryable",
          }],
          rowCount: 1,
        };
      }
      const insertedRelation = normalized.match(/^INSERT INTO (mengshu_[a-z0-9_]+)/)?.[1];
      if (options.failRelation !== undefined && insertedRelation === options.failRelation) {
        throw new Error("ledger write failed");
      }
      if (/^INSERT INTO mengshu_job_v2_effect_receipts/.test(normalized)) {
        return {
          rows: [{
            job_id: params[0],
            effect_key: params[1],
            request_fingerprint: params[2],
            lease_generation: params[3],
            result: JSON.parse(String(params[4])),
            committed_at: params[5],
          }],
          rowCount: 1,
        };
      }
      if (/^SELECT id, leaf_ids/.test(normalized)) {
        return {
          rows: [{
            id: bufferId(fullScope, "source", "source-1", 0),
            leaf_ids: [],
            child_node_ids: [],
            token_count: 0,
            opened_at: 100,
            updated_at: 100,
          }],
          rowCount: 1,
        };
      }
      if (/^SELECT pg_advisory_xact_lock/.test(normalized)) {
        return { rows: [{ locked: "" }], rowCount: 1 };
      }
      if (/^SELECT id, canonical_name, display_name, entity_type, status/.test(normalized) &&
          normalized.includes("FROM mengshu_graph_entities")) {
        return { rows: [], rowCount: 0 };
      }
      if (/^SELECT entity\.id, entity\.canonical_name/.test(normalized) &&
          normalized.includes("FROM mengshu_graph_entity_alias_bindings")) {
        return { rows: [], rowCount: 0 };
      }
      if (/^SELECT entity\.id, entity\.canonical_name/.test(normalized) &&
          normalized.includes("FROM mengshu_graph_entity_embeddings")) {
        return { rows: [], rowCount: 0 };
      }
      if (/^INSERT INTO mengshu_graph_entities/.test(normalized)) {
        return { rows: [{ id: params[0] }], rowCount: 1 };
      }
      if (/^SELECT id FROM mengshu_graph_entities/.test(normalized)) {
        const ids = params.at(-1) as readonly string[];
        return { rows: ids.map((id) => ({ id })), rowCount: ids.length };
      }
      if (/^INSERT INTO mengshu_graph_relations/.test(normalized)) {
        return { rows: [{ id: params[0] }], rowCount: 1 };
      }
      const authoritativeRelation = normalized.match(/^INSERT INTO (mengshu_(?:memory_evidence_links|graph_entity_evidence|graph_relation_evidence|graph_entity_aliases))/)?.[1];
      if (authoritativeRelation) {
        const returning = authoritativeRelation === "mengshu_graph_entity_aliases"
          ? "alias_id"
          : "link_id";
        return { rows: [{ [returning]: params[0] }], rowCount: 1 };
      }
      if (/^INSERT INTO mengshu_graph_entity_alias_bindings/.test(normalized)) {
        return { rows: [{ canonical_entity_id: params[13] }], rowCount: 1 };
      }
      if (/^INSERT INTO mengshu_graph_entity_resolution_ledger/.test(normalized)) {
        return { rows: [{ canonical_entity_id: params[14] }], rowCount: 1 };
      }
      if (/^INSERT INTO mengshu_graph_relation_resolution_ledger/.test(normalized)) {
        return { rows: [{ canonical_relation_id: params[14] }], rowCount: 1 };
      }
      if (/^INSERT INTO mengshu_graph_entity_embeddings/.test(normalized)) {
        return { rows: [{ entity_id: params[10] }], rowCount: 1 };
      }
      if (/^SELECT scope_fingerprint, tenant_id/.test(normalized) &&
          normalized.includes("FROM mengshu_topic_tree_aliases")) {
        if (normalized.includes("legacy_tree_key = ANY")) {
          return { rows: [], rowCount: 0 };
        }
        const entityIds = ["entity-1", "entity-2"];
        const labels = ["postgresql", "mengshu"];
        const rows = entityIds.map((entityId, index) => ({
          scope_fingerprint: params[0], tenant_id: params[1], user_id: params[2],
          app_id: params[3], project_id: params[4], agent_id: params[5],
          namespace: params[6], visibility: params[7], workspace_id: params[8],
          session_id: params[9], legacy_tree_key: entityId,
          canonical_topic_label: labels[index], status: "active",
          merged_from: [entityId], created_at: "100", updated_at: "100",
          sealed_node_id: null, superseded_at: null, archived_at: null,
        }));
        return { rows, rowCount: rows.length };
      }
      if (/^(?:INSERT INTO|UPDATE) mengshu_topic_tree_aliases/.test(normalized)) {
        return { rows: [], rowCount: 1 };
      }
      if (/^(?:INSERT|UPDATE|DELETE) (?:INTO )?mengshu_tree_/.test(normalized)) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${normalized}`);
    }),
  };
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(),
    end: vi.fn(async () => undefined),
  };
  const provider = new PostgresProvider({
    host: "unused",
    port: 5432,
    database: "unused",
    user: "unused",
    password: "unused",
  }, "text-embedding-3-small");
  Object.assign(provider as unknown as Record<string, unknown>, {
    pool,
    schemaVersion: options.schemaVersion ?? 17,
    schemaContractState: "ready",
  });
  const bundle = provider.createDurableJobV2RuntimeBundle({
    clock: () => 200,
    effectClock: () => 200,
    tokenFactory: () => "x".repeat(32),
    backoffMs: () => 100,
  });
  return { provider, bundle, pool, client, calls };
}

describe("PostgresProvider tree/graph durable effects", () => {
  test("D-21 M1/M5 capability 在 schema v16 前零 SQL fail-closed", async () => {
    const h = providerHarness({ schemaVersion: 15 });

    await expect(h.bundle.persistTopicTreeAliases({
      scope: fullScope,
      entities: [{ entityId: "entity-1", canonicalName: "PostgreSQL" }],
      now: 200,
    })).rejects.toThrow(/schema v16 is required/i);
    await expect(h.bundle.archiveSupersededTopicTrees({
      scope: fullScope,
      supersededBefore: 100,
      now: 200,
    })).rejects.toThrow(/schema v16 is required/i);
    expect(h.pool.connect).not.toHaveBeenCalled();
    expect(h.calls).toEqual([]);
  });

  test("build_tree 通过 provider-owned runner 在 fence/receipt 同一事务持久化", async () => {
    const h = providerHarness();
    const result = await h.bundle.executeBuildTreeEffect(treeRequest(), new AbortController().signal);

    expect(result).toMatchObject({
      status: "applied",
      receipt: {
        effectKey: "build_tree.persist.v1",
        result: {
          leafId: "trace-1",
          sealed: false,
          bufferId: bufferId(fullScope, "source", "source-1", 0),
          nodeId: null,
        },
      },
    });
    expect(h.calls.map(({ sql }) => sql)).toEqual([
      "BEGIN",
      expect.stringMatching(/^SELECT id FROM mengshu_jobs_v2/),
      expect.stringMatching(/^SELECT job_id, effect_key/),
      expect.stringMatching(/^INSERT INTO mengshu_tree_leaves/),
      expect.stringMatching(/^UPDATE mengshu_tree_leaves/),
      expect.stringMatching(/^INSERT INTO mengshu_tree_buffers/),
      expect.stringMatching(/^SELECT id, leaf_ids/),
      expect.stringMatching(/^UPDATE mengshu_tree_buffers/),
      expect.stringMatching(/^INSERT INTO mengshu_job_v2_effect_receipts/),
      "COMMIT",
    ]);
    expect(h.client.release).toHaveBeenCalledTimes(1);
  });

  test("D-21 build_tree 在 schema v16 前 fail closed 且 alias relation 进入 effect allowlist", async () => {
    const stale = providerHarness({ schemaVersion: 15 });
    await expect(stale.bundle.executeBuildTreeEffect(
      treeRequest(),
      new AbortController().signal,
    )).rejects.toThrow(/schema v16 is required/i);
    expect(stale.pool.connect).not.toHaveBeenCalled();

    const ready = providerHarness({ schemaVersion: 16 });
    await expect(ready.bundle.executeBuildTreeEffect(
      treeRequest(),
      new AbortController().signal,
    )).resolves.toMatchObject({ status: "applied" });
    expect(ready.calls.some(({ sql }) => sql.includes("mengshu_tree_leaves"))).toBe(true);
  });

  test("extract_graph 在 transaction 外完成输入快照并原子写 entity+receipt", async () => {
    const h = providerHarness();
    const result = await h.bundle.executeGraphEffect(graphRequest());

    expect(result).toMatchObject({
      status: "applied",
      receipt: {
        effectKey: "extract_graph.persist.v1",
        result: {
          createdEntities: 1,
          createdRelations: 0,
          entityIds: ["entity-1"],
          relationIds: [],
        },
      },
    });
    expect(h.calls.map(({ sql }) => sql)).toEqual([
      "BEGIN",
      expect.stringMatching(/^SELECT id FROM mengshu_jobs_v2/),
      expect.stringMatching(/^SELECT job_id, effect_key/),
      expect.stringMatching(/^INSERT INTO mengshu_graph_entities/),
      expect.stringMatching(/^INSERT INTO mengshu_job_v2_effect_receipts/),
      "COMMIT",
    ]);
  });

  test("authoritative extract_graph 在 v17 fenced transaction 原子完成 canonicalization、graph 与 ledger", async () => {
    const h = providerHarness({ schemaVersion: 17 });
    const result = await h.bundle.executeGraphEffect(authoritativeGraphRequest());

    expect(result).toMatchObject({
      status: "applied",
      receipt: {
        effectKey: "extract_graph.persist.v1",
        result: {
          evidenceId: "evidence-1",
          entityIds: ["entity-1", "entity-2"],
          relationIds: [expect.stringMatching(/^rel_[0-9a-f]{24}$/)],
          memoryEvidenceLinks: 1,
          entityEvidenceLinks: 2,
          relationEvidenceLinks: 1,
          aliasProjections: 2,
        },
      },
    });
    expect(h.calls.map(({ sql }) => sql)).toEqual([
      "BEGIN",
      expect.stringMatching(/^SELECT id FROM mengshu_jobs_v2/),
      expect.stringMatching(/^SELECT job_id, effect_key/),
      expect.stringMatching(/^SELECT s\.embedding_space_id, s\.dimensions/),
      expect.stringMatching(/^SELECT pg_advisory_xact_lock/),
      expect.stringMatching(/^SELECT pg_advisory_xact_lock/),
      expect.stringMatching(/^SELECT id, canonical_name, display_name, entity_type, status/),
      expect.stringMatching(/^SELECT entity\.id, entity\.canonical_name.*mengshu_graph_entity_alias_bindings/),
      expect.stringMatching(/^SELECT entity\.id, entity\.canonical_name.*mengshu_graph_entity_embeddings/),
      expect.stringMatching(/^SELECT id, canonical_name, display_name, entity_type, status/),
      expect.stringMatching(/^SELECT entity\.id, entity\.canonical_name.*mengshu_graph_entity_alias_bindings/),
      expect.stringMatching(/^SELECT entity\.id, entity\.canonical_name.*mengshu_graph_entity_embeddings/),
      expect.stringMatching(/^INSERT INTO mengshu_graph_entities/),
      expect.stringMatching(/^INSERT INTO mengshu_graph_entities/),
      expect.stringMatching(/^SELECT id FROM mengshu_graph_entities/),
      expect.stringMatching(/^INSERT INTO mengshu_graph_relations/),
      expect.stringMatching(/^INSERT INTO mengshu_memory_evidence_links/),
      expect.stringMatching(/^INSERT INTO mengshu_graph_entity_evidence/),
      expect.stringMatching(/^INSERT INTO mengshu_graph_entity_evidence/),
      expect.stringMatching(/^INSERT INTO mengshu_graph_relation_evidence/),
      expect.stringMatching(/^INSERT INTO mengshu_graph_entity_aliases/),
      expect.stringMatching(/^INSERT INTO mengshu_graph_entity_aliases/),
      expect.stringMatching(/^INSERT INTO mengshu_graph_entity_alias_bindings/),
      expect.stringMatching(/^INSERT INTO mengshu_graph_entity_alias_bindings/),
      expect.stringMatching(/^INSERT INTO mengshu_graph_entity_resolution_ledger/),
      expect.stringMatching(/^INSERT INTO mengshu_graph_entity_resolution_ledger/),
      expect.stringMatching(/^INSERT INTO mengshu_graph_relation_resolution_ledger/),
      expect.stringMatching(/^INSERT INTO mengshu_graph_entity_embeddings/),
      expect.stringMatching(/^INSERT INTO mengshu_graph_entity_embeddings/),
      expect.stringMatching(/^INSERT INTO mengshu_job_v2_effect_receipts/),
      "COMMIT",
    ]);
    const canonicalReads = h.calls.filter(({ sql }) =>
      sql.includes("FROM mengshu_graph_entities") ||
      sql.includes("FROM mengshu_graph_entity_alias_bindings") ||
      sql.includes("FROM mengshu_graph_entity_embeddings"));
    expect(canonicalReads).toHaveLength(7);
    expect(canonicalReads.every(({ params }) => params.slice(1, 10).join(":") === [
      "tenant", "user", "app", "project", "agent", "memory", "private", "workspace", "session",
    ].join(":"))).toBe(true);
  });

  test("authoritative embedding 维度与 active registry 不一致时写前回滚", async () => {
    const h = providerHarness({ schemaVersion: 17, activeEmbeddingDimensions: 3 });

    await expect(h.bundle.executeGraphEffect(authoritativeGraphRequest()))
      .rejects.toMatchObject({ code: "DURABLE_JOB_EFFECT_INVALID_INPUT", retryable: false });
    expect(h.calls.map(({ sql }) => sql)).toEqual([
      "BEGIN",
      expect.stringMatching(/^SELECT id FROM mengshu_jobs_v2/),
      expect.stringMatching(/^SELECT job_id, effect_key/),
      expect.stringMatching(/^SELECT s\.embedding_space_id, s\.dimensions/),
      "ROLLBACK",
    ]);
    expect(h.calls.some(({ sql }) => /^INSERT INTO mengshu_graph_entities/.test(sql))).toBe(false);
    expect(h.calls.some(({ sql }) => /^INSERT INTO mengshu_job_v2_effect_receipts/.test(sql)))
      .toBe(false);
  });

  test("authoritative v17 resolution ledger 失败回滚 graph/canonicalization 且不提交 receipt", async () => {
    const h = providerHarness({
      schemaVersion: 17,
      failRelation: "mengshu_graph_entity_resolution_ledger",
    });

    await expect(h.bundle.executeGraphEffect(authoritativeGraphRequest()))
      .rejects.toThrow("ledger write failed");
    expect(h.calls.map(({ sql }) => sql)).toEqual([
      "BEGIN",
      expect.stringMatching(/^SELECT id FROM mengshu_jobs_v2/),
      expect.stringMatching(/^SELECT job_id, effect_key/),
      expect.stringMatching(/^SELECT s\.embedding_space_id, s\.dimensions/),
      expect.stringMatching(/^SELECT pg_advisory_xact_lock/),
      expect.stringMatching(/^SELECT pg_advisory_xact_lock/),
      expect.stringMatching(/^SELECT id, canonical_name, display_name, entity_type, status/),
      expect.stringMatching(/^SELECT entity\.id, entity\.canonical_name.*mengshu_graph_entity_alias_bindings/),
      expect.stringMatching(/^SELECT entity\.id, entity\.canonical_name.*mengshu_graph_entity_embeddings/),
      expect.stringMatching(/^SELECT id, canonical_name, display_name, entity_type, status/),
      expect.stringMatching(/^SELECT entity\.id, entity\.canonical_name.*mengshu_graph_entity_alias_bindings/),
      expect.stringMatching(/^SELECT entity\.id, entity\.canonical_name.*mengshu_graph_entity_embeddings/),
      expect.stringMatching(/^INSERT INTO mengshu_graph_entities/),
      expect.stringMatching(/^INSERT INTO mengshu_graph_entities/),
      expect.stringMatching(/^SELECT id FROM mengshu_graph_entities/),
      expect.stringMatching(/^INSERT INTO mengshu_graph_relations/),
      expect.stringMatching(/^INSERT INTO mengshu_memory_evidence_links/),
      expect.stringMatching(/^INSERT INTO mengshu_graph_entity_evidence/),
      expect.stringMatching(/^INSERT INTO mengshu_graph_entity_evidence/),
      expect.stringMatching(/^INSERT INTO mengshu_graph_relation_evidence/),
      expect.stringMatching(/^INSERT INTO mengshu_graph_entity_aliases/),
      expect.stringMatching(/^INSERT INTO mengshu_graph_entity_aliases/),
      expect.stringMatching(/^INSERT INTO mengshu_graph_entity_alias_bindings/),
      expect.stringMatching(/^INSERT INTO mengshu_graph_entity_alias_bindings/),
      expect.stringMatching(/^INSERT INTO mengshu_graph_entity_resolution_ledger/),
      "ROLLBACK",
    ]);
    expect(h.calls.some(({ sql }) => /^INSERT INTO mengshu_job_v2_effect_receipts/.test(sql)))
      .toBe(false);
  });

  test("authoritative extract_graph 在 schema v17 之前 fail closed 且零 SQL", async () => {
    const h = providerHarness({ schemaVersion: 16 });
    await expect(h.bundle.executeGraphEffect(authoritativeGraphRequest()))
      .rejects.toThrow(/schema v17 is required/i);
    expect(h.pool.connect).not.toHaveBeenCalled();
    expect(h.calls).toEqual([]);
  });

  test("authoritative effect replay 直接返回首次 receipt，不消费新的 graph output", async () => {
    const request = authoritativeGraphRequest();
    const priorResult = {
      createdEntities: 1,
      createdRelations: 0,
      entityIds: ["entity-first"],
      relationIds: [],
      evidenceId: "evidence-1",
      memoryEvidenceLinks: 1,
      entityEvidenceLinks: 1,
      relationEvidenceLinks: 0,
      aliasProjections: 2,
    };
    const fingerprint = await import("./postgres-job-v2-domain-effects.js")
      .then(({ extractGraphSemanticFingerprint }) => extractGraphSemanticFingerprint(request));
    const h = providerHarness({
      schemaVersion: 17,
      priorReceipt: {
        job_id: request.effectInput.id,
        effect_key: "extract_graph.persist.v1",
        request_fingerprint: fingerprint,
        lease_generation: 1,
        result: priorResult,
        committed_at: 150,
      },
    });
    const recomputedGraph = deriveAuthoritativeEntityGraph({
      graphKind: "entity",
      memoryId: request.graph.memoryId,
      evidence: {
        authority: "persisted_evidence",
        evidenceId: request.graph.evidenceId,
        scope: fullScope,
        text: "Project uses PostgreSQL",
        sourceId: "source-1",
        sourceKind: "explicit_save",
        createdAt: 100,
      },
      extraction: { entities: [], relations: [] },
    });

    await expect(h.bundle.executeGraphEffect({
      ...request,
      graph: recomputedGraph,
      entityEmbeddings: { authority: "stale-runtime-output" },
    } as never)).resolves.toMatchObject({ status: "replayed", receipt: { result: priorResult } });
    expect(h.calls.map(({ sql }) => sql)).toEqual([
      "BEGIN",
      expect.stringMatching(/^SELECT id FROM mengshu_jobs_v2/),
      expect.stringMatching(/^SELECT job_id, effect_key/),
      "COMMIT",
    ]);
  });

  test("build_tree pre-abort 不连接数据库", async () => {
    const h = providerHarness();
    const controller = new AbortController();
    controller.abort();
    await expect(h.bundle.executeBuildTreeEffect(treeRequest(), controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(h.pool.connect).not.toHaveBeenCalled();
  });
});
