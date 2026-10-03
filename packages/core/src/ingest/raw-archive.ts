import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope, SourceRevisionRef } from "../domain/types.js";
import {
  captureIdempotencyKey,
  type RawArchiveManifest,
  type RawArchivePort,
} from "./capture-contract.js";

export const RAW_ARCHIVE_MAX_BYTES = 1_048_576;

export type RawArchivePhase = "after_content_rename" | "after_manifest_rename";

export class RawArchiveError extends Error {
  override readonly name = "RawArchiveError";

  constructor(
    readonly code: "RAW_ARCHIVE_DAMAGED" | "RAW_ARCHIVE_CONFLICT" | "RAW_ARCHIVE_INVALID",
  ) {
    super(code);
  }
}

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9._:-]+$/;
const CONTENT_PATH = /^raw\/(sources|sessions|events)\/[A-Za-z0-9._:-]+\/[A-Za-z0-9._:-]+\/content\.(txt|json|bin)$/;
const MEDIA_EXTENSION = Object.freeze({
  "text/plain": "txt",
  "application/json": "json",
  "application/octet-stream": "bin",
} as const);

export type RawArchiveMediaType = keyof typeof MEDIA_EXTENSION;
export type RawArchiveKind = "sources" | "sessions" | "events";

export function encodeRawPathSegment(value: string): string {
  if (SAFE_SEGMENT.test(value) && value !== "." && value !== "..") return value;
  return `h${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

export function rawContentRelativePath(input: {
  readonly kind: RawArchiveKind;
  readonly sourceId: string;
  readonly revision: string;
  readonly mediaType: RawArchiveMediaType;
}): string {
  return `raw/${input.kind}/${encodeRawPathSegment(input.sourceId)}/${encodeRawPathSegment(input.revision)}/content.${MEDIA_EXTENSION[input.mediaType]}`;
}

export function rawManifestRelativePath(captureId: string): string {
  return `raw/manifests/${captureId}.json`;
}

function isMediaType(value: unknown): value is RawArchiveMediaType {
  return typeof value === "string" && Object.hasOwn(MEDIA_EXTENSION, value);
}

function scopeFromUnknown(value: unknown): MemoryScope {
  if (!value || typeof value !== "object") throw new RawArchiveError("RAW_ARCHIVE_INVALID");
  const record = value as Record<string, unknown>;
  const required = ["tenantId", "userId", "appId", "projectId", "agentId", "namespace", "visibility"] as const;
  if (required.some((key) => typeof record[key] !== "string")) {
    throw new RawArchiveError("RAW_ARCHIVE_INVALID");
  }
  const scope: MemoryScope = {
    tenantId: record.tenantId as string,
    userId: record.userId as string,
    appId: record.appId as string,
    projectId: record.projectId as string,
    agentId: record.agentId as string,
    namespace: record.namespace as string,
    visibility: record.visibility as MemoryScope["visibility"],
  };
  if (record.workspaceId !== undefined) {
    if (typeof record.workspaceId !== "string") throw new RawArchiveError("RAW_ARCHIVE_INVALID");
    scope.workspaceId = record.workspaceId;
  }
  if (record.sessionId !== undefined) {
    if (typeof record.sessionId !== "string") throw new RawArchiveError("RAW_ARCHIVE_INVALID");
    scope.sessionId = record.sessionId;
  }
  return scope;
}

export function canonicalManifestText(manifest: RawArchiveManifest): string {
  const scope: Record<string, string> = {
    agentId: manifest.scope.agentId,
    appId: manifest.scope.appId,
    namespace: manifest.scope.namespace,
    projectId: manifest.scope.projectId,
    tenantId: manifest.scope.tenantId,
    userId: manifest.scope.userId,
    visibility: manifest.scope.visibility ?? "",
  };
  if (manifest.scope.sessionId !== undefined) scope.sessionId = manifest.scope.sessionId;
  if (manifest.scope.workspaceId !== undefined) scope.workspaceId = manifest.scope.workspaceId;
  return JSON.stringify({
    byteLength: manifest.byteLength,
    captureId: manifest.captureId,
    mediaType: manifest.mediaType,
    relativePath: manifest.relativePath,
    scope,
    source: {
      payloadHash: manifest.source.payloadHash,
      revision: manifest.source.revision,
      sourceId: manifest.source.sourceId,
    },
  });
}

export function parseRawArchiveManifest(value: unknown): RawArchiveManifest {
  const record = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!record || typeof record !== "object") throw new RawArchiveError("RAW_ARCHIVE_INVALID");
  const raw = record as Record<string, unknown>;
  const sourceRaw = raw.source;
  if (!sourceRaw || typeof sourceRaw !== "object") throw new RawArchiveError("RAW_ARCHIVE_INVALID");
  const sourceRecord = sourceRaw as Record<string, unknown>;
  const source: SourceRevisionRef = {
    sourceId: sourceRecord.sourceId as string,
    revision: sourceRecord.revision as string,
    payloadHash: sourceRecord.payloadHash as string,
  };
  if (!isMediaType(raw.mediaType) || typeof raw.relativePath !== "string" ||
      typeof raw.captureId !== "string" || !SHA256.test(raw.captureId) ||
      !Number.isSafeInteger(raw.byteLength) || (raw.byteLength as number) < 1 ||
      (raw.byteLength as number) > RAW_ARCHIVE_MAX_BYTES ||
      !CONTENT_PATH.test(raw.relativePath) || raw.relativePath.includes("/wiki/")) {
    throw new RawArchiveError("RAW_ARCHIVE_INVALID");
  }
  const scope = scopeFromUnknown(raw.scope);
  let fingerprint: string;
  try {
    fingerprint = authorityScopeFingerprint(scope);
  } catch {
    throw new RawArchiveError("RAW_ARCHIVE_INVALID");
  }
  let idempotencyKey: string;
  try {
    idempotencyKey = captureIdempotencyKey({ scopeFingerprint: fingerprint, source });
  } catch {
    throw new RawArchiveError("RAW_ARCHIVE_INVALID");
  }
  const expectedPath = rawContentRelativePath({
    kind: raw.relativePath.split("/")[1] as RawArchiveKind,
    sourceId: source.sourceId,
    revision: source.revision,
    mediaType: raw.mediaType,
  });
  if (raw.captureId !== idempotencyKey || raw.relativePath !== expectedPath ||
      MEDIA_EXTENSION[raw.mediaType] !== raw.relativePath.split(".").pop()) {
    throw new RawArchiveError("RAW_ARCHIVE_INVALID");
  }
  return Object.freeze({
    captureId: raw.captureId,
    scope: Object.freeze({ ...scope }),
    source: Object.freeze({ ...source }),
    byteLength: raw.byteLength as number,
    mediaType: raw.mediaType,
    relativePath: raw.relativePath,
  });
}

function contained(root: string, fingerprint: string, relativePath: string): string {
  if (!SHA256.test(fingerprint) || relativePath.startsWith("/") || relativePath.includes("\\") ||
      relativePath.split("/").some((part) => part === "" || part === "." || part === "..") ||
      relativePath === "wiki" || relativePath.startsWith("wiki/") || relativePath.includes("/wiki/")) {
    throw new RawArchiveError("RAW_ARCHIVE_INVALID");
  }
  const scopeRoot = resolve(root, fingerprint);
  const full = resolve(scopeRoot, ...relativePath.split("/"));
  const fromRoot = relative(scopeRoot, full);
  if (fromRoot.startsWith("..") || fromRoot.split(sep).includes("..") || resolve(scopeRoot, fromRoot) !== full) {
    throw new RawArchiveError("RAW_ARCHIVE_INVALID");
  }
  return full;
}

async function assertNoSymlink(root: string, target: string): Promise<void> {
  const rootStat = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (rootStat?.isSymbolicLink()) throw new RawArchiveError("RAW_ARCHIVE_INVALID");
  const fromRoot = relative(root, target);
  if (fromRoot.startsWith("..")) throw new RawArchiveError("RAW_ARCHIVE_INVALID");
  let current = root;
  for (const part of fromRoot.split(sep).filter((part) => part.length > 0)) {
    current = join(current, part);
    const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new RawArchiveError("RAW_ARCHIVE_INVALID");
  }
}

async function publishAtomic(
  targetPath: string,
  bytes: Uint8Array,
  phase: (() => Promise<void>) | undefined,
): Promise<"created" | "unchanged"> {
  const existing = await lstat(targetPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) throw new RawArchiveError("RAW_ARCHIVE_INVALID");
    const current = await readFile(targetPath);
    if (Buffer.compare(current, bytes) !== 0) throw new RawArchiveError("RAW_ARCHIVE_CONFLICT");
    return "unchanged";
  }
  await mkdir(dirname(targetPath), { recursive: true });
  const tempPath = join(dirname(targetPath), `.${randomUUID()}.mengshu-stage`);
  const handle = await open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    const staged = await readFile(tempPath);
    if (Buffer.compare(staged, bytes) !== 0) throw new RawArchiveError("RAW_ARCHIVE_DAMAGED");
    try {
      await link(tempPath, targetPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      const raced = await readFile(targetPath);
      if (Buffer.compare(raced, bytes) !== 0) throw new RawArchiveError("RAW_ARCHIVE_CONFLICT");
      return "unchanged";
    }
    const directory = await open(dirname(targetPath), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    if (phase) await phase();
    return "created";
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
}

export class FileRawArchive implements RawArchivePort {
  private readonly root: string;

  constructor(private readonly options: {
    readonly root: string;
    readonly onPhase?: (phase: RawArchivePhase, manifest: RawArchiveManifest) => void | Promise<void>;
  }) {
    this.root = resolve(options.root);
  }

  async put(input: { readonly manifest: RawArchiveManifest; readonly bytes: Uint8Array }): Promise<void> {
    const manifest = parseRawArchiveManifest(input.manifest);
    if (input.bytes.byteLength !== manifest.byteLength) throw new RawArchiveError("RAW_ARCHIVE_INVALID");
    const payloadHash = createHash("sha256").update(input.bytes).digest("hex");
    if (payloadHash !== manifest.source.payloadHash) throw new RawArchiveError("RAW_ARCHIVE_DAMAGED");
    if (Buffer.byteLength(canonicalManifestText(manifest)) > 8192) {
      throw new RawArchiveError("RAW_ARCHIVE_INVALID");
    }
    const fingerprint = authorityScopeFingerprint(manifest.scope);
    const contentPath = contained(this.root, fingerprint, manifest.relativePath);
    await assertNoSymlink(this.root, dirname(contentPath));
    await publishAtomic(contentPath, input.bytes, async () => {
      await this.options.onPhase?.("after_content_rename", manifest);
    });
    await assertNoSymlink(this.root, contentPath);
    const manifestPath = contained(this.root, fingerprint, rawManifestRelativePath(manifest.captureId));
    await assertNoSymlink(this.root, dirname(manifestPath));
    await publishAtomic(manifestPath, Buffer.from(canonicalManifestText(manifest)), async () => {
      await this.options.onPhase?.("after_manifest_rename", manifest);
    });
  }

  async read(manifest: RawArchiveManifest): Promise<Uint8Array> {
    const parsed = parseRawArchiveManifest(manifest);
    const fingerprint = authorityScopeFingerprint(parsed.scope);
    const contentPath = contained(this.root, fingerprint, parsed.relativePath);
    await assertNoSymlink(this.root, contentPath);
    const stat = await lstat(contentPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new RawArchiveError("RAW_ARCHIVE_DAMAGED");
      throw error;
    });
    if (stat.isSymbolicLink() || !stat.isFile()) throw new RawArchiveError("RAW_ARCHIVE_DAMAGED");
    const bytes = await readFile(contentPath);
    const payloadHash = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== parsed.byteLength || payloadHash !== parsed.source.payloadHash) {
      throw new RawArchiveError("RAW_ARCHIVE_DAMAGED");
    }
    return new Uint8Array(bytes);
  }

  async findManifest(scopeFingerprint: string, captureId: string): Promise<RawArchiveManifest | undefined> {
    if (!SHA256.test(scopeFingerprint) || !SHA256.test(captureId)) return undefined;
    const manifestPath = contained(this.root, scopeFingerprint, rawManifestRelativePath(captureId));
    await assertNoSymlink(this.root, manifestPath);
    const raw = await readFile(manifestPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (raw === undefined) return undefined;
    try {
      const manifest = parseRawArchiveManifest(raw);
      if (authorityScopeFingerprint(manifest.scope) !== scopeFingerprint || manifest.captureId !== captureId) {
        return undefined;
      }
      return manifest;
    } catch {
      return undefined;
    }
  }

  async listManifests(): Promise<readonly RawArchiveManifest[]> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const manifests: RawArchiveManifest[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !SHA256.test(entry.name)) continue;
      const directory = join(this.root, entry.name, "raw", "manifests");
      const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const file of files) {
        if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
        const manifest = await this.findManifest(entry.name, file.slice(0, 64));
        if (manifest) manifests.push(manifest);
      }
    }
    return Object.freeze(manifests);
  }
}
