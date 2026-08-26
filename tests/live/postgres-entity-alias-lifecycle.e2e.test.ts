import pg from "pg";
import { describe, expect, test } from "vitest";

import { CURRENT_SCHEMA_VERSION, SCHEMA_MIGRATIONS } from
  "../../packages/core/src/db/migrations/schema-migrations.js";
import { deriveAuthoritativeEntityGraph } from
  "../../packages/core/src/graph/authoritative-entity-graph-derivation.js";
import {
  canonicalizeAuthoritativeEntityGraphWithClient,
  persistEntityCanonicalizationPlanWithClient,
  type EntityCanonicalizationPlan,
  type PostgresEntityCanonicalizationClient,
} from "../../packages/core/src/graph/postgres-entity-canonicalization.js";
import type { GraphEntityRecord } from
  "../../packages/core/src/graph/types.js";
import type { MemoryScope } from
  "../../packages/core/src/domain/types.js";
import { provisionGlobalPostgresTestSchema } from "./global-postgres-config.js";

const { Client } = pg;
const liveEnabled = process.env.MENGSHU_RUN_LIVE_TESTS === "1";
const embeddingSpaceId = `embedding-space:v1:${"a".repeat(64)}`;

const scope: MemoryScope = Object.freeze({
  tenantId: "tenant-alias-live",
  userId: "user-alias-live",
  appId: "mengshu-alias-live",
  projectId: "project-alias-live",
  agentId: "agent-alias-live",
  namespace: "working-context",
  visibility: "private",
  workspaceId: "workspace-alias-live",
  sessionId: "session-alias-live",
});

function entity(
  id: string,
  canonicalName: string,
  alias: string,
  createdAt: number,
): GraphEntityRecord {
  return {
    id,
    scope,
    canonicalName,
    displayName: canonicalName,
    type: "person",
    aliases: [alias],
    mentionCount: 1,
    mentionCount30d: 1,
    distinctSourceCount: 1,
    lastSeenAt: createdAt,
    hotness: 0.5,
    queryHits30d: 0,
    status: "active",
    createdAt,
    updatedAt: createdAt,
    metadata: { source: "live-alias-lifecycle" },
  };
}

function graph(
  id: string,
  canonicalName: string,
  alias: string,
  createdAt: number,
) {
  return deriveAuthoritativeEntityGraph({
    graphKind: "entity",
    memoryId: `memory-${id}`,
    evidence: {
      authority: "persisted_evidence",
      evidenceId: `evidence-${id}`,
      scope,
      text: `${canonicalName} is also known as ${alias}`,
      sourceId: `source-${id}`,
      sourceKind: "postgres-live-test",
      createdAt,
    },
    extraction: {
      entities: [entity(id, canonicalName, alias, createdAt)],
      relations: [],
    },
  });
}

function aliasOnly(
  plan: EntityCanonicalizationPlan,
  normalizedAlias: string,
): EntityCanonicalizationPlan {
  const binding = plan.aliasBindings.find((item) =>
    item.normalizedAlias === normalizedAlias);
  if (!binding) throw new Error(`missing alias binding: ${normalizedAlias}`);
  return Object.freeze({
    ...plan,
    entityResolutions: Object.freeze([]),
    relationResolutions: Object.freeze([]),
    aliasBindings: Object.freeze([binding]),
    embeddings: Object.freeze([]),
    relatedRelations: Object.freeze([]),
    relatedRelationEvidenceLinks: Object.freeze([]),
  });
}

function queryAdapter(client: pg.Client): PostgresEntityCanonicalizationClient {
  return {
    async query(sql: string, params: readonly unknown[] = []) {
      const result = await client.query(sql, [...params]);
      return { rows: result.rows, rowCount: result.rowCount };
    },
  };
}

async function provisionCanonicalAliasSchema(client: pg.Client): Promise<void> {
  const graphEntityDdl = SCHEMA_MIGRATIONS.flatMap((migration) => migration.statements)
    .find((statement) => statement.startsWith(
      "CREATE TABLE IF NOT EXISTS mengshu_graph_entities (",
    ));
  const aliasMigration = SCHEMA_MIGRATIONS.find((migration) => migration.version === 17);
  const aliasDdl = aliasMigration?.statements.filter((statement) =>
    statement.includes("mengshu_graph_entity_alias_bindings"));
  if (!graphEntityDdl || aliasMigration?.name !== "add-canonical-entity-resolution-journal" ||
      !aliasDdl || aliasDdl.length !== 3) {
    throw new Error("v17 canonical alias schema fixture is incomplete");
  }
  await client.query(graphEntityDdl);
  for (const statement of aliasDdl) await client.query(statement);
}

async function insertCanonicalEntity(
  client: pg.Client,
  derived: ReturnType<typeof graph>,
): Promise<void> {
  const item = derived.entities[0]!;
  await client.query(`INSERT INTO mengshu_graph_entities (
  id, scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id,
  namespace, visibility, workspace_id, session_id, canonical_name, display_name,
  entity_type, aliases, mention_count, mention_count_30d, distinct_source_count,
  last_seen_at, hotness, graph_centrality, query_hits_30d, status, merged_into,
  created_at, updated_at, metadata
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
  $15::jsonb, $16, $17, $18, $19, $20, $21, $22, $23, NULL, $24, $25, $26::jsonb
)`, [
    item.id, derived.scopeFingerprint, scope.tenantId, scope.userId, scope.appId,
    scope.projectId, scope.agentId, scope.namespace, scope.visibility,
    scope.workspaceId, scope.sessionId, item.canonicalName, item.displayName, item.type,
    JSON.stringify(item.aliases), item.mentionCount, item.mentionCount30d,
    item.distinctSourceCount, item.lastSeenAt ?? null, item.hotness,
    item.graphCentrality ?? null, item.queryHits30d, item.status,
    item.createdAt, item.updatedAt, JSON.stringify(item.metadata),
  ]);
}

async function createPlan(
  client: PostgresEntityCanonicalizationClient,
  jobId: string,
  derived: ReturnType<typeof graph>,
  normalizedAlias: string,
): Promise<EntityCanonicalizationPlan> {
  const plan = await canonicalizeAuthoritativeEntityGraphWithClient(client, {
    jobId,
    graph: derived,
    embeddings: {
      authority: "runtime_active_embedding_space",
      embeddingSpaceId,
      embeddingSpaceState: "known-queryable",
      vectors: [{ rawEntityId: derived.entities[0]!.id, vector: [1, 0] }],
    },
  });
  return aliasOnly(plan, normalizedAlias);
}

describe.skipIf(!liveEnabled)("PostgreSQL v17 canonical entity alias lifecycle", () => {
  test("retired 可重绑、同 owner exact replay 幂等、不同 active owner fail-closed", async () => {
    const isolated = await provisionGlobalPostgresTestSchema("entity_alias_lifecycle");
    let client: pg.Client | undefined;
    try {
      expect(CURRENT_SCHEMA_VERSION).toBe(24);

      client = new Client({
        ...isolated.postgres,
        options: `-c search_path=${isolated.schema}`,
      });
      await client.connect();
      const query = queryAdapter(client);
      await provisionCanonicalAliasSchema(client);
      const normalizedAlias = "shared-alias";

      const firstGraph = graph("owner-a", "owner alpha", normalizedAlias, 100);
      await client.query("BEGIN");
      const firstPlan = await createPlan(query, "job-alias-generation-a", firstGraph, normalizedAlias);
      await insertCanonicalEntity(client, firstPlan.graph);
      await persistEntityCanonicalizationPlanWithClient(query, firstPlan);
      await client.query("COMMIT");

      await client.query(`UPDATE mengshu_graph_entity_alias_bindings
SET status = 'retired', updated_at = $1, retired_at = $1
WHERE scope_fingerprint = $2 AND entity_type = $3
  AND normalized_alias = $4 AND status = 'active'`, [
        150, firstGraph.scopeFingerprint, "person", normalizedAlias,
      ]);

      const secondGraph = graph("owner-b", "owner beta", normalizedAlias, 200);
      const conflictingGraph = graph("owner-c", "owner gamma", normalizedAlias, 300);
      await client.query("BEGIN");
      const secondPlan = await createPlan(query, "job-alias-generation-b", secondGraph, normalizedAlias);
      const conflictingPlan = await createPlan(
        query,
        "job-alias-generation-c",
        conflictingGraph,
        normalizedAlias,
      );
      expect(secondPlan.aliasBindings[0]!.bindingId)
        .not.toBe(firstPlan.aliasBindings[0]!.bindingId);
      await insertCanonicalEntity(client, secondPlan.graph);
      await persistEntityCanonicalizationPlanWithClient(query, secondPlan);
      await client.query("COMMIT");

      const rebound = await client.query<{
        alias_binding_id: string;
        canonical_entity_id: string;
        status: string;
        retired_at: string | null;
      }>(`SELECT alias_binding_id, canonical_entity_id, status, retired_at
FROM mengshu_graph_entity_alias_bindings
WHERE scope_fingerprint = $1 AND entity_type = $2 AND normalized_alias = $3
ORDER BY created_at, alias_binding_id`, [
        firstGraph.scopeFingerprint, "person", normalizedAlias,
      ]);
      expect(rebound.rows).toEqual([
        {
          alias_binding_id: firstPlan.aliasBindings[0]!.bindingId,
          canonical_entity_id: "owner-a",
          status: "retired",
          retired_at: "150",
        },
        {
          alias_binding_id: secondPlan.aliasBindings[0]!.bindingId,
          canonical_entity_id: "owner-b",
          status: "active",
          retired_at: null,
        },
      ]);

      await client.query("BEGIN");
      const replayCanonicalization = await canonicalizeAuthoritativeEntityGraphWithClient(query, {
        jobId: "job-alias-generation-b",
        graph: secondGraph,
        embeddings: {
          authority: "runtime_active_embedding_space",
          embeddingSpaceId,
          embeddingSpaceState: "known-queryable",
          vectors: [{ rawEntityId: secondGraph.entities[0]!.id, vector: [1, 0] }],
        },
      });
      expect(replayCanonicalization.entityResolutions).toEqual([
        expect.objectContaining({
          rawEntityId: "owner-b",
          canonicalEntityId: "owner-b",
          method: "exact",
        }),
      ]);
      const replayPlan = aliasOnly(replayCanonicalization, normalizedAlias);
      expect(replayPlan.aliasBindings[0]!.bindingId)
        .toBe(secondPlan.aliasBindings[0]!.bindingId);
      await persistEntityCanonicalizationPlanWithClient(query, replayPlan);
      await client.query("COMMIT");
      const replay = await client.query<{ count: string }>(`SELECT count(*)::text AS count
FROM mengshu_graph_entity_alias_bindings
WHERE scope_fingerprint = $1 AND entity_type = $2 AND normalized_alias = $3`, [
        firstGraph.scopeFingerprint, "person", normalizedAlias,
      ]);
      expect(replay.rows).toEqual([{ count: "2" }]);

      await client.query("BEGIN");
      try {
        await insertCanonicalEntity(client, conflictingPlan.graph);
        await expect(persistEntityCanonicalizationPlanWithClient(query, conflictingPlan))
          .rejects.toThrow("ledger result is invalid");
      } finally {
        await client.query("ROLLBACK");
      }

      const activeOwner = await client.query<{
        canonical_entity_id: string;
        status: string;
      }>(`SELECT canonical_entity_id, status
FROM mengshu_graph_entity_alias_bindings
WHERE scope_fingerprint = $1 AND entity_type = $2
  AND normalized_alias = $3 AND status = 'active'`, [
        firstGraph.scopeFingerprint, "person", normalizedAlias,
      ]);
      expect(activeOwner.rows).toEqual([{
        canonical_entity_id: "owner-b",
        status: "active",
      }]);
      const rolledBackOwner = await client.query<{ count: string }>(`SELECT count(*)::text AS count
FROM mengshu_graph_entities
WHERE scope_fingerprint = $1 AND id = 'owner-c'`, [firstGraph.scopeFingerprint]);
      expect(rolledBackOwner.rows).toEqual([{ count: "0" }]);
    } finally {
      if (client) await client.end();
      await isolated.dispose();
    }
  }, 120_000);
});
