import { describe, expect, test, vi } from "vitest";
import { createRestRouter } from "./router.js";
import { buildEvolutionTools } from "../../../mcp/src/evolution-tools.js";
import { assertEvolutionOwnerRequest } from "../evolution-owner-auth.js";
import type { EvolutionBatchCapability } from "../evolution.js";

const authority = { tenantId: "tenant", userId: "owner", allow: { appIds: ["app"], projectIds: ["project"],
  agentIds: ["agent"], namespaces: ["memories"], visibilities: ["private" as const] } };
const secret = "owner-only-fixture-credential-not-real";

describe("host-bound reuse control transport", () => {
  test("owner-only grants are typed and evaluator receives only a registered plan identifier", async () => {
    const evaluate = vi.fn(async () => { assertEvolutionOwnerRequest(authority);
      return { status: "blocked" as const, reason: "evaluation_not_registered", publishAllowed: false as const, executionAllowed: false as const }; });
    const replace = vi.fn(async () => { assertEvolutionOwnerRequest(authority); return { receiptId: "receipt", revision: 1, valueHash: "a".repeat(64) }; });
    const capability = { reuse: { evaluate, replaceGrants: replace, status: async () => {
      assertEvolutionOwnerRequest(authority); return { grantsRevision: 0, grantIds: [] };
    } } } as unknown as EvolutionBatchCapability;
    const tools = buildEvolutionTools(capability);
    const router = createRestRouter({ service: {} as never, authority, evolutionOwnerSecret: secret,
      continuousMemoryEvolution: capability, runtimeControl: {} as never,
      runtimeMcp: { listTools: () => tools, callTool: async (name, args) => tools.find(tool => tool.name === name)!.execute(args) } });
    const post = (operation: string, body: unknown, owner = true) => router.handle({ method: "POST", path: `/v1/evolution/reuse/${operation}`,
      headers: owner ? { "x-mengshu-owner-token": secret } : {}, body });
    expect((await post("evaluate", { planId: "one" }, false)).status).toBe(403);
    expect(evaluate).not.toHaveBeenCalled();
    for (const extra of [{ model: "other" }, { path: "/private" }, { accepted: true }, { reportHash: "a".repeat(64) }, { scope: authority }]) {
      expect((await post("evaluate", { planId: "one", ...extra })).status).toBe(400);
    }
    expect((await post("evaluate", { planId: "one" })).status).toBe(200);
    expect(evaluate).toHaveBeenCalledExactlyOnceWith({ planId: "one" });
    expect((await post("grants", { expectedRevision: 0, idempotencyKey: "one", grants: [] })).status).toBe(200);
    const grant = { id: "g", source: { appId: "app", projectId: "project", agentId: "agent", namespace: "memories", visibility: "private", userId: "other" },
      claimKinds: ["knowledge"], notBefore: new Date(0).toISOString(), expiresAt: new Date(1000).toISOString() };
    expect((await post("grants", { expectedRevision: 1, idempotencyKey: "two", grants: [grant] })).status).toBe(400);
    expect(replace).toHaveBeenCalledTimes(1);
    const ordinary = await router.handle({ method: "GET", path: "/v1/runtime/mcp-tools", headers: {} });
    expect(JSON.stringify(ordinary.body)).not.toContain("memory_evolution_reuse_");
    const owner = await router.handle({ method: "GET", path: "/v1/runtime/mcp-tools", headers: { "x-mengshu-owner-token": secret } });
    expect(JSON.stringify(owner.body)).toContain("memory_evolution_reuse_evaluate");
    expect((await router.handle({ method: "POST", path: "/v1/runtime/mcp-call", headers: {},
      body: { name: "memory_evolution_reuse_evaluate", arguments: { planId: "one" } } })).status).toBe(403);
  });
});
