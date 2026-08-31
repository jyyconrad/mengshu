import { describe, expect, test } from "vitest";

import type { MemoryScope } from "../domain/types.js";
import { PostgresSessionWorkingSetRepository } from "./postgres-repository.js";
import type { WorkingSetEntry } from "./types.js";

const scope: MemoryScope = {
  tenantId: "tenant-1", userId: "user-1", appId: "codex", projectId: "project-1",
  agentId: "agent-1", namespace: "memories", visibility: "private", sessionId: "session-1",
};
const entry: WorkingSetEntry = {
  id: "ws_1",
  scopeFingerprint: "a".repeat(64),
  sessionId: "session-1",
  kind: "tool_pair",
  status: "active",
  sourceMessageIds: ["use-1", "result-1"],
  toolCallId: "call-1",
  toolName: "exec",
  payloadRef: {
    provider: "session_log",
    locator: "session://call-1",
    contentHash: "b".repeat(64),
    byteLength: 10,
  },
  replaceability: 0.5,
  evidenceRefs: [],
  riskFlags: [],
  createdAt: new Date(1_000).toISOString(),
  updatedAt: new Date(1_000).toISOString(),
};

describe("PostgresSessionWorkingSetRepository", () => {
  test("tool pair shell and idempotency receipt commit in one provider transaction", async () => {
    const calls: string[] = [];
    const query = async <Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
    ): Promise<{ rows: Row[]; rowCount: number | null }> => {
      calls.push(sql.trim().split("\n")[0]!);
      if (sql.includes("insert-entry") || sql.includes("insert-idempotency")) {
        return { rows: [{ entry_id: entry.id } as unknown as Row], rowCount: 1 };
      }
      return { rows: [], rowCount: null };
    };
    const client = {
      query,
      release: () => { calls.push("RELEASE"); },
    };
    const repository = new PostgresSessionWorkingSetRepository({
      connect: async () => client,
      query,
    });
    await repository.putToolPairShell(entry, {
      scopeFingerprint: entry.scopeFingerprint,
      sessionId: entry.sessionId,
      idempotencyKey: "key-1",
      requestHash: "c".repeat(64),
      entryId: entry.id,
    }, scope);

    expect(calls).toEqual([
      "BEGIN",
      "/* working-set:insert-entry */",
      "/* working-set:insert-idempotency */",
      "COMMIT",
      "RELEASE",
    ]);
  });

  test("session close locks rows and persists the authoritative cleanup receipt", async () => {
    const calls: string[] = [];
    const query = async <Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
    ): Promise<{ rows: Row[]; rowCount: number | null }> => {
      calls.push(sql.trim().split("\n")[0]!);
      if (sql.includes("get-cleanup-receipt")) return { rows: [], rowCount: 0 };
      if (sql.includes("lock-session")) {
        return { rows: [
          { entry_id: "ws-retain", status: "active" },
          { entry_id: "ws-delete", status: "summarized" },
          { entry_id: "ws-fail", status: "active" },
        ] as unknown as Row[], rowCount: 3 };
      }
      if (sql.includes("close-session")) {
        return { rows: [
          { entry_id: "ws-retain" }, { entry_id: "ws-delete" }, { entry_id: "ws-fail" },
        ] as unknown as Row[], rowCount: 3 };
      }
      if (sql.includes("insert-cleanup-receipt")) {
        return { rows: [{ receipt_id: "x" } as unknown as Row], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    };
    const repository = new PostgresSessionWorkingSetRepository({
      query,
      connect: async () => ({ query, release: () => { calls.push("RELEASE"); } }),
    });
    const receipt = await repository.closeSession({
      scopeFingerprint: entry.scopeFingerprint,
      sessionId: entry.sessionId,
      retainedEntryIds: ["ws-retain"],
      deletedPayloadEntryIds: ["ws-delete"],
      failedPayloadEntryIds: ["ws-fail"],
      reason: "session_closed",
      retentionDays: 0,
      warnings: ["payload_delete_failed"],
      closedAt: new Date(2_000).toISOString(),
    });
    expect(receipt).toMatchObject({
      scannedCount: 3, retainedCount: 1, archivedCount: 0, deletedCount: 1, failedCount: 1,
    });
    expect(calls).toEqual(expect.arrayContaining([
      "/* working-set:lock-session */",
      "/* working-set:insert-cleanup-receipt */",
      "COMMIT",
    ]));
  });

  test("decodes sessions whose archived payload retention is due", async () => {
    const query = async <Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
    ): Promise<{ rows: Row[]; rowCount: number | null }> => {
      expect(sql).toContain("working-set:list-retention-due");
      return {
        rows: [{
          scope_fingerprint: entry.scopeFingerprint,
          session_id: "session-1",
          retention_days: "2",
          closed_at: "1000",
          tenant_id: scope.tenantId,
          user_id: scope.userId,
          app_id: scope.appId,
          project_id: scope.projectId,
          agent_id: scope.agentId,
          namespace: scope.namespace,
          visibility: "private",
          workspace_id: null,
        } as unknown as Row],
        rowCount: 1,
      };
    };
    const repository = new PostgresSessionWorkingSetRepository({
      query,
      connect: async () => ({ query, release: () => undefined }),
    });

    const due = await repository.listRetentionDue(new Date(200_000_000).toISOString(), 5);

    expect(due).toEqual([{
      scope,
      scopeFingerprint: entry.scopeFingerprint,
      sessionId: "session-1",
      retentionDays: 2,
      dueAt: new Date(1000 + 2 * 86_400_000).toISOString(),
    }]);
  });
});
