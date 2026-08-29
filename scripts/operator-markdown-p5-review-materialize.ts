import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import {
  parseGovernedAssetProposalPlan,
  type GovernedAssetProposal,
} from "../packages/core/src/db/migrations/governed-asset-proposal.js";

const ASSIGNMENT_SCHEMA = "mengshu.p5-proposal-review-assignment/v1" as const;
const MANIFEST_SCHEMA = "mengshu.p5-proposal-review-assignment-manifest/v1" as const;
const REVIEWERS = ["agent-a", "agent-b", "agent-c"] as const;
const SHA256 = /^[0-9a-f]{64}$/;

export interface RunP5ReviewMaterializeInput {
  readonly containmentRoot: string;
  readonly proposalPlanPath: string;
  readonly proposalPlanFileSha256: string;
  readonly outputDirectory: string;
  readonly createdAt: string;
}

export interface RunP5ReviewMaterializeResult {
  readonly outputDirectory: string;
  readonly manifestPath: string;
  readonly manifestFileSha256: string;
  readonly proposalCount: number;
  readonly clusterProposalCount: number;
  readonly batchCount: number;
  readonly reviewerCounts: Readonly<Record<string, number>>;
}

type ErrorCode =
  | "P5_REVIEW_MATERIALIZE_INVALID_ARGUMENT"
  | "P5_REVIEW_MATERIALIZE_PATH_ESCAPE"
  | "P5_REVIEW_MATERIALIZE_SYMLINK"
  | "P5_REVIEW_MATERIALIZE_INPUT_DRIFT"
  | "P5_REVIEW_MATERIALIZE_OUTPUT_EXISTS"
  | "P5_REVIEW_MATERIALIZE_FILESYSTEM_ERROR";

export class P5ReviewMaterializeError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
    this.name = "P5ReviewMaterializeError";
  }
}

function fail(code: ErrorCode): never {
  throw new P5ReviewMaterializeError(code);
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

function stableValue(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("P5_REVIEW_MATERIALIZE_INPUT_DRIFT");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (nodeUtilTypes.isProxy(value) || seen.has(value)) {
      fail("P5_REVIEW_MATERIALIZE_INPUT_DRIFT");
    }
    seen.add(value);
    const result = value.map((item) => stableValue(item, seen));
    seen.delete(value);
    return result;
  }
  if (!plainRecord(value) || seen.has(value)) fail("P5_REVIEW_MATERIALIZE_INPUT_DRIFT");
  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item === undefined || typeof item === "function" || typeof item === "symbol" ||
        typeof item === "bigint") fail("P5_REVIEW_MATERIALIZE_INPUT_DRIFT");
    result[key] = stableValue(item, seen);
  }
  seen.delete(value);
  return result;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function domainHash(domain: string, value: unknown): string {
  return createHash("sha256").update(domain).update("\0")
    .update(JSON.stringify(stableValue(value))).digest("hex");
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

async function assertNoSymlinkChain(root: string, target: string, allowMissingLeaf: boolean):
Promise<void> {
  if (!isAbsolute(root) || !isAbsolute(target) || resolve(root) !== root ||
      resolve(target) !== target || !strictDescendant(root, target)) {
    fail("P5_REVIEW_MATERIALIZE_PATH_ESCAPE");
  }
  let current = root;
  const parts = relative(root, target).split(sep);
  for (let index = 0; index < parts.length; index += 1) {
    current = resolve(current, parts[index]!);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (allowMissingLeaf && index === parts.length - 1 && errorCode(error) === "ENOENT") return;
      fail("P5_REVIEW_MATERIALIZE_FILESYSTEM_ERROR");
    }
    if (info.isSymbolicLink()) fail("P5_REVIEW_MATERIALIZE_SYMLINK");
    if (index < parts.length - 1 && !info.isDirectory()) {
      fail("P5_REVIEW_MATERIALIZE_FILESYSTEM_ERROR");
    }
  }
}

async function readVerified(root: string, path: string, expectedHash: string): Promise<string> {
  await assertNoSymlinkChain(root, path, false);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) fail("P5_REVIEW_MATERIALIZE_INPUT_DRIFT");
    const value = await handle.readFile("utf8");
    if (sha256(value) !== expectedHash) fail("P5_REVIEW_MATERIALIZE_INPUT_DRIFT");
    return value;
  } catch (error) {
    if (error instanceof P5ReviewMaterializeError) throw error;
    if (errorCode(error) === "ELOOP") fail("P5_REVIEW_MATERIALIZE_SYMLINK");
    fail("P5_REVIEW_MATERIALIZE_FILESYSTEM_ERROR");
  } finally {
    await handle?.close().catch(() => undefined);
  }
  return fail("P5_REVIEW_MATERIALIZE_FILESYSTEM_ERROR");
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
    if (errorCode(error) === "EEXIST") fail("P5_REVIEW_MATERIALIZE_OUTPUT_EXISTS");
    fail("P5_REVIEW_MATERIALIZE_FILESYSTEM_ERROR");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export interface P5ReviewBatch {
  readonly batchId: string;
  readonly sequence: number;
  readonly scopeFingerprint: string;
  readonly semanticType: GovernedAssetProposal["semanticType"];
  readonly riskLane: "protected" | "standard";
  readonly proposals: readonly GovernedAssetProposal[];
}

export function buildP5ReviewBatches(
  proposals: readonly GovernedAssetProposal[],
): P5ReviewBatch[] {
  const grouped = new Map<string, GovernedAssetProposal[]>();
  for (const proposal of proposals) {
    const key = `${proposal.scopeFingerprint}\0${proposal.semanticType}`;
    const values = grouped.get(key) ?? [];
    values.push(proposal);
    grouped.set(key, values);
  }
  const result: P5ReviewBatch[] = [];
  for (const key of [...grouped.keys()].sort()) {
    const values = grouped.get(key)!.sort((left, right) =>
      left.assetCandidateId.localeCompare(right.assetCandidateId));
    const protectedType = values[0]!.semanticType === "rules" ||
      values[0]!.semanticType === "profile";
    const size = protectedType ? 10 : 25;
    for (let offset = 0; offset < values.length; offset += size) {
      const members = values.slice(offset, offset + size);
      result.push({
        batchId: domainHash("mengshu.p5-proposal-review-batch/v1", {
          scopeFingerprint: members[0]!.scopeFingerprint,
          semanticType: members[0]!.semanticType,
          proposalIds: members.map((proposal) => proposal.proposalId),
        }),
        sequence: result.length + 1,
        scopeFingerprint: members[0]!.scopeFingerprint,
        semanticType: members[0]!.semanticType,
        riskLane: protectedType ? "protected" : "standard",
        proposals: members,
      });
    }
  }
  return result;
}

export async function runP5ReviewMaterialize(
  input: RunP5ReviewMaterializeInput,
): Promise<RunP5ReviewMaterializeResult> {
  if (!input || typeof input !== "object" || !isAbsolute(input.containmentRoot) ||
      resolve(input.containmentRoot) !== input.containmentRoot ||
      !isAbsolute(input.proposalPlanPath) || !isAbsolute(input.outputDirectory) ||
      resolve(input.proposalPlanPath) !== input.proposalPlanPath ||
      resolve(input.outputDirectory) !== input.outputDirectory ||
      !strictDescendant(input.containmentRoot, input.proposalPlanPath) ||
      !strictDescendant(input.containmentRoot, input.outputDirectory) ||
      !SHA256.test(input.proposalPlanFileSha256) || !validIso(input.createdAt)) {
    fail("P5_REVIEW_MATERIALIZE_INVALID_ARGUMENT");
  }
  await assertNoSymlinkChain(input.containmentRoot, input.outputDirectory, true);
  try {
    await mkdir(input.outputDirectory, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) === "EEXIST") fail("P5_REVIEW_MATERIALIZE_OUTPUT_EXISTS");
    fail("P5_REVIEW_MATERIALIZE_FILESYSTEM_ERROR");
  }
  const plan = parseGovernedAssetProposalPlan(await readVerified(
    input.containmentRoot,
    input.proposalPlanPath,
    input.proposalPlanFileSha256,
  ));
  const clusterProposalIds = plan.proposals.filter((proposal) => proposal.governanceClusterId)
    .map((proposal) => proposal.proposalId).sort();
  const reviewBatches = buildP5ReviewBatches(
    plan.proposals.filter((proposal) => !proposal.governanceClusterId),
  );
  const assignments = new Map<string, P5ReviewBatch[]>(REVIEWERS.map((reviewer) => [reviewer, []]));
  const loads = new Map<string, number>(REVIEWERS.map((reviewer) => [reviewer, 0]));
  for (const batch of reviewBatches) {
    const reviewer = [...REVIEWERS].sort((left, right) =>
      loads.get(left)! - loads.get(right)! || left.localeCompare(right))[0]!;
    assignments.get(reviewer)!.push(batch);
    loads.set(reviewer, loads.get(reviewer)! + batch.proposals.length);
  }
  const assignmentBodies = REVIEWERS.map((reviewer) => ({
    reviewer,
    body: {
      schema: ASSIGNMENT_SCHEMA,
      reviewer,
      createdAt: input.createdAt,
      proposalPlanFileSha256: input.proposalPlanFileSha256,
      proposalPlanSemanticSha256: plan.semanticPlanSha256,
      batches: assignments.get(reviewer),
      summary: {
        batchCount: assignments.get(reviewer)!.length,
        proposalCount: loads.get(reviewer),
        claimCount: assignments.get(reviewer)!.flatMap((batch) => batch.proposals)
          .reduce((sum, proposal) => sum + proposal.claims.length, 0),
      },
      guards: {
        privateReviewMaterial: true,
        finalCanonicalTargetSelectionAllowed: false,
        postgresTouched: false,
      },
    },
  }));
  const files: Array<{ reviewer: string; relativePath: string; sha256: string }> = [];
  for (const assignment of assignmentBodies) {
    const relativePath = `${assignment.reviewer}.json`;
    const serialized = canonicalJson(assignment.body);
    await writeExclusive(resolve(input.outputDirectory, relativePath), serialized);
    files.push({ reviewer: assignment.reviewer, relativePath, sha256: sha256(serialized) });
  }
  const manifest = {
    schema: MANIFEST_SCHEMA,
    createdAt: input.createdAt,
    proposalPlanFileSha256: input.proposalPlanFileSha256,
    proposalPlanSemanticSha256: plan.semanticPlanSha256,
    clusterProposalIds,
    files,
    summary: {
      proposalCount: plan.proposals.length,
      assignedProposalCount: [...loads.values()].reduce((sum, count) => sum + count, 0),
      clusterProposalCount: clusterProposalIds.length,
      batchCount: reviewBatches.length,
      reviewerCounts: Object.fromEntries(REVIEWERS.map((reviewer) => [reviewer, loads.get(reviewer)])),
      coverage: 1,
    },
  };
  const manifestText = canonicalJson(manifest);
  const manifestPath = resolve(input.outputDirectory, "manifest.json");
  await writeExclusive(manifestPath, manifestText);
  return Object.freeze({
    outputDirectory: input.outputDirectory,
    manifestPath,
    manifestFileSha256: sha256(manifestText),
    proposalCount: plan.proposals.length,
    clusterProposalCount: clusterProposalIds.length,
    batchCount: reviewBatches.length,
    reviewerCounts: Object.freeze(Object.fromEntries(
      REVIEWERS.map((reviewer) => [reviewer, loads.get(reviewer)!]),
    )),
  });
}

function parseCli(argv: readonly string[]): RunP5ReviewMaterializeInput {
  const flags: Readonly<Record<string, keyof RunP5ReviewMaterializeInput>> = {
    "--containment-root": "containmentRoot",
    "--proposal-plan": "proposalPlanPath",
    "--proposal-plan-file-sha256": "proposalPlanFileSha256",
    "--output-directory": "outputDirectory",
    "--created-at": "createdAt",
  };
  if (argv.length !== Object.keys(flags).length * 2) {
    fail("P5_REVIEW_MATERIALIZE_INVALID_ARGUMENT");
  }
  const result: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const field = flags[argv[index]!];
    const value = argv[index + 1];
    if (!field || !value || Object.prototype.hasOwnProperty.call(result, field)) {
      fail("P5_REVIEW_MATERIALIZE_INVALID_ARGUMENT");
    }
    result[field] = value;
  }
  return result as unknown as RunP5ReviewMaterializeInput;
}

async function main(): Promise<void> {
  const result = await runP5ReviewMaterialize(parseCli(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    const code = error instanceof P5ReviewMaterializeError
      ? error.code : "P5_REVIEW_MATERIALIZE_FILESYSTEM_ERROR";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
