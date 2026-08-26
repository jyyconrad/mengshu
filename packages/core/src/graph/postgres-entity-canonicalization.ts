import { createHash } from "node:crypto";

import type { KnownEmbeddingSpaceState } from "../domain/embedding-space.js";
import { decideEntitySemanticMatch, TOOL_ALIASES, canonicalize } from "./entity-resolver.js";
import {
  deriveAuthoritativeEntityGraph,
  type AuthoritativeEntityGraphDerivation,
  type EntityGraphEvidenceLink,
} from "./authoritative-entity-graph-derivation.js";
import type { EntityType } from "./schema.js";
import { PostgresGraphRepository } from "./postgres-repository.js";
import type { GraphEntityRecord, GraphRelationRecord } from "./types.js";

export interface PostgresEntityCanonicalizationQueryResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly rows: readonly Row[];
  readonly rowCount?: number | null;
}

/** Caller-owned transaction client. This module never controls the transaction. */
export interface PostgresEntityCanonicalizationClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresEntityCanonicalizationQueryResult<Row>>;
}

export interface EntityGraphEmbeddingBatch {
  readonly authority: "runtime_active_embedding_space";
  readonly embeddingSpaceId: string;
  readonly embeddingSpaceState: KnownEmbeddingSpaceState;
  readonly vectors: readonly Readonly<{
    rawEntityId: string;
    vector: readonly number[];
  }>[];
}

export interface EntityCanonicalResolution {
  readonly resolutionId: string;
  readonly jobId: string;
  readonly evidenceId: string;
  readonly rawEntityId: string;
  readonly canonicalEntityId: string;
  readonly type: EntityType;
  readonly method: "exact" | "alias" | "semantic" | "create";
  readonly similarity?: number;
  readonly canRollback: boolean;
  readonly rawEntity: Readonly<GraphEntityRecord>;
  readonly observedAliases: readonly string[];
  readonly createdAt: number;
}

export interface RelationCanonicalResolution {
  readonly resolutionId: string;
  readonly jobId: string;
  readonly evidenceId: string;
  readonly rawRelationId: string;
  readonly canonicalRelationId?: string;
  readonly canonicalSubjectId: string;
  readonly canonicalObjectId: string;
  readonly outcome: "canonicalized" | "dropped_self";
  readonly rawRelation: Readonly<GraphRelationRecord>;
  readonly createdAt: number;
}

export interface EntityCanonicalAliasBinding {
  readonly bindingId: string;
  readonly entityId: string;
  readonly type: EntityType;
  readonly alias: string;
  readonly normalizedAlias: string;
  readonly createdAt: number;
}

export interface CanonicalEntityEmbedding {
  readonly entityId: string;
  readonly type: EntityType;
  readonly embeddingSpaceId: string;
  readonly embeddingSpaceState: KnownEmbeddingSpaceState;
  readonly vector: readonly number[];
  readonly updatedAt: number;
}

export interface EntityCanonicalizationPlan {
  readonly jobId: string;
  readonly graph: AuthoritativeEntityGraphDerivation;
  readonly entityResolutions: readonly EntityCanonicalResolution[];
  readonly relationResolutions: readonly RelationCanonicalResolution[];
  readonly aliasBindings: readonly EntityCanonicalAliasBinding[];
  readonly embeddings: readonly CanonicalEntityEmbedding[];
  readonly relatedRelations: readonly Readonly<GraphRelationRecord>[];
  readonly relatedRelationEvidenceLinks: readonly EntityGraphEvidenceLink[];
}

export interface EntityCanonicalizationPersistResult {
  readonly createdRelations: number;
  readonly relationIds: readonly string[];
  readonly relationEvidenceLinks: number;
}

export interface CanonicalizeAuthoritativeEntityGraphInput {
  readonly jobId: string;
  readonly graph: AuthoritativeEntityGraphDerivation;
  readonly embeddings: EntityGraphEmbeddingBatch;
}

interface PersistedEntityIdentity {
  readonly id: string;
  readonly canonicalName: string;
  readonly displayName: string;
  readonly type: EntityType;
}

const EMBEDDING_SPACE_ID = /^embedding-space:v1:[0-9a-f]{64}$/;
const SAFE_ID = /^[^\s\p{Cc}]{1,256}$/u;
const ENTITY_TYPES = new Set<EntityType>([
  "person", "organization", "project", "repo", "file", "topic", "tool", "task",
  "concept", "user", "agent", "chunk", "document", "other",
]);
const NO_SEMANTIC_TYPES = new Set<EntityType>(["person", "file", "chunk", "document"]);

const ACTIVE_EMBEDDING_SPACE_SQL = `SELECT
  s.embedding_space_id, s.dimensions, s.state, s.queryability_state
FROM mengshu_active_embedding_space AS active
JOIN mengshu_embedding_spaces AS s
  ON s.embedding_space_id = active.embedding_space_id
WHERE active.singleton_key = 'active'
FOR SHARE OF active, s`;
const LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtextextended($1, 0)) AS locked`;
const EXACT_SQL = `SELECT id, canonical_name, display_name, entity_type, status
FROM mengshu_graph_entities
WHERE scope_fingerprint = $1
  AND tenant_id = $2 AND user_id = $3 AND app_id = $4 AND project_id = $5
  AND agent_id = $6 AND namespace = $7 AND visibility = $8
  AND workspace_id = $9 AND session_id = $10
  AND entity_type = $11 AND canonical_name = $12 AND status = 'active'
ORDER BY id LIMIT 2`;
const ALIAS_SQL = `SELECT entity.id, entity.canonical_name, entity.display_name,
  entity.entity_type, entity.status
FROM mengshu_graph_entity_alias_bindings AS binding
JOIN mengshu_graph_entities AS entity
  ON entity.scope_fingerprint = binding.scope_fingerprint
 AND entity.id = binding.canonical_entity_id
WHERE binding.scope_fingerprint = $1
  AND binding.tenant_id = $2 AND binding.user_id = $3 AND binding.app_id = $4
  AND binding.project_id = $5 AND binding.agent_id = $6 AND binding.namespace = $7
  AND binding.visibility = $8 AND binding.workspace_id = $9 AND binding.session_id = $10
  AND binding.entity_type = $11 AND binding.normalized_alias = $12
  AND binding.status = 'active' AND entity.status = 'active'
ORDER BY entity.id LIMIT 2`;
const SEMANTIC_SQL = `SELECT entity.id, entity.canonical_name, entity.display_name,
  entity.entity_type, entity.status,
  1 - (embedding.vector <=> $14::vector) AS similarity
FROM mengshu_graph_entity_embeddings AS embedding
JOIN mengshu_graph_entities AS entity
  ON entity.scope_fingerprint = embedding.scope_fingerprint
 AND entity.id = embedding.entity_id
WHERE embedding.scope_fingerprint = $1
  AND embedding.tenant_id = $2 AND embedding.user_id = $3 AND embedding.app_id = $4
  AND embedding.project_id = $5 AND embedding.agent_id = $6 AND embedding.namespace = $7
  AND embedding.visibility = $8 AND embedding.workspace_id = $9 AND embedding.session_id = $10
  AND embedding.entity_type = $11 AND embedding.embedding_space_id = $12
  AND embedding.embedding_space_state = $13 AND entity.status = 'active'
ORDER BY embedding.vector <=> $14::vector, entity.id
LIMIT 1`;

const ALIAS_BINDING_UPSERT_SQL = `INSERT INTO mengshu_graph_entity_alias_bindings (
  alias_binding_id, scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id,
  namespace, visibility, workspace_id, session_id, entity_type, normalized_alias,
  canonical_entity_id, status, created_at, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'active', $15, $15)
ON CONFLICT (scope_fingerprint, entity_type, normalized_alias)
WHERE status = 'active'
DO UPDATE SET
  status = 'active', updated_at = GREATEST(mengshu_graph_entity_alias_bindings.updated_at, EXCLUDED.updated_at)
WHERE mengshu_graph_entity_alias_bindings.canonical_entity_id = EXCLUDED.canonical_entity_id
RETURNING canonical_entity_id`;
const ENTITY_RESOLUTION_INSERT_SQL = `INSERT INTO mengshu_graph_entity_resolution_ledger (
  resolution_id, scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id,
  namespace, visibility, workspace_id, session_id, job_id, evidence_memory_id,
  raw_entity_id, canonical_entity_id, entity_type, method, similarity, can_rollback,
  raw_entity, observed_aliases, status, created_at, rolled_back_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
  $16, $17, $18, $19, $20::jsonb, $21::jsonb, 'applied', $22, NULL)
ON CONFLICT (scope_fingerprint, job_id, evidence_memory_id, raw_entity_id)
DO NOTHING RETURNING canonical_entity_id`;
const RELATION_RESOLUTION_INSERT_SQL = `INSERT INTO mengshu_graph_relation_resolution_ledger (
  resolution_id, scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id,
  namespace, visibility, workspace_id, session_id, job_id, evidence_memory_id,
  raw_relation_id, canonical_relation_id, canonical_subject_id, canonical_object_id,
  outcome, raw_relation, created_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
  $16, $17, $18, $19::jsonb, $20)
ON CONFLICT (scope_fingerprint, job_id, evidence_memory_id, raw_relation_id)
DO NOTHING RETURNING canonical_relation_id`;
const EMBEDDING_UPSERT_SQL = `INSERT INTO mengshu_graph_entity_embeddings (
  scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id, namespace,
  visibility, workspace_id, session_id, entity_id, entity_type, embedding_space_id,
  embedding_space_state, vector, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::vector, $16)
ON CONFLICT (scope_fingerprint, entity_id, embedding_space_id)
DO UPDATE SET vector = EXCLUDED.vector, embedding_space_state = EXCLUDED.embedding_space_state,
  entity_type = EXCLUDED.entity_type, updated_at = GREATEST(mengshu_graph_entity_embeddings.updated_at, EXCLUDED.updated_at)
RETURNING entity_id`;
const RELATED_RELATION_EVIDENCE_INSERT_SQL = `INSERT INTO mengshu_graph_relation_evidence (
  link_id, scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id,
  namespace, visibility, workspace_id, session_id, relation_id, evidence_memory_id,
  source_id, source_kind, created_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
ON CONFLICT (scope_fingerprint, relation_id, evidence_memory_id, source_id, source_kind)
DO NOTHING RETURNING link_id`;

function hash(kind: string, values: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify([kind, ...values])).digest("hex");
}

function relationId(
  scopeFingerprint: string,
  relation: Readonly<GraphRelationRecord>,
  subjectId: string,
  objectId: string,
): string {
  return `rel_${createHash("sha256")
    .update([scopeFingerprint, subjectId, relation.predicate, objectId].join(":"))
    .digest("hex").slice(0, 24)}`;
}

function scopeParams(graph: AuthoritativeEntityGraphDerivation): readonly string[] {
  const scope = graph.scope;
  return [
    graph.scopeFingerprint, scope.tenantId, scope.userId, scope.appId, scope.projectId,
    scope.agentId, scope.namespace, scope.visibility, scope.workspaceId ?? "",
    scope.sessionId ?? "",
  ];
}

function vectorParam(vector: readonly number[]): string {
  if (vector.length === 0 || vector.some((value) => !Number.isFinite(value)) ||
      vector.every((value) => value === 0)) {
    throw new Error("Postgres entity canonicalization embedding is invalid");
  }
  return `[${vector.join(",")}]`;
}

function rows<Row extends Record<string, unknown>>(
  result: PostgresEntityCanonicalizationQueryResult<Row>,
  max: number,
): readonly Row[] {
  if (!result || !Array.isArray(result.rows) ||
      (result.rowCount !== undefined && result.rowCount !== null &&
       result.rowCount !== result.rows.length) || result.rows.length > max) {
    throw new Error("Postgres entity canonicalization query result is invalid");
  }
  return result.rows;
}

function decodeIdentity(raw: Record<string, unknown> | undefined, expectedType: EntityType) {
  if (raw === undefined) return undefined;
  if (typeof raw.id !== "string" || !SAFE_ID.test(raw.id) ||
      typeof raw.canonical_name !== "string" || raw.canonical_name.trim().length === 0 ||
      typeof raw.display_name !== "string" || raw.display_name.trim().length === 0 ||
      raw.entity_type !== expectedType || raw.status !== "active") {
    throw new Error("Postgres entity canonicalization identity is invalid");
  }
  return Object.freeze({
    id: raw.id,
    canonicalName: raw.canonical_name,
    displayName: raw.display_name,
    type: expectedType,
  }) satisfies PersistedEntityIdentity;
}

function toolAliasCanonical(entity: Readonly<GraphEntityRecord>): string | undefined {
  if (entity.type !== "tool") return undefined;
  const name = canonicalize(entity.canonicalName);
  for (const [canonicalName, aliases] of Object.entries(TOOL_ALIASES)) {
    if (aliases.some((alias) => canonicalize(alias) === name)) return canonicalName;
  }
  return undefined;
}

function mergeEntity(
  raw: Readonly<GraphEntityRecord>,
  identity: PersistedEntityIdentity,
): Readonly<GraphEntityRecord> {
  return Object.freeze({
    ...raw,
    id: identity.id,
    canonicalName: identity.canonicalName,
    displayName: identity.displayName,
    type: identity.type,
    aliases: Object.freeze(Array.from(new Set([
      identity.displayName, identity.canonicalName, raw.displayName, raw.canonicalName, ...raw.aliases,
    ]))) as string[],
    status: "active" as const,
  });
}

function persistedIdentity(entity: Readonly<GraphEntityRecord>): PersistedEntityIdentity {
  return Object.freeze({
    id: entity.id,
    canonicalName: entity.canonicalName,
    displayName: entity.displayName,
    type: entity.type,
  });
}

function combineEntity(
  current: Readonly<GraphEntityRecord>,
  incoming: Readonly<GraphEntityRecord>,
): Readonly<GraphEntityRecord> {
  return Object.freeze({
    ...current,
    aliases: Object.freeze(Array.from(new Set([...current.aliases, ...incoming.aliases]))) as string[],
    mentionCount: current.mentionCount + incoming.mentionCount,
    mentionCount30d: current.mentionCount30d + incoming.mentionCount30d,
    distinctSourceCount: Math.max(current.distinctSourceCount, incoming.distinctSourceCount),
    lastSeenAt: Math.max(current.lastSeenAt ?? 0, incoming.lastSeenAt ?? 0),
    hotness: Math.max(current.hotness, incoming.hotness),
    queryHits30d: current.queryHits30d + incoming.queryHits30d,
    createdAt: Math.min(current.createdAt, incoming.createdAt),
    updatedAt: Math.max(current.updatedAt, incoming.updatedAt),
    metadata: Object.freeze({ ...current.metadata, ...incoming.metadata }),
  });
}

function validateInput(input: CanonicalizeAuthoritativeEntityGraphInput): void {
  if (!input || typeof input.jobId !== "string" || !SAFE_ID.test(input.jobId) ||
      !input.graph || input.embeddings?.authority !== "runtime_active_embedding_space" ||
      !EMBEDDING_SPACE_ID.test(input.embeddings.embeddingSpaceId) ||
      input.embeddings.embeddingSpaceState !== "known-queryable" ||
      !Array.isArray(input.embeddings.vectors)) {
    throw new Error("Postgres entity canonicalization input is invalid");
  }
  const rawIds = input.graph.entities.map((entity) => entity.id);
  const vectorIds = input.embeddings.vectors.map((item) => item.rawEntityId);
  if (new Set(vectorIds).size !== vectorIds.length || vectorIds.length !== rawIds.length ||
      rawIds.some((id) => !vectorIds.includes(id))) {
    throw new Error("Postgres entity canonicalization embedding batch is invalid");
  }
}

export function snapshotEntityGraphEmbeddingBatch(
  graph: AuthoritativeEntityGraphDerivation,
  raw: EntityGraphEmbeddingBatch,
): EntityGraphEmbeddingBatch {
  validateInput({ jobId: "embedding-snapshot", graph, embeddings: raw });
  const vectors = raw.vectors.map((item) => {
    if (!item || typeof item.rawEntityId !== "string" || !SAFE_ID.test(item.rawEntityId) ||
        !Array.isArray(item.vector) || item.vector.length === 0 ||
        item.vector.some((value) => typeof value !== "number" || !Number.isFinite(value)) ||
        item.vector.every((value) => value === 0)) {
      throw new Error("Postgres entity canonicalization embedding batch is invalid");
    }
    return Object.freeze({
      rawEntityId: item.rawEntityId,
      vector: Object.freeze([...item.vector]),
    });
  });
  const dimensions = new Set(vectors.map((item) => item.vector.length));
  if (dimensions.size > 1) {
    throw new Error("Postgres entity canonicalization embedding dimensions are inconsistent");
  }
  return Object.freeze({
    authority: "runtime_active_embedding_space",
    embeddingSpaceId: raw.embeddingSpaceId,
    embeddingSpaceState: raw.embeddingSpaceState,
    vectors: Object.freeze(vectors),
  });
}

export async function assertActiveEntityGraphEmbeddingSpaceWithClient(
  client: PostgresEntityCanonicalizationClient,
  batch: EntityGraphEmbeddingBatch,
): Promise<void> {
  const active = rows(await client.query(ACTIVE_EMBEDDING_SPACE_SQL), 1);
  const descriptor = active[0];
  const dimensions = descriptor?.dimensions;
  const vectorDimensions = batch.vectors[0]?.vector.length;
  if (!descriptor || descriptor.embedding_space_id !== batch.embeddingSpaceId ||
      descriptor.state !== batch.embeddingSpaceState ||
      (descriptor.queryability_state !== null &&
        descriptor.queryability_state !== batch.embeddingSpaceState) ||
      !Number.isSafeInteger(dimensions) || (dimensions as number) <= 0 ||
      !Number.isSafeInteger(vectorDimensions) || vectorDimensions !== dimensions ||
      batch.vectors.some(({ vector }) => vector.length !== dimensions)) {
    throw new Error("Postgres entity canonicalization active embedding space is invalid");
  }
}

async function readIdentity(
  client: PostgresEntityCanonicalizationClient,
  sql: string,
  params: readonly unknown[],
  type: EntityType,
): Promise<PersistedEntityIdentity | undefined> {
  const found = rows(await client.query(sql, params), 2);
  if (found.length > 1) throw new Error("Postgres entity canonicalization identity is ambiguous");
  return decodeIdentity(found[0], type);
}

export async function canonicalizeAuthoritativeEntityGraphWithClient(
  client: PostgresEntityCanonicalizationClient,
  input: CanonicalizeAuthoritativeEntityGraphInput,
): Promise<EntityCanonicalizationPlan> {
  const embeddingBatch = snapshotEntityGraphEmbeddingBatch(input.graph, input.embeddings);
  const graph = input.graph;
  const common = scopeParams(graph);
  const vectors = new Map(embeddingBatch.vectors.map((item) => [item.rawEntityId, item.vector]));
  const lockKeys = Array.from(new Set(graph.entities.map((entity) =>
    JSON.stringify([graph.scopeFingerprint, entity.type])))).sort();
  for (const lockKey of lockKeys) {
    const locked = rows(await client.query(LOCK_SQL, [lockKey]), 1);
    if (locked.length !== 1) {
      throw new Error("Postgres entity canonicalization lock failed");
    }
  }

  const idMap = new Map<string, string>();
  const canonicalEntities = new Map<string, Readonly<GraphEntityRecord>>();
  const localExactIdentities = new Map<string, PersistedEntityIdentity>();
  const localAliasIdentities = new Map<string, PersistedEntityIdentity>();
  const entityResolutions: EntityCanonicalResolution[] = [];
  const relationResolutions: RelationCanonicalResolution[] = [];
  const relatedRelationResolutions = new Map<string, RelationCanonicalResolution>();
  const embeddingByCanonical = new Map<string, CanonicalEntityEmbedding>();
  const relatedRelations = new Map<string, Readonly<GraphRelationRecord>>();
  const relatedRelationEvidenceLinks = new Map<string, EntityGraphEvidenceLink>();

  for (const raw of graph.entities) {
    if (!ENTITY_TYPES.has(raw.type)) throw new Error("Postgres entity type is invalid");
    const normalized = canonicalize(raw.canonicalName);
    const localExactKey = `${raw.type}\0${normalized}`;
    let method: EntityCanonicalResolution["method"] = "create";
    let similarity: number | undefined;
    let relatedIdentity: PersistedEntityIdentity | undefined;
    let relatedSimilarity: number | undefined;
    let builtInAlias: string | undefined;
    let identity = localExactIdentities.get(localExactKey) ??
      await readIdentity(client, EXACT_SQL, [...common, raw.type, normalized], raw.type);
    if (identity) {
      method = "exact";
    } else {
      builtInAlias = toolAliasCanonical(raw);
      if (builtInAlias) {
        identity = localExactIdentities.get(`${raw.type}\0${builtInAlias}`) ??
          await readIdentity(client, EXACT_SQL, [...common, raw.type, builtInAlias], raw.type);
      }
      if (!identity) {
        identity = localAliasIdentities.get(`${raw.type}\0${normalized}`) ??
          await readIdentity(client, ALIAS_SQL, [...common, raw.type, normalized], raw.type);
      }
      if (identity) {
        method = "alias";
      } else if (builtInAlias) {
        identity = Object.freeze({
          id: raw.id,
          canonicalName: builtInAlias,
          displayName: raw.displayName,
          type: raw.type,
        });
      } else if (!NO_SEMANTIC_TYPES.has(raw.type)) {
        const vector = vectors.get(raw.id);
        if (!vector) throw new Error("Postgres entity canonicalization embedding is missing");
        const candidates = rows(await client.query(SEMANTIC_SQL, [
          ...common, raw.type, embeddingBatch.embeddingSpaceId,
          embeddingBatch.embeddingSpaceState, vectorParam(vector),
        ]), 1);
        const candidate = candidates[0];
        const rawCandidateSimilarity = candidate?.similarity;
        const candidateSimilarity = rawCandidateSimilarity === null
          ? undefined
          : rawCandidateSimilarity;
        if (candidateSimilarity !== undefined &&
            (typeof candidateSimilarity !== "number" || !Number.isFinite(candidateSimilarity))) {
          throw new Error("Postgres entity canonicalization similarity is invalid");
        }
        const decision = decideEntitySemanticMatch(raw.type, candidateSimilarity as number | undefined);
        if (decision.action === "merge") {
          identity = decodeIdentity(candidate, raw.type);
          method = "semantic";
          similarity = decision.similarity;
        } else if (decision.action === "judge_or_related") {
          relatedIdentity = decodeIdentity(candidate, raw.type);
          relatedSimilarity = decision.similarity;
        }
      }
    }

    const resolvedIdentity = identity ?? Object.freeze({
      id: raw.id, canonicalName: raw.canonicalName,
      displayName: raw.displayName, type: raw.type,
    });
    const resolved = mergeEntity(raw, resolvedIdentity);
    idMap.set(raw.id, resolved.id);
    canonicalEntities.set(
      resolved.id,
      canonicalEntities.has(resolved.id)
        ? combineEntity(canonicalEntities.get(resolved.id)!, resolved)
        : resolved,
    );
    localExactIdentities.set(localExactKey, persistedIdentity(resolved));
    localExactIdentities.set(
      `${resolved.type}\0${canonicalize(resolved.canonicalName)}`,
      persistedIdentity(resolved),
    );
    const observedAliases = Object.freeze(Array.from(new Set([
      raw.displayName, raw.canonicalName, ...raw.aliases,
    ])));
    const resolvedIdentitySnapshot = persistedIdentity(resolved);
    for (const alias of observedAliases) {
      localAliasIdentities.set(
        `${raw.type}\0${canonicalize(alias)}`,
        resolvedIdentitySnapshot,
      );
    }
    entityResolutions.push(Object.freeze({
      resolutionId: hash("mengshu.entity-resolution/v1", [
        graph.scopeFingerprint, input.jobId, graph.evidenceId, raw.id,
      ]),
      jobId: input.jobId,
      evidenceId: graph.evidenceId,
      rawEntityId: raw.id,
      canonicalEntityId: resolved.id,
      type: raw.type,
      method,
      ...(similarity === undefined ? {} : { similarity }),
      canRollback: method === "semantic",
      rawEntity: raw,
      observedAliases,
      createdAt: graph.evidenceCreatedAt,
    }));
    const vector = vectors.get(raw.id)!;
    if (!embeddingByCanonical.has(resolved.id) || method !== "create") {
      embeddingByCanonical.set(resolved.id, Object.freeze({
        entityId: resolved.id,
        type: resolved.type,
        embeddingSpaceId: embeddingBatch.embeddingSpaceId,
        embeddingSpaceState: embeddingBatch.embeddingSpaceState,
        vector: Object.freeze([...vector]),
        updatedAt: graph.evidenceCreatedAt,
      }));
    }
    if (relatedIdentity && relatedIdentity.id !== resolved.id) {
      const relatedId = relationId(graph.scopeFingerprint, {
        id: "semantic-review-band",
        scope: graph.scope,
        subjectId: resolved.id,
        predicate: "related_to",
        objectId: relatedIdentity.id,
        confidence: relatedSimilarity!,
        evidenceChunkIds: [graph.evidenceId],
        evidenceCount: 1,
        firstSeenAt: graph.evidenceCreatedAt,
        lastSeenAt: graph.evidenceCreatedAt,
        status: "weak",
        sourceKinds: [graph.evidenceSourceKind],
        metadata: {},
      }, resolved.id, relatedIdentity.id);
      const related = Object.freeze({
        id: relatedId,
        scope: graph.scope,
        subjectId: resolved.id,
        predicate: "related_to" as const,
        objectId: relatedIdentity.id,
        confidence: relatedSimilarity!,
        evidenceChunkIds: [graph.evidenceId],
        evidenceCount: 1,
        firstSeenAt: graph.evidenceCreatedAt,
        lastSeenAt: graph.evidenceCreatedAt,
        status: "weak" as const,
        sourceKinds: [graph.evidenceSourceKind],
        metadata: Object.freeze({
          resolution: "semantic_review_band",
          similarity: relatedSimilarity,
        }),
      }) satisfies GraphRelationRecord;
      relatedRelations.set(related.id, related);
      const relatedEvidence = Object.freeze({
        id: hash("mengshu.entity-graph-evidence/v1", [
          graph.scopeFingerprint, "relation", relatedId, graph.evidenceId,
          graph.memoryId, graph.evidenceSourceId, graph.evidenceSourceKind,
        ]),
        scope: graph.scope,
        targetKind: "relation",
        targetId: relatedId,
        evidenceId: graph.evidenceId,
        memoryId: graph.memoryId,
        sourceId: graph.evidenceSourceId,
        sourceKind: graph.evidenceSourceKind,
        createdAt: graph.evidenceCreatedAt,
      });
      relatedRelationEvidenceLinks.set(relatedEvidence.id, relatedEvidence);
      relatedRelationResolutions.set(relatedId, Object.freeze({
        resolutionId: hash("mengshu.relation-resolution/v1", [
          graph.scopeFingerprint, input.jobId, graph.evidenceId, relatedId,
        ]),
        jobId: input.jobId,
        evidenceId: graph.evidenceId,
        rawRelationId: relatedId,
        canonicalRelationId: relatedId,
        canonicalSubjectId: resolved.id,
        canonicalObjectId: relatedIdentity.id,
        outcome: "canonicalized",
        rawRelation: related,
        createdAt: graph.evidenceCreatedAt,
      }));
    }
  }

  const relations: GraphRelationRecord[] = [];
  for (const raw of graph.relations) {
    const subjectId = idMap.get(raw.subjectId);
    const objectId = idMap.get(raw.objectId);
    if (!subjectId || !objectId) throw new Error("Postgres entity relation endpoint is unresolved");
    const dropped = subjectId === objectId;
    const canonicalRelationId = dropped
      ? undefined
      : relationId(graph.scopeFingerprint, raw, subjectId, objectId);
    if (canonicalRelationId) {
      relations.push(Object.freeze({
        ...raw, id: canonicalRelationId, subjectId, objectId,
      }));
    }
    relationResolutions.push(Object.freeze({
      resolutionId: hash("mengshu.relation-resolution/v1", [
        graph.scopeFingerprint, input.jobId, graph.evidenceId, raw.id,
      ]),
      jobId: input.jobId,
      evidenceId: graph.evidenceId,
      rawRelationId: raw.id,
      ...(canonicalRelationId === undefined ? {} : { canonicalRelationId }),
      canonicalSubjectId: subjectId,
      canonicalObjectId: objectId,
      outcome: dropped ? "dropped_self" : "canonicalized",
      rawRelation: raw,
      createdAt: graph.evidenceCreatedAt,
    }));
  }

  for (const relation of relations) {
    relatedRelations.delete(relation.id);
    relatedRelationResolutions.delete(relation.id);
    for (const [id, link] of relatedRelationEvidenceLinks) {
      if (link.targetId === relation.id) relatedRelationEvidenceLinks.delete(id);
    }
  }

  const canonicalGraph = deriveAuthoritativeEntityGraph({
    graphKind: "entity",
    memoryId: graph.memoryId,
    evidence: {
      authority: "persisted_evidence",
      evidenceId: graph.evidenceId,
      scope: graph.scope,
      text: "authoritative-canonical-entity-evidence",
      sourceId: graph.evidenceSourceId,
      sourceKind: graph.evidenceSourceKind,
      createdAt: graph.evidenceCreatedAt,
    },
    extraction: {
      entities: [...canonicalEntities.values()],
      relations,
    },
  });
  const aliasBindings = Object.freeze(canonicalGraph.aliasProjections.map((alias) => {
    const entity = canonicalEntities.get(alias.entityId)!;
    return Object.freeze({
      bindingId: hash("mengshu.entity-alias-binding/v2", [
        graph.scopeFingerprint, entity.type, alias.normalizedAlias,
        alias.entityId, input.jobId, graph.evidenceId,
      ]),
      entityId: alias.entityId,
      type: entity.type,
      alias: alias.alias,
      normalizedAlias: alias.normalizedAlias,
      createdAt: graph.evidenceCreatedAt,
    });
  }));
  return Object.freeze({
    jobId: input.jobId,
    graph: canonicalGraph,
    entityResolutions: Object.freeze(entityResolutions),
    relationResolutions: Object.freeze([
      ...relatedRelationResolutions.values(),
      ...relationResolutions,
    ]),
    aliasBindings,
    embeddings: Object.freeze([...embeddingByCanonical.values()]),
    relatedRelations: Object.freeze([...relatedRelations.values()]),
    relatedRelationEvidenceLinks: Object.freeze([...relatedRelationEvidenceLinks.values()]),
  });
}

function validateWriteResult(
  result: PostgresEntityCanonicalizationQueryResult,
  expectedColumn: string,
  expectedValue: string | null,
): void {
  const accepted = rows(result, 1);
  if (accepted.length !== 1 || accepted[0]?.[expectedColumn] !== expectedValue) {
    throw new Error("Postgres entity canonicalization ledger result is invalid");
  }
}

function insertedWriteResult(
  result: PostgresEntityCanonicalizationQueryResult,
  expectedColumn: string,
  expectedValue: string,
): number {
  const accepted = rows(result, 1);
  if (accepted.length === 0) return 0;
  if (accepted[0]?.[expectedColumn] !== expectedValue) {
    throw new Error("Postgres entity canonicalization ledger result is invalid");
  }
  return 1;
}

export async function persistEntityCanonicalizationPlanWithClient(
  client: PostgresEntityCanonicalizationClient,
  plan: EntityCanonicalizationPlan,
): Promise<EntityCanonicalizationPersistResult> {
  const common = scopeParams(plan.graph);
  const related = plan.relatedRelations.length === 0
    ? Object.freeze({ createdRelations: 0, relationIds: Object.freeze([] as string[]) })
    : await new PostgresGraphRepository().upsertGraphWithClient(
      client,
      plan.graph.scope,
      [],
      plan.relatedRelations as readonly GraphRelationRecord[],
    );
  let relationEvidenceLinks = 0;
  for (const link of plan.relatedRelationEvidenceLinks) {
    relationEvidenceLinks += insertedWriteResult(await client.query(
      RELATED_RELATION_EVIDENCE_INSERT_SQL, [
      link.id, ...common, link.targetId, link.evidenceId, link.sourceId,
      link.sourceKind, link.createdAt,
      ],
    ), "link_id", link.id);
  }
  for (const binding of plan.aliasBindings) {
    validateWriteResult(await client.query(ALIAS_BINDING_UPSERT_SQL, [
      binding.bindingId, ...common, binding.type, binding.normalizedAlias,
      binding.entityId, binding.createdAt,
    ]), "canonical_entity_id", binding.entityId);
  }
  for (const resolution of plan.entityResolutions) {
    validateWriteResult(await client.query(ENTITY_RESOLUTION_INSERT_SQL, [
      resolution.resolutionId, ...common, resolution.jobId, resolution.evidenceId,
      resolution.rawEntityId, resolution.canonicalEntityId, resolution.type,
      resolution.method, resolution.similarity ?? null, resolution.canRollback,
      JSON.stringify(resolution.rawEntity), JSON.stringify(resolution.observedAliases),
      resolution.createdAt,
    ]), "canonical_entity_id", resolution.canonicalEntityId);
  }
  for (const resolution of plan.relationResolutions) {
    validateWriteResult(await client.query(RELATION_RESOLUTION_INSERT_SQL, [
      resolution.resolutionId, ...common, resolution.jobId, resolution.evidenceId,
      resolution.rawRelationId, resolution.canonicalRelationId ?? null,
      resolution.canonicalSubjectId, resolution.canonicalObjectId, resolution.outcome,
      JSON.stringify(resolution.rawRelation), resolution.createdAt,
    ]), "canonical_relation_id", resolution.canonicalRelationId ?? null);
  }
  for (const embedding of plan.embeddings) {
    validateWriteResult(await client.query(EMBEDDING_UPSERT_SQL, [
      ...common, embedding.entityId, embedding.type, embedding.embeddingSpaceId,
      embedding.embeddingSpaceState, vectorParam(embedding.vector), embedding.updatedAt,
    ]), "entity_id", embedding.entityId);
  }
  return Object.freeze({
    createdRelations: related.createdRelations,
    relationIds: Object.freeze([...related.relationIds]),
    relationEvidenceLinks,
  });
}
