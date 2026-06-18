import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { MemoryService, StoreMemoryInput, RecallInput, DeleteMemoryInput } from "../../core/service-types.js";
import type { MemoryRecord, RecallResult } from "../../core/types.js";
import { IngestionPipeline } from "../../ingest/pipeline.js";
import { InMemoryMemoryStore } from "../../storage/repositories/in-memory.js";
import {
  handleMemoryCleanup,
  handleMemoryForget,
  handleMemoryRecall,
  handleMemoryScanDirectory,
  handleMemoryStore,
} from "./tools.js";

const scope = {
  tenantId: "local",
  appId: "openclaw",
  userId: "user-1",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "memories",
};

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem-1",
    scope,
    kind: "preference",
    text: "The user prefers dark mode",
    contentHash: "hash-1",
    importance: 0.8,
    category: "preference",
    dataType: "memory",
    tableName: "memories",
    metadata: { source: "user" },
    provenance: { source: "user" },
    createdAt: 1710000000000,
    vector: [0.1, 0.2],
    ...overrides,
  };
}

class FakeMemoryService implements MemoryService {
  stores: StoreMemoryInput[] = [];
  recalls: RecallInput[] = [];
  deletes: DeleteMemoryInput[] = [];

  constructor(private readonly recallResult: RecallResult = { scope, query: "", hits: [] }) {}

  async storeMemory(input: StoreMemoryInput) {
    this.stores.push(input);
    return { id: input.record.id, stored: true };
  }

  async recall(input: RecallInput) {
    this.recalls.push(input);
    return {
      ...this.recallResult,
      query: input.query,
    };
  }

  async buildContext() {
    return {
      scope,
      content: "",
      hits: [],
      tokenEstimate: 0,
    };
  }

  async delete(input: DeleteMemoryInput) {
    this.deletes.push(input);
    return { deleted: input.ids?.length ?? 3 };
  }

  async health() {
    return { ok: true, records: 0 };
  }
}

describe("OpenClaw memory tool handlers", () => {
  test("stores new memory through MemoryService with enriched metadata", async () => {
    const service = new FakeMemoryService();
    const result = await handleMemoryStore(
      {
        text: "The user prefers dark mode",
        importance: 0.9,
        category: "other",
        storageCategory: "用户偏好",
        metadata: { userId: "user-1", projectPath: "project-1", agentName: "agent-1" },
      },
      {
        service,
        embed: async () => [0.3, 0.4],
        existsByContentHash: async () => [],
        embeddingModel: "text-embedding-3-small",
        idFactory: () => "mem-created",
        now: () => 1710000000000,
      },
    );

    expect(result.details).toMatchObject({
      action: "created",
      id: "mem-created",
      targetTables: ["memories"],
      storageCategory: "核心记忆",
    });
    expect(service.stores).toHaveLength(1);
    expect(service.stores[0].record).toMatchObject({
      id: "mem-created",
      text: "The user prefers dark mode",
      category: "preference",
      dataType: "memory",
      tableName: "memories",
      vector: [0.3, 0.4],
      scope,
    });
  });

  test("does not store duplicate content", async () => {
    const service = new FakeMemoryService();
    const result = await handleMemoryStore(
      { text: "The user prefers dark mode" },
      {
        service,
        embed: async () => {
          throw new Error("should not embed duplicates");
        },
        existsByContentHash: async (hashes) => hashes,
        embeddingModel: "text-embedding-3-small",
      },
    );

    expect(result.details?.action).toBe("duplicate");
    expect(service.stores).toEqual([]);
  });

  test("recalls memories through MemoryService and preserves legacy output shape", async () => {
    const service = new FakeMemoryService({
      scope,
      query: "dark mode",
      hits: [
        {
          record: makeRecord({ score: undefined } as Partial<MemoryRecord>),
          score: 0.91,
          source: "vector",
          scoreBreakdown: { vector: 0.91 },
        },
      ],
    });

    const result = await handleMemoryRecall(
      {
        query: "dark mode",
        includeDocuments: true,
        limit: 3,
        minScore: 0.2,
        category: "核心记忆",
      },
      { service },
    );

    expect(service.recalls).toEqual([
      {
        query: "dark mode",
        limit: 3,
        minScore: 0.2,
        dataTypes: ["memory", "document"],
        filter: undefined,
        tableName: "memories",
        searchAll: false,
      },
    ]);
    expect(result.content[0].text).toContain("Found 1 memories");
    expect(result.details?.memories).toEqual([
      {
        id: "mem-1",
        text: "The user prefers dark mode",
        category: "preference",
        dataType: "memory",
        tableName: "memories",
        metadata: { source: "user" },
        importance: 0.8,
        score: 0.91,
      },
    ]);
  });

  test("forgets by id, filter, or high-confidence query match", async () => {
    const service = new FakeMemoryService({
      scope,
      query: "dark mode",
      hits: [{ record: makeRecord(), score: 0.95, source: "vector" }],
    });

    await handleMemoryForget({ memoryId: "mem-1" }, { service });
    await handleMemoryForget({ filter: { tableName: "memories" } }, { service });
    const queryResult = await handleMemoryForget({ query: "dark mode" }, { service });

    expect(service.deletes).toEqual([
      { ids: ["mem-1"] },
      { filter: { tableName: "memories" } },
      { ids: ["mem-1"] },
    ]);
    expect(queryResult.details).toEqual({ action: "deleted", id: "mem-1" });
  });

  test("cleanup requires at least one filter and delegates delete to MemoryService", async () => {
    const service = new FakeMemoryService();

    await expect(handleMemoryCleanup({}, { service })).resolves.toMatchObject({
      details: { error: "no_filter_provided" },
    });
    await expect(
      handleMemoryCleanup({ dataType: "memory", olderThanDays: 7 }, { service, now: () => 1710000000000 }),
    ).resolves.toMatchObject({
      details: {
        action: "cleanup",
        deletedCount: 3,
      },
    });
    expect(service.deletes[0]).toEqual({
      filter: {
        dataType: "memory",
        createdAt: { $lt: 1709395200000 },
      },
    });
  });

  test("scans a directory through ingestion pipeline and reports new counters", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-scan-tool-"));
    try {
      await fs.writeFile(path.join(tmpDir, "guide.md"), "# Guide\n\nalpha beta gamma", "utf8");
      const store = new InMemoryMemoryStore();
      const pipeline = new IngestionPipeline({
        documents: store.documents,
        chunks: store.chunks,
        jobs: store.jobs,
        audit: store.audit,
      });

      const result = await handleMemoryScanDirectory(
        { directory: tmpDir, targetTable: "knowledge" },
        {
          pipeline,
          resolvePath: (input) => input,
        },
      );

      expect(result.content[0].text).toContain("- Jobs queued:");
      expect(result.content[0].text).toContain("- Chunks admitted:");
      expect(result.content[0].text).toContain("- Chunks dropped:");
      expect(result.details).toMatchObject({
        directory: tmpDir,
        totalFiles: 1,
        processedFiles: 1,
        failedFiles: 0,
        targetTable: "knowledge",
        autoEnrichMetadata: true,
      });
      await expect(store.documents.list()).resolves.toHaveLength(1);
      await expect(store.jobs.list("queued")).resolves.toHaveLength(result.details.jobsQueued as number);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
