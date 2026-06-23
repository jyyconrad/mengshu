/**
 * `ms` CLI 主逻辑。
 *
 * bin/ms.ts 只保留 shebang 入口；这里承载实际命令装配，便于后续把 CLI
 * 从根目录迁入 packages/api。
 */

import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { memoryConfigSchema } from "../../../../config.js";
import { expandHome, resolveConfigPath, resolveEnvPath, resolveLegacyHomeDir } from "../../../../core/paths.js";
import { createMengshuRuntime } from "../../../../runtime.js";
import { registerMemoryServerCliCommands } from "../../../../adapters/openclaw/cli.js";
import { registerDoctorCliCommands } from "../../../../adapters/openclaw/cli-doctor.js";
import { registerForgetCliCommands } from "../../../../adapters/openclaw/cli-forget.js";
import { registerMcpCliCommands } from "../../../../adapters/openclaw/cli-mcp.js";
import { registerMigrateHomeCommand } from "../../../../adapters/openclaw/cli-migrate-home.js";
import { registerProjectCliCommands } from "../../../../adapters/openclaw/cli-project.js";
import { registerRecallCliCommands } from "../../../../adapters/openclaw/cli-recall.js";
import { runInteractiveSetup } from "../../../../adapters/openclaw/cli-setup.js";
import { registerWhyCliCommands } from "../../../../adapters/openclaw/cli-why.js";
import { registerEvalCliCommands } from "./eval.js";

const LEGACY_ENV_PATH = path.join(resolveLegacyHomeDir(), ".env");
const CLI_VERSION = "2026.3.9";

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

function resolveRuntimeDbPath(cfg: { dbType?: string; dbPath?: string }, configPath: string): string {
  if (cfg.dbType === "postgres" || cfg.dbType === "supabase") {
    return "";
  }
  const dbPath = cfg.dbPath ?? "~/.mengshu/memory/lancedb";
  return resolveMaybeRelative(dbPath, path.dirname(configPath));
}

function wantsHelpOrVersion(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("-h") || argv.includes("--version") || argv.includes("-V");
}

function printConfiglessHelp(argv: string[]): void {
  const program = new Command();
  program
    .name("ms")
    .description("Mengshu (梦枢) - Local-first memory middleware")
    .version(CLI_VERSION);

  if (argv.includes("--version") || argv.includes("-V")) {
    console.log(CLI_VERSION);
    return;
  }

  program.command("init").description("Initialize mengshu global/project configuration");
  program.command("doctor").description("Check config, embedding, DB and project state");
  program.command("mcp").description("Start MCP stdio server for local clients");
  program.command("recall <query>").description("Recall memories with optional explanation");
  program.command("forget").description("Forget memories by id or filter");
  program.command("why <memoryId>").description("Explain a memory's provenance and scoring");
  program.command("stats").description("Show memory statistics");
  program.command("search <query>").description("Search memories");
  console.log(program.helpInformation());
}

export async function runMengshuCli(argv: string[] = process.argv): Promise<void> {
  const configPath = resolveConfigPath();

  if (argv.length === 2) {
    if (!fs.existsSync(configPath)) {
      const result = await runInteractiveSetup();
      if (!result.configWritten) {
        return;
      }
      console.log("\n配置完成，启动 MCP server...\n");
    }

    await import("../../../../scripts/mengshu-mcp.js");
    return;
  }

  const explicitEnv = process.env.MENGSHU_ENV;
  const envPath = explicitEnv ? expandHome(explicitEnv) : resolveEnvPath();
  if (fs.existsSync(envPath)) {
    loadDotEnv(envPath);
  } else if (!explicitEnv && fs.existsSync(LEGACY_ENV_PATH)) {
    loadDotEnv(LEGACY_ENV_PATH);
  }

  if (!fs.existsSync(configPath)) {
    if (wantsHelpOrVersion(argv)) {
      printConfiglessHelp(argv);
      return;
    }
    console.error(`配置文件不存在: ${configPath}`);
    console.error("请先运行 'ms' (不带参数) 或 'ms init' 初始化配置");
    process.exitCode = 1;
    return;
  }

  const rawConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const cfg = memoryConfigSchema.parse(rawConfig);

  const resolvedDbPath = resolveRuntimeDbPath(cfg, configPath);

  const defaultScope = {
    tenantId: "local",
    appId: "mengshu",
    userId: "default",
    projectId: "default",
    agentId: "default",
    namespace: "working-context",
    visibility: "private" as const,
  };

  const runtime = createMengshuRuntime({
    config: cfg,
    resolvedDbPath,
    appId: "mengshu",
    defaultScope,
    logger: {
      warn: (message) => console.warn(`[mengshu] ${message}`),
    },
  });

  const program = new Command();
  program
    .name("ms")
    .description("Mengshu (梦枢) - Local-first memory middleware")
    .version(CLI_VERSION);

  registerDoctorCliCommands(program, {
    config: cfg,
    service: runtime.memoryService,
    embeddings: runtime.embeddings,
  });

  registerMcpCliCommands(program, {
    service: runtime.memoryService,
    agentFastPath: runtime.agentFastPath,
    namespaces: ["memories", "knowledge"],
    pipeline: runtime.ingestionPipeline,
    llmClient: runtime.llmClient,
    defaultScope,
  });

  registerMemoryServerCliCommands(program, {
    config: cfg,
    service: runtime.memoryService,
    console: runtime.consoleApi,
    agentFastPath: runtime.agentFastPath,
    worker: {
      jobs: runtime.ingestionStore.jobs,
      leaseMs: 30_000,
      intervalMs: 1_000,
      handlers: runtime.handlers,
    },
    getTableStats: runtime.db.getTableStats ? () => runtime.db.getTableStats!() : undefined,
  });

  registerProjectCliCommands(program, {
    service: runtime.memoryService,
    getRecordCount: () => runtime.db.count(),
    embeddings: runtime.embeddings,
    llmClient: runtime.llmClient,
    db: runtime.db,
  });

  registerWhyCliCommands(program, {
    service: runtime.memoryService,
    scope: defaultScope,
  });

  registerForgetCliCommands(program, {
    repository: runtime.memoryRepository,
    defaultScope,
    embeddings: runtime.embeddings,
  });

  registerRecallCliCommands(program, {
    service: runtime.memoryService,
    defaultScope,
  });

  registerMigrateHomeCommand(program);

  registerEvalCliCommands(program);

  program
    .command("stats")
    .description("Show memory statistics")
    .action(async () => {
      const totalCount = await runtime.db.count();
      const memoryCount = await runtime.db.count({ dataType: "memory" });
      const documentCount = await runtime.db.count({ dataType: "document" });

      console.log("Memory Statistics:");
      console.log(`- Total entries: ${totalCount}`);
      console.log(`- User memories: ${memoryCount}`);
      console.log(`- Scanned documents: ${documentCount}`);
      console.log(`- Database type: ${cfg.dbType}`);

      if (runtime.db.getTableStats) {
        const stats = await runtime.db.getTableStats();
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
      const result = await runtime.memoryService.recall({
        query,
        scope: defaultScope,
        limit: parseInt(options.limit, 10),
        minScore: parseFloat(options.minScore),
        searchAll: true,
      });

      console.log(`Found ${result.hits.length} results:\n`);
      for (const hit of result.hits) {
        const record = hit.record as { text?: string; kind?: string; category?: string };
        console.log(`[${hit.score.toFixed(3)}] ${record.text || ""}`);
        console.log(`  Kind: ${record.kind || "unknown"} | Category: ${record.category || "unknown"}`);
        console.log();
      }
    });

  await program.parseAsync(argv);
}
