import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

import {
  parseWikiConfig,
  resolveWikiMarkdownPath,
  resolveWikiRoot,
  WikiPathError,
} from "./root.js";

const FAKE_HOME = "/tmp/fake-home";

function temporaryDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("wiki root config", () => {
  test("defaults to ~/.mengshu/wiki and fills optional fields", () => {
    expect(resolveWikiRoot(undefined, { home: FAKE_HOME })).toBe(
      `${FAKE_HOME}/.mengshu/wiki`,
    );
    expect(parseWikiConfig(undefined, { home: FAKE_HOME })).toEqual({
      root: `${FAKE_HOME}/.mengshu/wiki`,
      entriesDirName: "entries",
      writeEntriesOnPersist: true,
      indexUpdate: "sync-ancestors",
      updateCompletion: true,
    });
  });

  test("expands ~ and accepts an absolute temporary root without creating it", () => {
    const parent = temporaryDirectory("mengshu-wiki-w1-root-");
    const missing = join(parent, "custom-wiki");
    try {
      expect(resolveWikiRoot("~/custom/wiki", { home: FAKE_HOME })).toBe(
        `${FAKE_HOME}/custom/wiki`,
      );
      expect(parseWikiConfig({ root: missing }, { home: FAKE_HOME }).root).toBe(resolve(missing));
      expect(existsSync(missing)).toBe(false);
      expect(parseWikiConfig({
        root: "~/temp-wiki",
        entriesDirName: "track-e",
        writeEntriesOnPersist: false,
        indexUpdate: "off",
        updateCompletion: false,
      }, { home: FAKE_HOME })).toEqual({
        root: `${FAKE_HOME}/temp-wiki`,
        entriesDirName: "track-e",
        writeEntriesOnPersist: false,
        indexUpdate: "off",
        updateCompletion: false,
      });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("rejects relative roots, bad optional fields, and unknown keys", () => {
    expect(() => resolveWikiRoot("relative/wiki", { home: FAKE_HOME })).toThrow(WikiPathError);
    expect(() => resolveWikiRoot("relative/wiki", { home: FAKE_HOME })).toThrow(/absolute/);
    expect(() => parseWikiConfig({ root: "wiki" }, { home: FAKE_HOME })).toThrow(/absolute/);
    expect(() => parseWikiConfig({ entriesDirName: "../entries" })).toThrow(/path segment/);
    expect(() => parseWikiConfig({ entriesDirName: "entries/nested" })).toThrow(/path segment/);
    expect(() => parseWikiConfig({ writeEntriesOnPersist: "true" })).toThrow(/boolean/);
    expect(() => parseWikiConfig({ indexUpdate: "async" })).toThrow(/sync-ancestors or off/);
    expect(() => parseWikiConfig({ updateCompletion: 1 })).toThrow(/boolean/);
    expect(() => parseWikiConfig({ material: true })).toThrow(/unknown keys: material/);
    expect(() => parseWikiConfig([])).toThrow(/object/);
  });
});

describe("wiki markdown path jail", () => {
  test("accepts relative .md paths and normalizes an in-root absolute path", () => {
    const parent = temporaryDirectory("mengshu-wiki-w1-jail-");
    const root = join(parent, "wiki");
    try {
      mkdirSync(root);
      const resolved = resolveWikiMarkdownPath(
        root,
        "pages/default-knowledge/entries/experience/abc.md",
      );
      expect(resolved.wikiPath).toBe("pages/default-knowledge/entries/experience/abc.md");
      expect(resolved.wikiPath.includes("\\")).toBe(false);
      expect(resolved.absolutePath).toBe(resolve(root, resolved.wikiPath));
      expect(existsSync(resolved.absolutePath)).toBe(false);
      expect(resolveWikiMarkdownPath(root, resolved.absolutePath)).toEqual(resolved);
      expect(resolveWikiMarkdownPath(root, "pages/default-knowledge/page-019.md").wikiPath).toBe(
        "pages/default-knowledge/page-019.md",
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("rejects .., absolute escape, non-md, and directories", () => {
    const parent = temporaryDirectory("mengshu-wiki-w1-reject-");
    const root = join(parent, "wiki");
    const outside = join(parent, "outside.md");
    try {
      mkdirSync(root);
      mkdirSync(join(root, "dir.md"));
      writeFileSync(outside, "outside", "utf8");

      expect(() => resolveWikiMarkdownPath(root, "../outside.md")).toThrow(
        expect.objectContaining({ code: "WIKI_PATH_TRAVERSAL" }),
      );
      expect(() => resolveWikiMarkdownPath(root, "pages/../../outside.md")).toThrow(
        expect.objectContaining({ code: "WIKI_PATH_TRAVERSAL" }),
      );
      expect(() => resolveWikiMarkdownPath(root, "/etc/passwd.md")).toThrow(
        expect.objectContaining({ code: "WIKI_PATH_ESCAPE" }),
      );
      expect(() => resolveWikiMarkdownPath(root, outside)).toThrow(
        expect.objectContaining({ code: "WIKI_PATH_ESCAPE" }),
      );
      expect(() => resolveWikiMarkdownPath(root, "pages/note.txt")).toThrow(
        expect.objectContaining({ code: "WIKI_PATH_EXTENSION" }),
      );
      expect(() => resolveWikiMarkdownPath(root, "pages/note.MD")).toThrow(
        expect.objectContaining({ code: "WIKI_PATH_EXTENSION" }),
      );
      expect(() => resolveWikiMarkdownPath(root, "pages\\note.md")).toThrow(
        expect.objectContaining({ code: "WIKI_PATH_INVALID" }),
      );
      expect(() => resolveWikiMarkdownPath(root, "dir.md")).toThrow(
        expect.objectContaining({ code: "WIKI_PATH_NOT_FILE" }),
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("rejects a symlinked root, intermediate directory, and markdown file", () => {
    const parent = temporaryDirectory("mengshu-wiki-w1-symlink-");
    const real = join(parent, "real");
    const rootLink = join(parent, "root-link");
    const root = join(parent, "wiki");
    const outside = join(parent, "outside");
    try {
      mkdirSync(real);
      mkdirSync(root);
      mkdirSync(outside);
      symlinkSync(real, rootLink, "dir");
      expect(() => resolveWikiMarkdownPath(rootLink, "page.md")).toThrow(
        expect.objectContaining({ code: "WIKI_PATH_SYMLINK" }),
      );

      symlinkSync(outside, join(root, "pages"), "dir");
      expect(() => resolveWikiMarkdownPath(root, "pages/a.md")).toThrow(
        expect.objectContaining({ code: "WIKI_PATH_SYMLINK" }),
      );

      const plain = join(parent, "plain");
      mkdirSync(join(plain, "pages"), { recursive: true });
      writeFileSync(join(outside, "secret.md"), "secret", "utf8");
      symlinkSync(join(outside, "secret.md"), join(plain, "pages", "secret.md"), "file");
      expect(() => resolveWikiMarkdownPath(plain, "pages/secret.md")).toThrow(
        expect.objectContaining({ code: "WIKI_PATH_SYMLINK" }),
      );
      expect(existsSync(join(outside, "secret.md"))).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
