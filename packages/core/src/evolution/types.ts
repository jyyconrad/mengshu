import type { AuthorityScope } from "../domain/authority-scope.js";
import type { MemoryKind, MemoryScope, MemorySemanticType } from "../domain/types.js";
import type { CandidateValidationReceiptV1 } from "../lifecycle/candidate-validation-receipt.js";
import type { SourceRecordLocator } from "./sources/types.js";

export type EvolutionInput =
  | { mode: "inventory"; selection: "baseline" | "changed" | "due" }
  | { mode: "directory"; sourceId: string };
export type EvolutionAction = "preview" | "propose" | "apply_allowed";
export interface EvolutionLimits {
  maxRecords: number;
  maxFiles: number;
  maxBytes: number;
  maxLlmCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxDurationMs: number;
}
export interface EvolutionRunRequest {
  input: EvolutionInput;
  action: EvolutionAction;
  limits?: Partial<EvolutionLimits>;
  idempotencyKey: string;
}
export type EvolutionControlWork =
  | { kind: "source_reconcile"; sourceId: string }
  | { kind: "source_revoke"; sourceId: string; expectedRevision: string; reviewReceiptId: string }
  | { kind: "undo_governance"; operationReceiptId: string; currentStateHash: string; reviewReceiptId: string };
export interface EvolutionControlRequest {
  input: { mode: "control"; work: EvolutionControlWork };
  action: "execute_control";
  limits?: Partial<Pick<EvolutionLimits, "maxRecords" | "maxFiles" | "maxBytes" | "maxDurationMs">>;
  idempotencyKey: string;
}
export interface EvolutionControlResult {
  status: "completed" | "partial";
  receiptId: string;
  /** Omitted when the durable port cannot enumerate the impact; never infer zero. */
  affectedMemoryIds?: string[];
  sourceManifestConfirmed?: boolean;
  sourceSnapshotHash?: string;
  reasons?: string[];
}
export interface EvolutionControlPort {
  /** Called only for explicit owner preparation/resume, never for automatic worker retries. */
  authorizePrepare(request: EvolutionControlRequest): Promise<void>;
  /** Runs under the existing batch/job lease after durable pessimistic I/O reservation. */
  execute(context: {
    request: EvolutionControlRequest & { limits: EvolutionLimits };
    batchId: string; scope: MemoryScope; lease: EvolutionLease;
    limits: EvolutionLimits; signal: AbortSignal;
  }): Promise<EvolutionControlResult>;
}
export type EvolutionBatchStatus = "queued" | "running" | "completed" | "partial" | "blocked" | "cancelled" | "failed";
export type EvolutionOperation =
  | "create" | "add_evidence" | "merge_equivalent" | "split_conditions"
  | "evolve" | "correct" | "mark_disputed" | "deprecate" | "expire"
  | "revalidate" | "compile_pattern" | "propose_skill" | "noop";
export type EvolutionClaimClass = "preference" | "fact" | "decision" | "constraint" | "task" | "experience" | "skill";
export type EvolutionReasonCode = "new_claim" | "independent_support" | "explicit_correction" | "attribute_changed"
  | "conflicting_evidence" | "equivalent_claim" | "mixed_conditions" | "applicability_ended"
  | "source_changed" | "pattern_observed" | "unchanged" | "format_only";
export type EvolutionJson = null | boolean | number | string | EvolutionJson[] | { [key: string]: EvolutionJson };

export interface EvolutionKey { createdAt: number; memoryId: string }
export interface EvolutionInputSnapshot {
  selectionEpoch: number;
  upperKey?: EvolutionKey;
  /** Opaque, bounded input-adapter state. Never a copy of input documents. */
  state?: EvolutionJson;
}
export type EvolutionCursor = EvolutionJson;
export interface EvolutionTargetRef { memoryId: string; expectedRevision: number; beforeHash: string }
export interface EvolutionTarget extends EvolutionTargetRef {
  text: string;
  scope: MemoryScope;
  kind: MemoryKind;
  semanticType?: MemorySemanticType;
  createdAt: number;
  evidenceRootIds: string[];
  pinned?: boolean;
  tombstoned?: boolean;
  highImpact?: boolean;
  validFrom?: number;
  validTo?: number;
}
export interface EvolutionEvidence {
  id: string;
  sourceId: string;
  revision: string;
  snapshotHash: string;
  text: string;
  scope: MemoryScope;
  rootEvidenceId: string;
  origin: "external" | "canonical" | "evaluation";
  /** Trust is assigned by a host adapter, never from log roles/frontmatter. */
  trust: "untrusted" | "user_statement" | "verified_document" | "verified_result";
  /** A host adapter detected truncated context; quoted claims must remain owner-review. */
  contextIncomplete?: boolean;
  occurredAt?: number;
  revoked?: boolean;
  locator?: string;
  authorizedTargetIds?: string[];
  hostAttestation?: EvolutionEvidenceAttestation;
}
export interface EvolutionInputUnit {
  id: string;
  scope: MemoryScope;
  snapshotHash: string;
  targets: EvolutionTarget[];
  evidence: EvolutionEvidence[];
  /** Host-adapter upper bound for each strong source re-read, excluding in-memory validation. */
  verificationBudget?: { records: number; files: number; bytes: number };
  /** Host-generated exact directory checkpoint; never an authorization or copied source body. */
  directoryLocator?: SourceRecordLocator;
  selectionEvent?: { eventId: string; memoryId: string; revision: number; origin: "external" | "evolution" | "access"; causeBatchId?: string };
}
export interface EvolutionPage {
  units: EvolutionInputUnit[];
  nextCursor: EvolutionCursor;
  complete: boolean;
  bytesRead: number;
  filesRead: number;
  /** Includes selected targets/evidence and bounded lookup/lookahead reads not returned as units. */
  recordsRead?: number;
  reasons?: string[];
}
export interface EvolutionInputContext {
  input: EvolutionInput;
  scope: MemoryScope;
  limits: EvolutionLimits;
  signal?: AbortSignal;
}
export interface EvolutionInputPort {
  readonly mode: EvolutionInput["mode"];
  open(context: EvolutionInputContext): Promise<EvolutionInputSnapshot>;
  /** Service requests one bounded unit at a time; cursor is exclusive. */
  readPage(context: EvolutionInputContext & { snapshot: EvolutionInputSnapshot; cursor: EvolutionCursor; limit: number }): Promise<EvolutionPage>;
  /** Re-read source hashes/revocation before staging and before canonical apply. */
  verifyUnit(unit: EvolutionInputUnit, context: EvolutionInputContext): Promise<{ valid: boolean; reason?: string; bytesRead?: number }>;
  readTargets(refs: EvolutionTargetRef[], context: EvolutionInputContext): Promise<EvolutionTarget[]>;
  readProposal?: EvolutionProposalSourcePort["read"];
  /** Called only after the durable per-unit receipt/checkpoint has committed. */
  acknowledge?(context: EvolutionInputContext & { snapshot: EvolutionInputSnapshot; cursor: EvolutionCursor; action?: EvolutionAction; proposalId?: string }): Promise<void>;
}

export interface EvolutionQuote { evidenceId: string; quote: string; start: number; end: number }
export interface EvolutionProposalDraft {
  operation: EvolutionOperation;
  claimClass: EvolutionClaimClass;
  reasonCode: EvolutionReasonCode;
  targetRefs: EvolutionTargetRef[];
  quotes: EvolutionQuote[];
  proposedText?: string;
  kind?: MemoryKind;
  semanticType?: MemorySemanticType;
  profileDimension?: string;
  validFrom?: number;
  validTo?: number;
}
export interface EvolutionValidation {
  outcome: "allowed" | "review" | "rejected" | "noop";
  reasons: string[];
  reviewRequirement: "none" | "owner";
  candidateReceipt?: CandidateValidationReceiptV1;
  /** Only fresh, independently verified external roots may contribute confidence. */
  independentEvidenceRootIds: string[];
  contextEligible: boolean;
  /** Administrative approval never establishes the historical author's identity or new independent support. */
  ownerApprovalReceiptId?: string;
  evidenceMode?: "verified_support" | "reviewed_reference";
}
export interface EvolutionStagedEvidence extends Omit<EvolutionEvidence, "text"> {
  quote: string;
  start: number;
  end: number;
}
export interface EvolutionProposal extends EvolutionProposalDraft {
  id: string;
  batchId: string;
  scope: MemoryScope;
  scopeFingerprint: string;
  inputUnitId: string;
  inputFingerprint: string;
  sourceSnapshotHash: string;
  configFingerprint: string;
  policyVersion: string;
  validation: EvolutionValidation;
  status: "staged" | "rejected" | "review" | "applied" | "noop";
  createdAt: number;
  /** Original immutable proposal whose exact diff was reviewed; set only by the host replay service. */
  reviewedProposalId?: string;
  /** Immutable approval identity also checked by the provider's transaction lock/consume path. */
  ownerApprovalReceiptId?: string;
  /** Host-owned bounded position before this unit, never source body text. */
  inputPosition?: { snapshot: EvolutionInputSnapshot; cursor: EvolutionCursor };
  /** Persisted only from the host input unit, never from a model proposal. */
  directoryLocator?: SourceRecordLocator;
}
export interface EvolutionUsage {
  records: number;
  files: number;
  bytes: number;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}
export interface EvolutionCounts { proposed: number; applied: number; rejected: number; review: number; noop: number; skipped: number }
export interface EvolutionBatch {
  id: string;
  scope: MemoryScope;
  scopeFingerprint: string;
  request: (EvolutionRunRequest | EvolutionControlRequest) & { limits: EvolutionLimits };
  requestHash: string;
  configFingerprint: string;
  policyVersion: string;
  status: EvolutionBatchStatus;
  reasons: string[];
  snapshot?: EvolutionInputSnapshot;
  cursor: EvolutionCursor;
  usage: EvolutionUsage;
  /** Explicit resume starts another bounded segment; run/idempotent retry never resets it. */
  segment?: { attempt: number; usage: EvolutionUsage };
  counts: EvolutionCounts;
  /** Batch-local processed receipt clock already included in counts; not an inventory/event watermark. */
  accountedThrough?: number;
  createdAt: number;
  updatedAt: number;
  version: number;
  cancelRequestedAt?: number;
  approvedReplay?: { proposalId: string; approvalReceiptId: string };
  controlResult?: EvolutionControlResult;
}
export interface EvolutionBatchReport {
  batchId: string;
  status: EvolutionBatchStatus;
  reasons: string[];
  usage: EvolutionUsage;
  usageAccounting?: "budget_reservation";
  segment?: { attempt: number; usage: EvolutionUsage };
  counts: EvolutionCounts;
  checkpoint: { cursor: EvolutionCursor; selectionEpoch?: number; upperKey?: EvolutionKey };
  configFingerprint: string;
  resumable: boolean;
  work?: { kind: "memory_evolution" | EvolutionControlWork["kind"]; result?: EvolutionControlResult };
}
export interface EvolutionLease { batchId: string; scopeFingerprint: string; ownerId: string; fencingToken: number; expiresAt: number }
export interface EvolutionApplyReceipt {
  id: string;
  proposalId: string;
  batchId: string;
  scopeFingerprint: string;
  operation: EvolutionOperation;
  outcome: "applied" | "noop";
  memoryIds: string[];
  committedAt: number;
}
export interface EvolutionProcessedInput {
  scopeFingerprint: string;
  inputFingerprint: string;
  action: "propose" | "apply_allowed";
  proposalId: string;
  processedAt: number;
}
export interface EvolutionRepository {
  /** Atomic scope/idempotency uniqueness; conflicting requestHash must reject. */
  createBatch(batch: EvolutionBatch): Promise<{ batch: EvolutionBatch; created: boolean }>;
  getBatch(batchId: string, scopeFingerprint: string): Promise<EvolutionBatch | undefined>;
  acquireLease(batchId: string, scopeFingerprint: string, ownerId: string, ttlMs: number): Promise<EvolutionLease | undefined>;
  releaseLease(lease: EvolutionLease): Promise<void>;
  saveBatch(batch: EvolutionBatch, expectedVersion: number, lease: EvolutionLease): Promise<EvolutionBatch>;
  /** Persist only quoted spans in isolated proposal storage, never canonical evidence. */
  stageProposal(proposal: EvolutionProposal, evidence: EvolutionStagedEvidence[], lease: EvolutionLease): Promise<EvolutionProposal>;
  getProposal(proposalId: string, scopeFingerprint: string): Promise<EvolutionProposal | undefined>;
  getReceipt(proposalId: string, scopeFingerprint: string): Promise<EvolutionApplyReceipt | undefined>;
  findProcessed(scopeFingerprint: string, inputFingerprint: string, action: "propose" | "apply_allowed"): Promise<EvolutionProcessedInput | undefined>;
  recordProcessed(input: EvolutionProcessedInput, lease: EvolutionLease): Promise<void>;
  /** Control-plane cancellation must survive concurrent leased saveBatch operations. */
  requestCancellation?(batchId: string, scopeFingerprint: string, requestedAt: number): Promise<EvolutionBatch | undefined>;
}
export interface EvolutionApplyContext {
  proposal: EvolutionProposal;
  evidence: EvolutionStagedEvidence[];
  authority: AuthorityScope;
  lease: EvolutionLease;
  signal?: AbortSignal;
  /** Rechecked in the provider-owned transaction, alongside head CAS/tombstones. */
  verifySource: () => Promise<{ valid: boolean; reason?: string }>;
  /** Provider must re-read/lock this immutable approval receipt in its own mutation transaction. */
  approval?: EvolutionReviewReceipt;
}
export type EvolutionApplyResult =
  | { outcome: "applied" | "noop"; receipt: EvolutionApplyReceipt; replayed: boolean }
  | { outcome: "blocked" | "rejected"; reason: string };
export interface EvolutionGovernedWriter {
  readonly supportedOperations: readonly EvolutionOperation[];
  /** Receipt, proposal applied status, evidence activation, CAS and canonical write are atomic. */
  apply(context: EvolutionApplyContext): Promise<EvolutionApplyResult>;
}
export interface EvolutionProposer {
  readonly available: boolean;
  /** Conservative per-request reservation including client retries. */
  readonly maxAttempts: number;
  estimateInputTokens(unit: EvolutionInputUnit): number;
  propose(unit: EvolutionInputUnit, options: { maxOutputTokens: number; timeoutMs: number; signal?: AbortSignal }): Promise<unknown>;
}
export interface MemoryEvolutionBatchServiceOptions {
  authority: AuthorityScope;
  scope: MemoryScope;
  /** Already resolved host-only global model/config fingerprint, without credentials. */
  configFingerprint: string;
  policyVersion?: string;
  repository: EvolutionRepository;
  inputs: readonly EvolutionInputPort[];
  proposer?: EvolutionProposer;
  writer?: EvolutionGovernedWriter;
  now?: () => number;
  ownerId?: string;
  reviews?: EvolutionReviewRepository;
  proposalSource?: EvolutionProposalSourcePort;
  control?: EvolutionControlPort;
}

/** Provider-owned inventory reads use immutable keysets, not access-updated timestamps. */
export interface EvolutionInventoryReadPort {
  freeze(scope: MemoryScope, selection: "baseline" | "changed" | "due", limit: number): Promise<EvolutionInputSnapshot>;
  readPage(scope: MemoryScope, snapshot: EvolutionInputSnapshot, after: EvolutionKey | undefined, limit: number, budget?: Pick<EvolutionLimits, "maxRecords" | "maxBytes">): Promise<{ units: EvolutionInputUnit[]; complete: boolean; recordsRead?: number; bytesRead?: number }>;
  readTargets(scope: MemoryScope, refs: EvolutionTargetRef[]): Promise<EvolutionTarget[]>;
  verifyEvidence(scope: MemoryScope, evidence: EvolutionEvidence[]): Promise<{ valid: boolean; reason?: string }>;
  /** Frozen committed events/due items. Cursor is opaque; never a MAX(sequence) consumption watermark. */
  readSelectedPage?(scope: MemoryScope, snapshot: EvolutionInputSnapshot, cursor: EvolutionCursor, limit: number, budget: Pick<EvolutionLimits, "maxRecords" | "maxBytes">): Promise<EvolutionPage>;
  /** Confirm only selected events with durable terminal proposal/receipt proof, never during preview. */
  acknowledgeSelection?(scope: MemoryScope, snapshot: EvolutionInputSnapshot, cursor: EvolutionCursor, action: EvolutionAction, proof?: { proposalId: string }): Promise<void>;
  readProposalUnit?: EvolutionProposalSourcePort["read"];
}

export interface EvolutionReviewActor {
  tenantId: string;
  userId: string;
  actorId: string;
  authentication: "local_owner" | "authenticated_owner";
}
export interface EvolutionReviewBinding {
  proposalId: string;
  scopeFingerprint: string;
  inputFingerprint: string;
  sourceSnapshotHash: string;
  configFingerprint: string;
  policyVersion: string;
  diffHash: string;
  evidenceHash: string;
  targetStateHash: string;
  targetRefs: EvolutionTargetRef[];
}
export interface EvolutionReviewItem {
  id: string;
  binding: EvolutionReviewBinding;
  bindingHash: string;
  proposal: EvolutionProposalDraft;
  targets: EvolutionTarget[];
  evidence: EvolutionStagedEvidence[];
  status: "pending" | "approved" | "rejected";
  createdAt: number;
  expiresAt: number;
}
export interface EvolutionReviewDecisionRequest {
  reviewId: string;
  expectedBindingHash: string;
  decision: "approve" | "reject";
  idempotencyKey: string;
  reason?: string;
}
export interface EvolutionReviewReceipt {
  id: string;
  reviewId: string;
  binding: EvolutionReviewBinding;
  bindingHash: string;
  decision: "approve" | "reject";
  actor: EvolutionReviewActor;
  idempotencyKey: string;
  decidedAt: number;
  expiresAt: number;
  reason?: string;
}
export interface EvolutionReviewRepository {
  listProposals(scopeFingerprint: string, request: EvolutionProposalListRequest & { limit: number; maxBytes: number }): Promise<EvolutionProposalPage>;
  getStagedEvidence(proposalId: string, scopeFingerprint: string): Promise<EvolutionStagedEvidence[]>;
  createReview(review: EvolutionReviewItem): Promise<{ review: EvolutionReviewItem; created: boolean }>;
  getReview(reviewId: string, scopeFingerprint: string): Promise<EvolutionReviewItem | undefined>;
  /** Atomically validate binding/expiry/proposal isolation, serialize decision and store the immutable receipt. */
  decideReview(receipt: EvolutionReviewReceipt, expectedBindingHash: string): Promise<EvolutionReviewReceipt>;
  getReviewReceipt(receiptId: string, scopeFingerprint: string): Promise<EvolutionReviewReceipt | undefined>;
  findProposalReview(proposalId: string, scopeFingerprint: string): Promise<EvolutionReviewReceipt | undefined>;
}
export interface EvolutionProposalListRequest {
  limit?: number;
  cursor?: string;
  batchId?: string;
  status?: EvolutionProposal["status"];
}
export interface EvolutionProposalPage { proposals: EvolutionProposal[]; nextCursor?: string }
export interface EvolutionProposalDetail { proposal: EvolutionProposal; evidence: EvolutionStagedEvidence[]; review?: EvolutionReviewReceipt }
export interface EvolutionEvidenceAttestation {
  id: string;
  issuer: string;
  scopeFingerprint: string;
  evidenceId: string;
  sourceId: string;
  revision: string;
  snapshotHash: string;
  rootEvidenceId: string;
  trust: Exclude<EvolutionEvidence["trust"], "untrusted">;
  authorId?: string;
  occurredAt?: number;
  authorizedTargetRefs: EvolutionTargetRef[];
  verifiedAt: number;
  expiresAt: number;
}
export interface EvolutionEvidenceAttestationPort {
  attest(context: EvolutionInputContext & { unit: EvolutionInputUnit }): Promise<{
    attestations: EvolutionEvidenceAttestation[];
    recordsRead: number;
    bytesRead: number;
    verificationBudget: { records: number; bytes: number };
  }>;
  /** Read-only revocation/expiry check on exactly these host-issued proofs. */
  verify(attestations: readonly EvolutionEvidenceAttestation[], context: EvolutionInputContext): Promise<{ valid: boolean; reason?: string; recordsRead: number; bytesRead: number }>;
}
export interface EvolutionProposalSourcePort {
  /** Rehydrate bounded current evidence and targets from host-bound inputs, not staged quote text. */
  read(proposal: EvolutionProposal, context: EvolutionInputContext): Promise<{ unit?: EvolutionInputUnit; recordsRead: number; filesRead: number; bytesRead: number; checkpoint?: { snapshot: EvolutionInputSnapshot; cursor: EvolutionCursor } }>;
}
export interface MemoryEvolutionReviewServiceOptions {
  authority: AuthorityScope;
  scope: MemoryScope;
  actor: EvolutionReviewActor;
  configFingerprint: string;
  policyVersion?: string;
  repository: EvolutionRepository & EvolutionReviewRepository;
  source: EvolutionProposalSourcePort;
  limits?: Partial<EvolutionLimits>;
  reviewTtlMs?: number;
  now?: () => number;
}

export interface EvolutionRelatedTargetsPort {
  /** Host-owned exact/source-link or bounded related reads, never a full inventory scan. */
  resolve(context: {
    scope: MemoryScope;
    evidence: readonly EvolutionEvidence[];
    limit: number;
    maxBytes: number;
    signal?: AbortSignal;
  }): Promise<{ targets: EvolutionTarget[]; recordsRead: number; bytesRead: number }>;
}
