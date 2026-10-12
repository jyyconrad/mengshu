import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { IndexMaintainer } from "./index-maintainer.js";
import { WikiPathError } from "./root.js";

const TOTALS = "共 9581 页,49509 条来源记录。";
const PAGE_SECRET = "PAGE_SECRET_BODY_TOKEN";
const SOURCES_SECRET = "SOURCES_SECRET_TOKEN";
const RULE_SECRET = "RULE_SECRET_TITLE";
const OTHER_SECRET = "OTHER_SECRET_TITLE";
const OUTSIDE_SECRET = "OUTSIDE_SECRET_TOKEN";
const WRONG_SCOPE = "WRONG_SCOPE_FROM_ENTRY";
const WRONG_PATH = "pages/elsewhere/page-001.md";

function temporaryRoot(): { parent: string; root: string } {
  const parent = mkdtempSync(join(tmpdir(), "mengshu-wiki-w4-"));
  const root = join(parent, "wiki");
  mkdirSync(root);
  return { parent, root };
}

function write(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function entryMarkdown(input: {
  id: string;
  semanticType: string;
  title: string;
  updatedAt?: string;
  wikiPath: string;
}): string {
  const frontmatter = [
    "---",
    `id: ${input.id}`,
    "kind: knowledge",
    `scope_key: ${WRONG_SCOPE}`,
    `semantic_type: ${input.semanticType}`,
  ];
  if (input.updatedAt !== undefined) frontmatter.push(`updated_at: ${input.updatedAt}`);
  frontmatter.push(`wiki_path: ${input.wikiPath}`, "track: entry", "---", "", `# ${input.title}`, "", "Body stored in the database.", "");
  return frontmatter.join("\n");
}

function fusedIndex(): string {
  return [
    "# Mengshu Wiki 索引",
    "",
    TOTALS,
    "",
    "## local:mengshu:default:default:default:knowledge",
    "- experience: 2 页 / 4 来源",
    "- rules: 1 页 / 1 来源",
    "",
    "## local:mengshu:default:default:default:memories",
    "- rules: 1 页 / 1 来源",
    "",
  ].join("\n");
}

function lineCount(text: string, line: string): number {
  return text.split("\n").filter((item) => item === line).length;
}

describe("wiki index maintainer", () => {
  test("patches only ancestor indexes, preserves fused totals, and matches reindex", () => {
    const { parent, root } = temporaryRoot();
    const outside = join(parent, "outside.md");
    const knowledge = join(root, "pages", "default-knowledge");
    const experience = join(knowledge, "entries", "experience");
    const rules = join(knowledge, "entries", "rules");
    const otherProfile = join(root, "pages", "other", "entries", "profile");
    const fusedOnly = join(root, "pages", "fused-only");
    const page1 = join(knowledge, "page-001.md");
    const page2 = join(knowledge, "page-002.md");
    const sources = join(knowledge, "page-001.sources");
    const otherPage = join(root, "pages", "other", "page-009.md");
    const fusedOnlyPage = join(fusedOnly, "page-003.md");
    const ruleFile = join(rules, "rule-1.md");
    const otherFile = join(otherProfile, "p-1.md");
    const noTime = join(experience, "m-no-time.md");
    const completion = join(root, "completion.jsonl");
    const pathMap = join(root, "path-map.jsonl");
    const registry = join(root, "scope-registry.json");
    try {
      write(outside, OUTSIDE_SECRET);
      write(otherPage, `# Other fused\n\n${PAGE_SECRET}\n`);
      write(otherFile, entryMarkdown({
        id: "p-1",
        semanticType: "profile",
        title: OTHER_SECRET,
        updatedAt: "2026-10-12T08:09:10.000Z",
        wikiPath: WRONG_PATH,
      }));
      write(fusedOnlyPage, `# Fused only\n\n${PAGE_SECRET}\n`);
      write(join(root, "INDEX.md"), fusedIndex());
      write(registry, JSON.stringify({
        version: 1,
        scopes: [
          {
            slug: "default-knowledge",
            scopeKey: "local:mengshu:default:default:default:knowledge",
          },
          { slug: "other", scopeKey: "" },
        ],
      }));
      write(completion, `${JSON.stringify({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        page: "pages/default-knowledge/page-001.md",
        scope: "local:mengshu:default:default:default:knowledge",
        semanticType: "experience",
        status: "fused",
      })}\n`);
      write(pathMap, "part-005/page-001.md\tpages/default-knowledge/page-001.md\n");
      write(page1, `---\nkind: fused\n---\n\n# Fused\n\n${PAGE_SECRET}\n${TOTALS.replace("9581", "99999")}\n`);
      write(page2, `# Another fused page\n\n${PAGE_SECRET}\n`);
      write(sources, `${SOURCES_SECRET}\n`);
      // Create experience before rules so canonical type order is not readdir order.
      write(join(experience, "z-entry.md"), entryMarkdown({
        id: "ignored-frontmatter-id",
        semanticType: "experience",
        title: "Second",
        updatedAt: "2026-10-12T04:05:06.000Z",
        wikiPath: WRONG_PATH,
      }));
      write(join(experience, "a-entry.md"), entryMarkdown({
        id: "ignored-frontmatter-id",
        semanticType: "experience",
        title: "Keep | both",
        updatedAt: "2026-10-12T01:02:03.000Z",
        wikiPath: WRONG_PATH,
      }));
      write(noTime, entryMarkdown({
        id: "m-no-time",
        semanticType: "experience",
        title: "Plain note",
        wikiPath: WRONG_PATH,
      }));
      write(ruleFile, entryMarkdown({
        id: "rule-1",
        semanticType: "rules",
        title: RULE_SECRET,
        updatedAt: "2026-10-12T07:08:09.000Z",
        wikiPath: WRONG_PATH,
      }));
      symlinkSync(outside, join(experience, "evil.md"));

      const immutable = [page1, page2, sources, otherPage, fusedOnlyPage, ruleFile, otherFile, completion, pathMap, registry, noTime];
      const before = new Map(immutable.map((path) => [path, readFileSync(path, "utf8")]));
      const originalIndex = readFileSync(join(root, "INDEX.md"), "utf8");
      chmodSync(page1, 0);
      chmodSync(page2, 0);
      chmodSync(sources, 0);
      chmodSync(otherPage, 0);
      chmodSync(fusedOnlyPage, 0);
      chmodSync(ruleFile, 0);
      chmodSync(otherFile, 0);

      const maintainer = new IndexMaintainer({ root });
      const entryPath = join(experience, "a-entry.md");
      const writes = maintainer.touchAncestors(entryPath);
      expect(writes.map((item) => item.wikiPath)).toEqual([
        "pages/default-knowledge/entries/experience/INDEX.md",
        "pages/default-knowledge/entries/INDEX.md",
        "pages/default-knowledge/INDEX.md",
        "INDEX.md",
      ]);
      expect(writes.every((item) => item.changed)).toBe(true);
      expect(writes.every((item) => !item.wikiPath.includes("\\") && !item.wikiPath.startsWith("/"))).toBe(true);

      expect(existsSync(join(rules, "INDEX.md"))).toBe(false);
      expect(existsSync(join(root, "pages", "other", "INDEX.md"))).toBe(false);
      expect(existsSync(join(root, "pages", "other", "entries", "INDEX.md"))).toBe(false);
      expect(existsSync(join(otherProfile, "INDEX.md"))).toBe(false);
      expect(existsSync(join(fusedOnly, "INDEX.md"))).toBe(false);
      expect(existsSync(join(root, "material"))).toBe(false);
      expect(existsSync(entryPath)).toBe(true);

      const rootIndex = readFileSync(join(root, "INDEX.md"), "utf8");
      expect(rootIndex.startsWith(originalIndex)).toBe(true);
      expect(rootIndex.slice(originalIndex.length)).toMatch(/^\n<!-- mengshu-entries:start -->\n## Entries\n/);
      expect(lineCount(rootIndex, "## Entries")).toBe(1);
      for (const line of [
        TOTALS,
        "## local:mengshu:default:default:default:knowledge",
        "- experience: 2 页 / 4 来源",
        "- rules: 1 页 / 1 来源",
        "## local:mengshu:default:default:default:memories",
        "- rules: 1 页 / 1 来源",
      ]) {
        expect(lineCount(rootIndex, line)).toBe(lineCount(originalIndex, line));
      }
      expect(rootIndex).toContain(
        "| default-knowledge | local:mengshu:default:default:default:knowledge | 4 | [pages/default-knowledge/INDEX.md](pages/default-knowledge/INDEX.md) |",
      );
      expect(rootIndex).toContain("| other | other | 1 | [pages/other/INDEX.md](pages/other/INDEX.md) |");
      expect(rootIndex.indexOf("| default-knowledge |")).toBeLessThan(rootIndex.indexOf("| other |"));
      expect(rootIndex).not.toContain("fused-only");
      expect(rootIndex).not.toContain(WRONG_SCOPE);
      expect(rootIndex).not.toContain(WRONG_PATH);
      expect(rootIndex).not.toContain(PAGE_SECRET);
      expect(rootIndex).not.toContain(RULE_SECRET);
      expect(rootIndex).not.toContain(OTHER_SECRET);
      expect(rootIndex).not.toContain(OUTSIDE_SECRET);

      const l3 = readFileSync(join(experience, "INDEX.md"), "utf8");
      const mtime = statSync(noTime).mtime.toISOString();
      const aRow = "| a-entry | Keep \\| both | pages/default-knowledge/entries/experience/a-entry.md | 2026-10-12T01:02:03.000Z |";
      const mRow = `| m-no-time | Plain note | pages/default-knowledge/entries/experience/m-no-time.md | ${mtime} |`;
      const zRow = "| z-entry | Second | pages/default-knowledge/entries/experience/z-entry.md | 2026-10-12T04:05:06.000Z |";
      expect(l3.indexOf(aRow)).toBeGreaterThan(-1);
      expect(l3.indexOf(aRow)).toBeLessThan(l3.indexOf(mRow));
      expect(l3.indexOf(mRow)).toBeLessThan(l3.indexOf(zRow));
      expect(l3).not.toContain("evil");
      expect(l3).not.toContain("ignored-frontmatter-id");
      expect(l3).not.toContain(WRONG_PATH);
      expect(l3).not.toContain(PAGE_SECRET);
      expect(l3).not.toContain(RULE_SECRET);
      expect(l3).not.toContain(OUTSIDE_SECRET);

      const l2 = readFileSync(join(knowledge, "entries", "INDEX.md"), "utf8");
      expect(l2.indexOf("| rules | 1 |")).toBeLessThan(l2.indexOf("| experience | 3 |"));
      expect(l2).not.toContain(RULE_SECRET);
      expect(l2).not.toContain(PAGE_SECRET);

      const l1 = readFileSync(join(knowledge, "INDEX.md"), "utf8");
      expect(l1).toContain("- page_files: 2");
      expect(l1).toContain("- total: 4");
      expect(l1).toContain("- scope_key: local:mengshu:default:default:default:knowledge");
      expect(l1).not.toContain(TOTALS);
      expect(l1).not.toContain(PAGE_SECRET);
      expect(l1).not.toContain(SOURCES_SECRET);
      expect(l1).not.toContain("共 ");

      const again = maintainer.touchAncestors("pages/default-knowledge/entries/experience/a-entry.md");
      expect(again.every((item) => item.changed)).toBe(false);
      expect(readFileSync(join(root, "INDEX.md"), "utf8")).toBe(rootIndex);
      expect(readFileSync(join(experience, "INDEX.md"), "utf8")).toBe(l3);
      expect(readFileSync(join(knowledge, "entries", "INDEX.md"), "utf8")).toBe(l2);
      expect(readFileSync(join(knowledge, "INDEX.md"), "utf8")).toBe(l1);

      for (const path of [page1, page2, sources, otherPage, fusedOnlyPage, ruleFile, otherFile]) {
        chmodSync(path, 0o644);
      }
      for (const [path, text] of before) {
        expect(readFileSync(path, "utf8")).toBe(text);
      }
      expect(readFileSync(outside, "utf8")).toBe(OUTSIDE_SECRET);

      const reindexed = maintainer.reindexEntries();
      expect(readFileSync(join(root, "INDEX.md"), "utf8")).toBe(rootIndex);
      expect(readFileSync(join(experience, "INDEX.md"), "utf8")).toBe(l3);
      expect(readFileSync(join(knowledge, "entries", "INDEX.md"), "utf8")).toBe(l2);
      expect(readFileSync(join(knowledge, "INDEX.md"), "utf8")).toBe(l1);
      expect(existsSync(join(rules, "INDEX.md"))).toBe(true);
      expect(readFileSync(join(rules, "INDEX.md"), "utf8")).toContain(RULE_SECRET);
      expect(existsSync(join(root, "pages", "other", "INDEX.md"))).toBe(true);
      expect(existsSync(join(otherProfile, "INDEX.md"))).toBe(true);
      expect(readFileSync(join(otherProfile, "INDEX.md"), "utf8")).toContain(OTHER_SECRET);
      expect(existsSync(join(fusedOnly, "INDEX.md"))).toBe(false);
      expect(reindexed.every((item) => item.wikiPath !== "pages/fused-only/INDEX.md")).toBe(true);
      for (const [path, text] of before) {
        expect(readFileSync(path, "utf8")).toBe(text);
      }

      const second = maintainer.reindexEntries();
      expect(second.every((item) => item.changed)).toBe(false);
      expect(readFileSync(page1, "utf8")).toBe(before.get(page1));
      expect(readFileSync(sources, "utf8")).toBe(before.get(sources));
    } finally {
      restoreModes(root);
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("drops a deleted entry from ancestor indexes and stays aligned with reindex", () => {
    const { parent, root } = temporaryRoot();
    const experience = join(root, "pages", "default-knowledge", "entries", "experience");
    const entry = join(experience, "a-entry.md");
    const kept = join(experience, "b-entry.md");
    try {
      write(join(root, "INDEX.md"), fusedIndex());
      write(join(root, "pages", "default-knowledge", "page-001.md"), `# Fused\n\n${PAGE_SECRET}\n`);
      write(entry, entryMarkdown({
        id: "a-entry",
        semanticType: "experience",
        title: "Gone",
        updatedAt: "2026-10-12T01:02:03.000Z",
        wikiPath: WRONG_PATH,
      }));
      write(kept, entryMarkdown({
        id: "b-entry",
        semanticType: "experience",
        title: "Stays",
        updatedAt: "2026-10-12T04:05:06.000Z",
        wikiPath: WRONG_PATH,
      }));
      const maintainer = new IndexMaintainer({ root });
      maintainer.touchAncestors("pages/default-knowledge/entries/experience/a-entry.md");
      const pageBefore = readFileSync(join(root, "pages", "default-knowledge", "page-001.md"), "utf8");
      unlinkSync(entry);
      const writes = maintainer.touchAncestors("pages/default-knowledge/entries/experience/a-entry.md");
      expect(writes.map((item) => item.wikiPath)).toEqual([
        "pages/default-knowledge/entries/experience/INDEX.md",
        "pages/default-knowledge/entries/INDEX.md",
        "pages/default-knowledge/INDEX.md",
        "INDEX.md",
      ]);
      expect(existsSync(entry)).toBe(false);
      const l3 = readFileSync(join(experience, "INDEX.md"), "utf8");
      expect(l3).not.toContain("a-entry");
      expect(l3).toContain("b-entry");
      expect(readFileSync(join(root, "INDEX.md"), "utf8")).toContain(
        "| default-knowledge | default-knowledge | 1 |",
      );
      expect(readFileSync(join(root, "pages", "default-knowledge", "page-001.md"), "utf8")).toBe(pageBefore);
      expect(readFileSync(join(root, "INDEX.md"), "utf8")).toContain(TOTALS);

      const touchedRoot = readFileSync(join(root, "INDEX.md"), "utf8");
      const touchedL1 = readFileSync(join(root, "pages", "default-knowledge", "INDEX.md"), "utf8");
      const touchedL2 = readFileSync(join(root, "pages", "default-knowledge", "entries", "INDEX.md"), "utf8");
      maintainer.reindexEntries();
      expect(readFileSync(join(root, "INDEX.md"), "utf8")).toBe(touchedRoot);
      expect(readFileSync(join(root, "pages", "default-knowledge", "INDEX.md"), "utf8")).toBe(touchedL1);
      expect(readFileSync(join(root, "pages", "default-knowledge", "entries", "INDEX.md"), "utf8")).toBe(touchedL2);
      expect(readFileSync(join(experience, "INDEX.md"), "utf8")).toBe(l3);
      expect(maintainer.touchAncestors(entry).every((item) => item.changed)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("rejects non-entry paths and symlinks without writing indexes", () => {
    const { parent, root } = temporaryRoot();
    const outside = join(parent, "outside.md");
    const experience = join(root, "pages", "default-knowledge", "entries", "experience");
    try {
      write(outside, OUTSIDE_SECRET);
      write(join(root, "INDEX.md"), fusedIndex());
      write(join(experience, "a-entry.md"), "# A\n");
      symlinkSync(outside, join(experience, "evil.md"));
      const original = readFileSync(join(root, "INDEX.md"), "utf8");
      const maintainer = new IndexMaintainer({ root });

      expect(() => maintainer.touchAncestors("pages/default-knowledge/page-001.md")).toThrow(WikiPathError);
      expect(() => maintainer.touchAncestors("../outside.md")).toThrow(
        expect.objectContaining({ code: "WIKI_PATH_TRAVERSAL" }),
      );
      expect(() => maintainer.touchAncestors("pages/default-knowledge/entries/experience/INDEX.md")).toThrow(
        /pages\/<slug>/,
      );
      expect(() => maintainer.touchAncestors("pages/default-knowledge/entries/not-a-type/a.md")).toThrow(
        WikiPathError,
      );
      expect(() => maintainer.touchAncestors("pages/default-knowledge/entries/experience/evil.md")).toThrow(
        expect.objectContaining({ code: "WIKI_PATH_SYMLINK" }),
      );
      expect(() => new IndexMaintainer({ root: "relative/wiki" })).toThrow(WikiPathError);
      expect(() => new IndexMaintainer({ root, entriesDirName: "../entries" })).toThrow(/path segment/);

      expect(readFileSync(join(root, "INDEX.md"), "utf8")).toBe(original);
      expect(existsSync(join(root, "pages", "default-knowledge", "INDEX.md"))).toBe(false);
      expect(existsSync(join(experience, "INDEX.md"))).toBe(false);
      expect(readFileSync(outside, "utf8")).toBe(OUTSIDE_SECRET);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("an index write failure leaves the entry file in place", () => {
    const { parent, root } = temporaryRoot();
    const experience = join(root, "pages", "default-knowledge", "entries", "experience");
    const entry = join(experience, "a-entry.md");
    try {
      write(join(root, "INDEX.md"), fusedIndex());
      write(entry, entryMarkdown({
        id: "a-entry",
        semanticType: "experience",
        title: "Keep me",
        updatedAt: "2026-10-12T01:02:03.000Z",
        wikiPath: WRONG_PATH,
      }));
      const entryText = readFileSync(entry, "utf8");
      const rootText = readFileSync(join(root, "INDEX.md"), "utf8");
      chmodSync(experience, 0o555);
      const maintainer = new IndexMaintainer({ root });
      expect(() => maintainer.touchAncestors("pages/default-knowledge/entries/experience/a-entry.md")).toThrow();
      expect(readFileSync(entry, "utf8")).toBe(entryText);
      expect(readFileSync(join(root, "INDEX.md"), "utf8")).toBe(rootText);
      expect(existsSync(join(experience, "INDEX.md"))).toBe(false);
      expect(existsSync(join(root, "pages", "default-knowledge", "entries", "INDEX.md"))).toBe(false);
    } finally {
      restoreModes(root);
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("uses the configured entries directory and does not invent fused totals", () => {
    const { parent, root } = temporaryRoot();
    const typeDir = join(root, "pages", "default-knowledge", "track-e", "rules");
    const page = join(root, "pages", "default-knowledge", "page-004.md");
    try {
      write(page, `# Fused\n\n${PAGE_SECRET}\n`);
      write(join(typeDir, "rule-9.md"), entryMarkdown({
        id: "rule-9",
        semanticType: "rules",
        title: "Custom dir",
        updatedAt: "2026-10-12T01:02:03.000Z",
        wikiPath: WRONG_PATH,
      }));
      chmodSync(page, 0);
      const maintainer = new IndexMaintainer({ root, entriesDirName: "track-e" });
      const writes = maintainer.touchAncestors("pages/default-knowledge/track-e/rules/rule-9.md");
      expect(writes.map((item) => item.wikiPath)).toEqual([
        "pages/default-knowledge/track-e/rules/INDEX.md",
        "pages/default-knowledge/track-e/INDEX.md",
        "pages/default-knowledge/INDEX.md",
        "INDEX.md",
      ]);
      const rootIndex = readFileSync(join(root, "INDEX.md"), "utf8");
      expect(rootIndex).not.toContain(TOTALS);
      expect(rootIndex).not.toContain("共 ");
      expect(rootIndex).toContain("pages/<slug>/track-e/");
      expect(rootIndex).toContain("| default-knowledge | default-knowledge | 1 |");
      const l1 = readFileSync(join(root, "pages", "default-knowledge", "INDEX.md"), "utf8");
      expect(l1).toContain("- page_files: 1");
      expect(l1).not.toContain(PAGE_SECRET);
      expect(readFileSync(join(typeDir, "INDEX.md"), "utf8")).toContain(
        "pages/default-knowledge/track-e/rules/rule-9.md",
      );
      expect(existsSync(join(root, "pages", "default-knowledge", "entries"))).toBe(false);
      chmodSync(page, 0o644);
      expect(readFileSync(page, "utf8")).toContain(PAGE_SECRET);
    } finally {
      restoreModes(root);
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

function restoreModes(root: string): void {
  if (!existsSync(root)) return;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) continue;
      chmodSync(current, stat.isDirectory() ? 0o755 : 0o644);
      if (!stat.isDirectory()) continue;
      for (const name of readdirSync(current)) stack.push(join(current, name));
    } catch {
      // Best-effort: a locked temp file must not hide the assertion error.
    }
  }
}
