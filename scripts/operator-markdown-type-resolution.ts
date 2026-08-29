import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { types as nodeUtilTypes } from "node:util";

import {
  MEMORY_CURATION_BATCH_PLAN_SCHEMA,
  type MemoryCurationBatch,
  type MemoryCurationBatchPlan,
  type MemoryCurationUnit,
} from "../packages/core/src/db/migrations/markdown-curation-batch-planner.js";
import {
  CURATION_ARTIFACT_BUNDLE_SCHEMA,
  validateCurationArtifactBundle,
  type CurationArtifactBundle,
  type SourceBinding,
} from "../packages/core/src/documents/curation-artifacts.js";
import type { MemorySemanticType } from "../packages/core/src/domain/types.js";
import { runMarkdownCurationBatchValidation } from "./operator-markdown-curation-batch-validate.js";

const INPUT_MANIFEST_SCHEMA = "mengshu.type-resolution-input-manifest/v1" as const;
const ARBITRATION_DRAFT_SCHEMA = "mengshu.type-resolution-arbitration-draft/v1" as const;
const UNIT_RESOLUTION_SCHEMA = "mengshu.unit-type-resolution/v1" as const;
const SOURCE_DISPOSITION_SCHEMA = "mengshu.source-type-disposition/v1" as const;
const RESOLUTION_SUMMARY_SCHEMA = "mengshu.type-resolution-summary/v1" as const;
const RESOLUTION_RECEIPT_SCHEMA = "mengshu.type-resolution-receipt/v1" as const;
const REVIEW_DRAFT_SCHEMA = "mengshu.type-review-review-draft/v1" as const;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,511}$/;
const SAFE_REASON = /^[a-z][a-z0-9_]{0,127}$/;
const PLAN_KEYS = [
  "schema", "migrationRunId", "sourceSnapshotSha256", "sourceManifestSha256",
  "preprocessedManifestSha256", "inventorySha256", "policyVersion", "createdAt",
  "maxUnitsPerBatch", "maxBytesPerBatch", "units", "batches", "summary", "guards",
  "planSha256",
] as const;
const SEMANTIC_TYPES = new Set<MemorySemanticType>([
  "profile", "task_context", "rules", "experience", "resource",
]);
const DISPOSITIONS = new Set([
  "canonical_keep", "merge_exact", "merge_semantic", "supersede", "archive_stale",
  "lookup_only", "quarantine", "distinct_keep",
]);

export interface TypeResolutionQuarantineAttempt {
  readonly sequence: number;
  readonly batchId: string;
  readonly attemptDirectory: string;
  readonly artifactSetSha256: string;
}

export interface TypeResolutionReviewAttempt {
  readonly sequence: number;
  readonly batchId: string;
  readonly primaryAttemptDirectory: string;
  readonly primaryArtifactSetSha256: string;
  readonly reviewAttemptDirectory: string;
  readonly reviewArtifactSetSha256: string;
  readonly reviewDraftPath: string;
  readonly reviewDraftSha256: string;
}

export interface TypeResolutionInputManifest {
  readonly schema: typeof INPUT_MANIFEST_SCHEMA;
  readonly planFileSha256: string;
  readonly planSha256: string;
  readonly quarantineAttempts: readonly TypeResolutionQuarantineAttempt[];
  readonly reviewAttempts: readonly TypeResolutionReviewAttempt[];
}

export interface TypeResolutionArbitrationDecision {
  readonly unitId: string;
  readonly scopeFingerprint: string;
  readonly sources: readonly SourceBinding[];
  readonly proposalId: string;
  readonly reviewedArtifactHash: string;
  readonly semanticType: MemorySemanticType;
  readonly disposition: string;
  readonly confidence: number;
  readonly conflict: boolean;
  readonly reasonCodes: readonly string[];
}

export interface TypeResolutionArbitrationDraft {
  readonly schema: typeof ARBITRATION_DRAFT_SCHEMA;
  readonly planSha256: string;
  readonly createdAt: string;
  readonly candidateOnly: true;
  readonly decisions: readonly TypeResolutionArbitrationDecision[];
}

export interface RunMarkdownTypeResolutionInput {
  readonly containmentRoot: string;
  readonly planPath: string;
  readonly planFileSha256: string;
  readonly inputManifestPath: string;
  readonly inputManifestFileSha256: string;
  readonly arbitrationDraftPath: string;
  readonly arbitrationDraftFileSha256: string;
  readonly outputDirectory: string;
  readonly createdAt: string;
}

export interface MarkdownTypeResolutionResult {
  readonly status: "accepted";
  readonly outputDirectory: string;
  readonly units: number;
  readonly sources: number;
  readonly unresolved: 0;
  readonly acceptedPrimary: number;
  readonly arbitrated: number;
  readonly outputHashes: Readonly<{
    unitTypeResolutions: string;
    sourceTypeDispositions: string;
    resolutionSummary: string;
  }>;
  readonly receiptSha256: string;
}

interface ReviewVerdictDraft {
  readonly unitId: string;
  readonly proposalId: string;
  readonly reviewedArtifactHash: string;
  readonly verdict: "accept" | "override" | "needs_review";
  readonly proposedSemanticType: MemorySemanticType;
  readonly dispositionCandidate: string;
  readonly confidence: number;
  readonly conflict: boolean;
  readonly reasonCodes: readonly string[];
  readonly notes: readonly string[];
}

interface ParsedReviewDraft {
  readonly batchId: string;
  readonly reviewer: string;
  readonly createdAt: string;
  readonly verdicts: readonly ReviewVerdictDraft[];
}

type ResolutionBasis = "quarantine" | "accepted_primary" | "arbitration";

interface UnitTypeResolution {
  readonly schema: typeof UNIT_RESOLUTION_SCHEMA;
  readonly unitId: string;
  readonly batchId: string;
  readonly sequence: number;
  readonly scopeFingerprint: string | null;
  readonly sources: readonly SourceBinding[];
  readonly semanticType: MemorySemanticType | null;
  readonly disposition: string;
  readonly confidence: number | null;
  readonly conflict: boolean;
  readonly resolutionBasis: ResolutionBasis;
  readonly proposalId: string | null;
  readonly reviewedArtifactHash: string | null;
  readonly reasonCodes: readonly string[];
  readonly candidateOnly: false;
}

function fail(message: string): never {
  throw new Error(`MARKDOWN_TYPE_RESOLUTION_INVALID: ${message}`);
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

function exactKeys(value: unknown, expected: readonly string[], label: string): Record<string, unknown> {
  if (!plainRecord(value)) fail(`${label} shape`);
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    fail(`${label} exact keys`);
  }
  return value;
}

function stableValue(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.normalize("NFC");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("canonical non-finite number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (nodeUtilTypes.isProxy(value) || seen.has(value)) fail("canonical proxy or cycle");
    seen.add(value);
    const result = value.map((item) => stableValue(item, seen));
    seen.delete(value);
    return result;
  }
  if (!plainRecord(value) || seen.has(value)) fail("canonical non-plain value");
  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (key !== key.normalize("NFC") || item === undefined || typeof item === "function" ||
        typeof item === "symbol" || typeof item === "bigint") fail("canonical unsupported value");
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

function parseCanonicalJson(text: string, label: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail(`${label} JSON`);
  }
  if (canonicalJson(value) !== text) fail(`${label} canonical JSON`);
  return value;
}

function parseCanonicalJsonl(text: string, label: string): readonly unknown[] {
  if (text === "") return Object.freeze([]);
  if (!text.endsWith("\n") || text.includes("\r")) fail(`${label} canonical JSONL`);
  const lines = text.slice(0, -1).split("\n");
  if (lines.some((line) => line.length === 0)) fail(`${label} canonical JSONL`);
  let values: unknown[];
  try {
    values = lines.map((line) => JSON.parse(line) as unknown);
  } catch {
    fail(`${label} JSONL`);
  }
  if (canonicalJsonl(values) !== text) fail(`${label} canonical JSONL`);
  return Object.freeze(values);
}

function iso(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value) fail(`${label} timestamp`);
  return value;
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) fail(`${label} id`);
  return value;
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(`${label} hash`);
  return value;
}

function positiveSequence(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    fail(`${label} sequence`);
  }
  return value;
}

function reasonCodes(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) || value.length === 0) {
    fail(`${label} reason codes`);
  }
  const result = value.map((reason) => {
    if (typeof reason !== "string" || !SAFE_REASON.test(reason)) fail(`${label} reason code`);
    return reason;
  });
  if (new Set(result).size !== result.length) fail(`${label} duplicate reason code`);
  return Object.freeze(result);
}

function semanticType(value: unknown, label: string): MemorySemanticType {
  if (typeof value !== "string" || !SEMANTIC_TYPES.has(value as MemorySemanticType)) {
    fail(`${label} semantic type`);
  }
  return value as MemorySemanticType;
}

function disposition(value: unknown, label: string): string {
  if (typeof value !== "string" || !DISPOSITIONS.has(value)) fail(`${label} disposition`);
  return value;
}

function confidence(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    fail(`${label} confidence`);
  }
  return value;
}

function strictDescendant(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function absolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) {
    fail(`${label} absolute path`);
  }
  return value;
}

async function pathInfo(path: string) {
  try {
    return await lstat(path);
  } catch {
    return undefined;
  }
}

async function assertContainedPath(
  root: string,
  candidate: string,
  kind: "file" | "directory",
): Promise<void> {
  if (!strictDescendant(root, candidate)) fail("path containment escape");
  const segments = relative(root, candidate).split(sep);
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = resolve(current, segments[index]!);
    const info = await pathInfo(current);
    if (!info) fail("contained input path missing");
    if (info.isSymbolicLink()) fail("symlink input path");
    if (index < segments.length - 1 && !info.isDirectory()) fail("input path ancestor");
    if (index === segments.length - 1 &&
        (kind === "file" ? !info.isFile() : !info.isDirectory())) fail("input path kind");
  }
}

async function readContainedFile(root: string, path: string): Promise<Buffer> {
  await assertContainedPath(root, path, "file");
  return readFile(path);
}

async function readPlan(
  root: string,
  path: string,
  expectedFileSha256: string,
): Promise<MemoryCurationBatchPlan> {
  const content = await readContainedFile(root, path);
  if (sha256(content) !== expectedFileSha256) fail("plan file hash drift");
  const value = parseCanonicalJson(content.toString("utf8"), "plan");
  if (!plainRecord(value) || Object.keys(value).sort().join("\0") !==
      [...PLAN_KEYS].sort().join("\0") || value.schema !== MEMORY_CURATION_BATCH_PLAN_SCHEMA ||
      !Array.isArray(value.units) || !Array.isArray(value.batches) ||
      !Array.isArray(value.guards) || !SHA256.test(String(value.planSha256))) {
    fail("plan contract");
  }
  const { planSha256, ...body } = value;
  if (sha256(JSON.stringify(stableValue(body))) !== planSha256) fail("plan semantic hash drift");
  return value as unknown as MemoryCurationBatchPlan;
}

function sourceBindings(value: unknown, label: string): readonly SourceBinding[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) || value.length === 0) {
    fail(`${label} sources`);
  }
  const seen = new Set<string>();
  const bindings = value.map((raw, index) => {
    const item = exactKeys(raw, ["sourceRef", "sourceHash"], `${label} source[${index}]`);
    const sourceRef = safeId(item.sourceRef, `${label} sourceRef`);
    const sourceHash = hash(item.sourceHash, `${label} sourceHash`);
    if (seen.has(sourceRef)) fail(`${label} duplicate source`);
    seen.add(sourceRef);
    return Object.freeze({ sourceRef, sourceHash });
  });
  return Object.freeze(bindings);
}

function planBindings(unit: MemoryCurationUnit): readonly SourceBinding[] {
  if (unit.files.length !== unit.sourceCount || unit.sourceRefs.length !== unit.sourceHashes.length) {
    fail("plan unit source coverage");
  }
  const files = sourceBindings(unit.files.map((file) => ({
    sourceRef: file.sourceRef,
    sourceHash: file.sourceHash,
  })), `plan unit ${unit.unitId}`);
  const legacy = sourceBindings(unit.sourceRefs.map((sourceRef, index) => ({
    sourceRef,
    sourceHash: unit.sourceHashes[index],
  })), `plan unit ${unit.unitId} legacy`);
  if (!sameBindings(files, legacy)) fail("plan unit source binding drift");
  return files;
}

function bindingKey(value: SourceBinding): string {
  return `${value.sourceRef}\0${value.sourceHash}`;
}

function sameBindings(left: readonly SourceBinding[], right: readonly SourceBinding[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(right.map(bindingKey));
  return left.every((binding) => expected.has(bindingKey(binding)));
}

function parseInputManifest(value: unknown): TypeResolutionInputManifest {
  const root = exactKeys(value, [
    "schema", "planFileSha256", "planSha256", "quarantineAttempts", "reviewAttempts",
  ], "input manifest");
  if (root.schema !== INPUT_MANIFEST_SCHEMA || !Array.isArray(root.quarantineAttempts) ||
      !Array.isArray(root.reviewAttempts) || nodeUtilTypes.isProxy(root.quarantineAttempts) ||
      nodeUtilTypes.isProxy(root.reviewAttempts)) fail("input manifest identity");
  const quarantineAttempts = root.quarantineAttempts.map((raw, index) => {
    const item = exactKeys(raw, [
      "sequence", "batchId", "attemptDirectory", "artifactSetSha256",
    ], `quarantine attempt[${index}]`);
    return Object.freeze({
      sequence: positiveSequence(item.sequence, "quarantine attempt"),
      batchId: safeId(item.batchId, "quarantine batch"),
      attemptDirectory: absolutePath(item.attemptDirectory, "quarantine attempt"),
      artifactSetSha256: hash(item.artifactSetSha256, "quarantine artifact set"),
    });
  });
  const reviewAttempts = root.reviewAttempts.map((raw, index) => {
    const item = exactKeys(raw, [
      "sequence", "batchId", "primaryAttemptDirectory", "primaryArtifactSetSha256",
      "reviewAttemptDirectory", "reviewArtifactSetSha256", "reviewDraftPath",
      "reviewDraftSha256",
    ], `review attempt[${index}]`);
    return Object.freeze({
      sequence: positiveSequence(item.sequence, "review attempt"),
      batchId: safeId(item.batchId, "review batch"),
      primaryAttemptDirectory: absolutePath(item.primaryAttemptDirectory, "primary attempt"),
      primaryArtifactSetSha256: hash(item.primaryArtifactSetSha256, "primary artifact set"),
      reviewAttemptDirectory: absolutePath(item.reviewAttemptDirectory, "review attempt"),
      reviewArtifactSetSha256: hash(item.reviewArtifactSetSha256, "review artifact set"),
      reviewDraftPath: absolutePath(item.reviewDraftPath, "review draft"),
      reviewDraftSha256: hash(item.reviewDraftSha256, "review draft"),
    });
  });
  return Object.freeze({
    schema: INPUT_MANIFEST_SCHEMA,
    planFileSha256: hash(root.planFileSha256, "manifest plan file"),
    planSha256: hash(root.planSha256, "manifest plan"),
    quarantineAttempts: Object.freeze(quarantineAttempts),
    reviewAttempts: Object.freeze(reviewAttempts),
  });
}

function parseArbitrationDraft(value: unknown): TypeResolutionArbitrationDraft {
  const root = exactKeys(value, [
    "schema", "planSha256", "createdAt", "candidateOnly", "decisions",
  ], "arbitration draft");
  if (root.schema !== ARBITRATION_DRAFT_SCHEMA || root.candidateOnly !== true ||
      !Array.isArray(root.decisions) || nodeUtilTypes.isProxy(root.decisions)) {
    fail("arbitration draft identity");
  }
  const decisions = root.decisions.map((raw, index): TypeResolutionArbitrationDecision => {
    const item = exactKeys(raw, [
      "unitId", "scopeFingerprint", "sources", "proposalId", "reviewedArtifactHash",
      "semanticType", "disposition", "confidence", "conflict", "reasonCodes",
    ], `arbitration decision[${index}]`);
    return Object.freeze({
      unitId: safeId(item.unitId, "arbitration unit"),
      scopeFingerprint: hash(item.scopeFingerprint, "arbitration scope"),
      sources: sourceBindings(item.sources, `arbitration ${String(item.unitId)}`),
      proposalId: safeId(item.proposalId, "arbitration proposal"),
      reviewedArtifactHash: hash(item.reviewedArtifactHash, "arbitration artifact"),
      semanticType: semanticType(item.semanticType, "arbitration"),
      disposition: disposition(item.disposition, "arbitration"),
      confidence: confidence(item.confidence, "arbitration"),
      conflict: typeof item.conflict === "boolean" ? item.conflict : fail("arbitration conflict"),
      reasonCodes: reasonCodes(item.reasonCodes, "arbitration"),
    });
  });
  if (new Set(decisions.map((item) => item.unitId)).size !== decisions.length) {
    fail("arbitration duplicate unit coverage");
  }
  return Object.freeze({
    schema: ARBITRATION_DRAFT_SCHEMA,
    planSha256: hash(root.planSha256, "arbitration plan"),
    createdAt: iso(root.createdAt, "arbitration"),
    candidateOnly: true,
    decisions: Object.freeze(decisions),
  });
}

function parseReviewDraft(value: unknown, batchId: string): ParsedReviewDraft {
  const root = exactKeys(value, [
    "schema", "batchId", "reviewer", "createdAt", "candidateOnly", "verdicts",
  ], "review draft");
  if (root.schema !== REVIEW_DRAFT_SCHEMA || root.batchId !== batchId ||
      root.candidateOnly !== true || !Array.isArray(root.verdicts) ||
      nodeUtilTypes.isProxy(root.verdicts)) fail("review draft identity");
  const reviewer = safeId(root.reviewer, "reviewer");
  const verdicts = root.verdicts.map((raw, index): ReviewVerdictDraft => {
    const item = exactKeys(raw, [
      "unitId", "proposalId", "reviewedArtifactHash", "verdict", "proposedSemanticType",
      "dispositionCandidate", "confidence", "conflict", "reasonCodes", "notes",
    ], `review verdict[${index}]`);
    if (!["accept", "override", "needs_review"].includes(String(item.verdict)) ||
        typeof item.conflict !== "boolean" || !Array.isArray(item.notes) ||
        item.notes.length === 0 || item.notes.some((note) => typeof note !== "string" ||
          note.trim() !== note || note.length === 0 || /[\p{Cc}\r\n]/u.test(note))) {
      fail("review verdict value");
    }
    return Object.freeze({
      unitId: safeId(item.unitId, "review unit"),
      proposalId: safeId(item.proposalId, "review proposal"),
      reviewedArtifactHash: hash(item.reviewedArtifactHash, "review artifact"),
      verdict: item.verdict as ReviewVerdictDraft["verdict"],
      proposedSemanticType: semanticType(item.proposedSemanticType, "review"),
      dispositionCandidate: disposition(item.dispositionCandidate, "review"),
      confidence: confidence(item.confidence, "review"),
      conflict: item.conflict,
      reasonCodes: reasonCodes(item.reasonCodes, "review"),
      notes: Object.freeze(item.notes as string[]),
    });
  });
  if (new Set(verdicts.map((item) => item.unitId)).size !== verdicts.length ||
      new Set(verdicts.map((item) => item.proposalId)).size !== verdicts.length) {
    fail("review duplicate unit or proposal coverage");
  }
  return Object.freeze({
    batchId,
    reviewer,
    createdAt: iso(root.createdAt, "review"),
    verdicts: Object.freeze(verdicts),
  });
}

async function readBundle(
  plan: MemoryCurationBatchPlan,
  batchId: string,
  attemptDirectory: string,
): Promise<CurationArtifactBundle> {
  const [receiptText, unitText, proposalText, relationText, verdictText] = await Promise.all([
    readFile(resolve(attemptDirectory, "batch-receipt.json"), "utf8"),
    readFile(resolve(attemptDirectory, "unit-decisions.jsonl"), "utf8"),
    readFile(resolve(attemptDirectory, "document-proposals/manifest.jsonl"), "utf8"),
    readFile(resolve(attemptDirectory, "relation-proposals.jsonl"), "utf8"),
    readFile(resolve(attemptDirectory, "review-verdicts.jsonl"), "utf8"),
  ]);
  return validateCurationArtifactBundle({
    schema: CURATION_ARTIFACT_BUNDLE_SCHEMA,
    receipt: parseCanonicalJson(receiptText, "attempt receipt"),
    unitDecisions: parseCanonicalJsonl(unitText, "attempt units"),
    documentProposals: parseCanonicalJsonl(proposalText, "attempt proposals"),
    relationProposals: parseCanonicalJsonl(relationText, "attempt relations"),
    reviewVerdicts: parseCanonicalJsonl(verdictText, "attempt verdicts"),
  }, { plan, batchId });
}

function candidateDisposition(bundle: CurationArtifactBundle, unitId: string): string {
  const decision = bundle.unitDecisions.find((item) => item.unitId === unitId);
  if (!decision) fail("primary unit decision missing");
  const prefix = "candidate_disposition_";
  const values = decision.reasonCodes.filter((reason) => reason.startsWith(prefix));
  if (values.length !== 1) fail("primary candidate disposition coverage");
  return disposition(values[0]!.slice(prefix.length), "primary candidate");
}

function primaryConflict(bundle: CurationArtifactBundle, unitId: string): boolean {
  const decision = bundle.unitDecisions.find((item) => item.unitId === unitId);
  if (!decision) fail("primary unit conflict missing");
  const observed = decision.reasonCodes.includes("content_conflict_observed");
  const absent = decision.reasonCodes.includes("content_conflict_not_observed");
  if (observed === absent) fail("primary conflict marker coverage");
  return observed;
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function expectedVerdictId(
  plan: MemoryCurationBatchPlan,
  batchId: string,
  verdict: ReviewVerdictDraft,
  reviewer: string,
): string {
  return `verdict_${sha256([
    "mengshu.type-review-verdict/v1", plan.planSha256, batchId, verdict.unitId,
    verdict.proposalId, verdict.reviewedArtifactHash, reviewer,
  ].join("\0")).slice(0, 32)}`;
}

function attemptSetHash(manifest: TypeResolutionInputManifest): string {
  const entries = [
    ...manifest.quarantineAttempts.map((item) => ({
      key: `${item.sequence}:quarantine:${item.batchId}`,
      hash: item.artifactSetSha256,
    })),
    ...manifest.reviewAttempts.flatMap((item) => [
      { key: `${item.sequence}:primary:${item.batchId}`, hash: item.primaryArtifactSetSha256 },
      { key: `${item.sequence}:review:${item.batchId}`, hash: item.reviewArtifactSetSha256 },
      { key: `${item.sequence}:review-draft:${item.batchId}`, hash: item.reviewDraftSha256 },
    ]),
  ].sort((left, right) => left.key.localeCompare(right.key));
  return sha256(entries.map((item) => `${item.key}\t${item.hash}\n`).join(""));
}

function createResolution(
  unit: MemoryCurationUnit,
  batch: MemoryCurationBatch,
  value: Omit<UnitTypeResolution, "schema" | "unitId" | "batchId" | "sequence" |
    "scopeFingerprint" | "sources" | "candidateOnly">,
): UnitTypeResolution {
  return Object.freeze({
    schema: UNIT_RESOLUTION_SCHEMA,
    unitId: unit.unitId,
    batchId: batch.batchId,
    sequence: batch.sequence,
    scopeFingerprint: unit.scopeFingerprint ?? null,
    sources: Object.freeze([...planBindings(unit)].sort((left, right) =>
      left.sourceRef.localeCompare(right.sourceRef))),
    ...value,
    candidateOnly: false,
  });
}

async function validateAttempt(
  root: string,
  planPath: string,
  planFileSha256: string,
  batchId: string,
  attemptDirectory: string,
  expectedArtifactSetSha256: string,
): Promise<void> {
  await assertContainedPath(root, attemptDirectory, "directory");
  const validation = await runMarkdownCurationBatchValidation({
    containmentRoot: root,
    planPath,
    planFileSha256,
    batchId,
    attemptDirectory,
  });
  if (validation.artifactSetSha256 !== expectedArtifactSetSha256) {
    fail("attempt artifact set hash drift");
  }
}

async function writeDurable(path: string, content: string): Promise<void> {
  await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

export async function runMarkdownTypeResolution(
  input: RunMarkdownTypeResolutionInput,
): Promise<MarkdownTypeResolutionResult> {
  const rawInput = exactKeys(input, [
    "containmentRoot", "planPath", "planFileSha256", "inputManifestPath",
    "inputManifestFileSha256", "arbitrationDraftPath", "arbitrationDraftFileSha256",
    "outputDirectory", "createdAt",
  ], "operator input");
  const root = absolutePath(rawInput.containmentRoot, "containment root");
  const planPath = absolutePath(rawInput.planPath, "plan");
  const planFileSha256 = hash(rawInput.planFileSha256, "plan file");
  const manifestPath = absolutePath(rawInput.inputManifestPath, "input manifest");
  const manifestFileSha256 = hash(rawInput.inputManifestFileSha256, "input manifest file");
  const arbitrationPath = absolutePath(rawInput.arbitrationDraftPath, "arbitration draft");
  const arbitrationFileSha256 = hash(
    rawInput.arbitrationDraftFileSha256,
    "arbitration draft file",
  );
  const outputDirectory = absolutePath(rawInput.outputDirectory, "output");
  const createdAt = iso(rawInput.createdAt, "resolution");
  const rootInfo = await pathInfo(root);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) fail("containment root input");
  for (const file of [planPath, manifestPath, arbitrationPath]) {
    await assertContainedPath(root, file, "file");
  }
  if (!strictDescendant(root, outputDirectory)) fail("output path containment");
  const outputInfo = await pathInfo(outputDirectory);
  if (outputInfo) fail("output directory already exists; overwrite forbidden");
  const outputParent = dirname(outputDirectory);
  if (outputParent !== root) await assertContainedPath(root, outputParent, "directory");

  const plan = await readPlan(root, planPath, planFileSha256);
  const [manifestBuffer, arbitrationBuffer] = await Promise.all([
    readContainedFile(root, manifestPath),
    readContainedFile(root, arbitrationPath),
  ]);
  if (sha256(manifestBuffer) !== manifestFileSha256) fail("input manifest file hash drift");
  if (sha256(arbitrationBuffer) !== arbitrationFileSha256) {
    fail("arbitration draft file hash drift");
  }
  const manifest = parseInputManifest(parseCanonicalJson(
    manifestBuffer.toString("utf8"),
    "input manifest",
  ));
  const arbitration = parseArbitrationDraft(parseCanonicalJson(
    arbitrationBuffer.toString("utf8"),
    "arbitration draft",
  ));
  if (manifest.planFileSha256 !== planFileSha256 || manifest.planSha256 !== plan.planSha256 ||
      arbitration.planSha256 !== plan.planSha256) fail("input plan hash drift");

  const p2Batches = [...plan.batches].filter((batch) => batch.sequence >= 1 && batch.sequence <= 34)
    .sort((left, right) => left.sequence - right.sequence);
  if (p2Batches.length !== 34 || p2Batches.some((batch, index) => batch.sequence !== index + 1)) {
    fail("P2 plan sequence coverage");
  }
  const quarantineEntries = [...manifest.quarantineAttempts];
  const reviewEntries = [...manifest.reviewAttempts];
  if (quarantineEntries.length !== 7 || reviewEntries.length !== 27 ||
      quarantineEntries.some((entry, index) => entry.sequence !== index + 1) ||
      reviewEntries.some((entry, index) => entry.sequence !== index + 8)) {
    fail("input manifest sequence coverage");
  }
  const allManifestBatches = [...quarantineEntries, ...reviewEntries];
  if (new Set(allManifestBatches.map((entry) => entry.batchId)).size !== 34) {
    fail("input manifest duplicate batch coverage");
  }
  for (const entry of allManifestBatches) {
    const batch = p2Batches.find((candidate) => candidate.sequence === entry.sequence);
    if (!batch || batch.batchId !== entry.batchId ||
        entry.sequence <= 7 && batch.cohort !== "quarantine" ||
        entry.sequence >= 8 && batch.mode !== "type_review") {
      fail("input manifest batch identity coverage");
    }
  }

  const unitById = new Map(plan.units.map((unit) => [unit.unitId, unit] as const));
  const resolutions: UnitTypeResolution[] = [];
  const requiredArbitration = new Map<string, Readonly<{
    unit: MemoryCurationUnit;
    batch: MemoryCurationBatch;
    proposalId: string;
    reviewedArtifactHash: string;
  }>>();
  let acceptedPrimary = 0;

  for (const entry of quarantineEntries) {
    const batch = p2Batches.find((candidate) => candidate.batchId === entry.batchId)!;
    await validateAttempt(
      root,
      planPath,
      planFileSha256,
      batch.batchId,
      entry.attemptDirectory,
      entry.artifactSetSha256,
    );
    const bundle = await readBundle(plan, batch.batchId, entry.attemptDirectory);
    if (bundle.documentProposals.length !== 0 || bundle.relationProposals.length !== 0 ||
        bundle.reviewVerdicts.length !== 0 || bundle.unitDecisions.length !== batch.unitIds.length) {
      fail("quarantine attempt artifact contract");
    }
    for (const decision of bundle.unitDecisions) {
      const unit = unitById.get(decision.unitId);
      if (!unit || decision.disposition !== "exclude" || decision.proposedSemanticType !== null ||
          decision.documentProposalIds.length !== 0 ||
          !decision.reasonCodes.includes("legacy_quarantine")) {
        fail("quarantine unit resolution contract");
      }
      resolutions.push(createResolution(unit, batch, {
        semanticType: null,
        disposition: "quarantine",
        confidence: null,
        conflict: false,
        resolutionBasis: "quarantine",
        proposalId: null,
        reviewedArtifactHash: null,
        reasonCodes: Object.freeze(["legacy_quarantine"]),
      }));
    }
  }

  for (const entry of reviewEntries) {
    const batch = p2Batches.find((candidate) => candidate.batchId === entry.batchId)!;
    for (const path of [
      entry.primaryAttemptDirectory,
      entry.reviewAttemptDirectory,
      entry.reviewDraftPath,
    ]) {
      if (!strictDescendant(root, path)) fail("review input path containment");
    }
    await Promise.all([
      validateAttempt(
        root,
        planPath,
        planFileSha256,
        batch.batchId,
        entry.primaryAttemptDirectory,
        entry.primaryArtifactSetSha256,
      ),
      validateAttempt(
        root,
        planPath,
        planFileSha256,
        batch.batchId,
        entry.reviewAttemptDirectory,
        entry.reviewArtifactSetSha256,
      ),
    ]);
    await assertContainedPath(root, entry.reviewDraftPath, "file");
    const reviewDraftBuffer = await readFile(entry.reviewDraftPath);
    if (sha256(reviewDraftBuffer) !== entry.reviewDraftSha256) fail("review draft hash drift");
    let reviewDraftValue: unknown;
    try {
      reviewDraftValue = JSON.parse(reviewDraftBuffer.toString("utf8"));
    } catch {
      fail("review draft JSON");
    }
    const reviewDraft = parseReviewDraft(reviewDraftValue, batch.batchId);
    const [primary, review] = await Promise.all([
      readBundle(plan, batch.batchId, entry.primaryAttemptDirectory),
      readBundle(plan, batch.batchId, entry.reviewAttemptDirectory),
    ]);
    if (primary.reviewVerdicts.length !== 0 ||
        !canonicalEqual(primary.unitDecisions, review.unitDecisions) ||
        !canonicalEqual(primary.documentProposals, review.documentProposals) ||
        !canonicalEqual(primary.relationProposals, review.relationProposals) ||
        reviewDraft.verdicts.length !== batch.unitIds.length ||
        review.reviewVerdicts.length !== batch.unitIds.length) {
      fail("primary/review attempt coverage drift");
    }
    const primaryDecisionByUnit = new Map(primary.unitDecisions.map((item) => [item.unitId, item]));
    const proposalById = new Map(primary.documentProposals.map((item) => [item.proposalId, item]));
    const materializedVerdictByProposal = new Map(
      review.reviewVerdicts.map((item) => [item.proposalId, item]),
    );
    for (const verdict of reviewDraft.verdicts) {
      const unit = unitById.get(verdict.unitId);
      const decision = primaryDecisionByUnit.get(verdict.unitId);
      const proposal = proposalById.get(verdict.proposalId);
      const materialized = materializedVerdictByProposal.get(verdict.proposalId);
      if (!unit || !decision || !proposal || !materialized ||
          !decision.documentProposalIds.includes(verdict.proposalId) ||
          proposal.unitIds.length !== 1 || proposal.unitIds[0] !== verdict.unitId ||
          proposal.markdownSha256 !== verdict.reviewedArtifactHash ||
          materialized.reviewedArtifactHash !== verdict.reviewedArtifactHash ||
          materialized.verdictId !== expectedVerdictId(
            plan,
            batch.batchId,
            verdict,
            reviewDraft.reviewer,
          ) || materialized.createdAt !== reviewDraft.createdAt ||
          materialized.verdict !== (verdict.verdict === "override" ? "reject" : verdict.verdict) ||
          !canonicalEqual(materialized.reasonCodes, verdict.reasonCodes)) {
        fail("review attempt/draft proposal hash coverage");
      }
      const primaryType = decision.proposedSemanticType;
      if (primaryType === null || proposal.semanticType !== primaryType) {
        fail("primary semantic type coverage");
      }
      const primaryDisposition = candidateDisposition(primary, verdict.unitId);
      const conflict = primaryConflict(primary, verdict.unitId);
      if (verdict.verdict === "accept") {
        if (verdict.proposedSemanticType !== primaryType ||
            verdict.dispositionCandidate !== primaryDisposition || verdict.conflict !== conflict) {
          fail("review accept drifts from primary");
        }
        acceptedPrimary += 1;
        resolutions.push(createResolution(unit, batch, {
          semanticType: primaryType,
          disposition: primaryDisposition,
          confidence: verdict.confidence,
          conflict,
          resolutionBasis: "accepted_primary",
          proposalId: proposal.proposalId,
          reviewedArtifactHash: proposal.markdownSha256,
          reasonCodes: Object.freeze(["accepted_primary", ...verdict.reasonCodes]),
        }));
      } else {
        requiredArbitration.set(verdict.unitId, Object.freeze({
          unit,
          batch,
          proposalId: proposal.proposalId,
          reviewedArtifactHash: proposal.markdownSha256,
        }));
      }
    }
  }

  const arbitrationByUnit = new Map(arbitration.decisions.map((item) => [item.unitId, item]));
  if (arbitrationByUnit.size !== requiredArbitration.size ||
      [...arbitrationByUnit.keys()].some((unitId) => !requiredArbitration.has(unitId)) ||
      [...requiredArbitration.keys()].some((unitId) => !arbitrationByUnit.has(unitId))) {
    fail("arbitration unit coverage unresolved");
  }
  for (const [unitId, expected] of requiredArbitration) {
    const decision = arbitrationByUnit.get(unitId)!;
    if (decision.scopeFingerprint !== expected.unit.scopeFingerprint ||
        !sameBindings(decision.sources, planBindings(expected.unit)) ||
        decision.proposalId !== expected.proposalId ||
        decision.reviewedArtifactHash !== expected.reviewedArtifactHash ||
        decision.disposition === "quarantine") {
      fail("arbitration source scope proposal hash drift or target escalation");
    }
    resolutions.push(createResolution(expected.unit, expected.batch, {
      semanticType: decision.semanticType,
      disposition: decision.disposition,
      confidence: decision.confidence,
      conflict: decision.conflict,
      resolutionBasis: "arbitration",
      proposalId: decision.proposalId,
      reviewedArtifactHash: decision.reviewedArtifactHash,
      reasonCodes: Object.freeze(["arbitrated_resolution", ...decision.reasonCodes]),
    }));
  }

  resolutions.sort((left, right) => left.sequence - right.sequence ||
    left.unitId.localeCompare(right.unitId));
  const quarantineUnits = resolutions.filter((item) => item.resolutionBasis === "quarantine").length;
  const reviewUnits = resolutions.length - quarantineUnits;
  if (resolutions.length !== 186 || quarantineUnits !== 48 || reviewUnits !== 138 ||
      new Set(resolutions.map((item) => item.unitId)).size !== resolutions.length) {
    fail("P2 unit coverage unresolved");
  }
  const sourceRows = resolutions.flatMap((unit) => unit.sources.map((source) => Object.freeze({
    schema: SOURCE_DISPOSITION_SCHEMA,
    sourceRef: source.sourceRef,
    sourceHash: source.sourceHash,
    unitId: unit.unitId,
    batchId: unit.batchId,
    sequence: unit.sequence,
    scopeFingerprint: unit.scopeFingerprint,
    semanticType: unit.semanticType,
    disposition: unit.disposition,
    conflict: unit.conflict,
    resolutionBasis: unit.resolutionBasis,
    proposalId: unit.proposalId,
    reviewedArtifactHash: unit.reviewedArtifactHash,
    candidateOnly: false as const,
  })));
  sourceRows.sort((left, right) => left.sourceRef.localeCompare(right.sourceRef));
  if (sourceRows.length !== 452 ||
      new Set(sourceRows.map((item) => item.sourceRef)).size !== sourceRows.length ||
      new Set(sourceRows.map((item) => bindingKey(item))).size !== sourceRows.length) {
    fail("global source duplicate or coverage unresolved");
  }

  const typeCounts: Record<string, number> = {
    profile: 0,
    task_context: 0,
    rules: 0,
    experience: 0,
    resource: 0,
    quarantine: 0,
  };
  const dispositionCounts = Object.fromEntries([...DISPOSITIONS].sort().map((key) => [key, 0]));
  for (const resolution of resolutions) {
    const typeKey = resolution.semanticType ?? "quarantine";
    typeCounts[typeKey] = (typeCounts[typeKey] ?? 0) + 1;
    dispositionCounts[resolution.disposition] =
      (dispositionCounts[resolution.disposition] ?? 0) + 1;
  }
  const counts = Object.freeze({
    batches: 34,
    quarantineBatches: 7,
    reviewBatches: 27,
    units: 186,
    quarantineUnits: 48,
    reviewUnits: 138,
    sources: 452,
    unresolved: 0,
    acceptedPrimary,
    arbitrated: requiredArbitration.size,
    semanticTypes: Object.freeze(typeCounts),
    dispositions: Object.freeze(dispositionCounts),
  });
  if (acceptedPrimary + requiredArbitration.size !== 138) fail("review resolution coverage");
  const summary = Object.freeze({
    schema: RESOLUTION_SUMMARY_SCHEMA,
    createdAt,
    planSha256: plan.planSha256,
    counts,
    candidateOnly: false,
  });
  const unitText = canonicalJsonl(resolutions);
  const sourceText = canonicalJsonl(sourceRows);
  const summaryText = canonicalJson(summary);
  const outputHashes = Object.freeze({
    unitTypeResolutions: sha256(unitText),
    sourceTypeDispositions: sha256(sourceText),
    resolutionSummary: sha256(summaryText),
  });
  const outputArtifactSetSha256 = sha256([
    `resolution-summary.json\t${outputHashes.resolutionSummary}\n`,
    `source-type-dispositions.jsonl\t${outputHashes.sourceTypeDispositions}\n`,
    `unit-type-resolutions.jsonl\t${outputHashes.unitTypeResolutions}\n`,
  ].join(""));
  const receipt = Object.freeze({
    schema: RESOLUTION_RECEIPT_SCHEMA,
    createdAt,
    inputHashes: Object.freeze({
      planFileSha256,
      planSha256: plan.planSha256,
      inputManifestFileSha256: manifestFileSha256,
      arbitrationDraftFileSha256: arbitrationFileSha256,
      validatedAttemptSetSha256: attemptSetHash(manifest),
    }),
    outputHashes,
    outputArtifactSetSha256,
    counts,
    candidateOnly: false,
    canonicalTargetsSelected: false,
    formalAssetsWritten: false,
    treeArtifactsWritten: false,
    postgresTouched: false,
  });
  const receiptText = canonicalJson(receipt);

  await mkdir(outputDirectory, { mode: 0o700 });
  await writeDurable(resolve(outputDirectory, "unit-type-resolutions.jsonl"), unitText);
  await writeDurable(resolve(outputDirectory, "source-type-dispositions.jsonl"), sourceText);
  await writeDurable(resolve(outputDirectory, "resolution-summary.json"), summaryText);
  await writeDurable(resolve(outputDirectory, "receipt.json"), receiptText);
  return Object.freeze({
    status: "accepted",
    outputDirectory,
    units: 186,
    sources: 452,
    unresolved: 0,
    acceptedPrimary,
    arbitrated: requiredArbitration.size,
    outputHashes,
    receiptSha256: sha256(receiptText),
  });
}

function parseArgs(argv: readonly string[]): RunMarkdownTypeResolutionInput {
  if (argv.length % 2 !== 0) fail("CLI arguments");
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--") || options.has(key)) {
      fail("CLI arguments");
    }
    options.set(key, value);
  }
  const expected = [
    "--containment-root", "--plan", "--plan-file-sha256", "--input-manifest",
    "--input-manifest-file-sha256", "--arbitration-draft",
    "--arbitration-draft-file-sha256", "--output-dir", "--created-at",
  ];
  if (options.size !== expected.length || expected.some((key) => !options.has(key))) {
    fail("CLI arguments");
  }
  return {
    containmentRoot: options.get("--containment-root")!,
    planPath: options.get("--plan")!,
    planFileSha256: options.get("--plan-file-sha256")!,
    inputManifestPath: options.get("--input-manifest")!,
    inputManifestFileSha256: options.get("--input-manifest-file-sha256")!,
    arbitrationDraftPath: options.get("--arbitration-draft")!,
    arbitrationDraftFileSha256: options.get("--arbitration-draft-file-sha256")!,
    outputDirectory: options.get("--output-dir")!,
    createdAt: options.get("--created-at")!,
  };
}

async function main(argv: readonly string[]): Promise<void> {
  try {
    const result = await runMarkdownTypeResolution(parseArgs(argv));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      code: "MARKDOWN_TYPE_RESOLUTION_FAILED",
      message: error instanceof Error ? error.message : "Type resolution failed",
    })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2));
}
