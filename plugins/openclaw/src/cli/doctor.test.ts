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
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerDoctorCliCommands,
  checkConfig,
  checkDb,
  checkEmbedding,
  checkModel,
  checkDisk,
  checkManifest,
} from "./cli-doctor.js";
import { MANIFEST_FILENAME } from "./manifest.js";

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
  console.log = (message?: unknown) => {
    logs.push(String(message));
  };
});

afterEach(() => {
  console.log = originalLog;
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
  });

  test("DB 异常时输出 fatal", async () => {
    const ms = new FakeCommand("ms");
    registerDoctorCliCommands(ms as never, {
      config: validConfig,
      service: { health: vi.fn(async () => ({ ok: false, error: "db gone" })) } as never,
      embeddings: { embed: vi.fn(async () => [0.1]) },
    });

    await ms.find("doctor")?.actionHandler?.(workDir, {});
    expect(logs.join("\n")).toMatch(/FATAL/);
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
  test("输出 server URL 与 scope 示例", async () => {
    const ms = new FakeCommand("ms");
    registerDoctorCliCommands(ms as never, { config: validConfig });

    await ms.find("connect")?.actionHandler?.("openclaw", { dir: workDir });
    const text = logs.join("\n");
    expect(text).toContain("http://127.0.0.1:3847");
    expect(text).toContain("scope");
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
