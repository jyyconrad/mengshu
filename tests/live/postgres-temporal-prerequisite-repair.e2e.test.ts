import { createHash } from "node:crypto";

import pg from "pg";
import { describe, expect, test } from "vitest";

import { vectorDimsForModel } from "../../config.js";
import {
  executePostgresTemporalPrerequisiteRepair,
  planPostgresTemporalPrerequisiteRepair,
  verifyPostgresTemporalPrerequisiteRepair,
} from "../../packages/core/src/db/migrations/temporal-prerequisite-repair.js";
import { PostgresProvider } from "../../packages/core/src/db/providers/postgres.js";
import {
  executePostgresTemporalMemoryBackfill,
  loadPostgresTemporalMemoryBackfillSourceRows,
} from "../../packages/core/src/db/migrations/temporal-memory-backfill-executor.js";
import { planTemporalMemoryBackfill } from
  "../../packages/core/src/db/migrations/temporal-memory-backfill.js";
import { loadGlobalMengshuConfig, provisionGlobalPostgresTestSchema } from
  "./global-postgres-config.js";

const liveEnabled = process.env.MENGSHU_RUN_LIVE_TESTS === "1";

describe.skipIf(!liveEnabled)("PostgreSQL temporal prerequisite repair live e2e", () => {
  test("migrates pending to candidate and quarantines an exact duplicate", async () => {
    const isolated = await provisionGlobalPostgresTestSchema("temporal_repair");
    const global = loadGlobalMengshuConfig();
    const model = global.config.embedding.model ?? "text-embedding-3-small";
    const provider = new PostgresProvider(isolated.postgres, model);
    const client = new pg.Client({
      ...isolated.postgres,
      options: `-c search_path=${isolated.schema},public`,
    });
    const vector = Array.from({ length: vectorDimsForModel(model) }, (_, index) => index === 0 ? 1 : 0);
    const base = {
      vector, importance: 0.8, category: "decision" as const,
      dataType: "memory" as const, tableName: "memories" as const,
      createdAt: 1_000, tenantId: "tenant-repair", userId: "user-repair",
      canonicalProjectId: "project-repair", productId: "codex",
      producerId: "agent-repair", namespace: "memories", visibility: "private" as const,
    };
    const canonicalText = "release through CI";
    try {
      await provider.initialize();
      await provider.applyScopeContentHashDedupeContract({ maintenance: true, quiescenceConfirmed: true });
      await provider.store([{
        ...base,
        id: "00000000-0000-4000-8000-00000000c001",
        text: canonicalText,
        contentHash: createHash("sha256").update(canonicalText).digest("hex"),
        lifecycleStatus: "active",
        metadata: { semanticType: "rules", sourceNodeIds: ["evidence-ci"],
          embeddingSpaceId: `embedding-space:v1:${"a".repeat(64)}`,
          embeddingSpaceState: "known-queryable" },
      }, {
        ...base,
        id: "00000000-0000-4000-8000-00000000c002",
        text: "pending task",
        contentHash: createHash("sha256").update("pending task").digest("hex"),
        lifecycleStatus: "pending" as never,
        metadata: { semanticType: "task_context",
          embeddingSpaceId: `embedding-space:v1:${"a".repeat(64)}`,
          embeddingSpaceState: "known-queryable" },
      }, {
        ...base,
        id: "00000000-0000-4000-8000-00000000c003",
        text: canonicalText,
        contentHash: "invalid-legacy-hash",
        lifecycleStatus: "active",
        metadata: { semanticType: "rules",
          embeddingSpaceId: `embedding-space:v1:${"a".repeat(64)}`,
          embeddingSpaceState: "known-queryable" },
      }]);
      await client.connect();
      const source = (await loadPostgresTemporalMemoryBackfillSourceRows(client))
        .filter((row) => row.id.endsWith("c001"));
      const temporalPlan = planTemporalMemoryBackfill(source, { runId: "repair-seed", createdAt: 2_000 });
      await executePostgresTemporalMemoryBackfill(client, source, temporalPlan, {
        mode: "apply", maintenance: true, quiescenceConfirmed: true,
      });

      const plan = await planPostgresTemporalPrerequisiteRepair(client, {
        runId: "repair-live", createdAt: 3_000,
      });
      expect(plan.counts).toEqual({ scanned: 2, repaired: 2, review: 0 });
      await expect(executePostgresTemporalPrerequisiteRepair(client, plan, {
        maintenance: true, quiescenceConfirmed: true,
      })).resolves.toMatchObject({ repaired: 2, review: 0, state: "applied" });
      await expect(verifyPostgresTemporalPrerequisiteRepair(client, plan, 4_000))
        .resolves.toMatchObject({ repaired: 2, state: "verified" });
      const candidates = await client.query(
        "SELECT COUNT(*)::int AS candidates FROM mengshu_candidates",
      );
      const quarantined = await client.query(
        "SELECT COUNT(*)::int AS quarantined FROM memories WHERE legacy_quarantine_reason IS NOT NULL",
      );
      expect(candidates.rows[0]?.candidates).toBe(1);
      expect(quarantined.rows[0]?.quarantined).toBe(2);
    } finally {
      await client.end().catch(() => undefined);
      await provider.close();
      await isolated.dispose();
    }
  }, 120_000);
});
