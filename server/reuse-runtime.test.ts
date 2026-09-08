import { afterEach, describe, expect, test, vi } from "vitest";
import { AgentFastPathService } from "../packages/api/src/agent-fast-path/index.js";
import type { AuthorityScope } from "../packages/core/src/domain/authority-scope.js";
import type { MemoryRecord, MemoryScope, RecallHit } from "../packages/core/src/domain/types.js";
import type { EvolutionHostStatePort } from "./evolution-host-state.js";
import { createHostReuseRuntime, createHostReuseRuntimeRouter } from "./reuse-runtime.js";
import type { ExplicitReuseReadOptions } from "../packages/core/src/evolution/reuse/reuse-read-access.js";
import type { AgentLoadout, LoadoutAssetCandidate } from "../packages/core/src/loadout/types.js";
import { GovernedRetrievalEngine, type GovernedRetrievalHydrationRequest, type GovernedRetrievalSource } from "../packages/core/src/retrieval/governed-retrieval-engine.js";
import { requireRecallHitReceipt, requireLookupResultReceipts } from "../packages/core/src/domain/recall-receipt-validation.js";
import { fuseHits } from "../packages/core/src/retrieval/fusion.js";

afterEach(() => vi.restoreAllMocks());

const source: MemoryScope = { tenantId: "t", userId: "u", appId: "codex", projectId: "p",
  agentId: "codex", namespace: "memory", visibility: "private" };
const target: MemoryScope = { ...source, appId: "openclaw", agentId: "openclaw" };
const authority: AuthorityScope = { tenantId: "t", userId: "u", allow: {
  appIds: ["codex", "openclaw"], projectIds: ["p"], agentIds: ["codex", "openclaw"],
  namespaces: ["memory"], visibilities: ["private"],
} };
const now = Date.parse("2026-09-06T00:00:00Z");
const original: MemoryRecord = { id: "m", scope: source, kind: "fact", semanticType: "resource",
  text: "Verified canonical text.", contentHash: "a".repeat(64), importance: 0.9, confidence: 0.9,
  category: "fact", dataType: "memory", lifecycleStatus: "active", createdAt: now,
  metadata: { admissionRoute: "active", contextEligible: true }, provenance: { source: "user" },
  sourceNodeIds: ["e"],
};

function fixture(options: { sameScope?: boolean; signals?: Partial<Record<GovernedRetrievalSource, number>>; lookupOnly?: boolean } = {}) {
  let clock = now;
  let revision = 1;
  let record = structuredClone(original);
  if (options.sameScope) record.scope = { ...target };
  if (options.lookupOnly) {
    record.lifecycleStatus = "archived";
    record.container = "session_candidate";
    record.metadata = { admissionRoute: "lookup_only", contextEligible: false };
  }
  let grants = options.sameScope ? [] : [{ id: "grant", sourceScope: source, targetScope: target, claimKinds: ["fact"],
    notBefore: "2026-09-05T00:00:00.000Z", expiresAt: "2026-09-07T00:00:00.000Z" }];
  const state = { scope: target, authority,
    read: async () => ({ revision, value: { grants } }),
    list: async () => ({ entries: [], revision: String(revision) }),
  } as unknown as EvolutionHostStatePort;
  const signals = options.signals ?? { bm25: 0.9 };
  const candidateSource = vi.fn((_options: ExplicitReuseReadOptions) => ({ search: async () =>
    (Object.entries(signals) as [GovernedRetrievalSource, number][]).map(([retrievalSource, relevance]) => ({ candidateId: `c:${retrievalSource}`, scope: record.scope,
      authoritativeRecordId: "m", evidenceIds: ["e"], source: retrievalSource, nodeType: "memory" as const, relevance })) }));
  const hydrate = vi.fn(async (_candidate: GovernedRetrievalHydrationRequest) => ({ record: structuredClone(record), evidenceIds: ["e"] }));
  const hydrator = vi.fn((_options: ExplicitReuseReadOptions) => ({ hydrate }));
  const runtime = createHostReuseRuntime({ authority, boundScope: target, state,
    candidateSource, hydrator, readTarget: async () => undefined, now: () => clock });
  const recall = async () => ({ scope: target, query: "a", hits: (await runtime.readService.lookup({ scope: target, query: "a", limit: 5 })).hits
    .map(hit => ({ ...hit, source: hit.scoreBreakdown.matchedBy[0] })) as RecallHit[] });
  const app = new AgentFastPathService({ defaultScope: target, recall,
    loadRecallHitsForScope: async () => (await recall()).hits,
    readBoundary: runtime.fastPathReadBoundary,
  });
  return { runtime, app, recall, candidateSource, hydrator, hydrate,
    revoke: () => { revision++; grants = []; },
    expire: () => { clock += 86_400_000; },
    hold: () => { record.metadata = { ...record.metadata, governance: {
      candidate: { riskFlags: [] }, evolution: { needsReview: true },
    } }; },
    correct: () => { record = { ...record, text: "Corrected current text.", contentHash: "b".repeat(64) }; },
    revokeSource: () => { record.lifecycleStatus = "revoked"; },
    removeEvidence: () => { record.sourceNodeIds = []; },
  };
}

describe("host-bound reuse runtime", () => {
  describe.each([true, false])("score receipts, same exact scope: %s", sameScope => {
    test.each([
      { vector: 0.9 }, { bm25: 0.8 }, { lexical: 0.7 }, { recent: 0.6 }, { tree: 0.8 },
      { entity_graph: 0.8 }, { work_memory_graph: 0.8 },
      { vector: 0.9, bm25: 0.5 }, { vector: 0, bm25: 1 },
      { vector: 0.6, entity_graph: 0.8, work_memory_graph: 0.7 },
    ])("preserves observed %j signals and returns the new engine receipt unchanged", async signals => {
      const h = fixture({ sameScope, signals });
      const retrieve = vi.spyOn(GovernedRetrievalEngine.prototype, "retrieve");
      const incoming = (await h.recall()).hits;
      expect(incoming).toHaveLength(1);
      const hits = await h.runtime.fastPathReadBoundary.rehydrate(target, incoming, "lookup");
      expect(hits).toHaveLength(1);
      const produced = (await retrieve.mock.results.at(-1)!.value).hits[0]!;
      expect(hits[0].scoreBreakdown).toBe(produced.scoreBreakdown);
      expect(hits[0].score).toBe(produced.score);
      expect(hits[0].source).toBe(produced.scoreBreakdown.matchedBy[0]);
      expect(requireRecallHitReceipt(hits[0])).toBe(produced.scoreBreakdown);
      expect(produced.scoreBreakdown.sourceSignals).toEqual(signals);
      const lookup = await h.app.lookup({ scope: target, query: "a" });
      expect(lookup.hits).toHaveLength(1);
      expect(lookup.hits[0].preview).toBe(original.text);
      expect(requireLookupResultReceipts(lookup)).toBe(lookup);
    });

    test("allows vector lookup-only records without promoting them to context", async () => {
      const h = fixture({ sameScope, signals: { vector: 0.9 }, lookupOnly: true });
      const lookup = await h.app.lookup({ scope: target, query: "a" });
      expect(lookup.hits).toHaveLength(1);
      expect(requireLookupResultReceipts(lookup)).toBe(lookup);
      const context = await h.app.context({ scope: target, task: "a" });
      expect(context.content).not.toContain(original.text);
      expect(context.telemetry.cacheHit).toBe(false);
    });
  });

  test.each([
    { raw: { text: 7.2 }, signals: { lexical: 1 } },
    { raw: { vector: 2 }, signals: { vector: 1 } },
    { raw: { vector: 0.6, text: 7.2 }, signals: { vector: 0.6, lexical: 1 } },
    { raw: { graph: 0.8 }, signals: { lexical: 1 } },
  ])("rehydrates legacy fusion signals %j without inventing retrieval subtypes", async ({ raw, signals }) => {
    const h = fixture();
    const current = (await h.recall()).hits[0]!;
    const incoming = fuseHits((Object.entries(raw) as [RecallHit["source"], number][]).map(([source, score]) => ({
      source, hits: [{ record: current.record, source, score }],
    })), { scope: target });
    expect(requireRecallHitReceipt(incoming[0])).toBe(incoming[0].scoreBreakdown);
    const retrieve = vi.spyOn(GovernedRetrievalEngine.prototype, "retrieve");
    const refreshed = await h.runtime.fastPathReadBoundary.rehydrate(target, incoming, "lookup");
    expect(refreshed).toHaveLength(1);
    const produced = (await retrieve.mock.results.at(-1)!.value).hits[0]!;
    expect(requireRecallHitReceipt(refreshed[0])).toBe(produced.scoreBreakdown);
    expect(produced.scoreBreakdown.sourceSignals).toEqual(signals);
  });

  test.each(["missing", "mismatched_source", "mismatched_score"] as const)("rejects a %s input receipt before hydration", async invalid => {
    const h = fixture({ signals: { vector: 0.9 } });
    const incoming = (await h.recall()).hits[0]!;
    const hit = { ...incoming };
    if (invalid === "missing") delete hit.scoreBreakdown;
    if (invalid === "mismatched_source") hit.source = "text";
    if (invalid === "mismatched_score") hit.score += 0.01;
    h.hydrate.mockClear();
    await expect(h.runtime.fastPathReadBoundary.rehydrate(target, [hit], "lookup"))
      .rejects.toThrow("RECALL_SCORE_BREAKDOWN_REQUIRED");
    expect(h.hydrate).not.toHaveBeenCalled();
  });

  test.each(["revoke", "expire", "hold", "revokeSource", "removeEvidence"] as const)("%s invalidates cached vector hits and their references", async change => {
    const h = fixture({ signals: { vector: 0.9, bm25: 0.5 } });
    const hits = (await h.recall()).hits;
    const refs = hits.map(hit => h.runtime.fastPathReadBoundary.reference(hit));
    const checkpoint = await h.runtime.fastPathReadBoundary.checkpoint(target);
    const app = new AgentFastPathService({ defaultScope: target, recall: async () => ({ scope: target, query: "a", hits }),
      loadRecallHitsForScope: async () => hits, readBoundary: h.runtime.fastPathReadBoundary });
    expect((await app.lookup({ scope: target, query: "a" })).hits).toHaveLength(1);
    h[change]();
    expect((await app.lookup({ scope: target, query: "a" })).hits).toEqual([]);
    expect((await app.context({ scope: target, task: "a" })).content).not.toContain(original.text);
    expect((await app.evidenceRead({ scope: target, refs })).evidence).toEqual([]);
    if (change === "revoke" || change === "expire") expect(await h.runtime.fastPathReadBoundary.revalidate(target, checkpoint)).toBe(false);
  });

  test("rehydrates stale vector cache content and rejects a grant revoked during hydration", async () => {
    const h = fixture({ signals: { vector: 0.9 } });
    const cached = (await h.recall()).hits;
    h.correct();
    const current = await h.runtime.fastPathReadBoundary.rehydrate(target, cached, "lookup");
    expect(current).toHaveLength(1);
    expect((current[0].record as MemoryRecord).text).toBe("Corrected current text.");
    expect(requireRecallHitReceipt(current[0])).toBe(current[0].scoreBreakdown);
    const hydrate = h.hydrate.getMockImplementation()!;
    h.hydrate.mockImplementation(async candidate => { const result = await hydrate(candidate); h.revoke(); return result; });
    expect(await h.runtime.fastPathReadBoundary.rehydrate(target, cached, "lookup")).toEqual([]);
  });

  test("vector lookup keeps exact-ID dereference and navigation behind current grants", async () => {
    const h = fixture({ signals: { vector: 0.9 } });
    const hit = (await h.runtime.readService.lookup({ scope: target, query: "a", limit: 1 })).hits[0]!;
    const reference = h.runtime.readService.reference(hit);
    const ref = h.runtime.fastPathReadBoundary.reference({ ...hit, source: hit.scoreBreakdown.matchedBy[0] });
    const exact = await h.runtime.readService.dereference({ scope: target, reference });
    expect(exact.hits).toHaveLength(1);
    expect(requireRecallHitReceipt({ ...exact.hits[0], source: exact.hits[0].scoreBreakdown.matchedBy[0] }))
      .toBe(exact.hits[0].scoreBreakdown);
    expect(await h.runtime.fastPathReadBoundary.navigate(target, { ref, limit: 1 }))
      .toEqual([expect.objectContaining({ ref, preview: original.text })]);
    h.revoke();
    expect((await h.runtime.readService.dereference({ scope: target, reference })).hits).toEqual([]);
    expect(await h.runtime.fastPathReadBoundary.navigate(target, { ref, limit: 1 })).toEqual([]);
  });

  test("batch evidence return rechecks an earlier canonical record changed while reading a later reference", async () => {
    const h = fixture();
    const first = (await h.runtime.readService.lookup({ scope: target, query: "a", limit: 1 })).hits[0]!;
    const refs = [first.record, { ...first.record, id: "second" }].map(record =>
      h.runtime.fastPathReadBoundary.reference({ ...first, record, source: "text" }));
    const hydrate = h.hydrate.getMockImplementation()!;
    h.hydrate.mockImplementation(async candidate => {
      if (candidate.authoritativeRecordId === "second") {
        h.hold();
        return { record: { ...structuredClone(original), id: "second" }, evidenceIds: ["e"] };
      }
      return hydrate(candidate);
    });
    await expect(h.app.evidenceRead({ scope: target, refs })).rejects.toThrow("REUSE_READ_CHANGED");
  });
  test("a Skill revoked after Loadout assembly cannot survive the context return boundary", async () => {
    const h = fixture();
    const hit = (await h.runtime.readService.lookup({ scope: target, query: "a", limit: 1 })).hits[0]!;
    const loadout: AgentLoadout = { id: "loadout", scope: { ...target, visibility: "private" }, appId: target.appId, agentId: target.agentId,
      projectId: target.projectId, version: 1, visibility: "private", createdAt: "2026-09-05T00:00:00.000Z",
      updatedAt: "2026-09-05T00:00:00.000Z", slotBindings: [{ assetId: "skill", assetKind: "skill",
        slot: "experience", disclosureMode: "must_read", priority: 1, required: true }],
      nativeMemoryPolicy: { semanticTypes: ["resource", "experience"], scopeReuse: "project_only", treeDepth: "topic",
        tokenBudgets: { profile: 500, task_context: 500, rules: 500, resource: 500, experience: 500 } } };
    let asset: LoadoutAssetCandidate = { assetId: "skill", assetVersion: 1, assetKind: "skill", status: "published",
      contentValidity: "current", scope: target, semanticTypes: ["experience"], recordId: "skill",
      content: "Previously reviewed Skill.", evidenceRefs: ["e"], lifecycleEligible: true,
      riskBlocked: false, conflictUnresolved: false, score: hit.score, scoreBreakdown: hit.scoreBreakdown,
      recallSource: "text", tokenEstimate: 10 };
    const app = new AgentFastPathService({ defaultScope: target, readBoundary: h.runtime.fastPathReadBoundary,
      recall: async () => ({ scope: target, query: "a", hits: [] }),
      loadRecallHitsForScope: async () => [{ ...hit, source: "text" }], resolveLoadout: async () => loadout,
      resolveLoadoutAssetCandidates: async () => [asset], knowledgeResources: { index: async () => {
        asset = { ...asset, status: "revoked", lifecycleEligible: false };
        throw new Error("optional unavailable");
      } } });
    await expect(app.context({ scope: target, task: "a" })).rejects.toThrow("REUSE_READ_CHANGED");
  });
  test("router preserves authorized second-project API access without sharing project state or accepting source identity", async () => {
    const second = { ...target, projectId: "second" };
    const hostAuthority = { ...authority, allow: { ...authority.allow, projectIds: ["p", "second"] } };
    const stateForScope = vi.fn((bound: MemoryScope) => ({ scope: bound, authority: hostAuthority,
      read: async () => undefined, list: async () => ({ entries: [], revision: "0" }),
    } as unknown as EvolutionHostStatePort));
    const router = createHostReuseRuntimeRouter({ authority: hostAuthority, boundScope: target, stateForScope,
      readTarget: async () => undefined,
      candidateSource: (_options, bound) => ({ search: async () => [{ candidateId: `candidate-${bound.projectId}`,
        authoritativeRecordId: `m-${bound.projectId}`, scope: bound, evidenceIds: ["e"], source: "bm25", nodeType: "memory", relevance: 1 }] }),
      hydrator: (_options, bound) => ({ hydrate: async () => ({ record: { ...original, scope: bound,
        id: `m-${bound.projectId}`, text: `Only ${bound.projectId}.` }, evidenceIds: ["e"] }) }), now: () => now });
    const app = new AgentFastPathService({ defaultScope: target, readBoundary: router.fastPathReadBoundary,
      recall: async (scope, query) => ({ scope, query, hits: (await router.readService.lookup({ scope, query, limit: 5 })).hits
        .map(hit => ({ ...hit, source: "text" })) }),
      loadRecallHitsForScope: async (scope, query) => (await router.readService.lookup({ scope, query, limit: 5 })).hits
        .map(hit => ({ ...hit, source: "text" })),
    });
    expect((await app.lookup({ scope: second, query: "a" })).hits[0]?.preview).toBe("Only second.");
    expect((await app.context({ scope: target, task: "a" })).content).not.toContain("Only second.");
    expect((await app.context({ scope: second, task: "a" })).content).not.toContain("Only p.");
    expect(router.forScope(second)).not.toBe(router.forScope(target));
    expect(router.forScope(second)).toBe(router.forScope(second));
    const checkpoint = await router.fastPathReadBoundary.checkpoint(target);
    expect(await router.fastPathReadBoundary.revalidate(second, checkpoint)).toBe(false);
    for (const forbidden of [{ ...second, projectId: "outside" }, { ...second, appId: source.appId },
      { ...second, agentId: source.agentId }, { ...second, userId: "another-owner" }]) {
      await expect(app.lookup({ scope: forbidden, query: "a" })).rejects.toThrow();
    }
    expect(stateForScope.mock.calls.map(([bound]) => bound.projectId).sort()).toEqual(["p", "second"]);
  });
  test("constructs source/hydrator/engine with one authority and rejects client source switching", async () => {
    const h = fixture();
    expect(h.candidateSource.mock.calls[0]?.[0]).toBe(h.runtime.readOptions);
    expect(h.hydrator.mock.calls[0]?.[0]).toBe(h.runtime.readOptions);
    expect(h.runtime.fastPathReadBoundary.resolveScope({})).toEqual(target);
    for (const scope of [source, { ...target, userId: "other" }, { ...target, namespace: "other" }]) {
      await expect(h.app.lookup({ scope, query: "a" })).rejects.toThrow("REUSE_HOST_SCOPE_MISMATCH");
      await expect(h.runtime.readService.lookup({ scope, query: "a", limit: 1 })).rejects.toThrow();
    }
  });
  test.each(["revoke", "expire", "hold"] as const)("%s invalidates context/lookup/explain/ref/cache", async change => {
    const h = fixture();
    const first = await h.app.context({ scope: target, task: "a" });
    expect(first.content).toContain(original.text);
    expect(first.telemetry.cacheHit).toBe(false);
    const lookup = await h.app.lookup({ scope: target, query: "a" });
    const token = lookup.hits[0]!.evidence[0]!.id;
    expect((await h.app.evidenceRead({ scope: target, refs: [token] })).evidence).toHaveLength(1);
    const cached = await h.runtime.readService.lookup({ scope: target, query: "a", limit: 1 });
    const reference = h.runtime.readService.reference(cached.hits[0]!);
    h[change]();
    expect((await h.app.context({ scope: target, task: "a" })).content).not.toContain(original.text);
    expect((await h.app.lookup({ scope: target, query: "a" })).hits).toEqual([]);
    expect((await h.app.evidenceRead({ scope: target, refs: [token] })).evidence).toEqual([]);
    expect((await h.runtime.readService.explain({ scope: target, reference })).hits).toEqual([]);
    expect((await h.runtime.readService.readCached({ scope: target, references: [reference] })).hits).toEqual([]);
  });
  test("context rehydrates canonical records even when a caller returns cached RecallHits", async () => {
    const h = fixture();
    const cached = (await h.runtime.readService.lookup({ scope: target, query: "a", limit: 1 })).hits
      .map(hit => ({ ...hit, source: "text" })) as RecallHit[];
    const app = new AgentFastPathService({ defaultScope: target, recall: async () => ({ scope: target, query: "a", hits: cached }),
      loadRecallHitsForScope: async () => cached, readBoundary: h.runtime.fastPathReadBoundary });
    h.correct();
    const response = await app.context({ scope: target, task: "a" });
    expect(response.content).toContain("Corrected current text.");
    expect(response.content).not.toContain(original.text);
  });
  test("read-time holds and revocation cannot leak through optional overlays or raw evidence adapters", async () => {
    const h = fixture();
    const cached = (await h.runtime.readService.lookup({ scope: target, query: "a", limit: 1 })).hits
      .map(hit => ({ ...hit, source: "text" })) as RecallHit[];
    const readEvidence = vi.fn(async () => [{ ref: "e", preview: "untrusted", source: "memory" as const }]);
    const app = new AgentFastPathService({ defaultScope: target, recall: async () => ({ scope: target, query: "a", hits: cached }),
      loadRecallHitsForScope: async () => cached, readBoundary: h.runtime.fastPathReadBoundary,
      knowledgeResources: { index: async () => { h.hold(); throw new Error("optional unavailable"); } },
      readEvidence,
    });
    await expect(app.context({ scope: target, task: "a" })).rejects.toThrow("REUSE_READ_CHANGED");
    await expect(app.evidenceRead({ scope: target, refs: ["e"] })).rejects.toThrow("REUSE_REFERENCE_INVALID");
    expect(readEvidence).not.toHaveBeenCalled();
  });
});
