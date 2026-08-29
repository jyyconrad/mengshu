import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  resolveCanonicalVaultPlacement,
  vaultAssetShortId,
} from "./placement.js";
import { resolveContainedVaultPath } from "./path-safety.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("canonical Vault placement", () => {
  test("按 5 Type 和 profileLayer 生成唯一 memory document 路径", () => {
    const suffix = vaultAssetShortId("asset-rules-1");

    expect(resolveCanonicalVaultPlacement({
      kind: "memory_document",
      assetId: "asset-rules-1",
      title: "Build Rules",
      semanticType: "rules",
      ruleDomain: "Project Runtime",
    })).toBe(`Memory/Rules/project-runtime/build-rules--${suffix}.md`);
    expect(resolveCanonicalVaultPlacement({
      kind: "memory_document",
      assetId: "asset-profile-1",
      title: "Ignored for profile filename",
      semanticType: "profile",
      profileLayer: "project",
      projectId: "Memory AutoDB",
    })).toBe(
      `Memory/Profile/Project/memory-autodb/profile--${vaultAssetShortId("asset-profile-1")}.md`,
    );
    expect(resolveCanonicalVaultPlacement({
      kind: "memory_document",
      assetId: "asset-task-1",
      title: "Current Plan",
      semanticType: "task_context",
      primaryProject: "Memory AutoDB",
    })).toBe(
      `Memory/Task Context/memory-autodb/current-plan--${vaultAssetShortId("asset-task-1")}.md`,
    );
    expect(resolveCanonicalVaultPlacement({
      kind: "memory_document",
      assetId: "asset-profile-global",
      title: "Global Profile",
      semanticType: "profile",
      profileLayer: "global",
    })).toBe(
      `Memory/Profile/Global/profile--${vaultAssetShortId("asset-profile-global")}.md`,
    );
    expect(resolveCanonicalVaultPlacement({
      kind: "memory_document",
      assetId: "asset-profile-app",
      title: "App Profile",
      semanticType: "profile",
      profileLayer: "app",
      appId: "OpenClaw",
    })).toBe(
      `Memory/Profile/App/openclaw/profile--${vaultAssetShortId("asset-profile-app")}.md`,
    );
    expect(resolveCanonicalVaultPlacement({
      kind: "memory_document",
      assetId: "asset-experience",
      title: "Migration Lessons",
      semanticType: "experience",
      primaryTopic: "History Migration",
    })).toBe(
      `Memory/Experience/history-migration/migration-lessons--${vaultAssetShortId("asset-experience")}.md`,
    );
    expect(resolveCanonicalVaultPlacement({
      kind: "memory_document",
      assetId: "asset-resource",
      title: "API Reference",
      semanticType: "resource",
      primarySourceOrProject: "Mengshu Docs",
    })).toBe(
      `Memory/Resource/mengshu-docs/api-reference--${vaultAssetShortId("asset-resource")}.md`,
    );
  });

  test("按 tree type/level/key 生成 sealed tree document 路径", () => {
    expect(resolveCanonicalVaultPlacement({
      kind: "tree_document",
      assetId: "asset-topic-tree-1",
      title: "Memory Storage Summary",
      treeRef: {
        treeType: "topic",
        level: "L2",
        treeKey: "Memory Storage",
        nodeId: "tree-topic-1",
        sealVersion: 3,
      },
    })).toBe(
      `Trees/Topic/memory-storage/memory-storage-summary--${vaultAssetShortId("asset-topic-tree-1")}.md`,
    );
    expect(resolveCanonicalVaultPlacement({
      kind: "tree_document",
      assetId: "asset-source-tree-1",
      title: "Source Summary",
      treeRef: {
        treeType: "source", level: "L1", treeKey: "Repository A",
        nodeId: "tree-source-1", sealVersion: 1,
      },
    })).toBe(
      `Trees/Source/repository-a/source-summary--${vaultAssetShortId("asset-source-tree-1")}.md`,
    );
    expect(resolveCanonicalVaultPlacement({
      kind: "tree_document",
      assetId: "asset-global-tree-1",
      title: "Global Digest",
      treeRef: {
        treeType: "global", level: "L3", treeKey: "Private User",
        nodeId: "tree-global-1", sealVersion: 2,
      },
    })).toBe(
      `Trees/Global/private-user/global-digest--${vaultAssetShortId("asset-global-tree-1")}.md`,
    );

    expect(() => resolveCanonicalVaultPlacement({
      kind: "tree_document",
      assetId: "asset-bad-tree",
      title: "Bad",
      treeRef: {
        treeType: "source",
        level: "L2",
        treeKey: "source-a",
        nodeId: "tree-bad",
        sealVersion: 1,
      },
    })).toThrow(/tree type.*level/i);
  });

  test("生成 Home、共享索引和 project/topic/source/document index 路径", () => {
    expect(resolveCanonicalVaultPlacement({
      kind: "index_document", assetId: "home", title: "Mengshu", purpose: "home",
    })).toBe("Home.md");
    expect(resolveCanonicalVaultPlacement({
      kind: "index_document", assetId: "memory-index", title: "Memory", purpose: "type_index",
    })).toBe("Memory/_index.md");
    expect(resolveCanonicalVaultPlacement({
      kind: "index_document",
      assetId: "project-index-1",
      title: "Memory AutoDB",
      purpose: "project_index",
      indexKey: "Memory AutoDB",
    })).toBe(
      `Indexes/Projects/memory-autodb--${vaultAssetShortId("project-index-1")}.md`,
    );
    expect(resolveCanonicalVaultPlacement({
      kind: "index_document",
      assetId: "document-index-1",
      title: "Vault Upgrade",
      purpose: "document_index",
      indexKey: "Vault Upgrade",
    })).toBe(
      `Indexes/Documents/vault-upgrade--${vaultAssetShortId("document-index-1")}.md`,
    );
  });

  test("拒绝 path-like placement label，并阻止绝对路径和父目录逃逸", async () => {
    expect(() => resolveCanonicalVaultPlacement({
      kind: "memory_document",
      assetId: "asset-escape",
      title: "Escape",
      semanticType: "experience",
      primaryTopic: "../outside",
    })).toThrow(/path/i);

    const root = await mkdtemp(join(tmpdir(), "mengshu-vault-path-"));
    temporaryRoots.push(root);
    expect(resolveContainedVaultPath(root, "Memory/Rules/a.md"))
      .toBe(join(root, "Memory", "Rules", "a.md"));
    expect(() => resolveContainedVaultPath(root, "../outside.md")).toThrow(/containment/i);
    expect(() => resolveContainedVaultPath(root, join(root, "outside.md"))).toThrow(/relative/i);
    expect(() => resolveContainedVaultPath(root, "Memory\\..\\outside.md")).toThrow(/separator/i);
    expect(() => resolveContainedVaultPath(root, "Memory/CON.md")).toThrow(/unsafe path/i);
    expect(resolveContainedVaultPath(root, "Memory/Cafe\u0301.md"))
      .toBe(join(root, "Memory", "Caf\u00e9.md"));
  });
});
