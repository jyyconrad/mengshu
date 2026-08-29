import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { VaultPolicyError } from "./scope.js";

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function validateSegment(segment: string): string {
  const normalized = segment.normalize("NFC");
  if (normalized === "." || normalized === "..") {
    throw new VaultPolicyError("VAULT_PATH_CONTAINMENT", "dot segments are forbidden");
  }
  if (normalized.length === 0 ||
      /\p{Cc}/u.test(normalized) || normalized.endsWith(" ") || normalized.endsWith(".") ||
      normalized.includes(":") || WINDOWS_RESERVED_NAME.test(normalized)) {
    throw new VaultPolicyError("VAULT_PATH_INVALID", `unsafe path segment: ${segment}`);
  }
  return normalized;
}

export function normalizeVaultRelativePath(relativePath: string): string {
  if (typeof relativePath !== "string" || relativePath.length === 0 || isAbsolute(relativePath)) {
    throw new VaultPolicyError("VAULT_PATH_INVALID", "Vault path must be relative");
  }
  if (relativePath.includes("\\")) {
    throw new VaultPolicyError("VAULT_PATH_INVALID", "portable Vault paths cannot use backslash separator");
  }
  const segments = relativePath.split("/").map(validateSegment);
  return segments.join("/");
}

export function resolveContainedVaultPath(rootPath: string, relativePath: string): string {
  if (!isAbsolute(rootPath)) {
    throw new VaultPolicyError("VAULT_ROOT_INVALID", "Vault root must be absolute");
  }
  const normalizedRelative = normalizeVaultRelativePath(relativePath);
  const root = resolve(rootPath.normalize("NFC"));
  const target = resolve(root, ...normalizedRelative.split("/"));
  const fromRoot = relative(root, target);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new VaultPolicyError("VAULT_PATH_CONTAINMENT");
  }
  return target;
}

async function existingPathIsSymlink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Reject any existing symlink at the Vault root or below it before managed I/O. */
export async function assertNoVaultSymlink(
  rootPath: string,
  relativePath?: string,
): Promise<void> {
  const root = resolve(rootPath);
  if (await existingPathIsSymlink(root)) {
    throw new VaultPolicyError("VAULT_PATH_SYMLINK", "Vault root is a symbolic link");
  }
  if (relativePath === undefined) return;
  const normalized = normalizeVaultRelativePath(relativePath);
  let current = root;
  for (const segment of normalized.split("/")) {
    current = resolve(current, segment);
    if (await existingPathIsSymlink(current)) {
      throw new VaultPolicyError("VAULT_PATH_SYMLINK", normalized);
    }
  }
}
