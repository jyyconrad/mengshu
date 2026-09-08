import { describe, expect, it, vi } from "vitest";
import { InMemorySkillCandidateRepository } from "../../lifecycle/skill-candidate-repository.js";
import { InMemorySkillArtifactRepository } from "../../skills/in-memory-repository.js";
import { SkillArtifactService } from "../../skills/skill-artifact-service.js";
import { SkillCandidateAggregator } from "../../lifecycle/skill-candidate-aggregator.js";
import type { CandidateRepository } from "../../lifecycle/candidate-types.js";
import { compileExperiencePatterns, candidateFromPattern, skillCandidateContentHash } from "./patterns.js";
import { GovernedSkillAggregationService } from "./skill-aggregation.js";
import type { ExperienceSourcePort, SkillDraftGatePort, VerifiedExperience } from "./experience-types.js";

const scope = { tenantId: "t", appId: "a", userId: "u", projectId: "p", agentId: "g", namespace: "n", visibility: "private" as const };
const DAY = 86400000;
const now = 20 * DAY;
function experience(index: number, result: VerifiedExperience["outcome"]["result"] = "success"): VerifiedExperience {
  const evidenceId = `e${index}`;
  const quote = "staging releases\nrelease requested\nCI approved\nRun checksum verification\nDo not bypass approval\nChecksum matched\nChecksum mismatch";
  const q = (text: string) => ({ evidenceId, text });
  return { memoryId: `m${index}`, revision: "1", scope, topicLabel: "Release checks", occurredAt: index * DAY, confidence: 0.65,
    embedding: { model: "fixture-model", values: [1, 0, 1] },
    evidence: [{ id: evidenceId, rootEvidenceId: `r${index}`, independenceGroupId: `i${index}`, origin: "external", quote, revoked: false, verificationReceiptId: `result-receipt-${index}` }],
    outcome: { ...q(result === "success" ? "Checksum matched" : "Checksum mismatch"), result, observedAt: index * DAY },
    applicability: [q("staging releases")], triggers: [q("release requested")], preconditions: [q("CI approved")],
    steps: [q("Run checksum verification")], riskBoundaries: [q("Do not bypass approval")], highRisk: false };
}
const cohort = () => [0, 1, 2, 3, 4].map(i => experience(i, i === 4 ? "counterexample" : "success"));
function fixture(experiences = cohort(), gate?: SkillDraftGatePort) {
  const candidates = new InMemorySkillCandidateRepository({ now: () => now });
  const source: ExperienceSourcePort = { readPage: vi.fn(async () => ({ experiences, nextCursor: "next" })), verify: vi.fn(async () => ({ valid: true })) };
  const repository = new InMemorySkillArtifactRepository();
  const artifacts = new SkillArtifactService({ candidates, repository, evidence: { validate: vi.fn(async () => ({ readable: true })) }, now: () => now });
  const propose = vi.spyOn(artifacts, "proposeFromCandidate");
  const service = new GovernedSkillAggregationService({ source, candidates, artifacts, gate, now: () => now });
  return { source, candidates, artifacts, service, propose };
}
const passedGate: SkillDraftGatePort = { evaluate: async ({ pattern, candidateHash }) => ({ status: "passed", receiptId: "paired-eval-receipt", patternId: pattern.id, candidateHash,
  targetFingerprint: "resolved-model-tools-environment", policyVersion: "paired-v1", expiresAt: now + DAY }) };

describe("evidence-grounded experience patterns", () => {
  it("retains actual outcomes/counterexamples/conditions and does not increase confidence", () => {
    const result = compileExperiencePatterns(scope, cohort());
    expect(result.patterns).toHaveLength(1);
    const pattern = result.patterns[0];
    expect(pattern).toMatchObject({ successCount: 4, failureCount: 1, timeSpanDays: 4, confidenceCeiling: 0.65 });
    expect(pattern.similarity).toBeCloseTo(1);
    const candidate = candidateFromPattern(pattern, now);
    expect(candidate.confidence).toBe(0.65);
    expect(candidate.evidenceMemoryIds).toHaveLength(5);
    expect(candidate.evidenceChunkIds).toHaveLength(5);
    expect(candidate.antiPatterns.join(" ")).toContain("Checksum mismatch");
    expect(candidate.antiPatterns.join(" ")).toContain("staging releases");
    expect(candidate.metadata?.outcomes).toHaveLength(5);
    expect(candidate.steps).toEqual(["Run checksum verification"]);
  });

  it.each(["revoked", "summary", "no_receipt", "missing_quote", "no_embedding", "mixed_model", "scope", "incomplete"])("fails closed on %s", kind => {
    const items = cohort();
    if (kind === "revoked") items[0].evidence[0].revoked = true;
    if (kind === "summary") items[0].evidence[0].origin = "summary";
    if (kind === "no_receipt") delete items[0].evidence[0].verificationReceiptId;
    if (kind === "missing_quote") items[0].outcome.text = "unobserved success";
    if (kind === "no_embedding") delete items[0].embedding;
    if (kind === "mixed_model") items[0].embedding!.model = "another-model";
    if (kind === "scope") items[0].scope = { ...scope, userId: "other" };
    if (kind === "incomplete") items[0].contextIncomplete = true;
    expect(compileExperiencePatterns(scope, items).patterns).toHaveLength(0);
  });

  it("does not count duplicate roots/independence groups, close dates, failures or unrelated vectors as thresholds", () => {
    const duplicate = cohort();
    duplicate[1].evidence[0].rootEvidenceId = duplicate[0].evidence[0].rootEvidenceId;
    expect(compileExperiencePatterns(scope, duplicate).patterns).toHaveLength(0);
    const copies = cohort();
    copies[1].evidence[0].independenceGroupId = copies[0].evidence[0].independenceGroupId;
    expect(compileExperiencePatterns(scope, copies).patterns).toHaveLength(0);
    expect(compileExperiencePatterns(scope, cohort().map(e => ({ ...e, occurredAt: 0, outcome: { ...e.outcome, observedAt: 0 } }))).patterns).toHaveLength(0);
    expect(compileExperiencePatterns(scope, [0, 1, 2, 3, 4].map(i => experience(i, "failure"))).patterns).toHaveLength(0);
    expect(compileExperiencePatterns(scope, cohort().map((e, i) => ({ ...e, embedding: { model: "fixture-model", values: [0, 1, 2, 3, 4].map(j => i === j ? 1 : 0) } }))).patterns).toHaveLength(0);
  });

  it("separates applicability and refuses to flatten different procedures or truncate exception blocks", () => {
    const different = cohort();
    different[0].applicability = [{ evidenceId: "e0", text: "CI approved" }];
    expect(compileExperiencePatterns(scope, different).patterns).toHaveLength(0);
    const procedures = cohort();
    procedures[0].steps = [{ evidenceId: "e0", text: "Do not bypass approval" }];
    const pattern = compileExperiencePatterns(scope, procedures).patterns[0];
    expect(() => candidateFromPattern(pattern, now)).toThrow("mixed_procedures");
    const long = cohort();
    long[0].evidence[0].quote = "x".repeat(2049);
    expect(compileExperiencePatterns(scope, long).patterns).toHaveLength(0);
  });

  it("is deterministic and returns no self-derived confidence or inferred cause fields", () => {
    const first = compileExperiencePatterns(scope, cohort()).patterns[0];
    const second = compileExperiencePatterns(scope, cohort().reverse()).patterns[0];
    expect(first.id).toBe(second.id);
    expect(skillCandidateContentHash(candidateFromPattern(first, now))).toBe(skillCandidateContentHash(candidateFromPattern(second, now + 1)));
    expect(JSON.stringify(candidateFromPattern(first, now))).not.toContain("rootCause");
  });
});

describe("governed Skill aggregation", () => {
  it("reaches the real artifact service but only creates a review-required suggest-only draft", async () => {
    const f = fixture(cohort(), passedGate);
    const result = await f.service.run(scope, { limit: 10, cursor: "previous" });
    expect(f.source.readPage).toHaveBeenCalledWith({ scope, limit: 10, cursor: "previous", signal: undefined });
    expect(result.errors).toEqual([]);
    expect(result.drafts).toHaveLength(1);
    expect(result.nextCursor).toBe("next");
    expect(f.propose).toHaveBeenCalledTimes(1);
    const { artifact } = await f.artifacts.read({ scope, skillId: result.drafts[0].skillId });
    expect(artifact).toMatchObject({ status: "draft", executionMode: "suggest_only", evidenceMemoryIds: ["m0", "m1", "m2", "m3", "m4"] });
    expect(artifact.antiPatterns[0]).toContain("Checksum mismatch");
    expect((await f.service.run(scope)).drafts[0].skillId).toBe(artifact.skillId);
    expect(await f.candidates.list()).toHaveLength(1);
  });

  it("missing evaluator blocks before hydration and rejected compatibility never creates a candidate/draft", async () => {
    const missing = fixture();
    expect((await missing.service.run(scope)).errors).toContain("skill_gate_unavailable");
    expect(missing.source.readPage).not.toHaveBeenCalled();
    const denied = fixture(cohort(), { evaluate: vi.fn(async () => ({ status: "blocked" as const, reasonCode: "target_incompatible" })) });
    expect((await denied.service.run(scope)).errors).toContain("target_incompatible");
    expect(denied.propose).not.toHaveBeenCalled();
    expect(await denied.candidates.list()).toEqual([]);
  });

  it.each(["expired", "candidate_changed", "pattern_changed", "source_revoked", "throw"])("blocks on stale or unavailable gate: %s", async kind => {
    const gate: SkillDraftGatePort = { evaluate: async input => {
      if (kind === "throw") throw new Error("private provider body");
      const passed = await passedGate.evaluate(input);
      if (passed.status !== "passed") return passed;
      return { ...passed, expiresAt: kind === "expired" ? now : passed.expiresAt, candidateHash: kind === "candidate_changed" ? "other" : passed.candidateHash, patternId: kind === "pattern_changed" ? "other" : passed.patternId };
    } };
    const f = fixture(cohort(), gate);
    if (kind === "source_revoked") f.source.verify = vi.fn(async () => ({ valid: false }));
    const result = await f.service.run(scope);
    expect(result.drafts).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain("private provider body");
    expect(f.propose).not.toHaveBeenCalled();
  });

  it("never resurrects a rejected candidate, and enforces bounded pages and cancellation", async () => {
    const f = fixture(cohort(), passedGate);
    const initial = await f.service.run(scope);
    await f.candidates.updateStatus(initial.skillCandidates[0].id, "rejected");
    f.propose.mockClear();
    expect((await f.service.run(scope)).errors).toContain("skill_candidate_ineligible");
    expect(f.propose).not.toHaveBeenCalled();
    expect((await f.service.run(scope, { limit: 4 })).errors).toContain("experience_page_overflow");
    expect((await f.service.run(scope, { signal: AbortSignal.abort() })).errors).toContain("cancelled");
    await expect(f.service.run(scope, { limit: 101 })).rejects.toThrow("limit");
  });

  it("defers excess patterns without invoking another evaluator and supports cancellation after hydration", async () => {
    const second = cohort().map(e => ({ ...e, memoryId: `${e.memoryId}-other`, topicLabel: "Other procedure" }));
    const evaluate = vi.fn(passedGate.evaluate);
    const f = fixture([...cohort(), ...second], { evaluate });
    const result = await f.service.run(scope, { maxDrafts: 1 });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(result.drafts).toHaveLength(1);
    expect(result.deferredPatternIds).toHaveLength(1);
    const cancelled = fixture(cohort(), { evaluate });
    const controller = new AbortController();
    cancelled.source.readPage = vi.fn(async () => { controller.abort(); return { experiences: cohort() }; });
    const stopped = await cancelled.service.run(scope, { signal: controller.signal });
    expect(stopped.deferredPatternIds).toHaveLength(1);
    expect(stopped.errors).toContain("cancelled");
    expect(cancelled.propose).not.toHaveBeenCalled();
  });

  it("reconciles an uncertain candidate create by its stable id and never invents a replacement", async () => {
    const f = fixture(cohort(), passedGate);
    const create = f.candidates.create.bind(f.candidates);
    const createSpy = vi.spyOn(f.candidates, "create").mockImplementation(async body => { await create(body); throw new Error("network acknowledgement lost"); });
    expect((await f.service.run(scope)).drafts).toHaveLength(1);
    expect(createSpy).toHaveBeenCalledTimes(1);
    const absent = fixture(cohort(), passedGate);
    vi.spyOn(absent.candidates, "create").mockRejectedValue(new Error("not committed"));
    expect((await absent.service.run(scope)).errors).toContain("skill_aggregation_blocked");
    expect(absent.propose).not.toHaveBeenCalled();
  });

  it("does not draft if evidence is revoked after candidate creation or persisted content changed", async () => {
    const revoked = fixture(cohort(), passedGate);
    revoked.source.verify = vi.fn().mockResolvedValueOnce({ valid: true }).mockResolvedValueOnce({ valid: false });
    expect((await revoked.service.run(scope)).errors).toContain("experience_source_changed");
    expect(revoked.propose).not.toHaveBeenCalled();
    const changed = fixture(cohort(), passedGate);
    const create = changed.candidates.create.bind(changed.candidates);
    vi.spyOn(changed.candidates, "create").mockImplementation(body => create({ ...body, steps: ["unrelated action"] }));
    expect((await changed.service.run(scope)).errors).toContain("skill_candidate_ineligible");
    expect(changed.propose).not.toHaveBeenCalled();
  });

  it("fails closed for unavailable sources, invalid cursors, future outcomes and non-private scope", async () => {
    const unavailable = fixture(cohort(), passedGate);
    unavailable.source.readPage = vi.fn().mockRejectedValue(new Error("private database detail"));
    expect((await unavailable.service.run(scope)).errors).toEqual(["experience_source_unavailable"]);
    const cursor = fixture(cohort(), passedGate);
    cursor.source.readPage = vi.fn(async () => ({ experiences: [], nextCursor: "x".repeat(2049) }));
    expect((await cursor.service.run(scope)).errors).toEqual(["experience_cursor_invalid"]);
    const future = cohort();
    future[0].outcome.observedAt = now + 1;
    expect((await fixture(future, passedGate).service.run(scope)).errors).toEqual(["experience_time_invalid"]);
    expect((await fixture(cohort(), passedGate).service.run({ ...scope, visibility: "team" })).errors).toEqual(["private_skill_scope_required"]);
  });

  it("wires through the existing aggregator and disables its heuristic fallback in governed-required mode", async () => {
    const f = fixture(cohort(), passedGate);
    const candidateRepository = { list: vi.fn(async () => []), get: vi.fn() } as unknown as CandidateRepository;
    const aggregator = new SkillCandidateAggregator({ candidateRepository, skillCandidateRepository: f.candidates, governedAggregation: f.service, requireGovernedAggregation: true });
    expect((await aggregator.runAggregation(scope)).skillCandidates).toHaveLength(1);
    expect(candidateRepository.list).not.toHaveBeenCalled();
    const unwired = new SkillCandidateAggregator({ candidateRepository, skillCandidateRepository: f.candidates, requireGovernedAggregation: true });
    expect((await unwired.runAggregation(scope)).errors).toContain("governed_skill_aggregation_unavailable");
    expect(await unwired.analyzeExperienceClusters(scope)).toEqual([]);
    expect(await unwired.generateSkillCandidate({ topicLabel: "synthetic", experienceIds: ["m"], evidenceCount: 100,
      timeSpanDays: 5, avgSimilarity: 1, successOutcomeCount: 99, meetsThreshold: true, reason: "asserted" })).toBeNull();
    expect(candidateRepository.list).not.toHaveBeenCalled();
    expect(candidateRepository.get).not.toHaveBeenCalled();
  });
});
