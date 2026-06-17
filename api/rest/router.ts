/**
 * MemoryService REST router.
 *
 * 该 router 只负责鉴权、路由和 JSON 契约，不直接依赖 Node HTTP 或 OpenClaw。
 * Node daemon 负责把 IncomingMessage 解析成 RestRequest。
 */

import type {
  BuildContextInput,
  RecallInput,
  StoreMemoryInput,
} from "../../core/service-types.js";
import type { GraphQueryInput } from "../../graph/query.js";
import type { ConsoleCandidatesRequest, ConsoleCandidateReviewRequest, ConsoleLookupRequest } from "../../console/types.js";
import type { MemoryScope } from "../../core/types.js";
import { authorizeRestRequest } from "./auth.js";
import type { RestRequest, RestResponse, RestRouterOptions } from "./types.js";
import type {
  AgentTaskContextRequest,
  AgentObserveLightRequest,
  AgentLookupRequest,
  AgentSessionCommitRequest,
} from "../agent-fast-path.js";

export interface RestRouter {
  handle(request: RestRequest): Promise<RestResponse>;
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

function requireObjectBody(body: unknown): Record<string, unknown> | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  return body as Record<string, unknown>;
}

export function createRestRouter(options: RestRouterOptions): RestRouter {
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
        return { status: 200, body: await options.service.health() };
      }

      if (request.path === "/v1/memories") {
        if (request.method !== "POST") {
          return methodNotAllowed();
        }
        const body = requireObjectBody(request.body);
        if (!body?.record) {
          return badRequest("record is required");
        }
        return {
          status: 201,
          body: await options.service.storeMemory(body as unknown as StoreMemoryInput),
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
        return {
          status: 200,
          body: await options.service.recall(body as unknown as RecallInput),
        };
      }

      if (request.path === "/v1/context") {
        if (request.method !== "POST") {
          return methodNotAllowed();
        }
        const body = requireObjectBody(request.body);
        if (typeof body?.query !== "string") {
          return badRequest("query is required");
        }
        return {
          status: 200,
          body: await options.service.buildContext(body as unknown as BuildContextInput),
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
        if (!body?.scope || typeof body.scope !== "object" || Array.isArray(body.scope)) {
          return badRequest("scope is required");
        }
        return {
          status: 200,
          body: await options.graph.query(body as unknown as GraphQueryInput),
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
        if (!body?.scope || typeof body.scope !== "object" || Array.isArray(body.scope)) {
          return badRequest("scope is required");
        }
        return {
          status: 200,
          body: await options.console.overview(body.scope as MemoryScope),
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
        if (!body?.scope || typeof body.scope !== "object" || Array.isArray(body.scope)) {
          return badRequest("scope is required");
        }
        if (typeof body.query !== "string") {
          return badRequest("query is required");
        }
        return {
          status: 200,
          body: await options.console.lookup(body as unknown as ConsoleLookupRequest),
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
        if (!body?.scope || typeof body.scope !== "object" || Array.isArray(body.scope)) {
          return badRequest("scope is required");
        }
        return {
          status: 200,
          body: await options.console.graph(body as unknown as GraphQueryInput),
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
        if (!body?.scope || typeof body.scope !== "object" || Array.isArray(body.scope)) {
          return badRequest("scope is required");
        }
        return {
          status: 200,
          body: await options.console.candidates(body as unknown as ConsoleCandidatesRequest),
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
        return {
          status: 200,
          body: await options.agentFastPath.context(body as unknown as AgentTaskContextRequest),
        };
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
        return {
          status: 200,
          body: await options.agentFastPath.observeLight(body as unknown as AgentObserveLightRequest),
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
        return {
          status: 200,
          body: await options.agentFastPath.lookup(body as unknown as AgentLookupRequest),
        };
      }

      if (request.path === "/v1/agent/session/commit") {
        if (!options.agentFastPath) {
          return notFound();
        }
        if (request.method !== "POST") {
          return methodNotAllowed();
        }
        const body = requireObjectBody(request.body);
        return {
          status: 200,
          body: await options.agentFastPath.sessionCommit(body as unknown as AgentSessionCommitRequest),
        };
      }

      return notFound();
    },
  };
}
