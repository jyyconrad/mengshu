import { describe, expect, test, vi } from "vitest";
import { createRestRouter } from "./router.js";
import { assertEvolutionOwnerRequest } from "../evolution-owner-auth.js";
import type { EvolutionBatchReport, EvolutionReviewItem, EvolutionReviewReceipt } from "../../../core/src/evolution/types.js";

const authority = { tenantId: "tenant", userId: "owner", allow: {
  appIds: ["codex"], projectIds: ["project"], agentIds: ["agent"], namespaces: ["memories"], visibilities: ["private" as const],
} };
const secret = "owner-only-fixture-credential-not-real";
const hash = "a".repeat(64);
const review: EvolutionReviewItem = {
  id: "review-1", binding: { proposalId: "proposal-1", scopeFingerprint: hash, inputFingerprint: hash,
    sourceSnapshotHash: hash, configFingerprint: hash, policyVersion: "policy-1", diffHash: hash,
    evidenceHash: hash, targetStateHash: hash, targetRefs: [] }, bindingHash: hash,
  proposal: { operation: "create", claimClass: "fact", reasonCode: "new_claim", targetRefs: [], proposedText: "A bounded fact", kind: "fact",
    quotes: [{ evidenceId: "source-1", quote: "A bounded fact", start: 0, end: 14 }] },
  targets: [], evidence: [], status: "pending", createdAt: 100, expiresAt: 200,
};
const report = { batchId: "batch-1", status: "queued", reasons: [],
  usage: { records: 0, files: 0, bytes: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 },
  counts: { proposed: 0, applied: 0, rejected: 0, review: 0, noop: 0, skipped: 0 },
  checkpoint: { cursor: null }, configFingerprint: hash, resumable: true,
} satisfies EvolutionBatchReport;

function fixture() {
  const preview = vi.fn(async () => { assertEvolutionOwnerRequest(authority); return review; });
  const decide = vi.fn(async () => ({ id: "receipt-1", reviewId: review.id, binding: review.binding,
    bindingHash: hash, decision: "approve", actor: { tenantId: "tenant", userId: "owner", actorId: "operator", authentication: "authenticated_owner" },
    idempotencyKey: "decision-1", decidedAt: 110, expiresAt: 200,
  } as EvolutionReviewReceipt));
  const apply = vi.fn(async () => report), cancel = vi.fn(async () => ({ ...report, status: "cancelled" as const }));
  const router = createRestRouter({ service: {} as never, authority, evolutionOwnerSecret: secret,
    continuousMemoryEvolution: { run: async () => report, status: async () => report, resume: async () => report,
      cancel, review: { preview, decide, status: async () => review, apply } },
    runtimeControl: {} as never,
    runtimeMcp: { listTools: () => [], callTool: async () => preview() },
  });
  return { preview, decide, apply, cancel, post: (operation: string, body: unknown, owner = false, mcp = false) => router.handle({
    method: "POST", path: mcp ? "/v1/runtime/mcp-call" : `/v1/evolution/${operation}`,
    headers: owner ? { "x-mengshu-owner-token": secret } : {}, body, remoteAddress: "127.0.0.1",
  }) };
}

describe("dedicated evolution review REST control plane", () => {
  test("requires independent operator authentication even on local REST and MCP proxy", async () => {
    const f = fixture();
    expect((await f.post("review/preview", { proposalId: "proposal-1" })).status).toBe(403);
    expect((await f.post("", { name: "memory_evolution_review_preview", arguments: { proposalId: "proposal-1" } }, false, true)).status).toBe(403);
    expect(f.preview).not.toHaveBeenCalled();
    const response = await f.post("review/preview", { proposalId: "proposal-1" }, true);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: "review-1", bindingHash: hash, proposal: { proposedText: "A bounded fact" } });
    expect((await f.post("", { name: "memory_evolution_review_preview", arguments: { proposalId: "proposal-1" } }, true, true)).status).toBe(200);
    expect(() => assertEvolutionOwnerRequest(authority)).toThrow();
  });
  test("approval, enqueue and cancel reject payload authority/paths/expiry instead of forwarding them", async () => {
    const f = fixture();
    const decision = { reviewId: "review-1", expectedBindingHash: hash, decision: "approve", idempotencyKey: "decision-1" };
    for (const key of ["actor", "scope", "path", "model", "expiresAt", "approval"]) {
      expect((await f.post("review/decide", { ...decision, [key]: "injected" }, true)).status).toBe(400);
    }
    expect(f.decide).not.toHaveBeenCalled();
    expect((await f.post("review/decide", decision, true)).status).toBe(200);
    expect((await f.post("review/apply", { approvalReceiptId: "receipt-1" }, true)).status).toBe(200);
    expect(f.apply).toHaveBeenCalledExactlyOnceWith("receipt-1");
    expect((await f.post("cancel", { batchId: "batch-1" }, true)).status).toBe(200);
    expect(f.cancel).toHaveBeenCalledExactlyOnceWith("batch-1");
  });
});
