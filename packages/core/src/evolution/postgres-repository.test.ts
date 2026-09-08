import { describe, expect, test, vi } from "vitest";
import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { EvolutionBatch, EvolutionLease, EvolutionProposal, EvolutionStagedEvidence, EvolutionReviewItem, EvolutionReviewReceipt } from "./types.js";
import { PostgresEvolutionRepository } from "./postgres-repository.js";
import { proposalRequestHash } from "./postgres-repository.js";
import { buildEvolutionReviewBinding, evolutionProposalDraft } from "./review-binding.js";
import { evolutionHash } from "./fingerprints.js";
import { POSTGRES_EVOLUTION_TRANSACTION_LIMITS_SQL } from "./postgres-common.js";

const scope = { tenantId: "tenant", userId: "user", appId: "codex", projectId: "project", agentId: "agent", namespace: "memories", visibility: "private" as const };
const fp = authorityScopeFingerprint(scope);
const hash = "a".repeat(64);
function batch(): EvolutionBatch {
  return { id: "batch", scope, scopeFingerprint: fp, request: { input: { mode: "inventory", selection: "baseline" }, action: "propose", idempotencyKey: "key", limits: { maxRecords: 5, maxFiles: 5, maxBytes: 10000, maxLlmCalls: 5, maxInputTokens: 10000, maxOutputTokens: 1000, maxDurationMs: 30000 } }, requestHash: hash, configFingerprint: hash, policyVersion: "v1", status: "queued", reasons: [], cursor: null, usage: { records: 0, files: 0, bytes: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 }, counts: { proposed: 0, applied: 0, rejected: 0, review: 0, noop: 0, skipped: 0 }, createdAt: 100, updatedAt: 100, version: 0 };
}
function proposal(): EvolutionProposal {
  return { id: "proposal", batchId: "batch", scope, scopeFingerprint: fp, operation: "create", claimClass: "fact", reasonCode: "new_claim", targetRefs: [], quotes: [{ evidenceId: "ev", quote: "quote", start: 0, end: 5 }], proposedText: "bounded new claim", kind: "fact", inputUnitId: "unit", inputFingerprint: hash, sourceSnapshotHash: hash, configFingerprint: hash, policyVersion: "v1", validation: { outcome: "review", reasons: [], reviewRequirement: "owner", independentEvidenceRootIds: [], contextEligible: false }, status: "review", createdAt: 100 };
}
const evidence: EvolutionStagedEvidence = { id: "ev", sourceId: "source", revision: "1", snapshotHash: hash, scope, rootEvidenceId: "root", origin: "external", trust: "untrusted", quote: "quote", start: 0, end: 5 };
const lease: EvolutionLease = { batchId: "batch", scopeFingerprint: fp, ownerId: "owner", fencingToken: 1, expiresAt: 50000 };

function harness(replies: Record<string, unknown[][]> = {}) {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
    calls.push({ sql, params });
    const tag = sql.match(/evolution:([a-z-]+)/)?.[1];
    const rows = tag ? replies[tag]?.shift() ?? [] : [];
    return { rows, rowCount: rows.length };
  });
  const release = vi.fn();
  const client = { query, release };
  const pool = { query, connect: vi.fn(async () => client) };
  const repository = new PostgresEvolutionRepository({ pool: pool as never, scope });
  return { repository, calls, query, release };
}

function reviewFixture() {
  const p = proposal();
  const { quote: _quote, start: _start, end: _end, ...source } = evidence;
  const binding = buildEvolutionReviewBinding(p, { id: p.inputUnitId, scope, snapshotHash: hash, targets: [], evidence: [{ ...source, text: "quote" }] });
  const review: EvolutionReviewItem = { id: "review", binding, bindingHash: evolutionHash(binding), proposal: evolutionProposalDraft(p), targets: [], evidence: [evidence], status: "pending", createdAt: 100, expiresAt: 1000 };
  const receipt: EvolutionReviewReceipt = { id: "receipt", reviewId: review.id, binding, bindingHash: review.bindingHash, decision: "approve", actor: { tenantId: "tenant", userId: "user", actorId: "owner", authentication: "local_owner" }, idempotencyKey: "review-decision", decidedAt: 200, expiresAt: 1000 };
  const envelope = { version: 1, proposal: p, evidence: [evidence], requestHash: proposalRequestHash(p, [evidence]), relationState: "staged", expiresAt: 2000 };
  return { p, review, receipt, candidate: { metadata: { evolution: envelope }, status: "pending" } };
}

describe("PostgresEvolutionRepository", () => {
  test("review creation binds staged proposal and evidence without writing canonical", async () => {
    const f = reviewFixture();
    const h = harness({ "proposal-get": [[f.candidate]], "review-insert": [[{ review: f.review }]] });
    await expect(h.repository.createReview(f.review)).resolves.toEqual({ review: f.review, created: true });
    expect(h.calls.find(c => c.sql.includes("evolution:proposal-get"))?.sql).toContain("FOR UPDATE");
    expect(h.calls.some(c => /(?:INSERT INTO|UPDATE) memories\b/.test(c.sql))).toBe(false);
    expect(h.calls.at(-1)?.sql).toBe("COMMIT");
  });
  test("review scope and forged diff are rejected before decision writes", async () => {
    const f = reviewFixture();
    const h = harness({ "proposal-get": [[f.candidate]] });
    await expect(h.repository.createReview({ ...f.review, proposal: { ...f.review.proposal, proposedText: "forged" } })).rejects.toThrow("REVIEW_BINDING_MISMATCH");
    await expect(h.repository.decideReview({ ...f.receipt, actor: { ...f.receipt.actor, userId: "another" } }, f.review.bindingHash)).rejects.toThrow("REVIEW_AUTHORITY_MISMATCH");
    expect(h.calls.some(c => c.sql.includes("evolution:review-decide"))).toBe(false);
  });
  test("review decision is same-client serialized, expiry checked by DB, and immutable", async () => {
    const f = reviewFixture();
    const h = harness({ "proposal-get": [[f.candidate]], "review-lock": [[{ review: f.review, receipt: null, revoked_at: null }]], "review-decide": [[{ receipt: f.receipt }]] });
    await expect(h.repository.decideReview(f.receipt, f.review.bindingHash)).resolves.toEqual(f.receipt);
    const write = h.calls.find(c => c.sql.includes("evolution:review-decide"))!;
    expect(write.sql).toContain("clock_timestamp()");
    expect(write.sql).toContain("receipt IS NULL");
    expect(h.calls.at(-1)?.sql).toBe("COMMIT");
    const retry = harness({ "proposal-get": [[f.candidate]], "review-lock": [[{ review: { ...f.review, status: "approved" }, receipt: f.receipt }]] });
    await expect(retry.repository.decideReview({ ...f.receipt, decision: "reject" }, f.review.bindingHash)).rejects.toThrow("REVIEW_DECISION_CONFLICT");
    expect(retry.calls.at(-1)?.sql).toBe("ROLLBACK");
  });
  test("expired decision cannot persist an approval or canonical side effect", async () => {
    const f = reviewFixture();
    const h = harness({ "proposal-get": [[f.candidate]], "review-lock": [[{ review: f.review }]], "review-decide": [[]] });
    await expect(h.repository.decideReview(f.receipt, f.review.bindingHash)).rejects.toThrow("REVIEW_EXPIRED_OR_CHANGED");
    expect(h.calls.at(-1)?.sql).toBe("ROLLBACK");
  });
  test("host mutation fence is checked inside every short transaction and rejects before writes", async () => {
    const calls: string[] = [];
    const query = vi.fn(async (sql: string) => { calls.push(sql); return { rows: [], rowCount: 0 }; });
    const client = { query, release: vi.fn() };
    const beforeMutation = vi.fn(async (connection: unknown) => {
      expect(connection).toBe(client);
      expect(calls[0]).toBe("BEGIN");
      throw new Error("stale minted fence");
    });
    const repository = new PostgresEvolutionRepository({ pool: { query, connect: async () => client } as never, scope, beforeMutation });
    await expect(repository.acquireLease("batch", fp, "owner", 1000)).rejects.toThrow();
    expect(beforeMutation).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["BEGIN", POSTGRES_EVOLUTION_TRANSACTION_LIMITS_SQL, "ROLLBACK"]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
  test("scope mismatches fail before any query", async () => {
    const h = harness();
    await expect(h.repository.getBatch("batch", "b".repeat(64))).rejects.toThrow("SCOPE_MISMATCH");
    await expect(h.repository.createBatch({ ...batch(), scope: { ...scope, userId: "other" } })).rejects.toThrow("SCOPE_MISMATCH");
    expect(h.query).not.toHaveBeenCalled();
  });
  test("create uses bound idempotency and replays the original batch", async () => {
    const original = batch();
    const h = harness({ "batch-insert": [[]], "batch-by-key": [[{ body: original }]] });
    const result = await h.repository.createBatch({ ...batch(), id: "another-id" });
    expect(result).toEqual({ batch: original, created: false });
    expect(h.calls[0]?.sql).toBe("BEGIN");
    expect(h.calls.at(-1)?.sql).toBe("COMMIT");
    expect(h.calls.find(({ sql }) => sql.includes("evolution:batch-insert"))?.params).toContain(fp);
  });
  test("idempotency collision rolls back and never returns the other request", async () => {
    const h = harness({ "batch-insert": [[]], "batch-by-key": [[{ body: batch() }]] });
    await expect(h.repository.createBatch({ ...batch(), requestHash: "b".repeat(64) })).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    expect(h.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(h.release).toHaveBeenCalledTimes(1);
  });
  test("checkpoint CAS includes owner, fencing token and unexpired DB lease", async () => {
    const h = harness({ "batch-save": [[]] });
    await expect(h.repository.saveBatch(batch(), 0, lease)).rejects.toThrow("STALE_BATCH_OR_LEASE");
    const call = h.calls.find(({ sql }) => sql.includes("evolution:batch-save"))!;
    expect(call.sql).toContain("version =");
    expect(call.sql).toContain("fencing_token =");
    expect(call.sql).toContain("lease_owner =");
    expect(call.sql).toContain("clock_timestamp()");
    expect(call.params).toContain(fp);
  });
  test("stage writes only candidate metadata, preserving quote/root identity and TTL", async () => {
    const p = proposal();
    const h = harness({ "lease-lock": [[{ id: "batch" }]], "proposal-insert": [[{ id: "proposal" }]] });
    await expect(h.repository.stageProposal(p, [evidence, { ...evidence, id: "ev2" }], lease)).rejects.toThrow();
    const h2 = harness({ "lease-lock": [[{ id: "batch" }]], "proposal-insert": [[{ id: "proposal" }]] });
    await expect(h2.repository.stageProposal(p, [evidence], lease)).resolves.toEqual(p);
    expect(h2.calls.some(({ sql }) => /(?:INSERT INTO|UPDATE) (?:memories|mengshu_memory_evidence_links)\b/.test(sql))).toBe(false);
    const insert = h2.calls.find(({ sql }) => sql.includes("evolution:proposal-insert"))!;
    const metadata = insert.params.find((value) => typeof value === "string" && value.includes('"evolution"')) as string;
    expect(JSON.parse(metadata)).toMatchObject({ evolution: { version: 1, evidence: [{ rootEvidenceId: "root", quote: "quote" }], expiresAt: expect.any(Number), relationState: "staged" } });
    expect(h2.calls.at(-1)?.sql).toBe("COMMIT");
  });
  test("staging cannot smuggle a second quote or escalate scope", async () => {
    const h = harness();
    await expect(h.repository.stageProposal(proposal(), [{ ...evidence, quote: "forged" }], lease)).rejects.toThrow("INVALID_STAGED_EVIDENCE");
    await expect(h.repository.stageProposal(proposal(), [{ ...evidence, scope: { ...scope, projectId: "outside" } }], lease)).rejects.toThrow("SCOPE_MISMATCH");
    expect(h.query).not.toHaveBeenCalled();
  });
  test("old lease cannot stage or record checkpoint work", async () => {
    const h = harness();
    await expect(h.repository.stageProposal(proposal(), [evidence], lease)).rejects.toThrow("STALE_LEASE");
    expect(h.calls.some(({ sql }) => sql.includes("evolution:proposal-insert"))).toBe(false);
    expect(h.calls.at(-1)?.sql).toBe("ROLLBACK");
  });
  test("processed fingerprints require a staged proposal proof and have per-item uniqueness", async () => {
    const h = harness({ "lease-lock": [[{ id: "batch" }]], "proposal-get": [[]] });
    await expect(h.repository.recordProcessed({ scopeFingerprint: fp, inputFingerprint: hash, action: "propose", proposalId: "proposal", processedAt: 100 }, lease)).rejects.toThrow("PROCESSED_PROOF_MISSING");
    expect(h.calls.some(({ sql }) => sql.includes("evolution:processed-insert"))).toBe(false);
  });
});
