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
import type {
  MemoryWriteCommand,
  MemoryWriteKernelResult,
} from "../../../core/src/service/write-kernel.js";
import type { RuntimeHostControlPlane } from
  "../../../core/src/runtime/host-contract.js";
import type { MemoryEvolutionService } from
  "../../../core/src/temporal/memory-evolution-service.js";
import type { SessionWorkingSetService } from
  "../../../core/src/working-set/session-working-set-service.js";
import type { SessionWorkingSetMemoryBridge } from
  "../../../core/src/working-set/memory-bridge.js";
import type { SkillArtifactService } from
  "../../../core/src/skills/skill-artifact-service.js";
import type {
  MemoryPolicyOverlayService,
  MemoryPolicyResolver,
} from "../../../core/src/policy/memory-policy-overlay.js";

export interface MemoryWriteCommandExecutor {
  executeMemoryWrite(command: MemoryWriteCommand): Promise<MemoryWriteKernelResult>;
}

export interface RuntimeMcpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface RuntimeMcpFacade {
  listTools(): readonly RuntimeMcpToolDescriptor[];
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

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
  /** Shared RuntimeHost owner/readiness/generation control plane. */
  runtimeControl?: RuntimeHostControlPlane;
  /** Runtime-owned MCP registry; thin stdio adapters only proxy this facade. */
  runtimeMcp?: RuntimeMcpFacade;
  /** Runtime-owned F0 write capability. Production writes fail closed when absent. */
  memoryWrite?: MemoryWriteCommandExecutor;
  memoryEvolution?: Pick<
    MemoryEvolutionService,
    "history" | "recallAsOf" | "recallAsOfResolved" | "expire" | "revoke" | "purge"
  >;
  sessionWorkingSet?: Pick<
    SessionWorkingSetService,
    "ingestToolPair" | "recordTaskBoundary" | "assemble" | "readPayload" |
    "explainRewrite" | "closeSession"
  >;
  sessionWorkingSetMemoryBridge?: Pick<SessionWorkingSetMemoryBridge, "promoteClaim">;
  skillArtifacts?: Pick<
    SkillArtifactService,
    "proposeFromCandidate" | "importCurated" | "review" | "publish" | "appendVersion" | "revoke" |
    "read" | "search" | "explain"
  >;
  memoryPolicyOverlays?: Pick<MemoryPolicyOverlayService, "appendVersion">;
  memoryPolicyResolver?: Pick<MemoryPolicyResolver, "resolve">;
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
