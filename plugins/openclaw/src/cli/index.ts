/**
 * OpenClaw `ms` server CLI commands.
 *
 * 这里只注册 serve/status/health 三个中间件入口；既有 stats/search/scan 等命令
 * 仍保留在 index.ts，避免一次性迁移全部 CLI。
 */

import { createConnection } from "node:net";
import { resolve } from "node:path";
import type { MemoryConfig } from "../../../../config.js";
import type { MemoryService } from "../../../../core/service-types.js";
import type { TableStats } from "../../../../db/types.js";
import type { MemoryScope } from "../../../../packages/core/src/domain/types.js";
import type { AuthorityScope } from "../../../../packages/core/src/domain/authority-scope.js";
import type { MemoryAutodbRegistry } from "../../../../packages/core/src/runtime/registry.js";
import {
  startMemoryServer,
  type MemoryServerLifecycleHost,
  type StartMemoryServerOptions,
} from "../../../../server/daemon.js";
import { resolveOpenClawAuthorityScope } from "../authority.js";
import {
  POSTGRES_SCHEMA_CUTOVER_TARGET,
  PostgresSchemaCutoverCliError,
  runPostgresSchemaCutover,
  type PostgresSchemaCutoverPort,
} from "./migrate-v10.js";

export interface CommanderLike {
  command(name: string): CommanderLike;
  description(text: string): CommanderLike;
  option(flag: string, description: string, defaultValue?: unknown): CommanderLike;
  action(handler: (...args: unknown[]) => unknown): CommanderLike;
}

export interface OpenClawCliAuthorityContext {
  /** Authenticated server authority. CLI code must never synthesize this value. */
  authority?: AuthorityScope;
  /** Runtime-owned default request, validated against authority before use. */
  defaultScope?: MemoryScope;
}

export function requireOpenClawCliAuthority(
  context: Partial<OpenClawCliAuthorityContext>,
): MemoryScope {
  if (!context.authority || !context.defaultScope) {
    throw new Error("OpenClaw CLI authenticated authority and defaultScope are required");
  }
  return resolveOpenClawAuthorityScope(context.authority, context.defaultScope);
}

export function resolveOpenClawCliScope(
  context: OpenClawCliAuthorityContext,
  request?: Record<string, unknown>,
): MemoryScope {
  requireOpenClawCliAuthority(context);
  return resolveOpenClawAuthorityScope(context.authority!, context.defaultScope!, request);
}

export interface RegisterMemoryServerCliOptions extends OpenClawCliAuthorityContext {
  config: Pick<MemoryConfig, "dbType" | "dbPath" | "server" | "evolution">;
  service: MemoryService;
  getTableStats?: () => Promise<TableStats[]>;
  startServer?: typeof startMemoryServer;
  keepAlive?: boolean;
  /** Runtime 持有的统一 Write Kernel 能力；serve 只负责透传。 */
  memoryWrite?: StartMemoryServerOptions["memoryWrite"];
  memoryEvolution?: StartMemoryServerOptions["memoryEvolution"];
  continuousMemoryEvolution?: StartMemoryServerOptions["continuousMemoryEvolution"];
  backgroundWork?: StartMemoryServerOptions["backgroundWork"];
  foregroundActivity?: StartMemoryServerOptions["foregroundActivity"];
  evolutionMaintenance?: StartMemoryServerOptions["evolutionMaintenance"];
  sessionWorkingSet?: StartMemoryServerOptions["sessionWorkingSet"];
  sessionWorkingSetMemoryBridge?: StartMemoryServerOptions["sessionWorkingSetMemoryBridge"];
  skillArtifacts?: StartMemoryServerOptions["skillArtifacts"];
  memoryPolicyOverlays?: StartMemoryServerOptions["memoryPolicyOverlays"];
  memoryPolicyResolver?: StartMemoryServerOptions["memoryPolicyResolver"];
  runtimeMcp?: StartMemoryServerOptions["runtimeMcp"];
  /** Console 聚合 API，注入后 serve 启动的 daemon 暴露 /v1/console/* 与 Candidates 闭环。 */
  console?: StartMemoryServerOptions["console"];
  /** Agent 快路径服务，注入后 daemon 暴露 /v1/agent/*（context/observe/lookup/session）。 */
  agentFastPath?: StartMemoryServerOptions["agentFastPath"];
  /** Production serve 必须显式构造 Durable Job v2 RuntimeHost；缺失时 fail-closed。 */
  runtimeHostFactory?: () => MemoryServerLifecycleHost;
  serverLogger?: StartMemoryServerOptions["logger"];
  /** 进程终止信号注册器；测试可注入，生产默认监听 SIGINT/SIGTERM。 */
  registerShutdownSignal?: StartMemoryServerOptions["registerShutdownSignal"];
  /** Listener 探针；测试可注入，默认执行有超时的 TCP connect。 */
  probeServer?: (target: ServerProbeTarget) => Promise<boolean>;
  /** PostgreSQL-only, provider-owned fixed migration facade plus one-run registry snapshot. */
  schemaCutover?: {
    readonly port: PostgresSchemaCutoverPort;
    readonly getRegistry: () => MemoryAutodbRegistry;
  };
}

export function registerNodeShutdownSignals(
  handler: () => Promise<void>,
): () => void {
  let triggered = false;
  let registered = true;
  const onSignal = () => {
    if (triggered) return;
    triggered = true;
    void handler().catch(() => {
      process.exitCode = 1;
      process.stderr.write("Memory server shutdown failed\n");
    });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return () => {
    if (!registered) return;
    registered = false;
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  };
}

export interface ServerProbeTarget {
  host: string;
  port: number;
}

function serverHost(config: RegisterMemoryServerCliOptions["config"]): string {
  return config.server?.host ?? "127.0.0.1";
}

function serverPort(config: RegisterMemoryServerCliOptions["config"]): number {
  return config.server?.port ?? 3847;
}

function serverUrl(config: RegisterMemoryServerCliOptions["config"]): string {
  return `http://${serverHost(config)}:${serverPort(config)}`;
}

function listenerConnectHost(host: string): string {
  if (host === "0.0.0.0") {
    return "127.0.0.1";
  }
  if (host === "::") {
    return "::1";
  }
  return host;
}

export function probeTcpListener(target: ServerProbeTarget, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (reachable: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    const socket = createConnection({
      host: listenerConnectHost(target.host),
      port: target.port,
    });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

export function registerMemoryServerCliCommands(
  memory: CommanderLike,
  options: RegisterMemoryServerCliOptions,
): void {
  memory
    .command("serve")
    .description("Start the local memory REST server")
    .option("--host <host>", "Host to bind")
    .option("--port <port>", "Port to bind")
    .option("--socket <path>", "Owner-only Unix socket under MENGSHU_HOME/run")
    .action(async (opts = {}) => {
      requireOpenClawCliAuthority(options);
      const values = opts as { host?: string; port?: string; socket?: string };
      const host = values.host ?? serverHost(options.config);
      const port = values.port ? Number.parseInt(values.port, 10) : serverPort(options.config);
      const socketPath = values.socket ?? process.env.MENGSHU_RUNTIME_SOCKET;
      if (!options.runtimeHostFactory) {
        throw new Error("Durable Job v2 RuntimeHost factory is required for serve");
      }
      const runtimeHost = options.runtimeHostFactory();
      const running = await (options.startServer ?? startMemoryServer)({
        service: options.service,
        memoryWrite: options.memoryWrite,
        memoryEvolution: options.memoryEvolution,
        continuousMemoryEvolution: options.continuousMemoryEvolution,
        backgroundWork: options.backgroundWork,
        foregroundActivity: options.foregroundActivity,
        evolutionMaintenance: options.evolutionMaintenance,
        evolutionOwnerSecret: options.config.evolution?.control?.ownerSecret,
        sessionWorkingSet: options.sessionWorkingSet,
        sessionWorkingSetMemoryBridge: options.sessionWorkingSetMemoryBridge,
        skillArtifacts: options.skillArtifacts,
        memoryPolicyOverlays: options.memoryPolicyOverlays,
        memoryPolicyResolver: options.memoryPolicyResolver,
        ...(options.runtimeMcp ? { runtimeMcp: options.runtimeMcp } : {}),
        console: options.console,
        agentFastPath: options.agentFastPath,
        authority: options.authority,
        runtimeHost,
        // Production serve 禁止回退到 legacy ingestionStore.jobs worker。
        worker: undefined,
        host,
        port,
        ...(socketPath ? { socketPath: resolve(socketPath) } : {}),
        secret: options.config.server?.secret,
        requireHttps: options.config.server?.requireHttps,
        logger: options.serverLogger,
        registerShutdownSignal: options.registerShutdownSignal ?? registerNodeShutdownSignals,
      });
      console.log(`Memory server listening at ${running.url}`);
      if (options.keepAlive === false) {
        return;
      }
      await new Promise<void>(() => {
        // Keep process alive for CLI serve.
      });
    });

  memory
    .command("status")
    .description("Show memory middleware status")
    .action(async () => {
      requireOpenClawCliAuthority(options);
      const target = {
        host: serverHost(options.config),
        port: serverPort(options.config),
      };
      const [health, serverReachable] = await Promise.all([
        options.service.health(),
        (options.probeServer ?? probeTcpListener)(target),
      ]);
      const serviceHealthy = health.ok && serverReachable;
      console.log("Memory Middleware Status:");
      console.log(`- Server URL: ${serverUrl(options.config)}`);
      console.log(`- Database type: ${options.config.dbType ?? "lancedb"}`);
      if (options.config.dbPath) {
        console.log(`- Database path: ${options.config.dbPath}`);
      }
      console.log(`- Server reachable: ${serverReachable}`);
      console.log(`- Service healthy: ${serviceHealthy}`);
      if (typeof health.records === "number") {
        console.log(`- Records: ${health.records}`);
      }
      if (options.getTableStats) {
        const stats = await options.getTableStats();
        console.log("Tables:");
        for (const stat of stats) {
          console.log(`- ${stat.name}: ${stat.count} entries`);
        }
      }
      if (!serverReachable) {
        throw new Error(`Memory server is not reachable at ${serverUrl(options.config)}`);
      }
      if (!health.ok) {
        throw new Error("Memory service is unhealthy");
      }
    });

  memory
    .command("health")
    .description("Show memory service health as JSON")
    .action(async () => {
      console.log(JSON.stringify(await options.service.health(), null, 2));
    });

  memory
    .command("migrate")
    .description("Inspect or apply the PostgreSQL schema/canonical-scope cutover")
    .option(
      "--to-schema <schema>",
      "Target schema version",
      `v${POSTGRES_SCHEMA_CUTOVER_TARGET}`,
    )
    .option("--dry-run", "Only inspect migration and scope backfill state", true)
    .option("--apply", "Apply canonical scope backfill and schema contracts", false)
    .option("--maintenance", "Confirm the runtime is in maintenance mode", false)
    .option("--quiescence-confirmed", "Confirm all old writers are stopped", false)
    .option("--confirm <token>", "Exact confirmation token printed by dry-run")
    .option(
      "--allow-quarantine <count>",
      "Exact existing + planned quarantine count accepted for apply",
    )
    .action(async (opts = {}) => {
      requireOpenClawCliAuthority(options);
      if (options.config.dbType !== "postgres") {
        throw new Error("ms migrate schema cutover is supported only for PostgreSQL");
      }
      if (!options.schemaCutover) {
        throw new Error("PostgreSQL schema cutover capability is unavailable");
      }
      const values = opts as {
        toSchema?: string;
        apply?: boolean;
        maintenance?: boolean;
        quiescenceConfirmed?: boolean;
        confirm?: string;
        allowQuarantine?: string;
      };
      try {
        let allowQuarantine: number | undefined;
        if (values.allowQuarantine !== undefined) {
          if (!/^(0|[1-9][0-9]*)$/.test(values.allowQuarantine)) {
            throw new PostgresSchemaCutoverCliError(
              "SCHEMA_CUTOVER_INVALID_QUARANTINE_ALLOWANCE",
            );
          }
          allowQuarantine = Number(values.allowQuarantine);
          if (!Number.isSafeInteger(allowQuarantine)) {
            throw new PostgresSchemaCutoverCliError(
              "SCHEMA_CUTOVER_INVALID_QUARANTINE_ALLOWANCE",
            );
          }
        }
        const report = await runPostgresSchemaCutover(
          options.schemaCutover.port,
          options.schemaCutover.getRegistry(),
          {
            targetSchema: values.toSchema,
            apply: values.apply === true,
            maintenance: values.maintenance === true,
            quiescenceConfirmed: values.quiescenceConfirmed === true,
            confirmationToken: values.confirm,
            allowQuarantine,
          },
        );
        console.log(JSON.stringify(report, null, 2));
      } catch (error) {
        if (error instanceof PostgresSchemaCutoverCliError && error.report) {
          console.log(JSON.stringify(error.report, null, 2));
        }
        throw error;
      }
    });
}
