/**
 * cli-project.ts 命令注册单元测试。
 *
 * 用 fake CommanderLike 捕获注册的命令名与 action，验证：
 * 1. 注册 init 与 project（status/context/lookup）命令。
 * 2. init action 能在临时目录创建 .mengshu.json，并打印 workspace/project id。
 * 3. init 幂等：已存在且无 --force 时不覆盖，保留原 id；--force 时覆盖。
 * 4. project status 读 manifest 打印 identity / scope / 复用策略；无 manifest 时提示 init。
 * 5. project lookup 基于 manifest scope 调 service.recall 并打印命中。
 * 6. project context 在 recall 失败（embedding 不可用）时降级提示而非 crash。
 *
 * v0.1.2 新增：
 * 7. init 后 registry.json 包含该 projectId。
 * 8. init 后全局目录有 projects/<projectId>/manifest.json。
 * 9. 第二次 init（不带 --force）touch lastOpenedAt。
 * 10. 旧 manifest（0.1 完整格式）兼容：status 命令依然能读出，不抛错。
 *
 * 使用 os.tmpdir 临时目录，测试后清理。
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerProjectCliCommands } from "./cli-project.js";
import { MANIFEST_FILENAME, readManifest, createManifest, writeManifest, readProjectManifest } from "./manifest.js";
import { readRegistry } from "../../core/registry.js";

/** 鸭子类型 fake：支持 command 字符串含位置参数（init [dir] / lookup <query>）。 */
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

  /** 测试辅助：按命令名前缀（忽略位置参数）查找子命令。 */
  find(name: string): FakeCommand | undefined {
    return this.subcommands.find((c) => c.name === name || c.name.startsWith(`${name} `));
  }
}

let workDir: string;
let testHome: string;
let logs: string[];
let originalLog: typeof console.log;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "mengshu-cli-"));
  testHome = mkdtempSync(join(tmpdir(), "mengshu-home-"));
  // 写入最小 config.json 避免触发交互式向导
  writeFileSync(join(testHome, "config.json"), JSON.stringify({ embedding: { apiKey: "test", baseURL: "http://localhost" } }));
  logs = [];
  originalLog = console.log;
  console.log = (message?: unknown) => {
    logs.push(String(message));
  };
});

afterEach(() => {
  console.log = originalLog;
  rmSync(workDir, { recursive: true, force: true });
  rmSync(testHome, { recursive: true, force: true });
});

describe("registerProjectCliCommands 注册", () => {
  test("注册 init 与 project 子命令族", () => {
    const ms = new FakeCommand("ms");
    registerProjectCliCommands(ms as never, { homePathOptions: { homeDir: testHome } });

    expect(ms.find("init")).toBeDefined();
    const project = ms.find("project");
    expect(project).toBeDefined();
    expect(project?.subcommands.map((c) => c.name.split(" ")[0])).toEqual([
      "status",
      "context",
      "lookup",
      "ingest-history",
    ]);
  });
});

describe("ms init", () => {
  test("创建 manifest 文件并打印 workspace/project id", async () => {
    const ms = new FakeCommand("ms");
    registerProjectCliCommands(ms as never, { homePathOptions: { homeDir: testHome } });

    await ms.find("init")?.actionHandler?.(workDir, { userId: "user-1" });

    expect(existsSync(join(workDir, MANIFEST_FILENAME))).toBe(true);
    const manifest = readProjectManifest(workDir, { homeDir: testHome });
    expect(manifest?.userId).toBe("user-1");
    expect(logs.join("\n")).toContain(manifest!.workspaceId);
    expect(logs.join("\n")).toContain(manifest!.projectId);
  });

  test("已存在且无 --force 时不覆盖，保留原 id", async () => {
    const ms = new FakeCommand("ms");
    registerProjectCliCommands(ms as never, { homePathOptions: { homeDir: testHome } });

    await ms.find("init")?.actionHandler?.(workDir, { projectId: "proj-keep" });
    const before = readProjectManifest(workDir, { homeDir: testHome });
    logs.length = 0;

    await ms.find("init")?.actionHandler?.(workDir, { projectId: "proj-other" });
    const after = readProjectManifest(workDir, { homeDir: testHome });

    expect(after?.projectId).toBe("proj-keep");
    expect(after?.createdAt).toBe(before?.createdAt);
    expect(logs.join("\n")).toMatch(/已存在|--force/);
  });

  test("--force 覆盖既有 manifest", async () => {
    const ms = new FakeCommand("ms");
    registerProjectCliCommands(ms as never, { homePathOptions: { homeDir: testHome } });

    await ms.find("init")?.actionHandler?.(workDir, { projectId: "proj-keep" });
    await ms.find("init")?.actionHandler?.(workDir, { projectId: "proj-new", force: true });

    expect(readProjectManifest(workDir, { homeDir: testHome })?.projectId).toBe("proj-new");
  });

  test("显式 --visibility 写入 manifest", async () => {
    const ms = new FakeCommand("ms");
    registerProjectCliCommands(ms as never, { homePathOptions: { homeDir: testHome } });

    await ms.find("init")?.actionHandler?.(workDir, { visibility: "private" });
    expect(readProjectManifest(workDir, { homeDir: testHome })?.defaultVisibility).toBe("private");
  });

  test("init 后 registry.json 包含该 projectId", async () => {
    const ms = new FakeCommand("ms");
    registerProjectCliCommands(ms as never, { homePathOptions: { homeDir: testHome } });

    await ms.find("init")?.actionHandler?.(workDir, { projectId: "proj-reg" });

    const registry = readRegistry({ homeDir: testHome });
    expect(registry.projects["proj-reg"]).toBeDefined();
    expect(registry.projects["proj-reg"].lastSeenRoot).toBe(workDir);
  });

  test("init 后全局目录有 projects/<projectId>/manifest.json", async () => {
    const ms = new FakeCommand("ms");
    registerProjectCliCommands(ms as never, { homePathOptions: { homeDir: testHome } });

    await ms.find("init")?.actionHandler?.(workDir, { projectId: "proj-global" });

    const globalManifestPath = join(testHome, "projects", "proj-global", "manifest.json");
    expect(existsSync(globalManifestPath)).toBe(true);
    const globalContent = JSON.parse(readFileSync(globalManifestPath, "utf8"));
    expect(globalContent.projectId).toBe("proj-global");
    expect(globalContent.slotReusePolicy).toBeDefined();
  });

  test("第二次 init（不带 --force）touch lastOpenedAt", async () => {
    const ms = new FakeCommand("ms");
    registerProjectCliCommands(ms as never, { homePathOptions: { homeDir: testHome } });

    await ms.find("init")?.actionHandler?.(workDir, { projectId: "proj-touch" });
    const registry1 = readRegistry({ homeDir: testHome });
    const firstOpened = registry1.projects["proj-touch"].lastOpenedAt;

    // 等待至少 1ms
    await new Promise((resolve) => setTimeout(resolve, 10));

    await ms.find("init")?.actionHandler?.(workDir, { projectId: "proj-touch" });
    const registry2 = readRegistry({ homeDir: testHome });
    const secondOpened = registry2.projects["proj-touch"].lastOpenedAt;

    expect(secondOpened).toBeGreaterThan(firstOpened!);
  });
});

describe("ms project status", () => {
  test("读 manifest 打印 identity / scope / 复用策略", async () => {
    const ms = new FakeCommand("ms");
    registerProjectCliCommands(ms as never, {
      getRecordCount: async () => 7,
      homePathOptions: { homeDir: testHome },
    });

    await ms.find("init")?.actionHandler?.(workDir, { workspaceId: "ws-acme", projectId: "proj-acme" });
    logs.length = 0;

    await ms.find("project")?.find("status")?.actionHandler?.(workDir, {});

    const text = logs.join("\n");
    expect(text).toContain("ws-acme");
    expect(text).toContain("proj-acme");
    expect(text).toContain("profile");
    expect(text).toContain("7");
  });

  test("无 manifest 时提示先运行 init", async () => {
    const ms = new FakeCommand("ms");
    registerProjectCliCommands(ms as never, { homePathOptions: { homeDir: testHome } });

    await ms.find("project")?.find("status")?.actionHandler?.(workDir, {});
    expect(logs.join("\n")).toMatch(/init/);
  });

  test("旧 manifest（0.1 完整格式）兼容：status 命令依然能读出", async () => {
    const ms = new FakeCommand("ms");
    registerProjectCliCommands(ms as never, { homePathOptions: { homeDir: testHome } });

    // 手工写一个旧格式完整 manifest
    const legacyManifest = createManifest({ dir: workDir, projectId: "proj-legacy" });
    writeManifest(workDir, legacyManifest);

    await ms.find("project")?.find("status")?.actionHandler?.(workDir, {});

    const text = logs.join("\n");
    expect(text).toContain("proj-legacy");
    expect(text).not.toMatch(/init/);
  });
});

describe("ms project lookup", () => {
  test("基于 manifest scope 调 service.recall 并打印命中", async () => {
    const ms = new FakeCommand("ms");
    const recall = vi.fn(async (_input: { query: string; scope: { projectId: string } }) => ({
      scope: {} as never,
      query: "q",
      hits: [
        {
          record: { id: "m1", text: "记住要先给结论", category: "preference" },
          score: 0.91,
          source: "vector" as const,
        },
      ],
    }));
    registerProjectCliCommands(ms as never, {
      service: { recall } as never,
      homePathOptions: { homeDir: testHome },
    });

    await ms.find("init")?.actionHandler?.(workDir, { projectId: "proj-acme" });
    logs.length = 0;

    await ms.find("project")?.find("lookup")?.actionHandler?.("结论", { dir: workDir });

    expect(recall).toHaveBeenCalledTimes(1);
    const callArg = recall.mock.calls[0][0];
    expect(callArg.query).toBe("结论");
    expect(callArg.scope.projectId).toBe("proj-acme");
    expect(logs.join("\n")).toContain("记住要先给结论");
  });

  test("无 manifest 时提示先运行 init", async () => {
    const ms = new FakeCommand("ms");
    registerProjectCliCommands(ms as never, {
      service: { recall: vi.fn() } as never,
      homePathOptions: { homeDir: testHome },
    });

    await ms.find("project")?.find("lookup")?.actionHandler?.("q", { dir: workDir });
    expect(logs.join("\n")).toMatch(/init/);
  });
});

describe("ms project context", () => {
  test("recall 失败（embedding 不可用）时降级提示而非抛错", async () => {
    const ms = new FakeCommand("ms");
    const recall = vi.fn(async () => {
      throw new Error("embedding api key missing");
    });
    registerProjectCliCommands(ms as never, {
      service: { recall } as never,
      homePathOptions: { homeDir: testHome },
    });

    await ms.find("init")?.actionHandler?.(workDir, { projectId: "proj-acme" });
    logs.length = 0;

    await expect(
      ms.find("project")?.find("context")?.actionHandler?.(workDir, {}),
    ).resolves.not.toThrow();
    expect(logs.join("\n")).toMatch(/降级|embedding|无法/);
  });

  test("无 service 时打印 scope 但提示无法构建上下文", async () => {
    const ms = new FakeCommand("ms");
    registerProjectCliCommands(ms as never, { homePathOptions: { homeDir: testHome } });

    await ms.find("init")?.actionHandler?.(workDir, { projectId: "proj-acme" });
    logs.length = 0;

    await ms.find("project")?.find("context")?.actionHandler?.(workDir, {});
    expect(logs.join("\n")).toContain("proj-acme");
  });
});
