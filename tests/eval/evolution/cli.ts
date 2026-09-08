import { readFile, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertExplicitVerificationPaths, assertLoopbackPostgres } from "../../fixtures/memory-evolution/isolated-postgres.js";
import { loadGlobalMengshuConfig } from "../../live/global-postgres-config.js";
import { createComponentDiagnosticFactory } from "./component-driver.js";
import { exactDiagnosticVerifier, freezeDiagnosticDataset, runEvolutionDiagnostic } from "./diagnostic-runner.js";
import { createSyntheticDiagnosticDataset } from "./synthetic-fixture.js";
import type { DiagnosticArmFactory, DiagnosticDataset, DiagnosticGovernanceMode } from "./types.js";

interface CliOptions { output: string; synthetic: boolean; dataset?: string; adapter?: string; governanceMode?: DiagnosticGovernanceMode }
export function parseDiagnosticCli(argv: string[]): CliOptions {
  const options: CliOptions = { output: "", synthetic: false };
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (seen.has(flag)) throw new Error("duplicate_cli_flag");
    seen.add(flag);
    if (flag === "--synthetic") { options.synthetic = true; continue; }
    if (flag === "--governance") {
      const mode = argv[++index];
      if (mode !== "auto" && mode !== "reviewed") throw new Error("invalid_governance_mode");
      options.governanceMode = mode;
      continue;
    }
    if (!["--output", "--dataset", "--adapter"].includes(flag)) throw new Error("unknown_cli_flag");
    const value = argv[++index];
    if (!value || !isAbsolute(value) || value.trim() !== value) throw new Error("explicit_absolute_path_required");
    if (flag === "--output") options.output = value;
    else if (flag === "--dataset") options.dataset = value;
    else options.adapter = value;
  }
  if (!options.output || (options.synthetic ? !!options.dataset || !!options.adapter : !options.dataset || !options.adapter)) {
    throw new Error("usage: --synthetic --output /absolute/new-directory OR --dataset /absolute/frozen.json --adapter /absolute/driver.ts --output /absolute/new-directory");
  }
  return options;
}

async function boundedJson(file: string): Promise<DiagnosticDataset> {
  const size = (await stat(file)).size;
  if (size > 20 * 1024 * 1024) throw new Error("diagnostic_dataset_too_large");
  return JSON.parse(await readFile(file, "utf8")) as DiagnosticDataset;
}
export async function runDiagnosticCli(options: CliOptions) {
  let factory: DiagnosticArmFactory;
  const dataset = options.synthetic ? createSyntheticDiagnosticDataset() : await boundedJson(options.dataset!);
  freezeDiagnosticDataset(dataset);
  if (options.synthetic) factory = createComponentDiagnosticFactory();
  else {
    if (process.env.MENGSHU_RUN_LIVE_TESTS !== "1") throw new Error("explicit_live_opt_in_required");
    const paths = assertExplicitVerificationPaths();
    assertExplicitVerificationPaths({ ...process.env, MENGSHU_CONFIG: await realpath(paths.configPath), MENGSHU_ENV: await realpath(paths.envPath) });
    assertLoopbackPostgres(loadGlobalMengshuConfig().postgres);
    // Operator-supplied local driver. No automatic production adapter, config discovery or model fallback.
    const module = await import(pathToFileURL(await realpath(options.adapter!)).href) as {
      createDiagnosticFactory?: (paths: { configPath: string; envPath: string }) => Promise<DiagnosticArmFactory> | DiagnosticArmFactory;
    };
    if (typeof module.createDiagnosticFactory !== "function") throw new Error("diagnostic_driver_factory_missing");
    factory = await module.createDiagnosticFactory(paths);
    if (!["isolated-postgres-controlled-model", "isolated-postgres-real-model"].includes(factory.executionBoundary)) throw new Error("isolated_postgres_driver_required");
  }
  const report = await runEvolutionDiagnostic({ dataset, factory, verifier: exactDiagnosticVerifier, governanceMode: options.governanceMode });
  await mkdir(options.output, { recursive: true, mode: 0o700 });
  const output = join(options.output, "report.json");
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return { output, datasetFingerprint: report.datasetFingerprint, governanceMode: report.governanceMode, releaseGate: report.releaseGate,
    blockers: report.blockers, arms: report.arms.map(({ arm, metrics }) => ({ arm, metrics })) };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runDiagnosticCli(parseDiagnosticCli(process.argv.slice(2))).then(summary => {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  }).catch(() => {
    process.stderr.write("Evolution diagnostic failed. Check explicit paths, opt-in, fixture and driver contracts; raw provider errors are not logged.\n");
    process.exitCode = 1;
  });
}
