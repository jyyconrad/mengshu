/**
 * Structured knowledge graph domain types.
 *
 * 图谱层表达实体、关系和 evidence 的结构化事实；所有记录都带 scope，
 * relation 必须绑定 evidence chunk，避免不可追溯的模型生成结论。
 */

import type { MemoryScope } from "../domain/types.js";
import type { EntityType, RelationPredicate } from "./schema.js";

// Re-export schema types for backward compatibility
export type { EntityType, RelationPredicate };
export { ENTITY_TYPES, RELATION_PREDICATES } from "./schema.js";

export type EntityStatus = "active" | "archived" | "merged";
export type RelationStatus = "active" | "weak" | "contradicted" | "archived";

export interface GraphEntityRecord {
  id: string;
  scope: MemoryScope;
  canonicalName: string;
  displayName: string;
  type: EntityType;
  aliases: string[];
  mentionCount: number;
  mentionCount30d: number;
  distinctSourceCount: number;
  lastSeenAt?: number;
  hotness: number;
  graphCentrality?: number;
  queryHits30d: number;
  status: EntityStatus;
  mergedInto?: string;
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown>;
}

export interface GraphRelationRecord {
  id: string;
  scope: MemoryScope;
  subjectId: string;
  predicate: RelationPredicate;
  objectId: string;
  confidence: number;
  evidenceChunkIds: string[];
  evidenceCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
  status: RelationStatus;
  sourceKinds: string[];
  metadata: Record<string, unknown>;
}

export interface GraphExtractionInput {
  scope: MemoryScope;
  chunkId: string;
  text: string;
  sourceId?: string;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

export interface GraphExtractionResult {
  entities: GraphEntityRecord[];
  relations: GraphRelationRecord[];
}
