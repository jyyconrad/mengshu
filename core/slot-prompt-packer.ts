/**
 * Slot prompt 拼装器。
 *
 * 本文件做什么：把 5 槽位上下文块拼装为可直接放入 Agent prompt 的文本，
 * 并提供 prompt-safe 转义（剔除可能用于注入的标签）。从 slot-context-builder
 * 拆出，保持 builder 聚焦于过滤/分组/打分逻辑。
 *
 * 边界：纯函数，不修改入参；转义为保守白名单式标签剔除，非完整 HTML 转义。
 */

import type { ContextFastResponse } from "./semantic-types.js";
import type { MemorySemanticType } from "./types.js";

/**
 * 简单的 prompt-safe 转义：剔除可能注入的标签。
 */
export function escapeForPrompt(text: string): string {
  return text
    .replace(/<\/?relevant-memories>/g, "")
    .replace(/<\/?slot[^>]*>/g, "")
    .replace(/<\/?system>/gi, "");
}

/**
 * Prompt 注入模板：将 5 槽位拼接为可直接放入 Agent prompt 的文本。
 * 顺序固定为 rules 优先（合规底线），其后 profile/task_context/experience/resource。
 */
export function packSlotsToPrompt(
  slots: ContextFastResponse["slots"],
  task?: string,
): string {
  const lines: string[] = ["<relevant-memories>"];

  if (task) {
    lines.push(`<task>${escapeForPrompt(task)}</task>`);
  }

  const order: MemorySemanticType[] = [
    "rules", // 规则优先（合规底线）
    "profile",
    "task_context",
    "experience",
    "resource",
  ];

  for (const type of order) {
    const block = slots[type];
    if (!block || block.nodeCount === 0) continue;
    lines.push(`<slot type="${type}" question="${escapeForPrompt(block.question)}">`);
    lines.push(escapeForPrompt(block.content));
    lines.push(`</slot>`);
  }

  lines.push("</relevant-memories>");
  return lines.join("\n");
}
