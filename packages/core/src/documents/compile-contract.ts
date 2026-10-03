import { isMemoryForm, type SourceWatermark } from "../domain/types.js";
import {
  assertTemporalRecallSelector,
  TemporalSelectorError,
} from "../temporal/selector.js";
import {
  DURABLE_JOB_V2_AUTHORITATIVE_TYPES,
  DURABLE_JOB_V2_DOCUMENT_COMPILE_TYPES,
  DURABLE_JOB_V2_EVOLUTION_COMPILE_TYPES,
  DURABLE_JOB_V2_EVOLUTION_TYPES,
} from "../storage/repositories/job-v2.js";
import type {
  DocumentChangeKind,
  DocumentCoverageEntry,
  DocumentCoverageState,
  DocumentGovernanceProposal,
  DocumentPreserveEntry,
  DocumentReadSetEntry,
  DocumentSectionDiffEntry,
} from "./types.js";

/**
 * compile_document is an opt-in complete durable registry.
 * publish_document is the commit stage of that job, not a second queue.
 * The default authoritative registry stays the exact three.
 */
export const GOVERNED_DOCUMENT_COMPILE_JOB_TYPES = Object.freeze([
  "compile_document",
  "publish_document",
] as const);

export type GovernedDocumentCompileJobType =
  (typeof GOVERNED_DOCUMENT_COMPILE_JOB_TYPES)[number];

export class DocumentCompileContractError extends Error {
  override readonly name = "DocumentCompileContractError";

  constructor(readonly code: "DOCUMENT_COMPILE_CONTRACT_INVALID") {
    super(code);
  }
}

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[^\s\p{Cc}]{1,256}$/u;
const CHANGE_KINDS = new Set<DocumentChangeKind>([
  "no_op", "append", "replace", "supersede", "conflict",
]);
const COVERAGE_STATES = new Set<DocumentCoverageState>([
  "selected", "read", "used", "deferred",
]);
const READ_KINDS = new Set<DocumentReadSetEntry["kind"]>(["source", "span", "section"]);

function fail(): never {
  throw new DocumentCompileContractError("DOCUMENT_COMPILE_CONTRACT_INVALID");
}

function safeId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) fail();
  return value;
}

function sha256(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail();
  return value;
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function stringList(values: unknown): readonly string[] {
  if (!Array.isArray(values) || values.some((item) => typeof item !== "string" || !SAFE_ID.test(item))) {
    fail();
  }
  const list = values as string[];
  if (!unique(list)) fail();
  return Object.freeze([...list]);
}

function watermark(value: SourceWatermark): SourceWatermark {
  if (!value || typeof value !== "object") fail();
  if (value.observedAt !== undefined &&
      (!Number.isSafeInteger(value.observedAt) || value.observedAt < 0)) fail();
  return Object.freeze({
    sourceId: safeId(value.sourceId),
    revision: safeId(value.revision),
    payloadHash: sha256(value.payloadHash),
    ...(value.observedAt === undefined ? {} : { observedAt: value.observedAt }),
  });
}

function assertReadSet(values: readonly DocumentReadSetEntry[]): readonly DocumentReadSetEntry[] {
  return Object.freeze(values.map((entry) => {
    if (!entry || !READ_KINDS.has(entry.kind)) fail();
    return Object.freeze({
      kind: entry.kind,
      ref: safeId(entry.ref),
      contentHash: sha256(entry.contentHash),
    });
  }));
}

function assertCoverage(values: readonly DocumentCoverageEntry[]): readonly DocumentCoverageEntry[] {
  return Object.freeze(values.map((entry) => {
    if (!entry || !COVERAGE_STATES.has(entry.state)) fail();
    if (entry.cursor !== undefined && (typeof entry.cursor !== "string" || entry.cursor.length === 0 ||
        entry.cursor.length > 256)) fail();
    return Object.freeze({
      ref: safeId(entry.ref),
      state: entry.state,
      ...(entry.cursor === undefined ? {} : { cursor: entry.cursor }),
    });
  }));
}

function assertSectionDiff(
  values: readonly DocumentSectionDiffEntry[],
  sectionIds: ReadonlySet<string>,
): readonly DocumentSectionDiffEntry[] {
  return Object.freeze(values.map((entry) => {
    if (!entry || !CHANGE_KINDS.has(entry.changeKind) || typeof entry.preserved !== "boolean") fail();
    const sectionId = safeId(entry.sectionId);
    if (!sectionIds.has(sectionId)) fail();
    if (entry.changeKind === "no_op" && entry.preserved !== true) fail();
    if (entry.changeKind !== "no_op" && entry.preserved !== false) fail();
    return Object.freeze({
      sectionId,
      claimIds: stringList(entry.claimIds),
      changeKind: entry.changeKind,
      preserved: entry.preserved,
    });
  }));
}

function assertPreserveSet(
  values: readonly DocumentPreserveEntry[],
  sectionIds: ReadonlySet<string>,
): readonly DocumentPreserveEntry[] {
  return Object.freeze(values.map((entry) => {
    if (!entry) fail();
    const sectionId = safeId(entry.sectionId);
    if (!sectionIds.has(sectionId)) fail();
    return Object.freeze({
      sectionId,
      ...(entry.claimId === undefined ? {} : { claimId: safeId(entry.claimId) }),
      contentHash: sha256(entry.contentHash),
      evidenceRefs: stringList(entry.evidenceRefs),
    });
  }));
}

/** Validates additive compile fields when present. Does not change governance decisions. */
export function assertDocumentCompileFields(proposal: DocumentGovernanceProposal): void {
  const sectionIds = new Set(proposal.sections.map((section) => section.sectionId));
  if (proposal.inputSnapshotHash !== undefined) sha256(proposal.inputSnapshotHash);
  if (proposal.readSet !== undefined) assertReadSet(proposal.readSet);
  if (proposal.coverage !== undefined) assertCoverage(proposal.coverage);
  if (proposal.sectionDiff !== undefined) assertSectionDiff(proposal.sectionDiff, sectionIds);
  if (proposal.preserveSet !== undefined) assertPreserveSet(proposal.preserveSet, sectionIds);
  if (proposal.sourceWatermarks !== undefined) {
    const seen = new Set<string>();
    for (const item of proposal.sourceWatermarks) {
      const normalized = watermark(item);
      const key = `${normalized.sourceId}\0${normalized.revision}`;
      if (seen.has(key)) fail();
      seen.add(key);
    }
  }
  if (proposal.changeKind !== undefined && !CHANGE_KINDS.has(proposal.changeKind)) fail();
  if (proposal.memoryForm !== undefined && !isMemoryForm(proposal.memoryForm)) fail();
  if (proposal.validTimeSelector !== undefined) {
    try {
      assertTemporalRecallSelector(proposal.validTimeSelector);
    } catch (error) {
      if (error instanceof TemporalSelectorError) fail();
      throw error;
    }
  }
  for (const section of proposal.sections) {
    for (const claim of section.claims) {
      if (claim.id !== undefined) safeId(claim.id);
    }
  }
}

export function governedDocumentCompileJobsAreUnregistered(): boolean {
  const registered = new Set<string>([
    ...DURABLE_JOB_V2_AUTHORITATIVE_TYPES,
    ...DURABLE_JOB_V2_EVOLUTION_TYPES,
    ...DURABLE_JOB_V2_DOCUMENT_COMPILE_TYPES,
    ...DURABLE_JOB_V2_EVOLUTION_COMPILE_TYPES,
  ]);
  return GOVERNED_DOCUMENT_COMPILE_JOB_TYPES.every((type) => !registered.has(type));
}
