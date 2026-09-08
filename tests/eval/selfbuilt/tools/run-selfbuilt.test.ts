import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

const projectRoot = path.resolve(import.meta.dirname, "../../../..");

function run(script: string, args: readonly string[]): void {
  execFileSync("npx", ["tsx", script, ...args], { cwd: projectRoot, stdio: "pipe" });
}

describe("self-built evaluation round and finalize CLIs", () => {
  test("persist two integrity-checked rounds and a passing self-built gate", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "mengshu-selfbuilt-run-"));
    const dataset = path.join(root, "dataset");
    const results = path.join(root, "results");
    run("tests/eval/selfbuilt/tools/prepare-selfbuilt.ts", ["--output", dataset]);
    run("tests/eval/selfbuilt/tools/run-selfbuilt-evaluation.ts", [
      "--round", "1", "--cache", "cold", "--dataset", dataset,
      "--output", path.join(results, "round-1"),
    ]);
    run("tests/eval/selfbuilt/tools/run-selfbuilt-evaluation.ts", [
      "--round", "2", "--cache", "warm", "--dataset", dataset,
      "--output", path.join(results, "round-2"),
    ]);
    run("tests/eval/selfbuilt/tools/finalize-selfbuilt-evaluation.ts", ["--root", results]);

    const comparison = JSON.parse(readFileSync(path.join(results, "comparison.json"), "utf8"));
    const gate = JSON.parse(readFileSync(path.join(results, "gate.json"), "utf8"));
    expect(comparison).toMatchObject({
      stable: true, delta: 0, changedCaseCount: 0,
      round1CandidateScore: 100, round2CandidateScore: 100,
    });
    expect(comparison).not.toHaveProperty("baselineScore");
    expect(gate).toMatchObject({
      schemaVersion: "mengshu.selfbuilt-gate/v1",
      decision: "pass",
      blockers: [],
      thresholds: {
        minimumCandidateScore: 99,
        maximumForbiddenLeakRate: 0,
        minimumAbstentionAccuracy: 1,
        minimumBaselineDelta: 20,
      },
      observed: { legacyBaselineScore: 72.693311, baselineDelta: 27.306689 },
    });
  }, 20_000);
});
