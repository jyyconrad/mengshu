import { describe, expect, test, vi } from "vitest";

import {
  runTopicTreeMigrationOperator,
  type TopicTreeMigrationOperatorDependencies,
} from "./operator-topic-tree-migrate.js";

const CONFIG = JSON.stringify({
  dbType: "postgres",
  postgres: {
    host: "127.0.0.1",
    port: 5432,
    database: "mengshu",
    user: "operator",
    password: "secret",
  },
});

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scope_fingerprint: "a".repeat(64),
    tenant_id: "tenant",
    user_id: "user",
    app_id: "app",
    project_id: "project",
    agent_id: "agent",
    namespace: "default",
    visibility: "private",
    workspace_id: "workspace",
    session_id: "",
    tree_key: "entity-1",
    buffer_count: "1",
    summary_count: "2",
    entity_id: "entity-1",
    canonical_name: "TypeScript Runtime",
    entity_updated_at: "100",
    existing_canonical_topic_label: null,
    ...overrides,
  };
}

function dependencies(
  scanRows: readonly Record<string, unknown>[] = [],
  checkpoint?: Record<string, unknown>,
): {
  deps: TopicTreeMigrationOperatorDependencies;
  calls: string[];
  persistAliases: ReturnType<typeof vi.fn>;
  archiveScope: ReturnType<typeof vi.fn>;
} {
  const calls: string[] = [];
  let scanned = false;
  const query = vi.fn(async (sql: string) => {
    calls.push(sql);
    if (sql.includes("topic-tree-operator:advisory-lock")) {
      return { rows: [{ locked: true }], rowCount: 1 };
    }
    if (sql.includes("topic-tree-operator:advisory-unlock")) {
      return { rows: [{ unlocked: true }], rowCount: 1 };
    }
    if (sql.includes("topic-tree-operator:snapshot-capture")) {
      return {
        rows: [{
          upper_scope_fingerprint: scanRows.length === 0 ? null : "a".repeat(64),
          upper_tree_key: scanRows.at(-1)?.tree_key ?? null,
          source_count: String(scanRows.length),
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("topic-tree-operator:snapshot-parity")) {
      return { rows: [{ source_count: String(checkpoint?.source_count ?? 1) }], rowCount: 1 };
    }
    if (sql.includes("topic-tree-operator:checkpoint-read")) {
      if (checkpoint) return { rows: [checkpoint], rowCount: 1 };
      if (scanRows.length === 0) return { rows: [{
        after_scope_fingerprint: "a".repeat(64), after_tree_key: "entity-1",
        upper_scope_fingerprint: "a".repeat(64), upper_tree_key: "entity-1",
        source_count: "1",
        counts: { scanned: 1, mapped: 1, orphan: 0, ambiguous: 0, batches: 1 },
      }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("topic-tree-operator:scan")) {
      if (scanned) return { rows: [], rowCount: 0 };
      scanned = true;
      return { rows: [...scanRows], rowCount: scanRows.length };
    }
    if (sql.includes("topic-tree-operator:receipt-write")) {
      return { rows: [{ written: String(scanRows.length) }], rowCount: 1 };
    }
    if (sql.includes("topic-tree-operator:verify")) {
      return {
        rows: [{
          receipt_count: "1",
          current_source_count: "1",
          unreceipted_count: "0",
          missing_source_count: "0",
          source_drift_count: "0",
          alias_mismatch_count: "0",
          review_count: "0",
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("topic-tree-operator:rollback-preflight")) {
      return { rows: [{ expected: "1", restorable: "1", already_restored: "0" }], rowCount: 1 };
    }
    if (sql.includes("topic-tree-operator:rollback-delete")) {
      return { rows: [{ deleted: "1" }], rowCount: 1 };
    }
    if (sql.includes("topic-tree-operator:archive-scopes")) {
      return { rows: [row()], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const persistAliases = vi.fn(async () => []);
  const archiveScope = vi.fn(async () => []);
  return {
    calls,
    persistAliases,
    archiveScope,
    deps: {
      readText: vi.fn(() => CONFIG),
      now: vi.fn(() => 1_000),
      connect: vi.fn(async () => ({
        client: { query } as never,
        close: vi.fn(async () => undefined),
      })),
      persistAliases: persistAliases as never,
      archiveScope: archiveScope as never,
    },
  };
}

const BASE = ["--config", "/tmp/config.json", "--migration-id", "topic-tree-v1"];
const WRITE_GATE = [
  "--maintenance",
  "--quiescence-confirmed",
  "--confirmation-token",
];

describe("topic tree migration operator", () => {
  test("defaults to a read-only dry-run and classifies mapped, orphan and ambiguous rows", async () => {
    const fake = dependencies([
      row(),
      row({ tree_key: "orphan", entity_id: null, canonical_name: null, entity_updated_at: null }),
      row({
        tree_key: "conflict",
        entity_id: "conflict",
        existing_canonical_topic_label: "old-label",
      }),
    ]);
    const result = await runTopicTreeMigrationOperator(BASE, fake.deps);

    expect(result).toMatchObject({
      operation: "dry-run",
      scanned: 3,
      mapped: 1,
      orphan: 1,
      ambiguous: 1,
    });
    expect(fake.calls[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(fake.calls.at(-1)).toBe("ROLLBACK");
    expect(fake.persistAliases).not.toHaveBeenCalled();
    expect(fake.calls.some((sql) => /INSERT|UPDATE|DELETE|COMMIT/.test(sql))).toBe(false);
  });

  test("apply requires maintenance, quiescence and the exact migration confirmation", async () => {
    const fake = dependencies([row()]);
    await expect(runTopicTreeMigrationOperator([...BASE, "--apply"], fake.deps))
      .rejects.toMatchObject({ code: "TOPIC_TREE_OPERATOR_WRITE_GATE_REQUIRED" });

    await expect(runTopicTreeMigrationOperator([
      ...BASE,
      "--apply",
      ...WRITE_GATE,
      "APPLY:topic-tree-v1",
    ], fake.deps)).resolves.toMatchObject({ operation: "apply", mapped: 1 });
    expect(fake.persistAliases).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      entities: [{ entityId: "entity-1", canonicalName: "TypeScript Runtime" }],
    }));
  });

  test("apply records every disposition and persists a resumable checkpoint transactionally", async () => {
    const fake = dependencies([
      row(),
      row({ tree_key: "orphan", entity_id: null, canonical_name: null, entity_updated_at: null }),
    ]);
    const result = await runTopicTreeMigrationOperator([
      ...BASE,
      "--apply",
      ...WRITE_GATE,
      "APPLY:topic-tree-v1",
    ], fake.deps);

    expect(result).toMatchObject({ scanned: 2, mapped: 1, orphan: 1 });
    expect(fake.calls).toContain("BEGIN");
    expect(fake.calls).toContain("COMMIT");
    expect(fake.calls.some((sql) => sql.includes("topic-tree-operator:receipt-write"))).toBe(true);
    expect(fake.calls.some((sql) => sql.includes("topic-tree-operator:checkpoint-write"))).toBe(true);
    expect(fake.calls.find((sql) => sql.includes("topic-tree-operator:scan")))
      .toContain("(source.scope_fingerprint, source.tree_key) <=");
  });

  test("apply resumes from the durable cursor and cumulative counts", async () => {
    const fake = dependencies([row({ tree_key: "entity-2", entity_id: "entity-2" })], {
      after_scope_fingerprint: "a".repeat(64),
      after_tree_key: "entity-1",
      upper_scope_fingerprint: "a".repeat(64),
      upper_tree_key: "entity-2",
      source_count: "2",
      counts: { scanned: 1, mapped: 1, orphan: 0, ambiguous: 0, batches: 1 },
    });
    const result = await runTopicTreeMigrationOperator([
      ...BASE,
      "--apply",
      ...WRITE_GATE,
      "APPLY:topic-tree-v1",
    ], fake.deps);

    expect(result).toMatchObject({ scanned: 2, mapped: 2, batches: 2 });
    expect(fake.calls.some((sql) => sql.includes("topic-tree-operator:checkpoint-read"))).toBe(true);
  });

  test("verify runs read-only and rejects source, receipt or alias parity drift", async () => {
    const fake = dependencies();
    await expect(runTopicTreeMigrationOperator([...BASE, "--verify"], fake.deps))
      .resolves.toMatchObject({ operation: "verify", valid: true });
    expect(fake.calls).toContain("BEGIN READ ONLY");
    expect(fake.calls[0]).toContain("topic-tree-operator:advisory-lock");

    fake.deps.connect = vi.fn(async () => ({
      client: {
        query: vi.fn(async (sql: string) => {
          if (sql.includes("advisory-lock")) return { rows: [{ locked: true }], rowCount: 1 };
          if (sql.includes("advisory-unlock")) return { rows: [{ unlocked: true }], rowCount: 1 };
          if (sql.includes("checkpoint-read")) return { rows: [{
            after_scope_fingerprint: "a".repeat(64), after_tree_key: "entity-1",
            upper_scope_fingerprint: "a".repeat(64), upper_tree_key: "entity-1",
            source_count: "1",
            counts: { scanned: 1, mapped: 1, orphan: 0, ambiguous: 0, batches: 1 },
          }], rowCount: 1 };
          if (sql.includes("snapshot-parity")) return { rows: [{ source_count: "1" }], rowCount: 1 };
          if (sql.includes("topic-tree-operator:verify")) return {
              rows: [{
                receipt_count: "1", current_source_count: "2", unreceipted_count: "1",
                missing_source_count: "0", source_drift_count: "0",
                alias_mismatch_count: "0", review_count: "0",
              }],
              rowCount: 1,
            };
          return { rows: [], rowCount: 0 };
        }),
      } as never,
      close: vi.fn(async () => undefined),
    }));
    await expect(runTopicTreeMigrationOperator([...BASE, "--verify"], fake.deps))
      .resolves.toMatchObject({ operation: "verify", valid: false, unreceipted: 1 });
  });

  test("verify is invalid while orphan or ambiguous review remains", async () => {
    const fake = dependencies([], {
      after_scope_fingerprint: "a".repeat(64), after_tree_key: "entity-1",
      upper_scope_fingerprint: "a".repeat(64), upper_tree_key: "entity-1",
      source_count: "1",
      counts: { scanned: 1, mapped: 0, orphan: 1, ambiguous: 0, batches: 1 },
    });
    fake.deps.connect = vi.fn(async () => ({
      client: {
        query: vi.fn(async (sql: string) => {
          if (sql.includes("advisory-lock")) return { rows: [{ locked: true }], rowCount: 1 };
          if (sql.includes("advisory-unlock")) return { rows: [{ unlocked: true }], rowCount: 1 };
          if (sql.includes("checkpoint-read")) return { rows: [{
            after_scope_fingerprint: "a".repeat(64), after_tree_key: "entity-1",
            upper_scope_fingerprint: "a".repeat(64), upper_tree_key: "entity-1",
            source_count: "1",
            counts: { scanned: 1, mapped: 0, orphan: 1, ambiguous: 0, batches: 1 },
          }], rowCount: 1 };
          if (sql.includes("snapshot-parity")) return { rows: [{ source_count: "1" }], rowCount: 1 };
          if (sql.includes("topic-tree-operator:verify")) return { rows: [{
            receipt_count: "1", current_source_count: "1", unreceipted_count: "0",
            missing_source_count: "0", source_drift_count: "0",
            alias_mismatch_count: "0", review_count: "1",
          }], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        }),
      } as never,
      close: vi.fn(async () => undefined),
    }));
    await expect(runTopicTreeMigrationOperator([...BASE, "--verify"], fake.deps))
      .resolves.toMatchObject({ valid: false, review: 1 });
  });

  test("apply fails closed when the migration advisory lock is already held", async () => {
    const fake = dependencies([row()]);
    fake.deps.connect = vi.fn(async () => ({
      client: { query: vi.fn(async (sql: string) => sql.includes("advisory-lock")
        ? { rows: [{ locked: false }], rowCount: 1 }
        : { rows: [], rowCount: 0 }) } as never,
      close: vi.fn(async () => undefined),
    }));
    await expect(runTopicTreeMigrationOperator([
      ...BASE, "--apply", ...WRITE_GATE, "APPLY:topic-tree-v1",
    ], fake.deps)).rejects.toMatchObject({ code: "TOPIC_TREE_OPERATOR_CONCURRENT_DRIFT" });
  });

  test("apply rejects bounded source-count drift before writing aliases", async () => {
    const checkpoint = {
      after_scope_fingerprint: "a".repeat(64), after_tree_key: "entity-1",
      upper_scope_fingerprint: "a".repeat(64), upper_tree_key: "entity-2",
      source_count: "2",
      counts: { scanned: 1, mapped: 1, orphan: 0, ambiguous: 0, batches: 1 },
    };
    const fake = dependencies([row({ tree_key: "entity-2", entity_id: "entity-2" })], checkpoint);
    fake.deps.connect = vi.fn(async () => ({
      client: {
        query: vi.fn(async (sql: string) => {
          if (sql.includes("advisory-lock")) return { rows: [{ locked: true }], rowCount: 1 };
          if (sql.includes("advisory-unlock")) return { rows: [{ unlocked: true }], rowCount: 1 };
          if (sql.includes("checkpoint-read")) return { rows: [checkpoint], rowCount: 1 };
          if (sql.includes("snapshot-parity")) return { rows: [{ source_count: "1" }], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        }),
      } as never,
      close: vi.fn(async () => undefined),
    }));

    await expect(runTopicTreeMigrationOperator([
      ...BASE, "--apply", ...WRITE_GATE, "APPLY:topic-tree-v1",
    ], fake.deps)).rejects.toMatchObject({ code: "TOPIC_TREE_OPERATOR_CONCURRENT_DRIFT" });
    expect(fake.persistAliases).not.toHaveBeenCalled();
  });

  test("rollback is quantity-conserving and protected by the destructive gate", async () => {
    const fake = dependencies();
    await expect(runTopicTreeMigrationOperator([...BASE, "--rollback"], fake.deps))
      .rejects.toMatchObject({ code: "TOPIC_TREE_OPERATOR_WRITE_GATE_REQUIRED" });
    await expect(runTopicTreeMigrationOperator([
      ...BASE,
      "--rollback",
      ...WRITE_GATE,
      "ROLLBACK:topic-tree-v1",
    ], fake.deps)).resolves.toEqual({ operation: "rollback", restored: 1 });
    expect(fake.calls).toContain("BEGIN");
    expect(fake.calls).toContain("COMMIT");
  });

  test("archive requires a retention cutoff and delegates exact-scope safety checks to core", async () => {
    const fake = dependencies();
    fake.deps.now = vi.fn(() => 4_000_000_000);
    await expect(runTopicTreeMigrationOperator([
      ...BASE,
      "--archive",
      "--superseded-before", "1000000000",
      ...WRITE_GATE,
      "ARCHIVE:topic-tree-v1",
    ], fake.deps)).resolves.toMatchObject({ operation: "archive", scopes: 1 });
    expect(fake.calls).toContain("BEGIN");
    expect(fake.calls).toContain("COMMIT");
    expect(fake.archiveScope).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      supersededBefore: 1_000_000_000,
      now: 4_000_000_000,
    }));
  });

  test("archive rejects a cutoff inside the minimum grace period", async () => {
    const fake = dependencies();
    await expect(runTopicTreeMigrationOperator([
      ...BASE, "--archive", "--superseded-before", "900",
      ...WRITE_GATE, "ARCHIVE:topic-tree-v1",
    ], fake.deps)).rejects.toMatchObject({ code: "TOPIC_TREE_OPERATOR_INVALID_ARGUMENTS" });
    expect(fake.archiveScope).not.toHaveBeenCalled();
  });
});
