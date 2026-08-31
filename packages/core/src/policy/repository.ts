import type {
  MemoryPolicyMutationResult,
  MemoryPolicyOverlayReceipt,
  MemoryPolicyOverlayVersion,
  MemoryPolicyLayer,
} from "./types.js";

export interface MemoryPolicyOverlayRepository {
  getLatest(scopeFingerprint: string, overlayId: string): Promise<MemoryPolicyOverlayVersion | undefined>;
  getVersion(
    scopeFingerprint: string,
    overlayId: string,
    version: number,
  ): Promise<MemoryPolicyOverlayVersion | undefined>;
  listActive(
    scopeFingerprint: string,
    layer: MemoryPolicyLayer,
  ): Promise<readonly MemoryPolicyOverlayVersion[]>;
  getReceipt(
    scopeFingerprint: string,
    idempotencyKey: string,
  ): Promise<MemoryPolicyOverlayReceipt | undefined>;
  appendVersion(input: {
    readonly scopeFingerprint: string;
    readonly overlay: MemoryPolicyOverlayVersion;
    readonly receipt: MemoryPolicyOverlayReceipt;
    readonly expectedLatestVersion: number;
  }): Promise<MemoryPolicyMutationResult>;
}
