/**
 * 旧 `MemoryEntry` 与中间件核心记录之间的适配层。
 *
 * 这里是 OpenClaw v2.x 存储格式进入 v4 middleware core 的兼容边界：
 * legacy 字段必须可无损回转，scope/provenance 则从 metadata 中派生。
 */

import type { MemoryCategory } from "../../../../config.js";
import type { MemoryEntry, TableName } from "../db/types.js";
import type { MemoryKind, MemoryRecord, MemoryScopeInput, RecordProvenance } from "../../../../core/types.js";
import { normalizeScope } from "../../../../core/scope.js";

export function tableNameToNamespace(tableName?: TableName): string {
  return tableName ?? "memories";
}

export function categoryToKind(category: MemoryCategory): MemoryKind {
  switch (category) {
    case "preference":
    case "decision":
    case "entity":
    case "fact":
    case "task":
    case "plan":
    case "goal":
      return category;
    case "core":
    case "other":
    default:
      return "other";
  }
}

function inferKind(entry: MemoryEntry): MemoryKind {
  if (entry.dataType === "document") {
    return "document";
  }
  if (entry.dataType === "knowledge" || tableNameToNamespace(entry.tableName).startsWith("knowledge")) {
    return "knowledge";
  }
  return categoryToKind(entry.category);
}

function buildProvenance(entry: MemoryEntry): RecordProvenance {
  const metadata = entry.metadata;
  return {
    source: typeof metadata.source === "string" ? metadata.source : undefined,
    sessionId: typeof metadata.sessionId === "string" ? metadata.sessionId : undefined,
    conversationId: typeof metadata.conversationId === "string" ? metadata.conversationId : undefined,
    messageId: typeof metadata.messageId === "string" ? metadata.messageId : undefined,
    filePath: typeof metadata.filePath === "string" ? metadata.filePath : undefined,
    createdAt: entry.createdAt,
  };
}

export function memoryEntryToRecord(entry: MemoryEntry, defaults: MemoryScopeInput = {}): MemoryRecord {
  const metadata = entry.metadata;
  const scope = normalizeScope({
    tenantId: defaults.tenantId,
    appId: defaults.appId,
    userId: typeof metadata.userId === "string" ? metadata.userId : defaults.userId,
    projectId: typeof metadata.projectPath === "string" ? metadata.projectPath : defaults.projectId,
    agentId: typeof metadata.agentName === "string" ? metadata.agentName : defaults.agentId,
    namespace: tableNameToNamespace(entry.tableName),
  });

  return {
    id: entry.id,
    scope,
    kind: inferKind(entry),
    text: entry.text,
    contentHash: entry.contentHash,
    importance: entry.importance,
    category: entry.category,
    dataType: entry.dataType,
    tableName: entry.tableName,
    metadata: { ...metadata },
    provenance: buildProvenance(entry),
    createdAt: entry.createdAt,
    updatedAt: typeof metadata.updatedAt === "number" ? metadata.updatedAt : undefined,
    vector: [...entry.vector],
  };
}

export function recordToMemoryEntry(record: MemoryRecord, vector?: number[]): MemoryEntry {
  return {
    id: record.id,
    text: record.text,
    contentHash: record.contentHash,
    vector: vector ? [...vector] : [...(record.vector ?? [])],
    importance: record.importance,
    category: record.category,
    dataType: record.dataType,
    tableName: record.tableName,
    metadata: { ...record.metadata },
    createdAt: record.createdAt,
  };
}
