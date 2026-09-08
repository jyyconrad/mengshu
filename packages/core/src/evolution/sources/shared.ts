import { createHash } from "node:crypto";
import { relative, isAbsolute, sep } from "node:path";
import { redactSecrets } from "../../ingest/agent-history/redaction.js";
import type { SourceScanLimits, SourceSnapshotFile } from "./types.js";

export const SCANNER_VERSION = "evolution-sources-v1";
export const MAX_TRACKED_SPANS = 2048;
export const MAX_TRACKED_FILES = 4096;
export const DEFAULT_SOURCE_SCAN_LIMITS: Readonly<SourceScanLimits> = Object.freeze({
  maxEntries: 2000,
  maxDepth: 8,
  maxFiles: 20,
  maxBytes: 10 * 1024 * 1024,
  maxDurationMs: 5 * 60 * 1000,
  maxRecords: 1000,
  maxRecordBytes: 64 * 1024,
  maxSnippetChars: 4096,
  maxContextChars: 512,
});

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, v]) => `${JSON.stringify(key)}:${stableJson(v)}`).join(",")}}`;
}

export function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function safeLabel(value: string, limit = 512): string {
  return redactSecrets(value).text.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, limit);
}

export function resolveLimits(limits?: Partial<SourceScanLimits>): SourceScanLimits {
  const result = { ...DEFAULT_SOURCE_SCAN_LIMITS };
  for (const [name, value] of Object.entries(limits ?? {})) {
    if (!(name in result) || !Number.isSafeInteger(value) || value! < 0) throw new Error("invalid source scan limit");
    result[name as keyof SourceScanLimits] = value!;
  }
  if (result.maxDepth > 64 || result.maxRecordBytes > 1024 * 1024 || result.maxSnippetChars > 65536 || result.maxContextChars > 4096) {
    throw new Error("source scan buffer/depth limit is too large");
  }
  if (result.maxRecordBytes < 1 || result.maxSnippetChars < 1) throw new Error("source scan buffers must be positive");
  return result;
}

export function snapshotHash(sourceId: string, fingerprint: string, files: SourceSnapshotFile[]): string {
  return sha256(stableJson({ sourceId, fingerprint, files: [...files].sort((a, b) => a.pathId.localeCompare(b.pathId)) }));
}
