import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  VaultPolicyError,
  assertVaultAllowsScope,
  validateVaultScopeDescriptor,
  type VaultScopeDescriptor,
} from "./scope.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function descriptor(
  overrides: Partial<VaultScopeDescriptor> = {},
): Promise<VaultScopeDescriptor> {
  const rootPath = await mkdtemp(join(tmpdir(), "mengshu-vault-scope-"));
  temporaryRoots.push(rootPath);
  return {
    vaultId: "vault-private-1",
    owner: { tenantId: "tenant-1", userId: "user-1" },
    allowedVisibilities: ["private"],
    allowedProjectIds: ["project-a", "project-b"],
    namespace: "memories",
    rootPath,
    mode: "standalone",
    profile: "governed-vault",
    ...overrides,
  };
}

describe("VaultScopeDescriptor", () => {
  test("校验首期 private-only 描述符并返回不可变副本", async () => {
    const input = await descriptor();
    const validated = validateVaultScopeDescriptor(input);

    expect(validated).toEqual(input);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.owner)).toBe(true);
    expect(Object.isFrozen(validated.allowedProjectIds)).toBe(true);

    (input.allowedProjectIds as string[])[0] = "mutated";
    expect(validated.allowedProjectIds).toEqual(["project-a", "project-b"]);
  });

  test("拒绝非 private、重复 allowlist、相对根路径和额外字段", async () => {
    const valid = await descriptor();

    expect(() => validateVaultScopeDescriptor({
      ...valid,
      allowedVisibilities: ["private", "workspace"],
    })).toThrowError(expect.objectContaining({ code: "VAULT_VISIBILITY_UNSUPPORTED" }));
    expect(() => validateVaultScopeDescriptor({
      ...valid,
      allowedProjectIds: ["project-a", "project-a"],
    })).toThrowError(expect.objectContaining({ code: "VAULT_DESCRIPTOR_INVALID" }));
    expect(() => validateVaultScopeDescriptor({
      ...valid,
      rootPath: "relative/vault",
    })).toThrowError(expect.objectContaining({ code: "VAULT_ROOT_INVALID" }));
    expect(() => validateVaultScopeDescriptor({
      ...valid,
      unexpected: true,
    } as never)).toThrowError(VaultPolicyError);
  });

  test("只允许 owner/namespace 精确匹配且 project allowlist 只能收窄", async () => {
    const vault = validateVaultScopeDescriptor(await descriptor());
    const allowed = {
      tenantId: "tenant-1",
      userId: "user-1",
      namespace: "memories",
      projectId: "project-a",
      visibility: "private" as const,
    };

    expect(assertVaultAllowsScope(vault, allowed)).toEqual(allowed);
    for (const denied of [
      { ...allowed, tenantId: "tenant-2" },
      { ...allowed, userId: "user-2" },
      { ...allowed, namespace: "knowledge" },
      { ...allowed, projectId: "project-c" },
      { ...allowed, visibility: "workspace" as const },
    ]) {
      expect(() => assertVaultAllowsScope(vault, denied))
        .toThrowError(expect.objectContaining({ code: "VAULT_SCOPE_MISMATCH" }));
    }
  });
});
