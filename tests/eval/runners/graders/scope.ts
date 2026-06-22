/**
 * scope grader（P0-2）：scopeMatchGrader。
 *
 * 本文件做什么：
 *   - 校验被注入到上下文的记忆 scope 是否与查询 scope 在 6 个核心维度上严格相等。
 *   - 6 维：tenantId / appId / userId / projectId / agentId / namespace。
 *   - 典型用途：验证跨 scope 记忆不会被错误注入（scope 隔离）。
 *
 * 判定逻辑：
 *   - 仅当 case 显式开启 scope 校验（goldenCase.scopeValidation 存在）时生效，否则 "skip"，
 *     避免破坏既有 7 套 suite 中故意混 scope 的用例。
 *   - 查询 scope = normalizeScope(goldenCase.scope)。
 *   - 每条被注入记忆的 scope = normalizeScope(seed.scope ?? {}, 查询 scope)，
 *     与 quick-eval 的 buildSeedRecord 保持一致（seed.scope 缺省继承 case scope）。
 *   - 任一维度不等即记 violation；metric=scope_leak_rate，
 *     value = 不匹配记忆数 / 注入记忆数，0 表示无泄漏。
 *
 * 关键边界：
 *   - 纯函数，不修改输入。
 *   - normalizeScope 经 core/scope.js 转发（与 runner 同一路径解析）。
 */

import { normalizeScope } from "../../../../core/scope.js";
import type { MemoryScope } from "../../../../core/types.js";

import type { Grader, GraderResult, GraderViolation } from "./types.js";

/** scope 6 核心隔离维度。 */
const SCOPE_DIMENSIONS: ReadonlyArray<keyof MemoryScope> = [
  "tenantId",
  "appId",
  "userId",
  "projectId",
  "agentId",
  "namespace",
];

/** 返回不相等的维度列表（全等则为空）。 */
function diffScope(a: MemoryScope, b: MemoryScope): string[] {
  const diffs: string[] = [];
  for (const dim of SCOPE_DIMENSIONS) {
    if (a[dim] !== b[dim]) {
      diffs.push(`${String(dim)}: "${String(a[dim])}" != "${String(b[dim])}"`);
    }
  }
  return diffs;
}

export const scopeMatchGrader: Grader = ({
  goldenCase: gc,
  runtimeOutput,
}): GraderResult | "skip" => {
  // 仅当 case 开启 scope 校验时生效。
  if (gc.scopeValidation == null) return "skip";

  const queryScope = normalizeScope(gc.scope);
  const injectedSet = new Set(runtimeOutput.injectedMemoryIds);
  const injected = gc.seedMemories.filter((seed) => injectedSet.has(seed.id));

  if (injected.length === 0) {
    // 无注入记忆视为无泄漏（通过）。
    return {
      metric: "scope_leak_rate",
      value: 0,
      passed: true,
    };
  }

  const violations: GraderViolation[] = [];
  for (const seed of injected) {
    const seedScope = normalizeScope(seed.scope ?? {}, queryScope);
    const diffs = diffScope(seedScope, queryScope);
    if (diffs.length > 0) {
      violations.push({
        message: `记忆 scope 与查询 scope 不匹配`,
        relatedId: seed.id,
        context: diffs.join("; "),
      });
    }
  }

  return {
    metric: "scope_leak_rate",
    value: violations.length / injected.length,
    passed: violations.length === 0,
    violations: violations.length > 0 ? violations : undefined,
  };
};
