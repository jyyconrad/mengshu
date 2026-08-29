import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  assertNoVaultSymlink,
  resolveContainedVaultPath,
} from "./path-safety.js";
import {
  VaultPolicyError,
  validateVaultScopeDescriptor,
  type VaultScopeDescriptor,
} from "./scope.js";

export const VAULT_MANAGED_DIRECTORIES = Object.freeze([
  "Memory",
  "Memory/Profile",
  "Memory/Profile/Global",
  "Memory/Profile/App",
  "Memory/Profile/Project",
  "Memory/Task Context",
  "Memory/Rules",
  "Memory/Experience",
  "Memory/Resource",
  "Trees",
  "Trees/Source",
  "Trees/Topic",
  "Trees/Global",
  "Indexes",
  "Indexes/Projects",
  "Indexes/Topics",
  "Indexes/Sources",
  "Indexes/Documents",
  "Views",
  "Inbox",
  ".mengshu",
  ".mengshu/conflicts",
] as const);

const HOME = `# Mengshu

## 5 Type Memory

- [[Memory/_index|Memory index]]
- [[Memory/_index#Profile|Profile]]
- [[Memory/_index#Task Context|Task Context]]
- [[Memory/_index#Rules|Rules]]
- [[Memory/_index#Experience|Experience]]
- [[Memory/_index#Resource|Resource]]

## Memory Trees

- [[Trees/_index|Tree index]]
- [[Trees/_index#Source|Source tree]]
- [[Trees/_index#Topic|Topic tree]]
- [[Trees/_index#Global|Global tree]]

## Indexes

- [[Indexes/Projects/_index|Projects]]
- [[Indexes/Topics/_index|Topics]]
- [[Indexes/Sources/_index|Sources]]
- [[Indexes/Documents/_index|Complex document indexes]]

## Review

![[Views/Review.base]]
`;

const MEMORY_INDEX = `# Memory

## Profile

## Task Context

## Rules

## Experience

## Resource
`;

const TREE_INDEX = `# Memory Trees

## Source

## Topic

## Global
`;

const INDEX_ROOT = `# Indexes

- [[Indexes/Projects/_index|Projects]]
- [[Indexes/Topics/_index|Topics]]
- [[Indexes/Sources/_index|Sources]]
- [[Indexes/Documents/_index|Complex document indexes]]
`;

function baseTemplate(input: {
  folder: string;
  name: string;
  kind: "memory_document" | "tree_document" | "index_document";
  semanticType?: string;
}): string {
  const filters = [
    `    - 'file.inFolder("${input.folder}")'`,
    `    - 'mengshu_kind == "${input.kind}"'`,
    ...(input.semanticType
      ? [`    - 'mengshu_semantic_type == "${input.semanticType}"'`] : []),
  ];
  return `filters:
  and:
${filters.join("\n")}
properties:
  mengshu_semantic_type:
    displayName: Type
  mengshu_state:
    displayName: State
  mengshu_governance:
    displayName: Governance
  mengshu_scope:
    displayName: Scope
  mengshu_updated:
    displayName: Updated
views:
  - type: table
    name: ${input.name}
    order:
      - file.name
      - mengshu_semantic_type
      - mengshu_scope
      - mengshu_updated
`;
}

const REVIEW_BASE = `filters:
  and:
    - 'mengshu_governance != "current"'
properties:
  mengshu_semantic_type:
    displayName: Type
  mengshu_state:
    displayName: State
  mengshu_governance:
    displayName: Governance
  mengshu_scope:
    displayName: Scope
  mengshu_updated:
    displayName: Updated
views:
  - type: table
    name: Review
    order:
      - file.name
      - mengshu_kind
      - mengshu_semantic_type
      - mengshu_scope
      - mengshu_updated
`;

const STATIC_MANAGED_FILES: Readonly<Record<string, string>> = Object.freeze({
  "Home.md": HOME,
  "Memory/_index.md": MEMORY_INDEX,
  "Trees/_index.md": TREE_INDEX,
  "Indexes/_index.md": INDEX_ROOT,
  "Indexes/Projects/_index.md": "# Projects\n",
  "Indexes/Topics/_index.md": "# Topics\n",
  "Indexes/Sources/_index.md": "# Sources\n",
  "Indexes/Documents/_index.md": "# Complex Document Indexes\n",
  "Views/Profile.base": baseTemplate({ folder: "Memory/Profile", name: "Profile", kind: "memory_document", semanticType: "profile" }),
  "Views/TaskContext.base": baseTemplate({ folder: "Memory/Task Context", name: "Task context", kind: "memory_document", semanticType: "task_context" }),
  "Views/Rules.base": baseTemplate({ folder: "Memory/Rules", name: "Rules", kind: "memory_document", semanticType: "rules" }),
  "Views/Experience.base": baseTemplate({ folder: "Memory/Experience", name: "Experience", kind: "memory_document", semanticType: "experience" }),
  "Views/Resource.base": baseTemplate({ folder: "Memory/Resource", name: "Resource", kind: "memory_document", semanticType: "resource" }),
  "Views/Trees.base": baseTemplate({ folder: "Trees", name: "Trees", kind: "tree_document" }),
  "Views/Projects.base": baseTemplate({ folder: "Indexes/Projects", name: "Projects", kind: "index_document" }),
  "Views/Topics.base": baseTemplate({ folder: "Indexes/Topics", name: "Topics", kind: "index_document" }),
  "Views/Sources.base": baseTemplate({ folder: "Indexes/Sources", name: "Sources", kind: "index_document" }),
  "Views/Review.base": REVIEW_BASE,
});

export const VAULT_MANAGED_FILES = Object.freeze([
  ...Object.keys(STATIC_MANAGED_FILES),
  ".mengshu/vault.json",
]);

export interface InitializeVaultResult {
  readonly descriptor: VaultScopeDescriptor;
  readonly created: readonly string[];
  readonly unchanged: readonly string[];
}

async function ensureManagedDirectory(rootPath: string, relativePath: string): Promise<void> {
  await assertNoVaultSymlink(rootPath, relativePath);
  const target = resolveContainedVaultPath(rootPath, relativePath);
  await mkdir(target, { recursive: true });
  const stat = await lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new VaultPolicyError("VAULT_PATH_SYMLINK", relativePath);
  }
}

async function writeManagedFile(
  rootPath: string,
  relativePath: string,
  content: string,
): Promise<"created" | "unchanged"> {
  await assertNoVaultSymlink(rootPath, relativePath);
  const target = resolveContainedVaultPath(rootPath, relativePath);
  try {
    await writeFile(target, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return "created";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || await readFile(target, "utf8") !== content) {
    throw new VaultPolicyError("VAULT_MANAGED_FILE_CONFLICT", relativePath);
  }
  return "unchanged";
}

function vaultManifest(descriptor: VaultScopeDescriptor): string {
  return `${JSON.stringify({
    schemaVersion: "governed-vault/v1",
    vaultId: descriptor.vaultId,
    owner: descriptor.owner,
    ...(descriptor.workspaceId === undefined ? {} : { workspaceId: descriptor.workspaceId }),
    allowedVisibilities: descriptor.allowedVisibilities,
    ...(descriptor.allowedProjectIds === undefined
      ? {}
      : { allowedProjectIds: descriptor.allowedProjectIds }),
    namespace: descriptor.namespace,
    rootPath: descriptor.rootPath,
    mode: descriptor.mode,
    profile: descriptor.profile,
  }, null, 2)}\n`;
}

export async function initializeReadOnlyVault(
  descriptorInput: VaultScopeDescriptor,
): Promise<InitializeVaultResult> {
  const descriptor = validateVaultScopeDescriptor(descriptorInput);
  await assertNoVaultSymlink(descriptor.rootPath);
  await mkdir(descriptor.rootPath, { recursive: true });
  await assertNoVaultSymlink(descriptor.rootPath);

  for (const relativePath of VAULT_MANAGED_DIRECTORIES) {
    await ensureManagedDirectory(descriptor.rootPath, relativePath);
  }

  const files: Readonly<Record<string, string>> = {
    ...STATIC_MANAGED_FILES,
    ".mengshu/vault.json": vaultManifest(descriptor),
  };
  const created: string[] = [];
  const unchanged: string[] = [];
  for (const relativePath of VAULT_MANAGED_FILES) {
    const parent = dirname(relativePath);
    if (parent !== "." && !VAULT_MANAGED_DIRECTORIES.includes(
      parent as (typeof VAULT_MANAGED_DIRECTORIES)[number],
    )) {
      throw new VaultPolicyError("VAULT_PATH_CONTAINMENT", relativePath);
    }
    const outcome = await writeManagedFile(descriptor.rootPath, relativePath, files[relativePath]!);
    (outcome === "created" ? created : unchanged).push(relativePath);
  }
  return Object.freeze({
    descriptor,
    created: Object.freeze(created),
    unchanged: Object.freeze(unchanged),
  });
}
