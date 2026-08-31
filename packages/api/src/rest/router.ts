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
import { MemoryEvolutionError } from
  "../../../core/src/temporal/memory-evolution-service.js";
import { TemporalTimeResolutionError } from
  "../../../core/src/temporal/time-resolution.js";
import { SessionWorkingSetError } from
  "../../../core/src/working-set/session-working-set-service.js";
import { SkillArtifactError } from
  "../../../core/src/skills/skill-artifact-service.js";
import { MemoryPolicyOverlayError } from
  "../../../core/src/policy/memory-policy-overlay.js";
import type {
  IngestToolPairInput,
  PromoteWorkingSetClaimInput,
  ReadSessionPayloadInput,
  RecordTaskBoundaryInput,
  SessionAssembleInput,
} from "../../../core/src/working-set/types.js";
import type {
  ProposeSkillInput,
  CuratedSkillImportInput,
  AppendSkillVersionInput,
  PublishSkillInput,
  RevokeSkillInput,
  ReviewSkillInput,
  SearchSkillInput,
} from "../../../core/src/skills/types.js";
import type { AppendMemoryPolicyOverlayInput, MemoryPolicyLayer } from
  "../../../core/src/policy/types.js";

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
      memoryEvolution: runtime.memoryEvolution,
      sessionWorkingSet: runtime.sessionWorkingSet,
      sessionWorkingSetMemoryBridge: runtime.sessionWorkingSetMemoryBridge,
      skillArtifacts: runtime.skillArtifacts,
      memoryPolicyOverlays: runtime.memoryPolicyOverlays,
      memoryPolicyResolver: runtime.memoryPolicyResolver,
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

function temporalError(error: unknown): RestResponse {
  if (error instanceof TemporalTimeResolutionError) {
    return { status: 400, body: { error: error.code } };
  }
  if (!(error instanceof MemoryEvolutionError)) {
    return { status: 500, body: { error: "Temporal memory operation failed" } };
  }
  if (error.code === "MEMORY_EVOLUTION_INVALID" ||
      error.code === "MEMORY_PURGE_CONFIRMATION_REQUIRED") {
    return { status: 400, body: { error: error.code } };
  }
  if (error.code === "MEMORY_LINEAGE_NOT_FOUND" ||
      error.code === "MEMORY_VERSION_NOT_FOUND") {
    return { status: 404, body: { error: error.code } };
  }
  if (error.code === "MEMORY_PURGE_PENDING") {
    return { status: 503, body: { error: error.code } };
  }
  return { status: 409, body: { error: error.code } };
}

function extensionError(error: unknown): RestResponse {
  if (error instanceof SessionWorkingSetError || error instanceof SkillArtifactError ||
      error instanceof MemoryPolicyOverlayError) {
    const code = error.code;
    if (code.includes("NOT_FOUND")) return { status: 404, body: { error: code } };
    if (code.includes("STALE") || code.includes("CONFLICT")) {
      return { status: 409, body: { error: code } };
    }
    if (code.includes("UNAVAILABLE")) return { status: 503, body: { error: code } };
    return { status: 400, body: { error: code } };
  }
  return { status: 500, body: { error: "Memory extension operation failed" } };
}

function temporalInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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

      if (request.path === "/v1/runtime") {
        if (!options.runtimeControl) return notFound();
        if (request.method !== "GET") return methodNotAllowed();
        try {
          return { status: 200, body: options.runtimeControl.snapshot() };
        } catch {
          return { status: 503, body: { error: "Runtime control plane is unavailable" } };
        }
      }

      if (request.path === "/v1/runtime/mcp-tools") {
        if (!options.runtimeControl || !options.runtimeMcp) return notFound();
        if (request.method !== "GET") return methodNotAllowed();
        return { status: 200, body: { tools: options.runtimeMcp.listTools() } };
      }

      if (request.path === "/v1/runtime/mcp-call") {
        if (!options.runtimeControl || !options.runtimeMcp) return notFound();
        if (request.method !== "POST") return methodNotAllowed();
        const body = requireObjectBody(request.body);
        const args = requireObjectBody(body?.arguments);
        if (!body || typeof body.name !== "string" || body.name.trim().length === 0 ||
            !args || Object.keys(body).some((key) => key !== "name" && key !== "arguments")) {
          return badRequest("runtime MCP call is invalid");
        }
        try {
          return { status: 200, body: await options.runtimeMcp.callTool(body.name, args) };
        } catch {
          return { status: 500, body: { error: "Runtime MCP operation failed" } };
        }
      }

      if (request.path.startsWith("/v1/session/working-set/") ||
          request.path === "/v1/session/task-boundary") {
        if (!options.sessionWorkingSet) return notFound();
        if (request.method !== "POST") return methodNotAllowed();
        const body = requireObjectBody(request.body);
        if (!body || typeof body.sessionId !== "string") return badRequest("sessionId is required");
        const scope = scopeOrResponse(options, body.scope);
        if (isRestResponse(scope)) return scope;
        try {
          if (request.path === "/v1/session/working-set/promote") {
            if (!options.sessionWorkingSetMemoryBridge) return notFound();
            return {
              status: 201,
              body: await options.sessionWorkingSetMemoryBridge.promoteClaim({
                ...body,
                scope,
              } as unknown as PromoteWorkingSetClaimInput),
            };
          }
          if (request.path === "/v1/session/working-set/tool-pair") {
            return {
              status: 201,
              body: await options.sessionWorkingSet.ingestToolPair({
                ...body,
                scope,
              } as unknown as IngestToolPairInput),
            };
          }
          if (request.path === "/v1/session/task-boundary") {
            return {
              status: 201,
              body: await options.sessionWorkingSet.recordTaskBoundary({
                ...body,
                scope,
              } as unknown as RecordTaskBoundaryInput),
            };
          }
          if (request.path === "/v1/session/working-set/assemble") {
            return {
              status: 200,
              body: await options.sessionWorkingSet.assemble({
                ...body,
                scope,
              } as unknown as SessionAssembleInput),
            };
          }
          if (request.path === "/v1/session/working-set/rewrite/explain") {
            if (typeof body.receiptId !== "string") return badRequest("receiptId is required");
            return {
              status: 200,
              body: await options.sessionWorkingSet.explainRewrite(
                body.receiptId,
                scope,
                body.sessionId,
              ),
            };
          }
          if (request.path === "/v1/session/working-set/payload/read") {
            return {
              status: 200,
              body: await options.sessionWorkingSet.readPayload({
                ...body,
                scope,
              } as unknown as ReadSessionPayloadInput),
            };
          }
          if (request.path === "/v1/session/working-set/close") {
            return {
              status: 200,
              body: await options.sessionWorkingSet.closeSession(scope, body.sessionId),
            };
          }
          return notFound();
        } catch (error) {
          return extensionError(error);
        }
      }

      if (request.path.startsWith("/v1/skills/")) {
        if (!options.skillArtifacts) return notFound();
        if (request.method !== "POST") return methodNotAllowed();
        const body = requireObjectBody(request.body);
        if (!body) return badRequest("request body is required");
        const scope = scopeOrResponse(options, body.scope);
        if (isRestResponse(scope)) return scope;
        try {
          if (request.path === "/v1/skills/propose") {
            return { status: 201, body: await options.skillArtifacts.proposeFromCandidate({
              ...body, scope,
            } as unknown as ProposeSkillInput) };
          }
          if (request.path === "/v1/skills/import-curated") {
            return { status: 201, body: await options.skillArtifacts.importCurated({
              ...body, scope,
            } as unknown as CuratedSkillImportInput) };
          }
          if (request.path === "/v1/skills/review") {
            return { status: 201, body: await options.skillArtifacts.review({
              ...body, scope,
            } as unknown as ReviewSkillInput) };
          }
          if (request.path === "/v1/skills/publish") {
            return { status: 201, body: await options.skillArtifacts.publish({
              ...body, scope,
            } as unknown as PublishSkillInput) };
          }
          if (request.path === "/v1/skills/append") {
            return { status: 201, body: await options.skillArtifacts.appendVersion({
              ...body, scope,
            } as unknown as AppendSkillVersionInput) };
          }
          if (request.path === "/v1/skills/revoke") {
            return { status: 201, body: await options.skillArtifacts.revoke({
              ...body, scope,
            } as unknown as RevokeSkillInput) };
          }
          if (request.path === "/v1/skills/read") {
            if (typeof body.skillId !== "string") return badRequest("skillId is required");
            return { status: 200, body: await options.skillArtifacts.read({
              scope, skillId: body.skillId,
              ...(typeof body.version === "number" ? { version: body.version } : {}),
            }) };
          }
          if (request.path === "/v1/skills/search") {
            return { status: 200, body: await options.skillArtifacts.search({
              ...body, scope,
            } as unknown as SearchSkillInput) };
          }
          if (request.path === "/v1/skills/explain") {
            if (typeof body.skillId !== "string") return badRequest("skillId is required");
            return { status: 200, body: await options.skillArtifacts.explain({
              scope, skillId: body.skillId,
              ...(typeof body.version === "number" ? { version: body.version } : {}),
            }) };
          }
          return notFound();
        } catch (error) {
          return extensionError(error);
        }
      }

      if (request.path === "/v1/memory-policy/versions" ||
          request.path === "/v1/memory-policy/resolve") {
        if (request.method !== "POST") return methodNotAllowed();
        const body = requireObjectBody(request.body);
        if (!body) return badRequest("request body is required");
        const scope = scopeOrResponse(options, body.scope);
        if (isRestResponse(scope)) return scope;
        try {
          if (request.path === "/v1/memory-policy/versions") {
            if (!options.memoryPolicyOverlays) return notFound();
            return { status: 201, body: await options.memoryPolicyOverlays.appendVersion({
              ...body, scope,
            } as unknown as AppendMemoryPolicyOverlayInput) };
          }
          if (!options.memoryPolicyResolver || typeof body.layer !== "string") return notFound();
          return { status: 200, body: await options.memoryPolicyResolver.resolve({
            scope, layer: body.layer as MemoryPolicyLayer,
          }) };
        } catch (error) {
          return extensionError(error);
        }
      }

      if (request.path === "/v1/memories/history" ||
          request.path === "/v1/recall/as-of" ||
          request.path === "/v1/memories/expire" ||
          request.path === "/v1/memories/revoke" ||
          request.path === "/v1/memories/purge") {
        if (!options.memoryEvolution) return notFound();
        if (request.method !== "POST") return methodNotAllowed();
        const body = requireObjectBody(request.body);
        if (!body || typeof body.lineageId !== "string" ||
            body.lineageId.length === 0 || body.lineageId !== body.lineageId.trim()) {
          return badRequest("lineageId is required");
        }
        const scope = scopeOrResponse(options, body.scope);
        if (isRestResponse(scope)) return scope;
        try {
          if (request.path === "/v1/memories/history") {
            return {
              status: 200,
              body: await options.memoryEvolution.history({
                scope,
                lineageId: body.lineageId,
              }),
            };
          }
          if (request.path === "/v1/recall/as-of") {
            if (typeof body.asOf === "string") {
              const timezoneOffsetMinutes = body.timezoneOffsetMinutes;
              if ((body.knownAt !== undefined && typeof body.knownAt !== "string" &&
                    !temporalInteger(body.knownAt)) ||
                  (timezoneOffsetMinutes !== undefined &&
                    (typeof timezoneOffsetMinutes !== "number" ||
                      !Number.isInteger(timezoneOffsetMinutes) ||
                      timezoneOffsetMinutes < -840 || timezoneOffsetMinutes > 840)) ||
                  (body.anchorAt !== undefined && !temporalInteger(body.anchorAt))) {
                return badRequest("temporal expression parameters are invalid");
              }
              return {
                status: 200,
                body: await options.memoryEvolution.recallAsOfResolved({
                  scope,
                  lineageId: body.lineageId,
                  asOf: body.asOf,
                  ...(body.knownAt === undefined ? {} : { knownAt: body.knownAt as string | number }),
                  ...(timezoneOffsetMinutes === undefined
                    ? {}
                    : { timezoneOffsetMinutes }),
                  ...(body.anchorAt === undefined ? {} : { anchorAt: body.anchorAt }),
                }),
              };
            }
            if (!temporalInteger(body.asOf) ||
                (body.knownAt !== undefined && !temporalInteger(body.knownAt))) {
              return badRequest("asOf/knownAt must be epoch milliseconds or a resolvable expression");
            }
            return {
              status: 200,
              body: await options.memoryEvolution.recallAsOf({
                scope,
                lineageId: body.lineageId,
                asOf: body.asOf,
                ...(body.knownAt === undefined ? {} : { knownAt: body.knownAt }),
              }),
            };
          }
          if (request.path === "/v1/memories/expire") {
            if (!temporalInteger(body.expectedHeadRevision) ||
                body.expectedHeadRevision < 1 || !temporalInteger(body.validTo) ||
                typeof body.idempotencyKey !== "string") {
              return badRequest("expire parameters are invalid");
            }
            return {
              status: 200,
              body: await options.memoryEvolution.expire({
                scope,
                lineageId: body.lineageId,
                expectedHeadRevision: body.expectedHeadRevision,
                validTo: body.validTo,
                ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
                idempotencyKey: body.idempotencyKey,
              }),
            };
          }
          if (request.path === "/v1/memories/revoke") {
            if (!temporalInteger(body.expectedHeadRevision) ||
                body.expectedHeadRevision < 1 || typeof body.reason !== "string" ||
                typeof body.idempotencyKey !== "string") {
              return badRequest("revoke parameters are invalid");
            }
            return {
              status: 200,
              body: await options.memoryEvolution.revoke({
                scope,
                lineageId: body.lineageId,
                expectedHeadRevision: body.expectedHeadRevision,
                reason: body.reason,
                idempotencyKey: body.idempotencyKey,
              }),
            };
          }
          if (typeof body.idempotencyKey !== "string" ||
              typeof body.confirmation !== "string") {
            return badRequest("purge parameters are invalid");
          }
          return {
            status: 200,
            body: await options.memoryEvolution.purge({
              scope,
              lineageId: body.lineageId,
              confirmation: body.confirmation,
              idempotencyKey: body.idempotencyKey,
            }),
          };
        } catch (error) {
          return temporalError(error);
        }
      }

      if (request.path === "/v1/memories/evolve" ||
          request.path === "/v1/memories/correct" ||
          request.path === "/v1/memories/restore") {
        if (!options.memoryEvolution || !options.memoryWrite) return notFound();
        if (request.method !== "POST") return methodNotAllowed();
        const body = requireObjectBody(request.body);
        const evidenceIds = Array.isArray(body?.evidenceIds) &&
            body.evidenceIds.length > 0 &&
            body.evidenceIds.every((id) => typeof id === "string" && id.length > 0)
          ? body.evidenceIds as string[]
          : undefined;
        if (!body || typeof body.lineageId !== "string" ||
            typeof body.text !== "string" || body.text.trim().length === 0 ||
            typeof body.kind !== "string" || typeof body.semanticType !== "string" ||
            typeof body.idempotencyKey !== "string" ||
            !temporalInteger(body.expectedHeadRevision) || body.expectedHeadRevision < 1 ||
            !temporalInteger(body.validFrom) || !evidenceIds) {
          return badRequest("temporal write parameters are invalid");
        }
        const transitionType = request.path === "/v1/memories/evolve"
          ? "evolved" as const
          : request.path === "/v1/memories/correct"
          ? "corrected" as const
          : "restored" as const;
        if (transitionType !== "restored" && typeof body.expectedHeadVersionId !== "string") {
          return badRequest("expectedHeadVersionId is required");
        }
        if (transitionType === "restored" && typeof body.sourceVersionId !== "string") {
          return badRequest("sourceVersionId is required");
        }
        const scope = scopeOrResponse(options, body.scope);
        if (isRestResponse(scope)) return scope;
        try {
          const metadata = requireObjectBody(body.metadata) ?? {};
          const provenance = requireObjectBody(body.provenance) ?? {};
          const targetId = typeof body.expectedHeadVersionId === "string"
            ? body.expectedHeadVersionId
            : body.sourceVersionId as string;
          const result = await options.memoryWrite.executeMemoryWrite({
            type: "correctMemory",
            correctionKind: "replaceText",
            targetId,
            idempotencyKey: body.idempotencyKey,
            serverAuthority: options.authority!,
            clientScope: scope,
            text: body.text,
            kind: body.kind as never,
            semanticType: body.semanticType as never,
            ...(typeof body.container === "string" ? { container: body.container as never } : {}),
            ...(typeof body.confidence === "number" ? { confidence: body.confidence } : {}),
            ...(typeof body.category === "string" ? { category: body.category as never } : {}),
            dataType: "memory",
            tableName: "memories",
            evidenceIds,
            metadata: { ...metadata, source: "user" },
            provenance: { ...provenance, source: "user" },
            temporal: {
              lineageId: body.lineageId,
              expectedHeadRevision: body.expectedHeadRevision,
              ...(typeof body.expectedHeadVersionId === "string"
                ? { expectedHeadVersionId: body.expectedHeadVersionId }
                : {}),
              validFrom: body.validFrom,
              transitionType,
              ...(transitionType === "restored"
                ? { restoredFromVersionId: body.sourceVersionId as string }
                : {}),
              ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
            },
          });
          return writeResponse(result);
        } catch (error) {
          return temporalError(error);
        }
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
