import { describe, expect, test, vi } from "vitest";

import {
  createDurableJobHandlerRegistry,
  createDurableJobV2,
  deriveDurableJobV2DomainDedupeKey,
  leaseDurableJobV2,
  type DurableJobV2,
  type DurableJobV2Scope,
} from "../packages/core/src/storage/repositories/job-v2.js";
import { bufferId } from "../packages/core/src/tree/buffer.js";
import { PostgresTreeFinalizeError } from
  "../packages/core/src/tree/postgres-build-tree-effect.js";
import {
  planTreeFanOut,
  type TreeFanOutInput,
} from "../packages/core/src/tree/tree-fan-out.js";
import { DurableJobV2HandlerFailure } from "./workers-v2.js";
import {
  BUILD_TREE_EFFECT_KEY,
  NativeBuildTreeEffectError,
  createNativeBuildTreeHandler,
  type NativeBuildTreeEffectPort,
  type NativeBuildTreeEffectRequest,
} from "./native-build-tree-handler.js";

const scope: DurableJobV2Scope = {
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "mengshu",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "working-context",
  visibility: "private",
};
const expectedBufferId = bufferId(
  { ...scope, workspaceId: "workspace-a", sessionId: "session-a" },
  "source",
  "session-a",
  0,
);

function runningJob(payloadOverrides: Record<string, unknown> = {}): DurableJobV2 {
  const payload: Record<string, unknown> = {
    scope: { ...scope, workspaceId: "workspace-a", sessionId: "session-a" },
    traceId: "observation-1",
    treeType: "source",
    treeKey: "session-a",
    leaf: {
      id: "observation-1",
      chunkId: "observation-1",
      sourceId: "session-a",
      text: "所有提交必须先完成测试验证。",
      eventAt: 90,
    },
    ...payloadOverrides,
  };
  const identity = typeof payload.targetIdempotencyKey === "string"
    ? payload.targetIdempotencyKey
    : String(payload.traceId);
  const created = createDurableJobV2({
    id: "job-tree-1",
    type: "build_tree",
    payload,
    dedupeKey: deriveDurableJobV2DomainDedupeKey("build_tree", identity, {
      workspaceId: "workspace-a", sessionId: "session-a",
    }),
    scope,
    maxAttempts: 3,
  }, {
    registry: createDurableJobHandlerRegistry(["build_tree"]),
    now: 100,
  });
  return leaseDurableJobV2(created, {
    owner: "worker-a",
    now: 110,
    leaseMs: 1_000,
    tokenFactory: () => "secret-lease-token-that-must-not-escape-123",
  }).job;
}

function runningFinalizeJob(payloadOverrides: Record<string, unknown> = {}): DurableJobV2 {
  const payload: Record<string, unknown> = {
    scope: { ...scope, workspaceId: "workspace-a", sessionId: "session-a" },
    traceId: "history-finalize-source-session-a",
    treeType: "source",
    treeKey: "session-a",
    finalize: {
      mode: "history_rebuild",
      expectedBufferId,
    },
    ...payloadOverrides,
  };
  const created = createDurableJobV2({
    id: "job-tree-finalize-1",
    type: "build_tree",
    payload,
    dedupeKey: deriveDurableJobV2DomainDedupeKey("build_tree", String(payload.traceId), {
      workspaceId: "workspace-a", sessionId: "session-a",
    }),
    scope,
    maxAttempts: 3,
  }, {
    registry: createDurableJobHandlerRegistry(["build_tree"]),
    now: 100,
  });
  return leaseDurableJobV2(created, {
    owner: "worker-a",
    now: 110,
    leaseMs: 1_000,
    tokenFactory: () => "secret-lease-token-that-must-not-escape-123",
  }).job;
}

const routedLeaf = {
  id: "observation-1",
  scope: { ...scope, workspaceId: "workspace-a", sessionId: "session-a" },
  chunkId: "evidence-observation-1",
  sourceId: "session-a",
  entityIds: ["entity-deploy-policy"],
  importance: 0.9,
  eventAt: 90,
  createdAt: 90,
  text: "所有提交必须先完成测试验证。",
  tokenCount: 4,
} as const;

const routedInput: TreeFanOutInput = {
  scope: routedLeaf.scope,
  leaf: { ...routedLeaf, entityIds: [...routedLeaf.entityIds] },
  routing: {
    valueScore: 0.7,
    importance: 0.9,
    semanticType: "rules",
    topicLabels: [" Deploy Rules "],
    topicHotnessEligible: true,
    scopeVisibility: "workspace",
    isWorkspaceRule: true,
    riskFlags: [],
  },
};

function routedJob(treeType: "source" | "topic" | "global"): DurableJobV2 {
  const target = planTreeFanOut(routedInput).targets.find((item) => item.treeType === treeType)!;
  return runningJob({
    treeType: target.treeType,
    treeKey: target.treeKey,
    leaf: {
      id: routedLeaf.id,
      chunkId: routedLeaf.chunkId,
      sourceId: routedLeaf.sourceId,
      entityIds: [...routedLeaf.entityIds],
      text: routedLeaf.text,
      eventAt: routedLeaf.eventAt,
    },
    targetIdempotencyKey: target.idempotencyKey,
    routing: routedInput.routing,
  });
}

function outcome(status: "applied" | "replayed" = "applied") {
  return {
    status,
    receipt: {
      result: {
        leafId: "observation-1",
        sealed: false,
        bufferId: expectedBufferId,
        nodeId: null,
      },
    },
  } as const;
}

function harness(result: unknown = outcome()): {
  port: NativeBuildTreeEffectPort;
  execute: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn(async (
    _request: NativeBuildTreeEffectRequest,
    _signal: AbortSignal,
  ) => await Promise.resolve(result) as Awaited<ReturnType<NativeBuildTreeEffectPort["executeBuildTreeEffect"]>>);
  return { port: Object.freeze({ executeBuildTreeEffect: execute }), execute };
}

describe("native build_tree durable-v2 handler", () => {
  test("history_rebuild finalize 复用 leased build_tree effect 并精确锁定 L0 buffer", async () => {
    const execute = vi.fn(async (request: NativeBuildTreeEffectRequest) => ({
      status: "applied" as const,
      receipt: {
        result: {
          leafId: request.semanticRequest.traceId,
          sealed: true,
          bufferId: null,
          nodeId: "sum_0123456789abcdef01234567",
          foldedNodeIds: [],
        },
      },
    }));
    const handler = createNativeBuildTreeHandler({
      effectPort: Object.freeze({ executeBuildTreeEffect: execute }),
    });

    await expect(handler(runningFinalizeJob(), {
      signal: new AbortController().signal,
      workerId: "worker-a",
    })).resolves.toMatchObject({
      status: "applied",
      sealed: true,
      nodeId: "sum_0123456789abcdef01234567",
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toEqual({
      effectKey: BUILD_TREE_EFFECT_KEY,
      effectInput: {
        id: "job-tree-finalize-1",
        scope,
        owner: "worker-a",
        leaseToken: "secret-lease-token-that-must-not-escape-123",
        leaseGeneration: 1,
      },
      semanticRequest: {
        type: "finalize_tree_buffer",
        version: 1,
        traceId: "history-finalize-source-session-a",
        context: { workspaceId: "workspace-a", sessionId: "session-a" },
        treeType: "source",
        treeKey: "session-a",
        level: 0,
        finalizeMode: "history_rebuild",
        expectedBufferId,
      },
    });
  });

  test.each([
    ["在线 leaf payload 不接受 forceSeal", { forceSeal: true }],
    ["finalize mode 必须固定为 history_rebuild", {
      finalize: { mode: "online", expectedBufferId },
    }],
    ["finalize 必须精确匹配 deterministic buffer id", {
      finalize: { mode: "history_rebuild", expectedBufferId: "buf_wrong" },
    }],
  ])("%s", async (name, overrides) => {
    const effect = harness();
    const base = name.startsWith("在线") ? runningJob() : runningFinalizeJob();
    const malicious = {
      ...base,
      payload: { ...base.payload, ...overrides },
    } as DurableJobV2;
    await expect(createNativeBuildTreeHandler({ effectPort: effect.port })(malicious, {
      signal: new AbortController().signal,
      workerId: "worker-a",
    })).rejects.toEqual(new DurableJobV2HandlerFailure("BUILD_TREE_INVALID_JOB", false));
    expect(effect.execute).not.toHaveBeenCalled();
  });

  test.each([
    ["source", "session-a"],
    ["topic", "deploy-rules"],
    ["global", "1970-01-01"],
  ] as const)(
    "完整 routing snapshot 仅执行 D-03/D-21 plan 中的 %s target，并保留 evidence",
    async (treeType, treeKey) => {
      const target = planTreeFanOut(routedInput).targets.find((item) => item.treeType === treeType)!;
      const expectedTargetBufferId = bufferId(routedInput.scope, treeType, treeKey, 0);
      const execute = vi.fn(async (request: NativeBuildTreeEffectRequest) => ({
        status: "applied" as const,
        receipt: {
          result: {
            leafId: "observation-1",
            sealed: false,
            bufferId: request.semanticRequest.expectedBufferId,
            nodeId: null,
          },
        },
      }));
      const handler = createNativeBuildTreeHandler({
        effectPort: Object.freeze({ executeBuildTreeEffect: execute }),
      });

      await expect(handler(routedJob(treeType), {
        signal: new AbortController().signal,
        workerId: "worker-a",
      })).resolves.toMatchObject({
        status: "applied",
        leafId: "observation-1",
        bufferId: expectedTargetBufferId,
      });

      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0]![0]).toMatchObject({
        semanticRequest: {
          treeType,
          treeKey,
          leaf: {
            chunkId: "evidence-observation-1",
            sourceId: "session-a",
            entityIds: ["entity-deploy-policy"],
            importance: 0.9,
          },
        },
      });
      expect(target.idempotencyKey).toMatch(/^tree-fan-out:[a-f0-9]{64}$/);
    },
  );

  test.each([
    ["D-03 中值 leaf 伪造 topic target", {
      treeType: "topic",
      treeKey: "deploy-rules",
      routing: { ...routedInput.routing, valueScore: 0.69 },
      targetIdempotencyKey: planTreeFanOut(routedInput).targets[1]!.idempotencyKey,
    }],
    ["D-21 伪造 entity id 作为 topic key", {
      treeType: "topic",
      treeKey: "entity-1",
      routing: routedInput.routing,
      targetIdempotencyKey: planTreeFanOut(routedInput).targets[1]!.idempotencyKey,
    }],
    ["伪造 target idempotency key", {
      treeType: "topic",
      treeKey: "deploy-rules",
      routing: routedInput.routing,
      targetIdempotencyKey: "tree-fan-out:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }],
    ["prompt injection evidence 伪造 source target", {
      treeType: "source",
      treeKey: "session-a",
      routing: { ...routedInput.routing, riskFlags: ["prompt_injection"] },
      targetIdempotencyKey: planTreeFanOut(routedInput).targets[0]!.idempotencyKey,
    }],
    ["旧 payload 不得直接写 topic", {
      treeType: "topic",
      treeKey: "deploy-rules",
    }],
    ["routing 与 target key 必须成对出现", {
      routing: routedInput.routing,
    }],
    ["routing snapshot 不接受额外字段", {
      treeType: "topic",
      treeKey: "deploy-rules",
      routing: { ...routedInput.routing, extra: true },
      targetIdempotencyKey: planTreeFanOut(routedInput).targets[1]!.idempotencyKey,
    }],
  ])("%s 在 provider effect 前 fail-closed", async (_name, payloadOverrides) => {
    const effect = harness();
    await expect(createNativeBuildTreeHandler({ effectPort: effect.port })(
      runningJob(payloadOverrides),
      { signal: new AbortController().signal, workerId: "worker-a" },
    )).rejects.toEqual(new DurableJobV2HandlerFailure("BUILD_TREE_INVALID_JOB", false));
    expect(effect.execute).not.toHaveBeenCalled();
  });

  test("history routing 接受显式 global hotness deny 并保持 source/topic target", async () => {
    const historyInput: TreeFanOutInput = {
      ...routedInput,
      routing: { ...routedInput.routing, globalHotnessEligible: false },
    };
    const target = planTreeFanOut(historyInput).targets.find((item) =>
      item.treeType === "topic"
    )!;
    const execute = vi.fn(async (request: NativeBuildTreeEffectRequest) => ({
      status: "applied" as const,
      receipt: {
        result: {
          leafId: routedLeaf.id,
          sealed: false,
          bufferId: request.semanticRequest.expectedBufferId,
          nodeId: null,
        },
      },
    }));
    const handler = createNativeBuildTreeHandler({
      effectPort: Object.freeze({ executeBuildTreeEffect: execute }),
    });
    const job = runningJob({
      treeType: target.treeType,
      treeKey: target.treeKey,
      leaf: {
        id: routedLeaf.id,
        chunkId: routedLeaf.chunkId,
        sourceId: routedLeaf.sourceId,
        entityIds: [...routedLeaf.entityIds],
        text: routedLeaf.text,
        eventAt: routedLeaf.eventAt,
      },
      routing: historyInput.routing,
      targetIdempotencyKey: target.idempotencyKey,
    });

    await expect(handler(job, {
      signal: new AbortController().signal,
      workerId: "worker-a",
    })).resolves.toMatchObject({ status: "applied" });
    expect(execute.mock.calls[0]![0]).toMatchObject({
      semanticRequest: { treeType: "topic", treeKey: "deploy-rules" },
    });
  });

  test("routing snapshot 拒绝 accessor 和 proxy", async () => {
    const target = planTreeFanOut(routedInput).targets[1]!;
    const accessor = { ...routedInput.routing } as Record<string, unknown>;
    Object.defineProperty(accessor, "importance", {
      enumerable: true,
      get: () => 0.9,
    });
    for (const routing of [accessor, new Proxy({ ...routedInput.routing }, {})]) {
      const effect = harness();
      const validJob = routedJob("topic");
      const maliciousJob = {
        ...validJob,
        payload: { ...validJob.payload, routing },
      } as DurableJobV2;
      await expect(createNativeBuildTreeHandler({ effectPort: effect.port })(maliciousJob, {
        signal: new AbortController().signal,
        workerId: "worker-a",
      })).rejects.toEqual(new DurableJobV2HandlerFailure("BUILD_TREE_INVALID_JOB", false));
      expect(effect.execute).not.toHaveBeenCalled();
    }
  });

  test("精确解析 production payload，纯计算稳定 leaf/buffer/policy 后只调用原子 effect port", async () => {
    const effect = harness();
    const handler = createNativeBuildTreeHandler({ effectPort: effect.port });

    const result = await handler(runningJob(), {
      signal: new AbortController().signal,
      workerId: "worker-a",
    });

    expect(result).toEqual({
      status: "applied",
      leafId: "observation-1",
      sealed: false,
      bufferId: expectedBufferId,
      nodeId: null,
      foldedNodeIds: [],
    });
    expect(effect.execute).toHaveBeenCalledTimes(1);
    const [request, signal] = effect.execute.mock.calls[0]!;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(request).toMatchObject({
      effectKey: BUILD_TREE_EFFECT_KEY,
      effectInput: {
        id: "job-tree-1",
        scope,
        owner: "worker-a",
        leaseGeneration: 1,
      },
      semanticRequest: {
        type: "build_tree",
        version: 1,
        traceId: "observation-1",
        context: { workspaceId: "workspace-a", sessionId: "session-a" },
        treeType: "source",
        treeKey: "session-a",
        level: 0,
        policy: { maxLeafCount: 20, maxTokenCount: 6000 },
        leaf: {
          id: "observation-1",
          chunkId: "observation-1",
          sourceId: "session-a",
          entityIds: [],
          importance: 0.5,
          eventAt: 90,
          createdAt: 90,
          text: "所有提交必须先完成测试验证。",
          tokenCount: 4,
        },
      },
    });
    expect(request.semanticRequest.expectedBufferId).toMatch(/^buf_[a-f0-9]{24}$/);
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.semanticRequest.leaf)).toBe(true);
  });

  test("receipt replay 原样返回且 handler 不自行写 repository", async () => {
    const effect = harness(outcome("replayed"));
    const result = await createNativeBuildTreeHandler({ effectPort: effect.port })(runningJob(), {
      signal: new AbortController().signal,
      workerId: "worker-a",
    });

    expect(result).toMatchObject({ status: "replayed", leafId: "observation-1" });
    expect(effect.execute).toHaveBeenCalledTimes(1);
  });

  test("sealed receipt 必须返回 nodeId 且 bufferId=null", async () => {
    const effect = harness({
      status: "applied",
      receipt: { result: {
        leafId: "observation-1",
        sealed: true,
        bufferId: null,
        nodeId: "sum_0123456789abcdef01234567",
      } },
    });

    await expect(createNativeBuildTreeHandler({ effectPort: effect.port })(runningJob(), {
      signal: new AbortController().signal,
      workerId: "worker-a",
    })).resolves.toMatchObject({ sealed: true, nodeId: "sum_0123456789abcdef01234567" });
  });

  test("stale fence 映射固定 retryable failure", async () => {
    const effect = harness({ status: "stale" });
    await expect(createNativeBuildTreeHandler({ effectPort: effect.port })(runningJob(), {
      signal: new AbortController().signal,
      workerId: "worker-a",
    })).rejects.toEqual(new DurableJobV2HandlerFailure("BUILD_TREE_EFFECT_STALE", true));
  });

  test("history finalize pending 映射固定 retryable failure", async () => {
    const effect = harness(Promise.reject(new PostgresTreeFinalizeError()));
    await expect(createNativeBuildTreeHandler({ effectPort: effect.port })(runningFinalizeJob(), {
      signal: new AbortController().signal,
      workerId: "worker-a",
    })).rejects.toEqual(new DurableJobV2HandlerFailure("BUILD_TREE_FINALIZE_PENDING", true));
  });

  test("执行前 abort 保留 AbortError，effect port 零调用", async () => {
    const effect = harness();
    const controller = new AbortController();
    controller.abort(new DOMException("stop", "AbortError"));

    const caught = await createNativeBuildTreeHandler({ effectPort: effect.port })(runningJob(), {
      signal: controller.signal,
      workerId: "worker-a",
    }).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe("AbortError");
    expect(effect.execute).not.toHaveBeenCalled();
  });

  test("effect port 协作 abort 原样传播，不改写为数据库失败", async () => {
    const abort = new DOMException("port aborted", "AbortError");
    const effect = harness(Promise.reject(abort));
    const caught = await createNativeBuildTreeHandler({ effectPort: effect.port })(runningJob(), {
      signal: new AbortController().signal,
      workerId: "worker-a",
    }).catch((error: unknown) => error);
    expect(caught).toBe(abort);
  });

  test("worker/lease 不匹配在 effect 前 fail-closed", async () => {
    const effect = harness();
    await expect(createNativeBuildTreeHandler({ effectPort: effect.port })(runningJob(), {
      signal: new AbortController().signal,
      workerId: "worker-other",
    })).rejects.toEqual(new DurableJobV2HandlerFailure("BUILD_TREE_INVALID_JOB", false));
    expect(effect.execute).not.toHaveBeenCalled();
  });

  test.each([
    ["extra payload field", { extra: true }],
    ["scope mismatch", { scope: { ...scope, projectId: "project-other" } }],
    ["invalid tree type", { treeType: "invalid" }],
    ["unsafe tree key", { treeKey: "bad key" }],
    ["identity mismatch", { leaf: { id: "other", chunkId: "observation-1", sourceId: "session-a", text: "x", eventAt: 90 } }],
    ["invalid event time", { leaf: { id: "observation-1", chunkId: "observation-1", sourceId: "session-a", text: "x", eventAt: -1 } }],
    ["leaf extra field", { leaf: { id: "observation-1", chunkId: "observation-1", sourceId: "session-a", text: "x", eventAt: 90, importance: 1 } }],
  ])("%s 拒绝且不触达 effect", async (_name, payload) => {
    const effect = harness();
    await expect(createNativeBuildTreeHandler({ effectPort: effect.port })(runningJob(payload), {
      signal: new AbortController().signal,
      workerId: "worker-a",
    })).rejects.toEqual(new DurableJobV2HandlerFailure("BUILD_TREE_INVALID_JOB", false));
    expect(effect.execute).not.toHaveBeenCalled();
  });

  test("dedupeKey 必须与 traceId 精确一致", async () => {
    const effect = harness();
    const job = { ...runningJob(), dedupeKey: "build_tree:other" } as DurableJobV2;
    await expect(createNativeBuildTreeHandler({ effectPort: effect.port })(job, {
      signal: new AbortController().signal,
      workerId: "worker-a",
    })).rejects.toEqual(new DurableJobV2HandlerFailure("BUILD_TREE_INVALID_JOB", false));
  });

  test.each([
    ["BUILD_TREE_EFFECT_OUTCOME_UNCERTAIN", true, "BUILD_TREE_EFFECT_RETRYABLE"],
    ["BUILD_TREE_EFFECT_FINGERPRINT_MISMATCH", false, "BUILD_TREE_EFFECT_REJECTED"],
  ] as const)("typed effect error %s 脱敏映射", async (code, retryable, expected) => {
    const secret = "postgres://admin:secret@private-host/internal";
    const effect = harness(Promise.reject(new NativeBuildTreeEffectError(code, secret)));
    const caught = await createNativeBuildTreeHandler({ effectPort: effect.port })(runningJob(), {
      signal: new AbortController().signal,
      workerId: "worker-a",
    }).catch((error: unknown) => error);
    expect(caught).toEqual(new DurableJobV2HandlerFailure(expected, retryable));
    expect(JSON.stringify(caught)).not.toContain(secret);
    expect((caught as Error).message).toBe("Durable job handler failed");
  });

  test("未知 effect 异常固定映射 retryable，不泄漏原始消息", async () => {
    const secret = "password=tree-secret";
    const effect = harness(Promise.reject(new Error(secret)));
    const caught = await createNativeBuildTreeHandler({ effectPort: effect.port })(runningJob(), {
      signal: new AbortController().signal,
      workerId: "worker-a",
    }).catch((error: unknown) => error);
    expect(caught).toEqual(new DurableJobV2HandlerFailure("BUILD_TREE_EFFECT_RETRYABLE", true));
    expect(JSON.stringify(caught)).not.toContain(secret);
  });

  test("effect 已开始后并发 abort 不覆盖 outcome-uncertain retryable 语义", async () => {
    const controller = new AbortController();
    const execute = vi.fn(async () => {
      controller.abort(new DOMException("late abort", "AbortError"));
      throw new NativeBuildTreeEffectError("BUILD_TREE_EFFECT_OUTCOME_UNCERTAIN");
    });
    const handler = createNativeBuildTreeHandler({
      effectPort: Object.freeze({ executeBuildTreeEffect: execute }),
    });

    await expect(handler(runningJob(), {
      signal: controller.signal,
      workerId: "worker-a",
    })).rejects.toEqual(new DurableJobV2HandlerFailure("BUILD_TREE_EFFECT_RETRYABLE", true));
  });

  test.each([
    { status: "applied", receipt: { result: { leafId: "wrong", sealed: false, bufferId: "buf_x", nodeId: null } } },
    { status: "applied", receipt: { result: { leafId: "observation-1", sealed: true, bufferId: "buf_x", nodeId: null } } },
    { status: "applied", receipt: { result: {
      leafId: "observation-1", sealed: false, bufferId: expectedBufferId, nodeId: null,
      foldedNodeIds: ["fold-node:a", "fold-node:a"],
    } } },
    { status: "applied", receipt: { result: {
      leafId: "observation-1", sealed: false, bufferId: expectedBufferId, nodeId: null,
      foldedNodeIds: ["unsafe id"],
    } } },
    { status: "unknown", receipt: { result: {} } },
  ])("malformed effect outcome 非 retryable 拒绝", async (malformed) => {
    const effect = harness(malformed);
    await expect(createNativeBuildTreeHandler({ effectPort: effect.port })(runningJob(), {
      signal: new AbortController().signal,
      workerId: "worker-a",
    })).rejects.toEqual(new DurableJobV2HandlerFailure("BUILD_TREE_EFFECT_REJECTED", false));
  });

  test("工厂拒绝 proxy/accessor/fake-shaped effect port", () => {
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, "executeBuildTreeEffect", { get: () => vi.fn() });
    expect(() => createNativeBuildTreeHandler({ effectPort: accessor as never })).toThrow(/effect port/i);
    expect(() => createNativeBuildTreeHandler({
      effectPort: new Proxy({ executeBuildTreeEffect: vi.fn() }, {}) as never,
    })).toThrow(/effect port/i);
  });
});
