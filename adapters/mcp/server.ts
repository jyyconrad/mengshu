/**
 * Transport-agnostic MCP memory server facade.
 *
 * 这个 facade 只负责工具发现和调用，不启动 stdio/http transport；这样 M3 可以先
 * 固化工具契约，避免过早引入 MCP SDK 依赖。
 */

import type { MemoryService } from "../../core/service-types.js";
import { createMcpMemoryTools, type McpMemoryTool } from "./tools.js";

export interface McpMemoryServer {
  name: string;
  listTools(): McpMemoryTool[];
  callTool(name: string, input: Record<string, unknown>): Promise<unknown>;
}

export function createMcpMemoryServer(options: {
  service: MemoryService;
  namespaces?: string[];
}): McpMemoryServer {
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
