import { computeCanonicalContentHash } from "../scoring/hash-utils.js";
import type { AuthorityScope } from "../domain/authority-scope.js";
import type { MemoryScope } from "../domain/types.js";
import type { EvolutionInputPort, EvolutionInputUnit, EvolutionProposalDraft } from "./types.js";

export const scope: MemoryScope = { tenantId: "tenant", userId: "user", appId: "app", projectId: "project", agentId: "agent", namespace: "memory", visibility: "private" };
export const authority: AuthorityScope = { tenantId: scope.tenantId, userId: scope.userId, allow: { appIds: ["app"], projectIds: ["project"], agentIds: ["agent"], namespaces: ["memory"], visibilities: ["private"] } };
export function unit(id = "unit-1", text = "The project database runs PostgreSQL 16."): EvolutionInputUnit {
  return { id, scope, snapshotHash: computeCanonicalContentHash(text), targets: [], evidence: [{ id: `evidence-${id}`, sourceId: "source", revision: "r1", snapshotHash: computeCanonicalContentHash(text), text, scope, rootEvidenceId: `root-${id}`, origin: "external", trust: "verified_document", occurredAt: 100 }] };
}
export function draft(input: EvolutionInputUnit): EvolutionProposalDraft {
  const e = input.evidence[0];
  return { operation: "create", claimClass: "fact", reasonCode: "new_claim", targetRefs: [], quotes: [{ evidenceId: e.id, quote: e.text, start: 0, end: e.text.length }], proposedText: e.text, kind: "fact" };
}
export function inputPort(units: EvolutionInputUnit[]): EvolutionInputPort {
  return {
    mode: "inventory",
    async open() { return { selectionEpoch: 100 }; },
    async readPage({ cursor }) {
      const index = typeof cursor === "number" ? cursor : 0;
      return { units: units.slice(index, index + 1), nextCursor: index + 1, complete: index + 1 >= units.length, bytesRead: units[index] ? Buffer.byteLength(units[index].evidence[0].text) : 0, filesRead: 0 };
    },
    async verifyUnit() { return { valid: true }; },
    async readTargets(refs) { return units.flatMap(u => u.targets).filter(t => refs.some(r => r.memoryId === t.memoryId)); },
  };
}
