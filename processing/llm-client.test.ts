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

import { describe, expect, test } from "vitest";
import type { MemoryConfig } from "../config.js";
import {
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

  test("passes maxTokens and temperature from config", async () => {
    const { client, calls } = makeFakeClient("ok");
    const llm = new OpenAiLlmClient(
      { ...llmConfig, maxTokens: 256, temperature: 0.5 },
      { client },
    );

    await llm.complete([{ role: "user", content: "x" }]);

    expect(calls[0].max_tokens).toBe(256);
    expect(calls[0].temperature).toBe(0.5);
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

  test("D-18: temperature is forced to 0.0 regardless of options/config", async () => {
    const { client, calls } = makeFakeClient(JSON.stringify({ name: "Ada", age: 30 }));
    const llm = new OpenAiLlmClient(
      { ...llmConfig, temperature: 0.9 },
      { client, minTimeout: 1, maxTimeout: 5 },
    );

    await llm.extractStructured(
      [{ role: "user", content: "extract" }],
      schema,
      { temperature: 0.7 },
    );

    expect(calls[0].temperature).toBe(0.0);
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
