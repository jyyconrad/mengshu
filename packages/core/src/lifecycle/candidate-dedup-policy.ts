/**
 * Candidate memory 的确定性 L0-L2 去重策略。
 *
 * 调用方必须先按 authority、scope、semanticType 与 embedding space 筛选存量记录。
 * 本模块仍同时校验 MemoryKind 与 semanticType，避免把底层分类和五槽位语义视图混用。
 */

import { createHash } from "node:crypto";

import type { MemoryKind, MemorySemanticType } from "../domain/types.js";

export const CANDIDATE_DEDUP_THRESHOLDS = Object.freeze({
  cjkShortTextMaxChars: 20,
  cjkShortTextLexical: 0.88,
  lexicalDefault: 0.85,
  semanticGate: 0.5,
  semanticJudgeFloor: 0.82,
  semanticMerge: 0.90,
});

export interface CandidateDedupSubject {
  readonly text: string;
  readonly vector?: readonly number[];
  readonly salience?: number;
  readonly confidence?: number;
  readonly kind: MemoryKind;
  readonly semanticType?: MemorySemanticType;
}

export interface CandidateDedupComparable {
  readonly id: string;
  readonly text: string;
  readonly vector?: readonly number[];
  readonly kind: MemoryKind;
  readonly semanticType?: MemorySemanticType;
}

export interface CandidateDedupInput {
  readonly candidate: CandidateDedupSubject;
  /** 已由调用方按 authority/scope/type/embedding-space 过滤的只读存量。 */
  readonly existingRecords: readonly CandidateDedupComparable[];
  /** 当前批次中已经接受的前序记录。 */
  readonly batchRecords: readonly CandidateDedupComparable[];
}

export type CandidateMaximumSimilarityResult = Readonly<
  | {
      known: true;
      maxSimilarity: number;
      comparedRecords: number;
    }
  | {
      known: false;
      reason: "invalid_candidate_vector" | "invalid_comparable_vector";
    }
>;

export type CandidateDedupResult = Readonly<
  | {
      duplicate: true;
      duplicateOf: string;
      layer: "exact" | "lexical" | "semantic";
      similarity: number;
      reason:
        | "canonical_hash_match"
        | "lexical_threshold_met"
        | "semantic_threshold_met";
    }
  | {
      duplicate: false;
      layer?: "semantic";
      similarity?: number;
      reason:
        | "distinct"
        | "invalid_vector_preserved"
        | "rule_polarity_mismatch"
        | "rule_semantic_preserved"
        | "semantic_gate_not_met"
        | "semantic_gray_zone_preserved";
    }
>;

const PREFIX = /^(?:用户说|记住|规则|偏好|经验|资源)\s*[:：]?\s*/u;
const CJK = /[\p{Script=Han}]/u;
const CJK_GLOBAL = /[\p{Script=Han}]/gu;
const PUNCTUATION = /[，。！？；：“”‘’「」『』【】、…—]/gu;
const NEGATIVE_RULE = /(?:不得|不允许|不准|禁止|无需|无须|不要|不能|不可|严禁|never|must\s+not|do\s+not|don't|cannot|can't)/iu;

/** §5.3 的 candidate canonicalization；只用于去重，不替代 ingest canonicalize。 */
export function canonicalCandidateText(text: string): string {
  return text
    .trim()
    .normalize("NFKC")
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase())
    .replace(PREFIX, "")
    .replace(/\s+/gu, " ")
    .replace(PUNCTUATION, (character) => {
      switch (character) {
        case "，": return ",";
        case "。": return ".";
        case "！": return "!";
        case "？": return "?";
        case "；": return ";";
        case "：": return ":";
        default: return "";
      }
    })
    .replace(/[/\\]+/gu, "/")
    .trim();
}

export function candidateCanonicalHash(text: string): string {
  return createHash("sha256").update(canonicalCandidateText(text)).digest("hex");
}

export function selectCandidateLexicalThreshold(text: string): number {
  const canonical = canonicalCandidateText(text);
  const cjkCount = canonical.match(CJK_GLOBAL)?.length ?? 0;
  if (cjkCount > 0 && [...canonical].length < CANDIDATE_DEDUP_THRESHOLDS.cjkShortTextMaxChars) {
    return CANDIDATE_DEDUP_THRESHOLDS.cjkShortTextLexical;
  }
  // “英文技术词密集”尚无确定性分类合同；未命中可靠条件时按默认阈值保守处理。
  return CANDIDATE_DEDUP_THRESHOLDS.lexicalDefault;
}

function ngrams(parts: readonly string[]): ReadonlySet<string> {
  if (parts.length === 0) return new Set();
  if (parts.length === 1) return new Set(parts);
  const result = new Set<string>();
  for (let index = 0; index < parts.length - 1; index += 1) {
    result.add(`${parts[index]}\u0000${parts[index + 1]}`);
  }
  return result;
}

function lexicalTokens(text: string): ReadonlySet<string> {
  const canonical = canonicalCandidateText(text);
  if (CJK.test(canonical)) {
    return ngrams([...canonical].filter((character) => !/\s/u.test(character)));
  }
  const words = canonical.match(/[\p{L}\p{N}_+.#@/-]+/gu) ?? [];
  return ngrams(words);
}

export function candidateLexicalSimilarity(left: string, right: string): number {
  const leftTokens = lexicalTokens(left);
  const rightTokens = lexicalTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  return intersection / (leftTokens.size + rightTokens.size - intersection);
}

function sameTypeBucket(
  candidate: CandidateDedupSubject,
  record: CandidateDedupComparable,
): boolean {
  return candidate.kind === record.kind && candidate.semanticType === record.semanticType;
}

function hasRulePolarityMismatch(
  candidate: CandidateDedupSubject,
  record: CandidateDedupComparable,
): boolean {
  if (candidate.semanticType !== "rules") return false;
  return NEGATIVE_RULE.test(canonicalCandidateText(candidate.text)) !==
    NEGATIVE_RULE.test(canonicalCandidateText(record.text));
}

type VectorValidation =
  | { readonly valid: true; readonly norm: number }
  | { readonly valid: false };

function validateVector(vector: readonly number[] | undefined): VectorValidation {
  if (!vector || vector.length === 0) return { valid: false };
  let squaredNorm = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) return { valid: false };
    squaredNorm += value * value;
  }
  return Number.isFinite(squaredNorm) && squaredNorm > 0
    ? { valid: true, norm: Math.sqrt(squaredNorm) }
    : { valid: false };
}

function cosine(
  left: readonly number[],
  leftNorm: number,
  right: readonly number[],
  rightNorm: number,
): number {
  let product = 0;
  for (let index = 0; index < left.length; index += 1) {
    product += left[index]! * right[index]!;
  }
  return Math.max(-1, Math.min(1, product / (leftNorm * rightNorm)));
}

/**
 * 为 admission 计算同一 type bucket 内的真实最大语义相似度。
 * 任一可比向量不可解释时返回 unknown，避免把缺失/错误向量伪装成零相似度。
 */
export function computeCandidateMaximumSimilarity(
  input: CandidateDedupInput,
): CandidateMaximumSimilarityResult {
  const records = [...input.existingRecords, ...input.batchRecords]
    .filter((record) => sameTypeBucket(input.candidate, record));
  if (records.length === 0) {
    return Object.freeze({ known: true, maxSimilarity: 0, comparedRecords: 0 });
  }

  const candidateHash = candidateCanonicalHash(input.candidate.text);
  if (records.some((record) => candidateCanonicalHash(record.text) === candidateHash)) {
    return Object.freeze({ known: true, maxSimilarity: 1, comparedRecords: records.length });
  }

  const candidateVector = input.candidate.vector;
  const candidateValidation = validateVector(candidateVector);
  if (!candidateVector || !candidateValidation.valid) {
    return Object.freeze({ known: false, reason: "invalid_candidate_vector" });
  }

  let maximumSimilarity = 0;
  for (const record of records) {
    const recordVector = record.vector;
    const recordValidation = validateVector(recordVector);
    if (!recordVector || !recordValidation.valid || recordVector.length !== candidateVector.length) {
      return Object.freeze({ known: false, reason: "invalid_comparable_vector" });
    }
    maximumSimilarity = Math.max(
      maximumSimilarity,
      Math.max(0, cosine(
        candidateVector,
        candidateValidation.norm,
        recordVector,
        recordValidation.norm,
      )),
    );
  }
  return Object.freeze({
    known: true,
    maxSimilarity: maximumSimilarity,
    comparedRecords: records.length,
  });
}

function semanticSignal(candidate: CandidateDedupSubject): number | undefined {
  const value = candidate.salience ?? candidate.confidence;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
}

function duplicate(
  duplicateOf: string,
  layer: "exact" | "lexical" | "semantic",
  similarity: number,
  reason: "canonical_hash_match" | "lexical_threshold_met" | "semantic_threshold_met",
): CandidateDedupResult {
  return Object.freeze({ duplicate: true, duplicateOf, layer, similarity, reason });
}

function distinct(
  reason: Extract<CandidateDedupResult, { duplicate: false }>["reason"],
  details: { readonly layer?: "semantic"; readonly similarity?: number } = {},
): CandidateDedupResult {
  return Object.freeze({ duplicate: false, ...details, reason });
}

export function evaluateCandidateDedup(input: CandidateDedupInput): CandidateDedupResult {
  const records = [...input.existingRecords, ...input.batchRecords]
    .filter((record) => sameTypeBucket(input.candidate, record));
  if (records.length === 0) return distinct("distinct");
  const candidateHash = candidateCanonicalHash(input.candidate.text);
  let rulePolarityMismatch = false;

  for (const record of records) {
    if (candidateCanonicalHash(record.text) !== candidateHash) continue;
    return duplicate(record.id, "exact", 1, "canonical_hash_match");
  }

  for (const record of records) {
    const similarity = candidateLexicalSimilarity(input.candidate.text, record.text);
    const threshold = Math.max(
      selectCandidateLexicalThreshold(input.candidate.text),
      selectCandidateLexicalThreshold(record.text),
    );
    if (similarity < threshold) continue;
    if (hasRulePolarityMismatch(input.candidate, record)) {
      rulePolarityMismatch = true;
      continue;
    }
    return duplicate(record.id, "lexical", similarity, "lexical_threshold_met");
  }

  const signal = semanticSignal(input.candidate);
  if (signal === undefined || signal < CANDIDATE_DEDUP_THRESHOLDS.semanticGate) {
    return distinct("semantic_gate_not_met");
  }
  if (rulePolarityMismatch) return distinct("rule_polarity_mismatch");
  // rules 的错误合并会直接改变 Agent 行为；没有 lexical 证据时不以 embedding 自动裁决。
  if (input.candidate.semanticType === "rules") return distinct("rule_semantic_preserved");

  const candidateVector = input.candidate.vector;
  if (candidateVector === undefined) return distinct("distinct");
  const candidateValidation = validateVector(candidateVector);
  if (!candidateValidation.valid) {
    return distinct("invalid_vector_preserved");
  }

  let invalidVector = false;
  let maximumSimilarity = -1;
  for (const record of records) {
    const recordVector = record.vector;
    if (recordVector === undefined) continue;
    const recordValidation = validateVector(recordVector);
    if (!recordValidation.valid || recordVector.length !== candidateVector.length) {
      invalidVector = true;
      continue;
    }
    const similarity = cosine(
      candidateVector,
      candidateValidation.norm,
      recordVector,
      recordValidation.norm,
    );
    maximumSimilarity = Math.max(maximumSimilarity, similarity);
    if (similarity < CANDIDATE_DEDUP_THRESHOLDS.semanticMerge) continue;
    if (hasRulePolarityMismatch(input.candidate, record)) {
      rulePolarityMismatch = true;
      continue;
    }
    return duplicate(record.id, "semantic", similarity, "semantic_threshold_met");
  }

  if (rulePolarityMismatch) return distinct("rule_polarity_mismatch");
  if (maximumSimilarity >= CANDIDATE_DEDUP_THRESHOLDS.semanticJudgeFloor) {
    return distinct("semantic_gray_zone_preserved", {
      layer: "semantic",
      similarity: maximumSimilarity,
    });
  }
  if (invalidVector) return distinct("invalid_vector_preserved");
  return distinct("distinct");
}
