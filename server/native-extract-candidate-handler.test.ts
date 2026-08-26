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
import type { CandidateWriteMaterializerDependencies } from
  "../packages/core/src/lifecycle/candidate-write-materializer.js";
import type { CandidateEvidenceReadPort } from
  "../packages/core/src/lifecycle/postgres-candidate-evidence-read-port.js";
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

const materialization: CandidateWriteMaterializerDependencies = {
  resolveMaxSimilarity: vi.fn(async () => 0.2),
  embed: vi.fn(async () => [0.1, 0.2]),
  scoreImportance: vi.fn(async () => 0.37),
  exactDedup: vi.fn(async () => ({ duplicate: false })),
  semanticDedup: vi.fn(async () => ({ duplicate: false })),
  stampMetadata: (metadata) => ({
    ...metadata,
    embeddingSpaceId: `embedding-space:v1:${"a".repeat(64)}`,
    embeddingSpaceState: "known-queryable",
  }),
};

const evidenceRead: CandidateEvidenceReadPort = {
  async readAuthoritativeEvidenceFacts(input) {
    return input.evidenceIds.map((evidenceId) => Object.freeze({
      evidenceId,
      sourceKind: "session_user" as const,
    }));
  },
};

function createHandler(
  input: Omit<
    Parameters<typeof createNativeExtractCandidateHandler>[0],
    "materialization" | "evidenceRead" | "deriveCommittedActive"
  >,
) {
  return createNativeExtractCandidateHandler({
    ...input,
    materialization,
    evidenceRead,
    deriveCommittedActive: async () => undefined,
  });
}

function runningJob(payloadOverrides: Record<string, unknown> = {}): DurableJobV2 {
  const payload = {
    scope: { ...scope, workspaceId: "workspace-a", sessionId: "session-a" },
    text: "TypeScript 提交必须先运行 npm test 完成测试验证。",
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
      if (/INSERT INTO "memories"/.test(normalized)) {
        return { rows: [{ id: String(params[0]) } as unknown as Row], rowCount: 1 };
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
    schemaVersion: 14,
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
    expect(() => createHandler({
      runtimeBundle: { ...real } as PostgresDurableJobV2RuntimeBundle,
      computation: { extractor },
    })).toThrow(/runtime|bundle|capability/i);
  });

  test("真实 bundle 仍拒绝缺失的计算依赖", () => {
    const real = createBundleHarness().bundle;
    expect(() => createHandler({
      runtimeBundle: real,
      computation: {} as never,
    })).toThrow(/computation dependencies/i);
  });

  test("生产 handler 缺少 authoritative evidence read port 时构造即 fail-closed", () => {
    expect(() => createNativeExtractCandidateHandler({
      runtimeBundle: createBundleHarness().bundle,
      computation: { extractor },
      materialization,
      deriveCommittedActive: async () => undefined,
    } as never)).toThrow(/evidence read/i);
  });

  test("计算前按完整 9D scope hydrate persisted evidence facts", async () => {
    const harness = createBundleHarness();
    const readAuthoritativeEvidenceFacts = vi.fn(evidenceRead.readAuthoritativeEvidenceFacts);
    const extracting = vi.fn(extractor.extract);
    const handler = createNativeExtractCandidateHandler({
      runtimeBundle: harness.bundle,
      computation: { extractor: { ...extractor, extract: extracting } },
      materialization,
      evidenceRead: { readAuthoritativeEvidenceFacts },
      deriveCommittedActive: async () => undefined,
    });
    const signal = new AbortController().signal;

    await handler(runningJob(), { signal, workerId: "worker-a" });

    expect(readAuthoritativeEvidenceFacts).toHaveBeenCalledWith({
      evidenceIds: ["observation-1"],
      scope: { ...scope, workspaceId: "workspace-a", sessionId: "session-a" },
      signal,
    });
    expect(extracting).toHaveBeenCalledOnce();
    expect(materialization.resolveMaxSimilarity).toHaveBeenCalledWith(expect.objectContaining({
      text: "TypeScript 提交必须先运行 npm test 完成测试验证。",
      kind: "constraint",
      semanticType: "rules",
      scope: { ...scope, workspaceId: "workspace-a", sessionId: "session-a" },
      signal,
    }));
    const candidateCall = harness.calls.find(({ sql }) => /INSERT INTO mengshu_candidates/.test(sql));
    expect(JSON.parse(String(candidateCall!.params[22]))).toMatchObject({
      computation: {
        confidenceBreakdown: {
          evidences: [{ evidenceId: "observation-1", sourceKind: "session_user" }],
        },
        valueSignalProvenance: {
          mode: "authoritative",
          sourceKind: "session_user",
          maxSimilarity: 0.2,
        },
      },
    });
  });

  test("evidence hydration 失败时不执行 extractor 或数据库 effect", async () => {
    const harness = createBundleHarness();
    const extracting = vi.fn(extractor.extract);
    const handler = createNativeExtractCandidateHandler({
      runtimeBundle: harness.bundle,
      computation: { extractor: { ...extractor, extract: extracting } },
      materialization,
      evidenceRead: {
        readAuthoritativeEvidenceFacts: async () => {
          throw new Error("postgres://admin:secret@private-host/internal");
        },
      },
      deriveCommittedActive: async () => undefined,
    });

    const caught = await handler(runningJob(), {
      signal: new AbortController().signal,
      workerId: "worker-a",
    }).catch((error: unknown) => error);

    expect(caught).toEqual(
      new DurableJobV2HandlerFailure("EXTRACT_CANDIDATE_EVIDENCE_RETRYABLE", true),
    );
    expect(extracting).not.toHaveBeenCalled();
    expect(harness.pool.connect).not.toHaveBeenCalled();
    expect(JSON.stringify(caught)).not.toMatch(/secret|private-host|admin/);
  });

  test("生产组合缺 materialization 依赖时固定 fail-closed，且不连接数据库", async () => {
    const harness = createBundleHarness();
    const handler = createNativeExtractCandidateHandler({
      runtimeBundle: harness.bundle,
      computation: { extractor },
      evidenceRead,
    });

    await expect(handler(runningJob(), {
      signal: new AbortController().signal,
      workerId: "worker-a",
    })).rejects.toEqual(
      new DurableJobV2HandlerFailure("EXTRACT_CANDIDATE_MATERIALIZATION_UNAVAILABLE", false),
    );
    expect(harness.pool.connect).not.toHaveBeenCalled();
  });

  test.each([
    "bad extractor",
    "bad\u0085extractor",
    "bad\ud800extractor",
    "x".repeat(257),
  ])("extractor.name 使用 durable-v2 统一 safe identifier：%j", (name) => {
    const real = createBundleHarness().bundle;
    expect(() => createHandler({
      runtimeBundle: real,
      computation: { extractor: { name, extract: vi.fn(async () => []) } },
    })).toThrow(/computation dependencies/i);
  });

  test("事务外完成纯计算，再把 job fence、9D scope、稳定 ID 与完整 metadata 原子持久化", async () => {
    const harness = createBundleHarness();
    const handler = createHandler({
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
      computation: {
        source: "fixture",
        nested: { preserved: true },
        admission: "candidate",
      },
      audit: { semanticType: "rules", admission: "candidate" },
      evidence: {
        quote: "TypeScript 提交必须先运行 npm test 完成测试验证。",
        eventIds: ["observation-1"],
      },
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

  test("candidate_low_priority 与 candidate 是唯一允许写入候选表的 admission 路由", async () => {
    const harness = createBundleHarness();
    const lowPriorityExtractor: TypeExtractor = {
      name: "low-priority-fixture",
      async extract(input) {
        return [{
          text: input.text,
          semanticType: "task_context",
          kind: "task",
          confidence: 0.3,
          reason: "fixture-low-priority",
          metadata: {},
        }];
      },
    };
    const handler = createHandler({
      runtimeBundle: harness.bundle,
      computation: { extractor: lowPriorityExtractor },
    });

    await expect(handler(runningJob({ text: "项目使用 TypeScript 5.6。" }), {
      signal: new AbortController().signal,
      workerId: "worker-a",
    })).resolves.toMatchObject({ status: "applied", created: 1 });

    const candidateCall = harness.calls.find(({ sql }) => /INSERT INTO mengshu_candidates/.test(sql));
    expect(candidateCall).toBeDefined();
    expect(JSON.parse(String(candidateCall!.params[22]))).toMatchObject({
      computation: { admission: "candidate_low_priority" },
      audit: { admission: "candidate_low_priority" },
    });
  });

  test.each([
    ["active", extractor, { intent: "remember" }],
    ["evidence_only", {
      name: "evidence-only-fixture",
      async extract(input: Parameters<TypeExtractor["extract"]>[0]) {
        return [{
          text: input.text,
          semanticType: "experience" as const,
          kind: "decision",
          confidence: 0.8,
          reason: "fixture-evidence",
          hasWhy: false,
        }];
      },
    } satisfies TypeExtractor, { text: "TypeScript 项目使用 pnpm workspace 管理依赖。" }],
  ] as const)(
    "%s 由 records effect 持久化为受控 memory",
    async (route, routedExtractor, payloadOverrides) => {
      const harness = createBundleHarness();
      const handler = createHandler({
        runtimeBundle: harness.bundle,
        computation: { extractor: routedExtractor },
      });

      const result = await handler(runningJob(payloadOverrides), {
        signal: new AbortController().signal,
        workerId: "worker-a",
      });
      expect(result).toMatchObject({
        status: "applied",
        created: 1,
        candidateIds: [],
        memoryIds: [expect.stringMatching(/^[0-9a-f-]{36}$/)],
        activeMemoryIds: route === "active" ? [expect.stringMatching(/^[0-9a-f-]{36}$/)] : [],
      });
      expect(harness.calls.filter(({ sql }) => /INSERT INTO "memories"/.test(sql))).toHaveLength(1);
      expect(harness.calls.filter(({ sql }) => sql === "BEGIN")).toHaveLength(1);
      expect(harness.calls.filter(({ sql }) => sql === "COMMIT")).toHaveLength(1);
    },
  );

  test("active effect applied/replayed 后只把 receipt 权威 ID 与完整 scope 交给 committed 派生", async () => {
    const harness = createBundleHarness();
    const deriveCommittedActive = vi.fn(async () => undefined);
    const handler = createNativeExtractCandidateHandler({
      runtimeBundle: harness.bundle,
      computation: { extractor },
      materialization,
      evidenceRead,
      deriveCommittedActive,
    });
    const job = runningJob({ intent: "remember" });
    const context = { signal: new AbortController().signal, workerId: "worker-a" };

    const applied = await handler(job, context) as { activeMemoryIds: readonly string[] };
    const replayed = await handler(job, context) as { activeMemoryIds: readonly string[] };

    expect(applied.activeMemoryIds).toHaveLength(1);
    expect(replayed.activeMemoryIds).toEqual(applied.activeMemoryIds);
    expect(deriveCommittedActive).toHaveBeenCalledTimes(2);
    expect(deriveCommittedActive).toHaveBeenNthCalledWith(1, {
      scope,
      context: { workspaceId: "workspace-a", sessionId: "session-a" },
      activeMemoryIds: applied.activeMemoryIds,
      signal: context.signal,
    });
    expect(deriveCommittedActive).toHaveBeenNthCalledWith(2, {
      scope,
      context: { workspaceId: "workspace-a", sessionId: "session-a" },
      activeMemoryIds: applied.activeMemoryIds,
      signal: context.signal,
    });
  });

  test("committed active 派生失败让父 job retry，effect replay 后补齐并仅发出脱敏 warning", async () => {
    const harness = createBundleHarness();
    const onCommittedActiveDerivationWarning = vi.fn();
    const deriveCommittedActive = vi.fn()
      .mockRejectedValueOnce(new Error("postgres://admin:secret@private-host/internal"))
      .mockResolvedValueOnce(undefined);
    const handler = createNativeExtractCandidateHandler({
      runtimeBundle: harness.bundle,
      computation: { extractor },
      materialization,
      evidenceRead,
      deriveCommittedActive,
      onCommittedActiveDerivationWarning,
    });
    const job = runningJob({ intent: "remember" });
    const context = {
      signal: new AbortController().signal,
      workerId: "worker-a",
    };

    await expect(handler(job, context)).rejects.toEqual(
      new DurableJobV2HandlerFailure("EXTRACT_CANDIDATE_ACTIVE_DERIVATION_RETRYABLE", true),
    );
    const replayed = await handler(job, context) as Record<string, unknown>;

    expect(replayed).toMatchObject({ status: "replayed", created: 1 });
    expect(deriveCommittedActive).toHaveBeenCalledTimes(2);
    expect(onCommittedActiveDerivationWarning).toHaveBeenCalledTimes(1);
    expect(onCommittedActiveDerivationWarning).toHaveBeenNthCalledWith(1);
    expect(JSON.stringify(onCommittedActiveDerivationWarning.mock.calls))
      .not.toMatch(/secret|private-host|admin/);
  });

  test("committed active warning callback 自身失败不掩盖 retryable 状态", async () => {
    const handler = createNativeExtractCandidateHandler({
      runtimeBundle: createBundleHarness().bundle,
      computation: { extractor },
      materialization,
      evidenceRead,
      deriveCommittedActive: async () => {
        throw new Error("warm derivation failed");
      },
      onCommittedActiveDerivationWarning: async () => {
        throw new Error("warning sink failed");
      },
    });

    await expect(handler(runningJob({ intent: "remember" }), {
      signal: new AbortController().signal,
      workerId: "worker-a",
    })).rejects.toEqual(
      new DurableJobV2HandlerFailure("EXTRACT_CANDIDATE_ACTIVE_DERIVATION_RETRYABLE", true),
    );
  });

  test("committed active 派生的 AbortError 在 receipt 提交后仍原样传播", async () => {
    const abort = new DOMException("worker stopping", "AbortError");
    const onCommittedActiveDerivationWarning = vi.fn();
    const handler = createNativeExtractCandidateHandler({
      runtimeBundle: createBundleHarness().bundle,
      computation: { extractor },
      materialization,
      evidenceRead,
      deriveCommittedActive: async () => {
        throw abort;
      },
      onCommittedActiveDerivationWarning,
    });

    await expect(handler(runningJob({ intent: "remember" }), {
      signal: new AbortController().signal,
      workerId: "worker-a",
    })).rejects.toBe(abort);
    expect(onCommittedActiveDerivationWarning).not.toHaveBeenCalled();
  });

  test("同批 candidate 与 memory route 只调用一次 records effect 并原子提交", async () => {
    const harness = createBundleHarness();
    const mixedExtractor: TypeExtractor = {
      name: "mixed-route-fixture",
      async extract() {
        return [
          {
            text: "TypeScript 提交必须先运行 npm test 完成测试验证。",
            semanticType: "rules",
            kind: "constraint",
            confidence: 0.95,
            reason: "fixture-candidate",
          },
          {
            text: "TypeScript 项目使用 pnpm workspace 管理依赖。",
            semanticType: "experience",
            kind: "decision",
            confidence: 0.8,
            reason: "fixture-evidence",
            hasWhy: false,
          },
        ];
      },
    };
    const handler = createHandler({
      runtimeBundle: harness.bundle,
      computation: { extractor: mixedExtractor },
    });

    const result = await handler(runningJob({
      text: [
        "TypeScript 提交必须先运行 npm test 完成测试验证。",
        "TypeScript 项目使用 pnpm workspace 管理依赖。",
      ].join("\n"),
    }), {
      signal: new AbortController().signal,
      workerId: "worker-a",
    });
    expect(result).toMatchObject({
      status: "applied",
      created: 2,
      candidateIds: [expect.stringMatching(/^candidate_[0-9a-f]{64}$/)],
      memoryIds: [expect.stringMatching(/^[0-9a-f-]{36}$/)],
    });
    expect(harness.calls.filter(({ sql }) => sql === "BEGIN")).toHaveLength(1);
    expect(harness.calls.filter(({ sql }) => sql === "COMMIT")).toHaveLength(1);
    expect(harness.calls.filter(({ sql }) => /INSERT INTO mengshu_job_v2_effect_receipts/.test(sql)))
      .toHaveLength(1);
  });

  test("drop 不产生 domain write，仅提交空 effect receipt 供 job replay", async () => {
    const harness = createBundleHarness();
    const dropExtractor: TypeExtractor = {
      name: "drop-fixture",
      async extract(input) {
        return [{
          text: input.text,
          semanticType: "task_context",
          kind: "task",
          confidence: 0.1,
          reason: "fixture-drop",
          metadata: {},
        }];
      },
    };
    const handler = createHandler({
      runtimeBundle: harness.bundle,
      computation: { extractor: dropExtractor },
    });

    const result = await handler(runningJob({ text: "项目使用 TypeScript 5.6。" }), {
      signal: new AbortController().signal,
      workerId: "worker-a",
    });
    expect(result).toMatchObject({
      status: "applied", created: 0, duplicateCount: 0,
      capacityRejectedCount: 0, candidateIds: [], memoryIds: [], activeMemoryIds: [],
      droppedCount: 0,
    });
    expect(result).toMatchObject({
      proposalReceipts: [{
        version: 1,
        candidateOrdinal: 0,
        outcome: "validator_rejected",
        validation: { version: 1, outcome: "rejected", gates: expect.any(Array) },
      }],
    });
    expect(JSON.stringify((result as { proposalReceipts: unknown }).proposalReceipts))
      .not.toContain("项目使用 TypeScript 5.6");
    expect(harness.calls.some(({ sql }) => /INSERT INTO mengshu_candidates/.test(sql))).toBe(false);
    expect(harness.calls.some(({ sql }) => /INSERT INTO (?:memories|knowledge)/.test(sql))).toBe(false);
  });

  test("同一 job 重算使用稳定 candidate ID，并由固定 receipt replay 原结果", async () => {
    const harness = createBundleHarness();
    const handler = createHandler({
      runtimeBundle: harness.bundle,
      computation: { extractor },
    });
    const context = { signal: new AbortController().signal, workerId: "worker-a" };

    const first = await handler(runningJob(), context) as {
      candidateIds: readonly string[];
      proposalReceipts: readonly unknown[];
    };
    const replay = await handler(runningJob(), context);

    expect(first.proposalReceipts).toHaveLength(1);
    expect(replay).toMatchObject({
      status: "replayed",
      candidateIds: first.candidateIds,
      proposalReceipts: first.proposalReceipts,
    });
    expect(harness.calls.filter(({ sql }) => /INSERT INTO mengshu_candidates/.test(sql)))
      .toHaveLength(1);
  });

  test("零候选仍提交可 replay 的固定 receipt", async () => {
    const harness = createBundleHarness();
    const emptyExtractor: TypeExtractor = { name: "empty", extract: vi.fn(async () => []) };
    const handler = createHandler({
      runtimeBundle: harness.bundle,
      computation: { extractor: emptyExtractor },
    });
    const context = { signal: new AbortController().signal, workerId: "worker-a" };

    await expect(handler(runningJob(), context)).resolves.toEqual({
      status: "applied", created: 0, duplicateCount: 0, capacityRejectedCount: 0,
      candidateIds: [], memoryIds: [], activeMemoryIds: [], droppedCount: 0,
      proposalReceipts: [],
    });
    await expect(handler(runningJob(), context)).resolves.toEqual({
      status: "replayed", created: 0, duplicateCount: 0, capacityRejectedCount: 0,
      candidateIds: [], memoryIds: [], activeMemoryIds: [], droppedCount: 0,
      proposalReceipts: [],
    });
    expect(harness.calls.some(({ sql }) => /INSERT INTO mengshu_job_v2_effect_receipts/.test(sql)))
      .toBe(true);
    expect(harness.calls.some(({ sql }) => /INSERT INTO mengshu_candidates/.test(sql)))
      .toBe(false);
  });

  test("stale fence 映射固定 retryable HandlerFailure，且不写 candidate/receipt", async () => {
    const harness = createBundleHarness({ stale: true });
    const handler = createHandler({
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
    const handler = createHandler({
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
    const handler = createHandler({
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
    const handler = createHandler({
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
    const computationHandler = createHandler({
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
    const providerHandler = createHandler({
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
    const handler = createHandler({
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
    const handler = createHandler({
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
    const handler = createHandler({
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
    const handler = createHandler({
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
