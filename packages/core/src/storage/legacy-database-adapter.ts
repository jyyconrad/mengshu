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
  DATABASE_STORE_CLEANUP_WARNING,
  parseDatabaseStoreCleanupError,
  parseDatabaseStoreResult,
} from "../db/types.js";
import {
  memoryEntryToRecord,
  recordToMemoryEntry,
} from "../domain/legacy-mapping.js";
import type {
  MemoryRepository,
  MemoryRepositoryQuery,
  MemoryRepositoryStoreResult,
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

  async store(records: MemoryRecord[]): Promise<MemoryRepositoryStoreResult> {
    return this.storeLegacyEntries(records.map((record) => this.recordToMemoryEntry(record)));
  }

  async query(input: MemoryRepositoryQuery): Promise<Array<MemoryRecord & { score: number }>> {
    const hits = await this.queryLegacyEntries(this.toLegacyQueryOptions(input));
    // Provider 是第一道下推边界；这里是第二道防御边界。旧记录的独立 authority
    // 列为 NULL 时绝不能用 metadata/default 回填后变成可见记录。
    const authorized = hits.filter((hit) =>
      hit.tenantId === input.scope.tenantId && hit.userId === input.scope.userId,
    );
    const records = authorized.map((hit) => ({
      ...this.memoryEntryToRecord(hit),
      score: hit.score,
    }));
    return input.limit === undefined ? records : records.slice(0, input.limit);
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

  async storeLegacyEntries(entries: MemoryEntry[]): Promise<MemoryRepositoryStoreResult> {
    let outcome;
    try {
      outcome = await this.provider.store(entries);
    } catch (error) {
      const cleanupError = parseDatabaseStoreCleanupError(error);
      if (!cleanupError) throw error;
      outcome = {
        ...cleanupError.receipt,
        cleanup: {
          cleanupFailed: true,
          operationStatus: cleanupError.operationStatus,
          warning: DATABASE_STORE_CLEANUP_WARNING,
        },
      };
    }
    if (!outcome) {
      throw new Error("Database provider did not return a durable store outcome");
    }
    const normalized = parseDatabaseStoreResult(outcome);
    if (!normalized) {
      throw new Error("Database provider returned an invalid durable store outcome");
    }

    const requestedIds = new Set(entries.map((entry) => entry.id));
    if (requestedIds.size !== entries.length ||
        normalized.records.some((record) => !requestedIds.has(record.requestedId))) {
      throw new Error("Database provider store receipt does not match requested entries");
    }
    const requiresCompleteReceipt = normalized.cleanup?.operationStatus !== "partial";
    if (requiresCompleteReceipt && normalized.records.length !== entries.length) {
      throw new Error("Database provider completed store receipt is incomplete");
    }
    return normalized;
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
    const { tenantId, userId } = input.scope;
    if (typeof tenantId !== "string" || tenantId.length === 0 || tenantId !== tenantId.trim() ||
        typeof userId !== "string" || userId.length === 0 || userId !== userId.trim()) {
      throw new Error("memory recall authority scope is invalid");
    }

    // tenant/user 是独立列上的硬 authority 条件；其它 scope 仍由现有软排序、
    // 显式 hard project/app 以及后续复用策略决定。
    const filter: Record<string, unknown> = { ...(input.filter ?? {}) };

    // D-25：提取内部 scope 过滤 key（由 memory-service 注入），映射到 MemoryQueryOptions
    const projectName = typeof filter._projectName === "string" ? filter._projectName : undefined;
    const appName = typeof filter._appName === "string" ? filter._appName : undefined;
    const projectPattern = typeof filter._projectPattern === "string" ? filter._projectPattern : undefined;

    // 删除内部 key，避免传给 provider 的 metadata filter
    delete filter._projectName;
    delete filter._appName;
    delete filter._projectPattern;

    return {
      query: input.query,
      vector: input.vector,
      limit: input.limit,
      minScore: input.minScore,
      tableName: input.tableName,
      dataTypes: input.dataTypes,
      searchAll: input.searchAll,
      tenantId,
      userId,
      filter: Object.keys(filter).length > 0 ? filter : undefined,
      // 映射到 MemoryQueryOptions（provider 层已支持）
      projectName,
      appName,
      projectPattern,
    };
  }
}
