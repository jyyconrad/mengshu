/**
 * identifier grader（P0-2）：forbiddenBodyPatternsGrader。
 *
 * 本文件做什么：
 *   - 校验被注入到上下文的记忆 body 是否命中 expected.forbiddenBodyPatterns 中的禁止模式。
 *   - 典型用途：验证 Matrix room id / sessionId / thread id 等标识符不应进入记忆正文。
 *
 * 判定逻辑：
 *   - 取 expected.forbiddenBodyPatterns（正则字符串数组）；缺失或为空 → "skip"。
 *   - 对每条被注入记忆（injectedMemoryIds 命中的 seed body），用每个模式做正则匹配。
 *   - 任意命中即记一条 violation；metric=identifier_leak_rate，
 *     value = 命中的 (记忆, 模式) 对数 / (注入记忆数 × 模式数)，0 表示无泄漏。
 *
 * 关键边界：
 *   - 纯函数，不修改输入。
 *   - 正则非法时降级为字面子串匹配，并在 violation.context 标注，避免抛错中断整套评测。
 */

import type { Grader, GraderResult, GraderViolation } from "./types.js";

/** 安全编译正则；非法时返回 undefined。 */
function safeCompile(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}

export const forbiddenBodyPatternsGrader: Grader = ({
  goldenCase: gc,
  runtimeOutput,
}): GraderResult | "skip" => {
  const patterns = gc.expected.forbiddenBodyPatterns ?? [];
  if (patterns.length === 0) return "skip";

  // 按 injectedMemoryIds 取出对应 seed 的 body。
  const injectedSet = new Set(runtimeOutput.injectedMemoryIds);
  const injectedBodies = gc.seedMemories
    .filter((seed) => injectedSet.has(seed.id))
    .map((seed) => ({ id: seed.id, body: seed.body }));

  const violations: GraderViolation[] = [];
  let hitPairs = 0;
  const totalPairs = Math.max(1, injectedBodies.length * patterns.length);

  for (const pattern of patterns) {
    const regex = safeCompile(pattern);
    for (const { id, body } of injectedBodies) {
      const matched = regex
        ? regex.test(body)
        : body.includes(pattern);
      if (matched) {
        hitPairs++;
        violations.push({
          message: `记忆 body 命中禁止模式 "${pattern}"`,
          relatedId: id,
          context: regex ? undefined : "正则非法，降级为字面子串匹配",
        });
      }
    }
  }

  return {
    metric: "identifier_leak_rate",
    value: hitPairs / totalPairs,
    passed: violations.length === 0,
    violations: violations.length > 0 ? violations : undefined,
  };
};
