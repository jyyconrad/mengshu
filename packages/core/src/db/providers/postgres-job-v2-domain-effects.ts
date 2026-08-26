import { createHash } from "node:crypto";

import { canonicalAuthorityScope } from "../../domain/authority-scope-fingerprint.js";
import type { AuthoritativeEntityGraphDerivation } from
  "../../graph/authoritative-entity-graph-derivation.js";
import type { MemoryTreeType, TreeLeaf } from "../../tree/types.js";
import type { GraphEntityRecord, GraphRelationRecord } from "../../graph/types.js";
import type { EntityGraphEmbeddingBatch } from
  "../../graph/postgres-entity-canonicalization.js";
import type { DurableJobV2Scope } from "../../storage/repositories/job-v2.js";
import type { PostgresDurableJobV2EffectResult } from
  "../../storage/repositories/postgres-job-v2-effect.js";
import type { PostgresDurableJobV2EffectReplayInspection } from
  "../../storage/repositories/postgres-job-v2-effect.js";

export const POSTGRES_BUILD_TREE_EFFECT_KEY = "build_tree.persist.v1" as const;
export const POSTGRES_EXTRACT_GRAPH_EFFECT_KEY = "extract_graph.persist.v1" as const;

export interface PostgresDomainEffectFence {
  readonly id: string;
  readonly scope: DurableJobV2Scope;
  readonly owner: string;
  readonly leaseToken: string;
  readonly leaseGeneration: number;
}
export interface PostgresAppendTreeSemanticRequest {
  readonly type: "build_tree";
  readonly version: 1;
  readonly traceId: string;
  readonly context: Readonly<{ workspaceId?: string; sessionId?: string }>;
  readonly treeType: MemoryTreeType;
  readonly treeKey: string;
  readonly level: 0;
  readonly policy: Readonly<{ maxLeafCount: 20; maxTokenCount: 6000 }>;
  readonly leaf: Readonly<TreeLeaf>;
  readonly expectedBufferId: string;
}

export interface PostgresFinalizeTreeSemanticRequest {
  readonly type: "finalize_tree_buffer";
  readonly version: 1;
  readonly traceId: string;
  readonly context: Readonly<{ workspaceId?: string; sessionId?: string }>;
  readonly treeType: Exclude<MemoryTreeType, "global">;
  readonly treeKey: string;
  readonly level: 0;
  readonly finalizeMode: "history_rebuild";
  readonly expectedBufferId: string;
}

export type PostgresBuildTreeSemanticRequest =
  | PostgresAppendTreeSemanticRequest
  | PostgresFinalizeTreeSemanticRequest;

export interface PostgresBuildTreeEffectRequest {
  readonly effectKey: typeof POSTGRES_BUILD_TREE_EFFECT_KEY;
  readonly effectInput: PostgresDomainEffectFence;
  readonly semanticRequest: PostgresBuildTreeSemanticRequest;
}

export interface PostgresBuildTreeEffectSummary extends Record<string, unknown> {
  readonly leafId: string;
  readonly sealed: boolean;
  readonly bufferId: string | null;
  readonly nodeId: string | null;
  /** Absent only on historical build_tree.persist.v1 receipts created before folding. */
  readonly foldedNodeIds?: readonly string[];
}

export interface PostgresExtractGraphSemanticRequest {
  readonly chunkId: string;
  readonly text: string;
  readonly sourceId?: string;
  readonly context?: Readonly<{
    projectName?: string;
    userName?: string;
    agentName?: string;
  }>;
}

export interface PostgresLegacyExtractGraphEffectRequest {
  readonly effectInput: PostgresDomainEffectFence;
  readonly context: Readonly<{ workspaceId?: string; sessionId?: string }>;
  readonly semanticRequest: PostgresExtractGraphSemanticRequest;
  readonly entities: readonly Readonly<GraphEntityRecord>[];
  readonly relations: readonly Readonly<GraphRelationRecord>[];
}

export interface PostgresAuthoritativeExtractGraphSemanticRequest {
  readonly graphKind: "entity";
  readonly activeMemoryId: string;
  readonly evidenceId: string;
}

export interface PostgresAuthoritativeExtractGraphEffectRequest {
  readonly effectInput: PostgresDomainEffectFence;
  readonly context: Readonly<{ workspaceId?: string; sessionId?: string }>;
  readonly semanticRequest: PostgresAuthoritativeExtractGraphSemanticRequest;
  readonly graph: AuthoritativeEntityGraphDerivation;
  readonly entityEmbeddings: EntityGraphEmbeddingBatch;
}

export type PostgresExtractGraphEffectRequest =
  | PostgresLegacyExtractGraphEffectRequest
  | PostgresAuthoritativeExtractGraphEffectRequest;

export interface PostgresExtractGraphEffectSummary extends Record<string, unknown> {
  readonly createdEntities: number;
  readonly createdRelations: number;
  readonly entityIds: readonly string[];
  readonly relationIds: readonly string[];
  readonly evidenceId?: string;
  readonly memoryEvidenceLinks?: number;
  readonly entityEvidenceLinks?: number;
  readonly relationEvidenceLinks?: number;
  readonly aliasProjections?: number;
}

export interface PostgresTreeAndGraphEffectPort {
  readonly executeBuildTreeEffect: (
    request: PostgresBuildTreeEffectRequest,
    signal: AbortSignal,
  ) => Promise<PostgresDurableJobV2EffectResult<PostgresBuildTreeEffectSummary>>;
  readonly executeGraphEffect: (
    request: PostgresExtractGraphEffectRequest,
  ) => Promise<PostgresDurableJobV2EffectResult<PostgresExtractGraphEffectSummary>>;
}

export interface PostgresAuthoritativeExtractGraphReplayRequest {
  readonly effectInput: PostgresDomainEffectFence;
  readonly context: Readonly<{ workspaceId?: string; sessionId?: string }>;
  readonly semanticRequest: PostgresAuthoritativeExtractGraphSemanticRequest;
}

export interface PostgresAuthoritativeExtractGraphReplayPort {
  readonly inspectAuthoritativeGraphReplay: (
    request: PostgresAuthoritativeExtractGraphReplayRequest,
  ) => Promise<PostgresDurableJobV2EffectReplayInspection<PostgresExtractGraphEffectSummary>>;
}

function fingerprint(value: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function buildTreeSemanticFingerprint(request: PostgresBuildTreeEffectRequest): string {
  const semantic = request.semanticRequest;
  const scope = canonicalAuthorityScope({
    ...request.effectInput.scope,
    ...semantic.context,
  });
  return fingerprint([
    "mengshu.build-tree-effect.semantic-request/v1",
    request.effectInput.id,
    scope,
    semantic.type,
    semantic.version,
    semantic.traceId,
    semantic.treeType,
    semantic.treeKey,
    semantic.level,
    ...(semantic.type === "build_tree"
      ? [semantic.policy, semantic.leaf]
      : [semantic.finalizeMode]),
    semantic.expectedBufferId,
  ]);
}

export function extractGraphSemanticFingerprint(
  request: PostgresExtractGraphEffectRequest,
): string {
  const scope = canonicalAuthorityScope({
    ...request.effectInput.scope,
    ...request.context,
  });
  if ("graphKind" in request.semanticRequest) {
    return fingerprint([
      "mengshu.extract-graph-effect.authoritative-semantic-request/v1",
      request.effectInput.id,
      scope,
      request.semanticRequest.graphKind,
      request.semanticRequest.activeMemoryId,
      request.semanticRequest.evidenceId,
    ]);
  }
  return fingerprint([
    "mengshu.extract-graph-effect.semantic-request/v1",
    request.effectInput.id,
    scope,
    request.semanticRequest,
  ]);
}

export function authoritativeExtractGraphReplayFingerprint(
  request: PostgresAuthoritativeExtractGraphReplayRequest,
): string {
  const scope = canonicalAuthorityScope({
    ...request.effectInput.scope,
    ...request.context,
  });
  return fingerprint([
    "mengshu.extract-graph-effect.authoritative-semantic-request/v1",
    request.effectInput.id,
    scope,
    request.semanticRequest.graphKind,
    request.semanticRequest.activeMemoryId,
    request.semanticRequest.evidenceId,
  ]);
}
