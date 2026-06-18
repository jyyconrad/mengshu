/**
 * Ingestion pipeline 输入输出类型。
 *
 * ingestion 热路径只做 canonicalize、chunk、hash、persist、enqueue，不调用 LLM
 * 或 embedding 服务。
 */

import type { MemoryScope } from "../domain/types.js";

export interface CanonicalizeInput {
  sourceId: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface CanonicalizedDocument {
  sourceId: string;
  markdown: string;
  metadata: Record<string, unknown>;
}

export interface ChunkMarkdownOptions {
  scopeKey: string;
  scope?: MemoryScope;
  documentId: string;
  chunkSize?: number;
  createdAt: number;
}

export interface IngestInput extends CanonicalizeInput {
  scope: MemoryScope;
  chunkSize?: number;
}

export interface IngestResult {
  documentId: string;
  chunksAdmitted: number;
  chunksDropped: number;
  jobsQueued: number;
}
