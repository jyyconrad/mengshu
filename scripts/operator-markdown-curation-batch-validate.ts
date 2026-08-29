import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";
import { types as nodeUtilTypes } from "node:util";

import {
  MEMORY_CURATION_BATCH_PLAN_SCHEMA,
  type MemoryCurationBatchPlan,
} from "../packages/core/src/db/migrations/markdown-curation-batch-planner.js";
import {
  CURATION_ARTIFACT_BUNDLE_SCHEMA,
  validateCurationArtifactBundle,
  type CurationArtifactBundle,
  type CurationArtifactSectionHashes,
} from "../packages/core/src/documents/curation-artifacts.js";

export interface RunMarkdownCurationBatchValidationInput {
  readonly containmentRoot: string;
  readonly planPath: string;
  readonly planFileSha256: string;
  readonly batchId: string;
  readonly attemptDirectory: string;
}

export interface MarkdownCurationBatchValidationResult {
  readonly status: "accepted";
  readonly batchId: string;
  readonly planFileSha256: string;
  readonly planSha256: string;
  readonly receiptSha256: string;
  readonly artifactSetSha256: string;
  readonly sectionHashes: CurationArtifactSectionHashes;
  readonly counts: Readonly<{
    units: number;
    sources: number;
    documentProposals: number;
    relationProposals: number;
    reviewVerdicts: number;
  }>;
}

export type MarkdownCurationBatchValidationErrorCode =
  | "MARKDOWN_CURATION_BATCH_VALIDATION_INVALID_ARGUMENT"
  | "MARKDOWN_CURATION_BATCH_VALIDATION_PATH_ESCAPE"
  | "MARKDOWN_CURATION_BATCH_VALIDATION_SYMLINK"
  | "MARKDOWN_CURATION_BATCH_VALIDATION_LAYOUT_INVALID"
  | "MARKDOWN_CURATION_BATCH_VALIDATION_PLAN_DRIFT"
  | "MARKDOWN_CURATION_BATCH_VALIDATION_BATCH_NOT_FOUND"
  | "MARKDOWN_CURATION_BATCH_VALIDATION_CANONICAL_INVALID"
  | "MARKDOWN_CURATION_BATCH_VALIDATION_ARTIFACT_DRIFT"
  | "MARKDOWN_CURATION_BATCH_VALIDATION_FILESYSTEM_ERROR";

const MESSAGES: Record<MarkdownCurationBatchValidationErrorCode, string> = {
  MARKDOWN_CURATION_BATCH_VALIDATION_INVALID_ARGUMENT:
    "Markdown curation batch validation argument is invalid or not absolute",
  MARKDOWN_CURATION_BATCH_VALIDATION_PATH_ESCAPE:
    "Markdown curation batch validation path escapes the containment root",
  MARKDOWN_CURATION_BATCH_VALIDATION_SYMLINK:
    "Markdown curation batch validation rejects symlink input",
  MARKDOWN_CURATION_BATCH_VALIDATION_LAYOUT_INVALID:
    "Markdown curation batch validation layout contains a missing or unknown component",
  MARKDOWN_CURATION_BATCH_VALIDATION_PLAN_DRIFT:
    "Markdown curation batch validation plan hash or semantic hash drifted",
  MARKDOWN_CURATION_BATCH_VALIDATION_BATCH_NOT_FOUND:
    "Markdown curation batch validation batch does not exist",
  MARKDOWN_CURATION_BATCH_VALIDATION_CANONICAL_INVALID:
    "Markdown curation batch validation JSON or JSONL is not canonical",
  MARKDOWN_CURATION_BATCH_VALIDATION_ARTIFACT_DRIFT:
    "Markdown curation batch validation proposal manifest or Markdown hash drifted",
  MARKDOWN_CURATION_BATCH_VALIDATION_FILESYSTEM_ERROR:
    "Markdown curation batch validation filesystem operation failed",
};

export class MarkdownCurationBatchValidationError extends Error {
  constructor(readonly code: MarkdownCurationBatchValidationErrorCode) {
    super(MESSAGES[code]);
    this.name = "MarkdownCurationBatchValidationError";
  }
}

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,511}$/;
const PLAN_KEYS = [
  "schema", "migrationRunId", "sourceSnapshotSha256", "sourceManifestSha256",
  "preprocessedManifestSha256", "inventorySha256", "policyVersion", "createdAt",
  "maxUnitsPerBatch", "maxBytesPerBatch", "units", "batches", "summary", "guards",
  "planSha256",
] as const;
const TOP_LEVEL_COMPONENTS = new Map<string, "file" | "directory">([
  ["batch-receipt.json", "file"],
  ["unit-decisions.jsonl", "file"],
  ["document-proposals", "directory"],
  ["relation-proposals.jsonl", "file"],
  ["review-verdicts.jsonl", "file"],
]);

function fail(code: MarkdownCurationBatchValidationErrorCode): never {
  throw new MarkdownCurationBatchValidationError(code);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      nodeUtilTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stableValue(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.normalize("NFC");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("MARKDOWN_CURATION_BATCH_VALIDATION_CANONICAL_INVALID");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (nodeUtilTypes.isProxy(value) || seen.has(value)) {
      fail("MARKDOWN_CURATION_BATCH_VALIDATION_CANONICAL_INVALID");
    }
    seen.add(value);
    const result = value.map((item) => stableValue(item, seen));
    seen.delete(value);
    return result;
  }
  if (!plainRecord(value) || seen.has(value)) {
    fail("MARKDOWN_CURATION_BATCH_VALIDATION_CANONICAL_INVALID");
  }
  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (key !== key.normalize("NFC") || item === undefined || typeof item === "function" ||
        typeof item === "symbol" || typeof item === "bigint") {
      fail("MARKDOWN_CURATION_BATCH_VALIDATION_CANONICAL_INVALID");
    }
    result[key] = stableValue(item, seen);
  }
  seen.delete(value);
  return result;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function canonicalJsonl(values: readonly unknown[]): string {
  return values.length === 0
    ? ""
    : `${values.map((value) => JSON.stringify(stableValue(value))).join("\n")}\n`;
}

function parseCanonicalJson(serialized: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    fail("MARKDOWN_CURATION_BATCH_VALIDATION_CANONICAL_INVALID");
  }
  if (canonicalJson(value) !== serialized) {
    fail("MARKDOWN_CURATION_BATCH_VALIDATION_CANONICAL_INVALID");
  }
  return value;
}

function parseCanonicalJsonl(serialized: string): readonly unknown[] {
  if (serialized === "") return Object.freeze([]);
  if (!serialized.endsWith("\n") || serialized.includes("\r")) {
    fail("MARKDOWN_CURATION_BATCH_VALIDATION_CANONICAL_INVALID");
  }
  const lines = serialized.slice(0, -1).split("\n");
  if (lines.some((line) => line.length === 0)) {
    fail("MARKDOWN_CURATION_BATCH_VALIDATION_CANONICAL_INVALID");
  }
  let values: unknown[];
  try {
    values = lines.map((line) => JSON.parse(line) as unknown);
  } catch {
    fail("MARKDOWN_CURATION_BATCH_VALIDATION_CANONICAL_INVALID");
  }
  if (canonicalJsonl(values) !== serialized) {
    fail("MARKDOWN_CURATION_BATCH_VALIDATION_CANONICAL_INVALID");
  }
  return Object.freeze(values);
}

function strictDescendant(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) &&
    !isAbsolute(child);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function statPath(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
      fail("MARKDOWN_CURATION_BATCH_VALIDATION_LAYOUT_INVALID");
    }
    fail("MARKDOWN_CURATION_BATCH_VALIDATION_FILESYSTEM_ERROR");
  }
}

async function assertContainedPath(
  root: string,
  candidate: string,
  kind: "file" | "directory",
): Promise<void> {
  if (!strictDescendant(root, candidate)) {
    fail("MARKDOWN_CURATION_BATCH_VALIDATION_PATH_ESCAPE");
  }
  const child = relative(root, candidate);
  const segments = child.split(sep);
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = resolve(current, segments[index]!);
    const info = await statPath(current);
    if (info.isSymbolicLink()) fail("MARKDOWN_CURATION_BATCH_VALIDATION_SYMLINK");
    if (index < segments.length - 1 && !info.isDirectory()) {
      fail("MARKDOWN_CURATION_BATCH_VALIDATION_LAYOUT_INVALID");
    }
    if (index === segments.length - 1 &&
        (kind === "file" ? !info.isFile() : !info.isDirectory())) {
      fail("MARKDOWN_CURATION_BATCH_VALIDATION_LAYOUT_INVALID");
    }
  }
}

async function readContainedFile(root: string, path: string): Promise<Buffer> {
  await assertContainedPath(root, path, "file");
  try {
    return await readFile(path);
  } catch {
    fail("MARKDOWN_CURATION_BATCH_VALIDATION_FILESYSTEM_ERROR");
  }
}

function assertAbsoluteCanonicalPath(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) {
    fail("MARKDOWN_CURATION_BATCH_VALIDATION_INVALID_ARGUMENT");
  }
  return value;
}

function validateInput(input: RunMarkdownCurationBatchValidationInput): Readonly<{
  containmentRoot: string;
  planPath: string;
  planFileSha256: string;
  batchId: string;
  attemptDirectory: string;
}> {
  if (!plainRecord(input) || !SHA256.test(input.planFileSha256) ||
      !SAFE_ID.test(input.batchId)) {
    fail("MARKDOWN_CURATION_BATCH_VALIDATION_INVALID_ARGUMENT");
  }
  const containmentRoot = assertAbsoluteCanonicalPath(input.containmentRoot);
  const planPath = assertAbsoluteCanonicalPath(input.planPath);
  const attemptDirectory = assertAbsoluteCanonicalPath(input.attemptDirectory);
  if (!strictDescendant(containmentRoot, planPath) ||
      !strictDescendant(containmentRoot, attemptDirectory)) {
    fail("MARKDOWN_CURATION_BATCH_VALIDATION_PATH_ESCAPE");
  }
  return Object.freeze({
    containmentRoot,
    planPath,
    planFileSha256: input.planFileSha256,
    batchId: input.batchId,
    attemptDirectory,
  });
}

function parsePlan(serialized: string, batchId: string): MemoryCurationBatchPlan {
  const value = parseCanonicalJson(serialized);
  if (!plainRecord(value) || Object.keys(value).sort().join("\0") !==
      [...PLAN_KEYS].sort().join("\0") || value.schema !== MEMORY_CURATION_BATCH_PLAN_SCHEMA ||
      !SHA256.test(String(value.planSha256)) || !Array.isArray(value.units) ||
      !Array.isArray(value.batches) || !Array.isArray(value.guards)) {
    fail("MARKDOWN_CURATION_BATCH_VALIDATION_PLAN_DRIFT");
  }
  const { planSha256, ...body } = value;
  if (sha256(JSON.stringify(stableValue(body))) !== planSha256) {
    fail("MARKDOWN_CURATION_BATCH_VALIDATION_PLAN_DRIFT");
  }
  if (!value.batches.some((batch) => plainRecord(batch) && batch.batchId === batchId)) {
    fail("MARKDOWN_CURATION_BATCH_VALIDATION_BATCH_NOT_FOUND");
  }
  return value as unknown as MemoryCurationBatchPlan;
}

async function assertRoot(root: string): Promise<void> {
  const info = await statPath(root);
  if (info.isSymbolicLink()) fail("MARKDOWN_CURATION_BATCH_VALIDATION_SYMLINK");
  if (!info.isDirectory()) fail("MARKDOWN_CURATION_BATCH_VALIDATION_INVALID_ARGUMENT");
}

async function assertAttemptLayout(root: string, attemptDirectory: string): Promise<void> {
  await assertContainedPath(root, attemptDirectory, "directory");
  let entries;
  try {
    entries = await readdir(attemptDirectory, { withFileTypes: true });
  } catch {
    fail("MARKDOWN_CURATION_BATCH_VALIDATION_FILESYSTEM_ERROR");
  }
  if (entries.length !== TOP_LEVEL_COMPONENTS.size || entries.some((entry) => {
    const kind = TOP_LEVEL_COMPONENTS.get(entry.name);
    return !kind || entry.isSymbolicLink() ||
      (kind === "file" ? !entry.isFile() : !entry.isDirectory());
  })) {
    if (entries.some((entry) => entry.isSymbolicLink())) {
      fail("MARKDOWN_CURATION_BATCH_VALIDATION_SYMLINK");
    }
    fail("MARKDOWN_CURATION_BATCH_VALIDATION_LAYOUT_INVALID");
  }
}

async function readStructuredArtifacts(attemptDirectory: string): Promise<Readonly<{
  receiptText: string;
  receipt: unknown;
  unitDecisions: readonly unknown[];
  documentProposals: readonly unknown[];
  relationProposals: readonly unknown[];
  reviewVerdicts: readonly unknown[];
  serializedHashes: Readonly<{
    receipt: string;
    unitDecisions: string;
    documentProposalManifest: string;
    relationProposals: string;
    reviewVerdicts: string;
  }>;
}>> {
  const paths = {
    receipt: resolve(attemptDirectory, "batch-receipt.json"),
    unitDecisions: resolve(attemptDirectory, "unit-decisions.jsonl"),
    documentProposalManifest: resolve(attemptDirectory, "document-proposals/manifest.jsonl"),
    relationProposals: resolve(attemptDirectory, "relation-proposals.jsonl"),
    reviewVerdicts: resolve(attemptDirectory, "review-verdicts.jsonl"),
  };
  const buffers = await Promise.all(Object.values(paths).map((path) =>
    readContainedFile(attemptDirectory, path)));
  const texts = buffers.map((buffer) => buffer.toString("utf8"));
  return Object.freeze({
    receiptText: texts[0]!,
    receipt: parseCanonicalJson(texts[0]!),
    unitDecisions: parseCanonicalJsonl(texts[1]!),
    documentProposals: parseCanonicalJsonl(texts[2]!),
    relationProposals: parseCanonicalJsonl(texts[3]!),
    reviewVerdicts: parseCanonicalJsonl(texts[4]!),
    serializedHashes: Object.freeze({
      receipt: sha256(buffers[0]!),
      unitDecisions: sha256(buffers[1]!),
      documentProposalManifest: sha256(buffers[2]!),
      relationProposals: sha256(buffers[3]!),
      reviewVerdicts: sha256(buffers[4]!),
    }),
  });
}

function componentHash(entries: readonly Readonly<{ path: string; hash: string }>[]): string {
  const material = [...entries]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((entry) => `${entry.path}\t${entry.hash}\n`)
    .join("");
  return sha256(material);
}

async function validateProposalFiles(
  attemptDirectory: string,
  bundle: CurationArtifactBundle,
  manifestSha256: string,
): Promise<string> {
  const proposalDirectory = resolve(attemptDirectory, "document-proposals");
  await assertContainedPath(attemptDirectory, proposalDirectory, "directory");
  let entries;
  try {
    entries = await readdir(proposalDirectory, { withFileTypes: true });
  } catch {
    fail("MARKDOWN_CURATION_BATCH_VALIDATION_FILESYSTEM_ERROR");
  }
  if (entries.some((entry) => entry.isSymbolicLink())) {
    fail("MARKDOWN_CURATION_BATCH_VALIDATION_SYMLINK");
  }
  if (entries.some((entry) => !entry.isFile())) {
    fail("MARKDOWN_CURATION_BATCH_VALIDATION_LAYOUT_INVALID");
  }

  const proposalPaths = bundle.documentProposals.map((proposal) => proposal.relativePath);
  if (new Set(proposalPaths).size !== proposalPaths.length || proposalPaths.some((path) =>
    dirname(path) !== "document-proposals")) {
    fail("MARKDOWN_CURATION_BATCH_VALIDATION_ARTIFACT_DRIFT");
  }
  const expectedNames = new Set([
    "manifest.jsonl",
    ...proposalPaths.map((path) => path.slice("document-proposals/".length)),
  ]);
  const actualNames = new Set(entries.map((entry) => entry.name));
  if (expectedNames.size !== actualNames.size ||
      [...expectedNames].some((name) => !actualNames.has(name))) {
    fail("MARKDOWN_CURATION_BATCH_VALIDATION_ARTIFACT_DRIFT");
  }

  const fileHashes: Array<Readonly<{ path: string; hash: string }>> = [{
    path: "document-proposals/manifest.jsonl",
    hash: manifestSha256,
  }];
  for (const proposal of bundle.documentProposals) {
    const absolutePath = resolve(attemptDirectory, proposal.relativePath);
    if (!strictDescendant(proposalDirectory, absolutePath)) {
      fail("MARKDOWN_CURATION_BATCH_VALIDATION_PATH_ESCAPE");
    }
    const content = await readContainedFile(attemptDirectory, absolutePath);
    const actualHash = sha256(content);
    if (actualHash !== proposal.markdownSha256) {
      fail("MARKDOWN_CURATION_BATCH_VALIDATION_ARTIFACT_DRIFT");
    }
    fileHashes.push({ path: proposal.relativePath, hash: actualHash });
  }
  return componentHash(fileHashes);
}

export async function runMarkdownCurationBatchValidation(
  input: RunMarkdownCurationBatchValidationInput,
): Promise<MarkdownCurationBatchValidationResult> {
  const validatedInput = validateInput(input);
  await assertRoot(validatedInput.containmentRoot);
  await assertContainedPath(validatedInput.containmentRoot, validatedInput.planPath, "file");
  await assertAttemptLayout(validatedInput.containmentRoot, validatedInput.attemptDirectory);

  const planBuffer = await readContainedFile(
    validatedInput.containmentRoot,
    validatedInput.planPath,
  );
  if (sha256(planBuffer) !== validatedInput.planFileSha256) {
    fail("MARKDOWN_CURATION_BATCH_VALIDATION_PLAN_DRIFT");
  }
  const plan = parsePlan(planBuffer.toString("utf8"), validatedInput.batchId);
  const artifacts = await readStructuredArtifacts(validatedInput.attemptDirectory);
  const value = {
    schema: CURATION_ARTIFACT_BUNDLE_SCHEMA,
    receipt: artifacts.receipt,
    unitDecisions: artifacts.unitDecisions,
    documentProposals: artifacts.documentProposals,
    relationProposals: artifacts.relationProposals,
    reviewVerdicts: artifacts.reviewVerdicts,
  };
  const bundle = validateCurationArtifactBundle(value, {
    plan,
    batchId: validatedInput.batchId,
  });
  const documentProposalComponentHash = await validateProposalFiles(
    validatedInput.attemptDirectory,
    bundle,
    artifacts.serializedHashes.documentProposalManifest,
  );
  const artifactSetSha256 = componentHash([
    { path: "batch-receipt.json", hash: artifacts.serializedHashes.receipt },
    { path: "unit-decisions.jsonl", hash: artifacts.serializedHashes.unitDecisions },
    { path: "document-proposals", hash: documentProposalComponentHash },
    { path: "relation-proposals.jsonl", hash: artifacts.serializedHashes.relationProposals },
    { path: "review-verdicts.jsonl", hash: artifacts.serializedHashes.reviewVerdicts },
  ]);
  return Object.freeze({
    status: "accepted",
    batchId: validatedInput.batchId,
    planFileSha256: validatedInput.planFileSha256,
    planSha256: plan.planSha256,
    receiptSha256: artifacts.serializedHashes.receipt,
    artifactSetSha256,
    sectionHashes: bundle.receipt.sectionHashes,
    counts: Object.freeze({
      units: bundle.unitDecisions.length,
      sources: bundle.receipt.sourceCount,
      documentProposals: bundle.documentProposals.length,
      relationProposals: bundle.relationProposals.length,
      reviewVerdicts: bundle.reviewVerdicts.length,
    }),
  });
}

function parseOptions(argv: readonly string[]): ReadonlyMap<string, string> {
  if (argv.length % 2 !== 0) fail("MARKDOWN_CURATION_BATCH_VALIDATION_INVALID_ARGUMENT");
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--") || options.has(flag)) {
      fail("MARKDOWN_CURATION_BATCH_VALIDATION_INVALID_ARGUMENT");
    }
    options.set(flag, value);
  }
  return options;
}

export function parseMarkdownCurationBatchValidationArgs(
  argv: readonly string[],
): RunMarkdownCurationBatchValidationInput {
  const options = parseOptions(argv);
  const expected = [
    "--containment-root", "--plan", "--plan-file-sha256", "--batch-id", "--attempt-dir",
  ];
  if (options.size !== expected.length || expected.some((flag) => !options.has(flag))) {
    fail("MARKDOWN_CURATION_BATCH_VALIDATION_INVALID_ARGUMENT");
  }
  return validateInput({
    containmentRoot: options.get("--containment-root")!,
    planPath: options.get("--plan")!,
    planFileSha256: options.get("--plan-file-sha256")!,
    batchId: options.get("--batch-id")!,
    attemptDirectory: options.get("--attempt-dir")!,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMarkdownCurationBatchValidation(parseMarkdownCurationBatchValidationArgs(
    process.argv.slice(2),
  )).then((report) => {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }).catch((error) => {
    const safe = error instanceof MarkdownCurationBatchValidationError
      ? { code: error.code, message: error.message }
      : { code: "MARKDOWN_CURATION_BATCH_VALIDATION_FAILED", message: "Validation failed" };
    process.stderr.write(`${JSON.stringify(safe)}\n`);
    process.exitCode = 1;
  });
}
