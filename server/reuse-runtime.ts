import { authorityScopeFingerprint } from "../packages/core/src/domain/authority-scope-fingerprint.js";
import { resolveAuthorityScope, type AuthorityScope } from "../packages/core/src/domain/authority-scope.js";
import { requireRecallHitReceipt } from "../packages/core/src/domain/recall-receipt-validation.js";
import type { MemoryRecord, MemoryScope, MemoryScopeInput, RecallHit } from "../packages/core/src/domain/types.js";
import { HostManagedReuseAuthorizer, sameExactReuseScope, type ExplicitReuseGrant } from
  "../packages/core/src/evolution/reuse/explicit-reuse-authorizer.js";
import { GovernedReuseReadService, type GovernedReuseReference } from
  "../packages/core/src/evolution/reuse/governed-reuse-read-service.js";
import { HostReuseCompatibilityReader, fingerprintCompatibilitySubject, fingerprintTargetProfile, reuseDigest,
  type CompatibilitySubject, type ReuseCompatibilityBinding, type TargetExecutionProfile } from
  "../packages/core/src/evolution/reuse/target-compatibility.js";
import type { ExplicitReuseReadOptions } from "../packages/core/src/evolution/reuse/reuse-read-access.js";
import { GovernedRetrievalEngine, type GovernedRetrievalCandidateSource, type GovernedRetrievalHydrator,
  type GovernedRetrievalHit, type GovernedRetrievalSource } from "../packages/core/src/retrieval/governed-retrieval-engine.js";
import type { AgentFastPathReadBoundary } from "../packages/api/src/agent-fast-path/index.js";
import type { EvolutionHostStateEntry, EvolutionHostStatePort } from "./evolution-host-state.js";

export interface HostReuseRuntimeOptions {
  readonly authority: AuthorityScope;
  /** One authenticated host binding, not a scope copied from request metadata. */
  readonly boundScope: MemoryScope;
  readonly state: EvolutionHostStatePort;
  readonly readTarget: (scope: MemoryScope) => Promise<TargetExecutionProfile | undefined>;
  readonly candidateSource: (options: ExplicitReuseReadOptions) => GovernedRetrievalCandidateSource;
  readonly hydrator: (options: ExplicitReuseReadOptions) => GovernedRetrievalHydrator;
  readonly now?: () => number;
}

const recallSourceByCandidate: Record<GovernedRetrievalSource, RecallHit["source"]> = {
  vector: "vector", bm25: "text", lexical: "text", recent: "recent",
  entity_graph: "graph", work_memory_graph: "graph", tree: "tree",
};

const publicRecallHit = (hit: GovernedRetrievalHit): RecallHit => ({
  ...hit, source: hit.scoreBreakdown.matchedBy[0],
});

export const compatibilityBindingId = (subject: CompatibilitySubject, target: MemoryScope): string =>
  reuseDigest("mengshu.host-compatibility-binding/v1", [fingerprintCompatibilitySubject(subject), authorityScopeFingerprint(target)]);

export function hostStateEntryLive(entry: EvolutionHostStateEntry | undefined, now: number): entry is EvolutionHostStateEntry {
  return !!entry && entry.revokedAt === undefined && (entry.expiresAt === undefined || entry.expiresAt > now);
}

/** Receipt lookup is bound to the same persisted revision, not an approval boolean in memory metadata. */
export async function readHostCompatibilityBinding(state: EvolutionHostStatePort, subject: CompatibilitySubject,
  target: MemoryScope, now: number): Promise<ReuseCompatibilityBinding | undefined> {
  if (!sameExactReuseScope(state.scope, target)) return undefined;
  const key = { kind: "compatibility_binding" as const, id: compatibilityBindingId(subject, target) };
  const entry = await state.read(key);
  if (!hostStateEntryLive(entry, now)) return undefined;
  const envelope = entry.value as unknown as { binding?: ReuseCompatibilityBinding; evaluationId?: string; evaluationReceiptId?: string };
  if (!envelope?.binding || !envelope.evaluationId || !envelope.evaluationReceiptId) return undefined;
  const evaluation = await state.read({ kind: "paired_evaluation", id: envelope.evaluationId });
  const receipt = await state.getReceipt(envelope.evaluationReceiptId);
  if (!hostStateEntryLive(evaluation, now) || !receipt || receipt.kind !== "paired_evaluation" ||
      receipt.operation !== "put" || receipt.entryId !== evaluation.id || receipt.revision !== evaluation.revision ||
      receipt.valueHash !== evaluation.valueHash || receipt.scopeFingerprint !== evaluation.scopeFingerprint ||
      receipt.actor.authentication === "host_task") return undefined;
  const report = evaluation.value as unknown as { verifierVersion?: string; result?: { status?: string; publishAllowed?: boolean;
    executionAllowed?: boolean; validation?: Record<string, unknown> }; expiresAt?: number };
  const validation = report?.result?.validation;
  const binding = envelope.binding;
  if (report?.verifierVersion !== "synthetic:fact-selection-v1" ||
      binding.evaluatorId !== "mengshu.synthetic-fact-selection.v1" ||
      report?.result?.status !== "accepted_for_review" || report.result.publishAllowed !== false ||
      report.result.executionAllowed !== false || !validation || !(report.expiresAt! > now) ||
      ["evaluatorId", "planHash", "reportHash", "holdoutRef", "reviewReceiptId", "targetFingerprint", "validatedAt"]
        .some(field => validation[field] !== (binding as unknown as Record<string, unknown>)[field]) ||
      fingerprintCompatibilitySubject(validation.subject as CompatibilitySubject) !== fingerprintCompatibilitySubject(subject) ||
      Date.parse(binding.expiresAt) > report.expiresAt! || binding.status !== "validated") return undefined;
  const current = await state.read(key);
  const currentEvaluation = await state.read({ kind: "paired_evaluation", id: envelope.evaluationId });
  return hostStateEntryLive(current, now) && hostStateEntryLive(currentEvaluation, now) &&
    current.revision === entry.revision && current.valueHash === entry.valueHash &&
    currentEvaluation.revision === evaluation.revision && currentEvaluation.valueHash === evaluation.valueHash
    ? structuredClone(binding) : undefined;
}

function referenceToken(ref: GovernedReuseReference): string {
  const token = `mr1:${Buffer.from(JSON.stringify(ref)).toString("base64url")}`;
  if (token.length > 4096) throw new Error("REUSE_REFERENCE_INVALID");
  return token;
}
function parseReference(token: string): GovernedReuseReference {
  if (typeof token !== "string" || token.length > 4096 || !/^mr1:[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error("REUSE_REFERENCE_INVALID");
  }
  try {
    const ref: GovernedReuseReference = JSON.parse(Buffer.from(token.slice(4), "base64url").toString("utf8"));
    if (!ref || Object.keys(ref).sort().join() !== "authoritativeRecordId,evidenceIds,sourceScope,version" ||
        referenceToken(ref) !== token) throw new Error();
    return ref;
  } catch { throw new Error("REUSE_REFERENCE_INVALID"); }
}

export function createHostReuseRuntime(options: HostReuseRuntimeOptions) {
  const now = options.now ?? Date.now;
  const authority = structuredClone(options.authority);
  const scope = structuredClone(options.boundScope);
  const { appId, projectId, agentId, namespace, visibility } = scope;
  const resolved = resolveAuthorityScope(authority, { appId, projectId, agentId, namespace, visibility: visibility! });
  if (!sameExactReuseScope(scope, resolved) || !sameExactReuseScope(scope, options.state.scope) ||
      reuseDigest("authority", authority) !== reuseDigest("authority", options.state.authority)) {
    throw new Error("REUSE_HOST_SCOPE_MISMATCH");
  }
  const resolveScope = (requested?: MemoryScopeInput): MemoryScope => {
    if (requested !== undefined && (!requested || typeof requested !== "object" || Array.isArray(requested) ||
        Object.keys(requested).some(key => !["tenantId", "userId", "appId", "projectId", "agentId", "namespace", "visibility", "workspaceId", "sessionId"].includes(key) ||
          requested[key as keyof MemoryScopeInput] !== scope[key as keyof MemoryScope]))) {
      throw new Error("REUSE_HOST_SCOPE_MISMATCH");
    }
    return structuredClone(scope);
  };
  const authorizer = new HostManagedReuseAuthorizer({ read: async () => {
    const entry = await options.state.read({ kind: "reuse_grants", id: "grants" });
    const value = hostStateEntryLive(entry, now()) ? entry.value as unknown as { grants?: readonly ExplicitReuseGrant[] } : undefined;
    return { authority, revision: String(entry?.revision ?? 0), grants: value?.grants ?? [] };
  } }, now);
  const compatibility = new HostReuseCompatibilityReader({
    readTarget: async target => options.readTarget(resolveScope(target)),
    readBinding: async (subject, target) => readHostCompatibilityBinding(options.state, subject, resolveScope(target), now()),
  }, now);
  const readOptions: ExplicitReuseReadOptions = Object.freeze({ reuseAuthorizer: authorizer, reuseCompatibility: compatibility });
  const source = options.candidateSource(readOptions);
  const engine = new GovernedRetrievalEngine(options.hydrator(readOptions), readOptions);
  const candidateSource: GovernedRetrievalCandidateSource = { search: input => {
    resolveScope(input.scope); return source.search(input);
  } };
  const scopedEngine: Pick<GovernedRetrievalEngine, "retrieve"> = { retrieve: input => {
    resolveScope(input.scope); return engine.retrieve(input);
  } };
  const rawReads = new GovernedReuseReadService(candidateSource, scopedEngine);
  const snapshots = new WeakMap<object, string>();
  const stamp = async () => {
    const grants = await options.state.read({ kind: "reuse_grants", id: "grants" });
    const bindings = await options.state.list("compatibility_binding");
    const evaluations = await options.state.list("paired_evaluation");
    const target = await options.readTarget(scope);
    return reuseDigest("mengshu.host-reuse-read-boundary/v1", [grants ?? null,
      await authorizer.sources(scope), target ? fingerprintTargetProfile(target) : null,
      [...bindings.entries, ...evaluations.entries].map(entry => [entry, hostStateEntryLive(entry, now()),
        Date.parse((entry.value as unknown as { binding?: ReuseCompatibilityBinding })?.binding?.expiresAt ?? "") > now()])]);
  };
  const checkpoint = async (target: MemoryScope): Promise<object> => {
    resolveScope(target);
    const token = Object.freeze({});
    snapshots.set(token, await stamp());
    return token;
  };
  const revalidate = async (target: MemoryScope, token: object): Promise<boolean> => {
    resolveScope(target);
    const before = snapshots.get(token);
    return before !== undefined && before === await stamp();
  };
  const rehydrate = async (target: MemoryScope, hits: readonly RecallHit[], intent: "lookup" | "context"): Promise<RecallHit[]> => {
    resolveScope(target);
    if (hits.length > 500) throw new Error("REUSE_REFERENCES_INVALID");
    const candidates = hits.flatMap((hit, i) => {
      const record = hit.record;
      if (!("scope" in record) || !record.scope || !("kind" in record)) throw new Error("REUSE_REFERENCE_INVALID");
      const receipt = requireRecallHitReceipt(hit);
      const signals: { source: GovernedRetrievalSource; relevance: number }[] = [];
      for (const [key, value] of Object.entries(receipt.sourceSignals)) {
        if (!Object.hasOwn(recallSourceByCandidate, key)) continue;
        const source = key as GovernedRetrievalSource;
        if (!receipt.matchedBy.includes(recallSourceByCandidate[source])) continue;
        signals.push({ source, relevance: value >= 0 && value <= 1 ? value : receipt.factors.relevance });
      }
      // Legacy public text has no BM25 subtype; raw scores are not normalized relevance.
      for (const source of receipt.matchedBy) {
        if (source === "graph" || signals.some(signal => recallSourceByCandidate[signal.source] === source)) continue;
        signals.push({ source: source === "text" ? "lexical" : source, relevance: receipt.factors.relevance });
      }
      // A generic graph receipt cannot identify a graph subtype. Keep the exact-ID read fallback.
      if (signals.length === 0) signals.push({ source: "lexical", relevance: receipt.factors.relevance });
      return signals.map(({ source, relevance }) => ({
        candidateId: `rehydrate:${i}:${source}`, authoritativeRecordId: record.id, scope: record.scope,
        source, nodeType: "memory" as const,
        evidenceIds: (record as MemoryRecord).sourceNodeIds ?? [], relevance,
      }));
    });
    return (await engine.retrieve({ intent, scope: target, candidates })).hits.map(publicRecallHit);
  };
  const guard = async <T extends { hits: GovernedRetrievalHit[] }>(target: MemoryScope, run: () => Promise<T>): Promise<T> => {
    resolveScope(target);
    const token = await checkpoint(target);
    const result = await run();
    const refreshed = await rehydrate(target, result.hits.map(publicRecallHit), "lookup");
    if (reuseDigest("records", refreshed.map(hit => hit.record).sort((a, b) => a.id.localeCompare(b.id))) !==
        reuseDigest("records", result.hits.map(hit => hit.record).sort((a, b) => a.id.localeCompare(b.id))) ||
        !await revalidate(target, token)) throw new Error("REUSE_READ_CHANGED");
    return result;
  };
  const readService = {
    reference: (hit: GovernedRetrievalHit) => rawReads.reference(hit),
    lookup: (input: Parameters<GovernedReuseReadService["lookup"]>[0]) => guard(input.scope, () => rawReads.lookup(input)),
    explain: (input: Parameters<GovernedReuseReadService["explain"]>[0]) => guard(input.scope, () => rawReads.explain(input)),
    dereference: (input: Parameters<GovernedReuseReadService["dereference"]>[0]) => guard(input.scope, () => rawReads.dereference(input)),
    readCached: (input: Parameters<GovernedReuseReadService["readCached"]>[0]) => guard(input.scope, () => rawReads.readCached(input)),
  };
  const readEvidence: AgentFastPathReadBoundary["readEvidence"] = async (target, refs) => {
    const batch = await guard(target, async () => {
      const hits: GovernedRetrievalHit[] = [];
      const results = [];
      for (const ref of refs) {
        const result = await rawReads.dereference({ scope: target, reference: parseReference(ref) });
        hits.push(...result.hits);
        for (const hit of result.hits) results.push({ ref, preview: hit.record.text, source: "memory" as const });
      }
      return { hits, results };
    });
    return batch.results;
  };
  const fastPathReadBoundary: AgentFastPathReadBoundary = {
    resolveScope, checkpoint, revalidate, rehydrate,
    reference: hit => referenceToken(rawReads.reference({ record: hit.record } as GovernedRetrievalHit)),
    readEvidence,
    navigate: async (target, input) => (await readEvidence(target, [input.ref])).slice(0, input.limit)
      .map(item => ({ ref: item.ref, level: "R4" as const, kind: "memory", title: item.preview.slice(0, 80), preview: item.preview })),
  };
  return { authorizer, compatibility, readOptions, readService, fastPathReadBoundary, engine: scopedEngine, candidateSource };
}

export interface HostReuseRuntimeRouterOptions extends Omit<HostReuseRuntimeOptions, "state" | "candidateSource" | "hydrator"> {
  readonly stateForScope: (scope: MemoryScope) => EvolutionHostStatePort;
  readonly candidateSource: (options: ExplicitReuseReadOptions, scope: MemoryScope) => GovernedRetrievalCandidateSource;
  readonly hydrator: (options: ExplicitReuseReadOptions, scope: MemoryScope) => GovernedRetrievalHydrator;
}

/** Multi-project API composition. Only the authorized project coordinate varies; identity never does. */
export function createHostReuseRuntimeRouter(options: HostReuseRuntimeRouterOptions) {
  const bound = structuredClone(options.boundScope);
  const authority = structuredClone(options.authority);
  const instances = new Map<string, ReturnType<typeof createHostReuseRuntime>>();
  const resolveScope = (input?: MemoryScopeInput): MemoryScope => {
    if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input))) throw new Error("REUSE_HOST_SCOPE_MISMATCH");
    const target = resolveAuthorityScope(authority, { appId: bound.appId, agentId: bound.agentId,
      projectId: input?.projectId ?? bound.projectId, namespace: bound.namespace, visibility: bound.visibility! });
    if (!sameExactReuseScope({ ...bound, projectId: target.projectId }, target) || input && Object.keys(input).some(key =>
      !["tenantId", "userId", "appId", "projectId", "agentId", "namespace", "visibility", "workspaceId", "sessionId"].includes(key) ||
      input[key as keyof MemoryScopeInput] !== target[key as keyof MemoryScope])) throw new Error("REUSE_HOST_SCOPE_MISMATCH");
    return target;
  };
  resolveScope(bound);
  const forScope = (requested: MemoryScope) => {
    const scope = resolveScope(requested);
    const key = authorityScopeFingerprint(scope);
    let runtime = instances.get(key);
    if (!runtime) {
      runtime = createHostReuseRuntime({ authority, boundScope: scope, state: options.stateForScope(scope),
        candidateSource: readOptions => options.candidateSource(readOptions, scope),
        hydrator: readOptions => options.hydrator(readOptions, scope), readTarget: options.readTarget, now: options.now });
      instances.set(key, runtime);
    }
    return runtime;
  };
  const reference = (hit: Pick<GovernedRetrievalHit, "record">) => Object.freeze({ version: 1 as const,
    authoritativeRecordId: hit.record.id, sourceScope: Object.freeze({ ...hit.record.scope }),
    evidenceIds: Object.freeze([...(hit.record.sourceNodeIds ?? [])]),
  });
  const readService = {
    reference,
    lookup: (input: Parameters<GovernedReuseReadService["lookup"]>[0]) => forScope(input.scope).readService.lookup(input),
    explain: (input: Parameters<GovernedReuseReadService["explain"]>[0]) => forScope(input.scope).readService.explain(input),
    dereference: (input: Parameters<GovernedReuseReadService["dereference"]>[0]) => forScope(input.scope).readService.dereference(input),
    readCached: (input: Parameters<GovernedReuseReadService["readCached"]>[0]) => forScope(input.scope).readService.readCached(input),
  };
  const fastPathReadBoundary: AgentFastPathReadBoundary = {
    resolveScope,
    checkpoint: scope => forScope(scope).fastPathReadBoundary.checkpoint(scope),
    revalidate: (scope, token) => forScope(scope).fastPathReadBoundary.revalidate(scope, token),
    rehydrate: (scope, hits, intent) => forScope(scope).fastPathReadBoundary.rehydrate(scope, hits, intent),
    reference: hit => referenceToken(reference({ record: hit.record as MemoryRecord })),
    readEvidence: (scope, refs) => forScope(scope).fastPathReadBoundary.readEvidence(scope, refs),
    navigate: (scope, input) => forScope(scope).fastPathReadBoundary.navigate(scope, input),
  };
  const engine: Pick<GovernedRetrievalEngine, "retrieve"> = { retrieve: input => forScope(input.scope).engine.retrieve(input) };
  const candidateSource: GovernedRetrievalCandidateSource = { search: input => forScope(input.scope).candidateSource.search(input) };
  const compatibility = {
    allows: (record: MemoryRecord, scope: MemoryScope) => forScope(scope).compatibility.allows(record, scope),
    allowsSkill: (artifact: Parameters<HostReuseCompatibilityReader["allowsSkill"]>[0], scope: MemoryScope) =>
      forScope(scope).compatibility.allowsSkill(artifact, scope),
  };
  return { forScope, readService, fastPathReadBoundary, engine, candidateSource, compatibility };
}
