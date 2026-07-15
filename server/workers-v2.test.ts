import { describe, expect, test, vi } from "vitest";

import {
  completeDurableJobV2,
  createDurableJobHandlerRegistry,
  createDurableJobV2,
  deriveDurableJobV2ScopedDedupeKey,
  failDurableJobV2,
  leaseDurableJobV2,
  renewDurableJobLeaseV2,
  type DurableJobV2,
  type DurableJobV2Scope,
} from "../packages/core/src/storage/repositories/job-v2.js";
import {
  DurableJobV2HandlerFailure,
  createAuthoritativeDurableJobV2WorkerHandlerRegistry,
  runNextDurableJobV2,
  startDurableJobV2WorkerLoop,
  type DurableJobV2RepositoryPort,
  type DurableJobV2Scheduler,
} from "./workers-v2.js";

const scope: DurableJobV2Scope = {
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "mengshu",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "working-context",
  visibility: "private",
};

function runningJob(type = "work", maxAttempts = 3): DurableJobV2 {
  const registry = createDurableJobHandlerRegistry([type]);
  const queued = createDurableJobV2({
    id: `job-${type}`,
    type,
    payload: { value: 1 },
    dedupeKey: `${type}:1`,
    scope,
    maxAttempts,
  }, { registry, now: 100 });
  return leaseDurableJobV2(queued, {
    owner: "worker-a",
    now: 100,
    leaseMs: 1_000,
    tokenFactory: () => "a".repeat(32),
  }).job;
}

function completed(job: DurableJobV2, now = 150): DurableJobV2 {
  return completeDurableJobV2(job, {
    owner: "worker-a",
    leaseToken: "a".repeat(32),
    leaseGeneration: 1,
    now,
  }).job;
}

function failed(
  job: DurableJobV2,
  retryable: boolean,
  code = retryable ? "HANDLER_ERROR" : "PERMANENT_ERROR",
): DurableJobV2 {
  return failDurableJobV2(job, {
    owner: "worker-a",
    leaseToken: "a".repeat(32),
    leaseGeneration: 1,
    now: 150,
    failure: { code, retryable },
    backoffMs: () => 100,
  }).job;
}

function renewed(job: DurableJobV2, now: number): DurableJobV2 {
  return renewDurableJobLeaseV2(job, {
    owner: "worker-a",
    leaseToken: "a".repeat(32),
    leaseGeneration: 1,
    now,
    leaseMs: 1_000,
  }).job;
}

class FakeRepository implements DurableJobV2RepositoryPort {
  reap = vi.fn<DurableJobV2RepositoryPort["reap"]>(async () => ({ applied: 0 }));
  quarantineUnknown = vi.fn<DurableJobV2RepositoryPort["quarantineUnknown"]>(
    async () => ({ applied: 0 }),
  );
  lease = vi.fn<DurableJobV2RepositoryPort["lease"]>(async () => ({ applied: 0 }));
  renew = vi.fn<DurableJobV2RepositoryPort["renew"]>(async () => ({ applied: 1 }));
  complete = vi.fn<DurableJobV2RepositoryPort["complete"]>(async () => ({ applied: 0 }));
  fail = vi.fn<DurableJobV2RepositoryPort["fail"]>(async () => ({ applied: 0 }));
}

class ManualScheduler implements DurableJobV2Scheduler {
  #now = 0;
  #nextId = 1;
  #tasks = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.#nextId++;
    this.#tasks.set(id, { at: this.#now + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#tasks.delete(handle as number);
  }

  advanceBy(ms: number): void {
    this.#now += ms;
    const due = [...this.#tasks.entries()]
      .filter(([, task]) => task.at <= this.#now)
      .sort((left, right) => left[1].at - right[1].at);
    for (const [id, task] of due) {
      this.#tasks.delete(id);
      task.callback();
    }
  }

  get pending(): number {
    return this.#tasks.size;
  }
}

function options(
  registry = createAuthoritativeDurableJobV2WorkerHandlerRegistry({
    work: async () => undefined,
  }),
  scheduler: DurableJobV2Scheduler = new ManualScheduler(),
) {
  return {
    scope,
    workerId: "worker-a",
    leaseMs: 1_000,
    heartbeatIntervalMs: 100,
    registry,
    scheduler,
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Durable Job v2 worker runNext", () => {
  test("handler registry 与 worker options 非法时 fail-closed", async () => {
    expect(() => createAuthoritativeDurableJobV2WorkerHandlerRegistry({ work: undefined })).toThrow(
      /handler.*invalid/i,
    );
    expect(() => createAuthoritativeDurableJobV2WorkerHandlerRegistry({})).toThrow(
      /authoritative.*empty|empty.*authoritative/i,
    );
    expect(() => new DurableJobV2HandlerFailure("bad-code", true)).toThrow(/code.*invalid/i);
    const repository = new FakeRepository();
    await expect(runNextDurableJobV2(repository, {
      ...options(),
      clock: () => -1,
    })).resolves.toEqual({
      status: "error",
      operation: "protocol",
      code: "INVALID_WORKER_OPTIONS",
    });
    expect(repository.reap).not.toHaveBeenCalled();

    await expect(runNextDurableJobV2(repository, {
      ...options(),
      registry: { authoritative: true, types: [], get: () => undefined },
    })).resolves.toMatchObject({ status: "error", code: "INVALID_WORKER_OPTIONS" });
    expect(repository.quarantineUnknown).not.toHaveBeenCalled();
  });

  test("先 reap、再按完整 authoritative registry quarantine、最后 lease", async () => {
    const repository = new FakeRepository();
    const order: string[] = [];
    repository.reap.mockImplementation(async () => {
      order.push("reap");
      return { applied: 0 };
    });
    repository.quarantineUnknown.mockImplementation(async () => {
      order.push("quarantineUnknown");
      return { applied: 0 };
    });
    repository.lease.mockImplementation(async () => {
      order.push("lease");
      return { applied: 0 };
    });

    await expect(runNextDurableJobV2(repository, options())).resolves.toEqual({ status: "idle" });
    expect(order).toEqual(["reap", "quarantineUnknown", "lease"]);
    expect(repository.reap).toHaveBeenCalledWith({ scope });
    expect(repository.quarantineUnknown).toHaveBeenCalledWith({
      scope,
      authoritativeHandlerTypes: ["work"],
    });
  });

  test("quarantineUnknown 原子隔离 orphan 后直接返回 DLQ，不 lease/handler", async () => {
    const repository = new FakeRepository();
    const orphan = runningJob("unknown");
    const quarantined = failed(orphan, false, "HANDLER_NOT_REGISTERED");
    const handler = vi.fn(async () => undefined);
    repository.quarantineUnknown.mockResolvedValue({ applied: 1, job: quarantined });

    await expect(runNextDurableJobV2(repository, options(
      createAuthoritativeDurableJobV2WorkerHandlerRegistry({ work: handler }),
    ))).resolves.toEqual({
      status: "dead_letter",
      id: quarantined.id,
      type: quarantined.type,
      failureCode: "HANDLER_NOT_REGISTERED",
    });
    expect(repository.lease).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(repository.fail).not.toHaveBeenCalled();
  });

  test("quarantineUnknown throw 为 uncertain；非法 applied/state/scope 均 fail-closed", async () => {
    const thrown = new FakeRepository();
    thrown.quarantineUnknown.mockRejectedValue(new Error("postgres-raw-secret"));
    const uncertainResult = await runNextDurableJobV2(thrown, options());
    expect(uncertainResult).toMatchObject({
      status: "uncertain",
      operation: "quarantineUnknown",
      code: "REPOSITORY_OUTCOME_UNCERTAIN",
    });
    expect(JSON.stringify(uncertainResult)).not.toContain("postgres-raw-secret");
    expect(thrown.lease).not.toHaveBeenCalled();

    const orphan = runningJob("unknown");
    const quarantined = failed(orphan, false, "HANDLER_NOT_REGISTERED");
    const registeredQuarantined = failed(
      runningJob("work"),
      false,
      "HANDLER_NOT_REGISTERED",
    );
    const otherScope = { ...scope, tenantId: "tenant-other" };
    const cases = [
      { applied: 2, job: quarantined },
      { applied: 1, job: orphan },
      { applied: 1, job: registeredQuarantined },
      {
        applied: 1,
        job: {
          ...quarantined,
          scope: otherScope,
          scopedDedupeKey: deriveDurableJobV2ScopedDedupeKey(
            otherScope,
            quarantined.dedupeKey,
          ),
        },
      },
    ];
    for (const result of cases) {
      const repository = new FakeRepository();
      repository.quarantineUnknown.mockResolvedValue(result as never);
      await expect(runNextDurableJobV2(repository, options())).resolves.toMatchObject({
        status: "error",
        operation: "quarantineUnknown",
        code: "INVALID_REPOSITORY_RESULT",
      });
      expect(repository.lease).not.toHaveBeenCalled();
    }
  });

  test("quarantineUnknown CAS miss 仅接受同 scope 的 orphan candidate 后继续 lease", async () => {
    const orphan = createDurableJobV2({
      id: "job-orphan-cas-miss",
      type: "legacy_handler",
      payload: { value: 1 },
      dedupeKey: "legacy_handler:cas-miss",
      scope,
      maxAttempts: 3,
    }, {
      registry: createDurableJobHandlerRegistry(["legacy_handler"]),
      now: 100,
    });
    const accepted = new FakeRepository();
    accepted.quarantineUnknown.mockResolvedValue({ applied: 0, job: orphan });

    await expect(runNextDurableJobV2(accepted, options())).resolves.toEqual({ status: "idle" });
    expect(accepted.lease).toHaveBeenCalledTimes(1);

    const alienScope = { ...scope, tenantId: "tenant-alien" };
    const registered = createDurableJobV2({
      id: "job-registered-cas-miss",
      type: "work",
      payload: { value: 1 },
      dedupeKey: "work:cas-miss",
      scope,
      maxAttempts: 3,
    }, {
      registry: createDurableJobHandlerRegistry(["work"]),
      now: 100,
    });
    const cases = [
      {
        ...orphan,
        scope: alienScope,
        scopedDedupeKey: deriveDurableJobV2ScopedDedupeKey(alienScope, orphan.dedupeKey),
      },
      registered,
      failed(runningJob("legacy_handler"), false, "HANDLER_NOT_REGISTERED"),
    ];
    for (const job of cases) {
      const repository = new FakeRepository();
      repository.quarantineUnknown.mockResolvedValue({ applied: 0, job } as never);
      await expect(runNextDurableJobV2(repository, options())).resolves.toEqual({
        status: "error",
        operation: "quarantineUnknown",
        code: "INVALID_REPOSITORY_RESULT",
      });
      expect(repository.lease).not.toHaveBeenCalled();
    }
  });

  test.each(["reap", "lease"] as const)(
    "%s applied 非 0/1 时拒绝 repository 结果",
    async (operation) => {
      const repository = new FakeRepository();
      const job = runningJob();
      repository[operation].mockResolvedValue({ applied: 2, job } as never);

      await expect(runNextDurableJobV2(repository, options())).resolves.toMatchObject({
        status: "error",
        operation,
        code: "INVALID_REPOSITORY_RESULT",
      });
      expect(repository.complete).not.toHaveBeenCalled();
      expect(repository.fail).not.toHaveBeenCalled();
    },
  );

  test("lease 返回其他 owner 的有效 running job 时 fail-closed", async () => {
    const repository = new FakeRepository();
    const handler = vi.fn(async () => undefined);
    const foreignLease = {
      ...runningJob(),
      leaseOwner: "worker-b",
      leaseToken: "b".repeat(32),
    } satisfies DurableJobV2;
    repository.lease.mockResolvedValue({ applied: 1, job: foreignLease });

    await expect(runNextDurableJobV2(repository, options(
      createAuthoritativeDurableJobV2WorkerHandlerRegistry({ work: handler }),
    ))).resolves.toMatchObject({
      status: "error",
      operation: "lease",
      code: "INVALID_REPOSITORY_RESULT",
    });
    expect(handler).not.toHaveBeenCalled();
    expect(repository.complete).not.toHaveBeenCalled();
  });

  test("handler 成功后 complete 使用 owner+token+generation fence", async () => {
    const repository = new FakeRepository();
    const job = runningJob();
    const handler = vi.fn(async () => "raw-handler-result");
    repository.lease.mockResolvedValue({ applied: 1, job });
    repository.complete.mockResolvedValue({ applied: 1, job: completed(job) });

    await expect(runNextDurableJobV2(repository, options(
      createAuthoritativeDurableJobV2WorkerHandlerRegistry({ work: handler }),
    ))).resolves.toEqual({ status: "completed", id: job.id, type: "work" });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(repository.complete).toHaveBeenCalledWith({
      id: job.id,
      scope,
      owner: "worker-a",
      leaseToken: "a".repeat(32),
      leaseGeneration: 1,
    });
  });

  test("complete/fail applied 非 0/1 时拒绝，不能伪装成功", async () => {
    const job = runningJob();
    const invalidComplete = new FakeRepository();
    invalidComplete.lease.mockResolvedValue({ applied: 1, job });
    invalidComplete.complete.mockResolvedValue({ applied: 2, job: completed(job) } as never);
    await expect(runNextDurableJobV2(invalidComplete, options())).resolves.toMatchObject({
      status: "error",
      operation: "complete",
      code: "INVALID_REPOSITORY_RESULT",
    });

    const invalidFail = new FakeRepository();
    invalidFail.lease.mockResolvedValue({ applied: 1, job });
    invalidFail.fail.mockResolvedValue({ applied: 2, job: failed(job, true) } as never);
    await expect(runNextDurableJobV2(invalidFail, options(
      createAuthoritativeDurableJobV2WorkerHandlerRegistry({
        work: async () => { throw new Error("handler-secret"); },
      }),
    ))).resolves.toMatchObject({
      status: "error",
      operation: "fail",
      code: "INVALID_REPOSITORY_RESULT",
    });
  });

  test("complete/fail 不接受 alien job，fail 必须回写请求的安全错误", async () => {
    const job = runningJob();
    const alienComplete = new FakeRepository();
    alienComplete.lease.mockResolvedValue({ applied: 1, job });
    alienComplete.complete.mockResolvedValue({
      applied: 1,
      job: { ...completed(job), id: "job-alien" },
    });
    await expect(runNextDurableJobV2(alienComplete, options())).resolves.toMatchObject({
      status: "error",
      operation: "complete",
    });

    const alienFail = new FakeRepository();
    alienFail.lease.mockResolvedValue({ applied: 1, job });
    alienFail.fail.mockResolvedValue({
      applied: 1,
      job: { ...failed(job, true, "OTHER_ERROR"), id: "job-alien" },
    });
    await expect(runNextDurableJobV2(alienFail, options(
      createAuthoritativeDurableJobV2WorkerHandlerRegistry({
        work: async () => { throw new Error("handler-secret"); },
      }),
    ))).resolves.toMatchObject({ status: "error", operation: "fail" });

    const mismatchedFailure = new FakeRepository();
    mismatchedFailure.lease.mockResolvedValue({ applied: 1, job });
    mismatchedFailure.fail.mockResolvedValue({
      applied: 1,
      job: failed(job, true, "OTHER_ERROR"),
    });
    await expect(runNextDurableJobV2(mismatchedFailure, options(
      createAuthoritativeDurableJobV2WorkerHandlerRegistry({
        work: async () => { throw new Error("handler-secret"); },
      }),
    ))).resolves.toMatchObject({ status: "error", operation: "fail" });
  });

  test("retryable handler failure 安全 fail 到 retry_wait，不传 raw secret", async () => {
    const repository = new FakeRepository();
    const job = runningJob();
    repository.lease.mockResolvedValue({ applied: 1, job });
    repository.fail.mockResolvedValue({ applied: 1, job: failed(job, true) });
    const registry = createAuthoritativeDurableJobV2WorkerHandlerRegistry({
      work: async () => {
        throw new Error("password=provider-secret");
      },
    });

    const result = await runNextDurableJobV2(repository, options(registry));

    expect(result).toEqual({
      status: "retry_wait",
      id: job.id,
      type: "work",
      failureCode: "HANDLER_ERROR",
    });
    expect(repository.fail).toHaveBeenCalledWith(expect.objectContaining({
      failure: { code: "HANDLER_ERROR", retryable: true },
    }));
    expect(JSON.stringify(repository.fail.mock.calls)).not.toContain("provider-secret");
    expect(JSON.stringify(result)).not.toContain("provider-secret");
  });

  test("结构化 nonretryable handler failure 进入 DLQ", async () => {
    const repository = new FakeRepository();
    const job = runningJob();
    repository.lease.mockResolvedValue({ applied: 1, job });
    repository.fail.mockResolvedValue({ applied: 1, job: failed(job, false) });
    const registry = createAuthoritativeDurableJobV2WorkerHandlerRegistry({
      work: async () => {
        throw new DurableJobV2HandlerFailure("PERMANENT_ERROR", false);
      },
    });

    await expect(runNextDurableJobV2(repository, options(registry))).resolves.toEqual({
      status: "dead_letter",
      id: job.id,
      type: "work",
      failureCode: "PERMANENT_ERROR",
    });
  });

  test("defense-in-depth：repository 若错误 lease orphan，仍不执行 handler", async () => {
    const repository = new FakeRepository();
    const job = runningJob("unknown");
    repository.lease.mockResolvedValue({ applied: 1, job });
    repository.fail.mockResolvedValue({
      applied: 1,
      job: failed(job, false, "HANDLER_NOT_REGISTERED"),
    });
    const registry = createAuthoritativeDurableJobV2WorkerHandlerRegistry({
      work: async () => undefined,
    });

    const result = await runNextDurableJobV2(repository, options(registry));

    expect(result).toMatchObject({ status: "dead_letter", failureCode: "HANDLER_NOT_REGISTERED" });
    expect(repository.fail).toHaveBeenCalledWith(expect.objectContaining({
      failure: { code: "HANDLER_NOT_REGISTERED", retryable: false },
    }));
  });

  test("heartbeat renew 成功后仍使用原 fence complete", async () => {
    const repository = new FakeRepository();
    const scheduler = new ManualScheduler();
    const job = runningJob();
    let finish!: () => void;
    const handler = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    repository.lease.mockResolvedValue({ applied: 1, job });
    const firstRenewal = renewed(job, 200);
    const secondRenewal = renewed(firstRenewal, 300);
    repository.renew
      .mockResolvedValueOnce({ applied: 1, job: firstRenewal })
      .mockResolvedValueOnce({ applied: 1, job: secondRenewal });
    repository.complete.mockResolvedValue({ applied: 1, job: completed(secondRenewal, 350) });
    const promise = runNextDurableJobV2(repository, options(
      createAuthoritativeDurableJobV2WorkerHandlerRegistry({ work: handler }),
      scheduler,
    ));
    await flush();

    scheduler.advanceBy(100);
    await flush();
    scheduler.advanceBy(100);
    await flush();
    finish();
    const result = await promise;

    expect(repository.renew).toHaveBeenCalledTimes(2);
    expect(repository.renew).toHaveBeenCalledWith({
      id: job.id,
      scope,
      owner: "worker-a",
      leaseToken: "a".repeat(32),
      leaseGeneration: 1,
      leaseMs: 1_000,
    });
    expect(result.status).toBe("completed");
  });

  test("renew 成功必须返回同一 job/fence 且推进 heartbeat/lease/updatedAt", async () => {
    const repository = new FakeRepository();
    const scheduler = new ManualScheduler();
    const job = runningJob();
    let finish!: () => void;
    repository.lease.mockResolvedValue({ applied: 1, job });
    repository.renew.mockResolvedValue({ applied: 1, job });
    repository.complete.mockResolvedValue({ applied: 1, job: completed(job) });
    const promise = runNextDurableJobV2(repository, options(
      createAuthoritativeDurableJobV2WorkerHandlerRegistry({
        work: () => new Promise<void>((resolve) => { finish = resolve; }),
      }),
      scheduler,
    ));
    await flush();

    scheduler.advanceBy(100);
    await flush();
    finish();

    await expect(promise).resolves.toMatchObject({
      status: "error",
      operation: "renew",
      code: "INVALID_REPOSITORY_RESULT",
    });
    expect(repository.complete).not.toHaveBeenCalled();
  });

  test("renew applied 非 0/1 或返回 alien job 时 abort handler 且不 ack", async () => {
    for (const renewedResult of [
      { applied: 2, job: renewed(runningJob(), 200) },
      { applied: 1, job: { ...renewed(runningJob(), 200), id: "job-alien" } },
    ]) {
      const repository = new FakeRepository();
      const scheduler = new ManualScheduler();
      const job = runningJob();
      let finish!: () => void;
      repository.lease.mockResolvedValue({ applied: 1, job });
      repository.renew.mockResolvedValue(renewedResult as never);
      const promise = runNextDurableJobV2(repository, options(
        createAuthoritativeDurableJobV2WorkerHandlerRegistry({
          work: () => new Promise<void>((resolve) => { finish = resolve; }),
        }),
        scheduler,
      ));
      await flush();

      scheduler.advanceBy(100);
      await flush();
      finish();

      await expect(promise).resolves.toMatchObject({ status: "error", operation: "renew" });
      expect(repository.complete).not.toHaveBeenCalled();
      expect(repository.fail).not.toHaveBeenCalled();
    }
  });

  test("被其他 worker takeover 后 heartbeat applied=0：abort handler 且禁止 complete/fail", async () => {
    const repository = new FakeRepository();
    const scheduler = new ManualScheduler();
    const job = runningJob();
    const handler = vi.fn((_job: DurableJobV2, context: { signal: AbortSignal }) =>
      new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true })));
    repository.lease.mockResolvedValue({ applied: 1, job });
    repository.renew.mockResolvedValue({ applied: 0, job });
    const promise = runNextDurableJobV2(repository, options(
      createAuthoritativeDurableJobV2WorkerHandlerRegistry({ work: handler }),
      scheduler,
    ));
    await flush();

    scheduler.advanceBy(100);
    await flush();

    await expect(promise).resolves.toMatchObject({ status: "lease_lost", id: job.id });
    expect(repository.complete).not.toHaveBeenCalled();
    expect(repository.fail).not.toHaveBeenCalled();
  });

  test("heartbeat renew 抛错视为 uncertain，abort handler 且不 ack", async () => {
    const repository = new FakeRepository();
    const scheduler = new ManualScheduler();
    const job = runningJob();
    const handler = vi.fn((_job: DurableJobV2, context: { signal: AbortSignal }) =>
      new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true })));
    repository.lease.mockResolvedValue({ applied: 1, job });
    repository.renew.mockRejectedValue(new Error("provider-secret"));
    const promise = runNextDurableJobV2(repository, options(
      createAuthoritativeDurableJobV2WorkerHandlerRegistry({ work: handler }),
      scheduler,
    ));
    await flush();

    scheduler.advanceBy(100);
    await flush();

    await expect(promise).resolves.toMatchObject({
      status: "uncertain",
      operation: "renew",
      code: "REPOSITORY_OUTCOME_UNCERTAIN",
    });
    expect(repository.complete).not.toHaveBeenCalled();
    expect(repository.fail).not.toHaveBeenCalled();
  });

  test.each([
    ["lost", { applied: 0 }, { status: "lease_lost", operation: "renew" }],
    ["invalid", { applied: 1 }, { status: "error", operation: "renew" }],
  ] as const)(
    "heartbeat %s 时不等待忽略 AbortSignal 的 handler，detached rejection 被吸收",
    async (_kind, renewResult, expected) => {
      const repository = new FakeRepository();
      const scheduler = new ManualScheduler();
      const job = runningJob();
      let rejectHandler!: (error: Error) => void;
      repository.lease.mockResolvedValue({ applied: 1, job });
      repository.renew.mockResolvedValue(renewResult);
      const promise = runNextDurableJobV2(repository, options(
        createAuthoritativeDurableJobV2WorkerHandlerRegistry({
          work: () => new Promise<void>((_resolve, reject) => { rejectHandler = reject; }),
        }),
        scheduler,
      ));
      await flush();

      scheduler.advanceBy(100);
      await flush();
      let observed: unknown;
      void promise.then((result) => { observed = result; });
      await flush();

      try {
        expect(observed).toMatchObject(expected);
        expect(repository.complete).not.toHaveBeenCalled();
        expect(repository.fail).not.toHaveBeenCalled();
      } finally {
        rejectHandler(new Error("late-detached-handler-secret"));
        await promise;
        await flush();
      }
    },
  );

  test("heartbeat uncertain 时不等待忽略 AbortSignal 的 handler", async () => {
    const repository = new FakeRepository();
    const scheduler = new ManualScheduler();
    const job = runningJob();
    let finish!: () => void;
    repository.lease.mockResolvedValue({ applied: 1, job });
    repository.renew.mockRejectedValue(new Error("ambiguous-renew-secret"));
    const promise = runNextDurableJobV2(repository, options(
      createAuthoritativeDurableJobV2WorkerHandlerRegistry({
        work: () => new Promise<void>((resolve) => { finish = resolve; }),
      }),
      scheduler,
    ));
    await flush();

    scheduler.advanceBy(100);
    await flush();
    let observed: unknown;
    void promise.then((result) => { observed = result; });
    await flush();

    try {
      expect(observed).toMatchObject({ status: "uncertain", operation: "renew" });
      expect(repository.complete).not.toHaveBeenCalled();
      expect(repository.fail).not.toHaveBeenCalled();
    } finally {
      finish();
      await promise;
    }
  });

  test("external abort 时不等待忽略 AbortSignal 的 handler", async () => {
    const repository = new FakeRepository();
    const scheduler = new ManualScheduler();
    const controller = new AbortController();
    const job = runningJob();
    let finish!: () => void;
    repository.lease.mockResolvedValue({ applied: 1, job });
    const promise = runNextDurableJobV2(repository, {
      ...options(createAuthoritativeDurableJobV2WorkerHandlerRegistry({
        work: () => new Promise<void>((resolve) => { finish = resolve; }),
      }), scheduler),
      signal: controller.signal,
    });
    await flush();

    controller.abort();
    await flush();
    let observed: unknown;
    void promise.then((result) => { observed = result; });
    await flush();

    try {
      expect(observed).toMatchObject({ status: "aborted", id: job.id });
      expect(repository.complete).not.toHaveBeenCalled();
      expect(repository.fail).not.toHaveBeenCalled();
    } finally {
      finish();
      await promise;
    }
  });

  test("heartbeat clearTimeout 同步抛错时返回 protocol 且不 ack", async () => {
    const repository = new FakeRepository();
    const scheduler = new ManualScheduler();
    scheduler.clearTimeout = () => { throw new Error("clear-timeout-secret"); };
    const job = runningJob();
    repository.lease.mockResolvedValue({ applied: 1, job });

    await expect(runNextDurableJobV2(repository, options(
      createAuthoritativeDurableJobV2WorkerHandlerRegistry({ work: async () => undefined }),
      scheduler,
    ))).resolves.toMatchObject({ status: "error", operation: "protocol" });
    expect(repository.complete).not.toHaveBeenCalled();
    expect(repository.fail).not.toHaveBeenCalled();
  });

  test("complete CAS applied=0 报 stale，不伪装成功也不重跑 handler", async () => {
    const repository = new FakeRepository();
    const job = runningJob();
    const handler = vi.fn(async () => undefined);
    repository.lease.mockResolvedValue({ applied: 1, job });
    repository.complete.mockResolvedValue({ applied: 0, job });

    await expect(runNextDurableJobV2(repository, options(
      createAuthoritativeDurableJobV2WorkerHandlerRegistry({ work: handler }),
    ))).resolves.toEqual({
      status: "stale",
      operation: "complete",
      id: job.id,
      type: "work",
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(repository.fail).not.toHaveBeenCalled();
  });

  test("lease applied=1 却缺 job，以及 fail CAS=0 都显式报 protocol/stale", async () => {
    const invalidLease = new FakeRepository();
    invalidLease.lease.mockResolvedValue({ applied: 1 });
    await expect(runNextDurableJobV2(invalidLease, options())).resolves.toEqual({
      status: "error",
      operation: "lease",
      code: "INVALID_REPOSITORY_RESULT",
    });

    const staleFail = new FakeRepository();
    const job = runningJob();
    staleFail.lease.mockResolvedValue({ applied: 1, job });
    staleFail.fail.mockResolvedValue({ applied: 0, job });
    await expect(runNextDurableJobV2(staleFail, options(
      createAuthoritativeDurableJobV2WorkerHandlerRegistry({
        work: async () => { throw new Error("secret"); },
      }),
    ))).resolves.toEqual({
      status: "stale",
      operation: "fail",
      id: job.id,
      type: job.type,
    });
  });

  test.each(["reap", "lease", "complete"] as const)(
    "%s repository/ambiguous commit error 转为 uncertain，不泄露 secret",
    async (operation) => {
      const repository = new FakeRepository();
      const job = runningJob();
      const handler = vi.fn(async () => undefined);
      repository.lease.mockResolvedValue({ applied: 1, job });
      repository.complete.mockResolvedValue({ applied: 1, job: completed(job) });
      repository[operation].mockRejectedValue(new Error("token=raw-provider-secret"));

      const result = await runNextDurableJobV2(repository, options(
        createAuthoritativeDurableJobV2WorkerHandlerRegistry({ work: handler }),
      ));

      expect(result).toMatchObject({
        status: "uncertain",
        operation,
        code: "REPOSITORY_OUTCOME_UNCERTAIN",
      });
      expect(JSON.stringify(result)).not.toContain("raw-provider-secret");
      if (operation === "complete") expect(handler).toHaveBeenCalledTimes(1);
      else expect(handler).not.toHaveBeenCalled();
    },
  );

  test("fail ambiguous commit 不重跑 handler，也不泄露 raw error", async () => {
    const repository = new FakeRepository();
    const job = runningJob();
    const handler = vi.fn(async () => { throw new Error("handler-secret"); });
    repository.lease.mockResolvedValue({ applied: 1, job });
    repository.fail.mockRejectedValue(new Error("commit-result-unknown-secret"));

    const result = await runNextDurableJobV2(repository, options(
      createAuthoritativeDurableJobV2WorkerHandlerRegistry({ work: handler }),
    ));

    expect(result).toMatchObject({ status: "uncertain", operation: "fail" });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(/handler-secret|commit-result-unknown-secret/);
  });
});

describe("Durable Job v2 worker loop", () => {
  test("非法 loop/stop timeout 与已 abort stop signal fail-closed", async () => {
    const repository = new FakeRepository();
    expect(() => startDurableJobV2WorkerLoop(repository, {
      ...options(),
      intervalMs: 0,
      stopTimeoutMs: 100,
    })).toThrow(/loop options.*invalid/i);

    const scheduler = new ManualScheduler();
    const job = runningJob();
    repository.lease.mockResolvedValue({ applied: 1, job });
    const loop = startDurableJobV2WorkerLoop(repository, {
      ...options(createAuthoritativeDurableJobV2WorkerHandlerRegistry({
        work: () => new Promise<void>(() => undefined),
      }), scheduler),
      intervalMs: 100,
      stopTimeoutMs: 100,
    });
    void loop.tick();
    await flush();
    const controller = new AbortController();
    controller.abort();
    await expect(loop.stop({ signal: controller.signal })).resolves.toEqual({ status: "aborted" });
  });

  test("stop abort 当前 handler 并在边界内结束，不执行 ack", async () => {
    const repository = new FakeRepository();
    const scheduler = new ManualScheduler();
    const job = runningJob();
    repository.lease.mockResolvedValueOnce({ applied: 1, job }).mockResolvedValue({ applied: 0 });
    const handler = vi.fn((_job: DurableJobV2, context: { signal: AbortSignal }) =>
      new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true })));
    const loop = startDurableJobV2WorkerLoop(repository, {
      ...options(createAuthoritativeDurableJobV2WorkerHandlerRegistry({ work: handler }), scheduler),
      intervalMs: 1_000,
      stopTimeoutMs: 500,
    });
    const tick = loop.tick();
    await flush();

    await expect(loop.stop()).resolves.toEqual({ status: "stopped" });
    await tick;
    expect(repository.complete).not.toHaveBeenCalled();
    expect(repository.fail).not.toHaveBeenCalled();
  });

  test("忽略 AbortSignal 的 handler 不阻塞 stop/tick，且禁止 ack", async () => {
    const repository = new FakeRepository();
    const scheduler = new ManualScheduler();
    const job = runningJob();
    repository.lease.mockResolvedValue({ applied: 1, job });
    const handler = vi.fn(() => new Promise<void>(() => undefined));
    const loop = startDurableJobV2WorkerLoop(repository, {
      ...options(createAuthoritativeDurableJobV2WorkerHandlerRegistry({ work: handler }), scheduler),
      intervalMs: 1_000,
      stopTimeoutMs: 200,
    });
    void loop.tick();
    await flush();

    await expect(loop.stop()).resolves.toEqual({ status: "stopped" });
    expect(repository.complete).not.toHaveBeenCalled();
    expect(repository.fail).not.toHaveBeenCalled();
    expect(scheduler.pending).toBe(0);
  });

  test("后台 timer/tick 的 registry rejection 转结构化 error 且不产生 unhandled", async () => {
    const repository = new FakeRepository();
    const scheduler = new ManualScheduler();
    const job = runningJob();
    repository.lease.mockResolvedValue({ applied: 1, job });
    const registry = {
      authoritative: true as const,
      types: ["work"],
      get: () => { throw new Error("unexpected-registry-secret"); },
    };
    const loop = startDurableJobV2WorkerLoop(repository, {
      ...options(registry, scheduler),
      intervalMs: 100,
      stopTimeoutMs: 200,
    });

    scheduler.advanceBy(100);
    await flush();
    await flush();

    await expect(loop.stop()).resolves.toEqual({ status: "stopped" });
    expect(repository.complete).not.toHaveBeenCalled();
    expect(repository.fail).not.toHaveBeenCalled();
    expect(scheduler.pending).toBe(0);
  });

  test("首次或重新 schedule 的 setTimeout 同步抛错时循环安全停止", async () => {
    const repository = new FakeRepository();
    const alwaysThrow = {
      setTimeout: () => { throw new Error("initial-set-timeout-secret"); },
      clearTimeout: vi.fn(),
    } satisfies DurableJobV2Scheduler;
    let initialLoop: ReturnType<typeof startDurableJobV2WorkerLoop> | undefined;
    expect(() => {
      initialLoop = startDurableJobV2WorkerLoop(repository, {
        ...options(undefined, alwaysThrow),
        intervalMs: 100,
        stopTimeoutMs: 200,
      });
    }).not.toThrow();
    await expect(initialLoop!.tick()).resolves.toEqual([]);
    await expect(initialLoop!.stop()).resolves.toEqual({ status: "stopped" });

    class ThrowOnSecondSetScheduler extends ManualScheduler {
      calls = 0;

      override setTimeout(callback: () => void, delayMs: number): number {
        this.calls += 1;
        if (this.calls === 2) throw new Error("reschedule-secret");
        return super.setTimeout(callback, delayMs);
      }
    }
    const rescheduler = new ThrowOnSecondSetScheduler();
    const rescheduleLoop = startDurableJobV2WorkerLoop(repository, {
      ...options(undefined, rescheduler),
      intervalMs: 100,
      stopTimeoutMs: 200,
    });
    rescheduler.advanceBy(100);
    await rescheduleLoop.tick();
    await flush();

    expect(rescheduler.calls).toBe(2);
    await expect(rescheduleLoop.tick()).resolves.toEqual([]);
    await expect(rescheduleLoop.stop()).resolves.toEqual({ status: "stopped" });
  });

  test("loop clearTimeout 同步抛错时 stop 不 reject 或泄漏 timer", async () => {
    const repository = new FakeRepository();
    class ThrowOnClearScheduler extends ManualScheduler {
      override clearTimeout(_handle: unknown): void {
        throw new Error("clear-timeout-secret");
      }
    }
    const scheduler = new ThrowOnClearScheduler();
    const loop = startDurableJobV2WorkerLoop(repository, {
      ...options(undefined, scheduler),
      intervalMs: 100,
      stopTimeoutMs: 200,
    });

    await expect(loop.stop()).resolves.toEqual({ status: "stopped" });
  });
});
