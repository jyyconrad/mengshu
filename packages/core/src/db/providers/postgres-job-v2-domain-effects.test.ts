import { describe, expect, test } from "vitest";

import {
  authoritativeExtractGraphReplayFingerprint,
  buildTreeSemanticFingerprint,
  extractGraphSemanticFingerprint,
  type PostgresBuildTreeEffectRequest,
  type PostgresAuthoritativeExtractGraphEffectRequest,
  type PostgresLegacyExtractGraphEffectRequest,
} from "./postgres-job-v2-domain-effects.js";

const scope = {
  tenantId: "tenant",
  userId: "user",
  appId: "app",
  projectId: "project",
  agentId: "agent",
  namespace: "memory",
  visibility: "private" as const,
};
const fence = {
  id: "job-1",
  scope,
  owner: "worker-1",
  leaseToken: "t".repeat(32),
  leaseGeneration: 1,
};
const fullScope = { ...scope, workspaceId: "workspace", sessionId: "session" };

function treeRequest(): PostgresBuildTreeEffectRequest {
  return {
    effectKey: "build_tree.persist.v1",
    effectInput: fence,
    semanticRequest: {
      type: "build_tree",
      version: 1,
      traceId: "trace-1",
      context: { workspaceId: "workspace", sessionId: "session" },
      treeType: "source",
      treeKey: "source-1",
      level: 0,
      policy: { maxLeafCount: 20, maxTokenCount: 6000 },
      leaf: {
        id: "trace-1",
        scope: fullScope,
        chunkId: "trace-1",
        sourceId: "source-1",
        entityIds: [],
        importance: 0.5,
        eventAt: 1,
        createdAt: 1,
        text: "evidence",
        tokenCount: 2,
      },
      expectedBufferId: "buf-1",
    },
  };
}

function graphRequest(): PostgresLegacyExtractGraphEffectRequest {
  return {
    effectInput: fence,
    context: { workspaceId: "workspace", sessionId: "session" },
    semanticRequest: { chunkId: "chunk-1", text: "evidence" },
    entities: [],
    relations: [],
  };
}

function authoritativeGraphRequest(): PostgresAuthoritativeExtractGraphEffectRequest {
  return {
    effectInput: fence,
    context: { workspaceId: "workspace", sessionId: "session" },
    semanticRequest: {
      graphKind: "entity",
      activeMemoryId: "memory-1",
      evidenceId: "evidence-1",
    },
    graph: {
      scope: fullScope,
      scopeFingerprint: "f".repeat(64),
      memoryId: "memory-1",
      evidenceId: "evidence-1",
      evidenceSourceId: "source-1",
      evidenceSourceKind: "explicit_save",
      evidenceCreatedAt: 1,
      entities: [],
      relations: [],
      entityEvidenceLinks: [],
      relationEvidenceLinks: [],
      aliasProjections: [],
    },
    entityEmbeddings: {
      authority: "runtime_active_embedding_space",
      embeddingSpaceId: `embedding-space:v1:${"a".repeat(64)}`,
      embeddingSpaceState: "known-queryable",
      vectors: [],
    },
  };
}

describe("postgres durable domain effect fingerprints", () => {
  test("build_tree fingerprint 包含 deterministic leaf，但排除 lease fence", () => {
    const request = treeRequest();
    if (request.semanticRequest.type !== "build_tree") throw new Error("expected append request");
    const first = buildTreeSemanticFingerprint(request);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(buildTreeSemanticFingerprint({
      ...request,
      effectInput: { ...request.effectInput, owner: "worker-2", leaseGeneration: 2 },
    })).toBe(first);
    expect(buildTreeSemanticFingerprint({
      ...request,
      semanticRequest: {
        ...request.semanticRequest,
        leaf: { ...request.semanticRequest.leaf, text: "changed" },
      },
    })).not.toBe(first);
  });

  test("history finalize fingerprint 包含 target buffer 且排除 lease fence", () => {
    const request: PostgresBuildTreeEffectRequest = {
      effectKey: "build_tree.persist.v1",
      effectInput: fence,
      semanticRequest: {
        type: "finalize_tree_buffer",
        version: 1,
        traceId: "history-finalize-source-1",
        context: { workspaceId: "workspace", sessionId: "session" },
        treeType: "source",
        treeKey: "source-1",
        level: 0,
        finalizeMode: "history_rebuild",
        expectedBufferId: "buf-1",
      },
    };
    const first = buildTreeSemanticFingerprint(request);
    expect(buildTreeSemanticFingerprint({
      ...request,
      effectInput: { ...request.effectInput, owner: "worker-2", leaseGeneration: 2 },
    })).toBe(first);
    expect(buildTreeSemanticFingerprint({
      ...request,
      semanticRequest: { ...request.semanticRequest, expectedBufferId: "buf-2" },
    })).not.toBe(first);
  });

  test("extract_graph fingerprint 排除非确定性 LLM graph output", () => {
    const request = graphRequest();
    const first = extractGraphSemanticFingerprint(request);
    expect(extractGraphSemanticFingerprint({
      ...request,
      effectInput: { ...request.effectInput, leaseToken: "x".repeat(32), leaseGeneration: 3 },
      entities: [{ id: "nondeterministic" } as never],
      relations: [{ id: "nondeterministic" } as never],
    })).toBe(first);
    expect(extractGraphSemanticFingerprint({
      ...request,
      semanticRequest: { ...request.semanticRequest, text: "changed" },
    })).not.toBe(first);
  });

  test("authoritative extract_graph fingerprint 只包含 fenced identity 和完整 scope", () => {
    const request = authoritativeGraphRequest();
    const first = extractGraphSemanticFingerprint(request);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(extractGraphSemanticFingerprint({
      ...request,
      effectInput: { ...request.effectInput, owner: "worker-2", leaseGeneration: 2 },
      graph: {
        ...request.graph,
        evidenceSourceKind: "changed-derived-output",
        entities: [{ id: "nondeterministic" } as never],
      },
    })).toBe(first);
    expect(extractGraphSemanticFingerprint({
      ...request,
      semanticRequest: { ...request.semanticRequest, evidenceId: "evidence-2" },
    })).not.toBe(first);
    expect(extractGraphSemanticFingerprint({
      ...request,
      context: { ...request.context, sessionId: "session-2" },
    })).not.toBe(first);
    expect(authoritativeExtractGraphReplayFingerprint({
      effectInput: request.effectInput,
      context: request.context,
      semanticRequest: request.semanticRequest,
    })).toBe(first);
  });
});
