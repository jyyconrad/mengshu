import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import {
  parseGovernedAssetProposalPlan,
  planGovernedAssetProposals,
  serializeGovernedAssetProposalPlan,
  type GovernedAssetResourceIdentityBinding,
  type GovernedAssetUnitGovernanceOverride,
} from "../packages/core/src/db/migrations/governed-asset-proposal.js";
import { parseTypedMemoryBatchPlan } from
  "../packages/core/src/db/migrations/typed-memory-batch-plan.js";
import { parseNativeRecordMarkdown } from
  "../packages/core/src/db/migrations/markdown-workset.js";
import { loadMarkdownWorksetBundle } from "./operator-markdown-workset.js";

export interface RunGovernedAssetProposalInput {
  readonly containmentRoot: string;
  readonly typedMemoryBatchPlanPath: string;
  readonly typedMemoryBatchPlanFileSha256: string;
  readonly sourceManifestPath: string;
  readonly sourceManifestFileSha256: string;
  readonly knowledgeResourceBindingsPath: string;
  readonly knowledgeResourceBindingsFileSha256: string;
  readonly resourceLinkageReviewPath: string;
  readonly resourceLinkageReviewFileSha256: string;
  readonly securityDecisionsPath: string;
  readonly securityDecisionsFileSha256: string;
  readonly outputPath: string;
  readonly createdAt: string;
}

export interface RunGovernedAssetProposalResult {
  readonly outputPath: string;
  readonly outputFileSha256: string;
  readonly semanticPlanSha256: string;
  readonly eligibleUnits: number;
  readonly proposals: number;
  readonly claims: number;
  readonly quarantinedUnits: number;
  readonly deferredUnits: number;
  readonly sourceCoverage: 1;
  readonly unitCoverage: 1;
}

type ErrorCode =
  | "GOVERNED_ASSET_PROPOSAL_OPERATOR_INVALID_ARGUMENT"
  | "GOVERNED_ASSET_PROPOSAL_OPERATOR_PATH_ESCAPE"
  | "GOVERNED_ASSET_PROPOSAL_OPERATOR_SYMLINK"
  | "GOVERNED_ASSET_PROPOSAL_OPERATOR_INPUT_DRIFT"
  | "GOVERNED_ASSET_PROPOSAL_OPERATOR_RESOURCE_REVIEW_INVALID"
  | "GOVERNED_ASSET_PROPOSAL_OPERATOR_SECURITY_DECISION_INVALID"
  | "GOVERNED_ASSET_PROPOSAL_OPERATOR_OUTPUT_EXISTS"
  | "GOVERNED_ASSET_PROPOSAL_OPERATOR_PLANNER_REJECTED"
  | "GOVERNED_ASSET_PROPOSAL_OPERATOR_FILESYSTEM_ERROR";

export class GovernedAssetProposalOperatorError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
    this.name = "GovernedAssetProposalOperatorError";
  }
}

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_REASON = /^[a-z][a-z0-9_]{0,127}$/;
const SECURITY_SCHEMA = "mengshu.p5-security-unit-decisions/v1";
const RESOURCE_REVIEW_SCHEMA = "mengshu.resource-linkage-review-draft/v1";

function fail(code: ErrorCode): never {
  throw new GovernedAssetProposalOperatorError(code);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableValue(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_INPUT_DRIFT");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (nodeUtilTypes.isProxy(value) || seen.has(value)) {
      fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_INPUT_DRIFT");
    }
    seen.add(value);
    const result = value.map((item) => stableValue(item, seen));
    seen.delete(value);
    return result;
  }
  if (!plainRecord(value) || seen.has(value)) {
    fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_INPUT_DRIFT");
  }
  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item === undefined || typeof item === "function" || typeof item === "symbol" ||
        typeof item === "bigint") fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_INPUT_DRIFT");
    result[key] = stableValue(item, seen);
  }
  seen.delete(value);
  return result;
}

function domainHash(domain: string, value: unknown): string {
  return createHash("sha256").update(domain).update("\0")
    .update(JSON.stringify(stableValue(value))).digest("hex");
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      nodeUtilTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: unknown, expected: readonly string[]): Record<string, unknown> {
  if (!plainRecord(value)) fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_INPUT_DRIFT");
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_INPUT_DRIFT");
  }
  return value;
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

async function assertNoSymlinkChain(root: string, target: string): Promise<void> {
  if (!isAbsolute(root) || !isAbsolute(target) || resolve(root) !== root ||
      resolve(target) !== target || !strictDescendant(root, target)) {
    fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_PATH_ESCAPE");
  }
  let current = root;
  const parts = relative(root, target).split(sep);
  for (let index = 0; index < parts.length; index += 1) {
    current = resolve(current, parts[index]!);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (index === parts.length - 1 && errorCode(error) === "ENOENT") return;
      fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_FILESYSTEM_ERROR");
    }
    if (info.isSymbolicLink()) fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_SYMLINK");
    if (index < parts.length - 1 && !info.isDirectory()) {
      fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_FILESYSTEM_ERROR");
    }
  }
}

async function readVerified(root: string, path: string, expected: string): Promise<string> {
  if (!SHA256.test(expected)) fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_INVALID_ARGUMENT");
  await assertNoSymlinkChain(root, path);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_INPUT_DRIFT");
    const value = await handle.readFile("utf8");
    if (sha256(value) !== expected) fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_INPUT_DRIFT");
    return value;
  } catch (error) {
    if (error instanceof GovernedAssetProposalOperatorError) throw error;
    if (errorCode(error) === "ELOOP") fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_SYMLINK");
    fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_FILESYSTEM_ERROR");
  } finally {
    await handle?.close().catch(() => undefined);
  }
  return fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_FILESYSTEM_ERROR");
}

function parseJsonLines(serialized: string): unknown[] {
  if (!serialized.endsWith("\n") || serialized.trim().length === 0) {
    fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_INPUT_DRIFT");
  }
  try {
    return serialized.trimEnd().split("\n").map((line) => JSON.parse(line) as unknown);
  } catch {
    fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_INPUT_DRIFT");
  }
}

function strings(value: unknown, allowEmpty = true): string[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) || !allowEmpty && value.length === 0 ||
      value.some((item) => typeof item !== "string" || item.length === 0)) {
    fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_INPUT_DRIFT");
  }
  const result = [...value] as string[];
  if (new Set(result).size !== result.length || result.some((item, index) => index > 0 &&
      result[index - 1]!.localeCompare(item) >= 0)) {
    fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_INPUT_DRIFT");
  }
  return result;
}

function sourceBindings(value: unknown): Array<{ sourceRef: string; sourceHash: string }> {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_INPUT_DRIFT");
  }
  return value.map((candidate) => {
    const item = exactKeys(candidate, ["sourceRef", "sourceHash"]);
    if (typeof item.sourceRef !== "string" || item.sourceRef.length === 0 ||
        typeof item.sourceHash !== "string" || !SHA256.test(item.sourceHash)) {
      fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_INPUT_DRIFT");
    }
    return { sourceRef: item.sourceRef, sourceHash: item.sourceHash };
  }).sort((left, right) => left.sourceRef.localeCompare(right.sourceRef));
}

interface ResourceReview {
  unitId: string;
  scopeFingerprint: string;
  verdict: "link" | "no_link" | "needs_review";
  resourceIdentityRefs: string[];
  evidenceSources: Array<{ sourceRef: string; sourceHash: string }>;
  reasonCodes: string[];
  canonicalRow: unknown;
}

function parseResourceReviews(serialized: string): ResourceReview[] {
  const seen = new Set<string>();
  return parseJsonLines(serialized).map((candidate): ResourceReview => {
    const item = exactKeys(candidate, [
      "schema", "unitId", "scopeFingerprint", "verdict", "resourceIdentityRefs",
      "evidenceSources", "confidence", "reasonCodes", "notes", "candidateOnly",
    ]);
    if (item.schema !== RESOURCE_REVIEW_SCHEMA || item.candidateOnly !== true ||
        typeof item.unitId !== "string" || seen.has(item.unitId) ||
        typeof item.scopeFingerprint !== "string" || !SHA256.test(item.scopeFingerprint) ||
        !["link", "no_link", "needs_review"].includes(String(item.verdict)) ||
        typeof item.confidence !== "number" || !Number.isFinite(item.confidence) ||
        item.confidence < 0 || item.confidence > 1 || !Array.isArray(item.notes) ||
        item.notes.some((note) => typeof note !== "string")) {
      fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_RESOURCE_REVIEW_INVALID");
    }
    seen.add(item.unitId);
    return {
      unitId: item.unitId,
      scopeFingerprint: item.scopeFingerprint,
      verdict: item.verdict as ResourceReview["verdict"],
      resourceIdentityRefs: strings(item.resourceIdentityRefs),
      evidenceSources: sourceBindings(item.evidenceSources),
      reasonCodes: strings(item.reasonCodes, false),
      canonicalRow: stableValue(item),
    };
  }).sort((left, right) => left.unitId.localeCompare(right.unitId));
}

function parseSecurityOverrides(serialized: string, typedPlanFileSha256: string):
readonly GovernedAssetUnitGovernanceOverride[] {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_SECURITY_DECISION_INVALID");
  }
  const root = exactKeys(value, [
    "schema", "typedMemoryBatchPlanFileSha256", "scannerPolicyVersion", "createdAt",
    "decisions", "guards",
  ]);
  if (root.schema !== SECURITY_SCHEMA ||
      root.typedMemoryBatchPlanFileSha256 !== typedPlanFileSha256 ||
      typeof root.scannerPolicyVersion !== "string" || !validIso(root.createdAt) ||
      !Array.isArray(root.decisions) || nodeUtilTypes.isProxy(root.decisions)) {
    fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_SECURITY_DECISION_INVALID");
  }
  const guards = exactKeys(root.guards, [
    "sensitiveValueStored", "publicProposalAllowed", "postgresTouched",
  ]);
  if (guards.sensitiveValueStored !== false || guards.publicProposalAllowed !== false ||
      guards.postgresTouched !== false) {
    fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_SECURITY_DECISION_INVALID");
  }
  const seen = new Set<string>();
  return root.decisions.map((candidate): GovernedAssetUnitGovernanceOverride => {
    const item = exactKeys(candidate, [
      "unitId", "action", "reasonCodes", "evidenceHash", "candidateOnly",
    ]);
    const reasonCodes = strings(item.reasonCodes, false);
    if (typeof item.unitId !== "string" || seen.has(item.unitId) ||
        item.action !== "quarantine" || item.candidateOnly !== false ||
        typeof item.evidenceHash !== "string" || !SHA256.test(item.evidenceHash) ||
        reasonCodes.some((reason) => !SAFE_REASON.test(reason))) {
      fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_SECURITY_DECISION_INVALID");
    }
    seen.add(item.unitId);
    return {
      unitId: item.unitId,
      action: "quarantine",
      reasonCodes,
      evidenceHash: item.evidenceHash,
      candidateOnly: false,
    };
  });
}

interface KnowledgeBindingRow {
  scopeFingerprint: string;
  resourceIdentity: string;
  sources: Array<{ sourceRef: string; sourceHash: string }>;
}

function parseKnowledgeBindings(serialized: string): KnowledgeBindingRow[] {
  return parseJsonLines(serialized).map((candidate) => {
    if (!plainRecord(candidate) || typeof candidate.scopeFingerprint !== "string" ||
        !SHA256.test(candidate.scopeFingerprint) || typeof candidate.resourceIdentity !== "string") {
      fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_RESOURCE_REVIEW_INVALID");
    }
    return {
      scopeFingerprint: candidate.scopeFingerprint,
      resourceIdentity: candidate.resourceIdentity,
      sources: sourceBindings(candidate.sources),
    };
  });
}

function deriveResourceInputs(
  reviews: readonly ResourceReview[],
  knowledgeRows: readonly KnowledgeBindingRow[],
  resourceUnits: ReadonlyMap<string, {
    scopeFingerprint: string;
    sources: readonly { sourceRef: string; sourceHash: string }[];
  }>,
): Readonly<{
  bindings: GovernedAssetResourceIdentityBinding[];
  overrides: GovernedAssetUnitGovernanceOverride[];
}> {
  if (reviews.length !== resourceUnits.size ||
      reviews.some((review) => !resourceUnits.has(review.unitId)) ||
      [...resourceUnits.keys()].some((unitId) => !reviews.some((review) => review.unitId === unitId))) {
    fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_RESOURCE_REVIEW_INVALID");
  }
  const bindings: GovernedAssetResourceIdentityBinding[] = [];
  const overrides: GovernedAssetUnitGovernanceOverride[] = [];
  for (const review of reviews) {
    const unit = resourceUnits.get(review.unitId)!;
    if (review.scopeFingerprint !== unit.scopeFingerprint) {
      fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_RESOURCE_REVIEW_INVALID");
    }
    if (review.verdict !== "link") {
      const expectedSources = [...unit.sources].sort((left, right) =>
        left.sourceRef.localeCompare(right.sourceRef));
      if (review.resourceIdentityRefs.length !== 0 ||
          review.evidenceSources.length !== expectedSources.length ||
          review.evidenceSources.some((source, index) =>
            source.sourceRef !== expectedSources[index]?.sourceRef ||
            source.sourceHash !== expectedSources[index]?.sourceHash)) {
        fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_RESOURCE_REVIEW_INVALID");
      }
      overrides.push({
        unitId: review.unitId,
        action: "defer",
        reasonCodes: [...new Set([...review.reasonCodes, "resource_linkage_unavailable"])].sort(),
        evidenceHash: domainHash(
          "mengshu.resource-linkage-review-evidence/v1",
          review.canonicalRow,
        ),
        candidateOnly: false,
      });
      continue;
    }
    if (review.resourceIdentityRefs.length === 0 || review.evidenceSources.length === 0) {
      fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_RESOURCE_REVIEW_INVALID");
    }
    for (const resourceIdentityRef of review.resourceIdentityRefs) {
      const candidates = knowledgeRows.filter((row) =>
        row.scopeFingerprint === review.scopeFingerprint &&
        row.resourceIdentity === resourceIdentityRef);
      if (candidates.length !== 1 || review.evidenceSources.some((source) =>
        !candidates[0]!.sources.some((candidate) =>
          candidate.sourceRef === source.sourceRef && candidate.sourceHash === source.sourceHash))) {
        fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_RESOURCE_REVIEW_INVALID");
      }
      bindings.push({
        memoryUnitId: review.unitId,
        scopeFingerprint: review.scopeFingerprint,
        resourceIdentityRef,
        evidenceSources: review.evidenceSources,
      });
    }
  }
  return Object.freeze({ bindings, overrides });
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
    if (errorCode(error) === "EEXIST") fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_OUTPUT_EXISTS");
    if (errorCode(error) === "ELOOP") fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_SYMLINK");
    fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_FILESYSTEM_ERROR");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function runGovernedAssetProposal(
  input: RunGovernedAssetProposalInput,
): Promise<RunGovernedAssetProposalResult> {
  const paths = [
    input.typedMemoryBatchPlanPath, input.sourceManifestPath,
    input.knowledgeResourceBindingsPath, input.resourceLinkageReviewPath,
    input.securityDecisionsPath, input.outputPath,
  ];
  const hashes = [
    input.typedMemoryBatchPlanFileSha256, input.sourceManifestFileSha256,
    input.knowledgeResourceBindingsFileSha256, input.resourceLinkageReviewFileSha256,
    input.securityDecisionsFileSha256,
  ];
  if (!input || typeof input !== "object" || !isAbsolute(input.containmentRoot) ||
      resolve(input.containmentRoot) !== input.containmentRoot ||
      paths.some((path) => typeof path !== "string" || !isAbsolute(path) ||
        resolve(path) !== path || !strictDescendant(input.containmentRoot, path)) ||
      hashes.some((hash) => typeof hash !== "string" || !SHA256.test(hash)) ||
      !validIso(input.createdAt)) {
    fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_INVALID_ARGUMENT");
  }
  await assertNoSymlinkChain(input.containmentRoot, input.outputPath);
  const [typedText, knowledgeText, reviewText, securityText] = await Promise.all([
    readVerified(
      input.containmentRoot,
      input.typedMemoryBatchPlanPath,
      input.typedMemoryBatchPlanFileSha256,
    ),
    readVerified(
      input.containmentRoot,
      input.knowledgeResourceBindingsPath,
      input.knowledgeResourceBindingsFileSha256,
    ),
    readVerified(
      input.containmentRoot,
      input.resourceLinkageReviewPath,
      input.resourceLinkageReviewFileSha256,
    ),
    readVerified(
      input.containmentRoot,
      input.securityDecisionsPath,
      input.securityDecisionsFileSha256,
    ),
  ]);
  const typedPlan = parseTypedMemoryBatchPlan(typedText);
  if (typedPlan.frozenHashes.knowledgeResourceBindingsFileSha256 !==
      input.knowledgeResourceBindingsFileSha256) {
    fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_INPUT_DRIFT");
  }
  let bundle;
  try {
    bundle = await loadMarkdownWorksetBundle(
      input.sourceManifestPath,
      input.sourceManifestFileSha256,
    );
  } catch {
    fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_INPUT_DRIFT");
  }
  const eligibleSources = new Set(typedPlan.eligibleUnits.flatMap((unit) =>
    unit.sources.map((source) => source.sourceRef)));
  const sourceRecords = bundle.files.map((file) => parseNativeRecordMarkdown(file.markdown))
    .filter((record) => eligibleSources.has(record.sourceRef));
  if (sourceRecords.length !== eligibleSources.size) {
    fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_INPUT_DRIFT");
  }
  const resourceUnits = new Map(typedPlan.eligibleUnits
    .filter((unit) => unit.semanticType === "resource")
    .map((unit) => [unit.unitId, {
      scopeFingerprint: unit.scopeFingerprint,
      sources: unit.sources,
    }] as const));
  const resource = deriveResourceInputs(
    parseResourceReviews(reviewText),
    parseKnowledgeBindings(knowledgeText),
    resourceUnits,
  );
  const securityOverrides = parseSecurityOverrides(
    securityText,
    input.typedMemoryBatchPlanFileSha256,
  );
  const overrideIds = new Set(resource.overrides.map((override) => override.unitId));
  if (securityOverrides.some((override) => overrideIds.has(override.unitId))) {
    fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_SECURITY_DECISION_INVALID");
  }
  let proposalPlan;
  try {
    proposalPlan = planGovernedAssetProposals({
      createdAt: input.createdAt,
      typedMemoryBatchPlanFileSha256: input.typedMemoryBatchPlanFileSha256,
      typedMemoryBatchPlan: typedPlan,
      sourceRecords,
      resourceIdentityBindings: resource.bindings,
      unitGovernanceOverrides: [...resource.overrides, ...securityOverrides],
    });
  } catch {
    fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_PLANNER_REJECTED");
  }
  const serialized = serializeGovernedAssetProposalPlan(proposalPlan);
  const parsed = parseGovernedAssetProposalPlan(serialized);
  await writeExclusive(input.outputPath, serialized);
  return Object.freeze({
    outputPath: input.outputPath,
    outputFileSha256: sha256(serialized),
    semanticPlanSha256: parsed.semanticPlanSha256,
    eligibleUnits: parsed.summary.eligibleUnitCount,
    proposals: parsed.summary.proposalCount,
    claims: parsed.summary.claimCount,
    quarantinedUnits: parsed.summary.quarantinedUnitCount,
    deferredUnits: parsed.summary.deferredUnitCount,
    sourceCoverage: parsed.summary.sourceCoverage,
    unitCoverage: parsed.summary.unitCoverage,
  });
}

const CLI: Readonly<Record<string, keyof RunGovernedAssetProposalInput>> = {
  "--containment-root": "containmentRoot",
  "--typed-plan": "typedMemoryBatchPlanPath",
  "--typed-plan-file-sha256": "typedMemoryBatchPlanFileSha256",
  "--source-manifest": "sourceManifestPath",
  "--source-manifest-file-sha256": "sourceManifestFileSha256",
  "--knowledge-bindings": "knowledgeResourceBindingsPath",
  "--knowledge-bindings-file-sha256": "knowledgeResourceBindingsFileSha256",
  "--resource-review": "resourceLinkageReviewPath",
  "--resource-review-file-sha256": "resourceLinkageReviewFileSha256",
  "--security-decisions": "securityDecisionsPath",
  "--security-decisions-file-sha256": "securityDecisionsFileSha256",
  "--output": "outputPath",
  "--created-at": "createdAt",
};

function parseCli(argv: readonly string[]): RunGovernedAssetProposalInput {
  if (argv.length !== Object.keys(CLI).length * 2) {
    fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_INVALID_ARGUMENT");
  }
  const result: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]!;
    const field = CLI[key];
    const value = argv[index + 1];
    if (!field || !value || Object.prototype.hasOwnProperty.call(result, field)) {
      fail("GOVERNED_ASSET_PROPOSAL_OPERATOR_INVALID_ARGUMENT");
    }
    result[field] = value;
  }
  return result as unknown as RunGovernedAssetProposalInput;
}

async function main(): Promise<void> {
  const result = await runGovernedAssetProposal(parseCli(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    const code = error instanceof GovernedAssetProposalOperatorError
      ? error.code : "GOVERNED_ASSET_PROPOSAL_OPERATOR_FILESYSTEM_ERROR";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
