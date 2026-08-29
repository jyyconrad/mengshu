import { isAbsolute, parse, resolve } from "node:path";

export type VaultVisibility = "private" | "workspace" | "team" | "public";

export interface VaultScopeDescriptor {
  readonly vaultId: string;
  readonly owner: {
    readonly tenantId: string;
    readonly userId: string;
  };
  readonly workspaceId?: string;
  readonly allowedVisibilities: readonly VaultVisibility[];
  readonly allowedProjectIds?: readonly string[];
  readonly namespace: string;
  readonly rootPath: string;
  readonly mode: "standalone" | "attached";
  readonly profile: "governed-vault";
}

export interface VaultDocumentScope {
  readonly tenantId: string;
  readonly userId: string;
  readonly namespace: string;
  readonly projectId?: string;
  readonly workspaceId?: string;
  readonly visibility?: VaultVisibility;
}

export type VaultPolicyErrorCode =
  | "VAULT_DESCRIPTOR_INVALID"
  | "VAULT_VISIBILITY_UNSUPPORTED"
  | "VAULT_ROOT_INVALID"
  | "VAULT_SCOPE_MISMATCH"
  | "VAULT_PATH_INVALID"
  | "VAULT_PATH_CONTAINMENT"
  | "VAULT_PATH_SYMLINK"
  | "VAULT_MANAGED_FILE_CONFLICT";

export class VaultPolicyError extends Error {
  constructor(readonly code: VaultPolicyErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "VaultPolicyError";
  }
}

const DESCRIPTOR_KEYS = new Set([
  "vaultId",
  "owner",
  "workspaceId",
  "allowedVisibilities",
  "allowedProjectIds",
  "namespace",
  "rootPath",
  "mode",
  "profile",
]);
const OWNER_KEYS = new Set(["tenantId", "userId"]);
const SAFE_IDENTIFIER = /^[^\p{White_Space}\p{Cc}\\/]{1,256}$/u;

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && keys.has(key));
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value !== value.normalize("NFC") ||
      !SAFE_IDENTIFIER.test(value)) {
    throw new VaultPolicyError("VAULT_DESCRIPTOR_INVALID", `${label} is invalid`);
  }
  return value;
}

function optionalIdentifier(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : identifier(value, label);
}

function validateRootPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.normalize("NFC") ||
      !isAbsolute(value) || /\p{Cc}/u.test(value)) {
    throw new VaultPolicyError("VAULT_ROOT_INVALID", "rootPath must be an absolute NFC path");
  }
  const rootPath = resolve(value);
  if (rootPath === parse(rootPath).root) {
    throw new VaultPolicyError("VAULT_ROOT_INVALID", "filesystem root cannot be a Vault root");
  }
  return rootPath;
}

function validateStringSet(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new VaultPolicyError("VAULT_DESCRIPTOR_INVALID", `${label} is invalid`);
  }
  const items = value.map((item) => identifier(item, label));
  if (new Set(items).size !== items.length) {
    throw new VaultPolicyError("VAULT_DESCRIPTOR_INVALID", `${label} contains duplicates`);
  }
  return Object.freeze(items);
}

export function validateVaultScopeDescriptor(value: unknown): VaultScopeDescriptor {
  if (!plainRecord(value) || !hasOnlyKeys(value, DESCRIPTOR_KEYS) ||
      !plainRecord(value.owner) || !hasOnlyKeys(value.owner, OWNER_KEYS) ||
      value.mode !== "standalone" && value.mode !== "attached" ||
      value.profile !== "governed-vault") {
    throw new VaultPolicyError("VAULT_DESCRIPTOR_INVALID");
  }
  if (!Array.isArray(value.allowedVisibilities) || value.allowedVisibilities.length !== 1 ||
      value.allowedVisibilities[0] !== "private") {
    throw new VaultPolicyError(
      "VAULT_VISIBILITY_UNSUPPORTED",
      "the first release permits only private visibility",
    );
  }
  const allowedProjectIds = validateStringSet(value.allowedProjectIds, "allowedProjectIds");
  return Object.freeze({
    vaultId: identifier(value.vaultId, "vaultId"),
    owner: Object.freeze({
      tenantId: identifier(value.owner.tenantId, "owner.tenantId"),
      userId: identifier(value.owner.userId, "owner.userId"),
    }),
    ...(value.workspaceId === undefined
      ? {}
      : { workspaceId: optionalIdentifier(value.workspaceId, "workspaceId")! }),
    allowedVisibilities: Object.freeze(["private"] as const),
    ...(allowedProjectIds === undefined ? {} : { allowedProjectIds }),
    namespace: identifier(value.namespace, "namespace"),
    rootPath: validateRootPath(value.rootPath),
    mode: value.mode,
    profile: "governed-vault",
  });
}

export function assertVaultAllowsScope<T extends VaultDocumentScope>(
  descriptorInput: VaultScopeDescriptor,
  scope: T,
): T {
  const descriptor = validateVaultScopeDescriptor(descriptorInput);
  const visibility = scope.visibility ?? "private";
  const projectAllowed = descriptor.allowedProjectIds === undefined ||
    scope.projectId !== undefined && descriptor.allowedProjectIds.includes(scope.projectId);
  if (scope.tenantId !== descriptor.owner.tenantId ||
      scope.userId !== descriptor.owner.userId ||
      scope.namespace !== descriptor.namespace ||
      visibility !== "private" ||
      descriptor.workspaceId !== undefined && scope.workspaceId !== descriptor.workspaceId ||
      !projectAllowed) {
    throw new VaultPolicyError("VAULT_SCOPE_MISMATCH");
  }
  return scope;
}
