/**
 * REST API 认证与本机保护。
 *
 * 默认没有 secret 时只允许 loopback；配置 secret 后要求 Bearer token；
 * 如果 requireHttps=true，则 bearer 不能通过 plaintext HTTP 传输。
 */

import type { RestServerConfig } from "./types.js";

export interface RestAuthInput {
  remoteAddress?: string;
  protocol?: "http" | "https";
  headers: Record<string, string | string[] | undefined>;
  config: Partial<RestServerConfig>;
}

export type RestAuthResult =
  | { ok: true }
  | { ok: false; status: number; message: string };

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  return Array.isArray(value) ? value[0] : value;
}

function isLoopback(remoteAddress?: string): boolean {
  return !remoteAddress ||
    remoteAddress === "127.0.0.1" ||
    remoteAddress === "::1" ||
    remoteAddress === "::ffff:127.0.0.1" ||
    remoteAddress === "localhost";
}

export function authorizeRestRequest(input: RestAuthInput): RestAuthResult {
  const secret = input.config.secret;
  const protocol = input.protocol ?? "http";

  if (secret) {
    if (input.config.requireHttps === true && protocol !== "https") {
      return { ok: false, status: 403, message: "HTTPS is required for REST API" };
    }
    const authorization = headerValue(input.headers, "authorization");
    if (authorization !== `Bearer ${secret}`) {
      return { ok: false, status: 401, message: "Invalid bearer token" };
    }
    return { ok: true };
  }

  if (!isLoopback(input.remoteAddress)) {
    return { ok: false, status: 403, message: "REST API without secret is loopback-only" };
  }

  return { ok: true };
}
