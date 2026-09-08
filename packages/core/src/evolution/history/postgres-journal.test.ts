import { describe, expect, it } from "vitest";
import { historyFixture } from "../../../../../tests/fixtures/evolution-history/fixture.js";
import { auditHistory } from "./audit.js";
import { planHistory } from "./plan.js";
import { HistoryPostgresJournal } from "./postgres-journal.js";
import type { HistoryPgClient } from "./postgres-read.js";

async function fixture() {
  const value = historyFixture(), plan = planHistory(value.input, await auditHistory(value.input, value.port)), unit = plan.units[0];
  const rows = new Map<string, Record<string, unknown>>(), receipts = new Map<string, { receipt: unknown; request_hash: string }>(), sql: string[] = [];
  const client = { query: async (query: string, values: readonly unknown[] = []) => {
    sql.push(query);
    if (query.includes("history:journal-row")) { const row = rows.get(String(values[0])); return { rows: row ? [{ payload: structuredClone(row) }] : [] }; }
    if (query.includes("history:journal-save")) { receipts.set(String(values[1]), { request_hash: String(values[2]), receipt: JSON.parse(String(values[3])) }); return { rows: [{ idempotency_key: values[1] }] }; }
    if (query.includes("history:journal-load")) { const receipt = receipts.get(String(values[1])); return { rows: receipt ? [receipt] : [] }; }
    if (query.includes("history:undo-columns")) return { rows: ["id", "text", "lifecycle_status"].map(column_name => ({ column_name })) };
    if (query.includes("history:undo-update")) { const row = JSON.parse(String(values.at(-1))); rows.set(String(values[0]), row); return { rows: [row] }; }
    if (query.includes("history:undo-insert")) { rows.delete(String(values[0])); return { rows: [] }; }
    throw new Error("Unexpected synthetic journal query");
  }, release() {} } as unknown as HistoryPgClient;
  return { rows, receipts, sql, journal: new HistoryPostgresJournal(client, plan, unit) };
}
describe("history exact-row compensation journal (offline SQL harness)", () => {
  it("restores only captured updates and own inserts; unrelated rows survive", async () => {
    const h = await fixture(); h.rows.set("owned", { id: "owned", text: "before", lifecycle_status: "pending" }); h.rows.set("outside", { id: "outside", text: "untouched" });
    await h.journal.capture({ table: "memories", keys: { id: "owned" } });
    await h.journal.capture({ table: "memories", keys: { id: "new" } });
    h.rows.set("owned", { id: "owned", text: "after", lifecycle_status: "active" }); h.rows.set("new", { id: "new", text: "raw" });
    const state = await h.journal.finish(1), receipt = { beforeStateHash: state.beforeHash, afterStateHash: state.afterHash };
    expect(await h.journal.verify(receipt)).toBe(true);
    expect(await h.journal.rollback(receipt)).toBe(state.beforeHash);
    expect(h.rows.get("owned")?.text).toBe("before"); expect(h.rows.has("new")).toBe(false); expect(h.rows.get("outside")?.text).toBe("untouched");
  });
  it("stops rollback before any write if a captured row changed after commit", async () => {
    const h = await fixture(); await h.journal.capture({ table: "memories", keys: { id: "owned" } }); h.rows.set("owned", { id: "owned", text: "committed" });
    const state = await h.journal.finish(1); h.rows.set("owned", { id: "owned", text: "newer-write" });
    await expect(h.journal.rollback({ beforeStateHash: state.beforeHash, afterStateHash: state.afterHash })).rejects.toThrow("HISTORY_ROLLBACK_CAS_FAILED");
    expect(h.sql.some(sql => sql.includes("history:undo-insert") || sql.includes("history:undo-update"))).toBe(false);
  });
  it("rejects unknown tables/keys before interpolating SQL", async () => {
    const h = await fixture();
    await expect(h.journal.capture({ table: "memories", keys: { "id;DELETE": "x" } })).rejects.toThrow("HISTORY_JOURNAL_SELECTION_INVALID");
    expect(h.sql).toHaveLength(0);
  });
  it("chunks large Unicode before-images below the real receipt limit and verifies chunk hashes", async () => {
    const h = await fixture(); h.rows.set("owned", { id: "owned", text: "资料".repeat(20000), lifecycle_status: "pending" });
    await h.journal.capture({ table: "memories", keys: { id: "owned" } }); h.rows.set("owned", { id: "owned", text: "changed" });
    const state = await h.journal.finish(1);
    expect(h.receipts.size).toBeGreaterThan(1);
    expect([...h.receipts.values()].every(row => Buffer.byteLength(JSON.stringify(row.receipt)) <= 30000)).toBe(true);
    const chunk = [...h.receipts.values()][0].receipt as { text: string }; chunk.text += "drift";
    await expect(h.journal.verify({ beforeStateHash: state.beforeHash, afterStateHash: state.afterHash })).rejects.toThrow("HISTORY_JOURNAL_CORRUPT");
  });
});
