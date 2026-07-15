import { describe, expect, test, vi } from "vitest";

import type { LlmClient } from "../packages/core/src/runtime/llm/llm-client.js";
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
import { DurableJobV2HandlerFailure } from "./workers-v2.js";
import {
  createNativeExtractGraphHandler,
  type NativeExtractGraphEffectPort,
  type NativeExtractGraphEffectRequest,
} from "./native-extract-graph-handler.js";

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
      const result = {
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
});
