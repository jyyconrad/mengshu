/**
 * 新存储层 repository contracts。
 *
 * 这些接口服务于 ingestion、retrieval、graph/tree 和治理流程；当前先提供
 * in-memory 实现作为 contract test 基线，后续再映射到 Postgres/Supabase/LanceDB。
 */

import type { MemoryRepository } from "../../domain/service-types.js";
import type { ChunkRecord, DocumentRecord, MemoryScope } from "../../domain/types.js";

export type { MemoryRepository } from "../../domain/service-types.js";

export interface ScopeFilter {
  scope?: MemoryScope;
}

export interface DocumentRepository {
  upsert(document: DocumentRecord): Promise<void>;
  get(id: string): Promise<DocumentRecord | undefined>;
  list(filter?: ScopeFilter): Promise<DocumentRecord[]>;
}

export interface ChunkRepository {
  upsertMany(chunks: ChunkRecord[]): Promise<void>;
  get(id: string): Promise<ChunkRecord | undefined>;
  listByDocument(documentId: string, filter?: ScopeFilter): Promise<ChunkRecord[]>;
  list(filter?: ScopeFilter): Promise<ChunkRecord[]>;
}

export type JobStatus = "queued" | "running" | "completed" | "failed";

export interface JobRecord {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
  status: JobStatus;
  attempts: number;
  workerId?: string;
  leaseUntil?: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface EnqueueJobInput {
  type: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
}

export interface LeaseJobInput {
  workerId: string;
  leaseMs: number;
}

export interface JobRepository {
  enqueue(input: EnqueueJobInput): Promise<JobRecord>;
  lease(input: LeaseJobInput): Promise<JobRecord | undefined>;
  complete(id: string): Promise<void>;
  fail(id: string, error: string): Promise<void>;
  list(status?: JobStatus): Promise<JobRecord[]>;
}

export interface AuditRecord {
  id: string;
  scope: MemoryScope;
  action: string;
  targetId?: string;
  metadata: Record<string, unknown>;
  createdAt: number;
}

export interface AppendAuditInput {
  scope: MemoryScope;
  action: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditRepository {
  append(input: AppendAuditInput): Promise<AuditRecord>;
  list(filter?: ScopeFilter): Promise<AuditRecord[]>;
}
