import { describe, expect, test, vi } from "vitest";

import type { MemoryConfig } from "../config.js";
import type { DurableJobV2Scope } from
  "../packages/core/src/storage/repositories/job-v2.js";
import type { DurableJobV2RepositoryPort } from "../server/workers-v2.js";
import {
  HISTORY_TREE_WORKER_ACCEPTANCE_SQL,
  HISTORY_TREE_WORKER_PROGRESS_SQL,
  HISTORY_TREE_WORKER_SCHEMA_GATE_SQL,
  HISTORY_TREE_WORKER_SCOPE_SQL,
  HistoryTreeWorkerError,
  runHistoryTreeWorker,
  type HistoryTreeWorkerDependencies,
  type HistoryTreeWorkerQueryClient,
} from "./operator-history-tree-worker.js";

const MANIFEST_HASH = "a".repeat(64);
const config = {
  embedding: {
    provider: "openai",
    apiKey: "test-key",
    baseURL: "https://example.test/v1",
    model: "text-embedding-3-small",
  },
  dbType: "postgres",
  postgres: {
    host: "127.0.0.1",
    port: 55432,
    database: "mengshu_drill",
    user: "jiangyayun",
    password: "unused",
    ssl: false,
  },
} satisfies MemoryConfig;

function argv(overrides: readonly string[] = []): readonly string[] {
  return [
    "--config", "/tmp/drill-config.json",
    "--migration-id", "history-rebuild-v1",
    "--manifest-sha256", MANIFEST_HASH,
    "--expected-scopes", "41",
    "--worker-id", "history-tree-drill",
    "--lease-ms", "30000",
    "--heartbeat-ms", "10000",
    "--poll-ms", "10",
    "--stall-timeout-ms", "10000",
    "--timeout-ms", "60000",
    "--max-jobs", "1000",
    "--concurrency", "4",
    "--maintenance",
    "--quiescence-confirmed",
    ...overrides,
  ];
}

function scope(index: number): DurableJobV2Scope {
  return Object.freeze({
    tenantId: `tenant-${index}`,
    userId: `user-${index}`,
    appId: "openclaw",
    projectId: `project-${index}`,
    agentId: "agent",
    namespace: "working-context",
    visibility: "private" as const,
  });
}

function scopeRow(value: DurableJobV2Scope) {
  return {
    tenant_id: value.tenantId,
    user_id: value.userId,
    app_id: value.appId,
    project_id: value.projectId,
    agent_id: value.agentId,
    namespace: value.namespace,
    visibility: value.visibility,
    target_job_ids: [
      `history-job:${value.tenantId}:leaf`,
      `history-job:${value.tenantId}:finalize`,
    ],
  };
}

function acceptance(overrides: Record<string, string> = {}) {
  return {
    history_scope_count: "41",
    worker_scope_count: "41",
    target_job_count: "82",
    completed_job_count: "0",
    dead_letter_job_count: "0",
    remaining_job_count: "82",
    non_target_nonterminal_count: "0",
    non_target_since_start_count: "0",
    invalid_target_count: "0",
    missing_target_job_count: "0",
    duplicate_scope_run_count: "0",
    barrier_violation_count: "0",
    receipt_drift_count: "0",
    ...overrides,
  };
}

function progress(overrides: Record<string, string> = {}) {
  return {
    target_job_count: "82",
    completed_job_count: "0",
    dead_letter_job_count: "0",
    remaining_job_count: "82",
    non_target_history_job_count: "0",
    missing_target_job_count: "0",
    ...overrides,
  };
}

function dependencies(input: {
  readonly snapshots?: readonly Record<string, string>[];
  readonly progressSnapshots?: readonly Record<string, string>[];
  readonly runNext?: HistoryTreeWorkerDependencies["runNext"];
  readonly repository?: DurableJobV2RepositoryPort;
  readonly workerScopes?: readonly DurableJobV2Scope[];
  readonly wait?: HistoryTreeWorkerDependencies["wait"];
  readonly now?: HistoryTreeWorkerDependencies["now"];
  readonly reportProgress?: NonNullable<HistoryTreeWorkerDependencies["reportProgress"]>;
} = {}) {
  const workerScopes = input.workerScopes ?? Array.from({ length: 41 }, (_, index) => scope(index));
  const snapshots = [...(input.snapshots ?? [
    acceptance(),
    acceptance({ completed_job_count: "82", remaining_job_count: "0" }),
  ])];
  const progressSnapshots = [...(input.progressSnapshots ?? [
    progress({ completed_job_count: "41", remaining_job_count: "41" }),
    progress({ completed_job_count: "82", remaining_job_count: "0" }),
  ])];
  const queryImpl = async (sql: string) => {
    if (sql.includes("history-tree-worker:schema-gate")) {
      return { rows: [{ version_count: "24" }], rowCount: 1 };
    }
    if (sql.includes("history-tree-worker:scopes")) {
      return { rows: workerScopes.map(scopeRow), rowCount: workerScopes.length };
    }
    if (sql.includes("history-tree-worker:acceptance")) {
      const row = snapshots.shift();
      if (!row) throw new Error("unexpected acceptance query");
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes("history-tree-worker:progress")) {
      const row = progressSnapshots.shift();
      if (!row) throw new Error("unexpected progress query");
      return { rows: [row], rowCount: 1 };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
  const queryMock = vi.fn(queryImpl);
  const query = queryMock as unknown as HistoryTreeWorkerQueryClient["query"] & {
    mock: ReturnType<typeof vi.fn>["mock"];
    mockImplementation: typeof queryMock.mockImplementation;
  };
  const closeConnection = vi.fn(async () => undefined);
  const closeRuntime = vi.fn(async () => undefined);
  const assertReady = vi.fn(async () => undefined);
  const runNext = vi.fn(input.runNext ?? (async (_repository, options) => ({
    status: "completed" as const,
    id: `job-${options.scope.tenantId}`,
    type: "build_tree",
  })));
  const deps: HistoryTreeWorkerDependencies = {
    readText: () => "{}",
    parseConfig: () => config,
    connect: async () => ({ client: { query }, close: closeConnection }),
    openRuntime: async () => ({
      repository: input.repository ?? {} as never,
      registry: {
        authoritative: true,
        types: ["build_tree", "extract_candidate", "extract_graph"],
        get: () => async () => undefined,
      },
      assertReady,
      close: closeRuntime,
    }),
    runNext,
    wait: input.wait ?? (async () => undefined),
    now: input.now ?? (() => 1_000),
    ...(input.reportProgress ? { reportProgress: input.reportProgress } : {}),
  };
  return { deps, query, runNext, assertReady, closeRuntime, closeConnection, workerScopes };
}

describe("history tree multi-scope worker operator", () => {
  test("uses the formal native worker once for every one of 41 authority scopes", async () => {
    const harness = dependencies();

    await expect(runHistoryTreeWorker(argv(), harness.deps)).resolves.toEqual({
      historyScopes: 41,
      workerScopes: 41,
      targetJobs: 82,
      completedJobs: 82,
      processedJobs: 82,
      rounds: 2,
      nonTargetJobsObserved: 0,
      barrierViolations: 0,
      receiptDrift: 0,
    });
    expect(harness.runNext).toHaveBeenCalledTimes(82);
    expect(harness.runNext.mock.calls.slice(0, 41).map((call) => call[1].scope))
      .toEqual(harness.workerScopes);
    expect(harness.runNext.mock.calls.slice(41).map((call) => call[1].scope))
      .toEqual(harness.workerScopes);
    expect(harness.runNext.mock.calls.every((call) =>
      call[1].registry.types.join(",") === "build_tree,extract_candidate,extract_graph"
    )).toBe(true);
    expect(harness.runNext.mock.calls.slice(0, 41).map((call) => call[1].idAllowlist))
      .toEqual(harness.workerScopes.map((workerScope) => [
        `history-job:${workerScope.tenantId}:leaf`,
        `history-job:${workerScope.tenantId}:finalize`,
      ]));
    expect(harness.assertReady).toHaveBeenCalledTimes(1);
    expect(harness.closeRuntime).toHaveBeenCalledTimes(1);
    expect(harness.closeConnection).toHaveBeenCalledTimes(1);
  });

  test("runs scopes with bounded concurrency and reports structured throughput/ETA progress", async () => {
    let active = 0;
    let maxActive = 0;
    let now = 1_000;
    const reportProgress = vi.fn();
    const harness = dependencies({
      progressSnapshots: [progress({ completed_job_count: "82", remaining_job_count: "0" })],
      now: () => now,
      reportProgress,
      runNext: async (_repository, options) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        now += 1;
        return { status: "completed", id: `job-${options.scope.tenantId}`, type: "build_tree" };
      },
    });

    await expect(runHistoryTreeWorker(argv(), harness.deps)).resolves.toMatchObject({ rounds: 1 });
    expect(maxActive).toBe(4);
    expect(reportProgress).toHaveBeenCalledWith(expect.objectContaining({
      state: "running",
      completedJobs: 82,
      remainingJobs: 0,
      throughputPerSecond: expect.any(Number),
      etaMs: 0,
    }));
  });

  test("zero tree-job cohort skips runtime/worker and completes as a valid no-op", async () => {
    const harness = dependencies({
      workerScopes: [],
      snapshots: [acceptance({
        worker_scope_count: "0",
        target_job_count: "0",
        completed_job_count: "0",
        remaining_job_count: "0",
      })],
      progressSnapshots: [],
    });

    await expect(runHistoryTreeWorker(argv(), harness.deps)).resolves.toEqual({
      historyScopes: 41,
      workerScopes: 0,
      targetJobs: 0,
      completedJobs: 0,
      processedJobs: 0,
      rounds: 0,
      nonTargetJobsObserved: 0,
      barrierViolations: 0,
      receiptDrift: 0,
    });
    expect(harness.assertReady).not.toHaveBeenCalled();
    expect(harness.runNext).not.toHaveBeenCalled();
    expect(harness.closeRuntime).not.toHaveBeenCalled();
    expect(harness.closeConnection).toHaveBeenCalledTimes(1);
  });

  test("fails on a real no-progress window even when poll interval is much smaller than total timeout", async () => {
    let now = 1_000;
    const args = [...argv()];
    args[args.indexOf("--stall-timeout-ms") + 1] = "20";
    const harness = dependencies({
      progressSnapshots: [progress(), progress(), progress()],
      runNext: async () => ({ status: "idle" }),
      now: () => now,
      wait: async (delayMs) => { now += delayMs; },
    });

    await expect(runHistoryTreeWorker(args, harness.deps)).rejects.toEqual(
      new HistoryTreeWorkerError("HISTORY_TREE_WORKER_STALLED"),
    );
    expect(now).toBeLessThan(61_000);
  });

  test("passes each authority scope's exact target job allowlist to the native worker", async () => {
    const workerScopes = [scope(0), scope(1)];
    const harness = dependencies({
      workerScopes,
      snapshots: [
        acceptance({ worker_scope_count: "2", target_job_count: "4", remaining_job_count: "4" }),
        acceptance({
          worker_scope_count: "2",
          target_job_count: "4",
          completed_job_count: "4",
          remaining_job_count: "0",
        }),
      ],
      progressSnapshots: [progress({
        target_job_count: "4",
        completed_job_count: "4",
        remaining_job_count: "0",
      })],
    });

    await expect(runHistoryTreeWorker(argv(), harness.deps)).resolves.toMatchObject({
      completedJobs: 4,
      rounds: 1,
    });
    expect(harness.runNext.mock.calls.map((call) => call[1].idAllowlist)).toEqual([
      ["history-job:tenant-0:leaf", "history-job:tenant-0:finalize"],
      ["history-job:tenant-1:leaf", "history-job:tenant-1:finalize"],
    ]);
    expect(harness.runNext.mock.calls.every((call) => call[1].idPrefix === "history-job:"))
      .toBe(true);
  });

  test("fails closed before opening runtime when a scope allowlist is empty or duplicated", async () => {
    for (const targetJobIds of [[], ["history-job:duplicate", "history-job:duplicate"]]) {
      const workerScope = scope(0);
      const harness = dependencies({ workerScopes: [workerScope] });
      harness.query.mockImplementation(async (sql: string) => {
        if (sql.includes("history-tree-worker:schema-gate")) {
          return { rows: [{ version_count: "24" }], rowCount: 1 };
        }
        if (sql.includes("history-tree-worker:scopes")) {
          return {
            rows: [{ ...scopeRow(workerScope), target_job_ids: targetJobIds }],
            rowCount: 1,
          };
        }
        throw new Error(`unexpected SQL: ${sql}`);
      });

      await expect(runHistoryTreeWorker(argv(), harness.deps)).rejects.toEqual(
        new HistoryTreeWorkerError("HISTORY_TREE_WORKER_QUEUE_DRIFT"),
      );
      expect(harness.assertReady).not.toHaveBeenCalled();
    }
  });

  test("fails before runtime mutation on scope drift or finalize barrier violation", async () => {
    const drift = dependencies({ snapshots: [acceptance({ history_scope_count: "40" })] });
    await expect(runHistoryTreeWorker(argv(), drift.deps)).rejects.toEqual(
      new HistoryTreeWorkerError("HISTORY_TREE_WORKER_SCOPE_DRIFT"),
    );
    expect(drift.runNext).not.toHaveBeenCalled();

    const barrier = dependencies({
      snapshots: [acceptance({ barrier_violation_count: "1" })],
    });
    await expect(runHistoryTreeWorker(argv(), barrier.deps)).rejects.toEqual(
      new HistoryTreeWorkerError("HISTORY_TREE_WORKER_QUEUE_DRIFT"),
    );
    expect(barrier.runNext).not.toHaveBeenCalled();
  });

  test("observes but does not mutate or block on non-target history jobs", async () => {
    const harness = dependencies({
      snapshots: [
        acceptance({ non_target_nonterminal_count: "3" }),
        acceptance({
          completed_job_count: "82",
          remaining_job_count: "0",
          non_target_nonterminal_count: "3",
        }),
      ],
      progressSnapshots: [progress({
        completed_job_count: "82",
        remaining_job_count: "0",
        non_target_history_job_count: "3",
      })],
    });

    await expect(runHistoryTreeWorker(argv(), harness.deps)).resolves.toMatchObject({
      completedJobs: 82,
      nonTargetJobsObserved: 3,
    });
    expect(harness.query.mock.calls.every(([sql]) =>
      String(sql).includes("history-tree-worker:supersede-stale")
    )).toBe(false);
  });

  test("requires explicit maintenance and quiescence gates", async () => {
    const harness = dependencies();
    const withoutQuiescence = argv().filter((value) => value !== "--quiescence-confirmed");
    await expect(runHistoryTreeWorker(withoutQuiescence, harness.deps)).rejects.toEqual(
      new HistoryTreeWorkerError("HISTORY_TREE_WORKER_WRITE_GATE_REQUIRED"),
    );
    expect(harness.query).not.toHaveBeenCalled();
  });

  test("acceptance SQL proves exact cohort, native receipts, sealed finalize, and barrier", () => {
    expect(HISTORY_TREE_WORKER_SCHEMA_GATE_SQL).toContain("BETWEEN 1 AND 24");
    expect(HISTORY_TREE_WORKER_SCOPE_SQL).toContain("ARRAY_AGG(DISTINCT job.id");
    expect(HISTORY_TREE_WORKER_SCOPE_SQL).toContain("mengshu_history_rebuild_artifacts");
    expect(HISTORY_TREE_WORKER_SCOPE_SQL).toContain("artifact.artifact_type = 'tree_job'");
    expect(HISTORY_TREE_WORKER_ACCEPTANCE_SQL).toContain("non_target_nonterminal");
    expect(HISTORY_TREE_WORKER_ACCEPTANCE_SQL.match(/job\.id LIKE 'history-job:%'/g))
      .toHaveLength(2);
    expect(HISTORY_TREE_WORKER_ACCEPTANCE_SQL).toContain("build_tree.persist.v1");
    expect(HISTORY_TREE_WORKER_ACCEPTANCE_SQL).toContain("barrier_violation");
    expect(HISTORY_TREE_WORKER_ACCEPTANCE_SQL).toContain("missing_target_job");
    expect(HISTORY_TREE_WORKER_ACCEPTANCE_SQL).toContain(
      "leaf.status <> 'completed' OR leaf_receipt.job_id IS NULL",
    );
    expect(HISTORY_TREE_WORKER_ACCEPTANCE_SQL).toContain(
      "leaf_receipt.committed_at > finalize_receipt.committed_at",
    );
    expect(HISTORY_TREE_WORKER_ACCEPTANCE_SQL).toContain(
      "receipt.result->>'sealed' IS DISTINCT FROM 'true'",
    );
    expect(HISTORY_TREE_WORKER_ACCEPTANCE_SQL).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/i);
    expect(HISTORY_TREE_WORKER_ACCEPTANCE_SQL).toContain(
      "job.status NOT IN ('completed', 'dead_letter')",
    );
  });

  test("scope, progress, and acceptance bind every target job to its completed run authority scope", () => {
    for (const sql of [
      HISTORY_TREE_WORKER_SCOPE_SQL,
      HISTORY_TREE_WORKER_PROGRESS_SQL,
      HISTORY_TREE_WORKER_ACCEPTANCE_SQL,
    ]) {
      for (const field of [
        "tenant_id",
        "user_id",
        "app_id",
        "project_id",
        "agent_id",
        "namespace",
        "visibility",
      ]) {
        expect(sql).toContain(`job.${field} = run.${field}`);
      }
    }
  });

  test("hot-loop progress SQL avoids payload and receipt barrier scans", () => {
    expect(HISTORY_TREE_WORKER_PROGRESS_SQL).toContain("history-tree-worker:progress");
    expect(HISTORY_TREE_WORKER_PROGRESS_SQL).toContain("non_target_history_job_count");
    expect(HISTORY_TREE_WORKER_PROGRESS_SQL).toContain("missing_target_job_count");
    expect(HISTORY_TREE_WORKER_PROGRESS_SQL).not.toContain("build_tree.persist.v1");
    expect(HISTORY_TREE_WORKER_PROGRESS_SQL).not.toContain("payload");
    expect(HISTORY_TREE_WORKER_PROGRESS_SQL).not.toContain("effect_receipts");
    expect(HISTORY_TREE_WORKER_PROGRESS_SQL).toContain(
      "job.status NOT IN ('completed', 'dead_letter')",
    );
  });

  test("barrier permits a completed leaf job reused across runs and creation cohorts", () => {
    expect(HISTORY_TREE_WORKER_ACCEPTANCE_SQL).not.toContain(
      "leaf.run_id = finalize.run_id",
    );
    expect(HISTORY_TREE_WORKER_ACCEPTANCE_SQL).not.toContain(
      "leaf.created_at = finalize.created_at",
    );
    expect(HISTORY_TREE_WORKER_ACCEPTANCE_SQL).not.toContain("barrier_cohort_drift");
    expect(HISTORY_TREE_WORKER_ACCEPTANCE_SQL).toContain(
      "leaf.payload->>'treeKey' = finalize.payload->>'treeKey'",
    );
  });

  test.each([
    ["missing leaf persistence receipt", "leaf_receipt.job_id IS NULL"],
    [
      "leaf persistence committed after finalize",
      "leaf_receipt.committed_at > finalize_receipt.committed_at",
    ],
  ])("barrier rejects %s", (_scenario, predicate) => {
    expect(HISTORY_TREE_WORKER_ACCEPTANCE_SQL).toContain(predicate);
  });
});
