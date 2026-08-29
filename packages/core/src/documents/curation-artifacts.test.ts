import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../domain/types.js";
import type { MemoryCurationBatchPlan } from "../db/migrations/markdown-curation-batch-planner.js";
import {
  computeGovernanceProjectionHash,
  computePublicContentHash,
} from "./canonical.js";
import type { GovernedDocumentAssetVersion } from "./types.js";
import {
  CURATION_ARTIFACT_BUNDLE_SCHEMA,
  CURATION_BATCH_RECEIPT_SCHEMA,
  CURATION_DOCUMENT_PROPOSAL_REF_SCHEMA,
  CURATION_RELATION_PROPOSAL_SCHEMA,
  CURATION_REVIEW_VERDICT_SCHEMA,
  CURATION_UNIT_DECISION_SCHEMA,
  GOVERNED_ASSET_CATALOG_SCHEMA,
  GOVERNED_CANONICAL_MANIFEST_SCHEMA,
  GOVERNED_INDEX_MANIFEST_SCHEMA,
  computeCurationArtifactListHash,
  createGovernedAssetCatalog,
  createGovernedCanonicalManifest,
  createGovernedIndexManifest,
  governedAssetCatalogSha256,
  governedCanonicalManifestSha256,
  governedIndexManifestSha256,
  parseGovernedAssetCatalog,
  parseGovernedCanonicalManifest,
  parseGovernedIndexManifest,
  serializeGovernedAssetCatalog,
  serializeGovernedCanonicalManifest,
  serializeGovernedIndexManifest,
  validateCurationArtifactBundle,
  type CurationArtifactBundle,
  type SourceBinding,
} from "./curation-artifacts.js";

const SCOPE = "a".repeat(64);
const OTHER_SCOPE = "b".repeat(64);
const HASH = (value: string): string => createHash("sha256").update(value).digest("hex");

const SOURCES: readonly SourceBinding[] = Object.freeze([
  Object.freeze({ sourceRef: "memories:a", sourceHash: HASH("source-a") }),
  Object.freeze({ sourceRef: "memories:z", sourceHash: HASH("source-z") }),
]);

function plan(): MemoryCurationBatchPlan {
  return {
    schema: "mengshu.memory-curation-batch-plan/v1",
    migrationRunId: "run_1",
    sourceSnapshotSha256: HASH("snapshot"),
    sourceManifestSha256: HASH("source-manifest"),
    preprocessedManifestSha256: HASH("preprocessed-manifest"),
    inventorySha256: HASH("inventory"),
    policyVersion: "curation/v1",
    createdAt: "2026-08-28T08:00:00.000Z",
    maxUnitsPerBatch: 10,
    maxBytesPerBatch: 10_000,
    units: [
      {
        unitId: "unit_a",
        cohort: "experience",
        scopeFingerprint: SCOPE,
        sourceRefs: [SOURCES[0]!.sourceRef],
        sourceHashes: [SOURCES[0]!.sourceHash],
        candidateTypes: ["experience"],
        qualityFlags: [],
        files: [{
          ...SOURCES[0]!, relativePath: "a.md", markdownSha256: HASH("a.md"), bytes: 100,
        }],
        sourceCount: 1,
        bytes: 100,
      },
      {
        unitId: "unit_z",
        cohort: "experience",
        scopeFingerprint: SCOPE,
        sourceRefs: [SOURCES[1]!.sourceRef],
        sourceHashes: [SOURCES[1]!.sourceHash],
        candidateTypes: ["experience"],
        qualityFlags: [],
        files: [{
          ...SOURCES[1]!, relativePath: "z.md", markdownSha256: HASH("z.md"), bytes: 100,
        }],
        sourceCount: 1,
        bytes: 100,
      },
    ],
    batches: [{
      batchId: "batch_1",
      sequence: 1,
      cohort: "experience",
      mode: "memory_document_proposal",
      scopeFingerprint: SCOPE,
      unitIds: ["unit_a", "unit_z"],
      sourceCount: 2,
      bytes: 200,
    }],
    summary: {
      sourceCount: 2,
      unitCount: 2,
      batchCount: 1,
      byCohort: { experience: { units: 2, sources: 2 } },
    },
    guards: [
      "agent_output_is_proposal_not_disposition",
      "postgres_activation_is_forbidden_during_curation",
    ],
    planSha256: HASH("plan"),
  };
}

function bundle(): CurationArtifactBundle {
  const unitDecisions = [
    {
      schema: CURATION_UNIT_DECISION_SCHEMA,
      unitId: "unit_a",
      scopeFingerprint: SCOPE,
      sources: [SOURCES[0]],
      proposedSemanticType: "experience" as const,
      disposition: "propose_asset" as const,
      documentProposalIds: ["proposal_a"],
      reasonCodes: ["grounded"],
      candidateOnly: true as const,
    },
    {
      schema: CURATION_UNIT_DECISION_SCHEMA,
      unitId: "unit_z",
      scopeFingerprint: SCOPE,
      sources: [SOURCES[1]],
      proposedSemanticType: "experience" as const,
      disposition: "propose_asset" as const,
      documentProposalIds: ["proposal_z"],
      reasonCodes: ["grounded"],
      candidateOnly: true as const,
    },
  ];
  const documentProposals = [
    {
      schema: CURATION_DOCUMENT_PROPOSAL_REF_SCHEMA,
      proposalId: "proposal_a",
      unitIds: ["unit_a"],
      scopeFingerprint: SCOPE,
      semanticType: "experience" as const,
      relativePath: "document-proposals/proposal-a.md",
      markdownSha256: HASH("proposal-a"),
      sources: [SOURCES[0]],
      candidateOnly: true as const,
    },
    {
      schema: CURATION_DOCUMENT_PROPOSAL_REF_SCHEMA,
      proposalId: "proposal_z",
      unitIds: ["unit_z"],
      scopeFingerprint: SCOPE,
      semanticType: "experience" as const,
      relativePath: "document-proposals/proposal-z.md",
      markdownSha256: HASH("proposal-z"),
      sources: [SOURCES[1]],
      candidateOnly: true as const,
    },
  ];
  const relationProposals = [{
    schema: CURATION_RELATION_PROPOSAL_SCHEMA,
    relationId: "relation_a_z",
    sourceProposalId: "proposal_a",
    relationType: "related" as const,
    targetRef: "proposal_z",
    sourceScopeFingerprint: SCOPE,
    targetScopeFingerprint: SCOPE,
    sources: [SOURCES[0]],
    evidenceRefs: [],
    routeReceiptHash: null,
    candidateOnly: true as const,
  }];
  const reviewVerdicts = [{
    schema: CURATION_REVIEW_VERDICT_SCHEMA,
    verdictId: "verdict_a",
    proposalId: "proposal_a",
    reviewedArtifactHash: HASH("proposal-a"),
    reviewer: "agent" as const,
    verdict: "accept" as const,
    reasonCodes: ["faithful"],
    createdAt: "2026-08-28T09:00:00.000Z",
    candidateOnly: true as const,
  }];
  return {
    schema: CURATION_ARTIFACT_BUNDLE_SCHEMA,
    receipt: {
      schema: CURATION_BATCH_RECEIPT_SCHEMA,
      batchId: "batch_1",
      planSha256: plan().planSha256,
      sourceSnapshotSha256: plan().sourceSnapshotSha256,
      sourceManifestSha256: plan().sourceManifestSha256,
      preprocessedManifestSha256: plan().preprocessedManifestSha256,
      inventorySha256: plan().inventorySha256,
      unitCount: 2,
      sourceCount: 2,
      sectionHashes: {
        unitDecisions: computeCurationArtifactListHash("unit-decisions", unitDecisions),
        documentProposals: computeCurationArtifactListHash("document-proposals", documentProposals),
        relationProposals: computeCurationArtifactListHash("relation-proposals", relationProposals),
        reviewVerdicts: computeCurationArtifactListHash("review-verdicts", reviewVerdicts),
      },
      candidateOnly: true,
      canonicalTargetsSelected: false,
      formalAssetsWritten: false,
      treeArtifactsWritten: false,
      postgresTouched: false,
      createdAt: "2026-08-28T09:00:00.000Z",
    },
    unitDecisions,
    documentProposals,
    relationProposals,
    reviewVerdicts,
  };
}

describe("P1 curation artifact bundle", () => {
  test("严格校验五件套、冻结 hash、batch/unit/source coverage 和显式 source binding", () => {
    const validated = validateCurationArtifactBundle(bundle(), { plan: plan(), batchId: "batch_1" });
    expect(validated.unitDecisions.flatMap((item) => item.sources)).toEqual(SOURCES);
    expect(validated.receipt).toMatchObject({
      candidateOnly: true,
      canonicalTargetsSelected: false,
      formalAssetsWritten: false,
      treeArtifactsWritten: false,
      postgresTouched: false,
      unitCount: 2,
      sourceCount: 2,
    });
  });

  test("拒绝未知 key、proxy 和 section hash 漂移", () => {
    const unknown = structuredClone(bundle()) as CurationArtifactBundle & { injected?: boolean };
    unknown.injected = true;
    expect(() => validateCurationArtifactBundle(unknown, { plan: plan(), batchId: "batch_1" }))
      .toThrow(/shape|key/i);
    const proxied = new Proxy(structuredClone(bundle()), {});
    expect(() => validateCurationArtifactBundle(proxied, { plan: plan(), batchId: "batch_1" }))
      .toThrow(/shape|proxy/i);
    const drifted = structuredClone(bundle()) as any;
    drifted.receipt.sectionHashes.unitDecisions = HASH("drift");
    expect(() => validateCurationArtifactBundle(drifted, { plan: plan(), batchId: "batch_1" }))
      .toThrow(/hash/i);
  });

  test("拒绝 source pair 漂移、重复与遗漏 source/unit", () => {
    const pairDrift = structuredClone(bundle()) as any;
    pairDrift.unitDecisions[0]!.sources[0] = {
      ...pairDrift.unitDecisions[0]!.sources[0],
      sourceHash: SOURCES[1]!.sourceHash,
    };
    pairDrift.receipt.sectionHashes.unitDecisions = computeCurationArtifactListHash(
      "unit-decisions", pairDrift.unitDecisions,
    );
    expect(pairDrift.receipt.sectionHashes.unitDecisions).toBe(computeCurationArtifactListHash(
      "unit-decisions", pairDrift.unitDecisions,
    ));
    expect(() => validateCurationArtifactBundle(pairDrift, { plan: plan(), batchId: "batch_1" }))
      .toThrow(/source|coverage|binding/i);

    const missingScope = structuredClone(bundle()) as any;
    missingScope.unitDecisions[0]!.scopeFingerprint = null;
    missingScope.receipt.sectionHashes.unitDecisions = computeCurationArtifactListHash(
      "unit-decisions", missingScope.unitDecisions,
    );
    expect(() => validateCurationArtifactBundle(missingScope, { plan: plan(), batchId: "batch_1" }))
      .toThrow(/only excluded|scope/i);

    const missing = structuredClone(bundle()) as any;
    missing.unitDecisions.pop();
    missing.receipt.unitCount = 1;
    missing.receipt.sourceCount = 1;
    missing.receipt.sectionHashes.unitDecisions = computeCurationArtifactListHash(
      "unit-decisions", missing.unitDecisions,
    );
    expect(() => validateCurationArtifactBundle(missing, { plan: plan(), batchId: "batch_1" }))
      .toThrow(/unit|coverage/i);

    const planDrift = structuredClone(plan()) as any;
    planDrift.units[0]!.sourceHashes[0] = SOURCES[1]!.sourceHash;
    expect(() => validateCurationArtifactBundle(bundle(), {
      plan: planDrift,
      batchId: "batch_1",
    })).toThrow(/plan.*source.*binding|drift/i);
  });

  test("拒绝 cross-scope、非法关系以及缺少强关系证据", () => {
    const crossScope = structuredClone(bundle()) as any;
    crossScope.relationProposals[0]!.targetScopeFingerprint = OTHER_SCOPE;
    crossScope.receipt.sectionHashes.relationProposals = computeCurationArtifactListHash(
      "relation-proposals", crossScope.relationProposals,
    );
    expect(() => validateCurationArtifactBundle(crossScope, { plan: plan(), batchId: "batch_1" }))
      .toThrow(/scope/i);

    const illegal = structuredClone(bundle()) as any;
    (illegal.relationProposals[0] as { relationType: string }).relationType = "similar_to";
    illegal.receipt.sectionHashes.relationProposals = computeCurationArtifactListHash(
      "relation-proposals", illegal.relationProposals,
    );
    expect(() => validateCurationArtifactBundle(illegal, { plan: plan(), batchId: "batch_1" }))
      .toThrow(/relation/i);

    const ungrounded = structuredClone(bundle()) as any;
    ungrounded.relationProposals[0]!.relationType = "derived_from";
    ungrounded.receipt.sectionHashes.relationProposals = computeCurationArtifactListHash(
      "relation-proposals", ungrounded.relationProposals,
    );
    expect(() => validateCurationArtifactBundle(ungrounded, { plan: plan(), batchId: "batch_1" }))
      .toThrow(/evidence/i);
  });

  test.each([
    ["candidateOnly", false],
    ["canonicalTargetsSelected", true],
    ["formalAssetsWritten", true],
    ["treeArtifactsWritten", true],
    ["postgresTouched", true],
  ] as const)("proposal-only guard %s=%s 时拒绝", (key, value) => {
    const guarded = structuredClone(bundle()) as any;
    guarded.receipt[key] = value as never;
    expect(() => validateCurationArtifactBundle(guarded, { plan: plan(), batchId: "batch_1" }))
      .toThrow(/proposal|formal|postgres|guard/i);
  });
});

const scope: MemoryScope = {
  tenantId: "local",
  userId: "u1",
  appId: "codex",
  projectId: "memory-autodb",
  agentId: "root",
  namespace: "memories",
  visibility: "private",
};

function governedAsset(): GovernedDocumentAssetVersion {
  const content = {
    title: "Markdown governance",
    sections: [{
      id: "section_contract",
      heading: "Contract",
      claims: [{ id: "claim_guard", text: "候选产物不能直接成为正式资产。" }],
    }],
    userNotes: "",
    topics: ["markdown-governance"],
    relatedAssetIds: [],
    sourceAssetIds: SOURCES.map((item) => item.sourceRef),
    aliases: [],
    tags: ["mengshu/experience"],
  };
  const publicContentHash = computePublicContentHash(content);
  const scopeFingerprint = authorityScopeFingerprint(scope);
  const governanceProjectionHash = computeGovernanceProjectionHash({
    assetId: "doc_governance",
    assetVersion: 1,
    claimEvidence: { claim_guard: ["evidence_1"] },
    provenanceRefs: SOURCES.map((item) => item.sourceRef),
    relationRefs: [],
    sourceDispositionRefs: ["disposition_a", "disposition_z"],
    resolutionHash: HASH("resolution"),
    policyVersion: "governed-document/v1",
  });
  return {
    assetId: "doc_governance",
    assetVersion: 1,
    schemaVersion: 1,
    kind: "memory_document",
    purpose: "typed_memory",
    semanticType: "experience",
    title: content.title,
    lifecycleState: "active",
    governanceState: "current",
    scope,
    scopeFingerprint,
    governanceDescription: {
      assetId: "doc_governance",
      assetVersion: 1,
      kind: "memory_document",
      purpose: "typed_memory",
      semanticType: "experience",
      scopeFingerprint,
      lifecycleState: "active",
      governanceState: "current",
      complexityClass: "simple",
      title: content.title,
      sectionIndex: [{ sectionId: "section_contract", heading: "Contract", brief: "治理合同" }],
      claimEvidenceCoverage: 1,
      sourceDispositionCoverage: 1,
      conflictCount: 0,
      staleReasons: [],
      publicContentHash,
      governanceProjectionHash,
      navigationRefs: [],
    },
    content,
    publicContentHash,
    governanceProjectionHash,
    provenanceRefs: SOURCES.map((item) => item.sourceRef),
    evidenceRefs: ["evidence_1"],
    relations: [],
    createdAt: "2026-08-28T08:00:00.000Z",
    updatedAt: "2026-08-28T09:00:00.000Z",
  };
}

function canonicalManifest() {
  const asset = governedAsset();
  return createGovernedCanonicalManifest({
    governanceRunId: "run_1",
    policyVersion: "governed-document/v1",
    createdAt: "2026-08-28T10:00:00.000Z",
    sourceSnapshotSha256: HASH("snapshot"),
    expectedSources: SOURCES,
    assets: [{
      asset,
      canonicalPath: "Memory/Experience/markdown-governance--doc-governance.md",
      markdownSha256: HASH("canonical-markdown"),
    }],
    sourceMappings: SOURCES.map((source) => ({
      source,
      scopeFingerprint: asset.scopeFingerprint,
      disposition: "attached_to_typed_document" as const,
      targetAssetIds: [asset.assetId],
      evidenceRefs: ["evidence_1"],
      reasonCode: "accepted_grounded_source",
    })),
  });
}

describe("P1 governed canonical manifest", () => {
  test("逐 source 唯一映射到 governed identity/hash/path 并严格 parse/hash", () => {
    const manifest = canonicalManifest();
    const serialized = serializeGovernedCanonicalManifest(manifest);
    expect(manifest.schema).toBe(GOVERNED_CANONICAL_MANIFEST_SCHEMA);
    expect(manifest.sourceMappings[0]!.targets[0]).toMatchObject({
      assetId: "doc_governance",
      assetVersion: 1,
      schemaVersion: 1,
      canonicalPath: "Memory/Experience/markdown-governance--doc-governance.md",
      publicContentHash: governedAsset().publicContentHash,
    });
    expect(parseGovernedCanonicalManifest(serialized, SOURCES)).toEqual(manifest);
    expect(governedCanonicalManifestSha256(serialized, SOURCES)).toMatch(/^[0-9a-f]{64}$/);
    expect(() => parseGovernedCanonicalManifest(serialized, [{
      sourceRef: SOURCES[0]!.sourceRef,
      sourceHash: HASH("wrong-source"),
    }, SOURCES[1]!])).toThrow(/source.*snapshot|drift/i);
  });

  test("拒绝 source pair 漂移、重复或遗漏 source", () => {
    expect(() => createGovernedCanonicalManifest({
      governanceRunId: "run_1",
      policyVersion: "governed-document/v1",
      createdAt: "2026-08-28T10:00:00.000Z",
      sourceSnapshotSha256: HASH("snapshot"),
      expectedSources: SOURCES,
      assets: [{
        asset: governedAsset(),
        canonicalPath: "Memory/Experience/x.md",
        markdownSha256: HASH("x"),
      }],
      sourceMappings: [{
        source: { sourceRef: SOURCES[0]!.sourceRef, sourceHash: SOURCES[1]!.sourceHash },
        scopeFingerprint: SCOPE,
        disposition: "attached_to_typed_document",
        targetAssetIds: ["doc_governance"],
        evidenceRefs: ["evidence_1"],
        reasonCode: "drifted",
      }],
    })).toThrow(/source|coverage|binding/i);

    const asset = governedAsset();
    expect(() => createGovernedCanonicalManifest({
      governanceRunId: "run_1",
      policyVersion: "governed-document/v1",
      createdAt: "2026-08-28T10:00:00.000Z",
      sourceSnapshotSha256: HASH("snapshot"),
      expectedSources: SOURCES,
      assets: [{
        asset,
        canonicalPath: "Memory/Experience/x.md",
        markdownSha256: HASH("x"),
      }],
      sourceMappings: SOURCES.map((source) => ({
        source,
        scopeFingerprint: asset.scopeFingerprint,
        disposition: "attached_to_typed_document" as const,
        targetAssetIds: [asset.assetId],
        evidenceRefs: [],
        reasonCode: "missing_evidence",
      })),
    })).toThrow(/target contract|evidence/i);
  });

  test("未知 key、artifact set hash 漂移和非 complete governed asset 均拒绝", () => {
    const manifest = canonicalManifest();
    const serialized = serializeGovernedCanonicalManifest(manifest);
    expect(() => parseGovernedCanonicalManifest(serialized.replace(
      '"schema":', '"injected": true,\n  "schema":',
    ))).toThrow(/shape|key|manifest/i);
    expect(() => parseGovernedCanonicalManifest(serialized.replace(
      `"artifactSetHash": "${manifest.artifactSetHash}"`,
      `"artifactSetHash": "${HASH("drift")}"`,
    ))).toThrow(/hash|manifest/i);
    expect(() => createGovernedCanonicalManifest({
      governanceRunId: "run_1",
      policyVersion: "governed-document/v1",
      createdAt: "2026-08-28T10:00:00.000Z",
      sourceSnapshotSha256: HASH("snapshot"),
      expectedSources: SOURCES,
      assets: [{
        asset: {
          ...governedAsset(),
          lifecycleState: "review",
          governanceDescription: {
            ...governedAsset().governanceDescription,
            lifecycleState: "review",
          },
        },
        canonicalPath: "Memory/Experience/x.md",
        markdownSha256: HASH("x"),
      }],
      sourceMappings: [],
    })).toThrow(/complete|active|asset/i);
  });
});

function catalogFixture() {
  const canonical = canonicalManifest();
  const canonicalSerialized = serializeGovernedCanonicalManifest(canonical);
  const catalog = createGovernedAssetCatalog({
    canonicalManifest: canonical,
    canonicalManifestSha256: governedCanonicalManifestSha256(canonicalSerialized),
    createdAt: "2026-08-28T11:00:00.000Z",
    memberships: [{
      assetId: "doc_governance",
      projects: ["memory-autodb"],
      topics: ["markdown-governance"],
      relatedAssetIds: [],
      sectionIds: ["section_contract"],
    }],
  });
  return { canonical, catalog };
}

describe("P1 asset catalog and index manifest", () => {
  test("catalog 覆盖全部 canonical asset，并冻结 manifest/catalog hash", () => {
    const { canonical, catalog } = catalogFixture();
    const serialized = serializeGovernedAssetCatalog(catalog);
    expect(catalog.schema).toBe(GOVERNED_ASSET_CATALOG_SCHEMA);
    expect(catalog.assets[0]!.sources).toEqual(SOURCES);
    expect(parseGovernedAssetCatalog(serialized, canonical)).toEqual(catalog);
    expect(governedAssetCatalogSha256(serialized, canonical)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("catalog 拒绝漏 member、cross-scope related target、未知 key 和 hash 漂移", () => {
    const { canonical, catalog } = catalogFixture();
    expect(() => createGovernedAssetCatalog({
      canonicalManifest: canonical,
      canonicalManifestSha256: governedCanonicalManifestSha256(
        serializeGovernedCanonicalManifest(canonical),
      ),
      createdAt: "2026-08-28T11:00:00.000Z",
      memberships: [],
    })).toThrow(/coverage|member|asset/i);

    const serialized = serializeGovernedAssetCatalog(catalog);
    expect(() => parseGovernedAssetCatalog(serialized.replace(
      '"schema":', '"injected": true,\n  "schema":',
    ), canonical)).toThrow(/shape|key|catalog/i);
    expect(() => parseGovernedAssetCatalog(serialized.replace(
      `"catalogHash": "${catalog.catalogHash}"`,
      `"catalogHash": "${HASH("drift")}"`,
    ), canonical)).toThrow(/hash|catalog/i);
  });

  test("index manifest 的 members/link graph 对 catalog 完整且从 Home 可达", () => {
    const { catalog } = catalogFixture();
    const catalogSerialized = serializeGovernedAssetCatalog(catalog);
    const index = createGovernedIndexManifest({
      catalog,
      catalogSha256: governedAssetCatalogSha256(catalogSerialized),
      createdAt: "2026-08-28T12:00:00.000Z",
      indexes: [
        {
          indexId: "index_home",
          relativePath: "Home.md",
          purpose: "home",
          scopeFingerprint: governedAsset().scopeFingerprint,
          memberAssetIds: [],
          childIndexIds: ["index_experience"],
          markdownSha256: HASH("home"),
        },
        {
          indexId: "index_experience",
          relativePath: "Memory/Experience/_index.md",
          purpose: "type_index",
          scopeFingerprint: governedAsset().scopeFingerprint,
          memberAssetIds: ["doc_governance"],
          childIndexIds: [],
          markdownSha256: HASH("experience-index"),
        },
      ],
    });
    const serialized = serializeGovernedIndexManifest(index);
    expect(index.schema).toBe(GOVERNED_INDEX_MANIFEST_SCHEMA);
    expect(index.linkGraph).toEqual([
      { fromIndexId: "index_experience", targetKind: "asset", targetId: "doc_governance" },
      { fromIndexId: "index_home", targetKind: "index", targetId: "index_experience" },
    ]);
    expect(parseGovernedIndexManifest(serialized, catalog)).toEqual(index);
    expect(governedIndexManifestSha256(serialized, catalog)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("index manifest 拒绝漏 asset、悬空 link、未知 key 与 hash 漂移", () => {
    const { catalog } = catalogFixture();
    expect(() => createGovernedIndexManifest({
      catalog,
      catalogSha256: governedAssetCatalogSha256(serializeGovernedAssetCatalog(catalog)),
      createdAt: "2026-08-28T12:00:00.000Z",
      indexes: [{
        indexId: "index_home",
        relativePath: "Home.md",
        purpose: "home",
        scopeFingerprint: governedAsset().scopeFingerprint,
        memberAssetIds: [],
        childIndexIds: [],
        markdownSha256: HASH("home"),
      }],
    })).toThrow(/coverage|reachable|empty/i);

    const catalogSerialized = serializeGovernedAssetCatalog(catalog);
    const valid = createGovernedIndexManifest({
      catalog,
      catalogSha256: governedAssetCatalogSha256(catalogSerialized),
      createdAt: "2026-08-28T12:00:00.000Z",
      indexes: [{
        indexId: "index_home",
        relativePath: "Home.md",
        purpose: "home",
        scopeFingerprint: governedAsset().scopeFingerprint,
        memberAssetIds: ["doc_governance"],
        childIndexIds: [],
        markdownSha256: HASH("home"),
      }],
    });
    const serialized = serializeGovernedIndexManifest(valid);
    const missingLink = JSON.parse(serialized) as any;
    missingLink.linkGraph = [];
    missingLink.artifactSetHash = HASH("adjusted");
    expect(() => parseGovernedIndexManifest(`${JSON.stringify(missingLink, null, 2)}\n`, catalog))
      .toThrow(/link|hash|manifest/i);
    expect(() => parseGovernedIndexManifest(serialized.replace(
      '"schema":', '"injected": true,\n  "schema":',
    ), catalog)).toThrow(/shape|key|manifest/i);
    expect(() => parseGovernedIndexManifest(serialized.replace(
      `"artifactSetHash": "${valid.artifactSetHash}"`,
      `"artifactSetHash": "${HASH("drift")}"`,
    ), catalog)).toThrow(/hash|manifest/i);
  });
});
