import { afterEach, describe, expect, test, vi } from "vitest";
import http from "node:http";
import https from "node:https";
import { Socket } from "node:net";
import { memoryConfigSchema } from "../../config.js";
import { PostgresProvider } from "../../packages/core/src/db/providers/postgres.js";
import type { EvolutionApplyDiagnostic } from "../../packages/core/src/evolution/governed-diagnostics.js";
import type { EvolutionBatchReport, EvolutionInputUnit, EvolutionReviewReceipt } from "../../packages/core/src/evolution/types.js";
import { LlmEvolutionProposer } from "../../packages/core/src/evolution/proposer.js";
import { parseEvolutionProposal } from "../../packages/core/src/evolution/schema.js";
import { validateEvolutionProposal } from "../../packages/core/src/evolution/proposal-validation.js";
import { Embeddings } from "../../packages/core/src/runtime/llm/embeddings.js";
import { createLlmClient } from "../../packages/core/src/runtime/llm/llm-client.js";
import { computeCanonicalContentHash } from "../../packages/core/src/scoring/hash-utils.js";
import type { publicEvolutionReview } from "../../packages/api/src/evolution-review.js";
import { CONTROLLED_NATIVE_SOURCE, createNativeRolloutConfig, installControlledNativeModelTransport, openNativeRolloutRuntime } from "../fixtures/memory-evolution-rollout/native-runtime.js";
import { ROLLOUT_SCOPE } from "../fixtures/memory-evolution-rollout/source-corpus.js";
import { safeNativeBatchDiagnostic } from "../fixtures/memory-evolution-rollout/startup-diagnostics.js";

const liveEnabled = process.env.MENGSHU_RUN_LIVE_TESTS === "1" && process.env.MENGSHU_EVOLUTION_ISOLATED_DB === "1";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

test("controlled fixture configuration is explicit and cannot inherit real model settings", async () => {
  const base = memoryConfigSchema.parse({ embedding: { apiKey: "not-used", baseURL: "https://not-used.invalid/v1" },
    llm: { apiKey: "not-used", model: "not-used", baseURL: "https://not-used.invalid/v1" } });
  const config = createNativeRolloutConfig(base, undefined, "/synthetic/source", "synthetic-owner-secret-not-a-credential",
    { modelTransport: "controlled_synthetic" });
  expect(config.llm?.model).toBe("controlled-synthetic-proposal");
  expect(config.embedding.apiKey).toBe("synthetic-transport-only");
  expect(JSON.stringify(config)).not.toContain("not-used");
  expect(config.evolution?.attestation).toBeUndefined();
  expect(memoryConfigSchema.parse(config)).toEqual(config);
  vi.stubEnv("MENGSHU_RUN_LIVE_TESTS", "0");
  vi.stubEnv("MENGSHU_EVOLUTION_REAL_MODEL", "0");
  await expect(openNativeRolloutRuntime(CONTROLLED_NATIVE_SOURCE, { modelTransport: "controlled_synthetic" }))
    .rejects.toThrow("native_rollout_requires_explicit_live_and_real_model_opt_in");
  vi.stubEnv("MENGSHU_RUN_LIVE_TESTS", "1");
  vi.stubEnv("MENGSHU_EVOLUTION_ISOLATED_DB", "0");
  await expect(openNativeRolloutRuntime(CONTROLLED_NATIVE_SOURCE, { modelTransport: "controlled_synthetic" }))
    .rejects.toThrow("controlled_native_requires_unsigned_synthetic_source_and_isolated_db");
  await expect(openNativeRolloutRuntime(CONTROLLED_NATIVE_SOURCE))
    .rejects.toThrow("native_rollout_requires_explicit_live_and_real_model_opt_in");
});

test("controlled transport is deterministic, remains owner-review and blocks network without connecting", async () => {
  const originalPropose = LlmEvolutionProposer.prototype.propose, originalEmbed = Embeddings.prototype.embedBatch;
  const transport = await installControlledNativeModelTransport();
  try {
    const base = memoryConfigSchema.parse({ embedding: { apiKey: "not-used", baseURL: "https://not-used.invalid/v1" } });
    const config = createNativeRolloutConfig(base, undefined, "/synthetic/source", "synthetic-owner-secret-not-a-credential", { modelTransport: "controlled_synthetic" });
    const snapshotHash = computeCanonicalContentHash(CONTROLLED_NATIVE_SOURCE);
    const unit: EvolutionInputUnit = { id: "controlled-unit", scope: ROLLOUT_SCOPE, snapshotHash, targets: [], evidence: [{
      id: "controlled-evidence", sourceId: "rollout-native-source", revision: "1", snapshotHash, text: CONTROLLED_NATIVE_SOURCE,
      scope: ROLLOUT_SCOPE, rootEvidenceId: "controlled-root", trust: "untrusted", origin: "external",
    }] };
    const proposer = new LlmEvolutionProposer(createLlmClient(config.llm), { maxAttempts: 1 });
    const draft = parseEvolutionProposal(await proposer.propose(unit, { maxOutputTokens: 1000, timeoutMs: 1000 }));
    expect(draft.semanticType).toBeUndefined();
    expect(validateEvolutionProposal(draft, unit, ROLLOUT_SCOPE)).toMatchObject({ outcome: "review", reviewRequirement: "owner",
      reasons: ["source_authority_unverified"], independentEvidenceRootIds: [], contextEligible: false });
    const vector = await new Embeddings(config.embedding).embed(CONTROLLED_NATIVE_SOURCE);
    expect(vector.length).toBe(1536);
    expect(vector.every(Number.isFinite)).toBe(true);
    expect(vector.reduce((sum, value) => sum + value * value, 0)).toBe(1);
    await expect(fetch("https://controlled.invalid/never-send")).rejects.toThrow("controlled_runtime_network_forbidden");
    for (const client of [http, https]) {
      expect(() => client.request("https://controlled.invalid/never-send")).toThrow("controlled_runtime_network_forbidden");
      expect(() => client.get("https://controlled.invalid/never-send")).toThrow("controlled_runtime_network_forbidden");
    }
    const socket = new Socket();
    try { expect(() => socket.connect(443, "controlled.invalid")).toThrow("controlled_runtime_network_forbidden"); }
    finally { socket.destroy(); }
    expect(transport.snapshot()).toEqual({ mode: "controlled_synthetic", proposalCalls: 1, embeddingCalls: 1, blockedNetworkCalls: 6 });
  } finally { transport.restore(); }
  expect(LlmEvolutionProposer.prototype.propose).toBe(originalPropose);
  expect(Embeddings.prototype.embedBatch).toBe(originalEmbed);
});

describe.skipIf(!liveEnabled)("R20 default RuntimeHost + isolated real PG + controlled synthetic model transport, not a real-model test", () => {
  test("untrusted propose -> independent owner review -> native apply -> lookup, never active context", async () => {
    const diagnostics: EvolutionApplyDiagnostic[] = [];
    const original = PostgresProvider.prototype.createEvolutionPersistence;
    // Preserve the actual provider-owned factory, kernel, transaction hooks, validator and owner review.
    const factory = vi.spyOn(PostgresProvider.prototype, "createEvolutionPersistence").mockImplementation(function (this: PostgresProvider, scope, options = {}) {
      const previous = options.writer?.onDiagnostic;
      return original.call(this, scope, { ...options, writer: { ...options.writer, onDiagnostic: event => {
        if (diagnostics.length < 8) diagnostics.push({ phase: event.phase, code: event.code,
          ...(event.transactionPhase ? { transactionPhase: event.transactionPhase } : {}),
          ...(event.sqlState && /^[A-Z0-9]{5}$/.test(event.sqlState) ? { sqlState: event.sqlState } : {}) });
        previous?.(event);
      } } });
    });
    const h = await openNativeRolloutRuntime(CONTROLLED_NATIVE_SOURCE, { modelTransport: "controlled_synthetic" });
    try {
      const diagnostic = (batch: EvolutionBatchReport, proposals: unknown) => JSON.stringify({
        transport: h.controlledTransport!.snapshot(), batch: JSON.parse(safeNativeBatchDiagnostic(batch, proposals)), applyDiagnostics: diagnostics,
      });
      expect(h.host.snapshot().ready).toBe(true);
      expect(h.controlledTransport!.snapshot()).toMatchObject({ mode: "controlled_synthetic", proposalCalls: 0, blockedNetworkCalls: 0 });
      expect(await h.canonicalCount()).toBe(0);
      const input = { mode: "directory" as const, sourceId: "rollout-native-source" };
      const limits = { maxRecords: 100, maxFiles: 5, maxBytes: 1_000_000, maxLlmCalls: 1,
        maxInputTokens: 16_000, maxOutputTokens: 1000, maxDurationMs: 45_000 };
      const queued = await h.capability.run({ input, action: "propose", limits, idempotencyKey: "controlled-native-propose" });
      expect(queued.status).toBe("queued");
      expect(h.controlledTransport!.snapshot().proposalCalls).toBe(0);
      const proposed = await h.waitBatch(queued.batchId);
      const items = (await h.proposals(proposed.batchId)).proposals;
      const proposedDiagnostic = diagnostic(proposed, items);
      expect(proposed.counts, proposedDiagnostic).toMatchObject({ proposed: 1, applied: 0, review: 1 });
      expect(items.length, proposedDiagnostic).toBe(1);
      expect(h.controlledTransport!.snapshot().proposalCalls, proposedDiagnostic).toBe(1);
      const proposal = items[0];
      expect(proposal.status, proposedDiagnostic).toBe("review");
      expect(proposal.semanticType, proposedDiagnostic).toBeUndefined();
      expect(proposal.validation.independentEvidenceRootIds.length, proposedDiagnostic).toBe(0);
      expect(proposal.validation.reviewRequirement, proposedDiagnostic).toBe("owner");
      expect(proposal.validation.reasons, proposedDiagnostic).toContain("source_authority_unverified");
      const staged = await h.persistence.repository.getStagedEvidence(proposal.id, h.scopeFingerprint);
      expect(staged.length, proposedDiagnostic).toBe(1);
      expect(staged.every(source => source.trust === "untrusted" && !source.hostAttestation), proposedDiagnostic).toBe(true);
      expect(await h.canonicalCount(), proposedDiagnostic).toBe(0);

      expect((await h.control("review/preview", { proposalId: proposal.id }, false)).status).toBe(403);
      const preview = await h.control("review/preview", { proposalId: proposal.id });
      expect(preview.status, proposedDiagnostic).toBe(200);
      const review = preview.body as ReturnType<typeof publicEvolutionReview>;
      // Independent owner policy checks only this synthetic source/diff. No question, oracle, author or trust grant.
      expect(review.targets.length).toBe(0);
      expect(review.evidence.length).toBe(1);
      expect(review.evidence.every(source => source.trust === "untrusted")).toBe(true);
      expect(review.proposal.proposedText === CONTROLLED_NATIVE_SOURCE).toBe(true);
      expect(review.proposal.quotes.length).toBe(1);
      expect(review.proposal.quotes.every(quote => quote.quote === CONTROLLED_NATIVE_SOURCE && quote.start === 0 && quote.end === CONTROLLED_NATIVE_SOURCE.length)).toBe(true);
      const decision = await h.control("review/decide", { reviewId: review.id, expectedBindingHash: review.bindingHash,
        decision: "approve", idempotencyKey: "controlled-owner-source-diff-only" });
      expect(decision.status, proposedDiagnostic).toBe(200);
      const approval = decision.body as EvolutionReviewReceipt;
      const response = await h.control("review/apply", { approvalReceiptId: approval.id });
      expect(response.status, proposedDiagnostic).toBe(200);
      const approvedQueued = response.body as EvolutionBatchReport;
      expect(approvedQueued.status, diagnostic(approvedQueued, [])).toBe("queued");
      expect(h.controlledTransport!.snapshot().proposalCalls).toBe(1);
      const applied = await h.waitBatch(approvedQueued.batchId);
      const appliedItems = (await h.proposals(applied.batchId)).proposals;
      const appliedDiagnostic = diagnostic(applied, appliedItems);
      expect({ status: applied.status, counts: applied.counts, llmCalls: applied.usage.llmCalls }, appliedDiagnostic)
        .toMatchObject({ status: "completed", counts: { applied: 1, rejected: 0 }, llmCalls: 0 });
      expect(h.controlledTransport!.snapshot().proposalCalls, appliedDiagnostic).toBe(1);
      expect(h.controlledTransport!.snapshot().embeddingCalls, appliedDiagnostic).toBeGreaterThan(0);
      expect(factory.mock.calls.some(([, options]) => !!options?.job && !!options.kernelDependencies), appliedDiagnostic).toBe(true);
      const written = appliedItems.find(item => item.status === "applied");
      expect(!!written, appliedDiagnostic).toBe(true);
      expect(written!.validation.contextEligible, appliedDiagnostic).toBe(false);
      expect(written!.validation.independentEvidenceRootIds.length, appliedDiagnostic).toBe(0);
      expect(written!.validation.reasons, appliedDiagnostic).toContain("owner_reviewed_reference");
      const receipt = await h.persistence.repository.getReceipt(written!.id, h.scopeFingerprint);
      expect(receipt?.outcome, appliedDiagnostic).toBe("applied");
      expect(receipt?.memoryIds.length, appliedDiagnostic).toBe(1);
      const memoryId = receipt!.memoryIds[0];
      const lookup = await h.runtime.agentFastPath.lookup({ scope: h.scope, query: CONTROLLED_NATIVE_SOURCE, minScore: 0, limit: 10 });
      expect(lookup.hits.some(hit => hit.id === memoryId), appliedDiagnostic).toBe(true);
      const context = await h.runtime.agentFastPath.context({ scope: h.scope, task: "What is the synthetic rollout audit retention period?", tokenBudget: 4000, latencyBudgetMs: 30_000 });
      expect(Object.values(context.slots).some(slot => slot?.sourceIds.includes(memoryId)), appliedDiagnostic).toBe(false);
      expect(context.content.includes(CONTROLLED_NATIVE_SOURCE), appliedDiagnostic).toBe(false);
      expect(await h.canonicalCount(), appliedDiagnostic).toBe(1);
      expect(h.controlledTransport!.snapshot().blockedNetworkCalls, appliedDiagnostic).toBe(0);
    } finally { await h.close(); }
  }, 180_000);
});
