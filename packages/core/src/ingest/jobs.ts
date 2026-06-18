/**
 * Ingestion job helpers.
 *
 * Job 的持久语义由 `JobRepository` 提供，这里只统一 dedupe key 约定，
 * 让 ingestion pipeline、workers 和后续文件系统 adapter 使用同一规则。
 *
 * 评审问题 #6 修复：
 * - dedupe key 支持可选 schemaVersion，但默认采用 reuse-compatible 策略
 *   （schemaVersion 不进入 key），避免 prompt 微调/LLM 升级触发全量重算。
 * - 仅当 schema 不兼容变更时，调用方显式传入 forceSchemaVersion 触发重新 enqueue。
 */

import type { JobRecord, JobRepository } from "../storage/repositories/types.js";

export interface EnqueueUniqueJobInput {
  type: string;
  targetId: string;
  payload: Record<string, unknown>;
  /**
   * 可选 schema 版本。默认不进入 dedupe key（reuse-compatible 模式），
   * 只有在 schema 不兼容变更时才传入，强制旧 job 失效并重新 enqueue。
   */
  forceSchemaVersion?: string;
}

export function jobDedupeKey(
  type: string,
  targetId: string,
  forceSchemaVersion?: string,
): string {
  // reuse-compatible：默认不带 schemaVersion，复用历史结果。
  // schema 不兼容变更时带上版本，使 key 改变从而重新 enqueue。
  return forceSchemaVersion
    ? `${type}:${targetId}:v${forceSchemaVersion}`
    : `${type}:${targetId}`;
}

export function enqueueUniqueJob(
  repository: JobRepository,
  input: EnqueueUniqueJobInput,
): Promise<JobRecord> {
  return repository.enqueue({
    type: input.type,
    payload: input.payload,
    dedupeKey: jobDedupeKey(input.type, input.targetId, input.forceSchemaVersion),
  });
}
