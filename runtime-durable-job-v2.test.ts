import { describe, expect, test, vi } from "vitest";

import {
  createDurableJobHandlerRegistry,
  createDurableJobV2,
  deriveDurableJobV2DomainDedupeKey,
  leaseDurableJobV2,
  type DurableJobV2,
  type DurableJobV2Scope,
} from "./packages/core/src/storage/repositories/job-v2.js";
import {
  PostgresProvider,
  type PostgresDurableJobV2RuntimeBundle,
} from "./packages/core/src/db/providers/postgres.js";
import {
  PostgresDurableJobV2Repository,
  type PostgresDurableJobV2Dependencies,
  type PostgresDurableJobV2EnqueueInput,
  type PostgresDurableJobV2OperationResult,
} from "./packages/core/src/storage/repositories/postgres-job-v2.js";
import {
  createAuthoritativeDurableJobV2WorkerHandlerRegistry,
  runNextDurableJobV2,
  type DurableJobV2RepositoryPort,
} from "./server/workers-v2.js";
import {
  RUNTIME_DURABLE_JOB_V2_LIMITATIONS,
  RuntimeDurableJobV2Error,
  createRuntimeDurableJobV2Enqueuer,
} from "./runtime-durable-job-v2.js";

const scope: DurableJobV2Scope = {
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "mengshu",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "working-context",
  visibility: "private",
};

class FakeDurableRepository extends PostgresDurableJobV2Repository {
  readonly enqueueInputs: PostgresDurableJobV2EnqueueInput[] = [];
  private readonly byDedupe = new Map<string, DurableJobV2>();

  constructor(private readonly dependencies: PostgresDurableJobV2Dependencies) {
    super({ connect: async () => { throw new Error("offline test must not connect"); } }, dependencies);
  }

  override async enqueue(input: PostgresDurableJobV2EnqueueInput): Promise<DurableJobV2> {
    this.enqueueInputs.push(input);
    const existing = this.byDedupe.get(input.dedupeKey);
    if (existing) return existing;
    const job = createDurableJobV2(input, {
      registry: this.dependencies.registry,
      now: this.dependencies.clock(),
    });
    this.byDedupe.set(input.dedupeKey, job);
    return job;
  }

  override async reap(): Promise<PostgresDurableJobV2OperationResult> { return { applied: 0 }; }
  override async quarantineUnknown(): Promise<PostgresDurableJobV2OperationResult> { return { applied: 0 }; }
  override async lease(): Promise<PostgresDurableJobV2OperationResult> { return { applied: 0 }; }
  override async renew(): Promise<PostgresDurableJobV2OperationResult> { return { applied: 0 }; }
  override async complete(): Promise<PostgresDurableJobV2OperationResult> { return { applied: 0 }; }
  override async fail(): Promise<PostgresDurableJobV2OperationResult> { return { applied: 0 }; }
}

function nativeComposition(overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}) {
  const handlers = {
    build_tree: vi.fn(async () => undefined),
    extract_candidate: vi.fn(async () => undefined),
    extract_graph: vi.fn(async () => undefined),
    ...overrides,
  };
  const registry = createAuthoritativeDurableJobV2WorkerHandlerRegistry(handlers);
  const dependencies: PostgresDurableJobV2Dependencies = {
    registry: createDurableJobHandlerRegistry(registry.types),
    clock: () => 100,
    tokenFactory: () => "a".repeat(32),
    backoffMs: () => 100,
  };
  const fakeRepository = new FakeDurableRepository(dependencies);
  const provider = new PostgresProvider({
    host: "unused",
    port: 5432,
    database: "unused",
    user: "unused",
    password: "unused",
  }, "text-embedding-3-small");
  const runtimeBundle = provider.createDurableJobV2RuntimeBundle({
    clock: () => 100,
    tokenFactory: () => "a".repeat(32),
    backoffMs: () => 100,
  });
  Object.assign(provider as unknown as Record<string, unknown>, {
    pool: { end: vi.fn(async () => undefined) },
    schemaVersion: 10,
    schemaContractState: "ready",
  });
  vi.spyOn(runtimeBundle.repository, "enqueue")
    .mockImplementation((input) => fakeRepository.enqueue(input));
  const capability = Object.freeze({ runtimeBundle, scope: Object.freeze({ ...scope }) });
  return { handlers, registry, repository: fakeRepository, provider, runtimeBundle, capability };
}

function extractPayload(metadata?: unknown) {
  return {
    scope: { ...scope },
    text: "User always prefers concise replies",
    traceId: "observation-1",
    intent: "remember",
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe("runtime durable job v2 enqueue boundary", () => {
  test("复制/伪造 bundle 与裸 low-level repository 在 enqueue/DB 前 fail-closed", () => {
    const composition = nativeComposition();
    const lowLevelRepository = new FakeDurableRepository({
      registry: createDurableJobHandlerRegistry(composition.registry.types),
      clock: () => 100,
      tokenFactory: () => "a".repeat(32),
      backoffMs: () => 100,
    });
    const fakeBundle = {
      ...composition.runtimeBundle,
      repository: lowLevelRepository,
    } as PostgresDurableJobV2RuntimeBundle;

    for (const invalid of [
      { repository: lowLevelRepository, scope },
      { runtimeBundle: { ...composition.runtimeBundle }, scope },
      { runtimeBundle: fakeBundle, scope },
    ]) {
      expect(() => createRuntimeDurableJobV2Enqueuer(invalid as never, {
        defaultScope: scope,
      })).toThrow(new RuntimeDurableJobV2Error("CAPABILITY_UNAVAILABLE"));
    }
    expect(composition.repository.enqueueInputs).toEqual([]);
    expect(lowLevelRepository.enqueueInputs).toEqual([]);
  });

  test("trusted native capability enqueue dedupe 绑定 type + persisted ID，重复返回既有 id", async () => {
    const composition = nativeComposition();
    let id = 0;
    const enqueuer = createRuntimeDurableJobV2Enqueuer(composition.capability, {
      defaultScope: scope,
      idFactory: () => `job-${++id}`,
    });

    const first = await enqueuer.enqueue({ type: "extract_candidate", payload: extractPayload() });
    const duplicate = await enqueuer.enqueue({ type: "extract_candidate", payload: extractPayload() });

    expect(first).toBe("job-1");
    expect(duplicate).toBe(first);
    expect(composition.repository.enqueueInputs).toHaveLength(2);
    expect(composition.repository.enqueueInputs[0]).toMatchObject({
      type: "extract_candidate",
      dedupeKey: deriveDurableJobV2DomainDedupeKey(
        "extract_candidate",
        "observation-1",
        {},
      ),
      scope,
      maxAttempts: 3,
    });
    expect(RUNTIME_DURABLE_JOB_V2_LIMITATIONS).toEqual({
      ingestionStoreJobs: "legacy_v1_not_consumed_by_v2",
      sessionCommit: "unsupported_v2_job_types_fail_closed",
      nativeHandlers: "required_for_production_serve",
      providerBinding: "trusted_composition_must_bind_runtime_db",
    });
  });

  test("schema readiness 未到 v10 时拒绝 enqueue，不产生积压 job", async () => {
    const composition = nativeComposition();
    Object.assign(composition.provider as unknown as Record<string, unknown>, {
      schemaVersion: 9,
      schemaContractState: "ready",
    });
    const enqueuer = createRuntimeDurableJobV2Enqueuer(composition.capability, {
      defaultScope: scope,
      idFactory: () => "job-1",
    });

    await expect(enqueuer.enqueue({
      type: "extract_candidate",
      payload: extractPayload(),
    })).rejects.toEqual(new RuntimeDurableJobV2Error("CAPABILITY_UNAVAILABLE"));
    expect(composition.repository.enqueueInputs).toEqual([]);
    expect((composition.provider as unknown as { pool: { end: ReturnType<typeof vi.fn> } })
      .pool.end).not.toHaveBeenCalled();
    expect(composition.provider).toMatchObject({
      schemaVersion: 9,
      schemaContractState: "ready",
    });
  });

  test("相同 trace 在不同 workspace/session 生成不同 domain dedupe", async () => {
    const composition = nativeComposition();
    let id = 0;
    const enqueuer = createRuntimeDurableJobV2Enqueuer(composition.capability, {
      defaultScope: scope,
      idFactory: () => `job-context-${++id}`,
    });
    const payload = extractPayload();
    const first = await enqueuer.enqueue({
      type: "extract_candidate",
      payload: { ...payload, scope: { ...scope, workspaceId: "workspace-a", sessionId: "session" } },
    });
    const second = await enqueuer.enqueue({
      type: "extract_candidate",
      payload: { ...payload, scope: { ...scope, workspaceId: "workspace-b", sessionId: "session" } },
    });

    expect(first).not.toBe(second);
    expect(composition.repository.enqueueInputs.map((input) => input.dedupeKey))
      .toEqual([
        deriveDurableJobV2DomainDedupeKey("extract_candidate", "observation-1", {
          workspaceId: "workspace-a", sessionId: "session",
        }),
        deriveDurableJobV2DomainDedupeKey("extract_candidate", "observation-1", {
          workspaceId: "workspace-b", sessionId: "session",
        }),
      ]);
  });

  test("cross-scope 与 unsupported 类型在 repository 前 fail-closed", async () => {
    const composition = nativeComposition();
    const enqueuer = createRuntimeDurableJobV2Enqueuer(composition.capability, {
      defaultScope: scope,
      idFactory: () => "job-1",
    });

    await expect(enqueuer.enqueue({
      type: "extract_candidate",
      payload: { ...extractPayload(), scope: { ...scope, tenantId: "tenant-b" } },
    })).rejects.toMatchObject({ code: "JOB_SCOPE_MISMATCH" });
    await expect(enqueuer.enqueue({
      type: "refresh_slot_snapshot",
      payload: extractPayload(),
    })).rejects.toMatchObject({ code: "JOB_TYPE_UNSUPPORTED" });
    await expect(enqueuer.enqueue({
      type: "embed_chunk",
      payload: extractPayload(),
    })).rejects.toBeInstanceOf(RuntimeDurableJobV2Error);
    await expect(enqueuer.enqueue({
      type: "extract_candidate",
      payload: {
        ...extractPayload(),
        scope: { ...scope, tenantOverride: "tenant-b" },
      },
    })).rejects.toMatchObject({ code: "JOB_PAYLOAD_INVALID" });
    expect(composition.repository.enqueueInputs).toEqual([]);
  });

  test("strict JSON 拒绝 array extra/symbol/accessor/sparse 与 object undefined/getter/prototype/cycle", async () => {
    const composition = nativeComposition();
    const enqueuer = createRuntimeDurableJobV2Enqueuer(composition.capability, {
      defaultScope: scope,
    });
    const extraArray = ["ok"] as unknown[] & { extra?: string };
    extraArray.extra = "forbidden";
    const symbolArray = ["ok"] as unknown[] & Record<symbol, unknown>;
    symbolArray[Symbol("forbidden")] = true;
    const accessorArray = ["ok"];
    Object.defineProperty(accessorArray, "0", { enumerable: true, get: () => "getter" });
    const sparseArray = new Array(1);
    const getterObject: Record<string, unknown> = {};
    Object.defineProperty(getterObject, "value", { enumerable: true, get: () => "getter" });
    const inheritedObject = Object.create({ inherited: true }) as Record<string, unknown>;
    inheritedObject.value = "own";
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const invalidValues = [
      extraArray,
      symbolArray,
      accessorArray,
      sparseArray,
      { value: undefined },
      getterObject,
      inheritedObject,
      cycle,
    ];

    for (const metadata of invalidValues) {
      await expect(enqueuer.enqueue({
        type: "extract_candidate",
        payload: extractPayload(metadata),
      })).rejects.toMatchObject({ code: "JOB_PAYLOAD_INVALID" });
    }
    expect(composition.repository.enqueueInputs).toEqual([]);
  });

  test("scope 可选 workspace/session 仅接受安全非空字符串", async () => {
    const composition = nativeComposition();
    const enqueuer = createRuntimeDurableJobV2Enqueuer(composition.capability, {
      defaultScope: scope,
    });

    for (const invalid of ["", "bad\nidentity", 42, { nested: true }]) {
      for (const field of ["workspaceId", "sessionId"] as const) {
        await expect(enqueuer.enqueue({
          type: "extract_candidate",
          payload: {
            ...extractPayload(),
            scope: { ...scope, [field]: invalid },
          },
        })).rejects.toMatchObject({ code: "JOB_PAYLOAD_INVALID" });
      }
    }
    expect(composition.repository.enqueueInputs).toEqual([]);
  });

  test("runtime identity 与 core SSOT/H1 trace 上限一致，拒绝 C1、孤立 surrogate 与 239 trace", async () => {
    const composition = nativeComposition();
    const enqueuer = createRuntimeDurableJobV2Enqueuer(composition.capability, {
      defaultScope: scope,
      idFactory: () => "job-1",
    });
    const invalidTraceIds = [
      `trace\u0085id`,
      `trace\u009fid`,
      `trace\ud800id`,
      "t".repeat(239),
    ];

    for (const traceId of invalidTraceIds) {
      await expect(enqueuer.enqueue({
        type: "extract_candidate",
        payload: { ...extractPayload(), traceId },
      })).rejects.toMatchObject({ code: "JOB_PAYLOAD_INVALID" });
    }
    await expect(enqueuer.enqueue({
      type: "extract_candidate",
      payload: { ...extractPayload(), traceId: "t".repeat(238) },
    })).resolves.toBe("job-1");
    expect(composition.repository.enqueueInputs).toHaveLength(1);
  });

  test("cooperative native handler 在 worker abort race 中不留下后台副作用或 fail/retry", async () => {
    const started = deferred();
    let sideEffects = 0;
    const nativeHandler = vi.fn(async (_job: DurableJobV2, context: { signal: AbortSignal }) => {
      started.resolve();
      if (!context.signal.aborted) {
        await new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      if (!context.signal.aborted) sideEffects += 1;
    });
    const composition = nativeComposition({ extract_candidate: nativeHandler });
    const queued = createDurableJobV2({
      id: "job-race",
      type: "extract_candidate",
      payload: extractPayload(),
      dedupeKey: "extract_candidate:observation-1",
      scope,
      maxAttempts: 3,
    }, { registry: createDurableJobHandlerRegistry(composition.registry.types), now: 100 });
    const running = leaseDurableJobV2(queued, {
      owner: "worker-a",
      now: 101,
      leaseMs: 1_000,
      tokenFactory: () => "b".repeat(32),
    }).job;
    const complete = vi.fn(async () => ({ applied: 0 as const }));
    const fail = vi.fn(async () => ({ applied: 0 as const }));
    const repository: DurableJobV2RepositoryPort = {
      reap: async () => ({ applied: 0 }),
      quarantineUnknown: async () => ({ applied: 0 }),
      lease: async () => ({ applied: 1, job: running }),
      renew: async () => ({ applied: 0 }),
      complete,
      fail,
    };
    const abort = new AbortController();
    const executing = runNextDurableJobV2(repository, {
      scope,
      workerId: "worker-a",
      leaseMs: 1_000,
      heartbeatIntervalMs: 500,
      registry: composition.registry,
      signal: abort.signal,
    });

    await started.promise;
    abort.abort();
    await expect(executing).resolves.toMatchObject({ status: "aborted", id: "job-race" });
    expect(sideEffects).toBe(0);
    expect(complete).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
    expect(nativeHandler).toHaveBeenCalledTimes(1);
  });
});
