/**
 * Wiki root resolution and markdown path jail.
 *
 * `wiki.root` is an absolute path (`~` expanded). Values stored as
 * `metadata.wikiPath` are relative to that root and use forward slashes.
 * The jail rejects `..`, absolute paths that leave the root, non-`.md`
 * paths, and symbolic links (including intermediate directories). It does
 * not create files or touch the database. A later wiki write failure must
 * not roll back a committed memory.
 */

import { lstatSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { expandHome } from "../runtime/paths.js";

export const DEFAULT_WIKI_ENTRIES_DIR_NAME = "entries";
export const DEFAULT_WIKI_INDEX_UPDATE = "sync-ancestors" as const;

const WIKI_CONFIG_KEYS = [
  "root",
  "entriesDirName",
  "writeEntriesOnPersist",
  "indexUpdate",
  "updateCompletion",
] as const;

const ENTRIES_DIR_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export type WikiIndexUpdate = "sync-ancestors" | "off";

export type WikiPathErrorCode =
  | "WIKI_ROOT_INVALID"
  | "WIKI_CONFIG_INVALID"
  | "WIKI_PATH_INVALID"
  | "WIKI_PATH_TRAVERSAL"
  | "WIKI_PATH_ESCAPE"
  | "WIKI_PATH_EXTENSION"
  | "WIKI_PATH_SYMLINK"
  | "WIKI_PATH_NOT_FILE";

export class WikiPathError extends Error {
  readonly code: WikiPathErrorCode;

  constructor(code: WikiPathErrorCode, message: string) {
    super(message);
    this.name = "WikiPathError";
    this.code = code;
  }
}

/** Resolved wiki settings. Optional input fields are filled with defaults. */
export interface WikiConfig {
  /** Absolute filesystem path. Not stored on memory rows. */
  root: string;
  /** Single path segment under `pages/<slug>/`. */
  entriesDirName: string;
  writeEntriesOnPersist: boolean;
  indexUpdate: WikiIndexUpdate;
  updateCompletion: boolean;
}

export interface WikiPathOptions {
  /** Override `os.homedir()` when expanding `~`. */
  home?: string;
}

/** Absolute path of a jailed `.md` file, plus the relative form safe to store. */
export interface ResolvedWikiMarkdownPath {
  absolutePath: string;
  wikiPath: string;
}

export function defaultWikiRoot(home: string = homedir()): string {
  return resolve(home, ".mengshu", "wiki");
}

/**
 * Expand `~` and require an absolute wiki root.
 * Does not create the directory and does not follow symlinks.
 */
export function resolveWikiRoot(input?: string, options: WikiPathOptions = {}): string {
  const home = options.home ?? homedir();
  const raw = input === undefined ? defaultWikiRoot(home) : input.trim();
  if (raw.length === 0) {
    throw new WikiPathError("WIKI_ROOT_INVALID", "wiki.root must be a non-empty string");
  }
  if (raw.includes("\0") || /\p{Cc}/u.test(raw)) {
    throw new WikiPathError("WIKI_ROOT_INVALID", "wiki.root contains unsupported characters");
  }
  const expanded = expandHome(raw, home);
  if (!isAbsolute(expanded)) {
    throw new WikiPathError("WIKI_ROOT_INVALID", "wiki.root must be an absolute path");
  }
  return resolve(expanded);
}

export function parseWikiConfig(value: unknown, options: WikiPathOptions = {}): WikiConfig {
  if (value === undefined) {
    return wikiConfigFromRaw({}, options);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WikiPathError("WIKI_CONFIG_INVALID", "wiki config must be an object");
  }
  const raw = value as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((key) => !(WIKI_CONFIG_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    throw new WikiPathError("WIKI_CONFIG_INVALID", `wiki config has unknown keys: ${unknown.join(", ")}`);
  }
  return wikiConfigFromRaw(raw, options);
}

/**
 * Resolve `requested` under `root` and return a relative forward-slash `wikiPath`.
 * Absolute inputs that stay inside the root are normalized; absolute escapes are rejected.
 * Missing `.md` files are allowed so a caller can target a path before the first write.
 */
export function resolveWikiMarkdownPath(
  rootInput: string,
  requested: string,
  options: WikiPathOptions = {},
): ResolvedWikiMarkdownPath {
  const root = resolveWikiRoot(rootInput, options);
  if (typeof requested !== "string" || requested.length === 0 || requested !== requested.trim()) {
    throw new WikiPathError("WIKI_PATH_INVALID", "wiki path must be a non-empty path");
  }
  const input = requested.normalize("NFC");
  if (input.includes("\0") || /\p{Cc}/u.test(input)) {
    throw new WikiPathError("WIKI_PATH_INVALID", "wiki path contains unsupported characters");
  }
  if (input.includes("\\")) {
    throw new WikiPathError("WIKI_PATH_INVALID", "wiki path must use forward slashes");
  }
  if (input.split("/").includes("..")) {
    throw new WikiPathError("WIKI_PATH_TRAVERSAL", "wiki path rejects ..");
  }

  const home = options.home ?? homedir();
  const expanded = input === "~" || input.startsWith("~/") ? expandHome(input, home) : input;
  if (expanded.startsWith("~")) {
    throw new WikiPathError("WIKI_PATH_INVALID", "wiki path must be relative to wiki root");
  }
  const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(root, expanded);
  const wikiPath = containedWikiPath(root, absolute);
  const segments = wikiPath.split("/");
  const base = segments[segments.length - 1] ?? "";
  if (base.length <= ".md".length || !base.endsWith(".md")) {
    throw new WikiPathError("WIKI_PATH_EXTENSION", "wiki path must be a .md file");
  }
  assertNoWikiSymlink(root, segments);
  return {
    absolutePath: resolve(root, ...segments),
    wikiPath,
  };
}

function wikiConfigFromRaw(raw: Record<string, unknown>, options: WikiPathOptions): WikiConfig {
  if (raw.root !== undefined && (typeof raw.root !== "string" || raw.root.trim().length === 0)) {
    throw new WikiPathError("WIKI_ROOT_INVALID", "wiki.root must be a non-empty string");
  }
  return {
    root: resolveWikiRoot(typeof raw.root === "string" ? raw.root : undefined, options),
    entriesDirName: optionalEntriesDirName(raw.entriesDirName),
    writeEntriesOnPersist: optionalBoolean(
      raw.writeEntriesOnPersist,
      "wiki.writeEntriesOnPersist",
      true,
    ),
    indexUpdate: optionalIndexUpdate(raw.indexUpdate),
    updateCompletion: optionalBoolean(raw.updateCompletion, "wiki.updateCompletion", true),
  };
}

function optionalBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new WikiPathError("WIKI_CONFIG_INVALID", `${field} must be a boolean`);
  }
  return value;
}

function optionalEntriesDirName(value: unknown): string {
  if (value === undefined) return DEFAULT_WIKI_ENTRIES_DIR_NAME;
  if (typeof value !== "string" || !ENTRIES_DIR_NAME.test(value)) {
    throw new WikiPathError(
      "WIKI_CONFIG_INVALID",
      "wiki.entriesDirName must be a single path segment",
    );
  }
  return value;
}

function optionalIndexUpdate(value: unknown): WikiIndexUpdate {
  if (value === undefined) return DEFAULT_WIKI_INDEX_UPDATE;
  if (value !== "sync-ancestors" && value !== "off") {
    throw new WikiPathError(
      "WIKI_CONFIG_INVALID",
      "wiki.indexUpdate must be sync-ancestors or off",
    );
  }
  return value;
}

function containedWikiPath(root: string, absolute: string): string {
  const fromRoot = relative(root, absolute);
  if (fromRoot === "") {
    throw new WikiPathError("WIKI_PATH_INVALID", "wiki path must point at a .md file under the root");
  }
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new WikiPathError("WIKI_PATH_ESCAPE", "wiki path escapes wiki root");
  }
  const wikiPath = fromRoot.split(sep).join("/");
  const segments = wikiPath.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new WikiPathError("WIKI_PATH_INVALID", "wiki path rejects empty or dot segments");
  }
  return wikiPath;
}

/**
 * Relative forward-slash `wikiPath` safe to show.
 * Absolute paths, backslashes, and `..` are omitted so a host layout is not echoed.
 */
export function relativeWikiPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const wikiPath = value.normalize("NFC");
  if (wikiPath.length === 0 || wikiPath !== wikiPath.trim()) return undefined;
  if (wikiPath.includes("\\") || wikiPath.includes("\0") || /\p{Cc}/u.test(wikiPath)) return undefined;
  if (isAbsolute(wikiPath) || wikiPath.startsWith("~") || /^[A-Za-z]:/.test(wikiPath)) return undefined;
  const segments = wikiPath.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return undefined;
  }
  return wikiPath;
}

/** `metadata.wikiPath` when it is a relative forward-slash path. */
export function relativeWikiPathFromMetadata(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  return relativeWikiPath((metadata as { wikiPath?: unknown }).wikiPath);
}

function lstatIfExists(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function assertNoWikiSymlink(root: string, segments: readonly string[]): void {
  const rootStat = lstatIfExists(root);
  if (rootStat?.isSymbolicLink()) {
    throw new WikiPathError("WIKI_PATH_SYMLINK", "wiki root rejects symbolic links");
  }
  if (rootStat && !rootStat.isDirectory()) {
    throw new WikiPathError("WIKI_ROOT_INVALID", "wiki root must be a directory");
  }
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index] ?? "");
    const stat = lstatIfExists(current);
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      throw new WikiPathError("WIKI_PATH_SYMLINK", "wiki path rejects symbolic links");
    }
    const isLast = index === segments.length - 1;
    if (isLast) {
      if (!stat.isFile()) {
        throw new WikiPathError("WIKI_PATH_NOT_FILE", "wiki path must be a markdown file");
      }
      return;
    }
    if (!stat.isDirectory()) {
      throw new WikiPathError("WIKI_PATH_INVALID", "wiki path crosses a non-directory");
    }
  }
}
