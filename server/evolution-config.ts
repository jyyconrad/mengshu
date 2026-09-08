import fs from "node:fs";
import { createHash } from "node:crypto";
import { memoryConfigSchema, type MemoryConfig } from "../config.js";
import { expandHome, resolveConfigPath, resolveHomeDir } from "../packages/core/src/runtime/paths.js";
import { resolveAuthorityScope, type AuthorityScope } from "../packages/core/src/domain/authority-scope.js";
import { authorityScopeFingerprint } from "../packages/core/src/domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../packages/core/src/domain/types.js";
import type { SourceBinding } from "../packages/core/src/evolution/sources/types.js";
import {
  NullLlmClient, OpenAiLlmClient, type LlmClient, type OpenAiLlmClientOptions,
} from "../packages/core/src/runtime/llm/llm-client.js";
import { fingerprintRuntimeScope, type RuntimeCostEventSink } from "../packages/core/src/cost/runtime-cost.js";
import { runtimePricingSnapshotFromConfig } from "../packages/core/src/cost/runtime-pricing.js";

export interface GlobalEvolutionConfig {
  readonly config: MemoryConfig;
  readonly sources: readonly SourceBinding[];
  readonly configFingerprint: string;
}

/** Operator environment is trusted; source/project documents never participate in this load. */
export function loadGlobalEvolutionConfig(input: {
  readonly authority: AuthorityScope;
  readonly scope: MemoryScope;
  readonly configPath?: string;
  readonly hostConfig?: MemoryConfig;
}): GlobalEvolutionConfig {
  const configuredPath = process.env.MENGSHU_CONFIG?.trim();
  const configPath = input.configPath ?? (configuredPath ? expandHome(configuredPath) : resolveConfigPath());
  let config: MemoryConfig;
  try {
    if (input.hostConfig) config = structuredClone(input.hostConfig);
    else {
      const stat = fs.statSync(configPath);
      if (!stat.isFile() || stat.size > 1_048_576) throw new Error("Invalid global config file");
      config = memoryConfigSchema.parse(JSON.parse(fs.readFileSync(configPath, "utf8")));
    }
  } catch {
    throw new Error("EVOLUTION_GLOBAL_CONFIG_UNAVAILABLE");
  }
  if (config.features?.continuousMemoryEvolution !== true) {
    throw new Error("EVOLUTION_GLOBAL_FEATURE_DISABLED");
  }
  const request = {
    appId: input.scope.appId, projectId: input.scope.projectId, agentId: input.scope.agentId,
    namespace: input.scope.namespace, visibility: input.scope.visibility ?? "private" as const,
  };
  const scope = resolveAuthorityScope(input.authority, request);
  if (authorityScopeFingerprint(scope) !== authorityScopeFingerprint(input.scope)) {
    throw new Error("EVOLUTION_HOST_SCOPE_MISMATCH");
  }
  const sources: SourceBinding[] = [];
  for (const source of config.evolution?.sources ?? []) {
    const sourceScope = resolveAuthorityScope(input.authority, { ...request, ...source.scope });
    if (authorityScopeFingerprint(sourceScope) !== authorityScopeFingerprint(scope)) continue;
    sources.push({ ...source, scope: sourceScope, outputRoots: [resolveHomeDir()] });
  }
  const model = config.llm;
  const configFingerprint = createHash("sha256").update(JSON.stringify({
    version: "mengshu.continuous-memory-evolution/v1",
    scopeFingerprint: authorityScopeFingerprint(scope),
    model: model ? {
      provider: model.provider, baseURL: model.baseURL, model: model.model,
      extractionModel: model.extractionModel, maxTokens: model.maxTokens,
    } : null,
    sources: sources.map(source => ({ ...source, scope: authorityScopeFingerprint(source.scope) }))
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
    trustedIssuers: [...(config.evolution?.attestation?.trustedIssuers ?? [])].sort((left, right) => left.id.localeCompare(right.id)),
    targetProfile: config.evolution?.reuse?.targetProfile ?? null,
    evaluations: [...(config.evolution?.reuse?.evaluations ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
  })).digest("hex");
  const freeze = <T>(value: T): T => {
    if (value && typeof value === "object") {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    return value;
  };
  return freeze({ config, sources, configFingerprint });
}

export function createGlobalEvolutionLlm(
  resolved: GlobalEvolutionConfig,
  ledger: RuntimeCostEventSink,
  scope: MemoryScope,
  options: Pick<OpenAiLlmClientOptions, "client" | "onCostLedgerError"> = {},
): LlmClient {
  if (!resolved.config.llm) return new NullLlmClient();
  return new OpenAiLlmClient(resolved.config.llm, {
    ...options, concurrency: 1, maxRetries: 0,
    costLedger: ledger, pricingSnapshot: runtimePricingSnapshotFromConfig(resolved.config),
    costContext: {
      category: "operator", operation: "memory_evolution.propose",
      scopeFingerprint: fingerprintRuntimeScope(scope),
    },
  });
}
