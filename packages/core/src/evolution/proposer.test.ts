import { describe, expect, it, vi } from "vitest";
import { LlmEvolutionProposer, abortableEvolution, serializedEvolutionProposal } from "./proposer.js";
import { OpenAiLlmClient, NullLlmClient } from "../runtime/llm/llm-client.js";
import type { ChatCompletionClient } from "../runtime/llm/llm-client.js";
import { draft, unit } from "./test-fixtures.js";

describe("host-owned evolution proposer", () => {
  it("uses the global extraction model, temperature zero, strict schema and no tool permissions", async () => {
    const input = unit();
    input.evidence[0].contextIncomplete = true;
    const create = vi.fn<ChatCompletionClient["chat"]["completions"]["create"]>(async () => ({ choices: [{ message: { content: JSON.stringify(draft(input)) } }] }));
    const client = new OpenAiLlmClient({ provider: "openai", apiKey: "synthetic", model: "host-default", extractionModel: "host-extraction", baseURL: "https://model.invalid/v1" }, { client: { chat: { completions: { create } } }, maxRetries: 0 });
    const proposer = new LlmEvolutionProposer(client, { maxAttempts: 1 });
    expect(proposer.estimateInputTokens(input)).toBeGreaterThan(Buffer.byteLength(JSON.stringify(input)));
    expect(await proposer.propose(input, { maxOutputTokens: 256, timeoutMs: 50000 })).toEqual(draft(input));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: "host-extraction", temperature: 0, max_tokens: 256, response_format: { type: "json_object" } }), expect.objectContaining({ maxRetries: 0, timeout: 30000, signal: expect.any(AbortSignal) }));
    expect(create.mock.calls[0][0]).not.toHaveProperty("tools");
    const message = create.mock.calls[0][0].messages.find(m => m.role === "user")!;
    expect(JSON.parse(message.content).evidence[0].contextIncomplete).toBe(true);
  });
  it("unavailable model fails closed, invalid retry reservations reject", async () => {
    const proposer = new LlmEvolutionProposer(new NullLlmClient());
    expect(proposer.available).toBe(false);
    expect(proposer.maxAttempts).toBe(4);
    await expect(proposer.propose(unit(), { maxOutputTokens: 10, timeoutMs: 10 })).rejects.toThrow("model_unavailable");
    for (const maxAttempts of [0, -1, 11, NaN, 1.2]) expect(() => new LlmEvolutionProposer(new NullLlmClient(), { maxAttempts })).toThrow("model_attempt_budget_invalid");
  });
  it("serializes separate batches until a cancelled noncooperative model actually settles", async () => {
    let finish!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    const hold = new Promise<void>(resolve => { finish = resolve; });
    const controller = new AbortController();
    const first = serializedEvolutionProposal(async () => { started(); await hold; return 1; }, controller.signal);
    await startedPromise;
    controller.abort();
    await expect(first).rejects.toThrow("cancelled");
    const next = vi.fn(async () => 2);
    const second = serializedEvolutionProposal(next);
    await Promise.resolve();
    expect(next).not.toHaveBeenCalled();
    finish();
    expect(await second).toBe(2);
  });
  it("never dispatches a queued cancelled call and handles already-aborted promises", async () => {
    const controller = new AbortController();
    controller.abort();
    const call = vi.fn(async () => 1);
    await expect(serializedEvolutionProposal(call, controller.signal)).rejects.toThrow("cancelled");
    expect(call).not.toHaveBeenCalled();
    await expect(abortableEvolution(Promise.resolve(1), controller.signal)).rejects.toThrow("cancelled");
    expect(await abortableEvolution(Promise.resolve(2))).toBe(2);
    await expect(abortableEvolution(Promise.reject(new Error("provider_failed")), new AbortController().signal)).rejects.toThrow("provider_failed");
  });
});
