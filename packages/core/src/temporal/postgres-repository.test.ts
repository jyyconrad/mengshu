import { createHash } from "node:crypto";

import { describe, expect, test, vi } from "vitest";

import type { MemoryRecord, MemoryScope } from "../domain/types.js";
import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import {
  PostgresTemporalMemoryRepository,
  type PostgresTemporalMemoryClient,
} from "./postgres-repository.js";
import type {
  MemoryTemporalVersion,
  MemoryVersionTransitionReceipt,
} from "./types.js";

const SCOPE: MemoryScope = Object.freeze({
  tenantId: "tenant-1",
  userId: "user-1",
  appId: "codex",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "memories",
  visibility: "private",
});
const FINGERPRINT = authorityScopeFingerprint(SCOPE);

function record(id: string, text: string, at: number): MemoryRecord {
  return {
    id,
    scope: SCOPE,
    kind: "decision",
    semanticType: "rules",
    container: "project",
    lifecycleStatus: "active",
    confidence: 0.9,
    text,
    contentHash: createHash("sha256").update(text).digest("hex"),
    importance: 0.9,
    category: "decision",
    dataType: "memory",
    metadata: { admissionRoute: "active", contextEligible: true },
    provenance: { source: "user", createdAt: at },
    sourceNodeIds: [`evidence-${id}`],
    createdAt: at,
    vector: [0.1, 0.2],
  };
}

function version(revision: number, text: string): MemoryTemporalVersion {
  const id = `00000000-0000-4000-8000-${String(revision).padStart(12, "0")}`;
  return {
    lineageId: "release-process",
    revision,
    record: record(id, text, revision * 100),
    ...(revision === 1
      ? {}
      : { previousVersionId: `00000000-0000-4000-8000-${String(revision - 1).padStart(12, "0")}` }),
    validFrom: revision * 100,
    recordedAt: revision * 1_000,
    transitionType: revision === 1 ? "created" : "evolved",
    invalidated: false,
    activationState: "active",
  };
}

function receipt(current: MemoryTemporalVersion): MemoryVersionTransitionReceipt {
  return {
    id: `receipt-${current.revision}`,
    idempotencyKey: `request-${current.revision}`,
    requestHash: String(current.revision).repeat(64).slice(0, 64),
    scopeFingerprint: FINGERPRINT,
    lineageId: current.lineageId,
    transitionType: current.transitionType,
    previousVersionId: current.previousVersionId,
    versionId: current.record.id,
    revision: current.revision,
    occurredAt: current.recordedAt,
  };
}

function result(rows: Record<string, unknown>[] = [], rowCount = rows.length) {
  return { rows, rowCount };
}

describe("PostgresTemporalMemoryRepository", () => {
  test("kind-only lookup versions retain archived visibility while temporal history advances", async () => {
    const next = version(1, "A verified kind-only fact");
    delete next.record.semanticType;
    next.record.kind = "fact";
    next.record.lifecycleStatus = "archived";
    next.record.metadata = { admissionRoute: "lookup_only", contextEligible: false };
    const calls: { sql: string; params: readonly unknown[] }[] = [];
    const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("stamp-version")) return result([{ id: next.record.id }]);
      if (sql.includes("advance-head")) return result([{ latest_revision: 1 }]);
      if (sql.includes("insert-receipt")) return result([{ receipt_id: receipt(next).id }]);
      if (sql.includes("insert-outbox")) return result([{ event_id: params[0] }]);
      return result();
    });
    const client = { query: query as PostgresTemporalMemoryClient["query"], release: vi.fn() };
    const repository = new PostgresTemporalMemoryRepository({ query: client.query, connect: async () => client }, {
      persistVersion: async () => ({ memoryId: next.record.id, stored: true }),
    });
    await repository.appendVersion({ scope: SCOPE, expectedHeadRevision: 0, version: next, receipt: receipt(next) });
    expect(calls.find(({ sql }) => sql.includes("stamp-version"))?.params[10]).toBe("archived");
  });
  test("future expiration schedules validTo without clearing the current head", async () => {
    const current = version(1, "temporary context");
    const expirationReceipt: MemoryVersionTransitionReceipt = {
      ...receipt(current),
      id: "receipt-expire",
      idempotencyKey: "expire-request",
      requestHash: "e".repeat(64),
      transitionType: "expired",
      versionId: undefined,
      previousVersionId: current.record.id,
      occurredAt: 2_000,
    };
    const calls: string[] = [];
    const query = vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes("receipt-lock")) return result();
      if (sql.includes("head-lock")) return result([{
        scope_fingerprint: FINGERPRINT, lineage_id: current.lineageId, latest_revision: 1,
        current_version_id: current.record.id, current_version_revision: 1, updated_at: 1_000,
      }]);
      if (sql.includes("close-head-state")) return result([{ id: current.record.id }]);
      if (sql.includes("insert-receipt")) return result([{ receipt_id: expirationReceipt.id }]);
      if (sql.includes("get-version")) return result([{
        id: current.record.id,
        text: current.record.text,
        content_hash: current.record.contentHash,
        lifecycle_status: "active",
        lineage_id: current.lineageId,
        revision: 1,
        valid_from_ms: "100",
        valid_to_ms: "5000",
        recorded_at_ms: "1000",
        closed_at_ms: null,
        temporal_invalidated: false,
        temporal_activation_state: "active",
        temporal_snapshot: current,
      }]);
      return result();
    });
    const typedQuery = query as unknown as PostgresTemporalMemoryClient["query"];
    const repository = new PostgresTemporalMemoryRepository({
      query: typedQuery,
      connect: async () => ({ query: typedQuery, release: vi.fn() }),
    });

    await expect(repository.closeHead({
      scope: SCOPE,
      lineageId: current.lineageId,
      expectedHeadRevision: 1,
      validTo: 5_000,
      reason: "ttl",
      transitionType: "expired",
      receipt: expirationReceipt,
    })).resolves.toMatchObject({
      version: { validTo: 5_000, record: { lifecycleStatus: "active" } },
    });
    expect(calls.some((sql) => sql.includes("clear-head"))).toBe(false);
    expect(calls.some((sql) => sql.includes("insert-outbox"))).toBe(false);
  });

  test("due expiration atomically archives the current version, clears the head and writes outbox", async () => {
    const calls: string[] = [];
    const query = vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes("lock-due-expirations")) return result([{
        scope_fingerprint: FINGERPRINT,
        lineage_id: "temporary-context",
        id: "00000000-0000-4000-8000-000000000001",
        revision: 1,
        valid_to_ms: "5000",
      }]);
      if (sql.includes("materialize-expired-version")) {
        return result([{ id: "00000000-0000-4000-8000-000000000001" }]);
      }
      if (sql.includes("materialize-expired-head")) return result([{ latest_revision: 1 }]);
      return result();
    });
    const typedQuery = query as unknown as PostgresTemporalMemoryClient["query"];
    const repository = new PostgresTemporalMemoryRepository({
      query: typedQuery,
      connect: async () => ({ query: typedQuery, release: vi.fn() }),
    });

    await expect(repository.materializeExpired(5_000, 100)).resolves.toBe(1);
    for (const marker of [
      "lock-due-expirations", "materialize-expired-version",
      "materialize-expired-head", "materialize-expired-outbox",
    ]) expect(calls.some((sql) => sql.includes(marker))).toBe(true);
    expect(calls[0]).toBe("BEGIN");
    expect(calls.at(-1)).toBe("COMMIT");
  });

  test("staged append advances latest revision without closing or replacing current head", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const next = {
      ...version(2, "future release"),
      validFrom: 5_000,
      recordedAt: 2_000,
      activationState: "staged" as const,
    };
    const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("receipt-lock")) return result();
      if (sql.includes("head-lock")) return result([{
        scope_fingerprint: FINGERPRINT, lineage_id: next.lineageId, latest_revision: 1,
        current_version_id: next.previousVersionId, current_version_revision: 1, updated_at: 1_000,
      }]);
      if (sql.includes("stamp-version")) return result([{ id: next.record.id }]);
      if (sql.includes("advance-staged-head")) return result([{ latest_revision: 2 }]);
      if (sql.includes("insert-receipt")) return result([{ receipt_id: "receipt-2" }]);
      if (sql.includes("insert-outbox")) return result([{ event_id: params[0] as string }]);
      return result();
    });
    const typedQuery = query as unknown as PostgresTemporalMemoryClient["query"];
    const persistVersion = vi.fn(async () => ({ memoryId: next.record.id, stored: true }));
    const repository = new PostgresTemporalMemoryRepository({
      query: typedQuery,
      connect: async () => ({ query: typedQuery, release: vi.fn() }),
    }, { persistVersion });

    await repository.appendVersion({
      scope: SCOPE, expectedHeadRevision: 1, version: next, receipt: receipt(next),
    });
    expect(calls.some(({ sql }) => sql.includes("temporal-repository:close-head"))).toBe(false);
    const stamp = calls.find(({ sql }) => sql.includes("stamp-version"));
    expect(stamp?.params).toContain("staged");
    expect(stamp?.params).toContain("archived");
    expect(calls.some(({ sql }) => sql.includes("advance-staged-head"))).toBe(true);
  });

  test("due activation atomically closes previous, activates staged version, advances head and outbox", async () => {
    const calls: string[] = [];
    const query = vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes("lock-due-activations")) return result([{
        scope_fingerprint: FINGERPRINT,
        lineage_id: "release-process",
        id: "00000000-0000-4000-8000-000000000002",
        revision: 2,
        valid_from_ms: 5_000,
        current_version_id: "00000000-0000-4000-8000-000000000001",
        current_version_revision: 1,
      }]);
      if (sql.includes("activate-close-previous")) {
        return result([{ id: "00000000-0000-4000-8000-000000000001" }]);
      }
      if (sql.includes("activate-version")) {
        return result([{ id: "00000000-0000-4000-8000-000000000002" }]);
      }
      if (sql.includes("activate-head")) return result([{ latest_revision: 2 }]);
      return result();
    });
    const typedQuery = query as unknown as PostgresTemporalMemoryClient["query"];
    const repository = new PostgresTemporalMemoryRepository({
      query: typedQuery,
      connect: async () => ({ query: typedQuery, release: vi.fn() }),
    });
    await expect(repository.activateDue(5_000, 100)).resolves.toBe(1);
    for (const marker of [
      "activate-close-previous", "activate-version", "activate-head", "activate-outbox",
    ]) expect(calls.some((sql) => sql.includes(marker))).toBe(true);
    expect(calls[0]).toBe("BEGIN");
    expect(calls.at(-1)).toBe("COMMIT");
  });

  test("appendVersion 在同一事务关闭旧 head、持久化新版本、CAS head 并写 receipt/outbox", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const next = version(2, "CI approval release");
    const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("temporal-repository:receipt-lock")) return result();
      if (sql.includes("temporal-repository:head-lock")) {
        return result([{
          scope_fingerprint: FINGERPRINT,
          lineage_id: next.lineageId,
          latest_revision: 1,
          current_version_id: next.previousVersionId,
          current_version_revision: 1,
          updated_at: 1_000,
        }]);
      }
      if (sql.includes("temporal-repository:close-head")) return result([{ id: next.previousVersionId }]);
      if (sql.includes("temporal-repository:stamp-version")) return result([{ id: next.record.id }]);
      if (sql.includes("temporal-repository:advance-head")) return result([{ latest_revision: 2 }]);
      if (sql.includes("temporal-repository:insert-receipt")) return result([{ receipt_id: "receipt-2" }]);
      if (sql.includes("temporal-repository:insert-outbox")) {
        return result([{ event_id: params[0] as string }]);
      }
      return result();
    });
    const typedQuery = query as unknown as PostgresTemporalMemoryClient["query"];
    const client: PostgresTemporalMemoryClient = { query: typedQuery, release: vi.fn() };
    const persistVersion = vi.fn(async () => ({ memoryId: next.record.id, stored: true }));
    const repository = new PostgresTemporalMemoryRepository({
      query: typedQuery,
      connect: async () => client,
    }, { persistVersion });

    await expect(repository.appendVersion({
      scope: SCOPE,
      expectedHeadRevision: 1,
      version: next,
      receipt: receipt(next),
    })).resolves.toMatchObject({ version: next, replayed: false });

    expect(persistVersion).toHaveBeenCalledOnce();
    const closeIndex = calls.findIndex(({ sql }) => sql.includes("temporal-repository:close-head"));
    const stampIndex = calls.findIndex(({ sql }) => sql.includes("temporal-repository:stamp-version"));
    const headIndex = calls.findIndex(({ sql }) => sql.includes("temporal-repository:advance-head"));
    const receiptIndex = calls.findIndex(({ sql }) => sql.includes("temporal-repository:insert-receipt"));
    const outboxIndex = calls.findIndex(({ sql }) => sql.includes("temporal-repository:insert-outbox"));
    expect(closeIndex).toBeGreaterThan(0);
    expect(stampIndex).toBeGreaterThan(closeIndex);
    expect(headIndex).toBeGreaterThan(stampIndex);
    expect(receiptIndex).toBeGreaterThan(headIndex);
    expect(outboxIndex).toBeGreaterThan(receiptIndex);
    expect(calls[0]?.sql).toBe("BEGIN");
    expect(calls.at(-1)?.sql).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  test("head CAS 不匹配时 rollback 且不持久化新版本", async () => {
    const calls: string[] = [];
    const next = version(2, "CI approval release");
    const query = vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes("temporal-repository:receipt-lock")) return result();
      if (sql.includes("temporal-repository:head-lock")) {
        return result([{
          scope_fingerprint: FINGERPRINT,
          lineage_id: next.lineageId,
          latest_revision: 2,
          current_version_id: "00000000-0000-4000-8000-000000000099",
          current_version_revision: 2,
          updated_at: 2_000,
        }]);
      }
      return result();
    });
    const typedQuery = query as unknown as PostgresTemporalMemoryClient["query"];
    const client: PostgresTemporalMemoryClient = { query: typedQuery, release: vi.fn() };
    const persistVersion = vi.fn();
    const repository = new PostgresTemporalMemoryRepository({
      query: typedQuery,
      connect: async () => client,
    }, { persistVersion });

    await expect(repository.appendVersion({
      scope: SCOPE,
      expectedHeadRevision: 1,
      version: next,
      receipt: receipt(next),
    })).rejects.toMatchObject({ code: "MEMORY_VERSION_STALE" });
    expect(persistVersion).not.toHaveBeenCalled();
    expect(calls.at(-1)).toBe("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });

  test("restore 在同一事务复验 source version 正文与 hash，冲突时不关闭当前 head", async () => {
    const calls: string[] = [];
    const restored = {
      ...version(3, "manual release"),
      transitionType: "restored" as const,
      restoredFromVersionId: "00000000-0000-4000-8000-000000000001",
      previousVersionId: "00000000-0000-4000-8000-000000000002",
    };
    const query = vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes("temporal-repository:receipt-lock")) return result();
      if (sql.includes("temporal-repository:head-lock")) {
        return result([{
          scope_fingerprint: FINGERPRINT,
          lineage_id: restored.lineageId,
          latest_revision: 2,
          current_version_id: restored.previousVersionId,
          current_version_revision: 2,
          updated_at: 2_000,
        }]);
      }
      if (sql.includes("temporal-repository:restore-source-lock")) {
        return result([{
          id: restored.restoredFromVersionId,
          text: "different historical body",
          content_hash: createHash("sha256").update("different historical body").digest("hex"),
        }]);
      }
      return result();
    });
    const typedQuery = query as unknown as PostgresTemporalMemoryClient["query"];
    const persistVersion = vi.fn();
    const repository = new PostgresTemporalMemoryRepository({
      query: typedQuery,
      connect: async () => ({ query: typedQuery, release: vi.fn() }),
    }, { persistVersion });

    await expect(repository.appendVersion({
      scope: SCOPE,
      expectedHeadRevision: 2,
      version: restored,
      receipt: receipt(restored),
    })).rejects.toMatchObject({ code: "MEMORY_VERSION_CONFLICT" });
    expect(calls.some((sql) => sql.includes("temporal-repository:restore-source-lock"))).toBe(true);
    expect(calls.some((sql) => sql.includes("temporal-repository:close-head"))).toBe(false);
    expect(persistVersion).not.toHaveBeenCalled();
    expect(calls.at(-1)).toBe("ROLLBACK");
  });

  test("purge 先提交 pending，再清理派生内容，最后删除 canonical 行并写最小 receipt", async () => {
    const calls: string[] = [];
    let connection = 0;
    const query = vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes("temporal-repository:purge-receipt-lock")) return result();
      if (sql.includes("temporal-repository:purge-head-lock")) {
        return result([{ latest_revision: 2, current_version_id: "version-2" }]);
      }
      if (sql.includes("temporal-repository:mark-purge-pending")) {
        return result([{ id: "version-1" }, { id: "version-2" }]);
      }
      if (sql.includes("temporal-repository:insert-purge-retry")) {
        return result([{ operation_id: "purge-1" }]);
      }
      if (sql.includes("temporal-repository:complete-derived-purge")) {
        return result([{ operation_id: "purge-1" }]);
      }
      if (sql.includes("temporal-repository:delete-versions")) return result([], 2);
      if (sql.includes("temporal-repository:delete-head")) {
        return result([{ lineage_id: "release-process" }]);
      }
      if (sql.includes("temporal-repository:insert-purge-receipt")) {
        return result([{ operation_id: "purge-1" }]);
      }
      if (sql.includes("temporal-repository:delete-purge-retry")) {
        return result([{ operation_id: "purge-1" }]);
      }
      return result();
    });
    const typedQuery = query as unknown as PostgresTemporalMemoryClient["query"];
    const clients = [0, 1].map((): PostgresTemporalMemoryClient => ({
      query: typedQuery,
      release: vi.fn(),
    }));
    const purgeDerived = vi.fn(async () => 4);
    const repository = new PostgresTemporalMemoryRepository({
      query: typedQuery,
      connect: async () => clients[connection++]!,
    }, { purgeDerived });

    await expect(repository.purge({
      scope: SCOPE,
      lineageId: "release-process",
      receipt: {
        operationId: "purge-1",
        idempotencyKey: "purge-request",
        requestHash: "a".repeat(64),
        scopeFingerprint: FINGERPRINT,
        lineageHash: "b".repeat(64),
        purgedVersions: 0,
        derivedArtifactsPurged: 0,
        occurredAt: 3_000,
      },
    })).resolves.toMatchObject({ purgedVersions: 2, derivedArtifactsPurged: 4 });

    expect(connection).toBe(2);
    expect(purgeDerived).toHaveBeenCalledWith(
      ["version-1", "version-2"],
      "release-process",
      FINGERPRINT,
    );
    expect(calls.filter((sql) => sql === "COMMIT")).toHaveLength(2);
    expect(calls.findIndex((sql) => sql.includes("mark-purge-pending")))
      .toBeLessThan(calls.findIndex((sql) => sql.includes("delete-versions")));
    expect(calls.findIndex((sql) => sql.includes("delete-head")))
      .toBeLessThan(calls.findIndex((sql) => sql.includes("delete-versions")));
  });

  test("durable purge retry claims with backoff and completes the persisted request", async () => {
    const request = {
      operationId: "purge-retry-1",
      idempotencyKey: "purge-retry-key",
      requestHash: "a".repeat(64),
      scopeFingerprint: FINGERPRINT,
      lineageHash: "b".repeat(64),
      purgedVersions: 0,
      derivedArtifactsPurged: 0,
      occurredAt: 3_000,
    };
    const calls: string[] = [];
    const query = vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes("claim-purge-retries")) return result([{
        scope_fingerprint: FINGERPRINT,
        lineage_id: "release-process",
        idempotency_key: request.idempotencyKey,
        request,
        attempts: 0,
      }]);
      if (sql.includes("purge-receipt-lock")) return result();
      if (sql.includes("purge-retry-lock")) return result([{
        request_hash: request.requestHash,
        request,
        version_ids: ["version-1", "version-2"],
        derived_artifacts_purged: 0,
        derived_complete: false,
      }]);
      if (sql.includes("purge-head-lock")) {
        return result([{ latest_revision: 2, current_version_id: "version-2" }]);
      }
      if (sql.includes("mark-purge-pending")) {
        return result([{ id: "version-1" }, { id: "version-2" }]);
      }
      if (sql.includes("complete-derived-purge")) return result([{ operation_id: request.operationId }]);
      if (sql.includes("delete-head")) return result([{ lineage_id: "release-process" }]);
      if (sql.includes("delete-versions")) return result([], 2);
      if (sql.includes("insert-purge-receipt")) return result([{ operation_id: request.operationId }]);
      if (sql.includes("delete-purge-retry")) return result([{ operation_id: request.operationId }]);
      return result();
    });
    const typedQuery = query as unknown as PostgresTemporalMemoryClient["query"];
    const repository = new PostgresTemporalMemoryRepository({
      query: typedQuery,
      connect: async () => ({ query: typedQuery, release: vi.fn() }),
    }, { purgeDerived: async () => 4 });

    await expect(repository.retryPendingPurges(10_000, 10)).resolves.toEqual({
      attempted: 1, completed: 1, failed: 0,
    });
    for (const marker of [
      "lease-purge-retry", "complete-derived-purge", "insert-purge-receipt",
      "delete-purge-retry",
    ]) expect(calls.some((sql) => sql.includes(marker))).toBe(true);
  });
});
