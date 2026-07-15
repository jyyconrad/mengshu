import { describe, expect, test, vi } from "vitest";
import type { DatabaseProvider, MemoryEntry, MemoryQueryOptions } from "./db/types.js";
import {
  DATABASE_STORE_CLEANUP_WARNING,
  DatabaseStoreCleanupError,
} from "./db/types.js";
import { createMengshuRuntime, toFriendlyMengshuError } from "./runtime.js";
import type { MemoryConfig } from "./config.js";
import { PostgresTreeRepository } from "./tree/postgres-repository.js";
import type { Embeddings } from "./processing/embeddings.js";
import { createEmbeddingSpace, type KnownEmbeddingSpace } from "./packages/core/src/domain/embedding-space.js";
import type { MemoryRecord, MemoryScope } from "./packages/core/src/domain/types.js";
import type { TreeRepository } from "./tree/types.js";
import type {
  AuthorityScopedForgetService,
  MemoryService,
} from "./packages/core/src/domain/service-types.js";
import { isAuthorityScopedForgetCapability } from "./packages/core/src/service/authority-forget-capability.js";
import { PostgresForgetTransactionPort } from "./packages/core/src/db/providers/postgres-forget-transaction.js";
import { PostgresProvider } from "./packages/core/src/db/providers/postgres.js";
import {
  PostgresDurableJobV2Repository,
  type PostgresDurableJobV2Dependencies,
  type PostgresDurableJobV2EnqueueInput,
} from "./packages/core/src/storage/repositories/postgres-job-v2.js";
import {
  createDurableJobV2,
  createDurableJobHandlerRegistry,
  deriveDurableJobV2DomainDedupeKey,
  type DurableJobV2,
} from "./packages/core/src/storage/repositories/job-v2.js";
import { createAuthoritativeDurableJobV2WorkerHandlerRegistry } from "./server/workers-v2.js";
import {
  createNativeDurableJobV2ServeCapability,
  createServeRuntimeHost,
} from "./server/runtime-host-factory.js";
import { RuntimeDurableJobV2Error } from "./runtime-durable-job-v2.js";
import {
  PostgresAtomicMemoryStorePort,
  type PostgresMemoryWriteClient,
} from "./packages/core/src/service/write-kernel-transaction.js";

function rejectingPostgresForgetPort(message: string): PostgresForgetTransactionPort {
  return new PostgresForgetTransactionPort({
    connect: async () => {
      throw new Error(message);
    },
  });
}

class FakeDb implements DatabaseProvider {
  initialize = vi.fn(async () => {});
  close = vi.fn(async () => {});
  store = vi.fn(async (entries: MemoryEntry[]) => ({
    inserted: entries.length,
    duplicates: 0,
    records: entries.map((entry) => ({
      requestedId: entry.id,
      persistedId: entry.id,
      stored: true,
    })),
  }));
  query = vi.fn(async (_options: MemoryQueryOptions) => []);
  delete = vi.fn(async (_ids: string[]) => {});
  deleteByFilter = vi.fn(async (_filter: Record<string, unknown>) => 0);
  existsByContentHash = vi.fn(async (_contentHashes: string[]) => []);
  count = vi.fn(async (_filter?: Record<string, unknown>) => 0);
  getTableStats = vi.fn(async () => [{ name: "memories" as const, count: 0 }]);
}

class RegistryFakeDb extends FakeDb {
  getActiveEmbeddingSpace = vi.fn<() => Promise<KnownEmbeddingSpace | null>>(
    async () => null,
  );
}

type RuntimePostgresProvider = PostgresProvider & RegistryFakeDb;

function runtimePostgresProvider(): RuntimePostgresProvider {
  const provider = new PostgresProvider({
    host: "unused",
    port: 5432,
    database: "unused",
    user: "unused",
    password: "unused",
  }, "text-embedding-3-small");
  return Object.assign(provider, {
    initialize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    store: vi.fn(async (entries: MemoryEntry[]) => ({
      inserted: entries.length,
      duplicates: 0,
      records: entries.map((entry) => ({
        requestedId: entry.id,
        persistedId: entry.id,
        stored: true,
      })),
    })),
    query: vi.fn(async (_options: MemoryQueryOptions) => []),
    delete: vi.fn(async (_ids: string[]) => {}),
    deleteByFilter: vi.fn(async (_filter: Record<string, unknown>) => 0),
    existsByContentHash: vi.fn(async (_contentHashes: string[]) => []),
    count: vi.fn(async (_filter?: Record<string, unknown>) => 0),
    getTableStats: vi.fn(async () => [{ name: "memories" as const, count: 0 }]),
    getActiveEmbeddingSpace: vi.fn<() => Promise<KnownEmbeddingSpace | null>>(async () => null),
    // This helper only borrows PostgresProvider's durable-v2 brand/read methods;
    // its storage is a legacy vi.fn, not a fake SQL transaction.
    createAtomicMemoryStorePort: undefined,
  }) as RuntimePostgresProvider;
}

function trustedDurableComposition(
  scope: MemoryScope & { visibility: "private" },
  failOnceTypes: readonly string[] = [],
) {
  const registry = createAuthoritativeDurableJobV2WorkerHandlerRegistry({
    build_tree: async () => undefined,
    extract_candidate: async () => undefined,
    extract_graph: async () => undefined,
  });
  const dependencies: PostgresDurableJobV2Dependencies = {
    registry: createDurableJobHandlerRegistry(registry.types),
    clock: () => 100,
    tokenFactory: () => "a".repeat(32),
    backoffMs: () => 100,
  };
  const provider = runtimePostgresProvider();
  const runtimeBundle = provider.createDurableJobV2RuntimeBundle({
    clock: dependencies.clock,
    tokenFactory: dependencies.tokenFactory,
    backoffMs: dependencies.backoffMs,
  });
  Object.assign(provider as unknown as Record<string, unknown>, {
    schemaVersion: 11,
    schemaContractState: "ready",
  });
  const repository = runtimeBundle.repository as PostgresDurableJobV2Repository & {
    enqueueInputs: PostgresDurableJobV2EnqueueInput[];
    createdJobs: DurableJobV2[];
  };
  repository.enqueueInputs = [];
  repository.createdJobs = [];
  const byDedupe = new Map<string, DurableJobV2>();
  const failOnce = new Set(failOnceTypes);
  repository.enqueue = async (input: PostgresDurableJobV2EnqueueInput): Promise<DurableJobV2> => {
    repository.enqueueInputs.push(input);
    if (failOnce.delete(input.type)) throw new Error(`injected ${input.type} enqueue failure`);
    const key = `${JSON.stringify(input.scope)}:${input.dedupeKey}`;
    const existing = byDedupe.get(key);
    if (existing) return existing;
    const job = createDurableJobV2(input, {
      registry: dependencies.registry,
      now: dependencies.clock(),
    });
    byDedupe.set(key, job);
    repository.createdJobs.push(job);
    return job;
  };
  return {
    provider,
    repository,
    runtimeBundle,
    capability: createNativeDurableJobV2ServeCapability({
      repository,
      registry,
      scope: { ...scope },
    }),
  };
}

const config: MemoryConfig = {
  embedding: {
    provider: "openai",
    apiKey: "test-key",
    baseURL: "http://localhost:9999/v1",
    model: "text-embedding-3-small",
  },
  dbType: "lancedb",
  dbPath: "/tmp/mengshu-test",
};

const postgresGuardConfig: MemoryConfig = {
  ...config,
  dbType: "postgres",
  dbPath: undefined,
};

function runtimeSpace(overrides: Partial<{ model: string; dim: number }> = {}) {
  return createEmbeddingSpace({
    provider: "openai",
    baseURL: "http://localhost:9999/v1",
    model: overrides.model ?? "text-embedding-3-small",
    dim: overrides.dim ?? 1536,
    normalization: "none",
  });
}

function fakeEmbeddings(): Embeddings {
  return {
    embed: vi.fn(async () => Array.from({ length: 1536 }, () => 0.01)),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(() => Array.from({ length: 1536 }, () => 0.01))),
  } as unknown as Embeddings;
}

function fakeTreeRepository(overrides: Partial<TreeRepository> = {}): TreeRepository {
  return {
    upsertLeaf: vi.fn(async () => {}),
    getLeaf: vi.fn(async () => undefined),
    listLeaves: vi.fn(async () => []),
    upsertBuffer: vi.fn(async () => {}),
    getBuffer: vi.fn(async () => undefined),
    deleteBuffer: vi.fn(async () => {}),
    upsertSummary: vi.fn(async () => {}),
    getSummary: vi.fn(async () => undefined),
    listSummaries: vi.fn(async () => []),
    getParent: vi.fn(async () => undefined),
    ...overrides,
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function directMemoryRecord(
  scope: MemoryScope,
  overrides: Partial<MemoryRecord> = {},
): MemoryRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    scope,
    kind: "fact",
    text: "direct memory service write",
    contentHash: "direct-memory-hash",
    importance: 0.8,
    category: "fact",
    dataType: "memory",
    tableName: "memories",
    metadata: {},
    provenance: { source: "user" },
    createdAt: 1,
    vector: [9, 9],
    ...overrides,
  };
}

describe("createMengshuRuntime", () => {
  test("10 个并发 runtime.start 只初始化 DB/registry/tree 一次，完成后才 ready", async () => {
    const db = new RegistryFakeDb();
    db.getActiveEmbeddingSpace.mockResolvedValue(runtimeSpace());
    const treeInitialize = vi.fn(async () => {});
    const runtime = createMengshuRuntime({
      config: postgresGuardConfig,
      resolvedDbPath: "",
      db,
      embeddings: fakeEmbeddings(),
      treeRepository: Object.assign(fakeTreeRepository(), { initialize: treeInitialize }),
    });

    expect(runtime.lifecycle.snapshot()).toEqual({ state: "created", ready: false });
    await Promise.all(Array.from({ length: 10 }, () => runtime.start()));

    expect(db.initialize).toHaveBeenCalledTimes(1);
    expect(db.getActiveEmbeddingSpace).toHaveBeenCalledTimes(1);
    expect(treeInitialize).toHaveBeenCalledTimes(1);
    expect(runtime.lifecycle.snapshot()).toEqual({ state: "ready", ready: true });
  });

  test("tree startup 失败会逆序关闭已启动 DB，runtime 不 ready", async () => {
    const db = new RegistryFakeDb();
    db.getActiveEmbeddingSpace.mockResolvedValue(runtimeSpace());
    const failure = new Error("tree-startup-failed");
    const calls: string[] = [];
    db.close.mockImplementation(async () => { calls.push("db:close"); });
    const treeClose = vi.fn(async () => { calls.push("tree:close"); });
    const runtime = createMengshuRuntime({
      config: postgresGuardConfig,
      resolvedDbPath: "",
      db,
      embeddings: fakeEmbeddings(),
      treeRepository: Object.assign(fakeTreeRepository(), {
        initialize: vi.fn(async () => { throw failure; }),
        close: treeClose,
      }),
    });

    await expect(runtime.start()).rejects.toBe(failure);

    expect(db.close).toHaveBeenCalledTimes(1);
    expect(treeClose).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["tree:close", "db:close"]);
    expect(runtime.lifecycle.snapshot()).toMatchObject({
      state: "failed",
      ready: false,
      failure,
    });
    expect(runtime.embeddingWriteGuard.snapshot().decision.reasonCode).toBe("registry-unavailable");
    expect(runtime.embeddingReadGuard.snapshot().reasonCode).toBe("registry-unavailable");
    await expect(runtime.memoryService.storeMemory({
      record: directMemoryRecord(runtime.defaultScope),
    })).rejects.toMatchObject({ reasonCode: "registry-unavailable" });
    expect(db.store).not.toHaveBeenCalled();
  });

  test("tree initialize/close 双失败聚合后仍逆序关闭 DB 并 reset guards", async () => {
    const db = new RegistryFakeDb();
    db.getActiveEmbeddingSpace.mockResolvedValue(runtimeSpace());
    const initializeFailure = new Error("tree-initialize-failed");
    const closeFailure = new Error("tree-close-failed");
    const runtime = createMengshuRuntime({
      config: postgresGuardConfig,
      resolvedDbPath: "",
      db,
      embeddings: fakeEmbeddings(),
      treeRepository: Object.assign(fakeTreeRepository(), {
        initialize: vi.fn(async () => { throw initializeFailure; }),
        close: vi.fn(async () => { throw closeFailure; }),
      }),
    });

    const failure = await runtime.start().catch((error) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([initializeFailure, closeFailure]);
    expect(db.close).toHaveBeenCalledTimes(1);
    expect(runtime.embeddingWriteGuard.snapshot().decision.reasonCode).toBe("registry-unavailable");
    expect(runtime.lifecycle.snapshot()).toMatchObject({ state: "failed", ready: false, failure });
  });

  test("normal stop reset guards，stopped Postgres direct service 不得 lazy reopen", async () => {
    const db = new RegistryFakeDb();
    db.getActiveEmbeddingSpace.mockResolvedValue(runtimeSpace());
    const runtime = createMengshuRuntime({
      config: postgresGuardConfig,
      resolvedDbPath: "",
      db,
      embeddings: fakeEmbeddings(),
      treeRepository: Object.assign(fakeTreeRepository(), {
        initialize: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      }),
    });
    await runtime.start();
    expect(runtime.embeddingWriteGuard.snapshot().decision.allowed).toBe(true);

    await runtime.stop();

    expect(runtime.lifecycle.snapshot()).toEqual({ state: "stopped", ready: false });
    expect(runtime.embeddingWriteGuard.snapshot().decision.reasonCode).toBe("registry-unavailable");
    expect(runtime.embeddingReadGuard.snapshot().reasonCode).toBe("registry-unavailable");
    await expect(runtime.memoryService.storeMemory({
      record: directMemoryRecord(runtime.defaultScope),
    })).rejects.toMatchObject({ reasonCode: "registry-unavailable" });
    expect(db.store).not.toHaveBeenCalled();
    expect(db.close).toHaveBeenCalledTimes(1);
  });

  test("runtime stop during DB start 立即 fail-closed，未进入 registry 也不得写入", async () => {
    const db = new RegistryFakeDb();
    const dbGate = deferred();
    db.initialize.mockImplementation(() => dbGate.promise);
    db.getActiveEmbeddingSpace.mockResolvedValue(runtimeSpace());
    const runtime = createMengshuRuntime({
      config: postgresGuardConfig,
      resolvedDbPath: "",
      db,
      embeddings: fakeEmbeddings(),
      treeRepository: fakeTreeRepository(),
    });

    const starting = runtime.start();
    await vi.waitFor(() => expect(db.initialize).toHaveBeenCalledTimes(1));
    const stopping = runtime.stop();

    expect(runtime.lifecycle.snapshot()).toEqual({ state: "stopping", ready: false });
    expect(runtime.embeddingWriteGuard.snapshot().decision.reasonCode).toBe("registry-unavailable");
    await expect(runtime.memoryService.storeMemory({
      record: directMemoryRecord(runtime.defaultScope),
    })).rejects.toMatchObject({ reasonCode: "registry-unavailable" });
    expect(db.store).not.toHaveBeenCalled();

    dbGate.resolve();
    await expect(starting).rejects.toMatchObject({ code: "RUNTIME_STOPPING" });
    await stopping;
    expect(db.getActiveEmbeddingSpace).not.toHaveBeenCalled();
    expect(db.close).toHaveBeenCalledTimes(1);
    expect(runtime.lifecycle.snapshot()).toEqual({ state: "stopped", ready: false });
  });

  test("runtime stop during registry read 后，延迟 active 结果不得重新开放写入", async () => {
    const db = new RegistryFakeDb();
    const registryGate = deferred<KnownEmbeddingSpace | null>();
    db.getActiveEmbeddingSpace.mockImplementation(() => registryGate.promise);
    const runtime = createMengshuRuntime({
      config: postgresGuardConfig,
      resolvedDbPath: "",
      db,
      embeddings: fakeEmbeddings(),
      treeRepository: fakeTreeRepository(),
    });

    const starting = runtime.start();
    await vi.waitFor(() => expect(db.getActiveEmbeddingSpace).toHaveBeenCalledTimes(1));
    const stopping = runtime.stop();

    expect(runtime.lifecycle.snapshot()).toEqual({ state: "stopping", ready: false });
    expect(runtime.embeddingWriteGuard.snapshot().decision.reasonCode).toBe("registry-unavailable");
    await expect(runtime.memoryService.storeMemory({
      record: directMemoryRecord(runtime.defaultScope),
    })).rejects.toMatchObject({ reasonCode: "registry-unavailable" });

    registryGate.resolve(runtimeSpace());
    await expect(starting).rejects.toMatchObject({ code: "RUNTIME_STOPPING" });
    expect(runtime.embeddingWriteGuard.snapshot().decision.reasonCode).toBe("registry-unavailable");
    expect(runtime.embeddingReadGuard.snapshot().reasonCode).toBe("registry-unavailable");
    await expect(runtime.memoryService.storeMemory({
      record: directMemoryRecord(runtime.defaultScope),
    })).rejects.toMatchObject({ reasonCode: "registry-unavailable" });
    expect(db.store).not.toHaveBeenCalled();

    await stopping;
    expect(db.close).toHaveBeenCalledTimes(1);
    expect(runtime.lifecycle.snapshot()).toEqual({ state: "stopped", ready: false });
  });

  test("runtime stop during tree start 让当前 start 拒绝并在清理后 reset guards", async () => {
    const db = new RegistryFakeDb();
    db.getActiveEmbeddingSpace.mockResolvedValue(runtimeSpace());
    const treeGate = deferred();
    const treeClose = vi.fn(async () => {});
    const runtime = createMengshuRuntime({
      config: postgresGuardConfig,
      resolvedDbPath: "",
      db,
      embeddings: fakeEmbeddings(),
      treeRepository: Object.assign(fakeTreeRepository(), {
        initialize: vi.fn(() => treeGate.promise),
        close: treeClose,
      }),
    });

    const starting = runtime.start();
    await vi.waitFor(() => expect(db.getActiveEmbeddingSpace).toHaveBeenCalledTimes(1));
    const stopping = runtime.stop();
    expect(runtime.lifecycle.snapshot()).toEqual({ state: "stopping", ready: false });
    expect(runtime.embeddingWriteGuard.snapshot().decision.reasonCode).toBe("registry-unavailable");
    expect(runtime.embeddingReadGuard.snapshot().reasonCode).toBe("registry-unavailable");
    await expect(runtime.memoryService.storeMemory({
      record: directMemoryRecord(runtime.defaultScope),
    })).rejects.toMatchObject({ reasonCode: "registry-unavailable" });
    expect(db.store).not.toHaveBeenCalled();
    treeGate.resolve();

    await expect(starting).rejects.toMatchObject({ code: "RUNTIME_STOPPING" });
    await stopping;
    expect(treeClose).toHaveBeenCalledTimes(1);
    expect(db.close).toHaveBeenCalledTimes(1);
    expect(runtime.embeddingWriteGuard.snapshot().decision.reasonCode).toBe("registry-unavailable");
    expect(runtime.lifecycle.snapshot()).toEqual({ state: "stopped", ready: false });
  });

  test("runtime.stop 聚合 tree/DB 关闭错误且 lifecycle 保持 failed", async () => {
    const db = new FakeDb();
    const dbFailure = new Error("db-close-failed");
    const treeFailure = new Error("tree-close-failed");
    db.close.mockRejectedValue(dbFailure);
    const runtime = createMengshuRuntime({
      config,
      resolvedDbPath: "/tmp/mengshu-test",
      db,
      embeddings: fakeEmbeddings(),
      treeRepository: Object.assign(fakeTreeRepository(), {
        initialize: vi.fn(async () => {}),
        close: vi.fn(async () => { throw treeFailure; }),
      }),
    });
    await runtime.start();

    const failure = await runtime.stop().catch((error) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([treeFailure, dbFailure]);
    expect(runtime.lifecycle.snapshot()).toMatchObject({
      state: "failed",
      ready: false,
      failure,
    });
    expect(db.close).toHaveBeenCalledTimes(1);
    await expect(runtime.stop()).rejects.toBe(failure);
    expect(db.close).toHaveBeenCalledTimes(1);
  });

  test("Postgres runtime 注入 provider 的真实 forget transaction port", async () => {
    const port = rejectingPostgresForgetPort("postgres-forget-port-used");
    const db = Object.assign(new RegistryFakeDb(), {
      createForgetTransactionPort: vi.fn(() => port),
    });
    const runtime = createMengshuRuntime({
      config: postgresGuardConfig,
      resolvedDbPath: "",
      db,
      embeddings: fakeEmbeddings(),
    });

    await expect(
      (runtime.memoryService as MemoryService & AuthorityScopedForgetService).forget({
        serverAuthority: {
          tenantId: "local",
          userId: "default",
          allow: {
            appIds: ["mengshu"],
            projectIds: ["default"],
            agentIds: ["default"],
            namespaces: ["working-context"],
            visibilities: ["private"],
          },
        },
        clientScope: {
          appId: runtime.defaultScope.appId,
          projectId: runtime.defaultScope.projectId,
          agentId: runtime.defaultScope.agentId,
          namespace: runtime.defaultScope.namespace,
          visibility: runtime.defaultScope.visibility,
        },
        action: "revoke",
        ids: ["11111111-1111-4111-8111-111111111111"],
        idempotencyKey: "runtime-forget-1",
      }),
    ).rejects.toThrow("postgres-forget-port-used");
    expect(db.createForgetTransactionPort).toHaveBeenCalledTimes(1);
    expect(isAuthorityScopedForgetCapability(runtime.authorityScopedForgetCapability)).toBe(true);
  });

  test("非 Postgres runtime 即使 provider 暴露 port 也保持 unavailable", async () => {
    const db = Object.assign(new FakeDb(), {
      createForgetTransactionPort: vi.fn(() => ({
        transaction: vi.fn(),
      })),
    });
    const runtime = createMengshuRuntime({
      config,
      resolvedDbPath: "/tmp/mengshu-test",
      db,
      embeddings: fakeEmbeddings(),
    });

    await expect(
      (runtime.memoryService as MemoryService & AuthorityScopedForgetService).forget({
        serverAuthority: {
          tenantId: "local",
          userId: "default",
          allow: {
            appIds: ["mengshu"],
            projectIds: ["default"],
            agentIds: ["default"],
            namespaces: ["working-context"],
            visibilities: ["private"],
          },
        },
        clientScope: {
          appId: runtime.defaultScope.appId,
          projectId: runtime.defaultScope.projectId,
          agentId: runtime.defaultScope.agentId,
          namespace: runtime.defaultScope.namespace,
          visibility: runtime.defaultScope.visibility,
        },
        action: "revoke",
        ids: ["11111111-1111-4111-8111-111111111111"],
        idempotencyKey: "runtime-forget-2",
      }),
    ).rejects.toMatchObject({ code: "TRANSACTION_UNAVAILABLE" });
    expect(db.createForgetTransactionPort).not.toHaveBeenCalled();
    expect(runtime.authorityScopedForgetCapability).toBeUndefined();
  });

  test("RED: Postgres active fingerprint 漂移后 observation 不得继续 embed/store", async () => {
    const db = new RegistryFakeDb();
    db.getActiveEmbeddingSpace.mockResolvedValue(runtimeSpace({
      model: "text-embedding-3-large",
      dim: 3072,
    }));
    const embeddings = fakeEmbeddings();
    const runtime = createMengshuRuntime({
      config: postgresGuardConfig,
      resolvedDbPath: "",
      db,
      embeddings,
    });

    await runtime.start();
    const result = await runtime.agentFastPath.observeLight({
      scope: runtime.defaultScope,
      eventType: "user_input",
      text: "must not cross embedding spaces",
      intent: "remember",
    });

    expect(runtime.embeddingWriteGuard.snapshot()).toMatchObject({
      enforcement: "enforced",
      decision: { allowed: false, reasonCode: "active-space-mismatch" },
    });
    expect(runtime.lifecycle.snapshot()).toMatchObject({
      state: "degraded",
      ready: false,
      degradedSteps: [{ name: "embedding-registry", reason: "active-space-mismatch" }],
    });
    expect(result.warnings).toEqual([
      expect.stringMatching(/observation_store_failed:.*active-space-mismatch/),
    ]);
    expect(embeddings.embed).not.toHaveBeenCalled();
    expect(db.store).not.toHaveBeenCalled();
  });

  test("Postgres active descriptor match 后允许 observation 写入", async () => {
    const db = new RegistryFakeDb();
    db.getActiveEmbeddingSpace.mockResolvedValue(runtimeSpace());
    const embeddings = fakeEmbeddings();
    const runtime = createMengshuRuntime({
      config: postgresGuardConfig,
      resolvedDbPath: "",
      db,
      embeddings,
    });

    await runtime.start();
    await runtime.agentFastPath.observeLight({
      scope: runtime.defaultScope,
      eventType: "user_input",
      text: "same embedding space",
      intent: "remember",
    });
    await runtime.ingestionPipeline.ingest({
      scope: runtime.defaultScope,
      sourceId: "/docs/allowed.md",
      content: "# allowed\n\nsame embedding space",
    });

    expect(runtime.embeddingWriteGuard.snapshot().decision.reasonCode).toBe("active-space-match");
    expect(embeddings.embed).toHaveBeenCalledTimes(3);
    expect(db.store).toHaveBeenCalledTimes(3);
  });

  test.each([
    ["missing", new RegistryFakeDb(), "registry-active-space-missing"],
    ["mismatch", (() => {
      const db = new RegistryFakeDb();
      db.getActiveEmbeddingSpace.mockResolvedValue(runtimeSpace({ model: "other-model" }));
      return db;
    })(), "active-space-mismatch"],
    ["unavailable", new FakeDb(), "registry-unavailable"],
  ] as const)("Postgres %s 时 public memoryService direct write=0（含预传 vector）", async (
    _case,
    db,
    reasonCode,
  ) => {
    const embeddings = fakeEmbeddings();
    const runtime = createMengshuRuntime({
      config: postgresGuardConfig,
      resolvedDbPath: "",
      db,
      embeddings,
    });
    await runtime.start();

    await expect(runtime.memoryService.storeMemory({
      record: directMemoryRecord(runtime.defaultScope),
    })).rejects.toMatchObject({ reasonCode });
    await expect(runtime.memoryService.storeMemory({
      record: directMemoryRecord(runtime.defaultScope, {
        id: "22222222-2222-4222-8222-222222222222",
        vector: undefined,
      }),
    })).rejects.toMatchObject({ reasonCode });

    expect(embeddings.embed).not.toHaveBeenCalled();
    expect(db.store).not.toHaveBeenCalled();
  });

  test("Postgres active match 时 public memoryService direct write 正常", async () => {
    const db = new RegistryFakeDb();
    db.getActiveEmbeddingSpace.mockResolvedValue(runtimeSpace());
    const embeddings = fakeEmbeddings();
    const runtime = createMengshuRuntime({
      config: postgresGuardConfig,
      resolvedDbPath: "",
      db,
      embeddings,
    });
    await runtime.start();

    await runtime.memoryService.storeMemory({ record: directMemoryRecord(runtime.defaultScope) });
    await runtime.memoryService.storeMemory({
      record: directMemoryRecord(runtime.defaultScope, {
        id: "22222222-2222-4222-8222-222222222222",
        vector: undefined,
      }),
    });

    expect(embeddings.embed).toHaveBeenCalledTimes(1);
    expect(db.store).toHaveBeenCalledTimes(2);
  });

  test("Postgres runtime 检测到 provider-owned atomic port 时 direct write 不走 legacy repository", async () => {
    const db = new RegistryFakeDb();
    db.getActiveEmbeddingSpace.mockResolvedValue(runtimeSpace());
    const sql: string[] = [];
    const client: PostgresMemoryWriteClient = {
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        statement: string,
      ) => {
        sql.push(statement);
        return { rows: [] as Row[], rowCount: /FROM mengshu_write_receipts/.test(statement) ? 0 : 1 };
      },
      release: () => undefined,
    };
    let insertedRecord: MemoryRecord | undefined;
    const atomicStore = new PostgresAtomicMemoryStorePort(
      { connect: async () => client },
      async (transaction, item) => {
        insertedRecord = item;
        await transaction.query('INSERT INTO "memories" (id) VALUES ($1)', [item.id]);
        return { requestedId: item.id, persistedId: item.id, stored: true };
      },
    );
    Object.assign(db, {
      createAtomicMemoryStorePort: () => atomicStore,
    });
    const runtime = createMengshuRuntime({
      config: postgresGuardConfig,
      resolvedDbPath: "",
      db,
      embeddings: fakeEmbeddings(),
      treeRepository: fakeTreeRepository(),
    });
    await runtime.start();

    await expect(runtime.memoryService.storeMemory({
      record: directMemoryRecord(runtime.defaultScope),
    })).resolves.toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      stored: true,
    });
    expect(db.store).not.toHaveBeenCalled();
    expect(sql.some((statement) => /INSERT INTO mengshu_write_audit/.test(statement))).toBe(true);
    expect(sql.some((statement) => /INSERT INTO mengshu_write_outbox/.test(statement))).toBe(true);
    expect(sql.some((statement) => /INSERT INTO mengshu_write_receipts/.test(statement))).toBe(true);
    expect(insertedRecord?.metadata.embeddingSpaceId).toBe(
      runtime.embeddingSpace.embeddingSpaceId,
    );
    expect(insertedRecord?.metadata.embeddingSpaceState).toBe("known-queryable");
    await runtime.stop();
  });

  test("non-Postgres public memoryService 保留 legacy-write-through", async () => {
    const db = new FakeDb();
    const embeddings = fakeEmbeddings();
    const runtime = createMengshuRuntime({
      config,
      resolvedDbPath: "/tmp/mengshu-test",
      db,
      embeddings,
    });
    await runtime.start();

    await expect(runtime.memoryService.storeMemory({
      record: directMemoryRecord(runtime.defaultScope),
    })).resolves.toMatchObject({ stored: true });
    expect(embeddings.embed).not.toHaveBeenCalled();
    expect(db.store).toHaveBeenCalledTimes(1);
  });

  test("Postgres active match 时 recall 仅对 runtime embedding space 执行 ANN", async () => {
    const db = new RegistryFakeDb();
    db.getActiveEmbeddingSpace.mockResolvedValue(runtimeSpace());
    const embeddings = fakeEmbeddings();
    const runtime = createMengshuRuntime({
      config: postgresGuardConfig,
      resolvedDbPath: "",
      db,
      embeddings,
    });

    await runtime.start();
    const result = await runtime.memoryService.recall({ query: "safe ann" });

    expect(runtime.embeddingReadGuard.snapshot()).toMatchObject({
      allowed: true,
      mode: "same-space-ann",
      reasonCode: "active-space-match",
    });
    expect(embeddings.embed).toHaveBeenCalledTimes(1);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query).toHaveBeenCalledWith(expect.objectContaining({
      vector: expect.any(Array),
      filter: {
        embeddingSpaceId: runtime.embeddingSpace.embeddingSpaceId,
        embeddingSpaceState: "known-queryable",
      },
    }));
    expect(result.hits).toEqual([]);
  });

  test.each([
    ["mismatch", runtimeSpace({ model: "text-embedding-3-large", dim: 3072 }), "active-space-mismatch"],
    ["unknown", null, "registry-active-space-missing"],
  ])("Postgres registry %s 时 recall 不 embed、不 query，并 fail-closed", async (_case, activeSpace, reasonCode) => {
    const db = new RegistryFakeDb();
    db.getActiveEmbeddingSpace.mockResolvedValue(activeSpace);
    const embeddings = fakeEmbeddings();
    const runtime = createMengshuRuntime({
      config: postgresGuardConfig,
      resolvedDbPath: "",
      db,
      embeddings,
    });

    await runtime.start();
    const result = await runtime.memoryService.recall({ query: "unsafe ann" });

    expect(runtime.embeddingReadGuard.snapshot()).toMatchObject({
      allowed: false,
      mode: "fail-closed",
      reasonCode,
    });
    expect(embeddings.embed).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
    expect(result.hits).toEqual([]);
  });

  test("read/write mismatch 不影响 lifecycle-only forget transaction", async () => {
    const port = rejectingPostgresForgetPort("forget-transaction-reached");
    const db = Object.assign(new RegistryFakeDb(), {
      createForgetTransactionPort: vi.fn(() => port),
    });
    db.getActiveEmbeddingSpace.mockResolvedValue(runtimeSpace({
      model: "text-embedding-3-large",
      dim: 3072,
    }));
    const embeddings = fakeEmbeddings();
    const runtime = createMengshuRuntime({
      config: postgresGuardConfig,
      resolvedDbPath: "",
      db,
      embeddings,
    });
    await runtime.start();

    await expect(
      (runtime.memoryService as MemoryService & AuthorityScopedForgetService).forget({
        serverAuthority: {
          tenantId: "local",
          userId: "default",
          allow: {
            appIds: ["mengshu"],
            projectIds: ["default"],
            agentIds: ["default"],
            namespaces: ["working-context"],
            visibilities: ["private"],
          },
        },
        clientScope: {
          appId: runtime.defaultScope.appId,
          projectId: runtime.defaultScope.projectId,
          agentId: runtime.defaultScope.agentId,
          namespace: runtime.defaultScope.namespace,
          visibility: runtime.defaultScope.visibility,
        },
        action: "revoke",
        ids: ["11111111-1111-4111-8111-111111111111"],
        idempotencyKey: "runtime-forget-read-mismatch",
      }),
    ).rejects.toThrow("forget-transaction-reached");

    expect(runtime.embeddingReadGuard.snapshot().reasonCode).toBe("active-space-mismatch");
    expect(runtime.embeddingWriteGuard.snapshot().decision.reasonCode).toBe("active-space-mismatch");
    expect(embeddings.embed).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  test("非 Postgres provider 没有可验证 registry 时 recall 严格 fail-closed", async () => {
    const db = new FakeDb();
    const embeddings = fakeEmbeddings();
    const runtime = createMengshuRuntime({
      config,
      resolvedDbPath: "/tmp/mengshu-test",
      db,
      embeddings,
    });

    await runtime.start();
    const result = await runtime.memoryService.recall({ query: "no unsafe fallback" });

    expect(runtime.embeddingReadGuard.snapshot()).toMatchObject({
      allowed: false,
      mode: "fail-closed",
      reasonCode: "registry-unavailable",
    });
    expect(embeddings.embed).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
    expect(result.hits).toEqual([]);
  });

  test("Postgres active missing 时 candidate/document/chunk 链全部只读且不 embed/store", async () => {
    const db = new RegistryFakeDb();
    const embeddings = fakeEmbeddings();
    const runtime = createMengshuRuntime({
      config: postgresGuardConfig,
      resolvedDbPath: "",
      db,
      embeddings,
    });
    await runtime.start();

    const candidate = await runtime.candidateRepository.enqueue({
      scope: runtime.defaultScope,
      text: "blocked candidate",
      kind: "fact",
      confidence: 0.9,
      evidenceIds: [],
      metadata: {},
    });
    const review = await runtime.candidateReview.review({ action: "approve", ids: [candidate.id] });
    await expect(runtime.ingestionPipeline.ingest({
      scope: runtime.defaultScope,
      sourceId: "/docs/blocked.md",
      content: "# blocked\n\nno active registry",
    })).rejects.toThrow(/registry-active-space-missing/);
    await expect(runtime.ingestionStore.chunks.upsertMany([{
      id: "blocked-chunk",
      scope: runtime.defaultScope,
      documentId: "blocked-document",
      text: "blocked chunk",
      contentHash: "blocked-chunk-hash",
      ordinal: 0,
      metadata: {},
      provenance: { source: "scan" },
      createdAt: 1,
    }])).rejects.toThrow(/registry-active-space-missing/);

    expect(review.errors).toEqual([
      expect.stringMatching(/promote_failed:.*registry-active-space-missing/),
    ]);
    expect(embeddings.embed).not.toHaveBeenCalled();
    expect(embeddings.embedBatch).not.toHaveBeenCalled();
    expect(db.store).not.toHaveBeenCalled();
    expect(runtime.lifecycle.snapshot()).toMatchObject({
      state: "degraded",
      ready: false,
      degradedSteps: [{ name: "embedding-registry", reason: "registry-active-space-missing" }],
    });
  });

  test("Postgres registry capability unavailable 时保持 read-only diagnostic", async () => {
    const db = new FakeDb();
    const embeddings = fakeEmbeddings();
    const runtime = createMengshuRuntime({
      config: postgresGuardConfig,
      resolvedDbPath: "",
      db,
      embeddings,
    });

    await runtime.start();
    const result = await runtime.agentFastPath.observeLight({
      scope: runtime.defaultScope,
      eventType: "user_input",
      text: "registry capability unavailable",
      intent: "remember",
    });

    expect(runtime.embeddingWriteGuard.snapshot()).toMatchObject({
      enforcement: "enforced",
      decision: { allowed: false, reasonCode: "registry-unavailable" },
    });
    expect(runtime.lifecycle.snapshot()).toMatchObject({
      state: "degraded",
      ready: false,
      degradedSteps: [{ name: "embedding-registry", reason: "registry-capability-missing" }],
    });
    expect(result.warnings).toEqual([
      expect.stringMatching(/observation_store_failed:.*registry-unavailable/),
    ]);
    expect(embeddings.embed).not.toHaveBeenCalled();
    expect(db.store).not.toHaveBeenCalled();
  });

  test("Postgres registry 读取异常时降级为 unavailable，日志不回显 provider error", async () => {
    const db = new RegistryFakeDb();
    db.getActiveEmbeddingSpace.mockRejectedValue(new Error("password=secret-do-not-log"));
    const warnings: string[] = [];
    const runtime = createMengshuRuntime({
      config: postgresGuardConfig,
      resolvedDbPath: "",
      db,
      embeddings: fakeEmbeddings(),
      logger: { warn: (message) => warnings.push(message) },
    });

    await runtime.start();

    expect(runtime.embeddingWriteGuard.snapshot().decision.reasonCode).toBe("registry-unavailable");
    expect(runtime.lifecycle.snapshot()).toMatchObject({
      state: "degraded",
      ready: false,
      degradedSteps: [{ name: "embedding-registry", reason: "registry-read-failed" }],
    });
    expect(warnings).toEqual([
      expect.stringMatching(/embedding registry unavailable.*registry-read-failed/i),
    ]);
    expect(warnings.join("\n")).not.toContain("secret-do-not-log");
  });

  test("非 Postgres 兼容模式显式暴露 legacy-write-through，而不是伪装 match", () => {
    const runtime = createMengshuRuntime({
      config,
      resolvedDbPath: "/tmp/mengshu-test",
      db: new FakeDb(),
    });

    expect(runtime.embeddingWriteGuard.snapshot()).toMatchObject({
      enforcement: "legacy-write-through",
      decision: { allowed: false, reasonCode: "registry-unavailable" },
    });
  });
  test("constructs shared runtime and delegates lifecycle to db", async () => {
    const db = new FakeDb();
    const runtime = createMengshuRuntime({
      config,
      resolvedDbPath: "/tmp/mengshu-test",
      appId: "test-app",
      db,
    });

    expect(runtime.memoryService).toBeDefined();
    expect(runtime.ingestionPipeline).toBeDefined();
    expect(runtime.consoleApi).toBeDefined();
    expect(runtime.agentFastPath).toBeDefined();
    expect(runtime.embeddingSpace).toMatchObject({
      state: "known-queryable",
      fingerprint: {
        provider: "openai",
        baseURL: "http://localhost:9999/v1",
        model: "text-embedding-3-small",
        dim: 1536,
        normalization: "none",
      },
    });
    expect(JSON.stringify(runtime.embeddingSpace)).not.toContain("test-key");
    expect(Object.keys(runtime.handlers).sort()).toEqual([
      "build_tree",
      "extract_candidate",
      "extract_graph",
    ]);

    await runtime.start();
    await runtime.stop();
    expect(db.initialize).toHaveBeenCalledTimes(1);
    expect(db.close).toHaveBeenCalledTimes(1);
    expect(runtime.lifecycle.snapshot()).toEqual({ state: "stopped", ready: false });
    await expect(runtime.start()).rejects.toMatchObject({ code: "RUNTIME_STOPPED" });
  });

  test("embedding fingerprint uses the model dimension, not an inactive knowledge-base hint", () => {
    const runtime = createMengshuRuntime({
      config: {
        ...config,
        knowledgeBases: {
          enabled: true,
          autoCreateTables: false,
          vectorDimensions: 1024,
        },
      },
      resolvedDbPath: "/tmp/mengshu-test",
      db: new FakeDb(),
    });

    expect(runtime.embeddingSpace.fingerprint.dim).toBe(1536);
  });

  test("keeps friendly config errors", () => {
    expect(() =>
      createMengshuRuntime({
        config: {
          ...config,
          embedding: { ...config.embedding, apiKey: "" },
        },
        resolvedDbPath: "/tmp/mengshu-test",
        db: new FakeDb(),
      })
    ).toThrow("[Mengshu 配置错误] embedding.apiKey 未设置");
  });

  test("uses durable Postgres tree repository for postgres config", () => {
    const db = new FakeDb();
    const runtime = createMengshuRuntime({
      config: {
        ...config,
        dbType: "postgres",
        dbPath: undefined,
        postgres: {
          host: "127.0.0.1",
          port: 5432,
          database: "test",
          user: "postgres",
          password: "postgres",
        },
      },
      resolvedDbPath: "",
      appId: "test-app",
      db,
    });

    expect(runtime.treeRepository).toBeInstanceOf(PostgresTreeRepository);
  });

  test("agent observeLight persists observations through shared memory service", async () => {
    const db = new FakeDb();
    const embeddings = {
      embed: vi.fn(async () => Array.from({ length: 1536 }, () => 0.01)),
      embedBatch: vi.fn(),
    } as unknown as Embeddings;
    const runtime = createMengshuRuntime({
      config,
      resolvedDbPath: "/tmp/mengshu-test",
      appId: "test-app",
      db,
      embeddings,
    });

    const response = await runtime.agentFastPath.observeLight({
      scope: runtime.defaultScope,
      eventType: "user_input",
      text: "用户要求所有 agent 共享 OpenClaw Postgres 记忆库。",
      intent: "remember",
    });

    expect(response.ack).toBe(true);
    expect(db.store).toHaveBeenCalledTimes(1);
    const stored = db.store.mock.calls[0]?.[0]?.[0];
    expect(stored?.text).toContain("OpenClaw Postgres");
    expect(stored?.tableName).toBe("memories");
    expect(stored?.vector).toHaveLength(1536);
    expect(stored?.metadata?.embeddingSpaceId).toBe(
      runtime.embeddingSpace.embeddingSpaceId,
    );
    expect(stored?.metadata?.embeddingSpaceState).toBe("known-queryable");
    expect(JSON.stringify(stored?.metadata)).not.toContain("test-key");
    expect(response).toMatchObject({
      stored: true,
      duplicate: false,
      persistedId: stored?.id,
    });
    expect(runtime.durableJobV2ServeCapability).toBeUndefined();
    expect(response.queuedJobs).toEqual([]);
    expect(response.warnings).toEqual([
      expect.stringMatching(/^enqueue_failed: Durable job v2 runtime operation failed$/),
      expect.stringMatching(/^tree_enqueue_failed: Durable job v2 runtime operation failed$/),
      expect.stringMatching(/^graph_enqueue_failed: Durable job v2 runtime operation failed$/),
    ]);
    await expect(runtime.ingestionStore.jobs.list()).resolves.toEqual([]);
  });

  test("Postgres runtime 默认不把 legacy handlers 适配成 v2 capability，serve 保持 fail-closed", () => {
    const db = new RegistryFakeDb() as RegistryFakeDb & {
      createDurableJobV2Repository: ReturnType<typeof vi.fn>;
    };
    db.createDurableJobV2Repository = vi.fn();
    const runtime = createMengshuRuntime({
      config: postgresGuardConfig,
      resolvedDbPath: "",
      db,
      embeddings: fakeEmbeddings(),
      treeRepository: fakeTreeRepository(),
    });

    expect(runtime.durableJobV2ServeCapability).toBeUndefined();
    expect(runtime.durableJobV2RuntimeBundle).toBeUndefined();
    expect(db.createDurableJobV2Repository).not.toHaveBeenCalled();
    expect(() => createServeRuntimeHost(runtime)).toThrow(
      expect.objectContaining({ code: "DURABLE_JOB_V2_RUNTIME_BUNDLE_REQUIRED" }),
    );
  });

  test("真实 PostgresProvider + exact authority 自动组合 provider-owned exact-three capability", () => {
    const defaultScope = {
      tenantId: "tenant-a",
      userId: "user-a",
      appId: "mengshu",
      projectId: "project-a",
      agentId: "agent-a",
      namespace: "working-context",
      visibility: "private" as const,
    };
    const db = runtimePostgresProvider();
    const runtime = createMengshuRuntime({
      config: postgresGuardConfig,
      resolvedDbPath: "",
      appId: "mengshu",
      defaultScope,
      db,
      embeddings: fakeEmbeddings(),
      treeRepository: fakeTreeRepository(),
    });

    expect(runtime.durableJobV2RuntimeBundle).toBeDefined();
    expect(runtime.durableJobV2ServeCapability).toBeDefined();
    expect(runtime.durableJobV2ServeCapability?.registry.types).toEqual([
      "build_tree",
      "extract_candidate",
      "extract_graph",
    ]);
    expect(runtime.durableJobV2ServeCapability?.repository)
      .toBe(runtime.durableJobV2RuntimeBundle?.repository);
  });

  test("Postgres Console 使用持久 candidate review，approve 在缺少原子 promotion 时 fail-closed", async () => {
    const defaultScope = {
      tenantId: "tenant-a",
      userId: "user-a",
      appId: "mengshu",
      projectId: "project-a",
      agentId: "agent-a",
      namespace: "working-context",
      visibility: "private" as const,
    };
    const candidate = {
      id: "candidate-persistent-1",
      scope: defaultScope,
      text: "persistent candidate",
      semanticType: "rules" as const,
      kind: "fact",
      confidence: 0.91,
      evidenceIds: ["evidence-1"],
      status: "pending" as const,
      hitCount: 0,
      metadata: {},
      createdAt: 100,
    };
    const get = vi.fn(async (id: string) => id === candidate.id ? candidate : undefined);
    const list = vi.fn(async () => [candidate]);
    const setStatus = vi.fn(async () => undefined);
    const count = vi.fn(async () => 1);
    const runEvictionScan = vi.fn(async () => ({ evicted: 2, archived: 1 }));
    const persistentReviewRepository = {
      get,
      list,
      setStatus,
      count,
      deleteByIds: vi.fn(async () => 0),
      archiveByIds: vi.fn(async () => 0),
      runEvictionScan,
    };
    const db = runtimePostgresProvider();
    const createCandidateReviewRepository = vi.spyOn(db, "createCandidateReviewRepository")
      .mockReturnValue(persistentReviewRepository);
    const runtime = createMengshuRuntime({
      config: postgresGuardConfig,
      resolvedDbPath: "",
      appId: "mengshu",
      defaultScope,
      db,
      embeddings: fakeEmbeddings(),
      treeRepository: fakeTreeRepository(),
    });

    expect(createCandidateReviewRepository).toHaveBeenCalledWith(defaultScope);
    await expect(runtime.consoleApi.candidates({ scope: defaultScope }))
      .resolves.toMatchObject({ total: 1, candidates: [{ id: candidate.id }] });
    await expect(runtime.consoleApi.candidateCount(defaultScope, { status: "pending" }))
      .resolves.toBe(1);

    await expect(runtime.consoleApi.reviewCandidates({
      action: { action: "reject", ids: [candidate.id], reason: "not durable" },
    })).resolves.toEqual({ affected: 1, promoted: [], errors: [] });
    expect(setStatus).toHaveBeenCalledWith(candidate.id, "rejected", { reason: "not durable" });

    setStatus.mockClear();
    await expect(runtime.consoleApi.reviewCandidates({
      action: { action: "archive", ids: [candidate.id] },
    })).resolves.toEqual({ affected: 1, promoted: [], errors: [] });
    expect(setStatus).toHaveBeenCalledWith(candidate.id, "archived");

    await expect(runtime.consoleApi.reviewCandidates({
      action: { action: "evict_expired" },
    })).resolves.toEqual({ affected: 3, promoted: [], errors: [] });
    expect(runEvictionScan).toHaveBeenCalledOnce();

    setStatus.mockClear();
    db.store.mockClear();
    await expect(runtime.consoleApi.reviewCandidates({
      action: { action: "approve", ids: [candidate.id] },
    })).resolves.toEqual({
      affected: 0,
      promoted: [],
      errors: [
        `promote_failed:${candidate.id}:candidate_approval_requires_atomic_promotion`,
      ],
    });
    expect(setStatus).not.toHaveBeenCalled();
    expect(db.store).not.toHaveBeenCalled();
  });

  test("schema v11 ready 时 deep lookup 与 console graph 读取 canonical tree/graph", async () => {
    const defaultScope = {
      tenantId: "tenant-a",
      userId: "user-a",
      appId: "mengshu",
      projectId: "project-a",
      agentId: "agent-a",
      namespace: "working-context",
      visibility: "private" as const,
    };
    const db = runtimePostgresProvider();
    Object.assign(db as unknown as Record<string, unknown>, {
      schemaVersion: 11,
      schemaContractState: "ready",
    });
    const listSummaries = vi.fn(async () => [{
      id: "summary-1",
      scope: defaultScope,
      treeType: "source" as const,
      treeKey: "default",
      level: 1,
      title: "summary",
      summary: "canonical tree summary",
      childNodeIds: [],
      leafIds: ["leaf-1"],
      evidenceChunkIds: ["chunk-1"],
      entityIds: [],
      relationIds: [],
      tokenCount: 3,
      timeRange: { startAt: 1, endAt: 1 },
      status: "sealed" as const,
      createdAt: 1,
      sealedAt: 1,
      metadata: {},
    }]);
    const findEntities = vi.fn(async () => [{
      id: "entity-1",
      scope: defaultScope,
      canonicalName: "mengshu",
      displayName: "Mengshu",
      type: "project" as const,
      aliases: ["Mengshu"],
      mentionCount: 1,
      mentionCount30d: 1,
      distinctSourceCount: 1,
      hotness: 0.5,
      queryHits30d: 0,
      status: "active" as const,
      createdAt: 1,
      updatedAt: 1,
      metadata: {},
    }]);
    const findRelations = vi.fn(async () => []);
    vi.spyOn(db, "createCanonicalTreeReadRepository").mockReturnValue({
      listSummaries,
    } as never);
    vi.spyOn(db, "createCanonicalGraphReadRepository").mockImplementation(() => ({
      getEntity: vi.fn(async () => undefined),
      findEntities,
      findRelations,
    }) as never);
    const runtime = createMengshuRuntime({
      config: postgresGuardConfig,
      resolvedDbPath: "",
      appId: "mengshu",
      defaultScope,
      db,
      embeddings: fakeEmbeddings(),
      treeRepository: fakeTreeRepository(),
    });

    const lookup = await runtime.agentFastPath.lookup({
      scope: defaultScope,
      query: "summary",
      mode: "deep",
    });
    const graph = await runtime.consoleApi.graph({
      scope: defaultScope,
      query: "mengshu",
    });

    expect(listSummaries).toHaveBeenCalledWith({ scope: defaultScope });
    expect(lookup.hits.some((hit) => hit.id === "summary-1")).toBe(true);
    expect(findEntities).toHaveBeenCalled();
    expect(findRelations).toHaveBeenCalled();
    expect(graph.entities.map((entity) => entity.id)).toEqual(["entity-1"]);
  });

  test("显式 trusted native v2 capability 注入后，observeLight 只写 v2 且 dedupe 绑定 persisted ID", async () => {
    const defaultScope = {
      tenantId: "tenant-a",
      userId: "user-a",
      appId: "mengshu",
      projectId: "project-a",
      agentId: "agent-a",
      namespace: "working-context",
      visibility: "private" as const,
    };
    const trusted = trustedDurableComposition(defaultScope);
    const db = trusted.provider;
    db.getActiveEmbeddingSpace.mockResolvedValue(runtimeSpace());
    const runtime = createMengshuRuntime({
      config: postgresGuardConfig,
      resolvedDbPath: "",
      appId: "mengshu",
      defaultScope,
      db,
      embeddings: fakeEmbeddings(),
      treeRepository: fakeTreeRepository(),
      durableJobV2ServeCapability: trusted.capability,
      durableJobV2RuntimeBundle: trusted.runtimeBundle,
    });
    await runtime.start();

    const capability = runtime.durableJobV2ServeCapability;
    expect(capability).toBeDefined();
    expect(capability?.registry.types).toEqual([
      "build_tree",
      "extract_candidate",
      "extract_graph",
    ]);
    expect(capability?.repository).toBe(trusted.repository);

    const response = await runtime.agentFastPath.observeLight({
      scope: runtime.defaultScope,
      eventType: "user_input",
      text: "persist and enqueue through durable v2",
      intent: "remember",
    });

    expect(response).toMatchObject({ ack: true, stored: true, duplicate: false });
    expect(response.queuedJobs).toHaveLength(3);
    expect(trusted.repository.enqueueInputs.map((input) => input.type)).toEqual([
      "extract_candidate",
      "build_tree",
      "extract_graph",
    ]);
    expect(trusted.repository.enqueueInputs.map((input) => input.dedupeKey)).toEqual([
      deriveDurableJobV2DomainDedupeKey("extract_candidate", response.persistedId!, {}),
      deriveDurableJobV2DomainDedupeKey("build_tree", response.persistedId!, {}),
      deriveDurableJobV2DomainDedupeKey("extract_graph", response.persistedId!, {}),
    ]);
    expect(trusted.repository.enqueueInputs.every((input) =>
      JSON.stringify(input.scope) === JSON.stringify(capability?.scope))).toBe(true);
    await expect(runtime.ingestionStore.jobs.list()).resolves.toEqual([]);
    await runtime.stop();
  });

  test("release-fail receipt reaches FastPath, audits once, and native duplicate retry re-ensures jobs", async () => {
    const defaultScope = {
      tenantId: "tenant-a",
      userId: "user-a",
      appId: "mengshu",
      projectId: "project-a",
      agentId: "agent-a",
      namespace: "working-context",
      visibility: "private" as const,
    };
    const trusted = trustedDurableComposition(defaultScope);
    const db = trusted.provider;
    db.getActiveEmbeddingSpace.mockResolvedValue(runtimeSpace());
    let persistedId: string | undefined;
    let durableRows = 0;
    db.store.mockImplementation(async (entries) => {
      const requestedId = entries[0]!.id;
      if (!persistedId) {
        persistedId = requestedId;
        durableRows += 1;
        throw new DatabaseStoreCleanupError({
          inserted: 1,
          duplicates: 0,
          records: [{ requestedId, persistedId, stored: true }],
        }, "completed");
      }
      return {
        inserted: 0,
        duplicates: 1,
        records: [{ requestedId, persistedId, stored: false }],
      };
    });
    const runtime = createMengshuRuntime({
      config: postgresGuardConfig,
      resolvedDbPath: "",
      appId: "mengshu",
      defaultScope,
      db,
      embeddings: fakeEmbeddings(),
      treeRepository: fakeTreeRepository(),
      durableJobV2ServeCapability: trusted.capability,
      durableJobV2RuntimeBundle: trusted.runtimeBundle,
    });
    const audit = vi.spyOn(runtime.ingestionStore.audit, "append");
    await runtime.start();

    const first = await runtime.agentFastPath.observeLight({
      scope: defaultScope,
      eventType: "user_input",
      text: "persisted although lock release failed",
      intent: "remember",
    });
    const retry = await runtime.agentFastPath.observeLight({
      scope: defaultScope,
      eventType: "user_input",
      text: "persisted although lock release failed",
      intent: "remember",
    });

    expect(durableRows).toBe(1);
    expect(first).toMatchObject({
      persistedId,
      stored: true,
      duplicate: false,
      warnings: [DATABASE_STORE_CLEANUP_WARNING],
    });
    expect(first.queuedJobs).toHaveLength(3);
    expect(retry).toMatchObject({
      persistedId,
      stored: false,
      duplicate: true,
    });
    expect(retry.queuedJobs).toHaveLength(3);
    expect(trusted.repository.enqueueInputs).toHaveLength(6);
    expect(trusted.repository.createdJobs).toHaveLength(3);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "memory.store",
      targetId: persistedId,
    }));
    await runtime.stop();
  });

  test("native duplicate retry repairs a partially enqueued derived-job pair idempotently", async () => {
    const defaultScope = {
      tenantId: "tenant-a",
      userId: "user-a",
      appId: "mengshu",
      projectId: "project-a",
      agentId: "agent-a",
      namespace: "working-context",
      visibility: "private" as const,
    };
    const trusted = trustedDurableComposition(defaultScope, ["build_tree"]);
    const db = trusted.provider;
    db.getActiveEmbeddingSpace.mockResolvedValue(runtimeSpace());
    let persistedId: string | undefined;
    db.store.mockImplementation(async (entries) => {
      const requestedId = entries[0]!.id;
      if (!persistedId) {
        persistedId = requestedId;
        return {
          inserted: 1,
          duplicates: 0,
          records: [{ requestedId, persistedId, stored: true }],
        };
      }
      return {
        inserted: 0,
        duplicates: 1,
        records: [{ requestedId, persistedId, stored: false }],
      };
    });
    const runtime = createMengshuRuntime({
      config: postgresGuardConfig,
      resolvedDbPath: "",
      appId: "mengshu",
      defaultScope,
      db,
      embeddings: fakeEmbeddings(),
      treeRepository: fakeTreeRepository(),
      durableJobV2ServeCapability: trusted.capability,
      durableJobV2RuntimeBundle: trusted.runtimeBundle,
    });
    await runtime.start();

    const first = await runtime.agentFastPath.observeLight({
      scope: defaultScope,
      eventType: "user_input",
      text: "repair a partially enqueued pair",
      intent: "remember",
    });
    expect(first).toMatchObject({ stored: true, duplicate: false });
    expect(first.queuedJobs).toHaveLength(2);
    expect(first.warnings?.some((warning) => warning.includes("tree_enqueue_failed"))).toBe(true);

    const retry = await runtime.agentFastPath.observeLight({
      scope: defaultScope,
      eventType: "user_input",
      text: "repair a partially enqueued pair",
      intent: "remember",
    });
    expect(retry).toMatchObject({ persistedId, stored: false, duplicate: true });
    expect(retry.queuedJobs).toHaveLength(3);
    expect(trusted.repository.createdJobs.map((job) => job.type)).toEqual([
      "extract_candidate",
      "extract_graph",
      "build_tree",
    ]);
    expect(trusted.repository.enqueueInputs.map((input) => input.type)).toEqual([
      "extract_candidate",
      "build_tree",
      "extract_graph",
      "extract_candidate",
      "build_tree",
      "extract_graph",
    ]);
    expect(trusted.repository.enqueueInputs.map((input) => input.dedupeKey)).toEqual([
      deriveDurableJobV2DomainDedupeKey("extract_candidate", persistedId!, {}),
      deriveDurableJobV2DomainDedupeKey("build_tree", persistedId!, {}),
      deriveDurableJobV2DomainDedupeKey("extract_graph", persistedId!, {}),
      deriveDurableJobV2DomainDedupeKey("extract_candidate", persistedId!, {}),
      deriveDurableJobV2DomainDedupeKey("build_tree", persistedId!, {}),
      deriveDurableJobV2DomainDedupeKey("extract_graph", persistedId!, {}),
    ]);
    await runtime.stop();
  });

  test("trusted v2 capability 对 cross-scope observe 与 session unsupported 类型诚实 fail-closed", async () => {
    const warnings: string[] = [];
    const defaultScope = {
      tenantId: "tenant-a",
      userId: "user-a",
      appId: "mengshu",
      projectId: "project-a",
      agentId: "agent-a",
      namespace: "working-context",
      visibility: "private" as const,
    };
    const trusted = trustedDurableComposition(defaultScope);
    const db = trusted.provider;
    db.getActiveEmbeddingSpace.mockResolvedValue(runtimeSpace());
    const runtime = createMengshuRuntime({
      config: postgresGuardConfig,
      resolvedDbPath: "",
      defaultScope,
      db,
      embeddings: fakeEmbeddings(),
      treeRepository: fakeTreeRepository(),
      logger: { warn: (message) => warnings.push(message) },
      durableJobV2ServeCapability: trusted.capability,
      durableJobV2RuntimeBundle: trusted.runtimeBundle,
    });
    await runtime.start();

    const observe = await runtime.agentFastPath.observeLight({
      scope: { ...runtime.defaultScope, tenantId: "tenant-b" },
      eventType: "user_input",
      text: "must not enqueue across runtime authority",
      intent: "remember",
    });
    const session = await runtime.agentFastPath.sessionCommit({
      scope: runtime.defaultScope,
      summary: "session summary is not a persisted observation payload",
    });

    expect(observe.queuedJobs).toEqual([]);
    expect(observe.warnings).toEqual([
      expect.stringMatching(/^enqueue_failed: Durable job v2 runtime operation failed$/),
      expect.stringMatching(/^tree_enqueue_failed: Durable job v2 runtime operation failed$/),
      expect.stringMatching(/^graph_enqueue_failed: Durable job v2 runtime operation failed$/),
    ]);
    expect(session.jobs).toEqual([]);
    expect(warnings).toEqual([
      expect.stringMatching(/^session_commit job refresh_slot_snapshot failed:/),
      expect.stringMatching(/^session_commit job extract_candidate failed:/),
    ]);
    expect(trusted.repository.enqueueInputs).toEqual([]);
    await expect(runtime.ingestionStore.jobs.list()).resolves.toEqual([]);
    await runtime.stop();
  });

  test("non-Postgres 即使注入 native v2 capability 也拒绝构造", () => {
    const defaultScope = {
      tenantId: "tenant-a",
      userId: "user-a",
      appId: "mengshu",
      projectId: "project-a",
      agentId: "agent-a",
      namespace: "working-context",
      visibility: "private" as const,
    };
    const trusted = trustedDurableComposition(defaultScope);

    expect(() => createMengshuRuntime({
      config,
      resolvedDbPath: "",
      defaultScope,
      db: new FakeDb(),
      embeddings: fakeEmbeddings(),
      treeRepository: fakeTreeRepository(),
      durableJobV2ServeCapability: trusted.capability,
      durableJobV2RuntimeBundle: trusted.runtimeBundle,
    })).toThrow(expect.objectContaining({ code: "CAPABILITY_UNAVAILABLE" }));
  });

  test("Postgres runtime 拒绝注入另一 provider mint 的 durable bundle", () => {
    const defaultScope = {
      tenantId: "tenant-a",
      userId: "user-a",
      appId: "mengshu",
      projectId: "project-a",
      agentId: "agent-a",
      namespace: "working-context",
      visibility: "private" as const,
    };
    const trusted = trustedDurableComposition(defaultScope);
    const foreignProvider = new PostgresProvider({
      host: "unused",
      port: 5432,
      database: "unused",
      user: "unused",
      password: "unused",
    }, "text-embedding-3-small");

    expect(() => createMengshuRuntime({
      config: postgresGuardConfig,
      resolvedDbPath: "",
      defaultScope,
      db: foreignProvider,
      embeddings: fakeEmbeddings(),
      treeRepository: fakeTreeRepository(),
      durableJobV2ServeCapability: trusted.capability,
      durableJobV2RuntimeBundle: trusted.runtimeBundle,
    })).toThrow(new RuntimeDurableJobV2Error("CAPABILITY_UNAVAILABLE"));
  });

  test("Postgres runtime 在 DB/enqueue 前拒绝同源 repository 拼出的 capability copy", () => {
    const defaultScope = {
      tenantId: "tenant-a",
      userId: "user-a",
      appId: "mengshu",
      projectId: "project-a",
      agentId: "agent-a",
      namespace: "working-context",
      visibility: "private" as const,
    };
    const trusted = trustedDurableComposition(defaultScope);
    const copiedCapability = { ...trusted.capability };

    expect(() => createMengshuRuntime({
      config: postgresGuardConfig,
      resolvedDbPath: "",
      defaultScope,
      db: trusted.provider,
      embeddings: fakeEmbeddings(),
      treeRepository: fakeTreeRepository(),
      durableJobV2ServeCapability: copiedCapability,
      durableJobV2RuntimeBundle: trusted.runtimeBundle,
    })).toThrow(new RuntimeDurableJobV2Error("CAPABILITY_UNAVAILABLE"));

    expect(trusted.provider.initialize).not.toHaveBeenCalled();
    expect(trusted.provider.store).not.toHaveBeenCalled();
    expect(trusted.repository.enqueueInputs).toEqual([]);
  });

  test("agent observeLight duplicate returns the persisted ID and creates no extraction/tree jobs", async () => {
    const persistedId = "99999999-9999-4999-8999-999999999999";
    const db = new FakeDb();
    db.store.mockImplementation(async (entries) => ({
      inserted: 0,
      duplicates: entries.length,
      records: entries.map((entry) => ({
        requestedId: entry.id,
        persistedId,
        stored: false,
      })),
    }));
    const runtime = createMengshuRuntime({
      config,
      resolvedDbPath: "/tmp/mengshu-test",
      appId: "test-app",
      db,
      embeddings: fakeEmbeddings(),
    });

    const response = await runtime.agentFastPath.observeLight({
      scope: runtime.defaultScope,
      eventType: "user_input",
      text: "duplicate observation",
      intent: "remember",
    });

    expect(response).toMatchObject({
      ack: true,
      duplicate: true,
      stored: false,
      persistedId,
      queuedJobs: [],
    });
    await expect(runtime.ingestionStore.jobs.list()).resolves.toEqual([]);
  });

  test("maps common provider errors to friendly errors", () => {
    expect(toFriendlyMengshuError(new Error("403 balance is insufficient")).message).toContain("余额不足");
    expect(toFriendlyMengshuError(new Error("401 unauthorized")).message).toContain("API 认证失败");
    expect(toFriendlyMengshuError(new Error("ECONNREFUSED")).message).toContain("无法连接到 Embedding API");
  });

  test("observeLight stores record with scope metadata for non-default scope", async () => {
    const db = new FakeDb();
    const embeddings = {
      embed: vi.fn(async () => Array.from({ length: 1536 }, () => 0.01)),
      embedBatch: vi.fn(),
    } as unknown as Embeddings;
    const runtime = createMengshuRuntime({
      config,
      resolvedDbPath: "/tmp/mengshu-test",
      appId: "test-app",
      db,
      embeddings,
    });

    await runtime.agentFastPath.observeLight({
      scope: { userId: "alice", projectId: "proj1", agentId: "agent1" },
      eventType: "user_input",
      text: "Alice 的项目任务",
      intent: "remember",
    });

    expect(db.store).toHaveBeenCalledTimes(1);
    const stored = db.store.mock.calls[0]?.[0]?.[0];
    expect(stored?.metadata?.userId).toBe("alice");
    expect(stored?.metadata?.projectPath).toBe("proj1");
    expect(stored?.metadata?.agentName).toBe("agent1");
  });

  test("observeLight stores record with default scope metadata for default scope", async () => {
    const db = new FakeDb();
    const embeddings = {
      embed: vi.fn(async () => Array.from({ length: 1536 }, () => 0.01)),
      embedBatch: vi.fn(),
    } as unknown as Embeddings;
    const runtime = createMengshuRuntime({
      config,
      resolvedDbPath: "/tmp/mengshu-test",
      appId: "test-app",
      db,
      embeddings,
    });

    await runtime.agentFastPath.observeLight({
      scope: { userId: "default" },
      eventType: "system_event",
      text: "全局观察",
    });

    expect(db.store).toHaveBeenCalledTimes(1);
    const stored = db.store.mock.calls[0]?.[0]?.[0];
    expect(stored?.metadata?.userId).toBe("default");
    expect(stored?.metadata?.projectPath).toBe("default");
    expect(stored?.metadata?.agentName).toBe("default");
  });

  test("observeLight rejects conflicting embedding metadata before embed/store", async () => {
    const db = new FakeDb();
    const embeddings = {
      embed: vi.fn(async () => Array.from({ length: 1536 }, () => 0.01)),
      embedBatch: vi.fn(),
    } as unknown as Embeddings;
    const runtime = createMengshuRuntime({
      config,
      resolvedDbPath: "/tmp/mengshu-test",
      appId: "test-app",
      db,
      embeddings,
    });

    const response = await runtime.agentFastPath.observeLight({
      scope: runtime.defaultScope,
      eventType: "user_input",
      text: "conflicting metadata",
      intent: "remember",
      metadata: {
        embeddingSpaceId: "embedding-space:v1:conflict",
      },
    });

    expect(response.warnings).toEqual([
      expect.stringMatching(/observation_store_failed:.*embeddingSpaceId/),
    ]);
    expect(embeddings.embed).not.toHaveBeenCalled();
    expect(db.store).not.toHaveBeenCalled();
  });

  test("candidate promotion stamps canonical embedding metadata", async () => {
    const db = new FakeDb();
    const embeddings = {
      embed: vi.fn(async () => Array.from({ length: 1536 }, () => 0.01)),
      embedBatch: vi.fn(),
    } as unknown as Embeddings;
    const runtime = createMengshuRuntime({
      config,
      resolvedDbPath: "/tmp/mengshu-test",
      appId: "test-app",
      db,
      embeddings,
    });
    const candidate = await runtime.candidateRepository.enqueue({
      scope: runtime.defaultScope,
      text: "candidate memory",
      semanticType: "rules",
      kind: "fact",
      confidence: 0.9,
      evidenceIds: [],
      extractor: "test",
      metadata: {},
    });

    const result = await runtime.candidateReview.review({
      action: "approve",
      ids: [candidate.id],
    });

    expect(result.errors).toEqual([]);
    const stored = db.store.mock.calls[0]?.[0]?.[0];
    expect(stored?.metadata?.embeddingSpaceId).toBe(
      runtime.embeddingSpace.embeddingSpaceId,
    );
    expect(stored?.metadata?.embeddingSpaceState).toBe("known-queryable");
  });

  test("candidate promotion duplicate 使用真实 persisted ID，不记录不存在的新 ID", async () => {
    const db = new FakeDb();
    db.store.mockImplementation(async (entries) => ({
      inserted: 0,
      duplicates: entries.length,
      records: entries.map((item) => ({
        requestedId: item.id,
        persistedId: "99999999-9999-4999-8999-999999999999",
        stored: false,
      })),
    }));
    const runtime = createMengshuRuntime({
      config,
      resolvedDbPath: "/tmp/mengshu-test",
      appId: "test-app",
      db,
      embeddings: fakeEmbeddings(),
    });
    const candidate = await runtime.candidateRepository.enqueue({
      scope: runtime.defaultScope,
      text: "duplicate candidate memory",
      kind: "fact",
      confidence: 0.9,
      evidenceIds: [],
      metadata: {},
    });

    const result = await runtime.candidateReview.review({ action: "approve", ids: [candidate.id] });

    expect(result.promoted).toEqual(["99999999-9999-4999-8999-999999999999"]);
    expect(await runtime.candidateRepository.get(candidate.id)).toMatchObject({
      promotedToMemoryId: "99999999-9999-4999-8999-999999999999",
    });
  });

  test("candidate promotion rejects conflicting embedding metadata", async () => {
    const db = new FakeDb();
    const embeddings = {
      embed: vi.fn(async () => Array.from({ length: 1536 }, () => 0.01)),
      embedBatch: vi.fn(),
    } as unknown as Embeddings;
    const runtime = createMengshuRuntime({
      config,
      resolvedDbPath: "/tmp/mengshu-test",
      appId: "test-app",
      db,
      embeddings,
    });
    const candidate = await runtime.candidateRepository.enqueue({
      scope: runtime.defaultScope,
      text: "candidate conflict",
      kind: "fact",
      confidence: 0.9,
      evidenceIds: [],
      metadata: { embeddingSpaceState: "unknown-unqueryable" },
    });

    const result = await runtime.candidateReview.review({
      action: "approve",
      ids: [candidate.id],
    });

    expect(result.errors).toEqual([
      expect.stringMatching(/promote_failed:.*embeddingSpaceState/),
    ]);
    expect(embeddings.embed).not.toHaveBeenCalled();
    expect(db.store).not.toHaveBeenCalled();
  });

  test("persistent document and chunk ingestion stamps canonical embedding metadata", async () => {
    const db = new FakeDb();
    const embeddings = {
      embed: vi.fn(async () => Array.from({ length: 1536 }, () => 0.01)),
      embedBatch: vi.fn(),
    } as unknown as Embeddings;
    const runtime = createMengshuRuntime({
      config,
      resolvedDbPath: "/tmp/mengshu-test",
      appId: "test-app",
      db,
      embeddings,
    });

    await runtime.ingestionPipeline.ingest({
      scope: runtime.defaultScope,
      sourceId: "/docs/embedding.md",
      content: "# Embedding\n\ncanonical metadata",
      chunkSize: 100,
    });

    const storedEntries = db.store.mock.calls.flatMap(([entries]) => entries);
    expect(storedEntries.length).toBeGreaterThanOrEqual(2);
    for (const entry of storedEntries) {
      expect(entry.metadata.embeddingSpaceId).toBe(
        runtime.embeddingSpace.embeddingSpaceId,
      );
      expect(entry.metadata.embeddingSpaceState).toBe("known-queryable");
      expect(JSON.stringify(entry.metadata)).not.toContain("test-key");
    }
  });
});
