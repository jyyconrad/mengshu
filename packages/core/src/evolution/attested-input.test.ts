import { describe, expect, it, vi } from "vitest";
import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import { AttestedEvolutionInput } from "./attested-input.js";
import { DEFAULT_EVOLUTION_LIMITS } from "./schema.js";
import { inputPort, scope, unit } from "./test-fixtures.js";
import type { EvolutionEvidenceAttestation, EvolutionEvidenceAttestationPort } from "./types.js";

function setup() {
  const u = unit(); u.evidence[0].trust = "untrusted";
  const e = u.evidence[0];
  const proof: EvolutionEvidenceAttestation = { id: "proof", issuer: "authenticated-event-store", scopeFingerprint: authorityScopeFingerprint(scope), evidenceId: e.id, sourceId: e.sourceId, revision: e.revision, snapshotHash: e.snapshotHash, rootEvidenceId: e.rootEvidenceId, trust: "user_statement", authorId: "verified-original-author", authorizedTargetRefs: [], occurredAt: e.occurredAt, verifiedAt: 900, expiresAt: 2000 };
  const port: EvolutionEvidenceAttestationPort = { attest: vi.fn(async () => ({ attestations: [proof], recordsRead: 1, bytesRead: 100, verificationBudget: { records: 1, bytes: 100 } })), verify: vi.fn(async () => ({ valid: true, recordsRead: 1, bytesRead: 80 })) };
  const source = inputPort([u]);
  const input = new AttestedEvolutionInput(source, port, () => 1000);
  const context = { input: { mode: "inventory" as const, selection: "baseline" as const }, scope, limits: DEFAULT_EVOLUTION_LIMITS };
  return { u, proof, port, source, input, context };
}
describe("host evidence attestation input", () => {
  it("separates authenticated author proof from log role text and counts proof reads", async () => {
    const t = setup();
    const page = await t.input.readPage({ ...t.context, snapshot: await t.input.open(t.context), cursor: null, limit: 1 });
    expect(page.units[0].evidence[0]).toMatchObject({ trust: "user_statement", hostAttestation: { id: "proof" } });
    expect(t.u.evidence[0].trust).toBe("untrusted");
    expect(page.recordsRead).toBe(2);
    expect(page.bytesRead).toBe(Buffer.byteLength(t.u.evidence[0].text) + 100);
    expect(await t.input.verifyUnit(page.units[0], t.context)).toMatchObject({ valid: true, bytesRead: expect.any(Number) });
    expect(t.port.verify).toHaveBeenCalledOnce();
  });
  it.each(["scopeFingerprint", "evidenceId", "snapshotHash", "rootEvidenceId", "revision"] as const)("rejects unrelated proof field %s", async key => {
    const t = setup(); t.proof[key] = "other";
    await expect(t.input.readPage({ ...t.context, snapshot: await t.input.open(t.context), cursor: null, limit: 1 })).rejects.toThrow("attestation_binding_mismatch");
  });
  it("requires actual author identity for user_statement and rejects forged target grants", async () => {
    const t = setup(); delete t.proof.authorId;
    await expect(t.input.readPage({ ...t.context, snapshot: await t.input.open(t.context), cursor: null, limit: 1 })).rejects.toThrow("attestation_author_required");
    t.proof.authorId = "author"; t.proof.authorizedTargetRefs = [{ memoryId: "unknown", expectedRevision: 1, beforeHash: "f".repeat(64) }];
    await expect(t.input.readPage({ ...t.context, snapshot: await t.input.open(t.context), cursor: null, limit: 1 })).rejects.toThrow("attestation_target_mismatch");
  });
  it("checks revocation again and leaves absence of proof untrusted", async () => {
    const t = setup();
    const page = await t.input.readPage({ ...t.context, snapshot: await t.input.open(t.context), cursor: null, limit: 1 });
    t.port.verify = vi.fn(async () => ({ valid: false, reason: "attestation_revoked", bytesRead: 40, recordsRead: 1 }));
    expect(await t.input.verifyUnit(page.units[0], t.context)).toMatchObject({ valid: false, reason: "attestation_revoked" });
    t.port.attest = async () => ({ attestations: [], recordsRead: 0, bytesRead: 0, verificationBudget: { records: 0, bytes: 0 } });
    const without = await t.input.readPage({ ...t.context, snapshot: await t.input.open(t.context), cursor: null, limit: 1 });
    expect(without.units[0].evidence[0].trust).toBe("untrusted");
  });
});
