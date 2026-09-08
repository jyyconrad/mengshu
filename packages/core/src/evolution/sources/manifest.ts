import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { MAX_TRACKED_FILES, MAX_TRACKED_SPANS, sha256 } from "./shared.js";
import type { SourceParser, SourceSemantics } from "./types.js";

export interface ManifestFile {
  pathId: string;
  relativePath: string;
  fileIdentity: string;
  logicalFileId: string;
  contentHash: string;
  hashBytes: number;
  size: number;
  mtimeMs: number;
  revisionId: string;
  parser: SourceParser;
  semantics: SourceSemantics;
  offset: number;
  prefixHash: string;
  line: number;
  sessionKey?: string;
  complete: boolean;
  hasGap: boolean;
  spans: Record<string, string>;
}

export interface SourceManifest {
  version: 1;
  sourceId: string;
  configFingerprint: string;
  generation: number;
  receiptIdHash?: string;
  files: Record<string, ManifestFile>;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
const integer = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

function validManifest(value: unknown): value is SourceManifest {
  if (!record(value) || value.version !== 1 || typeof value.sourceId !== "string" || !hash(value.configFingerprint) ||
      !integer(value.generation) || !record(value.files) || Object.keys(value.files).length > MAX_TRACKED_FILES) return false;
  return Object.entries(value.files).every(([key, file]) => {
    if (!record(file) || key !== file.pathId || !hash(key) || !hash(file.fileIdentity) || !hash(file.contentHash) || !hash(file.prefixHash) ||
        typeof file.relativePath !== "string" || file.relativePath.length > 512 || typeof file.logicalFileId !== "string" ||
        typeof file.revisionId !== "string" || !integer(file.hashBytes) || !integer(file.size) || !integer(file.offset) ||
        !integer(file.line) || typeof file.mtimeMs !== "number" || !Number.isFinite(file.mtimeMs) ||
        typeof file.complete !== "boolean" || typeof file.hasGap !== "boolean" ||
        !["auto", "markdown", "codex-jsonl", "claude-code-jsonl", "openclaw-jsonl"].includes(file.parser as string) ||
        !["current_document", "append_history", "reference_snapshot"].includes(file.semantics as string) ||
        (file.sessionKey !== undefined && !hash(file.sessionKey)) || !record(file.spans) ||
        Object.keys(file.spans).length > MAX_TRACKED_SPANS || (file.offset as number) > (file.hashBytes as number) ||
        (file.hashBytes as number) > (file.size as number)) return false;
    return Object.entries(file.spans).every(([id, contentHash]) => hash(id) && hash(contentHash));
  });
}

export async function readManifest(path: string, maxBytes: number): Promise<{ manifest?: SourceManifest; digest?: string; invalid: boolean }> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) return { invalid: true };
    const buffer = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > maxBytes || offset !== info.size) return { invalid: true };
    const data = buffer.subarray(0, offset).toString("utf8");
    const parsed: unknown = JSON.parse(data);
    return validManifest(parsed) ? { manifest: parsed, digest: sha256(data), invalid: false } : { invalid: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { invalid: false };
    return { invalid: true };
  } finally {
    await handle?.close();
  }
}

export async function writeManifest(path: string, manifest: SourceManifest, maxBytes: number): Promise<string> {
  if (!validManifest(manifest)) throw new Error("invalid source manifest checkpoint");
  const data = JSON.stringify(manifest);
  if (Buffer.byteLength(data) > maxBytes) throw new Error("source manifest capacity exceeded; DB receipt remains authoritative");
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    const directory = await open(parent, constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
    return sha256(data);
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}
