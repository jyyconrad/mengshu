import { createHash } from "node:crypto";
import { lstat, open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { types as nodeUtilTypes } from "node:util";

import {
  parseKnowledgeResourcePlan,
  planKnowledgeResourceCuration,
  serializeKnowledgeResourcePlan,
  type PlanKnowledgeResourceCurationInput,
} from "../packages/core/src/db/migrations/knowledge-resource-curation.js";
import { parsePreprocessedMarkdown } from "../packages/core/src/db/migrations/markdown-workset-preprocessed.js";
import type {
  MarkdownPreprocessNode,
  MarkdownWorksetPreprocessInventory,
} from "../packages/core/src/db/migrations/markdown-workset-preprocessor.js";
import type {
  MarkdownWorksetPreprocessManifest,
  MarkdownWorksetPreprocessManifestFile,
} from "./operator-markdown-workset-preprocess.js";

export interface RunMarkdownKnowledgeResourcePlanInput {
  readonly containmentRoot: string;
  readonly preprocessedManifestPath: string;
  readonly preprocessedManifestFileSha256: string;
  readonly inventoryPath: string;
  readonly inventoryFileSha256: string;
  readonly inventorySemanticSha256: string;
  readonly sourceManifestSha256: string;
  readonly sourceSnapshotSha256: string;
  readonly expectedKnowledgeSourceCount: number;
  readonly outputPath: string;
  readonly createdAt: string;
  readonly readConcurrency?: number;
}

export interface RunMarkdownKnowledgeResourcePlanResult {
  readonly outputPath: string;
  readonly outputFileSha256: string;
  readonly semanticPlanSha256: string;
  readonly knowledgeSourceCount: number;
  readonly unitCount: number;
  readonly batchCount: number;
  readonly quarantineSourceCount: number;
  readonly eligibleSourceCount: number;
}

export type MarkdownKnowledgeResourcePlanOperatorErrorCode =
  | "MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_INVALID_ARGUMENT"
  | "MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_PATH_ESCAPE"
  | "MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_SYMLINK"
  | "MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_INPUT_DRIFT"
  | "MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_COVERAGE_INVALID"
  | "MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_OUTPUT_EXISTS"
  | "MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_PLANNER_REJECTED"
  | "MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_FILESYSTEM_ERROR";

const MESSAGES: Readonly<
  Record<MarkdownKnowledgeResourcePlanOperatorErrorCode, string>
> = {
  MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_INVALID_ARGUMENT:
    "Markdown Knowledge resource plan argument is invalid",
  MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_PATH_ESCAPE:
    "Markdown Knowledge resource plan path escapes containment",
  MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_SYMLINK:
    "Markdown Knowledge resource plan rejects symlink input",
  MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_INPUT_DRIFT:
    "Markdown Knowledge resource plan input drifted",
  MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_COVERAGE_INVALID:
    "Markdown Knowledge resource plan source coverage is invalid",
  MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_OUTPUT_EXISTS:
    "Markdown Knowledge resource plan output already exists",
  MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_PLANNER_REJECTED:
    "Markdown Knowledge resource planner rejected verified input",
  MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_FILESYSTEM_ERROR:
    "Markdown Knowledge resource plan filesystem operation failed",
};

export class MarkdownKnowledgeResourcePlanOperatorError extends Error {
  constructor(readonly code: MarkdownKnowledgeResourcePlanOperatorErrorCode) {
    super(MESSAGES[code]);
    this.name = "MarkdownKnowledgeResourcePlanOperatorError";
  }
}

const SHA256 = /^[0-9a-f]{64}$/;
const DEFAULT_READ_CONCURRENCY = 32;
const MAX_READ_CONCURRENCY = 64;
const POLICY_VERSION = "knowledge-resource-curation/v1";
const REQUIRED_INPUT_KEYS = [
  "containmentRoot",
  "preprocessedManifestPath",
  "preprocessedManifestFileSha256",
  "inventoryPath",
  "inventoryFileSha256",
  "inventorySemanticSha256",
  "sourceManifestSha256",
  "sourceSnapshotSha256",
  "expectedKnowledgeSourceCount",
  "outputPath",
  "createdAt",
] as const;
const OPTIONAL_INPUT_KEYS = ["readConcurrency"] as const;
const REQUIRED_ARGS = new Map<
  string,
  keyof RunMarkdownKnowledgeResourcePlanInput
>([
  ["--containment-root", "containmentRoot"],
  ["--preprocessed-manifest", "preprocessedManifestPath"],
  ["--preprocessed-manifest-file-sha256", "preprocessedManifestFileSha256"],
  ["--inventory", "inventoryPath"],
  ["--inventory-file-sha256", "inventoryFileSha256"],
  ["--inventory-semantic-sha256", "inventorySemanticSha256"],
  ["--source-manifest-sha256", "sourceManifestSha256"],
  ["--source-snapshot-sha256", "sourceSnapshotSha256"],
  ["--expected-knowledge-count", "expectedKnowledgeSourceCount"],
  ["--output", "outputPath"],
  ["--created-at", "createdAt"],
]);
const OPTIONAL_ARGS = new Map<
  string,
  keyof RunMarkdownKnowledgeResourcePlanInput
>([["--read-concurrency", "readConcurrency"]]);

function fail(code: MarkdownKnowledgeResourcePlanOperatorErrorCode): never {
  throw new MarkdownKnowledgeResourcePlanOperatorError(code);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value)
  )
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function stableValue(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      fail("MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_INPUT_DRIFT");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (nodeUtilTypes.isProxy(value) || seen.has(value)) {
      fail("MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_INPUT_DRIFT");
    }
    seen.add(value);
    const result = value.map((item) => stableValue(item, seen));
    seen.delete(value);
    return result;
  }
  if (!plainRecord(value) || seen.has(value)) {
    fail("MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_INPUT_DRIFT");
  }
  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (
      item === undefined ||
      typeof item === "function" ||
      typeof item === "symbol" ||
      typeof item === "bigint"
    ) {
      fail("MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_INPUT_DRIFT");
    }
    result[key] = stableValue(item, seen);
  }
  seen.delete(value);
  return result;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function semanticJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function parseCanonicalJson(serialized: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    fail("MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_INPUT_DRIFT");
  }
  if (canonicalJson(value) !== serialized) {
    fail("MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_INPUT_DRIFT");
  }
  return value;
}

function strictDescendant(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return (
    child !== "" &&
    child !== ".." &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child)
  );
}

function canonicalAbsolutePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    resolve(value) !== value
  ) {
    fail("MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_INVALID_ARGUMENT");
  }
  return value;
}

async function stat(
  path: string,
  missingCode: MarkdownKnowledgeResourcePlanOperatorErrorCode,
) {
  try {
    return await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR")
      fail(missingCode);
    fail("MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_FILESYSTEM_ERROR");
  }
}

async function assertRoot(root: string): Promise<void> {
  const info = await stat(
    root,
    "MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_INVALID_ARGUMENT",
  );
  if (info.isSymbolicLink()) fail("MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_SYMLINK");
  if (!info.isDirectory())
    fail("MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_INVALID_ARGUMENT");
}

async function assertContainedExistingPath(
  root: string,
  candidate: string,
  kind: "file" | "directory",
  missingCode: MarkdownKnowledgeResourcePlanOperatorErrorCode,
): Promise<void> {
  if (!strictDescendant(root, candidate))
    fail("MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_PATH_ESCAPE");
  const segments = relative(root, candidate).split(sep);
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = resolve(current, segments[index]!);
    const info = await stat(current, missingCode);
    if (info.isSymbolicLink()) fail("MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_SYMLINK");
    if (index < segments.length - 1 && !info.isDirectory()) fail(missingCode);
    if (
      index === segments.length - 1 &&
      (kind === "file" ? !info.isFile() : !info.isDirectory())
    )
      fail(missingCode);
  }
}

async function assertFreshOutput(
  root: string,
  outputPath: string,
): Promise<void> {
  if (!strictDescendant(root, outputPath))
    fail("MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_PATH_ESCAPE");
  const outputParent = dirname(outputPath);
  if (outputParent !== root) {
    await assertContainedExistingPath(
      root,
      outputParent,
      "directory",
      "MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_INVALID_ARGUMENT",
    );
  }
  try {
    const info = await lstat(outputPath);
    if (info.isSymbolicLink()) fail("MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_SYMLINK");
    fail("MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_OUTPUT_EXISTS");
  } catch (error) {
    if (error instanceof MarkdownKnowledgeResourcePlanOperatorError)
      throw error;
    if (errorCode(error) !== "ENOENT") {
      fail("MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_FILESYSTEM_ERROR");
    }
  }
}

async function readVerifiedInput(
  path: string,
  expectedHash: string,
): Promise<string> {
  let content: Buffer;
  try {
    content = await readFile(path);
  } catch {
    fail("MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_FILESYSTEM_ERROR");
  }
  if (sha256(content) !== expectedHash)
    fail("MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_INPUT_DRIFT");
  return content.toString("utf8");
}

function inventorySemanticHash(
  inventory: Readonly<Record<string, unknown>>,
): string {
  const body = { ...inventory };
  delete body.inventorySha256;
  return sha256(semanticJson(body));
}

function validateBindings(
  manifestValue: unknown,
  inventoryValue: unknown,
  input: RunMarkdownKnowledgeResourcePlanInput,
): Readonly<{
  manifest: MarkdownWorksetPreprocessManifest;
  inventory: MarkdownWorksetPreprocessInventory;
  knowledge: readonly Readonly<{
    file: MarkdownWorksetPreprocessManifestFile;
    node: MarkdownPreprocessNode;
  }>[];
}> {
  if (
    !plainRecord(manifestValue) ||
    !plainRecord(inventoryValue) ||
    !Array.isArray(manifestValue.files) ||
    !Array.isArray(inventoryValue.nodes) ||
    !SHA256.test(String(inventoryValue.inventorySha256)) ||
    inventorySemanticHash(inventoryValue) !== input.inventorySemanticSha256 ||
    inventoryValue.inventorySha256 !== input.inventorySemanticSha256 ||
    manifestValue.inventorySha256 !== input.inventorySemanticSha256 ||
    manifestValue.inventoryFileSha256 !== input.inventoryFileSha256 ||
    manifestValue.sourceManifestSha256 !== input.sourceManifestSha256 ||
    manifestValue.sourceSnapshotSha256 !== input.sourceSnapshotSha256 ||
    inventoryValue.sourceSnapshotSha256 !== input.sourceSnapshotSha256 ||
    manifestValue.policyVersion !== inventoryValue.policyVersion ||
    !Number.isSafeInteger(manifestValue.sourceCount) ||
    !Number.isSafeInteger(inventoryValue.sourceCount)
  ) {
    fail("MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_INPUT_DRIFT");
  }

  const files = manifestValue.files as unknown[];
  const nodes = inventoryValue.nodes as unknown[];
  const fileByRef = new Map<string, MarkdownWorksetPreprocessManifestFile>();
  const nodeByRef = new Map<string, MarkdownPreprocessNode>();
  const paths = new Set<string>();
  for (const rawFile of files) {
    if (
      !plainRecord(rawFile) ||
      !exactKeys(rawFile, [
        "relativePath",
        "sourceRef",
        "sourceHash",
        "nodeSha256",
        "markdownSha256",
      ]) ||
      typeof rawFile.relativePath !== "string" ||
      !rawFile.relativePath ||
      rawFile.relativePath.includes("\\") ||
      isAbsolute(rawFile.relativePath) ||
      typeof rawFile.sourceRef !== "string" ||
      typeof rawFile.sourceHash !== "string" ||
      typeof rawFile.nodeSha256 !== "string" ||
      typeof rawFile.markdownSha256 !== "string" ||
      !SHA256.test(rawFile.sourceHash) ||
      !SHA256.test(rawFile.nodeSha256) ||
      !SHA256.test(rawFile.markdownSha256) ||
      fileByRef.has(rawFile.sourceRef) ||
      paths.has(rawFile.relativePath)
    ) {
      fail("MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_COVERAGE_INVALID");
    }
    fileByRef.set(
      rawFile.sourceRef,
      rawFile as unknown as MarkdownWorksetPreprocessManifestFile,
    );
    paths.add(rawFile.relativePath);
  }
  for (const rawNode of nodes) {
    if (
      !plainRecord(rawNode) ||
      typeof rawNode.sourceRef !== "string" ||
      typeof rawNode.sourceHash !== "string" ||
      !SHA256.test(rawNode.sourceHash) ||
      (rawNode.sourceTable !== "knowledge" &&
        rawNode.sourceTable !== "memories") ||
      nodeByRef.has(rawNode.sourceRef)
    ) {
      fail("MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_COVERAGE_INVALID");
    }
    const expectedPrefix =
      rawNode.sourceTable === "knowledge" ? "knowledge:" : "memories:";
    if (!rawNode.sourceRef.startsWith(expectedPrefix)) {
      fail("MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_COVERAGE_INVALID");
    }
    nodeByRef.set(
      rawNode.sourceRef,
      rawNode as unknown as MarkdownPreprocessNode,
    );
  }
  if (
    manifestValue.sourceCount !== files.length ||
    inventoryValue.sourceCount !== nodes.length ||
    manifestValue.sourceCount !== inventoryValue.sourceCount ||
    fileByRef.size !== nodeByRef.size ||
    [...fileByRef.keys()].some((sourceRef) => !nodeByRef.has(sourceRef))
  ) {
    fail("MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_COVERAGE_INVALID");
  }

  const knowledge = [...nodeByRef.values()]
    .filter((node) => node.sourceTable === "knowledge")
    .map((node) => {
      const file = fileByRef.get(node.sourceRef);
      if (
        !file ||
        !node.sourceRef.startsWith("knowledge:") ||
        file.sourceHash !== node.sourceHash
      ) {
        fail("MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_COVERAGE_INVALID");
      }
      return Object.freeze({ file, node });
    });
  if (knowledge.length !== input.expectedKnowledgeSourceCount) {
    fail("MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_COVERAGE_INVALID");
  }
  return Object.freeze({
    manifest: manifestValue as unknown as MarkdownWorksetPreprocessManifest,
    inventory: inventoryValue as unknown as MarkdownWorksetPreprocessInventory,
    knowledge: Object.freeze(knowledge),
  });
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<readonly R[]> {
  const result = new Array<R>(values.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      result[index] = await mapper(values[index]!, index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () =>
      worker(),
    ),
  );
  return Object.freeze(result);
}

async function sourceFacts(
  root: string,
  preprocessedRoot: string,
  bindings: readonly Readonly<{
    file: MarkdownWorksetPreprocessManifestFile;
    node: MarkdownPreprocessNode;
  }>[],
  concurrency: number,
): Promise<PlanKnowledgeResourceCurationInput["sourceFacts"]> {
  const facts = await mapConcurrent(
    bindings,
    concurrency,
    async ({ file, node }) => {
      const absolutePath = resolve(preprocessedRoot, file.relativePath);
      if (
        !strictDescendant(preprocessedRoot, absolutePath) ||
        relative(preprocessedRoot, absolutePath) !== file.relativePath
      ) {
        fail("MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_PATH_ESCAPE");
      }
      await assertContainedExistingPath(
        root,
        absolutePath,
        "file",
        "MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_INPUT_DRIFT",
      );
      let markdownBytes: Buffer;
      try {
        markdownBytes = await readFile(absolutePath);
      } catch {
        fail("MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_FILESYSTEM_ERROR");
      }
      if (sha256(markdownBytes) !== file.markdownSha256) {
        fail("MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_INPUT_DRIFT");
      }
      let parsed: ReturnType<typeof parsePreprocessedMarkdown>;
      try {
        parsed = parsePreprocessedMarkdown(markdownBytes.toString("utf8"));
      } catch {
        fail("MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_INPUT_DRIFT");
      }
      if (
        parsed.node.sourceRef !== file.sourceRef ||
        parsed.node.sourceHash !== file.sourceHash ||
        parsed.node.sourceTable !== "knowledge" ||
        parsed.nodeSha256 !== file.nodeSha256 ||
        semanticJson(parsed.node) !== semanticJson(node)
      ) {
        fail("MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_INPUT_DRIFT");
      }
      return Object.freeze({
        sourceRef: file.sourceRef,
        bytes: markdownBytes.byteLength,
        contentLength: parsed.content.length,
      });
    },
  );
  return facts;
}

async function durableWrite(path: string, serialized: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      fail("MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_OUTPUT_EXISTS");
    }
    if (error instanceof MarkdownKnowledgeResourcePlanOperatorError)
      throw error;
    fail("MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_FILESYSTEM_ERROR");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function validateInput(input: RunMarkdownKnowledgeResourcePlanInput): Readonly<{
  containmentRoot: string;
  preprocessedManifestPath: string;
  inventoryPath: string;
  outputPath: string;
  readConcurrency: number;
}> {
  if (
    !plainRecord(input) ||
    !exactKeys(input, REQUIRED_INPUT_KEYS, OPTIONAL_INPUT_KEYS) ||
    !SHA256.test(input.preprocessedManifestFileSha256) ||
    !SHA256.test(input.inventoryFileSha256) ||
    !SHA256.test(input.inventorySemanticSha256) ||
    !SHA256.test(input.sourceManifestSha256) ||
    !SHA256.test(input.sourceSnapshotSha256) ||
    !Number.isSafeInteger(input.expectedKnowledgeSourceCount) ||
    input.expectedKnowledgeSourceCount < 1 ||
    typeof input.createdAt !== "string" ||
    !Number.isFinite(Date.parse(input.createdAt)) ||
    new Date(input.createdAt).toISOString() !== input.createdAt
  ) {
    fail("MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_INVALID_ARGUMENT");
  }
  const readConcurrency = input.readConcurrency ?? DEFAULT_READ_CONCURRENCY;
  if (
    !Number.isSafeInteger(readConcurrency) ||
    readConcurrency < 1 ||
    readConcurrency > MAX_READ_CONCURRENCY
  ) {
    fail("MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_INVALID_ARGUMENT");
  }
  return Object.freeze({
    containmentRoot: canonicalAbsolutePath(input.containmentRoot),
    preprocessedManifestPath: canonicalAbsolutePath(
      input.preprocessedManifestPath,
    ),
    inventoryPath: canonicalAbsolutePath(input.inventoryPath),
    outputPath: canonicalAbsolutePath(input.outputPath),
    readConcurrency,
  });
}

export async function runMarkdownKnowledgeResourcePlan(
  input: RunMarkdownKnowledgeResourcePlanInput,
): Promise<RunMarkdownKnowledgeResourcePlanResult> {
  const paths = validateInput(input);
  await assertRoot(paths.containmentRoot);
  await Promise.all([
    assertContainedExistingPath(
      paths.containmentRoot,
      paths.preprocessedManifestPath,
      "file",
      "MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_INPUT_DRIFT",
    ),
    assertContainedExistingPath(
      paths.containmentRoot,
      paths.inventoryPath,
      "file",
      "MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_INPUT_DRIFT",
    ),
    assertFreshOutput(paths.containmentRoot, paths.outputPath),
  ]);
  const [manifestText, inventoryText] = await Promise.all([
    readVerifiedInput(
      paths.preprocessedManifestPath,
      input.preprocessedManifestFileSha256,
    ),
    readVerifiedInput(paths.inventoryPath, input.inventoryFileSha256),
  ]);
  const validated = validateBindings(
    parseCanonicalJson(manifestText),
    parseCanonicalJson(inventoryText),
    input,
  );
  const facts = await sourceFacts(
    paths.containmentRoot,
    dirname(paths.preprocessedManifestPath),
    validated.knowledge,
    paths.readConcurrency,
  );
  let plan: ReturnType<typeof planKnowledgeResourceCuration>;
  let serialized: string;
  try {
    plan = planKnowledgeResourceCuration({
      runId: validated.manifest.migrationRunId,
      policyVersion: POLICY_VERSION,
      createdAt: input.createdAt,
      expectedKnowledgeSourceCount: input.expectedKnowledgeSourceCount,
      frozenHashes: {
        sourceManifestSha256: input.sourceManifestSha256,
        sourceSnapshotSha256: input.sourceSnapshotSha256,
        preprocessedManifestSha256: input.preprocessedManifestFileSha256,
        inventoryFileSha256: input.inventoryFileSha256,
        inventorySemanticSha256: input.inventorySemanticSha256,
      },
      observedHashes: {
        sourceManifestSha256: validated.manifest.sourceManifestSha256,
        sourceSnapshotSha256: validated.manifest.sourceSnapshotSha256,
        preprocessedManifestSha256: sha256(manifestText),
        inventoryFileSha256: sha256(inventoryText),
        inventorySemanticSha256: validated.inventory.inventorySha256,
      },
      preprocessedManifest: {
        ...validated.manifest,
        files: validated.manifest.files.map((file) => ({ ...file })),
      },
      inventory: {
        ...validated.inventory,
        nodes: validated.inventory.nodes.map((node) => structuredClone(node)),
        groups: validated.inventory.groups.map((group) => structuredClone(group)),
        relationships: validated.inventory.relationships.map((relationship) =>
          structuredClone(relationship)),
      },
      sourceFacts: facts.map((fact) => ({ ...fact })),
    });
    serialized = serializeKnowledgeResourcePlan(plan);
    parseKnowledgeResourcePlan(serialized);
  } catch {
    fail("MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_PLANNER_REJECTED");
  }
  await durableWrite(paths.outputPath, serialized);
  return Object.freeze({
    outputPath: paths.outputPath,
    outputFileSha256: sha256(serialized),
    semanticPlanSha256: plan.semanticPlanSha256,
    knowledgeSourceCount: plan.summary.sourceCount,
    unitCount: plan.summary.unitCount,
    batchCount: plan.summary.batchCount,
    quarantineSourceCount: plan.summary.quarantineSourceCount,
    eligibleSourceCount: plan.summary.eligibleSourceCount,
  });
}

export function parseMarkdownKnowledgeResourcePlanArgs(
  argv: readonly string[],
): RunMarkdownKnowledgeResourcePlanInput {
  if (argv.length % 2 !== 0)
    fail("MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_INVALID_ARGUMENT");
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      !key ||
      !value ||
      values.has(key) ||
      (!REQUIRED_ARGS.has(key) && !OPTIONAL_ARGS.has(key))
    ) {
      fail("MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_INVALID_ARGUMENT");
    }
    values.set(key, value);
  }
  if ([...REQUIRED_ARGS.keys()].some((key) => !values.has(key))) {
    fail("MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_INVALID_ARGUMENT");
  }
  const expectedKnowledgeSourceCount = Number(
    values.get("--expected-knowledge-count"),
  );
  const rawConcurrency = values.get("--read-concurrency");
  const readConcurrency =
    rawConcurrency === undefined ? undefined : Number(rawConcurrency);
  const input: RunMarkdownKnowledgeResourcePlanInput = {
    containmentRoot: values.get("--containment-root")!,
    preprocessedManifestPath: values.get("--preprocessed-manifest")!,
    preprocessedManifestFileSha256: values.get(
      "--preprocessed-manifest-file-sha256",
    )!,
    inventoryPath: values.get("--inventory")!,
    inventoryFileSha256: values.get("--inventory-file-sha256")!,
    inventorySemanticSha256: values.get("--inventory-semantic-sha256")!,
    sourceManifestSha256: values.get("--source-manifest-sha256")!,
    sourceSnapshotSha256: values.get("--source-snapshot-sha256")!,
    expectedKnowledgeSourceCount,
    outputPath: values.get("--output")!,
    createdAt: values.get("--created-at")!,
    ...(readConcurrency === undefined ? {} : { readConcurrency }),
  };
  validateInput(input);
  return Object.freeze(input);
}

export async function mainMarkdownKnowledgeResourcePlan(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  try {
    const result = await runMarkdownKnowledgeResourcePlan(
      parseMarkdownKnowledgeResourcePlanArgs(argv),
    );
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
    return 0;
  } catch (error) {
    const operatorError =
      error instanceof MarkdownKnowledgeResourcePlanOperatorError
        ? error
        : new MarkdownKnowledgeResourcePlanOperatorError(
            "MARKDOWN_KNOWLEDGE_RESOURCE_PLAN_PLANNER_REJECTED",
          );
    process.stderr.write(
      `${JSON.stringify({
        ok: false,
        error: { code: operatorError.code, message: operatorError.message },
      })}\n`,
    );
    return 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await mainMarkdownKnowledgeResourcePlan();
}
