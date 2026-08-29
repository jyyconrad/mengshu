import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import {
  parseGovernedAssetProposalPlan,
  type GovernedAssetProposal,
  type GovernedAssetRelationCandidate,
} from "../packages/core/src/db/migrations/governed-asset-proposal.js";

const REVIEW_SCHEMA = "mengshu.p5-proposal-review-draft/v1";
const ASSIGNMENT_SCHEMA = "mengshu.p5-proposal-review-assignment/v1";
const RELATION_SCHEMA = "mengshu.governed-asset-relation-candidate/v1";
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]{1,1024}$/;
const PRIVATE_PATH = /(?:^|[\s`"'])(?:\/Users\/|\/home\/|[A-Za-z]:\\)/u;
const VERDICTS = new Set([
  "accept_exact_claims", "split_claims", "needs_review", "quarantine",
]);
const RELATIONS = new Set([
  "related", "references", "derived_from", "depends_on", "supersedes",
  "superseded_by", "contradicts", "tree_route",
]);

export interface ValidateP5PrimaryReviewInput {
  readonly containmentRoot: string;
  readonly proposalPlanPath: string;
  readonly proposalPlanFileSha256: string;
  readonly assignmentPath: string;
  readonly assignmentFileSha256: string;
  readonly reviewPath: string;
  readonly reviewFileSha256: string;
}

export interface ValidatedP5PrimaryReviewRow {
  readonly batchId: string;
  readonly proposalId: string;
  readonly assetCandidateId: string;
  readonly scopeFingerprint: string;
  readonly semanticType: string;
  readonly unitIds: readonly string[];
  readonly verdict: "accept_exact_claims" | "split_claims" | "needs_review" | "quarantine";
  readonly titleCandidate: string;
  readonly claims: readonly {
    readonly claimKey: string;
    readonly text: string;
    readonly sourceBindings: readonly {
      readonly sourceRef: string;
      readonly sourceHash: string;
      readonly startByte: number;
      readonly endByte: number;
      readonly excerptHash: string;
    }[];
  }[];
  readonly relationCandidates: readonly GovernedAssetRelationCandidate[];
  readonly confidence: number;
  readonly reasonCodes: readonly string[];
  readonly notes: readonly string[];
  readonly candidateOnly: true;
}

export interface ValidateP5PrimaryReviewResult {
  readonly reviewer: string;
  readonly proposalCount: number;
  readonly claimCount: number;
  readonly sourceBindingCount: number;
  readonly verdictCounts: Readonly<Record<string, number>>;
  readonly titleWarningCount: number;
  readonly coverage: 1;
  readonly rows: readonly ValidatedP5PrimaryReviewRow[];
}

type ErrorCode =
  | "P5_PRIMARY_REVIEW_INVALID_ARGUMENT"
  | "P5_PRIMARY_REVIEW_PATH_ESCAPE"
  | "P5_PRIMARY_REVIEW_SYMLINK"
  | "P5_PRIMARY_REVIEW_INPUT_DRIFT"
  | "P5_PRIMARY_REVIEW_CONTRACT_INVALID"
  | "P5_PRIMARY_REVIEW_COVERAGE_INVALID"
  | "P5_PRIMARY_REVIEW_EVIDENCE_INVALID"
  | "P5_PRIMARY_REVIEW_PUBLIC_CONTENT_INVALID"
  | "P5_PRIMARY_REVIEW_FILESYSTEM_ERROR";

export class P5PrimaryReviewValidationError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
    this.name = "P5PrimaryReviewValidationError";
  }
}

function fail(code: ErrorCode): never {
  throw new P5PrimaryReviewValidationError(code);
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

function exactKeys(value: unknown, expected: readonly string[]): Record<string, unknown> {
  if (!plainRecord(value)) fail("P5_PRIMARY_REVIEW_CONTRACT_INVALID");
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    fail("P5_PRIMARY_REVIEW_CONTRACT_INVALID");
  }
  return value;
}

function strictDescendant(root: string, target: string): boolean {
  const child = relative(root, target);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function readVerified(root: string, path: string, expectedHash: string): Promise<string> {
  if (!isAbsolute(root) || !isAbsolute(path) || resolve(root) !== root || resolve(path) !== path ||
      !strictDescendant(root, path) || !SHA256.test(expectedHash)) {
    fail("P5_PRIMARY_REVIEW_INVALID_ARGUMENT");
  }
  let current = root;
  for (const part of relative(root, path).split(sep)) {
    current = resolve(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch {
      fail("P5_PRIMARY_REVIEW_FILESYSTEM_ERROR");
    }
    if (info.isSymbolicLink()) fail("P5_PRIMARY_REVIEW_SYMLINK");
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const value = await handle.readFile("utf8");
    if (sha256(value) !== expectedHash) fail("P5_PRIMARY_REVIEW_INPUT_DRIFT");
    return value;
  } catch (error) {
    if (error instanceof P5PrimaryReviewValidationError) throw error;
    if (errorCode(error) === "ELOOP") fail("P5_PRIMARY_REVIEW_SYMLINK");
    fail("P5_PRIMARY_REVIEW_FILESYSTEM_ERROR");
  } finally {
    await handle?.close().catch(() => undefined);
  }
  return fail("P5_PRIMARY_REVIEW_FILESYSTEM_ERROR");
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    fail("P5_PRIMARY_REVIEW_INPUT_DRIFT");
  }
}

function parseJsonLines(value: string): unknown[] {
  if (!value.endsWith("\n") || value.trim().length === 0) {
    fail("P5_PRIMARY_REVIEW_INPUT_DRIFT");
  }
  return value.trimEnd().split("\n").map(parseJson);
}

function safeString(value: unknown, maxLength = 4096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength ||
      value !== value.normalize("NFC") || value.includes("\0") || value.includes("\r")) {
    fail("P5_PRIMARY_REVIEW_CONTRACT_INVALID");
  }
  return value;
}

function sortedStrings(value: unknown, allowEmpty = true): string[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) || !allowEmpty && value.length === 0 ||
      value.some((item) => typeof item !== "string" || !SAFE_TEXT.test(item))) {
    fail("P5_PRIMARY_REVIEW_CONTRACT_INVALID");
  }
  const result = [...value] as string[];
  if (new Set(result).size !== result.length || result.some((item, index) => index > 0 &&
      result[index - 1]!.localeCompare(item) >= 0)) {
    fail("P5_PRIMARY_REVIEW_CONTRACT_INVALID");
  }
  return result;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function privateContent(values: readonly string[], refs: readonly string[]): boolean {
  return values.some((value) => PRIVATE_PATH.test(value) ||
    refs.some((ref) => value.includes(ref)));
}

function baselineBindings(proposal: GovernedAssetProposal): ReadonlyMap<string, {
  readonly sourceHash: string;
  readonly sourceText: string;
  readonly maxEndByte: number;
}> {
  const result = new Map<string, {
    sourceHash: string;
    sourceText: string;
    maxEndByte: number;
  }>();
  for (const claim of proposal.claims) {
    for (const binding of claim.sourceBindings) {
      const existing = result.get(binding.sourceRef);
      if (existing && (existing.sourceHash !== binding.sourceHash ||
          existing.sourceText !== claim.text || existing.maxEndByte !== binding.endByte)) {
        fail("P5_PRIMARY_REVIEW_EVIDENCE_INVALID");
      }
      result.set(binding.sourceRef, {
        sourceHash: binding.sourceHash,
        sourceText: claim.text,
        maxEndByte: binding.endByte,
      });
    }
  }
  return result;
}

function parseRelations(
  value: unknown,
  proposal: GovernedAssetProposal,
  globalAssets: ReadonlyMap<string, GovernedAssetProposal>,
): GovernedAssetRelationCandidate[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    fail("P5_PRIMARY_REVIEW_CONTRACT_INVALID");
  }
  return value.map((candidate): GovernedAssetRelationCandidate => {
    const item = exactKeys(candidate, [
      "schema", "relationType", "targetAssetCandidateId", "reasonCode",
    ]);
    const target = typeof item.targetAssetCandidateId === "string"
      ? globalAssets.get(item.targetAssetCandidateId) : undefined;
    if (item.schema !== RELATION_SCHEMA || typeof item.relationType !== "string" ||
        !RELATIONS.has(item.relationType) || !target ||
        target.scopeFingerprint !== proposal.scopeFingerprint ||
        target.assetCandidateId === proposal.assetCandidateId ||
        typeof item.reasonCode !== "string" || !SAFE_TEXT.test(item.reasonCode)) {
      fail("P5_PRIMARY_REVIEW_CONTRACT_INVALID");
    }
    return {
      schema: RELATION_SCHEMA as GovernedAssetRelationCandidate["schema"],
      relationType: item.relationType as GovernedAssetRelationCandidate["relationType"],
      targetAssetCandidateId: item.targetAssetCandidateId as string,
      reasonCode: item.reasonCode,
    };
  });
}

export function validateP5PrimaryReviewRow(
  value: unknown,
  proposal: GovernedAssetProposal,
  batchId: string,
  globalAssets: ReadonlyMap<string, GovernedAssetProposal>,
): { row: ValidatedP5PrimaryReviewRow; titleWarning: boolean } {
  const item = exactKeys(value, [
    "schema", "batchId", "proposalId", "assetCandidateId", "scopeFingerprint",
    "semanticType", "unitIds", "verdict", "titleCandidate", "claims",
    "relationCandidates", "confidence", "reasonCodes", "notes", "candidateOnly",
  ]);
  if (item.schema !== REVIEW_SCHEMA || item.batchId !== batchId ||
      item.proposalId !== proposal.proposalId ||
      item.assetCandidateId !== proposal.assetCandidateId ||
      item.scopeFingerprint !== proposal.scopeFingerprint ||
      item.semanticType !== proposal.semanticType || item.candidateOnly !== true ||
      typeof item.verdict !== "string" || !VERDICTS.has(item.verdict) ||
      typeof item.confidence !== "number" || !Number.isFinite(item.confidence) ||
      item.confidence < 0 || item.confidence > 1 || !Array.isArray(item.claims)) {
    fail("P5_PRIMARY_REVIEW_CONTRACT_INVALID");
  }
  const unitIds = sortedStrings(item.unitIds, false);
  if (!sameStrings(unitIds, [...proposal.unitIds].sort())) {
    fail("P5_PRIMARY_REVIEW_CONTRACT_INVALID");
  }
  const titleCandidate = safeString(item.titleCandidate, 256);
  const reasonCodes = sortedStrings(item.reasonCodes, false);
  const notes = typeof item.notes === "string"
    ? [safeString(item.notes, 4096)]
    : Array.isArray(item.notes)
      ? item.notes.map((note) => safeString(note, 4096))
      : fail("P5_PRIMARY_REVIEW_CONTRACT_INVALID");
  const baseline = baselineBindings(proposal);
  const covered = new Set<string>();
  const claims = item.claims.map((candidate) => {
    const claim = exactKeys(candidate, ["claimKey", "text", "sourceBindings"]);
    const claimKey = safeString(claim.claimKey, 256);
    const claimText = safeString(claim.text, 24_000);
    if (!Array.isArray(claim.sourceBindings) || claim.sourceBindings.length === 0) {
      fail("P5_PRIMARY_REVIEW_EVIDENCE_INVALID");
    }
    const sourceBindings = claim.sourceBindings.map((raw) => {
      const binding = exactKeys(raw, [
        "sourceRef", "sourceHash", "startByte", "endByte", "excerptHash",
      ]);
      if (typeof binding.sourceRef !== "string") {
        fail("P5_PRIMARY_REVIEW_EVIDENCE_INVALID");
      }
      const sourceRef = binding.sourceRef;
      const source = baseline.get(sourceRef);
      if (!source || binding.sourceHash !== source.sourceHash ||
          typeof binding.startByte !== "number" || !Number.isSafeInteger(binding.startByte) ||
          binding.startByte < 0 || typeof binding.endByte !== "number" ||
          !Number.isSafeInteger(binding.endByte) || binding.endByte <= binding.startByte ||
          binding.endByte > source.maxEndByte || typeof binding.excerptHash !== "string" ||
          !SHA256.test(binding.excerptHash)) fail("P5_PRIMARY_REVIEW_EVIDENCE_INVALID");
      const bytes = Buffer.from(source.sourceText, "utf8")
        .subarray(binding.startByte, binding.endByte);
      const excerpt = bytes.toString("utf8");
      if (Buffer.byteLength(excerpt, "utf8") !== bytes.length || excerpt !== claimText ||
          sha256(bytes) !== binding.excerptHash) fail("P5_PRIMARY_REVIEW_EVIDENCE_INVALID");
      covered.add(sourceRef);
      return {
        sourceRef,
        sourceHash: binding.sourceHash as string,
        startByte: binding.startByte,
        endByte: binding.endByte,
        excerptHash: binding.excerptHash,
      };
    }).sort((left, right) => left.sourceRef.localeCompare(right.sourceRef));
    if (new Set(sourceBindings.map((binding) => binding.sourceRef)).size !==
        sourceBindings.length) fail("P5_PRIMARY_REVIEW_EVIDENCE_INVALID");
    return { claimKey, text: claimText, sourceBindings };
  });
  const verdict = item.verdict as ValidatedP5PrimaryReviewRow["verdict"];
  if ((verdict === "accept_exact_claims" || verdict === "split_claims") &&
      (claims.length === 0 || [...baseline.keys()].some((sourceRef) => !covered.has(sourceRef))) ||
      verdict === "quarantine" && claims.length > 0) {
    fail("P5_PRIMARY_REVIEW_EVIDENCE_INVALID");
  }
  const publicValues = [titleCandidate, ...claims.map((claim) => claim.text)];
  if (privateContent(publicValues, [...baseline.keys()])) {
    fail("P5_PRIMARY_REVIEW_PUBLIC_CONTENT_INVALID");
  }
  const relationCandidates = parseRelations(item.relationCandidates, proposal, globalAssets);
  return {
    row: {
      batchId,
      proposalId: proposal.proposalId,
      assetCandidateId: proposal.assetCandidateId,
      scopeFingerprint: proposal.scopeFingerprint,
      semanticType: proposal.semanticType,
      unitIds,
      verdict,
      titleCandidate,
      claims,
      relationCandidates,
      confidence: item.confidence,
      reasonCodes,
      notes,
      candidateOnly: true,
    },
    titleWarning: titleCandidate.endsWith("...") || titleCandidate.length > 120,
  };
}

export async function validateP5PrimaryReview(
  input: ValidateP5PrimaryReviewInput,
): Promise<ValidateP5PrimaryReviewResult> {
  const [planText, assignmentText, reviewText] = await Promise.all([
    readVerified(input.containmentRoot, input.proposalPlanPath, input.proposalPlanFileSha256),
    readVerified(input.containmentRoot, input.assignmentPath, input.assignmentFileSha256),
    readVerified(input.containmentRoot, input.reviewPath, input.reviewFileSha256),
  ]);
  const plan = parseGovernedAssetProposalPlan(planText);
  const globalAssets = new Map(plan.proposals.map((proposal) =>
    [proposal.assetCandidateId, proposal] as const));
  const assignment = exactKeys(parseJson(assignmentText), [
    "schema", "reviewer", "createdAt", "proposalPlanFileSha256",
    "proposalPlanSemanticSha256", "batches", "summary", "guards",
  ]);
  if (assignment.schema !== ASSIGNMENT_SCHEMA ||
      assignment.proposalPlanFileSha256 !== input.proposalPlanFileSha256 ||
      assignment.proposalPlanSemanticSha256 !== plan.semanticPlanSha256 ||
      typeof assignment.reviewer !== "string" || !Array.isArray(assignment.batches)) {
    fail("P5_PRIMARY_REVIEW_INPUT_DRIFT");
  }
  const expected = new Map<string, { proposal: GovernedAssetProposal; batchId: string }>();
  for (const rawBatch of assignment.batches) {
    if (!plainRecord(rawBatch) || typeof rawBatch.batchId !== "string" ||
        !Array.isArray(rawBatch.proposals)) fail("P5_PRIMARY_REVIEW_CONTRACT_INVALID");
    for (const rawProposal of rawBatch.proposals) {
      if (!plainRecord(rawProposal) || typeof rawProposal.proposalId !== "string") {
        fail("P5_PRIMARY_REVIEW_CONTRACT_INVALID");
      }
      const proposal = plan.proposals.find((candidate) =>
        candidate.proposalId === rawProposal.proposalId);
      if (!proposal || JSON.stringify(rawProposal) !== JSON.stringify(proposal) ||
          expected.has(proposal.proposalId)) fail("P5_PRIMARY_REVIEW_INPUT_DRIFT");
      expected.set(proposal.proposalId, { proposal, batchId: rawBatch.batchId });
    }
  }
  const seen = new Set<string>();
  const rows: ValidatedP5PrimaryReviewRow[] = [];
  let titleWarningCount = 0;
  for (const raw of parseJsonLines(reviewText)) {
    if (!plainRecord(raw) || typeof raw.proposalId !== "string" || seen.has(raw.proposalId)) {
      fail("P5_PRIMARY_REVIEW_COVERAGE_INVALID");
    }
    const assigned = expected.get(raw.proposalId);
    if (!assigned) fail("P5_PRIMARY_REVIEW_COVERAGE_INVALID");
    seen.add(raw.proposalId);
    const parsed = validateP5PrimaryReviewRow(
      raw,
      assigned.proposal,
      assigned.batchId,
      globalAssets,
    );
    rows.push(parsed.row);
    if (parsed.titleWarning) titleWarningCount += 1;
  }
  if (seen.size !== expected.size || [...expected.keys()].some((proposalId) => !seen.has(proposalId))) {
    fail("P5_PRIMARY_REVIEW_COVERAGE_INVALID");
  }
  rows.sort((left, right) => left.proposalId.localeCompare(right.proposalId));
  const verdictCounts: Record<string, number> = {
    accept_exact_claims: 0, split_claims: 0, needs_review: 0, quarantine: 0,
  };
  for (const row of rows) verdictCounts[row.verdict] += 1;
  return Object.freeze({
    reviewer: assignment.reviewer,
    proposalCount: rows.length,
    claimCount: rows.reduce((sum, row) => sum + row.claims.length, 0),
    sourceBindingCount: rows.reduce((sum, row) => sum +
      row.claims.reduce((claimSum, claim) => claimSum + claim.sourceBindings.length, 0), 0),
    verdictCounts: Object.freeze(verdictCounts),
    titleWarningCount,
    coverage: 1,
    rows: Object.freeze(rows),
  });
}

const CLI: Readonly<Record<string, keyof ValidateP5PrimaryReviewInput>> = {
  "--containment-root": "containmentRoot",
  "--proposal-plan": "proposalPlanPath",
  "--proposal-plan-file-sha256": "proposalPlanFileSha256",
  "--assignment": "assignmentPath",
  "--assignment-file-sha256": "assignmentFileSha256",
  "--review": "reviewPath",
  "--review-file-sha256": "reviewFileSha256",
};

function parseCli(argv: readonly string[]): ValidateP5PrimaryReviewInput {
  if (argv.length !== Object.keys(CLI).length * 2) fail("P5_PRIMARY_REVIEW_INVALID_ARGUMENT");
  const result: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const field = CLI[argv[index]!];
    const value = argv[index + 1];
    if (!field || !value || Object.prototype.hasOwnProperty.call(result, field)) {
      fail("P5_PRIMARY_REVIEW_INVALID_ARGUMENT");
    }
    result[field] = value;
  }
  return result as unknown as ValidateP5PrimaryReviewInput;
}

async function main(): Promise<void> {
  const result = await validateP5PrimaryReview(parseCli(process.argv.slice(2)));
  const { rows: ignored, ...summary } = result;
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    const code = error instanceof P5PrimaryReviewValidationError
      ? error.code : "P5_PRIMARY_REVIEW_FILESYSTEM_ERROR";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
