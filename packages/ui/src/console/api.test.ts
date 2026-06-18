import { describe, expect, test } from "vitest";
import type { MemoryService, StoreMemoryInput, RecallInput, DeleteMemoryInput } from "../../../../core/service-types.js";
import type { ContextBlock, MemoryRecord, RecallResult } from "../../../../core/types.js";
import { InMemoryGraphRepository } from "../../../../graph/repository.js";
import { GraphQueryService } from "../../../../graph/query.js";
import { InMemoryMemoryStore } from "../../../../storage/repositories/in-memory.js";
import { InMemoryTreeRepository } from "../../../../tree/buffer.js";
import { buildDailyDigest } from "../../../../tree/global.js";
import { InMemoryCandidateRepository } from "../../../../lifecycle/candidate-repository.js";
import { CandidateReviewService } from "../../../../lifecycle/candidate-review.js";
import type { CandidateRecord } from "../../../../lifecycle/candidate-types.js";
import { createConsoleApi } from "./api.js";

const scope = {
  tenantId: "local",
  appId: "openclaw",
  userId: "user-1",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "knowledge",
};

function record(id: string, text: string, metadata: Record<string, unknown> = {}): MemoryRecord {
  return {
    id,
    scope,
    kind: "knowledge",
    text,
    contentHash: `hash-${id}`,
    importance: 0.5,
    category: "other",
    dataType: "knowledge",
    tableName: "knowledge",
    metadata,
    provenance: { source: "scan", sourceId: `source-${id}` },
    createdAt: 1710000000000,
  };
}

class FakeMemoryService implements MemoryService {
  constructor(private readonly hits: Array<MemoryRecord & { score: number }> = []) {}

  async storeMemory(_input: StoreMemoryInput) {
    return { id: "mem-1", stored: true };
  }

  async recall(input: RecallInput): Promise<RecallResult> {
    return {
      scope,
      query: input.query,
      hits: this.hits.map((hit) => ({
        record: hit,
        score: hit.score,
        source: "vector",
        scoreBreakdown: { vector: hit.score },
        provenance: hit.provenance,
      })),
    };
  }

  async buildContext(): Promise<ContextBlock> {
    return { scope, content: "", hits: [], tokenEstimate: 0 };
  }

  async delete(_input: DeleteMemoryInput) {
    return { deleted: 0 };
  }

  async health() {
    return { ok: true, records: this.hits.length };
  }
}

describe("console API", () => {
  test("builds overview from service, graph, tree and jobs", async () => {
    const graphRepository = new InMemoryGraphRepository();
    await graphRepository.upsertEntities([
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
        hotness: 7,
        queryHits30d: 0,
        status: "active",
        createdAt: 1710000000000,
        updatedAt: 1710000000000,
        metadata: {},
      },
    ]);
    const store = new InMemoryMemoryStore();
    await store.jobs.enqueue({ type: "embed_chunk", payload: {}, dedupeKey: "embed_chunk:1" });
    const tree = new InMemoryTreeRepository();
    await buildDailyDigest(tree, scope, "2026-06-06", [], 1710000000000);
    const api = createConsoleApi({
      service: new FakeMemoryService([{ ...record("mem-1", "memory"), score: 0.9 }]),
      graph: new GraphQueryService(graphRepository),
      jobs: store.jobs,
      tree,
      chunks: store.chunks,
    });

    const overview = await api.overview(scope);

    expect(overview.metrics).toMatchObject({
      memories: 1,
      queuedJobs: 1,
      summaries: 1,
      entities: 1,
    });
    expect(overview.hotTopics).toEqual([{ id: "entity-1", label: "mengshu", hotness: 7 }]);
    expect(overview.dailyDigest?.title).toBe("Daily Digest 2026-06-06");
  });

  test("lookup hides private raw content and keeps provenance fields", async () => {
    const api = createConsoleApi({
      service: new FakeMemoryService([
        { ...record("public", "public memory"), score: 0.9 },
        { ...record("private", "secret memory", { private: true }), score: 0.8 },
      ]),
    });

    const result = await api.lookup({ scope, query: "memory" });

    expect(result.results).toEqual([
      expect.objectContaining({ id: "public", preview: "public memory", raw: "public memory", sourceLabel: "source-public" }),
      expect.objectContaining({ id: "private", preview: "[private]", raw: undefined, sourceLabel: "source-private" }),
    ]);
  });
});

function candidateInput(
  text: string,
  overrides: Partial<CandidateRecord> = {}
): Parameters<InMemoryCandidateRepository["enqueue"]>[0] {
  return {
    scope,
    text,
    semanticType: overrides.semanticType ?? "profile",
    kind: overrides.kind ?? "preference",
    confidence: overrides.confidence ?? 0.8,
    reason: overrides.reason,
    evidenceIds: overrides.evidenceIds ?? ["ev-1"],
    extractor: overrides.extractor ?? "auto",
    metadata: overrides.metadata ?? { secret: "should-not-leak" },
  };
}

describe("console candidates", () => {
  test("candidates() lists pending and projects only UI fields", async () => {
    const repository = new InMemoryCandidateRepository();
    await repository.enqueue(candidateInput("用户偏好深色主题"));
    const api = createConsoleApi({ service: new FakeMemoryService(), candidates: repository });

    const result = await api.candidates({ scope, filter: { status: "pending" } });

    expect(result.total).toBe(1);
    const [candidate] = result.candidates;
    expect(candidate.preview).toBe("用户偏好深色主题");
    expect(candidate.semanticType).toBe("profile");
    expect(candidate.confidence).toBe(0.8);
    expect(candidate.status).toBe("pending");
    expect(candidate.evidenceIds).toEqual(["ev-1"]);
    // 内部字段不应泄露
    expect((candidate as unknown as Record<string, unknown>).metadata).toBeUndefined();
    expect((candidate as unknown as Record<string, unknown>).hitCount).toBeUndefined();
    expect((candidate as unknown as Record<string, unknown>).extractor).toBeUndefined();
  });

  test("candidates() returns empty list when repository not injected", async () => {
    const api = createConsoleApi({ service: new FakeMemoryService() });
    const result = await api.candidates({ scope });
    expect(result).toEqual({ candidates: [], total: 0 });
  });

  test("approve promotes candidate to main store and records audit", async () => {
    const repository = new InMemoryCandidateRepository();
    const candidate = await repository.enqueue(candidateInput("接受我"));
    const stored: CandidateRecord[] = [];
    const audited: string[] = [];
    const review = new CandidateReviewService({
      repository,
      promoteCandidate: async ({ candidate: c }) => {
        stored.push(c);
        return { memoryId: `mem-${c.id}` };
      },
      audit: async ({ action }) => {
        audited.push(action);
      },
    });
    const api = createConsoleApi({
      service: new FakeMemoryService(),
      candidates: repository,
      candidateReview: review,
    });

    const result = await api.reviewCandidates({ action: { action: "approve", ids: [candidate.id] } });

    expect(result.affected).toBe(1);
    expect(result.promoted).toEqual([`mem-${candidate.id}`]);
    // 验收 2：approve 后该候选经 promoteCandidate 写入主库
    expect(stored.map((c) => c.text)).toEqual(["接受我"]);
    expect(audited).toContain("candidate.approve");
    // approve 后不再 pending
    const stillPending = await api.candidates({ scope, filter: { status: "pending" } });
    expect(stillPending.total).toBe(0);
    const promotedRecord = await repository.get(candidate.id);
    expect(promotedRecord?.status).toBe("approved");
    expect(promotedRecord?.promotedToMemoryId).toBe(`mem-${candidate.id}`);
  });

  test("reject and archive remove candidates from pending without promoting", async () => {
    const repository = new InMemoryCandidateRepository();
    const toReject = await repository.enqueue(candidateInput("拒绝我"));
    const toArchive = await repository.enqueue(candidateInput("归档我"));
    const stored: CandidateRecord[] = [];
    const review = new CandidateReviewService({
      repository,
      promoteCandidate: async ({ candidate: c }) => {
        stored.push(c);
        return { memoryId: `mem-${c.id}` };
      },
    });
    const api = createConsoleApi({
      service: new FakeMemoryService(),
      candidates: repository,
      candidateReview: review,
    });

    await api.reviewCandidates({ action: { action: "reject", ids: [toReject.id], reason: "noise" } });
    await api.reviewCandidates({ action: { action: "archive", ids: [toArchive.id] } });

    const pending = await api.candidates({ scope, filter: { status: "pending" } });
    expect(pending.total).toBe(0);
    // 验收 3：reject/archive 不会触发 promote，即不会注入主库
    expect(stored).toEqual([]);
    expect((await repository.get(toReject.id))?.status).toBe("rejected");
    expect((await repository.get(toArchive.id))?.status).toBe("archived");
  });

  test("batch approve_by_filter promotes all matching pending candidates", async () => {
    const repository = new InMemoryCandidateRepository();
    await repository.enqueue(candidateInput("高分1", { semanticType: "rules", confidence: 0.95 }));
    await repository.enqueue(candidateInput("高分2", { semanticType: "rules", confidence: 0.9 }));
    await repository.enqueue(candidateInput("低分", { semanticType: "rules", confidence: 0.5 }));
    const stored: CandidateRecord[] = [];
    const review = new CandidateReviewService({
      repository,
      promoteCandidate: async ({ candidate: c }) => {
        stored.push(c);
        return { memoryId: `mem-${c.id}` };
      },
    });
    const api = createConsoleApi({
      service: new FakeMemoryService(),
      candidates: repository,
      candidateReview: review,
    });

    const result = await api.reviewCandidates({
      action: { action: "approve_by_filter", filter: { semanticType: "rules", minConfidence: 0.9 } },
    });

    // 验收 4：批量操作覆盖
    expect(result.affected).toBe(2);
    expect(stored.map((c) => c.text).sort()).toEqual(["高分1", "高分2"]);
    expect((await api.candidates({ scope, filter: { status: "pending" } })).total).toBe(1);
  });

  test("overview reports pendingCandidates backlog and slotFreshness", async () => {
    const repository = new InMemoryCandidateRepository();
    await repository.enqueue(candidateInput("候选1"));
    await repository.enqueue(candidateInput("候选2"));
    const api = createConsoleApi({ service: new FakeMemoryService(), candidates: repository });

    const overview = await api.overview(scope);

    expect(overview.metrics.pendingCandidates).toBe(2);
    expect(typeof overview.slotFreshness).toBe("number");
  });

  test("overview pendingCandidates is 0 when candidates not injected", async () => {
    const api = createConsoleApi({ service: new FakeMemoryService() });
    const overview = await api.overview(scope);
    expect(overview.metrics.pendingCandidates).toBe(0);
  });

  test("candidateCount counts pending candidates", async () => {
    const repository = new InMemoryCandidateRepository();
    await repository.enqueue(candidateInput("a"));
    await repository.enqueue(candidateInput("b"));
    const api = createConsoleApi({ service: new FakeMemoryService(), candidates: repository });
    expect(await api.candidateCount(scope, { status: "pending" })).toBe(2);
  });

  test("reviewCandidates without review service returns error result", async () => {
    const repository = new InMemoryCandidateRepository();
    const candidate = await repository.enqueue(candidateInput("x"));
    const api = createConsoleApi({ service: new FakeMemoryService(), candidates: repository });
    const result = await api.reviewCandidates({ action: { action: "approve", ids: [candidate.id] } });
    expect(result.affected).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
