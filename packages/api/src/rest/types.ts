/**
 * REST API 的轻量请求/响应类型。
 *
 * router 使用这些类型保持与 Node HTTP daemon 解耦，方便单元测试和后续 MCP/SDK
 * 复用同一组契约。
 */

import type { MemoryConfig } from "../../../../config.js";
import type { MemoryService } from "../../../../core/service-types.js";
import type { GraphQueryService } from "../../../../graph/query.js";
import type { ConsoleApi } from "../../../../console/types.js";
import type { AgentFastPathService } from "../agent-fast-path/index.js";
import type { AuthorityScope } from "../../../core/src/domain/authority-scope.js";
import type { AuthorityScopedForgetService } from "../../../core/src/domain/service-types.js";

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
  forgetService?: AuthorityScopedForgetService;
  /** Server-owned authority. Required unless the explicit test-only legacy channel is used. */
  authority?: AuthorityScope;
  /** @deprecated Test-only compatibility channel; production callers must not use it. */
  unsafeLegacyScope?: true;
  graph?: GraphQueryService;
  console?: ConsoleApi;
  agentFastPath?: AgentFastPathService;
  server?: Partial<RestServerConfig>;
}
