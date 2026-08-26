/** 仅遍历工作记忆图；实体图查询继续由 GraphQueryService 承担。 */

import type { MemoryScope } from "../domain/types.js";
import type {
  WorkMemoryEdge,
  WorkMemoryEdgePredicate,
  WorkMemoryGraphNode,
  WorkMemoryGraphRepository,
  WorkMemoryNodeType,
} from "./work-memory-types.js";

export interface WorkMemoryGraphQueryInput {
  intent: "work_memory";
  scope: MemoryScope;
  nodeId?: string;
  recordId?: string;
  nodeType?: WorkMemoryNodeType;
  predicates?: readonly WorkMemoryEdgePredicate[];
  depth?: number;
  limit?: number;
}

export interface WorkMemoryGraphQueryResult {
  intent: "work_memory";
  nodes: WorkMemoryGraphNode[];
  edges: WorkMemoryEdge[];
  evidenceChunkIds: string[];
}

export class WorkMemoryGraphQueryService {
  constructor(private readonly repository: WorkMemoryGraphRepository) {}

  async query(input: WorkMemoryGraphQueryInput): Promise<WorkMemoryGraphQueryResult> {
    if (input.intent !== "work_memory") throw new Error("Work Memory Graph query intent is required");
    const maxDepth = Math.max(0, Math.min(input.depth ?? 1, 4));
    const limit = Math.max(1, Math.min(input.limit ?? 50, 500));
    const seeds = input.nodeId
      ? [await this.repository.getWorkMemoryNode(input.nodeId, input.scope)]
        .filter((node): node is WorkMemoryGraphNode => Boolean(node))
      : await this.repository.findWorkMemoryNodes({
        scope: input.scope,
        recordId: input.recordId,
        nodeType: input.nodeType,
        limit,
      });
    const nodes = new Map(seeds.map((node) => [node.id, node]));
    const edges = new Map<string, WorkMemoryEdge>();
    let frontier = seeds.map((node) => node.id);

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
      const next = new Set<string>();
      for (const nodeId of frontier) {
        const related = await this.repository.findWorkMemoryEdges({
          scope: input.scope,
          nodeId,
          limit,
        });
        for (const edge of related) {
          if (input.predicates && !input.predicates.includes(edge.predicate)) continue;
          edges.set(edge.id, edge);
          for (const endpoint of [edge.sourceId, edge.targetId]) {
            if (nodes.has(endpoint)) continue;
            const node = await this.repository.getWorkMemoryNode(endpoint, input.scope);
            if (node) {
              nodes.set(node.id, node);
              next.add(node.id);
            }
          }
        }
      }
      frontier = [...next];
    }

    const resultEdges = [...edges.values()].slice(0, limit);
    const evidenceChunkIds = new Set(resultEdges.flatMap((edge) => edge.evidenceChunkIds));
    for (const node of nodes.values()) {
      if (node.nodeType !== "evidence") {
        for (const evidenceId of node.evidenceChunkIds) evidenceChunkIds.add(evidenceId);
      }
    }
    return {
      intent: "work_memory",
      nodes: [...nodes.values()].slice(0, limit),
      edges: resultEdges,
      evidenceChunkIds: [...evidenceChunkIds],
    };
  }
}
