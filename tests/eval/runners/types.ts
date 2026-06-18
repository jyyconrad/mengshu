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
 *   - 汇总 metrics 输出 EvalReport（写到 eval/results/<timestamp>/report.md）
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
} from "../../core/types.js";

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
}

/** 期望断言结构。 */
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
  | "sensitive_blocked";

/**
 * 一条黄金集 case，对应 jsonl 一行。
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
