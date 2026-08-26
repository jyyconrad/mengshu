/**
 * Provider-agnostic write orchestration kernel.
 *
 * The kernel owns ordering and fail-closed branching only. Every policy,
 * model call and durable operation is injected through an explicit contract.
 */

import {
  createMemoryWriteReceipt,
  createWriteCommandFingerprint,
  createWriteIdempotencyIdentity,
  validateMemoryWriteReceipt,
  type MemoryWriteReceipt,
  type NormalizedMemoryWriteReceipt,
  type WriteIdempotencyIdentity,
} from "./write-kernel-transaction.js";
import type { MemoryCategory } from "../../../../config.js";
import type {
  MemoryContainer,
  MemoryKind,
  MemorySemanticType,
  RecordProvenance,
} from "../domain/types.js";
import type { DataType, TableName } from "../db/types.js";
import type { ValueScoreSignalProvenance } from "../scoring/value-score-signals.js";

export type WriteAdmissionRoute =
  | "drop"
  | "candidate_low_priority"
  | "candidate"
  | "active"
  | "lookup_only"
  | "evidence_only";

export type CandidateWriteAdmissionRoute = "candidate_low_priority" | "candidate";
export type MemoryWriteAdmissionRoute = "active" | "lookup_only" | "evidence_only";

export interface WriteScope {
  tenantId: string;
  userId: string;
  appId: string;
  projectId: string;
  agentId: string;
  namespace: string;
  workspaceId?: string;
  sessionId?: string;
  visibility?: "private" | "workspace" | "team" | "public";
}

interface WriteCommandContext {
  /** Client supplied; storage identity is always server tenant/user scoped. */
  idempotencyKey: string;
  serverAuthority: unknown;
  clientScope: unknown;
  metadata?: Readonly<Record<string, unknown>>;
}

interface TextWriteCommand extends WriteCommandContext {
  text: string;
  /** Mengshu 底层通用分类；即使没有 5-slot semanticType 也必须保留。 */
  kind: MemoryKind;
  /** 可选上下文视图。kind-only 显式保存可以持久化，但不会进入 5 槽位。 */
  semanticType?: MemorySemanticType;
  container?: MemoryContainer;
  confidence?: number;
  category?: MemoryCategory;
  dataType?: DataType;
  tableName?: TableName;
  provenance?: Readonly<RecordProvenance>;
  evidenceIds?: readonly string[];
  /** Untrusted caller-supplied vector; never consumed before embeddingGuard. */
  vector?: readonly number[];
}

export type MemoryCorrectionKind = "replaceText" | "revoke" | "archive" | "delete";

export type CorrectMemoryCommand =
  | (TextWriteCommand & {
      type: "correctMemory";
      correctionKind: "replaceText";
      targetId: string;
    })
  | (WriteCommandContext & {
      type: "correctMemory";
      correctionKind: "revoke" | "archive" | "delete";
      targetId: string;
    });

export type MemoryWriteCommand =
  | (TextWriteCommand & { type: "saveExplicit" })
  | (TextWriteCommand & {
      type: "observeAuto";
      intent: "remember" | "auto" | "ignore";
    })
  | (TextWriteCommand & { type: "importEvidence"; sourceId: string })
  | CorrectMemoryCommand;

export interface NormalizedWrite {
  text: string;
  metadata: Readonly<Record<string, unknown>>;
  promptRisk: boolean;
}

export interface ValidatedWriteCandidate {
  readonly [key: string]: unknown;
}

export type WriteValidationResult =
  | { accepted: true; candidate: ValidatedWriteCandidate }
  | { accepted: false; reason: string };

export interface WriteAdmissionResult {
  route: WriteAdmissionRoute;
  valueScore: number;
  reason?: string;
  breakdown?: Readonly<Record<string, number>>;
  valueSignalProvenance?: ValueScoreSignalProvenance;
}

export interface WriteDedupResult {
  duplicate: boolean;
  duplicateOf?: string;
  /** Deterministic dedup layer used for explain/audit; legacy adapters may omit it. */
  layer?: "exact" | "lexical" | "semantic";
}

interface BaseWriteMemoryRecord {
  id: string;
  commandType: MemoryWriteCommand["type"];
  scope: WriteScope;
  metadata: Readonly<Record<string, unknown>>;
  createdAt: number;
}

export type WriteMemoryRecord =
  | (BaseWriteMemoryRecord & {
      mutation: "content";
      text: string;
      vector: readonly number[];
      route: WriteAdmissionRoute;
      valueScore: number;
      /**
       * Recall salience, computed independently from admission valueScore.
       * Optional only for transitional provider fixtures; kernel output always sets it and
       * persistence mappers reject a missing value.
       */
      importance?: number;
      kind: MemoryKind;
      semanticType?: MemorySemanticType;
      container?: MemoryContainer;
      confidence?: number;
      category?: MemoryCategory;
      dataType?: DataType;
      tableName?: TableName;
      provenance: Readonly<RecordProvenance>;
      evidenceIds: readonly string[];
      governance: Readonly<{
        candidate: ValidatedWriteCandidate;
        admissionReason?: string;
        admissionBreakdown?: Readonly<Record<string, number>>;
        valueSignalProvenance?: ValueScoreSignalProvenance;
      }>;
      correctsId?: string;
      sourceId?: string;
    })
  | (BaseWriteMemoryRecord & {
      mutation: "lifecycle";
      targetId: string;
      lifecycleAction: "revoke" | "archive" | "delete";
    });

interface BaseWriteAuditEvent {
  memoryId: string;
  requestFingerprint: string;
  commandType: MemoryWriteCommand["type"];
  scope: WriteScope;
  route?: WriteAdmissionRoute;
  correctionKind?: MemoryCorrectionKind;
  at: number;
}

export type WriteAuditEvent = BaseWriteAuditEvent & (
  | { action: "candidate.write"; recordType: "candidate" }
  | { action: "memory.write"; recordType?: "memory" }
);

interface BaseWriteOutboxEvent {
  memoryId: string;
  requestFingerprint: string;
  commandType: MemoryWriteCommand["type"];
  scope: WriteScope;
  correctionKind?: MemoryCorrectionKind;
  at: number;
}

export type WriteOutboxEvent = BaseWriteOutboxEvent & (
  | { topic: "candidate.written"; recordType: "candidate" }
  | { topic: "memory.written" | "memory.lifecycle.changed"; recordType?: "memory" }
);

export interface MemoryWriteTransactionContext {
  /** Must lock this identity for the lifetime of the callback transaction. */
  getReceipt(identity: WriteIdempotencyIdentity): Promise<MemoryWriteReceipt | undefined>;
  saveReceipt(receipt: MemoryWriteReceipt): Promise<void>;
  writeMemory(memory: WriteMemoryRecord): Promise<{
    memoryId: string;
    stored: boolean;
  }>;
  appendAudit(event: WriteAuditEvent): Promise<void>;
  appendOutbox(event: WriteOutboxEvent): Promise<void>;
}

export interface MemoryWriteKernelDependencies {
  resolveAuthority(input: {
    serverAuthority: unknown;
    clientScope: unknown;
    command: MemoryWriteCommand;
  }): Promise<WriteScope> | WriteScope;
  normalize(input: {
    command: MemoryWriteCommand;
    scope: WriteScope;
  }): Promise<NormalizedWrite> | NormalizedWrite;
  embeddingGuard(input: {
    command: MemoryWriteCommand;
    scope: WriteScope;
    normalized: NormalizedWrite;
    suppliedVector?: readonly number[];
  }): Promise<{ ok: true } | { ok: false; reason: string }> | { ok: true } | { ok: false; reason: string };
  embed(input: {
    text: string;
    command: MemoryWriteCommand;
    scope: WriteScope;
  }): Promise<readonly number[]>;
  validate(input: {
    command: MemoryWriteCommand;
    scope: WriteScope;
    normalized: NormalizedWrite;
    vector?: readonly number[];
  }): Promise<WriteValidationResult> | WriteValidationResult;
  scoreAdmission(input: {
    command: MemoryWriteCommand;
    scope: WriteScope;
    normalized: NormalizedWrite;
    vector: readonly number[];
    candidate: ValidatedWriteCandidate;
  }): Promise<WriteAdmissionResult> | WriteAdmissionResult;
  scoreImportance(input: WritePipelineInput): Promise<number> | number;
  exactDedup(input: WritePipelineInput): Promise<WriteDedupResult> | WriteDedupResult;
  semanticDedup(input: WritePipelineInput): Promise<WriteDedupResult> | WriteDedupResult;
  /** Resolves only after commit; rejects on work, receipt, commit, or release failure. */
  transaction<T>(work: (context: MemoryWriteTransactionContext) => Promise<T>): Promise<T>;
  ack(input: {
    command: MemoryWriteCommand;
    /** Receipt is committed before this post-commit presentation hook is invoked. */
    committedReceipt: NormalizedMemoryWriteReceipt;
  }): Promise<void> | void;
  createId(): string;
  now(): number;
}

export interface WritePipelineInput {
  command: MemoryWriteCommand;
  scope: WriteScope;
  normalized: NormalizedWrite;
  vector: readonly number[];
  candidate: ValidatedWriteCandidate;
  admission: WriteAdmissionResult;
}

export type PersistedMemoryWriteResult = {
  status: "persisted";
  route: MemoryWriteAdmissionRoute;
  recordType: "memory";
  memoryId: string;
  stored: boolean;
};

export type PersistedCandidateWriteResult = {
  status: "persisted";
  route: CandidateWriteAdmissionRoute;
  recordType: "candidate";
  candidateId: string;
  /** Compatibility alias for callers that historically consumed only memoryId. */
  memoryId: string;
  stored: boolean;
};

export type PersistedLifecycleWriteResult = {
  status: "persisted";
  correctionKind: Exclude<MemoryCorrectionKind, "replaceText">;
  recordType: "memory";
  memoryId: string;
  stored: boolean;
};

export type MemoryWriteKernelResult =
  | PersistedMemoryWriteResult
  | PersistedCandidateWriteResult
  | PersistedLifecycleWriteResult
  | { status: "rejected"; reason: string }
  | {
      status: "duplicate";
      kind: "exact" | "lexical" | "semantic";
      duplicateOf?: string;
    }
  | { status: "ignored"; durable: false };

export type WriteKernelErrorCode =
  | "AUTHORITY_REJECTED"
  | "INVALID_COMMAND"
  | "IDEMPOTENCY_REQUIRED"
  | "IDEMPOTENCY_CONFLICT";

export class WriteKernelError extends Error {
  readonly code: WriteKernelErrorCode;

  constructor(code: WriteKernelErrorCode, message: string) {
    super(message);
    this.name = "WriteKernelError";
    this.code = code;
  }
}

function persistedRoute(
  command: MemoryWriteCommand,
  admission: WriteAdmissionResult,
): WriteAdmissionRoute {
  if (command.type === "observeAuto" && admission.route === "active") {
    return "candidate";
  }
  return admission.route;
}

function isCandidateRoute(route: WriteAdmissionRoute): route is CandidateWriteAdmissionRoute {
  return route === "candidate_low_priority" || route === "candidate";
}

function isMemoryRoute(route: WriteAdmissionRoute): route is MemoryWriteAdmissionRoute {
  return route === "active" || route === "lookup_only" || route === "evidence_only";
}

function validScore(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`write kernel ${label} must be within [0,1]`);
  }
  return value;
}

function governedConfidence(
  command: MemoryWriteCommand,
  candidate: ValidatedWriteCandidate,
): number | undefined {
  if (typeof candidate.confidence === "number") {
    return validScore(candidate.confidence, "confidence");
  }
  return "confidence" in command && command.confidence !== undefined
    ? validScore(command.confidence, "confidence")
    : undefined;
}

function isLifecycleCorrection(
  command: MemoryWriteCommand,
): command is Extract<CorrectMemoryCommand, { correctionKind: "revoke" | "archive" | "delete" }> {
  return command.type === "correctMemory" && command.correctionKind !== "replaceText";
}

export class MemoryWriteKernel {
  constructor(private readonly dependencies: MemoryWriteKernelDependencies) {}

  private validateExistingReceipt(
    existing: MemoryWriteReceipt,
    identity: WriteIdempotencyIdentity,
    fingerprint: string,
  ): NormalizedMemoryWriteReceipt {
    let validated: NormalizedMemoryWriteReceipt;
    try {
      validated = validateMemoryWriteReceipt(existing, identity);
    } catch (error) {
      throw new WriteKernelError(
        "IDEMPOTENCY_CONFLICT",
        error instanceof Error ? error.message : "write receipt is invalid",
      );
    }
    if (validated.requestFingerprint !== fingerprint) {
      throw new WriteKernelError(
        "IDEMPOTENCY_CONFLICT",
        "idempotency key was already used for a different write command",
      );
    }
    return validated;
  }

  private async acknowledge(
    command: MemoryWriteCommand,
    receipt: NormalizedMemoryWriteReceipt,
  ): Promise<Extract<MemoryWriteKernelResult, { status: "persisted" }>> {
    await this.dependencies.ack({ command, committedReceipt: receipt });
    return receipt.result;
  }

  private async commitDurable(
    command: MemoryWriteCommand,
    memory: WriteMemoryRecord,
    identity: WriteIdempotencyIdentity,
    fingerprint: string,
  ): Promise<Extract<MemoryWriteKernelResult, { status: "persisted" }>> {
    // Final short transaction performs the concurrency second-check and all durable mutation.
    const committedReceipt = await this.dependencies.transaction(async (transaction) => {
      const winner = await transaction.getReceipt(identity);
      if (winner) return this.validateExistingReceipt(winner, identity, fingerprint);

      const mutation = await transaction.writeMemory(memory);
      if (typeof mutation.memoryId !== "string" || mutation.memoryId.length === 0 ||
          typeof mutation.stored !== "boolean") {
        throw new Error("write transaction returned an invalid mutation result");
      }
      const result: Extract<MemoryWriteKernelResult, { status: "persisted" }> =
        memory.mutation === "lifecycle"
          ? {
              status: "persisted",
              correctionKind: memory.lifecycleAction,
              recordType: "memory",
              memoryId: mutation.memoryId,
              stored: mutation.stored,
            }
          : isCandidateRoute(memory.route)
          ? {
              status: "persisted",
              route: memory.route,
              recordType: "candidate",
              candidateId: mutation.memoryId,
              memoryId: mutation.memoryId,
              stored: mutation.stored,
            }
          : isMemoryRoute(memory.route)
          ? {
              status: "persisted",
              route: memory.route,
              recordType: "memory",
              memoryId: mutation.memoryId,
              stored: mutation.stored,
            }
          : (() => { throw new Error("write kernel cannot persist a drop route"); })();
      const proposedReceipt = createMemoryWriteReceipt(identity, fingerprint, result);

      if (mutation.stored) {
        const recordType = memory.mutation === "content" && isCandidateRoute(memory.route)
          ? "candidate" as const
          : "memory" as const;
        const auditBase: BaseWriteAuditEvent = {
          memoryId: mutation.memoryId,
          requestFingerprint: fingerprint,
          commandType: command.type,
          scope: memory.scope,
          ...(memory.mutation === "lifecycle"
            ? { correctionKind: memory.lifecycleAction }
            : { route: memory.route }),
          at: memory.createdAt,
        };
        await transaction.appendAudit(recordType === "candidate"
          ? { ...auditBase, action: "candidate.write", recordType: "candidate" }
          : { ...auditBase, action: "memory.write", recordType: "memory" });
        const outboxBase: BaseWriteOutboxEvent = {
          memoryId: mutation.memoryId,
          requestFingerprint: fingerprint,
          commandType: command.type,
          scope: memory.scope,
          ...(memory.mutation === "lifecycle"
            ? { correctionKind: memory.lifecycleAction }
            : {}),
          at: memory.createdAt,
        };
        await transaction.appendOutbox(recordType === "candidate"
          ? { ...outboxBase, topic: "candidate.written", recordType: "candidate" }
          : {
              ...outboxBase,
              topic: memory.mutation === "lifecycle"
                ? "memory.lifecycle.changed"
                : "memory.written",
              recordType: "memory",
            });
      }
      await transaction.saveReceipt(proposedReceipt);
      return proposedReceipt;
    });

    return this.acknowledge(command, committedReceipt);
  }

  async execute(command: MemoryWriteCommand): Promise<MemoryWriteKernelResult> {
    const scope = await this.dependencies.resolveAuthority({
      serverAuthority: command.serverAuthority,
      clientScope: command.clientScope,
      command,
    });
    let identity: WriteIdempotencyIdentity;
    let fingerprint: string;
    try {
      identity = createWriteIdempotencyIdentity(scope, command.idempotencyKey);
      fingerprint = createWriteCommandFingerprint(scope, command);
    } catch (error) {
      const message = error instanceof Error ? error.message : "write command is invalid";
      throw new WriteKernelError(
        message.includes("idempotency") ? "IDEMPOTENCY_REQUIRED" : "INVALID_COMMAND",
        message,
      );
    }

    // Short preflight transaction: lock/read/commit only. No model or policy work while its DB lock is held.
    const existing = await this.dependencies.transaction((transaction) =>
      transaction.getReceipt(identity));
    if (existing) {
      return this.acknowledge(
        command,
        this.validateExistingReceipt(existing, identity, fingerprint),
      );
    }

    const normalized = await this.dependencies.normalize({ command, scope });

    if (command.type === "observeAuto" && command.intent === "ignore") {
      return { status: "ignored", durable: false };
    }

    if (isLifecycleCorrection(command)) {
      const validation = await this.dependencies.validate({
        command,
        scope,
        normalized,
        vector: undefined,
      });
      if (!validation.accepted) {
        return { status: "rejected", reason: validation.reason };
      }

      const memory: WriteMemoryRecord = {
        id: command.targetId,
        commandType: command.type,
        mutation: "lifecycle",
        targetId: command.targetId,
        lifecycleAction: command.correctionKind,
        scope,
        metadata: normalized.metadata,
        createdAt: this.dependencies.now(),
      };
      return this.commitDurable(command, memory, identity, fingerprint);
    }

    const guard = await this.dependencies.embeddingGuard({
        command,
        scope,
        normalized,
        suppliedVector: command.vector,
    });
    if (!guard.ok) {
      return { status: "rejected", reason: guard.reason };
    }

    const vector = command.type !== "correctMemory" && command.vector
        ? Object.freeze([...command.vector])
        : await this.dependencies.embed({ text: normalized.text, command, scope });
    const validation = await this.dependencies.validate({
        command,
        scope,
        normalized,
        vector,
    });
    if (!validation.accepted) {
      return { status: "rejected", reason: validation.reason };
    }

    const admission = await this.dependencies.scoreAdmission({
        command,
        scope,
        normalized,
        vector,
        candidate: validation.candidate,
    });
    if (admission.route === "drop") {
      return { status: "rejected", reason: admission.reason ?? "admission_drop" };
    }
    const pipelineInput: WritePipelineInput = {
        command,
        scope,
        normalized,
        vector,
        candidate: validation.candidate,
        admission,
    };
    const importance = validScore(
      await this.dependencies.scoreImportance(pipelineInput),
      "importance",
    );

    const exact = await this.dependencies.exactDedup(pipelineInput);
    if (exact.duplicate) {
      return {
        status: "duplicate",
        kind: exact.layer ?? "exact",
        duplicateOf: exact.duplicateOf,
      };
    }
    const semantic = await this.dependencies.semanticDedup(pipelineInput);
    if (semantic.duplicate) {
      return {
        status: "duplicate",
        kind: semantic.layer ?? "semantic",
        duplicateOf: semantic.duplicateOf,
      };
    }

    const route = persistedRoute(command, admission);
    const confidence = governedConfidence(command, validation.candidate);
    const memory: WriteMemoryRecord = {
        id: this.dependencies.createId(),
        commandType: command.type,
        mutation: "content",
        scope,
        text: normalized.text,
        metadata: normalized.metadata,
        vector,
        route,
        valueScore: admission.valueScore,
        importance,
        kind: command.kind,
        ...(command.semanticType === undefined ? {} : { semanticType: command.semanticType }),
        ...(command.container === undefined ? {} : { container: command.container }),
        ...(confidence === undefined ? {} : { confidence }),
        ...(command.category === undefined ? {} : { category: command.category }),
        ...(command.dataType === undefined ? {} : { dataType: command.dataType }),
        ...(command.tableName === undefined ? {} : { tableName: command.tableName }),
        provenance: Object.freeze({ ...(command.provenance ?? {}) }),
        evidenceIds: Object.freeze([...(command.evidenceIds ?? [])]),
        governance: Object.freeze({
          candidate: validation.candidate,
          ...(admission.reason === undefined
            ? {}
            : { admissionReason: admission.reason }),
          ...(admission.breakdown === undefined
            ? {}
            : { admissionBreakdown: Object.freeze({ ...admission.breakdown }) }),
          ...(admission.valueSignalProvenance === undefined
            ? {}
            : { valueSignalProvenance: admission.valueSignalProvenance }),
        }),
        createdAt: this.dependencies.now(),
        ...(command.type === "correctMemory" ? { correctsId: command.targetId } : {}),
        ...(command.type === "importEvidence" ? { sourceId: command.sourceId } : {}),
    };
    return this.commitDurable(command, memory, identity, fingerprint);
  }
}
