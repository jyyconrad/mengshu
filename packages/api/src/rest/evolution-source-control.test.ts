import { describe, expect, test, vi } from "vitest";
import { createRestRouter } from "./router.js";
import { buildEvolutionTools } from "../../../mcp/src/evolution-tools.js";
import { assertEvolutionOwnerRequest } from "../evolution-owner-auth.js";
import type { EvolutionBatchCapability } from "../evolution.js";

const authority = { tenantId: "tenant", userId: "owner", allow: { appIds: ["app"], projectIds: ["project"],
  agentIds: ["agent"], namespaces: ["memories"], visibilities: ["private" as const] } };
const secret = "owner-only-fixture-credential-not-real";
const hash = "a".repeat(64);
const request = { statement: { issuer: "verifier", scopeFingerprint: hash, evidenceId: "evidence", sourceId: "source", revision: "r1",
  snapshotHash: hash, rootEvidenceId: "root", origin: "external", trust: "verified_document", authorizedTargetRefs: [], issuedAt: 1, expiresAt: 1000 },
  signature: "a".repeat(86), expectedRevision: 0, idempotencyKey: "issue-1" };

describe("signed source trust control transport", () => {
  test("only owner receives strict signed-source tools; generic host-state proof injection has no route", async () => {
    const issue = vi.fn(async () => { assertEvolutionOwnerRequest(authority); return { id: "receipt-1", kind: "source_attestation" as const,
      entryId: "evidence", operation: "put" as const, revision: 1, valueHash: hash, createdAt: 1 }; });
    const capability = { sourceControl: { issueSourceAttestation: issue, revokeSourceAttestation: issue } } as unknown as EvolutionBatchCapability;
    const tools = buildEvolutionTools(capability);
    const router = createRestRouter({ service: {} as never, authority, evolutionOwnerSecret: secret,
      continuousMemoryEvolution: capability, runtimeControl: {} as never,
      runtimeMcp: { listTools: () => tools, callTool: async (name, args) => tools.find(tool => tool.name === name)!.execute(args) } });
    const post = (operation: string, body: unknown, owner = true) => router.handle({ method: "POST", path: `/v1/evolution/${operation}`,
      headers: owner ? { "x-mengshu-owner-token": secret } : {}, body });
    expect((await post("source/attest", request, false)).status).toBe(403);
    expect(issue).not.toHaveBeenCalled();
    expect((await post("source/attest", { ...request, scope: authority })).status).toBe(400);
    expect((await post("source/attest", { ...request, statement: { ...request.statement, path: "/private" } })).status).toBe(400);
    expect((await post("source/attest", request)).status).toBe(200);
    expect(issue).toHaveBeenCalledExactlyOnceWith(request);
    for (const operation of ["state/put", "paired_evaluation", "compatibility_binding", "skill_draft_gate"]) {
      expect((await post(operation, { accepted: true, reportHash: hash })).status).toBe(404);
    }
    const ordinary = await router.handle({ method: "GET", path: "/v1/runtime/mcp-tools", headers: {} });
    expect(JSON.stringify(ordinary.body)).not.toContain("memory_evolution_source_");
    const owner = await router.handle({ method: "GET", path: "/v1/runtime/mcp-tools", headers: { "x-mengshu-owner-token": secret } });
    expect(JSON.stringify(owner.body)).toContain("memory_evolution_source_attest");
    expect((await router.handle({ method: "POST", path: "/v1/runtime/mcp-call", headers: {}, body: { name: "memory_evolution_source_attest", arguments: request } })).status).toBe(403);
  });
});
