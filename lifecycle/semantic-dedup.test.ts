/**
 * 候选语义去重测试
 *
 * 测试覆盖：
 * 1. embedding 相似度阈值（0.82/0.90）
 * 2. salience >= 0.5 门控
 * 3. 中文短文本 < 20 字使用 0.88 阈值
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  SemanticDeduplicator,
  cosineSimilarity,
  isChineseShortText,
  selectThreshold,
  type DedupCandidate,
  type SemanticDedupConfig,
} from "./semantic-dedup.js";
import { Embeddings } from "../processing/embeddings.js";

// Mock Embeddings 实现
class MockEmbeddings extends Embeddings {
  private cache = new Map<string, number[]>();
  private readonly dimension = 128;

  constructor() {
    super({
      provider: "openai",
      apiKey: "test-key",
      baseURL: "https://api.test.com/v1",
      model: "test-embedding",
    });
  }

  async embed(text: string): Promise<number[]> {
    if (this.cache.has(text)) {
      return this.cache.get(text)!;
    }
    // 生成确定性的伪向量（基于文本内容）
    const vector = this.generateVector(text);
    this.cache.set(text, vector);
    return vector;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  private generateVector(text: string): number[] {
    // 生成 128 维向量，基于文本哈希保证一致性
    const hash = this.simpleHash(text);
    const vector: number[] = [];
    for (let i = 0; i < this.dimension; i++) {
      vector.push(Math.sin(hash + i) * 0.5 + 0.5);
    }
    return this.normalize(vector);
  }

  private simpleHash(text: string): number {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = (hash << 5) - hash + text.charCodeAt(i);
      hash = hash & hash;
    }
    return hash;
  }

  private normalize(vector: number[]): number[] {
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    return vector.map((v) => v / norm);
  }

  // 辅助方法：设置两个文本的相似度（通过精确控制向量）
  setSimilarity(text1: string, text2: string, similarity: number): void {
    // 确保 text1 已有向量
    if (!this.cache.has(text1)) {
      const vec1 = this.generateVector(text1);
      this.cache.set(text1, vec1);
    }

    const vec1 = this.cache.get(text1)!;

    // 生成与 vec1 具有精确相似度的 vec2
    const vec2 = this.createSimilarVector(vec1, similarity);
    this.cache.set(text2, vec2);

    // 验证相似度（调试用）
    const actualSimilarity = cosineSimilarity(vec1, vec2);
    if (Math.abs(actualSimilarity - similarity) > 0.01) {
      console.warn(`Warning: setSimilarity target=${similarity}, actual=${actualSimilarity}`);
    }
  }

  private createSimilarVector(base: number[], targetSimilarity: number): number[] {
    // 创建正交向量（Gram-Schmidt 正交化）
    const orthogonal = this.createOrthogonalVector(base);

    // 混合 base 和 orthogonal 以达到目标相似度
    // cos(θ) = targetSimilarity
    // vec2 = targetSimilarity * base + sqrt(1 - targetSimilarity^2) * orthogonal
    const alpha = targetSimilarity;
    const beta = Math.sqrt(Math.max(0, 1 - alpha * alpha));

    const result = base.map((v, i) => alpha * v + beta * orthogonal[i]);
    return this.normalize(result);
  }

  private createOrthogonalVector(base: number[]): number[] {
    // 生成一个随机向量
    const random: number[] = [];
    for (let i = 0; i < this.dimension; i++) {
      random.push(Math.random() - 0.5);
    }

    // Gram-Schmidt: orthogonal = random - projection(random onto base)
    const dotProduct = random.reduce((sum, v, i) => sum + v * base[i], 0);
    const orthogonal = random.map((v, i) => v - dotProduct * base[i]);

    return this.normalize(orthogonal);
  }
}

describe("SemanticDeduplicator", () => {
  let embeddings: MockEmbeddings;
  let deduplicator: SemanticDeduplicator;

  beforeEach(() => {
    embeddings = new MockEmbeddings();
    deduplicator = new SemanticDeduplicator(embeddings);
  });

  describe("cosineSimilarity", () => {
    it("应该计算相同向量的相似度为 1", () => {
      const vec = [1, 0, 0];
      expect(cosineSimilarity(vec, vec)).toBeCloseTo(1.0, 5);
    });

    it("应该计算正交向量的相似度为 0", () => {
      const vec1 = [1, 0, 0];
      const vec2 = [0, 1, 0];
      expect(cosineSimilarity(vec1, vec2)).toBeCloseTo(0, 5);
    });

    it("应该计算反向向量的相似度为 -1", () => {
      const vec1 = [1, 0, 0];
      const vec2 = [-1, 0, 0];
      expect(cosineSimilarity(vec1, vec2)).toBeCloseTo(-1, 5);
    });

    it("应该处理长度不同的向量", () => {
      const vec1 = [1, 0, 0];
      const vec2 = [1, 0];
      expect(cosineSimilarity(vec1, vec2)).toBe(0);
    });

    it("应该处理零向量", () => {
      const vec1 = [0, 0, 0];
      const vec2 = [1, 0, 0];
      expect(cosineSimilarity(vec1, vec2)).toBe(0);
    });
  });

  describe("isChineseShortText", () => {
    it("应该识别中文短文本（< 20 字）", () => {
      expect(isChineseShortText("用户喜欢简洁的代码", 20)).toBe(true);
      expect(isChineseShortText("这是一个测试", 20)).toBe(true);
    });

    it("应该识别中文长文本（>= 20 字）", () => {
      const longText = "这是一个很长的中文文本，包含了超过二十个汉字，用于测试长文本的识别功能";
      expect(isChineseShortText(longText, 20)).toBe(false);
    });

    it("应该忽略标点和空格", () => {
      expect(isChineseShortText("用户，喜欢 简洁的代码！", 20)).toBe(true);
    });

    it("应该处理混合中英文文本", () => {
      expect(isChineseShortText("用户喜欢 React 框架", 20)).toBe(true);
    });

    it("应该排除纯英文文本", () => {
      expect(isChineseShortText("User prefers clean code", 20)).toBe(false);
    });

    it("应该排除空文本", () => {
      expect(isChineseShortText("", 20)).toBe(false);
    });
  });

  describe("selectThreshold", () => {
    const config: Required<SemanticDedupConfig> = {
      baseSimilarityThreshold: 0.82,
      highSimilarityThreshold: 0.90,
      shortTextThreshold: 0.88,
      shortTextMaxChars: 20,
      salienceGate: 0.5,
    };

    it("应该为中文短文本选择 0.88 阈值", () => {
      expect(selectThreshold("用户喜欢简洁的代码", config)).toBe(0.88);
    });

    it("应该为中文长文本选择 0.82 阈值", () => {
      const longText = "这是一个很长的中文文本，包含了超过二十个汉字，用于测试长文本的识别功能";
      expect(selectThreshold(longText, config)).toBe(0.82);
    });

    it("应该为英文文本选择 0.82 阈值", () => {
      expect(selectThreshold("User prefers clean code", config)).toBe(0.82);
    });
  });

  describe("checkDuplicate - 基础相似度阈值（0.82）", () => {
    it("应该检测相似度 >= 0.82 的低 salience 候选为重复", async () => {
      const text1 = "用户喜欢简洁的代码风格和清晰的注释";
      const text2 = "用户喜欢简洁代码风格和清晰注释内容"; // 非常相似的文本
      // 中文短文本需要更高的相似度（0.88）
      embeddings.setSimilarity(text1, text2, 0.90);

      const candidate: DedupCandidate = {
        id: "new",
        text: text2,
        salience: 0.4, // < 0.5 门控
      };

      const existing: DedupCandidate[] = [
        { id: "existing", text: text1, salience: 0.6 },
      ];

      const result = await deduplicator.checkDuplicate(candidate, existing);
      expect(result.isDuplicate).toBe(true);
      expect(result.reason).toBe("low_salience_duplicate");
      expect(result.duplicateOf).toBe("existing");
      expect(result.similarity).toBeGreaterThanOrEqual(0.88);
    });

    it("应该保留相似度 < 0.82 的低 salience 候选", async () => {
      const text1 = "用户喜欢简洁的代码风格";
      const text2 = "系统需要完整的测试覆盖"; // 完全不同的文本
      embeddings.setSimilarity(text1, text2, 0.75);

      const candidate: DedupCandidate = {
        id: "new",
        text: text2,
        salience: 0.4,
      };

      const existing: DedupCandidate[] = [
        { id: "existing", text: text1, salience: 0.6 },
      ];

      const result = await deduplicator.checkDuplicate(candidate, existing);
      expect(result.isDuplicate).toBe(false);
    });
  });

  describe("checkDuplicate - 高相似度阈值（0.90）", () => {
    it("应该检测相似度 >= 0.90 的高 salience 候选为重复", async () => {
      const text1 = "用户喜欢简洁的代码风格";
      const text2 = "用户喜欢简洁的代码风格内容"; // 几乎完全相同
      embeddings.setSimilarity(text1, text2, 0.92);

      const candidate: DedupCandidate = {
        id: "new",
        text: text2,
        salience: 0.7, // >= 0.5 门控
      };

      const existing: DedupCandidate[] = [
        { id: "existing", text: text1, salience: 0.8 },
      ];

      const result = await deduplicator.checkDuplicate(candidate, existing);
      expect(result.isDuplicate).toBe(true);
      expect(result.reason).toBe("high_value_duplicate");
      expect(result.duplicateOf).toBe("existing");
      expect(result.threshold).toBe(0.90);
    });

    it("应该保留相似度 < 0.90 的高 salience 候选", async () => {
      const text1 = "用户喜欢简洁的代码";
      const text2 = "系统需要完整的测试"; // 不同的文本
      embeddings.setSimilarity(text1, text2, 0.85);

      const candidate: DedupCandidate = {
        id: "new",
        text: text2,
        salience: 0.7,
      };

      const existing: DedupCandidate[] = [
        { id: "existing", text: text1, salience: 0.8 },
      ];

      const result = await deduplicator.checkDuplicate(candidate, existing);
      expect(result.isDuplicate).toBe(false);
    });
  });

  describe("checkDuplicate - 中文短文本阈值（0.88）", () => {
    it("应该对中文短文本使用 0.88 阈值", async () => {
      const text1 = "用户喜欢简洁代码"; // 8 个中文字
      const text2 = "用户喜欢简洁代码风格"; // 10 个中文字，非常相似
      embeddings.setSimilarity(text1, text2, 0.89);

      const candidate: DedupCandidate = {
        id: "new",
        text: text2,
        salience: 0.4, // 低 salience
      };

      const existing: DedupCandidate[] = [
        { id: "existing", text: text1, salience: 0.6 },
      ];

      const result = await deduplicator.checkDuplicate(candidate, existing);
      expect(result.isDuplicate).toBe(true);
      expect(result.threshold).toBe(0.88);
    });

    it("应该保留相似度 < 0.88 的中文短文本", async () => {
      const text1 = "用户喜欢简洁代码";
      const text2 = "系统需要文档"; // 不同的短文本
      embeddings.setSimilarity(text1, text2, 0.85);

      const candidate: DedupCandidate = {
        id: "new",
        text: text2,
        salience: 0.4,
      };

      const existing: DedupCandidate[] = [
        { id: "existing", text: text1, salience: 0.6 },
      ];

      const result = await deduplicator.checkDuplicate(candidate, existing);
      expect(result.isDuplicate).toBe(false);
    });
  });

  describe("checkDuplicate - salience 门控（>= 0.5）", () => {
    it("应该保留高 salience 新候选（即使与低 salience 旧候选相似）", async () => {
      const text1 = "用户喜欢简洁的代码风格";
      const text2 = "用户偏好简洁代码风格";
      embeddings.setSimilarity(text1, text2, 0.85);

      const candidate: DedupCandidate = {
        id: "new",
        text: text2,
        salience: 0.8, // 高 salience
      };

      const existing: DedupCandidate[] = [
        { id: "existing", text: text1, salience: 0.3 }, // 低 salience
      ];

      const result = await deduplicator.checkDuplicate(candidate, existing);
      // 新候选高价值，旧候选低价值，不判定为重复（由调用方处理替换逻辑）
      expect(result.isDuplicate).toBe(false);
    });

    it("应该去重低 salience 候选（与任何候选相似即去重）", async () => {
      const text1 = "用户喜欢简洁代码风格";
      const text2 = "用户喜欢简洁代码风格设计"; // 非常相似
      // 中文短文本（< 20字），需要 0.88 阈值
      embeddings.setSimilarity(text1, text2, 0.90);

      const candidate: DedupCandidate = {
        id: "new",
        text: text2,
        salience: 0.3, // 低 salience
      };

      const existing: DedupCandidate[] = [
        { id: "existing", text: text1, salience: 0.4 }, // 也是低 salience
      ];

      const result = await deduplicator.checkDuplicate(candidate, existing);
      expect(result.isDuplicate).toBe(true);
      expect(result.reason).toBe("low_salience_duplicate");
    });
  });

  describe("checkDuplicate - 边界情况", () => {
    it("应该处理空的已有候选列表", async () => {
      const candidate: DedupCandidate = {
        id: "new",
        text: "用户喜欢简洁代码",
        salience: 0.7,
      };

      const result = await deduplicator.checkDuplicate(candidate, []);
      expect(result.isDuplicate).toBe(false);
    });

    it("应该处理提供 vector 的候选", async () => {
      const vec1 = await embeddings.embed("用户喜欢简洁代码");
      const vec2 = await embeddings.embed("用户偏好简洁代码");

      const candidate: DedupCandidate = {
        id: "new",
        text: "用户偏好简洁代码",
        salience: 0.7,
        vector: vec2,
      };

      const existing: DedupCandidate[] = [
        {
          id: "existing",
          text: "用户喜欢简洁代码",
          salience: 0.8,
          vector: vec1,
        },
      ];

      const result = await deduplicator.checkDuplicate(candidate, existing);
      // 应该使用提供的 vector 而不是重新计算
      expect(result.isDuplicate).toBeDefined();
    });
  });

  describe("deduplicateBatch", () => {
    it("应该按 salience 降序去重（高价值优先保留）", async () => {
      const candidates: DedupCandidate[] = [
        { id: "c1", text: "用户喜欢简洁代码风格设计", salience: 0.5 },
        { id: "c2", text: "用户喜欢简洁代码风格设计理念", salience: 0.8 }, // 相似但 salience 更高
        { id: "c3", text: "项目需要文档说明内容完整", salience: 0.6 },
      ];

      embeddings.setSimilarity(candidates[0].text, candidates[1].text, 0.94);

      const result = await deduplicator.deduplicateBatch(candidates);

      // c2 (salience 0.8) 应该被保留，c1 (salience 0.5) 应该被去重
      expect(result.kept).toHaveLength(2);
      expect(result.removed).toHaveLength(1);
      expect(result.kept.find((c) => c.id === "c2")).toBeDefined();
      expect(result.removed[0].id).toBe("c1");
      expect(result.removed[0].dedupReason).toBe("high_value_duplicate");
    });

    it("应该处理空候选列表", async () => {
      const result = await deduplicator.deduplicateBatch([]);
      expect(result.kept).toHaveLength(0);
      expect(result.removed).toHaveLength(0);
    });

    it("应该保留所有不相似的候选", async () => {
      const candidates: DedupCandidate[] = [
        { id: "c1", text: "用户喜欢简洁代码风格设计", salience: 0.7 },
        { id: "c2", text: "项目需要详细文档说明内容", salience: 0.6 },
        { id: "c3", text: "团队使用敏捷开发流程方法", salience: 0.8 },
      ];

      // 设置低相似度（通过使用完全不同的文本）
      for (let i = 0; i < candidates.length; i++) {
        for (let j = i + 1; j < candidates.length; j++) {
          embeddings.setSimilarity(candidates[i].text, candidates[j].text, 0.5);
        }
      }

      const result = await deduplicator.deduplicateBatch(candidates);
      expect(result.kept).toHaveLength(3);
      expect(result.removed).toHaveLength(0);
    });
  });

  describe("配置管理", () => {
    it("应该使用默认配置", () => {
      const config = deduplicator.getConfig();
      expect(config.baseSimilarityThreshold).toBe(0.82);
      expect(config.highSimilarityThreshold).toBe(0.90);
      expect(config.shortTextThreshold).toBe(0.88);
      expect(config.shortTextMaxChars).toBe(20);
      expect(config.salienceGate).toBe(0.5);
    });

    it("应该允许自定义配置", () => {
      const customConfig: SemanticDedupConfig = {
        baseSimilarityThreshold: 0.85,
        salienceGate: 0.6,
      };
      const dedup = new SemanticDeduplicator(embeddings, customConfig);
      const config = dedup.getConfig();
      expect(config.baseSimilarityThreshold).toBe(0.85);
      expect(config.salienceGate).toBe(0.6);
      // 其他配置应该使用默认值
      expect(config.highSimilarityThreshold).toBe(0.90);
    });

    it("应该允许运行时更新配置", () => {
      deduplicator.updateConfig({ baseSimilarityThreshold: 0.75 });
      const config = deduplicator.getConfig();
      expect(config.baseSimilarityThreshold).toBe(0.75);
    });
  });

  describe("集成测试 - 综合场景", () => {
    it("应该正确处理混合 salience 和相似度的复杂场景", async () => {
      const candidates: DedupCandidate[] = [
        // 高 salience 组（应该只在 >= 0.90 时去重）
        { id: "h1", text: "用户喜欢使用TypeScript开发项目应用", salience: 0.9 },
        { id: "h2", text: "用户喜欢使用TypeScript开发项目应用系统", salience: 0.85 }, // 与 h1 高度相似
        // 低 salience 组（应该在 >= 0.82 时去重）
        { id: "l1", text: "项目使用React框架构建前端界面系统", salience: 0.4 },
        { id: "l2", text: "项目使用React框架构建前端界面系统应用", salience: 0.35 }, // 与 l1 相似
        // 独立候选
        { id: "u1", text: "团队使用敏捷开发流程管理工作进度", salience: 0.7 },
      ];

      // 设置相似度
      embeddings.setSimilarity(candidates[0].text, candidates[1].text, 0.93); // > 0.90
      embeddings.setSimilarity(candidates[2].text, candidates[3].text, 0.89); // > 0.82 but < 0.90

      const result = await deduplicator.deduplicateBatch(candidates);

      // h1 保留（salience 最高），h2 去重（高相似度）
      expect(result.kept.find((c) => c.id === "h1")).toBeDefined();
      expect(result.removed.find((c) => c.id === "h2")).toBeDefined();

      // l1 保留（salience 较高），l2 去重（低 salience 相似）
      expect(result.kept.find((c) => c.id === "l1")).toBeDefined();
      expect(result.removed.find((c) => c.id === "l2")).toBeDefined();

      // u1 保留（独立）
      expect(result.kept.find((c) => c.id === "u1")).toBeDefined();

      expect(result.kept).toHaveLength(3);
      expect(result.removed).toHaveLength(2);
    });
  });
});
