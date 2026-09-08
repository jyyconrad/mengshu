import type {
  CaseResult,
  EvalExecutionMetadata,
  EvalMetricDirection,
  EvalMetricResult,
  GoldenCase,
  ProductionRuntimeStage,
  ProductionStageEvidence,
  ProductionTreeReceipt,
  SuiteSummary,
} from "./types.js";
import type {
  MemoryKind,
  MemorySemanticType,
} from "../../../packages/core/src/domain/types.js";
import type { MemoryTreeType } from "../../../packages/core/src/tree/types.js";
import {
  isRecallScoreBreakdown,
  type CompleteRecallScoreBreakdown,
} from
  "../../../packages/core/src/domain/recall-scoring.js";

export const REQUIRED_PRODUCTION_STAGES: readonly ProductionRuntimeStage[] = Object.freeze([
  "write_observe",
  "candidate",
  "graph",
  "tree",
  "context_recall",
]);

const MEMORY_KINDS = new Set<MemoryKind>([
  "preference", "decision", "entity", "fact", "task", "plan", "goal",
  "document", "knowledge", "observation", "other",
]);
const SEMANTIC_TYPES = [
  "profile", "task_context", "rules", "experience", "resource",
] as const;
const TREE_TYPES = ["source", "topic", "global"] as const;

function isMemorySemanticType(value: unknown): value is MemorySemanticType {
  return typeof value === "string" &&
    (SEMANTIC_TYPES as readonly string[]).includes(value);
}

function isMemoryTreeType(value: unknown): value is MemoryTreeType {
  return typeof value === "string" &&
    (TREE_TYPES as readonly string[]).includes(value);
}

export interface MetricInput {
  name: string;
  numerator: number;
  denominator: number;
  direction: EvalMetricDirection;
  threshold: number;
}

/** buildReport 消费的最小 manifest gate 契约。 */
export interface SuiteGateContract {
  kind: "baseline" | "extension";
  metrics?: unknown;
  gate?: unknown;
}

export interface SuiteGateEvaluation {
  passed: boolean;
  failures: string[];
}

export const METRIC_DIRECTIONS: Readonly<Record<string, EvalMetricDirection>> = Object.freeze({
  case_pass_rate: "min",
  slot_recall: "min",
  wrong_injection: "exact",
  latency: "max",
  sensitive_blocked: "exact",
  must_escape: "exact",
  type_precision: "min",
  extraction_precision: "min",
  type_recall: "min",
  extraction_recall: "min",
  over_capture: "max",
  duplicate_precision: "min",
  false_merge: "max",
  breakdown_output_rate: "exact",
  conflict_recall: "min",
  rules_false_merge: "exact",
  faithfulness: "min",
  key_fact_evidence_rate: "exact",
  skill_candidate_only: "exact",
  no_executable_skill: "exact",
});

/** slot-context component baseline 的唯一阈值真源；latency=80ms 对应本地 component SLO。 */
export const SLOT_CONTEXT_BASELINE_THRESHOLDS = Object.freeze({
  casePassRate: 0.8,
  safetyCasePassRate: 1,
  slotRecall: 0.8,
  wrongInjection: 0,
  latencyP95Ms: 80,
  sensitiveBlocked: 1,
  mustEscape: 1,
});

export function isKnownEvalMetricName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(METRIC_DIRECTIONS, name);
}

const OFFLINE_EXECUTION: EvalExecutionMetadata = {
  runMode: "offline-component",
  provider: null,
  model: null,
  prompt: null,
  version: "slot-context-v1",
  fallback: false,
  degraded: false,
};

function metricPasses(
  value: number,
  direction: EvalMetricDirection,
  threshold: number,
): boolean {
  if (direction === "min") return value >= threshold;
  if (direction === "max") return value <= threshold;
  return value === threshold;
}

/** 创建不可伪造 value 的 metric；空分母直接失败。 */
export function createMetric(input: MetricInput): EvalMetricResult {
  if (input.denominator <= 0) {
    return {
      ...input,
      value: 0,
      passed: false,
      failure: `metric '${input.name}' denominator=${input.denominator}`,
    };
  }
  const value = input.numerator / input.denominator;
  const finite = [input.numerator, input.denominator, value, input.threshold].every(
    Number.isFinite,
  );
  return {
    ...input,
    value,
    passed: finite && metricPasses(value, input.direction, input.threshold),
    ...(!finite ? { failure: `metric '${input.name}' 含非有限数值` } : {}),
  };
}

/** 返回 runner 未声明支持的 expected keys；调用方必须把它们折叠进 case failures。 */
export function findUnsupportedExpectedFields(
  expected: Record<string, unknown>,
  supported: ReadonlySet<string>,
): string[] {
  return Object.keys(expected).filter((field) => !supported.has(field));
}

function parseManifestContract(contract: SuiteGateContract): {
  declared: string[];
  gates: Record<string, number>;
  failures: string[];
} {
  const failures: string[] = [];
  if (!Array.isArray(contract.metrics) || contract.metrics.length === 0) {
    return {
      declared: [],
      gates: {},
      failures: ["manifest metrics 必须为非空数组"],
    };
  }
  const declared: string[] = [];
  for (const name of contract.metrics) {
    if (typeof name !== "string" || !isKnownEvalMetricName(name)) {
      failures.push("manifest metrics 包含未知或非法 metric");
      continue;
    }
    if (declared.includes(name)) {
      failures.push(`manifest metric '${name}' 重复声明`);
      continue;
    }
    declared.push(name);
  }

  const gates: Record<string, number> = {};
  if (contract.kind === "extension") {
    if (!contract.gate || typeof contract.gate !== "object" || Array.isArray(contract.gate)) {
      failures.push("extension manifest gate 必须为对象");
    } else {
      const gateEntries = Object.entries(contract.gate);
      for (const [name, threshold] of gateEntries) {
        if (!declared.includes(name)) {
          failures.push(`manifest gate 包含未声明 metric '${name}'`);
          continue;
        }
        if (typeof threshold !== "number" || !Number.isFinite(threshold)) {
          failures.push(`manifest gate metric '${name}' threshold 非法`);
          continue;
        }
        gates[name] = threshold;
      }
      for (const name of declared) {
        if (!(name in gates)) {
          failures.push(`extension metric '${name}' 缺少 manifest gate threshold`);
        }
      }
    }
  } else if (contract.gate !== undefined) {
    if (!contract.gate || typeof contract.gate !== "object" || Array.isArray(contract.gate)) {
      failures.push("baseline manifest gate 必须为对象");
    }
  }
  return { declared, gates, failures };
}

/**
 * 用 manifest 声明核验 runner metric。extension 完全由声明 metric 决定，
 * 不读取 passRate，因此不会回退到历史 80% 通用 gate。
 */
export function evaluateSuiteGate(
  summary: SuiteSummary,
  contract: SuiteGateContract,
): SuiteGateEvaluation {
  const failures: string[] = [];
  const metrics = summary.metrics ?? [];
  const byName = new Map(metrics.map((metric) => [metric.name, metric]));
  const parsed = parseManifestContract(contract);
  const { declared, gates } = parsed;
  failures.push(...parsed.failures);
  if (declared.length === 0 && metrics.length === 0) {
    failures.push("suite 未声明且未产出任何 metric");
  }

  const metricNames = metrics.map((metric) => metric.name);
  const duplicateNames = metricNames.filter(
    (name, index) => metricNames.indexOf(name) !== index,
  );
  for (const name of new Set(duplicateNames)) {
    failures.push(`metric '${name}' 重复产出`);
  }

  for (const name of declared) {
    if (!byName.has(name)) {
      failures.push(`manifest metric '${name}' 未产出`);
    }
  }

  if (contract.kind === "extension") {
    for (const name of metricNames) {
      if (!declared.includes(name)) {
        failures.push(`runner 产出未声明 metric '${name}'`);
      }
    }
  }

  for (const metric of metrics) {
    if (!Number.isFinite(metric.denominator) || metric.denominator <= 0) {
      failures.push(metric.failure ?? `metric '${metric.name}' denominator=${metric.denominator}`);
      continue;
    }
    const expectedValue = metric.numerator / metric.denominator;
    if (!Number.isFinite(metric.numerator) || !Number.isFinite(metric.threshold) ||
        !Number.isFinite(expectedValue) || metric.value !== expectedValue) {
      failures.push(`metric '${metric.name}' value 不是 numerator/denominator`);
      continue;
    }
    if (metric.failure) failures.push(metric.failure);

    const manifestThreshold = gates[metric.name];
    const expectedDirection = METRIC_DIRECTIONS[metric.name];
    if (!expectedDirection) {
      failures.push(`metric '${metric.name}' 缺少 direction 定义`);
      continue;
    }
    if (metric.direction !== expectedDirection) {
      failures.push(
        `metric '${metric.name}' direction=${metric.direction}，协议要求 ${expectedDirection}`,
      );
    }
    if (manifestThreshold !== undefined) {
      if (metric.threshold !== manifestThreshold) {
        failures.push(
          `metric '${metric.name}' threshold=${metric.threshold}，manifest 要求 ${manifestThreshold}`,
        );
      }
      if (!metricPasses(expectedValue, expectedDirection, manifestThreshold)) {
        failures.push(
          `metric '${metric.name}' value=${expectedValue} 未满足 ${expectedDirection} ${manifestThreshold}`,
        );
      }
    } else if (!metric.passed || metric.failure) {
      failures.push(
        metric.failure ??
          `metric '${metric.name}' value=${metric.value} 未满足 ${metric.direction} ${metric.threshold}`,
      );
    }
  }

  // 通用 quality gate：任何 suite 存在 case failure 都不得被 metric 伪绿。
  if (summary.failed > 0) {
    failures.push(`suite '${summary.suite}' 存在 ${summary.failed} 个失败 case`);
  }

  return { passed: failures.length === 0, failures };
}

function validProductionReceiptId(value: unknown): value is string {
  return typeof value === "string" && value === value.trim() && value.length > 0 &&
    value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}

function denseProductionIds(value: unknown, minimum = 1): value is string[] {
  return Array.isArray(value) && value.length >= minimum &&
    value.every(validProductionReceiptId) && new Set(value).size === value.length;
}

function receiptContains(receiptIds: readonly string[], required: readonly string[]): boolean {
  const identities = new Set(receiptIds);
  return required.every((identity) => identities.has(identity));
}

function score01(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function sameCompleteRecallBreakdowns(values: readonly unknown[]): boolean {
  if (values.length < 2 || values.some((value) => !isRecallScoreBreakdown(value))) {
    return false;
  }
  const [expected, ...remaining] = values as readonly CompleteRecallScoreBreakdown[];
  const numericKeys = [
    "relevance", "scopeFit", "importance", "confidence", "evidenceWeight", "recency",
  ] as const;
  const importanceKeys = [
    "salience_llm", "sourceAuthority", "explicitnessBonus", "typePrior",
  ] as const;
  const near = (left: number, right: number): boolean => Math.abs(left - right) <= 1e-4;
  const sameStringSet = (left: readonly string[], right: readonly string[]): boolean =>
    left.length === right.length && new Set(left).size === left.length &&
    new Set(right).size === right.length && left.every((item) => right.includes(item));
  const sameSignals = (
    left: Readonly<Record<string, number>>,
    right: Readonly<Record<string, number>>,
  ): boolean => {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return JSON.stringify(leftKeys) === JSON.stringify(rightKeys) &&
      leftKeys.every((key) => near(left[key]!, right[key]!));
  };
  const sameImportance = (
    left: CompleteRecallScoreBreakdown["importanceBreakdown"],
    right: CompleteRecallScoreBreakdown["importanceBreakdown"],
  ): boolean => left === null || right === null
    ? left === right
    : importanceKeys.every((key) => near(left[key], right[key]));

  return remaining.every((value) =>
    near(expected!.score, value.score) &&
    near(expected!.scopeFit, value.scopeFit) &&
    near(expected!.composite, value.composite) &&
    numericKeys.every((key) => near(expected!.weights[key], value.weights[key]) &&
      near(expected!.factors[key], value.factors[key]) &&
      near(expected!.contributions[key], value.contributions[key])) &&
    sameImportance(expected!.importanceBreakdown, value.importanceBreakdown) &&
    sameStringSet(expected!.matchedBy, value.matchedBy) &&
    sameSignals(expected!.sourceSignals, value.sourceSignals));
}

function validHotnessEvidence(value: unknown): boolean {
  if (!plainRecord(value)) return false;
  const expected = Math.log(Number(value.mentionCount30d) + 1) +
    0.5 * Number(value.distinctSourceCount) + Number(value.recencyDecay) +
    Number(value.graphCentrality) + 2 * Number(value.queryHits30d);
  return nonNegativeInteger(value.mentionCount30d) &&
    nonNegativeInteger(value.distinctSourceCount) && nonNegativeInteger(value.lastSeenAt) &&
    typeof value.recencyDecay === "number" && Number.isFinite(value.recencyDecay) &&
    value.recencyDecay >= 0 && typeof value.graphCentrality === "number" &&
    Number.isFinite(value.graphCentrality) && value.graphCentrality >= 0 &&
    nonNegativeInteger(value.queryHits30d) && typeof value.score === "number" &&
    Number.isFinite(value.score) && Math.abs(value.score - expected) <= 1e-9;
}

function validProductionSealedSummary(value: unknown): boolean {
  if (!plainRecord(value) || value.executed !== true ||
      !validProductionReceiptId(value.jobId) || value.effectKey !== "build_tree.persist.v1" ||
      typeof value.requestFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(value.requestFingerprint) ||
      !nonNegativeInteger(value.leaseGeneration) || Number(value.leaseGeneration) < 1 ||
      !nonNegativeInteger(value.committedAt) || !validProductionReceiptId(value.nodeId) ||
      value.treeType !== "source" || !validProductionReceiptId(value.treeKey) ||
      value.level !== 1 || value.status !== "sealed" ||
      !denseProductionIds(value.leafIds, 20) || !denseProductionIds(value.evidenceChunkIds, 20) ||
      value.summaryCount !== 1 || value.leafCount !== 20 || value.sourceBufferCount !== 0 ||
      !Array.isArray(value.leafEvidenceBindings) || value.leafEvidenceBindings.length !== 20 ||
      !plainRecord(value.effectResult)) return false;
  const leafIds = value.leafIds as string[];
  const evidenceChunkIds = value.evidenceChunkIds as string[];
  const bindings = value.leafEvidenceBindings as unknown[];
  if (bindings.some((binding) => !plainRecord(binding) ||
      !validProductionReceiptId(binding.leafId) || !leafIds.includes(binding.leafId as string) ||
      !validProductionReceiptId(binding.evidenceChunkId) ||
      !evidenceChunkIds.includes(binding.evidenceChunkId as string) ||
      binding.activeLifecycleStatus !== "active" || binding.activeAdmissionRoute !== "active" ||
      binding.evidenceLifecycleStatus !== "archived" ||
      binding.evidenceAdmissionRoute !== "evidence_only" ||
      binding.evidenceCommandType !== "importEvidence")) return false;
  const bindingRecords = bindings as ReadonlyArray<Readonly<Record<string, unknown>>>;
  if (!sameIds(bindingRecords.map((binding) => binding.leafId as string), leafIds) ||
      !sameIds(bindingRecords.map((binding) => binding.evidenceChunkId as string), evidenceChunkIds)) {
    return false;
  }
  return exactKeys(value.effectResult, [
    "leafId", "sealed", "bufferId", "nodeId", "foldedNodeIds",
  ]) &&
    validProductionReceiptId(value.effectResult.leafId) && value.effectResult.sealed === true &&
    value.effectResult.bufferId === null && value.effectResult.nodeId === value.nodeId &&
    Array.isArray(value.effectResult.foldedNodeIds) &&
    value.effectResult.foldedNodeIds.length === 0 &&
    leafIds.includes(value.effectResult.leafId as string);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function validEvidenceBindings(
  value: unknown,
  linkIds: readonly string[],
  targetIds: readonly string[],
  evidenceId: string,
): boolean {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) =>
    !plainRecord(item) || !validProductionReceiptId(item.linkId) ||
    !validProductionReceiptId(item.targetId) || item.evidenceId !== evidenceId ||
    !targetIds.includes(item.targetId as string))) return false;
  const bindingIds = value.map((item) => (item as { linkId: string }).linkId);
  return new Set(bindingIds).size === bindingIds.length && sameIds(bindingIds, linkIds);
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return plainRecord(value) && sameIds(Object.keys(value), keys);
}

const CANDIDATE_GATE_IDS = [
  "G01", "G02", "G03", "G04", "G05", "G06", "G07", "G08", "G09", "G10", "G11",
] as const;
const PENDING_DERIVATION_KEYS = [
  "memories", "graphJobs", "treeJobs", "treeBuffers", "workMemoryNodes", "workMemoryEdges",
  "evidenceLinks",
] as const;
const PENDING_VISIBILITY_KEYS = ["contextSourceIds", "lookupHitIds", "recallHitIds"] as const;
const CANDIDATE_SCOPE_KEYS = [
  "tenantId", "userId", "appId", "projectId", "agentId", "namespace", "visibility",
  "workspaceId", "sessionId",
] as const;

function validAcceptedCandidateValidationReceipt(value: unknown, evidenceId: string): boolean {
  if (!plainRecord(value) || value.version !== 1 ||
      value.policyVersion !== "candidate-validator-v1" ||
      !Number.isSafeInteger(value.candidateOrdinal) || Number(value.candidateOrdinal) < 0 ||
      typeof value.proposalHash !== "string" || !/^[0-9a-f]{64}$/.test(value.proposalHash) ||
      value.outcome !== "accepted" || !Array.isArray(value.evidenceIds) ||
      !sameIds(value.evidenceIds as string[], [evidenceId]) ||
      !Array.isArray(value.gates) || value.gates.length !== CANDIDATE_GATE_IDS.length) return false;
  return value.gates.every((gate, index) => plainRecord(gate) &&
    gate.gateId === CANDIDATE_GATE_IDS[index] &&
    (gate.status === "passed" || gate.status === "not_applicable") &&
    typeof gate.reasonCode === "string" && gate.reasonCode.length > 0 &&
    gate.policyVersion === "candidate-validator-v1");
}

function validProductionPendingCandidate(value: unknown): boolean {
  if (!plainRecord(value) || value.executed !== true ||
      !denseProductionIds(value.receiptIds) || !validProductionReceiptId(value.jobId) ||
      value.effectKey !== "extract_candidate.persist.v1" ||
      !validProductionReceiptId(value.evidenceId) || !plainRecord(value.candidate) ||
      !plainRecord(value.effectTrace) || !Array.isArray(value.proposalReceipts) ||
      value.proposalReceipts.length !== 1 || !plainRecord(value.derivationCounts) ||
      !plainRecord(value.visibility)) return false;
  const candidate = value.candidate;
  const scope = candidate.scope;
  const validationReceipt = candidate.validationReceipt;
  if (!validProductionReceiptId(candidate.candidateId) || !exactKeys(scope, CANDIDATE_SCOPE_KEYS) ||
      Object.values(scope).some((item) => !validProductionReceiptId(item)) ||
      candidate.status !== "pending" || candidate.promotedToMemoryId !== null ||
      typeof candidate.contentHash !== "string" || !/^[0-9a-f]{64}$/.test(candidate.contentHash) ||
      candidate.activeContentHash !== candidate.contentHash ||
      !Array.isArray(candidate.evidenceIds) ||
      !sameIds(candidate.evidenceIds as string[], [value.evidenceId as string]) ||
      !MEMORY_KINDS.has(candidate.memoryKind as MemoryKind) ||
      !isMemorySemanticType(candidate.semanticType) ||
      (candidate.admissionRoute !== "candidate" &&
        candidate.admissionRoute !== "candidate_low_priority") ||
      !score01(candidate.valueScore) || !score01(candidate.importance) ||
      !score01(candidate.confidence) ||
      !validAcceptedCandidateValidationReceipt(validationReceipt, value.evidenceId as string)) return false;
  const effect = value.effectTrace;
  if (effect.created !== 1 || effect.duplicateCount !== 0 ||
      effect.capacityRejectedCount !== 0 || effect.droppedCount !== 0 ||
      !Array.isArray(effect.candidateIds) ||
      !sameIds(effect.candidateIds as string[], [candidate.candidateId as string]) ||
      !Array.isArray(effect.memoryIds) || effect.memoryIds.length !== 0 ||
      !Array.isArray(effect.activeMemoryIds) || effect.activeMemoryIds.length !== 0) return false;
  const proposal = value.proposalReceipts[0];
  if (!plainRecord(proposal) || proposal.version !== 1 ||
      !plainRecord(validationReceipt) ||
      proposal.candidateOrdinal !== validationReceipt.candidateOrdinal ||
      proposal.outcome !== "accepted" ||
      JSON.stringify(proposal.validation) !== JSON.stringify(validationReceipt) ||
      !plainRecord(proposal.admission) || proposal.admission.version !== 1 ||
      proposal.admission.outcome !== "accepted" ||
      proposal.admission.route !== candidate.admissionRoute ||
      proposal.admission.valueScore !== candidate.valueScore ||
      typeof proposal.admission.reason !== "string" || proposal.admission.reason.length === 0 ||
      !plainRecord(proposal.admission.breakdown)) return false;
  const derivationCounts = value.derivationCounts;
  const visibility = value.visibility;
  if (!exactKeys(derivationCounts, PENDING_DERIVATION_KEYS) ||
      PENDING_DERIVATION_KEYS.some((key) => derivationCounts[key] !== 0) ||
      !exactKeys(visibility, PENDING_VISIBILITY_KEYS) ||
      PENDING_VISIBILITY_KEYS.some((key) =>
        !Array.isArray(visibility[key]) ||
        (visibility[key] as unknown[]).some((id: unknown) => !validProductionReceiptId(id) ||
          id === candidate.candidateId))) return false;
  return receiptContains(value.receiptIds, [
    value.jobId as string, value.effectKey as string, value.evidenceId as string,
    candidate.candidateId as string,
  ]);
}

/** Return stable reason codes for the production tree receipt contract. */
export function findProductionTreeReceiptIssues(value: unknown): string[] {
  if (!plainRecord(value)) return ["shape"];
  const receipt = value as unknown as ProductionTreeReceipt;
  const issues: string[] = [];
  if (receipt.executed !== true || !denseProductionIds(receipt.receiptIds) ||
      !validProductionReceiptId(receipt.evidenceId) ||
      !validProductionReceiptId(receipt.activeMemoryId)) issues.push("base");
  if (receipt.effectKey !== "build_tree.persist.v1" ||
      !Array.isArray(receipt.expectedTreeTypes) ||
      receipt.expectedTreeTypes.some((treeType) => !isMemoryTreeType(treeType)) ||
      new Set(receipt.expectedTreeTypes).size !== receipt.expectedTreeTypes.length ||
      !receipt.expectedTreeTypes.includes("source")) issues.push("routing");
  if (!Array.isArray(receipt.bufferBindings) || !Array.isArray(receipt.topicJobIds) ||
      !Array.isArray(receipt.topicLeafIds) || !Array.isArray(receipt.topicTreeKeys)) {
    return [...issues, "arrays"];
  }

  const expectsGlobal = receipt.expectedTreeTypes.includes("global");
  const expectsTopic = receipt.expectedTreeTypes.includes("topic");
  const globalBindings = receipt.bufferBindings.filter(({ treeType }) => treeType === "global");
  const topicBindings = receipt.bufferBindings.filter(({ treeType }) => treeType === "topic");
  if (!validProductionReceiptId(receipt.sourceJobId) ||
      !validProductionReceiptId(receipt.sourceTreeKey) ||
      receipt.sourceLeafId !== receipt.activeMemoryId) issues.push("source_identity");
  if (expectsGlobal
    ? !validProductionReceiptId(receipt.globalJobId) ||
      !validProductionReceiptId(receipt.globalLeafId) ||
      receipt.sourceJobId === receipt.globalJobId || globalBindings.length !== 1 ||
      receipt.globalLeafId !== receipt.activeMemoryId
    : receipt.globalJobId !== null || receipt.globalLeafId !== null ||
      globalBindings.length !== 0) issues.push("global_identity");
  if (expectsTopic
    ? !denseProductionIds(receipt.topicJobIds) ||
      receipt.topicLeafIds.length === 0 ||
      receipt.topicLeafIds.some((leafId) => !validProductionReceiptId(leafId)) ||
      !denseProductionIds(receipt.topicTreeKeys) ||
      receipt.topicJobIds.length !== receipt.topicLeafIds.length ||
      receipt.topicJobIds.length !== receipt.topicTreeKeys.length ||
      receipt.topicLeafIds.some((leafId) => leafId !== receipt.activeMemoryId)
    : receipt.topicJobIds.length !== 0 || receipt.topicLeafIds.length !== 0 ||
      receipt.topicTreeKeys.length !== 0 || topicBindings.length !== 0) {
    issues.push("topic_identity");
  }

  const expectedBindingCount = 1 + (expectsGlobal ? 1 : 0) +
    (expectsTopic ? receipt.topicJobIds.length : 0);
  if (receipt.bufferBindings.length !== expectedBindingCount ||
      new Set(receipt.bufferBindings.map(({ jobId }) => jobId)).size !==
        receipt.bufferBindings.length ||
      new Set(receipt.bufferBindings.map(({ bufferId }) => bufferId)).size !==
        receipt.bufferBindings.length ||
      receipt.bufferBindings.some(({ leafId, bufferId, treeKey }) =>
        leafId !== receipt.activeMemoryId || !validProductionReceiptId(bufferId) ||
        !validProductionReceiptId(treeKey))) issues.push("buffer_bindings");
  if (!receipt.bufferBindings.some(({ jobId, treeType, treeKey }) =>
    jobId === receipt.sourceJobId && treeType === "source" &&
    treeKey === receipt.sourceTreeKey)) issues.push("source_binding");
  if (expectsGlobal && !globalBindings.some(({ jobId, treeKey }) =>
    jobId === receipt.globalJobId && /^\d{4}-\d{2}-\d{2}$/.test(treeKey))) {
    issues.push("global_binding");
  }
  if (topicBindings.length !== receipt.topicJobIds.length ||
      topicBindings.some(({ jobId, treeKey }) => !receipt.topicJobIds.includes(jobId) ||
        !receipt.topicTreeKeys.includes(treeKey))) issues.push("topic_bindings");
  if (!Array.isArray(receipt.coldTopicJobIds) || receipt.coldTopicJobIds.length !== 0 ||
      !Array.isArray(receipt.coldTopicBufferIds) || receipt.coldTopicBufferIds.length !== 0) {
    issues.push("cold_topic_noop");
  }
  if (!validProductionReceiptId(receipt.hotness?.topicEntityId) ||
      receipt.hotness?.threshold !== 6 ||
      !validHotnessEvidence(receipt.hotness?.beforeRecall) ||
      !validHotnessEvidence(receipt.hotness?.afterRecall) ||
      receipt.hotness.beforeRecall.score >= receipt.hotness.threshold ||
      receipt.hotness.afterRecall.score < receipt.hotness.threshold ||
      receipt.hotness.afterRecall.queryHits30d <= receipt.hotness.beforeRecall.queryHits30d) {
    issues.push("hotness");
  }
  if (!validProductionSealedSummary(receipt.sealedSummary)) issues.push("sealed_summary");
  if (receipt.topicJobIds.some((jobId) => jobId === receipt.sourceJobId ||
      (expectsGlobal && jobId === receipt.globalJobId))) issues.push("job_identity_overlap");
  if (!sameIds(
    Array.from(new Set(receipt.bufferBindings.map(({ treeType }) => treeType))),
    receipt.expectedTreeTypes,
  )) issues.push("tree_type_bindings");

  const requiredReceiptIds = [
    receipt.effectKey,
    receipt.sourceJobId,
    receipt.sourceLeafId,
    ...(expectsGlobal
      ? [receipt.globalJobId as string, receipt.globalLeafId as string]
      : []),
    ...receipt.topicJobIds,
    ...receipt.bufferBindings.map(({ bufferId }) => bufferId),
  ];
  if (!receiptContains(receipt.receiptIds, requiredReceiptIds)) issues.push("receipt_ids");
  return issues;
}

function validProductionStage(
  stage: ProductionRuntimeStage,
  evidence: ProductionStageEvidence | undefined,
): boolean {
  const validBase = (receipt: ProductionStageEvidence[ProductionRuntimeStage]): boolean =>
    receipt?.executed === true && denseProductionIds(receipt.receiptIds) &&
    validProductionReceiptId(receipt.evidenceId) &&
    validProductionReceiptId(receipt.activeMemoryId);

  switch (stage) {
    case "write_observe": {
      const receipt = evidence?.write_observe;
      if (!receipt || !validBase(receipt)) return false;
      return validProductionReceiptId(receipt.traceId) &&
        validProductionReceiptId(receipt.storageKey) &&
        receiptContains(receipt.receiptIds, [receipt.traceId, receipt.storageKey, receipt.evidenceId]);
    }
    case "candidate": {
      const receipt = evidence?.candidate;
      if (!receipt || !validBase(receipt)) return false;
      const governance = receipt.validatorAudit;
      const dedup = receipt.dedupTrace;
      return validProductionReceiptId(receipt.jobId) &&
        receipt.effectKey === "extract_candidate.persist.v1" &&
        MEMORY_KINDS.has(receipt.memoryKind) &&
        isMemorySemanticType(receipt.semanticType) && receipt.admissionRoute === "active" &&
        receipt.lifecycleStatus === "active" && receipt.contextEligible === true &&
        score01(receipt.valueScore) && score01(receipt.importance) &&
        score01(receipt.confidence) && plainRecord(governance) &&
        governance.semanticType === receipt.semanticType && governance.admission === "active" &&
        governance.valueScore === receipt.valueScore && plainRecord(governance.confidenceBreakdown) &&
        dedup?.created === 1 && dedup.duplicateCount === 0 &&
        dedup.capacityRejectedCount === 0 && dedup.droppedCount === 0 &&
        denseProductionIds(dedup.memoryIds) && dedup.memoryIds.length === 1 &&
        Array.isArray(dedup?.candidateIds) && dedup.candidateIds.length === 0 &&
        denseProductionIds(dedup.activeMemoryIds) && dedup.activeMemoryIds.length === 1 &&
        dedup.activeMemoryIds[0] === receipt.activeMemoryId &&
        dedup.memoryIds[0] === receipt.activeMemoryId &&
        validProductionPendingCandidate(receipt.pending) &&
        receiptContains(receipt.receiptIds, [
          receipt.jobId, receipt.effectKey, receipt.evidenceId, receipt.activeMemoryId,
        ]);
    }
    case "graph": {
      const receipt = evidence?.graph;
      if (!receipt || !validBase(receipt)) return false;
      return validProductionReceiptId(receipt.jobId) &&
        receipt.effectKey === "extract_graph.persist.v1" &&
        denseProductionIds(receipt.entityIds) && denseProductionIds(receipt.relationIds) &&
        denseProductionIds(receipt.memoryEvidenceLinkIds) &&
        denseProductionIds(receipt.entityEvidenceLinkIds) &&
        denseProductionIds(receipt.relationEvidenceLinkIds) &&
        validEvidenceBindings(receipt.memoryEvidenceBindings,
          receipt.memoryEvidenceLinkIds, [receipt.activeMemoryId], receipt.evidenceId) &&
        validEvidenceBindings(receipt.entityEvidenceBindings,
          receipt.entityEvidenceLinkIds, receipt.entityIds, receipt.evidenceId) &&
        validEvidenceBindings(receipt.relationEvidenceBindings,
          receipt.relationEvidenceLinkIds, receipt.relationIds, receipt.evidenceId) &&
        denseProductionIds(receipt.workMemoryNodeIds, 2) &&
        validProductionReceiptId(receipt.workMemoryActiveNodeId) &&
        validProductionReceiptId(receipt.workMemoryEvidenceNodeId) &&
        receipt.workMemoryActiveNodeId !== receipt.workMemoryEvidenceNodeId &&
        receipt.workMemoryNodeIds.includes(receipt.workMemoryActiveNodeId) &&
        receipt.workMemoryNodeIds.includes(receipt.workMemoryEvidenceNodeId) &&
        denseProductionIds(receipt.workMemoryEdgeIds) &&
        Array.isArray(receipt.workMemoryEdgeBindings) &&
        receipt.workMemoryEdgeBindings.length === receipt.workMemoryEdgeIds.length &&
        sameIds(receipt.workMemoryEdgeBindings.map(({ edgeId }) => edgeId),
          receipt.workMemoryEdgeIds) &&
        receipt.workMemoryEdgeBindings.every(({ edgeId, predicate, sourceId, targetId,
          evidenceChunkIds }) => validProductionReceiptId(edgeId) &&
          predicate === "grounded_by" && sourceId === receipt.workMemoryActiveNodeId &&
          targetId === receipt.workMemoryEvidenceNodeId &&
          denseProductionIds(evidenceChunkIds) && evidenceChunkIds.includes(receipt.evidenceId)) &&
        receiptContains(receipt.receiptIds, [
          receipt.jobId, receipt.effectKey, receipt.evidenceId, receipt.activeMemoryId,
          ...receipt.entityIds, ...receipt.relationIds, ...receipt.memoryEvidenceLinkIds,
          ...receipt.entityEvidenceLinkIds, ...receipt.relationEvidenceLinkIds,
          ...receipt.workMemoryNodeIds, ...receipt.workMemoryEdgeIds,
        ]);
    }
    case "tree": {
      const receipt = evidence?.tree;
      return receipt !== undefined && findProductionTreeReceiptIssues(receipt).length === 0;
    }
    case "context_recall": {
      const receipt = evidence?.context_recall;
      if (!receipt || !validBase(receipt)) return false;
      if (!exactKeys(receipt.slotActiveMemoryIds, SEMANTIC_TYPES) ||
          !exactKeys(receipt.slotSourceIds, SEMANTIC_TYPES) ||
          !exactKeys(receipt.slotScoreBreakdowns, SEMANTIC_TYPES)) return false;
      const slotActiveMemoryIds = SEMANTIC_TYPES.map((semanticType) =>
        receipt.slotActiveMemoryIds[semanticType]);
      if (!denseProductionIds(slotActiveMemoryIds, SEMANTIC_TYPES.length)) return false;
      const slotsAreIsolated = SEMANTIC_TYPES.every((semanticType) => {
        const ownId = receipt.slotActiveMemoryIds[semanticType];
        const sourceIds = receipt.slotSourceIds[semanticType];
        const foreignIds = slotActiveMemoryIds.filter((id) => id !== ownId);
        return denseProductionIds(sourceIds) && sourceIds.includes(ownId) &&
          foreignIds.every((foreignId) => !sourceIds.includes(foreignId)) &&
          isRecallScoreBreakdown(receipt.slotScoreBreakdowns[semanticType]);
      });
      return denseProductionIds(receipt.contextSourceIds) &&
        denseProductionIds(receipt.lookupHitIds) && denseProductionIds(receipt.recallHitIds) &&
        receipt.contextSourceIds.includes(receipt.activeMemoryId) &&
        receipt.lookupHitIds.includes(receipt.activeMemoryId) &&
        receipt.recallHitIds.includes(receipt.activeMemoryId) &&
        sameCompleteRecallBreakdowns([
          receipt.contextScoreBreakdown,
          receipt.lookupScoreBreakdown,
          receipt.recallScoreBreakdown,
        ]) &&
        slotsAreIsolated && slotActiveMemoryIds.every((id) => receipt.contextSourceIds.includes(id)) &&
        receiptContains(receipt.receiptIds, [receipt.activeMemoryId, ...slotActiveMemoryIds]);
    }
  }
}

function linkedProductionStages(evidence: ProductionStageEvidence | undefined): boolean {
  const stages = REQUIRED_PRODUCTION_STAGES.map((stage) => evidence?.[stage]);
  if (stages.some((stage) => stage === undefined)) return false;
  return new Set(stages.map((stage) => stage!.evidenceId)).size === 1 &&
    new Set(stages.map((stage) => stage!.activeMemoryId)).size === 1;
}

export function hasValidProductionRestartReplayEvidence(
  summary: SuiteSummary,
): boolean {
  const execution = summary.execution;
  const restart = execution?.productionRestartReplayEvidence;
  const stages = execution?.productionStageEvidence;
  if (restart?.restarted !== true || !stages?.write_observe || !stages.candidate ||
      !stages.graph || !stages.tree || !stages.context_recall ||
      restart.replayedCandidateJobId !== stages.candidate.jobId ||
      !denseProductionIds(restart.effectReceiptIdsBeforeRestart, 3) ||
      !denseProductionIds(restart.effectReceiptIdsAfterRestart, 3) ||
      !denseProductionIds(restart.ledgerIdsBeforeRestart, 4) ||
      !denseProductionIds(restart.ledgerIdsAfterRestart, 4) ||
      restart.effectReceiptCountBeforeRestart !== restart.effectReceiptIdsBeforeRestart.length ||
      restart.effectReceiptCountAfterRestart !== restart.effectReceiptIdsAfterRestart.length ||
      restart.ledgerCountBeforeRestart !== restart.ledgerIdsBeforeRestart.length ||
      restart.ledgerCountAfterRestart !== restart.ledgerIdsAfterRestart.length ||
      JSON.stringify(restart.effectReceiptIdsBeforeRestart) !==
        JSON.stringify(restart.effectReceiptIdsAfterRestart) ||
      JSON.stringify(restart.ledgerIdsBeforeRestart) !==
        JSON.stringify(restart.ledgerIdsAfterRestart) ||
      !sameIds(restart.contextSourceIdsBeforeRestart, restart.contextSourceIdsAfterRestart) ||
      !sameIds(restart.lookupHitIdsBeforeRestart, restart.lookupHitIdsAfterRestart) ||
      !sameIds(restart.recallHitIdsBeforeRestart, restart.recallHitIdsAfterRestart) ||
      !restart.contextSourceIdsAfterRestart.includes(stages.context_recall.activeMemoryId) ||
      !restart.lookupHitIdsAfterRestart.includes(stages.context_recall.activeMemoryId) ||
      !restart.recallHitIdsAfterRestart.includes(stages.context_recall.activeMemoryId) ||
      !exactKeys(restart.slotSourceIdsBeforeRestart, SEMANTIC_TYPES) ||
      !exactKeys(restart.slotSourceIdsAfterRestart, SEMANTIC_TYPES) ||
      SEMANTIC_TYPES.some((semanticType) => !sameIds(
        restart.slotSourceIdsBeforeRestart[semanticType],
        restart.slotSourceIdsAfterRestart[semanticType],
      )) ||
      !sameCompleteRecallBreakdowns([
        stages.context_recall.contextScoreBreakdown,
        stages.context_recall.lookupScoreBreakdown,
        stages.context_recall.recallScoreBreakdown,
        restart.contextScoreBreakdownBeforeRestart,
        restart.lookupScoreBreakdownBeforeRestart,
        restart.recallScoreBreakdownBeforeRestart,
        restart.contextScoreBreakdownAfterRestart,
        restart.lookupScoreBreakdownAfterRestart,
        restart.recallScoreBreakdownAfterRestart,
      ]) ||
      !plainRecord(restart.pending) ||
      !stages.candidate.pending ||
      restart.pending.replayedCandidateJobId !== stages.candidate.pending.jobId ||
      JSON.stringify(restart.pending.candidateBeforeRestart) !==
        JSON.stringify(stages.candidate.pending.candidate) ||
      JSON.stringify(restart.pending.candidateAfterRestart) !==
        JSON.stringify(stages.candidate.pending.candidate) ||
      JSON.stringify(restart.pending.effectTraceBeforeRestart) !==
        JSON.stringify(stages.candidate.pending.effectTrace) ||
      JSON.stringify(restart.pending.effectTraceAfterRestart) !==
        JSON.stringify(stages.candidate.pending.effectTrace) ||
      JSON.stringify(restart.pending.proposalReceiptsBeforeRestart) !==
        JSON.stringify(stages.candidate.pending.proposalReceipts) ||
      JSON.stringify(restart.pending.proposalReceiptsAfterRestart) !==
        JSON.stringify(stages.candidate.pending.proposalReceipts) ||
      JSON.stringify(restart.pending.derivationCountsBeforeRestart) !==
        JSON.stringify(stages.candidate.pending.derivationCounts) ||
      JSON.stringify(restart.pending.derivationCountsAfterRestart) !==
        JSON.stringify(stages.candidate.pending.derivationCounts) ||
      JSON.stringify(restart.pending.visibilityBeforeRestart) !==
        JSON.stringify(stages.candidate.pending.visibility) ||
      JSON.stringify(restart.pending.visibilityAfterRestart) !==
        JSON.stringify(stages.candidate.pending.visibility) ||
      !validProductionSealedSummary(restart.sealedSummaryBeforeRestart) ||
      !validProductionSealedSummary(restart.sealedSummaryAfterRestart) ||
      JSON.stringify(restart.sealedSummaryBeforeRestart) !==
        JSON.stringify(stages.tree.sealedSummary) ||
      JSON.stringify(restart.sealedSummaryAfterRestart) !==
        JSON.stringify(stages.tree.sealedSummary) ||
      !nonNegativeInteger(restart.sealedSummaryAttemptsBeforeRestart) ||
      !nonNegativeInteger(restart.sealedSummaryAttemptsAfterRestart) ||
      restart.sealedSummaryAttemptsBeforeRestart < 1 ||
      restart.sealedSummaryAttemptsAfterRestart <=
        restart.sealedSummaryAttemptsBeforeRestart) return false;
  const topicJobIds = stages.tree.topicJobIds;
  return receiptContains(restart.effectReceiptIdsAfterRestart, [
    `${stages.candidate.jobId}:${stages.candidate.effectKey}`,
    `${stages.graph.jobId}:${stages.graph.effectKey}`,
    `${stages.tree.sourceJobId}:${stages.tree.effectKey}`,
    ...(stages.tree.globalJobId === null
      ? []
      : [`${stages.tree.globalJobId}:${stages.tree.effectKey}`]),
    ...topicJobIds.map((jobId) => `${jobId}:${stages.tree!.effectKey}`),
  ]) && receiptContains(restart.ledgerIdsAfterRestart, [
    stages.write_observe!.storageKey,
    ...stages.graph.memoryEvidenceLinkIds,
    ...stages.graph.entityEvidenceLinkIds,
    ...stages.graph.relationEvidenceLinkIds,
    ...stages.graph.workMemoryNodeIds,
    ...stages.graph.workMemoryEdgeIds,
  ]);
}

export function findMissingProductionStageEvidence(
  evidence: ProductionStageEvidence | undefined,
  requiredStages: readonly ProductionRuntimeStage[] = REQUIRED_PRODUCTION_STAGES,
): ProductionRuntimeStage[] {
  if (!linkedProductionStages(evidence)) return [...requiredStages];
  return requiredStages.filter((stage) => !validProductionStage(stage, evidence));
}

/** 只有真实宿主 E2E、无降级且五阶段 receipt 齐全才具备 production release 资格。 */
export function isProductionReleaseEligible(
  summaries: readonly SuiteSummary[],
): boolean {
  return (
    summaries.length > 0 &&
    summaries.every(
      (summary) =>
        summary.execution?.runMode === "runtime-e2e" &&
        validExecutionIdentity(summary.execution.provider, 256) &&
        validExecutionIdentity(summary.execution.model, 256) &&
        validExecutionIdentity(summary.execution.prompt, 2_048) &&
        validExecutionIdentity(summary.execution.version, 256) &&
        summary.execution.fallback === false &&
        summary.execution.degraded === false &&
        findMissingProductionStageEvidence(
          summary.execution.productionStageEvidence,
        ).length === 0 &&
        hasValidProductionRestartReplayEvidence(summary),
    )
  );
}

function validExecutionIdentity(value: string | null, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength &&
    value === value.trim() && value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
}

function countPassingByFailurePrefix(
  cases: readonly GoldenCase[],
  results: readonly CaseResult[],
  applicable: (goldenCase: GoldenCase) => boolean,
  prefix: string,
): { numerator: number; denominator: number } {
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < cases.length; i++) {
    if (!applicable(cases[i])) continue;
    denominator += 1;
    const result = results[i];
    if (result && !result.failures.some((failure) => failure.startsWith(prefix))) {
      numerator += 1;
    }
  }
  return { numerator, denominator };
}

/** 为现有 slot-context baseline 生成完整 metric 协议。 */
export function createBaselineMetrics(
  cases: readonly GoldenCase[],
  results: readonly CaseResult[],
  summary: SuiteSummary,
): EvalMetricResult[] {
  if (cases.length !== results.length || summary.total !== cases.length) {
    throw new Error("baseline cases/results/summary 数量不一致");
  }
  const total = summary.total;
  const slotApplicable = cases
    .map((goldenCase, index) => ({ goldenCase, result: results[index] }))
    .filter(({ goldenCase }) => (goldenCase.expected.requiredMemoryIds?.length ?? 0) > 0);
  const metrics: EvalMetricResult[] = [
    createMetric({
      name: "case_pass_rate",
      numerator: summary.passed,
      denominator: total,
      direction: "min",
      threshold: summary.suite.includes("safety")
        ? SLOT_CONTEXT_BASELINE_THRESHOLDS.safetyCasePassRate
        : SLOT_CONTEXT_BASELINE_THRESHOLDS.casePassRate,
    }),
    createMetric({
      name: "slot_recall",
      numerator: slotApplicable.filter(({ result }) => result?.missedRequired.length === 0).length,
      denominator: slotApplicable.length,
      direction: "min",
      threshold: SLOT_CONTEXT_BASELINE_THRESHOLDS.slotRecall,
    }),
    createMetric({
      name: "wrong_injection",
      numerator: results.filter((result) => result.injectedForbidden.length > 0).length,
      denominator: total,
      direction: "exact",
      threshold: SLOT_CONTEXT_BASELINE_THRESHOLDS.wrongInjection,
    }),
    createMetric({
      name: "latency",
      numerator: summary.latencyP95Ms,
      denominator: 1,
      direction: "max",
      threshold: SLOT_CONTEXT_BASELINE_THRESHOLDS.latencyP95Ms,
    }),
  ];

  if (summary.suite.includes("safety")) {
    const sensitive = countPassingByFailurePrefix(
      cases,
      results,
      (goldenCase) => goldenCase.expected.expectSensitiveBlocked === true,
      "sensitive_blocked:",
    );
    const escaped = countPassingByFailurePrefix(
      cases,
      results,
      (goldenCase) =>
        (goldenCase.expected.mustEscape?.length ?? 0) > 0 ||
        (goldenCase.expected.mustEscapeMaxCount?.length ?? 0) > 0,
      "must_escape:",
    );
    metrics.push(
      createMetric({
        name: "sensitive_blocked",
        ...sensitive,
        direction: "exact",
        threshold: SLOT_CONTEXT_BASELINE_THRESHOLDS.sensitiveBlocked,
      }),
      createMetric({
        name: "must_escape",
        ...escaped,
        direction: "exact",
        threshold: SLOT_CONTEXT_BASELINE_THRESHOLDS.mustEscape,
      }),
    );
  }

  return metrics;
}

export function offlineSlotContextExecution(): EvalExecutionMetadata {
  return { ...OFFLINE_EXECUTION };
}
