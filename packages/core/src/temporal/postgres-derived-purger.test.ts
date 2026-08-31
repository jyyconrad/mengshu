import { describe, expect, test, vi } from "vitest";

import {
  PostgresTemporalDerivedPurgeError,
  purgePostgresTemporalDerivedArtifacts,
  type PostgresDerivedPurgeClient,
} from "./postgres-derived-purger.js";

function input() {
  return {
    versionIds: ["11111111-1111-4111-8111-111111111111"],
    lineageId: "lineage-1",
    scopeFingerprint: "a".repeat(64),
  };
}

describe("purgePostgresTemporalDerivedArtifacts", () => {
  test("uses one transaction and scrubs graph/tree/asset/skill/migration derivations", async () => {
    const sql: string[] = [];
    const calls: Array<{ statement: string; params: readonly unknown[] }> = [];
    const client: PostgresDerivedPurgeClient = {
      query: vi.fn(async (statement: string, params: readonly unknown[] = []) => {
        sql.push(statement);
        calls.push({ statement, params });
        return {
          rows: [],
          rowCount: statement.includes("DELETE FROM") ? 1 : 0,
        };
      }),
      release: vi.fn(),
    };
    const count = await purgePostgresTemporalDerivedArtifacts({
      connect: async () => client,
    }, input());

    expect(sql[0]).toBe("BEGIN");
    expect(sql.at(-1)).toBe("COMMIT");
    expect(count).toBeGreaterThan(20);
    for (const tag of [
      "memory-links", "work-nodes", "tree-summaries", "asset-versions",
      "skill-versions", "migration-snapshots", "repair-snapshots",
      "transition-receipts", "version-outbox",
    ]) {
      expect(sql.some((statement) => statement.includes(`temporal-derived-purge:${tag}`)), tag)
        .toBe(true);
    }
    expect(client.release).toHaveBeenCalledOnce();
    const transitionReceipts = calls.find(({ statement }) =>
      statement.includes("temporal-derived-purge:transition-receipts"));
    expect(transitionReceipts?.params).toEqual([
      input().scopeFingerprint,
      input().lineageId,
    ]);
    expect(transitionReceipts?.statement).toContain(
      "scope_fingerprint = $1 AND lineage_id = $2",
    );
  });

  test("any deletion failure rolls back and propagates so lineage remains purge_pending", async () => {
    const sql: string[] = [];
    const client: PostgresDerivedPurgeClient = {
      query: vi.fn(async (statement: string) => {
        sql.push(statement);
        if (statement.includes("tree-summaries")) throw new Error("tree store unavailable");
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    await expect(purgePostgresTemporalDerivedArtifacts({
      connect: async () => client,
    }, input())).rejects.toEqual(new PostgresTemporalDerivedPurgeError(
      "TEMPORAL_DERIVED_PURGE_TREE_SUMMARIES_FAILED",
    ));
    expect(sql.at(-1)).toBe("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });
});
