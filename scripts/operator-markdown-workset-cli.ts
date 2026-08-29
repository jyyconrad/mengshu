import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import pg from "pg";

import { memoryConfigSchema } from "../config.js";
import type { MemoryConfig } from "../config.js";
import {
  MarkdownWorksetImporter,
  markdownWorksetActivationConfirmationToken,
  prepareMarkdownWorksetImport,
  type MarkdownWorksetImportActivationReceipt,
  type MarkdownWorksetImportPlan,
} from "../packages/core/src/db/migrations/markdown-workset-importer.js";
import {
  loadMarkdownWorksetBundle,
  runPostgresMarkdownWorksetExport,
  writeGovernedMarkdownWorkset,
  type LoadedMarkdownWorksetBundle,
  type MarkdownWorksetPostgresQueryClient,
  type RunPostgresMarkdownWorksetExportInput,
  type WriteGovernedMarkdownWorksetInput,
} from "./operator-markdown-workset.js";
import {
  PostgresMarkdownWorksetImportActivationPort,
} from "./postgres-markdown-workset-import.js";
import {
  runMarkdownWorksetPreprocess,
  type RunMarkdownWorksetPreprocessInput,
} from "./operator-markdown-workset-preprocess.js";

export type MarkdownWorksetOperatorOperation =
  | "export"
  | "preprocess"
  | "govern"
  | "plan-import"
  | "activate-import"
  | "rollback-import";

interface BaseArgs {
  readonly operation: MarkdownWorksetOperatorOperation;
}

export interface MarkdownWorksetExportArgs extends BaseArgs {
  readonly operation: "export";
  readonly configPath: string;
  readonly containmentRoot: string;
  readonly outputDirectory: string;
  readonly runId: string;
  readonly policyVersion: string;
  readonly pageSize?: number;
  readonly writeConcurrency?: number;
}

export interface MarkdownWorksetGovernArgs extends BaseArgs {
  readonly operation: "govern";
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly containmentRoot: string;
  readonly outputDirectory: string;
  readonly policyVersion: string;
}

export interface MarkdownWorksetPreprocessArgs extends BaseArgs {
  readonly operation: "preprocess";
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly containmentRoot: string;
  readonly outputDirectory: string;
  readonly policyVersion: string;
  readonly concurrency?: number;
}

export interface MarkdownWorksetPlanImportArgs extends BaseArgs {
  readonly operation: "plan-import";
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly mode: "dry_run" | "prepare";
}

export interface MarkdownWorksetActivateArgs extends BaseArgs {
  readonly operation: "activate-import";
  readonly configPath: string;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly sourceManifestSha256: string;
  readonly expectedCurrentSnapshotSha256: string;
  readonly idempotencyKey: string;
  readonly confirmationToken: string;
  readonly maintenanceMode: true;
  readonly quiescenceConfirmed: true;
}

export interface MarkdownWorksetRollbackArgs extends BaseArgs {
  readonly operation: "rollback-import";
  readonly configPath: string;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly sourceManifestSha256: string;
  readonly expectedCurrentSnapshotSha256: string;
  readonly idempotencyKey: string;
  readonly confirmationToken: string;
  readonly activationReceiptPath: string;
  readonly maintenanceMode: true;
  readonly quiescenceConfirmed: true;
}

export type MarkdownWorksetOperatorArgs =
  | MarkdownWorksetExportArgs
  | MarkdownWorksetPreprocessArgs
  | MarkdownWorksetGovernArgs
  | MarkdownWorksetPlanImportArgs
  | MarkdownWorksetActivateArgs
  | MarkdownWorksetRollbackArgs;

export interface MarkdownWorksetOperatorCliConnection {
  readonly client: MarkdownWorksetPostgresQueryClient;
  readonly close: () => Promise<void>;
}

export interface MarkdownWorksetOperatorCliDependencies {
  readonly loadPostgresConfig: (path: string) => MemoryConfig["postgres"];
  readonly connect: (
    config: NonNullable<MemoryConfig["postgres"]>,
  ) => Promise<MarkdownWorksetOperatorCliConnection>;
  readonly runExport: typeof runPostgresMarkdownWorksetExport;
  readonly runPreprocess: (input: RunMarkdownWorksetPreprocessInput) =>
    ReturnType<typeof runMarkdownWorksetPreprocess>;
  readonly loadBundle: typeof loadMarkdownWorksetBundle;
  readonly writeGoverned: typeof writeGovernedMarkdownWorkset;
  readonly prepareImport: typeof prepareMarkdownWorksetImport;
  readonly createImporter: (
    config: NonNullable<MemoryConfig["postgres"]>,
    options: Readonly<{ sourceManifestHash: string; sourceSnapshotHash: string }>,
  ) => Promise<Readonly<{ importer: MarkdownWorksetImporter; close: () => Promise<void> }>>;
  readonly clock: () => string;
}

export type MarkdownWorksetOperatorReport =
  | Readonly<{
      operation: "export" | "preprocess" | "govern";
      runId: string;
      sourceCount: number;
      snapshotSha256: string;
      manifestPath: string;
      manifestSha256: string;
      inventorySha256?: string;
    }>
  | Readonly<{
      operation: "plan-import";
      mode: "dry_run" | "prepare";
      runId: string;
      manifestHash: string;
      verifyHash: string;
      planHash: string;
      stageHash: string;
      sourceTotal: number;
      liveTargetTotal: number;
      archiveTotal: number;
      quarantineTotal: number;
      unresolvedTotal: number;
      expectedCurrentSnapshotHash: string;
      activationConfirmationToken: string;
    }>
  | Readonly<{
      operation: "activate-import" | "rollback-import";
      runId: string;
      receiptHash: string;
      beforeSnapshotHash: string;
      afterSnapshotHash: string;
      activationReceipt?: MarkdownWorksetImportActivationReceipt;
    }>;

export class MarkdownWorksetOperatorCliError extends Error {
  constructor(readonly code: "INVALID_ARGUMENTS" | "INVALID_CONFIG" | "OPERATOR_FAILED") {
    super(code === "INVALID_ARGUMENTS"
      ? "Markdown workset operator arguments are invalid"
      : code === "INVALID_CONFIG"
        ? "Markdown workset PostgreSQL config is invalid"
        : "Markdown workset operator failed");
    this.name = "MarkdownWorksetOperatorCliError";
  }
}

const HASH = /^[0-9a-f]{64}$/;
const SAFE_TEXT = /^[^\s\u0000-\u001f\u007f]{1,256}$/;
const OPERATIONS = new Set<MarkdownWorksetOperatorOperation>([
  "export", "preprocess", "govern", "plan-import", "activate-import", "rollback-import",
]);

function fail(code: MarkdownWorksetOperatorCliError["code"]): never {
  throw new MarkdownWorksetOperatorCliError(code);
}

function parseOptions(argv: readonly string[]): ReadonlyMap<string, string | true> {
  const options = new Map<string, string | true>();
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (!flag.startsWith("--") || options.has(flag)) fail("INVALID_ARGUMENTS");
    if (["--prepare", "--maintenance", "--quiescence-confirmed"].includes(flag)) {
      options.set(flag, true);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail("INVALID_ARGUMENTS");
    options.set(flag, value);
    index += 1;
  }
  return options;
}

function exactOptions(
  options: ReadonlyMap<string, string | true>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((flag) => typeof options.get(flag) !== "string") ||
      [...options.keys()].some((flag) => !allowed.has(flag))) fail("INVALID_ARGUMENTS");
}

function textOption(options: ReadonlyMap<string, string | true>, flag: string): string {
  const value = options.get(flag);
  if (typeof value !== "string" || !SAFE_TEXT.test(value)) fail("INVALID_ARGUMENTS");
  return value;
}

function pathOption(options: ReadonlyMap<string, string | true>, flag: string): string {
  const value = options.get(flag);
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) {
    fail("INVALID_ARGUMENTS");
  }
  return value;
}

function hashOption(options: ReadonlyMap<string, string | true>): string {
  const value = options.get("--manifest-sha256");
  if (typeof value !== "string" || !HASH.test(value)) fail("INVALID_ARGUMENTS");
  return value;
}

function namedHashOption(
  options: ReadonlyMap<string, string | true>,
  flag: string,
): string {
  const value = options.get(flag);
  if (typeof value !== "string" || !HASH.test(value)) fail("INVALID_ARGUMENTS");
  return value;
}

function tokenOption(options: ReadonlyMap<string, string | true>, flag: string): string {
  const value = options.get(flag);
  if (typeof value !== "string" || value.length < 1 || value.length > 2048 ||
      /[\u0000-\u001f\u007f]/.test(value)) fail("INVALID_ARGUMENTS");
  return value;
}

export function parseMarkdownWorksetOperatorArgs(
  argv: readonly string[],
): MarkdownWorksetOperatorArgs {
  const operation = argv[0];
  if (typeof operation !== "string" || !OPERATIONS.has(operation as MarkdownWorksetOperatorOperation)) {
    fail("INVALID_ARGUMENTS");
  }
  const options = parseOptions(argv);
  if (operation === "export") {
    exactOptions(options, [
      "--config", "--containment-root", "--output", "--run-id", "--policy-version",
    ], ["--page-size", "--write-concurrency"]);
    const rawPageSize = options.get("--page-size");
    const pageSize = rawPageSize === undefined ? undefined : Number(rawPageSize);
    if (pageSize !== undefined &&
        (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 10_000)) {
      fail("INVALID_ARGUMENTS");
    }
    const rawWriteConcurrency = options.get("--write-concurrency");
    const writeConcurrency = rawWriteConcurrency === undefined
      ? undefined
      : Number(rawWriteConcurrency);
    if (writeConcurrency !== undefined &&
        (!Number.isSafeInteger(writeConcurrency) || writeConcurrency < 1 ||
          writeConcurrency > 64)) {
      fail("INVALID_ARGUMENTS");
    }
    return Object.freeze({
      operation,
      configPath: pathOption(options, "--config"),
      containmentRoot: pathOption(options, "--containment-root"),
      outputDirectory: pathOption(options, "--output"),
      runId: textOption(options, "--run-id"),
      policyVersion: textOption(options, "--policy-version"),
      ...(pageSize ? { pageSize } : {}),
      ...(writeConcurrency ? { writeConcurrency } : {}),
    });
  }
  if (operation === "govern") {
    exactOptions(options, [
      "--manifest", "--manifest-sha256", "--containment-root", "--output",
      "--policy-version",
    ]);
    return Object.freeze({
      operation,
      manifestPath: pathOption(options, "--manifest"),
      manifestSha256: hashOption(options),
      containmentRoot: pathOption(options, "--containment-root"),
      outputDirectory: pathOption(options, "--output"),
      policyVersion: textOption(options, "--policy-version"),
    });
  }
  if (operation === "preprocess") {
    exactOptions(options, [
      "--manifest", "--manifest-sha256", "--containment-root", "--output",
      "--policy-version",
    ], ["--concurrency"]);
    const rawConcurrency = options.get("--concurrency");
    const concurrency = rawConcurrency === undefined ? undefined : Number(rawConcurrency);
    if (concurrency !== undefined &&
        (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 64)) {
      fail("INVALID_ARGUMENTS");
    }
    return Object.freeze({
      operation: "preprocess" as const,
      manifestPath: pathOption(options, "--manifest"),
      manifestSha256: hashOption(options),
      containmentRoot: pathOption(options, "--containment-root"),
      outputDirectory: pathOption(options, "--output"),
      policyVersion: textOption(options, "--policy-version"),
      ...(concurrency ? { concurrency } : {}),
    });
  }
  if (operation === "plan-import") {
    exactOptions(options, ["--manifest", "--manifest-sha256"], ["--prepare"]);
    return Object.freeze({
      operation: "plan-import" as const,
      manifestPath: pathOption(options, "--manifest"),
      manifestSha256: hashOption(options),
      mode: options.get("--prepare") === true ? "prepare" : "dry_run",
    });
  }
  const required = [
    "--config", "--manifest", "--manifest-sha256", "--source-manifest-sha256",
    "--expected-current-snapshot-sha256", "--idempotency-key", "--confirmation-token",
  ];
  const optional = ["--maintenance", "--quiescence-confirmed"];
  if (operation === "rollback-import") required.push("--activation-receipt");
  exactOptions(options, required, optional);
  if (options.get("--maintenance") !== true || options.get("--quiescence-confirmed") !== true) {
    fail("INVALID_ARGUMENTS");
  }
  const common = {
    configPath: pathOption(options, "--config"),
    manifestPath: pathOption(options, "--manifest"),
    manifestSha256: hashOption(options),
    sourceManifestSha256: namedHashOption(options, "--source-manifest-sha256"),
    expectedCurrentSnapshotSha256: namedHashOption(
      options, "--expected-current-snapshot-sha256",
    ),
    idempotencyKey: textOption(options, "--idempotency-key"),
    confirmationToken: tokenOption(options, "--confirmation-token"),
    maintenanceMode: true as const,
    quiescenceConfirmed: true as const,
  };
  return operation === "activate-import"
    ? Object.freeze({ operation: "activate-import" as const, ...common })
    : Object.freeze({
        operation: "rollback-import" as const,
        ...common,
        activationReceiptPath: pathOption(options, "--activation-receipt"),
      });
}

function loadPostgresConfig(path: string): NonNullable<MemoryConfig["postgres"]> {
  let config: MemoryConfig;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    config = memoryConfigSchema.parse({
      embedding: raw.embedding,
      dbType: raw.dbType,
      postgres: raw.postgres,
    });
  } catch {
    fail("INVALID_CONFIG");
  }
  if (config.dbType !== "postgres" || !config.postgres) fail("INVALID_CONFIG");
  return config.postgres;
}

const DEFAULT_DEPENDENCIES: MarkdownWorksetOperatorCliDependencies = {
  loadPostgresConfig,
  async connect(config): Promise<MarkdownWorksetOperatorCliConnection> {
    const pool = new pg.Pool({ ...config, max: 1 });
    const client = await pool.connect();
    return {
      client: {
        async query(sql, params = []) {
          const result = await client.query(sql, [...params]);
          return { rows: result.rows as unknown[] };
        },
      },
      close: async () => {
        client.release();
        await pool.end();
      },
    };
  },
  runExport: runPostgresMarkdownWorksetExport,
  runPreprocess: runMarkdownWorksetPreprocess,
  loadBundle: loadMarkdownWorksetBundle,
  writeGoverned: writeGovernedMarkdownWorkset,
  prepareImport: prepareMarkdownWorksetImport,
  async createImporter(config, options) {
    const pool = new pg.Pool({ ...config, max: 1 });
    const adapterPool = {
      async connect() {
        const client = await pool.connect();
        return {
          async query(sql: string, params: readonly unknown[] = []) {
            const result = await client.query(sql, [...params]);
            return { rows: result.rows as unknown[], rowCount: result.rowCount };
          },
          release: () => client.release(),
        };
      },
    };
    const port = new PostgresMarkdownWorksetImportActivationPort(adapterPool, options);
    return {
      importer: new MarkdownWorksetImporter(port),
      close: () => pool.end(),
    };
  },
  clock: () => new Date().toISOString(),
};

function importReport(plan: MarkdownWorksetImportPlan): MarkdownWorksetOperatorReport {
  const expectedCurrentSnapshotHash = plan.sourceSnapshotHash;
  return Object.freeze({
    operation: "plan-import",
    mode: plan.mode,
    runId: plan.runId,
    manifestHash: plan.manifestHash,
    verifyHash: plan.verifyHash,
    planHash: plan.planHash,
    stageHash: plan.stageHash,
    sourceTotal: plan.counts.sourceTotal,
    liveTargetTotal: plan.counts.liveTargetTotal,
    archiveTotal: plan.counts.archiveTotal,
    quarantineTotal: plan.counts.quarantineTotal,
    unresolvedTotal: plan.counts.unresolvedTotal,
    expectedCurrentSnapshotHash,
    activationConfirmationToken: markdownWorksetActivationConfirmationToken({
      plan,
      expectedCurrentSnapshotHash,
    }),
  });
}

function activationReport(
  receipt: Awaited<ReturnType<MarkdownWorksetImporter["activate"]>>,
): MarkdownWorksetOperatorReport {
  return Object.freeze({
    operation: "activate-import",
    runId: receipt.runId,
    receiptHash: receipt.receiptHash,
    beforeSnapshotHash: receipt.beforeSnapshot.snapshotHash,
    afterSnapshotHash: receipt.afterSnapshot.snapshotHash,
    activationReceipt: receipt,
  });
}

function loadActivationReceipt(path: string): MarkdownWorksetImportActivationReceipt {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && "activationReceipt" in parsed) {
      return (parsed as { activationReceipt: MarkdownWorksetImportActivationReceipt })
        .activationReceipt;
    }
    return parsed as MarkdownWorksetImportActivationReceipt;
  } catch {
    fail("INVALID_ARGUMENTS");
  }
}

export async function runMarkdownWorksetOperatorCli(
  argv: readonly string[],
  dependencies: MarkdownWorksetOperatorCliDependencies = DEFAULT_DEPENDENCIES,
): Promise<MarkdownWorksetOperatorReport> {
  const args = parseMarkdownWorksetOperatorArgs(argv);
  if (args.operation === "export") {
    const config = dependencies.loadPostgresConfig(args.configPath);
    if (!config) fail("INVALID_CONFIG");
    const connection = await dependencies.connect(config);
    try {
      const input: RunPostgresMarkdownWorksetExportInput = {
        client: connection.client,
        containmentRoot: args.containmentRoot,
        outputDirectory: args.outputDirectory,
        migrationRunId: args.runId,
        policyVersion: args.policyVersion,
        createdAt: dependencies.clock(),
        pageSize: args.pageSize,
        writeConcurrency: args.writeConcurrency,
      };
      const result = await dependencies.runExport(input);
      return Object.freeze({
        operation: "export",
        runId: result.manifest.migrationRunId,
        sourceCount: result.manifest.sourceCount,
        snapshotSha256: result.manifest.snapshotSha256,
        manifestPath: result.manifestPath,
        manifestSha256: result.manifestSha256,
      });
    } finally {
      await connection.close();
    }
  }
  if (args.operation === "preprocess") {
    const result = await dependencies.runPreprocess({
      containmentRoot: args.containmentRoot,
      sourceManifestPath: args.manifestPath,
      sourceManifestSha256: args.manifestSha256,
      outputDirectory: args.outputDirectory,
      policyVersion: args.policyVersion,
      createdAt: dependencies.clock(),
      concurrency: args.concurrency,
    });
    return Object.freeze({
      operation: "preprocess",
      runId: result.manifest.migrationRunId,
      sourceCount: result.manifest.sourceCount,
      snapshotSha256: result.manifest.sourceSnapshotSha256,
      manifestPath: result.manifestPath,
      manifestSha256: result.manifestSha256,
      inventorySha256: result.inventory.inventorySha256,
    });
  }
  const source = await dependencies.loadBundle(args.manifestPath, args.manifestSha256);
  if (args.operation === "govern") {
    const input: WriteGovernedMarkdownWorksetInput = {
      source,
      containmentRoot: args.containmentRoot,
      outputDirectory: args.outputDirectory,
      policyVersion: args.policyVersion,
    };
    const result = await dependencies.writeGoverned(input);
    return Object.freeze({
      operation: "govern",
      runId: result.manifest.migrationRunId,
      sourceCount: result.manifest.sourceCount,
      snapshotSha256: result.manifest.snapshotSha256,
      manifestPath: result.manifestPath,
      manifestSha256: result.manifestSha256,
    });
  }
  if (args.operation === "plan-import") {
    return importReport(dependencies.prepareImport({
      mode: args.mode,
      manifest: source.manifest,
      files: source.files,
    }));
  }
  const config = dependencies.loadPostgresConfig(args.configPath);
  if (!config) fail("INVALID_CONFIG");
  const connection = await dependencies.createImporter(config, {
    sourceManifestHash: args.sourceManifestSha256,
    sourceSnapshotHash: source.manifest.snapshotSha256,
  });
  try {
    if (args.operation === "activate-import") {
      const plan = dependencies.prepareImport({
        mode: "prepare",
        manifest: source.manifest,
        files: source.files,
      });
      const receipt = await connection.importer.activate({
        plan,
        maintenanceMode: args.maintenanceMode,
        quiescenceConfirmed: args.quiescenceConfirmed,
        manifestHash: args.manifestSha256,
        verifyHash: plan.verifyHash,
        expectedCurrentSnapshotHash: args.expectedCurrentSnapshotSha256,
        idempotencyKey: args.idempotencyKey,
        confirmationToken: args.confirmationToken,
      });
      return activationReport(receipt);
    }
    const receipt = await connection.importer.rollback({
      activationReceipt: loadActivationReceipt(args.activationReceiptPath),
      maintenanceMode: args.maintenanceMode,
      quiescenceConfirmed: args.quiescenceConfirmed,
      expectedCurrentSnapshotHash: args.expectedCurrentSnapshotSha256,
      idempotencyKey: args.idempotencyKey,
      confirmationToken: args.confirmationToken,
    });
    return Object.freeze({
      operation: "rollback-import",
      runId: receipt.runId,
      receiptHash: receipt.receiptHash,
      beforeSnapshotHash: args.expectedCurrentSnapshotSha256,
      afterSnapshotHash: receipt.restoredSnapshot.snapshotHash,
    });
  } finally {
    await connection.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMarkdownWorksetOperatorCli(process.argv.slice(2))
    .then((report) => process.stdout.write(`${JSON.stringify(report)}\n`))
    .catch((error) => {
      const safe = error instanceof MarkdownWorksetOperatorCliError
        ? { code: error.code, message: error.message }
        : { code: "OPERATOR_FAILED", message: "Markdown workset operator failed" };
      process.stderr.write(`${JSON.stringify(safe)}\n`);
      process.exitCode = 1;
    });
}
