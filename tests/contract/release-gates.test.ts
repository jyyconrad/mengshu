import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { loadEvalManifest, selectEvalSuites } from "../eval/runners/eval-manifest.js";
import { EXTENSION_RUNNER_REGISTRY } from "../eval/runners/extension-runner-adapters.js";

const root = path.resolve(import.meta.dirname, "../..");
const packageJson = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8"),
) as { scripts?: Record<string, string> };
const vitestConfig = readFileSync(path.join(root, "vitest.config.ts"), "utf8");
const manifestPath = path.join(root, "tests/eval/goldens/manifest.json");

describe("MG-009 local release gates", () => {
  test("production gate requires explicit live opt-in and includes runtime, adapter, and fault suites", () => {
    const script = packageJson.scripts?.["test:production-gate"];

    expect(script).toBeDefined();
    expect(script).toContain("MENGSHU_RUN_LIVE_TESTS");
    expect(script).toMatch(/process\.exit\(1\)/);
    expect(script).toContain("tests/live/postgres-v9-runtime.e2e.test.ts");
    expect(script).toContain("tests/live/production-rest-runtime-eval.e2e.test.ts");
    expect(script).toContain("tests/live/postgres-authoritative-graph-reuse.e2e.test.ts");
    expect(script).toContain("tests/live/postgres-entity-alias-lifecycle.e2e.test.ts");
  });

  test("coverage includes every production TypeScript main-chain boundary", () => {
    for (const include of [
      '"packages/**/src/**/*.ts"',
      '"plugins/openclaw/src/**/*.ts"',
      '"server/**/*.ts"',
      '"scripts/**/*.ts"',
      '"*.ts"',
    ]) {
      expect(vitestConfig).toContain(include);
    }
    expect(vitestConfig).toContain('"packages/ui/src/web/**"');
    expect(vitestConfig).toContain('"**/*.test.ts"');
    expect(vitestConfig).toContain('"**/*.d.ts"');
    expect(vitestConfig).toContain('"**/generated/**"');
  });

  test.each([
    ["mengshu-progressive-disclosure", "progressive-disclosure-v1"],
    ["mengshu-asset-promotion", "asset-promotion-v1"],
    ["mengshu-slot-loadout", "slot-loadout-v1"],
  ])("%s is a real registered deterministic suite", (suiteName, runnerId) => {
    const manifest = loadEvalManifest(manifestPath);
    const plan = selectEvalSuites(manifest, suiteName, manifestPath)[0];

    expect(plan).toMatchObject({
      name: suiteName,
      kind: "extension",
      runner: runnerId,
      metrics: ["case_pass_rate"],
      gate: { case_pass_rate: 1 },
    });
    expect(plan?.caseCount).toBeGreaterThanOrEqual(5);
    expect(EXTENSION_RUNNER_REGISTRY.has(runnerId)).toBe(true);

    const fixtures = readFileSync(plan!.filePath, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { id?: string; scenario?: string });
    expect(new Set(fixtures.map((fixture) => fixture.id)).size).toBe(fixtures.length);
    expect(new Set(fixtures.map((fixture) => fixture.scenario)).size).toBeGreaterThanOrEqual(5);
  });
});
