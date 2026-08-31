import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import { isRecallScoreBreakdown } from "../domain/recall-scoring.js";
import type { MemoryScope, MemorySemanticType } from "../domain/types.js";
import { AgentLoadoutError } from "./service.js";
import type {
  AgentLoadout,
  LoadoutAssemblyResult,
  LoadoutAssetCandidate,
  LoadoutContribution,
  LoadoutDeniedReason,
  SlotAssetBinding,
} from "./types.js";

function normalized(scope: MemoryScope): MemoryScope {
  return scope.visibility === undefined ? { ...scope, visibility: "private" } : scope;
}

function sameScope(left: MemoryScope, right: MemoryScope): boolean {
  try {
    return authorityScopeFingerprint(normalized(left)) === authorityScopeFingerprint(normalized(right));
  } catch {
    return false;
  }
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function selectVersion(
  binding: SlotAssetBinding,
  candidates: readonly LoadoutAssetCandidate[],
): LoadoutAssetCandidate | undefined {
  const matching = candidates.filter((item) => item.assetId === binding.assetId &&
    item.assetKind === (binding.assetKind ?? "memory_view"));
  if (binding.pinnedVersion !== undefined) {
    return matching.find((item) => item.assetVersion === binding.pinnedVersion);
  }
  return [...matching].sort((left, right) => right.assetVersion - left.assetVersion)[0];
}

function denyReason(
  loadout: AgentLoadout,
  binding: SlotAssetBinding,
  candidate: LoadoutAssetCandidate,
  minScore: number,
): LoadoutDeniedReason | undefined {
  if ((candidate.assetKind !== "memory_view" && candidate.assetKind !== "skill") ||
      candidate.status !== "published") {
    return "asset_not_published";
  }
  if (candidate.contentValidity !== "current") return "asset_stale";
  if (!sameScope(candidate.scope, loadout.scope)) return "scope_mismatch";
  if (!candidate.semanticTypes.includes(binding.slot)) return "slot_incompatible";
  if (!candidate.lifecycleEligible) return "lifecycle_ineligible";
  if (candidate.riskBlocked) return "risk_blocked";
  if (candidate.conflictUnresolved) return "conflict_unresolved";
  if (!isRecallScoreBreakdown(candidate.scoreBreakdown) ||
      Math.abs(candidate.score - candidate.scoreBreakdown.score) > 1e-9) {
    return "score_breakdown_unavailable";
  }
  if (candidate.score < minScore) return "score_below_threshold";
  return undefined;
}

function consumesBody(binding: SlotAssetBinding): boolean {
  return binding.disclosureMode === "must_read" || binding.disclosureMode === "slot_summary";
}

function exceedsBodyBudget(
  binding: SlotAssetBinding,
  candidate: LoadoutAssetCandidate,
  remaining: number,
): boolean {
  if (!consumesBody(binding)) return false;
  return candidate.tokenEstimate > Math.min(
    binding.maxTokens ?? Number.POSITIVE_INFINITY,
    remaining,
  );
}

export interface AgentLoadoutAssemblyOptions {
  readonly nativeTokenUsage?: Partial<Record<MemorySemanticType, number>>;
}

export class AgentLoadoutAssembler {
  readonly #minScore: number;

  constructor(options: { readonly minScore?: number } = {}) {
    this.#minScore = options.minScore ?? 0;
    if (!Number.isFinite(this.#minScore) || this.#minScore < 0 || this.#minScore > 1) {
      throw new AgentLoadoutError("INVALID_INPUT");
    }
  }

  assemble(
    loadout: AgentLoadout | undefined,
    candidates: readonly LoadoutAssetCandidate[],
    options: AgentLoadoutAssemblyOptions = {},
  ): LoadoutAssemblyResult {
    if (!loadout) {
      return freeze({
        enhancementEnabled: false,
        contributions: [],
        denied: [],
        degraded: [],
        receipt: undefined,
      });
    }
    const denied: Array<{ assetId: string; reason: LoadoutDeniedReason }> = [];
    const degraded: LoadoutAssemblyResult["degraded"][number][] = [];
    const contributions: LoadoutContribution[] = [];
    const eligible: Array<{
      binding: SlotAssetBinding;
      candidate: LoadoutAssetCandidate;
    }> = [];
    for (const binding of loadout.slotBindings) {
      const candidate = selectVersion(binding, candidates);
      const reason = candidate
        ? denyReason(loadout, binding, candidate, this.#minScore)
        : "asset_unavailable";
      if (reason) {
        denied.push({ assetId: binding.assetId, reason });
        if (binding.required) throw new AgentLoadoutError("REQUIRED_BINDING_UNAVAILABLE");
        continue;
      }
      eligible.push({ binding, candidate: candidate! });
    }
    eligible.sort((left, right) =>
      right.candidate.score - left.candidate.score ||
      right.binding.priority - left.binding.priority ||
      left.binding.assetId.localeCompare(right.binding.assetId));
    const remaining = new Map<MemorySemanticType, number>();
    for (const slot of ["profile", "task_context", "rules", "experience", "resource"] as const) {
      const nativeUsage = options.nativeTokenUsage?.[slot] ?? 0;
      if (!Number.isFinite(nativeUsage) || nativeUsage < 0) {
        throw new AgentLoadoutError("INVALID_INPUT");
      }
      remaining.set(slot, Math.max(0, loadout.nativeMemoryPolicy.tokenBudgets[slot] - nativeUsage));
    }
    for (const { binding, candidate } of eligible) {
      const available = remaining.get(binding.slot) ?? 0;
      const budgetExceeded = exceedsBodyBudget(binding, candidate, available);
      if (budgetExceeded) {
        degraded.push({
          assetId: binding.assetId,
          slot: binding.slot,
          reason: "budget_exceeded",
        });
      }
      contributions.push({
        ...candidate,
        slot: binding.slot,
        disclosureMode: budgetExceeded ? "navigation" : binding.disclosureMode,
        ...(budgetExceeded
          ? {
              requestedDisclosureMode: binding.disclosureMode,
              degradedReason: "budget_exceeded" as const,
            }
          : {}),
        bindingPriority: binding.priority,
      });
      if (!budgetExceeded && consumesBody(binding)) {
        remaining.set(binding.slot, available - candidate.tokenEstimate);
      }
    }
    const assetVersions = contributions
      .map(({ assetId, assetKind, assetVersion }) => ({
        assetId,
        ...(assetKind === "skill" ? { assetKind } : {}),
        version: assetVersion,
      }))
      .sort((left, right) => (left.assetKind ?? "memory_view")
        .localeCompare(right.assetKind ?? "memory_view") ||
        left.assetId.localeCompare(right.assetId));
    return freeze({
      enhancementEnabled: true,
      contributions,
      denied,
      degraded,
      receipt: {
        loadoutId: loadout.id,
        loadoutVersion: loadout.version,
        assetVersions,
      },
    });
  }
}
