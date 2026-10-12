import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { createMcpMemoryTools } from "./tools.js";

describe("memory_wiki_read", () => {
  test("tool text says file drill-down and keeps knowledge_read as the DB projection", () => {
    const tools = createMcpMemoryTools({
      unsafeLegacyScope: true,
      service: {} as never,
      wikiRoot: tmpdir(),
      knowledgeResources: {
        search: async () => ({ resources: [] }),
        read: async () => ({ resource: undefined }),
      } as never,
    });
    const wiki = tools.find((tool) => tool.name === "memory_wiki_read");
    const knowledge = tools.find((tool) => tool.name === "memory_knowledge_read");
    expect(wiki?.description).toContain("wiki_read is file drill-down");
    expect(wiki?.description).toContain("memory_knowledge_read stays the DB projection");
    expect(knowledge?.description).toContain("wiki_read is file drill-down");
    expect(knowledge?.description).toContain("memory_knowledge_read stays the DB projection");
  });

  test("rejects ../ and non-md and returns only a relative path for a real markdown file", async () => {
    const parent = mkdtempSync(join(tmpdir(), "mengshu-mcp-wiki-read-"));
    const root = join(parent, "wiki");
    const fused = "pages/default-knowledge/page-019.md";
    try {
      mkdirSync(join(root, "pages/default-knowledge"), { recursive: true });
      writeFileSync(join(root, fused), "fused body", "utf8");
      const tool = createMcpMemoryTools({
        unsafeLegacyScope: true,
        service: {} as never,
        wikiRoot: root,
      }).find((item) => item.name === "memory_wiki_read")!;

      await expect(tool.execute({ path: "../outside.md" })).rejects.toThrow(/WIKI_PATH_TRAVERSAL/);
      await expect(tool.execute({ path: "pages/../../outside.md" })).rejects.toThrow(/WIKI_PATH_TRAVERSAL/);
      await expect(tool.execute({ path: "notes.txt" })).rejects.toThrow(/WIKI_PATH_EXTENSION/);
      await expect(tool.execute({ path: "page-019.sources" })).rejects.toThrow(/WIKI_PATH_EXTENSION/);
      await expect(tool.execute({ path: "../outside.md", wikiRoot: parent })).rejects.toThrow(
        /accepts only path and maxChars/,
      );

      const read = await tool.execute({ path: fused, maxChars: 5 });
      expect(read).toEqual({
        wikiPath: fused,
        content: "fused",
        truncated: true,
        totalChars: "fused body".length,
      });
      expect(JSON.stringify(read)).not.toContain(root);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
