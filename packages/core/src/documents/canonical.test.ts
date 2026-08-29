import { describe, expect, test } from "vitest";

import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../domain/types.js";
import {
  computeGovernanceProjectionHash,
  computeCompletionContractHash,
  computePublicContentHash,
  validateGovernedDocumentIndex,
  validateGovernedDocumentAssetVersion,
  type CanonicalPublicDocumentContent,
  type GovernedDocumentAssetVersion,
} from "./index.js";

const scope: MemoryScope = {
  tenantId: "local",
  userId: "u1",
  appId: "codex",
  projectId: "memory-autodb",
  agentId: "root",
  namespace: "memories",
  visibility: "private",
};

const content: CanonicalPublicDocumentContent = {
  title: "Memory storage rules",
  abstract: "稳定的文档资产提交规则。",
  sections: [{
    id: "sec_rules",
    heading: "Rules",
    claims: [{
      id: "claim_complete_head",
      text: "双侧校验完成前保留当前 complete head。",
    }],
  }],
  userNotes: "人工补充必须逐字保留。\n",
  topics: ["memory-storage"],
  relatedAssetIds: ["doc_related"],
  sourceAssetIds: ["source_design"],
  aliases: ["memory persistence rules"],
  tags: ["mengshu/rules"],
};

function memoryDocument(): GovernedDocumentAssetVersion {
  const publicContentHash = computePublicContentHash(content);
  const governanceProjectionHash = computeGovernanceProjectionHash({
    assetId: "doc_rules",
    assetVersion: 1,
    claimEvidence: { claim_complete_head: ["evidence_2", "evidence_1"] },
    provenanceRefs: ["source_design"],
    relationRefs: ["doc_related"],
    sourceDispositionRefs: ["disposition_1"],
    resolutionHash: "a".repeat(64),
    policyVersion: "governed-document/v1",
  });
  return {
    assetId: "doc_rules",
    assetVersion: 1,
    schemaVersion: 1,
    kind: "memory_document",
    purpose: "typed_memory",
    semanticType: "rules",
    title: content.title,
    lifecycleState: "active",
    governanceState: "current",
    scope,
    scopeFingerprint: authorityScopeFingerprint(scope),
    governanceDescription: {
      assetId: "doc_rules",
      assetVersion: 1,
      kind: "memory_document",
      purpose: "typed_memory",
      semanticType: "rules",
      scopeFingerprint: authorityScopeFingerprint(scope),
      lifecycleState: "active",
      governanceState: "current",
      complexityClass: "simple",
      title: content.title,
      abstract: content.abstract,
      sectionIndex: [{ sectionId: "sec_rules", heading: "Rules", brief: "提交规则" }],
      claimEvidenceCoverage: 1,
      sourceDispositionCoverage: 1,
      conflictCount: 0,
      staleReasons: [],
      publicContentHash,
      governanceProjectionHash,
      navigationRefs: ["source_design"],
    },
    content,
    publicContentHash,
    governanceProjectionHash,
    provenanceRefs: ["source_design"],
    evidenceRefs: ["evidence_1", "evidence_2"],
    relations: [{ type: "references", targetAssetId: "doc_related" }],
    createdAt: "2026-08-28T08:00:00.000Z",
    updatedAt: "2026-08-28T08:00:00.000Z",
  };
}

describe("governed document canonical contract", () => {
  test("公开内容 hash 不受集合顺序影响，但保留章节与 claim 顺序", () => {
    const reordered = {
      ...content,
      topics: [...content.topics].reverse(),
      relatedAssetIds: [...content.relatedAssetIds].reverse(),
      sourceAssetIds: [...content.sourceAssetIds].reverse(),
      aliases: [...content.aliases].reverse(),
      tags: [...content.tags].reverse(),
    };
    expect(computePublicContentHash(reordered)).toBe(computePublicContentHash(content));
    expect(computePublicContentHash({
      ...content,
      sections: [{ ...content.sections[0]!, claims: [
        { id: "claim_second", text: "second" },
        ...content.sections[0]!.claims,
      ] }],
    })).not.toBe(computePublicContentHash(content));
  });

  test("治理投影对具有集合语义的引用稳定排序", () => {
    const base = {
      assetId: "doc_rules",
      assetVersion: 1,
      claimEvidence: { claim_complete_head: ["evidence_2", "evidence_1"] },
      provenanceRefs: ["source_b", "source_a"],
      relationRefs: ["doc_b", "doc_a"],
      sourceDispositionRefs: ["disp_b", "disp_a"],
      resolutionHash: "a".repeat(64),
      policyVersion: "governed-document/v1",
    } as const;
    expect(computeGovernanceProjectionHash(base)).toBe(computeGovernanceProjectionHash({
      ...base,
      claimEvidence: { claim_complete_head: ["evidence_1", "evidence_2"] },
      provenanceRefs: ["source_a", "source_b"],
      relationRefs: ["doc_a", "doc_b"],
      sourceDispositionRefs: ["disp_a", "disp_b"],
    }));
  });

  test("memory/tree/index 三种 kind 的字段组合互斥", () => {
    const memory = memoryDocument();
    expect(validateGovernedDocumentAssetVersion(memory)).toMatchObject({
      kind: "memory_document",
      semanticType: "rules",
    });
    expect(validateGovernedDocumentAssetVersion({
      ...memory,
      kind: "tree_document",
      purpose: "tree_summary",
      semanticType: undefined,
      semanticTypes: ["rules"],
      treeRef: {
        treeType: "topic",
        level: "L2",
        treeKey: "memory-storage",
        nodeId: "tree_1",
        sealVersion: 1,
      },
      governanceDescription: {
        ...memory.governanceDescription,
        kind: "tree_document",
        purpose: "tree_summary",
        semanticType: undefined,
        treeRef: {
          treeType: "topic",
          level: "L2",
          treeKey: "memory-storage",
          nodeId: "tree_1",
          sealVersion: 1,
        },
      },
    })).toMatchObject({ kind: "tree_document", semanticTypes: ["rules"] });
    expect(validateGovernedDocumentAssetVersion({
      ...memory,
      kind: "index_document",
      purpose: "project_index",
      semanticType: undefined,
      governanceDescription: {
        ...memory.governanceDescription,
        kind: "index_document",
        purpose: "project_index",
        semanticType: undefined,
      },
    })).toMatchObject({ kind: "index_document", purpose: "project_index" });
    expect(() => validateGovernedDocumentAssetVersion({
      ...memory,
      semanticTypes: ["rules"],
    })).toThrow(/kind|semanticTypes/i);
    expect(() => validateGovernedDocumentAssetVersion({
      ...memory,
      kind: "tree_document",
      purpose: "tree_summary",
      semanticType: undefined,
    })).toThrow(/treeRef/i);
    expect(() => validateGovernedDocumentAssetVersion({
      ...memory,
      kind: "index_document",
      purpose: "project_index",
    })).toThrow(/semanticType/i);
  });

  test("关系类型使用冻结词表并拒绝旧拼写", () => {
    const memory = memoryDocument();
    for (const type of [
      "related", "references", "derived_from", "depends_on", "supersedes",
      "superseded_by", "contradicts", "tree_route",
    ] as const) {
      expect(() => validateGovernedDocumentAssetVersion({
        ...memory,
        relations: [{ type, targetAssetId: "doc_target" }],
      })).not.toThrow();
    }
    expect(() => validateGovernedDocumentAssetVersion({
      ...memory,
      relations: [{ type: "derives_from", targetAssetId: "doc_target" }],
    } as never)).toThrow(/relation type/i);
  });

  test("公开 hash 或 descriptor 版本不一致时 fail closed", () => {
    expect(() => validateGovernedDocumentAssetVersion({
      ...memoryDocument(),
      publicContentHash: "0".repeat(64),
    })).toThrow(/publicContentHash/i);
    expect(() => validateGovernedDocumentAssetVersion({
      ...memoryDocument(),
      governanceDescription: {
        ...memoryDocument().governanceDescription,
        assetVersion: 2,
      },
    })).toThrow(/governanceDescription/i);
  });

  test("复杂文档索引只允许导航到当前版本的已声明 section", () => {
    const document = memoryDocument();
    expect(validateGovernedDocumentIndex({
      assetId: document.assetId,
      assetVersion: document.assetVersion,
      title: document.title,
      abstract: document.content.abstract,
      complexityClass: "complex",
      recommendedReadOrder: ["sec_rules"],
      sections: [{
        sectionId: "sec_rules",
        heading: "Rules",
        level: 2,
        brief: "提交规则",
        childSectionIds: [],
        prerequisiteSectionIds: [],
        claimCount: 1,
        evidenceAvailable: true,
      }],
      relatedAssetIds: ["doc_related"],
      publicContentHash: document.publicContentHash,
    }, document)).toMatchObject({ assetId: "doc_rules", assetVersion: 1 });
    expect(() => validateGovernedDocumentIndex({
      assetId: document.assetId,
      assetVersion: document.assetVersion,
      title: document.title,
      abstract: document.content.abstract,
      complexityClass: "complex",
      recommendedReadOrder: ["sec_missing"],
      sections: [],
      relatedAssetIds: [],
      publicContentHash: document.publicContentHash,
    }, document)).toThrow(/section|read order/i);
  });

  test("completion contract hash 覆盖双侧完成所需的完整状态", () => {
    const document = memoryDocument();
    const base = {
      assetId: document.assetId,
      assetVersion: document.assetVersion,
      schemaVersion: document.schemaVersion,
      kind: document.kind,
      purpose: document.purpose,
      semanticType: document.semanticType,
      lifecycleState: document.lifecycleState,
      governanceState: document.governanceState,
      scopeFingerprint: document.scopeFingerprint,
      publicContentHash: document.publicContentHash,
      governanceProjectionHash: document.governanceProjectionHash,
    } as const;
    const hash = computeCompletionContractHash(base);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(computeCompletionContractHash({
      ...base,
      governanceState: "stale",
    })).not.toBe(hash);
  });
});
