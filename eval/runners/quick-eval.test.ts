/**
 * eval/runners/quick-eval.test.ts
 *
 * 本文件做什么：
 *   把 eval/goldens/*.jsonl 的每条 case 接到 vitest test.each 上，
 *   形成"每条黄金集 → 一个 vitest 用例"的回归测试。
 *
 * 核心流程：
 *   1) 加载 v0.1 与 safety 两个 jsonl；
 *   2) 用 quick-eval 的 runSuite 跑出 results；
 *   3) test.each 逐条断言 result.passed === true；
 *      失败时打印 case.failures 帮助定位。
 *   4) suite 级断言：
 *      - safety 套件 wrong_injection_rate 必须为 0；
 *      - v0.1 套件 pass rate 必须 >= 80%（v0.1 release gate）。
 *
 * 关键边界：
 *   - 这里依赖 SlotContextBuilder + scope-policy + sensitive-filter，
 *     不调用任何外部服务；纯本地，2 秒内能跑完。
 *   - 不依赖 LLM，不依赖向量库；判定全部基于 id 命中与字面匹配。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import { runSuite } from "./quick-eval.js";
import type { CaseResult } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const goldensDir = path.resolve(__dirname, "../goldens");

interface SuitePlan {
  name: string;
  file: string;
  /** 该套件 release gate 要求的最小通过率（0-1）。 */
  minPassRate: number;
  /** 该套件是否要求 wrong_injection_rate 严格为 0。 */
  requireZeroWrongInjection: boolean;
}

const SUITES: SuitePlan[] = [
  {
    name: "mengshu-v0.1",
    file: path.join(goldensDir, "mengshu-v0.1.jsonl"),
    minPassRate: 0.8,
    requireZeroWrongInjection: false,
  },
  {
    name: "mengshu-safety",
    file: path.join(goldensDir, "mengshu-safety.jsonl"),
    minPassRate: 0.95,
    requireZeroWrongInjection: true,
  },
];

for (const suite of SUITES) {
  describe(`golden suite: ${suite.name}`, async () => {
    const { results, summary } = await runSuite(suite.file);

    test("suite-level release gate", () => {
      if (suite.requireZeroWrongInjection) {
        expect(summary.wrongInjectionRate).toBe(0);
      }
      expect(summary.passRate).toBeGreaterThanOrEqual(suite.minPassRate);
    });

    const cases: Array<[string, CaseResult]> = results.map((r) => [r.caseId, r]);

    test.each(cases)("case %s should pass", (_caseId, result) => {
      if (!result.passed) {
        // 让失败信息可读
        // 方便直接复现：打印 caseId + failures
        console.error(
          `[${result.suite}] ${result.caseId} failed:\n  - ${result.failures.join("\n  - ")}`,
        );
      }
      expect(result.passed).toBe(true);
    });
  });
}
