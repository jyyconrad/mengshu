/**
 * Node HTTP memory server daemon.
 *
 * 第一版只暴露本机 REST API，不引入 Express，不在 daemon 内创建数据库或解析
 * OpenClaw 配置；调用方必须传入已构造好的 `MemoryService`。
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { chmod, lstat, mkdir, readFile, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MemoryService } from "../core/service-types.js";
import { createRestRouter } from "../adapters/rest/router.js";
import type { RestRequest, RestRouterOptions } from "../adapters/rest/types.js";
import { startJobWorkerLoop, type JobWorkerLoopOptions } from "./workers.js";
import type { JobRepository } from "../storage/repositories/types.js";
import type { MemoryScope } from "../packages/core/src/domain/types.js";
import type { AuthorityScope } from "../packages/core/src/domain/authority-scope.js";
import { createExactRestAuthority } from "../packages/api/src/rest/authority.js";
import { randomUUID } from "node:crypto";
import { resolveHomeDir } from "../packages/core/src/runtime/paths.js";
import { createRuntimeControlPlane } from "./runtime-control-plane.js";
import type { RuntimeHostControlPlane } from
  "../packages/core/src/runtime/host-contract.js";

export interface StartMemoryServerOptions {
  service: MemoryService;
  /** Runtime 持有的统一 Write Kernel 能力；缺失时 REST 写入保持 fail-closed。 */
  memoryWrite?: RestRouterOptions["memoryWrite"];
  runtimeMcp?: RestRouterOptions["runtimeMcp"];
  memoryEvolution?: RestRouterOptions["memoryEvolution"];
  sessionWorkingSet?: RestRouterOptions["sessionWorkingSet"];
  sessionWorkingSetMemoryBridge?: RestRouterOptions["sessionWorkingSetMemoryBridge"];
  skillArtifacts?: RestRouterOptions["skillArtifacts"];
  memoryPolicyOverlays?: RestRouterOptions["memoryPolicyOverlays"];
  memoryPolicyResolver?: RestRouterOptions["memoryPolicyResolver"];
  graph?: RestRouterOptions["graph"];
  console?: RestRouterOptions["console"];
  agentFastPath?: RestRouterOptions["agentFastPath"];
  /** Runtime-owned default scope; used to derive an exact-only authority. */
  defaultScope?: MemoryScope;
  /** Optional wider explicit allowlists from authenticated server configuration. */
  authority?: AuthorityScope;
  host?: string;
  port?: number;
  /** Optional owner-only Unix socket under $MENGSHU_HOME/run; takes precedence over TCP. */
  socketPath?: string;
  secret?: string;
  requireHttps?: boolean;
  /** 后台 job worker：注入后 daemon 在 listen 期间轮询 drain 队列，stop 时清理。 */
  worker?: {
    jobs: JobRepository;
  } & Omit<JobWorkerLoopOptions, "workerId"> & { workerId?: string };
  /** 新 RuntimeHost 的渐进迁移接点；未注入时保持原 daemon 行为。 */
  runtimeHost?: MemoryServerLifecycleHost;
  /** Canonical MENGSHU_HOME used only to derive the non-reversible control fingerprint. */
  runtimeHome?: string;
  /** 仅用于 composition/test 注入；生产默认使用 node:http。 */
  listenerFactory?: MemoryServerListenerFactory;
  /** 仅注册回调，不允许 daemon 直接 process.exit。 */
  registerShutdownSignal?: (handler: () => Promise<void>) => () => void;
  /** Host stop 的 daemon 级最后一道硬边界。 */
  runtimeHostStopTimeoutMs?: number;
  /** daemon 内所有 lifecycle await 共用的单操作硬边界。 */
  lifecycleOperationTimeoutMs?: number;
  lifecycleScheduler?: MemoryServerLifecycleScheduler;
  /** 仅记录脱敏后的请求失败分类；不得写入请求体或异常 message。 */
  logger?: {
    error(message: string): void;
  };
}

export interface RunningMemoryServer {
  url: string;
  server: http.Server;
  stop(): Promise<void>;
  snapshot(): MemoryServerDaemonSnapshot;
}

export interface MemoryServerLifecycleHost {
  start(): Promise<void>;
  stop(): Promise<void>;
  snapshot(): {
    readonly state: string;
    readonly ready: boolean;
    readonly accepting?: boolean;
    readonly generation: number;
  };
}

export interface MemoryServerListener {
  readonly listening: boolean;
  /** true 表示 error 是 bind 终态，之后绝不会再触发该次 listen callback。 */
  readonly listenErrorIsTerminal?: boolean;
  once(event: "error", listener: (error: unknown) => void): this;
  off(event: "error", listener: (error: unknown) => void): this;
  listen(port: number, host: string, callback: () => void): this;
  address(): AddressInfo | string | null;
  close(callback?: (error?: Error) => void): this;
}

export type MemoryServerListenerFactory = (
  handler: http.RequestListener,
) => MemoryServerListener;

export interface MemoryServerLifecycleScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type MemoryServerDaemonState =
  | "created"
  | "starting"
  | "ready"
  | "stopping"
  | "stopped"
  | "failed";

export type MemoryServerDaemonErrorCode =
  | "DAEMON_HOST_NOT_READY"
  | "DAEMON_START_FAILED"
  | "DAEMON_STOP_FAILED"
  | "DAEMON_STOPPING";

export class MemoryServerDaemonError extends Error {
  readonly code: MemoryServerDaemonErrorCode;

  constructor(code: MemoryServerDaemonErrorCode) {
    super("Memory server daemon operation failed");
    this.name = "MemoryServerDaemonError";
    this.code = code;
  }
}

export interface MemoryServerDaemonSnapshot {
  readonly state: MemoryServerDaemonState;
  readonly ready: boolean;
  readonly accepting: boolean;
  readonly mode: "legacy" | "runtime_host";
  readonly failureCode?: Exclude<MemoryServerDaemonErrorCode, "DAEMON_STOPPING">;
}

export interface MemoryServerDaemon {
  start(): Promise<RunningMemoryServer>;
  stop(): Promise<void>;
  snapshot(): MemoryServerDaemonSnapshot;
}

async function readBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON body");
  }
}

function requestPath(url: string | undefined): string {
  const parsed = new URL(url ?? "/", "http://localhost");
  return parsed.pathname;
}

function writeJson(
  response: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  response.end(JSON.stringify(body));
}

function contentType(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".ts") || filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

const moduleDir = dirname(fileURLToPath(import.meta.url));
const consoleRoot = normalize(join(moduleDir, "..", "packages", "ui", "src", "web"));

async function serveConsoleAsset(pathname: string, response: http.ServerResponse): Promise<boolean> {
  if (pathname !== "/console" && !pathname.startsWith("/console/")) {
    return false;
  }
  const relativePath = pathname === "/console" || pathname === "/console/"
    ? "index.html"
    : pathname.replace(/^\/console\/?/, "");
  const resolved = normalize(join(consoleRoot, relativePath));
  if (!resolved.startsWith(consoleRoot)) {
    response.statusCode = 403;
    response.end("Forbidden");
    return true;
  }
  try {
    const body = await readFile(resolved).catch(async (error: unknown) => {
      if (resolved.includes(".") || !(error instanceof Error)) {
        throw error;
      }
      return readFile(`${resolved}.ts`);
    });
    response.statusCode = 200;
    response.setHeader("content-type", contentType(resolved.includes(".") ? resolved : `${resolved}.ts`));
    response.end(body);
  } catch {
    response.statusCode = 404;
    response.end("Not found");
  }
  return true;
}

const DEFAULT_LIFECYCLE_SCHEDULER: MemoryServerLifecycleScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const DEFAULT_RUNTIME_HOST_STOP_TIMEOUT_MS = 5_000;

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

interface HostSnapshotData {
  readonly state: unknown;
  readonly ready: unknown;
  readonly accepting: unknown;
  readonly generation: unknown;
}

/** Host snapshot 是跨组件控制面合同，只接受无 getter/Proxy 副作用的 plain data object。 */
function readHostSnapshotData(host: MemoryServerLifecycleHost): HostSnapshotData | undefined {
  try {
    const snapshot = host.snapshot();
    if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) return undefined;
    const prototype = Object.getPrototypeOf(snapshot);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const expectedKeys = ["state", "ready", "accepting", "generation"] as const;
    const ownKeys = Reflect.ownKeys(snapshot);
    if (ownKeys.length !== expectedKeys.length ||
        ownKeys.some((key) => typeof key !== "string" || !expectedKeys.includes(key as typeof expectedKeys[number]))) {
      return undefined;
    }
    const values: Record<keyof HostSnapshotData, unknown> = {
      state: undefined,
      ready: undefined,
      accepting: undefined,
      generation: undefined,
    };
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(snapshot, key);
      if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor) ||
          descriptor.get !== undefined || descriptor.set !== undefined) {
        return undefined;
      }
      values[key] = descriptor.value;
    }
    return values;
  } catch {
    return undefined;
  }
}

function settleWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
  scheduler: MemoryServerLifecycleScheduler,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timerCreated = false;
    let timer: unknown;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (timerCreated) {
        try {
          scheduler.clearTimeout(timer);
        } catch {
          // 决议后清理 timer 失败不转发 raw scheduler 错误。
        }
      }
      resolve(ok);
    };
    promise.then(() => { finish(true); }, () => { finish(false); });
    try {
      timer = scheduler.setTimeout(() => { finish(false); }, timeoutMs);
      timerCreated = true;
    } catch {
      finish(false);
    }
  });
}

function settlesWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
  scheduler: MemoryServerLifecycleScheduler,
): Promise<boolean> {
  return settleWithin(
    promise.then(() => undefined, () => undefined),
    timeoutMs,
    scheduler,
  );
}

function listen(
  listener: MemoryServerListener,
  port: number,
  host: string,
  isCancelled: () => boolean,
  onLateBind: () => Promise<boolean>,
  onBound: () => void,
  errorIsTerminal: boolean,
  socketPath?: string,
): ListenerBindOperation {
  let finishCompletion!: (closed: boolean) => void;
  let completionSettled = false;
  const completion = new Promise<boolean>((resolve) => {
    finishCompletion = (closed) => {
      if (completionSettled) return;
      completionSettled = true;
      resolve(closed);
    };
  });
  const result = new Promise<void>((resolve, reject) => {
    let settled = false;
    const onError = (error: unknown, terminal = errorIsTerminal) => {
      if (settled) return;
      settled = true;
      listener.off("error", onError);
      if (terminal) finishCompletion(true);
      reject(error);
    };
    listener.once("error", onError);
    try {
      const callback = () => {
        if (settled) {
          if (isCancelled()) {
            try {
              void onLateBind().then(finishCompletion, () => { finishCompletion(false); });
            } catch {
              finishCompletion(false);
              // 已失败 bind 的迟到 callback 仍必须 fail-closed。
            }
          }
          return;
        }
        settled = true;
        listener.off("error", onError);
        if (isCancelled()) {
          try {
            void onLateBind().then(finishCompletion, () => { finishCompletion(false); });
          } catch {
            finishCompletion(false);
            // late bind cleanup 由 daemon 的固定 cleanup 状态承接，不转发 raw listener error。
          }
          reject(new Error("listener bind cancelled"));
          return;
        }
        try {
          onBound();
        } catch {
          finishCompletion(false);
          reject(new Error("listener runtime error handler registration failed"));
          return;
        }
        finishCompletion(true);
        resolve();
      };
      if (socketPath) {
        (listener.listen as unknown as (path: string, callback: () => void) => MemoryServerListener)(
          socketPath,
          callback,
        );
      } else {
        listener.listen(port, host, callback);
      }
    } catch (error) {
      onError(error, true);
    }
  });
  return { result, completion };
}

async function prepareUnixSocket(socketPath: string, runtimeHome: string): Promise<string> {
  if (!isAbsolute(socketPath) || /[\u0000-\u001f\u007f]/.test(socketPath)) {
    throw new MemoryServerDaemonError("DAEMON_START_FAILED");
  }
  const runRoot = resolve(runtimeHome, "run");
  const resolved = resolve(socketPath);
  if (dirname(resolved) !== runRoot || relative(runRoot, resolved).startsWith("..")) {
    throw new MemoryServerDaemonError("DAEMON_START_FAILED");
  }
  await mkdir(runRoot, { recursive: true, mode: 0o700 });
  await chmod(runRoot, 0o700);
  try {
    await lstat(resolved);
    throw new MemoryServerDaemonError("DAEMON_START_FAILED");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return resolved;
}

async function removeUnixSocket(socketPath: string | undefined): Promise<boolean> {
  if (!socketPath) return true;
  try {
    const stat = await lstat(socketPath);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!stat.isSocket() || (uid !== undefined && stat.uid !== uid)) return false;
    await unlink(socketPath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

interface ListenerBindOperation {
  readonly result: Promise<void>;
  readonly completion: Promise<boolean>;
}

async function closeListener(listener: MemoryServerListener | undefined): Promise<boolean> {
  if (!listener?.listening) return true;
  return new Promise((resolve) => {
    try {
      listener.close((error) => { resolve(!error); });
    } catch {
      resolve(false);
    }
  });
}

class MemoryServerDaemonController implements MemoryServerDaemon {
  private state: MemoryServerDaemonState = "created";
  private failureCode?: Exclude<MemoryServerDaemonErrorCode, "DAEMON_STOPPING">;
  private listener?: MemoryServerListener;
  private workerLoop?: ReturnType<typeof startJobWorkerLoop>;
  private unregisterSignal?: () => void;
  private startPromise?: Promise<RunningMemoryServer>;
  private stopPromise?: Promise<void>;
  private hostStopPromise?: Promise<boolean>;
  private lateHostStopPromise?: Promise<boolean>;
  private workerStopPromise?: Promise<boolean>;
  private listenerClosePromise?: Promise<boolean>;
  private lateListenerClosePromise?: Promise<boolean>;
  private listenerBindOperation?: ListenerBindOperation;
  private running?: RunningMemoryServer;
  private hostStartAttempted = false;
  private hostStartSettled = false;
  private hostStartAbandoned = false;
  private hostStartPromise?: Promise<void>;
  private ownedHostGeneration?: number;
  private hostOwnershipInvalidated = false;
  private listenerBindCancelled = false;
  private listenerRuntimeErrorHandler?: (error: unknown) => void;
  private listenerRuntimeErrorRegistered = false;
  private cleanupFailed = false;
  private readonly lifecycleScheduler: MemoryServerLifecycleScheduler;
  private readonly operationTimeoutMs: number;
  private readonly runtimeControl?: RuntimeHostControlPlane;

  constructor(private readonly options: StartMemoryServerOptions) {
    this.lifecycleScheduler = options.lifecycleScheduler ?? DEFAULT_LIFECYCLE_SCHEDULER;
    this.operationTimeoutMs = options.lifecycleOperationTimeoutMs ??
      options.runtimeHostStopTimeoutMs ?? DEFAULT_RUNTIME_HOST_STOP_TIMEOUT_MS;
    this.runtimeControl = options.runtimeHost
      ? createRuntimeControlPlane({
          runtimeHome: options.runtimeHome ?? resolveHomeDir(),
          ownerId: `runtime-${randomUUID()}`,
          host: options.runtimeHost,
        })
      : undefined;
  }

  snapshot(): MemoryServerDaemonSnapshot {
    const hostSnapshot = this.options.runtimeHost
      ? readHostSnapshotData(this.options.runtimeHost)
      : undefined;
    const hostReady = !this.options.runtimeHost || (
      hostSnapshot?.state === "ready" && hostSnapshot.ready === true &&
      hostSnapshot.accepting === true &&
      (this.ownedHostGeneration === undefined ||
        hostSnapshot.generation === this.ownedHostGeneration)
    );
    const ready = this.state === "ready" && hostReady;
    return Object.freeze({
      state: this.state,
      ready,
      accepting: ready && this.listener?.listening === true,
      mode: this.options.runtimeHost ? "runtime_host" : "legacy",
      ...(this.failureCode ? { failureCode: this.failureCode } : {}),
    });
  }

  private runtimeResponseHeaders(): Record<string, string> {
    if (!this.runtimeControl) return {};
    try {
      const snapshot = this.runtimeControl.snapshot();
      return {
        "x-mengshu-runtime-owner": snapshot.ownerId,
        "x-mengshu-runtime-home": snapshot.homeFingerprint,
        "x-mengshu-runtime-generation": String(snapshot.generation),
      };
    } catch {
      return {};
    }
  }

  start(): Promise<RunningMemoryServer> {
    if (this.state === "starting" || this.state === "ready") return this.startPromise!;
    if (this.state === "stopping") {
      return Promise.reject(new MemoryServerDaemonError("DAEMON_STOPPING"));
    }
    if (this.state === "failed") {
      return Promise.reject(new MemoryServerDaemonError(this.failureCode ?? "DAEMON_START_FAILED"));
    }
    if (this.state === "stopped") {
      return Promise.reject(new MemoryServerDaemonError("DAEMON_START_FAILED"));
    }
    this.state = "starting";
    this.failureCode = undefined;
    this.startPromise = this.runStart();
    return this.startPromise;
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (this.state === "created" || this.state === "stopped") {
      this.state = "stopped";
      this.stopPromise = Promise.resolve();
      return this.stopPromise;
    }
    this.listenerBindCancelled = true;
    this.abandonPendingHostStart();
    this.state = "stopping";
    this.stopPromise = this.runStop();
    return this.stopPromise;
  }

  private async runStart(): Promise<RunningMemoryServer> {
    let startFailureCode: Exclude<MemoryServerDaemonErrorCode, "DAEMON_STOPPING" | "DAEMON_STOP_FAILED"> =
      "DAEMON_START_FAILED";
    try {
      const host = this.options.host ?? "127.0.0.1";
      const port = this.options.port ?? 3847;
      const socketPath = this.options.socketPath === undefined
        ? undefined
        : await prepareUnixSocket(
            this.options.socketPath,
            this.options.runtimeHome ?? resolveHomeDir(),
          );
      if (this.options.runtimeHost && this.options.worker) {
        throw new MemoryServerDaemonError("DAEMON_START_FAILED");
      }
      if (!this.options.authority && !this.options.defaultScope) {
        // 保留旧 API 的显式配置诊断。
        throw new Error("REST server authority or server-owned defaultScope is required");
      }
      if (!isPositiveSafeInteger(this.operationTimeoutMs) ||
          typeof this.lifecycleScheduler.setTimeout !== "function" ||
          typeof this.lifecycleScheduler.clearTimeout !== "function") {
        throw new MemoryServerDaemonError("DAEMON_START_FAILED");
      }
      if (this.options.runtimeHost && !this.captureOwnedHostGeneration()) {
        startFailureCode = "DAEMON_HOST_NOT_READY";
        throw new MemoryServerDaemonError(startFailureCode);
      }
      const authority = this.options.authority ?? createExactRestAuthority(this.options.defaultScope!);
      const router = createRestRouter({
        service: this.options.service,
        runtimeControl: this.runtimeControl,
        runtimeMcp: this.options.runtimeMcp,
        memoryWrite: this.options.memoryWrite,
        memoryEvolution: this.options.memoryEvolution,
        sessionWorkingSet: this.options.sessionWorkingSet,
        sessionWorkingSetMemoryBridge: this.options.sessionWorkingSetMemoryBridge,
        skillArtifacts: this.options.skillArtifacts,
        memoryPolicyOverlays: this.options.memoryPolicyOverlays,
        memoryPolicyResolver: this.options.memoryPolicyResolver,
        forgetService: typeof (this.options.service as unknown as { forget?: unknown }).forget === "function"
          ? this.options.service as never
          : undefined,
        authority,
        graph: this.options.graph,
        console: this.options.console,
        agentFastPath: this.options.agentFastPath,
        server: {
          enabled: true,
          host,
          port,
          secret: this.options.secret,
          requireHttps: this.options.requireHttps,
        },
      });
      const requestListener: http.RequestListener = async (request, response) => {
        const method = request.method ?? "UNKNOWN";
        const pathname = requestPath(request.url);
        try {
          if (request.method === "GET" && await serveConsoleAsset(pathname, response)) return;
          const body = request.method === "GET" ? undefined : await readBody(request);
          const restRequest: RestRequest = {
            method: request.method ?? "GET",
            path: pathname,
            headers: request.headers as Record<string, string | string[] | undefined>,
            body,
            remoteAddress: request.socket.remoteAddress,
            protocol: "http",
          };
          const restResponse = await router.handle(restRequest);
          writeJson(response, restResponse.status, restResponse.body, {
            ...restResponse.headers,
            ...this.runtimeResponseHeaders(),
          });
        } catch (error) {
          const invalidJson = error instanceof Error && error.message === "Invalid JSON body";
          if (!invalidJson) {
            const name = error instanceof Error && error.name.trim().length > 0
              ? error.name
              : "UnknownError";
            const rawCode = error && typeof error === "object"
              ? (error as { code?: unknown }).code
              : undefined;
            const code = typeof rawCode === "string" && /^[A-Z0-9_]{1,64}$/.test(rawCode)
              ? ` code=${rawCode}`
              : "";
            const rawReason = error && typeof error === "object"
              ? (error as { reason?: unknown }).reason
              : undefined;
            const reason = typeof rawReason === "string" && /^[A-Z0-9_]{1,64}$/.test(rawReason)
              ? ` reason=${rawReason}`
              : "";
            this.options.logger?.error(
              `REST request failed method=${method} path=${pathname} error=${name}${code}${reason}`,
            );
          }
          writeJson(response, invalidJson ? 400 : 500, {
            error: invalidJson ? "Invalid JSON body" : "Internal server error",
          }, this.runtimeResponseHeaders());
        }
      };
      if (this.options.runtimeHost) {
        this.hostStartAttempted = true;
        const hostStartPromise = Promise.resolve().then(() => this.options.runtimeHost!.start());
        this.hostStartPromise = hostStartPromise;
        void hostStartPromise.then(
          () => { this.hostStartSettled = true; },
          () => { this.hostStartSettled = true; },
        );
        const hostStarted = await settleWithin(
          hostStartPromise,
          this.operationTimeoutMs,
          this.lifecycleScheduler,
        );
        if (!hostStarted) {
          this.abandonPendingHostStart();
          startFailureCode = "DAEMON_HOST_NOT_READY";
          throw new MemoryServerDaemonError(startFailureCode);
        }
        if (this.state === "stopping") throw new MemoryServerDaemonError("DAEMON_STOPPING");
        if (!this.ownedHostIsReady()) {
          startFailureCode = "DAEMON_HOST_NOT_READY";
          throw new MemoryServerDaemonError(startFailureCode);
        }
      }

      const factory = this.options.listenerFactory ??
        ((handler: http.RequestListener) => http.createServer(handler));
      this.listener = factory(requestListener);

      const listenerBindOperation = listen(
        this.listener,
        port,
        host,
        () => this.listenerBindCancelled,
        () => this.closeLateBoundListener(),
        () => { this.installListenerRuntimeErrorHandler(); },
        !this.options.listenerFactory || this.listener.listenErrorIsTerminal === true,
        socketPath,
      );
      this.listenerBindOperation = listenerBindOperation;
      const listenerBound = await settleWithin(
        listenerBindOperation.result,
        this.operationTimeoutMs,
        this.lifecycleScheduler,
      );
      if (!listenerBound) {
        this.listenerBindCancelled = true;
        throw new MemoryServerDaemonError("DAEMON_START_FAILED");
      }
      if (socketPath) await chmod(socketPath, 0o600);
      if (this.stoppingRequested()) throw new MemoryServerDaemonError("DAEMON_STOPPING");
      if (this.options.runtimeHost && !this.ownedHostIsReady()) {
        startFailureCode = "DAEMON_HOST_NOT_READY";
        throw new MemoryServerDaemonError(startFailureCode);
      }

      const address = this.listener.address();
      if (!address || (socketPath
        ? typeof address !== "string" || resolve(address) !== socketPath
        : typeof address === "string" || !isPositiveSafeInteger(address.port))) {
        throw new MemoryServerDaemonError("DAEMON_START_FAILED");
      }
      this.workerLoop = this.options.worker
        ? startJobWorkerLoop(this.options.worker.jobs, {
            workerId: this.options.worker.workerId ?? "memory-daemon-worker",
            leaseMs: this.options.worker.leaseMs,
            intervalMs: this.options.worker.intervalMs,
            handlers: this.options.worker.handlers,
            maxPerTick: this.options.worker.maxPerTick,
          })
        : undefined;

      this.running = Object.freeze({
        url: socketPath
          ? `http+unix://${encodeURIComponent(socketPath)}`
          : `http://${host}:${(address as AddressInfo).port}`,
        server: this.listener as http.Server,
        stop: () => this.stop(),
        snapshot: () => this.snapshot(),
      });
      if (this.options.registerShutdownSignal) {
        this.unregisterSignal = this.options.registerShutdownSignal(() => this.stop());
        if (typeof this.unregisterSignal !== "function") {
          throw new MemoryServerDaemonError("DAEMON_START_FAILED");
        }
      }
      if (this.stoppingRequested()) throw new MemoryServerDaemonError("DAEMON_STOPPING");
      this.state = "ready";
      return this.running;
    } catch (error) {
      if (error instanceof Error &&
          error.message === "REST server authority or server-owned defaultScope is required") {
        this.state = "failed";
        this.failureCode = "DAEMON_START_FAILED";
        throw error;
      }
      if (error instanceof MemoryServerDaemonError && error.code === "DAEMON_HOST_NOT_READY") {
        startFailureCode = error.code;
      }
      this.listenerBindCancelled = true;
      const signalUnregistered = this.unregisterSignalOnce();
      const listenerClosed = await this.closeListenerWithinBoundary();
      const socketRemoved = await removeUnixSocket(this.options.socketPath);
      const listenerErrorHandlerRemoved = this.removeListenerRuntimeErrorHandlerOnce();
      const workerStopped = await this.stopLegacyWorker();
      const hostStopped = await this.stopHostOnce();
      const lateHostStopped = this.lateHostStopPromise
        ? await this.lateHostStopPromise
        : true;
      if (this.state === "stopping") throw new MemoryServerDaemonError("DAEMON_STOPPING");
      if (!signalUnregistered || !listenerClosed || !socketRemoved || !listenerErrorHandlerRemoved ||
          !workerStopped || !hostStopped || !lateHostStopped || this.cleanupFailed) {
        this.state = "failed";
        this.failureCode = "DAEMON_STOP_FAILED";
        throw new MemoryServerDaemonError("DAEMON_STOP_FAILED");
      }
      this.state = "failed";
      this.failureCode = startFailureCode;
      throw new MemoryServerDaemonError(startFailureCode);
    }
  }

  private async runStop(): Promise<void> {
    const signalUnregistered = this.unregisterSignalOnce();
    const listenerClosed = await this.closeListenerWithinBoundary();
    const listenerErrorHandlerRemoved = this.removeListenerRuntimeErrorHandlerOnce();
    const workerStopped = await this.stopLegacyWorker();
    const hostStopped = await this.stopHostOnce();
    const startSettled = !this.startPromise || await settlesWithin(
      this.startPromise,
      this.operationTimeoutMs,
      this.lifecycleScheduler,
    );
    const signalUnregisteredAfterStart = this.unregisterSignalOnce();
    const listenerClosedAfterStart = await this.closeListenerWithinBoundary();
    const listenerErrorHandlerRemovedAfterStart = this.removeListenerRuntimeErrorHandlerOnce();
    const workerStoppedAfterStart = await this.stopLegacyWorker();
    const hostStoppedAfterStart = await this.stopHostOnce();
    const ownershipDrained = await this.drainLateCleanupOwnership();
    const socketRemoved = await removeUnixSocket(this.options.socketPath);

    if (!signalUnregistered || !signalUnregisteredAfterStart ||
        !listenerClosed || !listenerClosedAfterStart ||
        !listenerErrorHandlerRemoved || !listenerErrorHandlerRemovedAfterStart ||
        !workerStopped || !workerStoppedAfterStart ||
        !hostStopped || !hostStoppedAfterStart || !ownershipDrained || !socketRemoved ||
        !startSettled || this.cleanupFailed) {
      this.state = "failed";
      this.failureCode = "DAEMON_STOP_FAILED";
      throw new MemoryServerDaemonError("DAEMON_STOP_FAILED");
    }
    this.state = "stopped";
    this.failureCode = undefined;
  }

  private stopHostOnce(): Promise<boolean> {
    if (!this.options.runtimeHost || !this.hostStartAttempted) return Promise.resolve(true);
    if (this.hostOwnershipInvalidated) {
      this.hostStopPromise ??= Promise.resolve(true);
      return this.hostStopPromise;
    }
    if (!this.ownsCurrentHostGeneration()) {
      this.cleanupFailed = true;
      this.hostStopPromise ??= Promise.resolve(false);
      return this.hostStopPromise;
    }
    this.hostStopPromise ??= settleWithin(
      Promise.resolve().then(() => this.options.runtimeHost!.stop()),
      this.operationTimeoutMs,
      this.lifecycleScheduler,
    ).then((stopped) => this.recordCleanupResult(stopped));
    return this.hostStopPromise;
  }

  private abandonPendingHostStart(): void {
    const hostStartPromise = this.hostStartPromise;
    if (!hostStartPromise || this.hostStartSettled || this.hostStartAbandoned) return;
    this.hostStartAbandoned = true;
    void hostStartPromise.then(
      () => { this.startLateHostStop(); },
      () => { this.startLateHostStop(); },
    );
  }

  private startLateHostStop(): Promise<boolean> {
    if (this.lateHostStopPromise) return this.lateHostStopPromise;
    if (!this.options.runtimeHost || !this.hostStartAttempted) return Promise.resolve(true);
    const earlyStop = this.stopHostOnce();
    this.lateHostStopPromise = earlyStop.then(() => {
      if (!this.ownsCurrentHostGeneration()) return false;
      return settleWithin(
        Promise.resolve().then(() => this.options.runtimeHost!.stop()),
        this.operationTimeoutMs,
        this.lifecycleScheduler,
      );
    }).then((stopped) => {
      this.recordCleanupResult(stopped);
      if (!stopped) {
        this.state = "failed";
        this.failureCode = "DAEMON_STOP_FAILED";
      }
      return stopped;
    });
    return this.lateHostStopPromise;
  }

  private captureOwnedHostGeneration(): boolean {
    if (!this.options.runtimeHost) return true;
    if (this.ownedHostGeneration !== undefined) return true;
    const snapshot = readHostSnapshotData(this.options.runtimeHost);
    const generation = snapshot?.generation;
    if (typeof generation === "number" && isPositiveSafeInteger(generation)) {
      this.ownedHostGeneration = generation;
      return true;
    }
    return false;
  }

  private ownedHostIsReady(): boolean {
    if (!this.options.runtimeHost || this.ownedHostGeneration === undefined) return false;
    const snapshot = readHostSnapshotData(this.options.runtimeHost);
    if (!snapshot) {
      this.invalidateHostOwnership();
      return false;
    }
    const { state, ready, accepting, generation } = snapshot;
    if (typeof generation !== "number" || !isPositiveSafeInteger(generation) ||
        generation !== this.ownedHostGeneration) {
      this.invalidateHostOwnership();
      return false;
    }
    return state === "ready" && ready === true && accepting === true;
  }

  private ownsCurrentHostGeneration(): boolean {
    if (this.hostOwnershipInvalidated) return false;
    if (!this.options.runtimeHost || this.ownedHostGeneration === undefined) return true;
    const snapshot = readHostSnapshotData(this.options.runtimeHost);
    const generation = snapshot?.generation;
    return typeof generation === "number" && isPositiveSafeInteger(generation) &&
      generation === this.ownedHostGeneration;
  }

  private invalidateHostOwnership(): void {
    this.hostOwnershipInvalidated = true;
    this.cleanupFailed = true;
  }

  private async drainLateCleanupOwnership(): Promise<boolean> {
    const hostStartSettled = !this.hostStartAbandoned || !this.hostStartPromise || await settlesWithin(
      this.hostStartPromise,
      this.operationTimeoutMs,
      this.lifecycleScheduler,
    );
    const listenerBindClosed = !this.listenerBindOperation || await settleWithin(
      this.listenerBindOperation.completion.then((closed) => {
        if (!closed) throw new MemoryServerDaemonError("DAEMON_STOP_FAILED");
      }),
      this.operationTimeoutMs,
      this.lifecycleScheduler,
    );
    const lateHostStopped = this.lateHostStopPromise
      ? await this.lateHostStopPromise
      : true;
    const lateListenerClosed = this.lateListenerClosePromise
      ? await this.lateListenerClosePromise
      : true;
    return this.recordCleanupResult(
      hostStartSettled && listenerBindClosed && lateHostStopped && lateListenerClosed,
    );
  }

  private stopLegacyWorker(): Promise<boolean> {
    if (this.workerStopPromise) return this.workerStopPromise;
    const worker = this.workerLoop;
    if (!worker) return Promise.resolve(true);
    this.workerLoop = undefined;
    this.workerStopPromise = settleWithin(
      Promise.resolve().then(() => worker.stop()),
      this.operationTimeoutMs,
      this.lifecycleScheduler,
    ).then((stopped) => this.recordCleanupResult(stopped));
    return this.workerStopPromise;
  }

  private closeListenerWithinBoundary(): Promise<boolean> {
    if (this.listenerClosePromise) return this.listenerClosePromise;
    if (!this.listener?.listening) return Promise.resolve(true);
    const closing = settleWithin(
      closeListener(this.listener).then((closed) => {
        if (!closed) throw new MemoryServerDaemonError("DAEMON_STOP_FAILED");
      }),
      this.operationTimeoutMs,
      this.lifecycleScheduler,
    ).then((closed) => this.recordCleanupResult(closed));
    this.listenerClosePromise = closing;
    void closing.then(() => {
      if (this.listenerClosePromise === closing) this.listenerClosePromise = undefined;
    });
    return closing;
  }

  private unregisterSignalOnce(): boolean {
    const unregister = this.unregisterSignal;
    this.unregisterSignal = undefined;
    if (!unregister) return true;
    try {
      unregister();
      return true;
    } catch {
      this.cleanupFailed = true;
      return false;
    }
  }

  private recordCleanupResult(succeeded: boolean): boolean {
    if (!succeeded) this.cleanupFailed = true;
    return succeeded;
  }

  private closeLateBoundListener(): Promise<boolean> {
    if (this.lateListenerClosePromise) return this.lateListenerClosePromise;
    const earlyClose = this.listenerClosePromise ?? Promise.resolve(true);
    this.lateListenerClosePromise = earlyClose.then(() => this.closeListenerAttempt());
    void this.lateListenerClosePromise.then((closed) => {
      if (closed) return;
      this.cleanupFailed = true;
      this.state = "failed";
      this.failureCode = "DAEMON_STOP_FAILED";
    });
    return this.lateListenerClosePromise;
  }

  private closeListenerAttempt(): Promise<boolean> {
    if (!this.listener?.listening) return Promise.resolve(false);
    return settleWithin(
      closeListener(this.listener).then((closed) => {
        if (!closed) throw new MemoryServerDaemonError("DAEMON_STOP_FAILED");
      }),
      this.operationTimeoutMs,
      this.lifecycleScheduler,
    ).then((closed) => this.recordCleanupResult(closed));
  }

  private installListenerRuntimeErrorHandler(): void {
    if (this.listenerRuntimeErrorRegistered || !this.listener) return;
    const handler = (_error: unknown) => {
      this.listenerRuntimeErrorRegistered = false;
      try {
        // once listener 触发后立即续订，覆盖 close callback 决议前的重复 runtime error。
        this.listener!.once("error", handler);
        this.listenerRuntimeErrorHandler = handler;
        this.listenerRuntimeErrorRegistered = true;
      } catch {
        this.listenerRuntimeErrorHandler = undefined;
        this.cleanupFailed = true;
      }
      this.listenerBindCancelled = true;
      void this.stop().catch(() => undefined);
    };
    this.listener.once("error", handler);
    this.listenerRuntimeErrorHandler = handler;
    this.listenerRuntimeErrorRegistered = true;
  }

  private removeListenerRuntimeErrorHandlerOnce(): boolean {
    const handler = this.listenerRuntimeErrorHandler;
    if (!handler || !this.listenerRuntimeErrorRegistered || !this.listener) return true;
    this.listenerRuntimeErrorHandler = undefined;
    this.listenerRuntimeErrorRegistered = false;
    try {
      this.listener.off("error", handler);
      return true;
    } catch {
      this.cleanupFailed = true;
      return false;
    }
  }

  private stoppingRequested(): boolean {
    return this.state === "stopping";
  }
}

export function createMemoryServerDaemon(options: StartMemoryServerOptions): MemoryServerDaemon {
  return new MemoryServerDaemonController(options);
}

/** 兼容既有一次性启动 API；新 composition 可使用 createMemoryServerDaemon 做并发生命周期管理。 */
export function startMemoryServer(options: StartMemoryServerOptions): Promise<RunningMemoryServer> {
  return createMemoryServerDaemon(options).start();
}
