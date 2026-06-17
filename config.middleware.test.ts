import { describe, expect, test } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { memoryConfigSchema } from "./config.js";

const baseConfig = {
  embedding: {
    apiKey: "test-key",
    baseURL: "https://api.openai.com/v1",
    model: "text-embedding-3-small",
  },
};

describe("middleware config", () => {
  test("keeps legacy config valid and applies middleware defaults", () => {
    const config = memoryConfigSchema.parse(baseConfig);

    expect(config.mode).toBe("embedded");
    expect(config.server).toEqual({
      enabled: false,
      host: "127.0.0.1",
      port: 3847,
      requireHttps: false,
    });
    expect(config.features).toEqual({
      bm25: false,
      graph: false,
      summaryTree: false,
      webConsole: false,
    });
  });

  test("parses explicit server mode and feature flags", () => {
    const config = memoryConfigSchema.parse({
      ...baseConfig,
      mode: "server",
      server: {
        enabled: true,
        host: "0.0.0.0",
        port: 4099,
        secret: "secret-token",
        requireHttps: true,
      },
      features: {
        bm25: true,
        graph: true,
        summaryTree: true,
        webConsole: true,
      },
    });

    expect(config.mode).toBe("server");
    expect(config.server).toEqual({
      enabled: true,
      host: "0.0.0.0",
      port: 4099,
      secret: "secret-token",
      requireHttps: true,
    });
    expect(config.features).toEqual({
      bm25: true,
      graph: true,
      summaryTree: true,
      webConsole: true,
    });
  });

  test("rejects unknown middleware config keys", () => {
    expect(() => memoryConfigSchema.parse({ ...baseConfig, mode: "sidecar" })).toThrow(
      "mode must be one of: embedded, server, remote, backend-proxy",
    );
    expect(() => memoryConfigSchema.parse({ ...baseConfig, server: { unknown: true } })).toThrow(
      "server config has unknown keys: unknown",
    );
    expect(() => memoryConfigSchema.parse({ ...baseConfig, features: { unknown: true } })).toThrow(
      "features config has unknown keys: unknown",
    );
  });

  test("validates server field types and port range", () => {
    expect(() => memoryConfigSchema.parse({ ...baseConfig, server: { enabled: "yes" } })).toThrow(
      "server.enabled must be a boolean",
    );
    expect(() => memoryConfigSchema.parse({ ...baseConfig, server: { host: 123 } })).toThrow(
      "server.host must be a string",
    );
    expect(() => memoryConfigSchema.parse({ ...baseConfig, server: { port: 0 } })).toThrow(
      "server.port must be between 1 and 65535",
    );
    expect(() => memoryConfigSchema.parse({ ...baseConfig, server: { secret: 123 } })).toThrow(
      "server.secret must be a string",
    );
  });

  test("omits llm when not provided", () => {
    const config = memoryConfigSchema.parse(baseConfig);
    expect(config.llm).toBeUndefined();
  });

  test("parses a valid llm config block", () => {
    const config = memoryConfigSchema.parse({
      ...baseConfig,
      llm: {
        provider: "openai",
        model: "gpt-4o-mini",
        baseURL: "https://api.openai.com/v1",
        apiKey: "llm-key",
        maxTokens: 512,
        temperature: 0.3,
      },
    });

    expect(config.llm).toEqual({
      provider: "openai",
      model: "gpt-4o-mini",
      baseURL: "https://api.openai.com/v1",
      apiKey: "llm-key",
      maxTokens: 512,
      temperature: 0.3,
    });
  });

  test("parses minimal llm config with only required fields", () => {
    const config = memoryConfigSchema.parse({
      ...baseConfig,
      llm: { apiKey: "llm-key", model: "gpt-4o-mini" },
    });

    expect(config.llm).toEqual({
      provider: "openai",
      model: "gpt-4o-mini",
      apiKey: "llm-key",
      baseURL: undefined,
      maxTokens: undefined,
      temperature: undefined,
    });
  });

  test("rejects unknown llm config keys", () => {
    expect(() =>
      memoryConfigSchema.parse({ ...baseConfig, llm: { apiKey: "k", model: "m", unknown: true } }),
    ).toThrow("llm config has unknown keys: unknown");
  });

  test("validates llm field requirements and ranges", () => {
    expect(() => memoryConfigSchema.parse({ ...baseConfig, llm: { model: "m" } })).toThrow(
      "llm.apiKey is required",
    );
    expect(() => memoryConfigSchema.parse({ ...baseConfig, llm: { apiKey: "k" } })).toThrow(
      "llm.model is required",
    );
    expect(() =>
      memoryConfigSchema.parse({ ...baseConfig, llm: { apiKey: "k", model: "m", baseURL: 123 } }),
    ).toThrow("llm.baseURL must be a string");
    expect(() =>
      memoryConfigSchema.parse({ ...baseConfig, llm: { apiKey: "k", model: "m", maxTokens: 0 } }),
    ).toThrow("llm.maxTokens must be a positive integer");
    expect(() =>
      memoryConfigSchema.parse({ ...baseConfig, llm: { apiKey: "k", model: "m", temperature: 3 } }),
    ).toThrow("llm.temperature must be between 0 and 2");
  });

  test("uses MENGSHU_HOME for default dbPath when not specified", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "mengshu-home-"));
    const previous = process.env.MENGSHU_HOME;
    process.env.MENGSHU_HOME = tmpHome;
    try {
      const config = memoryConfigSchema.parse(baseConfig);
      expect(config.dbPath).toBe(path.join(tmpHome, "memory", "lancedb"));
    } finally {
      if (previous === undefined) {
        delete process.env.MENGSHU_HOME;
      } else {
        process.env.MENGSHU_HOME = previous;
      }
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
