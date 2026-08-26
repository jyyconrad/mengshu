import { describe, expect, test } from "vitest";

import {
  planLegacySemanticTypeBackfill,
  type LegacySemanticTypeBackfillRecord,
} from "./semantic-type-backfill.js";

function record(
  overrides: Partial<LegacySemanticTypeBackfillRecord> = {},
): LegacySemanticTypeBackfillRecord {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    kind: "decision",
    metadata: {},
    lifecycleStatus: "active",
    ...overrides,
  };
}

describe("legacy semantic type backfill planner", () => {
  test("preserves an explicit valid semantic type without rewriting metadata", () => {
    expect(planLegacySemanticTypeBackfill(record({
      metadata: { semanticType: "experience" },
    }))).toMatchObject({
      disposition: "preserve_explicit",
      semanticType: "experience",
      eligibleForContext: true,
      mutation: undefined,
    });
  });

  test("mirrors a one-sided explicit semantic type without changing its meaning", () => {
    expect(planLegacySemanticTypeBackfill(record({
      metadata: {
        semanticType: "rules",
        governance: { native: { kind: "decision" } },
      },
    }))).toMatchObject({
      disposition: "preserve_explicit",
      semanticType: "rules",
      eligibleForContext: true,
      mutation: { semanticType: "rules" },
    });

    expect(planLegacySemanticTypeBackfill(record({
      metadata: {
        governance: { native: { kind: "decision", semanticType: "rules" } },
      },
    }))).toMatchObject({
      disposition: "preserve_explicit",
      semanticType: "rules",
      eligibleForContext: true,
      mutation: { semanticType: "rules" },
    });
  });

  test("writes only deterministic high-confidence kind mappings", () => {
    const plan = planLegacySemanticTypeBackfill(record());
    expect(plan).toMatchObject({
      disposition: "backfill",
      semanticType: "rules",
      eligibleForContext: true,
      mutation: { semanticType: "rules" },
    });
    expect(plan.originalValueHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test.each(["fact", "entity", "observation", "other"] as const)(
    "keeps unmappable kind=%s as kind-only lookup data",
    (kind) => {
      expect(planLegacySemanticTypeBackfill(record({ kind }))).toMatchObject({
        disposition: "lookup_only",
        semanticType: undefined,
        eligibleForContext: false,
        mutation: { isolateLookupOnly: true },
      });
    },
  );

  test("quarantines invalid explicit values instead of guessing from kind", () => {
    expect(planLegacySemanticTypeBackfill(record({
      metadata: { semanticType: "instruction" },
    }))).toMatchObject({
      disposition: "invalid_explicit",
      semanticType: undefined,
      eligibleForContext: false,
      mutation: { isolateLookupOnly: true },
    });
  });

  test("records conflicting top-level and canonical semantic types without mutating or enabling context", () => {
    expect(planLegacySemanticTypeBackfill(record({
      metadata: {
        semanticType: "rules",
        governance: { native: { kind: "decision", semanticType: "profile" } },
      },
    }))).toMatchObject({
      disposition: "invalid_explicit",
      semanticType: undefined,
      eligibleForContext: false,
      mutation: { isolateLookupOnly: true },
    });
  });

  test("keeps an unresolved kind-source conflict out of context", () => {
    expect(planLegacySemanticTypeBackfill(record({
      classificationConflict: true,
    }))).toMatchObject({
      disposition: "invalid_explicit",
      eligibleForContext: false,
      mutation: { isolateLookupOnly: true },
    });
  });

  test("inactive records are preserved but never promoted into context by migration", () => {
    expect(planLegacySemanticTypeBackfill(record({ lifecycleStatus: "archived" }))).toMatchObject({
      disposition: "backfill",
      semanticType: "rules",
      eligibleForContext: false,
    });
  });
});
