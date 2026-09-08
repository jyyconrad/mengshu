import { describe, expect, test, vi } from "vitest";
import type { AuthorityScope } from "../../domain/authority-scope.js";
import type { MemoryRecord, MemoryScope } from "../../domain/types.js";
import { GovernedRetrievalEngine, type GovernedRetrievalCandidate } from "../../retrieval/governed-retrieval-engine.js";
import { HostManagedReuseAuthorizer, type HostReuseState } from "./explicit-reuse-authorizer.js";
import { GovernedReuseReadService } from "./governed-reuse-read-service.js";
import type { ReuseTargetCompatibility } from "./reuse-read-access.js";

const sourceScope: MemoryScope = {
  tenantId: "tenant-a", userId: "user-a", appId: "codex", agentId: "codex-agent",
  projectId: "project-a", namespace: "memory", visibility: "private",
};
const targetScope: MemoryScope = { ...sourceScope, appId: "openclaw", agentId: "openclaw-agent" };
const authority: AuthorityScope = {
  tenantId: "tenant-a", userId: "user-a", allow: {
    appIds: ["codex", "openclaw"], projectIds: ["project-a"],
    agentIds: ["codex-agent", "openclaw-agent"], namespaces: ["memory"], visibilities: ["private"],
  },
};
const memory: MemoryRecord = {
  id: "memory-a", scope: sourceScope, kind: "fact", semanticType: "resource", lifecycleStatus: "active",
  text: "A verified source claim.", contentHash: "a".repeat(64), importance: 0.9, confidence: 0.9,
  category: "fact", dataType: "memory", metadata: { admissionRoute: "active", contextEligible: true },
  provenance: { source: "user" }, sourceNodeIds: ["evidence-a"], createdAt: 1,
};
const candidate: GovernedRetrievalCandidate = {
  candidateId: "candidate-a", authoritativeRecordId: memory.id, scope: sourceScope,
  nodeType: "memory", source: "bm25", relevance: 0.9, evidenceIds: ["evidence-a"],
};

function setup(reuseCompatibility?: ReuseTargetCompatibility) {
  let record = memory;
  let clock = Date.parse("2026-09-06T00:00:00Z");
  let state: HostReuseState = { authority, revision: "1", grants: [{
    id: "share-a", sourceScope, targetScope, claimKinds: ["fact"],
    notBefore: "2026-09-01T00:00:00.000Z", expiresAt: "2026-09-07T00:00:00.000Z",
  }] };
  const authorizer = new HostManagedReuseAuthorizer({ read: async () => state }, () => clock);
  const hydrate = vi.fn(async () => ({ record, evidenceIds: ["evidence-a"] }));
  const engine = new GovernedRetrievalEngine({ hydrate }, { reuseAuthorizer: authorizer, reuseCompatibility });
  const service = new GovernedReuseReadService({ search: async () => [candidate] }, engine);
  return { engine, service, hydrate,
    revoke: () => { state = { ...state, revision: "2", grants: [] }; },
    expire: () => { clock = Date.parse("2026-09-07T00:00:00Z"); },
    disallowKind: () => { state = { ...state, revision: "2", grants: state.grants.map((grant) =>
      ({ ...grant, claimKinds: ["decision"] })) }; },
    record: (value: MemoryRecord) => { record = value; },
  };
}

describe("governed explicit reuse read boundaries", () => {
  test.each(["disputed", "needsReview"])("evolution %s blocks every ordinary read even with valid evidence", async (flag) => {
    const h = setup();
    const original = await h.service.lookup({ scope: targetScope, query: "verified", limit: 5 });
    const reference = h.service.reference(original.hits[0]!);
    for (const value of [true, "true", null]) {
      h.record({ ...memory, metadata: { ...memory.metadata, governance: {
        candidate: { riskFlags: [] }, evolution: { [flag]: value },
      } } });
      for (const scope of [sourceScope, targetScope]) {
        expect((await h.engine.retrieve({ intent: "context", scope, candidates: [candidate] })).hits).toEqual([]);
        expect((await h.service.lookup({ scope, query: "verified", limit: 5 })).hits).toEqual([]);
        expect((await h.service.explain({ scope, reference })).hits).toEqual([]);
        expect((await h.service.dereference({ scope, reference })).hits).toEqual([]);
        expect((await h.service.readCached({ scope, references: [reference] })).hits).toEqual([]);
      }
    }
  });
  test("identical text in different authorized source scopes does not collapse their canonical identities", async () => {
    const first = { ...memory, semanticType: "rules" as const };
    const second = { ...first, id: "memory-b", scope: { ...sourceScope, projectId: "project-b" } };
    const engine = new GovernedRetrievalEngine({ hydrate: async ({ authoritativeRecordId }) => ({
      record: authoritativeRecordId === first.id ? first : second, evidenceIds: ["evidence-a"],
    }) });
    const result = await engine.retrieve({ intent: "lookup", scope: sourceScope, candidates: [candidate,
      { ...candidate, candidateId: "candidate-b", authoritativeRecordId: second.id, scope: second.scope },
    ] });
    expect(result.hits.map((hit) => hit.record.id).sort()).toEqual(["memory-a", "memory-b"]);
    expect(result.hits.map((hit) => hit.record.scope.projectId).sort()).toEqual(["project-a", "project-b"]);
  });

  test("enabled target compatibility gates experience for native and explicitly granted scopes", async () => {
    let compatible = true;
    const h = setup({ allows: async () => compatible });
    h.record({ ...memory, semanticType: "experience" });
    for (const scope of [sourceScope, targetScope]) {
      expect((await h.engine.retrieve({ intent: "context", scope, candidates: [candidate] })).hits).toHaveLength(1);
    }
    compatible = false;
    for (const scope of [sourceScope, targetScope]) {
      expect((await h.engine.retrieve({ intent: "context", scope, candidates: [candidate] })).hits).toEqual([]);
    }
    const failing = setup({ allows: async () => { throw new Error("unavailable"); } });
    failing.record({ ...memory, semanticType: "experience" });
    expect((await failing.engine.retrieve({ intent: "context", scope: targetScope, candidates: [candidate] })).hits).toEqual([]);
  });

  test.each(["revoke", "expire", "disallowKind"] as const)("%s blocks lookup, explain, reference and cache boundaries", async (deny) => {
    const h = setup();
    const original = await h.service.lookup({ scope: targetScope, query: "verified", limit: 5 });
    const reference = h.service.reference(original.hits[0]!);
    h[deny]();
    expect((await h.service.lookup({ scope: targetScope, query: "verified", limit: 5 })).hits).toEqual([]);
    expect((await h.service.explain({ scope: targetScope, reference })).hits).toEqual([]);
    expect((await h.service.dereference({ scope: targetScope, reference })).hits).toEqual([]);
    expect((await h.service.readCached({ scope: targetScope, references: [reference] })).hits).toEqual([]);
  });

  test("rejects malformed or unbounded references without returning former content", async () => {
    const h = setup();
    await expect(h.service.readCached({ scope: targetScope, references: Array(501).fill({}) })).rejects.toThrow();
    await expect(h.service.dereference({ scope: targetScope, reference: {} as never })).rejects.toThrow();
  });

  test("default no-grant behavior remains denied", async () => {
    const result = await new GovernedRetrievalEngine({
      hydrate: async () => ({ record: memory, evidenceIds: ["evidence-a"] }),
    }).retrieve({ intent: "lookup", scope: targetScope, candidates: [candidate] });
    expect(result.hits).toEqual([]);
  });

  test("lookup/context/explain/reference/cache use original producer scope and fresh hydration", async () => {
    const h = setup();
    const result = await h.service.lookup({ scope: targetScope, query: "verified", limit: 5 });
    expect(result.hits[0]?.record.scope).toEqual(sourceScope);
    const reference = h.service.reference(result.hits[0]!);
    expect(JSON.stringify(reference)).not.toContain(memory.text);
    expect((await h.service.explain({ scope: targetScope, reference })).hits).toHaveLength(1);
    expect((await h.service.dereference({ scope: targetScope, reference })).hits).toHaveLength(1);
    expect((await h.service.readCached({ scope: targetScope, references: [reference] })).hits).toHaveLength(1);
    h.revoke();
    for (const result of [
      await h.service.explain({ scope: targetScope, reference }),
      await h.service.dereference({ scope: targetScope, reference }),
      await h.service.readCached({ scope: targetScope, references: [reference] }),
      await h.service.lookup({ scope: targetScope, query: "verified", limit: 5 }),
    ]) expect(result.hits).toEqual([]);
  });

  test("raw candidate claims cannot change scope, claim kind, lifecycle, or evidence", async () => {
    const h = setup();
    for (const altered of [
      { ...memory, scope: { ...sourceScope, userId: "other" } },
      { ...memory, kind: "decision" as const },
      { ...memory, lifecycleStatus: "revoked" as const },
      { ...memory, sourceNodeIds: ["unproven"] },
      { ...memory, semanticType: "experience" as const },
    ]) {
      h.record(altered);
      expect((await h.engine.retrieve({ intent: "context", scope: targetScope, candidates: [candidate] })).hits)
        .toEqual([]);
    }
  });

  test("canonical revisions and revoked evidence replace or remove cached content", async () => {
    const h = setup();
    const original = await h.service.lookup({ scope: targetScope, query: "verified", limit: 5 });
    const reference = h.service.reference(original.hits[0]!);
    h.record({ ...memory, text: "Updated current claim.", contentHash: "b".repeat(64) });
    const refreshed = await h.service.readCached({ scope: targetScope, references: [reference] });
    expect(refreshed.hits[0]?.record.text).toBe("Updated current claim.");
    h.record({ ...memory, lifecycleStatus: "revoked" });
    expect((await h.service.readCached({ scope: targetScope, references: [reference] })).hits).toEqual([]);
  });

  test("revocation during asynchronous hydration cannot return the former claim", async () => {
    const h = setup();
    h.hydrate.mockImplementationOnce(async () => { h.revoke(); return { record: memory, evidenceIds: ["evidence-a"] }; });
    expect((await h.engine.retrieve({ intent: "lookup", scope: targetScope, candidates: [candidate] })).hits).toEqual([]);
  });
});
