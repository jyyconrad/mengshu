import { describe, expect, test, vi } from "vitest";

import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import {
  computeGovernanceProjectionHash,
  computePublicContentHash,
} from "./canonical.js";
import { renderGovernedDocumentMarkdown } from "./markdown-codec.js";
import {
  GovernedDocumentMarkdownCommitError,
  type CompletePreparedDocumentResult,
  type GovernedDocumentMarkdownAdapterPort,
  type GovernedDocumentWriteFailurePhase,
  type GovernedDocumentWriteRepositoryPort,
  type PreparedGovernedDocumentVersion,
  type PrepareGovernedDocumentVersionInput,
  type RecordIncompleteDocumentInput,
} from "./repository.js";
import type {
  DocumentAssetCommitReceipt,
  GovernedDocumentAssetVersion,
} from "./types.js";
import {
  GovernedDocumentAssetWriteKernel,
  GovernedDocumentWriteError,
} from "./write-kernel.js";

const scope = Object.freeze({
  tenantId: "local",
  userId: "user_1",
  appId: "codex",
  projectId: "memory-autodb",
  agentId: "root",
  namespace: "memories",
  visibility: "private" as const,
});

function asset(title = "Vault write rules"): GovernedDocumentAssetVersion {
  const content = {
    title,
    abstract: "受治理文档的双侧完成规则。",
    sections: [{
      id: "sec_commit",
      heading: "Commit",
      claims: [{ id: "claim_head", text: "双侧校验前保留旧 complete head。" }],
    }],
    userNotes: "人工备注。\n",
    topics: ["vault"],
    relatedAssetIds: [],
    sourceAssetIds: ["source_design"],
    aliases: [],
    tags: ["mengshu/rules"],
  } as const;
  const publicContentHash = computePublicContentHash(content);
  const governanceProjectionHash = computeGovernanceProjectionHash({
    assetId: "doc_1",
    assetVersion: 3,
    claimEvidence: { claim_head: ["evidence_1"] },
    provenanceRefs: ["source_design"],
    relationRefs: [],
    sourceDispositionRefs: ["disposition_1"],
    resolutionHash: "a".repeat(64),
    policyVersion: "governed-document/v1",
  });
  const scopeFingerprint = authorityScopeFingerprint(scope);
  const result: GovernedDocumentAssetVersion = {
    assetId: "doc_1",
    assetVersion: 3,
    schemaVersion: 1,
    kind: "memory_document",
    purpose: "typed_memory",
    semanticType: "rules",
    title,
    lifecycleState: "active",
    governanceState: "current",
    scope,
    scopeFingerprint,
    governanceDescription: {
      assetId: "doc_1",
      assetVersion: 3,
      kind: "memory_document",
      purpose: "typed_memory",
      semanticType: "rules",
      scopeFingerprint,
      lifecycleState: "active",
      governanceState: "current",
      complexityClass: "simple",
      title,
      abstract: content.abstract,
      sectionIndex: [{ sectionId: "sec_commit", heading: "Commit", brief: "提交协议" }],
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
    evidenceRefs: ["evidence_1"],
    relations: [],
    createdAt: "2026-08-28T08:00:00.000Z",
    updatedAt: "2026-08-28T09:00:00.000Z",
  };
  return Object.freeze(result);
}

type FakeFailureDisposition = Partial<Record<GovernedDocumentWriteFailurePhase,
DocumentAssetCommitReceipt["disposition"]>>;

class FakeRepository implements GovernedDocumentWriteRepositoryPort {
  completeHead = 2;
  readonly prepared: PreparedGovernedDocumentVersion[] = [];
  readonly receipts = new Map<string, DocumentAssetCommitReceipt>();
  readonly events: string[] = [];
  readonly incompleteInputs: RecordIncompleteDocumentInput[] = [];
  failCas = false;

  constructor(private readonly failures: FakeFailureDisposition = {}) {}

  async prepareVersion(input: PrepareGovernedDocumentVersionInput) {
    this.events.push("prepare");
    const existing = this.receipts.get(`${input.vaultId}\0${input.idempotencyKey}`);
    if (existing) return Object.freeze({ state: "replayed" as const, receipt: existing });
    if (this.completeHead !== input.expectedCompleteVersion) {
      throw new Error("unexpected fake complete head");
    }
    const prepared = Object.freeze({ ...input, prepareToken: `prepare_${input.asset.assetVersion}` });
    this.prepared.push(prepared);
    return Object.freeze({ state: "prepared" as const, prepared });
  }

  async completePreparedVersion(input: Parameters<
  GovernedDocumentWriteRepositoryPort["completePreparedVersion"]>[0]):
  Promise<CompletePreparedDocumentResult> {
    this.events.push("complete-cas");
    if (this.failCas || this.completeHead !== input.prepared.expectedCompleteVersion) {
      return Object.freeze({ state: "cas_mismatch" as const });
    }
    const receipt = this.receipt(input.prepared, "complete", {
      markdownPublicContentHash: input.markdownPublicContentHash,
      renderHash: input.renderHash,
    });
    this.completeHead = input.prepared.asset.assetVersion;
    this.receipts.set(`${input.prepared.vaultId}\0${input.prepared.idempotencyKey}`, receipt);
    return Object.freeze({ state: "complete" as const, receipt });
  }

  async recordIncomplete(input: RecordIncompleteDocumentInput) {
    this.events.push(`incomplete:${input.phase}`);
    this.incompleteInputs.push(input);
    const disposition = this.failures[input.phase] ?? "pending";
    const receipt = this.receipt(input.prepared, disposition, {
      markdownPublicContentHash: input.markdownPublicContentHash ??
        input.prepared.asset.publicContentHash,
      renderHash: input.renderHash,
    });
    this.receipts.set(`${input.prepared.vaultId}\0${input.prepared.idempotencyKey}`, receipt);
    return receipt;
  }

  private receipt(
    prepared: PreparedGovernedDocumentVersion,
    disposition: DocumentAssetCommitReceipt["disposition"],
    _observed: { readonly markdownPublicContentHash: string; readonly renderHash?: string },
  ): DocumentAssetCommitReceipt {
    return Object.freeze({
      receiptId: `receipt_${this.receipts.size + 1}`,
      vaultId: prepared.vaultId,
      idempotencyKey: prepared.idempotencyKey,
      requestHash: prepared.requestHash,
      assetId: prepared.asset.assetId,
      assetVersion: prepared.asset.assetVersion,
      postgresPublicContentHash: prepared.asset.publicContentHash,
      markdownPublicContentHash: _observed.markdownPublicContentHash,
      governanceProjectionHash: prepared.asset.governanceProjectionHash,
      completionContractHash: prepared.completionContractHash,
      disposition,
      createdAt: "2026-08-28T09:01:00.000Z",
    });
  }
}

function adapter(
  commit: GovernedDocumentMarkdownAdapterPort["commit"] = async (input) => ({
    markdown: input.markdown,
  }),
): GovernedDocumentMarkdownAdapterPort & { commit: ReturnType<typeof vi.fn> } {
  return { commit: vi.fn(commit) };
}

const input = Object.freeze({
  asset: asset(),
  vaultId: "vault_1",
  canonicalPath: "Memory/Rules/project/doc_1.md",
  idempotencyKey: "commit_doc_1_v3",
  expectedCompleteVersion: 2,
});

describe("GovernedDocumentAssetWriteKernel", () => {
  test("非法 canonical path 在 prepare 前 fail closed", async () => {
    const repository = new FakeRepository();
    const markdown = adapter();
    const kernel = new GovernedDocumentAssetWriteKernel({ repository, markdown });

    await expect(kernel.commit({
      ...input,
      canonicalPath: "../outside.md",
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(repository.events).toEqual([]);
    expect(markdown.commit).not.toHaveBeenCalled();
  });

  test("prepare 后保留旧 head，parse-back 一致才原子 CAS complete", async () => {
    const repository = new FakeRepository();
    const markdown = adapter(async (commitInput) => {
      expect(repository.completeHead).toBe(2);
      expect(commitInput.asset).toBe(input.asset);
      return { markdown: commitInput.markdown };
    });
    const kernel = new GovernedDocumentAssetWriteKernel({ repository, markdown });

    const result = await kernel.commit(input);

    expect(result).toMatchObject({ replayed: false, receipt: { disposition: "complete" } });
    expect(repository.completeHead).toBe(3);
    expect(repository.events).toEqual(["prepare", "complete-cas"]);
    expect(markdown.commit).toHaveBeenCalledOnce();
    expect(result.receipt.completionContractHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("相同 idempotency key + request hash 返回同一 receipt，不重复写 Markdown", async () => {
    const repository = new FakeRepository();
    const markdown = adapter();
    const kernel = new GovernedDocumentAssetWriteKernel({ repository, markdown });
    const first = await kernel.commit(input);

    const replay = await kernel.commit(input);

    expect(replay).toEqual({ receipt: first.receipt, replayed: true });
    expect(markdown.commit).toHaveBeenCalledOnce();
  });

  test("相同 idempotency key + 不同 request hash fail closed", async () => {
    const repository = new FakeRepository();
    const markdown = adapter();
    const kernel = new GovernedDocumentAssetWriteKernel({ repository, markdown });
    await kernel.commit(input);

    await expect(kernel.commit({
      ...input,
      canonicalPath: "Memory/Rules/project/moved-doc_1.md",
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(markdown.commit).toHaveBeenCalledOnce();
  });

  test("fault before staging 记录 aborted，旧 complete head 不推进", async () => {
    const repository = new FakeRepository({ before_staging: "aborted" });
    const markdown = adapter(async () => {
      throw new GovernedDocumentMarkdownCommitError("before_staging", "unavailable");
    });
    const kernel = new GovernedDocumentAssetWriteKernel({ repository, markdown });

    const result = await kernel.commit(input);

    expect(result.receipt.disposition).toBe("aborted");
    expect(repository.completeHead).toBe(2);
    expect(repository.events).toEqual(["prepare", "incomplete:before_staging"]);
  });

  test("fault after write 记录 pending，保留已写 bytes 但不推进 head", async () => {
    const repository = new FakeRepository({ after_write: "pending" });
    let written = "";
    const markdown = adapter(async (commitInput) => {
      written = commitInput.markdown;
      throw new GovernedDocumentMarkdownCommitError("after_write", "rename interrupted");
    });
    const kernel = new GovernedDocumentAssetWriteKernel({ repository, markdown });

    const result = await kernel.commit(input);

    expect(result.receipt.disposition).toBe("pending");
    expect(written).toBe(renderGovernedDocumentMarkdown(input.asset));
    expect(repository.completeHead).toBe(2);
  });

  test("parse-back mismatch 记录 conflict 且不推进 head", async () => {
    const repository = new FakeRepository({ parse_back: "conflict" });
    const markdown = adapter(async (commitInput) => ({
      markdown: commitInput.markdown.replace(
        "双侧校验前保留旧 complete head。",
        "未校验也推进 head。",
      ),
    }));
    const kernel = new GovernedDocumentAssetWriteKernel({ repository, markdown });

    const result = await kernel.commit(input);

    expect(result.receipt.disposition).toBe("conflict");
    expect(repository.completeHead).toBe(2);
    expect(repository.events).toEqual(["prepare", "incomplete:parse_back"]);
    expect(repository.incompleteInputs[0]?.reason).toBe("PARSE_BACK_FAILED");
  });

  test("parse-back identity 与 completion contract 不一致时不推进 head", async () => {
    const repository = new FakeRepository({ parse_back: "conflict" });
    const markdown = adapter(async (commitInput) => ({
      markdown: commitInput.markdown.replace("mengshu_state: active", "mengshu_state: review"),
    }));
    const kernel = new GovernedDocumentAssetWriteKernel({ repository, markdown });

    const result = await kernel.commit(input);

    expect(result.receipt.disposition).toBe("conflict");
    expect(repository.completeHead).toBe(2);
    expect(repository.incompleteInputs[0]?.reason).toBe("COMPLETION_CONTRACT_MISMATCH");
  });

  test("complete-head CAS mismatch 记录 pending 且不推进 head", async () => {
    const repository = new FakeRepository({ head_cas: "pending" });
    repository.failCas = true;
    const kernel = new GovernedDocumentAssetWriteKernel({
      repository,
      markdown: adapter(),
    });

    const result = await kernel.commit(input);

    expect(result.receipt.disposition).toBe("pending");
    expect(repository.completeHead).toBe(2);
    expect(repository.events).toEqual(["prepare", "complete-cas", "incomplete:head_cas"]);
  });

  test("repository 返回漂移的 complete receipt 时拒绝伪造成功", async () => {
    const repository = new FakeRepository();
    repository.completePreparedVersion = async (completeInput) => ({
      state: "complete",
      receipt: {
        ...(await new FakeRepository().recordIncomplete({
          prepared: completeInput.prepared,
          phase: "head_cas",
          reason: "HEAD_CAS_MISMATCH",
        })),
        disposition: "complete",
        requestHash: "f".repeat(64),
      },
    });
    const kernel = new GovernedDocumentAssetWriteKernel({ repository, markdown: adapter() });

    await expect(kernel.commit(input)).rejects.toBeInstanceOf(GovernedDocumentWriteError);
    expect(repository.completeHead).toBe(2);
  });
});
