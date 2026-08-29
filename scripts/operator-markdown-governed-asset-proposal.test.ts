import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { authorityScopeFingerprint } from
  "../packages/core/src/domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../packages/core/src/domain/types.js";
import {
  parseGovernedAssetProposalPlan,
} from "../packages/core/src/db/migrations/governed-asset-proposal.js";
import {
  serializeTypedMemoryBatchPlan,
  type TypedMemoryBatchPlan,
} from "../packages/core/src/db/migrations/typed-memory-batch-plan.js";
import {
  createMarkdownWorksetManifest,
  createMarkdownWorksetRecord,
  markdownWorksetManifestSha256,
  renderNativeRecordMarkdown,
  serializeMarkdownWorksetManifest,
} from "../packages/core/src/db/migrations/markdown-workset.js";
import {
  runGovernedAssetProposal,
} from "./operator-markdown-governed-asset-proposal.js";

const roots: string[] = [];
const CREATED_AT = "2026-08-28T12:00:00.000Z";
const SCOPE: MemoryScope = {
  tenantId: "tenant-a",
  appId: "mengshu",
  userId: "user-a",
  projectId: "project-a",
  agentId: "codex",
  namespace: "memory",
  visibility: "private",
};
const SCOPE_FINGERPRINT = authorityScopeFingerprint(SCOPE);

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stable(item)]));
  }
  return value;
}

function domainHash(domain: string, value: unknown): string {
  return createHash("sha256").update(domain).update("\0")
    .update(JSON.stringify(stable(value))).digest("hex");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mengshu-p5-proposal-"));
  roots.push(root);
  const sourceDirectory = join(root, "source");
  const sourceRecords = [
    createMarkdownWorksetRecord({
      phase: "source",
      scopeFingerprint: SCOPE_FINGERPRINT,
      record: {
        id: "rules-sensitive",
        sourceTable: "memories",
        text: "private-value-must-not-appear",
        contentHash: hash("rules-sensitive-content"),
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
    }),
    createMarkdownWorksetRecord({
      phase: "source",
      scopeFingerprint: SCOPE_FINGERPRINT,
      record: {
        id: "resource-unlinked",
        sourceTable: "memories",
        text: "Resource without same-scope Knowledge evidence",
        contentHash: hash("resource-content"),
        vector: [0.2],
        importance: 0.8,
        category: "resource",
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
    }),
  ];
  const sourceFiles = sourceRecords.map((record, index) => ({
    relativePath: `source/memories/0${index}/${record.record.id}.md`,
    markdown: renderNativeRecordMarkdown(record),
  }));
  for (const file of sourceFiles) {
    const path = join(sourceDirectory, file.relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.markdown);
  }
  const sourceManifest = createMarkdownWorksetManifest({
    migrationRunId: "p5-fixture",
    phase: "source",
    policyVersion: "markdown-export/v1",
    createdAt: CREATED_AT,
    files: sourceFiles,
  });
  const sourceManifestText = serializeMarkdownWorksetManifest(sourceManifest);
  const sourceManifestPath = join(sourceDirectory, "manifest.json");
  await writeFile(sourceManifestPath, sourceManifestText);

  const knowledgeText = `${JSON.stringify({
    schema: "fixture",
    scopeFingerprint: hash("other-scope"),
    resourceIdentity: "resource_fixture",
    sources: [{ sourceRef: "knowledge:fixture", sourceHash: hash("knowledge") }],
  })}\n`;
  const knowledgePath = join(root, "knowledge-bindings.jsonl");
  await writeFile(knowledgePath, knowledgeText);
  const knowledgeHash = hash(knowledgeText);

  const eligibleUnits = sourceRecords.map((record, index) => ({
    schema: "mengshu.typed-memory-eligible-unit/v1" as const,
    unitId: hash(`unit-${index}`),
    origin: "typed_plan" as const,
    sourcePlanSequence: 35 + index,
    scopeFingerprint: SCOPE_FINGERPRINT,
    scope: SCOPE,
    semanticType: index === 0 ? "rules" as const : "resource" as const,
    disposition: "merge_exact" as const,
    sources: [{ sourceRef: record.sourceRef, sourceHash: record.sourceHash }],
    sourceCount: 1,
    bytes: Buffer.byteLength(record.record.text, "utf8"),
    governanceClusterId: null,
    reasonCodes: ["fixture"],
    candidateOnly: true as const,
  }));
  const frozenHashes = {
    memoryPlanFileSha256: hash("memory-plan-file"),
    memoryPlanSemanticSha256: hash("memory-plan-semantic"),
    unitResolutionsFileSha256: hash("unit-resolution-file"),
    unitResolutionsSemanticSha256: hash("unit-resolution-semantic"),
    mergeSemanticClusterBindingsFileSha256: hash("cluster-file"),
    mergeSemanticClusterBindingsSemanticSha256: hash("cluster-semantic"),
    knowledgeResourceBindingsFileSha256: knowledgeHash,
    scopeRegistryFileSha256: hash("scope-file"),
    scopeRegistrySha256: hash("scope-semantic"),
  };
  const body = {
    schema: "mengshu.typed-memory-batch-plan/v1" as const,
    migrationRunId: "p5-fixture",
    policyVersion: "typed-memory-batch-plan/v1",
    createdAt: CREATED_AT,
    frozenHashes,
    expectedMemorySourceCount: 2,
    expectedMemoryUnitCount: 2,
    maxUnitsPerBatch: 30 as const,
    maxBytesPerBatch: 400000 as const,
    eligibleUnits,
    excludedResolutions: [],
    batches: eligibleUnits.map((unit, index) => ({
      schema: "mengshu.typed-memory-governance-batch/v1" as const,
      batchId: hash(`batch-${index}`),
      sequence: index + 1,
      scopeFingerprint: SCOPE_FINGERPRINT,
      scope: SCOPE,
      semanticType: unit.semanticType,
      unitIds: [unit.unitId],
      governanceClusterIds: [],
      sourceCount: 1,
      bytes: unit.bytes,
      candidateOnly: true as const,
    })),
    summary: {
      sourceCount: 2,
      unitCount: 2,
      eligibleUnits: 2,
      eligibleSources: 2,
      excludedUnits: 0,
      excludedSources: 0,
      batchCount: 2,
      mergeSemanticClusters: 0,
      sourceCoverage: 1 as const,
      unitCoverage: 1 as const,
      excludedByDisposition: { supersede: 0, archive_stale: 0, lookup_only: 0, quarantine: 0 },
      eligibleBySemanticType: {
        profile: 0, rules: 1, task_context: 0, experience: 0, resource: 1,
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
  const typedPlan: TypedMemoryBatchPlan = {
    ...body,
    semanticPlanSha256: domainHash(
      "mengshu.typed-memory-batch-plan/semantic/v1",
      semanticBody,
    ),
  };
  const typedPlanText = serializeTypedMemoryBatchPlan(typedPlan);
  const typedPlanPath = join(root, "typed-plan.json");
  await writeFile(typedPlanPath, typedPlanText);
  const typedPlanHash = hash(typedPlanText);

  const resourceReviewText = `${JSON.stringify({
    schema: "mengshu.resource-linkage-review-draft/v1",
    unitId: eligibleUnits[1]!.unitId,
    scopeFingerprint: SCOPE_FINGERPRINT,
    verdict: "no_link",
    resourceIdentityRefs: [],
    evidenceSources: eligibleUnits[1]!.sources,
    confidence: 1,
    reasonCodes: ["no_same_scope_knowledge_binding"],
    notes: ["fixture"],
    candidateOnly: true,
  })}\n`;
  const resourceReviewPath = join(root, "resource-review.jsonl");
  await writeFile(resourceReviewPath, resourceReviewText);

  const securityText = `${JSON.stringify({
    schema: "mengshu.p5-security-unit-decisions/v1",
    typedMemoryBatchPlanFileSha256: typedPlanHash,
    scannerPolicyVersion: "p5-sensitive-patterns/v1",
    createdAt: CREATED_AT,
    decisions: [{
      unitId: eligibleUnits[0]!.unitId,
      action: "quarantine",
      reasonCodes: ["potential_credential_pattern"],
      evidenceHash: hash("security-evidence"),
      candidateOnly: false,
    }],
    guards: {
      sensitiveValueStored: false,
      publicProposalAllowed: false,
      postgresTouched: false,
    },
  }, null, 2)}\n`;
  const securityPath = join(root, "security.json");
  await writeFile(securityPath, securityText);

  return {
    root,
    sensitiveText: sourceRecords[0]!.record.text,
    input: {
      containmentRoot: root,
      typedMemoryBatchPlanPath: typedPlanPath,
      typedMemoryBatchPlanFileSha256: typedPlanHash,
      sourceManifestPath,
      sourceManifestFileSha256: markdownWorksetManifestSha256(sourceManifestText),
      knowledgeResourceBindingsPath: knowledgePath,
      knowledgeResourceBindingsFileSha256: knowledgeHash,
      resourceLinkageReviewPath: resourceReviewPath,
      resourceLinkageReviewFileSha256: hash(resourceReviewText),
      securityDecisionsPath: securityPath,
      securityDecisionsFileSha256: hash(securityText),
      outputPath: join(root, "proposal-plan.json"),
      createdAt: CREATED_AT,
    },
  };
}

describe("governed asset proposal operator", () => {
  it("将无链接 resource defer、安全命中 quarantine，且不泄漏被排除正文", async () => {
    const value = await fixture();
    const result = await runGovernedAssetProposal(value.input);
    const serialized = await readFile(value.input.outputPath, "utf8");
    const plan = parseGovernedAssetProposalPlan(serialized);

    expect(result).toMatchObject({
      eligibleUnits: 2,
      proposals: 0,
      quarantinedUnits: 1,
      deferredUnits: 1,
      sourceCoverage: 1,
      unitCoverage: 1,
    });
    expect(plan.excludedUnits.map((unit) => unit.action).sort()).toEqual(["defer", "quarantine"]);
    expect(serialized).not.toContain(value.sensitiveText);
    expect(serialized).not.toContain("memories:rules-sensitive");
  });

  it("拒绝覆盖既有输出和 resource review 文件 hash 漂移", async () => {
    const value = await fixture();
    await writeFile(value.input.outputPath, "reserved");
    await expect(runGovernedAssetProposal(value.input)).rejects.toMatchObject({
      code: "GOVERNED_ASSET_PROPOSAL_OPERATOR_OUTPUT_EXISTS",
    });

    const drift = await fixture();
    await expect(runGovernedAssetProposal({
      ...drift.input,
      resourceLinkageReviewFileSha256: hash("drift"),
    })).rejects.toMatchObject({ code: "GOVERNED_ASSET_PROPOSAL_OPERATOR_INPUT_DRIFT" });
  });
});
