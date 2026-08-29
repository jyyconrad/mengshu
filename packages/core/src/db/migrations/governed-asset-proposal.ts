import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import { authorityScopeFingerprint } from "../../domain/authority-scope-fingerprint.js";
import type { MemoryScope, MemorySemanticType } from "../../domain/types.js";
import type { GovernedDocumentRelationType } from "../../documents/types.js";
import {
  parseNativeRecordMarkdown,
  renderNativeRecordMarkdown,
  type MarkdownWorksetRecord,
} from "./markdown-workset.js";
import {
  parseTypedMemoryBatchPlan,
  serializeTypedMemoryBatchPlan,
  type TypedMemoryBatchPlan,
  type TypedMemoryEligibleUnit,
  type TypedMemorySourceBinding,
} from "./typed-memory-batch-plan.js";

export const GOVERNED_ASSET_PROPOSAL_PLAN_SCHEMA =
  "mengshu.governed-asset-proposal-plan/v1" as const;
const PROPOSAL_SCHEMA = "mengshu.governed-asset-proposal/v1" as const;
const CLAIM_SCHEMA = "mengshu.governed-asset-claim-candidate/v1" as const;
const ANCHOR_SCHEMA = "mengshu.governed-asset-source-anchor/v1" as const;
const RELATION_SCHEMA = "mengshu.governed-asset-relation-candidate/v1" as const;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,511}$/;
const SAFE_POLICY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,511}$/;
const PLACEHOLDER_TITLE = /^(?:untitled|tbd|todo|unknown|placeholder|无标题|未命名|待定)$/iu;
const SEMANTIC_TYPES = new Set<MemorySemanticType>([
  "profile", "task_context", "rules", "experience", "resource",
]);
const RELATION_TYPES = new Set<GovernedDocumentRelationType>([
  "related", "references", "derived_from", "depends_on", "supersedes",
  "superseded_by", "contradicts", "tree_route",
]);

export interface GovernedAssetResourceIdentityBinding {
  readonly memoryUnitId: string;
  readonly scopeFingerprint: string;
  readonly resourceIdentityRef: string;
  readonly evidenceSources: readonly TypedMemorySourceBinding[];
}

export interface GovernedAssetUnitGovernanceOverride {
  readonly unitId: string;
  readonly action: "quarantine" | "defer";
  readonly reasonCodes: readonly string[];
  readonly evidenceHash: string;
  readonly candidateOnly: false;
}

export interface PlanGovernedAssetProposalsInput {
  readonly createdAt: string;
  readonly typedMemoryBatchPlanFileSha256: string;
  readonly typedMemoryBatchPlan: TypedMemoryBatchPlan;
  readonly sourceRecords: readonly MarkdownWorksetRecord[];
  readonly resourceIdentityBindings: readonly GovernedAssetResourceIdentityBinding[];
  readonly unitGovernanceOverrides: readonly GovernedAssetUnitGovernanceOverride[];
}

export interface GovernedAssetSourceAnchor {
  readonly schema: typeof ANCHOR_SCHEMA;
  readonly sourceRef: string;
  readonly sourceHash: string;
  readonly startByte: number;
  readonly endByte: number;
  readonly excerptHash: string;
}

export interface GovernedAssetClaimCandidate {
  readonly schema: typeof CLAIM_SCHEMA;
  readonly claimId: string;
  readonly text: string;
  readonly sourceBindings: readonly GovernedAssetSourceAnchor[];
}

export interface GovernedAssetRelationCandidate {
  readonly schema: typeof RELATION_SCHEMA;
  readonly relationType: GovernedDocumentRelationType;
  readonly targetAssetCandidateId: string;
  readonly reasonCode: string;
}

export interface GovernedAssetProposal {
  readonly schema: typeof PROPOSAL_SCHEMA;
  readonly proposalId: string;
  readonly assetCandidateId: string;
  readonly sourceBatchIds: readonly string[];
  readonly scopeFingerprint: string;
  readonly scope: MemoryScope;
  readonly semanticType: MemorySemanticType;
  readonly unitIds: readonly string[];
  readonly governanceClusterId: string | null;
  readonly titleCandidate: string;
  readonly claims: readonly GovernedAssetClaimCandidate[];
  readonly relationCandidates: readonly GovernedAssetRelationCandidate[];
  readonly resourceIdentityRefs: readonly string[];
  readonly needsReview: boolean;
  readonly reviewReasons: readonly string[];
  readonly candidateOnly: true;
}

export interface GovernedAssetExcludedUnit {
  readonly unitId: string;
  readonly action: "quarantine" | "defer";
  readonly reasonCodes: readonly string[];
  readonly evidenceHash: string;
  readonly candidateOnly: true;
}

export interface GovernedAssetProposalPlan {
  readonly schema: typeof GOVERNED_ASSET_PROPOSAL_PLAN_SCHEMA;
  readonly migrationRunId: string;
  readonly policyVersion: string;
  readonly createdAt: string;
  readonly frozenHashes: Readonly<{
    typedMemoryBatchPlanFileSha256: string;
    typedMemoryBatchPlanSemanticSha256: string;
    sourceRecordSetSha256: string;
    resourceIdentityBindingsSha256: string;
    unitGovernanceOverridesSha256: string;
  }>;
  readonly proposals: readonly GovernedAssetProposal[];
  readonly excludedUnits: readonly GovernedAssetExcludedUnit[];
  readonly summary: Readonly<{
    eligibleUnitCount: number;
    eligibleSourceCount: number;
    proposalCount: number;
    claimCount: number;
    clusteredProposalCount: number;
    needsReviewCount: number;
    excludedUnitCount: number;
    quarantinedUnitCount: number;
    deferredUnitCount: number;
    unitCoverage: 1;
    sourceCoverage: 1;
  }>;
  readonly guards: Readonly<{
    candidateOnly: true;
    sourceTextIsAuthoritative: true;
    p2ProposalMarkdownUsedAsContent: false;
    llmEntailmentAsserted: false;
    formalAssetsWritten: false;
    canonicalTargetsSelected: false;
    postgresTouched: false;
    crossScopeGroupingAllowed: false;
    crossTypeGroupingAllowed: false;
    rawPrivateRefsAllowedInPublicContent: false;
  }>;
  readonly semanticPlanSha256: string;
}

function fail(message: string): never {
  throw new Error(`GOVERNED_ASSET_PROPOSAL_INVALID: ${message}`);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      nodeUtilTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!plainRecord(value)) fail(`${label} shape invalid`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} contains an unknown or missing key`);
  }
  return value;
}

function stableValue(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.normalize("NFC");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("non-finite number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (nodeUtilTypes.isProxy(value) || seen.has(value)) fail("proxy or cycle");
    seen.add(value);
    const result = value.map((item) => stableValue(item, seen));
    seen.delete(value);
    return result;
  }
  if (!plainRecord(value) || seen.has(value)) fail("invalid object or cycle");
  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item === undefined || typeof item === "function" || typeof item === "symbol" ||
        typeof item === "bigint") fail("invalid canonical value");
    result[key] = stableValue(item, seen);
  }
  seen.delete(value);
  return result;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function domainHash(domain: string, value: unknown): string {
  return createHash("sha256").update(domain).update("\0").update(stableJson(value)).digest("hex");
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== "string" || value !== value.normalize("NFC") || !SAFE_ID.test(value)) {
    fail(`${label} invalid`);
  }
  return value;
}

function policyVersion(value: unknown): string {
  if (typeof value !== "string" || value !== value.normalize("NFC") ||
      !SAFE_POLICY_VERSION.test(value)) fail("policy version invalid");
  return value;
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(`${label} hash invalid`);
  return value;
}

function iso(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
      new Date(Date.parse(value)).toISOString() !== value) fail(`${label} timestamp invalid`);
  return value;
}

function text(value: unknown, label: string, maxLength = 1_000_000): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.normalize("NFC") ||
      value.length > maxLength || value.includes("\0") || value.includes("\r")) {
    fail(`${label} text invalid`);
  }
  return value;
}

function stringArray(
  value: unknown,
  label: string,
  options: { readonly allowEmpty?: boolean; readonly hash?: boolean } = {},
): string[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) ||
      (options.allowEmpty === false && value.length === 0)) fail(`${label} array invalid`);
  const result = value.map((item) => options.hash ? hash(item, label) : safeId(item, label));
  if (new Set(result).size !== result.length) fail(`${label} duplicated`);
  return result;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(`${label} invalid`);
  return value as number;
}

function validateScope(scope: unknown, fingerprint: unknown, label: string): MemoryScope {
  if (!plainRecord(scope) || typeof fingerprint !== "string" || !SHA256.test(fingerprint)) {
    fail(`${label} scope invalid`);
  }
  try {
    if (authorityScopeFingerprint(scope as unknown as MemoryScope) !== fingerprint) {
      fail(`${label} scope fingerprint drift`);
    }
  } catch {
    fail(`${label} scope invalid`);
  }
  return stableValue(scope) as MemoryScope;
}

function sourceKey(binding: TypedMemorySourceBinding): string {
  return `${binding.sourceRef}\u001f${binding.sourceHash}`;
}

function validateInputSourceRecords(
  records: readonly MarkdownWorksetRecord[],
  expected: ReadonlyMap<string, TypedMemorySourceBinding>,
): ReadonlyMap<string, MarkdownWorksetRecord> {
  if (!Array.isArray(records) || nodeUtilTypes.isProxy(records)) fail("source records invalid");
  const byRef = new Map<string, MarkdownWorksetRecord>();
  for (const candidate of records) {
    let record: MarkdownWorksetRecord;
    try {
      record = parseNativeRecordMarkdown(renderNativeRecordMarkdown(candidate));
    } catch {
      fail("source record envelope invalid");
    }
    if (record.phase !== "source" || byRef.has(record.sourceRef)) {
      fail("source record phase or duplicate invalid");
    }
    const binding = expected.get(record.sourceRef);
    if (!binding) fail("source coverage contains an unexpected record");
    if (binding.sourceHash !== record.sourceHash) fail("source hash drift");
    byRef.set(record.sourceRef, record);
  }
  if (byRef.size !== expected.size || [...expected.keys()].some((ref) => !byRef.has(ref))) {
    fail("source coverage missing an eligible source");
  }
  return byRef;
}

function parseResourceIdentityBindings(
  value: readonly GovernedAssetResourceIdentityBinding[],
  unitsById: ReadonlyMap<string, TypedMemoryEligibleUnit>,
): GovernedAssetResourceIdentityBinding[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    fail("resource identity bindings invalid");
  }
  const seen = new Set<string>();
  return value.map((candidate) => {
    const item = exactKeys(candidate, [
      "memoryUnitId", "scopeFingerprint", "resourceIdentityRef", "evidenceSources",
    ], "resource identity binding");
    const memoryUnitId = safeId(item.memoryUnitId, "resource identity memory unit");
    const scopeFingerprint = hash(item.scopeFingerprint, "resource identity scope");
    const unit = unitsById.get(memoryUnitId);
    if (!unit || unit.semanticType !== "resource" ||
        unit.scopeFingerprint !== scopeFingerprint) {
      fail("resource identity binding unit type or scope drift");
    }
    if (!Array.isArray(item.evidenceSources) || item.evidenceSources.length === 0 ||
        nodeUtilTypes.isProxy(item.evidenceSources)) {
      fail("resource identity evidence sources invalid");
    }
    const evidenceSources = item.evidenceSources.map((candidateSource) => {
      const source = exactKeys(candidateSource, ["sourceRef", "sourceHash"],
        "resource identity evidence source");
      return {
        sourceRef: safeId(source.sourceRef, "resource identity evidence ref"),
        sourceHash: hash(source.sourceHash, "resource identity evidence"),
      };
    }).sort((left, right) => left.sourceRef.localeCompare(right.sourceRef));
    if (new Set(evidenceSources.map(sourceKey)).size !== evidenceSources.length) {
      fail("resource identity evidence source duplicated");
    }
    const result = {
      memoryUnitId,
      scopeFingerprint,
      resourceIdentityRef: safeId(item.resourceIdentityRef, "resource identity ref"),
      evidenceSources,
    };
    const key = `${result.memoryUnitId}\u001f${result.resourceIdentityRef}`;
    if (seen.has(key)) fail("resource identity binding duplicated");
    seen.add(key);
    return result;
  }).sort((left, right) => left.memoryUnitId.localeCompare(right.memoryUnitId) ||
    left.resourceIdentityRef.localeCompare(right.resourceIdentityRef));
}

function parseUnitGovernanceOverrides(
  value: readonly GovernedAssetUnitGovernanceOverride[],
  unitsById: ReadonlyMap<string, TypedMemoryEligibleUnit>,
): GovernedAssetUnitGovernanceOverride[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    fail("unit governance overrides invalid");
  }
  const seen = new Set<string>();
  return value.map((candidate) => {
    const item = exactKeys(candidate, [
      "unitId", "action", "reasonCodes", "evidenceHash", "candidateOnly",
    ], "unit governance override");
    const unitId = safeId(item.unitId, "override unit id");
    if (!unitsById.has(unitId) || seen.has(unitId) ||
        (item.action !== "quarantine" && item.action !== "defer") ||
        item.candidateOnly !== false) {
      fail("unit governance override unit, action, or uniqueness invalid");
    }
    const action: GovernedAssetUnitGovernanceOverride["action"] = item.action;
    seen.add(unitId);
    return {
      unitId,
      action,
      reasonCodes: stringArray(item.reasonCodes, "override reason codes", { allowEmpty: false }),
      evidenceHash: hash(item.evidenceHash, "override evidence"),
      candidateOnly: false as const,
    };
  }).sort((left, right) => left.unitId.localeCompare(right.unitId));
}

function derivedTitle(textValue: string, semanticType: MemorySemanticType, seed: string): string {
  const firstLine = textValue.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  let candidate = firstLine
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^[*_`]+|[*_`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (candidate.length > 160) candidate = `${Array.from(candidate).slice(0, 157).join("")}...`;
  if (!candidate || PLACEHOLDER_TITLE.test(candidate)) {
    const labels: Record<MemorySemanticType, string> = {
      profile: "Profile memory",
      task_context: "Task context memory",
      rules: "Rules memory",
      experience: "Experience memory",
      resource: "Resource memory",
    };
    candidate = `${labels[semanticType]} ${seed.slice(0, 12)}`;
  }
  return candidate;
}

function assertNoPrivateRefs(
  titleCandidate: string,
  claims: readonly GovernedAssetClaimCandidate[],
  extraPrivateRefs: readonly string[] = [],
): void {
  const refs = [...new Set([
    ...claims.flatMap((claim) => claim.sourceBindings.map((binding) => binding.sourceRef)),
    ...extraPrivateRefs,
  ])];
  const publicValues = [titleCandidate, ...claims.map((claim) => claim.text)];
  if (refs.some((ref) => publicValues.some((value) => value.includes(ref)))) {
    fail("raw private source reference leaked into public candidate content");
  }
}

function proposalIdentityBody(proposal: Omit<GovernedAssetProposal, "proposalId">): unknown {
  return proposal;
}

function planSemanticBody(plan: Omit<GovernedAssetProposalPlan, "semanticPlanSha256">): unknown {
  const { createdAt: ignored, ...body } = plan;
  return body;
}

function validatePlanCoverage(plan: TypedMemoryBatchPlan): {
  units: readonly TypedMemoryEligibleUnit[];
  batchIdsByUnit: ReadonlyMap<string, readonly string[]>;
  expectedSources: ReadonlyMap<string, TypedMemorySourceBinding>;
} {
  const unitById = new Map<string, TypedMemoryEligibleUnit>();
  const expectedSources = new Map<string, TypedMemorySourceBinding>();
  for (const unit of plan.eligibleUnits) {
    if (unitById.has(unit.unitId) || !SEMANTIC_TYPES.has(unit.semanticType) ||
        authorityScopeFingerprint(unit.scope) !== unit.scopeFingerprint) {
      fail("eligible unit identity, semantic type, or scope invalid");
    }
    unitById.set(unit.unitId, unit);
    for (const binding of unit.sources) {
      safeId(binding.sourceRef, "eligible source ref");
      hash(binding.sourceHash, "eligible source");
      const existing = expectedSources.get(binding.sourceRef);
      if (existing && existing.sourceHash !== binding.sourceHash) fail("eligible source hash conflict");
      expectedSources.set(binding.sourceRef, binding);
    }
  }
  const batchIdsByUnit = new Map<string, string[]>();
  for (const batch of plan.batches) {
    for (const unitId of batch.unitIds) {
      const unit = unitById.get(unitId) ?? fail("batch contains an unknown eligible unit");
      if (unit.scopeFingerprint !== batch.scopeFingerprint ||
          unit.semanticType !== batch.semanticType) {
        fail("batch crosses scope or semantic type");
      }
      const values = batchIdsByUnit.get(unitId) ?? [];
      values.push(batch.batchId);
      batchIdsByUnit.set(unitId, values);
    }
  }
  if (batchIdsByUnit.size !== unitById.size ||
      [...batchIdsByUnit.values()].some((batchIds) => batchIds.length !== 1)) {
    fail("eligible unit batch coverage invalid");
  }
  return { units: [...unitById.values()], batchIdsByUnit, expectedSources };
}

export function planGovernedAssetProposals(
  input: PlanGovernedAssetProposalsInput,
): GovernedAssetProposalPlan {
  const root = exactKeys(input, [
    "createdAt", "typedMemoryBatchPlanFileSha256", "typedMemoryBatchPlan",
    "sourceRecords", "resourceIdentityBindings", "unitGovernanceOverrides",
  ], "planner input");
  const createdAt = iso(root.createdAt, "createdAt");
  const typedMemoryBatchPlanFileSha256 = hash(
    root.typedMemoryBatchPlanFileSha256,
    "typed Memory batch plan file",
  );
  let typedPlan: TypedMemoryBatchPlan;
  try {
    typedPlan = parseTypedMemoryBatchPlan(serializeTypedMemoryBatchPlan(
      root.typedMemoryBatchPlan as TypedMemoryBatchPlan,
    ));
  } catch {
    fail("typed Memory batch plan invalid or unfrozen");
  }
  const { units, batchIdsByUnit, expectedSources } = validatePlanCoverage(typedPlan);
  const unitsById = new Map(units.map((unit) => [unit.unitId, unit] as const));
  const records = validateInputSourceRecords(
    root.sourceRecords as readonly MarkdownWorksetRecord[],
    expectedSources,
  );
  const resourceBindings = parseResourceIdentityBindings(
    root.resourceIdentityBindings as readonly GovernedAssetResourceIdentityBinding[],
    unitsById,
  );
  const overrides = parseUnitGovernanceOverrides(
    root.unitGovernanceOverrides as readonly GovernedAssetUnitGovernanceOverride[],
    unitsById,
  );
  const overrideByUnit = new Map(overrides.map((override) => [override.unitId, override] as const));
  const resourceRefsByUnit = new Map<string, string[]>();
  for (const binding of resourceBindings) {
    const values = resourceRefsByUnit.get(binding.memoryUnitId) ?? [];
    values.push(binding.resourceIdentityRef);
    resourceRefsByUnit.set(binding.memoryUnitId, values);
  }
  const frozenHashes = {
    typedMemoryBatchPlanFileSha256,
    typedMemoryBatchPlanSemanticSha256: typedPlan.semanticPlanSha256,
    sourceRecordSetSha256: domainHash(
      "mengshu.governed-asset-proposal-source-set/v1",
      [...expectedSources.values()].sort((left, right) => left.sourceRef.localeCompare(right.sourceRef)),
    ),
    resourceIdentityBindingsSha256: domainHash(
      "mengshu.governed-asset-proposal-resource-bindings/v1",
      resourceBindings,
    ),
    unitGovernanceOverridesSha256: domainHash(
      "mengshu.governed-asset-proposal-unit-overrides/v1",
      overrides,
    ),
  };

  const groups = new Map<string, TypedMemoryEligibleUnit[]>();
  for (const unit of units) {
    const key = unit.governanceClusterId ?? `unit:${unit.unitId}`;
    const values = groups.get(key) ?? [];
    values.push(unit);
    groups.set(key, values);
  }
  const proposals: GovernedAssetProposal[] = [];
  const excludedUnits: GovernedAssetExcludedUnit[] = [];
  for (const [groupKey, groupUnits] of [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))) {
      groupUnits.sort((left, right) => left.unitId.localeCompare(right.unitId));
      const first = groupUnits[0]!;
      if (groupUnits.some((unit) => unit.scopeFingerprint !== first.scopeFingerprint ||
          unit.semanticType !== first.semanticType)) {
        fail("governance cluster crosses scope or semantic type");
      }
      if (first.governanceClusterId &&
          groupUnits.some((unit) => unit.governanceClusterId !== first.governanceClusterId)) {
        fail("governance cluster is not atomic");
      }
      const groupOverrides = groupUnits.map((unit) => overrideByUnit.get(unit.unitId));
      if (groupOverrides.some(Boolean)) {
        if (groupOverrides.some((override) => !override) ||
            new Set(groupOverrides.map((override) => override!.action)).size !== 1) {
          fail("governance cluster override is not atomic");
        }
        excludedUnits.push(...groupOverrides.map((override) => ({
          unitId: override!.unitId,
          action: override!.action,
          reasonCodes: override!.reasonCodes,
          evidenceHash: override!.evidenceHash,
          candidateOnly: true as const,
        })));
        continue;
      }
      if (first.semanticType === "resource" &&
          groupUnits.some((unit) => !(resourceRefsByUnit.get(unit.unitId)?.length))) {
        fail("resource unit without identity binding requires explicit defer override");
      }
      const textGroups = new Map<string, {
        text: string;
        bindings: GovernedAssetSourceAnchor[];
      }>();
      for (const unit of groupUnits) {
        for (const binding of unit.sources) {
          const record = records.get(binding.sourceRef)!;
          const claimText = text(record.record.text, "source record text");
          const textHash = sha256(claimText);
          const current = textGroups.get(textHash) ?? { text: claimText, bindings: [] };
          if (current.text !== claimText) fail("source text hash collision");
          current.bindings.push({
            schema: ANCHOR_SCHEMA,
            sourceRef: binding.sourceRef,
            sourceHash: binding.sourceHash,
            startByte: 0,
            endByte: Buffer.byteLength(claimText, "utf8"),
            excerptHash: textHash,
          });
          textGroups.set(textHash, current);
        }
      }
      const claims = [...textGroups.entries()].sort(([left], [right]) => left.localeCompare(right))
        .map(([textHash, value]): GovernedAssetClaimCandidate => ({
          schema: CLAIM_SCHEMA,
          claimId: domainHash("mengshu.governed-asset-claim-candidate/v1", {
            groupKey,
            textHash,
            bindings: value.bindings.sort((left, right) =>
              left.sourceRef.localeCompare(right.sourceRef)),
          }),
          text: value.text,
          sourceBindings: value.bindings,
        }));
      if (claims.length === 0) fail("proposal has no source-backed claim");
      const unitIds = groupUnits.map((unit) => unit.unitId);
      const sourceBatchIds = [...new Set(unitIds.flatMap((unitId) =>
        batchIdsByUnit.get(unitId)!))].sort();
      const sourceBindings = claims.flatMap((claim) => claim.sourceBindings)
        .map(({ sourceRef, sourceHash }) => ({ sourceRef, sourceHash }))
        .sort((left, right) => left.sourceRef.localeCompare(right.sourceRef));
      const assetCandidateId = domainHash("mengshu.governed-asset-candidate/v1", {
        scopeFingerprint: first.scopeFingerprint,
        semanticType: first.semanticType,
        governanceClusterId: first.governanceClusterId,
        unitIds,
        sourceBindings,
      });
      const titleCandidate = derivedTitle(claims[0]!.text, first.semanticType, assetCandidateId);
      const reviewReasons = [
        "whole_body_claim_requires_review",
        ...(first.governanceClusterId ? ["semantic_cluster_requires_entailment_review"] : []),
        ...(claims.length > 1 ? ["multiple_source_bodies_require_claim_review"] : []),
        ...(first.semanticType === "resource" &&
          groupUnits.some((unit) => !(resourceRefsByUnit.get(unit.unitId)?.length))
          ? ["resource_identity_binding_missing"]
          : []),
      ];
      const resourceIdentityRefs = [...new Set(unitIds.flatMap((unitId) =>
        resourceRefsByUnit.get(unitId) ?? []))].sort();
      const groupResourceBindings = resourceBindings.filter((binding) =>
        unitIds.includes(binding.memoryUnitId));
      const body: Omit<GovernedAssetProposal, "proposalId"> = {
        schema: PROPOSAL_SCHEMA,
        assetCandidateId,
        sourceBatchIds,
        scopeFingerprint: first.scopeFingerprint,
        scope: first.scope,
        semanticType: first.semanticType,
        unitIds,
        governanceClusterId: first.governanceClusterId,
        titleCandidate,
        claims,
        relationCandidates: [],
        resourceIdentityRefs,
        needsReview: true,
        reviewReasons,
        candidateOnly: true,
      };
      assertNoPrivateRefs(titleCandidate, claims, [
        ...resourceIdentityRefs,
        ...groupResourceBindings.flatMap((binding) =>
          binding.evidenceSources.map((source) => source.sourceRef)),
      ]);
      proposals.push({
        ...body,
        proposalId: domainHash("mengshu.governed-asset-proposal/v1", {
          frozenHashes,
          proposal: proposalIdentityBody(body),
        }),
      });
  }
  proposals.sort((left, right) => left.assetCandidateId.localeCompare(right.assetCandidateId));
  excludedUnits.sort((left, right) => left.unitId.localeCompare(right.unitId));

  const coveredUnits = proposals.flatMap((proposal) => proposal.unitIds);
  const coveredSources = proposals.flatMap((proposal) => proposal.claims)
    .flatMap((claim) => claim.sourceBindings.map((binding) => binding.sourceRef));
  const allCoveredUnitIds = [...coveredUnits, ...excludedUnits.map((unit) => unit.unitId)];
  const excludedSourceCount = excludedUnits.reduce((sum, item) =>
    sum + unitsById.get(item.unitId)!.sourceCount, 0);
  if (allCoveredUnitIds.length !== units.length ||
      new Set(allCoveredUnitIds).size !== units.length ||
      coveredSources.length + excludedSourceCount !== expectedSources.size ||
      new Set(coveredSources).size !== coveredSources.length) {
    fail("eligible unit or source coverage invalid");
  }
  const summary = {
    eligibleUnitCount: units.length,
    eligibleSourceCount: expectedSources.size,
    proposalCount: proposals.length,
    claimCount: proposals.reduce((sum, proposal) => sum + proposal.claims.length, 0),
    clusteredProposalCount: proposals.filter((proposal) => proposal.governanceClusterId).length,
    needsReviewCount: proposals.filter((proposal) => proposal.needsReview).length,
    excludedUnitCount: excludedUnits.length,
    quarantinedUnitCount: excludedUnits.filter((unit) => unit.action === "quarantine").length,
    deferredUnitCount: excludedUnits.filter((unit) => unit.action === "defer").length,
    unitCoverage: 1 as const,
    sourceCoverage: 1 as const,
  };
  const guards = {
    candidateOnly: true as const,
    sourceTextIsAuthoritative: true as const,
    p2ProposalMarkdownUsedAsContent: false as const,
    llmEntailmentAsserted: false as const,
    formalAssetsWritten: false as const,
    canonicalTargetsSelected: false as const,
    postgresTouched: false as const,
    crossScopeGroupingAllowed: false as const,
    crossTypeGroupingAllowed: false as const,
    rawPrivateRefsAllowedInPublicContent: false as const,
  };
  const body: Omit<GovernedAssetProposalPlan, "semanticPlanSha256"> = {
    schema: GOVERNED_ASSET_PROPOSAL_PLAN_SCHEMA,
    migrationRunId: typedPlan.migrationRunId,
    policyVersion: typedPlan.policyVersion,
    createdAt,
    frozenHashes,
    proposals,
    excludedUnits,
    summary,
    guards,
  };
  return stableValue({
    ...body,
    semanticPlanSha256: domainHash(
      "mengshu.governed-asset-proposal-plan/semantic/v1",
      planSemanticBody(body),
    ),
  }) as GovernedAssetProposalPlan;
}

function validateParsedAnchor(value: unknown): GovernedAssetSourceAnchor {
  const item = exactKeys(value, [
    "schema", "sourceRef", "sourceHash", "startByte", "endByte", "excerptHash",
  ], "source anchor");
  if (item.schema !== ANCHOR_SCHEMA) fail("source anchor schema invalid");
  const startByte = nonNegativeInteger(item.startByte, "source anchor start");
  const endByte = nonNegativeInteger(item.endByte, "source anchor end");
  if (startByte !== 0 || endByte <= startByte) fail("source anchor byte range invalid");
  return {
    schema: ANCHOR_SCHEMA,
    sourceRef: safeId(item.sourceRef, "source anchor ref"),
    sourceHash: hash(item.sourceHash, "source anchor source"),
    startByte,
    endByte,
    excerptHash: hash(item.excerptHash, "source anchor excerpt"),
  };
}

function validateParsedProposal(
  value: unknown,
  frozenHashes: GovernedAssetProposalPlan["frozenHashes"],
): GovernedAssetProposal {
  const item = exactKeys(value, [
    "schema", "proposalId", "assetCandidateId", "sourceBatchIds", "scopeFingerprint",
    "scope", "semanticType", "unitIds", "governanceClusterId", "titleCandidate", "claims",
    "relationCandidates", "resourceIdentityRefs", "needsReview", "reviewReasons", "candidateOnly",
  ], "proposal");
  if (item.schema !== PROPOSAL_SCHEMA || item.candidateOnly !== true ||
      typeof item.needsReview !== "boolean" || !Array.isArray(item.claims) || item.claims.length === 0 ||
      !Array.isArray(item.relationCandidates)) fail("proposal contract invalid");
  const semanticType = item.semanticType as MemorySemanticType;
  if (!SEMANTIC_TYPES.has(semanticType)) fail("proposal semantic type invalid");
  const scopeFingerprint = hash(item.scopeFingerprint, "proposal scope");
  const titleCandidate = text(item.titleCandidate, "title candidate", 256).trim();
  if (titleCandidate !== item.titleCandidate || PLACEHOLDER_TITLE.test(titleCandidate)) {
    fail("placeholder title candidate invalid");
  }
  const claims = item.claims.map((candidate): GovernedAssetClaimCandidate => {
    const claim = exactKeys(candidate, [
      "schema", "claimId", "text", "sourceBindings",
    ], "claim candidate");
    if (claim.schema !== CLAIM_SCHEMA || !Array.isArray(claim.sourceBindings) ||
        claim.sourceBindings.length === 0) fail("claim candidate invalid");
    const claimText = text(claim.text, "claim candidate");
    const bindings = claim.sourceBindings.map(validateParsedAnchor);
    const excerptHash = sha256(claimText);
    if (bindings.some((binding) => binding.endByte !== Buffer.byteLength(claimText, "utf8") ||
        binding.excerptHash !== excerptHash)) fail("claim byte anchor or excerpt hash drift");
    return {
      schema: CLAIM_SCHEMA,
      claimId: hash(claim.claimId, "claim id"),
      text: claimText,
      sourceBindings: bindings,
    };
  });
  const relationCandidates = item.relationCandidates.map((candidate) => {
    const relation = exactKeys(candidate, [
      "schema", "relationType", "targetAssetCandidateId", "reasonCode",
    ], "relation candidate");
    if (relation.schema !== RELATION_SCHEMA ||
        !RELATION_TYPES.has(relation.relationType as GovernedDocumentRelationType)) {
      fail("relation candidate invalid");
    }
    return {
      schema: RELATION_SCHEMA,
      relationType: relation.relationType as GovernedDocumentRelationType,
      targetAssetCandidateId: hash(relation.targetAssetCandidateId, "relation target candidate"),
      reasonCode: safeId(relation.reasonCode, "relation reason"),
    };
  });
  const governanceClusterId = item.governanceClusterId === null
    ? null
    : hash(item.governanceClusterId, "governance cluster");
  const body: Omit<GovernedAssetProposal, "proposalId"> = {
    schema: PROPOSAL_SCHEMA,
    assetCandidateId: hash(item.assetCandidateId, "asset candidate id"),
    sourceBatchIds: stringArray(item.sourceBatchIds, "source batch ids"),
    scopeFingerprint,
    scope: validateScope(item.scope, scopeFingerprint, "proposal"),
    semanticType,
    unitIds: stringArray(item.unitIds, "proposal unit ids", { allowEmpty: false }),
    governanceClusterId,
    titleCandidate,
    claims,
    relationCandidates,
    resourceIdentityRefs: stringArray(item.resourceIdentityRefs, "resource identity refs"),
    needsReview: item.needsReview,
    reviewReasons: stringArray(item.reviewReasons, "review reasons", { allowEmpty: !item.needsReview }),
    candidateOnly: true,
  };
  if (!body.needsReview || body.reviewReasons.length === 0 ||
      !body.reviewReasons.includes("whole_body_claim_requires_review")) {
    fail("whole-body claim review guard missing");
  }
  assertNoPrivateRefs(titleCandidate, claims);
  const proposalId = hash(item.proposalId, "proposal id");
  if (proposalId !== domainHash("mengshu.governed-asset-proposal/v1", {
    frozenHashes,
    proposal: proposalIdentityBody(body),
  })) fail("proposal id drift");
  return { ...body, proposalId };
}

function validateParsedPlan(value: unknown): GovernedAssetProposalPlan {
  const root = exactKeys(value, [
    "schema", "migrationRunId", "policyVersion", "createdAt", "frozenHashes",
    "proposals", "excludedUnits", "summary", "guards", "semanticPlanSha256",
  ], "proposal plan");
  if (root.schema !== GOVERNED_ASSET_PROPOSAL_PLAN_SCHEMA ||
      !Array.isArray(root.proposals) || !Array.isArray(root.excludedUnits)) {
    fail("proposal plan contract invalid");
  }
  const frozen = exactKeys(root.frozenHashes, [
    "typedMemoryBatchPlanFileSha256", "typedMemoryBatchPlanSemanticSha256",
    "sourceRecordSetSha256", "resourceIdentityBindingsSha256",
    "unitGovernanceOverridesSha256",
  ], "frozen hashes");
  const frozenHashes = {
    typedMemoryBatchPlanFileSha256: hash(frozen.typedMemoryBatchPlanFileSha256, "typed plan file"),
    typedMemoryBatchPlanSemanticSha256: hash(frozen.typedMemoryBatchPlanSemanticSha256, "typed plan"),
    sourceRecordSetSha256: hash(frozen.sourceRecordSetSha256, "source set"),
    resourceIdentityBindingsSha256: hash(frozen.resourceIdentityBindingsSha256, "resource bindings"),
    unitGovernanceOverridesSha256: hash(
      frozen.unitGovernanceOverridesSha256,
      "unit governance overrides",
    ),
  };
  const proposals = root.proposals.map((proposal) => validateParsedProposal(proposal, frozenHashes));
  if (new Set(proposals.map((proposal) => proposal.proposalId)).size !== proposals.length ||
      new Set(proposals.map((proposal) => proposal.assetCandidateId)).size !== proposals.length) {
    fail("proposal identity duplicated");
  }
  const excludedUnits = root.excludedUnits.map((candidate): GovernedAssetExcludedUnit => {
    const item = exactKeys(candidate, [
      "unitId", "action", "reasonCodes", "evidenceHash", "candidateOnly",
    ], "excluded unit");
    if ((item.action !== "quarantine" && item.action !== "defer") ||
        item.candidateOnly !== true) fail("excluded unit contract invalid");
    return {
      unitId: safeId(item.unitId, "excluded unit id"),
      action: item.action,
      reasonCodes: stringArray(item.reasonCodes, "excluded reason codes", { allowEmpty: false }),
      evidenceHash: hash(item.evidenceHash, "excluded evidence"),
      candidateOnly: true,
    };
  });
  if (new Set(excludedUnits.map((item) => item.unitId)).size !== excludedUnits.length) {
    fail("excluded unit duplicated");
  }
  const summaryInput = exactKeys(root.summary, [
    "eligibleUnitCount", "eligibleSourceCount", "proposalCount", "claimCount",
    "clusteredProposalCount", "needsReviewCount", "excludedUnitCount",
    "quarantinedUnitCount", "deferredUnitCount", "unitCoverage", "sourceCoverage",
  ], "summary");
  const summary = {
    eligibleUnitCount: nonNegativeInteger(summaryInput.eligibleUnitCount, "eligible unit count"),
    eligibleSourceCount: nonNegativeInteger(summaryInput.eligibleSourceCount, "eligible source count"),
    proposalCount: nonNegativeInteger(summaryInput.proposalCount, "proposal count"),
    claimCount: nonNegativeInteger(summaryInput.claimCount, "claim count"),
    clusteredProposalCount: nonNegativeInteger(summaryInput.clusteredProposalCount, "cluster count"),
    needsReviewCount: nonNegativeInteger(summaryInput.needsReviewCount, "review count"),
    excludedUnitCount: nonNegativeInteger(summaryInput.excludedUnitCount, "excluded unit count"),
    quarantinedUnitCount: nonNegativeInteger(
      summaryInput.quarantinedUnitCount,
      "quarantined unit count",
    ),
    deferredUnitCount: nonNegativeInteger(summaryInput.deferredUnitCount, "deferred unit count"),
    unitCoverage: summaryInput.unitCoverage,
    sourceCoverage: summaryInput.sourceCoverage,
  };
  const unitIds = proposals.flatMap((proposal) => proposal.unitIds);
  const sourceRefs = proposals.flatMap((proposal) => proposal.claims)
    .flatMap((claim) => claim.sourceBindings.map((binding) => binding.sourceRef));
  const allUnitIds = [...unitIds, ...excludedUnits.map((unit) => unit.unitId)];
  if (summary.unitCoverage !== 1 || summary.sourceCoverage !== 1 ||
      summary.eligibleUnitCount !== allUnitIds.length ||
      new Set(allUnitIds).size !== allUnitIds.length ||
      summary.eligibleSourceCount < sourceRefs.length || new Set(sourceRefs).size !== sourceRefs.length ||
      summary.proposalCount !== proposals.length ||
      summary.claimCount !== proposals.reduce((sum, proposal) => sum + proposal.claims.length, 0) ||
      summary.clusteredProposalCount !== proposals.filter((proposal) => proposal.governanceClusterId).length ||
      summary.needsReviewCount !== proposals.filter((proposal) => proposal.needsReview).length ||
      summary.excludedUnitCount !== excludedUnits.length ||
      summary.quarantinedUnitCount !== excludedUnits.filter((unit) =>
        unit.action === "quarantine").length ||
      summary.deferredUnitCount !== excludedUnits.filter((unit) => unit.action === "defer").length) {
    fail("summary or coverage drift");
  }
  const guards = exactKeys(root.guards, [
    "candidateOnly", "sourceTextIsAuthoritative", "p2ProposalMarkdownUsedAsContent",
    "llmEntailmentAsserted", "formalAssetsWritten", "canonicalTargetsSelected",
    "postgresTouched", "crossScopeGroupingAllowed", "crossTypeGroupingAllowed",
    "rawPrivateRefsAllowedInPublicContent",
  ], "guards");
  if (guards.candidateOnly !== true || guards.sourceTextIsAuthoritative !== true ||
      guards.p2ProposalMarkdownUsedAsContent !== false || guards.llmEntailmentAsserted !== false ||
      guards.formalAssetsWritten !== false || guards.canonicalTargetsSelected !== false ||
      guards.postgresTouched !== false || guards.crossScopeGroupingAllowed !== false ||
      guards.crossTypeGroupingAllowed !== false ||
      guards.rawPrivateRefsAllowedInPublicContent !== false) fail("guards drift");
  const body: Omit<GovernedAssetProposalPlan, "semanticPlanSha256"> = {
    schema: GOVERNED_ASSET_PROPOSAL_PLAN_SCHEMA,
    migrationRunId: safeId(root.migrationRunId, "migration run id"),
    policyVersion: policyVersion(root.policyVersion),
    createdAt: iso(root.createdAt, "createdAt"),
    frozenHashes,
    proposals,
    excludedUnits,
    summary: summary as GovernedAssetProposalPlan["summary"],
    guards: guards as unknown as GovernedAssetProposalPlan["guards"],
  };
  const semanticPlanSha256 = hash(root.semanticPlanSha256, "semantic plan");
  if (semanticPlanSha256 !== domainHash(
    "mengshu.governed-asset-proposal-plan/semantic/v1",
    planSemanticBody(body),
  )) fail("semantic plan hash drift");
  return stableValue({ ...body, semanticPlanSha256 }) as GovernedAssetProposalPlan;
}

export function serializeGovernedAssetProposalPlan(plan: GovernedAssetProposalPlan): string {
  return stableJson(validateParsedPlan(plan));
}

export function parseGovernedAssetProposalPlan(serialized: string): GovernedAssetProposalPlan {
  if (typeof serialized !== "string") fail("serialized proposal plan invalid");
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    fail("serialized proposal plan invalid");
  }
  return validateParsedPlan(value);
}
