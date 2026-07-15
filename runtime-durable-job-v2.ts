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
    const identity = requiredIdentity(cloned.traceId);
    if (cloned.treeType !== "source" && cloned.treeType !== "topic" && cloned.treeType !== "global") {
      runtimeError("JOB_PAYLOAD_INVALID");
    }
    requiredIdentity(cloned.treeKey);
    if (!plainRecord(cloned.leaf) || requiredIdentity(cloned.leaf.id) !== identity ||
        requiredIdentity(cloned.leaf.chunkId) !== identity) {
      runtimeError("JOB_PAYLOAD_INVALID");
    }
    requiredIdentity(cloned.leaf.sourceId);
    return { payload: cloned, identity };
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
