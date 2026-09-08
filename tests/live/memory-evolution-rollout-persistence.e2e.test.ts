import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { PostgresEvolutionBudgetLedger } from "../../packages/core/src/evolution/postgres-budget.js";
import { PostgresEvolutionMaintenancePort } from "../../packages/core/src/evolution/postgres-maintenance.js";
import { appendEvolutionMutationEvent, writeEvolutionLink } from "../../packages/core/src/evolution/governed-metadata.js";
import { authorityScopeFingerprint } from "../../packages/core/src/domain/authority-scope-fingerprint.js";
import { evolutionHash, evolutionInputFingerprint } from "../../packages/core/src/evolution/fingerprints.js";
import { stageEvolutionEvidence, validateEvolutionProposal } from "../../packages/core/src/evolution/proposal-validation.js";
import { EVOLUTION_POLICY_VERSION } from "../../packages/core/src/evolution/schema.js";
import type { EvolutionInputUnit, EvolutionProposal, EvolutionProposalDraft } from "../../packages/core/src/evolution/types.js";
import { computeCanonicalContentHash } from "../../packages/core/src/scoring/hash-utils.js";
import { PG_ROLLOUT_CONFIG, openPostgresRollout, pgMetadataDraft, prepareMetadataReview, type PostgresRollout } from "../fixtures/memory-evolution-rollout/postgres.js";
import { ROLLOUT_AUTHORITY } from "../fixtures/memory-evolution-rollout/source-corpus.js";

const enabled = process.env.MENGSHU_RUN_LIVE_TESTS === "1";
const budget = { maxRecords: 80, maxBytes: 524_288 };

async function row(h: PostgresRollout, id: string) {
  return (await h.pool.query(`SELECT id::text, text, content_hash, metadata, lifecycle_status, revision,
    valid_to, evolution_alias_of::text, evolution_disputed, evolution_review_due_at FROM memories WHERE id=$1`, [id])).rows[0];
}

async function writes(h: PostgresRollout) {
  const receipts = (await h.pool.query("SELECT * FROM mengshu_evolution_apply_receipts ORDER BY proposal_id")).rows;
  const operations = (await h.pool.query("SELECT * FROM mengshu_evolution_operation_receipts ORDER BY idempotency_key")).rows;
  const audit = (await h.pool.query("SELECT * FROM mengshu_write_audit ORDER BY storage_key")).rows;
  const outbox = (await h.pool.query("SELECT * FROM mengshu_write_outbox ORDER BY event_id")).rows;
  return { receipts, operations, audit, outbox };
}

// A synthetic noop proposal is not a model result. Stage/processed/selection proof use actual PG repositories.
async function selectionProof(h: PostgresRollout, unit: EvolutionInputUnit) {
  const { batch, lease } = await h.lease();
  try {
    const draft: EvolutionProposalDraft = { operation: "noop", claimClass: "fact", reasonCode: "unchanged",
      targetRefs: unit.targets.map(({ memoryId, expectedRevision, beforeHash }) => ({ memoryId, expectedRevision, beforeHash })), quotes: [] };
    const proposal: EvolutionProposal = { ...draft, id: randomUUID(), batchId: batch.id, scope: h.scope,
      scopeFingerprint: h.scopeFingerprint, inputUnitId: unit.id, sourceSnapshotHash: unit.snapshotHash,
      inputFingerprint: evolutionInputFingerprint(unit, PG_ROLLOUT_CONFIG, EVOLUTION_POLICY_VERSION),
      configFingerprint: PG_ROLLOUT_CONFIG, policyVersion: EVOLUTION_POLICY_VERSION, createdAt: Date.now(),
      status: "noop", validation: validateEvolutionProposal(draft, unit, h.scope) };
    await h.persistence.repository.stageProposal(proposal, stageEvolutionEvidence(proposal, unit), lease);
    await h.persistence.repository.recordProcessed({ scopeFingerprint: h.scopeFingerprint, inputFingerprint: proposal.inputFingerprint,
      action: "propose", proposalId: proposal.id, processedAt: Date.now() }, lease);
    return { proposalId: proposal.id };
  } finally { await h.persistence.repository.releaseLease(lease); }
}

describe.skipIf(!enabled)("rollout: actual isolated PostgreSQL metadata, selectors, budgets and retention; no model", () => {
  test("native related-target discovery follows an effective exact-scope relation, preserves inventory bindings, and rejects revoked or outside evidence", async () => {
    const h = await openPostgresRollout();
    try {
      const text = "The synthetic related-target claim has one original source.";
      const sourceId = "synthetic-related-source";
      const seed = await h.seed(text, { sourceId });
      const outsideScope = { ...h.scope, userId: "outside-related-owner" };
      const outside = await h.seed(text, { sourceId, scope: outsideScope });
      const foreign = h.provider.createEvolutionPersistence(outsideScope);
      const [raw] = await h.persistence.inventory.hydrateEvidence(h.scope, [seed.rawId]);
      const [foreignRaw] = await foreign.inventory.hydrateEvidence(outsideScope, [outside.rawId]);
      expect(raw.trust).toBe("untrusted");
      // Synthetic persisted relation fixtures only: no model, author proof, or content-apply claim.
      for (const fixture of [
        { scope: h.scope, persistence: h.persistence, seed, raw },
        { scope: outsideScope, persistence: foreign, seed: outside, raw: foreignRaw },
      ]) {
        await fixture.persistence.repository.mutation(client => writeEvolutionLink(client, {
          scope: fixture.scope, scopeFingerprint: authorityScopeFingerprint(fixture.scope), memoryId: fixture.seed.id,
          evidenceId: fixture.seed.rawId, sourceId, sourceRecordId: fixture.raw.id, sourceRevision: fixture.raw.revision,
          sourceHash: fixture.raw.snapshotHash, rootId: fixture.raw.rootEvidenceId, state: "effective",
          sourceKind: "verified_document", now: Date.now(),
        }));
      }
      const before = await row(h, seed.id);
      expect(before).toMatchObject({ lifecycle_status: "archived", metadata: { admissionRoute: "lookup_only" } });
      const beforeWrites = await writes(h);
      const originalRaw = structuredClone(raw);
      const request = { scope: h.scope, evidence: [raw], limit: 8, maxBytes: 131_072 };
      const found = await h.persistence.relatedTargets.resolve(request);
      expect(found.targets.map(target => target.memoryId)).toEqual([seed.id]);
      expect(found.recordsRead).toBe(1);
      expect(found.bytesRead).toBeGreaterThan(0);
      const target = found.targets[0];
      expect(target).toMatchObject({ scope: h.scope, beforeHash: computeCanonicalContentHash(text),
        governanceHash: expect.stringMatching(/^[a-f0-9]{64}$/), evidenceRootIds: [`canonical:${seed.id}`] });
      const refs = found.targets.map(({ memoryId, expectedRevision, beforeHash }) => ({ memoryId, expectedRevision, beforeHash }));
      expect(await h.persistence.inventory.readTargets(h.scope, refs)).toEqual(found.targets);
      expect(raw).toEqual(originalRaw);
      expect(raw.authorizedTargetIds).toBeUndefined();
      expect(target).not.toHaveProperty("authorizedTargetIds");
      expect(target.evidenceRootIds).not.toContain(raw.rootEvidenceId);
      await expect(h.persistence.relatedTargets.resolve({ ...request, scope: outsideScope })).rejects.toThrow("scope_mismatch");
      await expect(h.persistence.relatedTargets.resolve({ ...request, evidence: [foreignRaw] })).rejects.toThrow("scope_mismatch");
      expect((await foreign.relatedTargets.resolve({ ...request, scope: outsideScope, evidence: [foreignRaw] })).targets.map(item => item.memoryId)).toEqual([outside.id]);
      expect(await h.persistence.relatedTargets.resolve({ ...request, evidence: [{ ...raw, revoked: true }] }))
        .toEqual({ targets: [], recordsRead: 0, bytesRead: 0 });

      // Move only the isolated synthetic relation to its persisted revoked state; this is not an administrative revoke test.
      await h.pool.query("UPDATE mengshu_memory_evidence_links SET relation_state='revoked',retired_at=$3 WHERE scope_fingerprint=$1 AND target_memory_id=$2",
        [h.scopeFingerprint, seed.id, Date.now()]);
      expect((await h.persistence.relatedTargets.resolve(request)).targets).toEqual([]);
      expect((await h.provider.createEvolutionPersistence(h.scope).relatedTargets.resolve(request)).targets).toEqual([]);
      expect(await row(h, seed.id)).toEqual(before);
      expect(await writes(h)).toEqual(beforeWrites);
      expect(await h.persistence.inventory.hydrateEvidence(h.scope, [seed.rawId])).toEqual([originalRaw]);
    } finally { await h.close(); }
  }, 120_000);

  test("S01/S20 same-source add_evidence writes only a real noop receipt, never support or confidence", async () => {
    const h = await openPostgresRollout();
    try {
      const seed = await h.seed("The synthetic unchanged claim has only its original evidence.");
      const unit = (await h.persistence.inventory.readPage(h.scope, { selectionEpoch: Date.now(),
        upperKey: { memoryId: seed.id, createdAt: seed.at }, state: { selectedMemoryId: seed.id } }, undefined, 1, budget)).units[0];
      unit.evidence = unit.evidence.filter(item => item.origin === "external");
      const draft = pgMetadataDraft(unit, "add_evidence", Date.now());
      const validation = validateEvolutionProposal(draft, unit, h.scope);
      expect(validation).toMatchObject({ outcome: "noop", reasons: ["no_independent_evidence"], independentEvidenceRootIds: [] });
      const { lease, batch } = await h.lease("apply_allowed");
      const proposal: EvolutionProposal = { ...draft, id: randomUUID(), batchId: batch.id, scope: h.scope, scopeFingerprint: h.scopeFingerprint,
        inputUnitId: unit.id, sourceSnapshotHash: unit.snapshotHash, inputFingerprint: evolutionInputFingerprint(unit, PG_ROLLOUT_CONFIG, EVOLUTION_POLICY_VERSION),
        configFingerprint: PG_ROLLOUT_CONFIG, policyVersion: EVOLUTION_POLICY_VERSION, status: "noop", validation, createdAt: Date.now() };
      const evidence = stageEvolutionEvidence(proposal, unit);
      await h.persistence.repository.stageProposal(proposal, evidence, lease);
      const persistence = h.provider.createEvolutionPersistence(h.scope, { writer: {
        hydrateEvidence: context => h.persistence.inventory.hydrateEvidence(h.scope, context.evidence.map(item => item.id)),
      } });
      const before = await row(h, seed.id);
      const context = { proposal, evidence, lease, authority: ROLLOUT_AUTHORITY,
        verifySource: () => h.persistence.inventory.verifyEvidence(h.scope, unit.evidence) };
      const result = await persistence.writer.apply(context);
      expect(result, JSON.stringify(result)).toMatchObject({ outcome: "noop", replayed: false, receipt: { memoryIds: [seed.id], operation: "add_evidence" } });
      expect(await row(h, seed.id)).toEqual(before);
      const committed = await writes(h);
      expect(committed.receipts).toHaveLength(1);
      expect(committed.operations).toEqual([]);
      expect(committed.audit).toEqual([]);
      expect(committed.outbox).toEqual([]);
      expect((await h.pool.query("SELECT count(*)::int AS n FROM mengshu_memory_evidence_links")).rows[0].n).toBe(0);
      expect(await persistence.writer.apply(context)).toMatchObject({ outcome: "noop", replayed: true });
      expect(await writes(h)).toEqual(committed);
      expect((await h.lookup()).hits.map(hit => hit.record.id)).toContain(seed.id);
      await expect(h.evidenceReader.read(h.scope, [{ ref: seed.rawId, source: "memory" }])).resolves.toMatchObject([{ preview: seed.text }]);
    } finally { await h.close(); }
  }, 120_000);

  test.each(["revalidate", "mark_disputed", "deprecate", "expire"] as const)("reviewed %s commits receipt atomically, preserves raw evidence and replays without writes", async operation => {
    const h = await openPostgresRollout();
    try {
      const seed = await h.seed(`The synthetic ${operation} fixture retains source evidence for 37 days.`);
      expect((await h.lookup()).hits.map(hit => hit.record.id)).toContain(seed.id);
      const hydrated = await h.persistence.inventory.hydrateEvidence(h.scope, [seed.rawId]);
      expect(hydrated).toMatchObject([{ id: seed.rawId, text: seed.text, origin: "external", trust: "untrusted" }]);
      const before = await row(h, seed.id);
      const review = await h.owner(() => prepareMetadataReview(h, [seed], operation));
      expect(review.proposal.status).toBe("review");
      expect(await row(h, seed.id)).toEqual(before);
      expect((await writes(h)).receipts).toEqual([]);
      const applied = await review.service.replayApproved(review.approval.id);
      expect(applied, JSON.stringify(applied)).toMatchObject({ status: "completed", counts: { applied: 1 }, usage: { llmCalls: 0 } });
      const after = await row(h, seed.id);
      expect(after).toMatchObject({ text: before.text, content_hash: before.content_hash, revision: before.revision });
      expect(Number(after.evolution_review_due_at)).toBeGreaterThan(0);
      expect(after.metadata.contextEligible).toBe(false);
      expect(after.metadata.governance.evolution.lastOperationId).toEqual(expect.any(String));
      if (operation === "revalidate") {
        expect(after.metadata.governance.evolution.lastRevalidatedAt).toEqual(expect.any(Number));
        expect((await h.lookup()).hits.map(hit => hit.record.id)).toContain(seed.id);
      } else {
        if (operation === "mark_disputed") expect(after.evolution_disputed).toBe(true);
        else expect(after.valid_to).toBeInstanceOf(Date);
        expect((await h.lookup()).hits.map(hit => hit.record.id)).not.toContain(seed.id);
      }
      expect(await h.persistence.inventory.hydrateEvidence(h.scope, [seed.rawId])).toEqual(hydrated);
      await expect(h.evidenceReader.read(h.scope, [{ ref: seed.rawId, source: "memory" }]))
        .resolves.toMatchObject([{ ref: seed.rawId, preview: seed.text }]);
      await expect(h.evidenceReader.read({ ...h.scope, userId: "foreign-owner" }, [{ ref: seed.rawId, source: "memory" }])).rejects.toThrow();
      const committed = await writes(h);
      expect(committed.receipts).toHaveLength(1);
      expect(committed.operations.filter(item => item.operation === operation)).toHaveLength(1);
      expect(committed.outbox).toHaveLength(1);
      expect(committed.outbox[0].evolution_origin).toBe(true);
      const receipt = committed.receipts[0].receipt;
      expect(receipt).toMatchObject({ batchId: applied.batchId, memoryIds: [seed.id], operation, outcome: "applied" });
      expect((await h.pool.query("SELECT consumed_by_proposal_id FROM mengshu_evolution_reviews WHERE receipt_id=$1", [review.approval.id])).rows)
        .toEqual([{ consumed_by_proposal_id: receipt.proposalId }]);
      expect(await review.service.replayApproved(review.approval.id)).toEqual(applied);
      expect(await writes(h)).toEqual(committed);
      expect(await row(h, seed.id)).toEqual(after);
    } finally { await h.close(); }
  }, 120_000);

  test("reviewed equivalent merge retains aliases/history, does not raise confidence, and is idempotent", async () => {
    const h = await openPostgresRollout();
    try {
      const at = Date.now() - 20_000;
      const text = "The synthetic release requires owner approval when the audit is available.";
      const left = await h.seed(text, { at }), right = await h.seed(text, { at });
      const review = await h.owner(() => prepareMetadataReview(h, [left, right], "merge_equivalent"));
      const result = await review.service.replayApproved(review.approval.id);
      expect(result, JSON.stringify(result)).toMatchObject({ status: "completed", counts: { applied: 1 }, usage: { llmCalls: 0 } });
      const primary = await row(h, left.id), alias = await row(h, right.id);
      expect(alias).toMatchObject({ text, evolution_alias_of: left.id });
      expect(alias.valid_to).toBeInstanceOf(Date);
      expect(primary.metadata.confidence).toBeLessThanOrEqual(0.61);
      expect(primary.metadata.contextEligible).toBe(false);
      expect((await h.lookup()).hits.map(hit => hit.record.id)).toEqual([left.id]);
      const originals = await h.evidenceReader.read(h.scope, [left, right].map(seed => ({ ref: seed.rawId, source: "memory" as const })));
      expect(originals).toHaveLength(2);
      expect(originals.every(item => item.preview === text)).toBe(true);
      const committed = await writes(h);
      expect(committed.operations[0].receipt).toMatchObject({ canonicalId: left.id, aliasIds: [right.id], retainedHistory: true });
      expect(await review.service.replayApproved(review.approval.id)).toEqual(result);
      expect(await writes(h)).toEqual(committed);
    } finally { await h.close(); }
  }, 120_000);

  test("a concurrently changed target invalidates its reviewed snapshot without consuming approval or writing metadata", async () => {
    const h = await openPostgresRollout();
    try {
      const seed = await h.seed("The synthetic old policy requires audit review.");
      const review = await h.owner(() => prepareMetadataReview(h, [seed], "revalidate"));
      // Synthetic competing writer on a separate real connection, after review and before the replay.
      const changed = "The synthetic current policy requires a fresh audit review.";
      await h.pool.query("UPDATE memories SET text=$2,content_hash=$3 WHERE id=$1", [seed.id, changed, computeCanonicalContentHash(changed)]);
      const current = await row(h, seed.id), before = await writes(h);
      const refused = await review.service.replayApproved(review.approval.id);
      expect(refused.status).toBe("blocked");
      expect(refused.counts.applied).toBe(0);
      expect(refused.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/review|source|target|binding/)]));
      expect(await writes(h)).toEqual(before);
      expect(await row(h, seed.id)).toEqual(current);
      expect((await h.pool.query("SELECT consumed_by_proposal_id FROM mengshu_evolution_reviews WHERE receipt_id=$1", [review.approval.id])).rows)
        .toEqual([{ consumed_by_proposal_id: null }]);
    } finally { await h.close(); }
  }, 120_000);

  test("S02 changed selection sees an earlier event committed last; preview/invalid proof cannot consume it", async () => {
    const h = await openPostgresRollout();
    const early = await h.pool.connect();
    try {
      const at = Date.now() - 20_000;
      const first = await h.seed("The synthetic early transaction has its own receipt.", { at });
      const later = await h.seed("The synthetic later transaction commits first.", { at });
      await early.query("BEGIN");
      await appendEvolutionMutationEvent(early, h.scope, first.id, randomUUID(), at, false);
      await h.persistence.repository.mutation(client => appendEvolutionMutationEvent(client, h.scope, later.id, randomUUID(), at + 1, false));
      const inventory = h.persistence.inventory;
      const snapshot = await inventory.freeze(h.scope, "changed", 80);
      const page = await inventory.readSelectedPage(h.scope, snapshot, null, 1, budget);
      expect(page.units.map(unit => unit.targets[0].memoryId)).toEqual([later.id]);
      const before = await writes(h);
      await inventory.acknowledgeSelection(h.scope, snapshot, page.nextCursor, "preview");
      await expect(inventory.acknowledgeSelection(h.scope, snapshot, page.nextCursor, "propose")).rejects.toThrow("SELECTION_PROOF_REQUIRED");
      expect(await writes(h)).toEqual(before);
      const proof = await selectionProof(h, page.units[0]);
      await inventory.acknowledgeSelection(h.scope, snapshot, page.nextCursor, "propose", proof);
      await inventory.acknowledgeSelection(h.scope, snapshot, page.nextCursor, "propose", proof);
      await early.query("COMMIT");
      const next = await inventory.freeze(h.scope, "changed", 80);
      const nextPage = await inventory.readSelectedPage(h.scope, next, null, 1, budget);
      expect(nextPage.units.map(unit => unit.targets[0].memoryId)).toEqual([first.id]);
      expect(nextPage.units[0].selectionEvent?.eventId).not.toBe(page.units[0].selectionEvent?.eventId);
      const nextProof = await selectionProof(h, nextPage.units[0]);
      await inventory.acknowledgeSelection(h.scope, next, nextPage.nextCursor, "propose", nextProof);
      await h.persistence.repository.mutation(client => appendEvolutionMutationEvent(client, h.scope, later.id, randomUUID(), Date.now(), true));
      // Query popularity is deliberately not a semantic write event.
      await h.pool.query("UPDATE memories SET metadata=jsonb_set(metadata,'{queryHits}','900'::jsonb) WHERE id=$1", [later.id]);
      const empty = await inventory.freeze(h.scope, "changed", 80);
      expect(await inventory.readSelectedPage(h.scope, empty, null, 1, budget)).toMatchObject({ units: [], complete: true });
      expect((await writes(h)).receipts).toEqual([]);
    } finally { await early.query("ROLLBACK"); early.release(); await h.close(); }
  }, 120_000);

  test("S02/E3-MAINT due and baseline ties are stable; drift retains cursor; due acknowledgement requires durable proof", async () => {
    const h = await openPostgresRollout();
    try {
      const at = Date.now() - 20_000;
      const seeds = [];
      for (const label of ["A", "B", "C"]) seeds.push(await h.seed(`The synthetic tie ${label} has a distinct original record.`, { at }));
      const inventory = h.persistence.inventory;
      const baseline = await inventory.freeze(h.scope, "baseline", 80);
      const seen: string[] = [];
      let after;
      for (let index = 0; index < 4; index++) {
        const page = await inventory.readPage(h.scope, baseline, after, 1, budget);
        seen.push(...page.units.map(unit => unit.targets[0].memoryId));
        if (page.complete) break;
        const last = page.units[0].targets[0];
        after = { createdAt: last.createdAt, memoryId: last.memoryId };
      }
      expect(seen).toEqual(seeds.map(seed => seed.id).sort());
      await h.pool.query("UPDATE memories SET evolution_review_due_at=$2 WHERE id::text=ANY($1::text[])", [seeds.map(seed => seed.id), Date.now() + 86_400_000]);
      await h.pool.query("UPDATE memories SET evolution_review_due_at=$2 WHERE id::text=ANY($1::text[])", [[seeds[0].id, seeds[1].id], at]);
      const frozen = await inventory.freeze(h.scope, "due", 80);
      const due = await inventory.readSelectedPage(h.scope, frozen, null, 1, budget);
      expect(due.units).toHaveLength(1);
      expect(due.units[0].targets[0].memoryId).toBe([seeds[0].id, seeds[1].id].sort()[0]);
      const proof = await selectionProof(h, due.units[0]);
      await expect(inventory.acknowledgeSelection(h.scope, frozen, due.nextCursor, "apply_allowed", proof)).rejects.toThrow("SELECTION_PROOF_MISSING");
      expect(Number((await row(h, due.units[0].targets[0].memoryId)).evolution_review_due_at)).toBe(at);
      await inventory.acknowledgeSelection(h.scope, frozen, due.nextCursor, "propose", proof);
      expect(Number((await row(h, due.units[0].targets[0].memoryId)).evolution_review_due_at)).toBeGreaterThan(Date.now());
      const remaining = seeds.slice(0, 2).find(seed => seed.id !== due.units[0].targets[0].memoryId)!;
      const next = await inventory.freeze(h.scope, "due", 80);
      await h.pool.query("UPDATE memories SET text=$2,content_hash=$3 WHERE id=$1", [remaining.id, "Synthetic concurrent due edit.", computeCanonicalContentHash("Synthetic concurrent due edit.")]);
      expect(await inventory.readSelectedPage(h.scope, next, null, 1, budget))
        .toMatchObject({ units: [], nextCursor: null, complete: false, reasons: ["inventory_selection_changed"] });
      expect(Number((await row(h, remaining.id)).evolution_review_due_at)).toBe(at);
    } finally { await h.close(); }
  }, 120_000);

  test("owner-wide budget reservations serialize across project scopes, keep uncertain expiry charged, and settle idempotently", async () => {
    const h = await openPostgresRollout();
    try {
      const other = h.provider.createEvolutionPersistence({ ...h.scope, projectId: "another-synthetic-project" });
      const owner = { tenantId: h.scope.tenantId, userId: h.scope.userId };
      const a = new PostgresEvolutionBudgetLedger({ pool: h.persistence.repository.pool, owner });
      const b = new PostgresEvolutionBudgetLedger({ pool: other.repository.pool, owner });
      const limits = { tokens: 100, costMicros: 1000 };
      const request = { tokens: 60, costMicros: 600, limits, ttlMs: 1 };
      const reservations = await Promise.all([a.reserve({ ...request, idempotencyKey: "scope-a" }), b.reserve({ ...request, idempotencyKey: "scope-b" })]);
      expect(reservations.filter(Boolean)).toHaveLength(1);
      const index = reservations[0] ? 0 : 1, winning = reservations[index]!;
      const key = index === 0 ? "scope-a" : "scope-b";
      expect(await b.reserve({ ...request, idempotencyKey: key })).toEqual(winning);
      await expect(a.reserve({ ...request, idempotencyKey: key, tokens: 61 })).rejects.toThrow("BUDGET_IDEMPOTENCY_CONFLICT");
      // Let the real one-millisecond TTL expire without violating the table's expiry CHECK.
      await h.pool.query("SELECT pg_sleep(0.01)");
      expect((await h.pool.query(`SELECT expires_at > created_at AS valid_ttl,
        expires_at < floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS expired
        FROM mengshu_evolution_budget_reservations WHERE reservation_id=$1`, [winning.reservationId])).rows)
        .toEqual([{ valid_ttl: true, expired: true }]);
      expect(await b.reserve({ ...request, idempotencyKey: "expired-retry" })).toBeUndefined();
      const settlement = { reservationId: winning.reservationId, dayKey: winning.dayKey, tokens: 20, costMicros: 200 };
      await a.settle(settlement);
      await b.settle(settlement);
      await expect(a.settle({ ...settlement, tokens: 21 })).rejects.toThrow("BUDGET_SETTLEMENT_CONFLICT");
      const additional = await b.reserve({ ...request, idempotencyKey: "after-settlement" });
      expect(additional).toBeDefined();
      const foreign = new PostgresEvolutionBudgetLedger({ pool: other.repository.pool, owner: { ...owner, userId: "foreign-budget-owner" } });
      expect(await foreign.reserve({ ...request, idempotencyKey: "own-cap" })).toBeDefined();
      await expect(foreign.settle(settlement)).rejects.toThrow("BUDGET_SETTLEMENT_CONFLICT");
      const storage = await a.storageUsage();
      expect(storage.databaseBytes).toBeGreaterThan(0);
      expect(storage.evolutionBytes).toBeGreaterThan(0);
      expect(storage.databaseBytes).toBeGreaterThanOrEqual(storage.evolutionBytes);
    } finally { await h.close(); }
  }, 120_000);

  test("E3-MAINT retention deletes only expired unreferenced raw, retains readable provenance and durable cleanup receipts", async () => {
    const h = await openPostgresRollout();
    try {
      const expiry = Date.now() - 1000;
      const linked = await h.seed("The synthetic retained canonical has original evidence.", { expiresAt: expiry });
      const orphan = await h.seed("The synthetic expired orphan has no canonical references.", { expiresAt: expiry, rawOnly: true });
      const stale = await h.seed("The synthetic stale cleanup candidate must survive.", { expiresAt: expiry, rawOnly: true });
      const port = new PostgresEvolutionMaintenancePort({ repository: h.persistence.repository });
      const { lease } = await h.lease();
      const candidates = await port.listExpired({ scope: h.scope, before: Date.now(), limit: 20 });
      expect(candidates.map(item => item.id).sort()).toEqual([linked.rawId, orphan.rawId, stale.rawId].sort());
      const candidate = (id: string) => candidates.find(item => item.id === id)!;
      const canonicalBefore = await row(h, linked.id);
      expect(await port.cleanupUnreferenced({ scope: h.scope, candidate: candidate(linked.rawId), lease })).toEqual({ status: "referenced" });
      expect(await port.cleanupUnreferenced({ scope: h.scope, candidate: { ...candidate(stale.rawId), revision: evolutionHash("stale") }, lease })).toEqual({ status: "stale" });
      await expect(port.cleanupUnreferenced({ scope: { ...h.scope, projectId: "foreign-project" }, candidate: candidate(orphan.rawId), lease })).rejects.toThrow("SCOPE_MISMATCH");
      const deleted = await port.cleanupUnreferenced({ scope: h.scope, candidate: candidate(orphan.rawId), lease });
      expect(deleted).toMatchObject({ status: "deleted", receiptId: expect.any(String) });
      expect(await row(h, orphan.rawId)).toBeUndefined();
      expect(await port.cleanupUnreferenced({ scope: h.scope, candidate: candidate(orphan.rawId), lease })).toMatchObject(deleted);
      await expect(h.evidenceReader.read(h.scope, [{ ref: orphan.rawId, source: "memory" }])).rejects.toThrow("MEMORY_EVIDENCE_CONTENT_INCOMPLETE");
      await expect(h.evidenceReader.read(h.scope, [{ ref: linked.rawId, source: "memory" }])).resolves.toMatchObject([{ preview: linked.text }]);
      expect(await row(h, linked.id)).toEqual(canonicalBefore);
      expect((await h.lookup()).hits.map(hit => hit.record.id)).toContain(linked.id);
      expect((await writes(h)).operations.filter(item => item.operation === "retention")).toHaveLength(1);
      await port.pruneMetadata({ lease, limit: 20 });
      expect((await writes(h)).operations.filter(item => item.operation === "retention")).toHaveLength(1);
    } finally { await h.close(); }
  }, 120_000);

  test("maintenance enqueue CAS and outcome event idempotency survive fresh production port instances", async () => {
    const h = await openPostgresRollout();
    try {
      const seed = await h.seed("The synthetic due policy needs bounded revalidation.");
      await h.pool.query("UPDATE memories SET evolution_review_due_at=$2 WHERE id=$1", [seed.id, Date.now() - 1000]);
      const options = { repository: h.persistence.repository, workBudget: { llmCalls: 0, inputTokens: 0, outputTokens: 0, costMicros: 0,
        records: 20, files: 0, bytes: 131_072, durationMs: 10_000 } };
      const port = new PostgresEvolutionMaintenancePort(options);
      const [item] = await port.listDue({ now: Date.now(), limit: 10 });
      expect(item.id).toBe(`revalidate:${seed.id}`);
      const request = { scope: h.scope, id: item.id, expectedRevision: item.revision, at: Date.now(), jobId: randomUUID() };
      await port.markEnqueued(request);
      const restarted = new PostgresEvolutionMaintenancePort(options);
      await restarted.markEnqueued(request);
      await expect(restarted.markEnqueued({ ...request, jobId: randomUUID() })).rejects.toThrow("MAINTENANCE_ITEM_CHANGED");
      const outcome = { scope: h.scope, workId: item.id, inputFingerprint: evolutionHash(seed.text), policyVersion: EVOLUTION_POLICY_VERSION,
        outcome: "noop" as const, reasonCode: "unchanged", at: Date.now(), fingerprint: evolutionHash("same-noop-class"), eventId: evolutionHash("event-one"), retryAfter: Date.now() + 1000 };
      await port.recordOutcome(outcome);
      await restarted.recordOutcome(outcome);
      await restarted.recordOutcome({ ...outcome, eventId: evolutionHash("event-two") });
      const summary = (await writes(h)).operations.filter(item => item.operation === "outcome_summary");
      expect(summary).toHaveLength(1);
      expect(summary[0].receipt).toMatchObject({ count: 2, reasonCode: "unchanged" });
      expect((await writes(h)).operations.filter(item => item.operation === "outcome_event")).toHaveLength(2);
      expect((await h.lookup()).hits.map(hit => hit.record.id)).toContain(seed.id);
    } finally { await h.close(); }
  }, 120_000);
});
