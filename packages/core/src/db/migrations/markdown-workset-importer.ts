import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import type { HistoricalSourceDisposition } from "./history-curation.js";
import {
  markdownWorksetManifestSha256,
  parseNativeRecordMarkdown,
  serializeMarkdownWorksetManifest,
  verifyMarkdownWorksetManifest,
  type MarkdownWorksetFileInput,
  type MarkdownWorksetManifest,
  type MarkdownWorksetNativeRecord,
} from "./markdown-workset.js";

export type MarkdownWorksetImportMode = "dry_run" | "prepare";
export type MarkdownWorksetLiveDisposition = "canonical_keep" | "distinct_keep" | "lookup_only";
export type MarkdownWorksetImportReceiptKind = "activate" | "rollback";

export interface MarkdownWorksetImportLiveRow {
  readonly targetRef: string;
  readonly sourceRef: string;
  readonly sourceHash: string;
  readonly scopeFingerprint?: string;
  readonly materialization: MarkdownWorksetLiveDisposition;
  readonly record: MarkdownWorksetNativeRecord;
}

export interface MarkdownWorksetImportMapping {
  readonly sourceRef: string;
  readonly sourceHash: string;
  readonly scopeFingerprint?: string;
  readonly disposition: HistoricalSourceDisposition;
  readonly canonicalTargetRef?: string;
  readonly mergedFrom: readonly string[];
  readonly policyVersion: string;
}

export interface MarkdownWorksetImportArchiveEntry extends MarkdownWorksetImportMapping {
  readonly disposition: "supersede" | "archive_stale";
  readonly record: MarkdownWorksetNativeRecord;
}

export interface MarkdownWorksetImportQuarantineEntry extends MarkdownWorksetImportMapping {
  readonly disposition: "quarantine";
  readonly record: MarkdownWorksetNativeRecord;
  readonly quarantineReason?: string;
}

export interface MarkdownWorksetImportPlanCounts {
  readonly sourceTotal: number;
  readonly liveTargetTotal: number;
  readonly mappingTotal: number;
  readonly archiveTotal: number;
  readonly quarantineTotal: number;
  readonly unresolvedTotal: 0;
}

export interface MarkdownWorksetImportCounts {
  readonly liveRows: number;
  readonly mappings: number;
  readonly archived: number;
  readonly quarantined: number;
}

export interface MarkdownWorksetImportSnapshot {
  readonly snapshotHash: string;
  readonly counts: MarkdownWorksetImportCounts;
}

export interface MarkdownWorksetImportPlan {
  readonly schema: "mengshu.markdown-workset-import-plan/v1";
  readonly mode: MarkdownWorksetImportMode;
  readonly runId: string;
  readonly policyVersion: string;
  readonly sourceSnapshotHash: string;
  readonly manifestHash: string;
  readonly verifyHash: string;
  readonly planHash: string;
  readonly stageHash: string;
  readonly liveRows: readonly MarkdownWorksetImportLiveRow[];
  readonly mappings: readonly MarkdownWorksetImportMapping[];
  readonly archiveLedger: readonly MarkdownWorksetImportArchiveEntry[];
  readonly quarantineLedger: readonly MarkdownWorksetImportQuarantineEntry[];
  readonly counts: MarkdownWorksetImportPlanCounts;
  readonly resultSnapshot: MarkdownWorksetImportSnapshot;
}

export interface PrepareMarkdownWorksetImportInput {
  readonly mode: MarkdownWorksetImportMode;
  readonly manifest: MarkdownWorksetManifest;
  readonly files: readonly MarkdownWorksetFileInput[];
}

export interface MarkdownWorksetBeforeImageReceipt {
  readonly beforeImageHash: string;
  readonly snapshot: MarkdownWorksetImportSnapshot;
}

export interface MarkdownWorksetStageReceipt {
  readonly stageHash: string;
  readonly counts: MarkdownWorksetImportCounts;
}

export interface MarkdownWorksetImportActivationReceipt {
  readonly schema: "mengshu.markdown-workset-import-activation-receipt/v1";
  readonly kind: "activate";
  readonly runId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly manifestHash: string;
  readonly verifyHash: string;
  readonly planHash: string;
  readonly beforeImageHash: string;
  readonly beforeSnapshot: MarkdownWorksetImportSnapshot;
  readonly afterSnapshot: MarkdownWorksetImportSnapshot;
  readonly createdAt: string;
  readonly receiptHash: string;
}

export interface MarkdownWorksetImportRollbackReceipt {
  readonly schema: "mengshu.markdown-workset-import-rollback-receipt/v1";
  readonly kind: "rollback";
  readonly runId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly activationReceiptHash: string;
  readonly manifestHash: string;
  readonly verifyHash: string;
  readonly restoredSnapshot: MarkdownWorksetImportSnapshot;
  readonly createdAt: string;
  readonly receiptHash: string;
}

export type MarkdownWorksetImportReceipt =
  | MarkdownWorksetImportActivationReceipt
  | MarkdownWorksetImportRollbackReceipt;

export interface MarkdownWorksetImportTransaction {
  readCurrentSnapshot(): Promise<MarkdownWorksetImportSnapshot>;
  saveBeforeImage(input: Readonly<{
    runId: string;
    snapshot: MarkdownWorksetImportSnapshot;
  }>): Promise<MarkdownWorksetBeforeImageReceipt>;
  stagePlan(plan: MarkdownWorksetImportPlan): Promise<MarkdownWorksetStageReceipt>;
  replaceFromStage(input: Readonly<{
    runId: string;
    expectedCurrentSnapshotHash: string;
    stageHash: string;
    expectedSnapshot: MarkdownWorksetImportSnapshot;
  }>): Promise<MarkdownWorksetImportSnapshot>;
  restoreBeforeImage(input: Readonly<{
    runId: string;
    beforeImageHash: string;
    expectedCurrentSnapshotHash: string;
    expectedRestoredSnapshot: MarkdownWorksetImportSnapshot;
  }>): Promise<MarkdownWorksetImportSnapshot>;
  writeReceipt(receipt: MarkdownWorksetImportReceipt): Promise<MarkdownWorksetImportReceipt>;
}

export interface MarkdownWorksetImportActivationPort {
  /** The adapter must hold this run lock until work settles. */
  withRunLock<T>(runId: string, work: () => Promise<T>): Promise<T>;
  readReceipt(
    kind: MarkdownWorksetImportReceiptKind,
    idempotencyKey: string,
  ): Promise<MarkdownWorksetImportReceipt | undefined>;
  /** The adapter must atomically commit the callback or roll back every callback side effect. */
  transaction<T>(work: (transaction: MarkdownWorksetImportTransaction) => Promise<T>): Promise<T>;
}

export interface ActivateMarkdownWorksetImportInput {
  readonly plan: MarkdownWorksetImportPlan;
  readonly maintenanceMode: boolean;
  readonly quiescenceConfirmed: boolean;
  readonly manifestHash: string;
  readonly verifyHash: string;
  readonly expectedCurrentSnapshotHash: string;
  readonly idempotencyKey: string;
  readonly confirmationToken: string;
}

export interface RollbackMarkdownWorksetImportInput {
  readonly activationReceipt: MarkdownWorksetImportActivationReceipt;
  readonly maintenanceMode: boolean;
  readonly quiescenceConfirmed: boolean;
  readonly expectedCurrentSnapshotHash: string;
  readonly idempotencyKey: string;
  readonly confirmationToken: string;
}

export type MarkdownWorksetImportErrorCode =
  | "MARKDOWN_IMPORT_INVALID_INPUT"
  | "MARKDOWN_IMPORT_VERIFY_FAILED"
  | "MARKDOWN_IMPORT_UNRESOLVED_SOURCE"
  | "MARKDOWN_IMPORT_DUPLICATE_LIVE_TARGET"
  | "MARKDOWN_IMPORT_NOT_PREPARED"
  | "MARKDOWN_IMPORT_SAFETY_GUARD_REQUIRED"
  | "MARKDOWN_IMPORT_HASH_DRIFT"
  | "MARKDOWN_IMPORT_INVALID_CONFIRMATION"
  | "MARKDOWN_IMPORT_IDEMPOTENCY_CONFLICT"
  | "MARKDOWN_IMPORT_SNAPSHOT_DRIFT"
  | "MARKDOWN_IMPORT_COUNT_MISMATCH"
  | "MARKDOWN_IMPORT_RECEIPT_MISMATCH";

const ERROR_MESSAGES: Record<MarkdownWorksetImportErrorCode, string> = {
  MARKDOWN_IMPORT_INVALID_INPUT: "Markdown workset import input is invalid",
  MARKDOWN_IMPORT_VERIFY_FAILED: "Markdown workset strict verification failed",
  MARKDOWN_IMPORT_UNRESOLVED_SOURCE: "Markdown workset contains an unresolved source disposition",
  MARKDOWN_IMPORT_DUPLICATE_LIVE_TARGET: "Markdown workset live target is duplicated",
  MARKDOWN_IMPORT_NOT_PREPARED: "Markdown workset plan is not prepared for activation",
  MARKDOWN_IMPORT_SAFETY_GUARD_REQUIRED: "Markdown workset activation safety guard is required",
  MARKDOWN_IMPORT_HASH_DRIFT: "Markdown workset activation hash drifted",
  MARKDOWN_IMPORT_INVALID_CONFIRMATION: "Markdown workset confirmation token is invalid",
  MARKDOWN_IMPORT_IDEMPOTENCY_CONFLICT: "Markdown workset idempotency key conflicts with another request",
  MARKDOWN_IMPORT_SNAPSHOT_DRIFT: "Markdown workset database snapshot drifted",
  MARKDOWN_IMPORT_COUNT_MISMATCH: "Markdown workset import count verification failed",
  MARKDOWN_IMPORT_RECEIPT_MISMATCH: "Markdown workset import receipt verification failed",
};

export class MarkdownWorksetImportError extends Error {
  constructor(readonly code: MarkdownWorksetImportErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "MarkdownWorksetImportError";
  }
}

const PLAN_SCHEMA = "mengshu.markdown-workset-import-plan/v1" as const;
const ACTIVATION_RECEIPT_SCHEMA = "mengshu.markdown-workset-import-activation-receipt/v1" as const;
const ROLLBACK_RECEIPT_SCHEMA = "mengshu.markdown-workset-import-rollback-receipt/v1" as const;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const LIVE_DISPOSITIONS = new Set<HistoricalSourceDisposition>([
  "canonical_keep", "distinct_keep", "lookup_only",
]);
const MERGE_DISPOSITIONS = new Set<HistoricalSourceDisposition>([
  "merge_exact", "merge_semantic",
]);
const ARCHIVE_DISPOSITIONS = new Set<HistoricalSourceDisposition>([
  "supersede", "archive_stale",
]);

function fail(code: MarkdownWorksetImportErrorCode): never {
  throw new MarkdownWorksetImportError(code);
}

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stableValue(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("MARKDOWN_IMPORT_INVALID_INPUT");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (nodeUtilTypes.isProxy(value) || seen.has(value)) fail("MARKDOWN_IMPORT_INVALID_INPUT");
    seen.add(value);
    const result = value.map((item) => stableValue(item, seen));
    seen.delete(value);
    return result;
  }
  if (!plainRecord(value) || seen.has(value)) fail("MARKDOWN_IMPORT_INVALID_INPUT");
  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item === undefined || typeof item === "function" || typeof item === "symbol" ||
        typeof item === "bigint") fail("MARKDOWN_IMPORT_INVALID_INPUT");
    result[key] = stableValue(item, seen);
  }
  seen.delete(value);
  return result;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function sha256(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(`${domain}\u001f${stableJson(value)}`, "utf8")
    .digest("hex");
}

function frozen<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function importCounts(plan: Pick<MarkdownWorksetImportPlan,
  "liveRows" | "mappings" | "archiveLedger" | "quarantineLedger">): MarkdownWorksetImportCounts {
  return frozen({
    liveRows: plan.liveRows.length,
    mappings: plan.mappings.length,
    archived: plan.archiveLedger.length,
    quarantined: plan.quarantineLedger.length,
  });
}

function validCounts(value: unknown): value is MarkdownWorksetImportCounts {
  return plainRecord(value) && [value.liveRows, value.mappings, value.archived, value.quarantined]
    .every((count) => Number.isSafeInteger(count) && (count as number) >= 0);
}

function validSnapshot(value: unknown): value is MarkdownWorksetImportSnapshot {
  return plainRecord(value) && typeof value.snapshotHash === "string" &&
    SHA256.test(value.snapshotHash) && validCounts(value.counts);
}

function sameCounts(left: MarkdownWorksetImportCounts, right: MarkdownWorksetImportCounts): boolean {
  return left.liveRows === right.liveRows && left.mappings === right.mappings &&
    left.archived === right.archived && left.quarantined === right.quarantined;
}

function sameSnapshot(left: MarkdownWorksetImportSnapshot, right: MarkdownWorksetImportSnapshot): boolean {
  return left.snapshotHash === right.snapshotHash && sameCounts(left.counts, right.counts);
}

function requireTarget(disposition: HistoricalSourceDisposition, target: string | undefined): string {
  if ((LIVE_DISPOSITIONS.has(disposition) || MERGE_DISPOSITIONS.has(disposition) ||
      disposition === "supersede") && !target) {
    fail("MARKDOWN_IMPORT_UNRESOLVED_SOURCE");
  }
  return target ?? "";
}

export function prepareMarkdownWorksetImport(
  input: PrepareMarkdownWorksetImportInput,
): MarkdownWorksetImportPlan {
  if (!plainRecord(input) || (input.mode !== "dry_run" && input.mode !== "prepare") ||
      !plainRecord(input.manifest) || !Array.isArray(input.files) ||
      nodeUtilTypes.isProxy(input.files) || input.manifest.phase !== "governed") {
    fail("MARKDOWN_IMPORT_INVALID_INPUT");
  }

  let verification: Readonly<{ sourceCount: number; verifiedCount: number; snapshotSha256: string }>;
  try {
    verification = verifyMarkdownWorksetManifest(input.manifest, input.files);
  } catch {
    fail("MARKDOWN_IMPORT_VERIFY_FAILED");
  }
  if (verification.sourceCount !== verification.verifiedCount ||
      verification.sourceCount !== input.manifest.sourceCount) {
    fail("MARKDOWN_IMPORT_VERIFY_FAILED");
  }

  const manifestHash = markdownWorksetManifestSha256(
    serializeMarkdownWorksetManifest(input.manifest),
  );
  const verifyHash = sha256("mengshu.markdown-workset-verification/v1", {
    manifestHash,
    runId: input.manifest.migrationRunId,
    phase: input.manifest.phase,
    policyVersion: input.manifest.policyVersion,
    ...verification,
  });
  const parsed = [...input.files]
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    .map((file) => {
      try {
        return parseNativeRecordMarkdown(file.markdown);
      } catch {
        fail("MARKDOWN_IMPORT_VERIFY_FAILED");
      }
    });

  const liveRows: MarkdownWorksetImportLiveRow[] = [];
  const mappings: MarkdownWorksetImportMapping[] = [];
  const archiveLedger: MarkdownWorksetImportArchiveEntry[] = [];
  const quarantineLedger: MarkdownWorksetImportQuarantineEntry[] = [];
  const liveTargets = new Set<string>();

  for (const worksetRecord of parsed) {
    const disposition = worksetRecord.disposition;
    if (worksetRecord.phase !== "governed" || !disposition ||
        worksetRecord.policyVersion !== input.manifest.policyVersion) {
      fail("MARKDOWN_IMPORT_UNRESOLVED_SOURCE");
    }
    const target = requireTarget(disposition, worksetRecord.canonicalTargetRef);
    const mapping: MarkdownWorksetImportMapping = frozen({
      sourceRef: worksetRecord.sourceRef,
      sourceHash: worksetRecord.sourceHash,
      ...(worksetRecord.scopeFingerprint
        ? { scopeFingerprint: worksetRecord.scopeFingerprint }
        : {}),
      disposition,
      ...(worksetRecord.canonicalTargetRef
        ? { canonicalTargetRef: worksetRecord.canonicalTargetRef }
        : {}),
      mergedFrom: frozen([...worksetRecord.mergedFrom]),
      policyVersion: worksetRecord.policyVersion,
    });
    mappings.push(mapping);

    if (LIVE_DISPOSITIONS.has(disposition)) {
      if (liveTargets.has(target)) fail("MARKDOWN_IMPORT_DUPLICATE_LIVE_TARGET");
      liveTargets.add(target);
      liveRows.push(frozen({
        targetRef: target,
        sourceRef: worksetRecord.sourceRef,
        sourceHash: worksetRecord.sourceHash,
        ...(worksetRecord.scopeFingerprint
          ? { scopeFingerprint: worksetRecord.scopeFingerprint }
          : {}),
        materialization: disposition as MarkdownWorksetLiveDisposition,
        record: frozen(stableValue(worksetRecord.record) as MarkdownWorksetNativeRecord),
      }));
    } else if (ARCHIVE_DISPOSITIONS.has(disposition)) {
      archiveLedger.push(frozen({
        ...mapping,
        disposition: disposition as MarkdownWorksetImportArchiveEntry["disposition"],
        record: frozen(stableValue(worksetRecord.record) as MarkdownWorksetNativeRecord),
      }));
    } else if (disposition === "quarantine") {
      quarantineLedger.push(frozen({
        ...mapping,
        disposition,
        record: frozen(stableValue(worksetRecord.record) as MarkdownWorksetNativeRecord),
        ...(worksetRecord.record.legacyQuarantineReason
          ? { quarantineReason: worksetRecord.record.legacyQuarantineReason }
          : {}),
      }));
    }
  }

  const bySource = <T extends { readonly sourceRef: string }>(left: T, right: T): number =>
    left.sourceRef.localeCompare(right.sourceRef);
  liveRows.sort((left, right) => left.targetRef.localeCompare(right.targetRef));
  mappings.sort(bySource);
  archiveLedger.sort(bySource);
  quarantineLedger.sort(bySource);

  for (const mapping of mappings) {
    if ((MERGE_DISPOSITIONS.has(mapping.disposition) || mapping.disposition === "supersede") &&
        (!mapping.canonicalTargetRef || !liveTargets.has(mapping.canonicalTargetRef))) {
      fail("MARKDOWN_IMPORT_UNRESOLVED_SOURCE");
    }
  }
  if (mappings.length !== verification.sourceCount) {
    fail("MARKDOWN_IMPORT_UNRESOLVED_SOURCE");
  }

  const frozenRows = frozen(liveRows);
  const frozenMappings = frozen(mappings);
  const frozenArchive = frozen(archiveLedger);
  const frozenQuarantine = frozen(quarantineLedger);
  const counts: MarkdownWorksetImportPlanCounts = frozen({
    sourceTotal: verification.sourceCount,
    liveTargetTotal: frozenRows.length,
    mappingTotal: frozenMappings.length,
    archiveTotal: frozenArchive.length,
    quarantineTotal: frozenQuarantine.length,
    unresolvedTotal: 0,
  });
  const planPayload = {
    mode: input.mode,
    runId: input.manifest.migrationRunId,
    policyVersion: input.manifest.policyVersion,
    sourceSnapshotHash: verification.snapshotSha256,
    manifestHash,
    verifyHash,
    liveRows: frozenRows,
    mappings: frozenMappings,
    archiveLedger: frozenArchive,
    quarantineLedger: frozenQuarantine,
    counts,
  };
  const planHash = sha256("mengshu.markdown-workset-import-plan/v1", planPayload);
  const stageHash = sha256("mengshu.markdown-workset-import-stage/v1", {
    planHash,
    liveRows: frozenRows,
    mappings: frozenMappings,
    archiveLedger: frozenArchive,
    quarantineLedger: frozenQuarantine,
  });
  const storageCounts = importCounts({
    liveRows: frozenRows,
    mappings: frozenMappings,
    archiveLedger: frozenArchive,
    quarantineLedger: frozenQuarantine,
  });
  const resultSnapshot: MarkdownWorksetImportSnapshot = frozen({
    snapshotHash: sha256("mengshu.markdown-workset-import-result-snapshot/v1", {
      runId: input.manifest.migrationRunId,
      stageHash,
      counts: storageCounts,
    }),
    counts: storageCounts,
  });

  return frozen({
    schema: PLAN_SCHEMA,
    ...planPayload,
    planHash,
    stageHash,
    resultSnapshot,
  });
}

function validPlan(plan: MarkdownWorksetImportPlan): boolean {
  if (!plainRecord(plan) || plan.schema !== PLAN_SCHEMA ||
      (plan.mode !== "dry_run" && plan.mode !== "prepare") ||
      typeof plan.runId !== "string" || plan.runId.length === 0 ||
      typeof plan.policyVersion !== "string" || plan.policyVersion.length === 0 ||
      ![plan.sourceSnapshotHash, plan.manifestHash, plan.verifyHash, plan.planHash, plan.stageHash]
        .every((value) => typeof value === "string" && SHA256.test(value)) ||
      !Array.isArray(plan.liveRows) || !Array.isArray(plan.mappings) ||
      !Array.isArray(plan.archiveLedger) || !Array.isArray(plan.quarantineLedger) ||
      !plainRecord(plan.counts) || !validSnapshot(plan.resultSnapshot)) return false;
  const expectedCounts = importCounts(plan);
  const planPayload = {
    mode: plan.mode,
    runId: plan.runId,
    policyVersion: plan.policyVersion,
    sourceSnapshotHash: plan.sourceSnapshotHash,
    manifestHash: plan.manifestHash,
    verifyHash: plan.verifyHash,
    liveRows: plan.liveRows,
    mappings: plan.mappings,
    archiveLedger: plan.archiveLedger,
    quarantineLedger: plan.quarantineLedger,
    counts: plan.counts,
  };
  const expectedPlanHash = sha256("mengshu.markdown-workset-import-plan/v1", planPayload);
  const expectedStageHash = sha256("mengshu.markdown-workset-import-stage/v1", {
    planHash: expectedPlanHash,
    liveRows: plan.liveRows,
    mappings: plan.mappings,
    archiveLedger: plan.archiveLedger,
    quarantineLedger: plan.quarantineLedger,
  });
  const expectedResultHash = sha256("mengshu.markdown-workset-import-result-snapshot/v1", {
    runId: plan.runId,
    stageHash: expectedStageHash,
    counts: expectedCounts,
  });
  return plan.planHash === expectedPlanHash && plan.stageHash === expectedStageHash &&
    plan.resultSnapshot.snapshotHash === expectedResultHash &&
    plan.counts.sourceTotal === plan.mappings.length &&
    plan.counts.liveTargetTotal === plan.liveRows.length &&
    plan.counts.mappingTotal === plan.mappings.length &&
    plan.counts.archiveTotal === plan.archiveLedger.length &&
    plan.counts.quarantineTotal === plan.quarantineLedger.length &&
    plan.counts.unresolvedTotal === 0 && sameCounts(expectedCounts, plan.resultSnapshot.counts);
}

export function markdownWorksetActivationConfirmationToken(input: Readonly<{
  plan: MarkdownWorksetImportPlan;
  expectedCurrentSnapshotHash: string;
}>): string {
  return [
    "ACTIVATE_MARKDOWN_WORKSET",
    input.plan.runId,
    input.plan.manifestHash,
    input.plan.verifyHash,
    input.expectedCurrentSnapshotHash,
  ].join(":");
}

export function markdownWorksetRollbackConfirmationToken(input: Readonly<{
  activationReceipt: MarkdownWorksetImportActivationReceipt;
  expectedCurrentSnapshotHash: string;
}>): string {
  return [
    "ROLLBACK_MARKDOWN_WORKSET",
    input.activationReceipt.runId,
    input.activationReceipt.receiptHash,
    input.activationReceipt.manifestHash,
    input.activationReceipt.verifyHash,
    input.expectedCurrentSnapshotHash,
  ].join(":");
}

function validSafetyGuard(maintenanceMode: boolean, quiescenceConfirmed: boolean): boolean {
  return maintenanceMode === true && quiescenceConfirmed === true;
}

function activationRequestHash(input: ActivateMarkdownWorksetImportInput): string {
  return sha256("mengshu.markdown-workset-import-activation-request/v1", {
    runId: input.plan.runId,
    idempotencyKey: input.idempotencyKey,
    planHash: input.plan.planHash,
    manifestHash: input.manifestHash,
    verifyHash: input.verifyHash,
    expectedCurrentSnapshotHash: input.expectedCurrentSnapshotHash,
  });
}

function rollbackRequestHash(input: RollbackMarkdownWorksetImportInput): string {
  return sha256("mengshu.markdown-workset-import-rollback-request/v1", {
    runId: input.activationReceipt.runId,
    idempotencyKey: input.idempotencyKey,
    activationReceiptHash: input.activationReceipt.receiptHash,
    manifestHash: input.activationReceipt.manifestHash,
    verifyHash: input.activationReceipt.verifyHash,
    expectedCurrentSnapshotHash: input.expectedCurrentSnapshotHash,
  });
}

function receiptHash(receipt: Omit<MarkdownWorksetImportReceipt, "receiptHash">): string {
  return sha256(`mengshu.markdown-workset-import-${receipt.kind}-receipt/v1`, receipt);
}

function validDate(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validActivationReceipt(value: unknown): value is MarkdownWorksetImportActivationReceipt {
  if (!plainRecord(value) || value.schema !== ACTIVATION_RECEIPT_SCHEMA || value.kind !== "activate" ||
      typeof value.runId !== "string" || typeof value.idempotencyKey !== "string" ||
      !SAFE_IDEMPOTENCY_KEY.test(value.idempotencyKey) ||
      ![value.requestHash, value.manifestHash, value.verifyHash, value.planHash,
        value.beforeImageHash, value.receiptHash]
        .every((hash) => typeof hash === "string" && SHA256.test(hash)) ||
      typeof value.createdAt !== "string" || !validDate(value.createdAt) ||
      !validSnapshot(value.beforeSnapshot) || !validSnapshot(value.afterSnapshot)) return false;
  const { receiptHash: actual, ...payload } = value;
  return receiptHash(payload as Omit<MarkdownWorksetImportReceipt, "receiptHash">) === actual;
}

function validRollbackReceipt(value: unknown): value is MarkdownWorksetImportRollbackReceipt {
  if (!plainRecord(value) || value.schema !== ROLLBACK_RECEIPT_SCHEMA || value.kind !== "rollback" ||
      typeof value.runId !== "string" || typeof value.idempotencyKey !== "string" ||
      !SAFE_IDEMPOTENCY_KEY.test(value.idempotencyKey) ||
      ![value.requestHash, value.activationReceiptHash, value.manifestHash,
        value.verifyHash, value.receiptHash]
        .every((hash) => typeof hash === "string" && SHA256.test(hash)) ||
      typeof value.createdAt !== "string" || !validDate(value.createdAt) ||
      !validSnapshot(value.restoredSnapshot)) return false;
  const { receiptHash: actual, ...payload } = value;
  return receiptHash(payload as Omit<MarkdownWorksetImportReceipt, "receiptHash">) === actual;
}

function ensurePersistedReceipt(
  expected: MarkdownWorksetImportReceipt,
  actual: MarkdownWorksetImportReceipt,
): void {
  if (stableJson(expected) !== stableJson(actual)) fail("MARKDOWN_IMPORT_RECEIPT_MISMATCH");
}

export class MarkdownWorksetImporter {
  constructor(
    private readonly port: MarkdownWorksetImportActivationPort,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  async activate(
    input: ActivateMarkdownWorksetImportInput,
  ): Promise<MarkdownWorksetImportActivationReceipt> {
    if (!plainRecord(input) || !validPlan(input.plan) || input.plan.mode !== "prepare") {
      if (plainRecord(input) && plainRecord(input.plan) && input.plan.mode === "dry_run") {
        fail("MARKDOWN_IMPORT_NOT_PREPARED");
      }
      fail("MARKDOWN_IMPORT_INVALID_INPUT");
    }
    if (!validSafetyGuard(input.maintenanceMode, input.quiescenceConfirmed)) {
      fail("MARKDOWN_IMPORT_SAFETY_GUARD_REQUIRED");
    }
    if (!SHA256.test(input.manifestHash) || !SHA256.test(input.verifyHash) ||
        input.manifestHash !== input.plan.manifestHash || input.verifyHash !== input.plan.verifyHash) {
      fail("MARKDOWN_IMPORT_HASH_DRIFT");
    }
    if (!SHA256.test(input.expectedCurrentSnapshotHash) ||
        !SAFE_IDEMPOTENCY_KEY.test(input.idempotencyKey)) fail("MARKDOWN_IMPORT_INVALID_INPUT");
    if (input.confirmationToken !== markdownWorksetActivationConfirmationToken(input)) {
      fail("MARKDOWN_IMPORT_INVALID_CONFIRMATION");
    }
    const requestHash = activationRequestHash(input);

    return this.port.withRunLock(input.plan.runId, async () => {
      const existing = await this.port.readReceipt("activate", input.idempotencyKey);
      if (existing) {
        if (!validActivationReceipt(existing) || existing.requestHash !== requestHash) {
          fail("MARKDOWN_IMPORT_IDEMPOTENCY_CONFLICT");
        }
        return existing;
      }
      return this.port.transaction(async (transaction) => {
        const current = await transaction.readCurrentSnapshot();
        if (!validSnapshot(current) || current.snapshotHash !== input.expectedCurrentSnapshotHash) {
          fail("MARKDOWN_IMPORT_SNAPSHOT_DRIFT");
        }
        const beforeImage = await transaction.saveBeforeImage({
          runId: input.plan.runId,
          snapshot: current,
        });
        if (!plainRecord(beforeImage) || typeof beforeImage.beforeImageHash !== "string" ||
            !SHA256.test(beforeImage.beforeImageHash) || !validSnapshot(beforeImage.snapshot) ||
            !sameSnapshot(beforeImage.snapshot, current)) {
          fail("MARKDOWN_IMPORT_RECEIPT_MISMATCH");
        }
        const staged = await transaction.stagePlan(input.plan);
        const expectedCounts = importCounts(input.plan);
        if (!plainRecord(staged) || !validCounts(staged.counts) ||
            !sameCounts(staged.counts, expectedCounts)) fail("MARKDOWN_IMPORT_COUNT_MISMATCH");
        if (staged.stageHash !== input.plan.stageHash) fail("MARKDOWN_IMPORT_HASH_DRIFT");

        const replaced = await transaction.replaceFromStage({
          runId: input.plan.runId,
          expectedCurrentSnapshotHash: input.expectedCurrentSnapshotHash,
          stageHash: staged.stageHash,
          expectedSnapshot: input.plan.resultSnapshot,
        });
        if (!validSnapshot(replaced) || !sameCounts(replaced.counts, input.plan.resultSnapshot.counts)) {
          fail("MARKDOWN_IMPORT_COUNT_MISMATCH");
        }
        if (replaced.snapshotHash !== input.plan.resultSnapshot.snapshotHash) {
          fail("MARKDOWN_IMPORT_HASH_DRIFT");
        }
        const createdAt = this.clock();
        if (!validDate(createdAt)) fail("MARKDOWN_IMPORT_INVALID_INPUT");
        const payload = frozen({
          schema: ACTIVATION_RECEIPT_SCHEMA,
          kind: "activate" as const,
          runId: input.plan.runId,
          idempotencyKey: input.idempotencyKey,
          requestHash,
          manifestHash: input.manifestHash,
          verifyHash: input.verifyHash,
          planHash: input.plan.planHash,
          beforeImageHash: beforeImage.beforeImageHash,
          beforeSnapshot: current,
          afterSnapshot: replaced,
          createdAt,
        });
        const receipt: MarkdownWorksetImportActivationReceipt = frozen({
          ...payload,
          receiptHash: receiptHash(payload),
        });
        const persisted = await transaction.writeReceipt(receipt);
        ensurePersistedReceipt(receipt, persisted);
        return receipt;
      });
    });
  }

  async rollback(
    input: RollbackMarkdownWorksetImportInput,
  ): Promise<MarkdownWorksetImportRollbackReceipt> {
    if (!plainRecord(input) || !validActivationReceipt(input.activationReceipt) ||
        !SHA256.test(input.expectedCurrentSnapshotHash) ||
        !SAFE_IDEMPOTENCY_KEY.test(input.idempotencyKey)) fail("MARKDOWN_IMPORT_INVALID_INPUT");
    if (!validSafetyGuard(input.maintenanceMode, input.quiescenceConfirmed)) {
      fail("MARKDOWN_IMPORT_SAFETY_GUARD_REQUIRED");
    }
    if (input.expectedCurrentSnapshotHash !== input.activationReceipt.afterSnapshot.snapshotHash) {
      fail("MARKDOWN_IMPORT_SNAPSHOT_DRIFT");
    }
    if (input.confirmationToken !== markdownWorksetRollbackConfirmationToken(input)) {
      fail("MARKDOWN_IMPORT_INVALID_CONFIRMATION");
    }
    const requestHash = rollbackRequestHash(input);

    return this.port.withRunLock(input.activationReceipt.runId, async () => {
      const existing = await this.port.readReceipt("rollback", input.idempotencyKey);
      if (existing) {
        if (!validRollbackReceipt(existing) || existing.requestHash !== requestHash) {
          fail("MARKDOWN_IMPORT_IDEMPOTENCY_CONFLICT");
        }
        return existing;
      }
      return this.port.transaction(async (transaction) => {
        const current = await transaction.readCurrentSnapshot();
        if (!validSnapshot(current) ||
            !sameSnapshot(current, input.activationReceipt.afterSnapshot)) {
          fail("MARKDOWN_IMPORT_SNAPSHOT_DRIFT");
        }
        const restored = await transaction.restoreBeforeImage({
          runId: input.activationReceipt.runId,
          beforeImageHash: input.activationReceipt.beforeImageHash,
          expectedCurrentSnapshotHash: input.expectedCurrentSnapshotHash,
          expectedRestoredSnapshot: input.activationReceipt.beforeSnapshot,
        });
        if (!validSnapshot(restored) ||
            !sameCounts(restored.counts, input.activationReceipt.beforeSnapshot.counts)) {
          fail("MARKDOWN_IMPORT_COUNT_MISMATCH");
        }
        if (restored.snapshotHash !== input.activationReceipt.beforeSnapshot.snapshotHash) {
          fail("MARKDOWN_IMPORT_HASH_DRIFT");
        }
        const createdAt = this.clock();
        if (!validDate(createdAt)) fail("MARKDOWN_IMPORT_INVALID_INPUT");
        const payload = frozen({
          schema: ROLLBACK_RECEIPT_SCHEMA,
          kind: "rollback" as const,
          runId: input.activationReceipt.runId,
          idempotencyKey: input.idempotencyKey,
          requestHash,
          activationReceiptHash: input.activationReceipt.receiptHash,
          manifestHash: input.activationReceipt.manifestHash,
          verifyHash: input.activationReceipt.verifyHash,
          restoredSnapshot: restored,
          createdAt,
        });
        const receipt: MarkdownWorksetImportRollbackReceipt = frozen({
          ...payload,
          receiptHash: receiptHash(payload),
        });
        const persisted = await transaction.writeReceipt(receipt);
        ensurePersistedReceipt(receipt, persisted);
        return receipt;
      });
    });
  }
}
