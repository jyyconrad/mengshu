import fs from "node:fs";
import { randomUUID } from "node:crypto";

import { config as loadDotEnv } from "dotenv";
import pg from "pg";

import { memoryConfigSchema, type MemoryConfig } from "../../config.js";
import {
  expandHome,
  resolveConfigPath,
  resolveEnvPath,
} from "../../packages/core/src/runtime/paths.js";

export interface GlobalPostgresConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  readonly ssl: boolean;
}

export interface GlobalMengshuConfig {
  readonly configPath: string;
  readonly config: MemoryConfig;
  readonly postgres: GlobalPostgresConfig;
}

export interface IsolatedGlobalPostgresTestSchema {
  readonly postgres: GlobalPostgresConfig;
  readonly schema: string;
  dispose(): Promise<void>;
}

const { Client } = pg;
const TEST_SCHEMA_RE = /^mengshu_[a-z0-9_]{1,40}_[0-9a-f]{12}$/;

function schemaAdminConfig(postgres: GlobalPostgresConfig): pg.ClientConfig {
  return { ...postgres, options: "-c search_path=public" };
}

export function parseGlobalPostgresConfig(value: unknown): GlobalPostgresConfig {
  const config = memoryConfigSchema.parse(value);
  if (config.dbType !== "postgres" || !config.postgres) {
    throw new Error("mengshu global config must select dbType=postgres");
  }
  return Object.freeze({
    host: config.postgres.host,
    port: config.postgres.port,
    database: config.postgres.database,
    user: config.postgres.user,
    password: config.postgres.password,
    ssl: config.postgres.ssl ?? false,
  });
}

/** Live gates reuse operator-owned middleware and never start PostgreSQL. */
export function loadGlobalMengshuConfig(): GlobalMengshuConfig {
  const explicitEnvPath = process.env.MENGSHU_ENV?.trim();
  const envPath = explicitEnvPath ? expandHome(explicitEnvPath) : resolveEnvPath();
  if (fs.existsSync(envPath)) {
    loadDotEnv({ path: envPath, override: false, quiet: true });
  }

  const explicitConfigPath = process.env.MENGSHU_CONFIG?.trim();
  const configPath = explicitConfigPath ? expandHome(explicitConfigPath) : resolveConfigPath();
  if (!fs.existsSync(configPath)) {
    throw new Error(`mengshu global config not found: ${configPath}`);
  }

  const config = memoryConfigSchema.parse(JSON.parse(fs.readFileSync(configPath, "utf8")));
  const postgres = parseGlobalPostgresConfig(config);
  return Object.freeze({ configPath, config, postgres });
}

export function loadGlobalPostgresConfig(): GlobalPostgresConfig {
  return loadGlobalMengshuConfig().postgres;
}

/**
 * Creates an isolated schema inside the operator-configured PostgreSQL service.
 * The caller still uses the production Postgres config. The isolated schema is
 * first so unqualified tables cannot land in public; public remains visible only
 * for shared extension types such as pgvector's `vector`.
 */
export async function provisionGlobalPostgresTestSchema(
  label: string,
): Promise<IsolatedGlobalPostgresTestSchema> {
  const normalized = label.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40);
  const schema = `mengshu_${normalized}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  if (!TEST_SCHEMA_RE.test(schema)) {
    throw new Error("invalid isolated PostgreSQL test schema name");
  }

  const postgres = loadGlobalPostgresConfig();
  const admin = new Client(schemaAdminConfig(postgres));
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA "${schema}" AUTHORIZATION CURRENT_USER`);
  } finally {
    await admin.end();
  }

  const previousPgOptions = process.env.PGOPTIONS;
  process.env.PGOPTIONS = `-c search_path=${schema},public`;
  let disposed = false;
  return Object.freeze({
    postgres,
    schema,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      if (previousPgOptions === undefined) delete process.env.PGOPTIONS;
      else process.env.PGOPTIONS = previousPgOptions;
      const cleanup = new Client(schemaAdminConfig(postgres));
      await cleanup.connect();
      try {
        await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await cleanup.end();
      }
    },
  });
}
