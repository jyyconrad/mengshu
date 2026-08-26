import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import type {
  AuthorityScopedForgetInput,
  AuthorityScopedForgetService,
  MemoryService,
  StoreMemoryInput,
  RecallInput,
  DeleteMemoryInput,
} from "../../../core/service-types.js";
import type { MemoryRecord, RecallResult } from "../../../core/types.js";
import { IngestionPipeline } from "../../../ingest/pipeline.js";
import { InMemoryMemoryStore } from "../../../storage/repositories/in-memory.js";
import {
  handleMemoryCleanup,
  handleMemoryForget,
  handleMemoryRecall,
  handleMemoryScanDirectory,
  handleMemoryStore,
  bindOpenClawPipelineAuthority,
} from "./tools.js";
import { createExactOpenClawAuthority } from "./authority.js";
import { computeRecallScoreBreakdown } from "../../../core/recall-scoring.js";

const scope = {
  tenantId: "local",
  appId: "openclaw",
  userId: "user-1",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "memories",
  visibility: "private" as const,
};
const authority = createExactOpenClawAuthority(scope);
const authorityContext = { authority, defaultScope: scope, unsafeLegacyWrite: true as const };

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

function recallHit(record: MemoryRecord, relevance = 0.91, source: "vector" | "tree" = "vector") {
  const scoreBreakdown = computeRecallScoreBreakdown(
    record,
    { relevance, scopeFit: 1 },
    [source],
    { [source]: relevance },
  );
  return { record, score: scoreBreakdown.score, source, scoreBreakdown };
}

class FakeMemoryService implements MemoryService, AuthorityScopedForgetService {
  stores: StoreMemoryInput[] = [];
  recalls: RecallInput[] = [];
  deletes: DeleteMemoryInput[] = [];
  forgets: AuthorityScopedForgetInput[] = [];

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

  async forget(input: AuthorityScopedForgetInput) {
    this.forgets.push(input);
    const affected = input.ids?.length ?? 3;
    return {
      action: input.action,
      affected,
      deleted: input.action === "delete" ? affected : 0,
      affectedIds: input.ids ?? [],
      transactional: true as const,
      idempotentReplay: false,
    };
  }

  async health() {
    return { ok: true, records: 0 };
  }
}

describe("OpenClaw memory tool handlers", () => {
  test("production store delegates to Runtime write capability without embedding or direct store", async () => {
    const service = new FakeMemoryService();
    const directStore = vi.spyOn(service, "storeMemory");
    const executeMemoryWrite = vi.fn(async () => ({
      status: "persisted" as const,
      route: "active" as const,
      recordType: "memory" as const,
      memoryId: "kernel-memory",
      stored: true,
    }));

    const result = await handleMemoryStore(
      {
        text: "The user prefers dark mode",
        idempotencyKey: "openclaw-save-1",
        category: "preference",
      },
      {
        authority,
        defaultScope: scope,
        service,
        memoryWrite: { executeMemoryWrite },
      },
    );

    expect(result.details).toMatchObject({ action: "created", id: "kernel-memory" });
    expect(directStore).not.toHaveBeenCalled();
    expect(executeMemoryWrite).toHaveBeenCalledWith(expect.objectContaining({
      type: "saveExplicit",
      idempotencyKey: "openclaw-save-1",
      serverAuthority: authority,
      clientScope: scope,
      text: "The user prefers dark mode",
      kind: "preference",
    }));
  });

  test("production store fails closed without write capability or idempotency key", async () => {
    const service = new FakeMemoryService();
    const directStore = vi.spyOn(service, "storeMemory");

    await expect(handleMemoryStore(
      { text: "The user prefers dark mode" },
      { authority, defaultScope: scope, service },
    )).rejects.toThrow(/idempotencyKey/);
    await expect(handleMemoryStore(
      { text: "The user prefers dark mode", idempotencyKey: "openclaw-save-2" },
      { authority, defaultScope: scope, service },
    )).rejects.toThrow(/write capability is unavailable/i);
    expect(directStore).not.toHaveBeenCalled();
  });

  test("stores new memory through MemoryService with enriched metadata", async () => {
    const service = new FakeMemoryService();
    const result = await handleMemoryStore(
      {
        text: "The user prefers dark mode",
        importance: 0.9,
        category: "other",
        storageCategory: "用户偏好",
        metadata: { projectPath: "project-1", agentName: "agent-1" },
      },
      {
        ...authorityContext,
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

  test("does not query global content-hash oracle before authority-scoped store", async () => {
    const service = new FakeMemoryService();
    const existsByContentHash = vi.fn(async (hashes: string[]) => hashes);
    const result = await handleMemoryStore(
      { text: "The user prefers dark mode" },
      {
        ...authorityContext,
        service,
        embed: async () => [0.1],
        existsByContentHash,
        embeddingModel: "text-embedding-3-small",
        idFactory: () => "authority-write",
      },
    );

    expect(existsByContentHash).not.toHaveBeenCalled();
    expect(result.details?.action).toBe("created");
    expect(service.stores).toHaveLength(1);
  });

  test("duplicate store reports the persisted record instead of a false created outcome", async () => {
    const service = new FakeMemoryService();
    vi.spyOn(service, "storeMemory").mockImplementation(async (input) => {
      service.stores.push(input);
      return { id: "existing-memory", stored: false };
    });

    const result = await handleMemoryStore(
      { text: "The user prefers dark mode" },
      {
        ...authorityContext,
        service,
        embed: async () => [0.1],
        existsByContentHash: async () => [],
        idFactory: () => "requested-memory",
      },
    );

    expect(result.content[0]?.text).toContain("Already stored");
    expect(result.details).toMatchObject({
      action: "duplicate",
      id: "existing-memory",
      createdCount: 0,
      duplicateCount: 1,
      outcomes: [
        { tableName: "memories", id: "existing-memory", action: "duplicate" },
      ],
    });
  });

  test("multi-table store aggregates created and duplicate outcomes without UI overclaim", async () => {
    const service = new FakeMemoryService();
    vi.spyOn(service, "storeMemory")
      .mockImplementationOnce(async (input) => {
        service.stores.push(input);
        return { id: "created-work", stored: true };
      })
      .mockImplementationOnce(async (input) => {
        service.stores.push(input);
        return { id: "existing-personal", stored: false };
      });

    const ids = ["requested-work", "requested-personal"];
    const result = await handleMemoryStore(
      { text: "Reusable TypeScript knowledge", storageCategory: "知识库" },
      {
        ...authorityContext,
        service,
        embed: async () => [0.1],
        existsByContentHash: async () => [],
        allowedTables: ["memories", "knowledge", "knowledge_work", "knowledge_personal"],
        idFactory: () => ids.shift()!,
        routingEngine: {
          routeToKnowledgeBases: () => ({
            targetTables: ["knowledge_work", "knowledge_personal"],
            matchedRules: [{ name: "multi-target" }],
          }),
        },
      },
    );

    expect(result.content[0]?.text).toContain("1 created, 1 duplicate");
    expect(result.details).toMatchObject({
      action: "mixed",
      id: "created-work",
      createdCount: 1,
      duplicateCount: 1,
      outcomes: [
        { tableName: "knowledge_work", id: "created-work", action: "created" },
        { tableName: "knowledge_personal", id: "existing-personal", action: "duplicate" },
      ],
    });
  });

  test("multi-table store exposes a partial receipt when a later target fails", async () => {
    const service = new FakeMemoryService();
    vi.spyOn(service, "storeMemory")
      .mockImplementationOnce(async (input) => {
        service.stores.push(input);
        return { id: "created-work", stored: true };
      })
      .mockRejectedValueOnce(new Error("raw provider failure"));

    await expect(handleMemoryStore(
      { text: "Reusable knowledge", storageCategory: "知识库" },
      {
        ...authorityContext,
        service,
        embed: async () => [0.1],
        existsByContentHash: async () => [],
        allowedTables: ["memories", "knowledge", "knowledge_work", "knowledge_personal"],
        idFactory: () => "requested-id",
        routingEngine: {
          routeToKnowledgeBases: () => ({
            targetTables: ["knowledge_work", "knowledge_personal"],
            matchedRules: [{ name: "multi-target" }],
          }),
        },
      },
    )).rejects.toMatchObject({
      message: "OpenClaw memory store partially completed",
      receipt: {
        createdCount: 1,
        duplicateCount: 0,
        outcomes: [
          { tableName: "knowledge_work", id: "created-work", action: "created" },
        ],
      },
    });
  });

  test("recalls memories through MemoryService and preserves legacy output shape", async () => {
    const hit = recallHit(makeRecord({ score: undefined } as Partial<MemoryRecord>));
    const service = new FakeMemoryService({
      scope,
      query: "dark mode",
      hits: [hit],
    });

    const result = await handleMemoryRecall(
      {
        query: "dark mode",
        includeDocuments: true,
        limit: 3,
        minScore: 0.2,
        category: "核心记忆",
      },
      { service, ...authorityContext },
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
        scope,
      },
    ]);
    expect(result.content[0].text).toContain("Found 1 memories");
    expect(result.details?.memories).toEqual([
      expect.objectContaining({
        id: "mem-1",
        text: "The user prefers dark mode",
        category: "preference",
        dataType: "memory",
        tableName: "memories",
        metadata: { source: "user" },
        importance: 0.8,
        source: "vector",
        scoreBreakdown: expect.objectContaining({
          weights: expect.any(Object),
          factors: expect.any(Object),
          contributions: expect.any(Object),
          matchedBy: ["vector"],
          sourceSignals: { vector: 0.91 },
        }),
      }),
    ]);
    expect((result.details?.memories as Array<{ scoreBreakdown: unknown }>)[0].scoreBreakdown)
      .toBe(hit.scoreBreakdown);
  });

  test("recall fails closed instead of fabricating a missing breakdown", async () => {
    const service = new FakeMemoryService({
      scope,
      query: "dark mode",
      hits: [{ record: makeRecord(), score: 0.91, source: "vector" }],
    });

    await expect(
      handleMemoryRecall({ query: "dark mode" }, { service, ...authorityContext }),
    ).rejects.toThrow("RECALL_SCORE_BREAKDOWN_REQUIRED");
  });

  test("forgets by id, filter, or high-confidence query match", async () => {
    const service = new FakeMemoryService({
      scope,
      query: "dark mode",
      hits: [{ record: makeRecord(), score: 0.95, source: "vector" }],
    });

    await handleMemoryForget({ memoryId: "mem-1" }, { service, forgetService: service, ...authorityContext });
    await handleMemoryForget({ filter: { category: "fact" } }, { service, forgetService: service, ...authorityContext });
    const queryResult = await handleMemoryForget({ query: "dark mode" }, { service, forgetService: service, ...authorityContext });

    expect(service.deletes).toEqual([]);
    expect(service.forgets).toHaveLength(3);
    expect(service.forgets.map((input) => input.serverAuthority)).toEqual([
      authority, authority, authority,
    ]);
    expect(service.forgets[0]).toMatchObject({ action: "delete", ids: ["mem-1"] });
    expect(service.forgets[1]).toMatchObject({ action: "delete", filter: { category: "fact" } });
    expect(service.forgets[0].clientScope).toEqual({
      appId: scope.appId,
      projectId: scope.projectId,
      agentId: scope.agentId,
      namespace: scope.namespace,
      visibility: scope.visibility,
    });
    expect(service.forgets[0].clientScope).not.toHaveProperty("tenantId");
    expect(service.forgets[0].clientScope).not.toHaveProperty("userId");
    expect(queryResult.details).toEqual({ action: "deleted", id: "mem-1" });
  });

  test("cleanup requires at least one filter and delegates delete to MemoryService", async () => {
    const service = new FakeMemoryService();

    await expect(handleMemoryCleanup({}, { service, forgetService: service, ...authorityContext })).resolves.toMatchObject({
      details: { error: "no_filter_provided" },
    });
    await expect(
      handleMemoryCleanup(
        { dataType: "memory", filter: { category: "fact" } },
        { service, forgetService: service, ...authorityContext, now: () => 1710000000000 },
      ),
    ).resolves.toMatchObject({
      details: {
        action: "cleanup",
        deletedCount: 3,
      },
    });
    expect(service.deletes).toEqual([]);
    expect(service.forgets[0]).toMatchObject({
      action: "delete",
      dataTypes: ["memory"],
      filter: { category: "fact" },
      serverAuthority: authority,
    });

    const before = service.forgets.length;
    await expect(handleMemoryCleanup(
      { olderThanDays: 7, filter: { category: "fact" } },
      { service, forgetService: service, ...authorityContext },
    )).rejects.toMatchObject({ code: "RANGE_DELETE_UNSUPPORTED" });
    expect(service.forgets).toHaveLength(before);
    expect(service.deletes).toEqual([]);
  });

  test.each([0, -1, Number.NaN])("cleanup rejects invalid olderThanDays=%s before transaction", async (olderThanDays) => {
    const service = new FakeMemoryService();
    await expect(handleMemoryCleanup(
      { olderThanDays, filter: { category: "fact" } },
      { service, forgetService: service, ...authorityContext },
    )).rejects.toMatchObject({ code: "OLDER_THAN_DAYS_INVALID" });
    expect(service.forgets).toEqual([]);
  });

  test.each([
    { category: { $eq: "fact" } },
    { category: ["fact"] },
    { "raw->>key": "x" },
    { category: "fact' OR 1=1 --" },
    { nested: { category: "fact" } },
  ])("rejects unsafe filter %j before recall/forget", async (filter) => {
    const service = new FakeMemoryService();
    await expect(handleMemoryRecall(
      { query: "safe query", filter },
      { service, ...authorityContext },
    )).rejects.toMatchObject({ code: "FILTER_INVALID" });
    await expect(handleMemoryForget(
      { filter },
      { service, forgetService: service, ...authorityContext },
    )).rejects.toMatchObject({ code: "FILTER_INVALID" });
    expect(service.recalls).toEqual([]);
    expect(service.forgets).toEqual([]);
  });

  test("rejects prototype filter keys from parsed JSON", async () => {
    const service = new FakeMemoryService();
    const filter = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    await expect(handleMemoryCleanup(
      { filter },
      { service, forgetService: service, ...authorityContext },
    )).rejects.toMatchObject({ code: "FILTER_INVALID" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(service.forgets).toEqual([]);
  });

  test.each([
    null,
    [],
    Object.create({ category: "fact" }),
    { pinned: "true" },
    { createdAt: Number.POSITIVE_INFINITY },
    { importance: 2 },
    { category: "" },
    { category: " fact" },
    { category: "ｆａｃｔ" },
  ])("rejects non-canonical filter shape/value %#", async (filter) => {
    const service = new FakeMemoryService();
    await expect(handleMemoryRecall(
      { query: "safe query", filter: filter as never },
      { service, ...authorityContext },
    )).rejects.toMatchObject({ code: "FILTER_INVALID" });
    expect(service.recalls).toEqual([]);
  });

  test("accepts allowlisted scalar filter values and custom knowledge table", async () => {
    const service = new FakeMemoryService();
    await handleMemoryRecall(
      {
        query: "safe query",
        knowledgeBase: "knowledge_work",
        filter: { pinned: true, createdAt: 1710000000000, importance: 0.8 },
      },
      {
        service,
        ...authorityContext,
        allowedTables: ["memories", "knowledge", "knowledge_work"],
      },
    );
    expect(service.recalls[0]).toMatchObject({
      tableName: "knowledge_work",
      dataTypes: ["knowledge"],
      searchAll: false,
      filter: { pinned: true, createdAt: 1710000000000, importance: 0.8 },
    });
  });

  test("an explicit knowledgeBase remains single-table even when searchAll is also true", async () => {
    const service = new FakeMemoryService();

    await handleMemoryRecall(
      {
        query: "configured only",
        knowledgeBase: "knowledge_work",
        searchAll: true,
      },
      {
        service,
        ...authorityContext,
        allowedTables: ["memories", "knowledge", "knowledge_work"],
      },
    );

    expect(service.recalls[0]).toMatchObject({
      tableName: "knowledge_work",
      dataTypes: ["knowledge"],
      searchAll: false,
    });
  });

  test("searchAll remains enabled when no specific knowledgeBase is selected", async () => {
    const service = new FakeMemoryService();

    await handleMemoryRecall(
      { query: "all configured", searchAll: true },
      { service, ...authorityContext },
    );

    expect(service.recalls[0]).toMatchObject({ searchAll: true });
    expect(service.recalls[0]?.tableName).toBeUndefined();
  });

  test("routing engine 返回非 allowlist table 时在 embed/store 前拒绝", async () => {
    const service = new FakeMemoryService();
    const embed = vi.fn(async () => [0.1]);
    await expect(handleMemoryStore(
      { text: "knowledge routing", storageCategory: "知识库" },
      {
        service,
        ...authorityContext,
        existsByContentHash: async () => [],
        embed,
        routingEngine: {
          routeToKnowledgeBases: () => ({
            targetTables: ["knowledge_;DROP" as never],
            matchedRules: [],
          }),
        },
      },
    )).rejects.toMatchObject({ code: "TABLE_NAME_INVALID" });
    expect(embed).not.toHaveBeenCalled();
    expect(service.stores).toEqual([]);
  });

  test.each([
    "memories;DROP TABLE memories",
    "knowledge_x OR 1=1",
    "documents",
    "knowledge_../secret",
    "__proto__",
  ])("rejects unsafe knowledgeBase/targetTable=%s before query/path", async (tableName) => {
    const service = new FakeMemoryService();
    const resolvePath = vi.fn((input: string) => input);
    await expect(handleMemoryRecall(
      { query: "safe query", knowledgeBase: tableName },
      { service, ...authorityContext },
    )).rejects.toMatchObject({ code: "TABLE_NAME_INVALID" });
    await expect(handleMemoryScanDirectory(
      { directory: "/tmp/docs", targetTable: tableName },
      { pipeline: {} as IngestionPipeline, resolvePath, ...authorityContext },
    )).rejects.toMatchObject({ code: "TABLE_NAME_INVALID" });
    expect(service.recalls).toEqual([]);
    expect(resolvePath).not.toHaveBeenCalled();
  });

  test("rejects 100 syntactically valid but unconfigured knowledge tables before side effects", async () => {
    const service = new FakeMemoryService();
    const resolvePath = vi.fn((input: string) => input);

    for (let index = 0; index < 100; index += 1) {
      const tableName = `knowledge_unconfigured_${index}`;
      await expect(handleMemoryRecall(
        { query: "safe query", knowledgeBase: tableName },
        { service, ...authorityContext },
      )).rejects.toMatchObject({ code: "TABLE_NAME_INVALID" });
      await expect(handleMemoryScanDirectory(
        { directory: "/tmp/docs", targetTable: tableName },
        { pipeline: {} as IngestionPipeline, resolvePath, ...authorityContext },
      )).rejects.toMatchObject({ code: "TABLE_NAME_INVALID" });
    }

    expect(service.recalls).toEqual([]);
    expect(resolvePath).not.toHaveBeenCalled();
  });

  test("routing rejects a syntactically valid unconfigured table before embed/store", async () => {
    const service = new FakeMemoryService();
    const embed = vi.fn(async () => [0.1]);

    await expect(handleMemoryStore(
      { text: "knowledge routing", storageCategory: "知识库" },
      {
        service,
        ...authorityContext,
        existsByContentHash: async () => [],
        embed,
        routingEngine: {
          routeToKnowledgeBases: () => ({
            targetTables: ["knowledge_unconfigured"],
            matchedRules: [],
          }),
        },
      },
    )).rejects.toMatchObject({ code: "TABLE_NAME_INVALID" });

    expect(embed).not.toHaveBeenCalled();
    expect(service.stores).toEqual([]);
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
      bindOpenClawPipelineAuthority(pipeline, authority, scope);

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

  test("recalls memories using the same scope as store for OpenClaw", async () => {
    // Use OpenClaw's runtime defaultScope (from runtime.ts defaultScope function)
    const openClawRuntimeDefaultScope = {
      tenantId: "default",  // openclaw uses "default"
      appId: "openclaw",
      userId: "default",
      projectId: "default",
      agentId: "default",
      namespace: "default",  // openclaw uses "default"
      visibility: "private" as const,
    };

    const service = new FakeMemoryService({
      scope: openClawRuntimeDefaultScope,
      query: "scope test",
      hits: [
        recallHit(
          makeRecord({ text: "OpenClaw scope test", scope: openClawRuntimeDefaultScope }),
          0.85,
        ),
      ],
    });

    // Store with OpenClaw runtime default scope
    await handleMemoryStore(
      {
        text: "OpenClaw scope test",
        importance: 0.8,
        category: "preference",
      },
      {
        authority: createExactOpenClawAuthority(openClawRuntimeDefaultScope),
        defaultScope: openClawRuntimeDefaultScope,
        service,
        unsafeLegacyWrite: true,
        embed: async () => [0.5, 0.6],
        existsByContentHash: async () => [],
        embeddingModel: "test-model",
        idFactory: () => "mem-scope-test",
        now: () => 1710000000000,
      },
    );

    // Clear previous recalls
    service.recalls = [];

    // Recall with OpenClaw runtime.defaultScope (passed directly as MemoryScope)
    await handleMemoryRecall(
      {
        query: "scope test",
        limit: 5,
        minScore: 0.1,
      },
      {
        authority: createExactOpenClawAuthority(openClawRuntimeDefaultScope),
        defaultScope: openClawRuntimeDefaultScope,
        service,
      },
    );

    // Verify recall was called with same scope structure as runtime.defaultScope
    expect(service.recalls).toHaveLength(1);
    expect(service.recalls[0]).toMatchObject({
      query: "scope test",
      scope: {
        tenantId: "default",
        appId: "openclaw",
        userId: "default",
        projectId: "default",
        agentId: "default",
        namespace: "default",
      },
    });
  });

  test("recall always uses server-owned default scope", async () => {
    const service = new FakeMemoryService();

    await handleMemoryRecall(
      {
        query: "test",
        limit: 5,
      },
      { service, ...authorityContext },
    );

    expect(service.recalls).toHaveLength(1);
    expect(service.recalls[0].scope).toEqual(scope);
  });

  test("recall ignores context metadata as business payload rather than scope claims", async () => {
    const service = new FakeMemoryService();

    // Plain metadata without tenantId/appId (e.g. OpenClaw hook event)
    await expect(handleMemoryRecall(
      { query: "test" },
      {
        ...authorityContext,
        service,
        metadata: { userId: "attacker", projectPath: "project-1", agentName: "agent-1" },
      },
    )).resolves.toMatchObject({ details: { count: 0 } });

    expect(service.recalls).toHaveLength(1);
    expect(service.recalls[0].scope).toEqual(scope);
  });

  test("recalls returns empty message when no hits found", async () => {
    const service = new FakeMemoryService({ scope, query: "", hits: [] });

    const result = await handleMemoryRecall(
      { query: "nothing matches" },
      { service, ...authorityContext },
    );

    expect(result.content[0].text).toBe("No relevant memories found.");
    expect(result.details).toEqual({ count: 0 });
  });

  test("forget returns empty message when query finds no matches", async () => {
    const service = new FakeMemoryService({ scope, query: "nothing", hits: [] });

    const result = await handleMemoryForget({ query: "nothing" }, { service, forgetService: service, ...authorityContext });

    expect(result.content[0].text).toBe("No matching memories found.");
    expect(result.details).toEqual({ found: 0 });
    expect(service.deletes).toHaveLength(0);
  });

  test("forget returns candidates list when multiple low-confidence matches found", async () => {
    const service = new FakeMemoryService({
      scope,
      query: "dark",
      hits: [
        { record: makeRecord({ id: "mem-1", text: "user prefers dark mode" }), score: 0.75, source: "vector" },
        { record: makeRecord({ id: "mem-2", text: "dark background" }), score: 0.72, source: "vector" },
      ],
    });

    const result = await handleMemoryForget({ query: "dark" }, { service, forgetService: service, ...authorityContext });

    expect(result.details).toMatchObject({ action: "candidates" });
    const details = result.details as { action: string; candidates: Array<{ id: string; score: number }> };
    expect(details.candidates).toHaveLength(2);
    expect(details.candidates[0].id).toBe("mem-1");
    expect(details.candidates[1].id).toBe("mem-2");
    expect(result.content[0].text).toContain("candidates");
    // Should NOT delete anything (ambiguous, requires explicit memoryId)
    expect(service.deletes).toHaveLength(0);
  });

  test("forget returns missing_param error when no query, memoryId, or filter provided", async () => {
    const service = new FakeMemoryService();

    const result = await handleMemoryForget({}, { service, forgetService: service, ...authorityContext });

    expect(result.details).toEqual({ error: "missing_param" });
    expect(service.deletes).toHaveLength(0);
  });

  test("recall formats non-MemoryRecord hits (SummaryNode) correctly", async () => {
    const summaryRecord = {
      id: "summary-1",
      scope,
      treeType: "source" as const,
      level: 1,
      summary: "Summary of dark mode preferences",
      childIds: [],
      evidenceIds: [],
      createdAt: 1710000000000,
    };

    const service = new FakeMemoryService({
      scope,
      query: "dark mode",
      hits: [
        recallHit(summaryRecord as never, 0.88, "tree"),
      ],
    });

    const result = await handleMemoryRecall({ query: "dark mode" }, { service, ...authorityContext });

    expect(result.content[0].text).toContain("Found 1 memories");
    // Non-MemoryRecord hit uses summary field for display
    expect(result.content[0].text).toContain("Summary of dark mode preferences");
    expect(result.details?.memories).toMatchObject([
      {
        id: "summary-1",
        source: "tree",
        scoreBreakdown: expect.objectContaining({ matchedBy: ["tree"] }),
      },
    ]);
  });

  test("store routes to knowledge base when routingEngine matches", async () => {
    const service = new FakeMemoryService();

    const result = await handleMemoryStore(
      {
        text: "Technical knowledge about TypeScript",
        storageCategory: "知识库",
      },
      {
        ...authorityContext,
        allowedTables: ["memories", "knowledge", "knowledge_work"],
        service,
        embed: async () => [0.1, 0.2],
        existsByContentHash: async () => [],
        embeddingModel: "test-model",
        idFactory: () => "knowledge-id",
        now: () => 1710000000000,
        routingEngine: {
          routeToKnowledgeBases: () => ({
            targetTables: ["knowledge_work"] as import("../../../db/types.js").TableName[],
            matchedRules: [{ name: "work-knowledge-rule" }],
          }),
        },
      },
    );

    expect(result.details).toMatchObject({
      action: "created",
      targetTables: ["knowledge_work"],
      routingEnabled: true,
    });
    expect(service.stores[0].record.tableName).toBe("knowledge_work");
  });

  test("100 组顶层 tenant/user 攻击均在 embed/store 前拒绝", async () => {
    const service = new FakeMemoryService();
    const existsByContentHash = vi.fn(async () => [] as string[]);
    const embed = vi.fn(async () => [0.1, 0.2]);

    for (let index = 0; index < 100; index += 1) {
      const identity = index % 2 === 0
        ? { tenantId: `attacker-tenant-${index}` }
        : { userId: `attacker-user-${index}` };
      await expect(handleMemoryStore(
        { text: `I prefer secure memory ${index}`, ...identity } as never,
        { service, ...authorityContext, existsByContentHash, embed },
      )).rejects.toMatchObject({ code: "CLIENT_FIELD_FORBIDDEN" });
    }

    expect(existsByContentHash).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    expect(service.stores).toEqual([]);
  });

  test("scan/forget/cleanup 身份攻击均在 path/query/transaction/delete 前拒绝", async () => {
    const service = new FakeMemoryService();
    const resolvePath = vi.fn((input: string) => input);

    await expect(handleMemoryScanDirectory(
      { directory: "/tmp/docs", tenantId: "attacker" } as never,
      {
        ...authorityContext,
        pipeline: {} as IngestionPipeline,
        resolvePath,
      },
    )).rejects.toMatchObject({ code: "CLIENT_FIELD_FORBIDDEN" });
    await expect(handleMemoryForget(
      { query: "secret", userId: "attacker" } as never,
      { service, forgetService: service, ...authorityContext },
    )).rejects.toMatchObject({ code: "CLIENT_FIELD_FORBIDDEN" });
    await expect(handleMemoryCleanup(
      { filter: { nested: { tenantId: "attacker" } } },
      { service, forgetService: service, ...authorityContext },
    )).rejects.toMatchObject({ code: "FILTER_INVALID" });

    expect(resolvePath).not.toHaveBeenCalled();
    expect(service.recalls).toEqual([]);
    expect(service.forgets).toEqual([]);
    expect(service.deletes).toEqual([]);
  });

  test.each([
    { appId: "evil-app" },
    { projectId: "evil-project" },
  ])("越权 app/project %j 在 embed/store 前拒绝", async (claim) => {
    const service = new FakeMemoryService();
    const embed = vi.fn(async () => [0.1]);

    await expect(handleMemoryStore(
      { text: "I prefer scoped memory", ...claim } as never,
      { service, ...authorityContext, existsByContentHash: async () => [], embed },
    )).rejects.toMatchObject({ code: "CLIENT_VALUE_NOT_ALLOWED" });
    expect(embed).not.toHaveBeenCalled();
    expect(service.stores).toEqual([]);
  });

  test("metadata 中 userId/projectId 是业务字段，不改变 server-owned scope", async () => {
    const service = new FakeMemoryService();
    await handleMemoryStore(
      {
        text: "I prefer business identifiers",
        metadata: { userId: "mentioned-user", projectId: "mentioned-project" },
      },
      {
        service,
        ...authorityContext,
        existsByContentHash: async () => [],
        embed: async () => [0.1],
        idFactory: () => "business-metadata",
      },
    );
    expect(service.stores[0].record.scope).toEqual(scope);
    expect(service.stores[0].record.metadata).toMatchObject({
      userId: "mentioned-user",
      projectId: "mentioned-project",
    });
  });
});
