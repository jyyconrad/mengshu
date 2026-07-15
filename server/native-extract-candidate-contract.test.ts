import { describe, expect, test } from "vitest";

import {
  createDurableJobHandlerRegistry,
  createDurableJobV2,
  deriveDurableJobV2DomainDedupeKey,
  leaseDurableJobV2,
  type DurableJobV2,
  type DurableJobV2Scope,
} from "../packages/core/src/storage/repositories/job-v2.js";
import {
  NATIVE_EXTRACT_CANDIDATE_CONTRACT_VERSION,
  NATIVE_EXTRACT_CANDIDATE_DEDUPE_PREFIX,
  NATIVE_EXTRACT_CANDIDATE_EFFECT_KEY,
  NATIVE_EXTRACT_CANDIDATE_EFFECT_SEMANTICS,
  NATIVE_EXTRACT_CANDIDATE_MAX_TRACE_ID_LENGTH,
  NATIVE_EXTRACT_CANDIDATE_SEMANTIC_TYPE,
  deriveNativeExtractCandidateId,
  parseNativeExtractCandidateJob,
} from "./native-extract-candidate-contract.js";

const scope: DurableJobV2Scope = {
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "mengshu",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "working-context",
  visibility: "private",
};

function job(payloadOverrides: Record<string, unknown> = {}): DurableJobV2 {
  const traceId = typeof payloadOverrides.traceId === "string"
    ? payloadOverrides.traceId
    : "observation-1";
  return createDurableJobV2({
    id: "job-1",
    type: "extract_candidate",
    payload: {
      scope: { ...scope, workspaceId: "workspace-a", sessionId: "session-a" },
      text: "所有提交必须先完成测试验证。",
      traceId,
      intent: "auto",
      ...payloadOverrides,
    },
    dedupeKey: deriveDurableJobV2DomainDedupeKey("extract_candidate", traceId, {
      workspaceId: "workspace-a", sessionId: "session-a",
    }),
    scope,
    maxAttempts: 3,
  }, {
    registry: createDurableJobHandlerRegistry(["extract_candidate"]),
    now: 100,
  });
}

describe("native extract_candidate pure contract", () => {
  test("真实 enqueuer payload 映射为 strict frozen context + semanticRequest", () => {
    const leased = leaseDurableJobV2(job(), {
      owner: "worker-a",
      now: 110,
      leaseMs: 1_000,
      tokenFactory: () => "secret-lease-token-that-must-not-escape-123",
    }).job;
    const result = parseNativeExtractCandidateJob(leased);

    expect(result).toEqual({
      context: { workspaceId: "workspace-a", sessionId: "session-a" },
      semanticRequest: {
        type: "extract_candidate",
        version: 1,
        text: "所有提交必须先完成测试验证。",
        traceId: "observation-1",
        intent: "auto",
      },
    });
    expect(Reflect.ownKeys(result)).toEqual(["context", "semanticRequest"]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.context)).toBe(true);
    expect(Object.isFrozen(result.semanticRequest)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret-lease-token");
  });

  test("intent 缺省为 auto；只接受 auto|remember", () => {
    const base = job();
    const payload = { ...base.payload };
    delete payload.intent;
    const exact = { ...base, payload } as DurableJobV2;
    expect(parseNativeExtractCandidateJob(exact).semanticRequest.intent).toBe("auto");
    expect(parseNativeExtractCandidateJob(job({ intent: "remember" })).semanticRequest.intent)
      .toBe("remember");
    expect(() => parseNativeExtractCandidateJob(job({ intent: "ignore" }))).toThrow(/intent|contract/i);
  });

  test("job type、dedupeKey 与 traceId 必须精确绑定", () => {
    expect(() => parseNativeExtractCandidateJob({ ...job(), type: "extract_graph" }))
      .toThrow(/type|contract/i);
    expect(() => parseNativeExtractCandidateJob({ ...job(), dedupeKey: "extract_candidate:other" }))
      .toThrow(/dedupe|contract/i);
  });

  test("payload/scope 仅接受 exact own-data；Proxy 零 trap", () => {
    let traps = 0;
    const proxy = new Proxy({ ...job().payload }, {
      ownKeys(target) { traps += 1; return Reflect.ownKeys(target); },
      get(target, key, receiver) { traps += 1; return Reflect.get(target, key, receiver); },
    });
    const getter = { ...job().payload };
    Object.defineProperty(getter, "traceId", { enumerable: true, get: () => "swapped" });
    const symbol = { ...job().payload, [Symbol("foreign")]: true };
    const extra = { ...job().payload, llmOutput: "forbidden" };
    class NonPlain { scope = job().payload.scope; text = "safe text"; traceId = "observation-1"; }

    for (const payload of [proxy, getter, symbol, extra, new NonPlain()]) {
      expect(() => parseNativeExtractCandidateJob({ ...job(), payload } as DurableJobV2))
        .toThrow(/payload|contract/i);
    }
    expect(traps).toBe(0);
  });

  test("job 与 nested scope Proxy/extra/getter/symbol/nonplain 同样 fail-closed", () => {
    const base = job();
    let traps = 0;
    const jobProxy = new Proxy(base, {
      ownKeys(target) { traps += 1; return Reflect.ownKeys(target); },
      get(target, key, receiver) { traps += 1; return Reflect.get(target, key, receiver); },
    });
    const scopeProxy = new Proxy({ ...scope }, {
      ownKeys(target) { traps += 1; return Reflect.ownKeys(target); },
      get(target, key, receiver) { traps += 1; return Reflect.get(target, key, receiver); },
    });
    const getter = { ...base };
    Object.defineProperty(getter, "dedupeKey", {
      enumerable: true,
      get: () => "extract_candidate:swapped",
    });
    class NonPlainJob {
      id = base.id;
      type = base.type;
      payload = base.payload;
      scope = base.scope;
      dedupeKey = base.dedupeKey;
      scopedDedupeKey = base.scopedDedupeKey;
      status = base.status;
      attempts = base.attempts;
      leaseGeneration = base.leaseGeneration;
      maxAttempts = base.maxAttempts;
      createdAt = base.createdAt;
      updatedAt = base.updatedAt;
    }
    for (const raw of [
      jobProxy,
      { ...base, payload: { ...base.payload, scope: scopeProxy } },
      getter,
      { ...base, foreign: true },
      { ...base, [Symbol("foreign")]: true },
      new NonPlainJob(),
    ]) {
      expect(() => parseNativeExtractCandidateJob(raw as DurableJobV2))
        .toThrow(/contract|job|scope/i);
    }
    expect(traps).toBe(0);
  });

  test("payload core 7D 必须逐字段等于 job.scope；workspace/session 是 strict context", () => {
    const mismatches: ReadonlyArray<readonly [keyof DurableJobV2Scope, string]> = [
      ["tenantId", "tenant-b"],
      ["userId", "user-b"],
      ["appId", "other-app"],
      ["projectId", "project-b"],
      ["agentId", "agent-b"],
      ["namespace", "other-context"],
      ["visibility", "team"],
    ];
    for (const [field, value] of mismatches) {
      expect(() => parseNativeExtractCandidateJob(job({
        scope: { ...scope, [field]: value },
      })), field).toThrow(/scope|contract/i);
    }
    expect(() => parseNativeExtractCandidateJob(job({
      scope: { ...scope, visibility: "cross-tenant" },
    }))).toThrow(/scope|contract/i);
    for (const context of [
      { workspaceId: "bad workspace" },
      { sessionId: "bad\u0000session" },
      { workspaceId: "workspace-a", foreign: true },
    ]) {
      expect(() => parseNativeExtractCandidateJob(job({ scope: { ...scope, ...context } })))
        .toThrow(/scope|context|contract/i);
    }
  });

  test("text/traceId 使用安全上限，clock/LLM output 不得进入 semantic request", () => {
    const maxText = "x".repeat(100_000);
    expect(parseNativeExtractCandidateJob(job({ text: maxText })).semanticRequest.text)
      .toBe(maxText);
    expect(NATIVE_EXTRACT_CANDIDATE_DEDUPE_PREFIX).toBe("extract_candidate:");
    expect(NATIVE_EXTRACT_CANDIDATE_MAX_TRACE_ID_LENGTH).toBe(256);
    const maxTraceId = "x".repeat(NATIVE_EXTRACT_CANDIDATE_MAX_TRACE_ID_LENGTH);
    const maxTraceJob = job({ traceId: maxTraceId });
    expect(maxTraceJob.dedupeKey).toMatch(/^extract_candidate:[0-9a-f]{64}$/);
    expect(parseNativeExtractCandidateJob(maxTraceJob).semanticRequest.traceId).toBe(maxTraceId);

    const overlongTraceId = "x".repeat(NATIVE_EXTRACT_CANDIDATE_MAX_TRACE_ID_LENGTH + 1);
    const overlongDedupeKey = `${NATIVE_EXTRACT_CANDIDATE_DEDUPE_PREFIX}${overlongTraceId}`;
    const rawOverlongJob = {
      id: "job-overlong-trace",
      type: "extract_candidate",
      payload: { scope, text: "safe text", traceId: overlongTraceId, intent: "auto" },
      scope,
      dedupeKey: overlongDedupeKey,
      scopedDedupeKey: "0".repeat(64),
      status: "queued",
      attempts: 0,
      leaseGeneration: 0,
      maxAttempts: 3,
      createdAt: 100,
      updatedAt: 100,
    } as DurableJobV2;
    expect(() => parseNativeExtractCandidateJob(rawOverlongJob)).toThrow(/payload|contract/i);
    expect(() => createDurableJobV2({
      id: "job-overlong-trace",
      type: "extract_candidate",
      payload: rawOverlongJob.payload,
      dedupeKey: overlongDedupeKey,
      scope,
      maxAttempts: 3,
    }, {
      registry: createDurableJobHandlerRegistry(["extract_candidate"]),
      now: 100,
    })).toThrow(/dedupe|job/i);

    for (const overrides of [
      { text: " " },
      { text: "x".repeat(100_001) },
      { text: "bad\u0000text" },
      { traceId: "bad trace" },
      { traceId: "x".repeat(NATIVE_EXTRACT_CANDIDATE_MAX_TRACE_ID_LENGTH + 1) },
      { clock: 123 },
      { llmOutput: { candidates: [] } },
    ]) {
      const base = job();
      const traceId = typeof overrides.traceId === "string"
        ? overrides.traceId
        : String(base.payload.traceId);
      const raw = {
        ...base,
        payload: { ...base.payload, ...overrides },
        dedupeKey: `extract_candidate:${traceId}`,
      } as DurableJobV2;
      expect(() => parseNativeExtractCandidateJob(raw)).toThrow(/contract|payload|text|trace/i);
    }
  });

  test("job.id 按 UTF-16 code unit 与真实 durable job 的 256 上限一致", () => {
    const acceptedId = "😀".repeat(128);
    const accepted = createDurableJobV2({
      id: acceptedId,
      type: "extract_candidate",
      payload: job().payload,
      dedupeKey: job().dedupeKey,
      scope,
      maxAttempts: 3,
    }, {
      registry: createDurableJobHandlerRegistry(["extract_candidate"]),
      now: 100,
    });
    expect(acceptedId).toHaveLength(256);
    expect(parseNativeExtractCandidateJob(accepted).semanticRequest.traceId)
      .toBe("observation-1");
    expect(deriveNativeExtractCandidateId(acceptedId, 0)).toMatch(/^candidate_[a-f0-9]{64}$/);

    const rejectedId = "😀".repeat(129);
    expect(rejectedId).toHaveLength(258);
    expect(() => createDurableJobV2({
      id: rejectedId,
      type: "extract_candidate",
      payload: job().payload,
      dedupeKey: job().dedupeKey,
      scope,
      maxAttempts: 3,
    }, {
      registry: createDurableJobHandlerRegistry(["extract_candidate"]),
      now: 100,
    })).toThrow(/job|contract/i);
    expect(() => parseNativeExtractCandidateJob({ ...job(), id: rejectedId }))
      .toThrow(/job|contract/i);
    expect(() => deriveNativeExtractCandidateId(rejectedId, 0))
      .toThrow(/candidate|contract/i);
  });

  test("C1 与孤立 surrogate 被真实 create、parser、candidate derive 一致拒绝", () => {
    for (const invalidId of ["id\u0085x", "id\u009Fx", "id\uD800x", "id\uDC00x"]) {
      expect(() => createDurableJobV2({
        id: invalidId,
        type: "extract_candidate",
        payload: job().payload,
        dedupeKey: job().dedupeKey,
        scope,
        maxAttempts: 3,
      }, {
        registry: createDurableJobHandlerRegistry(["extract_candidate"]),
        now: 100,
      }), JSON.stringify(invalidId)).toThrow(/job|contract/i);
      expect(() => parseNativeExtractCandidateJob({ ...job(), id: invalidId }),
        JSON.stringify(invalidId)).toThrow(/job|contract/i);
      expect(() => deriveNativeExtractCandidateId(invalidId, 0),
        JSON.stringify(invalidId)).toThrow(/candidate|contract/i);
    }
  });

  test.each([
    "tenantId", "userId", "appId", "projectId", "agentId", "namespace",
  ] as const)("scope.%s 对 C1 与孤立 surrogate 在 create/parser 一致拒绝", (field) => {
    for (const invalidValue of ["id\u0085x", "id\u009Fx", "id\uD800x", "id\uDC00x"]) {
      const invalidScope = { ...scope, [field]: invalidValue };
      const invalidPayload = {
        ...job().payload,
        scope: { ...invalidScope, workspaceId: "workspace-a", sessionId: "session-a" },
      };
      expect(() => createDurableJobV2({
        id: `job-${field}`,
        type: "extract_candidate",
        payload: invalidPayload,
        dedupeKey: job().dedupeKey,
        scope: invalidScope,
        maxAttempts: 3,
      }, {
        registry: createDurableJobHandlerRegistry(["extract_candidate"]),
        now: 100,
      }), JSON.stringify(invalidValue)).toThrow(/job|contract/i);
      expect(() => parseNativeExtractCandidateJob({
        ...job(),
        scope: invalidScope,
        payload: invalidPayload,
      } as DurableJobV2), JSON.stringify(invalidValue)).toThrow(/scope|contract/i);
    }
  });

  test.each([
    "tenantId", "userId", "appId", "projectId", "agentId", "namespace",
  ] as const)("scope.%s 按 UTF-16 code unit 与真实 durable job 的 256 上限一致", (field) => {
    const acceptedValue = "😀".repeat(128);
    const acceptedScope = { ...scope, [field]: acceptedValue };
    const accepted = createDurableJobV2({
      id: `job-${field}`,
      type: "extract_candidate",
      payload: {
        ...job().payload,
        scope: { ...acceptedScope, workspaceId: "workspace-a", sessionId: "session-a" },
      },
      dedupeKey: job().dedupeKey,
      scope: acceptedScope,
      maxAttempts: 3,
    }, {
      registry: createDurableJobHandlerRegistry(["extract_candidate"]),
      now: 100,
    });
    expect(acceptedValue).toHaveLength(256);
    expect(parseNativeExtractCandidateJob(accepted).semanticRequest.traceId)
      .toBe("observation-1");

    const rejectedValue = "😀".repeat(129);
    const rejectedScope = { ...scope, [field]: rejectedValue };
    const rejectedPayload = {
      ...job().payload,
      scope: { ...rejectedScope, workspaceId: "workspace-a", sessionId: "session-a" },
    };
    expect(() => createDurableJobV2({
      id: `job-${field}`,
      type: "extract_candidate",
      payload: rejectedPayload,
      dedupeKey: job().dedupeKey,
      scope: rejectedScope,
      maxAttempts: 3,
    }, {
      registry: createDurableJobHandlerRegistry(["extract_candidate"]),
      now: 100,
    })).toThrow(/job|contract/i);
    expect(() => parseNativeExtractCandidateJob({
      ...job(),
      scope: rejectedScope,
      payload: rejectedPayload,
    } as DurableJobV2)).toThrow(/scope|contract/i);
  });

  test("candidateId 仅由 job.id + index 确定，常量稳定且输入非法 fail-closed", () => {
    expect(NATIVE_EXTRACT_CANDIDATE_CONTRACT_VERSION).toBe(1);
    expect(NATIVE_EXTRACT_CANDIDATE_EFFECT_KEY).toBe("extract_candidate.persist.v1");
    expect(NATIVE_EXTRACT_CANDIDATE_SEMANTIC_TYPE).toBe("extract_candidate");
    expect(NATIVE_EXTRACT_CANDIDATE_EFFECT_SEMANTICS).toEqual({
      effectKey: "extract_candidate.persist.v1",
      semanticType: "extract_candidate",
      contractVersion: 1,
    });
    expect(Object.isFrozen(NATIVE_EXTRACT_CANDIDATE_EFFECT_SEMANTICS)).toBe(true);
    const first = deriveNativeExtractCandidateId("job-1", 0);
    expect(first).toBe(deriveNativeExtractCandidateId("job-1", 0));
    expect(first).not.toBe(deriveNativeExtractCandidateId("job-1", 1));
    expect(first).not.toBe(deriveNativeExtractCandidateId("job-2", 0));
    expect(first).toMatch(/^candidate_[a-f0-9]{64}$/);
    expect(() => deriveNativeExtractCandidateId("bad job", 0)).toThrow(/candidate|contract/i);
    for (const index of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => deriveNativeExtractCandidateId("job-1", index), String(index))
        .toThrow(/candidate|contract/i);
    }
  });
});
