/**
 * extract_graph handler 集成测试（P1-Q2）。
 *
 * 验证：
 * 1. handler 正确解析 job payload 并调用 extractGraphWithLlm
 * 2. LLM 成功时写入 graphRepository
 * 3. LLM 失败时记录 audit 并 fallback 到规则提取
 */

import { describe, test, expect, vi, beforeEach } from "vitest";
import type { JobRecord } from "../storage/repositories/types.js";
import type { LlmClient } from "../processing/llm-client.js";
import { InMemoryGraphRepository } from "./repository.js";
import { createExtractGraphHandler, enqueueExtractGraphJob } from "./extract-graph-handler.js";
import type { MemoryScope } from "../core/types.js";
import { InMemoryMemoryStore } from "../storage/repositories/in-memory.js";

const scope: MemoryScope = {
  tenantId: "local",
  appId: "openclaw",
  userId: "user-1",
  agentId: "agent-1",
  projectId: "project-1",
  namespace: "knowledge",
};

describe("createExtractGraphHandler (P1-Q2)", () => {
  let graphRepository: InMemoryGraphRepository;
  let auditCalls: Array<{
    scope: MemoryScope;
    action: string;
    targetId?: string;
    metadata?: Record<string, unknown>;
  }>;

  beforeEach(() => {
    graphRepository = new InMemoryGraphRepository();
    auditCalls = [];
  });

  test("LLM 成功时提取实体和关系并写入 graphRepository", async () => {
    const llmClient: LlmClient = {
      available: true,
      complete: vi.fn(),
      summarize: vi.fn(),
      extractStructured: vi.fn(async () => ({
        entities: [
          { name: "PostgreSQL", type: "tool", description: "数据库" },
          { name: "mengshu", type: "project", description: "记忆系统" },
        ],
        relations: [
          {
            subject: "mengshu",
            predicate: "uses",
            object: "PostgreSQL",
            evidence: "mengshu project uses PostgreSQL",
            confidence: 0.9,
          },
        ],
      })),
    } as unknown as LlmClient;

    const handler = createExtractGraphHandler({
      llmClient,
      graphRepository,
      audit: async (input) => {
        auditCalls.push(input);
      },
    });

    const job: JobRecord = {
      id: "job-1",
      type: "extract_graph",
      dedupeKey: "chunk-1",
      status: "queued",
      attempts: 0,
      payload: {
        chunkId: "chunk-1",
        text: "mengshu project uses PostgreSQL for storage and LanceDB for vectors.",
        scope: scope as unknown as Record<string, unknown>,
        context: { projectName: "mengshu" },
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await handler(job);

    // 验证实体已写入
    const entities = await graphRepository.findEntities({ scope });
    expect(entities.length).toBeGreaterThanOrEqual(2);
    const entityNames = entities.map((e) => e.displayName);
    expect(entityNames).toContain("PostgreSQL");
    expect(entityNames).toContain("mengshu");

    // 验证关系已写入
    const relations = await graphRepository.findRelations({ scope });
    expect(relations.length).toBeGreaterThan(0);
    const useRelation = relations.find((r) => r.predicate === "uses");
    expect(useRelation).toBeDefined();
    expect(useRelation?.confidence).toBe(0.9);

    // LLM 成功时不记录 audit
    expect(auditCalls).toHaveLength(0);
  });

  test("LLM 失败时记录 llm_extraction_failed audit 并 fallback 到规则提取", async () => {
    const llmClient: LlmClient = {
      available: true,
      complete: vi.fn(),
      summarize: vi.fn(),
      extractStructured: vi.fn(async () => {
        throw new Error("API rate limit exceeded");
      }),
    } as unknown as LlmClient;

    const handler = createExtractGraphHandler({
      llmClient,
      graphRepository,
      audit: async (input) => {
        auditCalls.push(input);
      },
    });

    const text = "mengshu project uses PostgreSQL and LanceDB for storage.";
    const job: JobRecord = {
      id: "job-2",
      type: "extract_graph",
      dedupeKey: "chunk-2",
      status: "queued",
      attempts: 0,
      payload: {
        chunkId: "chunk-2",
        text,
        scope: scope as unknown as Record<string, unknown>,
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await handler(job);

    // 验证 audit 被记录
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({
      scope,
      action: "llm_extraction_failed",
      targetId: "chunk-2",
      metadata: {
        textLength: text.length,
        error: "API rate limit exceeded",
        fallbackTo: "rule_based",
      },
    });

    // fallback 到规则提取，应该仍能提取实体（mengshu、PostgreSQL、LanceDB）
    const entities = await graphRepository.findEntities({ scope });
    expect(entities.length).toBeGreaterThan(0);
  });

  test("未提供 audit 钩子时 LLM 失败不抛错", async () => {
    const llmClient: LlmClient = {
      available: true,
      complete: vi.fn(),
      summarize: vi.fn(),
      extractStructured: vi.fn(async () => {
        throw new Error("Network timeout");
      }),
    } as unknown as LlmClient;

    // 不提供 audit 钩子
    const handler = createExtractGraphHandler({
      llmClient,
      graphRepository,
    });

    const job: JobRecord = {
      id: "job-3",
      type: "extract_graph",
      dedupeKey: "chunk-3",
      status: "queued",
      attempts: 0,
      payload: {
        chunkId: "chunk-3",
        text: "This is a test text with more than fifty characters to trigger LLM path.",
        scope: scope as unknown as Record<string, unknown>,
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // 应该不抛错，fallback 到规则提取
    await expect(handler(job)).resolves.not.toThrow();
  });

  test("job payload 缺少必要字段时抛错", async () => {
    const llmClient: LlmClient = {
      available: false,
      complete: vi.fn(),
      summarize: vi.fn(),
      extractStructured: vi.fn(),
    } as unknown as LlmClient;

    const handler = createExtractGraphHandler({
      llmClient,
      graphRepository,
    });

    const invalidJob: JobRecord = {
      id: "job-4",
      type: "extract_graph",
      dedupeKey: "chunk-4",
      status: "queued",
      attempts: 0,
      payload: {
        // 缺少 chunkId、text、scope
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await expect(handler(invalidJob)).rejects.toThrow("missing required payload fields");
  });
});

describe("enqueueExtractGraphJob", () => {
  test("正确 enqueue extract_graph job 到 JobRepository", async () => {
    const jobs = new InMemoryMemoryStore().jobs;

    const jobRecord = await enqueueExtractGraphJob(jobs, {
      chunkId: "chunk-1",
      text: "test text",
      scope,
      sourceId: "doc-1",
      context: { projectName: "mengshu" },
    });

    expect(jobRecord.type).toBe("extract_graph");
    expect(jobRecord.dedupeKey).toBe("extract_graph:chunk-1");
    expect(jobRecord.status).toBe("queued");
    expect(jobRecord.payload).toMatchObject({
      chunkId: "chunk-1",
      text: "test text",
      scope,
      sourceId: "doc-1",
      context: { projectName: "mengshu" },
    });

    // 验证 job 已入队
    const allJobs = await jobs.list("queued");
    expect(allJobs).toHaveLength(1);
    expect(allJobs[0].id).toBe(jobRecord.id);
  });

  test("相同 targetId 的 job 只入队一次（去重）", async () => {
    const jobs = new InMemoryMemoryStore().jobs;

    const job1 = await enqueueExtractGraphJob(jobs, {
      chunkId: "chunk-1",
      text: "text 1",
      scope,
    });

    const job2 = await enqueueExtractGraphJob(jobs, {
      chunkId: "chunk-1",
      text: "text 2",
      scope,
    });

    // 应该返回同一个 job（去重）
    expect(job1.id).toBe(job2.id);

    const allJobs = await jobs.list("queued");
    expect(allJobs).toHaveLength(1);
  });
});
