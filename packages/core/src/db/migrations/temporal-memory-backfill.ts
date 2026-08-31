import { createHash } from "node:crypto";

import { authorityScopeFingerprint } from "../../domain/authority-scope-fingerprint.js";
import type {
  MemoryKind,
  MemoryLifecycleStatus,
  MemoryRecord,
  MemoryScope,
  MemorySemanticType,
} from "../../domain/types.js";

export interface TemporalMemoryBackfillSourceRow {
  readonly id: string;
  readonly scope: MemoryScope;
  readonly kind: MemoryKind;
  readonly semanticType?: MemorySemanticType;
  readonly lifecycleStatus: MemoryLifecycleStatus;
  /** 原始物理值；legacy NULL 只在 apply 时显式归一化并由 rollback 恢复。 */
  readonly originalLifecycleStatus?: MemoryLifecycleStatus | null;
  readonly contentHash: string;
  readonly createdAt: number;
  readonly updatedAt?: number;
  readonly supersededBy?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  /** Apply-only canonical snapshot; planner hashes it but never emits plaintext. */
  readonly record?: MemoryRecord;
  readonly migrationBlockReason?: "noncanonical_lifecycle" | "unverifiable_content_hash";
}

export type TemporalMemoryBackfillDisposition =
  | "bootstrap_single"
  | "reuse_supersedes_chain"
  | "independent_lineage"
  | "review_multiple_heads"
  | "review_time_conflict"
  | "quarantine_invalid";

export type TemporalMemoryBackfillReasonCode =
  | "cycle"
  | "dangling_superseded_by"
  | "duplicate_id"
  | "fork"
  | "invalid_content_hash"
  | "invalid_created_at"
  | "invalid_id"
  | "invalid_scope"
  | "lifecycle_conflict"
  | "noncanonical_lifecycle"
  | "scope_mismatch"
  | "time_not_monotonic"
  | "type_mismatch"
  | "unverifiable_content_hash";

export interface TemporalMemoryBackfillRowPlan {
  readonly memoryId: string;
  readonly disposition: TemporalMemoryBackfillDisposition;
  readonly lineageId?: string;
  readonly revision?: number;
  readonly previousVersionId?: string;
  readonly validFrom?: number;
  readonly validTo?: number;
  readonly currentHead?: boolean;
  readonly lifecycleStatus: MemoryLifecycleStatus;
  readonly beforeHash: string;
  readonly afterHash?: string;
  readonly reasonCodes: readonly TemporalMemoryBackfillReasonCode[];
}

export interface TemporalMemoryBackfillPlan {
  readonly version: "temporal-memory-backfill-v1";
  readonly runId: string;
  readonly createdAt: number;
  readonly sourceHash: string;
  readonly manifestHash: string;
  readonly counts: Readonly<{
    scanned: number;
    automatic: number;
    review: number;
    lineages: number;
  }>;
  readonly rows: readonly TemporalMemoryBackfillRowPlan[];
}

export interface PlanTemporalMemoryBackfillOptions {
  readonly runId: string;
  readonly createdAt: number;
}

const LIFECYCLE_STATUSES = new Set<MemoryLifecycleStatus>([
  "active",
  "archived",
  "revoked",
  "superseded",
  "promoted",
]);
const CONTENT_HASH = /^(?:[0-9a-f]{32}|[0-9a-f]{64})$/;

function canonicalValue(value: unknown): unknown {
  if (value === undefined) return { $type: "undefined" };
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : { $number: String(value) };
  }
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [
      key,
      canonicalValue((value as Record<string, unknown>)[key]),
    ]));
  }
  return { $type: typeof value };
}

function hashValue(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(`${domain}\0${JSON.stringify(canonicalValue(value))}`)
    .digest("hex");
}

function compareRows(
  left: TemporalMemoryBackfillSourceRow,
  right: TemporalMemoryBackfillSourceRow,
): number {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

function sourceProjection(row: TemporalMemoryBackfillSourceRow): unknown {
  return {
    id: row.id,
    scope: row.scope,
    kind: row.kind,
    semanticType: row.semanticType,
    lifecycleStatus: row.lifecycleStatus,
    originalLifecycleStatus: row.originalLifecycleStatus,
    contentHash: row.contentHash,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    supersededBy: row.supersededBy,
    metadata: row.metadata,
    record: row.record,
    migrationBlockReason: row.migrationBlockReason,
  };
}

function lineageId(scopeFingerprint: string, rootId: string): string {
  return `tm_${hashValue("temporal-memory-backfill-lineage-v1", [
    scopeFingerprint,
    rootId,
  ]).slice(0, 48)}`;
}

function explicitTarget(row: TemporalMemoryBackfillSourceRow): string | undefined {
  const target = row.supersededBy?.trim();
  return target ? target : undefined;
}

function automaticDisposition(
  row: TemporalMemoryBackfillSourceRow,
  chainLength: number,
): TemporalMemoryBackfillDisposition {
  if (chainLength > 1) return "reuse_supersedes_chain";
  return row.lifecycleStatus === "active" ? "bootstrap_single" : "independent_lineage";
}

function addReason(
  reasons: Map<string, Set<TemporalMemoryBackfillReasonCode>>,
  id: string,
  reason: TemporalMemoryBackfillReasonCode,
): void {
  const values = reasons.get(id) ?? new Set<TemporalMemoryBackfillReasonCode>();
  values.add(reason);
  reasons.set(id, values);
}

function reviewDisposition(
  reasons: ReadonlySet<TemporalMemoryBackfillReasonCode>,
): TemporalMemoryBackfillDisposition {
  if ([...reasons].some((reason) =>
    reason === "duplicate_id" || reason === "invalid_id" || reason === "invalid_scope" ||
    reason === "invalid_content_hash" || reason === "invalid_created_at" ||
    reason === "noncanonical_lifecycle" || reason === "unverifiable_content_hash")) {
    return "quarantine_invalid";
  }
  if (reasons.has("cycle") || reasons.has("time_not_monotonic") ||
      reasons.has("lifecycle_conflict")) {
    return "review_time_conflict";
  }
  return "review_multiple_heads";
}

function markCycleNodes(
  rowsById: ReadonlyMap<string, TemporalMemoryBackfillSourceRow>,
  targets: ReadonlyMap<string, string>,
  reasons: Map<string, Set<TemporalMemoryBackfillReasonCode>>,
): void {
  const complete = new Set<string>();
  for (const start of rowsById.keys()) {
    if (complete.has(start)) continue;
    const path: string[] = [];
    const offsets = new Map<string, number>();
    let cursor: string | undefined = start;
    while (cursor !== undefined && !complete.has(cursor)) {
      const offset = offsets.get(cursor);
      if (offset !== undefined) {
        for (const id of path.slice(offset)) addReason(reasons, id, "cycle");
        break;
      }
      offsets.set(cursor, path.length);
      path.push(cursor);
      cursor = targets.get(cursor);
    }
    for (const id of path) complete.add(id);
  }
}

export function planTemporalMemoryBackfill(
  sourceRows: readonly TemporalMemoryBackfillSourceRow[],
  options: PlanTemporalMemoryBackfillOptions,
): TemporalMemoryBackfillPlan {
  if (!options.runId.trim() || !Number.isFinite(options.createdAt)) {
    throw new Error("Temporal backfill runId and createdAt are required");
  }

  const rows = [...sourceRows].sort(compareRows);
  const reasons = new Map<string, Set<TemporalMemoryBackfillReasonCode>>();
  const countsById = new Map<string, number>();
  const scopeById = new Map<string, string>();
  for (const row of rows) countsById.set(row.id, (countsById.get(row.id) ?? 0) + 1);

  for (const row of rows) {
    if (!row.id.trim()) addReason(reasons, row.id, "invalid_id");
    if ((countsById.get(row.id) ?? 0) > 1) addReason(reasons, row.id, "duplicate_id");
    if (!CONTENT_HASH.test(row.contentHash)) addReason(reasons, row.id, "invalid_content_hash");
    if (row.migrationBlockReason === "noncanonical_lifecycle") {
      addReason(reasons, row.id, "noncanonical_lifecycle");
    }
    if (row.migrationBlockReason === "unverifiable_content_hash") {
      addReason(reasons, row.id, "unverifiable_content_hash");
    }
    if (!Number.isFinite(row.createdAt) || row.createdAt < 0) {
      addReason(reasons, row.id, "invalid_created_at");
    }
    if (!LIFECYCLE_STATUSES.has(row.lifecycleStatus)) {
      addReason(reasons, row.id, "lifecycle_conflict");
    }
    try {
      scopeById.set(row.id, authorityScopeFingerprint(row.scope));
    } catch {
      addReason(reasons, row.id, "invalid_scope");
    }
  }

  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const validTargets = new Map<string, string>();
  const inbound = new Map<string, string[]>();
  for (const source of rows) {
    const targetId = explicitTarget(source);
    if (targetId === undefined) continue;
    const target = rowsById.get(targetId);
    if (target === undefined) {
      addReason(reasons, source.id, "dangling_superseded_by");
      continue;
    }
    let valid = true;
    if (scopeById.get(source.id) === undefined ||
        scopeById.get(source.id) !== scopeById.get(target.id)) {
      addReason(reasons, source.id, "scope_mismatch");
      addReason(reasons, target.id, "scope_mismatch");
      valid = false;
    }
    if (source.kind !== target.kind || source.semanticType !== target.semanticType) {
      addReason(reasons, source.id, "type_mismatch");
      addReason(reasons, target.id, "type_mismatch");
      valid = false;
    }
    if (source.createdAt >= target.createdAt) {
      addReason(reasons, source.id, "time_not_monotonic");
      addReason(reasons, target.id, "time_not_monotonic");
      valid = false;
    }
    if (source.lifecycleStatus !== "superseded") {
      addReason(reasons, source.id, "lifecycle_conflict");
      valid = false;
    }
    if (!valid) continue;
    validTargets.set(source.id, target.id);
    inbound.set(target.id, [...(inbound.get(target.id) ?? []), source.id]);
  }

  for (const [targetId, sourceIds] of inbound) {
    if (sourceIds.length <= 1) continue;
    addReason(reasons, targetId, "fork");
    for (const sourceId of sourceIds) addReason(reasons, sourceId, "fork");
  }
  markCycleNodes(rowsById, validTargets, reasons);

  // An ambiguous row contaminates its explicit connected component. This prevents a
  // valid-looking suffix from being silently split away from a fork or invalid edge.
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      const targetId = explicitTarget(row);
      if (targetId === undefined || !rowsById.has(targetId)) continue;
      const sourceReview = (reasons.get(row.id)?.size ?? 0) > 0;
      const targetReview = (reasons.get(targetId)?.size ?? 0) > 0;
      if (sourceReview === targetReview) continue;
      addReason(reasons, sourceReview ? targetId : row.id, "fork");
      changed = true;
    }
  }

  const cleanTargets = new Map<string, string>();
  const cleanInbound = new Map<string, string>();
  for (const [sourceId, targetId] of validTargets) {
    if ((reasons.get(sourceId)?.size ?? 0) > 0 || (reasons.get(targetId)?.size ?? 0) > 0) continue;
    cleanTargets.set(sourceId, targetId);
    cleanInbound.set(targetId, sourceId);
  }

  const automaticById = new Map<string, TemporalMemoryBackfillRowPlan>();
  const visited = new Set<string>();
  const cleanRows = rows.filter((row) => (reasons.get(row.id)?.size ?? 0) === 0);
  for (const root of cleanRows) {
    if (cleanInbound.has(root.id) || visited.has(root.id)) continue;
    const chain: TemporalMemoryBackfillSourceRow[] = [];
    let cursor: TemporalMemoryBackfillSourceRow | undefined = root;
    while (cursor !== undefined && !visited.has(cursor.id)) {
      chain.push(cursor);
      visited.add(cursor.id);
      const nextId = cleanTargets.get(cursor.id);
      cursor = nextId === undefined ? undefined : rowsById.get(nextId);
    }
    const scopeFingerprint = scopeById.get(root.id);
    if (scopeFingerprint === undefined) continue;
    const id = lineageId(scopeFingerprint, root.id);
    for (let index = 0; index < chain.length; index += 1) {
      const row = chain[index]!;
      const next = chain[index + 1];
      const projection = {
        lineageId: id,
        revision: index + 1,
        previousVersionId: index === 0 ? undefined : chain[index - 1]!.id,
        validFrom: row.createdAt,
        validTo: next?.createdAt,
        currentHead: next === undefined && row.lifecycleStatus === "active",
        lifecycleStatus: row.lifecycleStatus,
      };
      automaticById.set(row.id, {
        memoryId: row.id,
        disposition: automaticDisposition(row, chain.length),
        ...projection,
        beforeHash: hashValue("temporal-memory-backfill-before-v1", sourceProjection(row)),
        afterHash: hashValue("temporal-memory-backfill-after-v1", projection),
        reasonCodes: [],
      });
    }
  }

  const plannedRows = rows.map((row): TemporalMemoryBackfillRowPlan => {
    const automatic = automaticById.get(row.id);
    if (automatic !== undefined) return automatic;
    const rowReasons = reasons.get(row.id) ?? new Set<TemporalMemoryBackfillReasonCode>([
      "lifecycle_conflict",
    ]);
    return {
      memoryId: row.id,
      disposition: reviewDisposition(rowReasons),
      lifecycleStatus: row.lifecycleStatus,
      beforeHash: hashValue("temporal-memory-backfill-before-v1", sourceProjection(row)),
      reasonCodes: [...rowReasons].sort(),
    };
  });
  const automatic = plannedRows.filter((row) => row.lineageId !== undefined).length;
  const review = plannedRows.length - automatic;
  const lineages = new Set(plannedRows.flatMap((row) => row.lineageId ? [row.lineageId] : [])).size;
  const sourceHash = hashValue(
    "temporal-memory-backfill-source-v1",
    rows.map(sourceProjection),
  );
  const manifestBase = {
    version: "temporal-memory-backfill-v1" as const,
    runId: options.runId,
    createdAt: options.createdAt,
    sourceHash,
    counts: { scanned: rows.length, automatic, review, lineages },
    rows: plannedRows,
  };
  return Object.freeze({
    ...manifestBase,
    manifestHash: hashValue("temporal-memory-backfill-manifest-v1", manifestBase),
  });
}
