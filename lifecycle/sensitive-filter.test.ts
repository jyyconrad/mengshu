/**
 * sensitive-filter 单元测试
 *
 * 本测试覆盖 plan §5.1.3 + RISK-15 的敏感属性黑名单：
 * - 5 类敏感属性（人格/健康/政治/宗教/性取向）各至少 2 个命中样例
 * - 关键负例：合法的工作风格/沟通偏好/任务上下文不得被误判为敏感
 * 边界重点：验证「工作偏好 vs 人格标签」的分界，宁可漏过工作偏好也不能误伤。
 */

import { describe, expect, test } from "vitest";
import {
  detectSensitive,
  isSensitive,
  type SensitiveCategory,
} from "./sensitive-filter.js";
import { HeuristicTypeExtractor } from "./type-extractor.js";

function expectCategory(text: string, category: SensitiveCategory) {
  const result = detectSensitive(text);
  expect(result.sensitive).toBe(true);
  expect(result.categories).toContain(category);
  expect(result.matched.length).toBeGreaterThan(0);
}

describe("detectSensitive - personality 人格标签", () => {
  test("MBTI 类型命中", () => {
    expectCategory("我是 INFJ 型人格", "personality");
  });

  test("内向/外向人格断言命中", () => {
    expectCategory("我是一个很内向的人", "personality");
  });

  test("英文 introvert 命中", () => {
    expectCategory("I am an introvert", "personality");
  });
});

describe("detectSensitive - health 健康状况", () => {
  test("中文疾病/诊断命中", () => {
    expectCategory("我有抑郁症", "health");
  });

  test("英文 diagnosed with 命中", () => {
    expectCategory("I was diagnosed with diabetes", "health");
  });
});

describe("detectSensitive - political 政治立场", () => {
  test("中文党派立场命中", () => {
    expectCategory("我支持X党", "political");
  });

  test("英文政治立场命中", () => {
    expectCategory("I am a liberal and vote democrat", "political");
  });
});

describe("detectSensitive - religious 宗教信仰", () => {
  test("中文宗教信仰命中", () => {
    expectCategory("我信仰佛教", "religious");
  });

  test("英文 i am a christian 命中", () => {
    expectCategory("I am a christian", "religious");
  });

  test("英文 muslim 命中", () => {
    expectCategory("I am muslim", "religious");
  });
});

describe("detectSensitive - sexual_orientation 性取向", () => {
  test("中文性取向标签命中", () => {
    expectCategory("我是同性恋", "sexual_orientation");
  });

  test("英文性取向标签命中", () => {
    expectCategory("I am gay", "sexual_orientation");
  });
});

describe("detectSensitive - 合法内容负例（不得误伤）", () => {
  const benign = [
    "我偏好简洁回答",
    "先给结论再给计划",
    "项目截止日期是下周",
    "我喜欢用 TypeScript 写代码",
    "请在回复中使用中文",
    "当前任务是实现敏感属性黑名单",
    "参考 README.md 里的配置说明",
  ];

  for (const text of benign) {
    test(`合法内容不判敏感: ${text}`, () => {
      const result = detectSensitive(text);
      expect(result.sensitive).toBe(false);
      expect(result.categories).toEqual([]);
    });
  }
});

describe("isSensitive 便捷布尔判断", () => {
  test("敏感文本返回 true", () => {
    expect(isSensitive("我有抑郁症")).toBe(true);
  });

  test("合法文本返回 false", () => {
    expect(isSensitive("我偏好简洁回答")).toBe(false);
  });

  test("空文本返回 false", () => {
    expect(isSensitive("")).toBe(false);
  });
});

describe("HeuristicTypeExtractor 接入敏感过滤", () => {
  const extractor = new HeuristicTypeExtractor();

  test("敏感文本（健康）extract 返回空候选", async () => {
    const result = await extractor.extract({ text: "我有抑郁症，正在服用抗抑郁药" });
    expect(result).toEqual([]);
  });

  test("敏感文本（人格）即便显式保存也返回空候选", async () => {
    const result = await extractor.extract({
      text: "我是 INFJ 型人格",
      hints: { explicitSave: true },
    });
    expect(result).toEqual([]);
  });

  test("合法工作偏好不受影响，正常产出候选", async () => {
    const result = await extractor.extract({ text: "我偏好简洁回答，先给结论再给计划" });
    expect(result.length).toBeGreaterThan(0);
    expect(result.some((c) => c.semanticType === "profile")).toBe(true);
  });
});

