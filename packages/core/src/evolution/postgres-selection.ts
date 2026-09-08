import type { MemoryScope } from "../domain/types.js";
import { boundedJson, DB_NOW_MS, fail, integer, jsonHash, requiredId, scopedFingerprint, scopeParams, type PostgresEvolutionQueryClient } from "./postgres-common.js";
import type { PostgresEvolutionRepository } from "./postgres-repository.js";
import type { EvolutionAction, EvolutionCursor, EvolutionInputSnapshot, EvolutionInventoryReadPort, EvolutionLimits, EvolutionPage } from "./types.js";
import { matchesContentHash } from "../scoring/hash-utils.js";

interface SelectedEvent { source: "write" | "version" | "due"; eventId: string; memoryId: string; revision: number; contentHash: string; createdAt: number; occurredAt: number }
interface SelectionState { selection: "changed" | "due"; scopeFingerprint: string; events: SelectedEvent[]; hash: string; bytes: number; recordsRead?: number }
// Core checkpoints are 16KiB. Reserve 4KiB for envelope evolution and future cursor fields.
export const EVOLUTION_SELECTION_CHECKPOINT_MAX_BYTES = 12 * 1024;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export class PostgresEvolutionSelection {
  constructor(private readonly options: {
    client: PostgresEvolutionQueryClient; repository?: PostgresEvolutionRepository; scope: MemoryScope;
    memoryScopeSql: string; eligibleSql: string; now: () => number;
    readPage: EvolutionInventoryReadPort["readPage"];
  }) {}
  #state(snapshot: EvolutionInputSnapshot): SelectionState {
    const state = boundedJson(snapshot.state, 131072) as unknown as SelectionState;
    if (!state || !["changed", "due"].includes(state.selection) || state.scopeFingerprint !== scopedFingerprint(this.options.scope) ||
      !Array.isArray(state.events) || state.events.length > 128 || state.hash !== jsonHash([state.selection, state.scopeFingerprint, state.events])) fail("INVALID_SELECTION_SNAPSHOT");
    return state;
  }
  #offset(cursor: EvolutionCursor, state: SelectionState): number {
    if (cursor === null) return 0;
    const value = object(cursor);
    if (value.hash !== state.hash) fail("INVALID_SELECTION_CURSOR");
    return integer(value.offset, state.events.length);
  }
  async freeze(selection: "changed" | "due", limit: number): Promise<EvolutionInputSnapshot> {
    const { scope, client, memoryScopeSql, eligibleSql } = this.options;
    const at = integer(this.options.now()), fp = scopedFingerprint(scope);
    const bound = Math.min(128, Math.max(1, Math.floor(integer(limit, 10000) / 4)));
    const common = `WITH scoped AS (SELECT id::text AS memory_id, COALESCE(revision, 0) AS revision, content_hash,
floor(extract(epoch FROM created_at) * 1000)::bigint AS created_at_ms, evolution_review_due_at
FROM memories WHERE ${memoryScopeSql} AND ${eligibleSql} AND evolution_alias_of IS NULL)
`;
    const sql = selection === "due" ? `${common}
SELECT 'due' AS source, memory_id AS event_id, memory_id, revision, content_hash, created_at_ms, evolution_review_due_at AS occurred_at
FROM scoped WHERE evolution_review_due_at <= $10 ORDER BY evolution_review_due_at, memory_id LIMIT $11`
      : `${common}
SELECT * FROM (
SELECT 'write' AS source, o.event_id, s.memory_id, s.revision, s.content_hash, s.created_at_ms,
floor(extract(epoch FROM o.occurred_at) * 1000)::bigint AS occurred_at
FROM scoped s JOIN mengshu_write_outbox o ON o.memory_id = s.memory_id
WHERE o.evolution_consumed_at IS NULL AND o.evolution_origin IS FALSE
  AND o.tenant_id = $1 AND o.user_id = $2 AND o.product_id = $3 AND o.canonical_project_id = $4
  AND o.producer_id = $5 AND o.namespace = $6 AND o.visibility = $7 AND o.workspace_id = $8 AND o.session_id = $9
UNION ALL
SELECT 'version' AS source, o.event_id, s.memory_id, s.revision, s.content_hash, s.created_at_ms, o.occurred_at
FROM scoped s JOIN mengshu_memory_version_outbox o ON o.payload->>'versionId' = s.memory_id
WHERE o.scope_fingerprint = $10 AND o.evolution_consumed_at IS NULL AND o.evolution_origin IS FALSE
) events ORDER BY occurred_at, event_id, source LIMIT $11`;
    const rows = (await client.query(`/* evolution:selection-freeze */ ${sql}`, [...scopeParams(scope), selection === "due" ? at : fp, bound])).rows;
    if (rows.length > bound) fail("SELECTION_LIMIT");
    const events: SelectedEvent[] = rows.map(row => {
      const source = row.source;
      if (!["write", "version", "due"].includes(String(source)) || typeof row.content_hash !== "string" || !/^[a-f0-9]{32,64}$/.test(row.content_hash)) fail("INVALID_SELECTION_ROW");
      const event = { source: source as SelectedEvent["source"], eventId: requiredId(row.event_id), memoryId: requiredId(row.memory_id),
        revision: integer(Number(row.revision)), contentHash: row.content_hash, createdAt: integer(Number(row.created_at_ms)), occurredAt: integer(Number(row.occurred_at)) };
      if (source === "due") event.eventId = jsonHash(event);
      return event;
    });
    const state: SelectionState = { selection, scopeFingerprint: fp, events, hash: jsonHash([selection, fp, events]), bytes: Buffer.byteLength(JSON.stringify(rows)), recordsRead: rows.length };
    while (Buffer.byteLength(JSON.stringify({ selectionEpoch: at, state })) > EVOLUTION_SELECTION_CHECKPOINT_MAX_BYTES && events.length) {
      events.pop();
      state.hash = jsonHash([selection, fp, events]);
    }
    if (rows.length && !events.length) fail("SELECTION_EVENT_TOO_LARGE");
    // Excluded events remain pending: only acknowledgeSelection mutates individual event IDs.
    return boundedJson({ selectionEpoch: at, state: state as unknown as EvolutionInputSnapshot["state"] }, EVOLUTION_SELECTION_CHECKPOINT_MAX_BYTES);
  }
  async readSelectedPage(scope: MemoryScope, snapshot: EvolutionInputSnapshot, cursor: EvolutionCursor, limit: number, budget: Pick<EvolutionLimits, "maxRecords" | "maxBytes">): Promise<EvolutionPage> {
    if (scopedFingerprint(scope) !== scopedFingerprint(this.options.scope)) fail("SCOPE_MISMATCH");
    integer(limit, 10000);
    const state = this.#state(snapshot), offset = this.#offset(cursor, state), event = state.events[offset];
    const frozenRecords = cursor === null ? (state.recordsRead ?? state.events.length) : 0, frozenBytes = cursor === null ? state.bytes : 0;
    if (!event) return { units: [], nextCursor: cursor, complete: true, recordsRead: frozenRecords, bytesRead: frozenBytes, filesRead: 0 };
    if (budget.maxRecords - frozenRecords < 2 || budget.maxBytes <= frozenBytes || limit < 1) return { units: [], nextCursor: cursor, complete: false, recordsRead: frozenRecords, bytesRead: frozenBytes, filesRead: 0, reasons: ["inventory_selection_budget"] };
    const page = await this.options.readPage(scope, { selectionEpoch: snapshot.selectionEpoch, upperKey: { createdAt: event.createdAt, memoryId: event.memoryId }, state: { selectedMemoryId: event.memoryId } }, undefined, 1,
      { maxRecords: budget.maxRecords - frozenRecords, maxBytes: budget.maxBytes - frozenBytes });
    const accounting = { recordsRead: frozenRecords + (page.recordsRead ?? 0), bytesRead: frozenBytes + (page.bytesRead ?? 0), filesRead: 0 };
    const unit = page.units[0], target = unit?.targets[0];
    if (!unit || !target || target.memoryId !== event.memoryId || target.expectedRevision !== event.revision ||
      !matchesContentHash(target.text, event.contentHash)) return { ...accounting, units: [], nextCursor: cursor, complete: false, reasons: ["inventory_selection_changed"] };
    unit.id = `inventory:${event.memoryId}:${jsonHash([event.source, event.eventId])}`;
    unit.selectionEvent = { eventId: event.eventId, memoryId: event.memoryId, revision: target.expectedRevision, origin: "external" };
    return { ...accounting, units: [unit], complete: offset + 1 === state.events.length,
      nextCursor: { hash: state.hash, offset: offset + 1, eventId: event.eventId, snapshotHash: unit.snapshotHash } };
  }
  async acknowledgeSelection(scope: MemoryScope, snapshot: EvolutionInputSnapshot, cursor: EvolutionCursor, action: EvolutionAction, proof?: { proposalId: string }): Promise<void> {
    if (scopedFingerprint(scope) !== scopedFingerprint(this.options.scope)) fail("SCOPE_MISMATCH");
    if (action === "preview") return;
    const repository = this.options.repository;
    if (!repository) fail("selection_acknowledge_unavailable");
    const state = this.#state(snapshot), offset = this.#offset(cursor, state), event = state.events[offset - 1], position = object(cursor);
    if (!proof || !event || position.eventId !== event.eventId) fail("SELECTION_PROOF_REQUIRED");
    await repository.mutation(async client => {
      const envelope = await repository.readEnvelope(client, requiredId(proof.proposalId));
      const p = envelope?.proposal;
      if (!p || p.sourceSnapshotHash !== position.snapshotHash || p.inputUnitId !== `inventory:${event.memoryId}:${jsonHash([event.source, event.eventId])}` ||
        action === "apply_allowed" && !["applied", "noop", "rejected", "review"].includes(p.status)) fail("SELECTION_PROOF_MISMATCH");
      const processed = await client.query(`/* evolution:selection-proof */ SELECT proposal_id FROM mengshu_evolution_processed_inputs
WHERE scope_fingerprint = $1 AND proposal_id = $2 AND input_fingerprint = $3 AND action = $4`, [state.scopeFingerprint, p.id, p.inputFingerprint, action]);
      if (!processed.rows.length) fail("SELECTION_PROOF_MISSING");
      if (event.source === "due") {
        await client.query(`/* evolution:due-ack */ UPDATE memories SET evolution_review_due_at = ${DB_NOW_MS} + 604800000
WHERE ${this.options.memoryScopeSql} AND id::text = $10 AND COALESCE(revision,0) = $11 AND content_hash = $12 AND evolution_review_due_at = $13`, [...scopeParams(scope), event.memoryId, event.revision, event.contentHash, event.occurredAt]);
      } else if (event.source === "write") {
        await client.query(`/* evolution:changed-ack */ UPDATE mengshu_write_outbox SET evolution_consumed_at = ${DB_NOW_MS}
WHERE event_id = $10 AND memory_id = $11 AND tenant_id = $1 AND user_id = $2 AND product_id = $3
AND canonical_project_id = $4 AND producer_id = $5 AND namespace = $6 AND visibility = $7 AND workspace_id = $8 AND session_id = $9
AND evolution_consumed_at IS NULL AND evolution_origin IS FALSE`, [...scopeParams(scope), event.eventId, event.memoryId]);
      } else {
        await client.query(`/* evolution:changed-ack */ UPDATE mengshu_memory_version_outbox SET evolution_consumed_at = ${DB_NOW_MS}
WHERE scope_fingerprint = $1 AND event_id = $2 AND payload->>'versionId' = $3 AND evolution_consumed_at IS NULL AND evolution_origin IS FALSE`, [state.scopeFingerprint, event.eventId, event.memoryId]);
      }
    });
  }
}
