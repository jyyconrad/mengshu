import {
  DURABLE_JOB_V2_AUTHORITATIVE_TYPES,
  isDurableJobV2AuthoritativeTypes,
  createDurableJobHandlerRegistry,
  deriveDurableJobV2ScopedDedupeKey,
  type DurableJobV2Scope,
} from "../packages/core/src/storage/repositories/job-v2.js";
import {
  assertPostgresProviderOwnsDurableJobV2RuntimeBundle,
  type PostgresDurableJobV2RuntimeBundle,
} from "../packages/core/src/db/providers/postgres.js";
import { PostgresDurableJobV2Repository } from "../packages/core/src/storage/repositories/postgres-job-v2.js";
import {
  resolveAuthorityScope,
  type AuthorityScope,
  type ClientAuthorityScopeRequest,
} from "../packages/core/src/domain/authority-scope.js";
import { RuntimeHost } from "./runtime-host.js";
import { RuntimeBackgroundWork } from "./background-work.js";
import type { RuntimeBackgroundWorkConfig } from "../packages/core/src/runtime/background-work.js";
import {
  startBroadAuthorityDurableJobV2Supervisor,
  type BroadAuthorityDurableJobV2SupervisorOptions,
  type DurableJobV2AuthoritativeHandlerRegistry,
} from "./workers-v2.js";

export type RuntimeHostFactoryErrorCode =
  | "DURABLE_JOB_V2_POSTGRES_REQUIRED"
  | "DURABLE_JOB_V2_CAPABILITY_REQUIRED"
  | "DURABLE_JOB_V2_CAPABILITY_INVALID"
  | "DURABLE_JOB_V2_RUNTIME_BUNDLE_REQUIRED"
  | "DURABLE_JOB_V2_RUNTIME_BUNDLE_INVALID"
  | "DURABLE_JOB_V2_AUTHORITY_REQUIRED"
  | "DURABLE_JOB_V2_AUTHORITY_INVALID"
  | "DURABLE_JOB_V2_EXTERNAL_OWNER";

export class RuntimeHostFactoryError extends Error {
  readonly code: RuntimeHostFactoryErrorCode;

  constructor(code: RuntimeHostFactoryErrorCode) {
    super(code.startsWith("DURABLE_JOB_V2_AUTHORITY_")
      ? "Durable job v2 serve authority is unavailable"
      : "Durable job v2 serve capability is unavailable");
    this.name = "RuntimeHostFactoryError";
    this.code = code;
  }
}

/**
 * Runtime 必须原子公开 repository、与其配置一致的完整 handler registry 以及默认 scope。
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
  readonly config: { readonly dbType?: string; readonly server?: { readonly backgroundWork?: RuntimeBackgroundWorkConfig; readonly workerOwnership?: "runtime-host" | "external-runtime-host" } };
  readonly backgroundWork?: RuntimeBackgroundWork;
  readonly evolutionMaintenance?: { onIdle(signal: AbortSignal): Promise<void> };
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
  readonly authority?: AuthorityScope;
  readonly workerId?: string;
  readonly leaseMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly intervalMs?: number;
  readonly maxScopesPerTick?: number;
  readonly maxJobsPerTick?: number;
  /** Legacy tuning alias retained for existing live-test configuration. */
  readonly maxPerTick?: number;
  readonly stopTimeoutMs?: number;
  readonly startSupervisor?: typeof startBroadAuthorityDurableJobV2Supervisor;
}

const REPOSITORY_METHODS = [
  "listRunnableScopes",
  "reap",
  "quarantineUnknown",
  "lease",
  "renew",
  "complete",
  "fail",
] as const;

function authoritySeed(raw: unknown): ClientAuthorityScopeRequest {
  const allow = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as { readonly allow?: unknown }).allow
    : undefined;
  const record = allow && typeof allow === "object" && !Array.isArray(allow)
    ? allow as Record<string, unknown>
    : {};
  const first = (field: string): unknown => {
    const values = record[field];
    return Array.isArray(values) ? values[0] : undefined;
  };
  return {
    appId: first("appIds") as string,
    projectId: first("projectIds") as string,
    agentId: first("agentIds") as string,
    namespace: first("namespaces") as string,
    visibility: first("visibilities") as DurableJobV2Scope["visibility"],
  };
}

function validateServeAuthority(
  raw: unknown,
  expectedScope?: DurableJobV2Scope,
): AuthorityScope {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RuntimeHostFactoryError("DURABLE_JOB_V2_AUTHORITY_REQUIRED");
  }
  try {
    const authority = raw as AuthorityScope;
    const request = expectedScope
      ? {
          appId: expectedScope.appId,
          projectId: expectedScope.projectId,
          agentId: expectedScope.agentId,
          namespace: expectedScope.namespace,
          visibility: expectedScope.visibility,
        }
      : authoritySeed(authority);
    const resolved = resolveAuthorityScope(authority, request);
    if (expectedScope && (
      resolved.tenantId !== expectedScope.tenantId ||
      resolved.userId !== expectedScope.userId ||
      resolved.appId !== expectedScope.appId ||
      resolved.projectId !== expectedScope.projectId ||
      resolved.agentId !== expectedScope.agentId ||
      resolved.namespace !== expectedScope.namespace ||
      resolved.visibility !== expectedScope.visibility
    )) {
      throw new Error("default scope does not match authority");
    }
    return Object.freeze({
      tenantId: resolved.tenantId,
      userId: resolved.userId,
      ...(resolved.workspaceId === undefined ? {} : { workspaceId: resolved.workspaceId }),
      ...(resolved.sessionId === undefined ? {} : { sessionId: resolved.sessionId }),
      allow: Object.freeze({
        appIds: Object.freeze([...authority.allow.appIds]),
        projectIds: Object.freeze([...authority.allow.projectIds]),
        agentIds: Object.freeze([...authority.allow.agentIds]),
        namespaces: Object.freeze([...authority.allow.namespaces]),
        visibilities: Object.freeze([...authority.allow.visibilities]),
      }),
    });
  } catch (error) {
    if (error instanceof RuntimeHostFactoryError) throw error;
    throw new RuntimeHostFactoryError("DURABLE_JOB_V2_AUTHORITY_INVALID");
  }
}

// Module-private provenance marker prevents accidental structural wiring into serve.
// It is not a security sandbox against code already executing in this JS process.
const RUNTIME_MINTED_CAPABILITIES = new WeakSet<object>();

function hasExactAuthoritativeTypes(types: readonly string[]): boolean {
  return isDurableJobV2AuthoritativeTypes(types);
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
  const contract = createDurableJobHandlerRegistry(capability.registry.types);
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
    for (const type of input.registry.types) {
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
      types: Object.freeze([...input.registry.types]),
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
        !isDurableJobV2AuthoritativeTypes(bundle.handlerTypes) ||
        ((bundle.handlerTypes as readonly string[]).includes("evolve_memory_batch") !==
          (typeof bundle.createEvolutionPersistence === "function")) ||
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
  if (runtime.config.server?.workerOwnership === "external-runtime-host") {
    throw new RuntimeHostFactoryError("DURABLE_JOB_V2_EXTERNAL_OWNER");
  }
  if (typeof runtime.start !== "function" || typeof runtime.stop !== "function" ||
      typeof runtime.lifecycle?.snapshot !== "function") {
    throw new RuntimeHostFactoryError("DURABLE_JOB_V2_CAPABILITY_INVALID");
  }
  // A supplied malformed authority is rejected before touching provider-owned composition.
  if (options.authority !== undefined) validateServeAuthority(options.authority);
  const bundle = validateRuntimeBundle(runtime.db, runtime.durableJobV2RuntimeBundle);
  const capability = validateCapability(runtime.durableJobV2ServeCapability);
  if (capability.repository !== bundle.repository ||
      capability.registry.types.length !== bundle.handlerTypes.length ||
      capability.registry.types.some((type, index) => type !== bundle.handlerTypes[index])) {
    throw new RuntimeHostFactoryError("DURABLE_JOB_V2_RUNTIME_BUNDLE_INVALID");
  }
  const authority = validateServeAuthority(options.authority, capability.scope);
  const backgroundWork = runtime.backgroundWork ?? new RuntimeBackgroundWork({ scope: capability.scope, config: runtime.config.server?.backgroundWork });
  const startSupervisor = options.startSupervisor ?? startBroadAuthorityDurableJobV2Supervisor;
  const supervisorOptions: BroadAuthorityDurableJobV2SupervisorOptions = {
    authority,
    workerId: options.workerId ?? "mengshu-serve-worker",
    leaseMs: options.leaseMs ?? 30_000,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 10_000,
    intervalMs: options.intervalMs ?? 1_000,
    maxScopesPerTick: options.maxScopesPerTick ?? 100,
    maxJobsPerTick: options.maxJobsPerTick ?? options.maxPerTick ?? 100,
    stopTimeoutMs: options.stopTimeoutMs ?? 5_000,
    registry: capability.registry,
    selectWork: signal => backgroundWork.select(signal),
    ...(runtime.evolutionMaintenance ? { onIdle: (signal: AbortSignal) => runtime.evolutionMaintenance!.onIdle(signal) } : {}),
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
    startWorker: () => startSupervisor(capability.repository, supervisorOptions),
    // production composition 不注入 probeWorker；RuntimeHost 严禁用 tick 做 readiness probe。
    workerProbeTimeoutMs: 5_000,
    workerStopTimeoutMs: supervisorOptions.stopTimeoutMs,
  });
}
