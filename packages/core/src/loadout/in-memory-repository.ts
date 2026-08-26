import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../domain/types.js";
import { AgentLoadoutError } from "./service.js";
import type { AgentLoadoutRepository } from "./repository.js";
import type { AgentLoadout, AgentLoadoutReceipt } from "./types.js";

function normalized(scope: MemoryScope): MemoryScope {
  return scope.visibility === undefined ? { ...scope, visibility: "private" } : scope;
}

function scopeKey(scope: MemoryScope): string {
  return authorityScopeFingerprint(normalized(scope));
}

export class InMemoryAgentLoadoutRepository implements AgentLoadoutRepository {
  readonly now: () => number;
  readonly #versions = new Map<string, Map<number, AgentLoadout>>();
  readonly #receipts = new Map<string, AgentLoadoutReceipt>();

  constructor(options: { readonly now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  async resolveCurrent(scope: MemoryScope): Promise<AgentLoadout | undefined> {
    const prefix = `${scopeKey(scope)}:`;
    const matches = [...this.#versions.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, versions]) => versions.get(Math.max(...versions.keys()))!)
      .filter((loadout) => loadout.appId === scope.appId &&
        loadout.agentId === scope.agentId &&
        (loadout.projectId === undefined || loadout.projectId === scope.projectId));
    if (matches.length > 1) throw new AgentLoadoutError("INVALID_INPUT");
    return matches[0] ? structuredClone(matches[0]) : undefined;
  }

  async getLatest(scope: MemoryScope, id: string): Promise<AgentLoadout | undefined> {
    const versions = this.#versions.get(`${scopeKey(scope)}:${id}`);
    if (!versions?.size) return undefined;
    return structuredClone(versions.get(Math.max(...versions.keys()))!);
  }

  async getVersion(scope: MemoryScope, id: string, version: number): Promise<AgentLoadout | undefined> {
    const value = this.#versions.get(`${scopeKey(scope)}:${id}`)?.get(version);
    return value ? structuredClone(value) : undefined;
  }

  async getReceipt(scope: MemoryScope, requestKey: string): Promise<AgentLoadoutReceipt | undefined> {
    const value = this.#receipts.get(`${scopeKey(scope)}:${requestKey}`);
    return value ? structuredClone(value) : undefined;
  }

  async appendVersion(input: {
    readonly loadout: AgentLoadout;
    readonly receipt: AgentLoadoutReceipt;
    readonly expectedLatestVersion: number;
  }) {
    const key = `${scopeKey(input.loadout.scope)}:${input.loadout.id}`;
    const versions = this.#versions.get(key) ?? new Map<number, AgentLoadout>();
    const receiptKey = `${scopeKey(input.loadout.scope)}:${input.receipt.requestKey}`;
    const existing = this.#receipts.get(receiptKey);
    if (existing) {
      if (existing.requestHash !== input.receipt.requestHash) {
        throw new AgentLoadoutError("IDEMPOTENCY_CONFLICT");
      }
      const loadout = versions.get(existing.loadoutVersion);
      if (!loadout) throw new AgentLoadoutError("LOADOUT_NOT_FOUND");
      return { loadout: structuredClone(loadout), receipt: structuredClone(existing), replayed: true };
    }
    const latest = versions.size ? Math.max(...versions.keys()) : 0;
    if (latest !== input.expectedLatestVersion || input.loadout.version !== latest + 1) {
      throw new AgentLoadoutError("VERSION_CONFLICT");
    }
    versions.set(input.loadout.version, structuredClone(input.loadout));
    this.#versions.set(key, versions);
    this.#receipts.set(receiptKey, structuredClone(input.receipt));
    return {
      loadout: structuredClone(input.loadout),
      receipt: structuredClone(input.receipt),
      replayed: false,
    };
  }
}
