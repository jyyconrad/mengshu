/**
 * cli-doctor.ts 命令注册与 check 函数单元测试。
 *
 * 用 fake CommanderLike 捕获注册的命令名与 action，并直接单测各 check 函数，验证：
 * 1. checkDb：service.health() ok -> ok；ok:false -> fatal。
 * 2. checkEmbedding：embed 成功 -> ok；embed 抛错 -> warning（可降级，不是 fatal）。
 * 3. checkModel：合法 model -> ok；非法 model -> fatal。
 * 4. checkDisk：可写目录 -> ok；不存在/不可写 -> warning。
 * 5. checkManifest：存在合法 -> ok；不存在 -> info；损坏 -> warning。
 * 6. doctor 命令注册：action 执行不抛错，能区分 warning 与 fatal，并打印汇总。
 * 7. demo 命令：注入 fake service，验证 store + context 被调用且降级不 crash。
 * 8. connect 命令：输出含 server URL 与 scope。
 *
 * 使用 os.tmpdir 临时目录，测试后清理。
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerDoctorCliCommands as registerDoctorCliCommandsRaw,
  checkConfig,
  checkDb,
  checkEmbedding,
  checkModel,
  checkDisk,
  checkEmbeddingRegistry,
  checkManifest,
  checkWorkingSetRetention,
} from "./doctor.js";
import { MANIFEST_FILENAME } from "../manifest.js";

const defaultScope = {
  tenantId: "tenant-a", appId: "openclaw", userId: "server-user", projectId: "default",
  agentId: "default", namespace: "memories", visibility: "private" as const,
};
const authority = {
  tenantId: "tenant-a", userId: "server-user",
  allow: { appIds: ["openclaw"], projectIds: ["default"], agentIds: ["default"], namespaces: ["memories"], visibilities: ["private" as const] },
};
function registerDoctorCliCommands(memory: never, deps: Record<string, unknown>) {
  return registerDoctorCliCommandsRaw(memory, { authority, defaultScope, ...deps } as never);
}

/** 鸭子类型 fake：支持 command 字符串含位置参数（doctor [dir] / connect [appId]）。 */
class FakeCommand {
  subcommands: FakeCommand[] = [];
  options: Array<[string, string, unknown?]> = [];
  actionHandler?: (...args: unknown[]) => unknown;

  constructor(public readonly name: string) {}

  command(name: string) {
    const child = new FakeCommand(name);
    this.subcommands.push(child);
    return child;
  }

  description() {
    return this;
  }

  option(flag: string, description: string, defaultValue?: unknown) {
    this.options.push([flag, description, defaultValue]);
    return this;
  }

  action(handler: (...args: unknown[]) => unknown) {
    this.actionHandler = handler;
    return this;
  }

  find(name: string): FakeCommand | undefined {
    return this.subcommands.find((c) => c.name === name || c.name.startsWith(`${name} `));
  }
}

let workDir: string;
let logs: string[];
let originalLog: typeof console.log;
let originalExitCode: number | string | null | undefined;

const validConfig = {
  embedding: { provider: "openai", model: "text-embedding-3-small", apiKey: "k", baseURL: "http://x" },
  dbType: "lancedb",
  dbPath: "",
  server: { host: "127.0.0.1", port: 3847, secret: "s3cr3t" },
};

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "mengshu-doctor-"));
  logs = [];
  originalLog = console.log;
  originalExitCode = process.exitCode;
  console.log = (message?: unknown) => {
    logs.push(String(message));
  };
});

afterEach(() => {
  console.log = originalLog;
  process.exitCode = originalExitCode;
  rmSync(workDir, { recursive: true, force: true });
});

describe("checkConfig", () => {
  test("可解析返回 ok", () => {
    const result = checkConfig(validConfig);
    expect(result.status).toBe("ok");
  });

  test("缺失或不可解析返回 fatal", () => {
    expect(checkConfig(undefined).status).toBe("fatal");
  });
});

describe("checkWorkingSetRetention", () => {
  test("启用 Working Set 但没有 retentionDays 时返回 warning", () => {
    expect(checkWorkingSetRetention({ features: { sessionWorkingSet: true } })).toMatchObject({
      name: "working-set-retention",
      status: "warning",
    });
    expect(checkWorkingSetRetention({
      features: { sessionWorkingSet: true },
      sessionWorkingSet: { retentionDays: 30 },
    })).toMatchObject({ status: "ok" });
  });
});

describe("checkDb", () => {
  test("health ok 返回 ok", async () => {
    const service = { health: vi.fn(async () => ({ ok: true, records: 5 })) };
    const result = await checkDb(service as never);
    expect(result.status).toBe("ok");
    expect(result.message).toContain("5");
  });

  test("health ok:false 返回 fatal", async () => {
    const service = { health: vi.fn(async () => ({ ok: false, error: "db closed" })) };
    const result = await checkDb(service as never);
    expect(result.status).toBe("fatal");
    expect(result.message).toContain("db closed");
  });

  test("无 service 返回 warning", async () => {
    const result = await checkDb(undefined);
    expect(result.status).toBe("warning");
  });
});

describe("checkEmbedding", () => {
  test("embed 成功返回 ok", async () => {
    const embeddings = { embed: vi.fn(async () => [0.1, 0.2]) };
    const result = await checkEmbedding(embeddings);
    expect(result.status).toBe("ok");
    expect(embeddings.embed).toHaveBeenCalled();
  });

  test("embed 抛错返回 warning（可降级，非 fatal）", async () => {
    const embeddings = {
      embed: vi.fn(async () => {
        throw new Error("api key missing");
      }),
    };
    const result = await checkEmbedding(embeddings);
    expect(result.status).toBe("warning");
    expect(result.message).toContain("api key missing");
  });

  test("无 embeddings 返回 warning", async () => {
    const result = await checkEmbedding(undefined);
    expect(result.status).toBe("warning");
  });
});

describe("checkEmbeddingRegistry", () => {
  test("active is the only Postgres write-enabled state", () => {
    expect(checkEmbeddingRegistry({
      status: "active",
      writeMode: "write-enabled",
      embeddingReadMode: "same-space-ann",
      lifecycleState: "ready",
      lifecycleReady: true,
      reasonCode: "active-space-match",
    })).toEqual({
      name: "embedding-registry",
      status: "ok",
      message:
        "status=active, registryWriteMode=write-enabled, writePath=not-probed, " +
        "embeddingReadMode=same-space-ann, lifecycleState=ready, lifecycleReady=true",
    });
  });

  test.each(["missing", "mismatch", "unavailable", "unsupported"] as const)(
    "%s is visible as a read-only warning",
    (status) => {
      const result = checkEmbeddingRegistry({
        status,
        writeMode: "read-only",
        embeddingReadMode: "fail-closed",
        lifecycleState: "degraded",
        lifecycleReady: false,
        reasonCode: status === "missing"
          ? "registry-active-space-missing"
          : status === "mismatch"
            ? "active-space-mismatch"
            : "registry-unavailable",
      });
      expect(result).toMatchObject({
        name: "embedding-registry",
        status: "warning",
        message:
          `status=${status}, registryWriteMode=read-only, writePath=not-probed, ` +
          "embeddingReadMode=fail-closed, lifecycleState=degraded, lifecycleReady=false",
      });
    },
  );

  test("legacy providers remain explicit and never pretend active", () => {
    expect(checkEmbeddingRegistry({
      status: "legacy",
      writeMode: "legacy-write-through",
      embeddingReadMode: "fail-closed",
      lifecycleState: "ready",
      lifecycleReady: true,
      reasonCode: "registry-unavailable",
    })).toMatchObject({
      status: "info",
      message:
        "status=legacy, registryWriteMode=legacy-write-through, writePath=not-probed, " +
        "embeddingReadMode=fail-closed, lifecycleState=ready, lifecycleReady=true",
    });
  });
});

describe("checkModel", () => {
  test("合法 model 返回 ok", () => {
    expect(checkModel("text-embedding-3-small").status).toBe("ok");
  });

  test("非法 model 返回 fatal", () => {
    expect(checkModel("does-not-exist").status).toBe("fatal");
  });

  test("缺失 model 返回 warning", () => {
    expect(checkModel(undefined).status).toBe("warning");
  });
});

describe("checkDisk", () => {
  test("可写目录返回 ok", () => {
    const result = checkDisk(workDir);
    expect(result.status).toBe("ok");
  });

  test("不存在的深层路径父目录不可达返回 warning", () => {
    const result = checkDisk("/nonexistent-root-xyz/sub/db");
    expect(result.status).toBe("warning");
  });

  test("带 home 前缀的 dbPath 按全局 home 展开，不保留为项目相对路径", () => {
    const result = checkDisk("~/definitely-missing-mengshu-test/sub/db");
    expect(result.status).toBe("warning");
    expect(result.message).toContain(join(homedir(), "definitely-missing-mengshu-test", "sub", "db"));
    expect(result.message).not.toContain("/~/");
  });

  test("无 dbPath 返回 warning", () => {
    expect(checkDisk(undefined).status).toBe("warning");
  });
});

describe("checkManifest", () => {
  test("存在合法 manifest 返回 ok", () => {
    writeFileSync(
      join(workDir, MANIFEST_FILENAME),
      JSON.stringify({ version: "0.1", workspaceId: "ws", projectId: "p", defaultVisibility: "workspace", sourceRoots: [], createdAt: 1 }),
    );
    const result = checkManifest(workDir);
    expect(result.status).toBe("ok");
  });

  test("不存在 manifest 返回 info", () => {
    const result = checkManifest(workDir);
    expect(result.status).toBe("info");
    expect(result.message).toMatch(/init/);
  });

  test("损坏 manifest 返回 warning", () => {
    writeFileSync(join(workDir, MANIFEST_FILENAME), "{not json");
    const result = checkManifest(workDir);
    expect(result.status).toBe("warning");
  });
});

describe("registerDoctorCliCommands 注册", () => {
  test("doctor 是只读诊断，缺少 authenticated authority 也必须可运行", async () => {
    const ms = new FakeCommand("ms");
    const health = vi.fn(async () => ({ ok: true, records: 0 }));
    registerDoctorCliCommandsRaw(ms as never, {
      config: validConfig,
      service: { health },
      embeddings: { embed: vi.fn(async () => [0.1]) },
    } as never);

    await expect(ms.find("doctor")?.actionHandler?.(workDir, {})).resolves.not.toThrow();
    expect(health).toHaveBeenCalledTimes(1);
  });

  test("demo/connect 仍必须要求 authenticated authority", async () => {
    const ms = new FakeCommand("ms");
    registerDoctorCliCommandsRaw(ms as never, { config: validConfig } as never);

    await expect(ms.find("demo")?.actionHandler?.(workDir, {})).rejects.toThrow(/authority/i);
    expect(() => ms.find("connect")?.actionHandler?.("openclaw", {})).toThrow(/authority/i);
  });

  test("注册 doctor / demo / connect 命令", () => {
    const ms = new FakeCommand("ms");
    registerDoctorCliCommands(ms as never, {});
    expect(ms.find("doctor")).toBeDefined();
    expect(ms.find("demo")).toBeDefined();
    expect(ms.find("connect")).toBeDefined();
  });
});

describe("ms doctor", () => {
  test("embedding 不可用时输出 warning 而非 fatal，并打印汇总", async () => {
    const ms = new FakeCommand("ms");
    registerDoctorCliCommands(ms as never, {
      config: validConfig,
      service: { health: vi.fn(async () => ({ ok: true, records: 3 })) } as never,
      embeddings: {
        embed: vi.fn(async () => {
          throw new Error("embedding offline");
        }),
      },
    });

    await expect(ms.find("doctor")?.actionHandler?.(workDir, {})).resolves.not.toThrow();
    const text = logs.join("\n");
    expect(text).toMatch(/warning/i);
    expect(text).not.toMatch(/FATAL/);
    expect(text).toMatch(/Config fingerprint: cfg_v1_[a-f0-9]{16}/);
    expect(text).not.toContain("s3cr3t");
  });

  test("DB 异常时输出 fatal", async () => {
    const ms = new FakeCommand("ms");
    registerDoctorCliCommands(ms as never, {
      config: validConfig,
      service: { health: vi.fn(async () => ({ ok: false, error: "db gone" })) } as never,
      embeddings: { embed: vi.fn(async () => [0.1]) },
    });

    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await ms.find("doctor")?.actionHandler?.(workDir, {});
      expect(logs.join("\n")).toMatch(/FATAL/);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  test("PostgreSQL 配置跳过本地 dbPath 磁盘 warning", async () => {
    const ms = new FakeCommand("ms");
    registerDoctorCliCommands(ms as never, {
      config: {
        ...validConfig,
        dbType: "postgres",
        dbPath: undefined,
        postgres: {
          host: "127.0.0.1",
          port: 5432,
          database: "mengshu",
          user: "postgres",
          password: "secret",
        },
      },
      service: { health: vi.fn(async () => ({ ok: true, records: 3 })) } as never,
      embeddings: { embed: vi.fn(async () => [0.1]) },
    });

    await ms.find("doctor")?.actionHandler?.(workDir, {});
    const text = logs.join("\n");
    expect(text).toContain("[info] storage: PostgreSQL 后端，跳过本地 dbPath 磁盘检查");
    expect(text).not.toContain("未配置 dbPath");
  });

  test("OpenClaw doctor exposes registry read-only state without provider details", async () => {
    const ms = new FakeCommand("ms");
    registerDoctorCliCommands(ms as never, {
      config: { ...validConfig, dbType: "postgres" },
      service: { health: vi.fn(async () => ({ ok: true, records: 3 })) } as never,
      embeddings: { embed: vi.fn(async () => [0.1]) },
      embeddingStatus: () => ({
        status: "mismatch",
        writeMode: "read-only",
        embeddingReadMode: "fail-closed",
        lifecycleState: "degraded",
        lifecycleReady: false,
        reasonCode: "active-space-mismatch",
      }),
    });

    await ms.find("doctor")?.actionHandler?.(workDir, {});
    const text = logs.join("\n");
    expect(text).toContain(
      "[warning] embedding-registry: status=mismatch, registryWriteMode=read-only, " +
        "writePath=not-probed, embeddingReadMode=fail-closed, " +
        "lifecycleState=degraded, lifecycleReady=false",
    );
    expect(text).not.toContain("baseURL");
    expect(text).not.toContain("apiKey");
  });

  test("OpenClaw doctor awaits an asynchronous persisted-registry probe", async () => {
    const ms = new FakeCommand("ms");
    const embeddingStatus = vi.fn(async () => ({
      status: "active" as const,
      writeMode: "write-enabled" as const,
      embeddingReadMode: "same-space-ann" as const,
      lifecycleState: "ready" as const,
      lifecycleReady: true,
      reasonCode: "active-space-match" as const,
    }));
    registerDoctorCliCommands(ms as never, {
      config: { ...validConfig, dbType: "postgres" },
      service: { health: vi.fn(async () => ({ ok: true, records: 3 })) } as never,
      embeddings: { embed: vi.fn(async () => [0.1]) },
      embeddingStatus,
    });

    await ms.find("doctor")?.actionHandler?.(workDir, {});
    expect(embeddingStatus).toHaveBeenCalledTimes(1);
    expect(logs.join("\n")).toContain(
      "[ok] embedding-registry: status=active, registryWriteMode=write-enabled, " +
        "writePath=not-probed, embeddingReadMode=same-space-ann, " +
        "lifecycleState=ready, lifecycleReady=true",
    );
  });

  test("registry status callback failures are sanitized as unavailable", async () => {
    const ms = new FakeCommand("ms");
    registerDoctorCliCommands(ms as never, {
      config: { ...validConfig, dbType: "postgres" },
      service: { health: vi.fn(async () => ({ ok: true, records: 3 })) } as never,
      embeddings: { embed: vi.fn(async () => [0.1]) },
      embeddingStatus: () => {
        throw new Error("password=provider-secret");
      },
    });

    await ms.find("doctor")?.actionHandler?.(workDir, {});
    const text = logs.join("\n");
    expect(text).toContain(
      "status=unavailable, registryWriteMode=read-only, writePath=not-probed, " +
        "embeddingReadMode=fail-closed, lifecycleState=degraded, lifecycleReady=false",
    );
    expect(text).not.toContain("provider-secret");
  });
});

describe("ms demo", () => {
  test("注入 fake service 时 store 与 recall 被调用且不 crash", async () => {
    const ms = new FakeCommand("ms");
    const storeMemory = vi.fn(async () => ({ id: "x", stored: true }));
    const recall = vi.fn(async () => ({ scope: {} as never, query: "q", hits: [] }));
    registerDoctorCliCommands(ms as never, {
      config: validConfig,
      service: { storeMemory, recall } as never,
      embeddings: { embed: vi.fn(async () => [0.1, 0.2]) },
    });

    await expect(ms.find("demo")?.actionHandler?.(workDir, {})).resolves.not.toThrow();
    expect(storeMemory).toHaveBeenCalled();
  });

  test("embedding 不可用（recall/store 抛错）时降级提示而非 crash", async () => {
    const ms = new FakeCommand("ms");
    const storeMemory = vi.fn(async () => {
      throw new Error("embedding offline");
    });
    registerDoctorCliCommands(ms as never, {
      config: validConfig,
      service: { storeMemory, recall: vi.fn() } as never,
      embeddings: {
        embed: vi.fn(async () => {
          throw new Error("embedding offline");
        }),
      },
    });

    await expect(ms.find("demo")?.actionHandler?.(workDir, {})).resolves.not.toThrow();
    expect(logs.join("\n")).toMatch(/降级|embedding|无法/);
  });
});

describe("ms connect", () => {
  test("越权 appId 在输出连接信息前拒绝", async () => {
    const ms = new FakeCommand("ms");
    registerDoctorCliCommands(ms as never, { config: validConfig });

    expect(() => ms.find("connect")?.actionHandler?.("evil-app", { dir: workDir }))
      .toThrow(/not allowed|allowlist|authorized/i);
    expect(logs).toEqual([]);
  });

  test("默认输出 server URL 与 scope 示例但不泄露 secret", async () => {
    const ms = new FakeCommand("ms");
    registerDoctorCliCommands(ms as never, { config: validConfig });

    await ms.find("connect")?.actionHandler?.("openclaw", { dir: workDir });
    const text = logs.join("\n");
    expect(text).toContain("http://127.0.0.1:3847");
    expect(text).toContain("scope");
    expect(text).toMatch(/config fingerprint: cfg_v1_[a-f0-9]{16}/i);
    expect(text).not.toContain("s3cr3t");
    expect(text).toMatch(/secret.*已配置.*隐藏/i);
  });

  test("仅显式 --show-secret 时输出原始 secret", async () => {
    const ms = new FakeCommand("ms");
    registerDoctorCliCommands(ms as never, { config: validConfig });

    await ms.find("connect")?.actionHandler?.("openclaw", { dir: workDir, showSecret: true });

    expect(logs.join("\n")).toContain("s3cr3t");
  });

  test("缺 secret 时提示生成", async () => {
    const ms = new FakeCommand("ms");
    registerDoctorCliCommands(ms as never, {
      config: { ...validConfig, server: { host: "127.0.0.1", port: 3847 } },
    });

    await ms.find("connect")?.actionHandler?.("openclaw", { dir: workDir });
    expect(logs.join("\n")).toMatch(/secret/i);
  });
});
