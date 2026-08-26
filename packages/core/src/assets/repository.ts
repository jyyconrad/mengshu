import type { MemoryScope } from "../domain/types.js";
import type {
  MemoryViewAssetDescriptor,
  MemoryViewPromotionReceipt,
} from "./types.js";

export interface AppendMemoryViewAssetVersionInput {
  readonly asset: MemoryViewAssetDescriptor;
  readonly receipt: MemoryViewPromotionReceipt;
  readonly expectedLatestVersion: number;
}

export interface AppendMemoryViewAssetVersionResult {
  readonly asset: MemoryViewAssetDescriptor;
  readonly receipt: MemoryViewPromotionReceipt;
  readonly replayed: boolean;
}

export interface MemoryViewAssetRepository {
  readonly idFactory?: () => string;
  readonly now?: () => number;
  listLatest(scope: MemoryScope): Promise<readonly MemoryViewAssetDescriptor[]>;
  getLatest(scope: MemoryScope, assetId: string): Promise<MemoryViewAssetDescriptor | undefined>;
  getVersion(
    scope: MemoryScope,
    assetId: string,
    version: number,
  ): Promise<MemoryViewAssetDescriptor | undefined>;
  getReceipt(
    scope: MemoryScope,
    requestKey: string,
  ): Promise<MemoryViewPromotionReceipt | undefined>;
  appendVersion(
    input: AppendMemoryViewAssetVersionInput,
  ): Promise<AppendMemoryViewAssetVersionResult>;
}
