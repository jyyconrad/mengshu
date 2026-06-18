/**
 * 旧 DatabaseProvider 到核心 MemoryRepository 的适配器。
 *
 * 它让新的 `DefaultMemoryService` 可以复用现有 LanceDB/Supabase/Postgres
 * provider，不引入新 schema；同时保留 legacy helper，方便 OpenClaw adapter
 * 在迁移期间继续按旧 `MemoryEntry` 工作。
 */

import type {
  DatabaseProvider,
  MemoryEntry,
  MemoryQueryOptions,
  TableStats,
} from "../db/types.js";
import {
  memoryEntryToRecord,
  recordToMemoryEntry,
} from "../domain/legacy-mapping.js";
import type {
  MemoryRepository,
  MemoryRepositoryQuery,
} from "../domain/service-types.js";
import type { MemoryRecord, MemoryScopeInput } from "../domain/types.js";

export interface LegacyDatabaseStats {
  count: number;
  tables?: TableStats[];
}

export class LegacyDatabaseAdapter implements MemoryRepository {
  constructor(
    private readonly provider: DatabaseProvider,
    private readonly scopeDefaults: MemoryScopeInput = {},
  ) {}

  memoryEntryToRecord(entry: MemoryEntry): MemoryRecord {
    return memoryEntryToRecord(entry, this.scopeDefaults);
  }

  recordToMemoryEntry(record: MemoryRecord, vector?: number[]): MemoryEntry {
    return recordToMemoryEntry(record, vector);
  }

  async store(records: MemoryRecord[]): Promise<void> {
    await this.storeLegacyEntries(records.map((record) => this.recordToMemoryEntry(record)));
  }

  async query(input: MemoryRepositoryQuery): Promise<Array<MemoryRecord & { score: number }>> {
    const hits = await this.queryLegacyEntries(this.toLegacyQueryOptions(input));
    return hits.map((hit) => ({
      ...this.memoryEntryToRecord(hit),
      score: hit.score,
    }));
  }

  async delete(ids: string[]): Promise<void> {
    await this.deleteLegacyEntries(ids);
  }

  async deleteByFilter(filter: Record<string, unknown>): Promise<number> {
    return this.provider.deleteByFilter(filter);
  }

  async count(filter?: Record<string, unknown>): Promise<number> {
    return this.provider.count(filter);
  }

  async storeLegacyEntries(entries: MemoryEntry[]): Promise<void> {
    await this.provider.store(entries);
  }

  async queryLegacyEntries(options: MemoryQueryOptions): Promise<Array<MemoryEntry & { score: number }>> {
    return this.provider.query(options);
  }

  async deleteLegacyEntries(ids: string[]): Promise<void> {
    await this.provider.delete(ids);
  }

  async stats(): Promise<LegacyDatabaseStats> {
    const [count, tables] = await Promise.all([
      this.provider.count(),
      this.provider.getTableStats?.(),
    ]);
    return {
      count,
      tables,
    };
  }

  private toLegacyQueryOptions(input: MemoryRepositoryQuery): MemoryQueryOptions {
    const filter: Record<string, unknown> = { ...(input.filter ?? {}) };

    if (input.scope.userId !== "default") {
      filter.userId = input.scope.userId;
    }
    if (input.scope.projectId !== "default") {
      filter.projectPath = input.scope.projectId;
    }
    if (input.scope.agentId !== "default") {
      filter.agentName = input.scope.agentId;
    }

    return {
      query: input.query,
      vector: input.vector,
      limit: input.limit,
      minScore: input.minScore,
      tableName: input.tableName,
      dataTypes: input.dataTypes,
      searchAll: input.searchAll,
      filter: Object.keys(filter).length > 0 ? filter : undefined,
    };
  }
}
