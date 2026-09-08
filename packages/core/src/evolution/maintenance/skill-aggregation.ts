import { authorityScopeFingerprint } from "../../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../../domain/types.js";
import type { GeneralizationAnalysis, SkillCandidate, SkillCandidateRepository } from "../../lifecycle/skill-candidate-types.js";
import type { ExperienceSourcePort, ReviewedSkillDraftPort, SkillDraftGatePort } from "./experience-types.js";
import { candidateFromPattern, compileExperiencePatterns, skillCandidateContentHash } from "./patterns.js";

export interface GovernedSkillAggregationResult {
  skillCandidates: SkillCandidate[];
  analyses: GeneralizationAnalysis[];
  errors: string[];
  drafts: { skillId: string; receiptId: string; gateReceiptId: string }[];
  deferredPatternIds: string[];
  nextCursor?: string;
}

export class GovernedSkillAggregationService {
  constructor(private readonly deps: { source: ExperienceSourcePort; candidates: SkillCandidateRepository;
    artifacts: ReviewedSkillDraftPort; gate?: SkillDraftGatePort; now?: () => number }) {}

  async run(scope: MemoryScope, options: { limit?: number; cursor?: string; maxDrafts?: number; signal?: AbortSignal } = {}): Promise<GovernedSkillAggregationResult> {
    const result: GovernedSkillAggregationResult = { skillCandidates: [], analyses: [], errors: [], drafts: [], deferredPatternIds: [] };
    const limit = options.limit ?? 100;
    const maxDrafts = options.maxDrafts ?? 1;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(maxDrafts) || maxDrafts < 1 || maxDrafts > 10 ||
        (options.cursor !== undefined && options.cursor.length > 2048)) throw new Error("invalid_experience_limit");
    authorityScopeFingerprint(scope);
    if (scope.visibility !== "private") { result.errors.push("private_skill_scope_required"); return result; }
    if (options.signal?.aborted) { result.errors.push("cancelled"); return result; }
    if (!this.deps.gate) { result.errors.push("skill_gate_unavailable"); return result; }
    let page: Awaited<ReturnType<ExperienceSourcePort["readPage"]>>;
    try { page = await this.deps.source.readPage({ scope, limit, cursor: options.cursor, signal: options.signal }); }
    catch { result.errors.push("experience_source_unavailable"); return result; }
    if (page.experiences.length > limit) { result.errors.push("experience_page_overflow"); return result; }
    if (page.experiences.some(experience => experience.outcome.observedAt > (this.deps.now ?? Date.now)())) { result.errors.push("experience_time_invalid"); return result; }
    if (page.nextCursor !== undefined && page.nextCursor.length > 2048) { result.errors.push("experience_cursor_invalid"); return result; }
    result.nextCursor = page.nextCursor;
    const compiled = compileExperiencePatterns(scope, page.experiences);
    result.analyses = compiled.analyses;
    result.errors.push(...compiled.reasons);
    let attempted = 0;
    for (const pattern of compiled.patterns) {
      if (options.signal?.aborted || attempted >= maxDrafts) {
        result.deferredPatternIds.push(pattern.id);
        if (options.signal?.aborted && !result.errors.includes("cancelled")) result.errors.push("cancelled");
        continue;
      }
      attempted++;
      try {
        const candidate = candidateFromPattern(pattern, (this.deps.now ?? Date.now)());
        const candidateHash = skillCandidateContentHash(candidate);
        let existing = await this.deps.candidates.get(candidate.id);
        if (existing && (!["pending", "active"].includes(existing.status) || skillCandidateContentHash(existing) !== candidateHash)) {
          result.errors.push("skill_candidate_ineligible"); continue;
        }
        const gate = await this.deps.gate.evaluate({ scope, pattern: structuredClone(pattern), candidate: structuredClone(candidate), candidateHash });
        if (gate.status === "blocked") {
          result.errors.push(/^[a-z][a-z0-9_]{0,79}$/.test(gate.reasonCode) ? gate.reasonCode : "skill_gate_blocked"); continue;
        }
        if (gate.patternId !== pattern.id || gate.candidateHash !== candidateHash ||
            ![gate.receiptId, gate.targetFingerprint, gate.policyVersion].every(value => /^[^\s\p{Cc}]{1,256}$/u.test(value)) ||
            !Number.isSafeInteger(gate.expiresAt) || gate.expiresAt <= (this.deps.now ?? Date.now)()) { result.errors.push("skill_gate_stale"); continue; }
        const verify = () => this.deps.source.verify({ scope, experiences: pattern.experiences.map(experience => ({ memoryId: experience.memoryId, revision: experience.revision })) });
        if (options.signal?.aborted || !(await verify()).valid) { result.errors.push("experience_source_changed"); continue; }
        if (!existing) {
          const { id, createdAt: _createdAt, ...body } = candidate;
          try { existing = await this.deps.candidates.create({ id, ...body, metadata: { ...body.metadata, gateReceiptId: gate.receiptId, targetFingerprint: gate.targetFingerprint } }); }
          catch {
            // An uncertain create is reconciled by deterministic identity; never mint another candidate ID.
            existing = await this.deps.candidates.get(id);
            if (!existing) throw new Error("candidate_create_uncertain");
          }
        }
        if (!["pending", "active"].includes(existing.status) || skillCandidateContentHash(existing) !== candidateHash) { result.errors.push("skill_candidate_ineligible"); continue; }
        if (options.signal?.aborted || gate.expiresAt <= (this.deps.now ?? Date.now)() || !(await verify()).valid) { result.errors.push("experience_source_changed"); continue; }
        const draft = await this.deps.artifacts.proposeFromCandidate({ scope, ownerUserId: scope.userId, candidateId: existing.id,
          skillId: `experience-skill:${pattern.id}`, expectedLatestVersion: 0, manifest: [], expectedOutcomePolicyVersion: gate.policyVersion,
          idempotencyKey: `experience-draft:${pattern.id}` });
        if (draft.artifact.executionMode !== "suggest_only" || draft.artifact.status !== "draft") throw new Error("unexpected_skill_state");
        result.skillCandidates.push(existing);
        result.drafts.push({ skillId: draft.artifact.skillId, receiptId: draft.receipt.id, gateReceiptId: gate.receiptId });
      } catch (error) {
        const reason = error instanceof Error && ["mixed_procedures_review_required", "skill_context_overflow"].includes(error.message) ? error.message : "skill_aggregation_blocked";
        result.errors.push(reason);
      }
    }
    return result;
  }
}
