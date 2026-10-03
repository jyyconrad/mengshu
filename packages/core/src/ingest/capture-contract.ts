import { createHash } from "node:crypto";

import type { MemoryScope, SourceRevisionRef } from "../domain/types.js";

/**
 * Capture contract for a future raw archive. This module does not write files
 * and is not a wiki asset store. IngestionPipeline remains the chunk path.
 */
export const CAPTURE_STATUSES = Object.freeze([
  "captured",
  "captured_local_pending",
  "damaged",
] as const);

export type CaptureStatus = (typeof CAPTURE_STATUSES)[number];

export interface CaptureReceipt {
  readonly captureId: string;
  readonly status: CaptureStatus;
  readonly source: SourceRevisionRef;
  readonly idempotencyKey: string;
  readonly jobId?: string;
  /** True when this delivery matched an existing source revision and did not enqueue a second intent. */
  readonly replayed?: boolean;
}

export interface RawArchiveManifest {
  readonly captureId: string;
  readonly scope: MemoryScope;
  readonly source: SourceRevisionRef;
  readonly byteLength: number;
  readonly mediaType: string;
  /** Vault-relative pointer. Callers must not treat this as a second wiki root. */
  readonly relativePath: string;
}

export interface RawArchivePort {
  put(input: {
    readonly manifest: RawArchiveManifest;
    readonly bytes: Uint8Array;
  }): Promise<void>;
  read(manifest: RawArchiveManifest): Promise<Uint8Array>;
}

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[^\s\p{Cc}]{1,256}$/u;

export class CaptureContractError extends Error {
  override readonly name = "CaptureContractError";

  constructor(readonly code: "CAPTURE_CONTRACT_INVALID") {
    super(code);
  }
}

function fail(): never {
  throw new CaptureContractError("CAPTURE_CONTRACT_INVALID");
}

export function isCaptureStatus(value: unknown): value is CaptureStatus {
  return typeof value === "string" &&
    (CAPTURE_STATUSES as readonly string[]).includes(value);
}

export function captureIdempotencyKey(input: {
  readonly scopeFingerprint: string;
  readonly source: SourceRevisionRef;
}): string {
  if (!SHA256.test(input.scopeFingerprint) || !input.source ||
      typeof input.source.sourceId !== "string" || !SAFE_ID.test(input.source.sourceId) ||
      typeof input.source.revision !== "string" || !SAFE_ID.test(input.source.revision) ||
      typeof input.source.payloadHash !== "string" || !SHA256.test(input.source.payloadHash)) {
    fail();
  }
  return createHash("sha256")
    .update([
      input.scopeFingerprint,
      input.source.sourceId,
      input.source.revision,
      input.source.payloadHash,
    ].join("\0"))
    .digest("hex");
}
