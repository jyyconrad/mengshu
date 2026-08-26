import { scopeToKey } from "../domain/scope.js";
import type { MemoryScope } from "../domain/types.js";
import type {
  WorkMemoryEdge,
  WorkMemoryGraphNode,
} from "./work-memory-types.js";

const SAFE_ID = /^[^\s\p{Cc}]{1,256}$/u;
const DERIVED_NODE_TYPES = new Set(["memory", "summary", "skill_candidate"]);
export const WORK_MEMORY_NODE_LABEL_MAX_CHARS = 1_000;

function invalid(message: string): Error {
  return new Error(`Invalid Work Memory Graph: ${message}`);
}

export function workMemoryScopeKey(scope: MemoryScope): string {
  return [
    scopeToKey(scope),
    scope.workspaceId ?? "",
    scope.sessionId ?? "",
    scope.visibility ?? "private",
  ].map(encodeURIComponent).join(":");
}

function assertId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw invalid(`${label} is invalid`);
}

function assertEvidenceIds(ids: readonly string[], label: string): void {
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    throw invalid(`${label} must contain unique evidence ids`);
  }
  for (const id of ids) assertId(id, label);
}

export function workMemoryNodeLabel(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalid("node label is required");
  }
  const characters = Array.from(value);
  return characters.length <= WORK_MEMORY_NODE_LABEL_MAX_CHARS
    ? value
    : characters.slice(0, WORK_MEMORY_NODE_LABEL_MAX_CHARS).join("");
}

function assertScope(recordScope: MemoryScope, batchScope: MemoryScope): void {
  if (workMemoryScopeKey(recordScope) !== workMemoryScopeKey(batchScope)) {
    throw invalid("node or edge scope does not match batch scope");
  }
}

export function validateWorkMemoryNode(node: WorkMemoryGraphNode, scope: MemoryScope): void {
  assertScope(node.scope, scope);
  assertId(node.id, "node id");
  assertId(node.recordId, "record id");
  if (node.label.trim().length === 0 ||
      Array.from(node.label).length > WORK_MEMORY_NODE_LABEL_MAX_CHARS) {
    throw invalid("node label must contain between 1 and 1000 characters");
  }
  if (node.nodeType === "memory" || node.nodeType === "summary") {
    assertEvidenceIds(node.evidenceChunkIds, `${node.nodeType} evidence`);
  }
  if (node.nodeType === "summary" && (!Number.isSafeInteger(node.level) || node.level < 0 || node.level > 3)) {
    throw invalid("summary level must be between 0 and 3");
  }
  if (node.nodeType === "skill_candidate") {
    assertEvidenceIds(node.evidenceMemoryIds, "skill candidate memory evidence");
    assertEvidenceIds(node.evidenceChunkIds, "skill candidate chunk evidence");
  }
}

function assertEdgeEndpoints(
  edge: WorkMemoryEdge,
  source: WorkMemoryGraphNode,
  target: WorkMemoryGraphNode,
): void {
  switch (edge.predicate) {
    case "grounded_by":
      if (!DERIVED_NODE_TYPES.has(source.nodeType) || target.nodeType !== "evidence") {
        throw invalid("grounded_by must connect a derived node to evidence");
      }
      if (!edge.evidenceChunkIds.includes(target.recordId)) {
        throw invalid("grounded_by evidence must include its target record");
      }
      return;
    case "derives_from":
      if (!DERIVED_NODE_TYPES.has(source.nodeType) ||
          (target.nodeType !== "memory" && target.nodeType !== "summary")) {
        throw invalid("derives_from endpoints are invalid");
      }
      return;
    case "contradicts":
      if (source.nodeType !== "memory" || target.nodeType !== "memory") {
        throw invalid("contradicts must connect two memory nodes");
      }
      return;
    case "supersedes":
      if (!DERIVED_NODE_TYPES.has(source.nodeType) || source.nodeType !== target.nodeType) {
        throw invalid("supersedes must connect nodes of the same governed type");
      }
      return;
    case "promoted_to":
      if (source.nodeType !== "memory" || target.nodeType !== "skill_candidate") {
        throw invalid("promoted_to must connect memory to skill_candidate");
      }
  }
}

export function validateWorkMemoryEdge(
  edge: WorkMemoryEdge,
  scope: MemoryScope,
  resolveNode: (id: string) => WorkMemoryGraphNode | undefined,
): void {
  assertScope(edge.scope, scope);
  assertId(edge.id, "edge id");
  assertId(edge.sourceId, "source id");
  assertId(edge.targetId, "target id");
  if (edge.sourceId === edge.targetId) throw invalid("self edges are not allowed");
  if (edge.edgeType !== "memory_relation") throw invalid("edge type must be memory_relation");
  if (!Number.isFinite(edge.confidence) || edge.confidence <= 0 || edge.confidence > 1) {
    throw invalid("edge confidence must be in (0, 1]");
  }
  assertEvidenceIds(edge.evidenceChunkIds, "edge evidence");
  const source = resolveNode(edge.sourceId);
  const target = resolveNode(edge.targetId);
  if (!source || !target) throw invalid("edge endpoint is missing from the bound scope");
  assertEdgeEndpoints(edge, source, target);
}
