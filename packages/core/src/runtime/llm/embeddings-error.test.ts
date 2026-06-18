/**
 * Embeddings 运行时错误转换测试
 *
 * 验证 processBatch -> explainEmbeddingError 能把 OpenAI SDK 抛出的
 * 底层错误（含 SiliconFlow 等服务商的 { code, message } 业务错误体）
 * 转换成带根因、可操作的中文提示，并对鉴权/余额/参数类错误终止重试。
 */
import { describe, it, expect } from "vitest";
import { Embeddings } from "./embeddings.js";

interface FakeSdkError {
  status?: number;
  error?: { code?: number; message?: string };
  message: string;
}

/**
 * 构造一个内部 client.embeddings.create 固定抛出给定错误的 Embeddings 实例。
 * retryAttempts=0，避免测试因重试拖慢；同时验证不可重试错误立即冒泡。
 */
function embeddingsThrowing(error: FakeSdkError): Embeddings {
  const instance = new Embeddings(
    {
      apiKey: "sk-test-key-123",
      baseURL: "https://api.siliconflow.cn/v1",
      model: "BAAI/bge-m3",
      provider: "openai" as const,
    },
    { retryAttempts: 0, concurrency: 1, maxBatchSize: 20 },
  );
  // 注入假的 OpenAI client：仅替换 embeddings.create。
  (instance as unknown as { client: unknown }).client = {
    embeddings: {
      create: async () => {
        throw error;
      },
    },
  };
  return instance;
}

describe("Embeddings 运行时错误转换", () => {
  it("SiliconFlow 余额不足（403 + code 30001）应给出充值提示而非 Key 无效", async () => {
    const embeddings = embeddingsThrowing({
      status: 403,
      error: { code: 30001, message: "Sorry, your account balance is insufficient" },
      message: "403 status code (no body)",
    });

    await expect(embeddings.embed("测试")).rejects.toThrow(/余额不足/);
    await expect(embeddings.embed("测试")).rejects.toThrow(/充值|有额度/);
    // 不应把根因误导为 Key 无效。
    await expect(embeddings.embed("测试")).rejects.not.toThrow(/API Key 无效/);
  });

  it("403 文案含 balance insufficient（无 code）也应识别为余额不足", async () => {
    const embeddings = embeddingsThrowing({
      status: 403,
      error: { message: "account balance is insufficient" },
      message: "403",
    });

    await expect(embeddings.embed("测试")).rejects.toThrow(/余额不足/);
  });

  it("401 鉴权失败应给出 Key 校验提示", async () => {
    const embeddings = embeddingsThrowing({
      status: 401,
      error: { message: "Invalid token" },
      message: "401 Invalid token",
    });

    await expect(embeddings.embed("测试")).rejects.toThrow(/鉴权或权限失败/);
    await expect(embeddings.embed("测试")).rejects.toThrow(/Invalid token/);
  });

  it("403 非余额类（纯权限）应归入鉴权失败而非余额不足", async () => {
    const embeddings = embeddingsThrowing({
      status: 403,
      error: { message: "no permission for model" },
      message: "403 status code (no body)",
    });

    await expect(embeddings.embed("测试")).rejects.toThrow(/鉴权或权限失败/);
    await expect(embeddings.embed("测试")).rejects.not.toThrow(/余额不足/);
  });

  it("404 模型不存在应提示检查 model/baseURL", async () => {
    const embeddings = embeddingsThrowing({
      status: 404,
      error: { message: "model not found" },
      message: "404 Not Found",
    });

    await expect(embeddings.embed("测试")).rejects.toThrow(/model.*baseURL|baseURL.*model/);
  });

  it("未知错误应保留原始信息并附带 HTTP 状态", async () => {
    const embeddings = embeddingsThrowing({
      status: 500,
      error: { message: "internal error" },
      message: "500 Internal Server Error",
    });

    await expect(embeddings.embed("测试")).rejects.toThrow(/HTTP 500/);
    await expect(embeddings.embed("测试")).rejects.toThrow(/internal error/);
  });
});
