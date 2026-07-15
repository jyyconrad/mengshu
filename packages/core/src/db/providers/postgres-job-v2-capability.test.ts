import { describe, expect, test, vi } from "vitest";

import {
  DURABLE_JOB_V2_AUTHORITATIVE_TYPES,
  createDurableJobHandlerRegistry,
  type DurableJobV2Scope,
} from "../../storage/repositories/job-v2.js";
import { PostgresDurableJobV2Repository } from "../../storage/repositories/postgres-job-v2.js";
import {
  PostgresDurableJobV2RuntimeBundleError,
  PostgresProvider,
  assertPostgresProviderOwnsDurableJobV2RuntimeBundle,
  assertProviderOwnedPostgresDurableJobV2RuntimeBundle,
} from "./postgres.js";

const scope: DurableJobV2Scope = {
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "mengshu",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "working-context",
  visibility: "private",
};

const semanticRequest = Object.freeze({
  type: "extract_candidate" as const,
  version: 1 as const,
  text: "remember the verified project rule",
  traceId: "observation-1",
  intent: "remember",
});

function effectInput(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    scope,
    owner: "worker-a",
    leaseToken: "t".repeat(32),
    leaseGeneration: 1,
    ...overrides,
  };
}

function candidateBundle(
  provider: PostgresProvider,
  effectClock: () => number = () => 100,
) {
  return provider.createDurableJobV2RuntimeBundle({
    clock: () => 100,
    tokenFactory: () => "b".repeat(32),
    backoffMs: () => 100,
    effectClock,
  });
}

interface CapacityReceiptRow {
  job_id: string;
  effect_key: string;
  request_fingerprint: string;
  lease_generation: number;
  result: Record<string, unknown>;
  committed_at: number;
}

class CandidateCapacityDatabase {
  readonly jobs = new Map<string, number>();
  readonly pending: Array<readonly unknown[]> = [];
  readonly receipts = new Map<string, CapacityReceiptRow>();
  readonly lockKeys: string[] = [];
  countQueries = 0;
  capacityFailure?: Error;
  private readonly lockTails = new Map<string, Promise<void>>();

  async acquire(key: string): Promise<() => void> {
    this.lockKeys.push(key);
    const prior = this.lockTails.get(key) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => { releaseCurrent = resolve; });
    const tail = prior.then(() => current);
    this.lockTails.set(key, tail);
    await prior;
    return () => {
      releaseCurrent();
      if (this.lockTails.get(key) === tail) this.lockTails.delete(key);
    };
  }
}

class CandidateCapacityClient {
  readonly calls: string[] = [];
  private transaction = false;
  private staged: Array<readonly unknown[]> = [];
  private stagedReceipts = new Map<string, CapacityReceiptRow>();
  private releaseLock?: () => void;

  constructor(private readonly database: CandidateCapacityDatabase) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number }> {
    const normalized = sql.trim().replace(/\s+/g, " ");
    this.calls.push(normalized);
    if (normalized === "BEGIN") {
      this.transaction = true;
      return { rows: [], rowCount: 0 };
    }
    if (normalized === "COMMIT") {
      this.database.pending.push(...this.staged);
      for (const [key, value] of this.stagedReceipts) this.database.receipts.set(key, value);
      this.transaction = false;
      this.releaseLock?.();
      return { rows: [], rowCount: 0 };
    }
    if (normalized === "ROLLBACK") {
      this.transaction = false;
      this.staged = [];
      this.stagedReceipts.clear();
      this.releaseLock?.();
      return { rows: [], rowCount: 0 };
    }
    if (!this.transaction) throw new Error("capacity query escaped transaction");
    if (/SELECT id FROM mengshu_jobs_v2/.test(normalized)) {
      const leaseUntil = this.database.jobs.get(String(params[0]));
      const exists = leaseUntil !== undefined && leaseUntil > Number(params.at(-1));
      return { rows: exists ? [{ id: String(params[0]) } as unknown as Row] : [], rowCount: exists ? 1 : 0 };
    }
    if (/SELECT job_id, effect_key/.test(normalized)) {
      const key = `${String(params[0])}:${String(params[1])}`;
      const row = this.database.receipts.get(key);
      return { rows: row ? [row as unknown as Row] : [], rowCount: row ? 1 : 0 };
    }
    if (/SELECT pg_advisory_xact_lock/.test(normalized)) {
      if (this.database.capacityFailure) throw this.database.capacityFailure;
      this.releaseLock = await this.database.acquire(params.join(":"));
      return { rows: [{ pg_advisory_xact_lock: null } as unknown as Row], rowCount: 1 };
    }
    if (/SELECT COUNT\(\*\).*FROM mengshu_candidates/.test(normalized)) {
      this.database.countQueries += 1;
      const matches = (row: readonly unknown[]) =>
        row[1] === params[0] && row[2] === params[1] && row[3] === params[2] &&
        row[4] === params[3] && row[5] === params[4] && row[6] === params[5] &&
        row[7] === params[6] && row[8] === params[7] && row[9] === params[8];
      const pendingCount = [...this.database.pending, ...this.staged].filter(matches).length;
      return {
        rows: [{ pending_count: String(pendingCount) } as unknown as Row],
        rowCount: 1,
      };
    }
    if (/INSERT INTO mengshu_candidates/.test(normalized)) {
      const dedupe = (row: readonly unknown[]) =>
        row.slice(1, 10).every((value, index) => value === params[index + 1]) &&
        row[12] === params[12];
      const duplicate = [...this.database.pending, ...this.staged].some(dedupe);
      if (!duplicate) this.staged.push(Object.freeze([...params]));
      return { rows: [], rowCount: duplicate ? 0 : 1 };
    }
    if (/INSERT INTO mengshu_job_v2_effect_receipts/.test(normalized)) {
      const row: CapacityReceiptRow = {
        job_id: String(params[0]),
        effect_key: String(params[1]),
        request_fingerprint: String(params[2]),
        lease_generation: Number(params[3]),
        result: JSON.parse(String(params[4])) as Record<string, unknown>,
        committed_at: Number(params[5]),
      };
      this.stagedReceipts.set(`${row.job_id}:${row.effect_key}`, row);
      return { rows: [row as unknown as Row], rowCount: 1 };
    }
    throw new Error(`unexpected capacity SQL: ${normalized}`);
  }

  release(): void {}
}

function candidateCapacityHarness() {
  const database = new CandidateCapacityDatabase();
  const clients: CandidateCapacityClient[] = [];
  const pool = {
    query: vi.fn(),
    connect: vi.fn(async () => {
      const client = new CandidateCapacityClient(database);
      clients.push(client);
      return client;
    }),
    end: vi.fn(),
  };
  const provider = new PostgresProvider({
    host: "unused", port: 5432, database: "unused", user: "unused", password: "unused",
  }, "text-embedding-3-small");
  Object.assign(provider as unknown as Record<string, unknown>, {
    pool, schemaVersion: 8, schemaContractState: "ready",
  });
  const bundle = provider.createDurableJobV2RuntimeBundle({
    clock: () => 100,
    tokenFactory: () => "t".repeat(32),
    backoffMs: () => 100,
    effectClock: vi.fn().mockReturnValue(100),
  });
  const candidates = (jobId: string, count: number) => Array.from({ length: count }, (_, index) => ({
    id: `${jobId}-candidate-${index}`,
    text: `${jobId} candidate ${index}`,
    kind: "constraint",
    confidence: 0.9,
    evidenceIds: [`event-${jobId}`],
    metadata: { sourceIndex: index },
    createdAt: 100,
  }));
  const execute = (jobId: string, sessionId: string, count: number) => {
    database.jobs.set(jobId, 1_000);
    return bundle.executeCandidateEffect({
      effectInput: effectInput({ id: jobId }),
      context: { workspaceId: "workspace-a", sessionId },
      semanticRequest: {
        ...semanticRequest,
        traceId: `event-${jobId}`,
        text: `semantic request ${jobId}`,
      },
      candidates: candidates(jobId, count),
    });
  };
  return { database, clients, provider, bundle, execute, candidates };
}

describe("PostgresProvider durable job v2 capability", () => {
  test("provider 不暴露 per-call clock direct effect；过期 lease 经 bundle stale 且零写", async () => {
    const h = candidateCapacityHarness();
    h.database.jobs.set("job-expired", 50);

    expect(h.provider).not.toHaveProperty("executeCandidateEffect");
    await expect(h.bundle.executeCandidateEffect({
      effectInput: effectInput({ id: "job-expired" }),
      context: { workspaceId: "workspace-a", sessionId: "session-a" },
      semanticRequest: { ...semanticRequest, traceId: "event-expired" },
      candidates: h.candidates("job-expired", 5),
    })).resolves.toEqual({ status: "stale" });
    expect(h.database.pending).toEqual([]);
    expect(h.database.receipts.size).toBe(0);
    expect(h.database.lockKeys).toEqual([]);
  });
  test.each([51, 200])("direct provider 单批 %i 也只能提交 session capacity 50", async (count) => {
    const h = candidateCapacityHarness();
    const result = await h.execute("job-direct", "session-a", count);

    expect(result).toMatchObject({
      status: "applied",
      receipt: {
        result: {
          created: 50,
          duplicateCount: 0,
          capacityRejectedCount: count - 50,
        },
      },
    });
    expect(h.database.pending).toHaveLength(50);
    expect(h.database.countQueries).toBe(1);
  });

  test("同一 9D session 多 job 顺序/并发累计不超过 50，replay/stale 不再占容量", async () => {
    const sequential = candidateCapacityHarness();
    await expect(sequential.execute("job-a", "session-a", 40)).resolves.toMatchObject({
      receipt: { result: { created: 40, capacityRejectedCount: 0 } },
    });
    await expect(sequential.execute("job-b", "session-a", 20)).resolves.toMatchObject({
      receipt: { result: { created: 10, capacityRejectedCount: 10 } },
    });
    expect(sequential.database.pending).toHaveLength(50);
    const capacityQueriesBeforeReplay = sequential.database.countQueries;
    await expect(sequential.execute("job-a", "session-a", 40)).resolves.toMatchObject({
      status: "replayed",
      receipt: { result: { created: 40, capacityRejectedCount: 0 } },
    });
    expect(sequential.database.countQueries).toBe(capacityQueriesBeforeReplay);

    const concurrent = candidateCapacityHarness();
    const results = await Promise.all([
      concurrent.execute("job-c", "session-a", 40),
      concurrent.execute("job-d", "session-a", 40),
    ]);
    const summaries = results.map((result) => result.status === "stale" ? undefined : result.receipt.result);
    expect(summaries.reduce((sum, item) => sum + Number(item?.created ?? 0), 0)).toBe(50);
    expect(summaries.reduce((sum, item) => sum + Number(item?.capacityRejectedCount ?? 0), 0)).toBe(30);
    expect(concurrent.database.pending).toHaveLength(50);

    concurrent.database.jobs.delete("job-stale");
    const lockCount = concurrent.database.lockKeys.length;
    await expect(concurrent.bundle.executeCandidateEffect({
      effectInput: effectInput({ id: "job-stale" }),
      context: { workspaceId: "workspace-a", sessionId: "session-a" },
      semanticRequest: { ...semanticRequest, traceId: "event-stale" },
      candidates: concurrent.candidates("job-stale", 5),
    })).resolves.toEqual({ status: "stale" });
    expect(concurrent.database.lockKeys).toHaveLength(lockCount);
  });

  test("不同 workspace/session 派生不同 advisory lock key，不共享 capacity", async () => {
    const h = candidateCapacityHarness();
    const [first, second] = await Promise.all([
      h.execute("job-session-a", "session-a", 40),
      h.execute("job-session-b", "session-b", 40),
    ]);
    expect(first).toMatchObject({ receipt: { result: { created: 40, capacityRejectedCount: 0 } } });
    expect(second).toMatchObject({ receipt: { result: { created: 40, capacityRejectedCount: 0 } } });
    expect(h.database.pending).toHaveLength(80);
    expect(new Set(h.database.lockKeys).size).toBe(2);
  });

  test("capacity lock/count 内部错误固定脱敏且整批零写入", async () => {
    const h = candidateCapacityHarness();
    h.database.capacityFailure = new Error("postgres://admin:secret@private-host/internal");

    const error = await h.execute("job-capacity-error", "session-a", 5)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "DURABLE_JOB_EFFECT_CAPACITY_UNAVAILABLE",
      retryable: true,
      message: "Pending candidate capacity is unavailable",
    });
    expect(JSON.stringify(error)).not.toMatch(/secret|private-host|admin/);
    expect(h.database.pending).toEqual([]);
    expect(h.database.receipts.size).toBe(0);
  });
  test("原子 mint frozen bundle，fake/copy/foreign provider 均不可结构伪造", () => {
    const provider = new PostgresProvider({
      host: "unused", port: 5432, database: "unused", user: "unused", password: "unused",
    }, "text-embedding-3-small");
    const foreign = new PostgresProvider({
      host: "foreign", port: 5432, database: "foreign", user: "foreign", password: "foreign",
    }, "text-embedding-3-small");
    const dependencies = {
      clock: () => 100,
      tokenFactory: () => "a".repeat(32),
      backoffMs: () => 100,
      effectClock: () => 100,
    };
    const bundle = provider.createDurableJobV2RuntimeBundle(dependencies);

    expect(bundle.contract).toBe("mengshu.postgres-durable-job-v2/v1");
    expect(bundle.repository).toBeInstanceOf(PostgresDurableJobV2Repository);
    expect(bundle.handlerTypes).toEqual(DURABLE_JOB_V2_AUTHORITATIVE_TYPES);
    expect(bundle.executeCandidateEffect).toHaveLength(1);
    expect(bundle.assertReady).toHaveLength(0);
    expect(bundle.close).toHaveLength(0);
    expect(Object.isFrozen(bundle)).toBe(true);
    expect(Object.isFrozen(bundle.handlerTypes)).toBe(true);
    expect(assertProviderOwnedPostgresDurableJobV2RuntimeBundle(bundle)).toBe(bundle);
    expect(assertPostgresProviderOwnsDurableJobV2RuntimeBundle(provider, bundle)).toBe(bundle);

    const fake = { ...bundle };
    const getter = vi.fn(() => bundle.repository);
    const accessor = { ...fake };
    Object.defineProperty(accessor, "repository", { enumerable: true, get: getter });
    let proxyTraps = 0;
    const proxy = new Proxy(bundle, {
      get(target, key, receiver) { proxyTraps += 1; return Reflect.get(target, key, receiver); },
      ownKeys(target) { proxyTraps += 1; return Reflect.ownKeys(target); },
    });
    for (const value of [fake, Object.freeze(fake), accessor, proxy, {}]) {
      expect(() => assertProviderOwnedPostgresDurableJobV2RuntimeBundle(value)).toThrow(
        new PostgresDurableJobV2RuntimeBundleError("DURABLE_RUNTIME_BUNDLE_INVALID"),
      );
    }
    expect(getter).not.toHaveBeenCalled();
    expect(proxyTraps).toBe(0);
    expect(() => assertPostgresProviderOwnsDurableJobV2RuntimeBundle(foreign, bundle)).toThrow(
      new PostgresDurableJobV2RuntimeBundleError("DURABLE_RUNTIME_BUNDLE_INVALID"),
    );

    dependencies.clock = () => 999;
    dependencies.tokenFactory = () => "z".repeat(32);
    expect(bundle.handlerTypes).toEqual([
      "build_tree", "extract_candidate", "extract_graph",
    ]);
  });

  test("bundle mint dependencies exact own-data；Proxy/getter/symbol/extra/nonplain 零 trap", () => {
    const provider = new PostgresProvider({
      host: "unused", port: 5432, database: "unused", user: "unused", password: "unused",
    }, "text-embedding-3-small");
    const initialize = vi.spyOn(provider, "initialize");
    const getter = vi.fn(() => () => 100);
    const accessor = {
      tokenFactory: () => "a".repeat(32),
      backoffMs: () => 100,
    } as Record<string, unknown>;
    Object.defineProperty(accessor, "clock", { enumerable: true, get: getter });
    let proxyTraps = 0;
    const proxy = new Proxy({
      clock: () => 100,
      tokenFactory: () => "a".repeat(32),
      backoffMs: () => 100,
    }, {
      ownKeys(target) { proxyTraps += 1; return Reflect.ownKeys(target); },
      get(target, key, receiver) { proxyTraps += 1; return Reflect.get(target, key, receiver); },
    });
    const valid = {
      clock: () => 100,
      tokenFactory: () => "a".repeat(32),
      backoffMs: () => 100,
    };
    for (const value of [
      accessor,
      proxy,
      { ...valid, extra: true },
      { ...valid, [Symbol("extra")]: true },
      Object.assign(new Date(0), valid),
      { ...valid, clock: 100 },
    ]) {
      expect(() => provider.createDurableJobV2RuntimeBundle(value as never)).toThrow(
        new PostgresDurableJobV2RuntimeBundleError("DURABLE_RUNTIME_BUNDLE_INVALID"),
      );
    }
    expect(getter).not.toHaveBeenCalled();
    expect(proxyTraps).toBe(0);
    expect(initialize).not.toHaveBeenCalled();
  });

  test("bundle readiness typed fail-closed；v10 ready frozen 且零 lease/tick/domain DML", async () => {
    const make = (schemaVersion: number, schemaContractState: string) => {
      const client = { query: vi.fn(), release: vi.fn() };
      const pool = { query: vi.fn(), connect: vi.fn(async () => client), end: vi.fn() };
      const provider = new PostgresProvider({
        host: "unused", port: 5432, database: "unused", user: "unused", password: "unused",
      }, "text-embedding-3-small");
      Object.assign(provider as unknown as Record<string, unknown>, {
        pool, schemaVersion, schemaContractState,
      });
      const bundle = provider.createDurableJobV2RuntimeBundle({
        clock: () => 100,
        tokenFactory: () => "a".repeat(32),
        backoffMs: () => 100,
      });
      return { provider, bundle, pool, client };
    };

    const v5 = make(5, "pending");
    await expect(v5.bundle.assertReady()).rejects.toMatchObject({
      code: "DURABLE_RUNTIME_SCHEMA_CONTRACT_PENDING", retryable: false,
    });
    expect(v5.pool.end).toHaveBeenCalledTimes(1);
    expect(v5.provider).toMatchObject({
      pool: null,
      schemaVersion: 0,
      schemaContractState: "unknown",
    });
    await v5.bundle.close();
    expect(v5.pool.end).toHaveBeenCalledTimes(1);

    const v9 = make(9, "ready");
    await expect(v9.bundle.assertReady()).rejects.toMatchObject({
      code: "DURABLE_RUNTIME_SCHEMA_V10_REQUIRED", retryable: false,
    });
    const publicCloseTrap = vi.spyOn(v9.provider, "close").mockRejectedValue(
      new Error("public close monkey patch reached"),
    );
    await v9.bundle.close();
    expect(publicCloseTrap).not.toHaveBeenCalled();
    expect(v9.pool.end).toHaveBeenCalledTimes(1);

    const unknown = make(10, "unknown");
    await expect(unknown.bundle.assertReady()).rejects.toMatchObject({
      code: "DURABLE_RUNTIME_READINESS_UNAVAILABLE", retryable: true,
    });
    expect(unknown.pool.end).toHaveBeenCalledTimes(1);
    expect(unknown.provider).toMatchObject({
      pool: null,
      schemaVersion: 0,
      schemaContractState: "unknown",
    });

    const concurrent = make(5, "pending");
    const concurrentResults = await Promise.allSettled([
      concurrent.bundle.assertReady(),
      concurrent.bundle.assertReady(),
    ]);
    expect(concurrentResults).toEqual([
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({ code: "DURABLE_RUNTIME_SCHEMA_CONTRACT_PENDING" }),
      }),
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({ code: "DURABLE_RUNTIME_SCHEMA_CONTRACT_PENDING" }),
      }),
    ]);
    expect(concurrent.pool.end).toHaveBeenCalledTimes(1);

    const v10 = make(10, "ready");
    const readiness = await v10.bundle.assertReady();
    expect(readiness).toEqual({
      provider: "postgres",
      minimumSchemaVersion: 10,
      currentSchemaVersion: 10,
      candidateEffects: "ready",
      treeEffects: "ready",
      graphEffects: "ready",
    });
    expect(Object.isFrozen(readiness)).toBe(true);
    expect(v10.pool.end).not.toHaveBeenCalled();
    for (const item of [v5, v9, unknown, concurrent, v10]) {
      expect(item.pool.connect).not.toHaveBeenCalled();
      expect(item.pool.query).not.toHaveBeenCalled();
      expect(item.client.query).not.toHaveBeenCalled();
    }
    await v10.bundle.close();
    expect(v10.pool.end).toHaveBeenCalledTimes(1);
  });

  test("readiness 初始化瞬时失败映射 retryable typed error 且消息不泄漏", async () => {
    const provider = new PostgresProvider({
      host: "unused", port: 5432, database: "unused", user: "unused", password: "secret-password",
    }, "text-embedding-3-small");
    vi.spyOn(provider, "initialize").mockRejectedValue(
      new Error("postgres://admin:secret-password@private-host/internal"),
    );
    const pool = { end: vi.fn(async () => {}) };
    Object.assign(provider as unknown as Record<string, unknown>, { pool });
    const bundle = provider.createDurableJobV2RuntimeBundle({
      clock: () => 100,
      tokenFactory: () => "a".repeat(32),
      backoffMs: () => 100,
    });
    const error = await bundle.assertReady().catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "DURABLE_RUNTIME_READINESS_UNAVAILABLE",
      retryable: true,
      message: "Postgres durable runtime capability is unavailable",
    });
    expect(JSON.stringify(error)).not.toMatch(/secret-password|private-host|admin/);
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(provider).toMatchObject({
      pool: null,
      schemaVersion: 0,
      schemaContractState: "unknown",
    });
    await Promise.all([bundle.close(), bundle.close()]);
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  test("readiness cleanup reject 保留原 typed error，先 detach/reset 且并发只 end 一次", async () => {
    const provider = new PostgresProvider({
      host: "unused", port: 5432, database: "unused", user: "unused", password: "secret-password",
    }, "text-embedding-3-small");
    const pool = {
      end: vi.fn(async () => {
        throw new Error("postgres://admin:secret-password@private-host/cleanup");
      }),
    };
    Object.assign(provider as unknown as Record<string, unknown>, {
      pool,
      schemaVersion: 5,
      schemaContractState: "pending",
    });
    const bundle = provider.createDurableJobV2RuntimeBundle({
      clock: () => 100,
      tokenFactory: () => "a".repeat(32),
      backoffMs: () => 100,
    });

    const results = await Promise.allSettled([bundle.assertReady(), bundle.assertReady()]);

    for (const result of results) {
      expect(result).toMatchObject({
        status: "rejected",
        reason: {
          code: "DURABLE_RUNTIME_SCHEMA_CONTRACT_PENDING",
          retryable: false,
          message: "Postgres durable runtime capability is unavailable",
        },
      });
      expect(JSON.stringify(result)).not.toMatch(/secret-password|private-host|admin|cleanup/);
    }
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(provider).toMatchObject({
      pool: null,
      schemaVersion: 0,
      schemaContractState: "unknown",
    });
    await expect(bundle.close()).resolves.toBeUndefined();
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  test("explicit bundle.close cleanup reject 脱敏且 detach 后再次 close 幂等", async () => {
    const provider = new PostgresProvider({
      host: "unused", port: 5432, database: "unused", user: "unused", password: "secret-password",
    }, "text-embedding-3-small");
    const pool = {
      end: vi.fn(async () => {
        throw new Error("postgres://admin:secret-password@private-host/cleanup");
      }),
    };
    Object.assign(provider as unknown as Record<string, unknown>, {
      pool,
      schemaVersion: 8,
      schemaContractState: "ready",
    });
    const bundle = provider.createDurableJobV2RuntimeBundle({
      clock: () => 100,
      tokenFactory: () => "a".repeat(32),
      backoffMs: () => 100,
    });

    const error = await bundle.close().catch((caught: unknown) => caught);

    expect(error).toEqual(
      new PostgresDurableJobV2RuntimeBundleError("DURABLE_RUNTIME_READINESS_UNAVAILABLE"),
    );
    expect(JSON.stringify(error)).not.toMatch(/secret-password|private-host|admin|cleanup/);
    expect(provider).toMatchObject({
      pool: null,
      schemaVersion: 0,
      schemaContractState: "unknown",
    });
    await expect(bundle.close()).resolves.toBeUndefined();
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  test("initialize failure 即使已无 pool 也清除 stale schema readiness", async () => {
    const provider = new PostgresProvider({
      host: "unused", port: 5432, database: "unused", user: "unused", password: "secret-password",
    }, "text-embedding-3-small");
    vi.spyOn(provider, "initialize").mockImplementation(async () => {
      Object.assign(provider as unknown as Record<string, unknown>, {
        pool: null,
        schemaVersion: 8,
        schemaContractState: "ready",
      });
      throw new Error("postgres://admin:secret-password@private-host/initialize");
    });
    const bundle = provider.createDurableJobV2RuntimeBundle({
      clock: () => 100,
      tokenFactory: () => "a".repeat(32),
      backoffMs: () => 100,
    });

    await expect(bundle.assertReady()).rejects.toEqual(
      new PostgresDurableJobV2RuntimeBundleError("DURABLE_RUNTIME_READINESS_UNAVAILABLE"),
    );
    expect(provider).toMatchObject({
      pool: null,
      schemaVersion: 0,
      schemaContractState: "unknown",
    });
  });

  test("root public API does not expose the raw Postgres candidate writer", async () => {
    const publicApi = await import("../../index.js");
    expect(publicApi).not.toHaveProperty("PostgresCandidateRepository");
    expect(publicApi).not.toHaveProperty("PostgresCandidateQueryClient");
  });

  test("只暴露 repository capability，操作复用 initialized provider pool dedicated client", async () => {
    const client = {
      calls: [] as string[],
      release: vi.fn(),
      query: vi.fn(async (sql: string) => {
        client.calls.push(sql);
        return { rows: [], rowCount: 0 };
      }),
    };
    const pool = {
      query: vi.fn(async () => {
        throw new Error("pool.query must not be used by durable job v2");
      }),
      connect: vi.fn(async () => client),
      end: vi.fn(async () => {}),
    };
    const provider = new PostgresProvider({
      host: "unused",
      port: 5432,
      database: "unused",
      user: "unused",
      password: "unused",
    }, "text-embedding-3-small");
    Object.assign(provider as unknown as Record<string, unknown>, {
      pool,
      schemaVersion: 8,
      schemaContractState: "ready",
    });

    const capability = provider.createDurableJobV2Repository({
      registry: createDurableJobHandlerRegistry(["extract_candidate"]),
      clock: () => 100,
      tokenFactory: () => "a".repeat(32),
      backoffMs: () => 100,
    });

    expect(capability).toBeInstanceOf(PostgresDurableJobV2Repository);
    expect(capability).not.toHaveProperty("pool");
    expect(capability).not.toHaveProperty("query");

    await expect(capability.lease({ scope, owner: "worker-a", leaseMs: 100 }))
      .resolves.toEqual({ applied: 0 });
    await expect(capability.reap({ scope })).resolves.toEqual({ applied: 0 });

    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(pool.query).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledTimes(2);
    expect(client.calls).toEqual([
      "BEGIN", expect.stringMatching(/FOR UPDATE SKIP LOCKED/), "COMMIT",
      "BEGIN", expect.stringMatching(/FOR UPDATE SKIP LOCKED/), "COMMIT",
    ]);
  });

  test("provider-owned batch binds job/scope and atomically commits candidates plus receipt", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const release = vi.fn();
    const client = {
      release,
      query: vi.fn(async <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        params: readonly unknown[] = [],
      ) => {
        const normalized = sql.trim().replace(/\s+/g, " ");
        calls.push({ sql: normalized, params });
        if (normalized === "BEGIN" || normalized === "COMMIT") {
          return { rows: [] as Row[], rowCount: 0 };
        }
        if (/SELECT id FROM mengshu_jobs_v2/.test(normalized)) {
          return { rows: [{ id: "job-1" } as unknown as Row], rowCount: 1 };
        }
        if (/SELECT job_id, effect_key/.test(normalized)) {
          return { rows: [] as Row[], rowCount: 0 };
        }
        if (/SELECT pg_advisory_xact_lock/.test(normalized)) {
          return { rows: [{ pg_advisory_xact_lock: null } as unknown as Row], rowCount: 1 };
        }
        if (/SELECT COUNT\(\*\).*FROM mengshu_candidates/.test(normalized)) {
          return { rows: [{ pending_count: "0" } as unknown as Row], rowCount: 1 };
        }
        if (/INSERT INTO mengshu_candidates/.test(normalized)) {
          const candidateId = params[0];
          return { rows: [] as Row[], rowCount: candidateId === "candidate-2" ? 0 : 1 };
        }
        if (/INSERT INTO mengshu_job_v2_effect_receipts/.test(normalized)) {
          const result = JSON.parse(String(params[4]));
          return {
            rows: [{
              job_id: "job-1",
              effect_key: String(params[1]),
              request_fingerprint: String(params[2]),
              lease_generation: 1,
              result,
              committed_at: 110,
            } as unknown as Row],
            rowCount: 1,
          };
        }
        throw new Error(`unexpected SQL: ${normalized}`);
      }),
    };
    const pool = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      connect: vi.fn(async () => client),
      end: vi.fn(async () => {}),
    };
    const provider = new PostgresProvider({
      host: "unused", port: 5432, database: "unused", user: "unused", password: "unused",
    }, "text-embedding-3-small");
    Object.assign(provider as unknown as Record<string, unknown>, {
      pool,
      schemaVersion: 8,
      schemaContractState: "ready",
    });
    const result = await candidateBundle(
      provider,
      vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(110),
    ).executeCandidateEffect({
      effectInput: effectInput(),
      context: { workspaceId: "workspace-a", sessionId: "session-a" },
      semanticRequest,
      candidates: [{
        id: "candidate-1",
        text: "remember this rule",
        semanticType: "rules",
        kind: "constraint",
        confidence: 0.9,
        evidenceIds: ["observation-1"],
        metadata: { source: "extract_candidate" },
        createdAt: 100,
      }, {
        id: "candidate-2",
        text: "remember this second rule",
        semanticType: "rules",
        kind: "constraint",
        confidence: 0.8,
        evidenceIds: ["observation-2"],
        metadata: { source: "extract_candidate" },
        createdAt: 100,
      }, {
        id: "candidate-3",
        text: "remember this third rule",
        semanticType: "rules",
        kind: "constraint",
        confidence: 0.7,
        evidenceIds: ["observation-3"],
        metadata: { source: "extract_candidate" },
        createdAt: 100,
      }],
    });

    expect(result).toMatchObject({
      status: "applied",
      receipt: {
        effectKey: "extract_candidate.persist.v1",
        result: {
          created: 2,
          duplicateCount: 1,
          capacityRejectedCount: 0,
          candidateIds: ["candidate-1", "candidate-3"],
        },
      },
    });
    expect(calls.map(({ sql }) => sql)).toEqual([
      "BEGIN",
      expect.stringMatching(/SELECT id FROM mengshu_jobs_v2.+FOR UPDATE/),
      expect.stringMatching(/SELECT job_id, effect_key/),
      "SELECT pg_advisory_xact_lock($1, $2)",
      expect.stringMatching(/SELECT COUNT\(\*\).*FROM mengshu_candidates/),
      expect.stringMatching(/INSERT INTO mengshu_candidates.+ON CONFLICT \(tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility, workspace_id, session_id, active_content_hash\) DO NOTHING/),
      expect.stringMatching(/INSERT INTO mengshu_candidates/),
      expect.stringMatching(/INSERT INTO mengshu_candidates/),
      expect.stringMatching(/INSERT INTO mengshu_job_v2_effect_receipts.+SELECT.+mengshu_jobs_v2/),
      "COMMIT",
    ]);
    for (const candidateCall of calls.filter(({ sql }) => /INSERT INTO mengshu_candidates/.test(sql))) {
      expect(candidateCall.params[1]).toBe(scope.tenantId);
      expect(candidateCall.params[8]).toBe("workspace-a");
      expect(candidateCall.params[9]).toBe("session-a");
      expect(candidateCall.params[10]).toBe("job-1");
    }
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  test("zero candidates still commits a replayable fixed receipt", async () => {
    let prior: Record<string, unknown> | undefined;
    const calls: string[] = [];
    const client = {
      release: vi.fn(),
      query: vi.fn(async <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        params: readonly unknown[] = [],
      ) => {
        const normalized = sql.trim().replace(/\s+/g, " ");
        calls.push(normalized);
        if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
          return { rows: [] as Row[], rowCount: 0 };
        }
        if (/SELECT id FROM mengshu_jobs_v2/.test(normalized)) {
          return { rows: [{ id: "job-1" } as unknown as Row], rowCount: 1 };
        }
        if (/SELECT job_id, effect_key/.test(normalized)) {
          return { rows: (prior ? [prior] : []) as Row[], rowCount: prior ? 1 : 0 };
        }
        if (/INSERT INTO mengshu_job_v2_effect_receipts/.test(normalized)) {
          prior = {
            job_id: "job-1", effect_key: String(params[1]),
            request_fingerprint: String(params[2]), lease_generation: 1,
            result: JSON.parse(String(params[4])), committed_at: 110,
          };
          return { rows: [prior as Row], rowCount: 1 };
        }
        throw new Error(`unexpected SQL: ${normalized}`);
      }),
    };
    const pool = { query: vi.fn(), connect: vi.fn(async () => client), end: vi.fn() };
    const provider = new PostgresProvider({
      host: "unused", port: 5432, database: "unused", user: "unused", password: "unused",
    }, "text-embedding-3-small");
    Object.assign(provider as unknown as Record<string, unknown>, {
      pool, schemaVersion: 8, schemaContractState: "ready",
    });
    const bundle = candidateBundle(provider, () => 100);
    await expect(bundle.executeCandidateEffect(
      { effectInput: effectInput(), context: {}, semanticRequest, candidates: [] },
    )).resolves.toMatchObject({
      status: "applied", receipt: { result: { created: 0, duplicateCount: 0, candidateIds: [] } },
    });
    await expect(bundle.executeCandidateEffect(
      { effectInput: effectInput(), context: {}, semanticRequest, candidates: [] },
    )).resolves.toMatchObject({
      status: "replayed", receipt: { result: { created: 0, duplicateCount: 0, candidateIds: [] } },
    });
    await expect(bundle.executeCandidateEffect({
      effectInput: effectInput(),
      context: {},
      semanticRequest,
      candidates: [{
        id: "candidate-from-nondeterministic-recompute",
        text: "a different valid candidate from the same semantic request",
        kind: "constraint",
        confidence: 0.7,
        evidenceIds: ["observation-1"],
        metadata: {},
        createdAt: 120,
      }],
    })).resolves.toMatchObject({
      status: "replayed", receipt: { result: { created: 0, duplicateCount: 0, candidateIds: [] } },
    });
    await expect(bundle.executeCandidateEffect({
      effectInput: effectInput(),
      context: {},
      semanticRequest: { ...semanticRequest, text: `${semanticRequest.text} changed` },
      candidates: [],
    })).rejects.toMatchObject({
      code: "DURABLE_JOB_EFFECT_FINGERPRINT_MISMATCH",
    });
    for (const request of [
      { context: {}, semanticRequest: { ...semanticRequest, traceId: "observation-2" } },
      { context: {}, semanticRequest: { ...semanticRequest, intent: "auto" } },
      { context: { workspaceId: "workspace-b" }, semanticRequest },
    ]) {
      await expect(bundle.executeCandidateEffect({
        effectInput: effectInput(),
        ...request,
        candidates: [],
      })).rejects.toMatchObject({
        code: "DURABLE_JOB_EFFECT_FINGERPRINT_MISMATCH",
      });
    }
    prior = {
      ...prior,
      result: { created: 2, duplicateCount: 0, candidateIds: ["foreign-candidate"] },
    };
    await expect(bundle.executeCandidateEffect(
      { effectInput: effectInput(), context: {}, semanticRequest, candidates: [] },
    )).rejects.toThrow(/candidate effect receipt/i);
    expect(calls.filter((sql) => /INSERT INTO mengshu_candidates/.test(sql))).toHaveLength(0);
  });

  test("foreign authority/repository fields and unsafe strings fail before any DB access", async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      connect: vi.fn(async () => ({
        query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
        release: vi.fn(),
      })),
      end: vi.fn(async () => {}),
    };
    const provider = new PostgresProvider({
      host: "unused", port: 5432, database: "unused", user: "unused", password: "unused",
    }, "text-embedding-3-small");
    Object.assign(provider as unknown as Record<string, unknown>, {
      pool,
      schemaVersion: 8,
      schemaContractState: "pending",
    });
    const lease = effectInput({ id: "job-a" });
    const base = {
      id: "candidate-1", text: "remember this rule", semanticType: "rules", kind: "constraint",
      confidence: 0.9, evidenceIds: ["observation-1"], metadata: {}, createdAt: 100,
    };
    const foreignProvider = new PostgresProvider({
      host: "foreign", port: 5432, database: "foreign", user: "foreign", password: "foreign",
    }, "text-embedding-3-small");
    const foreignEffect = foreignProvider.createDurableJobV2EffectRepository({
      allowedRelations: ["memories"],
    });
    const foreignJobs = foreignProvider.createDurableJobV2Repository({
      registry: createDurableJobHandlerRegistry(["extract_candidate"]),
      clock: () => 100,
      tokenFactory: () => "f".repeat(32),
      backoffMs: () => 100,
    });
    const invalid = [
      { effectInput: lease, context: {}, semanticRequest, candidates: [{ ...base, sourceJobId: "job-b" }] },
      { effectInput: lease, context: {}, semanticRequest, candidates: [{ ...base, scope: { ...scope, tenantId: "tenant-b" } }] },
      { effectInput: lease, context: {}, semanticRequest, candidates: [{ ...base, text: "bad\u0000text" }] },
      { effectInput: lease, context: {}, semanticRequest, candidates: [{ ...base, reason: "bad\u0001reason" }] },
      { effectInput: lease, context: {}, semanticRequest, candidates: [{ ...base, metadata: { nested: { "bad\u0000key": "x" } } }] },
      { effectInput: lease, context: {}, semanticRequest, candidates: [{ ...base, metadata: { nested: { key: "bad\ud800value" } } }] },
      { effectInput: lease, context: {}, semanticRequest, candidates: [base, { ...base, id: "candidate-2", text: "bad\u0000later" }] },
      { effectInput: lease, context: {}, semanticRequest, candidates: [base], effectRepository: { execute: vi.fn() } },
      { effectInput: lease, context: {}, semanticRequest, candidates: [base], candidateRepository: { insertPendingWithClient: vi.fn() } },
      { effectInput: lease, context: {}, semanticRequest, candidates: [base], effectRepository: foreignEffect },
      { effectInput: lease, context: {}, semanticRequest, candidates: [base], jobRepository: foreignJobs },
    ];
    const bundle = candidateBundle(provider);
    for (const value of invalid) {
      await expect(bundle.executeCandidateEffect(value as never)).rejects.toThrow(/candidate effect|candidate input/i);
    }
    expect(pool.connect).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
    expect(provider).not.toHaveProperty("createCandidateRepository");
  });

  test("schema v8 gate fails before connect and raw effect cannot mint candidate policy", async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      connect: vi.fn(async () => ({ query: vi.fn(), release: vi.fn() })),
      end: vi.fn(async () => {}),
    };
    const provider = new PostgresProvider({
      host: "unused", port: 5432, database: "unused", user: "unused", password: "unused",
    }, "text-embedding-3-small");
    Object.assign(provider as unknown as Record<string, unknown>, {
      pool, schemaVersion: 7, schemaContractState: "ready",
    });
    await expect(candidateBundle(provider).executeCandidateEffect({
      effectInput: effectInput(),
      context: {},
      semanticRequest,
      candidates: [],
    })).rejects.toThrow(/schema v8/i);
    expect(() => provider.createDurableJobV2EffectRepository({
      allowedRelations: ["mengshu_candidates"],
    })).toThrow(/candidate effect/i);
    for (const relation of [
      "mengshu_tree_leaves",
      "mengshu_tree_buffers",
      "mengshu_tree_summary_nodes",
      "mengshu_graph_entities",
      "mengshu_graph_relations",
    ]) {
      expect(() => provider.createDurableJobV2EffectRepository({
        allowedRelations: [relation],
      })).toThrow(/provider-owned runtime capability/i);
    }
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test("generic effect dependencies are exact own-data and hostile wrappers fail without traps", () => {
    const provider = new PostgresProvider({
      host: "unused", port: 5432, database: "unused", user: "unused", password: "unused",
    }, "text-embedding-3-small");
    const getter = vi.fn()
      .mockReturnValueOnce(["memories"])
      .mockReturnValueOnce(["mengshu_candidates"]);
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "allowedRelations", {
      enumerable: true,
      get: getter,
    });
    const proxyTrap = vi.fn(() => {
      throw new Error("proxy trap must not run");
    });
    const proxied = new Proxy({ allowedRelations: ["memories"] }, {
      get: proxyTrap,
      ownKeys: proxyTrap,
      getOwnPropertyDescriptor: proxyTrap,
      getPrototypeOf: proxyTrap,
    });
    const indexedGetter = vi.fn(() => "memories");
    const accessorRelations: unknown[] = [];
    Object.defineProperty(accessorRelations, "0", {
      enumerable: true,
      configurable: true,
      get: indexedGetter,
    });
    Object.defineProperty(accessorRelations, "length", { value: 1 });
    const symbolExtra = { allowedRelations: ["memories"], [Symbol("extra")]: true };

    for (const dependencies of [
      accessor,
      proxied,
      { allowedRelations: ["memories"], extra: true },
      symbolExtra,
      new Date(0),
      { allowedRelations: accessorRelations },
      { allowedRelations: Object.assign(["memories"], { extra: true }) },
    ]) {
      expect(() => provider.createDurableJobV2EffectRepository(dependencies as never))
        .toThrow(/effect dependencies|invalid/i);
    }
    expect(getter).not.toHaveBeenCalled();
    expect(proxyTrap).not.toHaveBeenCalled();
    expect(indexedGetter).not.toHaveBeenCalled();
  });

  test("generic effect snapshots allowed relations once and caller mutation cannot open candidates", async () => {
    const calls: string[] = [];
    const client = {
      release: vi.fn(),
      query: vi.fn(async <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
      ) => {
        const normalized = sql.trim().replace(/\s+/g, " ");
        calls.push(normalized);
        if (normalized === "BEGIN" || normalized === "ROLLBACK") {
          return { rows: [] as Row[], rowCount: 0 };
        }
        if (/SELECT id FROM mengshu_jobs_v2/.test(normalized)) {
          return { rows: [{ id: "job-1" } as unknown as Row], rowCount: 1 };
        }
        if (/SELECT job_id, effect_key/.test(normalized)) {
          return { rows: [] as Row[], rowCount: 0 };
        }
        throw new Error(`unexpected SQL: ${normalized}`);
      }),
    };
    const pool = {
      query: vi.fn(),
      connect: vi.fn(async () => client),
      end: vi.fn(),
    };
    const provider = new PostgresProvider({
      host: "unused", port: 5432, database: "unused", user: "unused", password: "unused",
    }, "text-embedding-3-small");
    Object.assign(provider as unknown as Record<string, unknown>, {
      pool, schemaVersion: 8, schemaContractState: "ready",
    });
    const allowedRelations = ["memories"];
    const repository = provider.createDurableJobV2EffectRepository({ allowedRelations });
    allowedRelations[0] = "mengshu_candidates";

    await expect(repository.execute({
      ...effectInput(),
      effectKey: "generic.effect",
      requestFingerprint: "a".repeat(64),
    }, async (work) => {
      await work.query("DELETE FROM mengshu_candidates WHERE id = $1", ["candidate-1"]);
      return { deleted: true };
    })).rejects.toMatchObject({ code: "DURABLE_JOB_EFFECT_UNSAFE_SQL" });
    expect(calls.some((sql) => /DELETE FROM mengshu_candidates/.test(sql))).toBe(false);
    expect(calls.at(-1)).toBe("ROLLBACK");
  });

  test("internal candidate factory has no dynamic property authority receiver", () => {
    const pool = {
      query: vi.fn(),
      connect: vi.fn(),
      end: vi.fn(),
    };
    const provider = new PostgresProvider({
      host: "unused", port: 5432, database: "unused", user: "unused", password: "unused",
    }, "text-embedding-3-small");
    Object.assign(provider as unknown as Record<string, unknown>, {
      pool, schemaVersion: 8, schemaContractState: "ready",
    });
    const internalName = "createDurableJobV2EffectRepositoryInternal";
    expect((provider as unknown as Record<string, unknown>)[internalName]).toBeUndefined();
    expect(Reflect.ownKeys(provider)).not.toContain(internalName);
    expect(Reflect.ownKeys(PostgresProvider.prototype)).not.toContain(internalName);
    expect(() => provider.createDurableJobV2EffectRepository({
      allowedRelations: ["mengshu_candidates"],
    })).toThrow(/candidate effect/i);
    expect(pool.connect).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  test("合法 candidate execute 不可被实例或原型 monkey-patch 截获 authority", async () => {
    const calls: string[] = [];
    const client = {
      release: vi.fn(),
      query: vi.fn(async <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        params: readonly unknown[] = [],
      ) => {
        const normalized = sql.trim().replace(/\s+/g, " ");
        calls.push(normalized);
        if (normalized === "BEGIN" || normalized === "COMMIT") {
          return { rows: [] as Row[], rowCount: 0 };
        }
        if (/SELECT id FROM mengshu_jobs_v2/.test(normalized)) {
          return { rows: [{ id: String(params[0]) } as unknown as Row], rowCount: 1 };
        }
        if (/SELECT job_id, effect_key/.test(normalized)) {
          return { rows: [] as Row[], rowCount: 0 };
        }
        if (/INSERT INTO mengshu_job_v2_effect_receipts/.test(normalized)) {
          return {
            rows: [{
              job_id: String(params[0]),
              effect_key: String(params[1]),
              request_fingerprint: String(params[2]),
              lease_generation: Number(params[3]),
              result: JSON.parse(String(params[4])),
              committed_at: 110,
            } as unknown as Row],
            rowCount: 1,
          };
        }
        throw new Error(`unexpected SQL: ${normalized}`);
      }),
    };
    const pool = {
      query: vi.fn(),
      connect: vi.fn(async () => client),
      end: vi.fn(),
    };
    const provider = new PostgresProvider({
      host: "unused", port: 5432, database: "unused", user: "unused", password: "unused",
    }, "text-embedding-3-small");
    Object.assign(provider as unknown as Record<string, unknown>, {
      pool, schemaVersion: 8, schemaContractState: "ready",
    });

    const internalName = "createDurableJobV2EffectRepositoryInternal";
    let capturedAuthority: unknown;
    const ownTrap = vi.fn((...args: unknown[]) => {
      capturedAuthority = args[3];
      throw new Error("instance trap reached");
    });
    Object.defineProperty(provider, internalName, {
      configurable: true,
      value: ownTrap,
    });

    await expect(candidateBundle(provider, () => 100).executeCandidateEffect(
      { effectInput: effectInput(), context: {}, semanticRequest, candidates: [] },
    )).resolves.toMatchObject({ status: "applied" });
    expect(ownTrap).not.toHaveBeenCalled();
    delete (provider as unknown as Record<string, unknown>)[internalName];

    const prototype = PostgresProvider.prototype as unknown as Record<string, unknown>;
    const priorDescriptor = Object.getOwnPropertyDescriptor(prototype, internalName);
    const prototypeTrap = vi.fn((...args: unknown[]) => {
      capturedAuthority = args[3];
      throw new Error("prototype trap reached");
    });
    Object.defineProperty(prototype, internalName, {
      configurable: true,
      value: prototypeTrap,
    });
    try {
      await expect(candidateBundle(provider, () => 100).executeCandidateEffect(
        {
          effectInput: effectInput({ id: "job-2" }),
          context: {},
          semanticRequest,
          candidates: [],
        },
      )).resolves.toMatchObject({ status: "applied" });
    } finally {
      if (priorDescriptor) Object.defineProperty(prototype, internalName, priorDescriptor);
      else delete prototype[internalName];
    }
    expect(prototypeTrap).not.toHaveBeenCalled();
    expect(capturedAuthority).toBeUndefined();
    expect(Reflect.ownKeys(provider)).not.toContain(internalName);
    expect(Reflect.ownKeys(PostgresProvider.prototype)).not.toContain(internalName);
    expect((provider as unknown as Record<string, unknown>)[internalName]).toBeUndefined();
    const bundle = provider.createDurableJobV2RuntimeBundle({
      clock: () => 100,
      tokenFactory: () => "a".repeat(32),
      backoffMs: () => 100,
      effectClock: vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(110),
    });
    const publicExecuteTrap = vi.fn(() => {
      throw new Error("public execute monkey patch reached");
    });
    Object.defineProperty(provider, "executeCandidateEffect", {
      configurable: true,
      value: publicExecuteTrap,
    });
    try {
      await expect(bundle.executeCandidateEffect({
        effectInput: effectInput({ id: "job-3" }),
        context: {},
        semanticRequest,
        candidates: [],
      })).resolves.toMatchObject({ status: "applied" });
    } finally {
      delete (provider as unknown as Record<string, unknown>).executeCandidateEffect;
    }
    expect(publicExecuteTrap).not.toHaveBeenCalled();
    expect(calls.filter((sql) => sql === "COMMIT")).toHaveLength(3);
  });

  test("malformed lease, semantic request and 9D context fail before initialize", async () => {
    const provider = new PostgresProvider({
      host: "unused", port: 5432, database: "unused", user: "unused", password: "unused",
    }, "text-embedding-3-small");
    const initialize = vi.spyOn(provider, "initialize").mockRejectedValue(
      new Error("initialize must not run for malformed requests"),
    );
    const base = {
      effectInput: effectInput(),
      context: { workspaceId: "workspace-a", sessionId: "session-a" },
      semanticRequest,
      candidates: [],
    };
    const validCandidate = {
      id: "candidate-1", text: "remember this safe rule", kind: "constraint",
      confidence: 0.9, evidenceIds: ["observation-1"], metadata: {}, createdAt: 100,
    };
    const getter = vi.fn(() => ({}));
    const accessorCandidate = { ...validCandidate };
    Object.defineProperty(accessorCandidate, "metadata", { enumerable: true, get: getter });
    const cyclicMetadata: Record<string, unknown> = {};
    cyclicMetadata.self = cyclicMetadata;
    const invalid = [
      { ...base, effectInput: effectInput({ id: "bad\u0000job" }) },
      { ...base, effectInput: effectInput({ leaseToken: "short" }) },
      { ...base, effectInput: effectInput({ scope: { ...scope, workspaceId: "forbidden" } }) },
      { ...base, effectInput: effectInput({ scope: { ...scope, tenantId: "bad\ud800tenant" } }) },
      { ...base, context: { workspaceId: "bad\u0000workspace" } },
      { ...base, context: { workspaceId: "bad\ud800workspace" } },
      { ...base, context: { workspaceId: undefined } },
      { ...base, context: { workspaceId: "workspace-a", foreign: true } },
      { ...base, context: new Date(0) },
      { ...base, semanticRequest: { ...semanticRequest, text: "bad\u0000text" } },
      { ...base, semanticRequest: { ...semanticRequest, traceId: "bad\ud800trace" } },
      { ...base, semanticRequest: { ...semanticRequest, version: 2 } },
      { ...base, effectKey: "caller-controlled" },
      { ...base, requestFingerprint: "a".repeat(64) },
      { ...base, candidates: [accessorCandidate] },
      { ...base, candidates: [new Proxy(validCandidate, { get: vi.fn(Reflect.get) })] },
      { ...base, candidates: [{ ...validCandidate, [Symbol("foreign")]: true }] },
      { ...base, candidates: [{ ...validCandidate, metadata: cyclicMetadata }] },
    ];
    const bundle = candidateBundle(provider);
    for (const value of invalid) {
      await expect(bundle.executeCandidateEffect(value as never)).rejects.toThrow(/candidate (?:effect|input)/i);
    }
    expect(initialize).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
  });
});
