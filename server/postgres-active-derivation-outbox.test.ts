import { describe, expect, test, vi } from "vitest";

import {
  ActiveDerivationOutboxConsumer,
  PostgresActiveDerivationOutboxRepository,
} from "./postgres-active-derivation-outbox.js";

const EVENT = "a".repeat(64);
const STORAGE = "b".repeat(64);
const MEMORY = "11111111-1111-4111-8111-111111111111";

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: EVENT,
    storage_key: STORAGE,
    topic: "memory.written",
    memory_id: MEMORY,
    tenant_id: "tenant-a",
    user_id: "user-a",
    canonical_project_id: "project-a",
    product_id: "app-a",
    producer_id: "agent-a",
    namespace: "working-context",
    visibility: "private",
    workspace_id: "workspace-a",
    session_id: "session-a",
    occurred_at: "100",
    derivation_eligible: true,
    ...overrides,
  };
}

describe("PostgresActiveDerivationOutboxRepository", () => {
  test("claims pending rows with keyset order and skip locked under one transaction", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
        calls.push({ sql, params });
        return sql.includes("SELECT outbox.event_id")
          ? { rows: [row()], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const repository = new PostgresActiveDerivationOutboxRepository({
      connect: async () => client,
    });

    await expect(repository.claimPending({ limit: 20 })).resolves.toEqual([{
      eventId: EVENT,
      storageKey: STORAGE,
      memoryId: MEMORY,
      scope: {
        tenantId: "tenant-a", userId: "user-a", appId: "app-a", projectId: "project-a",
        agentId: "agent-a", namespace: "working-context", visibility: "private",
      },
      context: { workspaceId: "workspace-a", sessionId: "session-a" },
      occurredAt: 100,
      derivationEligible: true,
    }]);
    expect(calls.map((call) => call.sql)).toEqual([
      "BEGIN",
      expect.stringContaining("FOR UPDATE OF outbox SKIP LOCKED"),
      "COMMIT",
    ]);
    expect(calls[1]!.sql).toContain("ORDER BY outbox.occurred_at, outbox.event_id");
    expect(calls[1]!.sql).toContain("published_at IS NULL");
    expect(calls[1]!.sql).toContain("AS derivation_eligible");
    expect(calls[1]!.sql).toContain("COALESCE((memory.data_type = 'memory'");
    expect(calls[1]!.sql).toContain("extract(epoch FROM outbox.occurred_at) * 1000");
    expect(calls[1]!.sql).toContain("metadata->>'admissionRoute' = 'active'");
    expect(calls[1]!.sql).toContain("memory.data_type = 'memory'");
    expect(calls[1]!.sql).toContain("memory.metadata->>'memoryContainer' IN");
    expect(calls[1]!.sql).toContain("memory.legacy_quarantine_reason IS NULL");
    expect(calls[1]!.sql).toContain("memory.metadata #>> '{governance,provenance,sessionId}'");
    expect(calls[1]!.sql).toContain(
      "memory.metadata->>'sessionId' = memory.metadata #>> '{governance,provenance,sessionId}'",
    );
    expect(client.release).toHaveBeenCalledOnce();
  });

  test("canonicalizes legacy NULL workspace/session to empty outbox context", async () => {
    const query = vi.fn(async (sql: string) => sql.includes("SELECT outbox.event_id")
      ? { rows: [row({ workspace_id: "", session_id: "" })], rowCount: 1 }
      : { rows: [], rowCount: 0 });
    const repository = new PostgresActiveDerivationOutboxRepository({
      connect: async () => ({ query, release: () => undefined }),
    });

    await expect(repository.claimPending({ limit: 1 })).resolves.toEqual([
      expect.objectContaining({ context: {} }),
    ]);
    const sql = query.mock.calls[1]?.[0] ?? "";
    expect(sql).toContain("COALESCE(outbox.workspace_id, '') AS workspace_id");
    expect(sql).toContain("COALESCE(outbox.session_id, '') AS session_id");
    expect(sql).toContain("LEFT JOIN memories memory");
  });

  test("acks exact event/scope only after successful derivation", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({
      rows: [{ event_id: EVENT }],
      rowCount: 1,
    }));
    const repository = new PostgresActiveDerivationOutboxRepository({
      connect: async () => ({ query, release: () => undefined }),
    });
    const event = (await new PostgresActiveDerivationOutboxRepository({
      connect: async () => ({
        query: async (sql) => sql === "BEGIN" || sql === "COMMIT"
          ? { rows: [], rowCount: 0 }
          : { rows: [row()], rowCount: 1 },
        release: () => undefined,
      }),
    }).claimPending({ limit: 1 }))[0]!;

    await expect(repository.ackPublished(event, 200)).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(expect.stringMatching(
      /COALESCE\(workspace_id, ''\) = \$9[\s\S]*COALESCE\(session_id, ''\) = \$10/,
    ), [
      EVENT, "tenant-a", "user-a", "project-a", "app-a", "agent-a", "working-context",
      "private", "workspace-a", "session-a", 200, MEMORY, STORAGE,
    ]);
    expect(query.mock.calls[0]?.[0]).toContain("to_timestamp($11::double precision / 1000.0)");
  });
});

describe("ActiveDerivationOutboxConsumer", () => {
  test("failure remains pending; replay derives deterministically and only then acks", async () => {
    const event = {
      eventId: EVENT, storageKey: STORAGE, memoryId: MEMORY,
      scope: {
        tenantId: "tenant-a", userId: "user-a", appId: "app-a", projectId: "project-a",
        agentId: "agent-a", namespace: "working-context", visibility: "private" as const,
      },
      context: { workspaceId: "workspace-a", sessionId: "session-a" },
      occurredAt: 100,
      derivationEligible: true,
    };
    const ackPublished = vi.fn(async () => true);
    const derive = vi.fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce(undefined);
    const consumer = new ActiveDerivationOutboxConsumer({
      repository: { claimPending: async () => [event], ackPublished },
      deriveCommittedActive: derive,
      now: () => 200,
    });

    await expect(consumer.drainOnce()).resolves.toMatchObject({
      read: 1, derived: 0, acknowledged: 0,
      failures: [{ eventId: EVENT, reason: "derivation_failed" }],
    });
    expect(ackPublished).not.toHaveBeenCalled();
    await expect(consumer.drainOnce()).resolves.toMatchObject({
      read: 1, derived: 1, acknowledged: 1, failures: [],
    });
    expect(derive).toHaveBeenCalledTimes(2);
    expect(derive).toHaveBeenLastCalledWith({
      scope: event.scope,
      context: event.context,
      activeMemoryIds: [MEMORY],
      signal: expect.any(AbortSignal),
    });
    expect(ackPublished).toHaveBeenCalledOnce();
  });

  test("ack CAS miss remains pending and is reported as retryable ack failure", async () => {
    const event = {
      eventId: EVENT, storageKey: STORAGE, memoryId: MEMORY,
      scope: {
        tenantId: "tenant-a", userId: "user-a", appId: "app-a", projectId: "project-a",
        agentId: "agent-a", namespace: "working-context", visibility: "private" as const,
      },
      context: {},
      occurredAt: 100,
      derivationEligible: true,
    };
    const consumer = new ActiveDerivationOutboxConsumer({
      repository: {
        claimPending: async () => [event],
        ackPublished: async () => false,
      },
      deriveCommittedActive: async () => undefined,
      now: () => 200,
    });

    await expect(consumer.drainOnce()).resolves.toEqual({
      read: 1,
      derived: 1,
      acknowledged: 0,
      failures: [{ eventId: EVENT, reason: "ack_failed" }],
    });
  });

  test("acks non-active memory events without invoking active derivation", async () => {
    const event = {
      eventId: EVENT, storageKey: STORAGE, memoryId: MEMORY,
      scope: {
        tenantId: "tenant-a", userId: "user-a", appId: "app-a", projectId: "project-a",
        agentId: "agent-a", namespace: "working-context", visibility: "private" as const,
      },
      context: {},
      occurredAt: 100,
      derivationEligible: false,
    };
    const deriveCommittedActive = vi.fn(async () => undefined);
    const ackPublished = vi.fn(async () => true);
    const consumer = new ActiveDerivationOutboxConsumer({
      repository: { claimPending: async () => [event], ackPublished },
      deriveCommittedActive,
      now: () => 200,
    });

    await expect(consumer.drainOnce()).resolves.toEqual({
      read: 1, derived: 0, acknowledged: 1, failures: [],
    });
    expect(deriveCommittedActive).not.toHaveBeenCalled();
    expect(ackPublished).toHaveBeenCalledWith(event, 200);
  });
});
