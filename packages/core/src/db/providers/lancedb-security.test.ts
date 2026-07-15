import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { open as openFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

type QueryKind = "query" | "vector";

const lanceState = vi.hoisted(() => ({
  connectCalls: [] as string[],
  createCalls: [] as string[],
  openCalls: [] as string[],
  existingTables: ["memories", "knowledge"] as string[],
  filters: [] as Array<{ tableName: string; kind: QueryKind; expression: string }>,
  failures: new Map<string, Error>(),
  addFailures: new Map<string, Error>(),
  postCommitAddFailures: new Map<string, Error>(),
  postCommitPersistedIds: new Map<string, string>(),
  hideExactRequestedQueries: new Map<string, number>(),
  tamperLockOnExactQuery: false,
  tableNamesDelayMs: 0,
  addDelayMs: 0,
  activeAdds: 0,
  maxActiveAdds: 0,
  deleteFailures: new Map<string, Error>(),
  closedTables: [] as string[],
  closedConnections: 0,
  rows: new Map<string, Array<Record<string, unknown>>>(),
}));

function createBuilder(tableName: string, kind: QueryKind) {
  let filterExpression = "";
  return {
    filter(expression: string) {
      filterExpression = expression;
      lanceState.filters.push({ tableName, kind, expression });
      return this;
    },
    limit() {
      return this;
    },
    select() {
      return this;
    },
    async toArray() {
      const failure = lanceState.failures.get(tableName);
      if (failure) throw failure;
      if (/\bid = '/.test(filterExpression)) {
        const remaining = lanceState.hideExactRequestedQueries.get(tableName) ?? 0;
        if (remaining > 0) {
          lanceState.hideExactRequestedQueries.set(tableName, remaining - 1);
          return [];
        }
      }
      const equalities = [...filterExpression.matchAll(
        /(id|contentHash|tenant_id|user_id|canonical_project_id|product_id|producer_id|namespace|visibility) = '((?:''|[^'])*)'/g,
      )].map((match) => [match[1]!, match[2]!.replace(/''/g, "'")] as const);
      const results = (lanceState.rows.get(tableName) ?? []).filter((row) =>
        equalities.every(([key, value]) => row[key] === value));
      if (/\bid = '/.test(filterExpression) && lanceState.tamperLockOnExactQuery) {
        lanceState.tamperLockOnExactQuery = false;
        writeFileSync(join(DB_PATH, ".mengshu-write.lock"), JSON.stringify({
          version: 1,
          token: "66666666-6666-4666-8666-666666666666",
          pid: process.pid,
          createdMonotonicNs: process.hrtime.bigint().toString(),
          processStartMonotonicNs: "1",
        }), { mode: 0o600 });
      }
      return results;
    },
  };
}

function createTable(tableName: string) {
  return {
    close() {
      lanceState.closedTables.push(tableName);
    },
    isOpen() {
      return true;
    },
    async checkoutLatest() {},
    async add(rows: Array<Record<string, unknown>>) {
      const failure = lanceState.addFailures.get(tableName);
      if (failure) throw failure;
      lanceState.activeAdds += 1;
      lanceState.maxActiveAdds = Math.max(lanceState.maxActiveAdds, lanceState.activeAdds);
      try {
        if (lanceState.addDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, lanceState.addDelayMs));
        }
        const existing = lanceState.rows.get(tableName) ?? [];
        const persistedId = lanceState.postCommitPersistedIds.get(tableName);
        if (persistedId) lanceState.postCommitPersistedIds.delete(tableName);
        existing.push(...rows.map((row) => persistedId ? { ...row, id: persistedId } : row));
        lanceState.rows.set(tableName, existing);
        const postCommitFailure = lanceState.postCommitAddFailures.get(tableName);
        if (postCommitFailure) {
          lanceState.postCommitAddFailures.delete(tableName);
          throw postCommitFailure;
        }
      } finally {
        lanceState.activeAdds -= 1;
      }
    },
    async delete(expression: string) {
      const failure = lanceState.deleteFailures.get(tableName);
      if (failure) throw failure;
      if (expression === 'id = "__schema__"') {
        lanceState.rows.set(
          tableName,
          (lanceState.rows.get(tableName) ?? []).filter((row) => row.id !== "__schema__"),
        );
      }
    },
    query() {
      return createBuilder(tableName, "query");
    },
    vectorSearch() {
      return createBuilder(tableName, "vector");
    },
    async countRows() {
      return 0;
    },
  };
}

vi.mock("@lancedb/lancedb", () => ({
  connect: vi.fn(async (uri: string) => {
    lanceState.connectCalls.push(uri);
    return {
      close() {
        lanceState.closedConnections += 1;
      },
      isOpen() {
        return true;
      },
      async tableNames() {
        const snapshot = [...lanceState.existingTables];
        if (lanceState.tableNamesDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, lanceState.tableNamesDelayMs));
        }
        return snapshot;
      },
      async openTable(tableName: string) {
        const failure = lanceState.failures.get(tableName);
        if (failure) throw failure;
        lanceState.openCalls.push(tableName);
        return createTable(tableName);
      },
      async createTable(tableName: string, rows: Array<Record<string, unknown>>) {
        lanceState.createCalls.push(tableName);
        if (!lanceState.existingTables.includes(tableName)) {
          lanceState.existingTables.push(tableName);
        }
        lanceState.rows.set(tableName, [...rows]);
        return createTable(tableName);
      },
    };
  }),
}));

import { LanceDBProvider } from "./lancedb.js";
import type { MemoryEntry } from "../types.js";

const DB_PATH = join(realpathSync(tmpdir()), "mengshu-lance-security");

const createProvider = (
  knowledgeBases?: ConstructorParameters<typeof LanceDBProvider>[2],
  lockOptions?: ConstructorParameters<typeof LanceDBProvider>[3],
) =>
  new LanceDBProvider(
    DB_PATH,
    "text-embedding-3-small",
    knowledgeBases,
    lockOptions,
  );

const lockTestEntry = (id: string, contentHash = `${id}-hash`): MemoryEntry => ({
  id,
  text: id,
  contentHash,
  vector: [0.1],
  importance: 0.5,
  category: "other",
  dataType: "memory",
  metadata: {},
  createdAt: 1,
  tenantId: "tenant-a",
  userId: "user-a",
  canonicalProjectId: "project-a",
  productId: "app-a",
  producerId: "agent-a",
  namespace: "memories",
  visibility: "private",
});

function writeOperatorLock(token: string, pid: number): string {
  mkdirSync(DB_PATH, { recursive: true, mode: 0o700 });
  const lockPath = join(DB_PATH, ".mengshu-write.lock");
  writeFileSync(lockPath, JSON.stringify({
    version: 1,
    token,
    pid,
    createdMonotonicNs: process.hrtime.bigint().toString(),
    processStartMonotonicNs: "1",
  }), { mode: 0o600 });
  return lockPath;
}

describe("LanceDBProvider fail-closed validation", () => {
  beforeEach(() => {
    lanceState.connectCalls.length = 0;
    lanceState.createCalls.length = 0;
    lanceState.openCalls.length = 0;
    lanceState.filters.length = 0;
    lanceState.failures.clear();
    lanceState.addFailures.clear();
    lanceState.postCommitAddFailures.clear();
    lanceState.postCommitPersistedIds.clear();
    lanceState.hideExactRequestedQueries.clear();
    lanceState.tamperLockOnExactQuery = false;
    lanceState.tableNamesDelayMs = 0;
    lanceState.addDelayMs = 0;
    lanceState.activeAdds = 0;
    lanceState.maxActiveAdds = 0;
    lanceState.deleteFailures.clear();
    lanceState.closedTables.length = 0;
    lanceState.closedConnections = 0;
    lanceState.rows.clear();
    lanceState.existingTables = ["memories", "knowledge"];
    rmSync(DB_PATH, { recursive: true, force: true });
  });

  it("rejects 100 non-enum dataTypes before connecting", async () => {
    const provider = createProvider();
    const maliciousDataTypes = Array.from({ length: 100 }, (_, index) => {
      if (index % 3 === 0) return `memory' OR ${index}=${index} --`;
      if (index % 3 === 1) return `knowledge--${index}`;
      return `document OR ${index}=${index}`;
    });

    for (const dataType of maliciousDataTypes) {
      await expect(
        provider.query({
          dataTypes: [dataType] as never,
          tenantId: "tenant-a",
          userId: "user-a",
        }),
      ).rejects.toThrow(/dataTypes/i);
    }

    expect(lanceState.connectCalls).toEqual([]);
    expect(lanceState.createCalls).toEqual([]);
  });

  it("rejects 100 malicious or unconfigured knowledge tables before connecting", async () => {
    const provider = createProvider();

    for (let index = 0; index < 100; index += 1) {
      const tableName = index % 3 === 0
        ? `knowledge_unconfigured_${index}`
        : index % 3 === 1
          ? `knowledge_x' OR ${index}=${index} --`
          : `knowledge_x OR ${index}=${index}`;
      await expect(
        provider.query({
          tableName: tableName as never,
          tenantId: "tenant-a",
          userId: "user-a",
        }),
      ).rejects.toThrow(/tableName/i);
    }

    expect(lanceState.connectCalls).toEqual([]);
    expect(lanceState.createCalls).toEqual([]);
  });

  it("rejects malicious configured categories before any LanceDB state exists", () => {
    const maliciousCategories = Array.from({ length: 100 }, (_, index) =>
      index % 2 === 0 ? `work' OR ${index}=${index} --` : `work-${index}`,
    );

    for (const category of maliciousCategories) {
      expect(() => createProvider({
        enabled: true,
        autoCreateTables: true,
        builtinCategories: [category],
      })).toThrow(/^LanceDB configured knowledge-base category is invalid$/);
    }

    expect(lanceState.connectCalls).toEqual([]);
    expect(lanceState.createCalls).toEqual([]);
  });

  it("does not initialize or create state for unknown read and write targets", async () => {
    const provider = createProvider();

    await expect(
      provider.store([
        {
          id: "memory-1",
          text: "should never be written",
          contentHash: "hash-1",
          vector: [0],
          importance: 0.5,
          category: "other",
          dataType: "memory",
          metadata: {},
          createdAt: 1,
          tableName: "knowledge_unconfigured" as never,
        },
      ]),
    ).rejects.toThrow(/tableName/i);
    await expect(provider.ensureTable("knowledge_unconfigured")).rejects.toThrow(/tableName/i);

    expect(lanceState.connectCalls).toEqual([]);
    expect(lanceState.createCalls).toEqual([]);
    expect(lanceState.existingTables).toEqual(["memories", "knowledge"]);
  });

  it("creates and queries a configured extension table", async () => {
    const provider = createProvider({
        enabled: true,
        autoCreateTables: true,
        builtinCategories: ["work"],
    });

    await provider.initialize();
    await expect(
      provider.query({
        tableName: "knowledge_work",
        dataTypes: ["knowledge"],
        tenantId: "tenant-a",
        userId: "user-a",
      }),
    ).resolves.toEqual([]);

    expect(lanceState.createCalls).toEqual(["knowledge_work"]);
    expect(lanceState.filters).toHaveLength(1);
    expect(lanceState.filters[0]?.tableName).toBe("knowledge_work");
  });

  it("opens configured existing extension tables even when auto-create is disabled", async () => {
    lanceState.existingTables.push("knowledge_work");
    const provider = createProvider({
        enabled: true,
        autoCreateTables: false,
        builtinCategories: ["work"],
    });

    await expect(
      provider.query({
        tableName: "knowledge_work",
        tenantId: "tenant-a",
        userId: "user-a",
      }),
    ).resolves.toEqual([]);

    expect(lanceState.openCalls).toContain("knowledge_work");
    expect(lanceState.createCalls).toEqual([]);
  });

  it("rejects every missing canonical scope field before connecting or creating state", async () => {
    const required = [
      "tenantId", "userId", "canonicalProjectId", "productId",
      "producerId", "namespace", "visibility",
    ] as const;
    for (const field of required) {
      const entry: MemoryEntry = {
        id: `missing-${field}`,
        text: "legacy",
        contentHash: `missing-${field}`,
        vector: [0.1],
        importance: 0.5,
        category: "other" as const,
        dataType: "memory" as const,
        metadata: {},
        createdAt: 1,
        tenantId: "tenant-a",
        userId: "user-a",
        canonicalProjectId: "project-a",
        productId: "app-a",
        producerId: "agent-a",
        namespace: "memories",
        visibility: "private" as const,
      };
      delete entry[field];

      await expect(createProvider().store([entry])).rejects.toThrow(
        new RegExp(`canonical scope field: ${field}`, "i"),
      );
    }

    expect(lanceState.connectCalls).toEqual([]);
    expect(lanceState.createCalls).toEqual([]);
  });

  it("does not create a missing configured table from a read path", async () => {
    const provider = createProvider({
      enabled: true,
      autoCreateTables: false,
      builtinCategories: ["work"],
    });

    await expect(
      provider.query({
        tableName: "knowledge_work",
        tenantId: "tenant-a",
        userId: "user-a",
      }),
    ).rejects.toThrow(/^LanceDB configured table is unavailable$/);

    expect(lanceState.createCalls).toEqual([]);
    expect(lanceState.existingTables).toEqual(["memories", "knowledge"]);
  });

  it("does not create a missing default table from a read path", async () => {
    lanceState.existingTables = ["knowledge"];
    const provider = createProvider();

    await expect(provider.query({ tableName: "memories" }))
      .rejects.toThrow(/^LanceDB configured table is unavailable$/);

    expect(lanceState.createCalls).toEqual([]);
    expect(lanceState.existingTables).toEqual(["knowledge"]);
  });

  it("allows explicit initialization to create a configured table", async () => {
    const provider = createProvider({
      enabled: true,
      autoCreateTables: false,
      builtinCategories: ["work"],
    });

    await provider.ensureTable("knowledge_work");

    expect(lanceState.createCalls).toEqual(["knowledge_work"]);
    expect(lanceState.existingTables).toContain("knowledge_work");
  });

  it("places authority predicates before data type and metadata predicates", async () => {
    const provider = createProvider();

    for (const vector of [undefined, [0.1]]) {
      await provider.query({
        tableName: "memories",
        dataTypes: ["memory"],
        filter: { source: "test" },
        tenantId: "tenant-a",
        userId: "user-a",
        vector,
      });
    }

    expect(lanceState.filters).toHaveLength(2);
    for (const { expression } of lanceState.filters) {
      expect(expression).toMatch(
        /^tenant_id = 'tenant-a' AND user_id = 'user-a' AND dataType = 'memory' AND metadata\.source = 'test'$/,
      );
    }
  });

  it("fails searchAll as a whole with a fixed safe error", async () => {
    const provider = createProvider();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    lanceState.failures.set("knowledge", new Error("raw provider secret: /private/path"));

    await expect(
      provider.query({
        searchAll: true,
        tenantId: "tenant-a",
        userId: "user-a",
      }),
    ).rejects.toThrow(/^LanceDB searchAll failed closed$/);

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("cleans partial initialization state and permits an explicit retry", async () => {
    const provider = createProvider();
    lanceState.failures.set("knowledge", new Error("open failed"));

    await expect(provider.initialize()).rejects.toThrow();
    expect(lanceState.closedTables).toContain("memories");
    expect(lanceState.closedConnections).toBe(1);

    await expect(provider.query({ tableName: "memories" }))
      .rejects.toThrow(/^LanceDB initialization failed; explicit retry required$/);
    expect(lanceState.connectCalls).toHaveLength(1);

    lanceState.failures.delete("knowledge");
    await expect(provider.initialize()).resolves.toBeUndefined();
    expect(lanceState.connectCalls).toHaveLength(2);
  });

  it("closes a newly created table when schema cleanup fails", async () => {
    lanceState.existingTables = [];
    lanceState.deleteFailures.set("memories", new Error("schema cleanup failed"));
    const provider = createProvider();

    await expect(provider.initialize()).rejects.toThrow();

    expect(lanceState.closedTables).toContain("memories");
    expect(lanceState.closedConnections).toBe(1);

    lanceState.deleteFailures.delete("memories");
    await provider.initialize();
    expect(lanceState.rows.get("memories")).toEqual([]);
  });

  it("returns an explicit partial receipt when a later table write fails", async () => {
    const provider = createProvider({
      enabled: true,
      autoCreateTables: true,
      builtinCategories: ["work", "personal"],
    });
    lanceState.addFailures.set("knowledge_personal", new Error("raw write failure"));

    const store = provider.store([
      {
        id: "work-id",
        text: "work",
        contentHash: "shared-work",
        vector: [0.1],
        importance: 0.5,
        category: "other",
        dataType: "knowledge",
        tableName: "knowledge_work",
        metadata: {},
        createdAt: 1,
        tenantId: "tenant-a",
        userId: "user-a",
        canonicalProjectId: "project-a",
        productId: "app-a",
        producerId: "agent-a",
        namespace: "knowledge_work",
        visibility: "private",
      },
      {
        id: "personal-id",
        text: "personal",
        contentHash: "shared-personal",
        vector: [0.2],
        importance: 0.5,
        category: "other",
        dataType: "knowledge",
        tableName: "knowledge_personal",
        metadata: {},
        createdAt: 2,
        tenantId: "tenant-a",
        userId: "user-a",
        canonicalProjectId: "project-a",
        productId: "app-a",
        producerId: "agent-a",
        namespace: "knowledge_personal",
        visibility: "private",
      },
    ]);

    await expect(store).rejects.toMatchObject({
      message: "LanceDB store partially completed",
      receipt: {
        inserted: 1,
        duplicates: 0,
        records: [{ requestedId: "work-id", persistedId: "work-id", stored: true }],
      },
    });
  });

  it("serializes two provider instances sharing one Lance path before dedupe query/add", async () => {
    lanceState.addDelayMs = 25;
    const firstProvider = createProvider();
    const secondProvider = createProvider();
    const common = {
      text: "cross-provider dedupe",
      contentHash: "cross-provider-hash",
      vector: [0.1],
      importance: 0.5,
      category: "other" as const,
      dataType: "memory" as const,
      metadata: {},
      createdAt: 1,
      tenantId: "tenant-a",
      userId: "user-a",
      canonicalProjectId: "project-a",
      productId: "app-a",
      producerId: "agent-a",
      namespace: "memories",
      visibility: "private" as const,
    };

    const [first, second] = await Promise.all([
      firstProvider.store([{ ...common, id: "provider-a" }]),
      secondProvider.store([{ ...common, id: "provider-b" }]),
    ]);

    expect(first.inserted + second.inserted).toBe(1);
    expect(first.duplicates + second.duplicates).toBe(1);
    expect(new Set([first.records[0]?.persistedId, second.records[0]?.persistedId]).size).toBe(1);
    expect(lanceState.maxActiveAdds).toBe(1);
  });

  it("confirms a post-commit add exception under the same lock and reports stored=true", async () => {
    lanceState.postCommitAddFailures.set("memories", new Error("raw ambiguous ACK"));
    const result = await createProvider().store([{
      id: "post-commit-id",
      text: "post commit",
      contentHash: "post-commit-hash",
      vector: [0.1],
      importance: 0.5,
      category: "other",
      dataType: "memory",
      metadata: {},
      createdAt: 1,
      tenantId: "tenant-a",
      userId: "user-a",
      canonicalProjectId: "project-a",
      productId: "app-a",
      producerId: "agent-a",
      namespace: "memories",
      visibility: "private",
    }]);

    expect(result).toEqual({
      inserted: 1,
      duplicates: 0,
      records: [{ requestedId: "post-commit-id", persistedId: "post-commit-id", stored: true }],
    });
  });

  it("treats a foreign persisted id discovered after add failure as an existing duplicate", async () => {
    lanceState.postCommitPersistedIds.set("memories", "foreign-existing-id");
    lanceState.postCommitAddFailures.set("memories", new Error("raw ambiguous ACK"));
    const result = await createProvider().store([{
      id: "requested-id",
      text: "foreign duplicate",
      contentHash: "foreign-duplicate-hash",
      vector: [0.1],
      importance: 0.5,
      category: "other",
      dataType: "memory",
      metadata: {},
      createdAt: 1,
      tenantId: "tenant-a",
      userId: "user-a",
      canonicalProjectId: "project-a",
      productId: "app-a",
      producerId: "agent-a",
      namespace: "memories",
      visibility: "private",
    }]);

    expect(result).toEqual({
      inserted: 0,
      duplicates: 1,
      records: [{
        requestedId: "requested-id",
        persistedId: "foreign-existing-id",
        stored: false,
      }],
    });
  });

  it("also confirms a successful add ACK and treats a foreign id as duplicate", async () => {
    lanceState.postCommitPersistedIds.set("memories", "foreign-success-id");
    const result = await createProvider().store([
      lockTestEntry("requested-success-id", "foreign-success-hash"),
    ]);

    expect(result).toEqual({
      inserted: 0,
      duplicates: 1,
      records: [{
        requestedId: "requested-success-id",
        persistedId: "foreign-success-id",
        stored: false,
      }],
    });
  });

  it("fails partial when exact confirmation misses but general lookup echoes requested id", async () => {
    lanceState.hideExactRequestedQueries.set("memories", 1);
    const store = createProvider().store([
      lockTestEntry("inconsistent-requested-id", "inconsistent-query-hash"),
    ]);

    await expect(store).rejects.toMatchObject({
      message: "LanceDB store partially completed",
      receipt: { inserted: 0, duplicates: 0, records: [] },
    });
  });

  it("keeps mixed-batch receipt accurate when one add resolves foreign and another persists", async () => {
    lanceState.postCommitPersistedIds.set("memories", "foreign-mixed-id");
    const result = await createProvider().store([
      lockTestEntry("mixed-foreign", "mixed-foreign-hash"),
      lockTestEntry("mixed-stored", "mixed-stored-hash"),
    ]);

    expect(result).toEqual({
      inserted: 1,
      duplicates: 1,
      records: [
        { requestedId: "mixed-foreign", persistedId: "foreign-mixed-id", stored: false },
        { requestedId: "mixed-stored", persistedId: "mixed-stored", stored: true },
      ],
    });
  });

  it("reports a completed receipt when release fails after a successful store", async () => {
    lanceState.tamperLockOnExactQuery = true;
    await expect(createProvider().store([
      lockTestEntry("cleanup-after-success", "cleanup-success-hash"),
    ])).rejects.toMatchObject({
      name: "LanceDBStoreCleanupError",
      cleanupFailed: true,
      operationStatus: "completed",
      receipt: {
        inserted: 1,
        duplicates: 0,
        records: [{
          requestedId: "cleanup-after-success",
          persistedId: "cleanup-after-success",
          stored: true,
        }],
      },
    });
  });

  it("preserves the original partial receipt when release also fails", async () => {
    lanceState.addFailures.set("memories", new Error("pre-commit failure"));
    lanceState.tamperLockOnExactQuery = true;
    await expect(createProvider().store([
      lockTestEntry("cleanup-after-partial", "cleanup-partial-hash"),
    ])).rejects.toMatchObject({
      name: "LanceDBStoreCleanupError",
      cleanupFailed: true,
      operationStatus: "partial",
      receipt: { inserted: 0, duplicates: 0, records: [] },
    });
  });

  it("times out instead of waiting forever and releases the lock after the owner finishes", async () => {
    lanceState.addDelayMs = 80;
    const owner = createProvider(undefined, {
      writeLockTimeoutMs: 500,
      writeLockRetryMs: 2,
      writeLockStaleMs: 5_000,
    });
    const waiter = createProvider(undefined, {
      writeLockTimeoutMs: 15,
      writeLockRetryMs: 2,
      writeLockStaleMs: 5_000,
    });
    const entry: MemoryEntry = {
      id: "lock-owner",
      text: "lock owner",
      contentHash: "lock-timeout-hash",
      vector: [0.1],
      importance: 0.5,
      category: "other",
      dataType: "memory",
      metadata: {},
      createdAt: 1,
      tenantId: "tenant-a",
      userId: "user-a",
      canonicalProjectId: "project-a",
      productId: "app-a",
      producerId: "agent-a",
      namespace: "memories",
      visibility: "private",
    };

    const ownerStore = owner.store([entry]);
    while (lanceState.activeAdds === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await expect(waiter.store([{ ...entry, id: "lock-waiter" }]))
      .rejects.toThrow(/^LanceDB write lock acquisition timed out$/);
    await expect(ownerStore).resolves.toMatchObject({ inserted: 1 });

    lanceState.addDelayMs = 0;
    await expect(waiter.store([{ ...entry, id: "after-release" }]))
      .resolves.toMatchObject({ inserted: 0, duplicates: 1 });
    expect(readdirSync(DB_PATH).filter((name) => name.includes(".candidate-"))).toEqual([]);
  });

  it("removes a candidate by inode when fsync fails without leaking retry files", async () => {
    mkdirSync(DB_PATH, { recursive: true, mode: 0o700 });
    const probePath = join(DB_PATH, "sync-probe");
    const probe = await openFile(probePath, "w", 0o600);
    const sync = vi.spyOn(Object.getPrototypeOf(probe) as { sync(): Promise<void> }, "sync")
      .mockRejectedValueOnce(new Error("fsync failed"));
    await probe.close();
    rmSync(probePath, { force: true });
    try {
      await expect(createProvider().store([lockTestEntry("fsync-failure")]))
        .rejects.toThrow(/^LanceDB write lock initialization failed$/);
    } finally {
      sync.mockRestore();
    }
    expect(readdirSync(DB_PATH).filter((name) =>
      name.includes(".candidate-") || name.includes(".failed-"))).toEqual([]);
  });

  it("never auto-recovers a stale dead-owner lock and requires explicit operator removal", async () => {
    const lockPath = join(DB_PATH, ".mengshu-write.lock");
    mkdirSync(DB_PATH, { recursive: true, mode: 0o700 });
    writeFileSync(lockPath, JSON.stringify({
      version: 1,
      token: "11111111-1111-4111-8111-111111111111",
      pid: 2_147_483_647,
      createdMonotonicNs: (process.hrtime.bigint() - 60_000_000_000n).toString(),
      processStartMonotonicNs: "1",
    }), { mode: 0o600 });

    const provider = createProvider(undefined, {
      writeLockTimeoutMs: 15,
      writeLockRetryMs: 2,
      writeLockStaleMs: 10,
    });
    await expect(provider.store([lockTestEntry("stale-blocked", "stale-hash")]))
      .rejects.toThrow(/^LanceDB write lock acquisition timed out$/);
    expect(existsSync(lockPath)).toBe(true);

    rmSync(lockPath, { force: true });
    await expect(provider.store([lockTestEntry("operator-recovered", "stale-hash")]))
      .resolves.toMatchObject({ inserted: 1 });
  });

  it("inspect/recover requires quiescence, exact token, complete owner and proven death", async () => {
    const token = "77777777-7777-4777-8777-777777777777";
    const lockPath = writeOperatorLock(token, 2_147_483_647);
    const provider = createProvider();

    await expect(provider.inspectWriteLock()).resolves.toEqual({
      status: "locked-valid",
      recoveryGuardStatus: "absent",
      onlineSafe: false,
      requiredPrecondition: "global-quiescence",
      token,
      ownerPid: 2_147_483_647,
      ownerDefinitelyDead: true,
    });
    await expect(provider.recoverWriteLock({
      confirmQuiescent: false,
      expectedToken: token,
    } as never)).rejects.toThrow(/confirmed global quiescence/i);
    await expect(provider.recoverWriteLock({
      confirmQuiescent: true,
      expectedToken: "88888888-8888-4888-8888-888888888888",
    })).rejects.toThrow(/token mismatch/i);
    expect(existsSync(lockPath)).toBe(true);

    await expect(provider.recoverWriteLock({
      confirmQuiescent: true,
      expectedToken: token,
    })).resolves.toEqual({
      recovered: true,
      token,
      onlineSafe: false,
      requiredPrecondition: "global-quiescence-confirmed",
    });
    await expect(provider.inspectWriteLock()).resolves.toMatchObject({ status: "unlocked" });
  });

  it("operator recovery rejects live PID and EPERM as unproven death", async () => {
    const liveToken = "99999999-9999-4999-8999-999999999999";
    writeOperatorLock(liveToken, process.pid);
    const provider = createProvider();
    await expect(provider.recoverWriteLock({
      confirmQuiescent: true,
      expectedToken: liveToken,
    })).rejects.toThrow(/death is not proven/i);

    rmSync(join(DB_PATH, ".mengshu-write.lock"), { force: true });
    const deniedToken = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    writeOperatorLock(deniedToken, 123_456);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    try {
      await expect(provider.recoverWriteLock({
        confirmQuiescent: true,
        expectedToken: deniedToken,
      })).rejects.toThrow(/death is not proven/i);
    } finally {
      kill.mockRestore();
    }
  });

  it("operator recovery refuses incomplete owner metadata without deleting it", async () => {
    mkdirSync(DB_PATH, { recursive: true, mode: 0o700 });
    const lockPath = join(DB_PATH, ".mengshu-write.lock");
    writeFileSync(lockPath, "{", { mode: 0o600 });
    const provider = createProvider();

    await expect(provider.inspectWriteLock()).resolves.toMatchObject({ status: "locked-invalid" });
    await expect(provider.recoverWriteLock({
      confirmQuiescent: true,
      expectedToken: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    })).rejects.toThrow(/owner metadata is invalid/i);
    expect(existsSync(lockPath)).toBe(true);
  });

  it("operator recovery is single-flight across concurrent callers", async () => {
    const token = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    writeOperatorLock(token, 2_147_483_647);
    const first = createProvider();
    const second = createProvider();

    const results = await Promise.allSettled([
      first.recoverWriteLock({ confirmQuiescent: true, expectedToken: token }),
      second.recoverWriteLock({ confirmQuiescent: true, expectedToken: token }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(existsSync(join(DB_PATH, ".mengshu-write.lock"))).toBe(false);
  });

  it("a leftover recovery guard blocks writers and is never auto-stolen", async () => {
    mkdirSync(DB_PATH, { recursive: true, mode: 0o700 });
    writeFileSync(join(DB_PATH, ".mengshu-write-recovery.guard"), JSON.stringify({
      version: 1,
      token: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      pid: 2_147_483_647,
      createdMonotonicNs: process.hrtime.bigint().toString(),
      processStartMonotonicNs: "1",
    }), { mode: 0o600 });
    const provider = createProvider(undefined, {
      writeLockTimeoutMs: 15,
      writeLockRetryMs: 2,
      writeLockStaleMs: 5,
    });

    await expect(provider.inspectWriteLock()).resolves.toMatchObject({
      status: "recovery-blocked",
      recoveryGuardStatus: "valid",
      token: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      ownerPid: 2_147_483_647,
      ownerDefinitelyDead: true,
    });

    await expect(provider.store([lockTestEntry("guard-blocked")]))
      .rejects.toThrow(/^LanceDB write lock acquisition timed out$/);
    expect(existsSync(join(DB_PATH, ".mengshu-write-recovery.guard"))).toBe(true);
  });

  it("re-checks the recovery guard after candidate fsync and never publishes the fixed lock", async () => {
    mkdirSync(DB_PATH, { recursive: true, mode: 0o700 });
    const guardPath = join(DB_PATH, ".mengshu-write-recovery.guard");
    const probePath = join(DB_PATH, "sync-interleave-probe");
    const probe = await openFile(probePath, "w", 0o600);
    const prototype = Object.getPrototypeOf(probe) as { sync(): Promise<void> };
    const originalSync = prototype.sync;
    const sync = vi.spyOn(prototype, "sync").mockImplementationOnce(async function (
      this: { sync(): Promise<void> },
    ) {
      await originalSync.call(this);
      writeFileSync(guardPath, JSON.stringify({
        version: 1,
        token: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        pid: process.pid,
        createdMonotonicNs: process.hrtime.bigint().toString(),
        processStartMonotonicNs: "1",
      }), { mode: 0o600 });
    });
    await probe.close();
    rmSync(probePath, { force: true });

    try {
      await expect(createProvider(undefined, {
        writeLockTimeoutMs: 15,
        writeLockRetryMs: 2,
      }).store([lockTestEntry("guard-interleave")]))
        .rejects.toThrow(/^LanceDB write lock acquisition timed out$/);
    } finally {
      sync.mockRestore();
    }

    expect(existsSync(join(DB_PATH, ".mengshu-write.lock"))).toBe(false);
    expect(readdirSync(DB_PATH).filter((name) => name.includes(".candidate-"))).toEqual([]);
    expect(existsSync(guardPath)).toBe(true);
  });

  it("reports an invalid recovery guard as blocked instead of unlocked", async () => {
    mkdirSync(DB_PATH, { recursive: true, mode: 0o700 });
    writeFileSync(join(DB_PATH, ".mengshu-write-recovery.guard"), "{", { mode: 0o600 });

    await expect(createProvider().inspectWriteLock()).resolves.toEqual({
      status: "recovery-blocked",
      recoveryGuardStatus: "invalid",
      onlineSafe: false,
      requiredPrecondition: "global-quiescence",
    });
  });

  it("serializes three waiters after operator removes stale A without renaming the new owner", async () => {
    const lockPath = join(DB_PATH, ".mengshu-write.lock");
    mkdirSync(DB_PATH, { recursive: true, mode: 0o700 });
    writeFileSync(lockPath, JSON.stringify({
      version: 1,
      token: "55555555-5555-4555-8555-555555555555",
      pid: 2_147_483_647,
      createdMonotonicNs: (process.hrtime.bigint() - 60_000_000_000n).toString(),
      processStartMonotonicNs: "1",
    }), { mode: 0o600 });
    const options = {
      writeLockTimeoutMs: 500,
      writeLockRetryMs: 2,
      writeLockStaleMs: 5,
    };
    const providers = [createProvider(undefined, options), createProvider(undefined, options), createProvider(undefined, options)];
    const stores = providers.map((provider, index) => provider.store([
      lockTestEntry(`waiter-${index}`, "waiter-shared-hash"),
    ]));

    await new Promise((resolve) => setTimeout(resolve, 10));
    rmSync(lockPath, { force: true });
    const results = await Promise.all(stores);

    expect(results.reduce((sum, result) => sum + result.inserted, 0)).toBe(1);
    expect(results.reduce((sum, result) => sum + result.duplicates, 0)).toBe(2);
    expect(new Set(results.map((result) => result.records[0]?.persistedId)).size).toBe(1);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("does not auto-recover even after a separate owner process exits", async () => {
    mkdirSync(DB_PATH, { recursive: true, mode: 0o700 });
    const lockPath = join(DB_PATH, ".mengshu-write.lock");
    const script = String.raw`
      const fs = require("node:fs");
      const lockPath = process.argv[1];
      const start = process.hrtime.bigint() - BigInt(Math.floor(process.uptime() * 1e9));
      fs.writeFileSync(lockPath, JSON.stringify({
        version: 1,
        token: "22222222-2222-4222-8222-222222222222",
        pid: process.pid,
        createdMonotonicNs: process.hrtime.bigint().toString(),
        processStartMonotonicNs: start.toString(),
      }), { mode: 0o600 });
      process.stdout.write("ready\n");
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ["-e", script, lockPath], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        child.once("error", rejectReady);
        child.stdout!.once("data", () => resolveReady());
      });
      await expect(createProvider(undefined, {
        writeLockTimeoutMs: 15,
        writeLockRetryMs: 2,
        writeLockStaleMs: 5,
      }).store([lockTestEntry("child-live")]))
        .rejects.toThrow(/^LanceDB write lock acquisition timed out$/);
    } finally {
      child.kill("SIGTERM");
      await once(child, "close");
    }

    await expect(createProvider(undefined, {
      writeLockTimeoutMs: 15,
      writeLockRetryMs: 2,
      writeLockStaleMs: 5,
    }).store([lockTestEntry("child-dead")]))
      .rejects.toThrow(/^LanceDB write lock acquisition timed out$/);
    expect(existsSync(lockPath)).toBe(true);
  });

  it("does not steal an old lock whose owner process is still alive", async () => {
    const lockPath = join(DB_PATH, ".mengshu-write.lock");
    mkdirSync(DB_PATH, { recursive: true, mode: 0o700 });
    writeFileSync(lockPath, JSON.stringify({
      version: 1,
      token: "33333333-3333-4333-8333-333333333333",
      pid: process.pid,
      createdMonotonicNs: (process.hrtime.bigint() - 60_000_000_000n).toString(),
      processStartMonotonicNs: "1",
    }), { mode: 0o600 });

    await expect(createProvider(undefined, {
      writeLockTimeoutMs: 15,
      writeLockRetryMs: 2,
      writeLockStaleMs: 10,
    }).store([{
      id: "must-not-steal",
      text: "must not steal",
      contentHash: "live-lock-hash",
      vector: [0.1],
      importance: 0.5,
      category: "other",
      dataType: "memory",
      metadata: {},
      createdAt: 1,
      tenantId: "tenant-a",
      userId: "user-a",
      canonicalProjectId: "project-a",
      productId: "app-a",
      producerId: "agent-a",
      namespace: "memories",
      visibility: "private",
    }])).rejects.toThrow(/^LanceDB write lock acquisition timed out$/);
  });

  it.each([
    ["missing", undefined],
    ["damaged", "{"],
    ["unsafe-token", JSON.stringify({
      version: 1,
      token: "../../replacement",
      pid: 2_147_483_647,
      createdMonotonicNs: process.hrtime.bigint().toString(),
      processStartMonotonicNs: "1",
    })],
  ])("fails closed without deleting a stale lock whose owner metadata is %s", async (_kind, ownerJson) => {
    const lockPath = join(DB_PATH, ".mengshu-write.lock");
    mkdirSync(DB_PATH, { recursive: true, mode: 0o700 });
    if (ownerJson !== undefined) {
      writeFileSync(lockPath, ownerJson, { mode: 0o600 });
    } else {
      writeFileSync(lockPath, "", { mode: 0o600 });
    }

    await expect(createProvider(undefined, {
      writeLockTimeoutMs: 15,
      writeLockRetryMs: 2,
      writeLockStaleMs: 5,
    }).store([lockTestEntry(`owner-${_kind}`)]))
      .rejects.toThrow(/^LanceDB write lock acquisition timed out$/);
    expect(existsSync(lockPath)).toBe(true);
  });

  it("uses a monotonic acquisition deadline even when wall clock moves backwards", async () => {
    const lockPath = join(DB_PATH, ".mengshu-write.lock");
    mkdirSync(DB_PATH, { recursive: true, mode: 0o700 });
    writeFileSync(lockPath, JSON.stringify({
      version: 1,
      token: "44444444-4444-4444-8444-444444444444",
      pid: process.pid,
      createdMonotonicNs: (process.hrtime.bigint() - 60_000_000_000n).toString(),
      processStartMonotonicNs: "1",
    }), { mode: 0o600 });
    let wallClock = 10_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => --wallClock);
    try {
      await expect(createProvider(undefined, {
        writeLockTimeoutMs: 15,
        writeLockRetryMs: 2,
        writeLockStaleMs: 5,
      }).store([lockTestEntry("clock-rollback")]))
        .rejects.toThrow(/^LanceDB write lock acquisition timed out$/);
    } finally {
      now.mockRestore();
    }
  });

  it("rejects an existing database directory unless it is private mode 0700", async () => {
    mkdirSync(DB_PATH, { recursive: true, mode: 0o700 });
    chmodSync(DB_PATH, 0o755);
    await expect(createProvider().store([lockTestEntry("unsafe-mode")]))
      .rejects.toThrow(/^LanceDB database path is not a safe private directory$/);
    expect(lanceState.connectCalls).toEqual([]);
  });

  it("freezes a relative database path at construction so chdir cannot split lock and connection", async () => {
    const originalCwd = process.cwd();
    const base = mkdtempSync(join(realpathSync(tmpdir()), "mengshu-relative-path-"));
    chmodSync(base, 0o700);
    const elsewhere = mkdtempSync(join(realpathSync(tmpdir()), "mengshu-relative-elsewhere-"));
    chmodSync(elsewhere, 0o700);
    let provider: LanceDBProvider | undefined;
    try {
      process.chdir(base);
      provider = new LanceDBProvider("relative-db", "text-embedding-3-small");
      process.chdir(elsewhere);
      await provider.initialize();
      expect(lanceState.connectCalls.at(-1)).toBe(join(base, "relative-db"));
      expect(existsSync(join(base, "relative-db"))).toBe(true);
      expect(existsSync(join(elsewhere, "relative-db"))).toBe(false);
    } finally {
      process.chdir(originalCwd);
      await provider?.close();
      rmSync(base, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("resolves an existing symlink ancestor once and cannot be redirected afterward", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "mengshu-symlink-root-"));
    chmodSync(root, 0o700);
    const firstTarget = join(root, "first");
    const secondTarget = join(root, "second");
    const linkPath = join(root, "link");
    mkdirSync(firstTarget, { mode: 0o700 });
    mkdirSync(secondTarget, { mode: 0o700 });
    symlinkSync(firstTarget, linkPath);
    const provider = new LanceDBProvider(join(linkPath, "db"), "text-embedding-3-small");
    unlinkSync(linkPath);
    symlinkSync(secondTarget, linkPath);
    try {
      await provider.initialize();
      expect(lanceState.connectCalls.at(-1)).toBe(join(firstTarget, "db"));
      expect(existsSync(join(firstTarget, "db"))).toBe(true);
      expect(existsSync(join(secondTarget, "db"))).toBe(false);
    } finally {
      await provider.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects replacement of the canonical database directory inode after construction", async () => {
    mkdirSync(DB_PATH, { recursive: true, mode: 0o700 });
    const provider = createProvider();
    rmSync(DB_PATH, { recursive: true, force: true });
    mkdirSync(DB_PATH, { recursive: true, mode: 0o700 });

    await expect(provider.initialize())
      .rejects.toThrow(/^LanceDB database path identity changed$/);
    expect(lanceState.connectCalls).toEqual([]);
  });

  it("fails closed if an operator replaces the directory behind cached table handles", async () => {
    const provider = createProvider();
    await provider.initialize();
    rmSync(DB_PATH, { recursive: true, force: true });
    mkdirSync(DB_PATH, { recursive: true, mode: 0o700 });

    await expect(provider.query({
      tableName: "memories",
      tenantId: "tenant-a",
      userId: "user-a",
    })).rejects.toThrow(/^LanceDB database path identity changed$/);
  });

  it("serializes explicit initialize schema creation across provider instances", async () => {
    lanceState.existingTables = [];
    lanceState.tableNamesDelayMs = 20;
    const first = createProvider();
    const second = createProvider();

    await Promise.all([first.initialize(), second.initialize()]);

    expect(lanceState.createCalls.filter((name) => name === "memories")).toHaveLength(1);
    expect(lanceState.createCalls.filter((name) => name === "knowledge")).toHaveLength(1);
  });

  it("fails at construction when the POSIX owner capability is unavailable", () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
    try {
      expect(() => createProvider()).toThrow(
        /^LanceDB write locking requires getuid and O_NOFOLLOW$/,
      );
    } finally {
      if (descriptor) Object.defineProperty(process, "getuid", descriptor);
    }
  });

  it("does not open or search on-disk knowledge tables that are not configured", async () => {
    lanceState.existingTables.push("knowledge_legacy_orphan");
    const provider = createProvider();

    await provider.initialize();
    await expect(
      provider.query({
        tableName: "knowledge_legacy_orphan",
        tenantId: "tenant-a",
        userId: "user-a",
      }),
    ).rejects.toThrow(/tableName/i);

    expect(lanceState.openCalls).not.toContain("knowledge_legacy_orphan");
    expect(lanceState.createCalls).not.toContain("knowledge_legacy_orphan");
  });
});
