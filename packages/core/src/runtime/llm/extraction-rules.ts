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

/**
 * 离线 deterministic extractor 的语义信号。它只识别可解释的语言结构，不改写
 * 原文；candidate text/evidence 仍由调用方绑定到真实 source event。
 *
 * 这些规则是 LLM 不可用时的保守后备，而不是词典式全文总结器：每个信号都要求
 * “用途/约束/阶段/因果”等结构，避免仅因出现工具名或文件扩展名就过捕获。
 */
export interface DeterministicCandidateSignal {
  readonly semanticType: "profile" | "rules" | "experience" | "task_context" | "resource";
  readonly reason: string;
  readonly confidence: number;
  readonly profileDimension?: ProfileWhitelistDimension;
  readonly persistent?: boolean;
  readonly crossContextual?: boolean;
  readonly hasWhy?: boolean;
  readonly hasOutcome?: boolean;
}

const PROFILE_SIGNAL_PATTERNS: ReadonlyArray<
  readonly [ProfileWhitelistDimension, readonly RegExp[]]
> = [
  ["language", [
    /(?:交流|回答|文档|代码注释).{0,16}(?:中文|英文)|(?:中文|英文).{0,12}(?:交流|回答|code review|代码注释)/i,
    /\b(?:please\s+)?respond\s+in\s+(?:english|chinese)\b/i,
  ]],
  ["verification_preference", [
    /(?:复杂操作|复杂任务|删除文件|提交|schema\s*变更|数据库.{0,8}变更).{0,20}(?:先看|核对|确认|审核|测试)/i,
    /每次(?:都|会).{0,8}(?:测试|忘记写单元测试)/,
  ]],
  ["planning_preference", [
    /简单任务.{0,16}(?:跳过计划|直接实现)/,
  ]],
  ["risk_boundary", [
    /(?:删除文件|schema\s*变更|数据库.{0,8}变更).{0,20}(?:必须|不要|确认|审核|自动\s*push)/i,
  ]],
  ["response_style", [
    /(?:我(?:一般)?(?:喜欢|偏好|倾向)|每次回答|回答).{0,24}(?:结论|详细|简洁|寒暄|选项|格式)/,
    /记住.{0,8}(?:vim|emacs|编辑器).{0,4}(?:模式|mode)?/i,
  ]],
  ["domain_focus", [
    /我主要做.{2,40}|我(?:专注|主要从事).{2,40}/,
  ]],
] as const;

const RULE_SIGNAL_PATTERNS: readonly RegExp[] = [
  /禁止|不要|不能|永远不|从不|总是|默认|以后都|必须/,
  /\b(?:always|never|must(?:\s+not)?|do\s+not|don't)\b/i,
  /如果.{0,24}(?:就|则).{0,12}(?:禁用|禁止|必须)/,
  /(?:团队|项目).{0,12}(?:编码|提交|开发).{0,8}规范(?:包括|要求)?/,
] as const;

const EXPERIENCE_SIGNAL_PATTERNS: readonly RegExp[] = [
  /因为|由于|导致|否则|踩(?:了)?坑|教训|回退到|有\s*bug/i,
  /(?:改用|换成|切换到).{1,40}(?:后|之后).{1,40}(?:提升|减少|稳定|成功|快|小)/,
  /(?:试过|尝试|用了).{1,50}(?:更|比|快|慢|简单|稳定|确实)/,
  /\b(?:switched|changed)\s+to\b.{0,80}\bbecause\b|\bbecause\b.{0,80}\b(?:slow|failed|error)\b/i,
  /(?:可以考虑|建议)用.{2,50}/,
  /(?:刚才|昨天).{1,40}(?:好用|尝试|验证|确实)/,
] as const;

const TASK_CONTEXT_SIGNAL_PATTERNS: readonly RegExp[] = [
  /(?:这个|当前|本次|这次)?项目.{0,10}(?:目标|范围|要在).{1,40}/,
  /当前.{0,12}(?:阶段|进度|状态)|(?:阶段|进度|状态).{0,8}(?:开发|测试|完成)/,
  /(?:这次|当前|本次)?任务(?:是|为|用).{1,40}/,
  /(?:本周|本月|今天).{0,12}(?:优先|必须完成|完成)/,
  /(?:MVP|里程碑).{0,16}(?:月底|上线|完成)/i,
  /等.{1,40}(?:完成|就绪)后才能.{1,40}/,
  /(?:还没|未完成|没写).{0,16}(?:阻塞|blocked)|(?:暂时|当前).{0,8}阻塞/i,
  /这个文件用.{1,24}(?:格式化|处理)/,
  /遗留代码.{0,20}(?:重构|暂时不动)/,
  /\b(?:beta|alpha)\s+release\b.{0,30}\b(?:next|this)\s+(?:month|week)\b/i,
] as const;

const RESOURCE_SIGNAL_PATTERNS: readonly RegExp[] = [
  /(?:文档|配置文件|架构设计|部署脚本|环境变量).{0,8}(?:在|位于)\s*(?:https?:\/\/|[./\w-])\S*/i,
  /(?:启动|运行|测试).{0,12}(?:命令|用|with)\s+(?:npm|pnpm|yarn|bun|npx)\s+\S+/i,
  /\brun\s+tests?\s+with\s+(?:npm|pnpm|yarn|bun)\s+\S+/i,
  /(?:接口|API).{0,12}(?:GET|POST|PUT|PATCH|DELETE)\s+\/\S*/i,
  /用\s*[A-Za-z][\w.-]*\s*(?:跑单元测试|监控错误)|认证用\s*[A-Za-z][\w.-]*/i,
  /项目用\s+(?:pnpm\s+workspace|[A-Za-z][\w.-]*\s*\+\s*[A-Za-z][\w.-]*)/i,
] as const;

function firstProfileSignal(text: string): DeterministicCandidateSignal | undefined {
  for (const [profileDimension, patterns] of PROFILE_SIGNAL_PATTERNS) {
    if (patterns.some((pattern) => pattern.test(text))) {
      return {
        semanticType: "profile",
        profileDimension,
        reason: `deterministic_profile_${profileDimension}`,
        confidence: 0.82,
        persistent: true,
        crossContextual: true,
      };
    }
  }
  return undefined;
}

/**
 * 从一条真实 source event 识别 0..N 个独立语义信号。同一输入可同时产生例如
 * resource + rules；profile 仅在明确的协作维度内成立。
 */
export function inferDeterministicCandidateSignals(
  rawText: string,
): readonly DeterministicCandidateSignal[] {
  const text = rawText.trim();
  if (text.length < 5) return [];

  const signals: DeterministicCandidateSignal[] = [];
  const profile = firstProfileSignal(text);
  if (profile) signals.push(profile);

  const taskContext = TASK_CONTEXT_SIGNAL_PATTERNS.some((pattern) => pattern.test(text));
  if (taskContext) {
    signals.push({
      semanticType: "task_context",
      reason: "deterministic_task_context",
      confidence: 0.8,
      hasOutcome: /完成|通过|上线|阻塞|planned|release/i.test(text),
    });
  }

  const experience = EXPERIENCE_SIGNAL_PATTERNS.some((pattern) => pattern.test(text));
  if (experience && !taskContext) {
    signals.push({
      semanticType: "experience",
      reason: "deterministic_experience",
      confidence: 0.8,
      hasWhy: /因为|由于|导致|否则|because|failed|bug|踩(?:了)?坑/i.test(text),
      hasOutcome: /提升|减少|快|慢|简单|稳定|成功|失败|崩溃|报错|教训|回退|好用/i.test(text),
    });
  }

  const resource = RESOURCE_SIGNAL_PATTERNS.some((pattern) => pattern.test(text));
  if (resource) {
    signals.push({
      semanticType: "resource",
      reason: "deterministic_resource",
      confidence: 0.78,
      // 命中这里已要求明确用途/位置/命令；它是可复用资源而非偶发提及。
      persistent: true,
    });
  }

  const episodic = EPISODIC_PATTERNS.some((pattern) => pattern.test(text));
  const explicitProjectRuleAlongsideProfile =
    profile !== undefined && /项目(?:里|中).{0,16}(?:禁止|必须|不要)/.test(text);
  const rules = RULE_SIGNAL_PATTERNS.some((pattern) => pattern.test(text));
  if (
    rules &&
    !episodic &&
    (!profile || explicitProjectRuleAlongsideProfile) &&
    !experience
  ) {
    signals.push({
      semanticType: "rules",
      reason: "deterministic_rules",
      confidence: 0.86,
      persistent: true,
      crossContextual: true,
    });
  }

  return signals;
}
