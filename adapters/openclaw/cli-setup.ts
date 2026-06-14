/**
 * mengshu 交互式初始化向导。
 *
 * 本文件做什么：提供 `ms init` 的交互式引导流程，逐步收集用户配置并写入
 * `~/.mengshu/config.json` 和项目 `.mengshu.json`。
 *
 * 核心流程：
 * 1. 检测全局配置是否已存在（~/.mengshu/config.json）
 * 2. 若不存在，引导用户完成 embedding 配置（API provider / key / model）
 * 3. 可选配置 LLM、存储类型
 * 4. 写入全局配置
 * 5. 初始化项目工作空间（.mengshu.json）
 *
 * 关键边界：
 * - 使用 Node.js 内置 readline，不引入额外依赖
 * - 敏感信息（API key）建议写入 .env 而非 config.json 明文
 * - 已有配置时默认跳过全局设置，只做项目初始化
 */

import fs from "node:fs";
import path from "node:path";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { resolveHomeDir, resolveConfigPath, resolveEnvPath, expandHome } from "../../core/paths.js";

// Embedding provider 预设
const EMBEDDING_PROVIDERS: ReadonlyArray<{ name: string; baseURL: string; models: string[]; envKey: string }> = [
  { name: "OpenAI", baseURL: "https://api.openai.com/v1", models: ["text-embedding-3-small", "text-embedding-3-large", "text-embedding-ada-002"], envKey: "OPENAI_API_KEY" },
  { name: "Azure OpenAI", baseURL: "https://{resource}.openai.azure.com/openai/deployments/{deployment}", models: ["text-embedding-3-small", "text-embedding-3-large"], envKey: "AZURE_OPENAI_API_KEY" },
  { name: "Ollama (本地)", baseURL: "http://localhost:11434/v1", models: ["nomic-embed-text", "mxbai-embed-large", "all-minilm"], envKey: "" },
  { name: "自定义 (OpenAI-compatible)", baseURL: "", models: [], envKey: "" },
];

const DB_TYPES = [
  { name: "LanceDB (本地，推荐)", value: "lancedb" },
  { name: "PostgreSQL (pgvector)", value: "postgres" },
  { name: "Supabase (云端)", value: "supabase" },
] as const;

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
  // 默认选第一个
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

async function setupEmbedding(rl: ReadlineInterface): Promise<{ apiKey: string; baseURL: string; model: string; envKey: string }> {
  console.log("\n── Embedding 配置 ──────────────────────────────────");
  console.log("梦枢需要一个 embedding 服务来进行记忆的向量化存储和检索。\n");

  const providerIndex = await askChoice(rl, "选择 Embedding 服务商：", EMBEDDING_PROVIDERS);
  const provider = EMBEDDING_PROVIDERS[providerIndex];

  let baseURL = provider.baseURL;
  if (providerIndex === 3 || !baseURL) {
    // 自定义 provider
    baseURL = await ask(rl, "请输入 API Base URL: ");
    if (!baseURL) {
      throw new Error("Base URL 不能为空");
    }
  } else if (baseURL.includes("{resource}")) {
    // Azure 需要填写资源名
    const resource = await ask(rl, "Azure 资源名 (resource name): ");
    const deployment = await ask(rl, "Azure 部署名 (deployment name): ");
    baseURL = baseURL.replace("{resource}", resource).replace("{deployment}", deployment);
  }

  // 选择 model
  let model: string;
  if (provider.models.length > 0) {
    console.log("\n可用模型：");
    for (let i = 0; i < provider.models.length; i++) {
      console.log(`  ${i + 1}. ${provider.models[i]}${i === 0 ? " (推荐)" : ""}`);
    }
    const modelAnswer = await ask(rl, `选择模型 [1-${provider.models.length}] 或输入自定义模型名: `);
    const modelIndex = parseInt(modelAnswer, 10) - 1;
    if (modelIndex >= 0 && modelIndex < provider.models.length) {
      model = provider.models[modelIndex]!;
    } else if (modelAnswer) {
      model = modelAnswer;
    } else {
      model = provider.models[0]!;
    }
  } else {
    model = await askWithDefault(rl, "Embedding 模型名", "text-embedding-3-small");
  }

  // API Key
  let apiKey = "";
  if (providerIndex === 2) {
    // Ollama 不需要 key
    apiKey = "ollama";
    console.log("\nOllama 本地模式，无需 API Key。");
  } else {
    console.log("\nAPI Key 将存储在 ~/.mengshu/.env 文件中（不明文写入 config.json）。");
    apiKey = await ask(rl, "请输入 API Key: ");
    if (!apiKey) {
      throw new Error("API Key 不能为空");
    }
  }

  const envKey = provider.envKey || "MENGSHU_EMBEDDING_API_KEY";

  return { apiKey, baseURL, model, envKey };
}

async function setupDatabase(rl: ReadlineInterface): Promise<{ dbType: string; dbPath?: string }> {
  console.log("\n── 存储配置 ────────────────────────────────────────");

  const dbIndex = await askChoice(rl, "选择存储方式：", DB_TYPES);
  const dbType = DB_TYPES[dbIndex].value;

  if (dbType === "lancedb") {
    const dbPath = await askWithDefault(rl, "数据存储路径", "~/.mengshu/memory/lancedb");
    return { dbType, dbPath };
  }

  return { dbType };
}

async function setupLLM(rl: ReadlineInterface): Promise<{ apiKey: string; model: string; baseURL?: string; envKey: string } | null> {
  console.log("\n── LLM 配置（可选）────────────────────────────────");
  console.log("LLM 用于记忆分类、自动摘要等高级功能。不配置也能正常使用基础功能。\n");

  const wantLLM = await askYesNo(rl, "是否配置 LLM？", false);
  if (!wantLLM) return null;

  const baseURL = await askWithDefault(rl, "LLM API Base URL", "https://api.openai.com/v1");
  const model = await askWithDefault(rl, "LLM 模型名", "gpt-4o-mini");
  const apiKey = await ask(rl, "LLM API Key (留空则复用 embedding key): ");

  return {
    apiKey: apiKey || "",
    model,
    baseURL,
    envKey: "MENGSHU_LLM_API_KEY",
  };
}

export async function runInteractiveSetup(): Promise<SetupResult> {
  const homeDir = resolveHomeDir();
  const configPath = resolveConfigPath();
  const envPath = resolveEnvPath();

  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║          梦枢 Mengshu - 初始化向导                  ║");
  console.log("║  本地优先的用户工作上下文中枢                       ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log(`\n配置目录: ${homeDir}`);

  // 检查是否已有配置
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
    // 1. Embedding 配置
    const embedding = await setupEmbedding(rl);

    // 2. 存储配置
    const database = await setupDatabase(rl);

    // 3. LLM 配置（可选）
    const llm = await setupLLM(rl);

    // 4. 确认
    console.log("\n── 配置预览 ────────────────────────────────────────");
    console.log(`  Embedding: ${embedding.baseURL}`);
    console.log(`  Model:     ${embedding.model}`);
    console.log(`  Storage:   ${database.dbType}${database.dbPath ? ` (${database.dbPath})` : ""}`);
    if (llm) {
      console.log(`  LLM:       ${llm.model} @ ${llm.baseURL}`);
    }
    console.log(`  Config:    ${configPath}`);
    console.log(`  Env:       ${envPath}`);

    const confirm = await askYesNo(rl, "\n确认写入？", true);
    if (!confirm) {
      console.log("已取消。");
      return { configWritten: false, envWritten: false, configPath, envPath };
    }

    // 5. 写入配置
    ensureDir(homeDir);

    // 构建 config.json（API key 用环境变量引用）
    const config: Record<string, unknown> = {
      embedding: {
        apiKey: `\${${embedding.envKey}}`,
        baseURL: embedding.baseURL,
        model: embedding.model,
      },
      dbType: database.dbType,
    };
    if (database.dbPath) {
      config.dbPath = database.dbPath;
    }
    if (llm) {
      config.llm = {
        apiKey: llm.apiKey ? `\${${llm.envKey}}` : `\${${embedding.envKey}}`,
        model: llm.model,
        baseURL: llm.baseURL,
      };
    }

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");

    // 构建 .env
    const envLines: string[] = [
      "# Mengshu environment variables",
      `${embedding.envKey}=${embedding.apiKey}`,
    ];
    if (llm?.apiKey) {
      envLines.push(`${llm.envKey}=${llm.apiKey}`);
    }
    fs.writeFileSync(envPath, envLines.join("\n") + "\n", "utf8");

    console.log("\n✓ 配置已写入:");
    console.log(`  ${configPath}`);
    console.log(`  ${envPath}`);
    console.log("\n下一步：");
    console.log("  1. 在项目目录运行 `ms init` 初始化项目工作空间");
    console.log("  2. 运行 `ms doctor` 验证配置是否正确");
    console.log("  3. 运行 `ms search \"test\"` 测试搜索功能");

    return { configWritten: true, envWritten: true, configPath, envPath };
  } finally {
    rl.close();
  }
}

/**
 * 检查全局配置是否就绪，未就绪时引导用户完成设置。
 * 返回 true 表示配置已就绪（已存在或刚完成设置）。
 */
export function isGlobalConfigReady(options?: import("../../core/paths.js").HomePathOptions): boolean {
  const configPath = resolveConfigPath(options);
  return fs.existsSync(configPath);
}
