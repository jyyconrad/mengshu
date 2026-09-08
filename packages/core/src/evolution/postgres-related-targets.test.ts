import { describe, expect, test, vi } from "vitest";
import type { MemoryScope } from "../domain/types.js";
import { computeCanonicalContentHash, computeContentHash } from "../scoring/hash-utils.js";
import { scopedFingerprint, scopeParams } from "./postgres-common.js";
import { decodeEvolutionTarget, PostgresEvolutionInventoryReadPort } from "./postgres-inventory.js";
import { PostgresEvolutionRelatedTargets } from "./postgres-related-targets.js";
import type { EvolutionEvidence } from "./types.js";

const scope: MemoryScope = { tenantId: "tenant", userId: "owner", appId: "codex", projectId: "project';SELECT(1)--",
  agentId: "agent", namespace: "memories", visibility: "private", workspaceId: "workspace", sessionId: "session" };
const path = "a".repeat(64);
function evidence(overrides: Partial<EvolutionEvidence> = {}): EvolutionEvidence {
  const text = overrides.text ?? "Keep local backups.";
  return { id: "record-1", sourceId: "docs", revision: "revision-2", snapshotHash: computeCanonicalContentHash(text),
    text, scope, rootEvidenceId: "source-root", origin: "external", trust: "untrusted", locator: `${path}:1-20:span-1`, ...overrides };
}
function row(n = 1, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const text = "Keep local backups.";
  return { id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, text, content_hash: computeContentHash(text),
    created_at_ms: 100, revision: 2, lineage_id: "lineage-1", lifecycle_status: "active", data_type: "memory",
    temporal_invalidated: false, temporal_purge_pending: false, evolution_alias_of: null, evolution_disputed: false,
    legacy_quarantine_reason: null, valid_from_ms: 100, valid_to_ms: null, closed_at_ms: null, related_by_link: false,
    metadata: { admissionRoute: "active", contextEligible: true, pinned: true, semanticType: "rules",
      governance: { native: { kind: "decision" }, evolution: { effectiveRootIds: ["persisted-root"] } } }, ...overrides };
}
function harness(rows: Record<string, unknown>[] = []) {
  const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows }));
  const client = { query } as never;
  return { query, client, port: new PostgresEvolutionRelatedTargets({ client, scope }) };
}
const request = () => ({ scope, evidence: [evidence()], limit: 8, maxBytes: 100000 });

describe("PostgresEvolutionRelatedTargets", () => {
  test("exact hashes use the active scoped key and return the unchanged inventory target", async () => {
    const stored = row(), h = harness([stored]);
    const resolve = h.port.resolve;
    const result = await resolve(request());
    expect(result).toEqual({ targets: [decodeEvolutionTarget(stored, scope)], recordsRead: 1, bytesRead: Buffer.byteLength(JSON.stringify(stored)) });
    const [sql, params] = h.query.mock.calls[0]!;
    expect(params!.slice(0, 10)).toEqual([...scopeParams(scope), scopedFingerprint(scope)]);
    expect(params![11]).toEqual([computeContentHash(evidence().text), computeCanonicalContentHash(evidence().text)].sort());
    expect(sql).toContain("content_hash = clue.content_hash");
    expect(sql).toContain("lifecycle_status = 'active'");
    expect(sql).toContain("LIMIT 1");
    expect(sql).not.toContain(scope.projectId);
    expect(sql).not.toContain(evidence().text);
    const inventory = new PostgresEvolutionInventoryReadPort({ client: h.client, scope });
    expect(await inventory.readTargets(scope, result.targets)).toEqual(result.targets);
    expect(result.targets[0]).toMatchObject({ evidenceRootIds: ["persisted-root"], pinned: true, highImpact: true, governanceHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  test("source-linked targets can differ in text/revision without upgrading source trust or authorization", async () => {
    const input = evidence(), before = structuredClone(input);
    const stored = row(2, { text: "Old backup policy.", content_hash: computeContentHash("Old backup policy."), related_by_link: true });
    const h = harness([stored]);
    const result = await h.port.resolve({ ...request(), evidence: [input] });
    expect(result.targets).toEqual([decodeEvolutionTarget(stored, scope)]);
    expect(input).toEqual(before);
    expect(input.trust).toBe("untrusted");
    expect(input.authorizedTargetIds).toBeUndefined();
    expect(result.targets[0]).not.toHaveProperty("authorizedTargetIds");
    const [sql, params] = h.query.mock.calls[0]!;
    expect(JSON.parse(String(params![10]))).toEqual([{ evidence_id: input.id, source_id: input.sourceId, snapshot_hash: input.snapshotHash, path_id: path }]);
    for (const anchor of ["l.source_record_id = clue.evidence_id", "l.evidence_memory_id = clue.evidence_id", "l.source_hash = clue.snapshot_hash", "l.source_path_id = clue.path_id"]) expect(sql).toContain(anchor);
    expect(sql).toContain("l.source_id = clue.source_id");
    expect(sql).toContain("l.relation_state = 'effective'");
    expect(sql).toContain("l.retired_at IS NULL");
    expect(sql).toContain("disposition.disposition = 'revoked'");
  });

  test.each(["tenantId", "userId", "appId", "projectId", "agentId", "namespace", "visibility", "workspaceId", "sessionId"] as const)("%s mismatch fails before querying even when source labels match", async field => {
    const h = harness([row(1, { related_by_link: true })]);
    const changed = { ...scope, [field]: field === "visibility" ? "team" : "other" } as MemoryScope;
    await expect(h.port.resolve({ ...request(), scope: changed })).rejects.toThrow("scope_mismatch");
    await expect(h.port.resolve({ ...request(), evidence: [evidence({ scope: changed })] })).rejects.toThrow("scope_mismatch");
    expect(h.query).not.toHaveBeenCalled();
  });

  test("SQL scopes both relations and canonical rows including consistent session provenance", async () => {
    const h = harness();
    await h.port.resolve(request());
    const sql = h.query.mock.calls[0]![0];
    for (const [i, column] of ["tenant_id", "user_id", "app_id", "project_id", "agent_id", "namespace", "visibility", "workspace_id", "session_id"].entries()) expect(sql).toContain(`l.${column} = $${i + 1}`);
    expect(sql).toContain("l.scope_fingerprint = $10");
    expect(sql).toContain("canonical_project_id = $4");
    expect(sql).toContain("metadata->>'sessionId' = metadata #>> '{governance,provenance,sessionId}'");
    expect(sql).not.toMatch(/\b(BEGIN|COMMIT|UPDATE|INSERT|DELETE|FOR SHARE|FOR UPDATE)\b/);
  });

  test("current, validity, quarantine, tombstone and disputed state are guarded in the bounded SQL", async () => {
    const h = harness();
    await h.port.resolve(request());
    const sql = h.query.mock.calls[0]![0];
    for (const predicate of ["head.current_version_id = memories.id", "head.current_version_revision = memories.revision",
      "head.scope_fingerprint = $10", "head.lineage_id = memories.lineage_id", "valid_from <= CURRENT_TIMESTAMP", "valid_to IS NULL", "closed_at IS NULL",
      "temporal_invalidated IS NOT TRUE", "temporal_purge_pending IS NOT TRUE", "temporal_activation_state = 'active'",
      "legacy_quarantine_reason IS NULL", "data_type = 'memory'", "evolution_alias_of IS NULL", "evolution_disputed IS NOT TRUE",
      "{governance,evolution,needsReview}", "{governance,evolution,disputed}", "metadata->>'admissionRoute' = 'lookup_only'",
      "valid_from IS NOT NULL", "{governance,candidate,phase}", "<> 'raw_evidence'",
      "octet_length(text) <= 32768", "<= 65536"]) expect(sql).toContain(predicate);
    expect(sql).toContain("lineage_id IS NULL AND revision IS NULL");
    expect(sql).toContain("CASE WHEN id ~");
  });

  test("an empty or label-only match returns a real empty result without a fallback inventory read", async () => {
    const h = harness();
    expect(await h.port.resolve({ ...request(), evidence: [] })).toEqual({ targets: [], recordsRead: 0, bytesRead: 0 });
    expect(h.query).not.toHaveBeenCalled();
    expect(await h.port.resolve({ ...request(), evidence: [evidence({ sourceId: "mcp", locator: undefined })] })).toEqual({ targets: [], recordsRead: 0, bytesRead: 0 });
    expect(h.query).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(h.query.mock.calls[0]![1]![10]))[0].path_id).toBeNull();
  });

  test("deduplicates and stably orders targets but accounts every returned row and UTF-8 byte", async () => {
    const rows = [row(3, { created_at_ms: 200 }), row(2), row(1), row(1)];
    const h = harness(rows);
    const first = await h.port.resolve(request());
    const second = await h.port.resolve({ ...request(), evidence: [evidence(), evidence()] });
    expect(first).toEqual(second);
    expect(first.targets.map(t => t.memoryId)).toEqual([row(1).id, row(2).id, row(3).id]);
    expect(first.recordsRead).toBe(4);
    expect(first.bytesRead).toBe(rows.reduce((sum, r) => sum + Buffer.byteLength(JSON.stringify(r)), 0));
    expect(JSON.parse(String(h.query.mock.calls[1]![1]![10]))).toHaveLength(1);
  });

  test("query limits never exceed eight and transport overflow fails instead of silently clipping accounting", async () => {
    const h = harness();
    await h.port.resolve({ ...request(), limit: 10000 });
    expect(h.query.mock.calls[0]![1]!.at(-1)).toBe(8);
    const overflow = harness([row(1), row(2)]);
    await expect(overflow.port.resolve({ ...request(), limit: 1 })).rejects.toThrow("related_targets_record_limit");
    expect(overflow.query).toHaveBeenCalledTimes(1);
  });

  test("bytes overflow is a post-read failure including metadata and non-ASCII bytes", async () => {
    const stored = row(1, { related_by_link: true, text: "真实原文", content_hash: computeContentHash("真实原文") });
    const h = harness([stored]), bytes = Buffer.byteLength(JSON.stringify(stored));
    await expect(h.port.resolve({ ...request(), maxBytes: bytes - 1 })).rejects.toThrow("related_targets_byte_limit");
    expect(h.query).toHaveBeenCalledTimes(1);
    expect((await h.port.resolve({ ...request(), maxBytes: bytes })).bytesRead).toBe(bytes);
  });

  test.each([{ limit: 0 }, { limit: -1 }, { limit: 1.5 }, { maxBytes: 0 }, { maxBytes: Infinity }])("invalid budget %j never executes SQL", async budget => {
    const h = harness();
    await expect(h.port.resolve({ ...request(), ...budget })).rejects.toThrow("related_targets_budget_invalid");
    expect(h.query).not.toHaveBeenCalled();
  });

  test("input evidence, text and snapshot bounds are checked before the SQL read", async () => {
    const h = harness();
    await expect(h.port.resolve({ ...request(), evidence: Array.from({ length: 33 }, () => evidence()) })).rejects.toThrow("related_targets_evidence_limit");
    await expect(h.port.resolve({ ...request(), evidence: [evidence({ text: "x".repeat(32769) })] })).rejects.toThrow("related_targets_evidence_limit");
    await expect(h.port.resolve({ ...request(), evidence: [evidence({ snapshotHash: "0".repeat(64) })] })).rejects.toThrow("source_snapshot_changed");
    expect(h.query).not.toHaveBeenCalled();
  });

  test("revoked and evaluation evidence do not seed related targets", async () => {
    const h = harness([row()]);
    expect(await h.port.resolve({ ...request(), evidence: [evidence({ revoked: true }), evidence({ origin: "evaluation" })] })).toEqual({ targets: [], recordsRead: 0, bytesRead: 0 });
    expect(h.query).not.toHaveBeenCalled();
  });

  test("legacy MD5 candidates must also match canonical text unless actually source-linked", async () => {
    const other = row(1, { text: "Different claim.", content_hash: computeContentHash("Different claim.") });
    const h = harness([other]);
    const result = await h.port.resolve(request());
    expect(result.targets).toEqual([]);
    expect(result.recordsRead).toBe(1);
    expect(result.bytesRead).toBeGreaterThan(0);
  });

  test("invalid stored hashes fail closed without rewriting target evidence roots", async () => {
    const h = harness([row(1, { content_hash: "0".repeat(64), related_by_link: true })]);
    await expect(h.port.resolve(request())).rejects.toThrow("INVALID_INVENTORY_HASH");
  });

  test("AbortSignal is checked before and after SQL, with no orphan promise-race read", async () => {
    const h = harness([row()]), controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(h.port.resolve({ ...request(), signal: controller.signal })).rejects.toThrow("cancelled");
    expect(h.query).not.toHaveBeenCalled();
    const during = new AbortController();
    h.query.mockImplementationOnce(async () => { during.abort(new Error("cancelled_during_read")); return { rows: [row()] }; });
    await expect(h.port.resolve({ ...request(), signal: during.signal })).rejects.toThrow("cancelled_during_read");
    expect(h.query).toHaveBeenCalledTimes(1);
  });
});
