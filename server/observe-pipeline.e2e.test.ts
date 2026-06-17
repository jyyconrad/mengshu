/**
 * observe -> 候选区自动抽取链路端到端 smoke 测试。
 *
 * 本文件做什么：
 *   用真实 node:http daemon + in-memory 接线，验证 observe_light 到候选区
 *   pending 候选产出的完整异步链路：
 *     observe_light -> enqueue extract_candidate job -> daemon worker loop drain
 *     -> createExtractCandidateHandler 经 HeuristicTypeExtractor 抽取
 *     -> 写入候选区 pending（不污染主库）-> Console candidates API 可见。
 *
 * 接线全部在测试内组装，全用 in-memory 实现，不依赖外部数据库/网络。
 *
 * 关键边界：
 *   - 正向：rules 类语句产出 1 条 pending 候选，semanticType=rules。
 *   - 安全：敏感个人属性文本被 extractor 源头过滤，候选区保持为空。
 *   - 不污染主库：整个自动链路从不调用 MemoryService.storeMemory。
 *
 * 稳定性说明：
 *   异步链路用轮询 helper（waitFor）等待候选出现/确认空窗，不使用固定 sleep；
 *   worker intervalMs 取小值（20ms）让队列快速 drain，降低 flaky 风险。
 */

import { afterEach, describe, expect, test } from "vitest";
import type { MemoryService } from "../core/service-types.js";
import type { ContextBlock, MemoryRecord, RecallResult } from "../core/types.js";
import { startMemoryServer, type RunningMemoryServer } from "./daemon.js";
import { createConsoleApi } from "../console/api.js";
import { AgentFastPathService } from "../api/agent-fast-path.js";
import { InMemoryMemoryStore } from "../storage/repositories/in-memory.js";
import { InMemoryCandidateRepository } from "../lifecycle/candidate-repository.js";
import { createExtractCandidateHandler } from "../lifecycle/extract-candidate-handler.js";
import { defaultTypeExtractor } from "../lifecycle/type-extractor.js";
import { InMemoryTreeRepository } from "../tree/buffer.js";
import { createBuildTreeHandler } from "../tree/build-tree-handler.js";

const scope = {
  tenantId: "local",
  appId: "openclaw",
  userId: "user-1",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "memories",
};

/**
 * 最小 MemoryService stub。
 *
 * 本测试只验证候选产出，不验证主库召回，因此 recall 返回空、health 返回 0。
 * storeMemory 带计数器（storeCalls），用于断言自动链路从不写主库。
 */
class FakeMemoryService implements MemoryService {
  storeCalls = 0;

  async storeMemory() {
    this.storeCalls += 1;
    return { id: "mem-stub", stored: true };
  }

  async recall(): Promise<RecallResult> {
    return { scope, query: "", hits: [] };
  }

  async buildContext(): Promise<ContextBlock> {
    return { scope, content: "", hits: [], tokenEstimate: 0 };
  }

  async delete() {
    return { deleted: 0 };
  }

  async health() {
    return { ok: true, records: 0 };
  }
}

/**
 * 轮询等待条件成立，避免固定超时导致 flaky。
 *
 * @param check 返回 true 表示满足；满足即返回
 * @param timeoutMs 最长等待
 * @param intervalMs 轮询间隔
 * @returns 是否在超时前满足
 */
async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 2000,
  intervalMs = 15,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return await check();
}

/**
 * 组装完整的 in-memory 接线并启动真实 daemon。
 *
 * 返回 running server、候选仓库、service（含 storeMemory 计数器）。
 */
async function startPipeline(): Promise<{
  running: RunningMemoryServer;
  candidates: InMemoryCandidateRepository;
  service: FakeMemoryService;
  store: InMemoryMemoryStore;
}> {
  const store = new InMemoryMemoryStore();
  const candidates = new InMemoryCandidateRepository();
  const service = new FakeMemoryService();

  const extractCandidateHandler = createExtractCandidateHandler({
    extractor: defaultTypeExtractor,
    candidates,
  });

  // F3：observe 也入队 build_tree，worker 需注册该 handler 才能 drain。
  const treeRepository = new InMemoryTreeRepository();
  const buildTreeHandler = createBuildTreeHandler({ repository: treeRepository });

  const agentFastPath = new AgentFastPathService({
    loadRecordsForScope: async (): Promise<MemoryRecord[]> => [],
    recall: async (recallScope, query) => ({ scope: recallScope, query, hits: [] }),
    // observe_light 内部调用 enqueueJob，这里落到 in-memory jobs 队列。
    enqueueJob: async ({ type, payload }) => {
      const traceId = (payload as { traceId?: string }).traceId ?? String(Math.random());
      const job = await store.jobs.enqueue({
        type,
        payload,
        dedupeKey: `${type}:${traceId}`,
      });
      return job.id;
    },
  });

  const consoleApi = createConsoleApi({ service, candidates });

  const running = await startMemoryServer({
    service,
    console: consoleApi,
    agentFastPath,
    host: "127.0.0.1",
    port: 0,
    worker: {
      jobs: store.jobs,
      leaseMs: 30000,
      // 小 intervalMs 让 worker 快速 drain 队列。
      intervalMs: 20,
      handlers: { extract_candidate: extractCandidateHandler, build_tree: buildTreeHandler },
    },
  });

  return { running, candidates, service, store };
}

/** 发送 observe_light 请求。 */
async function postObserve(url: string, text: string, intent: string): Promise<Response> {
  return fetch(`${url}/v1/agent/observe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope, eventType: "user_input", text, intent }),
  });
}

describe("observe -> 候选区自动抽取链路 e2e", () => {
  let running: RunningMemoryServer | undefined;

  afterEach(async () => {
    await running?.stop();
    running = undefined;
  });

  test("正向：rules 类 observation 异步产出 1 条 pending 候选", async () => {
    const pipeline = await startPipeline();
    running = pipeline.running;

    const observeStartedAt = Date.now();
    const response = await postObserve(
      running.url,
      "禁止在未确认前删除生产数据。",
      "auto",
    );
    expect(response.status).toBe(200);
    const ack = (await response.json()) as { ack: boolean; queuedJobs: string[] };
    expect(ack.ack).toBe(true);
    expect(ack.queuedJobs.length).toBe(2);

    // 轮询等待 worker drain 队列并写入候选。
    const appeared = await waitFor(async () => {
      const pending = await pipeline.candidates.list({ scope, status: "pending" });
      return pending.length > 0;
    });
    const elapsedMs = Date.now() - observeStartedAt;
    expect(appeared).toBe(true);

    const pending = await pipeline.candidates.list({ scope, status: "pending" });
    expect(pending.length).toBe(1);
    expect(pending[0].semanticType).toBe("rules");
    expect(pending[0].status).toBe("pending");
    // 实测异步链路延迟量级，便于排查 flaky；不做硬阈值断言。
    expect(elapsedMs).toBeLessThan(2000);

    // 通过 Console candidates HTTP 端点验证候选可见。
    const consoleResp = await fetch(`${running.url}/v1/console/candidates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope, filter: { status: "pending" } }),
    });
    expect(consoleResp.status).toBe(200);
    const consoleBody = (await consoleResp.json()) as {
      candidates: Array<{ semanticType?: string; status: string }>;
      total: number;
    };
    expect(consoleBody.total).toBe(1);
    expect(consoleBody.candidates[0].semanticType).toBe("rules");
    expect(consoleBody.candidates[0].status).toBe("pending");

    // 不污染主库：自动链路从不调用 storeMemory。
    expect(pipeline.service.storeCalls).toBe(0);
  });

  test("安全边界：敏感个人属性文本被源头过滤，候选区保持为空", async () => {
    const pipeline = await startPipeline();
    running = pipeline.running;

    const response = await postObserve(running.url, "我有抑郁症", "auto");
    expect(response.status).toBe(200);
    const ack = (await response.json()) as { queuedJobs: string[] };
    // job 仍会入队，但 handler 经 extractor 过滤后不产出候选。
    expect(ack.queuedJobs.length).toBe(2);

    // 等待 job 被 worker 处理完（队列出现 completed），再断言候选为空。
    const processed = await waitFor(async () => {
      const completed = await pipeline.store.jobs.list("completed");
      return completed.length >= 1;
    });
    expect(processed).toBe(true);

    const pending = await pipeline.candidates.list({ scope, status: "pending" });
    expect(pending.length).toBe(0);
    const total = await pipeline.candidates.count({ scope });
    expect(total).toBe(0);

    // 敏感内容不入候选也不入主库。
    expect(pipeline.service.storeCalls).toBe(0);
  });

  test("不污染主库：多条 observation 经自动链路从不调用 storeMemory", async () => {
    const pipeline = await startPipeline();
    running = pipeline.running;

    await postObserve(running.url, "禁止在未确认前删除生产数据。", "auto");
    await postObserve(running.url, "我喜欢用 TypeScript 写代码。", "auto");

    // 等待两条候选都落库（rules + profile）。
    const ready = await waitFor(async () => {
      const pending = await pipeline.candidates.list({ scope, status: "pending" });
      return pending.length >= 2;
    });
    expect(ready).toBe(true);

    expect(pipeline.service.storeCalls).toBe(0);
  });
});
