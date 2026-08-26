import { randomUUID } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import type { MemoryScope } from "./core/types.js";
import {
  DURABLE_JOB_V2_AUTHORITATIVE_TYPES,
  DURABLE_JOB_V2_SAFE_IDENTIFIER_MAX_LENGTH,
  assertDurableJobV2,
  deriveDurableJobV2DomainDedupeKey,
  deriveDurableJobV2ScopedDedupeKey,
  isDurableJobV2SafeIdentifier,
  type DurableJobV2Scope,
} from "./packages/core/src/storage/repositories/job-v2.js";
import {
  assertProviderOwnedPostgresDurableJobV2RuntimeBundle,
  type PostgresDurableJobV2RuntimeBundle,
} from "./packages/core/src/db/providers/postgres.js";
import {
  planTreeFanOut,
  type TreeFanOutRoutingInput,
} from "./packages/core/src/tree/tree-fan-out.js";

export type RuntimeDurableJobV2Type = (typeof DURABLE_JOB_V2_AUTHORITATIVE_TYPES)[number];

export type RuntimeDurableJobV2ErrorCode =
  | "CAPABILITY_UNAVAILABLE"
  | "JOB_TYPE_UNSUPPORTED"
  | "JOB_SCOPE_MISMATCH"
  | "JOB_PAYLOAD_INVALID"
  | "REPOSITORY_RESULT_INVALID";

export class RuntimeDurableJobV2Error extends Error {
  readonly code: RuntimeDurableJobV2ErrorCode;

  constructor(code: RuntimeDurableJobV2ErrorCode) {
    super("Durable job v2 runtime operation failed");
    this.name = "RuntimeDurableJobV2Error";
    this.code = code;
  }
}

export const RUNTIME_DURABLE_JOB_V2_LIMITATIONS = Object.freeze({
  ingestionStoreJobs: "legacy_v1_not_consumed_by_v2" as const,
  sessionCommit: "unsupported_v2_job_types_fail_closed" as const,
  nativeHandlers: "required_for_production_serve" as const,
  providerBinding: "trusted_composition_must_bind_runtime_db" as const,
});

export interface RuntimeDurableJobV2Enqueuer {
  enqueue(input: {
    readonly type: string;
    readonly payload: Record<string, unknown>;
  }): Promise<string>;
}

export interface RuntimeDurableJobV2EnqueueCapability {
  readonly runtimeBundle: PostgresDurableJobV2RuntimeBundle;
  readonly scope: DurableJobV2Scope;
}

const EXTRACT_CANDIDATE_DEDUPE_PREFIX = "extract_candidate:";
const EXTRACT_CANDIDATE_TRACE_ID_MAX_LENGTH =
  DURABLE_JOB_V2_SAFE_IDENTIFIER_MAX_LENGTH - EXTRACT_CANDIDATE_DEDUPE_PREFIX.length;
const BUILD_TREE_PAYLOAD_REQUIRED = Object.freeze([
  "scope", "traceId", "treeType", "treeKey", "leaf",
] as const);
const BUILD_TREE_PAYLOAD_OPTIONAL = Object.freeze([
  "routing", "targetIdempotencyKey",
] as const);
const BUILD_TREE_LEAF_REQUIRED = Object.freeze([
  "id", "chunkId", "sourceId", "text", "eventAt",
] as const);
const BUILD_TREE_LEAF_OPTIONAL = Object.freeze(["entityIds"] as const);
const BUILD_TREE_ROUTING_REQUIRED = Object.freeze([
  "valueScore", "importance", "semanticType", "scopeVisibility", "riskFlags",
  "topicHotnessEligible",
] as const);
const BUILD_TREE_ROUTING_OPTIONAL = Object.freeze([
  "topicLabels", "explicitGlobal", "isWorkspaceRule",
] as const);
const BUILD_TREE_SEMANTIC_TYPES = new Set([
  "profile", "task_context", "rules", "experience", "resource",
]);
const BUILD_TREE_SCOPE_VISIBILITIES = new Set([
  "session", "project", "workspace", "app", "user", "global",
]);
const BUILD_TREE_TYPES = new Set(["source", "topic", "global"]);
const BUILD_TREE_MAX_TEXT_LENGTH = 100_000;
const BUILD_TREE_UNSAFE_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
const BUILD_TREE_UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

function runtimeError(code: RuntimeDurableJobV2ErrorCode): never {
  throw new RuntimeDurableJobV2Error(code);
}

function canonicalScope(scope: MemoryScope): DurableJobV2Scope | undefined {
  if (!scope || typeof scope !== "object" || scope.visibility === undefined) return undefined;
  const candidate: DurableJobV2Scope = {
    tenantId: scope.tenantId,
    userId: scope.userId,
    appId: scope.appId,
    projectId: scope.projectId,
    agentId: scope.agentId,
    namespace: scope.namespace,
    visibility: scope.visibility,
  };
  try {
    deriveDurableJobV2ScopedDedupeKey(candidate, "runtime-enqueue-scope-validation");
    return Object.freeze(candidate);
  } catch {
    return undefined;
  }
}

function sameScope(left: DurableJobV2Scope, right: DurableJobV2Scope): boolean {
  return left.tenantId === right.tenantId && left.userId === right.userId &&
    left.appId === right.appId && left.projectId === right.projectId &&
    left.agentId === right.agentId && left.namespace === right.namespace &&
    left.visibility === right.visibility;
}

function snapshotEnqueueCapability(
  value: unknown,
): RuntimeDurableJobV2EnqueueCapability | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        nodeUtilTypes.isProxy(value)) {
      return undefined;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || !keys.includes("runtimeBundle") || !keys.includes("scope") ||
        keys.some((key) => typeof key !== "string" ||
          (key !== "runtimeBundle" && key !== "scope"))) {
      return undefined;
    }
    const bundleDescriptor = Object.getOwnPropertyDescriptor(value, "runtimeBundle");
    const scopeDescriptor = Object.getOwnPropertyDescriptor(value, "scope");
    if (!bundleDescriptor?.enumerable || !("value" in bundleDescriptor) ||
        !scopeDescriptor?.enumerable || !("value" in scopeDescriptor)) {
      return undefined;
    }
    const runtimeBundle = assertProviderOwnedPostgresDurableJobV2RuntimeBundle(
      bundleDescriptor.value,
    );
    const scope = canonicalScope(scopeDescriptor.value as MemoryScope);
    if (!scope) return undefined;
    return Object.freeze({ runtimeBundle, scope });
  } catch {
    return undefined;
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dataProperty(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor?.enumerable || !("value" in descriptor)) runtimeError("JOB_PAYLOAD_INVALID");
  return descriptor.value;
}

/** Strict JSON clone aligned with job-v2: no silent dropping or exotic own properties. */
function cloneJson(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) runtimeError("JOB_PAYLOAD_INVALID");
    return value;
  }
  if (typeof value !== "object" || ancestors.has(value)) runtimeError("JOB_PAYLOAD_INVALID");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.some((key) => typeof key !== "string" ||
          (key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) ||
            !Number.isSafeInteger(Number(key)) || Number(key) >= value.length)))) {
        runtimeError("JOB_PAYLOAD_INVALID");
      }
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) runtimeError("JOB_PAYLOAD_INVALID");
        const item = dataProperty(value as unknown as Record<string, unknown>, String(index));
        if (item === undefined) runtimeError("JOB_PAYLOAD_INVALID");
        result.push(cloneJson(item, ancestors));
      }
      return result;
    }
    if (!plainRecord(value)) runtimeError("JOB_PAYLOAD_INVALID");
    const result: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") runtimeError("JOB_PAYLOAD_INVALID");
      const item = dataProperty(value, key);
      if (item === undefined) runtimeError("JOB_PAYLOAD_INVALID");
      result[key] = cloneJson(item, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function payloadScope(
  payload: Record<string, unknown>,
  expected: DurableJobV2Scope,
): Record<string, unknown> {
  const raw = dataProperty(payload, "scope");
  if (!plainRecord(raw)) runtimeError("JOB_PAYLOAD_INVALID");
  const cloned = cloneJson(raw) as Record<string, unknown>;
  const allowed = new Set([
    "tenantId",
    "userId",
    "appId",
    "projectId",
    "agentId",
    "namespace",
    "visibility",
    "workspaceId",
    "sessionId",
  ]);
  if (Object.keys(cloned).some((key) => !allowed.has(key))) {
    runtimeError("JOB_PAYLOAD_INVALID");
  }
  const candidate = canonicalScope(cloned as unknown as MemoryScope);
  if (!candidate || !sameScope(candidate, expected)) runtimeError("JOB_SCOPE_MISMATCH");
  for (const optional of ["workspaceId", "sessionId"] as const) {
    const value = cloned[optional];
    if (value !== undefined && !isDurableJobV2SafeIdentifier(value)) {
      runtimeError("JOB_PAYLOAD_INVALID");
    }
  }
  return cloned;
}

function requiredIdentity(
  value: unknown,
  maxLength: number = DURABLE_JOB_V2_SAFE_IDENTIFIER_MAX_LENGTH,
): string {
  if (!isDurableJobV2SafeIdentifier(value) || value.length > maxLength) {
    runtimeError("JOB_PAYLOAD_INVALID");
  }
  return value;
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!plainRecord(value)) runtimeError("JOB_PAYLOAD_INVALID");
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (keys.length < required.length || keys.some((key) => !allowed.has(key)) ||
      required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    runtimeError("JOB_PAYLOAD_INVALID");
  }
  return value;
}

function buildTreeText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    value.length <= BUILD_TREE_MAX_TEXT_LENGTH && !BUILD_TREE_UNSAFE_TEXT.test(value) &&
    !BUILD_TREE_UNPAIRED_SURROGATE.test(value);
}

function buildTreeScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function buildTreeStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => !buildTreeText(item))) {
    runtimeError("JOB_PAYLOAD_INVALID");
  }
  return value as string[];
}

function buildTreeIdArray(value: unknown): string[] {
  if (!Array.isArray(value)) runtimeError("JOB_PAYLOAD_INVALID");
  const ids = value.map((item) => requiredIdentity(item));
  if (new Set(ids).size !== ids.length) runtimeError("JOB_PAYLOAD_INVALID");
  return ids;
}

function buildTreeRouting(value: unknown): TreeFanOutRoutingInput {
  const routing = exactRecord(
    value,
    BUILD_TREE_ROUTING_REQUIRED,
    BUILD_TREE_ROUTING_OPTIONAL,
  );
  if (!buildTreeScore(routing.valueScore) || !buildTreeScore(routing.importance) ||
      typeof routing.semanticType !== "string" ||
      !BUILD_TREE_SEMANTIC_TYPES.has(routing.semanticType) ||
      typeof routing.scopeVisibility !== "string" ||
      !BUILD_TREE_SCOPE_VISIBILITIES.has(routing.scopeVisibility) ||
      typeof routing.topicHotnessEligible !== "boolean") {
    runtimeError("JOB_PAYLOAD_INVALID");
  }
  for (const field of ["explicitGlobal", "isWorkspaceRule"] as const) {
    if (Object.prototype.hasOwnProperty.call(routing, field) &&
        typeof routing[field] !== "boolean") {
      runtimeError("JOB_PAYLOAD_INVALID");
    }
  }
  const riskFlags = buildTreeStringArray(routing.riskFlags);
  const topicLabels = Object.prototype.hasOwnProperty.call(routing, "topicLabels")
    ? buildTreeStringArray(routing.topicLabels)
    : undefined;
  return {
    valueScore: routing.valueScore,
    importance: routing.importance,
    semanticType: routing.semanticType,
    scopeVisibility: routing.scopeVisibility,
    riskFlags,
    topicHotnessEligible: routing.topicHotnessEligible,
    ...(topicLabels === undefined ? {} : { topicLabels }),
    ...(routing.explicitGlobal === undefined
      ? {}
      : { explicitGlobal: routing.explicitGlobal }),
    ...(routing.isWorkspaceRule === undefined
      ? {}
      : { isWorkspaceRule: routing.isWorkspaceRule }),
  } as TreeFanOutRoutingInput;
}

function canonicalizeBuildTreePayload(
  cloned: Record<string, unknown>,
  scope: DurableJobV2Scope,
): { readonly payload: Record<string, unknown>; readonly identity: string } {
  exactRecord(cloned, BUILD_TREE_PAYLOAD_REQUIRED, BUILD_TREE_PAYLOAD_OPTIONAL);
  const traceId = requiredIdentity(cloned.traceId);
  if (typeof cloned.treeType !== "string" || !BUILD_TREE_TYPES.has(cloned.treeType)) {
    runtimeError("JOB_PAYLOAD_INVALID");
  }
  const treeKey = requiredIdentity(cloned.treeKey);
  const leaf = exactRecord(cloned.leaf, BUILD_TREE_LEAF_REQUIRED, BUILD_TREE_LEAF_OPTIONAL);
  if (requiredIdentity(leaf.id) !== traceId) {
    runtimeError("JOB_PAYLOAD_INVALID");
  }
  const chunkId = requiredIdentity(leaf.chunkId);
  const sourceId = requiredIdentity(leaf.sourceId);
  const entityIds = Object.prototype.hasOwnProperty.call(leaf, "entityIds")
    ? buildTreeIdArray(leaf.entityIds)
    : [];
  if (!buildTreeText(leaf.text) || !Number.isSafeInteger(leaf.eventAt) ||
      (leaf.eventAt as number) < 0) {
    runtimeError("JOB_PAYLOAD_INVALID");
  }

  const hasRouting = Object.prototype.hasOwnProperty.call(cloned, "routing");
  const hasTargetIdempotencyKey = Object.prototype.hasOwnProperty.call(
    cloned,
    "targetIdempotencyKey",
  );
  if (hasRouting !== hasTargetIdempotencyKey) runtimeError("JOB_PAYLOAD_INVALID");
  if (!hasRouting) {
    if (cloned.treeType !== "source" || treeKey !== sourceId) {
      runtimeError("JOB_PAYLOAD_INVALID");
    }
    return { payload: cloned, identity: traceId };
  }

  const targetIdempotencyKey = requiredIdentity(cloned.targetIdempotencyKey);
  const routing = buildTreeRouting(cloned.routing);
  const payloadScope = cloned.scope as Record<string, unknown>;
  const fullScope: MemoryScope = {
    ...scope,
    ...(typeof payloadScope.workspaceId === "string"
      ? { workspaceId: payloadScope.workspaceId }
      : {}),
    ...(typeof payloadScope.sessionId === "string"
      ? { sessionId: payloadScope.sessionId }
      : {}),
  };
  try {
    const matchingTargets = planTreeFanOut({
      scope: fullScope,
      leaf: {
        id: traceId,
        scope: fullScope,
        chunkId,
        sourceId,
        entityIds,
        importance: routing.importance,
        eventAt: leaf.eventAt as number,
        createdAt: leaf.eventAt as number,
        text: leaf.text as string,
        tokenCount: Math.max(1, Math.ceil((leaf.text as string).length / 4)),
      },
      routing,
    }).targets.filter((target) =>
      target.treeType === cloned.treeType && target.treeKey === treeKey &&
      target.idempotencyKey === targetIdempotencyKey
    );
    if (matchingTargets.length !== 1) runtimeError("JOB_PAYLOAD_INVALID");
  } catch {
    runtimeError("JOB_PAYLOAD_INVALID");
  }
  return { payload: cloned, identity: targetIdempotencyKey };
}

function supportedType(type: string): type is RuntimeDurableJobV2Type {
  return (DURABLE_JOB_V2_AUTHORITATIVE_TYPES as readonly string[]).includes(type);
}

function canonicalizePayload(
  type: RuntimeDurableJobV2Type,
  rawPayload: Record<string, unknown>,
  scope: DurableJobV2Scope,
): { readonly payload: Record<string, unknown>; readonly identity: string } {
  if (!plainRecord(rawPayload)) runtimeError("JOB_PAYLOAD_INVALID");
  const cloned = cloneJson(rawPayload) as Record<string, unknown>;
  cloned.scope = payloadScope(rawPayload, scope);

  if (type === "extract_candidate") {
    const identity = requiredIdentity(cloned.traceId, EXTRACT_CANDIDATE_TRACE_ID_MAX_LENGTH);
    if (typeof cloned.text !== "string" || cloned.text.trim().length === 0 ||
        (cloned.intent !== undefined && typeof cloned.intent !== "string")) {
      runtimeError("JOB_PAYLOAD_INVALID");
    }
    return { payload: cloned, identity };
  }
  if (type === "build_tree") {
    return canonicalizeBuildTreePayload(cloned, scope);
  }
  const identity = requiredIdentity(cloned.chunkId);
  if (typeof cloned.text !== "string" || cloned.text.trim().length === 0) {
    runtimeError("JOB_PAYLOAD_INVALID");
  }
  return { payload: cloned, identity };
}

export function createRuntimeDurableJobV2Enqueuer(
  rawCapability: unknown,
  options: {
    readonly defaultScope: MemoryScope;
    readonly idFactory?: () => string;
  },
): RuntimeDurableJobV2Enqueuer {
  const capability = snapshotEnqueueCapability(rawCapability);
  if (!capability) runtimeError("CAPABILITY_UNAVAILABLE");
  const defaultScope = canonicalScope(options.defaultScope);
  if (!defaultScope || !sameScope(defaultScope, capability.scope)) runtimeError("JOB_SCOPE_MISMATCH");
  const idFactory = options.idFactory ?? randomUUID;
  return Object.freeze({
    enqueue: async ({ type, payload }: {
      readonly type: string;
      readonly payload: Record<string, unknown>;
    }) => {
      if (!supportedType(type)) runtimeError("JOB_TYPE_UNSUPPORTED");
      // Entity Graph work is minted only by committed-active derivation after
      // provider-owned evidence reads; transport callers cannot submit graph text.
      if (type === "extract_graph") runtimeError("JOB_TYPE_UNSUPPORTED");
      const canonical = canonicalizePayload(type, payload, capability.scope);
      const canonicalPayloadScope = canonical.payload.scope as Record<string, unknown>;
      const dedupeKey = deriveDurableJobV2DomainDedupeKey(type, canonical.identity, {
        ...(typeof canonicalPayloadScope.workspaceId === "string"
          ? { workspaceId: canonicalPayloadScope.workspaceId }
          : {}),
        ...(typeof canonicalPayloadScope.sessionId === "string"
          ? { sessionId: canonicalPayloadScope.sessionId }
          : {}),
      });
      try {
        await capability.runtimeBundle.assertEnqueueReady();
      } catch {
        runtimeError("CAPABILITY_UNAVAILABLE");
      }
      const job = await capability.runtimeBundle.repository.enqueue({
        id: idFactory(),
        type,
        payload: canonical.payload,
        dedupeKey,
        scope: capability.scope,
        maxAttempts: 3,
      });
      try {
        assertDurableJobV2(job);
      } catch {
        runtimeError("REPOSITORY_RESULT_INVALID");
      }
      if (job.type !== type || job.dedupeKey !== dedupeKey ||
          !sameScope(job.scope, capability.scope)) {
        runtimeError("REPOSITORY_RESULT_INVALID");
      }
      return job.id;
    },
  });
}
