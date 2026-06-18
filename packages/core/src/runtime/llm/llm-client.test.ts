/**
 * LLM chat completion 客户端单元测试。
 *
 * 本文件做什么：
 *   - 验证 OpenAiLlmClient.complete 能正确解析 chat.completions 返回的文本。
 *   - 验证 summarize 将 instruction + text 拼成 system+user prompt 后调用 complete。
 *   - 验证 NullLlmClient 的安全降级语义（available=false，调用抛错）。
 *   - 验证 createLlmClient 的路由：有配置返回 OpenAiLlmClient，无配置返回 NullLlmClient。
 *   - 验证重试逻辑：注入的 fake client 第一次抛错、第二次成功，complete 最终成功返回。
 *
 * 关键边界：
 *   - 不真正访问网络。通过构造函数第二参数注入 fake chat client。
 *   - 重试用例把 minTimeout 调小（通过 options），避免测试等待真实退避时间。
 */

import { describe, expect, test, vi, afterEach } from "vitest";
import type { MemoryConfig } from "../config.js";
import {
  DEFAULT_LLM_TIMEOUT_MS,
  NullLlmClient,
  OpenAiLlmClient,
  createLlmClient,
  type ChatCompletionClient,
} from "./llm-client.js";

const llmConfig: NonNullable<MemoryConfig["llm"]> = {
  provider: "openai",
  model: "gpt-4o-mini",
  apiKey: "test-key",
  baseURL: "https://api.openai.com/v1",
};

/**
 * 构造一个返回固定内容的 fake chat client，并记录最近一次调用参数。
 */
function makeFakeClient(content: string): {
  client: ChatCompletionClient;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  const client: ChatCompletionClient = {
    chat: {
      completions: {
        async create(params) {
          calls.push(params as Record<string, unknown>);
          return { choices: [{ message: { content } }] };
        },
      },
    },
  };
  return { client, calls };
}

describe("OpenAiLlmClient", () => {
  test("complete returns the assistant message content", async () => {
    const { client, calls } = makeFakeClient("hello world");
    const llm = new OpenAiLlmClient(llmConfig, { client });

    const result = await llm.complete([{ role: "user", content: "hi" }]);

    expect(result).toBe("hello world");
    expect(llm.available).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe("gpt-4o-mini");
    expect(calls[0].messages).toEqual([{ role: "user", content: "hi" }]);
  });

  test("summarize wraps instruction and text into system+user prompt", async () => {
    const { client, calls } = makeFakeClient("摘要结果");
    const llm = new OpenAiLlmClient(llmConfig, { client });

    const result = await llm.summarize("正文内容", "请用一句话总结");

    expect(result).toBe("摘要结果");
    const messages = calls[0].messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("请用一句话总结");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toBe("正文内容");
  });

  test("passes maxTokens from config and fixes temperature to 0.0", async () => {
    const { client, calls } = makeFakeClient("ok");
    const llm = new OpenAiLlmClient(
      { ...llmConfig, maxTokens: 256 },
      { client },
    );

    await llm.complete([{ role: "user", content: "x" }]);

    expect(calls[0].max_tokens).toBe(256);
    expect(calls[0].temperature).toBe(0.0);
  });

  test("uses summarizationModel when modelType is summarization", async () => {
    const { client, calls } = makeFakeClient("summary");
    const llm = new OpenAiLlmClient(
      { ...llmConfig, summarizationModel: "gpt-4o" },
      { client },
    );

    await llm.complete(
      [{ role: "user", content: "summarize this" }],
      { modelType: "summarization" },
    );

    expect(calls[0].model).toBe("gpt-4o");
  });

  test("uses reasoningModel when modelType is reasoning", async () => {
    const { client, calls } = makeFakeClient("reasoning result");
    const llm = new OpenAiLlmClient(
      { ...llmConfig, reasoningModel: "gpt-4o" },
      { client },
    );

    await llm.complete(
      [{ role: "user", content: "reason about this" }],
      { modelType: "reasoning" },
    );

    expect(calls[0].model).toBe("gpt-4o");
  });

  test("falls back to default model when specific model not configured", async () => {
    const { client, calls } = makeFakeClient("ok");
    const llm = new OpenAiLlmClient(llmConfig, { client });

    await llm.complete(
      [{ role: "user", content: "x" }],
      { modelType: "summarization" },
    );

    expect(calls[0].model).toBe("gpt-4o-mini");
  });

  test("complete retries on transient failure then succeeds", async () => {
    let attempts = 0;
    const client: ChatCompletionClient = {
      chat: {
        completions: {
          async create() {
            attempts += 1;
            if (attempts === 1) {
              throw new Error("transient failure");
            }
            return { choices: [{ message: { content: "recovered" } }] };
          },
        },
      },
    };
    const llm = new OpenAiLlmClient(llmConfig, {
      client,
      maxRetries: 2,
      minTimeout: 1,
      maxTimeout: 5,
    });

    const result = await llm.complete([{ role: "user", content: "x" }]);

    expect(result).toBe("recovered");
    expect(attempts).toBe(2);
  });

  test("complete throws when response has no content", async () => {
    const client: ChatCompletionClient = {
      chat: {
        completions: {
          async create() {
            return { choices: [{ message: { content: null } }] };
          },
        },
      },
    };
    const llm = new OpenAiLlmClient(llmConfig, { client, maxRetries: 0, minTimeout: 1 });

    await expect(llm.complete([{ role: "user", content: "x" }])).rejects.toThrow();
  });
});

describe("OpenAiLlmClient - abort signal and timeout", () => {
  test("complete respects abort signal", async () => {
    const controller = new AbortController();
    const client: ChatCompletionClient = {
      chat: {
        completions: {
          async create(params) {
            // 模拟检查 signal
            if (params.signal?.aborted) {
              throw Object.assign(new Error("Request aborted"), { name: "AbortError" });
            }
            // 模拟异步操作中被 abort
            await new Promise((resolve, reject) => {
              const timer = setTimeout(resolve, 100);
              params.signal?.addEventListener("abort", () => {
                clearTimeout(timer);
                reject(Object.assign(new Error("Request aborted"), { name: "AbortError" }));
              });
            });
            return { choices: [{ message: { content: "ok" } }] };
          },
        },
      },
    };
    const llm = new OpenAiLlmClient(llmConfig, { client, maxRetries: 0 });

    // 立即 abort
    controller.abort();

    await expect(
      llm.complete([{ role: "user", content: "x" }], { signal: controller.signal }),
    ).rejects.toThrow("Request aborted");
  });

  test("complete respects timeout option", async () => {
    const client: ChatCompletionClient = {
      chat: {
        completions: {
          async create(params) {
            // 模拟长时间操作
            await new Promise((resolve, reject) => {
              const timer = setTimeout(resolve, 1000);
              params.signal?.addEventListener("abort", () => {
                clearTimeout(timer);
                reject(Object.assign(new Error("Request aborted"), { name: "AbortError" }));
              });
            });
            return { choices: [{ message: { content: "ok" } }] };
          },
        },
      },
    };
    const llm = new OpenAiLlmClient(llmConfig, { client, maxRetries: 0 });

    const start = Date.now();
    await expect(
      llm.complete([{ role: "user", content: "x" }], { timeout: 50 }),
    ).rejects.toThrow();
    const elapsed = Date.now() - start;

    // 应该在 50ms 左右超时，给一些余量
    expect(elapsed).toBeLessThan(200);
  });

  test("complete merges signal and timeout correctly", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    const client: ChatCompletionClient = {
      chat: {
        completions: {
          async create(params) {
            receivedSignal = params.signal;
            return { choices: [{ message: { content: "ok" } }] };
          },
        },
      },
    };
    const llm = new OpenAiLlmClient(llmConfig, { client });

    await llm.complete([{ role: "user", content: "x" }], {
      signal: controller.signal,
      timeout: 5000,
    });

    expect(receivedSignal).toBeDefined();
    expect(receivedSignal).not.toBe(controller.signal); // 应该是合并后的新 signal
  });

  test("extractStructured respects abort signal", async () => {
    const controller = new AbortController();
    const client: ChatCompletionClient = {
      chat: {
        completions: {
          async create(params) {
            if (params.signal?.aborted) {
              throw Object.assign(new Error("Request aborted"), { name: "AbortError" });
            }
            await new Promise((resolve, reject) => {
              const timer = setTimeout(resolve, 100);
              params.signal?.addEventListener("abort", () => {
                clearTimeout(timer);
                reject(Object.assign(new Error("Request aborted"), { name: "AbortError" }));
              });
            });
            return { choices: [{ message: { content: '{"name":"Ada"}' } }] };
          },
        },
      },
    };
    const llm = new OpenAiLlmClient(llmConfig, { client, maxRetries: 0 });

    controller.abort();

    await expect(
      llm.extractStructured(
        [{ role: "user", content: "x" }],
        { required: ["name"] },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("Request aborted");
  });
});

describe("OpenAiLlmClient.extractStructured", () => {
  const schema = {
    type: "object" as const,
    properties: { name: {}, age: {} },
    required: ["name", "age"],
  };

  test("parses valid JSON and validates required fields", async () => {
    const { client, calls } = makeFakeClient(JSON.stringify({ name: "Ada", age: 30 }));
    const llm = new OpenAiLlmClient(llmConfig, { client, minTimeout: 1, maxTimeout: 5 });

    const result = await llm.extractStructured<{ name: string; age: number }>(
      [{ role: "user", content: "extract" }],
      schema,
    );

    expect(result).toEqual({ name: "Ada", age: 30 });
    // D-08: 强制 json_object response_format
    expect(calls[0].response_format).toEqual({ type: "json_object" });
  });

  test("D-18: temperature is fixed to 0.0 regardless of config", async () => {
    const { client, calls } = makeFakeClient(JSON.stringify({ name: "Ada", age: 30 }));
    const llm = new OpenAiLlmClient(
      llmConfig,
      { client, minTimeout: 1, maxTimeout: 5 },
    );

    await llm.extractStructured(
      [{ role: "user", content: "extract" }],
      schema,
    );

    expect(calls[0].temperature).toBe(0.0);
  });

  test("uses extractionModel when modelType is extraction", async () => {
    const { client, calls } = makeFakeClient(JSON.stringify({ name: "Ada", age: 30 }));
    const llm = new OpenAiLlmClient(
      { ...llmConfig, extractionModel: "gpt-4o" },
      { client },
    );

    await llm.extractStructured(
      [{ role: "user", content: "extract" }],
      schema,
      { modelType: "extraction" },
    );

    expect(calls[0].model).toBe("gpt-4o");
  });

  test("falls back to default model when extraction model not configured", async () => {
    const { client, calls } = makeFakeClient(JSON.stringify({ name: "Ada", age: 30 }));
    const llm = new OpenAiLlmClient(llmConfig, { client });

    await llm.extractStructured(
      [{ role: "user", content: "extract" }],
      schema,
      { modelType: "extraction" },
    );

    expect(calls[0].model).toBe("gpt-4o-mini");
  });

  test("retries then throws when JSON is malformed", async () => {
    let attempts = 0;
    const client: ChatCompletionClient = {
      chat: {
        completions: {
          async create() {
            attempts += 1;
            return { choices: [{ message: { content: "not-json{" } }] };
          },
        },
      },
    };
    const llm = new OpenAiLlmClient(llmConfig, {
      client,
      maxRetries: 2,
      minTimeout: 1,
      maxTimeout: 5,
    });

    await expect(
      llm.extractStructured([{ role: "user", content: "x" }], schema),
    ).rejects.toThrow();
    // §10.4: 初次 + 2 次重试 = 3 次尝试
    expect(attempts).toBe(3);
  });

  test("retries then throws when required field is missing (schema validation)", async () => {
    let attempts = 0;
    const client: ChatCompletionClient = {
      chat: {
        completions: {
          async create() {
            attempts += 1;
            // 缺少 required 字段 age
            return { choices: [{ message: { content: JSON.stringify({ name: "Ada" }) } }] };
          },
        },
      },
    };
    const llm = new OpenAiLlmClient(llmConfig, {
      client,
      maxRetries: 1,
      minTimeout: 1,
      maxTimeout: 5,
    });

    await expect(
      llm.extractStructured([{ role: "user", content: "x" }], schema),
    ).rejects.toThrow(/Schema validation failed/);
    expect(attempts).toBe(2);
  });

  test("validates nested required fields in objects", async () => {
    const nestedSchema = {
      type: "object" as const,
      properties: {
        user: {
          type: "object" as const,
          properties: {
            name: { type: "string" as const },
            email: { type: "string" as const },
          },
          required: ["name", "email"],
        },
      },
      required: ["user"],
    };

    // 测试嵌套对象缺少字段
    const client: ChatCompletionClient = {
      chat: {
        completions: {
          async create() {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      user: { name: "Ada" }, // 缺少 email
                    }),
                  },
                },
              ],
            };
          },
        },
      },
    };

    const llm = new OpenAiLlmClient(llmConfig, { client, maxRetries: 0 });

    await expect(
      llm.extractStructured([{ role: "user", content: "x" }], nestedSchema),
    ).rejects.toThrow(/Schema validation failed at root\.user.*email/);
  });

  test("validates required fields in array items", async () => {
    const arraySchema = {
      type: "object" as const,
      properties: {
        users: {
          type: "array" as const,
          items: {
            type: "object" as const,
            properties: {
              name: { type: "string" as const },
              age: { type: "number" as const },
            },
            required: ["name", "age"],
          },
        },
      },
      required: ["users"],
    };

    // 测试数组中的对象缺少字段
    const client: ChatCompletionClient = {
      chat: {
        completions: {
          async create() {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      users: [
                        { name: "Ada", age: 30 },
                        { name: "Bob" }, // 缺少 age
                      ],
                    }),
                  },
                },
              ],
            };
          },
        },
      },
    };

    const llm = new OpenAiLlmClient(llmConfig, { client, maxRetries: 0 });

    await expect(
      llm.extractStructured([{ role: "user", content: "x" }], arraySchema),
    ).rejects.toThrow(/Schema validation failed at root\.users\[1\].*age/);
  });

  test("validates deeply nested structures", async () => {
    const deepSchema = {
      type: "object" as const,
      properties: {
        company: {
          type: "object" as const,
          properties: {
            departments: {
              type: "array" as const,
              items: {
                type: "object" as const,
                properties: {
                  name: { type: "string" as const },
                  manager: {
                    type: "object" as const,
                    properties: {
                      name: { type: "string" as const },
                      id: { type: "number" as const },
                    },
                    required: ["name", "id"],
                  },
                },
                required: ["name", "manager"],
              },
            },
          },
          required: ["departments"],
        },
      },
      required: ["company"],
    };

    const client: ChatCompletionClient = {
      chat: {
        completions: {
          async create() {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      company: {
                        departments: [
                          {
                            name: "Engineering",
                            manager: { name: "Alice", id: 1 },
                          },
                          {
                            name: "Sales",
                            manager: { name: "Bob" }, // 缺少 id
                          },
                        ],
                      },
                    }),
                  },
                },
              ],
            };
          },
        },
      },
    };

    const llm = new OpenAiLlmClient(llmConfig, { client, maxRetries: 0 });

    await expect(
      llm.extractStructured([{ role: "user", content: "x" }], deepSchema),
    ).rejects.toThrow(/Schema validation failed at root\.company\.departments\[1\]\.manager.*id/);
  });

  test("passes validation for complete nested structure", async () => {
    const nestedSchema = {
      type: "object" as const,
      properties: {
        user: {
          type: "object" as const,
          properties: {
            name: { type: "string" as const },
            email: { type: "string" as const },
          },
          required: ["name", "email"],
        },
        tags: {
          type: "array" as const,
          items: {
            type: "object" as const,
            properties: {
              id: { type: "number" as const },
              label: { type: "string" as const },
            },
            required: ["id", "label"],
          },
        },
      },
      required: ["user", "tags"],
    };

    const { client } = makeFakeClient(
      JSON.stringify({
        user: { name: "Ada", email: "ada@example.com" },
        tags: [
          { id: 1, label: "admin" },
          { id: 2, label: "developer" },
        ],
      }),
    );

    const llm = new OpenAiLlmClient(llmConfig, { client, maxRetries: 0 });

    const result = await llm.extractStructured<{
      user: { name: string; email: string };
      tags: Array<{ id: number; label: string }>;
    }>([{ role: "user", content: "x" }], nestedSchema);

    expect(result.user.name).toBe("Ada");
    expect(result.user.email).toBe("ada@example.com");
    expect(result.tags).toHaveLength(2);
    expect(result.tags[1].label).toBe("developer");
  });
});

describe("OpenAiLlmClient.extractStructured - P1-Q1 value constraint validation", () => {
  test("validates enum constraint and rejects invalid value", async () => {
    const enumSchema = {
      type: "object" as const,
      properties: {
        semanticType: {
          type: "string" as const,
          enum: ["profile", "task_context", "rules", "experience", "resource"],
        },
      },
      required: ["semanticType"],
    };

    const client: ChatCompletionClient = {
      chat: {
        completions: {
          async create() {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({ semanticType: "invalid_type" }),
                  },
                },
              ],
            };
          },
        },
      },
    };

    const llm = new OpenAiLlmClient(llmConfig, { client, maxRetries: 0 });

    await expect(
      llm.extractStructured([{ role: "user", content: "x" }], enumSchema),
    ).rejects.toThrow(/Schema validation failed at root\.semanticType.*not in enum/);
  });

  test("validates enum constraint with null as valid value", async () => {
    const enumSchema = {
      type: "object" as const,
      properties: {
        profileDimension: {
          type: ["string", "null"] as const,
          enum: [null, "language", "response_style", "risk_boundary"],
        },
      },
      required: ["profileDimension"],
    };

    const { client } = makeFakeClient(JSON.stringify({ profileDimension: null }));
    const llm = new OpenAiLlmClient(llmConfig, { client });

    const result = await llm.extractStructured<{ profileDimension: string | null }>(
      [{ role: "user", content: "x" }],
      enumSchema,
    );

    expect(result.profileDimension).toBe(null);
  });

  test("validates minimum constraint on numbers", async () => {
    const rangeSchema = {
      type: "object" as const,
      properties: {
        salience: { type: "number" as const, minimum: 0, maximum: 1 },
      },
      required: ["salience"],
    };

    const client: ChatCompletionClient = {
      chat: {
        completions: {
          async create() {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({ salience: -0.5 }),
                  },
                },
              ],
            };
          },
        },
      },
    };

    const llm = new OpenAiLlmClient(llmConfig, { client, maxRetries: 0 });

    await expect(
      llm.extractStructured([{ role: "user", content: "x" }], rangeSchema),
    ).rejects.toThrow(/Schema validation failed at root\.salience.*< minimum 0/);
  });

  test("validates maximum constraint on numbers", async () => {
    const rangeSchema = {
      type: "object" as const,
      properties: {
        salience: { type: "number" as const, minimum: 0, maximum: 1 },
      },
      required: ["salience"],
    };

    const client: ChatCompletionClient = {
      chat: {
        completions: {
          async create() {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({ salience: 1.5 }),
                  },
                },
              ],
            };
          },
        },
      },
    };

    const llm = new OpenAiLlmClient(llmConfig, { client, maxRetries: 0 });

    await expect(
      llm.extractStructured([{ role: "user", content: "x" }], rangeSchema),
    ).rejects.toThrow(/Schema validation failed at root\.salience.*> maximum 1/);
  });

  test("validates minLength constraint on strings", async () => {
    const lengthSchema = {
      type: "object" as const,
      properties: {
        text: { type: "string" as const, minLength: 8, maxLength: 400 },
      },
      required: ["text"],
    };

    const client: ChatCompletionClient = {
      chat: {
        completions: {
          async create() {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({ text: "short" }),
                  },
                },
              ],
            };
          },
        },
      },
    };

    const llm = new OpenAiLlmClient(llmConfig, { client, maxRetries: 0 });

    await expect(
      llm.extractStructured([{ role: "user", content: "x" }], lengthSchema),
    ).rejects.toThrow(/Schema validation failed at root\.text.*< minLength 8/);
  });

  test("validates maxLength constraint on strings", async () => {
    const lengthSchema = {
      type: "object" as const,
      properties: {
        reason: { type: "string" as const, maxLength: 200 },
      },
      required: ["reason"],
    };

    const client: ChatCompletionClient = {
      chat: {
        completions: {
          async create() {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({ reason: "x".repeat(201) }),
                  },
                },
              ],
            };
          },
        },
      },
    };

    const llm = new OpenAiLlmClient(llmConfig, { client, maxRetries: 0 });

    await expect(
      llm.extractStructured([{ role: "user", content: "x" }], lengthSchema),
    ).rejects.toThrow(/Schema validation failed at root\.reason.*> maxLength 200/);
  });

  test("validates minItems constraint on arrays", async () => {
    const arraySchema = {
      type: "object" as const,
      properties: {
        eventIds: { type: "array" as const, items: { type: "string" as const }, minItems: 1 },
      },
      required: ["eventIds"],
    };

    const client: ChatCompletionClient = {
      chat: {
        completions: {
          async create() {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({ eventIds: [] }),
                  },
                },
              ],
            };
          },
        },
      },
    };

    const llm = new OpenAiLlmClient(llmConfig, { client, maxRetries: 0 });

    await expect(
      llm.extractStructured([{ role: "user", content: "x" }], arraySchema),
    ).rejects.toThrow(/Schema validation failed at root\.eventIds.*< minItems 1/);
  });

  test("validates enum in array items (primitive array)", async () => {
    const arrayEnumSchema = {
      type: "object" as const,
      properties: {
        riskFlags: {
          type: "array" as const,
          items: {
            type: "string" as const,
            enum: ["sensitive", "prompt_injection", "low_evidence", "conflict_possible"],
          },
        },
      },
      required: ["riskFlags"],
    };

    const client: ChatCompletionClient = {
      chat: {
        completions: {
          async create() {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({ riskFlags: ["sensitive", "invalid_flag"] }),
                  },
                },
              ],
            };
          },
        },
      },
    };

    const llm = new OpenAiLlmClient(llmConfig, { client, maxRetries: 0 });

    await expect(
      llm.extractStructured([{ role: "user", content: "x" }], arrayEnumSchema),
    ).rejects.toThrow(/Schema validation failed at root\.riskFlags\[1\].*not in enum/);
  });

  test("validates type constraint (rejects wrong type)", async () => {
    const typeSchema = {
      type: "object" as const,
      properties: {
        age: { type: "number" as const },
      },
      required: ["age"],
    };

    const client: ChatCompletionClient = {
      chat: {
        completions: {
          async create() {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({ age: "thirty" }),
                  },
                },
              ],
            };
          },
        },
      },
    };

    const llm = new OpenAiLlmClient(llmConfig, { client, maxRetries: 0 });

    await expect(
      llm.extractStructured([{ role: "user", content: "x" }], typeSchema),
    ).rejects.toThrow(/Schema validation failed at root\.age.*expected type number/);
  });

  test("validates type array with null (accepts null when allowed)", async () => {
    const nullableSchema = {
      type: "object" as const,
      properties: {
        description: { type: ["string", "null"] as const },
      },
      required: ["description"],
    };

    const { client } = makeFakeClient(JSON.stringify({ description: null }));
    const llm = new OpenAiLlmClient(llmConfig, { client });

    const result = await llm.extractStructured<{ description: string | null }>(
      [{ role: "user", content: "x" }],
      nullableSchema,
    );

    expect(result.description).toBe(null);
  });

  test("passes validation for complex real schema (candidate extraction)", async () => {
    const candidateSchema = {
      type: "object" as const,
      properties: {
        candidates: {
          type: "array" as const,
          items: {
            type: "object" as const,
            properties: {
              text: { type: "string" as const, minLength: 8, maxLength: 400 },
              semanticType: {
                type: "string" as const,
                enum: ["profile", "task_context", "rules", "experience", "resource"],
              },
              salience: { type: "number" as const, minimum: 0, maximum: 1 },
              evidence: {
                type: "object" as const,
                properties: {
                  eventIds: { type: "array" as const, items: { type: "string" as const }, minItems: 1 },
                },
                required: ["eventIds"],
              },
              riskFlags: {
                type: "array" as const,
                items: {
                  type: "string" as const,
                  enum: ["sensitive", "prompt_injection", "low_evidence"],
                },
              },
            },
            required: ["text", "semanticType", "salience", "evidence"],
          },
        },
      },
      required: ["candidates"],
    };

    const { client } = makeFakeClient(
      JSON.stringify({
        candidates: [
          {
            text: "User prefers concise responses",
            semanticType: "profile",
            salience: 0.85,
            evidence: { eventIds: ["evt-001"] },
            riskFlags: ["sensitive"],
          },
        ],
      }),
    );

    const llm = new OpenAiLlmClient(llmConfig, { client });

    const result = await llm.extractStructured<{ candidates: any[] }>(
      [{ role: "user", content: "x" }],
      candidateSchema,
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].text).toBe("User prefers concise responses");
    expect(result.candidates[0].salience).toBe(0.85);
  });
});

describe("OpenAiLlmClient - default timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("DEFAULT_LLM_TIMEOUT_MS is exported and equals 30s", () => {
    expect(DEFAULT_LLM_TIMEOUT_MS).toBe(30_000);
  });

  test("complete aborts hung request via default timeout when none provided", async () => {
    vi.useFakeTimers();

    let abortReason: string | undefined;
    const client: ChatCompletionClient = {
      chat: {
        completions: {
          // 永久挂起的请求；只有当合并后的 signal abort 时才 reject。
          create(params) {
            return new Promise((_resolve, reject) => {
              params.signal?.addEventListener("abort", () => {
                abortReason = "aborted-by-default-timeout";
                reject(Object.assign(new Error("Request aborted"), { name: "AbortError" }));
              });
            });
          },
        },
      },
    };

    const llm = new OpenAiLlmClient(llmConfig, {
      client,
      maxRetries: 0,
      minTimeout: 1,
      maxTimeout: 5,
    });

    const pending = llm.complete([{ role: "user", content: "hang" }]);
    // 兜底：把回调写到 promise 上，避免未处理 rejection 在 advance 期间打断断言。
    const settled = pending.catch((err) => err);

    // 推进到 30 秒后，默认超时应该已经触发 abort。
    await vi.advanceTimersByTimeAsync(DEFAULT_LLM_TIMEOUT_MS + 10);

    const result = await settled;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/abort/i);
    expect(abortReason).toBe("aborted-by-default-timeout");
  });

  test("explicit timeout=0 still falls back to default timeout", async () => {
    vi.useFakeTimers();

    let aborted = false;
    const client: ChatCompletionClient = {
      chat: {
        completions: {
          create(params) {
            return new Promise((_resolve, reject) => {
              params.signal?.addEventListener("abort", () => {
                aborted = true;
                reject(Object.assign(new Error("Request aborted"), { name: "AbortError" }));
              });
            });
          },
        },
      },
    };

    const llm = new OpenAiLlmClient(llmConfig, {
      client,
      maxRetries: 0,
      minTimeout: 1,
      maxTimeout: 5,
    });

    const settled = llm
      .complete([{ role: "user", content: "hang" }], { timeout: 0 })
      .catch((err) => err);

    await vi.advanceTimersByTimeAsync(DEFAULT_LLM_TIMEOUT_MS + 10);

    const result = await settled;
    expect(result).toBeInstanceOf(Error);
    expect(aborted).toBe(true);
  });
});

describe("NullLlmClient", () => {
  test("available is false and calls throw", async () => {
    const llm = new NullLlmClient();

    expect(llm.available).toBe(false);
    await expect(llm.complete([{ role: "user", content: "x" }])).rejects.toThrow();
    await expect(llm.summarize("text", "instruction")).rejects.toThrow();
  });
});

describe("createLlmClient", () => {
  test("returns OpenAiLlmClient when config provided", () => {
    const llm = createLlmClient(llmConfig);
    expect(llm).toBeInstanceOf(OpenAiLlmClient);
    expect(llm.available).toBe(true);
  });

  test("returns NullLlmClient when config missing", () => {
    const llm = createLlmClient(undefined);
    expect(llm).toBeInstanceOf(NullLlmClient);
    expect(llm.available).toBe(false);
  });
});
