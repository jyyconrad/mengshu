/**
 * 5type / 5-slot continuity helpers.
 *
 * Storage dimension: MemorySemanticType = profile | task_context | rules | experience | resource.
 * Consumption view: memory_context_fast always exposes all five keys so Agents can rely on a
 * stable schema even when a slot has no active memories.
 */

import type { ContextFastResponse, SlotContextBlock } from "../domain/semantic-types.js";
import { FIVE_QUESTIONS } from "../domain/semantic-types.js";
import type { MemorySemanticType } from "../domain/types.js";

/** Stable order used by ensureFiveSlots and tests (not prompt pack order). */
export const MEMORY_SEMANTIC_TYPE_ORDER: readonly MemorySemanticType[] = [
  "profile",
  "task_context",
  "rules",
  "experience",
  "resource",
] as const;

export type EmptySlotReason =
  | "no_active_memories"
  | "loadout_policy_excluded"
  | "all_filtered";

export function emptySlotBlock(
  semanticType: MemorySemanticType,
  reason: EmptySlotReason = "no_active_memories",
): SlotContextBlock {
  return {
    semanticType,
    question: FIVE_QUESTIONS[semanticType],
    content: "",
    sourceIds: [],
    evidenceRefs: [],
    nodeCount: 0,
    tokenEstimate: 0,
    warnings: [`empty_slot: ${reason}`],
  };
}

export interface EnsureFiveSlotsOptions {
  /** Types excluded by Loadout native policy (still present as empty keys). */
  loadoutExcluded?: ReadonlySet<MemorySemanticType>;
  /** Filtered entries used to refine empty-slot reasons. */
  filtered?: ReadonlyArray<{ semanticType?: MemorySemanticType; reason?: string }>;
}

function refineEmptyReason(
  semanticType: MemorySemanticType,
  options: EnsureFiveSlotsOptions,
): EmptySlotReason {
  if (options.loadoutExcluded?.has(semanticType)) {
    return "loadout_policy_excluded";
  }
  const related = (options.filtered ?? []).filter((entry) => entry.semanticType === semanticType);
  if (related.length > 0) {
    return "all_filtered";
  }
  return "no_active_memories";
}

/**
 * Guarantee all five slot keys exist on a ContextFastResponse.slots object.
 * Existing non-empty blocks are preserved; missing keys get explicit empty blocks.
 */
export function ensureFiveSlots(
  slots: ContextFastResponse["slots"],
  options: EnsureFiveSlotsOptions = {},
): Required<ContextFastResponse["slots"]> {
  const next = { ...slots } as Required<ContextFastResponse["slots"]>;
  for (const semanticType of MEMORY_SEMANTIC_TYPE_ORDER) {
    const existing = next[semanticType];
    if (existing && existing.nodeCount > 0) {
      continue;
    }
    if (existing && existing.nodeCount === 0 && existing.warnings?.some((w) => w.startsWith("empty_slot:"))) {
      continue;
    }
    next[semanticType] = emptySlotBlock(semanticType, refineEmptyReason(semanticType, options));
  }
  return next;
}

/** Assert helper for tests and MCP adapters. */
export function assertFiveSlotKeys(slots: ContextFastResponse["slots"]): void {
  for (const semanticType of MEMORY_SEMANTIC_TYPE_ORDER) {
    if (!slots[semanticType]) {
      throw new Error(`FIVE_SLOT_KEY_MISSING:${semanticType}`);
    }
  }
}
