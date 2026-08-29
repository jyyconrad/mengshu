import { describe, expect, test } from "vitest";

import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../domain/types.js";
import {
  computeGovernanceProjectionHash,
  computePublicContentHash,
  parseGovernedDocumentMarkdown,
  renderGovernedDocumentMarkdown,
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

function asset(): GovernedDocumentAssetVersion {
  const content: CanonicalPublicDocumentContent = {
    title: "Vault rules",
    abstract: "受治理的 Vault 规则。",
    sections: [{
      id: "sec_commit",
      heading: "Commit",
      claims: [
        { id: "claim_head", text: "完成校验前不推进 head。" },
        { id: "claim_notes", text: "重新生成必须保留 Notes。" },
      ],
    }],
    userNotes: "第一行\n\n第二行\n",
    topics: ["vault", "memory-storage"],
    relatedAssetIds: ["doc_related"],
    sourceAssetIds: ["source_design"],
    aliases: ["vault rules"],
    tags: ["mengshu/rules"],
  };
  const publicContentHash = computePublicContentHash(content);
  const governanceProjectionHash = computeGovernanceProjectionHash({
    assetId: "doc_vault_rules",
    assetVersion: 3,
    claimEvidence: {
      claim_head: ["evidence_head"],
      claim_notes: ["evidence_notes"],
    },
    provenanceRefs: ["source_design"],
    relationRefs: ["doc_related"],
    sourceDispositionRefs: ["disposition_design"],
    resolutionHash: "a".repeat(64),
    policyVersion: "governed-document/v1",
  });
  return {
    assetId: "doc_vault_rules",
    assetVersion: 3,
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
      assetId: "doc_vault_rules",
      assetVersion: 3,
      kind: "memory_document",
      purpose: "typed_memory",
      semanticType: "rules",
      scopeFingerprint: authorityScopeFingerprint(scope),
      lifecycleState: "active",
      governanceState: "current",
      complexityClass: "simple",
      title: content.title,
      abstract: content.abstract,
      sectionIndex: [{ sectionId: "sec_commit", heading: "Commit", brief: "提交规则" }],
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
    evidenceRefs: ["evidence_head", "evidence_notes"],
    relations: [{ type: "references", targetAssetId: "doc_related" }],
    createdAt: "2026-08-28T08:00:00.000Z",
    updatedAt: "2026-08-28T09:00:00.000Z",
  };
}

describe("governed document markdown codec", () => {
  test("render 后 parse-back 恢复同一公开内容和 hash", () => {
    const source = asset();
    const markdown = renderGovernedDocumentMarkdown(source);
    const parsed = parseGovernedDocumentMarkdown(markdown);
    expect(parsed.identity).toEqual({
      assetId: source.assetId,
      assetVersion: source.assetVersion,
      schemaVersion: source.schemaVersion,
      kind: source.kind,
      purpose: source.purpose,
      semanticType: source.semanticType,
      semanticTypes: undefined,
      treeRef: undefined,
      lifecycleState: source.lifecycleState,
      governanceState: source.governanceState,
      scopeFingerprint: source.scopeFingerprint,
      publicContentHash: source.publicContentHash,
    });
    expect(parsed.content).toEqual(source.content);
    expect(computePublicContentHash(parsed.content)).toBe(source.publicContentHash);
  });

  test("用户 Notes 保留空行与结尾换行", () => {
    const markdown = renderGovernedDocumentMarkdown(asset());
    expect(parseGovernedDocumentMarkdown(markdown).content.userNotes).toBe("第一行\n\n第二行\n");
  });

  test("篡改正文但不更新 hash 时拒绝", () => {
    const markdown = renderGovernedDocumentMarkdown(asset())
      .replace("完成校验前不推进 head。", "绕过校验直接推进 head。");
    expect(() => parseGovernedDocumentMarkdown(markdown)).toThrow(/publicContentHash/i);
  });

  test("未知 schema 和破损 marker fail closed", () => {
    const markdown = renderGovernedDocumentMarkdown(asset());
    expect(() => parseGovernedDocumentMarkdown(
      markdown.replace("mengshu_schema: governed_document/v1", "mengshu_schema: governed_document/v999"),
    )).toThrow(/schema/i);
    expect(() => parseGovernedDocumentMarkdown(
      markdown.replace("<!-- mengshu:generated:end -->", ""),
    )).toThrow(/marker|generated/i);
    expect(() => parseGovernedDocumentMarkdown(
      markdown.replace("mengshu_kind: memory_document", "mengshu_kind: unknown_document"),
    )).toThrow(/kind/i);
  });

  test("Frontmatter key 集合和派生导航字段严格冻结", () => {
    const markdown = renderGovernedDocumentMarkdown(asset());
    expect(markdown).toContain('mengshu_scope: "project:memory-autodb"');
    expect(markdown).toContain('mengshu_primary_project: "memory-autodb"');
    expect(markdown).toContain('mengshu_primary_topic: "vault"');
    expect(markdown).toContain('mengshu_primary_source: "source_design"');
    expect(() => parseGovernedDocumentMarkdown(
      markdown.replace("mengshu_kind: memory_document", [
        "mengshu_kind: memory_document",
        "mengshu_agent_invented: true",
      ].join("\n")),
    )).toThrow(/frontmatter|schema/i);
    expect(() => parseGovernedDocumentMarkdown(
      markdown.replace('mengshu_primary_topic: "vault"', 'mengshu_primary_topic: "memory-storage"'),
    )).toThrow(/primary_topic|member/i);
  });

  test("tree/index document Properties 均可 parse-back", () => {
    const memory = asset();
    const treeRef = {
      treeType: "topic" as const,
      level: "L2" as const,
      treeKey: "vault",
      nodeId: "tree_vault",
      sealVersion: 2,
    };
    const tree: GovernedDocumentAssetVersion = {
      ...memory,
      kind: "tree_document",
      purpose: "tree_summary",
      semanticType: undefined,
      semanticTypes: ["rules"],
      treeRef,
      governanceDescription: {
        ...memory.governanceDescription,
        kind: "tree_document",
        purpose: "tree_summary",
        semanticType: undefined,
        treeRef,
      },
    };
    expect(parseGovernedDocumentMarkdown(renderGovernedDocumentMarkdown(tree)).identity)
      .toMatchObject({ kind: "tree_document", semanticTypes: ["rules"], treeRef });

    const index: GovernedDocumentAssetVersion = {
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
    };
    expect(parseGovernedDocumentMarkdown(renderGovernedDocumentMarkdown(index)).identity)
      .toMatchObject({ kind: "index_document", purpose: "project_index" });
  });

  test("非法 Properties、title、section 与 list 编码 fail closed", () => {
    const markdown = renderGovernedDocumentMarkdown(asset());
    expect(() => parseGovernedDocumentMarkdown(
      markdown.replace("mengshu_version: 3", "mengshu_version: three"),
    )).toThrow(/version|property|identity/i);
    expect(() => parseGovernedDocumentMarkdown(
      markdown.replace("# Vault rules", "Vault rules"),
    )).toThrow(/title/i);
    expect(() => parseGovernedDocumentMarkdown(
      markdown.replace("<!-- mengshu:section:sec_commit -->", "<!-- invalid-section -->"),
    )).toThrow(/section/i);
    expect(() => parseGovernedDocumentMarkdown(
      markdown.replace('  - "vault"', '  - "bad\\q"'),
    )).toThrow(/list|quoted/i);
  });
});
