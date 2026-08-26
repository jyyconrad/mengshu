import { Type } from "@sinclair/typebox";
import { isAbsolute } from "node:path";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  MEMORY_CATEGORIES,
  type MemoryCategory,
  type MemoryConfig,
  vectorDimsForModel,
} from "../../../config.js";
import { expandHome } from "../../../core/paths.js";
import {
  createMengshuRuntime,
  toFriendlyMengshuError,
  type MengshuRuntime,
} from "../../../runtime.js";
import {
  handleMemoryCleanup,
  handleMemoryForget,
  handleMemoryRecall,
  handleMemoryScanDirectory,
  handleMemoryStore,
  bindOpenClawPipelineAuthority,
  resolveOpenClawAllowedTables,
  type OpenClawAuthorityContext,
} from "./tools.js";
import { handleMemoryContextFast } from "./context-fast.js";
import {
  createOpenClawRecallTurnGuard,
  detectCategory,
  handleAgentEndCapture,
  handleBeforeAgentStartRecall,
  shouldCapture,
} from "./hooks.js";
import {
  registerMemoryServerCliCommands,
  type RegisterMemoryServerCliOptions,
} from "./cli/index.js";
import { registerProjectCliCommands } from "./cli/project.js";
import { registerDoctorCliCommands } from "./cli/doctor.js";
import { registerMcpCliCommands } from "./cli/mcp.js";
import { registerMigrateHomeCommand } from "./cli/migrate-home.js";
import { registerMaintainCommands } from "./cli/maintain.js";
import { registerLegacyCliCommands } from "./cli/legacy.js";
import {
  OPENCLAW_LEGACY_MEMORY_PLUGIN_IDS,
  OPENCLAW_MEMORY_PLUGIN_ID,
} from "./plugin-id.js";
import { describeOpenClawEmbeddingStatus } from "./embedding-status.js";
import type { AuthorityScope } from "../../../packages/core/src/domain/authority-scope.js";
import type {
  AuthorityScopedForgetService,
  MemoryService,
} from "../../../core/service-types.js";
import type { MemoryScope } from "../../../core/types.js";
import {
  snapshotOpenClawAuthority,
  resolveOpenClawAuthorityScope,
  resolveOpenClawHostScope,
} from "./authority.js";
import { createServeRuntimeHost } from "../../../server/runtime-host-factory.js";
import { PostgresProvider } from "../../../packages/core/src/db/providers/postgres.js";
import { readRegistry } from "../../../packages/core/src/runtime/registry.js";
import { createPostgresSchemaCutoverPort } from "./cli/migrate-v10.js";
import { runtimeMemoryWriteCapability } from "./memory-write.js";

export {
  OPENCLAW_LEGACY_MEMORY_PLUGIN_IDS,
  OPENCLAW_MEMORY_PLUGIN_ID,
} from "./plugin-id.js";

export interface RegisterOpenClawAdapterOptions {
  runtime?: MengshuRuntime;
  /** Canonical plugin entry supplies the exact operator-selected runtime scope. */
  defaultScope?: MemoryScope;
  /** Authenticated server authority. Required for every production composition. */
  authority?: AuthorityScope;
  /** Test/composition seam；production 默认仍使用 daemon startMemoryServer。 */
  startServer?: RegisterMemoryServerCliOptions["startServer"];
}

interface OpenClawToolHostContext {
  agentId?: string;
  sessionKey?: string;
}

function createAuthorityScopedOpenClawTool(
  authority: AuthorityScope,
  defaultScope: MemoryScope,
  build: (context: OpenClawAuthorityContext) => AnyAgentTool,
): Parameters<OpenClawPluginApi["registerTool"]>[0] {
  return ((hostContext: OpenClawToolHostContext) => {
    const boundary = resolveOpenClawHostScope(authority, defaultScope, hostContext);
    return build({
      authority: boundary.authority,
      defaultScope: boundary.scope,
    });
  }) as Parameters<OpenClawPluginApi["registerTool"]>[0];
}

type OpenClawMemoryPromptSectionBuilder = (params: {
  availableTools: Set<string>;
  citationsMode?: string;
}) => string[];

type OpenClawMemoryFlushPlanResolver = (params: {
  cfg?: unknown;
  nowMs?: number;
}) => null;

type OpenClawMemoryRuntime = {
  getMemorySearchManager(params: {
    cfg: unknown;
    agentId: string;
    purpose?: "default" | "status";
  }): Promise<{
    manager: ReturnType<typeof createOpenClawMemorySearchManager> | null;
    error?: string;
  }>;
  resolveMemoryBackendConfig(params: { cfg: unknown; agentId: string }): { backend: "builtin" };
  closeAllMemorySearchManagers?(): Promise<void>;
};

type OpenClawMemoryPluginApi = OpenClawPluginApi & {
  registerMemoryPromptSection?: (builder: OpenClawMemoryPromptSectionBuilder) => void;
  registerMemoryFlushPlan?: (resolver: OpenClawMemoryFlushPlanResolver) => void;
  registerMemoryRuntime?: (runtime: OpenClawMemoryRuntime) => void;
};

export function resolveOpenClawDbPath(
  dbPath: string,
  resolvePath: (path: string) => string,
): string {
  const expanded = expandHome(dbPath);
  return isAbsolute(expanded) ? expanded : resolvePath(expanded);
}

export function registerOpenClawAdapter(
  api: OpenClawPluginApi,
  config: MemoryConfig,
  options: RegisterOpenClawAdapterOptions = {},
): MengshuRuntime {
  try {
    if (!options.authority) {
      throw new Error(
        "OpenClaw authenticated AuthorityScope is required before runtime or host surface registration",
      );
    }
    const authority = snapshotOpenClawAuthority(options.authority);
    const resolvedDbPath = config.dbType === "postgres"
      ? ""
      : resolveOpenClawDbPath(config.dbPath ?? "~/.mengshu/memory/lancedb", (path) => api.resolvePath(path));
    const runtime = options.runtime ?? createMengshuRuntime({
      config,
      resolvedDbPath,
      appId: "openclaw",
      ...(options.defaultScope === undefined ? {} : { defaultScope: options.defaultScope }),
      logger: api.logger,
    });
    // Validate identity alignment and every allowlist before registering any host surface.
    resolveOpenClawAuthorityScope(authority, runtime.defaultScope);
    bindOpenClawPipelineAuthority(runtime.ingestionPipeline, authority, runtime.defaultScope);
    const forgetService = transactionalForgetCapability(runtime);
    const memoryWrite = runtimeMemoryWriteCapability(runtime);
    if (!forgetService) {
      api.logger.warn?.(
        "mengshu: transactional forget capability unavailable; memory_forget, memory_cleanup and ms mcp are disabled",
      );
    }

    registerOpenClawTools(api, runtime, authority, forgetService, memoryWrite);
    registerOpenClawCli(api, runtime, authority, forgetService, options.startServer);
    registerOpenClawHooks(api, runtime, authority, memoryWrite);
    registerOpenClawService(api, runtime, authority);
    registerOpenClawMemoryRuntime(api, runtime);
    return runtime;
  } catch (error) {
    throw toFriendlyMengshuError(error);
  }
}

function registerOpenClawTools(
  api: OpenClawPluginApi,
  runtime: MengshuRuntime,
  authority: AuthorityScope,
  forgetService: MemoryServiceWithForget | undefined,
  memoryWrite: ReturnType<typeof runtimeMemoryWriteCapability>,
): void {
  const { config, memoryService, ingestionPipeline, routingEngine } = runtime;
  const allowedTables = resolveOpenClawAllowedTables(config.knowledgeBases);

  api.registerTool(
    createAuthorityScopedOpenClawTool(authority, runtime.defaultScope, (hostAuthority) => ({
      name: "memory_recall",
      label: "Memory Recall",
      description:
        "Search through long-term memories. Use when you need context about user preferences, past decisions, or previously discussed topics.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query" }),
        limit: Type.Optional(Type.Number({ description: "Max results (default: 5)" })),
        minScore: Type.Optional(Type.Number({ description: "Minimum similarity score 0-1 (default: 0.1)" })),
        includeDocuments: Type.Optional(Type.Boolean({ description: "Include scanned document data (default: false)" })),
        filter: Type.Optional(Type.Record(Type.String(), Type.Unsafe<unknown>({}), { description: "Metadata filter conditions" })),
        category: Type.Optional(Type.String({ description: "Storage category: 核心记忆，用户偏好，事实，决策，定时任务，长期规划，知识库，etc." })),
        searchAll: Type.Optional(Type.Boolean({ description: "Search across all categories (default: false)" })),
        knowledgeBase: Type.Optional(Type.String({ description: "Specific knowledge base to search: knowledge_personal, knowledge_work, etc." })),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params) {
        return handleMemoryRecall(params as Parameters<typeof handleMemoryRecall>[0], {
          ...hostAuthority,
          allowedTables,
          service: memoryService,
        });
      },
    })),
    { name: "memory_recall" },
  );

  api.registerTool(
    createAuthorityScopedOpenClawTool(authority, runtime.defaultScope, (hostAuthority) => ({
      name: "memory_store",
      label: "Memory Store",
      description:
        "Save important information in long-term memory. Supports categories: 核心记忆，用户偏好，事实，决策，定时任务，长期规划，知识库，etc.",
      parameters: Type.Object({
        text: Type.String({ description: "Information to remember" }),
        importance: Type.Optional(Type.Number({ description: "Importance 0-1 (default: 0.7)" })),
        category: Type.Optional(
          Type.Unsafe<MemoryCategory>({
            type: "string",
            enum: [...MEMORY_CATEGORIES],
          }),
        ),
        metadata: Type.Optional(Type.Record(Type.String(), Type.Unsafe<unknown>({}), { description: "Custom metadata" })),
        storageCategory: Type.Optional(Type.String({ description: "Storage category: 核心记忆 | 用户偏好 | 事实 | 决策 | 定时任务 | 长期规划 | 知识库 (default: 核心记忆)" })),
      }, { additionalProperties: false }),
      async execute(toolCallId, params) {
        return handleMemoryStore({
          ...(params as Parameters<typeof handleMemoryStore>[0]),
          idempotencyKey: toolCallId,
        }, {
          ...hostAuthority,
          allowedTables,
          service: memoryService,
          memoryWrite,
          embeddingModel: config.embedding.model,
          routingEngine,
          logger: api.logger,
        });
      },
    })),
    { name: "memory_store" },
  );

  if (forgetService) {
    api.registerTool(
      createAuthorityScopedOpenClawTool(authority, runtime.defaultScope, (hostAuthority) => ({
        name: "memory_forget",
        label: "Memory Forget",
        description: "Delete specific memories. GDPR-compliant.",
        parameters: Type.Object({
          query: Type.Optional(Type.String({ description: "Search to find memory" })),
          memoryId: Type.Optional(Type.String({ description: "Specific memory ID" })),
          filter: Type.Optional(Type.Record(Type.String(), Type.Unsafe<unknown>({}), { description: "Filter conditions for bulk delete" })),
        }, { additionalProperties: false }),
        async execute(_toolCallId, params) {
          return handleMemoryForget(params as Parameters<typeof handleMemoryForget>[0], {
            ...hostAuthority,
            allowedTables,
            service: memoryService,
            forgetService,
          });
        },
      })),
      { name: "memory_forget" },
    );
  }

  api.registerTool(
    createAuthorityScopedOpenClawTool(authority, runtime.defaultScope, (hostAuthority) => ({
      name: "memory_scan_directory",
      label: "Memory Scan Directory",
      description:
        "Scan a directory of Markdown files and add them to memory. Automatically handles duplicates and slices large files.",
      parameters: Type.Object({
        directory: Type.String({ description: "Directory path to scan" }),
        ignorePaths: Type.Optional(Type.Array(Type.String(), { description: "Additional paths to ignore" })),
        ignoreRules: Type.Optional(Type.Array(Type.String(), { description: "Additional gitignore-style rules" })),
        targetTable: Type.Optional(Type.String({ description: "Target table name (default: knowledge)" })),
        autoEnrichMetadata: Type.Optional(Type.Boolean({ description: "Auto-enrich metadata (default: true)" })),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params) {
        return handleMemoryScanDirectory(
          params as Parameters<typeof handleMemoryScanDirectory>[0],
          {
            ...hostAuthority,
            allowedTables,
            pipeline: ingestionPipeline,
            resolvePath: (path) => api.resolvePath(path),
            defaultIgnorePaths: config.scanner?.defaultIgnorePaths,
            defaultIgnoreRules: config.scanner?.customIgnoreRules,
            defaultTargetTable: config.scanner?.targetTable,
            defaultAutoEnrichMetadata: config.scanner?.autoEnrichMetadata,
          },
        );
      },
    })),
    { name: "memory_scan_directory" },
  );

  if (forgetService) {
    api.registerTool(
      createAuthorityScopedOpenClawTool(authority, runtime.defaultScope, (hostAuthority) => ({
        name: "memory_cleanup",
        label: "Memory Cleanup",
        description:
          "Clean up old or unwanted memory data. Supports deleting by data type, age, or metadata filters.",
        parameters: Type.Object({
          dataType: Type.Optional(Type.String({ description: "Data type to delete: 'memory' or 'document'" })),
          olderThanDays: Type.Optional(Type.Number({ description: "Delete entries older than N days" })),
          filter: Type.Optional(Type.Record(Type.String(), Type.Unsafe<unknown>({}), { description: "Additional filter conditions" })),
        }, { additionalProperties: false }),
        async execute(_toolCallId, params) {
          return handleMemoryCleanup(params as Parameters<typeof handleMemoryCleanup>[0], {
            ...hostAuthority,
            allowedTables,
            service: memoryService,
            forgetService,
          });
        },
      })),
      { name: "memory_cleanup" },
    );
  }

  api.registerTool(
    createAuthorityScopedOpenClawTool(authority, runtime.defaultScope, (hostAuthority) => ({
      name: "memory_context_fast",
      label: "Memory Context (Fast)",
      description:
        "Get 5-slot context for agent task: profile, task_context, rules, experience, resource. Fast path optimized for agent startup (P95 < 80ms).",
      parameters: Type.Object({
        task: Type.String({ description: "Current task description" }),
        tokenBudget: Type.Optional(Type.Number({ description: "Total token budget (default: 4000)" })),
        latencyBudgetMs: Type.Optional(Type.Number({ description: "Latency budget in ms (default: 80)" })),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params) {
        const scope = resolveOpenClawAuthorityScope(
          hostAuthority.authority!,
          hostAuthority.defaultScope!,
          params,
        );
        return handleMemoryContextFast({
          ...(params as Parameters<typeof handleMemoryContextFast>[0]),
          scope,
        }, {
          agentFastPath: runtime.agentFastPath,
          defaultScope: scope,
          logger: api.logger,
        });
      },
    })),
    { name: "memory_context_fast" },
  );
}

type MemoryServiceWithForget = MemoryService & AuthorityScopedForgetService;

function transactionalForgetCapability(
  runtime: MengshuRuntime,
): MemoryServiceWithForget | undefined {
  if (runtime.config.dbType !== "postgres") return undefined;
  const provider = runtime.db as unknown as {
    createForgetTransactionPort?: () => { transaction?: unknown } | undefined;
  };
  const service = runtime.memoryService as MemoryServiceWithForget;
  if (typeof provider.createForgetTransactionPort !== "function" || typeof service.forget !== "function") {
    return undefined;
  }
  try {
    const port = provider.createForgetTransactionPort();
    if (!port || typeof port.transaction !== "function") return undefined;
  } catch {
    return undefined;
  }
  return service;
}

function registerOpenClawCli(
  api: OpenClawPluginApi,
  runtime: MengshuRuntime,
  authority: AuthorityScope,
  forgetService: MemoryServiceWithForget | undefined,
  startServer: RegisterMemoryServerCliOptions["startServer"],
): void {
  resolveOpenClawAuthorityScope(authority, runtime.defaultScope);
  api.registerCli(
    ({ program }) => {
      const memory = program.command("ms").description("Memory plugin commands");
      registerMemoryServerCliCommands(memory, {
        authority,
        defaultScope: runtime.defaultScope,
        config: runtime.config,
        service: runtime.memoryService,
        startServer,
        console: runtime.consoleApi,
        agentFastPath: runtime.agentFastPath,
        runtimeHostFactory: () => createServeRuntimeHost(runtime, { authority }),
        getTableStats: runtime.db.getTableStats ? () => runtime.db.getTableStats!() : undefined,
        schemaCutover: runtime.db instanceof PostgresProvider
          ? {
              port: createPostgresSchemaCutoverPort(runtime.db),
              getRegistry: () => readRegistry(),
            }
          : undefined,
      });
      registerProjectCliCommands(memory, {
        authority,
        defaultScope: runtime.defaultScope,
        service: runtime.memoryService,
      });
      registerMigrateHomeCommand(memory);
      registerDoctorCliCommands(memory, {
        authority,
        defaultScope: runtime.defaultScope,
        config: runtime.config,
        service: runtime.memoryService,
        embeddings: runtime.embeddings,
        embeddingStatus: () => probeCliEmbeddingStatus(runtime),
      });
      registerMcpCliCommands(memory, {
        authority,
        defaultScope: runtime.defaultScope,
        service: runtime.memoryService,
        forgetService,
        agentFastPath: runtime.agentFastPath,
        namespaces: ["memories", "knowledge"],
      });
      registerMaintainCommands(memory, {
        authority,
        defaultScope: runtime.defaultScope,
        centralityCalculator: runtime.centralityCalculator,
      });
      registerLegacyCliCommands(memory, {
        authority,
        defaultScope: runtime.defaultScope,
        config: runtime.config,
        ingestionPipeline: runtime.ingestionPipeline,
        routingEngine: runtime.routingEngine,
        resolvePath: (path) => api.resolvePath(path),
      });
    },
    { commands: ["ms"] },
  );
}

async function probeCliEmbeddingStatus(runtime: MengshuRuntime) {
  const initialState = runtime.lifecycle.snapshot().state;
  const ownsLifecycle = initialState === "created";
  if (initialState === "created" || initialState === "starting") {
    await runtime.start();
  } else if (initialState !== "ready" && initialState !== "degraded") {
    throw new Error("OpenClaw CLI embedding probe runtime is not available");
  }
  try {
    return describeOpenClawEmbeddingStatus(
      runtime.config.dbType,
      runtime.embeddingWriteGuard.snapshot(),
      runtime.embeddingReadGuard.snapshot(),
      runtime.lifecycle.snapshot(),
    );
  } finally {
    // `openclaw ms doctor` runs in a short-lived CLI process where OpenClaw does
    // not start plugin services. Only release a lifecycle that this probe owned.
    if (ownsLifecycle) await runtime.stop();
  }
}

type OpenClawRecallHook = "before_prompt_build" | "before_agent_start";

function parseOpenClawVersion(version: unknown): readonly [number, number, number] | undefined {
  if (typeof version !== "string") return undefined;
  const match = /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/.exec(version);
  if (!match) return undefined;
  const parsed = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  if (parsed.some((part) => !Number.isSafeInteger(part)) ||
      parsed[1] < 1 || parsed[1] > 12 || parsed[2] < 1 || parsed[2] > 31) {
    return undefined;
  }
  return parsed;
}

function compareOpenClawVersion(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

function resolveOpenClawRecallHook(version: unknown): OpenClawRecallHook | undefined {
  const parsed = parseOpenClawVersion(version);
  if (!parsed) return undefined;
  if (compareOpenClawVersion(parsed, [2026, 2, 25]) >= 0) return "before_prompt_build";
  if (compareOpenClawVersion(parsed, [2026, 2, 21]) >= 0 &&
      compareOpenClawVersion(parsed, [2026, 2, 24]) <= 0) return "before_agent_start";
  return undefined;
}

function registerOpenClawHooks(
  api: OpenClawPluginApi,
  runtime: MengshuRuntime,
  authority: AuthorityScope,
  memoryWrite: ReturnType<typeof runtimeMemoryWriteCapability>,
): void {
  const authorityContext = { authority, defaultScope: runtime.defaultScope };
  const turnGuard = createOpenClawRecallTurnGuard();
  let recallGuardActive = false;
  if (runtime.config.autoRecall) {
    const recallHook = resolveOpenClawRecallHook(api.runtime?.version);
    if (recallHook === "before_prompt_build") {
      recallGuardActive = true;
      api.on("before_prompt_build", async (event, hostContext) => {
        return handleBeforeAgentStartRecall(event, {
          ...authorityContext,
          agentFastPath: runtime.agentFastPath,
          hostContext,
          turnGuard,
          recallIncludeDocuments: runtime.config.recallIncludeDocuments,
          logger: api.logger,
        });
      });
    } else if (recallHook === "before_agent_start") {
      recallGuardActive = true;
      api.on("before_agent_start", async (event, hostContext) => {
        return handleBeforeAgentStartRecall(event, {
          ...authorityContext,
          agentFastPath: runtime.agentFastPath,
          hostContext,
          turnGuard,
          recallIncludeDocuments: runtime.config.recallIncludeDocuments,
          logger: api.logger,
        });
      });
    } else {
      api.logger.warn(
        "mengshu: automatic recall disabled [UNSUPPORTED_OPENCLAW_HOOK_VERSION]",
      );
    }
  }

  if (runtime.config.autoCapture || recallGuardActive) {
    api.on("agent_end", async (event, hostContext) => {
      try {
        if (!runtime.config.autoCapture) return;
        return await handleAgentEndCapture(event, {
          ...authorityContext,
          service: runtime.memoryService,
          memoryWrite,
          hostContext,
          shouldCapture,
          detectCategory,
          captureMaxChars: runtime.config.captureMaxChars,
          embeddingModel: runtime.config.embedding.model,
          logger: api.logger,
        });
      } finally {
        turnGuard.clear(hostContext);
      }
    });
  }
}

function registerOpenClawService(
  api: OpenClawPluginApi,
  runtime: MengshuRuntime,
  authority: AuthorityScope,
): void {
  const serviceHost = runtime.config.dbType === "postgres" && runtime.db instanceof PostgresProvider
    ? createServeRuntimeHost(runtime, { authority })
    : runtime;
  api.registerService({
    id: OPENCLAW_MEMORY_PLUGIN_ID,
    start: async () => {
      await serviceHost.start();
      const embeddingStatus = describeOpenClawEmbeddingStatus(
        runtime.config.dbType,
        runtime.embeddingWriteGuard.snapshot(),
        runtime.embeddingReadGuard.snapshot(),
        runtime.lifecycle.snapshot(),
      );
      const detail =
        `dbType=${runtime.config.dbType}, status=${embeddingStatus.status}, ` +
        `writeMode=${embeddingStatus.writeMode}, ` +
        `embeddingReadMode=${embeddingStatus.embeddingReadMode}, ` +
        `lifecycleState=${embeddingStatus.lifecycleState}, ` +
        `lifecycleReady=${embeddingStatus.lifecycleReady}`;
      if (embeddingStatus.lifecycleState === "degraded") {
        api.logger.warn?.(
          `${OPENCLAW_MEMORY_PLUGIN_ID}: initialized degraded/read-only (${detail})`,
        );
      } else if (embeddingStatus.writeMode === "read-only") {
        api.logger.warn?.(`${OPENCLAW_MEMORY_PLUGIN_ID}: initialized read-only (${detail})`);
      } else {
        api.logger.info?.(`${OPENCLAW_MEMORY_PLUGIN_ID}: initialized (${detail})`);
      }
    },
    stop: async () => {
      await serviceHost.stop();
      api.logger.info?.(`${OPENCLAW_MEMORY_PLUGIN_ID}: stopped`);
    },
  });
}

function registerOpenClawMemoryRuntime(api: OpenClawPluginApi, runtime: MengshuRuntime): void {
  const memoryApi = api as OpenClawMemoryPluginApi;
  if (typeof memoryApi.registerMemoryPromptSection === "function") {
    memoryApi.registerMemoryPromptSection(({ availableTools }) => {
      const hasMengshuTool =
        availableTools.has("memory_recall") ||
        availableTools.has("memory_store") ||
        availableTools.has("memory_context_fast");
      if (!hasMengshuTool) {
        return [];
      }
      return [
        "## Mengshu Memory",
        "Use the memory_recall or memory_context_fast tools to retrieve durable user preferences, project decisions, and reusable working context before acting.",
        "Use memory_store only for stable, verified facts or preferences that should persist across OpenClaw, Codex, and other agents sharing ~/.mengshu.",
        "",
      ];
    });
  }

  if (typeof memoryApi.registerMemoryFlushPlan === "function") {
    memoryApi.registerMemoryFlushPlan(() => null);
  }

  if (typeof memoryApi.registerMemoryRuntime === "function") {
    memoryApi.registerMemoryRuntime({
      async getMemorySearchManager() {
        return {
          manager: createOpenClawMemorySearchManager(runtime),
        };
      },
      resolveMemoryBackendConfig() {
        return { backend: "builtin" };
      },
      async closeAllMemorySearchManagers() {
        await runtime.stop();
      },
    });
  }
}

function createOpenClawMemorySearchManager(runtime: MengshuRuntime) {
  const postgres = runtime.config.postgres;
  const datastore = runtime.config.dbType === "postgres" && postgres
    ? `${postgres.user}@${postgres.host}:${postgres.port}/${postgres.database}`
    : runtime.resolvedDbPath;

  return {
    status() {
      const model = runtime.config.embedding.model;
      const embeddingStatus = describeOpenClawEmbeddingStatus(
        runtime.config.dbType,
        runtime.embeddingWriteGuard.snapshot(),
        runtime.embeddingReadGuard.snapshot(),
        runtime.lifecycle.snapshot(),
      );
      let dims: number | undefined;
      try {
        dims = model ? vectorDimsForModel(model) : undefined;
      } catch {
        dims = undefined;
      }
      return {
        backend: "builtin" as const,
        provider: "mengshu",
        model,
        dirty: false,
        dbPath: runtime.config.dbType === "lancedb" ? runtime.resolvedDbPath : undefined,
        sources: ["memory" as const],
        vector: {
          enabled: true,
          dims,
        },
        custom: {
          pluginId: OPENCLAW_MEMORY_PLUGIN_ID,
          home: "~/.mengshu",
          dbType: runtime.config.dbType,
          datastore,
          sharedAcrossAgents: true,
          embeddingRegistryStatus: embeddingStatus.status,
          embeddingWriteMode: embeddingStatus.writeMode,
          embeddingReadMode: embeddingStatus.embeddingReadMode,
          lifecycleState: embeddingStatus.lifecycleState,
          lifecycleReady: embeddingStatus.lifecycleReady,
        },
      };
    },
    async probeEmbeddingAvailability() {
      try {
        await runtime.embeddings.embed("mengshu memory health check");
        return { ok: true };
      } catch {
        return {
          ok: false,
          error: "embedding probe failed",
        };
      }
    },
    async probeVectorAvailability() {
      const health = await runtime.memoryService.health();
      return health.ok && runtime.embeddingReadGuard.snapshot().allowed;
    },
    async sync() {
      await runtime.start();
    },
    async close() {
      // Runtime lifecycle is owned by the registered OpenClaw service.
    },
  };
}
