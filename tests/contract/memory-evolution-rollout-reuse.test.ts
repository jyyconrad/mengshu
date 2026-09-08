import { describe, expect, test, vi } from "vitest";
import { computeCanonicalContentHash } from "../../packages/core/src/scoring/hash-utils.js";
import { HostManagedReuseAuthorizer, type HostReuseState } from "../../packages/core/src/evolution/reuse/explicit-reuse-authorizer.js";
import { GovernedReuseReadService } from "../../packages/core/src/evolution/reuse/governed-reuse-read-service.js";
import { GovernedRetrievalEngine } from "../../packages/core/src/retrieval/governed-retrieval-engine.js";
import { PostgresGovernedRetrievalHydrator, type PostgresGovernedRetrievalHydrationClient } from "../../packages/core/src/retrieval/postgres-governed-retrieval-hydrator.js";
import { EVIDENCE_ID, MEMORY_ID, evidenceRow, memoryRow, retrievalCandidate } from "../fixtures/memory-evolution/known-records.js";
import { ROLLOUT_AUTHORITY, ROLLOUT_NOW, ROLLOUT_SCOPE, SCOPE_DENIALS } from "../fixtures/memory-evolution-rollout/source-corpus.js";

function reuseFixture() {
  const sourceScope = ROLLOUT_SCOPE;
  const targetScope = { ...sourceScope, appId: "claude-code" };
  let now = ROLLOUT_NOW;
  let state: HostReuseState = { authority: ROLLOUT_AUTHORITY, revision: "granted-v1", grants: [{
    id: "rollout-explicit-fact", sourceScope, targetScope, claimKinds: ["fact"],
    notBefore: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
  }] };
  const raw = evidenceRow(sourceScope);
  const canonical = { ...memoryRow(), tenant_id: sourceScope.tenantId, user_id: sourceScope.userId, app_id: sourceScope.appId,
    project_id: sourceScope.projectId, agent_id: sourceScope.agentId, namespace: sourceScope.namespace,
    visibility: sourceScope.visibility, workspace_id: sourceScope.workspaceId, session_id: sourceScope.sessionId,
    category: "fact", text: "The audit retention is 30 days.",
    content_hash: computeCanonicalContentHash("The audit retention is 30 days."),
    metadata: { admissionRoute: "active", contextEligible: true, semanticType: "resource", memoryContainer: "project",
      sourceNodeIds: [EVIDENCE_ID], confidence: 0.72, valueScore: 0.92, riskFlags: [],
      governance: { commandType: "observeAuto", evidenceIds: [EVIDENCE_ID],
        candidate: { evidence: { eventIds: [EVIDENCE_ID] }, riskFlags: [], targetScope: "project" },
        provenance: { source: "user", sourceId: "rollout-original-source", sessionId: sourceScope.sessionId },
        native: { kind: "fact", semanticType: "resource", category: "fact", dataType: "memory" } } },
  };
  let afterCanonicalRead: (() => void) | undefined;
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("WITH direct_evidence")) return { rows: [structuredClone(raw)], rowCount: 1 };
    if (sql.includes("FROM memories")) {
      afterCanonicalRead?.();
      return { rows: [structuredClone(canonical)], rowCount: 1 };
    }
    throw new Error("unexpected_hydration_query");
  });
  const authorizer = new HostManagedReuseAuthorizer({ read: async () => state }, () => now);
  // SQL transport is synthetic; the PG decoder, original-evidence checks and all reuse gates are real.
  const hydrator = new PostgresGovernedRetrievalHydrator({ query: query as PostgresGovernedRetrievalHydrationClient["query"] }, { reuseAuthorizer: authorizer });
  const engine = new GovernedRetrievalEngine(hydrator, { reuseAuthorizer: authorizer });
  const service = new GovernedReuseReadService({ search: async () => [retrievalCandidate(sourceScope)] }, engine);
  const revoke = () => { state = { ...state, revision: "revoked-v2", grants: [] }; };
  return { sourceScope, targetScope, service, query, canonical, raw, authorizer, revoke,
    expire: () => { now += 60_001; }, revokeDuringHydration: () => { afterCanonicalRead = revoke; } };
}

describe("E4 independent reuse/hydration composition (fixture SQL, not live PG)", () => {
  test("explicit grant reads original scope through all four paths, then revocation invalidates cached references", async () => {
    const h = reuseFixture();
    const first = await h.service.lookup({ scope: h.targetScope, query: "audit retention", limit: 5 });
    expect(first.hits).toHaveLength(1);
    expect(first.hits[0].record).toMatchObject({ id: MEMORY_ID, scope: h.sourceScope, sourceNodeIds: [EVIDENCE_ID] });
    const reference = h.service.reference(first.hits[0]);
    expect(JSON.stringify(reference)).not.toContain(h.canonical.text);
    const reads = () => [
      () => h.service.lookup({ scope: h.targetScope, query: "audit", limit: 5 }),
      () => h.service.explain({ scope: h.targetScope, reference }),
      () => h.service.dereference({ scope: h.targetScope, reference }),
      () => h.service.readCached({ scope: h.targetScope, references: [reference] }),
    ];
    for (const read of reads()) expect((await read()).hits).toHaveLength(1);
    h.revoke();
    for (const read of reads()) expect((await read()).hits).toEqual([]);
  });

  test("expiry and a revoke during actual hydrator awaits cannot return old authorized content", async () => {
    for (const mode of ["expire", "during-hydration"] as const) {
      const h = reuseFixture();
      if (mode === "expire") h.expire();
      else h.revokeDuringHydration();
      expect((await h.service.lookup({ scope: h.targetScope, query: "audit", limit: 5 })).hits).toEqual([]);
    }
  });

  test.each(SCOPE_DENIALS.filter(item => item.name !== "app-without-grant"))("$name cannot use another scope's grant", async ({ scope }) => {
    const h = reuseFixture();
    const result = await h.service.lookup({ scope: { ...scope, appId: "claude-code" }, query: "audit", limit: 5 });
    expect(result.hits).toEqual([]);
    expect(h.query).not.toHaveBeenCalled();
  });

  test("an authorized canonical row cannot launder foreign original evidence or an ungranted claim kind", async () => {
    for (const mutate of ["evidence-owner", "kind"] as const) {
      const h = reuseFixture();
      if (mutate === "evidence-owner") h.raw.user_id = "foreign-owner";
      else h.canonical.metadata.governance.native.kind = "decision";
      expect((await h.service.lookup({ scope: h.targetScope, query: "audit", limit: 5 })).hits).toEqual([]);
    }
  });
});
