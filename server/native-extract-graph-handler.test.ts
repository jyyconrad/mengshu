import { describe, expect, test, vi } from "vitest";

import type { LlmClient } from "../packages/core/src/runtime/llm/llm-client.js";
import type { AuthoritativeEntityGraphReadPort } from
  "../packages/core/src/graph/postgres-authoritative-entity-graph-read-port.js";
import type { AuthoritativeEntityGraphReadFact } from
  "../packages/core/src/graph/postgres-authoritative-entity-graph-read-port.js";
import type { CanonicalEntityCentralityRefreshPort } from
  "../packages/core/src/graph/postgres-canonical-entity-centrality-refresh.js";
import type {
  CanonicalEntityTopicReadFacts,
  CanonicalEntityTopicReadPort,
} from "../packages/core/src/graph/postgres-canonical-entity-topic-read-port.js";
import type { EntityGraphEvidenceLink } from
  "../packages/core/src/graph/authoritative-entity-graph-derivation.js";
import { PostgresDurableJobV2EffectError } from
  "../packages/core/src/storage/repositories/postgres-job-v2-effect.js";
import {
  createDurableJobHandlerRegistry,
  createDurableJobV2,
  deriveDurableJobV2DomainDedupeKey,
  leaseDurableJobV2,
  type DurableJobV2,
  type DurableJobV2Scope,
} from "../packages/core/src/storage/repositories/job-v2.js";
import type { GraphExtractionResult } from "../packages/core/src/graph/types.js";
import type { GraphEntityRecord } from "../packages/core/src/graph/types.js";
import type { TreeFanOutInput, TreeFanOutTarget } from
  "../packages/core/src/tree/tree-fan-out.js";
import { DurableJobV2HandlerFailure } from "./workers-v2.js";
import {
  createNativeExtractGraphHandler as createNativeExtractGraphHandlerImpl,
  deriveNativeAuthoritativeExtractGraphDedupeKey,
  type NativeExtractGraphEffectPort,
  type NativeExtractGraphEffectRequest,
} from "./native-extract-graph-handler.js";

function createNativeExtractGraphHandler(
  dependencies: Parameters<typeof createNativeExtractGraphHandlerImpl>[0],
) {
  return createNativeExtractGraphHandlerImpl({
    prepareEntityEmbeddings: async (entities) => ({
      authority: "runtime_active_embedding_space",
      embeddingSpaceId: `embedding-space:v1:${"a".repeat(64)}`,
      embeddingSpaceState: "known-queryable",
      vectors: entities.map((entity, index) => ({
        rawEntityId: entity.id,
        vector: [index + 1, 0.5],
      })),
    }),
    ...dependencies,
  });
}

const scope: DurableJobV2Scope = {
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "mengshu",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "working-context",
  visibility: "private",
};

function runningJob(payload: Record<string, unknown> = {}): DurableJobV2 {
  const mergedPayload = {
    scope: { ...scope, workspaceId: "workspace-a", sessionId: "session-a" },
    chunkId: "chunk-1",
    text: "Mengshu 项目使用 PostgreSQL，并通过 MCP 为 Agent 提供本地优先记忆能力。",
    sourceId: "source-1",
    context: { projectName: "Mengshu", agentName: "Codex" },
    ...payload,
  };
  const queued = createDurableJobV2({
    id: "job-graph-1",
    type: "extract_graph",
    payload: mergedPayload,
    dedupeKey: deriveDurableJobV2DomainDedupeKey("extract_graph", String(mergedPayload.chunkId), {
      workspaceId: "workspace-a", sessionId: "session-a",
    }),
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
    tokenFactory: () => "secret-graph-lease-token-that-must-not-escape",
  }).job;
}

function authoritativeJob(payload: Record<string, unknown> = {}): DurableJobV2 {
  const mergedPayload = {
    scope: { ...scope, workspaceId: "workspace-a", sessionId: "session-a" },
    graphKind: "entity",
    activeMemoryId: "memory-a",
    evidenceId: "evidence-a",
    ...payload,
  };
  const queued = createDurableJobV2({
    id: "job-graph-authoritative-1",
    type: "extract_graph",
    payload: mergedPayload,
    dedupeKey: deriveNativeAuthoritativeExtractGraphDedupeKey({
      graphKind: "entity",
      activeMemoryId: String(mergedPayload.activeMemoryId),
      evidenceId: String(mergedPayload.evidenceId),
      context: { workspaceId: "workspace-a", sessionId: "session-a" },
    }),
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
    tokenFactory: () => "secret-graph-lease-token-that-must-not-escape",
  }).job;
}

function authoritativeFact(
  overrides: Partial<AuthoritativeEntityGraphReadFact> = {},
): AuthoritativeEntityGraphReadFact {
  return {
    authority: "persisted_active_memory_evidence",
    graphKind: "entity",
    activeMemoryId: "memory-a",
    activeText: "This active text must not reach graph extraction.",
    evidence: {
      authority: "persisted_evidence",
      evidenceId: "evidence-a",
      scope: { ...scope, workspaceId: "workspace-a", sessionId: "session-a" },
      text: "Mengshu uses PostgreSQL.",
      sourceId: "message-a",
      sourceKind: "agent-fast-path",
      createdAt: 90,
    },
    ...overrides,
  };
}

function authoritativeRead(overrides: Partial<AuthoritativeEntityGraphReadFact> = {}): AuthoritativeEntityGraphReadPort {
  return {
    read: vi.fn(async () => authoritativeFact(overrides)),
  };
}

const fullScope = Object.freeze({
  ...scope,
  workspaceId: "workspace-a",
  sessionId: "session-a",
});

function extractedTopic(overrides: Partial<GraphEntityRecord> = {}): GraphEntityRecord {
  return {
    id: "entity-topic",
    scope: fullScope,
    canonicalName: "runtime architecture",
    displayName: "Runtime Architecture",
    type: "topic",
    aliases: [],
    mentionCount: 1,
    mentionCount30d: 1,
    distinctSourceCount: 1,
    lastSeenAt: 90,
    hotness: 0,
    queryHits30d: 0,
    status: "active",
    createdAt: 90,
    updatedAt: 90,
    metadata: {},
    ...overrides,
  };
}

function entityEvidenceLink(): EntityGraphEvidenceLink {
  return {
    id: "a".repeat(64),
    scope: fullScope,
    targetKind: "entity",
    targetId: "entity-topic",
    evidenceId: "evidence-a",
    memoryId: "memory-a",
    sourceId: "message-a",
    sourceKind: "agent-fast-path",
    createdAt: 90,
  };
}

function canonicalTopicFacts(
  entityOverrides: Partial<GraphEntityRecord> = {},
): CanonicalEntityTopicReadFacts {
  return {
    canonicalFactsAuthority: "graph_repository",
    memory: {
      memoryId: "memory-a",
      scope: fullScope,
      text: "Mengshu uses PostgreSQL.",
      evidenceId: "evidence-a",
      sourceId: "message-a",
      entityIds: ["entity-topic"],
      eventAt: 90,
      createdAt: 90,
      routing: {
        valueScore: 0.75,
        importance: 0.8,
        semanticType: "experience",
        scopeVisibility: "project",
        riskFlags: [],
        topicHotnessEligible: false,
      },
    },
    canonicalEntities: [extractedTopic(entityOverrides)],
    entityEvidenceLinks: [entityEvidenceLink()],
  };
}

function canonicalProjectionHarness(facts: CanonicalEntityTopicReadFacts) {
  const events: string[] = [];
  const centrality: CanonicalEntityCentralityRefreshPort = {
    refresh: vi.fn(async () => {
      events.push("refresh");
      return {
        activeEntityCount: 1,
        activeRelationCount: 0,
        updatedCount: 1,
        centralities: { "entity-topic": facts.canonicalEntities[0]?.graphCentrality ?? 0 },
      };
    }),
  };
  const read: CanonicalEntityTopicReadPort = {
    read: vi.fn(async () => {
      events.push("read");
      return facts;
    }),
  };
  const aliases = {
    persist: vi.fn(async () => {
      events.push("alias");
      return [];
    }),
  };
  const enqueued: Array<Readonly<{
    input: TreeFanOutInput;
    target: TreeFanOutTarget;
  }>> = [];
  const enqueue = vi.fn(async (input: TreeFanOutInput, target: TreeFanOutTarget) => {
    events.push(`enqueue:${target.treeType}`);
    enqueued.push({ input, target });
    return "topic-job-a";
  });
  return { centrality, read, aliases, enqueue, events, enqueued };
}

function llmClient(): LlmClient {
  return {
    available: true,
    extractStructured: vi.fn(async () => ({
      entities: [
        { name: "Mengshu", type: "project" },
        { name: "PostgreSQL", type: "tool" },
      ],
      relations: [{
        subject: "Mengshu",
        predicate: "uses",
        object: "PostgreSQL",
        confidence: 0.9,
        evidence: "使用 PostgreSQL",
      }],
    })),
  } as unknown as LlmClient;
}

function effectHarness(options: { stale?: boolean; error?: Error } = {}) {
  const requests: NativeExtractGraphEffectRequest[] = [];
  let prior: Awaited<ReturnType<NativeExtractGraphEffectPort["executeGraphEffect"]>> | undefined;
  const port: NativeExtractGraphEffectPort = Object.freeze({
    contract: "mengshu.postgres-graph-effect/v1" as const,
    executeGraphEffect: vi.fn(async (request: NativeExtractGraphEffectRequest) => {
      requests.push(request);
      if (options.error) throw options.error;
      if (options.stale) return { status: "stale" as const };
      if (prior && prior.status !== "stale") {
        return { ...prior, status: "replayed" as const };
      }
      const authoritative = "graph" in request;
      const result = authoritative ? {
        createdEntities: request.graph.entities.length,
        createdRelations: request.graph.relations.length,
        entityIds: request.graph.entities.map((entity) => entity.id),
        relationIds: request.graph.relations.map((relation) => relation.id),
        evidenceId: request.graph.evidenceId,
        memoryEvidenceLinks: 1,
        entityEvidenceLinks: request.graph.entityEvidenceLinks.length,
        relationEvidenceLinks: request.graph.relationEvidenceLinks.length,
        aliasProjections: request.graph.aliasProjections.length,
      } : {
        createdEntities: request.entities.length,
        createdRelations: request.relations.length,
        entityIds: request.entities.map((entity) => entity.id),
        relationIds: request.relations.map((relation) => relation.id),
      };
      prior = {
        status: "applied" as const,
        receipt: {
          jobId: request.effectInput.id,
          effectKey: "extract_graph.persist.v1",
          requestFingerprint: "a".repeat(64),
          leaseGeneration: request.effectInput.leaseGeneration,
          result,
          committedAt: 500,
        },
      };
      return prior;
    }),
  });
  return { port, requests };
}

describe("native extract_graph durable-v2 handler", () => {
  test("工厂拒绝结构不完整的 effect port / LLM dependency", () => {
    expect(() => createNativeExtractGraphHandler({
      effectPort: {} as never,
      llmClient: llmClient(),
    })).toThrow(/dependencies|effect port/i);
    expect(() => createNativeExtractGraphHandler({
      effectPort: effectHarness().port,
      llmClient: {} as never,
    })).toThrow(/dependencies|llm/i);
  });

  test("LLM 计算在 effect 外完成，再提交精确 job fence/scope/semantic request", async () => {
    const llm = llmClient();
    const harness = effectHarness();
    const handler = createNativeExtractGraphHandler({ effectPort: harness.port, llmClient: llm });

    const result = await handler(runningJob(), {
      signal: new AbortController().signal,
      workerId: "worker-a",
    });

    expect(result).toMatchObject({
      status: "applied",
      createdEntities: 2,
      createdRelations: 1,
    });
    expect(llm.extractStructured).toHaveBeenCalledTimes(1);
    expect(harness.requests).toHaveLength(1);
    const request = harness.requests[0]!;
    expect(request.effectInput).toEqual({
      id: "job-graph-1",
      scope,
      owner: "worker-a",
      leaseToken: "secret-graph-lease-token-that-must-not-escape",
      leaseGeneration: 1,
    });
    expect(request.context).toEqual({ workspaceId: "workspace-a", sessionId: "session-a" });
    expect(request.semanticRequest).toEqual({
      chunkId: "chunk-1",
      text: "Mengshu 项目使用 PostgreSQL，并通过 MCP 为 Agent 提供本地优先记忆能力。",
      sourceId: "source-1",
      context: { projectName: "Mengshu", agentName: "Codex" },
    });
    expect("entities" in request).toBe(true);
    if (!("entities" in request)) throw new Error("expected legacy graph effect request");
    expect(request.entities.every((entity) => Object.isFrozen(entity))).toBe(true);
    expect(request.relations[0]).toMatchObject({
      predicate: "uses",
      evidenceChunkIds: ["chunk-1"],
      confidence: 0.9,
    });
  });

  test("相同 job 重算后由 effect receipt replay 首次稳定结果", async () => {
    const harness = effectHarness();
    const handler = createNativeExtractGraphHandler({ effectPort: harness.port, llmClient: llmClient() });
    const context = { signal: new AbortController().signal, workerId: "worker-a" };
    const first = await handler(runningJob(), context);
    const replay = await handler(runningJob(), context);

    expect(first).toMatchObject({ status: "applied" });
    expect(replay).toMatchObject({
      status: "replayed",
      entityIds: (first as { entityIds: string[] }).entityIds,
      relationIds: (first as { relationIds: string[] }).relationIds,
    });
  });

  test("LLM 非确定性重算改变输出时仍接受 provider 首次 receipt replay", async () => {
    const harness = effectHarness();
    const llm = llmClient();
    const handler = createNativeExtractGraphHandler({ effectPort: harness.port, llmClient: llm });
    const context = { signal: new AbortController().signal, workerId: "worker-a" };
    const first = await handler(runningJob(), context) as { entityIds: readonly string[] };
    vi.mocked(llm.extractStructured).mockResolvedValue({
      entities: [{ name: "Different Entity", type: "concept" }],
      relations: [],
    });

    await expect(handler(runningJob(), context)).resolves.toMatchObject({
      status: "replayed",
      entityIds: first.entityIds,
    });
  });

  test("stale fence 映射固定 retryable failure", async () => {
    const handler = createNativeExtractGraphHandler({
      effectPort: effectHarness({ stale: true }).port,
      llmClient: llmClient(),
    });
    await expect(handler(runningJob(), {
      signal: new AbortController().signal,
      workerId: "worker-a",
    })).rejects.toEqual(new DurableJobV2HandlerFailure("EXTRACT_GRAPH_EFFECT_STALE", true));
  });

  test.each([
    ["DURABLE_JOB_EFFECT_OUTCOME_UNCERTAIN", true, "EXTRACT_GRAPH_EFFECT_RETRYABLE"],
    ["DURABLE_JOB_EFFECT_LEASE_LOST", true, "EXTRACT_GRAPH_EFFECT_RETRYABLE"],
    ["DURABLE_JOB_EFFECT_FINGERPRINT_MISMATCH", false, "EXTRACT_GRAPH_EFFECT_REJECTED"],
    ["DURABLE_JOB_EFFECT_INVALID_RECEIPT", false, "EXTRACT_GRAPH_EFFECT_REJECTED"],
  ] as const)("provider error %s 脱敏映射", async (code, retryable, expectedCode) => {
    const secret = "postgres://admin:secret@private-host/graph";
    const handler = createNativeExtractGraphHandler({
      effectPort: effectHarness({ error: new PostgresDurableJobV2EffectError(code, secret) }).port,
      llmClient: llmClient(),
    });
    const caught = await handler(runningJob(), {
      signal: new AbortController().signal,
      workerId: "worker-a",
    }).catch((error: unknown) => error);
    expect(caught).toEqual(new DurableJobV2HandlerFailure(expectedCode, retryable));
    expect(JSON.stringify(caught)).not.toContain(secret);
  });

  test("payload/dedupe/scope/lease 任一不一致时 computation/effect 零触达", async () => {
    const compute = vi.fn(async () => ({ entities: [], relations: [] }));
    const harness = effectHarness();
    const handler = createNativeExtractGraphHandler({
      effectPort: harness.port,
      llmClient: llmClient(),
      compute,
    });
    const badJobs = [
      runningJob({ extra: true }),
      { ...runningJob(), dedupeKey: "extract_graph:other" },
      { ...runningJob(), scope: { ...scope, tenantId: "tenant-b" } },
      { ...runningJob(), leaseOwner: "worker-b" },
    ];
    for (const job of badJobs) {
      await expect(handler(job as DurableJobV2, {
        signal: new AbortController().signal,
        workerId: "worker-a",
      })).rejects.toMatchObject({ code: "EXTRACT_GRAPH_INVALID_JOB", retryable: false });
    }
    expect(compute).not.toHaveBeenCalled();
    expect(harness.requests).toEqual([]);
  });

  test("malformed entity/relation output 在 effect 前 fail-closed", async () => {
    const harness = effectHarness();
    const malformed: GraphExtractionResult = {
      entities: [{ id: "entity-1", type: "project", displayName: "x" } as never],
      relations: [{ id: "relation-1", subjectId: "missing", objectId: "missing" } as never],
    };
    const handler = createNativeExtractGraphHandler({
      effectPort: harness.port,
      llmClient: llmClient(),
      compute: vi.fn(async () => malformed),
    });
    await expect(handler(runningJob(), {
      signal: new AbortController().signal,
      workerId: "worker-a",
    })).rejects.toEqual(new DurableJobV2HandlerFailure("EXTRACT_GRAPH_OUTPUT_INVALID", false));
    expect(harness.requests).toEqual([]);
  });

  test("sparse/accessor output arrays 在 effect 前 fail-closed", async () => {
    const harness = effectHarness();
    const sparse = new Array(1);
    const handler = createNativeExtractGraphHandler({
      effectPort: harness.port,
      llmClient: llmClient(),
      compute: vi.fn(async () => ({ entities: sparse, relations: [] })),
    });
    await expect(handler(runningJob(), {
      signal: new AbortController().signal,
      workerId: "worker-a",
    })).rejects.toEqual(new DurableJobV2HandlerFailure("EXTRACT_GRAPH_OUTPUT_INVALID", false));
    expect(harness.requests).toEqual([]);
  });

  test("计算期间 abort 原样终止且 effect 零触达", async () => {
    const harness = effectHarness();
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
    const handler = createNativeExtractGraphHandler({
      effectPort: harness.port,
      llmClient: llmClient(),
      compute: async (_input, signal) => {
        resolveStarted();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return { entities: [], relations: [] };
      },
    });
    const abort = new AbortController();
    const running = handler(runningJob(), { signal: abort.signal, workerId: "worker-a" });
    await started;
    abort.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(harness.requests).toEqual([]);
  });

  test("零输出仍提交可 replay receipt", async () => {
    const harness = effectHarness();
    const handler = createNativeExtractGraphHandler({
      effectPort: harness.port,
      llmClient: llmClient(),
      compute: vi.fn(async () => ({ entities: [], relations: [] })),
    });
    const context = { signal: new AbortController().signal, workerId: "worker-a" };
    await expect(handler(runningJob(), context)).resolves.toMatchObject({
      status: "applied", createdEntities: 0, createdRelations: 0,
    });
    await expect(handler(runningJob(), context)).resolves.toMatchObject({
      status: "replayed", createdEntities: 0, createdRelations: 0,
    });
  });

  test("authoritative identity-only job 在 LLM 前权威回读，且 LLM 只消费 evidence text", async () => {
    const events: string[] = [];
    const readPort = authoritativeRead();
    vi.mocked(readPort.read).mockImplementation(async () => {
      events.push("read");
      return authoritativeFact();
    });
    const harness = effectHarness();
    const compute = vi.fn(async (input: Parameters<typeof import("../packages/core/src/graph/llm-extractor.js").extractGraphWithLlm>[0]) => {
      events.push("compute");
      expect(input.text).toBe("Mengshu uses PostgreSQL.");
      expect(input.text).not.toContain("active text");
      expect(input.chunkId).toBe("evidence-a");
      expect(input.sourceId).toBe("message-a");
      expect(input.metadata).toEqual({});
      return { entities: [], relations: [] };
    });
    const handler = createNativeExtractGraphHandler({
      effectPort: harness.port,
      llmClient: llmClient(),
      authoritativeRead: readPort,
      compute,
    });

    await expect(handler(authoritativeJob(), {
      signal: new AbortController().signal,
      workerId: "worker-a",
    })).resolves.toMatchObject({
      status: "applied",
      evidenceId: "evidence-a",
      memoryEvidenceLinks: 1,
    });

    expect(events).toEqual(["read", "compute"]);
    expect(readPort.read).toHaveBeenCalledWith({
      graphKind: "entity",
      activeMemoryId: "memory-a",
      evidenceId: "evidence-a",
      scope: { ...scope, workspaceId: "workspace-a", sessionId: "session-a" },
      signal: expect.any(AbortSignal),
    });
  });

  test("authoritative effect 只携 identity + derived graph，并严格验证 evidence/ledger receipt", async () => {
    const requests: NativeExtractGraphEffectRequest[] = [];
    const port: NativeExtractGraphEffectPort = {
      contract: "mengshu.postgres-graph-effect/v1",
      executeGraphEffect: vi.fn(async (request) => {
        requests.push(request);
        if (!("graph" in request)) throw new Error("missing authoritative graph");
        return {
          status: "applied" as const,
          receipt: {
            jobId: request.effectInput.id,
            effectKey: "extract_graph.persist.v1",
            requestFingerprint: "a".repeat(64),
            leaseGeneration: request.effectInput.leaseGeneration,
            result: {
              createdEntities: 0,
              createdRelations: 0,
              entityIds: [],
              relationIds: [],
              evidenceId: "evidence-a",
              memoryEvidenceLinks: 1,
              entityEvidenceLinks: 0,
              relationEvidenceLinks: 0,
              aliasProjections: 0,
            },
            committedAt: 500,
          },
        };
      }),
    };
    const handler = createNativeExtractGraphHandler({
      effectPort: port,
      llmClient: llmClient(),
      authoritativeRead: authoritativeRead(),
      compute: vi.fn(async () => ({ entities: [], relations: [] })),
    });

    await handler(authoritativeJob(), {
      signal: new AbortController().signal,
      workerId: "worker-a",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      semanticRequest: {
        graphKind: "entity",
        activeMemoryId: "memory-a",
        evidenceId: "evidence-a",
      },
      graph: {
        memoryId: "memory-a",
        evidenceId: "evidence-a",
        evidenceSourceId: "message-a",
        evidenceSourceKind: "agent-fast-path",
      },
    });
    expect(requests[0]).not.toHaveProperty("entities");
    expect(requests[0]).not.toHaveProperty("relations");
    expect(JSON.stringify(requests[0])).not.toContain("Mengshu uses PostgreSQL");
  });

  test("authoritative read 缺失/伪造 identity 时 LLM/effect 零触达，且绝不 fallback legacy", async () => {
    const cases: AuthoritativeEntityGraphReadPort[] = [
      { read: vi.fn(async () => { throw new Error("missing persisted evidence"); }) },
      authoritativeRead({ activeMemoryId: "memory-forged" }),
      authoritativeRead({
        evidence: { ...authoritativeFact().evidence, evidenceId: "evidence-forged" },
      }),
    ];
    for (const readPort of cases) {
      const compute = vi.fn(async () => ({ entities: [], relations: [] }));
      const harness = effectHarness();
      const handler = createNativeExtractGraphHandler({
        effectPort: harness.port,
        llmClient: llmClient(),
        authoritativeRead: readPort,
        compute,
      });
      await expect(handler(authoritativeJob(), {
        signal: new AbortController().signal,
        workerId: "worker-a",
      })).rejects.toMatchObject({ code: "EXTRACT_GRAPH_AUTHORITY_UNAVAILABLE", retryable: true });
      expect(compute).not.toHaveBeenCalled();
      expect(harness.requests).toEqual([]);
    }
  });

  test("authoritative replay 接受首次稳定 receipt，但拒绝 evidence/ledger count 不一致", async () => {
    const result = {
      createdEntities: 0,
      createdRelations: 0,
      entityIds: [],
      relationIds: [],
      evidenceId: "evidence-a",
      memoryEvidenceLinks: 1,
      entityEvidenceLinks: 0,
      relationEvidenceLinks: 0,
      aliasProjections: 0,
    };
    let call = 0;
    const port: NativeExtractGraphEffectPort = {
      contract: "mengshu.postgres-graph-effect/v1",
      executeGraphEffect: vi.fn(async (request) => ({
        status: call++ === 0 ? "applied" as const : "replayed" as const,
        receipt: {
          jobId: request.effectInput.id,
          effectKey: "extract_graph.persist.v1",
          requestFingerprint: "a".repeat(64),
          leaseGeneration: request.effectInput.leaseGeneration,
          result,
          committedAt: 500,
        },
      })),
    };
    const handler = createNativeExtractGraphHandler({
      effectPort: port,
      llmClient: llmClient(),
      authoritativeRead: authoritativeRead(),
      compute: vi.fn(async () => ({ entities: [], relations: [] })),
    });
    const context = { signal: new AbortController().signal, workerId: "worker-a" };
    await expect(handler(authoritativeJob(), context)).resolves.toMatchObject({ status: "applied" });
    await expect(handler(authoritativeJob(), context)).resolves.toMatchObject({ status: "replayed" });

    result.memoryEvidenceLinks = 2;
    await expect(handler(authoritativeJob(), context)).rejects.toMatchObject({
      code: "EXTRACT_GRAPH_EFFECT_REJECTED", retryable: false,
    });
  });

  test("authoritative applied receipt 允许每个抽取 entity 至多一条 evidence-backed related_to", async () => {
    const relatedResult = {
      createdEntities: 1,
      createdRelations: 1,
      entityIds: ["entity-topic"],
      relationIds: ["relation-related"],
      evidenceId: "evidence-a",
      memoryEvidenceLinks: 1,
      entityEvidenceLinks: 1,
      relationEvidenceLinks: 1,
      aliasProjections: 1,
    };
    const port: NativeExtractGraphEffectPort = {
      contract: "mengshu.postgres-graph-effect/v1",
      executeGraphEffect: vi.fn(async (request) => ({
        status: "applied" as const,
        receipt: {
          jobId: request.effectInput.id,
          effectKey: "extract_graph.persist.v1",
          requestFingerprint: "a".repeat(64),
          leaseGeneration: request.effectInput.leaseGeneration,
          result: relatedResult,
          committedAt: 500,
        },
      })),
    };
    const handler = createNativeExtractGraphHandler({
      effectPort: port,
      llmClient: llmClient(),
      authoritativeRead: authoritativeRead(),
      compute: vi.fn(async () => ({ entities: [extractedTopic()], relations: [] })),
    });
    const context = { signal: new AbortController().signal, workerId: "worker-a" };

    await expect(handler(authoritativeJob(), context)).resolves.toMatchObject({
      relationIds: ["relation-related"],
      relationEvidenceLinks: 1,
    });

    relatedResult.relationIds.push("relation-over-limit");
    relatedResult.relationEvidenceLinks = 2;
    await expect(handler(authoritativeJob(), context)).rejects.toMatchObject({
      code: "EXTRACT_GRAPH_EFFECT_REJECTED", retryable: false,
    });
  });

  test("严格 receipt 后才按 committedAt 刷新 9D canonical facts，并只投递 hot topic target", async () => {
    const projection = canonicalProjectionHarness(canonicalTopicFacts({
      mentionCount: 20,
      mentionCount30d: 20,
      distinctSourceCount: 3,
      lastSeenAt: 500,
      graphCentrality: 0.8,
      queryHits30d: 4,
      updatedAt: 500,
    }));
    const handler = createNativeExtractGraphHandler({
      effectPort: effectHarness().port,
      llmClient: llmClient(),
      authoritativeRead: authoritativeRead(),
      canonicalEntityCentrality: projection.centrality,
      canonicalEntityTopicRead: projection.read,
      topicTreeAliases: projection.aliases,
      enqueueTopicTarget: projection.enqueue,
      compute: vi.fn(async () => ({ entities: [extractedTopic()], relations: [] })),
    });

    await expect(handler(authoritativeJob(), {
      signal: new AbortController().signal,
      workerId: "worker-a",
    })).resolves.toMatchObject({
      status: "applied",
      entityIds: ["entity-topic"],
      evidenceId: "evidence-a",
      topicTargetCount: 1,
      topicJobIds: ["topic-job-a"],
    });

    expect(projection.events).toEqual(["refresh", "read", "alias", "enqueue:topic"]);
    expect(projection.aliases.persist).toHaveBeenCalledWith({
      scope: fullScope,
      entities: [{ entityId: "entity-topic", canonicalName: "runtime architecture" }],
      now: 500,
    });
    expect(projection.centrality.refresh).toHaveBeenCalledWith({
      scope: fullScope,
      now: 500,
      signal: expect.any(AbortSignal),
    });
    expect(projection.read.read).toHaveBeenCalledWith({
      graphKind: "entity",
      activeMemoryId: "memory-a",
      evidenceId: "evidence-a",
      receiptEntityIds: ["entity-topic"],
      scope: fullScope,
      signal: expect.any(AbortSignal),
    });
    expect(projection.enqueued).toHaveLength(1);
    expect(projection.enqueued[0]?.target).toMatchObject({
      treeType: "topic",
      treeKey: "runtime-architecture",
    });
    expect(projection.enqueued[0]?.input.leaf.entityIds).toEqual(["entity-topic"]);
    expect(projection.enqueued[0]?.input.routing).toMatchObject({
      valueScore: 0.75,
      importance: 0.8,
      semanticType: "experience",
      topicLabels: ["runtime architecture"],
      topicHotnessEligible: true,
    });
  });

  test("首次 cold canonical topic 是 NO-OP，不以 extraction metadata 猜 topic", async () => {
    const projection = canonicalProjectionHarness(canonicalTopicFacts({
      mentionCount: 1,
      mentionCount30d: 1,
      distinctSourceCount: 0,
      lastSeenAt: 500,
      graphCentrality: 0,
      queryHits30d: 0,
      updatedAt: 500,
    }));
    const handler = createNativeExtractGraphHandler({
      effectPort: effectHarness().port,
      llmClient: llmClient(),
      authoritativeRead: authoritativeRead(),
      canonicalEntityCentrality: projection.centrality,
      canonicalEntityTopicRead: projection.read,
      topicTreeAliases: projection.aliases,
      enqueueTopicTarget: projection.enqueue,
      compute: vi.fn(async () => ({
        entities: [extractedTopic({
          mentionCount: 100,
          mentionCount30d: 100,
          distinctSourceCount: 100,
          lastSeenAt: 90,
          queryHits30d: 100,
        })],
        relations: [],
      })),
    });

    await expect(handler(authoritativeJob(), {
      signal: new AbortController().signal,
      workerId: "worker-a",
    })).resolves.toMatchObject({ topicTargetCount: 0, topicJobIds: [] });
    expect(projection.events).toEqual(["refresh", "read"]);
    expect(projection.aliases.persist).not.toHaveBeenCalled();
    expect(projection.enqueue).not.toHaveBeenCalled();
  });

  test("未通过 receipt 验证时 canonical refresh/read/enqueue 均零触达", async () => {
    const projection = canonicalProjectionHarness(canonicalTopicFacts());
    const port: NativeExtractGraphEffectPort = {
      contract: "mengshu.postgres-graph-effect/v1",
      executeGraphEffect: vi.fn(async (request) => ({
        status: "applied" as const,
        receipt: {
          jobId: "forged-job",
          effectKey: "extract_graph.persist.v1",
          requestFingerprint: "a".repeat(64),
          leaseGeneration: request.effectInput.leaseGeneration,
          result: {
            createdEntities: 1,
            createdRelations: 0,
            entityIds: ["entity-topic"],
            relationIds: [],
            evidenceId: "evidence-a",
            memoryEvidenceLinks: 1,
            entityEvidenceLinks: 1,
            relationEvidenceLinks: 0,
            aliasProjections: 0,
          },
          committedAt: 500,
        },
      })),
    };
    const handler = createNativeExtractGraphHandler({
      effectPort: port,
      llmClient: llmClient(),
      authoritativeRead: authoritativeRead(),
      canonicalEntityCentrality: projection.centrality,
      canonicalEntityTopicRead: projection.read,
      topicTreeAliases: projection.aliases,
      enqueueTopicTarget: projection.enqueue,
      compute: vi.fn(async () => ({ entities: [extractedTopic()], relations: [] })),
    });

    await expect(handler(authoritativeJob(), {
      signal: new AbortController().signal,
      workerId: "worker-a",
    })).rejects.toEqual(new DurableJobV2HandlerFailure("EXTRACT_GRAPH_EFFECT_REJECTED", false));
    expect(projection.events).toEqual([]);
  });

  test("applied/replayed 使用相同 canonical topic target identity", async () => {
    const projection = canonicalProjectionHarness(canonicalTopicFacts({
      mentionCount: 20,
      mentionCount30d: 20,
      distinctSourceCount: 3,
      lastSeenAt: 500,
      graphCentrality: 0.8,
      queryHits30d: 4,
      updatedAt: 500,
    }));
    const handler = createNativeExtractGraphHandler({
      effectPort: effectHarness().port,
      llmClient: llmClient(),
      authoritativeRead: authoritativeRead(),
      canonicalEntityCentrality: projection.centrality,
      canonicalEntityTopicRead: projection.read,
      topicTreeAliases: projection.aliases,
      enqueueTopicTarget: projection.enqueue,
      compute: vi.fn(async () => ({ entities: [extractedTopic()], relations: [] })),
    });
    const context = { signal: new AbortController().signal, workerId: "worker-a" };

    await expect(handler(authoritativeJob(), context)).resolves.toMatchObject({ status: "applied" });
    await expect(handler(authoritativeJob(), context)).resolves.toMatchObject({ status: "replayed" });

    expect(projection.enqueued).toHaveLength(2);
    expect(projection.enqueued[0]?.target.idempotencyKey)
      .toBe(projection.enqueued[1]?.target.idempotencyKey);
    expect(projection.enqueued[0]?.target).toEqual(projection.enqueued[1]?.target);
  });

  test("provider replay preflight 跳过 authority/LLM/embedding/effect，仍执行 canonical topic 后处理", async () => {
    const projection = canonicalProjectionHarness(canonicalTopicFacts({
      mentionCount: 20,
      mentionCount30d: 20,
      distinctSourceCount: 3,
      lastSeenAt: 500,
      graphCentrality: 0.8,
      queryHits30d: 4,
      updatedAt: 500,
    }));
    const authoritative = authoritativeRead();
    const compute = vi.fn(async () => ({ entities: [extractedTopic()], relations: [] }));
    const prepareEntityEmbeddings = vi.fn(async () => ({
      authority: "runtime_active_embedding_space" as const,
      embeddingSpaceId: `embedding-space:v1:${"a".repeat(64)}`,
      embeddingSpaceState: "known-queryable" as const,
      vectors: [],
    }));
    const effectPort: NativeExtractGraphEffectPort = {
      contract: "mengshu.postgres-graph-effect/v1",
      inspectAuthoritativeGraphReplay: vi.fn(async () => ({
        status: "replayed" as const,
        receipt: {
          jobId: "job-graph-authoritative-1",
          effectKey: "extract_graph.persist.v1",
          requestFingerprint: "a".repeat(64),
          leaseGeneration: 1,
          result: {
            createdEntities: 1,
            createdRelations: 0,
            entityIds: ["entity-topic"],
            relationIds: [],
            evidenceId: "evidence-a",
            memoryEvidenceLinks: 1,
            entityEvidenceLinks: 1,
            relationEvidenceLinks: 0,
            aliasProjections: 1,
          },
          committedAt: 500,
        },
      })),
      executeGraphEffect: vi.fn(async () => { throw new Error("must not execute"); }),
    };
    const handler = createNativeExtractGraphHandlerImpl({
      effectPort,
      llmClient: llmClient(),
      authoritativeRead: authoritative,
      prepareEntityEmbeddings,
      canonicalEntityCentrality: projection.centrality,
      canonicalEntityTopicRead: projection.read,
      topicTreeAliases: projection.aliases,
      enqueueTopicTarget: projection.enqueue,
      compute,
    });

    await expect(handler(authoritativeJob(), {
      signal: new AbortController().signal,
      workerId: "worker-a",
    })).resolves.toMatchObject({
      status: "replayed",
      entityIds: ["entity-topic"],
      topicTargetCount: 1,
    });
    expect(authoritative.read).not.toHaveBeenCalled();
    expect(compute).not.toHaveBeenCalled();
    expect(prepareEntityEmbeddings).not.toHaveBeenCalled();
    expect(effectPort.executeGraphEffect).not.toHaveBeenCalled();
    expect(projection.events).toEqual(["refresh", "read", "alias", "enqueue:topic"]);
  });

  test("canonical refresh/read/enqueue 失败统一返回可重试 topic projection failure", async () => {
    for (const stage of ["refresh", "read", "alias", "enqueue"] as const) {
      const projection = canonicalProjectionHarness(canonicalTopicFacts({
        mentionCount: 20,
        mentionCount30d: 20,
        distinctSourceCount: 3,
        lastSeenAt: 500,
        graphCentrality: 0.8,
        queryHits30d: 4,
        updatedAt: 500,
      }));
      if (stage === "refresh") vi.mocked(projection.centrality.refresh).mockRejectedValue(new Error("down"));
      if (stage === "read") vi.mocked(projection.read.read).mockRejectedValue(new Error("down"));
      if (stage === "alias") projection.aliases.persist.mockRejectedValue(new Error("down"));
      if (stage === "enqueue") projection.enqueue.mockRejectedValue(new Error("down"));
      const handler = createNativeExtractGraphHandler({
        effectPort: effectHarness().port,
        llmClient: llmClient(),
        authoritativeRead: authoritativeRead(),
        canonicalEntityCentrality: projection.centrality,
        canonicalEntityTopicRead: projection.read,
        topicTreeAliases: projection.aliases,
        enqueueTopicTarget: projection.enqueue,
        compute: vi.fn(async () => ({ entities: [extractedTopic()], relations: [] })),
      });

      await expect(handler(authoritativeJob(), {
        signal: new AbortController().signal,
        workerId: "worker-a",
      })).rejects.toEqual(new DurableJobV2HandlerFailure(
        "EXTRACT_GRAPH_TOPIC_PROJECTION_RETRYABLE",
        true,
      ));
    }
  });

  test("authoritative read/compute abort 原样终止且后续阶段零触达", async () => {
    const abort = new AbortController();
    const harness = effectHarness();
    const compute = vi.fn(async () => ({ entities: [], relations: [] }));
    const readPort: AuthoritativeEntityGraphReadPort = {
      read: vi.fn(async () => {
        abort.abort();
        throw abort.signal.reason;
      }),
    };
    const handler = createNativeExtractGraphHandler({
      effectPort: harness.port,
      llmClient: llmClient(),
      authoritativeRead: readPort,
      compute,
    });

    await expect(handler(authoritativeJob(), {
      signal: abort.signal,
      workerId: "worker-a",
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(compute).not.toHaveBeenCalled();
    expect(harness.requests).toEqual([]);
  });
});
