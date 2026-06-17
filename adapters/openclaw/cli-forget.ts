/**
 * cli-forget.ts
 *
 * 工作内容：注册 `ms forget` 命令，支持撤回、纠错、固定、归档、回滚合并等治理操作。
 * 命令形态：`ms forget <id> [--undo | --archive | --restore | --pin | --unpin | --correct | --rollback-merge] [选项]`
 *
 * 设计边界：
 *   - 默认动作为 revoke（撤回）。
 *   - 所有动作通过 forget-handler 统一执行，状态持久化在 metadata。
 *   - 调用方负责注入 MemoryRepository 和可选的 Embeddings（纠错文本需要）。
 */

import type { MemoryRepository } from "../../core/service-types.js";
import type { MemoryScope } from "../../core/types.js";
import type { CommanderLike } from "./cli.js";
import { forgetCommand } from "../../lifecycle/forget-handler.js";
import type { ForgetAction, CorrectionInput } from "../../lifecycle/forget-types.js";

export interface ForgetCliDeps {
  repository: MemoryRepository;
  /** 可选：提供默认 scope 加速查询。 */
  defaultScope?: MemoryScope;
  /** 可选：纠错文本时重新计算向量需要 embeddings。 */
  embeddings?: { embed(text: string): Promise<number[]> };
}

interface ForgetOptions {
  undo?: boolean;
  archive?: boolean;
  restore?: boolean;
  pin?: boolean;
  unpin?: boolean;
  correct?: boolean;
  rollbackMerge?: boolean;
  text?: string;
  type?: string;
  scope?: string;
  reason?: string;
}

function resolveAction(options: ForgetOptions): ForgetAction {
  if (options.undo) return "undo";
  if (options.archive) return "archive";
  if (options.restore) return "restore";
  if (options.pin) return "pin";
  if (options.unpin) return "unpin";
  if (options.correct) return "correct";
  if (options.rollbackMerge) return "rollback-merge";
  return "revoke"; // 默认动作
}

function buildCorrection(options: ForgetOptions): CorrectionInput | undefined {
  if (!options.correct) return undefined;
  return {
    text: options.text,
    type: options.type as never,
    scope: options.scope,
  };
}

export function registerForgetCliCommands(memory: CommanderLike, deps: ForgetCliDeps): void {
  memory
    .command("forget <id>")
    .description(
      "忘记 / 治理记忆：撤回、纠错、固定、归档或回滚合并\n" +
      "默认动作为撤回（revoke），使记忆从召回和注入中剔除，7 天内可用 --undo 恢复"
    )
    .option("--undo", "撤销撤回（在 7 天窗口内恢复 revoked 记忆）")
    .option("--archive", "归档记忆（不参与默认召回，但保留可查）")
    .option("--restore", "恢复归档记忆为 active")
    .option("--pin", "固定记忆（强制进入必读层，跳过 importance 排序）")
    .option("--unpin", "取消固定")
    .option("--correct", "纠错记忆内容（需配合 --text / --type / --scope）")
    .option("--rollback-merge", "回滚合并，恢复被合并的原始记忆")
    .option("--text <text>", "纠错：新文本内容")
    .option("--type <type>", "纠错：新类型（如 preference / fact / decision）")
    .option("--scope <scope>", "纠错：新归属 scope 标识")
    .option("--reason <reason>", "操作原因（记入审计日志）")
    .action(async (...args: unknown[]) => {
      const id = args[0] as string;
      const options = (args[1] ?? {}) as ForgetOptions;
      try {
        const action = resolveAction(options);
        const correction = buildCorrection(options);

        const result = await forgetCommand({
          repository: deps.repository,
          id,
          action,
          actor: process.env.USER ?? "cli",
          reason: options.reason,
          correction,
          scope: deps.defaultScope,
          embeddings: deps.embeddings,
        });

        console.log(`\n[ms forget] ${result.message}`);
        if (result.lifecycleStatus) {
          console.log(`- lifecycleStatus: ${result.lifecycleStatus}`);
        }
        if (result.pinned !== undefined) {
          console.log(`- pinned: ${result.pinned}`);
        }
        if (result.restoredIds) {
          console.log(`- 恢复的原始记忆 ID: ${result.restoredIds.join(", ")}`);
        }
        if (!result.applied) {
          console.log(`- 幂等跳过：记忆已处于目标状态`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`\n[ms forget] 操作失败: ${message}`);
        process.exit(1);
      }
    });
}
