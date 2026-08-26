import { describe, expect, test, vi } from "vitest";

import type { RuntimeLifecycleStep } from "../packages/core/src/runtime/runtime-lifecycle.js";
import type {
  DurableJobV2RepositoryPort,
  DurableJobV2WorkerLoopHandle,
} from "./workers-v2.js";
import {
  createAuthoritativeDurableJobV2WorkerHandlerRegistry,
  startDurableJobV2WorkerLoop,
} from "./workers-v2.js";
import {
  RuntimeHost,
  RuntimeHostError,
  type RuntimeHostBoundaryScheduler,
} from "./runtime-host.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

class ManualScheduler implements RuntimeHostBoundaryScheduler {
  private nextId = 1;
  private readonly callbacks = new Map<number, () => void>();

  setTimeout(callback: () => void, _delayMs: number): number {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.callbacks.delete(handle as number);
  }

  fireAll(): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback();
  }

  get pending(): number {
    return this.callbacks.size;
  }
}

function fakeWorker(overrides: Partial<DurableJobV2WorkerLoopHandle> = {}) {
  return {
    tick: vi.fn(async () => [{ status: "idle" as const }]),
    stop: vi.fn(async () => ({ status: "stopped" as const })),
    ...overrides,
  } satisfies DurableJobV2WorkerLoopHandle;
}

function hostOptions(
  dependencies: readonly RuntimeLifecycleStep[],
  worker: DurableJobV2WorkerLoopHandle,
  scheduler = new ManualScheduler(),
) {
  return {
    dependencies,
    startWorker: vi.fn(() => worker),
    workerProbeTimeoutMs: 100,
    workerStopTimeoutMs: 200,
    scheduler,
  };
}

describe("RuntimeHost", () => {
  test("并发 start 幂等，依赖全部 ready 后才启动 worker 且绝不以 tick 做健康探测", async () => {
    const calls: string[] = [];
    const worker = fakeWorker();
    const options = hostOptions([
      { name: "db", start: vi.fn(async () => { calls.push("db:start"); }) },
      { name: "registry", start: vi.fn(async () => { calls.push("registry:start"); }) },
    ], worker);
    const host = new RuntimeHost(options);

    expect(host.snapshot().generation).toBe(1);

    const starts = Array.from({ length: 10 }, () => host.start());
    expect(starts.every((promise) => promise === starts[0])).toBe(true);
    await Promise.all(starts);

    expect(calls).toEqual(["db:start", "registry:start"]);
    expect(options.startWorker).toHaveBeenCalledTimes(1);
    expect(worker.tick).not.toHaveBeenCalled();
    expect(host.snapshot()).toEqual({
      state: "ready",
      ready: true,
      accepting: true,
      generation: 1,
    });
  });

  test("在线 supervisor 熔断后动态降级 readiness，half-open 成功后自动恢复", async () => {
    let workerHealth = {
      state: "healthy" as "healthy" | "open",
      ready: true,
      consecutiveFailures: 0,
      failingScopes: 0,
    };
    const worker = fakeWorker({
      snapshot: vi.fn(() => workerHealth),
    });
    const host = new RuntimeHost(hostOptions([
      { name: "db", start: async () => undefined },
    ], worker));
    await host.start();

    workerHealth = {
      state: "open",
      ready: false,
      consecutiveFailures: 5,
      failingScopes: 2,
    };
    expect(host.snapshot()).toEqual({
      state: "degraded",
      ready: false,
      accepting: false,
      generation: 1,
      issues: [{ component: "worker", code: "WORKER_RUNTIME_DEGRADED" }],
    });

    workerHealth = {
      state: "healthy",
      ready: true,
      consecutiveFailures: 0,
      failingScopes: 0,
    };
    expect(host.snapshot()).toEqual({
      state: "ready",
      ready: true,
      accepting: true,
      generation: 1,
    });
  });

  test("依赖降级时不启动 worker，Host 只报告脱敏 degraded", async () => {
    const worker = fakeWorker();
    const options = hostOptions([
      {
        name: "embedding-registry",
        start: async () => ({ ready: false as const, reason: "raw-provider-secret" }),
      },
    ], worker);
    const host = new RuntimeHost(options);

    await host.start();

    expect(options.startWorker).not.toHaveBeenCalled();
    expect(host.snapshot()).toEqual({
      state: "degraded",
      ready: false,
      accepting: false,
      generation: 1,
      issues: [
        { component: "embedding-registry", code: "DEPENDENCY_DEGRADED" },
        { component: "worker", code: "DEPENDENCIES_NOT_READY" },
      ],
    });
    expect(JSON.stringify(host.snapshot())).not.toContain("raw-provider-secret");
  });

  test("依赖初始化失败会逆序回滚且 worker 永不启动", async () => {
    const calls: string[] = [];
    const worker = fakeWorker();
    const options = hostOptions([
      {
        name: "db",
        start: async () => { calls.push("db:start"); },
        stop: async () => { calls.push("db:stop"); },
      },
      {
        name: "registry",
        start: async () => { calls.push("registry:start"); throw new Error("database-password"); },
      },
    ], worker);
    const host = new RuntimeHost(options);

    await expect(host.start()).rejects.toMatchObject({ code: "HOST_START_FAILED" });

    expect(calls).toEqual(["db:start", "registry:start", "db:stop"]);
    expect(options.startWorker).not.toHaveBeenCalled();
    expect(host.snapshot()).toEqual({
      state: "failed",
      ready: false,
      accepting: false,
      generation: 1,
      failureCode: "HOST_START_FAILED",
    });
    expect(JSON.stringify(host.snapshot())).not.toMatch(/database-password|Error/);
  });

  test("显式无副作用 probe 返回 uncertain/unavailable 时绝不伪报 ready", async () => {
    for (const status of ["uncertain", "unavailable"] as const) {
      const worker = fakeWorker();
      const options = {
        ...hostOptions([{ name: "db", start: async () => {} }], worker),
        probeWorker: vi.fn(async () => ({ status })),
      };
      const host = new RuntimeHost(options);

      await host.start();

      expect(options.probeWorker).toHaveBeenCalledWith();
      expect(options.startWorker).not.toHaveBeenCalled();
      expect(worker.tick).not.toHaveBeenCalled();
      expect(host.snapshot()).toMatchObject({
        state: "degraded",
        ready: false,
        accepting: false,
        issues: [{ component: "worker", code: "WORKER_NOT_READY" }],
      });
      await host.stop();
    }
  });

  test("worker probe 抛错或超时均脱敏降级且不产生未处理 rejection", async () => {
    const scheduler = new ManualScheduler();
    const late = deferred<{ status: "ready" }>();
    const worker = fakeWorker();
    const options = {
      ...hostOptions([{ name: "db", start: async () => {} }], worker, scheduler),
      probeWorker: vi.fn(() => late.promise),
    };
    const host = new RuntimeHost(options);

    const starting = host.start();
    await flush();
    scheduler.fireAll();
    await starting;
    late.reject(new Error("late-worker-secret"));
    await flush();

    expect(host.snapshot()).toMatchObject({
      state: "degraded",
      ready: false,
      issues: [{ component: "worker", code: "WORKER_PROBE_TIMEOUT" }],
    });
    expect(JSON.stringify(host.snapshot())).not.toContain("late-worker-secret");
    expect(options.startWorker).not.toHaveBeenCalled();
    expect(worker.tick).not.toHaveBeenCalled();

    const rejectedWorker = fakeWorker();
    const rejectedHost = new RuntimeHost({
      ...hostOptions([{ name: "db", start: async () => {} }], rejectedWorker),
      probeWorker: vi.fn(async () => { throw new Error("probe-provider-secret"); }),
    });
    await rejectedHost.start();
    expect(rejectedHost.snapshot()).toMatchObject({
      state: "degraded",
      ready: false,
      issues: [{ component: "worker", code: "WORKER_PROBE_FAILED" }],
    });
    expect(JSON.stringify(rejectedHost.snapshot())).not.toContain("probe-provider-secret");
    expect(rejectedHost.snapshot().state).toBe("degraded");
    expect(rejectedWorker.tick).not.toHaveBeenCalled();
    await rejectedHost.stop();
  });

  test("probe 在 worker 构造前完成，unavailable 时真实 worker 不调度 repository", async () => {
    let reaps = 0;
    const repository: DurableJobV2RepositoryPort = {
      reap: async () => { reaps += 1; return { applied: 0 }; },
      quarantineUnknown: async () => ({ applied: 0 }),
      lease: async () => ({ applied: 0 }),
      renew: async () => ({ applied: 0 }),
      complete: async () => ({ applied: 0 }),
      fail: async () => ({ applied: 0 }),
    };
    const registry = createAuthoritativeDurableJobV2WorkerHandlerRegistry({
      extract_candidate: async () => undefined,
    });
    const startWorker = vi.fn(() => startDurableJobV2WorkerLoop(repository, {
      scope: {
        tenantId: "tenant-a",
        userId: "user-a",
        appId: "app-a",
        projectId: "project-a",
        agentId: "agent-a",
        namespace: "memory",
        visibility: "private",
      },
      workerId: "runtime-host-worker",
      leaseMs: 100,
      heartbeatIntervalMs: 10,
      intervalMs: 1,
      stopTimeoutMs: 50,
      registry,
    }));
    const host = new RuntimeHost({
      dependencies: [],
      startWorker,
      probeWorker: async () => ({ status: "unavailable" }),
      workerProbeTimeoutMs: 50,
      workerStopTimeoutMs: 50,
    });

    await host.start();
    await new Promise((resolve) => setTimeout(resolve, 12));

    expect(host.snapshot()).toMatchObject({ state: "degraded", accepting: false });
    expect(startWorker).not.toHaveBeenCalled();
    expect(reaps).toBe(0);
    await host.stop();
  });

  test("probe ready 后才构造 worker，且 probe 不获得 tick-capable handle", async () => {
    const calls: string[] = [];
    const worker = fakeWorker();
    const probeWorker = vi.fn(async () => {
      calls.push("probe");
      return { status: "ready" as const };
    });
    const startWorker = vi.fn(() => {
      calls.push("worker:start");
      return worker;
    });
    const host = new RuntimeHost({
      dependencies: [],
      startWorker,
      probeWorker,
      workerProbeTimeoutMs: 50,
      workerStopTimeoutMs: 50,
    });

    await host.start();

    expect(calls).toEqual(["probe", "worker:start"]);
    expect(probeWorker).toHaveBeenCalledWith();
    expect(worker.tick).not.toHaveBeenCalled();
    await host.stop();
  });

  test("worker factory 失败会回滚全部依赖并返回固定错误码", async () => {
    const calls: string[] = [];
    const worker = fakeWorker();
    const options = hostOptions([
      {
        name: "db",
        start: async () => { calls.push("db:start"); },
        stop: async () => { calls.push("db:stop"); },
      },
      {
        name: "tree",
        start: async () => { calls.push("tree:start"); },
        stop: async () => { calls.push("tree:stop"); },
      },
    ], worker);
    options.startWorker.mockImplementation(() => { throw new Error("worker-factory-secret"); });
    const host = new RuntimeHost(options);

    await expect(host.start()).rejects.toEqual(new RuntimeHostError("HOST_START_FAILED"));

    expect(calls).toEqual(["db:start", "tree:start", "tree:stop", "db:stop"]);
    expect(host.snapshot()).toMatchObject({ state: "failed", failureCode: "HOST_START_FAILED" });
    expect(JSON.stringify(host.snapshot())).not.toContain("worker-factory-secret");
  });

  test("worker factory 返回部分句柄时仍有界关闭已创建资源", async () => {
    const stop = vi.fn(async () => ({ status: "stopped" as const }));
    const worker = { stop } as unknown as DurableJobV2WorkerLoopHandle;
    const options = hostOptions([{ name: "db", start: async () => {} }], worker);
    const host = new RuntimeHost(options);

    await expect(host.start()).rejects.toEqual(new RuntimeHostError("HOST_START_FAILED"));

    expect(stop).toHaveBeenCalledTimes(1);
    expect(host.snapshot()).toMatchObject({ state: "failed", failureCode: "HOST_START_FAILED" });
  });

  test("部分 worker 句柄 stop 超时后保留同一清理所有权，迟到完成可由显式 stop 收口", async () => {
    const scheduler = new ManualScheduler();
    const cleanup = deferred<{ status: "stopped" }>();
    const partialStop = vi.fn(() => cleanup.promise);
    const options = hostOptions(
      [{ name: "db", start: async () => {} }],
      { stop: partialStop } as unknown as DurableJobV2WorkerLoopHandle,
      scheduler,
    );
    const host = new RuntimeHost(options);

    const starting = host.start();
    await flush();
    expect(partialStop).toHaveBeenCalledTimes(1);
    scheduler.fireAll();
    await expect(starting).rejects.toEqual(new RuntimeHostError("HOST_STOP_FAILED"));
    expect(host.snapshot()).toMatchObject({ state: "failed", failureCode: "HOST_STOP_FAILED" });

    cleanup.resolve({ status: "stopped" });
    await flush();
    await host.stop();
    expect(partialStop).toHaveBeenCalledTimes(1);
    expect(scheduler.pending).toBe(0);
    expect(host.snapshot()).toMatchObject({ state: "stopped" });
    expect(host.snapshot()).not.toHaveProperty("failureCode");
  });

  test("部分 worker 句柄 stop 拒绝时固定报告 HOST_STOP_FAILED 且不会重复调用清理", async () => {
    const partialStop = vi.fn(async () => { throw new Error("worker-cleanup-secret"); });
    const options = hostOptions(
      [{ name: "db", start: async () => {} }],
      { stop: partialStop } as unknown as DurableJobV2WorkerLoopHandle,
    );
    const host = new RuntimeHost(options);

    await expect(host.start()).rejects.toEqual(new RuntimeHostError("HOST_STOP_FAILED"));
    await expect(host.stop()).rejects.toEqual(new RuntimeHostError("HOST_STOP_FAILED"));

    expect(partialStop).toHaveBeenCalledTimes(1);
    expect(host.snapshot()).toMatchObject({ state: "failed", failureCode: "HOST_STOP_FAILED" });
    expect(JSON.stringify(host.snapshot())).not.toContain("worker-cleanup-secret");
  });

  test("stop 先同步停止接单，再有界 drain worker，最后逆序关闭依赖", async () => {
    const calls: string[] = [];
    const workerStop = deferred<{ status: "stopped" }>();
    const worker = fakeWorker({
      stop: vi.fn(async (options) => {
        calls.push(`worker:stop:${options?.timeoutMs}`);
        return workerStop.promise;
      }),
    });
    const host = new RuntimeHost(hostOptions([
      {
        name: "db",
        start: async () => { calls.push("db:start"); },
        stop: async () => { calls.push("db:stop"); },
      },
      {
        name: "tree",
        start: async () => { calls.push("tree:start"); },
        stop: async () => { calls.push("tree:stop"); },
      },
    ], worker));
    await host.start();
    calls.length = 0;

    const stopping = host.stop();
    expect(host.snapshot()).toMatchObject({ state: "stopping", accepting: false, ready: false });
    await flush();
    expect(calls).toEqual(["worker:stop:200"]);
    workerStop.resolve({ status: "stopped" });
    await stopping;

    expect(calls).toEqual(["worker:stop:200", "tree:stop", "db:stop"]);
    expect(host.snapshot()).toEqual({ state: "stopped", ready: false, accepting: false, generation: 1 });
  });

  test("worker stop 超时或不协作时仍关闭所有依赖，并以脱敏失败收口", async () => {
    const scheduler = new ManualScheduler();
    const calls: string[] = [];
    const worker = fakeWorker({
      stop: vi.fn(() => new Promise<{ status: "stopped" }>(() => undefined)),
    });
    const host = new RuntimeHost(hostOptions([
      {
        name: "db",
        start: async () => {},
        stop: async () => { calls.push("db:stop"); },
      },
      {
        name: "tree",
        start: async () => {},
        stop: async () => { calls.push("tree:stop"); },
      },
    ], worker, scheduler));
    await host.start();

    const stopping = host.stop();
    await flush();
    scheduler.fireAll();
    await expect(stopping).rejects.toMatchObject({ code: "HOST_STOP_FAILED" });

    expect(calls).toEqual(["tree:stop", "db:stop"]);
    expect(host.snapshot()).toEqual({
      state: "failed",
      ready: false,
      accepting: false,
      generation: 1,
      failureCode: "HOST_STOP_FAILED",
    });
  });

  test("并发 double stop 共享同一 Promise 且每个资源只关闭一次", async () => {
    const dependencyStop = vi.fn(async () => {});
    const worker = fakeWorker();
    const host = new RuntimeHost(hostOptions([
      { name: "db", start: async () => {}, stop: dependencyStop },
    ], worker));
    await host.start();

    const stops = [host.stop(), host.stop(), host.stop()];
    expect(stops[0]).toBe(stops[1]);
    expect(stops[1]).toBe(stops[2]);
    await Promise.all(stops);

    expect(worker.stop).toHaveBeenCalledTimes(1);
    expect(dependencyStop).toHaveBeenCalledTimes(1);
  });

  test("stop during start fail-closed，start-during-stop 明确拒绝且只回滚一次", async () => {
    const init = deferred();
    const dependencyStop = vi.fn(async () => {});
    const worker = fakeWorker();
    const options = hostOptions([
      { name: "db", start: () => init.promise, stop: dependencyStop },
    ], worker);
    const host = new RuntimeHost(options);

    const starting = host.start();
    await flush();
    const stopping = host.stop();
    expect(host.snapshot()).toMatchObject({ state: "stopping", ready: false, accepting: false });
    await expect(host.start()).rejects.toMatchObject({ code: "HOST_STOPPING" });

    init.resolve();
    await expect(starting).rejects.toMatchObject({ code: "HOST_STOPPING" });
    await stopping;
    expect(options.startWorker).not.toHaveBeenCalled();
    expect(dependencyStop).toHaveBeenCalledTimes(1);
    expect(host.snapshot()).toMatchObject({ state: "stopped", ready: false, accepting: false });
  });

  test("完成 stop 后可新建 lifecycle 安全 restart，代次递增", async () => {
    const start = vi.fn(async () => {});
    const stop = vi.fn(async () => {});
    const worker = fakeWorker();
    const options = hostOptions([{ name: "db", start, stop }], worker);
    const host = new RuntimeHost(options);

    await host.start();
    await host.stop();
    await host.start();

    expect(start).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(options.startWorker).toHaveBeenCalledTimes(2);
    expect(host.snapshot()).toMatchObject({ state: "ready", ready: true, accepting: true, generation: 2 });
    await host.stop();
    expect(stop).toHaveBeenCalledTimes(2);
  });

  test("非法配置 fail-fast 且不会泄露配置内容", () => {
    const worker = fakeWorker();

    expect(() => new RuntimeHost({
      ...hostOptions([{ name: "bad secret=value", start: async () => {} }], worker),
      workerStopTimeoutMs: 0,
    })).toThrow(RuntimeHostError);
  });
});
