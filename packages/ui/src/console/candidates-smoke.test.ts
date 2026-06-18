/**
 * Console Candidates 端到端 smoke 测试。
 *
 * 通过真实 HTTP daemon 验证 serve 注入 Console 后的候选区治理闭环：
 * 1. 候选区入队 pending 候选。
 * 2. POST /v1/console/candidates 列出 pending。
 * 3. POST /v1/console/candidates/review approve → promoteCandidate 写入主库。
 * 4. 列表中该候选不再 pending。
 *
 * 关键边界：approve 才经 promoteCandidate 进主库；这里用收集型 fake 验证 store 被调用。
 */

import { afterEach, describe, expect, test } from "vitest";
import type { MemoryService } from "../../../../core/service-types.js";
import type { ContextBlock, MemoryRecord, RecallResult } from "../../../../core/types.js";
import { createConsoleApi } from "./api.js";
import { startMemoryServer, type RunningMemoryServer } from "../../../../server/daemon.js";
import { InMemoryCandidateRepository } from "../../../../lifecycle/candidate-repository.js";
import { CandidateReviewService } from "../../../../lifecycle/candidate-review.js";
import { candidateToMemoryRecord } from "../../../../lifecycle/candidate-promotion.js";

const scope = {
  tenantId: "local",
  appId: "openclaw",
  userId: "user-1",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "memories",
};

class CollectingMemoryService implements MemoryService {
  stored: MemoryRecord[] = [];

  async storeMemory(input: { record: MemoryRecord }) {
    this.stored.push(input.record);
    return { id: input.record.id, stored: true };
  }

  async recall(): Promise<RecallResult> {
    return { scope, query: "console", hits: [] };
  }

  async buildContext(): Promise<ContextBlock> {
    return { scope, content: "", hits: [], tokenEstimate: 0 };
  }

  async delete() {
    return { deleted: 0 };
  }

  async health() {
    return { ok: true, records: this.stored.length };
  }
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("console candidates end-to-end via daemon", () => {
  let running: RunningMemoryServer | undefined;

  afterEach(async () => {
    await running?.stop();
    running = undefined;
  });

  test("enqueue -> list pending -> approve -> promoted to main store", async () => {
    const service = new CollectingMemoryService();
    const repository = new InMemoryCandidateRepository();
    const candidateReview = new CandidateReviewService({
      repository,
      promoteCandidate: async ({ candidate }) => {
        const record = candidateToMemoryRecord(candidate, 1710000000000);
        await service.storeMemory({ record });
        return { memoryId: record.id };
      },
    });

    const enqueued = await repository.enqueue({
      scope,
      text: "复杂方案先给短结论再给计划",
      semanticType: "profile",
      kind: "preference",
      confidence: 0.85,
      evidenceIds: ["ev-1"],
      metadata: {},
    });

    running = await startMemoryServer({
      service,
      console: createConsoleApi({ service, candidates: repository, candidateReview }),
      host: "127.0.0.1",
      port: 0,
    });

    // 1. 列出 pending 候选
    const listResp = await postJson(`${running.url}/v1/console/candidates`, {
      scope,
      filter: { status: "pending" },
    });
    expect(listResp.status).toBe(200);
    const listBody = (await listResp.json()) as { total: number; candidates: Array<{ id: string }> };
    expect(listBody.total).toBe(1);
    expect(listBody.candidates[0].id).toBe(enqueued.id);

    // 2. approve 该候选
    const reviewResp = await postJson(`${running.url}/v1/console/candidates/review`, {
      action: { action: "approve", ids: [enqueued.id] },
    });
    expect(reviewResp.status).toBe(200);
    const reviewBody = (await reviewResp.json()) as { affected: number; promoted: string[] };
    expect(reviewBody.affected).toBe(1);

    // 3. 已写入主库
    expect(service.stored).toHaveLength(1);
    expect(service.stored[0].text).toBe("复杂方案先给短结论再给计划");
    expect(service.stored[0].lifecycleStatus).toBe("active");

    // 4. 不再 pending
    const afterResp = await postJson(`${running.url}/v1/console/candidates`, {
      scope,
      filter: { status: "pending" },
    });
    const afterBody = (await afterResp.json()) as { total: number };
    expect(afterBody.total).toBe(0);
  });
});
