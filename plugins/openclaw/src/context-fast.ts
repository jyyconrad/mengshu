/**
 * memory_context_fast tool handler for OpenClaw.
 *
 * 封装 AgentFastPathService 为 OpenClaw 工具，提供快速 5 槽位上下文。
 */

import type { MemoryScope, MemoryScopeInput } from "../../../core/types.js";
import {
  type AgentFastPathService,
  type AgentTaskContextRequest,
} from "../../../packages/api/src/agent-fast-path/index.js";
import { normalizeScope } from "../../../core/scope.js";
import { requireContextFastRecallReceipts } from "../../../packages/core/src/domain/recall-receipt-validation.js";
import { buildOpenClawScope } from "./scope.js";

export interface MemoryContextFastParams {
  task: string;
  scope?: MemoryScopeInput;
  tokenBudget?: number;
  latencyBudgetMs?: number;
}

export interface MemoryContextFastContext {
  agentFastPath: Pick<AgentFastPathService, "context">;
  defaultScope?: MemoryScopeInput;
  logger?: { info?(msg: string): void };
}

export async function handleMemoryContextFast(
  params: MemoryContextFastParams,
  context: MemoryContextFastContext
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}> {
  const inputScope = params.scope ?? context.defaultScope ?? buildOpenClawScope();
  const scope: MemoryScope = normalizeScope(inputScope);

  const request: AgentTaskContextRequest = {
    scope,
    task: params.task,
    tokenBudget: params.tokenBudget,
    latencyBudgetMs: params.latencyBudgetMs,
  };

  const response = requireContextFastRecallReceipts(
    await context.agentFastPath.context(request),
  );

  // 拼接结果为文本
  const lines: string[] = [];
  lines.push(`### 5 Slot Context (${response.telemetry.nodesUsed} memories, ${response.telemetry.latencyMs}ms)`);
  lines.push("");

  if (response.slots.profile) {
    lines.push(`#### ${response.slots.profile.question}`);
    lines.push(response.slots.profile.content);
    lines.push("");
  }
  if (response.slots.task_context) {
    lines.push(`#### ${response.slots.task_context.question}`);
    lines.push(response.slots.task_context.content);
    lines.push("");
  }
  if (response.slots.rules) {
    lines.push(`#### ${response.slots.rules.question}`);
    lines.push(response.slots.rules.content);
    lines.push("");
  }
  if (response.slots.experience) {
    lines.push(`#### ${response.slots.experience.question}`);
    lines.push(response.slots.experience.content);
    lines.push("");
  }
  if (response.slots.resource) {
    lines.push(`#### ${response.slots.resource.question}`);
    lines.push(response.slots.resource.content);
    lines.push("");
  }

  if (response.warnings && response.warnings.length > 0) {
    lines.push("**Warnings:**");
    response.warnings.forEach((w) => lines.push(`- ${w}`));
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: {
      scope: response.scope,
      slots: Object.fromEntries(
        Object.entries(response.slots).map(([k, v]) => [
          k,
          {
            nodeCount: v?.nodeCount,
            tokenEstimate: v?.tokenEstimate,
            sourceIds: v?.sourceIds,
            recallReceipts: v?.recallReceipts,
          },
        ])
      ),
      telemetry: response.telemetry,
      warnings: response.warnings,
      taskHints: response.taskHints,
      actions: response.actions,
    },
  };
}
