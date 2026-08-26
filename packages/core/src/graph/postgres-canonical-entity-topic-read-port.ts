import { types as nodeUtilTypes } from "node:util";

import {
  authorityScopeFingerprint,
  canonicalAuthorityScope,
  type CanonicalAuthorityScope,
} from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope, MemorySemanticType } from "../domain/types.js";
import type { TreeFanOutRoutingInput } from "../tree/tree-fan-out.js";
import {
  type CanonicalEntityTopicMemoryFact,
  type EntityGraphEvidenceLink,
} from "./authoritative-entity-graph-derivation.js";
import { ENTITY_TYPES } from "./schema.js";
import type { GraphEntityRecord } from "./types.js";

export interface CanonicalEntityTopicReadInput {
  readonly graphKind: "entity";
  readonly activeMemoryId: string;
  readonly evidenceId: string;
  readonly receiptEntityIds: readonly string[];
  readonly scope: MemoryScope;
  readonly signal: AbortSignal;
}

export interface CanonicalEntityTopicReadFacts {
  readonly canonicalFactsAuthority: "graph_repository";
  readonly memory: CanonicalEntityTopicMemoryFact;
  readonly canonicalEntities: readonly Readonly<GraphEntityRecord>[];
  readonly entityEvidenceLinks: readonly EntityGraphEvidenceLink[];
}

export interface CanonicalEntityTopicReadPort {
  read(input: CanonicalEntityTopicReadInput): Promise<CanonicalEntityTopicReadFacts>;
}

export interface PostgresCanonicalEntityTopicReadClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Row[]; readonly rowCount?: number | null }>;
}

const SAFE_ID = /^[^\s\p{Cc}]{1,256}$/u;
const SHA256 = /^[0-9a-f]{64}$/;
const SEMANTIC_TYPES = new Set<MemorySemanticType>([
  "profile", "task_context", "rules", "experience", "resource",
]);
const SCOPE_VISIBILITIES = new Set([
  "session", "project", "workspace", "app", "user", "global",
]);
const ENTITY_TYPE_SET = new Set<string>(ENTITY_TYPES);
const INPUT_KEYS = [
  "graphKind", "activeMemoryId", "evidenceId", "receiptEntityIds", "scope", "signal",
] as const;
const ENTITY_COLUMNS = [
  "entity_id", "entity_canonical_name", "entity_display_name", "entity_type",
  "entity_aliases", "entity_mention_count", "entity_mention_count_30d",
  "entity_distinct_source_count", "entity_last_seen_at", "entity_hotness",
  "entity_graph_centrality", "entity_query_hits_30d", "entity_status",
  "entity_merged_into", "entity_created_at", "entity_updated_at", "entity_metadata",
] as const;
const EVIDENCE_COLUMNS = [
  "entity_evidence_link_id", "entity_evidence_memory_id", "entity_evidence_source_id",
  "entity_evidence_source_kind", "entity_evidence_created_at",
] as const;
const ROW_KEYS = [
  "active_memory_id", "active_text", "active_importance", "active_created_at_ms",
  "active_tenant_id", "active_user_id", "active_app_id", "active_project_id",
  "active_agent_id", "active_namespace", "active_visibility", "active_workspace_id",
  "active_session_id", "active_data_type", "active_lifecycle_status",
  "active_legacy_quarantine_reason", "active_metadata", "memory_link_id",
  "memory_link_scope_fingerprint", "memory_link_target_memory_id",
  "memory_link_evidence_memory_id", "memory_link_kind", "memory_link_source",
  "memory_link_created_at", ...ENTITY_COLUMNS, ...EVIDENCE_COLUMNS,
] as const;

const ACTIVE_SESSION_SQL = `COALESCE(
  active_memory.metadata->>'sessionId',
  active_memory.metadata #>> '{governance,provenance,sessionId}',
  ''
)`;

const READ_SQL = `SELECT
  active_memory.id::text AS active_memory_id,
  active_memory.text AS active_text,
  active_memory.importance AS active_importance,
  floor(extract(epoch FROM active_memory.created_at) * 1000)::text AS active_created_at_ms,
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
  memory_link.link_id AS memory_link_id,
  memory_link.scope_fingerprint AS memory_link_scope_fingerprint,
  memory_link.target_memory_id AS memory_link_target_memory_id,
  memory_link.evidence_memory_id AS memory_link_evidence_memory_id,
  memory_link.link_kind AS memory_link_kind,
  memory_link.source AS memory_link_source,
  memory_link.created_at::text AS memory_link_created_at,
  entity.id AS entity_id,
  entity.canonical_name AS entity_canonical_name,
  entity.display_name AS entity_display_name,
  entity.entity_type AS entity_type,
  entity.aliases AS entity_aliases,
  entity.mention_count AS entity_mention_count,
  entity.mention_count_30d AS entity_mention_count_30d,
  entity.distinct_source_count AS entity_distinct_source_count,
  entity.last_seen_at::text AS entity_last_seen_at,
  entity.hotness AS entity_hotness,
  entity.graph_centrality AS entity_graph_centrality,
  entity.query_hits_30d AS entity_query_hits_30d,
  entity.status AS entity_status,
  entity.merged_into AS entity_merged_into,
  entity.created_at::text AS entity_created_at,
  entity.updated_at::text AS entity_updated_at,
  entity.metadata AS entity_metadata,
  entity_evidence.link_id AS entity_evidence_link_id,
  entity_evidence.evidence_memory_id AS entity_evidence_memory_id,
  entity_evidence.source_id AS entity_evidence_source_id,
  entity_evidence.source_kind AS entity_evidence_source_kind,
  entity_evidence.created_at::text AS entity_evidence_created_at
FROM memories AS active_memory
JOIN mengshu_memory_evidence_links AS memory_link
  ON memory_link.target_memory_id = active_memory.id::text
  AND memory_link.evidence_memory_id = $11
  AND memory_link.link_kind = 'grounded_by'
  AND memory_link.source = 'entity_graph'
  AND memory_link.tenant_id = $1 AND memory_link.user_id = $2
  AND memory_link.app_id = $3 AND memory_link.project_id = $4
  AND memory_link.agent_id = $5 AND memory_link.namespace = $6
  AND memory_link.visibility = $7 AND memory_link.workspace_id = $8
  AND memory_link.session_id = $9
LEFT JOIN unnest($12::text[]) AS receipt_entity(entity_id) ON TRUE
LEFT JOIN mengshu_graph_entities AS entity
  ON entity.id = receipt_entity.entity_id
  AND entity.tenant_id = $1 AND entity.user_id = $2 AND entity.app_id = $3
  AND entity.project_id = $4 AND entity.agent_id = $5 AND entity.namespace = $6
  AND entity.visibility = $7 AND entity.workspace_id = $8 AND entity.session_id = $9
  AND entity.status = 'active'
LEFT JOIN mengshu_graph_entity_evidence AS entity_evidence
  ON entity_evidence.entity_id = entity.id
  AND entity_evidence.evidence_memory_id = $11
  AND entity_evidence.tenant_id = $1 AND entity_evidence.user_id = $2
  AND entity_evidence.app_id = $3 AND entity_evidence.project_id = $4
  AND entity_evidence.agent_id = $5 AND entity_evidence.namespace = $6
  AND entity_evidence.visibility = $7 AND entity_evidence.workspace_id = $8
  AND entity_evidence.session_id = $9
WHERE active_memory.id::text = $10
  AND active_memory.tenant_id = $1 AND active_memory.user_id = $2
  AND active_memory.product_id = $3 AND active_memory.canonical_project_id = $4
  AND active_memory.producer_id = $5 AND active_memory.namespace = $6
  AND active_memory.visibility = $7 AND COALESCE(active_memory.workspace_id, '') = $8
  AND ${ACTIVE_SESSION_SQL} = $9
  AND active_memory.data_type = 'memory' AND active_memory.lifecycle_status = 'active'
  AND active_memory.metadata->>'admissionRoute' = 'active'
  AND active_memory.metadata->>'contextEligible' = 'true'
  AND active_memory.legacy_quarantine_reason IS NULL
ORDER BY entity.id`;

export class PostgresCanonicalEntityTopicReadError extends Error {
  readonly code = "POSTGRES_CANONICAL_ENTITY_TOPIC_READ_INVALID" as const;

  constructor() {
    super("Postgres canonical Entity topic read is invalid or incomplete");
    this.name = "PostgresCanonicalEntityTopicReadError";
  }
}

function invalid(): never {
  throw new PostgresCanonicalEntityTopicReadError();
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error && signal.reason.name === "AbortError"
    ? signal.reason
    : new DOMException("Canonical Entity topic read aborted", "AbortError");
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
  const record: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || key === "__proto__" || key === "constructor" || key === "prototype") {
      invalid();
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor) || descriptor.value === undefined) invalid();
    record[key] = descriptor.value;
  }
  return record;
}

function exactRow(value: unknown): Record<(typeof ROW_KEYS)[number], unknown> {
  const row = dataRecord(value);
  if (Reflect.ownKeys(row).length !== ROW_KEYS.length ||
      ROW_KEYS.some((key) => !Object.hasOwn(row, key))) invalid();
  return row as Record<(typeof ROW_KEYS)[number], unknown>;
}

function parseMillis(value: unknown, nullable = false): number | undefined {
  if (nullable && value === null) return undefined;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) invalid();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) invalid();
  return parsed;
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalid();
  return Number(value);
}

function score(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) invalid();
  return value;
}

function strings(value: unknown, allowEmpty = true): readonly string[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) || (!allowEmpty && value.length === 0) ||
      value.some((item) => typeof item !== "string" || item.trim().length === 0) ||
      new Set(value).size !== value.length) invalid();
  return Object.freeze([...value]);
}

function ids(value: unknown, allowEmpty = true): readonly string[] {
  const result = strings(value, allowEmpty);
  if (result.some((item) => !safeId(item))) invalid();
  return result;
}

function publicScope(scope: CanonicalAuthorityScope): MemoryScope {
  return Object.freeze({
    tenantId: scope.tenantId, userId: scope.userId, appId: scope.appId,
    projectId: scope.projectId, agentId: scope.agentId, namespace: scope.namespace,
    visibility: scope.visibility,
    ...(scope.workspaceId === "" ? {} : { workspaceId: scope.workspaceId }),
    ...(scope.sessionId === "" ? {} : { sessionId: scope.sessionId }),
  });
}

function assertRowAuthority(
  row: Record<(typeof ROW_KEYS)[number], unknown>,
  scope: CanonicalAuthorityScope,
  input: CanonicalEntityTopicReadInput,
): void {
  const actual = [
    row.active_tenant_id, row.active_user_id, row.active_app_id, row.active_project_id,
    row.active_agent_id, row.active_namespace, row.active_visibility,
    row.active_workspace_id, row.active_session_id,
  ];
  const expected = [
    scope.tenantId, scope.userId, scope.appId, scope.projectId, scope.agentId,
    scope.namespace, scope.visibility, scope.workspaceId, scope.sessionId,
  ];
  if (actual.some((value, index) => value !== expected[index]) ||
      row.active_memory_id !== input.activeMemoryId || row.active_data_type !== "memory" ||
      row.active_lifecycle_status !== "active" || row.active_legacy_quarantine_reason !== null ||
      row.memory_link_target_memory_id !== input.activeMemoryId ||
      row.memory_link_evidence_memory_id !== input.evidenceId ||
      row.memory_link_kind !== "grounded_by" || row.memory_link_source !== "entity_graph" ||
      !SHA256.test(String(row.memory_link_id)) ||
      row.memory_link_scope_fingerprint !== authorityScopeFingerprint(publicScope(scope))) {
    invalid();
  }
  parseMillis(row.memory_link_created_at);
}

function decodeMemory(
  row: Record<(typeof ROW_KEYS)[number], unknown>,
  input: CanonicalEntityTopicReadInput,
  scope: CanonicalAuthorityScope,
): CanonicalEntityTopicMemoryFact {
  if (typeof row.active_text !== "string" || row.active_text.trim().length === 0) invalid();
  const metadata = dataRecord(row.active_metadata);
  const governance = dataRecord(metadata.governance);
  const candidate = dataRecord(governance.candidate);
  const native = dataRecord(governance.native);
  const routing = dataRecord(candidate.treeRouting);
  const evidenceIds = ids(governance.evidenceIds, false);
  const sourceNodeIds = ids(metadata.sourceNodeIds, false);
  const eventIds = ids(dataRecord(candidate.evidence).eventIds, false);
  const riskFlags = strings(routing.riskFlags);
  const candidateRiskFlags = strings(candidate.riskFlags);
  const topicLabels = strings(routing.topicLabels);
  const importance = score(row.active_importance);
  const valueScore = score(metadata.valueScore);
  const semanticType = native.semanticType;
  if (metadata.admissionRoute !== "active" || metadata.contextEligible !== true ||
      metadata.importance !== importance || metadata.semanticType !== semanticType ||
      typeof semanticType !== "string" || !SEMANTIC_TYPES.has(semanticType as MemorySemanticType) ||
      evidenceIds.length !== 1 || evidenceIds[0] !== input.evidenceId ||
      JSON.stringify(evidenceIds) !== JSON.stringify(sourceNodeIds) ||
      JSON.stringify(evidenceIds) !== JSON.stringify(eventIds) || routing.version !== 1 ||
      routing.evidenceId !== input.evidenceId || !safeId(routing.sourceId) ||
      typeof routing.scopeVisibility !== "string" || !SCOPE_VISIBILITIES.has(routing.scopeVisibility) ||
      JSON.stringify(riskFlags) !== JSON.stringify(candidateRiskFlags) || topicLabels.length !== 0 ||
      routing.topicHotnessEligible !== false ||
      (routing.explicitGlobal !== undefined && typeof routing.explicitGlobal !== "boolean") ||
      (routing.isWorkspaceRule !== undefined && typeof routing.isWorkspaceRule !== "boolean")) invalid();
  const createdAt = parseMillis(row.active_created_at_ms)!;
  const routingFact: TreeFanOutRoutingInput = Object.freeze({
    valueScore,
    importance,
    semanticType: semanticType as MemorySemanticType,
    scopeVisibility: routing.scopeVisibility as TreeFanOutRoutingInput["scopeVisibility"],
    riskFlags: Object.freeze([...riskFlags]) as string[],
    topicHotnessEligible: false,
    ...(routing.explicitGlobal === undefined ? {} : { explicitGlobal: routing.explicitGlobal as boolean }),
    ...(routing.isWorkspaceRule === undefined ? {} : { isWorkspaceRule: routing.isWorkspaceRule as boolean }),
  });
  return Object.freeze({
    memoryId: input.activeMemoryId,
    scope: publicScope(scope),
    text: row.active_text,
    evidenceId: input.evidenceId,
    sourceId: routing.sourceId,
    entityIds: Object.freeze([...input.receiptEntityIds]),
    eventAt: createdAt,
    createdAt,
    routing: routingFact,
  });
}

function decodeEntity(
  row: Record<(typeof ROW_KEYS)[number], unknown>,
  scope: MemoryScope,
): Readonly<GraphEntityRecord> | undefined {
  if (row.entity_id === null && ENTITY_COLUMNS.every((key) => row[key] === null)) return undefined;
  if (!safeId(row.entity_id) || typeof row.entity_canonical_name !== "string" ||
      row.entity_canonical_name.trim().length === 0 || typeof row.entity_display_name !== "string" ||
      row.entity_display_name.trim().length === 0 || typeof row.entity_type !== "string" ||
      !ENTITY_TYPE_SET.has(row.entity_type) || row.entity_status !== "active") invalid();
  const graphCentrality = score(row.entity_graph_centrality);
  const lastSeenAt = parseMillis(row.entity_last_seen_at, true);
  const mergedInto = row.entity_merged_into === null ? undefined : row.entity_merged_into;
  if (mergedInto !== undefined && !safeId(mergedInto)) invalid();
  return Object.freeze({
    id: row.entity_id,
    scope,
    canonicalName: row.entity_canonical_name,
    displayName: row.entity_display_name,
    type: row.entity_type as GraphEntityRecord["type"],
    aliases: Object.freeze([...strings(row.entity_aliases)]) as string[],
    mentionCount: integer(row.entity_mention_count),
    mentionCount30d: integer(row.entity_mention_count_30d),
    distinctSourceCount: integer(row.entity_distinct_source_count),
    ...(lastSeenAt === undefined ? {} : { lastSeenAt }),
    hotness: typeof row.entity_hotness === "number" && Number.isFinite(row.entity_hotness) &&
      row.entity_hotness >= 0 ? row.entity_hotness : invalid(),
    graphCentrality,
    queryHits30d: integer(row.entity_query_hits_30d),
    status: "active",
    ...(mergedInto === undefined ? {} : { mergedInto }),
    createdAt: parseMillis(row.entity_created_at)!,
    updatedAt: parseMillis(row.entity_updated_at)!,
    metadata: Object.freeze(dataRecord(row.entity_metadata)),
  });
}

function decodeEvidenceLink(
  row: Record<(typeof ROW_KEYS)[number], unknown>,
  scope: CanonicalAuthorityScope,
  input: CanonicalEntityTopicReadInput,
): EntityGraphEvidenceLink | undefined {
  if (EVIDENCE_COLUMNS.every((key) => row[key] === null)) return undefined;
  if (!SHA256.test(String(row.entity_evidence_link_id)) ||
      row.entity_evidence_memory_id !== input.evidenceId ||
      !safeId(row.entity_evidence_source_id) ||
      typeof row.entity_evidence_source_kind !== "string" ||
      row.entity_evidence_source_kind.trim().length === 0 || !safeId(row.entity_id)) invalid();
  return Object.freeze({
    id: row.entity_evidence_link_id as string,
    scope,
    targetKind: "entity",
    targetId: row.entity_id,
    evidenceId: input.evidenceId,
    memoryId: input.activeMemoryId,
    sourceId: row.entity_evidence_source_id,
    sourceKind: row.entity_evidence_source_kind,
    createdAt: parseMillis(row.entity_evidence_created_at)!,
  });
}

export class PostgresCanonicalEntityTopicReadPort implements CanonicalEntityTopicReadPort {
  constructor(private readonly client: PostgresCanonicalEntityTopicReadClient) {
    if (!client || typeof client.query !== "function") invalid();
  }

  async read(input: CanonicalEntityTopicReadInput): Promise<CanonicalEntityTopicReadFacts> {
    const raw = dataRecord(input);
    if (Reflect.ownKeys(raw).length !== INPUT_KEYS.length ||
        INPUT_KEYS.some((key) => !Object.hasOwn(raw, key)) || input.graphKind !== "entity" ||
        !safeId(input.activeMemoryId) || !safeId(input.evidenceId) ||
        !(input.signal instanceof AbortSignal)) invalid();
    const receiptEntityIds = ids(input.receiptEntityIds);
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
      input.activeMemoryId, input.evidenceId, receiptEntityIds,
    ]);
    throwIfAborted(input.signal);
    if (!result || !Array.isArray(result.rows) || result.rows.length < 1 ||
        (result.rowCount !== undefined && result.rowCount !== null && result.rowCount !== result.rows.length)) {
      return invalid();
    }
    const rows = result.rows.map(exactRow);
    for (const row of rows) assertRowAuthority(row, scope, input);
    const memory = decodeMemory(rows[0]!, { ...input, receiptEntityIds }, scope);
    const publicAuthority = publicScope(scope);
    const canonicalEntities = rows.flatMap((row) => {
      const entity = decodeEntity(row, publicAuthority);
      return entity ? [entity] : [];
    });
    const entityEvidenceLinks = rows.flatMap((row) => {
      const link = decodeEvidenceLink(row, scope, input);
      return link ? [link] : [];
    });
    const entityIds = canonicalEntities.map((entity) => entity.id);
    if (rows.length !== Math.max(1, receiptEntityIds.length) ||
        JSON.stringify(entityIds.slice().sort()) !== JSON.stringify([...receiptEntityIds].sort()) ||
        new Set(entityIds).size !== entityIds.length ||
        new Set(entityEvidenceLinks.map((link) => link.id)).size !== entityEvidenceLinks.length) invalid();
    return Object.freeze({
      canonicalFactsAuthority: "graph_repository",
      memory,
      canonicalEntities: Object.freeze(canonicalEntities),
      entityEvidenceLinks: Object.freeze(entityEvidenceLinks),
    });
  }
}
