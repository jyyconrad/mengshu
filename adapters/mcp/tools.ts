/**
 * MCP core tool adapter.
 *
 * 用途：提供稳定的 MCP 工具注册表和 execute 映射，供 stdio/http transport 复用。
 * 核心流程：createMcpMemoryTools 把 MemoryService（以及可选的 AgentFastPathService）
 *   的方法映射成带 JSON Schema 的工具描述，stdio-server 再据此注册 MCP handler。
 * 关键边界：
 *   - 每个工具都带 inputSchema（MCP 协议要求）。
 *   - agentFastPath 可选；不传时只暴露基础 8 个工具（保持向后兼容）。
 *   - 不暴露内部治理工具（候选区/树/图谱/job 管理）。
 */

import type { AgentFastPathService } from "../../api/agent-fast-path.js";
import type {
  AgentLookupRequest,
  AgentObserveLightRequest,
  AgentTaskContextRequest,
} from "../../api/agent-fast-path.js";
import type {
  BuildContextInput,
  DeleteMemoryInput,
  MemoryService,
  RecallInput,
  StoreMemoryInput,
} from "../../core/service-types.js";

/** JSON Schema 对象（MCP inputSchema 形态，保持宽松类型） */
export type JsonSchemaObject = Record<string, unknown>;

export interface McpMemoryTool {
  name: string;
  description: string;
  /** MCP 协议要求的 JSON Schema，描述工具入参形状 */
  inputSchema: JsonSchemaObject;
  execute(input: Record<string, unknown>): Promise<unknown>;
}

export interface McpMemoryToolsOptions {
  service: MemoryService;
  namespaces?: string[];
  /** 可选 Agent 快路径服务；注入后额外暴露 3 个快路径工具 */
  agentFastPath?: AgentFastPathService;
}

/** 通用 scope 字段定义，多个工具复用 */
const scopeSchema: JsonSchemaObject = {
  type: "object",
  description: "Memory scope (tenant/app/user/project/agent/namespace).",
  properties: {
    tenantId: { type: "string" },
    appId: { type: "string" },
    userId: { type: "string" },
    projectId: { type: "string" },
    agentId: { type: "string" },
    namespace: { type: "string" },
  },
  additionalProperties: false,
};

/** 召回类工具的公共入参 schema */
const recallInputSchema: JsonSchemaObject = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query text." },
    scope: scopeSchema,
    limit: { type: "number", description: "Max hits to return." },
    minScore: { type: "number", description: "Minimum similarity score." },
    filter: { type: "object", description: "Structured metadata filter." },
    tableName: { type: "string", description: "Target table name." },
    dataTypes: { type: "array", items: { type: "string" } },
    searchAll: { type: "boolean", description: "Search across all tables." },
  },
  required: ["query"],
  additionalProperties: true,
};

/** 写入类工具的公共入参 schema */
const storeInputSchema: JsonSchemaObject = {
  type: "object",
  properties: {
    record: {
      type: "object",
      description: "Memory record payload to persist.",
      additionalProperties: true,
    },
  },
  required: ["record"],
  additionalProperties: true,
};

export function createMcpMemoryTools(options: McpMemoryToolsOptions): McpMemoryTool[] {
  const namespaces = options.namespaces ?? ["memories", "knowledge"];

  const baseTools: McpMemoryTool[] = [
    {
      name: "memory_save",
      description: "Save a memory record.",
      inputSchema: storeInputSchema,
      execute: (input) => options.service.storeMemory(input as unknown as StoreMemoryInput),
    },
    {
      name: "memory_recall",
      description: "Recall relevant memories.",
      inputSchema: recallInputSchema,
      execute: (input) => options.service.recall(input as unknown as RecallInput),
    },
    {
      name: "memory_context",
      description: "Build a prompt-safe context block from recalled memories.",
      inputSchema: {
        type: "object",
        properties: {
          ...(recallInputSchema.properties as JsonSchemaObject),
          title: { type: "string", description: "Optional context block title." },
        },
        required: ["query"],
        additionalProperties: true,
      },
      execute: (input) => options.service.buildContext(input as unknown as BuildContextInput),
    },
    {
      name: "memory_observe",
      description: "Observe and save a memory record.",
      inputSchema: storeInputSchema,
      execute: (input) => options.service.storeMemory(input as unknown as StoreMemoryInput),
    },
    {
      name: "memory_ingest",
      description:
        "Ingest an external source into memory. [Roadmap] Not yet available — use memory_observe/memory_save for single records, or the ms scan CLI for documents.",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string", description: "External source identifier." },
        },
        additionalProperties: true,
      },
      // memory_ingest 是 roadmap 功能：完整接入需把 IngestionPipeline 串入 MCP
      // 注入链路并决定持久化后端（当前 pipeline 用非持久化 InMemoryStore）。
      // 在落地前返回明确的状态说明 + 可操作替代方案，避免调用方误判为配置错误。
      execute: async () => ({
        status: "not_implemented",
        error:
          "memory_ingest 暂未开放（roadmap 功能，尚未接入持久化的 ingestion pipeline）。",
        hint:
          "替代方案：单条记忆用 memory_observe / memory_save；批量文档用 CLI 'ms scan <dir> --target-table knowledge'。",
      }),
    },
    {
      name: "memory_namespaces",
      description: "List known memory namespaces.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => ({ namespaces }),
    },
    {
      name: "memory_forget",
      description: "Forget memories by ids or filter.",
      inputSchema: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" }, description: "Memory ids to delete." },
          filter: { type: "object", description: "Structured metadata filter." },
        },
        additionalProperties: true,
      },
      execute: (input) => options.service.delete(input as unknown as DeleteMemoryInput),
    },
    {
      name: "memory_health",
      description: "Return memory service health.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => options.service.health(),
    },
  ];

  if (!options.agentFastPath) {
    return baseTools;
  }

  const fastPath = options.agentFastPath;
  const fastPathTools: McpMemoryTool[] = [
    {
      name: "memory_context_fast",
      description: "Fetch the 5-slot agent task context for task startup.",
      inputSchema: {
        type: "object",
        properties: {
          scope: scopeSchema,
          task: { type: "string", description: "Current task description." },
          intent: { type: "string", description: "Task intent classification." },
          constraints: { type: "array", items: { type: "string" } },
          tokenBudget: { type: "number" },
          latencyBudgetMs: { type: "number" },
        },
        required: ["scope", "task"],
        additionalProperties: true,
      },
      execute: (input) => fastPath.context(input as unknown as AgentTaskContextRequest),
    },
    {
      name: "memory_observe_light",
      description: "Submit a lightweight observation during a running task.",
      inputSchema: {
        type: "object",
        properties: {
          scope: scopeSchema,
          eventType: { type: "string", description: "Observation event type." },
          text: { type: "string", description: "Observation text." },
          metadata: { type: "object" },
          intent: { type: "string", enum: ["remember", "ignore", "auto"] },
        },
        required: ["scope", "eventType", "text"],
        additionalProperties: true,
      },
      execute: (input) => fastPath.observeLight(input as unknown as AgentObserveLightRequest),
    },
    {
      name: "memory_lookup",
      description: "On-demand fast lookup during a running task.",
      inputSchema: {
        type: "object",
        properties: {
          scope: scopeSchema,
          query: { type: "string", description: "Lookup query text." },
          filters: { type: "object" },
          mode: { type: "string", enum: ["fast", "deep"] },
          limit: { type: "number" },
        },
        required: ["scope", "query"],
        additionalProperties: true,
      },
      execute: (input) => fastPath.lookup(input as unknown as AgentLookupRequest),
    },
  ];

  return [...baseTools, ...fastPathTools];
}
