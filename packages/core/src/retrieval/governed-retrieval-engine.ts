import {
  computeRecallScoreBreakdown,
  type CompleteRecallScoreBreakdown,
  type RecallMatchedBy,
} from "../domain/recall-scoring.js";
import { computeScopeFit } from "../domain/scope-fit.js";
import {
  filterContextEligibleRecords,
  filterRecallEligibleRecords,
} from "../domain/recall-filter.js";
import { applyScopeReusePolicy, scopeToSessionKey } from "../domain/scope-policy.js";
import {
  authorizeReuseRecord,
  requiresExplicitReuseGrant,
  type ExplicitReuseReadOptions,
} from "../evolution/reuse/reuse-read-access.js";
import {
  sameExactReuseScope,
  type ExplicitReusePermit,
} from "../evolution/reuse/explicit-reuse-authorizer.js";
import type {
  MemoryKind,
  MemoryRecord,
  MemoryScope,
  MemorySemanticType,
  RecallCandidateSource,
  RecallFilteredCandidate,
  RecallFilteredReason,
} from "../domain/types.js";

export type GovernedRetrievalSource = RecallCandidateSource;

export type GovernedRetrievalNodeType =
  | "memory"
  | "evidence"
  | "entity_graph"
  | "work_memory_graph"
  | "tree";

export interface GovernedRetrievalNavigation {
  kind: GovernedRetrievalNodeType;
  ref: string;
}

export interface GovernedRetrievalCandidate {
  candidateId: string;
  authoritativeRecordId: string;
  scope: MemoryScope;
  source: GovernedRetrievalSource;
  nodeType: GovernedRetrievalNodeType;
  relevance?: number;
  rawScore?: number;
  evidenceIds: readonly string[];
  /** Provider-issued identity for route arbitration; hydration verifies it before use. */
  governedSemanticIdentity?: string;
  admissionRoute?: "active" | "lookup_only" | "evidence_only";
  /** Optional producer projection. Hydration remains authoritative for the claim kind. */
  claimKind?: MemoryKind;
  navigation?: GovernedRetrievalNavigation;
}

export interface GovernedRetrievalCandidateSearchInput {
  query: string;
  scope: MemoryScope;
  limit: number;
  signal?: AbortSignal;
}

/** Candidate producers only return authoritative identities and retrieval signals. */
export interface GovernedRetrievalCandidateSource {
  search(input: GovernedRetrievalCandidateSearchInput): Promise<GovernedRetrievalCandidate[]>;
}

/** Hydration must be backed by the authoritative memory/evidence repositories. */
export interface GovernedRetrievalHydration {
  record: MemoryRecord;
  evidenceIds: readonly string[];
}

export interface GovernedRetrievalHydrationRequest {
  scope: MemoryScope;
  authoritativeRecordId: string;
  candidates: readonly GovernedRetrievalCandidate[];
}

export interface GovernedRetrievalHydrator {
  hydrate(input: GovernedRetrievalHydrationRequest): Promise<GovernedRetrievalHydration | undefined>;
}

export type GovernedRetrievalFilteredReason = RecallFilteredReason;

export interface GovernedRetrievalFiltered extends RecallFilteredCandidate {}

export interface GovernedRetrievalHit {
  record: MemoryRecord;
  score: number;
  scoreBreakdown: CompleteRecallScoreBreakdown;
  factors: CompleteRecallScoreBreakdown["factors"];
  contributions: CompleteRecallScoreBreakdown["contributions"];
  matchedBy: readonly GovernedRetrievalSource[];
  slot?: MemorySemanticType;
  navigation: readonly GovernedRetrievalNavigation[];
}

export interface GovernedRetrievalRequest {
  intent: "lookup" | "context";
  scope: MemoryScope;
  candidates: readonly GovernedRetrievalCandidate[];
  minScore?: number;
  limit?: number;
}

export interface GovernedRetrievalResult {
  hits: GovernedRetrievalHit[];
  filtered: GovernedRetrievalFiltered[];
}

const RISK_FLAGS = new Set(["prompt_injection"]);

function filtered(
  candidate: GovernedRetrievalCandidate,
  filteredReason: GovernedRetrievalFilteredReason,
): GovernedRetrievalFiltered {
  return {
    candidateId: candidate.candidateId,
    authoritativeRecordId: candidate.authoritativeRecordId,
    source: candidate.source,
    filteredReason,
  };
}

function sameAuthority(left: MemoryScope, right: MemoryScope): boolean {
  return left.tenantId === right.tenantId && left.userId === right.userId;
}

function asStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    return undefined;
  }
  return value;
}

interface GovernanceRiskSignals {
  riskFlags: readonly string[];
  targetScope?: string;
}

function governanceRiskSignals(record: MemoryRecord): GovernanceRiskSignals | undefined {
  const governance = record.metadata.governance;
  if (governance === undefined) return { riskFlags: [] };
  if (!governance || typeof governance !== "object" || Array.isArray(governance)) return undefined;
  const candidate = (governance as Record<string, unknown>).candidate;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const snapshot = candidate as Record<string, unknown>;
  const riskFlags = snapshot.riskFlags === undefined ? [] : asStringArray(snapshot.riskFlags);
  if (!riskFlags || (snapshot.targetScope !== undefined && typeof snapshot.targetScope !== "string")) {
    return undefined;
  }
  return {
    riskFlags,
    ...(typeof snapshot.targetScope === "string" ? { targetScope: snapshot.targetScope } : {}),
  };
}

function hasBlockedRisk(record: MemoryRecord): boolean {
  const metadataFlags = record.metadata.riskFlags === undefined
    ? []
    : asStringArray(record.metadata.riskFlags);
  const governance = governanceRiskSignals(record);
  if (!metadataFlags || !governance) return true;
  const riskFlags = new Set([...metadataFlags, ...governance.riskFlags]);
  if ([...RISK_FLAGS].some((flag) => riskFlags.has(flag))) return true;
  const expandedSensitiveScope = (record.scope.visibility ?? "private") !== "private" ||
    governance.targetScope === "workspace" || governance.targetScope === "global";
  if (riskFlags.has("sensitive") && expandedSensitiveScope) return true;
  return false;
}

function hasUnresolvedConflict(record: MemoryRecord): boolean {
  const conflictStatus = record.metadata.conflictStatus;
  const conflictUnresolved = record.metadata.conflictUnresolved ??
    record.metadata.conflict_unresolved;
  if (conflictUnresolved !== undefined && typeof conflictUnresolved !== "boolean") return true;
  if (conflictStatus !== undefined && typeof conflictStatus !== "string") return true;
  const metadataFlags = record.metadata.riskFlags === undefined
    ? []
    : asStringArray(record.metadata.riskFlags);
  const governance = governanceRiskSignals(record);
  if (!metadataFlags || !governance) return true;
  return conflictUnresolved === true ||
    metadataFlags.includes("conflict_possible") ||
    governance.riskFlags.includes("conflict_possible") ||
    (typeof conflictStatus === "string" && conflictStatus !== "resolved" && conflictStatus !== "none");
}

/** Evolution holds apply to ordinary lookup too; owner audit reads use separate repositories. */
export function hasEvolutionReadHold(metadata: Readonly<Record<string, unknown>>): boolean {
  const governance = metadata.governance;
  if (governance === undefined) return false;
  if (!governance || typeof governance !== "object" || Array.isArray(governance)) return true;
  const evolution = (governance as Record<string, unknown>).evolution;
  if (evolution === undefined) return false;
  if (!evolution || typeof evolution !== "object" || Array.isArray(evolution)) return true;
  return ["disputed", "needsReview"].some((key) => {
    const value = (evolution as Record<string, unknown>)[key];
    return value !== undefined && value !== false;
  });
}

function retrievalEligible(
  record: MemoryRecord,
  scope: MemoryScope,
  intent: GovernedRetrievalRequest["intent"],
): boolean {
  const eligible = intent === "context"
    ? filterContextEligibleRecords([record], scope)
    : filterRecallEligibleRecords([record], scope);
  return eligible.length === 1;
}

function evidenceAvailable(
  candidate: GovernedRetrievalCandidate,
  hydration: GovernedRetrievalHydration,
): boolean {
  if (candidate.evidenceIds.length === 0) return false;
  if (candidate.evidenceIds.some((id) => typeof id !== "string" || id.length === 0)) return false;
  const hydratedEvidence = asStringArray(hydration.evidenceIds);
  const recordEvidence = asStringArray(hydration.record.sourceNodeIds ?? []);
  if (!hydratedEvidence || hydratedEvidence.length === 0 ||
      !recordEvidence || recordEvidence.length === 0) return false;
  const proven = new Set(hydratedEvidence.filter((id) => recordEvidence.includes(id)));
  return candidate.evidenceIds.every((id) => proven.has(id));
}

function scoringSource(source: GovernedRetrievalSource): RecallMatchedBy {
  switch (source) {
    case "bm25":
    case "lexical": return "text";
    case "entity_graph":
    case "work_memory_graph": return "graph";
    default: return source;
  }
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

export function createGovernedSemanticIdentity(input: {
  kind: MemoryKind;
  semanticType?: MemorySemanticType;
  contentHash: string;
}): string {
  if (typeof input.contentHash !== "string" || input.contentHash.length === 0) {
    throw new TypeError("governed semantic identity requires a content hash");
  }
  return JSON.stringify([
    "mengshu.governed-semantic-identity/v1",
    input.kind,
    input.semanticType ?? null,
    input.contentHash,
  ]);
}

function admissionRoute(record: MemoryRecord): "active" | "lookup_only" | undefined {
  const route = record.metadata.admissionRoute;
  return route === "active" || route === "lookup_only" ? route : undefined;
}

function routeRank(route: "active" | "lookup_only"): number {
  return route === "active" ? 0 : 1;
}

function uniqueNavigation(
  candidates: readonly GovernedRetrievalCandidate[],
): GovernedRetrievalNavigation[] {
  const seen = new Set<string>();
  const result: GovernedRetrievalNavigation[] = [];
  for (const candidate of candidates) {
    if (!candidate.navigation) continue;
    const key = `${candidate.navigation.kind}\u0000${candidate.navigation.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...candidate.navigation });
  }
  return result;
}

function validateRequest(request: GovernedRetrievalRequest): { minScore: number; limit: number } {
  if (request.intent !== "lookup" && request.intent !== "context") {
    throw new TypeError("intent must be lookup or context");
  }
  const minScore = request.minScore ?? 0;
  const limit = request.limit ?? Number.POSITIVE_INFINITY;
  if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
    throw new RangeError("minScore must be a finite number in [0, 1]");
  }
  if (limit !== Number.POSITIVE_INFINITY &&
      (!Number.isInteger(limit) || limit < 0)) {
    throw new RangeError("limit must be a non-negative integer");
  }
  return { minScore, limit };
}

export class GovernedRetrievalEngine {
  private readonly hydrator: GovernedRetrievalHydrator;

  constructor(hydrator: GovernedRetrievalHydrator, private readonly options: ExplicitReuseReadOptions = {}) {
    this.hydrator = hydrator;
  }

  async retrieve(request: GovernedRetrievalRequest): Promise<GovernedRetrievalResult> {
    const { minScore, limit } = validateRequest(request);
    const denied: GovernedRetrievalFiltered[] = [];
    const candidatesByRecord = new Map<string, GovernedRetrievalCandidate[]>();

    for (const candidate of request.candidates) {
      if (!sameAuthority(candidate.scope, request.scope)) {
        denied.push(filtered(candidate, "authority_mismatch"));
        continue;
      }
      if (requiresExplicitReuseGrant(candidate.scope, request.scope) &&
          !await this.options.reuseAuthorizer?.authorize(candidate.scope, request.scope)) {
        denied.push(filtered(candidate, "scope_mismatch"));
        continue;
      }
      const group = candidatesByRecord.get(candidate.authoritativeRecordId) ?? [];
      group.push(candidate);
      candidatesByRecord.set(candidate.authoritativeRecordId, group);
    }

    const governed = new Map<string, Array<{
      record: MemoryRecord;
      hydration: GovernedRetrievalHydration;
      candidates: GovernedRetrievalCandidate[];
      route: "active" | "lookup_only";
      permit?: ExplicitReusePermit;
    }>>();
    for (const [authoritativeRecordId, candidates] of candidatesByRecord) {
      const hydration = await this.hydrator.hydrate({
        scope: request.scope,
        authoritativeRecordId,
        candidates,
      });
      if (!hydration) {
        denied.push(...candidates.map((item) => filtered(item, "hydration_unavailable")));
        continue;
      }

      const record = hydration.record;
      if (record.id !== authoritativeRecordId || !sameAuthority(record.scope, request.scope)) {
        denied.push(...candidates.map((item) => filtered(item, "authority_mismatch")));
        continue;
      }
      const access = await authorizeReuseRecord(record, request.scope, this.options);
      if (!access) {
        denied.push(...candidates.map((item) => filtered(item, "scope_mismatch")));
        continue;
      }
      const scopedCandidates = candidates.filter((item) => {
        if (access.permit) {
          if (sameExactReuseScope(item.scope, record.scope) &&
              (item.claimKind === undefined || item.claimKind === record.kind)) return true;
          denied.push(filtered(item, "scope_mismatch"));
          return false;
        }
        const candidateScopedRecord = { ...record, scope: item.scope };
        if (applyScopeReusePolicy([candidateScopedRecord], request.scope).reusable.length === 1) {
          return true;
        }
        denied.push(filtered(item, "scope_mismatch"));
        return false;
      });
      if (scopedCandidates.length === 0) continue;
      if (hasBlockedRisk(record)) {
        denied.push(...scopedCandidates.map((item) => filtered(item, "risk_blocked")));
        continue;
      }
      if (hasEvolutionReadHold(record.metadata) ||
          (hasUnresolvedConflict(record) && record.metadata.admissionRoute !== "lookup_only")) {
        denied.push(...scopedCandidates.map((item) => filtered(item, "conflict_unresolved")));
        continue;
      }
      // Scope authorization is complete above; lifecycle/risk checks retain the source coordinates.
      if (!retrievalEligible(record, record.scope, request.intent)) {
        denied.push(...scopedCandidates.map((item) => filtered(item, "lifecycle_ineligible")));
        continue;
      }
      const identity = createGovernedSemanticIdentity(record);
      const route = admissionRoute(record);
      if (!route) {
        denied.push(...scopedCandidates.map((item) => filtered(item, "governance_mismatch")));
        continue;
      }
      const governanceMatched = scopedCandidates.filter((item) => {
        if (item.governedSemanticIdentity !== undefined &&
            item.governedSemanticIdentity !== identity) {
          denied.push(filtered(item, "governance_mismatch"));
          return false;
        }
        if (item.admissionRoute !== undefined && item.admissionRoute !== route) {
          denied.push(filtered(item, "governance_mismatch"));
          return false;
        }
        return true;
      });
      if (governanceMatched.length === 0) continue;
      // Equal wording in independently authorized scopes is not proof of the same canonical claim.
      const scopedIdentity = JSON.stringify([scopeToSessionKey(record.scope), record.scope.visibility ?? "private", identity]);
      const group = governed.get(scopedIdentity) ?? [];
      group.push({ record, hydration, candidates: governanceMatched, route, permit: access.permit });
      governed.set(scopedIdentity, group);
    }

    const scored: Array<{
      hit: GovernedRetrievalHit;
      representative: GovernedRetrievalCandidate;
      permit?: ExplicitReusePermit;
    }> = [];
    for (const records of governed.values()) {
      const winningRank = Math.min(...records.map((item) => routeRank(item.route)));
      const winner = records.find((item) => routeRank(item.route) === winningRank)!;
      for (const superseded of records) {
        if (superseded === winner) continue;
        denied.push(...superseded.candidates.map((item) =>
          filtered(item, "governed_identity_superseded")));
      }

      const { record, hydration } = winner;
      const evidenceBacked = winner.candidates.filter((item) => {
        if (evidenceAvailable(item, hydration)) return true;
        denied.push(filtered(item, "evidence_unavailable"));
        return false;
      });
      const scoreable = evidenceBacked.filter((item) => {
        if (typeof item.relevance === "number" && Number.isFinite(item.relevance) &&
            item.relevance >= 0 && item.relevance <= 1) return true;
        denied.push(filtered(item, "score_breakdown_unavailable"));
        return false;
      });
      if (scoreable.length === 0) continue;

      const representative = scoreable.reduce((best, item) =>
        (item.relevance ?? 0) > (best.relevance ?? 0) ? item : best);
      const sourceSignals: Record<string, number> = {};
      for (const item of scoreable) {
        sourceSignals[item.source] = Math.max(sourceSignals[item.source] ?? 0, item.relevance ?? 0);
      }
      const detailedSources = unique(scoreable.map((item) => item.source));
      const scoreBreakdown = computeRecallScoreBreakdown(
        record,
        {
          relevance: representative.relevance ?? 0,
          scopeFit: computeScopeFit(request.scope, record.scope),
        },
        unique(detailedSources.map(scoringSource)),
        sourceSignals,
      );
      scored.push({
        representative,
        permit: winner.permit,
        hit: {
          record,
          score: scoreBreakdown.score,
          scoreBreakdown,
          factors: scoreBreakdown.factors,
          contributions: scoreBreakdown.contributions,
          matchedBy: detailedSources,
          ...(record.semanticType ? { slot: record.semanticType } : {}),
          navigation: uniqueNavigation(scoreable),
        },
      });
    }

    const current: typeof scored = [];
    for (const item of scored) {
      if (item.permit && !await this.options.reuseAuthorizer?.revalidate(item.permit, item.hit.record.kind)) {
        denied.push(filtered(item.representative, "scope_mismatch"));
      } else {
        current.push(item);
      }
    }
    const aboveThreshold = current.filter(({ hit, representative }) => {
      if (hit.score >= minScore) return true;
      denied.push(filtered(representative, "score_below_threshold"));
      return false;
    });
    aboveThreshold.sort((left, right) =>
      right.hit.score - left.hit.score ||
      left.hit.record.id.localeCompare(right.hit.record.id));

    return {
      hits: aboveThreshold.slice(0, limit).map(({ hit }) => hit),
      filtered: denied,
    };
  }
}
