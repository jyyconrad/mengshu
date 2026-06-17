/**
 * valueScore 8 维信号推导（P1-Q4）
 *
 * 用途：从 validator 输出（ValidatedCandidate）和抽取上下文推导 valueScore
 * 准入决策所需的 8 维原始信号，供 value-score.ts 的 computeValueScore 消费。
 *
 * 设计依据：docs/04-design/04.2-detail/memory-system-unified-design.md §4.1
 * 各维度取值来源表（explicitness/durability/actionability/specificity/evidence/
 * scopeFit/novelty/riskPenalty）。
 *
 * 调用方：lifecycle/admission-decision.ts（准入路由决策入口）
 */

import type { ValueScoreSignals } from "./value-score.js";
import type { MemorySemanticType } from "../core/types.js";
import type {
  ValidatedCandidate,
  ScopeLevel,
  Temporality,
} from "../lifecycle/candidate-validator.js";
import { SCORING_WEIGHTS_V1 } from "./scoring-weights.js";
import { detectExplicitSave } from "./importance-score.js";

/** durability 字段 → 持久性分数映射（§4.1 表） */
const DURABILITY_MAPPING: Readonly<Record<Temporality, number>> = {
  persistent: 1.0, // long_term/project 级持久
  ephemeral: 0.1, // session/一次性
};

/**
 * durability 维度推导（§4.1 取值来源表）
 *
 * 从 validator 的 temporality 字段映射：
 * - persistent → 1.0（长期有效）
 * - ephemeral → 0.1（一次性/session 级）
 *
 * 注意：§2.3 schema 的 durability 取值为 long_term/project/session/ephemeral，
 * validator 已归一化为 persistent/ephemeral（闸门 10），此处直接映射 2 档。
 */
function deriveDurability(temporality: Temporality): number {
  return DURABILITY_MAPPING[temporality];
}

/**
 * actionability 维度推导（§4.1 取值来源表："由 typePrior 推导"）
 *
 * 表示"是否能改变 agent 后续行为"，与语义类型强相关：
 * - rules/profile 高（强影响行为）
 * - task_context/resource/experience 中等
 * 直接复用 SCORING_WEIGHTS_V1.typePrior（已按影响力排序 1.0/0.9/0.7/0.6/0.5）。
 */
function deriveActionability(semanticType: MemorySemanticType): number {
  return SCORING_WEIGHTS_V1.typePrior[semanticType];
}

/**
 * specificity 维度推导（§4.1 取值来源表："含具体指代 → 高"）
 *
 * 判定是否包含具体可执行信息（文件/工具/命令/数值/路径/标识符），
 * 复用 candidate-validator.ts 闸门 9 的 CONCRETE_MARKERS 逻辑。
 *
 * 命中任一具体标记 → 0.8（具体可执行），否则 → 0.3（抽象/泛词）。
 * 阈值设计：既不给满分 1.0（留余地给更强信号如"显式 API 调用"），
 * 也不给 0（纯泛词已被闸门 9 降级 evidence-only，此处是通过验证的候选）。
 */
const CONCRETE_MARKERS: readonly RegExp[] = [
  /[A-Za-z_$][\w$]{2,}/, // 标识符（3+ 字符，含下划线/美元符）
  /\d/, // 数值
  /[\\/][\w.-]+/, // 路径片段
  /\.[A-Za-z]{1,6}\b/, // 文件扩展名
  /`[^`]+`/, // 反引号代码标记
];

function deriveSpecificity(text: string): number {
  return CONCRETE_MARKERS.some((p) => p.test(text)) ? 0.8 : 0.3;
}

/**
 * evidence 维度推导（§4.1 取值来源表："sourceAuthority(evidence) 映射"）
 *
 * 当前上下文：候选来自 LLM 抽取（session_user 来源）或 heuristic（agent_output），
 * 暂无 rule_file/work_log 等高权威来源。统一按 session_user=0.8 给分。
 *
 * TODO(P2)：当接入 rule_file 扫描或 work_log 集成后，从 sourceKind 字段读取真实来源。
 */
function deriveEvidence(_text: string): number {
  // 首期固定 session_user 权威度 0.8（来自会话抽取）
  return SCORING_WEIGHTS_V1.sourceAuthority.session_user;
}

/**
 * scopeFit 维度推导（§4.1 取值来源表："有明确 scope 归属 → 高"）
 *
 * 判定 targetScope 是否明确且合理（不是过宽的 global/user）。
 * 设计意图：session/project/workspace 级记忆边界清晰（高分），
 * app/user 级模糊（中分），global 全局扩散风险（低分）。
 *
 * 阈值：session/project/workspace → 0.9（清晰归属）
 *       app/user → 0.6（跨边界）
 *       global → 0.3（过宽，风险）
 */
function deriveScopeFit(targetScope: ScopeLevel): number {
  if (targetScope === "session" || targetScope === "project" || targetScope === "workspace") {
    return 0.9;
  }
  if (targetScope === "app" || targetScope === "user") {
    return 0.6;
  }
  return 0.3; // global
}

/**
 * novelty 维度推导（§4.1 取值来源表："去重阶段 1 - maxSimilarity"）
 *
 * 当前上下文：准入阶段尚未执行 L3 语义去重（embedding 依赖异步），
 * 只经过 L0 exact hash（persistCandidates 内同 scope 同文本去重）。
 * 同批内重复已被拦截，剩余候选视为"初步新颖"，给中性偏高分 0.7。
 *
 * TODO(P2)：当接入异步去重后，从 deduplication 模块获取真实 maxSimilarity，
 * 用 1 - maxSimilarity 作为 novelty 分（完全重复 → 0，完全新颖 → 1.0）。
 */
function deriveNovelty(_text: string): number {
  // 首期给中性偏高分 0.7（同批去重通过 = 初步新颖）
  return 0.7;
}

/**
 * riskPenalty 维度推导（§4.1 取值来源表："命中风险词或 riskFlags"）
 *
 * 聚合 validator 输出的 riskFlags（sensitive/prompt_injection/low_evidence）。
 * 按设计 §4.7 消费链：
 * - prompt_injection: 不执行指令（已降级 evidence-only），惩罚 -0.15
 * - sensitive: 隐私风险，惩罚 -0.10（D-01 备注："首期不 hard drop，排序惩罚"）
 * - low_evidence: 证据不足（quote 模糊/eventIds 超界），惩罚 -0.15
 *
 * 返回归一化风险分 [0,1]（取各项惩罚最大值，不累加，避免过度惩罚）。
 */
function deriveRiskPenalty(riskFlags: readonly string[]): number {
  let maxPenalty = 0.0;
  if (riskFlags.includes("prompt_injection")) maxPenalty = Math.max(maxPenalty, 0.15);
  if (riskFlags.includes("sensitive")) maxPenalty = Math.max(maxPenalty, 0.1);
  if (riskFlags.includes("low_evidence")) maxPenalty = Math.max(maxPenalty, 0.15);
  return maxPenalty;
}

/**
 * 从 ValidatedCandidate 推导 valueScore 8 维信号（P1-Q4 核心映射）
 *
 * 各维度取值严格对应 §4.1 表中的"取值来源"列，保证可复现、可解释。
 * 调用方：admission-decision.ts 准入路由决策。
 *
 * @param candidate validator 裁决后的候选（含 salience/temporality/targetScope/riskFlags 等）
 * @param context 抽取上下文（intent 用于判定 explicitness）
 * @returns 8 维信号，供 computeValueScore 消费
 */
export function deriveValueScoreSignals(
  candidate: ValidatedCandidate,
  context: { intent?: string },
): ValueScoreSignals {
  // explicitness：用户明确要求记住 → 1.0，否则 0
  // 来源 1：intent=remember（memory_store 工具显式保存）
  // 来源 2：text 命中显式记忆请求模式（"记住"/"以后都"/"remember"/"don't forget"）
  const explicitness =
    context.intent === "remember" || detectExplicitSave(candidate.text) ? 1.0 : 0.0;

  // durability：持久性（persistent → 1.0, ephemeral → 0.1）
  const durability = deriveDurability(candidate.temporality);

  // actionability：能否改变 agent 行为（由 typePrior 推导）
  const actionability = deriveActionability(candidate.semanticType);

  // specificity：是否含具体指代（文件/工具/命令/数值）
  const specificity = deriveSpecificity(candidate.text);

  // evidence：来源权威度（首期固定 session_user=0.8）
  const evidence = deriveEvidence(candidate.text);

  // scopeFit：scope 归属是否明确（session/project 高，global 低）
  const scopeFit = deriveScopeFit(candidate.targetScope);

  // novelty：是否非重复（首期固定 0.7，待接入异步去重）
  const novelty = deriveNovelty(candidate.text);

  // riskPenalty：风险标记聚合（prompt_injection/sensitive/low_evidence）
  const riskPenalty = deriveRiskPenalty(candidate.riskFlags);

  return {
    explicitness,
    durability,
    actionability,
    specificity,
    evidence,
    scopeFit,
    novelty,
    riskPenalty,
  };
}
