import { describe, expect, test, vi } from "vitest";
import type { CandidateRecord } from "./candidate-types.js";
import { CandidateReviewService, candidateToMemoryRecord } from "./candidate-review.js";

const candidate: CandidateRecord = {
  id: "candidate-public-helper",
  scope: {
    tenantId: "tenant-a",
    userId: "user-a",
    appId: "codex",
    projectId: "project-a",
    agentId: "agent-a",
    namespace: "memories",
  },
  text: "public compatibility helper",
  kind: "fact",
  confidence: 0.8,
  evidenceIds: [],
  status: "pending",
  hitCount: 0,
  metadata: {},
  createdAt: 1,
};

describe("candidate-review public candidateToMemoryRecord", () => {
  test("默认 durable id 为稳定 UUID；candidate logical id 保持可追溯", () => {
    const first = candidateToMemoryRecord(candidate, { contentHash: "hash-a" });
    const second = candidateToMemoryRecord(candidate, { contentHash: "hash-a" });

    expect(first.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second.id).toBe(first.id);
    expect(first.metadata.promotedFromCandidate).toBe(candidate.id);
    expect(first.provenance.sourceId).toBe(candidate.id);
  });

  test("显式 idFactory 仍由调用方负责 provider 合同", () => {
    expect(candidateToMemoryRecord(candidate, {
      contentHash: "hash-a",
      idFactory: () => "11111111-1111-4111-8111-111111111111",
    }).id).toBe("11111111-1111-4111-8111-111111111111");
  });
});

describe("CandidateReviewService approval capability", () => {
  test.each([{ version: 1, operation: "evolve" }, null, false])(
    "ordinary approvals reject isolated evolution metadata: %j",
    async (evolution) => {
      const isolated = { ...candidate, metadata: { evolution } };
      const setStatus = vi.fn();
      const promoteCandidate = vi.fn();
      const service = new CandidateReviewService({
        repository: { get: async () => isolated, list: async () => [isolated], setStatus },
        promoteCandidate,
      });
      await expect(service.review({ action: "approve_by_filter", filter: {} }))
        .resolves.toEqual({ affected: 0, promoted: [], errors: [`evolution_review_required:${candidate.id}`] });
      expect(promoteCandidate).not.toHaveBeenCalled();
      expect(setStatus).not.toHaveBeenCalled();
    },
  );

  test("缺少 promotion capability 时在任何状态写入前 fail-closed", async () => {
    const setStatus = vi.fn(async () => undefined);
    const service = new CandidateReviewService({
      repository: {
        get: vi.fn(async () => candidate),
        list: vi.fn(async () => [candidate]),
        setStatus,
      },
    });

    await expect(service.review({ action: "approve", ids: [candidate.id] }))
      .resolves.toEqual({
        affected: 0,
        promoted: [],
        errors: [`promotion_unavailable:${candidate.id}`],
      });
    expect(setStatus).not.toHaveBeenCalled();
  });

  test("provider-owned promotion 已原子提交治理副作用时不执行二次 setStatus/audit", async () => {
    const setStatus = vi.fn(async () => undefined);
    const audit = vi.fn(async () => undefined);
    const service = new CandidateReviewService({
      repository: {
        get: vi.fn(async () => candidate),
        list: vi.fn(async () => [candidate]),
        setStatus,
      },
      promoteCandidate: vi.fn(async () => ({
        memoryId: "11111111-1111-4111-8111-111111111111",
        governanceCommitted: true as const,
      })),
      audit,
    });

    await expect(service.review({ action: "approve", ids: [candidate.id] }))
      .resolves.toEqual({
        affected: 1,
        promoted: ["11111111-1111-4111-8111-111111111111"],
        errors: [],
      });
    expect(setStatus).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  test("显式启用原子 receipt replay 时，approved candidate 可修补 promotion 后置派生", async () => {
    const approved = Object.freeze({
      ...candidate,
      status: "approved" as const,
      promotedToMemoryId: "11111111-1111-4111-8111-111111111111",
    });
    const promoteCandidate = vi.fn()
      .mockRejectedValueOnce(new Error("temporary derivation failure"))
      .mockResolvedValueOnce({
        memoryId: approved.promotedToMemoryId,
        governanceCommitted: true as const,
      });
    const setStatus = vi.fn(async () => undefined);
    const service = new CandidateReviewService({
      repository: {
        get: vi.fn(async () => approved),
        list: vi.fn(async () => [approved]),
        setStatus,
      },
      promoteCandidate,
      replayApprovedPromotion: true,
    });

    await expect(service.review({ action: "approve", ids: [approved.id] }))
      .resolves.toEqual({
        affected: 0,
        promoted: [],
        errors: [`promote_failed:${approved.id}:temporary derivation failure`],
      });
    await expect(service.review({ action: "approve", ids: [approved.id] }))
      .resolves.toEqual({
        affected: 1,
        promoted: [approved.promotedToMemoryId],
        errors: [],
      });
    expect(promoteCandidate).toHaveBeenCalledTimes(2);
    expect(setStatus).not.toHaveBeenCalled();
  });

  test("普通兼容 promotion 不允许把 approved candidate 当作 replay", async () => {
    const approved = Object.freeze({
      ...candidate,
      status: "approved" as const,
      promotedToMemoryId: "11111111-1111-4111-8111-111111111111",
    });
    const promoteCandidate = vi.fn(async () => ({ memoryId: approved.promotedToMemoryId }));
    const service = new CandidateReviewService({
      repository: {
        get: vi.fn(async () => approved),
        list: vi.fn(async () => [approved]),
        setStatus: vi.fn(async () => undefined),
      },
      promoteCandidate,
    });

    await expect(service.review({ action: "approve", ids: [approved.id] }))
      .resolves.toEqual({
        affected: 0,
        promoted: [],
        errors: [`not_pending:${approved.id}`],
      });
    expect(promoteCandidate).not.toHaveBeenCalled();
  });
});
