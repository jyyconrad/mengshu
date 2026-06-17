#!/usr/bin/env tsx
/**
 * mengshu 配置验证脚本
 *
 * 用途：在不真正启动服务的前提下，逐项诊断 ~/.mengshu/config.json 的常见配置问题，
 * 特别是 `${ENV_VAR}` 环境变量占位符未设置导致的 401 Invalid token 等连接失败。
 *
 * 检查项（按依赖顺序）：
 * 1. config 文件存在且可解析为 JSON
 * 2. 扫描所有 `${VAR}` 占位符，确认对应环境变量已设置（支持 ~/.mengshu/.env）
 * 3. API key 格式校验（embedding / llm）
 * 4. API 连接可用性（embedding 必测，llm 可选）
 *
 * 运行：
 *   tsx bin/validate-config.ts          # 完整检查（含联网探测）
 *   tsx bin/validate-config.ts --offline # 跳过联网探测，仅做静态检查
 *   tsx bin/validate-config.ts --json    # 以 JSON 输出结果（便于脚本消费）
 *
 * 退出码：0 = 全部通过 / 仅 warning；1 = 存在 fatal。
 */

import fs from "node:fs";
import path from "node:path";
import {
  resolveConfigPath,
  resolveEnvPath,
  resolveLegacyHomeDir,
  expandHome,
} from "../core/paths.js";

/** 单项检查结果。 */
export interface CheckResult {
  name: string;
  status: "ok" | "info" | "warning" | "fatal";
  message: string;
  /** 可选的修复建议（多行）。 */
  hint?: string;
}

const LEGACY_ENV_PATH = path.join(resolveLegacyHomeDir(), ".env");

/**
 * 解析 .env 文件并注入 process.env（已存在的键不覆盖）。
 * 与 bin/ms.ts 的 loadDotEnv 行为保持一致。
 */
export function loadDotEnv(envPath: string): void {
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

/** 在原始配置对象中递归查找所有 `${VAR}` 占位符，记录其字段路径与变量名。 */
export interface PlaceholderRef {
  /** 字段路径，如 "embedding.apiKey"。 */
  field: string;
  /** 引用的环境变量名，如 "SILICONFLOW_API_KEY"。 */
  envVar: string;
}

const PLACEHOLDER_RE = /\$\{([^}]+)\}/g;

export function collectPlaceholders(value: unknown, prefix = ""): PlaceholderRef[] {
  const refs: PlaceholderRef[] = [];
  if (typeof value === "string") {
    let match: RegExpExecArray | null;
    PLACEHOLDER_RE.lastIndex = 0;
    while ((match = PLACEHOLDER_RE.exec(value)) !== null) {
      refs.push({ field: prefix || "(root)", envVar: match[1] });
    }
    return refs;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      refs.push(...collectPlaceholders(item, `${prefix}[${i}]`));
    });
    return refs;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const next = prefix ? `${prefix}.${key}` : key;
      refs.push(...collectPlaceholders(child, next));
    }
  }
  return refs;
}

/** 检查 1：配置文件存在且可解析为 JSON 对象。返回解析后的原始对象或 null。 */
export function checkConfigFile(configPath: string): {
  result: CheckResult;
  raw: Record<string, unknown> | null;
} {
  const name = "config-file";
  if (!fs.existsSync(configPath)) {
    return {
      result: {
        name,
        status: "fatal",
        message: `配置文件不存在: ${configPath}`,
        hint: "运行 `ms`（不带参数）或 `ms init` 初始化配置。",
      },
      raw: null,
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        result: { name, status: "fatal", message: "配置文件不是合法的 JSON 对象" },
        raw: null,
      };
    }
    return {
      result: { name, status: "ok", message: `配置已加载: ${configPath}` },
      raw: parsed as Record<string, unknown>,
    };
  } catch (error) {
    return {
      result: {
        name,
        status: "fatal",
        message: `配置文件 JSON 解析失败: ${(error as Error).message}`,
        hint: "检查 config.json 是否存在多余逗号、未闭合的括号或引号。",
      },
      raw: null,
    };
  }
}

/** 检查 2：所有占位符引用的环境变量是否已设置。 */
export function checkEnvVars(raw: Record<string, unknown>, shellConfig: string): CheckResult[] {
  const refs = collectPlaceholders(raw);
  if (refs.length === 0) {
    return [
      {
        name: "env-vars",
        status: "info",
        message: "配置中未使用 ${VAR} 环境变量占位符（直接填写了字面值）",
      },
    ];
  }

  // 同一变量可能被多个字段引用，去重后逐个检查，但保留字段列表用于提示。
  const byVar = new Map<string, string[]>();
  for (const ref of refs) {
    const fields = byVar.get(ref.envVar) ?? [];
    fields.push(ref.field);
    byVar.set(ref.envVar, fields);
  }

  const results: CheckResult[] = [];
  for (const [envVar, fields] of byVar) {
    const present = typeof process.env[envVar] === "string" && process.env[envVar]!.length > 0;
    const fieldList = fields.join(", ");
    if (present) {
      results.push({
        name: `env:${envVar}`,
        status: "ok",
        message: `环境变量 ${envVar} 已设置（用于 ${fieldList}）`,
      });
    } else {
      results.push({
        name: `env:${envVar}`,
        status: "fatal",
        message: `环境变量 ${envVar} 未设置（被 ${fieldList} 引用）`,
        hint:
          `1. 编辑 Shell 配置文件：${shellConfig}\n` +
          `   或编辑 ${resolveEnvPath()}\n` +
          `2. 添加：export ${envVar}="你的真实密钥"\n` +
          `3. 重新加载：source ${shellConfig}\n` +
          `4. 重新运行本脚本验证`,
      });
    }
  }
  return results;
}

/**
 * 把原始配置中的 `${VAR}` 用 process.env 解析。
 * 与 config.ts 的 resolveEnvVars 行为一致，但缺失时返回 undefined 而非抛错，
 * 以便在缺失变量时仍能继续后续检查（不会因抛错而中断整个诊断）。
 */
export function tryResolve(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  let missing = false;
  const resolved = value.replace(PLACEHOLDER_RE, (_, envVar) => {
    const v = process.env[envVar];
    if (!v) {
      missing = true;
      return "";
    }
    return v;
  });
  return missing ? undefined : resolved;
}

/** 已知 provider 的 API key 前缀规则（用于格式预检，非强制）。 */
interface KeyRule {
  /** 命中 baseURL 关键字时适用。 */
  hostMatch: RegExp;
  /** key 应满足的前缀正则。 */
  keyPattern: RegExp;
  label: string;
}

const KEY_RULES: KeyRule[] = [
  { hostMatch: /siliconflow/i, keyPattern: /^sk-/, label: "SiliconFlow（应以 sk- 开头）" },
  { hostMatch: /deepseek/i, keyPattern: /^sk-/, label: "DeepSeek（应以 sk- 开头）" },
  { hostMatch: /openai\.com/i, keyPattern: /^sk-/, label: "OpenAI（应以 sk- 开头）" },
  { hostMatch: /dashscope|aliyun/i, keyPattern: /^sk-/, label: "通义/DashScope（应以 sk- 开头）" },
];

/** 检查 3：API key 格式预检。无法解析（缺变量）时跳过。 */
export function checkKeyFormat(
  label: string,
  apiKey: string | undefined,
  baseURL: string | undefined,
): CheckResult {
  const name = `key-format:${label}`;
  if (apiKey === undefined) {
    return {
      name,
      status: "warning",
      message: `${label} 的 apiKey 无法解析（环境变量缺失），跳过格式检查`,
    };
  }
  if (apiKey.trim().length === 0) {
    return { name, status: "fatal", message: `${label} 的 apiKey 解析后为空字符串` };
  }
  // 常见误填：把占位符当字面值、含空格、含引号
  if (apiKey.includes("${")) {
    return {
      name,
      status: "fatal",
      message: `${label} 的 apiKey 仍含未解析的占位符: ${apiKey}`,
    };
  }
  if (/\s/.test(apiKey)) {
    return { name, status: "warning", message: `${label} 的 apiKey 含空白字符，可能复制错误` };
  }
  // provider 前缀规则
  if (baseURL) {
    for (const rule of KEY_RULES) {
      if (rule.hostMatch.test(baseURL)) {
        if (!rule.keyPattern.test(apiKey)) {
          return {
            name,
            status: "warning",
            message: `${label} 的 apiKey 不符合 ${rule.label} 的格式预期`,
          };
        }
        return {
          name,
          status: "ok",
          message: `${label} 的 apiKey 格式符合 ${rule.label}`,
        };
      }
    }
  }
  return { name, status: "ok", message: `${label} 的 apiKey 已设置（长度 ${apiKey.length}）` };
}

/** 检查 4a：embedding 端点连接可用性。 */
export async function checkEmbeddingConnection(
  apiKey: string | undefined,
  baseURL: string | undefined,
  model: string,
): Promise<CheckResult> {
  const name = "embedding-connection";
  if (!apiKey || !baseURL) {
    return {
      name,
      status: "warning",
      message: "embedding apiKey/baseURL 无法解析，跳过连接检查",
    };
  }
  const url = joinUrl(baseURL, "/embeddings");
  try {
    const resp = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, input: "mengshu connection test" }),
    });
    return await classifyHttp(name, resp, "embedding", model);
  } catch (error) {
    return {
      name,
      status: "fatal",
      message: `embedding 连接失败: ${(error as Error).message}`,
      hint: `检查网络、baseURL 是否正确: ${baseURL}`,
    };
  }
}

/** 检查 4b：llm chat 端点连接可用性（仅当配置了 llm）。 */
export async function checkLlmConnection(
  apiKey: string | undefined,
  baseURL: string | undefined,
  model: string,
): Promise<CheckResult> {
  const name = "llm-connection";
  if (!apiKey || !baseURL) {
    return { name, status: "warning", message: "llm apiKey/baseURL 无法解析，跳过连接检查" };
  }
  const url = joinUrl(baseURL, "/chat/completions");
  try {
    const resp = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
    });
    return await classifyHttp(name, resp, "llm", model);
  } catch (error) {
    return {
      name,
      status: "fatal",
      message: `llm 连接失败: ${(error as Error).message}`,
      hint: `检查网络、baseURL 是否正确: ${baseURL}`,
    };
  }
}

/** 根据 HTTP 状态码归类结果。401/403 -> fatal，余额不足单独提示，404 -> warning，2xx -> ok。 */
async function classifyHttp(
  name: string,
  resp: Response,
  kind: string,
  model: string,
): Promise<CheckResult> {
  if (resp.ok) {
    return { name, status: "ok", message: `${kind} 服务可达（model=${model}, HTTP ${resp.status}）` };
  }

  // 读取响应体，提取服务商业务错误（如 SiliconFlow 余额不足 code 30001），
  // 避免把"余额不足"笼统报成"Invalid token"误导用户去排查密钥。
  let bodyCode: number | undefined;
  let bodyMessage = "";
  try {
    const raw = await resp.text();
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { code?: number; message?: string };
        bodyCode = typeof parsed.code === "number" ? parsed.code : undefined;
        bodyMessage = typeof parsed.message === "string" ? parsed.message : raw;
      } catch {
        bodyMessage = raw;
      }
    }
  } catch {
    // 读取失败时退回到状态码判断。
  }

  const looksLikeBalance =
    bodyCode === 30001 || /balance|insufficient|余额|欠费|arrears/i.test(bodyMessage);

  if ((resp.status === 403 || resp.status === 402) && looksLikeBalance) {
    return {
      name,
      status: "fatal",
      message: `${kind} 账户余额不足（HTTP ${resp.status}${bodyCode != null ? ` code ${bodyCode}` : ""}）`,
      hint: `API key 有效但账户额度不足。请前往服务商控制台充值或更换有额度的密钥。原始信息：${bodyMessage || "(无)"}`,
    };
  }

  if (resp.status === 401 || resp.status === 403) {
    return {
      name,
      status: "fatal",
      message: `${kind} 鉴权失败（HTTP ${resp.status}${bodyMessage ? `: ${bodyMessage}` : ""}）`,
      hint: "API key 无效或已过期。确认环境变量值为真实密钥，且与 baseURL 对应的服务商匹配。",
    };
  }
  if (resp.status === 404) {
    return {
      name,
      status: "warning",
      message: `${kind} 端点 404，可能是 baseURL 或 model 名不正确（model=${model}）`,
    };
  }
  if (resp.status === 429) {
    return { name, status: "warning", message: `${kind} 触发限流（HTTP 429），密钥有效但请求过于频繁` };
  }
  return { name, status: "warning", message: `${kind} 返回 HTTP ${resp.status}${bodyMessage ? `: ${bodyMessage}` : ""}` };
}

/** 拼接 baseURL 与路径，处理结尾斜杠，避免重复 /v1。 */
function joinUrl(baseURL: string, suffix: string): string {
  const base = baseURL.replace(/\/+$/, "");
  return `${base}${suffix}`;
}

/** 带超时的 fetch（默认 10s）。 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 10_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

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

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function optString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** 运行全部检查，返回结果数组。可被测试单独调用。 */
export async function runValidation(options: {
  configPath?: string;
  offline?: boolean;
} = {}): Promise<CheckResult[]> {
  const configPath = options.configPath ?? resolveConfigPath();
  const shellConfig = getShellConfigFile();
  const results: CheckResult[] = [];

  // 加载 .env（与 ms 命令行行为一致），便于检测通过 .env 提供的变量
  const envPath = resolveEnvPath();
  if (fs.existsSync(envPath)) {
    loadDotEnv(envPath);
  } else if (fs.existsSync(LEGACY_ENV_PATH)) {
    loadDotEnv(LEGACY_ENV_PATH);
  }

  // 检查 1：配置文件
  const { result: fileResult, raw } = checkConfigFile(configPath);
  results.push(fileResult);
  if (!raw) {
    return results;
  }

  // 检查 2：环境变量占位符
  results.push(...checkEnvVars(raw, shellConfig));

  // 解析 embedding / llm 配置（容错，不抛错）
  const embedding = asRecord(raw.embedding);
  const llm = raw.llm ? asRecord(raw.llm) : undefined;

  const embApiKey = tryResolve(embedding.apiKey);
  const embBaseURL = tryResolve(embedding.baseURL);
  const embModel = optString(embedding.model) ?? "text-embedding-3-small";

  // 检查 3：key 格式
  results.push(checkKeyFormat("embedding", embApiKey, embBaseURL));
  if (llm) {
    const llmApiKey = tryResolve(llm.apiKey);
    const llmBaseURL = tryResolve(llm.baseURL);
    results.push(checkKeyFormat("llm", llmApiKey, llmBaseURL));
  }

  // 检查 4：连接（可跳过）
  if (options.offline) {
    results.push({
      name: "connection",
      status: "info",
      message: "已启用 --offline，跳过 API 连接探测",
    });
    return results;
  }

  results.push(await checkEmbeddingConnection(embApiKey, embBaseURL, embModel));
  if (llm) {
    const llmApiKey = tryResolve(llm.apiKey);
    const llmBaseURL = tryResolve(llm.baseURL);
    const llmModel = optString(llm.model) ?? "(unknown)";
    results.push(await checkLlmConnection(llmApiKey, llmBaseURL, llmModel));
  }

  return results;
}

const STATUS_ICON: Record<CheckResult["status"], string> = {
  ok: "[OK]",
  info: "[..]",
  warning: "[!!]",
  fatal: "[XX]",
};

/** 打印人类可读的结果汇总，返回是否存在 fatal。 */
export function printResults(results: CheckResult[]): boolean {
  let hasFatal = false;
  console.log("\nmengshu 配置诊断结果\n" + "=".repeat(40));
  for (const r of results) {
    if (r.status === "fatal") {
      hasFatal = true;
    }
    console.log(`${STATUS_ICON[r.status]} ${r.name}: ${r.message}`);
    if (r.hint) {
      const indented = r.hint
        .split("\n")
        .map((line) => `       ${line}`)
        .join("\n");
      console.log(indented);
    }
  }
  console.log("=".repeat(40));
  const fatals = results.filter((r) => r.status === "fatal").length;
  const warns = results.filter((r) => r.status === "warning").length;
  if (hasFatal) {
    console.log(`诊断失败：${fatals} 个致命问题，${warns} 个警告。请按上方 hint 修复后重试。`);
  } else if (warns > 0) {
    console.log(`诊断通过（含 ${warns} 个警告）。配置可用，但建议关注警告项。`);
  } else {
    console.log("诊断全部通过，配置可用。");
  }
  return hasFatal;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const offline = argv.includes("--offline");
  const asJson = argv.includes("--json");

  const results = await runValidation({ offline });

  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
    const hasFatal = results.some((r) => r.status === "fatal");
    process.exit(hasFatal ? 1 : 0);
  }

  const hasFatal = printResults(results);
  process.exit(hasFatal ? 1 : 0);
}

// 仅在直接执行时运行 main（被 import 时不执行），便于单元测试。
const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]).includes("validate-config");
if (isDirectRun) {
  main().catch((error) => {
    console.error(`验证脚本异常: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exit(1);
  });
}
