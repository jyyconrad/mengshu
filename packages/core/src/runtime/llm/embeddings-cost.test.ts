import { describe, expect, test, vi } from "vitest";
import type { RuntimePricingSnapshot } from "../../cost/runtime-cost.js";
import { Embeddings, type EmbeddingClient } from "./embeddings.js";

const pricing: RuntimePricingSnapshot = {
  version: "pricing-test-v1",
  provider: "openai",
  currency: "USD",
  minorUnitsPerMajor: 100,
  models: { "embed-test": { embeddingPerMillion: 1 } },
};

const embeddingConfig = {
  apiKey: "test-key",
  baseURL: "https://example.test/v1",
  model: "embed-test",
  provider: "openai" as const,
};

describe("Embeddings runtime cost instrumentation", () => {
  test("embed delegates to the provider batch entry without duplicate events", async () => {
    const events: unknown[] = [];
    const client: EmbeddingClient = { embeddings: { create: vi.fn(async () => ({
      data: [{ embedding: [0.1, 0.2] }],
      usage: { prompt_tokens: 8 },
    })) } };
    const embeddings = new Embeddings(embeddingConfig, undefined, {
      client,
      maxRetries: 0,
      costLedger: { append: async (value) => { events.push(value); } },
      pricingSnapshot: pricing,
      costContext: {
        category: "native_memory",
        scopeFingerprint: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    });

    await expect(embeddings.embed("private body")).resolves.toEqual([0.1, 0.2]);
    expect(events).toMatchObject([{
      operation: "embedding.batch",
      status: "succeeded",
      inputTokens: null,
      outputTokens: null,
      embeddingUnits: 8,
      embeddingUnitKind: "tokens",
      attempt: 1,
    }]);
    expect(JSON.stringify(events)).not.toContain("private body");
  });

  test("records failed provider attempts and reports unpriced input-count fallback", async () => {
    const failed: unknown[] = [];
    const failing = new Embeddings(embeddingConfig, undefined, {
      client: { embeddings: { create: async () => { throw new Error("503 unavailable"); } } },
      maxRetries: 0,
      costLedger: { append: async (value) => { failed.push(value); } },
      pricingSnapshot: pricing,
    });
    await expect(failing.embedBatch(["a", "b"])).rejects.toThrow();
    expect(failed).toMatchObject([{ status: "failed", attempt: 1 }]);

    const succeeded: unknown[] = [];
    const noUsage = new Embeddings(embeddingConfig, undefined, {
      client: { embeddings: { create: async () => ({
        data: [{ embedding: [1] }, { embedding: [2] }],
      }) } },
      maxRetries: 0,
      costLedger: { append: async (value) => { succeeded.push(value); } },
      pricingSnapshot: pricing,
    });
    await noUsage.embedBatch(["a", "b"]);
    expect(succeeded).toMatchObject([{
      embeddingUnits: 2,
      embeddingUnitKind: "inputs",
      estimatedMinorUnits: null,
    }]);
  });
});
