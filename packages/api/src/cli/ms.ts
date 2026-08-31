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
import {
  registerMemoryServerCliCommands,
  type RegisterMemoryServerCliOptions,
} from "../../../../adapters/openclaw/cli.js";
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
import { registerRuntimeCostCliCommands } from "./runtime-cost.js";
import { JsonlRuntimeCostLedger } from "../../../core/src/cost/runtime-cost-ledger.js";
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
  createRuntimeMcpFacade,
  startMcpStdioServer,
  waitForMcpServerShutdown,
  type McpStdioServerOptions,
} from "../../../mcp/src/stdio-server.js";
import { PostgresProvider } from "../../../core/src/db/providers/postgres.js";
import type { MemoryScope, MemorySemanticType } from "../../../core/src/domain/types.js";
import type { AuthorityScope } from "../../../core/src/domain/authority-scope.js";
import type { MemoryViewAssetService } from
  "../../../core/src/assets/memory-view-service.js";
import type { AgentLoadoutService } from "../../../core/src/loadout/service.js";
import type { ContextAssemblyReceiptRepository } from
  "../../../core/src/context/assembly-receipt.js";
import {
  projectWorkspaceBindings,
  readRegistry,
} from "../../../core/src/runtime/registry.js";
import {
  createPostgresSchemaCutoverPort,
  POSTGRES_SCHEMA_CUTOVER_TARGET,
} from "../../../../plugins/openclaw/src/cli/migrate-v10.js";

const LEGACY_ENV_PATH = path.join(resolveLegacyHomeDir(), ".env");
const CLI_VERSION = "1.0.7";

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
  program.command("doctor [dir]").description("Diagnose config, DB, embedding, disk and manifest health");
  program.command("demo [dir]").description("Seed sample working context and demo context/lookup");
  program.command("connect [appId]").description("Print connection info for the local memory server");
  program.command("mcp").description("Start MCP stdio server for local clients");
  program.command("serve").description("Start the local memory REST server");
  program.command("status").description("Show memory middleware status");
  program.command("health").description("Show memory service health as JSON");
  const migrate = program.command("migrate")
    .description("Inspect or apply the PostgreSQL schema/canonical-scope cutover")
    .option(
      "--to-schema <schema>",
      "Target schema version",
      `v${POSTGRES_SCHEMA_CUTOVER_TARGET}`,
    )
    .option("--dry-run", "Only inspect migration and scope backfill state", true)
    .option("--apply", "Apply canonical scope backfill and schema contracts")
    .option("--maintenance", "Confirm the runtime is in maintenance mode")
    .option("--quiescence-confirmed", "Confirm all old writers are stopped")
    .option("--confirm <token>", "Exact confirmation token printed by dry-run")
    .option("--allow-quarantine <count>", "Exact existing + planned quarantine count accepted for apply");
  program.command("migrate-semantic-types").description("Dry-run or execute the 5-type legacy backfill funnel");
  program.command("migrate-topic-tree").description("Dry-run or execute the legacy Topic Tree funnel");
  const history = program.command("migrate-history")
    .description("Plan, verify, apply, or roll back the governed history rebuild funnel")
    .option("--prepare-manifest <path>", "Create a frozen secret-free manifest from PostgreSQL")
    .option("--generate-tree-policy <path>", "Generate a deterministic read-only tree policy bundle")
    .option("--audit-report <path>", "Write the tree policy generation audit report")
    .option("--migration-id <id>", "Stable migration identifier for the frozen manifest")
    .option("--max-records <count>", "Maximum frozen source records")
    .option("--max-model-calls <count>", "Maximum model calls")
    .option("--max-input-tokens <count>", "Maximum model input tokens")
    .option("--max-output-tokens <count>", "Maximum model output tokens")
    .option("--max-cost-minor-units <count>", "Maximum model cost in currency minor units")
    .option("--currency <code>", "Currency code for the pinned model budget")
    .option("--pricing-snapshot-version <version>", "Pinned model pricing snapshot")
    .option("--input-cost-per-million-tokens <count>", "Input price per million tokens in currency minor units")
    .option("--output-cost-per-million-tokens <count>", "Output price per million tokens in currency minor units")
    .option("--remote-egress <mode>", "deny or redacted-only")
    .option("--tree-policy-version <version>", "Pinned tree routing policy version")
    .option("--topic-label-version <version>", "Pinned topic label policy version")
    .option("--tree-policy-bundle <path>", "Frozen per-scope tree routing policy bundle")
    .option("--tree-policy-bundle-sha256 <sha256>", "Pinned tree policy bundle byte hash")
    .option("--manifest <path>", "Pinned manifest used by dry-run, verify, apply, or rollback")
    .option("--config <path>", "Resolved Mengshu configuration")
    .option("--plan", "Create the frozen deterministic migration plan without writes")
    .option("--dry-run", "Alias for read-only planning with zero writes")
    .option("--live-model", "Classify only unresolved records with the pinned extraction model")
    .option("--verify", "Verify the frozen migration plan without writes")
    .option("--apply", "Apply through the repository-owned execution port")
    .option("--rollback", "Rollback through the repository-owned execution port")
    .option("--maintenance", "Confirm maintenance mode for a write operation")
    .option("--quiescence-confirmed", "Confirm writers are quiescent")
    .option("--manifest-sha256 <sha256>", "Pin the exact prepared manifest bytes")
    .option("--confirmation-token <token>", "APPLY:<migrationId> or ROLLBACK:<migrationId>")
    .option("--drain-trees", "After apply, drain the fenced tree cohort and run strict verify")
    .option("--tree-worker-id <id>", "Worker identifier used by drain mode")
    .option("--tree-lease-ms <milliseconds>", "Tree worker lease duration", "60000")
    .option("--tree-heartbeat-ms <milliseconds>", "Tree worker heartbeat interval", "20000")
    .option("--tree-poll-ms <milliseconds>", "Tree worker idle polling interval", "100")
    .option("--tree-stall-timeout-ms <milliseconds>", "No-progress window before tree drain fails", "60000")
    .option("--tree-concurrency <count>", "Maximum tree scopes processed concurrently", "4")
    .option("--tree-timeout-ms <milliseconds>", "Maximum tree drain runtime", "21600000");
  const historyWorker = program.command("migrate-history-worker")
    .description("Drain the governed history rebuild tree-job cohort")
    .option("--config <path>", "Resolved Mengshu configuration")
    .option("--migration-id <id>", "Exact completed history migration identifier")
    .option("--manifest-sha256 <sha256>", "Pin the exact prepared manifest bytes")
    .option("--expected-scopes <count>", "Exact completed history scope count")
    .option("--worker-id <id>", "Stable operator worker identifier")
    .option("--lease-ms <milliseconds>", "Per-job lease duration")
    .option("--heartbeat-ms <milliseconds>", "Lease heartbeat interval; must be shorter than lease")
    .option("--poll-ms <milliseconds>", "Idle polling interval")
    .option("--stall-timeout-ms <milliseconds>", "No-progress window before the worker fails")
    .option("--timeout-ms <milliseconds>", "Maximum worker runtime")
    .option("--max-jobs <count>", "Maximum jobs this invocation may process")
    .option("--concurrency <count>", "Maximum scopes processed concurrently")
    .option("--maintenance", "Confirm maintenance mode for this write operation")
    .option("--quiescence-confirmed", "Confirm all normal writers are stopped");
  program.command("migrate-markdown-workset <operation>")
    .description("Export PostgreSQL to migration Markdown, preprocess/govern it, or plan re-import")
    .option("--config <path>", "Resolved Mengshu PostgreSQL configuration")
    .option("--containment-root <path>", "Migration containment root")
    .option("--output <path>", "Fresh output directory")
    .option("--run-id <id>", "Stable migration run identifier")
    .option("--policy-version <version>", "Pinned export/governance policy version")
    .option("--page-size <count>", "PostgreSQL keyset page size")
    .option("--write-concurrency <count>", "Concurrent private Markdown file writes (1-64)")
    .option("--concurrency <count>", "Concurrent preprocessing reads and writes (1-64)")
    .option("--manifest <path>", "Pinned source or governed workset manifest")
    .option("--manifest-sha256 <sha256>", "Pinned exact manifest bytes")
    .option("--prepare", "Prepare an activation-capable import plan after strict verification")
    .option("--source-manifest-sha256 <sha256>", "Pinned original PostgreSQL export manifest")
    .option("--expected-current-snapshot-sha256 <sha256>", "CAS guard for current native rows")
    .option("--idempotency-key <key>", "Stable activation or rollback request key")
    .option("--confirmation-token <token>", "Exact token emitted by plan-import")
    .option("--activation-receipt <path>", "Activation receipt used by rollback-import")
    .option("--maintenance", "Confirm maintenance mode for replacement")
    .option("--quiescence-confirmed", "Confirm all normal writers are stopped");
  program.command("asset").description("Inspect, deprecate, or revoke private governed assets");
  program.command("loadout").description("Inspect, unbind, or pause the current private Agent Loadout");
  program.command("session").description("Explain persisted exact-session context assembly receipts");
  program.command("project").description("Project memory workspace commands");
  program.command("recall <query>").description("Recall memories with optional explanation");
  program.command("forget").description("Forget memories by id or filter");
  program.command("why <memoryId>").description("Explain a memory's provenance and scoring");
  program.command("migrate-home").description("Migrate ~/.openclaw/ to ~/.mengshu/ (dry-run by default)");
  program.command("migrate-openclaw-plugin-id").description("Migrate legacy OpenClaw plugin ids");
  program.command("eval").description("Evaluation tools for OpenClaw history golden set");
  program.command("cost").description("Show the local append-only runtime cost ledger");
  program.command("stats").description("Show memory statistics");
  program.command("search <query>").description("Search memories");
  program.command("scan <directory>").description("Scan a directory of Markdown files into memory");
  program.command("embedding-space").description("Inspect or explicitly activate the embedding space");
  const selectedCommand = program.commands.find((command) => command.name() === argv[2]);
  console.log(selectedCommand?.helpInformation() ?? program.helpInformation());
}

function isMcpCommand(argv: string[]): boolean {
  return argv[2] === "mcp";
}

const SERVER_AUTHORITY_COMMANDS = new Set([
  "mcp", "serve", "status", "migrate", "session",
]);

export function semanticTypeBackfillOperatorArgv(
  argv: readonly string[],
  configPath: string,
): string[] {
  const args = [...argv.slice(3)];
  if (!args.includes("--config")) args.unshift("--config", configPath);
  return args;
}

export const topicTreeMigrationOperatorArgv = semanticTypeBackfillOperatorArgv;
export const historyRebuildOperatorArgv = semanticTypeBackfillOperatorArgv;
export const historyTreeWorkerOperatorArgv = semanticTypeBackfillOperatorArgv;

export function markdownWorksetOperatorArgv(
  argv: readonly string[],
  configPath: string,
): string[] {
  const args = [...argv.slice(3)];
  if (["export", "activate-import", "rollback-import"].includes(args[0] ?? "") &&
      !args.includes("--config")) {
    args.splice(1, 0, "--config", configPath);
  }
  return args;
}

export async function dispatchHistoryRebuildOperator(
  argv: readonly string[],
  configPath: string,
  runner?: (args: readonly string[]) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const run = runner ?? (await import("../../../../scripts/operator-history-rebuild.js"))
    .runHistoryRebuildCli;
  return run(historyRebuildOperatorArgv(argv, configPath));
}

export async function dispatchHistoryTreeWorkerOperator(
  argv: readonly string[],
  configPath: string,
  runner?: (args: readonly string[]) => Promise<unknown>,
): Promise<unknown> {
  const run = runner ?? (await import("../../../../scripts/operator-history-tree-worker.js"))
    .runHistoryTreeWorker;
  return run(historyTreeWorkerOperatorArgv(argv, configPath));
}

const HISTORY_DRAIN_VALUE_FLAGS = new Set([
  "--tree-worker-id", "--tree-lease-ms", "--tree-heartbeat-ms",
  "--tree-poll-ms", "--tree-stall-timeout-ms", "--tree-concurrency", "--tree-timeout-ms",
]);
const HISTORY_SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const HISTORY_SHA256 = /^[0-9a-f]{64}$/;

export interface HistoryRebuildDrainRunners {
  history(args: readonly string[]): Promise<Record<string, unknown>>;
  worker(args: readonly string[]): Promise<unknown>;
}

function requiredHistoryArg(args: readonly string[], name: string): string {
  const indexes = args.flatMap((value, index) => value === name ? [index] : []);
  if (indexes.length !== 1) throw new Error(`history drain requires exactly one ${name}`);
  const value = args[indexes[0]! + 1];
  if (!value || value.startsWith("--")) throw new Error(`history drain requires ${name}`);
  return value;
}

function positiveHistoryResult(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`history drain received invalid apply ${field}`);
  }
  return value;
}

function nonNegativeHistoryResult(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`history drain received invalid apply ${field}`);
  }
  return value;
}

/**
 * Product-level history migration orchestration. All mutation gates are still
 * enforced by the underlying apply and worker operators; this only persists
 * their safe sequencing in one resumable CLI invocation.
 */
export async function dispatchHistoryRebuildAndDrainTrees(
  argv: readonly string[],
  configPath: string,
  runners?: HistoryRebuildDrainRunners,
): Promise<Record<string, unknown>> {
  const operatorArgv = [...argv.slice(0, 3)];
  const drainValues = new Map<string, string>();
  let drain = false;
  for (let index = 3; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--drain-trees") {
      if (drain) throw new Error("history drain flag must be unique");
      drain = true;
      continue;
    }
    if (HISTORY_DRAIN_VALUE_FLAGS.has(token)) {
      const value = argv[index + 1];
      if (drainValues.has(token) || !value || value.startsWith("--")) {
        throw new Error(`history drain requires a single value for ${token}`);
      }
      drainValues.set(token, value);
      index += 1;
      continue;
    }
    operatorArgv.push(token);
  }
  if (!drain || !operatorArgv.includes("--apply") || !operatorArgv.includes("--live-model") ||
      !operatorArgv.includes("--maintenance") ||
      !operatorArgv.includes("--quiescence-confirmed") ||
      ["--plan", "--dry-run", "--verify", "--rollback", "--prepare-manifest"]
        .some((flag) => operatorArgv.includes(flag))) {
    throw new Error("history drain requires model-assisted apply and every write gate");
  }
  const normalizedApplyArgv = historyRebuildOperatorArgv(operatorArgv, configPath);
  const manifestPath = requiredHistoryArg(normalizedApplyArgv, "--manifest");
  const treePolicyBundlePath = requiredHistoryArg(
    normalizedApplyArgv, "--tree-policy-bundle",
  );
  const manifestHash = requiredHistoryArg(normalizedApplyArgv, "--manifest-sha256");
  const confirmation = requiredHistoryArg(normalizedApplyArgv, "--confirmation-token");
  const config = requiredHistoryArg(normalizedApplyArgv, "--config");
  const migrationId = confirmation.startsWith("APPLY:") ? confirmation.slice(6) : "";
  if (!HISTORY_SHA256.test(manifestHash) || !HISTORY_SAFE_ID.test(migrationId)) {
    throw new Error("history drain requires pinned apply identity");
  }
  const history = runners?.history ?? (await import(
    "../../../../scripts/operator-history-rebuild.js"
  )).runHistoryRebuildCli;
  const worker = runners?.worker ?? (await import(
    "../../../../scripts/operator-history-tree-worker.js"
  )).runHistoryTreeWorker;
  const applied = await history(normalizedApplyArgv);
  const scopes = positiveHistoryResult(applied.scopes, "scopes");
  const treeJobs = nonNegativeHistoryResult(applied.treeJobs, "treeJobs");
  if (applied.operation !== "apply" || applied.manifestSha256 !== manifestHash) {
    throw new Error("history drain apply result identity drifted");
  }
  const workerId = drainValues.get("--tree-worker-id") ?? `history-tree-${process.pid}`;
  if (!HISTORY_SAFE_ID.test(workerId)) throw new Error("history drain worker id is invalid");
  const workerResult = treeJobs === 0
    ? Object.freeze({
        skipped: true,
        historyScopes: scopes,
        workerScopes: 0,
        targetJobs: 0,
        completedJobs: 0,
        processedJobs: 0,
        rounds: 0,
      })
    : await worker([
        "--config", config,
        "--migration-id", migrationId,
        "--manifest-sha256", manifestHash,
        "--expected-scopes", String(scopes),
        "--worker-id", workerId,
        "--lease-ms", drainValues.get("--tree-lease-ms") ?? "60000",
        "--heartbeat-ms", drainValues.get("--tree-heartbeat-ms") ?? "20000",
        "--poll-ms", drainValues.get("--tree-poll-ms") ?? "100",
        "--stall-timeout-ms", drainValues.get("--tree-stall-timeout-ms") ?? "60000",
        "--concurrency", drainValues.get("--tree-concurrency") ?? "4",
        "--timeout-ms", drainValues.get("--tree-timeout-ms") ?? "21600000",
        "--max-jobs", String(treeJobs),
        "--maintenance", "--quiescence-confirmed",
      ]);
  const verified = await history([
    "--config", config, "--manifest", manifestPath,
    "--tree-policy-bundle", treePolicyBundlePath, "--verify",
  ]);
  return Object.freeze({
    operation: "apply-drain-verify",
    manifestSha256: manifestHash,
    apply: applied,
    worker: workerResult,
    verify: verified,
  });
}

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

/** Production serve 只暴露 Runtime 已有的统一 Write Kernel 能力。 */
export function resolveRuntimeMemoryWriteCapability(
  runtime: Pick<MengshuRuntime, "executeMemoryWrite">,
): RegisterMemoryServerCliOptions["memoryWrite"] {
  return runtime.executeMemoryWrite
    ? { executeMemoryWrite: runtime.executeMemoryWrite }
    : undefined;
}

/** `ms mcp` production composition：事件写入只暴露 Runtime 的统一 Write Kernel capability。 */
export function createCliMcpStdioServerOptions(
  runtime: MengshuRuntime,
  authorityConfig: McpServerAuthorityConfig,
  projectWorkspaceByProjectId?: Readonly<Record<string, string>>,
): McpStdioServerOptions {
  return {
    service: runtime.memoryService,
    ...(runtime.executeMemoryWrite
      ? { memoryWrite: { executeMemoryWrite: runtime.executeMemoryWrite } }
      : {}),
    forgetCapability: resolveRuntimeForgetCapability(runtime),
    authority: authorityConfig.authority,
    defaultScope: authorityConfig.defaultScope,
    workerOwnership: "external-runtime-host",
    projectWorkspaceByProjectId,
    agentFastPath: runtime.agentFastPath,
    memoryAssets: runtime.memoryViewAssets,
    knowledgeResources: runtime.knowledgeResources,
    temporalMemory: runtime.memoryEvolution,
    sessionWorkingSet: runtime.sessionWorkingSet,
    sessionWorkingSetBridge: runtime.sessionWorkingSetMemoryBridge,
    skillArtifacts: runtime.skillArtifacts,
    ...(runtime.memoryPolicyOverlays && runtime.memoryPolicyResolver
      ? { memoryPolicy: {
          mutations: runtime.memoryPolicyOverlays,
          resolver: runtime.memoryPolicyResolver,
        } }
      : {}),
    ...(runtime.contextAssemblyReceipts
      ? { sessionReceipts: runtime.contextAssemblyReceipts }
      : {}),
    namespaces: ["memories", "knowledge"],
    pipeline: runtime.ingestionPipeline,
    llmClient: runtime.llmClient,
  };
}

export interface MemoryAssetCliCapability extends Pick<
  MemoryViewAssetService,
  "list" | "read" | "changeStatus"
> {}

export function registerMemoryAssetCliCommands(
  program: Command,
  options: {
    readonly capability?: MemoryAssetCliCapability;
    readonly scope: MemoryScope;
  },
): void {
  const asset = program.command("asset")
    .description("Inspect and govern private memory-view assets");
  const capability = (): MemoryAssetCliCapability => {
    if (!options.capability) {
      throw new Error("memory asset capability requires the PostgreSQL v20 overlay");
    }
    return options.capability;
  };
  const positiveVersion = (value: string): number => {
    if (!/^[1-9][0-9]*$/.test(value)) throw new Error("--expected-version must be a positive integer");
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new Error("--expected-version must be a positive integer");
    return parsed;
  };

  asset.command("list")
    .description("List discoverable assets in the exact current scope")
    .action(async () => {
      console.log(JSON.stringify({ assets: await capability().list(options.scope) }, null, 2));
    });

  asset.command("explain <assetId>")
    .description("Explain an asset's current version, source refs, and evidence")
    .action(async (assetId: string) => {
      const result = await capability().read(options.scope, assetId);
      console.log(JSON.stringify({
        ...result.explanation,
        contentValidity: result.contentValidity,
        staleReasons: result.staleReasons,
      }, null, 2));
    });

  for (const targetStatus of ["deprecated", "revoked"] as const) {
    asset.command(`${targetStatus === "deprecated" ? "deprecate" : "revoke"} <assetId>`)
      .description(`${targetStatus === "deprecated" ? "Deprecate" : "Revoke"} an asset by appending a governed version`)
      .requiredOption("--expected-version <n>", "Current latest version for CAS")
      .requiredOption("--idempotency-key <key>", "Stable idempotency key")
      .action(async (assetId: string, commandOptions: {
        expectedVersion: string;
        idempotencyKey: string;
      }) => {
        if (commandOptions.idempotencyKey.trim().length === 0) {
          throw new Error("--idempotency-key must not be empty");
        }
        const result = await capability().changeStatus({
          scope: options.scope,
          assetId,
          expectedLatestVersion: positiveVersion(commandOptions.expectedVersion),
          targetStatus,
          idempotencyKey: commandOptions.idempotencyKey,
        });
        console.log(JSON.stringify(result, null, 2));
      });
  }
}

export interface MemoryLoadoutCliCapability extends Pick<
  AgentLoadoutService,
  "resolveCurrent" | "getLatest" | "unbind" | "pause"
> {}

export function registerMemoryLoadoutCliCommands(
  program: Command,
  options: {
    readonly capability?: MemoryLoadoutCliCapability;
    readonly scope: MemoryScope;
  },
): void {
  const loadout = program.command("loadout")
    .description("Inspect and govern the exact-scope private Agent Loadout");
  const capability = (): MemoryLoadoutCliCapability => {
    if (!options.capability) {
      throw new Error("agent loadout capability requires the PostgreSQL v20 overlay");
    }
    return options.capability;
  };
  const expectedVersion = (value: string): number => {
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new Error("--expected-version must be a positive integer");
    }
    return Number(value);
  };
  const requestKey = (value: string): string => {
    if (value.trim().length === 0) throw new Error("--idempotency-key must not be empty");
    return value;
  };

  loadout.command("current")
    .description("Show the current exact-scope Loadout")
    .action(async () => {
      console.log(JSON.stringify({ loadout: await capability().resolveCurrent(options.scope) }, null, 2));
    });

  loadout.command("explain <loadoutId>")
    .description("Show the latest append-only Loadout version")
    .action(async (loadoutId: string) => {
      console.log(JSON.stringify({ loadout: await capability().getLatest(options.scope, loadoutId) }, null, 2));
    });

  loadout.command("unbind <loadoutId> <assetId>")
    .description("Remove one asset/slot binding by appending a new Loadout version")
    .requiredOption("--slot <semanticType>", "One of profile/task_context/rules/experience/resource")
    .requiredOption("--expected-version <n>", "Current latest version for CAS")
    .requiredOption("--idempotency-key <key>", "Stable idempotency key")
    .action(async (loadoutId: string, assetId: string, commandOptions: {
      slot: string;
      expectedVersion: string;
      idempotencyKey: string;
    }) => {
      const result = await capability().unbind({
        scope: options.scope,
        loadoutId,
        assetId,
        slot: commandOptions.slot as MemorySemanticType,
        expectedLatestVersion: expectedVersion(commandOptions.expectedVersion),
        idempotencyKey: requestKey(commandOptions.idempotencyKey),
      });
      console.log(JSON.stringify(result, null, 2));
    });

  loadout.command("pause <loadoutId>")
    .description("Disable all asset bindings by appending an empty-binding Loadout version")
    .requiredOption("--expected-version <n>", "Current latest version for CAS")
    .requiredOption("--idempotency-key <key>", "Stable idempotency key")
    .action(async (loadoutId: string, commandOptions: {
      expectedVersion: string;
      idempotencyKey: string;
    }) => {
      const result = await capability().pause({
        scope: options.scope,
        loadoutId,
        expectedLatestVersion: expectedVersion(commandOptions.expectedVersion),
        idempotencyKey: requestKey(commandOptions.idempotencyKey),
      });
      console.log(JSON.stringify(result, null, 2));
    });
}

export type MemorySessionCliCapability = Pick<
  ContextAssemblyReceiptRepository,
  "getLatest"
>;

function validSessionId(value: string): boolean {
  return value.length >= 1 && value.length <= 256 && value.normalize("NFKC") === value &&
    !/[\p{White_Space}\p{Cc}\\/]/u.test(value);
}

export function registerMemorySessionCliCommands(
  program: Command,
  options: {
    readonly capability?: MemorySessionCliCapability;
    readonly scope: MemoryScope;
  },
): void {
  const session = program.command("session")
    .description("Inspect persisted exact-session context assembly receipts");
  session.command("explain <sessionId>")
    .description("Show the latest persisted context assembly receipt")
    .action(async (sessionId: string) => {
      if (!options.capability) {
        throw new Error("session receipt capability is unavailable");
      }
      if (!validSessionId(sessionId)) {
        throw new Error("session explain requires a valid sessionId");
      }
      if ((options.scope.visibility ?? "private") !== "private") {
        throw new Error("session explain requires an exact private scope");
      }
      if (options.scope.sessionId !== undefined && options.scope.sessionId !== sessionId) {
        throw new Error("sessionId does not match the exact CLI scope");
      }
      const receipt = await options.capability.getLatest(
        { ...options.scope, visibility: "private", sessionId },
        sessionId,
      );
      if (!receipt) throw new Error("Context assembly receipt not found");
      console.log(JSON.stringify(receipt, null, 2));
    });
}

/** `ms serve` 的唯一 production Host composition；当前 runtime 缺 v2 capability 时明确失败。 */
export function createCliServeRuntimeHost(
  runtime: ServeRuntimeHostSource,
  authority?: AuthorityScope,
) {
  return createServeRuntimeHost(runtime, { authority });
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
  const explicitConfig = process.env.MENGSHU_CONFIG?.trim();
  const configPath = explicitConfig ? expandHome(explicitConfig) : resolveConfigPath();

  if (argv.length === 2) {
    if (!fs.existsSync(configPath)) {
      const result = await runInteractiveSetup();
      if (!result.configWritten) {
        return;
      }
      console.log("\n配置完成，启动 MCP server...\n");
    }

    const { runStandaloneMcpServer } = await import("../../../../scripts/mengshu-mcp.js");
    await runStandaloneMcpServer();
    return;
  }

  const explicitEnv = process.env.MENGSHU_ENV;
  const envPath = explicitEnv ? expandHome(explicitEnv) : resolveEnvPath();
  if (fs.existsSync(envPath)) {
    loadDotEnv(envPath);
  } else if (!explicitEnv && fs.existsSync(LEGACY_ENV_PATH)) {
    loadDotEnv(LEGACY_ENV_PATH);
  }

  // 成本账本是 config/runtime 独立的只读面；查询本身不得启动 provider 或制造新成本事件。
  if (argv[2] === "cost") {
    const costProgram = new Command().name("ms");
    registerRuntimeCostCliCommands(costProgram, { ledger: new JsonlRuntimeCostLedger() });
    await costProgram.parseAsync(argv);
    return;
  }

  // Help/version are pure CLI surfaces. Never parse config, authority, or start runtime.
  if (wantsHelpOrVersion(argv)) {
    printConfiglessHelp(argv);
    return;
  }

  if (argv[2] === "migrate-semantic-types") {
    const { runSemanticTypeBackfillOperator } = await import(
      "../../../../scripts/operator-semantic-type-backfill.js"
    );
    const result = await runSemanticTypeBackfillOperator(
      semanticTypeBackfillOperatorArgv(argv, configPath),
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (argv[2] === "migrate-topic-tree") {
    const { runTopicTreeMigrationOperator } = await import(
      "../../../../scripts/operator-topic-tree-migrate.js"
    );
    const result = await runTopicTreeMigrationOperator(
      topicTreeMigrationOperatorArgv(argv, configPath),
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (argv[2] === "migrate-history") {
    const result = argv.includes("--drain-trees")
      ? await dispatchHistoryRebuildAndDrainTrees(argv, configPath)
      : await dispatchHistoryRebuildOperator(argv, configPath);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (argv[2] === "migrate-history-worker") {
    const result = await dispatchHistoryTreeWorkerOperator(argv, configPath);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (argv[2] === "migrate-markdown-workset") {
    const { runMarkdownWorksetOperatorCli } = await import(
      "../../../../scripts/operator-markdown-workset-cli.js"
    );
    const result = await runMarkdownWorksetOperatorCli(
      markdownWorksetOperatorArgv(argv, configPath),
    );
    console.log(JSON.stringify(result, null, 2));
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

  if (isMcpCommand(argv) && process.env.MENGSHU_MCP_DIRECT_DIAGNOSTIC !== "1") {
    const { runStandaloneMcpServer } = await import("../../../../scripts/mengshu-mcp.js");
    await runStandaloneMcpServer();
    return;
  }

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
      const running = await startMcpStdioServer(
        createCliMcpStdioServerOptions(
          runtime,
          serverAuthority,
          projectWorkspaceBindings(readRegistry()),
        ),
      );
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
    memoryWrite: resolveRuntimeMemoryWriteCapability(runtime),
    memoryEvolution: runtime.memoryEvolution,
    sessionWorkingSet: runtime.sessionWorkingSet,
    sessionWorkingSetMemoryBridge: runtime.sessionWorkingSetMemoryBridge,
    skillArtifacts: runtime.skillArtifacts,
    memoryPolicyOverlays: runtime.memoryPolicyOverlays,
    memoryPolicyResolver: runtime.memoryPolicyResolver,
    runtimeMcp: serverAuthority
      ? createRuntimeMcpFacade(createCliMcpStdioServerOptions(
          runtime,
          serverAuthority,
          projectWorkspaceBindings(readRegistry()),
        ))
      : undefined,
    console: runtime.consoleApi,
    agentFastPath: runtime.agentFastPath,
    defaultScope: runtime.defaultScope,
    serverLogger: {
      error: (message) => console.error(`[mengshu] ${message}`),
    },
    runtimeHostFactory: () => {
      if (!serverAuthority) throw new Error("Server authority configuration is required");
      return createCliServeRuntimeHost(runtime, serverAuthority.authority);
    },
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

  registerMemoryAssetCliCommands(program, {
    capability: runtime.memoryViewAssets,
    scope: defaultScope,
  });

  registerMemoryLoadoutCliCommands(program, {
    capability: runtime.agentLoadouts,
    scope: defaultScope,
  });

  registerMemorySessionCliCommands(program, {
    capability: runtime.contextAssemblyReceipts,
    scope: defaultScope,
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
