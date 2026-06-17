/**
 * 公共测试用 EmbeddingPort 实现。
 *
 * 本文件做什么：
 *   - 提供给单元测试 / 评测 runner 使用的可重现 EmbeddingPort 假实现。
 *   - 默认使用 1536 维向量（与生产 text-embedding-3-small 维度对齐），
 *     避免测试侧维度与生产侧不一致掩盖真实问题。
 *   - 支持两种生成模式：
 *       hash      —— 基于 FNV-1a hash 的确定性向量（默认）。相同文本永远相同；
 *                    不同文本极大概率得到不同向量；可重现，可在 eval 里做向量召回。
 *       constant  —— 返回一个固定向量（除某个 slot 外全是 0），用于
 *                    极简单元测试，向后兼容历史 [0.3, 0.4] 模式。
 *
 * 核心流程：
 *   embed(text) ：
 *     1. 用 FNV-1a 拿到 32-bit seed；
 *     2. 用 mulberry32 PRNG 生成 dim 个 [-1, 1] 的浮点；
 *     3. L2 归一化，让向量直接可用于 cosine 相似度比较。
 *
 * 关键边界：
 *   - 没有真正调用任何远端 embedding 服务，所有逻辑都是纯函数。
 *   - 不要在生产代码里直接 import 本文件，它只是测试基础设施。
 *   - constant 模式不归一化（保留旧行为），仅用于不依赖语义相似度的契约测试。
 *   - hash 模式产生的向量是 deterministic、reproducible，可以放进 jsonl 黄金集
 *     的判定逻辑而不需要外部 oracle。
 */

import type { EmbeddingPort } from "../core/service-types.js";

/** 生产侧默认的 embedding 维度（OpenAI text-embedding-3-small）。 */
export const DEFAULT_EMBEDDING_DIM = 1536;

/** Fake embedding 工作模式。 */
export type FakeEmbeddingMode = "hash" | "constant";

export interface FakeEmbeddingsOptions {
  /** 输出向量维度，默认 1536。 */
  dim?: number;
  /** 生成模式，默认 "hash"。 */
  mode?: FakeEmbeddingMode;
  /** constant 模式下，非零位的位置，默认 0。 */
  constantSlot?: number;
  /** constant 模式下，非零位的取值，默认 1。 */
  constantValue?: number;
}

/**
 * FNV-1a 32-bit hash。简单稳定，足够用于派生 PRNG seed。
 */
function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    // FNV prime 16777619，使用 Math.imul 保持 32-bit 截断
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * mulberry32：极简、确定性、序列良好的 32-bit PRNG。
 * 给定相同 seed，序列完全一致。
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 公共测试用 EmbeddingPort。
 *
 * 默认 hash 模式：相同文本 → 相同向量；不同文本 → 极大概率不同。
 * constant 模式：所有文本返回同一向量（仅一位非零），用于不依赖语义的契约测试。
 */
export class FakeEmbeddings implements EmbeddingPort {
  readonly dim: number;
  readonly mode: FakeEmbeddingMode;
  /** 调用过的文本（按调用顺序），便于断言 service 调了哪些 query。 */
  readonly texts: string[] = [];
  private readonly constantSlot: number;
  private readonly constantValue: number;

  constructor(options: FakeEmbeddingsOptions = {}) {
    const { dim = DEFAULT_EMBEDDING_DIM, mode = "hash" } = options;
    if (!Number.isInteger(dim) || dim <= 0) {
      throw new Error(`FakeEmbeddings: dim 必须是正整数，收到 ${dim}`);
    }
    this.dim = dim;
    this.mode = mode;
    this.constantSlot = Math.min(
      Math.max(0, options.constantSlot ?? 0),
      Math.max(0, dim - 1),
    );
    this.constantValue = options.constantValue ?? 1;
  }

  async embed(text: string): Promise<number[]> {
    this.texts.push(text);
    if (this.mode === "constant") {
      return this.buildConstantVector();
    }
    return this.buildHashVector(text);
  }

  /** 同步版本，便于 fixture / runner 在不 await 的场合直接用。 */
  embedSync(text: string): number[] {
    if (this.mode === "constant") {
      return this.buildConstantVector();
    }
    return this.buildHashVector(text);
  }

  private buildConstantVector(): number[] {
    const v = new Array<number>(this.dim).fill(0);
    if (this.dim > 0) {
      v[this.constantSlot] = this.constantValue;
    }
    return v;
  }

  private buildHashVector(text: string): number[] {
    const seed = fnv1a32(text || "<empty>");
    const rand = mulberry32(seed);
    const v = new Array<number>(this.dim);
    let sumSq = 0;
    for (let i = 0; i < this.dim; i++) {
      // 映射到 [-1, 1)
      const x = rand() * 2 - 1;
      v[i] = x;
      sumSq += x * x;
    }
    // L2 归一化，向量直接落到单位球，cosine ≈ 内积
    const norm = Math.sqrt(sumSq) || 1;
    for (let i = 0; i < this.dim; i++) {
      v[i] = v[i] / norm;
    }
    return v;
  }
}

/**
 * 默认实例，方便 eval runner 直接 import 使用。
 */
export const defaultFakeEmbeddings = new FakeEmbeddings();
