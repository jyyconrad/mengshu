import type { RuntimeClient } from "../../api/src/runtime-client.js";
import {
  startMcpToolRegistryStdioServer,
  type McpStdioStartDependencies,
  type RunningMcpStdioServer,
} from "./stdio-server.js";
import { freezeMcpToolRegistry, type McpMemoryTool } from "./tools.js";

const SAFE_TOOL_NAME = /^[a-z][a-z0-9_]{0,127}$/;

function descriptor(value: unknown): Omit<McpMemoryTool, "execute"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("RUNTIME_MCP_REGISTRY_INVALID");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const schema = record.inputSchema;
  if (JSON.stringify(keys) !== JSON.stringify(["description", "inputSchema", "name"]) ||
      typeof record.name !== "string" || !SAFE_TOOL_NAME.test(record.name) ||
      typeof record.description !== "string" || record.description.trim().length === 0 ||
      !schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("RUNTIME_MCP_REGISTRY_INVALID");
  }
  return {
    name: record.name,
    description: record.description,
    inputSchema: structuredClone(schema as Record<string, unknown>),
  };
}

export async function loadRuntimeMcpTools(client: RuntimeClient): Promise<readonly McpMemoryTool[]> {
  const response = await client.invoke<{ readonly tools?: readonly unknown[] }>({
    method: "GET",
    path: "/v1/runtime/mcp-tools",
  });
  if (!response || !Array.isArray(response.tools) || response.tools.length === 0) {
    throw new Error("RUNTIME_MCP_REGISTRY_INVALID");
  }
  const descriptors = response.tools.map(descriptor);
  if (new Set(descriptors.map((tool) => tool.name)).size !== descriptors.length) {
    throw new Error("RUNTIME_MCP_REGISTRY_INVALID");
  }
  return freezeMcpToolRegistry(descriptors.map((tool) => ({
    ...tool,
    execute: (args) => client.invoke({
      method: "POST",
      path: "/v1/runtime/mcp-call",
      body: { name: tool.name, arguments: args },
    }),
  })));
}

export async function startRuntimeClientMcpStdioServer(
  client: RuntimeClient,
  dependencies: Pick<McpStdioStartDependencies, "transport"> = {},
): Promise<RunningMcpStdioServer> {
  return startMcpToolRegistryStdioServer(await loadRuntimeMcpTools(client), dependencies);
}
