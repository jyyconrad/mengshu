/**
 * 四套评分体系的单一事实来源（Single Source of Truth）。
 *
 * 本文件固化 mengshu 记忆系统四套评分（valueScore / importance /
 * confidence / hotness）所需的全部权重常量，对应统一设计文档
 * docs/04-design/04.2-detail/memory-system-unified-design.md §4.6
 * 的 SCORING_WEIGHTS_V1 代码块（逐字段落地）。
 *
 * 决策来源：
 * - D-10 / D-11：四套评分分工固化，权重集中为单一事实来源。
 * - D-01：riskPenalty 在消费时为 -0.15 惩罚项；此处常量按 §4.6
 *   存正值 0.15，消费方（valueScore 计算）取负号使用。
 *
 * 变更规约：任何权重调整必须经 ADR-001 批准，不得在消费方内联硬编码。
 * 重新评估时机：累计 >= 10k 条 active memory 后做敏感性分析。
 */

/** 召回 recency 衰减分段：[天数上界, 衰减系数] */
export type RecencyDecayBucket = readonly [number, number];

export const SCORING_WEIGHTS_V1 = {
  version: "v1.0",
  /** valueScore 准入决策 8 维加权（§4.1）。riskPenalty 消费方取负。 */
  valueScore: {
    explicitness: 0.18,
    durability: 0.17,
    actionability: 0.17,
    specificity: 0.14,
    evidence: 0.12,
    scopeFit: 0.1,
    novelty: 0.07,
    riskPenalty: 0.15, // D-01：消费方按 -0.15 使用
  },
  /** importance 召回排序 + 树路由 4 项加权（§4.2），4 项和为 1.0。 */
  importance: {
    w1_salience: 0.45,
    w2_authority: 0.2,
    w3_explicit: 0.2,
    w4_type: 0.15,
  },
  /** 来源权威度 6 档（§4.2），用于 evidence/importance/confidence。 */
  sourceAuthority: {
    rule_file: 1.0,
    session_user: 0.8,
    work_log: 0.6,
    document: 0.5,
    tool_result: 0.4,
    agent_output: 0.3,
  },
  /** 类型先验，5 个语义 type（§4.2）。 */
  typePrior: {
    rules: 1.0,
    profile: 0.9,
    task_context: 0.7,
    resource: 0.6,
    experience: 0.5,
  },
  /** 各 type 的基础置信，confidence 多证据累积起点（§4.3）。 */
  typeBaseConfidence: {
    rules: 0.5,
    profile: 0.45,
    task_context: 0.4,
    resource: 0.4,
    experience: 0.4,
  },
  /** hotness topic 创建/归档 5 项求和系数（§4.4）。 */
  hotness: {
    ln_mention_coeff: 1.0,
    distinct_source_coeff: 0.5,
    recency_decay_buckets: [
      [1, 1.0],
      [7, 0.5],
      [30, 0.0],
    ],
    centrality_coeff: 1.0,
    query_hits_coeff: 2.0,
  },
} as const;

export type ScoringWeightsV1 = typeof SCORING_WEIGHTS_V1;
