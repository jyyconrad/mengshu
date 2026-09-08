import { authorityScopeFingerprint } from "../../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../../domain/types.js";
import { redactSecrets } from "../../ingest/agent-history/redaction.js";
import { DEFAULT_GENERALIZATION_TRIGGER, type GeneralizationAnalysis, type SkillCandidate } from "../../lifecycle/skill-candidate-types.js";
import { sha256, stableJson } from "../sources/shared.js";
import type { ExperiencePattern, ExperienceQuote, VerifiedExperience } from "./experience-types.js";

const safeId = (text: string) => /^[^\s\p{Cc}]{1,256}$/u.test(text);
const texts = (quotes: ExperienceQuote[]) => quotes.map(quote => quote.text);
const exactSet = (quotes: ExperienceQuote[]) => [...new Set(texts(quotes))].sort();
const outcomeEvidence = (experience: VerifiedExperience) => experience.evidence.find(e => e.id === experience.outcome.evidenceId)!;

function validExperience(experience: VerifiedExperience, scope: string): boolean {
  if (authorityScopeFingerprint(experience.scope) !== scope || experience.contextIncomplete || !safeId(experience.memoryId) || !safeId(experience.revision) ||
      !experience.topicLabel.trim() || experience.topicLabel.length > 80 || redactSecrets(experience.topicLabel).text !== experience.topicLabel ||
      typeof experience.highRisk !== "boolean" || !Number.isSafeInteger(experience.occurredAt) || experience.occurredAt < 0 ||
      !Number.isFinite(experience.confidence) || experience.confidence < 0 || experience.confidence > 1 ||
      !["success", "failure", "counterexample"].includes(experience.outcome.result) || !Number.isSafeInteger(experience.outcome.observedAt) ||
      experience.outcome.observedAt < experience.occurredAt || experience.evidence.length === 0 || experience.evidence.length > 16) return false;
  const evidence = new Map(experience.evidence.map(e => [e.id, e]));
  if (evidence.size !== experience.evidence.length || experience.evidence.some(e => ![e.id, e.rootEvidenceId, e.independenceGroupId].every(safeId) ||
      e.revoked || e.origin !== "external" || !e.quote.trim() || e.quote.length > 2048 || redactSecrets(e.quote).text !== e.quote)) return false;
  const result = evidence.get(experience.outcome.evidenceId);
  if (!result?.verificationReceiptId || !safeId(result.verificationReceiptId)) return false;
  const fields = [experience.applicability, experience.triggers, experience.preconditions, experience.steps, experience.riskBoundaries];
  if (fields.some(field => field.length === 0 || field.length > 12)) return false;
  // Accept complete source lines/blocks, not a substring that could remove a negation or qualifier.
  return [experience.outcome, ...fields.flat()].every(field => {
    const source = evidence.get(field.evidenceId);
    return !!source && !!field.text.trim() && field.text.length <= 2048 &&
      (source.quote.trim() === field.text || source.quote.split(/\r?\n/).some(line => line.trim() === field.text));
  });
}

function similarity(experiences: VerifiedExperience[]): number | undefined {
  const first = experiences[0]?.embedding;
  if (!first || !safeId(first.model) || first.values.length === 0 || first.values.length > 4096) return undefined;
  const vectors: number[][] = [];
  for (const experience of experiences) {
    const embedding = experience.embedding;
    if (!embedding || embedding.model !== first.model || embedding.values.length !== first.values.length ||
        embedding.values.some(value => !Number.isFinite(value))) return undefined;
    const norm = Math.hypot(...embedding.values);
    if (!Number.isFinite(norm) || norm === 0) return undefined;
    vectors.push(embedding.values.map(value => value / norm));
  }
  if (vectors.length < 2) return undefined;
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < vectors.length; i++) for (let j = i + 1; j < vectors.length; j++) {
    sum += vectors[i].reduce((dot, value, dimension) => dot + value * vectors[j][dimension], 0);
    pairs++;
  }
  return Math.max(-1, Math.min(1, sum / pairs));
}

export function compileExperiencePatterns(scope: MemoryScope, input: readonly VerifiedExperience[]): {
  patterns: ExperiencePattern[]; analyses: GeneralizationAnalysis[]; reasons: string[];
} {
  const empty = (reason: string) => ({ patterns: [], analyses: [], reasons: [reason] });
  if (input.length > 100) return empty("experience_page_overflow");
  let scopeHash: string;
  try {
    scopeHash = authorityScopeFingerprint(scope);
    if (input.some(experience => !validExperience(experience, scopeHash))) return empty("experience_evidence_invalid");
  } catch { return empty("experience_evidence_invalid"); }
  const groups = new Map<string, VerifiedExperience[]>();
  for (const experience of [...input].sort((a, b) => a.memoryId.localeCompare(b.memoryId))) {
    const key = stableJson([experience.topicLabel, exactSet(experience.applicability)]);
    groups.set(key, [...(groups.get(key) ?? []), experience]);
  }
  const patterns: ExperiencePattern[] = [];
  const analyses: GeneralizationAnalysis[] = [];
  const reasons: string[] = [];
  for (const group of groups.values()) {
    const roots = new Set<string>();
    const independent = new Set<string>();
    const memories = new Set<string>();
    const experiences = group.filter(experience => {
      const evidence = outcomeEvidence(experience);
      if (roots.has(evidence.rootEvidenceId) || independent.has(evidence.independenceGroupId) || memories.has(experience.memoryId)) return false;
      roots.add(evidence.rootEvidenceId); independent.add(evidence.independenceGroupId); memories.add(experience.memoryId); return true;
    });
    // Ambiguous duplicates could conceal a counterexample. Do not choose a favorable copy.
    if (experiences.length !== group.length) { reasons.push("dependent_or_duplicate_experience"); continue; }
    const score = similarity(experiences);
    const successCount = experiences.filter(experience => experience.outcome.result === "success").length;
    const times = experiences.map(experience => experience.outcome.observedAt);
    const timeSpanDays = (Math.max(...times) - Math.min(...times)) / 86400000;
    const trigger = DEFAULT_GENERALIZATION_TRIGGER;
    const reason = experiences.length < trigger.minExperienceCount ? "insufficient_independent_experience" :
      timeSpanDays < trigger.minTimeSpanDays ? "insufficient_time_span" : score === undefined ? "embedding_unavailable" :
      score < trigger.minAvgSimilarity ? "insufficient_similarity" : successCount < trigger.minSuccessOutcomes ? "insufficient_observed_success" :
      experiences.some(experience => experience.highRisk) ? "high_risk_review_required" : "meets_all_thresholds";
    const meetsThreshold = reason === "meets_all_thresholds";
    analyses.push({ topicLabel: group[0].topicLabel, experienceIds: experiences.map(experience => experience.memoryId),
      evidenceCount: experiences.length, timeSpanDays, avgSimilarity: score ?? 0, successOutcomeCount: successCount, meetsThreshold, reason });
    if (!meetsThreshold) { reasons.push(reason); continue; }
    const id = sha256(stableJson({ scope: scopeHash, inputs: experiences.map(experience => ({ ...experience, embedding: undefined })),
      embeddingModel: experiences[0].embedding!.model, similarity: score }));
    patterns.push({ id, scope: { ...scope }, topicLabel: group[0].topicLabel, experiences: structuredClone(experiences),
      evidenceRootIds: [...new Set(experiences.flatMap(experience => experience.evidence.map(e => e.rootEvidenceId)))].sort(),
      successCount, failureCount: experiences.length - successCount, timeSpanDays, similarity: score!,
      confidenceCeiling: Math.min(...experiences.map(experience => experience.confidence)) });
  }
  return { patterns, analyses, reasons: [...new Set(reasons)].sort() };
}

function procedure(experience: VerifiedExperience) {
  return { applicability: exactSet(experience.applicability), triggers: exactSet(experience.triggers), preconditions: exactSet(experience.preconditions),
    steps: texts(experience.steps), riskBoundaries: exactSet(experience.riskBoundaries) };
}

export function candidateFromPattern(pattern: ExperiencePattern, now: number): SkillCandidate {
  const successes = pattern.experiences.filter(experience => experience.outcome.result === "success");
  if (!successes.length || successes.some(experience => stableJson(procedure(experience)) !== stableJson(procedure(successes[0])))) throw new Error("mixed_procedures_review_required");
  const fields = procedure(successes[0]);
  const successSignals = [...new Set(successes.map(experience => experience.outcome.text))];
  const antiPatterns = pattern.experiences.filter(experience => experience.outcome.result !== "success").map(experience =>
    `Observed ${experience.outcome.result}: ${experience.outcome.text}; applicability: ${exactSet(experience.applicability).join("; ")}; preconditions: ${exactSet(experience.preconditions).join("; ")}`);
  if ([fields.preconditions, fields.triggers, fields.riskBoundaries, successSignals, antiPatterns].some(field => field.length > 8) ||
      fields.steps.length > 12 || fields.applicability.join("; ").length > 2048 || antiPatterns.some(value => value.length > 2048)) throw new Error("skill_context_overflow");
  return { id: `experience-candidate:${pattern.id}`, title: pattern.topicLabel, topicLabel: pattern.topicLabel, applicability: fields.applicability.join("; "),
    triggerConditions: fields.triggers, preconditions: fields.preconditions, steps: fields.steps, successSignals, antiPatterns,
    riskBoundaries: fields.riskBoundaries, highRisk: false, scope: { ...pattern.scope }, confidence: pattern.confidenceCeiling, status: "pending", createdAt: now,
    evidenceMemoryIds: pattern.experiences.map(experience => experience.memoryId),
    evidenceChunkIds: [...new Set(pattern.experiences.flatMap(experience => experience.evidence.map(e => e.id)))].sort(),
    reason: "Observed independent outcomes; owner review required.",
    metadata: { source: "governed_experience", patternId: pattern.id, evidenceSignature: pattern.id, reviewRequired: true,
      confidenceIncreased: false, evidenceRootIds: pattern.evidenceRootIds,
      outcomes: pattern.experiences.map(experience => ({ memoryId: experience.memoryId, revision: experience.revision, evidenceId: experience.outcome.evidenceId,
        result: experience.outcome.result, observedAt: experience.outcome.observedAt, applicability: texts(experience.applicability), preconditions: texts(experience.preconditions) })) } };
}

export function skillCandidateContentHash(candidate: SkillCandidate): string {
  return sha256(stableJson({ id: candidate.id, scope: authorityScopeFingerprint(candidate.scope), title: candidate.title, topicLabel: candidate.topicLabel,
    applicability: candidate.applicability, triggers: candidate.triggerConditions, preconditions: candidate.preconditions, steps: candidate.steps,
    successSignals: candidate.successSignals, antiPatterns: candidate.antiPatterns, riskBoundaries: candidate.riskBoundaries,
    highRisk: candidate.highRisk, memoryIds: candidate.evidenceMemoryIds, chunkIds: candidate.evidenceChunkIds, confidence: candidate.confidence, reason: candidate.reason }));
}
