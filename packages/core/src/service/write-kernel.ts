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
  type WriteIdempotencyIdentity,
} from "./write-kernel-transaction.js";

export type WriteAdmissionRoute =
  | "drop"
  | "candidate_low_priority"
  | "candidate"
  | "active"
  | "lookup_only"
  | "evidence_only";

export interface WriteScope {
  tenantId: string;
  userId: string;
  appId: string;
  projectId: string;
  agentId: string;
  namespace: string;
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
}

export interface WriteDedupResult {
  duplicate: boolean;
  duplicateOf?: string;
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
      correctsId?: string;
      sourceId?: string;
    })
  | (BaseWriteMemoryRecord & {
      mutation: "lifecycle";
      targetId: string;
      lifecycleAction: "revoke" | "archive" | "delete";
    });

export interface WriteAuditEvent {
  action: "memory.write";
  memoryId: string;
  commandType: MemoryWriteCommand["type"];
  scope: WriteScope;
  route?: WriteAdmissionRoute;
  correctionKind?: MemoryCorrectionKind;
  at: number;
}

export interface WriteOutboxEvent {
  topic: "memory.written" | "memory.lifecycle.changed";
  memoryId: string;
  commandType: MemoryWriteCommand["type"];
  scope: WriteScope;
  correctionKind?: MemoryCorrectionKind;
  at: number;
}

export interface MemoryWriteTransactionContext {
  /** Must lock this identity for the lifetime of the callback transaction. */
  getReceipt(identity: WriteIdempotencyIdentity): Promise<MemoryWriteReceipt | undefined>;
  saveReceipt(receipt: MemoryWriteReceipt): Promise<void>;
  writeMemory(memory: WriteMemoryRecord): Promise<void>;
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
  exactDedup(input: WritePipelineInput): Promise<WriteDedupResult> | WriteDedupResult;
  semanticDedup(input: WritePipelineInput): Promise<WriteDedupResult> | WriteDedupResult;
  /** Resolves only after commit; rejects on work, receipt, commit, or release failure. */
  transaction<T>(work: (context: MemoryWriteTransactionContext) => Promise<T>): Promise<T>;
  ack(input: {
    command: MemoryWriteCommand;
    /** Receipt is committed before this post-commit presentation hook is invoked. */
    committedReceipt: MemoryWriteReceipt;
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

export type MemoryWriteKernelResult =
  | ({ status: "persisted"; route: WriteAdmissionRoute; memoryId: string } & Readonly<Record<string, unknown>>)
  | ({ status: "persisted"; correctionKind: Exclude<MemoryCorrectionKind, "replaceText">; memoryId: string } & Readonly<Record<string, unknown>>)
  | { status: "rejected"; reason: string }
  | { status: "duplicate"; kind: "exact" | "semantic"; duplicateOf?: string }
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
  ): MemoryWriteReceipt {
    let validated: MemoryWriteReceipt;
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
    receipt: MemoryWriteReceipt,
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
    const result: Extract<MemoryWriteKernelResult, { status: "persisted" }> =
      memory.mutation === "lifecycle"
        ? {
            status: "persisted",
            correctionKind: memory.lifecycleAction,
            memoryId: memory.id,
          }
        : {
            status: "persisted",
            route: memory.route,
            memoryId: memory.id,
          };
    const proposedReceipt = createMemoryWriteReceipt(identity, fingerprint, result);

    // Final short transaction performs the concurrency second-check and all durable mutation.
    const committedReceipt = await this.dependencies.transaction(async (transaction) => {
      const winner = await transaction.getReceipt(identity);
      if (winner) return this.validateExistingReceipt(winner, identity, fingerprint);

      await transaction.writeMemory(memory);
      await transaction.appendAudit({
        action: "memory.write",
        memoryId: memory.id,
        commandType: command.type,
        scope: memory.scope,
        ...(memory.mutation === "lifecycle"
          ? { correctionKind: memory.lifecycleAction }
          : { route: memory.route }),
        at: memory.createdAt,
      });
      await transaction.appendOutbox({
        topic: memory.mutation === "lifecycle"
          ? "memory.lifecycle.changed"
          : "memory.written",
        memoryId: memory.id,
        commandType: command.type,
        scope: memory.scope,
        ...(memory.mutation === "lifecycle"
          ? { correctionKind: memory.lifecycleAction }
          : {}),
        at: memory.createdAt,
      });
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

    const exact = await this.dependencies.exactDedup(pipelineInput);
    if (exact.duplicate) {
      return { status: "duplicate", kind: "exact", duplicateOf: exact.duplicateOf };
    }
    const semantic = await this.dependencies.semanticDedup(pipelineInput);
    if (semantic.duplicate) {
      return { status: "duplicate", kind: "semantic", duplicateOf: semantic.duplicateOf };
    }

    const route = persistedRoute(command, admission);
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
        createdAt: this.dependencies.now(),
        ...(command.type === "correctMemory" ? { correctsId: command.targetId } : {}),
        ...(command.type === "importEvidence" ? { sourceId: command.sourceId } : {}),
    };
    return this.commitDurable(command, memory, identity, fingerprint);
  }
}
