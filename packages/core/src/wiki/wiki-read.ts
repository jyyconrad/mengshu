/**
 * Read a markdown file inside a wiki root.
 *
 * Paths go through the W1 jail (`resolveWikiMarkdownPath`). Any relative
 * `.md` under the root is allowed, including fused `page-*.md` pages and
 * Track E entries. The jail rejects `..`, absolute paths that leave the
 * root, non-`.md` paths, directories, and symbolic links. An in-root
 * absolute path is normalized to a relative `wikiPath` (forward slashes).
 * This reader never creates or rewrites files and does not touch the
 * database, so a missing file cannot roll back a committed memory.
 * `maxChars` truncates by JavaScript string length when set.
 */

import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

import {
  resolveWikiMarkdownPath,
  WikiPathError,
  type WikiPathOptions,
} from "./root.js";

export type WikiReadErrorCode =
  | "WIKI_READ_NOT_FOUND"
  | "WIKI_READ_MAX_CHARS"
  | "WIKI_READ_IO";

export class WikiReadError extends Error {
  readonly code: WikiReadErrorCode;

  constructor(code: WikiReadErrorCode, message: string) {
    super(message);
    this.name = "WikiReadError";
    this.code = code;
  }
}

export interface WikiReadOptions extends WikiPathOptions {
  /** Truncate `content` to this many JavaScript string characters. */
  maxChars?: number;
}

/** File body plus the relative path safe to store on `metadata.wikiPath`. */
export interface WikiMarkdownRead {
  wikiPath: string;
  content: string;
  truncated: boolean;
  totalChars: number;
}

export async function readWikiMarkdown(
  rootInput: string,
  requested: string,
  options: WikiReadOptions = {},
): Promise<WikiMarkdownRead> {
  const resolved = resolveWikiMarkdownPath(rootInput, requested, options);
  const maxChars = parseMaxChars(options.maxChars);
  const content = await readJailedFile(resolved.absolutePath, resolved.wikiPath);
  if (maxChars === undefined || content.length <= maxChars) {
    return freezeRead(resolved.wikiPath, content, false);
  }
  return freezeRead(resolved.wikiPath, content.slice(0, maxChars), true, content.length);
}

function freezeRead(
  wikiPath: string,
  content: string,
  truncated: boolean,
  totalChars: number = content.length,
): WikiMarkdownRead {
  return Object.freeze({
    wikiPath,
    content,
    truncated,
    totalChars,
  });
}

function parseMaxChars(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new WikiReadError("WIKI_READ_MAX_CHARS", "maxChars must be a positive integer");
  }
  return value;
}

function openFlags(): number {
  const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW;
  return typeof noFollow === "number" ? constants.O_RDONLY | noFollow : constants.O_RDONLY;
}

async function readJailedFile(absolutePath: string, wikiPath: string): Promise<string> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(absolutePath, openFlags());
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new WikiPathError("WIKI_PATH_NOT_FILE", "wiki path must be a markdown file");
    }
    return await handle.readFile({ encoding: "utf8" });
  } catch (error) {
    if (error instanceof WikiPathError || error instanceof WikiReadError) throw error;
    throw readFailure(error, wikiPath);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function readFailure(error: unknown, wikiPath: string): Error {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") {
    return new WikiReadError("WIKI_READ_NOT_FOUND", `wiki file not found: ${wikiPath}`);
  }
  if (code === "ELOOP" || code === "EMLINK") {
    return new WikiPathError("WIKI_PATH_SYMLINK", "wiki path rejects symbolic links");
  }
  if (code === "EISDIR") {
    return new WikiPathError("WIKI_PATH_NOT_FILE", "wiki path must be a markdown file");
  }
  return new WikiReadError("WIKI_READ_IO", `wiki read failed: ${wikiPath}`);
}
