import { describe, expect, test } from "vitest";

import { evaluateDocumentGovernanceProposal } from "./governance.js";
import {
  assertDocumentCompileFields,
  DocumentCompileContractError,
  governedDocumentCompileJobsAreUnregistered,
  GOVERNED_DOCUMENT_COMPILE_JOB_TYPES,
} from "./compile-contract.js";
import type { DocumentGovernanceProposal } from "./types.js";
import {
  DURABLE_JOB_V2_AUTHORITATIVE_TYPES,
  DURABLE_JOB_V2_DOCUMENT_COMPILE_TYPES,
  DURABLE_JOB_V2_EVOLUTION_COMPILE_TYPES,
  DURABLE_JOB_V2_EVOLUTION_TYPES,
} from "../storage/repositories/job-v2.js";

const hash = "a".repeat(64);
const proposal: DocumentGovernanceProposal = {
  proposalId: "proposal_1",
  governanceRunId: "run_1",
  scopeFingerprint: hash,
  expectedLatestVersion: 0,
  kind: "memory_document",
  purpose: "typed_memory",
  semanticType: "task_context",
  action: "update",
  title: "Project status",
  complexityClass: "simple",
  recommendedReadOrder: ["sec_status"],
  sections: [{
    sectionId: "sec_status",
    heading: "Status",
    brief: "当前状态",
    claims: [{
      id: "claim_status",
      text: "发布前运行测试。",
      inputRefs: ["information_1"],
      evidenceRefs: ["evidence_1"],
    }],
  }],
  relatedAssetIds: [],
  dispositions: [{
    informationRef: "information_1",
    sourceKind: "file",
    scopeFingerprint: hash,
    semanticType: "task_context",
    treeRoutes: [],
    disposition: "attached_to_typed_document",
    targetAssetIds: ["doc_1"],
    reasonCode: "eligible_grounded_fact",
    governanceRunId: "run_1",
    createdAt: "2026-10-03T00:00:00.000Z",
  }],
  riskClass: "low",
  reviewReasons: [],
  changeSummary: "更新状态段",
  modelFingerprint: "model_sha256",
  promptVersion: "document-organizer/v1",
};

const gate = {
  expectedScopeFingerprint: hash,
  expectedLatestVersion: 0,
  selectedInformationRefs: ["information_1"],
  readableEvidenceRefs: ["evidence_1"],
  readableInputRefs: ["information_1"],
  unresolvedConflictRefs: [],
  sensitiveDisclosureRefs: [],
  policyVersion: "document-governance/v1",
} as const;

describe("document compile contract", () => {
  test("附加水位、readEpoch 字段与稳定 claim id 不改变既有治理结论", () => {
    const compiled: DocumentGovernanceProposal = {
      ...proposal,
      inputSnapshotHash: hash,
      readSet: [{ kind: "section", ref: "sec_status", contentHash: hash }],
      coverage: [{ ref: "information_1", state: "used" }],
      sectionDiff: [{
        sectionId: "sec_status",
        claimIds: ["claim_status"],
        changeKind: "replace",
        preserved: false,
      }],
      preserveSet: [{
        sectionId: "sec_status",
        claimId: "claim_status",
        contentHash: hash,
        evidenceRefs: ["evidence_1"],
      }],
      sourceWatermarks: [{
        sourceId: "session-1",
        revision: "rev-1",
        payloadHash: "b".repeat(64),
        observedAt: 1_700_000_000_000,
      }],
      changeKind: "replace",
      memoryForm: "fact/claim",
      validTimeSelector: { mode: "as_of", asOf: 10, knownAt: 20 },
    };
    expect(evaluateDocumentGovernanceProposal({ ...gate, proposal }))
      .toEqual(evaluateDocumentGovernanceProposal({ ...gate, proposal: compiled }));
    expect(() => assertDocumentCompileFields(compiled)).not.toThrow();
    expect(() => assertDocumentCompileFields({
      ...compiled,
      sourceWatermarks: [{ sourceId: "session-1", revision: "rev-1", payloadHash: "not-a-hash" }],
    })).toThrow(DocumentCompileContractError);
  });

  test("compile_document 只进入可选完整注册表，publish_document 不是队列", () => {
    expect(GOVERNED_DOCUMENT_COMPILE_JOB_TYPES).toEqual([
      "compile_document",
      "publish_document",
    ]);
    expect(governedDocumentCompileJobsAreUnregistered()).toBe(false);
    expect(DURABLE_JOB_V2_AUTHORITATIVE_TYPES).toEqual([
      "build_tree",
      "extract_candidate",
      "extract_graph",
    ]);
    expect(DURABLE_JOB_V2_EVOLUTION_TYPES).not.toContain("compile_document");
    expect(DURABLE_JOB_V2_DOCUMENT_COMPILE_TYPES).toContain("compile_document");
    expect(DURABLE_JOB_V2_EVOLUTION_COMPILE_TYPES).toContain("compile_document");
    for (const types of [
      DURABLE_JOB_V2_AUTHORITATIVE_TYPES,
      DURABLE_JOB_V2_EVOLUTION_TYPES,
      DURABLE_JOB_V2_DOCUMENT_COMPILE_TYPES,
      DURABLE_JOB_V2_EVOLUTION_COMPILE_TYPES,
    ]) {
      expect(types).not.toContain("publish_document");
    }
  });
});
