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
import {
  createMengshuRuntime,
  type MengshuRuntime,
} from "../../../../runtime.js";
import type { DatabaseProvider } from "../../../core/src/db/types.js";
import { ingestMarkdownDirectory } from "../../../../ingest/adapters/file-system.js";
import { registerMemoryServerCliCommands } from "../../../../adapters/openclaw/cli.js";
import { registerDoctorCliCommands } from "../../../../adapters/openclaw/cli-doctor.js";
import { registerForgetCliCommands } from "../../../../adapters/openclaw/cli-forget.js";
import { registerMigrateHomeCommand } from "../../../../adapters/openclaw/cli-migrate-home.js";
import { registerProjectCliCommands } from "../../../../adapters/openclaw/cli-project.js";
import { registerRecallCliCommands } from "../../../../adapters/openclaw/cli-recall.js";
import { runInteractiveSetup } from "../../../../adapters/openclaw/cli-setup.js";
import { registerWhyCliCommands } from "../../../../adapters/openclaw/cli-why.js";
import { resolveCategoryName, resolveTableName } from "../../../../adapters/openclaw/tools.js";
import {
  createServeRuntimeHost,
  type ServeRuntimeHostSource,
} from "../../../../server/runtime-host-factory.js";
import { registerEmbeddingSpaceCliCommands } from "./embedding-space.js";
import { registerEvalCliCommands } from "./eval.js";
import { describeOpenClawEmbeddingStatus } from "../../../../plugins/openclaw/src/embedding-status.js";
import {
  isAuthorityScopedForgetCapability,
  type AuthorityScopedForgetCapability,
} from "../../../core/src/service/authority-forget-capability.js";
import {
  loadMcpServerAuthorityFromEnv,
  type McpServerAuthorityConfig,
} from "../../../mcp/src/server.js";
import {
  startMcpStdioServer,
  waitForMcpServerShutdown,
} from "../../../mcp/src/stdio-server.js";
import { PostgresProvider } from "../../../core/src/db/providers/postgres.js";
import { readRegistry } from "../../../core/src/runtime/registry.js";
import { createPostgresSchemaCutoverPort } from
  "../../../../plugins/openclaw/src/cli/migrate-v10.js";

const LEGACY_ENV_PATH = path.join(resolveLegacyHomeDir(), ".env");
const CLI_VERSION = "1.0.6";

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
  program.command("setup").description("Interactive setup wizard for global mengshu configuration");
  program.command("doctor").description("Check config, embedding, DB and project state");
  program.command("demo").description("Seed sample working context and demo context/lookup");
  program.command("connect [appId]").description("Print connection info for the local memory server");
  program.command("mcp").description("Start MCP stdio server for local clients");
  program.command("serve").description("Start the local memory REST server");
  program.command("status").description("Show memory middleware status");
  program.command("health").description("Show memory service health as JSON");
  program.command("migrate").description("Plan or run memory schema migration");
  program.command("project").description("Project memory workspace commands");
  program.command("recall <query>").description("Recall memories with optional explanation");
  program.command("forget").description("Forget memories by id or filter");
  program.command("why <memoryId>").description("Explain a memory's provenance and scoring");
  program.command("migrate-home").description("Migrate ~/.openclaw/ to ~/.mengshu/ (dry-run by default)");
  program.command("migrate-openclaw-plugin-id").description("Migrate legacy OpenClaw plugin ids");
  program.command("eval").description("Evaluation tools for OpenClaw history golden set");
  program.command("stats").description("Show memory statistics");
  program.command("search <query>").description("Search memories");
  program.command("scan <directory>").description("Scan a directory of Markdown files into memory");
  program.command("embedding-space").description("Inspect or explicitly activate the embedding space");
  console.log(program.helpInformation());
}

function isMcpCommand(argv: string[]): boolean {
  return argv[2] === "mcp";
}

const SERVER_AUTHORITY_COMMANDS = new Set(["mcp", "serve", "status", "health", "migrate"]);

/** 这些命令开放 server/host surface，必须在读取 config 或创建 runtime 前获得 host-owned authority。 */
export function requiresServerAuthority(argv: string[]): boolean {
  return SERVER_AUTHORITY_COMMANDS.has(argv[2] ?? "");
}

type RuntimeForgetCapability = AuthorityScopedForgetCapability;

/** Only expose forget when the live runtime proves a real Postgres transaction port. */
export function resolveRuntimeForgetCapability(
  runtime: Pick<MengshuRuntime, "authorityScopedForgetCapability">,
): RuntimeForgetCapability | undefined {
  return isAuthorityScopedForgetCapability(runtime.authorityScopedForgetCapability)
    ? runtime.authorityScopedForgetCapability
    : undefined;
}

/** `ms serve` 的唯一 production Host composition；当前 runtime 缺 v2 capability 时明确失败。 */
export function createCliServeRuntimeHost(runtime: ServeRuntimeHostSource) {
  return createServeRuntimeHost(runtime);
}

export interface CliProgramLike {
  parseAsync(argv: string[]): Promise<unknown>;
}

export interface StoppableRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * 让 CLI command 的生命周期拥有 runtime：短命令结束（含失败）后立即释放；
 * mcp/serve 的 parse promise 在服务存活期间不结束，因此不会被提前 stop。
 */
export async function runCliProgram(
  program: CliProgramLike,
  argv: string[],
  runtime: StoppableRuntime,
): Promise<void> {
  let failed = false;
  let primaryFailure: unknown;
  try {
    await runtime.start();
    await program.parseAsync(argv);
  } catch (error) {
    failed = true;
    primaryFailure = error;
  }
  try {
    await runtime.stop();
  } catch (stopFailure) {
    if (failed) {
      throw new AggregateError(
        [primaryFailure, stopFailure],
        "CLI execution and runtime shutdown both failed",
      );
    }
    throw stopFailure;
  }
  if (failed) throw primaryFailure;
}

/**
 * `ms migrate` owns only fixed read-only inspection by default. It must never run
 * the general runtime lifecycle before Commander has evaluated the apply gates.
 */
export async function runSchemaMigrationCliProgram(
  program: CliProgramLike,
  argv: string[],
  database: Pick<DatabaseProvider, "close">,
): Promise<void> {
  let failed = false;
  let primaryFailure: unknown;
  try {
    await program.parseAsync(argv);
  } catch (error) {
    failed = true;
    primaryFailure = error;
  }
  try {
    await database.close();
  } catch (closeFailure) {
    if (failed) {
      throw new AggregateError(
        [primaryFailure, closeFailure],
        "Schema migration CLI execution and database close both failed",
      );
    }
    throw closeFailure;
  }
  if (failed) throw primaryFailure;
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

  // Help/version are pure CLI surfaces. Never parse config, authority, or start runtime.
  if (wantsHelpOrVersion(argv)) {
    printConfiglessHelp(argv);
    return;
  }

  // MENGSHU_AUTHORITY_JSON/FILE 是通用 server authority 边界，不只服务 MCP。
  // 所有 host surface 都必须在 config/runtime/DB/listener 之前使用同一个严格 parser 验证；
  // identity 不得来自 client 参数、defaultScope 推导或硬编码。
  const serverAuthority: McpServerAuthorityConfig | undefined = requiresServerAuthority(argv)
    ? loadMcpServerAuthorityFromEnv(process.env)
    : undefined;

  if (!fs.existsSync(configPath)) {
    console.error(`配置文件不存在: ${configPath}`);
    console.error("请先运行 'ms' (不带参数) 或 'ms init' 初始化配置");
    process.exitCode = 1;
    return;
  }

  const rawConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const cfg = memoryConfigSchema.parse(rawConfig);

  const resolvedDbPath = resolveRuntimeDbPath(cfg, configPath);

  const defaultScope = serverAuthority?.defaultScope ?? {
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
    embeddingStatus: () => describeOpenClawEmbeddingStatus(
      runtime.config.dbType,
      runtime.embeddingWriteGuard.snapshot(),
      runtime.embeddingReadGuard.snapshot(),
      runtime.lifecycle.snapshot(),
    ),
  });

  program
    .command("mcp")
    .description("Start MCP stdio server for local clients (Codex / Claude Desktop)")
    .action(async () => {
      if (!serverAuthority) {
        throw new Error("MCP authority configuration is required");
      }
      const running = await startMcpStdioServer({
        service: runtime.memoryService,
        forgetCapability: resolveRuntimeForgetCapability(runtime),
        authority: serverAuthority.authority,
        defaultScope: serverAuthority.defaultScope,
        agentFastPath: runtime.agentFastPath,
        namespaces: ["memories", "knowledge"],
        pipeline: runtime.ingestionPipeline,
        llmClient: runtime.llmClient,
      });
      process.stderr.write("MCP stdio server started (Ctrl+C to stop)\n");
      try {
        const reason = await waitForMcpServerShutdown(running);
        if (reason === "SIGINT") process.exitCode = 130;
        if (reason === "SIGTERM") process.exitCode = 143;
      } finally {
        await running.close();
      }
    });

  registerMemoryServerCliCommands(program, {
    authority: serverAuthority?.authority,
    config: cfg,
    service: runtime.memoryService,
    console: runtime.consoleApi,
    agentFastPath: runtime.agentFastPath,
    defaultScope: runtime.defaultScope,
    runtimeHostFactory: () => createCliServeRuntimeHost(runtime),
    getTableStats: runtime.db.getTableStats ? () => runtime.db.getTableStats!() : undefined,
    schemaCutover: runtime.db instanceof PostgresProvider
      ? {
          port: createPostgresSchemaCutoverPort(runtime.db),
          getRegistry: () => readRegistry(),
        }
      : undefined,
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

  registerEmbeddingSpaceCliCommands(program, {
    dbType: cfg.dbType,
    runtimeSpace: runtime.embeddingSpace,
    getActive: typeof runtime.db.getActiveEmbeddingSpace === "function"
      ? () => runtime.db.getActiveEmbeddingSpace!()
      : undefined,
    registerActive: typeof runtime.db.registerActiveEmbeddingSpace === "function"
      ? (space) => runtime.db.registerActiveEmbeddingSpace!(space)
      : undefined,
  });

  program
    .command("scan <directory>")
    .description("Scan a directory of Markdown files into memory")
    .option("--ignore <paths...>", "Paths to ignore")
    .option("--ignore-rule <rules...>", "Additional gitignore-style ignore rules")
    .option("--category <name>", "Storage category: 核心记忆 | 知识库 (default: 知识库)", "知识库")
    .option("--chunk-size <n>", "Maximum characters per chunk")
    .option("--include-hidden", "Include hidden files", false)
    .action(async (
      directory: string,
      options: {
        ignore?: string[];
        ignoreRule?: string[];
        category?: string;
        chunkSize?: string;
        includeHidden?: boolean;
      } = {},
    ) => {
      const resolvedDir = resolveMaybeRelative(directory, process.cwd());
      const tableName = resolveTableName(options.category ?? "知识库");
      const chunkSize = options.chunkSize ? Number.parseInt(options.chunkSize, 10) : undefined;
      if (chunkSize !== undefined && (!Number.isFinite(chunkSize) || chunkSize <= 0)) {
        throw new Error("--chunk-size must be a positive integer");
      }

      console.log(`Scanning directory: ${resolvedDir}`);
      console.log(`Storage category: ${resolveCategoryName(tableName)}`);

      const result = await ingestMarkdownDirectory({
        directory: resolvedDir,
        scope: {
          ...defaultScope,
          namespace: tableName,
        },
        pipeline: runtime.ingestionPipeline,
        scannerOptions: {
          ignorePaths: [
            ...(options.ignore ?? []),
            ...(cfg.scanner?.defaultIgnorePaths ?? []),
          ],
          ignoreRules: [
            ...(options.ignoreRule ?? []),
            ...(cfg.scanner?.customIgnoreRules ?? []),
          ],
          includeHidden: options.includeHidden ?? false,
        },
        chunkSize,
        targetTable: tableName,
        autoEnrichMetadata: cfg.scanner?.autoEnrichMetadata,
      });

      console.log("\nScan completed:");
      console.log(`- Total files: ${result.totalFiles}`);
      console.log(`- Processed: ${result.processedFiles}`);
      console.log(`- Failed: ${result.failedFiles}`);
      console.log(`- Total chunks: ${result.totalChunks}`);
      console.log(`- Stored: ${result.storedChunks}`);
      console.log(`- Duplicates skipped: ${result.duplicateChunks}`);
      console.log(`- Jobs queued: ${result.jobsQueued}`);
      console.log(`- Chunks admitted: ${result.chunksAdmitted}`);
      console.log(`- Chunks dropped: ${result.chunksDropped}`);
      if (result.totalFiles === 0) {
        console.log("\nNo Markdown files found. `ms scan` currently imports .md and .mdx files.");
      }
      if (result.errors.length > 0) {
        console.log("\nErrors:");
        for (const error of result.errors) {
          console.log(`- ${error.filePath}: ${error.error}`);
        }
      }
    });

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

  try {
    if (argv[2] === "migrate") {
      await runSchemaMigrationCliProgram(program, argv, runtime.db);
    } else {
      await runCliProgram(program, argv, runtime);
    }
  } catch (error) {
    if (isMcpCommand(argv)) {
      void error;
      throw new Error("MCP server failed (STARTUP_OR_SHUTDOWN_ERROR)");
    }
    throw error;
  }
}
