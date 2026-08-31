import { createHash } from "node:crypto";

import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../domain/types.js";
import type { SessionWorkingSetRepository } from "./repository.js";
import type {
  ContextRewriteLevel,
  ContextRewriteReceipt,
  IngestToolPairInput,
  ReadSessionPayloadInput,
  RecordTaskBoundaryInput,
  SessionAssembleInput,
  SessionAssembleResult,
  SessionContextMessage,
  SessionPayloadRef,
  SessionPayloadReadResult,
  TaskOutline,
  TaskBoundaryAck,
  WorkingSetAck,
  WorkingSetCleanupReceipt,
  WorkingSetRetentionBatchResult,
  WorkingSetEntry,
  WorkingSetRewritePolicy,
} from "./types.js";

export type SessionWorkingSetErrorCode =
  | "WORKING_SET_INVALID"
  | "WORKING_SET_SCOPE_MISMATCH"
  | "WORKING_SET_IDEMPOTENCY_CONFLICT"
  | "WORKING_SET_SUMMARY_INVALID"
  | "WORKING_SET_PAYLOAD_UNVERIFIED"
  | "WORKING_SET_PAYLOAD_READ_UNAVAILABLE"
  | "WORKING_SET_PAYLOAD_HASH_MISMATCH"
  | "WORKING_SET_PROMOTION_INVALID"
  | "WORKING_SET_EVIDENCE_UNAVAILABLE"
  | "WORKING_SET_NOT_FOUND"
  | "WORKING_SET_VERSION_STALE";

export class SessionWorkingSetError extends Error {
  override readonly name = "SessionWorkingSetError";

  constructor(readonly code: SessionWorkingSetErrorCode) {
    super(code);
  }
}

export interface WorkingSetTokenCounter {
  count(text: string): number;
}

export interface SessionPayloadVerifier {
  verify(payloadRef: SessionPayloadRef): Promise<boolean> | boolean;
}

export interface SessionPayloadReader {
  read(payloadRef: SessionPayloadRef, maxBytes: number): Promise<Uint8Array>;
}

export interface SessionPayloadRetention {
  delete(payloadRef: SessionPayloadRef): Promise<void>;
}

export interface WorkingSetEvidenceRetentionGuard {
  canRelease(input: {
    readonly scope: MemoryScope;
    readonly sessionId: string;
    readonly entry: WorkingSetEntry;
  }): Promise<boolean>;
}

export interface SessionWorkingSetServiceOptions {
  readonly now?: () => number;
  readonly tokenCounter?: WorkingSetTokenCounter;
  readonly payloadVerifier?: SessionPayloadVerifier;
  readonly payloadReader?: SessionPayloadReader;
  readonly maxPayloadReadBytes?: number;
  readonly policy?: Partial<WorkingSetRewritePolicy>;
  readonly retentionDays?: number;
  readonly payloadRetention?: SessionPayloadRetention;
  readonly evidenceRetentionGuard?: WorkingSetEvidenceRetentionGuard;
}

const SAFE_ID = /^[^\s\p{Cc}]{1,256}$/u;
const SHA256 = /^[0-9a-f]{64}$/;
const DEFAULT_POLICY: WorkingSetRewritePolicy = Object.freeze({
  version: "session-working-set-policy-v1",
  mildRatio: 0.5,
  aggressiveRatio: 0.85,
  emergencyRatio: 0.95,
  emergencyTargetRatio: 0.6,
  outlineMaxRatio: 0.2,
});

function hash(domain: string, value: unknown): string {
  return createHash("sha256").update(`${domain}\0${JSON.stringify(value)}`).digest("hex");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function exactSessionFingerprint(scope: MemoryScope, sessionId: string): string {
  if (scope.visibility !== "private" || scope.sessionId !== sessionId || !SAFE_ID.test(sessionId)) {
    throw new SessionWorkingSetError("WORKING_SET_SCOPE_MISMATCH");
  }
  try {
    return authorityScopeFingerprint(scope);
  } catch {
    throw new SessionWorkingSetError("WORKING_SET_SCOPE_MISMATCH");
  }
}

function validatePolicy(policy: WorkingSetRewritePolicy): void {
  if (!SAFE_ID.test(policy.version) ||
      !(policy.mildRatio > 0 && policy.mildRatio < policy.aggressiveRatio &&
        policy.aggressiveRatio < policy.emergencyRatio && policy.emergencyRatio < 1) ||
      !(policy.emergencyTargetRatio > 0 && policy.emergencyTargetRatio < policy.aggressiveRatio) ||
      !(policy.outlineMaxRatio > 0 && policy.outlineMaxRatio <= 0.2)) {
    throw new SessionWorkingSetError("WORKING_SET_INVALID");
  }
}

function validatePayloadRef(payloadRef: SessionPayloadRef): void {
  if (!SAFE_ID.test(payloadRef.locator) || !SHA256.test(payloadRef.contentHash) ||
      !Number.isSafeInteger(payloadRef.byteLength) || payloadRef.byteLength < 0 ||
      (payloadRef.mimeType !== undefined && !/^[^\s\p{Cc}]{1,128}$/u.test(payloadRef.mimeType))) {
    throw new SessionWorkingSetError("WORKING_SET_INVALID");
  }
}

function validateToolPairInput(input: IngestToolPairInput): void {
  if (!SAFE_ID.test(input.toolCallId) || !SAFE_ID.test(input.toolName) ||
      !SAFE_ID.test(input.idempotencyKey) || input.sourceMessageIds.length !== 2 ||
      input.sourceMessageIds.some((id) => !SAFE_ID.test(id)) ||
      new Set(input.sourceMessageIds).size !== 2 ||
      !Number.isFinite(input.replaceability) || input.replaceability < 0 ||
      input.replaceability > 1 || input.evidenceRefs.some((id) => !SAFE_ID.test(id)) ||
      input.riskFlags.some((id) => !SAFE_ID.test(id))) {
    throw new SessionWorkingSetError("WORKING_SET_INVALID");
  }
  validatePayloadRef(input.payloadRef);
}

function validateSummary(input: IngestToolPairInput, summary: string): string {
  const value = summary.trim();
  const normalized = value.toLocaleLowerCase("en-US");
  if (value.length === 0 || value.length > 2_048 || !value.includes(input.toolName) ||
      !value.includes(input.payloadRef.locator)) {
    throw new SessionWorkingSetError("WORKING_SET_SUMMARY_INVALID");
  }
  if (input.outcome !== "success" &&
      /\b(success|succeeded|passed|all tests passed)\b/i.test(normalized)) {
    throw new SessionWorkingSetError("WORKING_SET_SUMMARY_INVALID");
  }
  const outcomeSignals: Record<IngestToolPairInput["outcome"], RegExp> = {
    success: /\b(success|succeeded|passed|ok)\b/i,
    failure: /\b(failure|failed|error|exitcode=[1-9])\b/i,
    permission_denied: /\b(permission[_ -]?denied|forbidden|unauthorized)\b/i,
    cancelled: /\b(cancelled|canceled|aborted)\b/i,
  };
  if (!outcomeSignals[input.outcome].test(normalized)) {
    throw new SessionWorkingSetError("WORKING_SET_SUMMARY_INVALID");
  }
  return value;
}

function levelFor(ratio: number, policy: WorkingSetRewritePolicy): ContextRewriteLevel {
  if (ratio >= policy.emergencyRatio) return "emergency";
  if (ratio >= policy.aggressiveRatio) return "aggressive";
  if (ratio >= policy.mildRatio) return "mild";
  return "normal";
}

function targetFor(level: ContextRewriteLevel, window: number, policy: WorkingSetRewritePolicy): number {
  if (level === "emergency") return Math.floor(window * policy.emergencyTargetRatio);
  if (level === "aggressive") return Math.floor(window * policy.aggressiveRatio);
  if (level === "mild") return Math.floor(window * policy.mildRatio);
  return window;
}

function summaryMessage(entry: WorkingSetEntry): SessionContextMessage {
  return {
    id: `working-set:${entry.id}`,
    role: "assistant",
    content: `${entry.toolName}:${entry.payloadRef?.locator}`,
    toolCallId: entry.toolCallId,
  };
}

function taskOutlineMessage(outline: TaskOutline): SessionContextMessage {
  return Object.freeze({
    id: `working-set-outline:${outline.id}:v${outline.version}`,
    role: "system" as const,
    content: `[TaskOutline]\n${JSON.stringify({
      goal: outline.goal,
      status: outline.status,
      completedSteps: outline.completedSteps,
      currentSteps: outline.currentSteps,
      nextSteps: outline.nextSteps,
      decisions: outline.decisions,
      openQuestions: outline.openQuestions,
      entryRefs: outline.entryRefs,
      evidenceRefs: outline.evidenceRefs,
      version: outline.version,
      policyVersion: outline.policyVersion,
    })}`,
  });
}

function injectOutline(
  messages: readonly SessionContextMessage[],
  outline: SessionContextMessage,
): SessionContextMessage[] {
  const result = [...messages];
  let index = 0;
  while (index < result.length &&
      (result[index]?.role === "system" || result[index]?.role === "developer")) index += 1;
  result.splice(index, 0, outline);
  return result;
}

export class SessionWorkingSetService {
  readonly #now: () => number;
  readonly #tokenCounter?: WorkingSetTokenCounter;
  readonly #payloadVerifier: SessionPayloadVerifier;
  readonly #payloadReader?: SessionPayloadReader;
  readonly #maxPayloadReadBytes: number;
  readonly #policy: WorkingSetRewritePolicy;
  readonly #retentionDays?: number;
  readonly #payloadRetention?: SessionPayloadRetention;
  readonly #evidenceRetentionGuard?: WorkingSetEvidenceRetentionGuard;

  constructor(
    readonly repository: SessionWorkingSetRepository,
    options: SessionWorkingSetServiceOptions = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#tokenCounter = options.tokenCounter;
    this.#payloadVerifier = options.payloadVerifier ?? { verify: () => true };
    this.#payloadReader = options.payloadReader;
    this.#maxPayloadReadBytes = options.maxPayloadReadBytes ?? 1_048_576;
    if (!Number.isSafeInteger(this.#maxPayloadReadBytes) || this.#maxPayloadReadBytes < 1) {
      throw new SessionWorkingSetError("WORKING_SET_INVALID");
    }
    this.#policy = Object.freeze({ ...DEFAULT_POLICY, ...options.policy });
    validatePolicy(this.#policy);
    if (options.retentionDays !== undefined &&
        (!Number.isSafeInteger(options.retentionDays) || options.retentionDays < 0)) {
      throw new SessionWorkingSetError("WORKING_SET_INVALID");
    }
    this.#retentionDays = options.retentionDays;
    this.#payloadRetention = options.payloadRetention;
    this.#evidenceRetentionGuard = options.evidenceRetentionGuard;
  }

  async ingestToolPair(input: IngestToolPairInput): Promise<WorkingSetAck> {
    validateToolPairInput(input);
    const scopeFingerprint = exactSessionFingerprint(input.scope, input.sessionId);
    const requestHash = hash("working-set-ingest-v1", {
      scopeFingerprint,
      sessionId: input.sessionId,
      taskBoundaryId: input.taskBoundaryId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      sourceMessageIds: input.sourceMessageIds,
      payloadRef: input.payloadRef,
      outcome: input.outcome,
      summary: input.summary,
      replaceability: input.replaceability,
      evidenceRefs: unique(input.evidenceRefs),
      riskFlags: unique(input.riskFlags),
    });
    const existing = await this.repository.getIdempotencyReceipt(
      scopeFingerprint,
      input.sessionId,
      input.idempotencyKey,
    );
    if (existing !== undefined) {
      if (existing.requestHash !== requestHash) {
        throw new SessionWorkingSetError("WORKING_SET_IDEMPOTENCY_CONFLICT");
      }
      const entry = await this.repository.getEntry(scopeFingerprint, input.sessionId, existing.entryId);
      if (entry === undefined) throw new SessionWorkingSetError("WORKING_SET_NOT_FOUND");
      return { entry, replayed: true };
    }
    if (!await this.#payloadVerifier.verify(input.payloadRef)) {
      throw new SessionWorkingSetError("WORKING_SET_PAYLOAD_UNVERIFIED");
    }
    const occurredAt = new Date(this.#now()).toISOString();
    const entryId = `ws_${hash("working-set-entry-v1", [
      scopeFingerprint,
      input.sessionId,
      input.idempotencyKey,
    ]).slice(0, 48)}`;
    const shell: WorkingSetEntry = Object.freeze({
      id: entryId,
      scopeFingerprint,
      sessionId: input.sessionId,
      ...(input.taskBoundaryId === undefined ? {} : { taskBoundaryId: input.taskBoundaryId }),
      kind: "tool_pair",
      status: "active",
      sourceMessageIds: Object.freeze([...input.sourceMessageIds]),
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      payloadRef: Object.freeze({ ...input.payloadRef }),
      replaceability: input.replaceability,
      evidenceRefs: Object.freeze(unique(input.evidenceRefs)),
      riskFlags: Object.freeze(unique(input.riskFlags)),
      createdAt: occurredAt,
      updatedAt: occurredAt,
    });
    await this.repository.putToolPairShell(shell, {
      scopeFingerprint,
      sessionId: input.sessionId,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      entryId,
    }, input.scope);
    if (input.summary === undefined) return { entry: shell, replayed: false };
    const summary = validateSummary(input, input.summary);
    const entry: WorkingSetEntry = Object.freeze({
      ...shell,
      status: "summarized",
      summary,
      updatedAt: new Date(this.#now()).toISOString(),
    });
    await this.repository.updateEntry(entry);
    return { entry, replayed: false };
  }

  async recordTaskBoundary(input: RecordTaskBoundaryInput): Promise<TaskBoundaryAck> {
    const scopeFingerprint = exactSessionFingerprint(input.scope, input.sessionId);
    const stringLists = [
      input.completedSteps,
      input.currentSteps,
      input.nextSteps,
      input.decisions,
      input.openQuestions,
      input.entryRefs,
      input.evidenceRefs,
    ];
    if (!SAFE_ID.test(input.taskBoundaryId) || !SAFE_ID.test(input.policyVersion) ||
        !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 ||
        typeof input.goal !== "string" || input.goal.trim().length === 0 ||
        input.goal.length > 4_096 ||
        !(["doing", "blocked", "completed", "abandoned"] as unknown[]).includes(input.status) ||
        stringLists.some((values) => !Array.isArray(values) || values.length > 256 ||
          values.some((value) => typeof value !== "string" || value.length === 0 ||
            value.length > 2_048))) {
      throw new SessionWorkingSetError("WORKING_SET_INVALID");
    }
    const version = input.expectedVersion + 1;
    const updatedAt = new Date(this.#now()).toISOString();
    const outline: TaskOutline = Object.freeze({
      id: `wo_${hash("working-set-outline-v1", [
        scopeFingerprint,
        input.sessionId,
        input.taskBoundaryId,
        version,
        input.policyVersion,
      ]).slice(0, 48)}`,
      scopeFingerprint,
      sessionId: input.sessionId,
      taskBoundaryId: input.taskBoundaryId,
      goal: input.goal.trim(),
      status: input.status,
      completedSteps: Object.freeze([...input.completedSteps]),
      currentSteps: Object.freeze([...input.currentSteps]),
      nextSteps: Object.freeze([...input.nextSteps]),
      decisions: Object.freeze([...input.decisions]),
      openQuestions: Object.freeze([...input.openQuestions]),
      entryRefs: Object.freeze(unique(input.entryRefs)),
      evidenceRefs: Object.freeze(unique(input.evidenceRefs)),
      version,
      policyVersion: input.policyVersion,
      updatedAt,
    });
    try {
      await this.repository.appendTaskOutline(outline, input.expectedVersion);
    } catch (error) {
      if (error instanceof Error &&
          (error.message === "WORKING_SET_VERSION_STALE" || error.message === "WORKING_SET_CONFLICT")) {
        throw new SessionWorkingSetError("WORKING_SET_VERSION_STALE");
      }
      throw error;
    }
    return { outline };
  }

  async readPayload(input: ReadSessionPayloadInput): Promise<SessionPayloadReadResult> {
    const scopeFingerprint = exactSessionFingerprint(input.scope, input.sessionId);
    if (!SAFE_ID.test(input.entryId) || !Number.isSafeInteger(input.maxBytes) ||
        input.maxBytes < 1 || input.maxBytes > this.#maxPayloadReadBytes) {
      throw new SessionWorkingSetError("WORKING_SET_INVALID");
    }
    if (this.#payloadReader === undefined) {
      throw new SessionWorkingSetError("WORKING_SET_PAYLOAD_READ_UNAVAILABLE");
    }
    const entry = await this.repository.getEntry(scopeFingerprint, input.sessionId, input.entryId);
    if (entry?.payloadRef === undefined || entry.status === "revoked" || entry.status === "expired") {
      throw new SessionWorkingSetError("WORKING_SET_NOT_FOUND");
    }
    let raw: Uint8Array;
    try {
      raw = await this.#payloadReader.read(entry.payloadRef, input.maxBytes);
    } catch {
      throw new SessionWorkingSetError("WORKING_SET_PAYLOAD_READ_UNAVAILABLE");
    }
    if (!(raw instanceof Uint8Array) || raw.byteLength > input.maxBytes ||
        raw.byteLength > entry.payloadRef.byteLength ||
        (input.maxBytes >= entry.payloadRef.byteLength && raw.byteLength !== entry.payloadRef.byteLength)) {
      throw new SessionWorkingSetError("WORKING_SET_PAYLOAD_READ_UNAVAILABLE");
    }
    const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    const truncated = bytes.byteLength < entry.payloadRef.byteLength;
    const contentHashVerified = !truncated &&
      createHash("sha256").update(bytes).digest("hex") === entry.payloadRef.contentHash;
    if (!truncated && !contentHashVerified) {
      throw new SessionWorkingSetError("WORKING_SET_PAYLOAD_HASH_MISMATCH");
    }
    return Object.freeze({
      entryId: entry.id,
      payloadRef: Object.freeze({ ...entry.payloadRef }),
      contentBase64: bytes.toString("base64"),
      bytesRead: bytes.byteLength,
      truncated,
      contentHashVerified,
      warnings: Object.freeze(truncated ? ["payload_truncated_hash_not_verified"] : []),
    });
  }

  async assemble(input: SessionAssembleInput): Promise<SessionAssembleResult> {
    const scopeFingerprint = exactSessionFingerprint(input.scope, input.sessionId);
    if (!Number.isSafeInteger(input.contextWindow) || input.contextWindow < 1 ||
        input.messages.some((message) => !SAFE_ID.test(message.id) || typeof message.content !== "string")) {
      throw new SessionWorkingSetError("WORKING_SET_INVALID");
    }
    const warnings: string[] = [];
    const count = this.#tokenCounter?.count.bind(this.#tokenCounter) ?? ((text: string) => {
      return Math.ceil(Buffer.byteLength(text, "utf8") / 3);
    });
    if (this.#tokenCounter === undefined) warnings.push("token_counter_degraded");
    const tokenCount = (messages: readonly SessionContextMessage[]) =>
      messages.reduce((sum, message) => sum + Math.max(0, Math.ceil(count(message.content))), 0);
    const outline = input.taskBoundaryId === undefined
      ? undefined
      : await this.repository.getTaskOutline(scopeFingerprint, input.sessionId, input.taskBoundaryId);
    const candidateOutlineMessage = outline === undefined ? undefined : taskOutlineMessage(outline);
    const outlineTokenBudget = Math.floor(input.contextWindow * this.#policy.outlineMaxRatio);
    const outlineMessage = candidateOutlineMessage !== undefined &&
        tokenCount([candidateOutlineMessage]) <= outlineTokenBudget
      ? candidateOutlineMessage
      : undefined;
    if (candidateOutlineMessage !== undefined && outlineMessage === undefined) {
      warnings.push("outline_budget_exceeded");
    }
    const effectiveInput = outlineMessage === undefined
      ? [...input.messages]
      : injectOutline(input.messages, outlineMessage);
    const tokensBefore = tokenCount(effectiveInput);
    const level = levelFor(tokensBefore / input.contextWindow, this.#policy);
    const targetTokens = targetFor(level, input.contextWindow, this.#policy);
    const entries = await this.repository.listEntries(scopeFingerprint, input.sessionId);
    const entryByMessageId = new Map<string, WorkingSetEntry>();
    for (const entry of entries) {
      for (const messageId of entry.sourceMessageIds) entryByMessageId.set(messageId, entry);
    }
    const protectedIds = new Set(input.protectedMessageIds);
    if (outlineMessage !== undefined) protectedIds.add(outlineMessage.id);
    const lastUser = [...input.messages].reverse().find((message) => message.role === "user");
    if (lastUser !== undefined) protectedIds.add(lastUser.id);
    for (const message of input.messages) {
      if ((message.role === "system" || message.role === "developer") ||
          (message.toolCallId !== undefined && entryByMessageId.get(message.id) === undefined)) {
        protectedIds.add(message.id);
      }
    }

    const candidates = entries
      .filter((entry) => entry.kind === "tool_pair" && entry.summary !== undefined &&
        (entry.status === "summarized" || entry.status === "active") &&
        (input.taskBoundaryId === undefined || entry.taskBoundaryId !== input.taskBoundaryId ||
          level === "emergency") &&
        entry.sourceMessageIds.every((id) => input.messages.some((message) => message.id === id)) &&
        entry.sourceMessageIds.every((id) => !protectedIds.has(id)))
      .sort((left, right) => right.replaceability - left.replaceability ||
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));

    const replacements = new Map<string, WorkingSetEntry>();
    let working = [...effectiveInput];
    if (level !== "normal") {
      for (const entry of candidates) {
        if (tokenCount(working) <= targetTokens) break;
        const sourceIds = new Set(entry.sourceMessageIds);
        const firstIndex = working.findIndex((message) => sourceIds.has(message.id));
        if (firstIndex < 0) continue;
        working = working.filter((message) => !sourceIds.has(message.id));
        working.splice(firstIndex, 0, summaryMessage(entry));
        replacements.set(entry.id, entry);
      }
    }
    const tokensAfter = tokenCount(working);
    if (level === "emergency" && tokensAfter > targetTokens) warnings.push("rewrite_target_unreachable");
    const replacedEntryIds = [...replacements.keys()];
    const replacedSourceIds = new Set(
      [...replacements.values()].flatMap((entry) => entry.sourceMessageIds),
    );
    const removedMessageIds = input.messages
      .filter((message) => replacedSourceIds.has(message.id))
      .map((message) => message.id);
    const evidenceRefs = unique([
      ...(outlineMessage === undefined ? [] : outline?.evidenceRefs ?? []),
      ...[...replacements.values()].flatMap((entry) => entry.evidenceRefs),
    ]);
    const inputHash = hash("working-set-rewrite-input-v1", effectiveInput.map((message) => [
      message.id,
      message.role,
      message.toolCallId ?? null,
      hash("working-set-message-content-v1", message.content),
    ]));
    const outputHash = hash("working-set-rewrite-output-v1", working.map((message) => [
      message.id,
      message.role,
      message.toolCallId ?? null,
      hash("working-set-message-content-v1", message.content),
    ]));
    const createdAt = new Date(this.#now()).toISOString();
    const receipt: ContextRewriteReceipt = Object.freeze({
      id: `wr_${hash("working-set-rewrite-receipt-v1", [
        scopeFingerprint,
        input.sessionId,
        inputHash,
        this.#policy.version,
      ]).slice(0, 48)}`,
      scopeFingerprint,
      sessionId: input.sessionId,
      ...(input.taskBoundaryId === undefined ? {} : { taskBoundaryId: input.taskBoundaryId }),
      level,
      contextWindow: input.contextWindow,
      tokensBefore,
      tokensAfter,
      targetTokens,
      protectedMessageIds: Object.freeze(unique([...protectedIds])),
      replacedEntryIds: Object.freeze(replacedEntryIds),
      removedMessageIds: Object.freeze(removedMessageIds),
      ...(outlineMessage === undefined || outline === undefined
        ? {}
        : { injectedOutlineVersion: outline.version }),
      evidenceRefs: Object.freeze(evidenceRefs),
      policyVersion: this.#policy.version,
      inputHash,
      outputHash,
      warnings: Object.freeze(unique(warnings)),
      createdAt,
    });
    await this.repository.appendRewriteReceipt(receipt);
    for (const entry of replacements.values()) {
      await this.repository.updateEntry({ ...entry, status: "replaced", updatedAt: createdAt });
    }
    return { messages: working, ...(outline === undefined ? {} : { outline }), receipt };
  }

  async explainRewrite(
    receiptId: string,
    scope: MemoryScope,
    sessionId: string,
  ): Promise<ContextRewriteReceipt> {
    const fingerprint = exactSessionFingerprint(scope, sessionId);
    const receipt = await this.repository.getRewriteReceipt(fingerprint, receiptId);
    if (receipt === undefined || receipt.sessionId !== sessionId) {
      throw new SessionWorkingSetError("WORKING_SET_NOT_FOUND");
    }
    return receipt;
  }

  async closeSession(scope: MemoryScope, sessionId: string): Promise<WorkingSetCleanupReceipt> {
    const fingerprint = exactSessionFingerprint(scope, sessionId);
    const closedAt = new Date(this.#now()).toISOString();
    const warnings: string[] = [];
    const entries = await this.repository.listEntries(fingerprint, sessionId);
    const outlines = await this.repository.listTaskOutlines(fingerprint, sessionId);
    const retained = new Set(outlines
      .filter((outline) => outline.status === "doing" || outline.status === "blocked")
      .flatMap((outline) => outline.entryRefs));
    const deleted = new Set<string>();
    const failed = new Set<string>();
    if (this.#retentionDays === undefined) warnings.push("retention_policy_unconfigured");

    for (const entry of entries) {
      if (entry.status === "expired" || entry.status === "revoked") {
        retained.add(entry.id);
        continue;
      }
      if (entry.evidenceRefs.length > 0) {
        if (this.#evidenceRetentionGuard === undefined) {
          retained.add(entry.id);
          warnings.push("evidence_retention_guard_unavailable");
          continue;
        }
        try {
          if (!await this.#evidenceRetentionGuard.canRelease({ scope, sessionId, entry })) {
            retained.add(entry.id);
            continue;
          }
        } catch {
          retained.add(entry.id);
          warnings.push("evidence_retention_check_failed");
          continue;
        }
      }
      if (retained.has(entry.id) || entry.payloadRef === undefined || this.#retentionDays !== 0) {
        continue;
      }
      if (this.#payloadRetention === undefined) {
        failed.add(entry.id);
        warnings.push("payload_retention_unavailable");
        continue;
      }
      try {
        await this.#payloadRetention.delete(entry.payloadRef);
        deleted.add(entry.id);
      } catch {
        failed.add(entry.id);
        warnings.push("payload_delete_failed");
      }
    }
    return this.repository.closeSession({
      scopeFingerprint: fingerprint,
      sessionId,
      retainedEntryIds: unique([...retained]),
      deletedPayloadEntryIds: unique([...deleted]),
      failedPayloadEntryIds: unique([...failed]),
      reason: "session_closed",
      ...(this.#retentionDays === undefined ? {} : { retentionDays: this.#retentionDays }),
      warnings: unique(warnings),
      closedAt,
    });
  }

  async runRetentionCleanup(input: { readonly limit?: number } = {}): Promise<WorkingSetRetentionBatchResult> {
    const limit = input.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new SessionWorkingSetError("WORKING_SET_INVALID");
    }
    const now = new Date(this.#now()).toISOString();
    const due = await this.repository.listRetentionDue(now, limit);
    const receipts: WorkingSetCleanupReceipt[] = [];
    let failedSessions = 0;
    for (const session of due) {
      try {
        const entries = await this.repository.listEntries(session.scopeFingerprint, session.sessionId);
        const outlines = await this.repository.listTaskOutlines(
          session.scopeFingerprint,
          session.sessionId,
        );
        const retained = new Set(outlines
          .filter((outline) => outline.status === "doing" || outline.status === "blocked")
          .flatMap((outline) => outline.entryRefs));
        const deleted = new Set<string>();
        const failed = new Set<string>();
        const warnings: string[] = [];
        for (const entry of entries) {
          if (retained.has(entry.id)) continue;
          if (entry.evidenceRefs.length > 0) {
            if (this.#evidenceRetentionGuard === undefined) {
              retained.add(entry.id);
              warnings.push("evidence_retention_guard_unavailable");
              continue;
            }
            try {
              if (!await this.#evidenceRetentionGuard.canRelease({
                scope: session.scope,
                sessionId: session.sessionId,
                entry,
              })) {
                retained.add(entry.id);
                continue;
              }
            } catch {
              retained.add(entry.id);
              warnings.push("evidence_retention_check_failed");
              continue;
            }
          }
          if (entry.payloadRef === undefined) continue;
          if (this.#payloadRetention === undefined) {
            failed.add(entry.id);
            warnings.push("payload_retention_unavailable");
            continue;
          }
          try {
            await this.#payloadRetention.delete(entry.payloadRef);
            deleted.add(entry.id);
          } catch {
            failed.add(entry.id);
            warnings.push("payload_delete_failed");
          }
        }
        receipts.push(await this.repository.closeSession({
          scopeFingerprint: session.scopeFingerprint,
          sessionId: session.sessionId,
          retainedEntryIds: unique([...retained]),
          deletedPayloadEntryIds: unique([...deleted]),
          failedPayloadEntryIds: unique([...failed]),
          reason: "retention_expired",
          retentionDays: session.retentionDays,
          warnings: unique(warnings),
          closedAt: now,
        }));
      } catch {
        failedSessions += 1;
      }
    }
    return Object.freeze({
      sessions: due.length,
      receipts: Object.freeze(receipts),
      failedSessions,
    });
  }
}

export type { TaskOutline };
