import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

import pg from "pg";

import { PostgresProvider } from
  "../../../packages/core/src/db/providers/postgres.js";
import { createEmbeddingSpace } from
  "../../../packages/core/src/domain/embedding-space.js";
import { deriveDurableJobV2DomainDedupeKey, type DurableJobV2Scope } from
  "../../../packages/core/src/storage/repositories/job-v2.js";
import { createMetric } from "./eval-metrics.js";
import type { CaseResult, SuiteSummary } from "./types.js";

const { Client } = pg;

export interface RuntimeE2ePostgresConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  readonly ssl: false;
}

export interface ProductionRestRuntimeE2eOptions {
  readonly postgres: RuntimeE2ePostgresConfig;
  readonly projectRoot?: string;
  readonly allowReset: true;
  readonly timeoutMs?: number;
}

interface RuntimeRestCase {
  readonly id: string;
  readonly suite: "mengshu-runtime-rest";
  readonly input: {
    readonly jobId: string;
    readonly leafId: string;
    readonly text: string;
  };
  readonly expected: {
    readonly healthOk: true;
    readonly records: number;
    readonly jobStatus: "completed";
    readonly effectKey: "build_tree.persist.v1";
    readonly treeLeafPersisted: true;
  };
}

const scope: DurableJobV2Scope = Object.freeze({
  tenantId: "eval-tenant",
  userId: "eval-user",
  appId: "mengshu",
  projectId: "runtime-e2e",
  agentId: "codex",
  namespace: "working-context",
  visibility: "private" as const,
});

function parseFixture(fixturePath: string): RuntimeRestCase {
  const lines = readFileSync(fixturePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (lines.length !== 1) {
    throw new Error("runtime-e2e fixture must contain exactly one case");
  }
  const value = JSON.parse(lines[0]!) as Partial<RuntimeRestCase>;
  if (value.id !== "runtime-rest-001" || value.suite !== "mengshu-runtime-rest" ||
      typeof value.input?.jobId !== "string" || typeof value.input.leafId !== "string" ||
      typeof value.input.text !== "string" || value.input.text.trim().length === 0 ||
      value.expected?.healthOk !== true || value.expected.records !== 0 ||
      value.expected.jobStatus !== "completed" ||
      value.expected.effectKey !== "build_tree.persist.v1" ||
      value.expected.treeLeafPersisted !== true) {
    throw new Error("runtime-e2e fixture contract is invalid");
  }
  return value as RuntimeRestCase;
}

function assertDedicatedDatabase(
  config: RuntimeE2ePostgresConfig,
  allowReset: true,
): void {
  if (allowReset !== true || !/^mengshu_live_[a-z0-9_]+$/.test(config.database) ||
      !Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65_535) {
    throw new Error("runtime-e2e requires an explicitly resettable mengshu_live_* database");
  }
}

async function resetDatabase(config: RuntimeE2ePostgresConfig): Promise<void> {
  const client = new Client(config);
  await client.connect();
  try {
    const identity = await client.query<{ database: string; user: string }>(
      "SELECT current_database() AS database, current_user AS user",
    );
    if (identity.rows.length !== 1 || identity.rows[0]?.database !== config.database ||
        identity.rows[0]?.user !== config.user) {
      throw new Error("runtime-e2e PostgreSQL identity does not match the dedicated target");
    }
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public AUTHORIZATION CURRENT_USER");
  } finally {
    await client.end();
  }
}

async function reservePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  const port = address && typeof address !== "string" ? address.port : 0;
  await new Promise<void>((resolve, reject) => {
    listener.close((error) => error ? reject(error) : resolve());
  });
  if (!Number.isSafeInteger(port) || port <= 0) {
    throw new Error("runtime-e2e could not reserve a local REST port");
  }
  return port;
}

function authorityConfig() {
  return {
    authority: {
      tenantId: scope.tenantId,
      userId: scope.userId,
      allow: {
        appIds: [scope.appId],
        projectIds: [scope.projectId],
        agentIds: [scope.agentId],
        namespaces: [scope.namespace],
        visibilities: [scope.visibility],
      },
    },
    defaultScope: { ...scope },
  };
}

async function waitForHealth(
  child: ChildProcessWithoutNullStreams,
  url: string,
  timeoutMs: number,
): Promise<{ ok: boolean; records?: number }> {
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  child.once("exit", () => { exited = true; });
  while (Date.now() < deadline) {
    if (exited) throw new Error("production ms serve exited before REST readiness");
    try {
      const response = await fetch(`${url}/v1/health`);
      if (response.ok) {
        return await response.json() as { ok: boolean; records?: number };
      }
    } catch {
      // Production listener is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("production ms serve REST readiness timed out");
}

async function waitForDurableEffect(
  config: RuntimeE2ePostgresConfig,
  goldenCase: RuntimeRestCase,
  timeoutMs: number,
): Promise<{ jobStatus: string; effectKey: string | null; leafCount: number }> {
  const client = new Client(config);
  await client.connect();
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await client.query<{
        job_status: string;
        effect_key: string | null;
        leaf_count: number;
      }>(`SELECT
  job.status AS job_status,
  receipt.effect_key,
  (SELECT count(*)::int FROM mengshu_tree_leaves leaf WHERE leaf.id = $2) AS leaf_count
FROM mengshu_jobs_v2 job
LEFT JOIN mengshu_job_v2_effect_receipts receipt ON receipt.job_id = job.id
WHERE job.id = $1`, [goldenCase.input.jobId, goldenCase.input.leafId]);
      const row = result.rows[0];
      if (row?.job_status === goldenCase.expected.jobStatus &&
          row.effect_key === goldenCase.expected.effectKey && row.leaf_count === 1) {
        return {
          jobStatus: row.job_status,
          effectKey: row.effect_key,
          leafCount: row.leaf_count,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    await client.end();
  }
  throw new Error("production RuntimeHost worker did not commit the durable effect in time");
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 3_000)),
  ]);
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

/**
 * Explicit-live runner. It uses the production `bin/ms.ts serve` entry; no
 * hand-built REST router, RuntimeHost, worker registry, or provider filter is
 * injected by the test.
 */
export async function runProductionRestRuntimeE2eSuite(
  fixturePath: string,
  options: ProductionRestRuntimeE2eOptions,
): Promise<{ results: CaseResult[]; summary: SuiteSummary }> {
  if (process.env.MENGSHU_RUN_LIVE_TESTS !== "1") {
    throw new Error("runtime-e2e requires MENGSHU_RUN_LIVE_TESTS=1");
  }
  const goldenCase = parseFixture(fixturePath);
  assertDedicatedDatabase(options.postgres, options.allowReset);
  const timeoutMs = options.timeoutMs ?? 20_000;
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "mengshu-runtime-e2e-"));
  let child: ChildProcessWithoutNullStreams | undefined;
  const startedAt = Date.now();
  try {
    await resetDatabase(options.postgres);
    const provider = new PostgresProvider(
      options.postgres,
      "text-embedding-3-small",
    );
    try {
      await provider.initialize();
      await provider.applyScopeContentHashDedupeContract({
        maintenance: true,
        quiescenceConfirmed: true,
      });
      await provider.registerActiveEmbeddingSpace(createEmbeddingSpace({
        provider: "openai",
        baseURL: "http://127.0.0.1:9/v1",
        model: "text-embedding-3-small",
        dim: 1536,
        normalization: "none",
      }));
      const bundle = provider.createDurableJobV2RuntimeBundle({
        clock: Date.now,
        tokenFactory: () => "runtime-e2e-lease-token-0000000000000001",
        backoffMs: () => 25,
      });
      const eventAt = Date.now() - 1;
      await bundle.repository.enqueue({
        id: goldenCase.input.jobId,
        type: "build_tree",
        payload: {
          scope,
          traceId: goldenCase.input.leafId,
          treeType: "source",
          treeKey: "runtime-e2e-source",
          leaf: {
            id: goldenCase.input.leafId,
            chunkId: goldenCase.input.leafId,
            sourceId: "runtime-e2e-source",
            text: goldenCase.input.text,
            eventAt,
          },
        },
        dedupeKey: deriveDurableJobV2DomainDedupeKey(
          "build_tree",
          goldenCase.input.leafId,
          {},
        ),
        scope,
        maxAttempts: 3,
      });
    } finally {
      await provider.close();
    }

    const port = await reservePort();
    const config = {
      embedding: {
        provider: "openai",
        apiKey: "runtime-e2e-no-network-call",
        baseURL: "http://127.0.0.1:9/v1",
        model: "text-embedding-3-small",
      },
      dbType: "postgres",
      postgres: options.postgres,
      server: { enabled: true, host: "127.0.0.1", port },
    };
    mkdirSync(tempHome, { recursive: true });
    writeFileSync(path.join(tempHome, "config.json"), JSON.stringify(config), "utf8");

    child = spawn(
      path.join(projectRoot, "node_modules/.bin/tsx"),
      [path.join(projectRoot, "bin/ms.ts"), "serve", "--host", "127.0.0.1", "--port", String(port)],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          MENGSHU_HOME: tempHome,
          MENGSHU_AUTHORITY_JSON: JSON.stringify(authorityConfig()),
          MENGSHU_AUTHORITY_FILE: "",
          NO_PROXY: "127.0.0.1,localhost,::1",
          no_proxy: "127.0.0.1,localhost,::1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    child.stdout.resume();
    child.stderr.resume();

    const health = await waitForHealth(
      child,
      `http://127.0.0.1:${port}`,
      timeoutMs,
    );
    const effect = await waitForDurableEffect(
      options.postgres,
      goldenCase,
      timeoutMs,
    );
    const failures: string[] = [];
    if (health.ok !== goldenCase.expected.healthOk) failures.push("health.ok mismatch");
    if (health.records !== goldenCase.expected.records) failures.push("health.records mismatch");
    if (effect.jobStatus !== goldenCase.expected.jobStatus) failures.push("job.status mismatch");
    if (effect.effectKey !== goldenCase.expected.effectKey) failures.push("effect key mismatch");
    if ((effect.leafCount === 1) !== goldenCase.expected.treeLeafPersisted) {
      failures.push("tree leaf persistence mismatch");
    }
    const result: CaseResult = {
      caseId: goldenCase.id,
      suite: goldenCase.suite,
      passed: failures.length === 0,
      failures,
      hitRequired: failures.length === 0
        ? [goldenCase.input.jobId, goldenCase.input.leafId]
        : [],
      missedRequired: failures.length === 0
        ? []
        : [goldenCase.input.jobId, goldenCase.input.leafId],
      injectedForbidden: [],
      filledSlots: [],
      latencyMs: Date.now() - startedAt,
      tokenEstimate: 0,
    };
    const passed = result.passed ? 1 : 0;
    return {
      results: [result],
      summary: {
        suite: goldenCase.suite,
        total: 1,
        passed,
        failed: 1 - passed,
        passRate: passed,
        slotRecallPassRate: 0,
        wrongInjectionRate: 0,
        latencyP50Ms: result.latencyMs,
        latencyP95Ms: result.latencyMs,
        failedCases: result.passed ? [] : [result],
        metrics: [createMetric({
          name: "case_pass_rate",
          numerator: passed,
          denominator: 1,
          direction: "min",
          threshold: 1,
        })],
        execution: {
          runMode: "runtime-e2e",
          provider: "postgresql-pgvector",
          model: "not-applicable-runtime-contract",
          prompt: "not-applicable-runtime-contract",
          version: "production-rest-runtime-host-v1",
          fallback: false,
          degraded: false,
        },
      },
    };
  } finally {
    if (child) await stopChild(child);
    rmSync(tempHome, { recursive: true, force: true });
  }
}
