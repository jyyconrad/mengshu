/**
 * LLM chat completion 客户端。
 *
 * 本文件做什么：
 *   - 封装 OpenAI 兼容的 chat.completions 调用，供上层做摘要 / 抽取等需要生成式
 *     能力的场景使用。
 *   - 定义统一的 LlmClient 接口（complete / summarize / available），让调用方
 *     无需关心底层是否真正配置了 LLM。
 *   - 提供 NullLlmClient 作为"未配置 LLM 时的安全降级占位"：available=false，
 *     调用 complete / summarize 直接抛错，强制调用方先检查 available。
 *
 * 核心流程：
 *   - OpenAiLlmClient 用 new OpenAI({apiKey, baseURL}) 创建客户端（可注入 fake
 *     便于测试），用 p-limit 控制并发、p-retry 做指数退避重试。
 *   - complete(messages) 调 chat.completions.create，取 choices[0].message.content。
 *   - summarize(text, instruction) 拼成 system(instruction)+user(text) 后调 complete。
 *   - createLlmClient(config) 根据配置路由到 OpenAiLlmClient 或 NullLlmClient。
 *
 * 关键边界：
 *   - 未配置 LLM（config 为 undefined）时返回 NullLlmClient，绝不静默成功。
 *   - 响应缺少 content 时视为失败抛错（可被重试覆盖）。
 *   - 不在本文件做内容安全过滤，调用方负责输入清洗。
 */

import OpenAI from "openai";
import pLimit from "p-limit";
import retry from "p-retry";
import type { MemoryConfig } from "../config.js";

/** 单条 chat 消息。 */
export interface LlmCompletionMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * 结构化抽取使用的简化 JSON Schema（§2.2 structured-output 约束）。
 *
 * 说明：本项目当前未引入 zod / ajv 等校验库，为避免新增依赖带来的
 * 风险，extractStructured 仅依赖 schema 的 `required` 字段做运行时校验
 * （检查这些字段在返回 JSON 中是否存在）。schema 的其余字段（properties
 * 等）仍会序列化进 system message 作为结构提示。后续若需更严格的类型 /
 * 取值校验，可在此基础上接入 zod schema 而无需改动调用方契约。
 */
export interface SimpleJsonSchema {
  /** 标记必须存在的字段名，extractStructured 会逐一校验其存在性。 */
  required?: string[];
  /** schema 其余约束（properties / type 等），仅作 prompt 提示用途。 */
  [key: string]: unknown;
}

/** complete 的可选调用参数（覆盖配置默认值）。 */
export interface LlmCompletionOptions {
  maxTokens?: number;
  temperature?: number;
}

/** 统一的 LLM 客户端接口。 */
export interface LlmClient {
  /** 执行一次 chat completion，返回 assistant 文本。 */
  complete(messages: LlmCompletionMessage[], options?: LlmCompletionOptions): Promise<string>;
  /** 将正文按指令摘要，内部拼成 system+user prompt。 */
  summarize(text: string, instruction: string): Promise<string>;
  /**
   * 结构化抽取：强制 JSON 输出并解析为 T，失败重试最多 3 次。
   * D-08 (§2.2): 使用 structured outputs + schema 运行时校验。
   * D-18: temperature 一律为 0.0，不受 options/config 覆盖。
   */
  extractStructured<T>(
    messages: LlmCompletionMessage[],
    schema: SimpleJsonSchema,
    options?: LlmCompletionOptions,
  ): Promise<T>;
  /** 是否真正可用（已配置 LLM）。调用方应先检查再使用。 */
  readonly available: boolean;
}

/**
 * chat.completions.create 的最小结构契约。
 * 抽出该接口便于测试注入 fake，不依赖真实 OpenAI 网络调用。
 */
export interface ChatCompletionClient {
  chat: {
    completions: {
      create(params: {
        model: string;
        messages: LlmCompletionMessage[];
        max_tokens?: number;
        temperature?: number;
        response_format?: { type: "json_object" };
      }): Promise<{ choices: Array<{ message: { content: string | null } }> }>;
    };
  };
}

/** OpenAiLlmClient 的构造可选项。 */
export interface OpenAiLlmClientOptions {
  /** 注入的 chat client，默认用真实 OpenAI SDK。测试时传入 fake。 */
  client?: ChatCompletionClient;
  /** 最大并发数，默认 3。 */
  concurrency?: number;
  /** 最大重试次数，默认 3。 */
  maxRetries?: number;
  /** 重试最小退避（毫秒），默认 1000。测试可调小。 */
  minTimeout?: number;
  /** 重试最大退避（毫秒），默认 5000。 */
  maxTimeout?: number;
}

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MIN_TIMEOUT = 1000;
const DEFAULT_MAX_TIMEOUT = 5000;

/**
 * 基于 OpenAI 兼容接口的 chat completion 客户端实现。
 */
export class OpenAiLlmClient implements LlmClient {
  public readonly available = true;

  private readonly client: ChatCompletionClient;
  private readonly limit: ReturnType<typeof pLimit>;
  private readonly model: string;
  private readonly maxTokens?: number;
  private readonly temperature?: number;
  private readonly maxRetries: number;
  private readonly minTimeout: number;
  private readonly maxTimeout: number;

  constructor(
    private readonly llmConfig: NonNullable<MemoryConfig["llm"]>,
    options: OpenAiLlmClientOptions = {},
  ) {
    this.client =
      options.client ??
      (new OpenAI({
        apiKey: llmConfig.apiKey,
        baseURL: llmConfig.baseURL,
      }) as unknown as ChatCompletionClient);

    this.model = llmConfig.model;
    this.maxTokens = llmConfig.maxTokens;
    this.temperature = llmConfig.temperature;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.minTimeout = options.minTimeout ?? DEFAULT_MIN_TIMEOUT;
    this.maxTimeout = options.maxTimeout ?? DEFAULT_MAX_TIMEOUT;
    this.limit = pLimit(options.concurrency ?? DEFAULT_CONCURRENCY);
  }

  async complete(
    messages: LlmCompletionMessage[],
    options: LlmCompletionOptions = {},
  ): Promise<string> {
    const maxTokens = options.maxTokens ?? this.maxTokens;
    const temperature = options.temperature ?? this.temperature;

    return this.limit(() =>
      retry(
        async () => {
          const response = await this.client.chat.completions.create({
            model: this.model,
            messages,
            ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
            ...(temperature !== undefined ? { temperature } : {}),
          });
          const content = response.choices?.[0]?.message?.content;
          if (typeof content !== "string" || content.length === 0) {
            throw new Error("LLM completion returned empty content");
          }
          return content;
        },
        {
          retries: this.maxRetries,
          minTimeout: this.minTimeout,
          maxTimeout: this.maxTimeout,
          factor: 2,
        },
      ),
    );
  }

  async summarize(text: string, instruction: string): Promise<string> {
    return this.complete([
      { role: "system", content: instruction },
      { role: "user", content: text },
    ]);
  }

  /**
   * 结构化抽取实现。
   * D-08 (§2.2): 使用 structured outputs，运行时校验 schema required 字段。
   * D-18: temperature 强制固定为 0.0，覆盖任何 options/config 设置。
   * §10.4: 重试使用退避策略，最多 3 次，失败后抛错并应记 audit。
   */
  async extractStructured<T>(
    messages: LlmCompletionMessage[],
    schema: SimpleJsonSchema,
    options: LlmCompletionOptions = {},
  ): Promise<T> {
    const schemaHint = `Respond with valid JSON matching this schema:\n${JSON.stringify(schema, null, 2)}`;
    const augmented: LlmCompletionMessage[] = [
      { role: "system", content: schemaHint },
      ...messages,
    ];

    return retry(
      async () => {
        const maxTokens = options.maxTokens ?? this.maxTokens;
        // D-18: temperature 一律 0.0，不受 options/config 覆盖
        const temperature = 0.0;

        const response = await this.limit(() =>
          this.client.chat.completions.create({
            model: this.model,
            messages: augmented,
            ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
            temperature, // 显式传递 0.0
            response_format: { type: "json_object" },
          }),
        );

        const content = response.choices?.[0]?.message?.content;
        if (typeof content !== "string" || content.length === 0) {
          throw new Error("LLM returned empty content");
        }

        const parsed = JSON.parse(content) as T;

        // D-08 (§2.2): schema 运行时校验 - 检查 required 字段是否存在
        if (schema.required && Array.isArray(schema.required)) {
          const missing = schema.required.filter(
            (field) => parsed && typeof parsed === "object" && !(field in parsed),
          );
          if (missing.length > 0) {
            throw new Error(
              `Schema validation failed: missing required fields: ${missing.join(", ")}`,
            );
          }
        }

        return parsed;
      },
      {
        // §10.4: 最多 3 次重试，指数退避
        retries: this.maxRetries,
        minTimeout: this.minTimeout,
        maxTimeout: this.maxTimeout,
        factor: 2,
      },
    );
  }
}

/**
 * 未配置 LLM 时的安全降级占位。
 * available=false；任何生成调用都会抛错，强制调用方先检查 available。
 */
export class NullLlmClient implements LlmClient {
  public readonly available = false;

  async complete(_messages: LlmCompletionMessage[], _options?: LlmCompletionOptions): Promise<string> {
    throw new Error("LLM is not configured: set the `llm` config block to enable completions");
  }

  async summarize(_text: string, _instruction: string): Promise<string> {
    throw new Error("LLM is not configured: set the `llm` config block to enable summaries");
  }

  async extractStructured<T>(
    _messages: LlmCompletionMessage[],
    _schema: SimpleJsonSchema,
    _options?: LlmCompletionOptions,
  ): Promise<T> {
    throw new Error("LLM is not configured: set the `llm` config block to enable structured extraction");
  }
}

/**
 * 根据配置创建 LLM 客户端。
 * 有 llm 配置返回 OpenAiLlmClient，否则返回 NullLlmClient。
 */
export function createLlmClient(config: MemoryConfig["llm"] | undefined): LlmClient {
  if (!config) {
    return new NullLlmClient();
  }
  return new OpenAiLlmClient(config);
}
