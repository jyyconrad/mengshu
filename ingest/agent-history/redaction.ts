/**
 * secret redaction —— 历史日志写入前的密钥脱敏（方案 §11.3-11.4）。
 *
 * 本文件做什么：在任何历史文本进入 chunk / embedding / LLM 之前，把 API key、
 * token、私钥、env 形式的密钥赋值、Bearer 授权头等替换为 `[REDACTED:<category>]`
 * 占位符，避免敏感凭据被写入长期记忆或发往远端 provider。
 *
 * 与 lifecycle/sensitive-filter.ts 的分工：
 * - sensitive-filter 拦截"个人敏感属性"（人格/健康/政治/宗教/性取向），命中即丢弃整段。
 * - 本文件处理"机器凭据/密钥"，命中只替换片段、保留其余文本，因为日志仍有工作价值。
 *
 * 关键边界：
 * - 设计取向：宁可漏脱敏一些低风险值，也尽量不误伤普通工作文本和常见枚举（NODE_ENV 等）。
 *   因此 env 赋值只在 key 名含 secret/token/key/password 等强信号、且值足够长时才脱敏。
 * - 纯函数、无 I/O、无第三方依赖，确保 adapter 热路径可高频调用。
 */

/** 脱敏命中的类别。 */
export type RedactionCategory =
  | "api_key"
  | "token"
  | "private_key"
  | "auth_header"
  | "env_secret";

export interface RedactionResult {
  /** 脱敏后的文本。 */
  text: string;
  /** 命中并替换的片段总数。 */
  redactedCount: number;
  /** 命中的类别（去重，保持首次出现顺序）。 */
  categories: RedactionCategory[];
}

interface RedactionRule {
  category: RedactionCategory;
  pattern: RegExp;
  /**
   * 替换函数：返回脱敏后的字符串。默认整段替换为占位符；
   * 对 env / auth_header 这类"前缀=值"结构，只替换值部分以保留可读性。
   */
  replace?: (match: string, ...groups: string[]) => string;
}

const PLACEHOLDER = (category: RedactionCategory): string => `[REDACTED:${category}]`;

/**
 * 规则顺序很重要：私钥块、授权头等"结构化强信号"优先于宽泛的 token 规则，
 * 避免被后者切碎。所有 pattern 使用全局标志以统计多次命中。
 */
const RULES: ReadonlyArray<RedactionRule> = [
  // PEM 私钥块（含 RSA/EC/OPENSSH/PGP 等）。
  {
    category: "private_key",
    pattern: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
  },
  // Authorization: Bearer <token> 请求头（只替换 token 部分）。
  {
    category: "auth_header",
    pattern: /(Authorization:\s*Bearer\s+)([A-Za-z0-9._\-]{16,})/gi,
    replace: (_m, prefix) => `${prefix}${PLACEHOLDER("auth_header")}`,
  },
  // OpenAI / Anthropic 风格 key：sk-... / sk-ant-...
  {
    category: "api_key",
    pattern: /\bsk-(?:ant-)?[A-Za-z0-9_\-]{20,}\b/g,
  },
  // GitHub token：ghp_/gho_/ghu_/ghs_/ghr_ + 36 位（早期固定 36，新版可能更长）。
  {
    category: "token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  },
  // Slack token：xox[baprs]-...
  {
    category: "token",
    pattern: /\bxox[baprs]-[A-Za-z0-9\-]{10,}\b/g,
  },
  // AWS Access Key Id：AKIA + 16 位大写字母数字。
  {
    category: "token",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  // env / 配置赋值：仅当 key 名含强密钥信号且值足够长时脱敏（避免误伤 NODE_ENV=production）。
  {
    category: "env_secret",
    pattern:
      /\b([A-Z0-9_]*(?:SECRET|TOKEN|API[_]?KEY|PASSWORD|PASSWD|PRIVATE[_]?KEY|ACCESS[_]?KEY|CLIENT[_]?SECRET)[A-Z0-9_]*)\s*[=:]\s*["']?([^\s"']{8,})["']?/gi,
    replace: (_m, key) => `${key}=${PLACEHOLDER("env_secret")}`,
  },
];

/**
 * 对文本做 secret 脱敏。
 * 多条规则依次套用；每条规则的全局匹配次数累加进 redactedCount。
 */
export function redactSecrets(input: string): RedactionResult {
  if (!input) {
    return { text: "", redactedCount: 0, categories: [] };
  }

  let text = input;
  let redactedCount = 0;
  const categories: RedactionCategory[] = [];

  for (const rule of RULES) {
    // 先统计命中次数（用一份独立的 regex 避免 lastIndex 干扰 replace）。
    const counter = new RegExp(rule.pattern.source, rule.pattern.flags);
    const matches = text.match(counter);
    const hitCount = matches ? matches.length : 0;
    if (hitCount === 0) {
      continue;
    }

    redactedCount += hitCount;
    if (!categories.includes(rule.category)) {
      categories.push(rule.category);
    }

    const replacer = rule.replace;
    const placeholder = PLACEHOLDER(rule.category);
    const replaceFn: (match: string, ...args: unknown[]) => string = replacer
      ? (match, ...groups) => replacer(match, ...(groups as string[]))
      : () => placeholder;
    text = text.replace(
      new RegExp(rule.pattern.source, rule.pattern.flags),
      replaceFn,
    );
  }

  return { text, redactedCount, categories };
}
