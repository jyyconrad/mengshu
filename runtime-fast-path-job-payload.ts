import type { MemoryScope } from "./core/types.js";

/**
 * Fast-path durable job payload whitelist.
 * extract_candidate keeps only text, traceId, and intent.
 */
export function strictFastPathJobPayload(
  type: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const rawScope = payload.scope as MemoryScope | undefined;
  if (!rawScope) return payload;
  const scope: Record<string, unknown> = {
    tenantId: rawScope.tenantId,
    userId: rawScope.userId,
    appId: rawScope.appId,
    projectId: rawScope.projectId,
    agentId: rawScope.agentId,
    namespace: rawScope.namespace,
    visibility: rawScope.visibility,
    ...(rawScope.workspaceId === undefined ? {} : { workspaceId: rawScope.workspaceId }),
    ...(rawScope.sessionId === undefined ? {} : { sessionId: rawScope.sessionId }),
  };
  if (type === "extract_candidate") {
    return {
      scope,
      ...(payload.text === undefined ? {} : { text: payload.text }),
      ...(payload.traceId === undefined ? {} : { traceId: payload.traceId }),
      ...(payload.intent === undefined ? {} : { intent: payload.intent }),
    };
  }
  if (type === "build_tree") {
    return {
      scope,
      ...(payload.traceId === undefined ? {} : { traceId: payload.traceId }),
      ...(payload.treeType === undefined ? {} : { treeType: payload.treeType }),
      ...(payload.treeKey === undefined ? {} : { treeKey: payload.treeKey }),
      ...(payload.leaf === undefined ? {} : { leaf: payload.leaf }),
      ...(payload.routing === undefined ? {} : { routing: payload.routing }),
      ...(payload.targetIdempotencyKey === undefined
        ? {}
        : { targetIdempotencyKey: payload.targetIdempotencyKey }),
    };
  }
  if (type === "extract_graph") {
    return {
      scope,
      ...(payload.chunkId === undefined ? {} : { chunkId: payload.chunkId }),
      ...(payload.text === undefined ? {} : { text: payload.text }),
      ...(payload.sourceId === undefined ? {} : { sourceId: payload.sourceId }),
      ...(payload.context === undefined ? {} : { context: payload.context }),
    };
  }
  return payload;
}
