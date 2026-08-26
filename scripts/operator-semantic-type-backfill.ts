import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import pg from "pg";

import {
  executePostgresSemanticTypeBackfill,
  rollbackPostgresSemanticTypeBackfill,
  SemanticTypeBackfillExecutorError,
  verifyPostgresSemanticTypeBackfill,
  type PostgresSemanticTypeBackfillClient,
} from "../packages/core/src/db/migrations/semantic-type-backfill-executor.js";
import {
  parseOperatorPostgresConfig,
  type OperatorPostgresConfig,
} from "./operator-scope-stage.js";

export interface SemanticTypeBackfillManifest {
  readonly version: 1;
  readonly migrationId: string;
  readonly mappingVersion: "kind-to-semantic-type/v1";
  readonly target: "memories.metadata.semanticType";
  readonly unmappable: "lookup_only";
}

export interface LoadedSemanticTypeBackfillManifest {
  readonly manifest: SemanticTypeBackfillManifest;
  readonly sha256: string;
}

export interface SemanticTypeBackfillOperatorConnection {
  readonly client: PostgresSemanticTypeBackfillClient;
  readonly close: () => Promise<void>;
}

export interface SemanticTypeBackfillOperatorDependencies {
  readonly readText: (path: string) => string;
  readonly connect: (config: OperatorPostgresConfig) => Promise<SemanticTypeBackfillOperatorConnection>;
}

export type SemanticTypeBackfillOperatorErrorCode =
  | "OPERATOR_INVALID_ARGUMENTS"
  | "OPERATOR_INVALID_CONFIG"
  | "OPERATOR_INVALID_MANIFEST"
  | "OPERATOR_APPLY_GATE_REQUIRED"
  | "OPERATOR_MANIFEST_MISMATCH"
  | "OPERATOR_FAILED";

const MESSAGES: Record<SemanticTypeBackfillOperatorErrorCode, string> = {
  OPERATOR_INVALID_ARGUMENTS: "Semantic type backfill operator arguments are invalid",
  OPERATOR_INVALID_CONFIG: "Semantic type backfill operator configuration is invalid",
  OPERATOR_INVALID_MANIFEST: "Semantic type backfill operator manifest is invalid",
  OPERATOR_APPLY_GATE_REQUIRED: "Semantic type backfill write operation requires explicit maintenance confirmation",
  OPERATOR_MANIFEST_MISMATCH: "Semantic type backfill manifest hash does not match the pinned value",
  OPERATOR_FAILED: "Semantic type backfill operator failed",
};

export class SemanticTypeBackfillOperatorError extends Error {
  constructor(readonly code: SemanticTypeBackfillOperatorErrorCode) {
    super(MESSAGES[code]);
    this.name = "SemanticTypeBackfillOperatorError";
  }
}

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function fail(code: SemanticTypeBackfillOperatorErrorCode): never {
  throw new SemanticTypeBackfillOperatorError(code);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function loadSemanticTypeBackfillManifest(
  text: string,
): LoadedSemanticTypeBackfillManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail("OPERATOR_INVALID_MANIFEST");
  }
  const keys = plainRecord(value) ? Object.keys(value).sort() : [];
  const expected = ["mappingVersion", "migrationId", "target", "unmappable", "version"];
  if (!plainRecord(value) || keys.length !== expected.length ||
      keys.some((key, index) => key !== expected[index]) || value.version !== 1 ||
      typeof value.migrationId !== "string" || !SAFE_ID.test(value.migrationId) ||
      value.mappingVersion !== "kind-to-semantic-type/v1" ||
      value.target !== "memories.metadata.semanticType" || value.unmappable !== "lookup_only") {
    fail("OPERATOR_INVALID_MANIFEST");
  }
  const manifest: SemanticTypeBackfillManifest = Object.freeze({
    version: 1,
    migrationId: value.migrationId,
    mappingVersion: value.mappingVersion,
    target: value.target,
    unmappable: value.unmappable,
  });
  return Object.freeze({
    manifest,
    sha256: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
  });
}

type Operation = "dry-run" | "apply" | "verify" | "rollback";

interface CliArgs {
  readonly configPath: string;
  readonly manifestPath: string;
  readonly operation: Operation;
  readonly maintenance: boolean;
  readonly quiescenceConfirmed: boolean;
  readonly manifestSha256?: string;
  readonly confirmationToken?: string;
  readonly batchSize?: number;
}

function cliArgs(argv: readonly string[]): CliArgs {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const configPath = value("--config");
  const manifestPath = value("--manifest");
  const operations = ["--apply", "--verify", "--rollback"].filter((flag) => argv.includes(flag));
  const rawBatchSize = value("--batch-size");
  const batchSize = rawBatchSize === undefined ? undefined : Number(rawBatchSize);
  if (!configPath || !manifestPath || operations.length > 1 ||
      (batchSize !== undefined && (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1_000))) {
    fail("OPERATOR_INVALID_ARGUMENTS");
  }
  return {
    configPath,
    manifestPath,
    operation: operations[0] === "--apply" ? "apply"
      : operations[0] === "--verify" ? "verify"
      : operations[0] === "--rollback" ? "rollback" : "dry-run",
    maintenance: argv.includes("--maintenance"),
    quiescenceConfirmed: argv.includes("--quiescence-confirmed"),
    manifestSha256: value("--manifest-sha256"),
    confirmationToken: value("--confirmation-token"),
    batchSize,
  };
}

function assertWriteGate(args: CliArgs, loaded: LoadedSemanticTypeBackfillManifest): void {
  if (args.operation !== "apply" && args.operation !== "rollback") return;
  if (!args.manifestSha256 || !args.confirmationToken ||
      args.maintenance !== true || args.quiescenceConfirmed !== true) {
    fail("OPERATOR_APPLY_GATE_REQUIRED");
  }
  if (!SHA256.test(args.manifestSha256) || args.manifestSha256 !== loaded.sha256) {
    fail("OPERATOR_MANIFEST_MISMATCH");
  }
  const expected = `${args.operation === "apply" ? "APPLY" : "ROLLBACK"}:${loaded.manifest.migrationId}`;
  if (args.confirmationToken !== expected) {
    fail("OPERATOR_APPLY_GATE_REQUIRED");
  }
}

const DEFAULT_DEPENDENCIES: SemanticTypeBackfillOperatorDependencies = {
  readText: (path) => readFileSync(path, "utf8"),
  connect: async (config) => {
    const pool = new pg.Pool({ ...config, max: 1 });
    const connection = await pool.connect();
    return {
      client: connection as unknown as PostgresSemanticTypeBackfillClient,
      close: async () => {
        connection.release();
        await pool.end();
      },
    };
  },
};

export async function runSemanticTypeBackfillOperator(
  argv: readonly string[],
  dependencies: SemanticTypeBackfillOperatorDependencies = DEFAULT_DEPENDENCIES,
): Promise<Record<string, unknown>> {
  const args = cliArgs(argv);
  let loaded: LoadedSemanticTypeBackfillManifest;
  let config: OperatorPostgresConfig;
  try {
    loaded = loadSemanticTypeBackfillManifest(dependencies.readText(args.manifestPath));
    config = parseOperatorPostgresConfig(dependencies.readText(args.configPath));
  } catch (error) {
    if (error instanceof SemanticTypeBackfillOperatorError) throw error;
    fail("OPERATOR_INVALID_CONFIG");
  }
  assertWriteGate(args, loaded);

  const connection = await dependencies.connect(config).catch(() => fail("OPERATOR_FAILED"));
  try {
    if (args.operation === "dry-run") {
      await connection.client.query("BEGIN READ ONLY");
      try {
        const result = await executePostgresSemanticTypeBackfill(connection.client, {
          migrationId: loaded.manifest.migrationId,
          manifestHash: loaded.sha256,
          ...(args.batchSize === undefined ? {} : { batchSize: args.batchSize }),
        });
        await connection.client.query("ROLLBACK");
        return { operation: "dry-run", ...result };
      } catch (error) {
        await connection.client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }
    if (args.operation === "verify") {
      await connection.client.query("BEGIN READ ONLY");
      try {
        const result = await verifyPostgresSemanticTypeBackfill(connection.client, {
          migrationId: loaded.manifest.migrationId,
          manifestHash: loaded.sha256,
        });
        await connection.client.query("ROLLBACK");
        return { operation: "verify", ...result };
      } catch (error) {
        await connection.client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }
    if (args.operation === "rollback") {
      const result = await rollbackPostgresSemanticTypeBackfill(connection.client, {
        migrationId: loaded.manifest.migrationId,
        manifestHash: loaded.sha256,
        maintenance: true,
        quiescenceConfirmed: true,
      });
      return { operation: "rollback", ...result };
    }
    const result = await executePostgresSemanticTypeBackfill(connection.client, {
      migrationId: loaded.manifest.migrationId,
      manifestHash: loaded.sha256,
      mode: "apply",
      maintenance: true,
      quiescenceConfirmed: true,
      ...(args.batchSize === undefined ? {} : { batchSize: args.batchSize }),
    });
    return { operation: "apply", ...result };
  } catch (error) {
    if (error instanceof SemanticTypeBackfillOperatorError ||
        error instanceof SemanticTypeBackfillExecutorError) throw error;
    fail("OPERATOR_FAILED");
  } finally {
    await connection.close().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSemanticTypeBackfillOperator(process.argv.slice(2))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      const output = error instanceof SemanticTypeBackfillOperatorError ||
          error instanceof SemanticTypeBackfillExecutorError
        ? { code: error.code, message: error.message }
        : { code: "OPERATOR_FAILED", message: MESSAGES.OPERATOR_FAILED };
      process.stderr.write(`${JSON.stringify(output)}\n`);
      process.exitCode = 1;
    });
}
