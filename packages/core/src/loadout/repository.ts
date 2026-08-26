import type { MemoryScope } from "../domain/types.js";
import type { AgentLoadout, AgentLoadoutReceipt } from "./types.js";

export interface AppendAgentLoadoutVersionResult {
  readonly loadout: AgentLoadout;
  readonly receipt: AgentLoadoutReceipt;
  readonly replayed: boolean;
}

export interface AgentLoadoutRepository {
  readonly now?: () => number;
  /** Resolve the single exact-scope loadout for the current app/agent/project identity. */
  resolveCurrent(scope: MemoryScope): Promise<AgentLoadout | undefined>;
  getLatest(scope: MemoryScope, id: string): Promise<AgentLoadout | undefined>;
  getVersion(scope: MemoryScope, id: string, version: number): Promise<AgentLoadout | undefined>;
  getReceipt(scope: MemoryScope, requestKey: string): Promise<AgentLoadoutReceipt | undefined>;
  appendVersion(input: {
    readonly loadout: AgentLoadout;
    readonly receipt: AgentLoadoutReceipt;
    readonly expectedLatestVersion: number;
  }): Promise<AppendAgentLoadoutVersionResult>;
}
