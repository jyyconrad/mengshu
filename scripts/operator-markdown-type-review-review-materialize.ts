import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { types as nodeUtilTypes } from "node:util";

import type { MemoryCurationBatchPlan } from "../packages/core/src/db/migrations/markdown-curation-batch-planner.js";
import {
  CURATION_ARTIFACT_BUNDLE_SCHEMA,
  CURATION_BATCH_RECEIPT_SCHEMA,
  CURATION_REVIEW_VERDICT_SCHEMA,
  computeCurationArtifactListHash,
  validateCurationArtifactBundle,
  type CurationArtifactBundle,
  type CurationReviewVerdict,
} from "../packages/core/src/documents/curation-artifacts.js";
import type { MemorySemanticType } from "../packages/core/src/domain/types.js";
import { runMarkdownCurationBatchValidation } from "./operator-markdown-curation-batch-validate.js";

const REVIEW_DRAFT_SCHEMA = "mengshu.type-review-review-draft/v1" as const;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,511}$/;
const SAFE_REASON = /^[a-z][a-z0-9_]{0,127}$/;
const SEMANTIC_TYPES = new Set<MemorySemanticType>([
  "profile", "task_context", "rules", "experience", "resource",
]);
const DISPOSITION_CANDIDATES = new Set([
  "canonical_keep", "merge_exact", "merge_semantic", "supersede", "archive_stale",
  "lookup_only", "quarantine", "distinct_keep",
]);

export interface TypeReviewVerdictDraft {
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

export interface TypeReviewReviewDraft {
  readonly schema: typeof REVIEW_DRAFT_SCHEMA;
  readonly batchId: string;
  readonly reviewer: string;
  readonly createdAt: string;
  readonly candidateOnly: true;
  readonly verdicts: readonly TypeReviewVerdictDraft[];
}

export interface RunTypeReviewReviewMaterializeInput {
  readonly containmentRoot: string;
  readonly planPath: string;
  readonly planFileSha256: string;
  readonly batchId: string;
  readonly primaryAttemptDirectory: string;
  readonly reviewDraftPath: string;
  readonly outputDirectory: string;
  readonly createdAt: string;
}

export interface TypeReviewReviewMaterializeResult {
  readonly status: "accepted";
  readonly batchId: string;
  readonly outputDirectory: string;
  readonly units: number;
  readonly sources: number;
  readonly accepted: number;
  readonly overridden: number;
  readonly needsReview: number;
  readonly artifactSetSha256: string;
}

function fail(message: string): never {
  throw new Error(`TYPE_REVIEW_REVIEW_MATERIALIZE_INVALID: ${message}`);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: unknown, expected: readonly string[], label: string): Record<string, unknown> {
  if (!plainRecord(value)) fail(`${label} shape`);
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    fail(`${label} keys`);
  }
  return value;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    if (!plainRecord(value)) fail("non-plain value");
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stable(item)]));
  }
  if (typeof value === "number" && !Number.isFinite(value)) fail("non-finite number");
  return value;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}

function canonicalJsonl(values: readonly unknown[]): string {
  return values.length === 0
    ? ""
    : `${values.map((value) => JSON.stringify(stable(value))).join("\n")}\n`;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function strictDescendant(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function absolute(value: unknown, label: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) fail(`${label} path`);
  return value;
}

async function regularFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function directory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

function iso(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value) fail(`${label} timestamp`);
  return value;
}

function parseJsonl(text: string): readonly unknown[] {
  if (text === "") return Object.freeze([]);
  if (!text.endsWith("\n") || text.includes("\r")) fail("JSONL encoding");
  try {
    return Object.freeze(text.slice(0, -1).split("\n").map((line) => JSON.parse(line)));
  } catch {
    fail("JSONL parse");
  }
}

function parseReviewDraft(value: unknown, batchId: string): TypeReviewReviewDraft {
  const draft = exactKeys(value, [
    "schema", "batchId", "reviewer", "createdAt", "candidateOnly", "verdicts",
  ], "review draft");
  if (draft.schema !== REVIEW_DRAFT_SCHEMA || draft.batchId !== batchId ||
      draft.candidateOnly !== true || typeof draft.reviewer !== "string" ||
      !SAFE_ID.test(draft.reviewer) || !Array.isArray(draft.verdicts) ||
      nodeUtilTypes.isProxy(draft.verdicts)) fail("review draft identity");
  const verdicts = draft.verdicts.map((raw, index): TypeReviewVerdictDraft => {
    const item = exactKeys(raw, [
      "unitId", "proposalId", "reviewedArtifactHash", "verdict", "proposedSemanticType",
      "dispositionCandidate", "confidence", "conflict", "reasonCodes", "notes",
    ], `review verdict[${index}]`);
    if (typeof item.unitId !== "string" || !SAFE_ID.test(item.unitId) ||
        typeof item.proposalId !== "string" || !SAFE_ID.test(item.proposalId) ||
        typeof item.reviewedArtifactHash !== "string" || !SHA256.test(item.reviewedArtifactHash) ||
        !["accept", "override", "needs_review"].includes(String(item.verdict)) ||
        typeof item.proposedSemanticType !== "string" ||
        !SEMANTIC_TYPES.has(item.proposedSemanticType as MemorySemanticType) ||
        typeof item.dispositionCandidate !== "string" ||
        !DISPOSITION_CANDIDATES.has(item.dispositionCandidate) ||
        typeof item.confidence !== "number" || !Number.isFinite(item.confidence) ||
        item.confidence < 0 || item.confidence > 1 || typeof item.conflict !== "boolean" ||
        !Array.isArray(item.reasonCodes) || !Array.isArray(item.notes)) fail("review verdict value");
    const reasonCodes = item.reasonCodes.map((reason) => {
      if (typeof reason !== "string" || !SAFE_REASON.test(reason)) fail("review reason code");
      return reason;
    });
    const notes = item.notes.map((note) => {
      if (typeof note !== "string" || note.trim() !== note || note.length === 0 ||
          note.length > 2_000 || /[\p{Cc}\r\n]/u.test(note)) fail("review note");
      return note;
    });
    if (reasonCodes.length === 0 || notes.length === 0 ||
        new Set(reasonCodes).size !== reasonCodes.length) fail("review evidence");
    return Object.freeze({
      unitId: item.unitId,
      proposalId: item.proposalId,
      reviewedArtifactHash: item.reviewedArtifactHash,
      verdict: item.verdict as TypeReviewVerdictDraft["verdict"],
      proposedSemanticType: item.proposedSemanticType as MemorySemanticType,
      dispositionCandidate: item.dispositionCandidate,
      confidence: item.confidence,
      conflict: item.conflict,
      reasonCodes: Object.freeze(reasonCodes),
      notes: Object.freeze(notes),
    });
  });
  if (new Set(verdicts.map((item) => item.unitId)).size !== verdicts.length ||
      new Set(verdicts.map((item) => item.proposalId)).size !== verdicts.length) {
    fail("review verdict duplicate coverage");
  }
  return Object.freeze({
    schema: REVIEW_DRAFT_SCHEMA,
    batchId,
    reviewer: draft.reviewer,
    createdAt: iso(draft.createdAt, "review draft"),
    candidateOnly: true,
    verdicts: Object.freeze(verdicts),
  });
}

async function primaryBundle(
  plan: MemoryCurationBatchPlan,
  batchId: string,
  directoryPath: string,
): Promise<CurationArtifactBundle> {
  const [receipt, unitDecisions, documentProposals, relationProposals, reviewVerdicts] =
    await Promise.all([
      readFile(resolve(directoryPath, "batch-receipt.json"), "utf8").then(JSON.parse),
      readFile(resolve(directoryPath, "unit-decisions.jsonl"), "utf8").then(parseJsonl),
      readFile(resolve(directoryPath, "document-proposals/manifest.jsonl"), "utf8").then(parseJsonl),
      readFile(resolve(directoryPath, "relation-proposals.jsonl"), "utf8").then(parseJsonl),
      readFile(resolve(directoryPath, "review-verdicts.jsonl"), "utf8").then(parseJsonl),
    ]);
  return validateCurationArtifactBundle({
    schema: CURATION_ARTIFACT_BUNDLE_SCHEMA,
    receipt,
    unitDecisions,
    documentProposals,
    relationProposals,
    reviewVerdicts,
  }, { plan, batchId });
}

function candidateDisposition(decision: CurationArtifactBundle["unitDecisions"][number]): string {
  const prefix = "candidate_disposition_";
  const code = decision.reasonCodes.find((reason) => reason.startsWith(prefix));
  if (!code) fail("primary candidate disposition missing");
  const value = code.slice(prefix.length);
  if (!DISPOSITION_CANDIDATES.has(value)) fail("primary candidate disposition invalid");
  return value;
}

async function writeDurable(path: string, content: string): Promise<void> {
  await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

export async function runTypeReviewReviewMaterialize(
  input: RunTypeReviewReviewMaterializeInput,
): Promise<TypeReviewReviewMaterializeResult> {
  if (!plainRecord(input) || !SHA256.test(input.planFileSha256) || !SAFE_ID.test(input.batchId)) {
    fail("input shape");
  }
  const root = absolute(input.containmentRoot, "containment root");
  const planPath = absolute(input.planPath, "plan");
  const primaryDirectory = absolute(input.primaryAttemptDirectory, "primary attempt");
  const reviewDraftPath = absolute(input.reviewDraftPath, "review draft");
  const outputDirectory = absolute(input.outputDirectory, "output");
  const createdAt = iso(input.createdAt, "materialize");
  if (![planPath, primaryDirectory, reviewDraftPath, outputDirectory].every((path) =>
    strictDescendant(root, path)) || !await directory(root) || !await regularFile(planPath) ||
      !await directory(primaryDirectory) || !await regularFile(reviewDraftPath) ||
      !await directory(dirname(outputDirectory))) fail("path containment or input");
  await runMarkdownCurationBatchValidation({
    containmentRoot: root,
    planPath,
    planFileSha256: input.planFileSha256,
    batchId: input.batchId,
    attemptDirectory: primaryDirectory,
  });
  const planText = await readFile(planPath, "utf8");
  if (sha256(planText) !== input.planFileSha256) fail("plan drift");
  const plan = JSON.parse(planText) as MemoryCurationBatchPlan;
  const primary = await primaryBundle(plan, input.batchId, primaryDirectory);
  if (primary.reviewVerdicts.length !== 0) fail("primary attempt already reviewed");
  const review = parseReviewDraft(JSON.parse(await readFile(reviewDraftPath, "utf8")), input.batchId);
  const decisionByUnit = new Map(primary.unitDecisions.map((decision) => [decision.unitId, decision]));
  const proposalById = new Map(primary.documentProposals.map((proposal) => [proposal.proposalId, proposal]));
  if (review.verdicts.length !== primary.unitDecisions.length) fail("review unit coverage");
  for (const verdict of review.verdicts) {
    const decision = decisionByUnit.get(verdict.unitId);
    const proposal = proposalById.get(verdict.proposalId);
    if (!decision || !proposal || !decision.documentProposalIds.includes(verdict.proposalId) ||
        verdict.reviewedArtifactHash !== proposal.markdownSha256) fail("review proposal coverage/hash");
    const primaryConflict = decision.reasonCodes.includes("content_conflict_observed");
    if (verdict.verdict === "accept" &&
        (verdict.proposedSemanticType !== decision.proposedSemanticType ||
          verdict.dispositionCandidate !== candidateDisposition(decision) ||
          verdict.conflict !== primaryConflict)) fail("accepted review drifts from primary");
  }
  const reviewVerdicts: readonly CurationReviewVerdict[] = Object.freeze(review.verdicts.map((item) =>
    Object.freeze({
      schema: CURATION_REVIEW_VERDICT_SCHEMA,
      verdictId: `verdict_${sha256([
        "mengshu.type-review-verdict/v1", plan.planSha256, input.batchId, item.unitId,
        item.proposalId, item.reviewedArtifactHash, review.reviewer,
      ].join("\0")).slice(0, 32)}`,
      proposalId: item.proposalId,
      reviewedArtifactHash: item.reviewedArtifactHash,
      reviewer: "agent" as const,
      verdict: item.verdict === "override" ? "reject" as const : item.verdict,
      reasonCodes: Object.freeze(item.reasonCodes),
      createdAt: review.createdAt,
      candidateOnly: true as const,
    })));
  const receipt = Object.freeze({
    schema: CURATION_BATCH_RECEIPT_SCHEMA,
    batchId: input.batchId,
    planSha256: plan.planSha256,
    sourceSnapshotSha256: plan.sourceSnapshotSha256,
    sourceManifestSha256: plan.sourceManifestSha256,
    preprocessedManifestSha256: plan.preprocessedManifestSha256,
    inventorySha256: plan.inventorySha256,
    unitCount: primary.unitDecisions.length,
    sourceCount: primary.receipt.sourceCount,
    sectionHashes: Object.freeze({
      unitDecisions: computeCurationArtifactListHash("unit-decisions", primary.unitDecisions),
      documentProposals: computeCurationArtifactListHash("document-proposals", primary.documentProposals),
      relationProposals: computeCurationArtifactListHash("relation-proposals", primary.relationProposals),
      reviewVerdicts: computeCurationArtifactListHash("review-verdicts", reviewVerdicts),
    }),
    candidateOnly: true,
    canonicalTargetsSelected: false,
    formalAssetsWritten: false,
    treeArtifactsWritten: false,
    postgresTouched: false,
    createdAt,
  });
  const bundle = validateCurationArtifactBundle({
    schema: CURATION_ARTIFACT_BUNDLE_SCHEMA,
    receipt,
    unitDecisions: primary.unitDecisions,
    documentProposals: primary.documentProposals,
    relationProposals: primary.relationProposals,
    reviewVerdicts,
  }, { plan, batchId: input.batchId });
  await mkdir(outputDirectory, { mode: 0o700 });
  const proposalDirectory = resolve(outputDirectory, "document-proposals");
  await mkdir(proposalDirectory, { mode: 0o700 });
  await writeDurable(resolve(outputDirectory, "batch-receipt.json"), canonicalJson(bundle.receipt));
  await writeDurable(resolve(outputDirectory, "unit-decisions.jsonl"), canonicalJsonl(bundle.unitDecisions));
  await writeDurable(resolve(proposalDirectory, "manifest.jsonl"), canonicalJsonl(bundle.documentProposals));
  for (const proposal of bundle.documentProposals) {
    await writeDurable(resolve(outputDirectory, proposal.relativePath),
      await readFile(resolve(primaryDirectory, proposal.relativePath), "utf8"));
  }
  await writeDurable(resolve(outputDirectory, "relation-proposals.jsonl"),
    canonicalJsonl(bundle.relationProposals));
  await writeDurable(resolve(outputDirectory, "review-verdicts.jsonl"), canonicalJsonl(reviewVerdicts));
  const validation = await runMarkdownCurationBatchValidation({
    containmentRoot: root,
    planPath,
    planFileSha256: input.planFileSha256,
    batchId: input.batchId,
    attemptDirectory: outputDirectory,
  });
  return Object.freeze({
    status: "accepted",
    batchId: input.batchId,
    outputDirectory,
    units: validation.counts.units,
    sources: validation.counts.sources,
    accepted: review.verdicts.filter((item) => item.verdict === "accept").length,
    overridden: review.verdicts.filter((item) => item.verdict === "override").length,
    needsReview: review.verdicts.filter((item) => item.verdict === "needs_review").length,
    artifactSetSha256: validation.artifactSetSha256,
  });
}

function args(argv: readonly string[]): RunTypeReviewReviewMaterializeInput {
  if (argv.length % 2 !== 0) fail("CLI arguments");
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || options.has(key)) fail("CLI arguments");
    options.set(key, value);
  }
  const expected = [
    "--containment-root", "--plan", "--plan-file-sha256", "--batch-id",
    "--primary-attempt", "--review-draft", "--output-dir", "--created-at",
  ];
  if (options.size !== expected.length || expected.some((key) => !options.has(key))) {
    fail("CLI arguments");
  }
  return {
    containmentRoot: options.get("--containment-root")!,
    planPath: options.get("--plan")!,
    planFileSha256: options.get("--plan-file-sha256")!,
    batchId: options.get("--batch-id")!,
    primaryAttemptDirectory: options.get("--primary-attempt")!,
    reviewDraftPath: options.get("--review-draft")!,
    outputDirectory: options.get("--output-dir")!,
    createdAt: options.get("--created-at")!,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTypeReviewReviewMaterialize(args(process.argv.slice(2))).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      code: "TYPE_REVIEW_REVIEW_MATERIALIZE_FAILED",
      message: error instanceof Error ? error.message : "Review materialization failed",
    })}\n`);
    process.exitCode = 1;
  });
}
