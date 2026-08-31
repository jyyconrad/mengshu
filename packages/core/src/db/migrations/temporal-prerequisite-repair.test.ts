import { describe, expect, test } from "vitest";

import { planPostgresTemporalPrerequisiteRepair } from "./temporal-prerequisite-repair.js";

const scope = {
  tenant_id: "tenant-1", user_id: "user-1", canonical_project_id: "project-1",
  product_id: "codex", producer_id: "agent-1", namespace: "memories",
  visibility: "private", workspace_id: null,
};

describe("planPostgresTemporalPrerequisiteRepair", () => {
  test("routes pending rows to candidate migration and invalid duplicate hashes to quarantine", async () => {
    const sourceRows = [
      { ...scope, id: "00000000-0000-4000-8000-000000000001", text: "pending",
        content_hash: "a".repeat(64), lifecycle_status: "pending", category: "task",
        metadata: {}, created_at_ms: "100" },
      { ...scope, id: "00000000-0000-4000-8000-000000000002", text: "duplicate",
        content_hash: "legacy-invalid", lifecycle_status: "active", category: "decision",
        metadata: {}, created_at_ms: "200" },
    ];
    const versionedRows = [{
      ...scope, id: "00000000-0000-4000-8000-000000000099", text: "duplicate",
      content_hash: "b".repeat(64), lifecycle_status: "active", category: "decision",
      metadata: {}, created_at_ms: "90",
    }];
    const client = {
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(sql: string) => {
        const rows = (sql.includes("repair-source") ? sourceRows : versionedRows) as unknown as Row[];
        return { rows, rowCount: rows.length };
      },
    };
    const plan = await planPostgresTemporalPrerequisiteRepair(client, {
      runId: "repair-1", createdAt: 1_000,
    });
    expect(plan.counts).toEqual({ scanned: 2, repaired: 2, review: 0 });
    expect(plan.rows).toMatchObject([
      { memoryId: "00000000-0000-4000-8000-000000000001", disposition: "migrate_candidate" },
      { memoryId: "00000000-0000-4000-8000-000000000002", disposition: "quarantine_duplicate",
        duplicateOf: "00000000-0000-4000-8000-000000000099" },
    ]);
  });
});
