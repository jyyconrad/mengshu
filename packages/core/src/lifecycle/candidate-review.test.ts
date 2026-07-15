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
});
