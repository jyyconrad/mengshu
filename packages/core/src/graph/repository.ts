/**
 * In-memory structured graph repository.
 *
 * 作为 graph/tree 持久化 provider 的 contract baseline：upsert entity/relation
 * 会合并 mention/evidence 统计，查询严格按 scope 隔离。
 */

import { scopeToKey } from "../domain/scope.js";
import type { MemoryScope } from "../domain/types.js";
import type { GraphEntityRecord, GraphRelationRecord, RelationPredicate } from "./types.js";

export interface EntityFilter {
  scope: MemoryScope;
  query?: string;
  type?: string;
  limit?: number;
}

export interface RelationFilter {
  scope: MemoryScope;
  entityId?: string;
  predicate?: RelationPredicate;
  limit?: number;
}

function mergeUnique<T>(left: T[], right: T[]): T[] {
  return Array.from(new Set([...left, ...right]));
}

export class InMemoryGraphRepository {
  private readonly entities = new Map<string, GraphEntityRecord>();
  private readonly relations = new Map<string, GraphRelationRecord>();

  async upsertEntities(records: GraphEntityRecord[]): Promise<void> {
    for (const record of records) {
      const existing = this.entities.get(record.id);
      if (!existing) {
        this.entities.set(record.id, record);
        continue;
      }
      this.entities.set(record.id, {
        ...existing,
        ...record,
        aliases: mergeUnique(existing.aliases, record.aliases),
        mentionCount: existing.mentionCount + record.mentionCount,
        mentionCount30d: existing.mentionCount30d + record.mentionCount30d,
        distinctSourceCount: Math.max(existing.distinctSourceCount, record.distinctSourceCount),
        lastSeenAt: Math.max(existing.lastSeenAt ?? 0, record.lastSeenAt ?? 0),
        hotness: Math.max(existing.hotness, record.hotness),
        queryHits30d: existing.queryHits30d + record.queryHits30d,
        metadata: { ...existing.metadata, ...record.metadata },
        createdAt: Math.min(existing.createdAt, record.createdAt),
        updatedAt: Math.max(existing.updatedAt, record.updatedAt),
      });
    }
  }

  async upsertRelations(records: GraphRelationRecord[]): Promise<void> {
    for (const record of records) {
      const existing = this.relations.get(record.id);
      if (!existing) {
        this.relations.set(record.id, record);
        continue;
      }
      const evidenceChunkIds = mergeUnique(existing.evidenceChunkIds, record.evidenceChunkIds);
      this.relations.set(record.id, {
        ...existing,
        ...record,
        confidence: Math.max(existing.confidence, record.confidence),
        evidenceChunkIds,
        evidenceCount: evidenceChunkIds.length,
        firstSeenAt: Math.min(existing.firstSeenAt, record.firstSeenAt),
        lastSeenAt: Math.max(existing.lastSeenAt, record.lastSeenAt),
        sourceKinds: mergeUnique(existing.sourceKinds, record.sourceKinds),
        metadata: { ...existing.metadata, ...record.metadata },
      });
    }
  }

  async findEntities(filter: EntityFilter): Promise<GraphEntityRecord[]> {
    const key = scopeToKey(filter.scope);
    const query = filter.query?.toLowerCase();
    return Array.from(this.entities.values())
      .filter((entity) => scopeToKey(entity.scope) === key)
      .filter((entity) => !filter.type || entity.type === filter.type)
      .filter((entity) => !query ||
        entity.canonicalName.includes(query) ||
        entity.displayName.toLowerCase().includes(query) ||
        entity.aliases.some((alias) => alias.toLowerCase().includes(query)))
      .sort((left, right) => right.hotness - left.hotness || right.mentionCount - left.mentionCount)
      .slice(0, filter.limit ?? Number.POSITIVE_INFINITY);
  }

  async findRelations(filter: RelationFilter): Promise<GraphRelationRecord[]> {
    const key = scopeToKey(filter.scope);
    return Array.from(this.relations.values())
      .filter((relation) => scopeToKey(relation.scope) === key)
      .filter((relation) => !filter.entityId || relation.subjectId === filter.entityId || relation.objectId === filter.entityId)
      .filter((relation) => !filter.predicate || relation.predicate === filter.predicate)
      .sort((left, right) => right.confidence - left.confidence || right.evidenceCount - left.evidenceCount)
      .slice(0, filter.limit ?? Number.POSITIVE_INFINITY);
  }

  async getEntity(id: string): Promise<GraphEntityRecord | undefined> {
    return this.entities.get(id);
  }

  async getRelation(id: string): Promise<GraphRelationRecord | undefined> {
    return this.relations.get(id);
  }
}
