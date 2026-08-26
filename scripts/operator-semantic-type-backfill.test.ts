import { describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";

import {
  loadSemanticTypeBackfillManifest,
  runSemanticTypeBackfillOperator,
  type SemanticTypeBackfillOperatorDependencies,
} from "./operator-semantic-type-backfill.js";

const manifestText = JSON.stringify({
  version: 1,
  migrationId: "semantic-type-5type-v1",
  mappingVersion: "kind-to-semantic-type/v1",
  target: "memories.metadata.semanticType",
  unmappable: "lookup_only",
});
const manifestHash = loadSemanticTypeBackfillManifest(manifestText).sha256;
const emptySnapshot = {
  sourceUpperBound: null,
  sourceCount: 0,
  attemptHash: createHash("sha256").update(JSON.stringify([
    "mengshu.semantic-type-backfill-attempt/v1",
    "semantic-type-5type-v1",
    manifestHash,
    null,
    0,
  ])).digest("hex"),
};

function dependencies(): {
  deps: SemanticTypeBackfillOperatorDependencies;
  calls: string[];
} {
  const calls: string[] = [];
  const query: SemanticTypeBackfillOperatorDependencies extends {
    connect: (...args: never[]) => Promise<infer Connection>;
  } ? Connection extends { client: infer Client } ? Client extends { query: infer Query } ? Query : never : never : never =
    (async <Row extends Record<string, unknown> = Record<string, unknown>>(sql: string) => {
      calls.push(sql);
      let result: { rows: readonly Record<string, unknown>[]; rowCount: number };
      if (sql.includes("semantic-type-backfill:lock")) {
        result = { rows: [{ acquired: true }], rowCount: 1 };
      } else if (sql.includes("semantic-type-backfill:unlock")) {
        result = { rows: [{ released: true }], rowCount: 1 };
      } else if (sql.includes("semantic-type-backfill:source-snapshot")) {
        result = { rows: [{ source_upper_bound: null, source_count: "0" }], rowCount: 1 };
      } else if (sql.includes("checkpoint-read")) {
        result = {
          rows: [{
            manifest_hash: manifestHash,
            after_id: null,
            counts: {
              scanned: 0,
              preservedExplicit: 0,
              backfilled: 0,
              lookupOnly: 0,
              invalidExplicit: 0,
              batches: 0,
              ...emptySnapshot,
            },
          }],
          rowCount: 1,
        };
      } else if (sql.includes("semantic-type-backfill:scan")) {
        result = { rows: [], rowCount: 0 };
      } else if (sql.includes("semantic-type-backfill:verify")) {
        result = {
          rows: [{
            manifest_hash: manifestHash,
            after_id: null,
            counts: {
              scanned: 0,
              preservedExplicit: 0,
              backfilled: 0,
              lookupOnly: 0,
              invalidExplicit: 0,
              batches: 0,
              ...emptySnapshot,
            },
            shadow_count: "0",
            receipt_count: "0",
            preserved_explicit_count: "0",
            backfill_count: "0",
            lookup_only_count: "0",
            invalid_explicit_count: "0",
            remaining_count: "0",
            live_mismatch_count: "0",
            snapshot_source_count: "0",
          }],
          rowCount: 1,
        };
      } else if (sql.includes("semantic-type-backfill:rollback-expected")) {
        result = {
          rows: [{
            expected_count: "0",
            restorable_count: "0",
            already_restored_count: "0",
          }],
          rowCount: 1,
        };
      } else {
        result = { rows: [], rowCount: 0 };
      }
      return result as { readonly rows: readonly Row[]; readonly rowCount: number };
    }) as never;
  const client = {
    query: vi.fn(query as never) as typeof query,
  };
  return {
    calls,
    deps: {
      readText: vi.fn((path: string) => path.endsWith("manifest.json")
        ? manifestText
        : JSON.stringify({
            dbType: "postgres",
            postgres: {
              host: "127.0.0.1",
              port: 5432,
              database: "mengshu",
              user: "operator",
              password: "secret",
            },
          })),
      connect: vi.fn(async () => ({
        client,
        close: vi.fn(async () => undefined),
      })),
    },
  };
}

function lockContendedDependencies(): SemanticTypeBackfillOperatorDependencies {
  const fake = dependencies().deps;
  return {
    ...fake,
    connect: async (config) => {
      const connection = await fake.connect(config);
      return {
        ...connection,
        client: {
          query: (async (sql: string, params?: readonly unknown[]) => {
            if (sql.includes("semantic-type-backfill:lock")) {
              return { rows: [{ acquired: false }], rowCount: 1 };
            }
            return connection.client.query(sql, params);
          }) as typeof connection.client.query,
        },
      };
    },
  };
}

describe("semantic type backfill operator", () => {
  test("validates and deterministically hashes the immutable manifest", () => {
    const first = loadSemanticTypeBackfillManifest(manifestText);
    const second = loadSemanticTypeBackfillManifest(manifestText);
    expect(first).toEqual(second);
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => loadSemanticTypeBackfillManifest(JSON.stringify({
      ...first.manifest,
      unmappable: "drop",
    }))).toThrow(/manifest/i);
  });

  test("defaults to dry-run inside an explicit read-only transaction", async () => {
    const fake = dependencies();
    const result = await runSemanticTypeBackfillOperator([
      "--config", "/tmp/config.json",
      "--manifest", "/tmp/manifest.json",
    ], fake.deps);
    expect(result).toMatchObject({ operation: "dry-run", scanned: 0 });
    expect(fake.calls[0]).toBe("BEGIN READ ONLY");
    expect(fake.calls.at(-2)).toContain("semantic-type-backfill:unlock");
    expect(fake.calls.at(-1)).toBe("ROLLBACK");
    expect(fake.calls.some((sql) => /INSERT|UPDATE|COMMIT/.test(sql))).toBe(false);
  });

  test("apply requires maintenance, quiescence, manifest pin and exact confirmation", async () => {
    const fake = dependencies();
    const hash = loadSemanticTypeBackfillManifest(manifestText).sha256;
    await expect(runSemanticTypeBackfillOperator([
      "--config", "/tmp/config.json",
      "--manifest", "/tmp/manifest.json",
      "--apply",
    ], fake.deps)).rejects.toMatchObject({ code: "OPERATOR_APPLY_GATE_REQUIRED" });

    await expect(runSemanticTypeBackfillOperator([
      "--config", "/tmp/config.json",
      "--manifest", "/tmp/manifest.json",
      "--apply",
      "--maintenance",
      "--quiescence-confirmed",
      "--manifest-sha256", hash,
      "--confirmation-token", "APPLY:semantic-type-5type-v1",
    ], fake.deps)).resolves.toMatchObject({ operation: "apply", scanned: 0 });
  });

  test("preserves the stable executor error when the migration advisory lock is held", async () => {
    await expect(runSemanticTypeBackfillOperator([
      "--config", "/tmp/config.json",
      "--manifest", "/tmp/manifest.json",
    ], lockContendedDependencies())).rejects.toMatchObject({
      code: "SEMANTIC_TYPE_BACKFILL_LOCK_UNAVAILABLE",
    });
  });

  test("verify is read-only and rollback uses the same destructive gate", async () => {
    const fake = dependencies();
    const hash = loadSemanticTypeBackfillManifest(manifestText).sha256;
    await expect(runSemanticTypeBackfillOperator([
      "--config", "/tmp/config.json",
      "--manifest", "/tmp/manifest.json",
      "--verify",
    ], fake.deps)).resolves.toMatchObject({ operation: "verify", valid: true });
    expect(fake.calls[0]).toBe("BEGIN READ ONLY");

    await expect(runSemanticTypeBackfillOperator([
      "--config", "/tmp/config.json",
      "--manifest", "/tmp/manifest.json",
      "--rollback",
      "--maintenance",
      "--quiescence-confirmed",
      "--manifest-sha256", hash,
      "--confirmation-token", "ROLLBACK:semantic-type-5type-v1",
    ], fake.deps)).resolves.toEqual({ operation: "rollback", restored: 0 });
  });
});
