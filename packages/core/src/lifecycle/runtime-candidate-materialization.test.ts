import { describe, expect, test, vi } from "vitest";

import { createEmbeddingSpace } from "../domain/embedding-space.js";
import {
  computeCandidateSpecs,
  type ComputedCandidateSpec,
} from "./candidate-spec-computation.js";
import { HeuristicTypeExtractor } from "./type-extractor.js";
import { materializeCandidateWriteRecords } from "./candidate-write-materializer.js";
import { createRuntimeCandidateMaterialization } from "./runtime-candidate-materialization.js";

const scope = Object.freeze({
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "mengshu",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "working-context",
  visibility: "private" as const,
  workspaceId: "workspace-a",
  sessionId: "session-a",
});
const embeddingSpace = createEmbeddingSpace({
  provider: "openai",
  baseURL: "https://example.test/v1",
  model: "test-embedding",
  dim: 3,
  normalization: "none",
});

function spec(overrides: Partial<ComputedCandidateSpec> = {}): ComputedCandidateSpec {
  return Object.freeze({
    text: "记住：所有发布必须运行完整测试",
    semanticType: "rules" as const,
    kind: "constraint",
    confidence: 0.9,
    reason: "explicit rule",
    extractor: "test-extractor",
    evidence: Object.freeze({
      quote: "所有发布必须运行完整测试",
      eventIds: Object.freeze(["evidence-a"]),
    }),
    metadata: Object.freeze({
      intent: "remember",
      admission: "active",
      admissionReason: "explicit_save",
      valueScore: 0.9,
      salience: 0.9,
      sourceKind: "session_user",
      riskFlags: Object.freeze([]),
    }),
    auditMetadata: Object.freeze({}),
    ...overrides,
  });
}

describe("runtime candidate materialization composition", () => {
  test("resolves admission novelty from the authoritative embedding space and dedup read port", async () => {
    const findExisting = vi.fn(async () => [{
      id: "memory-existing",
      text: "different stored memory",
      vector: [0.8, 0.6, 0],
      kind: "other" as const,
      semanticType: "rules" as const,
    }]);
    const dependencies = createRuntimeCandidateMaterialization({
      embeddingSpace,
      assertEmbeddingWriteAllowed: () => undefined,
      embed: async () => [1, 0, 0],
      dedupReadPort: { findExisting },
    });

    await expect(dependencies.resolveMaxSimilarity!({
      text: "new governed rule",
      kind: "constraint",
      semanticType: "rules",
      scope,
    })).resolves.toEqual({
      authority: "runtime_embedding_resolution",
      embeddingSpaceId: embeddingSpace.embeddingSpaceId,
      maxSimilarity: expect.closeTo(0.8, 8),
      vector: [1, 0, 0],
    });
    expect(findExisting).toHaveBeenCalledWith({
      scope,
      kind: "other",
      semanticType: "rules",
      embeddingSpaceId: embeddingSpace.embeddingSpaceId,
      embeddingSpaceState: "known-queryable",
      excludeIds: [],
    });
  });

  test("admission 与 materialization 复用同一向量且不把内部 resolution 持久化", async () => {
    const guard = vi.fn();
    const embed = vi.fn(async () => [1, 0, 0]);
    const dependencies = createRuntimeCandidateMaterialization({
      embeddingSpace,
      assertEmbeddingWriteAllowed: guard,
      embed,
      dedupReadPort: { findExisting: vi.fn(async () => []) },
    });
    const text = "记住：所有 TypeScript 发布必须运行 scripts/check.sh 完整测试。";
    const computed = await computeCandidateSpecs({
      extractor: new HeuristicTypeExtractor(),
      resolveMaxSimilarity: dependencies.resolveMaxSimilarity,
    }, {
      scope,
      text,
      traceId: "evidence-single-vector",
      intent: "remember",
      evidenceFacts: [{
        evidenceId: "evidence-single-vector",
        sourceKind: "session_user",
      }],
    });

    expect(computed.specs).toHaveLength(1);
    expect(computed.specs[0].similarityResolution).toMatchObject({
      embeddingSpaceId: embeddingSpace.embeddingSpaceId,
      maxSimilarity: 0,
      vector: [1, 0, 0],
    });
    const records = await materializeCandidateWriteRecords(dependencies, {
      specs: computed.specs,
      scope,
      fallbackReason: null,
      traceId: "evidence-single-vector",
      intent: "remember",
      createdAt: 1_000,
      createRecordId: () => "memory-single-vector",
    });

    expect(embed).toHaveBeenCalledOnce();
    expect(guard).toHaveBeenCalledTimes(3);
    expect(records[0].vector).toEqual([1, 0, 0]);
    expect(JSON.stringify(records[0].metadata)).not.toContain("similarityResolution");
  });

  test("统一执行 guard/importance/scope-space dedup/stamp，并保留 MemoryKind + semanticType", async () => {
    const guard = vi.fn();
    const embed = vi.fn(async () => [0.1, 0.2, 0.3]);
    const findExisting = vi.fn(async () => []);
    const dependencies = createRuntimeCandidateMaterialization({
      embeddingSpace,
      assertEmbeddingWriteAllowed: guard,
      embed,
      dedupReadPort: { findExisting },
    });

    const records = await materializeCandidateWriteRecords(dependencies, {
      specs: [spec()],
      scope,
      fallbackReason: null,
      traceId: "evidence-a",
      intent: "remember",
      createdAt: 1_000,
      createRecordId: () => "memory-a",
    });

    expect(guard).toHaveBeenCalledTimes(2);
    expect(embed).toHaveBeenCalledWith("记住：所有发布必须运行完整测试");
    expect(findExisting).toHaveBeenCalledWith({
      scope,
      kind: "other",
      semanticType: "rules",
      embeddingSpaceId: embeddingSpace.embeddingSpaceId,
      embeddingSpaceState: "known-queryable",
      excludeIds: ["memory-a"],
    });
    expect(records).toEqual([expect.objectContaining({
      id: "memory-a",
      kind: "other",
      semanticType: "rules",
      importance: expect.closeTo(0.915),
      metadata: expect.objectContaining({
        workspaceId: scope.workspaceId,
        sessionId: scope.sessionId,
        embeddingSpaceId: embeddingSpace.embeddingSpaceId,
        embeddingSpaceState: "known-queryable",
      }),
    })]);
  });

  test("importance 使用权威 candidate sourceKind，且缺失时 fail-closed", async () => {
    const dependencies = createRuntimeCandidateMaterialization({
      embeddingSpace,
      assertEmbeddingWriteAllowed: () => undefined,
      embed: async () => [0.1, 0.2, 0.3],
      dedupReadPort: { findExisting: async () => [] },
    });
    const agentSpec = spec({
      metadata: Object.freeze({ ...spec().metadata, sourceKind: "agent_output" }),
    });
    const [agentRecord] = await materializeCandidateWriteRecords(dependencies, {
      specs: [agentSpec], scope, fallbackReason: null, traceId: "evidence-a",
      intent: "remember", createdAt: 1_000, createRecordId: () => "memory-agent",
    });

    expect(agentRecord?.importance).toBeCloseTo(0.815);
    const { sourceKind: _sourceKind, ...metadataWithoutSourceKind } = spec().metadata;
    await expect(materializeCandidateWriteRecords(dependencies, {
      specs: [spec({ metadata: Object.freeze(metadataWithoutSourceKind) })],
      scope, fallbackReason: null, traceId: "evidence-a", intent: "remember",
      createdAt: 1_000, createRecordId: () => "memory-invalid",
    })).rejects.toThrow("Candidate write materialization failed");
  });

  test("D-06 lexical duplicate 被标记 drop，且不进入 semantic dedup 查询", async () => {
    const findExisting = vi.fn(async () => [{
      id: "memory-existing",
      text: "所有发布必须运行完整测试",
      vector: [0.2, 0.3, 0.4],
      kind: "other" as const,
      semanticType: "rules" as const,
    }]);
    const dependencies = createRuntimeCandidateMaterialization({
      embeddingSpace,
      assertEmbeddingWriteAllowed: () => undefined,
      embed: async () => [0.1, 0.2, 0.3],
      dedupReadPort: { findExisting },
    });

    const [record] = await materializeCandidateWriteRecords(dependencies, {
      specs: [spec({ text: "规则：所有发布必须运行完整测试" })],
      scope,
      fallbackReason: null,
      traceId: "evidence-a",
      intent: "remember",
      createdAt: 1_000,
      createRecordId: () => "memory-a",
    });

    expect(record).toMatchObject({
      route: "drop",
      governance: { candidate: { dedup: { kind: "exact", duplicateOf: "memory-existing" } } },
    });
    expect(findExisting).toHaveBeenCalledTimes(1);
  });

  test("scope 或 embedding stamp 冲突时 fail-closed", () => {
    const dependencies = createRuntimeCandidateMaterialization({
      embeddingSpace,
      assertEmbeddingWriteAllowed: () => undefined,
      embed: async () => [0.1, 0.2, 0.3],
      dedupReadPort: { findExisting: async () => [] },
    });

    expect(() => dependencies.stampMetadata({ sessionId: "other-session" }, {
      recordId: "memory-a",
      scope,
      spec: spec(),
    })).toThrow("Candidate write materialization failed");
    expect(() => dependencies.stampMetadata({
      embeddingSpaceId: `embedding-space:v1:${"f".repeat(64)}`,
    }, {
      recordId: "memory-a",
      scope,
      spec: spec(),
    })).toThrow("Candidate write materialization failed");
  });
});
