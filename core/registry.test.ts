/**
 * core/registry.ts 单测。
 *
 * 覆盖：emptyRegistry、读不存在的 registry、原子写入、upsertProject 合并与 workspace 倒排维护、
 *      touchProjectOpenedAt 幂等性。
 * 测试用 mkdtemp 隔离的临时目录，禁止触碰真实 `~/.memory-autodb/`。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  REGISTRY_VERSION,
  emptyRegistry,
  listProjects,
  readRegistry,
  touchProjectOpenedAt,
  upsertProject,
  writeRegistry,
  type MemoryAutodbRegistry,
  type RegistryProjectEntry,
} from "./registry.js";

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "memory-autodb-registry-"));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

function opts() {
  return { homeDir: tmpHome };
}

const baseEntry: RegistryProjectEntry = {
  workspaceId: "ws-abc",
  displayName: "memory-autodb",
  manifestPath: "/tmp/manifest.json",
  lastSeenRoot: "/Users/test/project",
  lastOpenedAt: 1_780_000_000_000,
};

describe("registry/emptyRegistry", () => {
  it("返回当前 schema 版本和空索引", () => {
    expect(emptyRegistry()).toEqual({ version: REGISTRY_VERSION, projects: {}, workspaces: {} });
  });
});

describe("registry/readRegistry", () => {
  it("文件不存在返回空骨架（不抛错）", () => {
    expect(readRegistry(opts())).toEqual(emptyRegistry());
  });

  it("缺失字段补默认值", () => {
    writeRegistry(
      { version: 1, projects: {}, workspaces: {} } as MemoryAutodbRegistry,
      opts(),
    );
    const reg = readRegistry(opts());
    expect(reg.projects).toEqual({});
    expect(reg.workspaces).toEqual({});
  });

  it("JSON 损坏抛带路径的错误", () => {
    const filePath = join(tmpHome, "registry.json");
    require("node:fs").writeFileSync(filePath, "{not-json", "utf8");
    expect(() => readRegistry(opts())).toThrow(/解析 registry 失败/);
  });
});

describe("registry/writeRegistry", () => {
  it("写入后可被 readRegistry 读回", () => {
    const reg = upsertProject(emptyRegistry(), "proj-1", baseEntry);
    writeRegistry(reg, opts());
    expect(readRegistry(opts())).toEqual(reg);
  });

  it("home 不存在时自动创建目录", () => {
    const deep = join(tmpHome, "nested", "home");
    const reg = upsertProject(emptyRegistry(), "proj-1", baseEntry);
    writeRegistry(reg, { homeDir: deep });
    expect(existsSync(join(deep, "registry.json"))).toBe(true);
  });

  it("不留下 tmp 残文件", () => {
    const reg = upsertProject(emptyRegistry(), "proj-1", baseEntry);
    writeRegistry(reg, opts());
    const files = require("node:fs").readdirSync(tmpHome);
    expect(files).toContain("registry.json");
    expect(files.filter((name: string) => name.endsWith(".tmp"))).toHaveLength(0);
  });
});

describe("registry/upsertProject", () => {
  it("首次插入写入新条目并维护 workspace 倒排表", () => {
    const reg = upsertProject(emptyRegistry(), "proj-1", baseEntry);
    expect(reg.projects["proj-1"]).toEqual(baseEntry);
    expect(reg.workspaces["ws-abc"]).toEqual({ projectIds: ["proj-1"] });
  });

  it("同 projectId 重复 upsert 时合并旧字段（未传则保留）", () => {
    const first = upsertProject(emptyRegistry(), "proj-1", baseEntry);
    const second = upsertProject(first, "proj-1", {
      workspaceId: "ws-abc",
      manifestPath: "/tmp/manifest.json",
      // 注意：未传 displayName 和 lastSeenRoot，应保留旧值
    });
    expect(second.projects["proj-1"].displayName).toBe("memory-autodb");
    expect(second.projects["proj-1"].lastSeenRoot).toBe("/Users/test/project");
  });

  it("换 workspace 时旧 ws 倒排表清理", () => {
    const first = upsertProject(emptyRegistry(), "proj-1", baseEntry);
    const moved = upsertProject(first, "proj-1", {
      ...baseEntry,
      workspaceId: "ws-new",
    });
    expect(moved.workspaces["ws-new"]).toEqual({ projectIds: ["proj-1"] });
    expect(moved.workspaces["ws-abc"]).toBeUndefined();
  });

  it("不修改入参对象", () => {
    const reg = emptyRegistry();
    upsertProject(reg, "proj-1", baseEntry);
    expect(reg.projects).toEqual({});
  });

  it("空 projectId 或 workspaceId 抛错", () => {
    expect(() => upsertProject(emptyRegistry(), "", baseEntry)).toThrow();
    expect(() =>
      upsertProject(emptyRegistry(), "proj-1", { ...baseEntry, workspaceId: "" }),
    ).toThrow();
  });
});

describe("registry/listProjects 与 touchProjectOpenedAt", () => {
  it("listProjects 返回所有项目", () => {
    const reg = upsertProject(
      upsertProject(emptyRegistry(), "proj-1", baseEntry),
      "proj-2",
      { ...baseEntry, workspaceId: "ws-2" },
    );
    const list = listProjects(reg);
    expect(list.map((p) => p.projectId).sort()).toEqual(["proj-1", "proj-2"]);
  });

  it("touchProjectOpenedAt 更新时间戳", () => {
    const reg = upsertProject(emptyRegistry(), "proj-1", baseEntry);
    const touched = touchProjectOpenedAt(reg, "proj-1", 9_999_999_999);
    expect(touched.projects["proj-1"].lastOpenedAt).toBe(9_999_999_999);
  });

  it("touchProjectOpenedAt 对不存在的 projectId 不抛错，原样返回", () => {
    const reg = upsertProject(emptyRegistry(), "proj-1", baseEntry);
    const touched = touchProjectOpenedAt(reg, "proj-missing", 9_999_999_999);
    expect(touched).toBe(reg);
  });
});

describe("registry/写入格式", () => {
  it("使用 2 空格缩进 + 末尾换行", () => {
    const reg = upsertProject(emptyRegistry(), "proj-1", baseEntry);
    writeRegistry(reg, opts());
    const raw = readFileSync(join(tmpHome, "registry.json"), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain("  \"version\":");
  });
});
