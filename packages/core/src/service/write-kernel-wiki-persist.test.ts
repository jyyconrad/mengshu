import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import type { MemoryRecord, MemoryScope } from "../domain/types.js";
import { DefaultMemoryService } from "./memory-service.js";
import {
  MemoryWriteKernel,
  type MemoryWriteCommand,
  type MemoryWriteKernelDependencies,
  type WriteMemoryRecord,
  type WriteScope,
} from "./write-kernel.js";
import type { MemoryWriteReceipt, WriteIdempotencyIdentity } from "./write-kernel-transaction.js";

const MEMORY_ID = "11111111-1111-4111-8111-111111111111";
const KNOWLEDGE_ID = "22222222-2222-4222-8222-222222222222";
const STORE_ID = "33333333-3333-4333-8333-333333333333";
const MEMORY_SCOPE_KEY = "local:mengshu:default:alpha-workspace:agent:memories";
const KNOWLEDGE_SCOPE_KEY = "local:mengshu:default:alpha-workspace:agent:knowledge";
const BETA_SCOPE_KEY = "local:mengshu:default:beta-workspace:agent:memories";

const memoryScope: WriteScope = {
  tenantId: "local",
  userId: "default",
  appId: "mengshu",
  projectId: "alpha-workspace",
  agentId: "agent",
  namespace: "memories",
  visibility: "private",
};

const knowledgeScope: WriteScope = { ...memoryScope, namespace: "knowledge" };
const betaScope: WriteScope = { ...memoryScope, projectId: "beta-workspace" };

function withTemp(prefix: string, run: (root: string) => Promise<void>): Promise<void> {
  return mkdtemp(join(tmpdir(), prefix)).then(async (root) => {
    try {
      await run(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(join(dir, entry.name), rel);
      else out.push(rel);
    }
  };
  walk(root, "");
  return out.sort();
}

function writeRegistry(
  root: string,
  extraScopes: ReadonlyArray<{ slug: string; scopeKey: string }> = [],
): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "scope-registry.json"), `${JSON.stringify({
    version: 1,
    scopes: [
      { slug: "default-memories", scopeKey: MEMORY_SCOPE_KEY },
      { slug: "default-knowledge", scopeKey: KNOWLEDGE_SCOPE_KEY },
      ...extraScopes,
    ],
  })}\n`, "utf8");
}

interface StoredRow {
  metadata: Record<string, unknown>;
  text?: string;
}

function kernelHarness(options: {
  root: string;
  scope?: WriteScope;
  id?: string;
  writeEntriesOnPersist?: boolean;
  indexUpdate?: "sync-ancestors" | "off";
  rows: Map<string, StoredRow>;
  order: string[];
  warnings?: string[];
  stored?: boolean;
  route?: "active" | "candidate";
}) {
  const receipts = new Map<string, MemoryWriteReceipt>();
  const inTransaction = { current: false };
  const inserted: Array<Record<string, unknown>> = [];
  const deps: MemoryWriteKernelDependencies = {
    resolveAuthority: async () => options.scope ?? memoryScope,
    normalize: async ({ command }) => ({
      text: "text" in command ? command.text : "",
      metadata: { ...(command.metadata ?? {}) },
      promptRisk: false,
    }),
    embeddingGuard: async () => ({ ok: true }),
    embed: async () => [0.1, 0.2],
    validate: async () => ({ accepted: true, candidate: { text: "validated" } }),
    scoreAdmission: async () => ({
      route: options.route ?? "active",
      valueScore: 0.9,
    }),
    scoreImportance: async () => 0.5,
    exactDedup: async () => ({ duplicate: false }),
    semanticDedup: async () => ({ duplicate: false }),
    transaction: async (work) => {
      inTransaction.current = true;
      try {
        const result = await work({
          getReceipt: async (identity: WriteIdempotencyIdentity) => receipts.get(identity.storageKey),
          saveReceipt: async (receipt: MemoryWriteReceipt) => {
            receipts.set(receipt.identity.storageKey, receipt);
          },
          writeMemory: async (memory: WriteMemoryRecord) => {
            options.order.push("write");
            expect(inTransaction.current).toBe(true);
            if (memory.mutation === "content") {
              inserted.push({ ...memory.metadata });
              options.rows.set(memory.id, {
                metadata: { ...memory.metadata },
                text: memory.text,
              });
            }
            return { memoryId: memory.id, stored: options.stored ?? true };
          },
          appendAudit: async () => undefined,
          appendOutbox: async () => undefined,
        });
        options.order.push("commit");
        return result;
      } finally {
        inTransaction.current = false;
      }
    },
    ack: async () => {
      options.order.push("ack");
      expect(inTransaction.current).toBe(false);
    },
    createId: () => options.id ?? MEMORY_ID,
    now: () => 1_720_000_000_000,
    wikiEntries: {
      root: options.root,
      writeEntriesOnPersist: options.writeEntriesOnPersist ?? true,
      ...(options.indexUpdate === undefined ? {} : { indexUpdate: options.indexUpdate }),
      logger: { warn: (message) => options.warnings?.push(message) },
      recordMetadata: async ({ id, tableName, patch }) => {
        options.order.push(`patch:${tableName}`);
        expect(inTransaction.current).toBe(false);
        const row = options.rows.get(id);
        expect(row).toBeDefined();
        row!.metadata = { ...row!.metadata, ...patch };
      },
    },
  };
  return { kernel: new MemoryWriteKernel(deps), inserted };
}

function saveCommand(overrides: Partial<MemoryWriteCommand> = {}): MemoryWriteCommand {
  return {
    type: "saveExplicit",
    idempotencyKey: "wiki-persist",
    serverAuthority: { tenantId: "local", userId: "default" },
    clientScope: memoryScope,
    text: "Remember the valve schedule",
    kind: "preference",
    semanticType: "rules",
    dataType: "memory",
    tableName: "memories",
    metadata: { title: "Valve schedule", source: "user" },
    provenance: { source: "user" },
    ...overrides,
  } as MemoryWriteCommand;
}

describe("wiki persist mirror", () => {
  test("memory persist writes a Track E file, refreshes indexes, and patches a relative wikiPath", async () => {
    await withTemp("mengshu-wiki-w3-memory-", async (root) => {
      writeRegistry(root);
      const rows = new Map<string, StoredRow>();
      const order: string[] = [];
      const { kernel, inserted } = kernelHarness({ root, rows, order });
      const wikiPath = `pages/default-memories/entries/rules/${MEMORY_ID}.md`;

      await expect(kernel.execute(saveCommand())).resolves.toMatchObject({
        status: "persisted",
        route: "active",
        recordType: "memory",
        memoryId: MEMORY_ID,
        stored: true,
      });

      expect(order).toEqual(["commit", "write", "commit", `patch:memories`, "ack"]);
      expect(inserted[0]).not.toHaveProperty("wikiPath");
      expect(rows.get(MEMORY_ID)?.metadata).toMatchObject({
        wikiPath,
        wikiTrack: "entry",
      });
      expect(String(rows.get(MEMORY_ID)?.metadata.wikiPath)).not.toContain("\\");
      expect(String(rows.get(MEMORY_ID)?.metadata.wikiPath).startsWith("/")).toBe(false);
      expect(String(rows.get(MEMORY_ID)?.metadata.wikiPath)).not.toContain(root);
      const markdown = readFileSync(join(root, wikiPath), "utf8");
      expect(markdown).toContain("kind: memory");
      expect(markdown).toContain(`wiki_path: ${wikiPath}`);
      expect(markdown).toContain("track: entry");
      expect(markdown).toContain("Remember the valve schedule");
      expect(markdown).not.toContain(root);
      expect(readFileSync(join(root, "pages/default-memories/entries/rules/INDEX.md"), "utf8")).toContain(MEMORY_ID);
      expect(readFileSync(join(root, "INDEX.md"), "utf8")).toContain("## Entries");
      expect(readFileSync(join(root, "INDEX.md"), "utf8")).toContain("default-memories");
      expect(filesUnder(root).some((rel) => rel.endsWith(".sources") || /\/page-\d+\.md$/.test(rel))).toBe(false);
    });
  });

  test("knowledge persist through the kernel lands under the knowledge slug", async () => {
    await withTemp("mengshu-wiki-w3-knowledge-", async (root) => {
      writeRegistry(root);
      const rows = new Map<string, StoredRow>();
      const order: string[] = [];
      const { kernel } = kernelHarness({
        root,
        rows,
        order,
        id: KNOWLEDGE_ID,
        scope: knowledgeScope,
      });
      const wikiPath = `pages/default-knowledge/entries/experience/${KNOWLEDGE_ID}.md`;

      await expect(kernel.execute(saveCommand({
        idempotencyKey: "wiki-knowledge",
        clientScope: knowledgeScope,
        text: "The plant notebook is the valve source",
        kind: "knowledge",
        semanticType: "experience",
        dataType: "knowledge",
        tableName: "knowledge",
        metadata: { title: "Plant notebook" },
        provenance: { source: "agent" },
      }))).resolves.toMatchObject({
        status: "persisted",
        memoryId: KNOWLEDGE_ID,
      });

      expect(order).toContain("patch:knowledge");
      expect(rows.get(KNOWLEDGE_ID)?.metadata).toMatchObject({
        wikiPath,
        wikiTrack: "entry",
      });
      const markdown = readFileSync(join(root, wikiPath), "utf8");
      expect(markdown).toContain("kind: knowledge");
      expect(markdown).toContain(`scope_key: ${KNOWLEDGE_SCOPE_KEY}`);
      expect(markdown).toContain("semantic_type: experience");
      expect(markdown).not.toContain(root);
    });
  });

  test("knowledge storeMemory outside the kernel mirrors after the repository commit", async () => {
    await withTemp("mengshu-wiki-w3-store-", async (root) => {
      writeRegistry(root);
      const rows = new Map<string, MemoryRecord>();
      const order: string[] = [];
      const scope: MemoryScope = {
        tenantId: "local",
        appId: "mengshu",
        userId: "default",
        projectId: "alpha-workspace",
        agentId: "agent",
        namespace: "knowledge",
        visibility: "private",
      };
      const record: MemoryRecord = {
        id: STORE_ID,
        scope,
        kind: "knowledge",
        semanticType: "experience",
        text: "Plant notebook holds the valve schedule",
        contentHash: "store-hash",
        importance: 0.5,
        category: "fact",
        dataType: "knowledge",
        tableName: "knowledge",
        metadata: { title: "Valve schedule" },
        provenance: { source: "agent" },
        createdAt: 1_720_000_000_000,
        vector: [0.2],
      };
      const service = new DefaultMemoryService({
        repository: {
          store: async (records) => {
            order.push("db");
            const stored = records[0]!;
            expect(stored.metadata.wikiPath).toBeUndefined();
            rows.set(stored.id, stored);
            return {
              inserted: 1,
              duplicates: 0,
              records: [{ requestedId: stored.id, persistedId: stored.id, stored: true }],
            };
          },
          query: async () => [],
          delete: async () => undefined,
          deleteByFilter: async () => 0,
          count: async () => rows.size,
        },
        embeddings: { embed: async () => [0.2] },
        wikiEntries: {
          root,
          recordMetadata: async ({ id, tableName, patch }) => {
            order.push(`patch:${tableName}`);
            const wikiPath = `pages/default-knowledge/entries/experience/${STORE_ID}.md`;
            expect(existsSync(join(root, wikiPath))).toBe(true);
            const current = rows.get(id);
            expect(current).toBeDefined();
            rows.set(id, { ...current!, metadata: { ...current!.metadata, ...patch } });
          },
        },
      });

      await expect(service.storeMemory({ record })).resolves.toMatchObject({
        id: STORE_ID,
        stored: true,
      });

      const wikiPath = `pages/default-knowledge/entries/experience/${STORE_ID}.md`;
      expect(order).toEqual(["db", "patch:knowledge"]);
      expect(rows.get(STORE_ID)?.metadata).toMatchObject({ wikiPath, wikiTrack: "entry" });
      expect(readFileSync(join(root, wikiPath), "utf8")).toContain("kind: knowledge");
      expect(readFileSync(join(root, "pages/default-knowledge/INDEX.md"), "utf8")).toContain("fused_page_bodies: not read");
      expect(filesUnder(root).some((rel) => rel.endsWith(".sources") || /\/page-\d+\.md$/.test(rel))).toBe(false);
    });
  });

  test("writeEntriesOnPersist false does not write files or patch metadata", async () => {
    await withTemp("mengshu-wiki-w3-off-", async (root) => {
      const rows = new Map<string, StoredRow>();
      const order: string[] = [];
      const { kernel } = kernelHarness({
        root,
        rows,
        order,
        writeEntriesOnPersist: false,
      });

      await expect(kernel.execute(saveCommand({ idempotencyKey: "wiki-off" }))).resolves.toMatchObject({
        status: "persisted",
        stored: true,
      });

      expect(order.filter((step) => step.startsWith("patch"))).toEqual([]);
      expect(rows.get(MEMORY_ID)?.metadata.wikiPath).toBeUndefined();
      expect(filesUnder(root)).toEqual([]);
    });
  });

  test("an existing fused page path is not mirrored and the page is not edited", async () => {
    await withTemp("mengshu-wiki-w3-fused-", async (root) => {
      writeRegistry(root);
      const fused = "pages/default-knowledge/page-019.md";
      mkdirSync(join(root, "pages/default-knowledge"), { recursive: true });
      writeFileSync(join(root, fused), "FUSED-BODY\n", "utf8");
      writeFileSync(join(root, "pages/default-knowledge/page-019.sources"), "FUSED-SOURCES\n", "utf8");
      const before = {
        page: readFileSync(join(root, fused), "utf8"),
        sources: readFileSync(join(root, "pages/default-knowledge/page-019.sources"), "utf8"),
        pageIno: statSync(join(root, fused)).ino,
        sourcesIno: statSync(join(root, "pages/default-knowledge/page-019.sources")).ino,
      };
      const rows = new Map<string, StoredRow>();
      const order: string[] = [];
      const { kernel } = kernelHarness({
        root,
        rows,
        order,
        id: KNOWLEDGE_ID,
        scope: knowledgeScope,
      });

      await expect(kernel.execute(saveCommand({
        idempotencyKey: "wiki-fused",
        clientScope: knowledgeScope,
        kind: "knowledge",
        semanticType: "experience",
        dataType: "knowledge",
        tableName: "knowledge",
        metadata: { wikiPath: fused, title: "should not mirror" },
      }))).resolves.toMatchObject({ status: "persisted", stored: true });

      expect(order.filter((step) => step.startsWith("patch"))).toEqual([]);
      expect(rows.get(KNOWLEDGE_ID)?.metadata.wikiPath).toBe(fused);
      expect(rows.get(KNOWLEDGE_ID)?.metadata.wikiTrack).toBeUndefined();
      expect(readFileSync(join(root, fused), "utf8")).toBe(before.page);
      expect(readFileSync(join(root, "pages/default-knowledge/page-019.sources"), "utf8")).toBe(before.sources);
      expect(statSync(join(root, fused)).ino).toBe(before.pageIno);
      expect(statSync(join(root, "pages/default-knowledge/page-019.sources")).ino).toBe(before.sourcesIno);
      expect(existsSync(join(root, "pages/default-knowledge/entries"))).toBe(false);
      expect(existsSync(join(root, "INDEX.md"))).toBe(false);
    });
  });

  test("wiki IO failure is logged, marks wikiStatus, and leaves the committed row", async () => {
    await withTemp("mengshu-wiki-w3-io-", async (parent) => {
      const root = join(parent, "not-a-directory");
      writeFileSync(root, "blocked\n", "utf8");
      const rows = new Map<string, StoredRow>();
      const order: string[] = [];
      const warnings: string[] = [];
      const { kernel } = kernelHarness({ root, rows, order, warnings });

      await expect(kernel.execute(saveCommand({ idempotencyKey: "wiki-io" }))).resolves.toMatchObject({
        status: "persisted",
        memoryId: MEMORY_ID,
        stored: true,
      });

      expect(rows.has(MEMORY_ID)).toBe(true);
      expect(rows.get(MEMORY_ID)?.text).toBe("Remember the valve schedule");
      expect(rows.get(MEMORY_ID)?.metadata.wikiPath).toBeUndefined();
      expect(rows.get(MEMORY_ID)?.metadata.wikiStatus).toBe("error");
      expect(order.at(-1)).toBe("ack");
      expect(order.indexOf("write")).toBeLessThan(order.indexOf("patch:memories"));
      expect(warnings.join("\n")).toMatch(/committed row kept/);
      expect(warnings.join("\n")).not.toContain(root);
      expect(existsSync(join(parent, "pages"))).toBe(false);
    });
  });

  test("candidate and unstored writes do not create entry files", async () => {
    await withTemp("mengshu-wiki-w3-skip-", async (root) => {
      writeRegistry(root);
      const rows = new Map<string, StoredRow>();
      const order: string[] = [];
      const candidate = kernelHarness({ root, rows, order, route: "candidate", id: MEMORY_ID });
      await expect(candidate.kernel.execute(saveCommand({ idempotencyKey: "wiki-candidate" }))).resolves.toMatchObject({
        status: "persisted",
        recordType: "candidate",
      });
      expect(order.filter((step) => step.startsWith("patch"))).toEqual([]);

      const quiet = kernelHarness({
        root,
        rows,
        order,
        stored: false,
        id: KNOWLEDGE_ID,
        scope: knowledgeScope,
      });
      await expect(quiet.kernel.execute(saveCommand({
        idempotencyKey: "wiki-unstored",
        clientScope: knowledgeScope,
        dataType: "knowledge",
        tableName: "knowledge",
        kind: "knowledge",
      }))).resolves.toMatchObject({ status: "persisted", stored: false });
      expect(filesUnder(root).filter((rel) => rel.endsWith(".md"))).toEqual([]);
    });
  });

  test("indexUpdate off still writes the Track E file and skips ancestor indexes", async () => {
    await withTemp("mengshu-wiki-w3-index-off-", async (root) => {
      writeRegistry(root);
      const rows = new Map<string, StoredRow>();
      const order: string[] = [];
      const { kernel } = kernelHarness({
        root,
        rows,
        order,
        indexUpdate: "off",
      });
      const wikiPath = `pages/default-memories/entries/rules/${MEMORY_ID}.md`;

      await expect(kernel.execute(saveCommand({ idempotencyKey: "wiki-index-off" }))).resolves.toMatchObject({
        status: "persisted",
        stored: true,
      });

      expect(order).toContain("patch:memories");
      expect(rows.get(MEMORY_ID)?.metadata).toMatchObject({
        wikiPath,
        wikiTrack: "entry",
      });
      expect(String(rows.get(MEMORY_ID)?.metadata.wikiPath)).not.toContain("\\");
      expect(String(rows.get(MEMORY_ID)?.metadata.wikiPath).startsWith("/")).toBe(false);
      const markdown = readFileSync(join(root, wikiPath), "utf8");
      expect(markdown).toContain("kind: memory");
      expect(markdown).toContain(`wiki_path: ${wikiPath}`);
      expect(markdown).toContain("track: entry");
      expect(markdown).toContain("Remember the valve schedule");
      expect(markdown).not.toContain(root);
      expect(filesUnder(root).filter((rel) => rel.endsWith(".md"))).toEqual([wikiPath]);
    });
  });

  test("a scope and semanticType change moves the entry and refreshes both ancestor indexes", async () => {
    await withTemp("mengshu-wiki-w3-move-", async (root) => {
      writeRegistry(root, [{ slug: "beta-memories", scopeKey: BETA_SCOPE_KEY }]);
      const rows = new Map<string, StoredRow>();
      const order: string[] = [];
      const oldPath = `pages/default-memories/entries/rules/${MEMORY_ID}.md`;
      const newPath = `pages/beta-memories/entries/experience/${MEMORY_ID}.md`;
      const first = kernelHarness({ root, rows, order });

      await expect(first.kernel.execute(saveCommand({ idempotencyKey: "wiki-before-move" }))).resolves.toMatchObject({
        status: "persisted",
        memoryId: MEMORY_ID,
        stored: true,
      });
      expect(rows.get(MEMORY_ID)?.metadata.wikiPath).toBe(oldPath);
      expect(readFileSync(join(root, "pages/default-memories/entries/rules/INDEX.md"), "utf8")).toContain(MEMORY_ID);
      expect(readFileSync(join(root, "pages/default-memories/entries/INDEX.md"), "utf8")).toContain("| rules | 1 |");
      expect(readFileSync(join(root, "pages/default-memories/INDEX.md"), "utf8")).toContain("- total: 1");

      const second = kernelHarness({ root, rows, order, scope: betaScope });
      await expect(second.kernel.execute(saveCommand({
        idempotencyKey: "wiki-after-move",
        clientScope: betaScope,
        semanticType: "experience",
        text: "Remember the moved valve",
        metadata: {
          title: "Moved valve",
          source: "user",
          wikiPath: oldPath,
        },
      }))).resolves.toMatchObject({
        status: "persisted",
        memoryId: MEMORY_ID,
        stored: true,
      });

      expect(existsSync(join(root, oldPath))).toBe(false);
      expect(existsSync(join(root, newPath))).toBe(true);
      const markdown = readFileSync(join(root, newPath), "utf8");
      expect(markdown).toContain("semantic_type: experience");
      expect(markdown).toContain(`scope_key: ${BETA_SCOPE_KEY}`);
      expect(markdown).toContain(`wiki_path: ${newPath}`);
      expect(markdown).toContain("Remember the moved valve");
      expect(markdown).not.toContain(root);

      const oldL3 = readFileSync(join(root, "pages/default-memories/entries/rules/INDEX.md"), "utf8");
      const newL3 = readFileSync(join(root, "pages/beta-memories/entries/experience/INDEX.md"), "utf8");
      expect(oldL3).not.toContain(MEMORY_ID);
      expect(oldL3).not.toContain(oldPath);
      expect(newL3).toContain(MEMORY_ID);
      expect(newL3).toContain(newPath);

      expect(readFileSync(join(root, "pages/default-memories/entries/INDEX.md"), "utf8")).toContain("| rules | 0 |");
      expect(readFileSync(join(root, "pages/beta-memories/entries/INDEX.md"), "utf8")).toContain("| experience | 1 |");
      const oldL1 = readFileSync(join(root, "pages/default-memories/INDEX.md"), "utf8");
      const newL1 = readFileSync(join(root, "pages/beta-memories/INDEX.md"), "utf8");
      expect(oldL1).toContain("- total: 0");
      expect(newL1).toContain("- total: 1");
      expect(oldL1).toContain("fused_page_bodies: not read");
      expect(newL1).toContain("- page_files: 0");

      const rootIndex = readFileSync(join(root, "INDEX.md"), "utf8");
      expect(rootIndex).toContain(
        "| default-memories | local:mengshu:default:alpha-workspace:agent:memories | 0 |",
      );
      expect(rootIndex).toContain(
        "| beta-memories | local:mengshu:default:beta-workspace:agent:memories | 1 |",
      );
      expect(rows.get(MEMORY_ID)?.metadata).toMatchObject({
        wikiPath: newPath,
        wikiTrack: "entry",
      });
      expect(String(rows.get(MEMORY_ID)?.metadata.wikiPath)).not.toContain("\\");
      expect(String(rows.get(MEMORY_ID)?.metadata.wikiPath).startsWith("/")).toBe(false);
      expect(String(rows.get(MEMORY_ID)?.metadata.wikiPath)).not.toContain(root);
      expect(filesUnder(root).some((rel) => rel.endsWith(".sources") || /\/page-\d+\.md$/.test(rel))).toBe(false);
    });
  });
});
