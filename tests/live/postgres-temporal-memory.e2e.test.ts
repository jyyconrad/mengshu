import { createHash, randomUUID } from "node:crypto";

import { describe, expect, test } from "vitest";

import { vectorDimsForModel } from "../../config.js";
import { PostgresProvider } from "../../packages/core/src/db/providers/postgres.js";
import { CURRENT_SCHEMA_VERSION } from
  "../../packages/core/src/db/migrations/schema-migrations.js";
import type { MemoryRecord, MemoryScope } from
  "../../packages/core/src/domain/types.js";
import { MemoryEvolutionService } from
  "../../packages/core/src/temporal/memory-evolution-service.js";
import {
  loadGlobalMengshuConfig,
  provisionGlobalPostgresTestSchema,
} from "./global-postgres-config.js";

const liveEnabled = process.env.MENGSHU_RUN_LIVE_TESTS === "1";

describe.skipIf(!liveEnabled)("PostgreSQL temporal memory live e2e", () => {
  test("migration + evolve + as-of + expire + purge remain atomic", async () => {
    const isolated = await provisionGlobalPostgresTestSchema("temporal_v28");
    const global = loadGlobalMengshuConfig();
    const embeddingModel = global.config.embedding.model ?? "text-embedding-3-small";
    const provider = new PostgresProvider(isolated.postgres, embeddingModel);
    const scope: MemoryScope = {
      tenantId: "tenant-temporal-live",
      userId: "user-temporal-live",
      appId: "codex",
      projectId: "project-temporal-live",
      agentId: "agent-temporal-live",
      namespace: "memories",
      visibility: "private",
    };
    const vector = Array.from(
      { length: vectorDimsForModel(embeddingModel) },
      (_, index) => index === 0 ? 1 : 0,
    );
    let now = 1_000;
    const service = new MemoryEvolutionService(
      provider.createTemporalMemoryRepository(),
      { now: () => now, idFactory: randomUUID },
    );
    const memory = (text: string, createdAt: number): MemoryRecord => ({
      id: randomUUID(),
      scope,
      kind: "decision",
      semanticType: "rules",
      container: "project",
      lifecycleStatus: "active",
      confidence: 0.95,
      text,
      contentHash: createHash("sha256").update(text).digest("hex"),
      importance: 0.9,
      category: "decision",
      dataType: "memory",
      tableName: "memories",
      metadata: {
        admissionRoute: "active",
        contextEligible: true,
        embeddingSpaceId: `embedding-space:v1:${"a".repeat(64)}`,
        embeddingSpaceState: "known-queryable",
      },
      provenance: { source: "user", createdAt },
      sourceNodeIds: [`evidence-${createdAt}`],
      createdAt,
      vector,
    });

    try {
      await provider.initialize();
      await expect(provider.applyScopeContentHashDedupeContract({
        maintenance: true,
        quiescenceConfirmed: true,
      })).resolves.toMatchObject({
        currentVersion: CURRENT_SCHEMA_VERSION,
        targetVersion: CURRENT_SCHEMA_VERSION,
        scopeContentHashDedupe: "ready",
      });
      const v1 = memory("manual release", 100);
      const v2 = memory("CI approval release", 200);
      await service.bootstrap({
        scope,
        lineageId: "release-process",
        record: v1,
        validFrom: 100,
        idempotencyKey: "bootstrap-release",
      });
      now = 2_000;
      await service.evolve({
        scope,
        lineageId: "release-process",
        expectedHeadRevision: 1,
        record: v2,
        validFrom: 200,
        reason: "workflow upgraded",
        idempotencyKey: "evolve-release",
      });

      await expect(service.current({ scope, lineageId: "release-process", at: 250 }))
        .resolves.toMatchObject({ record: { id: v2.id }, revision: 2, historical: false });
      await expect(service.recallAsOf({ scope, lineageId: "release-process", asOf: 150 }))
        .resolves.toMatchObject({ record: { id: v1.id }, revision: 1, historical: true });

      now = 3_000;
      await service.expire({
        scope,
        lineageId: "release-process",
        expectedHeadRevision: 2,
        validTo: 300,
        reason: "project completed",
        idempotencyKey: "expire-release",
      });
      await expect(service.current({ scope, lineageId: "release-process", at: 300 }))
        .resolves.toBeUndefined();

      const temporary = memory("temporary task context", 250);
      await service.bootstrap({
        scope,
        lineageId: "temporary-context",
        record: temporary,
        validFrom: 250,
        idempotencyKey: "bootstrap-temporary",
      });
      await service.expire({
        scope,
        lineageId: "temporary-context",
        expectedHeadRevision: 1,
        validTo: 3_500,
        reason: "task ttl",
        idempotencyKey: "expire-temporary",
      });
      await expect(service.current({ scope, lineageId: "temporary-context", at: 3_499 }))
        .resolves.toMatchObject({ record: { id: temporary.id, lifecycleStatus: "active" } });
      await expect(service.current({ scope, lineageId: "temporary-context", at: 3_500 }))
        .resolves.toBeUndefined();
      now = 3_500;
      await expect(service.materializeExpired()).resolves.toBe(1);
      await expect(service.history({ scope, lineageId: "temporary-context" }))
        .resolves.toMatchObject({
          head: { latestRevision: 1 },
          versions: [{
            validTo: 3_500,
            closedAt: 3_500,
            record: { id: temporary.id, lifecycleStatus: "archived" },
          }],
        });

      now = 4_000;
      const purged = await service.purge({
        scope,
        lineageId: "release-process",
        confirmation: "PURGE",
        idempotencyKey: "purge-release",
      });
      expect(purged).toMatchObject({ purgedVersions: 2 });
      expect(purged.derivedArtifactsPurged).toBeGreaterThan(0);
      expect(JSON.stringify(purged)).not.toContain("manual release");
      expect(JSON.stringify(purged)).not.toContain("CI approval release");
      await expect(service.history({ scope, lineageId: "release-process" }))
        .rejects.toMatchObject({ code: "MEMORY_LINEAGE_NOT_FOUND" });
    } finally {
      await provider.close();
      await isolated.dispose();
    }
  }, 120_000);
});
