import { describe, expect, test, vi } from "vitest";

import {
  DURABLE_JOB_V2_AUTHORITATIVE_TYPES,
  DURABLE_JOB_V2_SAFE_IDENTIFIER_MAX_LENGTH,
  JobV2ContractError,
  assertDurableJobV2,
  assertDurableJobV2SafeIdentifier,
  completeDurableJobV2,
  createDurableJobHandlerRegistry,
  createDurableJobV2,
  deriveDurableJobV2ScopedDedupeKey,
  failDurableJobV2,
  isDurableJobV2LeaseEligible,
  isDurableJobV2SafeIdentifier,
  leaseDurableJobV2,
  quarantineUnknownDurableJobV2,
  reapExpiredDurableJobV2,
  renewDurableJobLeaseV2,
  type DurableJobV2,
  type DurableJobV2Scope,
} from "./job-v2.js";

const registry = createDurableJobHandlerRegistry([
  "extract_candidate",
  "build_tree",
]);

const canonicalScope: DurableJobV2Scope = {
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "mengshu",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "working-context",
  visibility: "private",
};

function queued(overrides: Partial<DurableJobV2> = {}): DurableJobV2 {
  return createDurableJobV2({
    id: "job-1",
    type: "extract_candidate",
    payload: { candidateId: "candidate-1" },
    dedupeKey: "extract_candidate:candidate-1",
    scope: canonicalScope,
    maxAttempts: 3,
    ...overrides,
  }, { registry, now: 100 });
}

function lease(
  job: DurableJobV2 = queued(),
  overrides: Partial<Parameters<typeof leaseDurableJobV2>[1]> = {},
) {
  return leaseDurableJobV2(job, {
    owner: "worker-a",
    now: 100,
    leaseMs: 100,
    tokenFactory: () => "a".repeat(32),
    ...overrides,
  });
}

function orphanedQueued(): DurableJobV2 {
  const historicalRegistry = createDurableJobHandlerRegistry([
    ...registry.types,
    "legacy_handler",
  ]);
  return createDurableJobV2({
    id: "job-orphan",
    type: "legacy_handler",
    payload: { secretRef: "opaque-reference" },
    dedupeKey: "legacy_handler:1",
    scope: canonicalScope,
    maxAttempts: 3,
  }, { registry: historicalRegistry, now: 100 });
}

describe("durable job v2 enqueue contract", () => {
  test("safe identifier SSOT 按 UTF-16 长度并拒绝 whitespace/Cc/孤立 surrogate", () => {
    expect(DURABLE_JOB_V2_SAFE_IDENTIFIER_MAX_LENGTH).toBe(256);
    for (const value of ["safe-id", "😀".repeat(128)]) {
      expect(isDurableJobV2SafeIdentifier(value), value).toBe(true);
      expect(() => assertDurableJobV2SafeIdentifier(value)).not.toThrow();
    }
    const c1Controls = Array.from({ length: 0x20 }, (_, index) =>
      `id${String.fromCharCode(0x80 + index)}x`);
    for (const value of [
      "",
      "bad id",
      "id\u2003x",
      "id\u007Fx",
      ...c1Controls,
      "id\uD800x",
      "id\uDC00x",
      "😀".repeat(129),
    ]) {
      expect(isDurableJobV2SafeIdentifier(value), JSON.stringify(value)).toBe(false);
      expect(() => assertDurableJobV2SafeIdentifier(value)).toThrow(
        expect.objectContaining({ code: "INVALID_JOB" }),
      );
    }
  });

  test("create/assert/derive 对 C1 与孤立 surrogate identity 统一 fail-closed", () => {
    for (const invalid of ["id\u0085x", "id\u009Fx", "id\uD800x", "id\uDC00x"]) {
      expect(() => createDurableJobV2({
        id: invalid,
        type: "extract_candidate",
        payload: { candidateId: "candidate-1" },
        dedupeKey: "extract_candidate:candidate-1",
        scope: canonicalScope,
        maxAttempts: 3,
      }, { registry, now: 100 }), JSON.stringify(invalid)).toThrow(
        expect.objectContaining({ code: "INVALID_JOB" }),
      );
      expect(() => deriveDurableJobV2ScopedDedupeKey(
        canonicalScope,
        `extract_candidate:${invalid}`,
      ), JSON.stringify(invalid)).toThrow(expect.objectContaining({ code: "INVALID_JOB" }));
      expect(() => createDurableJobV2({
        id: "job-safe",
        type: "extract_candidate",
        payload: { candidateId: "candidate-1" },
        dedupeKey: "extract_candidate:candidate-1",
        scope: { ...canonicalScope, tenantId: invalid },
        maxAttempts: 3,
      }, { registry, now: 100 }), JSON.stringify(invalid)).toThrow(
        expect.objectContaining({ code: "INVALID_JOB" }),
      );
    }
  });

  test("authoritative handler type SSOT 精确冻结三种 native 类型", () => {
    expect(DURABLE_JOB_V2_AUTHORITATIVE_TYPES).toEqual([
      "build_tree",
      "extract_candidate",
      "extract_graph",
    ]);
    expect(Object.isFrozen(DURABLE_JOB_V2_AUTHORITATIVE_TYPES)).toBe(true);
  });

  test("registered handler 才能创建 queued job，且初始状态不带 lease", () => {
    const job = queued();

    expect(job).toEqual({
      id: "job-1",
      type: "extract_candidate",
      payload: { candidateId: "candidate-1" },
      dedupeKey: "extract_candidate:candidate-1",
      scopedDedupeKey: deriveDurableJobV2ScopedDedupeKey(
        canonicalScope,
        "extract_candidate:candidate-1",
      ),
      scope: canonicalScope,
      status: "queued",
      attempts: 0,
      leaseGeneration: 0,
      maxAttempts: 3,
      createdAt: 100,
      updatedAt: 100,
    });
    expect(Object.isFrozen(job)).toBe(true);
    expect(Object.isFrozen(job.payload)).toBe(true);
    expect(Object.isFrozen(job.scope)).toBe(true);
  });

  test("payload 必须是严格 JSON object，且递归冻结独立副本", () => {
    const source = { nested: { items: [1, { enabled: true }] } };
    const job = createDurableJobV2({
      id: "job-json",
      type: "extract_candidate",
      payload: source,
      dedupeKey: "extract_candidate:json",
      scope: canonicalScope,
      maxAttempts: 3,
    }, { registry, now: 100 });

    expect(job.payload).not.toBe(source);
    expect(Object.isFrozen(job.payload)).toBe(true);
    expect(Object.isFrozen(job.payload.nested)).toBe(true);
    expect(Object.isFrozen((job.payload.nested as { items: unknown[] }).items)).toBe(true);
    expect(Object.isFrozen(
      (job.payload.nested as { items: Array<unknown> }).items[1],
    )).toBe(true);

    const invalidPayloads: Array<Record<string, unknown>> = [
      { value: undefined },
      { value: () => undefined },
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY },
      { value: new Date(0) },
      { value: [, 1] },
    ];
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    invalidPayloads.push(cyclic);
    const arrayWithIgnoredProperty = [1] as unknown[] & Record<string, unknown>;
    arrayWithIgnoredProperty["99999999999999999999"] = 2;
    invalidPayloads.push({ value: arrayWithIgnoredProperty });

    for (const payload of invalidPayloads) {
      expect(() => createDurableJobV2({
        id: "job-invalid-json",
        type: "extract_candidate",
        payload,
        dedupeKey: "extract_candidate:invalid-json",
        scope: canonicalScope,
        maxAttempts: 3,
      }, { registry, now: 100 })).toThrow(expect.objectContaining({ code: "INVALID_JOB" }));
    }
  });

  test("未注册 type 在任何 enqueue 状态构造前 fail-closed", () => {
    expect(() => createDurableJobV2({
      id: "",
      type: "unknown_handler",
      payload: {},
      dedupeKey: "unknown:1",
      scope: canonicalScope,
      maxAttempts: 3,
    }, { registry, now: 100 })).toThrow(expect.objectContaining({
      code: "HANDLER_NOT_REGISTERED",
    }));
  });

  test("handler registry 拒绝非法 type，重复注册只保留一份", () => {
    expect(() => createDurableJobHandlerRegistry(["bad type"])).toThrow(
      expect.objectContaining({ code: "INVALID_HANDLER_TYPE" }),
    );
    expect(createDurableJobHandlerRegistry(["build_tree", "build_tree"]).types)
      .toEqual(["build_tree"]);
  });

  test("相同 client dedupe key 在 100 组 tenant/user owner 下生成独立 opaque identity", () => {
    const jobs = Array.from({ length: 100 }, (_, index) => queued({
      scope: {
        ...canonicalScope,
        tenantId: `tenant-${Math.floor(index / 10)}`,
        userId: `user-${index % 10}`,
      },
    }));

    expect(new Set(jobs.map((job) => job.scopedDedupeKey))).toHaveLength(100);
    for (const job of jobs) {
      expect(job.id).toBe("job-1");
      expect(job.dedupeKey).toBe("extract_candidate:candidate-1");
      expect(job.scopedDedupeKey).toMatch(/^[a-f0-9]{64}$/);
      expect(job.scopedDedupeKey).not.toContain(job.scope.tenantId);
      expect(job.scopedDedupeKey).not.toContain(job.scope.userId);
      expect(job.scopedDedupeKey).not.toContain(job.dedupeKey);
    }
    expect(queued({ id: "job-same-scope" }).scopedDedupeKey)
      .toBe(queued().scopedDedupeKey);
  });

  test.each([
    ["tenantId", "tenant-b"],
    ["userId", "user-b"],
    ["appId", "other-app"],
    ["projectId", "project-b"],
    ["agentId", "agent-b"],
    ["namespace", "other-namespace"],
    ["visibility", "team"],
  ] as const)("canonical scope 字段 %s 参与 dedupe 隔离", (field, value) => {
    const baseline = queued();
    const isolated = queued({
      id: `job-scope-${field}`,
      scope: { ...canonicalScope, [field]: value },
    });

    expect(isolated.scopedDedupeKey).not.toBe(baseline.scopedDedupeKey);
  });

  test.each([
    ["tenantId", ""],
    ["userId", " "],
    ["appId", ""],
    ["projectId", "\n"],
    ["agentId", ""],
    ["namespace", ""],
    ["visibility", "owner-only"],
  ] as const)("scope 字段 %s 为空或枚举非法时 fail-closed", (field, value) => {
    expect(() => queued({
      scope: { ...canonicalScope, [field]: value } as DurableJobV2Scope,
    })).toThrow(expect.objectContaining({ code: "INVALID_JOB" }));
  });

  test("enqueue 深复制并冻结 server-resolved scope，来源 mutation 不影响 job", () => {
    const source = { ...canonicalScope };
    const job = queued({ scope: source });

    source.tenantId = "tenant-mutated";
    source.visibility = "public";

    expect(job.scope).toEqual(canonicalScope);
    expect(job.scope).not.toBe(source);
    expect(Object.isFrozen(job.scope)).toBe(true);
  });

  test("canonical scope 拒绝额外字段、accessor 与非 plain object", () => {
    const extra = { ...canonicalScope, workspaceId: "workspace-a" };
    const accessor = { ...canonicalScope } as Record<string, unknown>;
    Object.defineProperty(accessor, "tenantId", {
      enumerable: true,
      get: () => "tenant-a",
    });
    const inherited = Object.assign(Object.create({ inherited: true }), canonicalScope);

    for (const scope of [extra, accessor, inherited]) {
      expect(() => queued({ scope: scope as DurableJobV2Scope }))
        .toThrow(expect.objectContaining({ code: "INVALID_JOB" }));
    }
  });
});

describe("durable job v2 lease eligibility", () => {
  test("queued、到期 retry_wait、过期 running 可 lease；未到期/终态不可 lease", () => {
    const firstLease = lease().job;
    const retryWait = failDurableJobV2(firstLease, {
      owner: "worker-a",
      leaseToken: "a".repeat(32),
      leaseGeneration: 1,
      now: 150,
      failure: { code: "RETRY", retryable: true },
      backoffMs: () => 150,
    }).job;
    const deadLetter = failDurableJobV2(lease(queued({ maxAttempts: 1 })).job, {
      owner: "worker-a",
      leaseToken: "a".repeat(32),
      leaseGeneration: 1,
      now: 150,
      failure: { code: "MAXED", retryable: true },
      backoffMs: () => 100,
    }).job;
    const completed = completeDurableJobV2(firstLease, {
      owner: "worker-a",
      leaseToken: "a".repeat(32),
      leaseGeneration: 1,
      now: 150,
    }).job;

    expect(isDurableJobV2LeaseEligible(queued(), 100)).toBe(true);
    expect(isDurableJobV2LeaseEligible(retryWait, 299)).toBe(false);
    expect(isDurableJobV2LeaseEligible(retryWait, 300)).toBe(true);
    expect(isDurableJobV2LeaseEligible(firstLease, 199)).toBe(false);
    expect(isDurableJobV2LeaseEligible(firstLease, 200)).toBe(true);
    expect(isDurableJobV2LeaseEligible(completed, 150)).toBe(false);
    expect(isDurableJobV2LeaseEligible(deadLetter, 150)).toBe(false);
  });

  test("lease 注入 owner/不可猜 token/heartbeat 并递增 attempts", () => {
    const tokenFactory = vi.fn(() => "opaque-token-abcdefghijklmnopqrstuvwxyz");

    const result = leaseDurableJobV2(queued(), {
      owner: "worker-a",
      now: 120,
      leaseMs: 500,
      tokenFactory,
    });

    expect(result).toMatchObject({
      applied: 1,
      job: {
        status: "running",
        attempts: 1,
        leaseGeneration: 1,
        leaseOwner: "worker-a",
        leaseToken: "opaque-token-abcdefghijklmnopqrstuvwxyz",
        leaseUntil: 620,
        heartbeatAt: 120,
        updatedAt: 120,
      },
    });
    expect(tokenFactory).toHaveBeenCalledTimes(1);
  });

  test("不可 lease 时 applied=0 且不生成 token", () => {
    const running = lease().job;
    const tokenFactory = vi.fn(() => "b".repeat(32));

    const result = leaseDurableJobV2(running, {
      owner: "worker-b",
      now: 199,
      leaseMs: 100,
      tokenFactory,
    });

    expect(result).toEqual({ applied: 0, job: running });
    expect(tokenFactory).not.toHaveBeenCalled();
  });

  test("过期 lease 由新 owner/new token 接管，旧 worker complete/fail 均为 0", () => {
    const first = lease().job;
    const takeover = lease(first, {
      owner: "worker-b",
      now: 200,
      tokenFactory: () => "b".repeat(32),
    }).job;

    expect(takeover).toMatchObject({
      status: "running",
      attempts: 2,
      leaseGeneration: 2,
      leaseOwner: "worker-b",
      leaseToken: "b".repeat(32),
    });
    expect(completeDurableJobV2(takeover, {
      owner: "worker-a",
      leaseToken: "a".repeat(32),
      leaseGeneration: 1,
      now: 201,
    })).toEqual({ applied: 0, job: takeover });
    expect(failDurableJobV2(takeover, {
      owner: "worker-a",
      leaseToken: "a".repeat(32),
      leaseGeneration: 1,
      now: 201,
      failure: { code: "OLD_WORKER", retryable: true, message: "must be ignored" },
      backoffMs: () => 100,
    })).toEqual({ applied: 0, job: takeover });
  });

  test("过期 lease 接管必须使用新 token", () => {
    const first = lease().job;
    expect(() => lease(first, {
      owner: "worker-b",
      now: 200,
      tokenFactory: () => "a".repeat(32),
    })).toThrow(expect.objectContaining({ code: "LEASE_TOKEN_REUSED" }));
  });

  test("retry 后即使 token 发生 ABA，generation fencing 仍拒绝旧 worker", () => {
    const first = lease().job;
    const retryWait = failDurableJobV2(first, {
      owner: "worker-a",
      leaseToken: "a".repeat(32),
      leaseGeneration: 1,
      now: 150,
      failure: { code: "RETRY", retryable: true },
      backoffMs: () => 50,
    }).job;
    const second = lease(retryWait, {
      owner: "worker-a",
      now: 200,
      tokenFactory: () => "a".repeat(32),
    }).job;

    expect(second).toMatchObject({ leaseGeneration: 2, leaseToken: "a".repeat(32) });
    expect(completeDurableJobV2(second, {
      owner: "worker-a",
      leaseToken: "a".repeat(32),
      leaseGeneration: 1,
      now: 201,
    })).toEqual({ applied: 0, job: second });
  });

  test("最终 attempt 的 lease 过期可由显式 reap 原子转入 DLQ", () => {
    const finalAttempt = lease(queued({ maxAttempts: 1 })).job;

    expect(reapExpiredDurableJobV2(finalAttempt, { now: 199 }))
      .toEqual({ applied: 0, job: finalAttempt });
    expect(reapExpiredDurableJobV2(finalAttempt, { now: 200 })).toMatchObject({
      applied: 1,
      job: {
        status: "dead_letter",
        attempts: 1,
        leaseGeneration: 1,
        lastError: { code: "LEASE_EXPIRED", retryable: false },
        updatedAt: 200,
      },
    });
  });
});

describe("durable job v2 authoritative orphan quarantine", () => {
  test("due queued orphan 原子转 DLQ，并保留 identity/scope/payload/dedupe", () => {
    const orphan = orphanedQueued();

    const result = quarantineUnknownDurableJobV2(orphan, {
      authoritativeRegistry: registry,
      now: 150,
    });

    expect(result).toMatchObject({
      applied: 1,
      job: {
        id: orphan.id,
        type: orphan.type,
        payload: orphan.payload,
        scope: orphan.scope,
        dedupeKey: orphan.dedupeKey,
        scopedDedupeKey: orphan.scopedDedupeKey,
        status: "dead_letter",
        attempts: orphan.attempts,
        leaseGeneration: orphan.leaseGeneration,
        lastError: {
          code: "HANDLER_NOT_REGISTERED",
          retryable: false,
          fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        updatedAt: 150,
      },
    });
    expect(result.job).not.toHaveProperty("leaseOwner");
    expect(result.job).not.toHaveProperty("nextAttemptAt");
  });

  test("retry_wait 仅到期后 quarantine；registered/running 均不处理", () => {
    const orphan = orphanedQueued();
    const running = leaseDurableJobV2(orphan, {
      owner: "worker-a",
      now: 100,
      leaseMs: 100,
      tokenFactory: () => "a".repeat(32),
    }).job;
    const retryWait = failDurableJobV2(running, {
      owner: "worker-a",
      leaseToken: "a".repeat(32),
      leaseGeneration: 1,
      now: 150,
      failure: { code: "RETRY", retryable: true },
      backoffMs: () => 100,
    }).job;

    expect(quarantineUnknownDurableJobV2(retryWait, {
      authoritativeRegistry: registry,
      now: 249,
    })).toEqual({ applied: 0, job: retryWait });
    expect(quarantineUnknownDurableJobV2(retryWait, {
      authoritativeRegistry: registry,
      now: 250,
    })).toMatchObject({ applied: 1, job: { status: "dead_letter" } });
    expect(quarantineUnknownDurableJobV2(queued(), {
      authoritativeRegistry: registry,
      now: 150,
    })).toEqual({ applied: 0, job: queued() });
    expect(quarantineUnknownDurableJobV2(running, {
      authoritativeRegistry: registry,
      now: 150,
    })).toEqual({ applied: 0, job: running });
  });

  test("空或非法 authoritative registry fail-closed", () => {
    expect(() => quarantineUnknownDurableJobV2(orphanedQueued(), {
      authoritativeRegistry: createDurableJobHandlerRegistry([]),
      now: 150,
    })).toThrow(expect.objectContaining({ code: "INVALID_JOB" }));
    expect(() => quarantineUnknownDurableJobV2(orphanedQueued(), {
      authoritativeRegistry: { types: ["bad type"], isRegistered: () => false },
      now: 150,
    })).toThrow();
  });
});

describe("durable job v2 fenced transitions", () => {
  test("renew 仅接受当前 owner+token 且未过期 lease", () => {
    const running = lease().job;
    const mismatch = renewDurableJobLeaseV2(running, {
      owner: "worker-b",
      leaseToken: "a".repeat(32),
      leaseGeneration: 1,
      now: 150,
      leaseMs: 200,
    });
    const staleGeneration = renewDurableJobLeaseV2(running, {
      owner: "worker-a",
      leaseToken: "a".repeat(32),
      leaseGeneration: 0,
      now: 150,
      leaseMs: 200,
    });
    const renewed = renewDurableJobLeaseV2(running, {
      owner: "worker-a",
      leaseToken: "a".repeat(32),
      leaseGeneration: 1,
      now: 150,
      leaseMs: 200,
    });

    expect(mismatch).toEqual({ applied: 0, job: running });
    expect(staleGeneration).toEqual({ applied: 0, job: running });
    expect(renewed).toMatchObject({
      applied: 1,
      job: { heartbeatAt: 150, leaseUntil: 350, updatedAt: 150 },
    });
    expect(renewDurableJobLeaseV2(running, {
      owner: "worker-a",
      leaseToken: "a".repeat(32),
      leaseGeneration: 1,
      now: 200,
      leaseMs: 200,
    })).toEqual({ applied: 0, job: running });
  });

  test("complete 仅由当前 lease worker 执行，并清除 lease 字段", () => {
    const running = lease().job;
    const completed = completeDurableJobV2(running, {
      owner: "worker-a",
      leaseToken: "a".repeat(32),
      leaseGeneration: 1,
      now: 150,
    });

    expect(completed).toEqual({
      applied: 1,
      job: {
        ...queued(),
        status: "completed",
        attempts: 1,
        leaseGeneration: 1,
        updatedAt: 150,
      },
    });
  });

  test("retryable failure 按确定性 backoff 进入 retry_wait，且不持久化原始 secret", () => {
    const running = lease().job;
    const backoffMs = vi.fn((attempts: number) => attempts * 1_000);
    const failed = failDurableJobV2(running, {
      owner: "worker-a",
      leaseToken: "a".repeat(32),
      leaseGeneration: 1,
      now: 150,
      failure: {
        code: "PROVIDER_ERROR",
        retryable: true,
        message: "password=secret-do-not-persist",
      },
      backoffMs,
    });

    expect(failed).toMatchObject({
      applied: 1,
      job: {
        status: "retry_wait",
        attempts: 1,
        nextAttemptAt: 1_150,
        lastError: {
          code: "PROVIDER_ERROR",
          retryable: true,
          fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
    });
    expect(backoffMs).toHaveBeenCalledWith(1);
    expect(JSON.stringify(failed)).not.toContain("secret-do-not-persist");
    expect(failed.job).not.toHaveProperty("leaseOwner");
    expect(failed.job).not.toHaveProperty("leaseToken");
  });

  test("达到 maxAttempts 或 non-retryable failure 进入 dead_letter", () => {
    const maxed = lease(queued({ maxAttempts: 1 })).job;
    const nonRetryable = lease().job;

    expect(failDurableJobV2(maxed, {
      owner: "worker-a",
      leaseToken: "a".repeat(32),
      leaseGeneration: 1,
      now: 150,
      failure: { code: "TIMEOUT", retryable: true, message: "timeout" },
      backoffMs: () => 100,
    })).toMatchObject({ applied: 1, job: { status: "dead_letter", attempts: 1 } });
    expect(failDurableJobV2(nonRetryable, {
      owner: "worker-a",
      leaseToken: "a".repeat(32),
      leaseGeneration: 1,
      now: 150,
      failure: { code: "INVALID_PAYLOAD", retryable: false, message: "bad" },
      backoffMs: () => 100,
    })).toMatchObject({ applied: 1, job: { status: "dead_letter", attempts: 1 } });
  });
});

describe("durable job v2 fail-closed validation", () => {
  test("persisted job 缺失或伪造 canonical scope 时所有状态转换 fail-closed", () => {
    const running = lease().job;
    const forged = {
      ...running,
      scope: { ...running.scope, tenantId: "tenant-forged" },
    } as DurableJobV2;
    const missingScopeField = {
      ...running,
      scope: {
        tenantId: running.scope.tenantId,
        userId: running.scope.userId,
      },
    } as unknown as DurableJobV2;
    const transitions = [
      () => isDurableJobV2LeaseEligible(forged, 200),
      () => leaseDurableJobV2(forged, {
        owner: "worker-b", now: 200, leaseMs: 100, tokenFactory: () => "b".repeat(32),
      }),
      () => renewDurableJobLeaseV2(forged, {
        owner: "worker-a", leaseToken: "a".repeat(32), leaseGeneration: 1,
        now: 150, leaseMs: 100,
      }),
      () => completeDurableJobV2(forged, {
        owner: "worker-a", leaseToken: "a".repeat(32), leaseGeneration: 1, now: 150,
      }),
      () => failDurableJobV2(forged, {
        owner: "worker-a", leaseToken: "a".repeat(32), leaseGeneration: 1,
        now: 150, failure: { code: "ERROR", retryable: false }, backoffMs: () => 0,
      }),
      () => reapExpiredDurableJobV2(forged, { now: 200 }),
      () => assertDurableJobV2(missingScopeField),
    ];

    for (const transition of transitions) {
      expect(transition).toThrow(expect.objectContaining({ code: "INVALID_JOB" }));
    }
  });

  test("successful transitions preserve the same canonical scope and scoped identity", () => {
    const original = queued();
    const running = lease(original).job;
    const renewed = renewDurableJobLeaseV2(running, {
      owner: "worker-a", leaseToken: "a".repeat(32), leaseGeneration: 1,
      now: 150, leaseMs: 100,
    }).job;
    const completed = completeDurableJobV2(renewed, {
      owner: "worker-a", leaseToken: "a".repeat(32), leaseGeneration: 1, now: 160,
    }).job;

    for (const job of [running, renewed, completed]) {
      expect(job.scope).toEqual(original.scope);
      expect(Object.isFrozen(job.scope)).toBe(true);
      expect(job.scopedDedupeKey).toBe(original.scopedDedupeKey);
    }
  });

  test("非 running 状态 renew/complete/fail 属于非法转换", () => {
    const job = queued();
    const expected = expect.objectContaining({ code: "INVALID_TRANSITION" });

    expect(() => renewDurableJobLeaseV2(job, {
      owner: "worker-a", leaseToken: "a".repeat(32), leaseGeneration: 0,
      now: 100, leaseMs: 100,
    })).toThrow(expected);
    expect(() => completeDurableJobV2(job, {
      owner: "worker-a", leaseToken: "a".repeat(32), leaseGeneration: 0, now: 100,
    })).toThrow(expected);
    expect(() => failDurableJobV2(job, {
      owner: "worker-a",
      leaseToken: "a".repeat(32),
      leaseGeneration: 0,
      now: 100,
      failure: { code: "ERROR", retryable: true },
      backoffMs: () => 100,
    })).toThrow(expected);
  });

  test("结构非法的 persisted job 在任何状态计算前拒绝", () => {
    const invalid = {
      ...queued(),
      status: "retry_wait",
    } as DurableJobV2;

    expect(() => isDurableJobV2LeaseEligible(invalid, 100)).toThrow(
      expect.objectContaining({ code: "INVALID_JOB" }),
    );
  });

  test("持久化时间、generation 与状态不变量 fail-closed", () => {
    const running = lease().job;
    const retryWait = failDurableJobV2(running, {
      owner: "worker-a",
      leaseToken: "a".repeat(32),
      leaseGeneration: 1,
      now: 150,
      failure: { code: "RETRY", retryable: true },
      backoffMs: () => 100,
    }).job;
    const invalidJobs: DurableJobV2[] = [
      { ...queued(), updatedAt: 99 },
      { ...running, leaseGeneration: 0 },
      { ...running, heartbeatAt: 99 },
      { ...running, leaseUntil: running.heartbeatAt },
      { ...running, leaseUntil: running.updatedAt },
      { ...retryWait, attempts: retryWait.maxAttempts },
      { ...retryWait, nextAttemptAt: 149 },
    ];

    for (const job of invalidJobs) {
      expect(() => assertDurableJobV2(job)).toThrow(
        expect.objectContaining({ code: "INVALID_JOB" }),
      );
    }
    expect(() => renewDurableJobLeaseV2(running, {
      owner: "worker-a",
      leaseToken: "a".repeat(32),
      leaseGeneration: 1,
      now: 99,
      leaseMs: 100,
    })).toThrow(expect.objectContaining({ code: "INVALID_JOB" }));
  });

  test("非法 token/backoff/error code fail-closed", () => {
    expect(() => lease(queued(), { tokenFactory: () => "guessable" })).toThrow(
      expect.objectContaining({ code: "INVALID_LEASE_TOKEN" }),
    );
    const running = lease().job;
    expect(() => failDurableJobV2(running, {
      owner: "worker-a",
      leaseToken: "a".repeat(32),
      leaseGeneration: 1,
      now: 150,
      failure: { code: "password=secret", retryable: true },
      backoffMs: () => -1,
    })).toThrow(JobV2ContractError);
    expect(() => failDurableJobV2(running, {
      owner: "worker-a",
      leaseToken: "a".repeat(32),
      leaseGeneration: 1,
      now: 150,
      failure: { code: "ERROR", retryable: true },
      backoffMs: () => -1,
    })).toThrow(expect.objectContaining({ code: "INVALID_BACKOFF" }));
  });
});
