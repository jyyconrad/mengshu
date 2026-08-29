import { createHash } from "node:crypto";

import type { MemorySemanticType, ProfileLayer } from "../domain/types.js";
import { normalizeVaultRelativePath } from "./path-safety.js";
import { VaultPolicyError } from "./scope.js";

export interface VaultTreeRef {
  readonly treeType: "source" | "topic" | "global";
  readonly level: "L1" | "L2" | "L3";
  readonly treeKey: string;
  readonly nodeId: string;
  readonly sealVersion: number;
}

export type VaultIndexPurpose =
  | "home"
  | "type_index"
  | "tree_index"
  | "project_index"
  | "topic_index"
  | "source_index"
  | "document_index"
  | "governance_catalog";

export interface VaultPlacementInput {
  readonly kind: "memory_document" | "tree_document" | "index_document";
  readonly assetId: string;
  readonly title: string;
  readonly semanticType?: MemorySemanticType;
  readonly profileLayer?: ProfileLayer;
  readonly appId?: string;
  readonly projectId?: string;
  readonly primaryProject?: string;
  readonly ruleDomain?: string;
  readonly primaryTopic?: string;
  readonly primarySourceOrProject?: string;
  readonly treeRef?: VaultTreeRef;
  readonly purpose?: VaultIndexPurpose;
  readonly indexKey?: string;
}

const SAFE_ASSET_ID = /^[^\p{White_Space}\p{Cc}\\/]{1,512}$/u;
const TREE_LEVEL: Readonly<Record<VaultTreeRef["treeType"], VaultTreeRef["level"]>> = {
  source: "L1",
  topic: "L2",
  global: "L3",
};
const TREE_DIRECTORY: Readonly<Record<VaultTreeRef["treeType"], string>> = {
  source: "Source",
  topic: "Topic",
  global: "Global",
};
const INDEX_DIRECTORY: Partial<Record<VaultIndexPurpose, string>> = {
  project_index: "Projects",
  topic_index: "Topics",
  source_index: "Sources",
  document_index: "Documents",
};

function requiredText(value: unknown, label: string, pathKey = false): string {
  if (typeof value !== "string" || value.trim().length === 0 ||
      value !== value.normalize("NFC") || /\p{Cc}/u.test(value) ||
      pathKey && (value.includes("/") || value.includes("\\") ||
        value.trim() === "." || value.trim() === "..")) {
    throw new VaultPolicyError("VAULT_PATH_INVALID", `${label} is not a safe path label`);
  }
  return value.trim();
}

function slug(value: unknown, label: string, pathKey = false): string {
  const text = requiredText(value, label, pathKey).toLocaleLowerCase("en-US");
  const pieces = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (pieces.length === 0) {
    throw new VaultPolicyError("VAULT_PATH_INVALID", `${label} has no usable path characters`);
  }
  return pieces.join("-");
}

function assetId(value: unknown): string {
  if (typeof value !== "string" || value !== value.normalize("NFC") || !SAFE_ASSET_ID.test(value)) {
    throw new VaultPolicyError("VAULT_PATH_INVALID", "assetId is invalid");
  }
  return value;
}

export function vaultAssetShortId(value: string): string {
  return createHash("sha256").update(assetId(value), "utf8").digest("hex").slice(0, 12);
}

function contentFilename(input: VaultPlacementInput, fixedName?: string): string {
  const name = fixedName ?? slug(input.title, "title");
  return `${name}--${vaultAssetShortId(input.assetId)}.md`;
}

function resolveMemoryPlacement(input: VaultPlacementInput): string {
  switch (input.semanticType) {
    case "profile": {
      if (input.profileLayer === "global") {
        return `Memory/Profile/Global/${contentFilename(input, "profile")}`;
      }
      if (input.profileLayer === "app") {
        return `Memory/Profile/App/${slug(input.appId, "appId", true)}/${contentFilename(input, "profile")}`;
      }
      if (input.profileLayer === "project") {
        return `Memory/Profile/Project/${slug(input.projectId, "projectId", true)}/${contentFilename(input, "profile")}`;
      }
      throw new VaultPolicyError("VAULT_PATH_INVALID", "profileLayer is required for profile");
    }
    case "task_context":
      return `Memory/Task Context/${slug(input.primaryProject, "primaryProject", true)}/${contentFilename(input)}`;
    case "rules":
      return `Memory/Rules/${slug(input.ruleDomain, "ruleDomain", true)}/${contentFilename(input)}`;
    case "experience":
      return `Memory/Experience/${slug(input.primaryTopic, "primaryTopic", true)}/${contentFilename(input)}`;
    case "resource":
      return `Memory/Resource/${slug(input.primarySourceOrProject, "primarySourceOrProject", true)}/${contentFilename(input)}`;
    default:
      throw new VaultPolicyError("VAULT_PATH_INVALID", "memory_document requires one 5 Type");
  }
}

function resolveTreePlacement(input: VaultPlacementInput): string {
  const tree = input.treeRef;
  if (!tree || TREE_LEVEL[tree.treeType] !== tree.level ||
      !Number.isSafeInteger(tree.sealVersion) || tree.sealVersion < 1) {
    throw new VaultPolicyError("VAULT_PATH_INVALID", "tree type and level are inconsistent");
  }
  requiredText(tree.nodeId, "tree.nodeId", true);
  return `Trees/${TREE_DIRECTORY[tree.treeType]}/${slug(tree.treeKey, "tree.treeKey", true)}/${contentFilename(input)}`;
}

function resolveIndexPlacement(input: VaultPlacementInput): string {
  switch (input.purpose) {
    case "home": return "Home.md";
    case "type_index": return "Memory/_index.md";
    case "tree_index": return "Trees/_index.md";
    case "governance_catalog": return "Indexes/_index.md";
    case "project_index":
    case "topic_index":
    case "source_index":
    case "document_index": {
      const key = slug(input.indexKey, "indexKey", true);
      return `Indexes/${INDEX_DIRECTORY[input.purpose]}/${key}--${vaultAssetShortId(input.assetId)}.md`;
    }
    default:
      throw new VaultPolicyError("VAULT_PATH_INVALID", "index_document requires a supported purpose");
  }
}

export function resolveCanonicalVaultPlacement(input: VaultPlacementInput): string {
  if (!input || typeof input !== "object") {
    throw new VaultPolicyError("VAULT_PATH_INVALID", "placement input is invalid");
  }
  assetId(input.assetId);
  requiredText(input.title, "title");
  const placement = input.kind === "memory_document"
    ? resolveMemoryPlacement(input)
    : input.kind === "tree_document"
      ? resolveTreePlacement(input)
      : input.kind === "index_document"
        ? resolveIndexPlacement(input)
        : (() => { throw new VaultPolicyError("VAULT_PATH_INVALID", "unsupported document kind"); })();
  return normalizeVaultRelativePath(placement);
}
