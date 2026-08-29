import type {
  DocumentAssetCommitReceipt,
  GovernedDocumentAssetVersion,
} from "./types.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RECEIPT_KEYS = Object.freeze([
  "receiptId",
  "vaultId",
  "idempotencyKey",
  "requestHash",
  "assetId",
  "assetVersion",
  "postgresPublicContentHash",
  "markdownPublicContentHash",
  "governanceProjectionHash",
  "completionContractHash",
  "disposition",
  "createdAt",
] as const);
const DISPOSITIONS = new Set<DocumentAssetCommitReceipt["disposition"]>([
  "complete", "pending", "conflict", "aborted",
]);

export class GovernedDocumentWriteContractError extends Error {
  constructor(message: string) {
    super(`GOVERNED_DOCUMENT_WRITE_CONTRACT_INVALID: ${message}`);
    this.name = "GovernedDocumentWriteContractError";
  }
}

function fail(message: string): never {
  throw new GovernedDocumentWriteContractError(message);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) fail(`${label} is invalid`);
  return value;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(`${label} is invalid`);
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
      new Date(Date.parse(value)).toISOString() !== value) {
    fail("receipt createdAt is invalid");
  }
  return value;
}

export type DocumentAssetCommitReceiptExpectation = Readonly<Partial<Pick<
DocumentAssetCommitReceipt,
"vaultId" | "idempotencyKey" | "requestHash" | "assetId" | "assetVersion" |
"postgresPublicContentHash" | "markdownPublicContentHash" | "governanceProjectionHash" |
"completionContractHash" | "disposition"
>>>;

export function validateDocumentAssetCommitReceipt(
  value: unknown,
  expected: DocumentAssetCommitReceiptExpectation = {},
): DocumentAssetCommitReceipt {
  if (!plainRecord(value) || Object.keys(value).length !== RECEIPT_KEYS.length ||
      Object.keys(value).some((key) => !RECEIPT_KEYS.includes(key as typeof RECEIPT_KEYS[number])) ||
      !Number.isSafeInteger(value.assetVersion) || (value.assetVersion as number) < 1 ||
      typeof value.disposition !== "string" ||
      !DISPOSITIONS.has(value.disposition as DocumentAssetCommitReceipt["disposition"])) {
    fail("receipt shape or disposition is invalid");
  }
  const receipt = Object.freeze({
    receiptId: safeId(value.receiptId, "receiptId"),
    vaultId: safeId(value.vaultId, "vaultId"),
    idempotencyKey: safeId(value.idempotencyKey, "idempotencyKey"),
    requestHash: sha256(value.requestHash, "requestHash"),
    assetId: safeId(value.assetId, "assetId"),
    assetVersion: value.assetVersion as number,
    postgresPublicContentHash: sha256(
      value.postgresPublicContentHash,
      "postgresPublicContentHash",
    ),
    markdownPublicContentHash: sha256(
      value.markdownPublicContentHash,
      "markdownPublicContentHash",
    ),
    governanceProjectionHash: sha256(
      value.governanceProjectionHash,
      "governanceProjectionHash",
    ),
    completionContractHash: sha256(value.completionContractHash, "completionContractHash"),
    disposition: value.disposition as DocumentAssetCommitReceipt["disposition"],
    createdAt: timestamp(value.createdAt),
  });
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (expectedValue !== undefined && receipt[key as keyof DocumentAssetCommitReceipt] !== expectedValue) {
      fail(`receipt ${key} does not match the write request`);
    }
  }
  return receipt;
}

export interface PrepareGovernedDocumentVersionInput {
  readonly asset: GovernedDocumentAssetVersion;
  readonly vaultId: string;
  readonly canonicalPath: string;
  readonly idempotencyKey: string;
  readonly expectedCompleteVersion: number;
  readonly requestHash: string;
  readonly completionContractHash: string;
  readonly renderHash: string;
}

export interface PreparedGovernedDocumentVersion extends PrepareGovernedDocumentVersionInput {
  /** Opaque provider token binding completion/failure to the prepared durable version. */
  readonly prepareToken: string;
}

export type PrepareGovernedDocumentVersionResult =
  | Readonly<{ state: "replayed"; receipt: DocumentAssetCommitReceipt }>
  | Readonly<{ state: "prepared"; prepared: PreparedGovernedDocumentVersion }>;

export interface CompletePreparedDocumentInput {
  readonly prepared: PreparedGovernedDocumentVersion;
  readonly markdownPublicContentHash: string;
  readonly renderHash: string;
}

export type CompletePreparedDocumentResult =
  | Readonly<{ state: "complete"; receipt: DocumentAssetCommitReceipt }>
  | Readonly<{ state: "cas_mismatch" }>;

export type GovernedDocumentWriteFailurePhase =
  | "before_staging"
  | "after_write"
  | "parse_back"
  | "head_cas";

export type GovernedDocumentWriteFailureReason =
  | "MARKDOWN_COMMIT_FAILED"
  | "PARSE_BACK_FAILED"
  | "COMPLETION_CONTRACT_MISMATCH"
  | "HEAD_CAS_MISMATCH"
  | "HEAD_CAS_FAILED";

export interface RecordIncompleteDocumentInput {
  readonly prepared: PreparedGovernedDocumentVersion;
  readonly phase: GovernedDocumentWriteFailurePhase;
  readonly reason: GovernedDocumentWriteFailureReason;
  readonly markdownPublicContentHash?: string;
  readonly renderHash?: string;
}

export interface GovernedDocumentWriteRepositoryPort {
  /** Atomically checks the scoped idempotency key and persists a sync_pending version. */
  prepareVersion(
    input: PrepareGovernedDocumentVersionInput,
  ): Promise<PrepareGovernedDocumentVersionResult>;

  /** Atomically CASes complete head, completes the binding, and persists the complete receipt. */
  completePreparedVersion(
    input: CompletePreparedDocumentInput,
  ): Promise<CompletePreparedDocumentResult>;

  /** Persists provider-owned pending/aborted/conflict disposition without advancing complete head. */
  recordIncomplete(input: RecordIncompleteDocumentInput): Promise<DocumentAssetCommitReceipt>;
}

export interface CommitGovernedDocumentMarkdownInput {
  readonly asset: GovernedDocumentAssetVersion;
  readonly vaultId: string;
  readonly canonicalPath: string;
  readonly assetId: string;
  readonly assetVersion: number;
  readonly requestHash: string;
  readonly renderHash: string;
  readonly markdown: string;
}

export interface GovernedDocumentMarkdownCommitResult {
  /** Exact committed bytes read after fsync/atomic rename for parse-back verification. */
  readonly markdown: string;
}

export interface GovernedDocumentMarkdownAdapterPort {
  commit(
    input: CommitGovernedDocumentMarkdownInput,
  ): Promise<GovernedDocumentMarkdownCommitResult>;
}

export class GovernedDocumentMarkdownCommitError extends Error {
  readonly phase: "before_staging" | "after_write";

  constructor(phase: "before_staging" | "after_write", _privateDetail?: string) {
    super(`GOVERNED_DOCUMENT_MARKDOWN_COMMIT_FAILED:${phase}`);
    this.name = "GovernedDocumentMarkdownCommitError";
    this.phase = phase;
  }
}
