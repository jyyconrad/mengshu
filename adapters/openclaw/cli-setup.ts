/**
 * mengshu 交互式初始化向导。
 *
 * 本文件做什么：提供 `ms init` / `ms setup` 的交互式引导流程，逐步收集用户配置
 * 并写入 `~/.mengshu/config.json` 和 `~/.mengshu/.env`。
 *
 * 核心流程：
 * 1. 检测全局配置是否已存在
 * 2. 引导用户完成 Embedding 配置（服务商 / key / model）
 * 3. 引导用户完成 LLM 配置（必选，记忆树构建依赖 LLM 生成实体和关系三元组）
 * 4. 配置存储类型
 * 5. 写入配置文件
 *
 * 关键边界：
 * - 使用 Node.js 内置 readline，不引入额外依赖
 * - 敏感信息（API key）写入 .env 而非 config.json 明文
 * - 已有配置时默认跳过，可通过 ms setup 重新配置
 */

import fs from "node:fs";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { resolveHomeDir, resolveConfigPath, resolveEnvPath } from "../../core/paths.js";

// ─── Provider 预设 ──────────────────────────────────────────────────────────

interface ProviderPreset {
  name: string;
  baseURL: string;
  models: string[];
  envKey: string;
  needsKey: boolean;
}

const EMBEDDING_PROVIDERS: ReadonlyArray<ProviderPreset> = [
  // 国际
  { name: "OpenAI", baseURL: "https://api.openai.com/v1", models: ["text-embedding-3-small", "text-embedding-3-large", "text-embedding-ada-002"], envKey: "OPENAI_API_KEY", needsKey: true },
  { name: "Azure OpenAI", baseURL: "https://{resource}.openai.azure.com/openai/deployments/{deployment}", models: ["text-embedding-3-small", "text-embedding-3-large"], envKey: "AZURE_OPENAI_API_KEY", needsKey: true },
  // 国产
  { name: "智谱 AI (Zhipu)", baseURL: "https://open.bigmodel.cn/api/paas/v4", models: ["embedding-3", "embedding-2"], envKey: "ZHIPU_API_KEY", needsKey: true },
  { name: "通义千问 (DashScope)", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", models: ["text-embedding-v3", "text-embedding-v2", "text-embedding-v1"], envKey: "DASHSCOPE_API_KEY", needsKey: true },
  { name: "百川 AI (Baichuan)", baseURL: "https://api.baichuan-ai.com/v1", models: ["Baichuan-Text-Embedding"], envKey: "BAICHUAN_API_KEY", needsKey: true },
  { name: "月之暗面 (Moonshot)", baseURL: "https://api.moonshot.cn/v1", models: ["moonshot-v1-embedding"], envKey: "MOONSHOT_API_KEY", needsKey: true },
  { name: "深度求索 (DeepSeek)", baseURL: "https://api.deepseek.com/v1", models: ["deepseek-embedding"], envKey: "DEEPSEEK_API_KEY", needsKey: true },
  { name: "零一万物 (Yi)", baseURL: "https://api.lingyiwanwu.com/v1", models: ["yi-embedding"], envKey: "YI_API_KEY", needsKey: true },
  { name: "硅基流动 (SiliconFlow)", baseURL: "https://api.siliconflow.cn/v1", models: ["BAAI/bge-m3", "BAAI/bge-large-zh-v1.5", "Pro/BAAI/bge-m3"], envKey: "SILICONFLOW_API_KEY", needsKey: true },
  { name: "火山引擎 (Volcengine/豆包)", baseURL: "https://ark.cn-beijing.volces.com/api/v3", models: ["doubao-embedding", "doubao-embedding-large"], envKey: "VOLCENGINE_API_KEY", needsKey: true },
  // 本地
  { name: "Ollama (本地)", baseURL: "http://localhost:11434/v1", models: ["nomic-embed-text", "mxbai-embed-large", "bge-m3", "all-minilm"], envKey: "", needsKey: false },
  // 自定义
  { name: "自定义 (OpenAI-compatible)", baseURL: "", models: [], envKey: "", needsKey: true },
];

const LLM_PROVIDERS: ReadonlyArray<ProviderPreset> = [
  // 国际
  { name: "OpenAI", baseURL: "https://api.openai.com/v1", models: ["gpt-4o-mini", "gpt-4o", "gpt-4-turbo", "gpt-3.5-turbo"], envKey: "OPENAI_API_KEY", needsKey: true },
  { name: "Anthropic (Claude)", baseURL: "https://api.anthropic.com/v1", models: ["claude-sonnet-4-6", "claude-haiku-4-5-20251001", "claude-opus-4-8"], envKey: "ANTHROPIC_API_KEY", needsKey: true },
  { name: "Azure OpenAI", baseURL: "https://{resource}.openai.azure.com/openai/deployments/{deployment}", models: ["gpt-4o-mini", "gpt-4o"], envKey: "AZURE_OPENAI_API_KEY", needsKey: true },
  // 国产
  { name: "智谱 AI (Zhipu)", baseURL: "https://open.bigmodel.cn/api/paas/v4", models: ["glm-4-flash", "glm-4", "glm-4-plus", "glm-4-long"], envKey: "ZHIPU_API_KEY", needsKey: true },
  { name: "通义千问 (DashScope)", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", models: ["qwen-turbo", "qwen-plus", "qwen-max", "qwen-long"], envKey: "DASHSCOPE_API_KEY", needsKey: true },
  { name: "百川 AI (Baichuan)", baseURL: "https://api.baichuan-ai.com/v1", models: ["Baichuan4", "Baichuan3-Turbo", "Baichuan3-Turbo-128k"], envKey: "BAICHUAN_API_KEY", needsKey: true },
  { name: "月之暗面 (Moonshot)", baseURL: "https://api.moonshot.cn/v1", models: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"], envKey: "MOONSHOT_API_KEY", needsKey: true },
  { name: "深度求索 (DeepSeek)", baseURL: "https://api.deepseek.com/v1", models: ["deepseek-chat", "deepseek-reasoner"], envKey: "DEEPSEEK_API_KEY", needsKey: true },
  { name: "零一万物 (Yi)", baseURL: "https://api.lingyiwanwu.com/v1", models: ["yi-lightning", "yi-large", "yi-large-turbo"], envKey: "YI_API_KEY", needsKey: true },
  { name: "硅基流动 (SiliconFlow)", baseURL: "https://api.siliconflow.cn/v1", models: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-72B-Instruct", "Pro/deepseek-ai/DeepSeek-V3"], envKey: "SILICONFLOW_API_KEY", needsKey: true },
  { name: "火山引擎 (Volcengine/豆包)", baseURL: "https://ark.cn-beijing.volces.com/api/v3", models: ["doubao-pro-32k", "doubao-pro-128k", "doubao-lite-32k"], envKey: "VOLCENGINE_API_KEY", needsKey: true },
  { name: "讯飞星火 (SparkDesk)", baseURL: "https://spark-api-open.xf-yun.com/v1", models: ["generalv3.5", "4.0Ultra", "generalv3"], envKey: "SPARK_API_KEY", needsKey: true },
  { name: "MiniMax", baseURL: "https://api.minimax.chat/v1", models: ["abab6.5s-chat", "abab6.5-chat", "abab5.5-chat"], envKey: "MINIMAX_API_KEY", needsKey: true },
  // 本地
  { name: "Ollama (本地)", baseURL: "http://localhost:11434/v1", models: ["qwen2.5:7b", "llama3.1:8b", "deepseek-r1:8b", "gemma2:9b"], envKey: "", needsKey: false },
  // 自定义
  { name: "自定义 (OpenAI-compatible)", baseURL: "", models: [], envKey: "", needsKey: true },
];

const DB_TYPES = [
  { name: "LanceDB (本地，推荐)", value: "lancedb" },
  { name: "PostgreSQL (pgvector)", value: "postgres" },
  { name: "Supabase (云端)", value: "supabase" },
] as const;

// ─── 交互工具函数 ────────────────────────────────────────────────────────────

interface SetupResult {
  configWritten: boolean;
  envWritten: boolean;
  configPath: string;
  envPath: string;
}

function createReadline(): ReadlineInterface {
  return createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function ask(rl: ReadlineInterface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function askWithDefault(rl: ReadlineInterface, question: string, defaultValue: string): Promise<string> {
  const answer = await ask(rl, `${question} [${defaultValue}]: `);
  return answer || defaultValue;
}

async function askChoice(rl: ReadlineInterface, question: string, options: ReadonlyArray<{ name: string }>): Promise<number> {
  console.log(`\n${question}`);
  for (let i = 0; i < options.length; i++) {
    console.log(`  ${i + 1}. ${options[i].name}`);
  }
  const answer = await ask(rl, `请选择 [1-${options.length}]: `);
  const index = parseInt(answer, 10) - 1;
  if (index >= 0 && index < options.length) {
    return index;
  }
  return 0;
}

async function askYesNo(rl: ReadlineInterface, question: string, defaultYes: boolean = true): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = await ask(rl, `${question} ${hint}: `);
  if (!answer) return defaultYes;
  return answer.toLowerCase().startsWith("y");
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

async function selectModel(rl: ReadlineInterface, models: string[]): Promise<string> {
  if (models.length === 0) {
    return await ask(rl, "请输入模型名: ");
  }
  console.log("\n可用模型：");
  for (let i = 0; i < models.length; i++) {
    console.log(`  ${i + 1}. ${models[i]}${i === 0 ? " (推荐)" : ""}`);
  }
  const answer = await ask(rl, `选择模型 [1-${models.length}] 或输入自定义模型名: `);
  const index = parseInt(answer, 10) - 1;
  if (index >= 0 && index < models.length) {
    return models[index]!;
  }
  return answer || models[0]!;
}

// ─── 各阶段配置 ─────────────────────────────────────────────────────────────

interface ProviderSetupResult {
  apiKey: string;
  baseURL: string;
  model: string;
  envKey: string;
}

async function setupProvider(
  rl: ReadlineInterface,
  title: string,
  description: string,
  providers: ReadonlyArray<ProviderPreset>,
  defaultEnvKey: string,
): Promise<ProviderSetupResult> {
  console.log(`\n── ${title} ──────────────────────────────────────────`);
  console.log(`${description}\n`);

  const providerIndex = await askChoice(rl, `选择${title}服务商：`, providers);
  const provider = providers[providerIndex]!;

  let baseURL = provider.baseURL;
  const isCustom = providerIndex === providers.length - 1;

  if (isCustom || !baseURL) {
    baseURL = await ask(rl, "请输入 API Base URL: ");
    if (!baseURL) {
      throw new Error("Base URL 不能为空");
    }
  } else if (baseURL.includes("{resource}")) {
    const resource = await ask(rl, "Azure 资源名 (resource name): ");
    const deployment = await ask(rl, "Azure 部署名 (deployment name): ");
    baseURL = baseURL.replace("{resource}", resource).replace("{deployment}", deployment);
  }

  const model = await selectModel(rl, provider.models);

  let apiKey = "";
  if (!provider.needsKey) {
    apiKey = "local";
    console.log("\n本地模式，无需 API Key。");
  } else {
    console.log("\nAPI Key 将存储在 ~/.mengshu/.env 文件中（不明文写入 config.json）。");
    apiKey = await ask(rl, "请输入 API Key: ");
    if (!apiKey) {
      throw new Error("API Key 不能为空");
    }
  }

  const envKey = provider.envKey || defaultEnvKey;
  return { apiKey, baseURL, model, envKey };
}

async function setupDatabase(rl: ReadlineInterface): Promise<{ dbType: string; dbPath?: string }> {
  console.log("\n── 存储配置 ────────────────────────────────────────");

  const dbIndex = await askChoice(rl, "选择向量存储方式：", DB_TYPES);
  const dbType = DB_TYPES[dbIndex].value;

  if (dbType === "lancedb") {
    const dbPath = await askWithDefault(rl, "数据存储路径", "~/.mengshu/memory/lancedb");
    return { dbType, dbPath };
  }

  return { dbType };
}

// ─── 主流程 ─────────────────────────────────────────────────────────────────

export async function runInteractiveSetup(): Promise<SetupResult> {
  const homeDir = resolveHomeDir();
  const configPath = resolveConfigPath();
  const envPath = resolveEnvPath();

  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║          梦枢 Mengshu - 初始化向导                  ║");
  console.log("║  本地优先的用户工作上下文中枢                       ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log(`\n配置目录: ${homeDir}`);

  if (fs.existsSync(configPath)) {
    console.log(`\n检测到已有配置: ${configPath}`);
    const rl = createReadline();
    const overwrite = await askYesNo(rl, "是否重新配置？", false);
    if (!overwrite) {
      rl.close();
      console.log("\n保留现有配置，跳过全局设置。");
      return { configWritten: false, envWritten: false, configPath, envPath };
    }
    rl.close();
  }

  const rl = createReadline();

  try {
    // 1. Embedding
    const embedding = await setupProvider(
      rl,
      "Embedding 配置",
      "梦枢需要一个 embedding 服务来进行记忆的向量化存储和检索。",
      EMBEDDING_PROVIDERS,
      "MENGSHU_EMBEDDING_API_KEY",
    );

    // 2. LLM（必选）
    console.log("\n提示：LLM 是必需的，梦枢使用 LLM 来构建记忆树（生成实体、关系三元组）。");
    const llmSameAsEmbedding = embedding.envKey && embedding.baseURL.includes("openai")
      ? await askYesNo(rl, "LLM 是否使用与 Embedding 相同的服务商？", false)
      : false;

    let llm: ProviderSetupResult;
    if (llmSameAsEmbedding) {
      const model = await selectModel(rl, ["gpt-4o-mini", "gpt-4o", "gpt-4-turbo"]);
      llm = { apiKey: embedding.apiKey, baseURL: embedding.baseURL, model, envKey: embedding.envKey };
    } else {
      llm = await setupProvider(
        rl,
        "LLM 配置",
        "LLM 用于记忆树构建（实体抽取、关系推理、三元组生成）和记忆分类。",
        LLM_PROVIDERS,
        "MENGSHU_LLM_API_KEY",
      );
    }

    // 3. 存储
    const database = await setupDatabase(rl);

    // 4. 预览确认
    console.log("\n── 配置预览 ────────────────────────────────────────");
    console.log(`  Embedding:  ${embedding.model} @ ${embedding.baseURL}`);
    console.log(`  LLM:        ${llm.model} @ ${llm.baseURL}`);
    console.log(`  Storage:    ${database.dbType}${database.dbPath ? ` (${database.dbPath})` : ""}`);
    console.log(`  Config:     ${configPath}`);
    console.log(`  Env:        ${envPath}`);

    const confirm = await askYesNo(rl, "\n确认写入？", true);
    if (!confirm) {
      console.log("已取消。");
      return { configWritten: false, envWritten: false, configPath, envPath };
    }

    // 5. 写入
    ensureDir(homeDir);

    // config.json（key 用环境变量引用）
    const config: Record<string, unknown> = {
      embedding: {
        apiKey: `\${${embedding.envKey}}`,
        baseURL: embedding.baseURL,
        model: embedding.model,
      },
      llm: {
        apiKey: llm.envKey === embedding.envKey ? `\${${embedding.envKey}}` : `\${${llm.envKey}}`,
        baseURL: llm.baseURL,
        model: llm.model,
      },
      dbType: database.dbType,
    };
    if (database.dbPath) {
      config.dbPath = database.dbPath;
    }

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");

    // .env
    const envEntries = new Map<string, string>();
    if (embedding.apiKey && embedding.apiKey !== "local") {
      envEntries.set(embedding.envKey, embedding.apiKey);
    }
    if (llm.apiKey && llm.apiKey !== "local" && llm.envKey !== embedding.envKey) {
      envEntries.set(llm.envKey, llm.apiKey);
    }

    const envLines: string[] = ["# Mengshu environment variables"];
    for (const [key, value] of envEntries) {
      envLines.push(`${key}=${value}`);
    }
    fs.writeFileSync(envPath, envLines.join("\n") + "\n", "utf8");

    console.log("\n✓ 配置已写入:");
    console.log(`  ${configPath}`);
    console.log(`  ${envPath}`);
    console.log("\n下一步：");
    console.log("  1. 在项目目录运行 `ms init` 初始化项目工作空间");
    console.log("  2. 运行 `ms doctor` 验证连接是否正常");
    console.log("  3. 运行 `ms search \"test\"` 测试搜索功能");

    return { configWritten: true, envWritten: true, configPath, envPath };
  } finally {
    rl.close();
  }
}

/**
 * 检查全局配置是否就绪。
 * 返回 true 表示配置文件已存在。
 */
export function isGlobalConfigReady(options?: import("../../core/paths.js").HomePathOptions): boolean {
  const configPath = resolveConfigPath(options);
  return fs.existsSync(configPath);
}
