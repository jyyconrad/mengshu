import { describe, expect, test } from "vitest";

import {
  resolveCanonicalVaultPlacement,
  validateVaultScopeDescriptor,
  vaultAssetShortId,
} from "./index.js";

describe("governed document vault placement", () => {
  test("按 5 Type 与 treeRef 生成稳定 canonical path", () => {
    expect(resolveCanonicalVaultPlacement({
      assetId: "doc_01JY7M4R",
      kind: "memory_document",
      semanticType: "rules",
      title: "Memory Storage Rules",
      ruleDomain: "project-memory-autodb",
    })).toBe(`Memory/Rules/project-memory-autodb/memory-storage-rules--${
      vaultAssetShortId("doc_01JY7M4R")
    }.md`);
    expect(resolveCanonicalVaultPlacement({
      assetId: "tree_01JY7M4R",
      kind: "tree_document",
      title: "Memory Storage",
      treeRef: {
        treeType: "topic",
        level: "L2",
        treeKey: "memory-storage",
        nodeId: "tree_node_1",
        sealVersion: 8,
      },
    })).toBe(`Trees/Topic/memory-storage/memory-storage--${
      vaultAssetShortId("tree_01JY7M4R")
    }.md`);
  });

  test("拒绝路径穿越、非 private authority 和 attached root 越界", () => {
    expect(() => resolveCanonicalVaultPlacement({
      assetId: "doc_01JY7M4R",
      kind: "memory_document",
      semanticType: "resource",
      title: "Secrets",
      primarySourceOrProject: "../../outside",
    })).toThrow(/path|segment|primaryKey/i);
    expect(() => validateVaultScopeDescriptor({
      vaultId: "vault_1",
      owner: { tenantId: "local", userId: "u1" },
      allowedVisibilities: ["workspace"],
      namespace: "memories",
      rootPath: "/tmp/Mengshu",
      mode: "standalone",
      profile: "governed-vault",
    })).toThrow(/private|visibility/i);
  });
});
