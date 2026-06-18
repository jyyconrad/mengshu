import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  MEMORY_CATEGORIES,
  type MemoryCategory,
  type MemoryConfig,
} from "../../config.js";
import {
  createMengshuRuntime,
  toFriendlyMengshuError,
  type MengshuRuntime,
} from "../../runtime.js";
import {
  handleMemoryCleanup,
  handleMemoryForget,
  handleMemoryRecall,
  handleMemoryScanDirectory,
  handleMemoryStore,
} from "./tools.js";
import { handleMemoryContextFast } from "./context-fast.js";
import {
  detectCategory,
  handleAgentEndCapture,
  handleBeforeAgentStartRecall,
  shouldCapture,
} from "./hooks.js";
import { registerMemoryServerCliCommands } from "./cli.js";
import { registerProjectCliCommands } from "./cli-project.js";
import { registerDoctorCliCommands } from "./cli-doctor.js";
import { registerMcpCliCommands } from "./cli-mcp.js";
import { registerMigrateHomeCommand } from "./cli-migrate-home.js";
import { registerMaintainCommands } from "./cli-maintain.js";
import { registerLegacyCliCommands } from "./cli-legacy.js";

export interface RegisterOpenClawAdapterOptions {
  runtime?: MengshuRuntime;
}

export function registerOpenClawAdapter(
  api: OpenClawPluginApi,
  config: MemoryConfig,
  options: RegisterOpenClawAdapterOptions = {},
): MengshuRuntime {
  try {
    const resolvedDbPath = api.resolvePath(config.dbPath!);
    const runtime = options.runtime ?? createMengshuRuntime({
      config,
      resolvedDbPath,
      appId: "openclaw",
      logger: api.logger,
    });

    api.logger.info?.(`mengshu: plugin registered (dbType: ${config.dbType}, lazy init)`);
    registerOpenClawTools(api, runtime);
    registerOpenClawCli(api, runtime);
    registerOpenClawHooks(api, runtime);
    registerOpenClawService(api, runtime);
    return runtime;
  } catch (error) {
    throw toFriendlyMengshuError(error);
  }
}

function registerOpenClawTools(api: OpenClawPluginApi, runtime: MengshuRuntime): void {
  const { config, db, embeddings, memoryService, ingestionPipeline, routingEngine } = runtime;

  api.registerTool(
    {
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
      }),
      async execute(_toolCallId, params) {
        return handleMemoryRecall(params as Parameters<typeof handleMemoryRecall>[0], {
          service: memoryService,
        });
      },
    },
    { name: "memory_recall" },
  );

  api.registerTool(
    {
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
      }),
      async execute(_toolCallId, params) {
        return handleMemoryStore(params as Parameters<typeof handleMemoryStore>[0], {
          service: memoryService,
          embed: (text) => embeddings.embed(text),
          existsByContentHash: (hashes) => db.existsByContentHash(hashes),
          embeddingModel: config.embedding.model,
          routingEngine,
          logger: api.logger,
        });
      },
    },
    { name: "memory_store" },
  );

  api.registerTool(
    {
      name: "memory_forget",
      label: "Memory Forget",
      description: "Delete specific memories. GDPR-compliant.",
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: "Search to find memory" })),
        memoryId: Type.Optional(Type.String({ description: "Specific memory ID" })),
        filter: Type.Optional(Type.Record(Type.String(), Type.Unsafe<unknown>({}), { description: "Filter conditions for bulk delete" })),
      }),
      async execute(_toolCallId, params) {
        return handleMemoryForget(params as Parameters<typeof handleMemoryForget>[0], {
          service: memoryService,
        });
      },
    },
    { name: "memory_forget" },
  );

  api.registerTool(
    {
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
      }),
      async execute(_toolCallId, params) {
        return handleMemoryScanDirectory(
          params as Parameters<typeof handleMemoryScanDirectory>[0],
          {
            pipeline: ingestionPipeline,
            resolvePath: (path) => api.resolvePath(path),
            defaultIgnorePaths: config.scanner?.defaultIgnorePaths,
            defaultIgnoreRules: config.scanner?.customIgnoreRules,
            defaultTargetTable: config.scanner?.targetTable,
            defaultAutoEnrichMetadata: config.scanner?.autoEnrichMetadata,
          },
        );
      },
    },
    { name: "memory_scan_directory" },
  );

  api.registerTool(
    {
      name: "memory_cleanup",
      label: "Memory Cleanup",
      description:
        "Clean up old or unwanted memory data. Supports deleting by data type, age, or metadata filters.",
      parameters: Type.Object({
        dataType: Type.Optional(Type.String({ description: "Data type to delete: 'memory' or 'document'" })),
        olderThanDays: Type.Optional(Type.Number({ description: "Delete entries older than N days" })),
        filter: Type.Optional(Type.Record(Type.String(), Type.Unsafe<unknown>({}), { description: "Additional filter conditions" })),
      }),
      async execute(_toolCallId, params) {
        return handleMemoryCleanup(params as Parameters<typeof handleMemoryCleanup>[0], {
          service: memoryService,
        });
      },
    },
    { name: "memory_cleanup" },
  );

  api.registerTool(
    {
      name: "memory_context_fast",
      label: "Memory Context (Fast)",
      description:
        "Get 5-slot context for agent task: profile, task_context, rules, experience, resource. Fast path optimized for agent startup (P95 < 80ms).",
      parameters: Type.Object({
        task: Type.String({ description: "Current task description" }),
        tokenBudget: Type.Optional(Type.Number({ description: "Total token budget (default: 4000)" })),
        latencyBudgetMs: Type.Optional(Type.Number({ description: "Latency budget in ms (default: 80)" })),
      }),
      async execute(_toolCallId, params) {
        return handleMemoryContextFast(params as Parameters<typeof handleMemoryContextFast>[0], {
          service: memoryService,
          logger: api.logger,
        });
      },
    },
    { name: "memory_context_fast" },
  );
}

function registerOpenClawCli(api: OpenClawPluginApi, runtime: MengshuRuntime): void {
  api.registerCli(
    ({ program }) => {
      const memory = program.command("ms").description("Memory plugin commands");
      registerMemoryServerCliCommands(memory, {
        config: runtime.config,
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
      registerProjectCliCommands(memory, {
        service: runtime.memoryService,
        getRecordCount: () => runtime.db.count(),
      });
      registerMigrateHomeCommand(memory);
      registerDoctorCliCommands(memory, {
        config: runtime.config,
        service: runtime.memoryService,
        embeddings: runtime.embeddings,
      });
      registerMcpCliCommands(memory, {
        service: runtime.memoryService,
        agentFastPath: runtime.agentFastPath,
        namespaces: ["memories", "knowledge"],
      });
      registerMaintainCommands(memory, {
        centralityCalculator: runtime.centralityCalculator,
        getDefaultScope: () => ({
          tenantId: "default",
          appId: "openclaw",
          userId: "default",
          projectId: "default",
          agentId: "default",
          namespace: "default",
        }),
      });
      registerLegacyCliCommands(memory, {
        config: runtime.config,
        db: runtime.db,
        embeddings: runtime.embeddings,
        ingestionPipeline: runtime.ingestionPipeline,
        routingEngine: runtime.routingEngine,
        resolvedDbPath: runtime.resolvedDbPath,
        resolvePath: (path) => api.resolvePath(path),
      });
    },
    { commands: ["ms"] },
  );
}

function registerOpenClawHooks(api: OpenClawPluginApi, runtime: MengshuRuntime): void {
  if (runtime.config.autoRecall) {
    api.on("before_agent_start", async (event) => {
      return handleBeforeAgentStartRecall(event, {
        service: runtime.memoryService,
        recallIncludeDocuments: runtime.config.recallIncludeDocuments,
        logger: api.logger,
      });
    });
  }

  if (runtime.config.autoCapture) {
    api.on("agent_end", async (event) => {
      return handleAgentEndCapture(event, {
        service: runtime.memoryService,
        embedBatch: (texts) => runtime.embeddings.embedBatch(texts),
        existsByContentHash: (hashes) => runtime.db.existsByContentHash(hashes),
        shouldCapture,
        detectCategory,
        captureMaxChars: runtime.config.captureMaxChars,
        embeddingModel: runtime.config.embedding.model,
        logger: api.logger,
      });
    });
  }
}

function registerOpenClawService(api: OpenClawPluginApi, runtime: MengshuRuntime): void {
  api.registerService({
    id: "mengshu",
    start: async () => {
      await runtime.start();
      api.logger.info?.(
        `mengshu: initialized (dbType: ${runtime.config.dbType}, model: ${runtime.config.embedding.model})`,
      );
    },
    stop: async () => {
      await runtime.stop();
      api.logger.info?.("mengshu: stopped");
    },
  });
}
