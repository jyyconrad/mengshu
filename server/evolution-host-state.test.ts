import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createPostgresEvolutionHostState } from "./evolution-host-state.js";
import { createEvolutionAttestation, evolutionAttestationSigningPayload, type EvolutionAttestationStatement } from "./evolution-attestation.js";
import { authority, scope, unit, inputPort } from "../packages/core/src/evolution/test-fixtures.js";
import { AttestedEvolutionInput } from "../packages/core/src/evolution/attested-input.js";
import { evolutionHash } from "../packages/core/src/evolution/fingerprints.js";
import { DEFAULT_EVOLUTION_LIMITS } from "../packages/core/src/evolution/schema.js";
import type { PostgresEvolutionPool } from "../packages/core/src/evolution/postgres-common.js";
import type { EvolutionApplyContext, EvolutionJson, EvolutionStagedEvidence } from "../packages/core/src/evolution/types.js";

function sqlFixture() {
  let now = 1000;
  let state = new Map<string, Record<string, unknown>>(), receipts = new Map<string, Record<string, unknown>>();
  let tail: Promise<void> = Promise.resolve();
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const query = vi.fn(async (sql: string, p: readonly unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> => {
    calls.push({ sql, params: p });
    const rows = [...state.values()].filter(r => r.owner_key === p[0] && r.scope_fingerprint === p[1]);
    const receiptRows = [...receipts.values()].filter(r => r.owner_key === p[0] && r.scope_fingerprint === p[1]);
    const key = JSON.stringify(p.slice(0, 4));
    if (sql.includes("evolution:attestation-clock")) return { rows: [{ now }] };
    if (sql.includes("evolution:host-state-read")) {
      const wanted = JSON.parse(String(p[2])) as { kind: string; entry_id: string }[];
      return { rows: structuredClone(rows.filter(r => wanted.some(w => w.kind === r.kind && w.entry_id === r.entry_id))) };
    }
    if (sql.includes("evolution:host-state-list")) return { rows: structuredClone(rows.filter(r => r.kind === p[2]).sort((a, b) => String(a.entry_id).localeCompare(String(b.entry_id)))) };
    if (sql.includes("evolution:host-state-lock")) return { rows: structuredClone(rows.filter(r => r.kind === p[2] && r.entry_id === p[3])) };
    if (sql.includes("evolution:host-state-quota")) return { rows: [{ entries: rows.filter(r => r.kind === p[2]).length, receipts: receiptRows.length }] };
    if (sql.includes("evolution:host-receipt-key")) return { rows: structuredClone(receiptRows.filter(r => r.kind === p[2] && r.idempotency_key === p[3])) };
    if (sql.includes("evolution:host-receipt-read") || sql.includes("evolution:host-administrative-lock")) return { rows: structuredClone(receiptRows.filter(r => r.receipt_id === p[2])) };
    if (sql.includes("evolution:host-state-save")) {
      state.set(key, { owner_key: p[0], scope_fingerprint: p[1], kind: p[2], entry_id: p[3], revision: p[4], value: JSON.parse(String(p[5])), value_hash: p[6], updated_at: p[7], expires_at: p[8], revoked_at: p[9] });
      return { rows: [{ revision: p[4] }] };
    }
    if (sql.includes("evolution:host-receipt-save")) receipts.set(key, { owner_key: p[0], scope_fingerprint: p[1], kind: p[2], idempotency_key: p[3], request_hash: p[4], receipt_id: p[5], receipt: JSON.parse(String(p[6])), created_at: p[7] });
    if (sql.includes("evolution:host-administrative-consume")) {
      const row = receiptRows.find(r => r.receipt_id === p[2]);
      if (row && (row.consumed_by == null || row.consumed_by === p[3])) { row.consumed_by = p[3]; return { rows: [{ receipt_id: row.receipt_id }] }; }
    }
    return { rows: [] };
  });
  const connect = vi.fn(async () => {
    let releaseLock = () => {};
    let backup: { state: typeof state; receipts: typeof receipts } | undefined;
    const transactionQuery = async (sql: string, p?: readonly unknown[]) => {
      if (sql === "BEGIN") {
        const prior = tail; tail = new Promise(resolve => { releaseLock = resolve; }); await prior;
        backup = { state: structuredClone(state), receipts: structuredClone(receipts) };
      }
      const result = await query(sql, p);
      if (sql === "ROLLBACK" && backup) { state = backup.state; receipts = backup.receipts; }
      if (sql === "COMMIT" || sql === "ROLLBACK") releaseLock();
      return result;
    };
    return { query: transactionQuery, release: vi.fn() };
  });
  const pool = { query, connect } as unknown as PostgresEvolutionPool;
  const actor = { tenantId: scope.tenantId, userId: scope.userId, actorId: "owner", authentication: "authenticated_owner" as const };
  const options = { pool, authority, scope, authorizeOwner: () => actor, now: () => now };
  const store = createPostgresEvolutionHostState(options);
  return { store, pool, options, query, connect, calls, actor, setNow: (at: number) => { now = at; } };
}
const mutation = { kind: "reuse_grants" as const, id: "grants", expectedRevision: 0, idempotencyKey: "request", value: { grants: [] } };
function undoApproval(scopeFingerprint: string) {
  const value = { operation: "undo_governance" as const, scopeFingerprint,
    target: { operationReceiptId: "a".repeat(64), currentStateHash: "b".repeat(64) }, idempotencyKey: "undo-operation" };
  return { kind: "governance_undo" as const, id: "undo-approval", expectedRevision: 0, idempotencyKey: "owner-undo-approval", expiresAt: 2000, value };
}

describe("durable host-only evolution control state", () => {
  it("requires an independently authenticated owner before a state mutation", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const connect = vi.fn(async () => ({ query, release: vi.fn() }));
    const store = createPostgresEvolutionHostState({ pool: { query, connect } as never, authority, scope, authorizeOwner: () => { throw new Error("owner authentication required"); } });
    await expect(store.put({ kind: "reuse_grants", id: "grants", expectedRevision: 0, idempotencyKey: "request", value: { grants: [] } })).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });
  it("persists CAS state and immutable idempotent receipts across factory instances", async () => {
    const t = sqlFixture();
    const saved = await t.store.put(mutation);
    const restarted = createPostgresEvolutionHostState(t.options);
    expect(await restarted.read({ kind: "reuse_grants", id: "grants" })).toMatchObject({ revision: 1, value: { grants: [] } });
    t.setNow(1200);
    expect(await restarted.put(mutation)).toEqual(saved);
    expect(await restarted.getReceipt(saved.id)).toEqual(saved);
    await expect(restarted.put({ ...mutation, value: { grants: ["different"] } })).rejects.toThrow("host_state_idempotency_conflict");
    await expect(restarted.put({ ...mutation, idempotencyKey: "stale" })).rejects.toThrow("host_state_cas_conflict");
  });
  it("allows only one concurrent CAS and changes the observable revision on revocation", async () => {
    const t = sqlFixture(); await t.store.put(mutation);
    const before = await t.store.list("reuse_grants");
    const results = await Promise.allSettled([
      t.store.put({ ...mutation, expectedRevision: 1, idempotencyKey: "a", operation: "revoke" }),
      createPostgresEvolutionHostState(t.options).put({ ...mutation, expectedRevision: 1, idempotencyKey: "b" }),
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    const after = await t.store.list("reuse_grants");
    expect(after.revision).not.toBe(before.revision);
    expect(after.entries[0]).toMatchObject({ revokedAt: 1000, revision: 2 });
    expect(t.calls.some(c => c.sql.includes("pg_advisory_xact_lock"))).toBe(true);
  });
  it("rejects foreign owner/control state and cannot use stored authority as a new root", async () => {
    const t = sqlFixture(); await t.store.put(mutation);
    const other = createPostgresEvolutionHostState({ ...t.options, authority: { ...authority, userId: "other" }, scope: { ...scope, userId: "other" } });
    expect(await other.read({ kind: "reuse_grants", id: "grants" })).toBeUndefined();
    await expect(other.put(mutation)).rejects.toThrow("host_state_owner_required");
    await expect(t.store.put({ ...mutation, value: { authority: { allow: "all" } } })).rejects.toThrow("host_state_content_forbidden");
    await expect(t.store.put({ ...mutation, value: { targetScope: { ...scope, userId: "other" } } })).rejects.toThrow();
    expect(() => createPostgresEvolutionHostState({ ...t.options, scope: { ...scope, appId: "outside" } })).toThrow();
  });
  it.each(["actor", "scope", "revision", "requestHash"])("rejects injected %s request fields before opening a transaction", async field => {
    const t = sqlFixture();
    await expect(t.store.put({ ...mutation, [field]: "forged" })).rejects.toThrow("host_state_request_invalid");
    expect(t.connect).not.toHaveBeenCalled();
  });
  it("bounds values/keys and preserves old state after an invalid expiry", async () => {
    const t = sqlFixture(); await t.store.put(mutation);
    await expect(t.store.put({ ...mutation, expectedRevision: 1, idempotencyKey: "expired", expiresAt: 999 })).rejects.toThrow("host_state_expiry_invalid");
    expect((await t.store.read({ kind: "reuse_grants", id: "grants" }))?.revision).toBe(1);
    await expect(t.store.put({ ...mutation, value: { body: "whole source" } })).rejects.toThrow("host_state_content_forbidden");
    await expect(t.store.readMany([{ kind: "reuse_grants", id: "grants" }], { maxRecords: 0, maxBytes: 100 })).rejects.toThrow("host_state_read_budget");
    await expect(t.store.put({ ...mutation, id: "');DROP TABLE x;--" })).rejects.toThrow("host_state_id_invalid");
  });
  it("never issues a successful receipt for an update that lost the SQL CAS", async () => {
    const t = sqlFixture();
    const query = t.query.getMockImplementation()!;
    t.query.mockImplementation((sql, params) => sql.includes("evolution:host-state-save") ? Promise.resolve({ rows: [] }) : query(sql, params));
    await expect(t.store.put(mutation)).rejects.toThrow("host_state_cas_conflict");
    expect(t.calls.some(c => c.sql.includes("host-receipt-save"))).toBe(false);
  });
  it.each([null, "not metadata", 1])("rejects non-object host metadata before the database: %s", async value => {
    const t = sqlFixture();
    await expect(t.store.put({ ...mutation, value })).rejects.toThrow("host_state_value_invalid");
    expect(t.connect).not.toHaveBeenCalled();
  });
  it("claims a holdout once per owner even under parallel execution, renamed aliases or a different allowed app", async () => {
    const t = sqlFixture(); const input = { planHash: "a".repeat(64), holdoutHash: "b".repeat(64), holdoutRef: "holdout", sourceScope: scope };
    const claimed = await Promise.all([t.store.claimHoldout(input), createPostgresEvolutionHostState(t.options).claimHoldout(input)]);
    expect(claimed.sort()).toEqual([false, true]);
    expect(await t.store.claimHoldout({ ...input, holdoutRef: "renamed", planHash: "c".repeat(64) })).toBe(false);
    const otherScope = { ...scope, appId: "second" };
    const other = createPostgresEvolutionHostState({ ...t.options, scope: otherScope, authority: { ...authority, allow: { ...authority.allow, appIds: [scope.appId, "second"] } } });
    expect(await other.claimHoldout({ ...input, sourceScope: otherScope })).toBe(false);
    await expect(t.store.put({ ...mutation, kind: "paired_holdout" } as never)).rejects.toThrow("host_state_kind_invalid");
  });
  it("locks the current transaction control domain without connecting or committing another transaction", async () => {
    const t = sqlFixture(); await t.store.put(mutation); t.connect.mockClear();
    const read = await t.store.readManyLocked(t.pool, [{ kind: "reuse_grants", id: "grants" }], { maxRecords: 1, maxBytes: 32768 });
    expect(read.entries[0].revision).toBe(1);
    expect(t.connect).not.toHaveBeenCalled();
    expect(t.calls.at(-1)?.sql).toContain("FOR UPDATE OF s");
    expect(t.calls.at(-2)?.sql).toContain("pg_advisory_xact_lock");
  });
  it("requires a distinct exact source-revoke administrative receipt and consumes it on the supplied transaction", async () => {
    const t = sqlFixture();
    const binding = { operation: "source_revoke" as const, scopeFingerprint: t.store.scopeFingerprint, target: { sourceId: "source", revision: "source-revision" }, idempotencyKey: "revoke-operation" };
    const receipt = await t.store.put({ kind: "source_revocation", id: "source", value: binding, expectedRevision: 0, idempotencyKey: "owner-approval", expiresAt: 2000 });
    const request = { ...binding, bindingHash: evolutionHash(binding), reviewReceiptId: receipt.id };
    t.connect.mockClear();
    await t.store.administrativeReviewGuard(t.pool, request);
    await t.store.administrativeReviewGuard(t.pool, request);
    expect(t.connect).not.toHaveBeenCalled();
    await expect(t.store.administrativeReviewGuard(t.pool, { ...request, target: { sourceId: "different", revision: "source-revision" } })).rejects.toThrow("host_state_administrative_review_mismatch");
    const ordinary = await t.store.put(mutation);
    await expect(t.store.administrativeReviewGuard(t.pool, { ...request, reviewReceiptId: ordinary.id })).rejects.toThrow("host_state_administrative_review_mismatch");
    t.setNow(2001);
    await expect(t.store.administrativeReviewGuard(t.pool, request)).rejects.toThrow("host_state_administrative_review_mismatch");
  });
  it("mints exact owner undo approval and rolls back or commits consumption on the caller's client across restart", async () => {
    const t = sqlFixture(), approval = undoApproval(t.store.scopeFingerprint), receipt = await t.store.put(approval);
    const restarted = createPostgresEvolutionHostState(t.options);
    expect(receipt).toMatchObject({ kind: "governance_undo", operation: "put", actor: t.actor });
    expect(await restarted.put(approval)).toEqual(receipt);
    expect((await restarted.list("governance_undo")).entries[0]).toMatchObject({ value: approval.value, revision: 1 });
    const request = { ...approval.value, reviewReceiptId: receipt.id, bindingHash: evolutionHash(approval.value) };
    const client = await t.pool.connect();
    try {
      await client.query("BEGIN"); t.connect.mockClear();
      await restarted.administrativeReviewGuard(client, request);
      expect(t.connect).not.toHaveBeenCalled();
      expect(t.calls.at(-3)?.sql).toContain("FOR UPDATE");
      expect(t.calls.at(-2)?.sql).toContain("FOR UPDATE");
      expect(t.calls.at(-1)?.sql).toContain("evolution:host-administrative-consume");
      await client.query("ROLLBACK");
      const inspect = () => t.pool.query("/* evolution:host-administrative-lock */ SELECT consumed_by", [receipt.ownerKey, receipt.scopeFingerprint, receipt.id]);
      expect((await inspect()).rows[0]?.consumed_by).toBeUndefined();
      await client.query("BEGIN");
      await restarted.administrativeReviewGuard(client, request);
      await restarted.administrativeReviewGuard(client, request);
      await client.query("COMMIT");
      expect((await inspect()).rows[0]?.consumed_by).toBe(request.bindingHash);
      expect(await restarted.getReceipt(receipt.id)).toEqual(receipt);
    } finally { client.release(); }
  });
  it.each(["target", "operation_receipt", "idempotency", "binding_hash", "source_receipt", "expired", "revoked", "new_revision", "consumed_other"])("undo approval rejects %s without consuming it", async mode => {
    const t = sqlFixture(), approval = undoApproval(t.store.scopeFingerprint);
    const receipt = await t.store.put(approval);
    const request = { ...approval.value, reviewReceiptId: receipt.id, bindingHash: evolutionHash(approval.value) };
    if (mode === "target") request.target = { ...request.target, currentStateHash: "c".repeat(64) };
    if (mode === "operation_receipt") request.target = { ...request.target, operationReceiptId: "c".repeat(64) };
    if (mode === "idempotency") request.idempotencyKey = "another-undo-operation";
    if (mode === "binding_hash") request.bindingHash = "c".repeat(64);
    if (mode === "source_receipt") request.reviewReceiptId = (await t.store.put({ ...approval, kind: "source_revocation" })).id;
    if (mode === "expired") t.setNow(2000);
    if (mode === "revoked" || mode === "new_revision") await t.store.put({ ...approval, expectedRevision: 1, idempotencyKey: "owner-change",
      ...(mode === "revoked" ? { operation: "revoke" as const } : {}) });
    if (mode === "consumed_other") await t.pool.query("/* evolution:host-administrative-consume */ UPDATE receipt", [receipt.ownerKey, receipt.scopeFingerprint, receipt.id, "c".repeat(64)]);
    t.calls.length = 0;
    await expect(t.store.administrativeReviewGuard(t.pool, request)).rejects.toThrow("host_state_administrative_review_mismatch");
    expect(t.calls.some(c => c.sql.includes("evolution:host-administrative-consume"))).toBe(false);
  });
  it("undo approval rejects unsigned owner assertions, other owners and non-undo JSON before SQL", async () => {
    const t = sqlFixture(), approval = undoApproval(t.store.scopeFingerprint);
    const hostTask = createPostgresEvolutionHostState({ ...t.options, authorizeOwner: () => ({ ...t.actor, authentication: "host_task" } as never) });
    await expect(hostTask.put(approval)).rejects.toThrow("host_state_owner_required");
    const otherOwner = createPostgresEvolutionHostState({ ...t.options, authorizeOwner: () => ({ ...t.actor, userId: "different" }) });
    await expect(otherOwner.put(approval)).rejects.toThrow("host_state_owner_required");
    const invalid: EvolutionJson[] = [
      { ...approval.value, operation: "source_revoke" },
      { ...approval.value, target: { ...approval.value.target, sourceId: "source" } },
      { ...approval.value, target: { operationReceiptId: "not-a-hash", currentStateHash: "b".repeat(64) } },
      { ...approval.value, result: { status: "passed" } },
      { status: "approved", memoryIds: ["any"] },
    ];
    for (const value of invalid) await expect(t.store.put({ ...approval, value })).rejects.toThrow();
    await expect(t.store.put({ ...approval, expiresAt: undefined })).rejects.toThrow("host_state_undo_approval_expiry_invalid");
    await expect(t.store.put({ ...approval, expiresAt: 1000 + 86_400_001 })).rejects.toThrow("host_state_undo_approval_expiry_invalid");
    expect(t.connect).not.toHaveBeenCalled();
  });
  it("persists skill_draft_gate metadata with the same owner CAS, replay and revoke contract", async () => {
    const t = sqlFixture();
    const gate = { kind: "skill_draft_gate" as const, id: "draft", expectedRevision: 0, idempotencyKey: "draft-approved", expiresAt: 2000,
      value: { patternId: "pattern", candidateHash: "a".repeat(64), targetFingerprint: "b".repeat(64), evaluationId: "evaluation" } };
    const receipt = await t.store.put(gate);
    expect(receipt).toMatchObject({ kind: "skill_draft_gate", revision: 1, actor: t.actor });
    const restarted = createPostgresEvolutionHostState(t.options);
    const key = { kind: gate.kind, id: gate.id };
    expect(await restarted.put(gate)).toEqual(receipt);
    expect(await restarted.getReceipt(receipt.id)).toEqual(receipt);
    expect(await restarted.read(key)).toMatchObject({ kind: gate.kind, revision: 1, value: gate.value });
    expect((await restarted.list(gate.kind)).entries).toHaveLength(1);
    const locked = await restarted.readManyLocked(t.pool, [key], { maxRecords: 1, maxBytes: 32768 });
    expect(locked.entries[0].revision).toBe(1);
    await expect(restarted.put({ ...gate, value: { ...gate.value, evaluationId: "changed" } })).rejects.toThrow("host_state_idempotency_conflict");
    await expect(restarted.put({ ...gate, idempotencyKey: "stale" })).rejects.toThrow("host_state_cas_conflict");
    await restarted.put({ ...gate, operation: "revoke", expectedRevision: 1, idempotencyKey: "draft-revoked" });
    expect(await restarted.read(key)).toMatchObject({ revision: 2, revokedAt: 1000 });
  });
  it("isolates skill_draft_gate receipts from source revocations and rejects unapproved kind spellings", async () => {
    const t = sqlFixture();
    const binding = { operation: "source_revoke" as const, scopeFingerprint: t.store.scopeFingerprint, target: { sourceId: "source", revision: "r1" }, idempotencyKey: "source-operation" };
    const gate = { kind: "skill_draft_gate" as const, id: "same-id", expectedRevision: 0, idempotencyKey: "same-key", expiresAt: 2000, value: binding };
    const receipt = await t.store.put(gate);
    const sourceReceipt = await t.store.put({ ...gate, kind: "source_revocation" });
    expect(receipt.id).not.toBe(sourceReceipt.id);
    expect((await t.store.list("skill_draft_gate")).entries.map(e => e.kind)).toEqual(["skill_draft_gate"]);
    await expect(t.store.administrativeReviewGuard(t.pool, { ...binding, bindingHash: evolutionHash(binding), reviewReceiptId: receipt.id })).rejects.toThrow("host_state_administrative_review_mismatch");
    t.connect.mockClear(); t.query.mockClear();
    await expect(t.store.put({ ...gate, kind: "skill-draft-gate" } as never)).rejects.toThrow("host_state_kind_invalid");
    await expect(t.store.list("skill_draft_gate_unapproved" as never)).rejects.toThrow("host_state_kind_invalid");
    expect(t.connect).not.toHaveBeenCalled(); expect(t.query).not.toHaveBeenCalled();
  });
  it("composes durable state, signed input and caller-transaction guards across restart and source revocation", async () => {
    const t = sqlFixture(), keys = generateKeyPairSync("ed25519"), source = unit();
    source.evidence[0].trust = "untrusted";
    const e = source.evidence[0];
    const statement: EvolutionAttestationStatement = { issuer: "verifier", scopeFingerprint: t.store.scopeFingerprint, evidenceId: e.id, sourceId: e.sourceId, revision: e.revision, snapshotHash: e.snapshotHash, rootEvidenceId: e.rootEvidenceId, origin: "external", trust: "verified_document", authorizedTargetRefs: [], issuedAt: 1000, expiresAt: 2000 };
    const trustedIssuers = [{ id: "verifier", publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString() }];
    const service = createEvolutionAttestation({ state: t.store, trustedIssuers, now: t.options.now });
    const request = { statement, signature: sign(null, evolutionAttestationSigningPayload(statement), keys.privateKey).toString("base64url"), expectedRevision: 0, idempotencyKey: "issue" };
    const issued = await service.control.issue(request);
    const restartedState = createPostgresEvolutionHostState(t.options);
    const restarted = createEvolutionAttestation({ state: restartedState, trustedIssuers, now: t.options.now });
    expect(await restarted.control.issue(request)).toEqual(issued);
    expect(await restartedState.getReceipt(issued.id)).toEqual(issued);
    const input = new AttestedEvolutionInput(inputPort([source]), restarted.port, t.options.now);
    const context = { input: { mode: "inventory" as const, selection: "baseline" as const }, scope, limits: DEFAULT_EVOLUTION_LIMITS };
    const page = await input.readPage({ ...context, snapshot: await input.open(context), cursor: null, limit: 1 });
    expect(page.units[0].evidence[0]).toMatchObject({ trust: "verified_document", rootEvidenceId: e.rootEvidenceId });
    expect(page.recordsRead).toBe(5);
    expect(page.bytesRead).toBeGreaterThan(Buffer.byteLength(e.text));
    expect(await input.verifyUnit(page.units[0], context)).toMatchObject({ valid: true });
    const { text, ...attested } = page.units[0].evidence[0];
    const span: EvolutionStagedEvidence = { ...attested, quote: text, start: 0, end: text.length };
    const apply = { evidence: [span], proposal: { scope, scopeFingerprint: t.store.scopeFingerprint } } as EvolutionApplyContext;
    const client = await t.pool.connect();
    await client.query("BEGIN");
    t.connect.mockClear();
    try {
      expect(await restarted.assertApplyInTransaction(client, apply, context)).toMatchObject({ recordsRead: 3, bytesRead: expect.any(Number) });
      expect(t.connect).not.toHaveBeenCalled();
      expect(t.calls.at(-2)?.sql).toContain("FOR UPDATE OF s");
      expect(t.calls.at(-3)?.sql).toContain("pg_advisory_xact_lock");
    } finally { await client.query("ROLLBACK"); client.release(); }
    await service.control.revokeSource({ sourceId: e.sourceId, sourceRevision: e.revision, expectedRevision: 0, idempotencyKey: "owner-revoke", operationIdempotencyKey: "provider-revoke", expiresAt: 1500 });
    expect(await input.verifyUnit(page.units[0], context)).toMatchObject({ valid: false });
    t.connect.mockClear();
    await expect(restarted.assertApplyInTransaction(t.pool, apply, context)).rejects.toThrow("attestation_revoked_or_changed");
    expect(t.connect).not.toHaveBeenCalled();
    const unsigned = createEvolutionAttestation({ state: restartedState, trustedIssuers: [], now: t.options.now });
    const { hostAttestation: _hostAttestation, ...untrusted } = span;
    t.query.mockClear();
    await expect(unsigned.assertApplyInTransaction(t.pool, { ...apply, evidence: [{ ...untrusted, trust: "untrusted" }] }, context)).resolves.toEqual({ recordsRead: 0, bytesRead: 0 });
    expect(t.query).not.toHaveBeenCalled();
  });
});
