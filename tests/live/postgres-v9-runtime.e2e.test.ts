import { randomUUID } from "node:crypto";

import pg from "pg";
import { describe, expect, test } from "vitest";

import { vectorDimsForModel, type MemoryConfig } from "../../config.js";
import { createMengshuRuntime } from "../../runtime.js";
import { PostgresProvider } from
  "../../packages/core/src/db/providers/postgres.js";
import { createEmbeddingSpace } from
  "../../packages/core/src/domain/embedding-space.js";
import {
  CURRENT_SCHEMA_VERSION,
  DURABLE_JOB_STATE_CONSTRAINT_NAME,
} from
  "../../packages/core/src/db/migrations/schema-migrations.js";
import type { Embeddings } from
  "../../packages/core/src/runtime/llm/embeddings.js";
import type { LlmClient, LlmCompletionMessage, SimpleJsonSchema } from
  "../../packages/core/src/runtime/llm/llm-client.js";
import type { MemoryRecord } from
  "../../packages/core/src/domain/types.js";
import { createServeRuntimeHost } from "../../server/runtime-host-factory.js";
import {
  provisionGlobalPostgresTestSchema,
  type GlobalPostgresConfig,
} from "./global-postgres-config.js";

const { Client } = pg;

const liveEnabled = process.env.MENGSHU_RUN_LIVE_TESTS === "1";
const EXPECTED_LEDGER = Object.freeze(Array.from(
  { length: CURRENT_SCHEMA_VERSION },
  (_, index) => index + 1,
));
const REQUIRED_RUNTIME_RELATIONS = Object.freeze([
  "mengshu_schema_migrations",
  "mengshu_jobs_v2",
  "mengshu_job_v2_effect_receipts",
  "mengshu_candidates",
  "mengshu_tree_leaves",
  "mengshu_tree_buffers",
  "mengshu_tree_summary_nodes",
  "mengshu_graph_entities",
  "mengshu_graph_relations",
  "mengshu_write_receipts",
  "mengshu_write_audit",
  "mengshu_write_outbox",
  "mengshu_work_memory_nodes",
  "mengshu_work_memory_edges",
  "mengshu_candidate_write_receipts",
  "mengshu_candidate_write_audit",
  "mengshu_candidate_write_outbox",
  "mengshu_memory_evidence_links",
  "mengshu_graph_entity_evidence",
  "mengshu_graph_relation_evidence",
  "mengshu_graph_entity_aliases",
]);
const REQUIRED_RUNTIME_INDEXES = Object.freeze([
  "mengshu_jobs_v2_queued_idx",
  "mengshu_job_v2_effect_receipts_committed_idx",
  "mengshu_candidates_scope_status_created_idx",
  "mengshu_tree_leaves_scope_event_idx",
  "mengshu_tree_summary_scope_idx",
  "mengshu_graph_entities_scope_name_idx",
  "mengshu_graph_relations_scope_subject_idx",
  "mengshu_write_receipts_created_idx",
  "mengshu_write_audit_scope_memory_idx",
  "mengshu_write_outbox_pending_idx",
  "mengshu_work_memory_nodes_scope_type_idx",
  "mengshu_work_memory_edges_scope_source_idx",
  "mengshu_work_memory_edges_scope_target_idx",
  "mengshu_candidate_write_audit_scope_candidate_idx",
  "mengshu_candidate_write_outbox_pending_idx",
  "mengshu_candidate_write_receipts_created_idx",
  "mengshu_memory_evidence_links_scope_target_idx",
  "mengshu_graph_entity_evidence_scope_evidence_idx",
  "mengshu_graph_relation_evidence_scope_evidence_idx",
  "mengshu_graph_entity_aliases_scope_alias_idx",
]);

async function ledger(config: GlobalPostgresConfig): Promise<number[]> {
  const client = new Client(config);
  await client.connect();
  try {
    const result = await client.query<{ version: number }>(
      "SELECT version FROM mengshu_schema_migrations ORDER BY version",
    );
    return result.rows.map(({ version }) => Number(version));
  } finally {
    await client.end();
  }
}

const scope = Object.freeze({
  tenantId: "tenant-live",
  userId: "user-live",
  appId: "mengshu-live",
  projectId: "project-live",
  agentId: "agent-live",
  namespace: "working-context",
  visibility: "private" as const,
});
const workspaceId = "workspace-live";
const sessionId = "session-live";
const fullScope = Object.freeze({ ...scope, workspaceId, sessionId });
const authority = Object.freeze({
  tenantId: scope.tenantId,
  userId: scope.userId,
  allow: Object.freeze({
    appIds: Object.freeze([scope.appId]),
    projectIds: Object.freeze([scope.projectId]),
    agentIds: Object.freeze([scope.agentId]),
    namespaces: Object.freeze([scope.namespace]),
    visibilities: Object.freeze([scope.visibility]),
  }),
});
const chunkId = "chunk-live-v9-1";
const liveEmbeddingModel = "BAAI/bge-m3";
const liveEmbeddingDimension = vectorDimsForModel(liveEmbeddingModel);
const liveEmbeddingSpace = createEmbeddingSpace({
  provider: "openai",
  baseURL: "https://embedding.live.test/v1",
  model: liveEmbeddingModel,
  dim: liveEmbeddingDimension,
  normalization: "none",
});
const text = "记住：Mengshu 必须使用 PostgreSQL，并且所有升级必须先完成真实测试验证，保留可重复的证据，绝不能跳过真实数据库端到端检查。";
const activeText = "PostgreSQL，并且所有升级必须先完成真实测试验证";

const llmClient = Object.freeze({
  available: true,
  async complete() { return ""; },
  async summarize() { return ""; },
  async extractStructured<T>(
    _messages: LlmCompletionMessage[],
    schema: SimpleJsonSchema,
  ): Promise<T> {
    if (schema.title === "MemoryCandidateExtraction") {
      return {
        candidates: [{
          text: activeText,
          semanticType: "rules",
          kind: "constraint",
          targetScope: "session",
          evidence: { eventIds: ["provider-output-is-not-authority"], quote: activeText },
          salience: 1,
          temporality: "durable",
          crossContextual: true,
          reason: "用户显式要求记住的验证约束",
          riskFlags: [],
        }],
      } as T;
    }
    if (schema.title === "GraphExtraction") {
      return {
        entities: [
          { name: "Mengshu", type: "project", aliases: ["梦枢"] },
          { name: "PostgreSQL", type: "tool", aliases: ["Postgres"] },
        ],
        relations: [{
          subject: "Mengshu",
          predicate: "uses",
          object: "PostgreSQL",
          confidence: 0.96,
          evidence: "Mengshu 必须使用 PostgreSQL",
        }],
      } as T;
    }
    return { entities: [], relations: [] } as T;
  },
}) as LlmClient;

function deterministicEmbeddings(): Embeddings {
  const vector = () => Array.from(
    { length: liveEmbeddingDimension },
    () => 1 / Math.sqrt(liveEmbeddingDimension),
  );
  return {
    modelName: liveEmbeddingModel,
    embed: async () => vector(),
    embedBatch: async (texts: string[]) => texts.map(() => vector()),
  } as unknown as Embeddings;
}

function runtimeConfig(config: GlobalPostgresConfig): MemoryConfig {
  return {
    embedding: {
      provider: "openai",
      apiKey: "live-test-key-not-a-real-secret",
      baseURL: liveEmbeddingSpace.fingerprint.baseURL,
      model: liveEmbeddingModel,
    },
    dbType: "postgres",
    postgres: config,
  };
}

async function waitFor<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  label: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let latest = await read();
  while (!accept(latest)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${label}: ${JSON.stringify(latest)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    latest = await read();
  }
  return latest;
}

describe.skipIf(!liveEnabled)("PostgreSQL current-schema RuntimeHost live e2e", () => {
  test("v1-v5 migration -> production host -> active receipt -> restart replay -> graph/tree/recall/slot", async () => {
    const isolated = await provisionGlobalPostgresTestSchema("runtime_v9");
    const config = isolated.postgres;
    try {
      expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(32);

      const provider = new PostgresProvider(config, liveEmbeddingModel);
    const runtimeBundle = provider.createDurableJobV2RuntimeBundle({
      clock: Date.now,
      tokenFactory: () => randomUUID().replaceAll("-", ""),
      backoffMs: () => 25,
    });
    try {
      await provider.initialize();
      expect(await provider.getSchemaContractStatus()).toEqual({
        currentVersion: 5,
        targetVersion: CURRENT_SCHEMA_VERSION,
        scopeContentHashDedupe: "pending",
      });
      expect(await ledger(config)).toEqual([1, 2, 3, 4, 5]);

      await expect(provider.applyScopeContentHashDedupeContract({
        maintenance: true,
        quiescenceConfirmed: true,
      })).resolves.toEqual({
        currentVersion: CURRENT_SCHEMA_VERSION,
        targetVersion: CURRENT_SCHEMA_VERSION,
        scopeContentHashDedupe: "ready",
      });
      expect(await ledger(config)).toEqual(EXPECTED_LEDGER);
      await expect(runtimeBundle.assertReady()).resolves.toMatchObject({
        minimumSchemaVersion: 10,
        currentSchemaVersion: CURRENT_SCHEMA_VERSION,
        candidateEffects: "ready",
        treeEffects: "ready",
        graphEffects: "ready",
      });

      const catalogClient = new Client(config);
      await catalogClient.connect();
      try {
        const relations = await catalogClient.query<{ relation: string }>(
          `SELECT relation
FROM unnest($1::text[]) AS relation
	WHERE to_regclass(current_schema() || '.' || relation) IS NOT NULL
ORDER BY relation`,
          [[...REQUIRED_RUNTIME_RELATIONS]],
        );
        expect(relations.rows.map(({ relation }) => relation).sort()).toEqual(
          [...REQUIRED_RUNTIME_RELATIONS].sort(),
        );
        const indexes = await catalogClient.query<{ index_name: string }>(
          `SELECT index_name
FROM unnest($1::text[]) AS index_name
	WHERE to_regclass(current_schema() || '.' || index_name) IS NOT NULL
ORDER BY index_name`,
          [[...REQUIRED_RUNTIME_INDEXES]],
        );
        expect(indexes.rows.map(({ index_name }) => index_name).sort()).toEqual(
          [...REQUIRED_RUNTIME_INDEXES].sort(),
        );
        const durableStateConstraint = await catalogClient.query<{ definition: string }>(
          `SELECT pg_get_constraintdef(oid) AS definition
FROM pg_constraint
	WHERE conrelid = 'mengshu_jobs_v2'::regclass AND conname = $1`,
          [DURABLE_JOB_STATE_CONSTRAINT_NAME],
        );
        expect(durableStateConstraint.rows).toHaveLength(1);
        expect(durableStateConstraint.rows[0]?.definition).toContain(
          "char_length(lease_token) >= 32",
        );
        expect(durableStateConstraint.rows[0]?.definition).toContain(
          "char_length(lease_token) <= 256",
        );
        expect(durableStateConstraint.rows[0]?.definition).not.toContain("{32,256}");
      } finally {
        await catalogClient.end();
      }

      const atomicStore = provider.createAtomicMemoryStorePort();
      const atomicRecord = (
        id: string,
        recordText: string,
        contentHash: string,
      ): MemoryRecord => ({
        id,
        scope: fullScope,
        kind: "fact",
        text: recordText,
        contentHash,
        importance: 0.8,
        category: "fact",
        dataType: "memory",
        tableName: "memories",
        metadata: {
          embeddingSpaceId: liveEmbeddingSpace.embeddingSpaceId,
          embeddingSpaceState: "known-queryable",
        },
        provenance: { source: "user", createdAt: Date.now() - 1 },
        createdAt: Date.now() - 1,
        vector: Array.from({ length: liveEmbeddingDimension }, () => 0.001),
      });
      const committedRecord = atomicRecord(
        "00000000-0000-4000-8000-000000000101",
        "atomic v11 memory write",
        "a".repeat(64),
      );
      await expect(atomicStore.store(committedRecord)).resolves.toEqual({
        id: committedRecord.id,
        stored: true,
      });
      await expect(atomicStore.store(committedRecord)).resolves.toEqual({
        id: committedRecord.id,
        stored: true,
      });

      const atomicClient = new Client(config);
      await atomicClient.connect();
      try {
        const counts = await atomicClient.query<{
          memories: number;
          audit: number;
          outbox: number;
          receipts: number;
        }>(`SELECT
  (SELECT count(*)::int FROM memories WHERE id = $1::uuid) AS memories,
  (SELECT count(*)::int FROM mengshu_write_audit WHERE memory_id = $1::text) AS audit,
  (SELECT count(*)::int FROM mengshu_write_outbox WHERE memory_id = $1::text) AS outbox,
  (SELECT count(*)::int FROM mengshu_write_receipts) AS receipts`, [committedRecord.id]);
        expect(counts.rows).toEqual([{ memories: 1, audit: 1, outbox: 1, receipts: 1 }]);

        await atomicClient.query(`CREATE FUNCTION mengshu_live_reject_write_audit()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced live rollback'; END $$`);
        await atomicClient.query(`CREATE TRIGGER mengshu_live_reject_write_audit
BEFORE INSERT ON mengshu_write_audit
FOR EACH ROW EXECUTE FUNCTION mengshu_live_reject_write_audit()`);
      } finally {
        await atomicClient.end();
      }

      const rolledBackRecord = atomicRecord(
        "00000000-0000-4000-8000-000000000102",
        "must rollback with journal failure",
        "b".repeat(64),
      );
      await expect(atomicStore.store(rolledBackRecord)).rejects.toThrow();
      const rollbackClient = new Client(config);
      await rollbackClient.connect();
      try {
        const counts = await rollbackClient.query<{
          memories: number;
          audit: number;
          outbox: number;
          receipts: number;
        }>(`SELECT
  (SELECT count(*)::int FROM memories WHERE id = $1::uuid) AS memories,
  (SELECT count(*)::int FROM mengshu_write_audit WHERE memory_id = $1::text) AS audit,
  (SELECT count(*)::int FROM mengshu_write_outbox WHERE memory_id = $1::text) AS outbox,
  (SELECT count(*)::int FROM mengshu_write_receipts) AS receipts`, [rolledBackRecord.id]);
        expect(counts.rows).toEqual([{ memories: 0, audit: 0, outbox: 0, receipts: 1 }]);
        await rollbackClient.query(
          "DROP TRIGGER mengshu_live_reject_write_audit ON mengshu_write_audit",
        );
        await rollbackClient.query("DROP FUNCTION mengshu_live_reject_write_audit() ");
      } finally {
        await rollbackClient.end();
      }
      await provider.registerActiveEmbeddingSpace(liveEmbeddingSpace);
    } finally {
      await provider.close();
    }

    const runtimeProvider = new PostgresProvider(config, liveEmbeddingModel);
    const runtime = createMengshuRuntime({
      config: runtimeConfig(config),
      resolvedDbPath: "",
      appId: scope.appId,
      defaultScope: fullScope,
      db: runtimeProvider,
      embeddings: deterministicEmbeddings(),
      llmClient,
    });
    const host = createServeRuntimeHost(runtime, {
      authority,
      workerId: "worker-live-runtime-host",
      leaseMs: 10_000,
      heartbeatIntervalMs: 2_000,
      intervalMs: 25,
      maxPerTick: 10,
      stopTimeoutMs: 5_000,
    });
    let activeRuntime = runtime;
    let restartedHost: ReturnType<typeof createServeRuntimeHost> | undefined;
    let replayHost: ReturnType<typeof createServeRuntimeHost> | undefined;
    let started = false;
    try {
      await host.start();
      started = true;
      expect(host.snapshot()).toMatchObject({ state: "ready", ready: true, accepting: true });

      const faultClient = new Client(config);
      await faultClient.connect();
      try {
        await faultClient.query(`CREATE FUNCTION mengshu_live_reject_work_graph_node()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced work graph failure'; END $$`);
        await faultClient.query(`CREATE TRIGGER mengshu_live_reject_work_graph_node
BEFORE INSERT ON mengshu_work_memory_nodes
FOR EACH ROW EXECUTE FUNCTION mengshu_live_reject_work_graph_node()`);
      } finally {
        await faultClient.end();
      }

      const observed = await runtime.agentFastPath.observeLight({
        scope: fullScope,
        eventType: "observation",
        text,
        intent: "remember",
        idempotencyKey: chunkId,
        metadata: { source: "user" },
      });
      expect(observed).toMatchObject({
        ack: true,
        recordType: "memory",
        admissionRoute: "evidence_only",
        stored: true,
      });
      expect(observed.queuedJobs).toHaveLength(1);
      const evidenceId = observed.persistedId!;

      const failed = await waitFor(async () => {
        const client = new Client(config);
        await client.connect();
        try {
          const result = await client.query<{
            status: string;
            attempts: number;
            receipt_count: number;
            active_memory_id: string | null;
            receipt_result: Record<string, unknown> | null;
          }>(`SELECT j.status, j.attempts,
  (SELECT count(*)::int FROM mengshu_job_v2_effect_receipts r
   WHERE r.job_id = j.id AND r.effect_key = 'extract_candidate.persist.v1') AS receipt_count,
  (SELECT r.result->'activeMemoryIds'->>0 FROM mengshu_job_v2_effect_receipts r
   WHERE r.job_id = j.id AND r.effect_key = 'extract_candidate.persist.v1') AS active_memory_id,
  (SELECT r.result FROM mengshu_job_v2_effect_receipts r
   WHERE r.job_id = j.id AND r.effect_key = 'extract_candidate.persist.v1') AS receipt_result
FROM mengshu_jobs_v2 j WHERE j.type = 'extract_candidate'`);
          return result.rows[0] ?? null;
        } finally {
          await client.end();
        }
      }, (value) => value?.status === "retry_wait" && value.receipt_count === 1 &&
        typeof value.active_memory_id === "string", "post-commit derivation failure");
      expect(failed).toMatchObject({ status: "retry_wait", attempts: 1, receipt_count: 1 });
      const activeMemoryId = failed!.active_memory_id!;

      await host.stop();
      started = false;
      expect(host.snapshot()).toMatchObject({ state: "stopped", ready: false, accepting: false });

      const repairClient = new Client(config);
      await repairClient.connect();
      try {
        await repairClient.query(
          "DROP TRIGGER mengshu_live_reject_work_graph_node ON mengshu_work_memory_nodes",
        );
        await repairClient.query("DROP FUNCTION mengshu_live_reject_work_graph_node() ");
      } finally {
        await repairClient.end();
      }

      const restartProvider = new PostgresProvider(config, liveEmbeddingModel);
      const restartRuntime = createMengshuRuntime({
        config: runtimeConfig(config),
        resolvedDbPath: "",
        appId: scope.appId,
        defaultScope: fullScope,
        db: restartProvider,
        embeddings: deterministicEmbeddings(),
        llmClient,
      });
      restartedHost = createServeRuntimeHost(restartRuntime, {
        authority,
        workerId: "worker-live-runtime-host-restart",
        leaseMs: 10_000,
        heartbeatIntervalMs: 2_000,
        intervalMs: 25,
        maxPerTick: 10,
        stopTimeoutMs: 5_000,
      });
      activeRuntime = restartRuntime;
      await restartedHost.start();
      started = true;
      expect(restartedHost.snapshot()).toMatchObject({
        generation: 1,
        state: "ready",
        accepting: true,
      });

      const completed = await waitFor(async () => {
        const client = new Client(config);
        await client.connect();
        try {
          const result = await client.query<{
            candidate_status: string;
            candidate_attempts: number;
            write_receipts: number;
            candidate_receipts: number;
            effect_receipts: number;
            graph_status: string;
            graph_attempts: number;
            graph_error_code: string | null;
            graph_payload: Record<string, unknown>;
            graph_receipts: number;
            graph_receipt_result: Record<string, unknown> | null;
            tree_jobs: number;
            tree_receipts: number;
            tree_types: string[];
            work_node_types: string[];
            work_edge_predicates: string[];
            graph_entities: number;
            graph_relations: number;
            memory_evidence_links: number;
            entity_evidence_links: number;
            relation_evidence_links: number;
            alias_projections: number;
            last_error_code: string | null;
            active_metadata: Record<string, unknown> | null;
            evidence_metadata: Record<string, unknown> | null;
          }>(`SELECT
  (SELECT status FROM mengshu_jobs_v2 WHERE type = 'extract_candidate') AS candidate_status,
  (SELECT attempts FROM mengshu_jobs_v2 WHERE type = 'extract_candidate') AS candidate_attempts,
  (SELECT count(*)::int FROM mengshu_write_receipts
   WHERE result->>'memoryId' = $2::text) AS write_receipts,
  (SELECT count(*)::int FROM mengshu_job_v2_effect_receipts
   WHERE effect_key = 'extract_candidate.persist.v1') AS candidate_receipts,
  (SELECT count(*)::int FROM mengshu_job_v2_effect_receipts) AS effect_receipts,
	  (SELECT status FROM mengshu_jobs_v2 WHERE type = 'extract_graph') AS graph_status,
	  (SELECT attempts FROM mengshu_jobs_v2 WHERE type = 'extract_graph') AS graph_attempts,
	  (SELECT last_error_code FROM mengshu_jobs_v2
	   WHERE type = 'extract_graph') AS graph_error_code,
	  (SELECT payload FROM mengshu_jobs_v2 WHERE type = 'extract_graph') AS graph_payload,
  (SELECT count(*)::int FROM mengshu_job_v2_effect_receipts
   WHERE effect_key = 'extract_graph.persist.v1') AS graph_receipts,
  (SELECT result FROM mengshu_job_v2_effect_receipts
   WHERE effect_key = 'extract_graph.persist.v1') AS graph_receipt_result,
  (SELECT count(*)::int FROM mengshu_jobs_v2 WHERE type = 'build_tree') AS tree_jobs,
  (SELECT count(*)::int FROM mengshu_job_v2_effect_receipts
   WHERE effect_key = 'build_tree.persist.v1') AS tree_receipts,
  ARRAY(SELECT DISTINCT tree_type FROM mengshu_tree_buffers ORDER BY tree_type) AS tree_types,
  ARRAY(SELECT DISTINCT node_type FROM mengshu_work_memory_nodes ORDER BY node_type) AS work_node_types,
  ARRAY(SELECT DISTINCT predicate FROM mengshu_work_memory_edges ORDER BY predicate) AS work_edge_predicates,
  (SELECT count(*)::int FROM mengshu_graph_entities) AS graph_entities,
  (SELECT count(*)::int FROM mengshu_graph_relations) AS graph_relations,
  (SELECT count(*)::int FROM mengshu_memory_evidence_links
   WHERE target_memory_id = $1::text AND evidence_memory_id = $2::text
     AND link_kind = 'grounded_by' AND source = 'entity_graph') AS memory_evidence_links,
  (SELECT count(*)::int FROM mengshu_graph_entity_evidence
   WHERE evidence_memory_id = $2::text) AS entity_evidence_links,
  (SELECT count(*)::int FROM mengshu_graph_relation_evidence
   WHERE evidence_memory_id = $2::text) AS relation_evidence_links,
  (SELECT count(*)::int FROM mengshu_graph_entity_aliases
   WHERE evidence_memory_id = $2::text) AS alias_projections,
  (SELECT last_error_code FROM mengshu_jobs_v2
   WHERE type = 'extract_candidate') AS last_error_code,
  (SELECT metadata FROM memories WHERE id = $1::uuid) AS active_metadata,
  (SELECT metadata FROM memories WHERE id = $2::uuid) AS evidence_metadata`,
            [activeMemoryId, evidenceId]);
          return result.rows[0]!;
        } finally {
          await client.end();
        }
      }, (value) => value.candidate_status === "completed" &&
        value.write_receipts === 1 && value.effect_receipts === 4 &&
        value.graph_status === "completed" && value.graph_receipts === 1 &&
        value.tree_jobs === 2 && value.tree_receipts === 2 &&
        value.tree_types.includes("source") && value.tree_types.includes("global") &&
        value.work_node_types.includes("evidence") && value.work_node_types.includes("memory") &&
        value.work_edge_predicates.includes("grounded_by") &&
        value.graph_entities === 2 && value.graph_relations === 1 &&
        value.memory_evidence_links === 1 && value.entity_evidence_links === 2 &&
        value.relation_evidence_links === 1 && value.alias_projections >= 2,
      "replayed active derivations");
      expect(completed).toMatchObject({
        candidate_status: "completed",
        candidate_attempts: 2,
        write_receipts: 1,
        candidate_receipts: 1,
        effect_receipts: 4,
        graph_status: "completed",
        graph_receipts: 1,
        tree_jobs: 2,
        tree_receipts: 2,
        tree_types: ["global", "source"],
        work_node_types: ["evidence", "memory"],
        work_edge_predicates: ["grounded_by"],
        graph_entities: 2,
        graph_relations: 1,
        memory_evidence_links: 1,
        entity_evidence_links: 2,
        relation_evidence_links: 1,
      });
      expect(Object.keys(completed.graph_payload).sort()).toEqual([
        "activeMemoryId", "evidenceId", "graphKind", "scope",
      ]);
      expect(completed.graph_payload).toEqual({
        scope: fullScope,
        graphKind: "entity",
        activeMemoryId,
        evidenceId,
      });
      expect(completed.graph_receipt_result).toMatchObject({
        createdEntities: 2,
        createdRelations: 1,
        entityIds: expect.arrayContaining([expect.any(String), expect.any(String)]),
        relationIds: [expect.any(String)],
        evidenceId,
        memoryEvidenceLinks: 1,
        entityEvidenceLinks: 2,
        relationEvidenceLinks: 1,
        aliasProjections: completed.alias_projections,
      });
      expect(completed.active_metadata).toMatchObject({
        admissionRoute: "active",
        semanticType: "rules",
        contextEligible: true,
        governance: {
          candidate: {
            treeRouting: {
              topicLabels: [],
              topicHotnessEligible: false,
            },
          },
        },
      });
      expect(completed.evidence_metadata).toMatchObject({
        admissionRoute: "evidence_only",
        contextEligible: false,
      });

      await restartedHost.stop();
      started = false;
      const replayAt = Date.now();
      const replayClient = new Client(config);
      await replayClient.connect();
      try {
        const forced = await replayClient.query(
          `UPDATE mengshu_jobs_v2
SET status = 'retry_wait', next_attempt_at = $1, lease_owner = NULL,
  lease_token = NULL, lease_until = NULL, heartbeat_at = NULL,
  last_error_code = 'LIVE_POST_COMMIT_REPLAY', last_error_retryable = TRUE,
  last_error_fingerprint = repeat('a', 64), updated_at = $1
WHERE type = 'extract_graph' AND status = 'completed'
RETURNING id`,
          [replayAt],
        );
        expect(forced.rowCount).toBe(1);
      } finally {
        await replayClient.end();
      }

      const replayProvider = new PostgresProvider(config, liveEmbeddingModel);
      const replayRuntime = createMengshuRuntime({
        config: runtimeConfig(config),
        resolvedDbPath: "",
        appId: scope.appId,
        defaultScope: fullScope,
        db: replayProvider,
        embeddings: deterministicEmbeddings(),
        llmClient,
      });
      replayHost = createServeRuntimeHost(replayRuntime, {
        authority,
        workerId: "worker-live-runtime-host-graph-replay",
        leaseMs: 10_000,
        heartbeatIntervalMs: 2_000,
        intervalMs: 25,
        maxPerTick: 10,
        stopTimeoutMs: 5_000,
      });
      activeRuntime = replayRuntime;
      await replayHost.start();
      started = true;

      const replayed = await waitFor(async () => {
        const client = new Client(config);
        await client.connect();
        try {
          const result = await client.query<{
            graph_status: string;
            graph_attempts: number;
            receipt_generation: number;
            graph_receipts: number;
            graph_entities: number;
            graph_relations: number;
            memory_evidence_links: number;
            entity_evidence_links: number;
            relation_evidence_links: number;
            alias_projections: number;
          }>(`SELECT
  (SELECT status FROM mengshu_jobs_v2 WHERE type = 'extract_graph') AS graph_status,
  (SELECT attempts FROM mengshu_jobs_v2 WHERE type = 'extract_graph') AS graph_attempts,
  (SELECT lease_generation FROM mengshu_job_v2_effect_receipts
   WHERE effect_key = 'extract_graph.persist.v1') AS receipt_generation,
  (SELECT count(*)::int FROM mengshu_job_v2_effect_receipts
   WHERE effect_key = 'extract_graph.persist.v1') AS graph_receipts,
  (SELECT count(*)::int FROM mengshu_graph_entities) AS graph_entities,
  (SELECT count(*)::int FROM mengshu_graph_relations) AS graph_relations,
  (SELECT count(*)::int FROM mengshu_memory_evidence_links
   WHERE target_memory_id = $1 AND evidence_memory_id = $2
     AND link_kind = 'grounded_by' AND source = 'entity_graph') AS memory_evidence_links,
  (SELECT count(*)::int FROM mengshu_graph_entity_evidence
   WHERE evidence_memory_id = $2) AS entity_evidence_links,
  (SELECT count(*)::int FROM mengshu_graph_relation_evidence
   WHERE evidence_memory_id = $2) AS relation_evidence_links,
  (SELECT count(*)::int FROM mengshu_graph_entity_aliases
   WHERE evidence_memory_id = $2) AS alias_projections`, [activeMemoryId, evidenceId]);
          return result.rows[0]!;
        } finally {
          await client.end();
        }
      }, (value) => value.graph_status === "completed" && value.graph_attempts === 2,
      "authoritative Entity Graph receipt replay");
      expect(replayed).toEqual({
        graph_status: "completed",
        graph_attempts: 2,
        receipt_generation: 1,
        graph_receipts: 1,
        graph_entities: 2,
        graph_relations: 1,
        memory_evidence_links: 1,
        entity_evidence_links: 2,
        relation_evidence_links: 1,
        alias_projections: completed.alias_projections,
      });

      const recalled = await activeRuntime.memoryService.recall({
        query: "PostgreSQL 真实测试验证",
        scope: fullScope,
        minScore: 0,
        limit: 10,
      });
      const activeHit = recalled.hits.find((hit) => hit.record.id === activeMemoryId);
      expect(activeHit, JSON.stringify({ recalled, completed })).toMatchObject({
        record: { id: activeMemoryId, semanticType: "rules", text: activeText },
        scoreBreakdown: {
          factors: {
            relevance: expect.any(Number),
            scopeFit: expect.any(Number),
            importance: expect.any(Number),
            confidence: expect.any(Number),
            evidenceWeight: expect.any(Number),
            recency: expect.any(Number),
          },
        },
      });

      const context = await activeRuntime.agentFastPath.context({
        scope: fullScope,
        task: "验证 PostgreSQL RuntimeHost 主链",
      });
      expect(context.slots.rules).toMatchObject({
        semanticType: "rules",
        sourceIds: [activeMemoryId],
        nodeCount: 1,
      });
      expect(context.slots.rules?.content).toContain("PostgreSQL");
      expect(context.slots.profile).toBeUndefined();
      expect(context.slots.task_context).toBeUndefined();
      expect(context.slots.experience).toBeUndefined();
      expect(context.slots.resource).toBeUndefined();
      expect(context.content).not.toContain(evidenceId);

      const evidenceClient = new Client(config);
      await evidenceClient.connect();
      try {
        const deleted = await evidenceClient.query(
          "DELETE FROM memories WHERE id = $1::uuid RETURNING id",
          [evidenceId],
        );
        expect(deleted.rowCount).toBe(1);
      } finally {
        await evidenceClient.end();
      }
      const withoutEvidence = await activeRuntime.memoryService.recall({
        query: "PostgreSQL 真实测试验证",
        scope: fullScope,
        minScore: 0,
        limit: 10,
      });
      expect(withoutEvidence.hits.some((hit) => hit.record.id === activeMemoryId)).toBe(false);
      } finally {
        if (started) await (replayHost ?? restartedHost ?? host).stop();
      }
    } finally {
      await isolated.dispose();
    }
  }, 90_000);
});
