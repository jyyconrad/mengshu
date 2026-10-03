import { authorityScopeFingerprint } from "../../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../../domain/types.js";
import type { GovernedDocumentReadRepository } from "../read-service.js";
import type {
  CompletePreparedDocumentInput,
  CompletePreparedDocumentResult,
  GovernedDocumentWriteRepositoryPort,
  PrepareGovernedDocumentVersionInput,
  PrepareGovernedDocumentVersionResult,
  PreparedGovernedDocumentVersion,
  RecordIncompleteDocumentInput,
} from "../repository.js";
import { validateDocumentAssetCommitReceipt } from "../repository.js";
import type {
  DocumentAssetCommitReceipt,
  GovernedDocumentAssetVersion,
  GovernedDocumentIndex,
} from "../types.js";
import type { TypedPageBindings } from "./assemble-typed-page.js";

export interface RetainedTypedPageVersion {
  readonly asset: GovernedDocumentAssetVersion;
  readonly bindings: TypedPageBindings;
}

/**
 * In-process version ledger for one governed document asset.
 * It implements the existing write and read ports and keeps every complete head.
 */
export class RetainedGovernedDocumentStore implements
  GovernedDocumentWriteRepositoryPort,
  GovernedDocumentReadRepository {
  readonly completeVersions: RetainedTypedPageVersion[] = [];
  private readonly versions = new Map<string, GovernedDocumentAssetVersion>();
  private readonly bindings = new Map<string, TypedPageBindings>();
  private readonly heads = new Map<string, number>();
  private readonly receipts = new Map<string, DocumentAssetCommitReceipt>();
  private receiptCount = 0;

  constructor(private readonly createdAt: () => string) {}

  headVersion(scope: MemoryScope, assetId: string): number {
    return this.heads.get(this.#headKey(scope, assetId)) ?? 0;
  }

  async getComplete(
    scope: MemoryScope,
    assetId: string,
  ): Promise<GovernedDocumentAssetVersion | undefined> {
    const version = this.headVersion(scope, assetId);
    if (version < 1) return undefined;
    return this.versions.get(this.#versionKey(scope, assetId, version));
  }

  async getVersion(
    scope: MemoryScope,
    assetId: string,
    assetVersion: number,
  ): Promise<GovernedDocumentAssetVersion | undefined> {
    return this.versions.get(this.#versionKey(scope, assetId, assetVersion));
  }

  async getIndex(
    _scope: MemoryScope,
    _assetId: string,
    _assetVersion: number,
  ): Promise<GovernedDocumentIndex | undefined> {
    return undefined;
  }

  readVersion(
    scope: MemoryScope,
    assetId: string,
    assetVersion: number,
  ): RetainedTypedPageVersion | undefined {
    const asset = this.versions.get(this.#versionKey(scope, assetId, assetVersion));
    const bindings = this.bindings.get(this.#versionKey(scope, assetId, assetVersion));
    if (!asset || !bindings) return undefined;
    return Object.freeze({ asset, bindings });
  }

  putBindings(scope: MemoryScope, assetId: string, assetVersion: number, bindings: TypedPageBindings): void {
    this.bindings.set(this.#versionKey(scope, assetId, assetVersion), bindings);
  }

  async prepareVersion(
    input: PrepareGovernedDocumentVersionInput,
  ): Promise<PrepareGovernedDocumentVersionResult> {
    const existing = this.receipts.get(`${input.vaultId}\0${input.idempotencyKey}`);
    if (existing) return Object.freeze({ state: "replayed" as const, receipt: existing });
    const head = this.headVersion(input.asset.scope, input.asset.assetId);
    if (head !== input.expectedCompleteVersion) throw new Error("HEAD_CAS_CONFLICT");
    const prepared = Object.freeze({
      ...input,
      prepareToken: `prep_${input.asset.assetId}_${input.asset.assetVersion}`,
    });
    return Object.freeze({ state: "prepared" as const, prepared });
  }

  async completePreparedVersion(
    input: CompletePreparedDocumentInput,
  ): Promise<CompletePreparedDocumentResult> {
    const prepared = input.prepared;
    const head = this.headVersion(prepared.asset.scope, prepared.asset.assetId);
    if (head !== prepared.expectedCompleteVersion) {
      return Object.freeze({ state: "cas_mismatch" as const });
    }
    const receipt = this.#receipt(prepared, "complete", input.markdownPublicContentHash);
    this.versions.set(
      this.#versionKey(prepared.asset.scope, prepared.asset.assetId, prepared.asset.assetVersion),
      prepared.asset,
    );
    this.heads.set(
      this.#headKey(prepared.asset.scope, prepared.asset.assetId),
      prepared.asset.assetVersion,
    );
    this.receipts.set(`${prepared.vaultId}\0${prepared.idempotencyKey}`, receipt);
    this.completeVersions.push(Object.freeze({
      asset: prepared.asset,
      bindings: this.bindings.get(this.#versionKey(
        prepared.asset.scope,
        prepared.asset.assetId,
        prepared.asset.assetVersion,
      )) ?? { claimEvidence: Object.freeze({}), inputRefs: Object.freeze({}) },
    }));
    return Object.freeze({ state: "complete" as const, receipt });
  }

  async recordIncomplete(input: RecordIncompleteDocumentInput): Promise<DocumentAssetCommitReceipt> {
    const receipt = this.#receipt(
      input.prepared,
      "pending",
      input.markdownPublicContentHash ?? input.prepared.asset.publicContentHash,
    );
    this.receipts.set(`${input.prepared.vaultId}\0${input.prepared.idempotencyKey}`, receipt);
    return receipt;
  }

  #receipt(
    prepared: PreparedGovernedDocumentVersion,
    disposition: DocumentAssetCommitReceipt["disposition"],
    markdownPublicContentHash: string,
  ): DocumentAssetCommitReceipt {
    this.receiptCount += 1;
    return validateDocumentAssetCommitReceipt({
      receiptId: `receipt_${prepared.asset.assetId}_${prepared.asset.assetVersion}_${this.receiptCount}`,
      vaultId: prepared.vaultId,
      idempotencyKey: prepared.idempotencyKey,
      requestHash: prepared.requestHash,
      assetId: prepared.asset.assetId,
      assetVersion: prepared.asset.assetVersion,
      postgresPublicContentHash: prepared.asset.publicContentHash,
      markdownPublicContentHash,
      governanceProjectionHash: prepared.asset.governanceProjectionHash,
      completionContractHash: prepared.completionContractHash,
      disposition,
      createdAt: this.createdAt(),
    });
  }

  #headKey(scope: MemoryScope, assetId: string): string {
    return `${authorityScopeFingerprint(scope)}\0${assetId}`;
  }

  #versionKey(scope: MemoryScope, assetId: string, assetVersion: number): string {
    return `${this.#headKey(scope, assetId)}\0${assetVersion}`;
  }
}
