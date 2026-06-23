/**
 * Transport-agnostic MCP memory server facade.
 *
 * 这个 facade 只负责工具发现和调用，不启动 stdio/http transport；这样 M3 可以先
 * 固化工具契约，避免过早引入 MCP SDK 依赖。
 */

import type { MemoryService } from "../../../core/service-types.js";
import type { AgentFastPathService } from "../../api/src/agent-fast-path/index.js";
import type { IngestionPipeline } from "../../core/src/ingest/pipeline.js";
import type { LlmClient } from "../../core/src/runtime/llm/llm-client.js";
import { createMcpMemoryTools, type McpMemoryTool } from "./tools.js";

export interface McpMemoryServer {
  name: string;
  listTools(): McpMemoryTool[];
  callTool(name: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface McpMemoryServerOptions {
  service: MemoryService;
  namespaces?: string[];
  agentFastPath?: AgentFastPathService;
  pipeline?: IngestionPipeline;
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

export function createMcpMemoryServer(options: McpMemoryServerOptions): McpMemoryServer {
  const tools = createMcpMemoryTools(options);
  return {
    name: "mengshu",
    listTools: () => tools,
    callTool: async (name, input) => {
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) {
        throw new Error(`Unknown MCP tool: ${name}`);
      }
      return tool.execute(input);
    },
  };
}
