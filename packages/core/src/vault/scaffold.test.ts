import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  VAULT_MANAGED_DIRECTORIES,
  VAULT_MANAGED_FILES,
  initializeReadOnlyVault,
} from "./scaffold.js";
import type { VaultScopeDescriptor } from "./scope.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function descriptor(rootPath: string, mode: "standalone" | "attached"): VaultScopeDescriptor {
  return {
    vaultId: `vault-${mode}`,
    owner: { tenantId: "tenant-1", userId: "user-1" },
    allowedVisibilities: ["private"],
    allowedProjectIds: ["project-1"],
    namespace: "memories",
    rootPath,
    mode,
    profile: "governed-vault",
  };
}

describe("read-only Vault scaffold", () => {
  test("初始化完整目录、Home、5 Type/Tree/Index 和 Bases，重复执行不改字节", async () => {
    const root = join(await temporaryDirectory("mengshu-vault-parent-"), "Mengshu");
    const first = await initializeReadOnlyVault(descriptor(root, "standalone"));

    expect(first.created).toEqual(expect.arrayContaining([
      "Home.md", "Memory/_index.md", "Trees/_index.md", "Indexes/_index.md",
      "Views/Profile.base", ".mengshu/vault.json",
    ]));
    for (const relative of VAULT_MANAGED_DIRECTORIES) {
      expect((await lstat(join(root, relative))).isDirectory()).toBe(true);
    }
    for (const relative of VAULT_MANAGED_FILES) {
      expect((await lstat(join(root, relative))).isFile()).toBe(true);
    }

    const homeBefore = await readFile(join(root, "Home.md"), "utf8");
    expect(homeBefore).toContain("[[Memory/_index#Profile|Profile]]");
    expect(homeBefore).toContain("[[Trees/_index#Global|Global tree]]");
    expect(homeBefore).toContain("![[Views/Review.base]]");
    expect(await readFile(join(root, "Views", "Rules.base"), "utf8"))
      .toContain('mengshu_semantic_type == "rules"');
    const reviewBase = await readFile(join(root, "Views", "Review.base"), "utf8");
    expect(reviewBase).toContain('mengshu_governance != "current"');
    expect(reviewBase).not.toContain("file.inFolder");
    expect(reviewBase).not.toContain("mengshu_kind ==");

    const second = await initializeReadOnlyVault(descriptor(root, "standalone"));
    expect(second.created).toEqual([]);
    expect(second.unchanged).toHaveLength(VAULT_MANAGED_FILES.length);
    expect(await readFile(join(root, "Home.md"), "utf8")).toBe(homeBefore);
  });

  test("attached 模式只管理选定子目录，不创建或修改父 Vault 的 .obsidian", async () => {
    const parent = await temporaryDirectory("mengshu-attached-parent-");
    const obsidian = join(parent, ".obsidian");
    await mkdir(obsidian);
    await writeFile(join(obsidian, "app.json"), "user-owned\n", "utf8");
    const root = join(parent, "Mengshu");

    await initializeReadOnlyVault(descriptor(root, "attached"));

    expect(await readFile(join(obsidian, "app.json"), "utf8")).toBe("user-owned\n");
    expect(await readdir(obsidian)).toEqual(["app.json"]);
    expect(await readFile(join(root, ".mengshu", "vault.json"), "utf8"))
      .toContain('"mode": "attached"');
  });

  test("已有不同 managed file 时拒绝静默覆盖", async () => {
    const root = join(await temporaryDirectory("mengshu-vault-conflict-"), "Mengshu");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "Home.md"), "user content\n", "utf8");

    await expect(initializeReadOnlyVault(descriptor(root, "standalone")))
      .rejects.toThrowError(expect.objectContaining({ code: "VAULT_MANAGED_FILE_CONFLICT" }));
    expect(await readFile(join(root, "Home.md"), "utf8")).toBe("user content\n");
  });

  test("拒绝通过现有符号链接把 managed 文件写出 Vault", async () => {
    const parent = await temporaryDirectory("mengshu-vault-symlink-");
    const root = join(parent, "Mengshu");
    const outside = await temporaryDirectory("mengshu-vault-outside-");
    await mkdir(root);
    await symlink(outside, join(root, "Memory"));

    await expect(initializeReadOnlyVault(descriptor(root, "standalone")))
      .rejects.toThrowError(expect.objectContaining({ code: "VAULT_PATH_SYMLINK" }));
    expect(await readdir(outside)).toEqual([]);
  });

  test("所有 managed file 的父目录都在声明的 managed directory 内", () => {
    const managedDirectories = new Set<string>(VAULT_MANAGED_DIRECTORIES);
    for (const file of VAULT_MANAGED_FILES) {
      const parent = dirname(file);
      expect(parent === "." || managedDirectories.has(parent)).toBe(true);
    }
  });
});
