import { createHash } from "node:crypto";

import { describe, expect, test, vi } from "vitest";

import {
  executePostgresSemanticTypeBackfill,
  rollbackPostgresSemanticTypeBackfill,
  SemanticTypeBackfillExecutorError,
  verifyPostgresSemanticTypeBackfill,
  type PostgresSemanticTypeBackfillClient,
} from "./semantic-type-backfill-executor.js";

const rows = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    metadata: {},
    memory_kind: "decision",
    lifecycle_status: "active",
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    metadata: {},
    memory_kind: "fact",
    lifecycle_status: "active",
  },
];

type FakeRow = Record<string, unknown>;

function sourceSnapshot(sourceUpperBound: string | null, sourceCount: number) {
  return {
    sourceUpperBound,
    sourceCount,
    attemptHash: createHash("sha256").update(JSON.stringify([
      "mengshu.semantic-type-backfill-attempt/v1",
      "semantic-v1",
      "a".repeat(64),
      sourceUpperBound,
      sourceCount,
    ])).digest("hex"),
  };
}

function client(options: {
    drift?: boolean;
    checkpoint?: Record<string, unknown>;
    verify?: Record<string, unknown>;
    batches?: FakeRow[][];
    rollbackExpected?: Record<string, unknown>;
    rollbackCount?: number;
    lockAcquired?: boolean;
    sourceUpperBound?: string | null;
    sourceCount?: number;
} = {}): {
  port: PostgresSemanticTypeBackfillClient;
  calls: Array<{ sql: string; params: readonly unknown[] }>;
} {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const batches = [...(options.batches ?? [rows])];
  const query: PostgresSemanticTypeBackfillClient["query"] = async <
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(sql: string, params: readonly unknown[] = []) => {
    calls.push({ sql, params });
    let result: { rows: readonly Record<string, unknown>[]; rowCount: number };
    if (sql.includes("semantic-type-backfill:lock")) {
      result = { rows: [{ acquired: options.lockAcquired !== false }], rowCount: 1 };
    } else if (sql.includes("semantic-type-backfill:unlock")) {
      result = { rows: [{ released: true }], rowCount: 1 };
    } else if (sql.includes("semantic-type-backfill:source-snapshot")) {
      const sourceUpperBound = options.sourceUpperBound === undefined
        ? rows.at(-1)!.id
        : options.sourceUpperBound;
      result = { rows: [{
        source_upper_bound: sourceUpperBound,
        source_count: String(options.sourceCount ?? (sourceUpperBound === null ? 0 : rows.length)),
      }], rowCount: 1 };
    } else if (sql.includes("semantic-type-backfill:checkpoint-read")) {
      result = options.checkpoint
        ? { rows: [options.checkpoint], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    } else if (sql.includes("semantic-type-backfill:scan")) {
      const batch = batches.shift() ?? [];
      result = { rows: batch, rowCount: batch.length };
    } else if (sql.includes("semantic-type-backfill:cas-update") ||
        sql.includes("semantic-type-backfill:cas-isolate")) {
      result = { rows: [], rowCount: options.drift ? 0 : 1 };
    } else if (sql.includes("semantic-type-backfill:verify")) {
      result = { rows: options.verify ? [options.verify] : [], rowCount: options.verify ? 1 : 0 };
    } else if (sql.includes("semantic-type-backfill:rollback-expected")) {
      const expected = options.rollbackExpected ?? {
        expected_count: "1",
        restorable_count: "1",
        already_restored_count: "0",
      };
      result = { rows: [expected], rowCount: 1 };
    } else if (sql.includes("semantic-type-backfill:rollback-update")) {
      result = { rows: [], rowCount: options.rollbackCount ?? 1 };
    } else {
      result = { rows: [], rowCount: 0 };
    }
    return result as { readonly rows: readonly Row[]; readonly rowCount: number };
  };
  return {
    calls,
    port: { query: vi.fn(query) as PostgresSemanticTypeBackfillClient["query"] },
  };
}

describe("semantic type backfill executor", () => {
  test("defaults to dry-run and performs no mutations", async () => {
    const fake = client();
    await expect(executePostgresSemanticTypeBackfill(fake.port, {
      migrationId: "semantic-v1",
      manifestHash: "a".repeat(64),
      batchSize: 10,
      now: 1_720_000_000_000,
    })).resolves.toEqual({
      mode: "dry-run",
      scanned: 2,
      preservedExplicit: 0,
      backfilled: 1,
      lookupOnly: 1,
      invalidExplicit: 0,
      batches: 1,
      ...sourceSnapshot(rows.at(-1)!.id, rows.length),
    });
    expect(fake.calls.some(({ sql }) => /INSERT|UPDATE|BEGIN|COMMIT/.test(sql))).toBe(false);
    expect(fake.calls[0]?.sql).toContain("semantic-type-backfill:lock");
    expect(fake.calls.at(-1)?.sql).toContain("semantic-type-backfill:unlock");
  });

  test("scans the canonical governance kind and falls back to deterministic legacy category", async () => {
    const fake = client({
      batches: [[
        {
          id: "00000000-0000-4000-8000-000000000011",
          metadata: { governance: { native: { kind: "decision" } } },
          canonical_memory_kind: "decision",
          metadata_kind: null,
          legacy_memory_kind: null,
          data_type: "memory",
          category: "other",
          lifecycle_status: "active",
        },
        {
          id: "00000000-0000-4000-8000-000000000012",
          metadata: {},
          canonical_memory_kind: null,
          metadata_kind: null,
          legacy_memory_kind: null,
          data_type: "memory",
          category: "preference",
          lifecycle_status: "active",
        },
      ]],
    });

    await expect(executePostgresSemanticTypeBackfill(fake.port, {
      migrationId: "semantic-v1",
      manifestHash: "a".repeat(64),
    })).resolves.toMatchObject({ scanned: 2, backfilled: 2, invalidExplicit: 0 });

    const scanSql = fake.calls.find(({ sql }) => sql.includes("semantic-type-backfill:scan"))?.sql ?? "";
    expect(scanSql).toContain("{governance,native,kind}");
    expect(scanSql).toContain("data_type");
    expect(scanSql).toContain("category");
  });

  test("apply requires maintenance and writer quiescence", async () => {
    const fake = client();
    await expect(executePostgresSemanticTypeBackfill(fake.port, {
      migrationId: "semantic-v1",
      manifestHash: "a".repeat(64),
      mode: "apply",
      batchSize: 10,
      now: 1_720_000_000_000,
    })).rejects.toMatchObject({
      code: "SEMANTIC_TYPE_BACKFILL_MAINTENANCE_REQUIRED",
    } satisfies Partial<SemanticTypeBackfillExecutorError>);
    expect(fake.calls).toHaveLength(0);
  });

  test("rejects a concurrent operator holding the migration-specific advisory lock", async () => {
    const fake = client({ lockAcquired: false });
    await expect(executePostgresSemanticTypeBackfill(fake.port, {
      migrationId: "semantic-v1",
      manifestHash: "a".repeat(64),
    })).rejects.toMatchObject({ code: "SEMANTIC_TYPE_BACKFILL_LOCK_UNAVAILABLE" });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.params).toEqual(["mengshu.semantic-type-backfill:semantic-v1"]);
  });

  test("pins the scan to the captured source upper bound and persists the attempt snapshot", async () => {
    const upperBound = rows[0]!.id;
    const fake = client({
      sourceUpperBound: upperBound,
      sourceCount: 1,
      batches: [[rows[0]!]],
    });
    await executePostgresSemanticTypeBackfill(fake.port, {
      migrationId: "semantic-v1",
      manifestHash: "a".repeat(64),
      mode: "apply",
      maintenance: true,
      quiescenceConfirmed: true,
    });
    const scan = fake.calls.find(({ sql }) => sql.includes("semantic-type-backfill:scan"));
    expect(scan?.params[3]).toBe(upperBound);
    expect(scan?.sql).toContain("id <= $4::uuid");
    const checkpoints = fake.calls.filter(({ sql }) => sql.includes("semantic-type-backfill:checkpoint"));
    const persisted = JSON.parse(String(checkpoints.at(-1)?.params[3]));
    expect(persisted).toMatchObject(sourceSnapshot(upperBound, 1));
  });

  test("apply captures shadow, CAS-updates only mapped rows, then writes receipts/checkpoint", async () => {
    const fake = client();
    await expect(executePostgresSemanticTypeBackfill(fake.port, {
      migrationId: "semantic-v1",
      manifestHash: "a".repeat(64),
      mode: "apply",
      maintenance: true,
      quiescenceConfirmed: true,
      batchSize: 10,
      now: 1_720_000_000_000,
    })).resolves.toMatchObject({ backfilled: 1, lookupOnly: 1 });

    const sql = fake.calls.map((call) => call.sql).join("\n");
    expect(sql).toContain("BEGIN");
    expect(sql).toContain("semantic-type-backfill:shadow");
    expect(sql).toContain("semantic-type-backfill:cas-update");
    expect(sql).toContain("semantic-type-backfill:cas-isolate");
    expect(sql).toContain("semantic-type-backfill:receipt");
    expect(sql).toContain("semantic-type-backfill:checkpoint");
    expect(sql).toContain("COMMIT");
    expect(fake.calls.filter(({ sql: value }) => value.includes("cas-update"))).toHaveLength(1);
    expect(fake.calls.filter(({ sql: value }) => value.includes("cas-isolate"))).toHaveLength(1);
    const casSql = fake.calls.find(({ sql: value }) => value.includes("cas-update"))?.sql ?? "";
    expect(casSql).toContain("jsonb_set");
    expect(casSql).toContain("{governance,native,semanticType}");
  });

  test("records canonical/legacy kind conflicts without mutating them", async () => {
    const fake = client({
      batches: [[{
        id: "00000000-0000-4000-8000-000000000013",
        metadata: { governance: { native: { kind: "decision" } }, kind: "preference" },
        canonical_memory_kind: "decision",
        metadata_kind: "preference",
        legacy_memory_kind: null,
        data_type: "memory",
        category: "decision",
        lifecycle_status: "active",
      }]],
    });
    await expect(executePostgresSemanticTypeBackfill(fake.port, {
      migrationId: "semantic-v1",
      manifestHash: "a".repeat(64),
      mode: "apply",
      maintenance: true,
      quiescenceConfirmed: true,
    })).resolves.toMatchObject({ invalidExplicit: 1, backfilled: 0 });
    expect(fake.calls.some(({ sql }) => sql.includes("cas-update"))).toBe(false);
    const isolation = fake.calls.find(({ sql }) => sql.includes("cas-isolate"));
    expect(isolation?.params.slice(1, 3)).toEqual(["semantic-v1", "invalid_explicit"]);
    expect(isolation?.sql).toContain("'admissionRoute', 'lookup_only'");
    expect(isolation?.sql).toContain("'contextEligible', false");
  });

  test("rolls back the current batch when CAS detects source drift", async () => {
    const fake = client({ drift: true });
    await expect(executePostgresSemanticTypeBackfill(fake.port, {
      migrationId: "semantic-v1",
      manifestHash: "a".repeat(64),
      mode: "apply",
      maintenance: true,
      quiescenceConfirmed: true,
      batchSize: 10,
      now: 1_720_000_000_000,
    })).rejects.toMatchObject({
      code: "SEMANTIC_TYPE_BACKFILL_CONCURRENT_DRIFT",
    } satisfies Partial<SemanticTypeBackfillExecutorError>);
    expect(fake.calls.at(-2)?.sql).toBe("ROLLBACK");
    expect(fake.calls.at(-1)?.sql).toContain("semantic-type-backfill:unlock");
  });

  test("refuses to resume a migration when the persisted manifest differs", async () => {
    const fake = client({
      checkpoint: {
        manifest_hash: "b".repeat(64),
        after_id: rows[0]!.id,
        counts: {
          scanned: 1,
          preservedExplicit: 0,
          backfilled: 1,
          lookupOnly: 0,
          invalidExplicit: 0,
          batches: 1,
          ...sourceSnapshot(rows[0]!.id, 1),
        },
      },
    });
    await expect(executePostgresSemanticTypeBackfill(fake.port, {
      migrationId: "semantic-v1",
      manifestHash: "a".repeat(64),
      mode: "apply",
      maintenance: true,
      quiescenceConfirmed: true,
    })).rejects.toMatchObject({ code: "SEMANTIC_TYPE_BACKFILL_MANIFEST_MISMATCH" });
    expect(fake.calls.some(({ sql }) => sql === "BEGIN")).toBe(false);
  });

  test("refuses an old non-empty checkpoint without an immutable source snapshot", async () => {
    const fake = client({
      checkpoint: {
        manifest_hash: "a".repeat(64),
        after_id: rows[0]!.id,
        counts: {
          scanned: 1, preservedExplicit: 0, backfilled: 1,
          lookupOnly: 0, invalidExplicit: 0, batches: 1,
        },
      },
    });
    await expect(executePostgresSemanticTypeBackfill(fake.port, {
      migrationId: "semantic-v1",
      manifestHash: "a".repeat(64),
      mode: "apply",
      maintenance: true,
      quiescenceConfirmed: true,
    })).rejects.toMatchObject({ code: "SEMANTIC_TYPE_BACKFILL_CONCURRENT_DRIFT" });
  });

  test("resumes after the durable checkpoint and preserves cumulative counts", async () => {
    const checkpointCounts = {
      scanned: 5,
      preservedExplicit: 1,
      backfilled: 2,
      lookupOnly: 2,
      invalidExplicit: 0,
      batches: 2,
      ...sourceSnapshot(rows[1]!.id, 6),
    };
    const fake = client({
      checkpoint: {
        manifest_hash: "a".repeat(64),
        after_id: rows[0]!.id,
        counts: checkpointCounts,
      },
      batches: [[rows[1]!]],
    });
    const result = await executePostgresSemanticTypeBackfill(fake.port, {
      migrationId: "semantic-v1",
      manifestHash: "a".repeat(64),
      mode: "apply",
      maintenance: true,
      quiescenceConfirmed: true,
      now: 1_720_000_000_000,
    });
    expect(result).toMatchObject({ scanned: 6, backfilled: 2, lookupOnly: 3, batches: 3 });
    const scan = fake.calls.find(({ sql }) => sql.includes("semantic-type-backfill:scan"));
    expect(scan?.params[0]).toBe(rows[0]!.id);
  });

  test("verifies shadow, receipt and disposition count conservation", async () => {
    const counts = {
      scanned: 4,
      preservedExplicit: 1,
      backfilled: 1,
      lookupOnly: 1,
      invalidExplicit: 1,
      batches: 2,
    };
    const fake = client({
      verify: {
        manifest_hash: "a".repeat(64),
        after_id: rows[1]!.id,
        counts: { ...counts, ...sourceSnapshot(rows[1]!.id, 4) },
        shadow_count: "4",
        receipt_count: "4",
        preserved_explicit_count: "1",
        backfill_count: "1",
        lookup_only_count: "1",
        invalid_explicit_count: "1",
        remaining_count: "0",
        live_mismatch_count: "0",
        snapshot_source_count: "4",
      },
    });
    await expect(verifyPostgresSemanticTypeBackfill(fake.port, {
      migrationId: "semantic-v1",
      manifestHash: "a".repeat(64),
    })).resolves.toEqual({
      migrationId: "semantic-v1",
      manifestHash: "a".repeat(64),
      ...counts,
      ...sourceSnapshot(rows[1]!.id, 4),
      shadowCount: 4,
      receiptCount: 4,
      valid: true,
    });
    const verifySql = fake.calls.find(({ sql }) =>
      sql.includes("semantic-type-backfill:verify"))?.sql ?? "";
    expect(verifySql).toContain("checkpoint.after_id");
    expect(verifySql).toContain("GROUP BY checkpoint.manifest_hash, checkpoint.after_id, checkpoint.counts");
  });

  test("fails verification when the funnel loses or duplicates a row", async () => {
    const fake = client({
      verify: {
        manifest_hash: "a".repeat(64),
        after_id: rows[1]!.id,
        counts: {
          scanned: 4,
          preservedExplicit: 1,
          backfilled: 1,
          lookupOnly: 1,
          invalidExplicit: 1,
          batches: 2,
          ...sourceSnapshot(rows[1]!.id, 4),
        },
        shadow_count: "4",
        receipt_count: "3",
        preserved_explicit_count: "1",
        backfill_count: "1",
        lookup_only_count: "1",
        invalid_explicit_count: "0",
        remaining_count: "0",
        live_mismatch_count: "0",
        snapshot_source_count: "4",
      },
    });
    await expect(verifyPostgresSemanticTypeBackfill(fake.port, {
      migrationId: "semantic-v1",
      manifestHash: "a".repeat(64),
    })).rejects.toMatchObject({ code: "SEMANTIC_TYPE_BACKFILL_VERIFY_FAILED" });
  });

  test("fails verification when the fixed source population drifts", async () => {
    const counts = {
      scanned: 1, preservedExplicit: 0, backfilled: 1,
      lookupOnly: 0, invalidExplicit: 0, batches: 1,
    };
    const fake = client({
      verify: {
        manifest_hash: "a".repeat(64),
        after_id: rows[0]!.id,
        counts: { ...counts, ...sourceSnapshot(rows[0]!.id, 1) },
        shadow_count: "1", receipt_count: "1",
        preserved_explicit_count: "0", backfill_count: "1",
        lookup_only_count: "0", invalid_explicit_count: "0",
        remaining_count: "0", live_mismatch_count: "0",
        snapshot_source_count: "2",
      },
    });
    await expect(verifyPostgresSemanticTypeBackfill(fake.port, {
      migrationId: "semantic-v1",
      manifestHash: "a".repeat(64),
    })).rejects.toMatchObject({ code: "SEMANTIC_TYPE_BACKFILL_VERIFY_FAILED" });
  });

  test.each([
    ["partial scan", { remaining_count: "1", live_mismatch_count: "0" }],
    ["live metadata drift", { remaining_count: "0", live_mismatch_count: "1" }],
  ])("fails verification on %s", async (_label, drift) => {
    const counts = {
      scanned: 1,
      preservedExplicit: 0,
      backfilled: 1,
      lookupOnly: 0,
      invalidExplicit: 0,
      batches: 1,
    };
    const fake = client({
      verify: {
        manifest_hash: "a".repeat(64),
        after_id: rows[0]!.id,
        counts: { ...counts, ...sourceSnapshot(rows[0]!.id, 1) },
        shadow_count: "1",
        receipt_count: "1",
        preserved_explicit_count: "0",
        backfill_count: "1",
        lookup_only_count: "0",
        invalid_explicit_count: "0",
        ...drift,
        snapshot_source_count: "1",
      },
    });
    await expect(verifyPostgresSemanticTypeBackfill(fake.port, {
      migrationId: "semantic-v1",
      manifestHash: "a".repeat(64),
    })).rejects.toMatchObject({ code: "SEMANTIC_TYPE_BACKFILL_VERIFY_FAILED" });
  });

  test("rollback restores only unchanged rows written by this migration", async () => {
    const fake = client({
      checkpoint: {
        manifest_hash: "a".repeat(64),
        after_id: rows[1]!.id,
        counts: {
          scanned: 2,
          preservedExplicit: 0,
          backfilled: 1,
          lookupOnly: 1,
          invalidExplicit: 0,
          batches: 1,
          ...sourceSnapshot(rows[1]!.id, 2),
        },
      },
      rollbackCount: 1,
    });
    await expect(rollbackPostgresSemanticTypeBackfill(fake.port, {
      migrationId: "semantic-v1",
      manifestHash: "a".repeat(64),
      maintenance: true,
      quiescenceConfirmed: true,
    })).resolves.toEqual({ restored: 1 });
    expect(fake.calls.map(({ sql }) => sql)).toEqual(expect.arrayContaining([
      "BEGIN",
      expect.stringContaining("semantic-type-backfill:rollback-update"),
      "COMMIT",
    ]));
  });

  test("rollback refuses partial restoration when a migrated row drifted", async () => {
    const fake = client({
      checkpoint: {
        manifest_hash: "a".repeat(64),
        after_id: rows[1]!.id,
        counts: {
          scanned: 2,
          preservedExplicit: 0,
          backfilled: 2,
          lookupOnly: 0,
          invalidExplicit: 0,
          batches: 1,
          ...sourceSnapshot(rows[1]!.id, 2),
        },
      },
      rollbackExpected: {
        expected_count: "2",
        restorable_count: "1",
        already_restored_count: "0",
      },
      rollbackCount: 1,
    });
    await expect(rollbackPostgresSemanticTypeBackfill(fake.port, {
      migrationId: "semantic-v1",
      manifestHash: "a".repeat(64),
      maintenance: true,
      quiescenceConfirmed: true,
    })).rejects.toMatchObject({ code: "SEMANTIC_TYPE_BACKFILL_CONCURRENT_DRIFT" });
    expect(fake.calls.some(({ sql }) => sql.includes("rollback-update"))).toBe(false);
    expect(fake.calls.at(-2)?.sql).toBe("ROLLBACK");
    expect(fake.calls.at(-1)?.sql).toContain("semantic-type-backfill:unlock");
  });

  test("rollback is idempotent when every mutation is already restored", async () => {
    const fake = client({
      checkpoint: {
        manifest_hash: "a".repeat(64),
        after_id: rows[0]!.id,
        counts: {
          scanned: 1,
          preservedExplicit: 0,
          backfilled: 1,
          lookupOnly: 0,
          invalidExplicit: 0,
          batches: 1,
          ...sourceSnapshot(rows[0]!.id, 1),
        },
      },
      rollbackExpected: {
        expected_count: "1",
        restorable_count: "0",
        already_restored_count: "1",
      },
      rollbackCount: 0,
    });
    await expect(rollbackPostgresSemanticTypeBackfill(fake.port, {
      migrationId: "semantic-v1",
      manifestHash: "a".repeat(64),
      maintenance: true,
      quiescenceConfirmed: true,
    })).resolves.toEqual({ restored: 0 });
  });
});
