/**
 * F0 provider-owned PostgreSQL 召回 hydration adapter。
 *
 * ANN/lexical/Graph 候选只提供 authoritative record identity 与存储 scope 坐标；
 * MemoryRecord、governance 和 evidence 集均从 PostgreSQL 权威回读，不接受候选正文、
 * metadata 或 evidence claims 作为事实源。request scope 的复用判断仍由 Engine 完成。
 */

import { types as nodeUtilTypes } from "node:util";

import type { MemoryCategory } from "../../../../config.js";
import {
  canonicalAuthorityScope,
  type CanonicalAuthorityScope,
} from "../domain/authority-scope-fingerprint.js";
import type {
  MemoryContainer,
  MemoryKind,
  MemoryRecord,
  MemoryScope,
  MemorySemanticType,
  RecordProvenance,
} from "../domain/types.js";
import { matchesContentHash } from "../scoring/hash-utils.js";
import type {
  GovernedRetrievalCandidate,
  GovernedRetrievalHydration,
  GovernedRetrievalHydrationRequest,
  GovernedRetrievalHydrator,
} from "./governed-retrieval-engine.js";

export interface PostgresGovernedRetrievalHydrationResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly rows: readonly Row[];
  readonly rowCount?: number | null;
}

/** client 生命周期归 PostgresProvider 所有。 */
export interface PostgresGovernedRetrievalHydrationClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresGovernedRetrievalHydrationResult<Row>>;
}

export type PostgresGovernedRetrievalHydrationRequest = GovernedRetrievalHydrationRequest & {
  readonly signal?: AbortSignal;
};

const SAFE_ID = /^[^\s\p{Cc}]{1,256}$/u;
const KINDS = new Set<MemoryKind>([
  "preference", "decision", "entity", "fact", "task", "plan", "goal",
  "document", "knowledge", "observation", "other",
]);
const SEMANTIC_TYPES = new Set<MemorySemanticType>([
  "profile", "task_context", "rules", "experience", "resource",
]);
const CONTAINERS = new Set<MemoryContainer>([
  "personal", "project", "session_candidate", "team", "enterprise",
]);
const CATEGORIES = new Set<MemoryCategory>([
  "core", "preference", "fact", "entity", "decision", "task", "plan", "goal", "other",
]);

const MEMORY_ROW_KEYS = [
  "id", "text", "content_hash", "importance", "category", "data_type",
  "created_at_ms", "updated_at_ms", "tenant_id", "user_id", "app_id",
  "project_id", "agent_id", "namespace", "visibility", "workspace_id",
  "session_id", "lifecycle_status", "legacy_quarantine_reason", "metadata",
] as const;

const EVIDENCE_ROW_KEYS = [
  "evidence_id", "evidence_text", "evidence_created_at_ms", "tenant_id", "user_id",
  "app_id", "project_id", "agent_id", "namespace", "visibility", "workspace_id",
  "session_id", "data_type", "lifecycle_status", "legacy_quarantine_reason", "metadata",
  "evidence_origin", "ledger_link_id", "ledger_target_memory_id",
  "ledger_evidence_memory_id", "ledger_link_kind", "ledger_source", "ledger_tenant_id",
  "ledger_user_id", "ledger_app_id", "ledger_project_id", "ledger_agent_id",
  "ledger_namespace", "ledger_visibility", "ledger_workspace_id", "ledger_session_id",
] as const;

const MEMORY_SESSION_SQL = `COALESCE(
  metadata->>'sessionId',
  metadata #>> '{governance,provenance,sessionId}',
  ''
)`;

const EFFECTIVE_MEMORY_LIFECYCLE_SQL = `CASE
  WHEN temporal_activation_state = 'staged'
    AND valid_from <= CURRENT_TIMESTAMP
    AND (valid_to IS NULL OR valid_to > CURRENT_TIMESTAMP)
  THEN 'active'
  ELSE lifecycle_status
END`;

const CURRENT_MEMORY_VERSION_SQL = `(lineage_id IS NULL OR id = (
  SELECT current_version.id
  FROM memories AS current_version
  WHERE current_version.scope_fingerprint = memories.scope_fingerprint
    AND current_version.lineage_id = memories.lineage_id
    AND current_version.valid_from <= CURRENT_TIMESTAMP
    AND (current_version.valid_to IS NULL OR current_version.valid_to > CURRENT_TIMESTAMP)
    AND current_version.temporal_invalidated IS NOT TRUE
    AND current_version.temporal_purge_pending IS NOT TRUE
    AND ((current_version.lifecycle_status = 'active'
        AND current_version.temporal_activation_state = 'active')
      OR (current_version.lifecycle_status = 'archived'
        AND current_version.temporal_activation_state = 'staged'))
  ORDER BY current_version.valid_from DESC, current_version.revision DESC
  LIMIT 1
))`;

const READ_MEMORY_SQL = `SELECT
  id::text AS id,
  text,
  content_hash,
  importance::double precision AS importance,
  category,
  data_type,
  floor(extract(epoch FROM created_at) * 1000)::text AS created_at_ms,
  floor(extract(epoch FROM created_at) * 1000)::text AS updated_at_ms,
  tenant_id,
  user_id,
  product_id AS app_id,
  canonical_project_id AS project_id,
  producer_id AS agent_id,
  namespace,
  visibility,
  COALESCE(workspace_id, '') AS workspace_id,
  ${MEMORY_SESSION_SQL} AS session_id,
  ${EFFECTIVE_MEMORY_LIFECYCLE_SQL} AS lifecycle_status,
  legacy_quarantine_reason,
  metadata
FROM memories
WHERE tenant_id = $1
  AND user_id = $2
  AND product_id = $3
  AND canonical_project_id = $4
  AND producer_id = $5
  AND namespace = $6
  AND visibility = $7
  AND COALESCE(workspace_id, '') = $8
  AND ${MEMORY_SESSION_SQL} = $9
  AND id::text = $10
  AND data_type = 'memory'
  AND ${EFFECTIVE_MEMORY_LIFECYCLE_SQL} IN ('active', 'archived')
  AND metadata->>'admissionRoute' IN ('active', 'lookup_only')
  AND legacy_quarantine_reason IS NULL
  AND temporal_invalidated IS NOT TRUE
  AND temporal_purge_pending IS NOT TRUE
  AND (lineage_id IS NULL OR (
    valid_from <= CURRENT_TIMESTAMP
    AND (valid_to IS NULL OR valid_to > CURRENT_TIMESTAMP)
  ))
  AND ${CURRENT_MEMORY_VERSION_SQL}
  AND (
    metadata->>'sessionId' IS NULL
    OR metadata #>> '{governance,provenance,sessionId}' IS NULL
    OR metadata->>'sessionId' = metadata #>> '{governance,provenance,sessionId}'
  )`;

const EVIDENCE_SESSION_SQL = `COALESCE(
  evidence.metadata->>'sessionId',
  evidence.metadata #>> '{governance,provenance,sessionId}',
  ''
)`;

const READ_EVIDENCE_SQL = `WITH direct_evidence AS (
  SELECT evidence_id, ordinal::bigint AS ordering
  FROM unnest($11::text[]) WITH ORDINALITY AS direct(evidence_id, ordinal)
), duplicate_links AS (
  SELECT link_id, target_memory_id, evidence_memory_id, link_kind, source,
    tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility,
    workspace_id, session_id
  FROM mengshu_memory_evidence_links
  WHERE tenant_id = $1
    AND user_id = $2
    AND app_id = $3
    AND project_id = $4
    AND agent_id = $5
    AND namespace = $6
    AND visibility = $7
    AND workspace_id = $8
    AND session_id = $9
    AND target_memory_id = $10
    AND link_kind = 'duplicate_evidence'
), requested_evidence AS (
  SELECT evidence_id, 'record'::text AS evidence_origin, ordering,
    NULL::text AS link_id
  FROM direct_evidence
  UNION ALL
  SELECT evidence_memory_id, 'duplicate_ledger'::text, 1000000, link_id
  FROM duplicate_links
  WHERE evidence_memory_id <> ALL($11::text[])
)
SELECT evidence.id::text AS evidence_id,
  evidence.text AS evidence_text,
  floor(extract(epoch FROM evidence.created_at) * 1000)::text AS evidence_created_at_ms,
  evidence.tenant_id,
  evidence.user_id,
  evidence.product_id AS app_id,
  evidence.canonical_project_id AS project_id,
  evidence.producer_id AS agent_id,
  evidence.namespace,
  evidence.visibility,
  COALESCE(evidence.workspace_id, '') AS workspace_id,
  ${EVIDENCE_SESSION_SQL} AS session_id,
  evidence.data_type,
  evidence.lifecycle_status,
  evidence.legacy_quarantine_reason,
  evidence.metadata,
  requested.evidence_origin,
  links.link_id AS ledger_link_id,
  links.target_memory_id AS ledger_target_memory_id,
  links.evidence_memory_id AS ledger_evidence_memory_id,
  links.link_kind AS ledger_link_kind,
  links.source AS ledger_source,
  links.tenant_id AS ledger_tenant_id,
  links.user_id AS ledger_user_id,
  links.app_id AS ledger_app_id,
  links.project_id AS ledger_project_id,
  links.agent_id AS ledger_agent_id,
  links.namespace AS ledger_namespace,
  links.visibility AS ledger_visibility,
  links.workspace_id AS ledger_workspace_id,
  links.session_id AS ledger_session_id
FROM requested_evidence AS requested
JOIN memories AS evidence ON evidence.id::text = requested.evidence_id
LEFT JOIN duplicate_links AS links ON links.link_id = requested.link_id
WHERE evidence.tenant_id = $1
  AND evidence.user_id = $2
  AND evidence.product_id = $3
  AND evidence.canonical_project_id = $4
  AND evidence.producer_id = $5
  AND evidence.namespace = $6
  AND evidence.visibility = $7
  AND COALESCE(evidence.workspace_id, '') = $8
  AND ${EVIDENCE_SESSION_SQL} = $9
  AND evidence.data_type = 'memory'
  AND evidence.lifecycle_status = 'archived'
  AND evidence.metadata->>'admissionRoute' = 'evidence_only'
  AND evidence.metadata->>'contextEligible' = 'false'
  AND evidence.metadata #>> '{governance,commandType}' = 'importEvidence'
  AND evidence.metadata #>> '{governance,candidate,phase}' = 'raw_evidence'
  AND evidence.metadata #>> '{governance,candidate,evidenceOnly}' = 'true'
  AND evidence.legacy_quarantine_reason IS NULL
  AND (
    evidence.metadata->>'sessionId' IS NULL
    OR evidence.metadata #>> '{governance,provenance,sessionId}' IS NULL
    OR evidence.metadata->>'sessionId' =
      evidence.metadata #>> '{governance,provenance,sessionId}'
  )
ORDER BY requested.ordering, evidence.id`;

function invalid(): undefined {
  return undefined;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error && signal.reason.name === "AbortError"
    ? signal.reason
    : new DOMException("Governed retrieval hydration aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && value === value.trim() && SAFE_ID.test(value);
}

function dataRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || key === "__proto__" || key === "prototype" ||
        key === "constructor") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor) || descriptor.value === undefined) {
      return undefined;
    }
    result[key] = descriptor.value;
  }
  return result;
}

function exactRow<const Keys extends readonly string[]>(
  value: unknown,
  expected: Keys,
): Record<Keys[number], unknown> | undefined {
  const record = dataRecord(value);
  if (!record) return undefined;
  const keys = Reflect.ownKeys(record);
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key)) ||
      keys.some((key) => typeof key !== "string" || !expected.includes(key))) return undefined;
  return record as Record<Keys[number], unknown>;
}

function jsonSnapshot(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : invalid();
  if (!value || typeof value !== "object" || nodeUtilTypes.isProxy(value) || ancestors.has(value)) {
    return invalid();
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).length !== value.length + 1) return invalid();
      return Object.freeze(value.map((item) => jsonSnapshot(item, ancestors)));
    }
    const record = dataRecord(value);
    if (!record) return invalid();
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      const snapshot = jsonSnapshot(item, ancestors);
      if (snapshot === undefined) return invalid();
      result[key] = snapshot;
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
}

function ids(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) || value.length === 0 ||
      value.length > 10_000 || value.some((item) => !safeId(item)) ||
      new Set(value).size !== value.length) return undefined;
  return Object.freeze([...value]) as readonly string[];
}

function strings(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) ||
      value.some((item) => typeof item !== "string" || item.trim().length === 0 ||
        item !== item.trim()) || new Set(value).size !== value.length) return undefined;
  return Object.freeze([...value]) as readonly string[];
}

function score(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function millis(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
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

function sameScopeRow(
  row: Record<string, unknown>,
  scope: CanonicalAuthorityScope,
  prefix = "",
): boolean {
  const actual = [
    row[`${prefix}tenant_id`], row[`${prefix}user_id`], row[`${prefix}app_id`],
    row[`${prefix}project_id`], row[`${prefix}agent_id`], row[`${prefix}namespace`],
    row[`${prefix}visibility`], row[`${prefix}workspace_id`], row[`${prefix}session_id`],
  ];
  const expected = [
    scope.tenantId, scope.userId, scope.appId, scope.projectId, scope.agentId,
    scope.namespace, scope.visibility, scope.workspaceId, scope.sessionId,
  ];
  return actual.every((value, index) => value === expected[index]);
}

interface DecodedMemory {
  readonly record: MemoryRecord;
  readonly directEvidenceIds: readonly string[];
}

function decodeMemory(
  value: unknown,
  scope: CanonicalAuthorityScope,
  authoritativeRecordId: string,
): DecodedMemory | undefined {
  const row = exactRow(value, MEMORY_ROW_KEYS);
  if (!row || row.id !== authoritativeRecordId || !sameScopeRow(row, scope) ||
      typeof row.text !== "string" || row.text.trim().length === 0 ||
      typeof row.content_hash !== "string" || !matchesContentHash(row.text, row.content_hash) ||
      !score(row.importance) || typeof row.category !== "string" ||
      row.category.trim().length === 0 || row.category !== row.category.trim() ||
      row.data_type !== "memory" ||
      row.legacy_quarantine_reason !== null) return invalid();
  const createdAt = millis(row.created_at_ms);
  const updatedAt = millis(row.updated_at_ms);
  if (createdAt === undefined || updatedAt === undefined || updatedAt < createdAt) return invalid();

  const metadata = dataRecord(row.metadata);
  if (!metadata) return invalid();
  const governance = dataRecord(metadata.governance);
  const candidate = governance && dataRecord(governance.candidate);
  const candidateEvidence = candidate && dataRecord(candidate.evidence);
  const provenance = governance && dataRecord(governance.provenance);
  const native = governance && dataRecord(governance.native);
  if (!governance || !candidate || !candidateEvidence || !provenance || !native) return invalid();

  const route = metadata.admissionRoute;
  const lifecycle = row.lifecycle_status;
  const container = metadata.memoryContainer;
  if ((route !== "active" && route !== "lookup_only") ||
      (route === "active" && (lifecycle !== "active" || metadata.contextEligible !== true ||
        container === "session_candidate")) ||
      (route === "lookup_only" && (lifecycle !== "archived" ||
        metadata.contextEligible !== false || container !== "session_candidate")) ||
      typeof container !== "string" || !CONTAINERS.has(container as MemoryContainer)) {
    return invalid();
  }

  const directEvidenceIds = ids(governance.evidenceIds);
  const sourceNodeIds = ids(metadata.sourceNodeIds);
  const eventIds = ids(candidateEvidence.eventIds);
  if (!directEvidenceIds || !sourceNodeIds || !eventIds ||
      JSON.stringify(directEvidenceIds) !== JSON.stringify(sourceNodeIds) ||
      JSON.stringify(sourceNodeIds) !== JSON.stringify(eventIds)) return invalid();

  const riskFlags = metadata.riskFlags === undefined ? Object.freeze([]) : strings(metadata.riskFlags);
  const candidateRiskFlags = strings(candidate.riskFlags);
  if (!riskFlags || !candidateRiskFlags ||
      (candidate.targetScope !== undefined && typeof candidate.targetScope !== "string")) {
    return invalid();
  }
  const combinedRisk = new Set([...riskFlags, ...candidateRiskFlags]);
  if (combinedRisk.has("prompt_injection")) return invalid();
  const expanded = scope.visibility !== "private" || candidate.targetScope === "workspace" ||
    candidate.targetScope === "global";
  if (combinedRisk.has("sensitive") && expanded) return invalid();

  const semanticType = native.semanticType;
  if (typeof native.kind !== "string" || !KINDS.has(native.kind as MemoryKind) ||
      (semanticType !== undefined &&
        (typeof semanticType !== "string" ||
          !SEMANTIC_TYPES.has(semanticType as MemorySemanticType))) ||
      semanticType !== metadata.semanticType ||
      (native.container !== undefined && native.container !== container) ||
      native.category !== row.category || native.dataType !== "memory" ||
      typeof provenance.source !== "string" || provenance.source.trim().length === 0 ||
      (scope.sessionId !== "" && provenance.sessionId !== scope.sessionId) ||
      !score(metadata.confidence) || !score(metadata.valueScore)) return invalid();

  const metadataSnapshot = jsonSnapshot(metadata);
  const provenanceSnapshot = jsonSnapshot(provenance);
  if (!metadataSnapshot || typeof metadataSnapshot !== "object" ||
      !provenanceSnapshot || typeof provenanceSnapshot !== "object") return invalid();
  return Object.freeze({
    directEvidenceIds,
    record: Object.freeze({
      id: authoritativeRecordId,
      scope: publicScope(scope),
      kind: native.kind as MemoryKind,
      ...(semanticType === undefined ? {} : { semanticType: semanticType as MemorySemanticType }),
      container: container as MemoryContainer,
      lifecycleStatus: lifecycle as MemoryRecord["lifecycleStatus"],
      confidence: metadata.confidence,
      text: row.text,
      contentHash: row.content_hash,
      importance: row.importance,
      category: CATEGORIES.has(row.category as MemoryCategory)
        ? row.category as MemoryCategory
        : "other",
      dataType: "memory",
      metadata: metadataSnapshot as Record<string, unknown>,
      provenance: provenanceSnapshot as RecordProvenance,
      sourceNodeIds: [...directEvidenceIds],
      createdAt,
      updatedAt,
    }),
  });
}

function validateRawEvidence(
  row: Record<(typeof EVIDENCE_ROW_KEYS)[number], unknown>,
  scope: CanonicalAuthorityScope,
): boolean {
  if (!safeId(row.evidence_id) || !sameScopeRow(row, scope) ||
      typeof row.evidence_text !== "string" || row.evidence_text.trim().length === 0 ||
      row.data_type !== "memory" || row.lifecycle_status !== "archived" ||
      row.legacy_quarantine_reason !== null) return false;
  const createdAt = millis(row.evidence_created_at_ms);
  const metadata = dataRecord(row.metadata);
  const governance = metadata && dataRecord(metadata.governance);
  const candidate = governance && dataRecord(governance.candidate);
  const provenance = governance && dataRecord(governance.provenance);
  const native = governance && dataRecord(governance.native);
  const sourceNodeIds = metadata && ids(metadata.sourceNodeIds);
  const evidenceIds = governance && ids(governance.evidenceIds);
  return createdAt !== undefined && !!metadata && !!governance && !!candidate && !!provenance &&
    !!native && !!sourceNodeIds && !!evidenceIds &&
    metadata.admissionRoute === "evidence_only" && metadata.contextEligible === false &&
    metadata.memoryContainer === "session_candidate" &&
    (metadata.eventType === "observation" || metadata.eventType === "explicit_save") &&
    governance.commandType === "importEvidence" && candidate.phase === "raw_evidence" &&
    candidate.evidenceOnly === true && candidate.quote === row.evidence_text &&
    safeId(candidate.sourceId) && sourceNodeIds.length === 1 &&
    sourceNodeIds[0] === candidate.sourceId && evidenceIds.length === 1 &&
    evidenceIds[0] === candidate.sourceId && provenance.sourceId === candidate.sourceId &&
    typeof provenance.source === "string" && provenance.source.trim().length > 0 &&
    (scope.sessionId === "" || provenance.sessionId === scope.sessionId) &&
    native.kind === "observation" && native.container === "session_candidate" &&
    native.dataType === "memory";
}

function decodeEvidence(
  values: readonly unknown[],
  scope: CanonicalAuthorityScope,
  authoritativeRecordId: string,
  directEvidenceIds: readonly string[],
): readonly string[] | undefined {
  const proven: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const row = exactRow(value, EVIDENCE_ROW_KEYS);
    if (!row || !validateRawEvidence(row, scope) || seen.has(String(row.evidence_id))) return invalid();
    const evidenceId = row.evidence_id as string;
    seen.add(evidenceId);
    if (row.evidence_origin === "record") {
      if (!directEvidenceIds.includes(evidenceId) || [
        row.ledger_link_id, row.ledger_target_memory_id, row.ledger_evidence_memory_id,
        row.ledger_link_kind, row.ledger_source, row.ledger_tenant_id, row.ledger_user_id,
        row.ledger_app_id, row.ledger_project_id, row.ledger_agent_id, row.ledger_namespace,
        row.ledger_visibility, row.ledger_workspace_id, row.ledger_session_id,
      ].some((item) => item !== null)) return invalid();
    } else if (row.evidence_origin === "duplicate_ledger") {
      if (!safeId(row.ledger_link_id) || row.ledger_target_memory_id !== authoritativeRecordId ||
          row.ledger_evidence_memory_id !== evidenceId ||
          row.ledger_link_kind !== "duplicate_evidence" ||
          row.ledger_source !== "write_kernel_dedup" ||
          !sameScopeRow(row, scope, "ledger_")) return invalid();
    } else {
      return invalid();
    }
    proven.push(evidenceId);
  }
  if (directEvidenceIds.some((id) => !seen.has(id)) || proven.length !== values.length) {
    return invalid();
  }
  return Object.freeze(proven);
}

function canonicalCandidateScope(
  input: PostgresGovernedRetrievalHydrationRequest,
): CanonicalAuthorityScope | undefined {
  if (!input || !safeId(input.authoritativeRecordId) || !Array.isArray(input.candidates) ||
      input.candidates.length === 0 || input.candidates.length > 10_000 ||
      (input.signal !== undefined && !(input.signal instanceof AbortSignal))) return invalid();
  let scope: CanonicalAuthorityScope;
  try {
    scope = canonicalAuthorityScope(input.candidates[0]!.scope);
  } catch {
    return invalid();
  }
  const snapshot = JSON.stringify(scope);
  for (const candidate of input.candidates) {
    if (!candidate || candidate.authoritativeRecordId !== input.authoritativeRecordId) return invalid();
    try {
      if (JSON.stringify(canonicalAuthorityScope(candidate.scope)) !== snapshot) return invalid();
    } catch {
      return invalid();
    }
  }
  return scope;
}

function validResult(result: unknown): result is PostgresGovernedRetrievalHydrationResult {
  if (!result || typeof result !== "object") return false;
  const typed = result as PostgresGovernedRetrievalHydrationResult;
  return Array.isArray(typed.rows) &&
    (typed.rowCount === undefined || typed.rowCount === null ||
      (Number.isSafeInteger(typed.rowCount) && typed.rowCount === typed.rows.length));
}

function scopeParams(
  scope: CanonicalAuthorityScope,
  authoritativeRecordId: string,
): readonly unknown[] {
  return [scope.tenantId, scope.userId, scope.appId, scope.projectId, scope.agentId,
    scope.namespace, scope.visibility, scope.workspaceId, scope.sessionId,
    authoritativeRecordId];
}

export class PostgresGovernedRetrievalHydrator implements GovernedRetrievalHydrator {
  constructor(private readonly client: PostgresGovernedRetrievalHydrationClient) {
    if (!client || typeof client.query !== "function") {
      throw new TypeError("Postgres governed retrieval hydration client is required");
    }
  }

  async hydrate(
    input: PostgresGovernedRetrievalHydrationRequest,
  ): Promise<GovernedRetrievalHydration | undefined> {
    const scope = canonicalCandidateScope(input);
    if (!scope) return invalid();
    throwIfAborted(input.signal);
    const memoryResult = await this.client.query(
      READ_MEMORY_SQL,
      scopeParams(scope, input.authoritativeRecordId),
    );
    throwIfAborted(input.signal);
    if (!validResult(memoryResult) || memoryResult.rows.length !== 1) return invalid();
    const memory = decodeMemory(memoryResult.rows[0], scope, input.authoritativeRecordId);
    if (!memory) return invalid();

    const evidenceResult = await this.client.query(READ_EVIDENCE_SQL, [
      ...scopeParams(scope, input.authoritativeRecordId),
      memory.directEvidenceIds,
    ]);
    throwIfAborted(input.signal);
    if (!validResult(evidenceResult)) return invalid();
    const evidenceIds = decodeEvidence(
      evidenceResult.rows,
      scope,
      input.authoritativeRecordId,
      memory.directEvidenceIds,
    );
    if (!evidenceIds) return invalid();
    return Object.freeze({
      record: Object.freeze({ ...memory.record, sourceNodeIds: [...evidenceIds] }),
      evidenceIds,
    });
  }
}
