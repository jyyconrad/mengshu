import { randomUUID } from "node:crypto";

import pg from "pg";
import { describe, expect, test } from "vitest";

import { PostgresProvider } from
  "../../packages/core/src/db/providers/postgres.js";
import {
  CURRENT_SCHEMA_VERSION,
  DURABLE_JOB_STATE_CONSTRAINT_NAME,
} from
  "../../packages/core/src/db/migrations/schema-migrations.js";
import type { LlmClient } from
  "../../packages/core/src/runtime/llm/llm-client.js";
import type { MemoryRecord } from
  "../../packages/core/src/domain/types.js";
import {
  deriveDurableJobV2DomainDedupeKey,
  type DurableJobV2Scope,
} from "../../packages/core/src/storage/repositories/job-v2.js";
import type { TypeExtractor } from
  "../../packages/core/src/lifecycle/type-extractor.js";
import { createNativeDurableJobV2Composition } from
  "../../server/native-durable-job-v2-composition.js";
import { startDurableJobV2WorkerLoop } from
  "../../server/workers-v2.js";

const { Client } = pg;

const liveEnabled = process.env.MENGSHU_RUN_LIVE_TESTS === "1";
const EXPECTED_LEDGER = Object.freeze(Array.from(
  { length: CURRENT_SCHEMA_VERSION },
  (_, index) => index + 1,
));
const REQUIRED_V9_RELATIONS = Object.freeze([
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
]);
const REQUIRED_V9_INDEXES = Object.freeze([
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
]);

interface LivePostgresConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  readonly ssl: false;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the PostgreSQL v9 live test`);
  return value;
}

function liveConfig(): LivePostgresConfig {
  const database = requiredEnv("MENGSHU_LIVE_PG_DATABASE");
  const port = Number(requiredEnv("MENGSHU_LIVE_PG_PORT"));
  if (!/^mengshu_live_[a-z0-9_]+$/.test(database) ||
      process.env.MENGSHU_LIVE_PG_ALLOW_RESET !== "1" ||
      !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      "PostgreSQL v9 live test requires an explicitly resettable mengshu_live_* database",
    );
  }
  return Object.freeze({
    host: requiredEnv("MENGSHU_LIVE_PG_HOST"),
    port,
    database,
    user: requiredEnv("MENGSHU_LIVE_PG_USER"),
    password: requiredEnv("MENGSHU_LIVE_PG_PASSWORD"),
    ssl: false as const,
  });
}

async function resetDedicatedDatabase(config: LivePostgresConfig): Promise<void> {
  const client = new Client(config);
  await client.connect();
  try {
    const identity = await client.query<{ database: string; user: string }>(
      "SELECT current_database() AS database, current_user AS user",
    );
    expect(identity.rows).toEqual([{ database: config.database, user: config.user }]);
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public AUTHORIZATION CURRENT_USER");
  } finally {
    await client.end();
  }
}

async function ledger(config: LivePostgresConfig): Promise<number[]> {
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

const scope: DurableJobV2Scope = Object.freeze({
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
const chunkId = "chunk-live-v9-1";
const liveEmbeddingSpaceId = `embedding-space:v1:${"e".repeat(64)}`;
const text = "记住：Mengshu 必须使用 PostgreSQL，并且所有升级必须先完成真实测试验证，保留可重复的证据，绝不能跳过真实数据库端到端检查。";

const candidateExtractor: TypeExtractor = Object.freeze({
  name: "postgres-v9-live-fixture",
  async extract() {
    return [{
      semanticType: "rules" as const,
      kind: "constraint",
      text,
      evidenceQuote: text,
      confidence: 0.98,
      reason: "live fixture",
    }];
  },
});

const llmClient = Object.freeze({
  available: true,
  async complete() { return ""; },
  async summarize() { return ""; },
  async extractStructured() {
    return {
      entities: [
        { name: "Mengshu", type: "project" },
        { name: "PostgreSQL", type: "tool" },
      ],
      relations: [{
        subject: "Mengshu",
        predicate: "uses",
        object: "PostgreSQL",
        confidence: 0.96,
        evidence: "Mengshu 必须使用 PostgreSQL",
      }],
    };
  },
}) as LlmClient;

describe.skipIf(!liveEnabled)("PostgreSQL v9+ durable runtime live e2e", () => {
  test("fresh v1-v5 → maintenance current → exact-three effects → canonical reads", async () => {
    const config = liveConfig();
    expect(CURRENT_SCHEMA_VERSION).toBe(12);
    await resetDedicatedDatabase(config);

    const provider = new PostgresProvider(config, "text-embedding-3-small");
    const runtimeBundle = provider.createDurableJobV2RuntimeBundle({
      clock: Date.now,
      tokenFactory: () => randomUUID().replaceAll("-", ""),
      backoffMs: () => 25,
    });
    let worker: ReturnType<typeof startDurableJobV2WorkerLoop> | undefined;
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
WHERE to_regclass('public.' || relation) IS NOT NULL
ORDER BY relation`,
          [[...REQUIRED_V9_RELATIONS]],
        );
        expect(relations.rows.map(({ relation }) => relation).sort()).toEqual(
          [...REQUIRED_V9_RELATIONS].sort(),
        );
        const indexes = await catalogClient.query<{ index_name: string }>(
          `SELECT index_name
FROM unnest($1::text[]) AS index_name
WHERE to_regclass('public.' || index_name) IS NOT NULL
ORDER BY index_name`,
          [[...REQUIRED_V9_INDEXES]],
        );
        expect(indexes.rows.map(({ index_name }) => index_name).sort()).toEqual(
          [...REQUIRED_V9_INDEXES].sort(),
        );
        const durableStateConstraint = await catalogClient.query<{ definition: string }>(
          `SELECT pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.mengshu_jobs_v2'::regclass AND conname = $1`,
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
          embeddingSpaceId: liveEmbeddingSpaceId,
          embeddingSpaceState: "known-queryable",
        },
        provenance: { source: "user", createdAt: Date.now() - 1 },
        createdAt: Date.now() - 1,
        vector: Array.from({ length: 1536 }, () => 0.001),
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

      const composition = createNativeDurableJobV2Composition({
        runtimeBundle,
        scope,
        candidateComputation: { extractor: candidateExtractor },
        llmClient,
      });
      expect(composition.registry.types).toEqual([
        "build_tree",
        "extract_candidate",
        "extract_graph",
      ]);

      const eventAt = Date.now() - 1;
      const context = { workspaceId, sessionId };
      await runtimeBundle.repository.enqueue({
        id: "job-live-candidate",
        type: "extract_candidate",
        payload: { scope: fullScope, text, traceId: chunkId, intent: "remember" },
        dedupeKey: deriveDurableJobV2DomainDedupeKey(
          "extract_candidate",
          chunkId,
          context,
        ),
        scope,
        maxAttempts: 3,
      });
      await runtimeBundle.repository.enqueue({
        id: "job-live-tree",
        type: "build_tree",
        payload: {
          scope: fullScope,
          traceId: chunkId,
          treeType: "source",
          treeKey: sessionId,
          leaf: {
            id: chunkId,
            chunkId,
            sourceId: sessionId,
            text,
            eventAt,
          },
        },
        dedupeKey: deriveDurableJobV2DomainDedupeKey("build_tree", chunkId, context),
        scope,
        maxAttempts: 3,
      });
      await runtimeBundle.repository.enqueue({
        id: "job-live-graph",
        type: "extract_graph",
        payload: {
          scope: fullScope,
          chunkId,
          text,
          sourceId: sessionId,
          context: {
            projectName: scope.projectId,
            userName: scope.userId,
            agentName: scope.agentId,
          },
        },
        dedupeKey: deriveDurableJobV2DomainDedupeKey("extract_graph", chunkId, context),
        scope,
        maxAttempts: 3,
      });

      worker = startDurableJobV2WorkerLoop(runtimeBundle.repository, {
        scope,
        workerId: "worker-live-v9",
        leaseMs: 10_000,
        heartbeatIntervalMs: 2_000,
        intervalMs: 60_000,
        maxPerTick: 10,
        stopTimeoutMs: 5_000,
        registry: composition.registry,
      });
      const results = await worker.tick();
      expect(results.filter(({ status }) => status === "completed").map((result) =>
        "type" in result ? result.type : undefined,
      ).sort(), JSON.stringify(results)).toEqual([
        "build_tree", "extract_candidate", "extract_graph",
      ]);
      expect(results.at(-1)).toEqual({ status: "idle" });

      const tree = provider.createCanonicalTreeReadRepository(fullScope);
      await expect(tree.getLeaf(chunkId)).resolves.toMatchObject({
        id: chunkId,
        chunkId,
        sourceId: sessionId,
        text,
        scope: fullScope,
      });

      const graph = provider.createCanonicalGraphReadRepository(fullScope);
      const entities = await graph.findEntities({ scope: fullScope, limit: 10 });
      expect(entities.map(({ canonicalName }) => canonicalName).sort()).toEqual([
        "mengshu",
        "postgresql",
      ]);
      const relations = await graph.findRelations({ scope: fullScope, limit: 10 });
      expect(relations).toEqual(expect.arrayContaining([expect.objectContaining({
        predicate: "uses",
        confidence: 0.96,
        evidenceChunkIds: [chunkId],
      })]));

      const verifyClient = new Client(config);
      await verifyClient.connect();
      try {
        const candidate = await verifyClient.query<{
          text: string;
          semantic_type: string;
          source_job_id: string;
        }>(
          `SELECT text, semantic_type, source_job_id
FROM mengshu_candidates
WHERE source_job_id = $1`,
          ["job-live-candidate"],
        );
        expect(candidate.rows).toEqual([{
          text,
          semantic_type: "rules",
          source_job_id: "job-live-candidate",
        }]);
        const jobs = await verifyClient.query<{ type: string; status: string }>(
          "SELECT type, status FROM mengshu_jobs_v2 ORDER BY type",
        );
        expect(jobs.rows).toEqual([
          { type: "build_tree", status: "completed" },
          { type: "extract_candidate", status: "completed" },
          { type: "extract_graph", status: "completed" },
        ]);
        const receipts = await verifyClient.query<{ effect_key: string }>(
          "SELECT effect_key FROM mengshu_job_v2_effect_receipts ORDER BY effect_key",
        );
        expect(receipts.rows.map(({ effect_key }) => effect_key)).toEqual([
          "build_tree.persist.v1",
          "extract_candidate.persist.v1",
          "extract_graph.persist.v1",
        ]);
      } finally {
        await verifyClient.end();
      }
    } finally {
      if (worker) await worker.stop();
      await provider.close();
    }
  }, 60_000);
});
