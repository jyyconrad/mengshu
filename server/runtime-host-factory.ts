import {
  DURABLE_JOB_V2_AUTHORITATIVE_TYPES,
  createDurableJobHandlerRegistry,
  deriveDurableJobV2ScopedDedupeKey,
  type DurableJobV2Scope,
} from "../packages/core/src/storage/repositories/job-v2.js";
import {
  assertPostgresProviderOwnsDurableJobV2RuntimeBundle,
  type PostgresDurableJobV2RuntimeBundle,
} from "../packages/core/src/db/providers/postgres.js";
import { PostgresDurableJobV2Repository } from "../packages/core/src/storage/repositories/postgres-job-v2.js";
import { RuntimeHost } from "./runtime-host.js";
import {
  startDurableJobV2WorkerLoop,
  type DurableJobV2AuthoritativeHandlerRegistry,
  type DurableJobV2RepositoryPort,
  type DurableJobV2WorkerLoopOptions,
} from "./workers-v2.js";

export type RuntimeHostFactoryErrorCode =
  | "DURABLE_JOB_V2_POSTGRES_REQUIRED"
  | "DURABLE_JOB_V2_CAPABILITY_REQUIRED"
  | "DURABLE_JOB_V2_CAPABILITY_INVALID"
  | "DURABLE_JOB_V2_RUNTIME_BUNDLE_REQUIRED"
  | "DURABLE_JOB_V2_RUNTIME_BUNDLE_INVALID";

export class RuntimeHostFactoryError extends Error {
  readonly code: RuntimeHostFactoryErrorCode;

  constructor(code: RuntimeHostFactoryErrorCode) {
    super("Durable job v2 serve capability is unavailable");
    this.name = "RuntimeHostFactoryError";
    this.code = code;
  }
}

/**
 * Runtime 必须原子公开 repository、与其配置一致的完整 handler registry 以及单一 worker scope。
 * 当前旧 MengshuRuntime 未公开该能力，因此 production serve 会明确 fail-closed；factory 不猜测
 * old JobRecord -> DurableJobV2 的 adapter，也不读取 ingestionStore.jobs 作为 fallback。
 */
export interface DurableJobV2ServeCapability {
  readonly version: 2;
  readonly authoritative: true;
  readonly repository: PostgresDurableJobV2Repository;
  readonly registry: DurableJobV2AuthoritativeHandlerRegistry;
  readonly scope: DurableJobV2Scope;
}

export { DURABLE_JOB_V2_AUTHORITATIVE_TYPES } from
  "../packages/core/src/storage/repositories/job-v2.js";

export interface ServeRuntimeHostSource {
  readonly config: { readonly dbType?: string };
  readonly db?: unknown;
  readonly durableJobV2ServeCapability?: DurableJobV2ServeCapability;
  readonly durableJobV2RuntimeBundle?: PostgresDurableJobV2RuntimeBundle;
  readonly lifecycle: {
    snapshot(): { readonly state: string; readonly ready: boolean };
  };
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface ServeRuntimeHostFactoryOptions {
  readonly workerId?: string;
  readonly leaseMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly intervalMs?: number;
  readonly maxPerTick?: number;
  readonly stopTimeoutMs?: number;
  readonly startWorker?: typeof startDurableJobV2WorkerLoop;
}

const REPOSITORY_METHODS = [
  "reap",
  "quarantineUnknown",
  "lease",
  "renew",
  "complete",
  "fail",
] as const;

// Module-private provenance marker prevents accidental structural wiring into serve.
// It is not a security sandbox against code already executing in this JS process.
const RUNTIME_MINTED_CAPABILITIES = new WeakSet<object>();

function hasExactAuthoritativeTypes(types: readonly string[]): boolean {
  return types.length === DURABLE_JOB_V2_AUTHORITATIVE_TYPES.length &&
    DURABLE_JOB_V2_AUTHORITATIVE_TYPES.every((type, index) => types[index] === type);
}

function validateCapabilityStructure(raw: unknown): DurableJobV2ServeCapability {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RuntimeHostFactoryError("DURABLE_JOB_V2_CAPABILITY_REQUIRED");
  }
  const capability = raw as Partial<DurableJobV2ServeCapability>;
  if (capability.version !== 2 || capability.authoritative !== true ||
      !(capability.repository instanceof PostgresDurableJobV2Repository) ||
      !capability.registry || !capability.scope || capability.registry.authoritative !== true ||
      !Array.isArray(capability.registry.types) ||
      !hasExactAuthoritativeTypes(capability.registry.types) ||
      typeof capability.registry.get !== "function") {
    throw new RuntimeHostFactoryError("DURABLE_JOB_V2_CAPABILITY_INVALID");
  }
  for (const method of REPOSITORY_METHODS) {
    if (typeof capability.repository[method] !== "function") {
      throw new RuntimeHostFactoryError("DURABLE_JOB_V2_CAPABILITY_INVALID");
    }
  }
  const contract = createDurableJobHandlerRegistry(DURABLE_JOB_V2_AUTHORITATIVE_TYPES);
  if (contract.types.length !== capability.registry.types.length ||
      contract.types.some((type, index) => type !== capability.registry!.types[index])) {
    throw new RuntimeHostFactoryError("DURABLE_JOB_V2_CAPABILITY_INVALID");
  }
  for (const type of contract.types) {
    if (typeof capability.registry.get(type) !== "function") {
      throw new RuntimeHostFactoryError("DURABLE_JOB_V2_CAPABILITY_INVALID");
    }
  }
  deriveDurableJobV2ScopedDedupeKey(capability.scope, "serve-capability-validation");
  return capability as DurableJobV2ServeCapability;
}

/**
 * Trusted composition validator：强制 exact type SSOT、复制/冻结 registry 与 scope，
 * 并要求 concrete PG repository。调用方仍负责把 repository 绑定到同一 runtime DB；
 * 这不是针对同进程恶意代码的安全沙箱。
 */
export function createNativeDurableJobV2ServeCapability(input: {
  readonly repository: PostgresDurableJobV2Repository;
  readonly registry: DurableJobV2AuthoritativeHandlerRegistry;
  readonly scope: DurableJobV2Scope;
}): DurableJobV2ServeCapability {
  try {
    if (!(input.repository instanceof PostgresDurableJobV2Repository) ||
        input.registry?.authoritative !== true || !Array.isArray(input.registry.types) ||
        !hasExactAuthoritativeTypes(input.registry.types)) {
      throw new RuntimeHostFactoryError("DURABLE_JOB_V2_CAPABILITY_INVALID");
    }
    const handlers = new Map<string, ReturnType<typeof input.registry.get>>();
    for (const type of DURABLE_JOB_V2_AUTHORITATIVE_TYPES) {
      const handler = input.registry.get(type);
      if (typeof handler !== "function") {
        throw new RuntimeHostFactoryError("DURABLE_JOB_V2_CAPABILITY_INVALID");
      }
      handlers.set(type, handler);
    }
    const scope = Object.freeze({
      tenantId: input.scope.tenantId,
      userId: input.scope.userId,
      appId: input.scope.appId,
      projectId: input.scope.projectId,
      agentId: input.scope.agentId,
      namespace: input.scope.namespace,
      visibility: input.scope.visibility,
    });
    deriveDurableJobV2ScopedDedupeKey(scope, "serve-capability-construction");
    const registry = Object.freeze({
      authoritative: true as const,
      types: Object.freeze([...DURABLE_JOB_V2_AUTHORITATIVE_TYPES]),
      get: (type: string) => handlers.get(type),
    });
    const capability = {
      version: 2 as const,
      authoritative: true as const,
      repository: input.repository,
      registry,
      scope,
    } satisfies DurableJobV2ServeCapability;
    validateCapabilityStructure(capability);
    Object.freeze(capability);
    RUNTIME_MINTED_CAPABILITIES.add(capability);
    return capability;
  } catch (error) {
    if (error instanceof RuntimeHostFactoryError) throw error;
    throw new RuntimeHostFactoryError("DURABLE_JOB_V2_CAPABILITY_INVALID");
  }
}

function validateCapability(raw: unknown): DurableJobV2ServeCapability {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RuntimeHostFactoryError("DURABLE_JOB_V2_CAPABILITY_REQUIRED");
  }
  try {
    if (!RUNTIME_MINTED_CAPABILITIES.has(raw)) {
      throw new RuntimeHostFactoryError("DURABLE_JOB_V2_CAPABILITY_INVALID");
    }
    return validateCapabilityStructure(raw);
  } catch {
    throw new RuntimeHostFactoryError("DURABLE_JOB_V2_CAPABILITY_INVALID");
  }
}

function validateRuntimeBundle(
  provider: unknown,
  raw: unknown,
): PostgresDurableJobV2RuntimeBundle {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RuntimeHostFactoryError("DURABLE_JOB_V2_RUNTIME_BUNDLE_REQUIRED");
  }
  try {
    const bundle = assertPostgresProviderOwnsDurableJobV2RuntimeBundle(provider, raw);
    if (bundle.contract !== "mengshu.postgres-durable-job-v2/v1" ||
        bundle.handlerTypes !== DURABLE_JOB_V2_AUTHORITATIVE_TYPES ||
        typeof bundle.executeBuildTreeEffect !== "function" ||
        typeof bundle.executeCandidateEffect !== "function" ||
        typeof bundle.executeGraphEffect !== "function" ||
        typeof bundle.assertEnqueueReady !== "function" ||
        typeof bundle.assertReady !== "function" || typeof bundle.close !== "function") {
      throw new RuntimeHostFactoryError("DURABLE_JOB_V2_RUNTIME_BUNDLE_INVALID");
    }
    return bundle;
  } catch {
    throw new RuntimeHostFactoryError("DURABLE_JOB_V2_RUNTIME_BUNDLE_INVALID");
  }
}

export function assertNativeDurableJobV2ServeCapability(
  raw: unknown,
): DurableJobV2ServeCapability {
  return validateCapability(raw);
}

export function createServeRuntimeHost(
  runtime: ServeRuntimeHostSource,
  options: ServeRuntimeHostFactoryOptions = {},
): RuntimeHost {
  if (!runtime || runtime.config?.dbType !== "postgres") {
    throw new RuntimeHostFactoryError("DURABLE_JOB_V2_POSTGRES_REQUIRED");
  }
  if (typeof runtime.start !== "function" || typeof runtime.stop !== "function" ||
      typeof runtime.lifecycle?.snapshot !== "function") {
    throw new RuntimeHostFactoryError("DURABLE_JOB_V2_CAPABILITY_INVALID");
  }
  const bundle = validateRuntimeBundle(runtime.db, runtime.durableJobV2RuntimeBundle);
  const capability = validateCapability(runtime.durableJobV2ServeCapability);
  if (capability.repository !== bundle.repository) {
    throw new RuntimeHostFactoryError("DURABLE_JOB_V2_RUNTIME_BUNDLE_INVALID");
  }
  const startWorker = options.startWorker ?? startDurableJobV2WorkerLoop;
  const workerOptions: DurableJobV2WorkerLoopOptions = {
    scope: capability.scope,
    workerId: options.workerId ?? "mengshu-serve-worker",
    leaseMs: options.leaseMs ?? 30_000,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 10_000,
    intervalMs: options.intervalMs ?? 1_000,
    stopTimeoutMs: options.stopTimeoutMs ?? 5_000,
    registry: capability.registry,
    ...(options.maxPerTick === undefined ? {} : { maxPerTick: options.maxPerTick }),
  };

  return new RuntimeHost({
    dependencies: [{
      name: "postgres_durable_bundle",
      start: async () => {
        await bundle.assertReady();
      },
      stop: () => bundle.close(),
    }, {
      name: "runtime",
      start: async () => {
        await runtime.start();
        let snapshot: { readonly state: string; readonly ready: boolean };
        try {
          snapshot = runtime.lifecycle.snapshot();
        } catch {
          return { ready: false as const, reason: "RUNTIME_NOT_READY" };
        }
        if (snapshot.state !== "ready" || snapshot.ready !== true) {
          return { ready: false as const, reason: "RUNTIME_NOT_READY" };
        }
      },
      stop: () => runtime.stop(),
    }],
    startWorker: () => startWorker(capability.repository, workerOptions),
    // production composition 不注入 probeWorker；RuntimeHost 严禁用 tick 做 readiness probe。
    workerProbeTimeoutMs: 5_000,
    workerStopTimeoutMs: workerOptions.stopTimeoutMs,
  });
}
