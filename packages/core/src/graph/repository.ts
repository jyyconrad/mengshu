/**
 * In-memory structured graph repository.
 *
 * 作为 graph/tree 持久化 provider 的 contract baseline：upsert entity/relation
 * 会合并 mention/evidence 统计，查询严格按 scope 隔离。
 */

import { scopeToKey } from "../domain/scope.js";
import type { MemoryScope } from "../domain/types.js";
import type { GraphEntityRecord, GraphRelationRecord, RelationPredicate } from "./types.js";
import type {
  WorkMemoryEdge,
  WorkMemoryEdgeFilter,
  WorkMemoryGraphBatch,
  WorkMemoryGraphNode,
  WorkMemoryGraphRepository,
  WorkMemoryNodeFilter,
} from "./work-memory-types.js";
import {
  validateWorkMemoryEdge,
  validateWorkMemoryNode,
  workMemoryScopeKey,
} from "./work-memory-validation.js";

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

export interface EntityGraphRepository {
  upsertEntities(records: GraphEntityRecord[]): Promise<void>;
  upsertRelations(records: GraphRelationRecord[]): Promise<void>;
  getEntity(id: string, scope?: MemoryScope): Promise<GraphEntityRecord | undefined>;
  getRelation(id: string, scope?: MemoryScope): Promise<GraphRelationRecord | undefined>;
  findEntities(filter: EntityFilter): Promise<GraphEntityRecord[]>;
  findRelations(filter: RelationFilter): Promise<GraphRelationRecord[]>;
}

/**
 * 共享 capability 合同；每个查询入口仍必须显式声明图查询意图。
 *
 * 当前 PostgreSQL v9 实体表必须经过 migration 才能承载工作记忆节点。
 * provider 可通过 GraphRepositoryOverlay 组合两个 schema，同时保持查询意图隔离。
 */
export interface GraphRepository extends EntityGraphRepository, WorkMemoryGraphRepository {}

/** 为两个图 schema 分开落地的 provider 提供增量组合边界。 */
export class GraphRepositoryOverlay implements GraphRepository {
  constructor(
    private readonly entityGraph: EntityGraphRepository,
    private readonly workMemoryGraph: WorkMemoryGraphRepository,
  ) {}

  async upsertEntities(records: GraphEntityRecord[]): Promise<void> {
    return this.entityGraph.upsertEntities(records);
  }

  async upsertRelations(records: GraphRelationRecord[]): Promise<void> {
    return this.entityGraph.upsertRelations(records);
  }

  async getEntity(id: string, scope?: MemoryScope): Promise<GraphEntityRecord | undefined> {
    return this.entityGraph.getEntity(id, scope);
  }

  async getRelation(id: string, scope?: MemoryScope): Promise<GraphRelationRecord | undefined> {
    return this.entityGraph.getRelation(id, scope);
  }

  async findEntities(filter: EntityFilter): Promise<GraphEntityRecord[]> {
    return this.entityGraph.findEntities(filter);
  }

  async findRelations(filter: RelationFilter): Promise<GraphRelationRecord[]> {
    return this.entityGraph.findRelations(filter);
  }

  async upsertWorkMemoryGraph(batch: WorkMemoryGraphBatch): Promise<void> {
    return this.workMemoryGraph.upsertWorkMemoryGraph(batch);
  }

  async getWorkMemoryNode(id: string, scope: MemoryScope): Promise<WorkMemoryGraphNode | undefined> {
    return this.workMemoryGraph.getWorkMemoryNode(id, scope);
  }

  async getWorkMemoryEdge(id: string, scope: MemoryScope): Promise<WorkMemoryEdge | undefined> {
    return this.workMemoryGraph.getWorkMemoryEdge(id, scope);
  }

  async findWorkMemoryNodes(filter: WorkMemoryNodeFilter): Promise<WorkMemoryGraphNode[]> {
    return this.workMemoryGraph.findWorkMemoryNodes(filter);
  }

  async findWorkMemoryEdges(filter: WorkMemoryEdgeFilter): Promise<WorkMemoryEdge[]> {
    return this.workMemoryGraph.findWorkMemoryEdges(filter);
  }
}

function mergeUnique<T>(left: T[], right: T[]): T[] {
  return Array.from(new Set([...left, ...right]));
}

export class InMemoryGraphRepository implements GraphRepository {
  private readonly entities = new Map<string, GraphEntityRecord>();
  private readonly relations = new Map<string, GraphRelationRecord>();
  private readonly workMemoryNodes = new Map<string, WorkMemoryGraphNode>();
  private readonly workMemoryEdges = new Map<string, WorkMemoryEdge>();

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

  async upsertWorkMemoryGraph(batch: WorkMemoryGraphBatch): Promise<void> {
    const scopeKey = workMemoryScopeKey(batch.scope);
    const nodeKeys = new Set<string>();
    const edgeKeys = new Set<string>();
    for (const node of batch.nodes) {
      validateWorkMemoryNode(node, batch.scope);
      const key = `${scopeKey}:${node.id}`;
      if (nodeKeys.has(key)) throw new Error("Invalid Work Memory Graph: duplicate node id in batch");
      const existing = this.workMemoryNodes.get(key);
      if (existing && (existing.nodeType !== node.nodeType || existing.recordId !== node.recordId)) {
        throw new Error("Invalid Work Memory Graph: node identity cannot change");
      }
      nodeKeys.add(key);
    }
    const resolveNode = (id: string): WorkMemoryGraphNode | undefined =>
      batch.nodes.find((node) => node.id === id) ?? this.workMemoryNodes.get(`${scopeKey}:${id}`);
    const allBoundNodes = [
      ...[...this.workMemoryNodes.entries()]
        .filter(([key]) => key.startsWith(`${scopeKey}:`))
        .map(([, node]) => node),
      ...batch.nodes,
    ];
    const evidenceRecordIds = new Set(allBoundNodes
      .filter((node) => node.nodeType === "evidence")
      .map((node) => node.recordId));
    const memoryRecordIds = new Set(allBoundNodes
      .filter((node) => node.nodeType === "memory")
      .map((node) => node.recordId));
    const assertEvidenceResolvable = (ids: readonly string[]): void => {
      if (ids.some((id) => !evidenceRecordIds.has(id))) {
        throw new Error("Invalid Work Memory Graph: cannot resolve evidence in the bound scope");
      }
    };
    for (const node of batch.nodes) {
      if (node.nodeType !== "evidence") assertEvidenceResolvable(node.evidenceChunkIds);
      if (node.nodeType === "skill_candidate" &&
          node.evidenceMemoryIds.some((id) => !memoryRecordIds.has(id))) {
        throw new Error("Invalid Work Memory Graph: cannot resolve memory evidence in the bound scope");
      }
    }
    for (const edge of batch.edges) {
      validateWorkMemoryEdge(edge, batch.scope, resolveNode);
      assertEvidenceResolvable(edge.evidenceChunkIds);
      const key = `${scopeKey}:${edge.id}`;
      if (edgeKeys.has(key)) throw new Error("Invalid Work Memory Graph: duplicate edge id in batch");
      const existing = this.workMemoryEdges.get(key);
      if (existing && (existing.predicate !== edge.predicate || existing.sourceId !== edge.sourceId ||
          existing.targetId !== edge.targetId)) {
        throw new Error("Invalid Work Memory Graph: edge identity cannot change");
      }
      edgeKeys.add(key);
    }

    for (const node of batch.nodes) this.workMemoryNodes.set(`${scopeKey}:${node.id}`, node);
    for (const edge of batch.edges) this.workMemoryEdges.set(`${scopeKey}:${edge.id}`, edge);
  }

  async getWorkMemoryNode(id: string, scope: MemoryScope): Promise<WorkMemoryGraphNode | undefined> {
    return this.workMemoryNodes.get(`${workMemoryScopeKey(scope)}:${id}`);
  }

  async getWorkMemoryEdge(id: string, scope: MemoryScope): Promise<WorkMemoryEdge | undefined> {
    return this.workMemoryEdges.get(`${workMemoryScopeKey(scope)}:${id}`);
  }

  async findWorkMemoryNodes(filter: WorkMemoryNodeFilter): Promise<WorkMemoryGraphNode[]> {
    const scopeKey = workMemoryScopeKey(filter.scope);
    const query = filter.query?.toLowerCase();
    return [...this.workMemoryNodes.entries()]
      .filter(([key]) => key.startsWith(`${scopeKey}:`))
      .map(([, node]) => node)
      .filter((node) => !filter.nodeType || node.nodeType === filter.nodeType)
      .filter((node) => !filter.recordId || node.recordId === filter.recordId)
      .filter((node) => !query || node.label.toLowerCase().includes(query))
      .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
      .slice(0, filter.limit ?? Number.POSITIVE_INFINITY);
  }

  async findWorkMemoryEdges(filter: WorkMemoryEdgeFilter): Promise<WorkMemoryEdge[]> {
    const scopeKey = workMemoryScopeKey(filter.scope);
    return [...this.workMemoryEdges.entries()]
      .filter(([key]) => key.startsWith(`${scopeKey}:`))
      .map(([, edge]) => edge)
      .filter((edge) => !filter.nodeId || edge.sourceId === filter.nodeId || edge.targetId === filter.nodeId)
      .filter((edge) => !filter.predicate || edge.predicate === filter.predicate)
      .sort((left, right) => right.confidence - left.confidence || left.id.localeCompare(right.id))
      .slice(0, filter.limit ?? Number.POSITIVE_INFINITY);
  }
}
