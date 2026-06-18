/**
 * 召回评分权重与节点打分。
 *
 * 本文件做什么：把 slot-context-builder 中原先硬编码的 importance*10+hotness
 * 排序公式，提取为显式的 6 因子权重常量 + 可解释打分函数，支持注入自定义权重。
 *
 * 核心设计（plan 评分权重）：
 * - 6 因子：relevance / scopeFit / importance / confidence / evidenceWeight / recency。
 * - 权重之和为 1，分数归一化到 [0,1]，便于跨槽位比较与 eval。
 *
 * v0.2 升级（P1-Q4）：
 * - importance 字段从硬编码改为接入 SCORING_WEIGHTS_V1（4 项加权公式 §4.2）
 * - 向后兼容：已存在的 record.importance 直接使用（运行时已算好）
 * - 新增 computeImportanceForRecord 辅助函数（从 record 元数据反推 importance）
 *
 * v0.1 现实边界（保留）：
 * - builder 拿到的是"已召回"记忆，relevance/scopeFit 是召回阶段算的，记录本身不带。
 *   因此这两个因子默认取中性值（0.5），可由调用方通过 signals 注入覆盖。
 * - 实际可得字段近似其余 4 因子：
 *   importance → importance（clamp 到 [0,1]，v0.2 起可由 computeImportanceForRecord 计算）
 *   confidence → confidence（缺省 1，表示用户显式保存）
 *   evidenceWeight → sourceNodeIds.length（按 EVIDENCE_SATURATION 饱和归一）
 *   recency → hotness（被召回热度，按 RECENCY_SATURATION 饱和归一）
 * - 缺失字段一律用默认值，保证默认权重下排序与原 importance 主导一致。
 * - 纯函数，不修改入参。
 */

import type { MemoryRecord, MemorySemanticType } from "./types.js";
import {
  computeImportance,
  computeImportanceWithBreakdown,
  type ImportanceSignals,
  type SourceKind,
} from "../scoring/importance-score.js";

/**
 * importance 4 项明细贡献值（可追溯，§4.2）。
 *
 * 每个字段是对应分量加权后的实际贡献（weight * 归一化信号），
 * 四项相加近似等于 importance，便于 explain / eval 追溯打分来源。
 * 计算复用 processing/importance-score.ts computeImportanceWithBreakdown。
 */
export interface ImportanceBreakdown {
  /** w1_salience * salience_llm 的贡献 */
  salience_llm: number;
  /** w2_authority * sourceAuthority 的贡献 */
  sourceAuthority: number;
  /** w3_explicit * explicitnessBonus 的贡献 */
  explicitnessBonus: number;
  /** w4_type * typePrior 的贡献 */
  typePrior: number;
}

/** importance 计算结果（含 4 项明细）。 */
export interface ImportanceResult {
  /** 综合 importance ∈ [0,1] */
  importance: number;
  /**
   * 4 项明细贡献。
   * 当 importance 直接取自 record.importance（运行时已算好）或缺失元数据走中性默认时，
   * 无法反推原始信号，明细为 null（仅 importance 可信）。
   */
  breakdown: ImportanceBreakdown | null;
}

/** 召回评分 6 因子权重。 */
export interface RecallWeights {
  /** 与任务的相关性（召回阶段算，builder 内默认中性） */
  relevance: number;
  /** scope 契合度（召回阶段算，builder 内默认中性） */
  scopeFit: number;
  /** 重要性 */
  importance: number;
  /** 置信度 */
  confidence: number;
  /** 证据充分度 */
  evidenceWeight: number;
  /** 新近/热度 */
  recency: number;
}

/**
 * v0.1 默认权重（plan 评分权重），相加为 1.0。
 */
export const DEFAULT_RECALL_WEIGHTS: RecallWeights = {
  relevance: 0.4,
  scopeFit: 0.2,
  importance: 0.15,
  confidence: 0.1,
  evidenceWeight: 0.1,
  recency: 0.05,
};

/** 证据数量饱和阈值：达到该条数即视为证据充分（归一化分母）。 */
const EVIDENCE_SATURATION = 3;

/** 热度饱和阈值：达到该热度即视为最新近（归一化分母）。 */
const RECENCY_SATURATION = 10;

/** 召回阶段可注入的外部信号（覆盖中性默认）。 */
export interface NodeScoreSignals {
  /** 0-1 相关性（如向量相似度） */
  relevance?: number;
  /** 0-1 scope 契合度 */
  scopeFit?: number;
}

/**
 * importance 计算所需的元数据（v0.2 新增）
 *
 * 当 record.importance 未预先计算时，可提供这些元数据从 SCORING_WEIGHTS_V1 重算。
 * 如果已有 record.importance，优先使用现有值（向后兼容）。
 */
export interface ImportanceMetadata {
  /** LLM 给的原始 salience（0-1） */
  salience?: number;
  /** 来源类型 */
  sourceKind?: SourceKind;
  /** 是否显式保存 */
  explicitSave?: boolean;
  /** 语义类型 */
  semanticType?: MemorySemanticType;
}

/** 将值约束到 [0,1]。 */
function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** 按饱和阈值把非负计数归一化到 [0,1]。 */
function saturate(value: number, saturation: number): number {
  if (saturation <= 0) return 0;
  return clamp01(value / saturation);
}

/**
 * 从 record 元数据计算 importance（v0.2 新增）
 *
 * 使用 SCORING_WEIGHTS_V1 的 4 项加权公式（§4.2）：
 * - w1_salience * salience_llm
 * - w2_authority * sourceAuthority
 * - w3_explicit * explicitnessBonus
 * - w4_type * typePrior
 *
 * @param meta importance 计算所需元数据
 * @returns importance ∈ [0,1]，缺失字段时返回 0.5（中性默认）
 */
export function computeImportanceForRecord(meta: ImportanceMetadata): number {
  // 缺失必要字段时返回中性默认值
  if (!meta.salience || !meta.sourceKind || !meta.semanticType) {
    return 0.5;
  }

  const signals: ImportanceSignals = {
    salience_llm: meta.salience,
    sourceKind: meta.sourceKind,
    explicitSave: meta.explicitSave ?? false,
    semanticType: meta.semanticType,
  };

  return computeImportance(signals);
}

/**
 * 从 record 元数据计算 importance 并返回 4 项明细（可追溯）。
 *
 * 与 computeImportanceForRecord 同源，额外暴露 salience_llm / sourceAuthority /
 * explicitnessBonus / typePrior 四项加权贡献，便于 explain / eval 追溯。
 *
 * @param meta importance 计算所需元数据
 * @returns { importance, breakdown }；缺失必要字段时 importance=0.5 且 breakdown=null
 */
export function computeImportanceForRecordWithBreakdown(
  meta: ImportanceMetadata,
): ImportanceResult {
  // 缺失必要字段时返回中性默认值，无法反推明细
  if (!meta.salience || !meta.sourceKind || !meta.semanticType) {
    return { importance: 0.5, breakdown: null };
  }

  const signals: ImportanceSignals = {
    salience_llm: meta.salience,
    sourceKind: meta.sourceKind,
    explicitSave: meta.explicitSave ?? false,
    semanticType: meta.semanticType,
  };

  const { score, breakdown } = computeImportanceWithBreakdown(signals);
  return { importance: score, breakdown };
}

/**
 * 计算单条记忆的归一化综合分（[0,1]）。
 *
 * relevance/scopeFit 默认中性 0.5（builder 缺这两个信号），可由 signals 覆盖。
 * 其余因子用记录可得字段近似，缺失字段取默认值。
 *
 * v0.2 升级：importance 优先使用 record.importance（已预先计算），
 * 如果未提供且传入了 importanceMeta，则从元数据重算。
 */
export function computeNodeScore(
  record: MemoryRecord,
  weights: RecallWeights = DEFAULT_RECALL_WEIGHTS,
  signals: NodeScoreSignals = {},
  importanceMeta?: ImportanceMetadata,
): number {
  const relevance = clamp01(signals.relevance ?? 0.5);
  const scopeFit = clamp01(signals.scopeFit ?? 0.5);

  // v0.2: importance 优先使用 record.importance，回退到元数据重算，最后默认 0.5
  let importance: number;
  if (record.importance !== undefined) {
    importance = clamp01(record.importance);
  } else if (importanceMeta) {
    importance = computeImportanceForRecord(importanceMeta);
  } else {
    importance = 0.5;
  }

  const confidence = clamp01(record.confidence ?? 1);
  const evidenceWeight = saturate(record.sourceNodeIds?.length ?? 0, EVIDENCE_SATURATION);
  const recency = saturate(record.hotness ?? 0, RECENCY_SATURATION);

  const score =
    weights.relevance * relevance +
    weights.scopeFit * scopeFit +
    weights.importance * importance +
    weights.confidence * confidence +
    weights.evidenceWeight * evidenceWeight +
    weights.recency * recency;

  return clamp01(score);
}

/**
 * 单条记忆综合分明细（可追溯）。
 *
 * factors：6 因子归一化后的输入值（[0,1]）。
 * contributions：6 因子加权后的实际贡献（weight * factor），相加得 score（clamp 前）。
 * importanceBreakdown：importance 的 4 项明细（仅在通过元数据重算时可得，否则为 null）。
 */
export interface NodeScoreBreakdown {
  /** 综合分 ∈ [0,1] */
  score: number;
  /** 使用的权重 */
  weights: RecallWeights;
  /** 6 因子归一化输入值 */
  factors: {
    relevance: number;
    scopeFit: number;
    importance: number;
    confidence: number;
    evidenceWeight: number;
    recency: number;
  };
  /** 6 因子加权贡献 */
  contributions: {
    relevance: number;
    scopeFit: number;
    importance: number;
    confidence: number;
    evidenceWeight: number;
    recency: number;
  };
  /** importance 的 4 项明细（salience_llm/sourceAuthority/explicitnessBonus/typePrior） */
  importanceBreakdown: ImportanceBreakdown | null;
}

/**
 * 计算综合分并返回完整明细（含 importance 4 项可追溯）。
 *
 * 与 computeNodeScore 同算法，额外输出每个因子的归一化值、加权贡献，
 * 以及 importance 的 4 项分量明细，便于 explain / eval / 调试排序结果。
 *
 * importance 取值优先级（P1-Q4 修复）：
 * 1. record.importance（运行时已算好，作为评分权威值）
 * 2. importanceMeta 未提供时回退到默认 0.5
 *
 * importance 明细追溯（P1-Q4 修复）：
 * - 当 importanceMeta 提供时，总是计算 4 项明细（用于 --explain 追溯）
 * - 明细基于元数据重算，可能与 record.importance 略有差异（时间差/权重版本差）
 * - 无 importanceMeta 时 importanceBreakdown=null
 */
export function computeNodeScoreWithBreakdown(
  record: MemoryRecord,
  weights: RecallWeights = DEFAULT_RECALL_WEIGHTS,
  signals: NodeScoreSignals = {},
  importanceMeta?: ImportanceMetadata,
): NodeScoreBreakdown {
  const relevance = clamp01(signals.relevance ?? 0.5);
  const scopeFit = clamp01(signals.scopeFit ?? 0.5);

  // importance 评分值：优先使用 record.importance（权威），回退默认 0.5
  const importance = record.importance !== undefined ? clamp01(record.importance) : 0.5;

  // importance 明细：提供 importanceMeta 时总是重算（explain 追溯需求，P1-Q4）
  let importanceBreakdown: ImportanceBreakdown | null = null;
  if (importanceMeta) {
    const result = computeImportanceForRecordWithBreakdown(importanceMeta);
    importanceBreakdown = result.breakdown;
  }

  const confidence = clamp01(record.confidence ?? 1);
  const evidenceWeight = saturate(record.sourceNodeIds?.length ?? 0, EVIDENCE_SATURATION);
  const recency = saturate(record.hotness ?? 0, RECENCY_SATURATION);

  const factors = { relevance, scopeFit, importance, confidence, evidenceWeight, recency };

  const contributions = {
    relevance: weights.relevance * relevance,
    scopeFit: weights.scopeFit * scopeFit,
    importance: weights.importance * importance,
    confidence: weights.confidence * confidence,
    evidenceWeight: weights.evidenceWeight * evidenceWeight,
    recency: weights.recency * recency,
  };

  const rawScore =
    contributions.relevance +
    contributions.scopeFit +
    contributions.importance +
    contributions.confidence +
    contributions.evidenceWeight +
    contributions.recency;

  return {
    score: clamp01(rawScore),
    weights,
    factors,
    contributions,
    importanceBreakdown,
  };
}
export function sortByNodeScore(
  records: readonly MemoryRecord[],
  weights: RecallWeights = DEFAULT_RECALL_WEIGHTS,
): MemoryRecord[] {
  return [...records].sort(
    (a, b) => computeNodeScore(b, weights) - computeNodeScore(a, weights),
  );
}
