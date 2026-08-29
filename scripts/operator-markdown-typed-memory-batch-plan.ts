import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

import {
  parseTypedMemoryBatchPlan,
  planTypedMemoryBatches,
  serializeTypedMemoryBatchPlan,
  type TypedMemoryBatchPlan,
  type TypedMemoryClusterBindingInput,
  type TypedMemoryUnitResolutionInput,
} from "../packages/core/src/db/migrations/typed-memory-batch-plan.js";
import { parseMarkdownScopeRegistry } from
  "../packages/core/src/db/migrations/markdown-scope-registry.js";
import type { MemoryCurationBatchPlan } from
  "../packages/core/src/db/migrations/markdown-curation-batch-planner.js";

export interface RunMarkdownTypedMemoryBatchPlanInput {
  readonly containmentRoot: string;
  readonly memoryPlanPath: string;
  readonly memoryPlanFileSha256: string;
  readonly memoryPlanSemanticSha256: string;
  readonly unitResolutionsPath: string;
  readonly unitResolutionsFileSha256: string;
  readonly unitResolutionsSemanticSha256: string;
  readonly mergeSemanticClusterBindingsPath: string;
  readonly mergeSemanticClusterBindingsFileSha256: string;
  readonly mergeSemanticClusterBindingsSemanticSha256: string;
  readonly knowledgeResourceBindingsPath: string;
  readonly knowledgeResourceBindingsFileSha256: string;
  readonly scopeRegistryPath: string;
  readonly scopeRegistryFileSha256: string;
  readonly scopeRegistrySha256: string;
  readonly expectedMemorySourceCount: number;
  readonly expectedMemoryUnitCount: number;
  readonly policyVersion: string;
  readonly createdAt: string;
  readonly outputPath: string;
}

export interface RunMarkdownTypedMemoryBatchPlanResult {
  readonly outputPath: string;
  readonly outputFileSha256: string;
  readonly semanticPlanSha256: string;
  readonly eligibleUnits: number;
  readonly eligibleSources: number;
  readonly excludedUnits: number;
  readonly excludedSources: number;
  readonly batchCount: number;
  readonly mergeSemanticClusters: number;
}

export type MarkdownTypedMemoryBatchPlanOperatorErrorCode =
  | "MARKDOWN_TYPED_MEMORY_BATCH_PLAN_INVALID_ARGUMENT"
  | "MARKDOWN_TYPED_MEMORY_BATCH_PLAN_PATH_ESCAPE"
  | "MARKDOWN_TYPED_MEMORY_BATCH_PLAN_SYMLINK"
  | "MARKDOWN_TYPED_MEMORY_BATCH_PLAN_INPUT_DRIFT"
  | "MARKDOWN_TYPED_MEMORY_BATCH_PLAN_OUTPUT_EXISTS"
  | "MARKDOWN_TYPED_MEMORY_BATCH_PLAN_REJECTED"
  | "MARKDOWN_TYPED_MEMORY_BATCH_PLAN_FILESYSTEM_ERROR";

export class MarkdownTypedMemoryBatchPlanOperatorError extends Error {
  constructor(readonly code: MarkdownTypedMemoryBatchPlanOperatorErrorCode) {
    super(code);
    this.name = "MarkdownTypedMemoryBatchPlanOperatorError";
  }
}

const SHA256 = /^[0-9a-f]{64}$/;

function fail(code: MarkdownTypedMemoryBatchPlanOperatorErrorCode): never {
  throw new MarkdownTypedMemoryBatchPlanOperatorError(code);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function strictDescendant(root: string, target: string): boolean {
  const child = relative(root, target);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function assertNoSymlinkChain(root: string, target: string): Promise<void> {
  if (!isAbsolute(root) || !isAbsolute(target) || resolve(root) !== root ||
      resolve(target) !== target || !strictDescendant(root, target)) {
    fail("MARKDOWN_TYPED_MEMORY_BATCH_PLAN_PATH_ESCAPE");
  }
  let current = root;
  const parts = relative(root, target).split(sep);
  for (let index = 0; index < parts.length; index += 1) {
    current = resolve(current, parts[index]!);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (index === parts.length - 1 && errorCode(error) === "ENOENT") return;
      fail("MARKDOWN_TYPED_MEMORY_BATCH_PLAN_FILESYSTEM_ERROR");
    }
    if (info.isSymbolicLink()) fail("MARKDOWN_TYPED_MEMORY_BATCH_PLAN_SYMLINK");
    if (index < parts.length - 1 && !info.isDirectory()) {
      fail("MARKDOWN_TYPED_MEMORY_BATCH_PLAN_FILESYSTEM_ERROR");
    }
  }
}

async function readVerified(
  containmentRoot: string,
  path: string,
  expectedSha256: string,
): Promise<string> {
  if (!SHA256.test(expectedSha256)) fail("MARKDOWN_TYPED_MEMORY_BATCH_PLAN_INVALID_ARGUMENT");
  await assertNoSymlinkChain(containmentRoot, path);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) fail("MARKDOWN_TYPED_MEMORY_BATCH_PLAN_INPUT_DRIFT");
    const value = await handle.readFile("utf8");
    if (sha256(value) !== expectedSha256) fail("MARKDOWN_TYPED_MEMORY_BATCH_PLAN_INPUT_DRIFT");
    return value;
  } catch (error) {
    if (error instanceof MarkdownTypedMemoryBatchPlanOperatorError) throw error;
    if (errorCode(error) === "ELOOP") fail("MARKDOWN_TYPED_MEMORY_BATCH_PLAN_SYMLINK");
    fail("MARKDOWN_TYPED_MEMORY_BATCH_PLAN_FILESYSTEM_ERROR");
  } finally {
    await handle?.close().catch(() => undefined);
  }
  return fail("MARKDOWN_TYPED_MEMORY_BATCH_PLAN_FILESYSTEM_ERROR");
}

function parseJsonLines<T>(serialized: string): T[] {
  if (!serialized.endsWith("\n") || serialized.trim().length === 0) {
    fail("MARKDOWN_TYPED_MEMORY_BATCH_PLAN_INPUT_DRIFT");
  }
  try {
    return serialized.trimEnd().split("\n").map((line) => {
      if (line.trim() !== line || line.length === 0) {
        fail("MARKDOWN_TYPED_MEMORY_BATCH_PLAN_INPUT_DRIFT");
      }
      return JSON.parse(line) as T;
    });
  } catch (error) {
    if (error instanceof MarkdownTypedMemoryBatchPlanOperatorError) throw error;
    fail("MARKDOWN_TYPED_MEMORY_BATCH_PLAN_INPUT_DRIFT");
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
      fail("MARKDOWN_TYPED_MEMORY_BATCH_PLAN_OUTPUT_EXISTS");
    }
    if (errorCode(error) === "ELOOP") fail("MARKDOWN_TYPED_MEMORY_BATCH_PLAN_SYMLINK");
    fail("MARKDOWN_TYPED_MEMORY_BATCH_PLAN_FILESYSTEM_ERROR");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function runMarkdownTypedMemoryBatchPlan(
  input: RunMarkdownTypedMemoryBatchPlanInput,
): Promise<RunMarkdownTypedMemoryBatchPlanResult> {
  const pathFields = [
    input.memoryPlanPath, input.unitResolutionsPath,
    input.mergeSemanticClusterBindingsPath, input.knowledgeResourceBindingsPath,
    input.scopeRegistryPath, input.outputPath,
  ];
  const hashes = [
    input.memoryPlanFileSha256, input.memoryPlanSemanticSha256,
    input.unitResolutionsFileSha256, input.unitResolutionsSemanticSha256,
    input.mergeSemanticClusterBindingsFileSha256,
    input.mergeSemanticClusterBindingsSemanticSha256,
    input.knowledgeResourceBindingsFileSha256, input.scopeRegistryFileSha256,
    input.scopeRegistrySha256,
  ];
  if (!input || typeof input !== "object" || !isAbsolute(input.containmentRoot) ||
      resolve(input.containmentRoot) !== input.containmentRoot ||
      pathFields.some((path) => typeof path !== "string" || !isAbsolute(path) ||
        resolve(path) !== path || !strictDescendant(input.containmentRoot, path)) ||
      hashes.some((hash) => typeof hash !== "string" || !SHA256.test(hash)) ||
      !Number.isSafeInteger(input.expectedMemorySourceCount) ||
      input.expectedMemorySourceCount < 0 || !Number.isSafeInteger(input.expectedMemoryUnitCount) ||
      input.expectedMemoryUnitCount < 0 || typeof input.policyVersion !== "string" ||
      input.policyVersion.trim() !== input.policyVersion || !validIso(input.createdAt)) {
    fail("MARKDOWN_TYPED_MEMORY_BATCH_PLAN_INVALID_ARGUMENT");
  }
  await assertNoSymlinkChain(input.containmentRoot, input.outputPath);
  const [memoryPlanText, unitResolutionsText, clusterBindingsText, , scopeRegistryText] =
    await Promise.all([
      readVerified(input.containmentRoot, input.memoryPlanPath, input.memoryPlanFileSha256),
      readVerified(
        input.containmentRoot,
        input.unitResolutionsPath,
        input.unitResolutionsFileSha256,
      ),
      readVerified(
        input.containmentRoot,
        input.mergeSemanticClusterBindingsPath,
        input.mergeSemanticClusterBindingsFileSha256,
      ),
      readVerified(
        input.containmentRoot,
        input.knowledgeResourceBindingsPath,
        input.knowledgeResourceBindingsFileSha256,
      ),
      readVerified(
        input.containmentRoot,
        input.scopeRegistryPath,
        input.scopeRegistryFileSha256,
      ),
    ]);
  let memoryPlan: MemoryCurationBatchPlan;
  try {
    memoryPlan = JSON.parse(memoryPlanText) as MemoryCurationBatchPlan;
  } catch {
    fail("MARKDOWN_TYPED_MEMORY_BATCH_PLAN_INPUT_DRIFT");
  }
  let plan: TypedMemoryBatchPlan;
  try {
    plan = planTypedMemoryBatches({
      policyVersion: input.policyVersion,
      createdAt: input.createdAt,
      expectedMemorySourceCount: input.expectedMemorySourceCount,
      expectedMemoryUnitCount: input.expectedMemoryUnitCount,
      frozenHashes: {
        memoryPlanFileSha256: input.memoryPlanFileSha256,
        memoryPlanSemanticSha256: input.memoryPlanSemanticSha256,
        unitResolutionsFileSha256: input.unitResolutionsFileSha256,
        unitResolutionsSemanticSha256: input.unitResolutionsSemanticSha256,
        mergeSemanticClusterBindingsFileSha256:
          input.mergeSemanticClusterBindingsFileSha256,
        mergeSemanticClusterBindingsSemanticSha256:
          input.mergeSemanticClusterBindingsSemanticSha256,
        knowledgeResourceBindingsFileSha256: input.knowledgeResourceBindingsFileSha256,
        scopeRegistryFileSha256: input.scopeRegistryFileSha256,
        scopeRegistrySha256: input.scopeRegistrySha256,
      },
      scopeRegistry: parseMarkdownScopeRegistry(scopeRegistryText),
      memoryPlan,
      unitResolutions: parseJsonLines<TypedMemoryUnitResolutionInput>(unitResolutionsText),
      mergeSemanticClusterBindings:
        parseJsonLines<TypedMemoryClusterBindingInput>(clusterBindingsText),
    });
  } catch {
    fail("MARKDOWN_TYPED_MEMORY_BATCH_PLAN_REJECTED");
  }
  const serialized = serializeTypedMemoryBatchPlan(plan);
  const parsed = parseTypedMemoryBatchPlan(serialized);
  await writeExclusive(input.outputPath, serialized);
  return Object.freeze({
    outputPath: input.outputPath,
    outputFileSha256: sha256(serialized),
    semanticPlanSha256: parsed.semanticPlanSha256,
    eligibleUnits: parsed.summary.eligibleUnits,
    eligibleSources: parsed.summary.eligibleSources,
    excludedUnits: parsed.summary.excludedUnits,
    excludedSources: parsed.summary.excludedSources,
    batchCount: parsed.summary.batchCount,
    mergeSemanticClusters: parsed.summary.mergeSemanticClusters,
  });
}

const CLI_FIELDS: Readonly<Record<string, keyof RunMarkdownTypedMemoryBatchPlanInput>> = {
  "--containment-root": "containmentRoot",
  "--memory-plan": "memoryPlanPath",
  "--memory-plan-file-sha256": "memoryPlanFileSha256",
  "--memory-plan-semantic-sha256": "memoryPlanSemanticSha256",
  "--unit-resolutions": "unitResolutionsPath",
  "--unit-resolutions-file-sha256": "unitResolutionsFileSha256",
  "--unit-resolutions-semantic-sha256": "unitResolutionsSemanticSha256",
  "--cluster-bindings": "mergeSemanticClusterBindingsPath",
  "--cluster-bindings-file-sha256": "mergeSemanticClusterBindingsFileSha256",
  "--cluster-bindings-semantic-sha256": "mergeSemanticClusterBindingsSemanticSha256",
  "--knowledge-bindings": "knowledgeResourceBindingsPath",
  "--knowledge-bindings-file-sha256": "knowledgeResourceBindingsFileSha256",
  "--scope-registry": "scopeRegistryPath",
  "--scope-registry-file-sha256": "scopeRegistryFileSha256",
  "--scope-registry-semantic-sha256": "scopeRegistrySha256",
  "--expected-memory-sources": "expectedMemorySourceCount",
  "--expected-memory-units": "expectedMemoryUnitCount",
  "--policy-version": "policyVersion",
  "--created-at": "createdAt",
  "--output": "outputPath",
};

function parseCli(argv: readonly string[]): RunMarkdownTypedMemoryBatchPlanInput {
  const values: Record<string, string | number> = {};
  if (argv.length !== Object.keys(CLI_FIELDS).length * 2) {
    fail("MARKDOWN_TYPED_MEMORY_BATCH_PLAN_INVALID_ARGUMENT");
  }
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]!;
    const value = argv[index + 1];
    const field = CLI_FIELDS[key];
    if (!field || value === undefined || Object.prototype.hasOwnProperty.call(values, field)) {
      fail("MARKDOWN_TYPED_MEMORY_BATCH_PLAN_INVALID_ARGUMENT");
    }
    values[field] = field === "expectedMemorySourceCount" || field === "expectedMemoryUnitCount"
      ? Number(value) : value;
  }
  return values as unknown as RunMarkdownTypedMemoryBatchPlanInput;
}

async function main(): Promise<void> {
  const result = await runMarkdownTypedMemoryBatchPlan(parseCli(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    const code = error instanceof MarkdownTypedMemoryBatchPlanOperatorError
      ? error.code : "MARKDOWN_TYPED_MEMORY_BATCH_PLAN_FILESYSTEM_ERROR";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
