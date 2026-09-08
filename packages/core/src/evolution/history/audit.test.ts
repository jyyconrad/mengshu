import { describe, expect, it } from "vitest";
import { historyFixture } from "../../../../../tests/fixtures/evolution-history/fixture.js";
import { auditHistory } from "./audit.js";
import { planHistory } from "./plan.js";
import { historyHash, parseHistoryInput } from "./schema.js";

describe("P16 immutable continuation audit and plan", () => {
  it("rejects P15 rerun, unknown fields, forged hashes and unbounded input", () => {
    const { input } = historyFixture();
    expect(parseHistoryInput(input)).toEqual(input);
    for (const bad of [{ ...input, runId: input.parentRunId }, { ...input, production: true }, { ...input, parentReceiptHash: "yes" }, { ...input, limits: { ...input.limits, pageSize: 1001 } }]) expect(() => parseHistoryInput(bad)).toThrow("HISTORY_INPUT_INVALID");
  });
  it("explains every original source, keeps Knowledge distinct, and never selects outside rows", async () => {
    const f = historyFixture(), audit = await auditHistory(f.input, f.port), plan = planHistory(f.input, audit);
    expect(audit.unresolved).toEqual([]);
    expect(plan.sourceDispositions).toHaveLength(4);
    expect(plan.counts).toMatchObject({ memoryTargets: 1, knowledgeGroups: 1, rawEvidenceRoots: 2, archiveSources: 3, preservedSources: 1 });
    expect(plan.units.map(unit => unit.phase)).toEqual(["evidence", "evidence", "activate", "knowledge", "archive", "archive", "archive"]);
    expect(plan.units.find(unit => unit.phase === "activate")?.target?.semanticType).toBeUndefined();
    expect(plan.units.find(unit => unit.phase === "activate")?.confidenceCeiling).toBe(0.8);
    expect(plan.outsideCohortRows).toBe(7);
    expect(plan.outsideCohortHash).toBe(f.parent.outsideCohortHash);
    expect(plan.units.every(unit => unit.sources.every(source => f.sources.some(s => s.sourceRef === source.sourceRef)))).toBe(true);
  });
  it("distinguishes operational row drift from semantic drift without silently dropping a source", async () => {
    const f = historyFixture();
    f.sources[0].currentRowHash = historyHash("only-hotness-or-schema-changed");
    let audit = await auditHistory(f.input, f.port);
    expect(audit.operationalDriftRefs).toEqual([f.sources[0].sourceRef]);
    expect(planHistory(f.input, audit).counts.memoryTargets).toBe(1);
    f.sources[0].currentSemanticHash = historyHash("text-evidence-or-scope-changed");
    audit = await auditHistory(f.input, f.port);
    const plan = planHistory(f.input, audit);
    expect(plan.counts.memoryTargets).toBe(0);
    expect(plan.sourceDispositions.find(row => row.sourceRef === f.sources[0].sourceRef)?.action).toBe("review");
    expect(plan.unresolvedCount).toBe(0);
  });
  it.each(["pinned", "tombstoned"] as const)("holds %s targets and their sources", async key => {
    const f = historyFixture(); f.targets[0][key] = true;
    const plan = planHistory(f.input, await auditHistory(f.input, f.port));
    expect(plan.counts.memoryTargets).toBe(0);
    expect(plan.units.some(unit => unit.sources.some(source => source.targetMemoryIds.includes("canonical-a")))).toBe(false);
  });
  it("rejects missing mappings, cross-scope bindings, missing claims and duplicate source identity", async () => {
    for (const mutate of [
      (f: ReturnType<typeof historyFixture>) => { f.parent.mappings--; },
      (f: ReturnType<typeof historyFixture>) => { f.bindings[0].scopeFingerprint = historyHash("other-scope"); },
      (f: ReturnType<typeof historyFixture>) => { f.targets[0].claimIds.push("unmapped-claim"); },
      (f: ReturnType<typeof historyFixture>) => { f.sources[1].sourceRef = f.sources[0].sourceRef; },
    ]) {
      const f = historyFixture(); mutate(f);
      const audit = await auditHistory(f.input, f.port);
      expect(audit.unresolved.length).toBeGreaterThan(0);
      expect(planHistory(f.input, audit).unresolvedCount).toBeGreaterThan(0);
    }
  });
  it("duplicate roots remain one root and cannot increase confidence", async () => {
    const f = historyFixture(); f.bindings[1].rootEvidenceId = f.bindings[0].rootEvidenceId; f.bindings[1].independenceGroupId = f.bindings[0].independenceGroupId;
    const plan = planHistory(f.input, await auditHistory(f.input, f.port));
    expect(plan.counts.rawEvidenceRoots).toBe(1);
    expect(plan.units.find(unit => unit.phase === "activate")?.confidenceCeiling).toBe(f.targets[0].confidence);
  });
  it("never guesses Knowledge resource identity or converts unknown disposition to archive", async () => {
    const f = historyFixture(); delete f.sources[2].knowledgeIdentity;
    f.sources[3].operation = "delete_everything";
    const plan = planHistory(f.input, await auditHistory(f.input, f.port));
    expect(plan.counts.knowledgeGroups).toBe(0);
    expect(plan.unresolvedCount).toBeGreaterThan(0);
    expect(plan.sourceDispositions.find(row => row.sourceRef === f.sources[3].sourceRef)?.action).toBe("review");
  });
  it("bounded pagination rejects stuck cursors and parent drift", async () => {
    const f = historyFixture();
    f.port.readSources = async () => ({ rows: [f.sources[0]], next: f.sources[0].sourceRef });
    await expect(auditHistory(f.input, f.port)).rejects.toThrow("HISTORY_CURSOR_INVALID");
    const other = historyFixture(); let calls = 0;
    other.port.readParent = async () => ({ ...other.parent, receiptHash: calls++ ? historyHash("changed") : other.parent.receiptHash });
    await expect(auditHistory(other.input, other.port)).rejects.toThrow("HISTORY_PARENT_DRIFT");
  });
  it("rejects same-count outside row changes during audit, including self-declared run metadata", async () => {
    const f = historyFixture(); let calls = 0;
    f.port.readParent = async () => ({ ...f.parent, outsideCohortHash: calls++ ? historyHash("outside text or spoofed historyP16 changed") : f.parent.outsideCohortHash });
    await expect(auditHistory(f.input, f.port)).rejects.toThrow("HISTORY_PARENT_DRIFT");
  });
});
