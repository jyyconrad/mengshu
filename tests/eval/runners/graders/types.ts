/**
 * 子 grader 统一接口（P0-2）。
 *
 * 本文件做什么：
 *   - 定义确定性子 grader 的统一输入/输出契约（GraderInput / GraderResult / Grader）。
 *   - 把 judge 的运行输出（JudgeInput）规整为 grader 易消费的 RuntimeOutput 视图。
 *
 * 设计要点：
 *   - 这套 GraderResult 与 ../types.ts 中面向 LLM 的 GraderResult（graderName/passed/failures/metrics）
 *     是两套不同用途的结构，互不影响。为避免破坏既有 7 套 eval suite 和 CaseResult.graderResults
 *     的类型，本文件的确定性 grader 接口独立定义在 graders/ 命名空间内。
 *   - 所有 grader 必须是纯函数（同入同出，无副作用、无 LLM 调用）。
 *   - grader 在缺少对应 expected 字段时返回 "skip"，由 judge 决定是否聚合，
 *     从而保证不填这些字段的旧 suite 行为不变。
 */

import type { GoldenCase, GoldenMetric, JudgeInput } from "../types.js";

/**
 * Runtime 输出视图：把 JudgeInput 中与判定相关的字段抽出，
 * 供子 grader 消费（避免 grader 直接耦合 JudgeInput 的全部字段）。
 */
export interface RuntimeOutput {
  /** 5 槽位上下文里被实际注入的记忆 id（按槽位输出顺序）。 */
  injectedMemoryIds: string[];
  /** 拼装后的 prompt 文本。 */
  content: string;
}

/** 子 grader 输入。 */
export interface GraderInput {
  goldenCase: GoldenCase;
  runtimeOutput: RuntimeOutput;
}

/** 单条违规记录。 */
export interface GraderViolation {
  /** 人类可读的违规描述。 */
  message: string;
  /** 关联的记忆 id / 模式 / 字符串（可选）。 */
  relatedId?: string;
  /** 附加上下文（命中的片段、scope 维度差异等）。 */
  context?: string;
}

/** 命中样本（用于报告与调试）。 */
export interface GraderSample {
  id: string;
  description: string;
  data?: unknown;
}

/** 子 grader 执行结果。 */
export interface GraderResult {
  /** 该 grader 度量的指标名。 */
  metric: GoldenMetric;
  /**
   * 指标数值（语义随 metric 而定）。
   * 对"泄漏率"类指标：0 表示无泄漏（通过），>0 表示有泄漏。
   */
  value: number;
  /** 是否通过。 */
  passed: boolean;
  /** 违规明细（仅在 !passed 时通常非空）。 */
  violations?: GraderViolation[];
  /** 命中样本（信息性）。 */
  samples?: GraderSample[];
}

/**
 * 子 grader：纯函数，输入 case + 运行输出，给出该指标的判定。
 * 若该 case 不涉及此 grader 的断言（缺对应 expected 字段），返回 "skip"。
 */
export type Grader = (input: GraderInput) => GraderResult | "skip";

/** 从 JudgeInput 构造 grader 输入。 */
export function toGraderInput(input: JudgeInput): GraderInput {
  return {
    goldenCase: input.goldenCase,
    runtimeOutput: {
      injectedMemoryIds: input.injectedMemoryIds,
      content: input.content,
    },
  };
}
