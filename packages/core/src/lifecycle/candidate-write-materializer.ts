/**
 * 把已完成 11 闸门与 admission 的候选规格物化为 provider effect 可提交的完整记录。
 * 本模块只做事务外编排；评分、embedding 与去重实现均由 Runtime 显式注入。
 */

import type {
  AdmissionRoute,
  MemoryKind,
  MemoryScope,
} from "../domain/types.js";
import type {
  WriteDedupResult,
  WriteMemoryRecord,
} from "../service/write-kernel.js";
import type {
  CandidateFallbackReason,
  CandidateMaximumSimilarityResolution,
  ComputedCandidateSpec,
} from "./candidate-spec-computation.js";
import type { ScopeLevel } from "./candidate-validator.js";
import { candidateTreeRoutingEnvelope } from "./candidate-tree-routing.js";

export type CandidateContentWriteRecord = Extract<
  WriteMemoryRecord,
  { mutation: "content" }
>;

export interface CandidateMaterializationStepInput {
  readonly recordId: string;
  readonly spec: ComputedCandidateSpec;
  /** 已完成 legacy extractor kind -> canonical MemoryKind 映射。 */
  readonly kind: MemoryKind;
  readonly scope: MemoryScope;
  readonly route: AdmissionRoute;
  readonly valueScore: number;
  readonly vector: readonly number[];
  readonly importance?: number;
  /** 排除稳定批次 ID，避免 durable retry 把第一次提交的自身识别为重复项。 */
  readonly excludeIds: readonly string[];
  /** 当前批次中已通过去重的前序记录，用于确定性同批去重。 */
  readonly batchRecords: readonly CandidateContentWriteRecord[];
}

export interface CandidateWriteMaterializerDependencies {
  /** admission 前只读解析真实 semantic maxSimilarity；不参与物化事务。 */
  resolveMaxSimilarity?(input: {
    readonly text: string;
    readonly kind: string;
    readonly semanticType?: ComputedCandidateSpec["semanticType"];
    readonly scope: MemoryScope;
    readonly signal?: AbortSignal;
  }): Promise<CandidateMaximumSimilarityResolution | undefined>;
  embed(input: {
    readonly text: string;
    readonly recordId: string;
    readonly scope: MemoryScope;
    readonly spec: ComputedCandidateSpec;
    readonly signal?: AbortSignal;
  }): Promise<readonly number[]>;
  scoreImportance(
    input: CandidateMaterializationStepInput,
  ): Promise<number> | number;
  exactDedup(
    input: CandidateMaterializationStepInput & { readonly importance: number },
  ): Promise<WriteDedupResult> | WriteDedupResult;
  semanticDedup(
    input: CandidateMaterializationStepInput & { readonly importance: number },
  ): Promise<WriteDedupResult> | WriteDedupResult;
  /** Runtime-owned embedding-space stamp; memory persistence rejects unstamped vectors. */
  stampMetadata(
    metadata: Readonly<Record<string, unknown>>,
    context: Readonly<{
      recordId: string;
      scope: MemoryScope;
      spec: ComputedCandidateSpec;
    }>,
  ): Readonly<Record<string, unknown>>;
}

export interface CandidateWriteMaterializationInput {
  readonly specs: readonly ComputedCandidateSpec[];
  readonly scope: MemoryScope;
  readonly fallbackReason: CandidateFallbackReason | null;
  readonly traceId: string;
  readonly intent: "auto" | "remember";
  readonly createdAt: number;
  readonly createRecordId: (sourceIndex: number) => string;
}

export class CandidateWriteMaterializationError extends Error {
  readonly code = "CANDIDATE_WRITE_MATERIALIZATION_INVALID" as const;

  constructor() {
    super("Candidate write materialization failed");
    this.name = "CandidateWriteMaterializationError";
  }
}

const ROUTES = new Set<AdmissionRoute>([
  "drop",
  "candidate_low_priority",
  "candidate",
  "active",
  "lookup_only",
  "evidence_only",
]);
const MEMORY_KINDS = new Set<MemoryKind>([
  "preference",
  "decision",
  "entity",
  "fact",
  "task",
  "plan",
  "goal",
  "document",
  "knowledge",
  "observation",
  "other",
]);
const SAFE_ID = /^[^\s\p{Cc}]{1,256}$/u;

function invalid(): never {
  throw new CandidateWriteMaterializationError();
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error && reason.name === "AbortError") throw reason;
  throw new DOMException("Candidate write materialization aborted", "AbortError");
}

function score(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) invalid();
  return value;
}

function vector(value: unknown): readonly number[] {
  if (!Array.isArray(value) || value.length === 0 ||
      value.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    invalid();
  }
  return Object.freeze([...value]);
}

function jsonSnapshot(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid();
    return value;
  }
  if (!value || typeof value !== "object" || ancestors.has(value)) invalid();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (keys.length !== value.length + 1 || !keys.includes("length")) invalid();
      return Object.freeze(value.map((item) => jsonSnapshot(item, ancestors)));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid();
    const result: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || key === "__proto__" || key === "prototype" ||
          key === "constructor" || /[\u0000-\u001f\u007f-\u009f]/u.test(key)) {
        invalid();
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor) || descriptor.value === undefined) invalid();
      result[key] = jsonSnapshot(descriptor.value, ancestors);
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
}

function dedup(value: unknown): Readonly<WriteDedupResult> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const result = value as Partial<WriteDedupResult>;
  if (typeof result.duplicate !== "boolean" ||
      (result.duplicateOf !== undefined &&
        (typeof result.duplicateOf !== "string" || !SAFE_ID.test(result.duplicateOf))) ||
      (result.layer !== undefined &&
        result.layer !== "exact" && result.layer !== "lexical" && result.layer !== "semantic")) {
    invalid();
  }
  return Object.freeze({
    duplicate: result.duplicate,
    ...(result.duplicateOf === undefined ? {} : { duplicateOf: result.duplicateOf }),
    ...(result.layer === undefined ? {} : { layer: result.layer }),
  });
}

function routeOf(spec: ComputedCandidateSpec): AdmissionRoute {
  const route = spec.metadata.admission;
  if (typeof route !== "string" || !ROUTES.has(route as AdmissionRoute)) invalid();
  return route as AdmissionRoute;
}

export function resolveCandidateMemoryKind(
  spec: Pick<ComputedCandidateSpec, "kind" | "semanticType">,
): MemoryKind {
  if (MEMORY_KINDS.has(spec.kind as MemoryKind)) return spec.kind as MemoryKind;
  switch (spec.kind) {
    case "lesson":
      return "decision";
    case "milestone":
      return "task";
    case "reference":
      return "document";
    case "relation":
      return "entity";
    case "constraint":
      return "other";
  }
  switch (spec.semanticType) {
    case "profile":
      return "preference";
    case "task_context":
      return "task";
    case "experience":
      return "observation";
    case "resource":
      return "document";
    default:
      return "other";
  }
}

function candidateGovernance(
  spec: ComputedCandidateSpec,
  fallbackReason: CandidateFallbackReason | null,
  scope: MemoryScope,
  traceId: string,
  intent: "auto" | "remember",
  dedupResult?: {
    readonly kind: "exact" | "lexical" | "semantic";
    readonly duplicateOf?: string;
  },
): Readonly<Record<string, unknown>> {
  const targetScope = spec.metadata.targetScope;
  const scopeVisibility = typeof targetScope === "string" &&
      ["session", "project", "workspace", "app", "user", "global"].includes(targetScope)
    ? targetScope
    : undefined;
  const riskFlags = Array.isArray(spec.metadata.riskFlags) &&
      spec.metadata.riskFlags.every((flag) => typeof flag === "string")
    ? [...spec.metadata.riskFlags]
    : undefined;
  const treeRouting = scopeVisibility !== undefined && riskFlags !== undefined &&
      spec.semanticType !== undefined
    ? candidateTreeRoutingEnvelope({
        scope,
        semanticType: spec.semanticType,
        targetScope: scopeVisibility as ScopeLevel,
        riskFlags,
        evidenceIds: spec.evidence.eventIds,
        explicit: intent === "remember",
      })
    : undefined;
  return jsonSnapshot({
    originalKind: spec.kind,
    extractor: spec.extractor,
    reason: spec.reason,
    confidence: score(spec.confidence),
    ...spec.metadata,
    audit: spec.auditMetadata,
    ...(spec.validationReceipt === undefined
      ? {}
      : { validationReceipt: spec.validationReceipt }),
    evidence: Object.freeze({
      quote: spec.evidence.quote,
      eventIds: Object.freeze([...spec.evidence.eventIds]),
    }),
    ...(treeRouting === undefined ? {} : { treeRouting }),
    ...(fallbackReason === null ? {} : { fallbackReason }),
    ...(dedupResult === undefined ? {} : { dedup: Object.freeze({ ...dedupResult }) }),
  }) as Readonly<Record<string, unknown>>;
}

function recordSnapshot(args: {
  readonly id: string;
  readonly spec: ComputedCandidateSpec;
  readonly scope: MemoryScope;
  readonly route: AdmissionRoute;
  readonly valueScore: number;
  readonly importance: number;
  readonly vector: readonly number[];
  readonly fallbackReason: CandidateFallbackReason | null;
  readonly traceId: string;
  readonly intent: "auto" | "remember";
  readonly createdAt: number;
  readonly duplicate?: {
    readonly kind: "exact" | "lexical" | "semantic";
    readonly duplicateOf?: string;
  };
  readonly stampMetadata: CandidateWriteMaterializerDependencies["stampMetadata"];
}): CandidateContentWriteRecord {
  const { spec } = args;
  const admissionReason = spec.metadata.admissionReason;
  if (typeof admissionReason !== "string" || admissionReason.length === 0) invalid();
  const frozenScope = Object.freeze({ ...args.scope });
  const metadata = jsonSnapshot(args.stampMetadata({
    computation: spec.metadata,
    audit: spec.auditMetadata,
    evidence: {
      quote: spec.evidence.quote,
      eventIds: [...spec.evidence.eventIds],
    },
    traceId: args.traceId,
    intent: args.intent,
    ...(args.fallbackReason === null ? {} : { fallbackReason: args.fallbackReason }),
  }, Object.freeze({
    recordId: args.id,
    scope: frozenScope,
    spec,
  }))) as Readonly<Record<string, unknown>>;
  return Object.freeze({
    id: args.id,
    commandType: "observeAuto",
    mutation: "content",
    scope: frozenScope,
    text: spec.text,
    metadata,
    vector: args.vector,
    route: args.route,
    valueScore: args.valueScore,
    importance: args.importance,
    kind: resolveCandidateMemoryKind(spec),
    ...(spec.semanticType === undefined ? {} : { semanticType: spec.semanticType }),
    confidence: score(spec.confidence),
    provenance: Object.freeze({
      source: "agent",
      sourceId: args.traceId,
      ...(args.scope.sessionId === undefined ? {} : { sessionId: args.scope.sessionId }),
      createdAt: args.createdAt,
    }),
    evidenceIds: Object.freeze([...spec.evidence.eventIds]),
    governance: Object.freeze({
      candidate: candidateGovernance(
        spec,
        args.fallbackReason,
        args.scope,
        args.traceId,
        args.intent,
        args.duplicate,
      ),
      admissionReason,
    }),
    createdAt: args.createdAt,
  });
}

function assertDependencies(value: CandidateWriteMaterializerDependencies): void {
  if (!value || typeof value !== "object" || typeof value.embed !== "function" ||
      typeof value.scoreImportance !== "function" || typeof value.exactDedup !== "function" ||
      typeof value.semanticDedup !== "function" || typeof value.stampMetadata !== "function") {
    invalid();
  }
}

/** Materialize one immutable, retry-stable batch before opening the provider transaction. */
export async function materializeCandidateWriteRecords(
  dependencies: CandidateWriteMaterializerDependencies,
  input: CandidateWriteMaterializationInput,
  signal?: AbortSignal,
): Promise<readonly CandidateContentWriteRecord[]> {
  assertDependencies(dependencies);
  if (!input || !Array.isArray(input.specs) || !Number.isSafeInteger(input.createdAt) ||
      input.createdAt < 0 || typeof input.createRecordId !== "function" ||
      typeof input.traceId !== "string" || !SAFE_ID.test(input.traceId) ||
      (input.intent !== "auto" && input.intent !== "remember")) {
    invalid();
  }
  throwIfAborted(signal);

  const identities = Object.freeze(input.specs.map((_, index) => {
    const id = input.createRecordId(index);
    if (typeof id !== "string" || !SAFE_ID.test(id)) invalid();
    return id;
  }));
  if (new Set(identities).size !== identities.length) invalid();

  const accepted: CandidateContentWriteRecord[] = [];
  const records: CandidateContentWriteRecord[] = [];
  for (let index = 0; index < input.specs.length; index += 1) {
    const spec = input.specs[index]!;
    const recordId = identities[index]!;
    const route = routeOf(spec);
    const kind = resolveCandidateMemoryKind(spec);
    const valueScore = score(spec.metadata.valueScore);
    const embedded = vector(await dependencies.embed({
      text: spec.text,
      recordId,
      scope: input.scope,
      spec,
      ...(signal === undefined ? {} : { signal }),
    }));
    throwIfAborted(signal);

    const baseStep: CandidateMaterializationStepInput = Object.freeze({
      recordId,
      spec,
      kind,
      scope: input.scope,
      route,
      valueScore,
      vector: embedded,
      excludeIds: identities,
      batchRecords: Object.freeze([...accepted]),
    });
    const importance = score(await dependencies.scoreImportance(baseStep));
    throwIfAborted(signal);
    const step = Object.freeze({ ...baseStep, importance });

    const exact = dedup(await dependencies.exactDedup(step));
    throwIfAborted(signal);
    let duplicate: {
      kind: "exact" | "lexical" | "semantic";
      duplicateOf?: string;
    } | undefined;
    if (exact.duplicate) {
      duplicate = {
        kind: exact.layer ?? "exact",
        ...(exact.duplicateOf === undefined ? {} : { duplicateOf: exact.duplicateOf }),
      };
    } else {
      const semantic = dedup(await dependencies.semanticDedup(step));
      throwIfAborted(signal);
      if (semantic.duplicate) {
        duplicate = {
          kind: semantic.layer ?? "semantic",
          ...(semantic.duplicateOf === undefined ? {} : { duplicateOf: semantic.duplicateOf }),
        };
      }
    }

    const record = recordSnapshot({
      id: recordId,
      spec,
      scope: input.scope,
      route: duplicate === undefined ? route : "drop",
      valueScore,
      importance,
      vector: embedded,
      fallbackReason: input.fallbackReason,
      traceId: input.traceId,
      intent: input.intent,
      createdAt: input.createdAt,
      stampMetadata: dependencies.stampMetadata,
      ...(duplicate === undefined ? {} : { duplicate }),
    });
    records.push(record);
    if (duplicate === undefined && route !== "drop") accepted.push(record);
  }
  return Object.freeze(records);
}
