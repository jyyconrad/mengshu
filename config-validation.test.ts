/**
 * 配置验证和友好错误提示测试
 */
import { describe, it, expect } from "vitest";
import { memoryConfigSchema } from "./config.js";

describe("配置验证和错误提示", () => {
  describe("环境变量解析错误", () => {
    it("应该在环境变量未设置时提供友好的错误提示", () => {
      const config = {
        embedding: {
          apiKey: "${NONEXISTENT_ENV_VAR}",
          baseURL: "https://api.openai.com/v1",
        },
      };

      expect(() => memoryConfigSchema.parse(config)).toThrow(/环境变量 NONEXISTENT_ENV_VAR 未设置/);
      expect(() => memoryConfigSchema.parse(config)).toThrow(/Shell 配置文件/);
      expect(() => memoryConfigSchema.parse(config)).toThrow(/export NONEXISTENT_ENV_VAR/);
      expect(() => memoryConfigSchema.parse(config)).toThrow(/详细文档/);
    });

    it("应该在 baseURL 环境变量未设置时提供字段名信息", () => {
      const config = {
        embedding: {
          apiKey: "sk-test-key",
          baseURL: "${NONEXISTENT_BASE_URL}",
        },
      };

      expect(() => memoryConfigSchema.parse(config)).toThrow(/环境变量 NONEXISTENT_BASE_URL 未设置/);
      expect(() => memoryConfigSchema.parse(config)).toThrow(/embedding.baseURL/);
    });

    it("应该在 LLM apiKey 环境变量未设置时提供字段名信息", () => {
      const config = {
        embedding: {
          apiKey: "sk-test-key",
          baseURL: "https://api.openai.com/v1",
        },
        llm: {
          provider: "openai" as const,
          model: "gpt-4o",
          apiKey: "${NONEXISTENT_LLM_KEY}",
        },
      };

      expect(() => memoryConfigSchema.parse(config)).toThrow(/环境变量 NONEXISTENT_LLM_KEY 未设置/);
      expect(() => memoryConfigSchema.parse(config)).toThrow(/llm.apiKey/);
    });
  });

  describe("配置缺失错误", () => {
    it("应该在 apiKey 缺失时提供友好提示", () => {
      const config = {
        embedding: {
          baseURL: "https://api.openai.com/v1",
        },
      };

      expect(() => memoryConfigSchema.parse(config)).toThrow(/embedding.apiKey is required/);
    });

    it("应该在 baseURL 缺失时提供友好提示", () => {
      const config = {
        embedding: {
          apiKey: "sk-test-key",
        },
      };

      expect(() => memoryConfigSchema.parse(config)).toThrow(/embedding.baseURL is required/);
    });
  });

  describe("成功解析", () => {
    it("应该成功解析有效的配置（不使用环境变量）", () => {
      const config = {
        embedding: {
          apiKey: "sk-test-key-123",
          baseURL: "https://api.openai.com/v1",
          model: "text-embedding-3-small",
        },
      };

      const result = memoryConfigSchema.parse(config);
      expect(result.embedding.apiKey).toBe("sk-test-key-123");
      expect(result.embedding.baseURL).toBe("https://api.openai.com/v1");
      expect(result.embedding.model).toBe("text-embedding-3-small");
    });

    it("应该成功解析使用环境变量的配置（当环境变量已设置）", () => {
      // 设置测试环境变量
      process.env.TEST_API_KEY = "sk-test-from-env";
      process.env.TEST_BASE_URL = "https://api.test.com/v1";

      const config = {
        embedding: {
          apiKey: "${TEST_API_KEY}",
          baseURL: "${TEST_BASE_URL}",
        },
      };

      const result = memoryConfigSchema.parse(config);
      expect(result.embedding.apiKey).toBe("sk-test-from-env");
      expect(result.embedding.baseURL).toBe("https://api.test.com/v1");

      // 清理环境变量
      delete process.env.TEST_API_KEY;
      delete process.env.TEST_BASE_URL;
    });

    it("应该在配置中混合使用环境变量和直接值", () => {
      process.env.TEST_API_KEY_2 = "sk-test-from-env-2";

      const config = {
        embedding: {
          apiKey: "${TEST_API_KEY_2}",
          baseURL: "https://api.direct.com/v1",
        },
      };

      const result = memoryConfigSchema.parse(config);
      expect(result.embedding.apiKey).toBe("sk-test-from-env-2");
      expect(result.embedding.baseURL).toBe("https://api.direct.com/v1");

      delete process.env.TEST_API_KEY_2;
    });
  });

  describe("Supabase 配置验证", () => {
    it("应该在 Supabase URL 环境变量未设置时提供友好提示", () => {
      const config = {
        embedding: {
          apiKey: "sk-test-key",
          baseURL: "https://api.openai.com/v1",
        },
        dbType: "supabase" as const,
        supabase: {
          url: "${NONEXISTENT_SUPABASE_URL}",
          serviceKey: "test-key",
        },
      };

      expect(() => memoryConfigSchema.parse(config)).toThrow(/环境变量 NONEXISTENT_SUPABASE_URL 未设置/);
      expect(() => memoryConfigSchema.parse(config)).toThrow(/supabase.url/);
    });

    it("应该在 Supabase serviceKey 环境变量未设置时提供友好提示", () => {
      const config = {
        embedding: {
          apiKey: "sk-test-key",
          baseURL: "https://api.openai.com/v1",
        },
        dbType: "supabase" as const,
        supabase: {
          url: "https://test.supabase.co",
          serviceKey: "${NONEXISTENT_SERVICE_KEY}",
        },
      };

      expect(() => memoryConfigSchema.parse(config)).toThrow(/环境变量 NONEXISTENT_SERVICE_KEY 未设置/);
      expect(() => memoryConfigSchema.parse(config)).toThrow(/supabase.serviceKey/);
    });
  });

  describe("PostgreSQL 配置验证", () => {
    it("应该在 PostgreSQL password 环境变量未设置时提供友好提示", () => {
      const config = {
        embedding: {
          apiKey: "sk-test-key",
          baseURL: "https://api.openai.com/v1",
        },
        dbType: "postgres" as const,
        postgres: {
          host: "localhost",
          port: 5432,
          database: "memory",
          user: "postgres",
          password: "${NONEXISTENT_PG_PASSWORD}",
        },
      };

      expect(() => memoryConfigSchema.parse(config)).toThrow(/环境变量 NONEXISTENT_PG_PASSWORD 未设置/);
      expect(() => memoryConfigSchema.parse(config)).toThrow(/postgres.password/);
    });
  });
});
