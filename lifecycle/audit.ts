/**
 * Lifecycle audit helpers.
 *
 * 治理操作必须留下 scope、action、target 和 actor/reason 元数据，供 Console
 * 和后续持久化 audit repository 统一展示。
 */

import type { MemoryScope } from "../core/types.js";
import type { AuditRepository } from "../storage/repositories/types.js";

export interface AuditLifecycleInput {
  scope: MemoryScope;
  action: string;
  targetId?: string;
  actor?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export async function auditLifecycle(
  repository: AuditRepository,
  input: AuditLifecycleInput,
) {
  return repository.append({
    scope: input.scope,
    action: input.action,
    targetId: input.targetId,
    metadata: {
      ...(input.metadata ?? {}),
      actor: input.actor,
      reason: input.reason,
    },
  });
}
