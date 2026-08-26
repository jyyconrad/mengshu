import { createHash } from "node:crypto";

import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { ContextAssemblyPlan, ContextFastResponse } from "../domain/semantic-types.js";
import type { MemoryScope, MemorySemanticType } from "../domain/types.js";
import type {
  AgentLoadout,
  DisclosureMode,
  LoadoutAssemblyResult,
  LoadoutDeniedReason,
} from "../loadout/types.js";

export interface ContextAssemblyBindingReceipt {
  readonly assetId: string;
  readonly slot: MemorySemanticType;
  readonly priority: number;
  readonly required: boolean;
  readonly requestedDisclosureMode: DisclosureMode;
  readonly effectiveDisclosureMode?: DisclosureMode;
  readonly selectedVersion?: number;
  readonly deniedReason?: LoadoutDeniedReason | "asset_unavailable";
  readonly degradedReason?: "budget_exceeded";
}

export interface ContextAssemblyReceipt {
  readonly id: string;
  readonly scopeFingerprint: string;
  readonly sessionId: string;
  readonly plan: ContextAssemblyPlan;
  readonly loadout?: { readonly id: string; readonly version: number };
  readonly bindings: readonly ContextAssemblyBindingReceipt[];
  readonly denied: ReadonlyArray<{ readonly ref: string; readonly reason: string }>;
  readonly degraded: ReadonlyArray<{
    readonly assetId: string;
    readonly slot: MemorySemanticType;
    readonly reason: "budget_exceeded";
  }>;
  readonly memoryRefs: readonly string[];
  readonly treeRefs: readonly string[];
  readonly assetRefs: ReadonlyArray<{ readonly assetId: string; readonly version: number }>;
  readonly evidenceRefs: readonly string[];
  readonly warnings: readonly string[];
  readonly stableContentHash: string;
  readonly dynamicContentHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ContextAssemblyReceiptRepository {
  append(scope: MemoryScope, receipt: ContextAssemblyReceipt): Promise<ContextAssemblyReceipt>;
  getLatest(scope: MemoryScope, sessionId: string): Promise<ContextAssemblyReceipt | undefined>;
}

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_TEXT = /^[^\p{Cc}]{1,512}$/u;
const SESSION_ID = /^[^\p{White_Space}\p{Cc}\\/]{1,256}$/u;
const SEMANTIC_TYPES = new Set<MemorySemanticType>([
  "profile", "task_context", "rules", "experience", "resource",
]);
const DISCLOSURE_MODES = new Set<DisclosureMode>([
  "must_read", "slot_summary", "navigation", "index_then_tool", "tool_only",
]);

function invalid(): never {
  throw new Error("Context assembly receipt is invalid");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stable(child)]));
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
      new Date(Date.parse(value)).toISOString() !== value) invalid();
  return value;
}

function safeText(value: unknown): string {
  if (typeof value !== "string" || !SAFE_TEXT.test(value) || value !== value.trim()) invalid();
  return value;
}

function validSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID.test(value) &&
    value.normalize("NFKC") === value;
}

function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function jsonSnapshot<T>(value: T): T {
  try {
    return deepFreeze(structuredClone(value));
  } catch {
    return invalid();
  }
}

function assertReceiptShape(value: unknown): asserts value is ContextAssemblyReceipt {
  if (!plain(value) || typeof value.id !== "string" || !SHA256.test(value.id) ||
      typeof value.scopeFingerprint !== "string" || !SHA256.test(value.scopeFingerprint) ||
      !validSessionId(value.sessionId) || !plain(value.plan) ||
      value.plan.sessionId !== value.sessionId || !Array.isArray(value.bindings) ||
      !Array.isArray(value.denied) || !Array.isArray(value.degraded) ||
      !Array.isArray(value.memoryRefs) || !Array.isArray(value.treeRefs) ||
      !Array.isArray(value.assetRefs) || !Array.isArray(value.evidenceRefs) ||
      !Array.isArray(value.warnings) || typeof value.stableContentHash !== "string" ||
      !SHA256.test(value.stableContentHash) || typeof value.dynamicContentHash !== "string" ||
      !SHA256.test(value.dynamicContentHash) || value.plan.stableContentHash !== value.stableContentHash ||
      value.plan.dynamicContentHash !== value.dynamicContentHash) invalid();
  const createdAt = timestamp(value.createdAt);
  const expiresAt = timestamp(value.expiresAt);
  if (value.plan.expiresAt !== expiresAt || Date.parse(expiresAt) < Date.parse(createdAt)) invalid();
  for (const refs of [value.memoryRefs, value.treeRefs, value.evidenceRefs]) {
    if (refs.some((item) => typeof item !== "string" || !SAFE_TEXT.test(item)) ||
        new Set(refs).size !== refs.length) invalid();
  }
  if (value.warnings.some((item) => typeof item !== "string" || item.length > 2_000 || /\p{Cc}/u.test(item))) {
    invalid();
  }
  if (value.assetRefs.some((item) => !plain(item) || !SAFE_TEXT.test(String(item.assetId)) ||
      !Number.isSafeInteger(item.version) || Number(item.version) < 1)) invalid();
  if (value.bindings.some((item) => !plain(item) || !SAFE_TEXT.test(String(item.assetId)) ||
      typeof item.slot !== "string" || !SEMANTIC_TYPES.has(item.slot as MemorySemanticType) ||
      !Number.isSafeInteger(item.priority) || Number(item.priority) < -1_000_000 ||
      Number(item.priority) > 1_000_000 || typeof item.required !== "boolean" ||
      typeof item.requestedDisclosureMode !== "string" ||
      !DISCLOSURE_MODES.has(item.requestedDisclosureMode as DisclosureMode) ||
      (item.effectiveDisclosureMode !== undefined &&
        (typeof item.effectiveDisclosureMode !== "string" ||
          !DISCLOSURE_MODES.has(item.effectiveDisclosureMode as DisclosureMode))) ||
      (item.selectedVersion !== undefined &&
        (!Number.isSafeInteger(item.selectedVersion) || Number(item.selectedVersion) < 1)))) invalid();
  if (value.loadout !== undefined && (!plain(value.loadout) ||
      !SAFE_TEXT.test(String(value.loadout.id)) || !Number.isSafeInteger(value.loadout.version) ||
      Number(value.loadout.version) < 1)) invalid();
  const { id, ...receiptWithoutId } = value;
  if (digest(["mengshu.context-assembly-receipt/v1", receiptWithoutId]) !== id) invalid();
}

export function validatePersistedContextAssemblyReceipt(value: unknown): ContextAssemblyReceipt {
  const snapshot = jsonSnapshot(value);
  assertReceiptShape(snapshot);
  return snapshot;
}

export function createContextAssemblyReceipt(input: {
  readonly scope: MemoryScope;
  readonly response: ContextFastResponse;
  readonly loadout?: AgentLoadout;
  readonly assembly?: LoadoutAssemblyResult;
  readonly now?: number;
}): ContextAssemblyReceipt {
  const sessionId = input.scope.sessionId;
  if (!validSessionId(sessionId)) {
    throw new Error("Context assembly receipt requires a valid sessionId");
  }
  const scopeFingerprint = authorityScopeFingerprint(input.scope);
  if (authorityScopeFingerprint(input.response.scope) !== scopeFingerprint ||
      !input.response.assemblyPlan || input.response.assemblyPlan.sessionId !== sessionId) {
    throw new Error("Context assembly receipt scope/session mismatch");
  }
  const plan = jsonSnapshot(input.response.assemblyPlan);
  const slots = Object.values(plan.slots).filter((slot) => slot !== undefined);
  const assetIds = new Set(slots.flatMap((slot) => slot.assetRefs.map((ref) => ref.assetId)));
  const memoryRefs = unique(slots.flatMap((slot) => [
    ...slot.navigation.filter((ref) => ref.kind === "memory").map((ref) => ref.ref),
    ...slot.mustRead.filter((block) => !assetIds.has(block.ref)).map((block) => block.ref),
  ]));
  const treeRefs = unique(slots.flatMap((slot) => slot.navigation
    .filter((ref) => ref.kind.endsWith("_tree")).map((ref) => ref.ref)));
  const evidenceRefs = unique(slots.flatMap((slot) => slot.evidenceRefs));
  const assetRefs = [...new Map(slots.flatMap((slot) => slot.assetRefs)
    .map((ref) => [`${ref.assetId}:${ref.version}`, { ...ref }] as const)).values()]
    .sort((left, right) => left.assetId.localeCompare(right.assetId) || left.version - right.version);
  const selectedVersions = new Map(input.assembly?.receipt?.assetVersions
    .map((item) => [item.assetId, item.version] as const) ?? []);
  const contributions = input.assembly?.contributions ?? [];
  const deniedByAsset = new Map(input.assembly?.denied.map((item) =>
    [item.assetId, item.reason] as const) ?? []);
  const degradedByBinding = new Map(input.assembly?.degraded.map((item) =>
    [`${item.assetId}:${item.slot}`, item.reason] as const) ?? []);
  const bindings = (input.loadout?.slotBindings ?? []).map((binding) => {
    const contribution = contributions.find((item) =>
      item.assetId === binding.assetId && item.slot === binding.slot);
    return {
      assetId: binding.assetId,
      slot: binding.slot,
      priority: binding.priority,
      required: binding.required,
      requestedDisclosureMode: binding.disclosureMode,
      ...(contribution === undefined ? {} : { effectiveDisclosureMode: contribution.disclosureMode }),
      ...(selectedVersions.get(binding.assetId) === undefined
        ? {}
        : { selectedVersion: selectedVersions.get(binding.assetId)! }),
      ...(deniedByAsset.get(binding.assetId) === undefined
        ? {}
        : { deniedReason: deniedByAsset.get(binding.assetId)! }),
      ...(degradedByBinding.get(`${binding.assetId}:${binding.slot}`) === undefined
        ? {}
        : { degradedReason: degradedByBinding.get(`${binding.assetId}:${binding.slot}`)! }),
    } satisfies ContextAssemblyBindingReceipt;
  });
  const createdAt = new Date(input.now ?? Date.now()).toISOString();
  const receiptWithoutId = {
    scopeFingerprint,
    sessionId,
    plan,
    ...(input.loadout === undefined ? {} : { loadout: { id: input.loadout.id, version: input.loadout.version } }),
    bindings,
    denied: [...plan.denied],
    degraded: [...(input.assembly?.degraded ?? [])],
    memoryRefs,
    treeRefs,
    assetRefs,
    evidenceRefs,
    warnings: [...(input.response.warnings ?? [])],
    stableContentHash: plan.stableContentHash,
    dynamicContentHash: plan.dynamicContentHash,
    createdAt,
    expiresAt: plan.expiresAt,
  };
  return validatePersistedContextAssemblyReceipt({
    id: digest(["mengshu.context-assembly-receipt/v1", receiptWithoutId]),
    ...receiptWithoutId,
  });
}
