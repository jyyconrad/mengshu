import path from "node:path";

import { describe, expect, test } from "vitest";

import { loadEvalManifest, selectEvalSuites } from "./eval-manifest.js";
import { buildReport } from "./quick-eval.js";
import type { SuiteSummary } from "./types.js";

const manifestPath = path.resolve(
  import.meta.dirname,
  "../runtime-e2e/manifest.json",
);

describe("production runtime-e2e eval contract", () => {
  test("独立 manifest 明确声明真实 RuntimeHost + REST suite", () => {
    const manifest = loadEvalManifest(manifestPath);
    const plan = selectEvalSuites(
      manifest,
      "mengshu-runtime-rest",
      manifestPath,
    )[0]!;

    expect(plan).toMatchObject({
      kind: "extension",
      runner: "production-rest-runtime-host-v1",
      runMode: "runtime-e2e",
      liveGate: "MENGSHU_RUN_LIVE_TESTS=1",
      transport: "rest-http",
      composition: "ms-serve-runtime-host",
      metrics: ["case_pass_rate"],
      gate: { case_pass_rate: 1 },
      caseCount: 1,
    });
  });

  test("未执行 live suite 时 production gate 不能因 skip 假绿", () => {
    const manifest = loadEvalManifest(manifestPath);
    const plan = selectEvalSuites(
      manifest,
      "mengshu-runtime-rest",
      manifestPath,
    )[0]!;
    const failedCase = {
      caseId: "runtime-rest-001",
      suite: plan.name,
      passed: false,
      failures: ["live runtime evidence missing"],
      hitRequired: [],
      missedRequired: [],
      injectedForbidden: [],
      filledSlots: [],
      latencyMs: 0,
      tokenEstimate: 0,
    };
    const summary: SuiteSummary = {
      suite: plan.name,
      total: 1,
      passed: 0,
      failed: 1,
      passRate: 0,
      slotRecallPassRate: 0,
      wrongInjectionRate: 0,
      latencyP50Ms: 0,
      latencyP95Ms: 0,
      failedCases: [failedCase],
      metrics: [{
        name: "case_pass_rate",
        numerator: 0,
        denominator: 1,
        value: 0,
        direction: "min",
        threshold: 1,
        passed: false,
      }],
      execution: {
        runMode: "runtime-e2e",
        provider: null,
        model: null,
        prompt: null,
        version: "not-executed",
        fallback: false,
        degraded: true,
      },
      gateFailures: ["live runtime evidence missing"],
    };

    const report = buildReport([summary], [], [plan]);
    expect(report.releaseGatePassed).toBe(false);
    expect(report.productionReleaseGatePassed).toBe(false);
  });
});
