/**
 * OpenClaw `ms` server CLI commands.
 *
 * 这里只注册 serve/status/health 三个中间件入口；既有 stats/search/scan 等命令
 * 仍保留在 index.ts，避免一次性迁移全部 CLI。
 */

import type { MemoryConfig } from "../../config.js";
import type { MemoryService } from "../../core/service-types.js";
import type { TableStats } from "../../db/types.js";
import { startMemoryServer, type StartMemoryServerOptions } from "../../server/daemon.js";
import { planV4Migration } from "../../migration/v4.js";

export interface CommanderLike {
  command(name: string): CommanderLike;
  description(text: string): CommanderLike;
  option(flag: string, description: string, defaultValue?: unknown): CommanderLike;
  action(handler: (...args: unknown[]) => unknown): CommanderLike;
}

export interface RegisterMemoryServerCliOptions {
  config: Pick<MemoryConfig, "dbType" | "dbPath" | "server">;
  service: MemoryService;
  getTableStats?: () => Promise<TableStats[]>;
  startServer?: typeof startMemoryServer;
  keepAlive?: boolean;
  /** Console 聚合 API，注入后 serve 启动的 daemon 暴露 /v1/console/* 与 Candidates 闭环。 */
  console?: StartMemoryServerOptions["console"];
  /** Agent 快路径服务，注入后 daemon 暴露 /v1/agent/*（context/observe/lookup/session）。 */
  agentFastPath?: StartMemoryServerOptions["agentFastPath"];
  /** 后台 job worker，注入后 daemon 在 listen 期间 drain extract_candidate 等 job。 */
  worker?: StartMemoryServerOptions["worker"];
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

export function registerMemoryServerCliCommands(
  memory: CommanderLike,
  options: RegisterMemoryServerCliOptions,
): void {
  memory
    .command("serve")
    .description("Start the local memory REST server")
    .option("--host <host>", "Host to bind")
    .option("--port <port>", "Port to bind")
    .action(async (opts = {}) => {
      const values = opts as { host?: string; port?: string };
      const host = values.host ?? serverHost(options.config);
      const port = values.port ? Number.parseInt(values.port, 10) : serverPort(options.config);
      const running = await (options.startServer ?? startMemoryServer)({
        service: options.service,
        console: options.console,
        agentFastPath: options.agentFastPath,
        worker: options.worker,
        host,
        port,
        secret: options.config.server?.secret,
        requireHttps: options.config.server?.requireHttps,
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
      const health = await options.service.health();
      console.log("Memory Middleware Status:");
      console.log(`- Server URL: ${serverUrl(options.config)}`);
      console.log(`- Database type: ${options.config.dbType ?? "lancedb"}`);
      if (options.config.dbPath) {
        console.log(`- Database path: ${options.config.dbPath}`);
      }
      console.log(`- Service healthy: ${health.ok}`);
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
    });

  memory
    .command("health")
    .description("Show memory service health as JSON")
    .action(async () => {
      console.log(JSON.stringify(await options.service.health(), null, 2));
    });

  memory
    .command("migrate")
    .description("Plan or run memory schema migration")
    .option("--to-schema <schema>", "Target schema version", "v4")
    .option("--dry-run", "Only print migration estimates", true)
    .action(async (opts = {}) => {
      const values = opts as { toSchema?: string; dryRun?: boolean };
      if ((values.toSchema ?? "v4") !== "v4") {
        throw new Error("Only --to-schema v4 is supported");
      }
      const health = await options.service.health();
      const sourceRecords = health.records ?? 0;
      const plan = planV4Migration(Array.from({ length: sourceRecords }, (_, index) => ({
        id: `record-${index}`,
        scope: {
          tenantId: "local",
          appId: "openclaw",
          userId: "default",
          projectId: "default",
          agentId: "default",
          namespace: "memories",
        },
        kind: "fact",
        text: "",
        contentHash: `hash-${index}`,
        importance: 0,
        category: "other",
        dataType: "memory",
        tableName: "memories",
        metadata: {},
        provenance: {},
        createdAt: 0,
      })), values.dryRun ?? true);
      console.log(JSON.stringify(plan, null, 2));
    });
}
