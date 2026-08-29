import { describe, expect, test } from "vitest";

import {
  GovernedDocumentMarkdownCommitError,
  GovernedDocumentWriteContractError,
  validateDocumentAssetCommitReceipt,
} from "./repository.js";

const receipt = Object.freeze({
  receiptId: "receipt_1",
  vaultId: "vault_1",
  idempotencyKey: "commit_doc_1_v3",
  requestHash: "a".repeat(64),
  assetId: "doc_1",
  assetVersion: 3,
  postgresPublicContentHash: "b".repeat(64),
  markdownPublicContentHash: "b".repeat(64),
  governanceProjectionHash: "c".repeat(64),
  completionContractHash: "d".repeat(64),
  disposition: "complete" as const,
  createdAt: "2026-08-28T08:00:00.000Z",
});

describe("governed document write repository contract", () => {
  test("严格校验并冻结 repository 返回的 completion receipt", () => {
    const validated = validateDocumentAssetCommitReceipt(receipt, {
      vaultId: receipt.vaultId,
      idempotencyKey: receipt.idempotencyKey,
      requestHash: receipt.requestHash,
      assetId: receipt.assetId,
      assetVersion: receipt.assetVersion,
      postgresPublicContentHash: receipt.postgresPublicContentHash,
      markdownPublicContentHash: receipt.markdownPublicContentHash,
      governanceProjectionHash: receipt.governanceProjectionHash,
      completionContractHash: receipt.completionContractHash,
    });

    expect(validated).toEqual(receipt);
    expect(Object.isFrozen(validated)).toBe(true);
  });

  test("receipt identity/hash/disposition 漂移时 fail closed", () => {
    expect(() => validateDocumentAssetCommitReceipt({
      ...receipt,
      requestHash: "not-a-hash",
    })).toThrow(GovernedDocumentWriteContractError);
    expect(() => validateDocumentAssetCommitReceipt({
      ...receipt,
      disposition: "unknown",
    } as never)).toThrow(/receipt|disposition/i);
    expect(() => validateDocumentAssetCommitReceipt(receipt, {
      requestHash: "e".repeat(64),
    })).toThrow(/receipt|requestHash/i);
  });

  test("Markdown adapter fault 保留确定的写入阶段", () => {
    const before = new GovernedDocumentMarkdownCommitError("before_staging", "disk unavailable");
    const after = new GovernedDocumentMarkdownCommitError("after_write", "rename interrupted");

    expect(before.phase).toBe("before_staging");
    expect(after.phase).toBe("after_write");
    expect(before.message).not.toContain("disk unavailable");
  });
});
