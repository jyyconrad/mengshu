import { describe, expect, test, vi } from "vitest";
import { decodeEvolutionOriginalEvidence, decodeEvolutionTarget, PostgresEvolutionInventoryReadPort } from "./postgres-inventory.js";
import { computeContentHash } from "../scoring/hash-utils.js";
import { assertEvolutionCheckpoint } from "./schema.js";
import { jsonHash } from "./postgres-common.js";
const scope = { tenantId: "tenant", userId: "user", appId: "codex", projectId: "p';SELECT(1)--", agentId: "a", namespace: "memories", visibility: "private" as const };
function row(id = "11111111-1111-4111-8111-111111111111") {
  return { id, text: "canonical fact", content_hash: computeContentHash("canonical fact"), created_at_ms: "100", revision: null, lineage_id: null, lifecycle_status: "archived", temporal_invalidated: false, temporal_purge_pending: false, metadata: { admissionRoute: "lookup_only", contextEligible: false, governance: { native: { kind: "fact" } } }, valid_from_ms: null, valid_to_ms: null };
}
function rawEvidence(source = "mcp") {
  const text = "User explicitly prefers local backups.";
  return { ...row("33333333-3333-4333-8333-333333333333"), text, content_hash: computeContentHash(text),
    data_type: "memory", legacy_quarantine_reason: null,
    metadata: { admissionRoute: "evidence_only", contextEligible: false, memoryContainer: "session_candidate", eventType: "observation", sourceNodeIds: ["original-event"],
      governance: { commandType: "importEvidence", evidenceIds: ["original-event"], native: { dataType: "memory", kind: "observation", container: "session_candidate" },
        provenance: { source, sourceId: "original-event" }, candidate: { phase: "raw_evidence", evidenceOnly: true, sourceId: "original-event", quote: text } } } };
}
function harness(rows: Record<string, unknown>[]) {
  const query = vi.fn(async (sql: string, _params?: readonly unknown[]) => /evolution:inventory-evidence/.test(sql) ? { rows: [], rowCount: 0 } : { rows, rowCount: rows.length });
  return { query, port: new PostgresEvolutionInventoryReadPort({ client: { query } as never, scope, now: () => 200 }) };
}
describe("PostgresEvolutionInventoryReadPort", () => {
  test.each([{ limit: 100, length: 64, pad: "a" }, { limit: 1000, length: 64, pad: "a" }, { limit: 10000, length: 256, pad: "a" }, { limit: 10000, length: 256, pad: "源" }])("changed snapshot fits 16KiB at limit $limit with event IDs of $length chars ($pad)", async ({ limit, length, pad }) => {
    const target = row(), candidates = Array.from({ length: Math.min(128, Math.max(1, Math.floor(limit / 4))) }, (_, i) => ({ source: "write", event_id: `${i}`.padStart(length, pad), memory_id: target.id, created_at_ms: 100, revision: 0, content_hash: target.content_hash, occurred_at: i }));
    const query = vi.fn(async () => ({ rows: candidates }));
    const port = new PostgresEvolutionInventoryReadPort({ client: { query } as never, scope, now: () => 200 });
    const snapshot = await port.freeze(scope, "changed", limit);
    expect(() => assertEvolutionCheckpoint(snapshot)).not.toThrow();
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(12 * 1024);
    const events = (snapshot.state as { events: unknown[] }).events;
    expect(events.length).toBeGreaterThan(0);
    if (limit > 100) expect(events.length).toBeLessThan(candidates.length);
    expect(query).toHaveBeenCalledTimes(1);
  });
  test("byte-trimmed events remain pending for subsequent batches; acknowledgements bind the exact event", async () => {
    const target = row(), pending = Array.from({ length: 128 }, (_, i) => ({ source: "write", event_id: `${i}`.padStart(256, "x"), memory_id: target.id, created_at_ms: 100, revision: 0, content_hash: target.content_hash, occurred_at: i }));
    const consumed = new Set<string>();
    let proposal: Record<string, unknown> = {};
    const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      if (sql.includes("evolution:selection-freeze")) return { rows: pending.filter(e => !consumed.has(e.event_id)).slice(0, Number(params.at(-1))) };
      if (sql.includes("evolution:selection-proof")) return { rows: [{ proposal_id: "p" }] };
      if (sql.includes("evolution:changed-ack")) consumed.add(String(params[9]));
      return { rows: [] };
    });
    const repository = { mutation: async (work: (client: unknown) => Promise<unknown>) => work({ query }), readEnvelope: async () => ({ proposal }) };
    const port = new PostgresEvolutionInventoryReadPort({ client: { query } as never, repository: repository as never, scope, now: () => 200 });
    const snapshot = await port.freeze(scope, "changed", 10000);
    type State = { hash: string; events: { source: string; eventId: string; memoryId: string }[]; recordsRead: number };
    const state = snapshot.state as unknown as State;
    expect(state.events.length).toBeLessThan(pending.length);
    expect(state.recordsRead).toBe(128);
    const first = state.events[0]!;
    proposal = { id: "p", status: "noop", sourceSnapshotHash: "a".repeat(64), inputFingerprint: "b".repeat(64), inputUnitId: `inventory:${first.memoryId}:${jsonHash([first.source, "different-event"])}` };
    const cursor = { hash: state.hash, offset: 1, eventId: first.eventId, snapshotHash: "a".repeat(64) };
    await expect(port.acknowledgeSelection(scope, snapshot, cursor, "apply_allowed", { proposalId: "p" })).rejects.toThrow("SELECTION_PROOF_MISMATCH");
    expect(consumed.size).toBe(0);
    for (const [offset, event] of state.events.entries()) {
      proposal.inputUnitId = `inventory:${event.memoryId}:${jsonHash([event.source, event.eventId])}`;
      await port.acknowledgeSelection(scope, snapshot, { ...cursor, offset: offset + 1, eventId: event.eventId }, "apply_allowed", { proposalId: "p" });
    }
    expect(consumed.size).toBe(state.events.length);
    const next = (await port.freeze(scope, "changed", 10000)).state as unknown as State;
    expect(next.events[0]?.eventId).toBe(pending[state.events.length]?.event_id);
    expect(next.events.every(event => !consumed.has(event.eventId))).toBe(true);
    expect(query.mock.calls.filter(([sql]) => sql.includes("evolution:changed-ack"))).toHaveLength(state.events.length);
  });
  test("original bounded raw evidence is hydrated separately from canonical self-reference", async () => {
    const raw = rawEvidence();
    const target = row();
    target.metadata = { ...target.metadata, governance: { ...target.metadata.governance, evidenceIds: [raw.id] } } as typeof target.metadata;
    const query = vi.fn(async (sql: string) => ({ rows: /evolution:inventory-evidence/.test(sql) ? [{ ...raw, target_ids: [target.id] }] : [target], rowCount: 1 }));
    const port = new PostgresEvolutionInventoryReadPort({ client: { query } as never, scope, now: () => 200 });
    const page = await port.readPage(scope, { selectionEpoch: 200, upperKey: { createdAt: 100, memoryId: target.id } }, undefined, 1);
    const original = page.units[0]?.evidence.find(e => e.id === raw.id);
    expect(original).toMatchObject({ text: raw.text, origin: "external", trust: "untrusted", sourceId: "original-event" });
    expect(original?.authorizedTargetIds).toBeUndefined();
    expect(page.units[0]?.targets[0]?.evidenceRootIds).toEqual([`canonical:${target.id}`]);
    expect(query.mock.calls.find(([sql]) => sql.includes("evolution:inventory-evidence"))?.[0]).toContain("LIMIT");
  });

  test.each(["mcp", "agent-fast-path", "user"])("%s channel and remember intent cannot prove user authorship", async (source) => {
    const raw = rawEvidence(source);
    raw.metadata = { ...raw.metadata, eventType: "observation", intent: "remember", authorRole: "user", hostVerified: true } as typeof raw.metadata;
    const decoded = decodeEvolutionOriginalEvidence(raw, scope);
    expect(decoded).toMatchObject({ id: raw.id, text: raw.text, sourceId: "original-event", trust: "untrusted", origin: "external", revoked: false });
    expect(decoded?.authorizedTargetIds).toBeUndefined();
    const h = harness([raw]);
    await expect(h.port.hydrateEvidence(scope, [raw.id])).resolves.toEqual([decoded]);
    await expect(h.port.verifyEvidence(scope, [decoded!])).resolves.toEqual({ valid: true });
  });
  test("raw hydration rejects records the canonical evidence reader cannot authorize", () => {
    const raw = rawEvidence();
    const governance = raw.metadata.governance;
    for (const invalid of [
      { ...raw, data_type: "knowledge" },
      { ...raw, legacy_quarantine_reason: "legacy_unverified" },
      { ...raw, metadata: { ...raw.metadata, eventType: "agent_summary" } },
      { ...raw, metadata: { ...raw.metadata, governance: { ...governance, candidate: { ...governance.candidate, quote: "different quote" } } } },
      { ...raw, metadata: { ...raw.metadata, governance: { ...governance, native: { ...governance.native, kind: "fact" } } } },
      { ...raw, metadata: { ...raw.metadata, sessionId: "one", governance: { ...governance, provenance: { ...governance.provenance, sessionId: "two" } } } },
    ]) expect(decodeEvolutionOriginalEvidence(invalid, scope)).toBeUndefined();
  });

  test("changed freezes committed event IDs, not a max-sequence watermark", async () => {
    const target = row();
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes("evolution:selection-freeze") ? [{ source: "write", event_id: "event-1", memory_id: target.id, created_at_ms: 100, revision: 0, content_hash: target.content_hash, occurred_at: 150 }] : sql.includes("evolution:inventory-evidence") ? [] : [target] }));
    const port = new PostgresEvolutionInventoryReadPort({ client: { query } as never, scope, now: () => 200 });
    const snapshot = await port.freeze(scope, "changed", 5);
    const page = await port.readSelectedPage(scope, snapshot, null, 1, { maxRecords: 20, maxBytes: 10000 });
    expect(page.units[0]?.selectionEvent).toMatchObject({ eventId: "event-1", memoryId: target.id, revision: 0, origin: "external" });
    expect(page.complete).toBe(true);
    const sql = query.mock.calls[0]![0];
    expect(sql).toContain("evolution_consumed_at IS NULL");
    expect(sql).toContain("evolution_origin IS FALSE");
    expect(sql).not.toMatch(/MAX\(|sequence\s*>/i);
  });
  test("due snapshot is bounded and drift fails without advancing cursor", async () => {
    const target = row();
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes("evolution:selection-freeze") ? [{ source: "due", event_id: target.id, memory_id: target.id, created_at_ms: 100, revision: 1, content_hash: target.content_hash, occurred_at: 0 }] : sql.includes("evolution:inventory-evidence") ? [] : [target] }));
    const port = new PostgresEvolutionInventoryReadPort({ client: { query } as never, scope, now: () => 200 });
    const snapshot = await port.freeze(scope, "due", 5);
    expect(query.mock.calls[0]![0]).toContain("evolution_review_due_at <=");
    const page = await port.readSelectedPage(scope, snapshot, null, 1, { maxRecords: 20, maxBytes: 10000 });
    expect(page).toMatchObject({ units: [], nextCursor: null, complete: false, reasons: ["inventory_selection_changed"] });
  });
  test("preview acknowledgement never mutates outbox", async () => {
    const h = harness([]);
    await expect(h.port.acknowledgeSelection(scope, { selectionEpoch: 1 }, null, "preview")).resolves.toBeUndefined();
    expect(h.query).not.toHaveBeenCalled();
  });
  test("freeze selects immutable maximum key with exact nine-dimensional scope parameters", async () => {
    const h = harness([row()]);
    await expect(h.port.freeze(scope, "baseline", 5)).resolves.toMatchObject({ selectionEpoch: 200, upperKey: { createdAt: 100, memoryId: row().id } });
    const [sql, params] = h.query.mock.calls[0]!;
    expect(sql).not.toContain(scope.projectId);
    expect(params).toContain(scope.projectId);
    expect(sql).toContain("COALESCE(metadata->>'sessionId'");
    expect(sql).not.toContain("updated_at");
  });
  test("keyset is exclusive and kind-only evidence stays canonical/untrusted", async () => {
    const h = harness([row(), row("22222222-2222-4222-8222-222222222222")]);
    const result = await h.port.readPage(scope, { selectionEpoch: 200, upperKey: { createdAt: 100, memoryId: "ffffffff-ffff-4fff-8fff-ffffffffffff" } }, { createdAt: 99, memoryId: row().id }, 1);
    expect(result.complete).toBe(false);
    expect(result.units).toHaveLength(1);
    expect(result.units[0]?.targets[0]).toMatchObject({ kind: "fact", expectedRevision: 0 });
    expect(result.units[0]?.targets[0]?.semanticType).toBeUndefined();
    expect(result.units[0]?.evidence[0]).toMatchObject({ origin: "canonical", trust: "untrusted" });
    const [sql] = h.query.mock.calls[0]!;
    expect(sql).toContain(") > (");
    expect(sql).toContain(") <= (");
    expect(sql).not.toContain("updated_at");
  });
  test("heat metadata does not alter semantic input fingerprint", async () => {
    const first = harness([row()]);
    const second = harness([{ ...row(), metadata: { ...row().metadata, queryHits: 999, hotness: 0.95 } }]);
    const snapshot = { selectionEpoch: 200, upperKey: { createdAt: 100, memoryId: row().id } };
    expect((await first.port.readPage(scope, snapshot, undefined, 2)).units[0]?.snapshotHash)
      .toBe((await second.port.readPage(scope, snapshot, undefined, 2)).units[0]?.snapshotHash);
  });
  test("target review state is identical across page budgets and rereads without promoting hydrated raw roots", async () => {
    const raw = rawEvidence(), target = row();
    const canonical = { ...target, metadata: { ...target.metadata, governance: { ...target.metadata.governance, evidenceIds: [raw.id] } } };
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes("evolution:inventory-evidence") ? [raw] : [canonical] }));
    const port = new PostgresEvolutionInventoryReadPort({ client: { query } as never, scope });
    const snapshot = { selectionEpoch: 200, upperKey: { createdAt: 100, memoryId: target.id } };
    const full = (await port.readPage(scope, snapshot, undefined, 1, { maxRecords: 20, maxBytes: 10000 })).units[0]!;
    const limited = (await port.readPage(scope, snapshot, undefined, 1, { maxRecords: 2, maxBytes: 10000 })).units[0]!;
    const current = await port.readTargets(scope, full.targets);
    expect(full.evidence).toContainEqual(expect.objectContaining({ id: raw.id, text: raw.text, trust: "untrusted", rootEvidenceId: expect.stringMatching(/^legacy-root:/) }));
    expect(limited.evidence).toHaveLength(1);
    expect(full.targets).toEqual(limited.targets);
    expect(full.targets).toEqual(current);
    expect(full.targets).toEqual([decodeEvolutionTarget(canonical, scope)]);
    expect(full.targets[0]!.evidenceRootIds).toEqual([`canonical:${target.id}`]);
  });
  test("review target fingerprint binds governance state but excludes scheduling and access metadata", () => {
    const original = row(), target = decodeEvolutionTarget(original, scope);
    const changed = [
      { ...original, evolution_disputed: true },
      { ...original, metadata: { ...original.metadata, contextEligible: true } },
      { ...original, metadata: { ...original.metadata, confidence: 0.9 } },
      { ...original, metadata: { ...original.metadata, governance: { ...original.metadata.governance, evidenceIds: ["new-raw"] } } },
      { ...original, metadata: { ...original.metadata, governance: { ...original.metadata.governance, evolution: { needsReview: true } } } },
    ];
    for (const current of changed) expect(decodeEvolutionTarget(current, scope)).not.toEqual(target);
    expect(decodeEvolutionTarget({ ...original, evolution_review_due_at: 999,
      metadata: { ...original.metadata, hotness: 1, queryHits: 500, governance: { ...original.metadata.governance,
        evolution: { enqueuedJobId: "later-job", lastAttemptAt: 500 } } } }, scope)).toEqual(target);
  });
  test("target rereads retain requested order with the same row size limits as inventory pages", async () => {
    const rows = [row(), row("22222222-2222-4222-8222-222222222222")], h = harness([...rows].reverse());
    const expected = rows.map(r => decodeEvolutionTarget(r, scope));
    expect(await h.port.readTargets(scope, expected)).toEqual(expected);
    expect(h.query.mock.calls[0]![0]).toContain("octet_length(text) <= 32768");
    expect(h.query.mock.calls[0]![0]).toContain("<= 65536");
  });
  test("page accounting includes lookahead and reserves the record budget before raw reads", async () => {
    const rows = [row(), row("22222222-2222-4222-8222-222222222222")], h = harness(rows);
    const page = await h.port.readPage(scope, { selectionEpoch: 200, upperKey: { createdAt: 100, memoryId: rows[1]!.id } }, undefined, 1, { maxRecords: 3, maxBytes: 10000 });
    expect(page).toMatchObject({ complete: false, recordsRead: 3, bytesRead: Buffer.byteLength(JSON.stringify(rows[0])) + Buffer.byteLength(JSON.stringify(rows[1])) });
    expect(h.query.mock.calls.some(([sql]) => sql.includes("evolution:inventory-evidence"))).toBe(false);
    const empty = harness(rows);
    await expect(empty.port.readPage(scope, { selectionEpoch: 200, upperKey: { createdAt: 100, memoryId: rows[1]!.id } }, undefined, 1, { maxRecords: 1, maxBytes: 10000 }))
      .resolves.toMatchObject({ units: [], complete: false, recordsRead: 0, bytesRead: 0 });
    expect(empty.query).not.toHaveBeenCalled();
  });
  test("maxBytes is reported honestly after a bounded read and stops further hydration", async () => {
    const h = harness([row()]);
    const result = await h.port.readPage(scope, { selectionEpoch: 200, upperKey: { createdAt: 100, memoryId: row().id } }, undefined, 1, { maxRecords: 10, maxBytes: 1 });
    expect(result.units).toEqual([]);
    expect(result.complete).toBe(false);
    expect(result.bytesRead).toBeGreaterThan(1);
    expect(h.query.mock.calls).toHaveLength(1);
  });
  test("revoked evidence and source content mismatch fail verification", async () => {
    const h = harness([row()]);
    const unit = (await h.port.readPage(scope, { selectionEpoch: 200, upperKey: { createdAt: 100, memoryId: row().id } }, undefined, 1)).units[0]!;
    const revoked = harness([{ ...row(), lifecycle_status: "revoked" }]);
    await expect(revoked.port.verifyEvidence(scope, unit.evidence)).resolves.toMatchObject({ valid: false });
    await expect(h.port.verifyEvidence(scope, [{ ...unit.evidence[0]!, snapshotHash: "f".repeat(64) }])).resolves.toMatchObject({ valid: false });
  });
});
