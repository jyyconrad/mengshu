import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  unlink,
  link,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  parseMarkdownWorksetManifest,
  parseNativeRecordMarkdown,
  type MarkdownWorksetManifest,
  type MarkdownWorksetManifestFile,
  type MarkdownWorksetRecord,
} from "../packages/core/src/db/migrations/markdown-workset.js";
import {
  parsePreprocessedMarkdown,
  preprocessedNodeSha256,
  renderPreprocessedMarkdown,
} from "../packages/core/src/db/migrations/markdown-workset-preprocessed.js";
import {
  assembleMarkdownWorksetPreprocessInventory,
  preprocessMarkdownWorksetRecord,
  type MarkdownPreprocessNode,
  type MarkdownPreprocessRelationship,
  type MarkdownWorksetPreprocessInventory,
} from "../packages/core/src/db/migrations/markdown-workset-preprocessor.js";

export const MARKDOWN_WORKSET_PREPROCESS_MANIFEST_SCHEMA =
  "mengshu.markdown-workset-preprocess-manifest/v1" as const;

export interface MarkdownWorksetPreprocessManifestFile {
  readonly relativePath: string;
  readonly sourceRef: string;
  readonly sourceHash: string;
  readonly nodeSha256: string;
  readonly markdownSha256: string;
}

export interface MarkdownWorksetPreprocessManifest {
  readonly schema: typeof MARKDOWN_WORKSET_PREPROCESS_MANIFEST_SCHEMA;
  readonly migrationRunId: string;
  readonly sourceManifestSha256: string;
  readonly sourceSnapshotSha256: string;
  readonly policyVersion: string;
  readonly createdAt: string;
  readonly sourceCount: number;
  readonly inventorySha256: string;
  readonly inventoryFileSha256: string;
  readonly summary: MarkdownWorksetPreprocessInventory["summary"];
  readonly files: readonly MarkdownWorksetPreprocessManifestFile[];
}

export interface RunMarkdownWorksetPreprocessInput {
  readonly containmentRoot: string;
  readonly sourceManifestPath: string;
  readonly sourceManifestSha256: string;
  readonly outputDirectory: string;
  readonly policyVersion: string;
  readonly createdAt: string;
  readonly concurrency?: number;
}

export interface RunMarkdownWorksetPreprocessResult {
  readonly outputDirectory: string;
  readonly inventoryPath: string;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly inventory: MarkdownWorksetPreprocessInventory;
  readonly manifest: MarkdownWorksetPreprocessManifest;
}

export type MarkdownWorksetPreprocessOperatorErrorCode =
  | "MARKDOWN_WORKSET_PREPROCESS_OPERATOR_INVALID_INPUT"
  | "MARKDOWN_WORKSET_PREPROCESS_OPERATOR_MANIFEST_DRIFT"
  | "MARKDOWN_WORKSET_PREPROCESS_OPERATOR_SOURCE_DRIFT"
  | "MARKDOWN_WORKSET_PREPROCESS_OPERATOR_OUTPUT_EXISTS"
  | "MARKDOWN_WORKSET_PREPROCESS_OPERATOR_FILESYSTEM_ERROR";

const MESSAGES: Record<MarkdownWorksetPreprocessOperatorErrorCode, string> = {
  MARKDOWN_WORKSET_PREPROCESS_OPERATOR_INVALID_INPUT: "Markdown preprocess operator input is invalid",
  MARKDOWN_WORKSET_PREPROCESS_OPERATOR_MANIFEST_DRIFT: "Markdown preprocess source manifest drifted",
  MARKDOWN_WORKSET_PREPROCESS_OPERATOR_SOURCE_DRIFT: "Markdown preprocess source file drifted",
  MARKDOWN_WORKSET_PREPROCESS_OPERATOR_OUTPUT_EXISTS: "Markdown preprocess output already exists",
  MARKDOWN_WORKSET_PREPROCESS_OPERATOR_FILESYSTEM_ERROR:
    "Markdown preprocess filesystem operation failed",
};

export class MarkdownWorksetPreprocessOperatorError extends Error {
  constructor(readonly code: MarkdownWorksetPreprocessOperatorErrorCode) {
    super(MESSAGES[code]);
    this.name = "MarkdownWorksetPreprocessOperatorError";
  }
}

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]{1,1024}$/;
const DEFAULT_CONCURRENCY = 32;
const MAX_CONCURRENCY = 64;

function fail(code: MarkdownWorksetPreprocessOperatorErrorCode): never {
  throw new MarkdownWorksetPreprocessOperatorError(code);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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

async function validateInput(input: RunMarkdownWorksetPreprocessInput): Promise<Readonly<{
  containmentRoot: string;
  sourceManifestPath: string;
  sourceDirectory: string;
  outputDirectory: string;
  concurrency: number;
}>> {
  if (!input || typeof input !== "object" || !SHA256.test(input.sourceManifestSha256) ||
      typeof input.policyVersion !== "string" || !SAFE_TEXT.test(input.policyVersion) ||
      typeof input.createdAt !== "string" || !Number.isFinite(Date.parse(input.createdAt)) ||
      new Date(input.createdAt).toISOString() !== input.createdAt) {
    fail("MARKDOWN_WORKSET_PREPROCESS_OPERATOR_INVALID_INPUT");
  }
  const paths = [input.containmentRoot, input.sourceManifestPath, input.outputDirectory];
  if (paths.some((path) => typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path)) {
    fail("MARKDOWN_WORKSET_PREPROCESS_OPERATOR_INVALID_INPUT");
  }
  const containmentRoot = resolve(input.containmentRoot);
  const sourceManifestPath = resolve(input.sourceManifestPath);
  const sourceDirectory = dirname(sourceManifestPath);
  const outputDirectory = resolve(input.outputDirectory);
  if (!strictDescendant(containmentRoot, sourceManifestPath) ||
      !strictDescendant(containmentRoot, outputDirectory) ||
      !strictDescendant(sourceDirectory, sourceManifestPath) ||
      outputDirectory === sourceDirectory ||
      !await regularPath(containmentRoot, "directory") ||
      !await regularPath(sourceManifestPath, "file")) {
    fail("MARKDOWN_WORKSET_PREPROCESS_OPERATOR_INVALID_INPUT");
  }
  try {
    await lstat(outputDirectory);
    fail("MARKDOWN_WORKSET_PREPROCESS_OPERATOR_OUTPUT_EXISTS");
  } catch (error) {
    if (error instanceof MarkdownWorksetPreprocessOperatorError) throw error;
    if (errorCode(error) !== "ENOENT") fail("MARKDOWN_WORKSET_PREPROCESS_OPERATOR_FILESYSTEM_ERROR");
  }
  const concurrency = input.concurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    fail("MARKDOWN_WORKSET_PREPROCESS_OPERATOR_INVALID_INPUT");
  }
  return Object.freeze({
    containmentRoot,
    sourceManifestPath,
    sourceDirectory,
    outputDirectory,
    concurrency,
  });
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

function stablePrettyJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

async function readSourceManifest(
  path: string,
  expectedSha256: string,
): Promise<Readonly<{ manifest: MarkdownWorksetManifest; serialized: string }>> {
  let serialized: string;
  try {
    serialized = await readFile(path, "utf8");
  } catch {
    fail("MARKDOWN_WORKSET_PREPROCESS_OPERATOR_FILESYSTEM_ERROR");
  }
  if (sha256(serialized) !== expectedSha256) {
    fail("MARKDOWN_WORKSET_PREPROCESS_OPERATOR_MANIFEST_DRIFT");
  }
  let manifest: MarkdownWorksetManifest;
  try {
    manifest = parseMarkdownWorksetManifest(serialized);
  } catch {
    fail("MARKDOWN_WORKSET_PREPROCESS_OPERATOR_MANIFEST_DRIFT");
  }
  if (manifest.phase !== "source") fail("MARKDOWN_WORKSET_PREPROCESS_OPERATOR_MANIFEST_DRIFT");
  return Object.freeze({ manifest, serialized });
}

async function readVerifiedSource(
  sourceDirectory: string,
  entry: MarkdownWorksetManifestFile,
): Promise<Readonly<{ markdown: string; record: MarkdownWorksetRecord }>> {
  const absolutePath = resolve(sourceDirectory, entry.relativePath);
  if (!strictDescendant(sourceDirectory, absolutePath) || !await regularPath(absolutePath, "file")) {
    fail("MARKDOWN_WORKSET_PREPROCESS_OPERATOR_SOURCE_DRIFT");
  }
  let markdown: string;
  try {
    markdown = await readFile(absolutePath, "utf8");
  } catch {
    fail("MARKDOWN_WORKSET_PREPROCESS_OPERATOR_FILESYSTEM_ERROR");
  }
  if (sha256(markdown) !== entry.markdownSha256) {
    fail("MARKDOWN_WORKSET_PREPROCESS_OPERATOR_SOURCE_DRIFT");
  }
  let record: MarkdownWorksetRecord;
  try {
    record = parseNativeRecordMarkdown(markdown);
  } catch {
    fail("MARKDOWN_WORKSET_PREPROCESS_OPERATOR_SOURCE_DRIFT");
  }
  if (record.phase !== "source" || record.sourceRef !== entry.sourceRef ||
      record.sourceHash !== entry.sourceHash) {
    fail("MARKDOWN_WORKSET_PREPROCESS_OPERATOR_SOURCE_DRIFT");
  }
  return Object.freeze({ markdown, record });
}

async function mapBatches<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<readonly R[]> {
  const result: R[] = [];
  for (let offset = 0; offset < values.length; offset += concurrency) {
    result.push(...await Promise.all(values.slice(offset, offset + concurrency).map(mapper)));
  }
  return Object.freeze(result);
}

async function createPrivateOutput(outputDirectory: string): Promise<void> {
  try {
    await mkdir(outputDirectory, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) === "EEXIST") fail("MARKDOWN_WORKSET_PREPROCESS_OPERATOR_OUTPUT_EXISTS");
    fail("MARKDOWN_WORKSET_PREPROCESS_OPERATOR_FILESYSTEM_ERROR");
  }
}

async function writeDerived(path: string, content: string): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if (errorCode(error) === "EEXIST") fail("MARKDOWN_WORKSET_PREPROCESS_OPERATOR_OUTPUT_EXISTS");
    fail("MARKDOWN_WORKSET_PREPROCESS_OPERATOR_FILESYSTEM_ERROR");
  }
}

async function writeDurable(path: string, content: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
  } catch (error) {
    if (errorCode(error) === "EEXIST") fail("MARKDOWN_WORKSET_PREPROCESS_OPERATOR_OUTPUT_EXISTS");
    fail("MARKDOWN_WORKSET_PREPROCESS_OPERATOR_FILESYSTEM_ERROR");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function relationshipsBySource(
  inventory: MarkdownWorksetPreprocessInventory,
): ReadonlyMap<string, readonly MarkdownPreprocessRelationship[]> {
  const result = new Map<string, MarkdownPreprocessRelationship[]>();
  for (const relationship of inventory.relationships) {
    for (const sourceRef of new Set([relationship.from, relationship.to])) {
      const current = result.get(sourceRef) ?? [];
      current.push(relationship);
      result.set(sourceRef, current);
    }
  }
  return new Map([...result].map(([sourceRef, relationships]) =>
    [sourceRef, Object.freeze(relationships)] as const));
}

async function publishManifest(
  outputDirectory: string,
  serialized: string,
): Promise<string> {
  const pendingPath = resolve(outputDirectory, ".manifest.json.pending");
  const manifestPath = resolve(outputDirectory, "manifest.json");
  await writeDurable(pendingPath, serialized);
  try {
    await link(pendingPath, manifestPath);
  } catch (error) {
    if (errorCode(error) === "EEXIST") fail("MARKDOWN_WORKSET_PREPROCESS_OPERATOR_OUTPUT_EXISTS");
    fail("MARKDOWN_WORKSET_PREPROCESS_OPERATOR_FILESYSTEM_ERROR");
  }
  await unlink(pendingPath).catch(() => undefined);
  return manifestPath;
}

export async function runMarkdownWorksetPreprocess(
  input: RunMarkdownWorksetPreprocessInput,
): Promise<RunMarkdownWorksetPreprocessResult> {
  const paths = await validateInput(input);
  const { manifest: sourceManifest } = await readSourceManifest(
    paths.sourceManifestPath,
    input.sourceManifestSha256,
  );

  // Pass 1 keeps only compact preprocessing nodes; native vectors and Markdown bytes are discarded.
  const nodes = await mapBatches(sourceManifest.files, paths.concurrency, async (entry) => {
    const source = await readVerifiedSource(paths.sourceDirectory, entry);
    return preprocessMarkdownWorksetRecord(source.record);
  });
  const inventory = assembleMarkdownWorksetPreprocessInventory({
    sourceSnapshotSha256: sourceManifest.snapshotSha256,
    policyVersion: input.policyVersion,
    nodes,
  });
  if (inventory.sourceCount !== sourceManifest.sourceCount) {
    fail("MARKDOWN_WORKSET_PREPROCESS_OPERATOR_SOURCE_DRIFT");
  }

  await createPrivateOutput(paths.outputDirectory);
  const inventoryPath = resolve(paths.outputDirectory, "inventory.json");
  const inventoryJson = stablePrettyJson(inventory);
  await writeDurable(inventoryPath, inventoryJson);
  const relations = relationshipsBySource(inventory);
  const nodeBySource = new Map(inventory.nodes.map((node) => [node.sourceRef, node] as const));

  // Pass 2 re-verifies source bytes and materializes candidate-only Markdown files.
  const files = await mapBatches(sourceManifest.files, paths.concurrency, async (entry) => {
    const source = await readVerifiedSource(paths.sourceDirectory, entry);
    const node = nodeBySource.get(entry.sourceRef);
    if (!node) fail("MARKDOWN_WORKSET_PREPROCESS_OPERATOR_SOURCE_DRIFT");
    const markdown = renderPreprocessedMarkdown({
      policyVersion: input.policyVersion,
      node,
      relationships: relations.get(entry.sourceRef) ?? Object.freeze([]),
      content: source.record.record.text,
    });
    const parsed = parsePreprocessedMarkdown(markdown);
    const outputPath = resolve(paths.outputDirectory, entry.relativePath);
    if (!strictDescendant(paths.outputDirectory, outputPath)) {
      fail("MARKDOWN_WORKSET_PREPROCESS_OPERATOR_SOURCE_DRIFT");
    }
    await writeDerived(outputPath, markdown);
    return Object.freeze({
      relativePath: entry.relativePath,
      sourceRef: entry.sourceRef,
      sourceHash: entry.sourceHash,
      nodeSha256: parsed.nodeSha256,
      markdownSha256: sha256(markdown),
    });
  });

  const manifest: MarkdownWorksetPreprocessManifest = Object.freeze({
    schema: MARKDOWN_WORKSET_PREPROCESS_MANIFEST_SCHEMA,
    migrationRunId: sourceManifest.migrationRunId,
    sourceManifestSha256: input.sourceManifestSha256,
    sourceSnapshotSha256: sourceManifest.snapshotSha256,
    policyVersion: input.policyVersion,
    createdAt: input.createdAt,
    sourceCount: files.length,
    inventorySha256: inventory.inventorySha256,
    inventoryFileSha256: sha256(inventoryJson),
    summary: inventory.summary,
    files,
  });
  const manifestJson = stablePrettyJson(manifest);
  const manifestPath = await publishManifest(paths.outputDirectory, manifestJson);
  return Object.freeze({
    outputDirectory: paths.outputDirectory,
    inventoryPath,
    manifestPath,
    manifestSha256: sha256(manifestJson),
    inventory,
    manifest,
  });
}
