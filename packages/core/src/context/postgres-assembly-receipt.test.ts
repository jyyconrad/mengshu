import { describe, expect, test, vi } from "vitest";

import { createContextAssemblyReceipt } from "./assembly-receipt.js";
import { PostgresContextAssemblyReceiptRepository } from "./postgres-assembly-receipt.js";

const scope = {
  tenantId: "tenant-a", userId: "user-a", appId: "codex", projectId: "project-a",
  agentId: "agent-a", namespace: "memory", visibility: "private" as const,
  sessionId: "session-a",
};
const receipt = createContextAssemblyReceipt({
  scope,
  response: {
    scope,
    slots: {},
    content: "safe",
    assemblyPlan: {
      sessionId: "session-a", slots: {}, tools: [], denied: [], versions: {
        slotSnapshot: 2, retrieval: "v1", scoring: "v1", promptPolicy: "v1",
      }, stableContentHash: "c".repeat(64), dynamicContentHash: "d".repeat(64),
      expiresAt: "2026-08-13T01:00:00.000Z",
    },
    telemetry: { latencyMs: 1, nodesUsed: 0, cacheHit: false },
  },
  now: Date.parse("2026-08-13T00:00:00.000Z"),
});

describe("PostgresContextAssemblyReceiptRepository", () => {
  test("appends and reads only by exact scope fingerprint plus session", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ receipt }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ receipt }], rowCount: 1 });
    const repository = new PostgresContextAssemblyReceiptRepository({ query } as never);

    await expect(repository.append(scope, receipt)).resolves.toEqual(receipt);
    await expect(repository.getLatest(scope, "session-a")).resolves.toEqual(receipt);
    expect(query.mock.calls[0]?.[0]).toContain("context-assembly-receipt:append");
    expect(query.mock.calls[1]?.[0]).toContain("scope_fingerprint = $1 AND session_id = $2");
  });

  test("fails closed when relational identity or persisted JSON is forged", async () => {
    const repository = new PostgresContextAssemblyReceiptRepository({
      query: vi.fn(async () => ({ rows: [{ receipt: { ...receipt, sessionId: "other" } }], rowCount: 1 })),
    } as never);
    await expect(repository.getLatest(scope, "session-a")).rejects.toThrow(/receipt/i);
  });

  test("returns the latest of multiple legitimate session receipts without false duplicate detection", async () => {
    const older = createContextAssemblyReceipt({
      scope,
      response: {
        scope,
        slots: {},
        content: "safe",
        assemblyPlan: {
          ...receipt.plan,
          dynamicContentHash: "e".repeat(64),
        },
        telemetry: { latencyMs: 1, nodesUsed: 0, cacheHit: false },
      },
      now: Date.parse("2026-08-12T23:59:00.000Z"),
    });
    const query = vi.fn(async (_sql: string) => ({
      rows: [
        { receipt_id: receipt.id, created_at: Date.parse(receipt.createdAt), receipt },
        { receipt_id: older.id, created_at: Date.parse(older.createdAt), receipt: older },
      ],
      rowCount: 2,
    }));
    const repository = new PostgresContextAssemblyReceiptRepository({ query } as never);

    await expect(repository.getLatest(scope, "session-a")).resolves.toEqual(receipt);
    expect(query.mock.calls[0]?.[0]).toContain("SELECT receipt_id, receipt, created_at");
  });
});
