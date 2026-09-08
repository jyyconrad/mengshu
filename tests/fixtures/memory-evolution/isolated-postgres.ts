import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import {
  loadGlobalMengshuConfig,
  provisionGlobalPostgresTestSchema,
  type GlobalPostgresConfig,
} from "../../live/global-postgres-config.js";

export function assertExplicitVerificationPaths(env: NodeJS.ProcessEnv = process.env) {
  for (const key of ["MENGSHU_CONFIG", "MENGSHU_ENV"] as const) {
    if (!env[key] || !isAbsolute(env[key]!) || env[key] !== env[key]!.trim()) {
      throw new Error(`Evolution live acceptance requires explicit absolute ${key}`);
    }
  }
  if (env.MENGSHU_EVOLUTION_ISOLATED_DB !== "1") {
    throw new Error("Evolution live acceptance requires MENGSHU_EVOLUTION_ISOLATED_DB=1 for a disposable database");
  }
  const configPath = resolve(env.MENGSHU_CONFIG!);
  const envPath = resolve(env.MENGSHU_ENV!);
  const globalRoot = join(homedir(), ".mengshu");
  if (configPath === join(globalRoot, "config.json") || envPath === join(globalRoot, ".env")) {
    throw new Error("Evolution live acceptance forbids the default global user configuration");
  }
  return { configPath, envPath };
}

export function assertLoopbackPostgres(postgres: Pick<GlobalPostgresConfig, "host" | "port">): void {
  if (!["127.0.0.1", "localhost", "::1"].includes(postgres.host) ||
      !Number.isSafeInteger(postgres.port) || postgres.port < 1 || postgres.port > 65535) {
    throw new Error("Evolution live acceptance permits only an explicitly configured loopback database");
  }
}

export async function provisionEvolutionVerificationSchema() {
  const paths = assertExplicitVerificationPaths();
  assertExplicitVerificationPaths({ ...process.env,
    MENGSHU_CONFIG: realpathSync(paths.configPath), MENGSHU_ENV: realpathSync(paths.envPath) });
  const global = loadGlobalMengshuConfig();
  assertLoopbackPostgres(global.postgres);
  const isolated = await provisionGlobalPostgresTestSchema("evolution_acceptance");
  return { ...isolated, config: global.config };
}
