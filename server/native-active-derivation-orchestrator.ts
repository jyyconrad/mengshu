/**
 * F0 committed active memory 派生编排。
 *
 * 本模块只在 candidate provider effect 已提交后运行，同时消费 receipt 中的
 * activeMemoryIds 与 effect 使用的完整 WriteMemoryRecord 批次。父 job replay
 * 会重放相同的幂等 graph upsert 和 build_tree ensure，以修补提交后的部分失败；
 * candidate、lookup、evidence 均不会进入派生链。
 */

import type { MemoryScope } from "../packages/core/src/domain/types.js";
import {
  deriveActiveMemoryProjections,
  type ActiveMemoryEvidenceFact,
  type ActiveMemoryGraphUnavailableReason,
  type ActiveMemoryTreeFacts,
  type ActiveMemoryTreeUnavailableReason,
} from "../packages/core/src/graph/active-memory-derivation.js";
import type { WorkMemoryGraphBatch } from
  "../packages/core/src/graph/work-memory-types.js";
import type { WriteMemoryRecord } from
  "../packages/core/src/service/write-kernel.js";
import {
  deriveDurableJobV2DomainDedupeKey,
  isDurableJobV2SafeIdentifier,
  type DurableJobV2Scope,
} from "../packages/core/src/storage/repositories/job-v2.js";
import type {
  TreeFanOutInput,
  TreeFanOutTarget,
} from "../packages/core/src/tree/tree-fan-out.js";
import { deriveNativeAuthoritativeExtractGraphDedupeKey } from
  "./native-extract-graph-handler.js";

type ContentWriteRecord = Extract<WriteMemoryRecord, { mutation: "content" }>;

export interface NativeActiveDerivationReadInput {
  readonly memoryIds: readonly string[];
  readonly records: readonly ContentWriteRecord[];
  readonly signal: AbortSignal;
}

export interface NativeActiveTreeTargetRequest {
  readonly type: "build_tree";
  readonly scope: DurableJobV2Scope;
  /** native-build-tree-handler 所要求的精确 client dedupe key。 */
  readonly dedupeKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly target: Readonly<TreeFanOutTarget>;
}

export interface NativeActiveEntityGraphTargetRequest {
  readonly type: "extract_graph";
  readonly scope: DurableJobV2Scope;
  readonly dedupeKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly memoryId: string;
  readonly evidenceId: string;
}

export interface NativeActiveDerivationDependencies {
  /** 在 record 精确 scope 内读取权威 evidence 行。 */
  readonly readEvidenceFacts: (
    input: NativeActiveDerivationReadInput,
  ) => Promise<readonly ActiveMemoryEvidenceFact[]>;
  /** 读取上游已计算完整的 D-03/D-21 routing facts。 */
  readonly readTreeFacts: (
    input: NativeActiveDerivationReadInput,
  ) => Promise<readonly ActiveMemoryTreeFacts[]>;
  /** 对 batch 中确定性的 node/edge id 必须幂等。 */
  readonly upsertWorkMemoryGraph: (
    batch: WorkMemoryGraphBatch,
    signal: AbortSignal,
  ) => Promise<void>;
  /** 只接收 authoritative active/evidence identity，不接收正文或 LLM 结果。 */
  readonly enqueueEntityGraphTarget: (
    request: NativeActiveEntityGraphTargetRequest,
    signal: AbortSignal,
  ) => Promise<string>;
  /**
   * 必须按 dedupeKey ensure native build_tree job，不得盲目重复入队。
   * provider queue 的 scoped dedupe 约束是持久化权威。
   */
  readonly enqueueTreeTarget: (
    request: NativeActiveTreeTargetRequest,
    signal: AbortSignal,
  ) => Promise<string>;
}

export interface NativeActiveTreeTargetResult extends TreeFanOutTarget {
  readonly dedupeKey: string;
  readonly jobId: string;
}

export interface NativeActiveEntityGraphTargetResult {
  readonly evidenceId: string;
  readonly dedupeKey: string;
  readonly jobId: string;
}

export type NativeActiveEntityGraphDerivationResult =
  | {
      readonly status: "ensured";
      readonly targets: readonly NativeActiveEntityGraphTargetResult[];
    }
  | {
      readonly status: "unavailable";
      readonly reason: ActiveMemoryGraphUnavailableReason;
    };

export type NativeActiveWorkMemoryGraphDerivationResult =
  | { readonly status: "upserted" }
  | {
      readonly status: "unavailable";
      readonly reason: ActiveMemoryGraphUnavailableReason;
    };

export type NativeActiveTreeDerivationResult =
  | {
      readonly status: "ensured";
      readonly admitted: boolean;
      readonly targets: readonly NativeActiveTreeTargetResult[];
    }
  | {
      readonly status: "unavailable";
      readonly reason: ActiveMemoryTreeUnavailableReason;
    };

export interface NativeActiveMemoryDerivationResult {
  readonly memoryId: string;
  readonly entityGraph: NativeActiveEntityGraphDerivationResult;
  readonly workMemoryGraph: NativeActiveWorkMemoryGraphDerivationResult;
  readonly tree: NativeActiveTreeDerivationResult;
}

export interface NativeActiveDerivationInput {
  readonly records: readonly WriteMemoryRecord[];
  /** Provider candidate effect receipt；这是 persisted-active 的唯一权威。 */
  readonly activeMemoryIds: readonly string[];
  readonly signal: AbortSignal;
}

export interface NativeActiveDerivationResult {
  /** 同时解析为同批 route=active content record 的 receipt id。 */
  readonly activeMemoryIds: readonly string[];
  readonly derivations: readonly NativeActiveMemoryDerivationResult[];
}

export class NativeActiveDerivationOrchestrationError extends Error {
  readonly code = "ACTIVE_MEMORY_DERIVATION_ORCHESTRATION_INVALID" as const;

  constructor() {
    super("Committed active memory derivation orchestration input is invalid");
    this.name = "NativeActiveDerivationOrchestrationError";
  }
}

const VISIBILITIES = new Set<DurableJobV2Scope["visibility"]>([
  "private", "workspace", "team", "public",
]);

function invalid(): never {
  throw new NativeActiveDerivationOrchestrationError();
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error && signal.reason.name === "AbortError"
    ? signal.reason
    : new DOMException("Active memory derivation aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

function selectCommittedActiveRecords(input: NativeActiveDerivationInput): {
  readonly memoryIds: readonly string[];
  readonly records: readonly ContentWriteRecord[];
} {
  if (!input || typeof input !== "object" || !Array.isArray(input.records) ||
      !Array.isArray(input.activeMemoryIds) || !(input.signal instanceof AbortSignal)) invalid();
  const recordById = new Map<string, WriteMemoryRecord>();
  for (const record of input.records) {
    if (!record || typeof record !== "object" ||
        !isDurableJobV2SafeIdentifier(record.id) || recordById.has(record.id)) invalid();
    recordById.set(record.id, record);
  }
  if (input.activeMemoryIds.some((id) => !isDurableJobV2SafeIdentifier(id)) ||
      new Set(input.activeMemoryIds).size !== input.activeMemoryIds.length) invalid();

  const memoryIds: string[] = [];
  const records: ContentWriteRecord[] = [];
  for (const memoryId of input.activeMemoryIds) {
    const record = recordById.get(memoryId);
    if (!record || record.mutation !== "content" || record.route !== "active") continue;
    memoryIds.push(memoryId);
    records.push(record);
  }
  return Object.freeze({
    memoryIds: Object.freeze(memoryIds),
    records: Object.freeze(records),
  });
}

function queueScope(scope: MemoryScope): DurableJobV2Scope {
  if (!VISIBILITIES.has(scope.visibility as DurableJobV2Scope["visibility"])) invalid();
  return Object.freeze({
    tenantId: scope.tenantId,
    userId: scope.userId,
    appId: scope.appId,
    projectId: scope.projectId,
    agentId: scope.agentId,
    namespace: scope.namespace,
    visibility: scope.visibility as DurableJobV2Scope["visibility"],
  });
}

function buildTreeTargetRequest(
  input: TreeFanOutInput,
  target: TreeFanOutTarget,
): NativeActiveTreeTargetRequest {
  const context = Object.freeze({
    ...(input.scope.workspaceId === undefined ? {} : { workspaceId: input.scope.workspaceId }),
    ...(input.scope.sessionId === undefined ? {} : { sessionId: input.scope.sessionId }),
  });
  const dedupeKey = deriveDurableJobV2DomainDedupeKey(
    "build_tree",
    target.idempotencyKey,
    context,
  );
  const payload = Object.freeze({
    scope: Object.freeze({ ...queueScope(input.scope), ...context }),
    traceId: input.leaf.id,
    treeType: target.treeType,
    treeKey: target.treeKey,
    leaf: Object.freeze({
      id: input.leaf.id,
      chunkId: input.leaf.chunkId,
      sourceId: input.leaf.sourceId,
      entityIds: Object.freeze([...input.leaf.entityIds]),
      text: input.leaf.text,
      eventAt: input.leaf.eventAt,
    }),
    routing: Object.freeze({
      valueScore: input.routing.valueScore,
      importance: input.routing.importance,
      semanticType: input.routing.semanticType,
      scopeVisibility: input.routing.scopeVisibility,
      riskFlags: Object.freeze([...input.routing.riskFlags]),
      topicHotnessEligible: input.routing.topicHotnessEligible,
      ...(input.routing.topicLabels === undefined
        ? {}
        : { topicLabels: Object.freeze([...input.routing.topicLabels]) }),
      ...(input.routing.explicitGlobal === undefined
        ? {}
        : { explicitGlobal: input.routing.explicitGlobal }),
      ...(input.routing.isWorkspaceRule === undefined
        ? {}
        : { isWorkspaceRule: input.routing.isWorkspaceRule }),
    }),
    targetIdempotencyKey: target.idempotencyKey,
  });
  return Object.freeze({
    type: "build_tree",
    scope: queueScope(input.scope),
    dedupeKey,
    payload,
    target: Object.freeze({ ...target }),
  });
}

function buildEntityGraphTargetRequest(
  record: ContentWriteRecord,
  evidenceId: string,
): NativeActiveEntityGraphTargetRequest {
  const context = Object.freeze({
    ...(record.scope.workspaceId === undefined ? {} : { workspaceId: record.scope.workspaceId }),
    ...(record.scope.sessionId === undefined ? {} : { sessionId: record.scope.sessionId }),
  });
  const dedupeKey = deriveNativeAuthoritativeExtractGraphDedupeKey({
    graphKind: "entity",
    activeMemoryId: record.id,
    evidenceId,
    context,
  });
  return Object.freeze({
    type: "extract_graph" as const,
    scope: queueScope(record.scope),
    dedupeKey,
    payload: Object.freeze({
      scope: Object.freeze({ ...queueScope(record.scope), ...context }),
      graphKind: "entity",
      activeMemoryId: record.id,
      evidenceId,
    }),
    memoryId: record.id,
    evidenceId,
  });
}

/**
 * ensure candidate effect 已提交 active 行的全部 graph/tree 派生。
 * 任一副作用失败都会向上抛出，使父 durable job 重试并修补缺失的幂等操作。
 */
export async function orchestrateCommittedActiveMemoryDerivations(
  dependencies: NativeActiveDerivationDependencies,
  input: NativeActiveDerivationInput,
): Promise<NativeActiveDerivationResult> {
  if (!dependencies || typeof dependencies !== "object" ||
      typeof dependencies.readEvidenceFacts !== "function" ||
      typeof dependencies.readTreeFacts !== "function" ||
      typeof dependencies.upsertWorkMemoryGraph !== "function" ||
      typeof dependencies.enqueueEntityGraphTarget !== "function" ||
      typeof dependencies.enqueueTreeTarget !== "function") invalid();
  const selected = selectCommittedActiveRecords(input);
  throwIfAborted(input.signal);
  if (selected.records.length === 0) {
    return Object.freeze({
      activeMemoryIds: selected.memoryIds,
      derivations: Object.freeze([]),
    });
  }

  const readInput = Object.freeze({
    memoryIds: selected.memoryIds,
    records: selected.records,
    signal: input.signal,
  });
  const [evidenceFacts, treeFacts] = await Promise.all([
    dependencies.readEvidenceFacts(readInput),
    dependencies.readTreeFacts(readInput),
  ]);
  throwIfAborted(input.signal);
  const projection = deriveActiveMemoryProjections({
    records: selected.records,
    activeMemoryIds: selected.memoryIds,
    evidenceFacts,
    treeFacts,
  });

  const derivations: NativeActiveMemoryDerivationResult[] = [];
  const recordById = new Map(selected.records.map((record) => [record.id, record]));
  for (const item of projection.projections) {
    throwIfAborted(input.signal);
    let entityGraph: NativeActiveEntityGraphDerivationResult;
    let workMemoryGraph: NativeActiveWorkMemoryGraphDerivationResult;
    if (item.graph.status === "unavailable") {
      entityGraph = Object.freeze({ status: "unavailable", reason: item.graph.reason });
      workMemoryGraph = Object.freeze({ status: "unavailable", reason: item.graph.reason });
    } else {
      await dependencies.upsertWorkMemoryGraph(item.graph.batch, input.signal);
      throwIfAborted(input.signal);
      workMemoryGraph = Object.freeze({ status: "upserted" });
      const record = recordById.get(item.memoryId);
      if (!record) invalid();
      const targets: NativeActiveEntityGraphTargetResult[] = [];
      for (const evidenceId of record.evidenceIds) {
        throwIfAborted(input.signal);
        const request = buildEntityGraphTargetRequest(record, evidenceId);
        const jobId = await dependencies.enqueueEntityGraphTarget(request, input.signal);
        if (!isDurableJobV2SafeIdentifier(jobId)) invalid();
        targets.push(Object.freeze({ evidenceId, dedupeKey: request.dedupeKey, jobId }));
      }
      entityGraph = Object.freeze({ status: "ensured", targets: Object.freeze(targets) });
    }

    let tree: NativeActiveTreeDerivationResult;
    if (item.tree.status === "unavailable") {
      tree = Object.freeze({ status: "unavailable", reason: item.tree.reason });
    } else {
      const treeInput = item.tree.input;
      const targets: NativeActiveTreeTargetResult[] = [];
      for (const target of item.tree.plan.targets) {
        throwIfAborted(input.signal);
        const request = buildTreeTargetRequest(treeInput, target);
        const jobId = await dependencies.enqueueTreeTarget(request, input.signal);
        if (!isDurableJobV2SafeIdentifier(jobId)) invalid();
        targets.push(Object.freeze({
          ...target,
          dedupeKey: request.dedupeKey,
          jobId,
        }));
      }
      tree = Object.freeze({
        status: "ensured",
        admitted: item.tree.plan.admitted,
        targets: Object.freeze(targets),
      });
    }
    derivations.push(Object.freeze({
      memoryId: item.memoryId,
      entityGraph,
      workMemoryGraph,
      tree,
    }));
  }

  return Object.freeze({
    activeMemoryIds: selected.memoryIds,
    derivations: Object.freeze(derivations),
  });
}
