/**
 * 持久化后端 adapter（F5 阶段 1）。
 *
 * 包装 DatabaseProvider 为 DocumentRepository / ChunkRepository 契约，
 * 将 ChunkRecord → MemoryEntry 并同步生成 vector，去重基于 contentHash。
 *
 * 映射规则：
 * - ChunkRecord.text → MemoryEntry.text
 * - ChunkRecord.contentHash → MemoryEntry.contentHash
 * - ChunkRecord.documentId → MemoryEntry.metadata.documentId
 * - ChunkRecord.ordinal → MemoryEntry.metadata.ordinal
 * - ChunkRecord.provenance → MemoryEntry.metadata.provenance
 * - 同步生成 vector（调用 embeddings.embed）
 * - 固定字段：dataType="knowledge", tableName="knowledge", category="fact", kind="knowledge", importance=0.5
 *
 * 去重职责：adapter 层不做去重。去重交给上游 IngestionPipeline，
 * 它用 scope-aware 的 chunks.list + seenHashes 双层去重（见 ingest/pipeline.ts）。
 * adapter 层若做 db.existsByContentHash 全局去重会导致跨 scope 误去重（数据隔离缺陷）。
 */

import { randomUUID } from "node:crypto";
import type { DatabaseProvider, MemoryEntry } from "../db/types.js";
import type { Embeddings } from "../runtime/llm/embeddings.js";
import type { ChunkRecord, DocumentRecord, MemoryScope, RecordProvenance } from "../domain/types.js";
import type {
  AuditRepository,
  ChunkRepository,
  DocumentRepository,
  EnqueueJobInput,
  JobRecord,
  JobRepository,
  JobStatus,
  LeaseJobInput,
  ScopeFilter,
} from "./repositories/types.js";

export interface CreatePersistentRepositoriesInput {
  db: DatabaseProvider;
  embeddings: Embeddings;
  scope: MemoryScope;
}

export interface PersistentRepositories {
  documents: DocumentRepository;
  chunks: ChunkRepository;
  /** Jobs 为瞬态队列，使用 in-memory 实现（不需要跨进程持久化）。 */
  jobs: JobRepository;
  audit: AuditRepository;
}

/**
 * upsertMany 写入 metadata 时使用的 scope 字段名，
 * 反向映射（MemoryEntry → ChunkRecord）时需排除这些保留键，避免污染 chunk.metadata。
 */
const SCOPE_METADATA_KEYS = [
  "tenantId",
  "appId",
  "userId",
  "projectId",
  "agentId",
  "namespace",
] as const;

/** upsertMany 写入 metadata 的其余保留键（非 scope）。 */
const RESERVED_METADATA_KEYS = ["documentId", "ordinal", "provenance", "tokenCount"] as const;

/**
 * 将 ScopeFilter.scope 映射为 db.query 的 metadata filter。
 *
 * 与 upsertMany 写入 metadata 时的字段命名保持一致（tenantId/appId/...）。
 * 注意：LanceDB 将 metadata 序列化为 JSON 字符串存储，对 `metadata.key` 的等值
 * 过滤可能失效（开放问题 7）；Postgres（JSONB）与 in-memory 实现按字段精确过滤。
 */
function scopeToQueryFilter(scope?: MemoryScope): Record<string, unknown> {
  if (!scope) {
    return {};
  }
  return {
    tenantId: scope.tenantId,
    appId: scope.appId,
    userId: scope.userId,
    projectId: scope.projectId,
    agentId: scope.agentId,
    namespace: scope.namespace,
  };
}

/**
 * 反向映射 MemoryEntry → ChunkRecord。
 *
 * - metadata.documentId → documentId
 * - metadata.ordinal → ordinal
 * - metadata.provenance → provenance
 * - metadata.tokenCount → tokenCount
 * - metadata 上的 scope 字段 → 重建 scope 对象
 * - 其余自定义 metadata 原样保留（剔除保留键与 scope 键）
 */
function entryToChunkRecord(entry: MemoryEntry): ChunkRecord {
  const md = entry.metadata as Record<string, unknown>;
  const scope: MemoryScope = {
    tenantId: String(md.tenantId ?? ""),
    appId: String(md.appId ?? ""),
    userId: String(md.userId ?? ""),
    projectId: String(md.projectId ?? ""),
    agentId: String(md.agentId ?? ""),
    namespace: String(md.namespace ?? ""),
  };

  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(md)) {
    if (
      (SCOPE_METADATA_KEYS as readonly string[]).includes(key) ||
      (RESERVED_METADATA_KEYS as readonly string[]).includes(key)
    ) {
      continue;
    }
    rest[key] = value;
  }

  return {
    id: entry.id,
    scope,
    documentId: typeof md.documentId === "string" ? md.documentId : undefined,
    text: entry.text,
    contentHash: entry.contentHash,
    ordinal: typeof md.ordinal === "number" ? md.ordinal : 0,
    tokenCount: typeof md.tokenCount === "number" ? md.tokenCount : undefined,
    metadata: rest,
    provenance: (md.provenance as RecordProvenance | undefined) ?? {},
    createdAt: entry.createdAt,
    vector: entry.vector,
  };
}

/**
 * 查询 knowledge 表中（可选按 scope 过滤的）全部 chunk 并反向映射为 ChunkRecord。
 *
 * 去重查询需拿到该 scope 下全部 chunk 的 contentHash，因此使用大 limit 一次拉取。
 * TODO（性能优化）：db.query 暂不支持仅返回部分字段（如只取 contentHash），
 * 大 scope 下可能拉回较多数据；后续可加分页或投影字段支持。
 */
const CHUNK_LIST_LIMIT = 100_000;

async function queryKnowledgeChunks(
  db: DatabaseProvider,
  scope?: MemoryScope
): Promise<ChunkRecord[]> {
  const results = await db.query({
    tableName: "knowledge",
    dataTypes: ["knowledge"],
    filter: scopeToQueryFilter(scope),
    limit: CHUNK_LIST_LIMIT,
  });
  return results.map((entry) => entryToChunkRecord(entry));
}

/**
 * 创建持久化 repositories（F5 阶段 1）。
 */
export function createPersistentRepositories(
  deps: CreatePersistentRepositoriesInput
): PersistentRepositories {
  const { db, embeddings, scope: defaultScope } = deps;

  const documents: DocumentRepository = {
    upsert: async (document: DocumentRecord) => {
      // DocumentRecord → MemoryEntry (dataType: "document")
      const entry = {
        id: document.id,
        text: document.title ?? "",
        contentHash: document.contentHash,
        vector: await embeddings.embed(document.title ?? ""),
        importance: 0.5,
        category: "fact" as const,
        dataType: "document" as const,
        tableName: "documents" as const,
        metadata: {
          ...document.metadata,
          uri: document.uri,
        },
        createdAt: document.createdAt,
      };
      await db.store([entry]);
    },
    get: async (id: string) => {
      // 暂不实现（F5 阶段 1 不需要）
      return undefined;
    },
    list: async (filter?: ScopeFilter) => {
      // 暂不实现
      return [];
    },
  };

  const chunks: ChunkRepository = {
    upsertMany: async (chunks: ChunkRecord[]) => {
      if (chunks.length === 0) {
        return;
      }

      // 去重交给 pipeline 层（scope-aware）。adapter 只负责映射 + 写入。
      // 映射 ChunkRecord → MemoryEntry，同步生成 vector
      const entries = await Promise.all(
        chunks.map(async (chunk) => {
          const vector = await embeddings.embed(chunk.text);
          return {
            id: chunk.id || randomUUID(),
            text: chunk.text,
            contentHash: chunk.contentHash,
            vector,
            importance: 0.5,
            category: "fact" as const,
            dataType: "knowledge" as const,
            tableName: "knowledge" as const,
            metadata: {
              documentId: chunk.documentId,
              ordinal: chunk.ordinal,
              provenance: chunk.provenance,
              tokenCount: chunk.tokenCount,
              // scope 字段序列化进 metadata，用于查询时过滤隔离
              tenantId: chunk.scope.tenantId,
              appId: chunk.scope.appId,
              userId: chunk.scope.userId,
              projectId: chunk.scope.projectId,
              agentId: chunk.scope.agentId,
              namespace: chunk.scope.namespace,
              ...chunk.metadata,
            },
            createdAt: chunk.createdAt,
          };
        })
      );

      await db.store(entries);
    },
    get: async (id: string) => {
      // 暂不实现（F5 阶段 1 不需要）
      return undefined;
    },
    listByDocument: async (documentId: string, filter?: ScopeFilter) => {
      const all = await queryKnowledgeChunks(db, filter?.scope);
      return all
        .filter((chunk) => chunk.documentId === documentId)
        .sort((a, b) => a.ordinal - b.ordinal);
    },
    list: async (filter?: ScopeFilter) => {
      return queryKnowledgeChunks(db, filter?.scope);
    },
  };

  // Jobs 为瞬态工作队列，in-memory 实现，不需要持久化
  const jobRecords = new Map<string, JobRecord>();
  const jobDedupe = new Map<string, string>();

  const jobs: JobRepository = {
    enqueue: async (input: EnqueueJobInput) => {
      const existingId = jobDedupe.get(input.dedupeKey);
      if (existingId) {
        return jobRecords.get(existingId)!;
      }
      const now = Date.now();
      const job: JobRecord = {
        id: randomUUID(),
        type: input.type,
        payload: input.payload,
        dedupeKey: input.dedupeKey,
        status: "queued",
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      };
      jobRecords.set(job.id, job);
      jobDedupe.set(job.dedupeKey, job.id);
      return job;
    },
    lease: async (input: LeaseJobInput) => {
      const now = Date.now();
      const job = Array.from(jobRecords.values()).find(
        (c) =>
          c.status === "queued" ||
          c.status === "failed" ||
          (c.status === "running" && typeof c.leaseUntil === "number" && c.leaseUntil <= now)
      );
      if (!job) return undefined;
      job.status = "running";
      job.workerId = input.workerId;
      job.leaseUntil = now + input.leaseMs;
      job.attempts += 1;
      job.updatedAt = now;
      return { ...job };
    },
    complete: async (id: string) => {
      const job = jobRecords.get(id);
      if (!job) return;
      job.status = "completed";
      job.leaseUntil = undefined;
      job.updatedAt = Date.now();
    },
    fail: async (id: string, error: string) => {
      const job = jobRecords.get(id);
      if (!job) return;
      job.status = "failed";
      job.error = error;
      job.leaseUntil = undefined;
      job.updatedAt = Date.now();
    },
    list: async (status?: JobStatus) =>
      Array.from(jobRecords.values()).filter((j) => !status || j.status === status),
  };

  const audit: AuditRepository = {
    append: async (input) => {
      // 暂不实现（F5 阶段 1 不需要）
      return {
        id: randomUUID(),
        scope: input.scope,
        action: input.action,
        targetId: input.targetId,
        metadata: input.metadata ?? {},
        createdAt: Date.now(),
      };
    },
    list: async (filter?: ScopeFilter) => {
      return [];
    },
  };

  return { documents, chunks, jobs, audit };
}
