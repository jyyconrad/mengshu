/**
 * Retention and TTL sweep helpers.
 *
 * 只生成可审计删除计划并通过 MemoryService 删除；调用方负责配置 TTL 和定时执行。
 */

import type { MemoryService } from "../domain/service-types.js";
import type { MemoryScope } from "../domain/types.js";
import type { AuditRepository } from "../storage/repositories/types.js";
import { auditLifecycle } from "./audit.js";

export interface RetentionSweepInput {
  scope: MemoryScope;
  olderThanMs: number;
  now: number;
  service: MemoryService;
  audit: AuditRepository;
  actor?: string;
}

export async function retentionSweep(input: RetentionSweepInput) {
  const cutoff = input.now - input.olderThanMs;
  const result = await input.service.delete({
    filter: {
      scope: input.scope,
      createdAt: { $lt: cutoff },
    },
  });
  await auditLifecycle(input.audit, {
    scope: input.scope,
    action: "retention_sweep",
    actor: input.actor,
    reason: `createdAt < ${cutoff}`,
    metadata: {
      deleted: result.deleted,
      cutoff,
    },
  });
  return {
    cutoff,
    deleted: result.deleted,
  };
}
