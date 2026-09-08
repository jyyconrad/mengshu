import { describe, expect, it } from "vitest";
import { historySemanticPayload, historySemanticSql } from "./postgres-read.js";

const before35 = { id: "synthetic-source", text: "Only reviewed observations apply.", metadata: { confidence: 0.4, evidenceIds: ["original-root"] }, tenant_id: "owner", lifecycle_status: "pending" };

describe("history PostgreSQL semantic policy", () => {
  it("treats v37 exact default governance columns and derived text_tsv as the v35 payload", () => {
    expect(historySemanticPayload({ ...before35, evolution_review_due_at: 0, evolution_disputed: false, evolution_alias_of: null, text_tsv: "'reviewed':2" }))
      .toEqual(historySemanticPayload(before35));
    for (const expression of ["b.row_payload", "s.row_payload", "to_jsonb(m.*)", "source.row_payload"] as const) {
      const sql = historySemanticSql(expression);
      expect(sql).toContain(`(${expression})->'evolution_review_due_at' = '0'::jsonb THEN ARRAY['evolution_review_due_at']::text[] ELSE ARRAY[]::text[] END`);
      expect(sql).toContain(`(${expression})->'evolution_disputed' = 'false'::jsonb THEN ARRAY['evolution_disputed']::text[] ELSE ARRAY[]::text[] END`);
      expect(sql).toContain("'text_tsv'");
    }
  });
  it.each([
    { evolution_disputed: true }, { evolution_review_due_at: 1788652800000 }, { evolution_alias_of: "another-record" },
    { evolution_disputed: "false" }, { evolution_review_due_at: "0" }, { unknown_governance: false },
    { text: "All observations apply." }, { tenant_id: "other-owner" }, { metadata: { confidence: 0.8 } },
  ])("keeps actual semantic changes in the witness: %j", change => {
    expect(historySemanticPayload({ ...before35, ...change })).not.toEqual(historySemanticPayload(before35));
  });
  it("detects dispute reversal, changed deadlines, and deadline removal directionally", () => {
    const disputed = { ...before35, evolution_disputed: true, evolution_review_due_at: 10 };
    for (const change of [{ evolution_disputed: false }, { evolution_review_due_at: 11 }, { evolution_review_due_at: 0 }]) {
      expect(historySemanticPayload({ ...disputed, ...change })).not.toEqual(historySemanticPayload(disputed));
    }
  });
  it("ignores only known operational metadata while preserving evidence and governance", () => {
    expect(historySemanticPayload({ ...before35, metadata: { ...before35.metadata, accessCount: 9, hotness: 0.9 }, text_tsv: "derived" })).toEqual(historySemanticPayload(before35));
    expect(historySemanticPayload({ ...before35, metadata: { ...before35.metadata, evolution: { disputed: true } } })).not.toEqual(historySemanticPayload(before35));
  });
  it("does not accept caller SQL expressions", () => {
    expect(() => historySemanticSql("caller.expression" as "b.row_payload")).toThrow("HISTORY_PG_EXPRESSION_INVALID");
  });
});
