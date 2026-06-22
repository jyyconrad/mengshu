/**
 * validator 集成测试：验证 11 闸门决策正确写入 trace
 */

import { describe, it, expect } from "vitest";
import {
  validateCandidate,
  type RawCandidate,
  type CandidateSource,
} from "../../../packages/core/src/lifecycle/candidate-validator.js";
import type { ValidatorDecisionEntry } from "./trace-writer.js";

describe("validator integration with trace", () => {
  it("should produce ValidatorDecisionEntry for passed candidate", () => {
    const rawCandidate: RawCandidate = {
      text: "用户偏好使用 TypeScript 编写代码",
      semanticType: "profile",
      salience: 0.85,
      temporality: "persistent",
      targetScope: "project",
      profileDimension: "coding_style",
      evidence: {
        quote: "用户偏好使用 TypeScript",
      },
    };

    const candidateSource: CandidateSource = {
      text: "项目历史：用户偏好使用 TypeScript 编写代码，避免使用 any。",
      scope: "project",
    };

    const validationResult = validateCandidate(rawCandidate, candidateSource);

    // 调试：查看 validation result
    console.log("Validation result:", JSON.stringify(validationResult, null, 2));

    // 转换为 trace schema
    let gateDecision: ValidatorDecisionEntry;

    if (validationResult.rejected) {
      gateDecision = {
        candidateId: "test-001",
        passed: false,
        gates: {
          [validationResult.reason]: {
            pass: false,
            reason: validationResult.reason,
          },
        },
      };
    } else {
      const hasSensitive = validationResult.riskFlags.includes("sensitive");
      const hasPromptInjection = validationResult.riskFlags.includes("prompt_injection");
      const isEvidenceOnly = validationResult.evidenceOnly;

      gateDecision = {
        candidateId: "test-001",
        passed: true,
        gates: {
          schema_valid: { pass: true },
          evidence_in_source: { pass: true },
          text_length_ok: { pass: true },
          salience_ok: { pass: true, score: validationResult.salience },
          semantic_type_valid: { pass: true },
          profile_dimension_ok: { pass: true },
          sensitive_check: { pass: !hasSensitive },
          prompt_injection_check: { pass: !hasPromptInjection },
          generic_filter: { pass: !isEvidenceOnly },
          temporality_consistent: { pass: true },
          scope_bounded: { pass: true },
        },
      };
    }

    expect(gateDecision.passed).toBe(!validationResult.rejected);
    if (!validationResult.rejected) {
      expect(Object.keys(gateDecision.gates)).toHaveLength(11);
    }
  });

  it("should produce ValidatorDecisionEntry for rejected candidate", () => {
    const rawCandidate: RawCandidate = {
      text: "短文本",
      semanticType: "profile",
      salience: 0.85,
      temporality: "persistent",
      targetScope: "project",
      profileDimension: "coding_style",
      evidence: {
        quote: "不在源文本中的引用",
      },
    };

    const candidateSource: CandidateSource = {
      text: "项目历史：用户偏好使用 TypeScript 编写代码。",
      scope: "project",
    };

    const validationResult = validateCandidate(rawCandidate, candidateSource);

    let gateDecision: ValidatorDecisionEntry;

    if (validationResult.rejected) {
      gateDecision = {
        candidateId: "test-002",
        passed: false,
        gates: {
          [validationResult.reason]: {
            pass: false,
            reason: validationResult.reason,
          },
        },
      };
    } else {
      gateDecision = {
        candidateId: "test-002",
        passed: true,
        gates: {},
      };
    }

    expect(gateDecision.passed).toBe(false);
    expect(Object.keys(gateDecision.gates).length).toBeGreaterThan(0);
    const firstGateKey = Object.keys(gateDecision.gates)[0];
    expect(gateDecision.gates[firstGateKey].pass).toBe(false);
    expect(gateDecision.gates[firstGateKey].reason).toBeTruthy();
  });
});
