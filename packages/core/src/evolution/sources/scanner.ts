import { createHash, randomUUID, type Hash } from "node:crypto";
import { constants, type Dir, type Stats } from "node:fs";
import { lstat, open, opendir, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import { REDACTION_MAP_VERSION } from "../../ingest/agent-history/redaction.js";
import { readManifest, writeManifest, type ManifestFile, type SourceManifest } from "./manifest.js";
import { SourceRecordParser, type ParsedSpan, type ParseResult } from "./parsers.js";
import { readExactSpan, recordCheckpoint, safeRelativeSourcePath, SourceExactReadError, validRecordLocator } from "./exact-reader.js";
import { DEFAULT_SOURCE_SCAN_LIMITS, MAX_TRACKED_FILES, MAX_TRACKED_SPANS, SCANNER_VERSION, resolveLimits, safeLabel, sha256, snapshotHash, stableJson, within } from "./shared.js";
import type {
  DirectorySourceScannerOptions, SourceBinding, SourceCommitReceipt, SourceFileChange, SourceIssueCode,
  SourceScanIssue, SourceScanLimits, SourceScanOptions, SourceScanReport, SourceSemantics, SourceSnapshot,
  SourceSnapshotFile, SourceVerification, SourceVerifyOptions, SourceRecord, SourceRecordLocator, SourceExactRead, SourceParser,
} from "./types.js";

const EXCLUDED_DIRS = new Set([
  ".git", "node_modules", "bower_components", "vendor", ".venv", "venv", "__pycache__",
  "dist", "build", "target", "coverage", ".next", ".nuxt", ".cache", ".output", ".mengshu", "mengshu-data",
]);
const CHUNK_BYTES = 16 * 1024;
const identity = (info: Stats) => sha256(`${info.dev}:${info.ino}`);
const sameStat = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

async function canonicalFuturePath(path: string): Promise<string> {
  let parent = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try { return join(await realpath(parent), ...missing.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(parent) === parent) throw new Error("unreadable source output root");
      missing.push(basename(parent));
      parent = dirname(parent);
    }
  }
}

interface DirectoryFrame { dir: Dir; path: string; relativePath: string; info: Stats }
interface PendingFile {
  path: string;
  relativePath: string;
  pathId: string;
  handle: FileHandle;
  info: Stats;
  prior?: ManifestFile;
  logicalFileId: string;
  parser: SourceRecordParser;
  readHash: Hash;
  boundaryHash: Hash;
  readOffset: number;
  offset: number;
  line: number;
  buffer: Buffer;
  skippingLongLine: boolean;
  lineStart: number;
  prefixTarget: number;
  prefixVerified: boolean;
  gap: boolean;
  eof: boolean;
  spans: Record<string, string>;
  seenSpans: Set<string>;
  seenOverflow: boolean;
  revisionChange?: "append" | "rewrite" | "rotation";
  replacedSpans: Set<string>;
  replayStart: { offset: number; line: number };
}
interface ScanState {
  frames: DirectoryFrame[];
  nextFile?: string;
  file?: PendingFile;
  seen: Set<string>;
  logicalSeen: Set<string>;
  observed: Map<string, ManifestFile>;
  uncertain: boolean;
  initialized: boolean;
  done: boolean;
  lastAcknowledgement?: { generation?: number };
  parsingLimits: string;
}
interface PreparedReport {
  digest: string;
  generation: number;
  recordIds: string[];
  sourceSnapshotHash: string;
  updates: ManifestFile[];
  removePaths: string[];
  confirmedReceipt?: string;
  acknowledgement: { generation?: number };
  predecessor?: { generation?: number };
}
interface Page {
  limits: SourceScanLimits;
  signal?: AbortSignal;
  started: number;
  report: SourceScanReport;
  updates: ManifestFile[];
  removals: string[];
  stopped: boolean;
}

/** Host-owned scanner. Preview does not write files, execute source content, or call providers. */
export class DirectorySourceScanner {
  readonly binding: Readonly<SourceBinding>;
  readonly configFingerprint: string;
  private readonly manifestPath: string;
  private readonly maxManifestBytes: number;
  private readonly includes?: Ignore;
  private readonly excludes?: Ignore;
  private readonly outputs: string[];
  private readonly scopeHash: string;
  private manifest: SourceManifest;
  private manifestDigest?: string;
  private manifestInvalid: boolean;
  private readonly paths = new Map<string, string>();
  private readonly prepared = new Map<string, PreparedReport>();
  private readonly confirmedReceipts = new Set<string>();
  private active?: { token: string; state: ScanState };
  private busy = false;
  private closed = false;

  private constructor(options: DirectorySourceScannerOptions, binding: SourceBinding, outputs: string[], manifest: SourceManifest, digest: string | undefined, invalid: boolean) {
    this.binding = Object.freeze(binding);
    this.configFingerprint = manifest.configFingerprint;
    this.manifestPath = resolve(options.manifestPath);
    this.maxManifestBytes = options.maxManifestBytes ?? 2 * 1024 * 1024;
    this.outputs = outputs;
    this.manifest = manifest;
    this.manifestDigest = digest;
    this.manifestInvalid = invalid;
    this.scopeHash = sha256(stableJson(binding.scope));
    this.includes = binding.include?.length ? ignore().add(binding.include) : undefined;
    this.excludes = binding.exclude?.length ? ignore().add(binding.exclude) : undefined;
  }

  static async create(options: DirectorySourceScannerOptions): Promise<DirectorySourceScanner> {
    const raw = options.binding;
    if (!raw || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(raw.sourceId) || !isAbsolute(raw.root) || !isAbsolute(options.manifestPath)) {
      throw new Error("source binding requires a trusted sourceId and absolute host paths");
    }
    if (!["auto", "markdown", "codex-jsonl", "claude-code-jsonl", "openclaw-jsonl"].includes(raw.parser)) throw new Error("unsupported source parser");
    if (raw.semantics && !["current_document", "append_history", "reference_snapshot"].includes(raw.semantics)) throw new Error("invalid source semantics");
    for (const key of ["tenantId", "appId", "userId", "projectId", "agentId", "namespace"] as const) {
      if (typeof raw.scope?.[key] !== "string" || !raw.scope[key].trim()) throw new Error("trusted source scope is required");
    }
    for (const patterns of [raw.include, raw.exclude]) {
      if (patterns && (patterns.length > 64 || patterns.some(p => typeof p !== "string" || p.length > 256 || p.startsWith("!") || p.includes("\0")))) {
        throw new Error("invalid source include/exclude patterns");
      }
    }
    const maxManifestBytes = options.maxManifestBytes ?? 2 * 1024 * 1024;
    if (!Number.isSafeInteger(maxManifestBytes) || maxManifestBytes < 256 || maxManifestBytes > 16 * 1024 * 1024) throw new Error("invalid source manifest limit");
    const root = await realpath(raw.root);
    const info = await lstat(root);
    if (!info.isDirectory()) throw new Error("source root must be a directory");
    if (root.split(sep).some(part => EXCLUDED_DIRS.has(part))) throw new Error("source root is an excluded output/dependency directory");
    const outputs: string[] = [];
    for (const path of [...(raw.outputRoots ?? []), dirname(resolve(options.manifestPath))]) {
      if (!isAbsolute(path)) throw new Error("source output roots must be absolute");
      outputs.push(await canonicalFuturePath(path));
    }
    if (outputs.some(path => within(path, root))) throw new Error("source root is inside an output directory");
    const manifestPath = join(outputs.at(-1)!, basename(options.manifestPath));
    if (within(root, manifestPath)) throw new Error("source manifest must be outside the input root");
    const binding = structuredClone({ ...raw, root, scope: Object.freeze({ ...raw.scope }) });
    Object.freeze(binding.scope);
    for (const array of [binding.include, binding.exclude, binding.outputRoots]) if (array) Object.freeze(array);
    const configFingerprint = sha256(stableJson({ ...binding, scanner: SCANNER_VERSION, redaction: REDACTION_MAP_VERSION }));
    const loaded = await readManifest(manifestPath, maxManifestBytes);
    const compatible = loaded.manifest?.sourceId === raw.sourceId && loaded.manifest.configFingerprint === configFingerprint;
    const manifest: SourceManifest = compatible ? loaded.manifest! : { version: 1, sourceId: raw.sourceId, configFingerprint, generation: 0, files: {} };
    return new DirectorySourceScanner({ ...options, manifestPath }, binding, outputs, manifest, loaded.digest, loaded.invalid);
  }

  async scan(options: SourceScanOptions = {}): Promise<SourceScanReport> {
    if (this.closed || this.busy) throw new Error("source scanner is closed or busy; use one host owner");
    const limits = resolveLimits(options.limits);
    const parsingLimits = stableJson({ maxDepth: limits.maxDepth, maxRecordBytes: limits.maxRecordBytes, maxSnippetChars: limits.maxSnippetChars, maxContextChars: limits.maxContextChars });
    this.busy = true;
    let state: ScanState | undefined;
    try {
      if (options.cursor) {
        if (!this.active || this.active.token !== options.cursor) throw new Error("invalid or expired source cursor");
        state = this.active.state;
        this.active = undefined;
        if (state.parsingLimits !== parsingLimits) throw new Error("source parsing limits changed; restart the scan without its cursor");
      } else {
        if (this.active) await this.closeState(this.active.state);
        this.active = undefined;
        state = { frames: [], seen: new Set(), logicalSeen: new Set(), observed: new Map(), uncertain: false, initialized: false, done: false, parsingLimits };
      }
      const started = performance.now();
      const emptyHash = snapshotHash(this.binding.sourceId, this.configFingerprint, []);
      const report: SourceScanReport = {
        scanId: randomUUID(), sourceId: this.binding.sourceId, configFingerprint: this.configFingerprint,
        status: "complete", enumerationComplete: false, records: [], files: [], issues: [],
        snapshot: { sourceId: this.binding.sourceId, configFingerprint: this.configFingerprint, hash: emptyHash, files: [] },
        sourceSnapshotHash: emptyHash, usage: { entries: 0, files: 0, bytes: 0, records: 0, durationMs: 0 },
      };
      const page: Page = { limits, signal: options.signal, started, report, updates: [], removals: [], stopped: false };
      if (this.manifestInvalid) { this.issue(page, "manifest_invalid"); state.uncertain = true; }
      while (!state.done && !page.stopped) {
        if (this.stop(page)) break;
        if (!state.initialized) {
          state.initialized = true;
          try { state.frames.push(await this.directoryFrame(this.binding.root, "")); }
          catch { this.issue(page, "unreadable"); state.uncertain = true; state.done = true; break; }
        }
        if (state.file || state.nextFile) {
          if (report.usage.files >= limits.maxFiles) { this.issue(page, "max_files"); page.stopped = true; break; }
          report.usage.files++;
          if (!state.file) {
            const path = state.nextFile!;
            state.nextFile = undefined;
            try { state.file = await this.openFile(path, state); }
            catch { this.issue(page, "unreadable", path); state.uncertain = true; continue; }
          }
          await this.readFilePage(state, page);
          continue;
        }
        const frame = state.frames.at(-1);
        if (!frame) { state.done = true; break; }
        if (report.usage.entries >= limits.maxEntries) { this.issue(page, "max_entries"); page.stopped = true; break; }
        let entry;
        try { entry = await frame.dir.read(); }
        catch { this.issue(page, "unreadable", frame.path); state.uncertain = true; await this.finishDirectory(state, page); continue; }
        if (!entry) { await this.finishDirectory(state, page); continue; }
        report.usage.entries++;
        const path = join(frame.path, entry.name);
        const rel = relative(this.binding.root, path).split(sep).join("/");
        if (entry.isSymbolicLink()) { this.issue(page, "symlink_rejected", path); state.uncertain = true; continue; }
        if (EXCLUDED_DIRS.has(entry.name) || this.excludes?.ignores(entry.isDirectory() ? `${rel}/` : rel)) continue;
        if (this.outputs.some(output => within(output, path))) { this.issue(page, "output_rejected", path); continue; }
        if (entry.isDirectory()) {
          if (state.frames.length > limits.maxDepth) { this.issue(page, "max_depth", path); state.uncertain = true; continue; }
          try { state.frames.push(await this.directoryFrame(path, rel)); }
          catch { this.issue(page, "unreadable", path); state.uncertain = true; }
          continue;
        }
        if (!entry.isFile() || !this.acceptFile(rel)) continue;
        const pathId = sha256(rel);
        if (state.seen.size >= MAX_TRACKED_FILES || (this.paths.size >= MAX_TRACKED_FILES && !this.paths.has(pathId))) {
          this.issue(page, "max_entries", path); state.uncertain = true; state.done = true; break;
        }
        state.seen.add(pathId);
        this.paths.set(pathId, path);
        state.nextFile = path;
      }
      report.enumerationComplete = state.done && !state.uncertain;
      if (report.enumerationComplete) {
        // Only missing files require a complete directory enumeration.
        for (const [pathId, old] of Object.entries(this.manifest.files)) {
          if (state.seen.has(pathId)) continue;
          if (state.logicalSeen.has(old.logicalFileId)) { page.removals.push(pathId); continue; }
          report.files.push({ pathId, relativePath: old.relativePath, logicalFileId: old.logicalFileId, status: "source_unavailable", previousRevisionId: old.revisionId, removedSpanIds: [], semantics: old.semantics });
        }
      }
      if (!state.done && !options.signal?.aborted) {
        const token = randomUUID();
        this.active = { token, state };
        report.cursor = token;
      } else await this.closeState(state);
      report.status = report.enumerationComplete && !report.issues.some(issue => !["output_rejected"].includes(issue.code)) && !report.files.some(f => f.status === "partial") ? "complete" : "partial";
      report.sourceSnapshotHash = snapshotHash(this.binding.sourceId, this.configFingerprint, report.snapshot.files);
      report.snapshot.hash = report.sourceSnapshotHash;
      report.usage.durationMs = Math.max(0, performance.now() - started);
      const acknowledgement = {};
      this.prepared.set(report.scanId, { digest: sha256(stableJson(report)), generation: this.manifest.generation,
        recordIds: report.records.map(record => record.id), sourceSnapshotHash: report.sourceSnapshotHash, updates: page.updates, removePaths: page.removals,
        acknowledgement, predecessor: state.lastAcknowledgement });
      if (report.records.length || report.files.some(file => file.removedSpanIds.length)) state.lastAcknowledgement = acknowledgement;
      while (this.prepared.size > 16) this.prepared.delete(this.prepared.keys().next().value!);
      return report;
    } catch (error) {
      if (state) await this.closeState(state);
      throw error;
    } finally { this.busy = false; }
  }

  async verifySnapshot(snapshot: SourceSnapshot, options: SourceVerifyOptions = {}): Promise<SourceVerification> {
    const maxBytes = options.maxBytes ?? DEFAULT_SOURCE_SCAN_LIMITS.maxBytes;
    const maxDuration = options.maxDurationMs ?? DEFAULT_SOURCE_SCAN_LIMITS.maxDurationMs;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(maxDuration) || maxDuration < 0) throw new Error("invalid source verification limits");
    let bytesRead = 0;
    const started = performance.now();
    const stopped = (): SourceVerification | undefined => {
      const reason = options.signal?.aborted ? "cancelled" : performance.now() - started >= maxDuration ? "max_duration" : undefined;
      return reason ? { valid: false, reason, bytesRead } : undefined;
    };
    const initialStop = stopped();
    if (initialStop) return initialStop;
    if (snapshot.sourceId !== this.binding.sourceId || snapshot.configFingerprint !== this.configFingerprint ||
        snapshot.hash !== snapshotHash(snapshot.sourceId, snapshot.configFingerprint, snapshot.files)) {
      return { valid: false, reason: "unknown_snapshot", bytesRead };
    }
    for (const expected of snapshot.files) {
      const beforeOpen = stopped();
      if (beforeOpen) return beforeOpen;
      const path = this.paths.get(expected.pathId);
      if (!path || !Number.isSafeInteger(expected.hashBytes) || expected.hashBytes < 0 || expected.hashBytes > expected.size) return { valid: false, reason: "unknown_snapshot", bytesRead };
      let handle;
      try {
        handle = await this.safeOpen(path);
        const initial = await handle.stat();
        if (identity(initial) !== expected.fileIdentity || initial.size !== expected.size || initial.mtimeMs !== expected.mtimeMs || initial.ctimeMs !== expected.ctimeMs) {
          return { valid: false, reason: "source_changed", bytesRead };
        }
        const hash = createHash("sha256");
        let offset = 0;
        while (offset < expected.hashBytes) {
          if (options.signal?.aborted) return { valid: false, reason: "cancelled", bytesRead };
          if (performance.now() - started >= maxDuration) return { valid: false, reason: "max_duration", bytesRead };
          if (bytesRead >= maxBytes) return { valid: false, reason: "max_bytes", bytesRead };
          const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, expected.hashBytes - offset, maxBytes - bytesRead));
          const result = await handle.read(buffer, 0, buffer.length, offset);
          bytesRead += result.bytesRead;
          offset += result.bytesRead;
          const afterRead = stopped();
          if (afterRead) return afterRead;
          if (!result.bytesRead) return { valid: false, reason: "source_changed", bytesRead };
          hash.update(buffer.subarray(0, result.bytesRead));
        }
        if (hash.digest("hex") !== expected.contentHash || !sameStat(initial, await handle.stat()) || !sameStat(initial, await this.safeStat(path))) {
          return { valid: false, reason: "source_changed", bytesRead };
        }
      } catch { return { valid: false, reason: "source_changed", bytesRead }; }
      finally { await handle?.close(); }
    }
    return stopped() ?? { valid: true, bytesRead };
  }

  async readRecord(locator: SourceRecordLocator, options: Omit<SourceScanOptions, "cursor"> = {}): Promise<SourceExactRead> {
    if (this.closed || this.busy) throw new Error("source scanner is closed or busy; use one host owner");
    const usage = { entries: 0, files: 0, bytes: 0, records: 0, durationMs: 0 };
    const started = performance.now();
    const finish = (result: Omit<SourceExactRead, "usage">): SourceExactRead => ({ ...result, usage: { ...usage, durationMs: Math.max(0, performance.now() - started) } });
    if (!validRecordLocator(locator) || locator.sourceId !== this.binding.sourceId || locator.configFingerprint !== this.configFingerprint) return finish({ valid: false, reason: "unknown_snapshot" });
    const limits = resolveLimits({ ...locator.parsing, ...options.limits });
    if (Object.entries(locator.parsing).some(([key, value]) => limits[key as keyof SourceScanLimits] !== value)) return finish({ valid: false, reason: "unknown_snapshot" });
    const check = () => {
      if (options.signal?.aborted) throw new SourceExactReadError("cancelled");
      if (performance.now() - started >= limits.maxDurationMs) throw new SourceExactReadError("max_duration");
    };
    let handle: FileHandle | undefined;
    this.busy = true;
    try {
      check();
      const parts = locator.relativePath.split("/");
      if (parts.length - 1 > limits.maxDepth) throw new SourceExactReadError("max_depth");
      if (parts.length + 1 > limits.maxEntries) throw new SourceExactReadError("max_entries");
      if (this.paths.size >= MAX_TRACKED_FILES && !this.paths.has(locator.snapshot.pathId)) throw new SourceExactReadError("max_entries");
      if (!limits.maxFiles) throw new SourceExactReadError("max_files");
      if (!limits.maxBytes) throw new SourceExactReadError("max_bytes");
      if (!limits.maxRecords) throw new SourceExactReadError("max_records");
      const path = join(this.binding.root, ...parts);
      const excluded = parts.some((part, i) => EXCLUDED_DIRS.has(part) || this.excludes?.ignores(parts.slice(0, i + 1).join("/") + (i < parts.length - 1 ? "/" : "")));
      if (excluded || !this.acceptFile(locator.relativePath) || this.outputs.some(output => within(output, path))) throw new SourceExactReadError("unknown_snapshot");
      usage.entries = parts.length + 1;
      usage.files = 1;
      handle = await this.safeOpen(path);
      check();
      const initial = await handle.stat();
      const expected = locator.snapshot;
      if (identity(initial) !== expected.fileIdentity || initial.size !== expected.size || initial.mtimeMs !== expected.mtimeMs || initial.ctimeMs !== expected.ctimeMs) throw new SourceExactReadError("source_changed");
      const parser = [".md", ".mdx", ".txt"].includes(extname(path).toLowerCase()) ? "markdown" : this.binding.parser;
      const read = await readExactSpan(handle, locator, parser, limits, usage, check);
      if (!sameStat(initial, await handle.stat()) || !sameStat(initial, await this.safeStat(path))) throw new SourceExactReadError("source_changed");
      check();
      const record = this.sourceRecord(read.span, expected, read.parser);
      if (stableJson(recordCheckpoint(record)) !== stableJson(locator.record)) throw new SourceExactReadError("source_changed");
      record.locator = structuredClone(locator);
      this.paths.set(expected.pathId, path);
      return finish({ valid: true, record });
    } catch (error) {
      return finish({ valid: false, reason: error instanceof SourceExactReadError ? error.reason : "source_changed" });
    } finally { await handle?.close(); this.busy = false; }
  }

  async confirm(report: SourceScanReport, receipt: SourceCommitReceipt): Promise<void> {
    if (this.closed || this.busy) throw new Error("source scanner is closed or busy; use one host owner");
    const prepared = this.prepared.get(report.scanId);
    if (!prepared || prepared.digest !== sha256(stableJson(report))) throw new Error("unknown, expired or modified source report");
    if (!receipt.receiptId?.trim() || receipt.receiptId.length > 512 || receipt.sourceSnapshotHash !== prepared.sourceSnapshotHash ||
        stableJson([...new Set(receipt.recordIds)].sort()) !== stableJson([...new Set(prepared.recordIds)].sort())) {
      throw new Error("source receipt must cover the exact snapshot and every selected record");
    }
    const receiptHash = sha256(receipt.receiptId);
    if (prepared.confirmedReceipt === receiptHash) return;
    if (prepared.confirmedReceipt || this.confirmedReceipts.has(receiptHash) || this.manifest.receiptIdHash === receiptHash) throw new Error("source receipt already confirmed another page");
    if (this.confirmedReceipts.size >= MAX_TRACKED_FILES) throw new Error("source receipt capacity reached; restart with a new checkpoint");
    if (prepared.predecessor && prepared.predecessor.generation === undefined) throw new Error("preceding source page requires its own DB receipt before confirmation");
    const expectedGeneration = prepared.predecessor?.generation ?? prepared.generation;
    if (expectedGeneration !== this.manifest.generation) throw new Error("source manifest checkpoint is stale");
    this.busy = true;
    try {
      const disk = await readManifest(this.manifestPath, this.maxManifestBytes);
      if (disk.invalid || disk.digest !== this.manifestDigest) throw new Error("source manifest changed; host must rebuild using DB receipts");
      const files = { ...this.manifest.files };
      for (const file of prepared.updates) files[file.pathId] = structuredClone(file);
      for (const pathId of prepared.removePaths) delete files[pathId];
      const next: SourceManifest = { ...this.manifest, generation: this.manifest.generation + 1, receiptIdHash: receiptHash, files };
      this.manifestDigest = await writeManifest(this.manifestPath, next, this.maxManifestBytes);
      this.manifest = next;
      this.manifestInvalid = false;
      prepared.confirmedReceipt = receiptHash;
      this.confirmedReceipts.add(receiptHash);
      prepared.acknowledgement.generation = next.generation;
    } finally { this.busy = false; }
  }

  async close(): Promise<void> {
    if (this.busy) throw new Error("source scanner is busy");
    if (this.active) await this.closeState(this.active.state);
    this.active = undefined;
    this.prepared.clear();
    this.confirmedReceipts.clear();
    this.paths.clear();
    this.closed = true;
  }

  private stop(page: Page): boolean {
    const code = page.signal?.aborted ? "cancelled" : performance.now() - page.started >= page.limits.maxDurationMs ? "max_duration" : undefined;
    if (code) { this.issue(page, code); page.stopped = true; return true; }
    return false;
  }

  private issue(page: Page, code: SourceIssueCode, path?: string, line?: number): void {
    const rel = path ? relative(this.binding.root, path).split(sep).join("/") : undefined;
    const issue: SourceScanIssue = { code, ...(rel ? { pathId: sha256(rel), relativePath: safeLabel(rel) } : {}), ...(line !== undefined ? { line } : {}) };
    if (page.report.issues.length < 200 && !page.report.issues.some(item => stableJson(item) === stableJson(issue))) page.report.issues.push(issue);
  }

  private acceptFile(path: string): boolean {
    if (this.includes && !this.includes.ignores(path)) return false;
    const extension = extname(path).toLowerCase();
    if ([".md", ".mdx", ".txt"].includes(extension)) return this.binding.parser === "auto" || this.binding.parser === "markdown";
    if (extension === ".jsonl") return this.binding.parser !== "markdown";
    return [".json", ".log"].includes(extension) && !["markdown", "auto"].includes(this.binding.parser);
  }

  private async safeStat(path: string): Promise<Stats> {
    if (!within(this.binding.root, path) || this.outputs.some(output => within(output, path))) throw new Error("source path rejected");
    const rel = relative(this.binding.root, path);
    let current = this.binding.root;
    for (const part of ["", ...rel.split(sep).filter(Boolean)]) {
      current = part ? join(current, part) : current;
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error("source symlink rejected");
    }
    if (await realpath(path) !== resolve(path)) throw new Error("source path changed");
    return lstat(path);
  }

  private async safeOpen(path: string): Promise<FileHandle> {
    const before = await this.safeStat(path);
    if (!before.isFile()) throw new Error("source is not a regular file");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || !sameStat(before, info) || !sameStat(info, await this.safeStat(path))) throw new Error("source changed during open");
      return handle;
    } catch (error) { await handle.close(); throw error; }
  }

  private async directoryFrame(path: string, relativePath: string): Promise<DirectoryFrame> {
    const info = await this.safeStat(path);
    if (!info.isDirectory()) throw new Error("source directory changed");
    const dir = await opendir(path, { bufferSize: 1 });
    try {
      if (!sameStat(info, await this.safeStat(path))) throw new Error("source directory changed");
      return { dir, path, relativePath, info };
    } catch (error) { await dir.close(); throw error; }
  }

  private async finishDirectory(state: ScanState, page: Page): Promise<void> {
    const frame = state.frames.pop()!;
    await frame.dir.close();
    try {
      if (!sameStat(frame.info, await this.safeStat(frame.path))) { this.issue(page, "directory_changed", frame.path); state.uncertain = true; }
    } catch { this.issue(page, "directory_changed", frame.path); state.uncertain = true; }
  }

  private async openFile(path: string, state: ScanState): Promise<PendingFile> {
    const handle = await this.safeOpen(path);
    const info = await handle.stat();
    const rel = relative(this.binding.root, path).split(sep).join("/");
    const pathId = sha256(rel);
    const parser = [".md", ".mdx", ".txt"].includes(extname(path).toLowerCase()) ? "markdown" : this.binding.parser;
    const known = [...Object.values(this.manifest.files), ...state.observed.values()];
    const prior = this.manifest.files[pathId] ?? known.find(file => file.fileIdentity === identity(info));
    const canResume = parser !== "markdown" && prior && !prior.hasGap && prior.fileIdentity === identity(info) && prior.offset <= info.size;
    return {
      path, relativePath: safeLabel(rel), pathId, handle, info, prior,
      logicalFileId: prior?.logicalFileId ?? sha256(stableJson({ scope: this.scopeHash, source: this.binding.sourceId, identity: identity(info) })),
      parser: new SourceRecordParser(canResume ? prior.parser : parser, canResume ? prior.sessionKey : undefined),
      readHash: createHash("sha256"), boundaryHash: createHash("sha256"), readOffset: 0, offset: 0, line: 0,
      buffer: Buffer.alloc(0), skippingLongLine: false, lineStart: 0,
      prefixTarget: canResume ? prior.offset : 0, prefixVerified: !canResume || prior.offset === 0,
      gap: !!(canResume && prior.hasGap), eof: false, spans: { ...(prior?.spans ?? {}) }, seenSpans: new Set(), seenOverflow: false,
      replacedSpans: new Set(),
      replayStart: { offset: canResume ? prior.offset : 0, line: canResume ? prior.line : 0 },
      revisionChange: prior && parser !== "markdown" && (prior.fileIdentity !== identity(info) || info.size < prior.size) ? "rotation" : undefined,
    };
  }

  private async readFilePage(state: ScanState, page: Page): Promise<void> {
    const file = state.file!;
    const drafts: ParsedSpan[] = [];
    let done = false;
    let changed = false;
    try {
      if (!sameStat(file.info, await file.handle.stat()) || !sameStat(file.info, await this.safeStat(file.path))) throw new Error("changed");
      while (!page.stopped && !done) {
        if (this.stop(page)) break;
        if (page.report.usage.records >= page.limits.maxRecords) { this.issue(page, "max_records"); page.stopped = true; break; }
        if (!file.prefixVerified) {
          if (file.readOffset < file.prefixTarget) {
            if (!await this.readBytes(file, page, file.prefixTarget - file.readOffset, true)) break;
            continue;
          }
          if (file.readHash.copy().digest("hex") !== file.prior!.prefixHash) {
            file.revisionChange ??= "rewrite";
            file.readHash = createHash("sha256"); file.boundaryHash = createHash("sha256");
            file.readOffset = 0; file.offset = 0; file.line = 0; file.prefixTarget = 0;
            file.replayStart = { offset: 0, line: 0 };
            file.parser = new SourceRecordParser(this.binding.parser); file.gap = false;
          } else {
            if (file.info.size > file.prior!.size) file.revisionChange ??= "append";
            file.boundaryHash = file.readHash.copy(); file.offset = file.prefixTarget; file.lineStart = file.offset; file.line = file.prior!.line;
          }
          file.prefixVerified = true;
          continue;
        }
        const newline = file.buffer.indexOf(10);
        if (newline >= 0) {
          const raw = file.buffer.subarray(0, newline + 1);
          file.buffer = file.buffer.subarray(newline + 1);
          const start = file.lineStart;
          file.boundaryHash.update(raw);
          file.offset += raw.length;
          file.line++;
          const oversized = file.skippingLongLine || raw.length > page.limits.maxRecordBytes;
          file.skippingLongLine = false;
          file.lineStart = file.offset;
          if (oversized) {
            file.parser.discardRecord();
            this.collect(file, { counted: true, issue: "record_too_large" }, drafts, state, page);
          }
          else this.collect(file, file.parser.consume(raw.toString("utf8").replace(/\r?\n$/, ""), start, file.offset, file.line, page.limits), drafts, state, page);
          continue;
        }
        if (file.readOffset >= file.info.size) {
          if (file.buffer.length || file.skippingLongLine) {
            if (file.parser.parser !== "markdown") {
              this.issue(page, "incomplete_line", file.path, file.line + 1);
              state.uncertain = true;
            } else {
              const raw = file.buffer;
              file.boundaryHash.update(raw); file.offset += raw.length; file.line++;
              if (file.skippingLongLine) {
                file.parser.discardRecord();
                this.collect(file, { counted: true, issue: "record_too_large" }, drafts, state, page);
              }
              else this.collect(file, file.parser.consume(raw.toString("utf8"), file.lineStart, file.offset, file.line, page.limits), drafts, state, page);
              file.buffer = Buffer.alloc(0); file.lineStart = file.offset;
            }
          }
          if (file.parser.parser === "markdown") {
            if (page.report.usage.records >= page.limits.maxRecords) { this.issue(page, "max_records"); page.stopped = true; break; }
            const final = file.parser.finish(page.limits);
            this.collect(file, final, drafts, state, page);
            if (!final.finished) continue;
          }
          done = true;
          file.eof = true;
          break;
        }
        if (file.buffer.length > page.limits.maxRecordBytes) {
          file.boundaryHash.update(file.buffer); file.offset += file.buffer.length;
          file.buffer = Buffer.alloc(0); file.skippingLongLine = true;
        }
        if (!await this.readBytes(file, page, file.info.size - file.readOffset, false)) break;
      }
      if (!sameStat(file.info, await file.handle.stat()) || !sameStat(file.info, await this.safeStat(file.path))) throw new Error("changed");
    } catch {
      changed = true;
      state.uncertain = true;
      this.issue(page, "source_changed", file.path);
    }
    if (changed) {
      await file.handle.close(); state.file = undefined; return;
    }
    const contentHash = file.readHash.copy().digest("hex");
    if (file.gap) state.uncertain = true;
    const complete = done && file.offset === file.info.size && !file.gap;
    const comparable = [...Object.values(this.manifest.files), ...state.observed.values()];
    const alias = file.readOffset === file.info.size ? comparable.find(other => other.pathId !== file.pathId && other.hashBytes === other.size && other.contentHash === contentHash) : undefined;
    if (alias) {
      file.logicalFileId = alias.logicalFileId;
      for (const [id, hash] of Object.entries(alias.spans)) if (!(id in file.spans)) file.spans[id] = hash;
    }
    const revisionId = sha256(stableJson({ logicalFileId: file.logicalFileId, contentHash, hashBytes: file.readOffset }));
    const snapshot: SourceSnapshotFile = { pathId: file.pathId, relativePath: file.relativePath, fileIdentity: identity(file.info), logicalFileId: file.logicalFileId,
      revisionId, contentHash, hashBytes: file.readOffset, size: file.info.size, mtimeMs: file.info.mtimeMs, ctimeMs: file.info.ctimeMs };
    page.report.snapshot.files.push(snapshot);
    for (const span of drafts) {
      if (alias?.spans[span.spanOrEventId] === span.contentHash) continue;
      const record = this.sourceRecord(span, snapshot, file.parser.parser, this.semantics(file));
      const relativePath = relative(this.binding.root, file.path).split(sep).join("/");
      if (safeRelativeSourcePath(relativePath)) {
        record.locator = {
          version: 1, sourceId: this.binding.sourceId, configFingerprint: this.configFingerprint, relativePath,
          snapshot: structuredClone(snapshot), snapshotHash: snapshotHash(this.binding.sourceId, this.configFingerprint, [snapshot]),
          record: recordCheckpoint(record),
          parsing: { maxRecordBytes: page.limits.maxRecordBytes, maxSnippetChars: page.limits.maxSnippetChars, maxContextChars: page.limits.maxContextChars },
          replayStart: { ...file.replayStart },
        };
      }
      page.report.records.push(record);
    }
    const old = file.prior ?? alias;
    const removedSpanIds = complete && file.parser.parser === "markdown" && !file.seenOverflow
      ? Object.keys(old?.spans ?? {}).filter(id => !file.seenSpans.has(id)) : [];
    const change: SourceFileChange = { pathId: file.pathId, relativePath: file.relativePath, logicalFileId: file.logicalFileId,
      status: !complete ? "partial" : alias || old?.pathId !== undefined && old.pathId !== file.pathId ? "alias" : !old ? "new" : old.contentHash === contentHash ? "unchanged" : "changed",
      previousRevisionId: old?.revisionId, revisionId, removedSpanIds };
    change.semantics = this.semantics(file);
    if (file.revisionChange) change.revisionChange = file.revisionChange;
    if (file.replacedSpans.size) change.replacedSpanIds = [...file.replacedSpans].sort();
    page.report.files.push(change);
    const remembered = Object.entries(file.spans).slice(-MAX_TRACKED_SPANS);
    const update: ManifestFile = {
      pathId: file.pathId, relativePath: file.relativePath, fileIdentity: identity(file.info), logicalFileId: file.logicalFileId,
      contentHash, hashBytes: file.readOffset, size: file.info.size, mtimeMs: file.info.mtimeMs, revisionId,
      parser: file.parser.parser, semantics: this.semantics(file),
      // Never checkpoint the middle of an oversized or incomplete record.
      offset: file.skippingLongLine ? file.lineStart : file.offset,
      prefixHash: file.boundaryHash.copy().digest("hex"), line: file.line, sessionKey: file.parser.sessionKey,
      complete, hasGap: file.gap, spans: Object.fromEntries(remembered),
    };
    if (file.skippingLongLine) { update.offset = 0; update.line = 0; update.prefixHash = sha256(""); update.sessionKey = undefined; }
    // Complete-file removals are committed with this page, never deferred to a later enumeration.
    for (const spanId of removedSpanIds) delete update.spans[spanId];
    if (file.prefixVerified) page.updates.push(update);
    state.observed.set(file.pathId, update);
    state.logicalSeen.add(file.logicalFileId);
    if (done) { await file.handle.close(); state.file = undefined; }
  }

  private semantics(file: PendingFile): SourceSemantics {
    return this.binding.semantics ?? (file.parser.parser === "markdown" ? "current_document" : file.parser.parser === "auto" ? file.prior?.semantics ?? "reference_snapshot" : "append_history");
  }

  private sourceRecord(span: ParsedSpan, snapshot: SourceSnapshotFile, parser: SourceParser, semantics?: SourceSemantics): SourceRecord {
    const rootEvidenceId = sha256(stableJson({ scope: this.scopeHash, quote: span.quote.normalize("NFC").replace(/\s+/g, " ").trim() }));
    return { ...span, id: sha256(stableJson({ scope: this.scopeHash, sourceId: this.binding.sourceId, event: span.spanOrEventId, contentHash: span.contentHash })),
      sourceId: this.binding.sourceId, scope: { ...this.binding.scope }, pathId: snapshot.pathId, relativePath: snapshot.relativePath,
      logicalFileId: snapshot.logicalFileId, revisionId: snapshot.revisionId, rootEvidenceId, independenceGroupId: rootEvidenceId,
      parser: parser === "auto" ? "codex-jsonl" : parser,
      semantics: semantics ?? this.binding.semantics ?? (parser === "markdown" ? "current_document" : parser === "auto" ? "reference_snapshot" : "append_history"), authority: "host_binding_only" };
  }

  private collect(file: PendingFile, parsed: ParseResult, drafts: ParsedSpan[], state: ScanState, page: Page): void {
    if (parsed.counted) page.report.usage.records++;
    if (parsed.issue) { file.gap = true; state.uncertain = true; this.issue(page, parsed.issue, file.path, file.line); }
    const span = parsed.span;
    if (!span) return;
    if (file.seenSpans.size < MAX_TRACKED_SPANS) file.seenSpans.add(span.spanOrEventId);
    else file.seenOverflow = true;
    const committed = this.manifest.files[file.pathId]?.spans[span.spanOrEventId] ?? file.prior?.spans[span.spanOrEventId];
    if (committed && committed !== span.contentHash && file.replacedSpans.size < MAX_TRACKED_SPANS) file.replacedSpans.add(span.spanOrEventId);
    if (committed !== span.contentHash && !drafts.some(draft => draft.spanOrEventId === span.spanOrEventId && draft.contentHash === span.contentHash)) drafts.push(span);
    file.spans[span.spanOrEventId] = span.contentHash;
    const keys = Object.keys(file.spans);
    if (keys.length > MAX_TRACKED_SPANS) delete file.spans[keys[0]];
  }

  private async readBytes(file: PendingFile, page: Page, remaining: number, prefix: boolean): Promise<boolean> {
    const available = page.limits.maxBytes - page.report.usage.bytes;
    if (available <= 0) { this.issue(page, "max_bytes"); page.stopped = true; return false; }
    const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, remaining, available));
    const result = await file.handle.read(buffer, 0, buffer.length, file.readOffset);
    if (!result.bytesRead) throw new Error("source changed while reading");
    page.report.usage.bytes += result.bytesRead;
    file.readOffset += result.bytesRead;
    const bytes = buffer.subarray(0, result.bytesRead);
    file.readHash.update(bytes);
    if (!prefix) file.buffer = file.buffer.length ? Buffer.concat([file.buffer, bytes]) : bytes;
    return true;
  }

  private async closeState(state: ScanState): Promise<void> {
    if (state.file) { await state.file.handle.close(); state.file = undefined; }
    for (const frame of state.frames.splice(0)) await frame.dir.close();
  }
}
