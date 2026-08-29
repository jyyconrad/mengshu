import { describe, expect, test } from "vitest";

import {
  evaluateDocumentGovernanceProposal,
  type DocumentGovernanceProposal,
} from "./index.js";

const proposal: DocumentGovernanceProposal = {
  proposalId: "proposal_1",
  governanceRunId: "run_1",
  scopeFingerprint: "a".repeat(64),
  expectedLatestVersion: 0,
  kind: "memory_document",
  purpose: "typed_memory",
  semanticType: "experience",
  action: "create",
  title: "History migration lessons",
  abstract: "迁移经验。",
  complexityClass: "simple",
  recommendedReadOrder: ["sec_lesson"],
  sections: [{
    sectionId: "sec_lesson",
    heading: "Lesson",
    brief: "迁移门禁",
    claims: [{
      text: "manifest 漂移时停止 apply。",
      inputRefs: ["information_1"],
      evidenceRefs: ["evidence_1"],
    }],
  }],
  relatedAssetIds: [],
  dispositions: [{
    informationRef: "information_1",
    sourceKind: "system_event",
    scopeFingerprint: "a".repeat(64),
    semanticType: "experience",
    treeRoutes: [{ treeType: "source", treeKey: "migration" }],
    disposition: "attached_and_routed",
    targetAssetIds: ["doc_1"],
    reasonCode: "eligible_grounded_fact",
    governanceRunId: "run_1",
    createdAt: "2026-08-28T08:00:00.000Z",
  }],
  riskClass: "low",
  reviewReasons: [],
  changeSummary: "创建迁移经验文档",
  modelFingerprint: "model_sha256",
  promptVersion: "document-organizer/v1",
};

const input = {
  proposal,
  expectedScopeFingerprint: "a".repeat(64),
  expectedLatestVersion: 0,
  selectedInformationRefs: ["information_1"],
  readableEvidenceRefs: ["evidence_1"],
  readableInputRefs: ["information_1"],
  unresolvedConflictRefs: [],
  sensitiveDisclosureRefs: [],
  previousSemanticType: undefined,
  policyVersion: "document-governance/v1",
} as const;

describe("document governance deterministic gates", () => {
  test("grounded、同 scope、disposition 完整的低风险 create 可自动应用", () => {
    expect(evaluateDocumentGovernanceProposal(input)).toEqual({
      decision: "auto_apply",
      reasonCodes: [],
      selectedInformationCount: 1,
      dispositionCoverage: 1,
      claimEvidenceCoverage: 1,
      policyVersion: "document-governance/v1",
    });
  });

  test("selected information 缺 disposition 时拒绝", () => {
    expect(evaluateDocumentGovernanceProposal({
      ...input,
      proposal: { ...proposal, dispositions: [] },
    })).toMatchObject({
      decision: "quarantine",
      reasonCodes: ["DISPOSITION_INCOMPLETE"],
      dispositionCoverage: 0,
    });
  });

  test("claim 缺 evidence 或引用不可读 evidence 时拒绝", () => {
    const ungrounded = {
      ...proposal,
      sections: [{
        ...proposal.sections[0]!,
        claims: [{
          ...proposal.sections[0]!.claims[0]!,
          evidenceRefs: ["evidence_missing"],
        }],
      }],
    };
    expect(evaluateDocumentGovernanceProposal({ ...input, proposal: ungrounded }))
      .toMatchObject({ decision: "quarantine", reasonCodes: ["EVIDENCE_UNREADABLE"] });
  });

  test("跨 scope、CAS 漂移和冲突引用 fail closed", () => {
    expect(evaluateDocumentGovernanceProposal({
      ...input,
      expectedScopeFingerprint: "b".repeat(64),
      expectedLatestVersion: 1,
      unresolvedConflictRefs: ["information_1"],
    })).toMatchObject({
      decision: "quarantine",
      reasonCodes: ["SCOPE_MISMATCH", "VERSION_CONFLICT", "UNRESOLVED_CONFLICT"],
    });
  });

  test("semanticType 变化、rules/profile、global tree 和 destructive action 必须 review", () => {
    expect(evaluateDocumentGovernanceProposal({
      ...input,
      previousSemanticType: "rules",
    })).toMatchObject({ decision: "review", reasonCodes: ["SEMANTIC_TYPE_CHANGE"] });
    expect(evaluateDocumentGovernanceProposal({
      ...input,
      proposal: { ...proposal, semanticType: "rules" },
      previousSemanticType: "rules",
    })).toMatchObject({ decision: "review", reasonCodes: ["PROTECTED_SEMANTIC_TYPE"] });
    expect(evaluateDocumentGovernanceProposal({
      ...input,
      proposal: { ...proposal, action: "deprecate" },
    })).toMatchObject({ decision: "review", reasonCodes: ["DESTRUCTIVE_ACTION"] });
  });

  test("不可读输入、空 evidence 与敏感引用按固定顺序 quarantine", () => {
    expect(evaluateDocumentGovernanceProposal({
      ...input,
      readableInputRefs: [],
      sensitiveDisclosureRefs: ["information_1"],
      proposal: {
        ...proposal,
        sections: [{
          ...proposal.sections[0]!,
          claims: [{
            ...proposal.sections[0]!.claims[0]!,
            evidenceRefs: [],
          }],
        }],
      },
    })).toMatchObject({
      decision: "quarantine",
      reasonCodes: ["INPUT_UNREADABLE", "EVIDENCE_REQUIRED", "SENSITIVE_DISCLOSURE"],
      claimEvidenceCoverage: 0,
    });
  });

  test("disposition 漂移、global tree、risk 与 model review reason 均由 policy 裁决", () => {
    expect(evaluateDocumentGovernanceProposal({
      ...input,
      proposal: {
        ...proposal,
        dispositions: [{ ...proposal.dispositions[0]!, scopeFingerprint: "b".repeat(64) }],
      },
    })).toMatchObject({ decision: "quarantine", reasonCodes: ["DISPOSITION_INVALID"] });

    expect(evaluateDocumentGovernanceProposal({
      ...input,
      proposal: {
        ...proposal,
        kind: "tree_document",
        purpose: "tree_summary",
        semanticType: undefined,
        treeRef: {
          treeType: "global",
          level: "L3",
          treeKey: "private-global",
          nodeId: "tree_global_1",
          sealVersion: 1,
        },
      },
    })).toMatchObject({ decision: "review", reasonCodes: ["GLOBAL_TREE_CHANGE"] });

    expect(evaluateDocumentGovernanceProposal({
      ...input,
      proposal: {
        ...proposal,
        riskClass: "high",
        reviewReasons: ["faithfulness_review"],
      },
    })).toMatchObject({
      decision: "review",
      reasonCodes: ["RISK_REVIEW_REQUIRED", "MODEL_REVIEW_REQUIRED"],
    });
  });
});
