/**
 * Graph query service.
 *
 * 提供 entity lookup 与 depth-limited relation traversal，返回 relation evidence，
 * 供 REST、Console 和 retrieval orchestrator 统一消费。
 */

import type { MemoryScope } from "../domain/types.js";
import type { InMemoryGraphRepository } from "./repository.js";
import type { GraphEntityRecord, GraphRelationRecord } from "./types.js";

export interface GraphQueryInput {
  scope: MemoryScope;
  query?: string;
  entityId?: string;
  depth?: number;
  limit?: number;
}

export interface GraphQueryResult {
  entities: GraphEntityRecord[];
  relations: GraphRelationRecord[];
  evidenceChunkIds: string[];
}

export class GraphQueryService {
  constructor(private readonly repository: InMemoryGraphRepository) {}

  async query(input: GraphQueryInput): Promise<GraphQueryResult> {
    const maxDepth = Math.max(1, Math.min(input.depth ?? 1, 2));
    const seedEntities = input.entityId
      ? [await this.repository.getEntity(input.entityId)].filter((entity): entity is GraphEntityRecord => Boolean(entity))
      : await this.repository.findEntities({
        scope: input.scope,
        query: input.query,
        limit: input.limit ?? 5,
      });
    const visitedEntities = new Map(seedEntities.map((entity) => [entity.id, entity]));
    const visitedRelations = new Map<string, GraphRelationRecord>();
    let frontier = seedEntities.map((entity) => entity.id);

    for (let depth = 0; depth < maxDepth; depth += 1) {
      const next = new Set<string>();
      for (const entityId of frontier) {
        const relations = await this.repository.findRelations({
          scope: input.scope,
          entityId,
          limit: input.limit ?? 20,
        });
        for (const relation of relations) {
          visitedRelations.set(relation.id, relation);
          for (const nextEntityId of [relation.subjectId, relation.objectId]) {
            if (!visitedEntities.has(nextEntityId)) {
              const entity = await this.repository.getEntity(nextEntityId);
              if (entity) {
                visitedEntities.set(entity.id, entity);
                next.add(entity.id);
              }
            }
          }
        }
      }
      frontier = Array.from(next);
      if (frontier.length === 0) {
        break;
      }
    }

    const relations = Array.from(visitedRelations.values())
      .sort((left, right) => right.confidence - left.confidence)
      .slice(0, input.limit ?? Number.POSITIVE_INFINITY);

    return {
      entities: Array.from(visitedEntities.values()),
      relations,
      evidenceChunkIds: Array.from(new Set(relations.flatMap((relation) => relation.evidenceChunkIds))),
    };
  }
}
