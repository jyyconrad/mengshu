import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DirectorySourceScanner } from "../../packages/core/src/evolution/sources/index.js";
import { planSourceReconciliation, reconcileSourceScan } from "../../packages/core/src/evolution/sources/reconciliation.js";
import { PostgresEvolutionSourceReconciliationPort } from "../../packages/core/src/evolution/postgres-source-reconciliation.js";
import { writeEvolutionLink } from "../../packages/core/src/evolution/governed-metadata.js";
import { evolutionHash } from "../../packages/core/src/evolution/fingerprints.js";
import { DEFAULT_EVOLUTION_LIMITS, EvolutionError } from "../../packages/core/src/evolution/schema.js";
import { InventoryEvolutionInput } from "../../packages/core/src/evolution/inventory-input.js";
import { AttestedEvolutionInput } from "../../packages/core/src/evolution/attested-input.js";
import { createPostgresEvolutionHostState } from "../../server/evolution-host-state.js";
import { createEvolutionAttestation, evolutionAttestationSigningPayload, type EvolutionAttestationStatement } from "../../server/evolution-attestation.js";
import { assertEvolutionOwnerRequest } from "../../packages/api/src/evolution-owner-auth.js";
import { ROLLOUT_AUTHORITY } from "../fixtures/memory-evolution-rollout/source-corpus.js";
import { openPostgresRollout, type PostgresRollout } from "../fixtures/memory-evolution-rollout/postgres.js";

const enabled = process.env.MENGSHU_RUN_LIVE_TESTS === "1";
const refs = (id: string) => [{ ref: id, source: "memory" as const }];
const actor = (h: PostgresRollout) => ({ ...assertEvolutionOwnerRequest(h.scope), actorId: h.scope.userId, authentication: "authenticated_owner" as const });
const restartedState = (h: PostgresRollout) => createPostgresEvolutionHostState({ pool: h.persistence.repository.pool,
  authority: ROLLOUT_AUTHORITY, scope: h.scope, authorizeOwner: () => actor(h) });

async function openSource(h: PostgresRollout, files: Record<string, string>) {
  const root = join(h.root, "source");
  await mkdir(root);
  for (const [name, content] of Object.entries(files)) await writeFile(join(root, name), content);
  const manifestPath = join(h.root, "state", "manifest.json");
  const scanner = await DirectorySourceScanner.create({ binding: { sourceId: "synthetic-retirement", root, scope: h.scope, parser: "markdown" }, manifestPath });
  const port = new PostgresEvolutionSourceReconciliationPort({ repository: h.persistence.repository,
    sourceId: scanner.binding.sourceId, configFingerprint: scanner.configFingerprint,
    authorizeAdministrativeReview: h.hostState.administrativeReviewGuard });
  return { root, scanner, port, manifestPath };
}

async function seedSourceLinks(h: PostgresRollout, scanner: DirectorySourceScanner) {
  const report = await scanner.scan();
  const seeds = [];
  for (const record of report.records) {
    const seed = await h.seed(record.quote, { sourceId: report.sourceId });
    // Synthetic initial reviewed relation only. This seed is neither content apply nor author attestation.
    await h.persistence.repository.mutation(client => writeEvolutionLink(client, { scope: h.scope, scopeFingerprint: h.scopeFingerprint,
      memoryId: seed.id, evidenceId: seed.rawId, now: Date.now(), state: "reviewed_reference", rootId: record.rootEvidenceId,
      sourceId: record.sourceId, sourceRevision: record.revisionId, sourceHash: record.contentHash, sourceKind: "untrusted",
      sourceRecordId: record.id, sourceLocator: `${record.pathId}:${record.byteStart}-${record.byteEnd}:${record.spanOrEventId}` }));
    seeds.push({ ...seed, record });
  }
  return { report, seeds };
}

describe.skipIf(!enabled)("rollout: real PG host state/source SQL over synthetic files, not default Runtime content apply", () => {
  test("S09/R08 zero-record globally partial deletion retires real support only after the receipt; historical raw remains readable", async () => {
    const h = await openPostgresRollout();
    let source: Awaited<ReturnType<typeof openSource>> | undefined;
    try {
      source = await openSource(h, { "a.md": "Old synthetic policy A.\n\nKeep synthetic policy A.\n", "b.md": "Old synthetic policy B.\n\nKeep synthetic policy B.\n" });
      const { report, seeds } = await seedSourceLinks(h, source.scanner);
      const { lease } = await h.lease();
      const initial = await reconcileSourceScan({ scanner: source.scanner, port: source.port, lease });
      expect(initial.receipt.recordIds).toEqual(expect.arrayContaining(report.records.map(record => record.id)));
      const first = initial.report.files[0].relativePath;
      const removed = seeds.find(seed => seed.record.relativePath === first && seed.text.startsWith("Old "))!;
      const kept = seeds.find(seed => seed.record.relativePath === first && seed.text.startsWith("Keep "))!;
      expect((await h.lookup()).hits.map(hit => hit.record.id)).toContain(removed.id);
      await writeFile(join(source.root, first), `${kept.text}\n`);
      const changed = await source.scanner.scan({ limits: { maxFiles: 1 } });
      const plan = planSourceReconciliation(h.scope, changed);
      expect(changed).toMatchObject({ enumerationComplete: false, records: [] });
      expect(plan.events).toContainEqual(expect.objectContaining({ kind: "supersede_spans", spanIds: [removed.record.spanOrEventId] }));
      const beforeManifest = JSON.parse(await readFile(source.manifestPath, "utf8"));
      expect(beforeManifest.files[removed.record.pathId].spans[removed.record.spanOrEventId]).toBeDefined();
      const receipt = await source.port.reconcile({ plan, lease, verifySource: () => source!.scanner.verifySnapshot(changed.snapshot) });
      expect(receipt.recordIds).toEqual([]);
      expect(JSON.parse(await readFile(source.manifestPath, "utf8"))).toEqual(beforeManifest);
      const links = (await h.pool.query("SELECT target_memory_id,relation_state FROM mengshu_memory_evidence_links ORDER BY target_memory_id")).rows;
      expect(links.find(link => link.target_memory_id === removed.id)?.relation_state).toBe("superseded");
      expect(links.filter(link => link.relation_state === "reviewed_reference")).toHaveLength(seeds.length - 1);
      const canonical = (await h.pool.query("SELECT text,metadata FROM memories WHERE id=$1", [removed.id])).rows[0];
      expect(canonical).toMatchObject({ text: removed.text, metadata: { confidence: 0, contextEligible: false,
        governance: { evidenceIds: [], evolution: { needsReview: true } } } });
      expect((await h.lookup()).hits.map(hit => hit.record.id)).not.toContain(removed.id);
      await expect(h.evidenceReader.read(h.scope, refs(removed.rawId))).resolves.toMatchObject([{ preview: removed.text }]);
      const count = (await h.pool.query("SELECT count(*)::int AS n FROM mengshu_write_outbox")).rows[0].n;
      // Crash after DB commit but before manifest confirmation: new port replays the durable receipt.
      const restarted = new PostgresEvolutionSourceReconciliationPort({ repository: h.provider.createEvolutionPersistence(h.scope).repository,
        sourceId: source.scanner.binding.sourceId, configFingerprint: source.scanner.configFingerprint });
      expect(await restarted.reconcile({ plan, lease, verifySource: () => source!.scanner.verifySnapshot(changed.snapshot) })).toEqual(receipt);
      expect((await h.pool.query("SELECT count(*)::int AS n FROM mengshu_write_outbox")).rows[0].n).toBe(count);
      await source.scanner.confirm(changed, receipt);
      expect(JSON.parse(await readFile(source.manifestPath, "utf8")).files[removed.record.pathId].spans[removed.record.spanOrEventId]).toBeUndefined();
      await writeFile(join(source.root, first), `${kept.text}\n\nAnother synthetic change.\n`);
      await expect(restarted.reconcile({ plan, lease, verifySource: () => source!.scanner.verifySnapshot(changed.snapshot) })).rejects.toThrow("SOURCE_CHANGED");
    } finally { try { await source?.scanner.close(); } finally { await h.close(); } }
  }, 120_000);

  test("S18 real owner administrative receipt is consumed with revoke; stale revision rolls consumption back; reimport stays blocked", async () => {
    const h = await openPostgresRollout();
    let source: Awaited<ReturnType<typeof openSource>> | undefined;
    try {
      source = await openSource(h, { "claim.md": "The synthetic revocable claim retains historical evidence.\n" });
      const { seeds: [seed] } = await seedSourceLinks(h, source.scanner);
      const { lease } = await h.lease();
      await reconcileSourceScan({ scanner: source.scanner, port: source.port, lease });
      await rm(join(source.root, "claim.md"));
      const absent = await reconcileSourceScan({ scanner: source.scanner, port: source.port, lease });
      expect(absent.plan.events).toContainEqual(expect.objectContaining({ kind: "source_unavailable" }));
      expect((await h.pool.query("SELECT relation_state FROM mengshu_memory_evidence_links")).rows).toEqual([{ relation_state: "reviewed_reference" }]);
      expect((await h.lookup()).hits.map(hit => hit.record.id)).toContain(seed.id);
      const sourceId = source.scanner.binding.sourceId;
      const options = { sourceId, sourceRevision: absent.plan.snapshotHash, expectedRevision: 0, idempotencyKey: "owner-revoke",
        operationIdempotencyKey: "apply-owner-revoke", expiresAt: Date.now() + 60_000 };
      await expect(h.attestation.control.revokeSource(options)).rejects.toThrow();
      const unguarded = new PostgresEvolutionSourceReconciliationPort({ repository: h.persistence.repository, sourceId, configFingerprint: source.scanner.configFingerprint });
      await expect(unguarded.revoke({ scope: h.scope, sourceId, expectedRevision: absent.plan.snapshotHash, reviewReceiptId: "not-a-real-receipt", idempotencyKey: "unguarded", lease })).rejects.toThrow("source_revoke_review_unavailable");
      const staleRevision = evolutionHash("stale-source-revision");
      const stale = await h.owner(() => h.attestation.control.revokeSource({ ...options, sourceRevision: staleRevision }));
      await expect(source.port.revoke({ scope: h.scope, sourceId, expectedRevision: staleRevision, reviewReceiptId: stale.id,
        idempotencyKey: options.operationIdempotencyKey, lease })).rejects.toThrow("SOURCE_REVISION_STALE");
      expect((await h.pool.query("SELECT consumed_by FROM mengshu_evolution_host_receipts WHERE receipt_id=$1", [stale.id])).rows).toEqual([{ consumed_by: null }]);
      expect((await h.pool.query("SELECT relation_state FROM mengshu_memory_evidence_links")).rows).toEqual([{ relation_state: "reviewed_reference" }]);
      const approval = await h.owner(() => h.attestation.control.revokeSource({ ...options, expectedRevision: 1, idempotencyKey: "correct-owner-revoke" }));
      const request = { scope: h.scope, sourceId, expectedRevision: absent.plan.snapshotHash, reviewReceiptId: approval.id,
        idempotencyKey: options.operationIdempotencyKey, lease };
      const revoked = await source.port.revoke(request);
      expect(revoked).toMatchObject({ affectedMemoryIds: [seed.id], suppressed: true });
      expect(await source.port.revoke(request)).toEqual(revoked);
      expect((await h.pool.query("SELECT consumed_by FROM mengshu_evolution_host_receipts WHERE receipt_id=$1", [approval.id])).rows[0].consumed_by).toMatch(/^[a-f0-9]{64}$/);
      expect((await h.pool.query("SELECT relation_state FROM mengshu_memory_evidence_links")).rows).toEqual([{ relation_state: "revoked" }]);
      expect((await h.lookup()).hits.map(hit => hit.record.id)).not.toContain(seed.id);
      await expect(h.evidenceReader.read(h.scope, refs(seed.rawId))).resolves.toMatchObject([{ preview: seed.text }]);
      await writeFile(join(source.root, "claim.md"), `${seed.text}\n`);
      await expect(reconcileSourceScan({ scanner: source.scanner, port: source.port, lease })).rejects.toThrow("SOURCE_REVOKED");
      expect((await h.pool.query("SELECT count(*)::int AS n FROM mengshu_evolution_operation_receipts WHERE operation='source_revoke'")).rows[0].n).toBe(1);
    } finally { try { await source?.scanner.close(); } finally { await h.close(); } }
  }, 120_000);

  test("host metadata CAS/receipt survive new factories; same owner cannot reclaim a heldout cohort from another app", async () => {
    const h = await openPostgresRollout();
    try {
      const request = { kind: "reuse_grants" as const, id: "synthetic-grants", expectedRevision: 0, idempotencyKey: "initial-grants", value: { grants: [] } };
      await expect(h.hostState.put(request)).rejects.toThrow();
      const first = await h.owner(() => h.hostState.put(request));
      const restarted = restartedState(h);
      expect(await h.owner(() => restarted.put(request))).toEqual(first);
      expect(await restarted.getReceipt(first.id)).toEqual(first);
      await expect(h.owner(() => restarted.put({ ...request, value: { grants: ["different"] } }))).rejects.toThrow("host_state_idempotency_conflict");
      const races = await h.owner(() => Promise.allSettled([
        h.hostState.put({ ...request, expectedRevision: 1, idempotencyKey: "racing-a", operation: "revoke" }),
        restarted.put({ ...request, expectedRevision: 1, idempotencyKey: "racing-b", operation: "revoke" }),
      ]));
      expect(races.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect(races.filter(result => result.status === "rejected")).toHaveLength(1);
      expect(await restarted.read({ kind: "reuse_grants", id: request.id })).toMatchObject({ revision: 2, revokedAt: expect.any(Number) });
      const otherScope = { ...h.scope, appId: "claude-code" };
      const other = createPostgresEvolutionHostState({ pool: h.provider.createEvolutionPersistence(otherScope).repository.pool,
        authority: ROLLOUT_AUTHORITY, scope: otherScope, authorizeOwner: () => { throw new Error("no-owner-in-automatic-holdout-claim"); } });
      expect(await other.read({ kind: "reuse_grants", id: request.id })).toBeUndefined();
      const holdout = { planHash: evolutionHash("plan-a"), holdoutRef: "synthetic-cohort", holdoutHash: evolutionHash("synthetic-heldout-hash-only"), sourceScope: h.scope };
      expect(await h.hostState.claimHoldout(holdout)).toBe(true);
      expect(await restarted.claimHoldout(holdout)).toBe(false);
      expect(await other.claimHoldout({ ...holdout, planHash: evolutionHash("plan-b"), holdoutRef: "renamed-cohort", sourceScope: otherScope })).toBe(false);
      expect((await h.pool.query("SELECT count(*)::int AS n FROM mengshu_evolution_host_state WHERE kind='paired_holdout'")).rows[0].n).toBe(1);
    } finally { await h.close(); }
  }, 120_000);

  test("synthetic Ed25519 attestation persists, guards an actual transaction, and rejects stale proof after real owner revoke", async () => {
    const h = await openPostgresRollout();
    try {
      const seed = await h.seed("The synthetic signed source attests exactly this bounded claim.");
      const [raw] = await h.persistence.inventory.hydrateEvidence(h.scope, [seed.rawId]);
      expect(raw.trust).toBe("untrusted");
      const keys = generateKeyPairSync("ed25519");
      const options = { state: h.hostState, trustedIssuers: [{ id: "synthetic-test-host", publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString() }] };
      const service = createEvolutionAttestation(options);
      const statement: EvolutionAttestationStatement = { issuer: "synthetic-test-host", scopeFingerprint: h.scopeFingerprint,
        evidenceId: raw.id, sourceId: raw.sourceId, revision: raw.revision, snapshotHash: raw.snapshotHash, rootEvidenceId: raw.rootEvidenceId,
        origin: "external", trust: "verified_document", authorizedTargetRefs: [], issuedAt: Date.now() - 1000, expiresAt: Date.now() + 60_000 };
      const signature = sign(null, evolutionAttestationSigningPayload(statement), keys.privateKey).toString("base64url");
      const request = { statement, signature, expectedRevision: 0, idempotencyKey: "signed-source" };
      await expect(service.control.issue(request)).rejects.toThrow();
      const receipt = await h.owner(() => service.control.issue(request));
      const restarted = createEvolutionAttestation({ ...options, state: restartedState(h) });
      expect(await h.owner(() => restarted.control.issue(request))).toEqual(receipt);
      await expect(h.owner(() => restarted.control.issue({ ...request, signature: "A".repeat(86), idempotencyKey: "forgery" }))).rejects.toThrow("attestation_signature_invalid");
      const input = new AttestedEvolutionInput(new InventoryEvolutionInput(h.persistence.inventory), restarted.port);
      const context = { input: { mode: "inventory" as const, selection: "baseline" as const }, scope: h.scope, limits: DEFAULT_EVOLUTION_LIMITS };
      const page = await input.readPage({ ...context, snapshot: await input.open(context), cursor: null, limit: 1 });
      const evidence = page.units[0].evidence.find(item => item.id === raw.id)!;
      expect(evidence).toMatchObject({ trust: "verified_document", hostAttestation: { evidenceId: raw.id, issuer: "synthetic-test-host" } });
      const proof = evidence.hostAttestation!;
      expect(await input.verifyUnit(page.units[0], context)).toMatchObject({ valid: true });
      const cost = await h.persistence.repository.mutation(client => restarted.assertInTransaction(client, [proof], context));
      expect(cost.recordsRead).toBeGreaterThan(0);
      const before = (await h.pool.query("SELECT metadata FROM memories WHERE id=$1", [seed.id])).rows[0];
      await h.owner(() => restarted.control.revokeSource({ sourceId: raw.sourceId, sourceRevision: raw.revision, expectedRevision: 0,
        idempotencyKey: "revoke-signature", operationIdempotencyKey: "retire-signature", expiresAt: Date.now() + 60_000 }));
      expect(await input.verifyUnit(page.units[0], context)).toMatchObject({ valid: false, reason: "attestation_revoked_or_changed" });
      let guardCode: string | undefined;
      let reachedAfterGuard = false;
      await expect(h.persistence.repository.mutation(async client => {
        // Uncommitted synthetic marker proves rollback, not just refusal before any SQL mutation.
        await client.query("UPDATE memories SET metadata=jsonb_set(metadata,'{rolloutRollbackProbe}','true'::jsonb) WHERE id=$1", [seed.id]);
        try { await restarted.assertInTransaction(client, [proof], context); }
        catch (error) { if (error instanceof EvolutionError) guardCode = error.code; throw error; }
        reachedAfterGuard = true;
      })).rejects.toMatchObject({ name: "PostgresEvolutionError", code: "TRANSACTION_FAILED" });
      // The public transaction contract deliberately does not retain a raw cause.
      expect(guardCode).toBe("attestation_revoked_or_changed");
      expect(reachedAfterGuard).toBe(false);
      // Attestation metadata alone is not content apply or active/context admission.
      expect((await h.pool.query("SELECT metadata FROM memories WHERE id=$1", [seed.id])).rows[0]).toEqual(before);
      expect((await h.persistence.inventory.hydrateEvidence(h.scope, [raw.id]))[0].trust).toBe("untrusted");
      expect((await h.pool.query("SELECT count(*)::int AS n FROM mengshu_evolution_apply_receipts")).rows[0].n).toBe(0);
    } finally { await h.close(); }
  }, 120_000);
});
