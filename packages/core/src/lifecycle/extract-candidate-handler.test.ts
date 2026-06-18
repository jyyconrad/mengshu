/**
 * extract-candidate-handler.ts 单元测试。
 *
 * 验证 extract_candidate job handler 把 observation 文本经 extractor 抽取后
 * 按 valueScore 准入策略写入候选区（pending），并保证：
 * 1. 抽到的候选默认进 candidate（pending），不直配主库（自动抽取不污染主库）。
 * 2. 准入决策 route=drop 的不入候选。
 * 3. 敏感文本（extractor 返回 []）不产生候选。
 * 4. payload 缺失 text/scope 时安全返回，不抛未捕获异常。
 * 5. 同 scope 同文本的重复 observation 不产生重复 pending 候选。
 */

import { describe, expect, test } from "vitest";
import { createExtractCandidateHandler } from "./extract-candidate-handler.js";
import { InMemoryCandidateRepository } from "./candidate-repository.js";
import { HeuristicTypeExtractor } from "./type-extractor.js";
import type { JobRecord } from "../storage/repositories/types.js";
import type {
  LlmClient,
  LlmCompletionMessage,
  LlmCompletionOptions,
  SimpleJsonSchema,
} from "../runtime/llm/llm-client.js";

const scope = {
  tenantId: "local",
  appId: "openclaw",
  userId: "u1",
  projectId: "p1",
  agentId: "default",
  namespace: "memories",
};

function job(payload: Record<string, unknown>): JobRecord {
  return {
    id: "job-1",
    type: "extract_candidate",
    payload,
    dedupeKey: "extract_candidate:job-1",
    status: "running",
    attempts: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("createExtractCandidateHandler", () => {
  test("rules 类文本抽取后进入候选区 pending", async () => {
    const candidates = new InMemoryCandidateRepository();
    const handler = createExtractCandidateHandler({
      extractor: new HeuristicTypeExtractor(),
      candidates,
    });

    await handler(job({ scope, text: "禁止在未确认前删除生产数据。", intent: "auto" }));

    const pending = await candidates.list({ scope, status: "pending" });
    expect(pending.length).toBeGreaterThanOrEqual(1);
    expect(pending[0].semanticType).toBe("rules");
    expect(pending[0].status).toBe("pending");
  });

  test("敏感文本不产生候选（extractor 源头过滤）", async () => {
    const candidates = new InMemoryCandidateRepository();
    const handler = createExtractCandidateHandler({
      extractor: new HeuristicTypeExtractor(),
      candidates,
    });

    await handler(job({ scope, text: "我有抑郁症，正在服用药物。", intent: "auto" }));

    const pending = await candidates.list({ scope, status: "pending" });
    expect(pending).toHaveLength(0);
  });

  test("无法抽取语义的普通文本不产生候选", async () => {
    const candidates = new InMemoryCandidateRepository();
    const handler = createExtractCandidateHandler({
      extractor: new HeuristicTypeExtractor(),
      candidates,
    });

    await handler(job({ scope, text: "今天天气不错。", intent: "auto" }));

    const pending = await candidates.list({ scope, status: "pending" });
    expect(pending).toHaveLength(0);
  });

  test("payload 缺 text 时安全返回不抛异常", async () => {
    const candidates = new InMemoryCandidateRepository();
    const handler = createExtractCandidateHandler({
      extractor: new HeuristicTypeExtractor(),
      candidates,
    });

    await expect(handler(job({ scope, intent: "auto" }))).resolves.not.toThrow();
    expect(await candidates.count({ scope })).toBe(0);
  });

  test("同 scope 同文本重复 observation 不产生重复 pending 候选", async () => {
    const candidates = new InMemoryCandidateRepository();
    const handler = createExtractCandidateHandler({
      extractor: new HeuristicTypeExtractor(),
      candidates,
    });

    const text = "禁止在未确认前删除生产数据。";
    await handler(job({ scope, text, intent: "auto" }));
    await handler(job({ scope, text, intent: "auto" }));

    const pending = await candidates.list({ scope, status: "pending" });
    expect(pending).toHaveLength(1);
  });

  test("写入候选时记录 audit（注入时）", async () => {
    const candidates = new InMemoryCandidateRepository();
    const audited: string[] = [];
    const handler = createExtractCandidateHandler({
      extractor: new HeuristicTypeExtractor(),
      candidates,
      audit: async ({ action }) => {
        audited.push(action);
      },
    });

    await handler(job({ scope, text: "禁止在未确认前删除生产数据。", intent: "auto" }));
    expect(audited).toContain("candidate.extract");
  });
});

/**
 * Fake LlmClient 基类：默认 available，complete/summarize 不被本测试用到。
 * 子类只需覆写 extractStructured 模拟不同返回 / 抛错场景。
 */
class FakeLlmClient implements LlmClient {
  readonly available: boolean;

  constructor(available = true) {
    this.available = available;
  }

  async complete(_m: LlmCompletionMessage[], _o?: LlmCompletionOptions): Promise<string> {
    throw new Error("not used in test");
  }

  async summarize(_t: string, _i: string): Promise<string> {
    throw new Error("not used in test");
  }

  async extractStructured<T>(
    _messages: LlmCompletionMessage[],
    _schema: SimpleJsonSchema,
    _options?: LlmCompletionOptions,
  ): Promise<T> {
    throw new Error("not implemented");
  }
}

/** 返回固定候选结果的 fake（候选 quote 取自源文本，eventIds 对齐 traceId）。 */
class StubLlmClient extends FakeLlmClient {
  constructor(private readonly payload: unknown) {
    super(true);
  }

  async extractStructured<T>(): Promise<T> {
    return this.payload as T;
  }
}

/** extractStructured 抛错的 fake（模拟超时 / schema 失败 / 网络不可用）。 */
class ThrowingLlmClient extends FakeLlmClient {
  async extractStructured<T>(): Promise<T> {
    throw new Error("simulated LLM failure");
  }
}

describe("inferSourceScope 推断逻辑（P1-Q3 修复）", () => {
  test("有 sessionId → session（最窄）", async () => {
    const candidates = new InMemoryCandidateRepository();
    const text = "用户偏好使用 TypeScript 严格模式。";
    const sessionScope = {
      ...scope,
      sessionId: "sess-123",
      workspaceId: "ws-1",
      projectId: "p1",
    };
    // LLM 返回 targetScope=workspace，但 sourceScope=session 应收窄到 session
    const llmClient = new StubLlmClient({
      candidates: [
        {
          text,
          semanticType: "profile",
          profileDimension: "language",
          targetScope: "workspace",
          evidence: { eventIds: ["trace-1"], quote: "TypeScript 严格模式" },
          salience: 0.8,
          temporality: "durable",
        },
      ],
    });

    const handler = createExtractCandidateHandler({
      extractor: new HeuristicTypeExtractor(),
      candidates,
      llmClient,
    });

    await handler(job({ scope: sessionScope, text, traceId: "trace-1", intent: "auto" }));
    const pending = await candidates.list({ scope: sessionScope, status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0].metadata.targetScope).toBe("session");
  });

  test("有 projectId（无 sessionId）→ project", async () => {
    const candidates = new InMemoryCandidateRepository();
    const text = "禁止在未确认前删除生产数据。";
    const projectScope = { ...scope, sessionId: undefined, projectId: "p1" };
    const llmClient = new StubLlmClient({
      candidates: [
        {
          text,
          semanticType: "rules",
          targetScope: "user",
          evidence: { eventIds: ["trace-2"], quote: "禁止在未确认前删除生产数据" },
          salience: 0.9,
          temporality: "durable",
        },
      ],
    });

    const handler = createExtractCandidateHandler({
      extractor: new HeuristicTypeExtractor(),
      candidates,
      llmClient,
    });

    await handler(job({ scope: projectScope, text, traceId: "trace-2", intent: "auto" }));
    const pending = await candidates.list({ scope: projectScope, status: "pending" });
    expect(pending).toHaveLength(1);
    // targetScope=user 宽于 sourceScope=project，应收窄到 project
    expect(pending[0].metadata.targetScope).toBe("project");
  });

  test("有 workspaceId（无 projectId/sessionId）→ workspace", async () => {
    const candidates = new InMemoryCandidateRepository();
    const text = "团队统一使用 Prettier 格式化代码。";
    const workspaceScope = {
      ...scope,
      sessionId: undefined,
      projectId: "",
      workspaceId: "ws-1",
    };
    const llmClient = new StubLlmClient({
      candidates: [
        {
          text,
          semanticType: "rules",
          targetScope: "global",
          evidence: { eventIds: ["trace-3"], quote: "Prettier 格式化代码" },
          salience: 0.7,
          temporality: "durable",
        },
      ],
    });

    const handler = createExtractCandidateHandler({
      extractor: new HeuristicTypeExtractor(),
      candidates,
      llmClient,
    });

    await handler(job({ scope: workspaceScope, text, traceId: "trace-3", intent: "auto" }));
    const pending = await candidates.list({ scope: workspaceScope, status: "pending" });
    expect(pending).toHaveLength(1);
    // targetScope=global 宽于 sourceScope=workspace，应收窄到 workspace
    expect(pending[0].metadata.targetScope).toBe("workspace");
  });
});

describe("createExtractCandidateHandler - LLM 异步路径（§0.8 / §2.3 / §10.4）", () => {
  const traceId = "trace-1";

  test("P1-Q3：sessionId 存在时 sourceScope 推断为 session", async () => {
    const candidates = new InMemoryCandidateRepository();
    const text = "禁止在未确认前删除生产数据。";
    const sessionScope = { ...scope, sessionId: "sess-123" };
    // LLM 返回 targetScope=global，但 sourceScope=session 时闸门 11 应收窄到 session
    const llmClient = new StubLlmClient({
      candidates: [
        {
          text,
          semanticType: "rules",
          kind: "constraint",
          targetScope: "global",
          evidence: { eventIds: [traceId], quote: "禁止在未确认前删除生产数据" },
          salience: 0.9,
          temporality: "durable",
          crossContextual: true,
          reason: "硬约束",
        },
      ],
    });

    const handler = createExtractCandidateHandler({
      extractor: new HeuristicTypeExtractor(),
      candidates,
      llmClient,
    });

    await handler(job({ scope: sessionScope, text, traceId, intent: "auto" }));
    const pending = await candidates.list({ scope: sessionScope, status: "pending" });
    expect(pending).toHaveLength(1);
    // 验证闸门 11：targetScope 被收窄到 session（不是 global）
    expect(pending[0].metadata.targetScope).toBe("session");
  });

  test("P1-Q3：traceId 正确传递给 validator 作为 eventId", async () => {
    const candidates = new InMemoryCandidateRepository();
    const text = "禁止在未确认前删除生产数据。";
    const customTraceId = "trace-custom-456";
    // LLM 返回的 eventIds 必须与 traceId 对齐，否则闸门 2 拒绝
    const llmClient = new StubLlmClient({
      candidates: [
        {
          text,
          semanticType: "rules",
          kind: "constraint",
          targetScope: "project",
          evidence: { eventIds: [customTraceId], quote: "禁止在未确认前删除生产数据" },
          salience: 0.9,
          temporality: "durable",
        },
      ],
    });

    const handler = createExtractCandidateHandler({
      extractor: new HeuristicTypeExtractor(),
      candidates,
      llmClient,
    });

    const result = (await handler(job({ scope, text, traceId: customTraceId, intent: "auto" }))) as { created: number };
    expect(result.created).toBe(1);
    const pending = await candidates.list({ scope, status: "pending" });
    expect(pending[0].evidenceIds).toContain(customTraceId);
  });

  test("P1-Q3：无 traceId 时使用 unknown-event 兜底", async () => {
    const candidates = new InMemoryCandidateRepository();
    const text = "禁止在未确认前删除生产数据。";
    const llmClient = new StubLlmClient({
      candidates: [
        {
          text,
          semanticType: "rules",
          kind: "constraint",
          targetScope: "project",
          // eventIds 对齐 unknown-event（handler 的兜底 eventId）
          evidence: { eventIds: ["unknown-event"], quote: "禁止在未确认前删除生产数据" },
          salience: 0.9,
          temporality: "durable",
        },
      ],
    });

    const handler = createExtractCandidateHandler({
      extractor: new HeuristicTypeExtractor(),
      candidates,
      llmClient,
    });

    // 不传 traceId
    const result = (await handler(job({ scope, text, intent: "auto" }))) as { created: number };
    expect(result.created).toBe(1);
  });

  test("llmClient.available 时走 LLM 路径，候选过 validator 后入库", async () => {
    const candidates = new InMemoryCandidateRepository();
    // quote 必须是源文本子串（validator 闸门 2）；eventIds 对齐 handler 传入的 eventId(=traceId)。
    const text = "禁止在未确认前删除生产数据，必须先经过审批流程确认。";
    const llmClient = new StubLlmClient({
      candidates: [
        {
          text,
          semanticType: "rules",
          kind: "constraint",
          targetScope: "project",
          evidence: { eventIds: [traceId], quote: "禁止在未确认前删除生产数据" },
          salience: 0.9,
          temporality: "durable",
          crossContextual: true,
          reason: "硬约束",
        },
      ],
    });

    const handler = createExtractCandidateHandler({
      extractor: new HeuristicTypeExtractor(),
      candidates,
      llmClient,
    });

    const result = (await handler(job({ scope, text, traceId, intent: "auto" }))) as { created: number };
    expect(result.created).toBe(1);

    const pending = await candidates.list({ scope, status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0].semanticType).toBe("rules");
    expect(pending[0].extractor).toBe("llm");
    // P1-Q4：metadata.admission 记录实际 AdmissionRoute 路由值（不再是静态字符串）。
    // 此处文本为纯中文，闸门 9（泛词过滤）会标 evidenceOnly=true，admission 决策返回 evidence_only。
    expect(pending[0].metadata.admission).toBe("evidence_only");
    expect(pending[0].metadata.admissionReason).toBeDefined();
  });

  test("LLM 抛错时 fallback 到 heuristic 路径（链路不断）", async () => {
    const candidates = new InMemoryCandidateRepository();
    const handler = createExtractCandidateHandler({
      extractor: new HeuristicTypeExtractor(),
      candidates,
      llmClient: new ThrowingLlmClient(),
    });

    const text = "禁止在未确认前删除生产数据。";
    const result = (await handler(job({ scope, text, traceId, intent: "auto" }))) as { created: number };

    // fallback heuristic 命中 rules，正常入库。
    expect(result.created).toBeGreaterThanOrEqual(1);
    const pending = await candidates.list({ scope, status: "pending" });
    expect(pending.length).toBeGreaterThanOrEqual(1);
    expect(pending[0].extractor).toBe("heuristic");
  });

  test("validator 拒绝的 LLM 候选不入库（quote 不在源文本 + 低 salience）", async () => {
    const candidates = new InMemoryCandidateRepository();
    const text = "禁止在未确认前删除生产数据。";
    const llmClient = new StubLlmClient({
      candidates: [
        {
          // quote 不在源文本 → 闸门 2 拒绝。
          text: "用户偏好使用 TypeScript 严格模式开发项目。",
          semanticType: "profile",
          profileDimension: "language",
          targetScope: "project",
          evidence: { eventIds: [traceId], quote: "完全不存在于源文本的引用内容" },
          salience: 0.8,
          temporality: "durable",
        },
        {
          // salience 低于 MIN_SALIENCE(0.3) → 闸门 4 拒绝。
          text: text + " 这是补充说明信息内容。",
          semanticType: "rules",
          targetScope: "project",
          evidence: { eventIds: [traceId], quote: "禁止在未确认前删除生产数据" },
          salience: 0.1,
          temporality: "durable",
        },
      ],
    });

    const handler = createExtractCandidateHandler({
      extractor: new HeuristicTypeExtractor(),
      candidates,
      llmClient,
    });

    const result = (await handler(job({ scope, text, traceId, intent: "auto" }))) as { created: number };
    expect(result.created).toBe(0);
    expect(await candidates.count({ scope })).toBe(0);
  });

  test("LLM 成功但零候选时不 fallback heuristic（视为无可记内容）", async () => {
    const candidates = new InMemoryCandidateRepository();
    const llmClient = new StubLlmClient({ candidates: [] });

    const handler = createExtractCandidateHandler({
      extractor: new HeuristicTypeExtractor(),
      candidates,
      llmClient,
    });

    // 该文本 heuristic 会命中 rules；若错误 fallback 则会产生候选。
    const result = (await handler(job({ scope, text: "禁止在未确认前删除生产数据。", traceId, intent: "auto" }))) as { created: number };
    expect(result.created).toBe(0);
    expect(await candidates.count({ scope })).toBe(0);
  });

  test("llmClient 不可用（available=false）时走纯 heuristic（向后兼容）", async () => {
    const candidates = new InMemoryCandidateRepository();
    const handler = createExtractCandidateHandler({
      extractor: new HeuristicTypeExtractor(),
      candidates,
      llmClient: new FakeLlmClient(false),
    });

    const result = (await handler(job({ scope, text: "禁止在未确认前删除生产数据。", intent: "auto" }))) as { created: number };
    expect(result.created).toBeGreaterThanOrEqual(1);
    const pending = await candidates.list({ scope, status: "pending" });
    expect(pending[0].extractor).toBe("heuristic");
  });
});
