import { createHash } from "node:crypto";

import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope, MemorySemanticType } from "../domain/types.js";
import type { AgentLoadoutRepository } from "./repository.js";
import type {
  AgentLoadout,
  AgentLoadoutReceipt,
  CreateAgentLoadoutVersionInput,
  CreateAgentLoadoutVersionResult,
  DisclosureMode,
  NativeMemoryPolicy,
  PauseAgentLoadoutInput,
  SlotAssetBinding,
  UnbindAgentLoadoutAssetInput,
} from "./types.js";

export type AgentLoadoutErrorCode =
  | "INVALID_INPUT"
  | "PRIVATE_SCOPE_REQUIRED"
  | "SCOPE_MISMATCH"
  | "DUPLICATE_BINDING"
  | "VERSION_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "LOADOUT_NOT_FOUND"
  | "REQUIRED_BINDING_UNAVAILABLE";

export class AgentLoadoutError extends Error {
  constructor(readonly code: AgentLoadoutErrorCode) {
    super(code);
    this.name = "AgentLoadoutError";
  }
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;
const TYPES = new Set<MemorySemanticType>([
  "profile", "task_context", "rules", "experience", "resource",
]);
const MODES = new Set<DisclosureMode>([
  "must_read", "slot_summary", "navigation", "index_then_tool", "tool_only",
]);

function id(value: unknown): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new AgentLoadoutError("INVALID_INPUT");
  return value;
}

function privateScope(value: MemoryScope): MemoryScope & { visibility: "private" } {
  const scope = value.visibility === undefined ? { ...value, visibility: "private" as const } : value;
  if (scope.visibility !== "private") throw new AgentLoadoutError("PRIVATE_SCOPE_REQUIRED");
  try {
    authorityScopeFingerprint(scope);
  } catch {
    throw new AgentLoadoutError("INVALID_INPUT");
  }
  return Object.freeze({ ...scope, visibility: "private" });
}

function bindings(value: readonly SlotAssetBinding[]): readonly SlotAssetBinding[] {
  if (!Array.isArray(value)) throw new AgentLoadoutError("INVALID_INPUT");
  const result = value.map((binding) => {
    if (!binding || typeof binding !== "object" || !TYPES.has(binding.slot) ||
        !MODES.has(binding.disclosureMode) || !Number.isSafeInteger(binding.priority) ||
        binding.priority < 0 || binding.priority > 1_000_000 ||
        typeof binding.required !== "boolean" ||
        (binding.pinnedVersion !== undefined &&
          (!Number.isSafeInteger(binding.pinnedVersion) || binding.pinnedVersion < 1)) ||
        (binding.maxTokens !== undefined &&
          (!Number.isSafeInteger(binding.maxTokens) || binding.maxTokens < 1))) {
      throw new AgentLoadoutError("INVALID_INPUT");
    }
    return Object.freeze({ ...binding, assetId: id(binding.assetId) });
  });
  if (new Set(result.map((item) => `${item.assetId}:${item.slot}`)).size !== result.length) {
    throw new AgentLoadoutError("DUPLICATE_BINDING");
  }
  return Object.freeze(result);
}

function policy(value: NativeMemoryPolicy): NativeMemoryPolicy {
  if (!value || typeof value !== "object" || !Array.isArray(value.semanticTypes) ||
      value.semanticTypes.some((type) => !TYPES.has(type)) ||
      new Set(value.semanticTypes).size !== value.semanticTypes.length ||
      !["project_only", "project_workspace", "authorized"].includes(value.scopeReuse) ||
      !["source", "topic", "global"].includes(value.treeDepth)) {
    throw new AgentLoadoutError("INVALID_INPUT");
  }
  const tokenBudgets = { ...value.tokenBudgets };
  for (const type of TYPES) {
    if (!Number.isSafeInteger(tokenBudgets[type]) || tokenBudgets[type] < 0) {
      throw new AgentLoadoutError("INVALID_INPUT");
    }
  }
  return Object.freeze({
    semanticTypes: Object.freeze([...value.semanticTypes]),
    scopeReuse: value.scopeReuse,
    treeDepth: value.treeDepth,
    tokenBudgets: Object.freeze(tokenBudgets),
  });
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function frozen<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
      new Date(Date.parse(value)).toISOString() !== value) {
    throw new AgentLoadoutError("INVALID_INPUT");
  }
  return value;
}

/** Reconstruct and deep-freeze a loadout read from untrusted JSONB. */
export function validatePersistedAgentLoadout(value: unknown): AgentLoadout {
  const allowed = new Set([
    "id", "scope", "appId", "agentId", "projectId", "version", "visibility",
    "slotBindings", "nativeMemoryPolicy", "createdAt", "updatedAt",
  ]);
  if (!plainRecord(value) || Object.keys(value).some((key) => !allowed.has(key)) ||
      value.visibility !== "private" || !Number.isSafeInteger(value.version) ||
      (value.version as number) < 1) {
    throw new AgentLoadoutError("INVALID_INPUT");
  }
  const scope = privateScope(value.scope as MemoryScope);
  const appId = id(value.appId);
  const agentId = id(value.agentId);
  const projectId = value.projectId === undefined ? undefined : id(value.projectId);
  if (appId !== scope.appId || agentId !== scope.agentId ||
      (projectId !== undefined && projectId !== scope.projectId)) {
    throw new AgentLoadoutError("SCOPE_MISMATCH");
  }
  const createdAt = timestamp(value.createdAt);
  const updatedAt = timestamp(value.updatedAt);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new AgentLoadoutError("INVALID_INPUT");
  return frozen({
    id: id(value.id),
    scope,
    appId,
    agentId,
    ...(projectId === undefined ? {} : { projectId }),
    version: value.version as number,
    visibility: "private",
    slotBindings: bindings(value.slotBindings as readonly SlotAssetBinding[]),
    nativeMemoryPolicy: policy(value.nativeMemoryPolicy as NativeMemoryPolicy),
    createdAt,
    updatedAt,
  });
}

export function validatePersistedAgentLoadoutReceipt(value: unknown): AgentLoadoutReceipt {
  if (!plainRecord(value) || Object.keys(value).length !== 4 ||
      !["requestKey", "requestHash", "loadoutId", "loadoutVersion"]
        .every((key) => Object.hasOwn(value, key)) ||
      typeof value.requestHash !== "string" || !/^[0-9a-f]{64}$/.test(value.requestHash) ||
      !Number.isSafeInteger(value.loadoutVersion) || (value.loadoutVersion as number) < 1) {
    throw new AgentLoadoutError("INVALID_INPUT");
  }
  return frozen({
    requestKey: id(value.requestKey),
    requestHash: value.requestHash,
    loadoutId: id(value.loadoutId),
    loadoutVersion: value.loadoutVersion as number,
  });
}

export class AgentLoadoutService {
  constructor(private readonly repository: AgentLoadoutRepository) {}

  resolveCurrent(scope: MemoryScope): Promise<AgentLoadout | undefined> {
    return this.repository.resolveCurrent(privateScope(scope));
  }

  async resolveForAssembly(scope: MemoryScope): Promise<AgentLoadout | undefined> {
    const loadout = await this.resolveCurrent(scope);
    return loadout && loadout.slotBindings.length > 0 ? loadout : undefined;
  }

  getLatest(scope: MemoryScope, loadoutId: string): Promise<AgentLoadout | undefined> {
    return this.repository.getLatest(privateScope(scope), id(loadoutId));
  }

  async createVersion(input: CreateAgentLoadoutVersionInput): Promise<CreateAgentLoadoutVersionResult> {
    const scope = privateScope(input.scope);
    const loadoutId = id(input.id);
    const requestKey = id(input.idempotencyKey);
    const appId = id(input.appId);
    const agentId = id(input.agentId);
    const projectId = input.projectId === undefined ? undefined : id(input.projectId);
    if (appId !== scope.appId || agentId !== scope.agentId ||
        (projectId !== undefined && projectId !== scope.projectId)) {
      throw new AgentLoadoutError("SCOPE_MISMATCH");
    }
    if (!Number.isSafeInteger(input.expectedLatestVersion) || input.expectedLatestVersion < 0) {
      throw new AgentLoadoutError("INVALID_INPUT");
    }
    const slotBindings = bindings(input.slotBindings);
    const nativeMemoryPolicy = policy(input.nativeMemoryPolicy);
    const requestHash = hash({
      id: loadoutId, expectedLatestVersion: input.expectedLatestVersion, scope,
      appId, agentId, projectId, slotBindings, nativeMemoryPolicy,
    });
    const existingReceipt = await this.repository.getReceipt(scope, requestKey);
    if (existingReceipt) {
      if (existingReceipt.requestHash !== requestHash) throw new AgentLoadoutError("IDEMPOTENCY_CONFLICT");
      const loadout = await this.repository.getVersion(scope, loadoutId, existingReceipt.loadoutVersion);
      if (!loadout) throw new AgentLoadoutError("LOADOUT_NOT_FOUND");
      return frozen({ loadout, replayed: true });
    }
    const now = new Date(this.repository.now?.() ?? Date.now()).toISOString();
    const loadout: AgentLoadout = frozen({
      id: loadoutId,
      scope,
      appId,
      agentId,
      ...(projectId === undefined ? {} : { projectId }),
      version: input.expectedLatestVersion + 1,
      visibility: "private",
      slotBindings,
      nativeMemoryPolicy,
      createdAt: now,
      updatedAt: now,
    });
    const persisted = await this.repository.appendVersion({
      loadout,
      expectedLatestVersion: input.expectedLatestVersion,
      receipt: { requestKey, requestHash, loadoutId, loadoutVersion: loadout.version },
    });
    return frozen({ loadout: persisted.loadout, replayed: persisted.replayed });
  }

  async unbind(input: UnbindAgentLoadoutAssetInput): Promise<CreateAgentLoadoutVersionResult> {
    const scope = privateScope(input.scope);
    const loadoutId = id(input.loadoutId);
    const assetId = id(input.assetId);
    if (!TYPES.has(input.slot)) throw new AgentLoadoutError("INVALID_INPUT");
    return this.appendBindingChange({
      scope,
      loadoutId,
      expectedLatestVersion: input.expectedLatestVersion,
      requestKey: id(input.idempotencyKey),
      requestHash: hash({
        operation: "unbind", scope, loadoutId, assetId, slot: input.slot,
        expectedLatestVersion: input.expectedLatestVersion,
      }),
      transform: (previous) => {
        const next = previous.slotBindings.filter((binding) =>
          binding.assetId !== assetId || binding.slot !== input.slot);
        if (next.length === previous.slotBindings.length) {
          throw new AgentLoadoutError("INVALID_INPUT");
        }
        return next;
      },
    });
  }

  async pause(input: PauseAgentLoadoutInput): Promise<CreateAgentLoadoutVersionResult> {
    const scope = privateScope(input.scope);
    const loadoutId = id(input.loadoutId);
    return this.appendBindingChange({
      scope,
      loadoutId,
      expectedLatestVersion: input.expectedLatestVersion,
      requestKey: id(input.idempotencyKey),
      requestHash: hash({
        operation: "pause", scope, loadoutId,
        expectedLatestVersion: input.expectedLatestVersion,
      }),
      transform: (previous) => {
        if (previous.slotBindings.length === 0) throw new AgentLoadoutError("INVALID_INPUT");
        return [];
      },
    });
  }

  private async appendBindingChange(input: {
    readonly scope: MemoryScope & { readonly visibility: "private" };
    readonly loadoutId: string;
    readonly expectedLatestVersion: number;
    readonly requestKey: string;
    readonly requestHash: string;
    readonly transform: (previous: AgentLoadout) => readonly SlotAssetBinding[];
  }): Promise<CreateAgentLoadoutVersionResult> {
    if (!Number.isSafeInteger(input.expectedLatestVersion) || input.expectedLatestVersion < 1) {
      throw new AgentLoadoutError("INVALID_INPUT");
    }
    const existingReceipt = await this.repository.getReceipt(input.scope, input.requestKey);
    if (existingReceipt) {
      if (existingReceipt.requestHash !== input.requestHash ||
          existingReceipt.loadoutId !== input.loadoutId) {
        throw new AgentLoadoutError("IDEMPOTENCY_CONFLICT");
      }
      const replay = await this.repository.getVersion(
        input.scope,
        input.loadoutId,
        existingReceipt.loadoutVersion,
      );
      if (!replay) throw new AgentLoadoutError("LOADOUT_NOT_FOUND");
      return frozen({ loadout: replay, replayed: true });
    }
    const previous = await this.repository.getLatest(input.scope, input.loadoutId);
    if (!previous) throw new AgentLoadoutError("LOADOUT_NOT_FOUND");
    if (previous.version !== input.expectedLatestVersion) {
      throw new AgentLoadoutError("VERSION_CONFLICT");
    }
    const now = new Date(this.repository.now?.() ?? Date.now()).toISOString();
    const loadout = frozen({
      ...previous,
      version: previous.version + 1,
      slotBindings: bindings(input.transform(previous)),
      createdAt: now,
      updatedAt: now,
    });
    const persisted = await this.repository.appendVersion({
      loadout,
      expectedLatestVersion: previous.version,
      receipt: {
        requestKey: input.requestKey,
        requestHash: input.requestHash,
        loadoutId: input.loadoutId,
        loadoutVersion: loadout.version,
      },
    });
    return frozen({ loadout: persisted.loadout, replayed: persisted.replayed });
  }
}
