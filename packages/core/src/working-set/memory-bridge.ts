import { createHash } from "node:crypto";

import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import { isMemoryForm, type MemoryForm, type MemoryScope } from "../domain/types.js";
import type {
  MemoryWriteCommand,
  MemoryWriteKernelResult,
} from "../service/write-kernel.js";
import { SessionWorkingSetError } from "./session-working-set-service.js";
import type { SessionWorkingSetRepository } from "./repository.js";
import type { PromoteWorkingSetClaimInput, WorkingSetPromotionReceipt } from "./types.js";

export interface WorkingSetMemoryWriteExecutor {
  executeMemoryWrite(command: MemoryWriteCommand): Promise<MemoryWriteKernelResult>;
}

const SAFE_ID = /^[^\s\p{Cc}]{1,256}$/u;
const SHA256 = /^[a-f0-9]{64}$/;

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

export function createWorkingSetPromotionReceipt(input: {
  readonly entryIds: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly memoryForm: MemoryForm;
  readonly scopeFingerprint: string;
  readonly idempotencyKey: string;
  readonly operatorOrPolicy: string;
}): WorkingSetPromotionReceipt {
  if (!isMemoryForm(input.memoryForm) || !SHA256.test(input.scopeFingerprint) ||
      !SAFE_ID.test(input.idempotencyKey) || !SAFE_ID.test(input.operatorOrPolicy) ||
      input.entryIds.length === 0 || input.evidenceRefs.length === 0 ||
      !unique(input.entryIds) || !unique(input.evidenceRefs) ||
      [...input.entryIds, ...input.evidenceRefs].some((id) => !SAFE_ID.test(id))) {
    throw new SessionWorkingSetError("WORKING_SET_PROMOTION_INVALID");
  }
  return Object.freeze({
    schema: "mengshu.working-set-promotion/v1",
    entryIds: Object.freeze([...input.entryIds]),
    evidenceRefs: Object.freeze([...input.evidenceRefs]),
    memoryForm: input.memoryForm,
    scopeFingerprint: input.scopeFingerprint,
    idempotencyKey: input.idempotencyKey,
    operatorOrPolicy: input.operatorOrPolicy,
  });
}

function exactSession(scope: MemoryScope, sessionId: string): void {
  if (scope.visibility !== "private" || scope.sessionId !== sessionId || !SAFE_ID.test(sessionId)) {
    throw new SessionWorkingSetError("WORKING_SET_SCOPE_MISMATCH");
  }
  try { authorityScopeFingerprint(scope); } catch {
    throw new SessionWorkingSetError("WORKING_SET_SCOPE_MISMATCH");
  }
}

export type WorkingSetPromotionResult = MemoryWriteKernelResult & {
  readonly promotionReceipt?: WorkingSetPromotionReceipt;
  readonly replayed?: boolean;
};

function promotionPayloadHash(input: PromoteWorkingSetClaimInput): string {
  return createHash("sha256").update(JSON.stringify({
    confirmation: input.confirmation ?? "",
    evidenceEntryIds: [...input.evidenceEntryIds],
    evidenceRefs: [...input.evidenceRefs],
    memoryForm: input.memoryForm ?? "",
    operatorOrPolicy: input.operatorOrPolicy ?? "",
    semanticType: input.semanticType,
    sessionId: input.sessionId,
    source: input.source,
    text: input.text,
  })).digest("hex");
}

export class SessionWorkingSetMemoryBridge {
  private readonly promotions = new Map<string, { readonly hash: string; readonly result: WorkingSetPromotionResult }>();

  constructor(readonly dependencies: {
    readonly repository: SessionWorkingSetRepository;
    readonly memoryWrite: WorkingSetMemoryWriteExecutor;
    readonly serverAuthority: unknown;
  }) {}

  async promoteClaim(input: PromoteWorkingSetClaimInput): Promise<WorkingSetPromotionResult> {
    exactSession(input.scope, input.sessionId);
    if (!SAFE_ID.test(input.idempotencyKey) || !input.text.trim() || input.text.length > 100_000 ||
        input.text !== input.text.trim() || input.evidenceEntryIds.length === 0 ||
        input.evidenceRefs.length === 0 || !unique(input.evidenceEntryIds) ||
        !unique(input.evidenceRefs) ||
        [...input.evidenceEntryIds, ...input.evidenceRefs].some((id) => !SAFE_ID.test(id))) {
      throw new SessionWorkingSetError("WORKING_SET_PROMOTION_INVALID");
    }
    if ((input.source === "user_explicit") !== (input.confirmation === "REMEMBER") ||
        (input.source === "verified_decision" &&
          input.semanticType !== "rules" && input.semanticType !== "task_context") ||
        (input.source === "verified_outcome" && input.semanticType !== "experience") ||
        (input.memoryForm !== undefined && !isMemoryForm(input.memoryForm)) ||
        (input.operatorOrPolicy !== undefined && !SAFE_ID.test(input.operatorOrPolicy))) {
      throw new SessionWorkingSetError("WORKING_SET_PROMOTION_INVALID");
    }
    const scopeFingerprint = authorityScopeFingerprint(input.scope);
    const payloadHash = promotionPayloadHash(input);
    const cacheKey = `${scopeFingerprint}\0${input.idempotencyKey}`;
    const cached = this.promotions.get(cacheKey);
    if (cached) {
      if (cached.hash !== payloadHash) throw new SessionWorkingSetError("WORKING_SET_PROMOTION_INVALID");
      return { ...cached.result, replayed: true };
    }
    const entries = await Promise.all(input.evidenceEntryIds.map((entryId) =>
      this.dependencies.repository.getEntry(scopeFingerprint, input.sessionId, entryId)));
    if (entries.some((entry) => entry === undefined || entry.status === "expired" ||
        entry.status === "revoked" || entry.riskFlags.length > 0)) {
      throw new SessionWorkingSetError("WORKING_SET_EVIDENCE_UNAVAILABLE");
    }
    const availableEvidence = new Set(entries.flatMap((entry) => entry!.evidenceRefs));
    if (input.evidenceRefs.some((evidenceRef) => !availableEvidence.has(evidenceRef)) ||
        (input.source === "verified_outcome" && entries.some((entry) => entry!.summary === undefined))) {
      throw new SessionWorkingSetError("WORKING_SET_EVIDENCE_UNAVAILABLE");
    }
    const base = {
      idempotencyKey: `working-set:${input.idempotencyKey}`,
      serverAuthority: this.dependencies.serverAuthority,
      clientScope: input.scope,
      text: input.text,
      semanticType: input.semanticType,
      evidenceIds: Object.freeze([...input.evidenceRefs]),
      metadata: Object.freeze({
        source: "session-working-set",
        promotionSource: input.source,
        evidenceEntryIds: Object.freeze([...input.evidenceEntryIds]),
        ...(input.memoryForm === undefined ? {} : { memoryForm: input.memoryForm }),
        ...(input.operatorOrPolicy === undefined ? {} : { operatorOrPolicy: input.operatorOrPolicy }),
      }),
      provenance: Object.freeze({
        source: input.source === "user_explicit" ? "user" : "agent",
        sourceId: input.evidenceEntryIds[0],
        sessionId: input.sessionId,
      }),
      dataType: "memory" as const,
      tableName: "memories" as const,
    };
    const command: MemoryWriteCommand = input.source === "user_explicit"
      ? {
          ...base,
          type: "saveExplicit",
          kind: input.semanticType === "profile" ? "preference" :
            input.semanticType === "task_context" ? "task" :
            input.semanticType === "rules" ? "decision" :
            input.semanticType === "resource" ? "knowledge" : "fact",
          container: input.semanticType === "profile" ? "personal" : "project",
          confidence: 1,
          category: input.semanticType === "profile" ? "preference" : "core",
        }
      : {
          ...base,
          type: "observeAuto",
          intent: "auto",
          kind: input.source === "verified_decision" ? "decision" : "fact",
          container: "session_candidate",
          confidence: 0.9,
          category: input.source === "verified_decision" ? "decision" : "fact",
        };
    const written = await this.dependencies.memoryWrite.executeMemoryWrite(command);
    const promotionReceipt = input.memoryForm === undefined ? undefined : createWorkingSetPromotionReceipt({
      entryIds: input.evidenceEntryIds,
      evidenceRefs: input.evidenceRefs,
      memoryForm: input.memoryForm,
      scopeFingerprint,
      idempotencyKey: input.idempotencyKey,
      operatorOrPolicy: input.operatorOrPolicy ?? "policy:working-set-promote",
    });
    const delivered: WorkingSetPromotionResult = {
      ...written,
      ...(promotionReceipt === undefined ? {} : { promotionReceipt }),
      replayed: false,
    };
    if (written.status === "persisted" || written.status === "duplicate" || written.status === "ignored") {
      this.promotions.set(cacheKey, { hash: payloadHash, result: delivered });
    }
    return delivered;
  }
}
