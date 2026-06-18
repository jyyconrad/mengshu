/**
 * REST API 的轻量请求/响应类型。
 *
 * router 使用这些类型保持与 Node HTTP daemon 解耦，方便单元测试和后续 MCP/SDK
 * 复用同一组契约。
 */

import type { MemoryConfig } from "../../config.js";
import type { MemoryService } from "../../core/service-types.js";
import type { GraphQueryService } from "../../graph/query.js";
import type { ConsoleApi } from "../../console/types.js";
import type { AgentFastPathService } from "../../api/agent-fast-path.js";

export type RestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | string;

export interface RestRequest {
  method: RestMethod;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  remoteAddress?: string;
  protocol?: "http" | "https";
}

export interface RestResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export type RestServerConfig = NonNullable<MemoryConfig["server"]>;

export interface RestRouterOptions {
  service: MemoryService;
  graph?: GraphQueryService;
  console?: ConsoleApi;
  agentFastPath?: AgentFastPathService;
  server?: Partial<RestServerConfig>;
}
