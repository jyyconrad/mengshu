import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { types as nodeUtilTypes } from "node:util";
import { createHash } from "node:crypto";

import {
  createMarkdownScopeRegistry,
  parseMarkdownScopeRegistry,
  serializeMarkdownScopeRegistry,
} from "../packages/core/src/db/migrations/markdown-scope-registry.js";
import { parseNativeRecordMarkdown } from "../packages/core/src/db/migrations/markdown-workset.js";
import { loadMarkdownWorksetBundle } from "./operator-markdown-workset.js";

export interface RunMarkdownScopeRegistryInput {
  readonly containmentRoot: string;
  readonly sourceManifestPath: string;
  readonly sourceManifestFileSha256: string;
  readonly expectedSourceCount: number;
  readonly outputPath: string;
  readonly createdAt: string;
}

export interface RunMarkdownScopeRegistryResult {
  readonly outputPath: string;
  readonly outputFileSha256: string;
  readonly registrySha256: string;
  readonly sourceCount: number;
  readonly scopedSourceCount: number;
  readonly unscopedSourceCount: number;
  readonly scopeCount: number;
}

export type MarkdownScopeRegistryOperatorErrorCode =
  | "MARKDOWN_SCOPE_REGISTRY_OPERATOR_INVALID_ARGUMENT"
  | "MARKDOWN_SCOPE_REGISTRY_OPERATOR_PATH_ESCAPE"
  | "MARKDOWN_SCOPE_REGISTRY_OPERATOR_SYMLINK"
  | "MARKDOWN_SCOPE_REGISTRY_OPERATOR_INPUT_DRIFT"
  | "MARKDOWN_SCOPE_REGISTRY_OPERATOR_OUTPUT_EXISTS"
  | "MARKDOWN_SCOPE_REGISTRY_OPERATOR_REGISTRY_REJECTED"
  | "MARKDOWN_SCOPE_REGISTRY_OPERATOR_FILESYSTEM_ERROR";

const MESSAGES: Readonly<Record<MarkdownScopeRegistryOperatorErrorCode, string>> = {
  MARKDOWN_SCOPE_REGISTRY_OPERATOR_INVALID_ARGUMENT: "Markdown scope registry argument is invalid",
  MARKDOWN_SCOPE_REGISTRY_OPERATOR_PATH_ESCAPE: "Markdown scope registry path escapes containment",
  MARKDOWN_SCOPE_REGISTRY_OPERATOR_SYMLINK: "Markdown scope registry rejects symlink path",
  MARKDOWN_SCOPE_REGISTRY_OPERATOR_INPUT_DRIFT: "Markdown scope registry input drifted",
  MARKDOWN_SCOPE_REGISTRY_OPERATOR_OUTPUT_EXISTS: "Markdown scope registry output already exists",
  MARKDOWN_SCOPE_REGISTRY_OPERATOR_REGISTRY_REJECTED: "Markdown scope registry rejected source scope",
  MARKDOWN_SCOPE_REGISTRY_OPERATOR_FILESYSTEM_ERROR: "Markdown scope registry filesystem operation failed",
};

export class MarkdownScopeRegistryOperatorError extends Error {
  constructor(readonly code: MarkdownScopeRegistryOperatorErrorCode) {
    super(MESSAGES[code]);
    this.name = "MarkdownScopeRegistryOperatorError";
  }
}

const SHA256 = /^[0-9a-f]{64}$/;
const INPUT_KEYS = [
  "containmentRoot", "sourceManifestPath", "sourceManifestFileSha256",
  "expectedSourceCount", "outputPath", "createdAt",
] as const;

function fail(code: MarkdownScopeRegistryOperatorErrorCode): never {
  throw new MarkdownScopeRegistryOperatorError(code);
}

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      nodeUtilTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function strictDescendant(root: string, target: string): boolean {
  const child = relative(root, target);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function assertOutputPath(input: RunMarkdownScopeRegistryInput): Promise<void> {
  if (!isAbsolute(input.containmentRoot) || !isAbsolute(input.outputPath) ||
      resolve(input.containmentRoot) !== input.containmentRoot ||
      resolve(input.outputPath) !== input.outputPath ||
      !strictDescendant(input.containmentRoot, input.outputPath)) {
    fail("MARKDOWN_SCOPE_REGISTRY_OPERATOR_PATH_ESCAPE");
  }
  let rootInfo;
  let parentInfo;
  try {
    [rootInfo, parentInfo] = await Promise.all([
      lstat(input.containmentRoot),
      lstat(dirname(input.outputPath)),
    ]);
  } catch {
    fail("MARKDOWN_SCOPE_REGISTRY_OPERATOR_FILESYSTEM_ERROR");
  }
  if (rootInfo.isSymbolicLink() || parentInfo.isSymbolicLink()) {
    fail("MARKDOWN_SCOPE_REGISTRY_OPERATOR_SYMLINK");
  }
  if (!rootInfo.isDirectory() || !parentInfo.isDirectory()) {
    fail("MARKDOWN_SCOPE_REGISTRY_OPERATOR_FILESYSTEM_ERROR");
  }
}

async function writeExclusive(path: string, content: string): Promise<void> {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      fail("MARKDOWN_SCOPE_REGISTRY_OPERATOR_OUTPUT_EXISTS");
    }
    if (errorCode(error) === "ELOOP") fail("MARKDOWN_SCOPE_REGISTRY_OPERATOR_SYMLINK");
    fail("MARKDOWN_SCOPE_REGISTRY_OPERATOR_FILESYSTEM_ERROR");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function runMarkdownScopeRegistry(
  input: RunMarkdownScopeRegistryInput,
): Promise<RunMarkdownScopeRegistryResult> {
  if (!plainRecord(input) || !exactKeys(input, INPUT_KEYS) ||
      !isAbsolute(input.sourceManifestPath) ||
      resolve(input.sourceManifestPath) !== input.sourceManifestPath ||
      typeof input.sourceManifestFileSha256 !== "string" ||
      !SHA256.test(input.sourceManifestFileSha256) ||
      !Number.isSafeInteger(input.expectedSourceCount) || input.expectedSourceCount < 0 ||
      !validIso(input.createdAt)) {
    fail("MARKDOWN_SCOPE_REGISTRY_OPERATOR_INVALID_ARGUMENT");
  }
  await assertOutputPath(input);
  let bundle;
  try {
    bundle = await loadMarkdownWorksetBundle(
      input.sourceManifestPath,
      input.sourceManifestFileSha256,
    );
  } catch {
    fail("MARKDOWN_SCOPE_REGISTRY_OPERATOR_INPUT_DRIFT");
  }
  if (bundle.manifest.phase !== "source" ||
      bundle.manifest.sourceCount !== input.expectedSourceCount ||
      bundle.files.length !== input.expectedSourceCount) {
    fail("MARKDOWN_SCOPE_REGISTRY_OPERATOR_INPUT_DRIFT");
  }
  let registry;
  try {
    registry = createMarkdownScopeRegistry({
      migrationRunId: bundle.manifest.migrationRunId,
      sourceManifestFileSha256: input.sourceManifestFileSha256,
      sourceSnapshotSha256: bundle.manifest.snapshotSha256,
      createdAt: input.createdAt,
      records: bundle.files.map((file) => parseNativeRecordMarkdown(file.markdown)),
    });
  } catch {
    fail("MARKDOWN_SCOPE_REGISTRY_OPERATOR_REGISTRY_REJECTED");
  }
  const serialized = serializeMarkdownScopeRegistry(registry);
  const parsed = parseMarkdownScopeRegistry(serialized);
  await writeExclusive(input.outputPath, serialized);
  return Object.freeze({
    outputPath: input.outputPath,
    outputFileSha256: sha256(serialized),
    registrySha256: parsed.registrySha256,
    sourceCount: parsed.summary.sourceCount,
    scopedSourceCount: parsed.summary.scopedSourceCount,
    unscopedSourceCount: parsed.summary.unscopedSourceCount,
    scopeCount: parsed.summary.scopeCount,
  });
}

function parseCliArgs(argv: readonly string[]): RunMarkdownScopeRegistryInput {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key || !value || !key.startsWith("--") || values.has(key)) {
      fail("MARKDOWN_SCOPE_REGISTRY_OPERATOR_INVALID_ARGUMENT");
    }
    values.set(key, value);
  }
  const required = [
    "--containment-root", "--source-manifest", "--source-manifest-file-sha256",
    "--expected-source-count", "--output", "--created-at",
  ];
  if (argv.length !== required.length * 2 || required.some((key) => !values.has(key))) {
    fail("MARKDOWN_SCOPE_REGISTRY_OPERATOR_INVALID_ARGUMENT");
  }
  return {
    containmentRoot: values.get("--containment-root")!,
    sourceManifestPath: values.get("--source-manifest")!,
    sourceManifestFileSha256: values.get("--source-manifest-file-sha256")!,
    expectedSourceCount: Number(values.get("--expected-source-count")),
    outputPath: values.get("--output")!,
    createdAt: values.get("--created-at")!,
  };
}

async function main(): Promise<void> {
  const result = await runMarkdownScopeRegistry(parseCliArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    const code = error instanceof MarkdownScopeRegistryOperatorError
      ? error.code : "MARKDOWN_SCOPE_REGISTRY_OPERATOR_FILESYSTEM_ERROR";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
