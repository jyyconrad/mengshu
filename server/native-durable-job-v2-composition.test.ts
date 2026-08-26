import { describe, expect, test } from "vitest";

import { PostgresProvider } from "../packages/core/src/db/providers/postgres.js";
import type { LlmClient } from "../packages/core/src/runtime/llm/llm-client.js";
import {
  createDurableJobHandlerRegistry,
  createDurableJobV2,
  deriveDurableJobV2DomainDedupeKey,
  leaseDurableJobV2,
} from "../packages/core/src/storage/repositories/job-v2.js";
import { DurableJobV2HandlerFailure } from "./workers-v2.js";
import type { CandidateWriteMaterializerDependencies } from
  "../packages/core/src/lifecycle/candidate-write-materializer.js";
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
const candidateMaterialization: CandidateWriteMaterializerDependencies = {
  resolveMaxSimilarity: async () => 0,
  embed: async () => [0.1, 0.2],
  scoreImportance: () => 0.5,
  exactDedup: () => ({ duplicate: false }),
  semanticDedup: () => ({ duplicate: false }),
  stampMetadata: (metadata) => metadata,
};
const deriveCommittedActive = async () => undefined;
const candidateEvidenceRead = {
  readAuthoritativeEvidenceFacts: async ({ evidenceIds }: { evidenceIds: readonly string[] }) =>
    evidenceIds.map((evidenceId) => ({ evidenceId, sourceKind: "session_user" as const })),
};
const authoritativeEntityGraphRead = {
  read: async () => {
    throw new Error("not exercised by composition construction test");
  },
};
const prepareEntityEmbeddings = async (entities: readonly { id: string }[]) => ({
  authority: "runtime_active_embedding_space" as const,
  embeddingSpaceId: `embedding-space:v1:${"a".repeat(64)}`,
  embeddingSpaceState: "known-queryable" as const,
  vectors: entities.map((entity) => ({ rawEntityId: entity.id, vector: [0.1, 0.2] })),
});

function legacyGraphJob() {
  const payload = {
    scope: { ...scope },
    chunkId: "evidence-a",
    text: "Caller supplied graph text",
    sourceId: "session-a",
  };
  const queued = createDurableJobV2({
    id: "legacy-graph-job",
    type: "extract_graph",
    payload,
    dedupeKey: deriveDurableJobV2DomainDedupeKey("extract_graph", payload.chunkId, {}),
    scope,
    maxAttempts: 3,
  }, {
    registry: createDurableJobHandlerRegistry(["extract_graph"]),
    now: 100,
  });
  return leaseDurableJobV2(queued, {
    owner: "worker-a",
    now: 110,
    leaseMs: 1_000,
    tokenFactory: () => "a".repeat(32),
  }).job;
}

describe("createNativeDurableJobV2Composition", () => {
  test("按 SSOT 顺序 mint provider-owned exact-three registry/capability", () => {
    const runtimeBundle = bundle();
    const composition = createNativeDurableJobV2Composition({
      runtimeBundle,
      scope,
      candidateComputation,
      candidateMaterialization,
      candidateEvidenceRead,
      authoritativeEntityGraphRead,
      prepareEntityEmbeddings,
      deriveCommittedActive,
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
      candidateMaterialization,
      candidateEvidenceRead,
      authoritativeEntityGraphRead,
      prepareEntityEmbeddings,
      deriveCommittedActive,
      llmClient,
    })).toThrow(/runtime capability is unavailable/i);
  });

  test("production composition 缺少 candidate materialization 时构造即 fail-closed", () => {
    expect(() => createNativeDurableJobV2Composition({
      runtimeBundle: bundle(),
      scope,
      candidateComputation,
      authoritativeEntityGraphRead,
      prepareEntityEmbeddings,
      deriveCommittedActive,
      llmClient,
    } as never)).toThrow(/materialization/i);
  });

  test("production composition 缺少 valueScore similarity resolver 时构造即 fail-closed", () => {
    const { resolveMaxSimilarity: _resolveMaxSimilarity, ...legacyMaterialization } =
      candidateMaterialization;
    expect(() => createNativeDurableJobV2Composition({
      runtimeBundle: bundle(),
      scope,
      candidateComputation,
      candidateMaterialization: legacyMaterialization as CandidateWriteMaterializerDependencies,
      candidateEvidenceRead,
      authoritativeEntityGraphRead,
      prepareEntityEmbeddings,
      deriveCommittedActive,
      llmClient,
    })).toThrow(/similarity resolver/i);
  });

  test("production composition 缺少 committed active derivation 时构造即 fail-closed", () => {
    expect(() => createNativeDurableJobV2Composition({
      runtimeBundle: bundle(),
      scope,
      candidateComputation,
      candidateMaterialization,
      candidateEvidenceRead,
      authoritativeEntityGraphRead,
      llmClient,
    } as never)).toThrow(/derivation/i);
  });

  test("production composition 缺少 evidence read 时构造即 fail-closed", () => {
    expect(() => createNativeDurableJobV2Composition({
      runtimeBundle: bundle(),
      scope,
      candidateComputation,
      candidateMaterialization,
      deriveCommittedActive,
      authoritativeEntityGraphRead,
      llmClient,
    } as never)).toThrow(/evidence read/i);
  });

  test("production composition 缺少 authoritative Entity Graph read 时构造即 fail-closed", () => {
    expect(() => createNativeDurableJobV2Composition({
      runtimeBundle: bundle(),
      scope,
      candidateComputation,
      candidateMaterialization,
      candidateEvidenceRead,
      deriveCommittedActive,
      llmClient,
    } as never)).toThrow(/authoritative Entity Graph read/i);
  });

  test("production exact-three registry 在 LLM/DB 前拒绝 legacy graph text job", async () => {
    const composition = createNativeDurableJobV2Composition({
      runtimeBundle: bundle(),
      scope,
      candidateComputation,
      candidateMaterialization,
      candidateEvidenceRead,
      authoritativeEntityGraphRead,
      prepareEntityEmbeddings,
      deriveCommittedActive,
      llmClient,
    });

    await expect(composition.registry.get("extract_graph")!(legacyGraphJob(), {
      signal: new AbortController().signal,
      workerId: "worker-a",
    })).rejects.toEqual(new DurableJobV2HandlerFailure("EXTRACT_GRAPH_INVALID_JOB", false));
  });
});
