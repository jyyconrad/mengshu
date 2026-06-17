/**
 * Agent 上下文服务的共享构造 helper。
 *
 * 本文件做什么：把 cli-project 与 cli-doctor 共用的 AgentFastPathService 构造逻辑提取出来，
 * 避免在多个 CLI 模块里重复实现 loadRecordsForScope / recall 适配。
 *
 * 核心流程：
 * 1. extractRecords：从 recall 命中里筛出形态合法的 MemoryRecord（含 text/category）。
 * 2. buildAgentService：基于 MemoryService.recall 构造 AgentFastPathService，供 context/lookup 复用。
 *
 * 关键边界：
 * - 不持有任何状态，纯构造；embedding 不可用时 recall 抛错由调用方降级处理。
 * - 不修改入参，返回新对象。
 */

import { AgentFastPathService } from "../../api/agent-fast-path.js";
import type { MemoryService } from "../../core/service-types.js";
import type { MemoryRecord, MemoryScope } from "../../core/types.js";

/** 从 recall 命中里筛出形态合法的 MemoryRecord（需含 text/category）。 */
export function extractRecords(hits: Array<{ record: unknown }>): MemoryRecord[] {
  const records: MemoryRecord[] = [];
  for (const hit of hits) {
    const record = hit.record;
    if (record && typeof record === "object" && "text" in record && "category" in record) {
      records.push(record as MemoryRecord);
    }
  }
  return records;
}

/** 基于 MemoryService.recall 构造 AgentFastPathService，供 context/lookup 复用。 */
export function buildAgentService(scope: MemoryScope, task: string, service: MemoryService): AgentFastPathService {
  return new AgentFastPathService({
    loadRecordsForScope: async (resolvedScope) => {
      const result = await service.recall({ query: task, scope: resolvedScope, limit: 50, minScore: 0.1 });
      return extractRecords(result.hits);
    },
    recall: async (resolvedScope, query, opts) =>
      service.recall({ query, scope: resolvedScope, limit: opts?.limit ?? 10, minScore: opts?.minScore ?? 0.1 }),
    defaultScope: scope,
  });
}
