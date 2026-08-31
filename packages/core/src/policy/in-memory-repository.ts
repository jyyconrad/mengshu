import type { MemoryPolicyOverlayRepository } from "./repository.js";
import type {
  MemoryPolicyLayer,
  MemoryPolicyMutationResult,
  MemoryPolicyOverlayReceipt,
  MemoryPolicyOverlayVersion,
} from "./types.js";

const key = (...parts: readonly (string | number)[]) => parts.join("\0");

export class InMemoryMemoryPolicyOverlayRepository implements MemoryPolicyOverlayRepository {
  listCalls = 0;
  readonly #versions = new Map<string, MemoryPolicyOverlayVersion>();
  readonly #heads = new Map<string, number>();
  readonly #receipts = new Map<string, MemoryPolicyOverlayReceipt>();

  async getLatest(scopeFingerprint: string, overlayId: string): Promise<MemoryPolicyOverlayVersion | undefined> {
    const version = this.#heads.get(key(scopeFingerprint, overlayId));
    return version === undefined ? undefined : this.getVersion(scopeFingerprint, overlayId, version);
  }

  async getVersion(
    scopeFingerprint: string,
    overlayId: string,
    version: number,
  ): Promise<MemoryPolicyOverlayVersion | undefined> {
    return structuredClone(this.#versions.get(key(scopeFingerprint, overlayId, version)));
  }

  async listActive(
    scopeFingerprint: string,
    layer: MemoryPolicyLayer,
  ): Promise<readonly MemoryPolicyOverlayVersion[]> {
    this.listCalls += 1;
    const overlays: MemoryPolicyOverlayVersion[] = [];
    for (const headKey of this.#heads.keys()) {
      const [fingerprint, overlayId] = headKey.split("\0");
      if (fingerprint !== scopeFingerprint || overlayId === undefined) continue;
      const overlay = await this.getLatest(fingerprint, overlayId);
      if (overlay?.status === "active" && overlay.layer === layer) overlays.push(overlay);
    }
    return overlays.sort((left, right) => left.id.localeCompare(right.id));
  }

  async getReceipt(
    scopeFingerprint: string,
    idempotencyKey: string,
  ): Promise<MemoryPolicyOverlayReceipt | undefined> {
    return structuredClone(this.#receipts.get(key(scopeFingerprint, idempotencyKey)));
  }

  async appendVersion(input: {
    readonly scopeFingerprint: string;
    readonly overlay: MemoryPolicyOverlayVersion;
    readonly receipt: MemoryPolicyOverlayReceipt;
    readonly expectedLatestVersion: number;
  }): Promise<MemoryPolicyMutationResult> {
    const receiptKey = key(input.scopeFingerprint, input.receipt.idempotencyKey);
    const replay = this.#receipts.get(receiptKey);
    if (replay !== undefined) {
      if (replay.requestHash !== input.receipt.requestHash) throw new Error("POLICY_IDEMPOTENCY_CONFLICT");
      const overlay = await this.getVersion(input.scopeFingerprint, replay.overlayId, replay.version);
      if (overlay === undefined) throw new Error("POLICY_OVERLAY_NOT_FOUND");
      return { overlay, receipt: structuredClone(replay), replayed: true };
    }
    const headKey = key(input.scopeFingerprint, input.overlay.id);
    const latest = this.#heads.get(headKey) ?? 0;
    if (latest !== input.expectedLatestVersion || input.overlay.version !== latest + 1) {
      throw new Error("POLICY_VERSION_STALE");
    }
    this.#versions.set(
      key(input.scopeFingerprint, input.overlay.id, input.overlay.version),
      structuredClone(input.overlay),
    );
    this.#heads.set(headKey, input.overlay.version);
    this.#receipts.set(receiptKey, structuredClone(input.receipt));
    return { overlay: structuredClone(input.overlay), receipt: structuredClone(input.receipt), replayed: false };
  }
}
