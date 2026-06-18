/**
 * candidate-validator.ts — 候选区 deterministic 校验器（P0-a，§3.1）
 *
 * 本文件实现 §3.1「候选接受/拒绝总表」的 11 条顺序判定闸门，是铁律
 * 「LLM 可以建议、不可裁决；所有入库经 validator」的确定性落地：
 * LLM 只产出原始候选信号（RawCandidate），最终是否入库、以何种形态入库，
 * 全部由本文件用可复现规则裁定，不依赖任何 LLM 主观输出做终判。
 *
 * 11 条闸门按顺序判定（任一「拒绝」命中即丢弃；「降级」命中保留但调整字段）：
 *   1  structured-output schema —— API 层强制；此处仅断言关键结构存在
 *   2  evidence 真实性 —— quote 必须在源文本内（char-bigram 含量 >= 0.9）、eventIds 子集
 *   3  text 长度下限 —— 去空白 >= 8 字符
 *   4  salience 下限 —— >= MIN_SALIENCE（0.3）
 *   5  semanticType 准入门槛 —— 必须在 5 type 枚举内
 *   6  profile 白名单 —— profileDimension 必须在 PROFILE_WHITELIST_DIMENSIONS
 *   7  敏感信息标记 —— 命中 detectSensitive（sensitive-filter 单一事实来源）：不拒绝，追加 riskFlags=["sensitive"]
 *   8  prompt injection —— 命中 PROMPT_INJECTION_PATTERNS：标 prompt_injection、降级 evidence-only
 *   9  泛词过滤 —— 纯泛词降级 evidence-only（简化启发式，不误拒详细内容）
 *   10 时效一致性 —— reconcileCrossContextual 校准后，ephemeral 不得与 rules/profile 共存
 *   11 scope 不超界 —— targetScope 不得宽于 source.scope，超界则收窄
 *
 * 注意：现有 graph/extraction-validator.ts 针对 entity/relation（8 条），本文件不改它；
 * 这里是 §17.1 约定的「candidate validator」独立落地，服务 memory candidate。
 *
 * 设计唯一事实来源：docs/04-design/04.2-detail/memory-system-unified-design.md §3.1。
 */

import type { MemorySemanticType } from "../domain/types.js";
import {
  PROFILE_WHITELIST_DIMENSIONS,
  PROMPT_INJECTION_PATTERNS,
  reconcileCrossContextual,
} from "../runtime/llm/extraction-rules.js";
// D-14 sensitive 单一事实来源：sensitive-filter.ts 是详细分类版（personality/health/
// political/religious/sexual_orientation），口径严格（如 health 要求"患有/确诊/诊断"前缀），
// 不会把"健康饮食"误标 sensitive。闸门 7 复用其判定，避免 extraction-rules 简化版的双轨漂移。
import { detectSensitive } from "./sensitive-filter.js";

/** salience 准入下限（§3.1 闸门 4，默认 0.3）。 */
export const MIN_SALIENCE = 0.3 as const;

/** evidence quote 在源文本中的 char-bigram 含量阈值（§3.1 闸门 2）。 */
export const EVIDENCE_FUZZY_THRESHOLD = 0.9 as const;

/** text 去空白后的最小字符数（§3.1 闸门 3）。 */
export const MIN_TEXT_LENGTH = 8 as const;

/** 泛词过滤的文本长度下限（§3.1 闸门 9，简化启发式）。 */
const GENERIC_MIN_LENGTH = 10 as const;

/**
 * scope 层级（由窄到宽，6 档单调递增，遵循设计 D-04 §0.3.1/§2.6）。
 * 闸门 11 用其序判定 targetScope 是否宽于 source.scope。
 *
 * 6 档语义：
 *   - session    最窄：单次会话内有效
 *   - project    项目级：单个项目内有效
 *   - workspace  工作区级：项目集合（如同一仓库下多子项目）
 *   - app        应用级：单设备内的同一应用
 *   - user       用户级：跨设备同账号
 *   - global     最宽：全局共享
 */
export type ScopeLevel =
  | "session"
  | "project"
  | "workspace"
  | "app"
  | "user"
  | "global";

const SCOPE_RANK: Readonly<Record<ScopeLevel, number>> = {
  session: 0,
  project: 1,
  workspace: 2,
  app: 3,
  user: 4,
  global: 5,
};

/** 时效性（§2.3 schema 字段）。 */
export type Temporality = "ephemeral" | "persistent";

/** evidence 块（§2.2 structured output）。 */
export interface CandidateEvidence {
  /** 原文引用，必须可在源文本内定位（闸门 2）。 */
  quote: string;
  /** 引用的事件 id，必须是源事件 id 子集（闸门 2）。 */
  eventIds?: readonly string[];
}

/**
 * RawCandidate：LLM 输出、未经 validator 裁决的原始候选。
 * 所有字段都是「建议值」，validator 可在 2-11 闸门中校准或拒绝。
 */
export interface RawCandidate {
  text: string;
  semanticType?: MemorySemanticType;
  salience: number;
  temporality: Temporality;
  /** LLM 主观给出的跨情境判断，闸门 10 用 reconcileCrossContextual 覆盖。 */
  crossContextual?: boolean;
  /** 候选期望写入的 scope，闸门 11 收窄到 source.scope。 */
  targetScope: ScopeLevel;
  /** semanticType=profile 时必填，闸门 6 校验白名单。 */
  profileDimension?: string;
  evidence: CandidateEvidence;
}

/**
 * CandidateSource：抽取请求上下文（§3.1 伪代码中的 ExtractionRequest 简化）。
 * validator 用它做 evidence 溯源与 scope 收窄。
 */
export interface CandidateSource {
  /** 抽取所基于的源文本，闸门 2 的 quote 必须在此内。 */
  text: string;
  /** 来源 scope 上界，闸门 11 不允许 targetScope 超过它。 */
  scope: ScopeLevel;
  /** 源事件 id 全集，闸门 2 校验 eventIds 子集关系。 */
  eventIds?: readonly string[];
}

/** 候选风险标记（闸门 2/7/8 追加）。 */
export type CandidateRiskFlag = "low_evidence" | "sensitive" | "prompt_injection";

/** 拒绝原因联合类型（闸门 1-6 的硬拒绝）。 */
export type RejectReason =
  | "schema_invalid"
  | "evidence_not_in_source"
  | "event_id_not_in_source"
  | "text_too_short"
  | "salience_below_min"
  | "unknown_semantic_type"
  | "profile_dimension_not_whitelisted";

/**
 * ValidatedCandidate：通过全部硬闸门、经 7-11 校准后的候选。
 * rejected 恒为 false；字段为 validator 裁定后的最终值（含降级/收窄结果）。
 */
export interface ValidatedCandidate {
  rejected: false;
  text: string;
  semanticType: MemorySemanticType;
  salience: number;
  temporality: Temporality;
  /** reconcileCrossContextual 校准后的系统裁定值（闸门 10）。 */
  crossContextual: boolean;
  /** 收窄后的最终 scope（闸门 11）。 */
  targetScope: ScopeLevel;
  profileDimension?: string;
  evidence: CandidateEvidence;
  /** 闸门 2/7/8 追加的风险标记（去重）。 */
  riskFlags: CandidateRiskFlag[];
  /** 闸门 8/9 命中后降级：仅作为证据保留，不作为可执行偏好/规则。 */
  evidenceOnly: boolean;
}

/** 拒绝结果（携带原因，闸门 2 额外携带 riskFlags 供 audit）。 */
export interface RejectedCandidate {
  rejected: true;
  reason: RejectReason;
  riskFlags?: CandidateRiskFlag[];
}

const SEMANTIC_TYPES: readonly MemorySemanticType[] = [
  "profile",
  "task_context",
  "rules",
  "experience",
  "resource",
];

const PROFILE_WHITELIST: ReadonlySet<string> = new Set(
  PROFILE_WHITELIST_DIMENSIONS,
);

/** 具体指代标记：拉丁标识符/命令、数值、路径、文件扩展名（闸门 9）。 */
const CONCRETE_MARKERS: readonly RegExp[] = [
  /[A-Za-z]{2,}/,
  /\d/,
  /[\\/][\w.-]+/,
  /\.[A-Za-z]{1,6}\b/,
];

/** normalize：小写化并去除所有空白，供 fuzzyContains 比对（§3.1 闸门 2）。 */
const normalize = (s: string): string => s.toLowerCase().replace(/\s+/g, "");

/** 生成 char-bigram 集合（长度 < 2 时返回空集，由调用方退化到子串判定）。 */
const charBigrams = (s: string): Set<string> => {
  const grams = new Set<string>();
  for (let i = 0; i < s.length - 1; i += 1) {
    grams.add(s.slice(i, i + 2));
  }
  return grams;
};

/**
 * fuzzyContains：判断 quote 是否「实质包含」于 source（§3.1 闸门 2）。
 *
 * 判定（normalize 后）：
 *   1. 直接子串命中 → true（最常见、最强证据）
 *   2. 否则计算 quote 的 char-bigram 在 source 中的含量（overlap coefficient，
 *      分母为 quote 的 bigram 数），>= threshold 视为命中。
 * 用 quote 侧含量而非全局 Jaccard：源文本通常远长于引用，全局 Jaccard 必然偏低，
 * 含量更贴合「引用是否来自源」的语义。
 *
 * @param source 源文本
 * @param quote LLM 给出的原文引用
 * @param threshold char-bigram 含量阈值，默认 0.9
 */
export const fuzzyContains = (
  source: string,
  quote: string,
  threshold: number = EVIDENCE_FUZZY_THRESHOLD,
): boolean => {
  if (!quote || quote.trim().length === 0) return false;

  const normalizedSource = normalize(source);
  const normalizedQuote = normalize(quote);
  if (normalizedQuote.length === 0) return false;

  if (normalizedSource.includes(normalizedQuote)) return true;
  if (normalizedQuote.length < 2) return false;

  const quoteGrams = charBigrams(normalizedQuote);
  const sourceGrams = charBigrams(normalizedSource);
  if (quoteGrams.size === 0) return false;

  let shared = 0;
  for (const gram of quoteGrams) {
    if (sourceGrams.has(gram)) shared += 1;
  }
  return shared / quoteGrams.size >= threshold;
};

/** 闸门 1：断言关键 structured-output 结构存在（不重复 API 层全检）。 */
const hasValidSchema = (c: RawCandidate): boolean => {
  return (
    typeof c?.text === "string" &&
    typeof c?.salience === "number" &&
    typeof c?.evidence === "object" &&
    c.evidence !== null &&
    typeof c.evidence.quote === "string"
  );
};

/** 闸门 2：eventIds 必须是 source.eventIds 子集（无 eventIds 时视为通过）。 */
const eventIdsSubsetOf = (
  candidate: readonly string[] | undefined,
  source: readonly string[] | undefined,
): boolean => {
  if (!candidate || candidate.length === 0) return true;
  const allowed = new Set(source ?? []);
  return candidate.every((id) => allowed.has(id));
};

/** 闸门 9：判断是否为纯泛词（长度不足或缺少具体指代）。 */
const isGenericText = (text: string): boolean => {
  const trimmed = text.trim();
  if (trimmed.length < GENERIC_MIN_LENGTH) return true;
  return !CONCRETE_MARKERS.some((p) => p.test(trimmed));
};

const reject = (
  reason: RejectReason,
  riskFlags?: CandidateRiskFlag[],
): RejectedCandidate => ({ rejected: true, reason, riskFlags });

/**
 * validateCandidate：按 §3.1 的 11 条顺序闸门裁决一条候选。
 *
 * @param c 未校验的原始候选（LLM 输出）
 * @param source 抽取请求上下文（源文本、scope 上界、事件全集）
 * @returns 通过则返回归一化后的 ValidatedCandidate；任一硬闸门命中则返回 RejectedCandidate
 */
export function validateCandidate(
  c: RawCandidate,
  source: CandidateSource,
): ValidatedCandidate | RejectedCandidate {
  // 闸门 1：structured-output schema 结构存在性
  if (!hasValidSchema(c)) {
    return reject("schema_invalid");
  }

  // 闸门 2：evidence 真实性（quote 在源 + eventIds 子集）
  if (!fuzzyContains(source.text, c.evidence.quote, EVIDENCE_FUZZY_THRESHOLD)) {
    return reject("evidence_not_in_source", ["low_evidence"]);
  }
  if (!eventIdsSubsetOf(c.evidence.eventIds, source.eventIds)) {
    return reject("event_id_not_in_source", ["low_evidence"]);
  }

  // 闸门 3：text 长度下限（去空白 >= 8）
  if (c.text.replace(/\s+/g, "").length < MIN_TEXT_LENGTH) {
    return reject("text_too_short");
  }

  // 闸门 4：salience 下限
  if (c.salience < MIN_SALIENCE) {
    return reject("salience_below_min");
  }

  // 闸门 5：semanticType 在 5 type 枚举内（基础准入，细分门槛由权重体现）
  if (!c.semanticType || !SEMANTIC_TYPES.includes(c.semanticType)) {
    return reject("unknown_semantic_type");
  }

  // 闸门 6：profile 白名单
  if (c.semanticType === "profile") {
    if (!c.profileDimension || !PROFILE_WHITELIST.has(c.profileDimension)) {
      return reject("profile_dimension_not_whitelisted");
    }
  }

  // 以下为「降级/校准」闸门：不拒绝，逐步构造最终字段（保持输入不可变）
  const riskFlags: CandidateRiskFlag[] = [];
  let evidenceOnly = false;

  // 闸门 7：敏感信息标记（D-14：复用 sensitive-filter 单一事实来源，不拒绝，仅追加 sensitive）
  const sensitiveDetection = detectSensitive(c.text);
  if (sensitiveDetection.sensitive) {
    riskFlags.push("sensitive");
  }

  // 闸门 8：prompt injection（标记 + 降级 evidence-only，不执行任何指令）
  if (PROMPT_INJECTION_PATTERNS.some((p) => p.test(c.text))) {
    riskFlags.push("prompt_injection");
    evidenceOnly = true;
  }

  // 闸门 9：泛词过滤（纯泛词降级 evidence-only）
  if (isGenericText(c.text)) {
    evidenceOnly = true;
  }

  // 闸门 10：时效一致性。先用 reconcileCrossContextual 校准跨情境，
  // 再修正 ephemeral 与 rules/profile 的冲突。
  const reconciled = reconcileCrossContextual(c.text, c.crossContextual);
  let semanticType: MemorySemanticType = c.semanticType;
  let temporality: Temporality = c.temporality;

  // LLM 给 rules/profile 但系统判定非跨情境 → 强制降级为 experience（§3.2 代码）
  if (
    (semanticType === "rules" || semanticType === "profile") &&
    !reconciled
  ) {
    semanticType = "experience";
    temporality = "ephemeral";
  }
  // ephemeral 不允许与 rules/profile 共存 → 改 experience（§3.1 闸门 10）
  if (
    temporality === "ephemeral" &&
    (semanticType === "rules" || semanticType === "profile")
  ) {
    semanticType = "experience";
  }

  // 闸门 11：scope 不超界（targetScope 不得宽于 source.scope）
  const targetScope: ScopeLevel =
    SCOPE_RANK[c.targetScope] > SCOPE_RANK[source.scope]
      ? source.scope
      : c.targetScope;

  return {
    rejected: false,
    text: c.text,
    semanticType,
    salience: c.salience,
    temporality,
    crossContextual: reconciled,
    targetScope,
    profileDimension: c.profileDimension,
    evidence: {
      quote: c.evidence.quote,
      eventIds: c.evidence.eventIds ? [...c.evidence.eventIds] : undefined,
    },
    riskFlags,
    evidenceOnly,
  };
}
