import { describe, expect, test, vi } from "vitest";
import type { MemoryService } from "../../../../core/service-types.js";
import type { ContextBlock, MemoryRecord, RecallResult } from "../../../../core/types.js";
import { InMemoryGraphRepository } from "../../../../graph/repository.js";
import { GraphQueryService } from "../../../../graph/query.js";
import { createConsoleApi } from "../../../../console/api.js";
import { InMemoryCandidateRepository } from "../../../../lifecycle/candidate-repository.js";
import { CandidateReviewService } from "../../../../lifecycle/candidate-review.js";
import { createRestApi, createRestRouter } from "./router.js";
import type { AuthorityScope } from "../../../core/src/domain/authority-scope.js";
import type { MemoryConfig } from "../../../../config.js";

const scope = {
  tenantId: "local",
  appId: "openclaw",
  userId: "user-1",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "memories",
};

const record: MemoryRecord = {
  id: "mem-1",
  scope,
  kind: "preference",
  text: "User prefers concise replies",
  contentHash: "hash-1",
  importance: 0.8,
  category: "preference",
  dataType: "memory",
  tableName: "memories",
  metadata: {},
  provenance: {},
  createdAt: 1710000000000,
};

const transportAuthority: AuthorityScope = {
  tenantId: "server-tenant",
  userId: "server-user",
  allow: {
    appIds: ["rest"],
    projectIds: ["project-1"],
    agentIds: ["agent-1"],
    namespaces: ["memories"],
    visibilities: ["private"],
  },
};

const attackerScope = {
  tenantId: "attacker-tenant",
  userId: "attacker-user",
  appId: "rest",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "memories",
  visibility: "private",
};

const restConfig: MemoryConfig = {
  embedding: {
    provider: "openai",
    apiKey: "test-key",
    baseURL: "http://127.0.0.1:9/v1",
    model: "text-embedding-3-small",
  },
  dbType: "lancedb",
  dbPath: "/tmp/mengshu-rest-router-test",
};

class FakeMemoryService implements MemoryService {
  async storeMemory() {
    return { id: "mem-1", stored: true };
  }

  async recall(): Promise<RecallResult> {
    return {
      scope,
      query: "concise",
      hits: [{ record, score: 0.9, source: "vector" }],
    };
  }

  async buildContext(): Promise<ContextBlock> {
    return {
      scope,
      content: "<retrieved-context>safe</retrieved-context>",
      hits: [{ record, score: 0.9, source: "vector" }],
      tokenEstimate: 8,
    };
  }

  async delete() {
    return { deleted: 0 };
  }

  async health() {
    return { ok: true, records: 1 };
  }
}

describe("REST router", () => {
  test("rejects production router construction without authority", () => {
    expect(() => createRestRouter({ service: new FakeMemoryService() })).toThrow(
      /REST authority is required/,
    );
  });

  test("createRestApi 将 exact authority 解析为 runtime 的唯一持久 scope", () => {
    const api = createRestApi(restConfig, restConfig.dbPath!, transportAuthority);

    expect(api.runtime.defaultScope).toEqual({
      tenantId: "server-tenant",
      userId: "server-user",
      appId: "rest",
      projectId: "project-1",
      agentId: "agent-1",
      namespace: "memories",
      visibility: "private",
    });
  });

  test("createRestApi 拒绝无法解析为单一 runtime scope 的多值 authority", () => {
    expect(() => createRestApi(restConfig, restConfig.dbPath!, {
      ...transportAuthority,
      allow: {
        ...transportAuthority.allow,
        projectIds: ["project-1", "project-2"],
      },
    })).toThrow();
  });

  test("candidate review 在进入 Console 前解析并校验 server authority scope", async () => {
    const reviewCandidates = vi.fn(async () => ({ affected: 0, promoted: [], errors: [] }));
    const router = createRestRouter({
      service: new FakeMemoryService(),
      authority: transportAuthority,
      console: { reviewCandidates } as unknown as NonNullable<
        Parameters<typeof createRestRouter>[0]["console"]
      >,
    });

    const response = await router.handle({
      method: "POST",
      path: "/v1/console/candidates/review",
      headers: {},
      body: {
        scope: { ...attackerScope, appId: "outside-authority" },
        action: { action: "approve", ids: ["candidate-1"] },
      },
    });

    expect(response.status).toBe(400);
    expect(reviewCandidates).not.toHaveBeenCalled();
  });

  test("authority makes attacker tenant/user override zero before save/recall/context/observe/forget", async () => {
    const service = new FakeMemoryService();
    const capturedScopes: unknown[] = [];
    service.storeMemory = (async (input: { record: { scope: unknown } }) => {
      capturedScopes.push(input.record.scope);
      return { id: "mem-1", stored: true };
    }) as unknown as typeof service.storeMemory;
    service.recall = (async (input: { scope: unknown }) => {
      capturedScopes.push(input.scope);
      return { scope, query: "", hits: [] };
    }) as unknown as typeof service.recall;
    service.buildContext = (async (input: { scope: unknown }) => {
      capturedScopes.push(input.scope);
      return { scope, content: "", hits: [], tokenEstimate: 0 };
    }) as unknown as typeof service.buildContext;
    const forgetService = {
      async forget(input: { clientScope: unknown; serverAuthority: AuthorityScope }) {
        capturedScopes.push({
          ...(input.clientScope as Record<string, unknown>),
          tenantId: input.serverAuthority.tenantId,
          userId: input.serverAuthority.userId,
        });
        return { action: "delete" as const, affected: 0, deleted: 0, affectedIds: [], transactional: true as const, idempotentReplay: false };
      },
    };
    const agentFastPath = {
      async observeLight(input: { scope: unknown }) {
        capturedScopes.push(input.scope);
        return { ack: true as const, traceId: "trace-1", queuedJobs: [] };
      },
    } as unknown as NonNullable<Parameters<typeof createRestRouter>[0]["agentFastPath"]>;
    const router = createRestRouter({ service, forgetService, agentFastPath, authority: transportAuthority });

    const responses = await Promise.all([
      router.handle({
        method: "POST",
        path: "/v1/memories",
        headers: {},
        body: { record: { ...record, scope: attackerScope } },
      }),
      router.handle({
        method: "POST",
        path: "/v1/recall",
        headers: {},
        body: { query: "recall", scope: attackerScope },
      }),
      router.handle({
        method: "POST",
        path: "/v1/context",
        headers: {},
        body: { query: "context", scope: attackerScope },
      }),
      router.handle({
        method: "POST",
        path: "/v1/agent/observe",
        headers: {},
        body: { text: "observe", eventType: "user_input", scope: attackerScope },
      }),
      router.handle({
        method: "POST",
        path: "/v1/forget",
        headers: {},
        body: { filter: { category: "core" }, scope: attackerScope, idempotencyKey: "request-1" },
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([201, 200, 200, 200, 200]);
    expect(capturedScopes).toHaveLength(5);
    for (const captured of capturedScopes) {
      expect(captured).toMatchObject({ tenantId: "server-tenant", userId: "server-user" });
      expect(captured).not.toMatchObject({ tenantId: "attacker-tenant" });
    }
  });

  test.each([
    ["invalid action", { action: "destroy", ids: ["mem-1"] }],
    ["non-string id", { ids: ["mem-1", 42] }],
    ["empty id", { ids: [""] }],
    ["duplicate ids", { ids: ["mem-1", "mem-1"] }],
  ])("RED: REST forget rejects %s before service", async (_label, invalid) => {
    const inputs: unknown[] = [];
    const forgetService = {
      async forget(input: unknown) {
        inputs.push(input);
        return { action: "delete" as const, affected: 0, deleted: 0, affectedIds: [], transactional: true as const, idempotentReplay: false };
      },
    };
    const router = createRestRouter({
      service: new FakeMemoryService(),
      forgetService,
      authority: transportAuthority,
    });

    const response = await router.handle({
      method: "POST",
      path: "/v1/forget",
      headers: {},
      body: {
        ...invalid,
        scope: {
          appId: "rest",
          projectId: "project-1",
          agentId: "agent-1",
          namespace: "memories",
          visibility: "private",
        },
        idempotencyKey: "request-1",
      },
    });

    expect(response.status).toBe(400);
    expect(inputs).toEqual([]);
  });
  test("returns health snapshot", async () => {
    const router = createRestRouter({ unsafeLegacyScope: true, service: new FakeMemoryService() });

    await expect(router.handle({ method: "GET", path: "/v1/health", headers: {} })).resolves.toEqual({
      status: 200,
      body: { ok: true, records: 1 },
    });
  });

  test("stores memory from JSON body", async () => {
    const router = createRestRouter({ unsafeLegacyScope: true, service: new FakeMemoryService() });

    await expect(
      router.handle({
        method: "POST",
        path: "/v1/memories",
        headers: {},
        body: {
          record,
        },
      }),
    ).resolves.toEqual({
      status: 201,
      body: { id: "mem-1", stored: true },
    });
  });

  test("recalls memories and builds context", async () => {
    const router = createRestRouter({ unsafeLegacyScope: true, service: new FakeMemoryService() });

    const recall = await router.handle({
      method: "POST",
      path: "/v1/recall",
      headers: {},
      body: { query: "concise", scope: { appId: "openclaw" } },
    });
    const context = await router.handle({
      method: "POST",
      path: "/v1/context",
      headers: {},
      body: { query: "concise", scope: { appId: "openclaw" } },
    });

    expect(recall.status).toBe(200);
    expect(recall.body).toMatchObject({ query: "concise" });
    expect(context.status).toBe(200);
    expect(context.body).toMatchObject({ content: "<retrieved-context>safe</retrieved-context>" });
  });

  test("applies auth guard and returns JSON errors", async () => {
    const router = createRestRouter({ unsafeLegacyScope: true,
      service: new FakeMemoryService(),
      server: { secret: "secret-token" },
    });

    await expect(
      router.handle({
        method: "GET",
        path: "/v1/health",
        headers: { authorization: "Bearer wrong" },
        remoteAddress: "127.0.0.1",
      }),
    ).resolves.toEqual({
      status: 401,
      body: { error: "Invalid bearer token" },
    });
  });

  test("routes graph query when graph service is configured", async () => {
    const repository = new InMemoryGraphRepository();
    await repository.upsertEntities([
      {
        id: "entity-1",
        scope,
        canonicalName: "mengshu",
        displayName: "mengshu",
        type: "project",
        aliases: ["mengshu"],
        mentionCount: 1,
        mentionCount30d: 1,
        distinctSourceCount: 1,
        lastSeenAt: 1710000000000,
        hotness: 4,
        queryHits30d: 0,
        status: "active",
        createdAt: 1710000000000,
        updatedAt: 1710000000000,
        metadata: {},
      },
    ]);
    const router = createRestRouter({ unsafeLegacyScope: true,
      service: new FakeMemoryService(),
      graph: new GraphQueryService(repository),
    });

    const result = await router.handle({
      method: "POST",
      path: "/v1/graph/query",
      headers: {},
      body: { scope, query: "mengshu" },
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      entities: [expect.objectContaining({ id: "entity-1" })],
      evidenceChunkIds: [],
    });
  });

  test("routes console overview, lookup and jobs", async () => {
    const service = new FakeMemoryService();
    const router = createRestRouter({ unsafeLegacyScope: true,
      service,
      console: createConsoleApi({ service }),
    });

    const overview = await router.handle({
      method: "POST",
      path: "/v1/console/overview",
      headers: {},
      body: { scope },
    });
    const lookup = await router.handle({
      method: "POST",
      path: "/v1/console/lookup",
      headers: {},
      body: { scope, query: "concise" },
    });
    const jobs = await router.handle({
      method: "GET",
      path: "/v1/console/jobs",
      headers: {},
    });

    expect(overview.status).toBe(200);
    expect(overview.body).toMatchObject({ metrics: { memories: 1 } });
    expect(lookup.status).toBe(200);
    expect(lookup.body).toMatchObject({ results: [expect.objectContaining({ id: "mem-1" })] });
    expect(jobs.status).toBe(200);
    expect(jobs.body).toEqual({ jobs: [], counts: {} });
  });

  test("routes console candidates list and review", async () => {
    const service = new FakeMemoryService();
    const repository = new InMemoryCandidateRepository();
    const candidate = await repository.enqueue({
      scope,
      text: "candidate via REST",
      semanticType: "profile",
      kind: "preference",
      confidence: 0.8,
      evidenceIds: ["ev-1"],
      metadata: {},
    });
    const review = new CandidateReviewService({
      repository,
      promoteCandidate: async ({ candidate: c }) => ({ memoryId: `mem-${c.id}` }),
    });
    const router = createRestRouter({ unsafeLegacyScope: true,
      service,
      console: createConsoleApi({ service, candidates: repository, candidateReview: review }),
    });

    const list = await router.handle({
      method: "POST",
      path: "/v1/console/candidates",
      headers: {},
      body: { scope, filter: { status: "pending" } },
    });
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({
      total: 1,
      candidates: [expect.objectContaining({ id: candidate.id, preview: "candidate via REST" })],
    });

    const reviewResult = await router.handle({
      method: "POST",
      path: "/v1/console/candidates/review",
      headers: {},
      body: { action: { action: "approve", ids: [candidate.id] } },
    });
    expect(reviewResult.status).toBe(200);
    expect(reviewResult.body).toMatchObject({ affected: 1, promoted: [`mem-${candidate.id}`] });

    const missingAction = await router.handle({
      method: "POST",
      path: "/v1/console/candidates/review",
      headers: {},
      body: { scope },
    });
    expect(missingAction.status).toBe(400);
  });

  test("returns 404 and 405 for unsupported routes", async () => {
    const router = createRestRouter({ unsafeLegacyScope: true, service: new FakeMemoryService() });

    await expect(router.handle({ method: "GET", path: "/v1/missing", headers: {} })).resolves.toEqual({
      status: 404,
      body: { error: "Not found" },
    });
    await expect(router.handle({ method: "GET", path: "/v1/recall", headers: {} })).resolves.toEqual({
      status: 405,
      body: { error: "Method not allowed" },
    });
  });
});
