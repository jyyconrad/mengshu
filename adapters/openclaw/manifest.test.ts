/**
 * manifest.ts 单元测试。
 *
 * 覆盖 A2-lite 验收核心：
 * 1. createManifest 幂等（同一目录两次创建得到相同 workspaceId/projectId）。
 * 2. readManifest 不存在返回 null、解析失败抛带路径错误。
 * 3. writeManifest + readManifest 往返一致。
 * 4. manifestToScope 映射正确（appId/tenantId 固定，visibility/workspace/project 来自 manifest）。
 * 5. 目录移动 identity 不变（manifest 内记录的 id 随指针文件保留，readManifest 不重算）。
 *
 * v0.1.2 新增：
 * 6. createPointer 由 manifest 派生轻量指针，manifestPath 正确。
 * 7. writeProjectIdentity 同时写项目指针和全局 manifest，内容一致。
 * 8. readPointerOrLegacyManifest 区分 0.1（legacy）和 0.2（pointer）格式。
 * 9. readProjectManifest 在 pointer 场景读全局 manifest，legacy 场景直接返回。
 * 10. pointer 指向不存在的全局 manifest 时抛错。
 *
 * 使用 os.tmpdir 下的临时目录，测试后清理，保持纯单元风格。
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MANIFEST_FILENAME,
  MANIFEST_POINTER_VERSION,
  createManifest,
  createPointer,
  readManifest,
  writeManifest,
  manifestToScope,
  readPointerOrLegacyManifest,
  writeProjectIdentity,
  readProjectManifest,
} from "./manifest.js";

let workDir: string;
let testHome: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "memory-autodb-manifest-"));
  testHome = mkdtempSync(join(tmpdir(), "memory-autodb-home-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  rmSync(testHome, { recursive: true, force: true });
});

describe("createManifest", () => {
  test("同一目录两次创建得到相同 workspaceId/projectId（幂等）", () => {
    const first = createManifest({ dir: workDir });
    const second = createManifest({ dir: workDir });

    expect(first.workspaceId).toBe(second.workspaceId);
    expect(first.projectId).toBe(second.projectId);
    expect(first.projectId).toMatch(/^proj-/);
    expect(first.workspaceId).toMatch(/^ws-/);
  });

  test("不同目录得到不同 projectId", () => {
    const other = mkdtempSync(join(tmpdir(), "memory-autodb-other-"));
    try {
      expect(createManifest({ dir: workDir }).projectId).not.toBe(
        createManifest({ dir: other }).projectId,
      );
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("显式传入覆盖自动生成的 id 与可见性", () => {
    const manifest = createManifest({
      dir: workDir,
      workspaceId: "ws-acme",
      projectId: "proj-acme",
      userId: "user-1",
      defaultVisibility: "private",
    });

    expect(manifest.workspaceId).toBe("ws-acme");
    expect(manifest.projectId).toBe("proj-acme");
    expect(manifest.userId).toBe("user-1");
    expect(manifest.defaultVisibility).toBe("private");
  });

  test("默认 visibility 为 workspace 且带默认复用策略与空 sourceRoots", () => {
    const manifest = createManifest({ dir: workDir });
    expect(manifest.defaultVisibility).toBe("workspace");
    expect(manifest.sourceRoots).toEqual([]);
    expect(manifest.slotReusePolicy?.profile).toBe("workspace");
    expect(manifest.slotReusePolicy?.task_context).toBe("project");
    expect(typeof manifest.createdAt).toBe("number");
    expect(manifest.version).toBe("0.1");
  });
});

describe("readManifest", () => {
  test("文件不存在返回 null", () => {
    expect(readManifest(workDir)).toBeNull();
  });

  test("JSON 解析失败抛出带文件路径的错误", () => {
    writeFileSync(join(workDir, MANIFEST_FILENAME), "{ not json", "utf8");
    expect(() => readManifest(workDir)).toThrow(MANIFEST_FILENAME);
  });
});

describe("writeManifest + readManifest 往返", () => {
  test("写入后可读回相同内容", () => {
    const manifest = createManifest({ dir: workDir, userId: "user-1" });
    writeManifest(workDir, manifest);

    expect(existsSync(join(workDir, MANIFEST_FILENAME))).toBe(true);
    const loaded = readManifest(workDir);
    expect(loaded).toEqual(manifest);
  });
});

describe("manifestToScope", () => {
  test("映射 appId=openclaw、tenantId=local，workspace/project/userId/visibility 来自 manifest", () => {
    const manifest = createManifest({
      dir: workDir,
      workspaceId: "ws-acme",
      projectId: "proj-acme",
      userId: "user-1",
      defaultVisibility: "workspace",
    });
    const scope = manifestToScope(manifest);

    expect(scope.appId).toBe("openclaw");
    expect(scope.tenantId).toBe("local");
    expect(scope.workspaceId).toBe("ws-acme");
    expect(scope.projectId).toBe("proj-acme");
    expect(scope.userId).toBe("user-1");
    expect(scope.namespace).toBe("memories");
    expect(scope.visibility).toBe("workspace");
  });

  test("overrides 覆盖 manifest 推导的 scope 字段", () => {
    const manifest = createManifest({ dir: workDir, projectId: "proj-acme" });
    const scope = manifestToScope(manifest, { agentId: "agent-x", namespace: "knowledge" });
    expect(scope.agentId).toBe("agent-x");
    expect(scope.namespace).toBe("knowledge");
    expect(scope.projectId).toBe("proj-acme");
  });
});

describe("目录移动 identity 不变", () => {
  test("manifest 指针随文件移动后 readManifest 仍返回原 id（不重算）", () => {
    const original = createManifest({ dir: workDir, userId: "user-1" });
    writeManifest(workDir, original);

    // 模拟移动：把 manifest 文件内容原样写到新目录（路径不同）
    const movedDir = mkdtempSync(join(tmpdir(), "memory-autodb-moved-"));
    try {
      writeFileSync(
        join(movedDir, MANIFEST_FILENAME),
        JSON.stringify(original, null, 2),
        "utf8",
      );
      const movedManifest = readManifest(movedDir);
      expect(movedManifest?.projectId).toBe(original.projectId);
      expect(movedManifest?.workspaceId).toBe(original.workspaceId);

      // 新目录直接 createManifest 会因路径不同得到不同 id，证明 identity 靠指针保留
      expect(createManifest({ dir: movedDir }).projectId).not.toBe(original.projectId);
    } finally {
      rmSync(movedDir, { recursive: true, force: true });
    }
  });
});

describe("createPointer（v0.1.2）", () => {
  test("由 manifest 派生轻量指针，manifestPath 正确", () => {
    const manifest = createManifest({ dir: workDir, projectId: "proj-test" });
    const pointer = createPointer(manifest, { homeDir: testHome });

    expect(pointer.version).toBe(MANIFEST_POINTER_VERSION);
    expect(pointer.workspaceId).toBe(manifest.workspaceId);
    expect(pointer.projectId).toBe(manifest.projectId);
    expect(pointer.createdAt).toBe(manifest.createdAt);
    expect(pointer.manifestPath).toContain("proj-test");
    expect(pointer.manifestPath).toContain("manifest.json");
  });
});

describe("writeProjectIdentity（v0.1.2）", () => {
  test("同时写项目指针和全局 manifest，内容一致", () => {
    const manifest = createManifest({ dir: workDir, projectId: "proj-xyz", userId: "user-1" });
    writeProjectIdentity(workDir, manifest, { homeDir: testHome });

    // 检查项目指针
    const pointerPath = join(workDir, MANIFEST_FILENAME);
    expect(existsSync(pointerPath)).toBe(true);
    const pointerContent = JSON.parse(readFileSync(pointerPath, "utf8"));
    expect(pointerContent.version).toBe(MANIFEST_POINTER_VERSION);
    expect(pointerContent.projectId).toBe("proj-xyz");

    // 检查全局 manifest
    const globalPath = join(testHome, "projects", "proj-xyz", "manifest.json");
    expect(existsSync(globalPath)).toBe(true);
    const globalContent = JSON.parse(readFileSync(globalPath, "utf8"));
    expect(globalContent.version).toBe("0.1");
    expect(globalContent.projectId).toBe("proj-xyz");
    expect(globalContent.userId).toBe("user-1");
    expect(globalContent.slotReusePolicy).toBeDefined();
  });

  test("全局目录不存在时自动创建", () => {
    const manifest = createManifest({ dir: workDir, projectId: "proj-auto" });
    const nonExistentHome = join(testHome, "nested", "path");

    writeProjectIdentity(workDir, manifest, { homeDir: nonExistentHome });

    const globalPath = join(nonExistentHome, "projects", "proj-auto", "manifest.json");
    expect(existsSync(globalPath)).toBe(true);
  });
});

describe("readPointerOrLegacyManifest（v0.1.2）", () => {
  test("识别 0.2 指针格式", () => {
    const pointer = {
      version: "0.2",
      workspaceId: "ws-test",
      projectId: "proj-test",
      manifestPath: "/fake/path/manifest.json",
      createdAt: Date.now(),
    };
    writeFileSync(join(workDir, MANIFEST_FILENAME), JSON.stringify(pointer, null, 2), "utf8");

    const result = readPointerOrLegacyManifest(workDir);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("pointer");
    if (result?.kind === "pointer") {
      expect(result.pointer.projectId).toBe("proj-test");
    }
  });

  test("识别 0.1 legacy 完整 manifest", () => {
    const manifest = createManifest({ dir: workDir, projectId: "proj-legacy" });
    writeManifest(workDir, manifest);

    const result = readPointerOrLegacyManifest(workDir);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("legacy");
    if (result?.kind === "legacy") {
      expect(result.manifest.projectId).toBe("proj-legacy");
      expect(result.manifest.slotReusePolicy).toBeDefined();
    }
  });

  test("文件不存在返回 null", () => {
    expect(readPointerOrLegacyManifest(workDir)).toBeNull();
  });
});

describe("readProjectManifest（v0.1.2）", () => {
  test("pointer 场景：读取全局 manifest", () => {
    const manifest = createManifest({ dir: workDir, projectId: "proj-ptr", userId: "user-x" });
    writeProjectIdentity(workDir, manifest, { homeDir: testHome });

    const loaded = readProjectManifest(workDir, { homeDir: testHome });
    expect(loaded).not.toBeNull();
    expect(loaded?.projectId).toBe("proj-ptr");
    expect(loaded?.userId).toBe("user-x");
    expect(loaded?.slotReusePolicy).toBeDefined();
  });

  test("legacy 场景：直接返回项目目录的完整 manifest", () => {
    const manifest = createManifest({ dir: workDir, projectId: "proj-old" });
    writeManifest(workDir, manifest);

    const loaded = readProjectManifest(workDir, { homeDir: testHome });
    expect(loaded).not.toBeNull();
    expect(loaded?.projectId).toBe("proj-old");
    expect(loaded?.slotReusePolicy).toBeDefined();
  });

  test("pointer 指向不存在的全局 manifest 时抛错", () => {
    const pointer = {
      version: "0.2",
      workspaceId: "ws-broken",
      projectId: "proj-broken",
      manifestPath: join(testHome, "projects", "proj-broken", "manifest.json"),
      createdAt: Date.now(),
    };
    writeFileSync(join(workDir, MANIFEST_FILENAME), JSON.stringify(pointer, null, 2), "utf8");

    expect(() => readProjectManifest(workDir, { homeDir: testHome })).toThrow(/不存在/);
    expect(() => readProjectManifest(workDir, { homeDir: testHome })).toThrow(/proj-broken/);
  });

  test("文件不存在返回 null", () => {
    expect(readProjectManifest(workDir, { homeDir: testHome })).toBeNull();
  });
});
