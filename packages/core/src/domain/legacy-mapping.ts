/**
 * 旧 `MemoryEntry` 与中间件核心记录之间的适配层。
 *
 * 这里是 OpenClaw v2.x 存储格式进入 v4 middleware core 的兼容边界：
 * legacy 字段必须可无损回转，scope/provenance 则从 metadata 中派生。
 *
 * 新增 scope 维度列支持，修复项目/产品维度过滤功能（D-25）：
 * - recordToMemoryEntry：写入时把 scope 维度镜像到独立字段（projectName/appName/userId/agentId/workspaceId）
 * - memoryEntryToRecord：读回时优先用独立字段，为 NULL 时回退 defaults（向后兼容）
 */

import type { MemoryCategory } from "../../../../config.js";
import type { MemoryEntry, TableName } from "../db/types.js";
import type { MemoryKind, MemoryRecord, MemoryScopeInput, MemorySemanticType, RecordProvenance } from "../../../../core/types.js";
import { normalizeScope } from "../../../../core/scope.js";
import { kindToSemanticType } from "./semantic-type-mapper.js";

const MEMORY_SEMANTIC_TYPES: readonly MemorySemanticType[] = [
  "profile",
  "task_context",
  "rules",
  "experience",
  "resource",
];

function isMemorySemanticType(value: unknown): value is MemorySemanticType {
  return typeof value === "string" && (MEMORY_SEMANTIC_TYPES as readonly string[]).includes(value);
}

/**
 * 把 legacy importance 强制规整为合法 number ∈ [0,1]。
 *
 * 迁移数据的 importance 可能以字符串（如 "0.9"）形式存储，违反 MemoryRecord.importance: number
 * 契约，导致下游 clamp01/排序依赖隐式类型转换。这里在边界处一次性收口：
 * - number：直接 clamp 到 [0,1]
 * - 可解析字符串："0.9" -> 0.9
 * - 非法/缺失：回退中性默认 0.5（与评分层缺省一致）
 */
function coerceImportance(value: unknown): number {
  const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(num)) return 0.5;
  if (num < 0) return 0;
  if (num > 1) return 1;
  return num;
}

/**
 * 解析记录的 semanticType（5 type 协议）。
 *
 * 迁移数据普遍缺少 metadata.semanticType，但带有 kind/category。为了让 5 槽位注入、
 * importance 4 项明细、召回排序等所有消费方都能拿到 semanticType（而不是只有
 * SlotContextBuilder 内部临时 enrich），在边界处统一推导：
 * 1. 优先用 metadata.semanticType（显式写入，最权威）
 * 2. 回退到 kind -> semanticType 的高置信度确定性映射
 * 3. 仍无法归类则保持 undefined（kind-only 记忆，靠 lookup 检索）
 */
function resolveSemanticType(
  metadata: MemoryEntry["metadata"],
  kind: MemoryKind,
): MemorySemanticType | undefined {
  if (isMemorySemanticType(metadata.semanticType)) {
    return metadata.semanticType;
  }
  const mapping = kindToSemanticType(kind);
  if (mapping.semanticType && mapping.confidence === "high") {
    return mapping.semanticType;
  }
  return undefined;
}

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
    // D-25：优先使用独立列（projectName/appName/userId/agentId/workspaceId），NULL 时回退 defaults
    appId: entry.appName ?? defaults.appId,
    userId: entry.userId ?? (typeof metadata.userId === "string" ? metadata.userId : defaults.userId),
    projectId: entry.projectName ?? (typeof metadata.projectPath === "string" ? metadata.projectPath : defaults.projectId),
    agentId: entry.agentId ?? (typeof metadata.agentName === "string" ? metadata.agentName : defaults.agentId),
    namespace: tableNameToNamespace(entry.tableName),
    workspaceId: entry.workspaceId ?? defaults.workspaceId,
  });

  const recordKind = inferKind(entry);

  return {
    id: entry.id,
    scope,
    kind: recordKind,
    text: entry.text,
    contentHash: entry.contentHash,
    importance: coerceImportance(entry.importance),
    category: entry.category,
    dataType: entry.dataType,
    tableName: entry.tableName,
    metadata: { ...metadata },
    provenance: buildProvenance(entry),
    createdAt: entry.createdAt,
    updatedAt: typeof metadata.updatedAt === "number" ? metadata.updatedAt : undefined,
    hotness: typeof metadata.hotness === "number" ? metadata.hotness : undefined,
    sourceNodeIds: Array.isArray(metadata.sourceNodeIds)
      ? (metadata.sourceNodeIds.filter((id): id is string => typeof id === "string"))
      : undefined,
    confidence: typeof metadata.confidence === "number" ? metadata.confidence : undefined,
    semanticType: resolveSemanticType(metadata, recordKind),
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
    // D-25：scope 维度镜像到独立列（只有 !== "default" 才写入，避免污染）
    projectName: record.scope.projectId && record.scope.projectId !== "default"
      ? record.scope.projectId
      : undefined,
    appName: record.scope.appId && record.scope.appId !== "default"
      ? record.scope.appId
      : undefined,
    userId: record.scope.userId && record.scope.userId !== "default"
      ? record.scope.userId
      : undefined,
    agentId: record.scope.agentId && record.scope.agentId !== "default"
      ? record.scope.agentId
      : undefined,
    workspaceId: record.scope.workspaceId,
    metadata: {
      ...record.metadata,
      ...(record.hotness !== undefined && { hotness: record.hotness }),
      ...(record.sourceNodeIds && { sourceNodeIds: record.sourceNodeIds }),
      ...(record.confidence !== undefined && { confidence: record.confidence }),
      ...(record.semanticType && { semanticType: record.semanticType }),
      ...(record.updatedAt !== undefined && { updatedAt: record.updatedAt }),
    },
    createdAt: record.createdAt,
  };
}
