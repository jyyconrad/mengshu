import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import type { MemoryRecord, MemoryScope } from "../domain/types.js";
import { InMemoryTemporalMemoryRepository } from "./in-memory-repository.js";
import {
  MemoryEvolutionError,
  MemoryEvolutionService,
} from "./memory-evolution-service.js";

const SCOPE: MemoryScope = Object.freeze({
  tenantId: "tenant-1",
  userId: "user-1",
  appId: "codex",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "memories",
  visibility: "private",
});

function record(id: string, text: string, at: number): MemoryRecord {
  return {
    id,
    scope: SCOPE,
    kind: "decision",
    semanticType: "rules",
    lifecycleStatus: "active",
    text,
    contentHash: createHash("sha256").update(text).digest("hex"),
    importance: 0.9,
    category: "decision",
    dataType: "memory",
    metadata: { admissionRoute: "active" },
    provenance: { source: "user", createdAt: at },
    sourceNodeIds: [`evidence-${id}`],
    createdAt: at,
  };
}

describe("MemoryEvolutionService", () => {
  test("future validFrom remains staged until due and never closes the current head early", async () => {
    let now = 200;
    const repository = new InMemoryTemporalMemoryRepository();
    const service = new MemoryEvolutionService(repository, {
      now: () => now,
      idFactory: () => `receipt-${now}`,
    });
    await service.bootstrap({
      scope: SCOPE,
      lineageId: "scheduled-policy",
      record: record("00000000-0000-4000-8000-000000000091", "policy v1", 100),
      validFrom: 100,
      idempotencyKey: "scheduled-bootstrap",
    });
    const staged = await service.evolve({
      scope: SCOPE,
      lineageId: "scheduled-policy",
      expectedHeadRevision: 1,
      record: record("00000000-0000-4000-8000-000000000092", "policy v2", 200),
      validFrom: 500,
      idempotencyKey: "scheduled-evolve",
    });
    expect(staged.version).toMatchObject({ revision: 2, activationState: "staged" });
    await expect(service.current({ scope: SCOPE, lineageId: "scheduled-policy", at: 300 }))
      .resolves.toMatchObject({ revision: 1, record: { text: "policy v1" } });
    await expect(service.current({ scope: SCOPE, lineageId: "scheduled-policy", at: 500 }))
      .resolves.toMatchObject({ revision: 2, record: { text: "policy v2" } });
    const before = await service.history({ scope: SCOPE, lineageId: "scheduled-policy" });
    expect(before.head).toMatchObject({
      latestRevision: 2,
      currentVersionRevision: 1,
    });
    expect(before.versions[0]).not.toHaveProperty("validTo");
    await expect(service.evolve({
      scope: SCOPE,
      lineageId: "scheduled-policy",
      expectedHeadRevision: 2,
      record: record("00000000-0000-4000-8000-000000000093", "policy v3", 250),
      validFrom: 250,
      idempotencyKey: "scheduled-overwrite",
    })).rejects.toMatchObject({ code: "MEMORY_VERSION_STALE" });

    now = 500;
    await expect(service.activateDue()).resolves.toBe(1);
    const after = await service.history({ scope: SCOPE, lineageId: "scheduled-policy" });
    expect(after.head).toMatchObject({ latestRevision: 2, currentVersionRevision: 2 });
    expect(after.versions).toEqual([
      expect.objectContaining({
        revision: 1, validTo: 500, record: expect.objectContaining({ lifecycleStatus: "superseded" }),
      }),
      expect.objectContaining({
        revision: 2, activationState: "active",
        record: expect.objectContaining({ lifecycleStatus: "active" }),
      }),
    ]);
  });

  test("evolve 原子关闭旧 head，并让 current/as-of 返回不同版本", async () => {
    const repository = new InMemoryTemporalMemoryRepository();
    const service = new MemoryEvolutionService(repository, {
      now: () => 1_720_000_000_000,
      idFactory: () => "receipt-evolve",
    });
    await service.bootstrap({
      scope: SCOPE,
      lineageId: "release-process",
      record: record("00000000-0000-4000-8000-000000000001", "manual release", 100),
      validFrom: 100,
      idempotencyKey: "bootstrap-release",
    });

    const transitioned = await service.evolve({
      scope: SCOPE,
      lineageId: "release-process",
      expectedHeadRevision: 1,
      record: record("00000000-0000-4000-8000-000000000002", "CI approval release", 200),
      validFrom: 200,
      reason: "workflow upgraded",
      idempotencyKey: "evolve-release",
    });

    expect(transitioned.version.revision).toBe(2);
    expect(transitioned.version.previousVersionId)
      .toBe("00000000-0000-4000-8000-000000000001");
    await expect(service.current({ scope: SCOPE, lineageId: "release-process", at: 250 }))
      .resolves.toMatchObject({ record: { text: "CI approval release" }, revision: 2 });
    await expect(service.recallAsOf({
      scope: SCOPE,
      lineageId: "release-process",
      asOf: 150,
    })).resolves.toMatchObject({
      record: { text: "manual release" },
      historical: true,
      revision: 1,
      validTo: 200,
    });
  });

  test("并发 stale head 被稳定拒绝，幂等重放返回原 receipt", async () => {
    const repository = new InMemoryTemporalMemoryRepository();
    const service = new MemoryEvolutionService(repository, {
      now: () => 300,
      idFactory: () => "receipt-stable",
    });
    await service.bootstrap({
      scope: SCOPE,
      lineageId: "deploy",
      record: record("00000000-0000-4000-8000-000000000011", "deploy v1", 100),
      validFrom: 100,
      idempotencyKey: "bootstrap-deploy",
    });
    const input = {
      scope: SCOPE,
      lineageId: "deploy",
      expectedHeadRevision: 1,
      record: record("00000000-0000-4000-8000-000000000012", "deploy v2", 200),
      validFrom: 200,
      idempotencyKey: "evolve-deploy",
    } as const;

    const first = await service.evolve(input);
    const replay = await service.evolve(input);
    expect(replay).toEqual({ ...first, replayed: true });
    await expect(service.evolve({
      ...input,
      record: record("00000000-0000-4000-8000-000000000013", "deploy v3", 250),
      idempotencyKey: "stale-deploy",
    })).rejects.toEqual(new MemoryEvolutionError("MEMORY_VERSION_STALE"));
  });

  test("corrected 旧版本不作为 as-of 事实，审计历史保留 invalidated 标记", async () => {
    const repository = new InMemoryTemporalMemoryRepository();
    const service = new MemoryEvolutionService(repository, {
      now: () => 300,
      idFactory: () => "receipt-correct",
    });
    await service.bootstrap({
      scope: SCOPE,
      lineageId: "endpoint",
      record: record("00000000-0000-4000-8000-000000000021", "endpoint is /old", 100),
      validFrom: 100,
      idempotencyKey: "bootstrap-endpoint",
    });
    await service.correct({
      scope: SCOPE,
      lineageId: "endpoint",
      expectedHeadRevision: 1,
      record: record("00000000-0000-4000-8000-000000000022", "endpoint is /new", 200),
      validFrom: 100,
      reason: "original record was wrong",
      idempotencyKey: "correct-endpoint",
    });

    await expect(service.recallAsOf({ scope: SCOPE, lineageId: "endpoint", asOf: 150 }))
      .resolves.toMatchObject({
        record: { text: "endpoint is /new" },
        revision: 2,
        transitionType: "corrected",
      });
    const history = await service.history({ scope: SCOPE, lineageId: "endpoint" });
    expect(history.versions).toEqual([
      expect.objectContaining({ revision: 1, invalidated: true }),
      expect.objectContaining({ revision: 2, transitionType: "corrected" }),
    ]);
  });

  test("restore 复制历史内容为新 revision，expire 在读取时立即排除 head", async () => {
    let now = 300;
    const repository = new InMemoryTemporalMemoryRepository();
    const service = new MemoryEvolutionService(repository, {
      now: () => now,
      idFactory: () => `receipt-${now}`,
    });
    const v1 = record("00000000-0000-4000-8000-000000000031", "manual", 100);
    await service.bootstrap({
      scope: SCOPE,
      lineageId: "rollback",
      record: v1,
      validFrom: 100,
      idempotencyKey: "bootstrap-rollback",
    });
    await service.evolve({
      scope: SCOPE,
      lineageId: "rollback",
      expectedHeadRevision: 1,
      record: record("00000000-0000-4000-8000-000000000032", "automated", 200),
      validFrom: 200,
      idempotencyKey: "evolve-rollback",
    });
    const restored = await service.restore({
      scope: SCOPE,
      lineageId: "rollback",
      expectedHeadRevision: 2,
      sourceVersionId: v1.id,
      record: record("00000000-0000-4000-8000-000000000033", "manual", 300),
      validFrom: 300,
      reason: "automation rolled back",
      idempotencyKey: "restore-rollback",
    });
    expect(restored.version).toMatchObject({ revision: 3, restoredFromVersionId: v1.id });

    now = 400;
    await service.expire({
      scope: SCOPE,
      lineageId: "rollback",
      expectedHeadRevision: 3,
      validTo: 400,
      reason: "project completed",
      idempotencyKey: "expire-rollback",
    });
    await expect(service.current({ scope: SCOPE, lineageId: "rollback", at: 400 }))
      .resolves.toBeUndefined();

    now = 500;
    const restoredAfterExpiration = await service.restore({
      scope: SCOPE,
      lineageId: "rollback",
      expectedHeadRevision: 3,
      sourceVersionId: v1.id,
      record: record("00000000-0000-4000-8000-000000000034", "manual", 500),
      validFrom: 500,
      reason: "historical procedure restored after expiration",
      idempotencyKey: "restore-expired-rollback",
    });
    expect(restoredAfterExpiration.version).toMatchObject({
      revision: 4,
      restoredFromVersionId: v1.id,
    });
    expect("previousVersionId" in restoredAfterExpiration.version).toBe(false);
  });

  test("future expiration remains current until validTo and is materialized after it is due", async () => {
    let now = 200;
    const repository = new InMemoryTemporalMemoryRepository();
    const service = new MemoryEvolutionService(repository, {
      now: () => now,
      idFactory: () => "receipt-future-expiry",
    });
    await service.bootstrap({
      scope: SCOPE,
      lineageId: "temporary-context",
      record: record("00000000-0000-4000-8000-000000000035", "temporary", 100),
      validFrom: 100,
      idempotencyKey: "bootstrap-temporary",
    });
    const scheduled = await service.expire({
      scope: SCOPE,
      lineageId: "temporary-context",
      expectedHeadRevision: 1,
      validTo: 500,
      reason: "task ttl",
      idempotencyKey: "expire-temporary",
    });
    expect(scheduled.version).toMatchObject({
      validTo: 500,
      record: { lifecycleStatus: "active" },
    });
    expect(scheduled.version).not.toHaveProperty("closedAt");
    await expect(service.current({ scope: SCOPE, lineageId: "temporary-context", at: 499 }))
      .resolves.toMatchObject({ revision: 1 });
    await expect(service.current({ scope: SCOPE, lineageId: "temporary-context", at: 500 }))
      .resolves.toBeUndefined();

    now = 500;
    await expect(service.materializeExpired()).resolves.toBe(1);
    const history = await service.history({ scope: SCOPE, lineageId: "temporary-context" });
    expect(history.head).not.toHaveProperty("currentVersionId");
    expect(history.versions[0]).toMatchObject({
      validTo: 500,
      closedAt: 500,
      record: { lifecycleStatus: "archived" },
    });
    await expect(service.materializeExpired()).resolves.toBe(0);
  });

  test("revoke is distinct from expire and never returns the withdrawn version as an as-of fact", async () => {
    let now = 200;
    const repository = new InMemoryTemporalMemoryRepository();
    const service = new MemoryEvolutionService(repository, {
      now: () => now,
      idFactory: () => "receipt-revoke",
    });
    await service.bootstrap({
      scope: SCOPE,
      lineageId: "withdrawn-rule",
      record: record("00000000-0000-4000-8000-000000000081", "obsolete rule", 100),
      validFrom: 100,
      idempotencyKey: "revoke-bootstrap",
    });
    const input = {
      scope: SCOPE,
      lineageId: "withdrawn-rule",
      expectedHeadRevision: 1,
      reason: "owner withdrew this rule",
      idempotencyKey: "revoke-rule",
    } as const;
    const revoked = await service.revoke(input);
    expect(revoked).toMatchObject({
      version: {
        record: { lifecycleStatus: "revoked" },
        validTo: 200,
        invalidated: true,
      },
      receipt: { transitionType: "revoked" },
      replayed: false,
    });
    await expect(service.current({ scope: SCOPE, lineageId: "withdrawn-rule", at: 150 }))
      .resolves.toBeUndefined();
    await expect(service.recallAsOf({ scope: SCOPE, lineageId: "withdrawn-rule", asOf: 150 }))
      .resolves.toBeUndefined();
    now = 300;
    await expect(service.revoke(input)).resolves.toEqual({ ...revoked, replayed: true });
    const history = await service.history({ scope: SCOPE, lineageId: "withdrawn-rule" });
    expect(history.versions[0]).toMatchObject({ invalidated: true, transitionReason: input.reason });
  });

  test("purge 擦除正文和派生内容，失败时 fail-closed", async () => {
    const repository = new InMemoryTemporalMemoryRepository({
      purgeDerived: async (versionIds) => versionIds.length,
    });
    const service = new MemoryEvolutionService(repository, {
      now: () => 500,
      idFactory: () => "purge-operation",
    });
    await service.bootstrap({
      scope: SCOPE,
      lineageId: "secret",
      record: record("00000000-0000-4000-8000-000000000041", "sensitive body", 100),
      validFrom: 100,
      idempotencyKey: "bootstrap-secret",
    });
    const receipt = await service.purge({
      scope: SCOPE,
      lineageId: "secret",
      confirmation: "PURGE",
      idempotencyKey: "purge-secret",
    });
    expect(receipt).toMatchObject({ purgedVersions: 1, derivedArtifactsPurged: 1 });
    expect(JSON.stringify(receipt)).not.toContain("sensitive body");
    await expect(service.history({ scope: SCOPE, lineageId: "secret" }))
      .rejects.toEqual(new MemoryEvolutionError("MEMORY_LINEAGE_NOT_FOUND"));

    const failing = new MemoryEvolutionService(new InMemoryTemporalMemoryRepository({
      purgeDerived: async () => { throw new Error("store unavailable"); },
    }), { now: () => 500 });
    await failing.bootstrap({
      scope: SCOPE,
      lineageId: "pending-purge",
      record: record("00000000-0000-4000-8000-000000000042", "must remain unreadable", 100),
      validFrom: 100,
      idempotencyKey: "bootstrap-pending",
    });
    await expect(failing.purge({
      scope: SCOPE,
      lineageId: "pending-purge",
      confirmation: "PURGE",
      idempotencyKey: "purge-pending",
    })).rejects.toEqual(new MemoryEvolutionError("MEMORY_PURGE_PENDING"));
    await expect(failing.current({ scope: SCOPE, lineageId: "pending-purge", at: 500 }))
      .resolves.toBeUndefined();
  });

  test("pending purge is retried durably and remains unreadable until completion", async () => {
    let attempt = 0;
    const repository = new InMemoryTemporalMemoryRepository({
      purgeDerived: async (ids) => {
        attempt += 1;
        if (attempt === 1) throw new Error("temporary outage");
        return ids.length;
      },
    });
    const service = new MemoryEvolutionService(repository, {
      now: () => 500,
      idFactory: () => "purge-retry-operation",
    });
    await service.bootstrap({
      scope: SCOPE,
      lineageId: "retry-purge",
      record: record("00000000-0000-4000-8000-000000000061", "erase after retry", 100),
      validFrom: 100,
      idempotencyKey: "retry-bootstrap",
    });
    await expect(service.purge({
      scope: SCOPE,
      lineageId: "retry-purge",
      confirmation: "PURGE",
      idempotencyKey: "retry-purge-request",
    })).rejects.toMatchObject({ code: "MEMORY_PURGE_PENDING" });
    await expect(service.current({ scope: SCOPE, lineageId: "retry-purge" }))
      .resolves.toBeUndefined();
    await expect(service.retryPendingPurges()).resolves.toEqual({
      attempted: 1, completed: 1, failed: 0,
    });
    await expect(service.history({ scope: SCOPE, lineageId: "retry-purge" }))
      .rejects.toMatchObject({ code: "MEMORY_LINEAGE_NOT_FOUND" });
  });
});
