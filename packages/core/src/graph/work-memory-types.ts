/**
 * Mengshu 原生工作记忆图合同。
 *
 * 工作记忆图表达受治理的记忆演化；即使与实体图共享 repository，
 * 两者仍保持独立的 schema 和查询语义。
 */

import type {
  MemoryLifecycleStatus,
  MemoryScope,
  MemorySemanticType,
} from "../domain/types.js";
import type { SkillCandidateStatus } from "../lifecycle/skill-candidate-types.js";

export const WORK_MEMORY_NODE_TYPES = [
  "evidence",
  "memory",
  "summary",
  "skill_candidate",
] as const;

export type WorkMemoryNodeType = (typeof WORK_MEMORY_NODE_TYPES)[number];

export const WORK_MEMORY_EDGE_PREDICATES = [
  "grounded_by",
  "derives_from",
  "contradicts",
  "supersedes",
  "promoted_to",
] as const;

export type WorkMemoryEdgePredicate = (typeof WORK_MEMORY_EDGE_PREDICATES)[number];

interface WorkMemoryGraphNodeBase {
  id: string;
  scope: MemoryScope;
  nodeType: WorkMemoryNodeType;
  /** 该图投影对应的权威记录 ID。 */
  recordId: string;
  label: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt?: number;
}

/** L0 evidence 是 provenance 端点，不是 active memory 投影。 */
export interface EvidenceGraphNode extends WorkMemoryGraphNodeBase {
  nodeType: "evidence";
  evidenceKind: "chunk" | "observation" | "document" | "message" | "resource";
}

export interface MemoryNode extends WorkMemoryGraphNodeBase {
  nodeType: "memory";
  semanticType?: MemorySemanticType;
  lifecycleStatus: MemoryLifecycleStatus;
  evidenceChunkIds: string[];
}

/** 权威树 SummaryNode 的投影，不是第二份摘要事实源。 */
export interface SummaryGraphNode extends WorkMemoryGraphNodeBase {
  nodeType: "summary";
  treeType: "source" | "topic" | "global";
  level: number;
  evidenceChunkIds: string[];
}

/** lifecycle/skill-candidate-types.SkillCandidate 的投影。 */
export interface SkillCandidateGraphNode extends WorkMemoryGraphNodeBase {
  nodeType: "skill_candidate";
  status: SkillCandidateStatus;
  evidenceMemoryIds: string[];
  evidenceChunkIds: string[];
}

export type WorkMemoryGraphNode =
  | EvidenceGraphNode
  | MemoryNode
  | SummaryGraphNode
  | SkillCandidateGraphNode;

export interface WorkMemoryEdge {
  id: string;
  scope: MemoryScope;
  edgeType: "memory_relation";
  predicate: WorkMemoryEdgePredicate;
  sourceId: string;
  targetId: string;
  confidence: number;
  /** 包括 lifecycle 边在内的所有派生关系都必须携带 L0 证据链。 */
  evidenceChunkIds: string[];
  reason?: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt?: number;
}

export interface WorkMemoryGraphBatch {
  scope: MemoryScope;
  nodes: readonly WorkMemoryGraphNode[];
  edges: readonly WorkMemoryEdge[];
}

export interface WorkMemoryNodeFilter {
  scope: MemoryScope;
  nodeType?: WorkMemoryNodeType;
  recordId?: string;
  query?: string;
  limit?: number;
}

export interface WorkMemoryEdgeFilter {
  scope: MemoryScope;
  nodeId?: string;
  predicate?: WorkMemoryEdgePredicate;
  limit?: number;
}

export interface WorkMemoryGraphRepository {
  upsertWorkMemoryGraph(batch: WorkMemoryGraphBatch): Promise<void>;
  getWorkMemoryNode(id: string, scope: MemoryScope): Promise<WorkMemoryGraphNode | undefined>;
  getWorkMemoryEdge(id: string, scope: MemoryScope): Promise<WorkMemoryEdge | undefined>;
  findWorkMemoryNodes(filter: WorkMemoryNodeFilter): Promise<WorkMemoryGraphNode[]>;
  findWorkMemoryEdges(filter: WorkMemoryEdgeFilter): Promise<WorkMemoryEdge[]>;
}
