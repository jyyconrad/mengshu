import type { MemoryKind, MemoryScope, MemorySemanticType } from "../domain/types.js";
import { computeCanonicalContentHash, matchesContentHash } from "../scoring/hash-utils.js";
import type { EvolutionAction, EvolutionCursor, EvolutionEvidence, EvolutionInputSnapshot, EvolutionInputUnit, EvolutionInventoryReadPort, EvolutionKey, EvolutionLimits, EvolutionTarget, EvolutionTargetRef } from "./types.js";
import { fail, integer, jsonHash, requiredId, scopedFingerprint, scopeParams, type PostgresEvolutionQueryClient } from "./postgres-common.js";
import type { PostgresEvolutionRepository } from "./postgres-repository.js";
import { PostgresEvolutionSelection } from "./postgres-selection.js";
import { evolutionGovernanceSnapshotHash, evolutionGovernanceState } from "./postgres-governance-state.js";

export const EVOLUTION_MEMORY_SCOPE_SQL = `tenant_id = $1 AND user_id = $2 AND product_id = $3
  AND canonical_project_id = $4 AND producer_id = $5 AND namespace = $6
  AND visibility = $7 AND COALESCE(workspace_id, '') = $8
  AND COALESCE(metadata->>'sessionId', metadata #>> '{governance,provenance,sessionId}', '') = $9
  AND (metadata->>'sessionId' IS NULL OR metadata #>> '{governance,provenance,sessionId}' IS NULL
    OR metadata->>'sessionId' = metadata #>> '{governance,provenance,sessionId}')`;
const CREATED_MS = "floor(extract(epoch FROM created_at) * 1000)::bigint";
export const EVOLUTION_MEMORY_COLUMNS_SQL = `id::text AS id, text, content_hash, ${CREATED_MS} AS created_at_ms,
revision, lineage_id, lifecycle_status, temporal_invalidated, temporal_purge_pending, metadata, data_type, legacy_quarantine_reason,
evolution_review_due_at, evolution_disputed, evolution_alias_of,
floor(extract(epoch FROM valid_from) * 1000)::bigint AS valid_from_ms,
floor(extract(epoch FROM valid_to) * 1000)::bigint AS valid_to_ms,
floor(extract(epoch FROM closed_at) * 1000)::bigint AS closed_at_ms`;
export const EVOLUTION_MEMORY_ROW_BOUNDS_SQL = "octet_length(text) <= 32768 AND octet_length(COALESCE(metadata, '{}'::jsonb)::text) <= 65536";
const ELIGIBLE = `${EVOLUTION_MEMORY_ROW_BOUNDS_SQL}
  AND temporal_purge_pending IS NOT TRUE AND temporal_invalidated IS NOT TRUE
  AND (temporal_activation_state IS NULL OR temporal_activation_state = 'active')
  AND ((lifecycle_status = 'active' AND COALESCE(metadata->>'admissionRoute', 'active') = 'active')
    OR (lifecycle_status = 'archived' AND metadata->>'admissionRoute' = 'lookup_only'))
  AND valid_to IS NULL AND NOT (metadata ? 'evolution')`;
const KINDS = new Set<MemoryKind>(["preference", "decision", "entity", "fact", "task", "plan", "goal", "document", "knowledge", "observation", "other"]);
const TYPES = new Set<MemorySemanticType>(["profile", "task_context", "rules", "experience", "resource"]);
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function key(value: EvolutionKey): EvolutionKey { return { createdAt: integer(value.createdAt), memoryId: requiredId(value.memoryId) }; }
function roots(metadata: Record<string, unknown>, id: string): string[] {
  const nativeRoots = record(record(metadata.governance).evolution).effectiveRootIds;
  // Legacy source aliases are not independent support until authoritative reconciliation exists.
  return Array.isArray(nativeRoots) && nativeRoots.every((r) => typeof r === "string" && r.length <= 256)
    ? [...new Set(nativeRoots as string[])].slice(0, 64).sort()
    : [`canonical:${id}`];
}
export interface PostgresEvolutionTarget extends EvolutionTarget { governanceHash: string }
export function decodeEvolutionTarget(row: Record<string, unknown>, scope: MemoryScope): PostgresEvolutionTarget {
  const metadata = record(row.metadata);
  const governance = record(metadata.governance);
  const native = record(governance.native);
  const id = requiredId(row.id);
  const kind = (native.kind ?? metadata.kind ?? "other") as MemoryKind;
  const semanticType = metadata.semanticType as MemorySemanticType | undefined;
  if (typeof row.text !== "string" || row.text.length === 0 || row.text.length > 100000 || !KINDS.has(kind) || (semanticType !== undefined && !TYPES.has(semanticType))) fail("INVALID_INVENTORY_ROW");
  if (!matchesContentHash(row.text, String(row.content_hash))) fail("INVALID_INVENTORY_HASH");
  return {
    memoryId: id, expectedRevision: row.revision == null ? 0 : integer(Number(row.revision)), beforeHash: computeCanonicalContentHash(row.text),
    governanceHash: evolutionGovernanceSnapshotHash([evolutionGovernanceState(row)], []),
    text: row.text, scope: { ...scope }, kind, ...(semanticType ? { semanticType } : {}),
    createdAt: integer(Number(row.created_at_ms)), evidenceRootIds: roots(metadata, typeof row.lineage_id === "string" ? row.lineage_id : id),
    pinned: metadata.pinned === true,
    tombstoned: row.evolution_alias_of != null || row.temporal_purge_pending === true || row.temporal_invalidated === true || ["revoked", "superseded"].includes(String(row.lifecycle_status)) || metadata.tombstoned === true || metadata.lifecycleStatus === "revoked",
    highImpact: kind === "decision" || semanticType === "rules",
    ...(row.valid_from_ms == null ? {} : { validFrom: integer(Number(row.valid_from_ms)) }),
    ...(row.valid_to_ms == null ? {} : { validTo: integer(Number(row.valid_to_ms)) }),
  };
}
function unitFromRow(row: Record<string, unknown>, scope: MemoryScope): EvolutionInputUnit {
  const target = decodeEvolutionTarget(row, scope);
  const evidence: EvolutionEvidence = {
    id: target.memoryId, sourceId: `canonical:${target.memoryId}`, revision: String(target.expectedRevision), snapshotHash: target.beforeHash,
    text: target.text, scope, rootEvidenceId: target.evidenceRootIds[0] ?? `canonical:${target.memoryId}`, origin: "canonical", trust: "untrusted", revoked: target.tombstoned,
  };
  return { id: target.memoryId, scope, snapshotHash: jsonHash({ target, sourceRevision: evidence.revision }), targets: [target], evidence: [evidence] };
}

export function decodeEvolutionOriginalEvidence(row: Record<string, unknown>, scope: MemoryScope): EvolutionEvidence | undefined {
  const metadata = record(row.metadata), governance = record(metadata.governance);
  const candidate = record(governance.candidate), provenance = record(governance.provenance);
  const native = record(governance.native);
  const sourceId = candidate.sourceId;
  if (row.data_type !== "memory" || row.legacy_quarantine_reason !== null ||
      !Number.isSafeInteger(Number(row.created_at_ms)) || Number(row.created_at_ms) < 0 ||
      metadata.admissionRoute !== "evidence_only" || metadata.contextEligible !== false || metadata.memoryContainer !== "session_candidate" ||
      !["observation", "explicit_save"].includes(String(metadata.eventType)) ||
      governance.commandType !== "importEvidence" || candidate.phase !== "raw_evidence" ||
      candidate.evidenceOnly !== true || candidate.quote !== row.text || typeof sourceId !== "string" || !/^[^\s\p{Cc}]{1,256}$/u.test(sourceId) || provenance.sourceId !== sourceId ||
      typeof provenance.source !== "string" || provenance.source.trim().length === 0 ||
      native.dataType !== "memory" || native.kind !== "observation" || native.container !== "session_candidate" ||
      (metadata.sessionId != null && provenance.sessionId != null && metadata.sessionId !== provenance.sessionId) ||
      (scope.sessionId !== undefined && scope.sessionId !== "" && provenance.sessionId !== scope.sessionId) ||
      !Array.isArray(governance.evidenceIds) || governance.evidenceIds.length !== 1 || governance.evidenceIds[0] !== sourceId ||
      !Array.isArray(metadata.sourceNodeIds) || metadata.sourceNodeIds.length !== 1 || metadata.sourceNodeIds[0] !== sourceId ||
      typeof row.text !== "string" || row.text.trim().length === 0 || Buffer.byteLength(row.text) > 32768 || !matchesContentHash(row.text, String(row.content_hash))) return undefined;
  // Old evidence has no trustworthy cross-export lineage. Collapse the source class conservatively.
  const rootEvidenceId = `legacy-root:${jsonHash([scopedFingerprint(scope), String(provenance.source)])}`;
  // Channel/intent labels, including "user", are not host-verified authorship or authorization.
  const trust: EvolutionEvidence["trust"] = "untrusted";
  return {
    id: requiredId(row.id), sourceId, revision: String(row.revision ?? 0), snapshotHash: computeCanonicalContentHash(row.text),
    text: row.text, scope: { ...scope }, rootEvidenceId, origin: "external", trust,
    revoked: row.lifecycle_status !== "archived" || row.temporal_invalidated === true || row.temporal_purge_pending === true || metadata.tombstoned === true || metadata.lifecycleStatus === "revoked",
  };
}

export class PostgresEvolutionInventoryReadPort implements EvolutionInventoryReadPort {
  readonly #scope: MemoryScope;
  readonly #fingerprint: string;
  readonly #client: PostgresEvolutionQueryClient;
  readonly #now: () => number;
  readonly #selection: PostgresEvolutionSelection;
  constructor(options: { client: PostgresEvolutionQueryClient; scope: MemoryScope; now?: () => number; repository?: PostgresEvolutionRepository }) {
    this.#scope = Object.freeze({ ...options.scope, visibility: options.scope.visibility ?? "private" });
    this.#fingerprint = scopedFingerprint(this.#scope);
    this.#client = options.client;
    this.#now = options.now ?? Date.now;
    this.#selection = new PostgresEvolutionSelection({ ...options, now: this.#now, memoryScopeSql: EVOLUTION_MEMORY_SCOPE_SQL, eligibleSql: ELIGIBLE, readPage: (...args) => this.readPage(...args) });
  }
  #assertScope(scope: MemoryScope): void { if (scopedFingerprint(scope) !== this.#fingerprint) fail("SCOPE_MISMATCH"); }
  async freeze(scope: MemoryScope, selection: "baseline" | "changed" | "due", limit: number): Promise<EvolutionInputSnapshot> {
    this.#assertScope(scope); integer(limit, 10000);
    if (selection === "changed" || selection === "due") return this.#selection.freeze(selection, limit);
    if (selection !== "baseline") fail("INVALID_SELECTION");
    const selectionEpoch = integer(this.#now());
    const result = await this.#client.query(
      `/* evolution:inventory-freeze */ SELECT id::text AS id, ${CREATED_MS} AS created_at_ms FROM memories
WHERE ${EVOLUTION_MEMORY_SCOPE_SQL} AND ${ELIGIBLE}
ORDER BY ${CREATED_MS} DESC, id DESC LIMIT 1`, scopeParams(this.#scope),
    );
    const row = result.rows[0];
    return { selectionEpoch, state: { maxRecordBytes: 32768, maxMetadataBytes: 65536, maxEvidencePerRecord: 7 }, ...(row ? { upperKey: { createdAt: integer(Number(row.created_at_ms)), memoryId: requiredId(row.id) } } : {}) };
  }
  readSelectedPage(scope: MemoryScope, snapshot: EvolutionInputSnapshot, cursor: EvolutionCursor, limit: number, budget: Pick<EvolutionLimits, "maxRecords" | "maxBytes">) {
    return this.#selection.readSelectedPage(scope, snapshot, cursor, limit, budget);
  }
  acknowledgeSelection(scope: MemoryScope, snapshot: EvolutionInputSnapshot, cursor: EvolutionCursor, action: EvolutionAction, proof?: { proposalId: string }) {
    return this.#selection.acknowledgeSelection(scope, snapshot, cursor, action, proof);
  }
  async readPage(scope: MemoryScope, snapshot: EvolutionInputSnapshot, after: EvolutionKey | undefined, limit: number,
    budget?: Pick<EvolutionLimits, "maxRecords" | "maxBytes">): Promise<{ units: EvolutionInputUnit[]; complete: boolean; recordsRead: number; bytesRead: number }> {
    this.#assertScope(scope);
    if (integer(limit, 10000) < 1) fail("INVALID_PAGE_LIMIT");
    const maxRecords = integer(budget?.maxRecords ?? 10000, 10000), maxBytes = integer(budget?.maxBytes ?? Number.MAX_SAFE_INTEGER);
    const boundedLimit = Math.min(limit, 64, Math.floor(maxRecords / 2));
    if (!snapshot.upperKey) return { units: [], complete: true, recordsRead: 0, bytesRead: 0 };
    if (boundedLimit === 0 || maxBytes === 0) return { units: [], complete: false, recordsRead: 0, bytesRead: 0 };
    const queryLimit = Math.min(boundedLimit + 1, maxRecords - boundedLimit);
    const upper = key(snapshot.upperKey), cursor = after ? key(after) : undefined;
    const selectedId = record(snapshot.state).selectedMemoryId;
    if (selectedId !== undefined) requiredId(selectedId);
    const result = await this.#client.query(
      `/* evolution:inventory-page */ SELECT ${EVOLUTION_MEMORY_COLUMNS_SQL} FROM memories
WHERE ${EVOLUTION_MEMORY_SCOPE_SQL} AND ${ELIGIBLE}
  AND (${CREATED_MS}, id) <= ($10::bigint, $11::uuid)
  AND ($12::bigint IS NULL OR (${CREATED_MS}, id) > ($12::bigint, $13::uuid))
  ${selectedId === undefined ? "" : "AND id::text = $15"}
ORDER BY ${CREATED_MS}, id LIMIT $14`,
      [...scopeParams(this.#scope), upper.createdAt, upper.memoryId, cursor?.createdAt ?? null, cursor?.memoryId ?? null, queryLimit, ...(selectedId === undefined ? [] : [selectedId])],
    );
    const readBytes = (rows: Record<string, unknown>[]) => rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0);
    let bytesRead = readBytes(result.rows);
    // maxBytes is post-read accounting, not a PostgreSQL wire/disk I/O quota.
    if (bytesRead > maxBytes) return { units: [], complete: false, recordsRead: result.rows.length, bytesRead };
    const selected = result.rows.slice(0, boundedLimit);
    const units = selected.map((row) => unitFromRow(row, this.#scope));
    let recordsRead = result.rows.length + selected.length;
    const rawLimit = Math.min(64, selected.length * 7, Math.floor((maxRecords - recordsRead) / Math.max(1, selected.length)));
    if (selected.length > 0 && rawLimit > 0) {
      const direct = selected.flatMap((row) => {
        const ids = record(record(row.metadata).governance).evidenceIds;
        return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string" && id.length <= 256).slice(0, 16) : [];
      });
      const raw = await this.#client.query(
        `/* evolution:inventory-evidence */ SELECT ${EVOLUTION_MEMORY_COLUMNS_SQL},
ARRAY(SELECT l.target_memory_id FROM mengshu_memory_evidence_links l
  WHERE l.scope_fingerprint = $12 AND l.evidence_memory_id = memories.id::text
    AND l.target_memory_id = ANY($11::text[]) LIMIT 64) AS target_ids
FROM memories WHERE ${EVOLUTION_MEMORY_SCOPE_SQL} AND metadata->>'admissionRoute' = 'evidence_only' AND octet_length(text) <= 32768
  AND octet_length(COALESCE(metadata, '{}'::jsonb)::text) <= 65536
  AND (id::text = ANY($10::text[]) OR EXISTS (SELECT 1 FROM mengshu_memory_evidence_links l
    WHERE l.scope_fingerprint = $12 AND l.target_memory_id = ANY($11::text[])
      AND l.evidence_memory_id = memories.id::text))
ORDER BY created_at, id LIMIT $13`,
        [...scopeParams(this.#scope), [...new Set(direct)], units.map((u) => u.id), this.#fingerprint, rawLimit],
      );
      recordsRead += raw.rows.length;
      bytesRead += readBytes(raw.rows);
      if (bytesRead > maxBytes) return { units: [], complete: false, recordsRead, bytesRead };
      for (const row of raw.rows) {
        const original = decodeEvolutionOriginalEvidence(row, this.#scope);
        if (!original || original.revoked) continue;
        for (let index = 0; index < selected.length; index++) {
          const directIds = record(record(selected[index]?.metadata).governance).evidenceIds;
          const linked = Array.isArray(row.target_ids) && row.target_ids.includes(units[index]!.id);
          if (!linked && !(Array.isArray(directIds) && directIds.includes(original.id))) continue;
          const unit = units[index]!;
          if (unit.evidence.length >= 8 || Buffer.byteLength(JSON.stringify({ ...unit, evidence: [...unit.evidence, original] })) > 120000) continue;
          // Hydrated references are input evidence, not new effective roots in the persisted target.
          unit.evidence.push(original);
        }
      }
    }
    for (const unit of units) unit.snapshotHash = jsonHash({ targets: unit.targets, evidence: unit.evidence.map(({ text: _text, locator: _locator, ...e }) => e) });
    recordsRead = Math.max(recordsRead, units.reduce((sum, u) => sum + u.targets.length + u.evidence.length, 0));
    const last = selected.at(-1);
    const complete = result.rows.length < queryLimit || (last?.id === upper.memoryId && Number(last.created_at_ms) === upper.createdAt);
    return { units, complete, recordsRead, bytesRead };
  }
  async readTargets(scope: MemoryScope, refs: EvolutionTargetRef[]): Promise<EvolutionTarget[]> {
    this.#assertScope(scope);
    if (refs.length > 64) fail("TARGET_LIMIT");
    if (refs.length === 0) return [];
    const ids = refs.map((ref) => requiredId(ref.memoryId));
    const result = await this.#client.query(
      `/* evolution:inventory-targets */ SELECT ${EVOLUTION_MEMORY_COLUMNS_SQL} FROM memories
WHERE ${EVOLUTION_MEMORY_SCOPE_SQL} AND ${EVOLUTION_MEMORY_ROW_BOUNDS_SQL} AND id = ANY($10::uuid[])`, [...scopeParams(this.#scope), ids],
    );
    const targets = new Map(result.rows.map(row => [String(row.id), decodeEvolutionTarget(row, this.#scope)]));
    return ids.flatMap(id => targets.has(id) ? [targets.get(id)!] : []);
  }
  async verifyEvidence(scope: MemoryScope, evidence: EvolutionEvidence[]): Promise<{ valid: boolean; reason?: string }> {
    this.#assertScope(scope);
    if (evidence.some((e) => scopedFingerprint(e.scope) !== this.#fingerprint || e.origin === "evaluation")) return { valid: false, reason: "UNSUPPORTED_EVIDENCE_SOURCE" };
    const hydrated = await this.hydrateEvidence(scope, evidence.map((e) => e.id));
    const valid = evidence.every((e) => hydrated.some((actual) => actual.id === e.id && actual.snapshotHash === e.snapshotHash && actual.revision === e.revision && actual.rootEvidenceId === e.rootEvidenceId && actual.trust === e.trust && !actual.revoked));
    return valid ? { valid } : { valid: false, reason: "SOURCE_CHANGED_OR_REVOKED" };
  }
  async hydrateEvidence(scope: MemoryScope, ids: readonly string[]): Promise<EvolutionEvidence[]> {
    this.#assertScope(scope);
    if (ids.length > 32) fail("EVIDENCE_LIMIT");
    if (ids.length === 0) return [];
    const result = await this.#client.query(
      `/* evolution:inventory-hydrate */ SELECT ${EVOLUTION_MEMORY_COLUMNS_SQL} FROM memories
WHERE ${EVOLUTION_MEMORY_SCOPE_SQL} AND id::text = ANY($10::text[])
  AND octet_length(text) <= 32768 AND octet_length(COALESCE(metadata, '{}'::jsonb)::text) <= 65536 LIMIT 32`,
      [...scopeParams(this.#scope), ids.map(requiredId)],
    );
    return result.rows.flatMap((row) => {
      if (record(row.metadata).admissionRoute === "evidence_only") {
        const original = decodeEvolutionOriginalEvidence(row, this.#scope);
        return original ? [original] : [];
      }
      const unit = unitFromRow(row, this.#scope);
      return unit.evidence;
    });
  }
}
