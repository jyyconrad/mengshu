import { describe, expect, test } from "vitest";
import type { MemoryService } from "../../core/service-types.js";
import type { ContextBlock, MemoryRecord, RecallResult } from "../../core/types.js";
import { InMemoryGraphRepository } from "../../graph/repository.js";
import { GraphQueryService } from "../../graph/query.js";
import { createConsoleApi } from "../../console/api.js";
import { InMemoryCandidateRepository } from "../../lifecycle/candidate-repository.js";
import { CandidateReviewService } from "../../lifecycle/candidate-review.js";
import { createRestRouter } from "./router.js";

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
  test("returns health snapshot", async () => {
    const router = createRestRouter({ service: new FakeMemoryService() });

    await expect(router.handle({ method: "GET", path: "/v1/health", headers: {} })).resolves.toEqual({
      status: 200,
      body: { ok: true, records: 1 },
    });
  });

  test("stores memory from JSON body", async () => {
    const router = createRestRouter({ service: new FakeMemoryService() });

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
    const router = createRestRouter({ service: new FakeMemoryService() });

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
    const router = createRestRouter({
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
    const router = createRestRouter({
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
    const router = createRestRouter({
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
    const router = createRestRouter({
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
    const router = createRestRouter({ service: new FakeMemoryService() });

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
