/**
 * OpenClaw tool handlers for mengshu.
 *
 * 该模块把 OpenClaw 工具参数映射到中间件 `MemoryService` 和 ingestion pipeline，
 * 并保持旧工具的响应文案和 details 结构。
 */

import { randomUUID } from "node:crypto";
import type { MemoryCategory } from "../../../config.js";
import { MEMORY_CATEGORIES, type KnowledgeBaseConfig } from "../../../config.js";
import type { DataType, TableName } from "../../../db/types.js";
import type {
  AuthorityScopedForgetService,
  MemoryService,
} from "../../../core/service-types.js";
import type { MemoryRecord, RecallHit, MemoryScope } from "../../../core/types.js";
import type { AuthorityScope } from "../../../packages/core/src/domain/authority-scope.js";
import type { IngestionPipeline } from "../../../ingest/pipeline.js";
import { ingestMarkdownDirectory } from "../../../ingest/adapters/file-system.js";
import { computeContentHash } from "../../../processing/hash-utils.js";
import { resolveOpenClawAuthorityScope } from "./authority.js";

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

export type OpenClawInputErrorCode =
  | "FILTER_INVALID"
  | "TABLE_NAME_INVALID"
  | "OLDER_THAN_DAYS_INVALID"
  | "RANGE_DELETE_UNSUPPORTED";

export class OpenClawInputError extends Error {
  readonly code: OpenClawInputErrorCode;
  readonly field: string;

  constructor(code: OpenClawInputErrorCode, message: string, field: string) {
    super(message);
    this.name = "OpenClawInputError";
    this.code = code;
    this.field = field;
  }
}

export class OpenClawPartialStoreError extends Error {
  constructor(readonly receipt: {
    createdCount: number;
    duplicateCount: number;
    outcomes: Array<{
      tableName: TableName;
      id: string;
      action: "created" | "duplicate";
    }>;
  }) {
    super("OpenClaw memory store partially completed");
    this.name = "OpenClawPartialStoreError";
  }
}

const SAFE_TABLE_NAME = /^(?:memories|knowledge|knowledge_[a-z][a-z0-9_]{0,63})$/;
const DEFAULT_ALLOWED_TABLES: readonly TableName[] = ["memories", "knowledge"];
const SAFE_FILTER_KEYS = new Set([
  "id",
  "contentHash",
  "appId",
  "projectId",
  "agentId",
  "namespace",
  "visibility",
  "category",
  "kind",
  "semanticType",
  "lifecycleStatus",
  "source",
  "createdAt",
  "importance",
  "pinned",
]);
const NUMERIC_FILTER_KEYS = new Set(["createdAt", "importance"]);
const SAFE_VISIBILITIES = new Set(["private", "workspace", "team", "public"]);
const PROTOTYPE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const CONTROL_OR_SQL_TOKEN = /[\u0000-\u001f\u007f;'"`]|--|\/\*|\*\//;

function inputError(
  code: OpenClawInputErrorCode,
  field: string,
): OpenClawInputError {
  const messages: Record<OpenClawInputErrorCode, string> = {
    FILTER_INVALID: "OpenClaw filter contains an unsupported key or value",
    TABLE_NAME_INVALID: "OpenClaw table name is not allowlisted",
    OLDER_THAN_DAYS_INVALID: "OpenClaw olderThanDays must be a finite positive number",
    RANGE_DELETE_UNSUPPORTED:
      "OpenClaw cleanup cannot transactionally delete by age range in this runtime",
  };
  return new OpenClawInputError(code, messages[code], field);
}

function assertSafeTableName(
  value: unknown,
  field: string,
  allowedTables: readonly TableName[] = DEFAULT_ALLOWED_TABLES,
): TableName {
  if (
    typeof value !== "string" ||
    !SAFE_TABLE_NAME.test(value) ||
    !allowedTables.includes(value as TableName)
  ) {
    throw inputError("TABLE_NAME_INVALID", field);
  }
  return value as TableName;
}

export function resolveOpenClawAllowedTables(
  knowledgeBases?: KnowledgeBaseConfig,
): readonly TableName[] {
  const tables = new Set<TableName>(DEFAULT_ALLOWED_TABLES);
  if (!knowledgeBases?.enabled) return [...tables];

  const categories = [
    ...(knowledgeBases.builtinCategories ?? []),
    ...(knowledgeBases.customCategories ?? []),
  ];
  for (const category of categories) {
    const tableName = `knowledge_${category}`;
    if (!SAFE_TABLE_NAME.test(tableName)) {
      throw inputError("TABLE_NAME_INVALID", "knowledgeBases");
    }
    tables.add(tableName as TableName);
  }
  return [...tables];
}

function validateFilter(
  value: unknown,
  field = "filter",
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw inputError("FILTER_INVALID", field);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw inputError("FILTER_INVALID", field);
  }
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) {
    throw inputError("FILTER_INVALID", field);
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (PROTOTYPE_KEYS.has(key) || !SAFE_FILTER_KEYS.has(key)) {
      throw inputError("FILTER_INVALID", field);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw inputError("FILTER_INVALID", field);
    }
    const item = descriptor.value;
    if (key === "pinned") {
      if (typeof item !== "boolean") throw inputError("FILTER_INVALID", field);
    } else if (key === "visibility") {
      if (typeof item !== "string" || !SAFE_VISIBILITIES.has(item)) {
        throw inputError("FILTER_INVALID", field);
      }
    } else if (NUMERIC_FILTER_KEYS.has(key)) {
      if (typeof item !== "number" || !Number.isFinite(item) || item < 0) {
        throw inputError("FILTER_INVALID", field);
      }
      if (key === "importance" && item > 1) {
        throw inputError("FILTER_INVALID", field);
      }
    } else if (
      typeof item !== "string" ||
      item.length === 0 ||
      item.length > 512 ||
      item !== item.trim() ||
      item.normalize("NFKC") !== item ||
      CONTROL_OR_SQL_TOKEN.test(item)
    ) {
      throw inputError("FILTER_INVALID", field);
    }
    result[key] = item;
  }
  return result;
}

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

export interface OpenClawAuthorityContext {
  authority?: AuthorityScope;
  defaultScope?: MemoryScope;
  allowedTables?: readonly TableName[];
}

export interface MemoryStoreContext extends OpenClawAuthorityContext {
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

export interface MemoryServiceContext extends OpenClawAuthorityContext {
  service: MemoryService;
  now?: () => number;
  metadata?: Record<string, unknown>;
}

export interface MemoryForgetContext extends MemoryServiceContext {
  forgetService: AuthorityScopedForgetService;
  idempotencyKeyFactory?: () => string;
}

export interface MemoryScanDirectoryContext extends OpenClawAuthorityContext {
  pipeline: IngestionPipeline;
  resolvePath(path: string): string;
  defaultIgnorePaths?: string[];
  defaultIgnoreRules?: string[];
  defaultTargetTable?: TableName;
  defaultAutoEnrichMetadata?: boolean;
  chunkSize?: number;
}

const PIPELINE_AUTHORITIES = new WeakMap<
  IngestionPipeline,
  { readonly authority: AuthorityScope; readonly defaultScope: MemoryScope }
>();

/** Bind legacy CLI scan composition to the same server authority without a client fallback. */
export function bindOpenClawPipelineAuthority(
  pipeline: IngestionPipeline,
  authority: AuthorityScope,
  defaultScope: MemoryScope,
): void {
  resolveOpenClawAuthorityScope(authority, defaultScope);
  PIPELINE_AUTHORITIES.set(pipeline, Object.freeze({ authority, defaultScope }));
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
  return tableName === "knowledge" || tableName?.startsWith("knowledge_")
    ? "knowledge"
    : "memory";
}

export function resolveCategoryLabel(category?: string): MemoryCategory {
  if (!category) return "other";
  return CATEGORY_LABEL_MAP[category] || "other";
}

function resolveRecallRouting(
  params: MemoryRecallParams,
  allowedTables?: readonly TableName[],
): {
  dataTypes: DataType[];
  tableName?: TableName;
  searchAll: boolean;
} {
  const includeDocuments = params.includeDocuments ?? false;
  let dataTypes: DataType[];
  let tableName: TableName | undefined;

  if (params.knowledgeBase !== undefined) {
    tableName = assertSafeTableName(params.knowledgeBase, "knowledgeBase", allowedTables);
    dataTypes = tableName === "knowledge" || tableName.startsWith("knowledge_")
      ? ["knowledge"]
      : ["memory"];
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
    searchAll: params.knowledgeBase === undefined && Boolean(params.searchAll),
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
  } = params;
  const filter = validateFilter(params.filter);
  const routing = resolveRecallRouting(params, context.allowedTables);
  const scope = resolveContextScope(context, params);

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
  // Authority resolution must precede routing, embedding and storage.
  const scope = resolveContextScope(context, params);

  const contentHash = computeContentHash(text);
  const now = context.now ?? Date.now;
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
    targetTables = routingResult.targetTables.map((table) =>
      assertSafeTableName(table, "routingEngine.targetTables", context.allowedTables));
    context.logger?.info?.(
      `mengshu: routing to ${targetTables.join(", ")} (matched rules: ${routingResult.matchedRules.map((r) => r.name).join(", ")})`,
    );
  }

  // Global content-hash lookup is not authority-scoped and therefore cannot be
  // used as a cross-tenant existence oracle. Scoped write-kernel dedupe owns it.
  const vector = await context.embed(text);

  const outcomes: Array<{
    tableName: TableName;
    id: string;
    action: "created" | "duplicate";
  }> = [];
  for (const table of targetTables) {
    const id = context.idFactory?.() ?? randomUUID();
    const record: MemoryRecord = {
      id,
      scope,
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
    let outcome: Awaited<ReturnType<MemoryService["storeMemory"]>>;
    try {
      outcome = await context.service.storeMemory({ record });
    } catch (error) {
      if (outcomes.length === 0) throw error;
      throw new OpenClawPartialStoreError({
        createdCount: outcomes.filter((item) => item.action === "created").length,
        duplicateCount: outcomes.filter((item) => item.action === "duplicate").length,
        outcomes: [...outcomes],
      });
    }
    outcomes.push({
      tableName: table,
      id: outcome.id,
      action: outcome.stored ? "created" : "duplicate",
    });
  }

  const tableNamesDisplay = targetTables.map((table) => resolveCategoryName(table)).join(", ");
  const createdCount = outcomes.filter((outcome) => outcome.action === "created").length;
  const duplicateCount = outcomes.length - createdCount;
  const action = createdCount === outcomes.length
    ? "created"
    : duplicateCount === outcomes.length
      ? "duplicate"
      : "mixed";
  const responseText = action === "created"
    ? `Stored: "${text.slice(0, 100)}..." to ${tableNamesDisplay}`
    : action === "duplicate"
      ? `Already stored: "${text.slice(0, 100)}..." in ${tableNamesDisplay}`
      : `Memory store completed: ${createdCount} created, ${duplicateCount} duplicate in ${tableNamesDisplay}`;
  return {
    content: [{ type: "text", text: responseText }],
    details: {
      action,
      id: outcomes[0]?.id,
      createdCount,
      duplicateCount,
      outcomes,
      contentHash,
      targetTables,
      storageCategory: resolveCategoryName(tableName),
      routingEnabled: !!context.routingEngine,
    },
  };
}

export async function handleMemoryForget(
  params: MemoryForgetParams,
  context: MemoryForgetContext,
): Promise<ToolResponse> {
  const { query, memoryId } = params;
  const filter = validateFilter(params.filter);
  const scope = resolveContextScope(context, params);
  if (!context.forgetService || typeof context.forgetService.forget !== "function") {
    throw new Error("OpenClaw transactional forget service is required");
  }
  const forget = async (selection: { ids?: readonly string[]; filter?: Record<string, unknown> }) =>
    context.forgetService.forget({
      serverAuthority: context.authority!,
      clientScope: clientScopeRequest(scope),
      action: "delete",
      ...selection,
      tableName: "memories",
      dataTypes: ["memory"],
      idempotencyKey: context.idempotencyKeyFactory?.() ?? `openclaw-forget:${randomUUID()}`,
      actor: "openclaw",
      reason: "memory_forget tool",
      now: context.now?.(),
    });
  if (memoryId) {
    await forget({ ids: [memoryId] });
    return {
      content: [{ type: "text", text: `Memory ${memoryId} forgotten.` }],
      details: { action: "deleted", id: memoryId },
    };
  }

  if (filter) {
    const result = await forget({ filter });
    return {
      content: [{ type: "text", text: `Deleted ${result.deleted} memories matching filter.` }],
      details: { action: "bulk_deleted", count: result.deleted },
    };
  }

  if (query) {
    const result = await context.service.recall({ query, limit: 5, minScore: 0.7, scope });
    if (result.hits.length === 0) {
      return {
        content: [{ type: "text", text: "No matching memories found." }],
        details: { found: 0 },
      };
    }

    if (result.hits.length === 1 && result.hits[0].score > 0.9) {
      await forget({ ids: [result.hits[0].record.id] });
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
  context: MemoryForgetContext,
): Promise<ToolResponse> {
  const { dataType, olderThanDays } = params;
  const validatedFilter = validateFilter(params.filter) ?? {};
  if (olderThanDays !== undefined) {
    if (
      typeof olderThanDays !== "number" ||
      !Number.isFinite(olderThanDays) ||
      olderThanDays <= 0
    ) {
      throw inputError("OLDER_THAN_DAYS_INVALID", "olderThanDays");
    }
    throw inputError("RANGE_DELETE_UNSUPPORTED", "olderThanDays");
  }
  const scope = resolveContextScope(context, params);
  const deleteFilter: Record<string, unknown> = { ...validatedFilter };

  if (Object.keys(deleteFilter).length === 0) {
    return {
      content: [{ type: "text", text: "Please specify at least one filter condition to avoid deleting all data." }],
      details: { error: "no_filter_provided" },
    };
  }
  if (!context.forgetService || typeof context.forgetService.forget !== "function") {
    throw new Error("OpenClaw transactional forget service is required");
  }

  const tableName = dataType === "document" ? "knowledge" : "memories";
  const dataTypes: DataType[] = dataType
    ? [dataType]
    : tableName === "knowledge"
      ? ["document"]
      : ["memory"];
  const result = await context.forgetService.forget({
    serverAuthority: context.authority!,
    clientScope: clientScopeRequest(scope),
    action: "delete",
    filter: deleteFilter,
    tableName,
    dataTypes,
    idempotencyKey: context.idempotencyKeyFactory?.() ?? `openclaw-cleanup:${randomUUID()}`,
    actor: "openclaw",
    reason: "memory_cleanup tool",
    now: context.now?.(),
  });
  return {
    content: [{ type: "text", text: `Cleanup completed. Deleted ${result.deleted} entries.` }],
    details: { action: "cleanup", deletedCount: result.deleted, filter: deleteFilter },
  };
}

export async function handleMemoryScanDirectory(
  params: MemoryScanDirectoryParams,
  context: MemoryScanDirectoryContext,
): Promise<ToolResponse> {
  const targetTable = assertSafeTableName(
    params.targetTable ?? context.defaultTargetTable ?? "knowledge",
    "targetTable",
    context.allowedTables,
  );
  const scope = resolveContextScope(context, params);
  const autoEnrichMetadata = params.autoEnrichMetadata ?? context.defaultAutoEnrichMetadata ?? true;
  const resolvedDir = context.resolvePath(params.directory);
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

function clientScopeRequest(scope: MemoryScope): Record<string, unknown> {
  return {
    appId: scope.appId,
    projectId: scope.projectId,
    agentId: scope.agentId,
    namespace: scope.namespace,
    visibility: scope.visibility ?? "private",
  };
}

function resolveContextScope(
  context: OpenClawAuthorityContext,
  untrusted: unknown,
): MemoryScope {
  let authority = context.authority;
  let defaultScope = context.defaultScope;
  if ((!authority || !defaultScope) && "pipeline" in context) {
    const bound = PIPELINE_AUTHORITIES.get(
      (context as MemoryScanDirectoryContext).pipeline,
    );
    authority = bound?.authority;
    defaultScope = bound?.defaultScope;
  }
  if (!authority || !defaultScope) {
    throw new Error("OpenClaw server authority and defaultScope are required");
  }
  return resolveOpenClawAuthorityScope(authority, defaultScope, untrusted);
}

export { MEMORY_CATEGORIES };
