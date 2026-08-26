import { describe, expect, test } from "vitest";
import { memoryConfigSchema } from "../../../../config.js";
import { runtimePricingSnapshotFromConfig } from "./runtime-pricing.js";

const baseConfig = {
  embedding: {
    provider: "openai",
    apiKey: "test-key",
    baseURL: "https://example.test/v1",
    model: "text-embedding-3-small",
  },
  llm: {
    provider: "openai",
    apiKey: "test-key",
    model: "gpt-default",
    extractionModel: "gpt-extract",
    summarizationModel: "gpt-summary",
    reasoningModel: "gpt-reason",
  },
};

describe("runtime pricing config", () => {
  test("parses a pinned snapshot and resolves role aliases to actual models", () => {
    const config = memoryConfigSchema.parse({
      ...baseConfig,
      llm: {
        ...baseConfig.llm,
        pricing: {
          version: "pricing-2026-08-v1",
          provider: "openai",
          currency: "USD",
          minorUnitsPerMajor: 100,
          models: {
            default: {
              inputTokenPrice: 2,
              outputTokenPrice: 4,
              embeddingPrice: 1,
            },
            extractionModel: { inputTokenPrice: 3, outputTokenPrice: 6 },
            summarizationModel: { inputTokenPrice: 4, outputTokenPrice: 8 },
            reasoningModel: { inputTokenPrice: 6, outputTokenPrice: 12 },
            "gpt-exact": { inputTokenPrice: 5, outputTokenPrice: 10 },
          },
        },
      },
    });

    expect(config.llm?.pricing?.version).toBe("pricing-2026-08-v1");
    expect(runtimePricingSnapshotFromConfig(config)).toEqual({
      version: "pricing-2026-08-v1",
      provider: "openai",
      currency: "USD",
      minorUnitsPerMajor: 100,
      models: {
        "gpt-default": { inputPerMillion: 2, outputPerMillion: 4 },
        "text-embedding-3-small": { embeddingPerMillion: 1 },
        "gpt-extract": { inputPerMillion: 3, outputPerMillion: 6 },
        "gpt-summary": { inputPerMillion: 4, outputPerMillion: 8 },
        "gpt-reason": { inputPerMillion: 6, outputPerMillion: 12 },
        "gpt-exact": { inputPerMillion: 5, outputPerMillion: 10 },
      },
    });
  });

  test("rejects unversioned, negative, or structurally unknown pricing", () => {
    expect(() => memoryConfigSchema.parse({
      ...baseConfig,
      llm: { ...baseConfig.llm, pricing: { provider: "openai", currency: "USD", models: {} } },
    })).toThrow(/pricing.version/);
    expect(() => memoryConfigSchema.parse({
      ...baseConfig,
      llm: {
        ...baseConfig.llm,
        pricing: {
          version: "v1",
          provider: "openai",
          currency: "USD",
          models: { default: { inputTokenPrice: -1 } },
        },
      },
    })).toThrow(/non-negative/);
    expect(() => memoryConfigSchema.parse({
      ...baseConfig,
      llm: {
        ...baseConfig.llm,
        pricing: {
          version: "v1",
          provider: "openai",
          currency: "USD",
          models: { default: { inputTokenPrice: 1, secret: "no" } },
        },
      },
    })).toThrow(/unknown keys/);
  });

  test("returns undefined when no pricing snapshot is configured", () => {
    expect(runtimePricingSnapshotFromConfig(memoryConfigSchema.parse(baseConfig))).toBeUndefined();
  });
});
