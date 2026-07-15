import { describe, expect, test, vi } from "vitest";
import memoryPlugin from "./index.js";

describe("OpenClaw canonical plugin entry", () => {
  test("host 未注入 authenticated AuthorityScope 时诚实拒绝且不注册任何 surface", () => {
    const api = {
      pluginConfig: {
        embedding: {
          provider: "openai",
          apiKey: "test-key",
          baseURL: "http://localhost:9999/v1",
          model: "text-embedding-3-small",
        },
        dbType: "lancedb",
        dbPath: ".mengshu/test",
      },
      logger: { info: vi.fn(), warn: vi.fn() },
      resolvePath: vi.fn((value: string) => value),
      registerTool: vi.fn(),
      registerCli: vi.fn(),
      registerService: vi.fn(),
      on: vi.fn(),
    };

    expect(() => memoryPlugin.register(api as never)).toThrow(/authenticated.*authority|host.*authority/i);
    expect(api.resolvePath).not.toHaveBeenCalled();
    expect(api.registerTool).not.toHaveBeenCalled();
    expect(api.registerCli).not.toHaveBeenCalled();
    expect(api.registerService).not.toHaveBeenCalled();
    expect(api.on).not.toHaveBeenCalled();
  });

  test("本机配置显式 host authority 后注册真实 OpenClaw surfaces", () => {
    const api = {
      pluginConfig: {
        embedding: {
          provider: "openai",
          apiKey: "test-key",
          baseURL: "http://localhost:9999/v1",
          model: "text-embedding-3-small",
        },
        dbType: "lancedb",
        dbPath: ".mengshu/test",
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
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      resolvePath: vi.fn((value: string) => value),
      registerTool: vi.fn(),
      registerCli: vi.fn(),
      registerService: vi.fn(),
      on: vi.fn(),
    };

    expect(() => memoryPlugin.register(api as never)).not.toThrow();
    expect(api.resolvePath).toHaveBeenCalledTimes(1);
    expect(api.registerTool).toHaveBeenCalled();
    expect(api.registerCli).toHaveBeenCalled();
    expect(api.registerService).toHaveBeenCalled();
    expect(api.on).toHaveBeenCalled();
  });

  test("非 default 的 exact host authority 成为 runtime default，不再被硬编码身份拒绝", () => {
    const api = {
      pluginConfig: {
        embedding: {
          provider: "openai",
          apiKey: "test-key",
          baseURL: "http://localhost:9999/v1",
          model: "text-embedding-3-small",
        },
        dbType: "lancedb",
        dbPath: ".mengshu/test",
        authority: {
          tenantId: "other-tenant",
          userId: "default",
          allow: {
            appIds: ["openclaw"],
            projectIds: ["default"],
            agentIds: ["default"],
            namespaces: ["default"],
            visibilities: ["private"],
          },
        },
      },
      logger: { info: vi.fn(), warn: vi.fn() },
      resolvePath: vi.fn((value: string) => value),
      registerTool: vi.fn(),
      registerCli: vi.fn(),
      registerService: vi.fn(),
      on: vi.fn(),
    };

    expect(() => memoryPlugin.register(api as never)).not.toThrow();
    expect(api.registerTool).toHaveBeenCalled();
    expect(api.registerCli).toHaveBeenCalled();
    expect(api.registerService).toHaveBeenCalled();
    expect(api.on).toHaveBeenCalled();
  });
});
