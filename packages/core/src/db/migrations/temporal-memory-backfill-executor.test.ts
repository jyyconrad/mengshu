import { describe, expect, test } from "vitest";

import type { MemoryScope } from "../../domain/types.js";
import { planTemporalMemoryBackfill, type TemporalMemoryBackfillSourceRow } from
  "./temporal-memory-backfill.js";
import {
  executePostgresTemporalMemoryBackfill,
  TemporalMemoryBackfillExecutorError,
} from "./temporal-memory-backfill-executor.js";

const scope: MemoryScope = {
  tenantId: "tenant-1",
  userId: "user-1",
  appId: "codex",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "memories",
  visibility: "private",
};
const source: TemporalMemoryBackfillSourceRow = {
  id: "00000000-0000-4000-8000-000000000001",
  scope,
  kind: "decision",
  semanticType: "rules",
  lifecycleStatus: "active",
  contentHash: "a".repeat(64),
  createdAt: 100,
  metadata: {},
};

describe("executePostgresTemporalMemoryBackfill", () => {
  test("dry-run validates the frozen plan without touching PostgreSQL", async () => {
    const calls: string[] = [];
    const plan = planTemporalMemoryBackfill([source], { runId: "run-1", createdAt: 1_000 });
    const result = await executePostgresTemporalMemoryBackfill({
      query: async (sql) => {
        calls.push(sql);
        return { rows: [], rowCount: 0 };
      },
    }, [source], plan);

    expect(result).toMatchObject({
      mode: "dry-run",
      state: "planned",
      scanned: 1,
      applied: 0,
      review: 0,
    });
    expect(calls).toEqual([]);
  });

  test("apply is fail-closed without both maintenance confirmations", async () => {
    const plan = planTemporalMemoryBackfill([source], { runId: "run-2", createdAt: 1_000 });
    await expect(executePostgresTemporalMemoryBackfill({
      query: async () => ({ rows: [], rowCount: 0 }),
    }, [source], plan, { mode: "apply", maintenance: true }))
      .rejects.toEqual(new TemporalMemoryBackfillExecutorError(
        "TEMPORAL_BACKFILL_MAINTENANCE_REQUIRED",
      ));
  });

  test("rejects a manifest that does not describe the supplied source snapshot", async () => {
    const plan = planTemporalMemoryBackfill([source], { runId: "run-3", createdAt: 1_000 });
    const drifted = { ...source, contentHash: "b".repeat(64) };
    await expect(executePostgresTemporalMemoryBackfill({
      query: async () => ({ rows: [], rowCount: 0 }),
    }, [drifted], plan))
      .rejects.toEqual(new TemporalMemoryBackfillExecutorError(
        "TEMPORAL_BACKFILL_MANIFEST_MISMATCH",
      ));
  });
});
