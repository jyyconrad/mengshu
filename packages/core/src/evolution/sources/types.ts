import type { MemoryScope } from "../../domain/types.js";

export type SourceParser = "auto" | "markdown" | "codex-jsonl" | "claude-code-jsonl" | "openclaw-jsonl";
export type SourceSemantics = "current_document" | "append_history" | "reference_snapshot";

/** Only RuntimeHost may construct this binding. File metadata is never authority. */
export interface SourceBinding {
  sourceId: string;
  root: string;
  scope: MemoryScope;
  parser: SourceParser;
  semantics?: SourceSemantics;
  include?: string[];
  exclude?: string[];
  outputRoots?: string[];
  configFingerprint?: string;
}

export interface SourceScanLimits {
  maxEntries: number;
  maxDepth: number;
  maxFiles: number;
  maxBytes: number;
  maxDurationMs: number;
  maxRecords: number;
  maxRecordBytes: number;
  maxSnippetChars: number;
  maxContextChars: number;
}

export interface SourceScanOptions {
  limits?: Partial<SourceScanLimits>;
  /** An opaque, single-use, in-process continuation, not an authority or DB receipt. */
  cursor?: string;
  signal?: AbortSignal;
}

export interface SourceSnapshotFile {
  pathId: string;
  relativePath: string;
  fileIdentity: string;
  logicalFileId: string;
  revisionId: string;
  /** SHA-256 of exactly [0, hashBytes), including any incomplete trailing record. */
  contentHash: string;
  hashBytes: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface SourceSnapshot {
  sourceId: string;
  configFingerprint: string;
  hash: string;
  files: SourceSnapshotFile[];
}

/** Bounded host checkpoint, not source authorization. Contains no source body or parser text state. */
export interface SourceRecordLocator {
  version: 1;
  sourceId: string;
  configFingerprint: string;
  relativePath: string;
  snapshot: SourceSnapshotFile;
  snapshotHash: string;
  record: { id: string; spanOrEventId: string; contentHash: string; byteStart: number; byteEnd: number; lineStart: number; lineEnd: number; digest: string };
  parsing: Pick<SourceScanLimits, "maxRecordBytes" | "maxSnippetChars" | "maxContextChars">;
  /** A committed append prefix is parsed again before resetting the parser's preceding context. */
  replayStart: { offset: number; line: number };
}

export interface SourceExactRead {
  valid: boolean;
  record?: SourceRecord;
  reason?: "unknown_snapshot" | "source_changed" | "max_bytes" | "max_files" | "max_records" | "max_entries" | "max_depth" | "max_duration" | "cancelled";
  /** Records conservatively count nonblank source lines, including metadata and Markdown lookahead. */
  usage: SourceScanReport["usage"];
}

export interface SourceRecord {
  id: string;
  sourceId: string;
  scope: MemoryScope;
  pathId: string;
  relativePath: string;
  logicalFileId: string;
  revisionId: string;
  spanOrEventId: string;
  contentHash: string;
  rootEvidenceId: string;
  independenceGroupId: string;
  parser: Exclude<SourceParser, "auto">;
  semantics: SourceSemantics;
  quote: string;
  context: { heading?: string; before?: string; after?: string; incomplete?: boolean };
  byteStart: number;
  byteEnd: number;
  lineStart: number;
  lineEnd: number;
  observedRole?: "user" | "assistant" | "system" | "tool";
  occurredAt?: number;
  redactedCount: number;
  /** The source asserts this metadata; it is not a verified user decision. */
  authority: "host_binding_only";
  locator?: SourceRecordLocator;
}

export type SourceIssueCode =
  | "max_entries" | "max_depth" | "max_files" | "max_bytes" | "max_duration" | "max_records"
  | "cancelled" | "symlink_rejected" | "output_rejected" | "unreadable" | "source_changed"
  | "directory_changed" | "bad_json" | "unrecognized_jsonl" | "incomplete_line"
  | "record_too_large" | "binary_file" | "manifest_invalid" | "identity_ambiguous";

export interface SourceScanIssue {
  code: SourceIssueCode;
  pathId?: string;
  relativePath?: string;
  line?: number;
}

export interface SourceFileChange {
  pathId: string;
  relativePath: string;
  logicalFileId: string;
  status: "new" | "changed" | "unchanged" | "partial" | "alias" | "source_unavailable";
  previousRevisionId?: string;
  revisionId?: string;
  removedSpanIds: string[];
  semantics?: SourceSemantics;
  revisionChange?: "append" | "rewrite" | "rotation";
  replacedSpanIds?: string[];
}

export interface SourceScanReport {
  scanId: string;
  sourceId: string;
  configFingerprint: string;
  status: "complete" | "partial";
  enumerationComplete: boolean;
  records: SourceRecord[];
  files: SourceFileChange[];
  issues: SourceScanIssue[];
  snapshot: SourceSnapshot;
  sourceSnapshotHash: string;
  usage: { entries: number; files: number; bytes: number; records: number; durationMs: number };
  cursor?: string;
}

/** The caller obtains this evidence from its own durable, authority-scoped DB transaction. */
export interface SourceCommitReceipt {
  receiptId: string;
  sourceSnapshotHash: string;
  recordIds: string[];
}

export interface SourceVerifyOptions {
  maxBytes?: number;
  maxDurationMs?: number;
  signal?: AbortSignal;
}

export interface SourceVerification {
  valid: boolean;
  reason?: "source_changed" | "unknown_snapshot" | "max_bytes" | "max_duration" | "cancelled";
  bytesRead: number;
}

export interface DirectorySourceScannerOptions {
  binding: SourceBinding;
  /** A trusted host-owned path outside the input tree. No writes occur during preview. */
  manifestPath: string;
  maxManifestBytes?: number;
}
