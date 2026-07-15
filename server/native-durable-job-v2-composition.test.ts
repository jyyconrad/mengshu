import { describe, expect, test } from "vitest";

import { PostgresProvider } from "../packages/core/src/db/providers/postgres.js";
import type { LlmClient } from "../packages/core/src/runtime/llm/llm-client.js";
import { createNativeDurableJobV2Composition } from "./native-durable-job-v2-composition.js";

const scope = Object.freeze({
  tenantId: "tenant",
  userId: "user",
  appId: "app",
  projectId: "project",
  agentId: "agent",
  namespace: "memory",
  visibility: "private" as const,
});

function bundle() {
  const provider = new PostgresProvider({
    host: "unused",
    port: 5432,
    database: "unused",
    user: "unused",
    password: "unused",
  }, "text-embedding-3-small");
  return provider.createDurableJobV2RuntimeBundle({
    clock: () => 100,
    tokenFactory: () => "t".repeat(32),
    backoffMs: () => 100,
  });
}

const llmClient = {
  available: false,
  extractStructured: async () => ({ entities: [], relations: [] }),
} as unknown as LlmClient;
const candidateComputation = {
  extractor: {
    name: "test-extractor",
    extract: async () => [],
  },
};

describe("createNativeDurableJobV2Composition", () => {
  test("按 SSOT 顺序 mint provider-owned exact-three registry/capability", () => {
    const runtimeBundle = bundle();
    const composition = createNativeDurableJobV2Composition({
      runtimeBundle,
      scope,
      candidateComputation,
      llmClient,
    });

    expect(composition.runtimeBundle).toBe(runtimeBundle);
    expect(composition.registry.types).toEqual([
      "build_tree",
      "extract_candidate",
      "extract_graph",
    ]);
    expect(composition.serveCapability.repository).toBe(runtimeBundle.repository);
    expect(composition.serveCapability.registry).not.toBe(composition.registry);
    for (const type of composition.registry.types) {
      expect(composition.registry.get(type)).toEqual(expect.any(Function));
      expect(composition.serveCapability.registry.get(type)).toEqual(expect.any(Function));
    }
    expect(Object.isFrozen(composition)).toBe(true);
  });

  test("复制/结构伪造 bundle 在 handler 构造前 fail-closed", () => {
    const runtimeBundle = bundle();
    expect(() => createNativeDurableJobV2Composition({
      runtimeBundle: { ...runtimeBundle },
      scope,
      candidateComputation,
      llmClient,
    })).toThrow(/runtime capability is unavailable/i);
  });
});
