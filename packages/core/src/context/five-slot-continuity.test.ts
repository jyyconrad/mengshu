import { describe, expect, it } from "vitest";
import {
  MEMORY_SEMANTIC_TYPE_ORDER,
  assertFiveSlotKeys,
  emptySlotBlock,
  ensureFiveSlots,
} from "./five-slot-continuity.js";
import { FIVE_QUESTIONS } from "../domain/semantic-types.js";

describe("five-slot-continuity", () => {
  it("orders all five semantic types stably", () => {
    expect([...MEMORY_SEMANTIC_TYPE_ORDER]).toEqual([
      "profile",
      "task_context",
      "rules",
      "experience",
      "resource",
    ]);
  });

  it("ensureFiveSlots fills missing keys with empty_slot warnings", () => {
    const slots = ensureFiveSlots({
      rules: {
        semanticType: "rules",
        question: FIVE_QUESTIONS.rules,
        content: "- never push secrets",
        sourceIds: ["r1"],
        nodeCount: 1,
        tokenEstimate: 20,
      },
    });
    assertFiveSlotKeys(slots);
    expect(slots.rules?.nodeCount).toBe(1);
    expect(slots.profile?.nodeCount).toBe(0);
    expect(slots.profile?.sourceIds).toEqual([]);
    expect(slots.profile?.warnings?.[0]).toMatch(/^empty_slot: no_active_memories$/);
    expect(slots.experience?.warnings?.[0]).toMatch(/^empty_slot:/);
  });

  it("marks loadout-excluded empty slots distinctly", () => {
    const slots = ensureFiveSlots({}, {
      loadoutExcluded: new Set(["experience", "resource"]),
    });
    expect(slots.experience?.warnings?.[0]).toBe("empty_slot: loadout_policy_excluded");
    expect(slots.resource?.warnings?.[0]).toBe("empty_slot: loadout_policy_excluded");
    expect(slots.profile?.warnings?.[0]).toBe("empty_slot: no_active_memories");
  });

  it("emptySlotBlock uses FIVE_QUESTIONS", () => {
    const block = emptySlotBlock("task_context", "all_filtered");
    expect(block.question).toBe(FIVE_QUESTIONS.task_context);
    expect(block.content).toBe("");
  });
});
