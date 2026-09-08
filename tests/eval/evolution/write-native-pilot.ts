import { writeFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertExplicitVerificationPaths, assertLoopbackPostgres } from "../../fixtures/memory-evolution/isolated-postgres.js";
import { loadGlobalMengshuConfig } from "../../live/global-postgres-config.js";
import { createNativeCreatePilotDataset, createNativePilotSettings } from "./native-create-pilot.js";
import { freezeDiagnosticDataset } from "./diagnostic-runner.js";

/** Main-agent-only explicit config read and synthetic freeze; this command never connects PG or a model. */
export async function writeNativePilot(argv: string[]) {
  if (argv.length !== 2 || argv[0] !== "--output" || !isAbsolute(argv[1]) || argv[1].trim() !== argv[1]) {
    throw new Error("explicit_absolute_output_file_required");
  }
  const paths = assertExplicitVerificationPaths();
  assertExplicitVerificationPaths({ ...process.env, MENGSHU_CONFIG: await realpath(paths.configPath), MENGSHU_ENV: await realpath(paths.envPath) });
  const config = loadGlobalMengshuConfig();
  assertLoopbackPostgres(config.postgres);
  const dataset = createNativeCreatePilotDataset(createNativePilotSettings(config.config, Date.now()));
  const frozen = freezeDiagnosticDataset(dataset);
  await writeFile(argv[1], JSON.stringify(frozen.dataset, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return { output: argv[1], fingerprint: frozen.datasetFingerprint, provenance: "synthetic", realCalls: 0 };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  writeNativePilot(process.argv.slice(2)).then(summary => process.stdout.write(JSON.stringify(summary) + "\n")).catch(() => {
    process.stderr.write("Native pilot freeze failed: explicit disposable config/env and a new absolute output file are required.\n");
    process.exitCode = 1;
  });
}
