import { createHash } from "node:crypto";

import {
  computeCompletionContractHash,
  validateGovernedDocumentAssetVersion,
} from "./canonical.js";
import {
  parseGovernedDocumentMarkdown,
  renderGovernedDocumentMarkdown,
} from "./markdown-codec.js";
import {
  GovernedDocumentMarkdownCommitError,
  GovernedDocumentWriteContractError,
  validateDocumentAssetCommitReceipt,
  type DocumentAssetCommitReceiptExpectation,
  type GovernedDocumentMarkdownAdapterPort,
  type GovernedDocumentWriteFailureReason,
  type GovernedDocumentWriteRepositoryPort,
  type PreparedGovernedDocumentVersion,
} from "./repository.js";
import type {
  DocumentAssetCommitReceipt,
  GovernedDocumentAssetVersion,
  GovernedDocumentCompletionContract,
  ParsedGovernedDocumentMarkdown,
} from "./types.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;

export type GovernedDocumentWriteErrorCode =
  | "INVALID_INPUT"
  | "IDEMPOTENCY_CONFLICT"
  | "REPOSITORY_CONTRACT_INVALID";

export class GovernedDocumentWriteError extends Error {
  readonly code: GovernedDocumentWriteErrorCode;

  constructor(code: GovernedDocumentWriteErrorCode) {
    super(`GOVERNED_DOCUMENT_WRITE_FAILED:${code}`);
    this.name = "GovernedDocumentWriteError";
    this.code = code;
  }
}

export interface CommitGovernedDocumentAssetInput {
  readonly asset: GovernedDocumentAssetVersion;
  readonly vaultId: string;
  readonly canonicalPath: string;
  readonly idempotencyKey: string;
  readonly expectedCompleteVersion: number;
}

export interface CommitGovernedDocumentAssetResult {
  readonly receipt: DocumentAssetCommitReceipt;
  readonly replayed: boolean;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function completionContract(asset: GovernedDocumentAssetVersion): GovernedDocumentCompletionContract {
  return {
    assetId: asset.assetId,
    assetVersion: asset.assetVersion,
    schemaVersion: asset.schemaVersion,
    kind: asset.kind,
    purpose: asset.purpose,
    ...(asset.semanticType === undefined ? {} : { semanticType: asset.semanticType }),
    ...(asset.semanticTypes === undefined ? {} : { semanticTypes: asset.semanticTypes }),
    ...(asset.treeRef === undefined ? {} : { treeRef: asset.treeRef }),
    lifecycleState: asset.lifecycleState,
    governanceState: asset.governanceState,
    scopeFingerprint: asset.scopeFingerprint,
    publicContentHash: asset.publicContentHash,
    governanceProjectionHash: asset.governanceProjectionHash,
  };
}

function parsedCompletionContract(
  parsed: ParsedGovernedDocumentMarkdown,
  governanceProjectionHash: string,
): GovernedDocumentCompletionContract {
  return {
    ...parsed.identity,
    governanceProjectionHash,
  };
}

function validateId(value: string, label: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new GovernedDocumentWriteError("INVALID_INPUT");
  }
  return value;
}

function validateCanonicalPath(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096 ||
      value.startsWith("/") || value.includes("\\") || /[\p{Cc}]/u.test(value) ||
      value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new GovernedDocumentWriteError("INVALID_INPUT");
  }
  return value;
}

export function computeGovernedDocumentWriteRequestHash(input: Readonly<{
  vaultId: string;
  canonicalPath: string;
  expectedCompleteVersion: number;
  completionContractHash: string;
}>): string {
  return sha256(JSON.stringify([
    "mengshu.governed-document-write/v1",
    input.vaultId,
    input.canonicalPath,
    input.expectedCompleteVersion,
    input.completionContractHash,
  ]));
}

function expectedReceipt(
  prepared: PreparedGovernedDocumentVersion,
): DocumentAssetCommitReceiptExpectation {
  return {
    vaultId: prepared.vaultId,
    idempotencyKey: prepared.idempotencyKey,
    requestHash: prepared.requestHash,
    assetId: prepared.asset.assetId,
    assetVersion: prepared.asset.assetVersion,
    postgresPublicContentHash: prepared.asset.publicContentHash,
    governanceProjectionHash: prepared.asset.governanceProjectionHash,
    completionContractHash: prepared.completionContractHash,
  };
}

function contractError(): never {
  throw new GovernedDocumentWriteError("REPOSITORY_CONTRACT_INVALID");
}

function validatePrepared(
  prepared: PreparedGovernedDocumentVersion,
  expected: Omit<PreparedGovernedDocumentVersion, "prepareToken">,
): PreparedGovernedDocumentVersion {
  try {
    validateId(prepared.prepareToken, "prepareToken");
    const asset = validateGovernedDocumentAssetVersion(prepared.asset);
    if (prepared.vaultId !== expected.vaultId ||
        prepared.canonicalPath !== expected.canonicalPath ||
        prepared.idempotencyKey !== expected.idempotencyKey ||
        prepared.expectedCompleteVersion !== expected.expectedCompleteVersion ||
        prepared.requestHash !== expected.requestHash ||
        prepared.completionContractHash !== expected.completionContractHash ||
        prepared.renderHash !== expected.renderHash ||
        asset.assetId !== expected.asset.assetId ||
        asset.assetVersion !== expected.asset.assetVersion ||
        computeCompletionContractHash(completionContract(asset)) !== expected.completionContractHash) {
      contractError();
    }
    return prepared;
  } catch (error) {
    if (error instanceof GovernedDocumentWriteError &&
        error.code === "REPOSITORY_CONTRACT_INVALID") throw error;
    contractError();
  }
}

function validateReceipt(
  value: unknown,
  expected: DocumentAssetCommitReceiptExpectation,
): DocumentAssetCommitReceipt {
  try {
    return validateDocumentAssetCommitReceipt(value, expected);
  } catch (error) {
    if (error instanceof GovernedDocumentWriteContractError) contractError();
    throw error;
  }
}

async function incomplete(
  repository: GovernedDocumentWriteRepositoryPort,
  prepared: PreparedGovernedDocumentVersion,
  input: {
    readonly phase: Parameters<GovernedDocumentWriteRepositoryPort["recordIncomplete"]>[0]["phase"];
    readonly reason: GovernedDocumentWriteFailureReason;
    readonly markdownPublicContentHash?: string;
    readonly renderHash?: string;
  },
): Promise<CommitGovernedDocumentAssetResult> {
  const receipt = validateReceipt(await repository.recordIncomplete({
    prepared,
    ...input,
  }), expectedReceipt(prepared));
  if (receipt.disposition === "complete") contractError();
  return Object.freeze({ receipt, replayed: false });
}

export class GovernedDocumentAssetWriteKernel {
  constructor(private readonly dependencies: Readonly<{
    repository: GovernedDocumentWriteRepositoryPort;
    markdown: GovernedDocumentMarkdownAdapterPort;
  }>) {}

  async commit(
    input: CommitGovernedDocumentAssetInput,
  ): Promise<CommitGovernedDocumentAssetResult> {
    let asset: GovernedDocumentAssetVersion;
    try {
      asset = validateGovernedDocumentAssetVersion(input.asset);
    } catch {
      throw new GovernedDocumentWriteError("INVALID_INPUT");
    }
    const vaultId = validateId(input.vaultId, "vaultId");
    const idempotencyKey = validateId(input.idempotencyKey, "idempotencyKey");
    const canonicalPath = validateCanonicalPath(input.canonicalPath);
    if (!Number.isSafeInteger(input.expectedCompleteVersion) || input.expectedCompleteVersion < 0 ||
        asset.assetVersion !== input.expectedCompleteVersion + 1) {
      throw new GovernedDocumentWriteError("INVALID_INPUT");
    }

    const completionContractHash = computeCompletionContractHash(completionContract(asset));
    const requestHash = computeGovernedDocumentWriteRequestHash({
      vaultId,
      canonicalPath,
      expectedCompleteVersion: input.expectedCompleteVersion,
      completionContractHash,
    });
    const rendered = renderGovernedDocumentMarkdown(asset);
    const renderHash = sha256(rendered);
    const prepareInput = Object.freeze({
      asset,
      vaultId,
      canonicalPath,
      idempotencyKey,
      expectedCompleteVersion: input.expectedCompleteVersion,
      requestHash,
      completionContractHash,
      renderHash,
    });
    const preparation = await this.dependencies.repository.prepareVersion(prepareInput);
    if (preparation.state === "replayed") {
      let receipt: DocumentAssetCommitReceipt;
      try {
        receipt = validateDocumentAssetCommitReceipt(preparation.receipt);
      } catch {
        contractError();
      }
      if (receipt.requestHash !== requestHash) {
        throw new GovernedDocumentWriteError("IDEMPOTENCY_CONFLICT");
      }
      receipt = validateReceipt(receipt, expectedReceipt({
        ...prepareInput,
        prepareToken: "replay",
      }));
      if (receipt.disposition === "complete" &&
          receipt.markdownPublicContentHash !== asset.publicContentHash) {
        contractError();
      }
      return Object.freeze({ receipt, replayed: true });
    }
    if (preparation.state !== "prepared" || !preparation.prepared) contractError();
    const prepared = validatePrepared(preparation.prepared, prepareInput);

    let committedMarkdown: string;
    try {
      const committed = await this.dependencies.markdown.commit({
        asset,
        vaultId,
        canonicalPath,
        assetId: asset.assetId,
        assetVersion: asset.assetVersion,
        requestHash,
        renderHash,
        markdown: rendered,
      });
      if (!committed || typeof committed.markdown !== "string") {
        throw new GovernedDocumentMarkdownCommitError("after_write");
      }
      committedMarkdown = committed.markdown;
    } catch (error) {
      return incomplete(this.dependencies.repository, prepared, {
        phase: error instanceof GovernedDocumentMarkdownCommitError
          ? error.phase : "after_write",
        reason: "MARKDOWN_COMMIT_FAILED",
        renderHash,
      });
    }

    const committedRenderHash = sha256(committedMarkdown);
    let parsed: ParsedGovernedDocumentMarkdown;
    try {
      parsed = parseGovernedDocumentMarkdown(committedMarkdown);
    } catch {
      return incomplete(this.dependencies.repository, prepared, {
        phase: "parse_back",
        reason: "PARSE_BACK_FAILED",
        renderHash: committedRenderHash,
      });
    }
    let observedCompletionHash: string;
    try {
      observedCompletionHash = computeCompletionContractHash(parsedCompletionContract(
        parsed,
        asset.governanceProjectionHash,
      ));
    } catch {
      observedCompletionHash = "";
    }
    if (observedCompletionHash !== completionContractHash) {
      return incomplete(this.dependencies.repository, prepared, {
        phase: "parse_back",
        reason: "COMPLETION_CONTRACT_MISMATCH",
        markdownPublicContentHash: parsed.identity.publicContentHash,
        renderHash: committedRenderHash,
      });
    }

    let completion;
    try {
      completion = await this.dependencies.repository.completePreparedVersion({
        prepared,
        markdownPublicContentHash: parsed.identity.publicContentHash,
        renderHash: committedRenderHash,
      });
    } catch {
      return incomplete(this.dependencies.repository, prepared, {
        phase: "head_cas",
        reason: "HEAD_CAS_FAILED",
        markdownPublicContentHash: parsed.identity.publicContentHash,
        renderHash: committedRenderHash,
      });
    }
    if (completion.state === "cas_mismatch") {
      return incomplete(this.dependencies.repository, prepared, {
        phase: "head_cas",
        reason: "HEAD_CAS_MISMATCH",
        markdownPublicContentHash: parsed.identity.publicContentHash,
        renderHash: committedRenderHash,
      });
    }
    if (completion.state !== "complete" || !completion.receipt) contractError();
    const receipt = validateReceipt(completion.receipt, {
      ...expectedReceipt(prepared),
      markdownPublicContentHash: parsed.identity.publicContentHash,
      disposition: "complete",
    });
    return Object.freeze({ receipt, replayed: false });
  }
}
