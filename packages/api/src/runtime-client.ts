import http from "node:http";
import { lstat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import {
  parseRuntimeHostControlSnapshot,
  type RuntimeHostControlSnapshot,
} from "../../core/src/runtime/host-contract.js";

export type RuntimeClientErrorCode =
  | "RUNTIME_TRANSPORT_FAILED"
  | "RUNTIME_PROTOCOL_INVALID"
  | "RUNTIME_HOME_MISMATCH"
  | "RUNTIME_NOT_READY"
  | "RUNTIME_NOT_OWNER"
  | "RUNTIME_OWNER_CHANGED"
  | "RUNTIME_GENERATION_STALE"
  | "RUNTIME_REQUEST_FAILED";

export class RuntimeClientError extends Error {
  readonly code: RuntimeClientErrorCode;

  constructor(code: RuntimeClientErrorCode) {
    super("Runtime client operation failed");
    this.name = "RuntimeClientError";
    this.code = code;
  }
}

export interface RuntimeClientRequest {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: unknown;
}

export interface RuntimeClientResponse {
  readonly status: number;
  readonly body: unknown;
  readonly runtimeIdentity?: {
    readonly ownerId: string;
    readonly homeFingerprint: string;
    readonly generation: number;
  };
}

export interface RuntimeClientTransport {
  request(input: RuntimeClientRequest): Promise<RuntimeClientResponse>;
}

export interface RuntimeClientOptions {
  readonly transport: RuntimeClientTransport;
  readonly expectedHomeFingerprint: string;
}

const SHA256 = /^[a-f0-9]{64}$/;

export class RuntimeClient {
  private current?: RuntimeHostControlSnapshot;

  constructor(private readonly options: RuntimeClientOptions) {
    if (!options || typeof options.transport?.request !== "function" ||
        !SHA256.test(options.expectedHomeFingerprint)) {
      throw new RuntimeClientError("RUNTIME_PROTOCOL_INVALID");
    }
  }

  snapshot(): RuntimeHostControlSnapshot {
    if (!this.current) throw new RuntimeClientError("RUNTIME_NOT_READY");
    return this.current;
  }

  connect(): Promise<RuntimeHostControlSnapshot> {
    return this.readControlSnapshot(false);
  }

  refresh(): Promise<RuntimeHostControlSnapshot> {
    return this.readControlSnapshot(true);
  }

  async invoke<T>(
    request: RuntimeClientRequest,
    expectedStatus: number | readonly number[] = 200,
  ): Promise<T> {
    const control = this.current === undefined ? await this.connect() : await this.refresh();
    let response: RuntimeClientResponse;
    try {
      response = await this.options.transport.request(request);
    } catch {
      throw new RuntimeClientError("RUNTIME_TRANSPORT_FAILED");
    }
    const identity = response?.runtimeIdentity;
    if (!identity || identity.homeFingerprint !== control.homeFingerprint) {
      throw new RuntimeClientError("RUNTIME_HOME_MISMATCH");
    }
    if (identity.ownerId !== control.ownerId) {
      throw new RuntimeClientError("RUNTIME_OWNER_CHANGED");
    }
    if (identity.generation !== control.generation) {
      throw new RuntimeClientError("RUNTIME_GENERATION_STALE");
    }
    const accepted = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
    if (!accepted.includes(response.status)) {
      throw new RuntimeClientError("RUNTIME_REQUEST_FAILED");
    }
    return response.body as T;
  }

  private async readControlSnapshot(refresh: boolean): Promise<RuntimeHostControlSnapshot> {
    let response: RuntimeClientResponse | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const candidate = await this.options.transport.request({ method: "GET", path: "/v1/runtime" });
        if (candidate?.status === 200) {
          response = candidate;
          break;
        }
      } catch {
        // A stale pooled socket after daemon restart is safe to retry for this GET only.
      }
    }
    if (!response) {
      throw new RuntimeClientError("RUNTIME_TRANSPORT_FAILED");
    }
    let next: RuntimeHostControlSnapshot;
    try {
      next = parseRuntimeHostControlSnapshot(response.body);
    } catch {
      throw new RuntimeClientError("RUNTIME_PROTOCOL_INVALID");
    }
    if (next.homeFingerprint !== this.options.expectedHomeFingerprint) {
      throw new RuntimeClientError("RUNTIME_HOME_MISMATCH");
    }
    if (!next.workerOwner) throw new RuntimeClientError("RUNTIME_NOT_OWNER");
    if (!next.ready || !next.accepting || next.state !== "ready") {
      throw new RuntimeClientError("RUNTIME_NOT_READY");
    }
    if (refresh && this.current) {
      if (next.ownerId !== this.current.ownerId) {
        throw new RuntimeClientError("RUNTIME_OWNER_CHANGED");
      }
      if (next.generation < this.current.generation) {
        throw new RuntimeClientError("RUNTIME_GENERATION_STALE");
      }
    }
    this.current = next;
    return next;
  }
}

export function createFetchRuntimeClientTransport(input: {
  readonly baseUrl: string;
  readonly bearerToken?: string;
  readonly ownerToken?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}): RuntimeClientTransport {
  const baseUrl = new URL(input.baseUrl);
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new RuntimeClientError("RUNTIME_PROTOCOL_INVALID");
  }
  const timeoutMs = input.timeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RuntimeClientError("RUNTIME_PROTOCOL_INVALID");
  }
  const fetchImpl = input.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new RuntimeClientError("RUNTIME_PROTOCOL_INVALID");
  }
  return Object.freeze({
    async request(request: RuntimeClientRequest): Promise<RuntimeClientResponse> {
      if (!request.path.startsWith("/") || request.path.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(request.path)) {
        throw new RuntimeClientError("RUNTIME_PROTOCOL_INVALID");
      }
      const url = new URL(request.path, baseUrl);
      if (url.origin !== baseUrl.origin) throw new RuntimeClientError("RUNTIME_PROTOCOL_INVALID");
      const response = await fetchImpl(url, {
        method: request.method,
        redirect: "error",
        headers: {
          accept: "application/json",
          ...(request.body === undefined ? {} : { "content-type": "application/json" }),
          ...(input.bearerToken ? { authorization: `Bearer ${input.bearerToken}` } : {}),
          ...(input.ownerToken ? { "x-mengshu-owner-token": input.ownerToken } : {}),
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await response.json().catch(() => undefined);
      const ownerId = response.headers.get("x-mengshu-runtime-owner");
      const homeFingerprint = response.headers.get("x-mengshu-runtime-home");
      const generation = Number(response.headers.get("x-mengshu-runtime-generation"));
      return {
        status: response.status,
        body,
        ...(ownerId && homeFingerprint && Number.isSafeInteger(generation) && generation > 0
          ? { runtimeIdentity: { ownerId, homeFingerprint, generation } }
          : {}),
      };
    },
  });
}

export function createUnixSocketRuntimeClientTransport(input: {
  readonly socketPath: string;
  readonly bearerToken?: string;
  readonly ownerToken?: string;
  readonly timeoutMs?: number;
}): RuntimeClientTransport {
  if (!isAbsolute(input.socketPath) || /[\u0000-\u001f\u007f]/.test(input.socketPath)) {
    throw new RuntimeClientError("RUNTIME_PROTOCOL_INVALID");
  }
  const timeoutMs = input.timeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RuntimeClientError("RUNTIME_PROTOCOL_INVALID");
  }
  const verifySocket = async (): Promise<void> => {
    const [socket, parent] = await Promise.all([
      lstat(input.socketPath),
      lstat(dirname(input.socketPath)),
    ]);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!socket.isSocket() || !parent.isDirectory() ||
        (socket.mode & 0o077) !== 0 || (parent.mode & 0o077) !== 0 ||
        (uid !== undefined && (socket.uid !== uid || parent.uid !== uid))) {
      throw new RuntimeClientError("RUNTIME_TRANSPORT_FAILED");
    }
  };
  return Object.freeze({
    async request(request: RuntimeClientRequest): Promise<RuntimeClientResponse> {
      await verifySocket();
      if (!request.path.startsWith("/") || /[\u0000-\u001f\u007f]/.test(request.path)) {
        throw new RuntimeClientError("RUNTIME_PROTOCOL_INVALID");
      }
      return new Promise<RuntimeClientResponse>((resolve, reject) => {
        const operation = http.request({
          socketPath: input.socketPath,
          path: request.path,
          method: request.method,
          headers: {
            accept: "application/json",
            ...(request.body === undefined ? {} : { "content-type": "application/json" }),
            ...(input.bearerToken ? { authorization: `Bearer ${input.bearerToken}` } : {}),
            ...(input.ownerToken ? { "x-mengshu-owner-token": input.ownerToken } : {}),
          },
        }, (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer | string) => {
            const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += value.byteLength;
            if (bytes > 4 * 1024 * 1024) {
              operation.destroy(new Error("runtime response too large"));
              return;
            }
            chunks.push(value);
          });
          response.on("end", () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
              const ownerId = response.headers["x-mengshu-runtime-owner"];
              const homeFingerprint = response.headers["x-mengshu-runtime-home"];
              const generation = Number(response.headers["x-mengshu-runtime-generation"]);
              resolve({
                status: response.statusCode ?? 0,
                body,
                ...(typeof ownerId === "string" && typeof homeFingerprint === "string" &&
                    Number.isSafeInteger(generation) && generation > 0
                  ? { runtimeIdentity: { ownerId, homeFingerprint, generation } }
                  : {}),
              });
            } catch {
              reject(new RuntimeClientError("RUNTIME_PROTOCOL_INVALID"));
            }
          });
        });
        operation.setTimeout(timeoutMs, () => operation.destroy(new Error("runtime timeout")));
        operation.on("error", () => reject(new RuntimeClientError("RUNTIME_TRANSPORT_FAILED")));
        if (request.body !== undefined) operation.write(JSON.stringify(request.body));
        operation.end();
      });
    },
  });
}
