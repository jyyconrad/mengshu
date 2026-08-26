import { readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

import {
  authorityScopeFingerprint,
  canonicalAuthorityScope,
} from "../packages/core/src/domain/authority-scope-fingerprint.js";
import type { MemoryScope, MemoryVisibility } from
  "../packages/core/src/domain/types.js";
import {
  deriveActiveMemoryProjections,
} from "../packages/core/src/graph/active-memory-derivation.js";
import { PostgresActiveMemoryDerivationReadPort } from
  "../packages/core/src/graph/postgres-active-derivation-read-port.js";
import {
  PostgresWorkMemoryGraphRepository,
  upsertPostgresWorkMemoryGraphInTransaction,
  type PostgresWorkMemoryQueryClient,
} from "../packages/core/src/graph/postgres-work-memory-repository.js";
import type {
  WorkMemoryEdge,
  WorkMemoryGraphBatch,
  WorkMemoryGraphNode,
} from "../packages/core/src/graph/work-memory-types.js";
import { buildWorkMemorySummaryProjection } from
  "../packages/core/src/tree/work-memory-summary-projection.js";
import type { TreeSummaryNode } from "../packages/core/src/tree/types.js";
import {
  createHistoryRebuildOperatorDependencies,
  loadHistoryRebuildManifest,
  type HistoryRebuildManifest,
} from "./operator-history-rebuild.js";

type Operation = "plan" | "apply" | "verify";

export interface HistoryWorkMemoryProjectionQueryClient extends PostgresWorkMemoryQueryClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Row[]; readonly rowCount?: number | null }>;
}

export interface HistoryWorkMemoryProjectionLoadResult {
  readonly batches: readonly WorkMemoryGraphBatch[];
  readonly activeMemories: number;
  readonly evidenceNodes: number;
  readonly summaries: number;
}

export interface HistoryWorkMemoryProjectionVerification {
  readonly nodes: number;
  readonly edges: number;
  readonly scopes: number;
}

export interface HistoryWorkMemoryProjectionDependencies {
  readText(path: string): string;
  parseConfig(text: string): unknown;
  connect(config: unknown): Promise<{
    readonly client: HistoryWorkMemoryProjectionQueryClient;
    close(): Promise<void>;
  }>;
  assertSchemaVersion(input: {
    readonly client: HistoryWorkMemoryProjectionQueryClient;
    readonly manifest: HistoryRebuildManifest;
    readonly manifestSha256: string;
    readonly operatorConfig: unknown;
  }): Promise<void>;
  loadBatches(input: {
    readonly client: HistoryWorkMemoryProjectionQueryClient;
    readonly manifest: HistoryRebuildManifest;
    readonly manifestSha256: string;
  }): Promise<HistoryWorkMemoryProjectionLoadResult>;
  upsertBatch(
    client: HistoryWorkMemoryProjectionQueryClient,
    batch: WorkMemoryGraphBatch,
  ): Promise<void>;
  verifyBatches(
    client: HistoryWorkMemoryProjectionQueryClient,
    batches: readonly WorkMemoryGraphBatch[],
  ): Promise<HistoryWorkMemoryProjectionVerification>;
  writeReport?(path: string, report: Readonly<Record<string, unknown>>): void;
}

export function normalizeHistoryWorkMemoryProjectionClient(
  client: HistoryWorkMemoryProjectionQueryClient,
): HistoryWorkMemoryProjectionQueryClient {
  return Object.freeze({
    query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ) => {
      const result = await client.query<Row>(sql, params);
      return { rows: result.rows, rowCount: result.rowCount };
    },
  });
}

type ErrorCode =
  | "HISTORY_WORK_MEMORY_INVALID_ARGUMENTS"
  | "HISTORY_WORK_MEMORY_INVALID_MANIFEST"
  | "HISTORY_WORK_MEMORY_WRITE_GATE_REQUIRED"
  | "HISTORY_WORK_MEMORY_OPERATOR_LOCKED"
  | "HISTORY_WORK_MEMORY_SCHEMA_NOT_READY"
  | "HISTORY_WORK_MEMORY_SOURCE_DRIFT"
  | "HISTORY_WORK_MEMORY_PROJECTION_DRIFT"
  | "HISTORY_WORK_MEMORY_CONNECTION_FAILED"
  | "HISTORY_WORK_MEMORY_EXECUTION_FAILED";

export class HistoryWorkMemoryProjectionError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
    this.name = "HistoryWorkMemoryProjectionError";
  }
}

function fail(code: ErrorCode): never {
  throw new HistoryWorkMemoryProjectionError(code);
}

const SHA256 = /^[0-9a-f]{64}$/;
const VISIBILITIES = new Set<MemoryVisibility>(["private", "workspace", "team", "public"]);

const OPERATOR_LOCK_SQL = `/* history-work-memory-projection:operator-lock */
SELECT pg_try_advisory_lock(hashtextextended(concat_ws(chr(31),
  'mengshu.history-rebuild-operator/v1', $1::text), 0)) AS acquired`;
const OPERATOR_UNLOCK_SQL = `/* history-work-memory-projection:operator-unlock */
SELECT pg_advisory_unlock(hashtextextended(concat_ws(chr(31),
  'mengshu.history-rebuild-operator/v1', $1::text), 0)) AS released`;

const RUNS_SQL = `/* history-work-memory-projection:runs */
SELECT run_id, scope_fingerprint, tenant_id, user_id, app_id, project_id,
  agent_id, namespace, visibility, workspace_id, session_id
FROM mengshu_history_rebuild_runs
WHERE migration_id = $1 AND manifest_hash = $2 AND state = 'completed'
ORDER BY scope_fingerprint, run_id`;

const ACTIVE_MEMORY_IDS_SQL = `/* history-work-memory-projection:active-memory-ids */
SELECT memory.id::text AS id
FROM memories memory
WHERE memory.metadata#>>'{historyRebuild,runId}' = $1
  AND memory.metadata#>>'{historyRebuild,role}' IS DISTINCT FROM 'evidence_mirror'
  AND memory.lifecycle_status = 'active'
  AND memory.metadata->>'admissionRoute' = 'active'
  AND memory.metadata->>'contextEligible' = 'true'
  AND memory.metadata->>'semanticType' IN (
    'profile', 'task_context', 'rules', 'experience', 'resource'
  )
  AND memory.legacy_quarantine_reason IS NULL
ORDER BY memory.created_at, memory.id`;

const SUMMARIES_SQL = `/* history-work-memory-projection:summaries */
WITH exact_runs AS (
  SELECT run_id FROM mengshu_history_rebuild_runs
  WHERE migration_id = $1 AND manifest_hash = $2 AND state = 'completed'
), history_tree_jobs AS (
  SELECT DISTINCT artifact.artifact_id
  FROM mengshu_history_rebuild_artifacts artifact
  JOIN exact_runs run USING (run_id)
  WHERE artifact.artifact_type = 'tree_job'
)
SELECT summary.id, summary.tree_type, summary.tree_key, summary.level,
  summary.title, summary.summary, summary.child_node_ids, summary.leaf_ids,
  summary.evidence_chunk_ids, summary.entity_ids, summary.relation_ids,
  summary.token_count, summary.start_at, summary.end_at, summary.status,
  summary.created_at, summary.sealed_at, summary.metadata,
  summary.scope_fingerprint, summary.tenant_id, summary.user_id, summary.app_id,
  summary.project_id, summary.agent_id, summary.namespace, summary.visibility,
  summary.workspace_id, summary.session_id
FROM mengshu_tree_summary_nodes summary
JOIN history_tree_jobs job ON job.artifact_id = summary.sealed_by_job_id
WHERE summary.status = 'sealed'
ORDER BY summary.level, summary.scope_fingerprint, summary.id`;

interface CliArgs {
  readonly configPath: string;
  readonly manifestPath: string;
  readonly operation: Operation;
  readonly maintenance: boolean;
  readonly quiescenceConfirmed: boolean;
  readonly manifestSha256?: string;
  readonly confirmationToken?: string;
  readonly reportPath?: string;
}

function cliArgs(argv: readonly string[]): CliArgs {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index < 0 ? undefined : argv[index + 1];
  };
  const operations = ["--plan", "--apply", "--verify"].filter((flag) => argv.includes(flag));
  const valueFlags = new Set([
    "--config", "--manifest", "--manifest-sha256", "--confirmation-token", "--report",
  ]);
  const booleanFlags = new Set([
    "--plan", "--apply", "--verify", "--maintenance", "--quiescence-confirmed",
  ]);
  let invalid = operations.length !== 1;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!valueFlags.has(token) && !booleanFlags.has(token)) invalid = true;
    if (valueFlags.has(token)) {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) invalid = true;
      index += 1;
    }
  }
  const configPath = value("--config");
  const manifestPath = value("--manifest");
  if (!configPath || !manifestPath || invalid) fail("HISTORY_WORK_MEMORY_INVALID_ARGUMENTS");
  return Object.freeze({
    configPath,
    manifestPath,
    operation: operations[0] === "--apply" ? "apply" : operations[0] === "--verify" ? "verify" : "plan",
    maintenance: argv.includes("--maintenance"),
    quiescenceConfirmed: argv.includes("--quiescence-confirmed"),
    ...(value("--manifest-sha256") ? { manifestSha256: value("--manifest-sha256") } : {}),
    ...(value("--confirmation-token") ? { confirmationToken: value("--confirmation-token") } : {}),
    ...(value("--report") ? { reportPath: value("--report") } : {}),
  });
}

function assertWriteGate(args: CliArgs, manifest: HistoryRebuildManifest, sha256: string): void {
  if (args.operation !== "apply") return;
  if (!args.maintenance || !args.quiescenceConfirmed || !args.manifestSha256 ||
      !args.confirmationToken || !SHA256.test(args.manifestSha256) ||
      args.manifestSha256 !== sha256 ||
      args.confirmationToken !== `APPLY_WORK_MEMORY_PROJECTION:${manifest.migrationId}`) {
    fail("HISTORY_WORK_MEMORY_WRITE_GATE_REQUIRED");
  }
}

function exactRows<Row extends Record<string, unknown>>(
  result: { readonly rows?: readonly Row[]; readonly rowCount?: number | null },
): readonly Row[] {
  if (!result || !Array.isArray(result.rows) ||
      (result.rowCount !== undefined && result.rowCount !== null &&
        result.rowCount !== result.rows.length)) fail("HISTORY_WORK_MEMORY_SOURCE_DRIFT");
  return result.rows;
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) fail("HISTORY_WORK_MEMORY_SOURCE_DRIFT");
  return value;
}

function integer(value: unknown): number {
  const number = typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)
    ? Number(value) : value;
  if (!Number.isSafeInteger(number) || (number as number) < 0) {
    fail("HISTORY_WORK_MEMORY_SOURCE_DRIFT");
  }
  return number as number;
}

function ids(value: unknown, allowEmpty = true): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) ||
      value.some((item) => typeof item !== "string" || item.length === 0) ||
      new Set(value).size !== value.length) fail("HISTORY_WORK_MEMORY_SOURCE_DRIFT");
  return [...value] as string[];
}

function metadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("HISTORY_WORK_MEMORY_SOURCE_DRIFT");
  }
  return { ...(value as Record<string, unknown>) };
}

function scopeFromRow(row: Record<string, unknown>): MemoryScope {
  const visibility = text(row.visibility);
  if (!VISIBILITIES.has(visibility as MemoryVisibility)) fail("HISTORY_WORK_MEMORY_SOURCE_DRIFT");
  const workspaceId = typeof row.workspace_id === "string" && row.workspace_id !== ""
    ? text(row.workspace_id) : undefined;
  const sessionId = typeof row.session_id === "string" && row.session_id !== ""
    ? text(row.session_id) : undefined;
  const scope: MemoryScope = {
    tenantId: text(row.tenant_id), userId: text(row.user_id), appId: text(row.app_id),
    projectId: text(row.project_id), agentId: text(row.agent_id),
    namespace: text(row.namespace), visibility: visibility as MemoryVisibility,
    ...(workspaceId ? { workspaceId } : {}), ...(sessionId ? { sessionId } : {}),
  };
  if (row.scope_fingerprint !== authorityScopeFingerprint(scope)) {
    fail("HISTORY_WORK_MEMORY_SOURCE_DRIFT");
  }
  return Object.freeze(scope);
}

function summaryFromRow(row: Record<string, unknown>): TreeSummaryNode {
  const level = integer(row.level);
  if (level < 1 || level > 3 || row.status !== "sealed" ||
      !["source", "topic", "global"].includes(String(row.tree_type))) {
    fail("HISTORY_WORK_MEMORY_SOURCE_DRIFT");
  }
  const createdAt = integer(row.created_at);
  const sealedAt = integer(row.sealed_at);
  const startAt = integer(row.start_at);
  const endAt = integer(row.end_at);
  if (sealedAt < createdAt || endAt < startAt) fail("HISTORY_WORK_MEMORY_SOURCE_DRIFT");
  return Object.freeze({
    id: text(row.id), scope: scopeFromRow(row),
    treeType: row.tree_type as TreeSummaryNode["treeType"], treeKey: text(row.tree_key),
    level: level as 1 | 2 | 3, title: text(row.title), summary: text(row.summary),
    childNodeIds: ids(row.child_node_ids), leafIds: ids(row.leaf_ids),
    evidenceChunkIds: ids(row.evidence_chunk_ids, false), entityIds: ids(row.entity_ids),
    relationIds: ids(row.relation_ids), tokenCount: integer(row.token_count),
    timeRange: { startAt, endAt }, status: "sealed", createdAt, sealedAt,
    metadata: metadata(row.metadata),
  });
}

function comparable<T extends WorkMemoryGraphNode | WorkMemoryEdge>(value: T): T {
  return { ...value, scope: canonicalAuthorityScope(value.scope) } as T;
}

function projectionInventory(batches: readonly WorkMemoryGraphBatch[]): {
  readonly nodes: ReadonlyMap<string, WorkMemoryGraphNode>;
  readonly edges: ReadonlyMap<string, WorkMemoryEdge>;
  readonly scopes: number;
} {
  const nodes = new Map<string, WorkMemoryGraphNode>();
  const edges = new Map<string, WorkMemoryEdge>();
  const scopes = new Set<string>();
  for (const batch of batches) {
    const fingerprint = authorityScopeFingerprint(batch.scope);
    scopes.add(fingerprint);
    for (const node of batch.nodes) {
      const key = `${fingerprint}\0${node.id}`;
      const prior = nodes.get(key);
      if (prior && !isDeepStrictEqual(comparable(prior), comparable(node))) {
        fail("HISTORY_WORK_MEMORY_PROJECTION_DRIFT");
      }
      nodes.set(key, node);
    }
    for (const edge of batch.edges) {
      const key = `${fingerprint}\0${edge.id}`;
      const prior = edges.get(key);
      if (prior && !isDeepStrictEqual(comparable(prior), comparable(edge))) {
        fail("HISTORY_WORK_MEMORY_PROJECTION_DRIFT");
      }
      edges.set(key, edge);
    }
  }
  return { nodes, edges, scopes: scopes.size };
}

async function loadProjectionBatches(input: {
  readonly client: HistoryWorkMemoryProjectionQueryClient;
  readonly manifest: HistoryRebuildManifest;
  readonly manifestSha256: string;
}): Promise<HistoryWorkMemoryProjectionLoadResult> {
  const runRows = exactRows(await input.client.query(RUNS_SQL, [
    input.manifest.migrationId, input.manifestSha256,
  ]));
  if (runRows.length === 0) fail("HISTORY_WORK_MEMORY_SOURCE_DRIFT");
  const batches: WorkMemoryGraphBatch[] = [];
  const evidenceKeys = new Set<string>();
  let activeMemories = 0;
  const readPort = new PostgresActiveMemoryDerivationReadPort(input.client);
  for (const run of runRows) {
    const scope = scopeFromRow(run);
    const runId = text(run.run_id);
    const idRows = exactRows(await input.client.query(ACTIVE_MEMORY_IDS_SQL, [runId]));
    const activeMemoryIds = idRows.map((row) => text(row.id));
    if (new Set(activeMemoryIds).size !== activeMemoryIds.length) {
      fail("HISTORY_WORK_MEMORY_SOURCE_DRIFT");
    }
    if (activeMemoryIds.length === 0) continue;
    const signal = new AbortController().signal;
    const records = await readPort.readCommittedActiveRecords({ activeMemoryIds, scope, signal });
    const evidenceFacts = await readPort.readEvidenceFacts({
      memoryIds: activeMemoryIds, records, signal,
    });
    const projection = deriveActiveMemoryProjections({
      records, activeMemoryIds, evidenceFacts, treeFacts: [],
    });
    if (projection.projections.length !== activeMemoryIds.length) {
      fail("HISTORY_WORK_MEMORY_SOURCE_DRIFT");
    }
    for (const item of projection.projections) {
      if (item.graph.status !== "available") fail("HISTORY_WORK_MEMORY_SOURCE_DRIFT");
      batches.push(item.graph.batch);
      activeMemories += 1;
      for (const node of item.graph.batch.nodes) {
        if (node.nodeType === "evidence") {
          evidenceKeys.add(`${authorityScopeFingerprint(node.scope)}\0${node.id}`);
        }
      }
    }
  }
  const summaryRows = exactRows(await input.client.query(SUMMARIES_SQL, [
    input.manifest.migrationId, input.manifestSha256,
  ]));
  for (const row of summaryRows) {
    batches.push(buildWorkMemorySummaryProjection(summaryFromRow(row)));
  }
  projectionInventory(batches);
  return Object.freeze({
    batches: Object.freeze(batches), activeMemories,
    evidenceNodes: evidenceKeys.size, summaries: summaryRows.length,
  });
}

async function verifyProjectionBatches(
  client: HistoryWorkMemoryProjectionQueryClient,
  batches: readonly WorkMemoryGraphBatch[],
): Promise<HistoryWorkMemoryProjectionVerification> {
  const inventory = projectionInventory(batches);
  const repository = new PostgresWorkMemoryGraphRepository({
    query: (sql, params) => client.query(sql, params),
    connect: async () => fail("HISTORY_WORK_MEMORY_EXECUTION_FAILED"),
  });
  for (const expected of inventory.nodes.values()) {
    const actual = await repository.getWorkMemoryNode(expected.id, expected.scope);
    if (!actual || !isDeepStrictEqual(comparable(actual), comparable(expected))) {
      fail("HISTORY_WORK_MEMORY_PROJECTION_DRIFT");
    }
  }
  for (const expected of inventory.edges.values()) {
    const actual = await repository.getWorkMemoryEdge(expected.id, expected.scope);
    if (!actual || !isDeepStrictEqual(comparable(actual), comparable(expected))) {
      fail("HISTORY_WORK_MEMORY_PROJECTION_DRIFT");
    }
  }
  return Object.freeze({ nodes: inventory.nodes.size, edges: inventory.edges.size, scopes: inventory.scopes });
}

export function createHistoryWorkMemoryProjectionDependencies():
HistoryWorkMemoryProjectionDependencies {
  const history = createHistoryRebuildOperatorDependencies();
  return {
    readText: (path) => readFileSync(path, "utf8"),
    parseConfig: history.parseConfig,
    connect: async (config) => {
      const connection = await history.connect(config);
      return {
        client: normalizeHistoryWorkMemoryProjectionClient(
          connection.client as HistoryWorkMemoryProjectionQueryClient,
        ),
        close: () => connection.close(),
      };
    },
    assertSchemaVersion: ({ client, manifest, manifestSha256, operatorConfig }) =>
      history.assertSchemaVersion({
        client, manifest, manifestSha256, operatorConfig, modelAssisted: false,
      }),
    loadBatches: loadProjectionBatches,
    upsertBatch: (client, batch) => upsertPostgresWorkMemoryGraphInTransaction(client, batch),
    verifyBatches: verifyProjectionBatches,
    writeReport: (path, report) => {
      writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, {
        encoding: "utf8", flag: "wx", mode: 0o600,
      });
    },
  };
}

async function changeLock(
  client: HistoryWorkMemoryProjectionQueryClient,
  migrationId: string,
  operation: "acquire" | "release",
): Promise<boolean> {
  const result = await client.query(
    operation === "acquire" ? OPERATOR_LOCK_SQL : OPERATOR_UNLOCK_SQL,
    [migrationId],
  );
  const row = result.rows[0];
  const key = operation === "acquire" ? "acquired" : "released";
  return result.rowCount === 1 && result.rows.length === 1 && row?.[key] === true;
}

export async function runHistoryWorkMemoryProjectionOperator(
  argv: readonly string[],
  dependencies: HistoryWorkMemoryProjectionDependencies =
    createHistoryWorkMemoryProjectionDependencies(),
): Promise<Record<string, unknown>> {
  const args = cliArgs(argv);
  let loaded;
  try {
    loaded = loadHistoryRebuildManifest(dependencies.readText(args.manifestPath));
  } catch {
    fail("HISTORY_WORK_MEMORY_INVALID_MANIFEST");
  }
  if (loaded.manifest.requiredSchemaVersion !== 24 || !loaded.manifest.tree.requireSealed) {
    fail("HISTORY_WORK_MEMORY_INVALID_MANIFEST");
  }
  assertWriteGate(args, loaded.manifest, loaded.sha256);
  let config: unknown;
  try {
    config = dependencies.parseConfig(dependencies.readText(args.configPath));
  } catch {
    fail("HISTORY_WORK_MEMORY_CONNECTION_FAILED");
  }
  const connection = await dependencies.connect(config)
    .catch(() => fail("HISTORY_WORK_MEMORY_CONNECTION_FAILED"));
  let locked = false;
  let transactionOpen = false;
  let primaryFailure: unknown;
  try {
    locked = await changeLock(connection.client, loaded.manifest.migrationId, "acquire");
    if (!locked) fail("HISTORY_WORK_MEMORY_OPERATOR_LOCKED");
    await connection.client.query(args.operation === "apply"
      ? "BEGIN ISOLATION LEVEL SERIALIZABLE" : "BEGIN READ ONLY");
    transactionOpen = true;
    try {
      await dependencies.assertSchemaVersion({
        client: connection.client,
        manifest: loaded.manifest,
        manifestSha256: loaded.sha256,
        operatorConfig: config,
      });
    } catch {
      fail("HISTORY_WORK_MEMORY_SCHEMA_NOT_READY");
    }
    const loadedBatches = await dependencies.loadBatches({
      client: connection.client,
      manifest: loaded.manifest,
      manifestSha256: loaded.sha256,
    });
    const inventory = projectionInventory(loadedBatches.batches);
    let verification: HistoryWorkMemoryProjectionVerification = {
      nodes: inventory.nodes.size, edges: inventory.edges.size, scopes: inventory.scopes,
    };
    if (args.operation === "apply") {
      for (const batch of loadedBatches.batches) {
        await dependencies.upsertBatch(connection.client, batch);
      }
      verification = await dependencies.verifyBatches(connection.client, loadedBatches.batches);
      await connection.client.query("COMMIT");
    } else if (args.operation === "verify") {
      verification = await dependencies.verifyBatches(connection.client, loadedBatches.batches);
      await connection.client.query("ROLLBACK");
    } else {
      await connection.client.query("ROLLBACK");
    }
    transactionOpen = false;
    const report = Object.freeze({
      operation: args.operation,
      migrationId: loaded.manifest.migrationId,
      manifestSha256: loaded.sha256,
      requiredSchemaVersion: loaded.manifest.requiredSchemaVersion,
      writes: args.operation === "apply" ? undefined : 0,
      modelCalls: 0,
      projectedBatches: loadedBatches.batches.length,
      activeMemories: loadedBatches.activeMemories,
      evidenceNodes: loadedBatches.evidenceNodes,
      summaries: loadedBatches.summaries,
      ...verification,
    });
    if (args.reportPath) dependencies.writeReport?.(args.reportPath, report);
    return report;
  } catch (error) {
    primaryFailure = error;
    if (transactionOpen) {
      await connection.client.query("ROLLBACK").catch(() => undefined);
      transactionOpen = false;
    }
    if (error instanceof HistoryWorkMemoryProjectionError) throw error;
    fail("HISTORY_WORK_MEMORY_EXECUTION_FAILED");
  } finally {
    let releaseFailed = false;
    if (locked) {
      releaseFailed = !await changeLock(
        connection.client,
        loaded.manifest.migrationId,
        "release",
      ).catch(() => false);
    }
    await connection.close().catch(() => undefined);
    if (releaseFailed && primaryFailure === undefined) {
      fail("HISTORY_WORK_MEMORY_CONNECTION_FAILED");
    }
  }
  fail("HISTORY_WORK_MEMORY_EXECUTION_FAILED");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runHistoryWorkMemoryProjectionOperator(process.argv.slice(2))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      const code = error instanceof HistoryWorkMemoryProjectionError
        ? error.code : "HISTORY_WORK_MEMORY_EXECUTION_FAILED";
      process.stderr.write(`${JSON.stringify({ code })}\n`);
      process.exitCode = 1;
    });
}
