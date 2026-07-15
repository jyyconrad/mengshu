import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  loadEvalManifest,
  selectEvalSuites,
} from "../eval/runners/eval-manifest.js";
import { buildReport } from "../eval/runners/quick-eval.js";
import {
  runProductionRestRuntimeE2eSuite,
  type RuntimeE2ePostgresConfig,
} from "../eval/runners/runtime-e2e.js";

const liveEnabled = process.env.MENGSHU_RUN_LIVE_TESTS === "1";
const manifestPath = path.resolve(
  import.meta.dirname,
  "../eval/runtime-e2e/manifest.json",
);

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the runtime-e2e live test`);
  return value;
}

function postgresConfig(): RuntimeE2ePostgresConfig {
  const port = Number(requiredEnv("MENGSHU_LIVE_PG_PORT"));
  return Object.freeze({
    host: requiredEnv("MENGSHU_LIVE_PG_HOST"),
    port,
    database: requiredEnv("MENGSHU_LIVE_PG_DATABASE"),
    user: requiredEnv("MENGSHU_LIVE_PG_USER"),
    password: requiredEnv("MENGSHU_LIVE_PG_PASSWORD"),
    ssl: false as const,
  });
}

describe.skipIf(!liveEnabled)("production REST RuntimeHost eval live e2e", () => {
  test("production ms serve consumes durable job and earns runtime-e2e gate", async () => {
    expect(process.env.MENGSHU_LIVE_PG_ALLOW_RESET).toBe("1");
    const manifest = loadEvalManifest(manifestPath);
    const plan = selectEvalSuites(
      manifest,
      "mengshu-runtime-rest",
      manifestPath,
    )[0]!;
    expect(plan.runMode).toBe("runtime-e2e");

    const run = await runProductionRestRuntimeE2eSuite(plan.filePath, {
      postgres: postgresConfig(),
      projectRoot: path.resolve(import.meta.dirname, "../.."),
      allowReset: true,
      timeoutMs: 30_000,
    });
    const report = buildReport([run.summary], [], [plan]);

    expect(run.results).toEqual([
      expect.objectContaining({
        caseId: "runtime-rest-001",
        passed: true,
        failures: [],
        hitRequired: [
          "eval-runtime-build-tree-001",
          "eval-runtime-leaf-001",
        ],
      }),
    ]);
    expect(report.releaseGatePassed).toBe(true);
    expect(report.productionReleaseGatePassed).toBe(true);
    expect(report.suites[0]).toMatchObject({
      gatePassed: true,
      execution: {
        runMode: "runtime-e2e",
        provider: "postgresql-pgvector",
        fallback: false,
        degraded: false,
      },
    });
  }, 60_000);
});
