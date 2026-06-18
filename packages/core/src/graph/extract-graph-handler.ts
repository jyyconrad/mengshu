/**
 * extract_graph job 的 handler 工厂函数，供 daemon worker 注册使用。
 * 解析 job payload，调用 LLM 图谱提取，将结果持久化到图谱仓库。
 */

import type { JobRecord, JobRepository } from "../storage/repositories/types.js";
import type { LlmClient } from "../processing/llm-client.js";
import type { InMemoryGraphRepository } from "./repository.js";
import { extractGraphWithLlm } from "./llm-extractor.js";
import type { MemoryScope } from "../core/types.js";
import { enqueueUniqueJob } from "../ingest/jobs.js";

export interface ExtractGraphJobPayload {
  chunkId: string;
  text: string;
  /** MemoryScope 序列化后的对象 */
  scope: Record<string, unknown>;
  sourceId?: string;
  context?: {
    projectName?: string;
    userName?: string;
    agentName?: string;
  };
}

export interface EnqueueExtractGraphInput {
  chunkId: string;
  text: string;
  scope: MemoryScope;
  sourceId?: string;
  context?: ExtractGraphJobPayload["context"];
}

export function enqueueExtractGraphJob(
  jobs: JobRepository,
  input: EnqueueExtractGraphInput,
): Promise<JobRecord> {
  return enqueueUniqueJob(jobs, {
    type: "extract_graph",
    targetId: input.chunkId,
    payload: {
      chunkId: input.chunkId,
      text: input.text,
      scope: input.scope as unknown as Record<string, unknown>,
      ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
      ...(input.context !== undefined ? { context: input.context } : {}),
    },
  });
}

export interface ExtractGraphHandlerDeps {
  llmClient: LlmClient;
  graphRepository: InMemoryGraphRepository;
  /** 可选审计钩子：记录 LLM 提取失败事件。 */
  audit?(input: {
    scope: MemoryScope;
    action: string;
    targetId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

export function createExtractGraphHandler(deps: ExtractGraphHandlerDeps) {
  return async (job: JobRecord): Promise<void> => {
    const payload = job.payload as unknown as ExtractGraphJobPayload;
    const { chunkId, text, scope: rawScope } = payload;
    if (!chunkId || !text || !rawScope) {
      throw new Error(`extract_graph job ${job.id}: missing required payload fields`);
    }

    const scope = rawScope as unknown as MemoryScope;
    const createdAt = job.createdAt;

    const result = await extractGraphWithLlm(
      {
        scope,
        chunkId,
        text,
        sourceId: payload.sourceId,
        createdAt,
        context: payload.context,
        metadata: {},
      },
      {
        llmClient: deps.llmClient,
        audit: deps.audit,
      },
    );

    await deps.graphRepository.upsertEntities(result.entities);
    await deps.graphRepository.upsertRelations(result.relations);
  };
}
