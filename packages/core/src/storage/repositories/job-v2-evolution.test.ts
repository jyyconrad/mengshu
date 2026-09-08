import { describe, expect, test } from "vitest";
import {
  DURABLE_JOB_V2_AUTHORITATIVE_TYPES, DURABLE_JOB_V2_EVOLUTION_TYPES,
  isDurableJobV2AuthoritativeTypes, createDurableJobHandlerRegistry, createDurableJobV2,
} from "./job-v2.js";
import { PostgresProvider } from "../../db/providers/postgres.js";

describe("feature-aware durable job SSOT", () => {
  test("keeps exact-three off and enables exactly four only on an opted-in provider bundle", () => {
    const provider = new PostgresProvider({ host: "unused", port: 5432, database: "unused", user: "unused", password: "unused" }, "text-embedding-3-small");
    const dependencies = { clock: () => 1, tokenFactory: () => "a".repeat(32), backoffMs: () => 1 };
    expect(provider.createDurableJobV2RuntimeBundle(dependencies).handlerTypes).toBe(DURABLE_JOB_V2_AUTHORITATIVE_TYPES);
    expect(provider.createDurableJobV2RuntimeBundle({ ...dependencies, enableMemoryEvolution: true }).handlerTypes)
      .toBe(DURABLE_JOB_V2_EVOLUTION_TYPES);
    expect(DURABLE_JOB_V2_EVOLUTION_TYPES).toEqual(["build_tree", "evolve_memory_batch", "extract_candidate", "extract_graph"]);
    expect(Object.isFrozen(DURABLE_JOB_V2_EVOLUTION_TYPES)).toBe(true);
  });
  test("rejects partial, reordered, and arbitrary registry extensions", () => {
    expect(isDurableJobV2AuthoritativeTypes(DURABLE_JOB_V2_AUTHORITATIVE_TYPES)).toBe(true);
    expect(isDurableJobV2AuthoritativeTypes(DURABLE_JOB_V2_EVOLUTION_TYPES)).toBe(true);
    for (const types of [["evolve_memory_batch"], [...DURABLE_JOB_V2_EVOLUTION_TYPES].reverse(),
      [...DURABLE_JOB_V2_AUTHORITATIVE_TYPES, "execute_script"]]) {
      expect(isDurableJobV2AuthoritativeTypes(types)).toBe(false);
    }
  });
  test("feature-off queue cannot enqueue evolution jobs", () => {
    const input = { id: "job", type: "evolve_memory_batch", payload: { batchId: "batch" }, dedupeKey: "batch", maxAttempts: 3,
      scope: { tenantId: "tenant", userId: "user", appId: "app", projectId: "project", agentId: "agent", namespace: "memories", visibility: "private" as const } };
    expect(() => createDurableJobV2(input, { registry: createDurableJobHandlerRegistry(DURABLE_JOB_V2_AUTHORITATIVE_TYPES), now: 1 })).toThrow();
    expect(createDurableJobV2(input, { registry: createDurableJobHandlerRegistry(DURABLE_JOB_V2_EVOLUTION_TYPES), now: 1 }).status).toBe("queued");
  });
});
