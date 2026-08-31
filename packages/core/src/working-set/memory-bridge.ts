import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../domain/types.js";
import type {
  MemoryWriteCommand,
  MemoryWriteKernelResult,
} from "../service/write-kernel.js";
import { SessionWorkingSetError } from "./session-working-set-service.js";
import type { SessionWorkingSetRepository } from "./repository.js";
import type { PromoteWorkingSetClaimInput } from "./types.js";

export interface WorkingSetMemoryWriteExecutor {
  executeMemoryWrite(command: MemoryWriteCommand): Promise<MemoryWriteKernelResult>;
}

const SAFE_ID = /^[^\s\p{Cc}]{1,256}$/u;

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function exactSession(scope: MemoryScope, sessionId: string): void {
  if (scope.visibility !== "private" || scope.sessionId !== sessionId || !SAFE_ID.test(sessionId)) {
    throw new SessionWorkingSetError("WORKING_SET_SCOPE_MISMATCH");
  }
  try { authorityScopeFingerprint(scope); } catch {
    throw new SessionWorkingSetError("WORKING_SET_SCOPE_MISMATCH");
  }
}

export class SessionWorkingSetMemoryBridge {
  constructor(readonly dependencies: {
    readonly repository: SessionWorkingSetRepository;
    readonly memoryWrite: WorkingSetMemoryWriteExecutor;
    readonly serverAuthority: unknown;
  }) {}

  async promoteClaim(input: PromoteWorkingSetClaimInput): Promise<MemoryWriteKernelResult> {
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
        (input.source === "verified_outcome" && input.semanticType !== "experience")) {
      throw new SessionWorkingSetError("WORKING_SET_PROMOTION_INVALID");
    }
    const scopeFingerprint = authorityScopeFingerprint(input.scope);
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
    return this.dependencies.memoryWrite.executeMemoryWrite(command);
  }
}
