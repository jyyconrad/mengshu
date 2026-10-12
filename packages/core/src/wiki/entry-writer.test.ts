import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { EntryWriteError, EntryWriter, type WikiEntryWriteInput } from "./entry-writer.js";
import { WikiPathError } from "./root.js";

const ID = "11111111-1111-4111-8111-111111111111";
const UPDATED = "2026-10-12T00:00:00.000Z";
const KNOWLEDGE_SCOPE = "local:mengshu:default:default:agent:knowledge";

function withTemp(prefix: string, run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        out.push(rel);
        continue;
      }
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else out.push(rel);
    }
  };
  walk(root, "");
  return out.sort();
}

function entryInput(overrides: Partial<WikiEntryWriteInput> = {}): WikiEntryWriteInput {
  return {
    id: ID,
    kind: "memory",
    text: "Remember the valve schedule",
    updatedAt: UPDATED,
    ...overrides,
  };
}

describe("wiki entry writer", () => {
  test("writes Track E frontmatter under an unscoped slug and does not create the root early", async () => {
    await withTemp("mengshu-wiki-w2-entry-", async (parent) => {
      const root = join(parent, "wiki");
      const writer = new EntryWriter({ root, now: () => new Date(UPDATED) });
      expect(existsSync(root)).toBe(false);

      const result = await writer.write(entryInput());
      const wikiPath = `pages/__unscoped__/entries/unclassified/${ID}.md`;
      expect(result).toEqual({ wikiPath, wikiTrack: "entry", movedFrom: [] });
      expect(result.wikiPath.includes("\\")).toBe(false);
      const markdown = readFileSync(join(root, wikiPath), "utf8");
      expect(markdown).toBe([
        "---",
        `id: ${ID}`,
        "kind: memory",
        "scope_key: __unscoped__",
        "semantic_type: unclassified",
        `updated_at: ${UPDATED}`,
        `wiki_path: ${wikiPath}`,
        "track: entry",
        "---",
        "",
        "# Remember the valve schedule",
        "",
        "Remember the valve schedule",
        "",
      ].join("\n"));
      expect(markdown).not.toContain(root);
      expect(filesUnder(root)).toEqual([wikiPath]);
    });
  });

  test("uses the scope registry slug, keeps fused pages, and renders the whitelist meta", async () => {
    await withTemp("mengshu-wiki-w2-registry-", async (parent) => {
      const root = join(parent, "wiki");
      mkdirSync(join(root, "pages", "default-knowledge"), { recursive: true });
      const registry = `${JSON.stringify({
        version: 1,
        scopes: [
          { slug: "default-knowledge", scopeKey: KNOWLEDGE_SCOPE },
          { slug: "default-memories", scopeKey: "local:mengshu:default:default:agent:memories" },
          { slug: "../oops", scopeKey: "local:t:u:ok-ws:a:b" },
        ],
      }, null, 2)}\n`;
      writeFileSync(join(root, "scope-registry.json"), registry, "utf8");
      writeFileSync(join(root, "INDEX.md"), "fused index\n", "utf8");
      writeFileSync(join(root, "completion.jsonl"), "{\"id\":\"x\",\"status\":\"fused\"}\n", "utf8");
      const page = join(root, "pages", "default-knowledge", "page-001.md");
      const sources = join(root, "pages", "default-knowledge", "page-001.sources");
      writeFileSync(page, "FUSED-BODY\n", "utf8");
      writeFileSync(sources, "FUSED-SOURCES\n", "utf8");
      const pageStat = statSync(page);
      const sourcesStat = statSync(sources);
      chmodSync(page, 0o000);
      chmodSync(sources, 0o000);

      const wikiPath = `pages/default-knowledge/entries/experience/${ID}.md`;
      try {
        const result = await new EntryWriter({ root }).write(entryInput({
          kind: "knowledge",
          scopeKey: KNOWLEDGE_SCOPE,
          semanticType: "experience",
          title: "  Valve schedule  ",
          text: "first line\nsecond line\n",
          source: "agent\n- admissionRoute: injected",
          admissionRoute: "candidate_low_priority",
          previousWikiPath: "pages/default-knowledge/page-001.md",
        }));
        expect(result).toEqual({ wikiPath, wikiTrack: "entry", movedFrom: [] });
      } finally {
        chmodSync(page, 0o644);
        chmodSync(sources, 0o644);
      }

      expect(readFileSync(page, "utf8")).toBe("FUSED-BODY\n");
      expect(readFileSync(sources, "utf8")).toBe("FUSED-SOURCES\n");
      expect(statSync(page).ino).toBe(pageStat.ino);
      expect(statSync(sources).ino).toBe(sourcesStat.ino);
      expect(readFileSync(join(root, "INDEX.md"), "utf8")).toBe("fused index\n");
      expect(readFileSync(join(root, "completion.jsonl"), "utf8")).toBe("{\"id\":\"x\",\"status\":\"fused\"}\n");
      expect(readFileSync(join(root, "scope-registry.json"), "utf8")).toBe(registry);
      expect(existsSync(join(root, "pages", "default-knowledge", "INDEX.md"))).toBe(false);
      expect(existsSync(join(root, "pages", "default-knowledge", "entries", "INDEX.md"))).toBe(false);
      expect(existsSync(join(parent, "oops"))).toBe(false);
      const markdown = readFileSync(join(root, wikiPath), "utf8");
      expect(markdown).toBe([
        "---",
        `id: ${ID}`,
        "kind: knowledge",
        `scope_key: ${KNOWLEDGE_SCOPE}`,
        "semantic_type: experience",
        `updated_at: ${UPDATED}`,
        `wiki_path: ${wikiPath}`,
        "track: entry",
        "---",
        "",
        "# Valve schedule",
        "",
        "first line",
        "second line",
        "",
        "## Meta",
        "",
        "- source: agent - admissionRoute: injected",
        "- admissionRoute: candidate_low_priority",
        "",
      ].join("\n"));
      expect(filesUnder(root).filter((rel) => rel.endsWith(".sources") || /\/page-.*\.md$/.test(rel))).toEqual([
        "pages/default-knowledge/page-001.md",
        "pages/default-knowledge/page-001.sources",
      ]);
    });
  });

  test("overwrites the same path and moves the file when scope or semantic type changes", async () => {
    await withTemp("mengshu-wiki-w2-move-", async (root) => {
      let now = new Date(UPDATED);
      const writer = new EntryWriter({ root, now: () => now });
      const first = await writer.write(entryInput({
        scopeKey: "alpha-workspace",
        semanticType: "rules",
        text: "before",
        updatedAt: undefined,
      }));
      expect(first.wikiPath).toBe(`pages/alpha-workspace/entries/rules/${ID}.md`);

      now = new Date("2026-10-13T01:02:03.000Z");
      const updated = await writer.write(entryInput({
        scopeKey: "alpha-workspace",
        semanticType: "rules",
        text: "after",
        updatedAt: undefined,
      }));
      expect(updated).toEqual({ wikiPath: first.wikiPath, wikiTrack: "entry", movedFrom: [] });
      const updatedText = readFileSync(join(root, first.wikiPath), "utf8");
      expect(updatedText).toContain("updated_at: 2026-10-13T01:02:03.000Z");
      expect(updatedText).toContain("\nafter\n");
      expect(updatedText).not.toContain("before");

      const extra = join(root, "pages", "alpha-workspace", "entries", "experience", `${ID}.md`);
      mkdirSync(join(root, "pages", "alpha-workspace", "entries", "experience"), { recursive: true });
      writeFileSync(extra, "stale\n", "utf8");
      const typed = await writer.write(entryInput({
        scopeKey: "alpha-workspace",
        semanticType: "profile",
        text: "typed",
      }));
      expect(typed.wikiPath).toBe(`pages/alpha-workspace/entries/profile/${ID}.md`);
      expect(typed.movedFrom).toEqual([
        `pages/alpha-workspace/entries/experience/${ID}.md`,
        `pages/alpha-workspace/entries/rules/${ID}.md`,
      ]);
      expect(existsSync(join(root, first.wikiPath))).toBe(false);
      expect(existsSync(extra)).toBe(false);

      const moved = await writer.write(entryInput({
        scopeKey: "beta-workspace",
        semanticType: "task_context",
        text: "moved",
      }));
      expect(moved).toEqual({
        wikiPath: `pages/beta-workspace/entries/task_context/${ID}.md`,
        wikiTrack: "entry",
        movedFrom: [typed.wikiPath],
      });
      expect(existsSync(join(root, typed.wikiPath))).toBe(false);
      const movedText = readFileSync(join(root, moved.wikiPath), "utf8");
      expect(movedText).toContain("scope_key: beta-workspace");
      expect(movedText).toContain(`wiki_path: ${moved.wikiPath}`);
      expect(filesUnder(root).filter((rel) => rel.endsWith(`${ID}.md`))).toEqual([moved.wikiPath]);
      expect(filesUnder(root).some((rel) => rel.includes(".tmp-") || rel.endsWith(".sources") || /page-.*\.md$/.test(rel))).toBe(false);
    });
  });

  test("slugifies unknown scope keys and disambiguates against the registry", async () => {
    await withTemp("mengshu-wiki-w2-slug-", async (root) => {
      const writer = new EntryWriter({ root, now: () => new Date(UPDATED) });
      const legacy = "local:mengshu:default:knowledge-legacy-tech-writer:default:knowledge";
      const legacyResult = await writer.write(entryInput({
        scopeKey: legacy,
        semanticType: "rules",
      }));
      expect(legacyResult.wikiPath).toBe(
        `pages/knowledge-legacy-tech-writer/entries/rules/${ID}.md`,
      );

      const short = await writer.write(entryInput({
        id: "22222222-2222-4222-8222-222222222222",
        scopeKey: "local:only-four",
        semanticType: "resource",
      }));
      expect(short.wikiPath).toBe("pages/local-only-four/entries/resource/22222222-2222-4222-8222-222222222222.md");

      const spaced = await writer.write(entryInput({
        id: "33333333-3333-4333-8333-333333333333",
        scopeKey: "Bad Name",
        semanticType: "Rules",
      }));
      expect(spaced.wikiPath).toBe("pages/bad-name/entries/unclassified/33333333-3333-4333-8333-333333333333.md");
      expect(readFileSync(join(root, spaced.wikiPath), "utf8")).toContain('scope_key: "Bad Name"');

      const unicodeKey = "local:t:u:项目:agent:knowledge";
      const unicodeHash = createHash("sha256").update(unicodeKey, "utf8").digest("hex").slice(0, 12);
      const unicode = await writer.write(entryInput({
        id: "44444444-4444-4444-8444-444444444444",
        scopeKey: unicodeKey,
        semanticType: "rules",
      }));
      expect(unicode.wikiPath).toBe(`pages/scope-${unicodeHash}/entries/rules/44444444-4444-4444-8444-444444444444.md`);

      const takenKey = "local:t:u:my-ws:agent:knowledge";
      const takenHash = createHash("sha256").update(takenKey, "utf8").digest("hex").slice(0, 8);
      writeFileSync(join(root, "scope-registry.json"), JSON.stringify({
        scopes: [
          { scopeKey: "other-a", slug: "my-ws" },
          { scopeKey: "other-b", slug: "my-ws-knowledge" },
        ],
      }), "utf8");
      const collided = await writer.write(entryInput({
        id: "55555555-5555-4555-8555-555555555555",
        scopeKey: takenKey,
        semanticType: "rules",
      }));
      expect(collided.wikiPath).toBe(`pages/my-ws-${takenHash}/entries/rules/55555555-5555-4555-8555-555555555555.md`);
    });
  });

  test("honors entriesDirName and ~ expansion without writing a top-level material tree", async () => {
    await withTemp("mengshu-wiki-w2-config-", async (parent) => {
      const home = join(parent, "home");
      mkdirSync(home);
      const writer = new EntryWriter({
        root: "~/wiki-w2",
        home,
        entriesDirName: "track-e",
        now: () => new Date(UPDATED),
      });
      const result = await writer.write(entryInput({
        scopeKey: "alpha-workspace",
        semanticType: "task_context",
      }));
      expect(result.wikiPath).toBe(`pages/alpha-workspace/track-e/task_context/${ID}.md`);
      const wiki = join(home, "wiki-w2");
      expect(existsSync(join(wiki, result.wikiPath))).toBe(true);
      expect(existsSync(join(wiki, "pages", "alpha-workspace", "entries"))).toBe(false);
      expect(existsSync(join(wiki, "material"))).toBe(false);
      expect(readFileSync(join(wiki, result.wikiPath), "utf8")).not.toContain(home);
    });
  });

  test("rejects unsafe ids, kinds, routes, and roots before creating entries", async () => {
    await withTemp("mengshu-wiki-w2-reject-", async (parent) => {
      const root = join(parent, "wiki");
      mkdirSync(root);
      const writer = new EntryWriter({ root, now: () => new Date(UPDATED) });
      await expect(writer.write(entryInput({ id: "page-001" }))).rejects.toMatchObject({
        name: "EntryWriteError",
        code: "ENTRY_PROTECTED_PATH",
      });
      await expect(writer.write(entryInput({ id: "../evil" }))).rejects.toBeInstanceOf(EntryWriteError);
      await expect(writer.write(entryInput({ kind: "fact" as "memory" }))).rejects.toMatchObject({
        code: "ENTRY_INPUT_INVALID",
      });
      await expect(writer.write(entryInput({ admissionRoute: "fused" }))).rejects.toMatchObject({
        code: "ENTRY_INPUT_INVALID",
      });
      await expect(writer.write(entryInput({
        previousWikiPath: "../outside.md",
      }))).rejects.toMatchObject({ code: "WIKI_PATH_TRAVERSAL" });
      expect(existsSync(join(root, "pages"))).toBe(false);
      expect(() => new EntryWriter({ root: "relative/wiki" })).toThrow(WikiPathError);
      expect(() => new EntryWriter({ root, entriesDirName: "../entries" })).toThrow(WikiPathError);
      expect(existsSync(join(root, "pages"))).toBe(false);
    });
  });

  test("a failed wiki write does not roll back a committed memory or the previous entry", async () => {
    await withTemp("mengshu-wiki-w2-fail-", async (parent) => {
      const root = join(parent, "wiki");
      const sentinel = join(parent, "memory-row.json");
      writeFileSync(sentinel, `{"id":"${ID}","status":"committed"}\n`, "utf8");
      const writer = new EntryWriter({ root, now: () => new Date(UPDATED) });
      const first = await writer.write(entryInput({
        scopeKey: "alpha-workspace",
        semanticType: "rules",
        text: "kept",
      }));
      const before = readFileSync(join(root, first.wikiPath), "utf8");
      const failing = new EntryWriter({
        root,
        now: () => new Date("2026-10-13T00:00:00.000Z"),
        beforeRename: () => {
          throw new Error("disk full");
        },
      });

      await expect(failing.write(entryInput({
        scopeKey: "beta-workspace",
        semanticType: "experience",
        text: "lost",
      }))).rejects.toMatchObject({
        code: "ENTRY_WRITE_FAILED",
        message: expect.stringMatching(/must not be rolled back/),
      });

      expect(readFileSync(sentinel, "utf8")).toBe(`{"id":"${ID}","status":"committed"}\n`);
      expect(readFileSync(join(root, first.wikiPath), "utf8")).toBe(before);
      expect(existsSync(join(root, `pages/beta-workspace/entries/experience/${ID}.md`))).toBe(false);
      expect(filesUnder(root).some((rel) => rel.includes(".tmp-"))).toBe(false);
      expect(filesUnder(parent).filter((rel) => rel.endsWith(`${ID}.md`))).toEqual([
        `wiki/${first.wikiPath}`,
      ]);
    });
  });

  test("does not follow a symlinked root, page directory, or entry file", async () => {
    await withTemp("mengshu-wiki-w2-link-", async (parent) => {
      const real = join(parent, "real");
      const outside = join(parent, "outside");
      const rootLink = join(parent, "root-link");
      mkdirSync(real);
      mkdirSync(outside);
      writeFileSync(join(outside, "secret.md"), "secret\n", "utf8");
      symlinkSync(real, rootLink, "dir");
      await expect(new EntryWriter({ root: rootLink }).write(entryInput())).rejects.toMatchObject({
        code: "WIKI_PATH_SYMLINK",
      });
      expect(readdirSync(real)).toEqual([]);
      expect(readFileSync(join(outside, "secret.md"), "utf8")).toBe("secret\n");

      const root = join(parent, "wiki");
      mkdirSync(root);
      symlinkSync(outside, join(root, "pages"), "dir");
      await expect(new EntryWriter({ root }).write(entryInput())).rejects.toMatchObject({
        code: "WIKI_PATH_SYMLINK",
      });
      expect(readdirSync(outside)).toEqual(["secret.md"]);

      const plain = join(parent, "plain");
      const entryDir = join(plain, "pages", "alpha-workspace", "entries", "rules");
      mkdirSync(entryDir, { recursive: true });
      symlinkSync(join(outside, "secret.md"), join(entryDir, `${ID}.md`), "file");
      await expect(new EntryWriter({ root: plain }).write(entryInput({
        scopeKey: "alpha-workspace",
        semanticType: "rules",
      }))).rejects.toMatchObject({ code: "WIKI_PATH_SYMLINK" });
      expect(readFileSync(join(outside, "secret.md"), "utf8")).toBe("secret\n");
      expect(existsSync(join(entryDir, `${ID}.md`))).toBe(true);
    });
  });
});
