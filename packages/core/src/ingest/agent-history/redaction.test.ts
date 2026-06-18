/**
 * secret redaction 单元测试（方案 §11.3-11.4）。
 *
 * 验证 API key / token / 私钥 / env 赋值 / 完整请求头 / SSH key 等被替换为占位符，
 * 且普通工作文本不被误伤。
 */

import { describe, it, expect } from "vitest";
import { redactSecrets } from "./redaction.js";

describe("redactSecrets", () => {
  it("redacts OpenAI-style API keys", () => {
    const result = redactSecrets("使用 key sk-abcdEFGH1234567890abcdEFGH1234567890abcdEFGH 调用");
    expect(result.text).not.toContain("sk-abcdEFGH1234567890");
    expect(result.text).toContain("[REDACTED:");
    expect(result.redactedCount).toBeGreaterThanOrEqual(1);
    expect(result.categories).toContain("api_key");
  });

  it("redacts GitHub tokens", () => {
    const result = redactSecrets("token ghp_1234567890abcdefABCDEF1234567890abcdef");
    expect(result.text).not.toContain("ghp_1234567890abcdefABCDEF1234567890abcdef");
    expect(result.categories).toContain("token");
  });

  it("redacts Bearer authorization headers", () => {
    const result = redactSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig");
    expect(result.text).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(result.categories).toContain("auth_header");
  });

  it("redacts private key blocks", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234\n-----END RSA PRIVATE KEY-----";
    const result = redactSecrets(`私钥如下：\n${pem}`);
    expect(result.text).not.toContain("MIIEpAIBAAKCAQEA1234");
    expect(result.categories).toContain("private_key");
  });

  it("redacts env-style secret assignments", () => {
    const result = redactSecrets("OPENAI_API_KEY=sk-verysecretvalue1234567890abcdef\nDB_PASSWORD=hunter2supersecret");
    expect(result.text).not.toContain("sk-verysecretvalue1234567890abcdef");
    expect(result.text).not.toContain("hunter2supersecret");
    expect(result.categories).toContain("env_secret");
  });

  it("redacts AWS access key ids", () => {
    const result = redactSecrets("aws key AKIAIOSFODNN7EXAMPLE here");
    expect(result.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result.categories).toContain("token");
  });

  it("does not redact ordinary work text", () => {
    const text = "请帮我重构 cli-project.ts 的 handleInit 函数，使用 manifestToScope 派生 scope。";
    const result = redactSecrets(text);
    expect(result.text).toBe(text);
    expect(result.redactedCount).toBe(0);
    expect(result.categories).toHaveLength(0);
  });

  it("does not redact short non-secret env-like assignments", () => {
    // NODE_ENV=production 不是密钥，值短且为常见枚举值，不应被误伤
    const result = redactSecrets("NODE_ENV=production\nLOG_LEVEL=debug");
    expect(result.text).toContain("production");
    expect(result.text).toContain("debug");
  });

  it("handles empty input", () => {
    const result = redactSecrets("");
    expect(result.text).toBe("");
    expect(result.redactedCount).toBe(0);
  });

  it("counts multiple distinct secrets", () => {
    const result = redactSecrets(
      "k1 sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa and k2 ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    expect(result.redactedCount).toBeGreaterThanOrEqual(2);
  });
});
