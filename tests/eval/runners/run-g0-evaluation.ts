import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { CURRENT_SCHEMA_VERSION } from
  "../../../packages/core/src/db/migrations/schema-migrations.js";
import { parseEvalCaseV2 } from "../public/protocol.js";
import { createEvalRunSpec } from "./evaluation-protocol.js";
import { runGeneralEvaluation } from "./general-runner.js";
import {
  createBudgetedFullContextEngine,
  createLexicalDiagnosticEngine,
  createNoMemoryEngine,
} from "./offline-retrieval-engines.js";

interface FrozenManifest {
  readonly datasetId: string;
  readonly caseCount: number;
  readonly casesSha256: string;
}

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

function main(): Promise<void> {
  const round = argument("--round");
  const cacheMode = argument("--cache") ?? "cold";
  if ((round !== "1" && round !== "2") || (cacheMode !== "cold" && cacheMode !== "warm")) {
    throw new Error("usage: run-g0-evaluation.ts --round <1|2> --cache <cold|warm> [--output dir]");
  }
  const datasetRoot = path.join(os.homedir(), ".mengshu", "eval-datasets", "public", "frozen", "g0-v1");
  const caseFile = path.join(datasetRoot, "cases.jsonl");
  const manifest = JSON.parse(readFileSync(path.join(datasetRoot, "manifest.json"), "utf8")) as FrozenManifest;
  const rawCases = readFileSync(caseFile);
  if (sha256(rawCases) !== manifest.casesSha256) throw new Error("frozen G0 case hash mismatch");
  const cases = rawCases.toString("utf8").trim().split("\n").map((line) =>
    parseEvalCaseV2(JSON.parse(line)));
  if (cases.length !== manifest.caseCount) throw new Error("frozen G0 case count mismatch");
  const gitSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const worktreeSha = worktreeSha256();
  const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version as string;
  const algorithmHash = sha256(readFileSync(new URL("./offline-retrieval-engines.ts", import.meta.url)));
  const runSpec = createEvalRunSpec({
    candidateVersion: `mengshu@${packageVersion}+${gitSha.slice(0, 12)}.wt.${worktreeSha.slice(0, 12)}`,
    baselineVersion: "diagnostic-no-memory/v1",
    datasetVersions: { [manifest.datasetId]: manifest.casesSha256 },
    governanceSnapshot: null,
    configFingerprint: sha256(JSON.stringify({ cacheMode, tier: "G0", protocol: "retrieval-diagnostic-v1" })),
    dbSchemaVersion: `v${CURRENT_SCHEMA_VERSION}`,
    embeddingModel: "not-run-offline-diagnostic",
    readerModel: "not-run-offline-diagnostic",
    judgeModel: "not-run-offline-diagnostic",
    promptHashes: { retrievalAlgorithm: algorithmHash, worktree: worktreeSha },
    randomSeed: 42,
    contextTokenBudget: 32_768,
    topK: 10,
    cacheMode,
  });
  return runGeneralEvaluation({
    tier: "G0",
    generatedAt: new Date().toISOString(),
    runSpec,
    datasetId: manifest.datasetId,
    datasetSha256: manifest.casesSha256,
    cases,
    engines: [
      createNoMemoryEngine(),
      createBudgetedFullContextEngine(),
      createLexicalDiagnosticEngine({ cacheMode, cases }),
    ],
  }).then((report) => {
    const outputDir = argument("--output") ?? path.join(
      os.homedir(), ".mengshu", "eval-results", "g0-v1", `round-${round}`,
    );
    mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    const summary = {
      round: Number(round), cacheMode, outputDir,
      reportHash: report.reportHash, runFingerprint: report.runFingerprint,
      blockers: report.blockers,
      variants: report.variants.map((variant) => ({
        variantId: variant.variantId, role: variant.role, status: variant.status,
        scoredCases: variant.scoredCases, diagnosticScore: variant.diagnosticScore,
        latencyP50Ms: variant.latencyP50Ms, latencyP95Ms: variant.latencyP95Ms,
      })),
    };
    writeFileSync(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
