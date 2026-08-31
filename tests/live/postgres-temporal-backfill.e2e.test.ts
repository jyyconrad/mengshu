import { createHash } from "node:crypto";

import pg from "pg";
import { describe, expect, test } from "vitest";

import { vectorDimsForModel } from "../../config.js";
import {
  executePostgresTemporalMemoryBackfill,
  loadPostgresTemporalMemoryBackfillSourceRows,
  rollbackPostgresTemporalMemoryBackfill,
  verifyPostgresTemporalMemoryBackfill,
} from "../../packages/core/src/db/migrations/temporal-memory-backfill-executor.js";
import { planTemporalMemoryBackfill } from
  "../../packages/core/src/db/migrations/temporal-memory-backfill.js";
import { PostgresProvider } from "../../packages/core/src/db/providers/postgres.js";
import { MemoryEvolutionService } from
  "../../packages/core/src/temporal/memory-evolution-service.js";
import {
  loadGlobalMengshuConfig,
  provisionGlobalPostgresTestSchema,
} from "./global-postgres-config.js";

const liveEnabled = process.env.MENGSHU_RUN_LIVE_TESTS === "1";

describe.skipIf(!liveEnabled)("PostgreSQL temporal legacy backfill live e2e", () => {
  test("apply yields readable snapshots and rollback restores the legacy row", async () => {
    const isolated = await provisionGlobalPostgresTestSchema("temporal_backfill");
    const global = loadGlobalMengshuConfig();
    const model = global.config.embedding.model ?? "text-embedding-3-small";
    const provider = new PostgresProvider(isolated.postgres, model);
    const client = new pg.Client({
      ...isolated.postgres,
      options: `-c search_path=${isolated.schema},public`,
    });
    const id = "00000000-0000-4000-8000-00000000b001";
    const text = "CI approval is required for releases";
    const contentHash = createHash("sha256").update(text).digest("hex");
    try {
      await provider.initialize();
      await provider.applyScopeContentHashDedupeContract({
        maintenance: true,
        quiescenceConfirmed: true,
      });
      const stored = await provider.store([{
        id,
        text,
        contentHash,
        vector: Array.from({ length: vectorDimsForModel(model) }, (_, index) => index === 0 ? 1 : 0),
        importance: 0.9,
        category: "decision",
        dataType: "memory",
        tableName: "memories",
        metadata: {
          semanticType: "rules",
          sourceNodeIds: ["evidence-backfill"],
          admissionRoute: "active",
          contextEligible: true,
          embeddingSpaceId: `embedding-space:v1:${"a".repeat(64)}`,
          embeddingSpaceState: "known-queryable",
        },
        createdAt: 1_000,
        tenantId: "tenant-backfill",
        userId: "user-backfill",
        canonicalProjectId: "project-backfill",
        productId: "codex",
        producerId: "agent-backfill",
        namespace: "memories",
        visibility: "private",
        lifecycleStatus: "active",
      }]);
      expect(stored).toMatchObject({ inserted: 1, duplicates: 0 });
      await client.connect();
      const source = await loadPostgresTemporalMemoryBackfillSourceRows(client);
      const plan = planTemporalMemoryBackfill(source, {
        runId: "live-temporal-backfill",
        createdAt: 2_000,
      });
      await expect(executePostgresTemporalMemoryBackfill(client, source, plan, {
        mode: "apply", maintenance: true, quiescenceConfirmed: true,
      })).resolves.toMatchObject({ applied: 1, review: 0, state: "applied" });
      await expect(verifyPostgresTemporalMemoryBackfill(client, plan, 3_000))
        .resolves.toMatchObject({ applied: 1, mismatches: 0, state: "verified" });

      const service = new MemoryEvolutionService(provider.createTemporalMemoryRepository());
      await expect(service.history({
        scope: {
          tenantId: "tenant-backfill", userId: "user-backfill", appId: "codex",
          projectId: "project-backfill", agentId: "agent-backfill",
          namespace: "memories", visibility: "private",
        },
        lineageId: plan.rows[0]!.lineageId!,
      })).resolves.toMatchObject({
        versions: [{ record: { id, text, contentHash }, revision: 1 }],
      });

      await expect(rollbackPostgresTemporalMemoryBackfill(client, plan, {
        maintenance: true, quiescenceConfirmed: true, now: 4_000,
      })).resolves.toMatchObject({ state: "rolled_back" });
      const restored = await client.query(
        "SELECT lineage_id, revision, lifecycle_status FROM memories WHERE id = $1::uuid",
        [id],
      );
      expect(restored.rows[0]).toMatchObject({
        lineage_id: null,
        revision: null,
        lifecycle_status: "active",
      });
    } finally {
      await client.end().catch(() => undefined);
      await provider.close();
      await isolated.dispose();
    }
  }, 120_000);
});
