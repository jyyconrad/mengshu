import { describe, expect, test, vi } from "vitest";

import {
  RuntimeLifecycle,
  RuntimeLifecycleError,
  type RuntimeLifecycleStep,
} from "./runtime-lifecycle.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("RuntimeLifecycle", () => {
  test("10 个并发 start 共享一次有序初始化", async () => {
    const calls: string[] = [];
    const lifecycle = new RuntimeLifecycle([
      { name: "db", start: vi.fn(async () => { calls.push("db:start"); }) },
      { name: "registry", start: vi.fn(async () => { calls.push("registry:start"); }) },
      { name: "tree", start: vi.fn(async () => { calls.push("tree:start"); }) },
    ]);

    await Promise.all(Array.from({ length: 10 }, () => lifecycle.start()));

    expect(calls).toEqual(["db:start", "registry:start", "tree:start"]);
    expect(lifecycle.snapshot()).toEqual({ state: "ready", ready: true });
  });

  test("ready 仅在所有步骤完成后为 true", async () => {
    const tree = deferred();
    const lifecycle = new RuntimeLifecycle([
      { name: "db", start: async () => {} },
      { name: "registry", start: async () => {} },
      { name: "tree", start: () => tree.promise },
    ]);

    const starting = lifecycle.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(lifecycle.snapshot()).toEqual({ state: "starting", ready: false });
    tree.resolve();
    await starting;
    expect(lifecycle.snapshot()).toEqual({ state: "ready", ready: true });
  });

  test("可诊断降级步骤允许 start 完成，但绝不报告 ready", async () => {
    const stop = vi.fn(async () => {});
    const lifecycle = new RuntimeLifecycle([
      { name: "db", start: async () => {}, stop },
      {
        name: "registry",
        start: async () => ({ ready: false, reason: "registry-unavailable" }),
      },
    ]);

    await lifecycle.start();

    expect(lifecycle.snapshot()).toEqual({
      state: "degraded",
      ready: false,
      degradedSteps: [{ name: "registry", reason: "registry-unavailable" }],
    });
    await lifecycle.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test("tree 启动失败时按逆序回滚已启动步骤，且不 ready", async () => {
    const calls: string[] = [];
    const failure = new Error("tree startup failed");
    const lifecycle = new RuntimeLifecycle([
      {
        name: "db",
        start: async () => { calls.push("db:start"); },
        stop: async () => { calls.push("db:stop"); },
      },
      { name: "registry", start: async () => { calls.push("registry:start"); } },
      {
        name: "tree",
        start: async () => {
          calls.push("tree:start");
          throw failure;
        },
      },
    ]);

    await expect(lifecycle.start()).rejects.toBe(failure);
    expect(calls).toEqual(["db:start", "registry:start", "tree:start", "db:stop"]);
    expect(lifecycle.snapshot()).toMatchObject({ state: "failed", ready: false, failure });
    await lifecycle.stop();
    expect(lifecycle.snapshot()).toEqual({ state: "stopped", ready: false });
  });

  test("stop during start 立即进入 stopping，当前/后续 start 均不得假成功", async () => {
    const tree = deferred();
    const calls: string[] = [];
    const lifecycle = new RuntimeLifecycle([
      {
        name: "db",
        start: async () => { calls.push("db:start"); },
        stop: async () => { calls.push("db:stop"); },
      },
      {
        name: "tree",
        start: async () => { calls.push("tree:start"); await tree.promise; },
        stop: async () => { calls.push("tree:stop"); },
      },
    ]);

    const starting = lifecycle.start();
    await Promise.resolve();
    const stopping = lifecycle.stop();
    await Promise.resolve();
    expect(lifecycle.snapshot()).toEqual({ state: "stopping", ready: false });
    await expect(lifecycle.start()).rejects.toMatchObject({ code: "RUNTIME_STOPPING" });
    expect(calls).not.toContain("db:stop");

    tree.resolve();
    await expect(starting).rejects.toMatchObject({ code: "RUNTIME_STOPPING" });
    await stopping;
    expect(calls).toEqual(["db:start", "tree:start", "tree:stop", "db:stop"]);
    expect(lifecycle.snapshot()).toEqual({ state: "stopped", ready: false });
  });

  test("stop during degraded start 不短暂发布 degraded，并只清理一次", async () => {
    const tree = deferred();
    const dbStop = vi.fn(async () => {});
    const registryStop = vi.fn(async () => {});
    const treeStop = vi.fn(async () => {});
    const lifecycle = new RuntimeLifecycle([
      { name: "db", start: async () => {}, stop: dbStop },
      {
        name: "registry",
        start: async () => ({ ready: false as const, reason: "registry-missing" }),
        stop: registryStop,
      },
      { name: "tree", start: () => tree.promise, stop: treeStop },
    ]);

    const starting = lifecycle.start();
    await Promise.resolve();
    await Promise.resolve();
    const stopping = lifecycle.stop();
    tree.resolve();

    await expect(starting).rejects.toMatchObject({ code: "RUNTIME_STOPPING" });
    await stopping;
    expect(lifecycle.snapshot()).toEqual({ state: "stopped", ready: false });
    expect(treeStop).toHaveBeenCalledTimes(1);
    expect(registryStop).toHaveBeenCalledTimes(1);
    expect(dbStop).toHaveBeenCalledTimes(1);
  });

  test("重复和并发 stop 只关闭一次", async () => {
    const stop = vi.fn(async () => {});
    const lifecycle = new RuntimeLifecycle([{ name: "db", start: async () => {}, stop }]);
    await lifecycle.start();

    await Promise.all([lifecycle.stop(), lifecycle.stop(), lifecycle.stop()]);
    await lifecycle.stop();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(lifecycle.snapshot()).toEqual({ state: "stopped", ready: false });
  });

  test("stopped 实例不可 restart，并返回明确错误码", async () => {
    const lifecycle = new RuntimeLifecycle([{ name: "db", start: async () => {}, stop: async () => {} }]);
    await lifecycle.start();
    await lifecycle.stop();

    await expect(lifecycle.start()).rejects.toMatchObject({
      name: "RuntimeLifecycleError",
      code: "RUNTIME_STOPPED",
    });
  });

  test("并发 start failure 共享同一失败对象且不重复初始化", async () => {
    const gate = deferred();
    const failure = new Error("shared startup failure");
    const start = vi.fn(async () => {
      await gate.promise;
      throw failure;
    });
    const lifecycle = new RuntimeLifecycle([{ name: "db", start }]);

    const attempts = Array.from({ length: 10 }, () => lifecycle.start().catch((error) => error));
    gate.resolve();
    const reasons = await Promise.all(attempts);

    expect(start).toHaveBeenCalledTimes(1);
    expect(reasons.every((reason) => reason === failure)).toBe(true);
    await expect(lifecycle.start()).rejects.toBe(failure);
  });

  test("stop 聚合所有关闭错误、继续逆序关闭并保持 failed 真实状态", async () => {
    const calls: string[] = [];
    const dbFailure = new Error("db stop failed");
    const treeFailure = new Error("tree stop failed");
    const steps: RuntimeLifecycleStep[] = [
      {
        name: "db",
        start: async () => {},
        stop: async () => { calls.push("db:stop"); throw dbFailure; },
      },
      {
        name: "tree",
        start: async () => {},
        stop: async () => { calls.push("tree:stop"); throw treeFailure; },
      },
    ];
    const lifecycle = new RuntimeLifecycle(steps);
    await lifecycle.start();

    const first = lifecycle.stop().catch((error) => error);
    const second = lifecycle.stop().catch((error) => error);
    const [firstError, secondError] = await Promise.all([first, second]);

    expect(firstError).toBe(secondError);
    expect(firstError).toBeInstanceOf(AggregateError);
    expect((firstError as AggregateError).errors).toEqual([treeFailure, dbFailure]);
    expect(calls).toEqual(["tree:stop", "db:stop"]);
    expect(lifecycle.snapshot()).toMatchObject({ state: "failed", ready: false, failure: firstError });
    await expect(lifecycle.stop()).rejects.toBe(firstError);
  });

  test("startup failure 与 rollback failure 聚合，后续 stop 不伪报 stopped", async () => {
    const startupFailure = new Error("tree startup failed");
    const rollbackFailure = new Error("db rollback failed");
    const lifecycle = new RuntimeLifecycle([
      {
        name: "db",
        start: async () => {},
        stop: async () => { throw rollbackFailure; },
      },
      { name: "tree", start: async () => { throw startupFailure; } },
    ]);

    const failure = await lifecycle.start().catch((error) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([startupFailure, rollbackFailure]);
    expect(lifecycle.snapshot()).toMatchObject({ state: "failed", ready: false, failure });
    await expect(lifecycle.stop()).rejects.toBe(failure);
    expect(lifecycle.snapshot()).toMatchObject({ state: "failed", ready: false, failure });
  });

  test("stopping 期间拒绝 start，并返回明确错误码", async () => {
    const release = deferred();
    const lifecycle = new RuntimeLifecycle([{
      name: "db",
      start: async () => {},
      stop: () => release.promise,
    }]);
    await lifecycle.start();
    const stopping = lifecycle.stop();
    await Promise.resolve();

    await expect(lifecycle.start()).rejects.toMatchObject({ code: "RUNTIME_STOPPING" });
    release.resolve();
    await stopping;
  });

  test("stop before start 直接进入 stopped 且不启动资源", async () => {
    const start = vi.fn(async () => {});
    const lifecycle = new RuntimeLifecycle([{ name: "db", start }]);

    await lifecycle.stop();

    expect(start).not.toHaveBeenCalled();
    expect(lifecycle.snapshot()).toEqual({ state: "stopped", ready: false });
    await expect(lifecycle.start()).rejects.toBeInstanceOf(RuntimeLifecycleError);
  });
});
