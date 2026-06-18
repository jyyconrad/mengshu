/**
 * Text index contract for hybrid retrieval.
 *
 * 该接口把 keyword/BM25 检索和底层 repository 解耦；调用方只看到
 * `RecallHit`，不需要知道记录来自 memory、chunk 还是 summary tree。
 */

import type { RecallHit, MemoryScope } from "../../domain/types.js";

export interface TextIndexDocument {
  id: string;
  scope: MemoryScope;
  text: string;
  hit: RecallHit;
  metadata?: Record<string, unknown>;
}

export interface TextSearchInput {
  query: string;
  scope: MemoryScope;
  limit?: number;
  minScore?: number;
  filter?: Record<string, unknown>;
}

export interface TextIndex {
  upsert(documents: TextIndexDocument[]): Promise<void>;
  remove(ids: string[]): Promise<void>;
  search(input: TextSearchInput): Promise<RecallHit[]>;
  count(filter?: { scope?: MemoryScope }): Promise<number>;
}
