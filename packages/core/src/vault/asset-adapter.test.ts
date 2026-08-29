import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../domain/types.js";
import {
  computeGovernanceProjectionHash,
  computePublicContentHash,
} from "../documents/canonical.js";
import {
  parseGovernedDocumentMarkdown,
  renderGovernedDocumentMarkdown,
} from "../documents/markdown-codec.js";
import type { GovernedDocumentMarkdownAdapterPort } from "../documents/repository.js";
import type {
  CanonicalPublicDocumentContent,
  GovernedDocumentAssetVersion,
} from "../documents/types.js";
import {
  GovernedMarkdownAdapterError,
  GovernedMarkdownVaultAdapter,
  type GovernedMarkdownAdapterPhaseEvent,
} from "./asset-adapter.js";
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

const scope: MemoryScope = {
  tenantId: "tenant-1",
  userId: "user-1",
  appId: "codex",
  projectId: "project-1",
  agentId: "root",
  namespace: "memories",
  visibility: "private",
};

function descriptor(rootPath: string): VaultScopeDescriptor {
  return {
    vaultId: "vault-1",
    owner: { tenantId: scope.tenantId, userId: scope.userId },
    allowedVisibilities: ["private"],
    allowedProjectIds: [scope.projectId],
    namespace: scope.namespace,
    rootPath,
    mode: "standalone",
    profile: "governed-vault",
  };
}

function completeAsset(
  overrides: Partial<GovernedDocumentAssetVersion> = {},
): GovernedDocumentAssetVersion {
  const assetId = overrides.assetId ?? "doc_vault_rules";
  const assetVersion = overrides.assetVersion ?? 3;
  const content: CanonicalPublicDocumentContent = overrides.content ?? {
    title: overrides.title ?? "Vault rules",
    abstract: "受治理的 Vault 规则。",
    sections: [{
      id: "sec_commit",
      heading: "Commit",
      claims: [{ id: "claim_head", text: "完成校验前不推进 head。" }],
    }],
    userNotes: "用户 Notes。\n",
    topics: ["vault"],
    relatedAssetIds: [],
    sourceAssetIds: ["source_design"],
    aliases: ["vault rules"],
    tags: ["mengshu/rules"],
  };
  const publicContentHash = computePublicContentHash(content);
  const governanceProjectionHash = computeGovernanceProjectionHash({
    assetId,
    assetVersion,
    claimEvidence: { claim_head: ["evidence_head"] },
    provenanceRefs: ["source_design"],
    relationRefs: [],
    sourceDispositionRefs: ["disposition_design"],
    resolutionHash: "a".repeat(64),
    policyVersion: "governed-document/v1",
  });
  const title = content.title;
  return {
    assetId,
    assetVersion,
    schemaVersion: 1,
    kind: "memory_document",
    purpose: "typed_memory",
    semanticType: "rules",
    title,
    lifecycleState: "active",
    governanceState: "current",
    scope,
    scopeFingerprint: authorityScopeFingerprint(scope),
    governanceDescription: {
      assetId,
      assetVersion,
      kind: "memory_document",
      purpose: "typed_memory",
      semanticType: "rules",
      scopeFingerprint: authorityScopeFingerprint(scope),
      lifecycleState: "active",
      governanceState: "current",
      complexityClass: "simple",
      title,
      abstract: content.abstract,
      sectionIndex: [{ sectionId: "sec_commit", heading: "Commit", brief: "提交规则" }],
      claimEvidenceCoverage: 1,
      sourceDispositionCoverage: 1,
      conflictCount: 0,
      staleReasons: [],
      publicContentHash,
      governanceProjectionHash,
      navigationRefs: ["source_design"],
    },
    content,
    publicContentHash,
    governanceProjectionHash,
    provenanceRefs: ["source_design"],
    evidenceRefs: ["evidence_head"],
    relations: [],
    createdAt: "2026-08-28T08:00:00.000Z",
    updatedAt: "2026-08-28T09:00:00.000Z",
    ...overrides,
  };
}

function completeTreeAsset(): GovernedDocumentAssetVersion {
  const base = completeAsset({ assetId: "doc_tree_rules" });
  const treeRef = {
    treeType: "topic" as const,
    level: "L2" as const,
    treeKey: "vault",
    nodeId: "tree_vault",
    sealVersion: 2,
  };
  return {
    ...base,
    kind: "tree_document",
    purpose: "tree_summary",
    semanticType: undefined,
    semanticTypes: ["rules"],
    treeRef,
    governanceDescription: {
      ...base.governanceDescription,
      kind: "tree_document",
      purpose: "tree_summary",
      semanticType: undefined,
      treeRef,
    },
  };
}

const canonicalPath = "Memory/Rules/project-1/vault-rules--fixture.md";

describe("GovernedMarkdownVaultAdapter", () => {
  test("直接实现 Write Kernel Markdown port，并保留 Vault scope 校验", async () => {
    const root = await temporaryDirectory("mengshu-asset-port-");
    const adapter: GovernedDocumentMarkdownAdapterPort = new GovernedMarkdownVaultAdapter({
      descriptor: descriptor(root),
    });
    const asset = completeAsset();
    const markdown = renderGovernedDocumentMarkdown(asset);
    const renderHash = (await import("node:crypto"))
      .createHash("sha256").update(markdown).digest("hex");

    await expect(adapter.commit({
      asset,
      vaultId: "vault-1",
      canonicalPath,
      assetId: asset.assetId,
      assetVersion: asset.assetVersion,
      requestHash: "d".repeat(64),
      renderHash,
      markdown,
    })).resolves.toEqual({ markdown });
    expect(await readFile(join(root, canonicalPath), "utf8")).toBe(markdown);

    await expect(adapter.commit({
      asset,
      vaultId: "other-vault",
      canonicalPath,
      assetId: asset.assetId,
      assetVersion: asset.assetVersion,
      requestHash: "d".repeat(64),
      renderHash,
      markdown,
    })).rejects.toMatchObject({ phase: "before_staging" });
  });

  test("通过同目录 staging -> fsync -> atomic rename -> parse-back 物化且重试幂等", async () => {
    const root = await temporaryDirectory("mengshu-asset-adapter-");
    const phases: GovernedMarkdownAdapterPhaseEvent[] = [];
    const adapter = new GovernedMarkdownVaultAdapter({
      descriptor: descriptor(root),
      onPhase: (event) => { phases.push(event); },
    });
    const asset = completeAsset();

    await expect(adapter.materializeComplete({ asset, relativePath: canonicalPath }))
      .resolves.toMatchObject({
        status: "created",
        assetId: asset.assetId,
        assetVersion: asset.assetVersion,
        relativePath: canonicalPath,
        publicContentHash: asset.publicContentHash,
      });
    expect(phases.map((event) => event.phase)).toEqual([
      "after_staging_fsync",
      "after_atomic_rename",
      "after_directory_fsync",
      "before_parse_back",
      "after_parse_back",
    ]);
    expect(dirname(phases[0]!.stagingPath!)).toBe(dirname(phases[0]!.targetPath));
    const markdown = await readFile(join(root, canonicalPath), "utf8");
    expect(parseGovernedDocumentMarkdown(markdown).identity)
      .toMatchObject({ assetId: asset.assetId, assetVersion: asset.assetVersion });
    expect((await readdir(dirname(join(root, canonicalPath))))
      .filter((name) => name.includes("mengshu-stage"))).toEqual([]);

    phases.length = 0;
    await expect(adapter.materializeComplete({ asset, relativePath: canonicalPath }))
      .resolves.toMatchObject({ status: "unchanged" });
    expect(phases).toEqual([]);
  });

  test("staging fsync 后故障不发布半成品，清理自有 staging 后可重试", async () => {
    const root = await temporaryDirectory("mengshu-asset-fsync-fault-");
    let fail = true;
    const adapter = new GovernedMarkdownVaultAdapter({
      descriptor: descriptor(root),
      onPhase: (event) => {
        if (fail && event.phase === "after_staging_fsync") {
          fail = false;
          throw new Error("injected after fsync");
        }
      },
    });

    await expect(adapter.materializeComplete({ asset: completeAsset(), relativePath: canonicalPath }))
      .rejects.toThrow("injected after fsync");
    await expect(readFile(join(root, canonicalPath), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(dirname(join(root, canonicalPath))))
      .filter((name) => name.includes("mengshu-stage"))).toEqual([]);
    await expect(adapter.materializeComplete({ asset: completeAsset(), relativePath: canonicalPath }))
      .resolves.toMatchObject({ status: "created" });
  });

  test("staging inode 在 fsync 后被替换时拒绝发布且不删除替换者字节", async () => {
    const root = await temporaryDirectory("mengshu-asset-stage-race-");
    let replacedPath: string | undefined;
    const adapter = new GovernedMarkdownVaultAdapter({
      descriptor: descriptor(root),
      onPhase: async (event) => {
        if (event.phase === "after_staging_fsync") {
          replacedPath = event.stagingPath!;
          await rm(event.stagingPath!);
          await writeFile(event.stagingPath!, "replacement bytes\n", "utf8");
        }
      },
    });

    await expect(adapter.materializeComplete({ asset: completeAsset(), relativePath: canonicalPath }))
      .rejects.toThrowError(expect.objectContaining({ code: "MARKDOWN_STAGING_REPLACED" }));
    expect(await readFile(replacedPath!, "utf8")).toBe("replacement bytes\n");
    await expect(readFile(join(root, canonicalPath), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  test("atomic rename 后故障保留完整文件，重试识别为 unchanged", async () => {
    const root = await temporaryDirectory("mengshu-asset-rename-fault-");
    let fail = true;
    const adapter = new GovernedMarkdownVaultAdapter({
      descriptor: descriptor(root),
      onPhase: (event) => {
        if (fail && event.phase === "after_atomic_rename") {
          fail = false;
          throw new Error("injected after rename");
        }
      },
    });
    const asset = completeAsset();

    await expect(adapter.materializeComplete({ asset, relativePath: canonicalPath }))
      .rejects.toThrow("injected after rename");
    expect(parseGovernedDocumentMarkdown(await readFile(join(root, canonicalPath), "utf8")).identity)
      .toMatchObject({ assetId: asset.assetId, assetVersion: asset.assetVersion });
    await expect(adapter.materializeComplete({ asset, relativePath: canonicalPath }))
      .resolves.toMatchObject({ status: "unchanged" });
  });

  test("parse-back 对 normalized semanticTypes 和 treeRef 执行完整身份校验", async () => {
    const root = await temporaryDirectory("mengshu-tree-asset-");
    const adapter = new GovernedMarkdownVaultAdapter({ descriptor: descriptor(root) });
    const asset = completeTreeAsset();
    const relativePath = "Trees/Topic/vault/tree-rules--fixture.md";

    await expect(adapter.materializeComplete({ asset, relativePath }))
      .resolves.toMatchObject({ status: "created", assetId: "doc_tree_rules" });
    expect(parseGovernedDocumentMarkdown(await readFile(join(root, relativePath), "utf8")).identity)
      .toMatchObject({ semanticTypes: ["rules"], treeRef: asset.treeRef });
  });

  test("parse-back identity/hash 漂移时 fail closed 且不推进任何业务状态", async () => {
    const root = await temporaryDirectory("mengshu-asset-parse-fault-");
    const adapter = new GovernedMarkdownVaultAdapter({
      descriptor: descriptor(root),
      onPhase: async (event) => {
        if (event.phase === "before_parse_back") {
          const bytes = await readFile(event.targetPath, "utf8");
          await writeFile(
            event.targetPath,
            bytes.replace("mengshu_version: 3", "mengshu_version: 4"),
            "utf8",
          );
        }
      },
    });

    await expect(adapter.materializeComplete({ asset: completeAsset(), relativePath: canonicalPath }))
      .rejects.toThrowError(expect.objectContaining({ code: "MARKDOWN_IDENTITY_MISMATCH" }));
    expect(await readFile(join(root, canonicalPath), "utf8")).toContain("mengshu_version: 4");
  });

  test("外部修改和目标路径被其他 asset 占用时只报告，不覆盖用户 bytes", async () => {
    const root = await temporaryDirectory("mengshu-asset-conflict-");
    const adapter = new GovernedMarkdownVaultAdapter({ descriptor: descriptor(root) });
    const target = join(root, canonicalPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "user-owned bytes\n", "utf8");

    await expect(adapter.materializeComplete({ asset: completeAsset(), relativePath: canonicalPath }))
      .resolves.toMatchObject({
        status: "external_modified",
        proposal: { assetId: "doc_vault_rules", reason: "invalid_markdown" },
      });
    expect(await readFile(target, "utf8")).toBe("user-owned bytes\n");

    const other = completeAsset({ assetId: "doc_other" });
    await writeFile(target, renderGovernedDocumentMarkdown(other), "utf8");
    await expect(adapter.materializeComplete({ asset: completeAsset(), relativePath: canonicalPath }))
      .resolves.toMatchObject({
        status: "conflict",
        conflict: { reason: "path_owned_by_other_asset", observedAssetId: "doc_other" },
      });
    expect(parseGovernedDocumentMarkdown(await readFile(target, "utf8")).identity.assetId)
      .toBe("doc_other");
  });

  test("缺失文件可重建；连续只读 reconcile 不改变文件且 changed=0", async () => {
    const root = await temporaryDirectory("mengshu-asset-reconcile-");
    const adapter = new GovernedMarkdownVaultAdapter({ descriptor: descriptor(root) });
    const entry = { asset: completeAsset(), relativePath: canonicalPath };

    await expect(adapter.reconcile({ entries: [entry], dryRun: true })).resolves.toMatchObject({
      dryRun: true,
      changed: 0,
      planned: 1,
      actions: [{ type: "rebuild_missing", assetId: "doc_vault_rules" }],
    });
    await expect(adapter.reconcile({ entries: [entry], dryRun: false }))
      .rejects.toThrowError(expect.objectContaining({ code: "MARKDOWN_READ_ONLY_RECONCILE_REQUIRED" }));

    await adapter.materializeComplete(entry);
    const bytes = await readFile(join(root, canonicalPath), "utf8");
    const first = await adapter.reconcile({ entries: [entry], dryRun: true });
    const second = await adapter.reconcile({ entries: [entry], dryRun: true });
    expect(first).toMatchObject({ changed: 0, planned: 0, actions: [] });
    expect(second).toEqual(first);
    expect(await readFile(join(root, canonicalPath), "utf8")).toBe(bytes);
  });

  test("rename 按 assetId 报 binding 更新，duplicate asset 报 conflict，均不移动文件", async () => {
    const root = await temporaryDirectory("mengshu-asset-move-");
    const adapter = new GovernedMarkdownVaultAdapter({ descriptor: descriptor(root) });
    const entry = { asset: completeAsset(), relativePath: canonicalPath };
    await adapter.materializeComplete(entry);
    const movedPath = "Memory/Rules/project-1/moved-by-user.md";
    await rename(join(root, canonicalPath), join(root, movedPath));

    await expect(adapter.reconcile({ entries: [entry], dryRun: true })).resolves.toMatchObject({
      changed: 0,
      planned: 1,
      actions: [{
        type: "update_binding_path",
        assetId: "doc_vault_rules",
        observedRelativePath: movedPath,
        canonicalRelativePath: canonicalPath,
      }],
    });
    await expect(readFile(join(root, movedPath), "utf8")).resolves.toContain("doc_vault_rules");

    const duplicatePath = "Memory/Rules/project-1/duplicate.md";
    await copyFile(join(root, movedPath), join(root, duplicatePath));
    await expect(adapter.reconcile({ entries: [entry], dryRun: true })).resolves.toMatchObject({
      changed: 0,
      planned: 1,
      actions: [{
        type: "conflict",
        conflict: { reason: "duplicate_asset" },
      }],
    });
    expect((await readdir(dirname(join(root, movedPath)))).sort()).toEqual([
      basename(duplicatePath), basename(movedPath),
    ].sort());
  });

  test("reconcile 区分 canonical 外部修改、路径占用与 moved 后篡改", async () => {
    const root = await temporaryDirectory("mengshu-reconcile-classify-");
    const adapter = new GovernedMarkdownVaultAdapter({ descriptor: descriptor(root) });
    const asset = completeAsset();
    const entry = { asset, relativePath: canonicalPath };
    await adapter.materializeComplete(entry);

    await writeFile(
      join(root, canonicalPath),
      renderGovernedDocumentMarkdown(asset).replace("mengshu_version: 3", "mengshu_version: 4"),
      "utf8",
    );
    await expect(adapter.reconcile({ entries: [entry], dryRun: true })).resolves.toMatchObject({
      actions: [{ type: "external_change_proposal", proposal: {
        reason: "identity_or_content_changed", observedAssetVersion: 4,
      } }],
    });

    await writeFile(join(root, canonicalPath), renderGovernedDocumentMarkdown(
      completeAsset({ assetId: "doc_other" }),
    ), "utf8");
    await expect(adapter.reconcile({ entries: [entry], dryRun: true })).resolves.toMatchObject({
      actions: [{ type: "conflict", conflict: { reason: "path_owned_by_other_asset" } }],
    });

    await writeFile(join(root, canonicalPath), renderGovernedDocumentMarkdown(asset), "utf8");
    const movedPath = "Memory/Rules/project-1/moved-and-edited.md";
    await rename(join(root, canonicalPath), join(root, movedPath));
    const edited = (await readFile(join(root, movedPath), "utf8"))
      .replace("完成校验前不推进 head。", "用户编辑后的内容。");
    await writeFile(join(root, movedPath), edited, "utf8");
    await expect(adapter.reconcile({ entries: [entry], dryRun: true })).resolves.toMatchObject({
      actions: [{ type: "external_change_proposal", proposal: {
        reason: "invalid_markdown", observedRelativePath: movedPath,
      } }],
    });
    expect(await readFile(join(root, movedPath), "utf8")).toBe(edited);
  });

  test("reconcile 对未创建根目录、非目录根和重复输入稳定 fail closed", async () => {
    const parent = await temporaryDirectory("mengshu-reconcile-input-");
    const missingRoot = join(parent, "missing-vault");
    const entry = { asset: completeAsset(), relativePath: canonicalPath };
    const missing = new GovernedMarkdownVaultAdapter({ descriptor: descriptor(missingRoot) });
    await expect(missing.reconcile({ entries: [entry], dryRun: true })).resolves.toMatchObject({
      scannedMarkdownFiles: 0,
      actions: [{ type: "rebuild_missing" }],
    });
    await expect(missing.reconcile({ entries: [entry, entry], dryRun: true }))
      .rejects.toThrowError(expect.objectContaining({ code: "MARKDOWN_RECONCILE_INPUT_INVALID" }));

    const fileRoot = join(parent, "file-vault");
    await writeFile(fileRoot, "not a directory", "utf8");
    const invalidRoot = new GovernedMarkdownVaultAdapter({ descriptor: descriptor(fileRoot) });
    await expect(invalidRoot.reconcile({ entries: [entry], dryRun: true }))
      .rejects.toThrowError(expect.objectContaining({ code: "MARKDOWN_RECONCILE_INPUT_INVALID" }));
  });

  test("containment 和符号链接路径 fail closed，不向 Vault 外写入", async () => {
    const parent = await temporaryDirectory("mengshu-asset-symlink-");
    const root = join(parent, "Mengshu");
    const outside = await temporaryDirectory("mengshu-asset-outside-");
    await mkdir(root);
    await symlink(outside, join(root, "Memory"));
    const adapter = new GovernedMarkdownVaultAdapter({ descriptor: descriptor(root) });

    await expect(adapter.materializeComplete({
      asset: completeAsset(), relativePath: "../outside.md",
    })).rejects.toThrow(/containment/i);
    await expect(adapter.materializeComplete({
      asset: completeAsset(), relativePath: canonicalPath,
    })).rejects.toThrow(/symlink/i);
    expect(await readdir(outside)).toEqual([]);
  });

  test("reconcile 不扫描 .obsidian 等非 managed 用户目录", async () => {
    const root = await temporaryDirectory("mengshu-asset-scan-boundary-");
    const adapter = new GovernedMarkdownVaultAdapter({ descriptor: descriptor(root) });
    const obsidian = join(root, ".obsidian");
    await mkdir(obsidian);
    await writeFile(join(obsidian, "user-note.md"), renderGovernedDocumentMarkdown(completeAsset()), "utf8");

    await expect(adapter.reconcile({
      entries: [{ asset: completeAsset(), relativePath: canonicalPath }],
      dryRun: true,
    })).resolves.toMatchObject({
      scannedMarkdownFiles: 0,
      actions: [{ type: "rebuild_missing" }],
    });
    await expect(readFile(join(obsidian, "user-note.md"), "utf8")).resolves.toContain("doc_vault_rules");
  });
});
