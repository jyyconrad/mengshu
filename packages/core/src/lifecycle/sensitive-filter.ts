/**
 * sensitive-filter 敏感个人属性黑名单
 *
 * 本文件做什么：
 *   对抽取器（extractor）输入的文本做敏感属性检测，拦截人格标签、健康状况、
 *   政治立场、宗教信仰、性取向五类敏感个人属性，使其不进入候选区（Candidate
 *   Zone）和 Durable Memory。依据 plan §5.1.3 safety + RISK-15。
 *
 * 核心流程：
 *   detectSensitive(text) 遍历 SENSITIVE_PATTERNS，逐类正则匹配，命中即记录类别
 *   与匹配片段；isSensitive(text) 是布尔便捷封装。检测在 extractor 入口调用，
 *   命中则直接返回空候选。
 *
 * 关键边界（隐私安全底线）：
 *   过滤敏感属性 = 隐私安全底线。这些属性属于个人最私密信息，一旦写入长期记忆
 *   会被反复注入上下文，造成画像化、歧视性推断等隐私风险，故必须在源头拦截。
 *
 *   工作偏好 vs 人格标签的分界：
 *   - 合法 profile（不拦截）：工作风格、沟通偏好，如「我偏好简洁回答」「先给结论
 *     再给计划」「我喜欢用 TypeScript」—— 这些描述协作方式，是有用的工作上下文。
 *   - 敏感人格标签（拦截）：MBTI、内向/外向等对「人本身」的性格特质断言，如
 *     「我是 INFJ」「我是个内向的人」—— 这是对人格的分类，属敏感个人属性。
 *
 *   设计取向：宁可漏过工作偏好，也不能误伤敏感属性误判为合法 —— 即正则只针对
 *   明确的人格/健康/政治/宗教/性取向断言，不覆盖泛化的「喜欢/偏好」工作表达。
 */

/**
 * 敏感属性类别
 */
export type SensitiveCategory =
  | "personality"
  | "health"
  | "political"
  | "religious"
  | "sexual_orientation";

/**
 * 敏感检测结果
 */
export interface SensitiveDetection {
  /** 是否命中任一敏感类别 */
  sensitive: boolean;
  /** 命中的敏感类别（去重） */
  categories: SensitiveCategory[];
  /** 命中的原始文本片段（用于审计/调试） */
  matched: string[];
}

/**
 * 各敏感类别的中英文正则集合。
 *
 * 设计原则：
 * - 只匹配明确的「敏感属性断言」，避免泛化关键词导致误伤工作偏好。
 * - personality 仅覆盖 MBTI 与「内向/外向 + 人」这类人格特质断言，
 *   不包含「我偏好/我喜欢」等工作风格表达。
 */
const SENSITIVE_PATTERNS: ReadonlyArray<{
  category: SensitiveCategory;
  patterns: ReadonlyArray<RegExp>;
}> = [
  {
    category: "personality",
    patterns: [
      // MBTI 四字母类型，如 INFJ / ENTP（要求落在词边界，避免误伤普通大写词）
      /\b[IE][NS][FT][JP]\b/i,
      // 中文：性格/人格/性格类型 + 内向/外向/敏感等特质断言
      /(性格|人格)(类型|特质|是|很|比较|偏)?[内外][向倾]/,
      /我(是|属于)?(一个|个)?(很|比较|超级|非常)?(内向|外向)(的)?(人|性格|型)/,
      // 英文：I am (an) introvert/extrovert，或人格特质断言
      /\bi\s*('?m|am)\s+(an?\s+)?(introvert|extrovert|introverted|extroverted)\b/i,
      /\bmy\s+personality\s+type\b/i,
    ],
  },
  {
    category: "health",
    patterns: [
      // 中文：患有/确诊/诊断 + 疾病，常见心理健康状况
      /(患有|确诊|诊断(出|为)?|得了)/,
      /(抑郁症|焦虑症|双相|精神分裂|癌症|糖尿病|高血压|艾滋|HIV|残疾)/i,
      // 中文：正在服用/用药
      /(我|正在|长期)(服用|吃)(药|抗抑郁|降压|胰岛素)/,
      // 英文：diagnosed with / suffer from / on medication
      /\bdiagnosed\s+with\b/i,
      /\b(suffer|suffering)\s+from\b/i,
      /\bon\s+(antidepressants|medication\s+for)\b/i,
    ],
  },
  {
    category: "political",
    patterns: [
      // 中文：支持/反对/加入 + 党 / 政治立场
      /(支持|反对|加入|拥护)[^\s，。]{0,6}党/,
      /(政治立场|党派|党员|左派|右派|保守派|自由派)/,
      // 英文：政治立场标签 / 投票倾向
      /\bi\s*('?m|am)\s+(a\s+)?(liberal|conservative|socialist|communist|libertarian)\b/i,
      /\bvote\s+(democrat|republican|labour|tory)\b/i,
    ],
  },
  {
    category: "religious",
    patterns: [
      // 中文：信仰/信奉 + 宗教，或是某教教徒
      /(信仰|信奉|皈依)/,
      /(基督教|天主教|伊斯兰教|佛教|道教|犹太教|印度教|穆斯林|教徒)/,
      // 英文：i am a christian/muslim/buddhist 等
      /\bi\s*('?m|am)\s+(a\s+)?(christian|muslim|buddhist|hindu|jewish|catholic|atheist)\b/i,
      /\bmy\s+(religion|faith)\s+is\b/i,
    ],
  },
  {
    category: "sexual_orientation",
    patterns: [
      // 中文：性取向标签
      /(性取向|同性恋|异性恋|双性恋|跨性别|酷儿)/,
      // 英文：性取向标签（要求明确自述，避免误伤如 "happy/straightforward"）
      /\bi\s*('?m|am)\s+(gay|lesbian|bisexual|bi|straight|queer|transgender|trans)\b/i,
      /\bmy\s+sexual\s+orientation\b/i,
    ],
  },
];

/**
 * 检测文本是否命中敏感属性。
 *
 * @param text 待检测文本
 * @returns 检测结果，含命中类别与匹配片段
 */
export function detectSensitive(text: string): SensitiveDetection {
  const input = typeof text === "string" ? text.trim() : "";
  if (input.length === 0) {
    return { sensitive: false, categories: [], matched: [] };
  }

  const categories: SensitiveCategory[] = [];
  const matched: string[] = [];

  for (const group of SENSITIVE_PATTERNS) {
    let groupHit = false;
    for (const pattern of group.patterns) {
      const m = input.match(pattern);
      if (m) {
        groupHit = true;
        matched.push(m[0]);
      }
    }
    if (groupHit) {
      categories.push(group.category);
    }
  }

  return {
    sensitive: categories.length > 0,
    categories,
    matched,
  };
}

/**
 * 便捷布尔判断：文本是否命中任一敏感属性。
 *
 * @param text 待检测文本
 * @returns 命中返回 true
 */
export function isSensitive(text: string): boolean {
  return detectSensitive(text).sensitive;
}
