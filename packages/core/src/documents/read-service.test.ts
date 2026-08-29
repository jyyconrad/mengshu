import { describe, expect, test } from "vitest";

import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../domain/types.js";
import {
  GovernedDocumentReadService,
  computeGovernanceProjectionHash,
  computePublicContentHash,
  type GovernedDocumentAssetVersion,
  type GovernedDocumentIndex,
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

function fixture(
  complexityClass: "simple" | "complex",
  state: GovernedDocumentAssetVersion["governanceState"] = "current",
): { asset: GovernedDocumentAssetVersion; index?: GovernedDocumentIndex } {
  const content = {
    title: "Vault rules",
    abstract: "提交与读取规则。",
    sections: [{
      id: "sec_commit",
      heading: "Commit",
      claims: [{ id: "claim_head", text: "完成校验前不推进 head。" }],
    }],
    userNotes: "",
    topics: ["vault"],
    relatedAssetIds: [],
    sourceAssetIds: ["source_design"],
    aliases: [],
    tags: ["mengshu/rules"],
  } as const;
  const publicContentHash = computePublicContentHash(content);
  const governanceProjectionHash = computeGovernanceProjectionHash({
    assetId: "doc_rules",
    assetVersion: 2,
    claimEvidence: { claim_head: ["evidence_head"] },
    provenanceRefs: ["source_design"],
    relationRefs: [],
    sourceDispositionRefs: ["disposition_design"],
    resolutionHash: "a".repeat(64),
    policyVersion: "governed-document/v1",
  });
  const documentIndexAssetId = complexityClass === "complex" ? "index_doc_rules" : undefined;
  const asset: GovernedDocumentAssetVersion = {
    assetId: "doc_rules",
    assetVersion: 2,
    schemaVersion: 1,
    kind: "memory_document",
    purpose: "typed_memory",
    semanticType: "rules",
    title: content.title,
    lifecycleState: "active",
    governanceState: state,
    scope,
    scopeFingerprint: authorityScopeFingerprint(scope),
    governanceDescription: {
      assetId: "doc_rules",
      assetVersion: 2,
      kind: "memory_document",
      purpose: "typed_memory",
      semanticType: "rules",
      scopeFingerprint: authorityScopeFingerprint(scope),
      lifecycleState: "active",
      governanceState: state,
      complexityClass,
      title: content.title,
      abstract: content.abstract,
      sectionIndex: [{ sectionId: "sec_commit", heading: "Commit", brief: "提交规则" }],
      ...(documentIndexAssetId ? { documentIndexAssetId } : {}),
      claimEvidenceCoverage: 1,
      sourceDispositionCoverage: 1,
      conflictCount: 0,
      staleReasons: state === "stale" ? ["source_revision_changed"] : [],
      publicContentHash,
      governanceProjectionHash,
      navigationRefs: ["source_design"],
    },
    ...(documentIndexAssetId ? { documentIndexRef: documentIndexAssetId } : {}),
    content,
    publicContentHash,
    governanceProjectionHash,
    provenanceRefs: ["source_design"],
    evidenceRefs: ["evidence_head"],
    relations: [],
    createdAt: "2026-08-28T08:00:00.000Z",
    updatedAt: "2026-08-28T09:00:00.000Z",
  };
  const index = complexityClass === "complex" ? {
    assetId: "doc_rules",
    assetVersion: 2,
    title: content.title,
    abstract: content.abstract,
    complexityClass,
    recommendedReadOrder: ["sec_commit"],
    sections: [{
      sectionId: "sec_commit",
      heading: "Commit",
      level: 2,
      brief: "提交规则",
      childSectionIds: [],
      prerequisiteSectionIds: [],
      claimCount: 1,
      evidenceAvailable: true,
    }],
    relatedAssetIds: [],
    publicContentHash,
  } satisfies GovernedDocumentIndex : undefined;
  return { asset, index };
}

function service(input: ReturnType<typeof fixture>) {
  return new GovernedDocumentReadService({
    repository: {
      getComplete: async (_scope, assetId) => assetId === input.asset.assetId
        ? input.asset : undefined,
      getIndex: async () => input.index,
    },
  });
}

describe("GovernedDocumentReadService", () => {
  test("complex 文档无参数读取返回 INDEX_REQUIRED 与当前索引", async () => {
    const input = fixture("complex");
    await expect(service(input).read(scope, "doc_rules")).resolves.toEqual({
      kind: "index_required",
      code: "INDEX_REQUIRED",
      assetId: "doc_rules",
      assetVersion: 2,
      descriptor: input.asset.governanceDescription,
      index: input.index,
    });
  });

  test("section 读取只允许当前 index 声明的 section", async () => {
    const reader = service(fixture("complex"));
    await expect(reader.read(scope, "doc_rules", { sectionId: "sec_commit" }))
      .resolves.toMatchObject({ kind: "section", section: { id: "sec_commit" } });
    await expect(reader.read(scope, "doc_rules", { sectionId: "sec_missing" }))
      .rejects.toMatchObject({ code: "SECTION_NOT_FOUND" });
  });

  test("simple 文档可在预算允许时直接读取正文", async () => {
    await expect(service(fixture("simple")).read(scope, "doc_rules"))
      .resolves.toMatchObject({ kind: "document", content: { title: "Vault rules" } });
  });

  test("stale 文档返回 filtered reason 并导航到 native recall", async () => {
    await expect(service(fixture("simple", "stale")).read(scope, "doc_rules"))
      .resolves.toEqual({
        kind: "filtered",
        assetId: "doc_rules",
        reason: "stale",
        fallback: "native_recall",
        navigationRefs: ["source_design"],
      });
  });

  test("索引版本或 hash 与 complete head 不一致时 fail closed", async () => {
    const input = fixture("complex");
    input.index = { ...input.index!, assetVersion: 1 };
    await expect(service(input).read(scope, "doc_rules"))
      .rejects.toMatchObject({ code: "INDEX_STALE" });
  });

  test("describe 返回治理说明与 current index，显式 full 才展开 complex 正文", async () => {
    const input = fixture("complex");
    const reader = service(input);
    await expect(reader.describe(scope, "doc_rules")).resolves.toEqual({
      descriptor: input.asset.governanceDescription,
      index: input.index,
    });
    await expect(reader.read(scope, "doc_rules", { full: true }))
      .resolves.toMatchObject({ kind: "document", content: { title: "Vault rules" } });
  });

  test("缺失 index、互斥读取参数与 incomplete coverage fail closed", async () => {
    const complex = fixture("complex");
    complex.index = undefined;
    await expect(service(complex).read(scope, "doc_rules"))
      .rejects.toMatchObject({ code: "INDEX_MISSING" });

    await expect(service(fixture("simple")).read(scope, "doc_rules", {
      sectionId: "sec_commit",
      full: true,
    })).rejects.toMatchObject({ code: "INVALID_READ_REQUEST" });

    const incomplete = fixture("simple");
    incomplete.asset = {
      ...incomplete.asset,
      governanceDescription: {
        ...incomplete.asset.governanceDescription,
        claimEvidenceCoverage: 0.5,
      },
    };
    await expect(service(incomplete).read(scope, "doc_rules"))
      .resolves.toMatchObject({ kind: "filtered", reason: "evidence_incomplete" });
  });

  test("非 active lifecycle 返回 native recall fallback", async () => {
    const revoked = fixture("simple");
    revoked.asset = {
      ...revoked.asset,
      lifecycleState: "revoked",
      governanceDescription: {
        ...revoked.asset.governanceDescription,
        lifecycleState: "revoked",
      },
    };
    await expect(service(revoked).read(scope, "doc_rules"))
      .resolves.toMatchObject({ kind: "filtered", reason: "revoked", fallback: "native_recall" });
  });
});
