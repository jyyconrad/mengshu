import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DirectorySourceScanner } from "../../packages/core/src/evolution/sources/index.js";
import { planSourceReconciliation } from "../../packages/core/src/evolution/sources/reconciliation.js";
import type { SourceScanReport } from "../../packages/core/src/evolution/sources/types.js";
import { planEquivalentMerge } from "../../packages/core/src/evolution/maintenance/merge.js";
import { evolutionHash } from "../../packages/core/src/evolution/fingerprints.js";
import type { EquivalentClaim } from "../../packages/core/src/evolution/maintenance/types.js";
import { GovernedSkillAggregationService } from "../../packages/core/src/evolution/maintenance/skill-aggregation.js";
import { InMemorySkillCandidateRepository } from "../../packages/core/src/lifecycle/skill-candidate-repository.js";
import { InMemorySkillArtifactRepository } from "../../packages/core/src/skills/in-memory-repository.js";
import { SkillArtifactService } from "../../packages/core/src/skills/skill-artifact-service.js";
import { HISTORY_EVENTS, MARKDOWN_REVISIONS, ROLLOUT_SCOPE, historyJsonl } from "../fixtures/memory-evolution-rollout/source-corpus.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function scannerFixture(parser: "markdown" | "codex-jsonl", contents: string) {
  const temp = await mkdtemp(join(tmpdir(), "rollout-reconcile-"));
  cleanups.push(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, "source");
  await mkdir(root);
  const path = join(root, parser === "markdown" ? "policy.md" : "history.jsonl");
  await writeFile(path, contents);
  const scanner = await DirectorySourceScanner.create({
    binding: { sourceId: "rollout-reconcile", root, scope: ROLLOUT_SCOPE, parser },
    manifestPath: join(temp, "state", "manifest.json"),
  });
  cleanups.push(() => scanner.close());
  const confirmFixture = (report: SourceScanReport) => scanner.confirm(report, {
    receiptId: `synthetic-manifest-only:${report.scanId}`, sourceSnapshotHash: report.sourceSnapshotHash,
    recordIds: report.records.map(record => record.id),
  });
  return { path, root, manifestPath: join(temp, "state", "manifest.json"), scanner, confirmFixture };
}

describe("E3 source scanner -> reconciliation plans (no database mutation)", () => {
  test("S09/S18: removing an assertion differs from deleting a source and neither fabricates an explicit revoke", async () => {
    const h = await scannerFixture("markdown", MARKDOWN_REVISIONS.before);
    // Fixture acknowledgements only establish a previous manifest, not real DB receipts or canonical writes.
    await h.confirmFixture(await h.scanner.scan());
    await writeFile(h.path, MARKDOWN_REVISIONS.assertionRemoved);
    const removed = await h.scanner.scan();
    const changed = planSourceReconciliation(ROLLOUT_SCOPE, removed);
    expect(changed.events).toContainEqual(expect.objectContaining({ kind: "supersede_spans", semantics: "current_document", requestReview: true }));
    expect(changed.events.every(event => event.preserveHistoricalEvidence)).toBe(true);
    await h.confirmFixture(removed);
    await rm(h.path);
    const absent = planSourceReconciliation(ROLLOUT_SCOPE, await h.scanner.scan());
    expect(absent.events).toContainEqual(expect.objectContaining({ kind: "source_unavailable", requestReview: true, preserveHistoricalEvidence: true }));
    expect(absent.events.some(event => event.kind === "supersede_spans")).toBe(false);
    expect(JSON.stringify(absent)).not.toContain("reviewReceiptId");
  });

  test("S09: rotating append history never supersedes its prior historical claims", async () => {
    const h = await scannerFixture("codex-jsonl", historyJsonl(2));
    await h.confirmFixture(await h.scanner.scan());
    await writeFile(h.path, JSON.stringify(HISTORY_EVENTS[2]) + "\n");
    const plan = planSourceReconciliation(ROLLOUT_SCOPE, await h.scanner.scan());
    expect(plan.events.every(event => event.semantics === "append_history" && event.preserveHistoricalEvidence)).toBe(true);
    expect(plan.events.some(event => event.kind === "supersede_spans")).toBe(false);
    expect(plan.events.some(event => event.kind === "history_rotated" || event.kind === "history_revised")).toBe(true);
  });

  test.each([{ maxFiles: 1 }, { maxEntries: 1 }])("S09/R08: deletion-only full-file results survive globally partial enumeration: %j", async limits => {
    const h = await scannerFixture("markdown", "Old policy.\n\nKeep policy.\n");
    await writeFile(join(h.root, "second.md"), "Old second.\n\nKeep second.\n");
    const initial = await h.scanner.scan();
    await h.confirmFixture(initial);
    const firstFile = initial.files[0].relativePath;
    const removed = initial.records.find(record => record.relativePath === firstFile && record.quote.startsWith("Old "))!;
    const kept = initial.records.find(record => record.relativePath === firstFile && record.quote.startsWith("Keep "))!;
    await writeFile(join(h.root, firstFile), `${kept.quote}\n`);
    const partial = await h.scanner.scan({ limits });
    expect(partial.enumerationComplete).toBe(false);
    expect(partial.records).toEqual([]);
    const plan = planSourceReconciliation(ROLLOUT_SCOPE, partial);
    expect(plan.events).toContainEqual(expect.objectContaining({ kind: "supersede_spans", spanIds: [removed.spanOrEventId] }));
    expect(plan.events.some(event => event.kind === "source_unavailable")).toBe(false);
    const beforeAck = JSON.parse(await readFile(h.manifestPath, "utf8"));
    expect(beforeAck.files[removed.pathId].spans[removed.spanOrEventId]).toBeDefined();
    // This confirms only scanner persistence. No claim is made that a real PG support row was retired.
    await h.confirmFixture(partial);
    const afterAck = JSON.parse(await readFile(h.manifestPath, "utf8"));
    expect(afterAck.files[removed.pathId].spans[removed.spanOrEventId]).toBeUndefined();
    const nextBatch = await h.scanner.scan({ limits });
    expect(nextBatch.files[0].status).toBe("unchanged");
    expect(planSourceReconciliation(ROLLOUT_SCOPE, nextBatch).events.some(event => event.kind === "supersede_spans")).toBe(false);
  });
});

describe("E3 bounded governance, no fake successful Skill evaluator", () => {
  function claim(id: string): EquivalentClaim {
    return { memoryId: id, revision: 1, contentHash: evolutionHash("The release requires approval."), scope: ROLLOUT_SCOPE,
      subject: "release", predicate: "requires", object: "approval", applicability: ["when audit is available"], polarity: "positive",
      verificationReceiptId: `synthetic-equivalence-proof:${id}`, evidenceRootIds: ["same-original-root"], confidence: 0.7 };
  }
  test("E3-MAINT/S20: exact merge conserves confidence and refuses lost conditions, polarity or scope", () => {
    const left = claim("claim-a");
    const right = claim("claim-b");
    const merged = planEquivalentMerge(left, right);
    expect(merged).toMatchObject({ status: "allowed", plan: { confidenceCeiling: 0.7, preserveAliases: true } });
    for (const unsafe of [
      { ...right, applicability: ["always"] }, { ...right, polarity: "negative" as const },
      { ...right, scope: { ...right.scope, userId: "other-owner" } }, { ...right, verificationReceiptId: undefined },
    ]) expect(planEquivalentMerge(left, unsafe)).toMatchObject({ status: "review" });
  });

  test("E3-MAINT/E4-BEHAVIOR: missing real target evaluator blocks before source access or Skill draft creation", async () => {
    const candidates = new InMemorySkillCandidateRepository();
    const artifacts = new SkillArtifactService({ candidates, repository: new InMemorySkillArtifactRepository(),
      evidence: { validate: async () => ({ readable: false }) } });
    const read = vi.fn(async () => ({ experiences: [] }));
    const draft = vi.spyOn(artifacts, "proposeFromCandidate");
    const service = new GovernedSkillAggregationService({ source: { readPage: read, verify: async () => ({ valid: false }) }, candidates, artifacts });
    expect(await service.run(ROLLOUT_SCOPE)).toMatchObject({ errors: ["skill_gate_unavailable"], drafts: [], skillCandidates: [] });
    expect(read).not.toHaveBeenCalled();
    expect(draft).not.toHaveBeenCalled();
    expect(await candidates.list()).toEqual([]);
  });
});
