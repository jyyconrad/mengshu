import { describe, expect, test } from "vitest";
import type { AuthorityScope } from "../../domain/authority-scope.js";
import type { MemoryScope } from "../../domain/types.js";
import {
  HostManagedReuseAuthorizer,
  validateExplicitReuseGrant,
  type ExplicitReuseGrant,
  type HostReuseState,
} from "./explicit-reuse-authorizer.js";

const now = Date.parse("2026-09-06T00:00:00Z");
const source: MemoryScope = {
  tenantId: "tenant-a", userId: "owner-a", appId: "codex", agentId: "agent-a",
  projectId: "project-a", namespace: "memory", visibility: "private",
};
const target: MemoryScope = { ...source, appId: "openclaw", agentId: "agent-b" };
const authority: AuthorityScope = {
  tenantId: source.tenantId, userId: source.userId,
  allow: {
    appIds: [source.appId, target.appId], agentIds: [source.agentId, target.agentId],
    projectIds: [source.projectId], namespaces: [source.namespace],
    visibilities: ["private"],
  },
};
const grant: ExplicitReuseGrant = {
  id: "grant-a", sourceScope: source, targetScope: target, claimKinds: ["fact", "preference"],
  notBefore: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 1000).toISOString(),
};

function host(grants: readonly ExplicitReuseGrant[] = [grant]) {
  let state: HostReuseState = { authority, revision: "1", grants };
  let clock = now;
  const authorizer = new HostManagedReuseAuthorizer({ read: async () => state }, () => clock);
  return {
    authorizer,
    set: (value: HostReuseState) => { state = value; },
    tick: (value: number) => { clock = value; },
  };
}

describe("host-owned explicit reuse grants", () => {
  test("permits only declared claims, preserves both exact scopes and returns a revision fence", async () => {
    const h = host();
    expect(await h.authorizer.authorize(source, target, "fact")).toMatchObject({
      grantId: grant.id, revision: "1", sourceScope: source, targetScope: target,
    });
    expect(await h.authorizer.authorize(source, target, "decision")).toBeUndefined();
    expect(await h.authorizer.authorize(target, source, "fact")).toBeUndefined();
    expect(await h.authorizer.sources(target)).toEqual([source]);
    expect(grant.sourceScope).toBe(source);
  });

  test("no-grant, expiry and revocation invalidate the current decision", async () => {
      const h = host([]);
      expect(await h.authorizer.authorize(source, target, "fact")).toBeUndefined();
      h.set({ authority, revision: "2", grants: [grant] });
      const permit = (await h.authorizer.authorize(source, target, "fact"))!;
      expect(await h.authorizer.revalidate(permit, "fact")).toBe(true);
      h.set({ authority, revision: "3", grants: [{ ...grant, revokedAt: new Date(now).toISOString() }] });
      expect(await h.authorizer.revalidate(permit, "fact")).toBe(false);
      expect(await h.authorizer.sources(target)).toEqual([]);
      h.set({ authority, revision: "4", grants: [grant] });
      h.tick(now + 1000);
      expect(await h.authorizer.authorize(source, target, "fact")).toBeUndefined();
  });

  test.each(["tenantId", "userId", "appId", "projectId", "agentId", "namespace", "workspaceId", "sessionId"])(
    "a grant cannot expand host %s", (field) => {
      expect(() => validateExplicitReuseGrant({
        ...grant, sourceScope: { ...source, [field]: "not-allowed" },
      }, authority)).toThrow();
    },
  );

  test("foreign owner, target scope drift, future grants and Team ACL remain denied", async () => {
    const h = host();
    for (const scope of [
      { ...target, userId: "owner-b" }, { ...target, tenantId: "tenant-b" },
      { ...target, projectId: "project-b" }, { ...target, namespace: "knowledge" },
      { ...target, visibility: "team" as const },
    ]) expect(await h.authorizer.authorize(source, scope, "fact")).toBeUndefined();
    h.tick(now - 1001);
    expect(await h.authorizer.sources(target)).toEqual([]);
    expect(() => validateExplicitReuseGrant({ ...grant, expiresAt: "invalid" }, authority)).toThrow();
    expect(() => validateExplicitReuseGrant({ ...grant, claimKinds: [] }, authority)).toThrow();
    expect(() => validateExplicitReuseGrant({ ...grant, claimKinds: ["*"] } as never, authority)).toThrow();
  });

  test("authority changes invalidate a still-present grant; malformed/duplicate state fails closed", async () => {
    const h = host();
    h.set({ authority: { ...authority, allow: { ...authority.allow, appIds: [source.appId] } },
      revision: "2", grants: [grant] });
    expect(await h.authorizer.sources(target)).toEqual([]);
    h.set({ authority, revision: "3", grants: [grant, grant] });
    expect(await h.authorizer.sources(target)).toEqual([]);
    h.set({ authority, revision: "", grants: [grant] });
    expect(await h.authorizer.authorize(source, target, "fact")).toBeUndefined();
  });

  test("untrusted permit copies and changing revisions cannot resurrect a previous decision", async () => {
    const h = host();
    const permit = (await h.authorizer.authorize(source, target, "fact"))!;
    expect(await h.authorizer.revalidate({ ...permit }, "fact")).toBe(false);
    h.set({ authority, revision: "2", grants: [grant] });
    expect(await h.authorizer.revalidate(permit, "fact")).toBe(false);
  });
});
