import fs from "node:fs";
import { resolveDefaultLanceDbPath, resolveLegacyLanceDbPath } from "./core/paths.js";

/**
 * 路由规则配置
 */
export interface RoutingRule {
  /** 规则名称 */
  name: string;
  /** 匹配模式（支持多个正则表达式字符串） */
  patterns: string[];
  /** 目标表 */
  targetTable: string;
  /** 是否启用 */
  enabled?: boolean;
}

/**
 * 知识库配置
 */
export interface KnowledgeBaseConfig {
  /** 是否启用多知识库功能 */
  enabled: boolean;
  /** 是否自动创建表 */
  autoCreateTables: boolean;
  /** 向量维度 */
  vectorDimensions?: number;
  /** 内置分类（personal, work） */
  builtinCategories?: string[];
  /** 用户自定义分类 */
  customCategories?: string[];
}

export type MemoryConfig = {
  embedding: {
    provider: "openai";
    model?: string;
    baseURL?: string;
    apiKey: string;
  };
  /**
   * LLM chat completion 配置（可选）。
   * 提供后即可启用摘要 / 抽取等生成式能力；未提供时上层降级到 NullLlmClient。
   *
   * 模型分层配置：
   * - extractionModel: 结构化抽取（候选记忆提取）
   * - summarizationModel: 摘要生成（Memory Tree sealing）
   * - reasoningModel: 推理判断（faithfulness 校验、晋升决策）
   *
   * temperature 可选配置（0~2），缺省由调用方决定（结构化任务通常用 0.0）。
   */
  llm?: {
    provider: "openai";
    /** 默认模型（兜底） */
    model: string;
    baseURL?: string;
    apiKey: string;
    maxTokens?: number;
    /** 采样温度（0~2），可选 */
    temperature?: number;
    /** 结构化抽取模型（候选记忆提取） */
    extractionModel?: string;
    /** 摘要生成模型（Memory Tree sealing） */
    summarizationModel?: string;
    /** 推理判断模型（faithfulness 校验、晋升决策） */
    reasoningModel?: string;
  };
  mode?: "embedded" | "server" | "remote" | "backend-proxy";
  server?: {
    enabled?: boolean;
    host?: string;
    port?: number;
    secret?: string;
    requireHttps?: boolean;
  };
  features?: {
    bm25?: boolean;
    graph?: boolean;
    summaryTree?: boolean;
    webConsole?: boolean;
  };
  dbType?: "lancedb" | "supabase" | "postgres";
  dbPath?: string;
  supabase?: {
    url: string;
    serviceKey: string;
  };
  postgres?: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    ssl?: boolean;
  };
  scanner?: {
    defaultIgnorePaths?: string[];
    customIgnoreRules?: string[];
    targetTable?: "memories" | "knowledge" | "documents";
    autoEnrichMetadata?: boolean;
  };
  batchProcessing?: {
    maxBatchSize?: number;
    concurrency?: number;
    retryAttempts?: number;
  };
  autoCapture?: boolean;
  autoRecall?: boolean;
  recallIncludeDocuments?: boolean;
  captureMaxChars?: number;
  tables?: {
    memories?: {
      enabled?: boolean;
      autoIndex?: boolean;
    };
    knowledge?: {
      enabled?: boolean;
      autoIndex?: boolean;
    };
  };
  /**
   * 多知识库配置
   * 支持动态创建 knowledge_* 表，实现知识分类存储
   */
  knowledgeBases?: KnowledgeBaseConfig;
  /**
   * 路由规则配置
   * 根据内容自动路由到对应的知识库表
   */
  routingRules?: RoutingRule[];
  /**
   * Memory Tree 配置
   */
  tree?: {
    summaryFaithfulness?: {
      /** 校验模式（D-07：P2 起默认 high_risk） */
      mode?: "off" | "sampled" | "high_risk" | "always";
      /** 抽样比例（sampled 模式下生效） */
      sampleRate?: number;
      /** Judge 模型（可选，缺省使用 llm.reasoningModel） */
      judgeModel?: string;
      /** 校验失败时的处理动作 */
      failAction?: "fallback_extractive" | "mark_untrusted" | "retry";
    };
  };
  /**
   * 候选自动晋升配置（§11.1 / §13）
   */
  promotion?: {
    /** 是否启用自动晋升（默认 true） */
    enabled?: boolean;
    /** 最少证据数（默认 5） */
    minEvidenceCount?: number;
    /** 最少观察时间跨度（天，默认 3） */
    minTimeSpanDays?: number;
    /** 泛化阈值：达到此阈值才聚合（默认 5） */
    generalizeThreshold?: number;
    /** 语义相似度阈值（默认 0.78） */
    minSimilarity?: number;
    /** 是否启用冲突自动降级（默认 true） */
    autoConflictDowngrade?: boolean;
  };
};

/**
 * 默认知识库配置
 */
export const DEFAULT_KNOWLEDGE_BASE_CATEGORIES = ["personal", "work"];

/**
 * 默认路由规则
 *
 * 注意：patterns 数组中的每个字符串都会被转换为独立的正则表达式
 * 如果需要使用"或"逻辑，请在单个字符串中使用 | 分隔（如 "个人 | 笔记|diary"）
 */
export const DEFAULT_ROUTING_RULES: RoutingRule[] = [
  {
    name: "personal",
    patterns: ["个人 | 笔记 | 日记|diary|随笔"],
    targetTable: "knowledge_personal",
    enabled: true,
  },
  {
    name: "work",
    patterns: ["工作 | 项目|work|project|任务"],
    targetTable: "knowledge_work",
    enabled: true,
  },
];

// 存储分类（与 STORAGE_CATEGORY_MAP 对应）
// memories 表分类
export const MEMORY_CATEGORIES = [
  "core",        // 核心记忆：对话中的关键信息
  "preference",  // 用户偏好：用户的喜好和习惯
  "fact",        // 事实：客观事实和知识点
  "entity",      // 实体：人名、地名、组织等
  "decision",    // 决策：达成的决定和共识
  "task",        // 定时任务：周期性任务
  "plan",        // 长期规划：长期计划和目标
  "goal",        // 目标：具体目标
  "other",       // 其他：知识库默认分类
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

const DEFAULT_MODEL = "text-embedding-3-small";
export const DEFAULT_CAPTURE_MAX_CHARS = 500;
const DEFAULT_SERVER_HOST = "127.0.0.1";
const DEFAULT_SERVER_PORT = 3847;
const VALID_MODES = ["embedded", "server", "remote", "backend-proxy"] as const;

let warnedLegacyDbPath = false;

function resolveDefaultDbPath(): string {
  const preferred = resolveDefaultLanceDbPath();
  try {
    if (fs.existsSync(preferred)) {
      return preferred;
    }
  } catch {
    // best-effort
  }

  // 兼容回退：仅当用户未显式覆盖 MENGSHU_HOME 时，才考虑旧路径。
  // 显式覆盖代表用户已经选择新 home，不应被旧目录截胡。
  const explicitHome = process.env.MENGSHU_HOME;
  if (!explicitHome || explicitHome.trim().length === 0) {
    try {
      const legacy = resolveLegacyLanceDbPath();
      if (fs.existsSync(legacy)) {
        if (!warnedLegacyDbPath) {
          warnedLegacyDbPath = true;
          console.warn(
            "[mengshu] 检测到旧路径 ~/.openclaw/memory/lancedb，建议运行 `ms migrate-home` 迁移到 ~/.mengshu/",
          );
        }
        return legacy;
      }
    } catch {
      // best-effort
    }
  }

  return preferred;
}

const EMBEDDING_DIMENSIONS: Record<string, number> = {
  // OpenAI 模型
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,

  // BAAI 模型
  "BAAI/bge-m3": 1024,

  // Ollama 常用嵌入模型
  "nomic-embed-text": 768,
  "nomic-embed-text:v1.5": 768,
  "mxbai-embed-large": 1024,
  "mxbai-embed-large:v1": 1024,
  "all-minilm": 384,
  "all-minilm:v6": 384,
  "all-minilm:v6.5": 384,
  "snowflake-arctic-embed": 1024,
  "snowflake-arctic-embed:l": 1024,
  "snowflake-arctic-embed:m": 768,
  "snowflake-arctic-embed:s": 512,

  // Ollama Open API 兼容模式（使用 openai 模型名）
  "modelscope.cn/Qwen/Qwen3-Embedding-0.6B-GGUF:latest": 1024,
  "Qwen/Qwen3-Embedding-0.6B":1024
};

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) {
    return;
  }
  throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
}

export function vectorDimsForModel(model: string): number {
  const dims = EMBEDDING_DIMENSIONS[model];
  if (!dims) {
    throw new Error(`Unsupported embedding model: ${model}`);
  }
  return dims;
}

/**
 * 解析配置中的环境变量占位符
 * @param value 配置值，如 "${OPENAI_API_KEY}"
 * @param fieldName 字段名，用于生成友好的错误信息
 * @returns 解析后的实际值
 * @throws 当环境变量未设置时抛出友好的配置错误
 *
 * 安全约束：占位符内的变量名必须匹配 `ENV_NAME_RE`（POSIX 习惯：大写字母 / 数字 /
 * 下划线，且首字符不能是数字）。不匹配时保留原 `${...}` 不替换并打印 warning，
 * 避免把可疑字符串（如 `${'; DROP TABLE; --}` 或带空格的命令片段）当作 env key
 * 透传到 process.env 查询。
 */
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

function resolveEnvVars(value: string, fieldName?: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (placeholder, envVar) => {
    if (typeof envVar !== "string" || !ENV_NAME_RE.test(envVar)) {
      // 非法变量名：保留原样并告警，不破坏整体配置加载（保持向后兼容）。
      const field = fieldName ? ` (${fieldName})` : "";
      console.warn(
        `[memory-autodb] Ignoring invalid env var placeholder${field}: ${placeholder}. ` +
          `Allowed pattern: ${ENV_NAME_RE.source}`,
      );
      return placeholder;
    }
    const envValue = process.env[envVar];
    if (!envValue) {
      const field = fieldName ? ` (${fieldName})` : "";
      const shellConfig = getShellConfigFile();
      throw new Error(
        `环境变量 ${envVar} 未设置${field}\n\n` +
        `请按以下步骤配置：\n` +
        `1. 编辑 Shell 配置文件：${shellConfig}\n` +
        `2. 添加环境变量：export ${envVar}="your-actual-value"\n` +
        `3. 重新加载配置：source ${shellConfig}\n` +
        `4. 或者在配置文件中直接填写实际值（不推荐用于敏感信息）\n\n` +
        `详细文档：docs/troubleshooting/env-setup.md`
      );
    }
    return envValue;
  });
}

/**
 * 获取当前 Shell 的配置文件路径
 */
function getShellConfigFile(): string {
  const shell = process.env.SHELL || "";
  if (shell.includes("zsh")) {
    return "~/.zshrc";
  }
  if (shell.includes("bash")) {
    return "~/.bashrc 或 ~/.bash_profile";
  }
  return "~/.profile";
}

function resolveEmbeddingModel(embedding: Record<string, unknown>): string {
  const model = typeof embedding.model === "string" ? embedding.model : DEFAULT_MODEL;
  vectorDimsForModel(model);
  return model;
}

export const memoryConfigSchema = {
  parse(value: unknown): MemoryConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("memory config required");
    }
    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(
      cfg,
      ["embedding", "llm", "mode", "server", "features", "dbType", "dbPath", "supabase", "postgres", "scanner", "batchProcessing", "autoCapture", "autoRecall", "recallIncludeDocuments", "captureMaxChars", "tables", "knowledgeBases", "routingRules", "tree"],
      "memory config",
    );

    const embedding = cfg.embedding as Record<string, unknown> | undefined;
    if (!embedding || typeof embedding.apiKey !== "string") {
      throw new Error("embedding.apiKey is required");
    }
    if (!embedding || typeof embedding.baseURL !== "string") {
      throw new Error("embedding.baseURL is required");
    }
    assertAllowedKeys(embedding, ["apiKey", "baseURL", "model"], "embedding config");

    const model = resolveEmbeddingModel(embedding);

    // Validate llm config if provided
    const llm = cfg.llm as Record<string, unknown> | undefined;
    if (llm) {
      assertAllowedKeys(
        llm,
        ["provider", "model", "baseURL", "apiKey", "maxTokens", "temperature", "extractionModel", "summarizationModel", "reasoningModel"],
        "llm config",
      );
      if (typeof llm.apiKey !== "string" || !llm.apiKey) {
        throw new Error("llm.apiKey is required when llm config is provided");
      }
      if (typeof llm.model !== "string" || !llm.model) {
        throw new Error("llm.model is required when llm config is provided");
      }
      if (llm.baseURL !== undefined && typeof llm.baseURL !== "string") {
        throw new Error("llm.baseURL must be a string");
      }
      if (
        llm.maxTokens !== undefined &&
        (typeof llm.maxTokens !== "number" || !Number.isInteger(llm.maxTokens) || llm.maxTokens < 1)
      ) {
        throw new Error("llm.maxTokens must be a positive integer");
      }
      if (llm.extractionModel !== undefined && typeof llm.extractionModel !== "string") {
        throw new Error("llm.extractionModel must be a string");
      }
      if (llm.summarizationModel !== undefined && typeof llm.summarizationModel !== "string") {
        throw new Error("llm.summarizationModel must be a string");
      }
      if (llm.reasoningModel !== undefined && typeof llm.reasoningModel !== "string") {
        throw new Error("llm.reasoningModel must be a string");
      }
      if (
        llm.temperature !== undefined &&
        (typeof llm.temperature !== "number" || llm.temperature < 0 || llm.temperature > 2)
      ) {
        throw new Error("llm.temperature must be between 0 and 2");
      }
    }

    const mode = typeof cfg.mode === "string" ? cfg.mode : "embedded";
    if (!VALID_MODES.includes(mode as (typeof VALID_MODES)[number])) {
      throw new Error("mode must be one of: embedded, server, remote, backend-proxy");
    }

    const server = cfg.server as Record<string, unknown> | undefined;
    if (server) {
      assertAllowedKeys(server, ["enabled", "host", "port", "secret", "requireHttps"], "server config");
      if (server.enabled !== undefined && typeof server.enabled !== "boolean") {
        throw new Error("server.enabled must be a boolean");
      }
      if (server.host !== undefined && typeof server.host !== "string") {
        throw new Error("server.host must be a string");
      }
      if (
        server.port !== undefined &&
        (typeof server.port !== "number" || !Number.isInteger(server.port) || server.port < 1 || server.port > 65535)
      ) {
        throw new Error("server.port must be between 1 and 65535");
      }
      if (server.secret !== undefined && typeof server.secret !== "string") {
        throw new Error("server.secret must be a string");
      }
      if (server.requireHttps !== undefined && typeof server.requireHttps !== "boolean") {
        throw new Error("server.requireHttps must be a boolean");
      }
    }

    const features = cfg.features as Record<string, unknown> | undefined;
    if (features) {
      assertAllowedKeys(features, ["bm25", "graph", "summaryTree", "webConsole"], "features config");
      for (const key of ["bm25", "graph", "summaryTree", "webConsole"]) {
        if (features[key] !== undefined && typeof features[key] !== "boolean") {
          throw new Error(`features.${key} must be a boolean`);
        }
      }
    }

    // Validate supabase config if provided
    const supabase = cfg.supabase as Record<string, unknown> | undefined;
    if (supabase) {
      assertAllowedKeys(supabase, ["url", "serviceKey"], "supabase config");
      if (typeof supabase.url !== "string" || !supabase.url) {
        throw new Error("supabase.url is required when supabase config is provided");
      }
      if (typeof supabase.serviceKey !== "string" || !supabase.serviceKey) {
        throw new Error("supabase.serviceKey is required when supabase config is provided");
      }
    }

    // Validate postgres config if provided
    const postgres = cfg.postgres as Record<string, unknown> | undefined;
    if (postgres) {
      assertAllowedKeys(postgres, ["host", "port", "database", "user", "password", "ssl"], "postgres config");
      if (typeof postgres.host !== "string" || !postgres.host) {
        throw new Error("postgres.host is required when postgres config is provided");
      }
      if (typeof postgres.port !== "number") {
        throw new Error("postgres.port is required and must be a number");
      }
      if (typeof postgres.database !== "string" || !postgres.database) {
        throw new Error("postgres.database is required when postgres config is provided");
      }
      if (typeof postgres.user !== "string" || !postgres.user) {
        throw new Error("postgres.user is required when postgres config is provided");
      }
      if (typeof postgres.password !== "string" || !postgres.password) {
        throw new Error("postgres.password is required when postgres config is provided");
      }
      if (postgres.ssl !== undefined && typeof postgres.ssl !== "boolean") {
        throw new Error("postgres.ssl must be a boolean");
      }
    }

    // Validate scanner config if provided
    const scanner = cfg.scanner as Record<string, unknown> | undefined;
    if (scanner) {
      assertAllowedKeys(scanner, ["defaultIgnorePaths", "customIgnoreRules", "targetTable", "autoEnrichMetadata"], "scanner config");
      if (scanner.defaultIgnorePaths && !Array.isArray(scanner.defaultIgnorePaths)) {
        throw new Error("scanner.defaultIgnorePaths must be an array");
      }
      if (scanner.customIgnoreRules && !Array.isArray(scanner.customIgnoreRules)) {
        throw new Error("scanner.customIgnoreRules must be an array");
      }
      if (scanner.targetTable && typeof scanner.targetTable !== "string") {
        throw new Error("scanner.targetTable must be a string");
      }
      if (scanner.autoEnrichMetadata && typeof scanner.autoEnrichMetadata !== "boolean") {
        throw new Error("scanner.autoEnrichMetadata must be a boolean");
      }
    }

    // Validate tables config if provided
    const tables = cfg.tables as Record<string, unknown> | undefined;
    if (tables) {
      assertAllowedKeys(tables, ["memories", "knowledge"], "tables config");
      if (tables.memories && typeof tables.memories !== "object") {
        throw new Error("tables.memories must be an object");
      }
      if (tables.knowledge && typeof tables.knowledge !== "object") {
        throw new Error("tables.knowledge must be an object");
      }
    }

    // Validate batchProcessing config if provided
    const batchProcessing = cfg.batchProcessing as Record<string, unknown> | undefined;
    if (batchProcessing) {
      assertAllowedKeys(batchProcessing, ["maxBatchSize", "concurrency", "retryAttempts"], "batchProcessing config");
      if (batchProcessing.maxBatchSize && (typeof batchProcessing.maxBatchSize !== "number" || batchProcessing.maxBatchSize < 1 || batchProcessing.maxBatchSize > 1000)) {
        throw new Error("batchProcessing.maxBatchSize must be between 1 and 1000");
      }
      if (batchProcessing.concurrency && (typeof batchProcessing.concurrency !== "number" || batchProcessing.concurrency < 1 || batchProcessing.concurrency > 10)) {
        throw new Error("batchProcessing.concurrency must be between 1 and 10");
      }
      if (batchProcessing.retryAttempts && (typeof batchProcessing.retryAttempts !== "number" || batchProcessing.retryAttempts < 0 || batchProcessing.retryAttempts > 10)) {
        throw new Error("batchProcessing.retryAttempts must be between 0 and 10");
      }
    }

    // Validate knowledgeBases config if provided
    const knowledgeBases = cfg.knowledgeBases as Record<string, unknown> | undefined;
    if (knowledgeBases) {
      assertAllowedKeys(knowledgeBases, ["enabled", "autoCreateTables", "vectorDimensions", "builtinCategories", "customCategories"], "knowledgeBases config");
      if (knowledgeBases.enabled && typeof knowledgeBases.enabled !== "boolean") {
        throw new Error("knowledgeBases.enabled must be a boolean");
      }
      if (knowledgeBases.autoCreateTables && typeof knowledgeBases.autoCreateTables !== "boolean") {
        throw new Error("knowledgeBases.autoCreateTables must be a boolean");
      }
      if (knowledgeBases.vectorDimensions && typeof knowledgeBases.vectorDimensions !== "number") {
        throw new Error("knowledgeBases.vectorDimensions must be a number");
      }
      if (knowledgeBases.builtinCategories && !Array.isArray(knowledgeBases.builtinCategories)) {
        throw new Error("knowledgeBases.builtinCategories must be an array of strings");
      }
      if (knowledgeBases.customCategories && !Array.isArray(knowledgeBases.customCategories)) {
        throw new Error("knowledgeBases.customCategories must be an array of strings");
      }
      // 验证 builtinCategories 和 customCategories 的格式（只能是字母、数字、下划线）
      const validCategoryName = /^[a-z][a-z0-9_]*$/;
      const builtinCats: string[] = Array.isArray(knowledgeBases.builtinCategories) ? knowledgeBases.builtinCategories : [];
      const customCats: string[] = Array.isArray(knowledgeBases.customCategories) ? knowledgeBases.customCategories : [];
      const allCategories = builtinCats.concat(customCats);
      for (const cat of allCategories) {
        if (typeof cat !== "string" || !validCategoryName.test(cat)) {
          throw new Error(`Invalid category name "${cat}": must start with lowercase letter, contain only lowercase letters, numbers, and underscores`);
        }
      }
    }

    // Validate routingRules config if provided
    const routingRules = cfg.routingRules as unknown[] | undefined;
    if (routingRules) {
      if (!Array.isArray(routingRules)) {
        throw new Error("routingRules must be an array");
      }
      for (let i = 0; i < routingRules.length; i++) {
        const rule = routingRules[i] as Record<string, unknown>;
        assertAllowedKeys(rule, ["name", "patterns", "targetTable", "enabled"], `routingRules[${i}]`);
        if (!rule.name || typeof rule.name !== "string") {
          throw new Error(`routingRules[${i}].name must be a string`);
        }
        if (!rule.patterns || !Array.isArray(rule.patterns)) {
          throw new Error(`routingRules[${i}].patterns must be an array of strings`);
        }
        // 验证 patterns 数组元素
        for (const pattern of rule.patterns as unknown[]) {
          if (typeof pattern !== "string") {
            throw new Error(`routingRules[${i}].patterns must contain only strings`);
          }
        }
        if (!rule.targetTable || typeof rule.targetTable !== "string") {
          throw new Error(`routingRules[${i}].targetTable must be a string`);
        }
        if (rule.enabled !== undefined && typeof rule.enabled !== "boolean") {
          throw new Error(`routingRules[${i}].enabled must be a boolean`);
        }
      }
    }

    // Validate tree config if provided
    const tree = cfg.tree as Record<string, unknown> | undefined;
    if (tree) {
      assertAllowedKeys(tree, ["summaryFaithfulness"], "tree config");
      const summaryFaithfulness = tree.summaryFaithfulness as Record<string, unknown> | undefined;
      if (summaryFaithfulness) {
        assertAllowedKeys(summaryFaithfulness, ["mode", "sampleRate", "judgeModel", "failAction"], "tree.summaryFaithfulness config");
        if (summaryFaithfulness.mode !== undefined) {
          const validModes = ["off", "sampled", "high_risk", "always"];
          if (typeof summaryFaithfulness.mode !== "string" || !validModes.includes(summaryFaithfulness.mode)) {
            throw new Error(`tree.summaryFaithfulness.mode must be one of: ${validModes.join(", ")}`);
          }
        }
        if (summaryFaithfulness.sampleRate !== undefined) {
          if (typeof summaryFaithfulness.sampleRate !== "number" || summaryFaithfulness.sampleRate < 0 || summaryFaithfulness.sampleRate > 1) {
            throw new Error("tree.summaryFaithfulness.sampleRate must be between 0 and 1");
          }
        }
        if (summaryFaithfulness.judgeModel !== undefined && typeof summaryFaithfulness.judgeModel !== "string") {
          throw new Error("tree.summaryFaithfulness.judgeModel must be a string");
        }
        if (summaryFaithfulness.failAction !== undefined) {
          const validActions = ["fallback_extractive", "mark_untrusted", "retry"];
          if (typeof summaryFaithfulness.failAction !== "string" || !validActions.includes(summaryFaithfulness.failAction)) {
            throw new Error(`tree.summaryFaithfulness.failAction must be one of: ${validActions.join(", ")}`);
          }
        }
      }
    }

    const captureMaxChars =
      typeof cfg.captureMaxChars === "number" ? Math.floor(cfg.captureMaxChars) : undefined;
    if (
      typeof captureMaxChars === "number" &&
      (captureMaxChars < 100 || captureMaxChars > 10_000)
    ) {
      throw new Error("captureMaxChars must be between 100 and 10000");
    }

    return {
      embedding: {
        provider: "openai",
        model,
        apiKey: resolveEnvVars(String(embedding.apiKey), "embedding.apiKey"),
        baseURL: resolveEnvVars(String(embedding.baseURL), "embedding.baseURL"),
      },
      llm: llm ? {
        provider: "openai",
        model: String(llm.model),
        apiKey: resolveEnvVars(String(llm.apiKey), "llm.apiKey"),
        baseURL: typeof llm.baseURL === "string" ? resolveEnvVars(llm.baseURL, "llm.baseURL") : undefined,
        maxTokens: typeof llm.maxTokens === "number" ? llm.maxTokens : undefined,
        temperature: typeof llm.temperature === "number" ? llm.temperature : undefined,
        extractionModel: typeof llm.extractionModel === "string" ? llm.extractionModel : undefined,
        summarizationModel: typeof llm.summarizationModel === "string" ? llm.summarizationModel : undefined,
        reasoningModel: typeof llm.reasoningModel === "string" ? llm.reasoningModel : undefined,
      } : undefined,
      mode: mode as MemoryConfig["mode"],
      server: {
        enabled: server?.enabled === true,
        host: typeof server?.host === "string" ? server.host : DEFAULT_SERVER_HOST,
        port: typeof server?.port === "number" ? server.port : DEFAULT_SERVER_PORT,
        secret: typeof server?.secret === "string" ? resolveEnvVars(server.secret, "server.secret") : undefined,
        requireHttps: server?.requireHttps === true,
      },
      features: {
        bm25: features?.bm25 === true,
        graph: features?.graph === true,
        summaryTree: features?.summaryTree === true,
        webConsole: features?.webConsole === true,
      },
      dbType: (cfg.dbType === "supabase" ? "supabase" : cfg.dbType === "postgres" ? "postgres" : "lancedb"),
      dbPath: typeof cfg.dbPath === "string" ? cfg.dbPath : resolveDefaultDbPath(),
      supabase: supabase ? {
        url: resolveEnvVars(String(supabase.url), "supabase.url"),
        serviceKey: resolveEnvVars(String(supabase.serviceKey), "supabase.serviceKey"),
      } : undefined,
      postgres: postgres ? {
        host: resolveEnvVars(String(postgres.host), "postgres.host"),
        port: postgres.port as number,
        database: resolveEnvVars(String(postgres.database), "postgres.database"),
        user: resolveEnvVars(String(postgres.user), "postgres.user"),
        password: resolveEnvVars(String(postgres.password), "postgres.password"),
        ssl: postgres.ssl as boolean | undefined,
      } : undefined,
      scanner: scanner ? {
        defaultIgnorePaths: scanner.defaultIgnorePaths as string[] | undefined,
        customIgnoreRules: scanner.customIgnoreRules as string[] | undefined,
        targetTable: scanner.targetTable as "memories" | "knowledge" | "documents" | undefined,
        autoEnrichMetadata: scanner.autoEnrichMetadata as boolean | undefined,
      } : undefined,
      batchProcessing: batchProcessing ? {
        maxBatchSize: typeof batchProcessing.maxBatchSize === "number" ? batchProcessing.maxBatchSize : 20,
        concurrency: typeof batchProcessing.concurrency === "number" ? batchProcessing.concurrency : 3,
        retryAttempts: typeof batchProcessing.retryAttempts === "number" ? batchProcessing.retryAttempts : 3,
      } : undefined,
      autoCapture: cfg.autoCapture === true,
      autoRecall: cfg.autoRecall !== false,
      recallIncludeDocuments: cfg.recallIncludeDocuments === true,
      captureMaxChars: captureMaxChars ?? DEFAULT_CAPTURE_MAX_CHARS,
      tables: tables ? {
        memories: (tables.memories as Record<string, unknown> | undefined) ? {
          enabled: (tables.memories as Record<string, unknown>).enabled as boolean | undefined,
          autoIndex: (tables.memories as Record<string, unknown>).autoIndex as boolean | undefined,
        } : undefined,
        knowledge: (tables.knowledge as Record<string, unknown> | undefined) ? {
          enabled: (tables.knowledge as Record<string, unknown>).enabled as boolean | undefined,
          autoIndex: (tables.knowledge as Record<string, unknown>).autoIndex as boolean | undefined,
        } : undefined,
      } : undefined,
      knowledgeBases: knowledgeBases ? {
        enabled: (knowledgeBases.enabled as boolean) ?? true,
        autoCreateTables: (knowledgeBases.autoCreateTables as boolean) ?? true,
        vectorDimensions: (knowledgeBases.vectorDimensions as number) ?? undefined,
        builtinCategories: (knowledgeBases.builtinCategories as string[]) ?? DEFAULT_KNOWLEDGE_BASE_CATEGORIES,
        customCategories: (knowledgeBases.customCategories as string[] | undefined),
      } : undefined,
      routingRules: routingRules ? routingRules as RoutingRule[] : DEFAULT_ROUTING_RULES,
      tree: tree ? {
        summaryFaithfulness: tree.summaryFaithfulness ? {
          mode: (tree.summaryFaithfulness as Record<string, unknown>).mode as "off" | "sampled" | "high_risk" | "always" | undefined ?? "high_risk",
          sampleRate: (tree.summaryFaithfulness as Record<string, unknown>).sampleRate as number | undefined ?? 0.05,
          judgeModel: (tree.summaryFaithfulness as Record<string, unknown>).judgeModel as string | undefined,
          failAction: (tree.summaryFaithfulness as Record<string, unknown>).failAction as "fallback_extractive" | "mark_untrusted" | "retry" | undefined ?? "fallback_extractive",
        } : {
          mode: "high_risk",
          sampleRate: 0.05,
          failAction: "fallback_extractive",
        },
      } : undefined,
    };
  },
  uiHints: {
    "embedding.apiKey": {
      label: "OpenAI API Key",
      sensitive: true,
      placeholder: "sk-proj-...",
      help: "API key for OpenAI embeddings (or use ${OPENAI_API_KEY})",
    },
    "embedding.baseURL": {
      label: "OpenAI Base URL",
      sensitive: false,
      placeholder: "https://api.openai.com",
      help: "Base URL for OpenAI API (default is https://api.openai.com)",
    },
    "embedding.model": {
      label: "Embedding Model",
      placeholder: DEFAULT_MODEL,
      help: "OpenAI embedding model to use",
    },
    dbType: {
      label: "Database Type",
      placeholder: "lancedb",
      help: "Database type to use: lancedb (local), supabase (cloud), or postgres (PostgreSQL with pgvector)",
      enum: ["lancedb", "supabase", "postgres"],
    },
    dbPath: {
      label: "LanceDB Path",
      placeholder: "~/.mengshu/memory/lancedb",
      advanced: true,
      help: "Path to local LanceDB database (only for lancedb type)",
    },
    "supabase.url": {
      label: "Supabase URL",
      placeholder: "https://your-project.supabase.co",
      help: "Supabase project URL (only for supabase type)",
    },
    "supabase.serviceKey": {
      label: "Supabase Service Key",
      sensitive: true,
      placeholder: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      help: "Supabase service role key (only for supabase type, or use ${SUPABASE_SERVICE_KEY})",
    },
    "postgres.host": {
      label: "PostgreSQL Host",
      placeholder: "localhost",
      help: "PostgreSQL server host (only for postgres type, or use ${PG_HOST})",
    },
    "postgres.port": {
      label: "PostgreSQL Port",
      placeholder: "5432",
      help: "PostgreSQL server port (only for postgres type)",
    },
    "postgres.database": {
      label: "PostgreSQL Database",
      placeholder: "memory",
      help: "PostgreSQL database name (only for postgres type, or use ${PG_DATABASE})",
    },
    "postgres.user": {
      label: "PostgreSQL User",
      placeholder: "postgres",
      help: "PostgreSQL user (only for postgres type, or use ${PG_USER})",
    },
    "postgres.password": {
      label: "PostgreSQL Password",
      sensitive: true,
      placeholder: "",
      help: "PostgreSQL password (only for postgres type, or use ${PG_PASSWORD})",
    },
    "postgres.ssl": {
      label: "PostgreSQL SSL",
      advanced: true,
      help: "Enable SSL for PostgreSQL connection (default: false)",
    },
    "scanner.defaultIgnorePaths": {
      label: "Default Ignore Paths",
      advanced: true,
      help: "Default paths to ignore during directory scanning",
    },
    "scanner.customIgnoreRules": {
      label: "Custom Ignore Rules",
      advanced: true,
      help: "Custom gitignore-style rules for directory scanning",
    },
    "scanner.targetTable": {
      label: "Scanner Target Table",
      advanced: true,
      placeholder: "knowledge",
      help: "Target table for scanned documents (default: knowledge)",
    },
    "scanner.autoEnrichMetadata": {
      label: "Scanner Auto-enrich Metadata",
      advanced: true,
      placeholder: "true",
      help: "Automatically enrich metadata with file information",
    },
    "batchProcessing.maxBatchSize": {
      label: "Max Batch Size",
      advanced: true,
      placeholder: "20",
      help: "Maximum number of items to process in a single batch",
    },
    "batchProcessing.concurrency": {
      label: "Concurrency",
      advanced: true,
      placeholder: "3",
      help: "Number of concurrent requests for embedding generation",
    },
    "batchProcessing.retryAttempts": {
      label: "Retry Attempts",
      advanced: true,
      placeholder: "3",
      help: "Number of retries for failed embedding requests",
    },
    "knowledgeBases.enabled": {
      label: "Enable Multi-Knowledge Base",
      advanced: true,
      help: "Enable multiple knowledge bases for categorized storage (e.g., personal, work)",
    },
    "knowledgeBases.autoCreateTables": {
      label: "Auto-Create Tables",
      advanced: true,
      help: "Automatically create knowledge base tables on startup",
    },
    "knowledgeBases.builtinCategories": {
      label: "Built-in Categories",
      advanced: true,
      placeholder: '["personal", "work"]',
      help: "Built-in knowledge base categories (creates knowledge_personal, knowledge_work tables)",
    },
    "knowledgeBases.customCategories": {
      label: "Custom Categories",
      advanced: true,
      placeholder: '["priority", "reference"]',
      help: "Custom knowledge base categories (creates knowledge_priority, knowledge_reference tables)",
    },
    "routingRules": {
      label: "Routing Rules",
      advanced: true,
      help: "Rules for automatically routing content to specific knowledge bases based on pattern matching",
    },
    autoCapture: {
      label: "Auto-Capture",
      help: "Automatically capture important information from conversations",
    },
    autoRecall: {
      label: "Auto-Recall",
      help: "Automatically inject relevant memories into context",
    },
    recallIncludeDocuments: {
      label: "Recall Include Documents",
      advanced: true,
      help: "Include scanned document data in auto-recall results",
    },
    captureMaxChars: {
      label: "Capture Max Chars",
      help: "Maximum message length eligible for auto-capture",
      advanced: true,
      placeholder: String(DEFAULT_CAPTURE_MAX_CHARS),
    },
  },
};
