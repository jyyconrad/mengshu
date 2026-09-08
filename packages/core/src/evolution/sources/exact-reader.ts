import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { SourceRecordParser, type ParsedSpan, type ParseResult } from "./parsers.js";
import { resolveLimits, safeLabel, sha256, snapshotHash, stableJson } from "./shared.js";
import type { SourceExactRead, SourceParser, SourceRecord, SourceRecordLocator, SourceScanLimits } from "./types.js";

export class SourceExactReadError extends Error {
  constructor(readonly reason: NonNullable<SourceExactRead["reason"]>) { super(reason); }
}
function fail(reason: NonNullable<SourceExactRead["reason"]>): never { throw new SourceExactReadError(reason); }
const integer = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const hash = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
export function recordDigest(record: SourceRecord): string {
  const { locator: _locator, ...source } = record;
  return sha256(stableJson(source));
}
export function recordCheckpoint(record: SourceRecord): SourceRecordLocator["record"] {
  return { id: record.id, spanOrEventId: record.spanOrEventId, contentHash: record.contentHash,
    byteStart: record.byteStart, byteEnd: record.byteEnd, lineStart: record.lineStart, lineEnd: record.lineEnd, digest: recordDigest(record) };
}
export function safeRelativeSourcePath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && path.length <= 512 && !/[\\:\u0000-\u001f\u007f]/.test(path) &&
    path.split("/").every(part => part && part !== "." && part !== "..") && safeLabel(path) === path;
}
export function validRecordLocator(value: SourceRecordLocator): boolean {
  try {
    if (!value || value.version !== 1 || !safeRelativeSourcePath(value.relativePath) || Buffer.byteLength(JSON.stringify(value)) > 4096) return false;
    const { snapshot: file, record, parsing, replayStart } = value;
    const limits = resolveLimits(parsing);
    return typeof value.sourceId === "string" && value.sourceId.length <= 128 && hash(value.configFingerprint) &&
      file.relativePath === value.relativePath && file.pathId === sha256(value.relativePath) &&
      [file.pathId, file.fileIdentity, file.logicalFileId, file.revisionId, file.contentHash, record.id, record.spanOrEventId, record.contentHash, record.digest].every(hash) &&
      [file.hashBytes, file.size, replayStart.offset, replayStart.line, record.byteStart, record.byteEnd, record.lineStart, record.lineEnd].every(integer) &&
      [file.mtimeMs, file.ctimeMs].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0) &&
      file.hashBytes <= file.size && record.byteEnd <= file.hashBytes && record.byteStart < record.byteEnd &&
      replayStart.offset <= record.byteStart && replayStart.line < record.lineStart && record.lineStart <= record.lineEnd &&
      (replayStart.offset === 0) === (replayStart.line === 0) &&
      ["maxRecordBytes", "maxSnippetChars", "maxContextChars"].every(key => parsing[key as keyof typeof parsing] === limits[key as keyof typeof parsing]) &&
      file.revisionId === sha256(stableJson({ logicalFileId: file.logicalFileId, contentHash: file.contentHash, hashBytes: file.hashBytes })) &&
      value.snapshotHash === snapshotHash(value.sourceId, value.configFingerprint, [file]);
  } catch { return false; }
}

/** Reparse only this file's verified prefix. Session keys, context and roles come from current bytes. */
export async function readExactSpan(handle: FileHandle, locator: SourceRecordLocator, initialParser: SourceParser,
  limits: SourceScanLimits, usage: SourceExactRead["usage"], check: () => void): Promise<{ span: ParsedSpan; parser: SourceParser }> {
  let parser = new SourceRecordParser(initialParser);
  let reset = locator.replayStart.offset === 0;
  let offset = 0;
  let line = 0;
  let buffer = Buffer.alloc(0);
  let span: ParsedSpan | undefined;
  const digest = createHash("sha256");
  const selected = (parsed: ParseResult) => {
    if (parsed.issue) fail("source_changed");
    if (reset && parsed.span?.byteStart === locator.record.byteStart && parsed.span.byteEnd === locator.record.byteEnd) span = parsed.span;
  };
  const consume = (raw: Buffer, terminated: boolean) => {
    check();
    if (raw.length > limits.maxRecordBytes) fail("source_changed");
    if (!reset && offset === locator.replayStart.offset) {
      if (line !== locator.replayStart.line || parser.parser === "markdown") fail("unknown_snapshot");
      parser = new SourceRecordParser(parser.parser, parser.sessionKey);
      reset = true;
    }
    if (!reset && offset > locator.replayStart.offset) fail("unknown_snapshot");
    const text = raw.toString("utf8");
    if (text.trim()) {
      if (usage.records >= limits.maxRecords) fail("max_records");
      usage.records++;
    }
    const start = offset;
    offset += raw.length;
    selected(parser.consume(terminated ? text.replace(/\r?\n$/, "") : text, start, offset, ++line, limits));
  };
  while (usage.bytes < locator.snapshot.hashBytes) {
    check();
    if (usage.bytes >= limits.maxBytes) fail("max_bytes");
    const chunk = Buffer.alloc(Math.min(16 * 1024, locator.snapshot.hashBytes - usage.bytes, limits.maxBytes - usage.bytes));
    const result = await handle.read(chunk, 0, chunk.length, usage.bytes);
    usage.bytes += result.bytesRead;
    check();
    if (!result.bytesRead) fail("source_changed");
    const bytes = chunk.subarray(0, result.bytesRead);
    digest.update(bytes);
    if (span) continue;
    buffer = buffer.length ? Buffer.concat([buffer, bytes]) : bytes;
    let newline: number;
    while (!span && (newline = buffer.indexOf(10)) >= 0) {
      const raw = buffer.subarray(0, newline + 1);
      buffer = buffer.subarray(newline + 1);
      consume(raw, true);
    }
    if (!span && buffer.length > limits.maxRecordBytes) fail("source_changed");
    if (span) buffer = Buffer.alloc(0);
  }
  if (!span && locator.snapshot.hashBytes === locator.snapshot.size && parser.parser === "markdown") {
    if (buffer.length) consume(buffer, false);
    for (let i = 0; !span && i < 2; i++) { check(); selected(parser.finish(limits)); }
  }
  check();
  if (!span || !reset || digest.digest("hex") !== locator.snapshot.contentHash) fail("source_changed");
  return { span, parser: parser.parser };
}
