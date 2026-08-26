/**
 * F0 PostgreSQL 多路召回候选 producer。
 *
 * 本模块只返回由持久化结构证明的 authoritative memory/evidence identity，
 * 不返回或信任图、树、全文索引中的正文。最终 lifecycle、risk、scope、evidence
 * 与六因子评分仍由 PostgresGovernedRetrievalHydrator / GovernedRetrievalEngine 复核。
 */

import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import {
  authorityScopeFingerprint,
  canonicalAuthorityScope,
  type CanonicalAuthorityScope,
} from "../domain/authority-scope-fingerprint.js";
import type { MemoryKind, MemoryScope, MemorySemanticType } from "../domain/types.js";
import type {
  GovernedRetrievalCandidate,
  GovernedRetrievalNodeType,
  GovernedRetrievalSource,
} from "./governed-retrieval-engine.js";
import { createGovernedSemanticIdentity } from "./governed-retrieval-engine.js";

export interface PostgresGovernedRetrievalCandidateQueryResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly rows: readonly Row[];
  readonly rowCount?: number | null;
}

/** client 生命周期与事务所有权属于 PostgresProvider。 */
export interface PostgresGovernedRetrievalCandidateQueryClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresGovernedRetrievalCandidateQueryResult<Row>>;
}

export interface PostgresGovernedRetrievalCandidateSearchInput {
  readonly query: string;
  readonly scope: MemoryScope;
  readonly limit: number;
  readonly signal?: AbortSignal;
}

const SAFE_ID = /^[^\s\p{Cc}]{1,256}$/u;
// Context tasks are commonly multi-line. Keep normal text whitespace while rejecting
// NUL, other C0/C1 controls and unpaired surrogate code units.
const UNSAFE_QUERY = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uD800-\uDFFF]/u;
const MAX_QUERY_LENGTH = 10_000;
const MAX_LIMIT = 500;

const ROW_KEYS = [
  "source", "node_type", "source_ref", "authoritative_record_id", "evidence_ids",
  "relevance", "scope_fingerprint", "tenant_id", "user_id", "app_id", "project_id",
  "agent_id", "namespace", "visibility", "workspace_id", "session_id",
  "memory_data_type", "memory_lifecycle_status", "memory_admission_route",
  "memory_context_eligible", "memory_legacy_quarantine_reason", "memory_kind",
  "memory_semantic_type", "memory_content_hash",
] as const;

const MEMORY_KINDS = new Set<MemoryKind>([
  "preference", "decision", "entity", "fact", "task", "plan", "goal",
  "document", "knowledge", "observation", "other",
]);
const SEMANTIC_TYPES = new Set<MemorySemanticType>([
  "profile", "task_context", "rules", "experience", "resource",
]);
const CONTENT_HASH = /^[a-f0-9]{32}$/;

const MEMORY_SESSION_SQL = `COALESCE(
  memory.metadata->>'sessionId',
  memory.metadata #>> '{governance,provenance,sessionId}',
  ''
)`;

const GRAPH_SCOPE_SQL = (alias: string): string => `${alias}.scope_fingerprint = $1
  AND ${alias}.tenant_id = $2 AND ${alias}.user_id = $3 AND ${alias}.app_id = $4
  AND ${alias}.project_id = $5 AND ${alias}.agent_id = $6 AND ${alias}.namespace = $7
  AND ${alias}.visibility = $8 AND ${alias}.workspace_id = $9
  AND ${alias}.session_id = $10`;

/**
 * PostgreSQL computes Okapi BM25 over the authoritative scope snapshot. The
 * monotonically normalized result contributes relevance only; Mengshu's
 * six-factor breakdown remains the final score.
 */
const SEARCH_SQL = `WITH lexical_query AS MATERIALIZED (
  SELECT websearch_to_tsquery('simple', $11) AS terms
), query_terms AS MATERIALIZED (
  SELECT DISTINCT term.lexeme
  FROM unnest(to_tsvector('simple', $11)) AS term(lexeme, positions, weights)
), authoritative_memory AS MATERIALIZED (
  SELECT memory.id::text AS id,
    memory.text,
    memory.tenant_id,
    memory.user_id,
    memory.product_id AS app_id,
    memory.canonical_project_id AS project_id,
    memory.producer_id AS agent_id,
    memory.namespace,
    memory.visibility,
    COALESCE(memory.workspace_id, '') AS workspace_id,
    ${MEMORY_SESSION_SQL} AS session_id,
    memory.data_type,
    memory.lifecycle_status,
    memory.metadata->>'admissionRoute' AS admission_route,
    memory.metadata->>'contextEligible' AS context_eligible,
    memory.metadata #>> '{governance,native,kind}' AS memory_kind,
    memory.metadata->>'semanticType' AS semantic_type,
    memory.content_hash,
    memory.legacy_quarantine_reason,
    memory.metadata #> '{governance,evidenceIds}' AS direct_evidence_ids
  FROM memories AS memory
  WHERE memory.tenant_id = $2
    AND memory.user_id = $3
    AND memory.product_id = $4
    AND memory.canonical_project_id = $5
    AND memory.producer_id = $6
    AND memory.namespace = $7
    AND memory.visibility = $8
    AND COALESCE(memory.workspace_id, '') = $9
    AND ${MEMORY_SESSION_SQL} = $10
    AND memory.data_type = 'memory'
    AND memory.lifecycle_status IN ('active', 'archived')
    AND memory.metadata->>'admissionRoute' IN ('active', 'lookup_only')
    AND (
      (memory.lifecycle_status = 'active'
        AND memory.metadata->>'admissionRoute' = 'active'
        AND memory.metadata->>'contextEligible' = 'true')
      OR
      (memory.lifecycle_status = 'archived'
        AND memory.metadata->>'admissionRoute' = 'lookup_only'
        AND memory.metadata->>'contextEligible' = 'false')
    )
    AND memory.legacy_quarantine_reason IS NULL
    AND jsonb_typeof(memory.metadata->'sourceNodeIds') = 'array'
    AND jsonb_typeof(memory.metadata #> '{governance,evidenceIds}') = 'array'
    AND jsonb_typeof(memory.metadata #> '{governance,candidate,evidence,eventIds}') = 'array'
    AND jsonb_array_length(memory.metadata #> '{governance,evidenceIds}') > 0
    AND memory.metadata->'sourceNodeIds' = memory.metadata #> '{governance,evidenceIds}'
    AND memory.metadata #> '{governance,evidenceIds}' =
      memory.metadata #> '{governance,candidate,evidence,eventIds}'
    AND (
      memory.metadata->>'sessionId' IS NULL
      OR memory.metadata #>> '{governance,provenance,sessionId}' IS NULL
      OR memory.metadata->>'sessionId' =
        memory.metadata #>> '{governance,provenance,sessionId}'
    )
), memory_terms AS MATERIALIZED (
  SELECT memory.id,
    term.lexeme,
    cardinality(term.positions)::double precision AS term_frequency
  FROM authoritative_memory AS memory
  CROSS JOIN LATERAL unnest(to_tsvector('simple', memory.text))
    AS term(lexeme, positions, weights)
), memory_lengths AS MATERIALIZED (
  SELECT memory.id,
    COALESCE(SUM(term.term_frequency), 0.0)::double precision AS document_length
  FROM authoritative_memory AS memory
  LEFT JOIN memory_terms AS term ON term.id = memory.id
  GROUP BY memory.id
), document_frequency AS MATERIALIZED (
  SELECT term.lexeme, COUNT(DISTINCT term.id)::double precision AS document_frequency
  FROM memory_terms AS term
  JOIN query_terms AS query_term ON query_term.lexeme = term.lexeme
  GROUP BY term.lexeme
), corpus_stats AS MATERIALIZED (
  SELECT COUNT(*)::double precision AS document_count,
    GREATEST(1.0, COALESCE(AVG(document_length), 0.0))::double precision
      AS average_document_length
  FROM memory_lengths
), bm25_scores AS MATERIALIZED (
  SELECT term.id,
    SUM(
      LN(1.0 + (
        (corpus.document_count - frequency.document_frequency + 0.5) /
        (frequency.document_frequency + 0.5)
      )) * (
        term.term_frequency * (1.2::double precision + 1.0) /
        (
          term.term_frequency + 1.2::double precision * (
            1.0 - 0.75::double precision + 0.75::double precision *
            length.document_length / corpus.average_document_length
          )
        )
      )
    )::double precision AS raw_bm25
  FROM memory_terms AS term
  JOIN query_terms AS query_term ON query_term.lexeme = term.lexeme
  JOIN document_frequency AS frequency ON frequency.lexeme = term.lexeme
  JOIN memory_lengths AS length ON length.id = term.id
  CROSS JOIN corpus_stats AS corpus
  GROUP BY term.id
), bm25_hits AS (
  SELECT 'bm25'::text AS source,
    'memory'::text AS node_type,
    memory.id AS source_ref,
    memory.id AS authoritative_record_id,
    memory.direct_evidence_ids AS evidence_ids,
    LEAST(1.0, GREATEST(0.0,
      1.0 - EXP(-score.raw_bm25)
    )) AS relevance,
    memory.*
  FROM authoritative_memory AS memory
  JOIN bm25_scores AS score ON score.id = memory.id
), entity_graph_anchors AS (
  SELECT entity.id AS source_ref,
    entity_evidence.evidence_memory_id AS evidence_id,
    LEAST(1.0, GREATEST(0.0,
      ts_rank_cd(
        to_tsvector('simple', concat_ws(' ', entity.canonical_name, entity.display_name)),
        lexical.terms
      )::double precision
    )) AS relevance
  FROM mengshu_graph_entities AS entity
  JOIN mengshu_graph_entity_evidence AS entity_evidence
    ON entity_evidence.scope_fingerprint = entity.scope_fingerprint
    AND entity_evidence.entity_id = entity.id
    AND ${GRAPH_SCOPE_SQL("entity_evidence")}
  CROSS JOIN lexical_query AS lexical
  WHERE ${GRAPH_SCOPE_SQL("entity")}
    AND entity.status = 'active'
    AND (
      to_tsvector('simple', concat_ws(' ', entity.canonical_name, entity.display_name)) @@
        lexical.terms
      OR EXISTS (
        SELECT 1 FROM mengshu_graph_entity_aliases AS entity_alias
        WHERE ${GRAPH_SCOPE_SQL("entity_alias")}
          AND entity_alias.entity_id = entity.id
          AND to_tsvector('simple', entity_alias.alias) @@ lexical.terms
      )
    )
  UNION ALL
  SELECT relation.id AS source_ref,
    relation_evidence.evidence_memory_id AS evidence_id,
    LEAST(1.0, GREATEST(0.0,
      ts_rank_cd(to_tsvector('simple', concat_ws(' ',
        subject.display_name, relation.predicate, object.display_name
      )), lexical.terms)::double precision
    )) AS relevance
  FROM mengshu_graph_relations AS relation
  JOIN mengshu_graph_entities AS subject
    ON subject.scope_fingerprint = relation.scope_fingerprint
    AND subject.id = relation.subject_id
    AND ${GRAPH_SCOPE_SQL("subject")}
  JOIN mengshu_graph_entities AS object
    ON object.scope_fingerprint = relation.scope_fingerprint
    AND object.id = relation.object_id
    AND ${GRAPH_SCOPE_SQL("object")}
  JOIN mengshu_graph_relation_evidence AS relation_evidence
    ON relation_evidence.scope_fingerprint = relation.scope_fingerprint
    AND relation_evidence.relation_id = relation.id
    AND ${GRAPH_SCOPE_SQL("relation_evidence")}
  CROSS JOIN lexical_query AS lexical
  WHERE ${GRAPH_SCOPE_SQL("relation")}
    AND relation.status IN ('active', 'weak')
    AND to_tsvector('simple', concat_ws(' ',
      subject.display_name, relation.predicate, object.display_name
    )) @@ lexical.terms
), entity_graph_hits AS (
  SELECT 'entity_graph'::text AS source,
    'entity_graph'::text AS node_type,
    anchor.source_ref,
    memory_link.target_memory_id AS authoritative_record_id,
    jsonb_agg(DISTINCT anchor.evidence_id ORDER BY anchor.evidence_id) AS evidence_ids,
    max(anchor.relevance) AS relevance,
    memory.*
  FROM entity_graph_anchors AS anchor
  JOIN mengshu_memory_evidence_links AS memory_link
    ON memory_link.evidence_memory_id = anchor.evidence_id
    AND memory_link.link_kind = 'grounded_by'
    AND memory_link.source = 'entity_graph'
    AND ${GRAPH_SCOPE_SQL("memory_link")}
  JOIN authoritative_memory AS memory
    ON memory.id = memory_link.target_memory_id
    AND memory.lifecycle_status = 'active'
    AND memory.admission_route = 'active'
    AND memory.context_eligible = 'true'
    AND memory.direct_evidence_ids ? anchor.evidence_id
  GROUP BY anchor.source_ref, memory_link.target_memory_id,
    memory.id, memory.text, memory.tenant_id, memory.user_id, memory.app_id,
    memory.project_id, memory.agent_id, memory.namespace, memory.visibility,
    memory.workspace_id, memory.session_id, memory.data_type, memory.lifecycle_status,
    memory.admission_route, memory.context_eligible, memory.legacy_quarantine_reason,
    memory.direct_evidence_ids, memory.memory_kind, memory.semantic_type, memory.content_hash
), work_memory_graph_hits AS (
  SELECT 'work_memory_graph'::text AS source,
    'work_memory_graph'::text AS node_type,
    work_node.id AS source_ref,
    work_node.record_id AS authoritative_record_id,
    work_node.evidence_chunk_ids AS evidence_ids,
    LEAST(1.0, GREATEST(0.0,
      ts_rank_cd(to_tsvector('simple', work_node.label), lexical.terms)::double precision
    )) AS relevance,
    memory.*
  FROM mengshu_work_memory_nodes AS work_node
  JOIN authoritative_memory AS memory
    ON memory.id = work_node.record_id
    AND memory.lifecycle_status = 'active'
    AND memory.admission_route = 'active'
    AND memory.context_eligible = 'true'
    AND work_node.evidence_chunk_ids = memory.direct_evidence_ids
  CROSS JOIN lexical_query AS lexical
  WHERE ${GRAPH_SCOPE_SQL("work_node")}
    AND work_node.node_type = 'memory'
    AND work_node.lifecycle_status = 'active'
    AND jsonb_typeof(work_node.evidence_chunk_ids) = 'array'
    AND jsonb_array_length(work_node.evidence_chunk_ids) > 0
    AND to_tsvector('simple', work_node.label) @@ lexical.terms
), tree_hits AS (
  SELECT 'tree'::text AS source,
    'tree'::text AS node_type,
    tree_leaf.id AS source_ref,
    memory.id AS authoritative_record_id,
    jsonb_build_array(tree_leaf.chunk_id) AS evidence_ids,
    LEAST(1.0, GREATEST(0.0,
      ts_rank_cd(to_tsvector('simple', tree_leaf.text), lexical.terms)::double precision
    )) AS relevance,
    memory.*
  FROM mengshu_tree_leaves AS tree_leaf
  JOIN authoritative_memory AS memory
    ON tree_leaf.id::text = memory.id::text
    AND memory.lifecycle_status = 'active'
    AND memory.admission_route = 'active'
    AND memory.context_eligible = 'true'
    AND memory.direct_evidence_ids ? tree_leaf.chunk_id
  CROSS JOIN lexical_query AS lexical
  WHERE ${GRAPH_SCOPE_SQL("tree_leaf")}
    AND to_tsvector('simple', tree_leaf.text) @@ lexical.terms
), combined AS (
  SELECT * FROM bm25_hits
  UNION ALL SELECT * FROM entity_graph_hits
  UNION ALL SELECT * FROM work_memory_graph_hits
  UNION ALL SELECT * FROM tree_hits
)
SELECT source,
  node_type,
  source_ref,
  authoritative_record_id,
  evidence_ids,
  relevance,
  $1::text AS scope_fingerprint,
  tenant_id,
  user_id,
  app_id,
  project_id,
  agent_id,
  namespace,
  visibility,
  workspace_id,
  session_id,
  data_type AS memory_data_type,
  lifecycle_status AS memory_lifecycle_status,
  admission_route AS memory_admission_route,
  context_eligible AS memory_context_eligible,
  legacy_quarantine_reason AS memory_legacy_quarantine_reason,
  memory_kind,
  semantic_type AS memory_semantic_type,
  content_hash AS memory_content_hash
FROM combined
ORDER BY relevance DESC, source, authoritative_record_id, source_ref
LIMIT $12`;

type CandidateRow = Record<(typeof ROW_KEYS)[number], unknown>;

export class PostgresGovernedRetrievalCandidateSourceError extends Error {
  readonly code = "POSTGRES_GOVERNED_RETRIEVAL_CANDIDATE_INVALID" as const;

  constructor(readonly reason = "UNSPECIFIED") {
    super("Postgres governed retrieval candidate query is invalid or incomplete");
    this.name = "PostgresGovernedRetrievalCandidateSourceError";
  }
}

function invalid(reason = "UNSPECIFIED"): never {
  throw new PostgresGovernedRetrievalCandidateSourceError(reason);
}

function diagnose<T>(reason: string, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof PostgresGovernedRetrievalCandidateSourceError &&
        error.reason === "UNSPECIFIED") {
      return invalid(reason);
    }
    throw error;
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error && signal.reason.name === "AbortError"
    ? signal.reason
    : new DOMException("Governed retrieval candidate query aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
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

function exactRow(value: unknown): CandidateRow {
  const record = dataRecord(value);
  const keys = Reflect.ownKeys(record);
  if (keys.length !== ROW_KEYS.length || ROW_KEYS.some((key) => !keys.includes(key)) ||
      keys.some((key) => typeof key !== "string" ||
        !ROW_KEYS.includes(key as (typeof ROW_KEYS)[number]))) invalid();
  return record as CandidateRow;
}

function evidenceIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) || value.length === 0 ||
      value.length > 10_000 || value.some((item) => !safeId(item)) ||
      new Set(value).size !== value.length) invalid();
  return Object.freeze([...value]) as readonly string[];
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

function sameScopeRow(row: CandidateRow, scope: CanonicalAuthorityScope, fingerprint: string): void {
  const actual = [
    row.scope_fingerprint, row.tenant_id, row.user_id, row.app_id, row.project_id,
    row.agent_id, row.namespace, row.visibility, row.workspace_id, row.session_id,
  ];
  const expected = [
    fingerprint, scope.tenantId, scope.userId, scope.appId, scope.projectId,
    scope.agentId, scope.namespace, scope.visibility, scope.workspaceId, scope.sessionId,
  ];
  if (actual.some((value, index) => value !== expected[index])) invalid();
}

function sourceAndNodeType(row: CandidateRow): {
  source: GovernedRetrievalSource;
  nodeType: GovernedRetrievalNodeType;
} {
  const pairs = new Map<GovernedRetrievalSource, GovernedRetrievalNodeType>([
    ["bm25", "memory"],
    ["entity_graph", "entity_graph"],
    ["work_memory_graph", "work_memory_graph"],
    ["tree", "tree"],
  ]);
  if (typeof row.source !== "string" || !pairs.has(row.source as GovernedRetrievalSource) ||
      row.node_type !== pairs.get(row.source as GovernedRetrievalSource)) invalid();
  return {
    source: row.source as GovernedRetrievalSource,
    nodeType: row.node_type as GovernedRetrievalNodeType,
  };
}

function assertMemoryEligibility(row: CandidateRow, source: GovernedRetrievalSource): void {
  if (row.memory_data_type !== "memory" || row.memory_legacy_quarantine_reason !== null) invalid();
  const active = row.memory_lifecycle_status === "active" &&
    row.memory_admission_route === "active" && row.memory_context_eligible === "true";
  const lookupOnly = row.memory_lifecycle_status === "archived" &&
    row.memory_admission_route === "lookup_only" && row.memory_context_eligible === "false";
  if (source === "bm25" ? !active && !lookupOnly : !active) invalid();
}

function governedIdentity(row: CandidateRow): string {
  if (typeof row.memory_kind !== "string" ||
      !MEMORY_KINDS.has(row.memory_kind as MemoryKind) ||
      (row.memory_semantic_type !== null &&
        (typeof row.memory_semantic_type !== "string" ||
          !SEMANTIC_TYPES.has(row.memory_semantic_type as MemorySemanticType))) ||
      typeof row.memory_content_hash !== "string" ||
      !CONTENT_HASH.test(row.memory_content_hash)) {
    return invalid();
  }
  return createGovernedSemanticIdentity({
    kind: row.memory_kind as MemoryKind,
    ...(row.memory_semantic_type === null
      ? {}
      : { semanticType: row.memory_semantic_type as MemorySemanticType }),
    contentHash: row.memory_content_hash,
  });
}

function candidateId(
  fingerprint: string,
  source: GovernedRetrievalSource,
  sourceRef: string,
  recordId: string,
  evidence: readonly string[],
): string {
  return createHash("sha256").update(JSON.stringify([
    "mengshu.governed-retrieval-candidate/v1",
    fingerprint,
    source,
    sourceRef,
    recordId,
    evidence,
  ])).digest("hex");
}

function decodeCandidate(
  value: unknown,
  scope: CanonicalAuthorityScope,
  publicMemoryScope: MemoryScope,
  fingerprint: string,
): GovernedRetrievalCandidate {
  const row = diagnose("ROW_SHAPE_INVALID", () => exactRow(value));
  diagnose("ROW_SCOPE_MISMATCH", () => sameScopeRow(row, scope, fingerprint));
  const { source, nodeType } = diagnose(
    "SOURCE_NODE_TYPE_INVALID",
    () => sourceAndNodeType(row),
  );
  const sourceRef = safeId(row.source_ref) ? row.source_ref : invalid("SOURCE_REF_INVALID");
  const recordId = safeId(row.authoritative_record_id)
    ? row.authoritative_record_id
    : invalid("AUTHORITATIVE_RECORD_ID_INVALID");
  const evidence = diagnose("EVIDENCE_IDS_INVALID", () => evidenceIds(row.evidence_ids));
  if (typeof row.relevance !== "number" || !Number.isFinite(row.relevance) ||
      row.relevance < 0 || row.relevance > 1) invalid("RELEVANCE_INVALID");
  if ((source === "bm25" || source === "tree") && sourceRef !== recordId) {
    invalid("SOURCE_RECORD_IDENTITY_MISMATCH");
  }
  diagnose("MEMORY_ELIGIBILITY_INVALID", () => assertMemoryEligibility(row, source));
  const admissionRoute = row.memory_admission_route === "active"
    ? "active" as const
    : row.memory_admission_route === "lookup_only"
      ? "lookup_only" as const
      : invalid("ADMISSION_ROUTE_INVALID");
  const navigation = source === "bm25"
    ? undefined
    : Object.freeze({ kind: nodeType, ref: sourceRef });
  return Object.freeze({
    candidateId: candidateId(fingerprint, source, sourceRef, recordId, evidence),
    authoritativeRecordId: recordId,
    scope: publicMemoryScope,
    source,
    nodeType,
    relevance: row.relevance,
    rawScore: row.relevance,
    evidenceIds: evidence,
    governedSemanticIdentity: diagnose(
      "GOVERNED_SEMANTIC_IDENTITY_INVALID",
      () => governedIdentity(row),
    ),
    admissionRoute,
    ...(navigation === undefined ? {} : { navigation }),
  });
}

function validateInput(input: PostgresGovernedRetrievalCandidateSearchInput): {
  query: string;
  scope: CanonicalAuthorityScope;
} {
  const record = dataRecord(input);
  const keys = Reflect.ownKeys(record);
  const allowed = new Set(["query", "scope", "limit", "signal"]);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
      !keys.includes("query") || !keys.includes("scope") || !keys.includes("limit") ||
      typeof input.query !== "string") invalid();
  const query = input.query.trim();
  if (query.length === 0 || query.length > MAX_QUERY_LENGTH || UNSAFE_QUERY.test(query) ||
      !Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_LIMIT ||
      (input.signal !== undefined && !(input.signal instanceof AbortSignal))) invalid();
  try {
    return { query, scope: canonicalAuthorityScope(input.scope) };
  } catch {
    return invalid();
  }
}

function validateResult(
  value: unknown,
  limit: number,
): PostgresGovernedRetrievalCandidateQueryResult {
  const record = dataRecord(value);
  const keys = Reflect.ownKeys(record);
  if (!keys.includes("rows") || keys.some((key) =>
    typeof key !== "string" || (key !== "rows" && key !== "rowCount"))) invalid();
  const result = record as unknown as PostgresGovernedRetrievalCandidateQueryResult;
  if (!Array.isArray(result.rows) || nodeUtilTypes.isProxy(result.rows) ||
      Reflect.ownKeys(result.rows).length !== result.rows.length + 1 ||
      result.rows.length > limit ||
      (result.rowCount !== undefined && result.rowCount !== null &&
        (!Number.isSafeInteger(result.rowCount) || result.rowCount !== result.rows.length))) invalid();
  return result;
}

export class PostgresGovernedRetrievalCandidateSource {
  constructor(private readonly client: PostgresGovernedRetrievalCandidateQueryClient) {
    if (!client || typeof client.query !== "function") {
      throw new TypeError("Postgres governed retrieval candidate query client is required");
    }
  }

  async search(
    input: PostgresGovernedRetrievalCandidateSearchInput,
  ): Promise<GovernedRetrievalCandidate[]> {
    const validated = diagnose("INPUT_INVALID", () => validateInput(input));
    throwIfAborted(input.signal);
    const fingerprint = authorityScopeFingerprint(input.scope);
    const scope = publicScope(validated.scope);
    let raw: unknown;
    try {
      raw = await this.client.query(SEARCH_SQL, [
        fingerprint,
        validated.scope.tenantId,
        validated.scope.userId,
        validated.scope.appId,
        validated.scope.projectId,
        validated.scope.agentId,
        validated.scope.namespace,
        validated.scope.visibility,
        validated.scope.workspaceId,
        validated.scope.sessionId,
        validated.query,
        input.limit,
      ]);
    } catch (error) {
      throwIfAborted(input.signal);
      if (error instanceof Error && error.name === "AbortError") throw error;
      return invalid("QUERY_FAILED");
    }
    throwIfAborted(input.signal);
    const result = diagnose("QUERY_RESULT_INVALID", () => validateResult(raw, input.limit));
    const candidates = result.rows.map((row) =>
      decodeCandidate(row, validated.scope, scope, fingerprint));
    const identities = new Set<string>();
    for (const candidate of candidates) {
      if (identities.has(candidate.candidateId)) invalid("DUPLICATE_CANDIDATE_ID");
      identities.add(candidate.candidateId);
    }
    return Object.freeze(candidates) as unknown as GovernedRetrievalCandidate[];
  }
}
