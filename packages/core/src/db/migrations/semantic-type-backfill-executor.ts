import { createHash } from "node:crypto";

import type { MemoryKind, MemoryLifecycleStatus } from "../../domain/types.js";
import {
  planLegacySemanticTypeBackfill,
  type LegacySemanticTypeBackfillPlan,
} from "./semantic-type-backfill.js";

export interface PostgresSemanticTypeBackfillQueryResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly rows: readonly Row[];
  readonly rowCount?: number | null;
}

export interface PostgresSemanticTypeBackfillClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresSemanticTypeBackfillQueryResult<Row>>;
}

export interface ExecutePostgresSemanticTypeBackfillOptions {
  readonly migrationId: string;
  readonly manifestHash: string;
  readonly mode?: "dry-run" | "apply";
  readonly maintenance?: boolean;
  readonly quiescenceConfirmed?: boolean;
  readonly batchSize?: number;
  readonly now?: number;
}

export interface ExecutePostgresSemanticTypeBackfillResult {
  readonly mode: "dry-run" | "apply";
  readonly scanned: number;
  readonly preservedExplicit: number;
  readonly backfilled: number;
  readonly lookupOnly: number;
  readonly invalidExplicit: number;
  readonly batches: number;
  readonly sourceUpperBound: string | null;
  readonly sourceCount: number;
  readonly attemptHash: string;
}

export interface VerifyPostgresSemanticTypeBackfillOptions {
  readonly migrationId: string;
  readonly manifestHash: string;
}

export interface VerifyPostgresSemanticTypeBackfillResult
  extends Omit<ExecutePostgresSemanticTypeBackfillResult, "mode"> {
  readonly migrationId: string;
  readonly manifestHash: string;
  readonly shadowCount: number;
  readonly receiptCount: number;
  readonly valid: true;
}

export interface RollbackPostgresSemanticTypeBackfillOptions
  extends VerifyPostgresSemanticTypeBackfillOptions {
  readonly maintenance?: boolean;
  readonly quiescenceConfirmed?: boolean;
}

export type SemanticTypeBackfillExecutorErrorCode =
  | "SEMANTIC_TYPE_BACKFILL_INVALID_OPTIONS"
  | "SEMANTIC_TYPE_BACKFILL_MAINTENANCE_REQUIRED"
  | "SEMANTIC_TYPE_BACKFILL_INVALID_DB_RESULT"
  | "SEMANTIC_TYPE_BACKFILL_MANIFEST_MISMATCH"
  | "SEMANTIC_TYPE_BACKFILL_LOCK_UNAVAILABLE"
  | "SEMANTIC_TYPE_BACKFILL_CONCURRENT_DRIFT"
  | "SEMANTIC_TYPE_BACKFILL_VERIFY_FAILED"
  | "SEMANTIC_TYPE_BACKFILL_DATABASE_FAILED"
  | "SEMANTIC_TYPE_BACKFILL_ROLLBACK_FAILED";

export class SemanticTypeBackfillExecutorError extends Error {
  constructor(readonly code: SemanticTypeBackfillExecutorErrorCode) {
    super(code);
    this.name = "SemanticTypeBackfillExecutorError";
  }
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEMORY_KINDS = new Set<MemoryKind>([
  "preference", "decision", "entity", "fact", "task", "plan", "goal",
  "document", "knowledge", "observation", "other",
]);
const LIFECYCLE = new Set<MemoryLifecycleStatus>([
  "active", "archived", "revoked", "superseded", "promoted",
]);
const LEGACY_CATEGORIES = new Set([
  "core", "preference", "decision", "entity", "fact", "task", "plan", "goal", "other",
]);
const LEGACY_DATA_TYPES = new Set(["memory", "document", "knowledge"]);

const LOCK_SQL = `/* semantic-type-backfill:lock */
SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired`;
const UNLOCK_SQL = `/* semantic-type-backfill:unlock */
SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released`;
const SOURCE_SNAPSHOT_SQL = `/* semantic-type-backfill:source-snapshot */
SELECT MAX(id)::text AS source_upper_bound, COUNT(*)::text AS source_count
FROM memories
WHERE legacy_quarantine_reason IS NULL`;

const SCAN_SQL = `/* semantic-type-backfill:scan */
SELECT id,
       metadata,
       metadata #>> '{governance,native,kind}' AS canonical_memory_kind,
       metadata->>'kind' AS metadata_kind,
       metadata->>'memoryKind' AS legacy_memory_kind,
       data_type,
       category,
       lifecycle_status
FROM memories
WHERE ($1::uuid IS NULL OR id > $1::uuid)
  AND ($4::uuid IS NOT NULL AND id <= $4::uuid)
  AND legacy_quarantine_reason IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM mengshu_semantic_type_backfill_receipts receipt
    WHERE receipt.migration_id = $2 AND receipt.record_id = memories.id
  )
ORDER BY id ASC
LIMIT $3`;
const SHADOW_SQL = `/* semantic-type-backfill:shadow */
INSERT INTO mengshu_semantic_type_backfill_shadow (
  migration_id, record_id, original_metadata, original_value_hash, captured_at
) VALUES ($1, $2::uuid, $3::jsonb, $4, $5)
ON CONFLICT (migration_id, record_id) DO NOTHING`;
const CAS_UPDATE_SQL = `/* semantic-type-backfill:cas-update */
UPDATE memories SET metadata = CASE
  WHEN jsonb_typeof(metadata->'governance') = 'object'
   AND jsonb_typeof(metadata #> '{governance,native}') = 'object'
    THEN jsonb_set(
      metadata || jsonb_build_object('semanticType', $2),
      '{governance,native,semanticType}',
      to_jsonb($2::text),
      true
    )
  ELSE metadata || jsonb_build_object('semanticType', $2)
END
WHERE id = $1::uuid
  AND metadata = $3::jsonb
RETURNING id`;
const CAS_ISOLATE_SQL = `/* semantic-type-backfill:cas-isolate */
UPDATE memories SET metadata = CASE
  WHEN jsonb_typeof(metadata->'governance') = 'object'
    THEN jsonb_set(
      metadata || jsonb_build_object(
        'admissionRoute', 'lookup_only',
        'contextEligible', false,
        'memoryContainer', 'session_candidate'
      ),
      '{governance,semanticTypeBackfill}',
      jsonb_build_object('migrationId', $2::text, 'disposition', $3::text),
      true
    )
  ELSE metadata || jsonb_build_object(
    'admissionRoute', 'lookup_only',
    'contextEligible', false,
    'memoryContainer', 'session_candidate',
    'semanticTypeBackfill', jsonb_build_object(
      'migrationId', $2::text,
      'disposition', $3::text
    )
  )
END
WHERE id = $1::uuid
  AND metadata = $4::jsonb
RETURNING id`;
const RECEIPT_SQL = `/* semantic-type-backfill:receipt */
INSERT INTO mengshu_semantic_type_backfill_receipts (
  receipt_id, migration_id, record_id, disposition, semantic_type,
  original_value_hash, resulting_value_hash, created_at
) VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8)
ON CONFLICT (migration_id, record_id) DO NOTHING`;
const CHECKPOINT_SQL = `/* semantic-type-backfill:checkpoint */
INSERT INTO mengshu_semantic_type_backfill_checkpoints (
  migration_id, manifest_hash, after_id, counts, updated_at
) VALUES ($1, $2, $3::uuid, $4::jsonb, $5)
ON CONFLICT (migration_id) DO UPDATE SET
  manifest_hash = EXCLUDED.manifest_hash,
  after_id = EXCLUDED.after_id,
  counts = EXCLUDED.counts,
  updated_at = GREATEST(mengshu_semantic_type_backfill_checkpoints.updated_at, EXCLUDED.updated_at)`;
const CHECKPOINT_READ_SQL = `/* semantic-type-backfill:checkpoint-read */
SELECT manifest_hash, after_id, counts
FROM mengshu_semantic_type_backfill_checkpoints
WHERE migration_id = $1`;
const VERIFY_SQL = `/* semantic-type-backfill:verify */
SELECT checkpoint.manifest_hash,
       checkpoint.after_id,
       checkpoint.counts,
       COUNT(DISTINCT shadow.record_id)::text AS shadow_count,
       COUNT(DISTINCT receipt.record_id)::text AS receipt_count,
       COUNT(DISTINCT receipt.record_id) FILTER (
         WHERE receipt.disposition = 'preserve_explicit'
       )::text AS preserved_explicit_count,
       COUNT(DISTINCT receipt.record_id) FILTER (
         WHERE receipt.disposition = 'backfill'
       )::text AS backfill_count,
       COUNT(DISTINCT receipt.record_id) FILTER (
         WHERE receipt.disposition = 'lookup_only'
       )::text AS lookup_only_count,
       COUNT(DISTINCT receipt.record_id) FILTER (
         WHERE receipt.disposition = 'invalid_explicit'
       )::text AS invalid_explicit_count,
       (
         SELECT COUNT(*)::text
         FROM memories candidate
         WHERE candidate.legacy_quarantine_reason IS NULL
           AND NULLIF(checkpoint.counts->>'sourceUpperBound', '') IS NOT NULL
           AND candidate.id <= NULLIF(checkpoint.counts->>'sourceUpperBound', '')::uuid
           AND NOT EXISTS (
             SELECT 1
             FROM mengshu_semantic_type_backfill_receipts pending_receipt
             WHERE pending_receipt.migration_id = checkpoint.migration_id
               AND pending_receipt.record_id = candidate.id
           )
       ) AS remaining_count,
       (
         SELECT COUNT(*)::text
         FROM memories snapshot_source
         WHERE snapshot_source.legacy_quarantine_reason IS NULL
           AND NULLIF(checkpoint.counts->>'sourceUpperBound', '') IS NOT NULL
           AND snapshot_source.id <= NULLIF(checkpoint.counts->>'sourceUpperBound', '')::uuid
       ) AS snapshot_source_count,
       (
         SELECT COUNT(*)::text
         FROM mengshu_semantic_type_backfill_shadow live_shadow
         JOIN mengshu_semantic_type_backfill_receipts live_receipt
           ON live_receipt.migration_id = live_shadow.migration_id
          AND live_receipt.record_id = live_shadow.record_id
         LEFT JOIN memories live_memory ON live_memory.id = live_shadow.record_id
         WHERE live_shadow.migration_id = checkpoint.migration_id
           AND live_memory.metadata IS DISTINCT FROM CASE
             WHEN live_receipt.disposition IN ('lookup_only', 'invalid_explicit')
               THEN CASE
                 WHEN jsonb_typeof(live_shadow.original_metadata->'governance') = 'object'
                   THEN jsonb_set(
                     live_shadow.original_metadata || jsonb_build_object(
                       'admissionRoute', 'lookup_only',
                       'contextEligible', false,
                       'memoryContainer', 'session_candidate'
                     ),
                     '{governance,semanticTypeBackfill}',
                     jsonb_build_object(
                       'migrationId', live_receipt.migration_id,
                       'disposition', live_receipt.disposition
                     ),
                     true
                   )
                 ELSE live_shadow.original_metadata || jsonb_build_object(
                   'admissionRoute', 'lookup_only',
                   'contextEligible', false,
                   'memoryContainer', 'session_candidate',
                   'semanticTypeBackfill', jsonb_build_object(
                     'migrationId', live_receipt.migration_id,
                     'disposition', live_receipt.disposition
                   )
                 )
               END
             WHEN live_receipt.resulting_value_hash IS NOT NULL
              AND jsonb_typeof(live_shadow.original_metadata->'governance') = 'object'
              AND jsonb_typeof(live_shadow.original_metadata #> '{governance,native}') = 'object'
               THEN jsonb_set(
                 live_shadow.original_metadata ||
                   jsonb_build_object('semanticType', live_receipt.semantic_type),
                 '{governance,native,semanticType}',
                 to_jsonb(live_receipt.semantic_type),
                 true
               )
             WHEN live_receipt.resulting_value_hash IS NOT NULL
               THEN live_shadow.original_metadata ||
                 jsonb_build_object('semanticType', live_receipt.semantic_type)
             ELSE live_shadow.original_metadata
           END
       ) AS live_mismatch_count
FROM mengshu_semantic_type_backfill_checkpoints checkpoint
LEFT JOIN mengshu_semantic_type_backfill_shadow shadow
  ON shadow.migration_id = checkpoint.migration_id
LEFT JOIN mengshu_semantic_type_backfill_receipts receipt
  ON receipt.migration_id = checkpoint.migration_id
WHERE checkpoint.migration_id = $1
GROUP BY checkpoint.manifest_hash, checkpoint.after_id, checkpoint.counts`;
const ROLLBACK_EXPECTED_SQL = `/* semantic-type-backfill:rollback-expected */
SELECT COUNT(*)::text AS expected_count,
       COUNT(*) FILTER (
         WHERE memory.metadata = CASE
           WHEN receipt.disposition IN ('lookup_only', 'invalid_explicit')
             THEN CASE
               WHEN jsonb_typeof(shadow.original_metadata->'governance') = 'object'
                 THEN jsonb_set(
                   shadow.original_metadata || jsonb_build_object(
                     'admissionRoute', 'lookup_only', 'contextEligible', false,
                     'memoryContainer', 'session_candidate'
                   ),
                   '{governance,semanticTypeBackfill}',
                   jsonb_build_object(
                     'migrationId', receipt.migration_id,
                     'disposition', receipt.disposition
                   ),
                   true
                 )
               ELSE shadow.original_metadata || jsonb_build_object(
                 'admissionRoute', 'lookup_only', 'contextEligible', false,
                 'memoryContainer', 'session_candidate',
                 'semanticTypeBackfill', jsonb_build_object(
                   'migrationId', receipt.migration_id,
                   'disposition', receipt.disposition
                 )
               )
             END
           WHEN jsonb_typeof(shadow.original_metadata->'governance') = 'object'
            AND jsonb_typeof(shadow.original_metadata #> '{governance,native}') = 'object'
             THEN jsonb_set(
               shadow.original_metadata || jsonb_build_object('semanticType', receipt.semantic_type),
               '{governance,native,semanticType}',
               to_jsonb(receipt.semantic_type),
               true
             )
           ELSE shadow.original_metadata || jsonb_build_object('semanticType', receipt.semantic_type)
         END
       )::text AS restorable_count,
       COUNT(*) FILTER (
         WHERE memory.metadata = shadow.original_metadata
       )::text AS already_restored_count
FROM mengshu_semantic_type_backfill_shadow shadow
JOIN mengshu_semantic_type_backfill_receipts receipt
  ON receipt.migration_id = shadow.migration_id
 AND receipt.record_id = shadow.record_id
LEFT JOIN memories memory ON memory.id = shadow.record_id
WHERE shadow.migration_id = $1
  AND receipt.resulting_value_hash IS NOT NULL`;
const ROLLBACK_UPDATE_SQL = `/* semantic-type-backfill:rollback-update */
UPDATE memories memory
SET metadata = shadow.original_metadata
FROM mengshu_semantic_type_backfill_shadow shadow
JOIN mengshu_semantic_type_backfill_receipts receipt
  ON receipt.migration_id = shadow.migration_id
 AND receipt.record_id = shadow.record_id
WHERE shadow.migration_id = $1
  AND receipt.resulting_value_hash IS NOT NULL
  AND memory.id = shadow.record_id
  AND memory.metadata = CASE
    WHEN receipt.disposition IN ('lookup_only', 'invalid_explicit')
      THEN CASE
        WHEN jsonb_typeof(shadow.original_metadata->'governance') = 'object'
          THEN jsonb_set(
            shadow.original_metadata || jsonb_build_object(
              'admissionRoute', 'lookup_only', 'contextEligible', false,
              'memoryContainer', 'session_candidate'
            ),
            '{governance,semanticTypeBackfill}',
            jsonb_build_object(
              'migrationId', receipt.migration_id,
              'disposition', receipt.disposition
            ),
            true
          )
        ELSE shadow.original_metadata || jsonb_build_object(
          'admissionRoute', 'lookup_only', 'contextEligible', false,
          'memoryContainer', 'session_candidate',
          'semanticTypeBackfill', jsonb_build_object(
            'migrationId', receipt.migration_id,
            'disposition', receipt.disposition
          )
        )
      END
    WHEN jsonb_typeof(shadow.original_metadata->'governance') = 'object'
     AND jsonb_typeof(shadow.original_metadata #> '{governance,native}') = 'object'
      THEN jsonb_set(
        shadow.original_metadata || jsonb_build_object('semanticType', receipt.semantic_type),
        '{governance,native,semanticType}',
        to_jsonb(receipt.semantic_type),
        true
      )
    ELSE shadow.original_metadata || jsonb_build_object('semanticType', receipt.semantic_type)
  END`;

interface BackfillRow {
  id: string;
  metadata: Record<string, unknown>;
  memoryKind: MemoryKind;
  lifecycleStatus?: MemoryLifecycleStatus;
  classificationConflict: boolean;
}

interface MutableStats {
  scanned: number;
  preservedExplicit: number;
  backfilled: number;
  lookupOnly: number;
  invalidExplicit: number;
  batches: number;
}

interface BackfillSourceSnapshot {
  readonly sourceUpperBound: string | null;
  readonly sourceCount: number;
  readonly attemptHash: string;
}

interface BackfillCheckpoint {
  manifestHash: string;
  afterId: string | null;
  counts: MutableStats;
  snapshot?: BackfillSourceSnapshot;
}

function fail(code: SemanticTypeBackfillExecutorErrorCode): never {
  throw new SemanticTypeBackfillExecutorError(code);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateOptions(options: ExecutePostgresSemanticTypeBackfillOptions) {
  const mode = options.mode ?? "dry-run";
  const batchSize = options.batchSize ?? 100;
  const now = options.now ?? Date.now();
  if (!SAFE_ID.test(options.migrationId) || !SHA256.test(options.manifestHash) ||
      (mode !== "dry-run" && mode !== "apply") ||
      !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1_000 ||
      !Number.isSafeInteger(now) || now < 0) {
    fail("SEMANTIC_TYPE_BACKFILL_INVALID_OPTIONS");
  }
  if (mode === "apply" &&
      (options.maintenance !== true || options.quiescenceConfirmed !== true)) {
    fail("SEMANTIC_TYPE_BACKFILL_MAINTENANCE_REQUIRED");
  }
  return { mode, batchSize, now } as const;
}

function validateIdentity(options: VerifyPostgresSemanticTypeBackfillOptions): void {
  if (!SAFE_ID.test(options.migrationId) || !SHA256.test(options.manifestHash)) {
    fail("SEMANTIC_TYPE_BACKFILL_INVALID_OPTIONS");
  }
}

function integer(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function decodeCounts(value: unknown): MutableStats {
  if (!plainRecord(value)) fail("SEMANTIC_TYPE_BACKFILL_INVALID_DB_RESULT");
  const counts = {
    scanned: integer(value.scanned),
    preservedExplicit: integer(value.preservedExplicit),
    backfilled: integer(value.backfilled),
    lookupOnly: integer(value.lookupOnly),
    invalidExplicit: integer(value.invalidExplicit),
    batches: integer(value.batches),
  };
  if (Object.values(counts).some((entry) => entry === null)) {
    fail("SEMANTIC_TYPE_BACKFILL_INVALID_DB_RESULT");
  }
  return counts as MutableStats;
}

function decodeCheckpoint(
  result: PostgresSemanticTypeBackfillQueryResult,
  manifestHash: string,
): BackfillCheckpoint | null {
  if (!Array.isArray(result.rows) || !Number.isInteger(result.rowCount) ||
      result.rowCount !== result.rows.length || result.rows.length > 1) {
    fail("SEMANTIC_TYPE_BACKFILL_INVALID_DB_RESULT");
  }
  const row = result.rows[0];
  if (!row) return null;
  if (!plainRecord(row) || typeof row.manifest_hash !== "string" ||
      !SHA256.test(row.manifest_hash) ||
      (row.after_id !== null && (typeof row.after_id !== "string" || !UUID.test(row.after_id)))) {
    fail("SEMANTIC_TYPE_BACKFILL_INVALID_DB_RESULT");
  }
  if (row.manifest_hash !== manifestHash) {
    fail("SEMANTIC_TYPE_BACKFILL_MANIFEST_MISMATCH");
  }
  const counts = decodeCounts(row.counts);
  const persistedCounts = row.counts as Record<string, unknown>;
  const sourceUpperBound = persistedCounts.sourceUpperBound;
  const sourceCount = integer(persistedCounts.sourceCount);
  const attemptHash = persistedCounts.attemptHash;
  const snapshot = sourceUpperBound === undefined && persistedCounts.sourceCount === undefined &&
      attemptHash === undefined
    ? undefined
    : (sourceUpperBound === null || typeof sourceUpperBound === "string" && UUID.test(sourceUpperBound)) &&
        sourceCount !== null && typeof attemptHash === "string" && SHA256.test(attemptHash)
      ? { sourceUpperBound, sourceCount, attemptHash } satisfies BackfillSourceSnapshot
      : fail("SEMANTIC_TYPE_BACKFILL_INVALID_DB_RESULT");
  if (counts.scanned > 0 && snapshot === undefined) {
    fail("SEMANTIC_TYPE_BACKFILL_CONCURRENT_DRIFT");
  }
  return {
    manifestHash: row.manifest_hash,
    afterId: row.after_id as string | null,
    counts,
    snapshot,
  };
}

function lockKey(migrationId: string): string {
  return `mengshu.semantic-type-backfill:${migrationId}`;
}

async function acquireLock(
  client: PostgresSemanticTypeBackfillClient,
  migrationId: string,
): Promise<void> {
  let result: PostgresSemanticTypeBackfillQueryResult;
  try {
    result = await client.query(LOCK_SQL, [lockKey(migrationId)]);
  } catch {
    fail("SEMANTIC_TYPE_BACKFILL_DATABASE_FAILED");
  }
  if (!Array.isArray(result.rows) || result.rowCount !== 1 || result.rows.length !== 1 ||
      result.rows[0]?.acquired !== true) {
    fail("SEMANTIC_TYPE_BACKFILL_LOCK_UNAVAILABLE");
  }
}

async function releaseLock(
  client: PostgresSemanticTypeBackfillClient,
  migrationId: string,
): Promise<void> {
  let result: PostgresSemanticTypeBackfillQueryResult;
  try {
    result = await client.query(UNLOCK_SQL, [lockKey(migrationId)]);
  } catch {
    fail("SEMANTIC_TYPE_BACKFILL_DATABASE_FAILED");
  }
  if (!Array.isArray(result.rows) || result.rowCount !== 1 || result.rows.length !== 1 ||
      result.rows[0]?.released !== true) {
    fail("SEMANTIC_TYPE_BACKFILL_DATABASE_FAILED");
  }
}

function attemptHash(
  migrationId: string,
  manifestHash: string,
  sourceUpperBound: string | null,
  sourceCount: number,
): string {
  return createHash("sha256").update(JSON.stringify([
    "mengshu.semantic-type-backfill-attempt/v1",
    migrationId,
    manifestHash,
    sourceUpperBound,
    sourceCount,
  ])).digest("hex");
}

async function captureSourceSnapshot(
  client: PostgresSemanticTypeBackfillClient,
  options: VerifyPostgresSemanticTypeBackfillOptions,
): Promise<BackfillSourceSnapshot> {
  let result: PostgresSemanticTypeBackfillQueryResult;
  try {
    result = await client.query(SOURCE_SNAPSHOT_SQL);
  } catch {
    fail("SEMANTIC_TYPE_BACKFILL_DATABASE_FAILED");
  }
  if (!Array.isArray(result.rows) || result.rowCount !== 1 || result.rows.length !== 1 ||
      !plainRecord(result.rows[0])) {
    fail("SEMANTIC_TYPE_BACKFILL_INVALID_DB_RESULT");
  }
  const sourceUpperBound = result.rows[0].source_upper_bound;
  const sourceCount = integer(result.rows[0].source_count);
  if ((sourceUpperBound !== null &&
        (typeof sourceUpperBound !== "string" || !UUID.test(sourceUpperBound))) ||
      sourceCount === null || (sourceCount === 0) !== (sourceUpperBound === null)) {
    fail("SEMANTIC_TYPE_BACKFILL_INVALID_DB_RESULT");
  }
  return Object.freeze({
    sourceUpperBound: sourceUpperBound as string | null,
    sourceCount,
    attemptHash: attemptHash(
      options.migrationId,
      options.manifestHash,
      sourceUpperBound as string | null,
      sourceCount,
    ),
  });
}

function decodeRows(result: PostgresSemanticTypeBackfillQueryResult): BackfillRow[] {
  if (!Array.isArray(result.rows) || !Number.isInteger(result.rowCount) ||
      result.rowCount !== result.rows.length) {
    fail("SEMANTIC_TYPE_BACKFILL_INVALID_DB_RESULT");
  }
  return result.rows.map((row) => {
    if (!plainRecord(row) || typeof row.id !== "string" || !UUID.test(row.id) ||
        !plainRecord(row.metadata) ||
        (row.lifecycle_status !== null && row.lifecycle_status !== undefined &&
          (typeof row.lifecycle_status !== "string" ||
            !LIFECYCLE.has(row.lifecycle_status as MemoryLifecycleStatus)))) {
      fail("SEMANTIC_TYPE_BACKFILL_INVALID_DB_RESULT");
    }
    const kindSources: MemoryKind[] = [];
    let invalidKindSource = false;
    const addKind = (value: unknown): void => {
      if (value === null || value === undefined) return;
      if (typeof value !== "string" || !MEMORY_KINDS.has(value as MemoryKind)) {
        invalidKindSource = true;
        return;
      }
      kindSources.push(value as MemoryKind);
    };
    addKind(row.canonical_memory_kind);
    addKind(row.metadata_kind);
    addKind(row.legacy_memory_kind ?? row.memory_kind);

    if (row.data_type !== undefined && row.data_type !== null &&
        (typeof row.data_type !== "string" || !LEGACY_DATA_TYPES.has(row.data_type))) {
      invalidKindSource = true;
    }
    if (row.category !== undefined && row.category !== null &&
        (typeof row.category !== "string" || !LEGACY_CATEGORIES.has(row.category))) {
      invalidKindSource = true;
    }
    let derivedKind: MemoryKind | undefined;
    if (row.data_type === "document") derivedKind = "document";
    else if (row.data_type === "knowledge") derivedKind = "knowledge";
    else if (typeof row.category === "string" && row.category !== "core" && row.category !== "other") {
      derivedKind = row.category as MemoryKind;
    }
    if (derivedKind !== undefined) kindSources.push(derivedKind);
    const distinctKinds = [...new Set(kindSources)];
    const kind = distinctKinds[0] ?? "other";
    return {
      id: row.id,
      metadata: row.metadata,
      memoryKind: kind,
      classificationConflict: invalidKindSource || distinctKinds.length > 1,
      ...(typeof row.lifecycle_status === "string"
        ? { lifecycleStatus: row.lifecycle_status as MemoryLifecycleStatus }
        : {}),
    };
  });
}

function receiptId(migrationId: string, plan: LegacySemanticTypeBackfillPlan): string {
  return createHash("sha256")
    .update(JSON.stringify(["semantic-type-backfill-receipt/v1", migrationId, plan.recordId]))
    .digest("hex");
}

function resultingHash(plan: LegacySemanticTypeBackfillPlan): string | null {
  if (!plan.mutation) return null;
  return createHash("sha256")
    .update(JSON.stringify([plan.originalValueHash, plan.mutation]))
    .digest("hex");
}

function increment(
  stats: { preservedExplicit: number; backfilled: number; lookupOnly: number; invalidExplicit: number },
  plan: LegacySemanticTypeBackfillPlan,
): void {
  if (plan.disposition === "preserve_explicit") stats.preservedExplicit += 1;
  else if (plan.disposition === "backfill") stats.backfilled += 1;
  else if (plan.disposition === "lookup_only") stats.lookupOnly += 1;
  else stats.invalidExplicit += 1;
}

export async function executePostgresSemanticTypeBackfill(
  client: PostgresSemanticTypeBackfillClient,
  options: ExecutePostgresSemanticTypeBackfillOptions,
): Promise<ExecutePostgresSemanticTypeBackfillResult> {
  const { mode, batchSize, now } = validateOptions(options);
  await acquireLock(client, options.migrationId);
  try {
  let checkpoint: BackfillCheckpoint | null;
  try {
    checkpoint = decodeCheckpoint(
      await client.query(CHECKPOINT_READ_SQL, [options.migrationId]),
      options.manifestHash,
    );
  } catch (error) {
    if (error instanceof SemanticTypeBackfillExecutorError) throw error;
    fail("SEMANTIC_TYPE_BACKFILL_DATABASE_FAILED");
  }
  const stats: MutableStats = checkpoint?.counts ?? {
    scanned: 0,
    preservedExplicit: 0,
    backfilled: 0,
    lookupOnly: 0,
    invalidExplicit: 0,
    batches: 0,
  };
  const snapshot = checkpoint?.snapshot ?? await captureSourceSnapshot(client, options);
  if (checkpoint?.snapshot && checkpoint.snapshot.attemptHash !== attemptHash(
    options.migrationId,
    options.manifestHash,
    checkpoint.snapshot.sourceUpperBound,
    checkpoint.snapshot.sourceCount,
  )) {
    fail("SEMANTIC_TYPE_BACKFILL_CONCURRENT_DRIFT");
  }
  let afterId: string | null = checkpoint?.afterId ?? null;

  if (mode === "apply" && checkpoint === null) {
    try {
      await client.query("BEGIN");
      await client.query(CHECKPOINT_SQL, [
        options.migrationId,
        options.manifestHash,
        null,
        JSON.stringify({ ...stats, ...snapshot }),
        now,
      ]);
      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        fail("SEMANTIC_TYPE_BACKFILL_ROLLBACK_FAILED");
      }
      if (error instanceof SemanticTypeBackfillExecutorError) throw error;
      fail("SEMANTIC_TYPE_BACKFILL_DATABASE_FAILED");
    }
  }

  while (true) {
    let rows: BackfillRow[];
    try {
      rows = decodeRows(await client.query(SCAN_SQL, [
        afterId,
        options.migrationId,
        batchSize,
        snapshot.sourceUpperBound,
      ]));
    } catch (error) {
      if (error instanceof SemanticTypeBackfillExecutorError) throw error;
      fail("SEMANTIC_TYPE_BACKFILL_DATABASE_FAILED");
    }
    if (rows.length === 0) break;
    stats.batches += 1;
    const plans = rows.map((row) => planLegacySemanticTypeBackfill({
      id: row.id,
      kind: row.memoryKind,
      metadata: row.metadata,
      lifecycleStatus: row.lifecycleStatus,
      classificationConflict: row.classificationConflict,
    }));
    for (const plan of plans) increment(stats, plan);
    stats.scanned += rows.length;
    afterId = rows.at(-1)!.id;
    if (mode === "dry-run") continue;

    try {
      await client.query("BEGIN");
      for (const [index, plan] of plans.entries()) {
        const row = rows[index]!;
        await client.query(SHADOW_SQL, [
          options.migrationId, row.id, JSON.stringify(row.metadata), plan.originalValueHash, now,
        ]);
        if (plan.mutation?.semanticType !== undefined) {
          const updated = await client.query(CAS_UPDATE_SQL, [
            row.id,
            plan.mutation.semanticType,
            JSON.stringify(row.metadata),
          ]);
          if (updated.rowCount !== 1) fail("SEMANTIC_TYPE_BACKFILL_CONCURRENT_DRIFT");
        } else if (plan.mutation?.isolateLookupOnly === true) {
          const updated = await client.query(CAS_ISOLATE_SQL, [
            row.id,
            options.migrationId,
            plan.disposition,
            JSON.stringify(row.metadata),
          ]);
          if (updated.rowCount !== 1) fail("SEMANTIC_TYPE_BACKFILL_CONCURRENT_DRIFT");
        }
        await client.query(RECEIPT_SQL, [
          receiptId(options.migrationId, plan),
          options.migrationId,
          row.id,
          plan.disposition,
          plan.semanticType ?? null,
          plan.originalValueHash,
          resultingHash(plan),
          now,
        ]);
      }
      await client.query(CHECKPOINT_SQL, [
        options.migrationId,
        options.manifestHash,
        afterId,
        JSON.stringify({ ...stats, ...snapshot }),
        now,
      ]);
      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        fail("SEMANTIC_TYPE_BACKFILL_ROLLBACK_FAILED");
      }
      if (error instanceof SemanticTypeBackfillExecutorError) throw error;
      fail("SEMANTIC_TYPE_BACKFILL_DATABASE_FAILED");
    }
  }
  return { mode, ...stats, ...snapshot };
  } finally {
    await releaseLock(client, options.migrationId);
  }
}

export async function verifyPostgresSemanticTypeBackfill(
  client: PostgresSemanticTypeBackfillClient,
  options: VerifyPostgresSemanticTypeBackfillOptions,
): Promise<VerifyPostgresSemanticTypeBackfillResult> {
  validateIdentity(options);
  await acquireLock(client, options.migrationId);
  try {
  let result: PostgresSemanticTypeBackfillQueryResult;
  try {
    result = await client.query(VERIFY_SQL, [options.migrationId]);
  } catch {
    fail("SEMANTIC_TYPE_BACKFILL_DATABASE_FAILED");
  }
  if (!Array.isArray(result.rows) || result.rowCount !== 1 || result.rows.length !== 1) {
    fail("SEMANTIC_TYPE_BACKFILL_VERIFY_FAILED");
  }
  const row = result.rows[0];
  if (!plainRecord(row) || row.manifest_hash !== options.manifestHash) {
    if (plainRecord(row) && typeof row.manifest_hash === "string" && SHA256.test(row.manifest_hash)) {
      fail("SEMANTIC_TYPE_BACKFILL_MANIFEST_MISMATCH");
    }
    fail("SEMANTIC_TYPE_BACKFILL_INVALID_DB_RESULT");
  }
  const counts = decodeCounts(row.counts);
  const checkpoint = decodeCheckpoint({ rows: [row], rowCount: 1 }, options.manifestHash);
  if (!checkpoint?.snapshot) fail("SEMANTIC_TYPE_BACKFILL_VERIFY_FAILED");
  const snapshot = checkpoint.snapshot;
  const shadowCount = integer(row.shadow_count);
  const receiptCount = integer(row.receipt_count);
  const remainingCount = integer(row.remaining_count);
  const liveMismatchCount = integer(row.live_mismatch_count);
  const snapshotSourceCount = integer(row.snapshot_source_count);
  const dispositionCounts = [
    integer(row.preserved_explicit_count),
    integer(row.backfill_count),
    integer(row.lookup_only_count),
    integer(row.invalid_explicit_count),
  ];
  if (shadowCount === null || receiptCount === null || remainingCount === null ||
      liveMismatchCount === null || snapshotSourceCount === null ||
      dispositionCounts.some((value) => value === null)) {
    fail("SEMANTIC_TYPE_BACKFILL_INVALID_DB_RESULT");
  }
  const dispositionTotal = dispositionCounts.reduce<number>((sum, value) => sum + value!, 0);
  if (counts.scanned !== counts.preservedExplicit + counts.backfilled +
      counts.lookupOnly + counts.invalidExplicit ||
      counts.scanned !== shadowCount || counts.scanned !== receiptCount ||
      counts.scanned !== dispositionTotal ||
      counts.preservedExplicit !== dispositionCounts[0] ||
      counts.backfilled !== dispositionCounts[1] ||
      counts.lookupOnly !== dispositionCounts[2] ||
      counts.invalidExplicit !== dispositionCounts[3]) {
    fail("SEMANTIC_TYPE_BACKFILL_VERIFY_FAILED");
  }
  if (remainingCount !== 0 || liveMismatchCount !== 0 ||
      snapshotSourceCount !== snapshot.sourceCount || counts.scanned !== snapshot.sourceCount) {
    fail("SEMANTIC_TYPE_BACKFILL_VERIFY_FAILED");
  }
  return {
    migrationId: options.migrationId,
    manifestHash: options.manifestHash,
    ...counts,
    shadowCount,
    receiptCount,
    ...snapshot,
    valid: true,
  };
  } finally {
    await releaseLock(client, options.migrationId);
  }
}

export async function rollbackPostgresSemanticTypeBackfill(
  client: PostgresSemanticTypeBackfillClient,
  options: RollbackPostgresSemanticTypeBackfillOptions,
): Promise<{ readonly restored: number }> {
  validateIdentity(options);
  if (options.maintenance !== true || options.quiescenceConfirmed !== true) {
    fail("SEMANTIC_TYPE_BACKFILL_MAINTENANCE_REQUIRED");
  }
  await acquireLock(client, options.migrationId);
  try {
  let checkpoint: BackfillCheckpoint | null;
  try {
    checkpoint = decodeCheckpoint(
      await client.query(CHECKPOINT_READ_SQL, [options.migrationId]),
      options.manifestHash,
    );
  } catch (error) {
    if (error instanceof SemanticTypeBackfillExecutorError) throw error;
    fail("SEMANTIC_TYPE_BACKFILL_DATABASE_FAILED");
  }
  if (!checkpoint) fail("SEMANTIC_TYPE_BACKFILL_VERIFY_FAILED");
  if (!checkpoint.snapshot || checkpoint.counts.scanned !== checkpoint.snapshot.sourceCount) {
    fail("SEMANTIC_TYPE_BACKFILL_VERIFY_FAILED");
  }
  try {
    await client.query("BEGIN");
    const expectedResult = await client.query(ROLLBACK_EXPECTED_SQL, [options.migrationId]);
    if (!Array.isArray(expectedResult.rows) || expectedResult.rowCount !== 1 ||
        expectedResult.rows.length !== 1 || !plainRecord(expectedResult.rows[0])) {
      fail("SEMANTIC_TYPE_BACKFILL_INVALID_DB_RESULT");
    }
    const expected = integer(expectedResult.rows[0].expected_count);
    const restorable = integer(expectedResult.rows[0].restorable_count);
    const alreadyRestored = integer(expectedResult.rows[0].already_restored_count);
    if (expected === null || restorable === null || alreadyRestored === null) {
      fail("SEMANTIC_TYPE_BACKFILL_INVALID_DB_RESULT");
    }
    if (restorable + alreadyRestored !== expected) {
      fail("SEMANTIC_TYPE_BACKFILL_CONCURRENT_DRIFT");
    }
    const result = await client.query(ROLLBACK_UPDATE_SQL, [options.migrationId]);
    if (!Number.isInteger(result.rowCount) || result.rowCount !== restorable) {
      if (Number.isInteger(result.rowCount) && result.rowCount! >= 0) {
        fail("SEMANTIC_TYPE_BACKFILL_CONCURRENT_DRIFT");
      }
      fail("SEMANTIC_TYPE_BACKFILL_INVALID_DB_RESULT");
    }
    await client.query("COMMIT");
    return { restored: result.rowCount! };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      fail("SEMANTIC_TYPE_BACKFILL_ROLLBACK_FAILED");
    }
    if (error instanceof SemanticTypeBackfillExecutorError) throw error;
    fail("SEMANTIC_TYPE_BACKFILL_DATABASE_FAILED");
  }
  } finally {
    await releaseLock(client, options.migrationId);
  }
}
