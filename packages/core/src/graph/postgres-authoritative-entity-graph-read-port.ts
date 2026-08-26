/**
 * F0 权威 Entity Graph 事实回读。
 *
 * 调用方只提交身份。本模块以单次 9D scope 查询读取 persisted active memory
 * 及其 persisted L0 evidence，并校验 governance/provenance 后才向图抽取暴露正文。
 */

import { types as nodeUtilTypes } from "node:util";

import {
  canonicalAuthorityScope,
  type CanonicalAuthorityScope,
} from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../domain/types.js";
import type { AuthoritativeEntityEvidenceFact } from
  "./authoritative-entity-graph-derivation.js";

export interface AuthoritativeEntityGraphReadInput {
  readonly graphKind: "entity";
  readonly activeMemoryId: string;
  readonly evidenceId: string;
  readonly scope: MemoryScope;
  readonly signal: AbortSignal;
}

export interface AuthoritativeEntityGraphReadFact {
  readonly authority: "persisted_active_memory_evidence";
  readonly graphKind: "entity";
  readonly activeMemoryId: string;
  readonly activeText: string;
  readonly evidence: AuthoritativeEntityEvidenceFact;
}

export interface AuthoritativeEntityGraphReadPort {
  read(input: AuthoritativeEntityGraphReadInput): Promise<AuthoritativeEntityGraphReadFact>;
}

export interface PostgresAuthoritativeEntityGraphReadResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly rows: readonly Row[];
  readonly rowCount?: number | null;
}

/** client 生命周期与事务所有权仍属于 PostgresProvider。 */
export interface PostgresAuthoritativeEntityGraphReadClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresAuthoritativeEntityGraphReadResult<Row>>;
}

const SAFE_ID = /^[^\s\p{Cc}]{1,256}$/u;
const INPUT_KEYS = ["graphKind", "activeMemoryId", "evidenceId", "scope", "signal"] as const;
const ROW_KEYS = [
  "active_memory_id", "active_text", "active_tenant_id", "active_user_id",
  "active_app_id", "active_project_id", "active_agent_id", "active_namespace",
  "active_visibility", "active_workspace_id", "active_session_id", "active_data_type",
  "active_lifecycle_status", "active_legacy_quarantine_reason", "active_metadata",
  "evidence_id", "evidence_text", "evidence_created_at_ms", "evidence_tenant_id",
  "evidence_user_id", "evidence_app_id", "evidence_project_id", "evidence_agent_id",
  "evidence_namespace", "evidence_visibility", "evidence_workspace_id",
  "evidence_session_id", "evidence_data_type", "evidence_lifecycle_status",
  "evidence_legacy_quarantine_reason", "evidence_metadata",
] as const;

const ACTIVE_SESSION_SQL = `COALESCE(
  active_memory.metadata->>'sessionId',
  active_memory.metadata #>> '{governance,provenance,sessionId}',
  ''
)`;
const EVIDENCE_SESSION_SQL = `COALESCE(
  evidence_memory.metadata->>'sessionId',
  evidence_memory.metadata #>> '{governance,provenance,sessionId}',
  ''
)`;

const READ_SQL = `SELECT
  active_memory.id::text AS active_memory_id,
  active_memory.text AS active_text,
  active_memory.tenant_id AS active_tenant_id,
  active_memory.user_id AS active_user_id,
  active_memory.product_id AS active_app_id,
  active_memory.canonical_project_id AS active_project_id,
  active_memory.producer_id AS active_agent_id,
  active_memory.namespace AS active_namespace,
  active_memory.visibility AS active_visibility,
  COALESCE(active_memory.workspace_id, '') AS active_workspace_id,
  ${ACTIVE_SESSION_SQL} AS active_session_id,
  active_memory.data_type AS active_data_type,
  active_memory.lifecycle_status AS active_lifecycle_status,
  active_memory.legacy_quarantine_reason AS active_legacy_quarantine_reason,
  active_memory.metadata AS active_metadata,
  evidence_memory.id::text AS evidence_id,
  evidence_memory.text AS evidence_text,
  floor(extract(epoch FROM evidence_memory.created_at) * 1000)::text AS evidence_created_at_ms,
  evidence_memory.tenant_id AS evidence_tenant_id,
  evidence_memory.user_id AS evidence_user_id,
  evidence_memory.product_id AS evidence_app_id,
  evidence_memory.canonical_project_id AS evidence_project_id,
  evidence_memory.producer_id AS evidence_agent_id,
  evidence_memory.namespace AS evidence_namespace,
  evidence_memory.visibility AS evidence_visibility,
  COALESCE(evidence_memory.workspace_id, '') AS evidence_workspace_id,
  ${EVIDENCE_SESSION_SQL} AS evidence_session_id,
  evidence_memory.data_type AS evidence_data_type,
  evidence_memory.lifecycle_status AS evidence_lifecycle_status,
  evidence_memory.legacy_quarantine_reason AS evidence_legacy_quarantine_reason,
  evidence_memory.metadata AS evidence_metadata
FROM memories AS active_memory
JOIN memories AS evidence_memory ON evidence_memory.id::text = $11
WHERE active_memory.tenant_id = $1
  AND active_memory.user_id = $2
  AND active_memory.product_id = $3
  AND active_memory.canonical_project_id = $4
  AND active_memory.producer_id = $5
  AND active_memory.namespace = $6
  AND active_memory.visibility = $7
  AND COALESCE(active_memory.workspace_id, '') = $8
  AND ${ACTIVE_SESSION_SQL} = $9
  AND (
    active_memory.metadata->>'sessionId' IS NULL
    OR active_memory.metadata #>> '{governance,provenance,sessionId}' IS NULL
    OR active_memory.metadata->>'sessionId' =
      active_memory.metadata #>> '{governance,provenance,sessionId}'
  )
  AND active_memory.id::text = $10
  AND active_memory.data_type = 'memory'
  AND active_memory.lifecycle_status = 'active'
  AND active_memory.metadata->>'admissionRoute' = 'active'
  AND active_memory.metadata->>'contextEligible' = 'true'
  AND active_memory.legacy_quarantine_reason IS NULL
  AND evidence_memory.tenant_id = $1
  AND evidence_memory.user_id = $2
  AND evidence_memory.product_id = $3
  AND evidence_memory.canonical_project_id = $4
  AND evidence_memory.producer_id = $5
  AND evidence_memory.namespace = $6
  AND evidence_memory.visibility = $7
  AND COALESCE(evidence_memory.workspace_id, '') = $8
  AND ${EVIDENCE_SESSION_SQL} = $9
  AND (
    evidence_memory.metadata->>'sessionId' IS NULL
    OR evidence_memory.metadata #>> '{governance,provenance,sessionId}' IS NULL
    OR evidence_memory.metadata->>'sessionId' =
      evidence_memory.metadata #>> '{governance,provenance,sessionId}'
  )
  AND evidence_memory.data_type = 'memory'
  AND evidence_memory.lifecycle_status = 'archived'
  AND evidence_memory.metadata->>'admissionRoute' = 'evidence_only'
  AND evidence_memory.metadata->>'contextEligible' = 'false'
  AND evidence_memory.metadata #>> '{governance,commandType}' = 'importEvidence'
  AND evidence_memory.metadata #>> '{governance,candidate,phase}' = 'raw_evidence'
  AND evidence_memory.metadata #>> '{governance,candidate,evidenceOnly}' = 'true'
  AND evidence_memory.legacy_quarantine_reason IS NULL`;

export class PostgresAuthoritativeEntityGraphReadError extends Error {
  readonly code = "POSTGRES_AUTHORITATIVE_ENTITY_GRAPH_READ_INVALID" as const;

  constructor() {
    super("Postgres authoritative Entity Graph read is invalid or incomplete");
    this.name = "PostgresAuthoritativeEntityGraphReadError";
  }
}

function invalid(): never {
  throw new PostgresAuthoritativeEntityGraphReadError();
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error && signal.reason.name === "AbortError"
    ? signal.reason
    : new DOMException("Authoritative Entity Graph read aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && value === value.trim() && SAFE_ID.test(value);
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

function exactInput(input: AuthoritativeEntityGraphReadInput): void {
  const record = dataRecord(input);
  const keys = Reflect.ownKeys(record);
  if (keys.length !== INPUT_KEYS.length || INPUT_KEYS.some((key) => !keys.includes(key)) ||
      input.graphKind !== "entity" || !safeId(input.activeMemoryId) ||
      !safeId(input.evidenceId) || !(input.signal instanceof AbortSignal)) invalid();
}

function exactRow(value: unknown): Record<(typeof ROW_KEYS)[number], unknown> {
  const record = dataRecord(value);
  const keys = Reflect.ownKeys(record);
  if (keys.length !== ROW_KEYS.length || ROW_KEYS.some((key) => !keys.includes(key)) ||
      keys.some((key) => typeof key !== "string" ||
        !ROW_KEYS.includes(key as (typeof ROW_KEYS)[number]))) invalid();
  return record as Record<(typeof ROW_KEYS)[number], unknown>;
}

function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) || value.length === 0 ||
      value.some((item) => !safeId(item)) || new Set(value).size !== value.length) invalid();
  return Object.freeze([...value]) as readonly string[];
}

function parseMillis(value: unknown): number {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) invalid();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) invalid();
  return parsed;
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

function assertScope(
  row: Record<(typeof ROW_KEYS)[number], unknown>,
  prefix: "active" | "evidence",
  scope: CanonicalAuthorityScope,
): void {
  const actual = [
    row[`${prefix}_tenant_id`], row[`${prefix}_user_id`], row[`${prefix}_app_id`],
    row[`${prefix}_project_id`], row[`${prefix}_agent_id`], row[`${prefix}_namespace`],
    row[`${prefix}_visibility`], row[`${prefix}_workspace_id`], row[`${prefix}_session_id`],
  ];
  const expected = [
    scope.tenantId, scope.userId, scope.appId, scope.projectId, scope.agentId,
    scope.namespace, scope.visibility, scope.workspaceId, scope.sessionId,
  ];
  if (actual.some((value, index) => value !== expected[index])) invalid();
}

function includesExactlyLinkedEvidence(
  metadata: Record<string, unknown>,
  evidenceId: string,
  scope: CanonicalAuthorityScope,
): void {
  const governance = dataRecord(metadata.governance);
  const candidate = dataRecord(governance.candidate);
  const candidateEvidence = dataRecord(candidate.evidence);
  const provenance = dataRecord(governance.provenance);
  const sourceNodeIds = stringList(metadata.sourceNodeIds);
  const evidenceIds = stringList(governance.evidenceIds);
  const eventIds = stringList(candidateEvidence.eventIds);
  if (!sourceNodeIds.includes(evidenceId) || !evidenceIds.includes(evidenceId) ||
      !eventIds.includes(evidenceId) || JSON.stringify(sourceNodeIds) !== JSON.stringify(evidenceIds) ||
      JSON.stringify(evidenceIds) !== JSON.stringify(eventIds) ||
      (scope.sessionId !== "" && provenance.sessionId !== scope.sessionId)) invalid();
}

function decode(
  value: unknown,
  input: AuthoritativeEntityGraphReadInput,
  scope: CanonicalAuthorityScope,
): AuthoritativeEntityGraphReadFact {
  const row = exactRow(value);
  assertScope(row, "active", scope);
  assertScope(row, "evidence", scope);
  if (row.active_memory_id !== input.activeMemoryId || row.evidence_id !== input.evidenceId ||
      typeof row.active_text !== "string" || row.active_text.trim().length === 0 ||
      typeof row.evidence_text !== "string" || row.evidence_text.trim().length === 0 ||
      row.active_data_type !== "memory" || row.active_lifecycle_status !== "active" ||
      row.active_legacy_quarantine_reason !== null || row.evidence_data_type !== "memory" ||
      row.evidence_lifecycle_status !== "archived" ||
      row.evidence_legacy_quarantine_reason !== null) invalid();

  const activeMetadata = dataRecord(row.active_metadata);
  if (activeMetadata.admissionRoute !== "active" || activeMetadata.contextEligible !== true ||
      !["personal", "project", "team", "enterprise"].includes(
        String(activeMetadata.memoryContainer),
      )) invalid();
  includesExactlyLinkedEvidence(activeMetadata, input.evidenceId, scope);

  const evidenceMetadata = dataRecord(row.evidence_metadata);
  const governance = dataRecord(evidenceMetadata.governance);
  const candidate = dataRecord(governance.candidate);
  const provenance = dataRecord(governance.provenance);
  const native = dataRecord(governance.native);
  const sourceNodeIds = stringList(evidenceMetadata.sourceNodeIds);
  const governanceEvidenceIds = stringList(governance.evidenceIds);
  const createdAt = parseMillis(row.evidence_created_at_ms);
  if (evidenceMetadata.admissionRoute !== "evidence_only" ||
      evidenceMetadata.contextEligible !== false ||
      evidenceMetadata.memoryContainer !== "session_candidate" ||
      evidenceMetadata.eventType !== "observation" ||
      governance.commandType !== "importEvidence" || candidate.phase !== "raw_evidence" ||
      candidate.evidenceOnly !== true || candidate.quote !== row.evidence_text ||
      !safeId(candidate.sourceId) || sourceNodeIds.length !== 1 ||
      sourceNodeIds[0] !== candidate.sourceId || governanceEvidenceIds.length !== 1 ||
      governanceEvidenceIds[0] !== candidate.sourceId || provenance.sourceId !== candidate.sourceId ||
      typeof provenance.source !== "string" || provenance.source.trim().length === 0 ||
      provenance.source.length > 256 ||
      (scope.sessionId !== "" && provenance.sessionId !== scope.sessionId) ||
      native.kind !== "observation" || native.container !== "session_candidate" ||
      native.dataType !== "memory") invalid();

  const evidence = Object.freeze({
    authority: "persisted_evidence" as const,
    evidenceId: input.evidenceId,
    scope: publicScope(scope),
    text: row.evidence_text,
    sourceId: candidate.sourceId,
    sourceKind: provenance.source,
    createdAt,
  });
  return Object.freeze({
    authority: "persisted_active_memory_evidence" as const,
    graphKind: "entity" as const,
    activeMemoryId: input.activeMemoryId,
    activeText: row.active_text,
    evidence,
  });
}

export class PostgresAuthoritativeEntityGraphReadPort
implements AuthoritativeEntityGraphReadPort {
  constructor(private readonly client: PostgresAuthoritativeEntityGraphReadClient) {
    if (!client || typeof client.query !== "function") invalid();
  }

  async read(input: AuthoritativeEntityGraphReadInput): Promise<AuthoritativeEntityGraphReadFact> {
    exactInput(input);
    throwIfAborted(input.signal);
    let scope: CanonicalAuthorityScope;
    try {
      scope = canonicalAuthorityScope(input.scope);
    } catch {
      return invalid();
    }
    const result = await this.client.query(READ_SQL, [
      scope.tenantId, scope.userId, scope.appId, scope.projectId, scope.agentId,
      scope.namespace, scope.visibility, scope.workspaceId, scope.sessionId,
      input.activeMemoryId, input.evidenceId,
    ]);
    throwIfAborted(input.signal);
    if (!result || !Array.isArray(result.rows) || result.rows.length !== 1 ||
        (result.rowCount !== undefined && result.rowCount !== null && result.rowCount !== 1)) {
      return invalid();
    }
    return decode(result.rows[0], input, scope);
  }
}
