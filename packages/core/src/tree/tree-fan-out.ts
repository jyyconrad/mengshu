/**
 * D-03 source/topic/global tree fan-out。
 *
 * plan 阶段是无副作用纯函数；execute 阶段按 target 幂等，使 durable job
 * 在部分失败后可安全 replay。
 */

import { createHash } from "node:crypto";
import type { MemoryScope, MemorySemanticType } from "../domain/types.js";
import type { JobHandler } from "../runtime/jobs.js";
import { appendLeafToBuffer, type SealPolicy } from "./buffer.js";
import { dayKey } from "./global.js";
import {
  routeLeaf,
  type LeafRoutingDecision,
  type LeafRoutingInput,
} from "./leaf-routing.js";
import { sealBuffer } from "./seal.js";
import type {
  MemoryTreeType,
  TreeLeaf,
  TreeRepository,
} from "./types.js";

export type TreeFanOutRoutingInput = Omit<
  LeafRoutingInput,
  "hasTopicLabel" | "semanticType" | "scopeVisibility" | "riskFlags"
> & {
  semanticType: MemorySemanticType;
  scopeVisibility: NonNullable<LeafRoutingInput["scopeVisibility"]>;
  riskFlags: string[];
  /** D-18/D-21 topic labels. Entity ids are evidence, never topic tree keys. */
  topicLabels?: readonly string[];
  /** Upstream hotness lifecycle has admitted creation/use of these topic trees. */
  topicHotnessEligible: boolean;
  /** Upstream publication policy can explicitly deny global fan-out. Defaults to allowed. */
  globalHotnessEligible?: boolean;
};

export interface TreeFanOutInput {
  scope: MemoryScope;
  leaf: TreeLeaf;
  routing: TreeFanOutRoutingInput;
  /** normalized label -> canonical label，用于 D-21 增量收敛。 */
  topicAliases?: Readonly<Record<string, string>>;
}

export interface TreeFanOutTarget {
  treeType: MemoryTreeType;
  treeKey: string;
  idempotencyKey: string;
}

export interface TreeFanOutPlan {
  admitted: boolean;
  decision: LeafRoutingDecision;
  targets: TreeFanOutTarget[];
  evidenceChunkIds: string[];
}

export interface TreeFanOutTargetResult extends TreeFanOutTarget {
  status: "applied" | "replayed";
  sealed: boolean;
  bufferId?: string;
  nodeId?: string;
  evidenceChunkIds: string[];
}

export interface TreeFanOutResult {
  plan: TreeFanOutPlan;
  targets: TreeFanOutTargetResult[];
}

export interface TreeFanOutHandlerDeps {
  repository: TreeRepository;
  policy?: SealPolicy;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function assertTreeLeaf(leaf: TreeLeaf): void {
  if (!Array.isArray(leaf.entityIds) || leaf.entityIds.some((id) => !nonEmpty(id))) {
    throw new Error("Tree fan-out leaf entityIds are invalid");
  }
  if (!Number.isSafeInteger(leaf.eventAt) || leaf.eventAt < 0 ||
      !Number.isSafeInteger(leaf.createdAt) || leaf.createdAt < 0) {
    throw new Error("Tree fan-out leaf timestamps are invalid");
  }
  if (leaf.tokenCount !== undefined &&
      (!Number.isSafeInteger(leaf.tokenCount) || leaf.tokenCount < 0)) {
    throw new Error("Tree fan-out leaf tokenCount is invalid");
  }
}

function assertFiniteScore(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Tree fan-out ${name} must be between 0 and 1`);
  }
}

const SEMANTIC_TYPES = new Set<MemorySemanticType>([
  "profile", "task_context", "rules", "experience", "resource",
]);
const SCOPE_VISIBILITIES = new Set<NonNullable<LeafRoutingInput["scopeVisibility"]>>([
  "session", "project", "workspace", "app", "user", "global",
]);
function assertRoutingContext(routing: TreeFanOutRoutingInput): void {
  if (!SEMANTIC_TYPES.has(routing.semanticType) ||
      !SCOPE_VISIBILITIES.has(routing.scopeVisibility) ||
      !Array.isArray(routing.riskFlags) ||
      routing.riskFlags.some((flag) => !nonEmpty(flag))) {
    throw new Error("Tree fan-out routing context is incomplete");
  }
  if (routing.isWorkspaceRule &&
      (routing.semanticType !== "rules" || routing.scopeVisibility !== "workspace")) {
    throw new Error("Tree fan-out workspace rule context is inconsistent");
  }
}

function sameScope(left: MemoryScope, right: MemoryScope): boolean {
  return left.tenantId === right.tenantId && left.appId === right.appId &&
    left.userId === right.userId && left.projectId === right.projectId &&
    left.agentId === right.agentId && left.namespace === right.namespace &&
    left.workspaceId === right.workspaceId && left.sessionId === right.sessionId &&
    left.visibility === right.visibility;
}

function assertScope(scope: MemoryScope): void {
  const dimensions = [
    scope.tenantId, scope.appId, scope.userId, scope.projectId,
    scope.agentId, scope.namespace,
  ];
  if (dimensions.some((dimension) => !nonEmpty(dimension)) ||
      (scope.workspaceId !== undefined && !nonEmpty(scope.workspaceId)) ||
      (scope.sessionId !== undefined && !nonEmpty(scope.sessionId)) ||
      (scope.visibility !== undefined &&
        !new Set(["private", "workspace", "team", "public"]).has(scope.visibility))) {
    throw new Error("Tree fan-out scope is invalid");
  }
}

function leafFingerprint(leaf: TreeLeaf): string {
  return createHash("sha256").update(JSON.stringify([
    "mengshu.tree-leaf/v1",
    leaf.id,
    leaf.chunkId,
    leaf.sourceId,
    [...leaf.entityIds].sort(),
    leaf.importance,
    leaf.eventAt,
    leaf.createdAt,
    leaf.text ?? "",
    leaf.tokenCount ?? null,
  ])).digest("hex");
}

/** D-18 normalization, capped at the specified 80 code units. */
export function normalizeTopicLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[`"'“”‘’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function canonicalTopicLabels(input: TreeFanOutInput): string[] {
  const labels = input.routing.topicLabels ?? [];
  if (!Array.isArray(labels) || labels.some((label) => typeof label !== "string")) {
    throw new Error("Tree fan-out topic labels are invalid");
  }
  const normalized = labels.map((label) => normalizeTopicLabel(label));
  if (normalized.some((label) => label.length === 0)) {
    throw new Error("Tree fan-out topic label is invalid after normalization");
  }
  const canonical = normalized.map((label) => {
    const alias = input.topicAliases?.[label];
    if (alias === undefined) return label;
    const resolved = normalizeTopicLabel(alias);
    if (!resolved) throw new Error("Tree fan-out topic alias is invalid after normalization");
    return resolved;
  });
  return Array.from(new Set(canonical)).sort();
}

function targetIdempotencyKey(
  scope: MemoryScope,
  leafId: string,
  treeType: MemoryTreeType,
  treeKey: string,
): string {
  const digest = createHash("sha256").update(JSON.stringify([
    "mengshu.tree-fan-out/v1",
    scope.tenantId,
    scope.appId,
    scope.userId,
    scope.projectId,
    scope.agentId,
    scope.namespace,
    scope.workspaceId ?? "",
    scope.sessionId ?? "",
    scope.visibility ?? "",
    leafId,
    treeType,
    treeKey,
  ])).digest("hex");
  return `tree-fan-out:${digest}`;
}

function target(
  input: TreeFanOutInput,
  treeType: MemoryTreeType,
  treeKey: string,
): TreeFanOutTarget {
  if (!nonEmpty(treeKey)) throw new Error(`Tree fan-out ${treeType} tree key is required`);
  return {
    treeType,
    treeKey,
    idempotencyKey: targetIdempotencyKey(input.scope, input.leaf.id, treeType, treeKey),
  };
}

/** Produce the complete deterministic fan-out plan before any repository write. */
export function planTreeFanOut(input: TreeFanOutInput): TreeFanOutPlan {
  if (!input || !input.leaf || !input.routing || !input.scope) {
    throw new Error("Tree fan-out input is required");
  }
  if (!nonEmpty(input.leaf.id)) throw new Error("Tree fan-out leaf id is required");
  if (!nonEmpty(input.leaf.chunkId)) {
    throw new Error("Tree fan-out evidence chunkId is required");
  }
  if (!nonEmpty(input.leaf.sourceId)) throw new Error("Tree fan-out sourceId is required");
  assertTreeLeaf(input.leaf);
  assertScope(input.scope);
  if (!sameScope(input.scope, input.leaf.scope)) {
    throw new Error("Tree fan-out leaf scope does not match request scope");
  }
  assertFiniteScore("valueScore", input.routing.valueScore);
  assertFiniteScore("importance", input.routing.importance);
  assertRoutingContext(input.routing);
  if (typeof input.routing.topicHotnessEligible !== "boolean") {
    throw new Error("Tree fan-out topic hotness eligibility is required");
  }
  if (input.leaf.importance !== input.routing.importance) {
    throw new Error("Tree fan-out leaf importance does not match routing importance");
  }

  const topicLabels = canonicalTopicLabels(input);
  if (input.routing.riskFlags.includes("prompt_injection")) {
    return {
      admitted: false,
      decision: {
        admitted: false,
        treeTypes: [],
        reason: "prompt_injection evidence is not eligible for tree routing",
      },
      targets: [],
      evidenceChunkIds: [input.leaf.chunkId],
    };
  }
  const routed = routeLeaf({
    ...input.routing,
    hasTopicLabel: topicLabels.length > 0 && input.routing.topicHotnessEligible,
  });
  const decision = input.routing.globalHotnessEligible === false &&
      routed.treeTypes.includes("global")
    ? { ...routed, treeTypes: routed.treeTypes.filter((treeType) => treeType !== "global") }
    : routed;
  const targets: TreeFanOutTarget[] = [];
  if (decision.treeTypes.includes("source")) {
    targets.push(target(input, "source", input.leaf.sourceId));
  }
  if (decision.treeTypes.includes("topic")) {
    for (const topicLabel of topicLabels) {
      targets.push(target(input, "topic", topicLabel));
    }
  }
  if (decision.treeTypes.includes("global")) {
    targets.push(target(input, "global", dayKey(input.leaf.eventAt)));
  }
  return {
    admitted: decision.admitted,
    decision,
    targets,
    evidenceChunkIds: [input.leaf.chunkId],
  };
}

async function findSealedReplay(
  repository: TreeRepository,
  input: TreeFanOutInput,
  currentTarget: TreeFanOutTarget,
): Promise<TreeFanOutTargetResult | undefined> {
  const nodes = await repository.listSummaries({
    scope: input.scope,
    treeType: currentTarget.treeType,
    treeKey: currentTarget.treeKey,
  });
  const node = nodes.find((candidate) => candidate.leafIds.includes(input.leaf.id));
  if (!node) return undefined;
  return {
    ...currentTarget,
    status: "replayed",
    sealed: true,
    nodeId: node.id,
    evidenceChunkIds: [...node.evidenceChunkIds],
  };
}

/** Execute a fan-out plan. A retry converges after any previously completed target. */
export async function executeTreeFanOut(
  repository: TreeRepository,
  input: TreeFanOutInput,
  policy?: SealPolicy,
): Promise<TreeFanOutResult> {
  const plan = planTreeFanOut(input);
  const existingLeaf = await repository.getLeaf(input.leaf.id);
  if (existingLeaf && (!sameScope(existingLeaf.scope, input.scope) ||
      leafFingerprint(existingLeaf) !== leafFingerprint(input.leaf))) {
    throw new Error("Tree fan-out leaf fingerprint conflict");
  }
  const results: TreeFanOutTargetResult[] = [];
  for (const currentTarget of plan.targets) {
    const sealedReplay = await findSealedReplay(repository, input, currentTarget);
    if (sealedReplay) {
      results.push(sealedReplay);
      continue;
    }
    const { buffer, shouldSeal, appended } = await appendLeafToBuffer(repository, {
      scope: input.scope,
      treeType: currentTarget.treeType,
      treeKey: currentTarget.treeKey,
      leaf: input.leaf,
      now: input.leaf.createdAt,
    }, policy);
    if (!shouldSeal) {
      results.push({
        ...currentTarget,
        status: appended ? "applied" : "replayed",
        sealed: false,
        bufferId: buffer.id,
        evidenceChunkIds: [...plan.evidenceChunkIds],
      });
      continue;
    }
    const node = await sealBuffer(repository, { buffer, now: input.leaf.createdAt });
    results.push({
      ...currentTarget,
      status: appended ? "applied" : "replayed",
      sealed: true,
      nodeId: node.id,
      evidenceChunkIds: [...node.evidenceChunkIds],
    });
  }
  return { plan, targets: results };
}

/** Additive worker adapter. Production composition can register it after F0 write material exists. */
export function createTreeFanOutHandler(deps: TreeFanOutHandlerDeps): JobHandler {
  return async (job) => {
    if (job.type !== "build_tree") {
      throw new Error("Tree fan-out handler requires a build_tree job");
    }
    const result = await executeTreeFanOut(
      deps.repository,
      job.payload as unknown as TreeFanOutInput,
      deps.policy,
    );
    return {
      admitted: result.plan.admitted,
      targetCount: result.targets.length,
      evidenceChunkIds: result.plan.evidenceChunkIds,
      targets: result.targets,
    };
  };
}
