/** Authoritative evidence -> candidate confidence 的纯计算边界。 */

import { types as nodeUtilTypes } from "node:util";

import type { MemorySemanticType } from "../domain/types.js";
import {
  computeConfidenceWithBreakdown,
} from "../scoring/confidence-score.js";
import type { SourceKind } from "../scoring/importance-score.js";

const SOURCE_KINDS = new Set<SourceKind>([
  "rule_file",
  "session_user",
  "work_log",
  "document",
  "tool_result",
  "agent_output",
]);
const SEMANTIC_TYPES = new Set<MemorySemanticType>([
  "profile",
  "task_context",
  "rules",
  "experience",
  "resource",
]);
const SAFE_EVIDENCE_ID = /^[^\s\p{Cc}]{1,256}$/u;
const UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

export interface AuthoritativeCandidateEvidenceFact {
  readonly evidenceId: string;
  readonly sourceKind: SourceKind;
}

export interface CandidateConfidenceEvidenceBreakdown {
  readonly evidenceId: string;
  readonly sourceKind: SourceKind;
  readonly reliability: number;
}

export interface CandidateConfidenceBreakdown {
  readonly score: number;
  readonly baseConfidence: number;
  readonly evidences: readonly CandidateConfidenceEvidenceBreakdown[];
}

function safeEvidenceId(value: unknown): value is string {
  return typeof value === "string" && SAFE_EVIDENCE_ID.test(value) &&
    !UNPAIRED_SURROGATE.test(value);
}

function snapshotFact(value: unknown): AuthoritativeCandidateEvidenceFact | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== 2 || keys.some((key) => typeof key !== "string") ||
      !keys.includes("evidenceId") || !keys.includes("sourceKind")) {
    return undefined;
  }
  const evidenceId = descriptors.evidenceId;
  const sourceKind = descriptors.sourceKind;
  if (!evidenceId?.enumerable || !("value" in evidenceId) ||
      !sourceKind?.enumerable || !("value" in sourceKind) ||
      !safeEvidenceId(evidenceId.value) ||
      typeof sourceKind.value !== "string" || !SOURCE_KINDS.has(sourceKind.value as SourceKind)) {
    return undefined;
  }
  return Object.freeze({
    evidenceId: evidenceId.value,
    sourceKind: sourceKind.value as SourceKind,
  });
}

/**
 * 将 server-owned facts 固定为无重复、不可变快照。缺失与非法输入统一返回 undefined，
 * 调用方必须 fail-closed，不能回退到 LLM/metadata 提供的来源类别。
 */
export function snapshotAuthoritativeCandidateEvidenceFacts(
  value: unknown,
): readonly AuthoritativeCandidateEvidenceFact[] | undefined {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) || value.length === 0) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) return undefined;
  const facts: AuthoritativeCandidateEvidenceFact[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
    const fact = snapshotFact(descriptor.value);
    if (!fact || seen.has(fact.evidenceId)) return undefined;
    seen.add(fact.evidenceId);
    facts.push(fact);
  }
  return Object.freeze(facts);
}

/** 仅使用候选真实 eventIds 对应的权威 facts 计算既有 confidence 公式。 */
export function deriveCandidateConfidence(input: {
  readonly semanticType: MemorySemanticType;
  readonly eventIds: readonly string[];
  readonly evidenceFacts: unknown;
}): CandidateConfidenceBreakdown | undefined {
  if (!SEMANTIC_TYPES.has(input.semanticType) || !Array.isArray(input.eventIds) ||
      input.eventIds.length === 0) return undefined;
  const facts = snapshotAuthoritativeCandidateEvidenceFacts(input.evidenceFacts);
  if (!facts) return undefined;
  const byId = new Map(facts.map((fact) => [fact.evidenceId, fact]));
  const eventIds = new Set<string>();
  const matched: AuthoritativeCandidateEvidenceFact[] = [];
  for (const evidenceId of input.eventIds) {
    if (!safeEvidenceId(evidenceId) || eventIds.has(evidenceId)) return undefined;
    eventIds.add(evidenceId);
    const fact = byId.get(evidenceId);
    if (!fact) return undefined;
    matched.push(fact);
  }
  const computed = computeConfidenceWithBreakdown(
    input.semanticType,
    matched.map(({ sourceKind }) => ({ sourceKind })),
  );
  const evidences = matched.map((fact, index) => Object.freeze({
    evidenceId: fact.evidenceId,
    sourceKind: fact.sourceKind,
    reliability: computed.evidenceReliabilities[index]!,
  }));
  return Object.freeze({
    score: computed.score,
    baseConfidence: computed.baseConfidence,
    evidences: Object.freeze(evidences),
  });
}
