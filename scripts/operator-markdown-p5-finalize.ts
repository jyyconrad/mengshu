import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  parseGovernedAssetProposalPlan,
  type GovernedAssetProposal,
} from "../packages/core/src/db/migrations/governed-asset-proposal.js";
import {
  parseTypedMemoryBatchPlan,
} from "../packages/core/src/db/migrations/typed-memory-batch-plan.js";
import {
  createPrivateEvidenceBindingsManifest,
  serializePrivateEvidenceBindingsManifest,
  type PrivateClaimEvidenceBinding,
  type PrivateEvidenceExpectedAsset,
  type PrivateEvidenceInputArtifact,
} from "../packages/core/src/documents/private-evidence-bindings.js";
import { validateP5ClusterCrossReview } from "./operator-markdown-p5-cluster-cross-review-validate.js";
import {
  validateP5CrossReview,
  type ValidatedP5CrossReviewRow,
} from "./operator-markdown-p5-cross-review-validate.js";

const INPUT_SCHEMA = "mengshu.p5-finalization-input/v1";
const RESOLUTION_SCHEMA = "mengshu.p5-final-asset-resolution/v1";
const UNIT_LEDGER_SCHEMA = "mengshu.p5-final-unit-disposition/v1";
const RECEIPT_SCHEMA = "mengshu.p5-finalization-receipt/v1";
const CLUSTER_SCHEMA = "mengshu.p5-cluster-cross-review-draft/v1";
const SECURITY_SCHEMA = "mengshu.p5-security-cross-review-draft/v1";
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,511}$/;

interface ArtifactRef {
  readonly path: string;
  readonly sha256: string;
}

interface OrdinaryReviewInput {
  readonly id: string;
  readonly assignment: ArtifactRef;
  readonly primaryReview: ArtifactRef;
  readonly crossReview: ArtifactRef;
}

interface FinalizationInput {
  readonly schema: typeof INPUT_SCHEMA;
  readonly governanceRunId: string;
  readonly policyVersion: string;
  readonly createdAt: string;
  readonly proposalPlan: ArtifactRef;
  readonly typedMemoryPlan: ArtifactRef;
  readonly ordinaryReviews: readonly OrdinaryReviewInput[];
  readonly clusterPrimaryReviewSha256: string;
  readonly clusterCrossReview: ArtifactRef;
  readonly securityCrossReview: ArtifactRef;
}

interface ResolvedClaim {
  readonly claimId: string;
  readonly claimKey: string;
  readonly text: string;
  readonly supportingUnitIds: readonly string[];
  readonly sourceBindings: readonly {
    readonly sourceRef: string;
    readonly sourceHash: string;
    readonly startByte: number;
    readonly endByte: number;
    readonly excerptHash: string;
  }[];
}

interface ResolvedAsset {
  readonly schema: "mengshu.p5-final-asset-candidate/v1";
  readonly assetId: string;
  readonly proposalId: string;
  readonly governanceClusterId: string | null;
  readonly scopeFingerprint: string;
  readonly scope: GovernedAssetProposal["scope"];
  readonly semanticType: GovernedAssetProposal["semanticType"];
  readonly unitIds: readonly string[];
  readonly title: string;
  readonly claims: readonly ResolvedClaim[];
  readonly relations: readonly {
    readonly type: string;
    readonly targetAssetId: string;
    readonly reasonCode: string;
  }[];
  readonly internalClaimRelations: readonly {
    readonly type: string;
    readonly fromClaimId: string;
    readonly toClaimId: string;
    readonly reasonCode: string;
  }[];
  readonly confidence: number;
  readonly resolutionKind: "ordinary_cross_review" | "cluster_cross_review";
  readonly candidateOnly: true;
}

type UnitAction = "publish_candidate" | "defer" | "quarantine";

interface UnitDisposition {
  readonly schema: typeof UNIT_LEDGER_SCHEMA;
  readonly unitId: string;
  readonly scopeFingerprint: string;
  readonly semanticType: string;
  readonly sourceBindings: readonly { readonly sourceRef: string; readonly sourceHash: string }[];
  readonly action: UnitAction;
  readonly targetAssetId: string | null;
  readonly reasonCodes: readonly string[];
  readonly candidateOnly: true;
}

class P5FinalizationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "P5FinalizationError";
  }
}

function fail(code: string): never {
  throw new P5FinalizationError(code);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function canonicalJsonLine(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function strictDescendant(root: string, target: string): boolean {
  const child = relative(root, target);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function containedPath(root: string, relativePath: string): string {
  if (typeof relativePath !== "string" || relativePath.length === 0 || isAbsolute(relativePath)) {
    fail("P5_FINALIZATION_PATH_INVALID");
  }
  const target = resolve(root, relativePath);
  if (!strictDescendant(root, target)) fail("P5_FINALIZATION_PATH_INVALID");
  return target;
}

async function readVerified(root: string, ref: ArtifactRef): Promise<string> {
  if (!ref || !SHA256.test(ref.sha256)) fail("P5_FINALIZATION_INPUT_INVALID");
  const path = containedPath(root, ref.path);
  let current = root;
  for (const part of relative(root, path).split(sep)) {
    current = resolve(current, part);
    const info = await lstat(current).catch(() => fail("P5_FINALIZATION_FILESYSTEM_ERROR"));
    if (info.isSymbolicLink()) fail("P5_FINALIZATION_SYMLINK");
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const text = await handle.readFile("utf8");
    if (sha256(text) !== ref.sha256) fail("P5_FINALIZATION_INPUT_DRIFT");
    return text;
  } catch (error) {
    if (error instanceof P5FinalizationError) throw error;
    fail("P5_FINALIZATION_FILESYSTEM_ERROR");
  } finally {
    await handle?.close().catch(() => undefined);
  }
  return fail("P5_FINALIZATION_FILESYSTEM_ERROR");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    fail("P5_FINALIZATION_INPUT_INVALID");
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("P5_FINALIZATION_INPUT_INVALID");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: unknown, expected: readonly string[]): Record<string, unknown> {
  const item = record(value);
  const actual = Object.keys(item).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    fail("P5_FINALIZATION_INPUT_INVALID");
  }
  return item;
}

function artifactRef(value: unknown): ArtifactRef {
  const item = exactKeys(value, ["path", "sha256"]);
  if (typeof item.path !== "string" || typeof item.sha256 !== "string" ||
      !SHA256.test(item.sha256)) fail("P5_FINALIZATION_INPUT_INVALID");
  return { path: item.path, sha256: item.sha256 };
}

function parseInput(value: unknown): FinalizationInput {
  const item = exactKeys(value, [
    "schema", "governanceRunId", "policyVersion", "createdAt", "proposalPlan",
    "typedMemoryPlan", "ordinaryReviews", "clusterPrimaryReviewSha256",
    "clusterCrossReview", "securityCrossReview",
  ]);
  if (item.schema !== INPUT_SCHEMA || typeof item.governanceRunId !== "string" ||
      !SAFE_ID.test(item.governanceRunId) || typeof item.policyVersion !== "string" ||
      item.policyVersion.length === 0 || typeof item.createdAt !== "string" ||
      new Date(item.createdAt).toISOString() !== item.createdAt ||
      typeof item.clusterPrimaryReviewSha256 !== "string" ||
      !SHA256.test(item.clusterPrimaryReviewSha256) ||
      !Array.isArray(item.ordinaryReviews) || item.ordinaryReviews.length !== 3) {
    fail("P5_FINALIZATION_INPUT_INVALID");
  }
  const ordinaryReviews = item.ordinaryReviews.map((raw) => {
    const review = exactKeys(raw, ["id", "assignment", "primaryReview", "crossReview"]);
    if (typeof review.id !== "string" || !SAFE_ID.test(review.id)) {
      fail("P5_FINALIZATION_INPUT_INVALID");
    }
    return {
      id: review.id,
      assignment: artifactRef(review.assignment),
      primaryReview: artifactRef(review.primaryReview),
      crossReview: artifactRef(review.crossReview),
    };
  });
  if (new Set(ordinaryReviews.map((review) => review.id)).size !== ordinaryReviews.length) {
    fail("P5_FINALIZATION_INPUT_INVALID");
  }
  return {
    schema: INPUT_SCHEMA,
    governanceRunId: item.governanceRunId,
    policyVersion: item.policyVersion,
    createdAt: item.createdAt,
    proposalPlan: artifactRef(item.proposalPlan),
    typedMemoryPlan: artifactRef(item.typedMemoryPlan),
    ordinaryReviews,
    clusterPrimaryReviewSha256: item.clusterPrimaryReviewSha256,
    clusterCrossReview: artifactRef(item.clusterCrossReview),
    securityCrossReview: artifactRef(item.securityCrossReview),
  };
}

function parseJsonLines(text: string): unknown[] {
  if (!text.endsWith("\n") || text.trim().length === 0) {
    fail("P5_FINALIZATION_INPUT_INVALID");
  }
  return text.trimEnd().split("\n").map(parseJson);
}

function finalAssetId(candidateId: string): string {
  return `doc_${sha256(`mengshu.p5-final-asset/v1\0${candidateId}`).slice(0, 32)}`;
}

function finalClaimId(assetId: string, claimKey: string, text: string): string {
  return `claim_${sha256(`mengshu.p5-final-claim/v1\0${assetId}\0${claimKey}\0${text}`)
    .slice(0, 32)}`;
}

function sourceTextMap(plan: ReturnType<typeof parseGovernedAssetProposalPlan>): Map<string, string> {
  const result = new Map<string, string>();
  for (const proposal of plan.proposals) {
    for (const claim of proposal.claims) {
      for (const binding of claim.sourceBindings) {
        const existing = result.get(binding.sourceRef);
        if (existing !== undefined && existing !== claim.text) {
          fail("P5_FINALIZATION_SOURCE_TEXT_DRIFT");
        }
        result.set(binding.sourceRef, claim.text);
      }
    }
  }
  return result;
}

function ordinaryAsset(
  row: ValidatedP5CrossReviewRow,
  proposal: GovernedAssetProposal,
): ResolvedAsset {
  const assetId = finalAssetId(proposal.assetCandidateId);
  return {
    schema: "mengshu.p5-final-asset-candidate/v1",
    assetId,
    proposalId: proposal.proposalId,
    governanceClusterId: null,
    scopeFingerprint: proposal.scopeFingerprint,
    scope: proposal.scope,
    semanticType: proposal.semanticType,
    unitIds: [...proposal.unitIds].sort(),
    title: row.titleCandidate,
    claims: row.claims.map((claim) => ({
      claimId: finalClaimId(assetId, claim.claimKey, claim.text),
      claimKey: claim.claimKey,
      text: claim.text,
      supportingUnitIds: [...proposal.unitIds].sort(),
      sourceBindings: claim.sourceBindings,
    })),
    relations: [],
    internalClaimRelations: [],
    confidence: row.confidence,
    resolutionKind: "ordinary_cross_review",
    candidateOnly: true,
  };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail("P5_FINALIZATION_INPUT_INVALID");
  }
  return [...value] as string[];
}

function parseClusterAssets(
  rows: readonly unknown[],
  plan: ReturnType<typeof parseGovernedAssetProposalPlan>,
  reviewedDraftHash: string,
): ResolvedAsset[] {
  const proposals = new Map(plan.proposals.filter((proposal) => proposal.governanceClusterId)
    .map((proposal) => [proposal.governanceClusterId!, proposal] as const));
  return rows.map((raw): ResolvedAsset => {
    const row = exactKeys(raw, [
      "schema", "clusterId", "reviewedDraftHash", "verdict", "titleCandidate", "claims",
      "relationCandidates", "confidence", "reasonCodes", "notes", "candidateOnly",
    ]);
    const proposal = typeof row.clusterId === "string" ? proposals.get(row.clusterId) : undefined;
    if (row.schema !== CLUSTER_SCHEMA || row.reviewedDraftHash !== reviewedDraftHash || !proposal ||
        row.verdict !== "accept" && row.verdict !== "override" ||
        typeof row.titleCandidate !== "string" || typeof row.confidence !== "number" ||
        !Array.isArray(row.claims) || !Array.isArray(row.relationCandidates)) {
      fail("P5_FINALIZATION_INPUT_INVALID");
    }
    const assetId = finalAssetId(proposal.assetCandidateId);
    const claimIdByKey = new Map<string, string>();
    const claims = row.claims.map((rawClaim): ResolvedClaim => {
      const claim = exactKeys(rawClaim, [
        "claimKey", "text", "supportingUnitIds", "sourceBindings",
      ]);
      if (typeof claim.claimKey !== "string" || typeof claim.text !== "string" ||
          !Array.isArray(claim.sourceBindings)) fail("P5_FINALIZATION_INPUT_INVALID");
      const claimId = finalClaimId(assetId, claim.claimKey, claim.text);
      if (claimIdByKey.has(claim.claimKey)) fail("P5_FINALIZATION_INPUT_INVALID");
      claimIdByKey.set(claim.claimKey, claimId);
      return {
        claimId,
        claimKey: claim.claimKey,
        text: claim.text,
        supportingUnitIds: stringList(claim.supportingUnitIds).sort(),
        sourceBindings: claim.sourceBindings as ResolvedClaim["sourceBindings"],
      };
    });
    const internalClaimRelations = row.relationCandidates.map((rawRelation) => {
      const relation = exactKeys(rawRelation, [
        "relation", "fromClaimKey", "toClaimKey", "reasonCode",
      ]);
      const fromClaimId = typeof relation.fromClaimKey === "string"
        ? claimIdByKey.get(relation.fromClaimKey) : undefined;
      const toClaimId = typeof relation.toClaimKey === "string"
        ? claimIdByKey.get(relation.toClaimKey) : undefined;
      if (typeof relation.relation !== "string" || !fromClaimId || !toClaimId ||
          typeof relation.reasonCode !== "string") fail("P5_FINALIZATION_INPUT_INVALID");
      return {
        type: relation.relation,
        fromClaimId,
        toClaimId,
        reasonCode: relation.reasonCode,
      };
    });
    return {
      schema: "mengshu.p5-final-asset-candidate/v1",
      assetId,
      proposalId: proposal.proposalId,
      governanceClusterId: proposal.governanceClusterId,
      scopeFingerprint: proposal.scopeFingerprint,
      scope: proposal.scope,
      semanticType: proposal.semanticType,
      unitIds: [...proposal.unitIds].sort(),
      title: row.titleCandidate,
      claims,
      relations: [],
      internalClaimRelations,
      confidence: row.confidence,
      resolutionKind: "cluster_cross_review",
      candidateOnly: true,
    };
  });
}

function securityDecisionIds(rows: readonly unknown[]): {
  readonly confirmedUnitIds: ReadonlySet<string>;
  readonly manualProposalIds: ReadonlySet<string>;
} {
  const confirmedUnitIds = new Set<string>();
  const manualProposalIds = new Set<string>();
  for (const raw of rows) {
    const row = exactKeys(raw, [
      "schema", "unitId", "proposalId", "verdict", "confidence", "patternClasses",
      "reasonCodes", "reviewedEvidenceHash", "candidateOnly",
    ]);
    if (row.schema !== SECURITY_SCHEMA || typeof row.unitId !== "string" ||
        row.proposalId !== null && typeof row.proposalId !== "string" ||
        row.verdict !== "confirm_quarantine" && row.verdict !== "false_positive_needs_manual" ||
        typeof row.reviewedEvidenceHash !== "string" || !SHA256.test(row.reviewedEvidenceHash) ||
        row.candidateOnly !== true) fail("P5_FINALIZATION_SECURITY_INVALID");
    if (row.verdict === "confirm_quarantine") confirmedUnitIds.add(row.unitId);
    if (row.verdict === "false_positive_needs_manual") {
      if (typeof row.proposalId !== "string") fail("P5_FINALIZATION_SECURITY_INVALID");
      manualProposalIds.add(row.proposalId);
    }
  }
  return { confirmedUnitIds, manualProposalIds };
}

function createEvidence(
  assets: readonly ResolvedAsset[],
  sources: ReadonlyMap<string, string>,
  input: FinalizationInput,
): string {
  const expectedAssets: PrivateEvidenceExpectedAsset[] = assets.map((asset) => ({
    assetId: asset.assetId,
    assetVersion: 1,
    scopeFingerprint: asset.scopeFingerprint,
    claimIds: asset.claims.map((claim) => claim.claimId).sort(),
  })).sort((left, right) => left.assetId.localeCompare(right.assetId));
  const bindings: PrivateClaimEvidenceBinding[] = [];
  for (const asset of assets) {
    for (const claim of asset.claims) {
      for (const source of claim.sourceBindings) {
        const sourceText = sources.get(source.sourceRef);
        if (sourceText === undefined) fail("P5_FINALIZATION_SOURCE_TEXT_MISSING");
        const evidenceId = `evidence_${sha256([
          asset.assetId, claim.claimId, source.sourceRef, source.startByte, source.endByte,
          source.excerptHash,
        ].join("\0")).slice(0, 32)}`;
        bindings.push({
          assetId: asset.assetId,
          assetVersion: 1,
          claimId: claim.claimId,
          evidenceId,
          sourceRef: source.sourceRef,
          sourceHash: source.sourceHash,
          sourceContentHash: sha256(sourceText),
          scopeFingerprint: asset.scopeFingerprint,
          anchor: {
            utf8ByteStart: source.startByte,
            utf8ByteEnd: source.endByte,
            excerptHash: source.excerptHash,
          },
          status: "active",
          resourceIdentity: null,
        });
      }
    }
  }
  bindings.sort((left, right) => left.assetId.localeCompare(right.assetId) ||
    left.assetVersion - right.assetVersion || left.claimId.localeCompare(right.claimId) ||
    left.evidenceId.localeCompare(right.evidenceId) || left.sourceRef.localeCompare(right.sourceRef) ||
    left.anchor.utf8ByteStart - right.anchor.utf8ByteStart ||
    left.anchor.utf8ByteEnd - right.anchor.utf8ByteEnd);
  const refs: PrivateEvidenceInputArtifact[] = [
    { artifact: "p5_cluster_cross_review", sha256: input.clusterCrossReview.sha256 },
    { artifact: "p5_proposal_plan", sha256: input.proposalPlan.sha256 },
    { artifact: "p5_security_cross_review", sha256: input.securityCrossReview.sha256 },
    { artifact: "p5_typed_memory_plan", sha256: input.typedMemoryPlan.sha256 },
    ...input.ordinaryReviews.map((review) => ({
      artifact: `p5_ordinary_cross_${review.id}`,
      sha256: review.crossReview.sha256,
    })),
  ].sort((left, right) => left.artifact.localeCompare(right.artifact));
  return serializePrivateEvidenceBindingsManifest(createPrivateEvidenceBindingsManifest({
    governanceRunId: input.governanceRunId,
    createdAt: input.createdAt,
    inputs: refs,
    expectedAssets,
    bindings,
  }));
}

async function writeExclusive(path: string, content: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
      constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch {
    fail("P5_FINALIZATION_OUTPUT_WRITE_FAILED");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function finalize(
  containmentRoot: string,
  input: FinalizationInput,
  outputDir: string,
): Promise<Record<string, unknown>> {
  const proposalPlanPath = containedPath(containmentRoot, input.proposalPlan.path);
  const [proposalText, typedText, clusterText, securityText] = await Promise.all([
    readVerified(containmentRoot, input.proposalPlan),
    readVerified(containmentRoot, input.typedMemoryPlan),
    readVerified(containmentRoot, input.clusterCrossReview),
    readVerified(containmentRoot, input.securityCrossReview),
  ]);
  const proposalPlan = parseGovernedAssetProposalPlan(proposalText);
  const typedPlan = parseTypedMemoryBatchPlan(typedText);
  if (proposalPlan.migrationRunId !== input.governanceRunId ||
      typedPlan.migrationRunId !== input.governanceRunId) fail("P5_FINALIZATION_INPUT_DRIFT");

  const ordinaryResults = await Promise.all(input.ordinaryReviews.map((review) =>
    validateP5CrossReview({
      containmentRoot,
      proposalPlanPath,
      proposalPlanFileSha256: input.proposalPlan.sha256,
      assignmentPath: containedPath(containmentRoot, review.assignment.path),
      assignmentFileSha256: review.assignment.sha256,
      reviewPath: containedPath(containmentRoot, review.primaryReview.path),
      reviewFileSha256: review.primaryReview.sha256,
      crossReviewPath: containedPath(containmentRoot, review.crossReview.path),
      crossReviewFileSha256: review.crossReview.sha256,
    })));
  await validateP5ClusterCrossReview({
    containmentRoot,
    proposalPlanPath,
    proposalPlanFileSha256: input.proposalPlan.sha256,
    crossReviewPath: containedPath(containmentRoot, input.clusterCrossReview.path),
    crossReviewFileSha256: input.clusterCrossReview.sha256,
    reviewedDraftFileSha256: input.clusterPrimaryReviewSha256,
  });

  const proposalById = new Map(proposalPlan.proposals.map((proposal) =>
    [proposal.proposalId, proposal] as const));
  const ordinaryRows = ordinaryResults.flatMap((result) => result.rows);
  const ordinaryAssets = ordinaryRows.filter((row) =>
    row.verdict === "accept" || row.verdict === "override").map((row) => {
    const proposal = proposalById.get(row.proposalId);
    if (!proposal || proposal.governanceClusterId) fail("P5_FINALIZATION_PROPOSAL_DRIFT");
    return ordinaryAsset(row, proposal);
  });
  const clusterAssets = parseClusterAssets(
    parseJsonLines(clusterText), proposalPlan, input.clusterPrimaryReviewSha256,
  );
  const assets = [...ordinaryAssets, ...clusterAssets].sort((left, right) =>
    left.assetId.localeCompare(right.assetId));
  const assetByProposal = new Map(assets.map((asset) => [asset.proposalId, asset] as const));
  const assetByCandidate = new Map(proposalPlan.proposals.map((proposal) => {
    const asset = assetByProposal.get(proposal.proposalId);
    return [proposal.assetCandidateId, asset] as const;
  }));
  for (const row of ordinaryRows.filter((candidate) =>
    candidate.verdict === "accept" || candidate.verdict === "override")) {
    const asset = assetByProposal.get(row.proposalId)!;
    (asset.relations as Array<ResolvedAsset["relations"][number]>).push(
      ...row.relationCandidates.map((relation) => {
        const target = assetByCandidate.get(relation.targetAssetCandidateId);
        if (!target || target.scopeFingerprint !== asset.scopeFingerprint) {
          fail("P5_FINALIZATION_RELATION_TARGET_INVALID");
        }
        return {
          type: relation.relationType,
          targetAssetId: target.assetId,
          reasonCode: relation.reasonCode,
        };
      }),
    );
  }
  if (new Set(assets.map((asset) => asset.assetId)).size !== assets.length ||
      assets.some((asset) => asset.claims.length === 0 ||
        new Set(asset.claims.map((claim) => claim.claimId)).size !== asset.claims.length)) {
    fail("P5_FINALIZATION_ASSET_COVERAGE_INVALID");
  }

  const security = securityDecisionIds(parseJsonLines(securityText));
  const ordinaryByProposal = new Map(ordinaryRows.map((row) => [row.proposalId, row] as const));
  for (const proposalId of security.manualProposalIds) {
    if (ordinaryByProposal.get(proposalId)?.verdict !== "quarantine") {
      fail("P5_FINALIZATION_SECURITY_RELEASE_FORBIDDEN");
    }
  }
  for (const unitId of security.confirmedUnitIds) {
    if (!proposalPlan.excludedUnits.some((unit) =>
      unit.unitId === unitId && unit.action === "quarantine")) {
      fail("P5_FINALIZATION_SECURITY_INVALID");
    }
  }

  const actionByUnit = new Map<string, {
    action: UnitAction;
    assetId: string | null;
    reasonCodes: readonly string[];
  }>();
  for (const asset of assets) {
    for (const unitId of asset.unitIds) {
      if (actionByUnit.has(unitId)) fail("P5_FINALIZATION_UNIT_COVERAGE_INVALID");
      actionByUnit.set(unitId, {
        action: "publish_candidate",
        assetId: asset.assetId,
        reasonCodes: [asset.resolutionKind],
      });
    }
  }
  for (const row of ordinaryRows.filter((candidate) =>
    candidate.verdict === "needs_review" || candidate.verdict === "quarantine")) {
    const proposal = proposalById.get(row.proposalId);
    if (!proposal) fail("P5_FINALIZATION_PROPOSAL_DRIFT");
    for (const unitId of proposal.unitIds) {
      if (actionByUnit.has(unitId)) fail("P5_FINALIZATION_UNIT_COVERAGE_INVALID");
      actionByUnit.set(unitId, {
        action: row.verdict === "quarantine" ? "quarantine" : "defer",
        assetId: null,
        reasonCodes: row.reasonCodes,
      });
    }
  }
  for (const excluded of proposalPlan.excludedUnits) {
    if (actionByUnit.has(excluded.unitId)) fail("P5_FINALIZATION_UNIT_COVERAGE_INVALID");
    actionByUnit.set(excluded.unitId, {
      action: excluded.action,
      assetId: null,
      reasonCodes: excluded.reasonCodes,
    });
  }
  const unitDispositions: UnitDisposition[] = typedPlan.eligibleUnits.map((unit): UnitDisposition => {
    const decision = actionByUnit.get(unit.unitId);
    if (!decision) fail("P5_FINALIZATION_UNIT_COVERAGE_INVALID");
    return {
      schema: UNIT_LEDGER_SCHEMA,
      unitId: unit.unitId,
      scopeFingerprint: unit.scopeFingerprint,
      semanticType: unit.semanticType,
      sourceBindings: [...unit.sources],
      action: decision.action,
      targetAssetId: decision.assetId,
      reasonCodes: [...decision.reasonCodes].sort(),
      candidateOnly: true,
    };
  }).sort((left, right) => left.unitId.localeCompare(right.unitId));
  if (unitDispositions.length !== typedPlan.eligibleUnits.length ||
      actionByUnit.size !== typedPlan.eligibleUnits.length ||
      new Set(unitDispositions.flatMap((unit) =>
        unit.sourceBindings.map((source) => source.sourceRef))).size !==
        typedPlan.summary.eligibleSources) fail("P5_FINALIZATION_UNIT_COVERAGE_INVALID");

  const resolution = {
    schema: RESOLUTION_SCHEMA,
    governanceRunId: input.governanceRunId,
    policyVersion: input.policyVersion,
    createdAt: input.createdAt,
    inputs: {
      proposalPlanSha256: input.proposalPlan.sha256,
      typedMemoryPlanSha256: input.typedMemoryPlan.sha256,
      ordinaryCrossReviewSha256: input.ordinaryReviews.map((review) =>
        review.crossReview.sha256).sort(),
      clusterCrossReviewSha256: input.clusterCrossReview.sha256,
      securityCrossReviewSha256: input.securityCrossReview.sha256,
    },
    assets,
    summary: {
      assetCount: assets.length,
      ordinaryAssetCount: ordinaryAssets.length,
      clusterAssetCount: clusterAssets.length,
      claimCount: assets.reduce((sum, asset) => sum + asset.claims.length, 0),
      sourceBindingCount: assets.reduce((sum, asset) => sum + asset.claims.reduce(
        (claimSum, claim) => claimSum + claim.sourceBindings.length, 0), 0),
      unitCount: unitDispositions.length,
      publishUnitCount: unitDispositions.filter((unit) =>
        unit.action === "publish_candidate").length,
      deferredUnitCount: unitDispositions.filter((unit) => unit.action === "defer").length,
      quarantinedUnitCount: unitDispositions.filter((unit) =>
        unit.action === "quarantine").length,
      unitCoverage: 1,
      claimEvidenceCoverage: 1,
    },
    guards: {
      candidateOnly: true,
      formalMarkdownWritten: false,
      publicEvidenceProjectionAllowed: false,
      postgresTouched: false,
    },
  };
  const resolutionText = canonicalJson(resolution);
  const ledgerText = `${unitDispositions.map(canonicalJsonLine).join("\n")}\n`;
  const evidenceText = createEvidence(assets, sourceTextMap(proposalPlan), input);

  const outputPath = containedPath(containmentRoot, outputDir);
  await mkdir(outputPath, { mode: 0o700 }).catch(() => fail("P5_FINALIZATION_OUTPUT_EXISTS"));
  const files = {
    resolution: {
      name: "resolved-assets.json", content: resolutionText, sha256: sha256(resolutionText),
    },
    unitLedger: {
      name: "unit-dispositions.jsonl", content: ledgerText, sha256: sha256(ledgerText),
    },
    privateEvidence: {
      name: "private-evidence-bindings.json", content: evidenceText, sha256: sha256(evidenceText),
    },
  };
  await Promise.all(Object.values(files).map((file) =>
    writeExclusive(resolve(outputPath, file.name), file.content)));
  const receipt = {
    schema: RECEIPT_SCHEMA,
    governanceRunId: input.governanceRunId,
    createdAt: input.createdAt,
    outputs: Object.fromEntries(Object.entries(files).map(([key, file]) => [key, {
      path: `${outputDir}/${file.name}`,
      sha256: file.sha256,
    }])),
    summary: resolution.summary,
    guards: {
      candidateOnly: true,
      formalMarkdownWritten: false,
      checkpointTouchedByWorker: false,
      postgresTouched: false,
    },
  };
  const receiptText = canonicalJson(receipt);
  await writeExclusive(resolve(outputPath, "receipt.json"), receiptText);
  return {
    outputDir,
    receiptSha256: sha256(receiptText),
    outputs: receipt.outputs,
    summary: receipt.summary,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length !== 8 || argv[0] !== "--containment-root" ||
      argv[2] !== "--input" || argv[4] !== "--input-sha256" ||
      argv[6] !== "--output-dir") fail("P5_FINALIZATION_INVALID_ARGUMENT");
  const containmentRoot = resolve(argv[1]!);
  if (!isAbsolute(argv[1]!) || containmentRoot !== argv[1]) {
    fail("P5_FINALIZATION_INVALID_ARGUMENT");
  }
  const inputRef = { path: argv[3]!, sha256: argv[5]! };
  const input = parseInput(parseJson(await readVerified(containmentRoot, inputRef)));
  const result = await finalize(containmentRoot, input, argv[7]!);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    const code = error instanceof P5FinalizationError
      ? error.code : "P5_FINALIZATION_UNEXPECTED_ERROR";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
