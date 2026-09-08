import { describe, expect, test } from "vitest";
import { RuntimeBackgroundWork } from "../../../../server/background-work.js";
import { createRestRouter } from "./router.js";
import { assertEvolutionOwnerRequest } from "../evolution-owner-auth.js";

const scope = { tenantId: "tenant", userId: "owner", appId: "app", projectId: "project", agentId: "agent", namespace: "memories", visibility: "private" as const };
const authority = { tenantId: scope.tenantId, userId: scope.userId, allow: {
  appIds: [scope.appId], projectIds: [scope.projectId], agentIds: [scope.agentId], namespaces: [scope.namespace], visibilities: [scope.visibility],
} };
const secret = "owner-background-fixture-credential-only";

describe("RuntimeHost background control", () => {
  test("read status stays available while pause and maintenance exit require owner plus current revision", async () => {
    const gate = new RuntimeBackgroundWork({ scope, authorizeUpdate: () => { assertEvolutionOwnerRequest(authority); } });
    const router = createRestRouter({ service: {} as never, authority, backgroundWork: gate, evolutionOwnerSecret: secret });
    const request = (method: string, body?: unknown, owner = false) => router.handle({ method, path: "/v1/runtime/background",
      body, headers: owner ? { "x-mengshu-owner-token": secret } : {}, remoteAddress: "127.0.0.1" });
    expect((await request("GET")).body).toMatchObject({ mode: "all", state: "enabled" });
    const expectedRevision = gate.snapshot().revision;
    expect((await request("POST", { expectedRevision, mode: "paused" })).status).toBe(403);
    expect((await request("POST", { expectedRevision, mode: "paused", scope }, true)).status).toBe(400);
    expect((await request("POST", { expectedRevision, mode: "paused" }, true)).status).toBe(200);
    expect((await request("GET")).body).toMatchObject({ mode: "paused", state: "paused" });
    expect((await request("POST", { expectedRevision, mode: "all" }, true)).status).toBe(409);
    await expect(gate.update({ expectedRevision: gate.snapshot().revision, mode: "all" })).rejects.toThrow();
    expect((await request("POST", { expectedRevision: gate.snapshot().revision, mode: "all" }, true)).status).toBe(200);
  });
});
