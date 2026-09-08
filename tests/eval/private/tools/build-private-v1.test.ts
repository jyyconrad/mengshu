import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

const projectRoot = path.resolve(import.meta.dirname, "../../../..");

describe("private-v1 collecting builder", () => {
  test("an empty collecting set remains blocked on independent annotation", () => {
    const output = mkdtempSync(path.join(os.tmpdir(), "mengshu-private-v1-empty-"));
    execFileSync("npx", ["tsx", "tests/eval/private/tools/build-private-v1.ts",
      "--output", output], {
      cwd: projectRoot,
      stdio: "pipe",
    });
    const manifest = JSON.parse(readFileSync(path.join(output, "manifest.json"), "utf8"));
    expect(manifest.blockers).toContain("independent_annotation_incomplete");
    expect(manifest).toMatchObject({
      status: "collecting",
      caseCount: 0,
      annotation: { verifiedCaseCount: 0 },
    });
  });

  test("synthetic fixtures pass privacy/governance checks but cannot bypass 500-case quotas", () => {
    const output = mkdtempSync(path.join(os.tmpdir(), "mengshu-private-v1-"));
    execFileSync("npx", ["tsx", "tests/eval/private/tools/build-private-v1.ts",
      "--cases", "tests/eval/private/fixtures/synthetic-private-v1.jsonl", "--output", output], {
      cwd: projectRoot,
      stdio: "pipe",
    });
    const manifest = JSON.parse(readFileSync(path.join(output, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      status: "collecting",
      caseCount: 4,
      privacyScan: { passed: true, findingCount: 0 },
      annotation: { verifiedCaseCount: 4 },
      countsByCohort: {
        "governed-canonical": 1, "fresh-holdout": 1,
        "legacy-paired": 1, adversarial: 1,
      },
    });
    expect(manifest.blockers).toEqual(expect.arrayContaining([
      "private_fresh_quota_not_met",
      "target_case_count_unmet",
    ]));
  });
});
