/**
 * forget-types.ts
 *
 * 工作内容：定义 `ms forget` 命令族（撤回 / 纠错 / 固定 / 归档 / 回滚合并）的
 *           输入输出契约与持久化在 metadata 中的生命周期治理字段。
 * 设计依据：memory-system-unified-design §13.3「用户可执行动作」。
 *
 * 关键约束：
 *   - 旧 `MemoryEntry` 的 legacy mapping 不持久化顶层 lifecycleStatus，因此所有
 *     治理状态（lifecycleStatus / pinned / 审计日志 / 合并日志）一律落在
 *     `metadata` 内，随记录无损回转，且与具体向量库实现解耦。
 *   - 所有写操作均追加审计日志（前后值、操作者、原因、时间），软删可回滚。
 */

import type { MemoryKind } from "../domain/types.js";

/** 撤回后可回滚的时间窗口：7 天（§13.3）。 */
export const REVOKE_UNDO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** 纠错后置信度重置到「人工确认级」。 */
export const HUMAN_CONFIRMED_CONFIDENCE = 1;

/** 主库生命周期状态（与 metadata 持久化字段同名）。 */
export type LifecycleStatus = "active" | "archived" | "revoked" | "superseded";

/** 默认不参与召回 / 注入的生命周期状态集合。 */
export const HIDDEN_FROM_RECALL: ReadonlySet<LifecycleStatus> = new Set([
  "revoked",
  "archived",
  "superseded",
]);

/** forget 命令族支持的动作。 */
export type ForgetAction =
  | "revoke"
  | "undo"
  | "archive"
  | "restore"
  | "pin"
  | "unpin"
  | "correct"
  | "rollback-merge";

/** 单条审计日志项，内联存储于 metadata.forgetLog。 */
export interface ForgetAuditEntry {
  action: ForgetAction;
  at: number;
  actor?: string;
  reason?: string;
  /** 受影响字段的前值（纠错 / 状态迁移时记录）。 */
  before?: Record<string, unknown>;
  /** 受影响字段的后值。 */
  after?: Record<string, unknown>;
}

/** 纠错动作的可选字段。 */
export interface CorrectionInput {
  /** 新正文。提供则同时刷新 contentHash 与（若可用）向量。 */
  text?: string;
  /** 新语义类型 / kind。 */
  type?: MemoryKind;
  /** 新归属 scope 标识（projectId / namespace 等，由调用方解释）。 */
  scope?: string;
}

/** 合并日志快照：记录被合并掉的原始记录，供回滚恢复（§5.8 可回滚要求）。 */
export interface MergeSnapshot {
  id: string;
  text: string;
  contentHash: string;
  importance: number;
  category: string;
  vector?: number[];
  metadata?: Record<string, unknown>;
  createdAt?: number;
}

/** forget 命令族的统一输入。 */
export interface ForgetCommandInput {
  id: string;
  action: ForgetAction;
  actor?: string;
  reason?: string;
  /** 注入当前时间，便于测试与确定性。 */
  now?: number;
  /** 仅 action="correct" 时使用。 */
  correction?: CorrectionInput;
  /** 目标表名（默认 memories）。 */
  table?: string;
}

/** forget 命令族的统一结果。 */
export interface ForgetCommandResult {
  id: string;
  action: ForgetAction;
  /** 是否实际产生了状态变更（幂等场景下可能为 false）。 */
  applied: boolean;
  lifecycleStatus?: LifecycleStatus;
  pinned?: boolean;
  /** 人类可读结果说明（CLI 直接打印）。 */
  message: string;
  /** rollback-merge 恢复出来的原始记录 id 列表。 */
  restoredIds?: string[];
}
