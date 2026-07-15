import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import {
  DURABLE_JOB_V2_SAFE_IDENTIFIER_MAX_LENGTH,
  isDurableJobV2SafeIdentifier,
  deriveDurableJobV2DomainDedupeKey,
  type DurableJobV2,
  type DurableJobV2Scope,
} from "../packages/core/src/storage/repositories/job-v2.js";

export const NATIVE_EXTRACT_CANDIDATE_CONTRACT_VERSION = 1 as const;
export const NATIVE_EXTRACT_CANDIDATE_EFFECT_KEY = "extract_candidate.persist.v1" as const;
export const NATIVE_EXTRACT_CANDIDATE_SEMANTIC_TYPE = "extract_candidate" as const;
export const NATIVE_EXTRACT_CANDIDATE_DEDUPE_PREFIX =
  `${NATIVE_EXTRACT_CANDIDATE_SEMANTIC_TYPE}:` as const;
export const NATIVE_EXTRACT_CANDIDATE_MAX_TRACE_ID_LENGTH =
  DURABLE_JOB_V2_SAFE_IDENTIFIER_MAX_LENGTH;
export const NATIVE_EXTRACT_CANDIDATE_EFFECT_SEMANTICS = Object.freeze({
  effectKey: NATIVE_EXTRACT_CANDIDATE_EFFECT_KEY,
  semanticType: NATIVE_EXTRACT_CANDIDATE_SEMANTIC_TYPE,
  contractVersion: NATIVE_EXTRACT_CANDIDATE_CONTRACT_VERSION,
});

export type NativeExtractCandidateContractErrorCode =
  | "INVALID_JOB"
  | "INVALID_PAYLOAD"
  | "INVALID_SCOPE"
  | "INVALID_INTENT"
  | "INVALID_CANDIDATE_IDENTITY";

export class NativeExtractCandidateContractError extends Error {
  readonly code: NativeExtractCandidateContractErrorCode;

  constructor(code: NativeExtractCandidateContractErrorCode) {
    super("Native extract_candidate contract is invalid");
    this.name = "NativeExtractCandidateContractError";
    this.code = code;
  }
}

export interface NativeExtractCandidateContext {
  readonly workspaceId?: string;
  readonly sessionId?: string;
}

export interface NativeExtractCandidateSemanticRequest {
  readonly type: typeof NATIVE_EXTRACT_CANDIDATE_SEMANTIC_TYPE;
  readonly version: typeof NATIVE_EXTRACT_CANDIDATE_CONTRACT_VERSION;
  readonly text: string;
  readonly traceId: string;
  readonly intent: "auto" | "remember";
}

export interface NativeExtractCandidateContract {
  readonly context: NativeExtractCandidateContext;
  readonly semanticRequest: NativeExtractCandidateSemanticRequest;
}

const JOB_REQUIRED = Object.freeze([
  "id", "type", "payload", "scope", "dedupeKey", "scopedDedupeKey", "status",
  "attempts", "leaseGeneration", "maxAttempts", "createdAt", "updatedAt",
] as const);
const JOB_OPTIONAL = Object.freeze([
  "nextAttemptAt", "leaseOwner", "leaseToken", "leaseUntil", "heartbeatAt", "lastError",
] as const);
const PAYLOAD_REQUIRED = Object.freeze(["scope", "text", "traceId"] as const);
const PAYLOAD_OPTIONAL = Object.freeze(["intent"] as const);
const SCOPE_REQUIRED = Object.freeze([
  "tenantId", "userId", "appId", "projectId", "agentId", "namespace", "visibility",
] as const);
const CONTEXT_OPTIONAL = Object.freeze(["workspaceId", "sessionId"] as const);
const UNSAFE_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
const UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const VISIBILITIES = new Set(["private", "workspace", "team", "public"]);
const MAX_TEXT_LENGTH = 100_000;

function invalid(code: NativeExtractCandidateContractErrorCode): never {
  throw new NativeExtractCandidateContractError(code);
}

function exactDataRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  code: NativeExtractCandidateContractErrorCode,
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    invalid(code);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(code);
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (keys.length < required.length ||
      keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
      required.some((key) => !keys.includes(key))) {
    invalid(code);
  }
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor) || descriptor.value === undefined) {
      invalid(code);
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function safeId(value: unknown): value is string {
  return isDurableJobV2SafeIdentifier(value);
}

function safeText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    value.length <= MAX_TEXT_LENGTH && !UNSAFE_TEXT.test(value) &&
    !UNPAIRED_SURROGATE.test(value);
}

function safeTraceId(value: unknown): value is string {
  return safeId(value) && value.length <= NATIVE_EXTRACT_CANDIDATE_MAX_TRACE_ID_LENGTH;
}

function snapshotScope(
  value: unknown,
  optionalContext: boolean,
): { readonly core: DurableJobV2Scope; readonly context: NativeExtractCandidateContext } {
  const scope = exactDataRecord(
    value,
    SCOPE_REQUIRED,
    optionalContext ? CONTEXT_OPTIONAL : [],
    "INVALID_SCOPE",
  );
  for (const field of SCOPE_REQUIRED.slice(0, 6)) {
    if (!safeId(scope[field])) invalid("INVALID_SCOPE");
  }
  if (typeof scope.visibility !== "string" || !VISIBILITIES.has(scope.visibility)) {
    invalid("INVALID_SCOPE");
  }
  for (const field of CONTEXT_OPTIONAL) {
    if (Object.hasOwn(scope, field) && !safeId(scope[field])) invalid("INVALID_SCOPE");
  }
  const core = Object.freeze({
    tenantId: scope.tenantId as string,
    userId: scope.userId as string,
    appId: scope.appId as string,
    projectId: scope.projectId as string,
    agentId: scope.agentId as string,
    namespace: scope.namespace as string,
    visibility: scope.visibility as DurableJobV2Scope["visibility"],
  });
  const context = Object.freeze({
    ...(scope.workspaceId === undefined ? {} : { workspaceId: scope.workspaceId as string }),
    ...(scope.sessionId === undefined ? {} : { sessionId: scope.sessionId as string }),
  });
  return Object.freeze({ core, context });
}

function sameScope(left: DurableJobV2Scope, right: DurableJobV2Scope): boolean {
  return left.tenantId === right.tenantId && left.userId === right.userId &&
    left.appId === right.appId && left.projectId === right.projectId &&
    left.agentId === right.agentId && left.namespace === right.namespace &&
    left.visibility === right.visibility;
}

/**
 * Parse the real runtime enqueuer shape: payload contains canonical core scope plus
 * optional workspace/session context. No lease fields, clock, or model output enter
 * the provider semantic request.
 */
export function parseNativeExtractCandidateJob(rawJob: DurableJobV2): NativeExtractCandidateContract {
  const job = exactDataRecord(rawJob, JOB_REQUIRED, JOB_OPTIONAL, "INVALID_JOB");
  if (job.type !== NATIVE_EXTRACT_CANDIDATE_SEMANTIC_TYPE || !safeId(job.id)) {
    invalid("INVALID_JOB");
  }
  const jobScope = snapshotScope(job.scope, false).core;
  const payload = exactDataRecord(
    job.payload,
    PAYLOAD_REQUIRED,
    PAYLOAD_OPTIONAL,
    "INVALID_PAYLOAD",
  );
  const payloadScope = snapshotScope(payload.scope, true);
  if (!sameScope(jobScope, payloadScope.core)) invalid("INVALID_SCOPE");
  if (!safeText(payload.text)) invalid("INVALID_PAYLOAD");
  if (!safeTraceId(payload.traceId)) invalid("INVALID_PAYLOAD");
  const intent = payload.intent ?? "auto";
  if (intent !== "auto" && intent !== "remember") invalid("INVALID_INTENT");
  const expectedDedupeKey = deriveDurableJobV2DomainDedupeKey(
    NATIVE_EXTRACT_CANDIDATE_SEMANTIC_TYPE,
    payload.traceId,
    payloadScope.context,
  );
  if (job.dedupeKey !== expectedDedupeKey) invalid("INVALID_JOB");

  return Object.freeze({
    context: payloadScope.context,
    semanticRequest: Object.freeze({
      type: NATIVE_EXTRACT_CANDIDATE_SEMANTIC_TYPE,
      version: NATIVE_EXTRACT_CANDIDATE_CONTRACT_VERSION,
      text: payload.text,
      traceId: payload.traceId,
      intent,
    }),
  });
}

/** Stable provider candidate identity; deliberately excludes clock and LLM output. */
export function deriveNativeExtractCandidateId(jobId: string, index: number): string {
  if (!safeId(jobId) || !Number.isSafeInteger(index) || index < 0) {
    invalid("INVALID_CANDIDATE_IDENTITY");
  }
  const digest = createHash("sha256")
    .update("mengshu.native-extract-candidate.candidate-id.v1\0")
    .update(jobId)
    .update("\0")
    .update(String(index))
    .digest("hex");
  return `candidate_${digest}`;
}
