import { describe, expect, test, vi } from "vitest";

import {
  DURABLE_JOB_V2_AUTHORITATIVE_TYPES,
  createDurableJobHandlerRegistry,
  type DurableJobV2Scope,
} from "../packages/core/src/storage/repositories/job-v2.js";
import {
  PostgresProvider,
  type PostgresDurableJobV2RuntimeBundle,
} from "../packages/core/src/db/providers/postgres.js";
import { PostgresDurableJobV2Repository } from "../packages/core/src/storage/repositories/postgres-job-v2.js";
import type { AuthorityScope } from "../packages/core/src/domain/authority-scope.js";
import type {
  BroadAuthorityDurableJobV2RepositoryPort,
  BroadAuthorityDurableJobV2SupervisorHandle,
  BroadAuthorityDurableJobV2SupervisorOptions,
  DurableJobV2AuthoritativeHandlerRegistry,
  DurableJobV2RepositoryPort,
} from "./workers-v2.js";
import {
  RuntimeHostError,
} from "./runtime-host.js";
import {
  RuntimeHostFactoryError,
  createNativeDurableJobV2ServeCapability,
  createServeRuntimeHost,
  type DurableJobV2ServeCapability,
} from "./runtime-host-factory.js";

const scope: DurableJobV2Scope = {
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "mengshu",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "working-context",
  visibility: "private",
};

const broadAuthority: AuthorityScope = {
  tenantId: scope.tenantId,
  userId: scope.userId,
  allow: {
    appIds: [scope.appId],
    projectIds: [scope.projectId, "project-b", "project-c"],
    agentIds: [scope.agentId],
    namespaces: [scope.namespace],
    visibilities: [scope.visibility],
  },
};

function fakeRepository(): DurableJobV2RepositoryPort {
  return {
    reap: vi.fn<DurableJobV2RepositoryPort["reap"]>(async () => ({ applied: 0 })),
    quarantineUnknown: vi.fn<DurableJobV2RepositoryPort["quarantineUnknown"]>(async () => ({ applied: 0 })),
    lease: vi.fn<DurableJobV2RepositoryPort["lease"]>(async () => ({ applied: 0 })),
    renew: vi.fn<DurableJobV2RepositoryPort["renew"]>(async () => ({ applied: 0 })),
    complete: vi.fn<DurableJobV2RepositoryPort["complete"]>(async () => ({ applied: 0 })),
    fail: vi.fn<DurableJobV2RepositoryPort["fail"]>(async () => ({ applied: 0 })),
  };
}

function authoritativeRegistry(): DurableJobV2AuthoritativeHandlerRegistry {
  const handlers = new Map([
    ["build_tree", vi.fn(async () => undefined)],
    ["extract_candidate", vi.fn(async () => undefined)],
    ["extract_graph", vi.fn(async () => undefined)],
  ]);
  return {
    authoritative: true,
    types: [...handlers.keys()],
    get: (type) => handlers.get(type),
  };
}

function capability(
  overrides: Partial<DurableJobV2ServeCapability> = {},
): DurableJobV2ServeCapability {
  return {
    version: 2,
    authoritative: true,
    repository: fakeRepository(),
    registry: authoritativeRegistry(),
    scope,
    ...overrides,
  } as unknown as DurableJobV2ServeCapability;
}

function providerBundle(
  calls: string[] = [],
  schemaVersion = 10,
  schemaContractState: "ready" | "pending" = "ready",
): {
  readonly provider: PostgresProvider;
  readonly bundle: PostgresDurableJobV2RuntimeBundle;
  readonly pool: { readonly end: ReturnType<typeof vi.fn> };
} {
  const provider = new PostgresProvider({
    host: "unused",
    port: 5432,
    database: "unused",
    user: "unused",
    password: "unused",
  }, "text-embedding-3-small");
  const pool = {
    end: vi.fn(async () => { calls.push("bundle:close"); }),
  };
  Object.assign(provider as unknown as Record<string, unknown>, {
    pool,
    schemaVersion,
    schemaContractState,
  });
  vi.spyOn(provider, "initialize").mockImplementation(async () => {
    calls.push("bundle:ready");
  });
  return {
    provider,
    bundle: provider.createDurableJobV2RuntimeBundle({
      clock: () => 100,
      tokenFactory: () => "a".repeat(32),
      backoffMs: () => 100,
    }),
    pool,
  };
}

function mintedCapability(
  inputRegistry: DurableJobV2AuthoritativeHandlerRegistry = authoritativeRegistry(),
  inputScope: DurableJobV2Scope = scope,
  repository?: PostgresDurableJobV2Repository,
): DurableJobV2ServeCapability {
  const registry = inputRegistry;
  const durableRepository = repository ?? new PostgresDurableJobV2Repository({
    connect: async () => { throw new Error("offline factory test must not connect"); },
  }, {
    registry: createDurableJobHandlerRegistry(registry.types),
    clock: () => 100,
    tokenFactory: () => "a".repeat(32),
    backoffMs: () => 100,
  });
  return createNativeDurableJobV2ServeCapability({
    repository: durableRepository,
    registry,
    scope: inputScope,
  });
}

function runtime(
  dbType: string,
  durableJobV2ServeCapability?: DurableJobV2ServeCapability,
  durableJobV2RuntimeBundle?: PostgresDurableJobV2RuntimeBundle,
  ready = true,
  db?: PostgresProvider,
) {
  const calls: string[] = [];
  return {
    calls,
    config: { dbType },
    ...(db ? { db } : {}),
    durableJobV2ServeCapability,
    durableJobV2RuntimeBundle,
    start: vi.fn(async () => { calls.push("runtime:start"); }),
    stop: vi.fn(async () => { calls.push("runtime:stop"); }),
    lifecycle: {
      snapshot: vi.fn(() => ({ state: ready ? "ready" : "degraded", ready })),
    },
  };
}

describe("createServeRuntimeHost", () => {
  test("有效 production composition 缺 authority 时在启动副作用前 fail-closed", () => {
    const { provider, bundle } = providerBundle();
    const source = runtime(
      "postgres",
      mintedCapability(authoritativeRegistry(), scope, bundle.repository),
      bundle,
      true,
      provider,
    );

    expect(() => createServeRuntimeHost(source)).toThrow(
      expect.objectContaining({ code: "DURABLE_JOB_V2_AUTHORITY_REQUIRED" }),
    );
    expect(source.start).not.toHaveBeenCalled();
  });

  test("production Host 使用有界 broad-authority supervisor 并保持 worker-first stop", async () => {
    const calls: string[] = [];
    const { provider, bundle } = providerBundle(calls);
    const worker = {
      tick: vi.fn(async () => []),
      stop: vi.fn(async () => {
        calls.push("supervisor:stop");
        return { status: "stopped" as const };
      }),
      snapshot: vi.fn(() => ({
        state: "healthy" as const,
        ready: true,
        consecutiveFailures: 0,
        failingScopes: 0,
      })),
    };
    const startSupervisor = vi.fn((
      _repository: BroadAuthorityDurableJobV2RepositoryPort,
      options: BroadAuthorityDurableJobV2SupervisorOptions,
    ) => {
      calls.push("supervisor:start");
      expect(options).toMatchObject({
        authority: broadAuthority,
        workerId: "mengshu-serve-worker",
        leaseMs: 30_000,
        heartbeatIntervalMs: 10_000,
        intervalMs: 1_000,
        maxScopesPerTick: 100,
        maxJobsPerTick: 100,
        stopTimeoutMs: 5_000,
      });
      expect(options).not.toHaveProperty("scope");
      return worker;
    });
    const source = runtime(
      "postgres",
      mintedCapability(authoritativeRegistry(), scope, bundle.repository),
      bundle,
      true,
      provider,
    );
    source.start.mockImplementation(async () => { calls.push("runtime:start"); });
    source.stop.mockImplementation(async () => { calls.push("runtime:stop"); });

    const host = createServeRuntimeHost(source, {
      authority: broadAuthority,
      startSupervisor,
    });
    await host.start();
    await host.stop();

    expect(startSupervisor).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      "bundle:ready",
      "runtime:start",
      "supervisor:start",
      "supervisor:stop",
      "runtime:stop",
      "bundle:close",
    ]);
  });

  test("production factory 拒绝裸 capability，且 exact-three 来自 core SSOT", () => {
    const source = runtime("postgres", mintedCapability());

    expect(() => createServeRuntimeHost(source)).toThrow(
      new RuntimeHostFactoryError("DURABLE_JOB_V2_RUNTIME_BUNDLE_REQUIRED"),
    );
    expect(DURABLE_JOB_V2_AUTHORITATIVE_TYPES).toEqual([
      "build_tree",
      "extract_candidate",
      "extract_graph",
    ]);
    expect(source.start).not.toHaveBeenCalled();
  });

  test("结构完全相同但未经 runtime mint 的 capability 在任何启动副作用前拒绝", () => {
    const { provider, bundle } = providerBundle();
    const forged = capability({ repository: bundle.repository });
    const source = runtime("postgres", forged, bundle, true, provider);
    const startSupervisor = vi.fn();

    expect(() => createServeRuntimeHost(source, {
      authority: broadAuthority,
      startSupervisor,
    })).toThrow(
      new RuntimeHostFactoryError("DURABLE_JOB_V2_CAPABILITY_INVALID"),
    );

    expect(source.start).not.toHaveBeenCalled();
    expect(startSupervisor).not.toHaveBeenCalled();
  });

  test("native capability constructor 拒绝单类型 registry，且复制冻结 exact SSOT/scope", () => {
    const single = {
      authoritative: true as const,
      types: ["extract_candidate"],
      get: () => vi.fn(async () => undefined),
    };
    expect(() => mintedCapability(single)).toThrow(
      new RuntimeHostFactoryError("DURABLE_JOB_V2_CAPABILITY_INVALID"),
    );

    const mutableTypes = ["build_tree", "extract_candidate", "extract_graph"];
    const mutableScope = { ...scope };
    const handlers = new Map(mutableTypes.map((type) => [type, vi.fn(async () => undefined)]));
    const minted = mintedCapability({
      authoritative: true,
      types: mutableTypes,
      get: (type) => handlers.get(type),
    }, mutableScope);

    mutableTypes.pop();
    mutableScope.tenantId = "tenant-mutated";
    handlers.delete("extract_graph");

    expect(minted.registry.types).toEqual(["build_tree", "extract_candidate", "extract_graph"]);
    expect(minted.scope).toEqual(scope);
    expect(typeof minted.registry.get("extract_graph")).toBe("function");
    expect(Object.isFrozen(minted)).toBe(true);
    expect(Object.isFrozen(minted.registry)).toBe(true);
    expect(Object.isFrozen(minted.registry.types)).toBe(true);
    expect(Object.isFrozen(minted.scope)).toBe(true);
  });

  test("非 Postgres 明确 fail-closed，绝不探测或构造旧 jobs fallback", () => {
    const source = runtime("lancedb", capability());
    const startSupervisor = vi.fn();

    expect(() => createServeRuntimeHost(source, {
      authority: broadAuthority,
      startSupervisor,
    }))
      .toThrow(new RuntimeHostFactoryError("DURABLE_JOB_V2_POSTGRES_REQUIRED"));

    expect(startSupervisor).not.toHaveBeenCalled();
    expect(source.start).not.toHaveBeenCalled();
  });

  test("Postgres 缺 capability 或 authoritative registry 不完整时 fail-closed", () => {
    const { provider, bundle } = providerBundle();
    const missing = runtime("postgres", undefined, bundle, true, provider);
    expect(() => createServeRuntimeHost(missing)).toThrow(
      new RuntimeHostFactoryError("DURABLE_JOB_V2_CAPABILITY_REQUIRED"),
    );

    for (const invalid of [
      capability({ version: 1 as 2 }),
      capability({ authoritative: false as true }),
      capability({ registry: { authoritative: true, types: [], get: () => undefined } }),
      capability({
        registry: {
          authoritative: true,
          types: ["extract_candidate"],
          get: () => undefined,
        },
      }),
      capability({ repository: {} as unknown as PostgresDurableJobV2Repository }),
      capability({ scope: { ...scope, visibility: "cross-tenant" as never } }),
    ]) {
      expect(() => createServeRuntimeHost(runtime(
        "postgres",
        invalid,
        bundle,
        true,
        provider,
      ))).toThrow(
        new RuntimeHostFactoryError("DURABLE_JOB_V2_CAPABILITY_INVALID"),
      );
    }
  });

  test("真实 capability 构造 Host，依赖 ready 后才启动 broad supervisor，且从不 tick 探测", async () => {
    const calls: string[] = [];
    const { provider, bundle, pool } = providerBundle(calls);
    const worker: BroadAuthorityDurableJobV2SupervisorHandle = {
      tick: vi.fn<BroadAuthorityDurableJobV2SupervisorHandle["tick"]>(async () => []),
      stop: vi.fn<BroadAuthorityDurableJobV2SupervisorHandle["stop"]>(async () => {
        calls.push("worker:stop");
        return { status: "stopped" };
      }),
      snapshot: vi.fn(() => ({
        state: "healthy" as const,
        ready: true,
        consecutiveFailures: 0,
        failingScopes: 0,
      })),
    };
    const startSupervisor = vi.fn((
      repository: BroadAuthorityDurableJobV2RepositoryPort,
      options: BroadAuthorityDurableJobV2SupervisorOptions,
    ) => {
      calls.push("worker:start");
      expect(repository).toBe(source.durableJobV2ServeCapability?.repository);
      expect(options).toMatchObject({
        authority: broadAuthority,
        workerId: "mengshu-serve-worker",
        leaseMs: 30_000,
        heartbeatIntervalMs: 10_000,
        intervalMs: 1_000,
        maxScopesPerTick: 100,
        maxJobsPerTick: 100,
        stopTimeoutMs: 5_000,
        registry: source.durableJobV2ServeCapability?.registry,
      });
      return worker;
    });
    const source = runtime(
      "postgres",
      mintedCapability(authoritativeRegistry(), scope, bundle.repository),
      bundle,
      true,
      provider,
    );
    source.start.mockImplementation(async () => { calls.push("runtime:start"); });
    source.stop.mockImplementation(async () => { calls.push("runtime:stop"); });
    const host = createServeRuntimeHost(source, {
      authority: broadAuthority,
      startSupervisor,
    });

    await host.start();

    expect(calls).toEqual(["bundle:ready", "runtime:start", "worker:start"]);
    expect(worker.tick).not.toHaveBeenCalled();
    expect(host.snapshot()).toMatchObject({ state: "ready", ready: true, accepting: true });

    await host.stop();
    expect(calls).toEqual([
      "bundle:ready",
      "runtime:start",
      "worker:start",
      "worker:stop",
      "runtime:stop",
      "bundle:close",
    ]);
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  test("bundle readiness 失败时 runtime/worker 均为零副作用且错误脱敏", async () => {
    const calls: string[] = [];
    const { provider, bundle, pool } = providerBundle(calls, 7, "ready");
    const source = runtime(
      "postgres",
      mintedCapability(authoritativeRegistry(), scope, bundle.repository),
      bundle,
      true,
      provider,
    );
    const startSupervisor = vi.fn();
    const host = createServeRuntimeHost(source, {
      authority: broadAuthority,
      startSupervisor,
    });

    await expect(host.start()).rejects.toEqual(new RuntimeHostError("HOST_START_FAILED"));

    expect(calls).toEqual(["bundle:ready", "bundle:close"]);
    expect(source.start).not.toHaveBeenCalled();
    expect(source.stop).not.toHaveBeenCalled();
    expect(startSupervisor).not.toHaveBeenCalled();
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(host.snapshot())).not.toMatch(/unused|password|postgres:\/\//);
  });

  test("runtime.start 失败会回滚已 ready bundle，worker 保持零副作用", async () => {
    const calls: string[] = [];
    const { provider, bundle, pool } = providerBundle(calls);
    const source = runtime(
      "postgres",
      mintedCapability(authoritativeRegistry(), scope, bundle.repository),
      bundle,
      true,
      provider,
    );
    source.start.mockImplementation(async () => {
      calls.push("runtime:start");
      throw new Error("postgres://admin:secret@private-host/runtime");
    });
    const startSupervisor = vi.fn();
    const host = createServeRuntimeHost(source, {
      authority: broadAuthority,
      startSupervisor,
    });

    await expect(host.start()).rejects.toEqual(new RuntimeHostError("HOST_START_FAILED"));

    expect(calls).toEqual(["bundle:ready", "runtime:start", "bundle:close"]);
    expect(startSupervisor).not.toHaveBeenCalled();
    expect(source.stop).not.toHaveBeenCalled();
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(host.snapshot())).not.toMatch(/secret|private-host|admin/);
  });

  test("bundle copy 与 repository 不同源在 readiness 前 fail-closed", () => {
    const calls: string[] = [];
    const first = providerBundle(calls);
    const second = providerBundle(calls);
    const capabilityForFirst = mintedCapability(
      authoritativeRegistry(),
      scope,
      first.bundle.repository,
    );

    expect(() => createServeRuntimeHost(runtime(
      "postgres",
      capabilityForFirst,
      { ...first.bundle },
      true,
      first.provider,
    ))).toThrow(new RuntimeHostFactoryError("DURABLE_JOB_V2_RUNTIME_BUNDLE_INVALID"));
    expect(() => createServeRuntimeHost(runtime(
      "postgres",
      capabilityForFirst,
      second.bundle,
      true,
      first.provider,
    ))).toThrow(new RuntimeHostFactoryError("DURABLE_JOB_V2_RUNTIME_BUNDLE_INVALID"));
    expect(calls).toEqual([]);
  });

  test("缺 runtime provider 或 bundle 属于另一 provider 时在 readiness/runtime/worker 前 fail-closed", () => {
    const calls: string[] = [];
    const first = providerBundle(calls);
    const second = providerBundle(calls);
    const capabilityForFirst = mintedCapability(
      authoritativeRegistry(),
      scope,
      first.bundle.repository,
    );
    const startSupervisor = vi.fn();

    expect(() => createServeRuntimeHost(runtime(
      "postgres",
      capabilityForFirst,
      first.bundle,
      true,
    ), { authority: broadAuthority, startSupervisor })).toThrow(
      new RuntimeHostFactoryError("DURABLE_JOB_V2_RUNTIME_BUNDLE_INVALID"),
    );
    expect(() => createServeRuntimeHost(runtime(
      "postgres",
      capabilityForFirst,
      first.bundle,
      true,
      second.provider,
    ), { authority: broadAuthority, startSupervisor })).toThrow(
      new RuntimeHostFactoryError("DURABLE_JOB_V2_RUNTIME_BUNDLE_INVALID"),
    );

    expect(calls).toEqual([]);
    expect(startSupervisor).not.toHaveBeenCalled();
  });

  test("runtime lifecycle degraded 时 Host degraded 且 worker 永不启动", async () => {
    const calls: string[] = [];
    const { provider, bundle } = providerBundle(calls);
    const source = runtime(
      "postgres",
      mintedCapability(authoritativeRegistry(), scope, bundle.repository),
      bundle,
      false,
      provider,
    );
    source.start.mockImplementation(async () => { calls.push("runtime:start"); });
    source.stop.mockImplementation(async () => { calls.push("runtime:stop"); });
    const startSupervisor = vi.fn();
    const host = createServeRuntimeHost(source, {
      authority: broadAuthority,
      startSupervisor,
    });

    await host.start();

    expect(host.snapshot()).toMatchObject({ state: "degraded", ready: false, accepting: false });
    expect(startSupervisor).not.toHaveBeenCalled();
    await host.stop();
    expect(source.stop).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["bundle:ready", "runtime:start", "runtime:stop", "bundle:close"]);
  });
});
