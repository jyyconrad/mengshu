import { describe, expect, test, vi } from "vitest";

import {
  PostgresSlotInvalidationOutboxRepository,
  SlotInvalidationOutboxConsumer,
} from "./postgres-slot-invalidation-outbox.js";

const FP_A = "a".repeat(64);
const FP_B = "b".repeat(64);
const EVENT_A = "1".repeat(64);
const EVENT_B = "2".repeat(64);

describe("PostgresSlotInvalidationOutboxRepository", () => {
  test("reads and validates pending Asset/Loadout invalidation events", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({
      rows: [
        {
          source_kind: "asset",
          event_id: EVENT_A,
          scope_fingerprint: FP_A,
          event_type: "asset.status.changed",
          occurred_at: "100",
        },
        {
          source_kind: "loadout",
          event_id: EVENT_B,
          scope_fingerprint: FP_B,
          event_type: "loadout.version.created",
          occurred_at: 101,
        },
      ],
      rowCount: 2,
    }));
    const repository = new PostgresSlotInvalidationOutboxRepository({ query });

    await expect(repository.readPending(20)).resolves.toEqual([
      {
        source: "asset",
        eventId: EVENT_A,
        scopeFingerprint: FP_A,
        eventType: "asset.status.changed",
        occurredAt: 100,
      },
      {
        source: "loadout",
        eventId: EVENT_B,
        scopeFingerprint: FP_B,
        eventType: "loadout.version.created",
        occurredAt: 101,
      },
    ]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("mengshu_asset_outbox"), [20]);
    expect(query.mock.calls[0]?.[0]).toContain("mengshu_loadout_outbox");
  });

  test("rejects malformed persisted rows and invalid batch sizes", async () => {
    const repository = new PostgresSlotInvalidationOutboxRepository({
      query: async () => ({ rows: [{
        source_kind: "asset",
        event_id: EVENT_A,
        scope_fingerprint: "wrong",
        event_type: "asset.status.changed",
        occurred_at: 1,
      }] }),
    });

    await expect(repository.readPending(0)).rejects.toThrow(/batch/i);
    await expect(repository.readPending(10)).rejects.toThrow(/persisted/i);
  });

  test("CAS acknowledges only the validated source table", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) =>
      ({ rows: [{ event_id: EVENT_A }], rowCount: 1 }));
    const repository = new PostgresSlotInvalidationOutboxRepository({ query });

    await expect(repository.ackPublished({
      source: "asset",
      eventId: EVENT_A,
      scopeFingerprint: FP_A,
      eventType: "asset.version.created",
      occurredAt: 100,
    }, 200)).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("mengshu_asset_outbox"), [EVENT_A, 200]);
    expect(query.mock.calls[0]?.[0]).not.toContain("mengshu_loadout_outbox");
  });
});

describe("SlotInvalidationOutboxConsumer", () => {
  test("invalidates exact fingerprints before CAS ack and keeps failed events pending", async () => {
    const events = [
      {
        source: "asset" as const,
        eventId: EVENT_A,
        scopeFingerprint: FP_A,
        eventType: "asset.status.changed" as const,
        occurredAt: 100,
      },
      {
        source: "loadout" as const,
        eventId: EVENT_B,
        scopeFingerprint: FP_B,
        eventType: "loadout.version.created" as const,
        occurredAt: 101,
      },
    ];
    const calls: string[] = [];
    const ackPublished = vi.fn(async (event: typeof events[number]) => {
      calls.push(`ack:${event.eventId}`);
      return true;
    });
    const consumer = new SlotInvalidationOutboxConsumer({
      repository: { readPending: async () => events, ackPublished },
      invalidateScopeFingerprint: (fingerprint) => {
        calls.push(`invalidate:${fingerprint}`);
        if (fingerprint === FP_B) throw new Error("cache unavailable");
      },
      now: () => 200,
    });

    await expect(consumer.drainOnce()).resolves.toEqual({
      read: 2,
      invalidated: 1,
      acknowledged: 1,
      failures: [{ eventId: EVENT_B, reason: "invalidation_failed" }],
    });
    expect(calls).toEqual([
      `invalidate:${FP_A}`,
      `ack:${EVENT_A}`,
      `invalidate:${FP_B}`,
    ]);
    expect(ackPublished).toHaveBeenCalledTimes(1);
  });

  test("treats already acknowledged replay as a safe invalidation", async () => {
    const consumer = new SlotInvalidationOutboxConsumer({
      repository: {
        readPending: async () => [{
          source: "asset",
          eventId: EVENT_A,
          scopeFingerprint: FP_A,
          eventType: "asset.version.created",
          occurredAt: 100,
        }],
        ackPublished: async () => false,
      },
      invalidateScopeFingerprint: () => undefined,
      now: () => 200,
    });

    await expect(consumer.drainOnce()).resolves.toEqual({
      read: 1,
      invalidated: 1,
      acknowledged: 0,
      failures: [],
    });
  });
});
