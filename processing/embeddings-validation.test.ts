/**
 * Embeddings 配置验证测试
 */
import { describe, it, expect } from "vitest";
import { Embeddings } from "./embeddings.js";

describe("Embeddings 配置验证", () => {
  describe("apiKey 验证", () => {
    it("应该在 apiKey 为空时抛出友好错误", () => {
      const config = {
        apiKey: "",
        baseURL: "https://api.openai.com/v1",
        model: "text-embedding-3-small",
        provider: "openai" as const,
      };

      expect(() => new Embeddings(config)).toThrow(/embedding.apiKey 配置错误/);
      expect(() => new Embeddings(config)).toThrow(/API Key 为空/);
      expect(() => new Embeddings(config)).toThrow(/获取 API Key/);
      expect(() => new Embeddings(config)).toThrow(/详细文档/);
    });

    it("应该在 apiKey 只包含空格时抛出友好错误", () => {
      const config = {
        apiKey: "   ",
        baseURL: "https://api.openai.com/v1",
        model: "text-embedding-3-small",
        provider: "openai" as const,
      };

      expect(() => new Embeddings(config)).toThrow(/embedding.apiKey 配置错误/);
      expect(() => new Embeddings(config)).toThrow(/API Key 为空/);
    });

    it("应该在 apiKey 仍包含占位符时抛出友好错误", () => {
      const config = {
        apiKey: "${OPENAI_API_KEY}",
        baseURL: "https://api.openai.com/v1",
        model: "text-embedding-3-small",
        provider: "openai" as const,
      };

      expect(() => new Embeddings(config)).toThrow(/embedding.apiKey 配置错误/);
      expect(() => new Embeddings(config)).toThrow(/环境变量未正确解析/);
      expect(() => new Embeddings(config)).toThrow(/当前值.*OPENAI_API_KEY/);
      expect(() => new Embeddings(config)).toThrow(/环境变量是否已在 Shell 配置文件中设置/);
    });

    it("应该在 apiKey 包含部分占位符时抛出友好错误", () => {
      const config = {
        apiKey: "sk-${API_KEY_SUFFIX}",
        baseURL: "https://api.openai.com/v1",
        model: "text-embedding-3-small",
        provider: "openai" as const,
      };

      expect(() => new Embeddings(config)).toThrow(/环境变量未正确解析/);
    });
  });

  describe("baseURL 验证", () => {
    it("应该在 baseURL 为空时抛出友好错误", () => {
      const config = {
        apiKey: "sk-test-key-123",
        baseURL: "",
        model: "text-embedding-3-small",
        provider: "openai" as const,
      };

      expect(() => new Embeddings(config)).toThrow(/embedding.baseURL 配置错误/);
      expect(() => new Embeddings(config)).toThrow(/Base URL 为空/);
      expect(() => new Embeddings(config)).toThrow(/OpenAI.*https:\/\/api.openai.com\/v1/);
    });

    it("应该在 baseURL 仍包含占位符时抛出友好错误", () => {
      const config = {
        apiKey: "sk-test-key-123",
        baseURL: "${OPENAI_BASE_URL}",
        model: "text-embedding-3-small",
        provider: "openai" as const,
      };

      expect(() => new Embeddings(config)).toThrow(/embedding.baseURL 配置错误/);
      expect(() => new Embeddings(config)).toThrow(/环境变量未正确解析/);
    });

    it("应该在 baseURL 格式无效时抛出友好错误", () => {
      const config = {
        apiKey: "sk-test-key-123",
        baseURL: "not-a-valid-url",
        model: "text-embedding-3-small",
        provider: "openai" as const,
      };

      expect(() => new Embeddings(config)).toThrow(/embedding.baseURL 配置错误/);
      expect(() => new Embeddings(config)).toThrow(/无效的 URL 格式/);
      expect(() => new Embeddings(config)).toThrow(/https:\/\/api.openai.com\/v1/);
    });

    it("应该接受有效的 HTTP URL", () => {
      const config = {
        apiKey: "sk-test-key-123",
        baseURL: "http://localhost:11434/v1",
        model: "text-embedding-3-small",
        provider: "openai" as const,
      };

      expect(() => new Embeddings(config)).not.toThrow();
    });

    it("应该接受有效的 HTTPS URL", () => {
      const config = {
        apiKey: "sk-test-key-123",
        baseURL: "https://api.openai.com/v1",
        model: "text-embedding-3-small",
        provider: "openai" as const,
      };

      expect(() => new Embeddings(config)).not.toThrow();
    });
  });

  describe("成功创建实例", () => {
    it("应该成功创建 Embeddings 实例（有效配置）", () => {
      const config = {
        apiKey: "sk-test-key-123",
        baseURL: "https://api.openai.com/v1",
        model: "text-embedding-3-small",
        provider: "openai" as const,
      };

      const embeddings = new Embeddings(config);
      expect(embeddings).toBeDefined();
    });

    it("应该成功创建实例（使用默认 model）", () => {
      const config = {
        apiKey: "sk-test-key-123",
        baseURL: "https://api.openai.com/v1",
        provider: "openai" as const,
      };

      const embeddings = new Embeddings(config);
      expect(embeddings).toBeDefined();
    });

    it("应该成功创建实例（带批处理配置）", () => {
      const config = {
        apiKey: "sk-test-key-123",
        baseURL: "https://api.openai.com/v1",
        model: "text-embedding-3-small",
        provider: "openai" as const,
      };

      const batchConfig = {
        maxBatchSize: 10,
        concurrency: 2,
        retryAttempts: 3,
      };

      const embeddings = new Embeddings(config, batchConfig);
      expect(embeddings).toBeDefined();
    });
  });
});
