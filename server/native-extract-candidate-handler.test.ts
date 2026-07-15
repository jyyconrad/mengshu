import { describe, expect, test, vi } from "vitest";

import {
  PostgresDurableJobV2EffectError,
} from "../packages/core/src/storage/repositories/postgres-job-v2-effect.js";
import {
  PostgresProvider,
  type PostgresDurableJobV2RuntimeBundle,
} from "../packages/core/src/db/providers/postgres.js";
import {
  createDurableJobHandlerRegistry,
  createDurableJobV2,
  deriveDurableJobV2DomainDedupeKey,
  leaseDurableJobV2,
  type DurableJobV2,
  type DurableJobV2Scope,
} from "../packages/core/src/storage/repositories/job-v2.js";
import type { TypeExtractor } from "../packages/core/src/lifecycle/type-extractor.js";
import { DurableJobV2HandlerFailure } from "./workers-v2.js";
import {
  createNativeExtractCandidateHandler,
} from "./native-extract-candidate-handler.js";

const scope: DurableJobV2Scope = {
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "mengshu",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "working-context",
  visibility: "private",
};

const extractor: TypeExtractor = {
  name: "native-fixture",
  async extract(input) {
    return [{
      text: input.text,
      semanticType: "rules",
      kind: "constraint",
      confidence: 0.95,
      reason: "fixture-rule",
      metadata: { source: "fixture", nested: { preserved: true } },
    }];
  },
};

function runningJob(payloadOverrides: Record<string, unknown> = {}): DurableJobV2 {
  const payload = {
    scope: { ...scope, workspaceId: "workspace-a", sessionId: "session-a" },
    text: "所有提交必须先完成测试验证。",
    traceId: "observation-1",
    intent: "auto",
    ...payloadOverrides,
  };
  const created = createDurableJobV2({
    id: "job-1",
    type: "extract_candidate",
    payload,
    dedupeKey: deriveDurableJobV2DomainDedupeKey("extract_candidate", String(payload.traceId), {
      workspaceId: "workspace-a", sessionId: "session-a",
    }),
    scope,
    maxAttempts: 3,
  }, {
    registry: createDurableJobHandlerRegistry(["extract_candidate"]),
    now: 100,
  });
  return leaseDurableJobV2(created, {
    owner: "worker-a",
    now: 110,
    leaseMs: 1_000,
    tokenFactory: () => "secret-lease-token-that-must-not-escape-123",
  }).job;
}

interface HarnessOptions {
  readonly stale?: boolean;
  readonly connectError?: Error;
}

function createBundleHarness(options: HarnessOptions = {}): {
  readonly bundle: PostgresDurableJobV2RuntimeBundle;
  readonly pool: { readonly connect: ReturnType<typeof vi.fn> };
  readonly calls: Array<{ readonly sql: string; readonly params: readonly unknown[] }>;
} {
  let priorReceipt: Record<string, unknown> | undefined;
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const client = {
    release: vi.fn(),
    query: vi.fn(async <Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ) => {
      const normalized = sql.trim().replace(/\s+/g, " ");
      calls.push({ sql: normalized, params });
      if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
        return { rows: [] as Row[], rowCount: 0 };
      }
      if (/SELECT id FROM mengshu_jobs_v2/.test(normalized)) {
        return {
          rows: (options.stale ? [] : [{ id: "job-1" }]) as unknown as Row[],
          rowCount: options.stale ? 0 : 1,
        };
      }
      if (/SELECT job_id, effect_key/.test(normalized)) {
        return {
          rows: (priorReceipt ? [priorReceipt] : []) as Row[],
          rowCount: priorReceipt ? 1 : 0,
        };
      }
      if (/SELECT pg_advisory_xact_lock/.test(normalized)) {
        return { rows: [{ pg_advisory_xact_lock: null } as unknown as Row], rowCount: 1 };
      }
      if (/SELECT COUNT\(\*\).*FROM mengshu_candidates/.test(normalized)) {
        return { rows: [{ pending_count: "0" } as unknown as Row], rowCount: 1 };
      }
      if (/INSERT INTO mengshu_candidates/.test(normalized)) {
        return { rows: [] as Row[], rowCount: 1 };
      }
      if (/INSERT INTO mengshu_job_v2_effect_receipts/.test(normalized)) {
        priorReceipt = {
          job_id: "job-1",
          effect_key: String(params[1]),
          request_fingerprint: String(params[2]),
          lease_generation: 1,
          result: JSON.parse(String(params[4])),
          committed_at: 500,
        };
        return { rows: [priorReceipt as Row], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${normalized}`);
    }),
  };
  const pool = {
    query: vi.fn(),
    connect: vi.fn(async () => {
      if (options.connectError) throw options.connectError;
      return client;
    }),
    end: vi.fn(),
  };
  const provider = new PostgresProvider({
    host: "unused", port: 5432, database: "unused", user: "unused", password: "unused",
  }, "text-embedding-3-small");
  Object.assign(provider as unknown as Record<string, unknown>, {
    pool,
    schemaVersion: 8,
    schemaContractState: "ready",
  });
  return {
    bundle: provider.createDurableJobV2RuntimeBundle({
      clock: () => 500,
      tokenFactory: () => "t".repeat(32),
      backoffMs: () => 100,
      effectClock: () => 500,
    }),
    pool,
    calls,
  };
}

describe("native extract_candidate durable handler", () => {
  test("工厂只接受真实 provider-owned runtime bundle", () => {
    const real = createBundleHarness().bundle;
    expect(() => createNativeExtractCandidateHandler({
      runtimeBundle: { ...real } as PostgresDurableJobV2RuntimeBundle,
      computation: { extractor },
    })).toThrow(/runtime|bundle|capability/i);
  });

  test("真实 bundle 仍拒绝缺失的计算依赖", () => {
    const real = createBundleHarness().bundle;
    expect(() => createNativeExtractCandidateHandler({
      runtimeBundle: real,
      computation: {} as never,
    })).toThrow(/computation dependencies/i);
  });

  test.each([
    "bad extractor",
    "bad\u0085extractor",
    "bad\ud800extractor",
    "x".repeat(257),
  ])("extractor.name 使用 durable-v2 统一 safe identifier：%j", (name) => {
    const real = createBundleHarness().bundle;
    expect(() => createNativeExtractCandidateHandler({
      runtimeBundle: real,
      computation: { extractor: { name, extract: vi.fn(async () => []) } },
    })).toThrow(/computation dependencies/i);
  });

  test("事务外完成纯计算，再把 job fence、9D scope、稳定 ID 与完整 metadata 原子持久化", async () => {
    const harness = createBundleHarness();
    const handler = createNativeExtractCandidateHandler({
      runtimeBundle: harness.bundle,
      computation: { extractor },
    });

    const result = await handler(runningJob(), {
      signal: new AbortController().signal,
      workerId: "worker-a",
    });

    expect(result).toMatchObject({
      status: "applied",
      created: 1,
      duplicateCount: 0,
      capacityRejectedCount: 0,
      candidateIds: [expect.stringMatching(/^candidate_[0-9a-f]{64}$/)],
    });
    const candidateCall = harness.calls.find(({ sql }) => /INSERT INTO mengshu_candidates/.test(sql));
    expect(candidateCall).toBeDefined();
    expect(candidateCall!.params.slice(1, 11)).toEqual([
      "tenant-a", "user-a", "mengshu", "project-a", "agent-a", "working-context",
      "private", "workspace-a", "session-a", "job-1",
    ]);
    expect(candidateCall!.params[0]).toBe((result as { candidateIds: string[] }).candidateIds[0]);
    expect(candidateCall!.params[18]).toBe(JSON.stringify(["observation-1"]));
    expect(JSON.parse(String(candidateCall!.params[22]))).toMatchObject({
      computation: { source: "fixture", nested: { preserved: true } },
      audit: { semanticType: "rules" },
      evidence: { quote: "所有提交必须先完成测试验证。", eventIds: ["observation-1"] },
    });
    expect(harness.calls.map(({ sql }) => sql)).toEqual([
      "BEGIN",
      expect.stringMatching(/SELECT id FROM mengshu_jobs_v2/),
      expect.stringMatching(/SELECT job_id, effect_key/),
      "SELECT pg_advisory_xact_lock($1, $2)",
      expect.stringMatching(/SELECT COUNT\(\*\).*FROM mengshu_candidates/),
      expect.stringMatching(/INSERT INTO mengshu_candidates/),
      expect.stringMatching(/INSERT INTO mengshu_job_v2_effect_receipts/),
      "COMMIT",
    ]);
  });

  test("同一 job 重算使用稳定 candidate ID，并由固定 receipt replay 原结果", async () => {
    const harness = createBundleHarness();
    const handler = createNativeExtractCandidateHandler({
      runtimeBundle: harness.bundle,
      computation: { extractor },
    });
    const context = { signal: new AbortController().signal, workerId: "worker-a" };

    const first = await handler(runningJob(), context) as { candidateIds: readonly string[] };
    const replay = await handler(runningJob(), context);

    expect(replay).toMatchObject({ status: "replayed", candidateIds: first.candidateIds });
    expect(harness.calls.filter(({ sql }) => /INSERT INTO mengshu_candidates/.test(sql)))
      .toHaveLength(1);
  });

  test("零候选仍提交可 replay 的固定 receipt", async () => {
    const harness = createBundleHarness();
    const emptyExtractor: TypeExtractor = { name: "empty", extract: vi.fn(async () => []) };
    const handler = createNativeExtractCandidateHandler({
      runtimeBundle: harness.bundle,
      computation: { extractor: emptyExtractor },
    });
    const context = { signal: new AbortController().signal, workerId: "worker-a" };

    await expect(handler(runningJob(), context)).resolves.toEqual({
      status: "applied", created: 0, duplicateCount: 0, capacityRejectedCount: 0, candidateIds: [],
    });
    await expect(handler(runningJob(), context)).resolves.toEqual({
      status: "replayed", created: 0, duplicateCount: 0, capacityRejectedCount: 0, candidateIds: [],
    });
    expect(harness.calls.some(({ sql }) => /INSERT INTO mengshu_job_v2_effect_receipts/.test(sql)))
      .toBe(true);
    expect(harness.calls.some(({ sql }) => /INSERT INTO mengshu_candidates/.test(sql)))
      .toBe(false);
  });

  test("stale fence 映射固定 retryable HandlerFailure，且不写 candidate/receipt", async () => {
    const harness = createBundleHarness({ stale: true });
    const handler = createNativeExtractCandidateHandler({
      runtimeBundle: harness.bundle,
      computation: { extractor },
    });

    await expect(handler(runningJob(), {
      signal: new AbortController().signal,
      workerId: "worker-a",
    })).rejects.toEqual(
      new DurableJobV2HandlerFailure("EXTRACT_CANDIDATE_EFFECT_STALE", true),
    );
    expect(harness.calls.some(({ sql }) => /INSERT INTO mengshu_(?:candidates|job_v2_effect_receipts)/.test(sql)))
      .toBe(false);
  });

  test.each([
    ["DURABLE_JOB_EFFECT_OUTCOME_UNCERTAIN", true, "EXTRACT_CANDIDATE_EFFECT_RETRYABLE"],
    ["DURABLE_JOB_EFFECT_LEASE_LOST", true, "EXTRACT_CANDIDATE_EFFECT_RETRYABLE"],
    ["DURABLE_JOB_EFFECT_FINGERPRINT_MISMATCH", false, "EXTRACT_CANDIDATE_EFFECT_REJECTED"],
    ["DURABLE_JOB_EFFECT_INVALID_RECEIPT", false, "EXTRACT_CANDIDATE_EFFECT_REJECTED"],
  ] as const)("typed provider error %s 脱敏映射 retryable=%s", async (code, retryable, expectedCode) => {
    const secret = "postgres://admin:secret@private-host/internal";
    const error = new PostgresDurableJobV2EffectError(code, secret);
    const harness = createBundleHarness({ connectError: error });
    const handler = createNativeExtractCandidateHandler({
      runtimeBundle: harness.bundle,
      computation: { extractor },
    });

    const caught = await handler(runningJob(), {
      signal: new AbortController().signal,
      workerId: "worker-a",
    }).catch((value: unknown) => value);
    expect(caught).toEqual(new DurableJobV2HandlerFailure(expectedCode, retryable));
    expect(JSON.stringify(caught)).not.toContain(secret);
    expect((caught as Error).message).toBe("Durable job handler failed");
  });

  test("计算期间 abort 原样终止，effect capability 与数据库均不触达", async () => {
    const harness = createBundleHarness();
    const controller = new AbortController();
    const abortingExtractor: TypeExtractor = {
      name: "abort-fixture",
      async extract() {
        controller.abort(new DOMException("stop", "AbortError"));
        return [];
      },
    };
    const handler = createNativeExtractCandidateHandler({
      runtimeBundle: harness.bundle,
      computation: { extractor: abortingExtractor },
    });

    await expect(handler(runningJob(), {
      signal: controller.signal,
      workerId: "worker-a",
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(harness.pool.connect).not.toHaveBeenCalled();
    expect(harness.calls).toEqual([]);
  });

  test("进入 handler 前已 abort 时构造标准 AbortError，零计算与 DB 访问", async () => {
    const harness = createBundleHarness();
    const guardedExtractor: TypeExtractor = { name: "guarded", extract: vi.fn(async () => []) };
    const handler = createNativeExtractCandidateHandler({
      runtimeBundle: harness.bundle,
      computation: { extractor: guardedExtractor },
    });
    const controller = new AbortController();
    controller.abort("plain-stop-reason");

    await expect(handler(runningJob(), {
      signal: controller.signal,
      workerId: "worker-a",
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(guardedExtractor.extract).not.toHaveBeenCalled();
    expect(harness.pool.connect).not.toHaveBeenCalled();
  });

  test("计算异常与未知 provider 异常分别使用固定脱敏 failure", async () => {
    const computationHarness = createBundleHarness();
    const computationHandler = createNativeExtractCandidateHandler({
      runtimeBundle: computationHarness.bundle,
      computation: {
        extractor: {
          name: "broken",
          async extract() { throw new Error("secret computation detail"); },
        },
      },
    });
    const context = { signal: new AbortController().signal, workerId: "worker-a" };
    await expect(computationHandler(runningJob(), context)).rejects.toEqual(
      new DurableJobV2HandlerFailure("EXTRACT_CANDIDATE_COMPUTATION_FAILED", true),
    );
    expect(computationHarness.pool.connect).not.toHaveBeenCalled();

    const providerHarness = createBundleHarness({
      connectError: new Error("postgres://admin:secret@private-host/internal"),
    });
    const providerHandler = createNativeExtractCandidateHandler({
      runtimeBundle: providerHarness.bundle,
      computation: { extractor },
    });
    const caught = await providerHandler(runningJob(), context).catch((error: unknown) => error);
    expect(caught).toEqual(
      new DurableJobV2HandlerFailure("EXTRACT_CANDIDATE_EFFECT_RETRYABLE", true),
    );
    expect(JSON.stringify(caught)).not.toMatch(/secret|private-host|admin/);
  });

  test("LLM fallback 审计原因随 computation/audit metadata 一并保留", async () => {
    const harness = createBundleHarness();
    const handler = createNativeExtractCandidateHandler({
      runtimeBundle: harness.bundle,
      computation: {
        extractor,
        llmClient: {
          available: true,
          async complete() { throw new Error("unused"); },
          async summarize() { throw new Error("unused"); },
          async extractStructured() { throw new Error("provider unavailable"); },
        },
      },
    });

    await handler(runningJob(), {
      signal: new AbortController().signal,
      workerId: "worker-a",
    });
    const candidateCall = harness.calls.find(({ sql }) => /INSERT INTO mengshu_candidates/.test(sql));
    expect(JSON.parse(String(candidateCall!.params[22]))).toMatchObject({
      fallbackReason: "llm_extraction_failed",
      computation: { source: "fixture" },
      audit: { semanticType: "rules" },
    });
  });

  test.each([
    ["unsafe kind", { kind: "bad kind", metadata: {} }],
    ["unsafe metadata", { kind: "constraint", metadata: { "bad\u0000key": "value" } }],
  ])("%s 在 DB 前经 canonical output gate 拒绝为 non-retryable", async (_label, output) => {
    const harness = createBundleHarness();
    const unsafeExtractor: TypeExtractor = {
      name: "unsafe-output-fixture",
      async extract(input) {
        return [{
          text: input.text,
          semanticType: "rules",
          kind: output.kind,
          confidence: 0.95,
          reason: "fixture-rule",
          metadata: output.metadata,
        }];
      },
    };
    const handler = createNativeExtractCandidateHandler({
      runtimeBundle: harness.bundle,
      computation: { extractor: unsafeExtractor },
    });

    await expect(handler(runningJob(), {
      signal: new AbortController().signal,
      workerId: "worker-a",
    })).rejects.toEqual(
      new DurableJobV2HandlerFailure("EXTRACT_CANDIDATE_OUTPUT_INVALID", false),
    );
    expect(harness.pool.connect).not.toHaveBeenCalled();
    expect(harness.calls).toEqual([]);
  });

  test.each([51, 200])(
    "D-02 每 session 从 %i 条确定性保留前 50 条，记录截断审计且 replay 不扩大事务",
    async (candidateCount) => {
    const texts = Array.from(
      { length: candidateCount },
      (_, index) => `规则 ${String(index).padStart(3, "0")}：所有提交必须先完成测试验证。`,
    );
    const inputText = texts.join("\n");
    const batchExtractor: TypeExtractor = {
      name: "batch-fixture",
      async extract() {
        return texts.map((text, index) => ({
          text,
          semanticType: "rules" as const,
          kind: "constraint",
          confidence: 0.95,
          reason: `fixture-${index}`,
          metadata: { sourceIndex: index },
        }));
      },
    };
    const harness = createBundleHarness();
    const handler = createNativeExtractCandidateHandler({
      runtimeBundle: harness.bundle,
      computation: { extractor: batchExtractor },
    });
    const job = runningJob({ text: inputText });
    const context = { signal: new AbortController().signal, workerId: "worker-a" };

    const applied = await handler(job, context) as {
      status: string;
      candidateIds: readonly string[];
    };
    const replayed = await handler(job, context);

    expect(applied.status).toBe("applied");
    expect(applied.candidateIds).toHaveLength(50);
    expect(new Set(applied.candidateIds).size).toBe(50);
    expect(replayed).toMatchObject({ status: "replayed", candidateIds: applied.candidateIds });
    const inserts = harness.calls.filter(({ sql }) => /INSERT INTO mengshu_candidates/.test(sql));
    expect(inserts).toHaveLength(50);
    expect(inserts.map(({ params }) => params[13])).toEqual(texts.slice(0, 50));
    expect(applied).toMatchObject({ capacityRejectedCount: candidateCount - 50 });
    expect(JSON.parse(String(inserts[0].params[22]))).toMatchObject({
      computation: { sourceIndex: 0 },
    });
    expect(JSON.parse(String(inserts[49].params[22]))).toMatchObject({
      computation: { sourceIndex: 49 },
    });
    expect(JSON.stringify(inserts)).not.toContain(texts[50]);
    },
  );

  test("非法 contract/lease 映射固定 non-retryable failure，不执行计算或持久化", async () => {
    const harness = createBundleHarness();
    const guardedExtractor: TypeExtractor = { name: "guarded", extract: vi.fn(async () => []) };
    const handler = createNativeExtractCandidateHandler({
      runtimeBundle: harness.bundle,
      computation: { extractor: guardedExtractor },
    });
    const invalid = { ...runningJob(), leaseOwner: undefined } as DurableJobV2;

    await expect(handler(invalid, {
      signal: new AbortController().signal,
      workerId: "worker-a",
    })).rejects.toEqual(
      new DurableJobV2HandlerFailure("EXTRACT_CANDIDATE_INVALID_JOB", false),
    );
    expect(guardedExtractor.extract).not.toHaveBeenCalled();
    expect(harness.pool.connect).not.toHaveBeenCalled();
  });
});
