import type { MemoryConfig } from "../../../../config.js";
import type { RuntimeModelPricing, RuntimePricingSnapshot } from "./runtime-cost.js";

function mergePricing(
  models: Record<string, RuntimeModelPricing>,
  model: string,
  next: RuntimeModelPricing,
): void {
  models[model] = { ...models[model], ...next };
}

/** Converts the validated config snapshot into exact provider model prices. */
export function runtimePricingSnapshotFromConfig(
  config: MemoryConfig,
): RuntimePricingSnapshot | undefined {
  const pricing = config.llm?.pricing;
  if (!pricing) return undefined;
  const models: Record<string, RuntimeModelPricing> = {};
  for (const [configuredName, row] of Object.entries(pricing.models)) {
    const targetModel = configuredName === "default"
      ? config.llm!.model
      : configuredName === "extractionModel"
        ? config.llm!.extractionModel ?? config.llm!.model
        : configuredName === "summarizationModel"
          ? config.llm!.summarizationModel ?? config.llm!.model
          : configuredName === "reasoningModel"
            ? config.llm!.reasoningModel ?? config.llm!.model
            : configuredName;
    const llmPrices: RuntimeModelPricing = {
      ...(row.inputTokenPrice === undefined ? {} : { inputPerMillion: row.inputTokenPrice }),
      ...(row.outputTokenPrice === undefined ? {} : { outputPerMillion: row.outputTokenPrice }),
      ...(configuredName === "default" || row.embeddingPrice === undefined
        ? {}
        : { embeddingPerMillion: row.embeddingPrice }),
    };
    if (Object.keys(llmPrices).length > 0) mergePricing(models, targetModel, llmPrices);
    if (configuredName === "default" && row.embeddingPrice !== undefined) {
      mergePricing(models, config.embedding.model ?? "text-embedding-3-small", {
        embeddingPerMillion: row.embeddingPrice,
      });
    }
  }
  return {
    version: pricing.version,
    provider: pricing.provider,
    currency: pricing.currency,
    minorUnitsPerMajor: pricing.minorUnitsPerMajor ?? 100,
    models,
  };
}
