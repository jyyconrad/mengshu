import { describe, expect, test, vi } from "vitest";
import { assertEvolutionOwnerRequest, withAuthenticatedEvolutionOwner } from "./evolution-owner-auth.js";
import { createFetchRuntimeClientTransport } from "./runtime-client.js";

const secret = "operator-only-fixture-credential-32-bytes";
const owner = { tenantId: "tenant", userId: "owner" };

describe("evolution owner control plane", () => {
  test("ordinary bearer, local address, duplicate headers and missing control config cannot authorize review", async () => {
    const work = vi.fn(async () => assertEvolutionOwnerRequest(owner));
    for (const headers of [
      {}, { authorization: `Bearer ${secret}` }, { "x-mengshu-owner-token": "wrong" },
      { "x-mengshu-owner-token": [secret, secret] },
      { "x-mengshu-owner-token": secret, "X-Mengshu-Owner-Token": secret },
    ]) await expect(withAuthenticatedEvolutionOwner({ headers, secret, owner }, work)).rejects.toThrow("EVOLUTION_OWNER_REQUIRED");
    await expect(withAuthenticatedEvolutionOwner({ headers: { "x-mengshu-owner-token": secret }, owner }, work)).rejects.toThrow("EVOLUTION_OWNER_REQUIRED");
    expect(work).not.toHaveBeenCalled();
    expect(() => assertEvolutionOwnerRequest(owner)).toThrow("EVOLUTION_OWNER_REQUIRED");
  });

  test("owner identity is host-bound and cannot leak to another concurrent request", async () => {
    const work = withAuthenticatedEvolutionOwner({ headers: { "X-Mengshu-Owner-Token": secret }, secret, owner }, async () => {
      await Promise.resolve();
      expect(assertEvolutionOwnerRequest(owner)).toEqual(owner);
      expect(() => assertEvolutionOwnerRequest({ ...owner, userId: "other" })).toThrow("EVOLUTION_OWNER_REQUIRED");
    });
    expect(() => assertEvolutionOwnerRequest(owner)).toThrow("EVOLUTION_OWNER_REQUIRED");
    await work;
    expect(() => assertEvolutionOwnerRequest(owner)).toThrow("EVOLUTION_OWNER_REQUIRED");
  });

  test("owner credentials are out-of-band and cannot follow cross-origin paths or redirects", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("{}", { status: 200 }));
    const transport = createFetchRuntimeClientTransport({ baseUrl: "http://127.0.0.1:1234", ownerToken: secret, fetch });
    await transport.request({ method: "POST", path: "/v1/evolution/review", body: { proposalId: "p" } });
    const [, options] = fetch.mock.calls[0]!;
    expect(options?.headers).toMatchObject({ "x-mengshu-owner-token": secret });
    expect(options?.body).not.toContain(secret);
    expect(options?.redirect).toBe("error");
    for (const path of ["https://other.invalid/review", "//other.invalid/review", "/\\other.invalid/review"]) {
      await expect(transport.request({ method: "POST", path })).rejects.toThrow();
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
