import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import pg from "pg";

import { memoryConfigSchema, type MemoryConfig } from "../config.js";
import type { MemoryScope } from "../packages/core/src/domain/types.js";
import type { DurableJobV2Scope } from
  "../packages/core/src/storage/repositories/job-v2.js";
import { createMengshuRuntime } from "../runtime.js";
import {
  runNextDurableJobV2,
  type DurableJobV2AuthoritativeHandlerRegistry,
  type DurableJobV2RepositoryPort,
  type RunNextDurableJobV2Result,
} from "../server/workers-v2.js";

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const HISTORY_JOB_ID_PREFIX = "history-job:";
const VISIBILITIES = new Set(["private", "workspace", "team", "public"] as const);

export const HISTORY_TREE_WORKER_SCHEMA_GATE_SQL = `/* history-tree-worker:schema-gate */
SELECT COUNT(*)::text AS version_count
FROM mengshu_schema_migrations WHERE version BETWEEN 1 AND 24`;

export const HISTORY_TREE_WORKER_SCOPE_SQL = `/* history-tree-worker:scopes */
WITH exact_runs AS (
  SELECT run_id, scope_fingerprint, tenant_id, user_id, app_id, project_id,
    agent_id, namespace, visibility
  FROM mengshu_history_rebuild_runs
  WHERE migration_id = $1 AND manifest_hash = $2 AND state = 'completed'
)
SELECT job.tenant_id, job.user_id, job.app_id, job.project_id,
  job.agent_id, job.namespace, job.visibility,
  ARRAY_AGG(DISTINCT job.id ORDER BY job.id) AS target_job_ids
FROM exact_runs run
JOIN mengshu_history_rebuild_artifacts artifact USING (run_id)
JOIN mengshu_jobs_v2 job ON job.id = artifact.artifact_id
  AND job.tenant_id = run.tenant_id AND job.user_id = run.user_id
  AND job.app_id = run.app_id AND job.project_id = run.project_id
  AND job.agent_id = run.agent_id AND job.namespace = run.namespace
  AND job.visibility = run.visibility
WHERE artifact.artifact_type = 'tree_job'
GROUP BY job.tenant_id, job.user_id, job.app_id, job.project_id,
  job.agent_id, job.namespace, job.visibility
ORDER BY tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility`;

export const HISTORY_TREE_WORKER_PROGRESS_SQL = `/* history-tree-worker:progress */
WITH exact_runs AS (
  SELECT run_id, tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility
  FROM mengshu_history_rebuild_runs
  WHERE migration_id = $1 AND manifest_hash = $2 AND state = 'completed'
), expected_tree_artifacts AS (
  SELECT artifact.artifact_id
  FROM exact_runs run
  JOIN mengshu_history_rebuild_artifacts artifact USING (run_id)
  WHERE artifact.artifact_type = 'tree_job'
), target_jobs AS (
  SELECT job.id, job.status, job.tenant_id, job.user_id, job.app_id, job.project_id,
    job.agent_id, job.namespace, job.visibility
  FROM exact_runs run
  JOIN mengshu_history_rebuild_artifacts artifact USING (run_id)
  JOIN mengshu_jobs_v2 job ON job.id = artifact.artifact_id
    AND job.tenant_id = run.tenant_id AND job.user_id = run.user_id
    AND job.app_id = run.app_id AND job.project_id = run.project_id
    AND job.agent_id = run.agent_id AND job.namespace = run.namespace
    AND job.visibility = run.visibility
  WHERE artifact.artifact_type = 'tree_job'
), worker_scopes AS (
  SELECT DISTINCT tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility
  FROM target_jobs
), non_target_history_jobs AS (
  SELECT job.id
  FROM worker_scopes scope
  JOIN mengshu_jobs_v2 job USING (
    tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility
  )
  WHERE job.id LIKE 'history-job:%'
    AND job.status NOT IN ('completed', 'dead_letter')
    AND NOT EXISTS (SELECT 1 FROM target_jobs target WHERE target.id = job.id)
)
SELECT
  (SELECT COUNT(*)::text FROM expected_tree_artifacts) AS target_job_count,
  (SELECT COUNT(*) FILTER (WHERE status = 'completed')::text FROM target_jobs)
    AS completed_job_count,
  (SELECT COUNT(*) FILTER (WHERE status = 'dead_letter')::text FROM target_jobs)
    AS dead_letter_job_count,
  (SELECT COUNT(*) FILTER (WHERE status NOT IN ('completed', 'dead_letter'))::text
    FROM target_jobs) AS remaining_job_count,
  (SELECT COUNT(*)::text FROM non_target_history_jobs) AS non_target_history_job_count,
  ((SELECT COUNT(*) FROM expected_tree_artifacts) -
    (SELECT COUNT(*) FROM target_jobs))::text AS missing_target_job_count`;

export const HISTORY_TREE_WORKER_ACCEPTANCE_SQL = `/* history-tree-worker:acceptance */
WITH exact_runs AS (
  SELECT run_id, scope_fingerprint, tenant_id, user_id, app_id, project_id,
    agent_id, namespace, visibility
  FROM mengshu_history_rebuild_runs
  WHERE migration_id = $1 AND manifest_hash = $2 AND state = 'completed'
), target_jobs AS (
  SELECT artifact.run_id, artifact.artifact_role, artifact.record_id,
    job.id, job.status, job.type, job.payload, job.max_attempts, job.created_at,
    job.tenant_id, job.user_id, job.app_id, job.project_id, job.agent_id,
    job.namespace, job.visibility
  FROM exact_runs run
  JOIN mengshu_history_rebuild_artifacts artifact USING (run_id)
  JOIN mengshu_jobs_v2 job ON job.id = artifact.artifact_id
    AND job.tenant_id = run.tenant_id AND job.user_id = run.user_id
    AND job.app_id = run.app_id AND job.project_id = run.project_id
    AND job.agent_id = run.agent_id AND job.namespace = run.namespace
    AND job.visibility = run.visibility
  WHERE artifact.artifact_type = 'tree_job'
), expected_tree_artifacts AS (
  SELECT artifact.run_id, artifact.artifact_id
  FROM exact_runs run
  JOIN mengshu_history_rebuild_artifacts artifact USING (run_id)
  WHERE artifact.artifact_type = 'tree_job'
), missing_target_job AS (
  SELECT artifact.artifact_id
  FROM expected_tree_artifacts artifact
  LEFT JOIN target_jobs target
    ON target.run_id = artifact.run_id AND target.id = artifact.artifact_id
  WHERE target.id IS NULL
), worker_scopes AS (
  SELECT DISTINCT tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility
  FROM target_jobs
), non_target_nonterminal AS (
  SELECT job.id
  FROM worker_scopes scope
  JOIN mengshu_jobs_v2 job USING (
    tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility
  )
  WHERE job.id LIKE 'history-job:%'
    AND job.status NOT IN ('completed', 'dead_letter')
    AND NOT EXISTS (SELECT 1 FROM target_jobs target WHERE target.id = job.id)
), non_target_since_start AS (
  SELECT job.id
  FROM worker_scopes scope
  JOIN mengshu_jobs_v2 job USING (
    tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility
  )
  WHERE job.created_at >= $3
    AND job.id LIKE 'history-job:%'
    AND job.status NOT IN ('completed', 'dead_letter')
    AND NOT EXISTS (SELECT 1 FROM target_jobs target WHERE target.id = job.id)
), invalid_target AS (
  SELECT target.id
  FROM target_jobs target
  WHERE target.id NOT LIKE 'history-job:%' OR target.type <> 'build_tree'
    OR target.artifact_role NOT IN (
      'source_leaf', 'source_finalize', 'topic_leaf', 'topic_finalize'
    )
    OR ((target.artifact_role IN ('source_leaf', 'topic_leaf')) <>
      (target.payload ? 'leaf'))
    OR ((target.artifact_role IN ('source_finalize', 'topic_finalize')) <>
      (target.payload#>>'{finalize,mode}' = 'history_rebuild'))
    OR target.max_attempts <> CASE
      WHEN target.artifact_role IN ('source_finalize', 'topic_finalize') THEN 100 ELSE 3 END
), barrier_violation AS (
  SELECT finalize.id
  FROM target_jobs finalize
  LEFT JOIN mengshu_job_v2_effect_receipts finalize_receipt
    ON finalize_receipt.job_id = finalize.id
    AND finalize_receipt.effect_key = 'build_tree.persist.v1'
  WHERE finalize.artifact_role IN ('source_finalize', 'topic_finalize')
    AND finalize.status = 'completed'
    AND (finalize_receipt.job_id IS NULL OR EXISTS (
      SELECT 1
      FROM target_jobs leaf
      LEFT JOIN mengshu_job_v2_effect_receipts leaf_receipt
        ON leaf_receipt.job_id = leaf.id
        AND leaf_receipt.effect_key = 'build_tree.persist.v1'
      WHERE leaf.artifact_role IN ('source_leaf', 'topic_leaf')
        AND leaf.tenant_id = finalize.tenant_id AND leaf.user_id = finalize.user_id
        AND leaf.app_id = finalize.app_id AND leaf.project_id = finalize.project_id
        AND leaf.agent_id = finalize.agent_id AND leaf.namespace = finalize.namespace
        AND leaf.visibility = finalize.visibility
        AND leaf.payload->>'treeType' = finalize.payload->>'treeType'
        AND leaf.payload->>'treeKey' = finalize.payload->>'treeKey'
        AND COALESCE(leaf.payload#>>'{scope,workspaceId}', '') =
          COALESCE(finalize.payload#>>'{scope,workspaceId}', '')
        AND COALESCE(leaf.payload#>>'{scope,sessionId}', '') =
          COALESCE(finalize.payload#>>'{scope,sessionId}', '')
        AND (leaf.status <> 'completed' OR leaf_receipt.job_id IS NULL OR
          leaf_receipt.committed_at > finalize_receipt.committed_at)
    ))
), receipt_parity AS (
  SELECT target.id
  FROM target_jobs target
  LEFT JOIN mengshu_job_v2_effect_receipts receipt
    ON receipt.job_id = target.id AND receipt.effect_key = 'build_tree.persist.v1'
  WHERE target.status = 'completed'
    AND (receipt.job_id IS NULL OR receipt.request_fingerprint !~ '^[0-9a-f]{64}$'
      OR receipt.lease_generation < 1
      OR (target.artifact_role IN ('source_finalize', 'topic_finalize') AND
        (receipt.result->>'sealed' IS DISTINCT FROM 'true' OR
          receipt.result->>'nodeId' IS NULL OR
          receipt.result->'bufferId' IS DISTINCT FROM 'null'::jsonb)))
), duplicate_scope_runs AS (
  SELECT scope_fingerprint
  FROM exact_runs GROUP BY scope_fingerprint HAVING COUNT(*) <> 1
)
SELECT
  (SELECT COUNT(DISTINCT scope_fingerprint)::text FROM exact_runs) AS history_scope_count,
  (SELECT COUNT(*)::text FROM worker_scopes) AS worker_scope_count,
  (SELECT COUNT(*)::text FROM expected_tree_artifacts) AS target_job_count,
  (SELECT COUNT(*) FILTER (WHERE status = 'completed')::text FROM target_jobs)
    AS completed_job_count,
  (SELECT COUNT(*) FILTER (WHERE status = 'dead_letter')::text FROM target_jobs)
    AS dead_letter_job_count,
  (SELECT COUNT(*) FILTER (WHERE status NOT IN ('completed', 'dead_letter'))::text
    FROM target_jobs) AS remaining_job_count,
  (SELECT COUNT(*)::text FROM non_target_nonterminal) AS non_target_nonterminal_count,
  (SELECT COUNT(*)::text FROM non_target_since_start) AS non_target_since_start_count,
  (SELECT COUNT(*)::text FROM invalid_target) AS invalid_target_count,
  (SELECT COUNT(*)::text FROM missing_target_job) AS missing_target_job_count,
  (SELECT COUNT(*)::text FROM duplicate_scope_runs) AS duplicate_scope_run_count,
  (SELECT COUNT(*)::text FROM barrier_violation) AS barrier_violation_count,
  (SELECT COUNT(*)::text FROM receipt_parity) AS receipt_drift_count`;

export interface HistoryTreeWorkerQueryClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ readonly rows?: readonly Row[]; readonly rowCount?: number | null }>;
}

export interface HistoryTreeWorkerConnection {
  readonly client: HistoryTreeWorkerQueryClient;
  close(): Promise<void>;
}

export interface HistoryTreeWorkerRuntime {
  readonly repository: DurableJobV2RepositoryPort;
  readonly registry: DurableJobV2AuthoritativeHandlerRegistry;
  assertReady(): Promise<void>;
  close(): Promise<void>;
}

export interface HistoryTreeWorkerDependencies {
  readText(path: string): string;
  parseConfig(text: string): MemoryConfig;
  connect(config: MemoryConfig): Promise<HistoryTreeWorkerConnection>;
  openRuntime(config: MemoryConfig, scope: DurableJobV2Scope): Promise<HistoryTreeWorkerRuntime>;
  runNext(
    repository: DurableJobV2RepositoryPort,
    options: Parameters<typeof runNextDurableJobV2>[1],
  ): Promise<RunNextDurableJobV2Result>;
  wait(delayMs: number): Promise<void>;
  now(): number;
  reportProgress?(progress: HistoryTreeWorkerProgressReport): void;
}

export interface HistoryTreeWorkerProgressReport {
  readonly state: "running";
  readonly completedJobs: number;
  readonly remainingJobs: number;
  readonly processedJobs: number;
  readonly rounds: number;
  readonly elapsedMs: number;
  readonly throughputPerSecond: number;
  readonly etaMs: number | null;
}

export interface HistoryTreeWorkerResult {
  readonly historyScopes: number;
  readonly workerScopes: number;
  readonly targetJobs: number;
  readonly completedJobs: number;
  readonly processedJobs: number;
  readonly rounds: number;
  readonly nonTargetJobsObserved: number;
  readonly barrierViolations: 0;
  readonly receiptDrift: 0;
}

export type HistoryTreeWorkerErrorCode =
  | "HISTORY_TREE_WORKER_INVALID_ARGUMENTS"
  | "HISTORY_TREE_WORKER_WRITE_GATE_REQUIRED"
  | "HISTORY_TREE_WORKER_SCHEMA_NOT_READY"
  | "HISTORY_TREE_WORKER_SCOPE_DRIFT"
  | "HISTORY_TREE_WORKER_QUEUE_DRIFT"
  | "HISTORY_TREE_WORKER_STALLED"
  | "HISTORY_TREE_WORKER_TIMEOUT"
  | "HISTORY_TREE_WORKER_RUNTIME_FAILED";

export class HistoryTreeWorkerError extends Error {
  constructor(readonly code: HistoryTreeWorkerErrorCode) {
    super(code);
    this.name = "HistoryTreeWorkerError";
  }
}

interface HistoryTreeWorkerOptions {
  readonly configPath: string;
  readonly migrationId: string;
  readonly manifestHash: string;
  readonly expectedScopes: number;
  readonly workerId: string;
  readonly leaseMs: number;
  readonly heartbeatIntervalMs: number;
  readonly pollMs: number;
  readonly stallTimeoutMs: number;
  readonly timeoutMs: number;
  readonly maxJobs: number;
  readonly concurrency: number;
  readonly maintenance: boolean;
  readonly quiescenceConfirmed: boolean;
}

interface AcceptanceSnapshot {
  readonly historyScopes: number;
  readonly workerScopes: number;
  readonly targetJobs: number;
  readonly completedJobs: number;
  readonly deadLetterJobs: number;
  readonly remainingJobs: number;
  readonly nonTargetNonterminal: number;
  readonly nonTargetSinceStart: number;
  readonly invalidTargets: number;
  readonly missingTargetJobs: number;
  readonly duplicateScopeRuns: number;
  readonly barrierViolations: number;
  readonly receiptDrift: number;
}

interface ProgressSnapshot {
  readonly targetJobs: number;
  readonly completedJobs: number;
  readonly deadLetterJobs: number;
  readonly remainingJobs: number;
  readonly nonTargetHistoryJobs: number;
  readonly missingTargetJobs: number;
}

interface WorkerScope {
  readonly scope: DurableJobV2Scope;
  readonly idAllowlist: readonly string[];
}

function fail(code: HistoryTreeWorkerErrorCode): never {
  throw new HistoryTreeWorkerError(code);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function requiredInteger(argv: readonly string[], name: string): number {
  const index = argv.indexOf(name);
  const raw = index < 0 ? undefined : argv[index + 1];
  if (!raw || !/^[1-9][0-9]*$/.test(raw)) fail("HISTORY_TREE_WORKER_INVALID_ARGUMENTS");
  const value = Number(raw);
  return positiveInteger(value) ? value : fail("HISTORY_TREE_WORKER_INVALID_ARGUMENTS");
}

function requiredValue(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index < 0 ? undefined : argv[index + 1];
  return value && !value.startsWith("--")
    ? value
    : fail("HISTORY_TREE_WORKER_INVALID_ARGUMENTS");
}

function cliOptions(argv: readonly string[]): HistoryTreeWorkerOptions {
  const valueFlags = new Set([
    "--config", "--migration-id", "--manifest-sha256", "--expected-scopes",
    "--worker-id", "--lease-ms", "--heartbeat-ms", "--poll-ms", "--timeout-ms",
    "--stall-timeout-ms", "--max-jobs", "--concurrency",
  ]);
  const booleanFlags = new Set(["--maintenance", "--quiescence-confirmed"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (booleanFlags.has(token)) continue;
    if (!valueFlags.has(token) || !argv[index + 1] || argv[index + 1]!.startsWith("--")) {
      fail("HISTORY_TREE_WORKER_INVALID_ARGUMENTS");
    }
    index += 1;
  }
  const options = {
    configPath: requiredValue(argv, "--config"),
    migrationId: requiredValue(argv, "--migration-id"),
    manifestHash: requiredValue(argv, "--manifest-sha256"),
    expectedScopes: requiredInteger(argv, "--expected-scopes"),
    workerId: requiredValue(argv, "--worker-id"),
    leaseMs: requiredInteger(argv, "--lease-ms"),
    heartbeatIntervalMs: requiredInteger(argv, "--heartbeat-ms"),
    pollMs: requiredInteger(argv, "--poll-ms"),
    stallTimeoutMs: requiredInteger(argv, "--stall-timeout-ms"),
    timeoutMs: requiredInteger(argv, "--timeout-ms"),
    maxJobs: requiredInteger(argv, "--max-jobs"),
    concurrency: requiredInteger(argv, "--concurrency"),
    maintenance: argv.includes("--maintenance"),
    quiescenceConfirmed: argv.includes("--quiescence-confirmed"),
  };
  if (!SAFE_ID.test(options.migrationId) || !SHA256.test(options.manifestHash) ||
      !SAFE_ID.test(options.workerId) || options.heartbeatIntervalMs >= options.leaseMs ||
      options.stallTimeoutMs > options.timeoutMs || options.concurrency > 64) {
    fail("HISTORY_TREE_WORKER_INVALID_ARGUMENTS");
  }
  if (!options.maintenance || !options.quiescenceConfirmed) {
    fail("HISTORY_TREE_WORKER_WRITE_GATE_REQUIRED");
  }
  return Object.freeze(options);
}

function parseConfig(text: string): MemoryConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail("HISTORY_TREE_WORKER_INVALID_ARGUMENTS");
  }
  try {
    const config = memoryConfigSchema.parse(raw);
    if (config.dbType !== "postgres" || !config.postgres) {
      return fail("HISTORY_TREE_WORKER_INVALID_ARGUMENTS");
    }
    return config;
  } catch {
    return fail("HISTORY_TREE_WORKER_INVALID_ARGUMENTS");
  }
}

function count(value: unknown): number {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    fail("HISTORY_TREE_WORKER_QUEUE_DRIFT");
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fail("HISTORY_TREE_WORKER_QUEUE_DRIFT");
}

function scopeRow(raw: Readonly<Record<string, unknown>>): WorkerScope {
  const values = [
    raw.tenant_id, raw.user_id, raw.app_id, raw.project_id,
    raw.agent_id, raw.namespace,
  ];
  if (values.some((value) => typeof value !== "string" || !SAFE_ID.test(value)) ||
      typeof raw.visibility !== "string" ||
      !VISIBILITIES.has(raw.visibility as DurableJobV2Scope["visibility"])) {
    fail("HISTORY_TREE_WORKER_QUEUE_DRIFT");
  }
  if (!Array.isArray(raw.target_job_ids) || raw.target_job_ids.length === 0 ||
      raw.target_job_ids.some((id) => typeof id !== "string" || !SAFE_ID.test(id)) ||
      new Set(raw.target_job_ids).size !== raw.target_job_ids.length) {
    fail("HISTORY_TREE_WORKER_QUEUE_DRIFT");
  }
  return Object.freeze({
    scope: Object.freeze({
      tenantId: raw.tenant_id as string,
      userId: raw.user_id as string,
      appId: raw.app_id as string,
      projectId: raw.project_id as string,
      agentId: raw.agent_id as string,
      namespace: raw.namespace as string,
      visibility: raw.visibility as DurableJobV2Scope["visibility"],
    }),
    idAllowlist: Object.freeze([...(raw.target_job_ids as string[])]),
  });
}

async function scopes(
  client: HistoryTreeWorkerQueryClient,
  options: HistoryTreeWorkerOptions,
): Promise<readonly WorkerScope[]> {
  const schema = await client.query(HISTORY_TREE_WORKER_SCHEMA_GATE_SQL);
  if (schema.rows?.length !== 1 || count(schema.rows[0]?.version_count) !== 24) {
    fail("HISTORY_TREE_WORKER_SCHEMA_NOT_READY");
  }
  const result = await client.query(HISTORY_TREE_WORKER_SCOPE_SQL, [
    options.migrationId, options.manifestHash,
  ]);
  if (!Array.isArray(result.rows) || (result.rowCount ?? result.rows.length) !== result.rows.length) {
    fail("HISTORY_TREE_WORKER_QUEUE_DRIFT");
  }
  return Object.freeze(result.rows.map(scopeRow));
}

async function acceptance(
  client: HistoryTreeWorkerQueryClient,
  options: HistoryTreeWorkerOptions,
  operatorStartedAt: number,
): Promise<AcceptanceSnapshot> {
  const result = await client.query(HISTORY_TREE_WORKER_ACCEPTANCE_SQL, [
    options.migrationId, options.manifestHash, operatorStartedAt,
  ]);
  if (result.rows?.length !== 1 || (result.rowCount ?? 1) !== 1) {
    fail("HISTORY_TREE_WORKER_QUEUE_DRIFT");
  }
  const row = result.rows[0]!;
  return Object.freeze({
    historyScopes: count(row.history_scope_count),
    workerScopes: count(row.worker_scope_count),
    targetJobs: count(row.target_job_count),
    completedJobs: count(row.completed_job_count),
    deadLetterJobs: count(row.dead_letter_job_count),
    remainingJobs: count(row.remaining_job_count),
    nonTargetNonterminal: count(row.non_target_nonterminal_count),
    nonTargetSinceStart: count(row.non_target_since_start_count),
    invalidTargets: count(row.invalid_target_count),
    missingTargetJobs: count(row.missing_target_job_count),
    duplicateScopeRuns: count(row.duplicate_scope_run_count),
    barrierViolations: count(row.barrier_violation_count),
    receiptDrift: count(row.receipt_drift_count),
  });
}

async function progress(
  client: HistoryTreeWorkerQueryClient,
  options: HistoryTreeWorkerOptions,
): Promise<ProgressSnapshot> {
  const result = await client.query(HISTORY_TREE_WORKER_PROGRESS_SQL, [
    options.migrationId, options.manifestHash,
  ]);
  if (result.rows?.length !== 1 || (result.rowCount ?? 1) !== 1) {
    fail("HISTORY_TREE_WORKER_QUEUE_DRIFT");
  }
  const row = result.rows[0]!;
  return Object.freeze({
    targetJobs: count(row.target_job_count),
    completedJobs: count(row.completed_job_count),
    deadLetterJobs: count(row.dead_letter_job_count),
    remainingJobs: count(row.remaining_job_count),
    nonTargetHistoryJobs: count(row.non_target_history_job_count),
    missingTargetJobs: count(row.missing_target_job_count),
  });
}

function assertStableQueue(
  snapshot: AcceptanceSnapshot,
  options: HistoryTreeWorkerOptions,
): void {
  if (snapshot.historyScopes !== options.expectedScopes ||
      (snapshot.targetJobs === 0 ? snapshot.workerScopes !== 0 : snapshot.workerScopes < 1)) {
    fail("HISTORY_TREE_WORKER_SCOPE_DRIFT");
  }
  if (snapshot.targetJobs - snapshot.completedJobs > options.maxJobs) {
    fail("HISTORY_TREE_WORKER_QUEUE_DRIFT");
  }
  if (snapshot.invalidTargets !== 0 ||
      snapshot.missingTargetJobs !== 0 || snapshot.duplicateScopeRuns !== 0 ||
      snapshot.barrierViolations !== 0 || snapshot.receiptDrift !== 0 ||
      snapshot.deadLetterJobs !== 0 || snapshot.completedJobs > snapshot.targetJobs ||
      snapshot.completedJobs + snapshot.deadLetterJobs + snapshot.remainingJobs !==
        snapshot.targetJobs) {
    fail("HISTORY_TREE_WORKER_QUEUE_DRIFT");
  }
}

function assertStableProgress(
  snapshot: ProgressSnapshot,
  baseline: AcceptanceSnapshot,
): void {
  if (snapshot.targetJobs !== baseline.targetJobs || snapshot.completedJobs < baseline.completedJobs ||
      snapshot.deadLetterJobs !== 0 ||
      snapshot.missingTargetJobs !== 0 || snapshot.completedJobs > snapshot.targetJobs ||
      snapshot.completedJobs + snapshot.deadLetterJobs + snapshot.remainingJobs !==
        snapshot.targetJobs) {
    fail("HISTORY_TREE_WORKER_QUEUE_DRIFT");
  }
}

function fatalWorkerResult(result: RunNextDurableJobV2Result): boolean {
  return result.status === "uncertain" || result.status === "error" ||
    result.status === "lease_lost" || result.status === "stale" ||
    result.status === "dead_letter" || result.status === "aborted";
}

function scopedWorkerId(base: string, index: number): string {
  const workerId = `${base}:${index}`;
  return workerId.length <= 128 && SAFE_ID.test(workerId)
    ? workerId
    : fail("HISTORY_TREE_WORKER_INVALID_ARGUMENTS");
}

export async function runHistoryTreeWorker(
  argv: readonly string[],
  dependencies: HistoryTreeWorkerDependencies = createHistoryTreeWorkerDependencies(),
): Promise<HistoryTreeWorkerResult> {
  const options = cliOptions(argv);
  const config = dependencies.parseConfig(dependencies.readText(options.configPath));
  const connection = await dependencies.connect(config).catch(() =>
    fail("HISTORY_TREE_WORKER_RUNTIME_FAILED"));
  let runtime: HistoryTreeWorkerRuntime | undefined;
  try {
    const operatorStartedAt = dependencies.now();
    if (!Number.isSafeInteger(operatorStartedAt) || operatorStartedAt < 0) {
      fail("HISTORY_TREE_WORKER_RUNTIME_FAILED");
    }
    const workerScopes = await scopes(connection.client, options);
    const before = await acceptance(connection.client, options, operatorStartedAt);
    assertStableQueue(before, options);
    if (workerScopes.length !== before.workerScopes) fail("HISTORY_TREE_WORKER_SCOPE_DRIFT");
    let nonTargetJobsObserved = Math.max(
      before.nonTargetNonterminal,
      before.nonTargetSinceStart,
    );
    if (before.targetJobs === 0) {
      return Object.freeze({
        historyScopes: before.historyScopes,
        workerScopes: 0,
        targetJobs: 0,
        completedJobs: 0,
        processedJobs: 0,
        rounds: 0,
        nonTargetJobsObserved,
        barrierViolations: 0 as const,
        receiptDrift: 0 as const,
      });
    }
    runtime = await dependencies.openRuntime(config, workerScopes[0]!.scope).catch(() =>
      fail("HISTORY_TREE_WORKER_RUNTIME_FAILED"));
    await runtime.assertReady().catch(() => fail("HISTORY_TREE_WORKER_RUNTIME_FAILED"));

    let processedJobs = 0;
    let rounds = 0;
    let previousCompletedJobs = before.completedJobs;
    let lastCompletedAt = operatorStartedAt;
    for (;;) {
      if (dependencies.now() - operatorStartedAt > options.timeoutMs) {
        fail("HISTORY_TREE_WORKER_TIMEOUT");
      }
      rounds += 1;
      let madeProgress = false;
      for (let offset = 0; offset < workerScopes.length; offset += options.concurrency) {
        const batch = workerScopes.slice(offset, offset + options.concurrency);
        const results = await Promise.all(batch.map((workerScope, batchIndex) => {
          const index = offset + batchIndex;
          return dependencies.runNext(runtime!.repository, {
            scope: workerScope.scope,
            idAllowlist: workerScope.idAllowlist,
            idPrefix: HISTORY_JOB_ID_PREFIX,
            workerId: scopedWorkerId(options.workerId, index),
            leaseMs: options.leaseMs,
            heartbeatIntervalMs: options.heartbeatIntervalMs,
            registry: runtime!.registry,
          });
        }));
        for (const result of results) {
          if (fatalWorkerResult(result)) fail("HISTORY_TREE_WORKER_RUNTIME_FAILED");
          if (result.status !== "idle") {
            madeProgress = true;
            processedJobs += 1;
            if (processedJobs > options.maxJobs) fail("HISTORY_TREE_WORKER_QUEUE_DRIFT");
          }
        }
      }
      const current = await progress(connection.client, options);
      assertStableProgress(current, before);
      nonTargetJobsObserved = Math.max(
        nonTargetJobsObserved,
        current.nonTargetHistoryJobs,
      );
      const observedAt = dependencies.now();
      if (!Number.isSafeInteger(observedAt) || observedAt < operatorStartedAt) {
        fail("HISTORY_TREE_WORKER_RUNTIME_FAILED");
      }
      const elapsedMs = observedAt - operatorStartedAt;
      const completedThisRun = current.completedJobs - before.completedJobs;
      const throughputPerSecond = elapsedMs > 0
        ? completedThisRun * 1_000 / elapsedMs
        : 0;
      dependencies.reportProgress?.(Object.freeze({
        state: "running" as const,
        completedJobs: current.completedJobs,
        remainingJobs: current.remainingJobs,
        processedJobs,
        rounds,
        elapsedMs,
        throughputPerSecond,
        etaMs: current.remainingJobs === 0
          ? 0
          : throughputPerSecond > 0
            ? Math.ceil(current.remainingJobs / throughputPerSecond * 1_000)
            : null,
      }));
      if (current.remainingJobs === 0) {
        const final = await acceptance(connection.client, options, operatorStartedAt);
        assertStableQueue(final, options);
        nonTargetJobsObserved = Math.max(
          nonTargetJobsObserved,
          final.nonTargetNonterminal,
          final.nonTargetSinceStart,
        );
        if (final.completedJobs !== final.targetJobs || final.targetJobs !== before.targetJobs ||
            final.workerScopes !== before.workerScopes) fail("HISTORY_TREE_WORKER_QUEUE_DRIFT");
        return Object.freeze({
          historyScopes: final.historyScopes,
          workerScopes: final.workerScopes,
          targetJobs: final.targetJobs,
          completedJobs: final.completedJobs,
          processedJobs,
          rounds,
          nonTargetJobsObserved,
          barrierViolations: 0 as const,
          receiptDrift: 0 as const,
        });
      }
      const cohortProgress = current.completedJobs > previousCompletedJobs;
      if (cohortProgress) lastCompletedAt = observedAt;
      previousCompletedJobs = current.completedJobs;
      if ((!madeProgress || !cohortProgress) && observedAt - lastCompletedAt >= options.stallTimeoutMs) {
        fail("HISTORY_TREE_WORKER_STALLED");
      }
      await dependencies.wait(options.pollMs);
    }
  } finally {
    await runtime?.close().catch(() => undefined);
    await connection.close().catch(() => undefined);
  }
}

export function createHistoryTreeWorkerDependencies(): HistoryTreeWorkerDependencies {
  return {
    readText: (path) => readFileSync(path, "utf8"),
    parseConfig,
    connect: async (config) => {
      const pool = new pg.Pool({
        ...config.postgres!,
        max: 2,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10_000,
      });
      const client = await pool.connect();
      client.on("error", () => undefined);
      return {
        client,
        close: async () => {
          client.release();
          await pool.end();
        },
      };
    },
    openRuntime: async (config, scope) => {
      const defaultScope: MemoryScope = Object.freeze({ ...scope });
      const runtime = createMengshuRuntime({
        config,
        resolvedDbPath: "",
        appId: "mengshu",
        defaultScope,
      });
      const bundle = runtime.durableJobV2RuntimeBundle;
      const capability = runtime.durableJobV2ServeCapability;
      if (!bundle || !capability || capability.repository !== bundle.repository) {
        fail("HISTORY_TREE_WORKER_RUNTIME_FAILED");
      }
      return Object.freeze({
        repository: bundle.repository,
        registry: capability.registry,
        assertReady: async () => { await bundle.assertReady(); },
        close: () => bundle.close(),
      });
    },
    runNext: (repository, options) => runNextDurableJobV2(repository, options),
    wait: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    now: Date.now,
    reportProgress: (progress) => {
      process.stderr.write(`${JSON.stringify(progress)}\n`);
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runHistoryTreeWorker(process.argv.slice(2))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      const code = error instanceof HistoryTreeWorkerError
        ? error.code
        : "HISTORY_TREE_WORKER_RUNTIME_FAILED";
      process.stderr.write(`${JSON.stringify({ code })}\n`);
      process.exitCode = 1;
    });
}
