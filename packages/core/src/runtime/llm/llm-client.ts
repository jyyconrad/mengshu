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
 * 说明：本项目未引入 zod / ajv 等校验库，extractStructured 自带一个轻量
 * 递归校验器（见 OpenAiLlmClient.validateSchema / validateValueConstraints），
 * 在运行时校验下列约束（P1-Q1 修复后）：
 *   - `required`：字段存在性（含嵌套对象与数组元素）；
 *   - `type`：类型匹配，支持类型数组如 `["string", "null"]`；
 *   - `enum`：取值枚举（允许 `null` 作为合法枚举值）；
 *   - `minimum`/`maximum`：数值范围；
 *   - `minLength`/`maxLength`：字符串长度；
 *   - `minItems`/`maxItems`：数组长度。
 * 未声明的约束自动跳过，保证向后兼容。schema 全文仍会序列化进 system
 * message 作为结构提示。后续若需更完整的 JSON Schema 语义，可平滑替换为 ajv
 * 而无需改动调用方契约。
 */
export interface SimpleJsonSchema {
  /** 标记必须存在的字段名，extractStructured 会逐一校验其存在性。 */
  required?: string[];
  /** schema 其余约束（properties / type / enum / minimum 等），运行时按需校验。 */
  [key: string]: unknown;
}

/** complete 的可选调用参数（覆盖配置默认值）。 */
export interface LlmCompletionOptions {
  maxTokens?: number;
  /** 调用方提供的 abort signal，用于取消请求。 */
  signal?: AbortSignal;
  /** 请求超时时间（毫秒），超时后自动取消。未设置则无超时限制。 */
  timeout?: number;
  /**
   * 模型用途类型，用于选择分层模型。
   * - extraction: 结构化抽取（候选记忆提取）
   * - summarization: 摘要生成（Memory Tree sealing）
   * - reasoning: 推理判断（faithfulness 校验、晋升决策）
   * 未指定时使用默认模型。
   */
  modelType?: "extraction" | "summarization" | "reasoning";
}

/** 统一的 LLM 客户端接口。 */
export interface LlmClient {
  /**
   * 执行一次 chat completion，返回 assistant 文本。
   * temperature 固定为 0.0，不可通过 options 覆盖。
   */
  complete(messages: LlmCompletionMessage[], options?: LlmCompletionOptions): Promise<string>;
  /**
   * 将正文按指令摘要，内部拼成 system+user prompt。
   * temperature 固定为 0.0。
   */
  summarize(text: string, instruction: string, options?: LlmCompletionOptions): Promise<string>;
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
        signal?: AbortSignal;
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
 * LLM 调用默认请求超时（毫秒）。
 *
 * 安全约束：当调用方未通过 options.timeout 显式设置上限时，强制使用此默认值
 * 防止上游 fetch 永久挂起导致资源耗尽。调用方仍可通过传 options.timeout 覆盖，
 * 但显式传 0 或负数视为未指定，仍套用默认值。
 */
export const DEFAULT_LLM_TIMEOUT_MS = 30_000;

/**
 * 基于 OpenAI 兼容接口的 chat completion 客户端实现。
 * 所有调用的 temperature 固定为 0.0。
 */
export class OpenAiLlmClient implements LlmClient {
  public readonly available = true;

  private readonly client: ChatCompletionClient;
  private readonly limit: ReturnType<typeof pLimit>;
  private readonly defaultModel: string;
  private readonly extractionModel?: string;
  private readonly summarizationModel?: string;
  private readonly reasoningModel?: string;
  private readonly maxTokens?: number;
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

    this.defaultModel = llmConfig.model;
    this.extractionModel = llmConfig.extractionModel;
    this.summarizationModel = llmConfig.summarizationModel;
    this.reasoningModel = llmConfig.reasoningModel;
    this.maxTokens = llmConfig.maxTokens;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.minTimeout = options.minTimeout ?? DEFAULT_MIN_TIMEOUT;
    this.maxTimeout = options.maxTimeout ?? DEFAULT_MAX_TIMEOUT;
    this.limit = pLimit(options.concurrency ?? DEFAULT_CONCURRENCY);
  }

  /**
   * 根据 modelType 选择对应的模型。
   * 优先使用专用模型，未配置时回退到默认模型。
   */
  private selectModel(modelType?: "extraction" | "summarization" | "reasoning"): string {
    switch (modelType) {
      case "extraction":
        return this.extractionModel ?? this.defaultModel;
      case "summarization":
        return this.summarizationModel ?? this.defaultModel;
      case "reasoning":
        return this.reasoningModel ?? this.defaultModel;
      default:
        return this.defaultModel;
    }
  }

  async complete(
    messages: LlmCompletionMessage[],
    options: LlmCompletionOptions = {},
  ): Promise<string> {
    const maxTokens = options.maxTokens ?? this.maxTokens;
    // temperature 固定为 0.0，不可配置
    const temperature = 0.0;
    const model = this.selectModel(options.modelType);

    // 合并 abort signal：优先使用调用方的 signal，若未显式给出 timeout 则套用默认上限，
    // 防止 fetch 永久挂起导致资源耗尽（安全约束）。
    const effectiveTimeout =
      typeof options.timeout === "number" && options.timeout > 0
        ? options.timeout
        : DEFAULT_LLM_TIMEOUT_MS;
    const signal = this.mergeAbortSignals(options.signal, effectiveTimeout);

    return this.limit(() =>
      retry(
        async () => {
          const response = await this.client.chat.completions.create({
            model,
            messages,
            ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
            temperature,
            ...(signal ? { signal } : {}),
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
          onFailedAttempt: (error) => {
            // 如果是 abort 错误，不重试
            if (error.name === "AbortError" || signal?.aborted) {
              throw error;
            }
          },
        },
      ),
    );
  }

  async summarize(text: string, instruction: string, options?: LlmCompletionOptions): Promise<string> {
    return this.complete([
      { role: "system", content: instruction },
      { role: "user", content: text },
    ], options);
  }

  /**
   * 合并 abort signals：如果提供了 timeout，创建一个超时 signal 并与原 signal 合并。
   * 返回合并后的 signal，如果两者都未提供则返回 undefined。
   */
  private mergeAbortSignals(signal?: AbortSignal, timeout?: number): AbortSignal | undefined {
    if (!signal && !timeout) {
      return undefined;
    }

    if (timeout && !signal) {
      // 只有 timeout，创建超时 AbortController
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      // 清理 timeout（虽然 abort 后也无害，但避免内存泄漏）
      controller.signal.addEventListener("abort", () => clearTimeout(timeoutId), { once: true });
      return controller.signal;
    }

    if (signal && !timeout) {
      // 只有 signal，直接返回
      return signal;
    }

    // 两者都有，需要合并：创建新的 AbortController，任一 signal abort 时都 abort
    const controller = new AbortController();

    if (signal!.aborted) {
      controller.abort();
      return controller.signal;
    }

    const onAbort = () => controller.abort();
    signal!.addEventListener("abort", onAbort, { once: true });

    const timeoutId = setTimeout(() => controller.abort(), timeout!);
    controller.signal.addEventListener("abort", () => {
      clearTimeout(timeoutId);
      signal!.removeEventListener("abort", onAbort);
    }, { once: true });

    return controller.signal;
  }

  /**
   * 递归校验 parsed 数据是否符合 schema 约束。
   *
   * P1-Q1 修复：在原有「顶层 + 嵌套 required 存在性校验」基础上，补齐取值约束的
   * 运行时校验——`type`、`enum`、`minimum`/`maximum`（数值）、`minLength`/`maxLength`
   * （字符串）、`minItems`/`maxItems`（数组）。这样 LLM 返回的畸形字段（如
   * `salience` 越界、`semanticType` 不在枚举内）会触发 schema 校验失败并被重试 / 兜底，
   * 而不是带着非法值流入下游 validator。
   *
   * 同时修复原实现「只递归对象、跳过基本类型数组元素」的缺口：现在 `eventIds`、
   * `riskFlags` 这类基本类型数组元素也会逐个按 items schema 校验。
   *
   * @param data - 待校验的数据
   * @param schema - JSON Schema 定义
   * @param path - 当前路径（用于错误消息）
   */
  private validateSchema(data: unknown, schema: SimpleJsonSchema, path: string): void {
    // 检查当前层级的 required 字段
    if (schema.required && Array.isArray(schema.required)) {
      if (data === null || typeof data !== "object") {
        throw new Error(`Schema validation failed at ${path}: expected object, got ${typeof data}`);
      }

      const missing = schema.required.filter((field) => !(field in data));
      if (missing.length > 0) {
        throw new Error(
          `Schema validation failed at ${path}: missing required fields: ${missing.join(", ")}`,
        );
      }
    }

    // 递归检查 properties 中定义的嵌套结构
    if (schema.properties && typeof schema.properties === "object" && data && typeof data === "object") {
      for (const [key, rawPropSchema] of Object.entries(schema.properties)) {
        if (key in data && rawPropSchema && typeof rawPropSchema === "object") {
          const propSchema = rawPropSchema as SimpleJsonSchema;
          const value = (data as Record<string, unknown>)[key];
          const nestedPath = `${path}.${key}`;

          // 先校验该字段自身的取值约束（type/enum/min/max/length 等）。
          this.validateValueConstraints(value, propSchema, nestedPath);

          // 处理数组类型：如果是数组且 items 定义了 schema，逐元素校验（含基本类型元素）。
          if (Array.isArray(value) && propSchema.items) {
            const itemSchema = propSchema.items as SimpleJsonSchema;
            value.forEach((item, index) => {
              const itemPath = `${nestedPath}[${index}]`;
              this.validateValueConstraints(item, itemSchema, itemPath);
              if (item && typeof item === "object") {
                this.validateSchema(item, itemSchema, itemPath);
              }
            });
          } else if (value && typeof value === "object" && !Array.isArray(value)) {
            // 对象类型（非数组），如果有 required 或 properties 则递归校验
            const hasValidation = propSchema.required || propSchema.properties;
            if (hasValidation) {
              this.validateSchema(value, propSchema, nestedPath);
            }
          }
        }
      }
    }

    // 处理数组类型（顶层数组）
    if (schema.items && Array.isArray(data)) {
      const itemSchema = schema.items as SimpleJsonSchema;
      data.forEach((item, index) => {
        const itemPath = `${path}[${index}]`;
        this.validateValueConstraints(item, itemSchema, itemPath);
        if (item && typeof item === "object") {
          this.validateSchema(item, itemSchema, itemPath);
        }
      });
    }
  }

  /**
   * 校验单个值是否满足 schema 的取值约束（非递归，只看当前节点）。
   *
   * 支持的约束：`type`（含类型数组如 `["string", "null"]`）、`enum`、
   * `minimum`/`maximum`、`minLength`/`maxLength`、`minItems`/`maxItems`。
   * 约束缺省时跳过对应检查，保证向后兼容（无约束的 schema 等价于原 required-only 行为）。
   *
   * @param value - 待校验的值
   * @param schema - 当前节点的 schema
   * @param path - 当前路径（用于错误消息）
   */
  private validateValueConstraints(value: unknown, schema: SimpleJsonSchema, path: string): void {
    // type 校验（支持单类型字符串或类型数组）
    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      const matched = types.some((t) => this.matchesJsonType(value, String(t)));
      if (!matched) {
        throw new Error(
          `Schema validation failed at ${path}: expected type ${types.join("|")}, got ${this.describeType(value)}`,
        );
      }
    }

    // enum 校验（允许 null 作为合法枚举值）
    if (Array.isArray(schema.enum)) {
      const allowed = schema.enum as unknown[];
      if (!allowed.some((candidate) => candidate === value)) {
        throw new Error(
          `Schema validation failed at ${path}: value ${JSON.stringify(value)} not in enum`,
        );
      }
    }

    // 数值范围校验
    if (typeof value === "number") {
      if (typeof schema.minimum === "number" && value < schema.minimum) {
        throw new Error(
          `Schema validation failed at ${path}: ${value} < minimum ${schema.minimum}`,
        );
      }
      if (typeof schema.maximum === "number" && value > schema.maximum) {
        throw new Error(
          `Schema validation failed at ${path}: ${value} > maximum ${schema.maximum}`,
        );
      }
    }

    // 字符串长度校验
    if (typeof value === "string") {
      if (typeof schema.minLength === "number" && value.length < schema.minLength) {
        throw new Error(
          `Schema validation failed at ${path}: string length ${value.length} < minLength ${schema.minLength}`,
        );
      }
      if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
        throw new Error(
          `Schema validation failed at ${path}: string length ${value.length} > maxLength ${schema.maxLength}`,
        );
      }
    }

    // 数组长度校验
    if (Array.isArray(value)) {
      if (typeof schema.minItems === "number" && value.length < schema.minItems) {
        throw new Error(
          `Schema validation failed at ${path}: array length ${value.length} < minItems ${schema.minItems}`,
        );
      }
      if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
        throw new Error(
          `Schema validation failed at ${path}: array length ${value.length} > maxItems ${schema.maxItems}`,
        );
      }
    }
  }

  /** 判断值是否匹配某个 JSON Schema 类型名。 */
  private matchesJsonType(value: unknown, type: string): boolean {
    switch (type) {
      case "string":
        return typeof value === "string";
      case "number":
        return typeof value === "number" && !Number.isNaN(value);
      case "integer":
        return typeof value === "number" && Number.isInteger(value);
      case "boolean":
        return typeof value === "boolean";
      case "object":
        return value !== null && typeof value === "object" && !Array.isArray(value);
      case "array":
        return Array.isArray(value);
      case "null":
        return value === null;
      default:
        // 未知类型名不做限制，避免误杀。
        return true;
    }
  }

  /** 生成可读的类型描述（用于错误消息），区分 null / array / object。 */
  private describeType(value: unknown): string {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    return typeof value;
  }

  /**
   * 结构化抽取实现。
   * D-08 (§2.2): 使用 structured outputs，运行时校验 schema required 字段。
   * D-18: temperature 强制固定为 0.0，覆盖任何 options/config 设置。
   * §10.4: 重试使用退避策略，最多 3 次，失败后抛错并应记 audit。
   * 新增：支持嵌套 schema 校验（递归验证 required 字段）。
   * 新增：支持 modelType 分层模型选择。
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

    const maxTokens = options.maxTokens ?? this.maxTokens;
    // D-18: temperature 一律 0.0，不受 options/config 覆盖
    const temperature = 0.0;
    const model = this.selectModel(options.modelType);

    // 合并 abort signal：未显式给出 timeout 时套用默认上限（安全约束）。
    const effectiveTimeout =
      typeof options.timeout === "number" && options.timeout > 0
        ? options.timeout
        : DEFAULT_LLM_TIMEOUT_MS;
    const signal = this.mergeAbortSignals(options.signal, effectiveTimeout);

    return retry(
      async () => {
        const response = await this.limit(() =>
          this.client.chat.completions.create({
            model,
            messages: augmented,
            ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
            temperature, // 显式传递 0.0
            response_format: { type: "json_object" },
            ...(signal ? { signal } : {}),
          }),
        );

        const content = response.choices?.[0]?.message?.content;
        if (typeof content !== "string" || content.length === 0) {
          throw new Error("LLM returned empty content");
        }

        const parsed = JSON.parse(content) as T;

        // D-08 (§2.2): schema 运行时校验 - 递归检查 required 字段
        this.validateSchema(parsed, schema, "root");

        return parsed;
      },
      {
        // §10.4: 最多 3 次重试，指数退避
        retries: this.maxRetries,
        minTimeout: this.minTimeout,
        maxTimeout: this.maxTimeout,
        factor: 2,
        onFailedAttempt: (error) => {
          // 如果是 abort 错误，不重试
          if (error.name === "AbortError" || signal?.aborted) {
            throw error;
          }
        },
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

  async summarize(_text: string, _instruction: string, _options?: LlmCompletionOptions): Promise<string> {
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
