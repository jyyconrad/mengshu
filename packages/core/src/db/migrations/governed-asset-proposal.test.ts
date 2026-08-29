import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { authorityScopeFingerprint } from "../../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../../domain/types.js";
import {
  createMarkdownWorksetRecord,
  type MarkdownWorksetRecord,
} from "./markdown-workset.js";
import type { TypedMemoryBatchPlan } from "./typed-memory-batch-plan.js";
import {
  parseGovernedAssetProposalPlan,
  planGovernedAssetProposals,
  serializeGovernedAssetProposalPlan,
} from "./governed-asset-proposal.js";

const HASH = "a".repeat(64);
const CREATED_AT = "2026-08-28T00:00:00.000Z";
const SCOPE: MemoryScope = {
  tenantId: "tenant",
  appId: "mengshu",
  userId: "user",
  projectId: "project",
  agentId: "codex",
  namespace: "memory",
  visibility: "private",
};
const SCOPE_FINGERPRINT = authorityScopeFingerprint(SCOPE);

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function domainHash(domain: string, value: unknown): string {
  return createHash("sha256").update(domain).update("\0").update(stableJson(value)).digest("hex");
}

function source(id: string, text: string): MarkdownWorksetRecord {
  return createMarkdownWorksetRecord({
    phase: "source",
    scopeFingerprint: SCOPE_FINGERPRINT,
    record: {
      id,
      sourceTable: "memories",
      text,
      contentHash: createHash("sha256").update(text).digest("hex"),
      vector: [0.1],
      importance: 0.8,
      category: "rules",
      dataType: "text",
      metadata: {},
      createdAt: CREATED_AT,
      tenantId: SCOPE.tenantId,
      productId: SCOPE.appId,
      userId: SCOPE.userId,
      canonicalProjectId: SCOPE.projectId,
      producerId: SCOPE.agentId,
      namespace: SCOPE.namespace,
      visibility: SCOPE.visibility,
    },
  });
}

function typedPlan(
  records: readonly MarkdownWorksetRecord[],
  options: {
    readonly clustered?: boolean;
    readonly firstType?: "rules" | "experience" | "resource";
    readonly secondType?: "rules" | "experience" | "resource";
    readonly singleExactUnit?: boolean;
  } = {},
): TypedMemoryBatchPlan {
  const unitRecords = (options.singleExactUnit ? [records[0]!] : records).map((record, index) => ({
    schema: "mengshu.typed-memory-eligible-unit/v1" as const,
    unitId: `unit-${index + 1}`,
    origin: "typed_plan" as const,
    sourcePlanSequence: 35 + index,
    scopeFingerprint: SCOPE_FINGERPRINT,
    scope: SCOPE,
    semanticType: index === 1
      ? options.secondType ?? options.firstType ?? "rules"
      : options.firstType ?? "rules",
    disposition: options.clustered ? "merge_semantic" as const : "merge_exact" as const,
    sources: (options.singleExactUnit ? records : [record]).map((sourceRecord) => ({
      sourceRef: sourceRecord.sourceRef,
      sourceHash: sourceRecord.sourceHash,
    })),
    sourceCount: options.singleExactUnit ? records.length : 1,
    bytes: (options.singleExactUnit ? records : [record]).reduce(
      (sum, sourceRecord) => sum + Buffer.byteLength(sourceRecord.record.text, "utf8"),
      0,
    ),
    governanceClusterId: options.clustered ? "b".repeat(64) : null,
    reasonCodes: ["fixture"],
    candidateOnly: true as const,
  }));
  const batches = unitRecords.map((unit, index) => ({
    schema: "mengshu.typed-memory-governance-batch/v1" as const,
    batchId: `batch-${index + 1}`,
    sequence: index + 1,
    scopeFingerprint: unit.scopeFingerprint,
    scope: unit.scope,
    semanticType: unit.semanticType,
    unitIds: [unit.unitId],
    governanceClusterIds: unit.governanceClusterId ? [unit.governanceClusterId] : [],
    sourceCount: unit.sourceCount,
    bytes: unit.bytes,
    candidateOnly: true as const,
  }));
  const frozenHashes = {
    memoryPlanFileSha256: HASH,
    memoryPlanSemanticSha256: HASH,
    unitResolutionsFileSha256: HASH,
    unitResolutionsSemanticSha256: HASH,
    mergeSemanticClusterBindingsFileSha256: HASH,
    mergeSemanticClusterBindingsSemanticSha256: HASH,
    knowledgeResourceBindingsFileSha256: HASH,
    scopeRegistryFileSha256: HASH,
    scopeRegistrySha256: HASH,
  };
  const body = {
    schema: "mengshu.typed-memory-batch-plan/v1" as const,
    migrationRunId: "run-1",
    policyVersion: "typed-memory-batch-plan/v1",
    createdAt: CREATED_AT,
    frozenHashes,
    expectedMemorySourceCount: records.length,
    expectedMemoryUnitCount: unitRecords.length,
    maxUnitsPerBatch: 30 as const,
    maxBytesPerBatch: 400000 as const,
    eligibleUnits: unitRecords,
    excludedResolutions: [],
    batches,
    summary: {
      sourceCount: records.length,
      unitCount: unitRecords.length,
      eligibleUnits: unitRecords.length,
      eligibleSources: records.length,
      excludedUnits: 0,
      excludedSources: 0,
      batchCount: unitRecords.length,
      mergeSemanticClusters: options.clustered ? 1 : 0,
      sourceCoverage: 1 as const,
      unitCoverage: 1 as const,
      excludedByDisposition: { supersede: 0, archive_stale: 0, lookup_only: 0, quarantine: 0 },
      eligibleBySemanticType: {
        profile: 0,
        rules: unitRecords.filter((unit) => unit.semanticType === "rules").length,
        task_context: 0,
        experience: unitRecords.filter((unit) => unit.semanticType === "experience").length,
        resource: unitRecords.filter((unit) => unit.semanticType === "resource").length,
      },
    },
    guards: {
      candidateOnly: true as const,
      canonicalTargetsSelected: false as const,
      formalAssetsWritten: false as const,
      treeArtifactsWritten: false as const,
      postgresTouched: false as const,
      knowledgePrivateBindingsAreInputsOnly: true as const,
      crossScopeBatchingAllowed: false as const,
      crossTypeBatchingAllowed: false as const,
    },
  };
  const { createdAt: ignored, ...semanticBody } = body;
  return {
    ...body,
    semanticPlanSha256: domainHash(
      "mengshu.typed-memory-batch-plan/semantic/v1",
      semanticBody,
    ),
  };
}

function plan(records: readonly MarkdownWorksetRecord[], typed = typedPlan(records)) {
  return planGovernedAssetProposals({
    createdAt: CREATED_AT,
    typedMemoryBatchPlanFileSha256: HASH,
    typedMemoryBatchPlan: typed,
    sourceRecords: records,
    resourceIdentityBindings: [],
    unitGovernanceOverrides: [],
  });
}

describe("governed asset proposal planner", () => {
  it("uses source record text and exact UTF-8 byte anchors for exact units", () => {
    const first = source("1", "# Vault rules\nAlways verify receipts.");
    const second = source("2", first.record.text);
    const result = plan([first, second]);

    expect(result.proposals).toHaveLength(2);
    const firstProposal = result.proposals.find((proposal) => proposal.unitIds.includes("unit-1"))!;
    expect(firstProposal).toMatchObject({
      semanticType: "rules",
      titleCandidate: "Vault rules",
      needsReview: true,
      candidateOnly: true,
    });
    expect(firstProposal.claims[0]).toMatchObject({
      text: first.record.text,
      sourceBindings: [{
        sourceRef: first.sourceRef,
        sourceHash: first.sourceHash,
        startByte: 0,
        endByte: Buffer.byteLength(first.record.text, "utf8"),
        excerptHash: createHash("sha256").update(first.record.text).digest("hex"),
      }],
    });
    expect(result.guards).toMatchObject({ formalAssetsWritten: false, postgresTouched: false });
    expect(parseGovernedAssetProposalPlan(serializeGovernedAssetProposalPlan(result)))
      .toEqual(result);
  });

  it("collapses exact-duplicate sources in one unit into one claim with all bindings", () => {
    const records = ["1", "2", "3"].map((id) => source(id, "# Shared rule\nVerify once."));
    const result = plan(records, typedPlan(records, { singleExactUnit: true }));

    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]!.claims).toHaveLength(1);
    expect(result.proposals[0]!.claims[0]!.sourceBindings.map((binding) => binding.sourceRef))
      .toEqual(["memories:1", "memories:2", "memories:3"]);
  });

  it("keeps an explicit semantic governance cluster atomic", () => {
    const records = [source("1", "# Rule A\nA"), source("2", "# Rule B\nB")];
    const result = plan(records, typedPlan(records, { clustered: true }));

    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]!.unitIds).toEqual(["unit-1", "unit-2"]);
    expect(result.proposals[0]!.governanceClusterId).toBe("b".repeat(64));
    expect(result.proposals[0]!.claims).toHaveLength(2);
    expect(result.proposals[0]!.reviewReasons)
      .toContain("semantic_cluster_requires_entailment_review");
  });

  it("rejects a governance cluster that crosses semantic types", () => {
    const records = [source("1", "Rule A"), source("2", "Rule B")];
    expect(() => plan(records, typedPlan(records, {
      clustered: true,
      secondType: "experience",
    }))).toThrow(/scope or semantic type/i);
  });

  it("rejects missing or hash-drifted source records", () => {
    const record = source("1", "Rule A");
    expect(() => planGovernedAssetProposals({
      createdAt: CREATED_AT,
      typedMemoryBatchPlanFileSha256: HASH,
      typedMemoryBatchPlan: typedPlan([record]),
      sourceRecords: [],
      resourceIdentityBindings: [],
      unitGovernanceOverrides: [],
    })).toThrow(/source coverage/i);

    const replacement = source("1", "Rule B");
    expect(() => plan([replacement], typedPlan([record]))).toThrow(/source hash/i);
  });

  it("keeps resource identity references outside public candidate content", () => {
    const record = source("1", "# API guide\nUse the stable client.");
    const result = planGovernedAssetProposals({
      createdAt: CREATED_AT,
      typedMemoryBatchPlanFileSha256: HASH,
      typedMemoryBatchPlan: typedPlan([record], { firstType: "resource" }),
      sourceRecords: [record],
      resourceIdentityBindings: [{
        memoryUnitId: "unit-1",
        scopeFingerprint: SCOPE_FINGERPRINT,
        resourceIdentityRef: "resource:api-guide",
        evidenceSources: [{ sourceRef: "knowledge:42", sourceHash: HASH }],
      }],
      unitGovernanceOverrides: [],
    });
    expect(result.proposals[0]!.resourceIdentityRefs).toEqual(["resource:api-guide"]);
    expect(JSON.stringify({
      title: result.proposals[0]!.titleCandidate,
      claims: result.proposals[0]!.claims.map((claim) => claim.text),
    })).not.toContain("resource:api-guide");
  });

  it("requires unbound resource units to defer and never emits overridden source text", () => {
    const sensitiveText = "# Private configuration\ncredential-pattern-value";
    const record = source("1", sensitiveText);
    const resourcePlan = typedPlan([record], { firstType: "resource" });
    expect(() => planGovernedAssetProposals({
      createdAt: CREATED_AT,
      typedMemoryBatchPlanFileSha256: HASH,
      typedMemoryBatchPlan: resourcePlan,
      sourceRecords: [record],
      resourceIdentityBindings: [],
      unitGovernanceOverrides: [],
    })).toThrow(/requires explicit defer override/i);

    const result = planGovernedAssetProposals({
      createdAt: CREATED_AT,
      typedMemoryBatchPlanFileSha256: HASH,
      typedMemoryBatchPlan: resourcePlan,
      sourceRecords: [record],
      resourceIdentityBindings: [],
      unitGovernanceOverrides: [{
        unitId: "unit-1",
        action: "quarantine",
        reasonCodes: ["potential_credential_pattern"],
        evidenceHash: HASH,
        candidateOnly: false,
      }],
    });
    expect(result.proposals).toEqual([]);
    expect(result.excludedUnits).toEqual([{
      unitId: "unit-1",
      action: "quarantine",
      reasonCodes: ["potential_credential_pattern"],
      evidenceHash: HASH,
      candidateOnly: true,
    }]);
    expect(JSON.stringify(result)).not.toContain(sensitiveText);
    expect(parseGovernedAssetProposalPlan(serializeGovernedAssetProposalPlan(result)))
      .toEqual(result);
  });

  it("rejects placeholder titles and raw source references in public content", () => {
    const record = source("1", "Rule A");
    const result = plan([record]);
    expect(() => parseGovernedAssetProposalPlan(JSON.stringify({
      ...result,
      proposals: [{ ...result.proposals[0], titleCandidate: "Untitled" }],
    }))).toThrow(/placeholder title/i);

    const leaked = source("2", "# Leak\nRead memories:2 for details.");
    expect(() => plan([leaked])).toThrow(/private source reference/i);
  });

  it("rejects unknown formal-asset fields in the candidate artifact", () => {
    const result = plan([source("1", "Rule A")]);
    expect(() => parseGovernedAssetProposalPlan(JSON.stringify({
      ...result,
      assetVersion: 1,
    }))).toThrow(/unknown or missing key/i);
  });
});
