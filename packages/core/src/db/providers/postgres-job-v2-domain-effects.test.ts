import { describe, expect, test } from "vitest";

import {
  buildTreeSemanticFingerprint,
  extractGraphSemanticFingerprint,
  type PostgresBuildTreeEffectRequest,
  type PostgresExtractGraphEffectRequest,
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

function graphRequest(): PostgresExtractGraphEffectRequest {
  return {
    effectInput: fence,
    context: { workspaceId: "workspace", sessionId: "session" },
    semanticRequest: { chunkId: "chunk-1", text: "evidence" },
    entities: [],
    relations: [],
  };
}

describe("postgres durable domain effect fingerprints", () => {
  test("build_tree fingerprint 包含 deterministic leaf，但排除 lease fence", () => {
    const request = treeRequest();
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
});
