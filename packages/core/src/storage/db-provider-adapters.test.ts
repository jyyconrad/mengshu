/**
 * 持久化后端 adapter 测试（F5 阶段 1）。
 *
 * 测试场景：
 * - ChunkRecord → MemoryEntry 映射正确性
 * - 向量生成（1536 维 text-embedding-3-small）
 * - scope 隔离（不同 scope 不互相覆盖、不跨域误去重）
 * - chunks.list 反向映射 + scope 过滤
 * - 与 IngestionPipeline 的 scope-aware 去重集成
 *
 * 去重职责：adapter 层不再做去重，去重交给 pipeline 层
 * （pipeline 用 scope-aware 的 chunks.list + seenHashes 双层去重）。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createPersistentRepositories } from "./db-provider-adapters.js";
import { IngestionPipeline } from "../ingest/pipeline.js";
import type { DatabaseProvider, MemoryEntry } from "../db/types.js";
import type { MemoryScope } from "../domain/types.js";
import type { Embeddings } from "../runtime/llm/embeddings.js";

/**
 * 创建支持 metadata 字段过滤的 in-memory DatabaseProvider。
 *
 * 行为模拟 Postgres JSONB 过滤（`metadata->>'key' = value`），
 * 即 filter 中的每个键都按 metadata 上的对应字段精确匹配。
 * 这正确反映了 scope 隔离应有的语义。
 */
function createInMemoryDb(): DatabaseProvider {
  const rows: MemoryEntry[] = [];
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    store: vi.fn(async (entries: MemoryEntry[]) => {
      rows.push(...entries.map((e) => ({ ...e, metadata: { ...e.metadata } })));
    }),
    query: vi.fn(async (options: any) => {
      let result = rows.slice();
      if (options.tableName) {
        result = result.filter((r) => r.tableName === options.tableName);
      }
      if (options.dataTypes && options.dataTypes.length > 0) {
        result = result.filter((r) => options.dataTypes.includes(r.dataType));
      }
      if (options.filter) {
        for (const [key, value] of Object.entries(options.filter)) {
          result = result.filter((r) => (r.metadata as any)[key] === value);
        }
      }
      const limited =
        typeof options.limit === "number" ? result.slice(0, options.limit) : result;
      return limited.map((r) => ({ ...r, score: 1 }));
    }),
    delete: vi.fn().mockResolvedValue(undefined),
    deleteByFilter: vi.fn().mockResolvedValue(0),
    existsByContentHash: vi.fn(async (hashes: string[]) => {
      const set = new Set(rows.map((r) => r.contentHash));
      return hashes.filter((h) => set.has(h));
    }),
    count: vi.fn(async () => rows.length),
  };
}

function makeEmbeddings(): Embeddings {
  return {
    embed: vi.fn(async () => new Array(1536).fill(0.1)),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(() => new Array(1536).fill(0.1))),
    modelName: "text-embedding-3-small",
  } as any;
}

describe("db-provider-adapters", () => {
  let mockDb: DatabaseProvider;
  let mockEmbeddings: Embeddings;
  let scope: MemoryScope;
  let storedEntries: Array<any>;

  beforeEach(() => {
    scope = {
      tenantId: "tenant-1",
      appId: "app-1",
      userId: "user-1",
      projectId: "proj-1",
      agentId: "agent-1",
      namespace: "default",
    };

    // mock DatabaseProvider
    storedEntries = [];
    mockDb = {
      initialize: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      store: vi.fn((entries) => {
        storedEntries.push(...entries);
        return Promise.resolve();
      }),
      query: vi.fn((options) => {
        return Promise.resolve(
          storedEntries
            .filter((e: any) => !options.filter?.contentHash || e.contentHash === options.filter.contentHash)
            .map((e: any) => ({ ...e, score: 1.0 }))
        );
      }),
      delete: vi.fn().mockResolvedValue(undefined),
      deleteByFilter: vi.fn().mockResolvedValue(0),
      existsByContentHash: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    };

    // mock Embeddings
    mockEmbeddings = {
      embed: vi.fn((text: string) => {
        // 生成固定长度 1536 维向量（模拟 text-embedding-3-small）
        return Promise.resolve(new Array(1536).fill(0.1));
      }),
      embedBatch: vi.fn((texts: string[]) => {
        return Promise.resolve(texts.map(() => new Array(1536).fill(0.1)));
      }),
      modelName: "text-embedding-3-small",
    } as any;
  });

  it("应正确映射 ChunkRecord.text → MemoryEntry.text", async () => {
    const repos = createPersistentRepositories({ db: mockDb, embeddings: mockEmbeddings, scope });

    await repos.chunks.upsertMany([
      {
        id: "chunk-1",
        scope,
        documentId: "doc-1",
        text: "hello world",
        contentHash: "hash-1",
        ordinal: 0,
        metadata: {},
        provenance: { source: "scan", sourceId: "file-1" },
        createdAt: Date.now(),
      },
    ]);

    expect(mockDb.store).toHaveBeenCalledTimes(1);
    const [callEntries] = (mockDb.store as any).mock.calls[0];
    expect(callEntries).toHaveLength(1);
    expect(callEntries[0].text).toBe("hello world");
    expect(callEntries[0].contentHash).toBe("hash-1");
    expect(callEntries[0].dataType).toBe("knowledge");
    expect(callEntries[0].tableName).toBe("knowledge");
    expect(callEntries[0].category).toBe("fact");
    expect(callEntries[0].metadata.documentId).toBe("doc-1");
    expect(callEntries[0].metadata.ordinal).toBe(0);
  });

  it("应同步生成 1536 维向量", async () => {
    const repos = createPersistentRepositories({ db: mockDb, embeddings: mockEmbeddings, scope });

    await repos.chunks.upsertMany([
      {
        id: "chunk-1",
        scope,
        text: "test vector generation",
        contentHash: "hash-vec",
        ordinal: 0,
        metadata: {},
        provenance: { source: "scan" },
        createdAt: Date.now(),
      },
    ]);

    const [callEntries] = (mockDb.store as any).mock.calls[0];
    expect(callEntries[0].vector).toHaveLength(1536);
    expect(callEntries[0].vector[0]).toBe(0.1);
    expect(mockEmbeddings.embed).toHaveBeenCalledWith("test vector generation");
  });

  it("upsertMany 不再做去重：相同 contentHash 也会再次写入（去重交给 pipeline 层）", async () => {
    const repos = createPersistentRepositories({ db: mockDb, embeddings: mockEmbeddings, scope });

    await repos.chunks.upsertMany([
      {
        id: "chunk-1",
        scope,
        text: "duplicate content",
        contentHash: "same-hash",
        ordinal: 0,
        metadata: {},
        provenance: { source: "scan" },
        createdAt: Date.now(),
      },
    ]);

    // 即使 db 报告该 contentHash 已存在，adapter 也不再据此跳过
    (mockDb.existsByContentHash as any).mockResolvedValue(["same-hash"]);

    await repos.chunks.upsertMany([
      {
        id: "chunk-2",
        scope,
        text: "duplicate content",
        contentHash: "same-hash",
        ordinal: 1,
        metadata: {},
        provenance: { source: "scan" },
        createdAt: Date.now(),
      },
    ]);

    // 两次都写入（adapter 层无去重），且不应调用全局 existsByContentHash
    expect(mockDb.store).toHaveBeenCalledTimes(2);
    expect(mockDb.existsByContentHash).not.toHaveBeenCalled();
  });

  it("应隔离不同 scope 的 chunk（不互相覆盖）", async () => {
    const scope1 = { ...scope, projectId: "proj-1" };
    const scope2 = { ...scope, projectId: "proj-2" };

    const repos1 = createPersistentRepositories({ db: mockDb, embeddings: mockEmbeddings, scope: scope1 });
    const repos2 = createPersistentRepositories({ db: mockDb, embeddings: mockEmbeddings, scope: scope2 });

    await repos1.chunks.upsertMany([
      {
        id: "chunk-1",
        scope: scope1,
        text: "content A",
        contentHash: "hash-A",
        ordinal: 0,
        metadata: {},
        provenance: { source: "scan" },
        createdAt: Date.now(),
      },
    ]);

    await repos2.chunks.upsertMany([
      {
        id: "chunk-2",
        scope: scope2,
        text: "content B",
        contentHash: "hash-B",
        ordinal: 0,
        metadata: {},
        provenance: { source: "scan" },
        createdAt: Date.now(),
      },
    ]);

    expect(mockDb.store).toHaveBeenCalledTimes(2);
    const [call1] = (mockDb.store as any).mock.calls[0];
    const [call2] = (mockDb.store as any).mock.calls[1];
    // scope 序列化进 metadata，验证隔离
    expect(call1[0].metadata.projectId).toBe("proj-1");
    expect(call2[0].metadata.projectId).toBe("proj-2");
  });

  it("应保留 chunk.provenance.sourceId（用于追溯）", async () => {
    const repos = createPersistentRepositories({ db: mockDb, embeddings: mockEmbeddings, scope });

    await repos.chunks.upsertMany([
      {
        id: "chunk-1",
        scope,
        text: "test",
        contentHash: "hash-1",
        ordinal: 0,
        metadata: {},
        provenance: { source: "scan", sourceId: "file-xyz" },
        createdAt: Date.now(),
      },
    ]);

    const [callEntries] = (mockDb.store as any).mock.calls[0];
    expect(callEntries[0].metadata.provenance).toEqual({ source: "scan", sourceId: "file-xyz" });
  });

  it("空数组不应触发 store/embed 调用", async () => {
    const repos = createPersistentRepositories({ db: mockDb, embeddings: mockEmbeddings, scope });

    await repos.chunks.upsertMany([]);

    expect(mockDb.store).not.toHaveBeenCalled();
    expect(mockEmbeddings.embed).not.toHaveBeenCalled();
  });

  it("chunk 缺失 id 时应生成 UUID", async () => {
    const repos = createPersistentRepositories({ db: mockDb, embeddings: mockEmbeddings, scope });

    await repos.chunks.upsertMany([
      {
        id: "",
        scope,
        text: "no id chunk",
        contentHash: "hash-noid",
        ordinal: 0,
        metadata: {},
        provenance: { source: "scan" },
        createdAt: Date.now(),
      },
    ]);

    const [callEntries] = (mockDb.store as any).mock.calls[0];
    expect(callEntries[0].id).toBeTruthy();
    expect(callEntries[0].id.length).toBeGreaterThan(0);
  });

  it("documents.upsert 应映射为 dataType=document 并生成向量", async () => {
    const repos = createPersistentRepositories({ db: mockDb, embeddings: mockEmbeddings, scope });

    await repos.documents.upsert({
      id: "doc-1",
      scope,
      title: "My Document",
      uri: "file:///path/doc.md",
      contentHash: "doc-hash",
      metadata: { language: "zh" },
      createdAt: Date.now(),
    });

    expect(mockDb.store).toHaveBeenCalledTimes(1);
    const [callEntries] = (mockDb.store as any).mock.calls[0];
    expect(callEntries[0].dataType).toBe("document");
    expect(callEntries[0].tableName).toBe("documents");
    expect(callEntries[0].text).toBe("My Document");
    expect(callEntries[0].contentHash).toBe("doc-hash");
    expect(callEntries[0].vector).toHaveLength(1536);
    expect(callEntries[0].metadata.uri).toBe("file:///path/doc.md");
    expect(callEntries[0].metadata.language).toBe("zh");
  });

  it("jobs 队列应支持 enqueue 去重与 lease/complete 生命周期", async () => {
    const repos = createPersistentRepositories({ db: mockDb, embeddings: mockEmbeddings, scope });

    const job1 = await repos.jobs.enqueue({ type: "embed", payload: { a: 1 }, dedupeKey: "key-1" });
    const job2 = await repos.jobs.enqueue({ type: "embed", payload: { a: 2 }, dedupeKey: "key-1" });
    // 相同 dedupeKey 返回同一 job
    expect(job2.id).toBe(job1.id);

    const queued = await repos.jobs.list("queued");
    expect(queued).toHaveLength(1);

    const leased = await repos.jobs.lease({ workerId: "w-1", leaseMs: 1000 });
    expect(leased?.id).toBe(job1.id);
    expect(leased?.status).toBe("running");

    await repos.jobs.complete(job1.id);
    const completed = await repos.jobs.list("completed");
    expect(completed).toHaveLength(1);
  });

  it("jobs.fail 应标记 failed 并记录 error", async () => {
    const repos = createPersistentRepositories({ db: mockDb, embeddings: mockEmbeddings, scope });

    const job = await repos.jobs.enqueue({ type: "embed", payload: {}, dedupeKey: "key-fail" });
    await repos.jobs.fail(job.id, "boom");

    const failed = await repos.jobs.list("failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toBe("boom");
  });

  it("audit.append 应返回带 id 的记录", async () => {
    const repos = createPersistentRepositories({ db: mockDb, embeddings: mockEmbeddings, scope });

    const record = await repos.audit.append({
      scope,
      action: "promote",
      targetId: "mem-1",
      metadata: { reason: "test" },
    });

    expect(record.id).toBeTruthy();
    expect(record.action).toBe("promote");
    expect(record.targetId).toBe("mem-1");
    expect(record.metadata).toEqual({ reason: "test" });
  });

  // ==========================================================================
  // chunks.list scope 隔离 + 反向映射（缺陷修复核心）
  // ==========================================================================

  describe("chunks.list（scope 过滤 + 反向映射）", () => {
    const scopeA: MemoryScope = {
      tenantId: "t", appId: "a", userId: "u", projectId: "projA", agentId: "ag", namespace: "ns",
    };
    const scopeB: MemoryScope = {
      tenantId: "t", appId: "a", userId: "u", projectId: "projB", agentId: "ag", namespace: "ns",
    };

    it("写入 scopeA 后，list({scope:scopeA}) 能查到，list({scope:scopeB}) 查不到", async () => {
      const db = createInMemoryDb();
      const repos = createPersistentRepositories({ db, embeddings: makeEmbeddings(), scope: scopeA });

      await repos.chunks.upsertMany([
        {
          id: "chunk-a",
          scope: scopeA,
          documentId: "doc-a",
          text: "scoped content",
          contentHash: "hash-a",
          ordinal: 0,
          metadata: {},
          provenance: { source: "scan", sourceId: "file-a" },
          createdAt: Date.now(),
        },
      ]);

      const inA = await repos.chunks.list({ scope: scopeA });
      const inB = await repos.chunks.list({ scope: scopeB });

      expect(inA).toHaveLength(1);
      expect(inA[0].contentHash).toBe("hash-a");
      expect(inB).toHaveLength(0);
    });

    it("相同 contentHash 不同 scope 分别写入：两个 scope 各自都能 list 到（不跨域误去重）", async () => {
      const db = createInMemoryDb();
      const reposA = createPersistentRepositories({ db, embeddings: makeEmbeddings(), scope: scopeA });
      const reposB = createPersistentRepositories({ db, embeddings: makeEmbeddings(), scope: scopeB });

      const sharedHash = "shared-hash";
      await reposA.chunks.upsertMany([
        {
          id: "chunk-a", scope: scopeA, documentId: "doc-a", text: "same text",
          contentHash: sharedHash, ordinal: 0, metadata: {},
          provenance: { source: "scan" }, createdAt: Date.now(),
        },
      ]);
      await reposB.chunks.upsertMany([
        {
          id: "chunk-b", scope: scopeB, documentId: "doc-b", text: "same text",
          contentHash: sharedHash, ordinal: 0, metadata: {},
          provenance: { source: "scan" }, createdAt: Date.now(),
        },
      ]);

      const inA = await reposA.chunks.list({ scope: scopeA });
      const inB = await reposB.chunks.list({ scope: scopeB });

      expect(inA).toHaveLength(1);
      expect(inB).toHaveLength(1);
      expect(inA[0].scope.projectId).toBe("projA");
      expect(inB[0].scope.projectId).toBe("projB");
    });

    it("list 反向映射正确（documentId/ordinal/provenance/scope/tokenCount 还原）", async () => {
      const db = createInMemoryDb();
      const repos = createPersistentRepositories({ db, embeddings: makeEmbeddings(), scope: scopeA });

      await repos.chunks.upsertMany([
        {
          id: "chunk-x",
          scope: scopeA,
          documentId: "doc-x",
          text: "mapping content",
          contentHash: "hash-x",
          ordinal: 7,
          tokenCount: 42,
          metadata: { custom: "value" },
          provenance: { source: "scan", sourceId: "file-x" },
          createdAt: 1700000000000,
        },
      ]);

      const [chunk] = await repos.chunks.list({ scope: scopeA });
      expect(chunk.id).toBe("chunk-x");
      expect(chunk.documentId).toBe("doc-x");
      expect(chunk.text).toBe("mapping content");
      expect(chunk.contentHash).toBe("hash-x");
      expect(chunk.ordinal).toBe(7);
      expect(chunk.tokenCount).toBe(42);
      expect(chunk.provenance).toEqual({ source: "scan", sourceId: "file-x" });
      expect(chunk.scope).toEqual(scopeA);
      // 自定义 metadata 应保留，且不含 scope/保留字段
      expect(chunk.metadata.custom).toBe("value");
      expect(chunk.metadata.projectId).toBeUndefined();
      expect(chunk.metadata.documentId).toBeUndefined();
      expect(chunk.metadata.provenance).toBeUndefined();
    });

    it("无 filter 时返回全部 knowledge chunk", async () => {
      const db = createInMemoryDb();
      const reposA = createPersistentRepositories({ db, embeddings: makeEmbeddings(), scope: scopeA });
      const reposB = createPersistentRepositories({ db, embeddings: makeEmbeddings(), scope: scopeB });

      await reposA.chunks.upsertMany([
        { id: "c1", scope: scopeA, text: "a", contentHash: "h1", ordinal: 0, metadata: {}, provenance: {}, createdAt: 1 },
      ]);
      await reposB.chunks.upsertMany([
        { id: "c2", scope: scopeB, text: "b", contentHash: "h2", ordinal: 0, metadata: {}, provenance: {}, createdAt: 2 },
      ]);

      const all = await reposA.chunks.list();
      expect(all).toHaveLength(2);
    });
  });

  // ==========================================================================
  // 集成：IngestionPipeline + persistentRepos scope-aware 去重
  // ==========================================================================

  describe("集成：pipeline scope-aware 去重", () => {
    const scopeA: MemoryScope = {
      tenantId: "t", appId: "a", userId: "u", projectId: "projA", agentId: "ag", namespace: "ns",
    };
    const scopeB: MemoryScope = {
      tenantId: "t", appId: "a", userId: "u", projectId: "projB", agentId: "ag", namespace: "ns",
    };
    const content = "# Title\n\nalpha beta gamma delta";

    it("同 scope 摄入两次相同内容 → 第二次 chunksDropped > 0（pipeline scope 去重生效）", async () => {
      const db = createInMemoryDb();
      const repos = createPersistentRepositories({ db, embeddings: makeEmbeddings(), scope: scopeA });
      const pipeline = new IngestionPipeline({
        documents: repos.documents,
        chunks: repos.chunks,
        jobs: repos.jobs,
        audit: repos.audit,
      });

      const first = await pipeline.ingest({
        scope: scopeA, sourceId: "/docs/g.md", content, chunkSize: 12,
      });
      const second = await pipeline.ingest({
        scope: scopeA, sourceId: "/docs/g.md", content, chunkSize: 12,
      });

      expect(first.chunksAdmitted).toBeGreaterThan(0);
      expect(first.chunksDropped).toBe(0);
      expect(second.chunksAdmitted).toBe(0);
      expect(second.chunksDropped).toBe(first.chunksAdmitted);
    });

    it("不同 scope 摄入相同内容 → 都 admitted（无跨域误去重）", async () => {
      const db = createInMemoryDb();
      const reposA = createPersistentRepositories({ db, embeddings: makeEmbeddings(), scope: scopeA });
      const reposB = createPersistentRepositories({ db, embeddings: makeEmbeddings(), scope: scopeB });

      const pipelineA = new IngestionPipeline({
        documents: reposA.documents, chunks: reposA.chunks, jobs: reposA.jobs, audit: reposA.audit,
      });
      const pipelineB = new IngestionPipeline({
        documents: reposB.documents, chunks: reposB.chunks, jobs: reposB.jobs, audit: reposB.audit,
      });

      const a = await pipelineA.ingest({ scope: scopeA, sourceId: "/docs/g.md", content, chunkSize: 12 });
      const b = await pipelineB.ingest({ scope: scopeB, sourceId: "/docs/g.md", content, chunkSize: 12 });

      expect(a.chunksAdmitted).toBeGreaterThan(0);
      expect(b.chunksAdmitted).toBe(a.chunksAdmitted);
      expect(b.chunksDropped).toBe(0);
    });
  });
});
