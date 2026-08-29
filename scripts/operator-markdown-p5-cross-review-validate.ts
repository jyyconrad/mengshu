import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { types as nodeUtilTypes } from "node:util";

import {
  parseGovernedAssetProposalPlan,
  type GovernedAssetProposal,
} from "../packages/core/src/db/migrations/governed-asset-proposal.js";
import {
  validateP5PrimaryReview,
  validateP5PrimaryReviewRow,
  type ValidateP5PrimaryReviewInput,
  type ValidatedP5PrimaryReviewRow,
} from "./operator-markdown-p5-primary-review-validate.js";

const CROSS_REVIEW_SCHEMA = "mengshu.p5-proposal-cross-review-draft/v1";
const PRIMARY_REVIEW_SCHEMA = "mengshu.p5-proposal-review-draft/v1";
const SHA256 = /^[0-9a-f]{64}$/;
const CROSS_VERDICTS = new Set(["accept", "override", "needs_review", "quarantine"]);

export interface ValidateP5CrossReviewInput extends ValidateP5PrimaryReviewInput {
  readonly crossReviewPath: string;
  readonly crossReviewFileSha256: string;
}

export interface ValidatedP5CrossReviewRow {
  readonly proposalId: string;
  readonly reviewedDraftHash: string;
  readonly verdict: "accept" | "override" | "needs_review" | "quarantine";
  readonly titleCandidate: string;
  readonly claims: ValidatedP5PrimaryReviewRow["claims"];
  readonly relationCandidates: ValidatedP5PrimaryReviewRow["relationCandidates"];
  readonly confidence: number;
  readonly reasonCodes: readonly string[];
  readonly notes: readonly string[];
  readonly candidateOnly: true;
}

export interface ValidateP5CrossReviewResult {
  readonly primaryReviewer: string;
  readonly proposalCount: number;
  readonly claimCount: number;
  readonly sourceBindingCount: number;
  readonly relationCount: number;
  readonly verdictCounts: Readonly<Record<string, number>>;
  readonly coverage: 1;
  readonly rows: readonly ValidatedP5CrossReviewRow[];
}

type ErrorCode =
  | "P5_CROSS_REVIEW_INVALID_ARGUMENT"
  | "P5_CROSS_REVIEW_PATH_ESCAPE"
  | "P5_CROSS_REVIEW_SYMLINK"
  | "P5_CROSS_REVIEW_INPUT_DRIFT"
  | "P5_CROSS_REVIEW_CONTRACT_INVALID"
  | "P5_CROSS_REVIEW_COVERAGE_INVALID"
  | "P5_CROSS_REVIEW_TITLE_INVALID"
  | "P5_CROSS_REVIEW_FILESYSTEM_ERROR";

export class P5CrossReviewValidationError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
    this.name = "P5CrossReviewValidationError";
  }
}

function fail(code: ErrorCode): never {
  throw new P5CrossReviewValidationError(code);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      nodeUtilTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: unknown, expected: readonly string[]): Record<string, unknown> {
  if (!plainRecord(value)) fail("P5_CROSS_REVIEW_CONTRACT_INVALID");
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    fail("P5_CROSS_REVIEW_CONTRACT_INVALID");
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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
      !strictDescendant(root, path)) fail("P5_CROSS_REVIEW_PATH_ESCAPE");
  if (!SHA256.test(expectedHash)) fail("P5_CROSS_REVIEW_INVALID_ARGUMENT");
  let current = root;
  for (const part of relative(root, path).split(sep)) {
    current = resolve(current, part);
    const info = await lstat(current).catch(() => fail("P5_CROSS_REVIEW_FILESYSTEM_ERROR"));
    if (info.isSymbolicLink()) fail("P5_CROSS_REVIEW_SYMLINK");
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const value = await handle.readFile("utf8");
    if (sha256(value) !== expectedHash) fail("P5_CROSS_REVIEW_INPUT_DRIFT");
    return value;
  } catch (error) {
    if (error instanceof P5CrossReviewValidationError) throw error;
    if (errorCode(error) === "ELOOP") fail("P5_CROSS_REVIEW_SYMLINK");
    fail("P5_CROSS_REVIEW_FILESYSTEM_ERROR");
  } finally {
    await handle?.close().catch(() => undefined);
  }
  return fail("P5_CROSS_REVIEW_FILESYSTEM_ERROR");
}

function parseJsonLines(value: string): unknown[] {
  if (!value.endsWith("\n") || value.trim().length === 0) {
    fail("P5_CROSS_REVIEW_INPUT_DRIFT");
  }
  try {
    return value.trimEnd().split("\n").map((line) => JSON.parse(line) as unknown);
  } catch {
    fail("P5_CROSS_REVIEW_INPUT_DRIFT");
  }
}

export function validateP5CrossReviewRow(
  value: unknown,
  proposal: GovernedAssetProposal,
  batchId: string,
  globalAssets: ReadonlyMap<string, GovernedAssetProposal>,
  reviewedDraftHash: string,
): ValidatedP5CrossReviewRow {
  const row = exactKeys(value, [
    "schema", "proposalId", "reviewedDraftHash", "verdict", "titleCandidate", "claims",
    "relationCandidates", "confidence", "reasonCodes", "notes", "candidateOnly",
  ]);
  if (row.schema !== CROSS_REVIEW_SCHEMA || row.proposalId !== proposal.proposalId ||
      row.reviewedDraftHash !== reviewedDraftHash || !SHA256.test(reviewedDraftHash) ||
      typeof row.verdict !== "string" || !CROSS_VERDICTS.has(row.verdict) ||
      !Array.isArray(row.claims) || !Array.isArray(row.relationCandidates)) {
    fail("P5_CROSS_REVIEW_CONTRACT_INVALID");
  }
  const verdict = row.verdict as ValidatedP5CrossReviewRow["verdict"];
  const publishes = verdict === "accept" || verdict === "override";
  if (publishes && row.claims.length === 0 || verdict === "quarantine" &&
      (row.claims.length > 0 || row.relationCandidates.length > 0)) {
    fail("P5_CROSS_REVIEW_CONTRACT_INVALID");
  }
  const pseudoPrimary = {
    schema: PRIMARY_REVIEW_SCHEMA,
    batchId,
    proposalId: proposal.proposalId,
    assetCandidateId: proposal.assetCandidateId,
    scopeFingerprint: proposal.scopeFingerprint,
    semanticType: proposal.semanticType,
    unitIds: [...proposal.unitIds].sort(),
    verdict: publishes ? row.claims.length > 1 ? "split_claims" : "accept_exact_claims" : verdict,
    titleCandidate: row.titleCandidate,
    claims: row.claims,
    relationCandidates: row.relationCandidates,
    confidence: row.confidence,
    reasonCodes: row.reasonCodes,
    notes: row.notes,
    candidateOnly: row.candidateOnly,
  };
  let parsed;
  try {
    parsed = validateP5PrimaryReviewRow(pseudoPrimary, proposal, batchId, globalAssets);
  } catch {
    fail("P5_CROSS_REVIEW_CONTRACT_INVALID");
  }
  if (parsed.titleWarning || parsed.row.titleCandidate.length > 120) {
    fail("P5_CROSS_REVIEW_TITLE_INVALID");
  }
  const claimKeys = parsed.row.claims.map((claim) => claim.claimKey);
  if (new Set(claimKeys).size !== claimKeys.length) {
    fail("P5_CROSS_REVIEW_CONTRACT_INVALID");
  }
  return Object.freeze({
    proposalId: proposal.proposalId,
    reviewedDraftHash,
    verdict,
    titleCandidate: parsed.row.titleCandidate,
    claims: parsed.row.claims,
    relationCandidates: parsed.row.relationCandidates,
    confidence: parsed.row.confidence,
    reasonCodes: parsed.row.reasonCodes,
    notes: parsed.row.notes,
    candidateOnly: true,
  });
}

export async function validateP5CrossReview(
  input: ValidateP5CrossReviewInput,
): Promise<ValidateP5CrossReviewResult> {
  const [primary, planText, crossReviewText] = await Promise.all([
    validateP5PrimaryReview(input),
    readVerified(input.containmentRoot, input.proposalPlanPath, input.proposalPlanFileSha256),
    readVerified(input.containmentRoot, input.crossReviewPath, input.crossReviewFileSha256),
  ]);
  const plan = parseGovernedAssetProposalPlan(planText);
  const proposals = new Map(plan.proposals.map((proposal) => [proposal.proposalId, proposal] as const));
  const globalAssets = new Map(plan.proposals.map((proposal) =>
    [proposal.assetCandidateId, proposal] as const));
  const primaryRows = new Map(primary.rows.map((row) => [row.proposalId, row] as const));
  const seen = new Set<string>();
  const rows: ValidatedP5CrossReviewRow[] = [];
  for (const raw of parseJsonLines(crossReviewText)) {
    if (!plainRecord(raw) || typeof raw.proposalId !== "string" || seen.has(raw.proposalId)) {
      fail("P5_CROSS_REVIEW_COVERAGE_INVALID");
    }
    const primaryRow = primaryRows.get(raw.proposalId);
    const proposal = proposals.get(raw.proposalId);
    if (!primaryRow || !proposal) fail("P5_CROSS_REVIEW_COVERAGE_INVALID");
    seen.add(raw.proposalId);
    rows.push(validateP5CrossReviewRow(
      raw,
      proposal,
      primaryRow.batchId,
      globalAssets,
      input.reviewFileSha256,
    ));
  }
  if (seen.size !== primaryRows.size || [...primaryRows.keys()].some((id) => !seen.has(id))) {
    fail("P5_CROSS_REVIEW_COVERAGE_INVALID");
  }
  rows.sort((left, right) => left.proposalId.localeCompare(right.proposalId));
  const verdictCounts: Record<string, number> = {
    accept: 0, override: 0, needs_review: 0, quarantine: 0,
  };
  for (const row of rows) verdictCounts[row.verdict] += 1;
  return Object.freeze({
    primaryReviewer: primary.reviewer,
    proposalCount: rows.length,
    claimCount: rows.reduce((sum, row) => sum + row.claims.length, 0),
    sourceBindingCount: rows.reduce((sum, row) => sum + row.claims.reduce(
      (claimSum, claim) => claimSum + claim.sourceBindings.length, 0), 0),
    relationCount: rows.reduce((sum, row) => sum + row.relationCandidates.length, 0),
    verdictCounts: Object.freeze(verdictCounts),
    coverage: 1,
    rows: Object.freeze(rows),
  });
}

const CLI: Readonly<Record<string, keyof ValidateP5CrossReviewInput>> = {
  "--containment-root": "containmentRoot",
  "--proposal-plan": "proposalPlanPath",
  "--proposal-plan-file-sha256": "proposalPlanFileSha256",
  "--assignment": "assignmentPath",
  "--assignment-file-sha256": "assignmentFileSha256",
  "--review": "reviewPath",
  "--review-file-sha256": "reviewFileSha256",
  "--cross-review": "crossReviewPath",
  "--cross-review-file-sha256": "crossReviewFileSha256",
};

function parseCli(argv: readonly string[]): ValidateP5CrossReviewInput {
  if (argv.length !== Object.keys(CLI).length * 2) fail("P5_CROSS_REVIEW_INVALID_ARGUMENT");
  const result: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const field = CLI[argv[index]!];
    const value = argv[index + 1];
    if (!field || !value || Object.prototype.hasOwnProperty.call(result, field)) {
      fail("P5_CROSS_REVIEW_INVALID_ARGUMENT");
    }
    result[field] = value;
  }
  return result as unknown as ValidateP5CrossReviewInput;
}

async function main(): Promise<void> {
  const result = await validateP5CrossReview(parseCli(process.argv.slice(2)));
  const { rows: ignored, ...summary } = result;
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    const code = error instanceof P5CrossReviewValidationError
      ? error.code : "P5_CROSS_REVIEW_FILESYSTEM_ERROR";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
