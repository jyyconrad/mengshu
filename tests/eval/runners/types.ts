/**
 * 评测 runner 共享类型定义。
 *
 * 本文件做什么：
 *   - 定义 jsonl 黄金集的 GoldenCase / SeedMemorySpec / Expected schema。
 *   - 定义 runner 输出的 EvalReport / CaseResult / SuiteSummary。
 *   - 提供 Judge 抽象，方便后续接入更复杂判定。
 *
 * 核心流程：
 *   - load-jsonl 读到 GoldenCase[]
 *   - quick-eval 把每条 GoldenCase 灌进 in-memory MemoryService 并构建 Slot 上下文
 *   - judge 对照 expected.requiredMemoryIds / forbiddenMemoryIds / requiredSlots
 *     给出 verdict 与 metric breakdown
 *   - 汇总 metrics 输出 EvalReport（写到 tests/eval/results/<timestamp>/report.md）
 *
 * 关键边界：
 *   - schema 必须与 docs/07-test/memory-evaluation-plan.md §5.2 一致；
 *     增字段可以加（向后兼容），不要改名或缩窄已有字段类型。
 *   - 这里的 Judge 不强依赖 LLM；v0.1 全部基于 id 命中、forbidden 严格 0、延迟 P95。
 */

import type {
  MemoryContainer,
  MemoryKind,
  MemoryLifecycleStatus,
  MemoryScopeInput,
  MemorySemanticType,
  MemoryVisibility,
} from "../../../core/types.js";

// ===== OpenClaw history 评估扩展类型（P0-1）=====

/** Claim 类型：fact（直接陈述）/ inference（推理）/ advice（建议）/ requirement（需求）。 */
export type ClaimType = "fact" | "inference" | "advice" | "requirement";

/** Claim 判定结果：present（已正确提取）/ absent（漏掉）/ hallucinated（幻觉）。 */
export type ClaimVerdict = "present" | "absent" | "hallucinated";

/** 时态状态：past（过去事实）/ current（当前状态）/ future（未来计划）/ timeless（无时态约束）。 */
export type TemporalStatus = "past" | "current" | "future" | "timeless";

/** 证据 span 角色：support（支持）/ contradict（反驳）/ context（上下文）/ metadata（元数据）。 */
export type SpanRole = "support" | "contradict" | "context" | "metadata";

/** 关系角色：membership（归属）/ evidence（证据链接）/ temporal（时序）/ conflict（冲突）。 */
export type RelationRole = "membership" | "evidence" | "temporal" | "conflict";

/** 需求文档字段（用于 requirement claim 的 applicability 断言）。 */
export interface RequirementFields {
  /** 需求类型（功能性 / 非功能性 / 质量属性 / 性能指标）。 */
  requirementType?: "functional" | "non_functional" | "quality" | "performance";
  /** 优先级（critical / high / medium / low）。 */
  priority?: "critical" | "high" | "medium" | "low";
  /** 状态（draft / approved / implemented / deprecated）。 */
  status?: "draft" | "approved" | "implemented" | "deprecated";
  /** 模块归属（如 auth / payment / notification）。 */
  module?: string;
  /** 依赖的其他需求 ID（如 REQ-001）。 */
  dependencies?: string[];
}

/** Claim 期望断言（结构化校验 + 证据追溯）。 */
export interface ClaimExpected {
  /** claim 唯一标识（如 fact-1 / req-3）。 */
  id: string;
  /** claim 类型（fact / inference / advice / requirement）。 */
  type: ClaimType;
  /** 预期判定结果（present / absent / hallucinated）。 */
  verdict: ClaimVerdict;
  /** 支持该 claim 的证据 span ID（引用 evidenceSpans[].id）。 */
  evidenceSpanIds: string[];
  /** applicability 字段（针对 inference / advice / requirement）。 */
  applicability?: {
    /** 适用条件文本（如"用户已登录"/"在生产环境"）。 */
    condition?: string;
    /** 适用 scope（project / app / global）。 */
    scope?: string;
    /** requirement 专用字段（如优先级 / 状态 / 模块 / 依赖）。 */
    requirement?: RequirementFields;
  };
  /** temporal 字段（针对事实性 claim）。 */
  temporal?: {
    /** 时态（past / current / future / timeless）。 */
    status: TemporalStatus;
    /** 精确时间戳（ISO8601 格式 或 相对时间描述）。 */
    timestamp?: string;
    /** 事件描述（如"登录失败"/"会议安排"）。 */
    event?: string;
  };
  /** 自由文本注释（用于标注员备注或特殊说明）。 */
  notes?: string;
}

/** 证据 span 标注（标准化证据单元）。 */
export interface EvidenceSpan {
  /** span 唯一标识（如 span-1 / span-auth-3）。 */
  id: string;
  /** 原文引用（精确匹配，用于回溯验证）。 */
  quote: string;
  /** 字符起始位置（从 0 开始）。 */
  charStart: number;
  /** 字符结束位置（不含）。 */
  charEnd: number;
  /** 归一化 quote 的 SHA256 hash（用于模糊匹配 + 去重）。 */
  normalizedQuoteHash?: string;
  /** span 角色（support / contradict / context / metadata）。 */
  spanRole: SpanRole;
  /** 是否为最小充分证据（即移除该 span 后无法支持 claim）。 */
  minimalSufficient?: boolean;
  /** 支持的 claim ID 列表（多对多关联）。 */
  supportsClaimIds?: string[];
  /** 支持的树节点 ID 列表（多对多关联）。 */
  supportsNodeIds?: string[];
  /** 支持的关系 ID 列表（多对多关联）。 */
  supportsRelationIds?: string[];
  /** 关系角色（当 relationRole 存在时，说明该 span 用于支持关系断言）。 */
  relationRole?: RelationRole;
}

/** 树层级期望断言（校验 topic tree 构建正确性）。 */
export interface TreeExpected {
  /** 必须存在的节点 ID 列表（如 ["topic-auth", "topic-payment"]）。 */
  requiredNodes?: string[];
  /** 必须存在的父子关系（from=parent, to=child）。 */
  requiredParentChild?: Array<{ from: string; to: string }>;
  /** 期望的 topic key 词汇（如 ["authentication", "login"]）。 */
  expectedTopicKeys?: string[];
  /** 禁止晋升到 global tree 的节点 ID（用于测 scope 隔离）。 */
  forbiddenGlobalPromotions?: string[];
  /** 期望的树深度（0=root, 1=L1, ...）。 */
  expectedDepth?: number;
  /** 期望的子树大小（节点总数）。 */
  expectedSubtreeSize?: number;
  /** 期望的树摘要包含的关键词（用于校验 L1/L2/L3 摘要质量）。 */
  summaryMustContain?: string[];
}

/** 关系期望断言（校验 belongs_to / supersedes / updates / precedes / conflicts_with）。 */
export interface RelationExpected {
  /** 关系唯一标识（如 rel-1 / rel-auth-supersedes-3）。 */
  id: string;
  /** 关系类型（belongs_to / supersedes / updates / precedes / conflicts_with）。 */
  type: string;
  /** 起点记忆 ID（如 mem-auth-2）。 */
  from: string;
  /** 终点记忆 ID（如 mem-auth-1）。 */
  to: string;
  /** 预期判定结果（present / absent / hallucinated）。 */
  verdict: ClaimVerdict;
  /** 支持该关系的证据 span ID（引用 evidenceSpans[].id）。 */
  evidenceSpanIds?: string[];
  /** 置信度（0.0-1.0，用于模糊关系校验）。 */
  confidence?: number;
  /** 关系元数据（如 timestamp / reason / scope）。 */
  metadata?: Record<string, unknown>;
}

/** Grader 执行结果（LLM 结构化评分）。 */
export interface GraderResult {
  /** grader 名称（如 claim-grader / tree-grader / relation-grader）。 */
  graderName: string;
  /** 是否通过（全部断言都满足才为 true）。 */
  passed: boolean;
  /** 失败原因列表（如 ["claim fact-3 absent", "tree node-auth missing"]）。 */
  failures: string[];
  /** 结构化评分明细（如 claimPrecision / claimRecall / treeFaithfulness）。 */
  metrics: Record<string, number>;
  /** LLM 原始输出（用于调试和复现）。 */
  rawOutput?: string;
  /** LLM 调用耗时（毫秒）。 */
  latencyMs?: number;
}

/** v0.1 jsonl 黄金集中的 seed 记忆条目。 */
export interface SeedMemorySpec {
  id: string;
  kind: MemoryKind;
  semanticType?: MemorySemanticType;
  /** 记忆正文（必填）。 */
  body: string;
  /** evidence id 或来源描述（信息性字段，不参与判定）。 */
  evidence?: string[];
  /** 重要性，默认 0.7。 */
  importance?: number;
  /** 生命周期，默认 active。 */
  lifecycleStatus?: MemoryLifecycleStatus;
  /** 容器，默认 project。 */
  container?: MemoryContainer;
  /** 可见性，默认 private。 */
  visibility?: MemoryVisibility;
  /** seed 自带 scope 覆盖（用于测跨 scope 隔离）；不填则用 case.scope。 */
  scope?: MemoryScopeInput;
  /** 任意元数据（信息性字段）。 */
  metadata?: Record<string, unknown>;
  /** 来源 ID 列表（引用 agent history 的 source ID，用于测 source tree 路由）。 */
  sourceIds?: string[];
}

/** 期望断言结构（包含 OpenClaw history 扩展字段）。 */
export interface ExpectedSpec {
  /** 必须出现在 5 槽位上下文里的记忆 id（v0.1 全部命中才算通过）。 */
  requiredMemoryIds?: string[];
  /** 严格禁止注入的记忆 id（出现一次该 case 即 fail）。 */
  forbiddenMemoryIds?: string[];
  /** 必须填充的槽位（要求至少一条记忆进入）。 */
  requiredSlots?: MemorySemanticType[];
  /** 上下文文本必须包含的关键字（v0.1 字面包含）。 */
  answerMustContain?: string[];
  /** 必须出现的 warnings 标签。 */
  warnings?: string[];
  /** 期望文本被 prompt-safe 转义（含 < or >）后不再有原标签。 */
  mustEscape?: string[];
  /**
   * 期望文本中某些标签的出现次数不超过给定次数。
   * 用于校验 prompt 模板天然包含的标签（如 wrapper 的 <relevant-memories>）
   * 在 body 注入后总次数仍不超出 wrapper 自带次数。
   */
  mustEscapeMaxCount?: Array<{ tag: string; max: number }>;
  /** 期望被敏感过滤拦截（即不应进入 seed/上下文）。 */
  expectSensitiveBlocked?: boolean;

  // ===== OpenClaw history 扩展字段（schema v2） =====
  /** 上下文文本中不允许出现的字符串（严格子串匹配，如 room_id / thread_id）。 */
  answerMustNotContain?: string[];
  /** 记忆 body 中禁止的模式（正则字符串，用于验证 identifier 不入正文）。 */
  forbiddenBodyPatterns?: string[];
  /** claim 断言（fact/inference/advice/requirement + verdict + evidenceSpanIds + applicability + temporal）。 */
  claims?: ClaimExpected[];
  /** 树断言（requiredNodes / requiredParentChild / expectedTopicKeys / forbiddenGlobalPromotions 等）。 */
  tree?: TreeExpected;
  /** 关系断言（belongs_to / supersedes / updates / precedes / conflicts_with 等）。 */
  relations?: RelationExpected[];
  /** 旧 suite 兼容关系投影（仅 from/to/type，必须是 relations 子集）。 */
  legacyTreeCompatibility?: {
    requiredRelations?: Array<{
      from: string;
      to: string;
      type: string;
    }>;
  };
  /** 结构验证（requiredFields / parseable）。 */
  requiredStructure?: {
    requiredFields?: string[];
    parseable?: boolean;
  };
  /** 可读性断言（maxTokens / mustMentionHistorical / maxDuplicateFactRate / maxNoiseDensity）。 */
  readability?: {
    maxTokens?: number;
    mustMentionHistorical?: boolean;
    maxDuplicateFactRate?: number;
    maxNoiseDensity?: number;
  };
}

/** 黄金集套件名称。 */
export type GoldenSuite =
  | "mengshu-v0.1"
  | "mengshu-safety"
  | "mengshu-cross-product"
  | "mengshu-negative"
  | string;

/** Judge 评估的指标名。 */
export type GoldenMetric =
  | "slot_recall"
  | "wrong_injection"
  | "latency"
  | "context_precision"
  | "evidence_grounding"
  | "abstention"
  | "must_contain"
  | "must_escape"
  | "sensitive_blocked"
  // ===== OpenClaw history 新增指标（P0-1）=====
  | "claim_precision"
  | "claim_recall"
  | "claim_f1"
  | "claim_hallucination_rate"
  | "fact_precision"
  | "fact_recall"
  | "inference_precision"
  | "inference_recall"
  | "advice_precision"
  | "advice_recall"
  | "requirement_precision"
  | "requirement_recall"
  | "evidence_coverage"
  | "evidence_minimal_sufficient_rate"
  | "tree_node_precision"
  | "tree_node_recall"
  | "tree_parent_child_precision"
  | "tree_parent_child_recall"
  | "tree_topic_key_coverage"
  | "tree_global_promotion_leak_rate"
  | "tree_faithfulness"
  | "tree_summary_keyword_coverage"
  | "tree_depth_accuracy"
  | "tree_subtree_size_accuracy"
  | "relation_precision"
  | "relation_recall"
  | "relation_f1"
  | "relation_type_precision"
  | "relation_evidence_coverage"
  | "belongs_to_precision"
  | "belongs_to_recall"
  | "supersedes_precision"
  | "supersedes_recall"
  | "updates_precision"
  | "updates_recall"
  | "precedes_precision"
  | "precedes_recall"
  | "conflicts_with_precision"
  | "conflicts_with_recall"
  | "scope_leak_rate"
  | "identifier_leak_rate"
  | "readability_token_efficiency"
  | "readability_duplicate_fact_rate"
  | "readability_noise_density";

/**
 * 一条黄金集 case，对应 jsonl 一行。
 *
 * OpenClaw history 扩展字段（schema v2）：
 * - source / evidenceSpans / annotation / tree / relations / scopeValidation / identifierValidation
 * 现有 suite 不填这些字段，grader 在处理时先检查字段存在性再执行对应逻辑。
 */
export interface GoldenCase {
  id: string;
  suite: GoldenSuite;
  /** 任务描述（人类可读）。 */
  task: string;
  /** 请求 scope；缺字段由 normalizeScope 用 default 兜底。 */
  scope: MemoryScopeInput;
  /** 预先种入的记忆。 */
  seedMemories: SeedMemorySpec[];
  /** 用户问题或任务请求。 */
  query: string;
  /** 期望断言。 */
  expected: ExpectedSpec;
  /** 关心的指标，仅用于报表分组。 */
  metrics?: GoldenMetric[];
  /** 是否为负向用例（记忆不应被注入）。 */
  negative?: boolean;
  /** 注释，用于报告。 */
  notes?: string;

  // ===== OpenClaw history 扩展字段（schema v2，评估计划 §Golden Case Schema） =====
  /** 来源元数据（app/agent/file/date/fixture 路径/脱敏版本/provenance）。 */
  source?: {
    app: string;
    agent?: string;
    file?: string;
    date?: string;
    redactedFixture?: string;
    redactionMapVersion?: string;
    provenance?: {
      sessionId?: string;
      threadId?: string;
      roomId?: string;
      messageId?: string;
    };
  };
  /** 证据 span 标注（quote/charStart/charEnd/normalizedQuoteHash/spanRole/minimalSufficient 等）。 */
  evidenceSpans?: EvidenceSpan[];
  /** 标注元数据（annotator/reviewedBy/agreement/notes）。 */
  annotation?: {
    annotator: string;
    reviewedBy?: string;
    agreement?: "full" | "partial" | "low";
    notes?: string;
  };
  /** 树层级断言（requiredNodes/requiredParentChild/expectedTopicKeys/forbiddenGlobalPromotions 等）。 */
  tree?: TreeExpected;
  /** 关系断言（belongs_to/supersedes/updates/precedes/conflicts_with 等）。 */
  relations?: RelationExpected[];
  /** scope 验证断言。 */
  scopeValidation?: unknown; // 完整类型在阶段 0.5 定义
  /** 标识符治理断言（room_id 不入正文/不入树）。 */
  identifierValidation?: unknown; // 完整类型在阶段 0.5 定义
}

/** 单条 case 的判定结果。 */
export interface CaseResult {
  caseId: string;
  suite: GoldenSuite;
  passed: boolean;
  /** 触发的失败原因列表，按出现顺序。 */
  failures: string[];
  /** 已命中的 requiredMemoryIds。 */
  hitRequired: string[];
  /** 漏掉的 requiredMemoryIds。 */
  missedRequired: string[];
  /** 出现的 forbiddenMemoryIds（理论 v0.1 安全集应为空）。 */
  injectedForbidden: string[];
  /** 实际填充的槽位。 */
  filledSlots: MemorySemanticType[];
  /** 处理延迟（毫秒）。 */
  latencyMs: number;
  /** 上下文 token 预估。 */
  tokenEstimate: number;
  /** 上下文文本（可选，调试用，默认不写入大报告）。 */
  contentPreview?: string;
  /** LLM grader 执行结果（claim / tree / relation grader 的结构化评分）。 */
  graderResults?: Record<string, GraderResult>;
}

/** 单个套件汇总。 */
export interface SuiteSummary {
  suite: GoldenSuite;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  /** v0.1 严格 id-recall：requiredMemoryIds 全部命中才算 pass。 */
  slotRecallPassRate: number;
  /** 安全集核心指标：forbidden 注入率。必须为 0。 */
  wrongInjectionRate: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  failedCases: CaseResult[];
}

/** runner 一次跑出的整体报告。 */
export interface EvalReport {
  generatedAt: string;
  suites: SuiteSummary[];
  totalCases: number;
  totalPassed: number;
  totalFailed: number;
  /** release gate 是否通过（safety 套件 wrong_injection_rate=0 且整体 pass>=80%）。 */
  releaseGatePassed: boolean;
  notes?: string[];
}

/** Judge：传入 runner 的执行结果与 case，给出该 case 的判定。 */
export interface JudgeInput {
  goldenCase: GoldenCase;
  /** 5 槽位上下文里被实际注入的记忆 id（按槽位输出顺序）。 */
  injectedMemoryIds: string[];
  /** 实际填充的槽位。 */
  filledSlots: MemorySemanticType[];
  /** 拼装后的 prompt 文本。 */
  content: string;
  /** 处理延迟（毫秒）。 */
  latencyMs: number;
  /** token 预估。 */
  tokenEstimate: number;
  /** seed 时被敏感过滤器拦截的记忆 id 列表（仅 safety 用）。 */
  sensitiveBlockedIds: string[];
}

export type Judge = (input: JudgeInput) => CaseResult;

// ===== 类型守卫函数（P0-1）=====

/**
 * 检查 GoldenCase 是否包含 OpenClaw history 相关字段。
 * 用于判断是否执行 agent-history 专用 grader。
 */
export function hasOpenClawHistoryFields(gc: GoldenCase): boolean {
  return !!(
    gc.source ||
    gc.evidenceSpans ||
    gc.annotation ||
    gc.scopeValidation ||
    gc.identifierValidation
  );
}

/**
 * 检查 ExpectedSpec 是否包含 claim 断言。
 * 用于判断是否执行 claim grader。
 */
export function hasClaimExpectations(expected: ExpectedSpec): boolean {
  return !!(expected.claims && expected.claims.length > 0);
}

/**
 * 检查 ExpectedSpec 是否包含 tree 断言。
 * 用于判断是否执行 tree grader。
 */
export function hasTreeExpectations(expected: ExpectedSpec): boolean {
  return !!(
    expected.tree &&
    (expected.tree.requiredNodes ||
      expected.tree.requiredParentChild ||
      expected.tree.expectedTopicKeys ||
      expected.tree.forbiddenGlobalPromotions ||
      expected.tree.expectedDepth !== undefined ||
      expected.tree.expectedSubtreeSize !== undefined ||
      expected.tree.summaryMustContain)
  );
}

/**
 * 检查 ExpectedSpec 是否包含 relation 断言。
 * 用于判断是否执行 relation grader。
 */
export function hasRelationExpectations(expected: ExpectedSpec): boolean {
  return !!(expected.relations && expected.relations.length > 0);
}

