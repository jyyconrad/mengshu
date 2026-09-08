import { authorityScopeFingerprint } from "../../../packages/core/src/domain/authority-scope-fingerprint.js";
import { computeCanonicalContentHash } from "../../../packages/core/src/scoring/hash-utils.js";
import { GovernedRetrievalEngine } from "../../../packages/core/src/retrieval/governed-retrieval-engine.js";
import type { EvolutionBatchReport } from "../../../packages/core/src/evolution/types.js";
import type { publicEvolutionReview } from "../../../packages/api/src/evolution-review.js";
import { openNativeRolloutRuntime } from "../../fixtures/memory-evolution-rollout/native-runtime.js";
import { ROLLOUT_SCOPE } from "../../fixtures/memory-evolution-rollout/source-corpus.js";
import { unknownCost } from "./component-driver.js";
import { createNativePilotSettings } from "./native-create-pilot.js";
import { evolutionHash } from "../../../packages/core/src/evolution/fingerprints.js";
import type { DiagnosticArmFactory, EvolutionObservation } from "./types.js";

export interface NativePilotReviewPolicy {
  id: string;
  /** Operator decision sees only source and exact staged diff, never question/oracle/verifier. */
  decide(input: { sourceText: string; review: ReturnType<typeof publicEvolutionReview> }): Promise<"approve" | "reject">;
}

/** Real default RuntimeHost + actual globally configured LLM, restricted to a bounded create-only pilot. */
export function createNativeRuntimeDiagnosticFactory(options: { reviewPolicy?: NativePilotReviewPolicy } = {}): DiagnosticArmFactory {
  return { id: "default-runtime-global-model-create-pilot/v1", executionBoundary: "isolated-postgres-real-model",
    async open(input) {
      if (input.material.unit.targets.length !== 0 || input.material.unit.evidence.length !== 1 || input.material.fault ||
          authorityScopeFingerprint(input.material.unit.scope) !== authorityScopeFingerprint(ROLLOUT_SCOPE)) {
        throw new Error("native_create_pilot_requires_empty_baseline_single_source");
      }
      const sourceText = input.material.unit.evidence[0].text;
      const h = await openNativeRolloutRuntime(sourceText);
      try {
        const actualSettings = createNativePilotSettings(h.runtime.config, input.settings.knownAt);
        if (evolutionHash(actualSettings) !== evolutionHash(input.settings) || input.settings.models.embedding !== h.runtime.embeddingSpace.fingerprint.model) {
          throw new Error("frozen_native_configuration_mismatch");
        }
      } catch (error) { await h.close(); throw error; }
      const before = await h.canonicalCount();
      let ran = false;
      let observation: EvolutionObservation;
      const cost = () => {
        const events = h.events.filter(event => event.operation.includes("evolution"));
        const total = (field: "inputTokens" | "outputTokens") => events.length && events.every(event => event[field] !== null)
          ? events.reduce((sum, event) => sum + event[field]!, 0) : null;
        const known = unknownCost();
        known.llmCalls = events.length;
        known.inputTokens = total("inputTokens");
        known.outputTokens = total("outputTokens");
        // No invented billing or database growth; native ledger observation is kept separately from reservations.
        known.embeddingCalls = h.events.filter(event => event.embeddingUnitKind !== null).length;
        return known;
      };
      return { isolationKey: input.isolationKey, storageIdentity: h.schema, freezeFingerprint: input.freezeFingerprint,
        async evolve() {
          if (ran) throw new Error("native_session_already_consumed");
          ran = true;
          observation = { status: "completed", reasons: [], cost: unknownCost(), costBasis: "measured",
            governance: { mode: input.governanceMode, autoApplied: 0, reviewedApplied: 0,
              reviewDecisionBasis: input.governanceMode === "auto" ? "not-requested" : options.reviewPolicy ? "owner-source-diff-only" : "unavailable",
              ...(options.reviewPolicy ? { reviewPolicyId: options.reviewPolicy.id } : {}) },
            stagedCount: 0, canonicalWrites: 0, evidenceWrites: null, confidenceDelta: null, repeatMutationDelta: null,
            commitToLookupMs: null, commitToContextMs: null };
          // A keeps the empty baseline. B has no authorized deterministic change for this create-only cohort.
          if (input.arm !== "C") return observation;
          const request = { input: { mode: "directory" as const, sourceId: "rollout-native-source" }, action: "propose" as const,
            limits: { maxRecords: 20, maxFiles: 5, maxBytes: 131_072, maxLlmCalls: 1, maxInputTokens: 16_000, maxOutputTokens: 1000, maxDurationMs: 45_000 } };
          let last: EvolutionBatchReport | undefined;
          let proposalId: string | undefined;
          for (let index = 0; index < input.material.repeatCount; index++) {
            const queued = await h.capability.run({ ...request, idempotencyKey: `native-pilot-propose-${index}` });
            last = await h.waitBatch(queued.batchId);
            observation.stagedCount! += last.counts.proposed;
            observation.cost.bytesRead! += last.usage.bytes;
            proposalId ??= (await h.proposals(queued.batchId)).proposals[0]?.id;
          }
          if (!proposalId || !last || last.status !== "completed") {
            observation.status = last?.status === "partial" ? "partial" : "blocked";
            observation.reasons = last?.reasons ?? ["native_proposal_unavailable"];
          } else if (input.governanceMode === "auto") {
            const queued = await h.capability.run({ ...request, action: "apply_allowed", idempotencyKey: "native-pilot-auto" });
            const result = await h.waitBatch(queued.batchId);
            observation.status = result.status === "completed" ? "completed" : result.status === "partial" ? "partial" : "blocked";
            observation.reasons = result.reasons;
            observation.governance.autoApplied = result.counts.applied;
          } else if (!options.reviewPolicy) {
            observation.status = "blocked";
            observation.reasons = ["independent_owner_review_policy_required"];
          } else {
            const response = await h.control("review/preview", { proposalId });
            if (response.status !== 200) throw new Error("native_owner_review_unavailable");
            const review = response.body as ReturnType<typeof publicEvolutionReview>;
            const decision = await options.reviewPolicy.decide({ sourceText, review: structuredClone(review) });
            const result = await h.control("review/decide", { reviewId: review.id, expectedBindingHash: review.bindingHash,
              decision, idempotencyKey: `native-pilot-owner-${decision}` });
            if (result.status !== 200) throw new Error("native_review_decision_failed");
            if (decision === "reject") { observation.status = "blocked"; observation.reasons = ["owner_rejected_source_diff"]; }
            else {
              const approved = await h.control("review/apply", { approvalReceiptId: (result.body as { id: string }).id });
              if (approved.status !== 200) throw new Error("native_review_apply_failed");
              const report = await h.waitBatch((approved.body as EvolutionBatchReport).batchId);
              observation.status = report.status === "completed" ? "completed" : "blocked";
              observation.reasons = report.reasons;
              observation.governance.reviewedApplied = report.counts.applied;
            }
          }
          observation.canonicalWrites = await h.canonicalCount() - before;
          observation.cost = { ...cost(), bytesRead: observation.cost.bytesRead };
          return observation;
        },
        async answer(question) {
          const candidates = await h.provider.createGovernedRetrievalCandidateSource().search({ scope: question.scope, query: question.text, limit: input.settings.topK });
          const engine = new GovernedRetrievalEngine(h.provider.createGovernedRetrievalHydrator());
          const lookup = await engine.retrieve({ intent: "lookup", scope: question.scope, candidates, limit: input.settings.topK, minScore: 0 });
          const first = lookup.hits[0];
          const evidenceIds = first?.record.sourceNodeIds ?? [];
          const raw = evidenceIds.length ? await h.runtime.agentFastPath.evidenceRead({ scope: question.scope, refs: evidenceIds }) : { evidence: [] };
          const originals = evidenceIds.length ? await h.persistence.inventory.hydrateEvidence(question.scope, evidenceIds) : [];
          const readable = new Set(raw.evidence.map(evidence => evidence.ref));
          return { status: first ? "answered" : "abstained", ...(first ? { text: first.record.text } : {}), evidenceIds,
            hydratedEvidence: originals.filter(evidence => readable.has(evidence.id))
              .map(evidence => ({ id: evidence.id, textHash: computeCanonicalContentHash(evidence.text), scope: evidence.scope })),
            // A governed lookup is not a context assembly. Do not claim context coverage for this bounded pilot.
            injected: null, cost: unknownCost() };
        },
        close: h.close,
      };
    },
  };
}

// CLI default never approves a plan on its own; reviewed pilots need an explicit operator adapter/policy.
export function createDiagnosticFactory(): DiagnosticArmFactory { return createNativeRuntimeDiagnosticFactory(); }
