import { describe, expect, test } from "vitest";
import { GovernedRetrievalEngine } from "../../packages/core/src/retrieval/governed-retrieval-engine.js";
import type { EvolutionBatchReport, EvolutionReviewReceipt } from "../../packages/core/src/evolution/types.js";
import type { publicEvolutionReview } from "../../packages/api/src/evolution-review.js";
import { openNativeRolloutRuntime } from "../fixtures/memory-evolution-rollout/native-runtime.js";
import { safeNativeBatchDiagnostic } from "../fixtures/memory-evolution-rollout/startup-diagnostics.js";
import { createSyntheticNativeIssuer, NATIVE_ATTESTED_LIMITS, SYNTHETIC_ATTESTED_SOURCE } from "../fixtures/memory-evolution-rollout/native-attestation.js";

const liveEnabled = process.env.MENGSHU_RUN_LIVE_TESTS === "1" && process.env.MENGSHU_EVOLUTION_REAL_MODEL === "1";

describe.skipIf(!liveEnabled)("rollout default RuntimeHost + isolated PG + explicit global model", () => {
  test("explicit signed synthetic source auto-creates through the default host and reads current, original evidence and context", async () => {
    const issuer = createSyntheticNativeIssuer();
    const h = await openNativeRolloutRuntime(SYNTHETIC_ATTESTED_SOURCE, { trustedIssuers: [issuer.trustedIssuer] });
    try {
      expect(await h.canonicalCount()).toBe(0);
      const unsigned = await h.readUnsignedSource();
      expect(unsigned.evidence[0]).toMatchObject({ trust: "untrusted", text: SYNTHETIC_ATTESTED_SOURCE });
      const request = issuer.signSource(unsigned);
      expect(request.statement).not.toHaveProperty("authorId");
      expect((await h.control("source/attest", request, false)).status).toBe(403);
      expect((await h.control("source/attest", { ...request, signature: "A".repeat(86) })).status).toBe(409);
      const signed = await h.control("source/attest", request);
      expect(signed.status).toBe(200);
      expect(signed.body).toMatchObject({ kind: "source_attestation", revision: 1 });
      expect((await h.control("source/attest", request)).body).toEqual(signed.body);
      expect(await h.canonicalCount()).toBe(0);

      const input = { mode: "directory" as const, sourceId: request.statement.sourceId };
      const context = { scope: h.scope, input, limits: NATIVE_ATTESTED_LIMITS };
      const attester = h.runtime.evolutionHostControl!.attestation.port;
      const resolved = await attester.attest({ ...context, unit: unsigned });
      expect(resolved.attestations).toHaveLength(1);
      const proof = resolved.attestations[0];
      expect(proof).toMatchObject({ evidenceId: unsigned.evidence[0].id, revision: unsigned.evidence[0].revision,
        snapshotHash: unsigned.evidence[0].snapshotHash, trust: "verified_document" });
      expect(await attester.verify([proof], context)).toMatchObject({ valid: true });

      const evolutionCalls = () => h.events.filter(event => event.operation.includes("evolution")).length;
      const before = evolutionCalls();
      const run = { input, action: "apply_allowed" as const, limits: NATIVE_ATTESTED_LIMITS, idempotencyKey: "signed-native-auto-create" };
      const queued = await h.capability.run(run);
      expect(queued.status).toBe("queued");
      expect(evolutionCalls()).toBe(before);
      expect(await h.canonicalCount()).toBe(0);
      const applied = await h.waitBatch(queued.batchId);
      const proposals = await h.proposals(applied.batchId);
      // A model noop, kind-only result or review refusal is not a positive E0/context pass.
      expect(applied, safeNativeBatchDiagnostic(applied, proposals.proposals)).toMatchObject({ status: "completed", counts: { applied: 1, review: 0 }, usage: { llmCalls: 1 } });
      expect(proposals.proposals).toHaveLength(1);
      const proposal = proposals.proposals[0];
      expect(proposal).toMatchObject({ operation: "create", status: "applied", proposedText: SYNTHETIC_ATTESTED_SOURCE,
        semanticType: "resource", validation: { outcome: "allowed", reviewRequirement: "none", contextEligible: true } });
      expect(proposal.validation.ownerApprovalReceiptId).toBeUndefined();
      expect(proposal.validation.independentEvidenceRootIds).toEqual([unsigned.evidence[0].rootEvidenceId]);
      const staged = await h.persistence.repository.getStagedEvidence(proposal.id, h.scopeFingerprint);
      expect(staged).toHaveLength(1);
      expect(staged[0]).toMatchObject({ trust: "verified_document", hostAttestation: proof });
      const receipt = await h.persistence.repository.getReceipt(proposal.id, h.scopeFingerprint);
      expect(receipt).toMatchObject({ outcome: "applied", operation: "create" });
      expect(receipt!.memoryIds).toHaveLength(1);
      const memoryId = receipt!.memoryIds[0];
      const current = await h.current(memoryId);
      expect(current).toMatchObject({ historical: false, invalidated: false, activationState: "active",
        record: { id: memoryId, text: SYNTHETIC_ATTESTED_SOURCE, semanticType: "resource", lifecycleStatus: "active",
          metadata: { admissionRoute: "active" } } });
      expect(current!.record.sourceNodeIds!.length).toBeGreaterThan(0);
      const lookup = await h.runtime.agentFastPath.lookup({ scope: h.scope, query: SYNTHETIC_ATTESTED_SOURCE, minScore: 0, limit: 10 });
      expect(lookup.hits.map(hit => hit.id)).toContain(memoryId);
      const raw = await h.runtime.agentFastPath.evidenceRead({ scope: h.scope, refs: current!.record.sourceNodeIds! });
      expect(raw.evidence.some(evidence => evidence.preview.trim() === SYNTHETIC_ATTESTED_SOURCE)).toBe(true);
      const injected = await h.runtime.agentFastPath.context({ scope: h.scope, task: SYNTHETIC_ATTESTED_SOURCE, tokenBudget: 4000, latencyBudgetMs: 30_000 });
      expect(injected.slots.resource?.sourceIds).toContain(memoryId);
      expect(injected.slots.resource?.evidenceRefs).toEqual(expect.arrayContaining(current!.record.sourceNodeIds!));
      expect(injected.content).toContain(SYNTHETIC_ATTESTED_SOURCE);
      expect(injected.slots.resource?.recallReceipts?.some(item => item.sourceId === memoryId)).toBe(true);
      const after = evolutionCalls();
      expect((await h.capability.run(run)).batchId).toBe(applied.batchId);
      expect(evolutionCalls()).toBe(after);
      expect(await h.canonicalCount()).toBe(1);

      const revoke = { sourceId: proof.sourceId, sourceRevision: proof.revision, expectedRevision: 0,
        idempotencyKey: "revoke-synthetic-proof", operationIdempotencyKey: "retire-synthetic-proof", expiresAt: Date.now() + 60_000 };
      expect((await h.control("source/revoke-attestation", revoke, false)).status).toBe(403);
      expect(await attester.verify([proof], context)).toMatchObject({ valid: true });
      const revoked = await h.control("source/revoke-attestation", revoke);
      expect(revoked.status).toBe(200);
      expect(revoked.body).toMatchObject({ kind: "source_revocation", revision: 1 });
      expect((await h.control("source/revoke-attestation", revoke)).body).toEqual(revoked.body);
      expect(await attester.verify([proof], context)).toMatchObject({ valid: false, reason: "attestation_revoked_or_changed" });
      expect((await attester.attest({ ...context, unit: unsigned })).attestations).toEqual([]);
      // Trust revocation is not a source-retirement receipt and does not itself prove canonical/cache withdrawal.
    } finally { await h.close(); }
  }, 240_000);

  test("owner review is separate from auto apply; reviewed kind-only create reads original evidence without author promotion", async () => {
    const sourceText = "The synthetic rollout audit retention period is 37 days.";
    const h = await openNativeRolloutRuntime(sourceText);
    try {
      expect(await h.canonicalCount()).toBe(0);
      const input = { mode: "directory" as const, sourceId: "rollout-native-source" };
      const limits = { maxRecords: 20, maxFiles: 5, maxBytes: 131_072, maxLlmCalls: 1,
        maxInputTokens: 16_000, maxOutputTokens: 1000, maxDurationMs: 45_000 };
      const queued = await h.capability.run({ input, action: "propose", limits, idempotencyKey: "native-propose" });
      expect(queued.status).toBe("queued");
      const proposed = await h.waitBatch(queued.batchId);
      const proposedItems = (await h.proposals(queued.batchId)).proposals;
      expect(proposed.counts, safeNativeBatchDiagnostic(proposed, proposedItems)).toMatchObject({ proposed: 1, applied: 0, review: 1 });
      expect(await h.canonicalCount()).toBe(0);
      const proposal = proposedItems[0];
      expect(proposal).toMatchObject({ operation: "create", status: "review" });
      expect(proposal.validation.independentEvidenceRootIds).toEqual([]);
      const staged = await h.persistence.repository.getStagedEvidence(proposal.id, h.scopeFingerprint);
      expect(staged.every(source => source.trust === "untrusted")).toBe(true);

      const autoQueued = await h.capability.run({ input, action: "apply_allowed", limits, idempotencyKey: "native-auto-without-owner" });
      const auto = await h.waitBatch(autoQueued.batchId);
      expect(auto.status, safeNativeBatchDiagnostic(auto, (await h.proposals(auto.batchId)).proposals)).toBe("blocked");
      expect(auto.counts.applied).toBe(0);
      expect(auto.reasons).toContain("owner_review_required");
      expect(await h.canonicalCount()).toBe(0);
      expect((await h.control("review/preview", { proposalId: proposal.id }, false)).status).toBe(403);
      await expect(h.capability.review!.preview(proposal.id)).rejects.toThrow("EVOLUTION_OWNER_REQUIRED");

      const previewResponse = await h.control("review/preview", { proposalId: proposal.id });
      expect(previewResponse.status).toBe(200);
      const review = previewResponse.body as ReturnType<typeof publicEvolutionReview>;
      expect(review.evidence.every(evidence => evidence.trust === "untrusted")).toBe(true);
      // The decision is source/diff-only, never based on a holdout question or answer key.
      expect(review.targets).toEqual([]);
      expect(review.proposal.proposedText?.trim()).toBe(sourceText);
      expect(review.proposal.quotes.every(quote => quote.quote.trim() === sourceText)).toBe(true);
      const decision = await h.control("review/decide", { reviewId: review.id, expectedBindingHash: review.bindingHash,
        decision: "approve", idempotencyKey: "synthetic-owner-source-diff-only" });
      expect(decision.status).toBe(200);
      const approval = decision.body as EvolutionReviewReceipt;
      const beforeApplyModelCalls = h.events.filter(event => event.operation.includes("evolution")).length;
      const appliedResponse = await h.control("review/apply", { approvalReceiptId: approval.id });
      expect(appliedResponse.status).toBe(200);
      const approvedQueued = appliedResponse.body as EvolutionBatchReport;
      expect(approvedQueued.status).toBe("queued");
      const applied = await h.waitBatch(approvedQueued.batchId);
      const appliedItems = (await h.proposals(applied.batchId)).proposals;
      expect(applied, safeNativeBatchDiagnostic(applied, appliedItems)).toMatchObject({ status: "completed", counts: { applied: 1 }, usage: { llmCalls: 0 } });
      expect(h.events.filter(event => event.operation.includes("evolution"))).toHaveLength(beforeApplyModelCalls);
      expect(await h.canonicalCount()).toBe(1);
      const written = appliedItems.find(item => item.status === "applied");
      expect(written).toBeDefined();
      const receipt = await h.persistence.repository.getReceipt(written!.id, h.scopeFingerprint);
      expect(receipt?.outcome).toBe("applied");
      expect(receipt?.memoryIds).toHaveLength(1);

      const candidates = await h.provider.createGovernedRetrievalCandidateSource().search({ scope: h.scope, query: "synthetic rollout audit retention", limit: 10 });
      const engine = new GovernedRetrievalEngine(h.provider.createGovernedRetrievalHydrator());
      const lookup = await engine.retrieve({ intent: "lookup", scope: h.scope, candidates, minScore: 0 });
      const hit = lookup.hits.find(item => item.record.id === receipt!.memoryIds[0]);
      expect(hit, JSON.stringify({ candidateCount: candidates.length, hitCount: lookup.hits.length,
        filteredReasons: lookup.filtered.map(item => item.filteredReason) })).toBeDefined();
      expect(hit?.record.text).toBe(sourceText);
      expect(hit?.record).toMatchObject({ container: "session_candidate", category: "fact", lifecycleStatus: "archived",
        metadata: { admissionRoute: "lookup_only", governance: { native: { category: "fact" } } } });
      expect(hit?.record.metadata.contextEligible).toBe(false);
      expect(hit?.record.sourceNodeIds?.length).toBeGreaterThan(0);
      const raw = await h.runtime.agentFastPath.evidenceRead({ scope: h.scope, refs: hit!.record.sourceNodeIds! });
      expect(raw.evidence.some(item => item.preview.includes(sourceText))).toBe(true);
      const context = await engine.retrieve({ intent: "context", scope: h.scope, candidates, minScore: 0 });
      expect(context.hits.some(item => item.record.id === hit!.record.id)).toBe(false);
      expect((await engine.retrieve({ intent: "lookup", scope: { ...h.scope, userId: "outside-owner" }, candidates })).hits).toEqual([]);
      expect((await h.control("review/apply", { approvalReceiptId: approval.id })).body).toMatchObject({ batchId: applied.batchId });
      expect(await h.canonicalCount()).toBe(1);
    } finally { await h.close(); }
  }, 240_000);
});
