import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Command } from "commander";

import { DatabaseFactory } from "../../../core/src/db/factory.js";
import { WikiPathError } from "../../../core/src/wiki/root.js";
import { readWikiCli, registerWikiCliCommands, runMengshuCli } from "./ms.js";

let cliHome: string | undefined;

afterEach(() => {
  if (cliHome) rmSync(cliHome, { recursive: true, force: true });
  cliHome = undefined;
  delete process.env.MENGSHU_HOME;
  delete process.env.MENGSHU_CONFIG;
});

describe("ms wiki read", () => {
  test("readWikiCli and the command reject ../ and non-md", async () => {
    const parent = mkdtempSync(join(tmpdir(), "mengshu-cli-wiki-read-"));
    const root = join(parent, "wiki");
    const lines: string[] = [];
    try {
      mkdirSync(join(root, "pages/default-memories/entries/rules"), { recursive: true });
      const entry = "pages/default-memories/entries/rules/6f0c0c2a-1b2c-4d5e-8f90-aabbccddeeff.md";
      writeFileSync(join(root, entry), "entry body", "utf8");

      await expect(readWikiCli({ wikiRoot: root, path: "../outside.md" })).rejects.toMatchObject({
        name: "WikiPathError",
        code: "WIKI_PATH_TRAVERSAL",
      });
      await expect(readWikiCli({ wikiRoot: root, path: "pages/../../outside.md" })).rejects.toMatchObject({
        code: "WIKI_PATH_TRAVERSAL",
      });
      await expect(readWikiCli({ wikiRoot: root, path: "notes.txt" })).rejects.toMatchObject({
        code: "WIKI_PATH_EXTENSION",
      });
      await expect(readWikiCli({ wikiRoot: root, path: "page-019.sources" })).rejects.toBeInstanceOf(WikiPathError);
      await expect(readWikiCli({ wikiRoot: root, path: entry })).resolves.toMatchObject({
        wikiPath: entry,
        content: "entry body",
        truncated: false,
      });

      const program = new Command().name("ms").exitOverride();
      registerWikiCliCommands(program, {
        wikiRoot: root,
        writeLine: (line) => lines.push(line),
      });
      const wiki = program.commands.find((command) => command.name() === "wiki")!;
      const read = wiki.commands.find((command) => command.name() === "read")!;
      expect(`${wiki.description()} ${read.description()}`).toContain("wiki_read is file drill-down");
      expect(`${wiki.description()} ${read.description()}`).toContain(
        "memory_knowledge_read stays the DB projection",
      );

      await expect(program.parseAsync(["node", "ms", "wiki", "read", "../outside.md"])).rejects.toMatchObject({
        code: "WIKI_PATH_TRAVERSAL",
      });
      await expect(program.parseAsync(["node", "ms", "wiki", "read", "notes.txt"])).rejects.toMatchObject({
        code: "WIKI_PATH_EXTENSION",
      });
      await program.parseAsync(["node", "ms", "wiki", "read", entry]);
      expect(lines.at(-1)).toContain(`"wikiPath":"${entry}"`);
      expect(lines.at(-1)).not.toContain(root);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("ms wiki read uses config wiki.root and does not open a database", async () => {
    cliHome = mkdtempSync(join(tmpdir(), "mengshu-wiki-cli-home-"));
    const root = join(cliHome, "wiki");
    mkdirSync(root);
    writeFileSync(join(cliHome, "config.json"), JSON.stringify({
      embedding: {
        apiKey: "test-key",
        baseURL: "http://127.0.0.1:9/v1",
        model: "text-embedding-3-small",
      },
      dbType: "lancedb",
      dbPath: join(cliHome, "lancedb"),
      wiki: { root },
    }));
    process.env.MENGSHU_HOME = cliHome;
    const createProvider = vi.spyOn(DatabaseFactory, "createProvider");
    try {
      await expect(runMengshuCli(["node", "ms", "wiki", "read", "../outside.md"])).rejects.toMatchObject({
        code: "WIKI_PATH_TRAVERSAL",
      });
      await expect(runMengshuCli(["node", "ms", "wiki", "read", "note.txt"])).rejects.toMatchObject({
        code: "WIKI_PATH_EXTENSION",
      });
      expect(createProvider).not.toHaveBeenCalled();
    } finally {
      createProvider.mockRestore();
    }
  });
});
