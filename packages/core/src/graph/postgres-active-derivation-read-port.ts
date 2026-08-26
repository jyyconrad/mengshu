/**
 * F0 provider-owned active derivation reads.
 *
 * Effect receipt ids are the only active authority. PostgreSQL rows are read
 * back in the exact authority scope and decoded from Write Kernel mirrors;
 * absent evidence/tree facts stay absent instead of being inferred.
 */

import { types as nodeUtilTypes } from "node:util";

import {
  canonicalAuthorityScope,
  type CanonicalAuthorityScope,
} from "../domain/authority-scope-fingerprint.js";
import type {
  MemoryKind,
  MemoryScope,
  MemorySemanticType,
  RecordProvenance,
} from "../domain/types.js";
import type { WriteMemoryRecord } from "../service/write-kernel.js";
import type {
  ActiveMemoryEvidenceFact,
  ActiveMemoryTreeFacts,
} from "./active-memory-derivation.js";

type ContentWriteRecord = Extract<WriteMemoryRecord, { mutation: "content" }>;

export interface CommittedActiveMemoryReadInput {
  readonly activeMemoryIds: readonly string[];
  readonly scope: MemoryScope;
  readonly signal: AbortSignal;
}

export interface ActiveDerivationFactReadInput {
  readonly memoryIds: readonly string[];
  readonly records: readonly ContentWriteRecord[];
  readonly signal: AbortSignal;
}

export interface ActiveMemoryDerivationReadPort {
  readCommittedActiveRecords(
    input: CommittedActiveMemoryReadInput,
  ): Promise<readonly ContentWriteRecord[]>;
  readEvidenceFacts(
    input: ActiveDerivationFactReadInput,
  ): Promise<readonly ActiveMemoryEvidenceFact[]>;
  readTreeFacts(
    input: ActiveDerivationFactReadInput,
  ): Promise<readonly ActiveMemoryTreeFacts[]>;
}

export interface PostgresActiveDerivationQueryResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly rows: readonly Row[];
  readonly rowCount?: number | null;
}

/** Query client lifecycle belongs to PostgresProvider. */
export interface PostgresActiveDerivationQueryClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresActiveDerivationQueryResult<Row>>;
}

const SAFE_ID = /^[^\s\p{Cc}]{1,256}$/u;
const MAX_IDS = 10_000;
const MEMORY_KINDS = new Set<MemoryKind>([
  "preference", "decision", "entity", "fact", "task", "plan", "goal",
  "document", "knowledge", "observation", "other",
]);
const SEMANTIC_TYPES = new Set<MemorySemanticType>([
  "profile", "task_context", "rules", "experience", "resource",
]);
const COMMAND_TYPES = new Set<ContentWriteRecord["commandType"]>([
  "saveExplicit", "observeAuto", "importEvidence", "correctMemory",
]);
const MEMORY_CONTAINERS = new Set(["personal", "project", "team", "enterprise"]);
const SCOPE_VISIBILITIES = new Set<ActiveMemoryTreeFacts["scopeVisibility"]>([
  "session", "project", "workspace", "app", "user", "global",
]);

const ROW_KEYS = [
  "id", "text", "vector_text", "importance", "category", "data_type",
  "physical_data_type", "data_type_compatibility",
  "created_at_ms", "tenant_id", "user_id", "app_id", "project_id",
  "agent_id", "namespace", "visibility", "workspace_id", "session_id",
  "lifecycle_status", "legacy_quarantine_reason", "metadata",
] as const;

const SESSION_SQL = `COALESCE(
  metadata->>'sessionId',
  metadata #>> '{governance,provenance,sessionId}',
  ''
)`;

// Historical rebuilds preserve a missing source importance in the physical column.
// Resolve the governed 0.70 floor only when the frozen source and plan ledgers prove it.
const IMPORTANCE_SQL = `CASE
  WHEN importance IS NOT NULL THEN importance::double precision
  WHEN jsonb_typeof(metadata->'importance') = 'number'
    AND (metadata->>'importance')::double precision = 0.70
    AND EXISTS (
      SELECT 1
      FROM mengshu_history_rebuild_source_rows history_source
      JOIN mengshu_history_rebuild_shadow_plans history_plan
        USING (run_id, source_table, record_id, source_hash)
      JOIN mengshu_history_rebuild_runs history_run USING (run_id)
      WHERE history_source.run_id::text = metadata #>> '{historyRebuild,runId}'
        AND history_source.source_table = 'memories'
        AND history_source.record_id = memories.id
        AND history_source.source_hash = metadata #>> '{historyRebuild,sourceHash}'
        AND NOT (history_source.source_row ? 'importance')
        AND history_plan.disposition = metadata #>> '{historyRebuild,disposition}'
        AND history_plan.plan_receipt_hash = metadata #>> '{historyRebuild,planReceiptHash}'
        AND history_run.state = 'completed'
    ) THEN 0.70::double precision
  ELSE importance::double precision
END`;

const HISTORY_MEMORY_DATA_TYPE_PROOF_SQL = `EXISTS (
  SELECT 1
  FROM mengshu_history_rebuild_source_rows history_source
  JOIN mengshu_history_rebuild_shadow_plans history_plan
    USING (run_id, source_table, record_id, source_hash)
  JOIN mengshu_history_rebuild_runs history_run USING (run_id)
  WHERE history_source.run_id::text = metadata #>> '{historyRebuild,runId}'
    AND history_source.source_table = 'memories'
    AND history_source.record_id = memories.id
    AND history_source.source_hash = metadata #>> '{historyRebuild,sourceHash}'
    AND history_source.source_row->>'dataType' = data_type
    AND history_plan.disposition = metadata #>> '{historyRebuild,disposition}'
    AND history_plan.plan_receipt_hash = metadata #>> '{historyRebuild,planReceiptHash}'
    AND history_plan.semantic_type = metadata->>'semanticType'
    AND history_plan.context_eligible = true
    AND history_run.state = 'completed'
)`;

const SELECT_COLUMNS_SQL = `SELECT
  id::text AS id,
  text,
  vector::text AS vector_text,
  ${IMPORTANCE_SQL} AS importance,
  category,
  data_type AS physical_data_type,
  CASE WHEN data_type = 'memory' OR ${HISTORY_MEMORY_DATA_TYPE_PROOF_SQL}
    THEN 'memory' ELSE data_type END AS data_type,
  CASE WHEN data_type <> 'memory' AND ${HISTORY_MEMORY_DATA_TYPE_PROOF_SQL}
    THEN 'history-memory-data-type/v1' ELSE NULL END AS data_type_compatibility,
  floor(extract(epoch FROM created_at) * 1000)::text AS created_at_ms,
  tenant_id,
  user_id,
  product_id AS app_id,
  canonical_project_id AS project_id,
  producer_id AS agent_id,
  namespace,
  visibility,
  COALESCE(workspace_id, '') AS workspace_id,
  ${SESSION_SQL} AS session_id,
  lifecycle_status,
  legacy_quarantine_reason,
  metadata
FROM memories`;

const SCOPE_WHERE_SQL = `tenant_id = $1
  AND user_id = $2
  AND product_id = $3
  AND canonical_project_id = $4
  AND producer_id = $5
  AND namespace = $6
  AND visibility = $7
  AND COALESCE(workspace_id, '') = $8
  AND ${SESSION_SQL} = $9
  AND (
    metadata->>'sessionId' IS NULL
    OR metadata #>> '{governance,provenance,sessionId}' IS NULL
    OR metadata->>'sessionId' = metadata #>> '{governance,provenance,sessionId}'
  )`;

const READ_ACTIVE_SQL = `${SELECT_COLUMNS_SQL}
WHERE ${SCOPE_WHERE_SQL}
  AND id::text = ANY($10::text[])
  AND (data_type = 'memory' OR ${HISTORY_MEMORY_DATA_TYPE_PROOF_SQL})
  AND lifecycle_status = 'active'
  AND metadata->>'admissionRoute' = 'active'
  AND metadata->>'contextEligible' = 'true'
  AND metadata->>'memoryContainer' IN ('personal', 'project', 'team', 'enterprise')
  AND legacy_quarantine_reason IS NULL
ORDER BY created_at ASC, id ASC`;

const READ_EVIDENCE_SQL = `${SELECT_COLUMNS_SQL}
WHERE ${SCOPE_WHERE_SQL}
  AND id::text = ANY($10::text[])
  AND data_type = 'memory'
  AND lifecycle_status = 'archived'
  AND metadata->>'admissionRoute' = 'evidence_only'
  AND metadata->>'contextEligible' = 'false'
  AND metadata #>> '{governance,commandType}' = 'importEvidence'
  AND metadata #>> '{governance,candidate,phase}' = 'raw_evidence'
  AND metadata #>> '{governance,candidate,evidenceOnly}' = 'true'
  AND legacy_quarantine_reason IS NULL
ORDER BY created_at ASC, id ASC`;

export class PostgresActiveDerivationReadError extends Error {
  readonly code = "POSTGRES_ACTIVE_DERIVATION_READ_INVALID" as const;

  constructor() {
    super("Postgres active derivation read is invalid or incomplete");
    this.name = "PostgresActiveDerivationReadError";
  }
}

function invalid(): never {
  throw new PostgresActiveDerivationReadError();
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error && signal.reason.name === "AbortError"
    ? signal.reason
    : new DOMException("Active derivation read aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value) && value === value.trim();
}

function finiteScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function denseIds(value: unknown, allowEmpty = false): readonly string[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) || value.length > MAX_IDS ||
      (!allowEmpty && value.length === 0) || value.some((id) => !safeId(id)) ||
      new Set(value).size !== value.length) invalid();
  return Object.freeze([...value]) as readonly string[];
}

function denseStrings(value: unknown, allowEmpty = false): readonly string[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) || value.length > MAX_IDS ||
      (!allowEmpty && value.length === 0) || value.some((item) =>
        typeof item !== "string" || item.trim().length === 0 || item !== item.trim()) ||
      new Set(value).size !== value.length) invalid();
  return Object.freeze([...value]) as readonly string[];
}

function exactRow(value: unknown): Record<(typeof ROW_KEYS)[number], unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    return invalid();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== ROW_KEYS.length || keys.some(
    (key) => typeof key !== "string" || !ROW_KEYS.includes(key as (typeof ROW_KEYS)[number]),
  )) invalid();
  for (const key of ROW_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) invalid();
  }
  return value as Record<(typeof ROW_KEYS)[number], unknown>;
}

function dataRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    return invalid();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || key === "__proto__" || key === "prototype" ||
        key === "constructor") invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor) || descriptor.value === undefined) {
      invalid();
    }
    result[key] = descriptor.value;
  }
  return result;
}

function jsonSnapshot(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid();
    return value;
  }
  if (!value || typeof value !== "object" || nodeUtilTypes.isProxy(value) || ancestors.has(value)) {
    invalid();
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return Object.freeze(value.map((item) => jsonSnapshot(item, ancestors)));
    const record = dataRecord(value);
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) result[key] = jsonSnapshot(item, ancestors);
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
}

function publicScope(scope: CanonicalAuthorityScope): MemoryScope {
  return Object.freeze({
    tenantId: scope.tenantId,
    userId: scope.userId,
    appId: scope.appId,
    projectId: scope.projectId,
    agentId: scope.agentId,
    namespace: scope.namespace,
    visibility: scope.visibility,
    ...(scope.workspaceId === "" ? {} : { workspaceId: scope.workspaceId }),
    ...(scope.sessionId === "" ? {} : { sessionId: scope.sessionId }),
  });
}

function canonicalInputScope(scope: MemoryScope): CanonicalAuthorityScope {
  try {
    return canonicalAuthorityScope(scope);
  } catch {
    return invalid();
  }
}

function assertRowScope(
  row: Record<(typeof ROW_KEYS)[number], unknown>,
  scope: CanonicalAuthorityScope,
): void {
  const actual = [
    row.tenant_id, row.user_id, row.app_id, row.project_id, row.agent_id,
    row.namespace, row.visibility, row.workspace_id, row.session_id,
  ];
  const expected = [
    scope.tenantId, scope.userId, scope.appId, scope.projectId, scope.agentId,
    scope.namespace, scope.visibility, scope.workspaceId, scope.sessionId,
  ];
  if (actual.some((value, index) => value !== expected[index])) invalid();
}

function scopeParams(scope: CanonicalAuthorityScope, ids: readonly string[]): readonly unknown[] {
  return [
    scope.tenantId, scope.userId, scope.appId, scope.projectId, scope.agentId,
    scope.namespace, scope.visibility, scope.workspaceId, scope.sessionId, ids,
  ];
}

function parseMillis(value: unknown): number {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) invalid();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) invalid();
  return parsed;
}

function parseVector(value: unknown): readonly number[] {
  if (typeof value !== "string") invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return invalid();
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some(
    (item) => typeof item !== "number" || !Number.isFinite(item),
  )) invalid();
  return Object.freeze([...parsed]);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function optionalSemanticType(value: unknown): MemorySemanticType | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !SEMANTIC_TYPES.has(value as MemorySemanticType)) invalid();
  return value as MemorySemanticType;
}

function optionalAdmissionBreakdown(value: unknown): Readonly<Record<string, number>> | undefined {
  if (value === undefined) return undefined;
  const record = dataRecord(value);
  if (Object.values(record).some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    invalid();
  }
  return jsonSnapshot(record) as Readonly<Record<string, number>>;
}

function decodeActiveRecord(
  value: unknown,
  scope: CanonicalAuthorityScope,
): ContentWriteRecord {
  const row = exactRow(value);
  assertRowScope(row, scope);
  if (!safeId(row.id) || typeof row.text !== "string" || row.text.trim().length === 0 ||
      !finiteScore(row.importance) || typeof row.category !== "string" ||
      row.data_type !== "memory" || row.lifecycle_status !== "active" ||
      row.legacy_quarantine_reason !== null) invalid();
  const metadata = dataRecord(row.metadata);
  const governance = dataRecord(metadata.governance);
  const candidate = dataRecord(governance.candidate);
  const native = dataRecord(governance.native);
  const physicalDataType = row.physical_data_type;
  const dataTypeCompatibility = row.data_type_compatibility;
  const legacyDataTypeCompatible = dataTypeCompatibility === "history-memory-data-type/v1";
  const provenance = jsonSnapshot(governance.provenance) as Readonly<RecordProvenance>;
  const evidenceIds = denseIds(governance.evidenceIds, true);
  const sourceNodeIds = denseIds(metadata.sourceNodeIds, true);
  if (!sameStrings(evidenceIds, sourceNodeIds) || metadata.admissionRoute !== "active" ||
      metadata.contextEligible !== true || !finiteScore(metadata.valueScore) ||
      metadata.importance !== row.importance || !finiteScore(metadata.confidence) ||
      !MEMORY_CONTAINERS.has(String(metadata.memoryContainer)) ||
      typeof governance.commandType !== "string" ||
      !COMMAND_TYPES.has(governance.commandType as ContentWriteRecord["commandType"]) ||
      typeof native.kind !== "string" || !MEMORY_KINDS.has(native.kind as MemoryKind) ||
      native.category !== row.category || typeof physicalDataType !== "string" ||
      physicalDataType.length === 0 ||
      (!legacyDataTypeCompatible && (dataTypeCompatibility !== null ||
        physicalDataType !== "memory" || native.dataType !== row.data_type)) ||
      (legacyDataTypeCompatible && (physicalDataType === "memory" ||
        native.dataType !== physicalDataType))) invalid();
  const semanticType = optionalSemanticType(native.semanticType);
  if (metadata.semanticType !== semanticType) invalid();
  if (native.container !== undefined && native.container !== metadata.memoryContainer) invalid();
  if (candidate.confidence !== undefined && !finiteScore(candidate.confidence)) invalid();
  if (candidate.evidence !== undefined) {
    const candidateEvidence = dataRecord(candidate.evidence);
    if (!sameStrings(denseIds(candidateEvidence.eventIds, true), evidenceIds)) invalid();
  }
  if (governance.admissionReason !== undefined &&
      (typeof governance.admissionReason !== "string" ||
        governance.admissionReason.trim().length === 0)) invalid();
  const admissionBreakdown = optionalAdmissionBreakdown(governance.admissionBreakdown);
  return Object.freeze({
    id: row.id,
    commandType: governance.commandType as ContentWriteRecord["commandType"],
    mutation: "content",
    scope: publicScope(scope),
    text: row.text,
    metadata: jsonSnapshot(metadata) as Readonly<Record<string, unknown>>,
    vector: parseVector(row.vector_text),
    route: "active",
    valueScore: metadata.valueScore,
    importance: row.importance,
    kind: native.kind as MemoryKind,
    ...(semanticType === undefined ? {} : { semanticType }),
    container: metadata.memoryContainer as ContentWriteRecord["container"],
    confidence: metadata.confidence,
    category: row.category as ContentWriteRecord["category"],
    dataType: "memory",
    provenance,
    evidenceIds,
    governance: Object.freeze({
      candidate: jsonSnapshot(candidate) as Readonly<Record<string, unknown>>,
      ...(governance.admissionReason === undefined
        ? {}
        : { admissionReason: governance.admissionReason }),
      ...(admissionBreakdown === undefined ? {} : { admissionBreakdown }),
    }),
    createdAt: parseMillis(row.created_at_ms),
  });
}

function assertedFactInput(input: ActiveDerivationFactReadInput): {
  readonly records: readonly ContentWriteRecord[];
  readonly scope?: CanonicalAuthorityScope;
} {
  if (!input || typeof input !== "object" || !Array.isArray(input.records) ||
      !Array.isArray(input.memoryIds) || !(input.signal instanceof AbortSignal)) invalid();
  const ids = denseIds(input.memoryIds, true);
  if (ids.length !== input.records.length) invalid();
  if (ids.length === 0) return { records: Object.freeze([]) };
  const byId = new Map(input.records.map((record) => [record.id, record]));
  if (byId.size !== input.records.length || ids.some((id) => !byId.has(id))) invalid();
  const records = ids.map((id) => byId.get(id)!);
  if (records.some((record) => record.mutation !== "content" || record.route !== "active")) invalid();
  const scope = canonicalInputScope(records[0]!.scope);
  for (const record of records) {
    const current = canonicalInputScope(record.scope);
    if (JSON.stringify(current) !== JSON.stringify(scope)) invalid();
  }
  return { records: Object.freeze(records), scope };
}

function evidenceKind(
  metadata: Record<string, unknown>,
  native: Record<string, unknown>,
): ActiveMemoryEvidenceFact["evidenceKind"] {
  const eventType = metadata.eventType;
  const kind = native.kind;
  if (eventType === "observation" && kind === "observation") return "observation";
  if (eventType === "explicit_save" && kind === "observation") return "message";
  // F0 production only exposes event kinds with an explicit durable writer contract.
  return invalid();
}

function decodeEvidenceFact(
  value: unknown,
  scope: CanonicalAuthorityScope,
): ActiveMemoryEvidenceFact {
  const row = exactRow(value);
  assertRowScope(row, scope);
  if (!safeId(row.id) || typeof row.text !== "string" || row.text.trim().length === 0 ||
      row.data_type !== "memory" || row.lifecycle_status !== "archived" ||
      row.physical_data_type !== "memory" || row.data_type_compatibility !== null ||
      row.legacy_quarantine_reason !== null) invalid();
  const metadata = dataRecord(row.metadata);
  const governance = dataRecord(metadata.governance);
  const candidate = dataRecord(governance.candidate);
  const native = dataRecord(governance.native);
  const provenance = dataRecord(governance.provenance);
  const evidenceIds = denseIds(governance.evidenceIds);
  const sourceNodeIds = denseIds(metadata.sourceNodeIds);
  if (metadata.admissionRoute !== "evidence_only" || metadata.contextEligible !== false ||
      governance.commandType !== "importEvidence" || candidate.phase !== "raw_evidence" ||
      candidate.evidenceOnly !== true || candidate.quote !== row.text ||
      !safeId(candidate.sourceId) || metadata.memoryContainer !== "session_candidate" ||
      (native.container !== undefined && native.container !== "session_candidate") ||
      !MEMORY_KINDS.has(native.kind as MemoryKind) ||
      !sameStrings(evidenceIds, sourceNodeIds) || evidenceIds.length !== 1 ||
      evidenceIds[0] !== candidate.sourceId ||
      provenance.sourceId !== candidate.sourceId ||
      (provenance.sessionId !== undefined && provenance.sessionId !== scope.sessionId)) invalid();
  return Object.freeze({
    evidenceId: row.id,
    scope: publicScope(scope),
    evidenceKind: evidenceKind(metadata, native),
    label: row.text,
    metadata: jsonSnapshot(metadata) as Readonly<Record<string, unknown>>,
    createdAt: parseMillis(row.created_at_ms),
  });
}

function treeFact(record: ContentWriteRecord): ActiveMemoryTreeFacts | undefined {
  const candidate = dataRecord(record.governance.candidate);
  if (candidate.treeRouting === undefined) return undefined;
  const routing = dataRecord(candidate.treeRouting);
  const required = [
    "version", "evidenceId", "sourceId", "entityIds", "scopeVisibility",
    "riskFlags", "topicLabels", "topicHotnessEligible",
  ];
  const optional = new Set(["explicitGlobal", "isWorkspaceRule"]);
  const keys = Object.keys(routing);
  if (required.some((key) => !Object.hasOwn(routing, key)) ||
      keys.some((key) => !required.includes(key) && !optional.has(key)) ||
      routing.version !== 1 || !safeId(routing.evidenceId) ||
      !record.evidenceIds.includes(routing.evidenceId) || !safeId(routing.sourceId) ||
      typeof routing.scopeVisibility !== "string" ||
      !SCOPE_VISIBILITIES.has(routing.scopeVisibility as ActiveMemoryTreeFacts["scopeVisibility"]) ||
      typeof routing.topicHotnessEligible !== "boolean" ||
      (routing.explicitGlobal !== undefined && typeof routing.explicitGlobal !== "boolean") ||
      (routing.isWorkspaceRule !== undefined && typeof routing.isWorkspaceRule !== "boolean")) invalid();
  const entityIds = denseIds(routing.entityIds, true);
  const riskFlags = denseStrings(routing.riskFlags, true);
  const topicLabels = denseStrings(routing.topicLabels, true);
  if (candidate.riskFlags !== undefined &&
      !sameStrings(denseStrings(candidate.riskFlags, true), riskFlags)) invalid();
  if (candidate.targetScope !== undefined && candidate.targetScope !== routing.scopeVisibility) invalid();
  return Object.freeze({
    memoryId: record.id,
    scope: Object.freeze({ ...record.scope }),
    evidenceId: routing.evidenceId,
    sourceId: routing.sourceId,
    entityIds,
    scopeVisibility: routing.scopeVisibility as ActiveMemoryTreeFacts["scopeVisibility"],
    riskFlags,
    topicLabels,
    topicHotnessEligible: routing.topicHotnessEligible,
    ...(routing.explicitGlobal === undefined ? {} : { explicitGlobal: routing.explicitGlobal }),
    ...(routing.isWorkspaceRule === undefined ? {} : { isWorkspaceRule: routing.isWorkspaceRule }),
  });
}

export class PostgresActiveMemoryDerivationReadPort
implements ActiveMemoryDerivationReadPort {
  constructor(private readonly client: PostgresActiveDerivationQueryClient) {
    if (!client || typeof client.query !== "function") invalid();
  }

  async readCommittedActiveRecords(
    input: CommittedActiveMemoryReadInput,
  ): Promise<readonly ContentWriteRecord[]> {
    if (!input || !(input.signal instanceof AbortSignal)) invalid();
    throwIfAborted(input.signal);
    const ids = denseIds(input.activeMemoryIds, true);
    const scope = canonicalInputScope(input.scope);
    if (ids.length === 0) return Object.freeze([]);
    const result = await this.client.query(READ_ACTIVE_SQL, scopeParams(scope, ids));
    throwIfAborted(input.signal);
    if (!result || !Array.isArray(result.rows) ||
        (result.rowCount !== undefined && result.rowCount !== null &&
          result.rowCount !== result.rows.length)) invalid();
    const byId = new Map<string, ContentWriteRecord>();
    for (const row of result.rows) {
      const record = decodeActiveRecord(row, scope);
      if (!ids.includes(record.id) || byId.has(record.id)) invalid();
      byId.set(record.id, record);
    }
    if (byId.size !== ids.length) invalid();
    return Object.freeze(ids.map((id) => byId.get(id)!));
  }

  async readEvidenceFacts(
    input: ActiveDerivationFactReadInput,
  ): Promise<readonly ActiveMemoryEvidenceFact[]> {
    const asserted = assertedFactInput(input);
    throwIfAborted(input.signal);
    if (!asserted.scope) return Object.freeze([]);
    const ids = Array.from(new Set(asserted.records.flatMap((record) => record.evidenceIds)));
    if (ids.length === 0) return Object.freeze([]);
    const result = await this.client.query(
      READ_EVIDENCE_SQL,
      scopeParams(asserted.scope, Object.freeze(ids)),
    );
    throwIfAborted(input.signal);
    if (!result || !Array.isArray(result.rows) ||
        (result.rowCount !== undefined && result.rowCount !== null &&
          result.rowCount !== result.rows.length)) invalid();
    const byId = new Map<string, ActiveMemoryEvidenceFact>();
    for (const row of result.rows) {
      const fact = decodeEvidenceFact(row, asserted.scope);
      if (!ids.includes(fact.evidenceId) || byId.has(fact.evidenceId)) invalid();
      byId.set(fact.evidenceId, fact);
    }
    if (byId.size !== ids.length) invalid();
    return Object.freeze(ids.map((id) => byId.get(id)!));
  }

  async readTreeFacts(
    input: ActiveDerivationFactReadInput,
  ): Promise<readonly ActiveMemoryTreeFacts[]> {
    const asserted = assertedFactInput(input);
    throwIfAborted(input.signal);
    const facts: ActiveMemoryTreeFacts[] = [];
    for (const record of asserted.records) {
      const fact = treeFact(record);
      if (fact) facts.push(fact);
    }
    throwIfAborted(input.signal);
    return Object.freeze(facts);
  }
}
