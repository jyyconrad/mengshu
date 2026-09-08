import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { CURRENT_SCHEMA_VERSION } from
  "../../../../packages/core/src/db/migrations/schema-migrations.js";
import type { SelfBuiltDatasetManifest } from "../generator.js";
import { parseSelfBuiltEvalCaseV1 } from "../protocol.js";
import {
  createGovernedSelfBuiltEngine,
  createLegacySelfBuiltEngine,
  runSelfBuiltEvaluation,
} from "../runner.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function worktreeSha256(): string {
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "buffer" },
  ).toString("utf8").split("\0").filter(Boolean).sort();
  const digest = createHash("sha256").update("mengshu.eval-worktree/v1\0");
  for (const file of files) {
    const stat = lstatSync(file);
    if (!stat.isFile() && !stat.isSymbolicLink()) continue;
    digest.update(file).update("\0");
    digest.update(stat.isSymbolicLink() ? readlinkSync(file) : readFileSync(file));
    digest.update("\0");
  }
  return digest.digest("hex");
}

async function main(): Promise<void> {
  const round = argument("--round");
  const cacheMode = argument("--cache");
  if ((round !== "1" && round !== "2") || (cacheMode !== "cold" && cacheMode !== "warm")) {
    throw new Error("usage: run-selfbuilt-evaluation.ts --round <1|2> --cache <cold|warm>");
  }
  const datasetRoot = path.resolve(argument("--dataset") ??
    "tests/eval/selfbuilt/data/mengshu-selfbuilt-v1");
  const caseFile = path.join(datasetRoot, "cases.jsonl");
  const rawCases = readFileSync(caseFile);
  const manifest = JSON.parse(readFileSync(path.join(datasetRoot, "manifest.json"), "utf8")) as
    SelfBuiltDatasetManifest;
  if (manifest.schemaVersion !== "mengshu.selfbuilt-dataset/v1" ||
      manifest.formalReleaseEligible !== false ||
      sha256(rawCases) !== manifest.casesSha256) {
    throw new Error("self-built frozen dataset integrity check failed");
  }
  const allCases = rawCases.toString("utf8").trim().split("\n")
    .map((line) => parseSelfBuiltEvalCaseV1(JSON.parse(line)));
  if (allCases.length !== manifest.caseCount) throw new Error("self-built case count mismatch");
  const cases = allCases.filter((item) => item.split === "test");
  const gitSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const worktreeSha = worktreeSha256();
  const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version as string;
  const report = await runSelfBuiltEvaluation({
    generatedAt: new Date().toISOString(),
    cacheMode,
    candidateVersion: `mengshu@${packageVersion}+${gitSha.slice(0, 12)}.wt.${worktreeSha.slice(0, 12)}`,
    dbSchemaVersion: `v${CURRENT_SCHEMA_VERSION}`,
    worktreeSha256: worktreeSha,
    manifest,
    cases,
    engines: [
      createLegacySelfBuiltEngine({ cacheMode, cases }),
      createGovernedSelfBuiltEngine({ cacheMode, cases }),
    ],
  });
  const output = path.resolve(argument("--output") ?? path.join(
    os.homedir(), ".mengshu", "eval-results", "selfbuilt-v1", `round-${round}`,
  ));
  mkdirSync(output, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  const summary = Object.freeze({
    round: Number(round),
    cacheMode,
    output,
    reportHash: report.reportHash,
    runFingerprint: report.runFingerprint,
    datasetSha256: report.runSpec.datasetSha256,
    worktreeSha256: report.runSpec.worktreeSha256,
    baselineCandidateDelta: report.baselineCandidateDelta,
    variants: report.variants.map((variant) => ({
      variantId: variant.variantId,
      role: variant.role,
      macroScore: variant.macroScore,
      evidenceRecall: variant.evidenceRecall,
      forbiddenLeakRate: variant.forbiddenLeakRate,
      abstentionAccuracy: variant.abstentionAccuracy,
      latencyP50Ms: variant.latencyP50Ms,
      latencyP95Ms: variant.latencyP95Ms,
    })),
  });
  writeFileSync(path.join(output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, {
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
