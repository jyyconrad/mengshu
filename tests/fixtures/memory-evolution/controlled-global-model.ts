import { vi } from "vitest";

import { LlmEvolutionProposer } from "../../../packages/core/src/evolution/proposer.js";
import type { EvolutionProposalDraft } from "../../../packages/core/src/evolution/types.js";
import {
  OpenAiLlmClient,
  type ChatCompletionClient,
} from "../../../packages/core/src/runtime/llm/llm-client.js";

interface ProposalPrompt {
  targets: Array<{
    memoryId: string; expectedRevision: number; beforeHash: string;
    kind: EvolutionProposalDraft["kind"]; semanticType?: EvolutionProposalDraft["semanticType"];
  }>;
  evidence: Array<{ evidenceId: string; text: string }>;
}

export function controlledGlobalModel(
  respond?: (draft: EvolutionProposalDraft, prompt: ProposalPrompt) => unknown | Promise<unknown>,
) {
  const completion = vi.fn<ChatCompletionClient["chat"]["completions"]["create"]>(async (params) => {
    const message = params.messages.find((item) => item.role === "user");
    if (!message) throw new Error("Missing bounded evolution input");
    const prompt = JSON.parse(message.content) as ProposalPrompt;
    const source = prompt.evidence[0]!;
    const target = prompt.targets[0];
    const draft: EvolutionProposalDraft = {
      operation: target ? "evolve" : "create",
      claimClass: target ? "constraint" : "fact",
      reasonCode: target ? "attribute_changed" : "new_claim",
      targetRefs: prompt.targets.map(({ memoryId, expectedRevision, beforeHash }) => ({
        memoryId, expectedRevision, beforeHash,
      })),
      quotes: [{ evidenceId: source.evidenceId, quote: source.text, start: 0, end: source.text.length }],
      proposedText: source.text, kind: target?.kind ?? "fact",
      ...(target?.semanticType ? { semanticType: target.semanticType } : {}),
    };
    const response = respond ? await respond(draft, prompt) : draft;
    return { choices: [{ message: { content: JSON.stringify(response) } }] };
  });
  const client = new OpenAiLlmClient({
    provider: "openai", apiKey: "synthetic-acceptance-key", model: "acceptance-global-default",
    extractionModel: "acceptance-global-extractor", baseURL: "https://models.invalid/v1",
  }, { client: { chat: { completions: { create: completion } } }, maxRetries: 0 });
  return { completion, client, proposer: new LlmEvolutionProposer(client, { maxAttempts: 1 }) };
}
