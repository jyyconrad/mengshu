/**
 * MemoryService REST router.
 *
 * 该 router 只负责鉴权、路由和 JSON 契约，不直接依赖 Node HTTP 或 OpenClaw。
 * Node daemon 负责把 IncomingMessage 解析成 RestRequest。
 */

import type {
  BuildContextInput,
  RecallInput,
} from "../../../../core/service-types.js";
import type { MemoryConfig } from "../../../../config.js";
import type { GraphQueryInput } from "../../../../graph/query.js";
import type { ConsoleCandidatesRequest, ConsoleCandidateReviewRequest, ConsoleLookupRequest } from "../../../../console/types.js";
import type { MemoryScope } from "../../../../core/types.js";
import {
  AuthorityScopeError,
  type AuthorityScope,
} from "../../../core/src/domain/authority-scope.js";
import { createMengshuRuntime } from "../../../../runtime.js";
import type { MengshuRuntime } from "../../../../runtime.js";
import { authorizeRestRequest } from "./auth.js";
import type { RestRequest, RestResponse, RestRouterOptions } from "./types.js";
import type { MemoryWriteKernelResult } from "../../../core/src/service/write-kernel.js";
import type { RecallResult } from "../../../../core/types.js";
import {
  CONTEXT_RECALL_BREAKDOWN_REQUIRED,
  RECALL_SCORE_BREAKDOWN_REQUIRED,
  requireContextBlockRecallReceipts,
  requireContextFastRecallReceipts,
  requireLookupResultReceipts,
  requireRecallResultReceipts,
} from "../../../core/src/domain/recall-receipt-validation.js";
import type {
  AgentTaskContextRequest,
  AgentObserveLightRequest,
  AgentLookupRequest,
  AgentSessionCommitRequest,
} from "../agent-fast-path/index.js";
import { resolveRestAuthorityScope } from "./authority.js";
import { createHash } from "node:crypto";

export interface RestRouter {
  handle(request: RestRequest): Promise<RestResponse>;
}

export interface RestApi {
  runtime: MengshuRuntime;
  router: RestRouter;
}

function runtimeMemoryWriteCapability(runtime: MengshuRuntime): RestRouterOptions["memoryWrite"] {
  const candidate = runtime as unknown as Partial<NonNullable<RestRouterOptions["memoryWrite"]>>;
  return typeof candidate.executeMemoryWrite === "function"
    ? { executeMemoryWrite: candidate.executeMemoryWrite.bind(runtime) }
    : undefined;
}

export function createRestApi(
  config: MemoryConfig,
  resolvedDbPath: string,
  authority: AuthorityScope,
): RestApi {
  // A single Runtime owns one scope-bound PostgreSQL candidate repository.
  // Therefore this convenience composition accepts only an authority that can
  // resolve one exact default scope; multi-scope hosts must compose separate
  // runtimes instead of silently binding candidate review to local defaults.
  const defaultScope = resolveRestAuthorityScope(authority, {});
  const runtime = createMengshuRuntime({
    config,
    resolvedDbPath,
    appId: defaultScope.appId,
    defaultScope,
  });
  return {
    runtime,
    router: createRestRouter({
      service: runtime.memoryService,
      memoryWrite: runtimeMemoryWriteCapability(runtime),
      console: runtime.consoleApi,
      agentFastPath: runtime.agentFastPath,
      server: config.server,
      authority,
    }),
  };
}

function methodNotAllowed(): RestResponse {
  return { status: 405, body: { error: "Method not allowed" } };
}

function notFound(): RestResponse {
  return { status: 404, body: { error: "Not found" } };
}

function badRequest(message: string): RestResponse {
  return { status: 400, body: { error: message } };
}

function writeResponse(result: MemoryWriteKernelResult): RestResponse {
  if (result.status === "persisted") {
    return {
      status: 201,
      body: {
        id: result.memoryId,
        stored: result.stored,
        status: result.status,
        ...("route" in result ? { route: result.route } : {}),
        recordType: result.recordType,
      },
    };
  }
  if (result.status === "duplicate") {
    return {
      status: 200,
      body: {
        id: result.duplicateOf,
        stored: false,
        status: result.status,
        kind: result.kind,
        duplicateOf: result.duplicateOf,
      },
    };
  }
  if (result.status === "rejected") {
    return { status: 422, body: { error: result.reason, status: result.status } };
  }
  return {
    status: 422,
    body: { error: "Explicit memory save cannot be ignored", status: result.status },
  };
}

function requireObjectBody(body: unknown): Record<string, unknown> | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  return body as Record<string, unknown>;
}

function validateRecallResult(result: RecallResult): string | undefined {
  try {
    requireRecallResultReceipts(result);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : RECALL_SCORE_BREAKDOWN_REQUIRED;
  }
}

function validateAgentLookupResult(result: unknown): string | undefined {
  try {
    requireLookupResultReceipts(result);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : RECALL_SCORE_BREAKDOWN_REQUIRED;
  }
}

function resolvedScope(
  options: RestRouterOptions,
  clientScope: unknown,
): { scope: MemoryScope } | { response: RestResponse } {
  if (!options.authority) {
    return { scope: (requireObjectBody(clientScope) ?? {}) as unknown as MemoryScope };
  }
  try {
    return { scope: resolveRestAuthorityScope(options.authority, clientScope) };
  } catch (error) {
    if (error instanceof AuthorityScopeError) {
      return { response: badRequest(`Invalid scope: ${error.code}`) };
    }
    return { response: badRequest("Invalid scope") };
  }
}

function scopeOrResponse(
  options: RestRouterOptions,
  clientScope: unknown,
): MemoryScope | RestResponse {
  const result = resolvedScope(options, clientScope);
  return "response" in result ? result.response : result.scope;
}

function isRestResponse(value: MemoryScope | RestResponse): value is RestResponse {
  return "status" in value;
}

function legacyRestV1IdempotencyKey(
  scope: MemoryScope,
  record: Record<string, unknown>,
): string {
  const metadata = requireObjectBody(record.metadata) ?? {};
  const provenance = requireObjectBody(record.provenance) ?? {};
  const stableInput = [
    scope.tenantId,
    scope.userId,
    scope.appId,
    scope.projectId,
    scope.agentId,
    scope.namespace,
    scope.visibility ?? "private",
    scope.workspaceId ?? "",
    scope.sessionId ?? "",
    typeof record.id === "string" ? record.id : "",
    typeof record.text === "string" ? record.text : "",
    typeof record.contentHash === "string" ? record.contentHash : "",
    typeof record.kind === "string" ? record.kind : "other",
    typeof record.semanticType === "string" ? record.semanticType : "",
    typeof provenance.sourceId === "string" ? provenance.sourceId : "",
    typeof provenance.messageId === "string" ? provenance.messageId : "",
    typeof metadata.sourceId === "string" ? metadata.sourceId : "",
  ];
  return `legacy-rest-v1:${createHash("sha256").update(JSON.stringify(stableInput)).digest("hex")}`;
}

export function createRestRouter(options: RestRouterOptions): RestRouter {
  if (!options.authority && options.unsafeLegacyScope !== true) {
    throw new Error("REST authority is required; unsafeLegacyScope is test-only and deprecated");
  }
  return {
    async handle(request: RestRequest): Promise<RestResponse> {
      const auth = authorizeRestRequest({
        remoteAddress: request.remoteAddress,
        protocol: request.protocol,
        headers: request.headers,
        config: options.server ?? {},
      });
      if (!auth.ok) {
        return { status: auth.status, body: { error: auth.message } };
      }

      if (request.path === "/v1/health") {
        if (request.method !== "GET") {
          return methodNotAllowed();
        }
        const health = await options.service.health();
        return { status: health.ok ? 200 : 503, body: health };
      }

      if (request.path === "/v1/memories") {
        if (request.method !== "POST") {
          return methodNotAllowed();
        }
        const body = requireObjectBody(request.body);
        const record = requireObjectBody(body?.record);
        if (!record) {
          return badRequest("record is required");
        }
        if (options.unsafeLegacyScope !== true) {
          let idempotencyKey = typeof body?.idempotencyKey === "string" && body.idempotencyKey.trim()
            ? body.idempotencyKey
            : undefined;
          if (!options.memoryWrite) {
            return { status: 503, body: { error: "Memory write capability is unavailable" } };
          }
          if (typeof record.text !== "string" || record.text.trim().length === 0) {
            return badRequest("record.text is required");
          }
          const scope = scopeOrResponse(options, record.scope ?? body?.scope);
          if (isRestResponse(scope)) return scope;
          idempotencyKey ??= legacyRestV1IdempotencyKey(scope, record);
          const metadata = requireObjectBody(record.metadata) ?? {};
          const provenance = requireObjectBody(record.provenance) ?? {};
          const result = await options.memoryWrite.executeMemoryWrite({
            type: "saveExplicit",
            idempotencyKey,
            serverAuthority: options.authority!,
            clientScope: scope,
            text: record.text,
            kind: (typeof record.kind === "string" ? record.kind : "other") as never,
            ...(typeof record.semanticType === "string"
              ? { semanticType: record.semanticType as never }
              : {}),
            ...(typeof record.container === "string" ? { container: record.container as never } : {}),
            ...(typeof record.confidence === "number" ? { confidence: record.confidence } : {}),
            ...(typeof record.category === "string" ? { category: record.category as never } : {}),
            ...(typeof record.dataType === "string" ? { dataType: record.dataType as never } : {}),
            ...(typeof record.tableName === "string" ? { tableName: record.tableName as never } : {}),
            metadata: { ...metadata, source: "user" },
            provenance: { ...provenance, source: "user" },
          });
          return writeResponse(result);
        }
        const scope = scopeOrResponse(options, record.scope ?? body?.scope);
        if (isRestResponse(scope)) return scope;
        return {
          status: 201,
          body: await options.service.storeMemory({
            record: { ...record, scope },
          } as never),
        };
      }

      if (request.path === "/v1/recall") {
        if (request.method !== "POST") {
          return methodNotAllowed();
        }
        const body = requireObjectBody(request.body);
        if (typeof body?.query !== "string") {
          return badRequest("query is required");
        }
        const scope = scopeOrResponse(options, body.scope);
        if (isRestResponse(scope)) return scope;
        const recalled = await options.service.recall({ ...body, scope } as unknown as RecallInput);
        const recallError = validateRecallResult(recalled);
        return recallError
          ? { status: 500, body: { error: recallError } }
          : { status: 200, body: recalled };
      }

      if (request.path === "/v1/context") {
        if (request.method !== "POST") {
          return methodNotAllowed();
        }
        const body = requireObjectBody(request.body);
        if (typeof body?.query !== "string") {
          return badRequest("query is required");
        }
        const scope = scopeOrResponse(options, body.scope);
        if (isRestResponse(scope)) return scope;
        const context = await options.service.buildContext(
          { ...body, scope } as unknown as BuildContextInput,
        );
        try {
          return {
            status: 200,
            body: requireContextBlockRecallReceipts(context),
          };
        } catch (error) {
          return {
            status: 500,
            body: {
              error: error instanceof Error ? error.message : RECALL_SCORE_BREAKDOWN_REQUIRED,
            },
          };
        }
      }

      if (request.path === "/v1/forget") {
        if (request.method !== "POST") {
          return methodNotAllowed();
        }
        const body = requireObjectBody(request.body);
        if (!body) {
          return badRequest("body is required");
        }
        const scope = scopeOrResponse(options, body.scope);
        if (isRestResponse(scope)) return scope;
        const idempotencyKey = typeof body.idempotencyKey === "string" && body.idempotencyKey.trim()
          ? body.idempotencyKey
          : undefined;
        if (!idempotencyKey) {
          return badRequest("idempotencyKey is required");
        }
        const action = body.action === undefined
          ? "delete"
          : body.action === "revoke" || body.action === "archive" || body.action === "delete"
            ? body.action
            : undefined;
        if (!action) {
          return badRequest("action is invalid");
        }
        let ids: string[] | undefined;
        if (body.ids !== undefined) {
          if (!Array.isArray(body.ids) || body.ids.length === 0) {
            return badRequest("ids must be a non-empty array");
          }
          ids = [];
          const seen = new Set<string>();
          for (const id of body.ids) {
            if (typeof id !== "string" || id.length === 0 || id !== id.trim() || seen.has(id)) {
              return badRequest("ids contain an invalid or duplicate value");
            }
            seen.add(id);
            ids.push(id);
          }
        }
        const filter = body.filter === undefined ? undefined : requireObjectBody(body.filter);
        if (body.filter !== undefined && (!filter || Object.keys(filter).length === 0)) {
          return badRequest("filter must be a non-empty object");
        }
        if ((ids === undefined) === (filter === undefined)) {
          return badRequest("exactly one of ids or filter is required");
        }
        const forgetService = options.forgetService ?? (
          typeof (options.service as unknown as { forget?: unknown }).forget === "function"
            ? options.service as unknown as NonNullable<RestRouterOptions["forgetService"]>
            : undefined
        );
        if (!forgetService || !options.authority) {
          return { status: 503, body: { error: "Authority-scoped forget is unavailable" } };
        }
        return {
          status: 200,
          body: await forgetService.forget({
            serverAuthority: options.authority,
            clientScope: {
              appId: scope.appId,
              projectId: scope.projectId,
              agentId: scope.agentId,
              namespace: scope.namespace,
              visibility: scope.visibility ?? "private",
            },
            action,
            ids,
            filter,
            tableName: body.tableName as never,
            dataTypes: Array.isArray(body.dataTypes) ? body.dataTypes as never : undefined,
            idempotencyKey,
            actor: typeof body.actor === "string" ? body.actor : undefined,
            reason: typeof body.reason === "string" ? body.reason : undefined,
          }),
        };
      }

      if (request.path === "/v1/graph/query") {
        if (!options.graph) {
          return notFound();
        }
        if (request.method !== "POST") {
          return methodNotAllowed();
        }
        const body = requireObjectBody(request.body);
        const scope = scopeOrResponse(options, body?.scope);
        if (isRestResponse(scope)) return scope;
        return {
          status: 200,
          body: await options.graph.query({ ...body, scope } as unknown as GraphQueryInput),
        };
      }

      if (request.path === "/v1/console/overview") {
        if (!options.console) {
          return notFound();
        }
        if (request.method !== "POST") {
          return methodNotAllowed();
        }
        const body = requireObjectBody(request.body);
        const scope = scopeOrResponse(options, body?.scope);
        if (isRestResponse(scope)) return scope;
        return {
          status: 200,
          body: await options.console.overview(scope),
        };
      }

      if (request.path === "/v1/console/lookup") {
        if (!options.console) {
          return notFound();
        }
        if (request.method !== "POST") {
          return methodNotAllowed();
        }
        const body = requireObjectBody(request.body);
        if (typeof body?.query !== "string") {
          return badRequest("query is required");
        }
        const scope = scopeOrResponse(options, body.scope);
        if (isRestResponse(scope)) return scope;
        return {
          status: 200,
          body: await options.console.lookup({ ...body, scope } as unknown as ConsoleLookupRequest),
        };
      }

      if (request.path === "/v1/console/graph") {
        if (!options.console) {
          return notFound();
        }
        if (request.method !== "POST") {
          return methodNotAllowed();
        }
        const body = requireObjectBody(request.body);
        const scope = scopeOrResponse(options, body?.scope);
        if (isRestResponse(scope)) return scope;
        return {
          status: 200,
          body: await options.console.graph({ ...body, scope } as unknown as GraphQueryInput),
        };
      }

      if (request.path === "/v1/console/jobs") {
        if (!options.console) {
          return notFound();
        }
        if (request.method !== "GET") {
          return methodNotAllowed();
        }
        return {
          status: 200,
          body: await options.console.jobs(),
        };
      }

      if (request.path === "/v1/console/candidates") {
        if (!options.console) {
          return notFound();
        }
        if (request.method !== "POST") {
          return methodNotAllowed();
        }
        const body = requireObjectBody(request.body);
        const scope = scopeOrResponse(options, body?.scope);
        if (isRestResponse(scope)) return scope;
        return {
          status: 200,
          body: await options.console.candidates({ ...body, scope } as unknown as ConsoleCandidatesRequest),
        };
      }

      if (request.path === "/v1/console/candidates/review") {
        if (!options.console) {
          return notFound();
        }
        if (request.method !== "POST") {
          return methodNotAllowed();
        }
        const body = requireObjectBody(request.body);
        const scope = scopeOrResponse(options, body?.scope);
        if (isRestResponse(scope)) return scope;
        const action = body?.action;
        if (!action || typeof action !== "object" || Array.isArray(action)) {
          return badRequest("action is required");
        }
        return {
          status: 200,
          body: await options.console.reviewCandidates(body as unknown as ConsoleCandidateReviewRequest),
        };
      }

      // v3.0 Agent 快路径端点
      if (request.path === "/v1/agent/context") {
        if (!options.agentFastPath) {
          return notFound();
        }
        if (request.method !== "POST") {
          return methodNotAllowed();
        }
        const body = requireObjectBody(request.body);
        if (typeof body?.task !== "string") {
          return badRequest("task is required");
        }
        const scope = scopeOrResponse(options, body.scope);
        if (isRestResponse(scope)) return scope;
        const context = await options.agentFastPath.context(
          { ...body, scope } as unknown as AgentTaskContextRequest,
        );
        try {
          return {
            status: 200,
            body: requireContextFastRecallReceipts(context),
          };
        } catch (error) {
          return {
            status: 500,
            body: {
              error: error instanceof Error ? error.message : CONTEXT_RECALL_BREAKDOWN_REQUIRED,
            },
          };
        }
      }

      if (request.path === "/v1/agent/observe") {
        if (!options.agentFastPath) {
          return notFound();
        }
        if (request.method !== "POST") {
          return methodNotAllowed();
        }
        const body = requireObjectBody(request.body);
        if (typeof body?.text !== "string") {
          return badRequest("text is required");
        }
        const scope = scopeOrResponse(options, body.scope);
        if (isRestResponse(scope)) return scope;
        return {
          status: 200,
          body: await options.agentFastPath.observeLight({ ...body, scope } as unknown as AgentObserveLightRequest),
        };
      }

      if (request.path === "/v1/agent/lookup") {
        if (!options.agentFastPath) {
          return notFound();
        }
        if (request.method !== "POST") {
          return methodNotAllowed();
        }
        const body = requireObjectBody(request.body);
        if (typeof body?.query !== "string") {
          return badRequest("query is required");
        }
        const scope = scopeOrResponse(options, body.scope);
        if (isRestResponse(scope)) return scope;
        const lookup = await options.agentFastPath.lookup(
          { ...body, scope } as unknown as AgentLookupRequest,
        );
        const lookupError = validateAgentLookupResult(lookup);
        return lookupError
          ? { status: 500, body: { error: lookupError } }
          : { status: 200, body: lookup };
      }

      if (request.path === "/v1/agent/session/commit") {
        if (!options.agentFastPath) {
          return notFound();
        }
        if (request.method !== "POST") {
          return methodNotAllowed();
        }
        const body = requireObjectBody(request.body);
        const scope = scopeOrResponse(options, body?.scope);
        if (isRestResponse(scope)) return scope;
        return {
          status: 200,
          body: await options.agentFastPath.sessionCommit({ ...body, scope } as unknown as AgentSessionCommitRequest),
        };
      }

      return notFound();
    },
  };
}
