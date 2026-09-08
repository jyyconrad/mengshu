import { describe, expect, it, vi } from "vitest";
import { historyFixture } from "../../../../../tests/fixtures/evolution-history/fixture.js";
import { auditHistory } from "./audit.js";
import { planHistory } from "./plan.js";
import { insertHistoryRawEvidence, readHistoryAnchoredEvidence } from "./postgres-evidence.js";
import { historyContentSha256 } from "./native-materials.js";
import { HistoryPostgresLockedStore, type HistoryPostgresStoreOptions } from "./postgres-store.js";
import type { HistoryPgClient } from "./postgres-read.js";
import type { MemoryRecord } from "../../domain/types.js";
import { authorityScopeFingerprint } from "../../domain/authority-scope-fingerprint.js";

async function fixture(text = "Visible observation") {
  const value = historyFixture(), bytes = Buffer.from(text);
  value.bindings[0].anchor = { utf8ByteStart: 7, utf8ByteEnd: 7 + bytes.length, excerptHash: historyContentSha256(bytes) };
  const plan = planHistory(value.input, await auditHistory(value.input, value.port));
  const unit = plan.units.find(unit => unit.phase === "evidence" && unit.sources[0].sourceRef === value.sources[0].sourceRef)!;
  const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [{ excerpt: bytes, total_bytes: 7 + bytes.length }], rowCount: 1 }));
  const store = new HistoryPostgresLockedStore({ query, release() {} } as unknown as HistoryPgClient, {} as HistoryPostgresStoreOptions);
  return { store, query, unit, plan, bytes };
}
describe("P16 anchored evidence reader", () => {
  it("reads only reviewed byte ranges and preserves exact UTF-8 content", async () => {
    const h = await fixture("明确例外：本条不适用于生产。");
    expect(await readHistoryAnchoredEvidence(h.store, h.plan, h.unit)).toBe(h.bytes.toString("utf8"));
    expect(h.query.mock.calls[0]).toEqual([expect.stringContaining("substring(convert_to(text,'UTF8')"), ["source-a", 7, h.bytes.length, "1"]]);
    expect(h.query.mock.calls[0][0]).not.toContain("SELECT text");
  });
  it("does not read a source without a reviewed anchor", async () => {
    const h = await fixture(); delete h.unit.bindings[0].anchor;
    await expect(readHistoryAnchoredEvidence(h.store, h.plan, h.unit)).rejects.toThrow("HISTORY_ANCHOR_REQUIRED");
    expect(h.query).not.toHaveBeenCalled();
  });
  it("rejects hash drift, truncated reads, and anchors outside the source", async () => {
    const h = await fixture();
    h.query.mockResolvedValue({ rows: [{ excerpt: Buffer.from("different"), total_bytes: 99 }], rowCount: 1 });
    await expect(readHistoryAnchoredEvidence(h.store, h.plan, h.unit)).rejects.toThrow("HISTORY_EVIDENCE_ANCHOR_DRIFT");
    h.query.mockResolvedValue({ rows: [{ excerpt: h.bytes, total_bytes: 1 }], rowCount: 1 });
    await expect(readHistoryAnchoredEvidence(h.store, h.plan, h.unit)).rejects.toThrow("HISTORY_EVIDENCE_ANCHOR_DRIFT");
  });
  it("rejects an oversized anchor before any source query", async () => {
    const h = await fixture(); h.unit.bindings[0].anchor!.utf8ByteEnd = 20000;
    await expect(readHistoryAnchoredEvidence(h.store, h.plan, h.unit)).rejects.toThrow("HISTORY_EVIDENCE_BYTE_BUDGET");
    expect(h.query).not.toHaveBeenCalled();
  });
});

function rawFixture() {
  const value = historyFixture(), scope = { ...value.scope, workspaceId: "fixture-workspace", sessionId: "fixture-session" };
  const source = { ...value.sources[0], scopeFingerprint: authorityScopeFingerprint(scope) };
  const metadata = { admissionRoute: "evidence_only", contextEligible: false, sessionId: scope.sessionId };
  const memory: MemoryRecord = { id: "raw-fixture", scope, text: "Reviewed visible excerpt", contentHash: "synthetic-hash", kind: "observation", category: "other", dataType: "memory", container: "session_candidate", lifecycleStatus: "archived", importance: 0, confidence: 0, createdAt: 1, metadata, provenance: { source: "synthetic-offline-fixture" } };
  const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [{ id: memory.id }], rowCount: 1 }));
  const client = { query, release() {} } as unknown as HistoryPgClient;
  return { memory, source, metadata, query, client };
}

describe("P16 raw evidence offline SQL contract", () => {
  it("uses a non-null opaque vector carrier but clears queryability, with source revision and all scope predicates", async () => {
    const h = rawFixture();
    await insertHistoryRawEvidence(h.client, h.memory, h.source, { ...h.metadata, embeddingSpaceId: "stale-space", embeddingSpaceState: "known-queryable" }, 100);
    expect(h.query).toHaveBeenCalledTimes(1);
    const [sql, values] = h.query.mock.calls[0];
    expect(sql).toContain("original.vector"); expect(sql).toContain("original.vector IS NOT NULL");
    expect(sql).toContain("NULL,'unknown-unqueryable'");
    for (const field of ["tenant_id", "user_id", "canonical_project_id", "product_id", "producer_id", "namespace", "visibility", "workspace_id", "metadata->>'sessionId'", "xmin::text"]) expect(sql).toContain(`original.${field}`);
    expect(values?.slice(7)).toEqual(["fixture-tenant", "fixture-user", "fixture-project", "fixture-app", "fixture-agent", "fixture", "private", "fixture-workspace", h.source.scopeFingerprint, "source-a", "1", "fixture-session"]);
    expect(JSON.parse(String(values?.[5]))).toEqual({ ...h.metadata, embeddingSpaceId: null, embeddingSpaceState: "unknown-unqueryable" });
    expect(sql).not.toContain("RETURNING vector"); expect(sql).not.toContain("UPDATE");
  });
  it("a missing or revision/scope-mismatched source stops instead of inventing a vector", async () => {
    const h = rawFixture(); h.query.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(insertHistoryRawEvidence(h.client, h.memory, h.source, h.metadata, 100)).rejects.toThrow("HISTORY_RAW_INSERT_FAILED");
    expect(h.query).toHaveBeenCalledTimes(1);
  });
  it("refuses active/context-eligible/cross-owner or unknown-source records before any SQL", async () => {
    const h = rawFixture();
    await expect(insertHistoryRawEvidence(h.client, { ...h.memory, lifecycleStatus: "active" }, h.source, h.metadata, 100)).rejects.toThrow("HISTORY_RAW_RECORD_INVALID");
    await expect(insertHistoryRawEvidence(h.client, h.memory, h.source, { ...h.metadata, contextEligible: true }, 100)).rejects.toThrow("HISTORY_RAW_RECORD_INVALID");
    await expect(insertHistoryRawEvidence(h.client, { ...h.memory, scope: { ...h.memory.scope, userId: "other-owner" } }, h.source, h.metadata, 100)).rejects.toThrow("HISTORY_RAW_RECORD_INVALID");
    await expect(insertHistoryRawEvidence(h.client, h.memory, { ...h.source, sourceRef: "unrecognized:source" }, h.metadata, 100)).rejects.toThrow("HISTORY_RAW_RECORD_INVALID");
    expect(h.query).not.toHaveBeenCalled();
  });
});
