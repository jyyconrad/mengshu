import { createHash } from "node:crypto";

import {
  authorityScopeFingerprint,
  canonicalAuthorityScope,
} from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../domain/types.js";
import { isGovernedTreeSummaryForAsset } from "./faithfulness.js";
import type {
  MemoryTreeType,
  SummaryFaithfulnessConfig,
  TreeSummaryNode,
} from "./types.js";

export type TreeFoldingTargetLevel = 2 | 3;
export type TreeFoldingFilteredReason = "child_not_sealed" | "faithfulness_not_passed";

export interface TreeFoldingPlanInput {
  readonly children: readonly TreeSummaryNode[];
  readonly targetLevel: TreeFoldingTargetLevel;
  readonly faithfulnessMode: SummaryFaithfulnessConfig["mode"];
}

export interface TreeFoldingChildSnapshot {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly tokenCount: number;
  readonly timeRange: Readonly<{ startAt: number; endAt: number }>;
}

export interface TreeFoldingPlan {
  readonly target: Readonly<{
    scope: MemoryScope;
    treeType: MemoryTreeType;
    treeKey: string;
    level: TreeFoldingTargetLevel;
  }>;
  /** Stable for one exact scope/tree/level and suitable as the open parent buffer identity. */
  readonly parentBufferId: string;
  /** Stable for the canonical set of child snapshots and suitable as the sealed node identity. */
  readonly parentNodeId: string;
  /** Durable enqueue/effect identity for this exact folding membership. */
  readonly dedupeKey: string;
  readonly children: readonly TreeFoldingChildSnapshot[];
  readonly childNodeIds: readonly string[];
  readonly leafIds: readonly string[];
  readonly evidenceChunkIds: readonly string[];
  readonly entityIds: readonly string[];
  readonly relationIds: readonly string[];
  readonly tokenCount: number;
  readonly timeRange: Readonly<{ startAt: number; endAt: number }>;
  readonly filtered: ReadonlyArray<{
    readonly childNodeId: string;
    readonly reason: TreeFoldingFilteredReason;
  }>;
}

export type TreeFoldingPlanErrorCode =
  | "TREE_FOLD_INPUT_INVALID"
  | "TREE_FOLD_LEVEL_INVALID"
  | "TREE_FOLD_SCOPE_MISMATCH"
  | "TREE_FOLD_TREE_MISMATCH"
  | "TREE_FOLD_CHILD_LEVEL_MISMATCH"
  | "TREE_FOLD_CHILD_CONFLICT"
  | "TREE_FOLD_NO_ELIGIBLE_CHILDREN";

export class TreeFoldingPlanError extends Error {
  constructor(readonly code: TreeFoldingPlanErrorCode) {
    super(`Tree folding plan failed: ${code}`);
    this.name = "TreeFoldingPlanError";
  }
}

const TREE_TYPES = new Set<MemoryTreeType>(["source", "topic", "global"]);
const FAITHFULNESS_MODES = new Set<SummaryFaithfulnessConfig["mode"]>([
  "off", "sampled", "high_risk", "always",
]);
const SAFE_TEXT = /^[^\s\p{Cc}][^\p{Cc}]{0,511}$/u;

function fail(code: TreeFoldingPlanErrorCode): never {
  throw new TreeFoldingPlanError(code);
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stable(child)]));
  }
  return value;
}

function digest(tag: string, value: unknown): string {
  return createHash("sha256").update(JSON.stringify([tag, stable(value)])).digest("hex");
}

function denseStrings(value: unknown, allowEmpty = true): readonly string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) ||
      value.some((item) => typeof item !== "string" || !SAFE_TEXT.test(item)) ||
      new Set(value).size !== value.length) {
    return fail("TREE_FOLD_INPUT_INVALID");
  }
  return value;
}

function safeTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validateChild(child: TreeSummaryNode): void {
  if (!child || typeof child !== "object" || !SAFE_TEXT.test(child.id) ||
      !TREE_TYPES.has(child.treeType) || !SAFE_TEXT.test(child.treeKey) ||
      !Number.isSafeInteger(child.level) || !SAFE_TEXT.test(child.title) ||
      typeof child.summary !== "string" || child.summary.trim().length === 0 ||
      !Number.isSafeInteger(child.tokenCount) || child.tokenCount < 0 ||
      !safeTime(child.createdAt) || (child.sealedAt !== undefined && !safeTime(child.sealedAt)) ||
      !child.timeRange || !safeTime(child.timeRange.startAt) || !safeTime(child.timeRange.endAt) ||
      child.timeRange.endAt < child.timeRange.startAt ||
      !child.metadata || typeof child.metadata !== "object" || Array.isArray(child.metadata)) {
    fail("TREE_FOLD_INPUT_INVALID");
  }
  denseStrings(child.childNodeIds);
  denseStrings(child.leafIds);
  denseStrings(child.evidenceChunkIds);
  denseStrings(child.entityIds);
  denseStrings(child.relationIds);
  try {
    canonicalAuthorityScope(child.scope);
  } catch {
    fail("TREE_FOLD_INPUT_INVALID");
  }
}

function childFingerprint(child: TreeSummaryNode): string {
  return digest("mengshu.tree-fold-child/v1", {
    id: child.id,
    scope: canonicalAuthorityScope(child.scope),
    treeType: child.treeType,
    treeKey: child.treeKey,
    level: child.level,
    title: child.title,
    summary: child.summary,
    childNodeIds: [...child.childNodeIds].sort(),
    leafIds: [...child.leafIds].sort(),
    evidenceChunkIds: [...child.evidenceChunkIds].sort(),
    entityIds: [...child.entityIds].sort(),
    relationIds: [...child.relationIds].sort(),
    tokenCount: child.tokenCount,
    timeRange: child.timeRange,
    status: child.status,
    createdAt: child.createdAt,
    sealedAt: child.sealedAt ?? null,
    metadata: child.metadata,
  });
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort());
}

function scopeSnapshot(scope: MemoryScope): MemoryScope {
  const canonical = canonicalAuthorityScope(scope);
  return Object.freeze({
    tenantId: canonical.tenantId,
    userId: canonical.userId,
    appId: canonical.appId,
    projectId: canonical.projectId,
    agentId: canonical.agentId,
    namespace: canonical.namespace,
    visibility: canonical.visibility,
    ...(canonical.workspaceId ? { workspaceId: canonical.workspaceId } : {}),
    ...(canonical.sessionId ? { sessionId: canonical.sessionId } : {}),
  });
}

/**
 * Plans one deterministic L1->L2 or L2->L3 fold without reading or writing a repository.
 * Callers persist the returned plan through a fenced durable effect.
 */
export function planTreeFolding(input: TreeFoldingPlanInput): TreeFoldingPlan {
  if (!input || typeof input !== "object" || !Array.isArray(input.children) ||
      input.children.length === 0 || !FAITHFULNESS_MODES.has(input.faithfulnessMode)) {
    fail("TREE_FOLD_INPUT_INVALID");
  }
  if (input.targetLevel !== 2 && input.targetLevel !== 3) fail("TREE_FOLD_LEVEL_INVALID");

  for (const child of input.children) validateChild(child);
  const first = input.children[0]!;
  const scopeFingerprint = authorityScopeFingerprint(first.scope);
  const childLevel = input.targetLevel - 1;
  for (const child of input.children) {
    if (authorityScopeFingerprint(child.scope) !== scopeFingerprint) fail("TREE_FOLD_SCOPE_MISMATCH");
    if (child.treeType !== first.treeType || child.treeKey !== first.treeKey) {
      fail("TREE_FOLD_TREE_MISMATCH");
    }
    if (child.level !== childLevel) fail("TREE_FOLD_CHILD_LEVEL_MISMATCH");
  }

  const byId = new Map<string, { child: TreeSummaryNode; fingerprint: string }>();
  for (const child of input.children) {
    const fingerprint = childFingerprint(child);
    const previous = byId.get(child.id);
    if (previous && previous.fingerprint !== fingerprint) fail("TREE_FOLD_CHILD_CONFLICT");
    if (!previous) byId.set(child.id, { child, fingerprint });
  }
  const canonicalChildren = [...byId.values()]
    .sort((left, right) => left.child.id.localeCompare(right.child.id));
  const filtered: Array<{ childNodeId: string; reason: TreeFoldingFilteredReason }> = [];
  const eligible = canonicalChildren.filter(({ child }) => {
    if (child.status !== "sealed") {
      filtered.push({ childNodeId: child.id, reason: "child_not_sealed" });
      return false;
    }
    if (!isGovernedTreeSummaryForAsset(child, input.faithfulnessMode)) {
      filtered.push({ childNodeId: child.id, reason: "faithfulness_not_passed" });
      return false;
    }
    return true;
  });
  if (eligible.length === 0) fail("TREE_FOLD_NO_ELIGIBLE_CHILDREN");

  const target = Object.freeze({
    scope: scopeSnapshot(first.scope),
    treeType: first.treeType,
    treeKey: first.treeKey,
    level: input.targetLevel,
  });
  const targetIdentity = {
    scopeFingerprint,
    treeType: target.treeType,
    treeKey: target.treeKey,
    level: target.level,
  };
  const membership = eligible.map(({ child, fingerprint }) => ({ id: child.id, fingerprint }));
  const parentBufferId = `fold-buffer:${digest("mengshu.tree-fold-buffer/v1", targetIdentity)}`;
  const parentNodeId = `fold-node:${digest("mengshu.tree-fold-node/v1", { targetIdentity, membership })}`;
  const dedupeKey = `tree-fold:${digest("mengshu.tree-fold-effect/v1", { targetIdentity, membership })}`;
  const tokenCount = eligible.reduce((sum, { child }) => sum + child.tokenCount, 0);
  if (!Number.isSafeInteger(tokenCount)) fail("TREE_FOLD_INPUT_INVALID");

  return Object.freeze({
    target,
    parentBufferId,
    parentNodeId,
    dedupeKey,
    children: Object.freeze(eligible.map(({ child }) => Object.freeze({
      id: child.id,
      title: child.title,
      summary: child.summary,
      tokenCount: child.tokenCount,
      timeRange: Object.freeze({ ...child.timeRange }),
    }))),
    childNodeIds: Object.freeze(eligible.map(({ child }) => child.id)),
    leafIds: uniqueSorted(eligible.flatMap(({ child }) => child.leafIds)),
    evidenceChunkIds: uniqueSorted(eligible.flatMap(({ child }) => child.evidenceChunkIds)),
    entityIds: uniqueSorted(eligible.flatMap(({ child }) => child.entityIds)),
    relationIds: uniqueSorted(eligible.flatMap(({ child }) => child.relationIds)),
    tokenCount,
    timeRange: Object.freeze({
      startAt: Math.min(...eligible.map(({ child }) => child.timeRange.startAt)),
      endAt: Math.max(...eligible.map(({ child }) => child.timeRange.endAt)),
    }),
    filtered: Object.freeze(filtered),
  });
}
