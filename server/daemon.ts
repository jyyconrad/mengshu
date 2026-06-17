/**
 * Node HTTP memory server daemon.
 *
 * 第一版只暴露本机 REST API，不引入 Express，不在 daemon 内创建数据库或解析
 * OpenClaw 配置；调用方必须传入已构造好的 `MemoryService`。
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { MemoryService } from "../core/service-types.js";
import { createRestRouter } from "../api/rest/router.js";
import type { RestRequest, RestRouterOptions } from "../api/rest/types.js";
import { startJobWorkerLoop, type JobWorkerLoopOptions } from "./workers.js";
import type { JobRepository } from "../storage/repositories/types.js";

export interface StartMemoryServerOptions {
  service: MemoryService;
  graph?: RestRouterOptions["graph"];
  console?: RestRouterOptions["console"];
  agentFastPath?: RestRouterOptions["agentFastPath"];
  host?: string;
  port?: number;
  secret?: string;
  requireHttps?: boolean;
  /** 后台 job worker：注入后 daemon 在 listen 期间轮询 drain 队列，stop 时清理。 */
  worker?: {
    jobs: JobRepository;
  } & Omit<JobWorkerLoopOptions, "workerId"> & { workerId?: string };
}

export interface RunningMemoryServer {
  url: string;
  server: http.Server;
  stop(): Promise<void>;
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

function writeJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function contentType(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".ts") || filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

const moduleDir = dirname(fileURLToPath(import.meta.url));
const consoleRoot = normalize(join(moduleDir, "..", "console", "web"));

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

export async function startMemoryServer(options: StartMemoryServerOptions): Promise<RunningMemoryServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 3847;
  const router = createRestRouter({
    service: options.service,
    graph: options.graph,
    console: options.console,
    agentFastPath: options.agentFastPath,
    server: {
      enabled: true,
      host,
      port,
      secret: options.secret,
      requireHttps: options.requireHttps,
    },
  });

  const server = http.createServer(async (request, response) => {
    try {
      const pathname = requestPath(request.url);
      if (request.method === "GET" && await serveConsoleAsset(pathname, response)) {
        return;
      }
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
      writeJson(response, restResponse.status, restResponse.body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeJson(response, message === "Invalid JSON body" ? 400 : 500, { error: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const url = `http://${host}:${address.port}`;

  // 启动后台 job worker（注入时）。daemon 拥有其生命周期：随 listen 启动、随 stop 清理。
  const workerLoop = options.worker
    ? startJobWorkerLoop(options.worker.jobs, {
        workerId: options.worker.workerId ?? "memory-daemon-worker",
        leaseMs: options.worker.leaseMs,
        intervalMs: options.worker.intervalMs,
        handlers: options.worker.handlers,
        maxPerTick: options.worker.maxPerTick,
      })
    : undefined;

  return {
    url,
    server,
    stop: async () => {
      await workerLoop?.stop();
      if (!server.listening) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}
