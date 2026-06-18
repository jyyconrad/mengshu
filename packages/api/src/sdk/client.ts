/**
 * mengshu JavaScript client SDK.
 *
 * SDK 通过 M2 REST API 访问 MemoryService，提供 bearer 注入、请求超时和稳定
 * 错误类型；它不依赖 OpenClaw，也不直接访问本地数据库。
 */

import type {
  MemoryClientContextInput,
  MemoryClientContextResult,
  MemoryClientFetch,
  MemoryClientHealth,
  MemoryClientOptions,
  MemoryClientRecallInput,
  MemoryClientRecallResult,
  MemoryClientStoreInput,
  MemoryClientStoreResult,
} from "./types.js";

export class MemoryClientError extends Error {
  status?: number;
  code?: string;
  body?: unknown;

  constructor(message: string, options: { status?: number; code?: string; body?: unknown } = {}) {
    super(message);
    this.name = "MemoryClientError";
    this.status = options.status;
    this.code = options.code;
    this.body = options.body;
  }
}

export class MemoryClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: MemoryClientFetch;

  constructor(options: MemoryClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  health(): Promise<MemoryClientHealth> {
    return this.request("/v1/health", { method: "GET" });
  }

  storeMemory(input: MemoryClientStoreInput): Promise<MemoryClientStoreResult> {
    return this.request("/v1/memories", { method: "POST", body: input });
  }

  recall(input: MemoryClientRecallInput): Promise<MemoryClientRecallResult> {
    return this.request("/v1/recall", { method: "POST", body: input });
  }

  buildContext(input: MemoryClientContextInput): Promise<MemoryClientContextResult> {
    return this.request("/v1/context", { method: "POST", body: input });
  }

  private async request<T>(path: string, options: { method: string; body?: unknown }): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = {};
    if (this.token) {
      headers.authorization = `Bearer ${this.token}`;
    }
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: options.method,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
      const body = await readResponseBody(response);
      if (!response.ok) {
        throw new MemoryClientError(errorMessageFromBody(body, response.statusText), {
          status: response.status,
          body,
        });
      }
      return body as T;
    } catch (error) {
      if (error instanceof MemoryClientError) {
        throw error;
      }
      if (controller.signal.aborted) {
        throw new MemoryClientError("Memory request timed out", { code: "timeout" });
      }
      throw new MemoryClientError(error instanceof Error ? error.message : String(error), {
        code: "request_failed",
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessageFromBody(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && typeof (body as Record<string, unknown>).error === "string") {
    return (body as Record<string, string>).error;
  }
  return fallback || "Memory client request failed";
}

export type {
  MemoryClientContextInput,
  MemoryClientContextResult,
  MemoryClientHealth,
  MemoryClientOptions,
  MemoryClientRecallInput,
  MemoryClientRecallResult,
  MemoryClientStoreInput,
  MemoryClientStoreResult,
} from "./types.js";
