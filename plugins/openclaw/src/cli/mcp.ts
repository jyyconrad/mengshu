/**
 * OpenClaw `ms mcp` 子命令（F1-2）。
 *
 * 本文件做什么：注册 `ms mcp` 命令，启动 stdio MCP server，让本地 MCP 客户端
 * （Claude Desktop / Cursor 等）通过 stdin/stdout 调用长期记忆工具。
 *
 * 核心流程：
 * 1. 用注入的 MemoryService（可选 AgentFastPathService）构造 stdio MCP server。
 * 2. connect StdioServerTransport，进程保持存活直到 SIGINT/SIGTERM。
 * 3. 收到终止信号时优雅 close server 后退出。
 *
 * 关键边界：
 * - stdio 模式下不能往 stdout 打印日志（会污染 JSON-RPC 流），状态信息走 stderr。
 * - scope 由客户端调用方在工具入参里传入，本命令不做鉴权。
 * - 与 cli.ts 共用 CommanderLike 鸭子类型，不引入 commander 硬依赖。
 */

import type { CommanderLike } from "./index.js";
import type { MemoryService } from "../../../../core/service-types.js";
import type { AgentFastPathService } from "../../../../packages/api/src/agent-fast-path/index.js";
import type { IngestionPipeline } from "../../../../packages/core/src/ingest/pipeline.js";
import type { LlmClient } from "../../../../packages/core/src/runtime/llm/llm-client.js";
import { startMcpStdioServer } from "../../../../packages/mcp/src/stdio-server.js";

/** mcp 命令依赖注入。 */
export interface McpCliDeps {
  service: MemoryService;
  /** 注入后额外暴露 context_fast / observe_light / lookup 快路径工具。 */
  agentFastPath?: AgentFastPathService;
  namespaces?: string[];
  /** 注入后 memory_ingest 走真实持久化链路。 */
  pipeline?: IngestionPipeline;
  /** 预留给 ingest 增强；当前热路径不调用 LLM。 */
  llmClient?: LlmClient;
  /**
   * 默认 scope。当 MCP 客户端调用工具未传递 scope 时自动填充（DEFECT-002 修复）。
   *
   * 设计理念：一个 MCP server 实例对应一个特定产品/项目，scope（尤其 tenantId）
   * 应该是 server 启动时确定的上下文，而不是依赖客户端每次调用时传递（容易遗漏）。
   */
  defaultScope?: {
    tenantId?: string;
    appId?: string;
    userId?: string;
    projectId?: string;
    agentId?: string;
    namespace?: string;
  };
  /** 启动器（测试可注入 fake）。默认 startMcpStdioServer。 */
  startServer?: typeof startMcpStdioServer;
  /** 进程存活控制（测试可注入立即返回的版本）。 */
  keepAlive?: boolean;
}

/** 注册 `ms mcp` 命令。 */
export function registerMcpCliCommands(memory: CommanderLike, deps: McpCliDeps): void {
  memory
    .command("mcp")
    .description("Start MCP stdio server for local clients (Claude Desktop / Cursor)")
    .action(async () => {
      const start = deps.startServer ?? startMcpStdioServer;
      const running = await start({
        service: deps.service,
        agentFastPath: deps.agentFastPath,
        namespaces: deps.namespaces,
        pipeline: deps.pipeline,
        llmClient: deps.llmClient,
        defaultScope: deps.defaultScope,
      });

      // stdio 模式：状态信息只能走 stderr，避免污染 stdout 的 JSON-RPC 流。
      process.stderr.write("MCP stdio server started (Ctrl+C to stop)\n");

      if (deps.keepAlive === false) {
        await running.close();
        return;
      }

      const shutdown = async () => {
        await running.close();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      // 保持进程存活，等待 MCP 客户端通过 stdio 通信。
      await new Promise<void>(() => {
        // 永不 resolve；由 SIGINT/SIGTERM 触发 shutdown。
      });
    });
}
