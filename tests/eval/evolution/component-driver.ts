import { authorityScopeFingerprint } from "../../../packages/core/src/domain/authority-scope-fingerprint.js";
import { MemoryEvolutionBatchService } from "../../../packages/core/src/evolution/batch-service.js";
import { InMemoryEvolutionRepository } from "../../../packages/core/src/evolution/in-memory-repository.js";
import { LlmEvolutionProposer } from "../../../packages/core/src/evolution/proposer.js";
import type { EvolutionInputPort, EvolutionProposalDraft, EvolutionProposer } from "../../../packages/core/src/evolution/types.js";
import { OpenAiLlmClient, type ChatCompletionClient } from "../../../packages/core/src/runtime/llm/llm-client.js";
import { computeCanonicalContentHash } from "../../../packages/core/src/scoring/hash-utils.js";
import { ROLLOUT_AUTHORITY } from "../../fixtures/memory-evolution-rollout/source-corpus.js";
import type { DiagnosticArmFactory, DiagnosticCost, EvolutionObservation } from "./types.js";

export const unknownCost = (): DiagnosticCost => ({ llmCalls: 0, inputTokens: null, outputTokens: null,
  embeddingCalls: 0, bytesRead: 0, databaseBytesDelta: null, costUsd: null });

/** A smoke driver for real batch/validator components, explicitly not the native RuntimeHost. */
export function createComponentDiagnosticFactory(): DiagnosticArmFactory {
  return {
    id: "real-batch-in-memory-controlled-transport/v1", executionBoundary: "component-controlled-model",
    async open(input) {
      const unit = structuredClone(input.material.unit);
      let llmCalls = 0;
      const completion: ChatCompletionClient["chat"]["completions"]["create"] = async params => {
        llmCalls++;
        if (params.model !== input.settings.models.proposer || params.temperature !== 0 || "tools" in params) throw new Error("controlled_transport_config_mismatch");
        if (input.material.fault === "model_unavailable") throw new Error("synthetic_model_unavailable");
        const message = params.messages.find(item => item.role === "user");
        if (!message) throw new Error("bounded_prompt_missing");
        const prompt = JSON.parse(message.content) as { targets: Array<{ memoryId: string; expectedRevision: number; beforeHash: string }>; evidence: Array<{ evidenceId: string; text: string }> };
        const source = prompt.evidence[0];
        const draft: EvolutionProposalDraft = { operation: prompt.targets.length ? "correct" : "create", claimClass: "fact",
          reasonCode: prompt.targets.length ? "explicit_correction" : "new_claim", targetRefs: prompt.targets.map(({ memoryId, expectedRevision, beforeHash }) => ({ memoryId, expectedRevision, beforeHash })),
          quotes: [{ evidenceId: source.evidenceId, quote: source.text, start: 0, end: source.text.length }], proposedText: source.text, kind: "fact" };
        return { choices: [{ message: { content: JSON.stringify(draft) } }] };
      };
      const client = new OpenAiLlmClient({ provider: "openai", apiKey: "synthetic-never-used", baseURL: "https://models.invalid/v1",
        model: input.settings.models.proposer, extractionModel: input.settings.models.proposer },
      { client: { chat: { completions: { create: completion } } }, maxRetries: 0 });
      const deterministic: EvolutionProposer = {
        available: true, maxAttempts: 1, estimateInputTokens: () => 1,
        async propose(current) {
          const evidence = current.evidence[0];
          const target = current.targets[0];
          const same = target?.text === evidence.text;
          return { operation: same ? "add_evidence" : "noop", claimClass: "fact", reasonCode: same ? "independent_support" : "unchanged",
            targetRefs: target ? [{ memoryId: target.memoryId, expectedRevision: target.expectedRevision, beforeHash: target.beforeHash }] : [],
            quotes: [{ evidenceId: evidence.id, quote: evidence.text, start: 0, end: evidence.text.length }],
            ...(same ? { proposedText: target.text, kind: target.kind } : {}) };
        },
      };
      // Synthetic input port and staging store are intentional substitutes, labelled in every report.
      const port: EvolutionInputPort = { mode: "inventory", async open() { return { selectionEpoch: input.settings.knownAt }; },
        async readPage(context) { return { units: context.cursor === null ? [structuredClone(unit)] : [], nextCursor: "done", complete: true,
          bytesRead: Buffer.byteLength(JSON.stringify(unit)), filesRead: 0 }; },
        async readTargets() { return structuredClone(unit.targets); },
        async verifyUnit(current) { return { valid: current.evidence.every(e => computeCanonicalContentHash(e.text) === e.snapshotHash) }; } };
      const repository = new InMemoryEvolutionRepository();
      const service = new MemoryEvolutionBatchService({ authority: ROLLOUT_AUTHORITY,
        scope: { ...unit.scope, projectId: "rollout-project" }, configFingerprint: input.settings.configFingerprint,
        repository, inputs: [port], proposer: input.arm === "B" ? deterministic : new LlmEvolutionProposer(client, { maxAttempts: 1 }) });
      let used = false;
      return { isolationKey: input.isolationKey, storageIdentity: `in-process:${input.isolationKey}`, freezeFingerprint: input.freezeFingerprint,
        async evolve() {
          if (used) throw new Error("session_already_consumed");
          used = true;
          const observation: EvolutionObservation = { status: "completed", reasons: [], cost: unknownCost(), costBasis: "component-measured",
            governance: { mode: input.governanceMode, autoApplied: 0, reviewedApplied: 0,
              reviewDecisionBasis: input.governanceMode === "auto" ? "not-requested" : "unavailable" },
            stagedCount: 0, canonicalWrites: 0, evidenceWrites: 0, confidenceDelta: 0, repeatMutationDelta: 0,
            commitToLookupMs: null, commitToContextMs: null };
          if (input.arm === "A") return observation;
          if (input.governanceMode === "reviewed") return { ...observation, status: "blocked", reasons: ["native_owner_review_unavailable"] };
          // No embedding system is instantiated here; this is an injected diagnostic fault, not a provider test.
          if (input.material.fault === "embedding_mismatch") return { ...observation, status: "blocked", reasons: ["injected_embedding_space_mismatch"] };
          for (let attempt = 0; attempt < input.material.repeatCount; attempt++) {
            const report = await service.run({ input: { mode: "inventory", selection: "baseline" }, action: "propose",
              idempotencyKey: `${input.isolationKey}:${attempt}`,
              ...(input.material.fault === "budget_exhausted" ? { limits: { maxLlmCalls: 0 } } : {}) });
            observation.status = report.status === "partial" ? "partial" : report.status === "completed" ? "completed" : "blocked";
            observation.reasons.push(...report.reasons);
            observation.stagedCount! += report.counts.proposed;
            observation.canonicalWrites! += report.counts.applied;
            observation.cost.bytesRead! += report.usage.bytes;
          }
          observation.reasons = [...new Set(observation.reasons)];
          observation.cost.llmCalls = llmCalls;
          return observation;
        },
        async answer(question) {
          // Baseline-only fixture reader. No claim of governed context/hydration is made.
          const candidate = unit.targets.find(target => authorityScopeFingerprint(target.scope) === authorityScopeFingerprint(question.scope));
          return { status: candidate ? "answered" : "abstained", ...(candidate ? { text: candidate.text } : {}),
            evidenceIds: candidate?.evidenceRootIds ?? [], injected: null, cost: unknownCost() };
        },
        async close() { /* All state is isolated, in-process and unreachable after this session. */ },
      };
    },
  };
}
