import OpenAI from "openai";
import pLimit from "p-limit";
import retry from "p-retry";
import type { MemoryConfig } from "../config";

export interface EmbeddingsOptions {
  /** 最大并发请求数 */
  concurrency?: number;
  /** 最大重试次数 */
  maxRetries?: number;
  /** 每批最大处理文本数 */
  maxBatchSize?: number;
}

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_BATCH_SIZE = 20;

/**
 * 标记一类不应重试的 embedding 错误（鉴权失败、余额不足、参数错误）。
 * 重试这些错误只会徒增延迟与配额消耗，命中即终止 p-retry。
 */
class NonRetryableEmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableEmbeddingError";
  }
}

/**
 * 从 OpenAI SDK 抛出的错误对象中尽力提取 HTTP 状态码。
 * SDK 错误通常带 `status`；部分场景下信息只在 message 文本里。
 */
function extractHttpStatus(error: unknown): number | undefined {
  if (error && typeof error === "object") {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") {
      return status;
    }
  }
  if (error instanceof Error) {
    const match = error.message.match(/\b(4\d{2}|5\d{2})\b/);
    if (match) {
      return Number(match[1]);
    }
  }
  return undefined;
}

/**
 * 从 SDK 错误中尽力提取服务商业务错误体 { code, message }。
 * OpenAI SDK 把响应体挂在 `error.error`；SiliconFlow 余额不足返回
 * { code: 30001, message: "...balance is insufficient" }。
 */
function extractErrorBody(error: unknown): { code?: number; message?: string } | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const body = (error as { error?: unknown }).error;
  if (body && typeof body === "object") {
    const code = (body as { code?: unknown }).code;
    const message = (body as { message?: unknown }).message;
    return {
      code: typeof code === "number" ? code : undefined,
      message: typeof message === "string" ? message : undefined,
    };
  }
  return undefined;
}

/**
 * 向量化服务类
 * 支持批量向量化、并发控制、请求重试
 */
export class Embeddings {
  private client: OpenAI;
  private limit: ReturnType<typeof pLimit>;
  private maxRetries: number;
  private maxBatchSize: number;
  private model: string;

  constructor(
    private readonly embeddingConfig: MemoryConfig["embedding"],
    private readonly batchConfig?: MemoryConfig["batchProcessing"],
    options: EmbeddingsOptions = {},
  ) {
    // 验证配置
    this.validateConfig(embeddingConfig);

    this.client = new OpenAI({
      apiKey: embeddingConfig.apiKey,
      baseURL: embeddingConfig.baseURL,
    });

    this.model = embeddingConfig.model ?? "text-embedding-3-small";

    const concurrency = options.concurrency ?? batchConfig?.concurrency ?? DEFAULT_CONCURRENCY;
    this.maxRetries = options.maxRetries ?? batchConfig?.retryAttempts ?? DEFAULT_MAX_RETRIES;
    this.maxBatchSize = options.maxBatchSize ?? batchConfig?.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;

    this.limit = pLimit(concurrency);
  }

  /**
   * 验证 embedding 配置
   * 提供友好的错误提示，帮助用户快速定位配置问题
   */
  private validateConfig(config: MemoryConfig["embedding"]): void {
    // 检查 apiKey 是否为空或仍是占位符格式
    if (!config.apiKey || config.apiKey.trim().length === 0) {
      throw new Error(
        `embedding.apiKey 配置错误：API Key 为空\n\n` +
        `请按以下步骤配置：\n` +
        `1. 获取 API Key（如 OpenAI: https://platform.openai.com/api-keys）\n` +
        `2. 在配置文件中设置：\n` +
        `   方式 A（推荐）：使用环境变量 "apiKey": "\${OPENAI_API_KEY}"\n` +
        `   方式 B：直接填写实际值 "apiKey": "sk-proj-..."\n` +
        `3. 如使用环境变量，需在 Shell 配置文件中设置并重新加载\n\n` +
        `详细文档：docs/troubleshooting/env-setup.md`
      );
    }

    // 检查是否仍是占位符格式（未解析的环境变量）
    if (config.apiKey.includes("${") || config.apiKey.includes("}")) {
      throw new Error(
        `embedding.apiKey 配置错误：环境变量未正确解析\n\n` +
        `当前值：${config.apiKey}\n\n` +
        `这通常意味着环境变量未设置。请检查：\n` +
        `1. 环境变量是否已在 Shell 配置文件中设置\n` +
        `2. 是否已重新加载配置（source ~/.zshrc 或重启终端）\n` +
        `3. 环境变量名是否拼写正确\n\n` +
        `详细文档：docs/troubleshooting/env-setup.md`
      );
    }

    // 检查 baseURL 格式
    if (!config.baseURL || config.baseURL.trim().length === 0) {
      throw new Error(
        `embedding.baseURL 配置错误：Base URL 为空\n\n` +
        `请在配置文件中设置正确的 API 基础 URL：\n` +
        `- OpenAI: "baseURL": "https://api.openai.com/v1"\n` +
        `- 其他提供商请参考对应文档\n\n` +
        `详细文档：docs/troubleshooting/env-setup.md`
      );
    }

    // 检查 baseURL 是否仍是占位符
    if (config.baseURL.includes("${") || config.baseURL.includes("}")) {
      throw new Error(
        `embedding.baseURL 配置错误：环境变量未正确解析\n\n` +
        `当前值：${config.baseURL}\n\n` +
        `请确保相关环境变量已正确设置并重新加载 Shell 配置。\n\n` +
        `详细文档：docs/troubleshooting/env-setup.md`
      );
    }

    // 验证 baseURL 格式（基本的 URL 格式检查）
    try {
      new URL(config.baseURL);
    } catch {
      throw new Error(
        `embedding.baseURL 配置错误：无效的 URL 格式\n\n` +
        `当前值：${config.baseURL}\n\n` +
        `请提供有效的 HTTP/HTTPS URL，例如：\n` +
        `- https://api.openai.com/v1\n` +
        `- http://localhost:11434/v1（本地 Ollama）\n\n` +
        `详细文档：docs/troubleshooting/env-setup.md`
      );
    }
  }

  /**
   * 单个文本向量化
   * @param text 要向量化的文本
   * @returns 向量数组
   */
  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  /**
   * 批量文本向量化
   * @param texts 文本数组
   * @returns 向量数组，顺序与输入对应
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    // 分批处理
    const batches: string[][] = [];
    for (let i = 0; i < texts.length; i += this.maxBatchSize) {
      batches.push(texts.slice(i, i + this.maxBatchSize));
    }

    // 并发处理所有批次
    const batchPromises = batches.map(batch =>
      this.limit(() => this.processBatch(batch))
    );

    const results = await Promise.all(batchPromises);
    return results.flat();
  }

  /**
   * 处理单个批次的向量化请求
   *
   * 关键边界：OpenAI SDK 对部分兼容服务商（如 SiliconFlow）的非 2xx 响应
   * 会出现 "status code (no body)" 的笼统报错，吞掉了真实错误体（如余额不足
   * code 30001）。这里在抛出前主动提取 SDK error 上的 status/body，转换成
   * 可操作的中文提示，避免用户被误导去排查 API Key。
   */
  private async processBatch(batch: string[]): Promise<number[][]> {
    return retry(
      async () => {
        try {
          const response = await this.client.embeddings.create({
            model: this.model,
            input: batch,
            encoding_format: "float",
          });

          // 按输入顺序返回结果
          return response.data.map(item => item.embedding);
        } catch (error) {
          throw this.explainEmbeddingError(error);
        }
      },
      {
        retries: this.maxRetries,
        minTimeout: 1000,
        maxTimeout: 5000,
        factor: 2,
        // 鉴权/余额/参数类错误重试无意义，命中即终止重试。
        shouldRetry: (error) => !(error instanceof NonRetryableEmbeddingError),
      }
    );
  }

  /**
   * 把 OpenAI SDK 抛出的底层错误转换为带根因的可读错误。
   * 优先解析 SiliconFlow 等服务商返回的 { code, message } 业务错误体。
   */
  private explainEmbeddingError(error: unknown): Error {
    const status = extractHttpStatus(error);
    const body = extractErrorBody(error);
    const providerMessage = body?.message ?? (error instanceof Error ? error.message : String(error));
    const providerCode = body?.code;

    // SiliconFlow 余额不足：code 30001 / 文案含 balance insufficient。
    const looksLikeBalance =
      providerCode === 30001 ||
      /balance|insufficient|余额|欠费|arrears/i.test(providerMessage);

    if (status === 403 && looksLikeBalance) {
      return new NonRetryableEmbeddingError(
        `Embedding 服务返回 403：账户余额不足。\n` +
        `服务商原始信息：${providerMessage}${providerCode != null ? `（code ${providerCode}）` : ""}\n\n` +
        `请前往对应服务商控制台充值或更换有额度的 API Key（model=${this.model}）。`,
      );
    }

    if (status === 401 || status === 403) {
      return new NonRetryableEmbeddingError(
        `Embedding 服务返回 ${status}：鉴权或权限失败。\n` +
        `服务商原始信息：${providerMessage}${providerCode != null ? `（code ${providerCode}）` : ""}\n\n` +
        `请确认 API Key 有效、未过期，且有权访问该 embedding 模型（model=${this.model}）。`,
      );
    }

    if (status === 429) {
      // 限流可重试，保持可重试类型。
      return new Error(`Embedding 服务返回 429（限流）：${providerMessage}`);
    }

    if (status === 400 || status === 404) {
      return new NonRetryableEmbeddingError(
        `Embedding 服务返回 ${status}：${providerMessage}\n\n` +
        `请确认 model（当前 ${this.model}）与 baseURL 是否与服务商匹配。`,
      );
    }

    // 其他错误：保留原始信息但补上 status，便于定位。
    return new Error(
      `Embedding 请求失败${status != null ? `（HTTP ${status}）` : ""}：${providerMessage}`,
    );
  }
}
