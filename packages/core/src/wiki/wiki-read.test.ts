import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { WikiPathError } from "./root.js";
import { readWikiMarkdown, WikiReadError } from "./wiki-read.js";

function temporaryDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("readWikiMarkdown", () => {
  test("reads fused pages, entries, and any other relative markdown", async () => {
    const parent = temporaryDirectory("mengshu-wiki-read-ok-");
    const root = join(parent, "wiki");
    const fused = "pages/default-knowledge/page-019.md";
    const entry = "pages/default-memories/entries/rules/6f0c0c2a-1b2c-4d5e-8f90-aabbccddeeff.md";
    const index = "INDEX.md";
    const fusedBody = "---\ntrack: fused\n---\n\n# Fused page\n\n你好世界\n";
    const entryBody = "---\ntrack: entry\n---\n\n# Rule\n\nprefer small diffs\n";
    const indexBody = "# Index\n\n- entries\n";
    try {
      mkdirSync(join(root, "pages/default-knowledge"), { recursive: true });
      mkdirSync(join(root, "pages/default-memories/entries/rules"), { recursive: true });
      writeFileSync(join(root, fused), fusedBody, "utf8");
      writeFileSync(join(root, `${fused.replace(/\.md$/, "")}.sources`), "source-a\n", "utf8");
      writeFileSync(join(root, entry), entryBody, "utf8");
      writeFileSync(join(root, index), indexBody, "utf8");

      const fusedRead = await readWikiMarkdown(root, fused);
      const entryRead = await readWikiMarkdown(root, entry);
      const indexRead = await readWikiMarkdown(root, index);
      const fromAbsolute = await readWikiMarkdown(root, join(root, fused));

      expect(fusedRead).toEqual({
        wikiPath: fused,
        content: fusedBody,
        truncated: false,
        totalChars: fusedBody.length,
      });
      expect(entryRead).toEqual({
        wikiPath: entry,
        content: entryBody,
        truncated: false,
        totalChars: entryBody.length,
      });
      expect(indexRead.wikiPath).toBe("INDEX.md");
      expect(indexRead.content).toBe(indexBody);
      expect(fromAbsolute).toEqual(fusedRead);
      expect(fusedRead.wikiPath.includes("\\")).toBe(false);
      expect(JSON.stringify(fusedRead)).not.toContain(root);
      expect(existsSync(join(root, fused))).toBe(true);
      expect(await readWikiMarkdown(root, fused)).toEqual(fusedRead);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("truncates by maxChars without dropping the unread tail from totalChars", async () => {
    const parent = temporaryDirectory("mengshu-wiki-read-trunc-");
    const root = join(parent, "wiki");
    const body = "你好世界abcdef";
    try {
      mkdirSync(root);
      writeFileSync(join(root, "note.md"), body, "utf8");

      const clipped = await readWikiMarkdown(root, "note.md", { maxChars: 2 });
      expect(clipped.content).toBe("你好");
      expect(clipped.truncated).toBe(true);
      expect(clipped.totalChars).toBe(body.length);
      expect(clipped.wikiPath).toBe("note.md");

      const exact = await readWikiMarkdown(root, "note.md", { maxChars: body.length });
      expect(exact.content).toBe(body);
      expect(exact.truncated).toBe(false);

      const wider = await readWikiMarkdown(root, "note.md", { maxChars: body.length + 5 });
      expect(wider).toEqual(exact);

      await expect(readWikiMarkdown(root, "note.md", { maxChars: 0 })).rejects.toMatchObject({
        name: "WikiReadError",
        code: "WIKI_READ_MAX_CHARS",
      });
      await expect(readWikiMarkdown(root, "note.md", { maxChars: 1.5 })).rejects.toBeInstanceOf(WikiReadError);
      await expect(readWikiMarkdown(root, "note.md", { maxChars: -3 })).rejects.toMatchObject({
        code: "WIKI_READ_MAX_CHARS",
      });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("does not create a missing markdown file", async () => {
    const parent = temporaryDirectory("mengshu-wiki-read-miss-");
    const root = join(parent, "wiki");
    try {
      mkdirSync(root);
      await expect(readWikiMarkdown(root, "pages/default-knowledge/page-019.md")).rejects.toMatchObject({
        name: "WikiReadError",
        code: "WIKI_READ_NOT_FOUND",
      });
      expect(existsSync(join(root, "pages"))).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("rejects traversal, absolute escape, non-md, and directories", async () => {
    const parent = temporaryDirectory("mengshu-wiki-read-reject-");
    const root = join(parent, "wiki");
    const outside = join(parent, "outside.md");
    try {
      mkdirSync(root);
      mkdirSync(join(root, "dir.md"));
      writeFileSync(outside, "outside", "utf8");

      await expect(readWikiMarkdown(root, "../outside.md")).rejects.toMatchObject({
        name: "WikiPathError",
        code: "WIKI_PATH_TRAVERSAL",
      });
      await expect(readWikiMarkdown(root, "pages/../../outside.md")).rejects.toMatchObject({
        code: "WIKI_PATH_TRAVERSAL",
      });
      await expect(readWikiMarkdown(root, "/etc/passwd.md")).rejects.toMatchObject({
        code: "WIKI_PATH_ESCAPE",
      });
      await expect(readWikiMarkdown(root, outside)).rejects.toMatchObject({
        code: "WIKI_PATH_ESCAPE",
      });
      await expect(readWikiMarkdown(root, "pages/note.txt")).rejects.toMatchObject({
        code: "WIKI_PATH_EXTENSION",
      });
      await expect(readWikiMarkdown(root, "page-019.sources")).rejects.toMatchObject({
        code: "WIKI_PATH_EXTENSION",
      });
      await expect(readWikiMarkdown(root, "pages/note.MD")).rejects.toMatchObject({
        code: "WIKI_PATH_EXTENSION",
      });
      await expect(readWikiMarkdown(root, "pages\\note.md")).rejects.toMatchObject({
        code: "WIKI_PATH_INVALID",
      });
      await expect(readWikiMarkdown(root, "dir.md")).rejects.toMatchObject({
        code: "WIKI_PATH_NOT_FILE",
      });
      await expect(readWikiMarkdown(root, "../outside.md")).rejects.toBeInstanceOf(WikiPathError);
      expect(existsSync(outside)).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("rejects a symlinked root, intermediate directory, and markdown file", async () => {
    const parent = temporaryDirectory("mengshu-wiki-read-symlink-");
    const real = join(parent, "real");
    const rootLink = join(parent, "root-link");
    const root = join(parent, "wiki");
    const outside = join(parent, "outside");
    const plain = join(parent, "plain");
    try {
      mkdirSync(real);
      writeFileSync(join(real, "page.md"), "linked-root", "utf8");
      mkdirSync(root);
      mkdirSync(outside);
      symlinkSync(real, rootLink, "dir");
      await expect(readWikiMarkdown(rootLink, "page.md")).rejects.toMatchObject({
        code: "WIKI_PATH_SYMLINK",
      });

      symlinkSync(outside, join(root, "pages"), "dir");
      await expect(readWikiMarkdown(root, "pages/a.md")).rejects.toMatchObject({
        code: "WIKI_PATH_SYMLINK",
      });

      mkdirSync(join(plain, "pages"), { recursive: true });
      writeFileSync(join(outside, "secret.md"), "secret-outside", "utf8");
      symlinkSync(join(outside, "secret.md"), join(plain, "pages", "secret.md"), "file");
      await expect(readWikiMarkdown(plain, "pages/secret.md")).rejects.toMatchObject({
        name: "WikiPathError",
        code: "WIKI_PATH_SYMLINK",
      });
      await expect(readWikiMarkdown(plain, "pages/secret.md")).rejects.toThrow(
        /symbolic links/,
      );
      expect(existsSync(join(outside, "secret.md"))).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
