import { createHash } from "node:crypto";

import type { CanonicalAuthorityScope } from "../domain/authority-scope-fingerprint.js";
import {
  deriveAuthoritativeEntityGraph,
  type AuthoritativeEntityGraphDerivation,
} from "./authoritative-entity-graph-derivation.js";
import {
  PostgresGraphRepository,
  type PostgresGraphPersistResult,
  type PostgresGraphQueryClient,
  type PostgresGraphQueryResult,
} from "./postgres-repository.js";

export interface PostgresAuthoritativeEntityGraphClient extends PostgresGraphQueryClient {}

export interface PostgresAuthoritativeEntityGraphPersistResult extends PostgresGraphPersistResult {
  readonly memoryEvidenceLinks: number;
  readonly entityEvidenceLinks: number;
  readonly relationEvidenceLinks: number;
  readonly aliasProjections: number;
}

const MEMORY_LINK_SQL = `INSERT INTO mengshu_memory_evidence_links (
  link_id, scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id,
  namespace, visibility, workspace_id, session_id, target_memory_id,
  evidence_memory_id, link_kind, source, created_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
ON CONFLICT (scope_fingerprint, target_memory_id, evidence_memory_id, link_kind, source)
DO NOTHING RETURNING link_id`;

const ENTITY_EVIDENCE_SQL = `INSERT INTO mengshu_graph_entity_evidence (
  link_id, scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id,
  namespace, visibility, workspace_id, session_id, entity_id, evidence_memory_id,
  source_id, source_kind, created_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
ON CONFLICT (scope_fingerprint, entity_id, evidence_memory_id, source_id, source_kind)
DO NOTHING RETURNING link_id`;

const RELATION_EVIDENCE_SQL = `INSERT INTO mengshu_graph_relation_evidence (
  link_id, scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id,
  namespace, visibility, workspace_id, session_id, relation_id, evidence_memory_id,
  source_id, source_kind, created_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
ON CONFLICT (scope_fingerprint, relation_id, evidence_memory_id, source_id, source_kind)
DO NOTHING RETURNING link_id`;

const ALIAS_SQL = `INSERT INTO mengshu_graph_entity_aliases (
  alias_id, scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id,
  namespace, visibility, workspace_id, session_id, entity_id, alias, normalized_alias,
  evidence_memory_id, source_id, created_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
ON CONFLICT (scope_fingerprint, entity_id, normalized_alias)
DO NOTHING RETURNING alias_id`;

function scopeParams(scope: CanonicalAuthorityScope, fingerprint: string): readonly unknown[] {
  return [fingerprint, scope.tenantId, scope.userId, scope.appId, scope.projectId,
    scope.agentId, scope.namespace, scope.visibility, scope.workspaceId, scope.sessionId];
}

function memoryLinkId(graph: AuthoritativeEntityGraphDerivation): string {
  return createHash("sha256").update(JSON.stringify([
    "mengshu.memory-evidence-link/v1", graph.scopeFingerprint, graph.memoryId,
    graph.evidenceId, "grounded_by", "entity_graph",
  ])).digest("hex");
}

function inserted(result: PostgresGraphQueryResult, expectedColumn: string): number {
  if (!result || !Array.isArray(result.rows) || !Number.isSafeInteger(result.rowCount) ||
      result.rowCount !== result.rows.length || result.rows.length > 1) {
    throw new Error("Postgres authoritative Entity Graph ledger result is invalid");
  }
  if (result.rows.length === 0) return 0;
  const row = result.rows[0];
  if (!row || typeof row[expectedColumn] !== "string") {
    throw new Error("Postgres authoritative Entity Graph ledger result is invalid");
  }
  return 1;
}

export function snapshotAuthoritativeEntityGraphDerivation(
  raw: AuthoritativeEntityGraphDerivation,
): AuthoritativeEntityGraphDerivation {
  if (!raw || typeof raw !== "object") {
    throw new Error("Postgres authoritative Entity Graph derivation is invalid");
  }
  let derived: AuthoritativeEntityGraphDerivation;
  try {
    derived = deriveAuthoritativeEntityGraph({
      graphKind: "entity",
      memoryId: raw.memoryId,
      evidence: {
        authority: "persisted_evidence",
        evidenceId: raw.evidenceId,
        scope: raw.scope,
        text: "authoritative-persisted-evidence",
        sourceId: raw.evidenceSourceId,
        sourceKind: raw.evidenceSourceKind,
        createdAt: raw.evidenceCreatedAt,
      },
      extraction: { entities: raw.entities, relations: raw.relations },
    });
  } catch {
    throw new Error("Postgres authoritative Entity Graph derivation is invalid");
  }
  if (JSON.stringify(derived) !== JSON.stringify(raw)) {
    throw new Error("Postgres authoritative Entity Graph derivation is invalid");
  }
  return derived;
}

export async function persistAuthoritativeEntityGraphWithClient(
  client: PostgresAuthoritativeEntityGraphClient,
  graph: AuthoritativeEntityGraphDerivation,
): Promise<PostgresAuthoritativeEntityGraphPersistResult> {
  const repository = new PostgresGraphRepository();
  const persisted = await repository.upsertGraphWithClient(
    client,
    graph.scope,
    graph.entities as Parameters<PostgresGraphRepository["upsertGraphWithClient"]>[2],
    graph.relations as Parameters<PostgresGraphRepository["upsertGraphWithClient"]>[3],
  );
  const common = scopeParams(graph.scope, graph.scopeFingerprint);
  const memoryEvidenceLinks = inserted(await client.query(MEMORY_LINK_SQL, [
    memoryLinkId(graph), ...common, graph.memoryId, graph.evidenceId,
    "grounded_by", "entity_graph", graph.evidenceCreatedAt,
  ]), "link_id");
  let entityEvidenceLinks = 0;
  for (const link of graph.entityEvidenceLinks) {
    entityEvidenceLinks += inserted(await client.query(ENTITY_EVIDENCE_SQL, [
      link.id, ...common, link.targetId, link.evidenceId, link.sourceId,
      link.sourceKind, link.createdAt,
    ]), "link_id");
  }
  let relationEvidenceLinks = 0;
  for (const link of graph.relationEvidenceLinks) {
    relationEvidenceLinks += inserted(await client.query(RELATION_EVIDENCE_SQL, [
      link.id, ...common, link.targetId, link.evidenceId, link.sourceId,
      link.sourceKind, link.createdAt,
    ]), "link_id");
  }
  let aliasProjections = 0;
  for (const alias of graph.aliasProjections) {
    aliasProjections += inserted(await client.query(ALIAS_SQL, [
      alias.id, ...common, alias.entityId, alias.alias, alias.normalizedAlias,
      alias.evidenceId, alias.sourceId, alias.createdAt,
    ]), "alias_id");
  }
  return Object.freeze({
    ...persisted,
    memoryEvidenceLinks,
    entityEvidenceLinks,
    relationEvidenceLinks,
    aliasProjections,
  });
}
