import { historyHash, historyJson, isHash, rejectHistory } from "./schema.js";
import type { HistoryPgClient } from "./postgres-read.js";
import type { HistoryPlan, HistoryPlanUnit } from "./types.js";

const KEYS = {
  memories: ["id"], knowledge: ["id"],
  mengshu_write_receipts: ["storage_key"],
  mengshu_write_outbox: ["event_id"],
  mengshu_forget_receipts: ["idempotency_key"],
  mengshu_forget_outbox: ["event_id"],
  mengshu_memory_evidence_links: ["link_id"],
  mengshu_memory_lineage_heads: ["scope_fingerprint", "lineage_id"],
  mengshu_memory_version_transition_receipts: ["scope_fingerprint", "idempotency_key"],
  mengshu_memory_version_outbox: ["event_id"],
  mengshu_governed_document_bindings: ["scope_fingerprint", "vault_id", "asset_id"],
  mengshu_governed_document_complete_heads: ["scope_fingerprint", "asset_id"],
  mengshu_governed_document_sync_receipts: ["receipt_id"],
  mengshu_asset_versions: ["scope_fingerprint", "asset_id", "version"],
  mengshu_asset_heads: ["scope_fingerprint", "asset_id"],
} as const;
export type HistoryJournalTable = keyof typeof KEYS;
export interface HistoryJournalSelection { table: HistoryJournalTable; keys: Record<string, string> }
interface CapturedRow { selection: HistoryJournalSelection; before: Record<string, unknown> | null; afterHash: string }
interface Journal { schema: "mengshu.history-p16-undo/v1"; runId: string; unitId: string; rows: CapturedRow[]; beforeHash: string; afterHash: string; hash: string }
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const CHUNK = 6000;
const safe = (selection: HistoryJournalSelection) => {
  if (!Object.hasOwn(KEYS, selection.table) || Object.keys(selection.keys).length !== KEYS[selection.table].length ||
      KEYS[selection.table].some(key => typeof selection.keys[key] !== "string" || !selection.keys[key].length || selection.keys[key].length > 512)) rejectHistory("HISTORY_JOURNAL_SELECTION_INVALID");
};
const predicate = (selection: HistoryJournalSelection) => Object.keys(selection.keys).map((key, i) => `"${key}"::text=$${i + 1}`).join(" AND ");
const stateHash = (rows: readonly { selection: HistoryJournalSelection; value: unknown }[]) => historyHash(rows);
const keyFor = (plan: HistoryPlan, unit: HistoryPlanUnit, part: number) => `history:undo:${historyHash([plan.input.runId, unit.id, part])}`;

/** Exact-key compensation log in the existing operation receipt journal, never a second fact store. */
export class HistoryPostgresJournal {
  private captured: { selection: HistoryJournalSelection; before: Record<string, unknown> | null }[] = [];
  constructor(private readonly client: HistoryPgClient, private readonly plan: HistoryPlan, private readonly unit: HistoryPlanUnit) {}
  async capture(selection: HistoryJournalSelection): Promise<void> {
    safe(selection);
    if (this.captured.some(row => historyHash(row.selection) === historyHash(selection))) return;
    if (this.captured.length >= 256) rejectHistory("HISTORY_JOURNAL_BUDGET");
    const before = await this.read(selection, true);
    this.captured.push({ selection: structuredClone(selection), before });
    if (Buffer.byteLength(historyJson(this.captured)) > MAX_JOURNAL_BYTES) rejectHistory("HISTORY_JOURNAL_BUDGET");
  }
  private async read(selection: HistoryJournalSelection, lock = false): Promise<Record<string, unknown> | null> {
    safe(selection);
    const result = await this.client.query(`/* history:journal-row */ SELECT to_jsonb(owned.*) AS payload FROM "${selection.table}" owned WHERE ${predicate(selection)}${lock ? " FOR UPDATE" : ""}`, Object.values(selection.keys));
    if (result.rows.length > 1) rejectHistory("HISTORY_JOURNAL_IDENTITY_CONFLICT");
    return result.rows[0]?.payload as Record<string, unknown> ?? null;
  }
  async finish(now: number): Promise<{ beforeHash: string; afterHash: string }> {
    const current: { selection: HistoryJournalSelection; value: Record<string, unknown> | null }[] = [];
    for (const row of this.captured) current.push({ selection: row.selection, value: await this.read(row.selection) });
    const beforeHash = stateHash(this.captured.map(row => ({ selection: row.selection, value: row.before }))), afterHash = stateHash(current);
    const body = { schema: "mengshu.history-p16-undo/v1" as const, runId: this.plan.input.runId, unitId: this.unit.id,
      rows: this.captured.map((row, i) => ({ ...row, afterHash: historyHash(current[i].value) })), beforeHash, afterHash };
    const json = historyJson({ ...body, hash: historyHash(body) });
    if (Buffer.byteLength(json) > MAX_JOURNAL_BYTES) rejectHistory("HISTORY_JOURNAL_BUDGET");
    const chunks = Math.ceil(json.length / CHUNK);
    for (let part = 0; part < chunks; part++) {
      const receipt = JSON.stringify({ chunks, part, hash: historyHash(json), text: json.slice(part * CHUNK, (part + 1) * CHUNK) });
      if (Buffer.byteLength(receipt) > 30000) rejectHistory("HISTORY_JOURNAL_BUDGET");
      const saved = await this.client.query(`/* history:journal-save */ INSERT INTO mengshu_evolution_operation_receipts
        (scope_fingerprint,idempotency_key,request_hash,operation,receipt,created_at) VALUES ($1,$2,$3,'history_undo',$4::jsonb,$5)
        ON CONFLICT (scope_fingerprint,idempotency_key) DO NOTHING RETURNING idempotency_key`, [this.unit.scopeFingerprint, keyFor(this.plan, this.unit, part), this.plan.hash, receipt, now]);
      if (saved.rows.length !== 1) rejectHistory("HISTORY_JOURNAL_CONFLICT");
    }
    return { beforeHash, afterHash };
  }
  private async load(): Promise<Journal> {
    let json = "", expectedHash = "", count = 1;
    for (let part = 0; part < count; part++) {
      const result = await this.client.query(`/* history:journal-load */ SELECT receipt,request_hash FROM mengshu_evolution_operation_receipts WHERE scope_fingerprint=$1 AND idempotency_key=$2`, [this.unit.scopeFingerprint, keyFor(this.plan, this.unit, part)]);
      const row = result.rows[0], chunk = row?.receipt as { chunks: number; part: number; hash: string; text: string } | undefined;
      if (!chunk || row.request_hash !== this.plan.hash || !Number.isSafeInteger(chunk.chunks) || chunk.chunks < 1 || chunk.chunks > 800 || chunk.part !== part || typeof chunk.text !== "string" || chunk.text.length > CHUNK || !isHash(chunk.hash)) rejectHistory("HISTORY_JOURNAL_CORRUPT");
      if (part === 0) { count = chunk.chunks; expectedHash = chunk.hash; }
      if (chunk.hash !== expectedHash || chunk.chunks !== count) rejectHistory("HISTORY_JOURNAL_CORRUPT");
      json += chunk.text;
      if (Buffer.byteLength(json) > MAX_JOURNAL_BYTES) rejectHistory("HISTORY_JOURNAL_BUDGET");
    }
    if (historyHash(json) !== expectedHash) rejectHistory("HISTORY_JOURNAL_CORRUPT");
    const journal = JSON.parse(json) as Journal, { hash, ...body } = journal;
    if (hash !== historyHash(body) || journal.runId !== this.plan.input.runId || journal.unitId !== this.unit.id || journal.schema !== "mengshu.history-p16-undo/v1") rejectHistory("HISTORY_JOURNAL_CORRUPT");
    return journal;
  }
  async verify(expected: { beforeStateHash: string; afterStateHash: string }): Promise<boolean> {
    const journal = await this.load();
    if (journal.beforeHash !== expected.beforeStateHash || journal.afterHash !== expected.afterStateHash) return false;
    for (const row of journal.rows) if (historyHash(await this.read(row.selection)) !== row.afterHash) return false;
    return true;
  }
  async rollback(expected: { beforeStateHash: string; afterStateHash: string }): Promise<string> {
    const journal = await this.load();
    if (journal.beforeHash !== expected.beforeStateHash || journal.afterHash !== expected.afterStateHash) rejectHistory("HISTORY_ROLLBACK_JOURNAL_MISMATCH");
    for (const row of journal.rows) if (historyHash(await this.read(row.selection, true)) !== row.afterHash) rejectHistory("HISTORY_ROLLBACK_CAS_FAILED");
    for (const row of [...journal.rows].reverse()) {
      const { table, keys } = row.selection;
      if (row.before === null) {
        // Only rows proven absent before this P16 unit can be removed by compensation.
        await this.client.query(`/* history:undo-insert */ DELETE FROM "${table}" WHERE ${predicate(row.selection)}`, Object.values(keys));
      } else {
        const columns = (await this.client.query(`/* history:undo-columns */ SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 AND is_generated='NEVER' ORDER BY ordinal_position`, [table])).rows.map(item => String(item.column_name));
        if (!columns.length || columns.some(column => !/^[a-z_][a-z0-9_]*$/.test(column))) rejectHistory("HISTORY_ROLLBACK_SCHEMA_CHANGED");
        const mutable = columns.filter(column => !Object.hasOwn(keys, column));
        const sql = mutable.map(column => `"${column}"=original."${column}"`).join(",");
        const restored = await this.client.query(`/* history:undo-update */ UPDATE "${table}" current SET ${sql} FROM jsonb_populate_record(NULL::"${table}",$${Object.keys(keys).length + 1}::jsonb) original WHERE ${Object.keys(keys).map((key, i) => `current."${key}"::text=$${i + 1}`).join(" AND ")} RETURNING current.*`, [...Object.values(keys), JSON.stringify(row.before)]);
        if (restored.rows.length !== 1) rejectHistory("HISTORY_ROLLBACK_ROW_MISSING");
      }
    }
    const restored = [];
    for (const row of journal.rows) restored.push({ selection: row.selection, value: await this.read(row.selection) });
    if (stateHash(restored) !== journal.beforeHash) rejectHistory("HISTORY_ROLLBACK_NOT_RESTORED");
    return journal.beforeHash;
  }
}
