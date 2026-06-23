/**
 * MCP stdio transport server.
 *
 * 用途：把 createMcpMemoryServer/createMcpMemoryTools 的工具表绑定到官方 MCP SDK，
 *   通过 stdio transport 暴露给本地 MCP 客户端（Claude Desktop / Cursor 等）。
 * 核心流程：
 *   1. createMcpMemoryTools 拿到工具表（含 inputSchema）。
 *   2. buildListToolsResult / buildCallToolHandler 把工具表转成 MCP 协议响应。
 *   3. createMcpStdioServer 构造 SDK Server 并注册 ListTools/CallTool handler。
 *   4. startMcpStdioServer 额外 connect StdioServerTransport，返回 close 句柄。
 * 关键边界：
 *   - stdio 仅用于本地客户端；scope 由调用方在 args 中传入，本层不做鉴权。
 *   - 不暴露内部治理工具；工具表完全由 createMcpMemoryTools 决定。
 *   - 未知工具 / execute 抛错都包成 MCP isError content，而非崩溃进程。
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { AgentFastPathService } from "../../api/src/agent-fast-path/index.js";
import type { MemoryService } from "../../../core/service-types.js";
import type { IngestionPipeline } from "../../core/src/ingest/pipeline.js";
import type { LlmClient } from "../../core/src/runtime/llm/llm-client.js";
import { createMcpMemoryTools, type McpMemoryTool } from "./tools.js";

const SERVER_NAME = "mengshu";
const SERVER_VERSION = "2026.3.9";

export interface McpStdioServerOptions {
  service: MemoryService;
  agentFastPath?: AgentFastPathService;
  namespaces?: string[];
  /** 注入后 memory_ingest 走真实持久化链路 */
  pipeline?: IngestionPipeline;
  /** 预留给 ingest 增强；当前热路径不调用 LLM */
  llmClient?: LlmClient;
  /**
   * 默认 scope，当客户端调用时未传递 scope 时自动填充。
   *
   * 设计理念：一个 MCP server 实例通常对应一个特定的产品/项目，
   * 因此 scope（尤其是 tenantId）应该是 MCP server 启动时确定的上下文，
   * 而不是每次调用时由客户端传递（容易遗漏或不一致）。
   *
   * 如果不配置，将使用系统默认值：
   * { tenantId: "local", appId: "default", userId: "default", ... }
   */
  defaultScope?: {
    tenantId?: string;
    appId?: string;
    userId?: string;
    projectId?: string;
    agentId?: string;
    namespace?: string;
  };
}

/** MCP CallTool 响应的 content 形态 */
interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * 把工具表转成 MCP ListTools 响应。
 */
export function buildListToolsResult(tools: McpMemoryTool[]): {
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
} {
  return {
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  };
}

/**
 * 构造 CallTool 处理函数：按 name 路由到 tool.execute，结果包成 MCP text content。
 * 提取为独立纯函数，便于单测，无需真正启动 stdio 进程。
 */
export function buildCallToolHandler(tools: McpMemoryTool[]) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  return async (name: string, args: Record<string, unknown>): Promise<McpToolResult> => {
    const tool = byName.get(name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown MCP tool: ${name}` }],
        isError: true,
      };
    }

    try {
      const result = await tool.execute(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Tool ${name} failed: ${message}` }],
        isError: true,
      };
    }
  };
}

/**
 * 创建已注册 handler 的 MCP Server（未绑定 transport）。
 * 返回 server 与 tools，便于上层 connect 或单测直接驱动 handler。
 */
export function createMcpStdioServer(options: McpStdioServerOptions): {
  server: Server;
  tools: McpMemoryTool[];
} {
  const tools = createMcpMemoryTools(options);
  const callTool = buildCallToolHandler(tools);

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => buildListToolsResult(tools));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    // SDK 的结果联合类型含 task 变体，这里只用标准 content 形态，做一次断言收窄。
    return callTool(name, (args ?? {}) as Record<string, unknown>) as Promise<{
      content: Array<{ type: "text"; text: string }>;
      isError?: boolean;
    }>;
  });

  return { server, tools };
}

/**
 * 启动 stdio MCP server：连接 StdioServerTransport，返回 close 句柄。
 */
export async function startMcpStdioServer(
  options: McpStdioServerOptions
): Promise<{ close(): Promise<void> }> {
  const { server } = createMcpStdioServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  return {
    close: async () => {
      await server.close();
    },
  };
}
