/**
 * candidate-types.test.ts
 *
 * 工作内容：验证候选区类型契约与默认配置（D-02）。
 * 核心流程：断言 `DEFAULT_CANDIDATE_CONFIG` 包含 `maxCandidatesPerSession=50` 等默认值。
 * 关键边界：容量约束必须为正整数，防止无限膨胀。
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_CANDIDATE_CONFIG,
  type CandidateZoneConfig,
} from "./candidate-types.js";

describe("DEFAULT_CANDIDATE_CONFIG", () => {
  it("包含 maxCandidatesPerSession=50（D-02 / §17.1）", () => {
    expect(DEFAULT_CANDIDATE_CONFIG.maxCandidatesPerSession).toBe(50);
  });

  it("包含全部必需字段且为正整数", () => {
    const config = DEFAULT_CANDIDATE_CONFIG;
    expect(config.evictionDays).toBe(30);
    expect(config.archiveDays).toBe(30);
    expect(config.reviewBatchSize).toBe(100);
    expect(config.maxCandidatesPerSession).toBeGreaterThan(0);
  });

  it("CandidateZoneConfig 字段均为可选", () => {
    const partial: CandidateZoneConfig = { maxCandidatesPerSession: 20 };
    expect(partial.maxCandidatesPerSession).toBe(20);
    expect(partial.evictionDays).toBeUndefined();
  });
});
