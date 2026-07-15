import { AuthorityScopeError } from "../../core/src/domain/authority-scope.js";
import { AuthorityScopedForgetError } from "../../core/src/lifecycle/forget-transaction.js";
import { EmbeddingWriteBlockedError } from "../../core/src/storage/embedding-space-policy.js";

const MCP_TOOL_FAILURE = "MCP tool request failed";

/** 客户端可修正的 MCP 入参错误；message 必须是代码内固定文案。 */
export class McpInvalidRequestError extends Error {
  readonly code = "INVALID_REQUEST";

  constructor(message: string) {
    super(message);
    this.name = "McpInvalidRequestError";
  }
}

/**
 * 将内部异常映射为稳定、脱敏且可操作的 MCP 错误文本。
 * 未知 provider/runtime 异常永远不回显原始 message。
 */
export function formatMcpToolError(error: unknown): string {
  if (error instanceof McpInvalidRequestError) {
    return `${MCP_TOOL_FAILURE} (${error.code}): ${error.message}`;
  }
  if (error instanceof AuthorityScopeError) {
    return `${MCP_TOOL_FAILURE} (${error.code})`;
  }
  if (error instanceof AuthorityScopedForgetError) {
    if (error.code === "TARGET_NOT_FOUND_OR_FORBIDDEN") {
      return `${MCP_TOOL_FAILURE} (${error.code}): ` +
        "目标未匹配授权 scope；请检查 tableName 和 dataTypes" +
        "（memory_ingest 记录位于 knowledge，类型为 document/knowledge）。";
    }
    return `${MCP_TOOL_FAILURE} (${error.code}): ${error.message}`;
  }
  if (error instanceof EmbeddingWriteBlockedError) {
    return `${MCP_TOOL_FAILURE} (WRITE_BLOCKED): ${error.reasonCode}`;
  }
  return `${MCP_TOOL_FAILURE} (INTERNAL_ERROR)`;
}
