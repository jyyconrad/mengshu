/**
 * OpenClaw Memory Plugin
 *
 * Long-term memory with vector search for AI conversations.
 * Supports LanceDB (local) and Supabase (cloud) storage.
 * Provides seamless auto-recall, auto-capture, and directory scanning capabilities.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  DEFAULT_CAPTURE_MAX_CHARS,
  MEMORY_CATEGORIES,
  type MemoryCategory,
  memoryConfigSchema,
  vectorDimsForModel,
} from "./config.js";
import { DatabaseFactory } from "./db/factory.js";
import type { DatabaseProvider, MemoryEntry, TableName } from "./db/types.js";
import { Embeddings } from "./processing/embeddings.js";
import { computeContentHash } from "./processing/hash-utils.js";
import { createRoutingEngine } from "./routing/index.js";
import {
  formatRelevantMemoriesContext,
  looksLikePromptInjection,
} from "./retrieval/prompt-safety.js";
import { DefaultMemoryService } from "./core/memory-service.js";
import { LegacyDatabaseAdapter } from "./storage/legacy-database-adapter.js";
import { InMemoryMemoryStore } from "./storage/repositories/in-memory.js";
import { IngestionPipeline } from "./ingest/pipeline.js";
import {
  handleMemoryCleanup,
  handleMemoryForget,
  handleMemoryRecall,
  handleMemoryScanDirectory,
  handleMemoryStore,
  resolveCategoryName,
  resolveTableName,
} from "./adapters/openclaw/tools.js";
import { handleMemoryContextFast } from "./adapters/openclaw/context-fast.js";
import {
  handleAgentEndCapture,
  handleBeforeAgentStartRecall,
} from "./adapters/openclaw/hooks.js";
import { registerMemoryServerCliCommands } from "./adapters/openclaw/cli.js";
import { registerProjectCliCommands } from "./adapters/openclaw/cli-project.js";
import { registerDoctorCliCommands } from "./adapters/openclaw/cli-doctor.js";
import { registerMcpCliCommands } from "./adapters/openclaw/cli-mcp.js";
import { registerMigrateHomeCommand } from "./adapters/openclaw/cli-migrate-home.js";
import { registerMaintainCommands } from "./adapters/openclaw/cli-maintain.js";
import { createConsoleApi } from "./console/api.js";
import { InMemoryCandidateRepository } from "./lifecycle/candidate-repository.js";
import { CandidateReviewService } from "./lifecycle/candidate-review.js";
import { candidateToMemoryRecord } from "./lifecycle/candidate-promotion.js";
import { createExtractCandidateHandler } from "./lifecycle/extract-candidate-handler.js";
import { defaultTypeExtractor } from "./lifecycle/type-extractor.js";
import { AgentFastPathService } from "./api/agent-fast-path.js";
import { enqueueUniqueJob } from "./ingest/jobs.js";
import { extractRecords } from "./adapters/openclaw/agent-service-helper.js";
import { InMemoryTreeRepository } from "./tree/buffer.js";
import { createBuildTreeHandler } from "./tree/build-tree-handler.js";
import { createLlmClient } from "./processing/llm-client.js";
import { InMemoryGraphRepository } from "./graph/repository.js";
import { createExtractGraphHandler } from "./graph/extract-graph-handler.js";
import { QueryHitsTracker } from "./graph/query-hits-tracker.js";
import { CentralityCalculator } from "./graph/centrality-calculator.js";

export {
  escapeMemoryForPrompt,
  formatContextBlock,
  formatRelevantMemoriesContext,
  looksLikePromptInjection,
} from "./retrieval/prompt-safety.js";

// ============================================================================
// Security and Helper Functions
// ============================================================================

/**
 * 验证 embedding 配置完整性
 * 在初始化 Embeddings 实例前进行早期验证，提供友好的错误提示
 */
function validateEmbeddingConfig(config: { apiKey: string; baseURL?: string; model?: string }): void {
  if (!config.apiKey || config.apiKey.trim().length === 0) {
    throw new Error(
      `[Mengshu 配置错误] embedding.apiKey 未设置\n\n` +
      `请在 openclaw.plugin.json 中配置 Embedding API Key：\n` +
      `{\n` +
      `  "embedding": {\n` +
      `    "apiKey": "\${OPENAI_API_KEY}",  // 推荐：使用环境变量\n` +
      `    "baseURL": "https://api.openai.com/v1",\n` +
      `    "model": "text-embedding-3-small"\n` +
      `  }\n` +
      `}\n\n` +
      `如需帮助，运行：ms doctor\n` +
      `详细文档：docs/troubleshooting/env-setup.md`
    );
  }

  if (config.apiKey.includes("${") || config.apiKey.includes("}")) {
    throw new Error(
      `[Mengshu 配置错误] 环境变量未正确解析\n\n` +
      `当前配置：embedding.apiKey = "${config.apiKey}"\n\n` +
      `这通常是因为环境变量未设置。请按以下步骤检查：\n` +
      `1. 检查 Shell 配置文件（~/.zshrc 或 ~/.bashrc）中是否已设置环境变量\n` +
      `2. 运行 'source ~/.zshrc' 重新加载配置（或重启终端）\n` +
      `3. 运行 'echo $OPENAI_API_KEY' 验证环境变量是否已生效\n` +
      `4. 或者直接在配置文件中填写实际 API Key（不推荐用于敏感信息）\n\n` +
      `如需帮助，运行：ms doctor\n` +
      `详细文档：docs/troubleshooting/env-setup.md`
    );
  }
}

const MEMORY_TRIGGERS = [
  /zapamatuj si|pamatuj|remember/i,
  /preferuji|radši|nechci|prefer/i,
  /rozhodli jsme|budeme používat/i,
  /\+\d{10,}/,
  /[\w.-]+@[\w.-]+\.\w+/,
  /můj\s+\w+\s+je|je\s+můj/i,
  /my\s+\w+\s+is|is\s+my/i,
  /i (like|prefer|hate|love|want|need)/i,
  /always|never|important/i,
];

export function shouldCapture(text: string, options?: { maxChars?: number }): boolean {
  const maxChars = options?.maxChars ?? DEFAULT_CAPTURE_MAX_CHARS;
  if (text.length < 10 || text.length > maxChars) {
    return false;
  }
  // Skip injected context from memory recall
  if (text.includes("<relevant-memories>")) {
    return false;
  }
  // Skip system-generated content
  if (text.startsWith("<") && text.includes("</")) {
    return false;
  }
  // Skip agent summary responses (contain markdown formatting)
  if (text.includes("**") && text.includes("\n-")) {
    return false;
  }
  // Skip emoji-heavy responses (likely agent output)
  const emojiCount = (text.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
  if (emojiCount > 3) {
    return false;
  }
  // Skip likely prompt-injection payloads
  if (looksLikePromptInjection(text)) {
    return false;
  }
  return MEMORY_TRIGGERS.some((r) => r.test(text));
}

export function detectCategory(text: string): MemoryCategory {
  const lower = text.toLowerCase();
  if (/prefer|radši|like|love|hate|want/i.test(lower)) {
    return "preference";
  }
  if (/rozhodli|decided|will use|budeme/i.test(lower)) {
    return "decision";
  }
  if (/\+\d{10,}|@[\w.-]+\.\w+|is called|jmenuje se/i.test(lower)) {
    return "entity";
  }
  if (/is|are|has|have|je|má|jsou/i.test(lower)) {
    return "fact";
  }
  return "other";
}

// ============================================================================
// Plugin Definition
// ============================================================================

const memoryPlugin = {
  id: "mengshu",
  name: "Memory (AutoDB)",
  description: "Long-term memory with vector search, supporting local LanceDB and cloud Supabase storage, with auto-recall/capture and directory scanning capabilities.",
  kind: "memory" as const,
  configSchema: memoryConfigSchema,

  register(api: OpenClawPluginApi) {
    try {
      const cfg = memoryConfigSchema.parse(api.pluginConfig);

      // 早期验证：在初始化 Embeddings 前检查配置完整性
      validateEmbeddingConfig(cfg.embedding);

      const resolvedDbPath = api.resolvePath(cfg.dbPath!);
      const db = DatabaseFactory.createProvider(cfg, resolvedDbPath);
      const embeddings = new Embeddings(cfg.embedding, cfg.batchProcessing);

      // P1-Q2：LLM 驱动的知识图谱仓库（in-memory，v0.x 不持久化）。
      const graphRepository = new InMemoryGraphRepository();

      // P2：QueryHits 追踪器，在 recall 时递增 entity.queryHits30d
      const queryHitsTracker = new QueryHitsTracker({ graphRepo: graphRepository });

      // P2：Centrality 计算器，按 degree 归一化计算 graphCentrality
      const centralityCalculator = new CentralityCalculator({ graphRepo: graphRepository });

      const memoryRepository = new LegacyDatabaseAdapter(db, { appId: "openclaw" });
      const memoryService = new DefaultMemoryService({
        repository: memoryRepository,
        embeddings,
        queryHitsTracker,
      });
    const ingestionStore = new InMemoryMemoryStore();
    const ingestionPipeline = new IngestionPipeline({
      documents: ingestionStore.documents,
      chunks: ingestionStore.chunks,
      jobs: ingestionStore.jobs,
      audit: ingestionStore.audit,
    });

    // 候选区：共享单例，供 observe 自动抽取链路与 Console 审核闭环共用同一实例。
    // approve 通过 promoteCandidate 把候选转换为 active MemoryRecord 写入主库。
    const candidateRepository = new InMemoryCandidateRepository();
    const candidateReview = new CandidateReviewService({
      repository: candidateRepository,
      promoteCandidate: async ({ candidate }) => {
        const record = candidateToMemoryRecord(candidate);
        await memoryService.storeMemory({ record });
        return { memoryId: record.id };
      },
      audit: async ({ scope, action, targetId, metadata }) => {
        await ingestionStore.audit.append({ scope, action, targetId, metadata });
      },
    });

    // Console 聚合 API：把候选区注入，使 serve 启动的 daemon 能提供 Candidates 治理闭环。
    const consoleApi = createConsoleApi({
      service: memoryService,
      candidates: candidateRepository,
      candidateReview,
    });

    // F2/F3：LLM 客户端（未配置 llm 时返回 NullLlmClient，树摘要降级 extractive）
    // 与 in-memory 记忆树仓库（source/topic/global，v0.x 不持久化）。
    const llmClient = createLlmClient(cfg.llm);
    const treeRepository = new InMemoryTreeRepository();

    // observe 自动抽取链路：
    // 1. AgentFastPathService.observeLight 入队 extract_candidate + build_tree job（jobs = ingestionStore.jobs）。
    // 2. extract_candidate handler 经 extractor 抽取并写入候选区（pending，不污染主库）。
    // 3. build_tree handler 把 observation 追加到 source 树 buffer，满阈值 seal 成 SummaryNode。
    // 4. daemon worker loop 轮询 jobs 执行 handler（serve 时启动，见下方 registerMemoryServerCliCommands）。
    const agentFastPath = new AgentFastPathService({
      loadRecordsForScope: async (resolvedScope) => {
        const result = await memoryService.recall({
          query: "",
          scope: resolvedScope,
          limit: 50,
          minScore: 0,
        });
        return extractRecords(result.hits);
      },
      recall: async (resolvedScope, query, opts) =>
        memoryService.recall({
          query,
          scope: resolvedScope,
          limit: opts?.limit ?? 10,
          minScore: opts?.minScore ?? 0.1,
        }),
      enqueueJob: async ({ type, payload }) => {
        const targetId =
          typeof payload.traceId === "string" ? payload.traceId : computeContentHash(JSON.stringify(payload));
        const job = await enqueueUniqueJob(ingestionStore.jobs, { type, targetId, payload });
        return job.id;
      },
      // F3-3：lookup_deep 融合记忆树摘要。
      loadTreeSummaries: async (resolvedScope) => treeRepository.listSummaries({ scope: resolvedScope }),
    });

    // extract_candidate job handler：observe → extractor → 候选区（pending）。
    const extractCandidateHandler = createExtractCandidateHandler({
      extractor: defaultTypeExtractor,
      candidates: candidateRepository,
      audit: async ({ scope, action, targetId, metadata }) => {
        await ingestionStore.audit.append({ scope, action, targetId, metadata });
      },
    });

    // F3：build_tree job handler：observe/ingest → 树 buffer → seal（LLM 可用则 abstractive 摘要）。
    const buildTreeHandler = createBuildTreeHandler({
      repository: treeRepository,
      llmClient,
    });

    // P1-Q2：extract_graph job handler：LLM 驱动的知识图谱提取，失败时 fallback 到规则提取。
    // LLM 异常通过 audit 钩子记录 llm_extraction_failed 事件到 ingestionStore.audit。
    const extractGraphHandler = createExtractGraphHandler({
      llmClient,
      graphRepository,
      audit: async ({ scope, action, targetId, metadata }) => {
        await ingestionStore.audit.append({ scope, action, targetId, metadata });
      },
    });

    // 初始化路由引擎（如果启用了多知识库功能）
    const routingEngine = cfg.knowledgeBases?.enabled
      ? createRoutingEngine(cfg.routingRules)
      : null;

    api.logger.info(`mengshu: plugin registered (dbType: ${cfg.dbType}, lazy init)`);

    // ========================================================================
    // Tools
    // ========================================================================

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
            embeddingModel: cfg.embedding.model,
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
          const { directory, ignorePaths = [], ignoreRules = [], targetTable = "knowledge", autoEnrichMetadata = true } = params as {
            directory: string;
            ignorePaths?: string[];
            ignoreRules?: string[];
            targetTable?: string;
            autoEnrichMetadata?: boolean;
          };

          return handleMemoryScanDirectory(
            {
              directory,
              ignorePaths,
              ignoreRules,
              targetTable,
              autoEnrichMetadata,
            },
            {
              pipeline: ingestionPipeline,
              resolvePath: (path) => api.resolvePath(path),
              defaultIgnorePaths: cfg.scanner?.defaultIgnorePaths,
              defaultIgnoreRules: cfg.scanner?.customIgnoreRules,
              defaultTargetTable: cfg.scanner?.targetTable,
              defaultAutoEnrichMetadata: cfg.scanner?.autoEnrichMetadata,
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

    // v3.0 Agent 快路径：5 槽位上下文
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

    // ========================================================================
    // CLI Commands
    // ========================================================================

    api.registerCli(
      ({ program }) => {
        const memory = program.command("ms").description("Memory plugin commands");
        registerMemoryServerCliCommands(memory, {
          config: cfg,
          service: memoryService,
          console: consoleApi,
          agentFastPath,
          worker: {
            jobs: ingestionStore.jobs,
            leaseMs: 30_000,
            intervalMs: 1_000,
            handlers: {
              extract_candidate: extractCandidateHandler,
              build_tree: buildTreeHandler,
              extract_graph: extractGraphHandler,
            },
          },
          getTableStats: db.getTableStats ? () => db.getTableStats!() : undefined,
        });

        // A2-lite: ms init + project 子命令（project scope identity 与 manifest）
        registerProjectCliCommands(memory, {
          service: memoryService,
          getRecordCount: () => db.count(),
        });

        // v0.1.2: ms migrate-home（全局配置目录迁移）
        registerMigrateHomeCommand(memory);

        // Milestone B: ms doctor / demo / connect（本机接入体验）
        registerDoctorCliCommands(memory, {
          config: cfg,
          service: memoryService,
          embeddings,
        });

        // F1-2: ms mcp（stdio MCP server，供 Claude Desktop / Cursor 接入）
        registerMcpCliCommands(memory, {
          service: memoryService,
          agentFastPath,
          namespaces: ["memories", "knowledge"],
        });

        // P2: ms maintain（数据维护工具：calculate-centrality 等）
        registerMaintainCommands(memory, {
          centralityCalculator,
          getDefaultScope: () => ({
            tenantId: "default",
            appId: "openclaw",
            userId: "default",
            projectId: "default",
            agentId: "default",
            namespace: "default",
          }),
        });

        memory
          .command("list")
          .description("List memory statistics")
          .action(async () => {
            const totalCount = await db.count();
            const memoryCount = await db.count({ dataType: "memory" });
            const documentCount = await db.count({ dataType: "document" });

            console.log(`Total memories: ${totalCount}`);
            console.log(`- User memories: ${memoryCount}`);
            console.log(`- Document memories: ${documentCount}`);
          });

        memory
          .command("tables")
          .description("List all tables")
          .action(async () => {
            if (db.getTableNames) {
              const tableNames = await db.getTableNames();
              console.log("Available tables:");
              for (const tableName of tableNames) {
                const count = await db.count({ tableName });
                console.log(`- ${tableName}: ${count} entries`);
              }
            } else {
              console.log("Table listing not supported by current database provider");
            }
          });

        memory
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

            // 分表统计（显示友好的分类名称）
            if (db.getTableStats) {
              const tableStats = await db.getTableStats();
              console.log("\nStorage Categories:");
              for (const stat of tableStats) {
                const categoryName = resolveCategoryName(stat.name);
                console.log(`- ${categoryName} (${stat.name}): ${stat.count} entries`);
              }
            }

            if (cfg.supabase) {
              console.log(`- Supabase URL: ${cfg.supabase.url}`);
            } else {
              console.log(`- LanceDB path: ${resolvedDbPath}`);
            }
          });

        memory
          .command("search")
          .description("Search memories")
          .argument("<query>", "Search query")
          .option("--limit <n>", "Max results", "5")
          .option("--include-documents", "Include scanned documents", false)
          .option("--category <name>", "Storage category: 核心记忆 | 知识库")
          .option("--search-all", "Search across all categories", false)
          .action(async (query, opts) => {
            const vector = await embeddings.embed(query);
            const tableName = resolveTableName(opts.category as string);
            const results = await db.query({
              vector,
              limit: parseInt(opts.limit),
              minScore: 0.3,
              dataTypes: opts.includeDocuments ? ["memory", "document", "knowledge"] : ["memory"],
              tableName,
              searchAll: opts.searchAll,
            });
            // Strip vectors for output
            const output = results.map((r) => ({
              id: r.id,
              text: r.text,
              category: r.category,
              dataType: r.dataType,
              storageCategory: resolveCategoryName(r.tableName),
              filePath: r.metadata?.filePath,
              importance: r.importance,
              score: r.score,
            }));
            console.log(JSON.stringify(output, null, 2));
          });

        memory
          .command("query")
          .description("Advanced query with filters")
          .option("--category <name>", "Storage category: 核心记忆 | 知识库")
          .option("--filter <json>", "Filter conditions as JSON")
          .option("--limit <n>", "Max results", "100")
          .action(async (opts) => {
            let filter: Record<string, unknown> = {};
            if (opts.filter) {
              try {
                filter = JSON.parse(opts.filter);
              } catch (err) {
                console.error("Invalid JSON filter:", err);
                process.exit(1);
              }
            }

            const tableName = resolveTableName(opts.category as string);
            const count = await db.count({ ...filter, tableName });
            console.log(`Found ${count} entries matching filter`);

            // 显示前 limit 条结果
            const results = await db.query({
              limit: parseInt(opts.limit),
              filter,
              tableName,
            });

            const output = results.map((r) => ({
              id: r.id,
              text: r.text.slice(0, 100) + (r.text.length > 100 ? "..." : ""),
              category: r.category,
              dataType: r.dataType,
              storageCategory: resolveCategoryName(r.tableName),
              metadata: r.metadata,
              importance: r.importance,
            }));
            console.log(JSON.stringify(output, null, 2));
          });

        memory
          .command("scan")
          .description("Scan directory of Markdown files")
          .argument("<directory>", "Directory to scan")
          .option("--ignore <paths...>", "Paths to ignore")
          .option("--category <name>", "Storage category: 核心记忆 | 知识库 (default: 知识库)", "知识库")
          .action(async (directory, opts) => {
            const resolvedDir = api.resolvePath(directory);
            const tableName = resolveTableName(opts.category as string) || "knowledge";

            console.log(`Scanning directory: ${resolvedDir}`);
            console.log(`Storage category: ${resolveCategoryName(tableName)}`);
            const response = await handleMemoryScanDirectory(
              {
                directory,
                ignorePaths: opts.ignore || [],
                targetTable: tableName,
              },
              {
                pipeline: ingestionPipeline,
                resolvePath: (path) => api.resolvePath(path),
                defaultIgnorePaths: cfg.scanner?.defaultIgnorePaths,
                defaultIgnoreRules: cfg.scanner?.customIgnoreRules,
                defaultTargetTable: cfg.scanner?.targetTable,
                defaultAutoEnrichMetadata: cfg.scanner?.autoEnrichMetadata,
              },
            );
            const result = response.details as {
              totalFiles: number;
              processedFiles: number;
              failedFiles: number;
              totalChunks: number;
              storedChunks: number;
              duplicateChunks: number;
              jobsQueued: number;
              chunksAdmitted: number;
              chunksDropped: number;
            };

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
          });

        memory
          .command("cleanup")
          .description("Clean up old memories")
          .option("--data-type <type>", "Data type to delete: memory or document")
          .option("--older-than <days>", "Delete entries older than N days")
          .option("--category <name>", "Storage category: 核心记忆 | 知识库")
          .action(async (opts) => {
            const filter: Record<string, unknown> = {};

            if (opts.dataType) {
              filter.dataType = opts.dataType;
            }

            if (opts.olderThan) {
              const days = parseInt(opts.olderThan);
              const cutoffTime = Date.now() - (days * 24 * 60 * 60 * 1000);
              filter.createdAt = { $lt: cutoffTime };
            }

            if (opts.category) {
              filter.tableName = resolveTableName(opts.category as string);
            }

            if (Object.keys(filter).length === 0) {
              console.error("Error: Please specify at least one filter condition");
              process.exit(1);
            }

            const deletedCount = await db.deleteByFilter(filter);
            console.log(`Deleted ${deletedCount} entries`);
          });

        memory
          .command("export")
          .description("Export memory data")
          .option("--category <name>", "Storage category: 核心记忆 | 知识库")
          .option("--format <format>", "Export format: json or csv", "json")
          .option("--output <file>", "Output file path")
          .action(async (opts) => {
            const tableName = resolveTableName(opts.category as string);
            const results = await db.query({
              limit: 10000,
              tableName,
            });

            let output: string;
            if (opts.format === "csv") {
              // CSV 格式导出
              const headers = ["id", "text", "category", "dataType", "importance", "createdAt"];
              output = headers.join(",") + "\n";
              for (const r of results) {
                const row = [
                  r.id,
                  `"${r.text.replace(/"/g, '""')}"`,
                  r.category,
                  r.dataType,
                  r.importance,
                  r.createdAt,
                ];
                output += row.join(",") + "\n";
              }
            } else {
              // JSON 格式导出
              const exportData = results.map((r) => ({
                id: r.id,
                text: r.text,
                category: r.category,
                dataType: r.dataType,
                storageCategory: resolveCategoryName(r.tableName),
                importance: r.importance,
                metadata: r.metadata,
                createdAt: r.createdAt,
              }));
              output = JSON.stringify(exportData, null, 2);
            }

            if (opts.output) {
              const fs = await import("node:fs/promises");
              await fs.writeFile(opts.output, output, "utf-8");
              console.log(`Exported ${results.length} entries to ${opts.output}`);
            } else {
              console.log(output);
            }
          });

        // ========================================================================
        // Knowledge Base Management Commands
        // ========================================================================

        memory
          .command("kb:list")
          .description("List all knowledge bases")
          .action(async () => {
            if (!db.getTableStats) {
              console.log("Knowledge base listing not supported by current database provider");
              return;
            }

            const stats = await db.getTableStats();
            const knowledgeBaseStats = stats.filter(s => s.name.startsWith("knowledge"));

            if (knowledgeBaseStats.length === 0) {
              console.log("No knowledge bases found");
              return;
            }

            console.log("Knowledge Bases:");
            for (const stat of knowledgeBaseStats) {
              const categoryName = resolveCategoryName(stat.name);
              console.log(`- ${categoryName} (${stat.name}): ${stat.count} entries`);
            }
          });

        memory
          .command("kb:stats <name>")
          .description("Show statistics for a specific knowledge base")
          .action(async (name) => {
            if (!db.count) {
              console.log("Statistics not supported by current database provider");
              return;
            }

            const tableName = name as TableName;
            const count = await db.count({ tableName });
            const categoryName = resolveCategoryName(tableName);
            console.log(`${categoryName} (${tableName}): ${count} entries`);
          });

        memory
          .command("kb:create <name>")
          .description("Create a new knowledge base table")
          .action(async (name) => {
            if (!db.ensureTable) {
              console.log("Table creation not supported by current database provider");
              return;
            }

            const tableName = name as TableName;
            if (!tableName.startsWith("knowledge_")) {
              console.error("Error: Knowledge base table name must start with 'knowledge_'");
              process.exit(1);
            }

            await db.ensureTable(tableName);
            const categoryName = resolveCategoryName(tableName);
            console.log(`Created knowledge base: ${categoryName} (${tableName})`);
          });

        memory
          .command("kb:delete <name>")
          .description("Delete a knowledge base table (WARNING: this will delete all data!)")
          .action(async (name) => {
            console.warn("Warning: Deleting a knowledge base will permanently delete all data.");
            console.warn("This operation cannot be undone.");
            console.log("");
            console.log("To delete a knowledge base, please use the Supabase web console or run SQL command:");
            console.log(`  DROP TABLE IF EXISTS ${name};`);
          });

        // ========================================================================
        // Routing Rules Management Commands
        // ========================================================================

        memory
          .command("rules:list")
          .description("List all routing rules")
          .action(async () => {
            if (routingEngine) {
              const rules = routingEngine.getAllRules();
              const enabledRules = routingEngine.getEnabledRules();

              console.log("Routing Rules:");
              console.log("");

              if (rules.length === 0) {
                console.log("  No rules configured");
                return;
              }

              for (const rule of rules) {
                const status = rule.enabled === false ? "(disabled)" : "(enabled)";
                const patterns = rule.patterns.map((p: string | RegExp) => typeof p === "string" ? p : p.source).join(", ");
                console.log(`  ${rule.name} ${status}`);
                console.log(`    Patterns: ${patterns}`);
                console.log(`    Target: ${resolveCategoryName(rule.targetTable)} (${rule.targetTable})`);
                console.log("");
              }

              console.log(`Total: ${rules.length} rules (${enabledRules.length} enabled)`);
            } else {
              console.log("Routing engine not initialized. Enable knowledgeBases in config to use routing rules.");
            }
          });

        memory
          .command("rules:enable <name>")
          .description("Enable a routing rule")
          .action(async (name) => {
            if (routingEngine) {
              routingEngine.toggleRule(name as string, true);
              console.log(`Enabled rule: ${name}`);
            } else {
              console.log("Routing engine not initialized");
            }
          });

        memory
          .command("rules:disable <name>")
          .description("Disable a routing rule")
          .action(async (name) => {
            if (routingEngine) {
              routingEngine.toggleRule(name as string, false);
              console.log(`Disabled rule: ${name}`);
            } else {
              console.log("Routing engine not initialized");
            }
          });
      },
      { commands: ["ms"] },
    );

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    // Auto-recall: inject relevant memories before agent starts
    if (cfg.autoRecall) {
      api.on("before_agent_start", async (event) => {
        return handleBeforeAgentStartRecall(event, {
          service: memoryService,
          recallIncludeDocuments: cfg.recallIncludeDocuments,
          logger: api.logger,
        });
      });
    }

    // Auto-capture: analyze and store important information after agent ends
    if (cfg.autoCapture) {
      api.on("agent_end", async (event) => {
        return handleAgentEndCapture(event, {
          service: memoryService,
          embedBatch: (texts) => embeddings.embedBatch(texts),
          existsByContentHash: (hashes) => db.existsByContentHash(hashes),
          shouldCapture,
          detectCategory,
          captureMaxChars: cfg.captureMaxChars,
          embeddingModel: cfg.embedding.model,
          logger: api.logger,
        });
      });
    }

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "mengshu",
      start: async () => {
        await db.initialize();
        api.logger.info(
          `mengshu: initialized (dbType: ${cfg.dbType}, model: ${cfg.embedding.model})`,
        );
      },
      stop: async () => {
        await db.close();
        api.logger.info("mengshu: stopped");
      },
    });
    } catch (error) {
      // 捕获并转换技术性错误为用户友好的提示
      if (error instanceof Error) {
        // 如果错误已经包含友好提示（以 [Mengshu 配置错误] 开头），直接抛出
        if (error.message.includes("[Mengshu 配置错误]") || error.message.includes("环境变量")) {
          throw error;
        }

        // 余额不足：403 + balance/insufficient/余额/code 30001。
        // 优先于通用 401/403 判断，避免把"余额不足"误导成"Key 无效"。
        if (
          (error.message.includes("403") || error.message.includes("余额") ||
            /balance|insufficient|arrears/i.test(error.message)) &&
          (/balance|insufficient|余额|欠费|arrears/i.test(error.message) ||
            error.message.includes("30001"))
        ) {
          throw new Error(
            `[Mengshu 配置错误] Embedding 服务账户余额不足（${error.message}）\n\n` +
            `API Key 本身有效，但对应账户额度不足以调用 Embedding。\n\n` +
            `请处理：\n` +
            `- 前往服务商控制台充值（如 SiliconFlow / DeepSeek）\n` +
            `- 或更换一个有额度的 Embedding API Key\n` +
            `- 充值后运行 'ms doctor' 复验\n\n` +
            `原始错误：${error.message}`
          );
        }

        // 转换常见的 API 错误
        if (error.message.includes("403") || error.message.includes("401")) {
          throw new Error(
            `[Mengshu 配置错误] API 认证失败（${error.message}）\n\n` +
            `这通常是因为：\n` +
            `1. API Key 无效或已过期\n` +
            `2. API Key 没有访问 Embedding API 的权限\n` +
            `3. 环境变量未正确设置\n\n` +
            `请检查配置：\n` +
            `- 确认 API Key 是否有效（可在提供商控制台验证）\n` +
            `- 确认 baseURL 是否正确（如 https://api.openai.com/v1）\n` +
            `- 运行 'ms doctor' 诊断配置问题\n\n` +
            `详细文档：docs/troubleshooting/env-setup.md\n\n` +
            `原始错误：${error.message}`
          );
        }

        if (error.message.includes("ECONNREFUSED") || error.message.includes("ENOTFOUND")) {
          throw new Error(
            `[Mengshu 配置错误] 无法连接到 Embedding API（${error.message}）\n\n` +
            `这通常是因为：\n` +
            `1. baseURL 配置错误（请检查拼写和协议 http/https）\n` +
            `2. 网络连接问题（防火墙、代理设置）\n` +
            `3. API 服务不可用\n\n` +
            `请检查配置：\n` +
            `- 确认 baseURL 是否正确（如 https://api.openai.com/v1）\n` +
            `- 如使用本地服务（如 Ollama），确认服务是否已启动\n` +
            `- 运行 'ms doctor' 诊断连接问题\n\n` +
            `详细文档：docs/troubleshooting/env-setup.md\n\n` +
            `原始错误：${error.message}`
          );
        }
      }

      // 未识别的错误，附加通用帮助信息
      throw new Error(
        `[Mengshu 初始化失败] ${error instanceof Error ? error.message : String(error)}\n\n` +
        `如需帮助：\n` +
        `- 运行 'ms doctor' 诊断问题\n` +
        `- 查看配置文档：docs/troubleshooting/env-setup.md\n` +
        `- 查看故障排查：docs/troubleshooting/README.md`
      );
    }
  },
};

export default memoryPlugin;
