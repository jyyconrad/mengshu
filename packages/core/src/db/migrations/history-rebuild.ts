import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import { kindToSemanticType } from "../../domain/semantic-type-mapper.js";
import type {
  MemoryKind,
  MemoryLifecycleStatus,
  MemoryScope,
  MemorySemanticType,
} from "../../domain/types.js";
import { normalizeTopicLabel } from "../../tree/tree-fan-out.js";

export const HISTORY_REBUILD_MODEL_CONFIDENCE_THRESHOLD = 0.85;

export type HistoryRebuildDisposition =
  | "preserve"
  | "backfill"
  | "model_classify"
  | "lookup_only"
  | "quarantine";

export interface HistoryRebuildScanRow {
  readonly sourceTable: "memories" | "knowledge";
  readonly recordId: string;
  /** Operator-owned hash of the frozen source row. */
  readonly sourceHash: string;
  readonly text: string;
  readonly kind: MemoryKind;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly scope: MemoryScope;
  readonly lifecycleStatus?: MemoryLifecycleStatus;
  readonly contentHash?: string;
  readonly vector?: readonly number[];
  readonly importance?: number;
  readonly valueScore?: number;
  readonly confidence?: number;
  readonly category?: string;
  readonly dataType?: string;
  readonly createdAt?: number;
  readonly embeddingSpaceId?: string | null;
  readonly embeddingSpaceState?: string | null;
  /** True only when the frozen row contains enough material for an archived L0 evidence mirror. */
  readonly canCreateEvidenceMirror?: boolean;
  readonly evidenceIds?: readonly string[];
  readonly topicLabels?: readonly string[];
  readonly classificationConflict?: boolean;
  readonly scopeConflict?: boolean;
  readonly legacyQuarantineReason?: string | null;
}

/** The model proposes classification only; it cannot decide governance or persistence. */
export interface HistoryRebuildModelClassification {
  readonly recordId: string;
  readonly sourceHash: string;
  readonly semanticType: MemorySemanticType;
  readonly topicLabels: readonly string[];
  readonly confidence: number;
}

export interface HistoryRebuildTreeEligibility {
  readonly source: boolean;
  readonly topic: boolean;
  readonly global: boolean;
}

export type HistoryRebuildReason =
  | "valid_explicit_semantic_type"
  | "deterministic_kind_mapping"
  | "model_classification_required"
  | "model_classification_accepted"
  | "model_confidence_below_threshold"
  | "model_attempts_exhausted"
  | "invalid_model_classification"
  | "invalid_source_row"
  | "invalid_explicit_semantic_type"
  | "classification_conflict"
  | "scope_conflict"
  | "legacy_quarantine"
  | "knowledge_resource_only"
  | "prior_history_lookup_only"
  | "invalid_prior_history_lookup_only";

export interface HistoryRebuildPlan {
  readonly sourceTable: "memories" | "knowledge";
  readonly recordId: string;
  readonly sourceHash: string;
  readonly disposition: HistoryRebuildDisposition;
  readonly semanticType?: MemorySemanticType;
  readonly topicLabels: readonly string[];
  readonly contextEligible: boolean;
  readonly treeEligibility: HistoryRebuildTreeEligibility;
  readonly reason: HistoryRebuildReason;
  readonly modelConfidence?: number;
  readonly receiptHash: string;
}

export interface HistoryRebuildSummary {
  readonly total: number;
  readonly preserve: number;
  readonly backfill: number;
  readonly modelClassify: number;
  readonly lookupOnly: number;
  readonly quarantine: number;
  readonly classified: number;
  readonly contextEligible: number;
  readonly sourceTreeEligible: number;
  readonly topicTreeEligible: number;
  readonly receiptHash: string;
}

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[^\s\p{Cc}]{1,256}$/u;
const SEMANTIC_TYPES = new Set<MemorySemanticType>([
  "profile", "task_context", "rules", "experience", "resource",
]);
const MEMORY_KINDS = new Set<MemoryKind>([
  "preference", "decision", "entity", "fact", "task", "plan", "goal",
  "document", "knowledge", "observation", "other",
]);
const LIFECYCLE = new Set<MemoryLifecycleStatus>([
  "active", "archived", "revoked", "superseded", "promoted",
]);
const VISIBILITIES = new Set(["private", "workspace", "team", "public"]);
const MODEL_KEYS = Object.freeze([
  "confidence", "recordId", "semanticType", "sourceHash", "topicLabels",
] as const);
const MAX_TOPIC_LABELS = 16;
const MAX_RAW_TOPIC_LENGTH = 256;

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownData(record: Readonly<Record<string, unknown>>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor?.enumerable === true && "value" in descriptor ? descriptor.value : undefined;
}

function invalidOwnField(record: Readonly<Record<string, unknown>>, key: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && (!descriptor.enumerable || !("value" in descriptor));
}

function exactOwnDataKeys(record: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(record);
  if (keys.some((key) => typeof key !== "string") || keys.length !== expected.length) return false;
  const sorted = [...keys as string[]].sort();
  if (sorted.some((key, index) => key !== expected[index])) return false;
  return sorted.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor?.enumerable === true && "value" in descriptor;
  });
}

function validSemanticType(value: unknown): value is MemorySemanticType {
  return typeof value === "string" && SEMANTIC_TYPES.has(value as MemorySemanticType);
}

function validScope(value: unknown): value is MemoryScope {
  if (!plainRecord(value)) return false;
  for (const key of ["tenantId", "userId", "appId", "projectId", "agentId", "namespace"]) {
    const field = ownData(value, key);
    if (typeof field !== "string" || field.trim().length === 0 || field !== field.trim()) return false;
  }
  const visibility = ownData(value, "visibility");
  if (visibility !== undefined &&
      (typeof visibility !== "string" || !VISIBILITIES.has(visibility))) return false;
  for (const key of ["workspaceId", "sessionId"]) {
    const field = ownData(value, key);
    if (field !== undefined &&
        (typeof field !== "string" || field.trim().length === 0 || field !== field.trim())) return false;
  }
  return true;
}

function denseStringArray(value: unknown, allowEmpty: boolean): readonly string[] | undefined {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) || (!allowEmpty && value.length === 0)) {
    return undefined;
  }
  if (Reflect.ownKeys(value).length !== value.length + 1) return undefined;
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor) || typeof descriptor.value !== "string") {
      return undefined;
    }
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function canonicalTopics(value: unknown): readonly string[] | undefined {
  const labels = denseStringArray(value, true);
  if (!labels || labels.length > MAX_TOPIC_LABELS) return undefined;
  const normalized: string[] = [];
  for (const label of labels) {
    if (label.length === 0 || label.length > MAX_RAW_TOPIC_LENGTH) return undefined;
    const canonical = normalizeTopicLabel(label);
    if (canonical.length === 0) return undefined;
    normalized.push(canonical);
  }
  return Object.freeze([...new Set(normalized)].sort());
}

function explicitSemanticType(metadata: Readonly<Record<string, unknown>>): {
  readonly state: "absent" | "valid" | "legacy" | "invalid";
  readonly value?: MemorySemanticType;
} {
  if (invalidOwnField(metadata, "semanticType") || invalidOwnField(metadata, "governance")) {
    return { state: "invalid" };
  }
  const top = ownData(metadata, "semanticType");
  const governance = ownData(metadata, "governance");
  if (governance !== undefined && !plainRecord(governance)) return { state: "invalid" };
  if (plainRecord(governance) && invalidOwnField(governance, "native")) {
    return { state: "invalid" };
  }
  const native = plainRecord(governance) ? ownData(governance, "native") : undefined;
  if (native !== undefined && !plainRecord(native)) return { state: "invalid" };
  if (plainRecord(native) && invalidOwnField(native, "semanticType")) {
    return { state: "invalid" };
  }
  const nested = plainRecord(native) ? ownData(native, "semanticType") : undefined;
  const topPresent = top !== undefined && top !== null;
  const nestedPresent = nested !== undefined && nested !== null;
  if ((topPresent && typeof top !== "string") ||
      (nestedPresent && typeof nested !== "string") ||
      (topPresent && nestedPresent && top !== nested)) {
    return { state: "invalid" };
  }
  const resolved = validSemanticType(top) ? top : validSemanticType(nested) ? nested : undefined;
  if (resolved !== undefined) return { state: "valid", value: resolved };
  return topPresent || nestedPresent ? { state: "legacy" } : { state: "absent" };
}

function priorHistoryLookupOnly(
  metadata: Readonly<Record<string, unknown>>,
): "absent" | "valid" | "invalid" {
  const admissionRoute = ownData(metadata, "admissionRoute");
  const contextEligible = ownData(metadata, "contextEligible");
  if (admissionRoute === "active" && contextEligible === true) return "absent";

  const rawHistoryRebuild = ownData(metadata, "historyRebuild");
  const historyRebuild = plainRecord(rawHistoryRebuild) ? rawHistoryRebuild : undefined;
  const disposition = historyRebuild === undefined
    ? undefined : ownData(historyRebuild, "disposition");
  if (admissionRoute !== "lookup_only" && disposition !== "lookup_only") return "absent";

  if (["admissionRoute", "contextEligible", "memoryContainer", "historyRebuild", "governance"]
    .some((key) => invalidOwnField(metadata, key)) ||
      admissionRoute !== "lookup_only" || contextEligible !== false ||
      ownData(metadata, "memoryContainer") !== "session_candidate" ||
      historyRebuild === undefined ||
      ["runId", "sourceHash", "disposition", "planReceiptHash"]
        .some((key) => invalidOwnField(historyRebuild, key)) ||
      typeof ownData(historyRebuild, "runId") !== "string" ||
      !SAFE_ID.test(ownData(historyRebuild, "runId") as string) ||
      typeof ownData(historyRebuild, "sourceHash") !== "string" ||
      !SHA256.test(ownData(historyRebuild, "sourceHash") as string) ||
      disposition !== "lookup_only" ||
      typeof ownData(historyRebuild, "planReceiptHash") !== "string" ||
      !SHA256.test(ownData(historyRebuild, "planReceiptHash") as string)) {
    return "invalid";
  }

  const rawGovernance = ownData(metadata, "governance");
  const governance = plainRecord(rawGovernance) ? rawGovernance : undefined;
  if (governance === undefined || invalidOwnField(governance, "native")) return "invalid";
  const rawNative = ownData(governance, "native");
  const native = plainRecord(rawNative) ? rawNative : undefined;
  return native !== undefined && !invalidOwnField(native, "container") &&
    ownData(native, "container") === "session_candidate" ? "valid" : "invalid";
}

function validSource(row: HistoryRebuildScanRow): boolean {
  if (!plainRecord(row) || (row.sourceTable !== "memories" && row.sourceTable !== "knowledge") ||
      typeof row.recordId !== "string" || !SAFE_ID.test(row.recordId) ||
      typeof row.sourceHash !== "string" || !SHA256.test(row.sourceHash) ||
      typeof row.text !== "string" || row.text.trim().length === 0 ||
      typeof row.kind !== "string" || !MEMORY_KINDS.has(row.kind as MemoryKind) ||
      !plainRecord(row.metadata) || !validScope(row.scope) ||
      (row.lifecycleStatus !== undefined && !LIFECYCLE.has(row.lifecycleStatus)) ||
      (row.classificationConflict !== undefined && typeof row.classificationConflict !== "boolean") ||
      (row.scopeConflict !== undefined && typeof row.scopeConflict !== "boolean") ||
      (row.legacyQuarantineReason !== undefined && row.legacyQuarantineReason !== null &&
        (typeof row.legacyQuarantineReason !== "string" || row.legacyQuarantineReason.length === 0)) ||
      (row.canCreateEvidenceMirror !== undefined &&
        typeof row.canCreateEvidenceMirror !== "boolean") ||
      (row.valueScore !== undefined &&
        (typeof row.valueScore !== "number" || !Number.isFinite(row.valueScore) ||
          row.valueScore < 0 || row.valueScore > 1)) ||
      (row.importance !== undefined &&
        (typeof row.importance !== "number" || !Number.isFinite(row.importance) ||
          row.importance < 0 || row.importance > 1))) {
    return false;
  }
  if (row.evidenceIds !== undefined) {
    const evidence = denseStringArray(row.evidenceIds, true);
    if (!evidence || evidence.some((id) => !SAFE_ID.test(id))) return false;
  }
  return row.topicLabels === undefined || canonicalTopics(row.topicLabels) !== undefined;
}

function parseModelClassification(value: unknown): HistoryRebuildModelClassification | undefined {
  if (!plainRecord(value) || !exactOwnDataKeys(value, MODEL_KEYS)) return undefined;
  const recordId = ownData(value, "recordId");
  const sourceHash = ownData(value, "sourceHash");
  const semanticType = ownData(value, "semanticType");
  const topicLabels = ownData(value, "topicLabels");
  const confidence = ownData(value, "confidence");
  if (typeof recordId !== "string" || !SAFE_ID.test(recordId) ||
      typeof sourceHash !== "string" || !SHA256.test(sourceHash) ||
      !validSemanticType(semanticType) || canonicalTopics(topicLabels) === undefined ||
      typeof confidence !== "number" || !Number.isFinite(confidence) ||
      confidence < 0 || confidence > 1) {
    return undefined;
  }
  return Object.freeze({
    recordId,
    sourceHash,
    semanticType,
    topicLabels: canonicalTopics(topicLabels)!,
    confidence,
  });
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : '"invalid-number"';
  if (value === undefined) return '"undefined"';
  if (!value || typeof value !== "object" || ancestors.has(value) || nodeUtilTypes.isProxy(value)) {
    return '"invalid-object"';
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        items.push(descriptor && "value" in descriptor
          ? canonicalJson(descriptor.value, ancestors)
          : '"invalid-item"');
      }
      return `[${items.join(",")}]`;
    }
    const record = value as Readonly<Record<string, unknown>>;
    const fields: string[] = [];
    for (const key of Reflect.ownKeys(record).filter((key): key is string => typeof key === "string").sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      fields.push(`${JSON.stringify(key)}:${descriptor && "value" in descriptor
        ? canonicalJson(descriptor.value, ancestors)
        : '"invalid-accessor"'}`);
    }
    return `{${fields.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function receiptHash(input: Readonly<Record<string, unknown>>): string {
  return createHash("sha256")
    .update("mengshu.history-rebuild-receipt/v1\0")
    .update(canonicalJson(input))
    .digest("hex");
}

function eligibility(
  row: HistoryRebuildScanRow,
  contextEligible: boolean,
  semanticType: MemorySemanticType,
  topicLabels: readonly string[],
): HistoryRebuildTreeEligibility {
  const evidenceIds = denseStringArray(row.evidenceIds ?? [], true) ?? [];
  const hasEvidence = evidenceIds.length > 0 || row.canCreateEvidenceMirror === true;
  const valueScore = row.valueScore ?? 0.70;
  const importance = row.importance ?? 0.70;
  const source = contextEligible && hasEvidence && valueScore >= 0.55;
  return Object.freeze({
    source,
    topic: source && valueScore >= 0.70 && importance >= 0.55 &&
      semanticType !== "profile" && topicLabels.length > 0,
    // Historical classification cannot establish an explicit global publication decision.
    global: false,
  });
}

function makePlan(
  row: HistoryRebuildScanRow,
  fields: Omit<HistoryRebuildPlan, "sourceTable" | "recordId" | "sourceHash" | "receiptHash">,
): HistoryRebuildPlan {
  const topics = Object.freeze([...fields.topicLabels]);
  const base = Object.freeze({
    sourceTable: row.sourceTable,
    recordId: row.recordId,
    sourceHash: row.sourceHash,
    ...fields,
    topicLabels: topics,
    treeEligibility: Object.freeze({ ...fields.treeEligibility }),
  });
  return Object.freeze({
    ...base,
    receiptHash: receiptHash({
      version: 1,
      source: {
        sourceTable: row.sourceTable,
        recordId: row.recordId,
        sourceHash: row.sourceHash,
        kind: row.kind,
        metadata: row.metadata,
        scope: row.scope,
        lifecycleStatus: row.lifecycleStatus,
        evidenceIds: [...(row.evidenceIds ?? [])].sort(),
        canCreateEvidenceMirror: row.canCreateEvidenceMirror,
        valueScore: row.valueScore,
        importance: row.importance,
      },
      result: base,
    }),
  });
}

function isolatedPlan(
  row: HistoryRebuildScanRow,
  disposition: "lookup_only" | "quarantine",
  reason: HistoryRebuildReason,
  modelConfidence?: number,
): HistoryRebuildPlan {
  return makePlan(row, {
    disposition,
    semanticType: undefined,
    topicLabels: Object.freeze([]),
    contextEligible: false,
    treeEligibility: Object.freeze({ source: false, topic: false, global: false }),
    reason,
    ...(modelConfidence === undefined ? {} : { modelConfidence }),
  });
}

export function planHistoryRebuild(
  row: HistoryRebuildScanRow,
  rawModelClassification?: unknown,
): HistoryRebuildPlan {
  if (!validSource(row)) return isolatedPlan(row, "quarantine", "invalid_source_row");
  if (row.scopeConflict === true) return isolatedPlan(row, "quarantine", "scope_conflict");
  if (row.classificationConflict === true) {
    return isolatedPlan(row, "quarantine", "classification_conflict");
  }
  if (row.legacyQuarantineReason) return isolatedPlan(row, "quarantine", "legacy_quarantine");

  if (row.sourceTable === "knowledge") {
    return makePlan(row, {
      disposition: "preserve",
      semanticType: "resource",
      topicLabels: Object.freeze([]),
      contextEligible: false,
      treeEligibility: Object.freeze({ source: false, topic: false, global: false }),
      reason: "knowledge_resource_only",
    });
  }

  const active = row.lifecycleStatus === undefined || row.lifecycleStatus === "active";
  if (active) {
    const priorLookupOnly = priorHistoryLookupOnly(row.metadata);
    if (priorLookupOnly === "invalid") {
      return isolatedPlan(row, "quarantine", "invalid_prior_history_lookup_only");
    }
    if (priorLookupOnly === "valid") {
      return isolatedPlan(row, "lookup_only", "prior_history_lookup_only");
    }
  }

  const explicit = explicitSemanticType(row.metadata);
  if (explicit.state === "invalid") {
    return isolatedPlan(row, "quarantine", "invalid_explicit_semantic_type");
  }
  const existingTopics = canonicalTopics(row.topicLabels ?? [])!;
  if (explicit.state === "valid") {
    const contextEligible = active;
    return makePlan(row, {
      disposition: "preserve",
      semanticType: explicit.value!,
      topicLabels: existingTopics,
      contextEligible,
      treeEligibility: eligibility(row, contextEligible, explicit.value!, existingTopics),
      reason: "valid_explicit_semantic_type",
    });
  }

  const mapped = kindToSemanticType(row.kind);
  if (mapped.confidence === "high" && mapped.semanticType !== null) {
    const contextEligible = active;
    return makePlan(row, {
      disposition: "backfill",
      semanticType: mapped.semanticType,
      topicLabels: existingTopics,
      contextEligible,
      treeEligibility: eligibility(row, contextEligible, mapped.semanticType, existingTopics),
      reason: "deterministic_kind_mapping",
    });
  }

  if (rawModelClassification === undefined) {
    return makePlan(row, {
      disposition: "model_classify",
      semanticType: undefined,
      topicLabels: Object.freeze([]),
      contextEligible: false,
      treeEligibility: Object.freeze({ source: false, topic: false, global: false }),
      reason: "model_classification_required",
    });
  }
  const model = parseModelClassification(rawModelClassification);
  if (!model || model.recordId !== row.recordId || model.sourceHash !== row.sourceHash) {
    return isolatedPlan(row, "quarantine", "invalid_model_classification");
  }
  if (model.confidence < HISTORY_REBUILD_MODEL_CONFIDENCE_THRESHOLD) {
    return isolatedPlan(
      row,
      "lookup_only",
      "model_confidence_below_threshold",
      model.confidence,
    );
  }
  const contextEligible = active;
  return makePlan(row, {
    disposition: "model_classify",
    semanticType: model.semanticType,
    topicLabels: model.topicLabels,
    contextEligible,
    treeEligibility: eligibility(row, contextEligible, model.semanticType, model.topicLabels),
    reason: "model_classification_accepted",
    modelConfidence: model.confidence,
  });
}

/** Fail-closed fallback after every durable model attempt identity is exhausted. */
export function planHistoryRebuildExhaustedModelAttempts(
  row: HistoryRebuildScanRow,
): HistoryRebuildPlan {
  const deterministic = planHistoryRebuild(row);
  return deterministic.reason === "model_classification_required"
    ? isolatedPlan(row, "lookup_only", "model_attempts_exhausted")
    : deterministic;
}

export function summarizeHistoryRebuildPlans(
  plans: readonly HistoryRebuildPlan[],
): HistoryRebuildSummary {
  const counts = {
    preserve: 0,
    backfill: 0,
    modelClassify: 0,
    lookupOnly: 0,
    quarantine: 0,
  };
  let classified = 0;
  let contextEligible = 0;
  let sourceTreeEligible = 0;
  let topicTreeEligible = 0;
  for (const plan of plans) {
    switch (plan.disposition) {
      case "preserve": counts.preserve += 1; break;
      case "backfill": counts.backfill += 1; break;
      case "model_classify": counts.modelClassify += 1; break;
      case "lookup_only": counts.lookupOnly += 1; break;
      case "quarantine": counts.quarantine += 1; break;
    }
    if (plan.semanticType !== undefined) classified += 1;
    if (plan.contextEligible) contextEligible += 1;
    if (plan.treeEligibility.source) sourceTreeEligible += 1;
    if (plan.treeEligibility.topic) topicTreeEligible += 1;
  }
  const conserved = counts.preserve + counts.backfill + counts.modelClassify +
    counts.lookupOnly + counts.quarantine;
  if (conserved !== plans.length) throw new Error("history rebuild funnel is not conserved");
  return Object.freeze({
    total: plans.length,
    ...counts,
    classified,
    contextEligible,
    sourceTreeEligible,
    topicTreeEligible,
    receiptHash: receiptHash({
      version: 1,
      counts: { total: plans.length, ...counts },
      receipts: plans.map((plan) => plan.receiptHash).sort(),
    }),
  });
}
