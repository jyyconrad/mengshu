/**
 * Track E wiki entry files: `pages/<slug>/<entries>/<semanticType>/<id>.md`.
 *
 * The database stays the record of record. This writer does not open a
 * transaction, does not update INDEX or completion, and does not create or
 * edit `page-*.md` or `.sources`. `wikiPath` is relative to the wiki root
 * and uses forward slashes. A thrown write leaves any committed memory in
 * place; callers must not roll that memory back.
 */

import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  parseWikiConfig,
  resolveWikiMarkdownPath,
  type ResolvedWikiMarkdownPath,
  WikiPathError,
} from "./root.js";

const WIKI_ENTRY_SEMANTIC_TYPES = [
  "profile",
  "task_context",
  "rules",
  "experience",
  "resource",
  "unclassified",
] as const;

const ADMISSION_ROUTES = new Set([
  "drop",
  "candidate_low_priority",
  "candidate",
  "active",
  "lookup_only",
  "evidence_only",
]);

const SLUG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const ENTRY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const YAML_PLAIN = /^[A-Za-z0-9_][A-Za-z0-9_.:/+-]{0,1023}$/;
const MAX_REGISTRY_BYTES = 2 * 1024 * 1024;
const HEADING_LIMIT = 120;

export type WikiEntryKind = "memory" | "knowledge";
export type WikiEntrySemanticType = (typeof WIKI_ENTRY_SEMANTIC_TYPES)[number];

export type EntryWriteErrorCode =
  | "ENTRY_INPUT_INVALID"
  | "ENTRY_PROTECTED_PATH"
  | "ENTRY_WRITE_FAILED";

export class EntryWriteError extends Error {
  readonly code: EntryWriteErrorCode;

  constructor(code: EntryWriteErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EntryWriteError";
    this.code = code;
  }
}

export interface WikiEntryWriteInput {
  readonly id: string;
  /** Record table, not MemoryKind. */
  readonly kind: WikiEntryKind;
  /** Missing or `__unscoped__` uses the `__unscoped__` slug. */
  readonly scopeKey?: string | null;
  /** Missing or unknown values use `unclassified`. */
  readonly semanticType?: string | null;
  readonly text: string;
  readonly title?: string | null;
  readonly updatedAt?: string | Date | null;
  readonly source?: string | null;
  /** Whitelisted admission route. Any other non-empty value is rejected. */
  readonly admissionRoute?: string | null;
  /**
   * Previous relative `metadata.wikiPath`. Fused `page-*.md` values are
   * ignored. `.sources` is never opened.
   */
  readonly previousWikiPath?: string | null;
}

export interface WikiEntryWriteResult {
  /** Relative to wikiRoot. Safe to store as `metadata.wikiPath`. */
  readonly wikiPath: string;
  readonly wikiTrack: "entry";
  /** Track E paths removed after the new file was published. */
  readonly movedFrom: readonly string[];
}

export interface EntryWriterOptions {
  /** Absolute wiki root, or a `~` path expanded with `home`. */
  readonly root: string;
  readonly home?: string;
  readonly entriesDirName?: string;
  /** Used when `updatedAt` is omitted. */
  readonly now?: () => Date;
  /** Runs after the temp file is durable and before rename. */
  readonly beforeRename?: () => void | Promise<void>;
}

interface RegistryIndex {
  readonly byKey: ReadonlyMap<string, string>;
  readonly slugs: ReadonlySet<string>;
}

interface LocatedEntry {
  readonly wikiPath: string;
  readonly absolutePath: string;
}

interface PlannedEntry {
  readonly id: string;
  readonly kind: WikiEntryKind;
  readonly scopeKey: string;
  readonly semanticType: WikiEntrySemanticType;
  readonly text: string;
  readonly updatedAt: string;
  readonly source?: string;
  readonly admissionRoute?: string;
  readonly title?: string | null;
  readonly destination: ResolvedWikiMarkdownPath;
}

const EMPTY_REGISTRY: RegistryIndex = { byKey: new Map(), slugs: new Set() };

/**
 * Writes one Track E markdown mirror. Constructing the writer does not
 * create directories and does not read or write the database.
 */
export class EntryWriter {
  private readonly root: string;
  private readonly entriesDirName: string;
  private readonly home: string | undefined;
  private readonly now: () => Date;
  private readonly beforeRename: (() => void | Promise<void>) | undefined;

  constructor(options: EntryWriterOptions) {
    if (!options || typeof options.root !== "string") {
      throw new EntryWriteError("ENTRY_INPUT_INVALID", "wiki root is required");
    }
    const config = parseWikiConfig(
      options.entriesDirName === undefined
        ? { root: options.root }
        : { root: options.root, entriesDirName: options.entriesDirName },
      { home: options.home },
    );
    this.root = config.root;
    this.entriesDirName = config.entriesDirName;
    this.home = options.home;
    this.now = options.now ?? (() => new Date());
    this.beforeRename = options.beforeRename;
  }

  /**
   * Relative Track E path for `input`. Does not create directories or files.
   */
  targetWikiPath(input: WikiEntryWriteInput): string {
    return this.prepare(input).destination.wikiPath;
  }

  async write(input: WikiEntryWriteInput): Promise<WikiEntryWriteResult> {
    const planned = this.prepare(input);
    try {
      const existing = await this.locateCopies(planned.id, input.previousWikiPath);
      const markdown = renderEntry({
        id: planned.id,
        kind: planned.kind,
        scopeKey: planned.scopeKey,
        semanticType: planned.semanticType,
        updatedAt: planned.updatedAt,
        wikiPath: planned.destination.wikiPath,
        heading: headingFor(planned.title, planned.text, planned.id),
        text: planned.text,
        source: planned.source,
        admissionRoute: planned.admissionRoute,
      });
      await this.publish(planned.destination, markdown);
      const movedFrom: string[] = [];
      for (const copy of existing) {
        if (copy.wikiPath === planned.destination.wikiPath) continue;
        if (await this.removeCopy(copy)) movedFrom.push(copy.wikiPath);
      }
      movedFrom.sort();
      return { wikiPath: planned.destination.wikiPath, wikiTrack: "entry", movedFrom };
    } catch (error) {
      throw asWriteError(error);
    }
  }

  private prepare(input: WikiEntryWriteInput): PlannedEntry {
    const id = requireEntryId(input.id);
    const kind = requireKind(input.kind);
    const scopeKey = normalizeScopeKey(input.scopeKey);
    const semanticType = resolveSemanticType(input.semanticType);
    const text = requireText(input.text);
    const updatedAt = resolveUpdatedAt(input.updatedAt, this.now);
    const source = optionalMetaLine(input.source, "source");
    const admissionRoute = optionalAdmissionRoute(input.admissionRoute);
    const registry = readScopeRegistry(this.root);
    const slug = resolveScopeSlug(scopeKey, registry);
    const wikiPath = `pages/${slug}/${this.entriesDirName}/${semanticType}/${id}.md`;
    assertEntryTarget(wikiPath, this.entriesDirName, id);
    return {
      id,
      kind,
      scopeKey: scopeKey ?? "__unscoped__",
      semanticType,
      text,
      updatedAt,
      source,
      admissionRoute,
      title: input.title,
      destination: this.resolveEntry(wikiPath),
    };
  }

  private resolveEntry(wikiPath: string): ResolvedWikiMarkdownPath {
    const resolved = resolveWikiMarkdownPath(this.root, wikiPath, { home: this.home });
    assertEntryTarget(resolved.wikiPath, this.entriesDirName, basename(resolved.wikiPath, ".md"));
    if (resolved.wikiPath !== wikiPath) {
      throw new EntryWriteError("ENTRY_PROTECTED_PATH", "wiki entry path escaped the Track E layout");
    }
    return resolved;
  }

  /**
   * Stats only `pages/<slug>/<entries>/<type>/<id>.md`. Does not read fused pages.
   */
  private async locateCopies(id: string, previousWikiPath: string | null | undefined): Promise<LocatedEntry[]> {
    const found = new Map<string, LocatedEntry>();
    const hinted = this.hintedCopy(id, previousWikiPath);
    if (hinted) found.set(hinted.wikiPath, hinted);

    let dirents;
    try {
      const pagesStat = await lstat(join(this.root, "pages"));
      if (pagesStat.isSymbolicLink() || !pagesStat.isDirectory()) return [...found.values()];
      dirents = await readdir(join(this.root, "pages"), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [...found.values()];
      throw error;
    }

    for (const dirent of dirents) {
      if (!dirent.isDirectory() || !isSafeSlug(dirent.name)) continue;
      const entriesPath = join(this.root, "pages", dirent.name, this.entriesDirName);
      const entriesStat = await lstatIfExists(entriesPath);
      if (!entriesStat) continue;
      if (entriesStat.isSymbolicLink()) {
        throw new WikiPathError("WIKI_PATH_SYMLINK", "wiki entry path rejects symbolic links");
      }
      if (!entriesStat.isDirectory()) {
        throw new WikiPathError("WIKI_PATH_INVALID", "wiki entries path is not a directory");
      }
      for (const semanticType of WIKI_ENTRY_SEMANTIC_TYPES) {
        const wikiPath = `pages/${dirent.name}/${this.entriesDirName}/${semanticType}/${id}.md`;
        const stat = await lstatIfExists(join(entriesPath, semanticType, `${id}.md`));
        if (!stat) continue;
        if (stat.isSymbolicLink()) {
          throw new WikiPathError("WIKI_PATH_SYMLINK", "wiki entry path rejects symbolic links");
        }
        if (!stat.isFile()) {
          throw new WikiPathError("WIKI_PATH_NOT_FILE", "wiki entry path must be a markdown file");
        }
        const resolved = this.resolveEntry(wikiPath);
        found.set(resolved.wikiPath, { wikiPath: resolved.wikiPath, absolutePath: resolved.absolutePath });
      }
    }
    return [...found.values()];
  }

  private hintedCopy(id: string, previousWikiPath: string | null | undefined): LocatedEntry | undefined {
    if (typeof previousWikiPath !== "string" || previousWikiPath.length === 0) return undefined;
    if (isProtectedWikiPath(previousWikiPath) || !previousWikiPath.endsWith(".md")) return undefined;
    let resolved: ResolvedWikiMarkdownPath;
    try {
      resolved = resolveWikiMarkdownPath(this.root, previousWikiPath, { home: this.home });
    } catch (error) {
      if (error instanceof WikiPathError && (
        error.code === "WIKI_PATH_TRAVERSAL" ||
        error.code === "WIKI_PATH_ESCAPE" ||
        error.code === "WIKI_PATH_SYMLINK"
      )) {
        throw error;
      }
      return undefined;
    }
    if (!isTrackEntryPath(resolved.wikiPath, this.entriesDirName, id)) return undefined;
    return { wikiPath: resolved.wikiPath, absolutePath: resolved.absolutePath };
  }

  private async publish(destination: ResolvedWikiMarkdownPath, markdown: string): Promise<void> {
    const parent = dirname(destination.absolutePath);
    await mkdir(parent, { recursive: true });
    this.resolveEntry(destination.wikiPath);
    if (basename(destination.absolutePath) !== basename(destination.wikiPath)) {
      throw new EntryWriteError("ENTRY_PROTECTED_PATH", "wiki entry target is not the Track E file");
    }
    await atomicWriteFile(destination.absolutePath, markdown, this.beforeRename);
  }

  private async removeCopy(copy: LocatedEntry): Promise<boolean> {
    assertEntryTarget(copy.wikiPath, this.entriesDirName, basename(copy.wikiPath, ".md"));
    const resolved = this.resolveEntry(copy.wikiPath);
    const stat = await lstatIfExists(resolved.absolutePath);
    if (!stat) return false;
    if (stat.isSymbolicLink()) {
      throw new WikiPathError("WIKI_PATH_SYMLINK", "wiki entry path rejects symbolic links");
    }
    if (!stat.isFile()) {
      throw new WikiPathError("WIKI_PATH_NOT_FILE", "wiki entry path must be a markdown file");
    }
    await rm(resolved.absolutePath);
    return true;
  }
}

function requireEntryId(value: unknown): string {
  if (typeof value !== "string" || !ENTRY_ID_RE.test(value) || value.includes("..")) {
    throw new EntryWriteError("ENTRY_INPUT_INVALID", "wiki entry id is not a safe file name");
  }
  if (/^page-/i.test(value) || value.includes(".sources")) {
    throw new EntryWriteError(
      "ENTRY_PROTECTED_PATH",
      "wiki entry id must not address a fused page or .sources file",
    );
  }
  return value;
}

function requireKind(value: unknown): WikiEntryKind {
  if (value !== "memory" && value !== "knowledge") {
    throw new EntryWriteError("ENTRY_INPUT_INVALID", "wiki entry kind must be memory or knowledge");
  }
  return value;
}

function normalizeScopeKey(value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new EntryWriteError("ENTRY_INPUT_INVALID", "scopeKey must be a string");
  }
  if (
    value !== value.trim() ||
    value.length > 512 ||
    value !== value.normalize("NFC") ||
    /\p{Cc}/u.test(value) ||
    value.includes("/") ||
    value.includes("\\") ||
    value.split(":").includes("..") ||
    value.split(":").includes(".")
  ) {
    throw new EntryWriteError("ENTRY_INPUT_INVALID", "scopeKey is not a safe scope key");
  }
  return value === "__unscoped__" ? undefined : value;
}

function resolveSemanticType(value: unknown): WikiEntrySemanticType {
  if (value == null || value === "") return "unclassified";
  if (typeof value === "string" && isSemanticType(value)) return value;
  if (typeof value !== "string") {
    throw new EntryWriteError("ENTRY_INPUT_INVALID", "semanticType must be a string");
  }
  return "unclassified";
}

function isSemanticType(value: string): value is WikiEntrySemanticType {
  return (WIKI_ENTRY_SEMANTIC_TYPES as readonly string[]).includes(value);
}

function requireText(value: unknown): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new EntryWriteError("ENTRY_INPUT_INVALID", "wiki entry text must be a string");
  }
  return value;
}

function resolveUpdatedAt(value: string | Date | null | undefined, now: () => Date): string {
  const date = value == null || value === ""
    ? now()
    : value instanceof Date
      ? value
      : typeof value === "string"
        ? new Date(value)
        : undefined;
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new EntryWriteError("ENTRY_INPUT_INVALID", "updatedAt must be an ISO-8601 timestamp");
  }
  return date.toISOString();
}

function optionalMetaLine(value: unknown, field: string): string | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new EntryWriteError("ENTRY_INPUT_INVALID", `${field} must be a string`);
  }
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return undefined;
  if (collapsed.length > 300 || /\p{Cc}/u.test(collapsed)) {
    throw new EntryWriteError("ENTRY_INPUT_INVALID", `${field} is not a single safe line`);
  }
  return collapsed;
}

function optionalAdmissionRoute(value: unknown): string | undefined {
  const line = optionalMetaLine(value, "admissionRoute");
  if (line === undefined) return undefined;
  if (!ADMISSION_ROUTES.has(line)) {
    throw new EntryWriteError("ENTRY_INPUT_INVALID", "admissionRoute is not a whitelisted route");
  }
  return line;
}

function readScopeRegistry(root: string): RegistryIndex {
  const path = join(root, "scope-registry.json");
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_REGISTRY;
    throw new EntryWriteError(
      "ENTRY_WRITE_FAILED",
      "wiki scope registry could not be read; a committed memory must not be rolled back",
      { cause: error },
    );
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_REGISTRY_BYTES) return EMPTY_REGISTRY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return EMPTY_REGISTRY;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return EMPTY_REGISTRY;
  const scopes = (parsed as { scopes?: unknown }).scopes;
  if (!Array.isArray(scopes)) return EMPTY_REGISTRY;
  const byKey = new Map<string, string>();
  const slugs = new Set<string>();
  for (const item of scopes) {
    if (!item || typeof item !== "object") continue;
    const scopeKey = (item as { scopeKey?: unknown }).scopeKey;
    const slug = (item as { slug?: unknown }).slug;
    if (typeof scopeKey !== "string" || typeof slug !== "string") continue;
    if (!isSafeSlug(slug) || byKey.has(scopeKey)) continue;
    if (scopeKey.length === 0 || scopeKey.length > 512 || /\p{Cc}/u.test(scopeKey)) continue;
    byKey.set(scopeKey, slug);
    slugs.add(slug);
  }
  return { byKey, slugs };
}

function resolveScopeSlug(scopeKey: string | undefined, registry: RegistryIndex): string {
  if (scopeKey === undefined) return "__unscoped__";
  const mapped = registry.byKey.get(scopeKey);
  if (mapped) return mapped;
  const base = slugifyScopeKey(scopeKey);
  if (!registry.slugs.has(base)) return base;
  const tail = slugifyToken(scopeKey.split(":").at(-1) ?? "");
  if (tail && tail !== base) {
    const disambiguated = `${base}-${tail}`;
    if (isSafeSlug(disambiguated) && !registry.slugs.has(disambiguated)) return disambiguated;
  }
  const hash = shortHash(scopeKey, 8);
  const hashed = `${trimSlug(base, 80)}-${hash}`;
  if (isSafeSlug(hashed) && !registry.slugs.has(hashed)) return hashed;
  return `scope-${hash}`;
}

function scopeWorkspaceSegment(scopeKey: string): string {
  const segments = scopeKey.split(":");
  return segments.length >= 6 ? (segments[3] ?? scopeKey) : scopeKey;
}

function slugifyScopeKey(scopeKey: string): string {
  const segment = scopeWorkspaceSegment(scopeKey);
  if (isSafeSlug(segment)) return segment;
  const folded = slugifyToken(segment);
  if (folded) return folded;
  return `scope-${shortHash(scopeKey, 12)}`;
}

function slugifyToken(value: string): string | undefined {
  if (isSafeSlug(value)) return value;
  const folded = value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .replace(/-+/g, "-");
  const clipped = folded.slice(0, 80).replace(/[._-]+$/g, "");
  return isSafeSlug(clipped) ? clipped : undefined;
}

function trimSlug(value: string, length: number): string {
  return value.slice(0, length).replace(/[._-]+$/g, "");
}

function shortHash(value: string, length: number): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, length);
}

function isSafeSlug(value: string): boolean {
  return SLUG_RE.test(value) && !value.includes("..") && !isProtectedSegment(value);
}

function isProtectedSegment(segment: string): boolean {
  return /^page-.*\.md$/i.test(segment) || segment === ".sources" || segment.endsWith(".sources");
}

function isProtectedWikiPath(wikiPath: string): boolean {
  return wikiPath.split("/").some((segment) => isProtectedSegment(segment));
}

function isTrackEntryPath(wikiPath: string, entriesDirName: string, id: string): boolean {
  const parts = wikiPath.split("/");
  return parts.length === 5 &&
    parts[0] === "pages" &&
    isSafeSlug(parts[1] ?? "") &&
    parts[2] === entriesDirName &&
    isSemanticType(parts[3] ?? "") &&
    parts[4] === `${id}.md` &&
    !isProtectedWikiPath(wikiPath);
}

function assertEntryTarget(wikiPath: string, entriesDirName: string, id: string): void {
  if (!isTrackEntryPath(wikiPath, entriesDirName, id) || isProtectedWikiPath(wikiPath)) {
    throw new EntryWriteError(
      "ENTRY_PROTECTED_PATH",
      "wiki entry writer refuses page-*.md and .sources paths",
    );
  }
}

function headingFor(title: string | null | undefined, text: string, id: string): string {
  const preferred = typeof title === "string" ? title : "";
  const source = preferred.trim().length > 0
    ? preferred
    : (text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "");
  const collapsed = source
    .replace(/[\p{Cc}\u2028\u2029]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^#+\s*/, "");
  if (collapsed.length === 0) return id;
  return collapsed.length > HEADING_LIMIT ? `${collapsed.slice(0, HEADING_LIMIT - 3)}...` : collapsed;
}

function yamlScalar(value: string): string {
  if (YAML_PLAIN.test(value) && !value.includes("..")) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
}

function renderEntry(input: {
  readonly id: string;
  readonly kind: WikiEntryKind;
  readonly scopeKey: string;
  readonly semanticType: WikiEntrySemanticType;
  readonly updatedAt: string;
  readonly wikiPath: string;
  readonly heading: string;
  readonly text: string;
  readonly source?: string;
  readonly admissionRoute?: string;
}): string {
  const frontmatter = [
    "---",
    `id: ${yamlScalar(input.id)}`,
    `kind: ${yamlScalar(input.kind)}`,
    `scope_key: ${yamlScalar(input.scopeKey)}`,
    `semantic_type: ${yamlScalar(input.semanticType)}`,
    `updated_at: ${yamlScalar(input.updatedAt)}`,
    `wiki_path: ${yamlScalar(input.wikiPath)}`,
    "track: entry",
    "---",
  ].join("\n");
  let markdown = `${frontmatter}\n\n# ${input.heading}\n\n${input.text}`;
  if (!markdown.endsWith("\n")) markdown += "\n";
  const meta: string[] = [];
  if (input.source) meta.push(`- source: ${input.source}`);
  if (input.admissionRoute) meta.push(`- admissionRoute: ${input.admissionRoute}`);
  if (meta.length > 0) markdown += `\n## Meta\n\n${meta.join("\n")}\n`;
  return markdown;
}

async function atomicWriteFile(
  absolutePath: string,
  markdown: string,
  beforeRename: (() => void | Promise<void>) | undefined,
): Promise<void> {
  const directory = dirname(absolutePath);
  const tmp = join(directory, `.${basename(absolutePath)}.tmp-${process.pid}-${randomUUID()}`);
  let published = false;
  try {
    const handle = await open(tmp, "wx", 0o644);
    try {
      await handle.writeFile(markdown, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (beforeRename) await beforeRename();
    if (isProtectedSegment(basename(absolutePath)) || absolutePath.endsWith(".sources")) {
      throw new EntryWriteError("ENTRY_PROTECTED_PATH", "refusing to publish a fused wiki file");
    }
    await rename(tmp, absolutePath);
    published = true;
    await syncDirectory(directory);
  } catch (error) {
    if (!published) await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const dir = await open(directory, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch {
    // Rename already published the entry. A directory fsync failure must not
    // discard that file or look like a database rollback.
  }
}

async function lstatIfExists(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function asWriteError(error: unknown): Error {
  if (error instanceof EntryWriteError || error instanceof WikiPathError) return error;
  return new EntryWriteError(
    "ENTRY_WRITE_FAILED",
    "wiki entry file write failed; a committed memory must not be rolled back",
    { cause: error },
  );
}
