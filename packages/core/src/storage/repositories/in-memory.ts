/**
 * In-memory repository implementation for middleware contracts.
 *
 * 该实现用于单元测试、嵌入式原型和后续持久化 provider 的 contract baseline；
 * 它强制 scope 过滤和 job lease 语义，但不承担进程外持久化。
 */

import { randomUUID } from "node:crypto";
import type { MemoryRepository, MemoryRepositoryQuery } from "../../core/service-types.js";
import type { ChunkRecord, DocumentRecord, MemoryRecord, MemoryScope } from "../../core/types.js";
import type {
  AppendAuditInput,
  AuditRecord,
  AuditRepository,
  ChunkRepository,
  DocumentRepository,
  EnqueueJobInput,
  JobRecord,
  JobRepository,
  JobStatus,
  LeaseJobInput,
  ScopeFilter,
} from "./types.js";

export interface InMemoryMemoryStoreOptions {
  now?: () => number;
  idFactory?: () => string;
}

function sameScope(left: MemoryScope, right: MemoryScope): boolean {
  return left.tenantId === right.tenantId &&
    left.appId === right.appId &&
    left.userId === right.userId &&
    left.projectId === right.projectId &&
    left.agentId === right.agentId &&
    left.namespace === right.namespace;
}

function matchesScope(record: { scope: MemoryScope }, filter?: ScopeFilter): boolean {
  return !filter?.scope || sameScope(record.scope, filter.scope);
}

function scoreByQuery(text: string, query?: string): number {
  if (!query) {
    return 1;
  }
  return text.toLowerCase().includes(query.toLowerCase()) ? 1 : 0;
}

export class InMemoryMemoryStore {
  readonly memories: MemoryRepository;
  readonly documents: DocumentRepository;
  readonly chunks: ChunkRepository;
  readonly jobs: JobRepository;
  readonly audit: AuditRepository;

  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly memoryRecords = new Map<string, MemoryRecord>();
  private readonly documentRecords = new Map<string, DocumentRecord>();
  private readonly chunkRecords = new Map<string, ChunkRecord>();
  private readonly jobRecords = new Map<string, JobRecord>();
  private readonly jobDedupe = new Map<string, string>();
  private readonly auditRecords: AuditRecord[] = [];

  constructor(options: InMemoryMemoryStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    this.memories = this.createMemoryRepository();
    this.documents = this.createDocumentRepository();
    this.chunks = this.createChunkRepository();
    this.jobs = this.createJobRepository();
    this.audit = this.createAuditRepository();
  }

  private createMemoryRepository(): MemoryRepository {
    return {
      store: async (records) => {
        for (const record of records) {
          this.memoryRecords.set(record.id, record);
        }
      },
      query: async (input: MemoryRepositoryQuery) => {
        return Array.from(this.memoryRecords.values())
          .filter((record) => sameScope(record.scope, input.scope))
          .map((record) => ({ ...record, score: scoreByQuery(record.text, input.query) }))
          .filter((record) => record.score >= (input.minScore ?? 0))
          .sort((a, b) => b.score - a.score)
          .slice(0, input.limit ?? Number.POSITIVE_INFINITY);
      },
      delete: async (ids) => {
        for (const id of ids) {
          this.memoryRecords.delete(id);
        }
      },
      deleteByFilter: async (filter) => {
        const ids = Array.from(this.memoryRecords.values())
          .filter((record) => Object.entries(filter).every(([key, value]) => (record as unknown as Record<string, unknown>)[key] === value))
          .map((record) => record.id);
        for (const id of ids) {
          this.memoryRecords.delete(id);
        }
        return ids.length;
      },
      count: async (filter = {}) => {
        return Array.from(this.memoryRecords.values())
          .filter((record) => {
            const scope = filter.scope as MemoryScope | undefined;
            return !scope || sameScope(record.scope, scope);
          })
          .length;
      },
    };
  }

  private createDocumentRepository(): DocumentRepository {
    return {
      upsert: async (document) => {
        this.documentRecords.set(document.id, document);
      },
      get: async (id) => this.documentRecords.get(id),
      list: async (filter) => Array.from(this.documentRecords.values()).filter((record) => matchesScope(record, filter)),
    };
  }

  private createChunkRepository(): ChunkRepository {
    return {
      upsertMany: async (chunks) => {
        for (const chunk of chunks) {
          this.chunkRecords.set(chunk.id, chunk);
        }
      },
      get: async (id) => this.chunkRecords.get(id),
      listByDocument: async (documentId, filter) =>
        Array.from(this.chunkRecords.values())
          .filter((chunk) => chunk.documentId === documentId && matchesScope(chunk, filter))
          .sort((a, b) => a.ordinal - b.ordinal),
      list: async (filter) => Array.from(this.chunkRecords.values()).filter((record) => matchesScope(record, filter)),
    };
  }

  private createJobRepository(): JobRepository {
    return {
      enqueue: async (input: EnqueueJobInput) => {
        const existingId = this.jobDedupe.get(input.dedupeKey);
        if (existingId) {
          return this.jobRecords.get(existingId)!;
        }
        const now = this.now();
        const job: JobRecord = {
          id: this.idFactory(),
          type: input.type,
          payload: input.payload,
          dedupeKey: input.dedupeKey,
          status: "queued",
          attempts: 0,
          createdAt: now,
          updatedAt: now,
        };
        this.jobRecords.set(job.id, job);
        this.jobDedupe.set(job.dedupeKey, job.id);
        return job;
      },
      lease: async (input: LeaseJobInput) => {
        const now = this.now();
        const job = Array.from(this.jobRecords.values()).find((candidate) =>
          candidate.status === "queued" ||
          candidate.status === "failed" ||
          (candidate.status === "running" && typeof candidate.leaseUntil === "number" && candidate.leaseUntil <= now)
        );
        if (!job) {
          return undefined;
        }
        job.status = "running";
        job.workerId = input.workerId;
        job.leaseUntil = now + input.leaseMs;
        job.attempts += 1;
        job.updatedAt = now;
        return { ...job };
      },
      complete: async (id) => {
        const job = this.jobRecords.get(id);
        if (!job) return;
        job.status = "completed";
        job.leaseUntil = undefined;
        job.updatedAt = this.now();
      },
      fail: async (id, error) => {
        const job = this.jobRecords.get(id);
        if (!job) return;
        job.status = "failed";
        job.error = error;
        job.leaseUntil = undefined;
        job.updatedAt = this.now();
      },
      list: async (status?: JobStatus) =>
        Array.from(this.jobRecords.values()).filter((job) => !status || job.status === status),
    };
  }

  private createAuditRepository(): AuditRepository {
    return {
      append: async (input: AppendAuditInput) => {
        const record: AuditRecord = {
          id: this.idFactory(),
          scope: input.scope,
          action: input.action,
          targetId: input.targetId,
          metadata: input.metadata ?? {},
          createdAt: this.now(),
        };
        this.auditRecords.push(record);
        return record;
      },
      list: async (filter) => this.auditRecords.filter((record) => matchesScope(record, filter)),
    };
  }
}
