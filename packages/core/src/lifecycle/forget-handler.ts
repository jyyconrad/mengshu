/**
 * forget-handler.ts
 *
 * 工作内容：忘记 / 治理命令族的核心逻辑。通过 MemoryRepository 的
 *           read-modify-write 模式原子地变更记忆的生命周期状态、固定标记、
 *           审计日志及合并回滚，状态全部持久化在 metadata 中（与向量库解耦）。
 *
 * 关键流程：
 *   1. query 获取目标记忆（scope 从第一条结果推导，或由调用方提供）
 *   2. 按 action 类型修改 metadata（lifecycleStatus / pinned / forgetLog / mergedFrom）
 *   3. delete + store 完成原子写入（LanceDB 不支持 upsert by id）
 *   4. 返回结果给 CLI / MCP
 */

import { computeContentHash } from "../processing/hash-utils.js";
import type { MemoryRepository } from "../core/service-types.js";
import type { MemoryRecord, MemoryScope } from "../core/types.js";
import {
  HIDDEN_FROM_RECALL,
  HUMAN_CONFIRMED_CONFIDENCE,
  REVOKE_UNDO_WINDOW_MS,
  type ForgetAction,
  type ForgetAuditEntry,
  type ForgetCommandInput,
  type ForgetCommandResult,
  type LifecycleStatus,
  type MergeSnapshot,
} from "./forget-types.js";

interface ForgetHandlerInput extends ForgetCommandInput {
  repository: MemoryRepository;
  /** 可选：提供 scope 加速查询（否则从记忆结果推导）。 */
  scope?: MemoryScope;
  /** 可选：重新计算向量时需要 embeddings port（纠错文本时可选）。 */
  embeddings?: { embed(text: string): Promise<number[]> };
}

export async function forgetCommand(input: ForgetHandlerInput): Promise<ForgetCommandResult> {
  const { repository, id, action, actor, reason, now = Date.now(), correction, scope, embeddings } = input;

  // Step 1: 获取目标记忆
  const existing = await fetchMemory(repository, id, scope);
  if (!existing) {
    throw new Error(`记忆不存在: ${id}`);
  }

  // Step 2: 按 action 修改
  const updated = { ...existing };
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  let applied = true;
  let message = "";
  let restoredIds: string[] | undefined;

  switch (action) {
    case "revoke": {
      const current = (updated.metadata.lifecycleStatus as LifecycleStatus | undefined) ?? "active";
      if (current === "revoked") {
        applied = false;
        message = `记忆 ${id} 已处于 revoked 状态，无需重复操作`;
        break;
      }
      before.lifecycleStatus = current;
      after.lifecycleStatus = "revoked";
      updated.metadata.lifecycleStatus = "revoked";
      message = `记忆已撤回（lifecycle: ${current} → revoked），7 天内可用 \`ms forget --undo ${id}\` 恢复`;
      break;
    }

    case "undo": {
      const current = updated.metadata.lifecycleStatus as LifecycleStatus | undefined;
      if (current !== "revoked") {
        throw new Error(`记忆 ${id} 当前状态为 ${current ?? "active"}，只能撤回 revoked 状态的记忆`);
      }
      const revokeLog = (updated.metadata.forgetLog as ForgetAuditEntry[] | undefined)?.find((log) => log.action === "revoke");
      if (!revokeLog) {
        throw new Error(`记忆 ${id} 缺少 revoke 审计日志，无法回滚`);
      }
      if (now - revokeLog.at > REVOKE_UNDO_WINDOW_MS) {
        throw new Error(`超出撤回回滚时间窗口（7 天），无法恢复记忆 ${id}`);
      }
      before.lifecycleStatus = "revoked";
      after.lifecycleStatus = "active";
      updated.metadata.lifecycleStatus = "active";
      message = `记忆已恢复为 active 状态`;
      break;
    }

    case "archive": {
      const current = (updated.metadata.lifecycleStatus as LifecycleStatus | undefined) ?? "active";
      if (current === "archived") {
        applied = false;
        message = `记忆 ${id} 已归档`;
        break;
      }
      before.lifecycleStatus = current;
      after.lifecycleStatus = "archived";
      updated.metadata.lifecycleStatus = "archived";
      message = `记忆已归档，不参与默认召回（可用 \`ms search --include-archived\` 检索）`;
      break;
    }

    case "restore": {
      const current = updated.metadata.lifecycleStatus as LifecycleStatus | undefined;
      if (current !== "archived") {
        throw new Error(`记忆 ${id} 当前状态为 ${current ?? "active"}，只能恢复归档记忆`);
      }
      before.lifecycleStatus = "archived";
      after.lifecycleStatus = "active";
      updated.metadata.lifecycleStatus = "active";
      message = `记忆已恢复为 active 状态`;
      break;
    }

    case "pin": {
      const current = updated.metadata.pinned;
      if (current === true) {
        applied = false;
        message = `记忆 ${id} 已固定`;
        break;
      }
      before.pinned = current;
      after.pinned = true;
      updated.metadata.pinned = true;
      message = `记忆已固定，强制进入必读层（使用 \`ms forget --unpin ${id}\` 取消）`;
      break;
    }

    case "unpin": {
      const current = updated.metadata.pinned;
      if (current !== true) {
        applied = false;
        message = `记忆 ${id} 未固定`;
        break;
      }
      before.pinned = true;
      after.pinned = false;
      updated.metadata.pinned = false;
      message = `记忆固定已取消`;
      break;
    }

    case "correct": {
      if (!correction || (!correction.text && !correction.type && !correction.scope)) {
        throw new Error(`纠错动作缺少纠错参数（--text / --type / --scope）`);
      }
      if (correction.text) {
        before.text = updated.text;
        after.text = correction.text;
        updated.text = correction.text;
        updated.contentHash = computeContentHash(correction.text);
        // 如果提供了 embeddings port，重新计算向量
        if (embeddings) {
          updated.vector = await embeddings.embed(correction.text);
        } else {
          // 清空向量，避免不一致
          delete updated.vector;
        }
      }
      if (correction.type) {
        before.kind = updated.kind;
        after.kind = correction.type;
        updated.kind = correction.type;
      }
      if (correction.scope) {
        // 当前简化实现：scope 作为元数据记录
        before.scopeMarker = updated.metadata.scopeMarker;
        after.scopeMarker = correction.scope;
        updated.metadata.scopeMarker = correction.scope;
      }
      // 纠错后置信度重置为「人工确认级」
      updated.metadata.confidence = HUMAN_CONFIRMED_CONFIDENCE;
      message = `记忆已纠错`;
      break;
    }

    case "rollback-merge": {
      const mergedFrom = updated.metadata.mergedFrom as MergeSnapshot[] | undefined;
      if (!mergedFrom || mergedFrom.length === 0) {
        throw new Error(`记忆 ${id} 不是合并记忆，无法回滚`);
      }
      // 恢复原始记忆
      const restored: MemoryRecord[] = mergedFrom.map((snapshot) => ({
        id: snapshot.id,
        scope: updated.scope,
        kind: updated.kind,
        text: snapshot.text,
        contentHash: snapshot.contentHash,
        importance: snapshot.importance,
        category: snapshot.category as never,
        dataType: updated.dataType,
        metadata: snapshot.metadata ?? {},
        provenance: updated.provenance,
        createdAt: snapshot.createdAt ?? now,
        vector: snapshot.vector,
      }));
      await repository.store(restored);
      restoredIds = restored.map((r) => r.id);
      // 删除合并记忆本身
      await repository.delete([id]);
      message = `合并已回滚，恢复 ${restoredIds.length} 条原始记忆: ${restoredIds.join(", ")}`;
      return {
        id,
        action,
        applied: true,
        message,
        restoredIds,
      };
    }

    default: {
      const _exhaustive: never = action;
      throw new Error(`未知的 forget 动作: ${_exhaustive}`);
    }
  }

  // Step 3: 追加审计日志（除幂等跳过外）
  if (applied) {
    const log = updated.metadata.forgetLog as ForgetAuditEntry[] | undefined ?? [];
    log.push({
      action,
      at: now,
      actor,
      reason,
      before: Object.keys(before).length > 0 ? before : undefined,
      after: Object.keys(after).length > 0 ? after : undefined,
    });
    updated.metadata.forgetLog = log;
    updated.updatedAt = now;
  }

  // Step 4: 原子写入（delete + store）
  if (applied) {
    await repository.delete([id]);
    await repository.store([updated]);
  }

  return {
    id,
    action,
    applied,
    lifecycleStatus: updated.metadata.lifecycleStatus as LifecycleStatus | undefined,
    pinned: updated.metadata.pinned as boolean | undefined,
    message,
  };
}

/** 辅助：从 repository 获取单个记忆。 */
async function fetchMemory(
  repository: MemoryRepository,
  id: string,
  scope?: MemoryScope
): Promise<MemoryRecord | undefined> {
  // 如果提供了 scope，直接查询
  if (scope) {
    const results = await repository.query({
      query: "",
      scope,
      limit: 1,
      minScore: 0,
    });
    const found = results.find((r) => r.id === id);
    if (found) {
      return found;
    }
  }

  // 没有 scope 或查询无果，尝试跨 scope 搜索（v0.1 简化：假设 repository 支持宽泛查询）
  // 实际实现中可能需要遍历所有可能的 scope 或使用专用的 getById 方法
  const fallbackScope: MemoryScope = {
    tenantId: "local",
    appId: "mengshu",
    userId: "default",
    projectId: "default",
    agentId: "default",
    namespace: "memories",
  };
  const results = await repository.query({
    query: "",
    scope: fallbackScope,
    limit: 100,
    minScore: 0,
  });
  return results.find((r) => r.id === id);
}
