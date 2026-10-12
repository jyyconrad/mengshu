import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Command } from "commander";

import { DatabaseFactory } from "../../../core/src/db/factory.js";
import type { DatabaseProvider, MemoryEntry, TableName } from "../../../core/src/db/types.js";
import { loadWikiBackfillRows, type WikiBackfillRow } from "../../../core/src/wiki/entry-backfill.js";
import { registerWikiCliCommands } from "./ms.js";

const FUSED = "pages/default-knowledge/page-001.md";
const FUSED_BODY = "FUSED-BODY\n";
const SOURCES = "pages/default-knowledge/page-001.sources";
const SOURCES_BODY = "SOURCES-BODY\n";
const PRESENT = "pages/default-memories/entries/rules/mem-present.md";
const PRESENT_BODY = "KEEP-PRESENT\n";
const BLOCKED = "pages/blocked";
const BLOCKED_BODY = "NOT-A-DIR\n";
const INDEX_BODY = "FUSED TOTAL 9581\n";
const COMPLETION_BODY = "fused-line\n";

interface StoredRow extends WikiBackfillRow {
  text: string;
}

let createProvider: { mockRestore(): void; mock: { calls: unknown[][] } } | undefined;

afterEach(() => {
  createProvider?.mockRestore();
  createProvider = undefined;
});

describe("ms wiki backfill-entries", () => {
  test("dry-run is the default and --apply writes only missing entry files", async () => {
    const parent = mkdtempSync(join(tmpdir(), "mengshu-wiki-backfill-"));
    const root = join(parent, "wiki");
    const banned = join(homedir(), ".mengshu");
    expect(root.startsWith(banned)).toBe(false);
    createProvider = vi.spyOn(DatabaseFactory, "createProvider");
    const stored = seedRows();
    const lines: string[] = [];
    let metadataCalls = 0;
    try {
      seedWiki(root);
      const frozen = snapshot(root);

      await run(parent, root, lines, stored, async () => {
        metadataCalls += 1;
        throw new Error("dry-run must not patch metadata");
      }, ["wiki", "backfill-entries"]);

      expect(metadataCalls).toBe(0);
      expect(snapshot(root)).toEqual(frozen);
      expect(createProvider.mock.calls).toEqual([]);
      const dry = JSON.parse(lines.at(-1) ?? "{}") as {
        mode: string;
        eligible: Array<{ id: string; wikiPath: string }>;
        skippedFused: Array<{ id: string; wikiPath: string }>;
        skippedPresent: Array<{ id: string }>;
        written: unknown[];
        reindexed: unknown;
        failed: Array<{ id: string }>;
      };
      expect(dry.mode).toBe("dry-run");
      expect(dry.written).toEqual([]);
      expect(dry.reindexed).toBeNull();
      expect(dry.skippedFused.map((item) => item.id)).toEqual(["know-fused"]);
      expect(dry.skippedFused[0]?.wikiPath).toBe(FUSED);
      expect(dry.skippedPresent.map((item) => item.id)).toEqual(["mem-present"]);
      expect(dry.eligible.map((item) => item.id)).toEqual(["mem-missing", "mem-none", "know-none"]);
      expect(dry.failed.map((item) => item.id)).toEqual(["mem-blocked"]);
      expect(dry.eligible.every((item) => item.wikiPath.startsWith("pages/") && !item.wikiPath.includes("\\"))).toBe(true);
      expect(lines.at(-1)).not.toContain(root);
      expect(lines.at(-1)).not.toContain(banned);

      lines.length = 0;
      await run(parent, root, lines, stored, async ({ id, patch }) => {
        metadataCalls += 1;
        const current = stored.get(id);
        if (!current) throw new Error(`missing committed row ${id}`);
        if (id === "mem-blocked") throw new Error("metadata patch failed");
        stored.set(id, {
          ...current,
          wikiPath: typeof patch.wikiPath === "string" ? patch.wikiPath : current.wikiPath,
          text: current.text,
        });
        if (patch.wikiStatus === "error") {
          stored.set(id, { ...stored.get(id)!, wikiPath: current.wikiPath ?? null });
        }
      }, ["wiki", "backfill-entries", "--apply"]);

      const applied = JSON.parse(lines.at(-1) ?? "{}") as {
        mode: string;
        written: Array<{ id: string; wikiPath: string }>;
        skippedFused: Array<{ id: string }>;
        metadataPatched: Array<{ id: string; wikiPath: string }>;
        failed: Array<{ id: string }>;
        reindexed: Array<{ wikiPath: string }> | null;
      };
      expect(applied.mode).toBe("apply");
      expect(applied.skippedFused.map((item) => item.id)).toEqual(["know-fused"]);
      expect(applied.written.map((item) => item.id)).toEqual(["mem-missing", "mem-none", "know-none"]);
      expect(applied.failed.map((item) => item.id)).toEqual(["mem-blocked"]);
      expect(applied.metadataPatched.map((item) => item.id)).toEqual(["mem-missing", "mem-none", "know-none"]);
      for (const item of applied.metadataPatched) {
        expect(item.wikiPath.startsWith("pages/")).toBe(true);
        expect(item.wikiPath.includes("entries")).toBe(true);
        expect(item.wikiPath.includes("\\")).toBe(false);
        expect(item.wikiPath.startsWith("/")).toBe(false);
        expect(item.wikiPath).not.toContain(root);
        expect(readFileSync(join(root, item.wikiPath), "utf8")).toContain(`wiki_path: ${item.wikiPath}`);
      }
      expect(applied.reindexed?.some((item) => item.wikiPath === "INDEX.md")).toBe(true);
      expect(applied.reindexed?.every((item) => item.wikiPath === "INDEX.md" || item.wikiPath.endsWith("/INDEX.md"))).toBe(true);
      expect(readFileSync(join(root, FUSED), "utf8")).toBe(FUSED_BODY);
      expect(readFileSync(join(root, SOURCES), "utf8")).toBe(SOURCES_BODY);
      expect(readFileSync(join(root, PRESENT), "utf8")).toBe(PRESENT_BODY);
      expect(readFileSync(join(root, BLOCKED), "utf8")).toBe(BLOCKED_BODY);
      expect(readFileSync(join(root, "completion.jsonl"), "utf8")).toBe(COMPLETION_BODY);
      expect(readFileSync(join(root, "INDEX.md"), "utf8")).toContain("FUSED TOTAL 9581");
      expect(readFileSync(join(root, "INDEX.md"), "utf8")).toContain("mengshu-entries:start");
      expect(existsSync(join(root, "pages/default-knowledge/entries/experience/know-none.md"))).toBe(true);
      expect(existsSync(join(root, "pages/blocked/entries"))).toBe(false);
      expect(stored.get("mem-blocked")?.text).toBe("blocked body");
      expect(stored.get("know-fused")?.wikiPath).toBe(FUSED);
      expect(stored.get("mem-present")?.text).toBe("present body");
      expect(relativeFiles(root).some((path) => path.startsWith("material/"))).toBe(false);
      expect(relativeFiles(root).filter((path) => path.endsWith(".sources"))).toEqual([SOURCES]);
      expect(createProvider.mock.calls).toEqual([]);
      expect(lines.at(-1)).not.toContain(root);
      expect(lines.at(-1)).not.toContain(banned);

      rmSync(join(root, "pages/default-memories/entries/INDEX.md"));
      lines.length = 0;
      await run(parent, root, lines, stored, async () => undefined, ["wiki", "reindex", "entries"]);
      const reindexed = JSON.parse(lines.at(-1) ?? "{}") as { reindexed: Array<{ wikiPath: string }> };
      expect(reindexed.reindexed.some((item) => item.wikiPath === "pages/default-memories/entries/INDEX.md")).toBe(true);
      expect(readFileSync(join(root, FUSED), "utf8")).toBe(FUSED_BODY);
      expect(readFileSync(join(root, SOURCES), "utf8")).toBe(SOURCES_BODY);
      expect(createProvider.mock.calls).toEqual([]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("--limit and --kind narrow the sample, and conflicting flags write nothing", async () => {
    const parent = mkdtempSync(join(tmpdir(), "mengshu-wiki-backfill-limit-"));
    const root = join(parent, "wiki");
    const stored = seedRows();
    const lines: string[] = [];
    try {
      seedWiki(root);
      await run(parent, root, lines, stored, async () => undefined, [
        "wiki", "backfill-entries", "--apply", "--limit", "1", "--kind", "memories",
      ]);
      const report = JSON.parse(lines.at(-1) ?? "{}") as {
        written: Array<{ id: string; wikiPath: string }>;
        eligible: Array<{ id: string }>;
      };
      expect(report.eligible.map((item) => item.id)).toEqual(["mem-missing"]);
      expect(report.written.map((item) => item.id)).toEqual(["mem-missing"]);
      expect(existsSync(join(root, "pages/default-knowledge/entries/experience/know-none.md"))).toBe(false);
      expect(readFileSync(join(root, FUSED), "utf8")).toBe(FUSED_BODY);

      const before = snapshot(root);
      await expect(run(parent, root, lines, stored, async () => {
        throw new Error("source should not open");
      }, ["wiki", "backfill-entries", "--apply", "--dry-run"])).rejects.toThrow(/either --apply or --dry-run/);
      expect(snapshot(root)).toEqual(before);

      await expect(run(parent, root, lines, stored, async () => undefined, [
        "wiki", "backfill-entries",
      ], { source: false })).rejects.toThrow(/database row source/);
      expect(snapshot(root)).toEqual(before);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("row loading lists memories and knowledge and skips documents", async () => {
    const queried: string[] = [];
    let listed = false;
    const provider = {
      async getTableNames(): Promise<TableName[]> {
        listed = true;
        return ["memories", "knowledge", "documents", "knowledge_personal"];
      },
      async query(options: { tableName?: TableName }): Promise<Array<MemoryEntry & { score: number }>> {
        queried.push(options.tableName ?? "");
        if (options.tableName === "documents") throw new Error("documents must not be scanned");
        if (options.tableName === "memories") return [entry("mem-1", "memory", { text: "memory body" })];
        if (options.tableName === "knowledge") {
          return [
            entry("know-1", "knowledge", {
              text: "fused body",
              metadata: { wikiPath: "pages/default-knowledge/page-003.md", semanticType: "experience" },
            }),
            entry("doc-1", "document", { text: "document body" }),
          ];
        }
        return [entry("know-ext", "knowledge", { text: "extended" })];
      },
    } as Pick<DatabaseProvider, "query" | "getTableNames">;

    const rows = await loadWikiBackfillRows(provider, "all");
    expect(listed).toBe(true);
    expect(queried).toEqual(["memories", "knowledge", "knowledge_personal"]);
    expect(rows.map((row) => row.id)).toEqual(["mem-1", "know-1", "know-ext"]);
    expect(rows[1]).toMatchObject({
      kind: "knowledge",
      tableName: "knowledge",
      wikiPath: "pages/default-knowledge/page-003.md",
      semanticType: "experience",
    });
    expect(rows[2]?.tableName).toBe("knowledge_personal");

    queried.length = 0;
    listed = false;
    const memories = await loadWikiBackfillRows(provider, "memories");
    expect(listed).toBe(false);
    expect(queried).toEqual(["memories"]);
    expect(memories.map((row) => row.id)).toEqual(["mem-1"]);
  });
});

function seedRows(): Map<string, StoredRow> {
  const rows: StoredRow[] = [
    row("know-fused", "knowledge", "default-knowledge", "experience", "fused body", FUSED),
    row("mem-present", "memory", "default-memories", "rules", "present body", PRESENT),
    row("mem-missing", "memory", "default-memories", "rules", "missing body", "pages/default-memories/entries/rules/mem-missing.md"),
    row("mem-none", "memory", "default-memories", "rules", "none body", null),
    row("know-none", "knowledge", "default-knowledge", "experience", "know body", null),
    row("mem-blocked", "memory", "blocked", "rules", "blocked body", null),
  ];
  return new Map(rows.map((item) => [item.id, item]));
}

function row(
  id: string,
  kind: "memory" | "knowledge",
  scopeKey: string,
  semanticType: string,
  text: string,
  wikiPath: string | null,
): StoredRow {
  return {
    id,
    kind,
    tableName: kind === "memory" ? "memories" : "knowledge",
    scopeKey,
    semanticType,
    text,
    title: id,
    updatedAt: "2026-10-12T00:00:00.000Z",
    wikiPath,
  };
}

function seedWiki(root: string): void {
  mkdirSync(join(root, "pages/default-knowledge"), { recursive: true });
  mkdirSync(join(root, "pages/default-memories/entries/rules"), { recursive: true });
  writeFileSync(join(root, FUSED), FUSED_BODY);
  writeFileSync(join(root, SOURCES), SOURCES_BODY);
  writeFileSync(join(root, PRESENT), PRESENT_BODY);
  writeFileSync(join(root, BLOCKED), BLOCKED_BODY);
  writeFileSync(join(root, "INDEX.md"), INDEX_BODY);
  writeFileSync(join(root, "completion.jsonl"), COMPLETION_BODY);
}

async function run(
  home: string,
  root: string,
  lines: string[],
  stored: Map<string, StoredRow>,
  recordMetadata: (input: { id: string; patch: Readonly<Record<string, string>> }) => Promise<void>,
  args: string[],
  options: { source?: boolean } = {},
): Promise<void> {
  const program = new Command().name("ms").exitOverride();
  registerWikiCliCommands(program, {
    wikiRoot: root,
    home,
    writeLine: (line) => lines.push(line),
    ...(options.source === false ? {} : {
      loadBackfillSource: async () => ({
        rows: [...stored.values()],
        recordMetadata: async (input) => {
          await recordMetadata({ id: input.id, patch: input.patch });
        },
      }),
    }),
  });
  await program.parseAsync(["node", "ms", ...args]);
}

function snapshot(root: string): Array<[string, string]> {
  return relativeFiles(root).map((path) => [path, readFileSync(join(root, path), "utf8")]);
}

function relativeFiles(root: string): string[] {
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

function entry(
  id: string,
  dataType: MemoryEntry["dataType"],
  extra: { text: string; metadata?: MemoryEntry["metadata"] },
): MemoryEntry & { score: number } {
  return {
    id,
    text: extra.text,
    contentHash: `hash-${id}`,
    vector: [0],
    importance: 0.5,
    category: "other",
    dataType,
    metadata: extra.metadata ?? {},
    createdAt: 1,
    tenantId: "local",
    userId: "user",
    canonicalProjectId: "project",
    productId: "app",
    producerId: "agent",
    namespace: dataType === "memory" ? "memories" : "knowledge",
    score: 0,
  };
}
