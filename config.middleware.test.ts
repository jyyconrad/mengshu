import { describe, expect, test } from "vitest";
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
});
