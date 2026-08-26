import { afterEach, describe, expect, test, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { MemoryService } from "../core/service-types.js";
import type { ContextBlock, MemoryRecord, RecallResult } from "../core/types.js";
import { computeRecallScoreBreakdown } from "../core/recall-scoring.js";
import type { JobRecord, JobRepository } from "../storage/repositories/types.js";
import {
  MemoryServerDaemonError,
  createMemoryServerDaemon,
  startMemoryServer,
  type MemoryServerLifecycleHost,
  type MemoryServerLifecycleScheduler,
  type MemoryServerListener,
  type RunningMemoryServer,
} from "./daemon.js";

const scope = {
  tenantId: "local",
  appId: "openclaw",
  userId: "user-1",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "memories",
  visibility: "private" as const,
};

const record: MemoryRecord = {
  id: "mem-1",
  scope,
  kind: "preference",
  text: "User prefers concise replies",
  contentHash: "hash-1",
  importance: 0.8,
  category: "preference",
  dataType: "memory",
  tableName: "memories",
  metadata: {},
  provenance: {},
  createdAt: 1710000000000,
};

class FakeMemoryService implements MemoryService {
  async storeMemory() {
    return { id: "mem-1", stored: true };
  }

  async recall(): Promise<RecallResult> {
    const scoreBreakdown = computeRecallScoreBreakdown(
      record,
      { relevance: 0.9, scopeFit: 1 },
      ["vector"],
      { vector: 0.9 },
    );
    return {
      scope,
      query: "concise",
      hits: [{ record, score: scoreBreakdown.score, source: "vector", scoreBreakdown }],
    };
  }

  async buildContext(): Promise<ContextBlock> {
    return { scope, content: "safe", hits: [], tokenEstimate: 1 };
  }

  async delete() {
    return { deleted: 0 };
  }

  async health() {
    return { ok: true, records: 1 };
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeLifecycleHost implements MemoryServerLifecycleHost {
  state: "created" | "starting" | "ready" | "degraded" | "stopping" | "stopped" | "failed" = "created";
  ready = false;
  generation = 1;

  constructor(private readonly calls: string[] = []) {}

  start = vi.fn(async () => {
    this.calls.push("host:start");
    this.state = "ready";
    this.ready = true;
  });

  stop = vi.fn(async () => {
    this.calls.push("host:stop");
    this.state = "stopped";
    this.ready = false;
  });

  snapshot() {
    return { state: this.state, ready: this.ready, accepting: this.ready, generation: this.generation };
  }
}

class FakeListener implements MemoryServerListener {
  listening = false;
  closeCalls = 0;
  onListen?: () => void;
  listenFailure?: Error;
  closeFailure?: Error;
  suppressListenSettlement = false;
  deferListeningUntilCallback = false;
  deferCloseSettlement = false;
  listenErrorIsTerminal = false;
  throwListenFailure?: Error;
  private listenCallback?: () => void;
  private closeCallback?: (error?: Error) => void;
  private errorListener?: (error: unknown) => void;

  constructor(private readonly calls: string[] = []) {}

  once(event: "error", listener: (error: unknown) => void): this {
    if (event === "error") this.errorListener = listener;
    return this;
  }

  off(event: "error", listener: (error: unknown) => void): this {
    if (event === "error" && this.errorListener === listener) this.errorListener = undefined;
    return this;
  }

  listen(_port: number, _host: string, callback: () => void): this {
    this.calls.push("listener:listen");
    if (this.throwListenFailure) throw this.throwListenFailure;
    this.listenCallback = callback;
    this.listening = !this.deferListeningUntilCallback;
    this.onListen?.();
    if (this.listenFailure) {
      const failure = this.listenFailure;
      queueMicrotask(() => this.errorListener?.(failure));
    } else if (!this.suppressListenSettlement) {
      queueMicrotask(callback);
    }
    return this;
  }

  completeLateBind(): void {
    this.listening = true;
    this.listenCallback?.();
  }

  emitError(error: Error): void {
    const listener = this.errorListener;
    this.errorListener = undefined;
    listener?.(error);
  }

  completeClose(error = this.closeFailure): void {
    const callback = this.closeCallback;
    this.closeCallback = undefined;
    callback?.(error);
  }

  address(): AddressInfo | string | null {
    return { address: "127.0.0.1", family: "IPv4", port: 43847 };
  }

  close(callback?: (error?: Error) => void): this {
    this.calls.push("listener:close");
    this.closeCalls += 1;
    this.listening = false;
    if (this.deferCloseSettlement) {
      this.closeCallback = callback;
    } else {
      queueMicrotask(() => callback?.(this.closeFailure));
    }
    return this;
  }
}

class ManualLifecycleScheduler implements MemoryServerLifecycleScheduler {
  private nextId = 1;
  private callbacks = new Map<number, () => void>();

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
    callbacks.forEach((callback) => callback());
  }

  get pending(): number {
    return this.callbacks.size;
  }
}

function daemonOptions(host: FakeLifecycleHost, listener: FakeListener) {
  return {
    service: new FakeMemoryService(),
    defaultScope: { ...scope, visibility: "private" as const },
    host: "127.0.0.1",
    port: 0,
    runtimeHost: host,
    listenerFactory: vi.fn(() => listener),
  };
}

describe("memory server daemon", () => {
  test("runtimeHost 与 legacy worker 配置互斥且在构造 listener/启动 Host 前拒绝", async () => {
    const host = new FakeLifecycleHost();
    const listener = new FakeListener();
    const listenerFactory = vi.fn(() => listener);
    const daemon = createMemoryServerDaemon({
      ...daemonOptions(host, listener),
      listenerFactory,
      worker: {
        jobs: {} as JobRepository,
        leaseMs: 100,
        intervalMs: 10,
        handlers: {},
      },
    });

    await expect(daemon.start()).rejects.toEqual(new MemoryServerDaemonError("DAEMON_START_FAILED"));

    expect(listenerFactory).not.toHaveBeenCalled();
    expect(host.start).not.toHaveBeenCalled();
    expect(daemon.snapshot()).toMatchObject({
      state: "failed",
      ready: false,
      accepting: false,
      mode: "runtime_host",
      failureCode: "DAEMON_START_FAILED",
    });
  });

  test("Host generation 缺失或非法时在启动 Host/listener 前 fail-closed", async () => {
    for (const generation of [undefined, 0, -1, Number.NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const host = {
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
        snapshot: vi.fn(() => ({
          state: "created",
          ready: false,
          accepting: false,
          ...(generation === undefined ? {} : { generation }),
        })),
      } as unknown as MemoryServerLifecycleHost;
      const listenerFactory = vi.fn(() => new FakeListener());
      const daemon = createMemoryServerDaemon({
        service: new FakeMemoryService(),
        defaultScope: { ...scope, visibility: "private" },
        runtimeHost: host,
        listenerFactory,
      });

      await expect(daemon.start()).rejects.toEqual(new MemoryServerDaemonError("DAEMON_HOST_NOT_READY"));

      expect(host.start).not.toHaveBeenCalled();
      expect(host.stop).not.toHaveBeenCalled();
      expect(listenerFactory).not.toHaveBeenCalled();
    }
  });

  test("rejects startup without server authority or defaultScope", async () => {
    await expect(startMemoryServer({
      service: new FakeMemoryService(),
      host: "127.0.0.1",
      port: 0,
    })).rejects.toThrow(/authority or server-owned defaultScope is required/);
  });

  let running: RunningMemoryServer | undefined;

  afterEach(async () => {
    await running?.stop();
    running = undefined;
  });

  test("serves REST responses over node:http", async () => {
    running = await startMemoryServer({
      service: new FakeMemoryService(),
      defaultScope: { ...scope, visibility: "private" },
      host: "127.0.0.1",
      port: 0,
    });

    const health = await fetch(`${running.url}/v1/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ ok: true, records: 1 });

    const recall = await fetch(`${running.url}/v1/recall`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "concise" }),
    });
    expect(recall.status).toBe(200);
    expect(await recall.json()).toMatchObject({ query: "concise" });
    expect(running.snapshot()).toEqual({
      state: "ready",
      ready: true,
      accepting: true,
      mode: "legacy",
    });
  });

  test("routes production memory writes through the injected Runtime Write Kernel capability", async () => {
    const executeMemoryWrite = vi.fn(async () => ({
      status: "persisted" as const,
      route: "active" as const,
      recordType: "memory" as const,
      memoryId: "memory-write-1",
      stored: true,
    }));
    running = await startMemoryServer({
      service: new FakeMemoryService(),
      memoryWrite: { executeMemoryWrite },
      defaultScope: { ...scope, visibility: "private" },
      host: "127.0.0.1",
      port: 0,
    });

    const response = await fetch(`${running.url}/v1/memories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "daemon-save-explicit-1",
        record: {
          text: "默认使用 TypeScript 严格模式进行开发",
          kind: "preference",
          semanticType: "profile",
          scope,
        },
      }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      id: "memory-write-1",
      stored: true,
      status: "persisted",
      route: "active",
      recordType: "memory",
    });
    expect(executeMemoryWrite).toHaveBeenCalledWith(expect.objectContaining({
      type: "saveExplicit",
      idempotencyKey: "daemon-save-explicit-1",
      serverAuthority: expect.objectContaining({ tenantId: "local", userId: "user-1" }),
      clientScope: scope,
      text: "默认使用 TypeScript 严格模式进行开发",
      kind: "preference",
      semanticType: "profile",
    }));
  });

  test("keeps production memory writes fail-closed when Runtime Write Kernel is absent", async () => {
    const service = new FakeMemoryService();
    const storeMemory = vi.spyOn(service, "storeMemory");
    running = await startMemoryServer({
      service,
      defaultScope: { ...scope, visibility: "private" },
      host: "127.0.0.1",
      port: 0,
    });

    const response = await fetch(`${running.url}/v1/memories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "daemon-save-explicit-without-capability",
        record: { text: "必须保持生产写入 fail-closed", kind: "decision", scope },
      }),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Memory write capability is unavailable",
    });
    expect(storeMemory).not.toHaveBeenCalled();
  });

  test("returns JSON bad request for malformed JSON", async () => {
    running = await startMemoryServer({
      service: new FakeMemoryService(),
      defaultScope: { ...scope, visibility: "private" },
      host: "127.0.0.1",
      port: 0,
    });

    const response = await fetch(`${running.url}/v1/recall`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid JSON body" });
  });

  test("await Host ready 后才 bind listener，并报告固定 ready 状态", async () => {
    const calls: string[] = [];
    const host = new FakeLifecycleHost(calls);
    const listener = new FakeListener(calls);
    const daemon = createMemoryServerDaemon(daemonOptions(host, listener));

    const server = await daemon.start();

    expect(calls).toEqual(["host:start", "listener:listen"]);
    expect(host.start).toHaveBeenCalledTimes(1);
    expect(daemon.snapshot()).toEqual({
      state: "ready",
      ready: true,
      accepting: true,
      mode: "runtime_host",
    });
    expect(server.url).toBe("http://127.0.0.1:43847");
    await daemon.stop();
  });

  test("运行中的 Host readiness 降级会立即反映到 daemon snapshot", async () => {
    const host = new FakeLifecycleHost();
    const listener = new FakeListener();
    const daemon = createMemoryServerDaemon(daemonOptions(host, listener));
    await daemon.start();

    host.state = "degraded";
    host.ready = false;
    expect(daemon.snapshot()).toEqual({
      state: "ready",
      ready: false,
      accepting: false,
      mode: "runtime_host",
    });

    host.state = "ready";
    host.ready = true;
    expect(daemon.snapshot()).toEqual({
      state: "ready",
      ready: true,
      accepting: true,
      mode: "runtime_host",
    });
    await daemon.stop();
  });

  test("Host degraded/failed 时不开放 listener，启动失败会回滚 Host 且不泄密", async () => {
    for (const state of ["degraded", "failed"] as const) {
      const host = new FakeLifecycleHost();
      host.start.mockImplementation(async () => {
        host.state = state;
        host.ready = false;
        if (state === "failed") throw new Error("postgres-password-secret");
      });
      const listener = new FakeListener();
      const listenerFactory = vi.fn(() => listener);
      const daemon = createMemoryServerDaemon({
        ...daemonOptions(host, listener),
        listenerFactory,
      });

      await expect(daemon.start()).rejects.toEqual(new MemoryServerDaemonError("DAEMON_HOST_NOT_READY"));

      expect(listener.listening).toBe(false);
      expect(listener.closeCalls).toBe(0);
      expect(listenerFactory).not.toHaveBeenCalled();
      expect(host.stop).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(daemon.snapshot())).not.toContain("postgres-password-secret");
    }
  });

  test("Host 虽标记 ready 但 accepting=false 时不开放 listener", async () => {
    const host = new FakeLifecycleHost();
    host.snapshot = vi.fn(() => ({
      state: "ready" as const,
      ready: true,
      accepting: false,
      generation: host.generation,
    }));
    const listener = new FakeListener();
    const daemon = createMemoryServerDaemon(daemonOptions(host, listener));

    await expect(daemon.start()).rejects.toEqual(new MemoryServerDaemonError("DAEMON_HOST_NOT_READY"));

    expect(listener.onListen).toBeUndefined();
    expect(listener.listening).toBe(false);
    expect(host.stop).toHaveBeenCalledTimes(1);
  });

  test("Host start 后 generation 变为 0/2、snapshot 或 generation getter 抛错时均不 bind 且不误停未知代次", async () => {
    for (const mode of ["zero", "changed", "snapshot-throw", "getter-throw"] as const) {
      const calls: string[] = [];
      const host = new FakeLifecycleHost(calls);
      let snapshotCalls = 0;
      host.start.mockImplementation(async () => {
        calls.push("host:start");
        host.state = "ready";
        host.ready = true;
        if (mode === "zero") host.generation = 0;
        if (mode === "changed") host.generation = 2;
      });
      if (mode === "snapshot-throw") {
        host.snapshot = vi.fn(() => {
          snapshotCalls += 1;
          if (snapshotCalls > 1) throw new Error("post-start-snapshot-secret");
          return {
            state: host.state,
            ready: host.ready,
            accepting: host.ready,
            generation: host.generation,
          };
        });
      }
      if (mode === "getter-throw") {
        host.snapshot = vi.fn(() => {
          snapshotCalls += 1;
          if (snapshotCalls === 1) {
            return {
              state: host.state,
              ready: host.ready,
              accepting: host.ready,
              generation: host.generation,
            };
          }
          return {
            state: host.state,
            ready: host.ready,
            accepting: host.ready,
            get generation(): number { throw new Error("generation-getter-secret"); },
          };
        });
      }
      const listener = new FakeListener(calls);
      const daemon = createMemoryServerDaemon(daemonOptions(host, listener));

      await expect(daemon.start()).rejects.toEqual(new MemoryServerDaemonError("DAEMON_STOP_FAILED"));

      expect(calls).toEqual(["host:start"]);
      expect(host.stop).not.toHaveBeenCalled();
      await expect(daemon.stop()).rejects.toEqual(new MemoryServerDaemonError("DAEMON_STOP_FAILED"));
      expect(daemon.snapshot()).toMatchObject({
        state: "failed",
        accepting: false,
        failureCode: "DAEMON_STOP_FAILED",
      });
    }
  });

  test("Host snapshot accessor 不能用 generation 2→1/1→2 拼接合法状态，关键字段 getter 均不执行", async () => {
    for (const mode of [
      "generation-2-to-1",
      "generation-1-to-2",
      "state-getter",
      "ready-getter",
      "accepting-getter",
    ] as const) {
      const calls: string[] = [];
      const host = new FakeLifecycleHost(calls);
      let snapshotCalls = 0;
      let getterReads = 0;
      host.start.mockImplementation(async () => {
        calls.push("host:start");
        host.state = "ready";
        host.ready = true;
      });
      host.snapshot = vi.fn(() => {
        snapshotCalls += 1;
        if (snapshotCalls === 1) {
          return {
            state: "created" as const,
            ready: false,
            accepting: false,
            generation: 1,
          };
        }
        const snapshot: Record<string, unknown> = {
          state: "ready",
          ready: true,
          accepting: true,
          generation: 1,
        };
        const field = mode.startsWith("generation")
          ? "generation"
          : mode.replace("-getter", "");
        const sequence = mode === "generation-2-to-1" ? [2, 1] : [1, 2];
        Object.defineProperty(snapshot, field, {
          enumerable: true,
          configurable: true,
          get: () => {
            const value = field === "generation"
              ? sequence[Math.min(getterReads, sequence.length - 1)]
              : snapshotCalls > 0
                ? field === "state" ? "ready" : true
                : undefined;
            getterReads += 1;
            return value;
          },
        });
        return snapshot as ReturnType<FakeLifecycleHost["snapshot"]>;
      });
      const listener = new FakeListener(calls);
      const daemon = createMemoryServerDaemon(daemonOptions(host, listener));

      await expect(daemon.start()).rejects.toEqual(new MemoryServerDaemonError("DAEMON_STOP_FAILED"));

      expect(getterReads).toBe(0);
      expect(calls).toEqual(["host:start"]);
      expect(listener.listening).toBe(false);
      expect(host.stop).not.toHaveBeenCalled();
    }
  });

  test("Host snapshot exact data shape 兼容 frozen/null-prototype 对象", async () => {
    for (const mode of ["frozen", "null-prototype"] as const) {
      const host = new FakeLifecycleHost();
      host.snapshot = vi.fn(() => {
        const values = {
          state: host.state,
          ready: host.ready,
          accepting: host.ready,
          generation: host.generation,
        };
        return (mode === "frozen"
          ? Object.freeze(values)
          : Object.assign(Object.create(null), values)) as ReturnType<FakeLifecycleHost["snapshot"]>;
      });
      const listener = new FakeListener();
      const daemon = createMemoryServerDaemon(daemonOptions(host, listener));

      await daemon.start();
      expect(daemon.snapshot()).toMatchObject({ state: "ready", accepting: true });
      await daemon.stop();
      expect(daemon.snapshot()).toMatchObject({ state: "stopped", accepting: false });
    }
  });

  test("Host post-start snapshot extra/symbol/non-enumerable/accessor 字段均 fail-closed 且 getter 零执行", async () => {
    for (const mode of ["extra", "symbol", "non-enumerable", "accessor"] as const) {
      const calls: string[] = [];
      const host = new FakeLifecycleHost(calls);
      let snapshotCalls = 0;
      let getterReads = 0;
      host.start.mockImplementation(async () => {
        calls.push("host:start");
        host.state = "ready";
        host.ready = true;
      });
      host.snapshot = vi.fn(() => {
        snapshotCalls += 1;
        const snapshot: Record<PropertyKey, unknown> = {
          state: snapshotCalls === 1 ? "created" : "ready",
          ready: snapshotCalls > 1,
          accepting: snapshotCalls > 1,
          generation: 1,
        };
        if (snapshotCalls > 1) {
          if (mode === "extra") snapshot.extra = true;
          if (mode === "symbol") snapshot[Symbol("extra")] = true;
          if (mode === "non-enumerable") {
            Object.defineProperty(snapshot, "generation", { value: 1, enumerable: false });
          }
          if (mode === "accessor") {
            Object.defineProperty(snapshot, "generation", {
              enumerable: true,
              get: () => { getterReads += 1; return 1; },
            });
          }
        }
        return snapshot as ReturnType<FakeLifecycleHost["snapshot"]>;
      });
      const listener = new FakeListener(calls);
      const daemon = createMemoryServerDaemon(daemonOptions(host, listener));

      await expect(daemon.start()).rejects.toEqual(new MemoryServerDaemonError("DAEMON_STOP_FAILED"));

      expect(getterReads).toBe(0);
      expect(calls).toEqual(["host:start"]);
      expect(host.stop).not.toHaveBeenCalled();
      expect(listener.listening).toBe(false);
      expect(daemon.snapshot()).toMatchObject({ state: "failed", failureCode: "DAEMON_STOP_FAILED" });
    }
  });

  test("listener bind 成功后 Host 状态竞态降级时先 close listener 再 stop Host", async () => {
    const calls: string[] = [];
    const host = new FakeLifecycleHost(calls);
    const listener = new FakeListener(calls);
    listener.onListen = () => {
      host.state = "degraded";
      host.ready = false;
    };
    const daemon = createMemoryServerDaemon(daemonOptions(host, listener));

    await expect(daemon.start()).rejects.toMatchObject({ code: "DAEMON_HOST_NOT_READY" });

    expect(calls).toEqual(["host:start", "listener:listen", "listener:close", "host:stop"]);
    expect(daemon.snapshot()).toEqual({
      state: "failed",
      ready: false,
      accepting: false,
      mode: "runtime_host",
      failureCode: "DAEMON_HOST_NOT_READY",
    });
  });

  test("listener bind 后 Host generation 变化时关闭 listener，但不误停新代次", async () => {
    const calls: string[] = [];
    const host = new FakeLifecycleHost(calls);
    const listener = new FakeListener(calls);
    listener.onListen = () => {
      host.generation = 2;
      host.state = "ready";
      host.ready = true;
    };
    const daemon = createMemoryServerDaemon(daemonOptions(host, listener));

    await expect(daemon.start()).rejects.toEqual(new MemoryServerDaemonError("DAEMON_STOP_FAILED"));

    expect(calls).toEqual(["host:start", "listener:listen", "listener:close"]);
    expect(host.stop).not.toHaveBeenCalled();
    expect(listener.listening).toBe(false);
    expect(daemon.snapshot()).toMatchObject({ state: "failed", failureCode: "DAEMON_STOP_FAILED" });
  });

  test("bind 失败时回滚 listener/Host，错误固定且不泄露原始地址", async () => {
    const calls: string[] = [];
    const host = new FakeLifecycleHost(calls);
    const listener = new FakeListener(calls);
    listener.listenFailure = new Error("EADDRINUSE api-secret.internal:43847");
    const daemon = createMemoryServerDaemon(daemonOptions(host, listener));

    await expect(daemon.start()).rejects.toEqual(new MemoryServerDaemonError("DAEMON_START_FAILED"));

    expect(calls).toEqual(["host:start", "listener:listen", "listener:close", "host:stop"]);
    expect(JSON.stringify(daemon.snapshot())).not.toMatch(/api-secret|EADDRINUSE/);
  });

  test("terminal listen error 与同步 listen throw 会终结 bind ownership，后续 stop 可正常 stopped", async () => {
    for (const mode of ["terminal-error", "sync-throw"] as const) {
      const host = new FakeLifecycleHost();
      const listener = new FakeListener();
      if (mode === "terminal-error") {
        listener.listenErrorIsTerminal = true;
        listener.listenFailure = new Error("EADDRINUSE terminal-secret");
      } else {
        listener.throwListenFailure = new Error("sync-listen-secret");
      }
      const daemon = createMemoryServerDaemon(daemonOptions(host, listener));

      await expect(daemon.start()).rejects.toEqual(new MemoryServerDaemonError("DAEMON_START_FAILED"));
      await daemon.stop();

      expect(daemon.snapshot()).toMatchObject({ state: "stopped", accepting: false });
    }
  });

  test("真实 EADDRINUSE 是 terminal bind failure，start 失败后 stop 不超时误报", async () => {
    const blocker = http.createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (blocker.address() as AddressInfo).port;
    const daemon = createMemoryServerDaemon({
      service: new FakeMemoryService(),
      defaultScope: { ...scope, visibility: "private" },
      host: "127.0.0.1",
      port,
      lifecycleOperationTimeoutMs: 100,
    });
    try {
      await expect(daemon.start()).rejects.toEqual(new MemoryServerDaemonError("DAEMON_START_FAILED"));
      await daemon.stop();
      expect(daemon.snapshot()).toMatchObject({ state: "stopped", accepting: false });
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  test("并发/二次 start 共享同一初始化，不会重复启动 Host 或 listener", async () => {
    const gate = deferred();
    const host = new FakeLifecycleHost();
    host.start.mockImplementation(async () => {
      host.state = "starting";
      await gate.promise;
      host.state = "ready";
      host.ready = true;
    });
    const listener = new FakeListener();
    const daemon = createMemoryServerDaemon(daemonOptions(host, listener));

    const starts = Array.from({ length: 10 }, () => daemon.start());
    expect(starts.every((promise) => promise === starts[0])).toBe(true);
    gate.resolve();
    const servers = await Promise.all(starts);
    expect(servers.every((server) => server === servers[0])).toBe(true);
    expect(await daemon.start()).toBe(servers[0]);
    expect(host.start).toHaveBeenCalledTimes(1);
    expect(listener.listening).toBe(true);
    await daemon.stop();
  });

  test("stop 先关闭 listener 再 await Host；并发/二次 stop 幂等", async () => {
    const calls: string[] = [];
    const host = new FakeLifecycleHost(calls);
    const listener = new FakeListener(calls);
    const hostStop = deferred();
    host.stop.mockImplementation(async () => {
      calls.push("host:stop");
      await hostStop.promise;
    });
    const daemon = createMemoryServerDaemon(daemonOptions(host, listener));
    await daemon.start();
    calls.length = 0;

    const stops = [daemon.stop(), daemon.stop(), daemon.stop()];
    expect(stops[0]).toBe(stops[1]);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["listener:close"]);
    expect(daemon.snapshot()).toMatchObject({ state: "stopping", ready: false, accepting: false });
    hostStop.resolve();
    await Promise.all(stops);

    expect(calls).toEqual(["listener:close", "host:stop"]);
    expect(listener.closeCalls).toBe(1);
    expect(host.stop).toHaveBeenCalledTimes(1);
    expect(daemon.snapshot()).toEqual({
      state: "stopped",
      ready: false,
      accepting: false,
      mode: "runtime_host",
    });
    await daemon.stop();
    expect(listener.closeCalls).toBe(1);
  });

  test("Host stop timeout/reject 仍先关闭 listener，并收口为固定安全失败状态", async () => {
    const calls: string[] = [];
    const host = new FakeLifecycleHost(calls);
    const listener = new FakeListener(calls);
    const scheduler = new ManualLifecycleScheduler();
    host.stop.mockImplementation(() => {
      calls.push("host:stop");
      return new Promise<void>(() => undefined);
    });
    const daemon = createMemoryServerDaemon({
      ...daemonOptions(host, listener),
      runtimeHostStopTimeoutMs: 100,
      lifecycleScheduler: scheduler,
    });
    await daemon.start();
    calls.length = 0;

    const stopping = daemon.stop();
    for (let index = 0; index < 10 && !calls.includes("host:stop"); index += 1) {
      await Promise.resolve();
    }
    expect(calls).toEqual(["listener:close", "host:stop"]);
    scheduler.fireAll();
    await expect(stopping).rejects.toEqual(new MemoryServerDaemonError("DAEMON_STOP_FAILED"));

    expect(calls).toEqual(["listener:close", "host:stop"]);
    expect(listener.listening).toBe(false);
    expect(daemon.snapshot()).toEqual({
      state: "failed",
      ready: false,
      accepting: false,
      mode: "runtime_host",
      failureCode: "DAEMON_STOP_FAILED",
    });
  });

  test("Host start 超时后先 stop 成功，迟到 start resolve 重新 ready 时必须由第二阶段 stop 再次关闭", async () => {
    const scheduler = new ManualLifecycleScheduler();
    const lateStart = deferred();
    const calls: string[] = [];
    const host = new FakeLifecycleHost(calls);
    host.start.mockImplementation(async () => {
      calls.push("host:start");
      host.state = "starting";
      await lateStart.promise;
      host.state = "ready";
      host.ready = true;
    });
    host.stop.mockImplementation(async () => {
      calls.push("host:stop");
      host.state = "stopped";
      host.ready = false;
    });
    const listener = new FakeListener(calls);
    const daemon = createMemoryServerDaemon({
      ...daemonOptions(host, listener),
      lifecycleOperationTimeoutMs: 100,
      lifecycleScheduler: scheduler,
    });

    const starting = daemon.start();
    for (let index = 0; index < 10 && !calls.includes("host:start"); index += 1) await Promise.resolve();
    scheduler.fireAll();
    await expect(starting).rejects.toEqual(new MemoryServerDaemonError("DAEMON_HOST_NOT_READY"));
    expect(host.stop).toHaveBeenCalledTimes(1);

    lateStart.resolve();
    for (let index = 0; index < 20 && host.stop.mock.calls.length < 2; index += 1) await Promise.resolve();
    for (let index = 0; index < 20 && scheduler.pending > 0; index += 1) await Promise.resolve();

    expect(host.stop).toHaveBeenCalledTimes(2);
    expect(host.snapshot()).toMatchObject({ state: "stopped", ready: false, accepting: false });
    expect(daemon.snapshot()).toMatchObject({ state: "failed", accepting: false });
    expect(scheduler.pending).toBe(0);
  });

  test("Host raw start 未决时 stop 不得先宣告成功，必须在统一边界内固定失败", async () => {
    const lateStart = deferred();
    const host = new FakeLifecycleHost();
    host.start.mockImplementation(async () => {
      host.state = "starting";
      await lateStart.promise;
      host.state = "ready";
      host.ready = true;
    });
    const listener = new FakeListener();
    const daemon = createMemoryServerDaemon({
      ...daemonOptions(host, listener),
      lifecycleOperationTimeoutMs: 5,
    });

    await expect(daemon.start()).rejects.toEqual(new MemoryServerDaemonError("DAEMON_HOST_NOT_READY"));
    const stopping = daemon.stop();
    await expect(stopping).rejects.toEqual(new MemoryServerDaemonError("DAEMON_STOP_FAILED"));
    expect(daemon.snapshot()).toMatchObject({ state: "failed", failureCode: "DAEMON_STOP_FAILED" });

    lateStart.resolve();
    for (let index = 0; index < 30 && host.stop.mock.calls.length < 2; index += 1) await Promise.resolve();

    expect(host.stop).toHaveBeenCalledTimes(2);
    expect(host.snapshot()).toMatchObject({ state: "stopped", ready: false, accepting: false });
    await expect(daemon.stop()).rejects.toEqual(new MemoryServerDaemonError("DAEMON_STOP_FAILED"));
  });

  test("迟到 Host start 的第二阶段 stop 失败时 daemon 固定保持 DAEMON_STOP_FAILED", async () => {
    const lateStart = deferred();
    const host = new FakeLifecycleHost();
    host.start.mockImplementation(async () => {
      host.state = "starting";
      await lateStart.promise;
      host.state = "ready";
      host.ready = true;
    });
    host.stop
      .mockImplementationOnce(async () => {
        host.state = "stopped";
        host.ready = false;
      })
      .mockImplementationOnce(async () => { throw new Error("late-host-stop-secret"); });
    const listener = new FakeListener();
    const daemon = createMemoryServerDaemon({
      ...daemonOptions(host, listener),
      lifecycleOperationTimeoutMs: 5,
    });

    await expect(daemon.start()).rejects.toEqual(new MemoryServerDaemonError("DAEMON_HOST_NOT_READY"));
    const stopping = daemon.stop();
    await expect(stopping).rejects.toEqual(new MemoryServerDaemonError("DAEMON_STOP_FAILED"));
    lateStart.resolve();
    for (let index = 0; index < 20 && host.stop.mock.calls.length < 2; index += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(host.stop).toHaveBeenCalledTimes(2);
    expect(daemon.snapshot()).toMatchObject({
      state: "failed",
      accepting: false,
      failureCode: "DAEMON_STOP_FAILED",
    });
    expect(JSON.stringify(daemon.snapshot())).not.toContain("late-host-stop-secret");
    await expect(daemon.stop()).rejects.toEqual(new MemoryServerDaemonError("DAEMON_STOP_FAILED"));
  });

  test("Host generation 已被外部推进时 daemon 不误停新代次并固定 cleanup failure", async () => {
    const host = new FakeLifecycleHost();
    const listener = new FakeListener();
    const daemon = createMemoryServerDaemon(daemonOptions(host, listener));
    await daemon.start();
    host.stop.mockClear();

    host.generation += 1;
    host.state = "ready";
    host.ready = true;

    await expect(daemon.stop()).rejects.toEqual(new MemoryServerDaemonError("DAEMON_STOP_FAILED"));

    expect(host.stop).not.toHaveBeenCalled();
    expect(host.snapshot()).toMatchObject({ state: "ready", ready: true, generation: 2 });
    expect(daemon.snapshot()).toMatchObject({ state: "failed", accepting: false });
  });

  test("Host start 超时后的迟到 reject 被消费并仍执行第二阶段 stop", async () => {
    const lateStart = deferred();
    const host = new FakeLifecycleHost();
    host.start.mockImplementation(() => lateStart.promise);
    const listener = new FakeListener();
    const daemon = createMemoryServerDaemon({
      ...daemonOptions(host, listener),
      lifecycleOperationTimeoutMs: 5,
    });

    await expect(daemon.start()).rejects.toEqual(new MemoryServerDaemonError("DAEMON_HOST_NOT_READY"));
    lateStart.reject(new Error("late-host-start-secret"));
    for (let index = 0; index < 20 && host.stop.mock.calls.length < 2; index += 1) await Promise.resolve();

    expect(host.stop).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(daemon.snapshot())).not.toContain("late-host-start-secret");
  });

  test("stop during 永不决议的 Host start 仍在统一边界内固定失败", async () => {
    const host = new FakeLifecycleHost();
    host.start.mockImplementation(() => new Promise<void>(() => undefined));
    host.stop.mockImplementation(() => new Promise<void>(() => undefined));
    const listener = new FakeListener();
    const daemon = createMemoryServerDaemon({
      ...daemonOptions(host, listener),
      lifecycleOperationTimeoutMs: 5,
    });

    const starting = daemon.start();
    await Promise.resolve();
    const stopping = daemon.stop();

    await expect(stopping).rejects.toEqual(new MemoryServerDaemonError("DAEMON_STOP_FAILED"));
    await expect(starting).rejects.toMatchObject({ code: "DAEMON_STOPPING" });
    expect(listener.listening).toBe(false);
    expect(daemon.snapshot()).toMatchObject({
      state: "failed",
      mode: "runtime_host",
      failureCode: "DAEMON_STOP_FAILED",
    });
  });

  test("listener bind 永不决议时 start 有界失败并回滚 Host/listener", async () => {
    const calls: string[] = [];
    const host = new FakeLifecycleHost(calls);
    const listener = new FakeListener(calls);
    listener.suppressListenSettlement = true;
    const daemon = createMemoryServerDaemon({
      ...daemonOptions(host, listener),
      lifecycleOperationTimeoutMs: 5,
    });

    await expect(daemon.start()).rejects.toEqual(new MemoryServerDaemonError("DAEMON_START_FAILED"));

    expect(calls).toEqual(["host:start", "listener:listen", "listener:close", "host:stop"]);
    expect(daemon.snapshot()).toMatchObject({ state: "failed", failureCode: "DAEMON_START_FAILED" });
  });

  test("bind 超时时 listener 尚未 listening，迟到 bind 会被立即关闭且不能复活失败 daemon", async () => {
    const scheduler = new ManualLifecycleScheduler();
    const calls: string[] = [];
    const host = new FakeLifecycleHost(calls);
    const listener = new FakeListener(calls);
    listener.suppressListenSettlement = true;
    listener.deferListeningUntilCallback = true;
    const daemon = createMemoryServerDaemon({
      ...daemonOptions(host, listener),
      lifecycleOperationTimeoutMs: 100,
      lifecycleScheduler: scheduler,
    });

    const starting = daemon.start();
    for (let index = 0; index < 20 && !calls.includes("listener:listen"); index += 1) {
      await Promise.resolve();
    }
    expect(calls).toContain("listener:listen");
    expect(scheduler.pending).toBeGreaterThan(0);
    scheduler.fireAll();
    await expect(starting).rejects.toEqual(new MemoryServerDaemonError("DAEMON_START_FAILED"));
    expect(listener.closeCalls).toBe(0);

    const stopping = daemon.stop();
    let stopSettled = false;
    void stopping.then(
      () => { stopSettled = true; },
      () => { stopSettled = true; },
    );
    for (let index = 0; index < 50 && !stopSettled; index += 1) {
      await Promise.resolve();
      if (scheduler.pending > 0) scheduler.fireAll();
    }
    await expect(stopping).rejects.toEqual(new MemoryServerDaemonError("DAEMON_STOP_FAILED"));

    listener.completeLateBind();
    for (let index = 0; index < 20 && listener.closeCalls === 0; index += 1) {
      await Promise.resolve();
    }
    for (let index = 0; index < 10 && scheduler.pending > 0; index += 1) {
      await Promise.resolve();
    }

    expect(listener.listening).toBe(false);
    expect(listener.closeCalls).toBe(1);
    expect(scheduler.pending).toBe(0);
    expect(daemon.snapshot()).toMatchObject({ state: "failed", failureCode: "DAEMON_STOP_FAILED" });
    await expect(daemon.stop()).rejects.toEqual(new MemoryServerDaemonError("DAEMON_STOP_FAILED"));
  });

  test("late bind close 失败不能发生在已宣告 stop success 之后", async () => {
    const listener = new FakeListener();
    listener.suppressListenSettlement = true;
    listener.deferListeningUntilCallback = true;
    listener.closeFailure = new Error("late-close-secret");
    const daemon = createMemoryServerDaemon({
      service: new FakeMemoryService(),
      defaultScope: { ...scope, visibility: "private" },
      listenerFactory: () => listener,
      lifecycleOperationTimeoutMs: 5,
    });

    await expect(daemon.start()).rejects.toEqual(new MemoryServerDaemonError("DAEMON_START_FAILED"));
    await expect(daemon.stop()).rejects.toEqual(new MemoryServerDaemonError("DAEMON_STOP_FAILED"));

    listener.completeLateBind();
    for (let index = 0; index < 20 && listener.closeCalls === 0; index += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(listener.closeCalls).toBe(1);
    expect(daemon.snapshot()).toMatchObject({ state: "failed", failureCode: "DAEMON_STOP_FAILED" });
    expect(JSON.stringify(daemon.snapshot())).not.toContain("late-close-secret");
  });

  test("bind 先 error 后迟到 listening callback 仍会关闭，不因 listen promise 已 settled 而泄漏", async () => {
    const calls: string[] = [];
    const host = new FakeLifecycleHost(calls);
    const listener = new FakeListener(calls);
    listener.suppressListenSettlement = true;
    listener.deferListeningUntilCallback = true;
    const daemon = createMemoryServerDaemon(daemonOptions(host, listener));

    const starting = daemon.start();
    for (let index = 0; index < 20 && !calls.includes("listener:listen"); index += 1) {
      await Promise.resolve();
    }
    listener.emitError(new Error("bind-error-secret"));
    await expect(starting).rejects.toEqual(new MemoryServerDaemonError("DAEMON_START_FAILED"));

    listener.completeLateBind();
    for (let index = 0; index < 20 && listener.closeCalls === 0; index += 1) await Promise.resolve();

    expect(listener.closeCalls).toBe(1);
    expect(listener.listening).toBe(false);
    expect(JSON.stringify(daemon.snapshot())).not.toContain("bind-error-secret");
  });

  test("运行期 listener error 有安全处理器并触发有序停机，不会成为 uncaught error", async () => {
    const calls: string[] = [];
    const host = new FakeLifecycleHost(calls);
    const listener = new FakeListener(calls);
    listener.deferCloseSettlement = true;
    const daemon = createMemoryServerDaemon(daemonOptions(host, listener));
    await daemon.start();
    calls.length = 0;

    expect(() => listener.emitError(new Error("runtime-listener-secret"))).not.toThrow();
    const stopping = daemon.stop();
    expect(() => listener.emitError(new Error("runtime-listener-secret-2"))).not.toThrow();
    listener.completeClose();
    await stopping;

    expect(calls).toEqual(["listener:close", "host:stop"]);
    expect(daemon.snapshot()).toMatchObject({ state: "stopped", ready: false, accepting: false });
  });

  test("legacy worker handler 不决议时 stop 仍有界失败，迟到完成不产生重复关闭", async () => {
    const handlerStarted = deferred();
    const handlerGate = deferred();
    let leased = false;
    const job: JobRecord = {
      id: "job-1",
      type: "hang",
      payload: {},
      dedupeKey: "job-1",
      status: "running",
      attempts: 1,
      workerId: "memory-daemon-worker",
      leaseUntil: Date.now() + 1_000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const jobs: JobRepository = {
      enqueue: async () => job,
      lease: async () => {
        if (leased) return undefined;
        leased = true;
        return job;
      },
      complete: async () => undefined,
      fail: async () => undefined,
      list: async () => [],
    };
    const daemon = createMemoryServerDaemon({
      service: new FakeMemoryService(),
      defaultScope: { ...scope, visibility: "private" },
      host: "127.0.0.1",
      port: 0,
      lifecycleOperationTimeoutMs: 5,
      worker: {
        jobs,
        leaseMs: 100,
        intervalMs: 1,
        handlers: {
          hang: async () => {
            handlerStarted.resolve();
            await handlerGate.promise;
          },
        },
      },
    });
    const server = await daemon.start();
    await handlerStarted.promise;

    const stopping = daemon.stop();
    await expect(stopping).rejects.toEqual(new MemoryServerDaemonError("DAEMON_STOP_FAILED"));
    expect(server.server.listening).toBe(false);
    handlerGate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(daemon.stop()).rejects.toEqual(new MemoryServerDaemonError("DAEMON_STOP_FAILED"));
  });

  test("启动回滚任一资源清理失败时报告固定 stop failure 且不泄露 raw error", async () => {
    const host = new FakeLifecycleHost();
    const listener = new FakeListener();
    listener.closeFailure = new Error("listener-close-secret");
    const daemon = createMemoryServerDaemon({
      ...daemonOptions(host, listener),
      registerShutdownSignal: (() => undefined) as never,
      lifecycleOperationTimeoutMs: 20,
    });

    await expect(daemon.start()).rejects.toEqual(new MemoryServerDaemonError("DAEMON_STOP_FAILED"));

    expect(daemon.snapshot()).toMatchObject({ state: "failed", failureCode: "DAEMON_STOP_FAILED" });
    expect(JSON.stringify(daemon.snapshot())).not.toContain("listener-close-secret");
    expect(host.stop).toHaveBeenCalledTimes(1);
  });

  test("stop during start 立即 fail-closed，pending start settle 后执行第二阶段 stop、listener 永不 bind", async () => {
    const gate = deferred();
    const host = new FakeLifecycleHost();
    host.start.mockImplementation(async () => {
      host.state = "starting";
      await gate.promise;
      host.state = "stopped";
      host.ready = false;
    });
    const listener = new FakeListener();
    const daemon = createMemoryServerDaemon(daemonOptions(host, listener));

    const starting = daemon.start();
    await Promise.resolve();
    const stopping = daemon.stop();
    await expect(daemon.start()).rejects.toMatchObject({ code: "DAEMON_STOPPING" });
    gate.resolve();

    await expect(starting).rejects.toMatchObject({ code: "DAEMON_STOPPING" });
    await stopping;
    expect(listener.listening).toBe(false);
    expect(host.stop).toHaveBeenCalledTimes(2);
    expect(daemon.snapshot()).toEqual({
      state: "stopped",
      ready: false,
      accepting: false,
      mode: "runtime_host",
    });
  });

  test("注入的信号回调只触发安全 stop，不调用 process.exit", async () => {
    const calls: string[] = [];
    const host = new FakeLifecycleHost(calls);
    const listener = new FakeListener(calls);
    let shutdownHandler: (() => Promise<void>) | undefined;
    const unregister = vi.fn(() => { calls.push("signal:unregister"); });
    const options = {
      ...daemonOptions(host, listener),
      registerShutdownSignal: vi.fn((handler: () => Promise<void>) => {
        shutdownHandler = handler;
        calls.push("signal:register");
        return unregister;
      }),
    };
    const daemon = createMemoryServerDaemon(options);
    await daemon.start();
    calls.length = 0;

    await shutdownHandler?.();

    expect(calls).toEqual(["signal:unregister", "listener:close", "host:stop"]);
    expect(daemon.snapshot()).toMatchObject({ state: "stopped", ready: false });
    expect(options.registerShutdownSignal).toHaveBeenCalledTimes(1);
  });

  test("signal 注销抛错仍完成断流和 Host stop，但最终固定报告 stop failure 且只注销一次", async () => {
    const calls: string[] = [];
    const host = new FakeLifecycleHost(calls);
    const listener = new FakeListener(calls);
    const unregister = vi.fn(() => {
      calls.push("signal:unregister");
      throw new Error("signal-provider-secret");
    });
    const daemon = createMemoryServerDaemon({
      ...daemonOptions(host, listener),
      registerShutdownSignal: () => unregister,
    });
    await daemon.start();
    calls.length = 0;

    await expect(daemon.stop()).rejects.toEqual(new MemoryServerDaemonError("DAEMON_STOP_FAILED"));

    expect(calls).toEqual(["signal:unregister", "listener:close", "host:stop"]);
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(daemon.snapshot()).toMatchObject({ state: "failed", failureCode: "DAEMON_STOP_FAILED" });
  });

  test("startup rollback 与同步 signal stop 共享 cleanup 结果，迟到取得的 unregister 失败不会被 stop 丢失", async () => {
    const host = new FakeLifecycleHost();
    const listener = new FakeListener();
    const unregister = vi.fn(() => { throw new Error("late-unregister-secret"); });
    let stopping: Promise<void> | undefined;
    const daemon = createMemoryServerDaemon({
      ...daemonOptions(host, listener),
      registerShutdownSignal: (handler) => {
        stopping = handler();
        return unregister;
      },
    });

    await expect(daemon.start()).rejects.toEqual(new MemoryServerDaemonError("DAEMON_STOPPING"));
    await expect(stopping).rejects.toEqual(new MemoryServerDaemonError("DAEMON_STOP_FAILED"));

    expect(listener.closeCalls).toBe(1);
    expect(host.stop).toHaveBeenCalledTimes(1);
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(daemon.snapshot()).toMatchObject({ state: "failed", failureCode: "DAEMON_STOP_FAILED" });
  });

  test("并发 startup rollback/stop 在 close 已把 listening=false 后仍共享未决 close 结果", async () => {
    const host = new FakeLifecycleHost();
    const listener = new FakeListener();
    listener.deferCloseSettlement = true;
    let stopping: Promise<void> | undefined;
    const daemon = createMemoryServerDaemon({
      ...daemonOptions(host, listener),
      registerShutdownSignal: (handler) => {
        stopping = handler();
        return () => undefined;
      },
    });

    let startSettled = false;
    const starting = daemon.start().finally(() => { startSettled = true; });
    for (let index = 0; index < 30 && host.stop.mock.calls.length === 0; index += 1) {
      await Promise.resolve();
    }
    expect(listener.closeCalls).toBe(1);
    expect(listener.listening).toBe(false);
    expect(startSettled).toBe(false);
    expect(host.stop).not.toHaveBeenCalled();

    listener.completeClose(new Error("shared-close-secret"));
    await expect(starting).rejects.toEqual(new MemoryServerDaemonError("DAEMON_STOPPING"));
    await expect(stopping).rejects.toEqual(new MemoryServerDaemonError("DAEMON_STOP_FAILED"));

    expect(listener.closeCalls).toBe(1);
    expect(daemon.snapshot()).toMatchObject({ state: "failed", failureCode: "DAEMON_STOP_FAILED" });
  });

  test("非 JSON 请求内部错误返回固定响应，不泄露 service raw secret", async () => {
    const service = new FakeMemoryService();
    service.health = async () => { throw new Error("database-url-secret"); };
    const error = vi.fn();
    running = await startMemoryServer({
      service,
      defaultScope: { ...scope, visibility: "private" },
      host: "127.0.0.1",
      port: 0,
      logger: { error },
    });

    const response = await fetch(`${running.url}/v1/health`);
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Internal server error" });
    expect(error).toHaveBeenCalledWith(
      "REST request failed method=GET path=/v1/health error=Error",
    );
    expect(error.mock.calls.flat().join(" ")).not.toContain("database-url-secret");
  });

  test("内部错误只记录白名单诊断 reason，不写入任意错误内容", async () => {
    const service = new FakeMemoryService();
    service.health = async () => {
      const failure = new Error("memory-content-secret") as Error & {
        code: string;
        reason: string;
      };
      failure.code = "SAFE_FAILURE";
      failure.reason = "ROW_SCOPE_MISMATCH";
      throw failure;
    };
    const error = vi.fn();
    running = await startMemoryServer({
      service,
      defaultScope: { ...scope, visibility: "private" },
      host: "127.0.0.1",
      port: 0,
      logger: { error },
    });

    const response = await fetch(`${running.url}/v1/health`);
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Internal server error" });
    expect(error).toHaveBeenCalledWith(
      "REST request failed method=GET path=/v1/health error=Error code=SAFE_FAILURE " +
      "reason=ROW_SCOPE_MISMATCH",
    );
    expect(error.mock.calls.flat().join(" ")).not.toContain("memory-content-secret");
  });

  test("console 静态资产、无扩展 TS fallback、CSS 与 404 均正常", async () => {
    running = await startMemoryServer({
      service: new FakeMemoryService(),
      defaultScope: { ...scope, visibility: "private" },
      host: "127.0.0.1",
      port: 0,
    });

    const html = await fetch(`${running.url}/console`);
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toContain("text/html");

    const script = await fetch(`${running.url}/console/src/main`);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("text/javascript");

    const css = await fetch(`${running.url}/console/src/styles.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");

    const missing = await fetch(`${running.url}/console/missing.txt`);
    expect(missing.status).toBe(404);

    const emptyBody = await fetch(`${running.url}/v1/recall`, { method: "POST" });
    expect(emptyBody.status).toBe(400);
  });

  test("created daemon stop 幂等，stopped 后拒绝重新 start", async () => {
    const host = new FakeLifecycleHost();
    const listener = new FakeListener();
    const daemon = createMemoryServerDaemon(daemonOptions(host, listener));

    const stops = [daemon.stop(), daemon.stop()];
    expect(stops[0]).toBe(stops[1]);
    await Promise.all(stops);

    expect(daemon.snapshot()).toEqual({
      state: "stopped",
      ready: false,
      accepting: false,
      mode: "runtime_host",
    });
    await expect(daemon.start()).rejects.toMatchObject({ code: "DAEMON_START_FAILED" });
    expect(host.start).not.toHaveBeenCalled();
  });

  test("Host snapshot 抛错按 not-ready 处理，listener 永不 bind", async () => {
    const host = new FakeLifecycleHost();
    host.snapshot = vi.fn(() => { throw new Error("snapshot-secret"); });
    const listener = new FakeListener();
    const daemon = createMemoryServerDaemon(daemonOptions(host, listener));

    await expect(daemon.start()).rejects.toMatchObject({ code: "DAEMON_HOST_NOT_READY" });

    expect(listener.listening).toBe(false);
    expect(host.start).not.toHaveBeenCalled();
    expect(host.stop).not.toHaveBeenCalled();
    await expect(daemon.start()).rejects.toMatchObject({ code: "DAEMON_HOST_NOT_READY" });
  });

  test("非法 listener address 与 signal registrar 合同都安全回滚", async () => {
    const host = new FakeLifecycleHost();
    const listener = new FakeListener();
    listener.address = vi.fn(() => null);
    const invalidAddress = createMemoryServerDaemon(daemonOptions(host, listener));
    await expect(invalidAddress.start()).rejects.toMatchObject({ code: "DAEMON_START_FAILED" });
    expect(listener.closeCalls).toBe(1);
    expect(host.stop).toHaveBeenCalledTimes(1);

    const host2 = new FakeLifecycleHost();
    const listener2 = new FakeListener();
    const invalidSignal = createMemoryServerDaemon({
      ...daemonOptions(host2, listener2),
      registerShutdownSignal: (() => undefined) as never,
    });
    await expect(invalidSignal.start()).rejects.toMatchObject({ code: "DAEMON_START_FAILED" });
    expect(listener2.closeCalls).toBe(1);
    expect(host2.stop).toHaveBeenCalledTimes(1);
  });

  test("listener close failure 仍 stop Host，并返回固定 stop failure", async () => {
    const calls: string[] = [];
    const host = new FakeLifecycleHost(calls);
    const listener = new FakeListener(calls);
    const daemon = createMemoryServerDaemon(daemonOptions(host, listener));
    await daemon.start();
    listener.closeFailure = new Error("listener-close-secret");
    calls.length = 0;

    await expect(daemon.stop()).rejects.toMatchObject({ code: "DAEMON_STOP_FAILED" });

    expect(calls).toEqual(["listener:close", "host:stop"]);
    expect(daemon.snapshot()).toMatchObject({ state: "failed", failureCode: "DAEMON_STOP_FAILED" });
  });
});
