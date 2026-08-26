import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import pg from "pg";

import type { MemoryScope } from "../packages/core/src/domain/types.js";
import {
  archiveSupersededPostgresTopicTrees,
  persistPostgresTopicTreeAliases,
  type ArchiveSupersededPostgresTopicTreesInput,
  type PersistPostgresTopicTreeAliasesInput,
  type PostgresTopicTreeMigrationQueryClient,
} from "../packages/core/src/tree/postgres-topic-tree-migration.js";
import { normalizeTopicLabel } from "../packages/core/src/tree/tree-fan-out.js";
import {
  parseOperatorPostgresConfig,
  type OperatorPostgresConfig,
} from "./operator-scope-stage.js";

export interface TopicTreeMigrationOperatorConnection {
  readonly client: PostgresTopicTreeMigrationQueryClient;
  readonly close: () => Promise<void>;
}

export interface TopicTreeMigrationOperatorDependencies {
  readText: (path: string) => string;
  now: () => number;
  connect: (config: OperatorPostgresConfig) => Promise<TopicTreeMigrationOperatorConnection>;
  persistAliases: (
    client: PostgresTopicTreeMigrationQueryClient,
    input: PersistPostgresTopicTreeAliasesInput,
  ) => ReturnType<typeof persistPostgresTopicTreeAliases>;
  archiveScope: (
    client: PostgresTopicTreeMigrationQueryClient,
    input: ArchiveSupersededPostgresTopicTreesInput,
  ) => ReturnType<typeof archiveSupersededPostgresTopicTrees>;
}

export type TopicTreeMigrationOperatorErrorCode =
  | "TOPIC_TREE_OPERATOR_INVALID_ARGUMENTS"
  | "TOPIC_TREE_OPERATOR_INVALID_CONFIG"
  | "TOPIC_TREE_OPERATOR_WRITE_GATE_REQUIRED"
  | "TOPIC_TREE_OPERATOR_INVALID_DATABASE_RESULT"
  | "TOPIC_TREE_OPERATOR_CONCURRENT_DRIFT"
  | "TOPIC_TREE_OPERATOR_FAILED";

const MESSAGES: Record<TopicTreeMigrationOperatorErrorCode, string> = {
  TOPIC_TREE_OPERATOR_INVALID_ARGUMENTS: "Topic tree migration operator arguments are invalid",
  TOPIC_TREE_OPERATOR_INVALID_CONFIG: "Topic tree migration operator configuration is invalid",
  TOPIC_TREE_OPERATOR_WRITE_GATE_REQUIRED: "Topic tree migration write operation requires explicit maintenance confirmation",
  TOPIC_TREE_OPERATOR_INVALID_DATABASE_RESULT: "Topic tree migration database result is invalid",
  TOPIC_TREE_OPERATOR_CONCURRENT_DRIFT: "Topic tree migration detected concurrent drift",
  TOPIC_TREE_OPERATOR_FAILED: "Topic tree migration operator failed",
};

export class TopicTreeMigrationOperatorError extends Error {
  constructor(readonly code: TopicTreeMigrationOperatorErrorCode) {
    super(MESSAGES[code]);
    this.name = "TopicTreeMigrationOperatorError";
  }
}

type Operation = "dry-run" | "apply" | "verify" | "rollback" | "archive";
type Disposition = "mapped" | "orphan" | "ambiguous";

interface CliArgs {
  readonly configPath: string;
  readonly migrationId: string;
  readonly operation: Operation;
  readonly batchSize: number;
  readonly maintenance: boolean;
  readonly quiescenceConfirmed: boolean;
  readonly confirmationToken?: string;
  readonly supersededBefore?: number;
}

interface SourceRow {
  readonly scopeFingerprint: string;
  readonly scope: MemoryScope;
  readonly treeKey: string;
  readonly bufferCount: number;
  readonly summaryCount: number;
  readonly entityId?: string;
  readonly canonicalName?: string;
  readonly entityUpdatedAt?: number;
  readonly existingCanonicalTopicLabel?: string;
}

interface PlannedRow extends SourceRow {
  readonly disposition: Disposition;
  readonly canonicalTopicLabel?: string;
  readonly sourceHash: string;
}

interface MigrationSnapshot {
  readonly upperScope?: string;
  readonly upperTreeKey?: string;
  readonly sourceCount: number;
}

interface MigrationCheckpoint extends MigrationSnapshot {
  readonly afterScope?: string;
  readonly afterTreeKey?: string;
  readonly counts: ReturnType<typeof initialCounts>;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SCOPE_HASH = /^[0-9a-f]{64}$/;
const VISIBILITIES = new Set(["private", "workspace", "team", "public"]);
const DEFAULT_BATCH_SIZE = 250;
const MIN_ARCHIVE_GRACE_MS = 30 * 24 * 60 * 60 * 1_000;

function fail(code: TopicTreeMigrationOperatorErrorCode): never {
  throw new TopicTreeMigrationOperatorError(code);
}

function cliArgs(argv: readonly string[]): CliArgs {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index < 0 ? undefined : argv[index + 1];
  };
  const configPath = value("--config");
  const migrationId = value("--migration-id");
  const flags = ["--apply", "--verify", "--rollback", "--archive"].filter((flag) => argv.includes(flag));
  const rawBatchSize = value("--batch-size");
  const batchSize = rawBatchSize === undefined ? DEFAULT_BATCH_SIZE : Number(rawBatchSize);
  const rawCutoff = value("--superseded-before");
  const supersededBefore = rawCutoff === undefined ? undefined : Number(rawCutoff);
  if (!configPath || !migrationId || !SAFE_ID.test(migrationId) || flags.length > 1 ||
      !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1_000 ||
      (supersededBefore !== undefined && (!Number.isSafeInteger(supersededBefore) || supersededBefore < 0))) {
    fail("TOPIC_TREE_OPERATOR_INVALID_ARGUMENTS");
  }
  const operation: Operation = flags[0] === "--apply" ? "apply"
    : flags[0] === "--verify" ? "verify"
    : flags[0] === "--rollback" ? "rollback"
    : flags[0] === "--archive" ? "archive" : "dry-run";
  if ((operation === "archive") !== (supersededBefore !== undefined)) {
    fail("TOPIC_TREE_OPERATOR_INVALID_ARGUMENTS");
  }
  return {
    configPath,
    migrationId,
    operation,
    batchSize,
    maintenance: argv.includes("--maintenance"),
    quiescenceConfirmed: argv.includes("--quiescence-confirmed"),
    confirmationToken: value("--confirmation-token"),
    ...(supersededBefore === undefined ? {} : { supersededBefore }),
  };
}

function assertWriteGate(args: CliArgs): void {
  if (args.operation === "dry-run" || args.operation === "verify") return;
  const token = `${args.operation.toUpperCase()}:${args.migrationId}`;
  if (!args.maintenance || !args.quiescenceConfirmed || args.confirmationToken !== token) {
    fail("TOPIC_TREE_OPERATOR_WRITE_GATE_REQUIRED");
  }
}

function objectRow(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("TOPIC_TREE_OPERATOR_INVALID_DATABASE_RESULT");
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, nullable = false): string | undefined {
  if (nullable && value === null) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 1_000 || /[\p{Cc}]/u.test(value)) {
    fail("TOPIC_TREE_OPERATOR_INVALID_DATABASE_RESULT");
  }
  return value;
}

function optionalScopeValue(value: unknown): string {
  if (value === null || value === "") return "";
  return stringValue(value)!;
}

function count(value: unknown): number {
  const parsed = typeof value === "number" ? value
    : typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail("TOPIC_TREE_OPERATOR_INVALID_DATABASE_RESULT");
  return parsed;
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") fail("TOPIC_TREE_OPERATOR_INVALID_DATABASE_RESULT");
  return value;
}

function resultRows(result: unknown): readonly Record<string, unknown>[] {
  const value = objectRow(result);
  if (!Array.isArray(value.rows) || (value.rowCount !== undefined && value.rowCount !== null &&
      (!Number.isInteger(value.rowCount) || value.rowCount !== value.rows.length))) {
    fail("TOPIC_TREE_OPERATOR_INVALID_DATABASE_RESULT");
  }
  return value.rows.map(objectRow);
}

function decodeSourceRows(result: unknown): readonly SourceRow[] {
  return resultRows(result).map((raw) => {
    const scopeFingerprint = stringValue(raw.scope_fingerprint)!;
    const visibility = stringValue(raw.visibility)!;
    if (!SCOPE_HASH.test(scopeFingerprint) || !VISIBILITIES.has(visibility)) {
      fail("TOPIC_TREE_OPERATOR_INVALID_DATABASE_RESULT");
    }
    const entityId = stringValue(raw.entity_id, true);
    const canonicalName = stringValue(raw.canonical_name, true);
    const entityUpdatedAt = raw.entity_updated_at === null ? undefined : count(raw.entity_updated_at);
    if ((entityId === undefined) !== (canonicalName === undefined) ||
        (entityId === undefined) !== (entityUpdatedAt === undefined)) {
      fail("TOPIC_TREE_OPERATOR_INVALID_DATABASE_RESULT");
    }
    return {
      scopeFingerprint,
      scope: {
        tenantId: stringValue(raw.tenant_id)!, userId: stringValue(raw.user_id)!,
        appId: stringValue(raw.app_id)!, projectId: stringValue(raw.project_id)!,
        agentId: stringValue(raw.agent_id)!, namespace: stringValue(raw.namespace)!,
        visibility: visibility as MemoryScope["visibility"],
        workspaceId: optionalScopeValue(raw.workspace_id),
        sessionId: optionalScopeValue(raw.session_id),
      },
      treeKey: stringValue(raw.tree_key)!,
      bufferCount: count(raw.buffer_count),
      summaryCount: count(raw.summary_count),
      ...(entityId === undefined ? {} : { entityId, canonicalName: canonicalName!, entityUpdatedAt: entityUpdatedAt! }),
      ...(raw.existing_canonical_topic_label === null ? {} : {
        existingCanonicalTopicLabel: stringValue(raw.existing_canonical_topic_label)!,
      }),
    };
  });
}

function plan(row: SourceRow): PlannedRow {
  const canonicalTopicLabel = row.canonicalName === undefined ? undefined : normalizeTopicLabel(row.canonicalName);
  const disposition: Disposition = !row.entityId || !canonicalTopicLabel ? "orphan"
    : row.existingCanonicalTopicLabel !== undefined &&
        row.existingCanonicalTopicLabel !== canonicalTopicLabel ? "ambiguous" : "mapped";
  const sourceHash = createHash("sha256").update(JSON.stringify({
    scopeFingerprint: row.scopeFingerprint,
    treeKey: row.treeKey,
    bufferCount: row.bufferCount,
    summaryCount: row.summaryCount,
    entityId: row.entityId ?? null,
    canonicalName: row.canonicalName ?? null,
    entityUpdatedAt: row.entityUpdatedAt ?? null,
    existingCanonicalTopicLabel: row.existingCanonicalTopicLabel ?? null,
  })).digest("hex");
  return { ...row, disposition, ...(canonicalTopicLabel ? { canonicalTopicLabel } : {}), sourceHash };
}

const ENSURE_OPERATOR_TABLES_SQL = `/* topic-tree-operator:ensure-tables */
CREATE TABLE IF NOT EXISTS mengshu_topic_tree_migration_receipts (
  migration_id TEXT NOT NULL, scope_fingerprint TEXT NOT NULL, legacy_tree_key TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('mapped', 'orphan', 'ambiguous')),
  canonical_topic_label TEXT, source_hash TEXT NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  alias_created BOOLEAN NOT NULL, receipt JSONB NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (migration_id, scope_fingerprint, legacy_tree_key)
);
CREATE TABLE IF NOT EXISTS mengshu_topic_tree_migration_checkpoints (
  migration_id TEXT PRIMARY KEY, after_scope_fingerprint TEXT, after_tree_key TEXT,
  upper_scope_fingerprint TEXT, upper_tree_key TEXT, source_count BIGINT NOT NULL CHECK (source_count >= 0),
  counts JSONB NOT NULL CHECK (jsonb_typeof(counts) = 'object'), updated_at BIGINT NOT NULL CHECK (updated_at >= 0),
  CHECK ((source_count = 0 AND upper_scope_fingerprint IS NULL AND upper_tree_key IS NULL)
    OR (source_count > 0 AND upper_scope_fingerprint IS NOT NULL AND upper_tree_key IS NOT NULL))
);
ALTER TABLE mengshu_topic_tree_migration_checkpoints
  ADD COLUMN IF NOT EXISTS upper_scope_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS upper_tree_key TEXT,
  ADD COLUMN IF NOT EXISTS source_count BIGINT NOT NULL DEFAULT 0`;

const ADVISORY_LOCK_SQL = `/* topic-tree-operator:advisory-lock */
SELECT pg_try_advisory_lock(hashtextextended('mengshu-topic-tree-migration:' || $1, 0)) AS locked`;
const ADVISORY_UNLOCK_SQL = `/* topic-tree-operator:advisory-unlock */
SELECT pg_advisory_unlock(hashtextextended('mengshu-topic-tree-migration:' || $1, 0)) AS unlocked`;

const SNAPSHOT_CAPTURE_SQL = `/* topic-tree-operator:snapshot-capture */
WITH source_keys AS (
  SELECT scope_fingerprint, tree_key FROM mengshu_tree_buffers WHERE tree_type = 'topic'
  UNION
  SELECT scope_fingerprint, tree_key FROM mengshu_tree_summary_nodes WHERE tree_type = 'topic'
)
SELECT (
    SELECT scope_fingerprint FROM source_keys
    ORDER BY scope_fingerprint DESC, tree_key DESC LIMIT 1
  ) AS upper_scope_fingerprint,
  (
    SELECT tree_key FROM source_keys
    ORDER BY scope_fingerprint DESC, tree_key DESC LIMIT 1
  ) AS upper_tree_key,
  (SELECT count(*)::text FROM source_keys) AS source_count`;

const SNAPSHOT_PARITY_SQL = `/* topic-tree-operator:snapshot-parity */
WITH source_keys AS (
  SELECT scope_fingerprint, tree_key FROM mengshu_tree_buffers WHERE tree_type = 'topic'
  UNION
  SELECT scope_fingerprint, tree_key FROM mengshu_tree_summary_nodes WHERE tree_type = 'topic'
)
SELECT count(*)::text AS source_count FROM source_keys
WHERE $1::text IS NOT NULL AND (scope_fingerprint, tree_key) <= ($1::text, $2::text)`;

const CHECKPOINT_READ_SQL = `/* topic-tree-operator:checkpoint-read */
SELECT after_scope_fingerprint, after_tree_key, upper_scope_fingerprint, upper_tree_key,
  source_count::text AS source_count, counts
FROM mengshu_topic_tree_migration_checkpoints WHERE migration_id = $1`;

const SCAN_SQL = `/* topic-tree-operator:scan */
WITH source_keys AS (
  SELECT scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id, namespace,
    visibility, workspace_id, session_id, tree_key,
    count(*) FILTER (WHERE source_kind = 'buffer')::text AS buffer_count,
    count(*) FILTER (WHERE source_kind = 'summary')::text AS summary_count
  FROM (
    SELECT scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id, namespace,
      visibility, workspace_id, session_id, tree_key, 'buffer'::text AS source_kind
    FROM mengshu_tree_buffers WHERE tree_type = 'topic'
      AND ($3::text IS NOT NULL AND (scope_fingerprint, tree_key) <= ($3::text, $4::text))
    UNION ALL
    SELECT scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id, namespace,
      visibility, workspace_id, session_id, tree_key, 'summary'::text AS source_kind
    FROM mengshu_tree_summary_nodes WHERE tree_type = 'topic'
      AND ($3::text IS NOT NULL AND (scope_fingerprint, tree_key) <= ($3::text, $4::text))
  ) source
  GROUP BY scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id, namespace,
    visibility, workspace_id, session_id, tree_key
)
SELECT source.*, entity.id AS entity_id, entity.canonical_name,
  entity.updated_at::text AS entity_updated_at,
  alias.canonical_topic_label AS existing_canonical_topic_label
FROM source_keys source
LEFT JOIN mengshu_graph_entities entity
  ON entity.scope_fingerprint = source.scope_fingerprint
  AND entity.tenant_id = source.tenant_id AND entity.user_id = source.user_id
  AND entity.app_id = source.app_id AND entity.project_id = source.project_id
  AND entity.agent_id = source.agent_id AND entity.namespace = source.namespace
  AND entity.visibility = source.visibility AND entity.workspace_id = source.workspace_id
  AND entity.session_id = source.session_id AND entity.id = source.tree_key
LEFT JOIN mengshu_topic_tree_aliases alias
  ON alias.scope_fingerprint = source.scope_fingerprint
  AND alias.tenant_id = source.tenant_id AND alias.user_id = source.user_id
  AND alias.app_id = source.app_id AND alias.project_id = source.project_id
  AND alias.agent_id = source.agent_id AND alias.namespace = source.namespace
  AND alias.visibility = source.visibility AND alias.workspace_id = source.workspace_id
  AND alias.session_id = source.session_id AND alias.legacy_tree_key = source.tree_key
WHERE ($1::text IS NULL OR (source.scope_fingerprint, source.tree_key) > ($1::text, $2::text))
  AND ($3::text IS NOT NULL AND (source.scope_fingerprint, source.tree_key) <= ($3::text, $4::text))
ORDER BY source.scope_fingerprint, source.tree_key LIMIT $5`;

const RECEIPT_WRITE_SQL = `/* topic-tree-operator:receipt-write */
WITH inserted AS (
  INSERT INTO mengshu_topic_tree_migration_receipts (
    migration_id, scope_fingerprint, legacy_tree_key, disposition, canonical_topic_label,
    source_hash, alias_created, receipt, created_at
  )
  SELECT $1, item.scope_fingerprint, item.legacy_tree_key, item.disposition,
    item.canonical_topic_label, item.source_hash, item.alias_created, item.receipt, $3
  FROM jsonb_to_recordset($2::jsonb) AS item(
    scope_fingerprint text, legacy_tree_key text, disposition text, canonical_topic_label text,
    source_hash text, alias_created boolean, receipt jsonb
  )
  ON CONFLICT (migration_id, scope_fingerprint, legacy_tree_key) DO NOTHING
  RETURNING 1
)
SELECT count(*)::text AS written FROM inserted`;

const CHECKPOINT_WRITE_SQL = `/* topic-tree-operator:checkpoint-write */
INSERT INTO mengshu_topic_tree_migration_checkpoints (
  migration_id, after_scope_fingerprint, after_tree_key, upper_scope_fingerprint, upper_tree_key,
  source_count, counts, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
ON CONFLICT (migration_id) DO UPDATE SET
  after_scope_fingerprint = EXCLUDED.after_scope_fingerprint,
  after_tree_key = EXCLUDED.after_tree_key, counts = EXCLUDED.counts,
  updated_at = GREATEST(mengshu_topic_tree_migration_checkpoints.updated_at, EXCLUDED.updated_at)`;

const VERIFY_SQL = `/* topic-tree-operator:verify */
WITH receipts AS (
  SELECT * FROM mengshu_topic_tree_migration_receipts WHERE migration_id = $1
), current_source AS (
  SELECT source.scope_fingerprint, source.tree_key,
    count(*) FILTER (WHERE source.source_kind = 'buffer') AS buffer_count,
    count(*) FILTER (WHERE source.source_kind = 'summary') AS summary_count,
    entity.id AS entity_id, entity.updated_at AS entity_updated_at
  FROM (
    SELECT scope_fingerprint, tree_key, 'buffer'::text AS source_kind
    FROM mengshu_tree_buffers WHERE tree_type = 'topic'
      AND ($2::text IS NOT NULL AND (scope_fingerprint, tree_key) <= ($2::text, $3::text))
    UNION ALL
    SELECT scope_fingerprint, tree_key, 'summary'::text AS source_kind
    FROM mengshu_tree_summary_nodes WHERE tree_type = 'topic'
      AND ($2::text IS NOT NULL AND (scope_fingerprint, tree_key) <= ($2::text, $3::text))
  ) source
  LEFT JOIN mengshu_graph_entities entity
    ON entity.scope_fingerprint = source.scope_fingerprint AND entity.id = source.tree_key
  GROUP BY source.scope_fingerprint, source.tree_key, entity.id, entity.updated_at
)
SELECT count(*)::text AS receipt_count,
  (SELECT count(*) FROM current_source)::text AS current_source_count,
  (SELECT count(*) FROM current_source source WHERE NOT EXISTS (
    SELECT 1 FROM receipts receipt WHERE receipt.scope_fingerprint = source.scope_fingerprint
      AND receipt.legacy_tree_key = source.tree_key))::text AS unreceipted_count,
  count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM current_source source
    WHERE source.scope_fingerprint = receipts.scope_fingerprint
      AND source.tree_key = receipts.legacy_tree_key))::text AS missing_source_count,
  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM current_source source
    WHERE source.scope_fingerprint = receipts.scope_fingerprint
      AND source.tree_key = receipts.legacy_tree_key
      AND (source.buffer_count::text <> receipts.receipt->>'bufferCount'
        OR source.summary_count::text <> receipts.receipt->>'summaryCount'
        OR source.entity_id IS DISTINCT FROM receipts.receipt->>'entityId'
        OR source.entity_updated_at::text IS DISTINCT FROM receipts.receipt->>'entityUpdatedAt')))::text
    AS source_drift_count,
  count(*) FILTER (WHERE receipts.disposition = 'mapped' AND NOT EXISTS (
    SELECT 1 FROM mengshu_topic_tree_aliases alias
    WHERE alias.scope_fingerprint = receipts.scope_fingerprint
      AND alias.legacy_tree_key = receipts.legacy_tree_key
      AND alias.canonical_topic_label = receipts.canonical_topic_label))::text AS alias_mismatch_count,
  count(*) FILTER (WHERE receipts.disposition IN ('orphan', 'ambiguous'))::text AS review_count
FROM receipts`;

const ROLLBACK_PREFLIGHT_SQL = `/* topic-tree-operator:rollback-preflight */
SELECT count(*) FILTER (WHERE disposition = 'mapped' AND alias_created)::text AS expected,
  count(*) FILTER (WHERE disposition = 'mapped' AND alias_created AND EXISTS (
    SELECT 1 FROM mengshu_topic_tree_aliases alias
    WHERE alias.scope_fingerprint = receipt.scope_fingerprint
      AND alias.legacy_tree_key = receipt.legacy_tree_key
      AND alias.canonical_topic_label = receipt.canonical_topic_label
      AND alias.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(alias.merged_from) merged(legacy_tree_key)
        WHERE NOT EXISTS (
          SELECT 1 FROM mengshu_topic_tree_migration_receipts peer
          WHERE peer.migration_id = receipt.migration_id
            AND peer.scope_fingerprint = receipt.scope_fingerprint
            AND peer.legacy_tree_key = merged.legacy_tree_key
            AND peer.disposition = 'mapped'
        )
      )))::text AS restorable,
  count(*) FILTER (WHERE disposition = 'mapped' AND alias_created AND NOT EXISTS (
    SELECT 1 FROM mengshu_topic_tree_aliases alias
    WHERE alias.scope_fingerprint = receipt.scope_fingerprint
      AND alias.legacy_tree_key = receipt.legacy_tree_key))::text AS already_restored
FROM mengshu_topic_tree_migration_receipts receipt WHERE migration_id = $1`;

const ROLLBACK_DELETE_SQL = `/* topic-tree-operator:rollback-delete */
WITH deleted AS (
  DELETE FROM mengshu_topic_tree_aliases alias USING mengshu_topic_tree_migration_receipts receipt
  WHERE receipt.migration_id = $1 AND receipt.disposition = 'mapped' AND receipt.alias_created
    AND alias.scope_fingerprint = receipt.scope_fingerprint
    AND alias.legacy_tree_key = receipt.legacy_tree_key
    AND alias.canonical_topic_label = receipt.canonical_topic_label AND alias.status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(alias.merged_from) merged(legacy_tree_key)
      WHERE NOT EXISTS (
        SELECT 1 FROM mengshu_topic_tree_migration_receipts peer
        WHERE peer.migration_id = receipt.migration_id
          AND peer.scope_fingerprint = receipt.scope_fingerprint
          AND peer.legacy_tree_key = merged.legacy_tree_key
          AND peer.disposition = 'mapped'
      )
    )
  RETURNING alias.legacy_tree_key
)
SELECT count(*)::text AS deleted FROM deleted`;

const ROLLBACK_REPAIR_MERGED_FROM_SQL = `/* topic-tree-operator:rollback-repair-merged-from */
WITH affected AS (
  SELECT DISTINCT scope_fingerprint, canonical_topic_label
  FROM mengshu_topic_tree_migration_receipts
  WHERE migration_id = $1 AND disposition = 'mapped' AND alias_created
), repaired AS (
  SELECT alias.scope_fingerprint, alias.canonical_topic_label,
    jsonb_agg(alias.legacy_tree_key ORDER BY alias.legacy_tree_key) AS merged_from
  FROM mengshu_topic_tree_aliases alias
  JOIN affected USING (scope_fingerprint, canonical_topic_label)
  GROUP BY alias.scope_fingerprint, alias.canonical_topic_label
)
UPDATE mengshu_topic_tree_aliases alias SET merged_from = repaired.merged_from
FROM repaired
WHERE alias.scope_fingerprint = repaired.scope_fingerprint
  AND alias.canonical_topic_label = repaired.canonical_topic_label`;

const ROLLBACK_CLEANUP_SQL = `/* topic-tree-operator:rollback-cleanup */
DELETE FROM mengshu_topic_tree_migration_receipts WHERE migration_id = $1;
DELETE FROM mengshu_topic_tree_migration_checkpoints WHERE migration_id = $1`;

const ARCHIVE_SCOPES_SQL = `/* topic-tree-operator:archive-scopes */
SELECT DISTINCT scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id,
  namespace, visibility, workspace_id, session_id
FROM mengshu_topic_tree_aliases
WHERE status = 'superseded' AND superseded_at <= $1
ORDER BY scope_fingerprint`;

const DEFAULT_DEPENDENCIES: TopicTreeMigrationOperatorDependencies = {
  readText: (path) => readFileSync(path, "utf8"),
  now: () => Date.now(),
  connect: async (config) => {
    const pool = new pg.Pool({ ...config, max: 1 });
    const connection = await pool.connect();
    return {
      client: connection as unknown as PostgresTopicTreeMigrationQueryClient,
      close: async () => {
        connection.release();
        await pool.end();
      },
    };
  },
  persistAliases: persistPostgresTopicTreeAliases,
  archiveScope: archiveSupersededPostgresTopicTrees,
};

function initialCounts(): Record<Disposition | "scanned" | "batches", number> {
  return { scanned: 0, mapped: 0, orphan: 0, ambiguous: 0, batches: 0 };
}

async function readCheckpoint(
  client: PostgresTopicTreeMigrationQueryClient,
  migrationId: string,
): Promise<MigrationCheckpoint | undefined> {
  const rows = resultRows(await client.query(CHECKPOINT_READ_SQL, [migrationId]));
  if (rows.length === 0) return undefined;
  if (rows.length !== 1) fail("TOPIC_TREE_OPERATOR_INVALID_DATABASE_RESULT");
  const raw = rows[0]!;
  const afterScope = raw.after_scope_fingerprint === null ? undefined : stringValue(raw.after_scope_fingerprint)!;
  const afterTreeKey = raw.after_tree_key === null ? undefined : stringValue(raw.after_tree_key)!;
  const upperScope = raw.upper_scope_fingerprint === null ? undefined : stringValue(raw.upper_scope_fingerprint)!;
  const upperTreeKey = raw.upper_tree_key === null ? undefined : stringValue(raw.upper_tree_key)!;
  const sourceCount = count(raw.source_count);
  const countsRaw = objectRow(raw.counts);
  const counts = initialCounts();
  for (const key of Object.keys(counts) as Array<keyof typeof counts>) counts[key] = count(countsRaw[key]);
  if ((afterScope === undefined) !== (afterTreeKey === undefined) ||
      (upperScope === undefined) !== (upperTreeKey === undefined) ||
      (sourceCount === 0) !== (upperScope === undefined) || counts.scanned > sourceCount) {
    fail("TOPIC_TREE_OPERATOR_INVALID_DATABASE_RESULT");
  }
  return {
    ...(afterScope ? { afterScope, afterTreeKey } : {}),
    ...(upperScope ? { upperScope, upperTreeKey } : {}),
    sourceCount,
    counts,
  };
}

async function captureSnapshot(
  client: PostgresTopicTreeMigrationQueryClient,
): Promise<MigrationSnapshot> {
  const rows = resultRows(await client.query(SNAPSHOT_CAPTURE_SQL));
  if (rows.length !== 1) fail("TOPIC_TREE_OPERATOR_INVALID_DATABASE_RESULT");
  const sourceCount = count(rows[0]!.source_count);
  const upperScope = rows[0]!.upper_scope_fingerprint === null
    ? undefined : stringValue(rows[0]!.upper_scope_fingerprint)!;
  const upperTreeKey = rows[0]!.upper_tree_key === null
    ? undefined : stringValue(rows[0]!.upper_tree_key)!;
  if ((upperScope === undefined) !== (upperTreeKey === undefined) ||
      (sourceCount === 0) !== (upperScope === undefined)) {
    fail("TOPIC_TREE_OPERATOR_INVALID_DATABASE_RESULT");
  }
  return { ...(upperScope ? { upperScope, upperTreeKey } : {}), sourceCount };
}

async function assertSnapshotParity(
  client: PostgresTopicTreeMigrationQueryClient,
  snapshot: MigrationSnapshot,
): Promise<void> {
  if (snapshot.sourceCount === 0) return;
  const rows = resultRows(await client.query(SNAPSHOT_PARITY_SQL, [
    snapshot.upperScope, snapshot.upperTreeKey,
  ]));
  if (rows.length !== 1 || count(rows[0]!.source_count) !== snapshot.sourceCount) {
    fail("TOPIC_TREE_OPERATOR_CONCURRENT_DRIFT");
  }
}

async function writeCheckpoint(
  client: PostgresTopicTreeMigrationQueryClient,
  migrationId: string,
  checkpoint: MigrationCheckpoint,
  now: number,
): Promise<void> {
  await client.query(CHECKPOINT_WRITE_SQL, [
    migrationId, checkpoint.afterScope ?? null, checkpoint.afterTreeKey ?? null,
    checkpoint.upperScope ?? null, checkpoint.upperTreeKey ?? null, checkpoint.sourceCount,
    JSON.stringify(checkpoint.counts), now,
  ]);
}

async function runScan(
  client: PostgresTopicTreeMigrationQueryClient,
  args: CliArgs,
  dependencies: TopicTreeMigrationOperatorDependencies,
): Promise<Record<string, unknown>> {
  let checkpoint = args.operation === "apply"
    ? await readCheckpoint(client, args.migrationId)
    : undefined;
  if (!checkpoint) {
    const snapshot = await captureSnapshot(client);
    checkpoint = { ...snapshot, counts: initialCounts() };
    if (args.operation === "apply") {
      await client.query("BEGIN");
      try {
        await writeCheckpoint(client, args.migrationId, checkpoint, dependencies.now());
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }
  } else {
    await assertSnapshotParity(client, checkpoint);
  }
  const totals = { ...checkpoint.counts };
  let afterScope = checkpoint.afterScope;
  let afterTreeKey = checkpoint.afterTreeKey;
  while (true) {
    const rows = checkpoint.sourceCount === 0 ? [] : decodeSourceRows(await client.query(SCAN_SQL, [
      afterScope ?? null, afterTreeKey ?? null,
      checkpoint.upperScope, checkpoint.upperTreeKey, args.batchSize,
    ]));
    if (rows.length === 0) break;
    const planned = rows.map(plan);
    for (const item of planned) {
      totals.scanned += 1;
      totals[item.disposition] += 1;
    }
    totals.batches += 1;
    if (args.operation === "apply") {
      await client.query("BEGIN");
      try {
        for (const item of planned.filter((candidate) => candidate.disposition === "mapped")) {
          await dependencies.persistAliases(client, {
            scope: item.scope,
            entities: [{ entityId: item.entityId!, canonicalName: item.canonicalName! }],
            now: dependencies.now(),
          });
        }
        const receiptPayload = planned.map((item) => ({
          scope_fingerprint: item.scopeFingerprint,
          legacy_tree_key: item.treeKey,
          disposition: item.disposition,
          canonical_topic_label: item.canonicalTopicLabel ?? null,
          source_hash: item.sourceHash,
          alias_created: item.disposition === "mapped" && item.existingCanonicalTopicLabel === undefined,
          receipt: {
            scope: item.scope,
            bufferCount: item.bufferCount,
            summaryCount: item.summaryCount,
            entityId: item.entityId ?? null,
            entityUpdatedAt: item.entityUpdatedAt ?? null,
          },
        }));
        const receiptRows = resultRows(await client.query(RECEIPT_WRITE_SQL, [
          args.migrationId, JSON.stringify(receiptPayload), dependencies.now(),
        ]));
        if (receiptRows.length !== 1 || count(receiptRows[0]!.written) !== planned.length) {
          fail("TOPIC_TREE_OPERATOR_CONCURRENT_DRIFT");
        }
        const last = planned.at(-1)!;
        await writeCheckpoint(client, args.migrationId, {
          ...checkpoint, afterScope: last.scopeFingerprint, afterTreeKey: last.treeKey, counts: totals,
        }, dependencies.now());
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }
    const last = planned.at(-1)!;
    afterScope = last.scopeFingerprint;
    afterTreeKey = last.treeKey;
  }
  return { operation: args.operation, ...totals };
}

async function verify(
  client: PostgresTopicTreeMigrationQueryClient,
  migrationId: string,
): Promise<Record<string, unknown>> {
  const checkpoint = await readCheckpoint(client, migrationId);
  if (!checkpoint) fail("TOPIC_TREE_OPERATOR_CONCURRENT_DRIFT");
  await assertSnapshotParity(client, checkpoint);
  const rows = resultRows(await client.query(VERIFY_SQL, [
    migrationId, checkpoint.upperScope ?? null, checkpoint.upperTreeKey ?? null,
  ]));
  if (rows.length !== 1) fail("TOPIC_TREE_OPERATOR_INVALID_DATABASE_RESULT");
  const row = rows[0]!;
  const receiptCount = count(row.receipt_count);
  const currentSourceCount = count(row.current_source_count);
  const unreceipted = count(row.unreceipted_count);
  const missingSource = count(row.missing_source_count);
  const sourceDrift = count(row.source_drift_count);
  const aliasMismatch = count(row.alias_mismatch_count);
  const review = count(row.review_count);
  return {
    operation: "verify",
    valid: receiptCount === currentSourceCount && unreceipted === 0 && missingSource === 0 &&
      sourceDrift === 0 && aliasMismatch === 0 && review === 0 &&
      receiptCount === checkpoint.sourceCount,
    receiptCount, currentSourceCount, unreceipted, missingSource, sourceDrift, aliasMismatch, review,
  };
}

async function rollback(
  client: PostgresTopicTreeMigrationQueryClient,
  migrationId: string,
): Promise<Record<string, unknown>> {
  const checkpoint = await readCheckpoint(client, migrationId);
  if (!checkpoint) fail("TOPIC_TREE_OPERATOR_CONCURRENT_DRIFT");
  await assertSnapshotParity(client, checkpoint);
  await client.query("BEGIN");
  try {
    const rows = resultRows(await client.query(ROLLBACK_PREFLIGHT_SQL, [migrationId]));
    if (rows.length !== 1) fail("TOPIC_TREE_OPERATOR_INVALID_DATABASE_RESULT");
    const expected = count(rows[0]!.expected);
    const restorable = count(rows[0]!.restorable);
    const alreadyRestored = count(rows[0]!.already_restored);
    if (restorable + alreadyRestored !== expected) fail("TOPIC_TREE_OPERATOR_CONCURRENT_DRIFT");
    const deletedRows = resultRows(await client.query(ROLLBACK_DELETE_SQL, [migrationId]));
    if (deletedRows.length !== 1) fail("TOPIC_TREE_OPERATOR_INVALID_DATABASE_RESULT");
    const deleted = count(deletedRows[0]!.deleted);
    if (deleted !== restorable) fail("TOPIC_TREE_OPERATOR_CONCURRENT_DRIFT");
    await client.query(ROLLBACK_REPAIR_MERGED_FROM_SQL, [migrationId]);
    await client.query(ROLLBACK_CLEANUP_SQL, [migrationId]);
    await client.query("COMMIT");
    return { operation: "rollback", restored: deleted + alreadyRestored };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

function decodeScopeRow(raw: Record<string, unknown>): MemoryScope {
  const visibility = stringValue(raw.visibility)!;
  if (!VISIBILITIES.has(visibility)) fail("TOPIC_TREE_OPERATOR_INVALID_DATABASE_RESULT");
  return {
    tenantId: stringValue(raw.tenant_id)!, userId: stringValue(raw.user_id)!,
    appId: stringValue(raw.app_id)!, projectId: stringValue(raw.project_id)!,
    agentId: stringValue(raw.agent_id)!, namespace: stringValue(raw.namespace)!,
    visibility: visibility as MemoryScope["visibility"],
    workspaceId: optionalScopeValue(raw.workspace_id),
    sessionId: optionalScopeValue(raw.session_id),
  };
}

async function archive(
  client: PostgresTopicTreeMigrationQueryClient,
  args: CliArgs,
  dependencies: TopicTreeMigrationOperatorDependencies,
): Promise<Record<string, unknown>> {
  const now = dependencies.now();
  if (args.supersededBefore === undefined || now < args.supersededBefore ||
      now - args.supersededBefore < MIN_ARCHIVE_GRACE_MS) {
    fail("TOPIC_TREE_OPERATOR_INVALID_ARGUMENTS");
  }
  await client.query("BEGIN");
  try {
    const rows = resultRows(await client.query(ARCHIVE_SCOPES_SQL, [args.supersededBefore]));
    let archived = 0;
    for (const row of rows) {
      const aliases = await dependencies.archiveScope(client, {
        scope: decodeScopeRow(row),
        supersededBefore: args.supersededBefore,
        now,
      });
      archived += aliases.length;
    }
    await client.query("COMMIT");
    return { operation: "archive", scopes: rows.length, archived };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

export async function runTopicTreeMigrationOperator(
  argv: readonly string[],
  dependencies: TopicTreeMigrationOperatorDependencies = DEFAULT_DEPENDENCIES,
): Promise<Record<string, unknown>> {
  const args = cliArgs(argv);
  assertWriteGate(args);
  let config: OperatorPostgresConfig;
  try {
    config = parseOperatorPostgresConfig(dependencies.readText(args.configPath));
  } catch {
    fail("TOPIC_TREE_OPERATOR_INVALID_CONFIG");
  }
  const connection = await dependencies.connect(config).catch(() => fail("TOPIC_TREE_OPERATOR_FAILED"));
  let advisoryLocked = false;
  try {
    if (args.operation === "dry-run") {
      await connection.client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      try {
        const result = await runScan(connection.client, args, dependencies);
        await connection.client.query("ROLLBACK");
        return result;
      } catch (error) {
        await connection.client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }
    if (args.operation === "verify") {
      const lockRows = resultRows(await connection.client.query(ADVISORY_LOCK_SQL, [args.migrationId]));
      if (lockRows.length !== 1 || !booleanValue(lockRows[0]!.locked)) {
        fail("TOPIC_TREE_OPERATOR_CONCURRENT_DRIFT");
      }
      advisoryLocked = true;
      await connection.client.query("BEGIN READ ONLY");
      try {
        const result = await verify(connection.client, args.migrationId);
        await connection.client.query("ROLLBACK");
        return result;
      } catch (error) {
        await connection.client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }
    if (args.operation === "archive") return await archive(connection.client, args, dependencies);
    const lockRows = resultRows(await connection.client.query(ADVISORY_LOCK_SQL, [args.migrationId]));
    if (lockRows.length !== 1 || !booleanValue(lockRows[0]!.locked)) {
      fail("TOPIC_TREE_OPERATOR_CONCURRENT_DRIFT");
    }
    advisoryLocked = true;
    await connection.client.query(ENSURE_OPERATOR_TABLES_SQL);
    if (args.operation === "rollback") return await rollback(connection.client, args.migrationId);
    return await runScan(connection.client, args, dependencies);
  } catch (error) {
    if (error instanceof TopicTreeMigrationOperatorError) throw error;
    fail("TOPIC_TREE_OPERATOR_FAILED");
  } finally {
    if (advisoryLocked) {
      await connection.client.query(ADVISORY_UNLOCK_SQL, [args.migrationId]).catch(() => undefined);
    }
    await connection.close().catch(() => undefined);
  }
  return fail("TOPIC_TREE_OPERATOR_FAILED");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTopicTreeMigrationOperator(process.argv.slice(2))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      const output = error instanceof TopicTreeMigrationOperatorError
        ? { code: error.code, message: error.message }
        : { code: "TOPIC_TREE_OPERATOR_FAILED", message: MESSAGES.TOPIC_TREE_OPERATOR_FAILED };
      process.stderr.write(`${JSON.stringify(output)}\n`);
      process.exitCode = 1;
    });
}
