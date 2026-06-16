#!/usr/bin/env tsx
/**
 * mengshu CLI 入口
 *
 * 支持两种模式：
 * 1. 带参数：执行 CLI 命令（ms doctor / ms stats / ms search 等）
 * 2. 无参数：启动 MCP stdio server（若配置不存在则先引导设置）
 */
import fs from "node:fs";
import { Command } from "commander";
import { resolveConfigPath, expandHome, resolveEnvPath, resolveLegacyHomeDir } from "../core/paths.js";
import { runInteractiveSetup } from "../adapters/openclaw/cli-setup.js";
import { memoryConfigSchema } from "../config.js";
import { DatabaseFactory } from "../db/factory.js";
import { Embeddings } from "../processing/embeddings.js";
import { DefaultMemoryService } from "../core/memory-service.js";
import { LegacyDatabaseAdapter } from "../storage/legacy-database-adapter.js";
import { registerDoctorCliCommands } from "../adapters/openclaw/cli-doctor.js";
import { registerMcpCliCommands } from "../adapters/openclaw/cli-mcp.js";
import { registerMemoryServerCliCommands } from "../adapters/openclaw/cli.js";
import { registerProjectCliCommands } from "../adapters/openclaw/cli-project.js";
import { registerMigrateHomeCommand } from "../adapters/openclaw/cli-migrate-home.js";
import { AgentFastPathService } from "../api/agent-fast-path.js";
import { extractRecords } from "../adapters/openclaw/agent-service-helper.js";
import path from "node:path";

const LEGACY_ENV_PATH = path.join(resolveLegacyHomeDir(), ".env");

function loadDotEnv(envPath: string): void {
  if (!fs.existsSync(envPath)) {
    return;
  }

  const text = fs.readFileSync(envPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const index = line.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function resolveMaybeRelative(input: string, baseDir: string): string {
  const expanded = expandHome(input);
  return path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
}

async function main(): Promise<void> {
  const configPath = resolveConfigPath();

  // 如果没有任何参数，检查配置并启动 MCP server
  if (process.argv.length === 2) {
    if (!fs.existsSync(configPath)) {
      // 首次使用，引导设置
      const result = await runInteractiveSetup();
      if (!result.configWritten) {
        process.exit(0);
      }
      console.log("\n配置完成，启动 MCP server...\n");
    }

    // 启动 MCP server
    await import("../scripts/mengshu-mcp.js");
    return;
  }

  // 有参数，执行 CLI 命令
  // 加载环境变量
  const explicitEnv = process.env.MENGSHU_ENV;
  const envPath = explicitEnv ? expandHome(explicitEnv) : resolveEnvPath();
  if (fs.existsSync(envPath)) {
    loadDotEnv(envPath);
  } else if (!explicitEnv && fs.existsSync(LEGACY_ENV_PATH)) {
    loadDotEnv(LEGACY_ENV_PATH);
  }

  // 加载配置
  if (!fs.existsSync(configPath)) {
    console.error(`配置文件不存在: ${configPath}`);
    console.error("请先运行 'ms' (不带参数) 或 'ms init' 初始化配置");
    process.exit(1);
  }

  const rawConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const cfg = memoryConfigSchema.parse(rawConfig);

  // 解析数据库路径
  const dbPath = cfg.dbPath ?? "~/.mengshu/memory/lancedb";
  const configDir = path.dirname(configPath);
  const resolvedDbPath = resolveMaybeRelative(dbPath, configDir);

  // 初始化服务
  const db = DatabaseFactory.createProvider(cfg, resolvedDbPath);
  const embeddings = new Embeddings(cfg.embedding, cfg.batchProcessing);
  const repository = new LegacyDatabaseAdapter(db, { appId: "mengshu" });
  const memoryService = new DefaultMemoryService({ repository, embeddings });

  const defaultScope = {
    tenantId: "local",
    appId: "mengshu",
    userId: "default",
    projectId: "default",
    agentId: "default",
    namespace: "working-context",
    visibility: "private" as const,
  };

  const agentFastPath = new AgentFastPathService({
    defaultScope,
    loadRecordsForScope: async (scope) => {
      const result = await memoryService.recall({
        query: "",
        scope,
        limit: 50,
        minScore: 0,
        searchAll: true,
      });
      return extractRecords(result.hits);
    },
    recall: async (scope, query, opts) =>
      memoryService.recall({
        query,
        scope,
        limit: opts?.limit ?? 10,
        minScore: opts?.minScore ?? 0.1,
        searchAll: true,
      }),
    storeObservation: async () => ({ id: "not-implemented" }),
    enqueueJob: async ({ type }) => `standalone-${type}-${Date.now()}`,
    logger: {
      warn: (message) => console.warn(`[mengshu] ${message}`),
    },
  });

  // 创建 Commander 实例
  const program = new Command();
  program
    .name("ms")
    .description("Mengshu (梦枢) - Local-first memory middleware")
    .version("2026.3.9");

  // 注册所有命令
  registerDoctorCliCommands(program, {
    config: cfg,
    service: memoryService,
    embeddings,
  });

  registerMcpCliCommands(program, {
    service: memoryService,
    agentFastPath,
    namespaces: ["memories", "knowledge"],
  });

  registerMemoryServerCliCommands(program, {
    config: cfg,
    service: memoryService,
    getTableStats: db.getTableStats ? () => db.getTableStats!() : undefined,
  });

  registerProjectCliCommands(program, {
    service: memoryService,
    getRecordCount: () => db.count(),
  });

  registerMigrateHomeCommand(program);

  // 基础命令
  program
    .command("stats")
    .description("Show memory statistics")
    .action(async () => {
      const totalCount = await db.count();
      const memoryCount = await db.count({ dataType: "memory" });
      const documentCount = await db.count({ dataType: "document" });

      console.log("Memory Statistics:");
      console.log(`- Total entries: ${totalCount}`);
      console.log(`- User memories: ${memoryCount}`);
      console.log(`- Scanned documents: ${documentCount}`);
      console.log(`- Database type: ${cfg.dbType}`);

      if (db.getTableStats) {
        const stats = await db.getTableStats();
        console.log("\nTables:");
        for (const stat of stats) {
          console.log(`- ${stat.name}: ${stat.count} entries`);
        }
      }
    });

  program
    .command("search <query>")
    .description("Search memories")
    .option("-l, --limit <n>", "Maximum results", "10")
    .option("-s, --min-score <n>", "Minimum score", "0.3")
    .action(async (query: string, options: { limit: string; minScore: string }) => {
      const result = await memoryService.recall({
        query,
        scope: defaultScope,
        limit: parseInt(options.limit, 10),
        minScore: parseFloat(options.minScore),
        searchAll: true,
      });

      console.log(`Found ${result.hits.length} results:\n`);
      for (const hit of result.hits) {
        const record = hit.record as any;
        console.log(`[${hit.score.toFixed(3)}] ${record.text || ''}`);
        console.log(`  Kind: ${record.kind || 'unknown'} | Category: ${record.category || 'unknown'}`);
        console.log();
      }
    });

  // 解析命令
  await program.parseAsync(process.argv);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
});
