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
      assetInjection: false,
      temporalMemory: false,
      sessionWorkingSet: false,
      skillArtifacts: false,
      memoryPolicyOverlay: false,
      teamAssets: false,
      proxy: false,
    });
  });

  test("解析并冻结本机 host authority，供插件入口建立可信身份边界", () => {
    const config = memoryConfigSchema.parse({
      ...baseConfig,
      authority: {
        tenantId: "default",
        userId: "default",
        allow: {
          appIds: ["openclaw"],
          projectIds: ["default"],
          agentIds: ["default"],
          namespaces: ["default"],
          visibilities: ["private"],
        },
      },
    });

    expect(config.authority).toEqual({
      tenantId: "default",
      userId: "default",
      allow: {
        appIds: ["openclaw"],
        projectIds: ["default"],
        agentIds: ["default"],
        namespaces: ["default"],
        visibilities: ["private"],
      },
    });
    expect(Object.isFrozen(config.authority)).toBe(true);
    expect(Object.isFrozen(config.authority?.allow.appIds)).toBe(true);
  });

  test("多 Agent authority 要求显式 defaultAgentId 且默认值必须在 allowlist 中", () => {
    const multiAgentAuthority = {
      tenantId: "default",
      userId: "default",
      allow: {
        appIds: ["openclaw"],
        projectIds: ["default"],
        agentIds: ["main", "codex"],
        namespaces: ["default"],
        visibilities: ["private"],
      },
    };

    expect(() => memoryConfigSchema.parse({
      ...baseConfig,
      authority: multiAgentAuthority,
    })).toThrow(/defaultAgentId.*required/i);
    expect(() => memoryConfigSchema.parse({
      ...baseConfig,
      authority: multiAgentAuthority,
      defaultAgentId: "attacker",
    })).toThrow(/defaultAgentId.*allowlist/i);

    const config = memoryConfigSchema.parse({
      ...baseConfig,
      authority: multiAgentAuthority,
      defaultAgentId: "main",
    });
    expect(config.defaultAgentId).toBe("main");
  });

  test("单 Agent authority 将唯一 allowlist 值规范化为 defaultAgentId", () => {
    const config = memoryConfigSchema.parse({
      ...baseConfig,
      authority: {
        tenantId: "default",
        userId: "default",
        allow: {
          appIds: ["openclaw"],
          projectIds: ["default"],
          agentIds: ["main"],
          namespaces: ["default"],
          visibilities: ["private"],
        },
      },
    });

    expect(config.defaultAgentId).toBe("main");
  });

  test("拒绝超过 64 个 Agent 的 host authority allowlist", () => {
    expect(() => memoryConfigSchema.parse({
      ...baseConfig,
      authority: {
        tenantId: "default",
        userId: "default",
        allow: {
          appIds: ["openclaw"],
          projectIds: ["default"],
          agentIds: Array.from({ length: 65 }, (_, index) => `agent-${index}`),
          namespaces: ["default"],
          visibilities: ["private"],
        },
      },
      defaultAgentId: "agent-0",
    })).toThrow(/agentIds.*64/i);
  });

  test.each([
    { authority: { tenantId: "default", userId: "default", allow: {} } },
    {
      authority: {
        tenantId: "default",
        userId: "default",
        allow: {
          appIds: ["openclaw", "OPENCLAW"],
          projectIds: ["default"],
          agentIds: ["default"],
          namespaces: ["default"],
          visibilities: ["private"],
        },
      },
    },
    {
      authority: {
        tenantId: "default",
        userId: "default",
        allow: {
          appIds: ["openclaw"],
          projectIds: ["../other"],
          agentIds: ["default"],
          namespaces: ["default"],
          visibilities: ["private"],
        },
      },
    },
  ])("拒绝缺失、歧义或路径混淆的 host authority: %#", (extra) => {
    expect(() => memoryConfigSchema.parse({ ...baseConfig, ...extra })).toThrow(/authority|allowlist|project/i);
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
        assetInjection: true,
        temporalMemory: true,
        sessionWorkingSet: true,
        skillArtifacts: true,
        memoryPolicyOverlay: true,
        teamAssets: false,
        proxy: false,
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
      assetInjection: true,
      temporalMemory: true,
      sessionWorkingSet: true,
      skillArtifacts: true,
      memoryPolicyOverlay: true,
      teamAssets: false,
      proxy: false,
    });
  });

  test("解析时态记忆配置并拒绝隐式 purge 或未知历史索引", () => {
    const config = memoryConfigSchema.parse({
      ...baseConfig,
      features: { temporalMemory: true },
      temporalMemory: {
        defaultExpirationAction: "archive",
        allowHistoricalRecall: true,
        allowRestore: true,
        historicalIndex: "bm25",
      },
    });

    expect(config.temporalMemory).toEqual({
      defaultExpirationAction: "archive",
      allowHistoricalRecall: true,
      allowRestore: true,
      historicalIndex: "bm25",
    });
    expect(() => memoryConfigSchema.parse({
      ...baseConfig,
      temporalMemory: { defaultExpirationAction: "purge" },
    })).toThrow(/temporalMemory\.defaultExpirationAction/i);
    expect(() => memoryConfigSchema.parse({
      ...baseConfig,
      temporalMemory: { historicalIndex: "ann" },
    })).toThrow(/temporalMemory\.historicalIndex/i);
  });

  test("解析 Working Set 配置并拒绝无序 ratio、负 retention", () => {
    const config = memoryConfigSchema.parse({
      ...baseConfig,
      features: { sessionWorkingSet: true },
      sessionWorkingSet: {
        mildRatio: 0.5,
        aggressiveRatio: 0.85,
        emergencyRatio: 0.95,
        emergencyTargetRatio: 0.6,
        outlineMaxRatio: 0.2,
        retentionDays: 30,
      },
    });
    expect(config.sessionWorkingSet).toEqual({
      mildRatio: 0.5,
      aggressiveRatio: 0.85,
      emergencyRatio: 0.95,
      emergencyTargetRatio: 0.6,
      outlineMaxRatio: 0.2,
      retentionDays: 30,
    });
    expect(() => memoryConfigSchema.parse({
      ...baseConfig,
      sessionWorkingSet: { mildRatio: 0.9, aggressiveRatio: 0.8 },
    })).toThrow(/sessionWorkingSet.*ratio/i);
    expect(() => memoryConfigSchema.parse({
      ...baseConfig,
      sessionWorkingSet: { retentionDays: -1 },
    })).toThrow(/sessionWorkingSet\.retentionDays/i);
  });

  test("Skill Artifact v1 配置强制 suggest_only 且禁止 executable", () => {
    const config = memoryConfigSchema.parse({
      ...baseConfig,
      skillArtifacts: {
        maxResourceBytes: 5_242_880,
        allowExecutable: false,
        executionMode: "suggest_only",
      },
    });
    expect(config.skillArtifacts).toEqual({
      maxResourceBytes: 5_242_880,
      allowExecutable: false,
      executionMode: "suggest_only",
    });
    expect(() => memoryConfigSchema.parse({
      ...baseConfig,
      skillArtifacts: { allowExecutable: true },
    })).toThrow(/skillArtifacts\.allowExecutable/i);
    expect(() => memoryConfigSchema.parse({
      ...baseConfig,
      skillArtifacts: { executionMode: "execute" },
    })).toThrow(/skillArtifacts\.executionMode/i);
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
    expect(() => memoryConfigSchema.parse({
      ...baseConfig,
      features: { assetInjection: "yes" },
    })).toThrow("features.assetInjection must be a boolean");
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
      },
    });

    expect(config.llm).toEqual({
      provider: "openai",
      model: "gpt-4o-mini",
      baseURL: "https://api.openai.com/v1",
      apiKey: "llm-key",
      maxTokens: 512,
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
    });
  });

  test("rejects unknown llm config keys", () => {
    expect(() =>
      memoryConfigSchema.parse({ ...baseConfig, llm: { apiKey: "k", model: "m", unknown: true } }),
    ).toThrow("llm config has unknown keys: unknown");
    expect(() =>
      memoryConfigSchema.parse({ ...baseConfig, llm: { apiKey: "k", model: "m", temperature: 0 } }),
    ).toThrow("llm config has unknown keys: temperature");
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

  test("does not synthesize dbPath for postgres config", () => {
    const config = memoryConfigSchema.parse({
      ...baseConfig,
      dbType: "postgres",
      postgres: {
        host: "127.0.0.1",
        port: 5432,
        database: "mengshu",
        user: "postgres",
        password: "secret",
      },
    });

    expect(config.dbType).toBe("postgres");
    expect(config.dbPath).toBeUndefined();
  });
});
