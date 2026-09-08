import { describe, expect, test, vi } from "vitest";
import { MemoryWriteKernel, type MemoryWriteCommand, type WriteMemoryRecord } from "../service/write-kernel.js";
import { PostgresMemoryWriteKernelTransactionPort, type PostgresMemoryWriteKernelClient } from "../service/write-kernel-postgres-transaction.js";
import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import { computeCanonicalContentHash } from "../scoring/hash-utils.js";
import { PostgresEvolutionRepository, proposalRequestHash } from "./postgres-repository.js";
import { PostgresEvolutionGovernedWriter, type PostgresEvolutionKernelFactory } from "./governed-writer.js";
import type { EvolutionApplyContext, EvolutionEvidence, EvolutionProposal } from "./types.js";
import { buildEvolutionReviewBinding } from "./review-binding.js";
import { evolutionHash } from "./fingerprints.js";
import { decodeEvolutionOriginalEvidence, decodeEvolutionTarget } from "./postgres-inventory.js";
import { EvolutionError } from "./schema.js";
import type { PostgresEvolutionQueryClient } from "./postgres-common.js";
import { resolveAuthorityScope } from "../domain/authority-scope.js";
import { writeRecordToMemoryRecord } from "../service/write-kernel-mapping.js";
import { recordToMemoryEntry } from "../domain/legacy-mapping.js";
import { createEvolutionRawEvidenceMaterializer } from "./governed-evidence-materializer.js";

const scope = { tenantId: "t", userId: "u", appId: "app", projectId: "p", agentId: "a", namespace: "memories", visibility: "private" as const };
const fp = authorityScopeFingerprint(scope);
const text = "The project backup location is local storage.";
const hash = computeCanonicalContentHash(text);
const evidence: EvolutionEvidence = { id: "11111111-1111-4111-8111-111111111111", sourceId: "binding-1", revision: "1", snapshotHash: hash, text, scope, rootEvidenceId: "root-1", origin: "external", trust: "verified_document", occurredAt: 1500 };
function context(): EvolutionApplyContext {
  const proposal: EvolutionProposal = { id: "proposal", batchId: "batch", scope, scopeFingerprint: fp, operation: "create", claimClass: "fact", reasonCode: "new_claim", targetRefs: [], proposedText: text, kind: "fact", quotes: [{ evidenceId: evidence.id, quote: text, start: 0, end: text.length }], inputUnitId: "unit", inputFingerprint: hash, sourceSnapshotHash: hash, configFingerprint: hash, policyVersion: "v1", validation: { outcome: "allowed", reasons: ["kind_only_lookup_only"], independentEvidenceRootIds: [evidence.rootEvidenceId], contextEligible: false, reviewRequirement: "none" }, status: "staged", createdAt: 1000 };
  const { text: _, ...ref } = evidence;
  return { proposal, evidence: [{ ...ref, quote: text, start: 0, end: text.length }], authority: { tenantId: "t", userId: "u", allow: { appIds: ["app"], projectIds: ["p"], agentIds: ["a"], namespaces: ["memories"], visibilities: ["private"] } }, lease: { batchId: "batch", scopeFingerprint: fp, ownerId: "owner", fencingToken: 1, expiresAt: 50000 }, verifySource: vi.fn(async () => ({ valid: true })) };
}
function harness(ctx = context(), options: { failReceipt?: boolean; target?: Record<string, unknown>; lockedTarget?: Record<string, unknown>; lookupTemporal?: boolean; rawRows?: Record<string, unknown>[]; missingApproval?: boolean; consumedApproval?: boolean } = {}) {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  let committedReceipt: unknown;
  let pendingReceipt: unknown;
  const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
    calls.push({ sql, params });
    if (sql === "BEGIN") pendingReceipt = committedReceipt;
    if (sql === "COMMIT") committedReceipt = pendingReceipt;
    if (/evolution:lease-lock/.test(sql)) return { rows: [{ id: "batch" }], rowCount: 1 };
    if (/evolution:approval-lock/.test(sql)) return { rows: options.missingApproval ? [] : [{ receipt: ctx.approval, consumed_by_proposal_id: options.consumedApproval ? "other-proposal" : null }] };
    if (/evolution:approval-consume/.test(sql)) return { rows: [{ receipt_id: ctx.approval?.id }] };
    if (/evolution:proposal-get/.test(sql)) return { rows: [{ metadata: { evolution: { version: 1, proposal: ctx.proposal, evidence: ctx.evidence, relationState: "staged", requestHash: proposalRequestHash(ctx.proposal, ctx.evidence), expiresAt: 100000 } }, status: "pending" }], rowCount: 1 };
    if (/evolution:(?:receipt-get|receipt-lock)/.test(sql)) return { rows: committedReceipt ? [{ receipt: committedReceipt, request_hash: proposalRequestHash(ctx.proposal, ctx.evidence) }] : [], rowCount: committedReceipt ? 1 : 0 };
    if (/evolution:apply-receipt/.test(sql)) {
      if (options.failReceipt) throw new Error("receipt failure");
      pendingReceipt = JSON.parse(params[4] as string);
      return { rows: [{ proposal_id: ctx.proposal.id }], rowCount: 1 };
    }
    if (/evolution:proposal-applied/.test(sql)) return { rows: [{ id: ctx.proposal.id }], rowCount: 1 };
    if (/evolution:(?:target-lock|target-read)/.test(sql)) {
      const target = sql.includes("target-lock") ? options.lockedTarget ?? options.target : options.target;
      return { rows: target ? [target] : [], rowCount: target ? 1 : 0 };
    }
    if (/evolution:metadata-write/.test(sql)) return { rows: [{ id: options.target?.id }], rowCount: 1 };
    if (/evolution:effective-evidence/.test(sql)) return { rows: [{ id: "memory" }], rowCount: 1 };
    if (/evolution:raw-evidence-lock/.test(sql)) return { rows: options.rawRows ?? [{ id: evidence.id, text, content_hash: hash, created_at_ms: 1000, data_type: "memory", legacy_quarantine_reason: null, lifecycle_status: "archived", metadata: {
      admissionRoute: "evidence_only", contextEligible: false, memoryContainer: "session_candidate", eventType: "observation", sourceNodeIds: [evidence.sourceId],
      governance: { commandType: "importEvidence", evidenceIds: [evidence.sourceId], native: { dataType: "memory", kind: "observation", container: "session_candidate" }, provenance: { source: "evolution", sourceId: evidence.sourceId }, candidate: { phase: "raw_evidence", evidenceOnly: true, quote: text, sourceId: evidence.sourceId } },
    } }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const client = { query, release: vi.fn() };
  const pool = { query, connect: async () => client };
  const repository = new PostgresEvolutionRepository({ pool: pool as never, scope: ctx.proposal.scope });
  const mutate = vi.fn(async (_client: unknown, memory: WriteMemoryRecord) => {
    const entry = recordToMemoryEntry(writeRecordToMemoryRecord(memory));
    return { memoryId: entry.id, stored: true };
  });
  const commands: MemoryWriteCommand[] = [];
  const createKernel: PostgresEvolutionKernelFactory = (hooks, verified) => {
    const tx = new PostgresMemoryWriteKernelTransactionPort(pool as never, mutate, hooks);
    return { transactionPort: tx, dependencies: {
      temporalLookupOnlyEnabled: options.lookupTemporal ?? true,
      resolveAuthority: ({ serverAuthority, clientScope }) => resolveAuthorityScope(serverAuthority as EvolutionApplyContext["authority"], clientScope),
      normalize: ({ command }) => ({ text: "text" in command ? command.text : "", metadata: command.metadata ?? {}, promptRisk: false }),
      embeddingGuard: () => ({ ok: true }), embed: async () => [1],
      validate: () => ({ accepted: true, candidate: { confidence: 0.5, evidence: { quote: text, eventIds: verified.canonicalEvidenceIds }, riskFlags: [] } }),
      scoreAdmission: () => ({ route: verified.validation.contextEligible ? "active" : "lookup_only", valueScore: 0.9 }),
      scoreImportance: () => 0.5,
      exactDedup: async () => ({ duplicate: false }), semanticDedup: async () => ({ duplicate: false }),
      ack: ({ command }) => { commands.push(command); }, createId: () => "memory", now: () => 2000,
    } };
  };
  return { repository, createKernel, mutate, calls, commands, client };
}
describe("PostgresEvolutionGovernedWriter", () => {
  test.each(["resolveAuthority", "normalize", "validate", "scoreAdmission"] as const)("host diagnostics locate the native kernel %s callback without publishing its payload", async method => {
    const ctx = context(), h = harness(ctx), onDiagnostic = vi.fn();
    const phases = { resolveAuthority: "kernel_authority", normalize: "kernel_normalize", validate: "kernel_validate", scoreAdmission: "kernel_admission" };
    const writer = new PostgresEvolutionGovernedWriter({ repository: h.repository, hydrateEvidence: async () => [evidence], now: () => 2000, onDiagnostic,
      createKernel: (hooks, verified) => {
        const configured = h.createKernel(hooks, verified);
        configured.dependencies[method] = () => { throw Object.assign(new Error("secret body/config"), { code: "arbitrary-secret-code" }); };
        return configured;
      } });
    expect(await writer.apply(ctx)).toEqual({ outcome: "rejected", reason: "atomic_apply_failed" });
    expect(onDiagnostic).toHaveBeenCalledExactlyOnceWith({ phase: phases[method], code: "UNEXPECTED_FAILURE" });
    expect(Object.isFrozen(onDiagnostic.mock.calls[0]![0])).toBe(true);
    expect(h.mutate).not.toHaveBeenCalled();
  });

  test("raw materializer failure is separate from canonical preparation and preserves only SQLSTATE", async () => {
    const ctx = context(), h = harness(ctx), onDiagnostic = vi.fn();
    const writer = new PostgresEvolutionGovernedWriter({ repository: h.repository, createKernel: h.createKernel,
      hydrateEvidence: async () => [evidence], now: () => 2000, onDiagnostic,
      materializeEvidence: async () => { throw Object.assign(new Error("secret raw body"), { code: "42P18", query: "private SQL" }); } });
    expect(await writer.apply(ctx)).toEqual({ outcome: "rejected", reason: "atomic_apply_failed" });
    expect(onDiagnostic).toHaveBeenCalledExactlyOnceWith({ phase: "materialize_evidence", code: "SQL_ERROR", sqlState: "42P18" });
    expect(h.mutate).not.toHaveBeenCalled();
  });

  test("native provider mutation SQL failure reports its transaction stage and rolls back", async () => {
    const ctx = context(), h = harness(ctx), onDiagnostic = vi.fn();
    h.mutate.mockImplementationOnce(async () => { throw Object.assign(new Error("secret provider payload"), { code: "23502" }); });
    const writer = new PostgresEvolutionGovernedWriter({ repository: h.repository, createKernel: h.createKernel,
      hydrateEvidence: async () => [evidence], now: () => 2000, onDiagnostic });
    expect(await writer.apply(ctx)).toEqual({ outcome: "rejected", reason: "atomic_apply_failed" });
    expect(onDiagnostic).toHaveBeenCalledExactlyOnceWith({ phase: "kernel_transaction", code: "TRANSACTION_FAILED", transactionPhase: "mutation", sqlState: "23502" });
    expect(h.calls.some(c => c.sql === "ROLLBACK")).toBe(true);
    expect(await h.repository.getReceipt("proposal", fp)).toBeUndefined();
  });

  test.each([false, true])("diagnostic callback failure (async=%s) cannot change committed replay", async asynchronous => {
    const ctx = context(), h = harness(ctx);
    const onDiagnostic = vi.fn(() => {
      if (asynchronous) return Promise.reject(new Error("observer failed"));
      throw new Error("observer failed");
    });
    const writer = new PostgresEvolutionGovernedWriter({ repository: h.repository, hydrateEvidence: async () => [evidence], now: () => 2000, onDiagnostic,
      createKernel: (hooks, verified) => {
        const configured = h.createKernel(hooks, verified);
        configured.dependencies.ack = () => { throw new Error("secret acknowledgement failure"); };
        return configured;
      } });
    expect(await writer.apply(ctx)).toMatchObject({ outcome: "applied", replayed: true });
    expect(onDiagnostic).toHaveBeenCalledExactlyOnceWith({ phase: "kernel_ack", code: "UNEXPECTED_FAILURE" });
    expect(await writer.apply(ctx)).toMatchObject({ outcome: "applied", replayed: true });
    expect(onDiagnostic).toHaveBeenCalledTimes(1);
    expect(h.mutate).toHaveBeenCalledTimes(1);
  });

  test("successful apply does not emit diagnostics", async () => {
    const ctx = context(), h = harness(ctx), onDiagnostic = vi.fn();
    const writer = new PostgresEvolutionGovernedWriter({ repository: h.repository, createKernel: h.createKernel,
      hydrateEvidence: async () => [evidence], now: () => 2000, onDiagnostic });
    expect(await writer.apply(ctx)).toMatchObject({ outcome: "applied" });
    expect(onDiagnostic).not.toHaveBeenCalled();
  });

  test("strict native metadata rejection is observed as provider mutation, not proposal validation", async () => {
    const ctx = context(), h = harness(ctx), onDiagnostic = vi.fn();
    const writer = new PostgresEvolutionGovernedWriter({ repository: h.repository, hydrateEvidence: async () => [evidence], now: () => 2000, onDiagnostic,
      createKernel: (hooks, verified) => {
        const configured = h.createKernel(hooks, verified);
        const normalize = configured.dependencies.normalize;
        configured.dependencies.normalize = async input => ({ ...await normalize(input), metadata: { invalid: new Date(1000) } });
        return configured;
      } });
    expect(await writer.apply(ctx)).toEqual({ outcome: "rejected", reason: "atomic_apply_failed" });
    expect(onDiagnostic).toHaveBeenCalledExactlyOnceWith({ phase: "kernel_transaction", code: "TRANSACTION_FAILED", transactionPhase: "mutation" });
    expect(h.mutate).toHaveBeenCalledTimes(1);
    expect(await h.repository.getReceipt("proposal", fp)).toBeUndefined();
    expect(h.calls.some(c => c.sql === "ROLLBACK")).toBe(true);
  });

  test("concurrent applies keep independent bounded failure phases", async () => {
    const ctx = context(), h = harness(ctx), onDiagnostic = vi.fn();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let reads = 0;
    const writer = new PostgresEvolutionGovernedWriter({ repository: h.repository, createKernel: h.createKernel, now: () => 2000, onDiagnostic,
      hydrateEvidence: async () => {
        if (++reads === 1) { entered(); await gate; throw new Error("secret source failure"); }
        return [evidence];
      }, materializeEvidence: async () => { throw new Error("secret materialization failure"); } });
    const first = writer.apply(ctx);
    await started;
    expect(await writer.apply(ctx)).toMatchObject({ reason: "atomic_apply_failed" });
    release();
    expect(await first).toMatchObject({ reason: "atomic_apply_failed" });
    expect(onDiagnostic.mock.calls).toEqual([
      [{ phase: "materialize_evidence", code: "UNEXPECTED_FAILURE" }],
      [{ phase: "hydrate_evidence", code: "UNEXPECTED_FAILURE" }],
    ]);
    expect(h.mutate).not.toHaveBeenCalled();
  });
  test.each([
    { operation: "create", revoked: false }, { operation: "create", revoked: true },
    { operation: "revalidate", revoked: false }, { operation: "revalidate", revoked: true },
  ] as const)("$operation locks host attestation/revocation with the canonical transaction client (revoked=$revoked)", async ({ operation, revoked }) => {
    const ctx = context();
    let sourceVerified = false;
    ctx.verifySource = vi.fn(async () => { sourceVerified = true; return { valid: true }; });
    const proof = { id: "proof", issuer: "trusted-issuer", scopeFingerprint: fp, evidenceId: evidence.id, sourceId: evidence.sourceId,
      revision: evidence.revision, snapshotHash: hash, rootEvidenceId: evidence.rootEvidenceId, trust: "verified_document" as const,
      occurredAt: 1500, authorizedTargetRefs: [], verifiedAt: 1500, expiresAt: 9000 };
    const source = { ...evidence, hostAttestation: proof };
    ctx.evidence[0]!.hostAttestation = proof;
    const target = { id: "22222222-2222-4222-8222-222222222222", text, content_hash: hash, created_at_ms: 100, revision: 0,
      lifecycle_status: "archived", metadata: { admissionRoute: "lookup_only", contextEligible: false, governance: { native: { kind: "fact" }, evidenceIds: [evidence.id] } } };
    if (operation === "revalidate") {
      ctx.proposal.operation = "revalidate"; ctx.proposal.reasonCode = "source_changed"; delete ctx.proposal.proposedText;
      ctx.proposal.targetRefs = [{ memoryId: target.id, expectedRevision: 0, beforeHash: hash }];
      ctx.proposal.reviewedProposalId = "original-proposal"; ctx.proposal.ownerApprovalReceiptId = "review-receipt";
      const binding = buildEvolutionReviewBinding(ctx.proposal, { id: "unit", scope, snapshotHash: hash, evidence: [source], targets: [decodeEvolutionTarget(target, scope)] });
      ctx.approval = { id: "review-receipt", reviewId: "review", idempotencyKey: "approve", decision: "approve", binding, bindingHash: evolutionHash(binding),
        actor: { tenantId: "t", userId: "u", actorId: "owner", authentication: "local_owner" }, decidedAt: 1500, expiresAt: 9000 };
    }
    const h = harness(ctx, { target });
    const assertApplyInTransaction = vi.fn(async (client: PostgresEvolutionQueryClient, current: EvolutionApplyContext) => {
      if (!sourceVerified) throw new EvolutionError("verification_budget_not_committed");
      expect(client).toBe(h.client);
      expect(current.evidence[0]?.hostAttestation).toEqual(proof);
      expect(h.calls.some(c => c.sql === "BEGIN")).toBe(true);
      expect(h.calls.some(c => c.sql.includes("evolution:source-tombstones"))).toBe(true);
      expect(h.calls.some(c => c.sql.includes("evolution:metadata-write"))).toBe(false);
      expect(h.mutate).not.toHaveBeenCalled();
      await client.query("/* host-attestation-lock */ SELECT 1");
      if (revoked) throw new EvolutionError("attestation_revoked_or_changed");
    });
    const onDiagnostic = vi.fn();
    const writer = new PostgresEvolutionGovernedWriter({ repository: h.repository, createKernel: h.createKernel,
      hydrateEvidence: async () => [source], assertApplyInTransaction, now: () => 2000, onDiagnostic });
    const result = await writer.apply(ctx);
    expect(assertApplyInTransaction).toHaveBeenCalledTimes(1);
    if (revoked) {
      expect(onDiagnostic).toHaveBeenCalledExactlyOnceWith(operation === "create"
        ? { phase: "host_guard", code: "TRANSACTION_FAILED", transactionPhase: "mutation" }
        : { phase: "host_guard", code: "EVOLUTION_GUARD_REJECTED" });
      expect(result).toMatchObject({ outcome: "rejected", reason: "attestation_revoked_or_changed" });
      expect(h.calls.some(c => c.sql === "ROLLBACK")).toBe(true);
      expect(h.calls.some(c => c.sql.includes("evolution:metadata-write") || c.sql.includes("evolution:apply-receipt"))).toBe(false);
      expect(h.mutate).not.toHaveBeenCalled();
    } else {
      expect(result).toMatchObject({ outcome: "applied" });
      expect(h.calls.findIndex(c => c.sql.includes("host-attestation-lock"))).toBeLessThan(h.calls.findIndex(c => c.sql.includes("evolution:apply-receipt")));
    }
  });
  test("a host attestation without a transaction guard cannot use successful external verification to apply", async () => {
    const ctx = context();
    ctx.evidence[0]!.hostAttestation = { id: "proof", issuer: "issuer", scopeFingerprint: fp, evidenceId: evidence.id, sourceId: evidence.sourceId,
      revision: evidence.revision, snapshotHash: hash, rootEvidenceId: evidence.rootEvidenceId, trust: "verified_document", authorizedTargetRefs: [], verifiedAt: 1500, expiresAt: 9000 };
    const h = harness(ctx), hydrateEvidence = vi.fn(async () => [{ ...evidence, hostAttestation: ctx.evidence[0]!.hostAttestation }]);
    const writer = new PostgresEvolutionGovernedWriter({ repository: h.repository, createKernel: h.createKernel, hydrateEvidence, now: () => 2000 });
    expect(await writer.apply(ctx)).toMatchObject({ outcome: "blocked", reason: "attestation_transaction_guard_unavailable" });
    expect(h.mutate).not.toHaveBeenCalled();
    expect(h.calls.some(c => c.sql === "BEGIN")).toBe(false);
    expect(hydrateEvidence).not.toHaveBeenCalled();
  });
  test.each(["unchanged", "scheduled", "held_before", "held_locked", "confidence_before", "confidence_locked"])("owner review uses persisted target state with separately hydrated raw: %s", async mode => {
    const target = { id: "22222222-2222-4222-8222-222222222222", text, content_hash: hash, created_at_ms: 100,
      revision: 0, lineage_id: null, lifecycle_status: "archived", valid_to_ms: null,
      metadata: { admissionRoute: "lookup_only", contextEligible: false, confidence: 0,
        governance: { native: { kind: "fact" }, evidenceIds: [evidence.id] } } };
    const ctx = context(), source = { ...evidence, trust: "untrusted" as const };
    ctx.evidence[0]!.trust = "untrusted";
    ctx.proposal.operation = "revalidate";
    ctx.proposal.reasonCode = "source_changed";
    delete ctx.proposal.proposedText;
    ctx.proposal.targetRefs = [{ memoryId: target.id, expectedRevision: 0, beforeHash: hash }];
    ctx.proposal.reviewedProposalId = "original-proposal";
    ctx.proposal.ownerApprovalReceiptId = "review-receipt";
    const binding = buildEvolutionReviewBinding(ctx.proposal, { id: "unit", scope, snapshotHash: hash,
      evidence: [source], targets: [decodeEvolutionTarget(target, scope)] });
    ctx.approval = { id: "review-receipt", reviewId: "review", decision: "approve", idempotencyKey: "approve", binding, bindingHash: evolutionHash(binding),
      actor: { actorId: "owner", tenantId: "t", userId: "u", authentication: "local_owner" }, decidedAt: 1500, expiresAt: 10000 };
    const changed = mode.startsWith("held") ? { ...target, evolution_disputed: true }
      : mode.startsWith("confidence") ? { ...target, metadata: { ...target.metadata, confidence: 0.7 } }
      : mode === "scheduled" ? { ...target, evolution_review_due_at: 9000,
        metadata: { ...target.metadata, queryHits: 500, governance: { ...target.metadata.governance, evolution: { lastAttemptAt: 1000 } } } }
      : target;
    const h = harness(ctx, { target: mode.endsWith("before") ? changed : target, lockedTarget: changed });
    const writer = new PostgresEvolutionGovernedWriter({ repository: h.repository, hydrateEvidence: async () => [source], now: () => 2000 });
    const result = await writer.apply(ctx);
    if (mode === "unchanged" || mode === "scheduled") {
      expect(result).toMatchObject({ outcome: "applied", receipt: { memoryIds: [target.id] } });
      expect(h.calls.some(({ sql }) => sql.includes("evolution:metadata-write"))).toBe(true);
    } else {
      expect(result).toMatchObject({ outcome: "rejected", reason: mode.endsWith("before") ? "approval_binding_mismatch" : "governance_state_changed" });
      expect(h.calls.some(({ sql }) => sql.includes("evolution:metadata-write"))).toBe(false);
      if (mode.endsWith("locked")) expect(h.calls.some(({ sql }) => sql === "ROLLBACK")).toBe(true);
    }
    expect(h.mutate).not.toHaveBeenCalled();
  });
  test("owner-reviewed untrusted original is lookup-only reference, never independent support", async () => {
    const ctx = context(), source = { ...evidence, trust: "untrusted" as const };
    ctx.evidence[0]!.trust = "untrusted";
    ctx.proposal.reviewedProposalId = "original-proposal";
    ctx.proposal.ownerApprovalReceiptId = "review-receipt";
    const binding = buildEvolutionReviewBinding(ctx.proposal, { id: "unit", scope, snapshotHash: hash, evidence: [source], targets: [] });
    ctx.approval = { id: "review-receipt", reviewId: "review", binding, bindingHash: evolutionHash(binding), decision: "approve", actor: { tenantId: "t", userId: "u", actorId: "owner", authentication: "local_owner" }, idempotencyKey: "approve", decidedAt: 1500, expiresAt: 9000 };
    for (const missingApproval of [false, true]) {
      const h = harness(ctx, { missingApproval });
      const writer = new PostgresEvolutionGovernedWriter({ repository: h.repository, createKernel: h.createKernel, hydrateEvidence: async () => [source], now: () => 2000 });
      const result = await writer.apply(ctx);
      if (missingApproval) {
        expect(result.outcome).not.toBe("applied");
        expect(h.mutate).not.toHaveBeenCalled();
      } else {
        expect(result).toMatchObject({ outcome: "applied" });
        expect(h.mutate.mock.calls[0]?.[1]).toMatchObject({ route: "lookup_only", confidence: 0 });
        const effective = h.calls.find(c => c.sql.includes("evolution:effective-evidence */"))!;
        expect(JSON.parse(effective.params[10] as string)).toMatchObject({ effectiveRootIds: [], evidence: [{ relationState: "reviewed_reference", trust: "untrusted" }] });
        expect(h.calls.some(c => c.sql.includes("evolution:approval-consume"))).toBe(true);
      }
    }
  });
  test("unbranded transaction factory cannot execute canonical writes", async () => {
    const ctx = context(), h = harness(ctx);
    const writer = new PostgresEvolutionGovernedWriter({ repository: h.repository, hydrateEvidence: async () => [evidence],
      createKernel: (hooks, input) => ({ ...h.createKernel(hooks, input), transactionPort: { transaction: async () => { throw new Error("must not be reached"); } } }), now: () => 2000 });
    expect(await writer.apply(ctx)).toMatchObject({ outcome: "blocked", reason: "provider_owned_transaction_required" });
    expect(h.mutate).not.toHaveBeenCalled();
  });
  test("kind-only temporal updates retain type and reject pinned or stale targets", async () => {
    const oldText = "The project backup location is remote storage.";
    const target = { id: "22222222-2222-4222-8222-222222222222", text: oldText, content_hash: computeCanonicalContentHash(oldText), created_at_ms: 100,
      revision: 1, lineage_id: "backup-lineage", lifecycle_status: "archived", valid_from_ms: 100, valid_to_ms: null,
      metadata: { admissionRoute: "lookup_only", contextEligible: false, governance: { native: { kind: "fact" } } } };
    const ctx = context();
    ctx.proposal.operation = "evolve"; ctx.proposal.reasonCode = "attribute_changed"; ctx.proposal.validFrom = 1500;
    ctx.proposal.targetRefs = [{ memoryId: target.id, beforeHash: target.content_hash, expectedRevision: 1 }];
    ctx.evidence[0]!.authorizedTargetIds = [target.id];
    const source = { ...evidence, authorizedTargetIds: [target.id] };
    const h = harness(ctx, { target });
    const writer = new PostgresEvolutionGovernedWriter({ repository: h.repository, createKernel: h.createKernel, hydrateEvidence: async () => [source], now: () => 2000 });
    expect(await writer.apply(ctx)).toMatchObject({ outcome: "applied" });
    expect(h.mutate.mock.calls[0]?.[1]).toMatchObject({ route: "lookup_only", kind: "fact", temporal: { lineageId: "backup-lineage", expectedHeadRevision: 1, expectedHeadVersionId: target.id, validFrom: 1500, transitionType: "evolved" } });
    const unavailable = harness(ctx, { target, lookupTemporal: false });
    const gated = new PostgresEvolutionGovernedWriter({ repository: unavailable.repository, createKernel: unavailable.createKernel, hydrateEvidence: async () => [source], now: () => 2000 });
    expect(await gated.apply(ctx)).toMatchObject({ outcome: "blocked", reason: "kind_only_temporal_read_unavailable" });
    expect(unavailable.mutate).not.toHaveBeenCalled();
    for (const row of [{ ...target, revision: 2 }, { ...target, metadata: { ...target.metadata, pinned: true } }, { ...target, temporal_purge_pending: true }]) {
      const rejected = harness(ctx, { target: row });
      const rejecting = new PostgresEvolutionGovernedWriter({ repository: rejected.repository, createKernel: rejected.createKernel, hydrateEvidence: async () => [source], now: () => 2000 });
      expect((await rejecting.apply(ctx)).outcome).not.toBe("applied");
      expect(rejected.mutate).not.toHaveBeenCalled();
    }
  });
  test("atomic create goes through Write Kernel and commits proposal, effective evidence and receipt together", async () => {
    const ctx = context(), h = harness(ctx);
    const writer = new PostgresEvolutionGovernedWriter({ repository: h.repository, createKernel: h.createKernel, hydrateEvidence: async () => [evidence], now: () => 2000 });
    const result = await writer.apply(ctx);
    expect(result).toMatchObject({ outcome: "applied", replayed: false, receipt: { memoryIds: ["memory"] } });
    expect(h.mutate).toHaveBeenCalledTimes(1);
    expect(h.mutate.mock.calls[0]?.[1]).toMatchObject({ kind: "fact", route: "lookup_only" });
    expect(h.mutate.mock.calls[0]?.[1]).not.toHaveProperty("semanticType");
    const sql = h.calls.map((c) => c.sql);
    expect(sql.findIndex((s) => /evolution:apply-receipt/.test(s))).toBeLessThan(sql.lastIndexOf("COMMIT"));
    expect(sql.findIndex((s) => /evolution:proposal-applied/.test(s))).toBeLessThan(sql.lastIndexOf("COMMIT"));
    expect(sql.find(s => s.includes("evolution:effective-evidence */"))).toContain("{record,metadata}");
    expect(ctx.verifySource).toHaveBeenCalled();
    await expect(writer.apply(ctx)).resolves.toMatchObject({ outcome: "applied", replayed: true });
    expect(h.mutate).toHaveBeenCalledTimes(1);
  });
  test.each([undefined, "host-session"])("materialized native raw passes locked evidence validation without synthetic metadata repair (session=%s)", async sessionId => {
    const ctx = context(), rawRows: Record<string, unknown>[] = [];
    const currentScope = { ...scope, ...(sessionId ? { sessionId } : {}) };
    ctx.proposal.scope = currentScope;
    ctx.proposal.scopeFingerprint = authorityScopeFingerprint(currentScope);
    ctx.lease.scopeFingerprint = ctx.proposal.scopeFingerprint;
    ctx.authority = { ...ctx.authority, ...(sessionId ? { sessionId } : {}) };
    ctx.evidence[0]!.scope = currentScope;
    const source = { ...evidence, scope: currentScope };
    const h = harness(ctx, { rawRows });
    const rawId = "77777777-7777-4777-8777-777777777777";
    const rawPort = new PostgresMemoryWriteKernelTransactionPort({ connect: async () => h.client as unknown as PostgresMemoryWriteKernelClient }, async (_client, memory) => {
      const entry = recordToMemoryEntry(writeRecordToMemoryRecord(memory));
      // Only SQL column aliases/defaults are projected; metadata comes entirely from the native write path.
      rawRows.push({ id: entry.id, text: entry.text, content_hash: entry.contentHash, created_at_ms: String(entry.createdAt),
        revision: null, data_type: entry.dataType, lifecycle_status: entry.lifecycleStatus, legacy_quarantine_reason: null,
        metadata: structuredClone(entry.metadata) });
      return { memoryId: entry.id, stored: true };
    });
    const configured = h.createKernel({}, { context: ctx, evidence: [source], targets: [], validation: ctx.proposal.validation,
      supportedEvidence: ctx.evidence, canonicalEvidenceIds: [] });
    const rawKernel = new MemoryWriteKernel({ ...configured.dependencies,
      normalize: ({ command, scope }) => ({ text: "text" in command ? command.text : "", promptRisk: false,
        metadata: { ...command.metadata, ...(scope.sessionId ? { sessionId: scope.sessionId } : {}) } }),
      validate: ({ command, normalized }) => {
        if (command.type !== "importEvidence") throw new Error("raw_import_required");
        return { accepted: true, candidate: { phase: "raw_evidence", evidenceOnly: true, quote: normalized.text, sourceId: command.sourceId } };
      },
      scoreAdmission: () => ({ route: "evidence_only", valueScore: 0 }), createId: () => rawId,
      transaction: work => rawPort.transaction(work) });
    const writer = new PostgresEvolutionGovernedWriter({ repository: h.repository, createKernel: h.createKernel,
      hydrateEvidence: async () => [source], materializeEvidence: createEvolutionRawEvidenceMaterializer(rawKernel), now: () => 2000 });
    const result = await writer.apply(ctx);
    if (sessionId) expect(rawRows[0]?.metadata).toMatchObject({ sessionId, governance: { provenance: { sessionId } } });
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied", receipt: { memoryIds: ["memory"] } });
    expect(rawRows).toHaveLength(1);
    expect(rawRows[0]?.metadata).toMatchObject({ eventType: "observation", admissionRoute: "evidence_only", contextEligible: false,
      memoryContainer: "session_candidate", governance: { commandType: "importEvidence", native: { kind: "observation", container: "session_candidate" } } });
    const raw = rawRows[0]!;
    const decoded = decodeEvolutionOriginalEvidence(raw, currentScope);
    expect(decoded).toMatchObject({ id: rawId, origin: "external", trust: "untrusted", revoked: false });
    expect(decoded?.authorizedTargetIds).toBeUndefined();
    const metadata = raw.metadata as Record<string, unknown>;
    expect(decodeEvolutionOriginalEvidence({ ...raw, metadata: { ...metadata, eventType: undefined } }, currentScope)).toBeUndefined();
    if (sessionId) {
      const governance = metadata.governance as Record<string, unknown>;
      const provenance = governance.provenance as Record<string, unknown>;
      for (const invalidSession of [undefined, "other-session"]) {
        expect(decodeEvolutionOriginalEvidence({ ...raw, metadata: { ...metadata,
          governance: { ...governance, provenance: { ...provenance, sessionId: invalidSession } } } }, currentScope)).toBeUndefined();
      }
    }
    expect(h.mutate.mock.calls[0]?.[1]).toMatchObject({ evidenceIds: [rawId] });
    expect(h.calls.find(call => call.sql.includes("evolution:effective-evidence-link"))?.params).toContain(rawId);
  });
  test.each(["untrusted", "same_root"])("%s extra evidence cannot gain canonical links or independent roots", async (extraKind) => {
    const ctx = context();
    const untrusted = { ...evidence, id: "99999999-9999-4999-8999-999999999999", rootEvidenceId: extraKind === "untrusted" ? "untrusted-root" : evidence.rootEvidenceId, trust: extraKind === "untrusted" ? "untrusted" as const : evidence.trust };
    const { text: _text, ...ref } = untrusted;
    ctx.evidence.push({ ...ref, quote: text, start: 0, end: text.length });
    ctx.proposal.quotes.push({ evidenceId: untrusted.id, quote: text, start: 0, end: text.length });
    const h = harness(ctx);
    const writer = new PostgresEvolutionGovernedWriter({ repository: h.repository, createKernel: h.createKernel, hydrateEvidence: async () => [evidence, untrusted], now: () => 2000 });
    expect(await writer.apply(ctx)).toMatchObject({ outcome: "applied" });
    expect(h.mutate.mock.calls[0]?.[1]).toMatchObject({ evidenceIds: [evidence.id] });
    const effective = h.calls.find(({ sql }) => sql.includes("evolution:effective-evidence */"));
    expect(JSON.parse(effective!.params[10] as string)).toMatchObject({ effectiveRootIds: [evidence.rootEvidenceId], evidence: [{ id: evidence.id }] });
    expect(JSON.parse(effective!.params[10] as string).evidence).toHaveLength(1);
    expect(h.calls.filter(({ sql }) => sql.includes("evolution:effective-evidence-link"))).toHaveLength(1);
  });
  test("logical source IDs bind to materialized raw UUIDs and mismatched provenance fails before mutation", async () => {
    const source = { ...evidence, id: "scanner:event-1" };
    const ctx = context(); ctx.evidence[0]!.id = source.id; ctx.proposal.quotes[0]!.evidenceId = source.id;
    const sourceKey = "evolution-source:materialized";
    const raw = { id: evidence.id, text, content_hash: hash, created_at_ms: 1000, data_type: "memory", legacy_quarantine_reason: null, lifecycle_status: "archived", metadata: {
      admissionRoute: "evidence_only", contextEligible: false, memoryContainer: "session_candidate", eventType: "observation", sourceNodeIds: [sourceKey],
      evolutionEvidence: { sourceEvidenceId: source.id, sourceId: source.sourceId, revision: source.revision, snapshotHash: source.snapshotHash, rootEvidenceId: source.rootEvidenceId, expiresAt: 1999 },
      governance: { commandType: "importEvidence", evidenceIds: [sourceKey], native: { dataType: "memory", kind: "observation", container: "session_candidate" }, provenance: { source: "evolution", sourceId: sourceKey }, candidate: { phase: "raw_evidence", evidenceOnly: true, quote: text, sourceId: sourceKey } },
    } };
    for (const invalid of [false, true]) {
      const rawRow = invalid ? { ...raw, metadata: { ...raw.metadata, evolutionEvidence: { ...raw.metadata.evolutionEvidence, snapshotHash: "f".repeat(64) } } } : raw;
      const h = harness(ctx, { rawRows: [rawRow] });
      const writer = new PostgresEvolutionGovernedWriter({ repository: h.repository, createKernel: h.createKernel, hydrateEvidence: async () => [source], now: () => 2000,
        materializeEvidence: async ({ supportedEvidence }) => {
          expect(supportedEvidence.map((e) => e.id)).toEqual([source.id]);
          return [{ sourceEvidenceId: source.id, evidenceMemoryId: raw.id }];
        } });
      const result = await writer.apply(ctx);
      if (invalid) {
        expect(result).toMatchObject({ outcome: "rejected", reason: "canonical_evidence_source_mismatch" });
        expect(h.mutate).not.toHaveBeenCalled();
      } else {
        expect(result).toMatchObject({ outcome: "applied" });
        expect(h.mutate.mock.calls[0]?.[1]).toMatchObject({ evidenceIds: [raw.id] });
        expect(h.calls.find(({ sql }) => sql.includes("evolution:effective-evidence-link"))?.params).toContain(raw.id);
      }
    }
  });
  test("a second unrelated trusted quote cannot be materialized or restored as effective support", async () => {
    const ctx = context();
    const otherText = "The unrelated service uses a cloud message queue.";
    const other = { ...evidence, id: "99999999-9999-4999-8999-999999999999", rootEvidenceId: "other-root", text: otherText, snapshotHash: computeCanonicalContentHash(otherText) };
    const { text: _text, ...ref } = other;
    ctx.evidence.push({ ...ref, quote: otherText, start: 0, end: otherText.length });
    ctx.proposal.quotes.push({ evidenceId: other.id, quote: otherText, start: 0, end: otherText.length });
    const h = harness(ctx), materialize = vi.fn(async () => []);
    const writer = new PostgresEvolutionGovernedWriter({ repository: h.repository, createKernel: h.createKernel,
      hydrateEvidence: async () => [evidence, other], materializeEvidence: materialize, now: () => 2000 });
    expect(await writer.apply(ctx)).toMatchObject({ outcome: "blocked", reason: "owner_review_required" });
    expect(materialize).not.toHaveBeenCalled();
    expect(h.mutate).not.toHaveBeenCalled();
  });
  test("failure after canonical mutation rolls back rather than reporting applied", async () => {
    const ctx = context(), h = harness(ctx, { failReceipt: true });
    const writer = new PostgresEvolutionGovernedWriter({ repository: h.repository, createKernel: h.createKernel, hydrateEvidence: async () => [evidence], now: () => 2000 });
    const result = await writer.apply(ctx);
    expect(result.outcome).not.toBe("applied");
    expect(h.calls.some(({ sql }) => sql === "ROLLBACK")).toBe(true);
    expect(await h.repository.getReceipt("proposal", fp)).toBeUndefined();
  });
  test("missing hydration blocks create without invoking kernel", async () => {
    const ctx = context(), h = harness(ctx);
    const createKernel = vi.fn(h.createKernel);
    const writer = new PostgresEvolutionGovernedWriter({ repository: h.repository, createKernel });
    expect(await writer.apply(ctx)).toMatchObject({ outcome: "blocked", reason: "source_hydration_unavailable" });
    expect(createKernel).not.toHaveBeenCalled();
  });
  test("a changed source fails within the transaction before canonical mutation", async () => {
    const ctx = context(); ctx.verifySource = async () => ({ valid: false, reason: "source_changed" });
    const h = harness(ctx);
    const writer = new PostgresEvolutionGovernedWriter({ repository: h.repository, createKernel: h.createKernel, hydrateEvidence: async () => [evidence], now: () => 2000 });
    expect(await writer.apply(ctx)).toMatchObject({ outcome: "rejected", reason: "source_changed" });
    expect(h.mutate).not.toHaveBeenCalled();
  });
  test.each(["invalid", "throws", "cancelled"])("source verification %s prevents the host budget/attestation callback and canonical writes", async mode => {
    const ctx = context(), controller = new AbortController();
    ctx.signal = controller.signal;
    ctx.verifySource = vi.fn(async () => {
      if (mode === "throws") throw new EvolutionError("source_verification_failed");
      if (mode === "cancelled") controller.abort();
      return mode === "invalid" ? { valid: false, reason: "source_changed" } : { valid: true };
    });
    const h = harness(ctx), assertApplyInTransaction = vi.fn(async () => {});
    const writer = new PostgresEvolutionGovernedWriter({ repository: h.repository, createKernel: h.createKernel,
      hydrateEvidence: async () => [evidence], assertApplyInTransaction, now: () => 2000 });
    expect(await writer.apply(ctx)).toMatchObject({ outcome: "rejected", reason: mode === "invalid" ? "source_changed" : mode === "throws" ? "source_verification_failed" : "cancelled" });
    expect(ctx.verifySource).toHaveBeenCalledTimes(1);
    expect(assertApplyInTransaction).not.toHaveBeenCalled();
    expect(h.mutate).not.toHaveBeenCalled();
    expect(h.calls.some(call => call.sql.includes("evolution:apply-receipt"))).toBe(false);
    expect(h.calls.some(call => call.sql === "ROLLBACK")).toBe(true);
  });
  test("hydration cannot substitute quote-only text, revoked or alternate-root evidence", async () => {
    for (const changed of [{ text: "unrelated" }, { revoked: true }, { rootEvidenceId: "different-root" }]) {
      const ctx = context(), h = harness(ctx);
      const writer = new PostgresEvolutionGovernedWriter({ repository: h.repository, createKernel: h.createKernel, hydrateEvidence: async () => [{ ...evidence, ...changed }], now: () => 2000 });
      expect((await writer.apply(ctx)).outcome).toBe("rejected");
      expect(h.mutate).not.toHaveBeenCalled();
    }
  });
  test("owner review is not an auto apply authorization", async () => {
    const ctx = context(); ctx.proposal.validation.reviewRequirement = "owner";
    const h = harness(ctx);
    const writer = new PostgresEvolutionGovernedWriter({ repository: h.repository, createKernel: h.createKernel, hydrateEvidence: async () => [evidence] });
    expect(await writer.apply(ctx)).toMatchObject({ outcome: "blocked", reason: "owner_review_required" });
    expect(h.mutate).not.toHaveBeenCalled();
  });
  test("noop records a durable receipt without touching canonical scores", async () => {
    const ctx = context(); ctx.proposal.operation = "noop"; ctx.proposal.validation.outcome = "noop";
    const h = harness(ctx);
    const writer = new PostgresEvolutionGovernedWriter({ repository: h.repository, now: () => 2000 });
    await expect(writer.apply(ctx)).resolves.toMatchObject({ outcome: "noop", receipt: { memoryIds: [] } });
    expect(h.mutate).not.toHaveBeenCalled();
    expect(h.calls.some(({ sql }) => /UPDATE memories/.test(sql))).toBe(false);
  });
});
