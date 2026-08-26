import { randomUUID } from "node:crypto";

import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../domain/types.js";
import { MemoryViewAssetError } from "./content-ref.js";
import type {
  AppendMemoryViewAssetVersionInput,
  MemoryViewAssetRepository,
} from "./repository.js";
import type {
  MemoryViewAssetDescriptor,
  MemoryViewPromotionReceipt,
} from "./types.js";

export interface InMemoryMemoryViewAssetRepositoryOptions {
  readonly idFactory?: () => string;
  readonly now?: () => number;
}

function deepClone<T>(value: T): T {
  return structuredClone(value);
}

function scopeKey(scope: MemoryScope): string {
  return authorityScopeFingerprint(scope.visibility === undefined
    ? { ...scope, visibility: "private" }
    : scope);
}

export class InMemoryMemoryViewAssetRepository implements MemoryViewAssetRepository {
  readonly idFactory: () => string;
  readonly now: () => number;
  readonly #assets = new Map<string, Map<number, MemoryViewAssetDescriptor>>();
  readonly #receipts = new Map<string, MemoryViewPromotionReceipt>();

  constructor(options: InMemoryMemoryViewAssetRepositoryOptions = {}) {
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? Date.now;
  }

  async listLatest(scope: MemoryScope): Promise<readonly MemoryViewAssetDescriptor[]> {
    const prefix = `${scopeKey(scope)}:`;
    return [...this.#assets.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, versions]) => deepClone(versions.get(Math.max(...versions.keys()))!))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async getLatest(
    scope: MemoryScope,
    assetId: string,
  ): Promise<MemoryViewAssetDescriptor | undefined> {
    const versions = this.#assets.get(`${scopeKey(scope)}:${assetId}`);
    if (!versions || versions.size === 0) return undefined;
    const latest = Math.max(...versions.keys());
    return deepClone(versions.get(latest)!);
  }

  async getVersion(
    scope: MemoryScope,
    assetId: string,
    version: number,
  ): Promise<MemoryViewAssetDescriptor | undefined> {
    const value = this.#assets.get(`${scopeKey(scope)}:${assetId}`)?.get(version);
    return value ? deepClone(value) : undefined;
  }

  async getReceipt(
    scope: MemoryScope,
    requestKey: string,
  ): Promise<MemoryViewPromotionReceipt | undefined> {
    const value = this.#receipts.get(`${scopeKey(scope)}:${requestKey}`);
    return value ? deepClone(value) : undefined;
  }

  async appendVersion(input: AppendMemoryViewAssetVersionInput) {
    const key = `${scopeKey(input.asset.sourceScope)}:${input.asset.id}`;
    const versions = this.#assets.get(key) ?? new Map<number, MemoryViewAssetDescriptor>();
    const receiptKey = `${scopeKey(input.asset.sourceScope)}:${input.receipt.requestKey}`;
    const existingReceipt = this.#receipts.get(receiptKey);
    if (existingReceipt) {
      if (existingReceipt.requestHash !== input.receipt.requestHash) {
        throw new MemoryViewAssetError("IDEMPOTENCY_CONFLICT");
      }
      const asset = versions.get(existingReceipt.assetVersion);
      if (!asset) throw new MemoryViewAssetError("ASSET_NOT_FOUND");
      return { asset: deepClone(asset), receipt: deepClone(existingReceipt), replayed: true };
    }
    const latestVersion = versions.size === 0 ? 0 : Math.max(...versions.keys());
    if (latestVersion !== input.expectedLatestVersion ||
        input.asset.version !== latestVersion + 1) {
      throw new MemoryViewAssetError("VERSION_CONFLICT");
    }
    versions.set(input.asset.version, deepClone(input.asset));
    this.#assets.set(key, versions);
    this.#receipts.set(receiptKey, deepClone(input.receipt));
    return { asset: deepClone(input.asset), receipt: deepClone(input.receipt), replayed: false };
  }
}
