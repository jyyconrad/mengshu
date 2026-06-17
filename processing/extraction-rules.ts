/**
 * extraction-rules.ts — 抽取阶段的固化词表与规则（P0-a）
 *
 * 用途：集中维护"系统侧确定性规则"所需的正则词表与白名单，作为唯一事实来源，
 * 同时被以下两处消费（避免各处内联重复、漂移）：
 *   - valueScore 的风险惩罚（命中风险词表 → 写 riskFlags，影响打分，§4.7）
 *   - deterministic validator（§3.1 闸门 8 的 prompt_injection 标记）
 *   - crossContextual 系统侧交叉验证（§3.2，覆盖 LLM 的主观判断）
 *
 * 设计依据：
 *   - §3.2  5 type 准入基准 + crossContextual 算法 + STABILITY/EPISODIC 词表
 *   - §3.3  profile 6 维白名单
 *   - §4.7  RiskFlags 消费链（prompt_injection 不执行）
 *
 * D-14 sensitive 单一事实来源：敏感信息检测统一由 lifecycle/sensitive-filter.ts
 * 的 detectSensitive 提供（详细分类 personality/health/political/religious/
 * sexual_orientation/PII，严格口径），本文件不再维护 SENSITIVE_PATTERNS 简化版，
 * 避免双轨并存导致的"健康饮食"等误命中。
 *
 * 注意：这些词表是系统内部治理用，不暴露给最终用户。词表按"中文 + 英文"分组，
 * 便于后续按语言扩展而不影响调用方。
 */

/**
 * 稳定性信号词：命中表示偏好/约束跨情境成立（强证据 → crossContextual=true）。
 * 为什么按语言拆两条：中文整词无词边界，英文需 \b 词边界 + 大小写不敏感，
 * 合并会导致英文部分误命中（如 "always" 出现在子串中）。
 */
export const STABILITY_PATTERNS: readonly RegExp[] = [
  /总是|从不|必须|禁止|默认|以后都|每次/,
  /\balways\b|\bnever\b|\bmust\b|\bdo not\b/i,
] as const;

/**
 * 情景标记词：命中表示属于一次性/当下情景（→ crossContextual=false）。
 * 反向覆盖优先级高于 STABILITY（见 reconcileCrossContextual 的判定顺序）。
 */
export const EPISODIC_PATTERNS: readonly RegExp[] = [
  /刚才|这次|当时|今天|昨天|这个 bug|这次任务/,
  /\bjust now\b|\bthis time\b|\btoday\b/i,
] as const;

/**
 * profile 6 维白名单（§3.3）：profile 只承载"工作协作偏好"，
 * 任何不在此列表内的 profileDimension 都不允许入 profile 候选。
 * 含义对照见 §3.3 表（language/response_style/.../domain_focus）。
 */
export const PROFILE_WHITELIST_DIMENSIONS = [
  "language",
  "response_style",
  "verification_preference",
  "planning_preference",
  "risk_boundary",
  "domain_focus",
] as const;

/** profile 白名单维度的联合类型，供调用方做编译期约束。 */
export type ProfileWhitelistDimension =
  (typeof PROFILE_WHITELIST_DIMENSIONS)[number];

/**
 * 敏感信息检测：统一由 lifecycle/sensitive-filter.ts 的 detectSensitive 提供（D-14）。
 * 本文件不再导出 SENSITIVE_PATTERNS——双轨并存且口径不一致是质量 P0-1 的根因，
 * 此处保留这条注释作为"单一事实来源"的入口指引。
 */

/**
 * prompt injection 模式（§3.1 闸门 8）：命中 → riskFlags=["prompt_injection"]，
 * 不执行任何指令，降级为 evidence-only（§4.7）。
 * 覆盖"忽略之前指令""你现在是""system:"等典型控制/越权话术。
 */
export const PROMPT_INJECTION_PATTERNS: readonly RegExp[] = [
  /忽略(之前|前面|上面|以上).{0,4}(的)?指令/,
  /你现在是|从现在起你/,
  /\bignore\s+(all|any|previous|prior|above)(\s+(?:previous|prior|above))?\s+(instructions|prompts?)\b/i,
  /\byou\s+are\s+now\b/i,
  /(^|\n|\s)system\s*[:：]/i,
  /忘记(你)?(之前|以上|所有)的?(设定|指令|规则)/,
] as const;

/**
 * crossContextual 系统侧交叉验证（§3.2）。
 *
 * 判定顺序严格照设计代码：
 *   1. 以 llmHint（LLM 主观 crossContextual，缺省 false）为初值
 *   2. STABILITY 命中 → 置 true（强证据覆盖）
 *   3. EPISODIC 命中 → 置 false（情景标记反向覆盖，优先级最高）
 *
 * 为什么 EPISODIC 后判：当一句话同时含稳定性词与情景词（如 "today I must fix"），
 * 设计意图是判定为非跨情境（一次性动作），故 EPISODIC 覆盖在 STABILITY 之后。
 *
 * @param text 候选文本
 * @param llmHint LLM 给出的 crossContextual 主观判断，缺省视为 false
 * @returns 系统裁定的 crossContextual 布尔值
 */
export const reconcileCrossContextual = (
  text: string,
  llmHint?: boolean
): boolean => {
  let result = llmHint ?? false;

  if (STABILITY_PATTERNS.some((p) => p.test(text))) result = true;
  if (EPISODIC_PATTERNS.some((p) => p.test(text))) result = false;

  return result;
};
