import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  runAssetPromotionSuite,
  runProgressiveDisclosureSuite,
  runSlotLoadoutSuite,
} from "./capability-contracts.js";

const goldens = path.resolve(import.meta.dirname, "../goldens");

describe.each([
  [
    "mengshu-progressive-disclosure",
    "mengshu-progressive-disclosure.jsonl",
    runProgressiveDisclosureSuite,
    5,
  ],
  [
    "mengshu-asset-promotion",
    "mengshu-asset-promotion.jsonl",
    runAssetPromotionSuite,
    5,
  ],
  [
    "mengshu-slot-loadout",
    "mengshu-slot-loadout.jsonl",
    runSlotLoadoutSuite,
    6,
  ],
])("%s deterministic capability runner", (suite, fixture, run, expectedCount) => {
  test("executes production component contracts without fallback", async () => {
    const result = await run(path.join(goldens, fixture));

    expect(result).toMatchObject({
      suite,
      total: expectedCount,
      passed: expectedCount,
      failed: 0,
      qualityGatePassed: true,
      gateFailures: [],
      contractIssues: [],
      execution: {
        runMode: "offline-component",
        fallback: false,
        degraded: false,
      },
    });
    expect(result.results).toHaveLength(expectedCount);
    expect(result.results.every((item) => item.passed && item.failures.length === 0)).toBe(true);
    expect(result.metrics).toEqual([
      expect.objectContaining({
        name: "case_pass_rate",
        numerator: expectedCount,
        denominator: expectedCount,
        value: 1,
        threshold: 1,
        passed: true,
      }),
    ]);
  });
});
