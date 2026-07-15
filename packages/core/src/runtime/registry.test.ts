/**
 * core/registry.ts 单测。
 *
 * 覆盖：emptyRegistry、读不存在的 registry、原子写入、upsertProject 合并与 workspace 倒排维护、
 *      touchProjectOpenedAt 幂等性。
 * 测试用 mkdtemp 隔离的临时目录，禁止触碰真实 `~/.mengshu/`。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  REGISTRY_VERSION,
  emptyRegistry,
  listProjects,
  registerCanonicalProject,
  readRegistry,
  resolveProjectAlias,
  resolveProjectPath,
  serializeRegistry,
  touchProjectOpenedAt,
  upsertProject,
  writeRegistry,
  type MemoryAutodbRegistry,
  type RegistryProjectEntry,
} from "./registry.js";

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "mengshu-registry-"));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

function opts() {
  return { homeDir: tmpHome };
}

const baseEntry: RegistryProjectEntry = {
  workspaceId: "ws-abc",
  displayName: "mengshu",
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
    expect(second.projects["proj-1"].displayName).toBe("mengshu");
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

describe("registry/v1 -> v2 in-memory upgrade", () => {
  function writeLegacyRegistry(registry: unknown): void {
    writeFileSync(join(tmpHome, "registry.json"), `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  }

  it("保留旧 identity/workspace 字段，并从 displayName 与现存 root 生成 v2 绑定", () => {
    const root = join(tmpHome, "legacy-project");
    mkdirSync(root, { recursive: true });
    writeLegacyRegistry({
      version: 1,
      projects: {
        "legacy-project": {
          workspaceId: "legacy-workspace",
          displayName: "旧项目",
          manifestPath: "/tmp/legacy-manifest.json",
          lastSeenRoot: root,
          lastOpenedAt: 123,
        },
      },
      workspaces: {
        "legacy-workspace": { projectIds: ["legacy-project"] },
      },
    });

    const upgraded = readRegistry(opts());

    expect(upgraded.version).toBe(REGISTRY_VERSION);
    expect(upgraded.workspaces).toEqual({
      "legacy-workspace": { projectIds: ["legacy-project"] },
    });
    expect(upgraded.projects["legacy-project"]).toMatchObject({
      workspaceId: "legacy-workspace",
      displayName: "旧项目",
      manifestPath: "/tmp/legacy-manifest.json",
      lastSeenRoot: root,
      canonicalRoot: realpathSync.native(root),
      lastOpenedAt: 123,
      aliases: [{ value: "旧项目", normalized: "旧项目", source: "display-name" }],
    });
    expect(upgraded.upgradeAudit).toEqual({
      fromVersion: 1,
      toVersion: REGISTRY_VERSION,
      diagnostics: [],
    });
    expect(resolveProjectAlias(upgraded, "旧项目")?.projectId).toBe("legacy-project");
    expect(resolveProjectPath(upgraded, root)?.projectId).toBe("legacy-project");
  });

  it.each([
    [undefined, "last-seen-root-missing"],
    ["relative/project", "last-seen-root-not-absolute"],
    ["/definitely/not/a/real/mengshu/project", "last-seen-root-not-found"],
  ] as const)("lastSeenRoot=%s 时保持未绑定并留下诊断 %s", (lastSeenRoot, code) => {
    writeLegacyRegistry({
      version: 1,
      projects: {
        legacy: {
          workspaceId: "ws",
          displayName: "Legacy",
          manifestPath: "/tmp/legacy.json",
          ...(lastSeenRoot === undefined ? {} : { lastSeenRoot }),
        },
      },
      workspaces: { ws: { projectIds: ["legacy"] } },
    });

    const upgraded = readRegistry(opts());

    expect(upgraded.projects.legacy.canonicalRoot).toBeUndefined();
    expect(upgraded.upgradeAudit?.diagnostics).toContainEqual({
      projectId: "legacy",
      code,
    });
  });

  it("display alias 或 realpath 冲突时双方均保持未绑定并 fail-closed 诊断", () => {
    const root = join(tmpHome, "shared-root");
    const rootLink = join(tmpHome, "shared-root-link");
    mkdirSync(root, { recursive: true });
    symlinkSync(root, rootLink);
    writeLegacyRegistry({
      version: 1,
      projects: {
        alpha: {
          workspaceId: "ws",
          displayName: "共享名称",
          manifestPath: "/tmp/alpha.json",
          lastSeenRoot: root,
        },
        beta: {
          workspaceId: "ws",
          displayName: "共享名称",
          manifestPath: "/tmp/beta.json",
          lastSeenRoot: rootLink,
        },
      },
      workspaces: { ws: { projectIds: ["alpha", "beta"] } },
    });

    const upgraded = readRegistry(opts());

    expect(upgraded.projects.alpha.canonicalRoot).toBeUndefined();
    expect(upgraded.projects.beta.canonicalRoot).toBeUndefined();
    expect(upgraded.projects.alpha.aliases).toBeUndefined();
    expect(upgraded.projects.beta.aliases).toBeUndefined();
    expect(upgraded.upgradeAudit?.diagnostics).toEqual([
      { projectId: "alpha", code: "canonical-path-conflict" },
      { projectId: "alpha", code: "display-alias-conflict" },
      { projectId: "beta", code: "canonical-path-conflict" },
      { projectId: "beta", code: "display-alias-conflict" },
    ]);
    expect(resolveProjectAlias(upgraded, "共享名称")).toBeNull();
    expect(resolveProjectPath(upgraded, root)).toBeNull();
  });

  it("规范化后相同的 legacy projectId 保留原 key，但明确诊断且查询 fail-closed", () => {
    writeLegacyRegistry({
      version: 1,
      projects: {
        Alpha: {
          workspaceId: "ws",
          manifestPath: "/tmp/alpha-upper.json",
        },
        alpha: {
          workspaceId: "ws",
          manifestPath: "/tmp/alpha-lower.json",
        },
      },
      workspaces: { ws: { projectIds: ["Alpha", "alpha"] } },
    });

    const upgraded = readRegistry(opts());

    expect(Object.keys(upgraded.projects).sort()).toEqual(["Alpha", "alpha"]);
    expect(upgraded.upgradeAudit?.diagnostics).toEqual([
      { projectId: "Alpha", code: "last-seen-root-missing" },
      { projectId: "Alpha", code: "project-id-normalization-conflict" },
      { projectId: "alpha", code: "last-seen-root-missing" },
      { projectId: "alpha", code: "project-id-normalization-conflict" },
    ]);
    expect(() => resolveProjectAlias(upgraded, "alpha")).toThrow(/冲突/);
  });

  it("升级结果 write -> read 保持稳定，且不重复升级", () => {
    const root = join(tmpHome, "roundtrip");
    mkdirSync(root, { recursive: true });
    writeLegacyRegistry({
      version: 1,
      projects: {
        roundtrip: {
          workspaceId: "ws",
          displayName: "Round Trip",
          manifestPath: "/tmp/roundtrip.json",
          lastSeenRoot: root,
        },
      },
      workspaces: { ws: { projectIds: ["roundtrip"] } },
    });

    const upgraded = readRegistry(opts());
    writeRegistry(upgraded, opts());

    expect(readRegistry(opts())).toEqual(upgraded);
    expect(readFileSync(join(tmpHome, "registry.json"), "utf8")).toBe(serializeRegistry(upgraded));
  });
});

describe("registry/canonical project identity", () => {
  function createProjectRoot(name: string): string {
    const root = join(tmpHome, "roots", name);
    mkdirSync(root, { recursive: true });
    return root;
  }

  function canonicalEntry(root: string, workspaceId = "ws-canonical"): RegistryProjectEntry {
    return {
      workspaceId,
      displayName: `Canonical ${workspaceId}`,
      manifestPath: join(tmpHome, "manifests", `${workspaceId}.json`),
      lastSeenRoot: root,
      lastOpenedAt: 123,
    };
  }

  it("规范化 canonical projectId，并支持 slug 与中文 alias 的可解释查询", () => {
    const root = createProjectRoot("alpha");
    const registry = registerCanonicalProject(
      emptyRegistry(),
      "  Project-Alpha  ",
      canonicalEntry(root),
      { slug: "ＭｅｎｇＳｈｕ", aliases: ["梦枢"] },
    );

    expect(registry.projects["project-alpha"]?.canonicalRoot).toBe(realpathSync.native(root));
    expect(resolveProjectAlias(registry, "mengshu")).toMatchObject({
      projectId: "project-alpha",
      matchedBy: "alias",
      aliasSource: "slug",
    });
    expect(resolveProjectAlias(registry, "梦枢")).toMatchObject({
      projectId: "project-alpha",
      matchedBy: "alias",
      aliasSource: "explicit",
    });
    expect(resolveProjectAlias(registry, "PROJECT-ALPHA")).toMatchObject({
      projectId: "project-alpha",
      matchedBy: "project-id",
      aliasSource: "project-id",
    });
  });

  it("拒绝相对 root/manifest path", () => {
    const root = createProjectRoot("absolute");
    expect(() =>
      registerCanonicalProject(emptyRegistry(), "project-a", {
        ...canonicalEntry(root),
        lastSeenRoot: "relative/project",
      }),
    ).toThrow(/absolute|绝对/i);
    expect(() =>
      registerCanonicalProject(emptyRegistry(), "project-a", {
        ...canonicalEntry(root),
        manifestPath: "relative/manifest.json",
      }),
    ).toThrow(/absolute|绝对/i);
  });

  it("real path 相同但 projectId 不同时 fail-closed", () => {
    const root = createProjectRoot("real");
    const link = join(tmpHome, "roots", "real-link");
    symlinkSync(root, link);
    const first = registerCanonicalProject(emptyRegistry(), "project-a", canonicalEntry(root));

    expect(() =>
      registerCanonicalProject(first, "project-b", canonicalEntry(link, "ws-b")),
    ).toThrow(/path|路径|绑定/i);
  });

  it("只按规范化路径精确比较，不把同前缀目录误判为冲突", () => {
    const root = createProjectRoot("project");
    const rootWithSamePrefix = createProjectRoot("project-copy");
    const first = registerCanonicalProject(emptyRegistry(), "project-a", canonicalEntry(root));
    const second = registerCanonicalProject(
      first,
      "project-b",
      canonicalEntry(rootWithSamePrefix, "ws-b"),
    );

    expect(resolveProjectPath(second, rootWithSamePrefix)?.projectId).toBe("project-b");
  });

  it("alias 已绑定到其它 project 时 fail-closed", () => {
    const first = registerCanonicalProject(
      emptyRegistry(),
      "project-a",
      canonicalEntry(createProjectRoot("a")),
      { aliases: ["共享别名"] },
    );

    expect(() =>
      registerCanonicalProject(
        first,
        "project-b",
        canonicalEntry(createProjectRoot("b"), "ws-b"),
        { aliases: [" 共享别名 "] },
      ),
    ).toThrow(/alias|别名/i);
  });

  it("相同 canonical identity 重复注册幂等", () => {
    const root = createProjectRoot("idempotent");
    const entry = canonicalEntry(root);
    const first = registerCanonicalProject(emptyRegistry(), "Project-A", entry, {
      slug: "project-a-slug",
      aliases: ["项目甲"],
    });
    const second = registerCanonicalProject(first, "project-a", entry, {
      aliases: ["项目甲"],
      slug: "project-a-slug",
    });

    expect(second).toEqual(first);
  });

  it("不同注册顺序产生稳定序列化", () => {
    const rootA = createProjectRoot("stable-a");
    const rootB = createProjectRoot("stable-b");
    const forward = registerCanonicalProject(
      registerCanonicalProject(emptyRegistry(), "project-a", canonicalEntry(rootA, "ws-a")),
      "project-b",
      canonicalEntry(rootB, "ws-b"),
    );
    const reverse = registerCanonicalProject(
      registerCanonicalProject(emptyRegistry(), "project-b", canonicalEntry(rootB, "ws-b")),
      "project-a",
      canonicalEntry(rootA, "ws-a"),
    );

    expect(serializeRegistry(reverse)).toBe(serializeRegistry(forward));
  });
});
