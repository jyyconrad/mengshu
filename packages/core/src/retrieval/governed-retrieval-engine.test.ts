import { describe, expect, test, vi } from "vitest";
import {
  computeRecallScoreBreakdown,
  DEFAULT_RECALL_WEIGHTS,
} from "../domain/recall-scoring.js";
import { computeScopeFit } from "../domain/scope-fit.js";
import type { MemoryRecord, MemoryScope } from "../domain/types.js";
import {
  GovernedRetrievalEngine,
  createGovernedSemanticIdentity,
  type GovernedRetrievalCandidate,
  type GovernedRetrievalHydration,
} from "./governed-retrieval-engine.js";

const scope: MemoryScope = {
  tenantId: "tenant-a",
  appId: "codex",
  userId: "user-a",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "default",
  visibility: "private",
};

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "memory-a",
    scope,
    kind: "decision",
    semanticType: "rules",
    lifecycleStatus: "active",
    text: "Use the governed retrieval path.",
    contentHash: "hash-a",
    importance: 0.8,
    confidence: 0.7,
    hotness: 4,
    category: "other",
    dataType: "memory",
    metadata: { admissionRoute: "active", contextEligible: true },
    provenance: { source: "user" },
    sourceNodeIds: ["evidence-a", "evidence-b"],
    createdAt: 1,
    ...overrides,
  };
}

function candidate(
  overrides: Partial<GovernedRetrievalCandidate> = {},
): GovernedRetrievalCandidate {
  return {
    candidateId: "candidate-a",
    authoritativeRecordId: "memory-a",
    scope,
    source: "vector",
    nodeType: "memory",
    relevance: 0.9,
    evidenceIds: ["evidence-a"],
    navigation: { kind: "memory", ref: "memory-a" },
    ...overrides,
  };
}

function hydration(
  memory: MemoryRecord = record(),
  evidenceIds: readonly string[] = memory.sourceNodeIds ?? [],
): GovernedRetrievalHydration {
  return { record: memory, evidenceIds };
}

function engineFor(entries: Readonly<Record<string, GovernedRetrievalHydration | undefined>>) {
  const hydrate = vi.fn(async ({ authoritativeRecordId }: { authoritativeRecordId: string }) =>
    entries[authoritativeRecordId]);
  return { engine: new GovernedRetrievalEngine({ hydrate }), hydrate };
}

describe("GovernedRetrievalEngine", () => {
  test.each([undefined, "invalid"])("rejects an invalid retrieval intent: %s", async (intent) => {
    const { engine } = engineFor({ "memory-a": hydration() });

    await expect(engine.retrieve({
      intent,
      scope,
      candidates: [candidate()],
    } as never)).rejects.toThrow("intent must be lookup or context");
  });

  test.each([
    {
      name: "authority mismatch",
      memory: record({ scope: { ...scope, userId: "user-b" } }),
      reason: "authority_mismatch",
    },
    {
      name: "lifecycle ineligible",
      memory: record({ lifecycleStatus: "revoked" }),
      reason: "lifecycle_ineligible",
    },
    {
      name: "risk blocked",
      memory: record({ metadata: { admissionRoute: "active", riskFlags: ["prompt_injection"] } }),
      reason: "risk_blocked",
    },
    {
      name: "sensitive scope expansion blocked",
      memory: record({
        metadata: {
          admissionRoute: "active",
          governance: { candidate: { riskFlags: ["sensitive"], targetScope: "workspace" } },
        },
      }),
      reason: "risk_blocked",
    },
    {
      name: "conflict unresolved",
      memory: record({ metadata: { admissionRoute: "active", conflictStatus: "unresolved" } }),
      reason: "conflict_unresolved",
    },
    {
      name: "conflict risk unresolved",
      memory: record({
        metadata: {
          admissionRoute: "active",
          governance: { candidate: { riskFlags: ["conflict_possible"] } },
        },
      }),
      reason: "conflict_unresolved",
    },
  ])("hard filter: $name", async ({ memory, reason }) => {
    const { engine } = engineFor({ "memory-a": hydration(memory) });

    const result = await engine.retrieve({ intent: "context", scope, candidates: [candidate()] });

    expect(result.hits).toEqual([]);
    expect(result.filtered).toEqual([
      expect.objectContaining({ candidateId: "candidate-a", filteredReason: reason }),
    ]);
  });

  test("authoritative governance reason takes precedence over an invalid score signal", async () => {
    const revoked = record({ lifecycleStatus: "revoked" });
    const { engine } = engineFor({ "memory-a": hydration(revoked) });

    const result = await engine.retrieve({
      intent: "context",
      scope,
      candidates: [candidate({ relevance: Number.NaN })],
    });

    expect(result.filtered).toEqual([
      expect.objectContaining({ filteredReason: "lifecycle_ineligible" }),
    ]);
  });

  test.each([
    {
      intent: "context" as const,
      memory: record(),
      returned: true,
    },
    {
      intent: "lookup" as const,
      memory: record(),
      returned: true,
    },
    {
      intent: "lookup" as const,
      memory: record({
        lifecycleStatus: "archived",
        container: "session_candidate",
        metadata: { admissionRoute: "lookup_only", contextEligible: false },
      }),
      returned: true,
    },
    {
      intent: "context" as const,
      memory: record({
        lifecycleStatus: "archived",
        container: "session_candidate",
        metadata: { admissionRoute: "lookup_only", contextEligible: false },
      }),
      returned: false,
    },
    {
      intent: "lookup" as const,
      memory: record({
        lifecycleStatus: "archived",
        container: "session_candidate",
        metadata: { admissionRoute: "evidence_only", contextEligible: false },
      }),
      returned: false,
    },
  ])("intent=$intent applies the governed lifecycle contract", async ({ intent, memory, returned }) => {
    const { engine } = engineFor({ "memory-a": hydration(memory) });

    const result = await engine.retrieve({ intent, scope, candidates: [candidate()] });

    expect(result.hits).toHaveLength(returned ? 1 : 0);
    if (!returned) {
      expect(result.filtered).toEqual([
        expect.objectContaining({ filteredReason: "lifecycle_ineligible" }),
      ]);
    }
  });

  test.each([
    ["app", { appId: "other-app" }],
    ["workspace", { workspaceId: "other-workspace" }],
    ["project", { projectId: "other-project" }],
    ["agent", { agentId: "other-agent" }],
    ["namespace", { namespace: "other-namespace" }],
  ])("hard filters a task_context record across %s scope", async (_name, scopeOverride) => {
    const foreignScope = { ...scope, workspaceId: "workspace-a", ...scopeOverride };
    const requestScope = { ...scope, workspaceId: "workspace-a" };
    const memory = record({
      scope: foreignScope,
      semanticType: "task_context",
    });
    const { engine } = engineFor({ "memory-a": hydration(memory) });

    const result = await engine.retrieve({
      intent: "lookup",
      scope: requestScope,
      candidates: [candidate({ scope: foreignScope })],
    });

    expect(result.hits).toEqual([]);
    expect(result.filtered).toEqual([
      expect.objectContaining({ filteredReason: "scope_mismatch" }),
    ]);
  });

  test("hard filters a cross-project source candidate even when hydration returns a local record", async () => {
    const requestScope = { ...scope, workspaceId: "workspace-a" };
    const local = record({ scope: requestScope, semanticType: "task_context" });
    const { engine } = engineFor({ "memory-a": hydration(local) });

    const result = await engine.retrieve({
      intent: "lookup",
      scope: requestScope,
      candidates: [candidate({
        scope: { ...requestScope, projectId: "other-project" },
      })],
    });

    expect(result.hits).toEqual([]);
    expect(result.filtered).toEqual([
      expect.objectContaining({ filteredReason: "scope_mismatch" }),
    ]);
  });

  test("preserves workspace-level rules reuse across projects", async () => {
    const requestScope = { ...scope, workspaceId: "workspace-a" };
    const sharedScope = { ...requestScope, projectId: "other-project", agentId: "other-agent" };
    const sharedRule = record({ scope: sharedScope, semanticType: "rules" });
    const { engine } = engineFor({ "memory-a": hydration(sharedRule) });

    const result = await engine.retrieve({
      intent: "context",
      scope: requestScope,
      candidates: [candidate({ scope: sharedScope })],
    });

    expect(result.hits).toHaveLength(1);
  });

  test("ordinary memory requires evidence-backed hydration", async () => {
    const ungrounded = record({ sourceNodeIds: [] });
    const { engine } = engineFor({ "memory-a": hydration(ungrounded, []) });

    const result = await engine.retrieve({
      intent: "lookup",
      scope,
      candidates: [candidate({ evidenceIds: [] })],
    });

    expect(result.hits).toEqual([]);
    expect(result.filtered).toEqual([
      expect.objectContaining({ filteredReason: "evidence_unavailable" }),
    ]);
  });

  test("cross-source dedup hydrates once and merges source signals/navigation", async () => {
    const { engine, hydrate } = engineFor({ "memory-a": hydration() });
    const candidates: GovernedRetrievalCandidate[] = [
      candidate({
        candidateId: "vector-a",
        source: "vector",
        relevance: 0.8,
        navigation: { kind: "memory", ref: "memory-a" },
      }),
      candidate({
        candidateId: "entity-a",
        source: "entity_graph",
        nodeType: "entity_graph",
        relevance: 0.7,
        navigation: { kind: "entity_graph", ref: "entity-project" },
      }),
      candidate({
        candidateId: "tree-a",
        source: "tree",
        nodeType: "tree",
        relevance: 0.9,
        evidenceIds: ["evidence-a", "evidence-b"],
        navigation: { kind: "tree", ref: "topic-node-a" },
      }),
    ];

    const result = await engine.retrieve({ intent: "context", scope, candidates });

    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({
      record: { id: "memory-a" },
      slot: "rules",
      matchedBy: ["vector", "entity_graph", "tree"],
      navigation: [
        { kind: "memory", ref: "memory-a" },
        { kind: "entity_graph", ref: "entity-project" },
        { kind: "tree", ref: "topic-node-a" },
      ],
    });
    expect(result.filtered).toEqual([]);
  });

  test("same governed semantic identity uses route-aware first-wins and excludes evidence-only", async () => {
    type RouteAwareCandidateFixture = Required<Pick<
      GovernedRetrievalCandidate,
      "governedSemanticIdentity" | "admissionRoute"
    >> & GovernedRetrievalCandidate;
    const active = record({
      id: "memory-active",
      contentHash: "same-governed-semantic-identity",
      sourceNodeIds: ["evidence-active"],
      metadata: { admissionRoute: "active", contextEligible: true },
    });
    const lookupOnly = record({
      id: "memory-lookup-only",
      lifecycleStatus: "archived",
      container: "session_candidate",
      contentHash: "same-governed-semantic-identity",
      sourceNodeIds: ["evidence-lookup"],
      metadata: { admissionRoute: "lookup_only", contextEligible: false },
    });
    const evidenceOnly = record({
      id: "memory-evidence-only",
      lifecycleStatus: "archived",
      container: "session_candidate",
      contentHash: "same-governed-semantic-identity",
      sourceNodeIds: ["evidence-raw"],
      metadata: { admissionRoute: "evidence_only", contextEligible: false },
    });
    const semanticIdentity = createGovernedSemanticIdentity(active);
    const { engine } = engineFor({
      [active.id]: hydration(active),
      [lookupOnly.id]: hydration(lookupOnly),
      [evidenceOnly.id]: hydration(evidenceOnly),
    });
    const candidates: RouteAwareCandidateFixture[] = [
      {
        ...candidate({
          candidateId: "candidate-active",
          authoritativeRecordId: active.id,
          relevance: 0.2,
          evidenceIds: ["evidence-active"],
        }),
        governedSemanticIdentity: semanticIdentity,
        admissionRoute: "active",
      },
      {
        ...candidate({
          candidateId: "candidate-lookup-only",
          authoritativeRecordId: lookupOnly.id,
          relevance: 0.99,
          evidenceIds: ["evidence-lookup"],
        }),
        governedSemanticIdentity: semanticIdentity,
        admissionRoute: "lookup_only",
      },
      {
        ...candidate({
          candidateId: "candidate-evidence-only",
          authoritativeRecordId: evidenceOnly.id,
          source: "recent",
          nodeType: "evidence",
          relevance: 1,
          evidenceIds: ["evidence-raw"],
        }),
        governedSemanticIdentity: semanticIdentity,
        admissionRoute: "evidence_only",
      },
    ];

    const result = await engine.retrieve({ intent: "lookup", scope, candidates });

    expect(result.hits.map((hit) => hit.record.id)).toEqual([active.id]);
    expect(result.filtered).toContainEqual(expect.objectContaining({
      candidateId: "candidate-evidence-only",
      authoritativeRecordId: evidenceOnly.id,
      filteredReason: "lifecycle_ineligible",
    }));
    expect(result.filtered).toContainEqual(expect.objectContaining({
      candidateId: "candidate-lookup-only",
      authoritativeRecordId: lookupOnly.id,
      filteredReason: "governed_identity_superseded",
    }));
  });

  test("provider identity and route must match the authoritative hydrated record", async () => {
    const memory = record();
    const { engine } = engineFor({ [memory.id]: hydration(memory) });

    const result = await engine.retrieve({
      intent: "lookup",
      scope,
      candidates: [candidate({
        governedSemanticIdentity: createGovernedSemanticIdentity({
          ...memory,
          contentHash: "forged-hash",
        }),
        admissionRoute: "lookup_only",
      })],
    });

    expect(result.hits).toEqual([]);
    expect(result.filtered).toEqual([expect.objectContaining({
      filteredReason: "governance_mismatch",
    })]);
  });

  test("score, factors and contributions exactly reuse the single six-factor breakdown", async () => {
    const memory = record();
    const { engine } = engineFor({ "memory-a": hydration(memory) });
    const candidates = [
      candidate({ source: "vector", relevance: 0.65 }),
      candidate({
        candidateId: "work-a",
        source: "work_memory_graph",
        nodeType: "work_memory_graph",
        relevance: 0.75,
        navigation: { kind: "work_memory_graph", ref: "decision-chain-a" },
      }),
      candidate({
        candidateId: "bm25-a",
        source: "bm25",
        relevance: 0.55,
        navigation: { kind: "memory", ref: "memory-a" },
      }),
    ];
    const expected = computeRecallScoreBreakdown(
      memory,
      { relevance: 0.75, scopeFit: computeScopeFit(scope, memory.scope) },
      ["vector", "graph", "text"],
      { vector: 0.65, work_memory_graph: 0.75, bm25: 0.55 },
    );

    const result = await engine.retrieve({ intent: "context", scope, candidates });

    expect(result.hits[0].scoreBreakdown).toEqual(expected);
    expect(result.hits[0].score).toBe(expected.score);
    expect(result.hits[0].factors).toEqual(expected.factors);
    expect(result.hits[0].contributions).toEqual(expected.contributions);
    expect(result.hits[0].scoreBreakdown.weights).toEqual(DEFAULT_RECALL_WEIGHTS);
  });

  test("applies minScore before limit and explains low-score filtering", async () => {
    const low = record({
      id: "low",
      importance: 0,
      confidence: 0,
      hotness: 0,
      sourceNodeIds: ["evidence-low"],
    });
    const { engine } = engineFor({ low: hydration(low) });

    const result = await engine.retrieve({
      intent: "context",
      scope,
      minScore: 0.8,
      limit: 1,
      candidates: [candidate({
        candidateId: "low-candidate",
        authoritativeRecordId: "low",
        relevance: 0,
        evidenceIds: ["evidence-low"],
      })],
    });

    expect(result.hits).toEqual([]);
    expect(result.filtered).toEqual([
      expect.objectContaining({
        candidateId: "low-candidate",
        authoritativeRecordId: "low",
        filteredReason: "score_below_threshold",
      }),
    ]);
  });

  test.each([
    {
      name: "missing evidence refs",
      candidate: candidate({ source: "tree", nodeType: "tree", evidenceIds: [] }),
      hydrated: hydration(),
      reason: "evidence_unavailable",
    },
    {
      name: "missing hydration",
      candidate: candidate({ source: "tree", nodeType: "tree" }),
      hydrated: undefined,
      reason: "hydration_unavailable",
    },
    {
      name: "evidence mismatch",
      candidate: candidate({ source: "tree", nodeType: "tree", evidenceIds: ["other"] }),
      hydrated: hydration(),
      reason: "evidence_unavailable",
    },
    {
      name: "missing score signal",
      candidate: candidate({ source: "tree", nodeType: "tree", relevance: undefined }),
      hydrated: hydration(),
      reason: "score_breakdown_unavailable",
    },
  ])("tree fail-closed: $name", async ({ candidate: tree, hydrated, reason }) => {
    const { engine } = engineFor({ "memory-a": hydrated });

    const result = await engine.retrieve({ intent: "context", scope, candidates: [tree] });

    expect(result.hits).toEqual([]);
    expect(result.filtered).toEqual([
      expect.objectContaining({ candidateId: tree.candidateId, filteredReason: reason }),
    ]);
  });
});
