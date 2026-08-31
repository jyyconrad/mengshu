import { describe, expect, test, vi } from "vitest";
import type { MemoryConfig } from "../../../../../config.js";
import type { RuntimeCostEventSink, RuntimePricingSnapshot } from "../../cost/runtime-cost.js";
import {
  OpenAiLlmClient,
  type ChatCompletionClient,
} from "./llm-client.js";

const config: NonNullable<MemoryConfig["llm"]> = {
  provider: "openai",
  model: "gpt-test",
  apiKey: "test-key",
  baseURL: "https://example.test/v1",
};

const pricing: RuntimePricingSnapshot = {
  version: "pricing-test-v1",
  provider: "openai",
  currency: "USD",
  minorUnitsPerMajor: 100,
  models: { "gpt-test": { inputPerMillion: 2, outputPerMillion: 4 } },
};

describe("OpenAiLlmClient runtime cost instrumentation", () => {
  test("records exactly one event per provider attempt and accounts retry usage", async () => {
    let attempts = 0;
    const events: unknown[] = [];
    const client: ChatCompletionClient = {
      chat: { completions: { create: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient");
        return {
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 120, completion_tokens: 30 },
        };
      } } },
    };
    const llm = new OpenAiLlmClient(config, {
      client,
      maxRetries: 1,
      minTimeout: 1,
      maxTimeout: 1,
      costLedger: { append: async (value) => { events.push(value); } },
      pricingSnapshot: pricing,
      costContext: {
        category: "native_memory",
        scopeFingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    });

    await expect(llm.complete([{ role: "user", content: "secret prompt" }])).resolves.toBe("ok");
    expect(events).toMatchObject([
      { operation: "llm.complete", status: "failed", attempt: 1, inputTokens: null, outputTokens: null },
      { operation: "llm.complete", status: "succeeded", attempt: 2, inputTokens: 120, outputTokens: 30 },
    ]);
    expect(JSON.stringify(events)).not.toContain("secret prompt");
  });

  test("summarize delegates to complete without duplicate ledger events", async () => {
    const append = vi.fn<RuntimeCostEventSink["append"]>().mockResolvedValue(undefined);
    const client: ChatCompletionClient = {
      chat: { completions: { create: async () => ({
        choices: [{ message: { content: "summary" } }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }) } },
    };
    const llm = new OpenAiLlmClient(config, {
      client,
      costLedger: { append },
      pricingSnapshot: pricing,
    });

    await llm.summarize("private body", "summarize");
    expect(append).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ operation: "llm.summarize" }));
  });

  test("ledger failure warns but never retries or fails a successful provider call", async () => {
    const create = vi.fn(async () => ({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
    const warn = vi.fn();
    const llm = new OpenAiLlmClient(config, {
      client: { chat: { completions: { create } } },
      costLedger: { append: async () => { throw new Error("disk full"); } },
      onCostLedgerError: warn,
      pricingSnapshot: pricing,
      maxRetries: 2,
      minTimeout: 1,
      maxTimeout: 1,
    });

    await expect(llm.complete([{ role: "user", content: "x" }])).resolves.toBe("ok");
    expect(create).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("structured parsing failures and retries are recorded at the provider attempt boundary", async () => {
    let attempt = 0;
    const events: unknown[] = [];
    const llm = new OpenAiLlmClient(config, {
      client: { chat: { completions: { create: async () => {
        attempt += 1;
        return {
          choices: [{ message: { content: attempt === 1 ? "{invalid" : '{"ok":true}' } }],
          usage: { prompt_tokens: 20, completion_tokens: 3 },
        };
      } } } },
      costLedger: { append: async (value) => { events.push(value); } },
      pricingSnapshot: pricing,
      maxRetries: 1,
      minTimeout: 1,
      maxTimeout: 1,
    });

    await expect(llm.extractStructured(
      [{ role: "user", content: "extract" }],
      { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
    )).resolves.toEqual({ ok: true });
    expect(events).toMatchObject([
      { operation: "llm.extract_structured", status: "failed", attempt: 1, inputTokens: 20 },
      { operation: "llm.extract_structured", status: "succeeded", attempt: 2, inputTokens: 20 },
    ]);
  });

  test("copies call-level policy attribution into every provider attempt", async () => {
    const events: unknown[] = [];
    const scopeFingerprint = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const llm = new OpenAiLlmClient(config, {
      client: { chat: { completions: { create: async () => ({
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 20, completion_tokens: 3 },
      }) } } },
      costLedger: { append: async (value) => { events.push(value); } },
      pricingSnapshot: pricing,
    });

    await llm.extractStructured(
      [{ role: "user", content: "extract" }],
      { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
      {
        costContext: {
          category: "policy_overlay",
          scopeFingerprint,
          operation: "candidate.extract",
          policyResolution: {
            scopeFingerprint: "a".repeat(64),
            layer: "candidate_extraction",
            overlayId: "policy-1",
            overlayVersion: 2,
            contentHash: "b".repeat(64),
            guardVersion: "memory-policy-guard-v1",
            resolutionHash: "c".repeat(64),
          },
        },
      },
    );

    expect(events).toMatchObject([{
      operation: "candidate.extract",
      category: "policy_overlay",
      policyResolution: { overlayId: "policy-1", overlayVersion: 2 },
    }]);
  });
});
