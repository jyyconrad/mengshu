import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, posix } from "node:path";

import { parseFrontMatter } from "../ingest/front-matter.js";
import { validateGovernedDocumentAssetVersion } from "../documents/canonical.js";
import {
  parseGovernedDocumentMarkdown,
  renderGovernedDocumentMarkdown,
} from "../documents/markdown-codec.js";
import {
  GovernedDocumentMarkdownCommitError,
  type CommitGovernedDocumentMarkdownInput,
  type GovernedDocumentMarkdownAdapterPort,
  type GovernedDocumentMarkdownCommitResult,
} from "../documents/repository.js";
import type {
  GovernedDocumentAssetVersion,
  ParsedGovernedDocumentMarkdown,
} from "../documents/types.js";
import {
  assertNoVaultSymlink,
  normalizeVaultRelativePath,
  resolveContainedVaultPath,
} from "./path-safety.js";
import {
  assertVaultAllowsScope,
  validateVaultScopeDescriptor,
  type VaultScopeDescriptor,
} from "./scope.js";

export type GovernedMarkdownAdapterErrorCode =
  | "MARKDOWN_IDENTITY_MISMATCH"
  | "MARKDOWN_PARSE_BACK_FAILED"
  | "MARKDOWN_STAGING_REPLACED"
  | "MARKDOWN_READ_ONLY_RECONCILE_REQUIRED"
  | "MARKDOWN_RECONCILE_INPUT_INVALID";

export class GovernedMarkdownAdapterError extends Error {
  constructor(readonly code: GovernedMarkdownAdapterErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "GovernedMarkdownAdapterError";
  }
}

export type GovernedMarkdownAdapterPhase =
  | "after_staging_fsync"
  | "after_atomic_rename"
  | "after_directory_fsync"
  | "before_parse_back"
  | "after_parse_back";

export interface GovernedMarkdownAdapterPhaseEvent {
  readonly phase: GovernedMarkdownAdapterPhase;
  readonly targetPath: string;
  readonly stagingPath?: string;
  readonly relativePath: string;
  readonly assetId: string;
  readonly assetVersion: number;
}

export interface MaterializeGovernedMarkdownInput {
  readonly asset: GovernedDocumentAssetVersion;
  readonly relativePath: string;
}

export interface VaultExternalChangeProposal {
  readonly kind: "external_change";
  readonly assetId: string;
  readonly expectedAssetVersion: number;
  readonly expectedPublicContentHash: string;
  readonly canonicalRelativePath: string;
  readonly observedRelativePath: string;
  readonly observedAssetId?: string;
  readonly observedAssetVersion?: number;
  readonly observedPublicContentHash?: string;
  readonly observedRenderHash: string;
  readonly reason: "invalid_markdown" | "identity_or_content_changed";
}

export interface VaultMarkdownConflict {
  readonly assetId: string;
  readonly canonicalRelativePath: string;
  readonly observedRelativePaths: readonly string[];
  readonly observedAssetId?: string;
  readonly reason: "path_owned_by_other_asset" | "duplicate_asset";
}

export type MaterializeGovernedMarkdownResult =
  | Readonly<{
      status: "created" | "unchanged";
      assetId: string;
      assetVersion: number;
      relativePath: string;
      publicContentHash: string;
      renderHash: string;
    }>
  | Readonly<{
      status: "external_modified";
      proposal: VaultExternalChangeProposal;
    }>
  | Readonly<{
      status: "conflict";
      conflict: VaultMarkdownConflict;
    }>;

export type VaultReconcileAction =
  | Readonly<{
      type: "rebuild_missing";
      assetId: string;
      assetVersion: number;
      canonicalRelativePath: string;
    }>
  | Readonly<{
      type: "update_binding_path";
      assetId: string;
      assetVersion: number;
      observedRelativePath: string;
      canonicalRelativePath: string;
    }>
  | Readonly<{
      type: "external_change_proposal";
      proposal: VaultExternalChangeProposal;
    }>
  | Readonly<{
      type: "conflict";
      conflict: VaultMarkdownConflict;
    }>;

export interface GovernedMarkdownReconcileReport {
  readonly dryRun: true;
  /** A dry-run is observably read-only; planned work is reported separately. */
  readonly changed: 0;
  readonly planned: number;
  readonly scannedMarkdownFiles: number;
  readonly actions: readonly VaultReconcileAction[];
}

interface ObservedMarkdownFile {
  readonly relativePath: string;
  readonly renderHash: string;
  readonly parsed?: ParsedGovernedDocumentMarkdown;
  readonly observedAssetId?: string;
  readonly observedAssetVersion?: number;
  readonly observedPublicContentHash?: string;
}

interface OwnedFileIdentity {
  readonly device: number;
  readonly inode: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function equalStringSet(left?: readonly string[], right?: readonly string[]): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function sameTreeRef(
  left: ParsedGovernedDocumentMarkdown["identity"]["treeRef"],
  right: GovernedDocumentAssetVersion["treeRef"],
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.treeType === right.treeType && left.level === right.level &&
    left.treeKey === right.treeKey && left.nodeId === right.nodeId &&
    left.sealVersion === right.sealVersion;
}

function identityMatches(
  parsed: ParsedGovernedDocumentMarkdown,
  asset: GovernedDocumentAssetVersion,
): boolean {
  const identity = parsed.identity;
  return identity.assetId === asset.assetId &&
    identity.assetVersion === asset.assetVersion &&
    identity.schemaVersion === asset.schemaVersion &&
    identity.kind === asset.kind &&
    identity.purpose === asset.purpose &&
    identity.semanticType === asset.semanticType &&
    equalStringSet(identity.semanticTypes, asset.semanticTypes) &&
    sameTreeRef(identity.treeRef, asset.treeRef) &&
    identity.lifecycleState === asset.lifecycleState &&
    identity.governanceState === asset.governanceState &&
    identity.scopeFingerprint === asset.scopeFingerprint &&
    identity.publicContentHash === asset.publicContentHash;
}

function declaredIdentity(markdown: string): {
  assetId?: string;
  assetVersion?: number;
  publicContentHash?: string;
} {
  try {
    const attributes = parseFrontMatter(markdown).attributes;
    return {
      ...(typeof attributes.mengshu_id === "string"
        ? { assetId: attributes.mengshu_id }
        : {}),
      ...(typeof attributes.mengshu_version === "number" &&
          Number.isSafeInteger(attributes.mengshu_version)
        ? { assetVersion: attributes.mengshu_version }
        : {}),
      ...(typeof attributes.mengshu_public_content_hash === "string"
        ? { publicContentHash: attributes.mengshu_public_content_hash }
        : {}),
    };
  } catch {
    return {};
  }
}

function freeze<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

async function pathKind(path: string): Promise<"missing" | "file" | "directory" | "other"> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return "other";
    if (stat.isFile()) return "file";
    if (stat.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

async function readOwnedFileIdentity(path: string): Promise<OwnedFileIdentity | undefined> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    return { device: stat.dev, inode: stat.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function sameOwnedFile(
  left: OwnedFileIdentity | undefined,
  right: OwnedFileIdentity | undefined,
): boolean {
  return left !== undefined && right !== undefined &&
    left.device === right.device && left.inode === right.inode;
}

async function safeUnlinkOwnStaging(
  path: string,
  identity: OwnedFileIdentity | undefined,
): Promise<void> {
  if (!sameOwnedFile(identity, await readOwnedFileIdentity(path))) return;
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export class GovernedMarkdownVaultAdapter implements GovernedDocumentMarkdownAdapterPort {
  readonly #descriptor: VaultScopeDescriptor;
  readonly #onPhase?: (
    event: GovernedMarkdownAdapterPhaseEvent,
  ) => void | Promise<void>;

  constructor(options: {
    readonly descriptor: VaultScopeDescriptor;
    readonly onPhase?: (
      event: GovernedMarkdownAdapterPhaseEvent,
    ) => void | Promise<void>;
  }) {
    this.#descriptor = validateVaultScopeDescriptor(options.descriptor);
    this.#onPhase = options.onPhase;
  }

  async commit(
    input: CommitGovernedDocumentMarkdownInput,
  ): Promise<GovernedDocumentMarkdownCommitResult> {
    let asset: GovernedDocumentAssetVersion;
    let relativePath: string;
    try {
      asset = validateGovernedDocumentAssetVersion(input.asset);
      relativePath = normalizeVaultRelativePath(input.canonicalPath);
      assertVaultAllowsScope(this.#descriptor, asset.scope);
      const rendered = renderGovernedDocumentMarkdown(asset);
      if (input.vaultId !== this.#descriptor.vaultId || input.assetId !== asset.assetId ||
          input.assetVersion !== asset.assetVersion || relativePath !== input.canonicalPath ||
          !/^[0-9a-f]{64}$/.test(input.requestHash) ||
          input.renderHash !== sha256(input.markdown) || input.markdown !== rendered) {
        throw new Error("write input does not match the governed asset");
      }
    } catch {
      throw new GovernedDocumentMarkdownCommitError("before_staging");
    }

    const result = await this.materializeComplete({ asset, relativePath });
    if (result.status === "external_modified" || result.status === "conflict") {
      throw new GovernedDocumentMarkdownCommitError("before_staging");
    }
    const target = resolveContainedVaultPath(this.#descriptor.rootPath, relativePath);
    return freeze({ markdown: await readFile(target, "utf8") });
  }

  async #phase(
    phase: GovernedMarkdownAdapterPhase,
    input: {
      readonly targetPath: string;
      readonly stagingPath?: string;
      readonly relativePath: string;
      readonly asset: GovernedDocumentAssetVersion;
    },
  ): Promise<void> {
    await this.#onPhase?.(freeze({
      phase,
      targetPath: input.targetPath,
      ...(input.stagingPath === undefined ? {} : { stagingPath: input.stagingPath }),
      relativePath: input.relativePath,
      assetId: input.asset.assetId,
      assetVersion: input.asset.assetVersion,
    }));
  }

  async #observeFile(relativePathInput: string): Promise<ObservedMarkdownFile | undefined> {
    const relativePath = normalizeVaultRelativePath(relativePathInput);
    await assertNoVaultSymlink(this.#descriptor.rootPath, relativePath);
    const target = resolveContainedVaultPath(this.#descriptor.rootPath, relativePath);
    const kind = await pathKind(target);
    if (kind === "missing") return undefined;
    if (kind !== "file") {
      throw new GovernedMarkdownAdapterError(
        "MARKDOWN_RECONCILE_INPUT_INVALID",
        `${relativePath} is not a regular file`,
      );
    }
    const markdown = await readFile(target, "utf8");
    const declared = declaredIdentity(markdown);
    let parsed: ParsedGovernedDocumentMarkdown | undefined;
    try {
      parsed = parseGovernedDocumentMarkdown(markdown);
    } catch {
      // Invalid external bytes remain observable through their public front matter only.
    }
    return freeze({
      relativePath,
      renderHash: sha256(markdown),
      ...(parsed === undefined ? {} : { parsed }),
      observedAssetId: parsed?.identity.assetId ?? declared.assetId,
      observedAssetVersion: parsed?.identity.assetVersion ?? declared.assetVersion,
      observedPublicContentHash:
        parsed?.identity.publicContentHash ?? declared.publicContentHash,
    });
  }

  #externalProposal(
    asset: GovernedDocumentAssetVersion,
    canonicalRelativePath: string,
    observed: ObservedMarkdownFile,
  ): VaultExternalChangeProposal {
    return freeze({
      kind: "external_change",
      assetId: asset.assetId,
      expectedAssetVersion: asset.assetVersion,
      expectedPublicContentHash: asset.publicContentHash,
      canonicalRelativePath,
      observedRelativePath: observed.relativePath,
      ...(observed.observedAssetId === undefined
        ? {}
        : { observedAssetId: observed.observedAssetId }),
      ...(observed.observedAssetVersion === undefined
        ? {}
        : { observedAssetVersion: observed.observedAssetVersion }),
      ...(observed.observedPublicContentHash === undefined
        ? {}
        : { observedPublicContentHash: observed.observedPublicContentHash }),
      observedRenderHash: observed.renderHash,
      reason: observed.parsed === undefined
        ? "invalid_markdown"
        : "identity_or_content_changed",
    });
  }

  #classifyExisting(
    asset: GovernedDocumentAssetVersion,
    canonicalRelativePath: string,
    observed: ObservedMarkdownFile,
  ): MaterializeGovernedMarkdownResult {
    if (observed.observedAssetId !== undefined && observed.observedAssetId !== asset.assetId) {
      return freeze({
        status: "conflict",
        conflict: freeze({
          assetId: asset.assetId,
          canonicalRelativePath,
          observedRelativePaths: Object.freeze([observed.relativePath]),
          observedAssetId: observed.observedAssetId,
          reason: "path_owned_by_other_asset" as const,
        }),
      });
    }
    if (observed.parsed && identityMatches(observed.parsed, asset)) {
      return freeze({
        status: "unchanged",
        assetId: asset.assetId,
        assetVersion: asset.assetVersion,
        relativePath: canonicalRelativePath,
        publicContentHash: asset.publicContentHash,
        renderHash: observed.renderHash,
      });
    }
    return freeze({
      status: "external_modified",
      proposal: this.#externalProposal(asset, canonicalRelativePath, observed),
    });
  }

  async materializeComplete(
    input: MaterializeGovernedMarkdownInput,
  ): Promise<MaterializeGovernedMarkdownResult> {
    const asset = validateGovernedDocumentAssetVersion(input.asset);
    assertVaultAllowsScope(this.#descriptor, asset.scope);
    const relativePath = normalizeVaultRelativePath(input.relativePath);
    const targetPath = resolveContainedVaultPath(this.#descriptor.rootPath, relativePath);
    const existing = await this.#observeFile(relativePath);
    if (existing) return this.#classifyExisting(asset, relativePath, existing);

    const parentRelativePath = posix.dirname(relativePath);
    if (parentRelativePath !== ".") {
      await assertNoVaultSymlink(this.#descriptor.rootPath, parentRelativePath);
      await mkdir(
        resolveContainedVaultPath(this.#descriptor.rootPath, parentRelativePath),
        { recursive: true },
      );
      await assertNoVaultSymlink(this.#descriptor.rootPath, parentRelativePath);
    } else {
      await mkdir(this.#descriptor.rootPath, { recursive: true });
      await assertNoVaultSymlink(this.#descriptor.rootPath);
    }

    const markdown = renderGovernedDocumentMarkdown(asset);
    const renderHash = sha256(markdown);
    const stagingName = `.${basename(relativePath)}.mengshu-stage-${process.pid}-${randomUUID()}`;
    const stagingRelativePath = parentRelativePath === "."
      ? stagingName
      : `${parentRelativePath}/${stagingName}`;
    const stagingPath = resolveContainedVaultPath(this.#descriptor.rootPath, stagingRelativePath);
    let published = false;
    let stagingIdentity: OwnedFileIdentity | undefined;
    try {
      const handle = await open(stagingPath, "wx", 0o600);
      try {
        const stat = await handle.stat();
        stagingIdentity = { device: stat.dev, inode: stat.ino };
        await handle.writeFile(markdown, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.#phase("after_staging_fsync", {
        targetPath, stagingPath, relativePath, asset,
      });

      // Re-check after fsync so an observed concurrent edit is never overwritten knowingly.
      const raced = await this.#observeFile(relativePath);
      if (raced) return this.#classifyExisting(asset, relativePath, raced);
      await assertNoVaultSymlink(this.#descriptor.rootPath, stagingRelativePath);
      if (!sameOwnedFile(stagingIdentity, await readOwnedFileIdentity(stagingPath))) {
        throw new GovernedMarkdownAdapterError("MARKDOWN_STAGING_REPLACED");
      }
      await rename(stagingPath, targetPath);
      published = true;
      await this.#phase("after_atomic_rename", {
        targetPath, stagingPath, relativePath, asset,
      });

      const directoryHandle = await open(dirname(targetPath), "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
      await this.#phase("after_directory_fsync", {
        targetPath, stagingPath, relativePath, asset,
      });
      await this.#phase("before_parse_back", {
        targetPath, stagingPath, relativePath, asset,
      });

      let parsed: ParsedGovernedDocumentMarkdown;
      try {
        parsed = parseGovernedDocumentMarkdown(await readFile(targetPath, "utf8"));
      } catch (error) {
        throw new GovernedMarkdownAdapterError(
          "MARKDOWN_PARSE_BACK_FAILED",
          error instanceof Error ? error.message : "Markdown parse-back failed",
        );
      }
      if (!identityMatches(parsed, asset)) {
        throw new GovernedMarkdownAdapterError("MARKDOWN_IDENTITY_MISMATCH");
      }
      await this.#phase("after_parse_back", {
        targetPath, stagingPath, relativePath, asset,
      });
      return freeze({
        status: "created",
        assetId: asset.assetId,
        assetVersion: asset.assetVersion,
        relativePath,
        publicContentHash: asset.publicContentHash,
        renderHash,
      });
    } finally {
      if (!published) await safeUnlinkOwnStaging(stagingPath, stagingIdentity);
    }
  }

  async #scanMarkdownFiles(): Promise<readonly ObservedMarkdownFile[]> {
    const rootKind = await pathKind(this.#descriptor.rootPath);
    if (rootKind === "missing") return Object.freeze([]);
    if (rootKind !== "directory") {
      throw new GovernedMarkdownAdapterError(
        "MARKDOWN_RECONCILE_INPUT_INVALID",
        "Vault root is not a directory",
      );
    }
    await assertNoVaultSymlink(this.#descriptor.rootPath);
    const observed: ObservedMarkdownFile[] = [];
    const walk = async (relativeDirectory?: string): Promise<void> => {
      if (relativeDirectory) {
        await assertNoVaultSymlink(this.#descriptor.rootPath, relativeDirectory);
      }
      const absoluteDirectory = relativeDirectory
        ? resolveContainedVaultPath(this.#descriptor.rootPath, relativeDirectory)
        : this.#descriptor.rootPath;
      const entries = await readdir(absoluteDirectory, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const relativePath = relativeDirectory
          ? `${relativeDirectory}/${entry.name}`
          : entry.name;
        if (relativeDirectory === undefined &&
            !["Home.md", "Memory", "Trees", "Indexes"].includes(entry.name)) {
          continue;
        }
        if (entry.isSymbolicLink()) {
          throw new Error(`VAULT_PATH_SYMLINK: ${relativePath}`);
        }
        if (entry.isDirectory()) {
          await walk(relativePath);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".md") ||
            entry.name.includes(".mengshu-stage-")) continue;
        const candidate = await this.#observeFile(relativePath);
        if (candidate) observed.push(candidate);
      }
    };
    await walk();
    return Object.freeze(observed);
  }

  async reconcile(input: {
    readonly entries: readonly MaterializeGovernedMarkdownInput[];
    readonly dryRun: boolean;
  }): Promise<GovernedMarkdownReconcileReport> {
    if (input.dryRun !== true) {
      throw new GovernedMarkdownAdapterError("MARKDOWN_READ_ONLY_RECONCILE_REQUIRED");
    }
    if (!Array.isArray(input.entries)) {
      throw new GovernedMarkdownAdapterError("MARKDOWN_RECONCILE_INPUT_INVALID");
    }
    const expected = input.entries.map((entry) => {
      const asset = validateGovernedDocumentAssetVersion(entry.asset);
      assertVaultAllowsScope(this.#descriptor, asset.scope);
      return freeze({
        asset,
        relativePath: normalizeVaultRelativePath(entry.relativePath),
      });
    });
    if (new Set(expected.map((entry) => entry.asset.assetId)).size !== expected.length ||
        new Set(expected.map((entry) => entry.relativePath)).size !== expected.length) {
      throw new GovernedMarkdownAdapterError(
        "MARKDOWN_RECONCILE_INPUT_INVALID",
        "expected assets and canonical paths must be unique",
      );
    }

    const observed = await this.#scanMarkdownFiles();
    const byPath = new Map(observed.map((item) => [item.relativePath, item] as const));
    const byAssetId = new Map<string, ObservedMarkdownFile[]>();
    for (const item of observed) {
      if (item.observedAssetId === undefined) continue;
      const matches = byAssetId.get(item.observedAssetId) ?? [];
      matches.push(item);
      byAssetId.set(item.observedAssetId, matches);
    }

    const actions: VaultReconcileAction[] = [];
    for (const entry of expected.sort((left, right) =>
      left.asset.assetId.localeCompare(right.asset.assetId))) {
      const matches = byAssetId.get(entry.asset.assetId) ?? [];
      if (matches.length > 1) {
        actions.push(freeze({
          type: "conflict",
          conflict: freeze({
            assetId: entry.asset.assetId,
            canonicalRelativePath: entry.relativePath,
            observedRelativePaths: Object.freeze(matches.map((item) => item.relativePath).sort()),
            reason: "duplicate_asset" as const,
          }),
        }));
        continue;
      }

      const canonical = byPath.get(entry.relativePath);
      if (canonical) {
        const classification = this.#classifyExisting(
          entry.asset,
          entry.relativePath,
          canonical,
        );
        if (classification.status === "external_modified") {
          actions.push(freeze({
            type: "external_change_proposal",
            proposal: classification.proposal,
          }));
        } else if (classification.status === "conflict") {
          actions.push(freeze({ type: "conflict", conflict: classification.conflict }));
        }
        continue;
      }

      const moved = matches[0];
      if (!moved) {
        actions.push(freeze({
          type: "rebuild_missing",
          assetId: entry.asset.assetId,
          assetVersion: entry.asset.assetVersion,
          canonicalRelativePath: entry.relativePath,
        }));
      } else if (moved.parsed && identityMatches(moved.parsed, entry.asset)) {
        actions.push(freeze({
          type: "update_binding_path",
          assetId: entry.asset.assetId,
          assetVersion: entry.asset.assetVersion,
          observedRelativePath: moved.relativePath,
          canonicalRelativePath: entry.relativePath,
        }));
      } else {
        actions.push(freeze({
          type: "external_change_proposal",
          proposal: this.#externalProposal(entry.asset, entry.relativePath, moved),
        }));
      }
    }
    return freeze({
      dryRun: true,
      changed: 0,
      planned: actions.length,
      scannedMarkdownFiles: observed.length,
      actions: Object.freeze(actions),
    });
  }
}
