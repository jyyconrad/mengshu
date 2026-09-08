import { describe, expect, test, vi } from "vitest";
import { createEvolutionRawEvidenceMaterializer } from "./governed-evidence-materializer.js";
import { computeCanonicalContentHash } from "../scoring/hash-utils.js";

describe("evolution raw evidence materializer", () => {
  test("stores selected quotes only with stable idempotency and no active support links", async () => {
    const execute = vi.fn(async () => ({ status: "persisted", recordType: "memory", route: "evidence_only", memoryId: "11111111-1111-4111-8111-111111111111", stored: true }));
    const materialize = createEvolutionRawEvidenceMaterializer({ execute: execute as never });
    const text = "First statement. Selected complete statement. Last statement.";
    const quote = "Selected complete statement.";
    const source = { id: "event-1", sourceId: "source", revision: "1", snapshotHash: computeCanonicalContentHash(text), rootEvidenceId: "root", text };
    const input = { context: { proposal: { id: "proposal", scopeFingerprint: "a".repeat(64), scope: { appId: "app", projectId: "p", agentId: "a", namespace: "memories", visibility: "private" }, createdAt: 100 }, authority: { tenantId: "t", userId: "u" }, evidence: [{ ...source, quote, start: 17, end: 45 }] }, evidence: [source] };
    const verified = { ...input, supportedEvidence: input.context.evidence };
    const first = await materialize(verified as never);
    await materialize(verified as never);
    expect(first).toEqual([{ sourceEvidenceId: "event-1", evidenceMemoryId: "11111111-1111-4111-8111-111111111111" }]);
    const command = (execute.mock.calls as unknown as [Record<string, unknown>][])[0]![0];
    expect(command).toMatchObject({ type: "importEvidence", text: quote, kind: "observation", container: "session_candidate", metadata: { eventType: "observation", evolutionEvidence: { sourceEvidenceId: "event-1", snapshotHash: source.snapshotHash, rootEvidenceId: "root", expiresAt: 604800100 } } });
    expect(command).not.toHaveProperty("semanticType");
    expect(JSON.stringify(command)).not.toContain("First statement");
    expect(execute.mock.calls[0]).toEqual(execute.mock.calls[1]);
  });
  test("active or candidate receipts are not accepted as raw evidence proof", async () => {
    const materialize = createEvolutionRawEvidenceMaterializer({ execute: async () => ({ status: "duplicate", kind: "exact" }) });
    const input = { context: { proposal: { id: "p", createdAt: 0, scope: {}, scopeFingerprint: "a".repeat(64) }, evidence: [{ id: "s", quote: "quote", start: 0, end: 5 }] }, evidence: [{ id: "s", text: "quote" }] };
    await expect(materialize({ ...input, supportedEvidence: input.context.evidence } as never)).rejects.toThrow("raw_evidence_not_persisted");
  });
});
