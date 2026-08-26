/**
 * F0 active memory 派生边界。
 *
 * 本模块只把 provider 已确认提交的 active WriteMemoryRecord 投影为原生
 * Work Memory Graph batch 与 D-03 tree fan-out plan；不写库、不入队，也不从
 * metadata 推断 routing facts。
 */

import { createHash } from "node:crypto";

import type {
  MemoryScope,
  MemorySemanticType,
} from "../domain/types.js";
import type { WriteMemoryRecord } from "../service/write-kernel.js";
import {
  planTreeFanOut,
  type TreeFanOutInput,
  type TreeFanOutPlan,
  type TreeFanOutRoutingInput,
} from "../tree/tree-fan-out.js";
import type { TreeLeaf } from "../tree/types.js";
import type {
  EvidenceGraphNode,
  MemoryNode,
  WorkMemoryEdge,
  WorkMemoryGraphBatch,
  WorkMemoryGraphNode,
} from "./work-memory-types.js";
import {
  validateWorkMemoryEdge,
  validateWorkMemoryNode,
  workMemoryNodeLabel,
  workMemoryScopeKey,
} from "./work-memory-validation.js";

type ContentWriteRecord = Extract<WriteMemoryRecord, { mutation: "content" }>;

export type ActiveMemoryEvidenceKind = EvidenceGraphNode["evidenceKind"];

/** Evidence details come from an authoritative evidence read, never memory metadata. */
export interface ActiveMemoryEvidenceFact {
  readonly evidenceId: string;
  readonly scope: MemoryScope;
  readonly evidenceKind: ActiveMemoryEvidenceKind;
  readonly label: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
}

/** Complete, upstream-computed facts needed to route one active memory. */
export interface ActiveMemoryTreeFacts {
  readonly memoryId: string;
  readonly scope: MemoryScope;
  /** Selects a real evidence id declared by the active memory as this tree leaf's L0 source. */
  readonly evidenceId: string;
  readonly sourceId: string;
  readonly entityIds: readonly string[];
  readonly scopeVisibility: TreeFanOutRoutingInput["scopeVisibility"];
  readonly riskFlags: readonly string[];
  readonly topicLabels: readonly string[];
  readonly topicHotnessEligible: boolean;
  readonly explicitGlobal?: boolean;
  readonly isWorkspaceRule?: boolean;
}

export type ActiveMemoryGraphUnavailableReason =
  | "evidence_ids_missing"
  | "evidence_ids_invalid"
  | "evidence_fact_missing"
  | "evidence_scope_mismatch"
  | "evidence_fact_invalid"
  | "graph_contract_invalid";

export type ActiveMemoryTreeUnavailableReason =
  | "semantic_type_missing"
  | "importance_missing"
  | "value_score_invalid"
  | "tree_facts_missing"
  | "tree_scope_mismatch"
  | "tree_evidence_mismatch"
  | "tree_routing_incomplete"
  | "tree_routing_invalid";

export type ActiveMemoryGraphProjection =
  | {
      readonly status: "available";
      readonly batch: WorkMemoryGraphBatch;
    }
  | {
      readonly status: "unavailable";
      readonly reason: ActiveMemoryGraphUnavailableReason;
    };

export type ActiveMemoryTreeProjection =
  | {
      readonly status: "available";
      readonly input: TreeFanOutInput;
      readonly plan: TreeFanOutPlan;
    }
  | {
      readonly status: "unavailable";
      readonly reason: ActiveMemoryTreeUnavailableReason;
    };

export interface ActiveMemoryProjection {
  readonly memoryId: string;
  readonly graph: ActiveMemoryGraphProjection;
  readonly tree: ActiveMemoryTreeProjection;
}

export interface ActiveMemoryDerivationInput {
  readonly records: readonly WriteMemoryRecord[];
  /** Provider-owned effect receipt. This is the persisted-active authority. */
  readonly activeMemoryIds: readonly string[];
  readonly evidenceFacts: readonly ActiveMemoryEvidenceFact[];
  readonly treeFacts: readonly ActiveMemoryTreeFacts[];
}

export interface ActiveMemoryDerivationResult {
  readonly projections: readonly ActiveMemoryProjection[];
}

export class ActiveMemoryDerivationError extends Error {
  readonly code = "ACTIVE_MEMORY_DERIVATION_INVALID" as const;

  constructor() {
    super("Active memory derivation input is invalid or ambiguous");
    this.name = "ActiveMemoryDerivationError";
  }
}

const SAFE_ID = /^[^\s\p{Cc}]{1,256}$/u;
const SAFE_TEXT = /[^\s]/u;
const SEMANTIC_TYPES = new Set<MemorySemanticType>([
  "profile", "task_context", "rules", "experience", "resource",
]);
const EVIDENCE_KINDS = new Set<ActiveMemoryEvidenceKind>([
  "chunk", "observation", "document", "message", "resource",
]);
const SCOPE_VISIBILITIES = new Set<TreeFanOutRoutingInput["scopeVisibility"]>([
  "session", "project", "workspace", "app", "user", "global",
]);
const MEMORY_VISIBILITIES = new Set(["private", "workspace", "team", "public"]);

function invalid(): never {
  throw new ActiveMemoryDerivationError();
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && SAFE_TEXT.test(value) && value.trim() === value;
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

function safeScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function scopeSnapshot(scope: MemoryScope): MemoryScope {
  if (!scope || typeof scope !== "object") invalid();
  const required = [
    scope.tenantId,
    scope.appId,
    scope.userId,
    scope.projectId,
    scope.agentId,
    scope.namespace,
  ];
  if (required.some((value) => !nonEmpty(value)) ||
      (scope.workspaceId !== undefined && !nonEmpty(scope.workspaceId)) ||
      (scope.sessionId !== undefined && !nonEmpty(scope.sessionId)) ||
      (scope.visibility !== undefined && !MEMORY_VISIBILITIES.has(scope.visibility))) {
    invalid();
  }
  return Object.freeze({
    tenantId: scope.tenantId,
    appId: scope.appId,
    userId: scope.userId,
    projectId: scope.projectId,
    agentId: scope.agentId,
    namespace: scope.namespace,
    ...(scope.workspaceId === undefined ? {} : { workspaceId: scope.workspaceId }),
    ...(scope.sessionId === undefined ? {} : { sessionId: scope.sessionId }),
    ...(scope.visibility === undefined ? {} : { visibility: scope.visibility }),
  });
}

function sameScope(left: MemoryScope, right: MemoryScope): boolean {
  return left.tenantId === right.tenantId && left.appId === right.appId &&
    left.userId === right.userId && left.projectId === right.projectId &&
    left.agentId === right.agentId && left.namespace === right.namespace &&
    left.workspaceId === right.workspaceId && left.sessionId === right.sessionId &&
    left.visibility === right.visibility;
}

function isValidScope(value: unknown): value is MemoryScope {
  try {
    scopeSnapshot(value as MemoryScope);
    return true;
  } catch {
    return false;
  }
}

function jsonSnapshot(
  value: unknown,
  ancestors = new Set<object>(),
): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid();
    return value;
  }
  if (!value || typeof value !== "object" || ancestors.has(value)) invalid();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const snapshot = value.map((item) => jsonSnapshot(item, ancestors));
      return Object.freeze(snapshot);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid();
    const snapshot: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || key === "__proto__" || key === "prototype" ||
          key === "constructor") invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor) || descriptor.value === undefined) {
        invalid();
      }
      snapshot[key] = jsonSnapshot(descriptor.value, ancestors);
    }
    return Object.freeze(snapshot);
  } finally {
    ancestors.delete(value);
  }
}

function immutableArray<T>(values: readonly T[]): T[] {
  return Object.freeze([...values]) as unknown as T[];
}

function unavailableGraph(
  reason: ActiveMemoryGraphUnavailableReason,
): ActiveMemoryGraphProjection {
  return Object.freeze({ status: "unavailable", reason });
}

function unavailableTree(
  reason: ActiveMemoryTreeUnavailableReason,
): ActiveMemoryTreeProjection {
  return Object.freeze({ status: "unavailable", reason });
}

function uniqueIds(value: unknown, allowEmpty: boolean): readonly string[] | undefined {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) ||
      value.some((item) => !safeId(item)) || new Set(value).size !== value.length) {
    return undefined;
  }
  return Object.freeze([...value]) as readonly string[];
}

function graphNodeId(nodeType: "memory" | "evidence", recordId: string): string {
  return `${nodeType}:${recordId}`;
}

function groundedByEdgeId(scope: MemoryScope, memoryId: string, evidenceId: string): string {
  const digest = createHash("sha256").update(JSON.stringify([
    "mengshu.work-memory-grounded-by/v1",
    workMemoryScopeKey(scope),
    memoryId,
    evidenceId,
  ])).digest("hex");
  return `grounded-by:${digest}`;
}

function validEvidenceFact(fact: ActiveMemoryEvidenceFact): boolean {
  return Boolean(fact) && typeof fact === "object" &&
    safeId(fact.evidenceId) && isValidScope(fact.scope) &&
    EVIDENCE_KINDS.has(fact.evidenceKind) &&
    nonEmpty(fact.label) && Number.isSafeInteger(fact.createdAt) && fact.createdAt >= 0 &&
    Boolean(fact.metadata) && typeof fact.metadata === "object" && !Array.isArray(fact.metadata);
}

function buildGraphProjection(
  record: ContentWriteRecord,
  evidenceById: ReadonlyMap<string, ActiveMemoryEvidenceFact>,
): ActiveMemoryGraphProjection {
  if (record.evidenceIds.length === 0) return unavailableGraph("evidence_ids_missing");
  const evidenceIds = uniqueIds(record.evidenceIds, false);
  if (!evidenceIds) return unavailableGraph("evidence_ids_invalid");
  const facts: ActiveMemoryEvidenceFact[] = [];
  for (const evidenceId of evidenceIds) {
    const fact = evidenceById.get(evidenceId);
    if (!fact) return unavailableGraph("evidence_fact_missing");
    if (!validEvidenceFact(fact)) return unavailableGraph("evidence_fact_invalid");
    if (!sameScope(record.scope, fact.scope)) {
      return unavailableGraph("evidence_scope_mismatch");
    }
    facts.push(fact);
  }

  try {
    const graphScope = scopeSnapshot(record.scope);
    const memoryNode: MemoryNode = Object.freeze({
      id: graphNodeId("memory", record.id),
      scope: graphScope,
      nodeType: "memory",
      recordId: record.id,
      ...(record.semanticType === undefined ? {} : { semanticType: record.semanticType }),
      lifecycleStatus: "active",
      evidenceChunkIds: immutableArray(evidenceIds),
      label: workMemoryNodeLabel(record.text),
      metadata: jsonSnapshot({ kind: record.kind }) as Record<string, unknown>,
      createdAt: record.createdAt,
    });
    const evidenceNodes: EvidenceGraphNode[] = facts.map((fact) => Object.freeze({
      id: graphNodeId("evidence", fact.evidenceId),
      scope: graphScope,
      nodeType: "evidence" as const,
      recordId: fact.evidenceId,
      evidenceKind: fact.evidenceKind,
      label: workMemoryNodeLabel(fact.label),
      metadata: jsonSnapshot(fact.metadata) as Record<string, unknown>,
      createdAt: fact.createdAt,
    }));
    const nodes: WorkMemoryGraphNode[] = [memoryNode, ...evidenceNodes];
    const edges: WorkMemoryEdge[] = evidenceNodes.map((evidenceNode) => Object.freeze({
      id: groundedByEdgeId(graphScope, record.id, evidenceNode.recordId),
      scope: graphScope,
      edgeType: "memory_relation" as const,
      predicate: "grounded_by" as const,
      sourceId: memoryNode.id,
      targetId: evidenceNode.id,
      confidence: 1,
      evidenceChunkIds: immutableArray([evidenceNode.recordId]),
      metadata: Object.freeze({}),
      createdAt: record.createdAt,
    }));
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    for (const node of nodes) validateWorkMemoryNode(node, graphScope);
    for (const edge of edges) {
      validateWorkMemoryEdge(edge, graphScope, (id) => nodeById.get(id));
    }
    const batch: WorkMemoryGraphBatch = Object.freeze({
      scope: graphScope,
      nodes: immutableArray(nodes),
      edges: immutableArray(edges),
    });
    return Object.freeze({ status: "available", batch });
  } catch (error) {
    if (error instanceof ActiveMemoryDerivationError) {
      return unavailableGraph("evidence_fact_invalid");
    }
    return unavailableGraph("graph_contract_invalid");
  }
}

function completeTreeFacts(facts: ActiveMemoryTreeFacts): boolean {
  if (!safeId(facts.memoryId) || !safeId(facts.evidenceId) || !safeId(facts.sourceId) ||
      !Array.isArray(facts.entityIds) || facts.entityIds.some((id) => !safeId(id)) ||
      new Set(facts.entityIds).size !== facts.entityIds.length ||
      !SCOPE_VISIBILITIES.has(facts.scopeVisibility) ||
      !Array.isArray(facts.riskFlags) || facts.riskFlags.some((flag) => !nonEmpty(flag)) ||
      new Set(facts.riskFlags).size !== facts.riskFlags.length ||
      !Array.isArray(facts.topicLabels) || facts.topicLabels.some((label) => !nonEmpty(label)) ||
      typeof facts.topicHotnessEligible !== "boolean") {
    return false;
  }
  return (facts.explicitGlobal === undefined || typeof facts.explicitGlobal === "boolean") &&
    (facts.isWorkspaceRule === undefined || typeof facts.isWorkspaceRule === "boolean");
}

function immutableTreePlan(plan: TreeFanOutPlan): TreeFanOutPlan {
  return Object.freeze({
    admitted: plan.admitted,
    decision: Object.freeze({
      admitted: plan.decision.admitted,
      treeTypes: immutableArray(plan.decision.treeTypes),
      reason: plan.decision.reason,
    }),
    targets: immutableArray(plan.targets.map((target) => Object.freeze({ ...target }))),
    evidenceChunkIds: immutableArray(plan.evidenceChunkIds),
  });
}

function buildTreeProjection(
  record: ContentWriteRecord,
  factsByMemoryId: ReadonlyMap<string, ActiveMemoryTreeFacts>,
): ActiveMemoryTreeProjection {
  if (record.semanticType === undefined) return unavailableTree("semantic_type_missing");
  if (!safeScore(record.importance)) return unavailableTree("importance_missing");
  if (!safeScore(record.valueScore)) return unavailableTree("value_score_invalid");
  const facts = factsByMemoryId.get(record.id);
  if (!facts) return unavailableTree("tree_facts_missing");
  if (!facts.scope || !isValidScope(facts.scope)) {
    return unavailableTree("tree_routing_incomplete");
  }
  if (!sameScope(record.scope, facts.scope)) return unavailableTree("tree_scope_mismatch");
  if (!record.evidenceIds.includes(facts.evidenceId)) {
    return unavailableTree("tree_evidence_mismatch");
  }
  if (!SEMANTIC_TYPES.has(record.semanticType) || !completeTreeFacts(facts)) {
    return unavailableTree("tree_routing_incomplete");
  }

  try {
    const treeScope = scopeSnapshot(record.scope);
    const leaf: TreeLeaf = Object.freeze({
      id: record.id,
      scope: treeScope,
      chunkId: facts.evidenceId,
      sourceId: facts.sourceId,
      entityIds: immutableArray(facts.entityIds),
      importance: record.importance,
      eventAt: record.createdAt,
      createdAt: record.createdAt,
      text: record.text,
    });
    const routing: TreeFanOutRoutingInput = Object.freeze({
      valueScore: record.valueScore,
      importance: record.importance,
      semanticType: record.semanticType,
      scopeVisibility: facts.scopeVisibility,
      riskFlags: immutableArray(facts.riskFlags),
      topicLabels: immutableArray(facts.topicLabels),
      topicHotnessEligible: facts.topicHotnessEligible,
      ...(facts.explicitGlobal === undefined ? {} : { explicitGlobal: facts.explicitGlobal }),
      ...(facts.isWorkspaceRule === undefined ? {} : { isWorkspaceRule: facts.isWorkspaceRule }),
    });
    const input: TreeFanOutInput = Object.freeze({ scope: treeScope, leaf, routing });
    const plan = immutableTreePlan(planTreeFanOut(input));
    return Object.freeze({ status: "available", input, plan });
  } catch {
    return unavailableTree("tree_routing_invalid");
  }
}

function uniqueIndex<T>(
  values: readonly T[],
  idOf: (value: T) => unknown,
): ReadonlyMap<string, T> {
  if (!Array.isArray(values)) invalid();
  const result = new Map<string, T>();
  for (const value of values) {
    const id = idOf(value);
    if (!safeId(id) || result.has(id)) invalid();
    result.set(id, value);
  }
  return result;
}

/**
 * Produce immutable, side-effect-free F0 derivations for persisted active memories only.
 */
export function deriveActiveMemoryProjections(
  input: ActiveMemoryDerivationInput,
): ActiveMemoryDerivationResult {
  if (!input || typeof input !== "object" || !Array.isArray(input.records) ||
      !Array.isArray(input.activeMemoryIds) || !Array.isArray(input.evidenceFacts) ||
      !Array.isArray(input.treeFacts)) invalid();
  const recordsById = uniqueIndex(input.records, (record) => record?.id);
  const activeMemoryIds = uniqueIds(input.activeMemoryIds, true);
  if (!activeMemoryIds) invalid();
  const evidenceById = uniqueIndex(input.evidenceFacts, (fact) => fact?.evidenceId);
  const treeFactsByMemoryId = uniqueIndex(input.treeFacts, (facts) => facts?.memoryId);

  const projections: ActiveMemoryProjection[] = [];
  for (const memoryId of activeMemoryIds) {
    const record = recordsById.get(memoryId);
    if (!record || record.mutation !== "content" || record.route !== "active") continue;
    projections.push(Object.freeze({
      memoryId,
      graph: buildGraphProjection(record, evidenceById),
      tree: buildTreeProjection(record, treeFactsByMemoryId),
    }));
  }
  return Object.freeze({ projections: Object.freeze(projections) });
}
