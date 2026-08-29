import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  planMemoryCurationBatches,
  type MemoryCurationBatchPlan,
  type MemoryCurationPlannerFile,
} from "../packages/core/src/db/migrations/markdown-curation-batch-planner.js";
import type {
  MarkdownWorksetPreprocessInventory,
} from "../packages/core/src/db/migrations/markdown-workset-preprocessor.js";
import type {
  MarkdownWorksetPreprocessManifest,
} from "./operator-markdown-workset-preprocess.js";

export interface RunMarkdownCurationPlanInput {
  readonly containmentRoot: string;
  readonly preprocessedManifestPath: string;
  readonly preprocessedManifestSha256: string;
  readonly inventoryPath: string;
  readonly inventoryFileSha256: string;
  readonly outputDirectory: string;
  readonly policyVersion: string;
  readonly createdAt: string;
  readonly maxUnitsPerBatch?: number;
  readonly maxBytesPerBatch?: number;
}

export interface RunMarkdownCurationPlanResult {
  readonly planPath: string;
  readonly planFileSha256: string;
  readonly plan: MemoryCurationBatchPlan;
}

export type MarkdownCurationPlanOperatorErrorCode =
  | "MARKDOWN_CURATION_PLAN_INVALID_INPUT"
  | "MARKDOWN_CURATION_PLAN_INPUT_DRIFT"
  | "MARKDOWN_CURATION_PLAN_OUTPUT_EXISTS"
  | "MARKDOWN_CURATION_PLAN_FILESYSTEM_ERROR";

const MESSAGES: Record<MarkdownCurationPlanOperatorErrorCode, string> = {
  MARKDOWN_CURATION_PLAN_INVALID_INPUT: "Markdown curation plan operator input is invalid",
  MARKDOWN_CURATION_PLAN_INPUT_DRIFT: "Markdown curation plan input drifted",
  MARKDOWN_CURATION_PLAN_OUTPUT_EXISTS: "Markdown curation plan output already exists",
  MARKDOWN_CURATION_PLAN_FILESYSTEM_ERROR: "Markdown curation plan filesystem operation failed",
};

export class MarkdownCurationPlanOperatorError extends Error {
  constructor(readonly code: MarkdownCurationPlanOperatorErrorCode) {
    super(MESSAGES[code]);
    this.name = "MarkdownCurationPlanOperatorError";
  }
}

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]{1,1024}$/;

function fail(code: MarkdownCurationPlanOperatorErrorCode): never {
  throw new MarkdownCurationPlanOperatorError(code);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function strictDescendant(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function regularPath(path: string, kind: "file" | "directory"): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return !stats.isSymbolicLink() && (kind === "file" ? stats.isFile() : stats.isDirectory());
  } catch {
    return false;
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = stableValue((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

async function writeDurable(path: string, content: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
  } catch (error) {
    if (errorCode(error) === "EEXIST") fail("MARKDOWN_CURATION_PLAN_OUTPUT_EXISTS");
    fail("MARKDOWN_CURATION_PLAN_FILESYSTEM_ERROR");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function runMarkdownCurationPlan(
  input: RunMarkdownCurationPlanInput,
): Promise<RunMarkdownCurationPlanResult> {
  if (!input || typeof input !== "object" || !SHA256.test(input.preprocessedManifestSha256) ||
      !SHA256.test(input.inventoryFileSha256) || !SAFE_TEXT.test(input.policyVersion) ||
      !Number.isFinite(Date.parse(input.createdAt)) ||
      new Date(input.createdAt).toISOString() !== input.createdAt) {
    fail("MARKDOWN_CURATION_PLAN_INVALID_INPUT");
  }
  const rawPaths = [input.containmentRoot, input.preprocessedManifestPath,
    input.inventoryPath, input.outputDirectory];
  if (rawPaths.some((path) => !isAbsolute(path) || resolve(path) !== path)) {
    fail("MARKDOWN_CURATION_PLAN_INVALID_INPUT");
  }
  const root = resolve(input.containmentRoot);
  const manifestPath = resolve(input.preprocessedManifestPath);
  const inventoryPath = resolve(input.inventoryPath);
  const outputDirectory = resolve(input.outputDirectory);
  if (!strictDescendant(root, manifestPath) || !strictDescendant(root, inventoryPath) ||
      !strictDescendant(root, outputDirectory) || !await regularPath(root, "directory") ||
      !await regularPath(manifestPath, "file") || !await regularPath(inventoryPath, "file")) {
    fail("MARKDOWN_CURATION_PLAN_INVALID_INPUT");
  }
  try {
    await lstat(outputDirectory);
    fail("MARKDOWN_CURATION_PLAN_OUTPUT_EXISTS");
  } catch (error) {
    if (error instanceof MarkdownCurationPlanOperatorError) throw error;
    if (errorCode(error) !== "ENOENT") fail("MARKDOWN_CURATION_PLAN_FILESYSTEM_ERROR");
  }
  const manifestText = await readFile(manifestPath, "utf8");
  const inventoryText = await readFile(inventoryPath, "utf8");
  if (sha256(manifestText) !== input.preprocessedManifestSha256 ||
      sha256(inventoryText) !== input.inventoryFileSha256) {
    fail("MARKDOWN_CURATION_PLAN_INPUT_DRIFT");
  }
  let manifest: MarkdownWorksetPreprocessManifest;
  let inventory: MarkdownWorksetPreprocessInventory;
  try {
    manifest = JSON.parse(manifestText) as MarkdownWorksetPreprocessManifest;
    inventory = JSON.parse(inventoryText) as MarkdownWorksetPreprocessInventory;
  } catch {
    fail("MARKDOWN_CURATION_PLAN_INPUT_DRIFT");
  }
  if (manifest.sourceCount !== inventory.sourceCount ||
      manifest.inventorySha256 !== inventory.inventorySha256 ||
      manifest.inventoryFileSha256 !== input.inventoryFileSha256 ||
      manifest.sourceSnapshotSha256 !== inventory.sourceSnapshotSha256 ||
      manifest.files.length !== manifest.sourceCount) {
    fail("MARKDOWN_CURATION_PLAN_INPUT_DRIFT");
  }
  const preprocessedRoot = dirname(manifestPath);
  const memoryEntries = manifest.files.filter((file) => file.sourceRef.startsWith("memories:"));
  const files: MemoryCurationPlannerFile[] = [];
  for (let offset = 0; offset < memoryEntries.length; offset += 64) {
    files.push(...await Promise.all(memoryEntries.slice(offset, offset + 64).map(async (file) => {
      const absolutePath = resolve(preprocessedRoot, file.relativePath);
      if (!strictDescendant(preprocessedRoot, absolutePath) || !await regularPath(absolutePath, "file")) {
        fail("MARKDOWN_CURATION_PLAN_INPUT_DRIFT");
      }
      const content = await readFile(absolutePath);
      if (sha256(content) !== file.markdownSha256) fail("MARKDOWN_CURATION_PLAN_INPUT_DRIFT");
      return Object.freeze({
        sourceRef: file.sourceRef,
        sourceHash: file.sourceHash,
        relativePath: file.relativePath,
        markdownSha256: file.markdownSha256,
        bytes: content.byteLength,
      });
    })));
  }
  const plan = planMemoryCurationBatches({
    migrationRunId: manifest.migrationRunId,
    sourceSnapshotSha256: manifest.sourceSnapshotSha256,
    sourceManifestSha256: manifest.sourceManifestSha256,
    preprocessedManifestSha256: input.preprocessedManifestSha256,
    inventorySha256: inventory.inventorySha256,
    policyVersion: input.policyVersion,
    createdAt: input.createdAt,
    nodes: inventory.nodes,
    groups: inventory.groups,
    files,
    maxUnitsPerBatch: input.maxUnitsPerBatch ?? 30,
    maxBytesPerBatch: input.maxBytesPerBatch ?? 400_000,
  });
  await mkdir(outputDirectory, { mode: 0o700 });
  const planPath = resolve(outputDirectory, "memory-curation-plan.json");
  const planJson = `${JSON.stringify(stableValue(plan), null, 2)}\n`;
  await writeDurable(planPath, planJson);
  return Object.freeze({ planPath, planFileSha256: sha256(planJson), plan });
}
