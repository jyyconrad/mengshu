import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import {
  parseGovernedAssetProposalPlan,
} from "../packages/core/src/db/migrations/governed-asset-proposal.js";

const REVIEW_SCHEMA = "mengshu.p5-cluster-cross-review-draft/v1";
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_REASON = /^[a-z][a-z0-9_]{0,127}$/;
const PRIVATE_PATH = /(?:^|[\s`"'])(?:\/Users\/|\/home\/|[A-Za-z]:\\)/u;
const RELATIONS = new Set([
  "related", "references", "derived_from", "depends_on", "supersedes",
  "superseded_by", "contradicts", "tree_route",
]);

export interface ValidateP5ClusterCrossReviewInput {
  readonly containmentRoot: string;
  readonly proposalPlanPath: string;
  readonly proposalPlanFileSha256: string;
  readonly crossReviewPath: string;
  readonly crossReviewFileSha256: string;
  readonly reviewedDraftFileSha256: string;
}

export interface ValidateP5ClusterCrossReviewResult {
  readonly clusterCount: number;
  readonly unitCount: number;
  readonly sourceCount: number;
  readonly claimCount: number;
  readonly relationCount: number;
  readonly sourceBindingCount: number;
  readonly coverage: 1;
}

type ErrorCode =
  | "P5_CLUSTER_REVIEW_INVALID_ARGUMENT"
  | "P5_CLUSTER_REVIEW_PATH_ESCAPE"
  | "P5_CLUSTER_REVIEW_SYMLINK"
  | "P5_CLUSTER_REVIEW_INPUT_DRIFT"
  | "P5_CLUSTER_REVIEW_CONTRACT_INVALID"
  | "P5_CLUSTER_REVIEW_EVIDENCE_INVALID"
  | "P5_CLUSTER_REVIEW_PUBLIC_CONTENT_INVALID"
  | "P5_CLUSTER_REVIEW_COVERAGE_INVALID"
  | "P5_CLUSTER_REVIEW_FILESYSTEM_ERROR";

export class P5ClusterCrossReviewValidationError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
    this.name = "P5ClusterCrossReviewValidationError";
  }
}

function fail(code: ErrorCode): never {
  throw new P5ClusterCrossReviewValidationError(code);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      nodeUtilTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: unknown, expected: readonly string[]): Record<string, unknown> {
  if (!plainRecord(value)) fail("P5_CLUSTER_REVIEW_CONTRACT_INVALID");
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    fail("P5_CLUSTER_REVIEW_CONTRACT_INVALID");
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

async function readVerified(root: string, path: string, expected: string): Promise<string> {
  if (!isAbsolute(root) || !isAbsolute(path) || resolve(root) !== root || resolve(path) !== path ||
      !strictDescendant(root, path) || !SHA256.test(expected)) {
    fail("P5_CLUSTER_REVIEW_INVALID_ARGUMENT");
  }
  let current = root;
  for (const part of relative(root, path).split(sep)) {
    current = resolve(current, part);
    const info = await lstat(current).catch(() => fail("P5_CLUSTER_REVIEW_FILESYSTEM_ERROR"));
    if (info.isSymbolicLink()) fail("P5_CLUSTER_REVIEW_SYMLINK");
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const value = await handle.readFile("utf8");
    if (sha256(value) !== expected) fail("P5_CLUSTER_REVIEW_INPUT_DRIFT");
    return value;
  } catch (error) {
    if (error instanceof P5ClusterCrossReviewValidationError) throw error;
    if (errorCode(error) === "ELOOP") fail("P5_CLUSTER_REVIEW_SYMLINK");
    fail("P5_CLUSTER_REVIEW_FILESYSTEM_ERROR");
  } finally {
    await handle?.close().catch(() => undefined);
  }
  return fail("P5_CLUSTER_REVIEW_FILESYSTEM_ERROR");
}

function jsonLines(value: string): unknown[] {
  if (!value.endsWith("\n") || value.trim().length === 0) {
    fail("P5_CLUSTER_REVIEW_INPUT_DRIFT");
  }
  try {
    return value.trimEnd().split("\n").map((line) => JSON.parse(line) as unknown);
  } catch {
    fail("P5_CLUSTER_REVIEW_INPUT_DRIFT");
  }
}

function strings(value: unknown, allowEmpty = false): string[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) || !allowEmpty && value.length === 0 ||
      value.some((item) => typeof item !== "string" || item.length === 0)) {
    fail("P5_CLUSTER_REVIEW_CONTRACT_INVALID");
  }
  const result = [...value] as string[];
  if (new Set(result).size !== result.length || result.some((item, index) => index > 0 &&
      result[index - 1]!.localeCompare(item) >= 0)) {
    fail("P5_CLUSTER_REVIEW_CONTRACT_INVALID");
  }
  return result;
}

export async function validateP5ClusterCrossReview(
  input: ValidateP5ClusterCrossReviewInput,
): Promise<ValidateP5ClusterCrossReviewResult> {
  const [planText, reviewText] = await Promise.all([
    readVerified(input.containmentRoot, input.proposalPlanPath, input.proposalPlanFileSha256),
    readVerified(input.containmentRoot, input.crossReviewPath, input.crossReviewFileSha256),
  ]);
  if (!SHA256.test(input.reviewedDraftFileSha256)) {
    fail("P5_CLUSTER_REVIEW_INVALID_ARGUMENT");
  }
  const plan = parseGovernedAssetProposalPlan(planText);
  const clusters = new Map(plan.proposals.filter((proposal) => proposal.governanceClusterId)
    .map((proposal) => [proposal.governanceClusterId!, proposal] as const));
  const seen = new Set<string>();
  let claimCount = 0;
  let relationCount = 0;
  let sourceBindingCount = 0;
  const coveredUnits = new Set<string>();
  const coveredSources = new Set<string>();
  for (const raw of jsonLines(reviewText)) {
    const row = exactKeys(raw, [
      "schema", "clusterId", "reviewedDraftHash", "verdict", "titleCandidate", "claims",
      "relationCandidates", "confidence", "reasonCodes", "notes", "candidateOnly",
    ]);
    const cluster = typeof row.clusterId === "string" ? clusters.get(row.clusterId) : undefined;
    if (row.schema !== REVIEW_SCHEMA || row.reviewedDraftHash !== input.reviewedDraftFileSha256 ||
        row.verdict !== "override" && row.verdict !== "accept" || !cluster ||
        seen.has(row.clusterId as string) || row.candidateOnly !== true ||
        typeof row.titleCandidate !== "string" || row.titleCandidate.length === 0 ||
        row.titleCandidate.length > 120 || row.titleCandidate.endsWith("...") ||
        typeof row.confidence !== "number" || !Number.isFinite(row.confidence) ||
        row.confidence < 0 || row.confidence > 1 || !Array.isArray(row.claims) ||
        row.claims.length === 0 || !Array.isArray(row.relationCandidates)) {
      fail("P5_CLUSTER_REVIEW_CONTRACT_INVALID");
    }
    seen.add(row.clusterId as string);
    const baselineSources = new Map<string, {
      sourceHash: string;
      endByte: number;
      excerptHash: string;
      unitId: string;
    }>();
    for (const claim of cluster.claims) {
      for (const binding of claim.sourceBindings) {
        const unit = cluster.unitIds.find((unitId) => plan.proposals.some((proposal) =>
          proposal.proposalId === cluster.proposalId && proposal.unitIds.includes(unitId)));
        baselineSources.set(binding.sourceRef, {
          sourceHash: binding.sourceHash,
          endByte: binding.endByte,
          excerptHash: binding.excerptHash,
          unitId: unit ?? cluster.unitIds[0]!,
        });
      }
    }
    const claimKeys = new Set<string>();
    const rowClaimKeys: string[] = [];
    for (const rawClaim of row.claims) {
      const claim = exactKeys(rawClaim, [
        "claimKey", "text", "supportingUnitIds", "sourceBindings",
      ]);
      if (typeof claim.claimKey !== "string" || claimKeys.has(claim.claimKey) ||
          typeof claim.text !== "string" || claim.text.length === 0 ||
          PRIVATE_PATH.test(claim.text) || !Array.isArray(claim.sourceBindings) ||
          claim.sourceBindings.length === 0) fail("P5_CLUSTER_REVIEW_PUBLIC_CONTENT_INVALID");
      claimKeys.add(claim.claimKey);
      rowClaimKeys.push(claim.claimKey);
      const supportingUnitIds = strings(claim.supportingUnitIds);
      if (supportingUnitIds.some((unitId) => !cluster.unitIds.includes(unitId))) {
        fail("P5_CLUSTER_REVIEW_EVIDENCE_INVALID");
      }
      supportingUnitIds.forEach((unitId) => coveredUnits.add(unitId));
      for (const rawBinding of claim.sourceBindings) {
        const binding = exactKeys(rawBinding, [
          "sourceRef", "sourceHash", "startByte", "endByte", "excerptHash",
        ]);
        const baseline = typeof binding.sourceRef === "string"
          ? baselineSources.get(binding.sourceRef) : undefined;
        if (!baseline || binding.sourceHash !== baseline.sourceHash || binding.startByte !== 0 ||
            binding.endByte !== baseline.endByte || binding.excerptHash !== baseline.excerptHash) {
          fail("P5_CLUSTER_REVIEW_EVIDENCE_INVALID");
        }
        coveredSources.add(binding.sourceRef as string);
        sourceBindingCount += 1;
      }
      claimCount += 1;
    }
    for (const rawRelation of row.relationCandidates) {
      const relation = exactKeys(rawRelation, [
        "relation", "fromClaimKey", "toClaimKey", "reasonCode",
      ]);
      if (typeof relation.relation !== "string" || !RELATIONS.has(relation.relation) ||
          typeof relation.fromClaimKey !== "string" || !claimKeys.has(relation.fromClaimKey) ||
          typeof relation.toClaimKey !== "string" || !claimKeys.has(relation.toClaimKey) ||
          relation.fromClaimKey === relation.toClaimKey ||
          typeof relation.reasonCode !== "string" || !SAFE_REASON.test(relation.reasonCode)) {
        fail("P5_CLUSTER_REVIEW_CONTRACT_INVALID");
      }
      relationCount += 1;
    }
    const reasonCodes = strings(row.reasonCodes);
    if (reasonCodes.length === 0 || rowClaimKeys.length !== claimKeys.size ||
        typeof row.notes !== "string" || row.notes.length === 0 ||
        PRIVATE_PATH.test(row.titleCandidate)) fail("P5_CLUSTER_REVIEW_CONTRACT_INVALID");
  }
  const expectedUnits = new Set([...clusters.values()].flatMap((proposal) => proposal.unitIds));
  const expectedSources = new Set([...clusters.values()].flatMap((proposal) => proposal.claims)
    .flatMap((claim) => claim.sourceBindings.map((binding) => binding.sourceRef)));
  if (seen.size !== clusters.size || [...clusters.keys()].some((clusterId) => !seen.has(clusterId)) ||
      [...expectedUnits].some((unitId) => !coveredUnits.has(unitId)) ||
      [...expectedSources].some((sourceRef) => !coveredSources.has(sourceRef))) {
    fail("P5_CLUSTER_REVIEW_COVERAGE_INVALID");
  }
  return Object.freeze({
    clusterCount: seen.size,
    unitCount: expectedUnits.size,
    sourceCount: expectedSources.size,
    claimCount,
    relationCount,
    sourceBindingCount,
    coverage: 1,
  });
}

const CLI: Readonly<Record<string, keyof ValidateP5ClusterCrossReviewInput>> = {
  "--containment-root": "containmentRoot",
  "--proposal-plan": "proposalPlanPath",
  "--proposal-plan-file-sha256": "proposalPlanFileSha256",
  "--cross-review": "crossReviewPath",
  "--cross-review-file-sha256": "crossReviewFileSha256",
  "--reviewed-draft-file-sha256": "reviewedDraftFileSha256",
};

function parseCli(argv: readonly string[]): ValidateP5ClusterCrossReviewInput {
  if (argv.length !== Object.keys(CLI).length * 2) fail("P5_CLUSTER_REVIEW_INVALID_ARGUMENT");
  const result: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const field = CLI[argv[index]!];
    const value = argv[index + 1];
    if (!field || !value || Object.prototype.hasOwnProperty.call(result, field)) {
      fail("P5_CLUSTER_REVIEW_INVALID_ARGUMENT");
    }
    result[field] = value;
  }
  return result as unknown as ValidateP5ClusterCrossReviewInput;
}

async function main(): Promise<void> {
  const result = await validateP5ClusterCrossReview(parseCli(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    const code = error instanceof P5ClusterCrossReviewValidationError
      ? error.code : "P5_CLUSTER_REVIEW_FILESYSTEM_ERROR";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
