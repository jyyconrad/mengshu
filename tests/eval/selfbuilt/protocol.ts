import { canonicalAuthorityScope } from
  "../../../packages/core/src/domain/authority-scope-fingerprint.js";
import type {
  AdmissionRoute,
  MemoryKind,
  MemoryLifecycleStatus,
  MemoryScope,
  MemorySemanticType,
} from "../../../packages/core/src/domain/types.js";

export const SELFBUILT_CAPABILITIES = Object.freeze([
  "durable-facts-profile-rules",
  "task-project-continuity",
  "temporal-update-conflict",
  "cross-source-evidence",
  "negative-interference-abstention",
  "scope-lifecycle-sensitive",
] as const);

export const SELFBUILT_SCENARIOS = Object.freeze([
  "direct-recall",
  "temporal-update",
  "cross-source",
  "scope-isolation",
  "lifecycle-block",
  "hydration-fallback",
] as const);

export type SelfBuiltCapability = typeof SELFBUILT_CAPABILITIES[number];
export type SelfBuiltScenario = typeof SELFBUILT_SCENARIOS[number];
export type SelfBuiltSourceClass = "session" | "document" | "tool" | "agent-history";
export type SelfBuiltHydrationState = "available" | "unavailable";

export interface SelfBuiltMemoryEventV1 {
  readonly eventId: string;
  readonly evidenceRef: string;
  readonly occurredAt: string;
  readonly validFrom: string;
  readonly validTo?: string;
  readonly scope: MemoryScope;
  readonly text: string;
  readonly semanticType: MemorySemanticType;
  readonly kind: MemoryKind;
  readonly lifecycleStatus: MemoryLifecycleStatus;
  readonly admissionRoute: AdmissionRoute;
  readonly sourceClass: SelfBuiltSourceClass;
  readonly supersededBy?: string;
  readonly hydrationState?: SelfBuiltHydrationState;
}

export interface SelfBuiltEvalCaseV1 {
  readonly schemaVersion: "1";
  readonly id: string;
  readonly track: "selfbuilt";
  readonly datasetId: "mengshu-selfbuilt-v1";
  readonly datasetVersion: "template-v1";
  readonly split: "dev" | "test";
  readonly language: "zh" | "en";
  readonly capability: SelfBuiltCapability;
  readonly scenario: SelfBuiltScenario;
  readonly memoryStream: readonly SelfBuiltMemoryEventV1[];
  readonly query: Readonly<{
    text: string;
    scope: MemoryScope;
    occurredAt: string;
    expectedMode: "answer" | "abstain";
    topK: number;
  }>;
  readonly gold: Readonly<{
    requiredEvidenceRefs: readonly string[];
    forbiddenEvidenceRefs: readonly string[];
  }>;
}

const CASE_KEYS = [
  "schemaVersion", "id", "track", "datasetId", "datasetVersion", "split", "language",
  "capability", "scenario", "memoryStream", "query", "gold",
] as const;
const EVENT_REQUIRED_KEYS = [
  "eventId", "evidenceRef", "occurredAt", "validFrom", "scope", "text", "semanticType",
  "kind", "lifecycleStatus", "admissionRoute", "sourceClass",
] as const;
const EVENT_OPTIONAL_KEYS = ["validTo", "supersededBy", "hydrationState"] as const;
const QUERY_KEYS = ["text", "scope", "occurredAt", "expectedMode", "topK"] as const;
const GOLD_KEYS = ["requiredEvidenceRefs", "forbiddenEvidenceRefs"] as const;
const SCOPE_KEYS = [
  "tenantId", "appId", "userId", "projectId", "agentId", "namespace", "workspaceId",
  "sessionId", "visibility",
] as const;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const SEMANTIC_TYPES = new Set<MemorySemanticType>([
  "profile", "task_context", "rules", "experience", "resource",
]);
const KINDS = new Set<MemoryKind>([
  "preference", "decision", "entity", "fact", "task", "plan", "goal", "document",
  "knowledge", "observation", "other",
]);
const LIFECYCLES = new Set<MemoryLifecycleStatus>([
  "active", "archived", "revoked", "superseded", "promoted",
]);
const ROUTES = new Set<AdmissionRoute>([
  "drop", "candidate_low_priority", "candidate", "active", "lookup_only", "evidence_only",
]);
const SOURCE_CLASSES = new Set<SelfBuiltSourceClass>([
  "session", "document", "tool", "agent-history",
]);

function record(
  value: unknown,
  field: string,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${field} must be a plain object`);
  }
  const keys = Object.keys(value);
  const unknown = keys.filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${field} contains unknown fields: ${unknown.join(",")}`);
  const missing = required.filter((key) => !keys.includes(key));
  if (missing.length > 0) throw new Error(`${field} is missing fields: ${missing.join(",")}`);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, maxLength = 1024): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength ||
      value !== value.trim() || !SAFE_TEXT.test(value)) {
    throw new Error(`${field} must be bounded safe text`);
  }
  return value;
}

function id(value: unknown, field: string): string {
  const result = text(value, field, 128);
  if (!SAFE_ID.test(result)) throw new Error(`${field} must be a safe id`);
  return result;
}

function timestamp(value: unknown, field: string): string {
  const result = text(value, field, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result) ||
      !Number.isFinite(Date.parse(result))) {
    throw new Error(`${field} must be an ISO timestamp`);
  }
  return result;
}

function scope(value: unknown, field: string): MemoryScope {
  const raw = record(value, field, SCOPE_KEYS);
  const candidate = Object.fromEntries(SCOPE_KEYS.map((key) => [key,
    key === "visibility" ? raw[key] : id(raw[key], `${field}.${key}`)])) as unknown as MemoryScope;
  if (raw.visibility !== "private" && raw.visibility !== "workspace" &&
      raw.visibility !== "team" && raw.visibility !== "public") {
    throw new Error(`${field}.visibility is invalid`);
  }
  candidate.visibility = raw.visibility;
  canonicalAuthorityScope(candidate);
  return Object.freeze(candidate);
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  const values = value.map((item, index) => id(item, `${field}[${index}]`));
  if (new Set(values).size !== values.length) throw new Error(`${field} contains duplicate values`);
  return Object.freeze(values);
}

function member<T extends string>(
  value: unknown,
  values: ReadonlySet<T>,
  field: string,
): T {
  if (typeof value !== "string" || !values.has(value as T)) throw new Error(`${field} is invalid`);
  return value as T;
}

function event(value: unknown, index: number): SelfBuiltMemoryEventV1 {
  const field = `memoryStream[${index}]`;
  const raw = record(value, field, [...EVENT_REQUIRED_KEYS, ...EVENT_OPTIONAL_KEYS], EVENT_REQUIRED_KEYS);
  const occurredAt = timestamp(raw.occurredAt, `${field}.occurredAt`);
  const validFrom = timestamp(raw.validFrom, `${field}.validFrom`);
  const validTo = raw.validTo === undefined ? undefined : timestamp(raw.validTo, `${field}.validTo`);
  if (validTo !== undefined && Date.parse(validTo) < Date.parse(validFrom)) {
    throw new Error(`${field} validTo must not precede validFrom`);
  }
  const hydrationState = raw.hydrationState === undefined
    ? undefined
    : member(raw.hydrationState, new Set<SelfBuiltHydrationState>(["available", "unavailable"]),
      `${field}.hydrationState`);
  return Object.freeze({
    eventId: id(raw.eventId, `${field}.eventId`),
    evidenceRef: id(raw.evidenceRef, `${field}.evidenceRef`),
    occurredAt,
    validFrom,
    ...(validTo === undefined ? {} : { validTo }),
    scope: scope(raw.scope, `${field}.scope`),
    text: text(raw.text, `${field}.text`, 4096),
    semanticType: member(raw.semanticType, SEMANTIC_TYPES, `${field}.semanticType`),
    kind: member(raw.kind, KINDS, `${field}.kind`),
    lifecycleStatus: member(raw.lifecycleStatus, LIFECYCLES, `${field}.lifecycleStatus`),
    admissionRoute: member(raw.admissionRoute, ROUTES, `${field}.admissionRoute`),
    sourceClass: member(raw.sourceClass, SOURCE_CLASSES, `${field}.sourceClass`),
    ...(raw.supersededBy === undefined ? {} : {
      supersededBy: id(raw.supersededBy, `${field}.supersededBy`),
    }),
    ...(hydrationState === undefined ? {} : { hydrationState }),
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export function parseSelfBuiltEvalCaseV1(value: unknown): Readonly<SelfBuiltEvalCaseV1> {
  const raw = record(value, "SelfBuiltEvalCaseV1", CASE_KEYS);
  if (raw.schemaVersion !== "1" || raw.track !== "selfbuilt" ||
      raw.datasetId !== "mengshu-selfbuilt-v1" || raw.datasetVersion !== "template-v1") {
    throw new Error("self-built dataset identity is invalid");
  }
  if (raw.split !== "dev" && raw.split !== "test") throw new Error("split is invalid");
  if (raw.language !== "zh" && raw.language !== "en") throw new Error("language is invalid");
  const capability = member(raw.capability, new Set(SELFBUILT_CAPABILITIES), "capability");
  const scenario = member(raw.scenario, new Set(SELFBUILT_SCENARIOS), "scenario");
  if (!Array.isArray(raw.memoryStream) || raw.memoryStream.length === 0 ||
      raw.memoryStream.length > 32) {
    throw new Error("memoryStream must contain 1..32 events");
  }
  const memoryStream = Object.freeze(raw.memoryStream.map(event));
  if (new Set(memoryStream.map((item) => item.eventId)).size !== memoryStream.length ||
      new Set(memoryStream.map((item) => item.evidenceRef)).size !== memoryStream.length) {
    throw new Error("memoryStream event and evidence ids must be unique; duplicate found");
  }
  const queryRaw = record(raw.query, "query", QUERY_KEYS);
  if (queryRaw.expectedMode !== "answer" && queryRaw.expectedMode !== "abstain") {
    throw new Error("query.expectedMode is invalid");
  }
  if (!Number.isSafeInteger(queryRaw.topK) || Number(queryRaw.topK) < 1 || Number(queryRaw.topK) > 20) {
    throw new Error("query.topK must be an integer in 1..20");
  }
  const goldRaw = record(raw.gold, "gold", GOLD_KEYS);
  const requiredEvidenceRefs = stringArray(goldRaw.requiredEvidenceRefs, "gold.requiredEvidenceRefs");
  const forbiddenEvidenceRefs = stringArray(goldRaw.forbiddenEvidenceRefs, "gold.forbiddenEvidenceRefs");
  const evidenceRefs = new Set(memoryStream.map((item) => item.evidenceRef));
  for (const ref of [...requiredEvidenceRefs, ...forbiddenEvidenceRefs]) {
    if (!evidenceRefs.has(ref)) throw new Error(`gold evidence ref '${ref}' is missing`);
  }
  if (requiredEvidenceRefs.some((ref) => forbiddenEvidenceRefs.includes(ref))) {
    throw new Error("required and forbidden evidence must not overlap");
  }
  if (queryRaw.expectedMode === "abstain" &&
      (requiredEvidenceRefs.length !== 0 || forbiddenEvidenceRefs.length === 0)) {
    throw new Error("abstain cases require zero required and at least one forbidden evidence ref");
  }
  if (queryRaw.expectedMode === "answer" && requiredEvidenceRefs.length === 0) {
    throw new Error("answer cases require positive evidence");
  }
  return deepFreeze({
    schemaVersion: "1",
    id: id(raw.id, "id"),
    track: "selfbuilt",
    datasetId: "mengshu-selfbuilt-v1",
    datasetVersion: "template-v1",
    split: raw.split,
    language: raw.language,
    capability,
    scenario,
    memoryStream,
    query: Object.freeze({
      text: text(queryRaw.text, "query.text", 4096),
      scope: scope(queryRaw.scope, "query.scope"),
      occurredAt: timestamp(queryRaw.occurredAt, "query.occurredAt"),
      expectedMode: queryRaw.expectedMode,
      topK: Number(queryRaw.topK),
    }),
    gold: Object.freeze({ requiredEvidenceRefs, forbiddenEvidenceRefs }),
  });
}
