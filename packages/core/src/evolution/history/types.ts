import type { MemoryKind, MemoryScope, MemorySemanticType } from "../../domain/types.js";

export interface HistoryContinuationInput {
  schema: "mengshu.history-p16-input/v1";
  runId: string;
  parentRunId: string;
  parentReceiptHash: string;
  projectionHash: string;
  sourceManifestHash: string;
  governanceManifestHash: string;
  policyVersion: string;
  expected: { sources: number; targets: number; claimBindings: number; scopes: number };
  limits: { pageSize: number; maxSources: number; maxTargets: number; maxBindings: number; maxBatchUnits: number; maxDurationMs: number };
}

export interface HistorySourceWitness {
  sourceRef: string;
  sourceHash: string;
  mappingHash: string;
  scopeFingerprint: string;
  beforeSemanticHash: string;
  currentSemanticHash: string | null;
  beforeRowHash: string;
  currentRowHash: string | null;
  currentRevision: string | null;
  disposition: string;
  operation: string;
  targetMemoryIds: string[];
  /** Source-level legacy resolution only. It grants no canonical/version/archive authority. */
  knowledgeBinding?: {
    resolutionReceiptHash: string; semanticPlanHash: string; unitId: string; resourceIdentity: string;
    logicalSourceDisposition: "snapshot_document" | "locator_resource" | "distinct_chunk";
    revisionKind: "snapshot_chunks" | "unversioned"; logicalSourceIdentities: string[]; resourceLocators: string[];
    ordinalCount: number; disposition: "lookup_only" | "quarantine";
  };
  /** New P16 selection receipt, never fabricated from legacy resourceIdentity/revisionKind. */
  knowledgeIdentity?: {
    resourceHash: string; versionHash: string; contentHash: string; reviewReceiptHash: string;
    canonicalSourceRef: string; sourceSetHash: string; aggregationPlanHash: string;
  };
}

export interface HistoryClaimBinding {
  evidenceId: string;
  claimId: string;
  assetId: string;
  assetVersion: number;
  targetMemoryId: string;
  sourceRef: string;
  sourceHash: string;
  scopeFingerprint: string;
  rootEvidenceId: string;
  independenceGroupId: string;
  anchor?: { utf8ByteStart: number; utf8ByteEnd: number; excerptHash: string };
}

export interface HistoryTargetWitness {
  memoryId: string;
  assetId: string;
  assetVersion: number;
  scope: MemoryScope;
  expectedSemanticHash: string;
  currentSemanticHash: string | null;
  revision: string | null;
  lifecycle: string | null;
  documentState: string | null;
  documentMatchesProjection: boolean;
  kind?: MemoryKind;
  semanticType?: MemorySemanticType;
  pinned: boolean;
  tombstoned: boolean;
  current: boolean;
  confidence: number;
  claimIds: string[];
}

export interface HistoryParentObservation {
  runId: string;
  materializationComplete: boolean;
  receiptHash: string;
  projectionHash: string;
  sourceManifestHash: string;
  governanceManifestHash: string;
  sources: number;
  mappings: number;
  targets: number;
  claimBindings: number;
  /** Observed only. Existing unrelated rows/jobs are never selected for mutation. */
  outsideCohortRows: number;
  outsideCohortHash: string;
  unrelatedQueueHash: string;
}

export interface HistoryReadPort {
  readParent(input: HistoryContinuationInput): Promise<HistoryParentObservation>;
  readSources(input: { parentRunId: string; after?: string; limit: number }): Promise<{ rows: HistorySourceWitness[]; next?: string }>;
  readTargets(input: { parentRunId: string; after?: string; limit: number }): Promise<{ rows: HistoryTargetWitness[]; next?: string }>;
  readBindings(input: { parentRunId: string; after?: string; limit: number }): Promise<{ rows: HistoryClaimBinding[]; next?: string }>;
}

export interface HistoryAudit {
  schema: "mengshu.history-p16-audit/v1";
  inputHash: string;
  parent: HistoryParentObservation;
  sources: HistorySourceWitness[];
  targets: HistoryTargetWitness[];
  bindings: HistoryClaimBinding[];
  unresolved: { ref: string; reason: string }[];
  held: { ref: string; reason: string }[];
  operationalDriftRefs: string[];
  hash: string;
}

export type HistoryPhase = "evidence" | "activate" | "knowledge" | "archive";
export interface HistoryPlanUnit {
  id: string;
  phase: HistoryPhase;
  scopeFingerprint: string;
  target?: HistoryTargetWitness;
  sources: HistorySourceWitness[];
  bindings: HistoryClaimBinding[];
  canonicalSourceRef?: string;
  dependencies: string[];
  confidenceCeiling?: number;
}

export interface HistoryPlan {
  schema: "mengshu.history-p16-plan/v1";
  input: HistoryContinuationInput;
  inputHash: string;
  auditHash: string;
  witnessHash: string;
  units: HistoryPlanUnit[];
  sourceDispositions: { sourceRef: string; action: "preserve" | "archive_after_verify" | "review" | "quarantine"; targetRefs: string[] }[];
  unresolvedCount: number;
  held: HistoryAudit["held"];
  outsideCohortRows: number;
  outsideCohortHash: string;
  unrelatedQueueHash: string;
  counts: { memoryTargets: number; knowledgeGroups: number; rawEvidenceRoots: number; archiveSources: number; preservedSources: number };
  knowledgeReviewPlan?: {
    schema: "mengshu.history-p16-knowledge-review-plan/v1";
    candidates: { unitId: string; scopeFingerprint: string; binding: NonNullable<HistorySourceWitness["knowledgeBinding"]>; sources: { sourceRef: string; sourceHash: string }[] }[];
    canonicalTargetsSelected: false; formalAssetsWritten: false; supersedeAllowed: false; hash: string;
  };
  hash: string;
}

export interface HistoryAuthorization {
  token: string;
  reviewReceiptId: string;
  backupReceiptHash: string;
  restoreReceiptHash: string;
  rehearsalReceiptHash: string;
  maintenanceReceiptId: string;
  quiescenceReceiptId: string;
}

export interface HistoryOperationReceipt {
  id: string;
  runId: string;
  parentRunId: string;
  planHash: string;
  unitId: string;
  phase: HistoryPhase;
  status: "committed" | "rolled_back";
  sourceWitnessHash: string;
  affectedRefs: string[];
  evidenceMemoryIds: string[];
  evidenceRootIds: string[];
  targetRevision?: string;
  beforeStateHash: string;
  afterStateHash: string;
  rollbackRef: string;
  hash: string;
}

export interface HistoryReadVerification {
  unitId: string;
  currentRead: boolean;
  evidenceRead: boolean;
  lookupRead: boolean;
  contextRead: boolean;
  exactScope: boolean;
  confidenceNotIncreased: boolean;
  canonicalIdentityPreserved: boolean;
  evidenceRootIds: string[];
  receiptHash: string;
}

/** Provider-minted locked session. No source body is exposed to the operator or its reports. */
export interface HistoryNativeSession {
  /** Validate host review/maintenance/quiescence/backup/restore/rehearsal receipts, not client booleans. */
  assertGates(input: { plan: HistoryPlan; action: "apply" | "archive" | "rollback"; authorization: HistoryAuthorization }): Promise<void>;
  readReceipt(input: { runId: string; unitId: string }): Promise<HistoryOperationReceipt | undefined>;
  /** SERIALIZABLE transaction: recheck source/target/scope/CAS, native mutation, scoped derivation outbox and receipt. */
  applyUnit(input: { plan: HistoryPlan; unit: HistoryPlanUnit; dependencies: HistoryOperationReceipt[]; authorization: HistoryAuthorization }): Promise<HistoryOperationReceipt>;
  /** Use authoritative current/evidence/lookup/context readers, not SQL rowcounts. */
  verifyUnit(input: { plan: HistoryPlan; unit: HistoryPlanUnit; receipt: HistoryOperationReceipt }): Promise<HistoryReadVerification>;
  /** CAS only this run's own changes in reverse dependency order; preserve original P15 and outside rows/jobs. */
  rollbackUnit(input: { plan: HistoryPlan; unit: HistoryPlanUnit; receipt: HistoryOperationReceipt; authorization: HistoryAuthorization }): Promise<HistoryOperationReceipt>;
  verifyConservation(plan: HistoryPlan): Promise<{ mappingsComplete: boolean; outsideCohortUnchanged: boolean; unrelatedQueueUnchanged: boolean }>;
}

export interface HistoryNativePort {
  /** Advisory lock lives on one dedicated connection for the entire callback. */
  withOperatorLock<T>(input: { runId: string; parentRunId: string; planHash: string }, work: (session: HistoryNativeSession) => Promise<T>): Promise<T>;
}
