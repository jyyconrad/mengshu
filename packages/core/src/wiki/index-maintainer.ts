/**
 * Track E ancestor index maintenance.
 *
 * One entry path refreshes only its L3 type INDEX, L2 entries INDEX,
 * L1 `pages/<slug>/INDEX.md`, and the L0 `## Entries` section of
 * `<wikiRoot>/INDEX.md`. Rows are re-derived from directory listings
 * (stable sort), so a second run and `reindexEntries()` match.
 *
 * Fused totals in the root INDEX stay byte-for-byte. `page-*.md` bodies
 * are not read; an L1 fused count is a filename total for that slug only.
 * This module does not write entry files, completion, or the database.
 * A failed index write must not roll back a committed memory.
 */

import { randomBytes } from "node:crypto";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { parseFrontMatter } from "../ingest/front-matter.js";
import {
  parseWikiConfig,
  resolveWikiMarkdownPath,
  WikiPathError,
  type WikiPathOptions,
} from "./root.js";

const PAGES_DIR = "pages";
const INDEX_FILE = "INDEX.md";
const ENTRY_SECTION_START = "<!-- mengshu-entries:start -->";
const ENTRY_SECTION_END = "<!-- mengshu-entries:end -->";

/** Canonical order, not locale or readdir order. */
const ENTRY_SEMANTIC_TYPES = [
  "profile",
  "task_context",
  "rules",
  "experience",
  "resource",
  "unclassified",
] as const;

const SEMANTIC_TYPE_SET = new Set<string>(ENTRY_SEMANTIC_TYPES);
const SLUG_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/;
const ENTRY_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.md$/;
const FUSED_PAGE_NAME = /^page-.+\.md$/;

export interface IndexMaintainerOptions extends WikiPathOptions {
  /** Absolute wiki root, or `~` expanded with `home`. */
  root: string;
  /** Single path segment under `pages/<slug>/`. Default `entries`. */
  entriesDirName?: string;
}

export interface WikiIndexWrite {
  /** Forward-slash path relative to the wiki root. */
  wikiPath: string;
  changed: boolean;
}

interface LocatedEntry {
  slug: string;
  semanticType: string;
}

interface TypeCount {
  semanticType: string;
  count: number;
  indexWikiPath: string;
}

interface EntryListing {
  total: number;
  types: TypeCount[];
}

interface EntryRow {
  id: string;
  title: string;
  wikiPath: string;
  updatedAt: string;
}

interface SlugCount {
  slug: string;
  scopeKey: string;
  entries: number;
  indexWikiPath: string;
}

type PathKind = "missing" | "symlink" | "dir" | "file" | "other";

export class IndexMaintainer {
  readonly root: string;
  readonly entriesDirName: string;

  constructor(options: IndexMaintainerOptions) {
    const parsed = parseWikiConfig({
      root: options.root,
      ...(options.entriesDirName !== undefined ? { entriesDirName: options.entriesDirName } : {}),
    }, options);
    this.root = parsed.root;
    this.entriesDirName = parsed.entriesDirName;
  }

  /**
   * Refresh the ancestor indexes of one Track E file.
   * `entryPath` is a wiki-relative or in-root absolute `.md` path.
   * The entry file may already be gone (delete); it is never created or removed here.
   */
  touchAncestors(entryPath: string): WikiIndexWrite[] {
    this.assertWikiRoot();
    const entry = this.locateEntry(entryPath);
    const writes: WikiIndexWrite[] = [];
    const typeDir = this.absolute(PAGES_DIR, entry.slug, this.entriesDirName, entry.semanticType);
    if (this.pathKind(typeDir) === "dir") {
      writes.push(this.writeGenerated(
        `${this.typeWiki(entry.slug, entry.semanticType)}/${INDEX_FILE}`,
        renderTypeIndex(entry.semanticType, this.entryRows(entry.slug, entry.semanticType)),
      ));
    }
    const entriesDir = this.absolute(PAGES_DIR, entry.slug, this.entriesDirName);
    if (this.pathKind(entriesDir) === "dir") {
      const listing = this.listEntries(entry.slug);
      writes.push(this.writeGenerated(
        `pages/${entry.slug}/${this.entriesDirName}/${INDEX_FILE}`,
        renderEntriesIndex(entry.slug, listing.types),
      ));
    }
    const slugDir = this.absolute(PAGES_DIR, entry.slug);
    if (this.pathKind(slugDir) === "dir") {
      writes.push(this.writeGenerated(
        `pages/${entry.slug}/${INDEX_FILE}`,
        renderSlugIndex({
          slug: entry.slug,
          scopeKey: this.scopeKey(entry.slug),
          entriesDirName: this.entriesDirName,
          fusedPages: this.countFusedPageNames(entry.slug),
          entries: this.listEntries(entry.slug),
        }),
      ));
    }
    writes.push(this.writeRootEntries());
    return writes;
  }

  /**
   * Rebuild every Track E index and the root Entries section.
   * Slugs without an entries directory are left alone. Fused totals are not recomputed.
   */
  reindexEntries(): WikiIndexWrite[] {
    this.assertWikiRoot();
    const writes: WikiIndexWrite[] = [];
    for (const slug of this.listEntrySlugs()) {
      const listing = this.listEntries(slug);
      for (const type of listing.types) {
        writes.push(this.writeGenerated(
          type.indexWikiPath,
          renderTypeIndex(type.semanticType, this.entryRows(slug, type.semanticType)),
        ));
      }
      writes.push(this.writeGenerated(
        `pages/${slug}/${this.entriesDirName}/${INDEX_FILE}`,
        renderEntriesIndex(slug, listing.types),
      ));
      writes.push(this.writeGenerated(
        `pages/${slug}/${INDEX_FILE}`,
        renderSlugIndex({
          slug,
          scopeKey: this.scopeKey(slug),
          entriesDirName: this.entriesDirName,
          fusedPages: this.countFusedPageNames(slug),
          entries: listing,
        }),
      ));
    }
    writes.push(this.writeRootEntries());
    return writes;
  }

  private locateEntry(entryPath: string): LocatedEntry {
    const resolved = resolveWikiMarkdownPath(this.root, entryPath);
    const segments = resolved.wikiPath.split("/");
    const slug = segments[1] ?? "";
    const semanticType = segments[3] ?? "";
    const fileName = segments[4] ?? "";
    if (
      segments.length !== 5
      || segments[0] !== PAGES_DIR
      || segments[2] !== this.entriesDirName
      || !SLUG_NAME.test(slug)
      || !SEMANTIC_TYPE_SET.has(semanticType)
      || !isEntryFileName(fileName)
    ) {
      throw new WikiPathError(
        "WIKI_PATH_INVALID",
        "wiki index path must be pages/<slug>/<entries>/<semanticType>/<id>.md",
      );
    }
    return { slug, semanticType };
  }

  private writeRootEntries(): WikiIndexWrite {
    const absolute = this.absolute(INDEX_FILE);
    const kind = this.pathKind(absolute);
    if (kind === "symlink") {
      throw new WikiPathError("WIKI_PATH_SYMLINK", "wiki index rejects symbolic links");
    }
    if (kind !== "missing" && kind !== "file") {
      throw new WikiPathError("WIKI_PATH_NOT_FILE", "wiki INDEX.md must be a file");
    }
    const existing = kind === "file" ? readFileSync(absolute, "utf8") : "";
    const section = renderRootEntriesSection(this.slugCounts(), this.entriesDirName);
    return this.writeGenerated(INDEX_FILE, patchEntriesSection(existing, section));
  }

  private writeGenerated(wikiPath: string, text: string): WikiIndexWrite {
    const absolute = this.absolute(...wikiPath.split("/"));
    assertContained(this.root, absolute);
    const kind = this.pathKind(absolute);
    if (kind === "symlink") {
      throw new WikiPathError("WIKI_PATH_SYMLINK", "wiki index rejects symbolic links");
    }
    if (kind !== "missing" && kind !== "file") {
      throw new WikiPathError("WIKI_PATH_NOT_FILE", "wiki index path must be a markdown file");
    }
    const next = text.endsWith("\n") ? text : `${text}\n`;
    if (kind === "file" && readFileSync(absolute, "utf8") === next) {
      return { wikiPath, changed: false };
    }
    if (this.pathKind(dirname(absolute)) === "symlink") {
      throw new WikiPathError("WIKI_PATH_SYMLINK", "wiki index rejects symbolic links");
    }
    atomicWrite(absolute, next);
    return { wikiPath, changed: true };
  }

  private slugCounts(): SlugCount[] {
    const scopeKeys = loadScopeKeys(this.root);
    return this.listEntrySlugs().map((slug) => ({
      slug,
      scopeKey: scopeKeys.get(slug) ?? slug,
      entries: this.listEntries(slug).total,
      indexWikiPath: `pages/${slug}/${INDEX_FILE}`,
    }));
  }

  private scopeKey(slug: string): string {
    return loadScopeKeys(this.root).get(slug) ?? slug;
  }

  /** Slugs that have a real entries directory, sorted by slug. Does not follow symlinks. */
  private listEntrySlugs(): string[] {
    const pagesDir = this.absolute(PAGES_DIR);
    const kind = this.pathKind(pagesDir);
    if (kind === "missing") return [];
    if (kind === "symlink") {
      throw new WikiPathError("WIKI_PATH_SYMLINK", "wiki pages directory rejects symbolic links");
    }
    if (kind !== "dir") return [];
    const slugs: string[] = [];
    for (const dirent of readRealDirectory(pagesDir)) {
      if (!dirent.isDirectory() || dirent.isSymbolicLink() || !SLUG_NAME.test(dirent.name)) continue;
      const entriesKind = this.pathKind(this.absolute(PAGES_DIR, dirent.name, this.entriesDirName));
      if (entriesKind === "symlink") continue;
      if (entriesKind === "dir") slugs.push(dirent.name);
    }
    slugs.sort(compareText);
    return slugs;
  }

  private listEntries(slug: string): EntryListing {
    const entriesDir = this.absolute(PAGES_DIR, slug, this.entriesDirName);
    if (this.pathKind(entriesDir) !== "dir") return { total: 0, types: [] };
    const types = listSemanticTypeNames(entriesDir).map((semanticType) => ({
      semanticType,
      count: countEntryFileNames(join(entriesDir, semanticType)),
      indexWikiPath: `${this.typeWiki(slug, semanticType)}/${INDEX_FILE}`,
    }));
    return {
      total: types.reduce((sum, type) => sum + type.count, 0),
      types,
    };
  }

  private entryRows(slug: string, semanticType: string): EntryRow[] {
    const typeDir = this.absolute(PAGES_DIR, slug, this.entriesDirName, semanticType);
    const typeWiki = this.typeWiki(slug, semanticType);
    const rows: EntryRow[] = [];
    for (const dirent of readRealDirectory(typeDir)) {
      if (!dirent.isFile() || dirent.isSymbolicLink() || !isEntryFileName(dirent.name)) continue;
      const absolute = join(typeDir, dirent.name);
      const loaded = readRegularFile(absolute);
      const parsed = parseFrontMatter(loaded.text.replace(/\r\n/g, "\n"));
      const id = dirent.name.slice(0, -".md".length);
      rows.push({
        id,
        title: entryTitle(parsed.body, id),
        wikiPath: `${typeWiki}/${dirent.name}`,
        updatedAt: stringAttr(parsed.attributes.updated_at) ?? loaded.mtimeIso,
      });
    }
    rows.sort((left, right) => compareText(left.id, right.id) || compareText(left.wikiPath, right.wikiPath));
    return rows;
  }

  /** Filename count of `page-*.md` directly inside the slug. Bodies are not opened. */
  private countFusedPageNames(slug: string): number {
    const slugDir = this.absolute(PAGES_DIR, slug);
    if (this.pathKind(slugDir) !== "dir") return 0;
    let count = 0;
    for (const dirent of readRealDirectory(slugDir)) {
      if (dirent.isFile() && !dirent.isSymbolicLink() && FUSED_PAGE_NAME.test(dirent.name)) count += 1;
    }
    return count;
  }

  private typeWiki(slug: string, semanticType: string): string {
    return `pages/${slug}/${this.entriesDirName}/${semanticType}`;
  }

  private absolute(...segments: readonly string[]): string {
    return resolve(this.root, ...segments);
  }

  private pathKind(path: string): PathKind {
    const stat = lstatIfExists(path);
    if (!stat) return "missing";
    if (stat.isSymbolicLink()) return "symlink";
    if (stat.isDirectory()) return "dir";
    if (stat.isFile()) return "file";
    return "other";
  }

  private assertWikiRoot(): void {
    if (this.pathKind(this.root) !== "dir") {
      throw new WikiPathError("WIKI_ROOT_INVALID", "wiki root must be a real directory");
    }
  }
}

function renderRootEntriesSection(rows: readonly SlugCount[], entriesDirName: string): string {
  const lines = [
    "## Entries",
    "",
    `Track E files under \`pages/<slug>/${entriesDirName}/\`. Counts are directory listings. Fused totals are not recomputed.`,
    "",
    "| slug | scope_key | entries | index |",
    "| --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    lines.push(
      `| ${escapeCell(row.slug)} | ${escapeCell(flat(row.scopeKey, 300))} | ${row.entries} | ${markdownLink(row.indexWikiPath, row.indexWikiPath)} |`,
    );
  }
  return lines.join("\n");
}

function renderSlugIndex(input: {
  slug: string;
  scopeKey: string;
  entriesDirName: string;
  fusedPages: number;
  entries: EntryListing;
}): string {
  const entriesIndex = `pages/${input.slug}/${input.entriesDirName}/${INDEX_FILE}`;
  const lines = [
    `# ${input.slug}`,
    "",
    `- scope_key: ${flat(input.scopeKey, 300)}`,
    "- fused_page_bodies: not read",
    "",
    "## Fused",
    "",
    `- page_files: ${input.fusedPages}`,
    "",
    "## Entries",
    "",
    `- total: ${input.entries.total}`,
    `- index: ${markdownLink(entriesIndex, `${input.entriesDirName}/${INDEX_FILE}`)}`,
    "",
    "| semantic_type | count | index |",
    "| --- | --- | --- |",
  ];
  for (const type of input.entries.types) {
    lines.push(
      `| ${type.semanticType} | ${type.count} | ${markdownLink(type.indexWikiPath, `${input.entriesDirName}/${type.semanticType}/${INDEX_FILE}`)} |`,
    );
  }
  return lines.join("\n");
}

function renderEntriesIndex(slug: string, types: readonly TypeCount[]): string {
  const lines = [
    "# Entries",
    "",
    `Track E semantic types for \`${slug}\`.`,
    "",
    "| semantic_type | count | index |",
    "| --- | --- | --- |",
  ];
  for (const type of types) {
    lines.push(
      `| ${type.semanticType} | ${type.count} | ${markdownLink(type.indexWikiPath, `${type.semanticType}/${INDEX_FILE}`)} |`,
    );
  }
  return lines.join("\n");
}

function renderTypeIndex(semanticType: string, rows: readonly EntryRow[]): string {
  const lines = [
    `# ${semanticType}`,
    "",
    "| id | title | path | updated_at |",
    "| --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    lines.push(
      `| ${escapeCell(row.id)} | ${row.title} | ${escapeCell(row.wikiPath)} | ${escapeCell(row.updatedAt)} |`,
    );
  }
  return lines.join("\n");
}

/**
 * Insert or replace only the marked Entries section.
 * Bytes before the section, and any trailer after it, stay unchanged.
 */
function patchEntriesSection(existing: string, section: string): string {
  const block = `${ENTRY_SECTION_START}\n${section.trim()}\n${ENTRY_SECTION_END}\n`;
  const start = lineIndex(existing, ENTRY_SECTION_START);
  const end = lineIndex(existing, ENTRY_SECTION_END);
  if (start !== -1 || end !== -1) {
    if (start === -1 || end < start) {
      throw new WikiPathError("WIKI_PATH_INVALID", "wiki INDEX.md Entries markers are incomplete");
    }
    const suffix = existing.slice(end + ENTRY_SECTION_END.length).replace(/^\n/, "");
    return `${existing.slice(0, start)}${block}${suffix}`;
  }
  if (existing.length === 0) return block;
  const prefix = existing.endsWith("\n") ? existing : `${existing}\n`;
  return `${prefix}${prefix.endsWith("\n\n") ? "" : "\n"}${block}`;
}

function listSemanticTypeNames(entriesDir: string): string[] {
  const present = new Set<string>();
  for (const dirent of readRealDirectory(entriesDir)) {
    if (!dirent.isDirectory() || dirent.isSymbolicLink()) continue;
    if (SEMANTIC_TYPE_SET.has(dirent.name)) present.add(dirent.name);
  }
  return ENTRY_SEMANTIC_TYPES.filter((semanticType) => present.has(semanticType));
}

function countEntryFileNames(typeDir: string): number {
  if (pathKindOf(typeDir) !== "dir") return 0;
  let count = 0;
  for (const dirent of readRealDirectory(typeDir)) {
    if (dirent.isFile() && !dirent.isSymbolicLink() && isEntryFileName(dirent.name)) count += 1;
  }
  return count;
}

function loadScopeKeys(root: string): Map<string, string> {
  const path = join(root, "scope-registry.json");
  if (pathKindOf(path) !== "file") return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return new Map();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
  const scopes = (parsed as { scopes?: unknown }).scopes;
  if (!Array.isArray(scopes)) return new Map();
  const map = new Map<string, string>();
  for (const scope of scopes) {
    if (!scope || typeof scope !== "object" || Array.isArray(scope)) continue;
    const record = scope as { slug?: unknown; scopeKey?: unknown };
    if (typeof record.slug !== "string" || typeof record.scopeKey !== "string") continue;
    if (!SLUG_NAME.test(record.slug) || record.scopeKey.trim().length === 0) continue;
    if (!map.has(record.slug)) map.set(record.slug, flat(record.scopeKey, 300));
  }
  return map;
}

function isEntryFileName(name: string): boolean {
  return name !== INDEX_FILE && ENTRY_FILE_NAME.test(name);
}

function entryTitle(body: string, fallback: string): string {
  for (const line of body.split("\n")) {
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line.trim());
    if (heading?.[1]) return escapeCell(flat(heading[1], 160));
  }
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return escapeCell(flat(trimmed, 160));
  }
  return escapeCell(flat(fallback, 160));
}

function stringAttr(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function flat(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join("") : text;
}

function escapeCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

function markdownLink(label: string, href: string): string {
  return `[${escapeCell(label)}](${href})`;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function lineIndex(text: string, marker: string): number {
  if (text.startsWith(marker)) return 0;
  const found = text.indexOf(`\n${marker}`);
  return found === -1 ? -1 : found + 1;
}

function readRealDirectory(path: string): Dirent[] {
  if (pathKindOf(path) === "symlink") {
    throw new WikiPathError("WIKI_PATH_SYMLINK", "wiki index rejects symbolic links");
  }
  if (pathKindOf(path) !== "dir") {
    throw new WikiPathError("WIKI_PATH_INVALID", "wiki index directory is missing");
  }
  return readdirSync(path, { withFileTypes: true });
}

function readRegularFile(path: string): { text: string; mtimeIso: string } {
  const stat = lstatIfExists(path);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    throw new WikiPathError("WIKI_PATH_NOT_FILE", "wiki entry must be a regular markdown file");
  }
  return { text: readFileSync(path, "utf8"), mtimeIso: stat.mtime.toISOString() };
}

function atomicWrite(path: string, text: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, text, { encoding: "utf8", flag: "wx" });
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
}

function assertContained(root: string, absolute: string): void {
  const fromRoot = relative(root, absolute);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new WikiPathError("WIKI_PATH_ESCAPE", "wiki index path escapes wiki root");
  }
}

function pathKindOf(path: string): PathKind {
  const stat = lstatIfExists(path);
  if (!stat) return "missing";
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isDirectory()) return "dir";
  if (stat.isFile()) return "file";
  return "other";
}

function lstatIfExists(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
