import { createHash } from "node:crypto";

import type { WorkMemoryEdge, WorkMemoryGraphBatch, SummaryGraphNode } from "../graph/work-memory-types.js";
import {
  validateWorkMemoryNode,
  workMemoryNodeLabel,
  workMemoryScopeKey,
} from "../graph/work-memory-validation.js";
import type { TreeSummaryNode } from "./types.js";

const SAFE_ID = /^[^\s\p{Cc}]{1,256}$/u;

function invalid(message: string): Error {
  return new Error(`Invalid Work Memory summary projection: ${message}`);
}

function endpointIds(summary: TreeSummaryNode): readonly string[] {
  const recordIds = summary.level === 1 ? summary.leafIds : summary.childNodeIds;
  if (recordIds.length === 0 || new Set(recordIds).size !== recordIds.length ||
      recordIds.some((id) => !SAFE_ID.test(id))) throw invalid("derivation endpoint is missing or invalid");
  const prefix = summary.level === 1 ? "memory" : "summary";
  return Object.freeze(recordIds.map((id) => `${prefix}:${id}`).sort());
}

function edgeId(summary: TreeSummaryNode, sourceId: string, targetId: string): string {
  const digest = createHash("sha256").update(JSON.stringify([
    "mengshu.work-memory-summary-derives-from/v1",
    workMemoryScopeKey(summary.scope),
    sourceId,
    targetId,
  ])).digest("hex");
  return `derives-from:${digest}`;
}

export function buildWorkMemorySummaryProjection(summary: TreeSummaryNode): WorkMemoryGraphBatch {
  if (!summary || typeof summary !== "object" || summary.status !== "sealed") {
    throw invalid("summary must be sealed");
  }
  if (!SAFE_ID.test(summary.id) || !Number.isSafeInteger(summary.level) ||
      summary.level < 1 || summary.level > 3) throw invalid("summary identity or level is invalid");
  if (!Array.isArray(summary.evidenceChunkIds) || summary.evidenceChunkIds.length === 0 ||
      new Set(summary.evidenceChunkIds).size !== summary.evidenceChunkIds.length ||
      summary.evidenceChunkIds.some((id) => !SAFE_ID.test(id))) throw invalid("summary evidence is invalid");
  const sealedAt = summary.sealedAt;
  if (!Number.isSafeInteger(summary.createdAt) || summary.createdAt < 0 ||
      !Number.isSafeInteger(sealedAt) || sealedAt === undefined || sealedAt < summary.createdAt) {
    throw invalid("summary timestamps are invalid");
  }
  const targets = endpointIds(summary);
  const sourceId = `summary:${summary.id}`;
  const node: SummaryGraphNode = Object.freeze({
    id: sourceId,
    scope: summary.scope,
    nodeType: "summary",
    recordId: summary.id,
    label: workMemoryNodeLabel(summary.title),
    treeType: summary.treeType,
    level: summary.level,
    evidenceChunkIds: Object.freeze([...summary.evidenceChunkIds]) as unknown as string[],
    metadata: Object.freeze({ treeKey: summary.treeKey, sealedAt }),
    createdAt: summary.createdAt,
  });
  validateWorkMemoryNode(node, summary.scope);
  const edges: readonly WorkMemoryEdge[] = Object.freeze(targets.map((targetId) => Object.freeze({
    id: edgeId(summary, sourceId, targetId),
    scope: summary.scope,
    edgeType: "memory_relation" as const,
    predicate: "derives_from" as const,
    sourceId,
    targetId,
    confidence: 1,
    evidenceChunkIds: Object.freeze([...summary.evidenceChunkIds]) as unknown as string[],
    metadata: Object.freeze({}),
    createdAt: sealedAt,
  })));
  return Object.freeze({
    scope: summary.scope,
    nodes: Object.freeze([node]),
    edges,
  });
}
