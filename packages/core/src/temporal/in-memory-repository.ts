import { createHash } from "node:crypto";

import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { MemoryRecord, MemoryScope } from "../domain/types.js";
import type {
  AppendTemporalMemoryVersionInput,
  CloseTemporalMemoryHeadInput,
  PurgeTemporalMemoryLineageInput,
  TemporalMemoryRepository,
} from "./repository.js";
import {
  MemoryEvolutionError,
  type MemoryHistoryResult,
  type MemoryLineageHead,
  type MemoryPurgeReceipt,
  type MemoryTemporalVersion,
  type MemoryVersionTransitionReceipt,
  type MemoryVersionTransitionResult,
} from "./types.js";

export interface InMemoryTemporalMemoryRepositoryOptions {
  readonly purgeDerived?: (
    versionIds: readonly string[],
    lineageId: string,
    scopeFingerprint: string,
  ) => Promise<number>;
}

interface StoredLineage {
  head: MemoryLineageHead;
  versions: MemoryTemporalVersion[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function normalizedScope(scope: MemoryScope): MemoryScope {
  return scope.visibility === undefined ? { ...scope, visibility: "private" } : scope;
}

function scopeFingerprint(scope: MemoryScope): string {
  return authorityScopeFingerprint(normalizedScope(scope));
}

function lineageKey(scope: MemoryScope, lineageId: string): string {
  return `${scopeFingerprint(scope)}:${lineageId}`;
}

function receiptKey(scope: MemoryScope, idempotencyKey: string): string {
  return `${scopeFingerprint(scope)}:${idempotencyKey}`;
}

function withLifecycle(
  record: MemoryRecord,
  lifecycleStatus: "active" | "archived" | "superseded" | "revoked",
) {
  return { ...record, lifecycleStatus } satisfies MemoryRecord;
}

function validAt(version: MemoryTemporalVersion, at: number): boolean {
  return !version.invalidated && version.validFrom <= at &&
    (version.validTo === undefined || at < version.validTo) &&
    version.record.lifecycleStatus !== "revoked";
}

function knownAt(version: MemoryTemporalVersion, at: number): boolean {
  return version.recordedAt <= at && (version.closedAt === undefined || at < version.closedAt);
}

export class InMemoryTemporalMemoryRepository implements TemporalMemoryRepository {
  readonly #lineages = new Map<string, StoredLineage>();
  readonly #transitionReceipts = new Map<string, MemoryVersionTransitionReceipt>();
  readonly #purgeReceipts = new Map<string, MemoryPurgeReceipt>();
  readonly #pendingPurges = new Set<string>();
  readonly #pendingPurgeRequests = new Map<string, PurgeTemporalMemoryLineageInput>();
  readonly #purgeDerived: NonNullable<InMemoryTemporalMemoryRepositoryOptions["purgeDerived"]>;

  constructor(options: InMemoryTemporalMemoryRepositoryOptions = {}) {
    this.#purgeDerived = options.purgeDerived ?? (async () => 0);
  }

  async getTransitionReceipt(scope: MemoryScope, idempotencyKey: string) {
    const value = this.#transitionReceipts.get(receiptKey(scope, idempotencyKey));
    return value ? clone(value) : undefined;
  }

  async getPurgeReceipt(scope: MemoryScope, idempotencyKey: string) {
    const value = this.#purgeReceipts.get(receiptKey(scope, idempotencyKey));
    return value ? clone(value) : undefined;
  }

  async getHead(scope: MemoryScope, lineageId: string) {
    const value = this.#lineages.get(lineageKey(scope, lineageId))?.head;
    return value ? clone(value) : undefined;
  }

  async getVersion(scope: MemoryScope, lineageId: string, versionId: string) {
    const value = this.#lineages.get(lineageKey(scope, lineageId))?.versions
      .find((version) => version.record.id === versionId);
    return value ? clone(value) : undefined;
  }

  async appendVersion(
    input: AppendTemporalMemoryVersionInput,
  ): Promise<MemoryVersionTransitionResult> {
    const existingReceipt = await this.getTransitionReceipt(
      input.scope,
      input.receipt.idempotencyKey,
    );
    if (existingReceipt) {
      if (existingReceipt.requestHash !== input.receipt.requestHash) {
        throw new MemoryEvolutionError("MEMORY_IDEMPOTENCY_CONFLICT");
      }
      const existingVersion = await this.getVersion(
        input.scope,
        input.version.lineageId,
        existingReceipt.versionId ?? "",
      );
      if (!existingVersion) throw new MemoryEvolutionError("MEMORY_VERSION_CONFLICT");
      return { version: existingVersion, receipt: existingReceipt, replayed: true };
    }

    const key = lineageKey(input.scope, input.version.lineageId);
    if (this.#pendingPurges.has(key)) throw new MemoryEvolutionError("MEMORY_PURGE_PENDING");
    const stored = this.#lineages.get(key);
    const currentRevision = stored?.head.latestRevision ?? 0;
    if (currentRevision !== input.expectedHeadRevision ||
        input.version.revision !== input.expectedHeadRevision + 1) {
      throw new MemoryEvolutionError("MEMORY_VERSION_STALE");
    }
    if (stored?.versions.some((version) => version.record.id === input.version.record.id)) {
      throw new MemoryEvolutionError("MEMORY_VERSION_CONFLICT");
    }

    const versions = stored ? stored.versions.map(clone) : [];
    if (input.version.activationState === "active" && input.expectedHeadRevision > 0 &&
        stored?.head.currentVersionId !== undefined) {
      const previousIndex = versions.findIndex((version) =>
        version.record.id === stored?.head.currentVersionId &&
        version.revision === input.expectedHeadRevision);
      if (previousIndex < 0) throw new MemoryEvolutionError("MEMORY_VERSION_STALE");
      const previous = versions[previousIndex]!;
      const validTo = Math.max(previous.validFrom, input.version.validFrom);
      versions[previousIndex] = {
        ...previous,
        record: withLifecycle(previous.record, "superseded"),
        validTo,
        closedAt: input.version.recordedAt,
        invalidated: input.version.transitionType === "corrected",
      };
    }
    versions.push(clone(input.version));
    versions.sort((left, right) => left.revision - right.revision);
    const head: MemoryLineageHead = {
      scopeFingerprint: scopeFingerprint(input.scope),
      lineageId: input.version.lineageId,
      latestRevision: input.version.revision,
      ...(input.version.activationState === "staged"
        ? {
            ...(stored?.head.currentVersionId === undefined
              ? {}
              : { currentVersionId: stored.head.currentVersionId }),
            ...(stored?.head.currentVersionRevision === undefined
              ? {}
              : { currentVersionRevision: stored.head.currentVersionRevision }),
          }
        : {
            currentVersionId: input.version.record.id,
            currentVersionRevision: input.version.revision,
          }),
      updatedAt: input.version.recordedAt,
    };
    this.#lineages.set(key, { head, versions });
    this.#transitionReceipts.set(
      receiptKey(input.scope, input.receipt.idempotencyKey),
      clone(input.receipt),
    );
    return { version: clone(input.version), receipt: clone(input.receipt), replayed: false };
  }

  async closeHead(
    input: CloseTemporalMemoryHeadInput,
  ): Promise<MemoryVersionTransitionResult> {
    const existingReceipt = await this.getTransitionReceipt(
      input.scope,
      input.receipt.idempotencyKey,
    );
    if (existingReceipt) {
      if (existingReceipt.requestHash !== input.receipt.requestHash) {
        throw new MemoryEvolutionError("MEMORY_IDEMPOTENCY_CONFLICT");
      }
      const existingVersion = await this.getVersion(
        input.scope,
        input.lineageId,
        existingReceipt.previousVersionId ?? "",
      );
      if (!existingVersion) throw new MemoryEvolutionError("MEMORY_VERSION_CONFLICT");
      return { version: existingVersion, receipt: existingReceipt, replayed: true };
    }

    const key = lineageKey(input.scope, input.lineageId);
    const stored = this.#lineages.get(key);
    if (!stored) throw new MemoryEvolutionError("MEMORY_LINEAGE_NOT_FOUND");
    if (this.#pendingPurges.has(key)) throw new MemoryEvolutionError("MEMORY_PURGE_PENDING");
    if (stored.head.currentVersionRevision !== input.expectedHeadRevision ||
        stored.head.currentVersionId === undefined) {
      throw new MemoryEvolutionError("MEMORY_VERSION_STALE");
    }
    const index = stored.versions.findIndex((version) =>
      version.record.id === stored.head.currentVersionId);
    if (index < 0) throw new MemoryEvolutionError("MEMORY_VERSION_CONFLICT");
    const current = stored.versions[index]!;
    if (input.validTo < current.validFrom) {
      throw new MemoryEvolutionError("MEMORY_VERSION_CONFLICT");
    }
    const scheduled = input.transitionType === "expired" &&
      input.validTo > input.receipt.occurredAt;
    const closed: MemoryTemporalVersion = scheduled
      ? {
          ...current,
          validTo: input.validTo,
          transitionReason: input.reason,
        }
      : {
          ...current,
          record: withLifecycle(current.record,
            input.transitionType === "revoked" ? "revoked" : "archived"),
          validTo: input.validTo,
          closedAt: input.receipt.occurredAt,
          transitionReason: input.reason,
          invalidated: input.transitionType === "revoked",
        };
    stored.versions[index] = closed;
    if (!scheduled) {
      const {
        currentVersionId: _currentVersionId,
        currentVersionRevision: _currentVersionRevision,
        ...headWithoutCurrent
      } = stored.head;
      stored.head = {
        ...headWithoutCurrent,
        updatedAt: input.receipt.occurredAt,
      };
    }
    this.#transitionReceipts.set(
      receiptKey(input.scope, input.receipt.idempotencyKey),
      clone(input.receipt),
    );
    return { version: clone(closed), receipt: clone(input.receipt), replayed: false };
  }

  async current(scope: MemoryScope, lineageId: string, at: number) {
    const key = lineageKey(scope, lineageId);
    if (this.#pendingPurges.has(key)) return undefined;
    const stored = this.#lineages.get(key);
    const value = stored?.versions
      .filter((version) => validAt(version, at) &&
        (version.record.lifecycleStatus === "active" || version.activationState === "staged"))
      .sort((left, right) => right.validFrom - left.validFrom || right.revision - left.revision)[0];
    return value ? clone(value) : undefined;
  }

  async asOf(scope: MemoryScope, lineageId: string, asOf: number, known?: number) {
    const key = lineageKey(scope, lineageId);
    if (this.#pendingPurges.has(key)) return undefined;
    const candidates = (this.#lineages.get(key)?.versions ?? [])
      .filter((version) => validAt(version, asOf) &&
        (known === undefined || knownAt(version, known)))
      .sort((left, right) => right.revision - left.revision);
    return candidates[0] ? clone(candidates[0]) : undefined;
  }

  async history(scope: MemoryScope, lineageId: string): Promise<MemoryHistoryResult | undefined> {
    const key = lineageKey(scope, lineageId);
    if (this.#pendingPurges.has(key)) return undefined;
    const stored = this.#lineages.get(key);
    if (!stored) return undefined;
    return {
      scope: clone(normalizedScope(scope)),
      lineageId,
      head: clone(stored.head),
      versions: clone(stored.versions),
    };
  }

  async activateDue(now: number, limit: number): Promise<number> {
    let activated = 0;
    const lineages = [...this.#lineages.entries()].sort(([left], [right]) => left.localeCompare(right));
    for (const [key, stored] of lineages) {
      if (activated >= limit) break;
      if (this.#pendingPurges.has(key)) continue;
      const staged = stored.versions.find((version) =>
        version.activationState === "staged" && version.validFrom <= now &&
        version.revision === stored.head.latestRevision);
      if (staged === undefined) continue;
      if (stored.head.currentVersionId !== undefined) {
        const previousIndex = stored.versions.findIndex((version) =>
          version.record.id === stored.head.currentVersionId);
        if (previousIndex < 0) throw new MemoryEvolutionError("MEMORY_VERSION_CONFLICT");
        const previous = stored.versions[previousIndex]!;
        stored.versions[previousIndex] = {
          ...previous,
          record: withLifecycle(previous.record, "superseded"),
          validTo: staged.validFrom,
          closedAt: now,
        };
      }
      const stagedIndex = stored.versions.findIndex((version) =>
        version.record.id === staged.record.id);
      stored.versions[stagedIndex] = {
        ...staged,
        record: withLifecycle(staged.record, "active"),
        activationState: "active",
      };
      stored.head = {
        ...stored.head,
        currentVersionId: staged.record.id,
        currentVersionRevision: staged.revision,
        updatedAt: now,
      };
      activated += 1;
    }
    return activated;
  }

  async materializeExpired(now: number, limit: number): Promise<number> {
    let materialized = 0;
    const lineages = [...this.#lineages.entries()].sort(([left], [right]) =>
      left.localeCompare(right));
    for (const [key, stored] of lineages) {
      if (materialized >= limit) break;
      if (this.#pendingPurges.has(key) || stored.head.currentVersionId === undefined) continue;
      const index = stored.versions.findIndex((version) =>
        version.record.id === stored.head.currentVersionId &&
        version.revision === stored.head.currentVersionRevision &&
        version.activationState === "active" &&
        version.record.lifecycleStatus === "active" &&
        version.validTo !== undefined && version.validTo <= now);
      if (index < 0) continue;
      const current = stored.versions[index]!;
      stored.versions[index] = {
        ...current,
        record: withLifecycle(current.record, "archived"),
        closedAt: now,
      };
      const {
        currentVersionId: _currentVersionId,
        currentVersionRevision: _currentVersionRevision,
        ...headWithoutCurrent
      } = stored.head;
      stored.head = {
        ...headWithoutCurrent,
        updatedAt: now,
      };
      materialized += 1;
    }
    return materialized;
  }

  async purge(input: PurgeTemporalMemoryLineageInput): Promise<MemoryPurgeReceipt> {
    const existingReceipt = await this.getPurgeReceipt(input.scope, input.receipt.idempotencyKey);
    if (existingReceipt) {
      if (existingReceipt.requestHash !== input.receipt.requestHash) {
        throw new MemoryEvolutionError("MEMORY_IDEMPOTENCY_CONFLICT");
      }
      return existingReceipt;
    }
    const key = lineageKey(input.scope, input.lineageId);
    const stored = this.#lineages.get(key);
    if (!stored) throw new MemoryEvolutionError("MEMORY_LINEAGE_NOT_FOUND");
    this.#pendingPurges.add(key);
    this.#pendingPurgeRequests.set(key, clone(input));
    let derivedArtifactsPurged: number;
    try {
      derivedArtifactsPurged = await this.#purgeDerived(
        stored.versions.map((version) => version.record.id),
        input.lineageId,
        scopeFingerprint(input.scope),
      );
    } catch {
      throw new MemoryEvolutionError("MEMORY_PURGE_PENDING");
    }
    const receipt: MemoryPurgeReceipt = {
      ...input.receipt,
      lineageHash: createHash("sha256").update(input.lineageId).digest("hex"),
      purgedVersions: stored.versions.length,
      derivedArtifactsPurged,
    };
    this.#lineages.delete(key);
    this.#pendingPurges.delete(key);
    this.#pendingPurgeRequests.delete(key);
    this.#purgeReceipts.set(receiptKey(input.scope, receipt.idempotencyKey), clone(receipt));
    return clone(receipt);
  }

  async retryPendingPurges(_now: number, limit: number) {
    const requests = [...this.#pendingPurgeRequests.values()].slice(0, limit);
    let completed = 0;
    for (const request of requests) {
      try {
        await this.purge(request);
        completed += 1;
      } catch {
        // Pending state is the durable retry source of truth.
      }
    }
    return { attempted: requests.length, completed, failed: requests.length - completed };
  }
}
