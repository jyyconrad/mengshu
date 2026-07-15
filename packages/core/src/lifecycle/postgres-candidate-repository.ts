import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import type { MemoryScope, MemorySemanticType } from "../domain/types.js";

export const MENGSHU_CANDIDATE_RELATION = "mengshu_candidates";
export const MENGSHU_CANDIDATE_CONFLICT_COLUMNS = Object.freeze([
  "tenant_id",
  "user_id",
  "app_id",
  "project_id",
  "agent_id",
  "namespace",
  "visibility",
  "workspace_id",
  "session_id",
  "active_content_hash",
] as const);

export interface PostgresCandidateQueryResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly rows: readonly Row[];
  readonly rowCount?: number | null;
}

export interface PostgresCandidateQueryClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresCandidateQueryResult<Row>>;
}

export interface PostgresPendingCandidateInput {
  readonly id: string;
  readonly text: string;
  readonly semanticType?: MemorySemanticType;
  readonly kind: string;
  readonly confidence: number;
  readonly reason?: string;
  readonly evidenceIds: readonly string[];
  readonly extractor?: string;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: number;
}

export interface PostgresCandidateEffectBinding {
  readonly sourceJobId: string;
  readonly scope: MemoryScope;
}

export interface PostgresCandidateInsertResult {
  readonly inserted: boolean;
  readonly candidateId?: string;
}

const SAFE_ID = /^[^\s\p{Cc}]{1,256}$/u;
const VISIBILITIES = new Set(["private", "workspace", "team", "public"]);
const SEMANTIC_TYPES = new Set<MemorySemanticType>([
  "profile", "task_context", "rules", "experience", "resource",
]);
const INPUT_REQUIRED = Object.freeze([
  "id", "text", "kind", "confidence",
  "evidenceIds", "metadata", "createdAt",
] as const);
const INPUT_OPTIONAL = Object.freeze(["semanticType", "reason", "extractor"] as const);
const BINDING_REQUIRED = Object.freeze(["sourceJobId", "scope"] as const);
const UNSAFE_STRING = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

const INSERT_PENDING_SQL = `INSERT INTO ${MENGSHU_CANDIDATE_RELATION} (
  id, tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility,
  workspace_id, session_id, source_job_id, content_hash, active_content_hash,
  text, semantic_type, kind, confidence, reason, evidence_ids, extractor, status,
  hit_count, metadata, created_at, updated_at, last_hit_at, promoted_to_memory_id
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
  $15, $16, $17, $18, $19::jsonb, $20, $21, $22, $23::jsonb, $24, $25, $26, $27
)
ON CONFLICT (tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility, workspace_id, session_id, active_content_hash) DO NOTHING`;

function invalid(label = "Postgres candidate input is invalid"): Error {
  return new Error(label);
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value) && !UNPAIRED_SURROGATE.test(value);
}

function safeText(value: string): boolean {
  return !UNSAFE_STRING.test(value) && !UNPAIRED_SURROGATE.test(value);
}

function cloneStrictJson(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (!safeText(value)) throw invalid();
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid();
    return value;
  }
  if (!value || typeof value !== "object" || nodeUtilTypes.isProxy(value) || ancestors.has(value)) {
    throw invalid();
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (!lengthDescriptor || !("value" in lengthDescriptor) ||
          !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) throw invalid();
      const length = Number(lengthDescriptor.value);
      const keys = Reflect.ownKeys(value);
      if (keys.length !== length + 1 || !keys.includes("length") ||
          keys.some((key) => typeof key !== "string" ||
            (key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)))) {
        throw invalid();
      }
      const result: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) throw invalid();
        result.push(cloneStrictJson(descriptor.value, ancestors));
      }
      return Object.freeze(result);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw invalid();
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || key === "__proto__" || key === "prototype" || key === "constructor") {
        throw invalid();
      }
      if (!safeText(key)) throw invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) throw invalid();
      result[key] = cloneStrictJson(descriptor.value, ancestors);
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  const record = cloneStrictJson(value) as Record<string, unknown>;
  if (!record || typeof record !== "object" || Array.isArray(record)) throw invalid();
  const keys = Reflect.ownKeys(record);
  const allowed = new Set([...required, ...optional]);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
      required.some((key) => !keys.includes(key))) throw invalid();
  return record;
}

function canonicalScope(value: unknown): Readonly<MemoryScope> {
  const record = exactRecord(
    value,
    ["tenantId", "userId", "appId", "projectId", "agentId", "namespace", "visibility"],
    ["workspaceId", "sessionId"],
  );
  if (!safeId(record.tenantId) || !safeId(record.userId) || !safeId(record.appId) ||
      !safeId(record.projectId) || !safeId(record.agentId) || !safeId(record.namespace) ||
      typeof record.visibility !== "string" || !VISIBILITIES.has(record.visibility) ||
      (record.workspaceId !== undefined && !safeId(record.workspaceId)) ||
      (record.sessionId !== undefined && !safeId(record.sessionId))) throw invalid();
  return Object.freeze({
    tenantId: record.tenantId,
    userId: record.userId,
    appId: record.appId,
    projectId: record.projectId,
    agentId: record.agentId,
    namespace: record.namespace,
    visibility: record.visibility as MemoryScope["visibility"],
    ...(record.workspaceId === undefined ? {} : { workspaceId: record.workspaceId }),
    ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
  });
}

function canonicalBinding(value: unknown): Readonly<PostgresCandidateEffectBinding> {
  const binding = exactRecord(value, BINDING_REQUIRED);
  if (!safeId(binding.sourceJobId)) throw invalid();
  return Object.freeze({
    sourceJobId: binding.sourceJobId,
    scope: canonicalScope(binding.scope),
  });
}

function canonicalInput(value: unknown): Readonly<PostgresPendingCandidateInput> {
  const input = exactRecord(value, INPUT_REQUIRED, INPUT_OPTIONAL);
  const evidenceIds = cloneStrictJson(input.evidenceIds);
  const metadata = cloneStrictJson(input.metadata);
  if (!safeId(input.id) ||
      typeof input.text !== "string" || !safeText(input.text) ||
      input.text.trim().length === 0 || input.text.length > 100_000 ||
      !safeId(input.kind) || typeof input.confidence !== "number" || !Number.isFinite(input.confidence) ||
      input.confidence < 0 || input.confidence > 1 ||
      (input.semanticType !== undefined &&
        (typeof input.semanticType !== "string" || !SEMANTIC_TYPES.has(input.semanticType as MemorySemanticType))) ||
      (input.reason !== undefined &&
        (typeof input.reason !== "string" || !safeText(input.reason) || input.reason.length > 2_000)) ||
      (input.extractor !== undefined && !safeId(input.extractor)) ||
      !Array.isArray(evidenceIds) || evidenceIds.some((id) => !safeId(id)) ||
      !metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
      !Number.isSafeInteger(input.createdAt) || Number(input.createdAt) < 0) throw invalid();
  return Object.freeze({
    id: input.id,
    text: input.text,
    ...(input.semanticType === undefined ? {} : { semanticType: input.semanticType as MemorySemanticType }),
    kind: input.kind,
    confidence: input.confidence,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    evidenceIds: evidenceIds as readonly string[],
    ...(input.extractor === undefined ? {} : { extractor: input.extractor }),
    metadata: metadata as Record<string, unknown>,
    createdAt: Number(input.createdAt),
  });
}

function canonicalBatch(value: unknown): readonly Readonly<PostgresPendingCandidateInput>[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value)) throw invalid();
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) throw invalid();
  const length = Number(lengthDescriptor.value);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || !keys.includes("length") ||
      keys.some((key) => typeof key !== "string" ||
        (key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)))) {
    throw invalid();
  }
  const result: Readonly<PostgresPendingCandidateInput>[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) throw invalid();
    result.push(canonicalInput(descriptor.value));
  }
  return Object.freeze(result);
}

function queryParams(
  bindingValue: unknown,
  inputValue: unknown,
): {
  readonly id: string;
  readonly sourceJobId: string;
  readonly scope: Readonly<MemoryScope>;
  readonly params: readonly unknown[];
} {
  const binding = canonicalBinding(bindingValue);
  const input = canonicalInput(inputValue);
  const scope = binding.scope;

  const hash = createHash("sha256").update(input.text.trim()).digest("hex");
  const params = Object.freeze([
    input.id,
    scope.tenantId,
    scope.userId,
    scope.appId,
    scope.projectId,
    scope.agentId,
    scope.namespace,
    scope.visibility,
    scope.workspaceId ?? "",
    scope.sessionId ?? "",
    binding.sourceJobId,
    hash,
    hash,
    input.text,
    input.semanticType ?? null,
    input.kind,
    input.confidence,
    input.reason ?? null,
    JSON.stringify(input.evidenceIds),
    input.extractor ?? null,
    "pending",
    0,
    JSON.stringify(input.metadata),
    input.createdAt,
    null,
    null,
    null,
  ]);
  return Object.freeze({ id: input.id, sourceJobId: binding.sourceJobId, scope, params });
}

function readQuery(client: unknown): PostgresCandidateQueryClient["query"] {
  if (!client || typeof client !== "object" || nodeUtilTypes.isProxy(client)) throw invalid();
  const descriptor = Object.getOwnPropertyDescriptor(client, "query");
  if (!descriptor?.enumerable || !("value" in descriptor) || typeof descriptor.value !== "function") {
    throw invalid();
  }
  return descriptor.value as PostgresCandidateQueryClient["query"];
}

function decodeInsertResult(value: unknown): 0 | 1 {
  const result = exactRecord(value, ["rows", "rowCount"]);
  if (!Array.isArray(result.rows) || result.rows.length !== 0 ||
      (result.rowCount !== 0 && result.rowCount !== 1)) {
    throw invalid("Postgres candidate insert result is invalid");
  }
  return result.rowCount;
}

/**
 * Narrow T408-A persistence kernel. It intentionally does not implement CandidateRepository:
 * review/list/update/delete remain unavailable until a server-owned authority contract exists.
 */
export class PostgresCandidateRepository {
  readonly #assertReady: () => void;

  constructor(options: { readonly assertReady?: () => void } = {}) {
    if (options.assertReady !== undefined && typeof options.assertReady !== "function") throw invalid();
    this.#assertReady = options.assertReady ?? (() => undefined);
  }

  snapshotPendingCandidates(value: unknown): readonly Readonly<PostgresPendingCandidateInput>[] {
    return canonicalBatch(value);
  }

  async insertPendingWithClient(
    client: PostgresCandidateQueryClient,
    binding: PostgresCandidateEffectBinding,
    input: PostgresPendingCandidateInput,
  ): Promise<PostgresCandidateInsertResult> {
    const canonical = queryParams(binding, input);
    this.#assertReady();
    const query = readQuery(client);
    const rowCount = decodeInsertResult(await query.call(client, INSERT_PENDING_SQL, canonical.params));
    return Object.freeze(rowCount === 1
      ? { inserted: true, candidateId: canonical.id }
      : { inserted: false });
  }
}
