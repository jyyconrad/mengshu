import { createHash, randomUUID } from "node:crypto";

import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { MemoryRecord, MemoryScope } from "../domain/types.js";
import type { TemporalMemoryRepository } from "./repository.js";
import {
  MemoryEvolutionError,
  type MemoryHistoryResult,
  type MemoryPurgeReceipt,
  type MemoryTemporalReadResult,
  type MemoryTemporalVersion,
  type MemoryVersionTransitionReceipt,
  type MemoryVersionTransitionResult,
  type MemoryVersionTransitionType,
} from "./types.js";
import { resolveTemporalTime } from "./time-resolution.js";

export { MemoryEvolutionError } from "./types.js";

interface MemoryEvolutionServiceOptions {
  readonly now?: () => number;
  readonly idFactory?: () => string;
}

interface BaseVersionInput {
  readonly scope: MemoryScope;
  readonly lineageId: string;
  readonly record: MemoryRecord;
  readonly validFrom: number;
  readonly reason?: string;
  readonly idempotencyKey: string;
}

export interface BootstrapMemoryVersionInput extends BaseVersionInput {}

export interface AppendMemoryVersionInput extends BaseVersionInput {
  readonly expectedHeadRevision: number;
}

export interface RestoreMemoryVersionInput extends AppendMemoryVersionInput {
  readonly sourceVersionId: string;
}

export interface ExpireMemoryVersionInput {
  readonly scope: MemoryScope;
  readonly lineageId: string;
  readonly expectedHeadRevision: number;
  readonly validTo: number;
  readonly reason?: string;
  readonly idempotencyKey: string;
}

export interface RevokeMemoryVersionInput {
  readonly scope: MemoryScope;
  readonly lineageId: string;
  readonly expectedHeadRevision: number;
  readonly reason: string;
  readonly idempotencyKey: string;
}

export interface PurgeMemoryLineageInput {
  readonly scope: MemoryScope;
  readonly lineageId: string;
  readonly confirmation: string;
  readonly idempotencyKey: string;
}

const SAFE_ID = /^[^\s\p{Cc}]{1,256}$/u;
const CONTENT_HASH = /^(?:[a-f0-9]{32}|[a-f0-9]{64})$/;
const SAFE_REASON = /^[^\p{Cc}]{1,1024}$/u;

function exactScope(scope: MemoryScope): MemoryScope {
  return scope.visibility === undefined ? { ...scope, visibility: "private" } : scope;
}

function scopeFingerprint(scope: MemoryScope): string {
  return authorityScopeFingerprint(exactScope(scope));
}

function finiteTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function hashRequest(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function sameScope(left: MemoryScope, right: MemoryScope): boolean {
  return scopeFingerprint(left) === scopeFingerprint(right);
}

function validateBase(input: BaseVersionInput): void {
  if (!SAFE_ID.test(input.lineageId) || !SAFE_ID.test(input.idempotencyKey) ||
      !finiteTimestamp(input.validFrom) || !SAFE_ID.test(input.record.id) ||
      input.record.text.trim().length === 0 || !CONTENT_HASH.test(input.record.contentHash) ||
      input.record.lifecycleStatus !== "active" || input.record.dataType !== "memory" ||
      input.record.sourceNodeIds === undefined || input.record.sourceNodeIds.length === 0 ||
      !sameScope(input.scope, input.record.scope) ||
      (input.reason !== undefined &&
        (input.reason !== input.reason.trim() || !SAFE_REASON.test(input.reason)))) {
    throw new MemoryEvolutionError("MEMORY_EVOLUTION_INVALID");
  }
}

function readResult(
  value: MemoryTemporalVersion | undefined,
  historical: boolean,
): MemoryTemporalReadResult | undefined {
  return value ? { ...value, historical } : undefined;
}

export class MemoryEvolutionService {
  readonly #now: () => number;
  readonly #idFactory: () => string;

  constructor(
    private readonly repository: TemporalMemoryRepository,
    options: MemoryEvolutionServiceOptions = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  async #existingTransition(
    scope: MemoryScope,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<MemoryVersionTransitionResult | undefined> {
    const receipt = await this.repository.getTransitionReceipt(scope, idempotencyKey);
    if (!receipt) return undefined;
    if (receipt.requestHash !== requestHash) {
      throw new MemoryEvolutionError("MEMORY_IDEMPOTENCY_CONFLICT");
    }
    const versionId = receipt.versionId ?? receipt.previousVersionId;
    if (!versionId) throw new MemoryEvolutionError("MEMORY_VERSION_CONFLICT");
    const version = await this.repository.getVersion(scope, receipt.lineageId, versionId);
    if (!version) throw new MemoryEvolutionError("MEMORY_VERSION_CONFLICT");
    return { version, receipt, replayed: true };
  }

  async #append(
    input: AppendMemoryVersionInput,
    transitionType: Exclude<MemoryVersionTransitionType, "created" | "expired" | "revoked">,
    restoredFromVersionId?: string,
    allowMissingCurrent = false,
  ): Promise<MemoryVersionTransitionResult> {
    validateBase(input);
    if (!Number.isSafeInteger(input.expectedHeadRevision) || input.expectedHeadRevision < 1) {
      throw new MemoryEvolutionError("MEMORY_EVOLUTION_INVALID");
    }
    const head = await this.repository.getHead(input.scope, input.lineageId);
    if (!head) throw new MemoryEvolutionError("MEMORY_LINEAGE_NOT_FOUND");
    const requestHash = hashRequest([
      "mengshu.memory-transition/v1",
      scopeFingerprint(input.scope),
      input.lineageId,
      transitionType,
      input.expectedHeadRevision,
      input.record.id,
      input.record.contentHash,
      input.validFrom,
      restoredFromVersionId ?? null,
      input.reason ?? null,
    ]);
    const existing = await this.#existingTransition(
      input.scope,
      input.idempotencyKey,
      requestHash,
    );
    if (existing) return existing;
    const compareRevision = head.latestRevision;
    if (compareRevision !== input.expectedHeadRevision ||
        (!allowMissingCurrent && head.currentVersionId === undefined)) {
      throw new MemoryEvolutionError("MEMORY_VERSION_STALE");
    }
    const recordedAt = this.#now();
    const activationState = input.validFrom > recordedAt ? "staged" as const : "active" as const;
    if (activationState === "staged" && transitionType === "corrected") {
      throw new MemoryEvolutionError("MEMORY_EVOLUTION_INVALID");
    }
    if (head.currentVersionRevision !== undefined &&
        head.currentVersionRevision !== head.latestRevision) {
      throw new MemoryEvolutionError("MEMORY_VERSION_STALE");
    }
    const version: MemoryTemporalVersion = {
      lineageId: input.lineageId,
      revision: input.expectedHeadRevision + 1,
      record: structuredClone({ ...input.record, scope: exactScope(input.record.scope) }),
      ...(head.currentVersionId === undefined
        ? {}
        : { previousVersionId: head.currentVersionId }),
      ...(restoredFromVersionId === undefined ? {} : { restoredFromVersionId }),
      validFrom: input.validFrom,
      recordedAt,
      transitionType,
      ...(input.reason === undefined ? {} : { transitionReason: input.reason }),
      invalidated: false,
      activationState,
    };
    const receipt: MemoryVersionTransitionReceipt = {
      id: this.#idFactory(),
      idempotencyKey: input.idempotencyKey,
      requestHash,
      scopeFingerprint: scopeFingerprint(input.scope),
      lineageId: input.lineageId,
      transitionType,
      ...(head.currentVersionId === undefined
        ? {}
        : { previousVersionId: head.currentVersionId }),
      versionId: input.record.id,
      revision: version.revision,
      occurredAt: recordedAt,
    };
    return this.repository.appendVersion({
      scope: exactScope(input.scope),
      expectedHeadRevision: input.expectedHeadRevision,
      version,
      receipt,
    });
  }

  async bootstrap(input: BootstrapMemoryVersionInput): Promise<MemoryVersionTransitionResult> {
    validateBase(input);
    const requestHash = hashRequest([
      "mengshu.memory-transition/v1",
      scopeFingerprint(input.scope),
      input.lineageId,
      "created",
      input.record.id,
      input.record.contentHash,
      input.validFrom,
      input.reason ?? null,
    ]);
    const existing = await this.#existingTransition(
      input.scope,
      input.idempotencyKey,
      requestHash,
    );
    if (existing) return existing;
    if (await this.repository.getHead(input.scope, input.lineageId)) {
      throw new MemoryEvolutionError("MEMORY_VERSION_STALE");
    }
    const recordedAt = this.#now();
    const activationState = input.validFrom > recordedAt ? "staged" as const : "active" as const;
    const version: MemoryTemporalVersion = {
      lineageId: input.lineageId,
      revision: 1,
      record: structuredClone({ ...input.record, scope: exactScope(input.record.scope) }),
      validFrom: input.validFrom,
      recordedAt,
      transitionType: "created",
      ...(input.reason === undefined ? {} : { transitionReason: input.reason }),
      invalidated: false,
      activationState,
    };
    const receipt: MemoryVersionTransitionReceipt = {
      id: this.#idFactory(),
      idempotencyKey: input.idempotencyKey,
      requestHash,
      scopeFingerprint: scopeFingerprint(input.scope),
      lineageId: input.lineageId,
      transitionType: "created",
      versionId: input.record.id,
      revision: 1,
      occurredAt: recordedAt,
    };
    return this.repository.appendVersion({
      scope: exactScope(input.scope),
      expectedHeadRevision: 0,
      version,
      receipt,
    });
  }

  evolve(input: AppendMemoryVersionInput): Promise<MemoryVersionTransitionResult> {
    return this.#append(input, "evolved");
  }

  correct(input: AppendMemoryVersionInput): Promise<MemoryVersionTransitionResult> {
    return this.#append(input, "corrected");
  }

  async restore(input: RestoreMemoryVersionInput): Promise<MemoryVersionTransitionResult> {
    if (!SAFE_ID.test(input.sourceVersionId)) {
      throw new MemoryEvolutionError("MEMORY_EVOLUTION_INVALID");
    }
    const source = await this.repository.getVersion(
      input.scope,
      input.lineageId,
      input.sourceVersionId,
    );
    if (!source) throw new MemoryEvolutionError("MEMORY_VERSION_NOT_FOUND");
    if (source.record.contentHash !== input.record.contentHash ||
        source.record.text !== input.record.text) {
      throw new MemoryEvolutionError("MEMORY_VERSION_CONFLICT");
    }
    return this.#append(input, "restored", input.sourceVersionId, true);
  }

  async expire(input: ExpireMemoryVersionInput): Promise<MemoryVersionTransitionResult> {
    if (!SAFE_ID.test(input.lineageId) || !SAFE_ID.test(input.idempotencyKey) ||
        !Number.isSafeInteger(input.expectedHeadRevision) || input.expectedHeadRevision < 1 ||
        !finiteTimestamp(input.validTo) ||
        (input.reason !== undefined &&
          (input.reason !== input.reason.trim() || !SAFE_REASON.test(input.reason)))) {
      throw new MemoryEvolutionError("MEMORY_EVOLUTION_INVALID");
    }
    const requestHash = hashRequest([
      "mengshu.memory-transition/v1",
      scopeFingerprint(input.scope),
      input.lineageId,
      "expired",
      input.expectedHeadRevision,
      input.validTo,
      input.reason ?? null,
    ]);
    const existing = await this.#existingTransition(
      input.scope,
      input.idempotencyKey,
      requestHash,
    );
    if (existing) return existing;
    const head = await this.repository.getHead(input.scope, input.lineageId);
    if (!head) throw new MemoryEvolutionError("MEMORY_LINEAGE_NOT_FOUND");
    if (head.latestRevision !== input.expectedHeadRevision ||
        head.currentVersionRevision !== input.expectedHeadRevision ||
        head.currentVersionId === undefined) {
      throw new MemoryEvolutionError("MEMORY_VERSION_STALE");
    }
    const occurredAt = this.#now();
    const receipt: MemoryVersionTransitionReceipt = {
      id: this.#idFactory(),
      idempotencyKey: input.idempotencyKey,
      requestHash,
      scopeFingerprint: scopeFingerprint(input.scope),
      lineageId: input.lineageId,
      transitionType: "expired",
      previousVersionId: head.currentVersionId,
      revision: input.expectedHeadRevision,
      occurredAt,
    };
    return this.repository.closeHead({
      scope: exactScope(input.scope),
      lineageId: input.lineageId,
      expectedHeadRevision: input.expectedHeadRevision,
      validTo: input.validTo,
      reason: input.reason,
      transitionType: "expired",
      receipt,
    });
  }

  async revoke(input: RevokeMemoryVersionInput): Promise<MemoryVersionTransitionResult> {
    if (!SAFE_ID.test(input.lineageId) || !SAFE_ID.test(input.idempotencyKey) ||
        !Number.isSafeInteger(input.expectedHeadRevision) || input.expectedHeadRevision < 1 ||
        input.reason !== input.reason.trim() || !SAFE_REASON.test(input.reason)) {
      throw new MemoryEvolutionError("MEMORY_EVOLUTION_INVALID");
    }
    const occurredAt = this.#now();
    const requestHash = hashRequest([
      "mengshu.memory-transition/v1",
      scopeFingerprint(input.scope),
      input.lineageId,
      "revoked",
      input.expectedHeadRevision,
      input.reason,
    ]);
    const existing = await this.#existingTransition(
      input.scope,
      input.idempotencyKey,
      requestHash,
    );
    if (existing) return existing;
    const head = await this.repository.getHead(input.scope, input.lineageId);
    if (!head) throw new MemoryEvolutionError("MEMORY_LINEAGE_NOT_FOUND");
    if (head.latestRevision !== input.expectedHeadRevision ||
        head.currentVersionRevision !== input.expectedHeadRevision ||
        head.currentVersionId === undefined) {
      throw new MemoryEvolutionError("MEMORY_VERSION_STALE");
    }
    const receipt: MemoryVersionTransitionReceipt = {
      id: this.#idFactory(),
      idempotencyKey: input.idempotencyKey,
      requestHash,
      scopeFingerprint: scopeFingerprint(input.scope),
      lineageId: input.lineageId,
      transitionType: "revoked",
      previousVersionId: head.currentVersionId,
      revision: input.expectedHeadRevision,
      occurredAt,
    };
    return this.repository.closeHead({
      scope: exactScope(input.scope),
      lineageId: input.lineageId,
      expectedHeadRevision: input.expectedHeadRevision,
      validTo: occurredAt,
      reason: input.reason,
      transitionType: "revoked",
      receipt,
    });
  }

  async current(input: { readonly scope: MemoryScope; readonly lineageId: string; readonly at?: number }) {
    if (!SAFE_ID.test(input.lineageId)) {
      throw new MemoryEvolutionError("MEMORY_EVOLUTION_INVALID");
    }
    return readResult(
      await this.repository.current(input.scope, input.lineageId, input.at ?? this.#now()),
      false,
    );
  }

  async recallAsOf(input: {
    readonly scope: MemoryScope;
    readonly lineageId: string;
    readonly asOf: number;
    readonly knownAt?: number;
  }) {
    if (!SAFE_ID.test(input.lineageId) || !finiteTimestamp(input.asOf) ||
        (input.knownAt !== undefined && !finiteTimestamp(input.knownAt))) {
      throw new MemoryEvolutionError("MEMORY_EVOLUTION_INVALID");
    }
    return readResult(
      await this.repository.asOf(input.scope, input.lineageId, input.asOf, input.knownAt),
      true,
    );
  }

  async recallAsOfResolved(input: {
    readonly scope: MemoryScope;
    readonly lineageId: string;
    readonly asOf: string;
    readonly knownAt?: string | number;
    readonly timezoneOffsetMinutes?: number;
    readonly anchorAt?: number;
  }) {
    const referenceAt = this.#now();
    const asOfResolution = resolveTemporalTime({
      expression: input.asOf,
      referenceAt,
      ...(input.timezoneOffsetMinutes === undefined
        ? {}
        : { timezoneOffsetMinutes: input.timezoneOffsetMinutes }),
      ...(input.anchorAt === undefined ? {} : { anchorAt: input.anchorAt }),
    });
    const knownAtResolution = input.knownAt === undefined
      ? undefined
      : resolveTemporalTime({
          expression: input.knownAt,
          referenceAt,
          ...(input.timezoneOffsetMinutes === undefined
            ? {}
            : { timezoneOffsetMinutes: input.timezoneOffsetMinutes }),
          ...(input.anchorAt === undefined ? {} : { anchorAt: input.anchorAt }),
        });
    const memory = await this.recallAsOf({
      scope: input.scope,
      lineageId: input.lineageId,
      asOf: asOfResolution.selectedAt,
      ...(knownAtResolution === undefined ? {} : { knownAt: knownAtResolution.selectedAt }),
    });
    return Object.freeze({
      memory,
      asOfResolution,
      ...(knownAtResolution === undefined ? {} : { knownAtResolution }),
    });
  }

  async history(input: {
    readonly scope: MemoryScope;
    readonly lineageId: string;
  }): Promise<MemoryHistoryResult> {
    if (!SAFE_ID.test(input.lineageId)) {
      throw new MemoryEvolutionError("MEMORY_EVOLUTION_INVALID");
    }
    const result = await this.repository.history(input.scope, input.lineageId);
    if (!result) throw new MemoryEvolutionError("MEMORY_LINEAGE_NOT_FOUND");
    return result;
  }

  async activateDue(input: { readonly limit?: number } = {}): Promise<number> {
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new MemoryEvolutionError("MEMORY_EVOLUTION_INVALID");
    }
    return this.repository.activateDue(this.#now(), limit);
  }

  async materializeExpired(input: { readonly limit?: number } = {}): Promise<number> {
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new MemoryEvolutionError("MEMORY_EVOLUTION_INVALID");
    }
    return this.repository.materializeExpired(this.#now(), limit);
  }

  async retryPendingPurges(input: { readonly limit?: number } = {}) {
    const limit = input.limit ?? 10;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new MemoryEvolutionError("MEMORY_EVOLUTION_INVALID");
    }
    return this.repository.retryPendingPurges(this.#now(), limit);
  }

  async purge(input: PurgeMemoryLineageInput): Promise<MemoryPurgeReceipt> {
    if (!SAFE_ID.test(input.lineageId) || !SAFE_ID.test(input.idempotencyKey)) {
      throw new MemoryEvolutionError("MEMORY_EVOLUTION_INVALID");
    }
    if (input.confirmation !== "PURGE") {
      throw new MemoryEvolutionError("MEMORY_PURGE_CONFIRMATION_REQUIRED");
    }
    const requestHash = hashRequest([
      "mengshu.memory-purge/v1",
      scopeFingerprint(input.scope),
      input.lineageId,
      input.confirmation,
    ]);
    const existing = await this.repository.getPurgeReceipt(input.scope, input.idempotencyKey);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new MemoryEvolutionError("MEMORY_IDEMPOTENCY_CONFLICT");
      }
      return existing;
    }
    const occurredAt = this.#now();
    return this.repository.purge({
      scope: exactScope(input.scope),
      lineageId: input.lineageId,
      receipt: {
        operationId: this.#idFactory(),
        idempotencyKey: input.idempotencyKey,
        requestHash,
        scopeFingerprint: scopeFingerprint(input.scope),
        lineageHash: createHash("sha256").update(input.lineageId).digest("hex"),
        purgedVersions: 0,
        derivedArtifactsPurged: 0,
        occurredAt,
      },
    });
  }
}
