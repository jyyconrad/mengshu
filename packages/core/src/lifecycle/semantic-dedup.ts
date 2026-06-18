/**
 * 候选语义去重模块
 *
 * 实现基于 embedding 相似度的候选去重策略：
 * - 基础阈值 0.82（结构化相似但非完全重复）
 * - 高相似阈值 0.90（几乎完全相同）
 * - 中文短文本（< 20 字）使用 0.88 阈值（更严格）
 * - salience >= 0.5 作为保留门控（低显著性候选优先被去重）
 *
 * 设计原则：
 * 1. 已入库的高价值候选（salience >= 0.5）优先保留
 * 2. 相似度计算使用余弦相似度（cosine similarity）
 * 3. 中文短文本因信息密度高，使用更高阈值避免误去重
 * 4. 去重决策基于 embedding 向量 + salience 分数双重过滤
 */

import type { Embeddings } from "../processing/embeddings.js";

/**
 * 去重配置
 */
export interface SemanticDedupConfig {
  /** 基础相似度阈值（默认 0.82） */
  baseSimilarityThreshold?: number;
  /** 高相似度阈值（默认 0.90） */
  highSimilarityThreshold?: number;
  /** 中文短文本阈值（默认 0.88） */
  shortTextThreshold?: number;
  /** 中文短文本字数上限（默认 20） */
  shortTextMaxChars?: number;
  /** salience 保留门控（默认 0.5） */
  salienceGate?: number;
}

/**
 * 候选记录（简化版，仅用于去重）
 */
export interface DedupCandidate {
  id: string;
  text: string;
  /** 候选显著性（对应 confidence） */
  salience: number;
  /** embedding 向量（可选，未提供时实时计算） */
  vector?: number[];
}

/**
 * 去重结果
 */
export interface DedupResult {
  /** 是否为重复 */
  isDuplicate: boolean;
  /** 重复的原因 */
  reason?: string;
  /** 与哪个已有候选重复（候选 id） */
  duplicateOf?: string;
  /** 相似度分数 */
  similarity?: number;
  /** 使用的阈值 */
  threshold?: number;
}

const DEFAULT_CONFIG: Required<SemanticDedupConfig> = {
  baseSimilarityThreshold: 0.82,
  highSimilarityThreshold: 0.90,
  shortTextThreshold: 0.88,
  shortTextMaxChars: 20,
  salienceGate: 0.5,
};

/**
 * 计算两个向量的余弦相似度
 */
export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * 判断文本是否为中文短文本
 * 统计中文字符数（不含标点、空格、英文）
 */
export function isChineseShortText(text: string, maxChars: number): boolean {
  // 匹配中文字符（CJK 统一表意文字）
  const chineseChars = text.match(/[一-龥]/g);
  const chineseCharCount = chineseChars ? chineseChars.length : 0;
  return chineseCharCount > 0 && chineseCharCount < maxChars;
}

/**
 * 根据文本特征选择合适的相似度阈值
 */
export function selectThreshold(
  text: string,
  config: Required<SemanticDedupConfig>,
): number {
  if (isChineseShortText(text, config.shortTextMaxChars)) {
    return config.shortTextThreshold;
  }
  return config.baseSimilarityThreshold;
}

/**
 * 语义去重器
 */
export class SemanticDeduplicator {
  private config: Required<SemanticDedupConfig>;

  constructor(
    private embeddings: Embeddings,
    config?: SemanticDedupConfig,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 检查新候选是否与已有候选集合重复
   *
   * 策略：
   * 1. 如果新候选 salience < 门控值，且存在相似候选 → 判定为重复
   * 2. 如果新候选 salience >= 门控值，且已有候选 salience < 门控值 → 保留新候选（替换旧候选）
   * 3. 如果双方 salience 都 >= 门控值，使用更高阈值（highSimilarityThreshold）判定
   *
   * @param candidate 待检查的新候选
   * @param existingCandidates 已有候选集合（同 scope 的 pending 候选）
   * @returns 去重结果
   */
  async checkDuplicate(
    candidate: DedupCandidate,
    existingCandidates: DedupCandidate[],
  ): Promise<DedupResult> {
    if (existingCandidates.length === 0) {
      return { isDuplicate: false };
    }

    // 计算新候选的 embedding（如果未提供）
    const newVector = candidate.vector ?? await this.embeddings.embed(candidate.text);

    // 获取或计算所有已有候选的 embedding
    const existingVectors = await this.getOrComputeVectors(existingCandidates);

    const newSalience = candidate.salience;
    const threshold = selectThreshold(candidate.text, this.config);

    // 遍历已有候选，查找相似项
    for (let i = 0; i < existingCandidates.length; i++) {
      const existing = existingCandidates[i];
      const existingVector = existingVectors[i];
      const similarity = cosineSimilarity(newVector, existingVector);

      // 双方都是高价值候选（salience >= 门控值）
      if (newSalience >= this.config.salienceGate && existing.salience >= this.config.salienceGate) {
        // 使用更高阈值判定
        if (similarity >= this.config.highSimilarityThreshold) {
          return {
            isDuplicate: true,
            reason: "high_value_duplicate",
            duplicateOf: existing.id,
            similarity,
            threshold: this.config.highSimilarityThreshold,
          };
        }
      }
      // 新候选是低价值（salience < 门控值）
      else if (newSalience < this.config.salienceGate) {
        // 与任何候选相似即判定为重复
        if (similarity >= threshold) {
          return {
            isDuplicate: true,
            reason: "low_salience_duplicate",
            duplicateOf: existing.id,
            similarity,
            threshold,
          };
        }
      }
      // 新候选高价值，已有候选低价值
      else if (newSalience >= this.config.salienceGate && existing.salience < this.config.salienceGate) {
        // 这种情况下新候选应该被保留，旧候选应该被标记淘汰
        // 但这是替换逻辑，不是去重判定，这里仍判定不重复
        // （替换逻辑由调用方处理）
        continue;
      }
    }

    return { isDuplicate: false };
  }

  /**
   * 批量去重：从候选列表中移除重复项
   *
   * 策略：
   * 1. 按 salience 降序排序（高价值优先保留）
   * 2. 依次检查每个候选，与已保留集合比较
   * 3. 不重复的加入保留集合，重复的加入去重集合
   *
   * @param candidates 待去重的候选列表
   * @returns { kept, removed } kept 为保留的候选，removed 为去重的候选（含去重原因）
   */
  async deduplicateBatch(
    candidates: DedupCandidate[],
  ): Promise<{
    kept: DedupCandidate[];
    removed: Array<DedupCandidate & { dedupReason: string; duplicateOf: string }>;
  }> {
    if (candidates.length === 0) {
      return { kept: [], removed: [] };
    }

    // 按 salience 降序排序（高价值优先）
    const sorted = [...candidates].sort((a, b) => b.salience - a.salience);

    // 批量计算所有候选的 embedding（优化性能）
    const vectors = await this.embeddings.embedBatch(sorted.map(c => c.text));

    const kept: DedupCandidate[] = [];
    const removed: Array<DedupCandidate & { dedupReason: string; duplicateOf: string }> = [];

    for (let i = 0; i < sorted.length; i++) {
      const candidate = sorted[i];
      const vector = vectors[i];

      // 与已保留集合比较
      const result = await this.checkDuplicate(
        { ...candidate, vector },
        kept.map((c, idx) => ({ ...c, vector: vectors[sorted.indexOf(c)] })),
      );

      if (result.isDuplicate) {
        removed.push({
          ...candidate,
          dedupReason: result.reason!,
          duplicateOf: result.duplicateOf!,
        });
      } else {
        kept.push({ ...candidate, vector });
      }
    }

    return { kept, removed };
  }

  /**
   * 获取或计算候选集合的 embedding 向量
   */
  private async getOrComputeVectors(candidates: DedupCandidate[]): Promise<number[][]> {
    const needCompute: number[] = [];
    const vectors: number[][] = [];

    // 收集需要计算的候选索引
    for (let i = 0; i < candidates.length; i++) {
      if (candidates[i].vector) {
        vectors[i] = candidates[i].vector!;
      } else {
        needCompute.push(i);
      }
    }

    // 批量计算缺失的 embedding
    if (needCompute.length > 0) {
      const textsToEmbed = needCompute.map(idx => candidates[idx].text);
      const computed = await this.embeddings.embedBatch(textsToEmbed);

      for (let i = 0; i < needCompute.length; i++) {
        vectors[needCompute[i]] = computed[i];
      }
    }

    return vectors;
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<SemanticDedupConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取当前配置
   */
  getConfig(): Required<SemanticDedupConfig> {
    return { ...this.config };
  }
}
