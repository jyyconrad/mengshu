import pg from "pg";
import { describe, expect, test } from "vitest";

import { vectorDimsForModel } from "../../config.js";
import { PostgresProvider } from
  "../../packages/core/src/db/providers/postgres.js";
import { createEmbeddingSpace } from
  "../../packages/core/src/domain/embedding-space.js";
import type { MemoryScope } from
  "../../packages/core/src/domain/types.js";
import { deriveAuthoritativeEntityGraph } from
  "../../packages/core/src/graph/authoritative-entity-graph-derivation.js";
import type { GraphEntityRecord, GraphRelationRecord } from
  "../../packages/core/src/graph/types.js";
import type {
  PostgresAuthoritativeExtractGraphEffectRequest,
  PostgresExtractGraphEffectSummary,
} from
  "../../packages/core/src/db/providers/postgres-job-v2-domain-effects.js";
import { provisionGlobalPostgresTestSchema } from "./global-postgres-config.js";

const { Client } = pg;
const liveEnabled = process.env.MENGSHU_RUN_LIVE_TESTS === "1";
const embeddingModel = "text-embedding-3-small";
const embeddingDimensions = vectorDimsForModel(embeddingModel);
const embeddingSpace = createEmbeddingSpace({
  provider: "openai",
  baseURL: "https://embedding.graph-reuse.live.test/v1",
  model: embeddingModel,
  dim: embeddingDimensions,
  normalization: "none",
});

const jobScope = Object.freeze({
  tenantId: "tenant-graph-reuse",
  userId: "user-graph-reuse",
  appId: "mengshu-graph-reuse",
  projectId: "project-graph-reuse",
  agentId: "agent-graph-reuse",
  namespace: "working-context",
  visibility: "private" as const,
});
const context = Object.freeze({
  workspaceId: "workspace-graph-reuse",
  sessionId: "session-graph-reuse",
});
const fullScope: MemoryScope = Object.freeze({ ...jobScope, ...context });

function vector(index: number): number[] {
  return Array.from({ length: embeddingDimensions }, (_, current) => current === index ? 1 : 0);
}

function entity(
  id: string,
  type: GraphEntityRecord["type"],
  canonicalName: string,
  displayName: string,
  aliases: string[],
  at: number,
): GraphEntityRecord {
  return {
    id,
    scope: fullScope,
    canonicalName,
    displayName,
    type,
    aliases,
    mentionCount: 1,
    mentionCount30d: 1,
    distinctSourceCount: 1,
    lastSeenAt: at,
    hotness: 0.5,
    queryHits30d: 0,
    status: "active",
    createdAt: at,
    updatedAt: at,
    metadata: { source: "authoritative-graph-reuse-live" },
  };
}

function relation(
  id: string,
  subjectId: string,
  predicate: GraphRelationRecord["predicate"],
  objectId: string,
  evidenceId: string,
  at: number,
): GraphRelationRecord {
  return {
    id,
    scope: fullScope,
    subjectId,
    predicate,
    objectId,
    confidence: 0.95,
    evidenceChunkIds: [evidenceId],
    evidenceCount: 1,
    firstSeenAt: at,
    lastSeenAt: at,
    status: "active",
    sourceKinds: ["explicit_save"],
    metadata: { source: "authoritative-graph-reuse-live" },
  };
}

function graphRequest(
  suffix: "a" | "b",
  fence: Readonly<{
    id: string;
    owner: string;
    leaseToken: string;
    leaseGeneration: number;
  }>,
  at: number,
): PostgresAuthoritativeExtractGraphEffectRequest {
  const evidenceId = `evidence-graph-reuse-${suffix}`;
  const memoryId = `memory-graph-reuse-${suffix}`;
  const chunkId = `raw-chunk-${suffix}`;
  const projectId = `raw-mengshu-${suffix}`;
  const toolId = `raw-postgresql-${suffix}`;
  const entities = [
    entity(chunkId, "chunk", `chunk-${suffix}`, `Chunk ${suffix.toUpperCase()}`, [], at),
    entity(projectId, "project", "mengshu", "Mengshu", ["Mengshu"], at),
    entity(toolId, "tool", "postgresql", "PostgreSQL", ["Postgres"], at),
  ];
  const graph = deriveAuthoritativeEntityGraph({
    graphKind: "entity",
    memoryId,
    evidence: {
      authority: "persisted_evidence",
      evidenceId,
      scope: fullScope,
      text: `Chunk ${suffix} states that Mengshu uses PostgreSQL`,
      sourceId: `source-graph-reuse-${suffix}`,
      sourceKind: "explicit_save",
      createdAt: at,
    },
    extraction: {
      entities,
      relations: [
        relation(`raw-chunk-mengshu-${suffix}`, chunkId, "mentions", projectId, evidenceId, at),
        relation(`raw-chunk-postgresql-${suffix}`, chunkId, "mentions", toolId, evidenceId, at),
        relation(`raw-mengshu-uses-postgresql-${suffix}`, projectId, "uses", toolId, evidenceId, at),
      ],
    },
  });
  return {
    effectInput: {
      id: fence.id,
      scope: jobScope,
      owner: fence.owner,
      leaseToken: fence.leaseToken,
      leaseGeneration: fence.leaseGeneration,
    },
    context,
    semanticRequest: { graphKind: "entity", activeMemoryId: memoryId, evidenceId },
    graph,
    entityEmbeddings: {
      authority: "runtime_active_embedding_space",
      embeddingSpaceId: embeddingSpace.embeddingSpaceId,
      embeddingSpaceState: "known-queryable",
      vectors: graph.entities.map((item, index) => ({
        rawEntityId: item.id,
        vector: vector(index),
      })),
    },
  };
}

describe.skipIf(!liveEnabled)("PostgreSQL authoritative Entity Graph canonical reuse", () => {
  test("不同 evidence 复用 canonical entity/relation 时仍原子提交 ledger 与 receipt", async () => {
    const isolated = await provisionGlobalPostgresTestSchema("authoritative_graph_reuse");
    const provider = new PostgresProvider(isolated.postgres, embeddingModel);
    let now = 1_000;
    let tokenOrdinal = 0;
    const bundle = provider.createDurableJobV2RuntimeBundle({
      clock: () => now,
      effectClock: () => now,
      tokenFactory: () => `graph-reuse-token-${++tokenOrdinal}`.padEnd(32, "x"),
      backoffMs: () => 100,
    });
    let client: pg.Client | undefined;
    try {
      await provider.initialize();
      await provider.applyScopeContentHashDedupeContract({
        maintenance: true,
        quiescenceConfirmed: true,
      });
      await provider.registerActiveEmbeddingSpace(embeddingSpace);

      const receipts: PostgresExtractGraphEffectSummary[] = [];
      for (const suffix of ["a", "b"] as const) {
        const jobId = `job-graph-reuse-${suffix}`;
        await bundle.repository.enqueue({
          id: jobId,
          type: "extract_graph",
          payload: { evidenceId: `evidence-graph-reuse-${suffix}` },
          dedupeKey: `extract_graph:reuse-${suffix}`,
          scope: jobScope,
          maxAttempts: 3,
        });
        now += 10;
        const leased = await bundle.repository.lease({
          scope: jobScope,
          owner: "worker-graph-reuse",
          leaseMs: 10_000,
        });
        expect(leased).toMatchObject({
          applied: 1,
          job: { id: jobId, status: "running", leaseGeneration: 1 },
        });
        const running = leased.job!;
        const request = graphRequest(suffix, {
          id: running.id,
          owner: running.leaseOwner!,
          leaseToken: running.leaseToken!,
          leaseGeneration: running.leaseGeneration,
        }, now);
        const effect = await bundle.executeGraphEffect(request);
        expect(effect.status).toBe("applied");
        if (effect.status !== "applied") throw new Error("expected applied graph effect");
        receipts.push(effect.receipt.result);
        if (suffix === "b") {
          await expect(bundle.executeGraphEffect(request)).resolves.toEqual({
            status: "replayed",
            receipt: effect.receipt,
          });
        }
        await bundle.repository.complete({
          id: running.id,
          scope: jobScope,
          owner: running.leaseOwner!,
          leaseToken: running.leaseToken!,
          leaseGeneration: running.leaseGeneration,
        });
        now += 10;
      }

      expect(receipts).toMatchObject([
        {
          createdEntities: 3,
          createdRelations: 3,
          evidenceId: "evidence-graph-reuse-a",
          memoryEvidenceLinks: 1,
          entityEvidenceLinks: 3,
          relationEvidenceLinks: 3,
        },
        {
          createdEntities: 1,
          createdRelations: 2,
          evidenceId: "evidence-graph-reuse-b",
          memoryEvidenceLinks: 1,
          entityEvidenceLinks: 3,
          relationEvidenceLinks: 3,
        },
      ]);
      expect(receipts[0]!.entityIds).toEqual([
        "raw-chunk-a", "raw-mengshu-a", "raw-postgresql-a",
      ]);
      expect(receipts[1]!.entityIds).toEqual([
        "raw-chunk-b", "raw-mengshu-a", "raw-postgresql-a",
      ]);
      expect(receipts[0]!.relationIds).toHaveLength(3);
      expect(receipts[1]!.relationIds).toHaveLength(3);
      expect(receipts[1]!.relationIds[2]).toBe(receipts[0]!.relationIds[2]);

      client = new Client({
        ...isolated.postgres,
        options: `-c search_path=${isolated.schema},public`,
      });
      await client.connect();
      const counts = await client.query<{
        entities: number;
        relations: number;
        memory_evidence: number;
        entity_evidence: number;
        relation_evidence: number;
        entity_resolutions: number;
        relation_resolutions: number;
        receipts: number;
      }>(`SELECT
  (SELECT count(*)::int FROM mengshu_graph_entities) AS entities,
  (SELECT count(*)::int FROM mengshu_graph_relations) AS relations,
  (SELECT count(*)::int FROM mengshu_memory_evidence_links) AS memory_evidence,
  (SELECT count(*)::int FROM mengshu_graph_entity_evidence) AS entity_evidence,
  (SELECT count(*)::int FROM mengshu_graph_relation_evidence) AS relation_evidence,
  (SELECT count(*)::int FROM mengshu_graph_entity_resolution_ledger) AS entity_resolutions,
  (SELECT count(*)::int FROM mengshu_graph_relation_resolution_ledger) AS relation_resolutions,
  (SELECT count(*)::int FROM mengshu_job_v2_effect_receipts
   WHERE effect_key = 'extract_graph.persist.v1') AS receipts`);
      expect(counts.rows).toEqual([{
        entities: 4,
        relations: 5,
        memory_evidence: 2,
        entity_evidence: 6,
        relation_evidence: 6,
        entity_resolutions: 6,
        relation_resolutions: 6,
        receipts: 2,
      }]);

      const canonical = await client.query<{
        canonical_name: string;
        entity_type: string;
        count: number;
        mention_count: number;
      }>(`SELECT canonical_name, entity_type, count(*)::int AS count,
  sum(mention_count)::int AS mention_count
FROM mengshu_graph_entities
WHERE canonical_name IN ('mengshu', 'postgresql')
GROUP BY canonical_name, entity_type
ORDER BY canonical_name`);
      expect(canonical.rows).toEqual([
        { canonical_name: "mengshu", entity_type: "project", count: 1, mention_count: 2 },
        { canonical_name: "postgresql", entity_type: "tool", count: 1, mention_count: 2 },
      ]);

      const secondResolutions = await client.query<{
        raw_entity_id: string;
        canonical_entity_id: string;
        method: string;
      }>(`SELECT raw_entity_id, canonical_entity_id, method
FROM mengshu_graph_entity_resolution_ledger
WHERE evidence_memory_id = 'evidence-graph-reuse-b'
ORDER BY raw_entity_id`);
      expect(secondResolutions.rows).toEqual([
        { raw_entity_id: "raw-chunk-b", canonical_entity_id: "raw-chunk-b", method: "create" },
        { raw_entity_id: "raw-mengshu-b", canonical_entity_id: "raw-mengshu-a", method: "exact" },
        { raw_entity_id: "raw-postgresql-b", canonical_entity_id: "raw-postgresql-a", method: "exact" },
      ]);

      const secondRelationResolutions = await client.query<{
        raw_relation_id: string;
        canonical_relation_id: string;
      }>(`SELECT raw_relation_id, canonical_relation_id
FROM mengshu_graph_relation_resolution_ledger
WHERE evidence_memory_id = 'evidence-graph-reuse-b'
ORDER BY raw_relation_id`);
      expect(secondRelationResolutions.rows).toEqual([
        {
          raw_relation_id: "raw-chunk-mengshu-b",
          canonical_relation_id: receipts[1]!.relationIds[0],
        },
        {
          raw_relation_id: "raw-chunk-postgresql-b",
          canonical_relation_id: receipts[1]!.relationIds[1],
        },
        {
          raw_relation_id: "raw-mengshu-uses-postgresql-b",
          canonical_relation_id: receipts[0]!.relationIds[2],
        },
      ]);

      const secondEntityEvidence = await client.query<{
        entity_id: string;
        evidence_memory_id: string;
      }>(`SELECT entity_id, evidence_memory_id
FROM mengshu_graph_entity_evidence
WHERE evidence_memory_id = 'evidence-graph-reuse-b'
ORDER BY entity_id`);
      expect(secondEntityEvidence.rows).toEqual([
        { entity_id: "raw-chunk-b", evidence_memory_id: "evidence-graph-reuse-b" },
        { entity_id: "raw-mengshu-a", evidence_memory_id: "evidence-graph-reuse-b" },
        { entity_id: "raw-postgresql-a", evidence_memory_id: "evidence-graph-reuse-b" },
      ]);

      const secondRelationEvidence = await client.query<{
        relation_id: string;
        evidence_memory_id: string;
      }>(`SELECT relation_id, evidence_memory_id
FROM mengshu_graph_relation_evidence
WHERE evidence_memory_id = 'evidence-graph-reuse-b'
ORDER BY relation_id`);
      expect(secondRelationEvidence.rows).toEqual(
        [...receipts[1]!.relationIds].sort().map((relationId) => ({
          relation_id: relationId,
          evidence_memory_id: "evidence-graph-reuse-b",
        })),
      );

      const activeAliasOwners = await client.query<{
        normalized_alias: string;
        owners: number;
      }>(`SELECT normalized_alias, count(DISTINCT canonical_entity_id)::int AS owners
FROM mengshu_graph_entity_alias_bindings
WHERE status = 'active' AND normalized_alias IN ('mengshu', 'postgres', 'postgresql')
GROUP BY normalized_alias
ORDER BY normalized_alias`);
      expect(activeAliasOwners.rows).toEqual([
        { normalized_alias: "mengshu", owners: 1 },
        { normalized_alias: "postgres", owners: 1 },
        { normalized_alias: "postgresql", owners: 1 },
      ]);

      const reusedRelation = await client.query<{
        evidence_count: number;
        evidence_chunk_ids: string[];
      }>(`SELECT evidence_count, evidence_chunk_ids
FROM mengshu_graph_relations
WHERE subject_id = 'raw-mengshu-a' AND predicate = 'uses'
  AND object_id = 'raw-postgresql-a'`);
      expect(reusedRelation.rows).toEqual([{
        evidence_count: 2,
        evidence_chunk_ids: ["evidence-graph-reuse-a", "evidence-graph-reuse-b"],
      }]);
    } finally {
      if (client) await client.end();
      await provider.close();
      await isolated.dispose();
    }
  }, 120_000);
});
