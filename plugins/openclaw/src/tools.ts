/**
 * OpenClaw tool handlers for mengshu.
 *
 * 该模块把 OpenClaw 工具参数映射到中间件 `MemoryService` 和 ingestion pipeline，
 * 并保持旧工具的响应文案和 details 结构。
 */

import { randomUUID } from "node:crypto";
import type { MemoryCategory } from "../../../config.js";
import { MEMORY_CATEGORIES } from "../../../config.js";
import type { DataType, TableName } from "../../../db/types.js";
import type { MemoryService } from "../../../core/service-types.js";
import type { MemoryRecord, RecallHit, MemoryScope } from "../../../core/types.js";
import type { IngestionPipeline } from "../../../ingest/pipeline.js";
import { ingestMarkdownDirectory } from "../../../ingest/adapters/file-system.js";
import { computeContentHash } from "../../../processing/hash-utils.js";
import { buildOpenClawScope } from "./scope.js";

const STORAGE_CATEGORY_MAP: Record<string, "memories" | "knowledge"> = {
  "核心记忆": "memories",
  "记忆": "memories",
  "对话记忆": "memories",
  "用户偏好": "memories",
  "偏好": "memories",
  "喜好": "memories",
  "事实": "memories",
  "实体": "memories",
  "决策": "memories",
  "定时任务": "memories",
  "任务": "memories",
  "长期规划": "memories",
  "规划": "memories",
  "计划": "memories",
  "目标": "memories",
  "知识库": "knowledge",
  "知识": "knowledge",
  "文档": "knowledge",
  "资料": "knowledge",
  "参考": "knowledge",
};

const CATEGORY_LABEL_MAP: Record<string, MemoryCategory> = {
  "核心记忆": "core",
  "记忆": "core",
  "对话记忆": "core",
  "用户偏好": "preference",
  "偏好": "preference",
  "喜好": "preference",
  "事实": "fact",
  "实体": "entity",
  "决策": "decision",
  "定时任务": "task",
  "任务": "task",
  "长期规划": "plan",
  "规划": "plan",
  "计划": "plan",
  "目标": "goal",
  "知识库": "other",
  "知识": "other",
  "文档": "other",
  "资料": "other",
  "参考": "other",
};

export interface ToolResponse {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

export interface MemoryRecallParams {
  query: string;
  limit?: number;
  minScore?: number;
  includeDocuments?: boolean;
  filter?: Record<string, unknown>;
  category?: string;
  searchAll?: boolean;
  knowledgeBase?: string;
}

export interface MemoryStoreParams {
  text: string;
  importance?: number;
  category?: MemoryCategory;
  metadata?: Record<string, unknown>;
  storageCategory?: string;
}

export interface MemoryForgetParams {
  query?: string;
  memoryId?: string;
  filter?: Record<string, unknown>;
}

export interface MemoryCleanupParams {
  dataType?: "memory" | "document";
  olderThanDays?: number;
  filter?: Record<string, unknown>;
}

export interface MemoryScanDirectoryParams {
  directory: string;
  ignorePaths?: string[];
  ignoreRules?: string[];
  targetTable?: string;
  autoEnrichMetadata?: boolean;
}

export interface MemoryStoreContext {
  service: MemoryService;
  embed(text: string): Promise<number[]>;
  existsByContentHash(contentHashes: string[]): Promise<string[]>;
  embeddingModel?: string;
  routingEngine?: {
    routeToKnowledgeBases(text: string, metadata?: Record<string, unknown>): {
      targetTables: TableName[];
      matchedRules: Array<{ name: string }>;
    };
  } | null;
  logger?: {
    info?(message: string): void;
  };
  idFactory?: () => string;
  now?: () => number;
}

export interface MemoryServiceContext {
  service: MemoryService;
  now?: () => number;
  metadata?: Record<string, unknown> | MemoryScope;
}

export interface MemoryScanDirectoryContext {
  pipeline: IngestionPipeline;
  resolvePath(path: string): string;
  defaultIgnorePaths?: string[];
  defaultIgnoreRules?: string[];
  defaultTargetTable?: TableName;
  defaultAutoEnrichMetadata?: boolean;
  chunkSize?: number;
}

export function resolveTableName(category?: string): "memories" | "knowledge" {
  if (!category) return "memories";
  return STORAGE_CATEGORY_MAP[category] || "memories";
}

export function resolveCategoryName(tableName?: string): string {
  if (!tableName) return "未知";
  const reverseMap: Record<string, string> = {
    "memories": "核心记忆",
    "knowledge": "知识库",
    "knowledge_personal": "个人知识库",
    "knowledge_work": "工作知识库",
  };
  return reverseMap[tableName] || tableName;
}

export function resolveDataType(tableName?: "memories" | "knowledge" | string): "memory" | "knowledge" {
  switch (tableName) {
    case "knowledge":
    case "knowledge_personal":
    case "knowledge_work":
      return "knowledge";
    case "memories":
    default:
      return "memory";
  }
}

export function resolveCategoryLabel(category?: string): MemoryCategory {
  if (!category) return "other";
  return CATEGORY_LABEL_MAP[category] || "other";
}

function resolveRecallRouting(params: MemoryRecallParams): {
  dataTypes: DataType[];
  tableName?: TableName;
  searchAll: boolean;
} {
  const includeDocuments = params.includeDocuments ?? false;
  let dataTypes: DataType[];
  let tableName: TableName | undefined;

  if (params.knowledgeBase) {
    tableName = params.knowledgeBase as TableName;
    dataTypes = params.knowledgeBase.startsWith("knowledge_") ? ["knowledge"] : ["memory"];
  } else if (params.category) {
    tableName = resolveTableName(params.category);
    if (tableName === "knowledge") {
      dataTypes = ["knowledge"];
    } else if (tableName === "memories") {
      dataTypes = includeDocuments ? ["memory", "document"] : ["memory"];
    } else {
      dataTypes = includeDocuments ? ["memory", "document", "knowledge"] : ["memory"];
    }
  } else {
    dataTypes = includeDocuments ? ["memory", "document", "knowledge"] : ["memory"];
  }

  return {
    dataTypes,
    tableName,
    searchAll: Boolean(params.searchAll || params.knowledgeBase),
  };
}

function isMemoryRecord(record: RecallHit["record"]): record is MemoryRecord {
  return "text" in record && "category" in record;
}

function formatRecallHit(hit: RecallHit, index: number): string {
  if (!isMemoryRecord(hit.record)) {
    return `${index + 1}. [${hit.source}] ${"summary" in hit.record ? hit.record.summary : hit.record.id} (${(hit.score * 100).toFixed(0)}%)`;
  }
  const source = hit.record.dataType === "document" && hit.record.metadata?.filePath
    ? ` (from: ${hit.record.metadata.filePath})`
    : "";
  const categoryInfo = hit.record.tableName ? ` [${resolveCategoryName(hit.record.tableName)}]` : "";
  return `${index + 1}. [${hit.record.category}]${categoryInfo} ${hit.record.text}${source} (${(hit.score * 100).toFixed(0)}%)`;
}

function sanitizeRecallHit(hit: RecallHit): Record<string, unknown> {
  if (!isMemoryRecord(hit.record)) {
    return {
      id: hit.record.id,
      score: hit.score,
      source: hit.source,
    };
  }
  return {
    id: hit.record.id,
    text: hit.record.text,
    category: hit.record.category,
    dataType: hit.record.dataType,
    tableName: hit.record.tableName,
    metadata: hit.record.metadata,
    importance: hit.record.importance,
    score: hit.score,
  };
}

export async function handleMemoryRecall(
  params: MemoryRecallParams,
  context: MemoryServiceContext,
): Promise<ToolResponse> {
  const {
    query,
    limit = 5,
    minScore = 0.1,
    filter,
  } = params;
  const routing = resolveRecallRouting(params);

  // Build scope from metadata if provided
  // If metadata is already a MemoryScope, use it directly
  // If it's OpenClaw event metadata, convert through buildOpenClawScope
  let scope: MemoryScope | undefined;
  if (context.metadata) {
    if ("tenantId" in context.metadata && "appId" in context.metadata) {
      // Already a MemoryScope (e.g. runtime.defaultScope)
      scope = context.metadata as MemoryScope;
    } else {
      // OpenClaw event metadata, convert through buildOpenClawScope
      scope = buildOpenClawScope(context.metadata);
    }
  }

  const result = await context.service.recall({
    query,
    limit,
    minScore,
    dataTypes: routing.dataTypes,
    filter,
    tableName: routing.tableName,
    searchAll: routing.searchAll,
    scope,
  });

  if (result.hits.length === 0) {
    return {
      content: [{ type: "text", text: "No relevant memories found." }],
      details: { count: 0 },
    };
  }

  const text = result.hits.map(formatRecallHit).join("\n");
  return {
    content: [{ type: "text", text: `Found ${result.hits.length} memories:\n\n${text}` }],
    details: {
      count: result.hits.length,
      memories: result.hits.map(sanitizeRecallHit),
    },
  };
}

export async function handleMemoryStore(
  params: MemoryStoreParams,
  context: MemoryStoreContext,
): Promise<ToolResponse> {
  const {
    text,
    importance = 0.7,
    category = "other",
    metadata = {},
    storageCategory,
  } = params;

  const contentHash = computeContentHash(text);
  const existingHashes = await context.existsByContentHash([contentHash]);
  if (existingHashes.length > 0) {
    return {
      content: [{ type: "text", text: "Similar memory already exists." }],
      details: {
        action: "duplicate",
        contentHash,
      },
    };
  }

  const now = context.now ?? Date.now;
  const vector = await context.embed(text);
  const enrichedMetadata: Record<string, unknown> = {
    ...metadata,
    source: "user" as const,
    createdAt: now(),
    updatedAt: now(),
    embeddingModel: context.embeddingModel,
  };
  const tableName = resolveTableName(storageCategory || "核心记忆");
  const resolvedCategory = category === "other" && storageCategory
    ? resolveCategoryLabel(storageCategory)
    : category;

  let targetTables: TableName[] = [tableName];
  if (context.routingEngine && tableName === "knowledge") {
    const routingResult = context.routingEngine.routeToKnowledgeBases(text, enrichedMetadata);
    targetTables = routingResult.targetTables;
    context.logger?.info?.(
      `mengshu: routing to ${targetTables.join(", ")} (matched rules: ${routingResult.matchedRules.map((r) => r.name).join(", ")})`,
    );
  }

  const ids: string[] = [];
  for (const table of targetTables) {
    const id = context.idFactory?.() ?? randomUUID();
    ids.push(id);
    const record: MemoryRecord = {
      id,
      scope: buildOpenClawScope({ ...enrichedMetadata, tableName: table }),
      kind: resolveDataType(table) === "knowledge" ? "knowledge" : resolvedCategory === "other" || resolvedCategory === "core" ? "other" : resolvedCategory,
      text,
      contentHash,
      vector,
      importance,
      category: resolvedCategory,
      dataType: resolveDataType(table),
      tableName: table,
      metadata: enrichedMetadata,
      provenance: {
        source: "user",
        sessionId: typeof enrichedMetadata.sessionId === "string" ? enrichedMetadata.sessionId : undefined,
        conversationId: typeof enrichedMetadata.conversationId === "string" ? enrichedMetadata.conversationId : undefined,
        messageId: typeof enrichedMetadata.messageId === "string" ? enrichedMetadata.messageId : undefined,
        createdAt: now(),
      },
      createdAt: now(),
      updatedAt: now(),
    };
    await context.service.storeMemory({ record });
  }

  const tableNamesDisplay = targetTables.map((table) => resolveCategoryName(table)).join(", ");
  return {
    content: [{ type: "text", text: `Stored: "${text.slice(0, 100)}..." to ${tableNamesDisplay}` }],
    details: {
      action: "created",
      id: ids[0],
      contentHash,
      targetTables,
      storageCategory: resolveCategoryName(tableName),
      routingEnabled: !!context.routingEngine,
    },
  };
}

export async function handleMemoryForget(
  params: MemoryForgetParams,
  context: MemoryServiceContext,
): Promise<ToolResponse> {
  const { query, memoryId, filter } = params;
  if (memoryId) {
    await context.service.delete({ ids: [memoryId] });
    return {
      content: [{ type: "text", text: `Memory ${memoryId} forgotten.` }],
      details: { action: "deleted", id: memoryId },
    };
  }

  if (filter) {
    const result = await context.service.delete({ filter });
    return {
      content: [{ type: "text", text: `Deleted ${result.deleted} memories matching filter.` }],
      details: { action: "bulk_deleted", count: result.deleted },
    };
  }

  if (query) {
    const result = await context.service.recall({ query, limit: 5, minScore: 0.7 });
    if (result.hits.length === 0) {
      return {
        content: [{ type: "text", text: "No matching memories found." }],
        details: { found: 0 },
      };
    }

    if (result.hits.length === 1 && result.hits[0].score > 0.9) {
      await context.service.delete({ ids: [result.hits[0].record.id] });
      const record = result.hits[0].record;
      const text = "text" in record ? record.text : record.id;
      return {
        content: [{ type: "text", text: `Forgotten: "${text}"` }],
        details: { action: "deleted", id: record.id },
      };
    }

    const list = result.hits
      .map((hit) => {
        const record = hit.record;
        const text = "text" in record ? record.text : record.id;
        return `- [${record.id.slice(0, 8)}] ${text.slice(0, 60)}...`;
      })
      .join("\n");
    return {
      content: [{ type: "text", text: `Found ${result.hits.length} candidates. Specify memoryId:\n${list}` }],
      details: {
        action: "candidates",
        candidates: result.hits.map((hit) => {
          const record = hit.record;
          return {
            id: record.id,
            text: "text" in record ? record.text : undefined,
            category: "category" in record ? record.category : undefined,
            score: hit.score,
          };
        }),
      },
    };
  }

  return {
    content: [{ type: "text", text: "Provide query, memoryId, or filter." }],
    details: { error: "missing_param" },
  };
}

export async function handleMemoryCleanup(
  params: MemoryCleanupParams,
  context: MemoryServiceContext,
): Promise<ToolResponse> {
  const { dataType, olderThanDays, filter = {} } = params;
  const deleteFilter: Record<string, unknown> = { ...filter };
  if (dataType) {
    deleteFilter.dataType = dataType;
  }
  if (olderThanDays) {
    const now = context.now ?? Date.now;
    deleteFilter.createdAt = { $lt: now() - (olderThanDays * 24 * 60 * 60 * 1000) };
  }

  if (Object.keys(deleteFilter).length === 0) {
    return {
      content: [{ type: "text", text: "Please specify at least one filter condition to avoid deleting all data." }],
      details: { error: "no_filter_provided" },
    };
  }

  const result = await context.service.delete({ filter: deleteFilter });
  return {
    content: [{ type: "text", text: `Cleanup completed. Deleted ${result.deleted} entries.` }],
    details: { action: "cleanup", deletedCount: result.deleted, filter: deleteFilter },
  };
}

export async function handleMemoryScanDirectory(
  params: MemoryScanDirectoryParams,
  context: MemoryScanDirectoryContext,
): Promise<ToolResponse> {
  const targetTable = (params.targetTable ?? context.defaultTargetTable ?? "knowledge") as TableName;
  const autoEnrichMetadata = params.autoEnrichMetadata ?? context.defaultAutoEnrichMetadata ?? true;
  const resolvedDir = context.resolvePath(params.directory);
  const scope = buildOpenClawScope({ tableName: targetTable });
  const result = await ingestMarkdownDirectory({
    directory: resolvedDir,
    scope,
    pipeline: context.pipeline,
    scannerOptions: {
      ignorePaths: [
        ...(params.ignorePaths ?? []),
        ...(context.defaultIgnorePaths ?? []),
      ],
      ignoreRules: [
        ...(params.ignoreRules ?? []),
        ...(context.defaultIgnoreRules ?? []),
      ],
    },
    chunkSize: context.chunkSize,
    targetTable,
    autoEnrichMetadata,
  });

  return {
    content: [
      {
        type: "text",
        text: `Directory scan completed:\n` +
          `- Scanned directory: ${result.directory}\n` +
          `- Total files found: ${result.totalFiles}\n` +
          `- Processed successfully: ${result.processedFiles}\n` +
          `- Failed: ${result.failedFiles}\n` +
          `- Total chunks: ${result.totalChunks}\n` +
          `- Stored new chunks: ${result.storedChunks}\n` +
          `- Duplicate chunks skipped: ${result.duplicateChunks}\n` +
          `- Jobs queued: ${result.jobsQueued}\n` +
          `- Chunks admitted: ${result.chunksAdmitted}\n` +
          `- Chunks dropped: ${result.chunksDropped}`,
      },
    ],
    details: {
      ...result,
      targetTable,
      autoEnrichMetadata,
    },
  };
}

export { MEMORY_CATEGORIES };
