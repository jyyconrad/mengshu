/**
 * 黄金集 case 判定逻辑。
 *
 * 本文件做什么：
 *   - 把 runner 执行结果（injectedMemoryIds / filledSlots / content / latency）
 *     与 GoldenCase.expected 对照，输出 CaseResult。
 *   - 计算汇总指标：slot_recall pass rate、wrong_injection_rate、latency P50/P95。
 *
 * 核心流程：
 *   defaultJudge(input)：
 *     1) requiredMemoryIds：必须全部出现在 injectedMemoryIds 中；
 *     2) forbiddenMemoryIds：一旦出现一个就 fail；
 *     3) requiredSlots：必须出现在 filledSlots 中；
 *     4) answerMustContain：content 必须字面包含；
 *     5) mustEscape：content 不能再包含原始注入标签；
 *     6) expectSensitiveBlocked：seed 必须被敏感过滤器拦截；
 *     7) negative case：要求 injectedMemoryIds 全部不出现 forbidden。
 *
 *   summarizeSuite(cases)：
 *     - passRate = passed / total
 *     - slotRecallPassRate = (requiredMemoryIds 全部命中的 case 数) / total
 *     - wrongInjectionRate = (任意 forbidden 命中的 case 数) / total
 *     - latency P50/P95 用排序后取分位
 *
 * 关键边界：
 *   - 没有任何 expected 字段时（理论不应发生），case 默认 pass，避免空集 fail。
 *   - latency 仅做记录与统计，不直接决定 release gate（gate 在 quick-eval 出报告时校验）。
 */

import type {
  CaseResult,
  GoldenCase,
  Judge,
  JudgeInput,
  SuiteSummary,
} from "./types.js";

/**
 * 计算分位数（升序，输入会被复制再排序，不修改原数组）。
 * p 取 0~1，例如 0.95 表示 P95。
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(p * (sorted.length - 1) + 0.5)),
  );
  return sorted[idx];
}

/**
 * 默认 v0.1 Judge：基于 id 严格匹配 + forbidden 严格 0 + slot 必填 + 字面包含。
 */
export const defaultJudge: Judge = (input: JudgeInput): CaseResult => {
  const { goldenCase: gc } = input;
  const failures: string[] = [];

  const requiredIds = gc.expected.requiredMemoryIds ?? [];
  const forbiddenIds = gc.expected.forbiddenMemoryIds ?? [];
  const requiredSlots = gc.expected.requiredSlots ?? [];
  const mustContain = gc.expected.answerMustContain ?? [];
  const mustEscape = gc.expected.mustEscape ?? [];

  const injected = new Set(input.injectedMemoryIds);

  // 1) requiredMemoryIds：必须全部命中
  const hitRequired: string[] = [];
  const missedRequired: string[] = [];
  for (const id of requiredIds) {
    if (injected.has(id)) hitRequired.push(id);
    else missedRequired.push(id);
  }
  if (missedRequired.length > 0) {
    failures.push(
      `slot_recall: 漏掉 requiredMemoryIds=[${missedRequired.join(", ")}]`,
    );
  }

  // 2) forbiddenMemoryIds：严格 0 出现
  const injectedForbidden = forbiddenIds.filter((id) => injected.has(id));
  if (injectedForbidden.length > 0) {
    failures.push(
      `wrong_injection: 注入了 forbiddenMemoryIds=[${injectedForbidden.join(", ")}]`,
    );
  }

  // 3) requiredSlots：必须出现
  const filledSet = new Set(input.filledSlots);
  const missingSlots = requiredSlots.filter((slot) => !filledSet.has(slot));
  if (missingSlots.length > 0) {
    failures.push(
      `requiredSlots: 槽位未填充=[${missingSlots.join(", ")}]`,
    );
  }

  // 4) answerMustContain：字面包含
  for (const keyword of mustContain) {
    if (!input.content.includes(keyword)) {
      failures.push(`must_contain: 上下文缺少关键字 "${keyword}"`);
    }
  }

  // 5) mustEscape：原始注入标签不应出现
  for (const dangerous of mustEscape) {
    if (input.content.includes(dangerous)) {
      failures.push(`must_escape: 危险标签未被转义 "${dangerous}"`);
    }
  }

  // 5b) mustEscapeMaxCount：标签出现次数不超过给定上限
  //     用于校验 prompt 模板自带的 <relevant-memories> 等标签 + body
  //     注入后总次数仍 <= max（即 body 中的注入被剥离）。
  const maxCounts = gc.expected.mustEscapeMaxCount ?? [];
  for (const { tag, max } of maxCounts) {
    let count = 0;
    let cursor = 0;
    while (cursor <= input.content.length) {
      const next = input.content.indexOf(tag, cursor);
      if (next === -1) break;
      count++;
      cursor = next + tag.length;
    }
    if (count > max) {
      failures.push(
        `must_escape: 标签 "${tag}" 出现 ${count} 次，超过预期 max=${max}`,
      );
    }
  }

  // 6) expectSensitiveBlocked：seed 必须被敏感过滤器拦截
  if (gc.expected.expectSensitiveBlocked) {
    const seedIds = gc.seedMemories.map((m) => m.id);
    const blockedSet = new Set(input.sensitiveBlockedIds);
    const notBlocked = seedIds.filter((id) => !blockedSet.has(id));
    if (notBlocked.length > 0) {
      failures.push(
        `sensitive_blocked: 期望被敏感过滤拦截但实际通过 [${notBlocked.join(", ")}]`,
      );
    }
  }

  // 7) negative case：任何 forbidden 注入都已记录到 injectedForbidden
  //    这里仅做提示，不重复 fail（已经在 step 2 处理）。

  return {
    caseId: gc.id,
    suite: gc.suite,
    passed: failures.length === 0,
    failures,
    hitRequired,
    missedRequired,
    injectedForbidden,
    filledSlots: input.filledSlots,
    latencyMs: input.latencyMs,
    tokenEstimate: input.tokenEstimate,
  };
};

/**
 * 把一组 CaseResult 汇总成 SuiteSummary。
 */
export function summarizeSuite(
  suite: string,
  cases: GoldenCase[],
  results: CaseResult[],
): SuiteSummary {
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = total - passed;

  const slotRecallPasses = results.filter((r, idx) => {
    const required = cases[idx].expected.requiredMemoryIds ?? [];
    if (required.length === 0) return true;
    return r.missedRequired.length === 0;
  }).length;

  const wrongInjections = results.filter(
    (r) => r.injectedForbidden.length > 0,
  ).length;

  const latencies = results.map((r) => r.latencyMs);
  return {
    suite,
    total,
    passed,
    failed,
    passRate: total === 0 ? 0 : passed / total,
    slotRecallPassRate: total === 0 ? 0 : slotRecallPasses / total,
    wrongInjectionRate: total === 0 ? 0 : wrongInjections / total,
    latencyP50Ms: percentile(latencies, 0.5),
    latencyP95Ms: percentile(latencies, 0.95),
    failedCases: results.filter((r) => !r.passed),
  };
}
