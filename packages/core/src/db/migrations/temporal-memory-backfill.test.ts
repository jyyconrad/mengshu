import { describe, expect, test } from "vitest";

import type { MemoryScope } from "../../domain/types.js";
import {
  planTemporalMemoryBackfill,
  type TemporalMemoryBackfillSourceRow,
} from "./temporal-memory-backfill.js";

const SCOPE: MemoryScope = Object.freeze({
  tenantId: "tenant-1", userId: "user-1", appId: "codex",
  projectId: "project-1", agentId: "agent-1", namespace: "memories",
  visibility: "private",
});

function row(
  id: string,
  createdAt: number,
  overrides: Partial<TemporalMemoryBackfillSourceRow> = {},
): TemporalMemoryBackfillSourceRow {
  return {
    id,
    scope: SCOPE,
    kind: "decision",
    semanticType: "rules",
    lifecycleStatus: "active",
    contentHash: id.replaceAll("-", "").padEnd(64, "a").slice(0, 64),
    createdAt,
    metadata: {},
    ...overrides,
  };
}

describe("planTemporalMemoryBackfill", () => {
  test("single legacy row becomes revision 1 and current head without guessing lineage peers", () => {
    const plan = planTemporalMemoryBackfill([
      row("00000000-0000-4000-8000-000000000001", 100),
    ], { runId: "temporal-plan-1", createdAt: 1_000 });

    expect(plan.counts).toEqual({ scanned: 1, automatic: 1, review: 0, lineages: 1 });
    expect(plan.rows[0]).toMatchObject({
      disposition: "bootstrap_single",
      revision: 1,
      validFrom: 100,
      lifecycleStatus: "active",
      currentHead: true,
    });
    expect(plan.rows[0]?.lineageId).toMatch(/^tm_[0-9a-f]{48}$/);
  });

  test("exact-scope explicit supersededBy chain gets monotonic revisions and half-open intervals", () => {
    const v1 = row("00000000-0000-4000-8000-000000000011", 100, {
      lifecycleStatus: "superseded",
      supersededBy: "00000000-0000-4000-8000-000000000012",
    });
    const v2 = row("00000000-0000-4000-8000-000000000012", 200, {
      lifecycleStatus: "superseded",
      supersededBy: "00000000-0000-4000-8000-000000000013",
    });
    const v3 = row("00000000-0000-4000-8000-000000000013", 300);
    const plan = planTemporalMemoryBackfill([v3, v1, v2], {
      runId: "temporal-plan-chain",
      createdAt: 1_000,
    });

    expect(plan.counts).toEqual({ scanned: 3, automatic: 3, review: 0, lineages: 1 });
    expect(plan.rows.map((item) => ({
      id: item.memoryId,
      disposition: item.disposition,
      revision: item.revision,
      previous: item.previousVersionId,
      validFrom: item.validFrom,
      validTo: item.validTo,
      current: item.currentHead,
    }))).toEqual([
      {
        id: v1.id, disposition: "reuse_supersedes_chain", revision: 1,
        previous: undefined, validFrom: 100, validTo: 200, current: false,
      },
      {
        id: v2.id, disposition: "reuse_supersedes_chain", revision: 2,
        previous: v1.id, validFrom: 200, validTo: 300, current: false,
      },
      {
        id: v3.id, disposition: "reuse_supersedes_chain", revision: 3,
        previous: v2.id, validFrom: 300, validTo: undefined, current: true,
      },
    ]);
  });

  test("cross-scope edge, type mismatch, fork and cycle never auto-merge", () => {
    const otherScope = { ...SCOPE, projectId: "project-2" };
    const target = row("00000000-0000-4000-8000-000000000021", 200);
    const sources = [
      row("00000000-0000-4000-8000-000000000022", 100, {
        supersededBy: target.id,
        scope: otherScope,
      }),
      row("00000000-0000-4000-8000-000000000023", 100, {
        supersededBy: target.id,
        semanticType: "experience",
      }),
      row("00000000-0000-4000-8000-000000000024", 100, { supersededBy: target.id }),
      row("00000000-0000-4000-8000-000000000025", 110, { supersededBy: target.id }),
      row("00000000-0000-4000-8000-000000000026", 300, {
        supersededBy: "00000000-0000-4000-8000-000000000027",
      }),
      row("00000000-0000-4000-8000-000000000027", 400, {
        supersededBy: "00000000-0000-4000-8000-000000000026",
      }),
      target,
    ];
    const plan = planTemporalMemoryBackfill(sources, {
      runId: "temporal-plan-review",
      createdAt: 1_000,
    });

    expect(plan.counts.review).toBeGreaterThanOrEqual(6);
    expect(plan.rows.filter((item) => item.disposition.startsWith("review_")))
      .toHaveLength(plan.counts.review);
    expect(plan.rows.filter((item) => item.disposition.startsWith("review_"))
      .every((item) => item.lineageId === undefined && item.revision === undefined)).toBe(true);
  });

  test("same frozen input is order-independent and yields the same manifest hash", () => {
    const rows = [
      row("00000000-0000-4000-8000-000000000031", 100),
      row("00000000-0000-4000-8000-000000000032", 200),
    ];
    const a = planTemporalMemoryBackfill(rows, { runId: "run-a", createdAt: 1_000 });
    const b = planTemporalMemoryBackfill([...rows].reverse(), {
      runId: "run-a",
      createdAt: 1_000,
    });

    expect(a.manifestHash).toBe(b.manifestHash);
    expect(a.rows).toEqual(b.rows);
  });
});
