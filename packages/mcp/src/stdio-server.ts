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
 *   - stdio 必须注入 server-owned AuthorityScope；客户端只能请求 allowlist 内的非身份字段。
 *   - 不暴露内部治理工具；工具表完全由 createMcpMemoryTools 决定。
 *   - 未知工具 / execute 抛错都包成 MCP isError content，而非崩溃进程。
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { AgentFastPathService } from "../../api/src/agent-fast-path/index.js";
import type { MemoryService } from "../../../core/service-types.js";
import type { AuthorityScopedForgetService } from "../../core/src/domain/service-types.js";
import type { AuthorityScopedForgetCapability } from "../../core/src/service/authority-forget-capability.js";
import type { IngestionPipeline } from "../../core/src/ingest/pipeline.js";
import type { LlmClient } from "../../core/src/runtime/llm/llm-client.js";
import type { AuthorityScope } from "../../core/src/domain/authority-scope.js";
import type { MemoryScope } from "../../core/src/domain/types.js";
import {
  createMcpMemoryTools,
  freezeMcpToolRegistry,
  type McpMemoryTool,
} from "./tools.js";
import { parseMcpServerAuthorityConfig } from "./server.js";
import { formatMcpToolError } from "./tool-error.js";

const SERVER_NAME = "mengshu";
const SERVER_VERSION = "1.0.6";

export interface McpStdioServerOptions {
  service: MemoryService;
  forgetCapability?: AuthorityScopedForgetCapability;
  /** @deprecated Ignored. Structural services cannot enable destructive tools. */
  forgetService?: AuthorityScopedForgetService;
  /** Authenticated server authority; stdio never accepts client tenant/user. */
  authority: AuthorityScope;
  /** Server-selected default request, validated against authority at host startup. */
  defaultScope?: MemoryScope;
  agentFastPath?: AgentFastPathService;
  namespaces?: string[];
  /** 注入后 memory_ingest 走真实持久化链路 */
  pipeline?: IngestionPipeline;
  /** 预留给 ingest 增强；当前热路径不调用 LLM */
  llmClient?: LlmClient;
}

/** MCP CallTool 响应的 content 形态 */
interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * 把工具表转成 MCP ListTools 响应。
 */
export function buildListToolsResult(tools: readonly McpMemoryTool[]): {
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
export function buildCallToolHandler(tools: readonly McpMemoryTool[]) {
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
        content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: formatMcpToolError(err) }],
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
  tools: readonly McpMemoryTool[];
} {
  const authorityConfig = parseMcpServerAuthorityConfig({
    authority: options.authority,
    defaultScope: options.defaultScope,
  });
  const tools = freezeMcpToolRegistry(createMcpMemoryTools({
    ...options,
    ...authorityConfig,
  }));
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

export interface RunningMcpStdioServer {
  close(): Promise<void>;
  readonly closed: Promise<void>;
}

export interface McpStdioStartDependencies {
  transport?: Transport;
}

/**
 * 启动 stdio MCP server：连接 StdioServerTransport，返回 close 句柄。
 */
export async function startMcpStdioServer(
  options: McpStdioServerOptions,
  dependencies: McpStdioStartDependencies = {},
): Promise<RunningMcpStdioServer> {
  const { server } = createMcpStdioServer(options);
  const transport = dependencies.transport ?? new StdioServerTransport();
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  server.onclose = resolveClosed;
  await server.connect(transport);
  let closePromise: Promise<void> | undefined;
  return {
    closed,
    close: () => {
      closePromise ??= server.close().finally(resolveClosed);
      return closePromise;
    },
  };
}

type McpShutdownSignal = "SIGINT" | "SIGTERM";

export interface McpShutdownSignalSource {
  once(signal: McpShutdownSignal, listener: () => void): unknown;
  off(signal: McpShutdownSignal, listener: () => void): unknown;
}

/** Wait for transport EOF/close or a termination signal without exiting the process. */
export async function waitForMcpServerShutdown(
  running: RunningMcpStdioServer,
  signals: McpShutdownSignalSource = process,
): Promise<"transport" | McpShutdownSignal> {
  let resolveSignal!: (signal: McpShutdownSignal) => void;
  const signalled = new Promise<McpShutdownSignal>((resolve) => {
    resolveSignal = resolve;
  });
  const onSigint = () => resolveSignal("SIGINT");
  const onSigterm = () => resolveSignal("SIGTERM");
  signals.once("SIGINT", onSigint);
  signals.once("SIGTERM", onSigterm);
  try {
    const reason = await Promise.race([
      running.closed.then(() => "transport" as const),
      signalled,
    ]);
    if (reason !== "transport") await running.close();
    return reason;
  } finally {
    signals.off("SIGINT", onSigint);
    signals.off("SIGTERM", onSigterm);
  }
}

/** Close transport first, but always attempt runtime shutdown as well. */
export async function closeMcpServerAndRuntime(
  running: RunningMcpStdioServer | undefined,
  runtime: { stop(): Promise<void> },
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await running?.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    await runtime.stop();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "MCP transport and runtime shutdown failed");
  }
}
